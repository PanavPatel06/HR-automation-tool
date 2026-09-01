import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { requireSession } from '../../../lib/auth';
import { readTab, patchRows, appendRow, setConfig, isDemoMode, parseConfig, SheetsError, type Patch } from '../../../lib/sheets';
import { groqJson, GroqError } from '../../../lib/groq';
import { buildMergeContext, render, validateHtml, selectTemplate, renderSkeleton, DEFAULT_TEMPLATE_BODY, TemplateError, FIELD_RE } from '../../../lib/template';
import { sendMail, fetchUrlAttachment, isMailerConfigured, mailFrom, MailerError, MAX_ATTACHMENTS_BYTES, type OutgoingAttachment } from '../../../lib/mailer';
import { TABS } from '../../../lib/contract';

/**
 * EmailLog rows are collected in an array and appended in one pass, which puts
 * them out of reach of tests/write-columns.test.js (it can only read literal
 * appendRow call sites). Typing them off the contract gets the same guarantee
 * at compile time instead: a column that isn't on the tab won't build.
 */
type EmailLogRow = Record<(typeof TABS)['EmailLog'][number], string>;

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Every action the app can take. There are only three that matter:
 *
 *   compose-template  fill a template with one candidate's sheet data
 *   compose-ai        write a message from a brief plus that sheet data
 *   send              deliver it, to one person or several
 *
 * Both compose actions are pure reads — they hand a draft back to the browser
 * and write nothing. A human reads what's in the box before `send` runs. That
 * is the entire review step; there is no separate approval stage, because
 * nothing can be sent that a person has not just looked at.
 */

type Body = { action: string; ids?: string[]; [k: string]: unknown };

function fail(status: number, code: string, message: string, hint = '') {
  return NextResponse.json({ ok: false, code, message, hint }, { status });
}

const EMAIL_RE = /^[^\s@,;:<>()[\]\\]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * Dry run OFF means "these emails are meant to reach people". If the mailer is
 * not configured, there is no way to honour that, and the only safe answer is
 * to stop.
 *
 * The alternative — quietly logging the send as though it happened — is the
 * worst failure this system could have: the log says sent, and nobody finds
 * out until a candidate is never heard from. One blank RESEND_API_KEY in the
 * deploy environment would do it.
 */
