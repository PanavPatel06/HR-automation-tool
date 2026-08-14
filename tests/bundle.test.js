'use strict';
/**
 * Executes the *bundled* Code-node bodies — the exact strings that end up
 * inside the workflow JSON — against fake n8n globals.
 *
 * Unit tests cover the library; this covers the seam between the library and
 * n8n: bundling, the `$('Node')` reads, and the row arrays each emit-* node
 * expects to find.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

let bundleNode;
test.before(async () => { ({ bundleNode } = await import('../scripts/lib/bundle.mjs')); });

/**
 * Build the n8n sandbox a Code node sees, from a map of node name -> rows.
 *
 * `allowBuiltin` models NODE_FUNCTION_ALLOW_BUILTIN: when false, `require` is
 * undefined, which is exactly what n8n does out of the box.
 */
function sandbox({ nodes = {}, env = {}, input = [], statics = {}, http, allowBuiltin = true } = {}) {
  const items = (rows) => rows.map((json) => ({ json }));
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`test sandbox: no node named "${name}"`);
    return { all: () => items(nodes[name]), first: () => items(nodes[name])[0] };
  };
  const $input = { all: () => items(input), first: () => items(input)[0] };
  const ctx = http ? { helpers: { httpRequest: http } } : {};
  return { $, $env: env, $input, $getWorkflowStaticData: () => statics, ctx, allowBuiltin };
}

async function run(nodeName, sb) {
  const { code } = bundleNode(nodeName);
  const fn = new AsyncFunction('$', '$env', '$input', '$getWorkflowStaticData', 'console', 'require', code);
  return fn.call(
    sb.ctx, sb.$, sb.$env, sb.$input, sb.$getWorkflowStaticData, { log: () => {} },
    sb.allowBuiltin ? require : undefined
  );
}

const CONFIG_ROWS = [
  { key: 'toggle_intake', value: 'true', type: 'boolean' },
  { key: 'toggle_draft', value: 'true', type: 'boolean' },
  { key: 'toggle_send', value: 'true', type: 'boolean' },
  { key: 'dry_run', value: 'false', type: 'boolean' },
  { key: 'categories', value: 'Junior,Senior', type: 'list' },
  { key: 'batch_size', value: '5', type: 'number' },
  { key: 'send_daily_cap', value: '10', type: 'number' },
  { key: 'company_name', value: '3Space', type: 'string' },
  { key: 'hr_name', value: 'Priya', type: 'string' },
  { key: 'hr_signature', value: 'Best,<br>Priya', type: 'string' },
];
const ROLE_ROWS = [{ role_id: 'R1', title: 'Frontend Engineer', is_open: 'TRUE' }];

// --- WF-01 ------------------------------------------------------------------

test('bundled WF-01 validates a new row and emits the sheet writes', async () => {
  const sb = sandbox({
    nodes: {
      'Read Config': CONFIG_ROWS,
      'Read Job Roles': ROLE_ROWS,
      'Read Applicants': [
        { row_number: 2, name: 'Asha Menon', email: 'ASHA@example.com', job_role: 'frontend engineer', category: 'Junior' },
        { row_number: 3, name: '', email: 'oops', job_role: 'Frontend Engineer' },
      ],
    },
  });
  const [out] = await run('wf01-intake', sb);
  const j = out.json;

  assert.equal(j.applicant_rows.length, 2, 'both the good and the blocked row are written back');
  assert.equal(j.applicant_rows[0].email, 'asha@example.com');
  assert.equal(j.applicant_rows[0].row_number, 2, 'row_number is preserved for the update match');
  assert.ok(!('_row_number' in j.applicant_rows[0]), 'internal field is stripped before the sheet write');
  assert.equal(j.applicant_rows[1].status, 'blocked');
  assert.equal(j.error_rows.length, 1);
  assert.equal(j.error_rows[0].error_code, 'E-INTAKE-MISSING');
  assert.equal(j.runlog_rows.length, 1);
  assert.equal(j.items_failed, 1);
});

