'use strict';
/**
 * Per-workflow decision logic, kept pure so every rule is unit-testable.
 *
 * The n8n Code nodes are deliberately thin wrappers around these functions: I/O
 * in the node, judgement in here.
 */

const { AppError, toAppError } = require('./errors');
const { STAGE, STATUS, canTransition } = require('./schema');
const { validateIntake, dedupeKey, isValidEmail } = require('./intake');
const { selectTemplate, renderEmail, truthy, extractFields } = require('./template');
const { makeApplicantId, nowIso, fitCell } = require('./util');

/**
 * A template opts into AI personalisation by containing {{ai_body}}.
 * Templates without it render deterministically and cost zero tokens — which is
 * how HR keeps the quota for the emails that actually need it.
 */
const AI_FIELD = 'ai_body';
function usesAi(template) {
  return extractFields(String(template && template.html || '')).includes(AI_FIELD)
      || extractFields(String(template && template.subject || '')).includes(AI_FIELD);
}

// --- WF-01 Intake -----------------------------------------------------------

/**
 * @returns {{rows: object[], errors: object[], stats: object}}
 *   `rows` are ready to write back (valid rows AND blocked rows — a blocked row
 *   must still land in the sheet with its reason, never be dropped).
 */
function planIntake({ rows, roles, categories, correlationId, now = nowIso(), idFactory = makeApplicantId }) {
  const seen = new Set();
  // Existing, already-processed rows seed the dedupe set.
  for (const r of rows || []) {
    if (r.applicant_id && r.email && r.job_role && r.status !== STATUS.BLOCKED) {
      seen.add(dedupeKey(r.email, r.job_role));
    }
  }

  const out = [];
  const errors = [];
  let processed = 0;

  for (const raw of rows || []) {
    // Only untouched rows are candidates: anything with an id and a stage has
    // already been through here.
    if (raw.applicant_id && raw.stage) continue;
    processed++;

    const result = validateIntake(raw, {
      roles, categories, seen, correlationId,
      applicantId: idFactory(new Date(now)),
      now,
    });

    if (result.ok) {
      seen.add(result.key);
      out.push({ ...raw, ...result.row, _row_number: raw._row_number });
    } else {
      const e = result.error;
      out.push({
        ...raw, ...result.row,
        error_code: e.code, error_message: e.message,
        _row_number: raw._row_number,
      });
      errors.push({ applicant_id: result.row.applicant_id, error: e, payload: { email: raw.email, job_role: raw.job_role } });
    }
  }

  return { rows: out, errors, stats: { scanned: (rows || []).length, processed, blocked: errors.length } };
}

// --- WF-02 Drafting ---------------------------------------------------------

/** Which applicants are eligible for a draft right now. */
function selectForDrafting({ applicants, ids = null, batchSize = 10, redraft = false }) {
  const wanted = ids && ids.length ? new Set(ids) : null;
  const eligible = (applicants || []).filter((a) => {
    if (!a.applicant_id) return false;
    if (wanted) return wanted.has(a.applicant_id);
    if (a.status === STATUS.BLOCKED) return false;
    if (redraft) return [STAGE.NEW, STAGE.DRAFTED, STAGE.FAILED, STAGE.SCORED, STAGE.SHORTLISTED].includes(a.stage);
    return a.stage === STAGE.NEW || (a.stage === STAGE.FAILED && !a.email_subject);
  });
  return eligible.slice(0, Math.max(1, batchSize));
}

/** The user-side prompt for personalising one email. */
function buildDraftPrompt({ applicant, template, config, promptVersion = 'draft-email.v1' }) {
  const lines = [
    `Company: ${config.company_name || 'the company'}`,
    `Candidate name: ${applicant.name}`,
    `Role applied for: ${applicant.job_role}`,
    applicant.category ? `Seniority/category: ${applicant.category}` : '',
    `Sender: ${config.hr_name || 'HR'}`,
    '',
    'Write the body of an outreach email to this candidate about their application.',
    '',
    'Return JSON only, exactly: {"subject": "...", "body_html": "..."}',
    'Rules for body_html:',
    '- 2 to 4 short paragraphs, wrapped in <p> tags.',
    '- Allowed tags: <p> <br> <strong> <em> <ul> <li> <a>. Nothing else.',
    '- Do not include a greeting line or a sign-off — the template supplies both.',
    '- Do not invent facts about the candidate, the salary, the interview date, or the process.',
    '- Do not use placeholders or merge fields of any kind.',
    `- Address the ${applicant.job_role} role specifically; a generic email is a failure.`,
  ].filter(Boolean);
  return { user: lines.join('\n'), promptVersion, template_id: template && template.template_id };
}

