import 'server-only';

/**
 * Outbound email, via Resend's HTTP API.
 *
 * Replaces the old Gmail API integration. Gmail needed a Google Cloud
 * project, an OAuth consent screen and a refresh token that silently expires
 * after 7 days while the app is unverified; Resend needs an API key and a
 * verified sending domain. Nothing here reads a mailbox — candidates' replies
 * land in whatever inbox `reply_to` points at, and a human reads them there.
 *
 * One HTTPS POST, so no SDK: `fetch` is already in the runtime.
 *
 * Every caller in app/api/action/route.ts checks the `dry_run` Config flag
 * itself before this file builds a request — sendMail() has no dry-run mode of
 * its own, it always sends for real.
 */

export class MailerError extends Error {
  code: string;
  hint: string;
  constructor(code: string, message: string, hint: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

/**
 * Both halves are required. A key with no From address cannot send, and a From
 * address with no key cannot either — treating "half configured" as configured
 * is how a deployment ends up logging sends that never happened.
 */
export function isMailerConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

/** The visible sender, e.g. `3Space Hiring <hiring@3space.in>`. */
export function mailFrom(): string {
  return String(process.env.MAIL_FROM ?? '').trim();
}

export type OutgoingAttachment = { filename: string; mimeType: string; base64: string };

/** Total base64 attachment payload accepted per send — Resend's own ceiling is 40MB. */
export const MAX_ATTACHMENTS_BYTES = 15 * 1024 * 1024;

/**
 * A template's file attachment is stored as a plain URL (a Drive "anyone with
 * the link" share, or any other public link) rather than uploaded through the
 * dashboard, so this needs no storage of its own. Fetched fresh at send time
 * rather than cached, so replacing the linked file takes effect on the next
 * send with no template edit needed.
 */
export async function fetchUrlAttachment(url: string, filename?: string): Promise<OutgoingAttachment> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new MailerError('E-ATTACHMENT-FETCH', 'Could not fetch the template attachment.', `Check the URL is reachable: ${(err as Error)?.message ?? String(err)}`);
  }
  if (!res.ok) {
    throw new MailerError('E-ATTACHMENT-FETCH', `Template attachment URL returned ${res.status}.`, 'Make sure the link is shared "anyone with the link" and reachable without login.');
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ATTACHMENTS_BYTES) {
    throw new MailerError('E-VALIDATION', 'Template attachment is too large.', `Must stay under ${Math.round(MAX_ATTACHMENTS_BYTES / 1024 / 1024)}MB.`);
  }
  const mimeType = res.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
  return { filename: filename?.trim() || url.split('/').pop() || 'attachment', mimeType, base64: buf.toString('base64') };
}

/** Strip tags for the text/plain alternative. Spam filters mark HTML-only mail down. */
function toPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Resend reports failures as a JSON body with `name` and `message`. The status
 * alone is ambiguous — a 403 is both "bad key" and "you haven't verified a
 * domain yet" — so the message is inspected to tell the two apart, because
 * they need completely different fixes.
 */
function mapError(status: number, payload: { name?: string; message?: string } | null): MailerError {
  const message = payload?.message || `Resend returned HTTP ${status}.`;

  if (status === 401 || payload?.name === 'missing_api_key' || payload?.name === 'restricted_api_key') {
    return new MailerError('E-MAIL-AUTH', `Resend rejected the API key: ${message}`, 'Check RESEND_API_KEY in the deployment environment. Generate a new key at resend.com/api-keys with "Sending access".');
  }
  // The single most common first-send failure: on a fresh Resend account you
  // may only email yourself until a domain is verified.
  if (/domain|verif|testing emails|own email address/i.test(message)) {
    return new MailerError('E-MAIL-DOMAIN', `Resend refused the sender address: ${message}`,
      `Verify your domain at resend.com/domains (add the DNS records it gives you), then set MAIL_FROM to an address at that domain. Until a domain is verified, Resend only delivers to the address that owns the account.`);
  }
  if (status === 403) return new MailerError('E-MAIL-AUTH', `Resend refused the request: ${message}`, 'Check the API key has sending permission, and that MAIL_FROM is at a domain you have verified.');
  if (status === 422) return new MailerError('E-VALIDATION', `Resend rejected the message: ${message}`, 'Usually a malformed recipient address or an oversized attachment.');
  if (status === 429) return new MailerError('E-MAIL-429', `Resend rate limit hit: ${message}`, 'The free tier allows 100 emails/day and 2 requests/second. Wait and retry, or upgrade the plan.');
  return new MailerError('E-UNKNOWN', `Resend request failed: ${message}`, 'Check the server logs and resend.com/emails for the delivery record.');
}

/**
 * Send one email. Returns Resend's message id, which is what gets written to
 * EmailLog so a send can be traced back to a delivery record in their console.
 *
 * `replyTo` is what makes the reply loop work without any mailbox access: the
 * candidate hits Reply and their answer goes to a real human inbox, not to
 * this app.
 */
export async function sendMail(args: {
  to: string; subject: string; html: string; replyTo?: string; attachments?: OutgoingAttachment[];
}): Promise<{ id: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = mailFrom();
  if (!apiKey || !from) {
    throw new MailerError('E-CONFIG-MISSING', 'Email sending is not configured.', 'Set RESEND_API_KEY and MAIL_FROM in the deployment environment.');
  }

  const attachments = args.attachments ?? [];
  const totalSize = attachments.reduce((n, a) => n + a.base64.length, 0);
  if (totalSize > MAX_ATTACHMENTS_BYTES) {
    throw new MailerError('E-VALIDATION', 'Attachments are too large.', `Total attachment size must stay under ${Math.round(MAX_ATTACHMENTS_BYTES / 1024 / 1024)}MB.`);
  }

  let res: Response;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [args.to],
        subject: args.subject,
        html: args.html,
        text: toPlainText(args.html),
        ...(args.replyTo ? { reply_to: args.replyTo } : {}),
        ...(attachments.length
          ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.base64, content_type: a.mimeType })) }
          : {}),
      }),
    });
  } catch (err) {
    // A network failure here is genuinely ambiguous — the request may or may
    // not have reached Resend. Say so rather than implying nothing was sent.
    throw new MailerError('E-MAIL-NETWORK', `Could not reach Resend: ${(err as Error)?.message ?? String(err)}`,
      'The email may or may not have been accepted. Check resend.com/emails before retrying, so you do not send a duplicate.');
  }

  const payload = await res.json().catch(() => null) as { id?: string; name?: string; message?: string } | null;
  if (!res.ok) throw mapError(res.status, payload);
  if (!payload?.id) {
    throw new MailerError('E-UNKNOWN', 'Resend accepted the request but returned no message id.', 'Check resend.com/emails to confirm whether it was delivered before retrying.');
  }
  return { id: payload.id };
}
