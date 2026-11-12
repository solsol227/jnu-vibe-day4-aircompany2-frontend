// Open-Meteo API (API 키 불필요)
const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";
const REFRESH_MS = 10 * 60 * 1000; // 10분마다 자동 갱신

// 한국 환경부 기준 등급 (㎍/㎥)
const GRADE_COLOR = { "좋음": "#2f80ed", "보통": "#27ae60", "나쁨": "#f2994a", "매우나쁨": "#eb5757" };
const GRAY = "#9aa0a6";
function grade(kind, v) {
  if (v == null) return null;
  const cut = kind === "pm10" ? [30, 80, 150] : [15, 35, 75];
  return v <= cut[0] ? "좋음" : v <= cut[1] ? "보통" : v <= cut[2] ? "나쁨" : "매우나쁨";
}
const badge = (g) => g ? `<span class="badge" style="background:${GRADE_COLOR[g]}">${g}</span>` : "";

// 17개 시도 (지도 마커용)
const SIDO = [
  ["서울", 37.5665, 126.978], ["부산", 35.1796, 129.0756], ["대구", 35.8714, 128.6014],
  ["인천", 37.4563, 126.7052], ["광주", 35.1595, 126.8526], ["대전", 36.3504, 127.3845],
  ["울산", 35.5384, 129.3114], ["세종", 36.48, 127.289], ["경기(수원)", 37.2636, 127.0286],
  ["강원(춘천)", 37.8813, 127.7298], ["충북(청주)", 36.6424, 127.489], ["충남(홍성)", 36.6012, 126.6608],
  ["전북(전주)", 35.8242, 127.148], ["전남(무안)", 34.8161, 126.4629], ["경북(안동)", 36.5684, 128.7294],
  ["경남(창원)", 35.2279, 128.6811], ["제주", 33.4996, 126.5312],
];

// WMO weather code → [이모지, 설명]
const WMO = {
  0: ["☀️", "맑음"], 1: ["🌤️", "대체로 맑음"], 2: ["⛅", "구름 조금"], 3: ["☁️", "흐림"],
  45: ["🌫️", "안개"], 48: ["🌫️", "서리 안개"],
  51: ["🌦️", "약한 이슬비"], 53: ["🌦️", "이슬비"], 55: ["🌦️", "강한 이슬비"],
  56: ["🌧️", "약한 어는 이슬비"], 57: ["🌧️", "어는 이슬비"],
  61: ["🌧️", "약한 비"], 63: ["🌧️", "비"], 65: ["🌧️", "강한 비"],
  66: ["🌧️", "어는 비"], 67: ["🌧️", "강한 어는 비"],
  71: ["🌨️", "약한 눈"], 73: ["🌨️", "눈"], 75: ["❄️", "강한 눈"], 77: ["❄️", "싸락눈"],
  80: ["🌦️", "약한 소나기"], 81: ["🌧️", "소나기"], 82: ["⛈️", "강한 소나기"],
  85: ["🌨️", "눈 소나기"], 86: ["❄️", "강한 눈 소나기"],
  95: ["⛈️", "뇌우"], 96: ["⛈️", "우박 동반 뇌우"], 99: ["⛈️", "강한 우박 뇌우"],
};
const wmo = (c) => WMO[c] || ["❓", "알 수 없음"];

const $ = (id) => document.getElementById(id);
let current = { name: "서울", lat: 37.5665, lon: 126.978 };
let timer = null;

function setStatus(msg) { $("status").textContent = msg; }

// ---------- 한글 → 영문(국어 로마자 표기법) 변환 ----------
const R_INIT = ["g","kk","n","d","tt","r","m","b","pp","s","ss","","j","jj","ch","k","t","p","h"];
const R_VOWEL = ["a","ae","ya","yae","eo","e","yeo","ye","o","wa","wae","oe","yo","u","wo","we","wi","yu","eu","ui","i"];
const R_FINAL = ["","k","k","k","n","n","n","t","l","k","m","l","l","l","p","l","m","p","p","t","t","ng","t","t","k","t","p","t"];