test('bundled WF-01 respects the Config toggle and says so', async () => {
  const sb = sandbox({
    nodes: {
      'Read Config': [{ key: 'toggle_intake', value: 'false', type: 'boolean' }],
      'Read Job Roles': ROLE_ROWS,
      'Read Applicants': [{ row_number: 2, name: 'Asha', email: 'a@b.com', job_role: 'Frontend Engineer' }],
    },
  });
  const [out] = await run('wf01-intake', sb);
  assert.equal(out.json.status, 'skipped');
  assert.equal(out.json.applicant_rows.length, 0);
  assert.match(out.json.notes, /toggle_intake is OFF/);
});

test('bundled WF-01 turns an unreadable sheet into a recorded error, not a crash', async () => {
  const sb = sandbox({ nodes: { 'Read Config': CONFIG_ROWS, 'Read Job Roles': ROLE_ROWS } });
  const [out] = await run('wf01-intake', sb); // 'Read Applicants' missing -> throws inside
  assert.equal(out.json.ok, false);
  assert.equal(out.json.error_rows.length, 1);
  assert.equal(out.json.runlog_rows.length, 1, 'the run is still logged');
});

// --- emit-* fan-out ---------------------------------------------------------

test('emit nodes turn plan arrays into items, and no-op cleanly when empty', async () => {
  const plan = { applicant_rows: [{ applicant_id: 'A' }, { applicant_id: 'B' }], error_rows: [], runlog_rows: [{ status: 'ok' }] };
  assert.equal((await run('emit-applicants', sandbox({ input: [plan] }))).length, 2);
  assert.equal((await run('emit-errors', sandbox({ input: [plan] }))).length, 0, 'an empty branch simply stops');
  assert.equal((await run('emit-runlog', sandbox({ input: [plan] }))).length, 1);
  assert.equal((await run('emit-sends', sandbox({ input: [{}] }))).length, 0, 'a plan with no send_items sends nothing');
});

// --- WF-03: the safety-critical path ---------------------------------------

const APPROVED_ROW = {
  row_number: 2, applicant_id: 'APP-1', name: 'Asha', email: 'asha@example.com',
  stage: 'APPROVED', email_subject: 'Hello', email_html: '<p>Hi Asha</p>', email_status: 'none',
};

test('bundled WF-03 queues an approved row and leaves the audit trail empty until it sends', async () => {
  const sb = sandbox({
    nodes: {
      'Verify Request': [{ ids: ['APP-1'], _verified: true }],
      'Read Config': CONFIG_ROWS,
      'Read Applicants': [APPROVED_ROW],
      'Read Email Log': [],
    },
  });
  const [out] = await run('wf03-plan-send', sb);
  assert.equal(out.json.send_items.length, 1);
  assert.equal(out.json.send_items[0].to, 'asha@example.com');
  assert.equal(out.json.dry_run, false);
  assert.equal(out.json.error_rows.length, 0);
});

test('bundled WF-03 on a dry run sends nothing and records the intent', async () => {
  const sb = sandbox({
    nodes: {
      'Verify Request': [{}],
      'Read Config': CONFIG_ROWS.map((r) => (r.key === 'dry_run' ? { ...r, value: 'true' } : r)),
      'Read Applicants': [APPROVED_ROW],
      'Read Email Log': [],
    },
  });
  const [out] = await run('wf03-plan-send', sb);
  assert.equal(out.json.send_items.length, 0, 'Gmail receives zero items, so it never executes');
  assert.equal(out.json.emaillog_rows[0].result, 'dry-run');
  assert.equal(out.json.applicant_rows[0].stage, 'APPROVED', 'a dry run never advances the stage');
  assert.match(out.json.notes, /DRY RUN/);
});

