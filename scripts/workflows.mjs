/**
 * V1 workflow graphs. Rendered to n8n/workflows/*.json by build-workflows.mjs.
 *
 * Shape shared by every workflow: read what you need, run ONE planning code
 * node that decides everything, then fan out to `emit-*` nodes that turn the
 * plan's row arrays into sheet writes. Branches never contain judgement — that
 * all lives in tested library code.
 */

import { workflow, node as n } from './lib/dsl.mjs';

const WF00 = () => workflow({
  id: 'WF-00',
  name: 'WF-00 Preflight',
  notes: 'Validates every credential, env var and Config key without writing or sending anything. Run after any deploy or credential change.',
  nodes: [
    n.manualTrigger('Run manually'),
    n.webhook('Preflight Webhook', { path: 'preflight' }),
    n.sheetsRead('Read Config', 'Config'),
    n.code('Preflight', 'wf00-preflight'),
    n.respond('Respond'),
  ],
  edges: [
    ['Run manually', 'Read Config'],
    ['Preflight Webhook', 'Read Config'],
    ['Read Config', 'Preflight'],
    ['Preflight', 'Respond'],
  ],
});

const WF01 = () => workflow({
  id: 'WF-01',
  name: 'WF-01 Intake & Normalise',
  notes: 'Polls the Applicants tab for untouched rows, validates them, and writes back either a normalised row or a blocked row with a typed reason.',
  nodes: [
    n.schedule('Every 2 minutes', { minutes: 2 }),
    n.sheetsRead('Read Config', 'Config'),
    n.sheetsRead('Read Job Roles', 'JobRoles'),
    n.sheetsRead('Read Applicants', 'Applicants'),
    n.code('Plan Intake', 'wf01-intake'),
    n.code('Emit Applicant Rows', 'emit-applicants'),
    n.code('Emit Error Rows', 'emit-errors'),
    n.code('Emit Run Log', 'emit-runlog'),
    n.sheetsUpdate('Update Applicants', 'Applicants'),
    n.sheetsAppend('Append Errors', 'Errors'),
    n.sheetsAppend('Append Run Log', 'RunLog'),
  ],
  edges: [
    ['Every 2 minutes', 'Read Config'],
    ['Read Config', 'Read Job Roles'],
    ['Read Job Roles', 'Read Applicants'],
    ['Read Applicants', 'Plan Intake'],
    ['Plan Intake', 'Emit Applicant Rows'],
    ['Plan Intake', 'Emit Error Rows'],
    ['Plan Intake', 'Emit Run Log'],
    ['Emit Applicant Rows', 'Update Applicants'],
    ['Emit Error Rows', 'Append Errors'],
    ['Emit Run Log', 'Append Run Log'],
  ],
});

const WF02 = () => workflow({
  id: 'WF-02',
  name: 'WF-02 Draft Generation',
  notes: 'Dashboard-triggered. Picks a template per applicant and, only when the template contains {{ai_body}}, spends model quota to personalise it.',
  nodes: [
    n.webhook('Draft Webhook', { path: 'draft' }),
    n.code('Verify Request', 'verify-request'),
    n.sheetsRead('Read Config', 'Config'),
    n.sheetsRead('Read Templates', 'Templates'),
    n.sheetsRead('Read Applicants', 'Applicants'),
    n.code('Generate Drafts', 'wf02-draft'),
    n.code('Emit Applicant Rows', 'emit-applicants'),
    n.code('Emit Error Rows', 'emit-errors'),
    n.code('Emit Run Log', 'emit-runlog'),
    n.code('Emit Quota', 'emit-quota'),
    n.sheetsUpdate('Update Applicants', 'Applicants'),
    n.sheetsAppend('Append Errors', 'Errors'),
    n.sheetsAppend('Append Run Log', 'RunLog'),
    n.sheetsAppend('Append Quota', 'Quota'),
    n.respond('Respond'),
  ],
  edges: [
    ['Draft Webhook', 'Verify Request'],
    ['Verify Request', 'Read Config'],
    ['Read Config', 'Read Templates'],
    ['Read Templates', 'Read Applicants'],
    ['Read Applicants', 'Generate Drafts'],
    ['Generate Drafts', 'Emit Applicant Rows'],
    ['Generate Drafts', 'Emit Error Rows'],
    ['Generate Drafts', 'Emit Run Log'],
    ['Generate Drafts', 'Emit Quota'],
    ['Generate Drafts', 'Respond'],
    ['Emit Applicant Rows', 'Update Applicants'],
    ['Emit Error Rows', 'Append Errors'],
    ['Emit Run Log', 'Append Run Log'],
    ['Emit Quota', 'Append Quota'],
  ],
});

