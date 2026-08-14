'use strict';
/**
 * The AI layer: one entry point for every model call in the system.
 *
 * Responsibilities, in order of importance:
 *   1. Never let a quota error corrupt a row. Exhaustion parks; it does not fail.
 *   2. Fail over Groq -> Gemini on transient errors, and record that it happened
 *      (W-AI-FAILOVER) so degradation is never silent.
 *   3. Enforce the token budget *before* dispatch, so we do not discover the
 *      limit by being rejected.
 *
 * All I/O is injected (`http`, `sleep`, `now`) so this is unit-testable with no
 * network and no real clock. See tests/ai-router.test.mjs.
 */

const { AppError, classifyProviderHttp } = require('./errors');

/**
 * Free-tier limits. PLACEHOLDERS — verify in the Groq / Google AI consoles and
 * override via the Quota tab. The router also self-corrects from live
 * x-ratelimit-* response headers, so a stale number here degrades gracefully.
 */
const MODELS = {
  'groq:llama-3.1-8b-instant':     { provider: 'groq',   model: 'llama-3.1-8b-instant',     rpm: 30, rpd: 14400, tpm: 6000,    tpd: 500000 },
  'groq:llama-3.3-70b-versatile':  { provider: 'groq',   model: 'llama-3.3-70b-versatile',  rpm: 30, rpd: 1000,  tpm: 12000,   tpd: 100000 },
  'gemini:gemini-2.0-flash':       { provider: 'gemini', model: 'gemini-2.0-flash',         rpm: 15, rpd: 1500,  tpm: 1000000, tpd: Infinity },
};

/** Ordered failover chains per task. First entry is primary. */
const ROUTES = {
  draft_email:      ['groq:llama-3.3-70b-versatile', 'gemini:gemini-2.0-flash'],
  generate_template:['groq:llama-3.3-70b-versatile', 'gemini:gemini-2.0-flash'],
  classify_reply:   ['groq:llama-3.1-8b-instant', 'gemini:gemini-2.0-flash'],
  // V2
  resume_markdown:  ['groq:llama-3.1-8b-instant', 'gemini:gemini-2.0-flash'],
  score_resume:     ['groq:llama-3.3-70b-versatile', 'gemini:gemini-2.0-flash', 'groq:llama-3.1-8b-instant'],
};

/**
 * ~4 characters per token. Crude, but it only needs to be right enough to
 * reserve budget; actual usage from the response reconciles the bucket.
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

/** Models emit JSON wrapped in prose or ```json fences more often than not. */
function extractJson(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced ? fenced[1] : null, text].filter(Boolean);
  for (const c of candidates) {
    try { return JSON.parse(c.trim()); } catch (_e) { /* try next */ }
  }
  // Last resort: the outermost balanced {...} or [...] span.
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch (_e) { return null; }
    }
  }
  return null;
}

/**
 * Token bucket per model, persisted to the Quota tab so it survives restarts.
 * Windows are wall-clock: minute buckets reset on the minute, day buckets at
 * UTC midnight, matching how the providers actually meter.
 */
class QuotaLedger {
  constructor(state = {}, nowFn = () => Date.now()) {
    this.now = nowFn;
    this.state = {};
    for (const [key, v] of Object.entries(state)) this.state[key] = { ...v };
  }

  _bucket(key) {
    const t = this.now();
    const minute = Math.floor(t / 60000);
    const day = Math.floor(t / 86400000);
    let b = this.state[key];
    if (!b) b = this.state[key] = { minute, day, rpm: 0, tpm: 0, rpd: 0, tpd: 0 };
    if (b.minute !== minute) { b.minute = minute; b.rpm = 0; b.tpm = 0; }
    if (b.day !== day) { b.day = day; b.rpd = 0; b.tpd = 0; }
    return b;
  }

