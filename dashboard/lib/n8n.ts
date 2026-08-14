import 'server-only';
import { createHmac } from 'node:crypto';

/**
 * The dashboard's only channel to n8n: signed webhook calls.
 *
 * The dashboard never talks to Groq, Gmail, or a candidate. Every side effect
 * goes through n8n, which keeps secrets in one place and makes every action
 * auditable in one log.
 */

export type N8nAction = 'draft' | 'send' | 'template-generate' | 'preflight';

const PATHS: Record<N8nAction, string> = {
  draft: 'draft',
  send: 'send',
  'template-generate': 'template-generate',
  preflight: 'preflight',
};

export class N8nError extends Error {
  code: string;
  hint: string;
  status?: number;
  constructor(code: string, message: string, hint: string, status?: number) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

/**
 * Recursively key-sorted JSON. Must match canonicalJson() in
 * n8n/src/lib/util.js exactly — the two sides sign the same bytes or nothing
 * verifies.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function sign(secret: string, body: unknown, timestamp: number) {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${canonicalJson(body)}`).digest('hex');
  return `v1=${mac}`;
}

export type N8nResult = {
  ok: boolean;
  status: string;
  workflow?: string;
  correlation_id?: string;
  items_in?: number;
  items_ok?: number;
  items_failed?: number;
  notes?: string;
  warnings?: string[];
  errors?: Array<{ applicant_id?: string; code?: string; message?: string }>;
  [k: string]: unknown;
};

/**
 * Call an n8n webhook. Timeouts are deliberately generous — a draft batch runs
 * model calls serially to respect the per-minute token limit.
 */
export async function callN8n(action: N8nAction, payload: Record<string, unknown>, { timeoutMs = 120_000 } = {}): Promise<N8nResult> {
  const base = process.env.N8N_BASE_URL?.replace(/\/+$/, '');
  const secret = process.env.N8N_WEBHOOK_SECRET;

  if (!base) throw new N8nError('E-CONFIG-MISSING', 'N8N_BASE_URL is not set.', 'Add it to the dashboard environment, e.g. https://n8n.example.com (no trailing slash).');
  if (!secret) throw new N8nError('E-CONFIG-MISSING', 'N8N_WEBHOOK_SECRET is not set.', 'It must match N8N_WEBHOOK_SECRET in n8n/.env exactly.');

  const timestamp = Math.floor(Date.now() / 1000);
  const body = { ...payload, trigger: 'dashboard' };
  const url = `${base}/webhook/${PATHS[action]}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-HR-Timestamp': String(timestamp),
        'X-HR-Signature': sign(secret, body, timestamp),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new N8nError('E-LLM-TIMEOUT', `n8n did not respond within ${Math.round(timeoutMs / 1000)}s.`, 'The batch may still be running. Check the Console page in a minute before retrying — retrying could duplicate work.');
    }
    throw new N8nError('E-CONFIG-CRED', `Could not reach n8n at ${base}.`, 'Check N8N_BASE_URL, that the container is up, and that its TLS certificate is valid.');
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }

  if (res.status === 404) {
    throw new N8nError('E-CONFIG-CRED', `Webhook /${PATHS[action]} does not exist in n8n.`, 'Import the workflow and ACTIVATE it — inactive workflows only serve the /webhook-test/ URL.', 404);
  }
  if (res.status === 500 && /signature rejected/i.test(text)) {
    throw new N8nError('E-CONFIG-CRED', 'n8n rejected the request signature.', 'N8N_WEBHOOK_SECRET differs between the dashboard and n8n, or the two clocks are more than 5 minutes apart.', 500);
  }
  if (!res.ok) {
    throw new N8nError('E-UNKNOWN', `n8n returned HTTP ${res.status}.`, 'Open the execution in n8n for the full stack trace.', res.status);
  }

  const result = (Array.isArray(parsed) ? parsed[0] : parsed) as N8nResult;
  // Spread first: the explicit defaults below must win when n8n omits them.
  return { ...result, ok: result?.ok !== false, status: result?.status ?? 'unknown' };
}
