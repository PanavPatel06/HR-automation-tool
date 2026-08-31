import 'server-only';

/**
 * Template selection, merge-field rendering, and HTML sanity checks — used
 * by both the bulk draft pipeline (lib/draft.ts) and the Inbox's ad-hoc
 * single-thread replies (the `reply-template-fill` / `reply-ai-draft` /
 * `send-reply` actions in app/api/action/route.ts).
 *
 * The hard rule: an email with an unresolved {{merge_field}} is never
 * sendable — "Hi {{first_name}}," reaching a candidate is worse than a
 * visible error.
 */

export class TemplateError extends Error {
  code: string;
  hint: string;
  constructor(code: string, message: string, hint: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export const FIELD_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** Void elements never need a closing tag. */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', '!doctype']);

/** Every {{field}} referenced by a template, de-duplicated, in first-seen order. */
export function extractFields(template: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  FIELD_RE.lastIndex = 0;
  while ((m = FIELD_RE.exec(String(template || ''))) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

export function escapeHtml(value: unknown): string {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type MergeContext = Record<string, string>;

/** Build the merge context for one applicant. */
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
    // The branded skeleton's header/footer block — see renderSkeleton() below.
    company_email: String(config.company_email ?? ''),
    company_phone: String(config.company_phone ?? ''),
    company_incubator: String(config.company_incubator ?? ''),
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
  { escape = true, allowHtmlFields = ['hr_signature', 'company_phone', 'company_incubator'] }: { escape?: boolean; allowHtmlFields?: string[] } = {}
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

/** Sheets round-trips booleans as strings; treat them consistently everywhere. */
function truthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  return ['true', 'yes', '1', 'y', 'x'].includes(String(v ?? '').trim().toLowerCase());
}

/**
 * The branded email shell every template starts from — logo mark, contact
 * header, and a footer credit, matching 3Space's letterhead. `%%BODY%%` is
 * where the message itself goes; renderSkeleton() below fills it in.
 *
 * Table-based with every style inline, not a `<style>` block or `<div>`
 * layout — the only markup that renders identically across Gmail, Outlook,
 * and every other mail client. `#6d4fe0` mirrors the dashboard's own brand
 * accent (`--purple` in app/globals.css), so the email and the app match.
 */
const TEMPLATE_SKELETON = [
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f3f1;padding:32px 0;font-family:Arial,Helvetica,sans-serif;">',
  '<tr><td align="center">',
  '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:10px;">',
  '<tr><td style="padding:32px 36px 18px 36px;">',
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>',
  '<td style="font-size:24px;font-weight:700;letter-spacing:1px;color:#1a1a1a;"><span style="color:#6d4fe0;">3</span>SPACE</td>',
  '<td align="right" style="font-size:11px;line-height:1.7;color:#87837a;">{{company_email}}<br>{{company_phone}}<br>{{company_incubator}}</td>',
  '</tr></table>',
  '</td></tr>',
  '<tr><td style="padding:0 36px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:2px solid #6d4fe0;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>',
  '<tr><td style="padding:30px 36px;font-size:15px;line-height:1.65;color:#1a1a1a;">',
  '%%BODY%%',
  '</td></tr>',
  '<tr><td style="padding:18px 36px 30px;border-top:1px solid #ece9e4;font-size:11px;color:#a5a196;">{{company_name}} &middot; {{company_incubator}}</td></tr>',
  '</table>',
  '</td></tr>',
  '</table>',
].join('\n');

/** The default seed template's message — plugged into TEMPLATE_SKELETON's %%BODY%% slot. */
export const DEFAULT_TEMPLATE_BODY = [
  '<p style="margin:0 0 16px;">Hi {{first_name}},</p>',
  '{{ai_body}}',
  '<p style="margin:24px 0 0;">{{hr_signature}}</p>',
].join('\n');

/** Slot a message fragment into the branded skeleton. Used for the default seed template and every AI-generated one, so both look identical. */
export function renderSkeleton(bodyHtml: string): string {
  return TEMPLATE_SKELETON.replace('%%BODY%%', bodyHtml);
}

export type TemplateRow = Record<string, string>;

/**
 * Pick the best template for an applicant. Specificity wins: an exact
 * role+category match beats role-only, which beats the default. Returns the
 * chosen template plus a warning when it had to fall back, so the caller can
 * record that a generic email was used.
 */
export function selectTemplate(
  templates: TemplateRow[],
  { job_role, category, stage = 'outreach' }: { job_role?: string; category?: string; stage?: string } = {},
): { template: TemplateRow; warning: string | null } {
  const active = (templates || []).filter((t) => truthy(t.is_active));
  if (!active.length) {
    throw new TemplateError('E-MAIL-TEMPLATE', 'No active templates exist.', 'Create one in the dashboard before drafting.');
  }

  const eq = (a?: string, b?: string) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const stageMatches = active.filter((t) => !t.stage || eq(t.stage, stage));
  const pool = stageMatches.length ? stageMatches : active;

  const scored = pool.map((t) => {
    let score = 0;
    if (t.job_role && eq(t.job_role, job_role)) score += 4;
    else if (t.job_role) score -= 10; // wrong role is disqualifying, not neutral
    if (t.category && eq(t.category, category)) score += 2;
    else if (t.category) score -= 5;
    if (truthy(t.is_default)) score += 1;
    return { template: t, score };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < 0) {
    const fallback = pool.find((t) => truthy(t.is_default));
    if (!fallback) {
      throw new TemplateError('E-MAIL-TEMPLATE', `No template matches role "${job_role}" and no default template is set.`, 'Set a default template in the dashboard.');
    }
    return { template: fallback, warning: 'W-TEMPLATE-DEFAULT' };
  }
  const usedDefault = best.score <= 1 && truthy(best.template.is_default);
  return { template: best.template, warning: usedDefault ? 'W-TEMPLATE-DEFAULT' : null };
}

/**
 * Full render + gate for one applicant's email. Throws TemplateError when
 * anything would produce a broken email, so callers cannot accidentally send
 * or save it. `extras` carries generated values that are not applicant
 * columns — chiefly `ai_body` — trusted as HTML since they already passed
 * checkDraftSchema() in lib/draft.ts; validateHtml() below is the backstop.
 */
export function renderEmail({
  template, applicant, config, extras = {},
}: {
  template: TemplateRow; applicant: Record<string, string>; config: Record<string, unknown>; extras?: Record<string, string>;
}): { subject: string; html: string; template_id: string } {
  const ctx = { ...buildMergeContext(applicant, config), ...extras };
  const allowHtmlFields = ['hr_signature', 'company_phone', 'company_incubator', ...Object.keys(extras)];
  const subject = render(template.subject || '', ctx, { escape: false });
  const body = render(template.html || '', ctx, { escape: true, allowHtmlFields });

  const unresolved = [...new Set([...subject.unresolved, ...body.unresolved])];
  if (unresolved.length) {
    throw new TemplateError('E-MAIL-TEMPLATE', `Unresolved merge field(s): ${unresolved.map((f) => `{{${f}}}`).join(', ')}.`, 'Fill these in the template before drafting.');
  }

  const structure = validateHtml(body.html);
  if (!structure.ok) {
    throw new TemplateError('E-MAIL-TEMPLATE', `Template HTML is invalid: ${structure.problems.join(' ')}`, 'Fix the template HTML.');
  }
  if (!subject.html.trim()) {
    throw new TemplateError('E-MAIL-TEMPLATE', 'Rendered subject is empty.', 'Set a subject on the template.');
  }

  return { subject: subject.html.trim(), html: body.html, template_id: template.template_id };
}
