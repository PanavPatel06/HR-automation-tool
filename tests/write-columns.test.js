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
  assert.ok(sites.length >= 6, `expected to find the write sites, found ${sites.length}`);

  for (const { fn, tab, keys } of sites) {
    assert.ok(TABS[tab], `${fn} writes to unknown tab "${tab}"`);
    const allowed = new Set([...columnsFor(tab, { includeV2: true }), '_row']);
    for (const key of keys) {
      assert.ok(
        allowed.has(key),
        `${fn}('${tab}', …) writes "${key}", which is not a column on ${tab}. `
        + `Valid: ${[...allowed].join(', ')}`,
      );
    }
  }
});

test('the reply path writes the columns it needs on every tab it touches', () => {
  // Guards the ad-hoc Inbox reply specifically: it is the newest write path,
  // and the one whose failure leaves an email sent with nothing recorded.
  const needed = {
    Applicants: ['template_id', 'email_subject', 'email_html', 'email_status', 'sent_at', 'thread_id', 'message_id', 'stage', 'updated_at'],
    EmailLog: ['at', 'correlation_id', 'applicant_id', 'to', 'subject', 'provider', 'result', 'provider_message_id', 'thread_id', 'dry_run'],
    Replies: ['handled_by', 'handled_at'],
  };
  for (const [tab, columns] of Object.entries(needed)) {
    const actual = columnsFor(tab, { includeV2: true });
    for (const column of columns) {
      assert.ok(actual.includes(column), `${tab} is missing "${column}", which the reply path writes`);
    }
  }
});