function romanize(text) {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0) - 0xac00;
    if (code < 0 || code > 11171) { out += ch; continue; }
    out += R_INIT[Math.floor(code / 588)] + R_VOWEL[Math.floor((code % 588) / 28)] + R_FINAL[code % 28];
  }
  return out;
}

// 영문 검색어 후보: 로마자 변환 + 행정구역 접미사(시/군/구/도) 제거 버전
function englishVariants(q) {
  if (!/[가-힣]/.test(q)) return [];
  const v = [romanize(q)];
  const stripped = q.replace(/[시군구도]$/, "");
  if (stripped && stripped !== q) v.push(romanize(stripped));
  return [...new Set(v)];
}

// ---------- 주요 지역 (1글자 입력부터 즉시 추천) ----------
const KR_PLACES = [
  ["서울","Seoul",37.5665,126.978],["부산","Busan",35.1796,129.0756],["대구","Daegu",35.8714,128.6014],
  ["인천","Incheon",37.4563,126.7052],["광주","Gwangju",35.1595,126.8526],["대전","Daejeon",36.3504,127.3845],
  ["울산","Ulsan",35.5384,129.3114],["세종","Sejong",36.48,127.289],["수원","Suwon",37.2636,127.0286],
  ["성남","Seongnam",37.4201,127.1262],["고양","Goyang",37.6584,126.832],["용인","Yongin",37.2411,127.1776],
  ["창원","Changwon",35.2279,128.6811],["청주","Cheongju",36.6424,127.489],["천안","Cheonan",36.8151,127.1139],
  ["전주","Jeonju",35.8242,127.148],["포항","Pohang",36.019,129.3435],["제주","Jeju",33.4996,126.5312],
  ["서귀포","Seogwipo",33.2541,126.56],["춘천","Chuncheon",37.8813,127.7298],["강릉","Gangneung",37.7519,128.8761],
  ["속초","Sokcho",38.207,128.5918],["원주","Wonju",37.3422,127.9202],["목포","Mokpo",34.8118,126.3922],
  ["여수","Yeosu",34.7604,127.6622],["순천","Suncheon",34.9506,127.4872],["안동","Andong",36.5684,128.7294],
  ["경주","Gyeongju",35.8562,129.2247],["김해","Gimhae",35.2285,128.8894],["진주","Jinju",35.18,128.1076],
  ["군산","Gunsan",35.9676,126.7369],["평택","Pyeongtaek",36.9921,127.1127],["울릉","Ulleung",37.4845,130.9057],
  ["독도","Dokdo",37.2426,131.8597],["통영","Tongyeong",34.8544,128.4331],["거제","Geoje",34.8806,128.6211],
];

function localSuggest(q) {
  return KR_PLACES.filter(([ko]) => ko.startsWith(q)).map(([ko, en, lat, lon]) => ({
    id: `local-${en}`, name: ko, sub: en, lat, lon,
  }));
}

async function geocode(name) {
  const url = `${GEO_URL}?name=${encodeURIComponent(name)}&count=10&language=ko&countryCode=KR`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || []).map((r) => ({
    id: String(r.id), name: r.name, sub: [r.admin1, r.admin2].filter(Boolean).join(" "), lat: r.latitude, lon: r.longitude,
  }));
}

// 한글로 먼저 검색하고, 결과가 부족하면 영문으로 변환해서 재검색
async function findPlaces(q) {
  const results = [...localSuggest(q)];
  const seen = new Set(results.map((r) => r.name));
  const add = (list) => list.forEach((r) => {
    const key = r.name + r.sub;
    if (!seen.has(r.name) && !seen.has(key)) { seen.add(key); results.push(r); }
  });
  if (q.length >= 2) {
    add(await geocode(q).catch(() => []));
    if (results.length < 5) {
      for (const en of englishVariants(q)) add(await geocode(en).catch(() => []));
    }
  }
  return results.slice(0, 8);
}

// ---------- 자동완성 UI ----------
let suggestions = [];
let activeIdx = -1;
let seq = 0;

function renderSuggest() {
  const ul = $("suggest");
  ul.innerHTML = suggestions.map((s, i) =>
    `<li data-i="${i}" class="${i === activeIdx ? "active" : ""}"><span>${s.name}</span><small>${s.sub || ""}</small></li>`
  ).join("");
  ul.hidden = suggestions.length === 0;
}

