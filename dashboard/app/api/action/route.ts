import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { requireSession } from '../../../lib/auth';
import { readTab, patchRows, appendRow, setConfig, isDemoMode, parseConfig, SheetsError, type Patch } from '../../../lib/sheets';
import { groqJson, GroqError } from '../../../lib/groq';
import { buildMergeContext, render, validateHtml, selectTemplate, renderEmail, TemplateError, FIELD_RE } from '../../../lib/template';
import { selectForDrafting, usesAi, buildDraftPrompt, checkDraftSchema, assembleDraft } from '../../../lib/draft';
import { findMessagesForAddress, sendMail, isGmailConfigured, GmailError, MAX_ATTACHMENTS_BYTES, type OutgoingAttachment } from '../../../lib/gmail';
import { ACTIONABLE } from '../../../lib/contract';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Every mutating action the dashboard can take. Approval is a pure state
 * change written straight to Sheets — it must never be a model's decision, so
 * it never leaves this process. Draft and Send are the only actions with a
 * side effect outside the sheet (spending model quota, sending mail); they
 * still run in-process, straight to Groq/Gmail — see lib/draft.ts.
 */

type Body = { action: string; ids?: string[]; [k: string]: unknown };

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
    if (action === 'template-generate') {
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
      const created = await appendRow('Templates', {
        template_id: `TPL-AI-${Date.now().toString(36).toUpperCase()}`,
        name: `AI draft — ${jobRole || 'any role'}`,
        job_role: jobRole,
        subject: generated.subject || `Your application for ${jobRole || 'the role'}`,
        html: generated.html || '<p>Hi {{first_name}},</p>\n{{ai_body}}\n<p>{{hr_signature}}</p>',
        source: 'ai',
        is_active: 'FALSE',
        is_default: 'FALSE',
        prompt_version: 'template-gen.v1',
        created_at: now,
        updated_at: now,
      });

      revalidatePath('/', 'layout');
      return NextResponse.json({ ok: true, result: { status: 'ok', notes: `"${created.name}" generated with Groq and saved inactive — review it, then activate.` } });
    }

    // --- Inbox: ad-hoc single-thread replies --------------------------------
    //
    // Draft/send below are the *bulk* pipeline — batches of applicants moving
    // through a stage machine. Replying to one candidate's thread from the
    // Inbox page is a different shape (one applicant, freeform content,
    // triggered by a human reading their reply). reply-template-fill is a
    // pure read+render and works everywhere; reply-ai-draft's Sheets side
    // works everywhere too (it never writes); send-reply's write side stays
    // demo-mode only for now, with an honest 501 in real-Sheets mode rather
    // than a fake path. Gmail is a separate, optional gate
    // (isGmailConfigured()) — see gmail-sync and send-reply below.
    if (action === 'start-conversation') {
      const name = String(body.name ?? '').trim();
      const email = String(body.email ?? '').trim().toLowerCase();
      const jobRole = String(body.job_role ?? '').trim();
      const category = String(body.category ?? '').trim();
      if (!email) return fail(400, 'E-BADREQ', 'An email address is required.');
      // Same pragmatic check WF-01 Intake uses — catches typos and empty
      // cells, not a full RFC 5322 parse.
      if (!/^[^\s@,;:<>()[\]\\]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) {
        return fail(400, 'E-BADREQ', `"${email}" is not a valid email address.`);
      }

      const applicants = await readTab('Applicants');
      const existing = applicants.find((a) => a.email.toLowerCase() === email);
      if (existing) {
        return NextResponse.json({ ok: true, result: {
          status: 'ok', applicant_id: existing.applicant_id,
          notes: `${email} already has a conversation — opening the existing thread.`,
        } });
      }

      const now = new Date().toISOString();
      const applicant = await appendRow('Applicants', {
        applicant_id: `APP-${Date.now().toString(36).toUpperCase()}`,
        created_at: now,
        name, email, job_role: jobRole, category,
        source: 'manual', stage: 'NEW', status: 'ok',
        updated_at: now,
      });

      revalidatePath('/', 'layout');
      return NextResponse.json({ ok: true, result: {
        status: 'ok', applicant_id: applicant.applicant_id,
        notes: `Started a conversation with ${email}.`,
      } });
    }

    if (action === 'gmail-sync') {
      if (!isGmailConfigured()) {
        return fail(501, 'E-NOT-IMPLEMENTED', 'Gmail is not configured.', 'Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN — run scripts/gmail-oauth.mjs, see dashboard/README.md.');
      }
      const applicantId = String(body.applicant_id ?? '').trim();
      if (!applicantId) return fail(400, 'E-BADREQ', 'No applicant selected.');

      const applicants = await readTab('Applicants');
      const applicant = applicants.find((a) => a.applicant_id === applicantId);
      if (!applicant) return fail(404, 'E-NOTFOUND', `Applicant ${applicantId} does not exist.`);
      if (!applicant.email) return fail(400, 'E-BADREQ', 'This applicant has no email address to search for.');

      const messages = await findMessagesForAddress(applicant.email);
      return NextResponse.json({ ok: true, result: {
        status: 'ok',
        messages,
        notes: messages.length ? `Imported ${messages.length} real message(s) from Gmail for ${applicant.email}.` : `No Gmail messages found for ${applicant.email}.`,
      } });
    }

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
      // Unlike send-reply, this never writes anything — it's a read + a Groq
      // call — so unlike the rest of this section it works with real Sheets
      // too, as long as GROQ_API_KEY is set (groqJson() enforces that itself).
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
      // If the client has a real Gmail message synced (see gmail-sync above),
      // it can pass its text here so the draft responds to what the
      // candidate actually wrote in their real inbox, not just the Replies
      // tab's classified snippet.
      const gmailContext = String(body.gmail_context ?? '').trim().slice(0, 2000);
      const latestReply = replies
        .filter((r) => r.applicant_id === applicantId)
        .sort((a, b) => b.received_at.localeCompare(a.received_at))[0];

      const prompt = [
        'Write a reply email to a job applicant. Write the final text directly for the person named below — do NOT use {{merge field}} placeholders anywhere in the output.',
        `Candidate: ${ctx.first_name} (full name: ${ctx.name || 'unknown'}), applying for ${ctx.job_role || 'an open role'}.`,
        `Sign off using company "${ctx.company_name || 'the company'}" and sender "${ctx.hr_name || 'HR'}".`,
        gmailContext
          ? `The candidate's most recent real email to us said: "${gmailContext}". Reply directly and specifically to this.`
          : latestReply
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
        return fail(501, 'E-NOT-IMPLEMENTED', 'Sending an ad-hoc reply is demo-mode only right now.', 'The bulk approve → send pipeline works against real Sheets; ad-hoc single-thread replies are not yet wired to write there.');
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

      const attachments = Array.isArray(body.attachments) ? (body.attachments as OutgoingAttachment[]) : [];
      const totalAttachmentBytes = attachments.reduce((n, a) => n + (a.base64?.length ?? 0), 0);
      if (totalAttachmentBytes > MAX_ATTACHMENTS_BYTES) {
        return fail(413, 'E-VALIDATION', 'Attachments are too large.', `Total attachment size must stay under ${Math.round(MAX_ATTACHMENTS_BYTES / 1024 / 1024)}MB.`);
      }

      const applicants = await readTab('Applicants');
      const applicant = applicants.find((a) => a.applicant_id === applicantId);
      if (!applicant) return fail(404, 'E-NOTFOUND', `Applicant ${applicantId} does not exist.`);

      const now = new Date().toISOString();
      const templateId = String(body.template_id ?? '').trim();
      const configRows = await readTab('Config');
      const config = parseConfig(configRows);
      // Same safety switch the bulk pipeline (WF-03) respects: real sending
      // only happens when dry_run has been deliberately turned off in
      // Settings. Gmail being configured is not enough on its own — that
      // would make flipping GMAIL_REFRESH_TOKEN into .env.local the same as
      // consenting to send real mail, which is the wrong default.
      const dryRun = config.dry_run !== false;
      const willSendForReal = isGmailConfigured() && !dryRun;

      let providerMessageId = '';
      let threadId = applicant.thread_id || `thread-demo-${applicant.applicant_id}`;
      if (willSendForReal) {
        const sent = await sendMail({
          to: applicant.email, subject, html, attachments,
          threadId: applicant.thread_id || undefined,
          inReplyTo: applicant.message_id || undefined,
          references: applicant.message_id || undefined,
        });
        providerMessageId = sent.id;
        threadId = sent.threadId || threadId;
      }

      await patchRows('Applicants', [{
        _row: applicant._row,
        template_id: templateId,
        email_subject: subject,
        email_html: html,
        email_status: 'sent',
        sent_at: now,
        thread_id: threadId,
        message_id: providerMessageId,
        stage: 'SENT',
        error_code: '',
        error_message: '',
        updated_at: now,
      }]);

      await appendRow('EmailLog', {
        at: now,
        correlation_id: `run-demo-reply-${Date.now().toString(36)}`,
        applicant_id: applicantId,
        to: applicant.email,
        subject,
        provider: willSendForReal ? 'gmail' : 'demo',
        result: 'sent',
        provider_message_id: providerMessageId,
        thread_id: threadId,
        dry_run: willSendForReal ? 'false' : 'true',
      });

      // Responding to a candidate naturally clears their open replies from
      // the Inbox/Replies queue — nobody needs to "handle" a message that
      // has already been answered.
      const replies = await readTab('Replies');
      const open = replies.filter((r) => r.applicant_id === applicantId && !r.handled_at);
      if (open.length) {
        await patchRows('Replies', open.map((r) => ({ _row: r._row, handled_by: 'dashboard', handled_at: now })));
      }

      const attachmentNote = attachments.length ? ` with ${attachments.length} attachment(s)` : '';
      revalidatePath('/', 'layout');
      return NextResponse.json({ ok: true, result: {
        status: 'ok',
        notes: willSendForReal
          ? `Reply actually sent via Gmail to ${applicant.email}${attachmentNote}.`
          : `Reply "sent" to ${applicant.email}${attachmentNote} — logged in Email Log, not actually delivered. ${isGmailConfigured() ? 'Turn off dry run in Settings to send for real.' : 'Configure Gmail to send for real — see dashboard/README.md.'}`,
      } });
    }

    // --- Draft: batch-generate email drafts ---------------------------------
    if (action === 'draft') {
      const configRows = await readTab('Config');
      const config = parseConfig(configRows);
      if (config.toggle_draft === false) {
        return fail(409, 'E-CONFIG', 'Drafting is turned off.', 'Turn on Drafting in Settings.');
      }

      const [applicants, templates] = await Promise.all([readTab('Applicants'), readTab('Templates')]);
      const batch = selectForDrafting({
        applicants, ids: ids.length ? ids : null,
        batchSize: Number(config.batch_size) || 10,
        redraft: body.redraft === true,
      });
      if (!batch.length) {
        return NextResponse.json({ ok: true, result: { status: 'ok', items_in: 0, items_ok: 0, items_failed: 0, notes: 'Nothing to draft.' } });
      }

      const now = new Date().toISOString();
      const patches: Patch[] = [];
      const errors: Array<{ applicant_id?: string; code?: string; message?: string }> = [];

      for (const applicant of batch) {
        try {
          const { template } = selectTemplate(templates, { job_role: applicant.job_role, category: applicant.category });
          let ai: { subject?: string; body_html?: string } | undefined;
          if (usesAi(template)) {
            const prompt = buildDraftPrompt({ applicant, template, config });
            const generated = await groqJson(prompt, { maxTokens: 900 }) as { subject?: string; body_html?: string };
            const check = checkDraftSchema(generated);
            if (!check.ok) throw new GroqError('E-LLM-SCHEMA', `Groq's draft failed validation: ${check.reason}.`, 'Try Draft again.');
            ai = generated;
          }
          const draft = assembleDraft({ applicant, template, config, ai, now });
          patches.push({ _row: applicant._row, ...draft } as Patch);
        } catch (err) {
          const e = err as { code?: string; message: string };
          errors.push({ applicant_id: applicant.applicant_id, code: e.code, message: e.message });
          patches.push({ _row: applicant._row, stage: 'FAILED', status: 'failed', error_code: e.code || 'E-UNKNOWN', error_message: e.message, updated_at: now } as Patch);
        }
      }

      await patchRows('Applicants', patches);
      revalidatePath('/', 'layout');
      const okCount = batch.length - errors.length;
      return NextResponse.json({ ok: errors.length === 0, result: {
        status: errors.length === 0 ? 'ok' : okCount > 0 ? 'partial' : 'failed',
        items_in: batch.length, items_ok: okCount, items_failed: errors.length, errors,
        notes: `${okCount} of ${batch.length} drafted${errors.length ? `, ${errors.length} failed` : ''}.`,
      } });
    }

    // --- Send: the most safety-critical action in the app -------------------
    if (action === 'send') {
      if (!ids.length) {
        return fail(400, 'E-BADREQ', 'No recipients selected.', 'Select the applicants to email. Sending to "everything" is deliberately not possible in one click.');
      }
      const configRows = await readTab('Config');
      const config = parseConfig(configRows);
      if (config.toggle_send === false) {
        return fail(409, 'E-CONFIG', 'Sending is turned off.', 'Turn on Sending in Settings.');
      }

      const dryRun = config.dry_run !== false;
      const willSendForReal = isGmailConfigured() && !dryRun;
      const cap = Number(config.send_daily_cap) || 400;

      const [applicants, emailLog] = await Promise.all([readTab('Applicants'), readTab('EmailLog')]);
      const today = new Date().toISOString().slice(0, 10);
      let budget = Math.max(0, cap - emailLog.filter((r) => r.at.startsWith(today) && r.result === 'sent').length);

      const now = new Date().toISOString();
      const patches: Patch[] = [];
      const logEntries: Array<Record<string, string>> = [];
      const errors: Array<{ applicant_id?: string; message?: string }> = [];
      let okCount = 0;

      const runId = `run-send-${Date.now().toString(36)}`;
      const logSend = (a: (typeof applicants)[number], overrides: Record<string, string>) => logEntries.push({
        at: now, correlation_id: runId, applicant_id: a.applicant_id, to: a.email, subject: a.email_subject,
        provider: '', result: '', provider_message_id: '', thread_id: '', dry_run: 'false', error_code: '', error_message: '',
        ...overrides,
      });

      for (const id of ids) {
        const a = applicants.find((r) => r.applicant_id === id);
        if (!a) { errors.push({ applicant_id: id, message: 'Applicant not found.' }); continue; }

        const reject = (message: string) => errors.push({ applicant_id: a.applicant_id, message });
        if (a.stage !== 'APPROVED') { reject(`Stage is "${a.stage || 'empty'}", not APPROVED. Approve the draft before sending.`); continue; }
        if (!a.email_subject || !a.email_html) { reject('Row is APPROVED but has no draft body. Regenerate the draft.'); continue; }
        if (/\{\{[^}]+\}\}/.test(a.email_subject + a.email_html)) { reject('Draft still contains unresolved merge fields. Nothing was sent.'); continue; }
        if (!/^[^\s@,;:<>()[\]\\]+@[^\s@.]+(\.[^\s@.]+)+$/.test(a.email)) { reject(`"${a.email}" is not a deliverable address.`); continue; }
        if (a.email_status === 'sent') { reject('Already sent. Refusing to send a duplicate.'); continue; }
        if (budget <= 0) { reject(`Daily send cap of ${cap} reached. Remaining sends resume tomorrow.`); continue; }

        let providerMessageId = '';
        let threadId = a.thread_id || '';
        if (willSendForReal) {
          try {
            const sent = await sendMail({
              to: a.email, subject: a.email_subject, html: a.email_html,
              threadId: a.thread_id || undefined, inReplyTo: a.message_id || undefined, references: a.message_id || undefined,
            });
            providerMessageId = sent.id;
            threadId = sent.threadId || threadId;
          } catch (err) {
            const e = err as GmailError;
            reject(e.message);
            logSend(a, { provider: 'gmail', result: 'failed', error_code: e.code || 'E-UNKNOWN', error_message: e.message });
            continue;
          }
        }

        budget--;
        okCount++;
        patches.push({ _row: a._row, email_status: 'sent', sent_at: now, thread_id: threadId, message_id: providerMessageId, stage: 'SENT', error_code: '', error_message: '', updated_at: now });
        logSend(a, { provider: willSendForReal ? 'gmail' : 'demo', result: 'sent', provider_message_id: providerMessageId, thread_id: threadId, dry_run: willSendForReal ? 'false' : 'true' });
      }

      if (patches.length) await patchRows('Applicants', patches);
      for (const entry of logEntries) await appendRow('EmailLog', entry);

      revalidatePath('/', 'layout');
      return NextResponse.json({ ok: errors.length === 0, result: {
        status: errors.length === 0 ? 'ok' : okCount > 0 ? 'partial' : 'failed',
        items_in: ids.length, items_ok: okCount, items_failed: errors.length, errors,
        notes: `${okCount} of ${ids.length} sent${!willSendForReal ? ' (dry run — nothing left the building)' : ''}${errors.length ? `, ${errors.length} rejected` : ''}.`,
      } });
    }

    // --- Preflight: check every credential without writing or sending -------
    if (action === 'preflight') {
      const checks: Array<{ check: string; ok: boolean; detail: string; fix: string }> = [];
      const warnOnly = new Set(['dry_run is ON', 'Gmail configured (optional)']);
      const add = (check: string, ok: boolean, detail = '', fix = '') => checks.push({ check, ok, detail, fix: ok ? '' : fix });

      add('GROQ_API_KEY is set', Boolean(process.env.GROQ_API_KEY), process.env.GROQ_API_KEY ? 'present' : 'missing', 'Add GROQ_API_KEY to the dashboard environment.');

      if (isDemoMode()) {
        add('Google Sheets configured', true, 'not set — running in demo mode with a built-in sample dataset', '');
      } else {
        try {
          const rows = await readTab('Config');
          add('Google Sheets credential works', true, `read ${rows.length} Config row(s)`);
          const expectedKeys = ['dry_run', 'toggle_draft', 'toggle_send', 'categories', 'batch_size', 'company_name', 'hr_name', 'hr_signature', 'send_daily_cap'];
          const missingKeys = expectedKeys.filter((k) => !rows.some((r) => r.key === k));
          add('Config keys are present', missingKeys.length === 0, missingKeys.length ? `missing: ${missingKeys.join(', ')}` : 'ok', 'Run `npm run bootstrap:sheets` — it adds missing keys without touching existing values.');
          const config = parseConfig(rows);
          add('dry_run is ON', config.dry_run === true, config.dry_run === true ? 'no real emails will be sent' : 'REAL EMAILS WILL BE SENT', 'This is only a warning. Turn it off in Settings when ready to send for real.');
        } catch (err) {
          const e = err as SheetsError;
          add('Google Sheets credential works', false, `${e.code}: ${e.message}`, e.hint);
        }
      }

      add('Gmail configured (optional)', isGmailConfigured(), isGmailConfigured() ? 'present' : 'not set — sends stay logged-only, never delivered', 'Run `npm run gmail:oauth` to enable real sending.');

      const failedChecks = checks.filter((c) => !c.ok);
      const fatal = failedChecks.filter((c) => !warnOnly.has(c.check));
      return NextResponse.json({ ok: fatal.length === 0, result: {
        status: fatal.length === 0 ? (failedChecks.length ? 'ok-with-warnings' : 'ok') : 'failed',
        checks,
        summary: fatal.length === 0
          ? `All ${checks.length} checks passed${failedChecks.length ? ` (${failedChecks.length} warning(s))` : ''}.`
          : `${fatal.length} blocking problem(s): ${fatal.map((c) => c.check).join('; ')}`,
      } });
    }

    // --- pure state changes: write to Sheets directly ------------------------
    switch (action) {
      case 'approve':
      case 'unapprove': {
        if (!ids.length) return fail(400, 'E-BADREQ', 'No applicants selected.');
        const rows = await readTab('Applicants');
        const now = new Date().toISOString();
        const targets = rows.filter((r) => ids.includes(r.applicant_id));

        // Enforce the stage machine from lib/schema.js — a row can only be
        // approved/unapproved from the stage that transition legally allows.
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

      case 'set-category': {
        if (!ids.length) return fail(400, 'E-BADREQ', 'No applicants selected.');
        const value = String(body.category ?? '').trim();
        const rows = await readTab('Applicants');
        const targets = rows.filter((r) => ids.includes(r.applicant_id));
        if (!targets.length) return fail(404, 'E-NOTFOUND', 'No matching applicants found.');
        const now = new Date().toISOString();
        const n = await patchRows('Applicants', targets.map((r) => ({ _row: r._row, category: value, updated_at: now })));
        revalidatePath('/', 'layout');
        return NextResponse.json({ ok: true, result: { status: 'ok', notes: `${n} applicant(s) set to category ${value ? `"${value}"` : '(none)'}` } });
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

      default:
        return fail(400, 'E-BADREQ', `Unknown action "${action}".`);
    }
  } catch (err) {
    if (err instanceof TemplateError || err instanceof SheetsError || err instanceof GroqError || err instanceof GmailError) {
      return NextResponse.json({ ok: false, code: err.code, message: err.message, hint: err.hint }, { status: 502 });
    }
    return fail(500, 'E-UNKNOWN', (err as Error)?.message ?? 'Unexpected failure.', 'Check the Vercel function logs.');
  }
}
