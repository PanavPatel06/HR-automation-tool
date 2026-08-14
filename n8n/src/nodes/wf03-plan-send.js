// @requires errors schema util intake template pipeline runtime
//
// WF-03 Send, planning half. The most safety-critical node in V1: everything it
// rejects is an email that would have gone out wrong.

const started = nowIso();
const correlationId = newCorrelationId('WF-03');
const WORKFLOW = 'WF-03 Send';

const request = (() => {
  try { return $('Verify Request').first().json || {}; } catch (_e) { return {}; }
})();

try {
  const config = parseConfig(rowsOf($('Read Config').all()));

  if (!config.toggle_send) {
    return [{ json: { ...skipped({ workflow: WORKFLOW, correlationId, started, reason: 'toggle_send is OFF in the Config tab. Turn it on deliberately.' }), send_items: [], applicant_rows: [], emaillog_rows: [], error_rows: [], runlog_rows: [] } }];
  }

  const applicants = rowsOf($('Read Applicants').all()).map((r) => ({ ...r, _row_number: r.row_number }));

  // Count today's real sends so the daily cap survives across runs.
  const today = started.slice(0, 10);
  const sentToday = rowsOf($('Read Email Log').all())
    .filter((r) => String(r.at || '').startsWith(today) && r.result === 'sent').length;

  const plan = planSends({
    applicants,
    ids: Array.isArray(request.ids) ? request.ids : null,
    config,
    sentToday,
    now: started,
  });

  const error_rows = plan.rejected.map((r) =>
    errorRow({ correlationId, applicantId: r.applicant_id, workflow: WORKFLOW, node: 'Plan Sends', error: r.error })
  );

  // A rejected row keeps its stage and becomes visibly failed in the dashboard.
  const rejected_applicant_rows = plan.rejected.map((r) => {
    const src = applicants.find((a) => a.applicant_id === r.applicant_id) || {};
    return {
      applicant_id: r.applicant_id,
      row_number: src._row_number,
      status: r.error.park ? 'pending' : 'failed',
      error_code: r.error.code,
      error_message: r.error.message,
      correlation_id: correlationId,
      updated_at: started,
    };
  }).filter((r) => r.row_number);

  // Dry run: record the intent, send nothing. send_items stays empty, so the
  // Gmail node receives no input and never executes.
  if (plan.dryRun) {
    const recorded = plan.approved.map((item) => recordSend({ item, result: null, correlationId, now: started }));
    const env0 = envelope({
      workflow: WORKFLOW, correlationId, trigger: request.trigger || 'webhook', started,
      items_in: plan.approved.length + plan.rejected.length,
      ok: plan.approved.map((i) => ({ applicant_id: i.applicant_id, to: i.to })),
      failed: plan.rejected.map((r) => ({ applicant_id: r.applicant_id, code: r.error.code, message: r.error.message })),
      warnings: ['DRY-RUN'],
      notes: `DRY RUN — ${plan.approved.length} email(s) would have been sent. Set dry_run=false in Config to send for real.`,
    });
    return [{ json: {
      ...env0,
      dry_run: true,
      send_items: [],
      applicant_rows: [
        ...recorded.map((r) => ({ ...r.applicant, row_number: (plan.approved.find((i) => i.applicant_id === r.applicant.applicant_id) || {})._row_number })),
        ...rejected_applicant_rows,
      ].filter((r) => r.row_number),
      emaillog_rows: recorded.map((r) => r.log),
      error_rows,
      runlog_rows: [runLogRow(env0)],
    } }];
  }

  const env0 = envelope({
    workflow: WORKFLOW, correlationId, trigger: request.trigger || 'webhook', started,
    items_in: plan.approved.length + plan.rejected.length,
    ok: plan.approved.map((i) => ({ applicant_id: i.applicant_id, to: i.to })),
    failed: plan.rejected.map((r) => ({ applicant_id: r.applicant_id, code: r.error.code, message: r.error.message })),
    notes: `${plan.approved.length} queued for send, ${plan.rejected.length} rejected, ${plan.capRemaining} left in today's cap`,
  });

  return [{ json: {
    ...env0,
    dry_run: false,
    correlation_id: correlationId,
    send_items: plan.approved,
    applicant_rows: rejected_applicant_rows,
    emaillog_rows: [],
    error_rows,
    runlog_rows: [runLogRow(env0)],
  } }];
} catch (err) {
  const e = toAppError(err);
  const env0 = envelope({ workflow: WORKFLOW, correlationId, trigger: 'webhook', started, failed: [{ code: e.code, message: e.message }], notes: e.hint });
  return [{ json: {
    ...env0,
    send_items: [], applicant_rows: [], emaillog_rows: [],
    error_rows: [errorRow({ correlationId, workflow: WORKFLOW, node: 'Plan Sends', error: e })],
    runlog_rows: [runLogRow(env0)],
  } }];
}