function pick(i) {
  const s = suggestions[i];
  if (!s) return;
  $("city-input").value = s.name;
  suggestions = []; activeIdx = -1; renderSuggest();
  load({ name: s.sub && !s.id.startsWith("local-") ? `${s.name}, ${s.sub}` : s.name, lat: s.lat, lon: s.lon });
}

let debounce;
$("city-input").addEventListener("input", (e) => {
  const q = e.target.value.trim();
  clearTimeout(debounce);
  if (!q) { suggestions = []; renderSuggest(); return; }
  debounce = setTimeout(async () => {
    const my = ++seq;
    const list = await findPlaces(q);
    if (my !== seq) return; // 오래된 응답 무시
    suggestions = list; activeIdx = -1; renderSuggest();
    if (!list.length) setStatus(`'${q}' 에 해당하는 지역이 없습니다`);
    else setStatus("");
  }, 250);
});

$("city-input").addEventListener("keydown", (e) => {
  if (!suggestions.length) return;
  if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = (activeIdx + 1) % suggestions.length; renderSuggest(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = (activeIdx - 1 + suggestions.length) % suggestions.length; renderSuggest(); }
  else if (e.key === "Escape") { suggestions = []; renderSuggest(); }
});

$("suggest").addEventListener("mousedown", (e) => {
  const li = e.target.closest("li");
  if (li) { e.preventDefault(); pick(Number(li.dataset.i)); }
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".combo")) { suggestions = []; renderSuggest(); }
});

async function fetchWeather({ lat, lon }) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: "auto",
    forecast_days: 7,
  });
  const res = await fetch(`${FORECAST_URL}?${params}`);
  if (!res.ok) throw new Error("날씨 데이터를 가져오지 못했습니다");
  return res.json();
}

async function fetchAir(lat, lon) {
  const params = new URLSearchParams({ latitude: lat, longitude: lon, current: "pm10,pm2_5", timezone: "auto" });
  const res = await fetch(`${AIR_URL}?${params}`);
  if (!res.ok) throw new Error("미세먼지 데이터를 가져오지 못했습니다");
  const c = (await res.json()).current;
  return { pm10: c.pm10, pm25: c.pm2_5 };
}

function renderAir(a) {
  const f = (v, k) => v == null ? "-" : `${Math.round(v)} ㎍/㎥${badge(grade(k, v))}`;
  $("pm10").innerHTML = a ? f(a.pm10, "pm10") : "-";
  $("pm25").innerHTML = a ? f(a.pm25, "pm25") : "-";
}

function render(place, d) {
  const c = d.current, u = d.current_units;
  const [icon, desc] = wmo(c.weather_code);
  $("place").textContent = place.name;
  $("icon").textContent = icon;
  $("temp").textContent = `${Math.round(c.temperature_2m)}${u.temperature_2m}`;
  $("desc").textContent = desc;
  $("feels").textContent = `${Math.round(c.apparent_temperature)}${u.apparent_temperature}`;
  $("humidity").textContent = `${c.relative_humidity_2m}${u.relative_humidity_2m}`;
  $("wind").textContent = `${c.wind_speed_10m} ${u.wind_speed_10m}`;
  $("precip").textContent = `${c.precipitation} ${u.precipitation}`;
  $("updated").textContent = `업데이트: ${c.time.replace("T", " ")} (현지 시각)`;

  const days = ["일", "월", "화", "수", "목", "금", "토"];
  $("daily").innerHTML = d.daily.time.map((t, i) => {
    const dt = new Date(t + "T00:00:00");
    const label = i === 0 ? "오늘" : `${dt.getMonth() + 1}/${dt.getDate()} ${days[dt.getDay()]}`;
    const [ic, ds] = wmo(d.daily.weather_code[i]);
    return `<li>
      <span>${label}</span>
      <span class="ico" title="${ds}">${ic}</span>
      <span class="rng">${Math.round(d.daily.temperature_2m_min[i])}° / ${Math.round(d.daily.temperature_2m_max[i])}°</span>
      <span class="rain">💧${d.daily.precipitation_probability_max[i] ?? 0}%</span>
    </li>`;
  }).join("");
  $("weather").hidden = false;
}

