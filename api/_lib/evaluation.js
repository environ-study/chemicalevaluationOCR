const { randomUUID, timingSafeEqual } = require('node:crypto');

const MAX_COMPONENTS = 10;
const LOGIC_VERSION = '1.0.0';

function validCas(value) {
  if (typeof value !== 'string' || !/^\d{2,7}-\d{2}-\d$/.test(value)) return false;
  const digits = value.replace(/-/g, '');
  const sum = [...digits.slice(0, -1)].reverse().reduce((n, d, i) => n + Number(d) * (i + 1), 0);
  return sum % 10 === Number(digits.at(-1));
}

function validate(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['JSON 객체가 필요합니다.'];
  for (const key of ['requestId', 'materialCode', 'msdsVersionId']) {
    if (typeof body[key] !== 'string' || !body[key].trim() || body[key].length > 128) errors.push(`${key}: 1~128자 문자열이 필요합니다.`);
  }
  if (!Array.isArray(body.components) || body.components.length < 1 || body.components.length > MAX_COMPONENTS) {
    return [...errors, `components: 1~${MAX_COMPONENTS}개 성분이 필요합니다.`];
  }
  const ids = new Set();
  body.components.forEach((c, i) => {
    const prefix = `components[${i}]`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) { errors.push(`${prefix}: 객체가 필요합니다.`); return; }
    if (typeof c.componentId !== 'string' || !c.componentId.trim() || c.componentId.length > 128 || ids.has(c.componentId)) errors.push(`${prefix}.componentId: 중복 없는 1~128자 ID가 필요합니다.`);
    ids.add(c.componentId);
    if (!validCas(c.casNo)) errors.push(`${prefix}.casNo: CAS 형식 또는 체크섬 오류입니다.`);
    if (typeof c.contentMax !== 'number' || !Number.isFinite(c.contentMax) || c.contentMax <= 0 || c.contentMax > 100) errors.push(`${prefix}.contentMax: 0 초과 100 이하의 숫자가 필요합니다.`);
    if (c.contentMin !== undefined && (typeof c.contentMin !== 'number' || !Number.isFinite(c.contentMin) || c.contentMin < 0 || c.contentMin > c.contentMax)) errors.push(`${prefix}.contentMin: 0 이상 최대함량 이하의 숫자가 필요합니다.`);
    if (typeof c.maxExclusive !== 'boolean') errors.push(`${prefix}.maxExclusive: true 또는 false가 필요합니다.`);
    if (c.maxExclusive && c.contentMin === c.contentMax) errors.push(`${prefix}: 미만 조건에서 최소·최대함량이 같을 수 없습니다.`);
    if (c.contentUnit !== 'percent') errors.push(`${prefix}.contentUnit: percent만 지원합니다. 25%는 25로 보내세요.`);
  });
  return errors;
}

function safeEqual(a, b) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Reuse existing handlers and their upstream error classification/cache without HTTP self-calls.
async function invoke(handler, query) {
  let payload;
  const response = { status() { return this; }, json(value) { payload = value; return this; } };
  try {
    await handler({ method: 'GET', query }, response);
    if (payload && typeof payload.success === 'boolean') return payload;
  } catch { /* Never return exception messages or credentials. */ }
  return { success: false, errorCode: 'INTERNAL_ERROR', retryable: true, message: '조회 처리 오류입니다.' };
}

