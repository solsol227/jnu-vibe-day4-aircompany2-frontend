// Vercel 서버리스 함수: Gemini 함수 호출(function calling) 에이전트
// 환경변수: GEMINI_API_KEY (필수), GEMINI_MODEL (선택, 기본 gemini-3.8-flash)
const { declarations, handlers } = require("./_tools");

const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const MAX_STEPS = 5; // 도구 호출 반복 상한

const SYSTEM = `당신은 한국 여행 추천 에이전트입니다. 한국어로, 친근하고 간결하게 답하세요.
- 날씨가 판단에 필요하면 get_weather를, 장소 추천이 필요하면 find_spots를 호출하세요. 둘 다 필요하면 둘 다 호출하세요.
- 장소를 추천할 때는 먼저 get_weather로 날씨와 미세먼지를 확인하고 반영하세요. (비·눈·미세먼지 '나쁨' 이상이면 실내 위주: museum/cafe, 맑고 쾌적하면 야외: park/beach/attraction)
- location 인자는 사용자가 말한 지명을 그대로(한글) 넣으세요. 위치를 못 찾았다고 나오면 영문 지명으로 한 번 재시도하세요.
- find_spots 결과에 url이 있으면 장소 이름 옆에 함께 안내해도 좋습니다.
- 도구 결과에 없는 장소나 수치를 지어내지 마세요. 오류가 나면 다른 인자로 한 번 재시도하고, 그래도 안 되면 솔직히 알려주세요.
- 미세먼지는 모델 예측값이라 실측과 다를 수 있음을 필요할 때 짧게 언급하세요.
- 답변은 추천 이유(날씨 근거)를 포함해 5~8줄 이내로 정리하세요.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 일시적 과부하(429/500/503)는 짧게 대기하며 최대 2번 시도
async function gemini(contents) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY.trim() },
      signal: AbortSignal.timeout(12000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents,
        tools: [{ functionDeclarations: declarations }],
        generationConfig: { temperature: 0.5 },
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) return d;
    last = new Error(d.error?.message || `Gemini 오류 (${r.status})`);
    if (![429, 500, 503].includes(r.status)) break;   // 키/요청 오류는 재시도해도 소용없음
    await sleep(1000 * (attempt + 1));
  }
  throw last;
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

  const contents = [...msgs];
  const toolCalls = [];
  const started = Date.now();

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (Date.now() - started > 18000) { // Vercel 제한(30초) 전에 스스로 마무리
        return res.status(200).json({ reply: "응답이 오래 걸려 중단했습니다. 잠시 후 다시 시도하거나 질문을 더 짧게 해 주세요.", toolCalls });
      }
      const d = await gemini(contents);
      const cand = d.candidates?.[0];
      const parts = cand?.content?.parts || [];
      const calls = parts.filter((p) => p.functionCall);

      if (!calls.length) {
        const reply = parts.map((p) => p.text || "").join("").trim();
        return res.status(200).json({ reply: reply || "답변을 만들지 못했습니다. 다시 질문해 주세요.", toolCalls });
      }

      contents.push(cand.content); // 모델의 함수 호출 턴을 그대로 이력에 추가
      const responses = await Promise.all(calls.map(async ({ functionCall: fc }) => {
        const fn = handlers[fc.name];
        let result;
        try { result = fn ? await fn(fc.args || {}) : { error: `알 수 없는 도구: ${fc.name}` }; }
        catch (e) { result = { error: String(e.message || e) }; }
        toolCalls.push({ name: fc.name, args: fc.args || {}, result });
        return { functionResponse: { name: fc.name, response: { result } } };
      }));
      contents.push({ role: "user", parts: responses });
    }
    return res.status(200).json({ reply: "도구 호출이 너무 많아 중단했습니다. 질문을 조금 더 구체적으로 해 주세요.", toolCalls });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
};
