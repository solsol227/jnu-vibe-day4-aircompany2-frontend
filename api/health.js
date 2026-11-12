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

  const t = Date.now();
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      signal: AbortSignal.timeout(25000),
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "한 단어로 인사해줘" }] }] }),
    });
    const d = await r.json().catch(() => ({}));
    out.simple_call = { status: r.status, ms: Date.now() - t, reply: d.candidates?.[0]?.content?.parts?.map((p) => p.text).join("").slice(0, 50), error: d.error?.message };
  } catch (e) {
    out.simple_call = { status: "fail", ms: Date.now() - t, error: e.name + ": " + e.message };
  }

  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
      headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(8000),
    });
    const d = await r.json();
    out.available_flash_models = (d.models || []).map((m) => m.name.replace("models/", "")).filter((n) => /flash/.test(n));
  } catch (e) { out.available_flash_models = "조회 실패: " + e.message; }

  res.status(200).json(out);
};
