import 'server-only';
import { google } from 'googleapis';
import { TABS, type TabName, type Row } from './contract';

/**
 * Read/write access to the spreadsheet.
 *
 * Reads are the dashboard's whole data layer — there is no other database. If
 * the dashboard is down, HR can still work directly in the sheet, which is the
 * point of using Sheets as the source of truth.
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

/**
 * Read a tab as objects. `_row` is the 1-based sheet row, needed for writes.
 * A missing/empty tab returns [] rather than throwing — an empty Errors tab is
 * the normal, happy case.
 */
export async function readTab(tab: TabName): Promise<Row[]> {
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
 * a concurrent n8n write to a different column is never clobbered.
 */
export async function patchRows(tab: TabName, patches: Patch[]): Promise<number> {
  if (!patches.length) return 0;

  const headers = TABS[tab] as readonly string[];
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

/** Set a Config key. Used by the toggle switches. */
export async function setConfig(key: string, value: string): Promise<void> {
  const rows = await readTab('Config');
  const row = rows.find((r) => r.key === key);
  if (!row) throw new SheetsError('E-CONFIG-MISSING', `Config key "${key}" does not exist.`, 'Run `npm run bootstrap:sheets` to add missing keys.');
  await patchRows('Config', [{ _row: row._row, value, updated_at: new Date().toISOString() }]);
}

/** Config rows as a typed object, matching parseConfig() in the n8n library. */
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
