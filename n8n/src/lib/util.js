'use strict';
/**
 * Small shared helpers: IDs, config coercion, and the HMAC scheme that lets n8n
 * trust a webhook came from the dashboard.
 */

/**
 * n8n's Code sandbox only exposes built-ins when NODE_FUNCTION_ALLOW_BUILTIN is
 * set. IDs degrade to Math.random without it; HMAC cannot, so it fails with a
 * config error rather than pretending to verify anything.
 */
let crypto = null;
try { crypto = require('crypto'); } catch (_e) { crypto = null; }

/** Unambiguous alphabet — no 0/O/1/I/L, because these get read aloud and retyped. */
const ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

const defaultRand = () => (crypto ? crypto.randomBytes(1)[0] / 256 : Math.random());

function randomId(length = 6, rand = defaultRand) {
  let out = '';
  for (let i = 0; i < length; i++) out += ID_ALPHABET[Math.floor(rand() * ID_ALPHABET.length) % ID_ALPHABET.length];
  return out;
}

/** APP-20260814-K7M2QX — sortable by eye, unique enough for this volume. */
function makeApplicantId(date = new Date(), rand) {
  const d = date.toISOString().slice(0, 10).replace(/-/g, '');
  return `APP-${d}-${randomId(6, rand)}`;
}

/** One per workflow execution. Ties rows, log lines, and errors together. */
function makeCorrelationId(workflow = 'WF', date = new Date(), rand) {
  const t = date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${workflow}-${t}-${randomId(4, rand)}`;
}

function nowIso(date = new Date()) { return date.toISOString(); }

function truthy(v) {
  if (typeof v === 'boolean') return v;
  return ['true', 'yes', '1', 'y', 'on'].includes(String(v == null ? '' : v).trim().toLowerCase());
}

/**
 * Turn the Config tab's rows into a typed object.
 * Unknown types fall through as strings rather than throwing — a bad `type`
 * cell should not take the pipeline down.
 */
function parseConfig(rows) {
  const out = {};
  for (const r of rows || []) {
    const key = String(r.key || '').trim();
    if (!key) continue;
    const raw = r.value == null ? '' : String(r.value);
    switch (String(r.type || 'string').trim().toLowerCase()) {
      case 'boolean': out[key] = truthy(raw); break;
      case 'number': { const n = Number(raw); out[key] = Number.isFinite(n) ? n : 0; break; }
      case 'list': out[key] = raw.split(',').map((s) => s.trim()).filter(Boolean); break;
      case 'json': try { out[key] = JSON.parse(raw); } catch (_e) { out[key] = null; } break;
      default: out[key] = raw;
    }
  }
  return out;
}

/** Chunk a list so batches respect Sheets write limits and model rate limits. */
function chunk(items, size) {
  const out = [];
  const n = Math.max(1, Number(size) || 1);
  for (let i = 0; i < (items || []).length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** Google Sheets caps a cell at 50k characters; truncate visibly, never silently. */
const CELL_LIMIT = 49000;
function fitCell(value) {
  const s = value == null ? '' : String(value);
  return s.length <= CELL_LIMIT ? s : s.slice(0, CELL_LIMIT) + '\n<!-- truncated for sheet cell limit -->';
}

// --- Webhook signing --------------------------------------------------------

/**
 * The dashboard signs `${timestamp}.${body}`; n8n recomputes and compares.
 * Timestamp is inside the signed payload so a captured request cannot be
 * replayed outside the tolerance window.
 */
function requireCrypto() {
  if (!crypto) {
    throw new Error('E-CONFIG-MISSING: node:crypto is unavailable in this sandbox. Set NODE_FUNCTION_ALLOW_BUILTIN=crypto on the n8n container — webhook signatures cannot be verified without it.');
  }
  return crypto;
}

/**
 * Recursively key-sorted JSON. The dashboard serialises an object, n8n parses
 * it and re-serialises to verify; without canonicalisation any key-order
 * difference across that hop would look like tampering.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function signPayload(secret, body, timestamp) {
  requireCrypto();
  const ts = String(timestamp);
  const payload = typeof body === 'string' ? body : canonicalJson(body);
  const mac = crypto.createHmac('sha256', String(secret)).update(`${ts}.${payload}`).digest('hex');
  return { signature: `v1=${mac}`, timestamp: ts };
}

function verifySignature(secret, body, timestamp, signature, { toleranceSec = 300, now = Date.now() } = {}) {
  requireCrypto();
  if (!secret) return { ok: false, reason: 'no-secret-configured' };
  if (!signature || !timestamp) return { ok: false, reason: 'missing-signature' };

  const age = Math.abs(now / 1000 - Number(timestamp));
  if (!Number.isFinite(age)) return { ok: false, reason: 'bad-timestamp' };
  if (age > toleranceSec) return { ok: false, reason: 'stale-timestamp' };

  const expected = signPayload(secret, body, timestamp).signature;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return { ok: false, reason: 'bad-signature' };
  return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'bad-signature' };
}

module.exports = {
  randomId, makeApplicantId, makeCorrelationId, nowIso, truthy,
  parseConfig, chunk, fitCell, CELL_LIMIT, signPayload, verifySignature, canonicalJson,
};
