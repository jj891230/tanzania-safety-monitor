// 대시보드용 GDACS 프록시 — 브라우저가 www.gdacs.org SEARCH API를 직접 부르던 것을
// 대신한다. 그 API는 20~45초씩 걸리거나 끊기는 일이 잦아(_lib/gdacs.js 머리말 참고)
// 대시보드가 "1개 소스 실패"를 자주 띄웠다. 여기서는 1~3초에 오는 RSS를 읽어 같은
// 모양으로 내려주고, Vercel CDN에 10분 캐시 + 만료 후 하루까지는 옛 값을 먼저 주고
// 뒤에서 갱신(stale-while-revalidate)한다. GDACS가 잠깐 죽어도 방문자는 마지막
// 성공본을 본다 — 재해 목록은 분 단위로 바뀌는 자료가 아니므로 이 정도면 충분하다.
const { fetchGdacs } = require("./_lib/gdacs.js");

module.exports = async (req, res) => {
  try {
    const { features, source, errors } = await fetchGdacs({ timeoutMs: 12000, searchTimeoutMs: 20000 });
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=86400, max-age=120");
    res.status(200).json({ checkedAt: new Date().toISOString(), source, count: features.length, errors, features });
  } catch (e) {
    // 캐시된 성공본이 CDN에 남아 있으면 그쪽이 먼저 나가므로, 여기 도달했다면 정말로 없는 경우다
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: e.message });
  }
};
