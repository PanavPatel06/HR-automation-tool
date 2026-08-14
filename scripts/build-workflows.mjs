#!/usr/bin/env node
/**
 * Renders scripts/workflows.mjs to n8n/workflows/*.json and validates the graphs.
 *
 *   npm run build:workflows     write the JSON
 *   npm run check:workflows     validate + fail if the committed JSON is stale
 *
 * The validation matters because n8n only reports a broken `$('Node')`
 * reference at runtime, halfway through a batch. Checking it here turns that
 * into a build failure instead.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { WORKFLOWS } from './workflows.mjs';
import { ROOT } from './lib/bundle.mjs';

const require = createRequire(import.meta.url);
const { V1_TABS } = require(join(ROOT, 'n8n/src/lib/schema.js'));

const OUT_DIR = join(ROOT, 'n8n', 'workflows');
const CHECK = process.argv.includes('--check');

const problems = [];
const built = [];

/** Every node that can reach `target` by following edges backwards. */
function ancestorsOf(target, connections) {
  const parents = new Map();
  for (const [from, conn] of Object.entries(connections)) {
    for (const output of conn.main || []) {
      for (const link of output || []) {
        if (!parents.has(link.node)) parents.set(link.node, new Set());
        parents.get(link.node).add(from);
      }
    }
  }
  const seen = new Set();
  const stack = [...(parents.get(target) || [])];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(parents.get(cur) || []));
  }
  return seen;
}

function validate(id, wf, meta) {
  const fail = (msg) => problems.push(`${id}: ${msg}`);
  const names = new Set(wf.nodes.map((x) => x.name));

  // 1. Every $('X') must exist and be upstream — otherwise it is undefined at runtime.
  for (const spec of meta.nodes) {
    if (!spec._nodeRefs || !spec._nodeRefs.length) continue;
    const ancestors = ancestorsOf(spec.name, wf.connections);
    for (const ref of spec._nodeRefs) {
      if (!names.has(ref)) fail(`node "${spec.name}" reads $('${ref}') but no such node exists`);
      else if (!ancestors.has(ref)) fail(`node "${spec.name}" reads $('${ref}') which is not upstream of it`);
    }
  }

  // 2. Nothing orphaned: every non-trigger node must be reachable from a trigger.
  const triggers = wf.nodes.filter((x) => /trigger|webhook/i.test(x.type)).map((x) => x.name);
  if (!triggers.length) fail('has no trigger node');
  const reachable = new Set(triggers);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [from, conn] of Object.entries(wf.connections)) {
      if (!reachable.has(from)) continue;
      for (const output of conn.main || []) {
        for (const link of output || []) {
          if (!reachable.has(link.node)) { reachable.add(link.node); changed = true; }
        }
      }
    }
  }
  for (const node of wf.nodes) {
    if (!reachable.has(node.name)) fail(`node "${node.name}" is unreachable from any trigger`);
  }

  // 3. Sheet tabs must be ones the bootstrap actually creates.
  for (const node of wf.nodes) {
    const tab = node.parameters?.sheetName?.value;
    if (node.type === 'n8n-nodes-base.googleSheets' && tab && !V1_TABS.includes(tab)) {
      fail(`node "${node.name}" targets tab "${tab}", which is not a V1 tab`);
    }
  }

  // 4. Code nodes must have a non-trivial body that actually parses.
  //    n8n compiles jsCode as an async function body, so top-level await and
  //    top-level return are both legal — AsyncFunction reproduces that exactly.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const node of wf.nodes) {
    if (node.type !== 'n8n-nodes-base.code') continue;
    const code = node.parameters?.jsCode || '';
    if (code.length < 50) fail(`code node "${node.name}" has a suspiciously short body`);
    if (/require\(['"]\.\//.test(code)) fail(`code node "${node.name}" still contains a relative require — the bundler failed`);
    if (/module\.exports/.test(code)) fail(`code node "${node.name}" still contains module.exports — the bundler failed`);
    try {
      new AsyncFunction(code);
    } catch (err) {
      fail(`code node "${node.name}" is not valid JavaScript: ${err.message}`);
    }
  }

  // 5. Anything that reads a webhook body must verify its signature first.
  const hasWebhook = wf.nodes.some((x) => x.type === 'n8n-nodes-base.webhook');
  const hasVerify = wf.nodes.some((x) => x.name === 'Verify Request');
  if (hasWebhook && !hasVerify && id !== 'WF-00') {
    fail('exposes a webhook without a "Verify Request" node — unsigned callers could trigger it');
  }
}

mkdirSync(OUT_DIR, { recursive: true });

for (const factory of WORKFLOWS) {
  const { json, _meta } = factory();
  validate(_meta.id, json, _meta);

  const file = join(OUT_DIR, `${_meta.id}-${json.name.replace(/^WF-\S+\s*/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}.json`);
  const text = JSON.stringify(json, null, 2) + '\n';

  if (CHECK) {
    if (!existsSync(file)) problems.push(`${_meta.id}: ${file} is missing — run npm run build:workflows`);
    else if (readFileSync(file, 'utf8') !== text) problems.push(`${_meta.id}: ${file} is stale — run npm run build:workflows`);
  } else {
    writeFileSync(file, text);
  }
  built.push({ id: _meta.id, name: json.name, file, nodes: json.nodes.length, bytes: text.length });
}

// A workflow file left behind after a rename would be silently imported.
if (!CHECK) {
  const expected = new Set(built.map((b) => b.file.split('/').pop()));
  for (const f of readdirSync(OUT_DIR)) {
    if (f.endsWith('.json') && !expected.has(f)) problems.push(`stale file n8n/workflows/${f} — delete it or restore its definition`);
  }
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${CHECK ? 'Checking' : 'Building'} ${built.length} workflows\n`);
for (const b of built) {
  console.log(`  ${pad(b.id, 7)} ${pad(b.name, 32)} ${pad(`${b.nodes} nodes`, 10)} ${(b.bytes / 1024).toFixed(0)} KB`);
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ✖ ${p}`);
  console.error('');
  process.exit(1);
}
console.log(`\n✔ ${CHECK ? 'workflows are valid and up to date' : `written to n8n/workflows/`}\n`);
