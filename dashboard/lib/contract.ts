/**
 * The sheet contract, mirrored for the dashboard.
 *
 * This duplicates n8n/src/lib/schema.js on purpose: the dashboard deploys to
 * Vercel from the `dashboard/` directory alone and cannot import from outside
 * it. `tests/contract-parity.test.js` at the repo root fails the build if the
 * two ever disagree, so the duplication cannot rot silently.
 */

export const TABS = {
  Applicants: [
    'applicant_id', 'created_at', 'name', 'email', 'phone', 'job_role', 'category',
    'resume_link', 'resume_file_id', 'source', 'stage', 'status',
    'template_id', 'email_subject', 'email_html', 'email_status', 'sent_at',
    'thread_id', 'message_id', 'reply_state', 'approved_by', 'approved_at',
    'error_code', 'error_message', 'correlation_id', 'updated_at',
  ],
  Templates: ['template_id', 'name', 'job_role', 'category', 'stage', 'subject', 'html', 'source', 'is_active', 'is_default', 'prompt_version', 'created_at', 'updated_at'],
  JobRoles: ['role_id', 'title', 'department', 'is_open', 'created_at'],
  EmailLog: ['at', 'correlation_id', 'applicant_id', 'to', 'subject', 'provider', 'result', 'provider_message_id', 'thread_id', 'dry_run', 'error_code', 'error_message'],
  Replies: ['received_at', 'applicant_id', 'thread_id', 'from', 'subject', 'snippet', 'classified_intent', 'confidence', 'model', 'handled_by', 'handled_at'],
  RunLog: ['started_at', 'correlation_id', 'workflow', 'trigger', 'finished_at', 'items_in', 'items_ok', 'items_failed', 'status', 'notes'],
  Errors: ['at', 'correlation_id', 'applicant_id', 'workflow', 'node', 'error_code', 'error_message', 'severity', 'retryable', 'hint', 'payload_json', 'retry_count', 'resolved'],
  Quota: ['provider', 'model', 'window', 'requests_used', 'tokens_used', 'requests_limit', 'tokens_limit', 'window_reset_at', 'updated_at'],
  Config: ['key', 'value', 'type', 'description', 'updated_at'],
} as const;

export type TabName = keyof typeof TABS;

export type Row = Record<string, string> & { _row: number };

export const STAGES = ['NEW', 'DRAFTED', 'APPROVED', 'SENT', 'REPLIED', 'CLOSED', 'FAILED'] as const;
export type Stage = (typeof STAGES)[number];

/** Which stage a bulk action can legally act on — mirrors the n8n stage machine. */
export const ACTIONABLE: Record<string, Stage[]> = {
  draft: ['NEW', 'DRAFTED', 'FAILED'],
  approve: ['DRAFTED'],
  unapprove: ['APPROVED'],
  send: ['APPROVED'],
};

/** Workflow toggles, in the order they run. Drives the Settings grid. */
export const TOGGLES = [
  { key: 'toggle_intake', label: 'Intake', workflow: 'WF-01', description: 'Validates new rows in the Applicants tab every 2 minutes.' },
  { key: 'toggle_draft', label: 'Drafting', workflow: 'WF-02', description: 'Generates email drafts. The only workflow that spends model quota.' },
  { key: 'toggle_send', label: 'Sending', workflow: 'WF-03', description: 'Sends approved drafts. Off by default — turn it on deliberately.' },
  { key: 'toggle_replies', label: 'Reply watcher', workflow: 'WF-04', description: 'Polls the mailbox and classifies candidate replies.' },
  { key: 'toggle_followup', label: 'Follow-up flagging', workflow: 'WF-05', description: 'Flags silent candidates for review. Never sends anything.' },
] as const;

export const SEVERITY_ORDER = { fatal: 0, error: 1, warn: 2 } as const;

export function isTruthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  return ['true', 'yes', '1', 'y', 'on'].includes(String(v ?? '').trim().toLowerCase());
}
