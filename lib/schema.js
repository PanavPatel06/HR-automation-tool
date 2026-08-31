'use strict';
/**
 * The sheet contract. This file is the single source of truth for tab names,
 * column order, and the stage machine, read by scripts/bootstrap-sheets.mjs
 * and the tests in tests/. The dashboard deploys from `dashboard/` alone and
 * cannot import outside it, so `dashboard/lib/contract.ts` mirrors this file
 * by hand — tests/contract-parity.test.js is what keeps the two from drifting.
 *
 * V2 columns are declared here already (marked `v2: true`) but the bootstrap
 * only creates them when BOOTSTRAP_V2=true, so V1 sheets stay narrow.
 */

const STAGE = {
  NEW: 'NEW',
  DRAFTED: 'DRAFTED',
  APPROVED: 'APPROVED',
  SENT: 'SENT',
  REPLIED: 'REPLIED',
  CLOSED: 'CLOSED',
  FAILED: 'FAILED',
  // V2
  PARSED: 'PARSED',
  SCORED: 'SCORED',
  SHORTLISTED: 'SHORTLISTED',
  REJECTED: 'REJECTED',
};

const STATUS = { OK: 'ok', PENDING: 'pending', FAILED: 'failed', BLOCKED: 'blocked' };

/** Allowed forward transitions. FAILED can always roll back to its origin on retry. */
const TRANSITIONS = {
  NEW: ['DRAFTED', 'FAILED', 'PARSED', 'REJECTED'],
  PARSED: ['SCORED', 'FAILED'],
  SCORED: ['SHORTLISTED', 'REJECTED', 'DRAFTED', 'FAILED'],
  SHORTLISTED: ['DRAFTED', 'REJECTED', 'FAILED'],
  DRAFTED: ['APPROVED', 'DRAFTED', 'FAILED'],
  APPROVED: ['SENT', 'DRAFTED', 'FAILED'],
  SENT: ['REPLIED', 'CLOSED', 'FAILED'],
  REPLIED: ['CLOSED', 'DRAFTED', 'FAILED'],
  REJECTED: ['CLOSED'],
  CLOSED: [],
  FAILED: ['NEW', 'PARSED', 'SCORED', 'DRAFTED', 'APPROVED', 'SENT'],
};

