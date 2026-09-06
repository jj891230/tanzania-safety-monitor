// 탄자니아 전역 예보 강수 격자 — 지도 위 "강수 이동" 애니메이션의 미래 구간(B안).
//
// 브라우저가 Open-Meteo를 직접 부르지 않고 이 함수를 거치는 이유는 순전히 용량이다.
// 196개 지점을 한 번에 요청하면 응답이 286KB인데, 그중 실제로 쓰는 강수 배열은 20KB뿐이고
// 나머지는 지점마다 반복되는 메타데이터(timezone 문자열, units, 48개짜리 time 배열 등)다.
// (실측: 기본 286KB / timeformat=unixtime 211KB / 강수 배열만 20KB)
// 여기서 껍데기를 벗겨 내려주면 14배 가벼워지고, Vercel CDN 캐시까지 얹혀 두 번째
// 방문자부터는 Open-Meteo를 아예 안 부른다.
//
// 격자는 대시보드 지도와 같은 경위도 범위를 14×14로 균등 분할한 것이다. 국경 밖(바다·인접국)
// 지점도 그대로 두는데, 화면에서는 국경으로 잘라내지만 가장자리 보간에는 필요하기 때문이다.

const LON0 = 29.45, LON1 = 40.55, LAT0 = -0.75, LAT1 = -11.95;   // template.html의 지도와 동일
// 한 변의 표본 수. 14(=196지점, 약 79km)로 시작했는데 위성 영상(3km)에서 예보로 넘어갈 때
// 화면이 너무 뭉개져 보인다는 지적을 받아 20(=400지점, 약 55km)으로 올렸다.
// 26까지 올려봤더니 GET URL이 9,770자가 되어 서버가 414(URI Too Long)로 거절했다 —
// 더 촘촘하게 하려면 POST로 바꿔야 한다. (실측: 14→상류 1.7초/슬림 44KB,
// 20→2.4초/89KB, 26→414 에러)
const N = 20;
const HOURS = 48;                 // 앞으로 몇 시간까지
const TZ = "Africa/Dar_es_Salaam";

function buildGrid() {
  const lats = [], lons = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      lons.push(+(LON0 + (LON1 - LON0) * (i + 0.5) / N).toFixed(3));
      lats.push(+(LAT0 + (LAT1 - LAT0) * (j + 0.5) / N).toFixed(3));
    }
  }
  return { lats, lons };
}

