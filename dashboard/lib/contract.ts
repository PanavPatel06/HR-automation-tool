/**
 * The sheet contract, mirrored for the dashboard.
 *
 * This duplicates lib/schema.js on purpose: the dashboard deploys from the
 * `dashboard/` directory alone and cannot import from outside it.
 * `tests/contract-parity.test.js` at the repo root fails the build if the
 * two ever disagree, so the duplication cannot rot silently.
 */

export const TABS = {
  Applicants: [
    'applicant_id', 'name', 'email', 'job_role', 'category', 'notes',
    'last_subject', 'last_sent_at', 'created_at', 'updated_at',
  ],
  Templates: ['template_id', 'name', 'job_role', 'category', 'subject', 'html', 'source', 'is_active', 'is_default', 'attachment_url', 'attachment_name', 'updated_at'],
  EmailLog: ['at', 'applicant_id', 'to', 'subject', 'result', 'provider_message_id', 'dry_run', 'error_code', 'error_message'],
  Config: ['key', 'value', 'type', 'description', 'updated_at'],
} as const;

export type TabName = keyof typeof TABS;

export type Row = Record<string, string> & { _row: number };

/**
 * Config seed values, mirroring CONFIG_DEFAULTS in ../../lib/schema.js (again,
 * checked by tests/contract-parity.test.js). Used to seed the demo dataset so
 * exploring the app without a spreadsheet shows the real settings rather than
 * an invented set.
 */
export const CONFIG_DEFAULTS = [
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
] as const;

/** Master switches, shown on the Settings page. */
export const TOGGLES = [
  { key: 'toggle_ai', label: 'AI writing', description: 'Allows "Write with AI" and template generation. Spends model quota.' },
  { key: 'toggle_send', label: 'Sending', description: 'Allows sending. Off by default — turn it on deliberately.' },
] as const;

export function isTruthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  return ['true', 'yes', '1', 'y', 'on'].includes(String(v ?? '').trim().toLowerCase());
}
