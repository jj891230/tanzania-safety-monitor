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
const N = 14;                     // 한 변의 표본 수 → 196지점, 약 80km 간격
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

module.exports = async (req, res) => {
  const { lats, lons } = buildGrid();
  // forecast_days는 "오늘 00시부터" 세는 값이라, 지금이 저녁이면 앞으로 남는 시간이
  // 얼마 안 된다. 하루 더 받아서 아래에서 현재 시각부터 HOURS만큼 잘라 쓴다.
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=" + lats.join(",") +
    "&longitude=" + lons.join(",") +
    "&hourly=precipitation&forecast_days=" + (Math.ceil(HOURS / 24) + 1) +
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

  // 10분 CDN 캐시 + 만료 후 1시간까지는 옛 값을 쓰면서 뒤에서 갱신(SWR).
  // 예보는 시간당 한 번 바뀌므로 이 정도면 원본 호출이 거의 안 나간다.
  res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600, max-age=300");
  res.status(200).json({
    checkedAt: new Date().toISOString(),
    bbox: { lon0: LON0, lon1: LON1, lat0: LAT0, lat1: LAT1 },
    n: N,
    time,
    cells,
  });
};
