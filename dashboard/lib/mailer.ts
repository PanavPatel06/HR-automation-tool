import 'server-only';
import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Outbound email, over plain SMTP.
 *
 * Two integrations came before this one and both were rejected for the same
 * reason — setup cost out of all proportion to "send an email":
 *
 *   - The Gmail API needed a Google Cloud project, an OAuth consent screen and
 *     a refresh token that silently expires after seven days while the app is
 *     unverified.
 *   - Resend needed a domain you control DNS for, because it will only deliver
 *     to the account owner's own address until a domain is verified.
 *
 * SMTP with a Gmail App Password needs neither. Turn on 2-Step Verification,
 * generate a 16-character password, and that is the entire setup. The password
 * does not expire, there is no consent screen, and mail goes out from a real
 * mailbox — so replies land there naturally and every send also appears in that
 * account's Sent folder, which is a free second audit trail.
 *
 * Nothing here is Gmail-specific: MAIL_HOST/MAIL_PORT default to Gmail but
 * point anywhere, so moving to a company mail server or a paid relay later is
 * an environment change rather than a code change.
 *
 * Every caller in app/api/action/route.ts checks the `dry_run` Config flag
 * before this file builds anything — sendMail() has no dry-run mode of its own,
 * it always sends for real.
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

const DEFAULT_HOST = 'smtp.gmail.com';
const DEFAULT_PORT = 465;

/**
 * The account that authenticates to the SMTP server. Both halves are required:
 * a user with no password cannot log in and a password with no user cannot
 * either, and treating "half configured" as configured is how a deployment
 * ends up logging sends that never happened.
 */
export function isMailerConfigured(): boolean {
  return Boolean(process.env.MAIL_USER && process.env.MAIL_PASSWORD);
}

/**
 * The visible sender. Gmail rewrites this to the authenticated account anyway
 * unless the address is a verified alias, so it defaults to MAIL_USER — set
 * MAIL_FROM only to add a display name, e.g.
 * `3Space Hiring <3spacetechcorp@gmail.com>`.
 */
export function mailFrom(): string {
  return String(process.env.MAIL_FROM ?? '').trim() || String(process.env.MAIL_USER ?? '').trim();
}

/** Where the SMTP connection goes, for preflight to show without sending anything. */
export function mailHost(): string {
  return `${process.env.MAIL_HOST || DEFAULT_HOST}:${process.env.MAIL_PORT || DEFAULT_PORT}`;
}

export type OutgoingAttachment = { filename: string; mimeType: string; base64: string };

/** Total base64 attachment payload accepted per send. Gmail's own ceiling is 25MB. */
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

/** Strip tags for the text/plain alternative. HTML-only mail scores worse with spam filters. */
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
 * One transporter for the process, not one per send: it keeps a pooled
 * connection, so a batch of fifty candidates is one TLS handshake rather than
 * fifty. Built lazily so importing this file never opens a socket.
 */
let transporter: Transporter | null = null;

function transport(): Transporter {
  if (transporter) return transporter;

  const user = process.env.MAIL_USER;
  const pass = process.env.MAIL_PASSWORD;
  if (!user || !pass) {
    throw new MailerError('E-CONFIG-MISSING', 'Email sending is not configured.', 'Set MAIL_USER and MAIL_PASSWORD in the deployment environment.');
  }

  const port = Number(process.env.MAIL_PORT) || DEFAULT_PORT;
  transporter = nodemailer.createTransport({
    host: process.env.MAIL_HOST || DEFAULT_HOST,
    port,
    // 465 is implicit TLS; 587 starts plaintext and upgrades via STARTTLS.
    // Getting this pair wrong is the classic "connection hangs forever".
    secure: port === 465,
    auth: { user, pass },
    pool: true,
    maxConnections: 1,
    // Gmail counts recipients per rolling 24h; one message per recipient keeps
    // the accounting simple and means one bad address never poisons a batch.
    maxMessages: 100,
  });
  return transporter;
}

