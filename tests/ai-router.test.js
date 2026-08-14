'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AiRouter, QuotaLedger, estimateTokens, extractJson, backoffMs, MODELS } = require('../n8n/src/lib/ai-router');

const KEYS = { groq: 'gk', gemini: 'ge' };
const noSleep = async () => {};

function groqOk(text, tokens = 100) {
  return { status: 200, headers: {}, body: { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { total_tokens: tokens } } };
}
function geminiOk(text, tokens = 100) {
  return { status: 200, headers: {}, body: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: tokens } } };
}
/** Scripted transport: returns queued responses in order, records requests. */
function transport(responses) {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    const r = responses.shift();
    if (!r) throw new Error('unexpected extra HTTP call');
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}
const router = (http, extra = {}) => new AiRouter({ http, sleep: noSleep, keys: KEYS, rand: () => 0.5, ...extra });

test('happy path returns text and reports no failover', async () => {
  const http = transport([groqOk('Hello')]);
  const r = await router(http).complete({ task: 'draft_email', user: 'hi' });
  assert.equal(r.text, 'Hello');
  assert.equal(r.provider, 'groq');
  assert.equal(r.failedOver, false);
  assert.deepEqual(r.warnings, []);
  assert.match(http.calls[0].url, /api\.groq\.com/);
});

test('retries a 500 on the same model before failing over', async () => {
  const http = transport([{ status: 500, headers: {}, body: 'boom' }, groqOk('recovered')]);
  const r = await router(http).complete({ task: 'draft_email', user: 'hi' });
  assert.equal(r.text, 'recovered');
  assert.equal(r.failedOver, false);
  assert.equal(http.calls.length, 2);
});

test('exhausting Groq fails over to Gemini and records W-AI-FAILOVER', async () => {
  const err = { status: 500, headers: {}, body: 'boom' };
  const http = transport([err, err, err, geminiOk('from gemini')]);
  const r = await router(http).complete({ task: 'draft_email', user: 'hi' });
  assert.equal(r.text, 'from gemini');
  assert.equal(r.provider, 'gemini');
  assert.equal(r.failedOver, true);
  assert.deepEqual(r.warnings, ['W-AI-FAILOVER'], 'degradation is never silent');
});

test('a bad API key is not retried — it fails over immediately', async () => {
  const http = transport([{ status: 401, headers: {}, body: 'bad key' }, geminiOk('ok')]);
  const r = await router(http).complete({ task: 'draft_email', user: 'hi' });
  assert.equal(r.provider, 'gemini');
  assert.equal(http.calls.length, 2, 'no wasted retries against a rejected key');
});

test('daily quota exhaustion parks instead of corrupting the row', async () => {
  const ledger = new QuotaLedger({}, () => 0);
  // Burn both models' daily token budgets.
  ledger.reserve('groq:llama-3.3-70b-versatile', MODELS['groq:llama-3.3-70b-versatile'].tpd);
  const http = transport([geminiOk('gemini saved it')]);
  const r = await router(http, { ledger }).complete({ task: 'draft_email', user: 'hi' });
  assert.equal(r.provider, 'gemini', 'spills to the co-primary rather than failing');
});

test('every provider exhausted raises E-QUOTA-ALL, which is a park not a data loss', async () => {
  const ledger = new QuotaLedger({}, () => 0);
  ledger.reserve('groq:llama-3.3-70b-versatile', MODELS['groq:llama-3.3-70b-versatile'].tpd);
  ledger.reserve('gemini:gemini-2.0-flash', 0);
  ledger.state['gemini:gemini-2.0-flash'].rpd = MODELS['gemini:gemini-2.0-flash'].rpd;
  const http = transport([]);
  await assert.rejects(
    () => router(http, { ledger }).complete({ task: 'draft_email', user: 'hi' }),
    (e) => e.code === 'E-QUOTA-ALL' && e.park === true
  );
  assert.equal(http.calls.length, 0, 'no request is even attempted when the budget is gone');
});

test('a 429 naming the daily limit is classified as a park, a plain 429 is a retry', async () => {
  const daily = transport([{ status: 429, headers: {}, body: 'Rate limit reached: tokens per day (TPD)' }, geminiOk('ok')]);
  const r1 = await router(daily).complete({ task: 'draft_email', user: 'hi' });
  assert.equal(r1.provider, 'gemini', 'daily exhaustion moves on rather than retrying into the same wall');

  const perMinute = transport([{ status: 429, headers: {}, body: 'Rate limit reached: requests per minute' }, groqOk('ok')]);
  const r2 = await router(perMinute).complete({ task: 'draft_email', user: 'hi' });
  assert.equal(r2.provider, 'groq', 'per-minute limits back off and retry the same model');
});