/** Structural gate on what the model returned, before it reaches a template. */
function checkDraftSchema(json) {
  if (!json || typeof json !== 'object') return { ok: false, reason: 'not an object' };
  if (typeof json.subject !== 'string' || !json.subject.trim()) return { ok: false, reason: 'missing subject' };
  if (typeof json.body_html !== 'string' || !json.body_html.trim()) return { ok: false, reason: 'missing body_html' };
  if (/\{\{|\}\}/.test(json.body_html + json.subject)) return { ok: false, reason: 'model emitted merge-field placeholders' };
  if (/<(script|iframe|style)\b/i.test(json.body_html)) return { ok: false, reason: 'disallowed tag in body_html' };
  if (json.body_html.length > 20000) return { ok: false, reason: 'body_html unreasonably long' };
  return { ok: true };
}

/**
 * Turn one applicant + one AI result into the draft columns.
 * `ai` is null for templates that do not use {{ai_body}}.
 */
function assembleDraft({ applicant, template, config, ai, correlationId, now = nowIso() }) {
  const mergeExtras = ai ? { ai_body: ai.body_html } : {};
  const effectiveTemplate = {
    ...template,
    subject: ai && ai.subject && usesAi(template) && String(template.subject || '').includes(`{{${AI_FIELD}}}`)
      ? ai.subject
      : template.subject,
  };

  const rendered = renderEmail({
    template: effectiveTemplate,
    applicant,
    config,
    extras: mergeExtras,
  });

  return {
    applicant_id: applicant.applicant_id,
    template_id: template.template_id,
    email_subject: rendered.subject,
    email_html: fitCell(rendered.html),
    stage: STAGE.DRAFTED,
    status: STATUS.OK,
    error_code: '',
    error_message: '',
    correlation_id: correlationId,
    updated_at: now,
  };
}

// --- WF-03 Sending ----------------------------------------------------------

/**
 * Decide what may actually be sent. This is the most safety-critical function
 * in V1: every rejection here is an email that would have embarrassed someone.
 */
function planSends({ applicants, ids, config, sentToday = 0, now = nowIso() }) {
  const wanted = ids && ids.length ? new Set(ids) : null;
  const cap = Number(config.send_daily_cap) || 400;
  const dryRun = truthy(config.dry_run);

  const approved = [];
  const rejected = [];
  let budget = Math.max(0, cap - sentToday);

  for (const a of applicants || []) {
    if (wanted && !wanted.has(a.applicant_id)) continue;

    const reject = (code, msg) => rejected.push({ applicant_id: a.applicant_id, error: new AppError(code, msg, {}) });

    if (a.stage !== STAGE.APPROVED) { reject('E-MAIL-NODRAFT', `Stage is "${a.stage || 'empty'}", not APPROVED. Approve the draft before sending.`); continue; }
    if (!canTransition(a.stage, STAGE.SENT)) { reject('E-MAIL-NODRAFT', `Illegal transition ${a.stage} -> SENT.`); continue; }
    if (!a.email_subject || !a.email_html) { reject('E-MAIL-NODRAFT', 'Row is APPROVED but has no draft body. Regenerate the draft.'); continue; }
    if (/\{\{[^}]+\}\}/.test(String(a.email_subject) + String(a.email_html))) { reject('E-MAIL-TEMPLATE', 'Draft still contains unresolved merge fields. Nothing was sent.'); continue; }
    if (!isValidEmail(a.email)) { reject('E-MAIL-BOUNCE', `"${a.email}" is not a deliverable address.`); continue; }
    if (a.email_status === 'sent') { reject('E-MAIL-NODRAFT', 'Already sent. Refusing to send a duplicate.'); continue; }
    if (budget <= 0) { reject('E-MAIL-LIMIT', `Daily send cap of ${cap} reached. Remaining sends resume tomorrow.`); continue; }

    budget--;
    approved.push({
      applicant_id: a.applicant_id,
      to: a.email,
      name: a.name,
      subject: a.email_subject,
      html: a.email_html,
      dry_run: dryRun,
      _row_number: a._row_number,
    });
  }

  return { approved, rejected, dryRun, capRemaining: budget, now };
}

/** Post-send row updates, from the Gmail node's result. */
function recordSend({ item, result, correlationId, now = nowIso() }) {
  const sent = !item.dry_run && result && !result.error;
  return {
    applicant: {
      applicant_id: item.applicant_id,
      stage: sent ? STAGE.SENT : STAGE.APPROVED,
      status: sent ? STATUS.OK : STATUS.PENDING,
      email_status: item.dry_run ? 'dry-run' : (sent ? 'sent' : 'failed'),
      sent_at: sent ? now : '',
      thread_id: (result && result.threadId) || '',
      message_id: (result && result.id) || '',
      error_code: sent || item.dry_run ? '' : 'E-MAIL-BOUNCE',
      error_message: sent || item.dry_run ? '' : String((result && result.error) || 'Send failed'),
      correlation_id: correlationId,
      updated_at: now,
    },
    log: {
      at: now,
      correlation_id: correlationId,
      applicant_id: item.applicant_id,
      to: item.to,
      subject: item.subject,
      provider: 'gmail',
      result: item.dry_run ? 'dry-run' : (sent ? 'sent' : 'failed'),
      provider_message_id: (result && result.id) || '',
      thread_id: (result && result.threadId) || '',
      dry_run: String(item.dry_run),
      error_code: sent || item.dry_run ? '' : 'E-MAIL-BOUNCE',
      error_message: sent || item.dry_run ? '' : String((result && result.error) || ''),
    },
  };
}

