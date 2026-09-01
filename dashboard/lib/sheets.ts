import 'server-only';
import { google } from 'googleapis';
import { TABS, CONFIG_DEFAULTS, type TabName, type Row } from './contract';
import { renderSkeleton, DEFAULT_TEMPLATE_BODY } from './template';

/**
 * Read/write access to the spreadsheet.
 *
 * Reads are the dashboard's whole data layer — there is no other database. If
 * the dashboard is down, HR can still work directly in the sheet, which is the
 * point of using Sheets as the source of truth.
 *
 * When SHEET_ID or GOOGLE_SERVICE_ACCOUNT_JSON is missing, every read/write
 * below falls through to an in-memory sample dataset instead of throwing, so
 * the dashboard is fully explorable with zero Google Cloud setup. It is
 * seeded once per server process and mutates in place — approve/toggle/etc.
 * behave like a real (if non-persistent) backend. Nothing here is reachable
 * once real credentials are set; see isDemoMode().
 */

export class SheetsError extends Error {
  code: string;
  hint: string;
  constructor(code: string, message: string, hint: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export function isDemoMode(): boolean {
  return !process.env.SHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
}

function credentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new SheetsError('E-CONFIG-MISSING', 'GOOGLE_SERVICE_ACCOUNT_JSON is not set.', 'Paste the service-account JSON into the dashboard environment. See dashboard/.env.example.');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new SheetsError('E-CONFIG-CRED', 'GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.', 'Paste the whole key file contents, including the outer braces.');
  }
}

function sheetId() {
  const id = process.env.SHEET_ID;
  if (!id) throw new SheetsError('E-CONFIG-MISSING', 'SHEET_ID is not set.', 'Add SHEET_ID to the dashboard environment.');
  return id;
}

async function client() {
  const creds = credentials();
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: creds.client_email, private_key: creds.private_key },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() as never });
}

function mapError(err: unknown, what: string): SheetsError {
  const status = (err as { response?: { status?: number }; code?: number })?.response?.status
    ?? (err as { code?: number })?.code;
  if (status === 403) return new SheetsError('E-SHEET-PERM', `Permission denied ${what}.`, 'Share the spreadsheet with the service account email as Editor.');
  if (status === 404) return new SheetsError('E-SHEET-PERM', `Spreadsheet not found ${what}.`, 'Check SHEET_ID in the dashboard environment.');
  if (status === 429) return new SheetsError('E-SHEET-429', `Google Sheets rate limit hit ${what}.`, 'Wait a moment and refresh. If it persists, reduce how often the dashboard is open.');
  return new SheetsError('E-UNKNOWN', `Failed ${what}: ${(err as Error)?.message ?? String(err)}`, 'Check the Vercel function logs for the full error.');
}

// --- demo dataset ------------------------------------------------------------
//
// Seeded lazily on first access (not at module load) so its relative
// timestamps — "4 minutes ago", "this morning" — stay fresh no matter when
// the dev server was started. Config values mirror ../lib/schema.js's real
// CONFIG_DEFAULTS rather than inventing settings that don't exist.

let demoStore: Record<TabName, Row[]> | null = null;

function blankRow(tab: TabName): Record<string, string> {
  return Object.fromEntries((TABS[tab] as readonly string[]).map((c) => [c, '']));
}

