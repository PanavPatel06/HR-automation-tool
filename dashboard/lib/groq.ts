import 'server-only';

/**
 * A direct Groq call, used only as the demo-mode stand-in for n8n's AI
 * router (n8n/src/lib/ai-router.js). In the real architecture the dashboard
 * never talks to a model provider — every AI call goes through n8n so
 * secrets and rate limits live in one place (see lib/n8n.ts). This exists so
 * "Generate a template" still works with zero n8n setup, for someone who has
 * only a Groq key and no Google Sheet: see isDemoMode() in lib/sheets.ts for
 * the gate that keeps it out of the real path entirely.
 */

export class GroqError extends Error {
  code: string;
  hint: string;
  constructor(code: string, message: string, hint: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

function extractJson(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(match ? match[0] : text);
  } catch {
    throw new GroqError('E-LLM-JSON', 'Groq did not return valid JSON.', 'Usually transient — try Generate again.');
  }
}

/** Ask Groq for a JSON object. Throws GroqError with a code/hint on any failure. */
export async function groqJson(prompt: string, { model, maxTokens = 1200 }: { model?: string; maxTokens?: number } = {}): Promise<Record<string, unknown>> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new GroqError('E-CONFIG-MISSING', 'GROQ_API_KEY is not set.', 'Add GROQ_API_KEY to dashboard/.env.local.');

  const resolvedModel = model || process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

  let res: Response;
  try {
    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: resolvedModel,
        temperature: 0.4,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: 'Return JSON only. No prose, no markdown code fences.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
  } catch (err) {
    throw new GroqError('E-CONFIG-CRED', `Could not reach Groq: ${(err as Error)?.message ?? String(err)}`, 'Check network access and GROQ_API_KEY.');
  }

  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body?.error?.message ?? '';
    } catch { /* body wasn't JSON */ }
    throw new GroqError('E-LLM-HTTP', `Groq HTTP ${res.status}${detail ? `: ${detail}` : ''} (model: ${resolvedModel})`, 'Check GROQ_API_KEY and that the model id is still current.');
  }

  const body = await res.json();
  const text = String(body?.choices?.[0]?.message?.content ?? '');
  return extractJson(text) as Record<string, unknown>;
}
