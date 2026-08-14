'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { signPayload, verifySignature, canonicalJson, parseConfig, chunk, fitCell, makeApplicantId, makeCorrelationId, CELL_LIMIT } = require('../n8n/src/lib/util');
const { validateHeaders, columnsFor, canTransition, CONFIG_DEFAULTS, V1_TABS } = require('../n8n/src/lib/schema');
const { AppError, toAppError, classifyProviderHttp, safeJson } = require('../n8n/src/lib/errors');

// --- webhook signing --------------------------------------------------------

test('a correctly signed payload verifies', () => {
  const body = { action: 'send', ids: ['APP-1'] };
  const ts = Math.floor(Date.now() / 1000);
  const { signature } = signPayload('secret', body, ts);
  assert.equal(verifySignature('secret', body, ts, signature).ok, true);
});

test('tampering with the body invalidates the signature', () => {
  const ts = Math.floor(Date.now() / 1000);
  const { signature } = signPayload('secret', { ids: ['APP-1'] }, ts);
  const r = verifySignature('secret', { ids: ['APP-1', 'APP-666'] }, ts, signature);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-signature');
});

test('a captured request cannot be replayed outside the tolerance window', () => {
  const body = { action: 'send' };
  const ts = Math.floor(Date.now() / 1000) - 3600;
  const { signature } = signPayload('secret', body, ts);
  assert.equal(verifySignature('secret', body, ts, signature).reason, 'stale-timestamp');
});

test('a wrong secret and a missing secret are both refused', () => {
  const ts = Math.floor(Date.now() / 1000);
  const { signature } = signPayload('secret', {}, ts);
  assert.equal(verifySignature('other', {}, ts, signature).ok, false);
  assert.equal(verifySignature('', {}, ts, signature).reason, 'no-secret-configured');
  assert.equal(verifySignature('secret', {}, ts, '').reason, 'missing-signature');
});

// --- config -----------------------------------------------------------------

test('config rows coerce to their declared types', () => {
  const cfg = parseConfig([
    { key: 'dry_run', value: 'TRUE', type: 'boolean' },
    { key: 'batch_size', value: '10', type: 'number' },
    { key: 'categories', value: 'Intern, Junior , Senior', type: 'list' },
    { key: 'weights', value: '{"a":1}', type: 'json' },
    { key: 'company_name', value: '3Space', type: 'string' },
    { key: '', value: 'ignored', type: 'string' },
  ]);
  assert.equal(cfg.dry_run, true);
  assert.equal(cfg.batch_size, 10);
  assert.deepEqual(cfg.categories, ['Intern', 'Junior', 'Senior']);
  assert.deepEqual(cfg.weights, { a: 1 });
  assert.equal(cfg.company_name, '3Space');
  assert.ok(!('' in cfg));
});

test('a malformed config cell degrades instead of taking the pipeline down', () => {
  const cfg = parseConfig([
    { key: 'weights', value: 'not json', type: 'json' },
    { key: 'batch_size', value: 'ten', type: 'number' },
  ]);
  assert.equal(cfg.weights, null);
  assert.equal(cfg.batch_size, 0);
});

test('every Config default declares a type that parses', () => {
  const cfg = parseConfig(CONFIG_DEFAULTS);
  assert.equal(cfg.dry_run, true, 'ships with dry-run ON');
  assert.equal(cfg.toggle_send, false, 'sending is off until deliberately enabled');
  assert.ok(Array.isArray(cfg.categories));
});

// --- sheet contract ---------------------------------------------------------

test('V1 sheets omit V2 columns but keep the same order', () => {
  const v1 = columnsFor('Applicants');
  const v2 = columnsFor('Applicants', { includeV2: true });
  assert.ok(!v1.includes('match_percent'));
  assert.ok(v2.includes('match_percent'));
  assert.deepEqual(v2.slice(0, v1.length), v1, 'V2 only appends — V1 column positions never move');
});

test('validateHeaders detects the drift that causes E-SHEET-SCHEMA', () => {
  const good = columnsFor('Applicants');
  assert.equal(validateHeaders('Applicants', good).ok, true);

  const missing = good.filter((c) => c !== 'thread_id');
  const r = validateHeaders('Applicants', missing);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['thread_id']);

  const extra = validateHeaders('Applicants', [...good, 'notes']);
  assert.equal(extra.ok, true, 'extra columns are reported but not fatal');
  assert.deepEqual(extra.extra, ['notes']);
});

test('every V1 tab has a resolvable column list', () => {
  for (const tab of V1_TABS) assert.ok(columnsFor(tab).length > 0, tab);
});

