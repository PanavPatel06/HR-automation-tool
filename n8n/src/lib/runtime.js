'use strict';
/**
 * The seam between the pure engine and n8n's Code-node sandbox.
 *
 * Everything n8n-specific lives here so the rest of the library stays testable
 * with plain Node. `ctx` is the Code node's `this`.
 */

const { AppError, toAppError, safeJson } = require('./errors');
const { makeCorrelationId, nowIso } = require('./util');

/**
 * HTTP adapter shaped for AiRouter.
 *
 * n8n's `this.helpers.httpRequest` is preferred (it respects proxy settings and
 * n8n's own timeouts), with `fetch` as a fallback for sandbox configurations
 * where helpers are not exposed. Non-2xx must come back as a value, not a
 * throw — the router classifies statuses itself.
 */
function makeHttp(ctx, { timeout = 60000 } = {}) {
  const helper = ctx && ctx.helpers && typeof ctx.helpers.httpRequest === 'function' ? ctx.helpers.httpRequest.bind(ctx.helpers) : null;

  return async function http(req) {
    if (helper) {
      const res = await helper({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
        json: true,
        timeout,
        returnFullResponse: true,
        ignoreHttpStatusErrors: true,
      });
      return { status: res.statusCode || res.status || 200, body: res.body, headers: res.headers || {} };
    }

    if (typeof fetch !== 'function') {
      throw new AppError('E-CONFIG-MISSING', 'No HTTP transport available in this n8n Code node (neither this.helpers.httpRequest nor fetch).', {});
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
        signal: controller.signal,
      });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch (_e) { body = text; }
      const headers = {};
      res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      return { status: res.status, body, headers };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** API keys from the n8n environment. Requires N8N_BLOCK_ENV_ACCESS_IN_NODE=false. */
function apiKeys(env) {
  const e = env || {};
  return { groq: e.GROQ_API_KEY || '', gemini: e.GEMINI_API_KEY || '' };
}

/** `$('Node').all()` -> plain row objects, tolerant of a missing/empty node. */
function rowsOf(items) {
  if (!items) return [];
  return items.map((i) => (i && i.json ? i.json : i)).filter(Boolean);
}

/** Wrap plain objects back into n8n items. */
function toItems(rows) {
  return (rows || []).map((json) => ({ json }));
}

/**
 * Standard envelope every workflow's terminal code node returns. The dashboard
 * reads exactly this shape, so a new workflow is legible without new UI.
 */
function envelope({ workflow, correlationId, trigger = 'manual', started, items_in = 0, ok = [], failed = [], warnings = [], notes = '' }) {
  return {
    ok: failed.length === 0,
    workflow,
    correlation_id: correlationId,
    trigger,
    started_at: started,
    finished_at: nowIso(),
    items_in,
    items_ok: ok.length,
    items_failed: failed.length,
    status: failed.length === 0 ? 'ok' : (ok.length ? 'partial' : 'failed'),
    warnings: [...new Set(warnings)],
    notes,
    results: ok,
    errors: failed,
  };
}

/** Row shape for the Errors tab. Payloads are PII-redacted by safeJson. */
function errorRow({ correlationId, applicantId = '', workflow, node = '', error, payload = {}, retryCount = 0 }) {
  const e = toAppError(error);
  return {
    at: nowIso(),
    correlation_id: correlationId,
    applicant_id: applicantId,
    workflow,
    node,
    error_code: e.code,
    error_message: e.message,
    severity: e.severity,
    retryable: String(e.retryable),
    hint: e.hint,
    payload_json: safeJson({ ...payload, details: e.details }),
    retry_count: retryCount,
    resolved: 'FALSE',
  };
}

/** Row shape for the RunLog tab. */
function runLogRow(env) {
  return {
    started_at: env.started_at,
    correlation_id: env.correlation_id,
    workflow: env.workflow,
    trigger: env.trigger,
    finished_at: env.finished_at,
    items_in: env.items_in,
    items_ok: env.items_ok,
    items_failed: env.items_failed,
    status: env.status,
    notes: [env.notes, env.warnings.length ? `warnings: ${env.warnings.join(',')}` : ''].filter(Boolean).join(' | '),
  };
}

/**
 * A workflow toggle that is OFF is a normal outcome, not an error: the run
 * ends immediately with a skipped envelope so the dashboard shows why nothing
 * happened.
 */
function skipped({ workflow, correlationId, reason, started }) {
  return { ...envelope({ workflow, correlationId, started }), ok: true, status: 'skipped', notes: reason };
}

function newCorrelationId(workflow) { return makeCorrelationId(workflow); }

module.exports = { makeHttp, apiKeys, rowsOf, toItems, envelope, errorRow, runLogRow, skipped, newCorrelationId };