  /**
   * @returns {{ok: true} | {ok: false, reason: 'rpm'|'tpm'|'rpd'|'tpd', waitMs: number}}
   */
  check(key, estTokens, limits) {
    const l = limits || MODELS[key];
    if (!l) return { ok: true };
    const b = this._bucket(key);
    const t = this.now();
    const msToNextMinute = 60000 - (t % 60000);
    const msToNextDay = 86400000 - (t % 86400000);

    if (b.rpd + 1 > l.rpd) return { ok: false, reason: 'rpd', waitMs: msToNextDay };
    if (b.tpd + estTokens > l.tpd) return { ok: false, reason: 'tpd', waitMs: msToNextDay };
    if (b.rpm + 1 > l.rpm) return { ok: false, reason: 'rpm', waitMs: msToNextMinute };
    if (b.tpm + estTokens > l.tpm) return { ok: false, reason: 'tpm', waitMs: msToNextMinute };
    return { ok: true };
  }

  /** Reserve before dispatch. */
  reserve(key, estTokens) {
    const b = this._bucket(key);
    b.rpm += 1; b.rpd += 1; b.tpm += estTokens; b.tpd += estTokens;
    return b;
  }

  /** Reconcile the estimate against what the provider actually charged. */
  settle(key, estTokens, actualTokens) {
    const b = this._bucket(key);
    const delta = (actualTokens || 0) - estTokens;
    b.tpm = Math.max(0, b.tpm + delta);
    b.tpd = Math.max(0, b.tpd + delta);
    return b;
  }

  /** Trust the provider's own accounting when it sends headers. */
  applyHeaders(key, headers) {
    if (!headers) return;
    const get = (n) => headers[n] ?? headers[n.toLowerCase()] ?? headers[n.toUpperCase()];
    const remTokens = Number(get('x-ratelimit-remaining-tokens'));
    const limTokens = Number(get('x-ratelimit-limit-tokens'));
    if (Number.isFinite(remTokens) && Number.isFinite(limTokens) && limTokens > 0) {
      this._bucket(key).tpm = Math.max(0, limTokens - remTokens);
    }
    const remReq = Number(get('x-ratelimit-remaining-requests'));
    const limReq = Number(get('x-ratelimit-limit-requests'));
    if (Number.isFinite(remReq) && Number.isFinite(limReq) && limReq > 0) {
      this._bucket(key).rpm = Math.max(0, limReq - remReq);
    }
  }

  snapshot() { return JSON.parse(JSON.stringify(this.state)); }

  /**
   * How many more items of `tokensPerItem` fit today, and how long they take.
   * This is what the dashboard's ETA panel renders.
   */
  forecast(key, tokensPerItem, limits) {
    const l = limits || MODELS[key];
    if (!l) return { remainingToday: Infinity, itemsPerMinute: Infinity, etaMinutes: 0 };
    const b = this._bucket(key);
    const remainingToday = Math.max(0, Math.floor(Math.min(
      (l.tpd - b.tpd) / tokensPerItem,
      l.rpd - b.rpd
    )));
    const itemsPerMinute = Math.min(l.tpm / tokensPerItem, l.rpm);
    return { remainingToday, itemsPerMinute, etaMinutes: (n) => n / itemsPerMinute };
  }
}

/** Exponential backoff with full jitter, so parallel workers do not resonate. */
function backoffMs(attempt, base = 2000, cap = 16000, rand = Math.random) {
  const exp = Math.min(cap, base * Math.pow(2, attempt));
  return Math.floor(exp / 2 + rand() * (exp / 2));
}

function buildGroqRequest({ model, system, user, json, temperature, maxTokens, apiKey }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  return {
    method: 'POST',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: {
      model,
      messages,
      temperature: temperature ?? 0.4,
      max_tokens: maxTokens ?? 2048,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    },
  };
}

function buildGeminiRequest({ model, system, user, json, temperature, maxTokens, apiKey }) {
  return {
    method: 'POST',
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    headers: { 'Content-Type': 'application/json' },
    body: {
      contents: [{ role: 'user', parts: [{ text: user }] }],
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: {
        temperature: temperature ?? 0.4,
        maxOutputTokens: maxTokens ?? 2048,
        ...(json ? { responseMimeType: 'application/json' } : {}),
      },
    },
  };
}

function parseGroqResponse(body) {
  const choice = body && body.choices && body.choices[0];
  const text = choice && choice.message ? choice.message.content : '';
  const usage = (body && body.usage) || {};
  return { text: text || '', tokens: usage.total_tokens || 0, finish: choice ? choice.finish_reason : '' };
}

