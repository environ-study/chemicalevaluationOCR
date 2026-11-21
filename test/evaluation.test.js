const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler, validCas } = require('../api/_lib/evaluation');

const component = (overrides = {}) => ({ componentId: 'C01', casNo: '96-29-7', contentMin: 10, contentMax: 25, maxExclusive: false, contentUnit: 'percent', ...overrides });
const body = (components = [component()]) => ({ requestId: 'R1', materialCode: 'M1', msdsVersionId: 'V1', components });
const source = (payload) => async (_req, res) => res.status(200).json(payload);
function handler(overrides = {}) {
  return createHandler({ getKey: () => 'test-secret', upstreamReady: () => true,
    kreach: source({ success: true, notFound: false, regulations: [] }),
    kosha: source({ success: true, notFound: false, regulations: [] }), ...overrides });
}
async function call(fn, input = body(), headers = {}, method = 'POST') {
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  await fn({ method, headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json', ...headers }, body: input }, res);
  return res;
}

test('CAS checksum and strict numeric input validation', async () => {
  assert.equal(validCas('96-29-7'), true);
  assert.equal(validCas('96-29-8'), false);
  for (const changes of [{ casNo: '96-29-8' }, { contentMax: '25%' }, { contentMax: 101 }, { contentMin: 30 }, { maxExclusive: 'false' }, { contentUnit: 'fraction' }, { contentMin: 25, maxExclusive: true }]) {
    const res = await call(handler(), body([component(changes)]));
    assert.equal(res.code, 400);
  }
});

test('rejects invalid identities, duplicate IDs and excessive batch sizes before querying', async () => {
  const fn = handler({ kreach: () => { throw Error('must not query'); } });
  assert.equal((await call(fn, body([component(), component()]))).code, 400);
  assert.equal((await call(fn, body(Array.from({ length: 11 }, (_, i) => component({ componentId: String(i) }))))).code, 400);
  assert.equal((await call(fn, { ...body(), requestId: '' })).code, 400);
});

test('fails closed without integration key and rejects invalid authentication/content', async () => {
  assert.equal((await call(handler({ getKey: () => undefined }))).code, 503);
  assert.equal((await call(handler(), body(), { authorization: 'Bearer wrong' })).code, 401);
  assert.equal((await call(handler(), body(), { 'content-type': 'text/plain' })).code, 415);
  assert.equal((await call(handler(), '{')).code, 400);
  assert.equal((await call(handler(), ' '.repeat(32769))).code, 413);
  const method = await call(handler(), body(), {}, 'GET');
  assert.equal(method.code, 405);
  assert.equal(method.headers.Allow, 'POST');
});

test('forwards maximum/exclusive boundary and preserves regulation evidence', async () => {
  const evidence = { success: true, regulations: [{ type: '인체등유해성물질', matchedByContent: true, uniqueNo: '2023-1-1127', sources: [{ ancmntInfo: 'test' }] }] };
  let received;
  const res = await call(handler({ kreach: async (req, response) => { received = req.query; response.json(evidence); } }));
  assert.deepEqual(received, { cas: '96-29-7', contentMax: '25', isLt: 'false' });
  assert.equal(res.body.components[0].regulatoryStatus, 'REGULATED');
  assert.deepEqual(res.body.components[0].sources.kreach, evidence);
  assert.ok(res.body.components[0].requiredActions.includes('SITE_PERMIT_REVIEW'));
  assert.equal(res.body.finalAdmissionDecision, 'REQUIRES_INTERNAL_SYSTEM_REVIEW');
  assert.equal(res.body.materialCode, 'M1');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('deduplicates calls while preserving component IDs and request order', async () => {
  let krCalls = 0, koCalls = 0;
  const res = await call(handler({
    kreach: async (_req, r) => { krCalls++; r.json({ success: true, regulations: [] }); },
    kosha: async (_req, r) => { koCalls++; r.json({ success: true, regulations: [] }); },
  }), body([component(), component({ componentId: 'C02' }), component({ componentId: 'C03', contentMax: 30 })]));
  assert.equal(krCalls, 2);
  assert.equal(koCalls, 1);
  assert.deepEqual(res.body.components.map(c => c.componentId), ['C01', 'C02', 'C03']);
});

test('distinguishes no-match, not-found and upstream failure; preserves successful side', async () => {
  const noMatch = await call(handler());
  assert.equal(noMatch.body.components[0].regulatoryStatus, 'NO_MATCH_IN_QUERIED_SOURCES');
  const missing = await call(handler({ kosha: source({ success: true, notFound: true, regulations: [] }) }));
  assert.equal(missing.body.components[0].regulatoryStatus, 'UNDETERMINED');
  assert.equal(missing.body.components[0].status, 'REVIEW_REQUIRED');
  const partial = await call(handler({ kosha: source({ success: false, errorCode: 'UPSTREAM_TIMEOUT', retryable: true }) }));
  assert.equal(partial.body.status, 'PARTIAL');
  assert.equal(partial.body.success, false);
  assert.equal(partial.body.components[0].sources.kreach.success, true);
  assert.equal(partial.body.components[0].sources.kosha.errorCode, 'UPSTREAM_TIMEOUT');
});

test('does not expose unexpected exception details or arbitrary caller properties', async () => {
  const res = await call(handler({ kosha: async () => { throw Error('secret URL'); } }), body([component({ privateNote: 'do not echo' })]));
  assert.equal(res.body.components[0].sources.kosha.errorCode, 'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(res.body).includes('secret URL'));
  assert.ok(!JSON.stringify(res.body).includes('do not echo'));
});
