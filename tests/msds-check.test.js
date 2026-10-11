/* MSDS 정합성 검사 순수 로직 테스트 — 실행: npm test (node tests/msds-check.test.js) */
const assert = require('assert');
const M = require('../msds-check.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('CAS 체크디지트', () => {
  assert.ok(M.casChecksumOk('108-88-3'));
  assert.ok(M.casChecksumOk('7732-18-5'));
  assert.ok(!M.casChecksumOk('6777-74-7')); // 실제 샘플의 원문 오기(정답 67774-74-7)
});

t('함유량 형식', () => {
  const c = (s, strict) => { const r = M.parseContent(s, strict); return r && [r.min, r.max, r.isLt]; };
  assert.deepStrictEqual(c('10~20'), [10, 20, false]);
  assert.deepStrictEqual(c('1~5 미만'), [1, 5, true]);
  assert.deepStrictEqual(c('5 이상 10 미만'), [5, 10, true]);
  assert.deepStrictEqual(c('< 1'), [null, 1, true]);
  assert.deepStrictEqual(c('30 ± 5'), [25, 35, false]);
  assert.deepStrictEqual(c('≥1 - <2.5 %'), [1, 2.5, true]);
  assert.deepStrictEqual(c('>= 99.00 - <= 100.00 %W/W'), [99, 100, false]);
  assert.deepStrictEqual(c('0,5 - 1 %'), [0.5, 1, false]);
  assert.strictEqual(c('244-334-7'), null);           // EC 번호
  assert.strictEqual(c('Flam. Liq. 3, H226', true), null);
});

t('날짜 형식', () => {
  const d = (s) => M.extractDates(s).map((x) => x.iso);
  assert.deepStrictEqual(d('최종 개정일자 : 2023. 05. 01'), ['2023-05-01']);
  assert.deepStrictEqual(d('Safety Data Sheet dated: 10/23/2025'), ['2025-10-23']);
  assert.deepStrictEqual(d('Revision Date 15.01.2025'), ['2025-01-15']);
  assert.deepStrictEqual(d('Revision Date: Jan 1st, 2025'), ['2025-01-01']);
  assert.deepStrictEqual(d('修订日期：2017/6/1'), ['2017-06-01']);
});

t('섹션 제목(국문/영문/중문)', () => {
  const L = (text) => ({ text });
  const s = M.findSections([
    '1. 화학제품과 회사에 관한 정보', 'SECTION 3: Composition / information on ingredients',
    '3.1 Substances or 3.2 Mixtures', 'See Section 14', '第十五部分 法规信息', '16. Other information',
  ].map(L));
  assert.deepStrictEqual(s, { 1: 0, 3: 1, 15: 4, 16: 5 });
});

t('제출번호 — 첫/마지막 페이지', () => {
  const page = (pageNo, texts) => ({ pageNo, lines: texts.map((text) => ({ text, page: pageNo })) });
  assert.strictEqual(M.checkSubmissionNo([page(1, ['MSDS 제출번호 : AA01234-5678901234']), page(2, [])]).status, 'ok');
  assert.strictEqual(M.checkSubmissionNo([page(1, []), page(2, ['AA01234-5678901234']), page(3, [])]).status, 'error');
  assert.strictEqual(M.checkSubmissionNo([page(1, ['MSDS 제출번호 : 4401234-5678901234'])]).corrected, true);
  assert.strictEqual(M.checkSubmissionNo([page(1, ['제품명 : 테스트'])]).status, 'error');
});

t('15번 소제목형(KCC 양식) — 성분별 해당됨/해당없음', () => {
  const lines = [
    '15. 법적 규제현황', '가. 산업안전보건법에 의한 규제', '○ 작업환경측정물질',
    '- 해당됨 (1% 이상 함유한 자일렌)', '- 해당없음 (1% 이상 함유한 에틸벤젠)',
    '- [2-Propenoic acid polymer with butyl] : 해당', '없음',
    '○ PSM대상물질 - 제품:해당됨(인화성액체)', '- [자일렌] : 해당됨 (인화성 액체)',
    '나. 화학물질관리법에 의한 규제', '○ 사고대비물질', '- 해당없음 (85% 이상 함유한 자일렌)',
    '다. 화학물질의 등록 및 평가 등에 관한 법률', '* 중점관리물질', '- [자일렌] : STOT',
    '16. 그 밖의 참고사항',
  ].map((text) => ({ text, page: 1, segs: [{ text, x0: 0.1, x1: 0.9 }] }));
  const comps = [
    { cas: '1330-20-7', name: '자일렌', alias: '자일롤 ; 다이메틸벤젠' },
    { cas: '100-41-4', name: '에틸벤젠', alias: '' },
    { cas: '27306-39-4', name: '2-Propenoic acid polymer with butyl', alias: '' },
  ];
  const r = M.parseRegulations(lines, M.findSections(lines), comps);
  const pos = (cas) => r.hits.filter((h) => h.cas === cas && h.status === 'positive').map((h) => h.item).sort();
  assert.deepStrictEqual(pos('1330-20-7'), ['공정안전보고서(PSM) 대상', '작업환경측정대상물질', '중점관리물질']);
  assert.deepStrictEqual(pos('100-41-4'), []);
  assert.deepStrictEqual(pos('27306-39-4'), []); // 줄바꿈된 "해당 / 없음"
  assert.ok(r.hits.some((h) => h.cas === '' && h.item === '공정안전보고서(PSM) 대상'));
  assert.ok(!r.hits.some((h) => h.item === '위험물')); // 괄호 속 "인화성 액체"는 항목이 아님
  assert.strictEqual(r.unmatchedNames.length, 0);
});

console.log(`\n${n} passed`);