function buildDemoStore(): Record<TabName, Row[]> {
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

  let n = 0;
  const rows = <T extends TabName>(tab: T, list: Array<Partial<Record<(typeof TABS)[T][number], string>>>): Row[] =>
    list.map((overrides) => ({ ...blankRow(tab), ...overrides, _row: (n += 1) + 1 } as unknown as Row));

  const store = {
    Applicants: (() => { n = 0; return rows('Applicants', [
      { applicant_id: 'APP-1001', name: 'Asha Menon', email: 'asha.menon@example.com', job_role: 'Frontend Engineer', category: 'Junior', notes: 'Strong React portfolio, no TypeScript yet. Referred by Meera.', stage: 'NEW', created_at: ago(1 * DAY), updated_at: ago(1 * DAY) },
      { applicant_id: 'APP-1002', name: 'Ravi Kumar', email: 'ravi.kumar@example.com', job_role: 'Backend Engineer', category: 'Senior', notes: 'Eight years on distributed systems; wants to lead a team.', stage: 'DRAFTED', template_id: 'TPL-DEFAULT', email_subject: 'Your application for Backend Engineer at 3Space', email_html: '<p>Hi Ravi,</p><p>Thanks for applying for the Backend Engineer role. We were impressed by your background in distributed systems and would like to move forward.</p><p>Best regards,<br>HR Team</p>', created_at: ago(2 * DAY), updated_at: ago(20 * HOUR) },
      { applicant_id: 'APP-1003', name: 'Priya Shah', email: 'priya.shah@example.com', job_role: 'Product Designer', category: 'Mid', notes: 'Portfolio is mostly B2B dashboards \u2014 good fit.', stage: 'APPROVED', template_id: 'TPL-DEFAULT', email_subject: 'Your application for Product Designer at 3Space', email_html: '<p>Hi Priya,</p><p>Thanks for applying for the Product Designer role. We would like to continue the conversation.</p><p>Best regards,<br>HR Team</p>', created_at: ago(3 * DAY), updated_at: ago(4 * HOUR) },
      { applicant_id: 'APP-1004', name: 'Karan Mehta', email: 'karan.mehta@example.com', job_role: 'Backend Engineer', category: 'Senior', stage: 'SENT', template_id: 'TPL-DEFAULT', email_subject: 'Your application for Backend Engineer at 3Space', email_html: '<p>Hi Karan,</p><p>Thanks for applying — we would like to set up a call this week.</p>', sent_at: ago(2 * DAY), created_at: ago(5 * DAY), updated_at: ago(2 * DAY) },
      { applicant_id: 'APP-1005', name: 'Neha Verma', email: 'neha.verma@example.com', job_role: 'Frontend Engineer', category: 'Junior', stage: 'REPLIED', email_subject: 'Your application for Frontend Engineer at 3Space', email_html: '<p>Hi Neha,</p><p>Thanks for applying for the Frontend Engineer role.</p>', sent_at: ago(3 * DAY), created_at: ago(6 * DAY), updated_at: ago(1 * HOUR) },
      { applicant_id: 'APP-1006', name: 'Not An Email', email: 'oops-at-example', job_role: 'Frontend Engineer', category: 'Junior', stage: 'NEW', error_code: 'E-VALIDATION', error_message: 'email does not look like a valid address', created_at: ago(30 * MIN), updated_at: ago(30 * MIN) },
      { applicant_id: 'APP-1007', name: 'Dev Patel', email: 'dev.patel@example.com', job_role: 'Product Designer', category: 'Mid', stage: 'FAILED', error_code: 'E-LLM-EMPTY', error_message: 'Model returned an empty draft after 3 retries', created_at: ago(8 * DAY), updated_at: ago(7 * DAY) },
    ]); })(),

    Templates: (() => { n = 0; return rows('Templates', [
      { template_id: 'TPL-DEFAULT', name: 'Default outreach', subject: 'Your application for {{job_role}} at {{company_name}}', html: renderSkeleton(DEFAULT_TEMPLATE_BODY), source: 'seed', is_active: 'TRUE', is_default: 'TRUE', updated_at: ago(30 * DAY) },
      { template_id: 'TPL-FE-STATIC', name: 'Frontend follow-up (static)', job_role: 'Frontend Engineer', subject: 'Next steps for your Frontend Engineer application', html: renderSkeleton('<p style="margin:0 0 16px;">Hi {{first_name}},</p><p style="margin:0;">Thanks for your interest in the Frontend Engineer role. We will follow up within a week.</p><p style="margin:24px 0 0;">{{hr_signature}}</p>'), source: 'manual', is_active: 'TRUE', is_default: 'FALSE', updated_at: ago(20 * DAY) },
      { template_id: 'TPL-AI-DRAFT', name: 'AI draft \u2014 Designer outreach', job_role: 'Product Designer', subject: 'Your Product Designer application at {{company_name}}', html: renderSkeleton(DEFAULT_TEMPLATE_BODY), source: 'ai', is_active: 'FALSE', is_default: 'FALSE', updated_at: ago(2 * HOUR) },
    ]); })(),

    EmailLog: (() => { n = 0; return rows('EmailLog', [
      { at: ago(2 * DAY), applicant_id: 'APP-1004', to: 'karan.mehta@example.com', subject: 'Your application for Backend Engineer at 3Space', result: 'sent', provider_message_id: 'demo-msg-1004', dry_run: 'false' },
      { at: ago(3 * DAY), applicant_id: 'APP-1005', to: 'neha.verma@example.com', subject: 'Your application for Frontend Engineer at 3Space', result: 'sent', provider_message_id: 'demo-msg-1005', dry_run: 'false' },
      { at: ago(7 * DAY), applicant_id: 'APP-1007', to: 'dev.patel@example.com', subject: 'Your application for Product Designer at 3Space', result: 'failed', error_code: 'E-MAIL-DOMAIN', error_message: 'The domain is not verified on this Resend account', dry_run: 'false' },
    ]); })(),

    Config: (() => { n = 0; return rows('Config', CONFIG_DEFAULTS.map((c) => ({ ...c, updated_at: ago(30 * DAY) }))); })(),
  } as Record<TabName, Row[]>;

  return store;
}

