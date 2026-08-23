import 'server-only';
import { extractFields, renderEmail, type TemplateRow } from './template';
import type { Row } from './contract';

/**
 * Draft-generation logic for the "Draft" bulk action — batch selection, the
 * model prompt, and the schema gate on what comes back. Kept pure (no I/O)
 * so it's easy to reason about; app/api/action/route.ts does the actual
 * reading/writing and the Groq call.
 */

/** A template opts into AI personalisation by containing {{ai_body}}. */
const AI_FIELD = 'ai_body';
export function usesAi(template: TemplateRow): boolean {
  return extractFields(String(template?.html || '')).includes(AI_FIELD)
      || extractFields(String(template?.subject || '')).includes(AI_FIELD);
}

/** Which applicants are eligible for a draft right now. */
export function selectForDrafting({
  applicants, ids = null, batchSize = 10, redraft = false,
}: {
  applicants: Row[]; ids?: string[] | null; batchSize?: number; redraft?: boolean;
}): Row[] {
  const wanted = ids && ids.length ? new Set(ids) : null;
  const eligible = (applicants || []).filter((a) => {
    if (!a.applicant_id) return false;
    if (wanted) return wanted.has(a.applicant_id);
    if (a.status === 'blocked') return false;
    if (redraft) return ['NEW', 'DRAFTED', 'FAILED'].includes(a.stage);
    return a.stage === 'NEW' || (a.stage === 'FAILED' && !a.email_subject);
  });
  return eligible.slice(0, Math.max(1, batchSize));
}

/** The prompt for personalising one email's AI body. */
export function buildDraftPrompt({
  applicant, template, config,
}: { applicant: Row; template: TemplateRow; config: Record<string, unknown> }): string {
  const lines = [
    `Company: ${config.company_name || 'the company'}`,
    `Candidate name: ${applicant.name}`,
    `Role applied for: ${applicant.job_role}`,
    applicant.category ? `Seniority/category: ${applicant.category}` : '',
    `Sender: ${config.hr_name || 'HR'}`,
    '',
    'Write the body of an outreach email to this candidate about their application.',
    '',
    'Return JSON only, exactly: {"subject": "...", "body_html": "..."}',
    'Rules for body_html:',
    '- 2 to 4 short paragraphs, wrapped in <p> tags.',
    '- Allowed tags: <p> <br> <strong> <em> <ul> <li> <a>. Nothing else.',
    '- Do not include a greeting line or a sign-off — the template supplies both.',
    '- Do not invent facts about the candidate, the salary, the interview date, or the process.',
    '- Do not use placeholders or merge fields of any kind.',
    `- Address the ${applicant.job_role} role specifically; a generic email is a failure.`,
  ].filter(Boolean);
  return lines.join('\n');
}

/** Structural gate on what the model returned, before it reaches a template. */
export function checkDraftSchema(json: unknown): { ok: boolean; reason?: string } {
  const j = json as { subject?: unknown; body_html?: unknown } | null;
  if (!j || typeof j !== 'object') return { ok: false, reason: 'not an object' };
  if (typeof j.subject !== 'string' || !j.subject.trim()) return { ok: false, reason: 'missing subject' };
  if (typeof j.body_html !== 'string' || !j.body_html.trim()) return { ok: false, reason: 'missing body_html' };
  if (/\{\{|\}\}/.test(j.body_html + j.subject)) return { ok: false, reason: 'model emitted merge-field placeholders' };
  if (/<(script|iframe|style)\b/i.test(j.body_html)) return { ok: false, reason: 'disallowed tag in body_html' };
  if (j.body_html.length > 20000) return { ok: false, reason: 'body_html unreasonably long' };
  return { ok: true };
}

/** Google Sheets caps a cell at 50k characters; truncate visibly, never silently. */
function fitCell(value: string): string {
  const LIMIT = 49000;
  return value.length <= LIMIT ? value : value.slice(0, LIMIT) + '\n<!-- truncated for sheet cell limit -->';
}

/**
 * Turn one applicant + one optional AI result into the draft columns.
 * `ai` is undefined for templates that do not use {{ai_body}}.
 */
export function assembleDraft({
  applicant, template, config, ai, now = new Date().toISOString(),
}: {
  applicant: Row; template: TemplateRow; config: Record<string, unknown>;
  ai?: { subject?: string; body_html?: string }; now?: string;
}): Record<string, string> {
  const mergeExtras: Record<string, string> = ai ? { ai_body: ai.body_html || '' } : {};
  const effectiveTemplate: TemplateRow = {
    ...template,
    subject: ai?.subject && usesAi(template) && String(template.subject || '').includes(`{{${AI_FIELD}}}`)
      ? ai.subject
      : template.subject,
  };

  const rendered = renderEmail({ template: effectiveTemplate, applicant, config, extras: mergeExtras });

  return {
    applicant_id: applicant.applicant_id,
    template_id: template.template_id,
    email_subject: rendered.subject,
    email_html: fitCell(rendered.html),
    stage: 'DRAFTED',
    status: 'ok',
    error_code: '',
    error_message: '',
    updated_at: now,
  };
}
