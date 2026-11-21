/* ============================================================
   api/_lib/regulation.js — 인체등유해성물질 지정고시 DB 조회
   ─────────────────────────────────────────────────────────
   api/_data/regulation.json(scripts/regulation/build_regulation.py 산출물)을
   읽어 K-REACH 결과를 두 가지로 보강한다.

   1) supplementHazard(): K-REACH API는 고시가 시행일에 도달해야 반영되고,
      일부 물질은 레코드가 없거나 종전 기준이 남아 있다. API에 없는 구분이나
      API보다 낮은(엄격한) 고시 기준을 regulations[]에 fromNotice로 추가한다.
      아직 시행 전인 고시에서 온 기준은 pendingFrom(시행일)을 달아 현재 판정에서
      제외하고 "시행 예정"으로만 보여준다.

   2) computeGrace(): 최신 유예 고시의 고정 부칙 기한을 반환한다. 경과 여부는 판정하지 않는다.
      유예는 해당 고시로 새로 규제 범위에 들어온 함량에만 적용된다
      (종전 최저함량 prevMin 미만. prevMin이 없으면 신규 지정이므로 모든 함량).

   기존/신규화학물질 판정(korexst)은 건드리지 않는다.
   ============================================================ */

const DB = require('../_data/regulation.json');

const CATEGORY_LABEL = { 급성: '인체급성유해성', 만성: '인체만성유해성', 생태: '생태유해성' };

