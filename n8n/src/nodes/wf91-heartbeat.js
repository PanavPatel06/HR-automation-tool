// @requires errors schema util runtime
//
// WF-91 exists to detect the failure mode nothing else can: n8n silently not
// running. No errors are raised when no workflow fires, so the dashboard
// watches for a stale heartbeat instead.

const now = nowIso();
const correlationId = newCorrelationId('WF-91');

return [{ json: {
  ok: true,
  runlog_rows: [{
    started_at: now,
    correlation_id: correlationId,
    workflow: 'WF-91 Heartbeat',
    trigger: 'schedule',
    finished_at: now,
    items_in: 0, items_ok: 1, items_failed: 0,
    status: 'ok',
    notes: 'alive',
  }],
} }];
