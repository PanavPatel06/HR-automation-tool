'use strict';
/**
 * Template selection, merge-field rendering, and HTML sanity checks (WF-02/03).
 *
 * The hard rule enforced here: an email with an unresolved {{merge_field}} is
 * never sendable. It fails as E-MAIL-TEMPLATE before it reaches Gmail, because
 * "Hi {{name}}," reaching a candidate is worse than a visible error.
 */

const { AppError } = require('./errors');

const FIELD_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** Void elements never need a closing tag. */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', '!doctype']);

/** Escape a value destined for an HTML email body. */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Every {{field}} referenced by a template, de-duplicated, in first-seen order. */
function extractFields(template) {
  const out = [];
  const seen = new Set();
  let m;
  FIELD_RE.lastIndex = 0;
  while ((m = FIELD_RE.exec(String(template || ''))) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

/**
 * Build the merge context for one applicant. Values are raw here; escaping
 * happens at render time so the same context can feed plain-text and HTML.
 */
function buildMergeContext(applicant, config = {}) {
  const name = String(applicant.name || '').trim();
  const first = name.split(' ')[0] || name;
  return {
    name,
    first_name: first,
    email: applicant.email || '',
    job_role: applicant.job_role || '',
    category: applicant.category || '',
    applicant_id: applicant.applicant_id || '',
    company_name: config.company_name || '',
    hr_name: config.hr_name || '',
    hr_signature: config.hr_signature || '',
    // V2 fields render as empty in V1 rather than blowing up shared templates.
    match_percent: applicant.match_percent == null ? '' : String(applicant.match_percent),
  };
}

/**
 * Render a template. `allowHtmlFields` names context keys whose value is
 * trusted HTML (the signature); everything else is escaped.
 *
 * @returns {{html: string, unresolved: string[], used: string[]}}
 */
function render(template, context, { escape = true, allowHtmlFields = ['hr_signature'] } = {}) {
  const src = String(template == null ? '' : template);
  const used = [];
  const unresolved = [];
  const allow = new Set(allowHtmlFields);

  const html = src.replace(FIELD_RE, (match, field) => {
    const value = context ? context[field] : undefined;
    if (value === undefined || value === null || String(value).trim() === '') {
      unresolved.push(field);
      return match; // leave it visible so validation can catch it
    }
    used.push(field);
    return escape && !allow.has(field) ? escapeHtml(value) : String(value);
  });

  return { html, unresolved: [...new Set(unresolved)], used: [...new Set(used)] };
}

/**
 * Cheap structural check for generated/uploaded HTML: balanced tags and no
 * script/iframe. Not a full parser — it catches the failure modes an LLM or a
 * hand-pasted template actually produces.
 */
function validateHtml(html) {
  const problems = [];
  const src = String(html == null ? '' : html);

  if (!src.trim()) problems.push('Template body is empty.');
  if (/<script\b/i.test(src)) problems.push('Contains a <script> tag — not allowed in email.');
  if (/<iframe\b/i.test(src)) problems.push('Contains an <iframe> tag — not allowed in email.');
  if (/\son[a-z]+\s*=/i.test(src)) problems.push('Contains an inline event handler (onclick=…) — not allowed in email.');

  const stack = [];
  const tagRe = /<\/?([a-zA-Z0-9!-]+)[^>]*?(\/?)>/g;
  let m;
  while ((m = tagRe.exec(src)) !== null) {
    const raw = m[0];
    const tag = m[1].toLowerCase();
    const selfClosing = m[2] === '/';
    if (VOID_TAGS.has(tag) || selfClosing || raw.startsWith('<!')) continue;
    if (raw.startsWith('</')) {
      const open = stack.pop();
      if (open !== tag) {
        problems.push(open ? `Mismatched tag: </${tag}> closes <${open}>.` : `Stray closing tag </${tag}>.`);
        break; // one structural report is enough; the rest cascade
      }
    } else {
      stack.push(tag);
    }
  }
  if (stack.length) problems.push(`Unclosed tag(s): ${[...new Set(stack)].map((t) => `<${t}>`).join(', ')}.`);

  return { ok: problems.length === 0, problems };
}

/**
 * Pick the best template for an applicant.
 *
 * Specificity wins: an exact role+category match beats role-only, which beats
 * the default. Returns the chosen template plus a warning when it had to fall
 * back, so the row records that it used a generic email.
 */
function selectTemplate(templates, { job_role, category, stage = 'outreach' } = {}) {
  const active = (templates || []).filter((t) => truthy(t.is_active));
  if (!active.length) {
    throw new AppError('E-MAIL-TEMPLATE', 'No active templates exist. Create one in the dashboard before drafting.', {});
  }

  const eq = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
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
      throw new AppError('E-MAIL-TEMPLATE', `No template matches role "${job_role}" and no default template is set.`, { job_role, category });
    }
    return { template: fallback, warning: 'W-TEMPLATE-DEFAULT' };
  }
  const usedDefault = best.score <= 1 && truthy(best.template.is_default);
  return { template: best.template, warning: usedDefault ? 'W-TEMPLATE-DEFAULT' : null };
}

/**
 * Full render + gate. Throws E-MAIL-TEMPLATE when anything would produce a
 * broken email, so callers cannot accidentally proceed.
 *
 * `extras` carries generated values that are not applicant columns — chiefly
 * `ai_body`. Those are trusted HTML because they have already passed
 * checkDraftSchema, so they render unescaped; the final validateHtml pass below
 * is still the backstop.
 */
function renderEmail({ template, applicant, config, extras = {} }) {
  const ctx = { ...buildMergeContext(applicant, config), ...extras };
  const allowHtmlFields = ['hr_signature', ...Object.keys(extras)];
  const subject = render(template.subject || '', ctx, { escape: false });
  const body = render(template.html || '', ctx, { escape: true, allowHtmlFields });

  const unresolved = [...new Set([...subject.unresolved, ...body.unresolved])];
  if (unresolved.length) {
    throw new AppError(
      'E-MAIL-TEMPLATE',
      `Unresolved merge field(s): ${unresolved.map((f) => `{{${f}}}`).join(', ')}.`,
      { unresolved, template_id: template.template_id }
    );
  }

  const structure = validateHtml(body.html);
  if (!structure.ok) {
    throw new AppError('E-MAIL-TEMPLATE', `Template HTML is invalid: ${structure.problems.join(' ')}`, { template_id: template.template_id });
  }
  if (!subject.html.trim()) {
    throw new AppError('E-MAIL-TEMPLATE', 'Rendered subject is empty.', { template_id: template.template_id });
  }

  return { subject: subject.html.trim(), html: body.html, template_id: template.template_id };
}

/** Sheets round-trips booleans as strings; treat them consistently everywhere. */
function truthy(v) {
  if (typeof v === 'boolean') return v;
  return ['true', 'yes', '1', 'y', 'x'].includes(String(v == null ? '' : v).trim().toLowerCase());
}

module.exports = {
  escapeHtml, extractFields, buildMergeContext, render, validateHtml,
  selectTemplate, renderEmail, truthy, FIELD_RE,
};
