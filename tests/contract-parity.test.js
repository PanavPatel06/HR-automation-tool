'use strict';
/**
 * The dashboard deploys from `dashboard/` alone and cannot import the n8n
 * library, so `dashboard/lib/contract.ts` duplicates the column contract.
 *
 * Duplication is only safe if it cannot drift silently. This test is what makes
 * it safe: if a column is added on one side and not the other, the build fails
 * here rather than at runtime as an E-SHEET-SCHEMA in production.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const { TABS, columnsFor, V1_TABS, STAGE, TRANSITIONS } = require('../n8n/src/lib/schema');
const { CONFIG_DEFAULTS } = require('../n8n/src/lib/schema');

const CONTRACT_TS = readFileSync(join(__dirname, '..', 'dashboard', 'lib', 'contract.ts'), 'utf8');

/** Pull `Name: ['a', 'b', …],` out of the TS source without a TS parser. */
function tabColumnsFromTs(tab) {
  const re = new RegExp(`${tab}:\\s*\\[([\\s\\S]*?)\\],\\n`, 'm');
  const m = CONTRACT_TS.match(re);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test('every V1 tab in the dashboard contract matches the n8n schema exactly', () => {
  for (const tab of V1_TABS) {
    const fromTs = tabColumnsFromTs(tab);
    assert.ok(fromTs, `dashboard/lib/contract.ts is missing the "${tab}" tab`);
    assert.deepEqual(
      fromTs,
      columnsFor(tab),
      `Column drift on "${tab}". Update dashboard/lib/contract.ts and n8n/src/lib/schema.js together.`,
    );
  }
});

test('the dashboard declares every V1 tab and no V2 ones', () => {
  // Scope to the TABS block — ACTIONABLE below it has the same key: [...] shape.
  const block = CONTRACT_TS.match(/export const TABS = \{([\s\S]*?)\n\} as const;/);
  assert.ok(block, 'TABS block not found in the dashboard contract');
  const declared = [...block[1].matchAll(/^\s{2}(\w+):\s*\[/gm)].map((m) => m[1]);
  assert.deepEqual(declared.sort(), [...V1_TABS].sort(), 'the dashboard must declare exactly the V1 tabs');
  assert.ok(!declared.includes('Analysis'), 'Analysis is a V2 tab and must not appear in the V1 dashboard');
});

test('the dashboard stage list matches the n8n stage machine', () => {
  const m = CONTRACT_TS.match(/export const STAGES = \[([\s\S]*?)\] as const/);
  assert.ok(m, 'STAGES not found in the dashboard contract');
  const dashboardStages = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);

  // V1 stages only; V2 adds PARSED/SCORED/SHORTLISTED/REJECTED.
  const v1Stages = ['NEW', 'DRAFTED', 'APPROVED', 'SENT', 'REPLIED', 'CLOSED', 'FAILED'];
  assert.deepEqual(dashboardStages, v1Stages);
  for (const s of dashboardStages) {
    assert.ok(Object.values(STAGE).includes(s), `dashboard stage "${s}" is not in the n8n stage machine`);
  }
});

test('dashboard bulk actions only permit stages the n8n machine allows', () => {
  const m = CONTRACT_TS.match(/export const ACTIONABLE[\s\S]*?\n\};/);
  assert.ok(m, 'ACTIONABLE not found in the dashboard contract');

  // approve: DRAFTED -> APPROVED must be legal; send: APPROVED -> SENT must be.
  assert.ok(TRANSITIONS.DRAFTED.includes('APPROVED'), 'DRAFTED -> APPROVED must stay legal');
  assert.ok(TRANSITIONS.APPROVED.includes('SENT'), 'APPROVED -> SENT must stay legal');
  assert.ok(!TRANSITIONS.DRAFTED.includes('SENT'), 'DRAFTED -> SENT must stay illegal — approval is mandatory');

  // The dashboard must not offer "send" on any stage the machine would refuse.
  const sendLine = m[0].match(/send:\s*\[([^\]]*)\]/);
  const sendStages = [...(sendLine ? sendLine[1] : '').matchAll(/'([^']+)'/g)].map((x) => x[1]);
  for (const s of sendStages) {
    assert.ok(TRANSITIONS[s]?.includes('SENT'), `dashboard offers "send" from stage ${s}, which n8n would refuse`);
  }
});

test('every toggle the dashboard shows exists as a Config default', () => {
  const keys = [...CONTRACT_TS.matchAll(/key:\s*'(toggle_\w+)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 5, 'expected at least the five workflow toggles');
  const known = new Set(CONFIG_DEFAULTS.map((d) => d.key));
  for (const k of keys) {
    assert.ok(known.has(k), `dashboard toggle "${k}" has no Config default — bootstrap would never create it`);
  }
});

test('the n8n schema has no duplicate column names within a tab', () => {
  for (const tab of Object.keys(TABS)) {
    const cols = columnsFor(tab, { includeV2: true });
    assert.equal(new Set(cols).size, cols.length, `duplicate column in "${tab}"`);
  }
});
