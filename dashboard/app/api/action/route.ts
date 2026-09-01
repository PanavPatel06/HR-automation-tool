import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { requireSession } from '../../../lib/auth';
import { readTab, patchRows, appendRow, setConfig, isDemoMode, parseConfig, SheetsError, type Patch } from '../../../lib/sheets';
import { groqJson, GroqError } from '../../../lib/groq';
import { buildMergeContext, render, validateHtml, selectTemplate, renderSkeleton, DEFAULT_TEMPLATE_BODY, TemplateError, FIELD_RE } from '../../../lib/template';
import { selectForDrafting, usesAi, buildDraftPrompt, checkDraftSchema, assembleDraft } from '../../../lib/draft';
import { sendMail, fetchUrlAttachment, isMailerConfigured, mailFrom, mailHost, verifyMailer, MailerError, MAX_ATTACHMENTS_BYTES, type OutgoingAttachment } from '../../../lib/mailer';
import { ACTIONABLE } from '../../../lib/contract';
import { findDuplicates, describeDuplicates } from '../../../lib/duplicates';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Every mutating action the dashboard can take. Approval is a pure state
 * change written straight to Sheets — it must never be a model's decision, so
 * it never leaves this process. Draft and Send are the only actions with a
 * side effect outside the sheet (spending model quota, sending mail).
 */

type Body = { action: string; ids?: string[]; [k: string]: unknown };

function fail(status: number, code: string, message: string, hint = '') {
  return NextResponse.json({ ok: false, code, message, hint }, { status });
}

/** Pragmatic check — catches typos and empty cells, not a full RFC 5322 parse. */
const EMAIL_RE = /^[^\s@,;:<>()[\]\\]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * Dry run OFF means "these emails are meant to reach people". If the mailer is
 * not configured, there is no way to honour that, and the only safe answer is
 * to stop.
 *
 * The alternative — quietly logging the send as though it happened — is the
 * worst failure this system could have: rows march to SENT, EmailLog says
 * sent, and nobody finds out until a candidate is never heard from. One blank
 * MAIL_PASSWORD in the deploy environment would do it.
 *
 * Returns a response when sending must be refused, otherwise null.
 */
function requireMailerWhenLive(dryRun: boolean) {
  if (dryRun || isMailerConfigured()) return null;
  return fail(503, 'E-CONFIG-MISSING',
    'Dry run is off, but email sending is not configured — nothing was sent.',
    'Set MAIL_USER and MAIL_PASSWORD in the deployment environment, or turn dry run back on in Settings. Nothing is logged as sent while this is broken.');
}