// --- WF-04 Replies ----------------------------------------------------------

/** Thread id is authoritative; from-address is the fallback for forwarded mail. */
function matchReply({ message, applicants }) {
  const threadId = message.threadId || message.thread_id || '';
  const from = String(message.from || '').toLowerCase();
  const fromEmail = (from.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [''])[0];

  if (threadId) {
    const byThread = (applicants || []).find((a) => a.thread_id && a.thread_id === threadId);
    if (byThread) return { applicant: byThread, matchedBy: 'thread_id' };
  }
  if (fromEmail) {
    const byEmail = (applicants || [])
      .filter((a) => String(a.email || '').toLowerCase() === fromEmail && a.stage === STAGE.SENT)
      .sort((a, b) => String(b.sent_at || '').localeCompare(String(a.sent_at || '')));
    if (byEmail.length) return { applicant: byEmail[0], matchedBy: 'email' };
  }
  return { applicant: null, matchedBy: 'none' };
}

const REPLY_INTENTS = ['interested', 'declined', 'question', 'out_of_office', 'unclear'];

function buildReplyPrompt({ message }) {
  return [
    'Classify this reply from a job candidate.',
    '',
    'Return JSON only: {"intent": "...", "confidence": 0.0, "summary": "..."}',
    `intent must be one of: ${REPLY_INTENTS.join(', ')}.`,
    'confidence is 0.0-1.0. summary is one sentence, max 140 characters.',
    'If the message is ambiguous, say "unclear" with low confidence rather than guessing.',
    '',
    '--- reply ---',
    String(message.text || message.snippet || '').slice(0, 4000),
  ].join('\n');
}

function checkReplySchema(json) {
  if (!json || typeof json !== 'object') return { ok: false, reason: 'not an object' };
  if (!REPLY_INTENTS.includes(json.intent)) return { ok: false, reason: `intent "${json.intent}" not in the allowed set` };
  const c = Number(json.confidence);
  if (!Number.isFinite(c) || c < 0 || c > 1) return { ok: false, reason: 'confidence out of range' };
  return { ok: true };
}

/**
 * Low-confidence classifications are escalated, never acted on. The model
 * sorting the inbox is a convenience; it does not get to decide outcomes.
 */
function applyReply({ applicant, message, classification, config, now = nowIso() }) {
  const min = Number(config.reply_confidence_min ?? 0.7);
  const confident = Number(classification.confidence) >= min;
  const intent = confident ? classification.intent : 'unclear';
  const warnings = confident ? [] : ['W-REPLY-LOWCONF'];

  return {
    warnings,
    reply: {
      received_at: message.received_at || now,
      applicant_id: applicant.applicant_id,
      thread_id: message.threadId || applicant.thread_id || '',
      from: message.from || applicant.email,
      subject: message.subject || '',
      snippet: String(message.snippet || message.text || '').slice(0, 500),
      classified_intent: intent,
      confidence: Number(classification.confidence) || 0,
      model: classification.model || '',
      handled_by: '',
      handled_at: '',
    },
    applicant: {
      applicant_id: applicant.applicant_id,
      stage: STAGE.REPLIED,
      reply_state: confident ? intent : 'needs_human',
      updated_at: now,
    },
  };
}

// --- WF-05 Follow-ups -------------------------------------------------------

/** Candidates who were emailed, never replied, and are past the silence window. */
function planFollowups({ applicants, config, now = new Date() }) {
  const days = Number(config.followup_days) || 5;
  const cutoff = new Date(now.getTime() - days * 86400000);
  return (applicants || []).filter((a) => {
    if (a.stage !== STAGE.SENT) return false;
    if (a.reply_state && a.reply_state !== 'none') return false;
    if (!a.sent_at) return false;
    const sent = new Date(a.sent_at);
    return !Number.isNaN(sent.getTime()) && sent < cutoff;
  });
}

module.exports = {
  AI_FIELD, usesAi,
  planIntake,
  selectForDrafting, buildDraftPrompt, checkDraftSchema, assembleDraft,
  planSends, recordSend,
  matchReply, buildReplyPrompt, checkReplySchema, applyReply, REPLY_INTENTS,
  planFollowups,
};