async function load(place) {
  current = place;
  setStatus("불러오는 중...");
  try {
    const [w, air] = await Promise.all([fetchWeather(place), fetchAir(place.lat, place.lon).catch(() => null)]);
    render(place, w);
    renderAir(air);
    focusMap(place);
    setStatus("");
  } catch (e) {
    setStatus(`⚠️ ${e.message}`);
  }
  clearInterval(timer);
  timer = setInterval(() => load(current), REFRESH_MS);
}

$("search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("city-input").value.trim();
  if (!q) return;
  if (suggestions.length) return pick(Math.max(activeIdx, 0));
  setStatus("검색 중...");
  const list = await findPlaces(q);
  if (!list.length) return setStatus(`⚠️ '${q}' 지역을 찾을 수 없습니다`);
  suggestions = list;
  pick(0);
});

$("geo-btn").addEventListener("click", () => {
  if (!navigator.geolocation) return setStatus("이 브라우저는 위치 정보를 지원하지 않습니다");
  setStatus("위치 확인 중...");
  navigator.geolocation.getCurrentPosition(
    (p) => load({ name: "내 위치", lat: p.coords.latitude, lon: p.coords.longitude }),
    () => setStatus("위치 권한이 거부되었습니다"),
  );
});

load(current);

// ---------- 지도 (Leaflet) ----------
let map = null, markerLayer = null, spotLayer = null, selected = null, sidoData = [];

function markerIcon(r, isSel) {
  const chip = (v, k) => {
    const c = GRADE_COLOR[grade(k, v)] || GRAY;
    return `<span style="background:${c};color:#fff;border-radius:4px;padding:0 4px;min-width:20px;text-align:center">${v == null ? "-" : Math.round(v)}</span>`;
  };
  const t = r.temp == null ? "-" : `${Math.round(r.temp)}°`;
  return L.divIcon({
    className: "", iconSize: [64, 44], iconAnchor: [32, 22],
    html: `<div style="width:64px;height:44px;border-radius:10px;background:#fff;color:#1b2a49;display:flex;flex-direction:column;` +
      `align-items:center;justify-content:center;gap:2px;font:bold 11px sans-serif;box-shadow:0 1px 5px rgba(0,0,0,.45);` +
      `border:${isSel ? "3px solid #1b2a49" : "1px solid #ccc"}">` +
      `<div style="font-size:15px;line-height:1">${t}</div>` +
      `<div style="display:flex;gap:3px">${chip(r.pm10, "pm10")}${chip(r.pm25, "pm25")}</div></div>`,
  });
}

function drawMarkers() {
  if (!markerLayer) return;
  markerLayer.clearLayers();
  for (const r of sidoData) {
    L.marker([r.lat, r.lon], { icon: markerIcon(r, r.name === selected) })
      .on("click", (e) => { L.DomEvent.stopPropagation(e); load({ name: r.name, lat: r.lat, lon: r.lon }); })
      .bindTooltip(`${r.name} · ${r.temp == null ? "-" : Math.round(r.temp) + "°C"} · PM10 ${r.pm10 == null ? "-" : Math.round(r.pm10)} · PM2.5 ${r.pm25 == null ? "-" : Math.round(r.pm25)}`)
      .addTo(markerLayer);
  }
}

function focusMap(place) {
  selected = place.name;
  if (!map) return;
  map.setView([place.lat, place.lon], Math.max(map.getZoom(), 8));
  drawMarkers();
}

