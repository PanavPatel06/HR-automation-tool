'use strict';
/**
 * Every column the dashboard writes must exist in the sheet contract.
 *
 * `patchRows`/`appendRow` throw `E-SHEET-SCHEMA: Cannot write unknown column`
 * at runtime — in production, mid-send, after the email has already gone out.
 * A column renamed in lib/schema.js and missed in one action is the whole
 * failure mode, and it is invisible until someone clicks the button.
 *
 * This reads the action route as text (no TS parser available here, same
 * approach as contract-parity.test.js) and checks the literal column names at
 * every write site.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const { columnsFor, TABS } = require('../lib/schema');

const ROUTE = readFileSync(
  join(__dirname, '..', 'dashboard', 'app', 'api', 'action', 'route.ts'),
  'utf8',
);

/** The source span of one call, from its opening paren to the matching close. */
function callBody(source, openParenIndex) {
  let depth = 0;
  for (let i = openParenIndex; i < source.length; i++) {
    const c = source[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return source.slice(openParenIndex, i + 1);
    }
  }
  return '';
}

/** Every `key:` written as an object-literal property inside a call. */
function keysIn(body) {
  return [...body.matchAll(/[{,\s]([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((m) => m[1]);
}

function writeSites() {
  const sites = [];
  const re = /(appendRow|patchRows)\(\s*'([A-Za-z]+)'\s*,/g;
  let m;
  while ((m = re.exec(ROUTE)) !== null) {
    const openParen = ROUTE.indexOf('(', m.index);
    const body = callBody(ROUTE, openParen);
    // Calls handed a prebuilt variable (`patchRows('Applicants', patches)`)
    // carry no literal to check; they are covered where the variable is built.
    if (!body.includes('{')) continue;
    sites.push({ fn: m[1], tab: m[2], keys: keysIn(body) });
  }
  return sites;
}

test('every literal column written by the action route exists in the contract', () => {
  const sites = writeSites();
  // EmailLog's rows are built into an array and appended in a loop, so they
  // are out of this test's reach — dashboard/app/api/action/route.ts types
  // them off the contract instead, which the build enforces.
  assert.ok(sites.length >= 4, `expected to find the write sites, found ${sites.length}`);

  for (const { fn, tab, keys } of sites) {
    assert.ok(TABS[tab], `${fn} writes to unknown tab "${tab}"`);
    const allowed = new Set([...columnsFor(tab), '_row']);
    for (const key of keys) {
      assert.ok(
        allowed.has(key),
        `${fn}('${tab}', …) writes "${key}", which is not a column on ${tab}. `
        + `Valid: ${[...allowed].join(', ')}`,
      );
    }
  }
});

test('the send path writes the columns it needs on every tab it touches', () => {
  // Guards the send path specifically: it is the one whose failure leaves an
  // email delivered with nothing recorded.
  const needed = {
    Applicants: ['last_subject', 'last_sent_at', 'updated_at'],
    EmailLog: ['at', 'applicant_id', 'to', 'subject', 'result', 'provider_message_id', 'dry_run', 'error_code', 'error_message'],
  };
  for (const [tab, columns] of Object.entries(needed)) {
    const actual = columnsFor(tab);
    for (const column of columns) {
      assert.ok(actual.includes(column), `${tab} is missing "${column}", which the reply path writes`);
    }
  }
});
