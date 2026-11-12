// 에이전트가 호출하는 두 가지 도구: get_weather, find_spots (둘 다 API 키 불필요)
const UA = "weather-agent-demo/1.0";

// ---------- 공통: 지명 → 좌표 (Open-Meteo 지오코딩) ----------
const KAKAO_KEY = () => (process.env.KAKAO_REST_API_KEY || "").trim();
let kakaoErr = null; // 마지막 카카오 호출 실패 이유 (도구 결과에 노출해 원인을 바로 볼 수 있게 함)
const kakaoGet = async (path, params) => {
  const r = await fetch(`https://dapi.kakao.com/v2/local/search/${path}.json?${new URLSearchParams(params)}`, {
    headers: { Authorization: `KakaoAK ${KAKAO_KEY()}` }, signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    kakaoErr = `Kakao ${r.status}: ${body.message || body.errorType || ""}`.trim();
    throw new Error(kakaoErr);
  }
  kakaoErr = null;
  return r.json();
};

// 카카오가 안 될 때를 대비한 한글 → 영문 지명 (Open-Meteo 지오코딩은 한글 검색이 약함)
const ALIAS = {
  서울: "Seoul", 부산: "Busan", 대구: "Daegu", 인천: "Incheon", 광주: "Gwangju", 대전: "Daejeon", 울산: "Ulsan",
  세종: "Sejong", 수원: "Suwon", 성남: "Seongnam", 고양: "Goyang", 용인: "Yongin", 창원: "Changwon", 청주: "Cheongju",
  천안: "Cheonan", 전주: "Jeonju", 포항: "Pohang", 제주: "Jeju", 서귀포: "Seogwipo", 춘천: "Chuncheon", 강릉: "Gangneung",
  속초: "Sokcho", 원주: "Wonju", 목포: "Mokpo", 여수: "Yeosu", 순천: "Suncheon", 안동: "Andong", 경주: "Gyeongju",
  김해: "Gimhae", 진주: "Jinju", 군산: "Gunsan", 평택: "Pyeongtaek", 울릉: "Ulleung", 독도: "Dokdo", 통영: "Tongyeong",
  거제: "Geoje", 제주도: "Jeju", 제주시: "Jeju", 양양: "Yangyang", 가평: "Gapyeong", 남원: "Namwon", 담양: "Damyang",
};

// 주요 도시는 좌표를 확정해 둠 (카카오 키워드 검색은 "제주" → 올레길처럼 도시가 아닌 장소를 첫 결과로 줄 수 있음)
const CITY = {
  서울: [37.5665, 126.978], 부산: [35.1796, 129.0756], 대구: [35.8714, 128.6014], 인천: [37.4563, 126.7052],
  광주: [35.1595, 126.8526], 대전: [36.3504, 127.3845], 울산: [35.5384, 129.3114], 세종: [36.48, 127.289],
  수원: [37.2636, 127.0286], 성남: [37.4201, 127.1262], 고양: [37.6584, 126.832], 용인: [37.2411, 127.1776],
  창원: [35.2279, 128.6811], 청주: [36.6424, 127.489], 천안: [36.8151, 127.1139], 전주: [35.8242, 127.148],
  포항: [36.019, 129.3435], 제주: [33.4996, 126.5312], 제주시: [33.4996, 126.5312], 제주도: [33.4996, 126.5312],
  서귀포: [33.2541, 126.56], 춘천: [37.8813, 127.7298], 강릉: [37.7519, 128.8761], 속초: [38.207, 128.5918],
  원주: [37.3422, 127.9202], 목포: [34.8118, 126.3922], 여수: [34.7604, 127.6622], 순천: [34.9506, 127.4872],
  안동: [36.5684, 128.7294], 경주: [35.8562, 129.2247], 김해: [35.2285, 128.8894], 진주: [35.18, 128.1076],
  군산: [35.9676, 126.7369], 평택: [36.9921, 127.1127], 울릉: [37.4845, 130.9057], 독도: [37.2426, 131.8597],
  통영: [34.8544, 128.4331], 거제: [34.8806, 128.6211], 양양: [38.0754, 128.619], 가평: [37.8315, 127.5095],
};

async function geocode(location) {
  const city = CITY[(location || "").trim()];
  if (city) return { name: location.trim(), lat: city[0], lon: city[1] };
  if (KAKAO_KEY()) { // 카카오: 한글 지명("제주", "홍대입구역")을 그대로 처리
    try {
      const a = await kakaoGet("address", { query: location, size: 1 }).catch(() => null);
      const ad = a?.documents?.[0];
      if (ad) return { name: ad.address_name, lat: +ad.y, lon: +ad.x };
      const d = await kakaoGet("keyword", { query: location, size: 1 });
      const k = d.documents?.[0];
      if (k) return { name: k.place_name, lat: +k.y, lon: +k.x };
    } catch { /* Open-Meteo로 폴백 */ }
  }
  const q = ALIAS[location.trim()] || location;
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=ko`;
  const r = await fetch(url);
  const d = await r.json();
  const g = d.results?.[0];
  if (!g) return null;
  return { name: [g.name, g.admin1].filter(Boolean).join(", "), lat: g.latitude, lon: g.longitude };
}

async function resolvePlace({ location, latitude, longitude }) {
  if (typeof latitude === "number" && typeof longitude === "number") {
    return { name: location || "지정 좌표", lat: latitude, lon: longitude };
  }
  if (!location) return null;
  return geocode(location);
}

const WMO = {
  0: "맑음", 1: "대체로 맑음", 2: "구름 조금", 3: "흐림", 45: "안개", 48: "서리 안개",
  51: "약한 이슬비", 53: "이슬비", 55: "강한 이슬비", 61: "약한 비", 63: "비", 65: "강한 비",
  71: "약한 눈", 73: "눈", 75: "강한 눈", 80: "약한 소나기", 81: "소나기", 82: "강한 소나기",
  95: "뇌우", 96: "우박 동반 뇌우", 99: "강한 우박 뇌우",
};
const pmGrade = (kind, v) => {
  if (v == null) return null;
  const c = kind === "pm10" ? [30, 80, 150] : [15, 35, 75];
  return v <= c[0] ? "좋음" : v <= c[1] ? "보통" : v <= c[2] ? "나쁨" : "매우나쁨";
};

// ---------- Tool 1: get_weather ----------
async function get_weather(args) {
  const p = await resolvePlace(args);
  if (!p) return { error: `'${args.location}' 위치를 찾지 못했습니다. 다른 표기(한글↔영문)로 다시 시도하세요.`, kakao_error: kakaoErr || undefined };

  const w = await (await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=4`
  )).json();
  if (w.error) return { error: "날씨 API 오류: " + w.reason };

  let air = null;
  try {
    const a = await (await fetch(
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${p.lat}&longitude=${p.lon}&current=pm10,pm2_5&timezone=auto`
    )).json();
    if (a.current) {
      air = {
        pm10: a.current.pm10, pm10_grade: pmGrade("pm10", a.current.pm10),
        pm25: a.current.pm2_5, pm25_grade: pmGrade("pm25", a.current.pm2_5),
        note: "모델 기반 예측값(실측과 다를 수 있음)",
      };
    }
  } catch { /* 미세먼지는 실패해도 날씨는 반환 */ }

  const c = w.current;
  return {
    place: p.name, lat: p.lat, lon: p.lon,
    now: {
      temp_c: c.temperature_2m, feels_like_c: c.apparent_temperature, humidity_pct: c.relative_humidity_2m,
      precipitation_mm: c.precipitation, wind_kmh: c.wind_speed_10m, condition: WMO[c.weather_code] || "알 수 없음",
    },
    air,
    forecast: w.daily.time.map((t, i) => ({
      date: t, condition: WMO[w.daily.weather_code[i]] || "알 수 없음",
      min_c: w.daily.temperature_2m_min[i], max_c: w.daily.temperature_2m_max[i],
      rain_prob_pct: w.daily.precipitation_probability_max[i],
    })),
  };
}

// ---------- Tool 2: find_spots (OpenStreetMap Overpass) ----------
const CATEGORY = {
  attraction: '["tourism"~"attraction|viewpoint|museum|gallery|zoo|theme_park"]',
  museum: '["tourism"~"museum|gallery"]',
  cafe: '["amenity"="cafe"]',
  restaurant: '["amenity"="restaurant"]',
  park: '["leisure"~"park|garden|nature_reserve"]',
  beach: '["natural"="beach"]',
};
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

const dist = (la1, lo1, la2, lo2) => {
  const R = 6371000, r = Math.PI / 180;
  const a = Math.sin(((la2 - la1) * r) / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(((lo2 - lo1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

// Overpass가 모두 실패했을 때의 예비 경로 (Nominatim 텍스트 검색)
const WORD = { attraction: "tourist attraction", museum: "museum", cafe: "cafe", restaurant: "restaurant", park: "park", beach: "beach" };
async function nominatimFallback(p, category, radius, limit) {
  const dLat = radius / 111000, dLon = radius / (111000 * Math.cos((p.lat * Math.PI) / 180));
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(WORD[category])}&format=jsonv2&limit=${limit}` +
    `&accept-language=ko&bounded=1&viewbox=${p.lon - dLon},${p.lat + dLat},${p.lon + dLon},${p.lat - dLat}`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(String(r.status));
    const list = await r.json();
    const spots = list.map((x) => ({
      name: x.name || x.display_name.split(",")[0], type: x.type || category,
      lat: +x.lat, lon: +x.lon, distance_m: Math.round(dist(p.lat, p.lon, +x.lat, +x.lon)),
    })).sort((a, b) => a.distance_m - b.distance_m);
    return { center: p.name, category, radius_m: radius, count: spots.length, spots, source: "nominatim(fallback)" };
  } catch {
    return { error: "장소 검색 서버가 응답하지 않습니다. 잠시 후 다시 시도하세요.", kakao_error: kakaoErr || undefined };
  }
}

// 카카오 로컬 API: 카테고리 코드가 있으면 카테고리 검색, 없으면 키워드 검색 (모두 거리순)
const KAKAO_CAT = { attraction: "AT4", museum: "CT1", cafe: "CE7", restaurant: "FD6" };
const KAKAO_WORD = { park: "공원", beach: "해수욕장" };
async function kakaoSpots(p, category, radius, limit) {
  const base = { x: p.lon, y: p.lat, radius, sort: "distance", size: Math.min(limit, 15) };
  const d = KAKAO_CAT[category]
    ? await kakaoGet("category", { ...base, category_group_code: KAKAO_CAT[category] })
    : await kakaoGet("keyword", { ...base, query: KAKAO_WORD[category] });
  const spots = (d.documents || []).map((x) => ({
    name: x.place_name, type: x.category_name?.split(" > ").slice(-1)[0] || category,
    address: x.road_address_name || x.address_name, lat: +x.y, lon: +x.x,
    distance_m: Number(x.distance) || Math.round(dist(p.lat, p.lon, +x.y, +x.x)), url: x.place_url,
  }));
  return { center: p.name, category, radius_m: radius, count: spots.length, spots, source: "kakao" };
}

async function find_spots(args) {
  const category = CATEGORY[args.category] ? args.category : "attraction";
  const limit = Math.min(Math.max(Number(args.limit) || 6, 1), 10);
  const radius = Math.min(Math.max(Number(args.radius_m) || 5000, 500), 20000);
  const p = await resolvePlace(args);
  if (!p) return { error: `'${args.location}' 위치를 찾지 못했습니다. 다른 표기(한글↔영문)로 다시 시도하세요.`, kakao_error: kakaoErr || undefined };

  if (KAKAO_KEY()) {
    const k = await kakaoSpots(p, category, radius, limit).catch(() => null);
    if (k) return k;
  }

  const q = `[out:json][timeout:8];nwr${CATEGORY[category]}["name"](around:${radius},${p.lat},${p.lon});out center 60;`;
  // 두 서버에 동시에 요청하고 먼저 성공한 쪽을 사용 (각 9초 제한)
  let data = null;
  try {
    data = await Promise.any(OVERPASS.map(async (ep) => {
      const r = await fetch(ep, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
        body: "data=" + encodeURIComponent(q), signal: AbortSignal.timeout(9000),
      });
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      if (!Array.isArray(j.elements)) throw new Error("bad overpass response"); // 오류 안내 등은 실패로 처리
      return j;
    }));
  } catch { /* 모두 실패 → 예비 경로 */ }
  if (!data) return nominatimFallback(p, category, radius, limit);

  const spots = (data.elements || [])
    .map((e) => {
      const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
      if (lat == null) return null;
      const t = e.tags;
      return {
        name: t["name:ko"] || t.name, type: t.tourism || t.amenity || t.leisure || t.natural || category,
        lat, lon, distance_m: Math.round(dist(p.lat, p.lon, lat, lon)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance_m - b.distance_m)
    .filter((s, i, arr) => arr.findIndex((x) => x.name === s.name) === i) // 이름 중복 제거
    .slice(0, limit);

  return { center: p.name, category, radius_m: radius, count: spots.length, spots, kakao_error: kakaoErr || undefined };
}

// ---------- Gemini 함수 선언 ----------
const declarations = [
  {
    name: "get_weather",
    description: "특정 장소의 실시간 날씨(기온·체감·습도·강수·풍속), 미세먼지(PM10/PM2.5), 향후 4일 예보를 조회한다.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "지명 (예: 제주, 서울, 홍대입구역, 강릉). 한글 그대로 넣어도 되며, 실패하면 영문(Jeju)으로 재시도" },
      },
      required: ["location"],
    },
  },
  {
    name: "find_spots",
    description: "특정 장소 주변의 관광지·카페·식당·공원·해변·박물관을 검색해 가까운 순으로 돌려준다.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "검색 중심 지명 (예: 제주, 서울, 성수동). 한글 그대로 넣어도 되며, 실패하면 영문으로 재시도" },
        category: {
          type: "string",
          enum: Object.keys(CATEGORY),
          description: "attraction=관광지, museum=박물관/미술관(실내), cafe=카페, restaurant=식당, park=공원, beach=해변",
        },
        radius_m: { type: "integer", description: "검색 반경(미터), 기본 5000, 최대 20000" },
        limit: { type: "integer", description: "결과 개수, 기본 6, 최대 10" },
      },
      required: ["location", "category"],
    },
  },
];

const handlers = { get_weather, find_spots };

module.exports = { declarations, handlers };
