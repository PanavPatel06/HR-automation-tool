import 'server-only';
import { google } from 'googleapis';
import { TABS, type TabName, type Row } from './contract';
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
      { applicant_id: 'APP-1001', created_at: ago(1 * DAY), name: 'Asha Menon', email: 'asha.menon@example.com', job_role: 'Frontend Engineer', category: 'Junior', source: 'form', stage: 'NEW', status: 'ok', updated_at: ago(1 * DAY) },
      { applicant_id: 'APP-1002', created_at: ago(2 * DAY), name: 'Ravi Kumar', email: 'ravi.kumar@example.com', job_role: 'Backend Engineer', category: 'Senior', source: 'form', stage: 'DRAFTED', status: 'ok', template_id: 'TPL-DEFAULT', email_subject: 'Your application for Backend Engineer at Your Company', email_html: '<p>Hi Ravi,</p><p>Thanks for applying for the Backend Engineer role. We were impressed by your background in distributed systems and would like to move forward.</p><p>Best regards,<br>HR Team</p>', updated_at: ago(20 * HOUR) },
      { applicant_id: 'APP-1003', created_at: ago(3 * DAY), name: 'Priya Shah', email: 'priya.shah@example.com', job_role: 'Product Designer', category: 'Mid', source: 'manual', stage: 'APPROVED', status: 'ok', template_id: 'TPL-DEFAULT', email_subject: 'Your application for Product Designer at Your Company', email_html: '<p>Hi Priya,</p><p>Thanks for applying for the Product Designer role. We would like to continue the conversation.</p><p>Best regards,<br>HR Team</p>', approved_by: 'dashboard', approved_at: ago(4 * HOUR), updated_at: ago(4 * HOUR) },
      { applicant_id: 'APP-1004', created_at: ago(5 * DAY), name: 'Karan Mehta', email: 'karan.mehta@example.com', job_role: 'Backend Engineer', category: 'Senior', source: 'form', stage: 'SENT', status: 'ok', template_id: 'TPL-DEFAULT', email_subject: 'Your application for Backend Engineer at Your Company', email_html: '<p>Hi Karan, …</p>', email_status: 'sent', sent_at: ago(2 * DAY), thread_id: 'thread-demo-1004', message_id: 'msg-demo-1004', updated_at: ago(2 * DAY) },
      { applicant_id: 'APP-1005', created_at: ago(6 * DAY), name: 'Neha Verma', email: 'neha.verma@example.com', job_role: 'Frontend Engineer', category: 'Junior', source: 'form', stage: 'REPLIED', status: 'ok', email_status: 'sent', sent_at: ago(3 * DAY), thread_id: 'thread-demo-1005', reply_state: 'interested', updated_at: ago(1 * HOUR) },
      { applicant_id: 'APP-1006', created_at: ago(30 * MIN), name: 'Not An Email', email: 'oops-at-example', job_role: 'Frontend Engineer', category: 'Junior', source: 'form', stage: 'NEW', status: 'blocked', error_code: 'E-VALIDATION', error_message: 'email does not look like a valid address', updated_at: ago(30 * MIN) },
      { applicant_id: 'APP-1007', created_at: ago(8 * DAY), name: 'Dev Patel', email: 'dev.patel@example.com', job_role: 'Product Designer', category: 'Mid', source: 'form', stage: 'FAILED', status: 'failed', error_code: 'E-LLM-EMPTY', error_message: 'Model returned an empty draft after 3 retries', correlation_id: 'run-demo-draft-9', updated_at: ago(7 * DAY) },
    ]); })(),

    Templates: (() => { n = 0; return rows('Templates', [
      { template_id: 'TPL-DEFAULT', name: 'Default outreach', subject: 'Your application for {{job_role}} at {{company_name}}', html: renderSkeleton(DEFAULT_TEMPLATE_BODY), source: 'seed', is_active: 'TRUE', is_default: 'TRUE', prompt_version: 'seed.v1', created_at: ago(30 * DAY), updated_at: ago(30 * DAY) },
      { template_id: 'TPL-FE-STATIC', name: 'Frontend follow-up (static)', job_role: 'Frontend Engineer', subject: 'Next steps for your Frontend Engineer application', html: renderSkeleton('<p style="margin:0 0 16px;">Hi {{first_name}},</p><p style="margin:0;">Thanks for your interest in the Frontend Engineer role. We will follow up within a week.</p><p style="margin:24px 0 0;">{{hr_signature}}</p>'), source: 'manual', is_active: 'TRUE', is_default: 'FALSE', created_at: ago(20 * DAY), updated_at: ago(20 * DAY) },
      { template_id: 'TPL-AI-DRAFT', name: 'AI draft — Designer outreach', job_role: 'Product Designer', subject: 'Your Product Designer application at {{company_name}}', html: renderSkeleton(DEFAULT_TEMPLATE_BODY), source: 'ai', is_active: 'FALSE', is_default: 'FALSE', prompt_version: 'template-gen.v1', created_at: ago(2 * HOUR), updated_at: ago(2 * HOUR) },
    ]); })(),

    JobRoles: (() => { n = 0; return rows('JobRoles', [
      { role_id: 'ROLE-1', title: 'Frontend Engineer', department: 'Engineering', is_open: 'TRUE', created_at: ago(60 * DAY) },
      { role_id: 'ROLE-2', title: 'Backend Engineer', department: 'Engineering', is_open: 'TRUE', created_at: ago(60 * DAY) },
      { role_id: 'ROLE-3', title: 'Product Designer', department: 'Design', is_open: 'TRUE', created_at: ago(45 * DAY) },
      { role_id: 'ROLE-4', title: 'Support Engineer', department: 'Engineering', is_open: 'FALSE', created_at: ago(90 * DAY) },
    ]); })(),

    EmailLog: (() => { n = 0; return rows('EmailLog', [
      { at: ago(2 * DAY), correlation_id: 'run-demo-send-1', applicant_id: 'APP-1004', to: 'karan.mehta@example.com', subject: 'Your application for Backend Engineer at Your Company', provider: 'gmail', result: 'sent', provider_message_id: 'msg-demo-1004', thread_id: 'thread-demo-1004', dry_run: 'false' },
      { at: ago(3 * DAY), correlation_id: 'run-demo-send-2', applicant_id: 'APP-1005', to: 'neha.verma@example.com', subject: 'Your application for Frontend Engineer at Your Company', provider: 'gmail', result: 'sent', provider_message_id: 'msg-demo-1005', thread_id: 'thread-demo-1005', dry_run: 'false' },
      { at: ago(7 * DAY), correlation_id: 'run-demo-send-0', applicant_id: 'APP-1007', to: 'dev.patel@example.com', subject: 'Your application for Product Designer at Your Company', provider: 'gmail', result: 'failed', error_code: 'E-GMAIL-BOUNCE', error_message: 'Recipient address rejected', dry_run: 'false' },
    ]); })(),

    Replies: (() => { n = 0; return rows('Replies', [
      { received_at: ago(1 * HOUR), applicant_id: 'APP-1005', thread_id: 'thread-demo-1005', from: 'neha.verma@example.com', subject: 'Re: Your application for Frontend Engineer at Your Company', snippet: 'Thanks so much — I would love to move forward, when works for a call?', classified_intent: 'interested', confidence: '0.94', model: 'groq/llama-3.1-8b-instant' },
      { received_at: ago(9 * HOUR), applicant_id: 'APP-1004', thread_id: 'thread-demo-1004', from: 'karan.mehta@example.com', subject: 'Re: Your application for Backend Engineer at Your Company', snippet: 'Out of office until the 24th, will respond after.', classified_intent: 'out_of_office', confidence: '0.88', model: 'groq/llama-3.1-8b-instant', handled_by: 'dashboard', handled_at: ago(8 * HOUR) },
      { received_at: ago(26 * HOUR), applicant_id: 'APP-1004', thread_id: 'thread-demo-1004b', from: 'karan.mehta@example.com', subject: 'Re: Your application for Backend Engineer at Your Company', snippet: "Hey — quick one, does this include the relocation stipend we discussed?", classified_intent: 'unclear', confidence: '0.42', model: 'groq/llama-3.1-8b-instant' },
    ]); })(),

    RunLog: (() => { n = 0; return rows('RunLog', [
      { started_at: ago(20 * HOUR), correlation_id: 'run-demo-draft-1', workflow: 'Draft', trigger: 'dashboard', finished_at: ago(20 * HOUR), items_in: '2', items_ok: '2', items_failed: '0', status: 'ok', notes: '2 drafted' },
      { started_at: ago(2 * DAY), correlation_id: 'run-demo-send-1', workflow: 'Send', trigger: 'dashboard', finished_at: ago(2 * DAY), items_in: '1', items_ok: '1', items_failed: '0', status: 'ok', notes: '1 sent' },
      { started_at: ago(7 * DAY), correlation_id: 'run-demo-draft-9', workflow: 'Draft', trigger: 'dashboard', finished_at: ago(7 * DAY), items_in: '3', items_ok: '2', items_failed: '1', status: 'partial', notes: '1 of 3 drafts failed — model returned empty content' },
    ]); })(),

    Errors: (() => { n = 0; return rows('Errors', [
      { at: ago(7 * DAY), correlation_id: 'run-demo-draft-9', applicant_id: 'APP-1007', workflow: 'Draft', node: 'Groq', error_code: 'E-LLM-EMPTY', error_message: 'Model returned an empty draft', severity: 'error', retryable: 'true', hint: 'Usually transient. Click Draft again; escalate if it repeats for the same applicant.', resolved: '' },
      { at: ago(30 * MIN), correlation_id: 'run-demo-intake', applicant_id: 'APP-1006', workflow: 'Intake', node: 'Validate row', error_code: 'E-VALIDATION', error_message: 'email does not look like a valid address', severity: 'warn', retryable: 'false', hint: 'Fix the email in the Applicants tab.', resolved: '' },
      { at: ago(9 * DAY), correlation_id: 'run-demo-send-old', applicant_id: 'APP-1007', workflow: 'Send', node: 'Gmail', error_code: 'E-GMAIL-BOUNCE', error_message: 'Recipient address rejected', severity: 'error', retryable: 'false', hint: 'Confirm the address with the candidate before retrying.', resolved: 'TRUE' },
    ]); })(),

    Quota: (() => { n = 0; return rows('Quota', [
      { provider: 'groq', model: 'llama-3.1-8b-instant', window: 'daily', requests_used: '46', tokens_used: '118400', requests_limit: '14400', tokens_limit: '500000', window_reset_at: ago(-1 * (24 * HOUR - 4 * HOUR)), updated_at: ago(20 * MIN) },
      { provider: 'gemini', model: 'gemini-1.5-flash', window: 'daily', requests_used: '3', tokens_used: '6200', requests_limit: '1500', tokens_limit: '1000000', window_reset_at: ago(-1 * (24 * HOUR - 4 * HOUR)), updated_at: ago(2 * HOUR) },
    ]); })(),

    Config: (() => { n = 0; return rows('Config', [
      { key: 'dry_run', value: 'true', type: 'boolean', description: 'When true, WF-03 logs sends instead of sending. Ship with this ON.', updated_at: ago(30 * DAY) },
      { key: 'toggle_intake', value: 'true', type: 'boolean', description: 'Master switch for WF-01 Intake.', updated_at: ago(30 * DAY) },
      { key: 'toggle_draft', value: 'true', type: 'boolean', description: 'Master switch for WF-02 Draft generation.', updated_at: ago(30 * DAY) },
      { key: 'toggle_send', value: 'false', type: 'boolean', description: 'Master switch for WF-03 Send. Off by default — turn on deliberately.', updated_at: ago(30 * DAY) },
      { key: 'toggle_replies', value: 'true', type: 'boolean', description: 'Master switch for WF-04 Reply watcher.', updated_at: ago(30 * DAY) },
      { key: 'toggle_followup', value: 'false', type: 'boolean', description: 'Master switch for WF-05 Follow-up drafting.', updated_at: ago(30 * DAY) },
      { key: 'categories', value: 'Intern,Junior,Mid,Senior,Lead', type: 'list', description: 'Allowed values for Applicants.category.', updated_at: ago(30 * DAY) },
      { key: 'batch_size', value: '10', type: 'number', description: 'Max applicants processed per draft batch.', updated_at: ago(30 * DAY) },
      { key: 'followup_days', value: '5', type: 'number', description: 'Days of silence before a follow-up is drafted.', updated_at: ago(30 * DAY) },
      { key: 'max_resume_mb', value: '10', type: 'number', description: 'Reject resumes larger than this.', updated_at: ago(30 * DAY) },
      { key: 'reply_confidence_min', value: '0.7', type: 'number', description: 'Below this, a reply is flagged needs_human.', updated_at: ago(30 * DAY) },
      { key: 'send_daily_cap', value: '400', type: 'number', description: 'Self-imposed cap, kept under the Gmail ~500/day ceiling.', updated_at: ago(30 * DAY) },
      { key: 'company_name', value: 'Your Company', type: 'string', description: 'Merge field {{company_name}}.', updated_at: ago(30 * DAY) },
      { key: 'hr_name', value: 'HR Team', type: 'string', description: 'Merge field {{hr_name}}.', updated_at: ago(30 * DAY) },
      { key: 'hr_signature', value: 'Best regards,<br>HR Team', type: 'string', description: 'Merge field {{hr_signature}}. HTML allowed.', updated_at: ago(30 * DAY) },
      { key: 'company_email', value: '3spacetechcorp@gmail.com', type: 'string', description: 'Merge field {{company_email}} — shown in the branded template header.', updated_at: ago(30 * DAY) },
      { key: 'company_phone', value: 'Tel: +91 63519 32850<br>+91 87809 97391', type: 'string', description: 'Merge field {{company_phone}}. HTML allowed.', updated_at: ago(30 * DAY) },
      { key: 'company_incubator', value: 'Incubated at<br>PDEU IIC, Gandhinagar', type: 'string', description: 'Merge field {{company_incubator}}. HTML allowed.', updated_at: ago(30 * DAY) },
    ]); })(),
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
