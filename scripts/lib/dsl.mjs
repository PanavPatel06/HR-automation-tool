/**
 * A tiny DSL for describing n8n workflows in readable JS instead of hand-edited
 * JSON. `npm run build:workflows` renders these to n8n/workflows/*.json.
 *
 * Credentials are referenced by NAME. n8n matches on id first and falls back to
 * showing the name, so after importing you pick the credential once per node
 * type — see docs/deployment.md.
 */

import { bundleNode } from './bundle.mjs';

export const CREDENTIALS = {
  sheets: { googleApi: { id: 'hr-sheets-sa', name: 'HR Sheets Service Account' } },
  gmail: { gmailOAuth2: { id: 'hr-gmail', name: 'HR Gmail' } },
};

/** Deterministic ids keep regenerated JSON diff-clean. */
function idFor(workflowId, nodeName) {
  const slug = nodeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${workflowId.toLowerCase()}-${slug}`;
}

const SHEET_RL = (tab) => ({
  documentId: { __rl: true, value: '={{ $env.SHEET_ID }}', mode: 'id' },
  sheetName: { __rl: true, value: tab, mode: 'name' },
});

// --- node constructors ------------------------------------------------------

export const node = {
  manualTrigger: (name = 'Run manually') => ({
    name, type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {},
  }),

  webhook: (name, { path, method = 'POST' }) => ({
    name, type: 'n8n-nodes-base.webhook', typeVersion: 2,
    parameters: { httpMethod: method, path, responseMode: 'responseNode', options: { rawBody: false } },
    webhookId: `hr-${path}`,
  }),

  schedule: (name, { minutes, hour }) => ({
    name, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2,
    parameters: {
      rule: {
        interval: hour !== undefined
          ? [{ field: 'hours', hoursInterval: 24, triggerAtHour: hour }]
          : [{ field: 'minutes', minutesInterval: minutes }],
      },
    },
  }),

  gmailTrigger: (name, { minutes = 5 } = {}) => ({
    name, type: 'n8n-nodes-base.gmailTrigger', typeVersion: 1.2,
    parameters: {
      pollTimes: { item: [{ mode: 'custom', cronExpression: `*/${minutes} * * * *` }] },
      simple: false,
      filters: { q: 'is:unread -from:me' },
      options: { downloadAttachments: false },
    },
    credentials: CREDENTIALS.gmail,
  }),

  errorTrigger: (name = 'On any workflow error') => ({
    name, type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, parameters: {},
  }),

  /** Code node whose body is bundled from n8n/src/nodes/<src>.js */
  code: (name, src, { mode = 'runOnceForAllItems' } = {}) => {
    const bundled = bundleNode(src);
    return {
      name, type: 'n8n-nodes-base.code', typeVersion: 2,
      parameters: { mode, jsCode: bundled.code },
      _src: src,
      _nodeRefs: bundled.nodeRefs,
    };
  },

  /**
   * `executeOnce` matters more than it looks: a Sheets node runs once per input
   * item by default, so chained reads would otherwise re-read the sheet once
   * for every row the previous read returned.
   */
  sheetsRead: (name, tab, { alwaysOutputData = true } = {}) => ({
    name, type: 'n8n-nodes-base.googleSheets', typeVersion: 4.5,
    parameters: {
      authentication: 'serviceAccount',
      resource: 'sheet', operation: 'read',
      ...SHEET_RL(tab),
      options: {},
    },
    credentials: CREDENTIALS.sheets,
    alwaysOutputData,
    executeOnce: true,
  }),

  sheetsAppend: (name, tab) => ({
    name, type: 'n8n-nodes-base.googleSheets', typeVersion: 4.5,
    parameters: {
      authentication: 'serviceAccount',
      resource: 'sheet', operation: 'append',
      ...SHEET_RL(tab),
      columns: { mappingMode: 'autoMapInputData', matchingColumns: [], value: {} },
      options: { cellFormat: 'USER_ENTERED' },
    },
    credentials: CREDENTIALS.sheets,
    // A failed audit write must not abort the run it is auditing.
    onError: 'continueRegularOutput',
  }),

  /** Matches on row_number, which the read operation emits for every row. */
  sheetsUpdate: (name, tab, { matchOn = 'row_number' } = {}) => ({
    name, type: 'n8n-nodes-base.googleSheets', typeVersion: 4.5,
    parameters: {
      authentication: 'serviceAccount',
      resource: 'sheet', operation: 'update',
      ...SHEET_RL(tab),
      columns: { mappingMode: 'autoMapInputData', matchingColumns: [matchOn], value: {} },
      options: { cellFormat: 'USER_ENTERED' },
    },
    credentials: CREDENTIALS.sheets,
  }),

  gmailSend: (name) => ({
    name, type: 'n8n-nodes-base.gmail', typeVersion: 2.1,
    parameters: {
      resource: 'message', operation: 'send',
      sendTo: '={{ $json.to }}',
      subject: '={{ $json.subject }}',
      emailType: 'html',
      message: '={{ $json.html }}',
      options: { appendAttribution: false },
    },
    credentials: CREDENTIALS.gmail,
    // Per-recipient isolation: one bad address must not abort a batch of 100.
    onError: 'continueRegularOutput',
    retryOnFail: true,
    maxTries: 2,
  }),

  /** Operator alert. Plain text, no template, so it cannot itself fail to render. */
  gmailAlert: (name) => ({
    name, type: 'n8n-nodes-base.gmail', typeVersion: 2.1,
    parameters: {
      resource: 'message', operation: 'send',
      sendTo: '={{ $env.ALERT_EMAIL }}',
      subject: '={{ $json.alert_subject }}',
      emailType: 'text',
      message: '={{ $json.alert_body }}',
      options: { appendAttribution: false },
    },
    credentials: CREDENTIALS.gmail,
    onError: 'continueRegularOutput',
  }),

  /** Boolean split on a field the upstream code node set. */
  ifBool: (name, expression) => ({
    name, type: 'n8n-nodes-base.if', typeVersion: 2.2,
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{
          id: `${name}-cond`,
          leftValue: expression,
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        }],
        combinator: 'and',
      },
      looseTypeValidation: true,
      options: {},
    },
  }),

  respond: (name = 'Respond') => ({
    name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1,
    parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json) }}', options: {} },
  }),

  noOp: (name) => ({ name, type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} }),
};

// --- graph assembly ---------------------------------------------------------

/**
 * @param {object} spec
 * @param {string} spec.id      e.g. 'WF-01'
 * @param {string} spec.name
 * @param {object[]} spec.nodes
 * @param {Array} spec.edges    ['A','B'] or ['A', 'B', outputIndex]
 */
export function workflow(spec) {
  const { id, name, nodes, edges, tags = [], notes = '' } = spec;

  const byName = new Map();
  for (const n of nodes) {
    if (byName.has(n.name)) throw new Error(`${id}: duplicate node name "${n.name}"`);
    byName.set(n.name, n);
  }

  // Depth = longest path from a trigger, so the layout reads left to right.
  const depth = new Map(nodes.map((n) => [n.name, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    for (const [from, to] of edges) {
      const d = (depth.get(from) ?? 0) + 1;
      if (d > (depth.get(to) ?? 0)) depth.set(to, d);
    }
  }
  const lane = new Map();
  const positioned = nodes.map((n) => {
    const d = depth.get(n.name) ?? 0;
    const row = lane.get(d) ?? 0;
    lane.set(d, row + 1);
    const { _src, _nodeRefs, ...rest } = n;
    return { ...rest, id: idFor(id, n.name), position: [220 + d * 260, 180 + row * 180] };
  });

  const connections = {};
  for (const [from, to, outputIndex = 0] of edges) {
    if (!byName.has(from)) throw new Error(`${id}: edge from unknown node "${from}"`);
    if (!byName.has(to)) throw new Error(`${id}: edge to unknown node "${to}"`);
    connections[from] = connections[from] || { main: [] };
    while (connections[from].main.length <= outputIndex) connections[from].main.push([]);
    connections[from].main[outputIndex].push({ node: to, type: 'main', index: 0 });
  }

  return {
    _meta: { id, notes, nodes },
    json: {
      name,
      nodes: positioned,
      connections,
      settings: {
        executionOrder: 'v1',
        saveManualExecutions: true,
        saveDataErrorExecution: 'all',
        saveDataSuccessExecution: 'all',
        // Every workflow reports failures through WF-90.
        errorWorkflow: id === 'WF-90' ? undefined : 'WF-90 Error Handler',
      },
      tags: ['hr-automation', ...tags],
      active: false,
      versionId: `${id.toLowerCase()}-v1`,
      meta: { instanceId: 'hr-automation' },
      pinData: {},
    },
  };
}