function parseGeminiResponse(body) {
  const cand = body && body.candidates && body.candidates[0];
  if (cand && cand.finishReason === 'SAFETY') {
    throw new AppError('E-LLM-REFUSAL', 'Gemini blocked the response on safety grounds.', {});
  }
  const parts = cand && cand.content && cand.content.parts ? cand.content.parts : [];
  const text = parts.map((p) => p.text || '').join('');
  const usage = (body && body.usageMetadata) || {};
  return { text: text || '', tokens: usage.totalTokenCount || 0, finish: cand ? cand.finishReason : '' };
}

class AiRouter {
  /**
   * @param {object} opts
   * @param {(req: object) => Promise<{status:number, body:any, headers:object}>} opts.http
   * @param {(ms:number)=>Promise<void>} [opts.sleep]
   * @param {object} opts.keys            { groq, gemini }
   * @param {QuotaLedger} [opts.ledger]
   * @param {object} [opts.routes]        override ROUTES
   * @param {object} [opts.limits]        override MODELS
   * @param {(msg:string, meta:object)=>void} [opts.log]
   */
  constructor(opts) {
    this.http = opts.http;
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.keys = opts.keys || {};
    this.ledger = opts.ledger || new QuotaLedger({}, opts.now);
    this.routes = opts.routes || ROUTES;
    this.limits = opts.limits || MODELS;
    this.log = opts.log || (() => {});
    this.maxAttemptsPerModel = opts.maxAttemptsPerModel ?? 3;
    this.rand = opts.rand || Math.random;
  }

  /**
   * Run one task through its failover chain.
   *
   * @returns {Promise<{text, json, model, provider, tokens, failedOver, warnings, attempts}>}
   * @throws  {AppError} E-QUOTA-ALL when every model is exhausted (park, retry later)
   */
  async complete({ task, system, user, json = false, temperature, maxTokens, schemaCheck }) {
    const chain = this.routes[task];
    if (!chain) throw new AppError('E-CONFIG-MISSING', `No model route configured for task "${task}".`, { task });

    const estTokens = estimateTokens(system) + estimateTokens(user) + (maxTokens ?? 2048);
    const warnings = [];
    const attempts = [];
    let parked = null;
    let lastError = null;
    // A skipped provider (no key, unknown model) must never mask a real failure
    // further up the chain — otherwise "Groq returned invalid JSON" gets
    // reported as "no Gemini key", and the operator debugs the wrong thing.
    let skipError = null;

    for (let ci = 0; ci < chain.length; ci++) {
      const key = chain[ci];
      const spec = this.limits[key];
      if (!spec) { skipError = skipError || new AppError('E-CONFIG-MISSING', `Unknown model "${key}".`, {}); continue; }

      const apiKey = this.keys[spec.provider];
      if (!apiKey) {
        skipError = skipError || new AppError('E-CONFIG-MISSING', `No API key configured for provider "${spec.provider}".`, { provider: spec.provider });
        attempts.push({ model: key, outcome: 'no-key' });
        continue;
      }

      // Budget gate: skip an exhausted model rather than earning a 429.
      const gate = this.ledger.check(key, estTokens, spec);
      if (!gate.ok) {
        parked = parked || gate;
        attempts.push({ model: key, outcome: `quota:${gate.reason}` });
        this.log('quota-skip', { model: key, reason: gate.reason, waitMs: gate.waitMs });
        continue;
      }

      for (let attempt = 0; attempt < this.maxAttemptsPerModel; attempt++) {
        try {
          const result = await this._callOnce({ key, spec, apiKey, system, user, json, temperature, maxTokens, estTokens });

          if (json) {
            const parsed = extractJson(result.text);
            if (parsed === null) {
              // One repair pass, then give up on this model.
              const repaired = await this._repairJson({ key, spec, apiKey, system, user, raw: result.text, temperature, maxTokens, estTokens });
              if (repaired === null) throw new AppError('E-LLM-SCHEMA', 'Model did not return valid JSON, including after a repair attempt.', { model: key });
              result.json = repaired;
            } else {
              result.json = parsed;
            }
            if (schemaCheck) {
              const verdict = schemaCheck(result.json);
              if (!verdict || verdict.ok !== true) {
                throw new AppError('E-LLM-SCHEMA', `Response failed schema check: ${(verdict && verdict.reason) || 'unknown'}.`, { model: key });
              }
            }
          }

          if (ci > 0) {
            warnings.push('W-AI-FAILOVER');
            this.log('failover', { from: chain[0], to: key, reason: lastError ? lastError.code : 'quota' });
          }
          attempts.push({ model: key, outcome: 'ok', tokens: result.tokens });
          return { ...result, model: spec.model, provider: spec.provider, routeKey: key, failedOver: ci > 0, warnings, attempts };
        } catch (err) {
          const appErr = err instanceof AppError ? err : new AppError('E-UNKNOWN', err && err.message ? err.message : String(err), {});
          lastError = appErr;
          attempts.push({ model: key, outcome: appErr.code, attempt });
          this.log('attempt-failed', { model: key, code: appErr.code, attempt });

          if (appErr.park) { parked = { ok: false, reason: appErr.code, waitMs: 60000 }; break; }
          if (appErr.code === 'E-LLM-AUTH' || appErr.code === 'E-LLM-SCHEMA' || appErr.code === 'E-LLM-REFUSAL') break; // next model
          if (!appErr.retryable) break;
          if (attempt < this.maxAttemptsPerModel - 1) {
            await this.sleep(appErr.retryAfterMs || backoffMs(attempt, 2000, 16000, this.rand));
          }
        }
      }
    }

    if (parked && !lastError) {
      throw new AppError('E-QUOTA-ALL', 'All configured models are out of budget for now. Work is parked and will resume automatically.', { attempts, waitMs: parked.waitMs });
    }
    // Preference order: a real attempt failure, then a config problem, then quota.
    const finalErr = lastError || skipError || new AppError('E-QUOTA-ALL', 'No model could serve this request.', { attempts });
    finalErr.details = { ...(finalErr.details || {}), attempts };
    throw finalErr;
  }

