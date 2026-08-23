'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateHeaders, columnsFor, canTransition, CONFIG_DEFAULTS, V1_TABS } = require('../lib/schema');

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

test('every Config default has a key, value and type', () => {
  for (const d of CONFIG_DEFAULTS) {
    assert.ok(d.key, 'missing key');
    assert.ok(d.type, `${d.key} has no type`);
    assert.equal(typeof d.value, 'string', `${d.key} value must be a string`);
  }
});

// --- stage machine -----------------------------------------------------------

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