const WF02B = () => workflow({
  id: 'WF-02B',
  name: 'WF-02b Template Generation',
  notes: 'Generates an HTML template from an HR brief. Always saved INACTIVE — a human previews and activates it before it can reach a candidate.',
  nodes: [
    n.webhook('Template Webhook', { path: 'template-generate' }),
    n.code('Verify Request', 'verify-request'),
    n.sheetsRead('Read Config', 'Config'),
    n.code('Generate Template', 'wf02b-template'),
    n.code('Emit Templates', 'emit-templates'),
    n.code('Emit Error Rows', 'emit-errors'),
    n.code('Emit Run Log', 'emit-runlog'),
    n.sheetsAppend('Append Templates', 'Templates'),
    n.sheetsAppend('Append Errors', 'Errors'),
    n.sheetsAppend('Append Run Log', 'RunLog'),
    n.respond('Respond'),
  ],
  edges: [
    ['Template Webhook', 'Verify Request'],
    ['Verify Request', 'Read Config'],
    ['Read Config', 'Generate Template'],
    ['Generate Template', 'Emit Templates'],
    ['Generate Template', 'Emit Error Rows'],
    ['Generate Template', 'Emit Run Log'],
    ['Generate Template', 'Respond'],
    ['Emit Templates', 'Append Templates'],
    ['Emit Error Rows', 'Append Errors'],
    ['Emit Run Log', 'Append Run Log'],
  ],
});

const WF03 = () => workflow({
  id: 'WF-03',
  name: 'WF-03 Send',
  notes: 'The only workflow that talks to a candidate. Refuses anything not APPROVED with a complete, fully-merged draft. On a dry run Emit Sends yields zero items, so Gmail never executes.',
  nodes: [
    n.webhook('Send Webhook', { path: 'send' }),
    n.code('Verify Request', 'verify-request'),
    n.sheetsRead('Read Config', 'Config'),
    n.sheetsRead('Read Applicants', 'Applicants'),
    n.sheetsRead('Read Email Log', 'EmailLog'),
    n.code('Plan Sends', 'wf03-plan-send'),

    // Planned side: dry-run records, rejections, run log.
    n.code('Emit Planned Applicant Rows', 'emit-applicants'),
    n.code('Emit Planned Email Log', 'emit-emaillog'),
    n.code('Emit Planned Errors', 'emit-errors'),
    n.code('Emit Planned Run Log', 'emit-runlog'),

    // Live side.
    n.code('Emit Sends', 'emit-sends'),
    n.gmailSend('Send via Gmail'),
    n.code('Record Sends', 'wf03-record-send'),
    n.code('Emit Sent Applicant Rows', 'emit-applicants'),
    n.code('Emit Sent Email Log', 'emit-emaillog'),
    n.code('Emit Sent Errors', 'emit-errors'),
    n.code('Emit Sent Run Log', 'emit-runlog'),

    n.sheetsUpdate('Update Applicants', 'Applicants'),
    n.sheetsAppend('Append Email Log', 'EmailLog'),
    n.sheetsAppend('Append Errors', 'Errors'),
    n.sheetsAppend('Append Run Log', 'RunLog'),
    n.respond('Respond'),
  ],
  edges: [
    ['Send Webhook', 'Verify Request'],
    ['Verify Request', 'Read Config'],
    ['Read Config', 'Read Applicants'],
    ['Read Applicants', 'Read Email Log'],
    ['Read Email Log', 'Plan Sends'],

    ['Plan Sends', 'Emit Planned Applicant Rows'],
    ['Plan Sends', 'Emit Planned Email Log'],
    ['Plan Sends', 'Emit Planned Errors'],
    ['Plan Sends', 'Emit Planned Run Log'],
    ['Plan Sends', 'Emit Sends'],
    ['Plan Sends', 'Respond'],

    ['Emit Sends', 'Send via Gmail'],
    ['Send via Gmail', 'Record Sends'],
    ['Record Sends', 'Emit Sent Applicant Rows'],
    ['Record Sends', 'Emit Sent Email Log'],
    ['Record Sends', 'Emit Sent Errors'],
    ['Record Sends', 'Emit Sent Run Log'],

    ['Emit Planned Applicant Rows', 'Update Applicants'],
    ['Emit Sent Applicant Rows', 'Update Applicants'],
    ['Emit Planned Email Log', 'Append Email Log'],
    ['Emit Sent Email Log', 'Append Email Log'],
    ['Emit Planned Errors', 'Append Errors'],
    ['Emit Sent Errors', 'Append Errors'],
    ['Emit Planned Run Log', 'Append Run Log'],
    ['Emit Sent Run Log', 'Append Run Log'],
  ],
});

