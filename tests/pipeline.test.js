'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  planIntake, selectForDrafting, buildDraftPrompt, checkDraftSchema, assembleDraft,
  planSends, recordSend, matchReply, checkReplySchema, applyReply, planFollowups, usesAi,
} = require('../n8n/src/lib/pipeline');

const CONFIG = { company_name: '3Space', hr_name: 'Priya', hr_signature: 'Best,<br>Priya', dry_run: false, send_daily_cap: 3, reply_confidence_min: 0.7, followup_days: 5 };
const ROLES = ['Frontend Engineer'];
const CATS = ['Junior', 'Senior'];
let idn = 0;
const idFactory = () => `APP-TEST-${String(++idn).padStart(3, '0')}`;

// --- WF-01 ------------------------------------------------------------------

test('intake processes only untouched rows and leaves processed ones alone', () => {
  idn = 0;
  const rows = [
    { _row_number: 2, name: 'Asha', email: 'asha@x.com', job_role: 'Frontend Engineer', category: 'Junior' },
    { _row_number: 3, applicant_id: 'APP-OLD', stage: 'SENT', name: 'Ravi', email: 'ravi@x.com', job_role: 'Frontend Engineer' },
  ];
  const r = planIntake({ rows, roles: ROLES, categories: CATS, correlationId: 'C1', now: '2026-08-14T00:00:00.000Z', idFactory });
  assert.equal(r.rows.length, 1, 'the already-processed row is not touched again');
  assert.equal(r.rows[0].applicant_id, 'APP-TEST-001');
  assert.equal(r.stats.processed, 1);
});

test('intake keeps blocked rows in the sheet with their reason attached', () => {
  idn = 0;
  const rows = [{ _row_number: 2, name: '', email: 'bad', job_role: 'Frontend Engineer' }];
  const r = planIntake({ rows, roles: ROLES, categories: CATS, correlationId: 'C1', idFactory });
  assert.equal(r.rows.length, 1, 'blocked rows are still written back — never silently dropped');
  assert.equal(r.rows[0].status, 'blocked');
  assert.equal(r.rows[0].error_code, 'E-INTAKE-MISSING');
  assert.equal(r.errors.length, 1);
});

test('intake dedupes against rows already in the sheet', () => {
  idn = 0;
  const rows = [
    { _row_number: 2, applicant_id: 'APP-OLD', stage: 'SENT', email: 'asha@x.com', job_role: 'Frontend Engineer', name: 'Asha' },
    { _row_number: 3, name: 'Asha', email: 'asha@x.com', job_role: 'Frontend Engineer' },
  ];
  const r = planIntake({ rows, roles: ROLES, categories: CATS, correlationId: 'C1', idFactory });
  assert.equal(r.rows[0].error_code, 'E-INTAKE-DUPE');
});

// --- WF-02 ------------------------------------------------------------------

const template = (over = {}) => ({
  template_id: 'T1', is_active: 'TRUE', is_default: 'TRUE', stage: 'outreach',
  subject: 'Your application for {{job_role}}',
  html: '<p>Hi {{first_name}},</p>{{ai_body}}<p>{{hr_signature}}</p>',
  ...over,
});

test('a template opts into AI only by using {{ai_body}}', () => {
  assert.equal(usesAi(template()), true);
  assert.equal(usesAi(template({ html: '<p>Hi {{first_name}}</p>' })), false, 'plain templates cost zero tokens');
});

test('drafting selects NEW rows and respects the batch size', () => {
  const applicants = [
    { applicant_id: 'A', stage: 'NEW' },
    { applicant_id: 'B', stage: 'NEW' },
    { applicant_id: 'C', stage: 'SENT' },
    { applicant_id: 'D', stage: 'NEW', status: 'blocked' },
  ];
  const sel = selectForDrafting({ applicants, batchSize: 1 });
  assert.deepEqual(sel.map((a) => a.applicant_id), ['A']);
  const all = selectForDrafting({ applicants, batchSize: 10 });
  assert.deepEqual(all.map((a) => a.applicant_id), ['A', 'B'], 'blocked and already-sent rows are excluded');
});

test('drafting honours an explicit id list even for redrafts', () => {
  const applicants = [{ applicant_id: 'A', stage: 'DRAFTED' }, { applicant_id: 'B', stage: 'NEW' }];
  assert.deepEqual(selectForDrafting({ applicants, ids: ['A'] }).map((a) => a.applicant_id), ['A']);
});

