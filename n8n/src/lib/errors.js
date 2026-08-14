'use strict';
/**
 * Typed error catalogue. See docs/error-codes.md (canonical prose copy).
 *
 * Every failure in this system carries one of these codes. `retryable` drives
 * the queue behaviour: transient errors back off and retry, permanent errors go
 * straight to a human. `park` means "not a failure at all — stop and resume
 * later", used for exhausted daily quotas.
 */

const SEVERITY = { WARN: 'warn', ERROR: 'error', FATAL: 'fatal' };

const ERROR_CATALOGUE = {
  // --- Intake: bad input from the form or a human typing in the sheet -------
  'E-INTAKE-MISSING': { retryable: false, severity: SEVERITY.ERROR, hint: 'A required field is empty. Fix the row in the Applicants sheet and set status to blank to reprocess.' },
  'E-INTAKE-EMAIL':   { retryable: false, severity: SEVERITY.ERROR, hint: 'Email address is not parseable. Correct it in the sheet.' },
  'E-INTAKE-ROLE':    { retryable: false, severity: SEVERITY.ERROR, hint: 'job_role does not match any row in the JobRoles tab. Add the role or correct the spelling.' },
  'E-INTAKE-DUPE':    { retryable: false, severity: SEVERITY.WARN,  hint: 'This email already has an application for this role. Delete the duplicate row or change the role.' },
  'E-INTAKE-CATEGORY':{ retryable: false, severity: SEVERITY.ERROR, hint: 'category is not one of the configured values. See the Config tab, key "categories".' },

  // --- Resume retrieval ----------------------------------------------------
  'E-FETCH-404':  { retryable: false, severity: SEVERITY.ERROR, hint: 'Resume link is dead. Ask the candidate to resubmit.' },
  'E-FETCH-PERM': { retryable: false, severity: SEVERITY.ERROR, hint: 'Drive file is not shared with the service account. Share the folder with the service account email.' },
  'E-FETCH-SIZE': { retryable: false, severity: SEVERITY.ERROR, hint: 'Resume exceeds the size limit in Config (max_resume_mb).' },
  'E-FETCH-TYPE': { retryable: false, severity: SEVERITY.ERROR, hint: 'Unsupported file type. Accepted: pdf, doc, docx, txt, md.' },
  'E-FETCH-NET':  { retryable: true,  severity: SEVERITY.ERROR, hint: 'Network failure while downloading. Will retry.' },

  // --- Model layer ---------------------------------------------------------
  'E-LLM-TIMEOUT': { retryable: true,  severity: SEVERITY.ERROR, hint: 'Model did not respond in time. Will retry, then fail over to the backup provider.' },
  'E-LLM-SCHEMA':  { retryable: false, severity: SEVERITY.ERROR, hint: 'Model returned invalid JSON twice, including a repair attempt. Check the prompt version in prompts/.' },
  'E-LLM-REFUSAL': { retryable: false, severity: SEVERITY.ERROR, hint: 'Model declined to answer. Usually a prompt problem, not a data problem.' },
  'E-LLM-EMPTY':   { retryable: true,  severity: SEVERITY.ERROR, hint: 'Model returned an empty response. Will retry.' },
  'E-LLM-AUTH':    { retryable: false, severity: SEVERITY.FATAL,  hint: 'API key rejected. Check GROQ_API_KEY / GEMINI_API_KEY in the n8n environment.' },
  'E-LLM-SERVER':  { retryable: true,  severity: SEVERITY.ERROR, hint: 'Provider returned 5xx. Will retry, then fail over.' },

  // --- Rate limits. E-QUOTA-TPD is a park, not a failure. ------------------
  'E-QUOTA-RPM': { retryable: true,  severity: SEVERITY.WARN,  hint: 'Per-minute limit hit. Backing off.' },
  'E-QUOTA-TPD': { retryable: true,  severity: SEVERITY.WARN,  park: true, hint: 'Daily token budget exhausted for this model. Work parks and resumes at the window reset.' },
  'E-QUOTA-ALL': { retryable: true,  severity: SEVERITY.FATAL, park: true, hint: 'Every configured provider is exhausted. Nothing is lost — the queue resumes at the next window reset.' },

  // --- Sending -------------------------------------------------------------
  'E-MAIL-AUTH':     { retryable: false, severity: SEVERITY.FATAL, hint: 'Gmail OAuth credential expired. Reconnect it in n8n > Credentials.' },
  'E-MAIL-BOUNCE':   { retryable: false, severity: SEVERITY.ERROR, hint: 'Address rejected by the mail server. Correct it in the sheet.' },
  'E-MAIL-LIMIT':    { retryable: true,  severity: SEVERITY.WARN,  park: true, hint: 'Daily Gmail send cap reached (~500/day on consumer accounts). Remaining sends resume tomorrow.' },
  'E-MAIL-TEMPLATE': { retryable: false, severity: SEVERITY.ERROR, hint: 'Template still contains unresolved {{merge_fields}}. Nothing was sent.' },
  'E-MAIL-NODRAFT':  { retryable: false, severity: SEVERITY.ERROR, hint: 'Send was requested for a row with no approved draft. Generate and approve a draft first.' },

  // --- Google Sheets -------------------------------------------------------
  'E-SHEET-429':    { retryable: true,  severity: SEVERITY.WARN,  hint: 'Sheets API rate limit. Backing off.' },
  'E-SHEET-PERM':   { retryable: false, severity: SEVERITY.FATAL, hint: 'Spreadsheet is not shared with the service account (needs Editor).' },
  'E-SHEET-SCHEMA': { retryable: false, severity: SEVERITY.FATAL, hint: 'Expected column is missing. Run `npm run bootstrap:sheets` to repair the headers.' },

  // --- Setup / config ------------------------------------------------------
  'E-CONFIG-MISSING': { retryable: false, severity: SEVERITY.FATAL, hint: 'A required environment variable is not set. See .env.example.' },
  'E-CONFIG-CRED':    { retryable: false, severity: SEVERITY.FATAL, hint: 'A credential is invalid or unreachable. Run WF-00 Preflight for a full report.' },

  // --- Warnings: recorded, never fatal ------------------------------------
  'W-AI-FAILOVER':      { retryable: false, severity: SEVERITY.WARN, hint: 'Primary provider failed; the backup served this request. Recorded for audit.' },
  'W-TEMPLATE-DEFAULT': { retryable: false, severity: SEVERITY.WARN, hint: 'No role-specific template matched; the default template was used.' },
  'W-REPLY-LOWCONF':    { retryable: false, severity: SEVERITY.WARN, hint: 'Reply intent classified with low confidence. Flagged for a human.' },
  'E-UNKNOWN':          { retryable: false, severity: SEVERITY.ERROR, hint: 'Unclassified failure. The raw message is in the Errors tab.' },
};

