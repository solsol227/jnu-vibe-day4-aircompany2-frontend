// Vercel 서버리스 함수: Gemini 함수 호출(function calling) 에이전트
// 환경변수: GEMINI_API_KEY (필수), GEMINI_MODEL (선택, 쉼표로 우선순위 나열 가능)
// 앞 모델이 과부하(503)/제한(429)/없음(404)이면 다음 모델로 자동 전환
const { declarations, handlers } = require("./_tools");

const MODELS = (process.env.GEMINI_MODEL || "gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-flash-latest,gemini-3-flash-preview,gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-flash-lite-latest")
  .split(",").map((s) => s.trim()).filter(Boolean);
let pref = { i: 0, until: 0 }; // 따뜻한 인스턴스에서는 최근 성공한 모델부터 시도 (5분)
const cool = {};               // 방금 429/503이 난 모델은 잠시 건너뛰어 한도·시간 낭비를 막는다
const MAX_STEPS = 5; // 도구 호출 반복 상한

const SYSTEM = `당신은 한국 여행 추천 에이전트입니다. 한국어로, 친근하고 간결하게 답하세요.
- 날씨가 판단에 필요하면 get_weather를, 장소 추천이 필요하면 find_spots를 호출하세요. 둘 다 필요하면 둘 다 호출하세요.
- 장소를 추천할 때는 먼저 get_weather로 날씨와 미세먼지를 확인하고 반영하세요. (비·눈·미세먼지 '나쁨' 이상이면 실내 위주: museum/cafe, 맑고 쾌적하면 야외: park/beach/attraction)
- location 인자는 사용자가 말한 지명을 그대로(한글) 넣으세요. 위치를 못 찾았다고 나오면 영문 지명으로 한 번 재시도하세요.
- find_spots 결과에 url이 있으면 장소 이름 옆에 함께 안내해도 좋습니다.
- 도구 결과에 없는 장소나 수치를 지어내지 마세요. 오류가 나면 다른 인자로 한 번 재시도하고, 그래도 안 되면 솔직히 알려주세요.
- 미세먼지는 모델 예측값이라 실측과 다를 수 있음을 필요할 때 짧게 언급하세요.
- 답변은 추천 이유(날씨 근거)를 포함해 5~8줄 이내로 정리하세요.`;

async function callModel(model, contents, useThinking = true) {
  const level = useThinking ? (process.env.GEMINI_THINKING_LEVEL || "").trim() : "";
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY.trim() },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents,
      tools: [{ functionDeclarations: declarations }],
      generationConfig: {
        temperature: 0.5,
        // 선택: 응답이 느리면 Vercel 환경변수 GEMINI_THINKING_LEVEL=low 로 "생각" 시간을 줄일 수 있음
        ...(level ? { thinkingConfig: { thinkingLevel: level } } : {}),
      },
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (r.ok) return d;
  // 이 모델이 thinking 옵션을 지원하지 않으면 옵션만 빼고 같은 모델로 다시 시도
  if (level && r.status === 400 && /think/i.test(d.error?.message || "")) return callModel(model, contents, false);
  const e = new Error(d.error?.message || `Gemini 오류 (${r.status})`);
  e.status = r.status;
  // 429 상세: 어떤 한도(분당/일일/한도 0)인지, 몇 초 뒤 재시도 가능한지
  const det = d.error?.details || [];
  const viol = det.find((x) => /QuotaFailure/.test(x["@type"] || ""))?.violations || [];
  e.quota = viol.map((v) => `${v.quotaId || v.quotaMetric || ""}`).filter(Boolean).join(", ") || undefined;
  e.retryDelay = det.find((x) => /RetryInfo/.test(x["@type"] || ""))?.retryDelay;
  e.retryable = [404, 429, 500, 503].includes(r.status); // 키/요청 오류(400/403)는 다른 모델도 마찬가지
  throw e;
}

