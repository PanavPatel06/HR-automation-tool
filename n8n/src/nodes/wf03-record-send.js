// @requires errors schema util intake template pipeline runtime
//
// WF-03 Send, recording half. Gmail emits exactly one output item per input
// item and preserves order (it runs with onError=continueRegularOutput), so
// results pair with `Emit Sends` by index.

const correlationId = (() => {
  try { return $('Plan Sends').first().json.correlation_id || newCorrelationId('WF-03'); } catch (_e) { return newCorrelationId('WF-03'); }
})();
const WORKFLOW = 'WF-03 Send';
const now = nowIso();

const results = $input.all();
const sent = (() => {
  try { return rowsOf($('Emit Sends').all()); } catch (_e) { return []; }
})();

const applicant_rows = [];
const emaillog_rows = [];
const error_rows = [];

for (let i = 0; i < sent.length; i++) {
  const item = sent[i];
  const raw = results[i] ? results[i].json : null;

  // n8n surfaces a per-item failure as an `error` field rather than throwing.
  const result = raw && raw.error
    ? { error: typeof raw.error === 'string' ? raw.error : (raw.error.message || 'send failed') }
    : raw;

  const rec = recordSend({ item, result, correlationId, now });
  applicant_rows.push({ ...rec.applicant, row_number: item._row_number });
  emaillog_rows.push(rec.log);

  if (rec.applicant.error_code) {
    error_rows.push(errorRow({
      correlationId, applicantId: item.applicant_id, workflow: WORKFLOW, node: 'Send via Gmail',
      error: new AppError(rec.applicant.error_code, rec.applicant.error_message, {}),
      payload: { to: item.to },
    }));
  }
}

const okCount = applicant_rows.filter((r) => r.email_status === 'sent').length;
const env0 = envelope({
  workflow: WORKFLOW, correlationId, trigger: 'webhook', started: now,
  items_in: sent.length,
  ok: applicant_rows.filter((r) => r.email_status === 'sent').map((r) => ({ applicant_id: r.applicant_id })),
  failed: applicant_rows.filter((r) => r.email_status === 'failed').map((r) => ({ applicant_id: r.applicant_id, code: r.error_code, message: r.error_message })),
  notes: `${okCount}/${sent.length} delivered to Gmail`,
});

return [{ json: { ...env0, applicant_rows: applicant_rows.filter((r) => r.row_number), emaillog_rows, error_rows, runlog_rows: [runLogRow(env0)] } }];