class AppError extends Error {
  /**
   * @param {string} code   a key of ERROR_CATALOGUE
   * @param {string} message one-line, human-readable, safe to show in the dashboard
   * @param {object} [details] structured context; never include resume text or PII
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AppError';
    const meta = ERROR_CATALOGUE[code] || ERROR_CATALOGUE['E-UNKNOWN'];
    this.code = ERROR_CATALOGUE[code] ? code : 'E-UNKNOWN';
    this.retryable = meta.retryable;
    this.severity = meta.severity;
    this.park = meta.park === true;
    this.hint = meta.hint;
    this.details = details;
  }

  /** Flat shape written to the Errors / Applicants tabs. */
  toRow() {
    return {
      error_code: this.code,
      error_message: this.message,
      severity: this.severity,
      retryable: this.retryable,
      hint: this.hint,
      details_json: safeJson(this.details),
    };
  }
}

/** Wrap anything thrown — including non-Error values — into an AppError. */
function toAppError(err, fallbackCode = 'E-UNKNOWN') {
  if (err instanceof AppError) return err;
  if (err && err.code && ERROR_CATALOGUE[err.code]) {
    return new AppError(err.code, err.message || String(err), err.details || {});
  }
  const message = err && err.message ? err.message : String(err);
  return new AppError(fallbackCode, message, {});
}

function isRetryable(code) {
  const meta = ERROR_CATALOGUE[code];
  return meta ? meta.retryable === true : false;
}

function isPark(code) {
  const meta = ERROR_CATALOGUE[code];
  return meta ? meta.park === true : false;
}

/**
 * Map an HTTP failure from an AI provider onto the catalogue.
 * Kept separate from the router so it can be unit-tested against real statuses.
 */
function classifyProviderHttp(status, body) {
  const text = typeof body === 'string' ? body : safeJson(body);
  if (status === 401 || status === 403) return new AppError('E-LLM-AUTH', `Provider rejected the API key (HTTP ${status}).`, { status });
  if (status === 429) {
    // Groq distinguishes daily from per-minute exhaustion only in the message body.
    const daily = /per day|daily|TPD|RPD/i.test(text || '');
    return new AppError(daily ? 'E-QUOTA-TPD' : 'E-QUOTA-RPM', `Rate limited (HTTP 429)${daily ? ' — daily budget' : ''}.`, { status });
  }
  if (status >= 500) return new AppError('E-LLM-SERVER', `Provider error (HTTP ${status}).`, { status });
  return new AppError('E-UNKNOWN', `Unexpected provider response (HTTP ${status}).`, { status });
}

/** JSON.stringify that never throws and never returns undefined. */
function safeJson(value, maxLen = 4000) {
  try {
    const s = JSON.stringify(value, replacerDropPii);
    if (s === undefined) return '';
    return s.length > maxLen ? s.slice(0, maxLen) + '…[truncated]' : s;
  } catch (_e) {
    return '"[unserialisable]"';
  }
}

/** Defence in depth: candidate prose must never reach a log line. */
const PII_KEYS = new Set(['resume_text', 'resume_md', 'email_html', 'body', 'html', 'snippet']);
function replacerDropPii(key, value) {
  if (PII_KEYS.has(key) && typeof value === 'string') return `[redacted:${value.length}chars]`;
  return value;
}

module.exports = { AppError, ERROR_CATALOGUE, SEVERITY, toAppError, isRetryable, isPark, classifyProviderHttp, safeJson };