function canTransition(from, to) {
  if (!from) return to === STAGE.NEW;
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

const TABS = {
  Applicants: [
    'applicant_id', 'created_at', 'name', 'email', 'phone', 'job_role', 'category',
    'resume_link', 'resume_file_id', 'source', 'stage', 'status',
    'template_id', 'email_subject', 'email_html', 'email_status', 'sent_at',
    'thread_id', 'message_id', 'reply_state', 'approved_by', 'approved_at',
    'error_code', 'error_message', 'correlation_id', 'updated_at',
    { name: 'resume_md_link', v2: true },
    { name: 'match_percent', v2: true },
    { name: 'match_verdict', v2: true },
    { name: 'scored_at', v2: true },
    { name: 'scoring_model', v2: true },
  ],
  Templates: [
    'template_id', 'name', 'job_role', 'category', 'stage', 'subject', 'html',
    'source', 'is_active', 'is_default', 'prompt_version', 'attachment_url',
    'attachment_name', 'created_at', 'updated_at',
  ],
  JobRoles: [
    'role_id', 'title', 'department', 'is_open', 'created_at',
    { name: 'jd_markdown', v2: true },
    { name: 'must_haves', v2: true },
    { name: 'nice_to_haves', v2: true },
    { name: 'weights_json', v2: true },
  ],
  EmailLog: [
    'at', 'correlation_id', 'applicant_id', 'to', 'subject', 'provider',
    'result', 'provider_message_id', 'thread_id', 'dry_run', 'error_code', 'error_message',
  ],
  Replies: [
    'received_at', 'applicant_id', 'thread_id', 'from', 'subject', 'snippet',
    'classified_intent', 'confidence', 'model', 'handled_by', 'handled_at',
  ],
  RunLog: [
    'started_at', 'correlation_id', 'workflow', 'trigger', 'finished_at',
    'items_in', 'items_ok', 'items_failed', 'status', 'notes',
  ],
  Errors: [
    'at', 'correlation_id', 'applicant_id', 'workflow', 'node', 'error_code',
    'error_message', 'severity', 'retryable', 'hint', 'payload_json', 'retry_count', 'resolved',
  ],
  Quota: [
    'provider', 'model', 'window', 'requests_used', 'tokens_used',
    'requests_limit', 'tokens_limit', 'window_reset_at', 'updated_at',
  ],
  Config: ['key', 'value', 'type', 'description', 'updated_at'],
  Analysis: [
    { name: 'applicant_id', v2: true }, { name: 'job_role', v2: true },
    { name: 'match_percent', v2: true }, { name: 'match_verdict', v2: true },
    { name: 'criteria_json', v2: true }, { name: 'strengths', v2: true },
    { name: 'gaps', v2: true }, { name: 'evidence_json', v2: true },
    { name: 'model', v2: true }, { name: 'prompt_version', v2: true },
    { name: 'scored_at', v2: true }, { name: 'raw_json', v2: true },
  ],
};

/** Tabs that exist in V1. Analysis is V2-only. */
const V1_TABS = ['Applicants', 'Templates', 'JobRoles', 'EmailLog', 'Replies', 'RunLog', 'Errors', 'Quota', 'Config'];

/** Resolve a tab's column names for the target version. */
function columnsFor(tab, { includeV2 = false } = {}) {
  const cols = TABS[tab];
  if (!cols) throw new Error(`Unknown tab: ${tab}`);
  return cols
    .filter((c) => (typeof c === 'string' ? true : includeV2 || !c.v2))
    .map((c) => (typeof c === 'string' ? c : c.name));
}

/**
 * Contract check. Runs in WF-00 Preflight and in CI, so a drifted sheet is
 * caught before a run rather than halfway through one.
 */
function validateHeaders(tab, actualHeaders, { includeV2 = false } = {}) {
  const expected = columnsFor(tab, { includeV2 });
  const actual = (actualHeaders || []).map((h) => String(h || '').trim());
  const missing = expected.filter((c) => !actual.includes(c));
  const extra = actual.filter((c) => c && !expected.includes(c));
  return { ok: missing.length === 0, missing, extra };
}

/** Defaults seeded into the Config tab. Everything runtime-tunable lives here. */
const CONFIG_DEFAULTS = [
  { key: 'dry_run', value: 'true', type: 'boolean', description: 'When true, WF-03 logs sends instead of sending. Ship with this ON.' },
  { key: 'toggle_draft', value: 'true', type: 'boolean', description: 'Master switch for the Draft action.' },
  { key: 'toggle_send', value: 'false', type: 'boolean', description: 'Master switch for the Send action. Off by default — turn on deliberately.' },
  { key: 'categories', value: 'Intern,Junior,Mid,Senior,Lead', type: 'list', description: 'Allowed values for Applicants.category.' },
  { key: 'batch_size', value: '10', type: 'number', description: 'Max applicants processed per draft batch.' },
  { key: 'followup_days', value: '5', type: 'number', description: 'Days of silence before a follow-up is drafted.' },
  { key: 'max_resume_mb', value: '10', type: 'number', description: 'Reject resumes larger than this.' },
  { key: 'reply_confidence_min', value: '0.7', type: 'number', description: 'Below this, a reply is flagged needs_human.' },
  { key: 'send_daily_cap', value: '400', type: 'number', description: 'Self-imposed cap, kept under the Gmail ~500/day ceiling.' },
  { key: 'company_name', value: '3Space', type: 'string', description: 'Merge field {{company_name}}. Appears in subjects and the template footer.' },
  { key: 'hr_name', value: 'HR Team', type: 'string', description: 'Merge field {{hr_name}}.' },
  { key: 'hr_signature', value: 'Best regards,<br>HR Team', type: 'string', description: 'Merge field {{hr_signature}}. HTML allowed.' },
  { key: 'company_email', value: '3spacetechcorp@gmail.com', type: 'string', description: 'Merge field {{company_email}} — shown in the branded template header.' },
  { key: 'company_phone', value: 'Tel: +91 63519 32850<br>+91 87809 97391', type: 'string', description: 'Merge field {{company_phone}}. HTML allowed.' },
  { key: 'company_incubator', value: 'Incubated at<br>PDEU IIC, Gandhinagar', type: 'string', description: 'Merge field {{company_incubator}}. HTML allowed.' },
  { key: 'company_logo_url', value: '', type: 'string', description: 'Merge field {{company_logo_url}}. Blank derives it from the deployment origin (<dashboard>/brand/logo.png). Set it only if the logo lives elsewhere — it must load without a login.' },
];

module.exports = { STAGE, STATUS, TRANSITIONS, canTransition, TABS, V1_TABS, columnsFor, validateHeaders, CONFIG_DEFAULTS };