test('the stage machine refuses illegal jumps', () => {
  assert.equal(canTransition('NEW', 'DRAFTED'), true);
  assert.equal(canTransition('DRAFTED', 'APPROVED'), true);
  assert.equal(canTransition('APPROVED', 'SENT'), true);
  assert.equal(canTransition('NEW', 'SENT'), false, 'cannot send without drafting and approving');
  assert.equal(canTransition('DRAFTED', 'SENT'), false, 'approval is mandatory');
  assert.equal(canTransition('SENT', 'DRAFTED'), false);
  assert.equal(canTransition('FAILED', 'DRAFTED'), true, 'retry rolls back to the origin stage');
  assert.equal(canTransition(null, 'NEW'), true);
});

// --- errors -----------------------------------------------------------------

test('AppError carries retry semantics from the catalogue', () => {
  assert.equal(new AppError('E-QUOTA-TPD', 'x').park, true);
  assert.equal(new AppError('E-LLM-TIMEOUT', 'x').retryable, true);
  assert.equal(new AppError('E-INTAKE-EMAIL', 'x').retryable, false);
  assert.equal(new AppError('E-MAIL-AUTH', 'x').severity, 'fatal');
});

test('an unknown code degrades to E-UNKNOWN rather than throwing', () => {
  const e = new AppError('E-NOPE', 'mystery');
  assert.equal(e.code, 'E-UNKNOWN');
  assert.equal(e.message, 'mystery');
});

test('toAppError wraps anything, including strings', () => {
  assert.equal(toAppError('plain string').code, 'E-UNKNOWN');
  assert.equal(toAppError(new AppError('E-SHEET-429', 'x')).code, 'E-SHEET-429');
  assert.equal(toAppError(new Error('boom'), 'E-FETCH-NET').code, 'E-FETCH-NET');
});

test('provider HTTP statuses map to the right codes', () => {
  assert.equal(classifyProviderHttp(401, '').code, 'E-LLM-AUTH');
  assert.equal(classifyProviderHttp(429, 'tokens per day').code, 'E-QUOTA-TPD');
  assert.equal(classifyProviderHttp(429, 'requests per minute').code, 'E-QUOTA-RPM');
  assert.equal(classifyProviderHttp(503, '').code, 'E-LLM-SERVER');
});

test('candidate prose never reaches a log line', () => {
  const s = safeJson({ applicant_id: 'APP-1', email_html: '<p>Dear Asha…</p>', resume_text: 'long cv' });
  assert.match(s, /APP-1/);
  assert.ok(!s.includes('Dear Asha'), 'PII is redacted, ids are kept');
  assert.match(s, /redacted:/);
});

test('safeJson survives circular structures', () => {
  const a = {}; a.self = a;
  assert.equal(typeof safeJson(a), 'string');
});

// --- misc -------------------------------------------------------------------

test('ids are shaped for reading aloud and are unique', () => {
  assert.match(makeApplicantId(new Date('2026-08-14T00:00:00Z')), /^APP-20260814-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  assert.match(makeCorrelationId('WF-02', new Date('2026-08-14T10:20:30Z')), /^WF-02-20260814102030-[A-Z0-9]{4}$/);
  const ids = new Set(Array.from({ length: 500 }, () => makeApplicantId()));
  assert.ok(ids.size > 495, 'collisions are rare at this volume');
});

test('cell values are truncated visibly, never silently', () => {
  const long = 'x'.repeat(CELL_LIMIT + 500);
  const out = fitCell(long);
  assert.ok(out.length < long.length);
  assert.match(out, /truncated for sheet cell limit/);
  assert.equal(fitCell('short'), 'short');
  assert.equal(fitCell(null), '');
});

test('chunk splits batches and never returns an infinite loop on bad input', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([1, 2], 0), [[1], [2]]);
  assert.deepEqual(chunk([], 5), []);
});

test('signature survives JSON key reordering across the HTTP hop', () => {
  const ts = Math.floor(Date.now() / 1000);
  const sent = { action: 'send', ids: ['A', 'B'], nested: { z: 1, a: 2 } };
  const { signature } = signPayload('secret', sent, ts);
  // What n8n sees after parse/serialise may order keys differently.
  const received = { nested: { a: 2, z: 1 }, ids: ['A', 'B'], action: 'send' };
  assert.equal(verifySignature('secret', received, ts, signature).ok, true);
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson([1, { b: 1, a: 2 }]), '[1,{"a":2,"b":1}]');
});

test('array order still matters — reordering ids is tampering', () => {
  const ts = Math.floor(Date.now() / 1000);
  const { signature } = signPayload('secret', { ids: ['A', 'B'] }, ts);
  assert.equal(verifySignature('secret', { ids: ['B', 'A'] }, ts, signature).ok, false);
});