test('draft schema rejects the ways models actually misbehave', () => {
  assert.equal(checkDraftSchema({ subject: 's', body_html: '<p>x</p>' }).ok, true);
  assert.equal(checkDraftSchema({ subject: '', body_html: '<p>x</p>' }).ok, false);
  assert.equal(checkDraftSchema({ subject: 's', body_html: '<p>Hi {{name}}</p>' }).ok, false, 'model must not emit merge fields');
  assert.equal(checkDraftSchema({ subject: 's', body_html: '<script>x</script>' }).ok, false);
  assert.equal(checkDraftSchema(null).ok, false);
});

test('assembleDraft injects the AI body and resolves every field', () => {
  const applicant = { applicant_id: 'A', name: 'Asha Menon', email: 'a@x.com', job_role: 'Frontend Engineer' };
  const d = assembleDraft({
    applicant, template: template(), config: CONFIG,
    ai: { subject: 'ignored', body_html: '<p>We liked your work.</p>' },
    correlationId: 'C1', now: '2026-08-14T00:00:00.000Z',
  });
  assert.equal(d.stage, 'DRAFTED');
  assert.equal(d.email_subject, 'Your application for Frontend Engineer');
  assert.match(d.email_html, /Hi Asha,/);
  assert.match(d.email_html, /We liked your work\./);
  assert.ok(!/\{\{/.test(d.email_html), 'no merge field survives into a draft');
});

test('assembleDraft fails loudly when the AI body is missing for an AI template', () => {
  assert.throws(
    () => assembleDraft({ applicant: { applicant_id: 'A', name: 'Asha' }, template: template(), config: CONFIG, ai: null, correlationId: 'C1' }),
    (e) => e.code === 'E-MAIL-TEMPLATE' && /ai_body/.test(e.message)
  );
});

test('the draft prompt names the role and forbids invention', () => {
  const p = buildDraftPrompt({ applicant: { name: 'Asha', job_role: 'Frontend Engineer' }, template: template(), config: CONFIG });
  assert.match(p.user, /Frontend Engineer/);
  assert.match(p.user, /Do not invent facts/);
  assert.equal(p.promptVersion, 'draft-email.v1');
});

// --- WF-03: the safety-critical one ----------------------------------------

const approved = (over = {}) => ({
  applicant_id: 'A', email: 'a@x.com', name: 'Asha', stage: 'APPROVED',
  email_subject: 'Hello', email_html: '<p>Hi Asha</p>', email_status: 'none', ...over,
});

test('only APPROVED rows with a complete draft may send', () => {
  const cases = [
    [approved({ stage: 'DRAFTED' }), 'E-MAIL-NODRAFT'],
    [approved({ stage: 'NEW' }), 'E-MAIL-NODRAFT'],
    [approved({ email_html: '' }), 'E-MAIL-NODRAFT'],
    [approved({ email_html: '<p>Hi {{first_name}}</p>' }), 'E-MAIL-TEMPLATE'],
    [approved({ email: 'not-an-email' }), 'E-MAIL-BOUNCE'],
    [approved({ email_status: 'sent' }), 'E-MAIL-NODRAFT'],
  ];
  for (const [row, code] of cases) {
    const r = planSends({ applicants: [row], config: CONFIG });
    assert.equal(r.approved.length, 0, `${code} case must not send`);
    assert.equal(r.rejected[0].error.code, code);
  }
  assert.equal(planSends({ applicants: [approved()], config: CONFIG }).approved.length, 1);
});

test('the daily cap stops the batch instead of blasting past it', () => {
  const applicants = ['A', 'B', 'C', 'D'].map((id) => approved({ applicant_id: id }));
  const r = planSends({ applicants, config: CONFIG, sentToday: 1 });
  assert.equal(r.approved.length, 2, 'cap 3 minus 1 already sent');
  assert.equal(r.rejected.length, 2);
  assert.equal(r.rejected[0].error.code, 'E-MAIL-LIMIT');
  assert.equal(r.rejected[0].error.park, true, 'hitting the cap parks, it does not fail the row');
});

test('dry-run marks the batch without sending and never advances the stage', () => {
  const r = planSends({ applicants: [approved()], config: { ...CONFIG, dry_run: 'TRUE' } });
  assert.equal(r.dryRun, true);
  assert.equal(r.approved[0].dry_run, true);
  const rec = recordSend({ item: r.approved[0], result: { id: 'm1', threadId: 't1' }, correlationId: 'C1', now: 'T' });
  assert.equal(rec.applicant.stage, 'APPROVED', 'a dry run must not mark the row SENT');
  assert.equal(rec.applicant.email_status, 'dry-run');
  assert.equal(rec.log.result, 'dry-run');
});

test('a real send records the thread id that reply matching depends on', () => {
  const r = planSends({ applicants: [approved()], config: CONFIG });
  const rec = recordSend({ item: r.approved[0], result: { id: 'm1', threadId: 't1' }, correlationId: 'C1', now: 'T' });
  assert.equal(rec.applicant.stage, 'SENT');
  assert.equal(rec.applicant.thread_id, 't1');
  assert.equal(rec.log.result, 'sent');
});

test('one failed recipient is recorded without touching the rest of the batch', () => {
  const r = planSends({ applicants: [approved({ applicant_id: 'A' }), approved({ applicant_id: 'B' })], config: CONFIG });
  const bad = recordSend({ item: r.approved[0], result: { error: 'mailbox unavailable' }, correlationId: 'C1', now: 'T' });
  const good = recordSend({ item: r.approved[1], result: { id: 'm2', threadId: 't2' }, correlationId: 'C1', now: 'T' });
  assert.equal(bad.applicant.stage, 'APPROVED', 'stays retryable');
  assert.equal(bad.applicant.error_code, 'E-MAIL-BOUNCE');
  assert.equal(good.applicant.stage, 'SENT');
});

test('an explicit id list scopes the send precisely', () => {
  const applicants = [approved({ applicant_id: 'A' }), approved({ applicant_id: 'B' })];
  const r = planSends({ applicants, ids: ['B'], config: CONFIG });
  assert.deepEqual(r.approved.map((x) => x.applicant_id), ['B']);
});

// --- WF-04 ------------------------------------------------------------------

test('replies match on thread id first, then fall back to sender address', () => {
  const applicants = [
    { applicant_id: 'A', email: 'a@x.com', thread_id: 't1', stage: 'SENT', sent_at: '2026-01-01' },
    { applicant_id: 'B', email: 'b@x.com', thread_id: '', stage: 'SENT', sent_at: '2026-02-01' },
  ];
  assert.equal(matchReply({ message: { threadId: 't1' }, applicants }).applicant.applicant_id, 'A');
  const byEmail = matchReply({ message: { from: 'Bee <b@x.com>' }, applicants });
  assert.equal(byEmail.applicant.applicant_id, 'B');
  assert.equal(byEmail.matchedBy, 'email');
  assert.equal(matchReply({ message: { from: 'nobody@z.com' }, applicants }).applicant, null);
});

test('reply schema pins the intent vocabulary', () => {
  assert.equal(checkReplySchema({ intent: 'interested', confidence: 0.9 }).ok, true);
  assert.equal(checkReplySchema({ intent: 'maybe', confidence: 0.9 }).ok, false);
  assert.equal(checkReplySchema({ intent: 'interested', confidence: 3 }).ok, false);
});

test('a low-confidence classification escalates to a human instead of deciding', () => {
  const applicant = { applicant_id: 'A', email: 'a@x.com', thread_id: 't1' };
  const low = applyReply({ applicant, message: { snippet: 'hmm' }, classification: { intent: 'declined', confidence: 0.4 }, config: CONFIG, now: 'T' });
  assert.equal(low.applicant.reply_state, 'needs_human');
  assert.equal(low.reply.classified_intent, 'unclear');
  assert.deepEqual(low.warnings, ['W-REPLY-LOWCONF']);

  const high = applyReply({ applicant, message: { snippet: 'yes please' }, classification: { intent: 'interested', confidence: 0.95 }, config: CONFIG, now: 'T' });
  assert.equal(high.applicant.reply_state, 'interested');
  assert.equal(high.applicant.stage, 'REPLIED');
});

// --- WF-05 ------------------------------------------------------------------

test('follow-ups target only silent, already-sent candidates past the window', () => {
  const now = new Date('2026-08-14T00:00:00Z');
  const applicants = [
    { applicant_id: 'old', stage: 'SENT', reply_state: 'none', sent_at: '2026-08-01T00:00:00Z' },
    { applicant_id: 'recent', stage: 'SENT', reply_state: 'none', sent_at: '2026-08-13T00:00:00Z' },
    { applicant_id: 'replied', stage: 'SENT', reply_state: 'interested', sent_at: '2026-08-01T00:00:00Z' },
    { applicant_id: 'never-sent', stage: 'DRAFTED', reply_state: 'none', sent_at: '' },
    { applicant_id: 'bad-date', stage: 'SENT', reply_state: 'none', sent_at: 'yesterday' },
  ];
  const r = planFollowups({ applicants, config: CONFIG, now });
  assert.deepEqual(r.map((a) => a.applicant_id), ['old']);
});
