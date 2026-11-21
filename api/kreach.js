/* ============================================================
   api/kreach.js — 화평법 K-REACH 조회 서버리스 함수
   ─────────────────────────────────────────────────────────
   GET /api/kreach?cas=108-88-3&contentMax=20&isLt=false

   - 원문(raw)만 Vercel KV에 캐시(성공 시에만, TTL 24h)
   - 함량 판정(matchedByContent)은 매 요청마다 무캐시로 재계산
   - API 키는 process.env.API_KEY로만 참조, 응답에 절대 포함하지 않음
   ============================================================ */

const { fetchKreachRaw, applyContentJudgment } = require('./_lib/kreach-parse');
const { getCachedSuccess, setCachedSuccess } = require('./_lib/kv-cache');
const { classifyUpstreamFailure, statusForErrorCode } = require('./_lib/http');
const { normalizeCas } = require('./_lib/normalize');
const { casAlias, enrichKreach } = require('./_lib/regulation');

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

  // v2: 상세 팝업 sources 보존 및 기존/등록대상기존 분류 수정.
  // 이전 스키마의 성공 캐시에는 sources가 없어 비고가 빈 것으로 보이므로
  // 키 버전을 올려 배포 직후 새 원문을 받아 자가치유한다.
  // v3: 묶음 CAS 재조회 도입 — 이전에 미등록으로 캐시된 결과를 갱신한다.
  const cacheKey = `kreach_raw:v3:${cas}`;

  try {
    let raw = await getCachedSuccess(cacheKey);
    if (!raw) {
      raw = await fetchKreachRaw(cas, apiKey);
      // K-REACH는 CAS가 묶여 등록된 물질(예: "105827-78-9, 138261-41-3")을 단일 CAS로는
      // 찾지 못한다 → 규제 DB의 묶음 문자열로 한 번 더 조회한다.
      const alias = raw && raw.notFound ? casAlias(cas) : null;
      if (alias) raw = { ...(await fetchKreachRaw(alias, apiKey)), casNo: cas, searchedAs: alias };
      await setCachedSuccess(cacheKey, raw);
    }
    // 고시 기준 보완(API 미반영분) + 함량 판정 + 유예기한
    const final = enrichKreach(raw, cas, contentMax, isLt, applyContentJudgment);
    res.status(200).json(final);
  } catch (err) {
    const payload = classifyUpstreamFailure(err, err && err.upstreamRes);
    console.error(`[api/kreach] cas=${cas} errorCode=${payload.errorCode}`);
    res.status(statusForErrorCode(payload.errorCode)).json(payload);
  }
};
