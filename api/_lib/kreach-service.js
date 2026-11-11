/* ============================================================
   api/_lib/kreach-service.js — K-REACH 조회 공통 흐름
   ─────────────────────────────────────────────────────────
   api/kreach.js(단건)와 api/kreach-batch.js(묶음)가 같은 캐시 키·
   같은 판정 로직을 쓰도록 "캐시 확인 → 업스트림 조회 → 캐시 저장"
   흐름과 요약(summary) 변환을 한곳에 모은다.
   ============================================================ */

const { fetchKreachRaw, applyContentJudgment } = require('./kreach-parse');
const { getCachedSuccess, setCachedSuccess } = require('./kv-cache');

// v2: 상세 팝업 sources 보존 및 기존/등록대상기존 분류 수정.
// 이전 스키마의 성공 캐시에는 sources가 없어 비고가 빈 것으로 보이므로
// 키 버전을 올려 배포 직후 새 원문을 받아 자가치유한다.
function kreachCacheKey(cas) {
  return `kreach_raw:v2:${cas}`;
}

/** 함량과 무관한 원문(raw). 캐시 우선, 없으면 업스트림 조회 후 성공분만 캐시. */
async function getKreachRaw(cas, apiKey) {
  const cacheKey = kreachCacheKey(cas);
  let raw = await getCachedSuccess(cacheKey);
  if (!raw) {
    raw = await fetchKreachRaw(cas, apiKey);
    await setCachedSuccess(cacheKey, raw);
  }
  return raw;
}

/** 원문 + 함량 판정까지 적용한 최종 결과(기존 /api/kreach 응답과 동일). */
async function getKreachResult(cas, contentMax, isLt, apiKey) {
  const raw = await getKreachRaw(cas, apiKey);
  return applyContentJudgment(raw, contentMax, isLt);
}

function regulationLabel(r) {
  return r.hazardCategory ? `${r.type}(${r.hazardCategory})` : r.type;
}

function uniq(list) {
  return [...new Set(list)];
}

/**
 * 판정 결과만 남긴 요약.
 *   regulated  : 입력 함량 기준으로 해당되는 규제(matchedByContent:true)
 *   notMatched : 물질에 규제는 있으나 입력 함량에서는 해당되지 않는 규제
 */
function toSummary(final) {
  if (!final || final.success !== true) return final;
  const regs = final.regulations || [];
  return {
    success: true,
    cas: final.casNo,
    name: final.chemicalName || '',
    nameKor: final.chemicalNameKor || '',
    nameEn: final.chemicalNameEn || '',
    notFound: !!final.notFound,
    existing: !!(final.existingChemical && final.existingChemical.matched),
    prohibited: !!final.prohibited,
    prohibitedReason: final.prohibitedReason || '',
    regulated: uniq(regs.filter((r) => r.matchedByContent).map(regulationLabel)),
    notMatched: uniq(regs.filter((r) => !r.matchedByContent).map(regulationLabel)),
    infoTags: uniq((final.infoTags || []).map((t) => t.type)),
    contentMax: final.contentMax,
    isLt: final.isLt,
  };
}

module.exports = { kreachCacheKey, getKreachRaw, getKreachResult, toSummary };
