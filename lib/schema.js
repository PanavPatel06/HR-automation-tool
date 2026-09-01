'use strict';
/**
 * The sheet contract. This file is the single source of truth for tab names
 * and column order, read by scripts/bootstrap-sheets.mjs and the tests in
 * tests/. The dashboard deploys from `dashboard/` alone and cannot import
 * outside it, so `dashboard/lib/contract.ts` mirrors this file by hand —
 * tests/contract-parity.test.js is what keeps the two from drifting.
 *
 * Four tabs, and no pipeline. The app does one thing: read people out of the
 * sheet, help you write to them, and send it. There is no stage machine, no
 * draft/approve cycle, and no per-row workflow state — a candidate row is just
 * the facts about a person plus a note of when you last wrote to them.
 */

const TABS = {
  // Everything you type is on the left; the app only ever writes the last
  // four. `notes` is free text handed to the model as extra context — "met at
  // the PDEU fair", "strong on React, weak on backend" — which is the cheapest
  // way to make a generated email specific.
  Applicants: [
    'applicant_id', 'name', 'email', 'job_role', 'category', 'notes',
    'last_subject', 'last_sent_at', 'created_at', 'updated_at',
  ],
  Templates: [
    'template_id', 'name', 'job_role', 'category', 'subject', 'html',
    'source', 'is_active', 'is_default', 'attachment_url', 'attachment_name', 'updated_at',
  ],
  EmailLog: [
    'at', 'applicant_id', 'to', 'subject', 'result',
    'provider_message_id', 'dry_run', 'error_code', 'error_message',
  ],
  Config: ['key', 'value', 'type', 'description', 'updated_at'],
};

const TAB_NAMES = ['Applicants', 'Templates', 'EmailLog', 'Config'];

/** Resolve a tab's column names. */
function columnsFor(tab) {
  const cols = TABS[tab];
  if (!cols) throw new Error(`Unknown tab: ${tab}`);
  return cols.slice();
}

/**
 * Contract check. Runs in Preflight and in CI, so a drifted sheet is caught
 * before a run rather than halfway through one.
 */
function validateHeaders(tab, actualHeaders) {
  const expected = columnsFor(tab);
  const actual = (actualHeaders || []).map((h) => String(h || '').trim());
  const missing = expected.filter((c) => !actual.includes(c));
  const extra = actual.filter((c) => c && !expected.includes(c));
  return { ok: missing.length === 0, missing, extra };
}

/** Defaults seeded into the Config tab. Everything runtime-tunable lives here. */
const CONFIG_DEFAULTS = [
  { key: 'dry_run', value: 'true', type: 'boolean', description: 'When true, sends are logged to EmailLog instead of delivered. Ship with this ON.' },
  { key: 'toggle_send', value: 'false', type: 'boolean', description: 'Master switch for sending. Off by default — turn on deliberately.' },
  { key: 'toggle_ai', value: 'true', type: 'boolean', description: 'Master switch for the AI writing actions. Off means templates only, and no model quota is spent.' },
  { key: 'categories', value: 'Intern,Junior,Mid,Senior,Lead', type: 'list', description: 'Suggested values for Applicants.category.' },
  { key: 'send_daily_cap', value: '100', type: 'number', description: "Self-imposed daily cap. Resend's free tier allows 100 emails/day, 3,000/month — raise this only if you upgrade the plan." },
  { key: 'company_name', value: '3Space', type: 'string', description: 'Merge field {{company_name}}. Appears in subjects and the template footer.' },
  { key: 'hr_name', value: 'HR Team', type: 'string', description: 'Merge field {{hr_name}}.' },
  { key: 'hr_signature', value: 'Best regards,<br>HR Team', type: 'string', description: 'Merge field {{hr_signature}}. HTML allowed.' },
  { key: 'company_email', value: '3spacetechcorp@gmail.com', type: 'string', description: 'Merge field {{company_email}} — shown in the branded template header, and used as the Reply-To on every email so candidates reply to a mailbox you read.' },
  { key: 'company_phone', value: 'Tel: +91 63519 32850<br>+91 87809 97391', type: 'string', description: 'Merge field {{company_phone}}. HTML allowed.' },
  { key: 'company_incubator', value: 'Incubated at<br>PDEU IIC, Gandhinagar', type: 'string', description: 'Merge field {{company_incubator}}. HTML allowed.' },
  { key: 'company_logo_url', value: '', type: 'string', description: 'Merge field {{company_logo_url}}. Blank derives it from the deployment origin (<dashboard>/brand/logo.png). Set it only if the logo lives elsewhere — it must load without a login.' },
];

module.exports = { TABS, TAB_NAMES, columnsFor, validateHeaders, CONFIG_DEFAULTS };
