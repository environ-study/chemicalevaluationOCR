/* ============================================================
   api/kreach-batch.js — 화평법 K-REACH 묶음 조회 서버리스 함수
   ─────────────────────────────────────────────────────────
   POST /api/kreach-batch
   Headers: Content-Type: application/json
            x-access-token: <KREACH_BATCH_TOKEN 환경변수 값>
   Body:    {
              "view": "summary" | "full",          (기본 summary)
              "items": [
                { "cas": "7681-52-9", "contentMax": 7, "isLt": false },
                ...                                  (최대 MAX_ITEMS개)
              ]
            }

   - 같은 CAS는 업스트림 원문을 한 번만 조회하고, 함량 판정은 항목별로 한다.
   - 업스트림 과부하(429)를 피하려고 동시 조회 수를 CONCURRENCY로 제한한다.
   - 한 항목이 실패해도 전체는 200으로 응답하고, 해당 항목만 success:false.
   - 함수 시간 제한 전에 끝내지 못한 항목은 BATCH_TIME_LIMIT(retryable)로 돌려준다.
   - 토큰 환경변수가 없으면 열어두지 않고 500(SERVER_MISCONFIGURED)으로 막는다.
   ============================================================ */

const crypto = require('crypto');
const { getKreachRaw, toSummary } = require('./_lib/kreach-service');
const { applyContentJudgment } = require('./_lib/kreach-parse');
const { classifyUpstreamFailure } = require('./_lib/http');
const { normalizeCas, isValidCasFormat } = require('./_lib/normalize');

const MAX_ITEMS = 30;
const CONCURRENCY = 5;
const TIME_BUDGET_MS = 50000; // vercel.json maxDuration(60s)보다 여유 있게

function fail(res, status, errorCode, message, retryable = false) {
  res.status(status).json({ success: false, retryable, errorCode, message });
}

function tokenMatches(given, expected) {
  // 길이 차이로 인한 타이밍 노출을 막기 위해 해시 후 상수시간 비교
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function parseBody(req) {
  const body = req.body;
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : body;
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseContentMax(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** 동시 실행 수를 제한해 tasks(() => Promise)를 실행. 시간 초과 시 남은 작업은 시작하지 않는다. */
async function runPool(tasks, limit, deadline) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      if (Date.now() > deadline) {
        results[i] = { timedOut: true };
        continue;
      }
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    fail(res, 405, 'METHOD_NOT_ALLOWED', 'POST만 지원합니다.');
    return;
  }

  const apiKey = process.env.API_KEY;
  const accessToken = process.env.KREACH_BATCH_TOKEN;
  if (!apiKey || !accessToken) {
    fail(res, 500, 'SERVER_MISCONFIGURED', '서버 환경설정 오류입니다. 관리자에게 문의해 주세요.');
    return;
  }

  if (!tokenMatches(req.headers['x-access-token'], accessToken)) {
    fail(res, 401, 'UNAUTHORIZED', 'x-access-token 헤더가 없거나 올바르지 않습니다.');
    return;
  }

  const body = parseBody(req);
  if (!body || !Array.isArray(body.items)) {
    fail(res, 400, 'BAD_REQUEST', 'JSON 본문에 items 배열이 필요합니다.');
    return;
  }
  if (body.items.length === 0) {
    fail(res, 400, 'BAD_REQUEST', 'items가 비어 있습니다.');
    return;
  }
  if (body.items.length > MAX_ITEMS) {
    fail(res, 400, 'TOO_MANY_ITEMS', `한 번에 최대 ${MAX_ITEMS}개까지 조회할 수 있습니다. 나눠서 요청해 주세요.`);
    return;
  }
  const view = body.view === 'full' ? 'full' : 'summary';

  // 항목 정규화 + 형식 검사(틀린 항목은 그 항목만 실패 처리)
  const items = body.items.map((it) => {
    const src = it && typeof it === 'object' ? it : { cas: it };
    const cas = normalizeCas(src.cas);
    return {
      cas,
      valid: isValidCasFormat(cas),
      contentMax: parseContentMax(src.contentMax),
      isLt: src.isLt === true || src.isLt === 'true' || src.isLt === 1 || src.isLt === '1',
    };
  });

  // 유효한 CAS만 중복 제거해 원문 조회
  const uniqueCas = [...new Set(items.filter((it) => it.valid).map((it) => it.cas))];
  const deadline = Date.now() + TIME_BUDGET_MS;
  const fetched = await runPool(
    uniqueCas.map((cas) => async () => {
      try {
        return { raw: await getKreachRaw(cas, apiKey) };
      } catch (err) {
        const payload = classifyUpstreamFailure(err, err && err.upstreamRes);
        console.error(`[api/kreach-batch] cas=${cas} errorCode=${payload.errorCode}`);
        return { error: payload };
      }
    }),
    CONCURRENCY,
    deadline
  );
  const byCas = new Map(uniqueCas.map((cas, i) => [cas, fetched[i]]));

  const results = items.map((it) => {
    if (!it.valid) {
      return { cas: it.cas, success: false, retryable: false, errorCode: 'INVALID_CAS', message: 'CAS 번호 형식이 올바르지 않습니다.' };
    }
    const got = byCas.get(it.cas);
    if (got.timedOut) {
      return { cas: it.cas, success: false, retryable: true, errorCode: 'BATCH_TIME_LIMIT', message: '시간 제한으로 조회하지 못했습니다. 이 항목만 다시 요청해 주세요.' };
    }
    if (got.error) return { cas: it.cas, ...got.error };
    const final = applyContentJudgment(got.raw, it.contentMax, it.isLt);
    if (view === 'summary') return toSummary(final);
    return { cas: it.cas, ...final };
  });

  const failed = results.filter((r) => !r || r.success !== true).length;
  res.status(200).json({ success: true, view, count: results.length, failed, results });
};