async function jget(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error("open-meteo → " + r.status);
    return await r.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error("open-meteo → 응답 없음(" + timeoutMs / 1000 + "초 초과)");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 현지시각 기준 "지금 정시"부터 h시간 뒤를 YYYY-MM-DDTHH:00 으로. Open-Meteo의
// start_hour/end_hour가 timezone과 같은 현지시각 기준이라 변환 없이 바로 쓴다.
function hourStamp(h) {
  const nowLocal = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  nowLocal.setMinutes(0, 0, 0);
  nowLocal.setHours(nowLocal.getHours() + h);
  const p = (n) => String(n).padStart(2, "0");
  return nowLocal.getFullYear() + "-" + p(nowLocal.getMonth() + 1) + "-" + p(nowLocal.getDate()) +
    "T" + p(nowLocal.getHours()) + ":00";
}

module.exports = async (req, res) => {
  const { lats, lons } = buildGrid();
  // forecast_days는 "오늘 00시부터" 세는 값이라, 지금이 저녁이면 앞으로 남는 시간이
  // 얼마 안 된다. 하루 더 받아서 아래에서 현재 시각부터 HOURS만큼 잘라 쓴다.
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=" + lats.join(",") +
    "&longitude=" + lons.join(",") +
    // 강수와 운량을 같이 받는다 — 화면에서 "강수/구름" 모드를 전환할 때 재요청이 없도록.
    // start_hour/end_hour로 필요한 48시간만 딱 잘라 받는다. forecast_days로 받으면
    // 오늘 0시부터 72시간이 와서 3분의 1이 버려진다(실측: 443KB/2.0초 → 317KB/1.5초).
    // 운량을 전체/중층/상층으로 나눠 받는다. 위성 적외(10.8μm)는 낮고 따뜻한 구름을
    // 지면과 구분하지 못해서, 전체 운량만 쓰면 "위성은 맑은데 예보는 100% 흐림"이 된다
    // (실측: 도도마 전체 86% = 전부 낮은구름 → 적외에는 아무것도 안 보임).
    // 그래서 화면에서는 전체 운량으로 "구름이 있는 곳"을, 중·상층운으로 "구름 높이(밝기)"를
    // 그린다 — 위성 쪽도 구름탐지(clm)로 위치, 적외로 밝기를 잡아 같은 방식으로 맞춘다.
    "&hourly=precipitation,cloud_cover,cloud_cover_mid,cloud_cover_high" +
    "&start_hour=" + hourStamp(0) + "&end_hour=" + hourStamp(HOURS - 1) +
    "&timezone=" + encodeURIComponent(TZ);

  let raw;
  try {
    raw = await jget(url);
  } catch (e) {
    res.status(502).json({ error: e.message });
    return;
  }

  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length !== N * N) {
    // 지점 수가 안 맞으면 격자 해석이 통째로 어긋나므로 그리지 않는 편이 낫다
    res.status(502).json({ error: "격자 응답 수 불일치: " + list.length + " ≠ " + N * N });
    return;
  }

  // 시간축은 모든 지점이 동일하므로 한 번만 싣는다(이게 용량 절감의 핵심)
  const timeAll = (list[0].hourly && list[0].hourly.time) || [];

  // 응답은 오늘 00시부터 시작하므로 "지금 시각"의 위치를 찾아 거기서부터 자른다.
  // 안 자르면 슬라이더의 '현재'가 오늘 자정을 가리킨다(실제로 그렇게 나왔었다).
  // 현지시각 문자열(YYYY-MM-DDTHH:00)끼리 비교하는 게 시간대 변환보다 안전하다.
  const nowLocal = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const stamp =
    nowLocal.getFullYear() + "-" + String(nowLocal.getMonth() + 1).padStart(2, "0") + "-" +
    String(nowLocal.getDate()).padStart(2, "0") + "T" + String(nowLocal.getHours()).padStart(2, "0");
  let start = timeAll.findIndex((t) => t.slice(0, 13) >= stamp);
  if (start < 0) start = 0;

  const time = timeAll.slice(start, start + HOURS);
  // 소수 1자리면 충분하다(0.1mm 미만은 어차피 안 그린다). null은 0으로.
  const cells = list.map((p) =>
    ((p.hourly && p.hourly.precipitation) || [])
      .slice(start, start + HOURS)
      .map((v) => (v == null ? 0 : Math.round(v * 10) / 10))
  );
  // 운량은 % 정수라 그대로.
  const clouds = list.map((p) =>
    ((p.hourly && p.hourly.cloud_cover) || [])
      .slice(start, start + HOURS)
      .map((v) => (v == null ? 0 : Math.round(v)))
  );
  // 중·상층운 = 위성 적외가 실제로 볼 수 있는 구름. 둘 중 큰 값을 쓴다(적외 밝기는
  // 가장 높고 차가운 구름 상단이 결정하므로).
  const cloudsHi = list.map((p) => {
    const mid = (p.hourly && p.hourly.cloud_cover_mid) || [];
    const high = (p.hourly && p.hourly.cloud_cover_high) || [];
    return mid.slice(start, start + HOURS).map((v, i) =>
      Math.round(Math.max(v == null ? 0 : v, high[start + i] == null ? 0 : high[start + i])));
  });

  // 10분 CDN 캐시 + 만료 후 1시간까지는 옛 값을 쓰면서 뒤에서 갱신(SWR).
  // 예보는 시간당 한 번 바뀌므로 이 정도면 원본 호출이 거의 안 나간다.
  res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600, max-age=300");
  res.status(200).json({
    checkedAt: new Date().toISOString(),
    bbox: { lon0: LON0, lon1: LON1, lat0: LAT0, lat1: LAT1 },
    n: N,
    time,
    cells,     // 강수 mm/h
    clouds,    // 전체 운량 % — 구름이 "있는 곳"
    cloudsHi,  // 중·상층운 % — 구름 "높이(화면 밝기)". 위성 적외가 보는 것과 같은 범위
  });
};
