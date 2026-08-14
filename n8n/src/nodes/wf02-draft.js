// @requires errors schema util intake template ai-router pipeline runtime
//
// WF-02 Draft generation. The only node in V1 that spends model quota.
//
// Two costs are deliberately avoided here:
//   - templates without {{ai_body}} never reach the model at all;
//   - the quota ledger is checked before dispatch, so an exhausted budget parks
//     the batch instead of burning retries on guaranteed 429s.

const started = nowIso();
const correlationId = newCorrelationId('WF-02');
const WORKFLOW = 'WF-02 Draft';

let env = {};
try { env = $env || {}; } catch (_e) { env = {}; }

const request = (() => {
  try { return $('Verify Request').first().json || {}; } catch (_e) { return {}; }
})();

// Quota survives restarts in n8n's own static store — no sheet round-trip on
// the hot path.
const store = $getWorkflowStaticData('global');
store.quota = store.quota || {};

const applicant_rows = [];
const error_rows = [];
const quota_rows = [];
const ok = [];
const failed = [];
const warnings = [];

try {
  const config = parseConfig(rowsOf($('Read Config').all()));
  if (!config.toggle_draft) {
    return [{ json: { ...skipped({ workflow: WORKFLOW, correlationId, started, reason: 'toggle_draft is OFF in the Config tab.' }), applicant_rows: [], error_rows: [], runlog_rows: [] } }];
  }

  const templates = rowsOf($('Read Templates').all());
  const applicants = rowsOf($('Read Applicants').all()).map((r) => ({ ...r, _row_number: r.row_number }));

  const selected = selectForDrafting({
    applicants,
    ids: Array.isArray(request.ids) ? request.ids : null,
    batchSize: Number(request.batch_size) || Number(config.batch_size) || 10,
    redraft: request.redraft === true,
  });

  const ledger = new QuotaLedger(store.quota);
  const router = new AiRouter({
    http: makeHttp(this, { timeout: 60000 }),
    keys: apiKeys(env),
    ledger,
    log: (msg, meta) => console.log(`[${correlationId}] ${msg}`, JSON.stringify(meta)),
  });

  for (const applicant of selected) {
    try {
      const picked = selectTemplate(templates, { job_role: applicant.job_role, category: applicant.category, stage: 'outreach' });
      if (picked.warning) warnings.push(picked.warning);

      let ai = null;
      if (usesAi(picked.template)) {
        const prompt = buildDraftPrompt({ applicant, template: picked.template, config });
        const res = await router.complete({
          task: 'draft_email',
          system: 'You write concise, warm, factual recruiting emails. You never invent details. You return JSON only.',
          user: prompt.user,
          json: true,
          temperature: 0.5,
          maxTokens: 1200,
          schemaCheck: checkDraftSchema,
        });
        ai = res.json;
        if (res.failedOver) warnings.push('W-AI-FAILOVER');
        warnings.push(...(res.warnings || []));
      }

      const draft = assembleDraft({ applicant, template: picked.template, config, ai, correlationId, now: nowIso() });
      applicant_rows.push({ ...draft, row_number: applicant._row_number });
      ok.push({ applicant_id: applicant.applicant_id, ai: Boolean(ai) });
    } catch (err) {
      // Item-level isolation: one bad applicant never aborts the batch.
      const e = toAppError(err);
      failed.push({ applicant_id: applicant.applicant_id, code: e.code, message: e.message });
      error_rows.push(errorRow({
        correlationId, applicantId: applicant.applicant_id, workflow: WORKFLOW, node: 'Generate Drafts',
        error: e, payload: { job_role: applicant.job_role, category: applicant.category },
      }));
      applicant_rows.push({
        applicant_id: applicant.applicant_id,
        row_number: applicant._row_number,
        stage: e.park ? applicant.stage : 'FAILED',
        status: e.park ? 'pending' : 'failed',
        error_code: e.code,
        error_message: e.message,
        correlation_id: correlationId,
        updated_at: nowIso(),
      });
      // Every provider exhausted: stop the batch rather than failing the rest
      // one by one. The remaining rows stay NEW and get picked up next run.
      if (e.code === 'E-QUOTA-ALL') break;
    }
  }

  store.quota = ledger.snapshot();
  const now = nowIso();
  for (const [key, b] of Object.entries(store.quota)) {
    const limits = MODELS[key] || {};
    const [provider, ...rest] = key.split(':');
    quota_rows.push({
      provider, model: rest.join(':'), window: 'day',
      requests_used: b.rpd, tokens_used: b.tpd,
      requests_limit: limits.rpd === Infinity ? '' : limits.rpd,
      tokens_limit: limits.tpd === Infinity ? '' : limits.tpd,
      window_reset_at: new Date(Math.ceil(Date.now() / 86400000) * 86400000).toISOString(),
      updated_at: now,
    });
  }

  const env0 = envelope({
    workflow: WORKFLOW, correlationId, trigger: request.trigger || 'webhook', started,
    items_in: selected.length, ok, failed, warnings,
    notes: `${ok.length} drafted, ${failed.length} failed`,
  });
  return [{ json: { ...env0, applicant_rows, error_rows, quota_rows, runlog_rows: [runLogRow(env0)] } }];
} catch (err) {
  const e = toAppError(err);
  const env0 = envelope({ workflow: WORKFLOW, correlationId, trigger: 'webhook', started, failed: [{ code: e.code, message: e.message }], notes: e.hint });
  return [{
    json: {
      ...env0,
      applicant_rows,
      error_rows: [...error_rows, errorRow({ correlationId, workflow: WORKFLOW, node: 'Generate Drafts', error: e })],
      quota_rows,
      runlog_rows: [runLogRow(env0)],
    },
  }];
}
