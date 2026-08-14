// @requires errors schema util intake template pipeline runtime
//
// WF-05 Follow-ups. V1 deliberately only FLAGS candidates — it never sends.
// Automated nagging is exactly the thing that damages an employer brand, so a
// human stays in the loop.

const started = nowIso();
const correlationId = newCorrelationId('WF-05');
const WORKFLOW = 'WF-05 Follow-up';

try {
  const config = parseConfig(rowsOf($('Read Config').all()));
  if (!config.toggle_followup) {
    return [{ json: { ...skipped({ workflow: WORKFLOW, correlationId, started, reason: 'toggle_followup is OFF in the Config tab.' }), applicant_rows: [], error_rows: [], runlog_rows: [] } }];
  }

  const applicants = rowsOf($('Read Applicants').all()).map((r) => ({ ...r, _row_number: r.row_number }));
  const due = planFollowups({ applicants, config, now: new Date(started) });

  const applicant_rows = due.map((a) => ({
    applicant_id: a.applicant_id,
    row_number: a._row_number,
    reply_state: 'followup_due',
    correlation_id: correlationId,
    updated_at: started,
  }));

  const env0 = envelope({
    workflow: WORKFLOW, correlationId, trigger: 'schedule', started,
    items_in: applicants.length,
    ok: due.map((a) => ({ applicant_id: a.applicant_id })),
    notes: `${due.length} candidate(s) silent for ${config.followup_days} day(s) — flagged for review, nothing sent`,
  });
  return [{ json: { ...env0, applicant_rows, error_rows: [], runlog_rows: [runLogRow(env0)] } }];
} catch (err) {
  const e = toAppError(err);
  const env0 = envelope({ workflow: WORKFLOW, correlationId, trigger: 'schedule', started, failed: [{ code: e.code, message: e.message }], notes: e.hint });
  return [{ json: { ...env0, applicant_rows: [], error_rows: [errorRow({ correlationId, workflow: WORKFLOW, node: 'Plan Follow-ups', error: e })], runlog_rows: [runLogRow(env0)] } }];
}
