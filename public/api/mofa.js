// 대시보드용 외교부 자료 프록시 — 여행경보·대사관 안전공지·대사관 연락처(_lib/mofa.js).
// 인증키를 브라우저에 내보내지 않기 위해 서버에서 부르고, CDN에 30분 캐시 + 만료 후 하루까지는
// 옛 값을 먼저 주고 뒤에서 갱신한다(여행경보·공지는 하루에 몇 번 바뀌는 자료가 아니다).
const { fetchMofa } = require("./_lib/mofa.js");

module.exports = async (req, res) => {
  try {
    const d = await fetchMofa({ key: process.env.DATA_GO_KR_KEY, timeoutMs: 10000, notices: 8 });
    // 셋 다 실패면 캐시가 낫다 — 502로 돌려 CDN이 옛 성공본을 계속 내주게 한다
    if (!d.alarm && !d.notices && !d.embassy) {
      res.setHeader("Cache-Control", "no-store");
      res.status(502).json({ error: d.errors.join("; ") });
      return;
    }
    res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400, max-age=300");
    res.status(200).json({ checkedAt: new Date().toISOString(), ...d });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ error: e.message });
  }
};
