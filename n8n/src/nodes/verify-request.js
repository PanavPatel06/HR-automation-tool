// @requires errors util
//
// HMAC gate for every dashboard-triggered workflow. An unsigned or stale
// request is refused here, before any sheet is read or any email is composed.

let env = {};
try { env = $env || {}; } catch (_e) { env = {}; }

const req = $input.first().json || {};
const headers = {};
for (const [k, v] of Object.entries(req.headers || {})) headers[String(k).toLowerCase()] = v;
const body = req.body || {};

const secret = env.N8N_WEBHOOK_SECRET || '';
const verdict = verifySignature(secret, body, headers['x-hr-timestamp'], headers['x-hr-signature']);

if (!verdict.ok) {
  // Deliberately terse: never tell an unauthenticated caller which check failed
  // in detail. The reason is logged for the operator.
  console.log(`[verify-request] rejected: ${verdict.reason}`);
  throw new Error(`E-CONFIG-CRED: webhook signature rejected (${verdict.reason}).`);
}

return [{ json: { ...body, _verified: true, _received_at: nowIso() } }];