const WF04 = () => workflow({
  id: 'WF-04',
  name: 'WF-04 Reply Watcher',
  notes: 'Polls the HR mailbox, matches replies to applicants by thread id, and classifies intent. Low-confidence results are escalated, never acted on.',
  nodes: [
    n.gmailTrigger('Gmail Trigger', { minutes: 5 }),
    n.sheetsRead('Read Config', 'Config'),
    n.sheetsRead('Read Applicants', 'Applicants'),
    n.code('Classify Replies', 'wf04-replies'),
    n.code('Emit Replies', 'emit-replies'),
    n.code('Emit Applicant Rows', 'emit-applicants'),
    n.code('Emit Error Rows', 'emit-errors'),
    n.code('Emit Run Log', 'emit-runlog'),
    n.sheetsAppend('Append Replies', 'Replies'),
    n.sheetsUpdate('Update Applicants', 'Applicants'),
    n.sheetsAppend('Append Errors', 'Errors'),
    n.sheetsAppend('Append Run Log', 'RunLog'),
  ],
  edges: [
    ['Gmail Trigger', 'Read Config'],
    ['Read Config', 'Read Applicants'],
    ['Read Applicants', 'Classify Replies'],
    ['Classify Replies', 'Emit Replies'],
    ['Classify Replies', 'Emit Applicant Rows'],
    ['Classify Replies', 'Emit Error Rows'],
    ['Classify Replies', 'Emit Run Log'],
    ['Emit Replies', 'Append Replies'],
    ['Emit Applicant Rows', 'Update Applicants'],
    ['Emit Error Rows', 'Append Errors'],
    ['Emit Run Log', 'Append Run Log'],
  ],
});

const WF05 = () => workflow({
  id: 'WF-05',
  name: 'WF-05 Follow-up Flagging',
  notes: 'Flags candidates who were emailed and never replied. V1 flags only — it never sends. Off by default.',
  nodes: [
    n.schedule('Daily at 09:00', { hour: 9 }),
    n.sheetsRead('Read Config', 'Config'),
    n.sheetsRead('Read Applicants', 'Applicants'),
    n.code('Plan Follow-ups', 'wf05-followup'),
    n.code('Emit Applicant Rows', 'emit-applicants'),
    n.code('Emit Run Log', 'emit-runlog'),
    n.sheetsUpdate('Update Applicants', 'Applicants'),
    n.sheetsAppend('Append Run Log', 'RunLog'),
  ],
  edges: [
    ['Daily at 09:00', 'Read Config'],
    ['Read Config', 'Read Applicants'],
    ['Read Applicants', 'Plan Follow-ups'],
    ['Plan Follow-ups', 'Emit Applicant Rows'],
    ['Plan Follow-ups', 'Emit Run Log'],
    ['Emit Applicant Rows', 'Update Applicants'],
    ['Emit Run Log', 'Append Run Log'],
  ],
});

const WF90 = () => workflow({
  id: 'WF-90',
  name: 'WF-90 Error Handler',
  notes: 'Set as the Error Workflow on every other workflow. Catches anything unhandled, writes it to the Errors tab, and emails the operator for fatal problems only.',
  nodes: [
    n.errorTrigger('On any workflow error'),
    n.code('Format Error', 'wf90-error'),
    n.code('Emit Error Rows', 'emit-errors'),
    n.code('Emit Run Log', 'emit-runlog'),
    n.sheetsAppend('Append Errors', 'Errors'),
    n.sheetsAppend('Append Run Log', 'RunLog'),
    n.ifBool('Fatal?', '={{ $json.should_alert }}'),
    n.gmailAlert('Email Operator'),
  ],
  edges: [
    ['On any workflow error', 'Format Error'],
    ['Format Error', 'Emit Error Rows'],
    ['Format Error', 'Emit Run Log'],
    ['Format Error', 'Fatal?'],
    ['Emit Error Rows', 'Append Errors'],
    ['Emit Run Log', 'Append Run Log'],
    ['Fatal?', 'Email Operator', 0],
  ],
});

const WF91 = () => workflow({
  id: 'WF-91',
  name: 'WF-91 Heartbeat',
  notes: 'Detects the one failure nothing else can: n8n not running at all. The dashboard shows a stale heartbeat as a red banner.',
  nodes: [
    n.schedule('Every 10 minutes', { minutes: 10 }),
    n.code('Heartbeat', 'wf91-heartbeat'),
    n.code('Emit Run Log', 'emit-runlog'),
    n.sheetsAppend('Append Run Log', 'RunLog'),
  ],
  edges: [
    ['Every 10 minutes', 'Heartbeat'],
    ['Heartbeat', 'Emit Run Log'],
    ['Emit Run Log', 'Append Run Log'],
  ],
});

export const WORKFLOWS = [WF00, WF01, WF02, WF02B, WF03, WF04, WF05, WF90, WF91];
