const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const app = vm.createContext({ window: { addEventListener() {} }, document: { addEventListener() {} } });
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8'), app);

function comp(regulations) {
  return { cas: '96-29-7', min: 0, max: 0.01,
    kr: { success: true, chemicalNameEn: 'Methyl ethyl ketoxime', regulations },
    ko: { success: true, regulations: [] }, verdict: { verdict: 'OK' } };
}

test('LOC discloses all designated categories below their concentration thresholds', () => {
  const c = comp([
    ...['급성', '만성', '생태'].map(hazardCategory => ({ type: '인체등유해성물질', hazardCategory, matchedByContent: false })),
    ...['허가물질', '제한물질', '사고대비물질'].map(type => ({ type, matchedByContent: false })),
  ]);
  const row = app.buildLocComps([c])[0];
  for (const key of ['v_acute', 'v_chronic', 'v_env', 'v_perm', 'v_rest', 'v_acc']) assert.equal(row[key], 'V');
  assert.equal(row.v_prohib, '');
});

test('LOC disclosure does not change with concentration match; undesignated fields remain blank', () => {
  const regulation = { type: '인체등유해성물질', hazardCategory: '만성', criterion: '≥0.1%' };
  for (const matchedByContent of [false, true]) {
    const row = app.buildLocComps([comp([{ ...regulation, matchedByContent }])])[0];
    assert.equal(row.v_chronic, 'V');
    assert.equal(row.v_acute, '');
    assert.equal(row.v_env, '');
    assert.equal(row.v_acc, '');
  }
});

test('below-threshold regulatory criteria and category are visible with separate applicability label', () => {
  const c = comp([{ type: '인체등유해성물질', hazardCategory: '만성', criterion: '≥0.1%', matchedByContent: false, sources: [] }]);
  const html = app.buildKrCell(c.kr, 0, 0);
  assert.ok(html.includes('만성 · ≥0.1% · 입력 함량 기준 비해당'));
  assert.ok(html.includes("'reg',0"));
  assert.equal(app.decidePurchase(c, new Set(), new Set(), false).verdict, 'OK');
});

test('special management under KOSHA does not populate environment accident category', () => {
  const c = comp([]);
  c.ko.regulations = [{ type: '특별관리물질' }];
  assert.equal(app.buildLocComps([c])[0].v_acc, '');
  assert.equal(app.decidePurchase(c, new Set(), new Set(), false).verdict, 'REVIEW');
});
