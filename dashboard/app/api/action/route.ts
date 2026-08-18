import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { requireSession } from '../../../lib/auth';
import { callN8n, N8nError, type N8nAction } from '../../../lib/n8n';
import { readTab, patchRows, setConfig, appendDemoRow, isDemoMode, parseConfig, SheetsError, type Patch } from '../../../lib/sheets';
import { groqJson, GroqError } from '../../../lib/groq';
import { buildMergeContext, render, validateHtml, FIELD_RE } from '../../../lib/template';
import { ACTIONABLE } from '../../../lib/contract';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Every mutating action the dashboard can take.
 *
 * Split by destination: anything with a side effect outside the sheet (sending
 * mail, spending model quota) goes to n8n; pure state changes (approve, toggle,
 * activate) are written straight to Sheets. Approval in particular must never
 * be a model's decision, so it never leaves this process.
 */

type Body = { action: string; ids?: string[]; [k: string]: unknown };

const N8N_ACTIONS = new Set<N8nAction>(['draft', 'send', 'template-generate', 'preflight']);

function fail(status: number, code: string, message: string, hint = '') {
  return NextResponse.json({ ok: false, code, message, hint }, { status });
}

export async function POST(req: Request) {
  if (!(await requireSession())) return fail(401, 'E-AUTH', 'Your session has expired.', 'Sign in again.');

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'E-BADREQ', 'Request body is not valid JSON.');
  }

  const { action, ids = [] } = body;

  try {
    // --- demo mode: no n8n to delegate to, so template generation calls Groq
    // directly. Nothing else in N8N_ACTIONS gets a demo path — draft/send/
    // preflight need the real pipeline (batching, Gmail, quota tracking) and
    // are out of scope for a zero-setup demo.
    if (action === 'template-generate' && isDemoMode()) {
      const jobRole = String(body.job_role ?? '').trim();
      const purpose = String(body.purpose ?? 'initial outreach to a job applicant').trim();
      const tone = String(body.tone ?? 'warm, professional, concise').trim();
      const notes = String(body.notes ?? '').trim().slice(0, 500);

      const prompt = [
        `Write a recruiting email template for ${jobRole || 'any role'} candidates.`,
        `Purpose: ${purpose}. Tone: ${tone}.`,
        notes ? `Extra instructions: ${notes}.` : '',
        'Return JSON only: {"subject": string, "html": string}.',
        'The html MUST include the literal placeholders {{first_name}}, {{job_role}}, {{company_name}}, {{ai_body}}, and {{hr_signature}} somewhere appropriate.',
        'Keep it concise. Do not invent facts, dates, compensation, or promises.',
      ].filter(Boolean).join(' ');

      const generated = await groqJson(prompt) as { subject?: string; html?: string };
      const now = new Date().toISOString();
      const created = appendDemoRow('Templates', {
        template_id: `TPL-AI-${Date.now().toString(36).toUpperCase()}`,
        name: `AI draft — ${jobRole || 'any role'}`,
        job_role: jobRole,
        subject: generated.subject || `Your application for ${jobRole || 'the role'}`,
        html: generated.html || '<p>Hi {{first_name}},</p>\n{{ai_body}}\n<p>{{hr_signature}}</p>',
        source: 'ai',
        is_active: 'FALSE',
        is_default: 'FALSE',
        prompt_version: 'template-gen.v1-demo',
        created_at: now,
        updated_at: now,
      });

      revalidatePath('/', 'layout');
      return NextResponse.json({ ok: true, result: { status: 'ok', notes: `"${created.name}" generated with Groq and saved inactive — review it, then activate.` } });
    }

    // --- Inbox: ad-hoc single-thread replies --------------------------------
    //
    // Draft/send above are the *bulk* pipeline — batches of applicants moving
    // through a stage machine, delegated to n8n because sending is a real
    // side effect n8n owns. Replying to one candidate's thread from the Inbox
    // page is a different shape (one applicant, freeform content, triggered
    // by a human reading their reply) that n8n has no route for at all, in
    // either mode. So: reply-template-fill is a pure read+render and works
    // everywhere; reply-ai-draft and send-reply are demo-mode only, same as
    // template-generate, with an honest 501 in real mode rather than a fake
    // path or a confusing "unknown action".
    if (action === 'reply-template-fill') {
      const applicantId = String(body.applicant_id ?? '').trim();
      if (!applicantId) return fail(400, 'E-BADREQ', 'No applicant selected.');

      const [applicants, templates, configRows] = await Promise.all([
        readTab('Applicants'), readTab('Templates'), readTab('Config'),
      ]);
      const applicant = applicants.find((a) => a.applicant_id === applicantId);
      if (!applicant) return fail(404, 'E-NOTFOUND', `Applicant ${applicantId} does not exist.`);

      const templateId = String(body.template_id ?? '').trim();
      const template = templateId ? templates.find((t) => t.template_id === templateId) : undefined;
      if (templateId && !template) return fail(404, 'E-NOTFOUND', `Template ${templateId} does not exist.`);

      const ctx = buildMergeContext(applicant, parseConfig(configRows));
      const subject = template ? render(template.subject || '', ctx, { escape: false }).html : '';
      const html = template ? render(template.html || '', ctx, { escape: true }).html : '';

      return NextResponse.json({ ok: true, result: {
        status: 'ok', subject, html,
        notes: template ? `Loaded "${template.name}". Fill in any {{fields}} still showing before sending.` : 'Blank message.',
      } });
    }

    if (action === 'reply-ai-draft') {
      if (!isDemoMode()) {
        return fail(501, 'E-NOT-IMPLEMENTED', 'AI reply drafting is demo-mode only right now.', 'There is no n8n route for ad-hoc reply drafting yet — only the bulk draft pipeline (WF-02) is wired to n8n.');
      }
      const applicantId = String(body.applicant_id ?? '').trim();
      if (!applicantId) return fail(400, 'E-BADREQ', 'No applicant selected.');

      const [applicants, templates, replies, configRows] = await Promise.all([
        readTab('Applicants'), readTab('Templates'), readTab('Replies'), readTab('Config'),
      ]);
      const applicant = applicants.find((a) => a.applicant_id === applicantId);
      if (!applicant) return fail(404, 'E-NOTFOUND', `Applicant ${applicantId} does not exist.`);

      const config = parseConfig(configRows);
      const ctx = buildMergeContext(applicant, config);
      const templateId = String(body.template_id ?? '').trim();
      const template = templateId ? templates.find((t) => t.template_id === templateId) : undefined;
      const instructions = String(body.instructions ?? '').trim().slice(0, 500);
      const latestReply = replies
        .filter((r) => r.applicant_id === applicantId)
        .sort((a, b) => b.received_at.localeCompare(a.received_at))[0];

      const prompt = [
        'Write a reply email to a job applicant. Write the final text directly for the person named below — do NOT use {{merge field}} placeholders anywhere in the output.',
        `Candidate: ${ctx.first_name} (full name: ${ctx.name || 'unknown'}), applying for ${ctx.job_role || 'an open role'}.`,
        `Sign off using company "${ctx.company_name || 'the company'}" and sender "${ctx.hr_name || 'HR'}".`,
        latestReply
          ? `The candidate's most recent message to us (classified intent: ${latestReply.classified_intent || 'unclear'}): "${latestReply.snippet}". Reply directly and specifically to this.`
          : 'The candidate has not replied to anything yet — this is a proactive outreach or status update, not a reply to a message.',
        template ? `Match the tone of this existing template as a style reference only — do not copy its literal {{placeholders}}: subject "${template.subject}", body "${template.html}".` : '',
        instructions ? `Extra instructions from HR: ${instructions}.` : '',
        'Return JSON only: {"subject": string, "html": string}. The html should be simple, email-safe markup (p, br, a, strong, em, ul/li) — no <script> or <iframe>.',
        'Do not invent facts, dates, compensation, interview times, or promises beyond what is given above.',
      ].filter(Boolean).join(' ');

      const generated = await groqJson(prompt, { maxTokens: 900 }) as { subject?: string; html?: string };

      // Defense in depth: run the model's output back through the same merge
      // gate a template goes through, in case it echoed a literal
      // {{placeholder}} back instead of the real value.
      const subjectR = render(generated.subject || '', ctx, { escape: false });
      const bodyR = render(generated.html || '', ctx, { escape: true });
      const unresolved = [...new Set([...subjectR.unresolved, ...bodyR.unresolved])];
      const structure = validateHtml(bodyR.html);

      if (unresolved.length || !structure.ok || !subjectR.html.trim()) {
        const problems = [
          ...structure.problems,
          unresolved.length ? `Unresolved field(s): ${unresolved.map((f) => `{{${f}}}`).join(', ')}.` : '',
          !subjectR.html.trim() ? 'Subject was empty.' : '',
        ].filter(Boolean).join(' ');
        throw new GroqError('E-LLM-JSON', `Groq's draft did not pass validation: ${problems}`, 'Try Write with AI again, or write the reply manually.');
      }

      return NextResponse.json({ ok: true, result: {
        status: 'ok', subject: subjectR.html.trim(), html: bodyR.html,
        notes: 'AI draft ready — review it, then send.',
      } });
    }

    if (action === 'send-reply') {
      if (!isDemoMode()) {
        return fail(501, 'E-NOT-IMPLEMENTED', 'Sending an ad-hoc reply is demo-mode only right now.', 'Production sends go through the bulk approve → send pipeline (WF-03). Ad-hoc single-thread replies are not yet wired to n8n/Gmail.');
      }
      const applicantId = String(body.applicant_id ?? '').trim();
      const subject = String(body.subject ?? '').trim();
      const html = String(body.html ?? '').trim();
      if (!applicantId) return fail(400, 'E-BADREQ', 'No applicant selected.');
      if (!subject || !html) return fail(400, 'E-BADREQ', 'Subject and message body are required.');

      const structure = validateHtml(html);
      if (!structure.ok) return fail(422, 'E-MAIL-TEMPLATE', `Message HTML is invalid: ${structure.problems.join(' ')}`, 'Fix the HTML and try again.');
      const leftover = [...new Set([...subject.matchAll(FIELD_RE), ...html.matchAll(FIELD_RE)].map((m) => m[1]))];
      if (leftover.length) {
        return fail(422, 'E-MAIL-TEMPLATE', `Unresolved merge field(s): ${leftover.map((f) => `{{${f}}}`).join(', ')}.`, 'Fill these in before sending — an email cannot go out with a literal placeholder.');
      }

      const applicants = await readTab('Applicants');
      const applicant = applicants.find((a) => a.applicant_id === applicantId);
      if (!applicant) return fail(404, 'E-NOTFOUND', `Applicant ${applicantId} does not exist.`);

      const now = new Date().toISOString();
      const templateId = String(body.template_id ?? '').trim();

      await patchRows('Applicants', [{
        _row: applicant._row,
        template_id: templateId,
        email_subject: subject,
        email_html: html,
        email_status: 'sent',
        sent_at: now,
        thread_id: applicant.thread_id || `thread-demo-${applicant.applicant_id}`,
        stage: 'SENT',
        error_code: '',
        error_message: '',
        updated_at: now,
      }]);

      appendDemoRow('EmailLog', {
        at: now,
        correlation_id: `run-demo-reply-${Date.now().toString(36)}`,
        applicant_id: applicantId,
        to: applicant.email,
        subject,
        provider: 'demo',
        result: 'sent',
        dry_run: 'true',
      });

      // Responding to a candidate naturally clears their open replies from
      // the Inbox/Replies queue — nobody needs to "handle" a message that
      // has already been answered.
      const replies = await readTab('Replies');
      const open = replies.filter((r) => r.applicant_id === applicantId && !r.handled_at);
      if (open.length) {
        await patchRows('Replies', open.map((r) => ({ _row: r._row, handled_by: 'dashboard', handled_at: now })));
      }

      revalidatePath('/', 'layout');
      return NextResponse.json({ ok: true, result: {
        status: 'ok',
        notes: `Reply sent to ${applicant.email} — logged in Email Log. (Demo mode: simulated, not actually delivered.)`,
      } });
    }

    // --- side-effecting: delegate to n8n ------------------------------------
    if (N8N_ACTIONS.has(action as N8nAction)) {
      if (action === 'send' && ids.length === 0) {
        return fail(400, 'E-BADREQ', 'No recipients selected.', 'Select the applicants to email. Sending to "everything" is deliberately not possible in one click.');
      }
      const payload: Record<string, unknown> = { ...body };
      delete payload.action;

      const result = await callN8n(action as N8nAction, payload, {
        timeoutMs: action === 'preflight' ? 60_000 : 280_000,
      });
      revalidatePath('/', 'layout');
      return NextResponse.json({ ok: result.ok, result });
    }

    // --- pure state changes: write to Sheets directly ------------------------
    switch (action) {
      case 'approve':
      case 'unapprove': {
        if (!ids.length) return fail(400, 'E-BADREQ', 'No applicants selected.');
        const rows = await readTab('Applicants');
        const now = new Date().toISOString();
        const targets = rows.filter((r) => ids.includes(r.applicant_id));

        // Enforce the same stage machine n8n does, so the dashboard cannot
        // create a state the workflows would refuse.
        const legal = ACTIONABLE[action];
        const wrong = targets.filter((r) => !legal.includes(r.stage as never));
        if (wrong.length) {
          return fail(409, 'E-STAGE',
            `${wrong.length} of ${targets.length} selected row(s) are not in a stage that can be ${action}d.`,
            `${action === 'approve' ? 'Only DRAFTED' : 'Only APPROVED'} rows can be ${action}d. Offending: ${wrong.slice(0, 5).map((r) => `${r.applicant_id} (${r.stage})`).join(', ')}`);
        }

        const patches: Patch[] = targets.map((r): Patch => (action === 'approve'
          ? { _row: r._row, stage: 'APPROVED', approved_by: 'dashboard', approved_at: now, error_code: '', error_message: '', updated_at: now }
          : { _row: r._row, stage: 'DRAFTED', approved_by: '', approved_at: '', updated_at: now }));

        const n = await patchRows('Applicants', patches);
        revalidatePath('/', 'layout');
        return NextResponse.json({ ok: true, result: { updated: n, status: 'ok', notes: `${n} row(s) ${action}d` } });
      }

      case 'set-config': {
        const key = String(body.key ?? '');
        const value = String(body.value ?? '');
        if (!key) return fail(400, 'E-BADREQ', 'No config key given.');
        await setConfig(key, value);
        revalidatePath('/', 'layout');
        return NextResponse.json({ ok: true, result: { status: 'ok', notes: `${key} = ${value}` } });
      }

      case 'set-template-active': {
        const templateId = String(body.template_id ?? '');
        const active = body.active === true;
        const rows = await readTab('Templates');
        const target = rows.find((r) => r.template_id === templateId);
        if (!target) return fail(404, 'E-NOTFOUND', `Template ${templateId} does not exist.`);
        await patchRows('Templates', [{ _row: target._row, is_active: active ? 'TRUE' : 'FALSE', updated_at: new Date().toISOString() }]);
        revalidatePath('/', 'layout');
        return NextResponse.json({ ok: true, result: { status: 'ok', notes: `${target.name} ${active ? 'activated' : 'deactivated'}` } });
      }

      case 'resolve-error': {
        const correlationIds: string[] = (body.correlation_ids as string[]) ?? [];
        const rows = await readTab('Errors');
        const targets = rows.filter((r) => correlationIds.includes(r.correlation_id) && r.resolved !== 'TRUE');
        const n = await patchRows('Errors', targets.map((r) => ({ _row: r._row, resolved: 'TRUE' })));
        revalidatePath('/', 'layout');
        return NextResponse.json({ ok: true, result: { status: 'ok', notes: `${n} error(s) marked resolved` } });
      }

      case 'mark-reply-handled': {
        const threadIds: string[] = (body.thread_ids as string[]) ?? [];
        const rows = await readTab('Replies');
        const targets = rows.filter((r) => threadIds.includes(r.thread_id) && !r.handled_at);
        const now = new Date().toISOString();
        const n = await patchRows('Replies', targets.map((r) => ({ _row: r._row, handled_by: 'dashboard', handled_at: now })));
        revalidatePath('/', 'layout');
        return NextResponse.json({ ok: true, result: { status: 'ok', notes: `${n} reply/replies marked handled` } });
      }

      default:
        return fail(400, 'E-BADREQ', `Unknown action "${action}".`);
    }
  } catch (err) {
    if (err instanceof N8nError || err instanceof SheetsError || err instanceof GroqError) {
      return NextResponse.json({ ok: false, code: err.code, message: err.message, hint: err.hint }, { status: 502 });
    }
    return fail(500, 'E-UNKNOWN', (err as Error)?.message ?? 'Unexpected failure.', 'Check the Vercel function logs.');
  }
}