function componentResult(component, kr, ko) {
  const failed = kr.success !== true || ko.success !== true;
  const missing = kr.notFound === true || ko.notFound === true;
  const matched = (kr.regulations || []).filter(r => r.matchedByContent === true);
  const koRegs = ko.regulations || [];
  const actions = [];
  if (failed) actions.push('RETRY_OR_MANUAL_REVIEW');
  if (missing) actions.push('VERIFY_SUBSTANCE_IDENTITY');
  if (kr.prohibited || ko.prohibited) actions.push('PROHIBITION_REVIEW');
  if (matched.length) actions.push('SITE_PERMIT_REVIEW');
  if (koRegs.length || ko.specialManagement) actions.push('OCCUPATIONAL_SAFETY_REVIEW');
  return {
    ...component,
    status: failed ? 'PARTIAL' : missing ? 'REVIEW_REQUIRED' : 'COMPLETE',
    regulatoryStatus: failed || missing ? 'UNDETERMINED'
      : kr.prohibited || ko.prohibited || matched.length || koRegs.length || ko.specialManagement ? 'REGULATED' : 'NO_MATCH_IN_QUERIED_SOURCES',
    requiredActions: actions,
    sources: { kreach: kr, kosha: ko },
  };
}

function createHandler({ kreach, kosha, getKey = () => process.env.INTEGRATION_API_KEY, upstreamReady = () => !!process.env.API_KEY }) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ success: false, errorCode: 'METHOD_NOT_ALLOWED', retryable: false });
    }
    const key = getKey();
    if (!key) return res.status(503).json({ success: false, errorCode: 'INTEGRATION_NOT_CONFIGURED', retryable: false });
    const auth = req.headers?.authorization;
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), key)) return res.status(401).json({ success: false, errorCode: 'UNAUTHORIZED', retryable: false });
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')) return res.status(415).json({ success: false, errorCode: 'UNSUPPORTED_MEDIA_TYPE', retryable: false });
    let body = req.body;
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      if (Buffer.byteLength(body) > 32768) return res.status(413).json({ success: false, errorCode: 'PAYLOAD_TOO_LARGE', retryable: false });
      try { body = JSON.parse(body.toString()); } catch { return res.status(400).json({ success: false, errorCode: 'INVALID_JSON', retryable: false }); }
    }
    if (Buffer.byteLength(JSON.stringify(body) || '') > 32768) return res.status(413).json({ success: false, errorCode: 'PAYLOAD_TOO_LARGE', retryable: false });
    const errors = validate(body);
    if (errors.length) return res.status(400).json({ success: false, errorCode: 'VALIDATION_FAILED', retryable: false, errors });
    if (!upstreamReady()) return res.status(503).json({ success: false, errorCode: 'SERVER_MISCONFIGURED', retryable: false });
    const startedAt = new Date().toISOString();
    const krTasks = new Map(), koTasks = new Map();
    const components = new Array(body.components.length);
    let cursor = 0;
    const lookup = (map, key, fn) => {
      if (!map.has(key)) map.set(key, fn());
      return map.get(key);
    };
    async function worker() {
      while (cursor < body.components.length) {
        const i = cursor++;
        const c = body.components[i];
        const [kr, ko] = await Promise.all([
          lookup(krTasks, `${c.casNo}:${c.contentMax}:${c.maxExclusive}`, () => invoke(kreach, { cas: c.casNo, contentMax: String(c.contentMax), isLt: String(c.maxExclusive) })),
          lookup(koTasks, c.casNo, () => invoke(kosha, { cas: c.casNo })),
        ]);
        // Explicit fields only: do not echo arbitrary caller properties.
        components[i] = componentResult({ componentId: c.componentId, casNo: c.casNo, contentMin: c.contentMin ?? null, contentMax: c.contentMax, maxExclusive: c.maxExclusive, contentUnit: 'percent' }, kr, ko);
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, body.components.length) }, worker));
    const partial = components.some(c => c.status === 'PARTIAL');
    return res.status(200).json({
      success: !partial, status: partial ? 'PARTIAL' : 'COMPLETE',
      evaluationId: randomUUID(), requestId: body.requestId,
      materialCode: body.materialCode, msdsVersionId: body.msdsVersionId,
      apiVersion: '1', logicVersion: LOGIC_VERSION,
      startedAt, evaluatedAt: new Date().toISOString(),
      finalAdmissionDecision: 'REQUIRES_INTERNAL_SYSTEM_REVIEW',
      components,
    });
  };
}

module.exports = { createHandler, validate, validCas };
