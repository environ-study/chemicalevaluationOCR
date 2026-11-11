/* ============================================================
   api/kreach.js — 화평법 K-REACH 조회 서버리스 함수
   ─────────────────────────────────────────────────────────
   GET /api/kreach?cas=108-88-3&contentMax=20&isLt=false[&view=summary]
   (여러 CAS를 한 번에 조회하려면 POST /api/kreach-batch 사용)

   - 원문(raw)만 Vercel KV에 캐시(성공 시에만, TTL 24h)
   - 함량 판정(matchedByContent)은 매 요청마다 무캐시로 재계산
   - API 키는 process.env.API_KEY로만 참조, 응답에 절대 포함하지 않음
   ============================================================ */

const { getKreachResult, toSummary } = require('./_lib/kreach-service');
const { classifyUpstreamFailure, statusForErrorCode } = require('./_lib/http');
const { normalizeCas } = require('./_lib/normalize');

function firstValue(v) {
  return Array.isArray(v) ? v[0] : v;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({
      success: false,
      retryable: false,
      errorCode: 'METHOD_NOT_ALLOWED',
      message: 'GET만 지원합니다.',
    });
    return;
  }

  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    res.status(500).json({
      success: false,
      retryable: false,
      errorCode: 'SERVER_MISCONFIGURED',
      message: '서버 환경설정 오류입니다. 관리자에게 문의해 주세요.',
    });
    return;
  }

  const cas = normalizeCas(firstValue(req.query.cas));
  if (!cas) {
    res.status(400).json({
      success: false,
      retryable: false,
      errorCode: 'BAD_REQUEST',
      message: 'cas 파라미터가 필요합니다.',
    });
    return;
  }

  const contentMaxRaw = firstValue(req.query.contentMax);
  const isLtRaw = firstValue(req.query.isLt);
  const parsedContentMax = contentMaxRaw !== undefined && contentMaxRaw !== '' ? parseFloat(contentMaxRaw) : NaN;
  const contentMax = Number.isFinite(parsedContentMax) ? parsedContentMax : null;
  const isLt = isLtRaw === 'true' || isLtRaw === '1';

  const summary = firstValue(req.query.view) === 'summary';

  try {
    const final = await getKreachResult(cas, contentMax, isLt, apiKey);
    res.status(200).json(summary ? toSummary(final) : final);
  } catch (err) {
    const payload = classifyUpstreamFailure(err, err && err.upstreamRes);
    console.error(`[api/kreach] cas=${cas} errorCode=${payload.errorCode}`);
    res.status(statusForErrorCode(payload.errorCode)).json(payload);
  }
};