function demoDb(): Record<TabName, Row[]> {
  if (!demoStore) demoStore = buildDemoStore();
  return demoStore;
}

// --- reads / writes ----------------------------------------------------------

/**
 * Read a tab as objects. `_row` is the 1-based sheet row, needed for writes.
 * A missing/empty tab returns [] rather than throwing — an empty Errors tab is
 * the normal, happy case.
 */
export async function readTab(tab: TabName): Promise<Row[]> {
  if (isDemoMode()) return demoDb()[tab].map((r) => ({ ...r }));

  let res;
  try {
    const api = await client();
    res = await api.spreadsheets.values.get({ spreadsheetId: sheetId(), range: `${tab}!A:AZ` });
  } catch (err) {
    throw mapError(err, `reading the "${tab}" tab`);
  }

  const values = res.data.values ?? [];
  if (values.length === 0) return [];

  const headers = (values[0] ?? []).map((h) => String(h ?? '').trim());
  const expected = TABS[tab] as readonly string[];
  const missing = expected.filter((c) => !headers.includes(c));
  if (missing.length) {
    throw new SheetsError('E-SHEET-SCHEMA', `The "${tab}" tab is missing column(s): ${missing.join(', ')}.`, 'Run `npm run bootstrap:sheets` from the repo root to repair the headers.');
  }

  return values.slice(1).map((cells, i) => {
    const row: Record<string, string> = {};
    headers.forEach((h, c) => { if (h) row[h] = String(cells[c] ?? ''); });
    return { ...row, _row: i + 2 } as Row;
  }).filter((r) => Object.entries(r).some(([k, v]) => k !== '_row' && v !== ''));
}

/** Read several tabs at once. One slow tab should not serialise the others. */
export async function readTabs<T extends TabName>(tabs: T[]): Promise<Record<T, Row[]>> {
  const results = await Promise.all(tabs.map((t) => readTab(t)));
  return Object.fromEntries(tabs.map((t, i) => [t, results[i]])) as Record<T, Row[]>;
}

/** A cell-level patch: the target row, plus the columns to overwrite. */
export type Patch = { _row: number; [column: string]: string | number };

/**
 * Patch specific cells on specific rows. Only the named columns are written, so
 * a concurrent write to a different column (e.g. from someone editing the
 * sheet directly) is never clobbered.
 */