/** 한국 시간 기준 오늘(YYYY-MM-DD) */
function todayKst(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function daysBetween(fromYmd, toYmd) {
  return Math.round((Date.parse(toYmd) - Date.parse(fromYmd)) / 86400000);
}

function entriesFor(cas) {
  return (DB.cas[cas] || []).map((k) => ({ key: k, ...DB.entries[k] }));
}

function casAlias(cas) {
  return DB.casAlias[cas] || null;
}

/**
 * 오늘 시행 중인 기준과 시행 예정 기준을 구분별로 나눈다.
 * history = {목록 고시번호: {구분: %}} — 시행일이 지난 마지막 목록이 현재 적용 기준.
 * 반환: {구분: {active: %|null, pending: %|null, pendingFrom: 'YYYY-MM-DD'|null}}
 */
function splitByEffective(entry, today) {
  const lists = DB.historyLists.filter((id) => entry.history && entry.history[id]);
  const effective = lists.filter((id) => DB.notices[id].effectiveDate <= today);
  const future = lists.filter((id) => DB.notices[id].effectiveDate > today);
  // 이력이 없는 항목(구 PDF 시대 이후 변동 없음 등)은 현재 기준이 곧 시행 기준
  const active = lists.length ? (effective.length ? entry.history[effective[effective.length - 1]] : {}) : entry.hazard;
  const out = {};
  Object.entries(entry.hazard || {}).forEach(([cat, cur]) => {
    const a = active[cat] != null ? active[cat] : null;
    const isPending = future.length && (a == null || cur < a);
    out[cat] = {
      active: a,
      pending: isPending ? cur : null,
      pendingFrom: isPending ? DB.notices[future[0]].effectiveDate : null,
    };
  });
  return out;
}

function noticeLabel(entry) {
  const last = latestTarget(entry);
  const id = last ? last.notice : DB.meta.currentList;
  const n = DB.notices[id];
  return `${n.agency}고시 제${id}호`;
}

function latestTarget(entry) {
  return (entry.targets || []).reduce((best, t) => {
    if (!best) return t;
    return DB.notices[t.notice].date > DB.notices[best.notice].date ? t : best;
  }, null);
}

/**
 * raw: fetchKreachRaw() 결과(캐시본 — 변경하지 않고 복사본을 반환)
 * K-REACH에 없거나 더 느슨한 구분만 고시 기준으로 추가한다.
 */
function supplementHazard(raw, cas, today = todayKst()) {
  if (!raw || raw.success !== true) return raw;
  const entries = entriesFor(cas);
  if (!entries.length) return raw;

  const apiMin = {};
  (raw.regulations || []).forEach((r) => {
    if (r.type !== '인체등유해성물질' || !Number.isFinite(r.thresholdValue)) return;
    if (apiMin[r.hazardCategory] == null || r.thresholdValue < apiMin[r.hazardCategory]) {
      apiMin[r.hazardCategory] = r.thresholdValue;
    }
  });

  const added = [];
  const push = (e, category, threshold, pending) => {
    if (threshold == null) return;
    if (apiMin[category] != null && apiMin[category] <= threshold) return;
    added.push({
      type: '인체등유해성물질',
      hazardCategory: category,
      thresholdValue: threshold,
      operator: '>=',
      criterion: `≥${threshold}%`,
      uniqueNo: e.uid + (e.sub != null ? `(${e.sub})` : ''),
      fromNotice: true,
      pendingFrom: pending,
      sources: [{
        itemName: e.name,
        subType: `인체등유해성물질 — 고시 기준(K-REACH API 미반영)${pending ? ` · ${pending} 시행 예정` : ''}`,
        uniqueNo: e.uid + (e.sub != null ? `(${e.sub})` : ''),
        contInfo: `${CATEGORY_LABEL[category]} : ${threshold}%`,
        excpInfo: apiMin[category] != null ? `K-REACH API 기준 ${apiMin[category]}% → 고시 기준 ${threshold}% 적용` : '',
        ancmntYmd: '',
        ancmntInfo: `${noticeLabel(e)} 별표(현재 목록: 제${DB.meta.currentList}호, K-REACH 목록 ${DB.meta.kreachSnapshot})`,
      }],
    });
  };
  entries.forEach((e) => {
    Object.entries(splitByEffective(e, today)).forEach(([category, s]) => {
      push(e, category, s.active, null);
      if (s.pending != null && (s.active == null || s.pending < s.active)) push(e, category, s.pending, s.pendingFrom);
    });
  });
  if (!added.length) return raw;

  // 같은 구분·시행상태는 가장 낮은 기준 하나만 남긴다(복수 고유번호 연결 시)
  const byCat = new Map();
  added.forEach((r) => {
    const key = `${r.hazardCategory}|${r.pendingFrom || ''}`;
    const cur = byCat.get(key);
    if (!cur || r.thresholdValue < cur.thresholdValue) byCat.set(key, r);
  });
  // 시행 중 기준이 같거나 더 엄격하면 시행 예정 기준은 의미가 없다
  byCat.forEach((r, key) => {
    if (!r.pendingFrom) return;
    const act = byCat.get(`${r.hazardCategory}|`);
    if (act && act.thresholdValue <= r.thresholdValue) byCat.delete(key);
  });
  const supplemented = Array.from(byCat.values());
  const replaced = new Set(supplemented.filter((r) => apiMin[r.hazardCategory] != null && !r.pendingFrom).map((r) => r.hazardCategory));

  return {
    ...raw,
    chemicalName: raw.chemicalName || supplemented[0].sources[0].itemName,
    regulations: (raw.regulations || [])
      // 시행 중인 고시 기준이 더 엄격하면 API의 종전 기준은 대체한다
      .filter((r) => !(r.type === '인체등유해성물질' && replaced.has(r.hazardCategory)))
      .concat(supplemented),
  };
}

function exceeds(content, threshold, isLt) {
  if (content == null) return false;
  return isLt ? content > threshold : content >= threshold;
}

/** 새로 규제 범위에 들어온 함량인가(종전 기준 미만) */
function belowPrevious(content, prevMin, isLt) {
  if (prevMin == null) return true;
  return isLt ? content <= prevMin : content < prevMin;
}

/**
 * 해당 CAS·함량에 적용되는 최신 유예 고시와 남은 기한.
 * 함량을 모르면 판단하지 않는다(null).
 */
function computeGrace(cas, contentMax, isLt, today = todayKst()) {
  if (contentMax == null) return null;
  const candidates = [];
  entriesFor(cas).forEach((e) => {
    const thresholds = Object.values(e.hazard || {});
    if (!thresholds.length || !thresholds.some((t) => exceeds(contentMax, t, isLt))) return;
    const t = latestTarget(e);
    if (!t || !belowPrevious(contentMax, t.prevMin, isLt)) return;
    candidates.push({ entry: e, target: t });
  });
  if (!candidates.length) return null;

  const { entry, target } = candidates.reduce((a, b) =>
    (DB.notices[b.target.notice].date > DB.notices[a.target.notice].date ? b : a));
  const notice = DB.notices[target.notice];

  const special = (notice.specials || []).find((s) => {
    if (s.uid !== entry.uid) return false;
    if (s.contentMin != null && !exceeds(contentMax, s.contentMin, isLt)) return false;
    if (s.contentBelow != null && !belowPrevious(contentMax, s.contentBelow, isLt)) return false;
    return true;
  }) || null;
  const deadlines = (special || notice).deadlines;

  const items = Object.entries(DB.articles).map(([article, task]) => {
    const due = deadlines[article];
    return { article: `제${article}조`, task, due, dueRule: notice.dueRule };
  });
  const remaining = items.sort((a, b) => a.due.localeCompare(b.due));
  if (!remaining.length) return null;

  return {
    notice: target.notice,
    noticeLabel: `${notice.agency}고시 제${target.notice}호(${notice.date})`,
    changeKind: target.kind,
    prevMin: target.prevMin,
    uniqueNo: entry.uid + (entry.sub != null ? `(${entry.sub})` : ''),
    effective: special ? special.effectiveDate : notice.effectiveDate,
    effectiveText: notice.effective,
    holder: special ? special.holder : notice.holder,
    special: special ? { label: special.label, note: special.note } : null,
    items: remaining,
    basis: '고시 부칙상 경과조치이며 개별 사업장 적용 여부는 취급 개시 시점 등에 따라 확인 필요',
  };
}

/** kreach 응답 최종 보강: 고시 기준 보완 + 유예기한 */
function enrichKreach(raw, cas, contentMax, isLt, applyContentJudgment, today = todayKst()) {
  const supplemented = supplementHazard(raw, cas, today);
  const judged = applyContentJudgment(supplemented, contentMax, isLt);
  if (!judged || judged.success !== true) return judged;
  const regulations = (judged.regulations || []).map((r) => (r.pendingFrom
    // 시행 전 기준은 현재 판정(구매판정·확인서)에서 제외하고 별도 표시만 한다
    ? { ...r, matchedPending: r.matchedByContent, matchedByContent: false }
    : r));
  return {
    ...judged,
    regulations,
    grace: computeGrace(cas, contentMax, isLt, today),
    regulationDb: { currentList: DB.meta.currentList, kreachSnapshot: DB.meta.kreachSnapshot, builtAt: DB.meta.builtAt },
  };
}

module.exports = { DB, todayKst, entriesFor, casAlias, supplementHazard, computeGrace, enrichKreach };
