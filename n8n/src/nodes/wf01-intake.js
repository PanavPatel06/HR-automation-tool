// @requires errors schema util intake pipeline runtime
//
// WF-01 Intake: validate every untouched row in the Applicants tab.
// Emits one item carrying every downstream row set (see emit-*.js).

const started = nowIso();
const correlationId = newCorrelationId('WF-01');
const WORKFLOW = 'WF-01 Intake';

let env = {};
try { env = $env || {}; } catch (_e) { env = {}; }

try {
  const config = parseConfig(rowsOf($('Read Config').all()));

  if (!config.toggle_intake) {
    return [{ json: { ...skipped({ workflow: WORKFLOW, correlationId, started, reason: 'toggle_intake is OFF in the Config tab.' }), applicant_rows: [], error_rows: [], runlog_rows: [] } }];
  }

  const roleRows = rowsOf($('Read Job Roles').all());
  const roles = roleRows.filter((r) => r.title && String(r.is_open).toLowerCase() !== 'false').map((r) => r.title);
  const categories = config.categories || [];

  // Sheets read emits row_number on every row; that is what the update node
  // matches on, so carry it through untouched.
  const rows = rowsOf($('Read Applicants').all()).map((r) => ({ ...r, _row_number: r.row_number }));

  const plan = planIntake({ rows, roles, categories, correlationId, now: started });

  const applicant_rows = plan.rows.map((r) => {
    const out = { ...r, row_number: r._row_number };
    delete out._row_number;
    return out;
  });

  const error_rows = plan.errors.map((e) =>
    errorRow({ correlationId, applicantId: e.applicant_id, workflow: WORKFLOW, node: 'Plan Intake', error: e.error, payload: e.payload })
  );

  const env0 = envelope({
    workflow: WORKFLOW, correlationId, trigger: 'schedule', started,
    items_in: plan.stats.processed,
    ok: applicant_rows.filter((r) => r.status !== 'blocked').map((r) => ({ applicant_id: r.applicant_id })),
    failed: plan.errors.map((e) => ({ applicant_id: e.applicant_id, code: e.error.code, message: e.error.message })),
    notes: `scanned ${plan.stats.scanned} rows, ${plan.stats.processed} new, ${plan.stats.blocked} blocked`,
  });

  return [{ json: { ...env0, applicant_rows, error_rows, runlog_rows: [runLogRow(env0)] } }];
} catch (err) {
  // A failure here is a workflow-level fault (bad config, unreadable sheet).
  // Surface it as data so the run still records why it produced nothing.
  const e = toAppError(err);
  const env0 = envelope({ workflow: WORKFLOW, correlationId, trigger: 'schedule', started, failed: [{ code: e.code, message: e.message }], notes: e.hint });
  return [{
    json: {
      ...env0,
      applicant_rows: [],
      error_rows: [errorRow({ correlationId, workflow: WORKFLOW, node: 'Plan Intake', error: e })],
      runlog_rows: [runLogRow(env0)],
    },
  }];
}
