import 'server-only';
import { google, type gmail_v1 } from 'googleapis';

/**
 * Direct Gmail access: importing a candidate's real thread and sending real
 * mail, both the bulk Send action and the Inbox's ad-hoc single-thread
 * replies. Every caller in app/api/action/route.ts checks the `dry_run`
 * Config flag itself before this file ever builds a real request —
 * sendMail() has no dry-run mode of its own, it always sends for real.
 *
 * Entirely optional: see isGmailConfigured(). Unset, and sending stays
 * logged-only — nothing here is reachable.
 */

export class GmailError extends Error {
  code: string;
  hint: string;
  constructor(code: string, message: string, hint: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export function isGmailConfigured(): boolean {
  return Boolean(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN);
}

function client(): gmail_v1.Gmail {
  const id = process.env.GMAIL_CLIENT_ID;
  const secret = process.env.GMAIL_CLIENT_SECRET;
  const refresh = process.env.GMAIL_REFRESH_TOKEN;
  if (!id || !secret || !refresh) {
    throw new GmailError('E-CONFIG-MISSING', 'Gmail is not configured.', 'Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN — run scripts/gmail-oauth.mjs.');
  }
  const auth = new google.auth.OAuth2(id, secret);
  auth.setCredentials({ refresh_token: refresh });
  return google.gmail({ version: 'v1', auth: auth as never });
}

function mapError(err: unknown, what: string): GmailError {
  const status = (err as { response?: { status?: number }; code?: number })?.response?.status ?? (err as { code?: number })?.code;
  if (status === 401 || status === 403) return new GmailError('E-GMAIL-AUTH', `Gmail rejected the request ${what}.`, 'The refresh token may be revoked or the scope insufficient. Re-run scripts/gmail-oauth.mjs.');
  if (status === 429) return new GmailError('E-GMAIL-429', `Gmail rate limit hit ${what}.`, 'Wait a moment and try again.');
  return new GmailError('E-UNKNOWN', `Gmail request failed ${what}: ${(err as Error)?.message ?? String(err)}`, 'Check the server logs for the full error.');
}

export type GmailAttachmentMeta = { filename: string; mimeType: string; size: number; attachmentId: string; messageId: string };
export type GmailMessage = {
  id: string; threadId: string; from: string; to: string; subject: string;
  date: string; snippet: string; html: string; text: string; attachments: GmailAttachmentMeta[];
};

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

/** Walk the MIME part tree, collecting the html/text body and any attachment metadata. */
function walkParts(part: gmail_v1.Schema$MessagePart | undefined, messageId: string, out: { html: string; text: string; attachments: GmailAttachmentMeta[] }) {
  if (!part) return;
  const mime = part.mimeType || '';
  if (part.filename && part.body?.attachmentId) {
    out.attachments.push({ filename: part.filename, mimeType: mime || 'application/octet-stream', size: part.body.size ?? 0, attachmentId: part.body.attachmentId, messageId });
  } else if (mime === 'text/html' && part.body?.data) {
    out.html += decodeBase64Url(part.body.data);
  } else if (mime === 'text/plain' && part.body?.data) {
    out.text += decodeBase64Url(part.body.data);
  }
  for (const child of part.parts || []) walkParts(child, messageId, out);
}

function parseMessage(raw: gmail_v1.Schema$Message): GmailMessage {
  const headers = raw.payload?.headers ?? undefined;
  const out = { html: '', text: '', attachments: [] as GmailAttachmentMeta[] };
  walkParts(raw.payload ?? undefined, raw.id || '', out);
  return {
    id: raw.id || '',
    threadId: raw.threadId || '',
    from: header(headers, 'From'),
    to: header(headers, 'To'),
    subject: header(headers, 'Subject'),
    date: new Date(Number(raw.internalDate || Date.now())).toISOString(),
    snippet: raw.snippet || '',
    html: out.html,
    text: out.text,
    attachments: out.attachments,
  };
}

/**
 * Every message to or from this address, oldest first — one search plus one
 * `get` per result, so this costs a handful of requests per applicant, not
 * per message in the whole mailbox.
 */
export async function findMessagesForAddress(email: string, { max = 20 } = {}): Promise<GmailMessage[]> {
  if (!email) return [];
  const gmail = client();

  let list;
  try {
    list = await gmail.users.messages.list({ userId: 'me', q: `to:${email} OR from:${email}`, maxResults: max });
  } catch (err) {
    throw mapError(err, `searching Gmail for ${email}`);
  }

  const ids = list.data.messages ?? [];
  if (!ids.length) return [];

  const messages = await Promise.all(ids.map(async (m) => {
    try {
      const res = await gmail.users.messages.get({ userId: 'me', id: m.id as string, format: 'full' });
      return parseMessage(res.data);
    } catch (err) {
      throw mapError(err, `reading Gmail message ${m.id}`);
    }
  }));

  return messages.sort((a, b) => a.date.localeCompare(b.date));
}

/** Raw bytes of one attachment, for the download route. */
export async function getAttachmentData(messageId: string, attachmentId: string): Promise<Buffer> {
  const gmail = client();
  try {
    const res = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
    return Buffer.from(res.data.data || '', 'base64url');
  } catch (err) {
    throw mapError(err, `downloading attachment ${attachmentId}`);
  }
}

export type OutgoingAttachment = { filename: string; mimeType: string; base64: string };

/** Split base64 into RFC-2045 76-char lines — most MIME parsers expect this. */
function wrapBase64(b64: string): string {
  return b64.match(/.{1,76}/g)?.join('\r\n') ?? '';
}

function buildMime({ to, subject, html, text, inReplyTo, references, attachments = [] }: {
  to: string; subject: string; html: string; text?: string;
  inReplyTo?: string; references?: string; attachments?: OutgoingAttachment[];
}): string {
  const boundaryMixed = `mixed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const boundaryAlt = `alt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const plain = text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  const headers = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : '',
    references ? `References: ${references}` : '',
    `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`,
  ].filter(Boolean).join('\r\n');

  const altPart = [
    `--${boundaryMixed}`,
    `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
    '',
    `--${boundaryAlt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    plain,
    '',
    `--${boundaryAlt}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    html,
    '',
    `--${boundaryAlt}--`,
  ].join('\r\n');

  const attachmentParts = attachments.map((a) => [
    `--${boundaryMixed}`,
    `Content-Type: ${a.mimeType || 'application/octet-stream'}; name="${a.filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${a.filename}"`,
    '',
    wrapBase64(a.base64),
  ].join('\r\n')).join('\r\n');

  return [headers, '', altPart, attachmentParts, `--${boundaryMixed}--`].filter(Boolean).join('\r\n');
}

/** Total base64 attachment payload accepted per send — keeps well under Gmail's ~25MB combined limit. */
export const MAX_ATTACHMENTS_BYTES = 15 * 1024 * 1024;

export async function sendMail(args: {
  to: string; subject: string; html: string; threadId?: string;
  inReplyTo?: string; references?: string; attachments?: OutgoingAttachment[];
}): Promise<{ id: string; threadId: string }> {
  const totalSize = (args.attachments ?? []).reduce((n, a) => n + a.base64.length, 0);
  if (totalSize > MAX_ATTACHMENTS_BYTES) {
    throw new GmailError('E-VALIDATION', 'Attachments are too large.', `Total attachment size must stay under ${Math.round(MAX_ATTACHMENTS_BYTES / 1024 / 1024)}MB.`);
  }

  const gmail = client();
  const raw = Buffer.from(buildMime(args)).toString('base64url');
  try {
    const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw, threadId: args.threadId } });
    return { id: res.data.id || '', threadId: res.data.threadId || '' };
  } catch (err) {
    throw mapError(err, 'sending mail via Gmail');
  }
}
