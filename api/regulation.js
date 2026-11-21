/* ============================================================
   api/regulation.js — 인체등유해성물질 지정고시 DB 단독 조회
   ─────────────────────────────────────────────────────────
   GET /api/regulation?cas=71-43-2&contentMax=0.5&isLt=false

   외부 API 호출 없이 api/_data/regulation.json만 조회한다.
   - entries: CAS에 연결된 고유번호별 현재 기준과 유예 대상 고시 이력
   - grace  : 함량을 주면 남은 부칙 유예기한(없으면 null)
   ============================================================ */

const { normalizeCas } = require('./_lib/normalize');
const { DB, entriesFor, computeGrace, todayKst } = require('./_lib/regulation');

function firstValue(v) {
  return Array.isArray(v) ? v[0] : v;
}

module.exports = function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, errorCode: 'METHOD_NOT_ALLOWED', message: 'GET만 지원합니다.' });
    return;
  }
  const cas = normalizeCas(firstValue(req.query.cas));
  if (!cas) {
    res.status(400).json({ success: false, errorCode: 'BAD_REQUEST', message: 'cas 파라미터가 필요합니다.' });
    return;
  }
  const contentMaxRaw = firstValue(req.query.contentMax);
  const parsed = contentMaxRaw !== undefined && contentMaxRaw !== '' ? parseFloat(contentMaxRaw) : NaN;
  const contentMax = Number.isFinite(parsed) ? parsed : null;
  const isLtRaw = firstValue(req.query.isLt);
  const isLt = isLtRaw === 'true' || isLtRaw === '1';

  const today = todayKst();
  const entries = entriesFor(cas).map(({ key, history, ...e }) => ({
    ...e,
    targets: e.targets.map((t) => ({ ...t, noticeDate: DB.notices[t.notice].date })),
  }));
  res.status(200).json({
    success: true,
    casNo: cas,
    found: entries.length > 0,
    entries,
    grace: computeGrace(cas, contentMax, isLt, today),
    today,
    db: { currentList: DB.meta.currentList, kreachSnapshot: DB.meta.kreachSnapshot, builtAt: DB.meta.builtAt },
  });
};
