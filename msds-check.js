/* ============================================================
   msds-check.js — MSDS 업로드 정합성 검사 (브라우저 내 처리)

   [처리 흐름]
   1. 파일 읽기
      - PDF : pdf.js로 텍스트 레이어 추출. 글자가 거의 없거나 깨진
              페이지(스캔본)는 캔버스로 렌더링해 Tesseract OCR로 대체
      - JPG/PNG : Tesseract OCR (kor+eng)
      → 모든 페이지를 동일한 "줄(line) / 조각(segment)" 구조로 정규화
        (좌표는 페이지 크기 대비 0~1 비율 — PDF·OCR 공통)
   2. 검사 (모두 순수함수 — Node에서도 테스트 가능)
      ① MSDS 제출번호(AA…) — 첫 페이지 또는 마지막 페이지
      ② 개정일자 — 첫/마지막 페이지 우선, 없으면 전체
      ③ 3번 구성성분 표 — CAS(체크디지트 검증)·물질명·함유량 파싱
      ④ 15번 법적 규제현황 — 법령/규제항목 키워드, 해당없음 구분,
         성분(CAS)별 귀속 → 3번 표 보조정보로 표시
   3. 결과 렌더링 + "직접입력 시트로 보내기"

   파일은 서버로 전송되지 않는다. 라이브러리·OCR 언어데이터도
   /vendor 아래에 자체 호스팅한다(외부 CDN 미사용).
   ============================================================ */
