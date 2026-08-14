'use strict';
/**
 * Intake validation and normalisation (WF-01).
 *
 * Deliberately pure: no I/O, no clock, no randomness unless injected. Every
 * rejection produces a typed code, never a silent drop — a blocked row is
 * visible in the dashboard with a reason attached.
 */

const { AppError } = require('./errors');
const { STAGE, STATUS } = require('./schema');

/**
 * Pragmatic email check. Deliberately not RFC 5322: the goal is to catch typos
 * and empty cells, not to litigate quoted local parts. Anything that passes
 * here still has to survive the mail server.
 */
const EMAIL_RE = /^[^\s@,;:<>()[\]\\]+@[^\s@.]+(\.[^\s@.]+)+$/;

function normaliseEmail(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase();
}

function isValidEmail(raw) {
  const e = normaliseEmail(raw);
  return e.length > 0 && e.length <= 254 && EMAIL_RE.test(e);
}

function normaliseName(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
}

/** Keep digits and a single leading +; blank rather than guess. */
function normalisePhone(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  const plus = s.startsWith('+') ? '+' : '';
  const digits = s.replace(/\D/g, '');
  return digits ? plus + digits : '';
}

/** Case- and whitespace-insensitive key for matching roles and categories. */
function slug(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');
}

/**
 * Pull a Google Drive file ID out of the many link shapes Drive hands out.
 * Returns '' for non-Drive URLs — those are fetched over plain HTTP instead.
 */
function extractDriveFileId(url) {
  const s = String(url == null ? '' : url).trim();
  if (!s) return '';
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]{10,})/,      // /file/d/<id>/view
    /[?&]id=([a-zA-Z0-9_-]{10,})/,          // ?id=<id>
    /\/document\/d\/([a-zA-Z0-9_-]{10,})/,  // Docs
    /\/open\?id=([a-zA-Z0-9_-]{10,})/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return '';
}

function isHttpUrl(url) {
  const s = String(url == null ? '' : url).trim();
  return /^https?:\/\/[^\s]+$/i.test(s);
}

/** Deterministic dedupe key: one application per person per role. */
function dedupeKey(email, jobRole) {
  return `${normaliseEmail(email)}::${slug(jobRole)}`;
}

/**
 * Validate and normalise one raw intake row.
 *
 * @param {object} raw            row as read from the sheet or form webhook
 * @param {object} ctx
 * @param {string[]} ctx.roles        titles from the JobRoles tab
 * @param {string[]} ctx.categories   allowed categories from Config
 * @param {Set<string>} [ctx.seen]    dedupe keys already present
 * @param {string} ctx.correlationId
 * @param {string} ctx.applicantId    pre-minted id (injected, so this stays pure)
 * @param {string} ctx.now            ISO timestamp (injected)
 * @returns {{ok: true, row: object} | {ok: false, error: AppError, row: object}}
 */
function validateIntake(raw, ctx) {
  const { roles = [], categories = [], seen = new Set(), correlationId = '', applicantId = '', now = '' } = ctx || {};

  const name = normaliseName(raw.name);
  const email = normaliseEmail(raw.email);
  const jobRole = normaliseName(raw.job_role);
  const category = normaliseName(raw.category);
  const resumeLink = String(raw.resume_link == null ? '' : raw.resume_link).trim();

  const base = {
    applicant_id: raw.applicant_id || applicantId,
    created_at: raw.created_at || now,
    name,
    email,
    phone: normalisePhone(raw.phone),
    job_role: jobRole,
    category,
    resume_link: resumeLink,
    resume_file_id: extractDriveFileId(resumeLink),
    source: raw.source || 'manual',
    stage: STAGE.NEW,
    status: STATUS.OK,
    email_status: 'none',
    reply_state: 'none',
    error_code: '',
    error_message: '',
    correlation_id: correlationId,
    updated_at: now,
  };

  const fail = (code, message, details) => ({
    ok: false,
    error: new AppError(code, message, details),
    row: { ...base, stage: STAGE.NEW, status: STATUS.BLOCKED },
  });

  // Order matters: report the most actionable problem first.
  const missing = [];
  if (!name) missing.push('name');
  if (!email) missing.push('email');
  if (!jobRole) missing.push('job_role');
  if (missing.length) {
    return fail('E-INTAKE-MISSING', `Required field(s) empty: ${missing.join(', ')}.`, { missing });
  }

  if (!isValidEmail(email)) {
    return fail('E-INTAKE-EMAIL', `"${email}" is not a valid email address.`, {});
  }

  if (roles.length) {
    const match = roles.find((r) => slug(r) === slug(jobRole));
    if (!match) {
      return fail('E-INTAKE-ROLE', `Job role "${jobRole}" is not in the JobRoles tab.`, { known: roles.slice(0, 20) });
    }
    base.job_role = match; // snap to canonical casing so grouping is exact
  }

  if (category && categories.length) {
    const match = categories.find((c) => slug(c) === slug(category));
    if (!match) {
      return fail('E-INTAKE-CATEGORY', `Category "${category}" is not allowed. Allowed: ${categories.join(', ')}.`, { categories });
    }
    base.category = match;
  }

  if (resumeLink && !isHttpUrl(resumeLink)) {
    return fail('E-FETCH-TYPE', `resume_link is not an http(s) URL: "${resumeLink.slice(0, 80)}".`, {});
  }

  const key = dedupeKey(base.email, base.job_role);
  if (seen.has(key)) {
    return fail('E-INTAKE-DUPE', `${base.email} already has an application for "${base.job_role}".`, { key });
  }

  return { ok: true, row: base, key };
}

module.exports = {
  EMAIL_RE, normaliseEmail, isValidEmail, normaliseName, normalisePhone, slug,
  extractDriveFileId, isHttpUrl, dedupeKey, validateIntake,
};