// 모델을 순서대로 시도. 도구 호출 이후 모델이 바뀌면 서명(thought signature) 불일치를 피하려고
// 함수 호출 이력을 텍스트 요약으로 바꿔서 전달한다.
async function gemini(st) {
  const first = Date.now() < pref.until ? pref.i : 0;
  let last;
  for (let i = first; i < MODELS.length; i++) {
    if (Date.now() - st.started > 45000) break;
    const model = MODELS[i];
    // 쿨다운 중인 모델은 건너뜀 (남은 모델이 하나도 없을 때만 그대로 시도)
    if ((cool[model] || 0) > Date.now() && MODELS.slice(i + 1).some((m) => (cool[m] || 0) <= Date.now())) continue;
    if (st.used && st.used !== model && st.toolCalls.length) {
      const results = JSON.stringify(st.toolCalls.map((c) => ({ tool: c.name, args: c.args, result: c.result })));
      st.contents = [...st.msgs, { role: "user", parts: [{ text: `[이미 실행된 도구 결과]
${results}

위 결과를 바탕으로 사용자 질문에 답하세요.` }] }];
    }
    const t0 = Date.now();
    try {
      const d = await callModel(model, st.contents);
      st.used = model;
      pref = i === 0 ? { i: 0, until: 0 } : { i, until: Date.now() + 5 * 60 * 1000 };
      return d;
    } catch (e) {
      last = e;
      const timeout = e.name === "TimeoutError" || e.name === "AbortError";
      if (e.status === 429) {
        const perDay = /PerDay/.test(e.quota || "");   // 일일 한도: 알려준 시간만큼(최대 6시간), 분당 한도: 최대 60초
        const sec = parseFloat(e.retryDelay) > 0 ? Math.min(parseFloat(e.retryDelay), perDay ? 21600 : 60) : 60;
        cool[model] = Date.now() + sec * 1000;
      }
      else if (e.status === 404) cool[model] = Date.now() + 3600000;   // 제공되지 않는 모델은 1시간 건너뜀
      else if (e.status === 503 || timeout) cool[model] = Date.now() + 30000;
      st.attempts.push({ model, status: e.status || (timeout ? "timeout" : "error"), ms: Date.now() - t0, quota: e.quota, retryDelay: e.retryDelay, message: String(e.message).slice(0, 160) });
      if (!e.retryable && !timeout) throw e;
    }
  }
  throw last || new Error("응답 시간 초과");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST만 지원합니다" });
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "서버에 GEMINI_API_KEY 환경변수가 설정되지 않았습니다 (Vercel → Settings → Environment Variables)" });
  }

  // 입력 검증: 텍스트만, 길이/개수 제한 (남용 방지)
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-12)
    .filter((m) => (m.role === "user" || m.role === "model") && typeof m.text === "string")
    .map((m) => ({ role: m.role, parts: [{ text: m.text.slice(0, 500) }] }));
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return res.status(400).json({ error: "마지막 메시지는 사용자 메시지여야 합니다" });

  const toolCalls = [];
  const st = { msgs, contents: [...msgs], toolCalls, started: Date.now(), used: null, attempts: [] };

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (Date.now() - st.started > 40000) { // Vercel 제한(60초) 전에 스스로 마무리
        return res.status(200).json({ reply: "응답이 오래 걸려 중단했습니다. 잠시 후 다시 시도하거나 질문을 더 짧게 해 주세요.", toolCalls });
      }
      const d = await gemini(st);
      const cand = d.candidates?.[0];
      const parts = cand?.content?.parts || [];
      const calls = parts.filter((p) => p.functionCall);

      if (!calls.length) {
        const reply = parts.map((p) => p.text || "").join("").trim();
        return res.status(200).json({ reply: reply || "답변을 만들지 못했습니다. 다시 질문해 주세요.", toolCalls, model: st.used });
      }

      st.contents.push(cand.content); // 모델의 함수 호출 턴을 그대로 이력에 추가
      const responses = await Promise.all(calls.map(async ({ functionCall: fc }) => {
        const fn = handlers[fc.name];
        let result;
        try { result = fn ? await fn(fc.args || {}) : { error: `알 수 없는 도구: ${fc.name}` }; }
        catch (e) { result = { error: String(e.message || e) }; }
        toolCalls.push({ name: fc.name, args: fc.args || {}, result });
        return { functionResponse: { name: fc.name, response: { result } } };
      }));
      st.contents.push({ role: "user", parts: responses });
    }
    return res.status(200).json({ reply: "도구 호출이 너무 많아 중단했습니다. 질문을 조금 더 구체적으로 해 주세요.", toolCalls });
  } catch (e) {
    const busy = e.retryable || e.name === "TimeoutError" || e.name === "AbortError";
    return res.status(502).json({
      error: busy ? "AI 모델이 모두 혼잡하거나 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요." : String(e.message || e),
      attempts: st.attempts, // 모델별 실패 이유 (진단용)
    });
  }
};