export async function patchRows(tab: TabName, patches: Patch[]): Promise<number> {
  if (!patches.length) return 0;

  const headers = TABS[tab] as readonly string[];

  if (isDemoMode()) {
    const db = demoDb()[tab];
    for (const patch of patches) {
      const target = db.find((r) => r._row === patch._row);
      if (!target) continue;
      for (const [key, value] of Object.entries(patch)) {
        if (key === '_row') continue;
        if (!headers.includes(key)) throw new SheetsError('E-SHEET-SCHEMA', `Cannot write unknown column "${key}" on "${tab}".`, 'This is a bug — the column is not in the contract.');
        (target as unknown as Record<string, string>)[key] = String(value);
      }
    }
    return patches.length;
  }

  const colLetter = (i: number) => {
    let s = '', n = i + 1;
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };

  const data: Array<{ range: string; values: string[][] }> = [];
  for (const patch of patches) {
    for (const [key, value] of Object.entries(patch)) {
      if (key === '_row') continue;
      const idx = headers.indexOf(key);
      if (idx === -1) throw new SheetsError('E-SHEET-SCHEMA', `Cannot write unknown column "${key}" on "${tab}".`, 'This is a bug — the column is not in the contract.');
      data.push({ range: `${tab}!${colLetter(idx)}${patch._row}`, values: [[String(value)]] });
    }
  }

  try {
    const api = await client();
    await api.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId(),
      requestBody: { valueInputOption: 'USER_ENTERED', data },
    });
  } catch (err) {
    throw mapError(err, `updating ${patches.length} row(s) in "${tab}"`);
  }
  return patches.length;
}

/**
 * Append a brand-new row to a tab — real Sheets `values.append` in real mode,
 * an in-memory push in demo mode. Unlike patchRows, this creates a row rather
 * than editing one: an AI-generated template, an EmailLog entry, or a
 * manually started Inbox conversation. Bulk applicant intake still happens
 * by adding rows to the sheet directly (by hand or via a Google Form) — see
 * README.md#known-limitations.
 */
export async function appendRow(tab: TabName, fields: Record<string, string>): Promise<Row> {
  const headers = TABS[tab] as readonly string[];
  for (const key of Object.keys(fields)) {
    if (!headers.includes(key)) throw new SheetsError('E-SHEET-SCHEMA', `Cannot write unknown column "${key}" on "${tab}".`, 'This is a bug — the column is not in the contract.');
  }

  if (isDemoMode()) {
    const db = demoDb()[tab];
    const nextRow = (db.at(-1)?._row ?? 1) + 1;
    const row = { ...blankRow(tab), ...fields, _row: nextRow } as unknown as Row;
    db.push(row);
    return row;
  }

  try {
    const api = await client();
    const res = await api.spreadsheets.values.append({
      spreadsheetId: sheetId(),
      range: `${tab}!A:A`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [headers.map((h) => fields[h] ?? '')] },
    });
    const rowNum = Number(res.data.updates?.updatedRange?.match(/(\d+)(?::|$)/)?.[1]) || 0;
    return { ...blankRow(tab), ...fields, _row: rowNum } as unknown as Row;
  } catch (err) {
    throw mapError(err, `appending a row to "${tab}"`);
  }
}

/** Set a Config key. Used by the toggle switches. */
export async function setConfig(key: string, value: string): Promise<void> {
  const rows = await readTab('Config');
  const row = rows.find((r) => r.key === key);
  if (!row) throw new SheetsError('E-CONFIG-MISSING', `Config key "${key}" does not exist.`, 'Run `npm run bootstrap:sheets` to add missing keys.');
  await patchRows('Config', [{ _row: row._row, value, updated_at: new Date().toISOString() }]);
}

/** Config rows as a typed object, matching parseConfig() in ../lib/schema.js's callers. */
export function parseConfig(rows: Row[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const key = String(r.key ?? '').trim();
    if (!key) continue;
    const raw = r.value ?? '';
    switch (String(r.type ?? 'string').toLowerCase()) {
      case 'boolean': out[key] = ['true', 'yes', '1', 'y', 'on'].includes(raw.trim().toLowerCase()); break;
      case 'number': { const n = Number(raw); out[key] = Number.isFinite(n) ? n : 0; break; }
      case 'list': out[key] = raw.split(',').map((s) => s.trim()).filter(Boolean); break;
      case 'json': try { out[key] = JSON.parse(raw); } catch { out[key] = null; } break;
      default: out[key] = raw;
    }
  }
  return out;
}