function requireMailerWhenLive(dryRun: boolean) {
  if (dryRun || isMailerConfigured()) return null;
  return fail(503, 'E-CONFIG-MISSING',
    'Dry run is off, but email sending is not configured — nothing was sent.',
    'Set RESEND_API_KEY and MAIL_FROM in the deployment environment, or turn dry run back on in Settings. Nothing is logged as sent while this is broken.');
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
    // --- compose: turn sheet data into a message, write nothing -------------

    if (action === 'compose-template' || action === 'compose-ai') {
      const applicantId = String(body.applicant_id ?? '').trim();
      if (!applicantId) return fail(400, 'E-BADREQ', 'No candidate selected.');

      const [applicants, templates, configRows] = await Promise.all([
        readTab('Applicants'), readTab('Templates'), readTab('Config'),
      ]);
      const applicant = applicants.find((a) => a.applicant_id === applicantId);
      if (!applicant) return fail(404, 'E-NOTFOUND', `Candidate ${applicantId} does not exist.`);

      const config = parseConfig(configRows);
      const ctx = buildMergeContext(applicant, config);
      const templateId = String(body.template_id ?? '').trim();
      const template = templateId ? templates.find((t) => t.template_id === templateId) : undefined;
      if (templateId && !template) return fail(404, 'E-NOTFOUND', `Template ${templateId} does not exist.`);

      // Fill a stored template. No model call, so this always works and costs
      // nothing — it is the deterministic half of the app.
      if (action === 'compose-template') {
        if (!template) return fail(400, 'E-BADREQ', 'Pick a template first.');
        const subject = render(template.subject || '', ctx, { escape: false });
        const bodyR = render(template.html || '', ctx, { escape: true });
        return NextResponse.json({ ok: true, result: {
          status: 'ok', subject: subject.html, html: bodyR.html,
          notes: `Loaded "${template.name}" for ${applicant.name || applicant.email}.`
            + (bodyR.unresolved.length ? ` Fill in {{${bodyR.unresolved[0]}}} before sending.` : ''),
        } });
      }

      // --- compose-ai ---
      if (config.toggle_ai === false) {
        return fail(409, 'E-CONFIG', 'AI writing is turned off.', 'Turn on AI writing in Settings, or use a template instead.');
      }
      const instructions = String(body.instructions ?? '').trim().slice(0, 1000);
      if (!instructions && !template) {
        return fail(400, 'E-BADREQ', 'Tell the model what to say.',
          'Type what this email should cover — for example "invite her to a 30-minute call next week" — or pick a template to base it on.');
      }

      // Everything the model knows about this person comes from their row.
      const prompt = [
        'Write an email to a job applicant. Write the final text directly for the person named below — do NOT use {{merge field}} placeholders anywhere in the output.',
        `Candidate: ${ctx.first_name} (full name: ${ctx.name || 'unknown'}), applying for ${ctx.job_role || 'an open role'}${ctx.category ? ` at ${ctx.category} level` : ''}.`,
        applicant.notes ? `What we know about them: ${applicant.notes.slice(0, 500)}. Use this to make the email specific, but do not repeat it back verbatim.` : '',
        `Sign off using company "${ctx.company_name || 'the company'}" and sender "${ctx.hr_name || 'HR'}".`,
        applicant.last_subject ? `The last email we sent them had the subject "${applicant.last_subject}". Do not repeat it wholesale.` : 'We have not emailed them before.',
        template ? `Match the tone of this existing template as a style reference only — do not copy its literal {{placeholders}}: subject "${template.subject}", body "${template.html}".` : '',
        instructions ? `What this email must say, from HR: ${instructions}.` : '',
        'Return JSON only: {"subject": string, "html": string}. The html should be simple, email-safe markup (p, br, a, strong, em, ul/li) — no <script> or <iframe>.',
        'html is the message body only: greeting, a few short paragraphs, sign-off. No <html>, <head>, <body>, no logo, header, or company contact block — those are added automatically around whatever you return.',
        'Do not invent facts, dates, compensation, interview times, or promises beyond what is given above.',
      ].filter(Boolean).join(' ');

      const generated = await groqJson(prompt, { maxTokens: 900 }) as { subject?: string; html?: string };

      // The model writes the message only; the branded shell goes around it
      // here, so an AI-written email leaves the building looking like every
      // other one. Wrapping before the merge pass means the skeleton's own
      // {{company_*}} fields resolve in the same render.
      //
      // Defense in depth: running the model's output through that same merge
      // gate also catches it echoing a literal {{placeholder}} back instead of
      // the real value.
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
        throw new GroqError('E-LLM-JSON', `Groq's draft did not pass validation: ${problems}`, 'Try Write with AI again, or use a template.');
      }

      return NextResponse.json({ ok: true, result: {
        status: 'ok', subject: subjectR.html.trim(), html: bodyR.html,
        notes: `Draft ready for ${ctx.name || applicant.email} — read it, then send.`,
      } });
    }

    // --- send: the only action that reaches a real person ------------------
    //
    // One code path for both shapes. Sending to one person uses the subject and
    // body sitting in the compose box; sending to several renders one named
    // template per recipient, so every message is still something a human
    // composed — just merged with each candidate's own row.
    if (action === 'send') {
      const configRows = await readTab('Config');
      const config = parseConfig(configRows);

      const dryRun = config.dry_run !== false;
      const willSendForReal = !dryRun;
      // Checked once, before a single row is touched or logged: a missing
      // mailer is a deployment fault, not a per-candidate one.
      const misconfigured = requireMailerWhenLive(dryRun);
      if (misconfigured) return misconfigured;

      if (config.toggle_send === false) {
        return fail(409, 'E-CONFIG', 'Sending is turned off.', 'Turn on Sending in Settings.');
      }

      const templateId = String(body.template_id ?? '').trim();
      const singleId = String(body.applicant_id ?? '').trim();
      const targetIds = singleId ? [singleId] : ids;
      if (!targetIds.length) {
        return fail(400, 'E-BADREQ', 'No recipients selected.', 'Sending to "everyone" is deliberately not possible in one click — tick the people you mean.');
      }

      const [applicants, templates, emailLog] = await Promise.all([
        readTab('Applicants'), readTab('Templates'), readTab('EmailLog'),
      ]);
      const template = templateId ? templates.find((t) => t.template_id === templateId) : undefined;
      if (templateId && !template) return fail(404, 'E-NOTFOUND', `Template ${templateId} does not exist.`);

      // Many recipients means the body must come from a template — there is no
      // way for a person to have read twenty different AI drafts.
      const single = targetIds.length === 1;
      if (!single && !template) {
        return fail(400, 'E-BADREQ', 'Pick a template to send to several people.',
          'A written-by-hand message goes to one person at a time; a template is merged separately for each recipient.');
      }

      const cap = Number(config.send_daily_cap) || 100;
      const today = new Date().toISOString().slice(0, 10);
      let budget = Math.max(0, cap - emailLog.filter((r) => r.at.startsWith(today) && r.result === 'sent').length);
      if (budget <= 0) {
        return fail(429, 'E-QUOTA', `Daily send cap of ${cap} reached.`, "Sending resumes tomorrow, or raise send_daily_cap in Settings — Resend's free tier itself cuts off at 100/day.");
      }

      // Fetched once for the whole batch, not once per recipient.
      let attachments: OutgoingAttachment[] = Array.isArray(body.attachments) ? (body.attachments as OutgoingAttachment[]) : [];
      if (template?.attachment_url) {
        attachments = [...attachments, await fetchUrlAttachment(template.attachment_url, template.attachment_name)];
      }
      const totalAttachmentBytes = attachments.reduce((n, a) => n + (a.base64?.length ?? 0), 0);
      if (totalAttachmentBytes > MAX_ATTACHMENTS_BYTES) {
        return fail(413, 'E-VALIDATION', 'Attachments are too large.', `Total attachment size must stay under ${Math.round(MAX_ATTACHMENTS_BYTES / 1024 / 1024)}MB.`);
      }

      const replyTo = replyToAddress(config);
      const now = new Date().toISOString();
      const patches: Patch[] = [];
      const logEntries: EmailLogRow[] = [];
      const errors: Array<{ applicant_id?: string; message?: string }> = [];
      let okCount = 0;

      for (const id of targetIds) {
        const a = applicants.find((r) => r.applicant_id === id);
        if (!a) { errors.push({ applicant_id: id, message: 'Not found in the sheet.' }); continue; }

        const reject = (message: string) => errors.push({ applicant_id: a.applicant_id, message });
        if (!EMAIL_RE.test(a.email)) { reject(`"${a.email}" is not a deliverable address.`); continue; }
        if (budget <= 0) { reject(`Daily send cap of ${cap} reached. The rest resume tomorrow.`); continue; }

        // One recipient: exactly what is in the compose box. Several: the
        // template, merged with this person's row.
        let subject: string;
        let html: string;
        if (single && !template) {
          subject = String(body.subject ?? '').trim();
          html = String(body.html ?? '').trim();
          if (!subject || !html) { reject('Subject and message body are required.'); continue; }
        } else {
          const ctx = buildMergeContext(a, config);
          subject = render(template!.subject || '', ctx, { escape: false }).html;
          html = render(template!.html || '', ctx, { escape: true }).html;
        }

        // Fail-closed, per recipient. A literal {{first_name}} arriving in
        // someone's inbox is worse than a visible error here.
        const leftover = [...new Set([...subject.matchAll(FIELD_RE), ...html.matchAll(FIELD_RE)].map((m) => m[1]))];
        if (leftover.length) {
          reject(`Unresolved merge field(s): ${leftover.map((f) => `{{${f}}}`).join(', ')}. Nothing was sent to this person.`);
          continue;
        }
        const structure = validateHtml(html);
        if (!structure.ok) { reject(`Message HTML is invalid: ${structure.problems.join(' ')}`); continue; }

        let providerMessageId = '';
        if (willSendForReal) {
          try {
            const sent = await sendMail({ to: a.email, subject, html, attachments, replyTo });
            providerMessageId = sent.id;
          } catch (err) {
            // One rejected recipient must not abort the batch, and must never
            // leave the row looking as though it was written to.
            const e = err as MailerError;
            reject(e.message);
            logEntries.push({
              at: now, applicant_id: a.applicant_id, to: a.email, subject,
              result: 'failed', provider_message_id: '', dry_run: 'false',
              error_code: e.code || 'E-UNKNOWN', error_message: e.message,
            });
            continue;
          }
        }

        budget--;
        okCount++;
        logEntries.push({
          at: now, applicant_id: a.applicant_id, to: a.email, subject,
          result: 'sent', provider_message_id: providerMessageId,
          dry_run: willSendForReal ? 'false' : 'true', error_code: '', error_message: '',
        });
        patches.push({ _row: a._row, last_subject: subject, last_sent_at: now, updated_at: now });
      }

      // EmailLog first, on its own: a send that isn't in the log is a send
      // somebody repeats, so the audit row matters more than the candidate row.
      for (const entry of logEntries) await appendRow('EmailLog', entry);
      try {
        if (patches.length) await patchRows('Applicants', patches);
      } catch (err) {
        const e = err as SheetsError;
        return fail(500, e.code || 'E-UNKNOWN',
          `${okCount} email(s) ${willSendForReal ? 'were sent' : 'were logged'}, but updating the sheet afterwards failed: ${e.message}`,
          `${willSendForReal ? 'Do not send again — they have already gone out. ' : ''}Every one is recorded in the Email Log.`);
      }

      revalidatePath('/', 'layout');
      const attachmentNote = attachments.length ? ` with ${attachments.length} attachment(s)` : '';
      return NextResponse.json({ ok: errors.length === 0, result: {
        status: errors.length === 0 ? 'ok' : okCount > 0 ? 'partial' : 'failed',
        items_in: targetIds.length, items_ok: okCount, items_failed: errors.length, errors,
        notes: willSendForReal
          ? `${okCount} of ${targetIds.length} sent${attachmentNote}. Replies go to ${replyTo || mailFrom()}.`
          : `${okCount} of ${targetIds.length} logged${attachmentNote} — dry run, nothing left the building. ${isMailerConfigured() ? 'Turn off dry run in Settings to send for real.' : 'Set RESEND_API_KEY and MAIL_FROM to send for real.'}`,
      } });
    }

    // --- everything else: small, boring, and rarely used --------------------

    if (action === 'add-applicant') {
      const name = String(body.name ?? '').trim();
      const email = String(body.email ?? '').trim().toLowerCase();
      const jobRole = String(body.job_role ?? '').trim();
      const category = String(body.category ?? '').trim();
      const notes = String(body.notes ?? '').trim();
      if (!email) return fail(400, 'E-BADREQ', 'An email address is required.');
      if (!EMAIL_RE.test(email)) return fail(400, 'E-BADREQ', `"${email}" is not a valid email address.`);

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
        name, email, job_role: jobRole, category, notes,
        created_at: now, updated_at: now,
      });

      revalidatePath('/', 'layout');
      return NextResponse.json({ ok: true, result: {
        status: 'ok', applicant_id: applicant.applicant_id,
        notes: `Added ${email} to the Applicants tab.`,
      } });
    }

    if (action === 'template-generate') {
      const config = parseConfig(await readTab('Config'));
      if (config.toggle_ai === false) {
        return fail(409, 'E-CONFIG', 'AI writing is turned off.', 'Turn on AI writing in Settings.');
      }
      const jobRole = String(body.job_role ?? '').trim();
      const purpose = String(body.purpose ?? 'initial outreach to a job applicant').trim();
      const tone = String(body.tone ?? 'warm, professional, concise').trim();
      const notes = String(body.notes ?? '').trim().slice(0, 500);

      const prompt = [
        `Write the body of a recruiting email template for ${jobRole || 'any role'} candidates.`,
        `Purpose: ${purpose}. Tone: ${tone}.`,
        notes ? `Extra instructions: ${notes}.` : '',
        'Return JSON only: {"subject": string, "html": string}.',
        'The html MUST include the literal placeholders {{first_name}}, {{job_role}}, {{company_name}} and {{hr_signature}} somewhere appropriate.',
        'html is just the message body — a few short <p> paragraphs plus those placeholders. No <html>, <head>, <body>, header, logo, or company contact details: those are added automatically around whatever you return.',
        'Keep it concise. Do not invent facts, dates, compensation, or promises.',
      ].filter(Boolean).join(' ');

      const generated = await groqJson(prompt) as { subject?: string; html?: string };
      // Every template — hand-written seed or AI-generated — shares the same
      // branded shell; only this inner message fragment differs.
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
      return NextResponse.json({ ok: true, result: { status: 'ok', notes: `"${created.name}" generated and saved inactive — read it, then activate it.` } });
    }

    // --- Preflight: check every credential without writing or sending -------
    if (action === 'preflight') {
      const checks: Array<{ check: string; ok: boolean; detail: string; fix: string }> = [];
      const warnOnly = new Set(['dry_run is ON', 'Email sending configured (optional)']);
      const add = (check: string, ok: boolean, detail = '', fix = '') => checks.push({ check, ok, detail, fix: ok ? '' : fix });
      // Whether a missing mailer is a warning or a failure depends on dry run,
      // which is read below. Recorded here, judged at the end.
      let liveSending = false;

      add('GROQ_API_KEY is set', Boolean(process.env.GROQ_API_KEY), process.env.GROQ_API_KEY ? 'present' : 'missing', 'Add GROQ_API_KEY to the dashboard environment. Without it, only templates work.');

      if (isDemoMode()) {
        add('Google Sheets configured', true, 'not set — running in demo mode with a built-in sample dataset', '');
        // Still read the switches: a rehearsal in demo mode should surface the
        // same "live but no mailer" failure a real deployment would.
        liveSending = parseConfig(await readTab('Config')).dry_run === false;
      } else {
        try {
          const rows = await readTab('Config');
          add('Google Sheets credential works', true, `read ${rows.length} Config row(s)`);
          const expectedKeys = ['dry_run', 'toggle_send', 'toggle_ai', 'send_daily_cap', 'company_name', 'hr_name', 'hr_signature', 'company_email'];
          const missingKeys = expectedKeys.filter((k) => !rows.some((r) => r.key === k));
          add('Config keys are present', missingKeys.length === 0, missingKeys.length ? `missing: ${missingKeys.join(', ')}` : 'ok', 'Run `npm run bootstrap:sheets` — it adds missing keys without touching existing values.');

          const applicants = await readTab('Applicants');
          const badEmails = applicants.filter((a) => a.applicant_id && a.email && !EMAIL_RE.test(a.email));
          add('Candidate email addresses look valid', badEmails.length === 0,
            badEmails.length ? `${badEmails.length} bad: ${badEmails.slice(0, 3).map((a) => `${a.applicant_id} (${a.email})`).join(', ')}` : `${applicants.length} row(s) checked`,
            'Fix the address in the Applicants tab. These rows are refused at send time.');

          const config = parseConfig(rows);
          liveSending = config.dry_run === false;
          add('dry_run is ON', config.dry_run === true, config.dry_run === true ? 'no real emails will be sent' : 'REAL EMAILS WILL BE SENT', 'This is only a warning. Turn it off in Settings when ready to send for real.');
        } catch (err) {
          const e = err as SheetsError;
          add('Google Sheets credential works', false, `${e.code}: ${e.message}`, e.hint);
        }
      }

      // Optional only while dry run is on. Once sending is live it is the
      // difference between mail going out and mail silently not going out, so
      // it is promoted to a hard failure and named accordingly.
      if (liveSending) {
        add('Email sending configured (REQUIRED — dry run is off)', isMailerConfigured(),
          isMailerConfigured() ? `sending as ${mailFrom()}` : 'MISSING — every send will be refused until this is fixed',
          'Set RESEND_API_KEY and MAIL_FROM in the deployment environment, or turn dry run back on in Settings.');
      } else {
        add('Email sending configured (optional)', isMailerConfigured(),
          isMailerConfigured() ? `sending as ${mailFrom()}` : 'not set — sends stay logged-only, never delivered',
          'Set RESEND_API_KEY and MAIL_FROM to enable real sending.');
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

    switch (action) {
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