  async _callOnce({ key, spec, apiKey, system, user, json, temperature, maxTokens, estTokens }) {
    const build = spec.provider === 'groq' ? buildGroqRequest : buildGeminiRequest;
    const req = build({ model: spec.model, system, user, json, temperature, maxTokens, apiKey });

    this.ledger.reserve(key, estTokens);
    let res;
    try {
      res = await this.http(req);
    } catch (err) {
      if (/timeout|ETIMEDOUT|ESOCKETTIMEDOUT|aborted/i.test(String(err && err.message))) {
        throw new AppError('E-LLM-TIMEOUT', 'Model request timed out.', { model: key });
      }
      throw new AppError('E-LLM-SERVER', `Network failure calling ${spec.provider}: ${err && err.message}`, { model: key });
    }

    this.ledger.applyHeaders(key, res.headers);

    if (res.status < 200 || res.status >= 300) {
      const err = classifyProviderHttp(res.status, res.body);
      const retryAfter = res.headers && (res.headers['retry-after'] || res.headers['Retry-After']);
      if (retryAfter) err.retryAfterMs = Math.min(60000, Number(retryAfter) * 1000 || 0);
      throw err;
    }

    const parsed = spec.provider === 'groq' ? parseGroqResponse(res.body) : parseGeminiResponse(res.body);
    if (!parsed.text || !parsed.text.trim()) throw new AppError('E-LLM-EMPTY', 'Model returned an empty response.', { model: key });

    this.ledger.settle(key, estTokens, parsed.tokens);
    return { text: parsed.text, tokens: parsed.tokens, finish: parsed.finish };
  }

  async _repairJson({ key, spec, apiKey, system, user, raw, temperature, maxTokens, estTokens }) {
    try {
      const repairUser = [
        'Your previous response was not valid JSON. Return the SAME content as a single valid JSON object.',
        'Output JSON only — no prose, no markdown fences.',
        '',
        '--- previous response ---',
        String(raw).slice(0, 4000),
      ].join('\n');
      const res = await this._callOnce({ key, spec, apiKey, system, user: repairUser, json: true, temperature: 0, maxTokens, estTokens });
      return extractJson(res.text);
    } catch (_e) {
      return null;
    }
  }
}

module.exports = {
  MODELS, ROUTES, AiRouter, QuotaLedger,
  estimateTokens, extractJson, backoffMs,
  buildGroqRequest, buildGeminiRequest, parseGroqResponse, parseGeminiResponse,
};
