// @requires errors schema util runtime
//
// WF-90 catches anything no other handler did. Its own failure would be
// invisible, so it does the minimum possible work and never calls a model.

const trigger = $input.first().json || {};
const wf = trigger.workflow || {};
const exec = trigger.execution || {};
const lastNode = exec.lastNodeExecuted || '';
const message = (exec.error && (exec.error.message || exec.error.description)) || 'Unknown workflow failure';

// Recover a typed code if the thrower embedded one ("E-XXX-YYY: detail").
const codeMatch = String(message).match(/\b([EW]-[A-Z]+-[A-Z0-9]+)\b/);
const code = codeMatch ? codeMatch[1] : 'E-UNKNOWN';

const correlationId = newCorrelationId('WF-90');
const now = nowIso();

const error_rows = [{
  at: now,
  correlation_id: correlationId,
  applicant_id: '',
  workflow: wf.name || 'unknown',
  node: lastNode,
  error_code: code,
  error_message: String(message).slice(0, 900),
  severity: (ERROR_CATALOGUE[code] || {}).severity || 'error',
  retryable: String(Boolean((ERROR_CATALOGUE[code] || {}).retryable)),
  hint: (ERROR_CATALOGUE[code] || {}).hint || 'Open the execution in n8n for the full stack trace.',
  payload_json: safeJson({ execution_id: exec.id, execution_url: exec.url, mode: exec.mode }),
  retry_count: 0,
  resolved: 'FALSE',
}];

const runlog_rows = [{
  started_at: exec.startedAt || now,
  correlation_id: correlationId,
  workflow: wf.name || 'unknown',
  trigger: exec.mode || 'unknown',
  finished_at: now,
  items_in: 0, items_ok: 0, items_failed: 1,
  status: 'failed',
  notes: `${code} at node "${lastNode}" — ${String(message).slice(0, 200)}`,
}];

const severity = error_rows[0].severity;
return [{ json: {
  ok: false,
  error_rows,
  runlog_rows,
  // Drives the alert branch: only fatal problems are worth interrupting someone.
  should_alert: severity === 'fatal',
  alert_subject: `[HR automation] ${code} in ${wf.name || 'a workflow'}`,
  alert_body: [
    `Workflow: ${wf.name || 'unknown'}`,
    `Node: ${lastNode}`,
    `Code: ${code}`,
    `Message: ${String(message).slice(0, 500)}`,
    `Hint: ${error_rows[0].hint}`,
    exec.url ? `Execution: ${exec.url}` : '',
  ].filter(Boolean).join('\n'),
} }];
