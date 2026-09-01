'use strict';
/**
 * Redundancy detection on the Applicants tab.
 *
 * A repeated applicant_id is the dangerous one: every action resolves a row
 * with `.find(a => a.applicant_id === id)`, so the second row is unreachable
 * and acting on it silently hits the first. This test is what stops that
 * detection quietly regressing.
 *
 * dashboard/lib/duplicates.ts is TypeScript with only erasable type syntax, so
 * Node's type stripping can import it directly — no build step, and the test
 * runs against the same source the app does rather than a copy.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = pathToFileURL(join(__dirname, '..', 'dashboard', 'lib', 'duplicates.ts')).href;

let row = 1;
const make = (applicant_id, email) => ({ applicant_id, email, _row: (row += 1) });

test('a clean sheet reports nothing', async () => {
  const { findDuplicates } = await import(MODULE);
  row = 1;
  assert.deepEqual(findDuplicates([make('APP-1', 'a@example.com'), make('APP-2', 'b@example.com')]), []);
});

test('a repeated applicant_id is caught, with the sheet rows that clash', async () => {
  const { findDuplicates } = await import(MODULE);
  row = 1;
  const found = findDuplicates([
    make('APP-1', 'a@example.com'),
    make('APP-2', 'b@example.com'),
    make('APP-1', 'c@example.com'),
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'applicant_id');
  assert.equal(found[0].value, 'APP-1');
  assert.deepEqual(found[0].rows.map((r) => r._row), [2, 4]);
});

test('a repeated email is caught regardless of case or padding', async () => {
  const { findDuplicates } = await import(MODULE);
  row = 1;
  const found = findDuplicates([
    make('APP-1', 'Asha@Example.com'),
    make('APP-2', '  asha@example.com '),
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'email');
  assert.equal(found[0].value, 'asha@example.com');
});

test('blank cells are not duplicates of each other', async () => {
  const { findDuplicates } = await import(MODULE);
  row = 1;
  // Three rows with no email yet is normal, not a redundancy problem.
  const found = findDuplicates([make('APP-1', ''), make('APP-2', ''), make('APP-3', '')]);
  assert.deepEqual(found, []);
});

test('rows with no applicant_id are ignored entirely', async () => {
  const { findDuplicates } = await import(MODULE);
  row = 1;
  // Trailing blank rows are invisible to the app, so they cannot clash.
  assert.deepEqual(findDuplicates([make('', 'x@example.com'), make('', 'x@example.com')]), []);
});

test('duplicateIds flags every row in every group', async () => {
  const { findDuplicates, duplicateIds } = await import(MODULE);
  row = 1;
  const rows = [make('APP-1', 'a@example.com'), make('APP-2', 'a@example.com'), make('APP-3', 'z@example.com')];
  const ids = duplicateIds(findDuplicates(rows));
  assert.ok(ids.has('APP-1') && ids.has('APP-2'));
  assert.ok(!ids.has('APP-3'), 'a unique row must not be flagged');
});