const CACHE_KEY = "sido-cache-v2";
async function loadSido() {
  // 새로고침해도 10분 안에는 저장된 값 사용 (Open-Meteo 호출 제한 보호)
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (c && Date.now() - c.t < REFRESH_MS) { sidoData = c.data; return drawMarkers(); }
  } catch {}
  const lat = SIDO.map((s) => s[1]).join(","), lon = SIDO.map((s) => s[2]).join(",");
  const [w, a] = await Promise.all([
    fetch(`${FORECAST_URL}?latitude=${lat}&longitude=${lon}&current=temperature_2m&timezone=auto`).then((r) => r.json()),
    fetch(`${AIR_URL}?latitude=${lat}&longitude=${lon}&current=pm10,pm2_5&timezone=auto`).then((r) => r.json()).catch(() => []),
  ]);
  const wl = Array.isArray(w) ? w : [w], al = Array.isArray(a) ? a : [a];
  sidoData = SIDO.map(([name, la, lo], i) => ({
    name, lat: la, lon: lo,
    temp: wl[i]?.current?.temperature_2m,
    pm10: al[i]?.current?.pm10,
    pm25: al[i]?.current?.pm2_5,
  }));
  if (sidoData.every((x) => x.temp != null && x.pm25 != null)) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), data: sidoData })); } catch {}
  }
  drawMarkers();
}

function initMap() {
  if (typeof L === "undefined") return setStatus("지도 라이브러리를 불러오지 못했습니다");
  map = L.map("map").setView([36.2, 127.8], 7);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    { attribution: "© OpenStreetMap", maxZoom: 18 }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  spotLayer = L.layerGroup().addTo(map);
  map.on("click", (e) => load({ name: "선택 지점", lat: e.latlng.lat, lon: e.latlng.lng }));
  loadSido().catch(() => setStatus("⚠️ 전국 지도 데이터를 불러오지 못했습니다"));
  setInterval(() => loadSido().catch(() => {}), REFRESH_MS);
}

initMap();

// ---------- AI 에이전트 (Gemini + get_weather / find_spots, 서버: Vercel /api/chat) ----------
const chatLog = [];          // [{role:"user"|"model", text}]
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const mdLite = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");

function addMsg(role, html) {
  const d = document.createElement("div");
  d.className = `msg ${role}`;
  d.innerHTML = html;
  $("chat-log").appendChild(d);
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
  return d;
}

function showSpots(calls) {
  const spots = calls.filter((c) => c.name === "find_spots").flatMap((c) => c.result?.spots || []);
  if (!spots.length || !spotLayer) return;
  spotLayer.clearLayers();
  spots.forEach((p) => L.marker([p.lat, p.lon]).bindPopup(`<b>${esc(p.name)}</b><br>${esc(p.type)} · ${p.distance_m}m` + (p.address ? `<br>${esc(p.address)}` : "") + (p.url && /^https?:\/\//.test(p.url) ? `<br><a href="${esc(p.url)}" target="_blank" rel="noopener">카카오맵에서 보기</a>` : "")).addTo(spotLayer));
  map.fitBounds(spots.map((p) => [p.lat, p.lon]), { padding: [30, 30], maxZoom: 13 });
  $("map").scrollIntoView({ behavior: "smooth", block: "center" });
}

async function ask(text) {
  addMsg("user", esc(text));
  chatLog.push({ role: "user", text });
  const wait = addMsg("model", "생각 중...");
  $("chat-send").disabled = true;
  try {
    const res = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: chatLog.slice(-12) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const why = (data.attempts || []).map((x) => `${x.model}: ${x.status} ${x.ms}ms`).join("\n");
      throw new Error((data.error || `서버 오류 (${res.status})`) + (why ? "\n\n[진단]\n" + why : ""));
    }
    const tools = (data.toolCalls || []).map((c) =>
      `<span class="tool">🔧 ${esc(c.name)}(${esc(Object.values(c.args || {}).join(", "))})</span>`).join(" ");
    wait.innerHTML = (tools ? tools + "<br>" : "") + mdLite(data.reply) + (data.model ? `<div class="tool" style="margin:6px 0 0">${esc(data.model)}</div>` : "");
    chatLog.push({ role: "model", text: data.reply });
    showSpots(data.toolCalls || []);
  } catch (e) {
    wait.innerHTML = `⚠️ ${mdLite(e.message)}`;
    chatLog.pop();
  } finally {
    $("chat-send").disabled = false;
  }
}

$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const t = $("chat-input").value.trim();
  if (!t) return;
  $("chat-input").value = "";
  ask(t);
});
document.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => ask(b.textContent)));