test('bundled WF-03 refuses an unapproved row and files a typed error', async () => {
  const sb = sandbox({
    nodes: {
      'Verify Request': [{}],
      'Read Config': CONFIG_ROWS,
      'Read Applicants': [{ ...APPROVED_ROW, stage: 'DRAFTED' }],
      'Read Email Log': [],
    },
  });
  const [out] = await run('wf03-plan-send', sb);
  assert.equal(out.json.send_items.length, 0);
  assert.equal(out.json.error_rows[0].error_code, 'E-MAIL-NODRAFT');
  assert.equal(out.json.applicant_rows[0].status, 'failed');
});

test('bundled WF-03 honours the send toggle', async () => {
  const sb = sandbox({
    nodes: {
      'Verify Request': [{}],
      'Read Config': CONFIG_ROWS.map((r) => (r.key === 'toggle_send' ? { ...r, value: 'false' } : r)),
      'Read Applicants': [APPROVED_ROW],
      'Read Email Log': [],
    },
  });
  const [out] = await run('wf03-plan-send', sb);
  assert.equal(out.json.status, 'skipped');
  assert.equal(out.json.send_items.length, 0);
});

test('bundled WF-03 counts today\'s sends against the daily cap', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const sb = sandbox({
    nodes: {
      'Verify Request': [{}],
      'Read Config': CONFIG_ROWS.map((r) => (r.key === 'send_daily_cap' ? { ...r, value: '2' } : r)),
      'Read Applicants': [APPROVED_ROW, { ...APPROVED_ROW, row_number: 3, applicant_id: 'APP-2', email: 'b@example.com' }],
      'Read Email Log': [{ at: `${today}T01:00:00Z`, result: 'sent' }, { at: `${today}T02:00:00Z`, result: 'sent' }],
    },
  });
  const [out] = await run('wf03-plan-send', sb);
  assert.equal(out.json.send_items.length, 0, 'cap of 2 already consumed today');
  assert.equal(out.json.error_rows[0].error_code, 'E-MAIL-LIMIT');
});

test('bundled WF-03 recording pairs Gmail results with the right applicants', async () => {
  const planned = [
    { applicant_id: 'APP-1', to: 'a@x.com', subject: 's', html: '<p>h</p>', dry_run: false, _row_number: 2 },
    { applicant_id: 'APP-2', to: 'b@x.com', subject: 's', html: '<p>h</p>', dry_run: false, _row_number: 3 },
  ];
  const sb = sandbox({
    nodes: { 'Plan Sends': [{ correlation_id: 'WF-03-TEST' }], 'Emit Sends': planned },
    // Gmail with continueOnFail emits one item per input, in order.
    input: [{ id: 'm1', threadId: 't1' }, { error: 'mailbox unavailable' }],
  });
  const [out] = await run('wf03-record-send', sb);
  const rows = out.json.applicant_rows;
  assert.equal(rows[0].applicant_id, 'APP-1');
  assert.equal(rows[0].stage, 'SENT');
  assert.equal(rows[0].thread_id, 't1', 'thread id is captured — reply matching depends on it');
  assert.equal(rows[1].applicant_id, 'APP-2');
  assert.equal(rows[1].stage, 'APPROVED', 'the failed one stays retryable');
  assert.equal(rows[1].error_code, 'E-MAIL-BOUNCE');
  assert.equal(out.json.emaillog_rows.length, 2, 'both attempts are audited');
  assert.equal(out.json.error_rows.length, 1);
});

// --- WF-02: full draft path with a stubbed provider ------------------------