/** Candidates hit Reply on the email; their answer must reach a human, not this app. */
function replyToAddress(config: Record<string, unknown>): string | undefined {
  return String(config.company_email ?? '').trim() || undefined;
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
        `Write the body of a recruiting email template for ${jobRole || 'any role'} candidates.`,
        `Purpose: ${purpose}. Tone: ${tone}.`,
        notes ? `Extra instructions: ${notes}.` : '',
        'Return JSON only: {"subject": string, "html": string}.',
        'The html MUST include the literal placeholders {{first_name}}, {{job_role}}, {{company_name}}, {{ai_body}}, and {{hr_signature}} somewhere appropriate.',
        'html is just the message body — a few short <p> paragraphs plus those placeholders. No <html>, <head>, <body>, header, logo, or company contact details: those are added automatically around whatever you return.',
        'Keep it concise. Do not invent facts, dates, compensation, or promises.',
      ].filter(Boolean).join(' ');

      const generated = await groqJson(prompt) as { subject?: string; html?: string };
      // Every template — hand-written seed or AI-generated — shares the same
      // branded shell (logo, contact header, footer); only this inner
      // message fragment differs. See renderSkeleton() in lib/template.ts.
      const created = await appendRow('Templates', {
        template_id: `TPL-AI-${Date.now().toString(36).toUpperCase()}`,
        name: `AI draft — ${jobRole || 'any role'}`,
        job_role: jobRole,
        subject: generated.subject || `Your application for ${jobRole || 'the role'}`,
        html: renderSkeleton(generated.html || DEFAULT_TEMPLATE_BODY),
        source: 'ai',
        is_active: 'FALSE',
        is_default: 'FALSE',
        updated_at: new Date().toISOString(),
      });

      revalidatePath('/', 'layout');
      return NextResponse.json({ ok: true, result: { status: 'ok', notes: `"${created.name}" generated with Groq and saved inactive — review it, then activate.` } });
    }

    // --- Composing a reply to one candidate ---------------------------------
    //
    // Draft/send further down are the *bulk* pipeline — batches of applicants
    // moving through a stage machine. Replying to one person is a different
    // shape: their name, role and category come out of the Applicants row, you
    // add a line of instructions, and the model writes the message.
    // reply-template-fill and reply-ai-draft never write anything; send-reply
    // answers to the same Sending switch, daily cap and mailer requirement the
    // bulk pipeline does.
    if (action === 'start-conversation') {
      const name = String(body.name ?? '').trim();
      const email = String(body.email ?? '').trim().toLowerCase();
      const jobRole = String(body.job_role ?? '').trim();
      const category = String(body.category ?? '').trim();
      const notes = String(body.notes ?? '').trim();
      if (!email) return fail(400, 'E-BADREQ', 'An email address is required.');
      // Pragmatic check — catches typos and empty cells, not a full RFC 5322 parse.
      if (!/^[^\s@,;:<>()[\]\\]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) {
        return fail(400, 'E-BADREQ', `"${email}" is not a valid email address.`);
      }

      const applicants = await readTab('Applicants');
      const existing = applicants.find((a) => a.email.toLowerCase() === email);
      if (existing) {
        return NextResponse.json({ ok: true, result: {
          status: 'ok', applicant_id: existing.applicant_id,
          notes: `${email} is already in the sheet — opening the existing row.`,
        } });
      }

      const now = new Date().toISOString();
      const applicant = await appendRow('Applicants', {
        applicant_id: `APP-${Date.now().toString(36).toUpperCase()}`,
        name, email, job_role: jobRole, category,
        stage: 'NEW', created_at: now, updated_at: now,
      });

      revalidatePath('/', 'layout');
      return NextResponse.json({ ok: true, result: {
        status: 'ok', applicant_id: applicant.applicant_id,
        notes: `Added ${email} to the Applicants tab.`,
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
        notes: template ? `Loaded "${template.name}" for ${applicant.name || applicant.email}. Fill in any {{fields}} still showing before sending.` : 'Blank message.',
      } });
    }

    if (action === 'reply-ai-draft') {
      // The centre of the app now: the candidate's name, role and category come
      // out of their Applicants row, HR adds a line of instructions, and the
      // model writes the message. Reads only — nothing is written until Send.
      const applicantId = String(body.applicant_id ?? '').trim();
      if (!applicantId) return fail(400, 'E-BADREQ', 'No applicant selected.');

      const [applicants, templates, configRows] = await Promise.all([
        readTab('Applicants'), readTab('Templates'), readTab('Config'),
      ]);
      const applicant = applicants.find((a) => a.applicant_id === applicantId);
      if (!applicant) return fail(404, 'E-NOTFOUND', `Applicant ${applicantId} does not exist.`);

      const config = parseConfig(configRows);
      const ctx = buildMergeContext(applicant, config);
      const templateId = String(body.template_id ?? '').trim();
      const template = templateId ? templates.find((t) => t.template_id === templateId) : undefined;
      const instructions = String(body.instructions ?? '').trim().slice(0, 1000);
      if (!instructions && !template) {
        return fail(400, 'E-BADREQ', 'Tell the model what to say.',
          'Type what this email should cover in the instructions box — for example "invite her to a 30-minute call next week" — or pick a template to base it on.');
      }

      const prompt = [
        'Write an email to a job applicant. Write the final text directly for the person named below — do NOT use {{merge field}} placeholders anywhere in the output.',
        `Candidate: ${ctx.first_name} (full name: ${ctx.name || 'unknown'}), applying for ${ctx.job_role || 'an open role'}${ctx.category ? ` at ${ctx.category} level` : ''}.`,
        `Sign off using company "${ctx.company_name || 'the company'}" and sender "${ctx.hr_name || 'HR'}".`,
        applicant.email_subject
          ? `For context, the last email we sent this candidate had the subject "${applicant.email_subject}". Do not repeat it wholesale.`
          : 'We have not emailed this candidate before.',
        template ? `Match the tone of this existing template as a style reference only — do not copy its literal {{placeholders}}: subject "${template.subject}", body "${template.html}".` : '',
        instructions ? `What this email must say, from HR: ${instructions}.` : '',
        'Return JSON only: {"subject": string, "html": string}. The html should be simple, email-safe markup (p, br, a, strong, em, ul/li) — no <script> or <iframe>.',
        'html is the message body only: greeting, a few short paragraphs, sign-off. No <html>, <head>, <body>, no logo, header, or company contact block — those are added automatically around whatever you return.',
        'Do not invent facts, dates, compensation, interview times, or promises beyond what is given above.',
      ].filter(Boolean).join(' ');

      const generated = await groqJson(prompt, { maxTokens: 900 }) as { subject?: string; html?: string };

      // The model writes the message only; the branded shell goes around it
      // here, so an AI reply leaves the building looking like every other
      // email — same logo, header and footer a stored template gives you.
      // Wrapping before the merge pass means the skeleton's own
      // {{company_*}} fields resolve in the same render.
      //
      // Defense in depth: running the model's output through that same merge
      // gate also catches it echoing a literal {{placeholder}} back instead
      // of the real value.
      const subjectR = render(generated.subject || '', ctx, { escape: false });
      const bodyR = render(renderSkeleton(generated.html || ''), ctx, { escape: true });
      const unresolved = [...new Set([...subjectR.unresolved, ...bodyR.unresolved])];
      const structure = validateHtml(bodyR.html);

      if (unresolved.length || !structure.ok || !subjectR.html.trim()) {
        const problems = [
          ...structure.problems,
          unresolved.length ? `Unresolved field(s): ${unresolved.map((f) => `{{${f}}}`).join(', ')}.` : '',
          !subjectR.html.trim() ? 'Subject was empty.' : '',
        ].filter(Boolean).join(' ');
        throw new GroqError('E-LLM-JSON', `Groq's draft did not pass validation: ${problems}`, 'Try Write with AI again, or write the message manually.');
      }

      return NextResponse.json({ ok: true, result: {
        status: 'ok', subject: subjectR.html.trim(), html: bodyR.html,
        notes: `Draft ready for ${ctx.name || applicant.email} — review it, then send.`,
      } });
    }

    if (action === 'send-reply') {
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

      const applicants = await readTab('Applicants');
      const applicant = applicants.find((a) => a.applicant_id === applicantId);
      if (!applicant) return fail(404, 'E-NOTFOUND', `Applicant ${applicantId} does not exist.`);

      const now = new Date().toISOString();
      const templateId = String(body.template_id ?? '').trim();
      const configRows = await readTab('Config');
      const config = parseConfig(configRows);
      // Real sending only happens when dry_run has been deliberately turned
      // off in Settings. The mailer being configured is not enough on its own
      // — that would make pasting an API key into the environment the same as
      // consenting to email real people, which is the wrong default.
      const dryRun = config.dry_run !== false;
      const willSendForReal = !dryRun;
      // Live sending with no mailer behind it is a broken deployment, not a
      // quieter mode of working. Fail here rather than logging "sent" for an
      // email nobody will ever receive. See requireMailerWhenLive().
      const misconfigured = requireMailerWhenLive(dryRun);
      if (misconfigured) return misconfigured;

      if (config.toggle_send === false) {
        return fail(409, 'E-CONFIG', 'Sending is turned off.', 'Turn on Sending in Settings.');
      }
      const cap = Number(config.send_daily_cap) || 100;
      const today = new Date().toISOString().slice(0, 10);
      const sentToday = (await readTab('EmailLog')).filter((r) => r.at.startsWith(today) && r.result === 'sent').length;
      if (sentToday >= cap) {
        return fail(429, 'E-QUOTA', `Daily send cap of ${cap} reached.`, "Sending resumes tomorrow, or raise send_daily_cap in Settings — Gmail itself cuts off around 500 recipients a day.");
      }

      if (templateId) {
        const templates = await readTab('Templates');
        const template = templates.find((t) => t.template_id === templateId);
        if (template?.attachment_url) attachments.push(await fetchUrlAttachment(template.attachment_url, template.attachment_name));
      }
      const totalAttachmentBytes = attachments.reduce((n, a) => n + (a.base64?.length ?? 0), 0);
      if (totalAttachmentBytes > MAX_ATTACHMENTS_BYTES) {
        return fail(413, 'E-VALIDATION', 'Attachments are too large.', `Total attachment size must stay under ${Math.round(MAX_ATTACHMENTS_BYTES / 1024 / 1024)}MB.`);
      }

      let providerMessageId = '';
      if (willSendForReal) {
        const sent = await sendMail({ to: applicant.email, subject, html, attachments, replyTo: replyToAddress(config) });
        providerMessageId = sent.id;
      }

      // Past this line the email is already gone. EmailLog is written first
      // and on its own: a send that isn't in the log is a send somebody
      // repeats, so the audit row matters more than the pipeline state.
      await appendRow('EmailLog', {
        at: now,
        applicant_id: applicantId,
        to: applicant.email,
        subject,
        result: 'sent',
        provider_message_id: providerMessageId,
        dry_run: willSendForReal ? 'false' : 'true',
      });

      try {
        await patchRows('Applicants', [{
          _row: applicant._row,
          template_id: templateId,
          email_subject: subject,
          email_html: html,
          sent_at: now,
          stage: 'SENT',
          error_code: '',
          error_message: '',
          updated_at: now,
        }]);
      } catch (err) {
        const e = err as SheetsError;
        return fail(500, e.code || 'E-UNKNOWN',
          `The email ${willSendForReal ? 'was sent' : 'was logged'}, but updating the sheet afterwards failed: ${e.message}`,
          `${willSendForReal ? 'Do not send it again — it has already gone out. ' : ''}It is recorded in EmailLog. Fix the sheet problem, then set the row's stage to SENT by hand.`);
      }

      const attachmentNote = attachments.length ? ` with ${attachments.length} attachment(s)` : '';
      revalidatePath('/', 'layout');
      return NextResponse.json({ ok: true, result: {
        status: 'ok',
        notes: willSendForReal
          ? `Sent to ${applicant.email}${attachmentNote}. Replies go to ${replyToAddress(config) || mailFrom()}.`
          : `"Sent" to ${applicant.email}${attachmentNote} — logged in the Email Log, not actually delivered. ${isMailerConfigured() ? 'Turn off dry run in Settings to send for real.' : 'Set MAIL_USER and MAIL_PASSWORD to send for real — see README.md.'}`,
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
          patches.push({ _row: applicant._row, stage: 'FAILED', error_code: e.code || 'E-UNKNOWN', error_message: e.message, updated_at: now } as Patch);
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
      const willSendForReal = !dryRun;
      // Checked once for the whole batch, before a single row is touched: a
      // missing mailer is a deployment fault, not a per-candidate one.
      const misconfigured = requireMailerWhenLive(dryRun);
      if (misconfigured) return misconfigured;
      const cap = Number(config.send_daily_cap) || 100;
      const replyTo = replyToAddress(config);

      const [applicants, emailLog, templates] = await Promise.all([readTab('Applicants'), readTab('EmailLog'), readTab('Templates')]);
      const today = new Date().toISOString().slice(0, 10);
      let budget = Math.max(0, cap - emailLog.filter((r) => r.at.startsWith(today) && r.result === 'sent').length);

      // Fetched once per template_id, not once per applicant — a batch of 200
      // applicants on one template still only downloads the file once.
      const attachmentByTemplate = new Map<string, Promise<OutgoingAttachment | null>>();
      const attachmentFor = (templateId: string) => {
        if (!templateId) return Promise.resolve(null);
        if (!attachmentByTemplate.has(templateId)) {
          const t = templates.find((row) => row.template_id === templateId);
          attachmentByTemplate.set(templateId, t?.attachment_url ? fetchUrlAttachment(t.attachment_url, t.attachment_name) : Promise.resolve(null));
        }
        return attachmentByTemplate.get(templateId)!;
      };

      const now = new Date().toISOString();
      const patches: Patch[] = [];
      const logEntries: Array<Record<string, string>> = [];
      const errors: Array<{ applicant_id?: string; message?: string }> = [];
      let okCount = 0;

      const logSend = (a: (typeof applicants)[number], overrides: Record<string, string>) => logEntries.push({
        at: now, applicant_id: a.applicant_id, to: a.email, subject: a.email_subject,
        result: '', provider_message_id: '', dry_run: 'false', error_code: '', error_message: '',
        ...overrides,
      });

      for (const id of ids) {
        const a = applicants.find((r) => r.applicant_id === id);
        if (!a) { errors.push({ applicant_id: id, message: 'Applicant not found.' }); continue; }

        const reject = (message: string) => errors.push({ applicant_id: a.applicant_id, message });
        if (a.stage !== 'APPROVED') { reject(`Stage is "${a.stage || 'empty'}", not APPROVED. Approve the draft before sending.`); continue; }
        if (!a.email_subject || !a.email_html) { reject('Row is APPROVED but has no draft body. Regenerate the draft.'); continue; }
        if (/\{\{[^}]+\}\}/.test(a.email_subject + a.email_html)) { reject('Draft still contains unresolved merge fields. Nothing was sent.'); continue; }
        if (!EMAIL_RE.test(a.email)) { reject(`"${a.email}" is not a deliverable address.`); continue; }
        if (a.sent_at) { reject('Already sent. Refusing to send a duplicate.'); continue; }
        if (budget <= 0) { reject(`Daily send cap of ${cap} reached. Remaining sends resume tomorrow.`); continue; }

        let providerMessageId = '';
        if (willSendForReal) {
          try {
            const templateAttachment = await attachmentFor(a.template_id);
            const sent = await sendMail({
              to: a.email, subject: a.email_subject, html: a.email_html, replyTo,
              attachments: templateAttachment ? [templateAttachment] : undefined,
            });
            providerMessageId = sent.id;
          } catch (err) {
            // One rejected recipient must not abort the batch, and must never
            // leave the row looking sent. It stays APPROVED and retryable.
            const e = err as MailerError;
            reject(e.message);
            logSend(a, { result: 'failed', error_code: e.code || 'E-UNKNOWN', error_message: e.message });
            continue;
          }
        }

        budget--;
        okCount++;
        patches.push({ _row: a._row, sent_at: now, stage: 'SENT', error_code: '', error_message: '', updated_at: now });
        logSend(a, { result: 'sent', provider_message_id: providerMessageId, dry_run: willSendForReal ? 'false' : 'true' });
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
      const warnOnly = new Set(['dry_run is ON', 'Mailbox logs in (optional)', 'No repeated email address', 'Email addresses look valid']);
      const add = (check: string, ok: boolean, detail = '', fix = '') => checks.push({ check, ok, detail, fix: ok ? '' : fix });
      // Whether a missing mailer is a warning or a failure depends on dry run,
      // which is read further down. Recorded here, judged at the end.
      let liveSending = false;

      add('GROQ_API_KEY is set', Boolean(process.env.GROQ_API_KEY), process.env.GROQ_API_KEY ? 'present' : 'missing', 'Add GROQ_API_KEY to the dashboard environment.');

      if (isDemoMode()) {
        add('Google Sheets configured', true, 'not set — running in demo mode with a built-in sample dataset', '');
        // Still read the switches: a rehearsal in demo mode should surface the
        // same "live but no mailer" failure a real deployment would.
        liveSending = parseConfig(await readTab('Config')).dry_run === false;
      } else {
        try {
          const rows = await readTab('Config');
          add('Google Sheets credential works', true, `read ${rows.length} Config row(s)`);
          const expectedKeys = ['dry_run', 'toggle_draft', 'toggle_send', 'categories', 'batch_size', 'company_name', 'hr_name', 'hr_signature', 'send_daily_cap'];
          const missingKeys = expectedKeys.filter((k) => !rows.some((r) => r.key === k));
          add('Config keys are present', missingKeys.length === 0, missingKeys.length ? `missing: ${missingKeys.join(', ')}` : 'ok', 'Run `npm run bootstrap:sheets` — it adds missing keys without touching existing values.');
          const config = parseConfig(rows);
          liveSending = config.dry_run === false;
          add('dry_run is ON', config.dry_run === true, config.dry_run === true ? 'no real emails will be sent' : 'REAL EMAILS WILL BE SENT', 'This is only a warning. Turn it off in Settings when ready to send for real.');
        } catch (err) {
          const e = err as SheetsError;
          add('Google Sheets credential works', false, `${e.code}: ${e.message}`, e.hint);
        }
      }

      // Optional only while dry run is on. Once sending is live it is the
      // difference between mail going out and mail silently not going out,
      // so it is promoted to a hard failure and named accordingly.
      const label = liveSending ? 'Mailbox logs in (REQUIRED — dry run is off)' : 'Mailbox logs in (optional)';
      if (!isMailerConfigured()) {
        add(label, false,
          liveSending ? 'MISSING — every send will be refused until this is fixed' : 'not set — sends stay logged-only, never delivered',
          'Set MAIL_USER and MAIL_PASSWORD in the deployment environment. For Gmail that is your address and a 16-character App Password (2-Step Verification must be on).');
      } else {
        // Actually open the connection and authenticate. Checking the two
        // variables are merely *present* is what let a typo'd password sit
        // undetected until the first real send; this proves it logs in.
        try {
          await verifyMailer();
          add(label, true, `${mailFrom()} via ${mailHost()}`);
        } catch (err) {
          const e = err as MailerError;
          add(label, false, `${e.code}: ${e.message}`, e.hint);
        }
      }

      // Data checks, run in demo mode too: they are about the rows, not the
      // credential, so a rehearsal should surface exactly what a real sheet
      // would. A repeated applicant_id is a silent correctness bug — every
      // lookup takes the first match — so it blocks; a repeated address or a
      // malformed one only affects that person and is visible, so they warn.
      try {
        const applicants = await readTab('Applicants');
        const withId = applicants.filter((a) => a.applicant_id);
        const duplicates = findDuplicates(applicants);

        const repeatedIds = duplicates.filter((d) => d.kind === 'applicant_id');
        add('No repeated applicant_id', repeatedIds.length === 0,
          repeatedIds.length ? describeDuplicates(repeatedIds) : `${withId.length} row(s) checked`,
          'Two rows with one id means every action on it silently hits the first row. Give one of them a new id in the sheet.');

        const repeatedEmails = duplicates.filter((d) => d.kind === 'email');
        add('No repeated email address', repeatedEmails.length === 0,
          repeatedEmails.length ? describeDuplicates(repeatedEmails) : 'none',
          'That person receives every email twice. Delete the duplicate row, or correct the address on the candidate.');

        const badEmails = withId.filter((a) => a.email && !EMAIL_RE.test(a.email));
        add('Email addresses look valid', badEmails.length === 0,
          badEmails.length ? `${badEmails.length} bad: ${badEmails.slice(0, 3).map((a) => `${a.applicant_id} (${a.email})`).join(', ')}` : 'all parse',
          'Fix it on the candidate, or in the Applicants tab. These rows are refused at send time.');
      } catch (err) {
        const e = err as SheetsError;
        add('Applicants tab is readable', false, `${e.code}: ${e.message}`, e.hint);
      }

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
          ? { _row: r._row, stage: 'APPROVED', error_code: '', error_message: '', updated_at: now }
          : { _row: r._row, stage: 'DRAFTED', updated_at: now }));

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

      case 'set-email': {
        // A row can arrive from a form or a paste with a typo'd or missing
        // address — APP-1006 in the demo data is exactly that. Sending refuses
        // those rows, so being able to correct one here is the difference
        // between fixing it in two seconds and going hunting in the sheet.
        const applicantId = String(body.applicant_id ?? '').trim();
        const email = String(body.email ?? '').trim().toLowerCase();
        if (!applicantId) return fail(400, 'E-BADREQ', 'No applicant selected.');
        if (!email) return fail(400, 'E-BADREQ', 'An email address is required.');
        if (!EMAIL_RE.test(email)) return fail(400, 'E-VALIDATION', `"${email}" is not a valid email address.`, 'It needs an @ and a domain with a dot, e.g. name@example.com.');

        const rows = await readTab('Applicants');
        const target = rows.find((r) => r.applicant_id === applicantId);
        if (!target) return fail(404, 'E-NOTFOUND', `Applicant ${applicantId} does not exist.`);

        // Refuse to *create* a duplicate here, rather than only reporting it
        // later: two rows with one address means someone gets emailed twice.
        const clash = rows.find((r) => r.applicant_id !== applicantId && r.email.trim().toLowerCase() === email);
        if (clash) {
          return fail(409, 'E-VALIDATION', `${email} is already on ${clash.applicant_id} (${clash.name || 'no name'}).`,
            'Two rows sharing an address means that person gets every email twice. Use a different address, or delete the duplicate row in the sheet.');
        }

        const now = new Date().toISOString();
        await patchRows('Applicants', [{ _row: target._row, email, updated_at: now }]);
        revalidatePath('/', 'layout');
        return NextResponse.json({ ok: true, result: { status: 'ok', notes: `${target.name || applicantId} is now ${email}.` } });
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

      case 'set-template-attachment': {
        const templateId = String(body.template_id ?? '');
        const attachmentUrl = String(body.attachment_url ?? '').trim();
        const attachmentName = String(body.attachment_name ?? '').trim();
        if (attachmentUrl && !/^https?:\/\//i.test(attachmentUrl)) {
          return fail(400, 'E-VALIDATION', 'Attachment URL must start with http:// or https://.');
        }
        const rows = await readTab('Templates');
        const target = rows.find((r) => r.template_id === templateId);
        if (!target) return fail(404, 'E-NOTFOUND', `Template ${templateId} does not exist.`);
        await patchRows('Templates', [{ _row: target._row, attachment_url: attachmentUrl, attachment_name: attachmentName, updated_at: new Date().toISOString() }]);
        revalidatePath('/', 'layout');
        return NextResponse.json({ ok: true, result: { status: 'ok', notes: attachmentUrl ? `Attachment set on ${target.name}.` : `Attachment removed from ${target.name}.` } });
      }

      default:
        return fail(400, 'E-BADREQ', `Unknown action "${action}".`);
    }
  } catch (err) {
    if (err instanceof TemplateError || err instanceof SheetsError || err instanceof GroqError || err instanceof MailerError) {
      return NextResponse.json({ ok: false, code: err.code, message: err.message, hint: err.hint }, { status: 502 });
    }
    return fail(500, 'E-UNKNOWN', (err as Error)?.message ?? 'Unexpected failure.', 'Check the server logs.');
  }
}
