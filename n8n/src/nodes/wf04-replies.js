// @requires errors schema util intake template ai-router pipeline runtime
//
// WF-04 Reply watcher. Classification sorts the inbox; it never decides an
// outcome. Anything below the confidence floor is escalated to a human.

const started = nowIso();
const correlationId = newCorrelationId('WF-04');
const WORKFLOW = 'WF-04 Replies';

let env = {};
try { env = $env || {}; } catch (_e) { env = {}; }

const store = $getWorkflowStaticData('global');
store.quota = store.quota || {};

const reply_rows = [];
const applicant_rows = [];
const error_rows = [];
const warnings = [];
const ok = [];
const failed = [];

try {
  const config = parseConfig(rowsOf($('Read Config').all()));
  if (!config.toggle_replies) {
    return [{ json: { ...skipped({ workflow: WORKFLOW, correlationId, started, reason: 'toggle_replies is OFF in the Config tab.' }), reply_rows: [], applicant_rows: [], error_rows: [], runlog_rows: [] } }];
  }

  const applicants = rowsOf($('Read Applicants').all()).map((r) => ({ ...r, _row_number: r.row_number }));
  const messages = rowsOf($('Gmail Trigger').all());

  const ledger = new QuotaLedger(store.quota);
  const router = new AiRouter({
    http: makeHttp(this, { timeout: 45000 }),
    keys: apiKeys(env),
    ledger,
    log: (msg, meta) => console.log(`[${correlationId}] ${msg}`, JSON.stringify(meta)),
  });

  for (const raw of messages) {
    const message = {
      threadId: raw.threadId || raw.thread_id || '',
      from: (raw.from && raw.from.value && raw.from.value[0] && raw.from.value[0].address) || raw.From || raw.from || '',
      subject: raw.subject || raw.Subject || '',
      snippet: raw.snippet || '',
      text: raw.text || raw.textPlain || raw.snippet || '',
      received_at: raw.date || raw.internalDate || started,
    };

    try {
      const match = matchReply({ message, applicants });
      if (!match.applicant) {
        // Not a candidate reply — ordinary mail in the same mailbox. Skip
        // quietly; it is not an error and must not raise an alert.
        continue;
      }

      const res = await router.complete({
        task: 'classify_reply',
        system: 'You classify recruiting email replies. You return JSON only. When in doubt you answer "unclear" with low confidence.',
        user: buildReplyPrompt({ message }),
        json: true,
        temperature: 0,
        maxTokens: 300,
        schemaCheck: checkReplySchema,
      });

      const applied = applyReply({
        applicant: match.applicant,
        message,
        classification: { ...res.json, model: res.routeKey },
        config,
        now: nowIso(),
      });

      warnings.push(...applied.warnings, ...(res.warnings || []));
      reply_rows.push(applied.reply);
      applicant_rows.push({ ...applied.applicant, row_number: match.applicant._row_number });
      ok.push({ applicant_id: match.applicant.applicant_id, intent: applied.reply.classified_intent, matched_by: match.matchedBy });
    } catch (err) {
      const e = toAppError(err);
      failed.push({ code: e.code, message: e.message });
      error_rows.push(errorRow({ correlationId, workflow: WORKFLOW, node: 'Classify Replies', error: e, payload: { thread_id: message.threadId } }));
      if (e.code === 'E-QUOTA-ALL') break;
    }
  }

  store.quota = ledger.snapshot();
  const env0 = envelope({
    workflow: WORKFLOW, correlationId, trigger: 'gmail', started,
    items_in: messages.length, ok, failed, warnings,
    notes: `${ok.length} reply/replies matched to applicants out of ${messages.length} message(s)`,
  });
  return [{ json: { ...env0, reply_rows, applicant_rows: applicant_rows.filter((r) => r.row_number), error_rows, runlog_rows: [runLogRow(env0)] } }];
} catch (err) {
  const e = toAppError(err);
  const env0 = envelope({ workflow: WORKFLOW, correlationId, trigger: 'gmail', started, failed: [{ code: e.code, message: e.message }], notes: e.hint });
  return [{ json: { ...env0, reply_rows, applicant_rows, error_rows: [...error_rows, errorRow({ correlationId, workflow: WORKFLOW, node: 'Classify Replies', error: e })], runlog_rows: [runLogRow(env0)] } }];
}
