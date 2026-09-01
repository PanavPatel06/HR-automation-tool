'use strict';
/**
 * The dashboard deploys from `dashboard/` alone and cannot import outside it,
 * so `dashboard/lib/contract.ts` duplicates lib/schema.js's column contract and
 * its Config defaults.
 *
 * Duplication is only safe if it cannot drift silently. This test is what makes
 * it safe: if a column is added on one side and not the other, the build fails
 * here rather than at runtime as an E-SHEET-SCHEMA in production.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const { TABS, columnsFor, TAB_NAMES, CONFIG_DEFAULTS } = require('../lib/schema');

const CONTRACT_TS = readFileSync(join(__dirname, '..', 'dashboard', 'lib', 'contract.ts'), 'utf8');

/** Pull `Name: ['a', 'b', …],` out of the TS source without a TS parser. */
function tabColumnsFromTs(tab) {
  const re = new RegExp(`${tab}:\\s*\\[([\\s\\S]*?)\\],\\n`, 'm');
  const m = CONTRACT_TS.match(re);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test('every tab in the dashboard contract matches lib/schema.js exactly', () => {
  for (const tab of TAB_NAMES) {
    const fromTs = tabColumnsFromTs(tab);
    assert.ok(fromTs, `dashboard/lib/contract.ts is missing the "${tab}" tab`);
    assert.deepEqual(
      fromTs,
      columnsFor(tab),
      `Column drift on "${tab}". Update dashboard/lib/contract.ts and lib/schema.js together.`,
    );
  }
});

test('the dashboard declares exactly the four tabs and no others', () => {
  const block = CONTRACT_TS.match(/export const TABS = \{([\s\S]*?)\n\} as const;/);
  assert.ok(block, 'TABS block not found in the dashboard contract');
  const declared = [...block[1].matchAll(/^\s{2}(\w+):\s*\[/gm)].map((m) => m[1]);
  assert.deepEqual(declared.sort(), [...TAB_NAMES].sort(), 'the dashboard must declare exactly the tabs in lib/schema.js');
});

test('the dashboard CONFIG_DEFAULTS mirror lib/schema.js key for key', () => {
  // The demo dataset is seeded from the dashboard copy, so a drifted key here
  // means exploring the app shows settings a real sheet would never have.
  const block = CONTRACT_TS.match(/export const CONFIG_DEFAULTS = \[([\s\S]*?)\n\] as const;/);
  assert.ok(block, 'CONFIG_DEFAULTS not found in the dashboard contract');
  const keys = [...block[1].matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(keys, CONFIG_DEFAULTS.map((d) => d.key), 'Config key drift between lib/schema.js and dashboard/lib/contract.ts');

  const values = [...block[1].matchAll(/value:\s*'([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(values, CONFIG_DEFAULTS.map((d) => d.value), 'Config default values drifted between the two files');
});

test('every toggle the dashboard shows exists as a Config default', () => {
  const block = CONTRACT_TS.match(/export const TOGGLES = \[([\s\S]*?)\n\] as const;/);
  assert.ok(block, 'TOGGLES not found in the dashboard contract');
  const keys = [...block[1].matchAll(/key:\s*'(\w+)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 2, 'expected at least the AI and Sending switches');
  const known = new Set(CONFIG_DEFAULTS.map((d) => d.key));
  for (const k of keys) {
    assert.ok(known.has(k), `dashboard toggle "${k}" has no Config default — bootstrap would never create it`);
  }
});

test('lib/schema.js has no duplicate column names within a tab', () => {
  for (const tab of Object.keys(TABS)) {
    const cols = columnsFor(tab);
    assert.equal(new Set(cols).size, cols.length, `duplicate column in "${tab}"`);
  }
});
