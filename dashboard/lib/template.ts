import 'server-only';

/**
 * Template merge-field rendering and HTML sanity checks.
 *
 * Ported from n8n/src/lib/template.js for the dashboard's own Inbox reply
 * flow (see the `reply-template-fill` / `reply-ai-draft` / `send-reply`
 * actions in app/api/action/route.ts) — that flow sends ad-hoc single-thread
 * replies straight from the dashboard, which n8n has no route for, so it
 * cannot delegate there the way draft/send do. Only the pieces the dashboard
 * needs are ported; selectTemplate() and the row-shaped renderEmail()
 * wrapper stay in n8n, which still owns the real bulk send pipeline.
 *
 * The hard rule carried over unchanged: an email with an unresolved
 * {{merge_field}} is never sendable — "Hi {{first_name}}," reaching a
 * candidate is worse than a visible error.
 */

export const FIELD_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** Void elements never need a closing tag. */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', '!doctype']);

export function escapeHtml(value: unknown): string {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type MergeContext = Record<string, string>;

/** Build the merge context for one applicant. Mirrors n8n's buildMergeContext(). */
export function buildMergeContext(applicant: Record<string, string>, config: Record<string, unknown> = {}): MergeContext {
  const name = String(applicant.name || '').trim();
  const first = name.split(' ')[0] || name;
  return {
    name,
    first_name: first,
    email: applicant.email || '',
    job_role: applicant.job_role || '',
    category: applicant.category || '',
    applicant_id: applicant.applicant_id || '',
    company_name: String(config.company_name ?? ''),
    hr_name: String(config.hr_name ?? ''),
    hr_signature: String(config.hr_signature ?? ''),
  };
}

/**
 * Render a template. `allowHtmlFields` names context keys whose value is
 * trusted HTML (the signature); everything else is escaped. An unresolved
 * field is left visible in the output (e.g. a literal `{{ai_body}}`) rather
 * than silently dropped, so a human reviewing the draft sees exactly what
 * still needs filling in.
 */
export function render(
  template: string,
  context: MergeContext,
  { escape = true, allowHtmlFields = ['hr_signature'] }: { escape?: boolean; allowHtmlFields?: string[] } = {}
): { html: string; unresolved: string[]; used: string[] } {
  const src = String(template == null ? '' : template);
  const used: string[] = [];
  const unresolved: string[] = [];
  const allow = new Set(allowHtmlFields);

  const html = src.replace(FIELD_RE, (match, field) => {
    const value = context ? context[field] : undefined;
    if (value === undefined || value === null || String(value).trim() === '') {
      unresolved.push(field);
      return match;
    }
    used.push(field);
    return escape && !allow.has(field) ? escapeHtml(value) : String(value);
  });

  return { html, unresolved: [...new Set(unresolved)], used: [...new Set(used)] };
}

/**
 * Cheap structural check for generated/hand-written HTML: balanced tags and
 * no script/iframe/event-handler. Not a full parser — it catches the failure
 * modes an LLM or a hand-typed reply actually produces.
 */
export function validateHtml(html: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const src = String(html == null ? '' : html);

  if (!src.trim()) problems.push('Message body is empty.');
  if (/<script\b/i.test(src)) problems.push('Contains a <script> tag — not allowed in email.');
  if (/<iframe\b/i.test(src)) problems.push('Contains an <iframe> tag — not allowed in email.');
  if (/\son[a-z]+\s*=/i.test(src)) problems.push('Contains an inline event handler (onclick=…) — not allowed in email.');

  const stack: string[] = [];
  const tagRe = /<\/?([a-zA-Z0-9!-]+)[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(src)) !== null) {
    const raw = m[0];
    const tag = m[1].toLowerCase();
    const selfClosing = m[2] === '/';
    if (VOID_TAGS.has(tag) || selfClosing || raw.startsWith('<!')) continue;
    if (raw.startsWith('</')) {
      const open = stack.pop();
      if (open !== tag) {
        problems.push(open ? `Mismatched tag: </${tag}> closes <${open}>.` : `Stray closing tag </${tag}>.`);
        break;
      }
    } else {
      stack.push(tag);
    }
  }
  if (stack.length) problems.push(`Unclosed tag(s): ${[...new Set(stack)].map((t) => `<${t}>`).join(', ')}.`);

  return { ok: problems.length === 0, problems };
}