/**
 * SMTP reports failures as a numeric reply code plus a server message. The
 * code alone is ambiguous — a 535 is both "wrong password" and "you used your
 * Google account password instead of an App Password" — so the message is
 * inspected to tell them apart, because they need different fixes.
 */
function mapError(err: unknown): MailerError {
  const e = err as { responseCode?: number; code?: string; message?: string; response?: string };
  const status = e?.responseCode;
  const text = `${e?.response || e?.message || String(err)}`;

  if (status === 535 || e?.code === 'EAUTH') {
    return new MailerError('E-MAIL-AUTH', `The mail server rejected the login: ${text}`,
      'Use a 16-character Google App Password, not your normal account password — and 2-Step Verification must be on for the account to have one. Check MAIL_USER and MAIL_PASSWORD.');
  }
  // Gmail's daily cap is a rolling 24-hour window, not a midnight reset.
  if (status === 421 || status === 450 || status === 452 || /quota|rate limit|too many/i.test(text)) {
    return new MailerError('E-MAIL-429', `The mail server is throttling us: ${text}`,
      'Usually the daily sending quota. Gmail allows about 500 recipients a day on a personal account, counted over a rolling 24 hours — it will resume on its own.');
  }
  if (status === 550 || status === 551 || status === 553 || status === 554) {
    return new MailerError('E-MAIL-REJECTED', `The recipient was rejected: ${text}`,
      'Usually a mistyped or dead address. Fix it in the candidate\'s Email box and try again.');
  }
  if (e?.code === 'ECONNECTION' || e?.code === 'ETIMEDOUT' || e?.code === 'ESOCKET' || e?.code === 'EDNS') {
    return new MailerError('E-MAIL-NETWORK', `Could not reach the mail server: ${text}`,
      `Check MAIL_HOST and MAIL_PORT (${mailHost()}). Port 465 needs implicit TLS, 587 needs STARTTLS — a mismatch hangs rather than erroring cleanly. The email was not sent.`);
  }
  return new MailerError('E-UNKNOWN', `Sending failed: ${text}`, 'Check the server logs, and the Sent folder of the sending account before retrying so you do not send a duplicate.');
}

/**
 * Send one email. Returns the server-assigned message id, which is written to
 * EmailLog so a send can be traced back to the message in the Sent folder.
 *
 * `replyTo` is what keeps the reply loop honest when the sending account is
 * not the mailbox a human watches.
 */
export async function sendMail(args: {
  to: string; subject: string; html: string; replyTo?: string; attachments?: OutgoingAttachment[];
}): Promise<{ id: string }> {
  const attachments = args.attachments ?? [];
  const totalSize = attachments.reduce((n, a) => n + a.base64.length, 0);
  if (totalSize > MAX_ATTACHMENTS_BYTES) {
    throw new MailerError('E-VALIDATION', 'Attachments are too large.', `Total attachment size must stay under ${Math.round(MAX_ATTACHMENTS_BYTES / 1024 / 1024)}MB.`);
  }

  try {
    const info = await transport().sendMail({
      from: mailFrom(),
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: toPlainText(args.html),
      ...(args.replyTo ? { replyTo: args.replyTo } : {}),
      attachments: attachments.map((a) => ({
        filename: a.filename,
        content: a.base64,
        encoding: 'base64',
        contentType: a.mimeType || 'application/octet-stream',
      })),
    });
    return { id: info.messageId || '' };
  } catch (err) {
    if (err instanceof MailerError) throw err;
    throw mapError(err);
  }
}

/**
 * Open a connection and authenticate, without sending anything. This is what
 * lets preflight prove the credentials actually work rather than only that
 * they are present — the difference between "a password is set" and "that
 * password logs in".
 */
export async function verifyMailer(): Promise<void> {
  try {
    await transport().verify();
  } catch (err) {
    if (err instanceof MailerError) throw err;
    throw mapError(err);
  }
}
