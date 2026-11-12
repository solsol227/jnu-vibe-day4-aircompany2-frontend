// 진단용: GET /api/health → Gemini 응답 속도와 사용 가능한 flash 모델 목록 확인
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

module.exports = async (req, res) => {
  const key = (process.env.GEMINI_API_KEY || "").trim();
  const out = {
    model: MODEL,
    gemini_key_set: !!key,
    kakao_key_set: !!(process.env.KAKAO_REST_API_KEY || "").trim(),
    thinking_level: process.env.GEMINI_THINKING_LEVEL || null,
  };
  if (!key) return res.status(200).json(out);

  const chain = (process.env.GEMINI_MODEL || "gemini-3.8-flash,gemini-3.7-flash,gemini-flash-latest,gemini-3.5-flash")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const level = (process.env.GEMINI_THINKING_LEVEL || "").trim();
  out.chain = chain;
  // 모델별로 동시에 호출해 상태·소요시간을 비교 (thinkingLevel 포함/미포함 둘 다)
  const probe = async (model, withThinking) => {
    const t = Date.now();
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "한 단어로 인사해줘" }] }],
          ...(withThinking && level ? { generationConfig: { thinkingConfig: { thinkingLevel: level } } } : {}),
        }),
      });
      const d = await r.json().catch(() => ({}));
      return { status: r.status, ms: Date.now() - t, reply: d.candidates?.[0]?.content?.parts?.map((p) => p.text).join("").slice(0, 30), error: d.error?.message?.slice(0, 120) };
    } catch (e) { return { status: "fail", ms: Date.now() - t, error: e.name }; }
  };
  const jobs = chain.flatMap((m) => (level ? [[m, true], [m, false]] : [[m, false]]));
  const res2 = await Promise.all(jobs.map(([m, th]) => probe(m, th)));
  out.probes = jobs.map(([m, th], i) => ({ model: m, thinking: th ? level : "off", ...res2[i] }));

  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
      headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(8000),
    });
    const d = await r.json();
    out.available_flash_models = (d.models || []).map((m) => m.name.replace("models/", "")).filter((n) => /flash/.test(n));
  } catch (e) { out.available_flash_models = "조회 실패: " + e.message; }

  res.status(200).json(out);
};
