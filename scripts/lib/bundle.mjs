/**
 * Inlines the tested library into an n8n Code node.
 *
 * n8n Code nodes cannot `require` local files, which normally forces workflow
 * logic to live as untestable strings inside JSON. Instead, node bodies are
 * real files in n8n/src/nodes/ that declare their dependencies with a
 * `// @requires` header; this bundler resolves them, strips the CommonJS
 * plumbing, and concatenates. The same source is what tests/ exercises.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIB_DIR = join(ROOT, 'n8n', 'src', 'lib');
const NODE_DIR = join(ROOT, 'n8n', 'src', 'nodes');

const RELATIVE_REQUIRE = /^\s*(?:const|let|var)\s+\{?[^}]*\}?\s*=\s*require\(['"]\.\/[^'"]+['"]\);?\s*$/gm;
const EXPORTS_BLOCK = /^module\.exports\s*=[\s\S]*$/m;
const USE_STRICT = /^\s*['"]use strict['"];\s*$/gm;

/** Which local modules does this source pull in? */
function localDeps(source) {
  const deps = [];
  const re = /require\(['"]\.\/([\w-]+)['"]\)/g;
  let m;
  while ((m = re.exec(source)) !== null) if (!deps.includes(m[1])) deps.push(m[1]);
  return deps;
}

function stripModulePlumbing(source) {
  return source
    .replace(RELATIVE_REQUIRE, '')
    .replace(EXPORTS_BLOCK, '')
    .replace(USE_STRICT, '')
    .trim();
}

/** Depth-first, so a module always appears after the modules it depends on. */
function resolveOrder(names, seen = new Set(), order = []) {
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const path = join(LIB_DIR, `${name}.js`);
    if (!existsSync(path)) throw new Error(`Unknown lib module "${name}" (expected ${path})`);
    const src = readFileSync(path, 'utf8');
    resolveOrder(localDeps(src), seen, order);
    order.push(name);
  }
  return order;
}

/**
 * @param {string} nodeName base name of a file in n8n/src/nodes/
 * @returns {{code: string, libs: string[], nodeRefs: string[]}}
 */
export function bundleNode(nodeName) {
  const path = join(NODE_DIR, `${nodeName}.js`);
  if (!existsSync(path)) throw new Error(`Missing node body: ${path}`);
  const raw = readFileSync(path, 'utf8');

  // `[ \t]*` not `\s+`: \s matches newlines, which would swallow the next line
  // as a dependency list when @requires is empty.
  const declared = (raw.match(/^\/\/[ \t]*@requires[ \t]*(.*)$/m) || [null, ''])[1]
    .split(/\s+/).map((s) => s.trim()).filter(Boolean);
  const libs = resolveOrder([...new Set([...declared, ...localDeps(raw)])]);

  const parts = [
    '// ---------------------------------------------------------------------',
    '// GENERATED FILE — do not edit inside n8n.',
    `// Source: n8n/src/nodes/${nodeName}.js  +  n8n/src/lib/{${libs.join(',')}}.js`,
    '// Edit the source and run `npm run build:workflows`.',
    '// ---------------------------------------------------------------------',
  ];
  for (const lib of libs) {
    parts.push(`// ===== lib/${lib}.js =====`);
    parts.push(stripModulePlumbing(readFileSync(join(LIB_DIR, `${lib}.js`), 'utf8')));
  }
  parts.push(`// ===== nodes/${nodeName}.js =====`);
  parts.push(stripModulePlumbing(raw));

  return { code: parts.join('\n\n'), libs, nodeRefs: referencedNodes(raw) };
}

/** Every `$('Some Node')` the body reads from — used to validate the graph. */
export function referencedNodes(source) {
  const out = [];
  const re = /\$\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(source)) !== null) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export { ROOT, LIB_DIR, NODE_DIR };