(function (root) {
  'use strict';

  /* ═══════════════════════════════════════════════════════════
     1. 공통 유틸
     ═══════════════════════════════════════════════════════════ */
  const compact = (s) => String(s == null ? '' : s).replace(/\s+/g, '');

  /** 전각·유사 기호를 표준 기호로 통일 */
  function normalizeSymbols(s) {
    return String(s == null ? '' : s)
      .replace(/[～∼〜~]/g, '~')
      .replace(/[–—‐‑−]/g, '-')
      .replace(/＜/g, '<').replace(/＞/g, '>')
      .replace(/≦/g, '≤').replace(/≧/g, '≥')
      .replace(/<=/g, '≤').replace(/>=/g, '≥')
      .replace(/=</g, '≤').replace(/=>/g, '≥')
      .replace(/％/g, '%')
      .replace(/，/g, ',')
      .replace(/：/g, ':');
  }

  /* ═══════════════════════════════════════════════════════════
     2. CAS 번호
     ═══════════════════════════════════════════════════════════ */
  // OCR이 하이픈 주변에 공백을 넣는 경우까지 허용
  const CAS_RE = /(^|[^\d])(\d{2,7})\s*-\s*(\d{2})\s*-\s*(\d)(?!\d)/g;

  function casChecksumOk(cas) {
    const m = /^(\d{2,7})-(\d{2})-(\d)$/.exec(cas);
    if (!m) return false;
    const digits = (m[1] + m[2]).split('').reverse();
    const sum = digits.reduce((s, d, i) => s + Number(d) * (i + 1), 0);
    return sum % 10 === Number(m[3]);
  }

  /** 문자열에서 CAS 후보를 모두 찾는다 → [{cas, index, end, valid}] */
  function findCas(text) {
    const src = normalizeSymbols(text);
    const out = [];
    CAS_RE.lastIndex = 0;
    let m;
    while ((m = CAS_RE.exec(src))) {
      const cas = `${m[2]}-${m[3]}-${m[4]}`;
      const index = m.index + m[1].length;
      out.push({ cas, index, end: CAS_RE.lastIndex, valid: casChecksumOk(cas) });
    }
    return out;
  }

  /* ═══════════════════════════════════════════════════════════
     3. 줄(line) 구성 — PDF 텍스트 아이템 / OCR 단어 공통
     ─────────────────────────────────────────────────────────
     입력 item: { str, x0, x1, y, h }  (모두 0~1 정규화, y는 위→아래, 중심선)
     출력 line: { page, y, h, text, segs:[{text,x0,x1}] }
       - text : 아이템 간격을 공백으로 반영한 한 줄 텍스트
       - segs : 큰 간격(표 열 간격)으로 나눈 조각 — 표 열 판별에 사용
     ═══════════════════════════════════════════════════════════ */
  function buildLines(items, pageNo, aspect) {
    // aspect = 페이지 높이/너비 — x(너비 비율)와 h(높이 비율)를 같은 단위로 비교하기 위함
    const ar = aspect || 1.414;
    const sorted = items
      .filter((it) => it && String(it.str || '').trim())
      .slice()
      .sort((a, b) => a.y - b.y || a.x0 - b.x0);

    const rows = [];
    sorted.forEach((it) => {
      const h = it.h || 0.01;
      let target = null;
      for (let i = rows.length - 1; i >= 0 && i >= rows.length - 4; i--) {
        const r = rows[i];
        if (Math.abs(r.y - it.y) <= Math.max(r.h, h) * 0.55) { target = r; break; }
      }
      if (!target) {
        target = { y: it.y, h, items: [] };
        rows.push(target);
      }
      target.items.push(it);
      // 줄의 대표 y/높이는 아이템 평균으로 갱신
      const n = target.items.length;
      target.y = (target.y * (n - 1) + it.y) / n;
      target.h = Math.max(target.h, h);
    });

    return rows.map((r) => {
      const its = r.items.slice().sort((a, b) => a.x0 - b.x0);
      const fontW = (r.h * ar); // 글자 높이를 너비 비율로 환산
      let text = '';
      const segs = [];
      let seg = null;
      let prev = null;
      its.forEach((it) => {
        const s = String(it.str);
        const gap = prev ? it.x0 - prev.x1 : 0;
        if (!prev) {
          text = s;
        } else {
          const needSpace = gap > fontW * 0.18 && !/\s$/.test(text) && !/^\s/.test(s);
          text += (needSpace ? ' ' : '') + s;
        }
        if (!seg || gap > fontW * 1.1) {
          seg = { text: s, x0: it.x0, x1: it.x1 };
          segs.push(seg);
        } else {
          const needSpace = gap > fontW * 0.18 && !/\s$/.test(seg.text) && !/^\s/.test(s);
          seg.text += (needSpace ? ' ' : '') + s;
          seg.x1 = Math.max(seg.x1, it.x1);
        }
        prev = it;
      });
      segs.forEach((sg) => { sg.text = sg.text.replace(/\s+/g, ' ').trim(); });
      return {
        page: pageNo,
        y: r.y,
        h: r.h,
        text: text.replace(/\s+/g, ' ').trim(),
        segs: segs.filter((sg) => sg.text),
      };
    }).filter((l) => l.text);
  }

  /** 추출된 텍스트가 실질적인 글자인지(폰트 매핑 깨짐/스캔본 판별) */
  function textLooksUsable(text) {
    const t = compact(text);
    if (t.length < 25) return false;
    const good = (t.match(/[가-힣A-Za-z0-9.,:;()\-%~<>/]/g) || []).length;
    return good / t.length >= 0.6;
  }

  /* ═══════════════════════════════════════════════════════════
     4. 16개 항목(섹션) 위치 찾기 — 국문 / 영문(SECTION n) / 중문(第N部分)
     ═══════════════════════════════════════════════════════════ */
  const SECTION_DEFS = [
    { no: 1,  title: '화학제품과 회사에 관한 정보', kw: ['화학제품', '회사에관한', '제품및회사', '제품명및회사', 'identification', '化学品及企业', '标识'] },
    { no: 2,  title: '유해성·위험성', kw: ['유해성', '위험성', 'hazard', '危险性'] },
    { no: 3,  title: '구성성분의 명칭 및 함유량', kw: ['구성성분', '명칭및함유량', '함유량', 'composition', 'ingredient', '成分', '组成'] },
    { no: 4,  title: '응급조치 요령', kw: ['응급조치', 'firstaid', '急救'] },
    { no: 5,  title: '폭발·화재시 대처방법', kw: ['폭발', '화재', 'firefighting', 'fire-fighting', 'fire', '消防'] },
    { no: 6,  title: '누출 사고시 대처방법', kw: ['누출', 'accidental', 'release', '泄漏'] },
    { no: 7,  title: '취급 및 저장방법', kw: ['취급', '저장', 'handling', 'storage', '操作', '储存'] },
    { no: 8,  title: '노출방지 및 개인보호구', kw: ['노출방지', '개인보호구', 'exposure', 'personalprotection', '接触控制', '个体防护'] },
    { no: 9,  title: '물리화학적 특성', kw: ['물리화학', '물리적', 'physical', '理化'] },
    { no: 10, title: '안정성 및 반응성', kw: ['안정성', '반응성', 'stability', 'reactivity', '稳定性'] },
    { no: 11, title: '독성에 관한 정보', kw: ['독성', 'toxicolog', '毒理'] },
    { no: 12, title: '환경에 미치는 영향', kw: ['환경에', '환경영향', 'ecolog', '生态'] },
    { no: 13, title: '폐기시 주의사항', kw: ['폐기', 'disposal', '废弃'] },
    { no: 14, title: '운송에 필요한 정보', kw: ['운송', 'transport', '运输'] },
    { no: 15, title: '법적 규제현황', kw: ['법적규제', '법적', '규제현황', 'regulatory', '法规'] },
    { no: 16, title: '그 밖의 참고사항', kw: ['그밖의', '그밖', '기타참고', '참고사항', 'otherinformation', 'other', '其他信息', '其他'] },
  ];

  // "3.", "3)", "제3항", "SECTION 3:", "Section 3 -" 등
  const HEADING_RE = /^(?:section|sec\.|섹션|항목)?(?:제)?(\d{1,2})(?:번|항)?(?![.,]\d)[.)．:\]\-]?(.*)$/;
  const ZH_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  function zhToNumber(s) {
    if (s.length === 1) return ZH_NUM[s] || null;
    if (s[0] === '十') return 10 + (ZH_NUM[s[1]] || 0);
    if (s.length === 2 && s[1] === '十') return (ZH_NUM[s[0]] || 0) * 10;
    if (s.length === 3 && s[1] === '十') return (ZH_NUM[s[0]] || 0) * 10 + (ZH_NUM[s[2]] || 0);
    return null;
  }

  /** 줄 하나를 섹션 제목으로 해석 → { no } 또는 null */
  function parseHeading(text) {
    const c = compact(normalizeSymbols(text)).toLowerCase();
    if (c.length > 140) return null;
    let no = null;
    let rest = '';
    const zh = /^第([一二三四五六七八九十]{1,3})部分(.*)$/.exec(c);
    if (zh) {
      no = zhToNumber(zh[1]);
      rest = zh[2];
    } else {
      const m = HEADING_RE.exec(c);
      if (!m) return null;
      no = Number(m[1]);
      rest = m[2];
    }
    const def = SECTION_DEFS.find((d) => d.no === no);
    if (!def) return null;
    rest = rest.replace(/^[.:\-\s]+/, '').slice(0, 45);
    if (!rest || !def.kw.some((k) => rest.includes(k))) return null;
    return { no };
  }

  /**
   * 각 줄을 섹션 제목 후보로 판정하고, 번호가 증가하는 가장 긴 수열(LIS)을
   * 골라 확정한다 — 본문 속 "2) 유해성 정보" 같은 하위 번호, 목차 반복과 구분하기 위함.
   * 반환: { [no]: lineIndex }
   */
  function findSections(lines) {
    const cands = [];
    lines.forEach((ln, idx) => {
      const h = parseHeading(ln.text);
      if (h) cands.push({ no: h.no, idx });
    });

    // 번호·위치가 모두 증가하는 최장 부분수열 (같은 길이면 앞쪽 후보 우선)
    const n = cands.length;
    const best = new Array(n).fill(1);
    const prev = new Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < i; j++) {
        if (cands[j].no < cands[i].no && best[j] + 1 > best[i]) {
          best[i] = best[j] + 1;
          prev[i] = j;
        }
      }
    }
    let end = -1;
    for (let i = 0; i < n; i++) if (end < 0 || best[i] > best[end]) end = i;
    const out = {};
    for (let i = end; i >= 0; i = prev[i]) out[cands[i].no] = cands[i].idx;
    return out;
  }

  /** 섹션 no의 본문 줄 범위 [start, end) — 다음으로 발견된 섹션 제목 전까지 */
  function sectionRange(sections, no, totalLines) {
    if (sections[no] == null) return null;
    const start = sections[no] + 1;
    let end = totalLines;
    Object.keys(sections).forEach((k) => {
      const idx = sections[k];
      if (Number(k) > no && idx >= start && idx < end) end = idx;
    });
    return [start, end];
  }

  /* ═══════════════════════════════════════════════════════════
     5. ① MSDS 제출번호 (AA…)
     ═══════════════════════════════════════════════════════════ */
  // 예: AA12345-1234567890 — OCR이 0을 O로 읽는 경우를 허용한 뒤 보정
  const SUBMIT_RE = /AA[0-9O]{5,}(?:-[0-9O]{2,})*/g;
  const SUBMIT_LABEL_RE = /(제출번호|msds번호|물질안전보건자료번호|submissionno)/i;

  function checkSubmissionNo(pages) {
    const total = pages.length;
    const found = [];
    const labelPages = new Set();
    pages.forEach((p) => {
      p.lines.forEach((ln) => {
        const c = compact(normalizeSymbols(ln.text)).toUpperCase();
        if (SUBMIT_LABEL_RE.test(c.toLowerCase())) labelPages.add(p.pageNo);
        SUBMIT_RE.lastIndex = 0;
        let m;
        let strictHit = false;
        while ((m = SUBMIT_RE.exec(c))) {
          strictHit = true;
          const value = 'AA' + m[0].slice(2).replace(/O/g, '0');
          if (!found.some((f) => f.value === value && f.page === p.pageNo)) {
            found.push({ value, page: p.pageNo, line: ln.text });
          }
        }
        // OCR이 "AA"를 "44"/"A4" 등으로 읽는 경우 — 제출번호 라벨 바로 뒤에 있을 때만 보정
        const lm = !strictHit && SUBMIT_LABEL_RE.exec(c.toLowerCase());
        if (lm) {
          const after = c.slice(lm.index + lm[0].length).replace(/^[:\s]*/, '');
          const om = /^([A4][A4])([0-9O]{5,}(?:-[0-9O]{2,})*)/.exec(after);
          // 앞 두 글자가 아예 깨진 경우(예: "&\01234-…") — 번호 형식은 맞으므로 '불확실'로 표시
          const um = !om && /^([^0-9]{1,3})([0-9O]{5}(?:-[0-9O]{6,}))/.exec(after);
          const hit = om || um;
          if (hit) {
            const value = 'AA' + hit[2].replace(/O/g, '0');
            if (!found.some((f) => f.value === value && f.page === p.pageNo)) {
              found.push({ value, page: p.pageNo, line: ln.text, corrected: om ? (om[1] !== 'AA') : 'uncertain', rawPrefix: hit[1] });
            }
          }
        }
      });
    });

    const edgePages = new Set([1, total]);
    const onEdge = found.filter((f) => edgePages.has(f.page));
    if (onEdge.length && onEdge[0].corrected === 'uncertain') {
      return {
        status: 'warn',
        value: onEdge[0].value,
        page: onEdge[0].page,
        all: found,
        corrected: 'uncertain',
        message: `제출번호 앞부분이 "${onEdge[0].rawPrefix}"로 판독됨 — AA 여부를 원본에서 확인 (${onEdge[0].page}페이지)`,
      };
    }
    if (onEdge.length) {
      return {
        status: 'ok',
        value: onEdge[0].value,
        page: onEdge[0].page,
        all: found,
        corrected: !!onEdge[0].corrected,
        message: `제출번호 ${onEdge[0].value} (${onEdge[0].page}페이지)` +
          (onEdge[0].corrected ? ' — OCR 판독값을 AA로 보정, 원본 확인 필요' : ''),
      };
    }
    if (found.length) {
      return {
        status: 'error',
        value: found[0].value,
        page: found[0].page,
        all: found,
        message: `제출번호가 첫·마지막 페이지가 아닌 ${found[0].page}페이지에서만 확인됨 — 재검토 필요`,
      };
    }
    return {
      status: 'error',
      value: null,
      page: null,
      all: [],
      message: labelPages.size
        ? '제출번호 항목은 있으나 AA로 시작하는 번호가 없음 — 재검토 필요'
        : 'AA로 시작하는 MSDS 제출번호가 없음 — 재검토 필요',
    };
  }

  /* ═══════════════════════════════════════════════════════════
     6. ② 개정일자
     ─────────────────────────────────────────────────────────
     지원 형식: 2024.08.20 / 2024-8-20 / 2024년 8월 20일 / 2017/6/1
               15.01.2025(일.월.년) / 10/23/2025(월/일/년, 미국식)
               Jan 1st, 2025 / 1 January 2025 / 15-Jan-2025
     ═══════════════════════════════════════════════════════════ */
  const DATE_YMD_RE = /((?:19|20)\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})(?!\d)\s*일?/g;
  const DATE_XXY_RE = /(?<![\d.])(\d{1,2})\s*([.\-/])\s*(\d{1,2})\s*[.\-/]\s*((?:19|20)\d{2})(?!\d)/g;
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const DATE_MDY_NAME_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((?:19|20)\d{2})/gi;
  const DATE_DMY_NAME_RE = /\b(\d{1,2})(?:st|nd|rd|th)?[\s\-.]+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?[\s\-.,]+((?:19|20)\d{2})/gi;

  const REVISION_LABEL_RE = /(최종개정일자|최종개정일|개정일자|개정일|개정년월일|개정날짜|revisiondate|reviseddate|daterevised|rev\.?date|dateofrevision|dateoflastrevision|lastrevised|revisedon|revision:|safetydatasheetdated|sdsdated|versiondate|修订日期|修订日|修改日期|überarbeitetam|überarbeitungsdatum)/i;
  const CREATED_LABEL_RE = /(최초작성일자|최초작성일|작성일자|작성일|발행일자|발행일|issuedate|dateofissue|issuingdate|dateoffirstedition|dateofpreparation|preparationdate|编制日期|填表时间)/i;

  function isoDate(y, mo, d) {
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  function extractDates(text) {
    const src = normalizeSymbols(text);
    const out = [];
    const push = (index, iso, raw, ambiguous) => {
      if (iso && !out.some((o) => o.index === index)) out.push({ index, iso, raw: raw.trim(), ambiguous: !!ambiguous });
    };
    let m;
    DATE_YMD_RE.lastIndex = 0;
    while ((m = DATE_YMD_RE.exec(src))) push(m.index, isoDate(+m[1], +m[2], +m[3]), m[0]);
    DATE_XXY_RE.lastIndex = 0;
    while ((m = DATE_XXY_RE.exec(src))) {
      const a = +m[1], b = +m[3], y = +m[4];
      // 슬래시는 미국식(월/일/년), 점·하이픈은 유럽식(일.월.년)을 기본으로 하되
      // 한쪽이 12를 넘으면 그쪽을 '일'로 확정한다
      let mo, d, ambiguous = false;
      if (a > 12) { d = a; mo = b; }
      else if (b > 12) { mo = a; d = b; }
      else if (m[2] === '/') { mo = a; d = b; ambiguous = a !== b; }
      else { d = a; mo = b; ambiguous = a !== b && m[2] === '-'; }
      push(m.index, isoDate(y, mo, d), m[0], ambiguous);
    }
    DATE_MDY_NAME_RE.lastIndex = 0;
    while ((m = DATE_MDY_NAME_RE.exec(src))) push(m.index, isoDate(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]), m[0]);
    DATE_DMY_NAME_RE.lastIndex = 0;
    while ((m = DATE_DMY_NAME_RE.exec(src))) push(m.index, isoDate(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]), m[0]);
    return out.sort((x, y) => x.index - y.index);
  }

  /** 라벨이 있는 줄의 라벨 뒤 → 같은 페이지 다음 2줄 순으로 날짜를 찾는다 */
  function findLabeledDate(pages, labelRe, pageOrder) {
    for (const pi of pageOrder) {
      const p = pages[pi];
      if (!p) continue;
      for (let i = 0; i < p.lines.length; i++) {
        const ln = p.lines[i];
        // 같은 줄에 여러 칸(예: "Printing date: … Date of issue: …")이 있으면 라벨이 있는 조각부터 본다
        const parts = ln.segs && ln.segs.length > 1 ? ln.segs.map((s) => s.text).concat([ln.text]) : [ln.text];
        for (const part of parts) {
          const norm = normalizeSymbols(part);
          const c = compact(norm).toLowerCase();
          const lm = labelRe.exec(c);
          if (!lm) continue;
          const dates = extractDates(norm);
          const labelCharPos = approxOriginalIndex(norm, lm.index + lm[0].length);
          const after = dates.filter((d) => d.index >= labelCharPos);
          const pick = after[0] || (part === ln.text ? null : dates[0]);
          if (pick) return { ...pick, page: p.pageNo, line: ln.text };
        }
        if (!labelRe.test(compact(normalizeSymbols(ln.text)).toLowerCase())) continue;
        // 라벨 줄에 날짜가 없으면: 바로 위(중문 양식은 라벨 위에 값) → 아래 2줄
        for (const k of [1, 2, -1]) {
          const other = p.lines[i + k];
          if (!other) continue;
          const nd = extractDates(other.text);
          if (nd.length) return { ...nd[0], page: p.pageNo, line: ln.text + ' / ' + other.text };
        }
      }
    }
    return null;
  }

  /** 공백 제거 문자열의 인덱스 → 원문 인덱스 근사 변환 */
  function approxOriginalIndex(original, compactIdx) {
    let count = 0;
    for (let i = 0; i < original.length; i++) {
      if (!/\s/.test(original[i])) {
        if (count === compactIdx) return i;
        count++;
      }
    }
    return original.length;
  }

  function checkRevisionDate(pages) {
    const total = pages.length;
    const edge = total > 1 ? [total - 1, 0] : [0];
    const middle = pages.map((_, i) => i).filter((i) => !edge.includes(i));
    const order = edge.concat(middle);

    const revision = findLabeledDate(pages, REVISION_LABEL_RE, order);
    const created = findLabeledDate(pages, CREATED_LABEL_RE, order);

    if (revision) {
      const edgeHit = revision.page === 1 || revision.page === total;
      return {
        status: 'ok',
        value: revision.iso,
        raw: revision.raw,
        ambiguous: revision.ambiguous,
        page: revision.page,
        created: created ? created.iso : null,
        message: `개정일자 ${revision.iso} (${revision.page}페이지${edgeHit ? '' : ' — 첫·마지막 페이지 외'})` +
          (revision.ambiguous ? ` — 원문 "${revision.raw}" 일/월 순서 확인 필요` : ''),
      };
    }
    return {
      status: 'warn',
      value: null,
      fallbackValue: created ? created.iso : null,
      page: created ? created.page : null,
      created: created ? created.iso : null,
      message: created
        ? `개정일자 표기를 찾지 못함 (작성·발행일자 ${created.iso}만 확인됨)`
        : '개정일자를 찾지 못함 — 원문 확인 필요',
    };
  }

  /* ═══════════════════════════════════════════════════════════
     7. ③ 3번 구성성분
     ─────────────────────────────────────────────────────────
     두 가지 배치를 모두 처리한다.
       - 표(열) 배치 : 머리글(물질명/CAS/함유량…)로 열 위치를 잡고, CAS가 있는
                       줄을 한 행으로 본다. 열 순서는 양식마다 다르다(함유량이
                       CAS 왼쪽에 오는 경우 포함).
       - 블록(라벨) 배치 : "Substance name: … / CAS No.: … / Concentration: …"
                       처럼 성분마다 여러 줄로 기재 — CAS 줄 주변에서 라벨로 찾는다.
     EC·Index·REACH 등록번호, H코드 등 숫자는 함유량으로 오인하지 않도록 제거한다.
     ═══════════════════════════════════════════════════════════ */
  const SECRET_RE = /(영업비밀|비공개|tradesecret|confidential|proprietary|withheld|商业秘密)/i;
  const NUM = '(\\d+(?:[.,]\\d+)?)';
  const num = (s) => Number(String(s).replace(',', '.'));

  /** 함유량으로 오인되는 식별번호·코드 제거 */
  function stripNonContentNumbers(text) {
    return normalizeSymbols(text)
      .replace(/\b01-\d{10}-\d{2}(-[\dA-Za-z]{4})?/g, ' ')         // REACH 등록번호
      .replace(/\b\d{3}-\d{3}-\d{2}-[\dX]\b/gi, ' ')                // EU Index No.
      .replace(/\b\d{3}-\d{3}-\d\b/g, ' ')                          // EC / EINECS No.
      .replace(/(^|[^\d])\d{2,7}\s*-\s*\d{2}\s*-\s*\d(?!\d)/g, '$1 ') // CAS
      .replace(/\b[HP]\d{3}[A-Za-z]*\b/g, ' ')                      // H/P 코드
      .replace(/\b(cat(egory)?|tox|liq|sol|gas|irrit|sens|carc|muta|repr|stot\s*(se|re)?|asp|aquatic\s*(acute|chronic)?|eye\s*dam|skin\s*corr)\.?\s*\d[A-C]?\b/gi, ' ')
      .replace(/(구분|카테고리)\s*\d[A-C]?/g, ' ');
  }

  /**
   * 함유량 문자열 → { min, max, isLt, raw }
   * isLt=true : 최대값 미포함(미만) — 기존 직접입력 시트의 "미만" 체크와 동일 의미
   * strict=true : %, 범위 기호 등 함유량다운 표식이 있을 때만 인정(열·라벨 근거가 없을 때)
   */
  function parseContent(raw, strict) {
    const s = stripNonContentNumbers(raw)
      .replace(/(wt|w\/w|g\/g|v\/v|mass|vol|weight)\s*%|%\s*(w\/w|wt|g\/g|v\/v)|%/gi, ' % ')
      .replace(/\s+/g, ' ').trim();
    if (!s || !/\d/.test(s)) return null;
    if (strict && !/(%|~|≤|≥|<|>|±|이상|미만|이하|초과|\d\s*-\s*\d)/.test(s)) return null;
    const out = (min, max, isLt) => ({ min: min == null ? null : round(min), max: max == null ? null : round(max), isLt: !!isLt, raw: s });
    let m;
    // 30 ± 5
    if ((m = new RegExp(NUM + '\\s*%?\\s*±\\s*' + NUM).exec(s))) return out(num(m[1]) - num(m[2]), num(m[1]) + num(m[2]), false);
    // 1 ≤ x < 5 / 5 이상 10 미만
    if ((m = new RegExp(NUM + '\\s*%?\\s*(?:≤|<|이상|초과)\\s*(?:[a-zA-Z가-힣]{1,3}\\s*)?(<|≤|미만|이하)?\\s*' + NUM + '\\s*%?\\s*(미만|이하)?').exec(s)) && (m[2] || m[4])) {
      return out(num(m[1]), num(m[3]), m[2] === '<' || m[2] === '미만' || m[4] === '미만');
    }
    // ≥1 - <2.5 / >= 99 - <= 100 / 10 ~ 20 (미만) / 10 to 20
    if ((m = new RegExp('(?:≥|>)?\\s*' + NUM + '\\s*%?\\s*(?:~|-|to|–)\\s*(<|≤)?\\s*' + NUM + '\\s*%?\\s*(미만|이하)?', 'i').exec(s))) {
      let a = num(m[1]), b = num(m[3]);
      if (a > b) [a, b] = [b, a];
      return out(a, b, m[2] === '<' || m[4] === '미만');
    }
    // < 1 / 1 미만
    if ((m = new RegExp('<\\s*' + NUM).exec(s)) || (m = new RegExp(NUM + '\\s*%?\\s*미만').exec(s))) return out(null, num(m[1]), true);
    // ≤ 5 / 5 이하
    if ((m = new RegExp('≤\\s*' + NUM).exec(s)) || (m = new RegExp(NUM + '\\s*%?\\s*이하').exec(s))) return out(null, num(m[1]), false);
    // > 99 / ≥ 99 / 99 이상
    if ((m = new RegExp('(?:>|≥)\\s*' + NUM).exec(s)) || (m = new RegExp(NUM + '\\s*%?\\s*(?:이상|초과)').exec(s))) return out(num(m[1]), 100, false);
    // 단일 값 (strict 모드에서는 % 표기 필수)
    if ((m = new RegExp('(?:^|\\s)' + NUM + '\\s*%').exec(s)) || (!strict && (m = new RegExp('(?:^|\\s)' + NUM + '(?:\\s|$)').exec(s)))) {
      const v = num(m[1]);
      return v <= 100 ? out(v, v, false) : null;
    }
    return null;
  }

  function round(v) { return Math.round(v * 1000) / 1000; }

  const center = (sg) => (sg.x0 + sg.x1) / 2;

  /** 머리글 조각 → 열 종류 */
  function headerType(text) {
    const t = compact(text).toLowerCase();
    if (!t) return null;
    if (/(einecs|elincs|ec(no|번호|#|-no)|^ec$|index)/.test(t)) return 'ec';
    if (/(cas|식별번호|ident)/.test(t)) return 'cas';
    if (/(함유량|함량|농도|content|concentration|conc\.|%|w\/w|wt|weight|qty|quantity|浓度|含量|range)/.test(t)) return 'content';
    if (/(관용명|이명|synonym|commonname|别名)/.test(t)) return 'alias';
    if (/(classification|분류|hazard|h-statement|危险性)/.test(t)) return 'class';
    if (/(물질명|성분명|화학물질|성분|name|chemical|substance|component|ingredient|组分|名称)/.test(t)) return 'name';
    return null;
  }

  /**
   * 첫 데이터(CAS) 행 위쪽에서 머리글 줄을 찾는다.
   * 머리글이 2~3줄로 나뉜 경우(예: "Concentration range in" / "electrolyte (w/w %)")
   * 인접 줄 조각도 합친다. 반환: { headerIdx, cols:[{type,x0,x1}] } 또는 null
   */
  function detectHeader(lines, firstRowIdx) {
    for (let i = firstRowIdx - 1; i >= 0 && i >= firstRowIdx - 8; i--) {
      const ln = lines[i];
      if (findCas(ln.text).length) continue;
      const typed = ln.segs.map((sg) => ({ type: headerType(sg.text), x0: sg.x0, x1: sg.x1 })).filter((c) => c.type);
      const kinds = new Set(typed.map((c) => c.type));
      if (typed.length < 2 || !(kinds.has('cas') || kinds.has('content'))) continue;
      // 위·아래 인접 머리글 조각 보충
      [i - 1, i + 1].forEach((j) => {
        const nl = lines[j];
        if (!nl || j >= firstRowIdx || findCas(nl.text).length) return;
        nl.segs.forEach((sg) => {
          const type = headerType(sg.text);
          if (!type) return;
          const overlap = typed.find((c) => sg.x0 < c.x1 + 0.02 && sg.x1 > c.x0 - 0.02);
          if (overlap) { if (overlap.type === 'name' && type === 'content') overlap.type = 'content'; }
          else typed.push({ type, x0: sg.x0, x1: sg.x1 });
        });
      });
      typed.sort((a, b) => a.x0 - b.x0);
      return { headerIdx: i, cols: typed };
    }
    return null;
  }

  /** 데이터 조각이 속한 열 — 머리글 중심과 가장 가까운 열(가운데/왼쪽 정렬 모두 고려) */
  function columnOf(sg, header) {
    let best = null;
    header.cols.forEach((c) => {
      const inside = sg.x0 >= c.x0 - 0.015 && sg.x0 <= c.x1;
      const d = Math.min(Math.abs(center(sg) - center(c)), Math.abs(sg.x0 - c.x0)) - (inside ? 0.05 : 0);
      if (!best || d < best.d) best = { c, d };
    });
    return best ? best.c : null;
  }

  const CAS_LABEL_RE = /\b(cas\s*(no|number|n°|#|rn)?\.?\s*[:：]?|cas-no\.?\s*[:：]?)/gi;
  const NAME_LABEL_RE = /^(substance\s*name|chemical\s*name|product\s*name|component|ingredient|name|물질명|화학물질명|성분명|화학명|品名|名称)\s*[:：]\s*(.+)$/i;
  const CONTENT_LABEL_RE = /(concentration|contents?|weight\s*%|wt\.?\s*%|함유량|함량|농도|浓度|含量)\s*(\([^)]*\))?\s*[:：]?\s*(.*)$/i;
  const LABEL_LINE_RE = /^[A-Za-z가-힣.()\s/#-]{2,40}[:：]/;

  function cleanName(s) {
    return String(s || '')
      .replace(CAS_LABEL_RE, ' ')
      .replace(/[;,:：]\s*$/, '')
      .replace(/^[\s\-•·*;:]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseComposition(allLines, sections) {
    let range = sectionRange(sections, 3, allLines.length);
    let fallback = false;
    if (!range) {
      // 3번 제목을 못 찾은 경우: 4번(또는 이후 첫 섹션) 이전까지 전체에서 탐색
      fallback = true;
      const stop = [4, 5, 6, 7, 8, 15].map((n) => sections[n]).filter((v) => v != null);
      range = [0, stop.length ? Math.min(...stop) : allLines.length];
    }
    const lines = allLines.slice(range[0], range[1]);

    // 1) 행 기준 줄: 유효 형식 CAS가 있는 줄 (또는 CAS 자리에 "영업비밀")
    const rowIdx = [];
    lines.forEach((ln, i) => {
      if (findCas(ln.text).length) rowIdx.push(i);
    });
    const header = rowIdx.length ? detectHeader(lines, rowIdx[0]) : null;
    const casCol = header && header.cols.find((c) => c.type === 'cas');
    if (header && casCol) {
      lines.forEach((ln, i) => {
        if (i <= header.headerIdx || rowIdx.includes(i)) return;
        const secretSeg = ln.segs.find((sg) => SECRET_RE.test(compact(sg.text)) && columnOf(sg, header) === casCol);
        if (secretSeg) rowIdx.push(i);
      });
      rowIdx.sort((a, b) => a - b);
    }

    // 비고 문장 속 CAS(예: "…added with water [CAS No. 7732-18-5] to 100%")는 성분 행에서 제외
    const isProse = (ln) => (ln.text.match(/[A-Za-z가-힣]+/g) || []).length >= 12;
    if (!header && rowIdx.some((i) => !isProse(lines[i]))) {
      for (let k = rowIdx.length - 1; k >= 0; k--) if (isProse(lines[rowIdx[k]])) rowIdx.splice(k, 1);
    }

    const rows = rowIdx.map((li, k) => {
      const ln = lines[li];
      const casHits = findCas(ln.text);
      const casInfo = casHits[0] || null;
      const casSeg = casInfo
        ? ln.segs.find((sg) => findCas(sg.text).length) || ln.segs[0]
        : ln.segs.find((sg) => SECRET_RE.test(compact(sg.text)));

      let name = '';
      let alias = '';
      const contentParts = [];
      const nameFromCasSeg = () => {
        if (!casSeg) return '';
        const t = normalizeSymbols(casSeg.text);
        const h = findCas(t)[0];
        return cleanName(h ? t.slice(0, h.index) : '');
      };

      if (header) {
        ln.segs.forEach((sg) => {
          if (sg === casSeg) return;
          const col = columnOf(sg, header);
          const type = col ? col.type : null;
          if (type === 'content') contentParts.push({ text: sg.text, labeled: true, x0: col.x0 });
          else if (type === 'alias') alias += (alias ? ' ' : '') + sg.text;
          else if (type === 'name') name += (name ? ' ' : '') + sg.text;
          else if (type !== 'ec' && type !== 'class' && type !== 'cas') contentParts.push({ text: sg.text, labeled: false });
        });
        if (!name) name = nameFromCasSeg();
      } else {
        // 머리글 없음: CAS 조각 앞쪽 텍스트를 이름 후보로, 나머지는 함유량 후보로
        ln.segs.forEach((sg) => {
          if (sg === casSeg) return;
          if (sg.x1 <= (casSeg ? casSeg.x0 : 0) + 0.005 && !parseContent(sg.text, true)) name += (name ? ' ' : '') + sg.text;
          else contentParts.push({ text: sg.text, labeled: false });
        });
        const before = nameFromCasSeg();
        if (before && !LABEL_LINE_RE.test(before + ':')) name = name ? name + ' ' + before : before;
        if (casSeg) {
          const t = normalizeSymbols(casSeg.text);
          const h = findCas(t)[0];
          if (h) contentParts.push({ text: t.slice(h.end), labeled: false });
        }
      }

      // 2) 같은 줄의 함유량 — 함유량 열(왼쪽부터) → 그 밖의 조각(엄격 판정)
      contentParts.sort((a, b) => (b.labeled - a.labeled) || ((a.x0 || 0) - (b.x0 || 0)));
      let content = null;
      let contentRaw = '';
      for (const part of contentParts) {
        const c = parseContent(part.text, !part.labeled);
        if (c) { content = c; contentRaw = part.text; break; }
      }

      // 3) 블록 배치 — 다음 CAS 행 전까지(뒤) → 이전 CAS 행 이후(앞) 줄에서 라벨로 탐색
      const prevRow = k > 0 ? rowIdx[k - 1] : (header ? header.headerIdx : -1);
      const nextRow = k + 1 < rowIdx.length ? rowIdx[k + 1] : lines.length;
      const after = lines.slice(li + 1, nextRow);
      const before = lines.slice(prevRow + 1, li).reverse(); // 가까운 줄부터
      if (!content && !header) {
        for (const nl of after.concat(before)) {
          const m = CONTENT_LABEL_RE.exec(normalizeSymbols(nl.text));
          if (!m) continue;
          const c = parseContent(m[3] || nl.text, false);
          if (c) { content = c; contentRaw = (m[3] || nl.text).trim(); break; }
        }
      }
      name = cleanName(name);
      if (!name && !header) {
        const labeled = before.concat(after).find((nl) => NAME_LABEL_RE.test(normalizeSymbols(nl.text).trim()));
        if (labeled) name = cleanName(NAME_LABEL_RE.exec(normalizeSymbols(labeled.text).trim())[2]);
        else {
          const plain = before.find((nl) => !LABEL_LINE_RE.test(nl.text) && !CONTENT_LABEL_RE.test(nl.text) &&
            /[A-Za-z가-힣一-龥]{3,}/.test(nl.text) && !findCas(nl.text).length);
          if (plain) name = cleanName(plain.text);
        }
      }

      return {
        cas: casInfo ? casInfo.cas : '',
        casValid: casInfo ? casInfo.valid : false,
        secret: !casInfo,
        name: cleanName(name),
        alias: cleanName(alias),
        contentRaw: contentRaw.trim(),
        min: content ? content.min : null,
        max: content ? content.max : null,
        isLt: content ? content.isLt : false,
        page: ln.page,
        y: ln.y,
        h: ln.h,
        lineText: ln.text,
        extraCas: casHits.slice(1).map((c) => c.cas),
        _li: li,
      };
    });

    // 4) 표 배치에서 줄바꿈된 물질명(CAS 없는 줄, CAS 열 왼쪽 이름 열에만 글자) → 가장 가까운 행에 이어붙임
    if (rows.length && header && casCol) {
      const avgH = rows.reduce((s, r) => s + r.h, 0) / rows.length;
      const nameCols = header.cols.filter((c) => c.type === 'name' || c.type === 'alias');
      lines.forEach((ln, i) => {
        if (i <= header.headerIdx || rowIdx.includes(i)) return;
        if (!ln.segs.length || !ln.segs.every((sg) => { const c = columnOf(sg, header); return c && nameCols.includes(c); })) return;
        let best = null;
        rows.forEach((r) => {
          if (r.page !== ln.page) return;
          const dy = Math.abs(r.y - ln.y);
          if (dy <= avgH * 2.6 && (!best || dy < best.dy)) best = { r, dy };
        });
        if (!best) return;
        ln.segs.forEach((sg) => {
          const c = columnOf(sg, header);
          const key = c.type === 'alias' ? 'aliasParts' : 'nameParts';
          const base = c.type === 'alias' ? best.r.alias : best.r.name;
          best.r[key] = best.r[key] || [{ y: best.r.y, text: base }];
          best.r[key].push({ y: ln.y, text: sg.text });
        });
      });
      rows.forEach((r) => {
        if (r.nameParts) r.name = cleanName(r.nameParts.sort((a, b) => a.y - b.y).map((p) => p.text).filter(Boolean).join(' '));
        if (r.aliasParts) r.alias = cleanName(r.aliasParts.sort((a, b) => a.y - b.y).map((p) => p.text).filter(Boolean).join(' '));
        delete r.nameParts; delete r.aliasParts;
      });
    }
    rows.forEach((r) => { delete r._li; });

    // 페이지가 넘어가며 행이 반복되거나 비고란에 같은 CAS가 다시 나온 경우 중복 제거
    // (같은 CAS면 함유량을 읽은 쪽을 남긴다)
    const deduped = [];
    rows.forEach((r) => {
      const dup = r.cas && deduped.find((d) => d.cas === r.cas);
      if (!dup) { deduped.push(r); return; }
      if (dup.max == null && r.max != null) Object.assign(dup, r);
    });

    const issues = [];
    if (!deduped.length) issues.push({ level: 'error', msg: '구성성분에서 CAS 번호를 읽지 못함' });
    deduped.forEach((r, i) => {
      if (r.cas && !r.casValid) issues.push({ level: 'warn', msg: `${i + 1}행 CAS ${r.cas} 체크디지트 불일치 — 원문 오기 또는 오독` });
      if (r.secret) issues.push({ level: 'info', msg: `${i + 1}행 CAS 비공개(영업비밀 등)` });
      if (r.max == null) issues.push({ level: 'warn', msg: `${i + 1}행${r.cas ? ' (' + r.cas + ')' : ''} 함유량을 읽지 못함` });
      if (r.max != null && r.max > 100) issues.push({ level: 'warn', msg: `${i + 1}행 함유량 ${r.max}%가 100% 초과` });
      if (r.extraCas.length) issues.push({ level: 'warn', msg: `${i + 1}행에 CAS가 여러 개 — 행 분리 확인 필요` });
    });
    const minSum = deduped.reduce((s, r) => s + (r.min || 0), 0);
    if (minSum > 100.5) issues.push({ level: 'warn', msg: `최소 함유량 합계 ${round(minSum)}% — 100% 초과` });

    return {
      found: !fallback,
      fallback,
      headerFound: !!header,
      layout: header ? 'table' : 'block',
      rows: deduped,
      issues,
    };
  }

  /* ═══════════════════════════════════════════════════════════
     8. ④ 15번 법적 규제현황
     ═══════════════════════════════════════════════════════════ */
  const LAW_DEFS = [
    { law: '산업안전보건법', kw: ['산업안전보건법', '산안법'], items: [
      ['작업환경측정대상물질', ['작업환경측정']],
      ['특수건강진단대상물질', ['특수건강진단', '특수건강검진']],
      ['관리대상유해물질', ['관리대상유해물질']],
      ['특별관리물질', ['특별관리물질']],
      ['노출기준설정물질', ['노출기준설정', '노출기준']],
      ['허용기준설정물질', ['허용기준설정', '허용기준']],
      ['제조등금지물질', ['제조등금지', '제조등의금지', '제조·사용금지']],
      ['허가대상물질', ['허가대상유해물질', '허가대상물질']],
      ['공정안전보고서(PSM) 대상', ['공정안전보고서', 'psm']],
    ] },
    { law: '화학물질관리법', kw: ['화학물질관리법', '화관법', '유해화학물질관리법'], items: [
      ['유독물질', ['유독물질']],
      ['사고대비물질', ['사고대비물질']],
      ['배출량조사대상', ['배출량조사']],
      ['인체급성유해성물질', ['인체급성유해성']],
      ['인체만성유해성물질', ['인체만성유해성']],
      ['생태유해성물질', ['생태유해성']],
    ] },
    { law: '화학물질의 등록 및 평가 등에 관한 법률', kw: ['화학물질의등록및평가', '화평법', '화학물질등록평가법'], items: [
      ['허가물질', ['허가물질']],
      ['제한물질', ['제한물질']],
      ['금지물질', ['금지물질']],
      ['중점관리물질', ['중점관리물질']],
      ['인체등유해성물질', ['인체등유해성', '인체등의유해성']],
      ['등록대상기존화학물질', ['등록대상기존화학물질']],
      ['기존화학물질', ['기존화학물질']],
    ] },
    { law: '위험물안전관리법', kw: ['위험물안전관리법', '위험물관리법'], items: [
      ['위험물', ['제1류', '제2류', '제3류', '제4류', '제5류', '제6류', '인화성액체', '특수인화물', '제1석유류', '제2석유류', '제3석유류', '제4석유류', '알코올류']],
    ] },
    { law: '폐기물관리법', kw: ['폐기물관리법'], items: [['지정폐기물', ['지정폐기물']]] },
    { law: '잔류성오염물질 관리법', kw: ['잔류성오염물질관리법', '잔류성오염물질', '잔류성유기오염물질'], items: [] },
    { law: '대기환경보전법', kw: ['대기환경보전법'], items: [] },
    { law: '물환경보전법', kw: ['물환경보전법', '수질및수생태계'], items: [] },
    { law: '토양환경보전법', kw: ['토양환경보전법'], items: [] },
    { law: '고압가스 안전관리법', kw: ['고압가스안전관리법'], items: [] },
    // ── 국외 SDS에서 자주 쓰이는 규제·목록 (해당 여부만 표시) ──
    { law: '한국 (영문 기재: K-REACH/KECI 등)', foreign: true, kw: ['k-reach', 'kreach', 'keci', 'koreaexisting', 'korea'], items: [] },
    { law: '미국 TSCA', foreign: true, kw: ['tsca'], items: [] },
    { law: '미국 SARA/EPCRA', foreign: true, kw: ['sara313', 'sara302', 'sara311', 'sara', 'epcra'], items: [] },
    { law: '미국 CERCLA', foreign: true, kw: ['cercla'], items: [] },
    { law: '미국 California Prop 65', foreign: true, kw: ['proposition65', 'prop.65', 'prop65'], items: [] },
    { law: '미국 OSHA', foreign: true, kw: ['29cfr1910', 'osha'], items: [] },
    { law: 'EU REACH', foreign: true, kw: ['1907/2006', 'svhc', 'reach'], items: [] },
    { law: 'EU CLP', foreign: true, kw: ['1272/2008', 'clp'], items: [] },
    { law: 'EU Seveso', foreign: true, kw: ['seveso', '2012/18/eu'], items: [] },
    { law: '독일 ChemG/GefStoffV', foreign: true, kw: ['chemikaliengesetz', 'gefstoffv', 'chemg'], items: [] },
    { law: '캐나다 DSL/WHMIS', foreign: true, kw: ['whmis', 'cepa', 'dsl'], items: [] },
    { law: '호주 AICS/AIIC', foreign: true, kw: ['aics', 'aiic'], items: [] },
    { law: '일본 ENCS/안위법', foreign: true, kw: ['encs', 'japan'], items: [] },
    { law: '중국 IECSC/위험화학품', foreign: true, kw: ['iecsc', '危险化学品', 'china'], items: [] },
    { law: '기타 국가 목록(필리핀·대만·뉴질랜드)', foreign: true, kw: ['piccs', 'tcsi', 'nzioc', 'newzealand'], items: [] },
    { law: '국제협약(로테르담·스톡홀름·몬트리올)', foreign: true, kw: ['로테르담', '스톡홀름', '몬트리올', 'rotterdam', 'stockholm', 'montreal'], items: [] },
  ];

  const NEGATIVE_RE = /^[:\-·•\s]*(해당없음|해당사항없음|해당안됨|비해당|미해당|자료없음|없음|notapplicable|notregulated|notlisted|notsubjectto|none\b|n\/a|na\b|-$)/i;

  // 모든 규제항목 키워드를 길이 내림차순으로 — "제조등금지물질"을 "금지물질"보다 먼저 잡기 위함
  const ITEM_KEYWORDS = [];
  LAW_DEFS.forEach((d) => d.items.forEach(([item, kws]) => kws.forEach((k) => {
    ITEM_KEYWORDS.push({ law: d.law, item, kw: compact(k).toLowerCase() });
  })));
  ITEM_KEYWORDS.sort((a, b) => b.kw.length - a.kw.length);

  const LAW_KEYWORDS = [];
  LAW_DEFS.forEach((d) => d.kw.forEach((k) => LAW_KEYWORDS.push({ law: d.law, kw: compact(k).toLowerCase() })));
  LAW_KEYWORDS.sort((a, b) => b.kw.length - a.kw.length);

  // 규제항목이 다른 법령에도 등장할 수 있어(예: 허가물질 — 구 화관법/현 화평법)
  // 줄에서 직전에 언급된 법령 문맥을 우선 사용한다.
  const ITEM_LAW_ALIASES = {
    '허가물질': ['화학물질관리법', '화학물질의 등록 및 평가 등에 관한 법률'],
    '제한물질': ['화학물질관리법', '화학물질의 등록 및 평가 등에 관한 법률'],
    '금지물질': ['화학물질관리법', '화학물질의 등록 및 평가 등에 관한 법률'],
    '인체등유해성물질': ['화학물질관리법', '화학물질의 등록 및 평가 등에 관한 법률'],
  };

  function maskRange(str, start, len) {
    return str.slice(0, start) + ' '.repeat(len) + str.slice(start + len);
  }

  function parseRegulations(allLines, sections, components) {
    const range = sectionRange(sections, 15, allLines.length);
    if (!range) {
      return { found: false, laws: [], hits: [], unmatchedCas: [], issues: [{ level: 'warn', msg: '15번 법적 규제현황 항목을 찾지 못함' }] };
    }
    const lines = allLines.slice(range[0], range[1]);
    const compByCas = new Map((components || []).filter((c) => c.cas).map((c) => [c.cas, c]));

    // 3번 표의 물질명·관용명을 성분 식별 키로 사용 (짧은 일반어는 오탐 방지 위해 제외)
    const nameKeys = [];
    (components || []).forEach((c) => {
      if (!c.cas) return;
      [c.name, c.alias].forEach((nm) => {
        const k = compact(nm).toLowerCase();
        if (!k || k === '-') return;
        const hangul = /[가-힣]/.test(k);
        if ((hangul && k.length >= 2) || (!hangul && k.length >= 4)) nameKeys.push({ cas: c.cas, key: k });
      });
    });
    nameKeys.sort((a, b) => b.key.length - a.key.length);

    const compOfLine = (ln) => {
      const cHits = findCas(ln.text);
      if (cHits.length) return cHits[0].cas;
      const lower = compact(ln.text).toLowerCase();
      const nk = nameKeys.find((n) => lower.includes(n.key));
      return nk ? nk.cas : '';
    };
    const lineHasItem = (ln) => {
      const lower = compact(normalizeSymbols(ln.text)).toLowerCase();
      return ITEM_KEYWORDS.some((k) => lower.includes(k.kw));
    };

    // 기재 방식 판별
    //  - 한 줄형: "톨루엔(108-88-3) : 작업환경측정대상물질…" → 성분은 그 줄에만 적용
    //  - 블록형: "톨루엔(108-88-3)" 다음 줄들에 규제 나열 → 다음 성분이 나올 때까지 유지
    let inlineCount = 0, blockCount = 0;
    lines.forEach((ln) => {
      if (!compOfLine(ln)) return;
      if (lineHasItem(ln)) inlineCount++; else blockCount++;
    });
    const carryOver = blockCount > inlineCount;

    const hits = [];
    const lawMentions = new Map(); // law -> { negative:boolean, positive:boolean, lines:[] }
    let lawCtx = null;
    let compCtx = '';
    const casIn15 = new Set();

    lines.forEach((ln, li) => {
      const lower = compact(normalizeSymbols(ln.text)).toLowerCase();
      findCas(ln.text).forEach((h) => casIn15.add(h.cas));

      const lineComp = compOfLine(ln);
      if (carryOver) { if (lineComp) compCtx = lineComp; }
      else compCtx = lineComp;

      // 법령 언급
      let work = lower;
      LAW_KEYWORDS.forEach(({ law, kw }) => {
        const idx = work.indexOf(kw);
        if (idx < 0) return;
        lawCtx = law;
        work = maskRange(work, idx, kw.length);
        const after = lower.slice(idx + kw.length)
          .replace(/^(관리법|법률|법)?(에의한|에따른|에의거한|상|의)?(규제|규제현황|규제정보)?/, '');
        const entry = lawMentions.get(law) || { negative: false, positive: false, lines: [] };
        if (NEGATIVE_RE.test(after)) entry.negative = true;
        entry.lines.push(ln.text);
        lawMentions.set(law, entry);
      });

      // 규제항목
      const found = [];
      ITEM_KEYWORDS.forEach(({ law, item, kw }) => {
        let idx = work.indexOf(kw);
        while (idx >= 0) {
          found.push({ law, item, start: idx, end: idx + kw.length });
          work = maskRange(work, idx, kw.length);
          idx = work.indexOf(kw);
        }
      });
      found.sort((a, b) => a.start - b.start);
      found.forEach((f, k) => {
        const nextStart = k + 1 < found.length ? found[k + 1].start : lower.length;
        let tail = lower.slice(f.end, nextStart).replace(/^(물질|대상|대상물질|유해물질|설정물질)+/, '');
        if (!tail.replace(/[:\-·•\s]/g, '') && lines[li + 1]) {
          tail = compact(lines[li + 1].text).toLowerCase(); // 표 형식: 다음 줄에 해당/해당없음
        }
        const negative = NEGATIVE_RE.test(tail);
        let law = f.law;
        const aliases = ITEM_LAW_ALIASES[f.item];
        if (aliases && lawCtx && aliases.includes(lawCtx)) law = lawCtx;
        hits.push({
          law,
          item: f.item,
          status: negative ? 'negative' : 'positive',
          cas: compCtx || '',
          line: ln.text,
          page: ln.page,
        });
        const entry = lawMentions.get(law) || { negative: false, positive: false, lines: [] };
        if (!negative) entry.positive = true;
        lawMentions.set(law, entry);
      });
    });

    // 법령별 요약
    const laws = [];
    LAW_DEFS.forEach((d) => {
      const m = lawMentions.get(d.law);
      const lawHits = hits.filter((h) => h.law === d.law);
      if (!m && !lawHits.length) return;
      const positiveItems = Array.from(new Set(lawHits.filter((h) => h.status === 'positive').map((h) => h.item)));
      const negativeItems = Array.from(new Set(lawHits.filter((h) => h.status === 'negative').map((h) => h.item)))
        .filter((it) => !positiveItems.includes(it));
      let status = 'mentioned';
      if (positiveItems.length) status = 'regulated';
      else if ((m && m.negative) || negativeItems.length) status = 'not_applicable';
      laws.push({ law: d.law, status, positiveItems, negativeItems });
    });

    const compCas = new Set(compByCas.keys());
    const unmatchedCas = Array.from(casIn15).filter((c) => casChecksumOk(c) && !compCas.has(c));

    const issues = [];
    if (!laws.length) issues.push({ level: 'warn', msg: '15번 항목에서 법령명을 찾지 못함 — 원문 확인 필요' });
    unmatchedCas.forEach((c) => issues.push({ level: 'warn', msg: `15번에 기재된 CAS ${c}가 3번 구성성분 표에 없음` }));

    return { found: true, laws, hits, unmatchedCas, issues };
  }

  /** 15번 규제 hit를 성분(CAS)별로 묶어 3번 표의 보조정보로 사용 */
  function regulationsByCas(reg) {
    const map = new Map();
    (reg && reg.hits ? reg.hits : []).forEach((h) => {
      if (h.status !== 'positive') return;
      const key = h.cas || '';
      if (!map.has(key)) map.set(key, []);
      const arr = map.get(key);
      if (!arr.some((x) => x.item === h.item && x.law === h.law)) arr.push({ law: h.law, item: h.item });
    });
    return map;
  }

  /* ═══════════════════════════════════════════════════════════
     9. 제품명 (1번 항목) — 시트 제목용
     ═══════════════════════════════════════════════════════════ */
  const PRODUCT_LABEL_RE = /^(?:[가-하]\.\s*|\d\)\s*|[-•·]\s*)?(제\s*품\s*명|상\s*품\s*명|product\s*name|trade\s*name|product\s*identifier|产品名称|产品名|化学品中文名)\s*(?:\([^)]*\))?\s*[:：]?\s*(.*)$/i;

  function findProductName(allLines, sections) {
    const range = sectionRange(sections, 1, allLines.length) || [0, Math.min(allLines.length, 40)];
    const scan = (lines) => {
      for (let i = 0; i < lines.length; i++) {
        // 같은 줄의 다른 칸(예: "SDS 编号…  产品名称：…")도 확인
        const parts = [lines[i].text].concat((lines[i].segs || []).map((sg) => sg.text));
        for (const part of parts) {
          const m = PRODUCT_LABEL_RE.exec(normalizeSymbols(part).trim());
          if (!m) continue;
          const v = m[2].replace(/^[:：\s]+/, '').trim();
          if (v && !/^(used|on|of)\b/i.test(v)) return v;
          const next = lines[i + 1] && lines[i + 1].text.trim();
          if (next && !PRODUCT_LABEL_RE.test(next) && next.length <= 80) return next;
        }
      }
      return '';
    };
    return scan(allLines.slice(range[0], range[1])) || scan(allLines.slice(0, Math.min(allLines.length, 40)));
  }

  /* ═══════════════════════════════════════════════════════════
     10. 전체 검사
     ═══════════════════════════════════════════════════════════ */
  function analyzeDocument(pages) {
    const allLines = [];
    pages.forEach((p) => p.lines.forEach((ln) => allLines.push(ln)));
    const sections = findSections(allLines);

    const submission = checkSubmissionNo(pages);
    const revision = checkRevisionDate(pages);
    const composition = parseComposition(allLines, sections);
    const regulation = parseRegulations(allLines, sections, composition.rows);
    const productName = findProductName(allLines, sections);

    const regByCas = regulationsByCas(regulation);
    composition.rows.forEach((r) => { r.regs = r.cas ? (regByCas.get(r.cas) || []) : []; });
    const productLevelRegs = regByCas.get('') || [];

    const missingSections = SECTION_DEFS.filter((d) => sections[d.no] == null).map((d) => d.no);
    const ocrPages = pages.filter((p) => p.source === 'ocr').map((p) => p.pageNo);

    const issues = [];
    issues.push({ level: submission.status, area: '제출번호', msg: submission.message });
    issues.push({ level: revision.status === 'ok' ? 'ok' : 'warn', area: '개정일자', msg: revision.message });
    composition.issues.forEach((i) => issues.push({ ...i, area: '3번 구성성분' }));
    if (!composition.found) issues.push({ level: 'warn', area: '3번 구성성분', msg: '3번 항목 제목을 찾지 못해 문서 전체에서 CAS를 탐색함' });
    regulation.issues.forEach((i) => issues.push({ ...i, area: '15번 법적규제' }));
    if (ocrPages.length) issues.push({ level: 'info', area: 'OCR', msg: `${ocrPages.join(', ')}페이지는 OCR로 판독 — 숫자·CAS를 원본과 대조하세요` });
    const lowRes = pages.filter((p) => p.lowRes);
    if (lowRes.length) {
      issues.push({ level: 'warn', area: 'OCR', msg: `이미지 해상도가 낮음(가로 ${lowRes.map((p) => p.pixelWidth + 'px').join(', ')}) — 오독 가능성이 높으니 200dpi 이상(가로 1600px 이상)으로 다시 스캔 권장` });
    }

    let verdict = 'OK';
    if (issues.some((i) => i.level === 'error')) verdict = 'REVIEW';
    else if (issues.some((i) => i.level === 'warn')) verdict = 'CHECK';

    return {
      verdict,
      productName,
      pageCount: pages.length,
      ocrPages,
      sections,
      missingSections,
      submission,
      revision,
      composition,
      regulation,
      productLevelRegs,
      issues,
    };
  }

  /* ═══════════════════════════════════════════════════════════
     11. 브라우저 전용 — 파일 → pages 추출 (pdf.js / Tesseract)
     ═══════════════════════════════════════════════════════════ */
  const VENDOR = 'vendor';
  let pdfjsPromise = null;
  let ocrWorkerPromise = null;

  function loadPdfjs() {
    if (!pdfjsPromise) {
      const base = new URL(VENDOR + '/pdfjs/', document.baseURI).href;
      pdfjsPromise = import(base + 'pdf.min.mjs').then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs';
        return { lib, base };
      });
    }
    return pdfjsPromise;
  }

  function getOcrWorker(onProgress) {
    if (!ocrWorkerPromise) {
      if (!root.Tesseract) return Promise.reject(new Error('OCR 라이브러리(Tesseract)를 불러오지 못했습니다.'));
      const base = new URL(VENDOR + '/tesseract/', document.baseURI).href;
      ocrWorkerPromise = root.Tesseract.createWorker('kor+eng', 1, {
        workerPath: base + 'worker.min.js',
        corePath: base + 'core',
        langPath: base + 'lang',
        gzip: true,
        logger: (m) => { if (ocrProgressHook) ocrProgressHook(m); },
      }).then(async (w) => {
        // 페이지 분할 모드: 희소 텍스트(PSM 11) — 단어 좌표로 줄·열을 직접 재구성하므로
        // 표 안의 글자까지 빠짐없이 찾는 모드가 유리하다. 실측: 기본값(PSM 6)은 표 영역을,
        // 자동(PSM 3)은 일부 문단을 통째로 누락했다.
        await w.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' });
        return w;
      }).catch((e) => { ocrWorkerPromise = null; throw e; });
    }
    ocrProgressHook = onProgress || null;
    return ocrWorkerPromise;
  }
  let ocrProgressHook = null;

  /** 캔버스 OCR → 정규화된 line 배열 */
  async function ocrCanvas(canvas, pageNo, onProgress) {
    const worker = await getOcrWorker(onProgress);
    const { data } = await worker.recognize(canvas);
    const W = canvas.width, H = canvas.height;
    // data.words는 첫 블록만 담기는 경우가 있어(표 영역 누락) 전체 단어가 들어 있는 TSV를 사용한다
    // TSV 열: level page block par line word left top width height conf text
    const words = [];
    String(data.tsv || '').split('\n').forEach((row) => {
      const c = row.split('\t');
      if (c.length < 12 || c[0] !== '5') return;
      const text = c.slice(11).join('\t');
      const conf = Number(c[10]);
      if (!text.trim() || (Number.isFinite(conf) && conf >= 0 && conf < 10)) return;
      const left = +c[6], top = +c[7], width = +c[8], height = +c[9];
      words.push({ str: text, x0: left / W, x1: (left + width) / W, y: (top + height / 2) / H, h: height / H });
    });
    return buildLines(words, pageNo, H / W);
  }

  function canvasFromImage(img) {
    // OCR 정확도를 위해 너비 1600~2600px 범위로 맞춘다
    const targetW = Math.min(2600, Math.max(1600, img.naturalWidth || img.width));
    const scale = targetW / (img.naturalWidth || img.width);
    const c = document.createElement('canvas');
    c.width = Math.round((img.naturalWidth || img.width) * scale);
    c.height = Math.round((img.naturalHeight || img.height) * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 열 수 없습니다.')); };
      img.src = url;
    });
  }

  /**
   * 파일 1개 → pages[{pageNo, source:'text'|'ocr', lines}]
   * onStatus(text): 진행 상태 문자열 콜백
   */
  async function extractPages(file, onStatus) {
    const status = onStatus || (() => {});
    const isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name);
    const ocrProgress = (label) => (m) => {
      if (m && m.status === 'recognizing text') status(`${label} OCR 판독 중… ${Math.round((m.progress || 0) * 100)}%`);
      else if (m && /loading|initializ/.test(m.status || '')) status('OCR 엔진 준비 중… (최초 1회, 수 초 소요)');
    };

    if (!isPdf) {
      status('이미지 불러오는 중…');
      const img = await loadImage(file);
      const canvas = canvasFromImage(img);
      const lines = await ocrCanvas(canvas, 1, ocrProgress('이미지'));
      // A4 기준 가로 1600px ≈ 200dpi. 그보다 작으면 작은 글자·숫자 오독이 많다
      return [{ pageNo: 1, source: 'ocr', lines, lowRes: (img.naturalWidth || img.width) < 1500, pixelWidth: img.naturalWidth || img.width }];
    }

    status('PDF 여는 중…');
    const { lib, base: pdfBase } = await loadPdfjs();
    const buf = await file.arrayBuffer();
    const pdf = await lib.getDocument({
      data: new Uint8Array(buf),
      cMapUrl: pdfBase + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: pdfBase + 'standard_fonts/',
      isEvalSupported: false,
    }).promise;

    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      status(`${i}/${pdf.numPages}페이지 텍스트 추출 중…`);
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = [];
      let raw = '';
      tc.items.forEach((it) => {
        if (!it.str || !it.str.trim()) return;
        const tx = lib.Util.transform(vp.transform, it.transform);
        const fontH = Math.hypot(tx[2], tx[3]) || 10;
        const x0 = tx[4];
        const w = (it.width || 0) * vp.scale || fontH * it.str.length * 0.6;
        const yBase = tx[5];
        items.push({
          str: it.str,
          x0: x0 / vp.width,
          x1: (x0 + w) / vp.width,
          y: (yBase - fontH * 0.35) / vp.height,
          h: fontH / vp.height,
        });
        raw += it.str;
      });

      if (textLooksUsable(raw)) {
        pages.push({ pageNo: i, source: 'text', lines: buildLines(items, i, vp.height / vp.width) });
      } else {
        // 스캔본(또는 글자 매핑이 깨진) 페이지 → 렌더링 후 OCR
        status(`${i}/${pdf.numPages}페이지 이미지 렌더링 중…`);
        const scale = Math.min(3, 2200 / vp.width);
        const rvp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(rvp.width);
        canvas.height = Math.round(rvp.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: rvp }).promise;
        const lines = await ocrCanvas(canvas, i, ocrProgress(`${i}/${pdf.numPages}페이지`));
        pages.push({ pageNo: i, source: 'ocr', lines });
      }
      page.cleanup();
    }
    await pdf.destroy();
    return pages;
  }

  async function checkFile(file, onStatus) {
    const pages = await extractPages(file, onStatus);
    const result = analyzeDocument(pages);
    result.fileName = file.name;
    result.pages = pages;
    return result;
  }

  /** 여러 장의 이미지(페이지별 사진·스캔)를 순서대로 한 MSDS로 묶어 검사 */
  async function checkFilesAsOne(files, onStatus) {
    const pages = [];
    for (let i = 0; i < files.length; i++) {
      const status = (t) => (onStatus || (() => {}))(`${i + 1}/${files.length}장 — ${t}`);
      const ps = await extractPages(files[i], status);
      ps.forEach((p) => {
        const pageNo = pages.length + 1;
        p.pageNo = pageNo;
        p.lines.forEach((l) => { l.page = pageNo; });
        p.sourceFile = files[i].name;
        pages.push(p);
      });
    }
    const result = analyzeDocument(pages);
    result.fileName = files.map((f) => f.name).join(' + ');
    result.pages = pages;
    return result;
  }

  const api = {
    // 순수 로직 (테스트용으로 노출)
    casChecksumOk,
    findCas,
    buildLines,
    textLooksUsable,
    findSections,
    parseContent,
    checkSubmissionNo,
    checkRevisionDate,
    extractDates,
    parseComposition,
    parseRegulations,
    findProductName,
    analyzeDocument,
    SECTION_DEFS,
    LAW_DEFS,
    // 브라우저 전용
    extractPages,
    checkFile,
    checkFilesAsOne,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MsdsCheck = api;
})(typeof self !== 'undefined' ? self : this);