test('JSON mode: fenced JSON is extracted', async () => {
  const http = transport([groqOk('```json\n{"intent":"interested"}\n```')]);
  const r = await router(http).complete({ task: 'classify_reply', user: 'x', json: true });
  assert.deepEqual(r.json, { intent: 'interested' });
});

test('JSON mode: invalid JSON gets exactly one repair pass, then fails over', async () => {
  const http = transport([
    groqOk('sorry, here is prose'),   // first attempt, unparseable
    groqOk('still prose'),            // repair attempt on the same model
    geminiOk('{"intent":"declined"}'),
  ]);
  const r = await router(http).complete({ task: 'classify_reply', user: 'x', json: true });
  assert.deepEqual(r.json, { intent: 'declined' });
  assert.equal(r.provider, 'gemini');
});

test('schemaCheck rejection moves to the next model rather than returning junk', async () => {
  const http = transport([groqOk('{"wrong":"shape"}'), groqOk('{"wrong":"shape"}'), geminiOk('{"intent":"interested"}')]);
  const r = await router(http).complete({
    task: 'classify_reply', user: 'x', json: true,
    schemaCheck: (j) => (j && j.intent ? { ok: true } : { ok: false, reason: 'missing intent' }),
  });
  assert.equal(r.json.intent, 'interested');
});

test('Gemini safety refusal is typed, not swallowed', async () => {
  const http = transport([
    { status: 200, headers: {}, body: { candidates: [{ finishReason: 'SAFETY' }] } },
  ]);
  await assert.rejects(
    () => router(http, { routes: { t: ['gemini:gemini-2.0-flash'] } }).complete({ task: 't', user: 'x' }),
    (e) => e.code === 'E-LLM-REFUSAL'
  );
});

test('a missing API key skips that provider instead of crashing', async () => {
  const http = transport([geminiOk('ok')]);
  const r = await router(http, { keys: { gemini: 'ge' } }).complete({ task: 'draft_email', user: 'hi' });
  assert.equal(r.provider, 'gemini');
});

test('ledger self-corrects from x-ratelimit headers', () => {
  const ledger = new QuotaLedger({}, () => 0);
  ledger.applyHeaders('groq:llama-3.1-8b-instant', { 'x-ratelimit-limit-tokens': '6000', 'x-ratelimit-remaining-tokens': '1500' });
  assert.equal(ledger.snapshot()['groq:llama-3.1-8b-instant'].tpm, 4500);
});

test('forecast produces the throughput numbers the ETA panel shows', () => {
  const ledger = new QuotaLedger({}, () => 0);
  const f = ledger.forecast('groq:llama-3.3-70b-versatile', 3300);
  assert.equal(f.remainingToday, 30, '100000 TPD / 3300 per resume');
  assert.ok(Math.abs(f.itemsPerMinute - 12000 / 3300) < 1e-9);
});

test('window rollover clears the minute bucket but not the day bucket', () => {
  let t = 0;
  const ledger = new QuotaLedger({}, () => t);
  ledger.reserve('groq:llama-3.1-8b-instant', 5000);
  t = 61000;
  assert.equal(ledger.check('groq:llama-3.1-8b-instant', 5000).ok, true, 'new minute, fresh TPM');
  assert.equal(ledger.snapshot()['groq:llama-3.1-8b-instant'].tpd, 5000, 'daily total persists across minutes');
});

test('helpers', () => {
  assert.equal(estimateTokens('abcd'.repeat(100)), 100);
  assert.deepEqual(extractJson('noise {"a":{"b":1}} trailing'), { a: { b: 1 } });
  assert.equal(extractJson('no json here'), null);
  const b = backoffMs(2, 2000, 16000, () => 0.5);
  assert.ok(b >= 4000 && b <= 8000, `jittered backoff in range, got ${b}`);
});

test('a real failure is reported, not the trivial "next provider has no key"', async () => {
  const http = transport([groqOk('junk'), groqOk('still junk')]);
  await assert.rejects(
    () => router(http, { keys: { groq: 'gk' } }).complete({ task: 'draft_email', user: 'x', json: true }),
    (e) => e.code === 'E-LLM-SCHEMA',
    'the operator needs to know Groq returned bad JSON, not that Gemini is unconfigured'
  );
});

test('when nothing was actually attempted, the config problem is reported', async () => {
  await assert.rejects(
    () => router(transport([]), { keys: {} }).complete({ task: 'draft_email', user: 'x' }),
    (e) => e.code === 'E-CONFIG-MISSING'
  );
});
