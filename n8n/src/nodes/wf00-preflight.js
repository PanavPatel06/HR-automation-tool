// @requires errors schema util ai-router runtime
//
// WF-00 Preflight. Most "mysterious" breakage is config drift, so this proves
// every dependency is reachable BEFORE a run needs it. Safe to run any time:
// it writes nothing and sends nothing.

const started = nowIso();
const correlationId = newCorrelationId('WF-00');

let env = {};
let envAccessible = true;
try { env = $env || {}; } catch (_e) { env = {}; envAccessible = false; }

const checks = [];
const add = (name, ok, detail, fix) => checks.push({ check: name, ok, detail: detail || '', fix: ok ? '' : (fix || '') });

// --- environment ------------------------------------------------------------
add('n8n can read environment variables', envAccessible,
  envAccessible ? 'ok' : '$env is blocked',
  'Set N8N_BLOCK_ENV_ACCESS_IN_NODE=false on the n8n container and restart.');

for (const key of ['SHEET_ID', 'N8N_WEBHOOK_SECRET', 'GROQ_API_KEY']) {
  add(`env.${key} is set`, Boolean(env[key]), env[key] ? 'present' : 'missing',
    `Add ${key} to n8n/.env and restart the container. See .env.example.`);
}
add('env.GEMINI_API_KEY is set (fallback provider)', Boolean(env.GEMINI_API_KEY),
  env.GEMINI_API_KEY ? 'present' : 'missing',
  'Without it there is no failover: a Groq outage stops drafting entirely.');

add('node:crypto is available', (() => { try { signPayload('x', {}, 1); return true; } catch (_e) { return false; } })(),
  '', 'Set NODE_FUNCTION_ALLOW_BUILTIN=crypto on the n8n container — webhook signatures cannot be verified without it.');

// --- Google Sheets ----------------------------------------------------------
let configRows = [];
try {
  configRows = rowsOf($('Read Config').all());
  add('Google Sheets credential works', true, `read ${configRows.length} Config row(s)`);
} catch (err) {
  add('Google Sheets credential works', false, String(err && err.message),
    'Share the spreadsheet with the service account email as Editor, and check SHEET_ID.');
}

const headers = configRows.length ? Object.keys(configRows[0]).filter((k) => k !== 'row_number') : [];
const headerCheck = validateHeaders('Config', headers);
add('Config tab headers match the contract', configRows.length === 0 ? false : headerCheck.ok,
  headerCheck.missing.length ? `missing: ${headerCheck.missing.join(', ')}` : 'ok',
  'Run `npm run bootstrap:sheets` to repair the headers.');

const config = parseConfig(configRows);
const missingKeys = CONFIG_DEFAULTS.map((d) => d.key).filter((k) => !(k in config));
add('All expected Config keys are present', missingKeys.length === 0,
  missingKeys.length ? `missing: ${missingKeys.join(', ')}` : 'ok',
  'Run `npm run bootstrap:sheets` — it adds missing keys without touching existing values.');

add('dry_run is ON', config.dry_run === true,
  config.dry_run === true ? 'no real emails will be sent' : 'REAL EMAILS WILL BE SENT',
  'This is only a warning. Set dry_run=false in Config when you are ready to send for real.');

// --- model providers --------------------------------------------------------
const http = makeHttp(this, { timeout: 20000 });
const ledger = new QuotaLedger({});

for (const [provider, routeKey] of [['groq', 'groq:llama-3.1-8b-instant'], ['gemini', 'gemini:gemini-2.0-flash']]) {
  if (!env[`${provider.toUpperCase()}_API_KEY`]) { add(`${provider} API reachable`, false, 'no key configured', `Set ${provider.toUpperCase()}_API_KEY.`); continue; }
  try {
    const router = new AiRouter({ http, keys: apiKeys(env), ledger, routes: { ping: [routeKey] }, maxAttemptsPerModel: 1 });
    const res = await router.complete({ task: 'ping', user: 'Reply with the single word: ok', maxTokens: 5, temperature: 0 });
    add(`${provider} API reachable`, true, `responded with ${res.tokens} token(s)`);
  } catch (err) {
    const e = toAppError(err);
    add(`${provider} API reachable`, false, `${e.code}: ${e.message}`, e.hint);
  }
}

const failedChecks = checks.filter((c) => !c.ok);
const fatal = failedChecks.filter((c) => !/dry_run|GEMINI/.test(c.check));

return [{ json: {
  ok: fatal.length === 0,
  workflow: 'WF-00 Preflight',
  correlation_id: correlationId,
  started_at: started,
  finished_at: nowIso(),
  status: fatal.length === 0 ? (failedChecks.length ? 'ok-with-warnings' : 'ok') : 'failed',
  passed: checks.length - failedChecks.length,
  total: checks.length,
  checks,
  summary: fatal.length === 0
    ? `All ${checks.length} checks passed${failedChecks.length ? ` (${failedChecks.length} warning(s))` : ''}.`
    : `${fatal.length} blocking problem(s): ${fatal.map((c) => c.check).join('; ')}`,
} }];
