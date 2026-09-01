'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateHeaders, columnsFor, CONFIG_DEFAULTS, TAB_NAMES } = require('../lib/schema');

test('the columns a human types come first on Applicants', () => {
  // The sheet is maintained by hand. If the app ever pushes name/email/role
  // past the first screen, adding a candidate becomes a scrolling exercise.
  assert.deepEqual(
    columnsFor('Applicants').slice(0, 6),
    ['applicant_id', 'name', 'email', 'job_role', 'category', 'notes'],
  );
});

test('validateHeaders detects the drift that causes E-SHEET-SCHEMA', () => {
  const good = columnsFor('Applicants');
  assert.equal(validateHeaders('Applicants', good).ok, true);

  const missing = good.filter((c) => c !== 'job_role');
  const r = validateHeaders('Applicants', missing);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['job_role']);

  const extra = validateHeaders('Applicants', [...good, 'linkedin']);
  assert.equal(extra.ok, true, 'extra columns are reported but not fatal');
  assert.deepEqual(extra.extra, ['linkedin']);
});

test('every tab has a resolvable column list', () => {
  assert.equal(TAB_NAMES.length, 4, 'the sheet is deliberately four tabs');
  for (const tab of TAB_NAMES) assert.ok(columnsFor(tab).length > 0, tab);
});

test('every Config default has a key, value and type', () => {
  for (const d of CONFIG_DEFAULTS) {
    assert.ok(d.key, 'missing key');
    assert.ok(d.type, `${d.key} has no type`);
    assert.equal(typeof d.value, 'string', `${d.key} value must be a string`);
  }
});

test('sending ships off, and dry run ships on', () => {
  // These two are what stop a fresh deployment emailing real candidates before
  // anyone has looked at a message.
  const byKey = Object.fromEntries(CONFIG_DEFAULTS.map((d) => [d.key, d.value]));
  assert.equal(byKey.dry_run, 'true');
  assert.equal(byKey.toggle_send, 'false');
});

test('EmailLog can record both halves of a send attempt', () => {
  // It is the only audit trail — a row must be able to say what was sent, to
  // whom, whether it was real, and why it failed if it did.
  const cols = columnsFor('EmailLog');
  for (const c of ['at', 'to', 'subject', 'result', 'dry_run', 'error_code', 'error_message']) {
    assert.ok(cols.includes(c), `EmailLog is missing "${c}"`);
  }
});