test('bundled WF-02 drafts through the AI router and updates the sheet', async () => {
  const calls = [];
  const http = async (req) => {
    calls.push(req);
    return {
      statusCode: 200,
      headers: {},
      body: { choices: [{ message: { content: JSON.stringify({ subject: 'ignored', body_html: '<p>We liked your portfolio.</p>' }) }, finish_reason: 'stop' }], usage: { total_tokens: 320 } },
    };
  };
  const sb = sandbox({
    http,
    env: { GROQ_API_KEY: 'gk', GEMINI_API_KEY: 'ge' },
    nodes: {
      'Verify Request': [{ ids: ['APP-1'] }],
      'Read Config': CONFIG_ROWS,
      'Read Templates': [{
        template_id: 'T1', name: 'Outreach', job_role: '', category: '', stage: 'outreach',
        subject: 'Your application for {{job_role}}',
        html: '<p>Hi {{first_name}},</p>{{ai_body}}<p>{{hr_signature}}</p>',
        is_active: 'TRUE', is_default: 'TRUE',
      }],
      'Read Applicants': [{ row_number: 2, applicant_id: 'APP-1', name: 'Asha Menon', email: 'a@x.com', job_role: 'Frontend Engineer', category: 'Junior', stage: 'NEW' }],
    },
  });

  const [out] = await run('wf02-draft', sb);
  const j = out.json;
  assert.equal(j.items_failed, 0, JSON.stringify(j.errors));
  assert.equal(j.applicant_rows.length, 1);
  assert.equal(j.applicant_rows[0].stage, 'DRAFTED');
  assert.match(j.applicant_rows[0].email_html, /Hi Asha,/);
  assert.match(j.applicant_rows[0].email_html, /We liked your portfolio\./);
  assert.ok(!/\{\{/.test(j.applicant_rows[0].email_html));
  assert.equal(j.quota_rows.length, 1, 'quota usage is reported for the dashboard');
  assert.match(calls[0].url, /api\.groq\.com/);
});

test('bundled WF-02 skips the model entirely for a template without {{ai_body}}', async () => {
  let called = false;
  const sb = sandbox({
    http: async () => { called = true; throw new Error('should not be called'); },
    env: { GROQ_API_KEY: 'gk' },
    nodes: {
      'Verify Request': [{}],
      'Read Config': CONFIG_ROWS,
      'Read Templates': [{ template_id: 'T1', stage: 'outreach', subject: 'Hi {{first_name}}', html: '<p>Hi {{first_name}}, thanks.</p>', is_active: 'TRUE', is_default: 'TRUE' }],
      'Read Applicants': [{ row_number: 2, applicant_id: 'APP-1', name: 'Asha', email: 'a@x.com', job_role: 'Frontend Engineer', stage: 'NEW' }],
    },
  });
  const [out] = await run('wf02-draft', sb);
  assert.equal(called, false, 'zero tokens spent on a deterministic template');
  assert.equal(out.json.applicant_rows[0].stage, 'DRAFTED');
});

test('bundled WF-02 isolates a failing applicant from the rest of the batch', async () => {
  let n = 0;
  const http = async () => {
    n++;
    // First applicant: the model returns junk twice (original + repair), and
    // there is no Gemini key, so that item fails. The second succeeds.
    const content = n <= 2 ? 'not json at all' : JSON.stringify({ subject: 's', body_html: '<p>ok</p>' });
    return { statusCode: 200, headers: {}, body: { choices: [{ message: { content } }], usage: { total_tokens: 100 } } };
  };
  const sb = sandbox({
    http,
    env: { GROQ_API_KEY: 'gk' },
    nodes: {
      'Verify Request': [{}],
      'Read Config': CONFIG_ROWS,
      'Read Templates': [{ template_id: 'T1', stage: 'outreach', subject: 'Hi', html: '<p>Hi {{first_name}},</p>{{ai_body}}', is_active: 'TRUE', is_default: 'TRUE' }],
      'Read Applicants': [
        { row_number: 2, applicant_id: 'APP-1', name: 'Asha', email: 'a@x.com', job_role: 'Frontend Engineer', stage: 'NEW' },
        { row_number: 3, applicant_id: 'APP-2', name: 'Ravi', email: 'b@x.com', job_role: 'Frontend Engineer', stage: 'NEW' },
      ],
    },
  });
  const [out] = await run('wf02-draft', sb);
  assert.equal(out.json.items_ok, 1);
  assert.equal(out.json.items_failed, 1);
  assert.equal(out.json.error_rows[0].error_code, 'E-LLM-SCHEMA');
  assert.equal(out.json.applicant_rows.find((r) => r.applicant_id === 'APP-2').stage, 'DRAFTED');
  assert.equal(out.json.applicant_rows.find((r) => r.applicant_id === 'APP-1').stage, 'FAILED');
});

// --- WF-90 ------------------------------------------------------------------

test('bundled WF-90 recovers a typed code from a thrown message', async () => {
  const sb = sandbox({
    input: [{
      workflow: { name: 'WF-03 Send' },
      execution: { id: '42', url: 'https://n8n/exec/42', lastNodeExecuted: 'Send via Gmail', mode: 'webhook', error: { message: 'E-MAIL-AUTH: credential expired' } },
    }],
  });
  const [out] = await run('wf90-error', sb);
  assert.equal(out.json.error_rows[0].error_code, 'E-MAIL-AUTH');
  assert.equal(out.json.error_rows[0].severity, 'fatal');
  assert.equal(out.json.should_alert, true, 'fatal problems interrupt someone');
  assert.match(out.json.alert_subject, /E-MAIL-AUTH/);
});

test('bundled WF-90 handles an untyped crash without alerting', async () => {
  const sb = sandbox({
    input: [{ workflow: { name: 'WF-01 Intake' }, execution: { lastNodeExecuted: 'Plan Intake', error: { message: 'Cannot read properties of undefined' } } }],
  });
  const [out] = await run('wf90-error', sb);
  assert.equal(out.json.error_rows[0].error_code, 'E-UNKNOWN');
  assert.equal(out.json.should_alert, false);
  assert.equal(out.json.runlog_rows[0].status, 'failed');
});

// --- verify-request ---------------------------------------------------------

test('bundled verify-request accepts a correctly signed call and rejects a forged one', async () => {
  const { signPayload } = require('../n8n/src/lib/util');
  const body = { ids: ['APP-1'], action: 'draft' };
  const ts = Math.floor(Date.now() / 1000);
  const { signature } = signPayload('topsecret', body, ts);

  const good = sandbox({ env: { N8N_WEBHOOK_SECRET: 'topsecret' }, input: [{ body, headers: { 'X-HR-Timestamp': String(ts), 'X-HR-Signature': signature } }] });
  const [out] = await run('verify-request', good);
  assert.equal(out.json._verified, true);
  assert.deepEqual(out.json.ids, ['APP-1']);

  const forged = sandbox({ env: { N8N_WEBHOOK_SECRET: 'topsecret' }, input: [{ body, headers: { 'x-hr-timestamp': String(ts), 'x-hr-signature': 'v1=deadbeef' } }] });
  await assert.rejects(() => run('verify-request', forged), /signature rejected/);

  const unsigned = sandbox({ env: { N8N_WEBHOOK_SECRET: 'topsecret' }, input: [{ body, headers: {} }] });
  await assert.rejects(() => run('verify-request', unsigned), /signature rejected/);
});

test('bundled verify-request refuses to run when no secret is configured', async () => {
  const sb = sandbox({ env: {}, input: [{ body: {}, headers: { 'x-hr-timestamp': '1', 'x-hr-signature': 'v1=x' } }] });
  await assert.rejects(() => run('verify-request', sb), /signature rejected/);
});

test('without NODE_FUNCTION_ALLOW_BUILTIN the signature check fails loudly with the fix', async () => {
  const { signPayload } = require('../n8n/src/lib/util');
  const body = { ids: ['APP-1'] };
  const ts = Math.floor(Date.now() / 1000);
  const { signature } = signPayload('topsecret', body, ts);
  const sb = sandbox({
    allowBuiltin: false,
    env: { N8N_WEBHOOK_SECRET: 'topsecret' },
    input: [{ body, headers: { 'x-hr-timestamp': String(ts), 'x-hr-signature': signature } }],
  });
  await assert.rejects(() => run('verify-request', sb), /NODE_FUNCTION_ALLOW_BUILTIN/,
    'it must never silently accept an unverified request');
});
