#!/usr/bin/env node
/**
 * Creates or repairs the spreadsheet: every tab, every header, every Config
 * default. Idempotent by design — safe to re-run after any schema change, and
 * the fix for E-SHEET-SCHEMA.
 *
 *   npm run bootstrap:sheets              create/repair
 *   npm run bootstrap:sheets -- --check   report drift, change nothing
 *   npm run seed:demo                     add a default template and 3 applicants
 *
 * Requires SHEET_ID plus either GOOGLE_SERVICE_ACCOUNT_JSON (the key file
 * inline) or GOOGLE_APPLICATION_CREDENTIALS (a path to it).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { TAB_NAMES, columnsFor, validateHeaders, CONFIG_DEFAULTS } = require(join(ROOT, 'lib/schema.js'));

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const SEED = args.includes('--seed-demo');

const die = (msg, fix) => {
  console.error(`\n✖ ${msg}`);
  if (fix) console.error(`\n  Fix: ${fix}\n`);
  process.exit(1);
};

// Env, without a dotenv dependency. dashboard/.env.local is read too, so one
// file covers both the dashboard and these scripts — a root .env is optional
// and wins where the two overlap. Real environment variables beat both.
for (const envFile of [join(ROOT, '.env'), join(ROOT, '.env.local'), join(ROOT, 'dashboard', '.env.local')]) {
  if (!existsSync(envFile)) continue;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const SHEET_ID = process.env.SHEET_ID;
if (!SHEET_ID) die('SHEET_ID is not set.', 'Add SHEET_ID to dashboard/.env.local — it is the id in the spreadsheet URL, between /d/ and /edit.');

// Either form of the same credential: the key file on disk, or its contents
// inline (which is what the deployed dashboard uses, so most people already
// have it in dashboard/.env.local).
let credentials;
const CREDS_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const CREDS_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (CREDS_PATH && existsSync(CREDS_PATH)) {
  credentials = JSON.parse(readFileSync(CREDS_PATH, 'utf8'));
} else if (CREDS_JSON) {
  try {
    credentials = JSON.parse(CREDS_JSON);
  } catch {
    die('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.', 'Paste the whole key file on one line, in single quotes.');
  }
} else {
  die('No service-account credentials found.',
      'Set GOOGLE_SERVICE_ACCOUNT_JSON in dashboard/.env.local (the whole key file on one line, in single quotes), or GOOGLE_APPLICATION_CREDENTIALS to the key file\'s absolute path. See README.md § Deployment, step 1.');
}

let google;
try {
  ({ google } = await import('googleapis'));
} catch (_e) {
  die('The googleapis package is not installed.', 'Run: npm install');
}

const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

const serviceAccountEmail = credentials.client_email;

async function api(fn, what) {
  try {
    return await fn();
  } catch (err) {
    const status = err?.response?.status || err?.code;
    if (status === 403) {
      die(`Permission denied while ${what}.`,
          `Open the spreadsheet, click Share, and give Editor access to:\n       ${serviceAccountEmail}`);
    }
    if (status === 404) die(`Spreadsheet not found while ${what}.`, `Check SHEET_ID. Current value: ${SHEET_ID}`);
    if (status === 429) die(`Google Sheets rate limit hit while ${what}.`, 'Wait a minute and re-run.');
    die(`Failed while ${what}: ${err?.message || err}`);
  }
}

const wanted = TAB_NAMES;

const meta = await api(() => sheets.spreadsheets.get({ spreadsheetId: SHEET_ID }), 'reading the spreadsheet');
const existing = new Map(meta.data.sheets.map((s) => [s.properties.title, s.properties]));

const actions = [];
const drift = [];

// --- 1. create missing tabs -------------------------------------------------
const missingTabs = wanted.filter((t) => !existing.has(t));
if (missingTabs.length && !CHECK) {
  await api(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: missingTabs.map((title) => ({
        addSheet: { properties: { title, gridProperties: { rowCount: 1000, columnCount: 40, frozenRowCount: 1 } } },
      })),
    },
  }), 'creating tabs');
}
for (const t of missingTabs) (CHECK ? drift : actions).push(`tab "${t}" ${CHECK ? 'is missing' : 'created'}`);

// --- 2. write/repair headers ------------------------------------------------
for (const tab of wanted) {
  const expected = columnsFor(tab);
  const res = await api(
    () => sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!1:1` }),
    `reading headers of "${tab}"`
  ).catch(() => ({ data: {} }));

  const actual = (res.data?.values?.[0]) || [];
  const verdict = validateHeaders(tab, actual);

  if (actual.length === 0) {
    if (!CHECK) {
      await api(() => sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `${tab}!A1`, valueInputOption: 'RAW',
        requestBody: { values: [expected] },
      }), `writing headers to "${tab}"`);
    }
    (CHECK ? drift : actions).push(`"${tab}" headers ${CHECK ? 'are empty' : `written (${expected.length} columns)`}`);
  } else if (!verdict.ok) {
    // Append missing columns rather than rewriting the row: existing data is
    // positional, so reordering would silently corrupt every row.
    const repaired = [...actual];
    for (const col of verdict.missing) repaired.push(col);
    if (!CHECK) {
      await api(() => sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `${tab}!A1`, valueInputOption: 'RAW',
        requestBody: { values: [repaired] },
      }), `repairing headers of "${tab}"`);
    }
    (CHECK ? drift : actions).push(`"${tab}" ${CHECK ? 'is missing columns' : 'repaired'}: ${verdict.missing.join(', ')}`);
  }
  if (verdict.extra.length) actions.push(`"${tab}" has extra columns (left alone): ${verdict.extra.join(', ')}`);
}

// --- 3. seed Config defaults (never overwrite an existing value) ------------
const cfgRes = await api(
  () => sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Config!A:E' }),
  'reading Config'
).catch(() => ({ data: {} }));

const cfgRows = (cfgRes.data?.values || []).slice(1);
const haveKeys = new Set(cfgRows.map((r) => String(r[0] || '').trim()).filter(Boolean));
const missingCfg = CONFIG_DEFAULTS.filter((d) => !haveKeys.has(d.key));

if (missingCfg.length && !CHECK) {
  const now = new Date().toISOString();
  await api(() => sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: 'Config!A:E',
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: missingCfg.map((d) => [d.key, d.value, d.type, d.description, now]) },
  }), 'seeding Config defaults');
}
for (const d of missingCfg) (CHECK ? drift : actions).push(`Config key "${d.key}" ${CHECK ? 'is missing' : `added (= ${d.value})`}`);

// --- 4. optional demo data --------------------------------------------------
if (SEED && !CHECK) {
  const now = new Date().toISOString();

  // The branded shell (logo, contact header, footer) — mirrors
  // renderSkeleton()/TEMPLATE_SKELETON in dashboard/lib/template.ts. Can't
  // import that file directly: it's TypeScript marked 'server-only', and this
  // script runs as plain Node outside the dashboard's Next.js build, same
  // reason dashboard/lib/contract.ts mirrors lib/schema.js by hand.
  const logo = '<img src="{{company_logo_url}}" alt="{{company_name}}" width="150" style="display:block;border:0;outline:none;text-decoration:none;height:auto;">';
  const templateHtml = [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f4;padding:40px 0;font-family:Helvetica,Arial,sans-serif;">',
    '<tr><td align="center">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid #e6e4e0;">',
    '<tr><td style="height:3px;background-color:#0a0a0a;font-size:0;line-height:0;">&nbsp;</td></tr>',
    '<tr><td style="padding:30px 36px 22px 36px;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>',
    `<td valign="middle">${logo}</td>`,
    '<td valign="middle" align="right" style="font-size:10.5px;line-height:1.8;color:#8b8880;letter-spacing:0.02em;">{{company_email}}<br>{{company_phone}}<br>{{company_incubator}}</td>',
    '</tr></table>',
    '</td></tr>',
    '<tr><td style="padding:0 36px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid #0a0a0a;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>',
    '<tr><td style="padding:32px 36px;font-size:15px;line-height:1.75;color:#1a1a1a;">',
    '<p style="margin:0 0 18px;">Hi {{first_name}},</p>',
    '<p style="margin:0 0 16px;">Thanks for applying for the {{job_role}} role at {{company_name}}. We have your application and will be in touch shortly with next steps.</p>',
    '<p style="margin:26px 0 0;">{{hr_signature}}</p>',
    '</td></tr>',
    '<tr><td style="padding:18px 36px 26px 36px;border-top:1px solid #ededea;font-size:10px;line-height:1.7;letter-spacing:0.09em;text-transform:uppercase;color:#a8a49b;">{{company_name}} &middot; {{company_email}}</td></tr>',
    '</table>',
    '</td></tr>',
    '</table>',
  ].join('\n');

  // Column order must match TABS.Templates in lib/schema.js:
  // template_id, name, job_role, category, subject, html, source, is_active,
  // is_default, attachment_url, attachment_name, updated_at
  await api(() => sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: 'Templates!A:L', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        'TPL-DEFAULT', 'Default outreach', '', '',
        'Your application for {{job_role}} at {{company_name}}',
        templateHtml, 'seed', 'TRUE', 'TRUE', '', '', now,
      ]],
    },
  }), 'seeding Templates');

  // Only the columns a human ever types — the app fills in the rest.
  // Column order: applicant_id, name, email, job_role, category, notes.
  // One row is deliberately invalid, to show what preflight catches.
  await api(() => sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: 'Applicants!A:F', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [
        ['APP-DEMO-1', 'Asha Menon', 'asha.demo@example.com', 'Frontend Engineer', 'Junior', 'Strong React portfolio, referred by Meera'],
        ['APP-DEMO-2', 'Ravi Kumar', 'ravi.demo@example.com', 'Backend Engineer', 'Senior', 'Eight years on distributed systems'],
        ['APP-DEMO-3', 'Not An Email', 'oops-at-example', 'Frontend Engineer', 'Junior', 'Deliberately broken address'],
      ],
    },
  }), 'seeding demo applicants');

  actions.push('seeded 1 default template and 3 demo applicants (one with a deliberately invalid address)');
}

// --- report -----------------------------------------------------------------
console.log(`\nSpreadsheet: https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`);
console.log(`Service account: ${serviceAccountEmail}`);
console.log(`Mode: ${CHECK ? 'check (no writes)' : 'apply'}\n`);

if (CHECK) {
  if (!drift.length) { console.log('✔ Sheet matches the schema.\n'); process.exit(0); }
  console.error(`${drift.length} problem(s):\n`);
  for (const d of drift) console.error(`  ✖ ${d}`);
  console.error('\n  Fix: npm run bootstrap:sheets\n');
  process.exit(1);
}

if (!actions.length) console.log('✔ Nothing to do — the sheet is already correct.\n');
else { for (const a of actions) console.log(`  • ${a}`); console.log('\n✔ Done.\n'); }
