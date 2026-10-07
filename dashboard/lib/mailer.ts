import 'server-only';

/** Zoho Mail API client. All OAuth credentials stay in this server-only module. */

export class MailerError extends Error {
  code: string;
  hint: string;
  constructor(code: string, message: string, hint: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export type OutgoingAttachment = { filename: string; mimeType: string; base64: string };
export const MAX_ATTACHMENTS_BYTES = 15 * 1024 * 1024;

export type ZohoMessageSummary = {
  messageId: string;
  threadId: string;
  folderId: string;
  subject: string;
  fromAddress: string;
  toAddress: string;
  summary: string;
  sentDateInGMT: string;
  receivedTime: string;
  status: string;
  hasAttachment: string;
};

export type ZohoConversationMessage = ZohoMessageSummary & { content: string };

type ZohoEnvelope<T> = { status?: { code?: number; description?: string }; data?: T; message?: string; error?: string };
type ZohoAttachmentRef = { storeName: string; attachmentPath: string; attachmentName: string };

const ACCOUNTS_URL = 'https://accounts.zoho.in/oauth/v2/token';
const API_BASE = 'https://mail.zoho.in/api/accounts';
let accessToken: string | null = null;
let tokenExpiresAt = 0;
let refreshInFlight: Promise<string> | null = null;

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new MailerError('E-CONFIG-MISSING', `${key} is not set.`, `Add ${key} to the dashboard environment.`);
  return value;
}

function config() {
  return {
    clientId: requiredEnv('ZOHO_CLIENT_ID'),
    clientSecret: requiredEnv('ZOHO_CLIENT_SECRET'),
    refreshToken: requiredEnv('ZOHO_REFRESH_TOKEN'),
    accountId: requiredEnv('ZOHO_ACCOUNT_ID'),
    folderId: requiredEnv('ZOHO_FOLDER_ID'),
    from: requiredEnv('ZOHO_FROM_ADDRESS'),
  };
}

export function isMailerConfigured(): boolean {
  return ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ACCOUNT_ID', 'ZOHO_FOLDER_ID', 'ZOHO_FROM_ADDRESS']
    .every((key) => Boolean(process.env[key]?.trim()));
}

export function mailFrom(): string {
  return String(process.env.ZOHO_FROM_ADDRESS ?? '').trim();
}

export function mailHost(): string {
  return 'mail.zoho.in (Zoho Mail API)';
}

async function getAccessToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && accessToken && Date.now() < tokenExpiresAt - 60_000) return accessToken;
  if (!forceRefresh && refreshInFlight) return refreshInFlight;

  const credentials = config();
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
  });

  refreshInFlight = (async () => {
    let response: Response;
    try {
      response = await fetch(ACCOUNTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
        cache: 'no-store',
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new MailerError('E-ZOHO-NETWORK', `Could not reach Zoho Accounts: ${(err as Error)?.message ?? String(err)}`, 'Check the Zoho OAuth credentials and try again.');
    }

    const payload = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string; message?: string };
    if (!response.ok || !payload.access_token) {
      const reason = payload.error || payload.message || `HTTP ${response.status}`;
      throw new MailerError('E-ZOHO-OAUTH', `Zoho could not refresh the access token: ${reason}`, 'Confirm the refresh token belongs to this client, is not revoked, and was authorized with the required Mail API scopes.');
    }

    accessToken = payload.access_token;
    tokenExpiresAt = Date.now() + (Number(payload.expires_in) || 3600) * 1000;
    return accessToken;
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function zohoRequest<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const token = await getAccessToken();
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/${config().accountId}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Zoho-oauthtoken ${token}`,
        ...init.headers,
      },
      cache: 'no-store',
      signal: init.signal ?? AbortSignal.timeout(25_000),
    });
  } catch (err) {
    if (err instanceof MailerError) throw err;
    throw new MailerError('E-ZOHO-NETWORK', `Could not reach Zoho Mail: ${(err as Error)?.message ?? String(err)}`, 'Wait briefly and retry. No conversation content is stored by this app.');
  }

  if (response.status === 401 && retry) {
    accessToken = null;
    tokenExpiresAt = 0;
    await getAccessToken(true);
    return zohoRequest<T>(path, init, false);
  }

  const payload = await response.json().catch(() => ({})) as ZohoEnvelope<T>;
  const apiCode = Number(payload.status?.code);
  if (!response.ok || (Number.isFinite(apiCode) && apiCode >= 400)) {
    const reason = payload.status?.description || payload.message || payload.error || `HTTP ${response.status}`;
    const code = response.status === 429 ? 'E-ZOHO-429' : response.status === 401 ? 'E-ZOHO-AUTH' : 'E-ZOHO-API';
    throw new MailerError(code, `Zoho Mail API request failed: ${reason}`, code === 'E-ZOHO-AUTH'
      ? 'Check that the Zoho refresh token has the required scopes and that the client credentials match.'
      : 'Check the Zoho account/folder IDs and the API response in the server logs.');
  }
  return payload as T;
}

function arrayData<T>(payload: ZohoEnvelope<T[]>, action: string): T[] {
  if (!Array.isArray(payload.data)) {
    if (payload.status?.code === 200 && payload.data == null) return [];
    throw new MailerError('E-ZOHO-RESPONSE', `Zoho returned an unexpected response while ${action}.`, 'Run preflight and check the Zoho Mail API response.');
  }
  return payload.data;
}

function normalizeMessage(raw: Record<string, unknown>): ZohoMessageSummary {
  return {
    messageId: String(raw.messageId ?? ''),
    threadId: String(raw.threadId ?? raw.messageId ?? ''),
    folderId: String(raw.folderId ?? ''),
    subject: String(raw.subject ?? '(no subject)'),
    fromAddress: String(raw.fromAddress ?? ''),
    toAddress: String(raw.toAddress ?? ''),
    summary: String(raw.summary ?? ''),
    sentDateInGMT: String(raw.sentDateInGMT ?? ''),
    receivedTime: String(raw.receivedTime ?? raw.receivedtime ?? ''),
    status: String(raw.status ?? ''),
    hasAttachment: String(raw.hasAttachment ?? '0'),
  };
}

/** Metadata is fetched on candidate selection; message bodies are fetched only when a thread is opened. */
export async function listCandidateMessages(email: string): Promise<ZohoMessageSummary[]> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return [];
  const results: ZohoMessageSummary[] = [];
  const pageSize = 200;
  const maxMessages = 2000;

  for (let start = 1; start <= maxMessages; start += pageSize) {
    const searchKey = `sender:${normalizedEmail}::or:to:${normalizedEmail}`;
    const query = new URLSearchParams({ searchKey, receivedTime: String(Date.now()), start: String(start), limit: String(pageSize), includeto: 'true' });
    const payload = await zohoRequest<ZohoEnvelope<Record<string, unknown>[]>>(`/messages/search?${query}`);
    const rows = arrayData(payload, 'listing candidate messages').map(normalizeMessage);
    results.push(...rows);
    if (rows.length < pageSize) break;
  }

  const unique = new Map<string, ZohoMessageSummary>();
  for (const message of results) {
    if (message.messageId) unique.set(message.messageId, message);
  }
  return [...unique.values()].sort((a, b) => Number(a.sentDateInGMT || a.receivedTime) - Number(b.sentDateInGMT || b.receivedTime));
}

export async function getConversation(email: string, threadId: string): Promise<ZohoConversationMessage[]> {
  if (!threadId || threadId.length > 100) throw new MailerError('E-ZOHO-THREAD', 'Invalid Zoho thread ID.', 'Refresh the Inbox and open the conversation again.');
  const messages = (await listCandidateMessages(email)).filter((message) => message.threadId === threadId);
  if (!messages.length) return [];

  const withContent: ZohoConversationMessage[] = [];
  // Small batches limit API bursts and keep this compatible with the free web service.
  for (let i = 0; i < messages.length; i += 5) {
    const batch = messages.slice(i, i + 5);
    const bodies = await Promise.all(batch.map(async (message) => {
      if (!message.folderId || !message.messageId) return '';
      const query = new URLSearchParams({ includeBlockContent: 'false' });
      const payload = await zohoRequest<ZohoEnvelope<{ content?: string }>>(
        `/folders/${encodeURIComponent(message.folderId)}/messages/${encodeURIComponent(message.messageId)}/content?${query}`,
      );
      return typeof payload.data?.content === 'string' ? payload.data.content : '';
    }));
    batch.forEach((message, index) => withContent.push({ ...message, content: bodies[index] }));
  }
  return withContent;
}

async function uploadAttachment(attachment: OutgoingAttachment): Promise<ZohoAttachmentRef> {
  const credentials = config();
  const token = await getAccessToken();
  const query = new URLSearchParams({ fileName: attachment.filename, isInline: 'false' });
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/${credentials.accountId}/messages/attachments?${query}`, {
      method: 'POST',
      headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': attachment.mimeType || 'application/octet-stream' },
      body: Buffer.from(attachment.base64, 'base64'),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new MailerError('E-ZOHO-ATTACHMENT', `Could not upload ${attachment.filename}: ${(err as Error)?.message ?? String(err)}`, 'Try again with a smaller attachment.');
  }
  const payload = await response.json().catch(() => ({})) as ZohoEnvelope<ZohoAttachmentRef>;
  if (!response.ok || !payload.data?.storeName || !payload.data.attachmentPath || !payload.data.attachmentName) {
    throw new MailerError('E-ZOHO-ATTACHMENT', `Zoho rejected attachment ${attachment.filename}.`, payload.status?.description || 'Check the attachment size and the Zoho CREATE scope.');
  }
  return payload.data;
}

export async function sendMail(args: {
  to: string; subject: string; html: string; replyTo?: string; attachments?: OutgoingAttachment[];
}): Promise<{ id: string }> {
  const attachments = args.attachments ?? [];
  const totalSize = attachments.reduce((n, a) => n + Buffer.from(a.base64, 'base64').length, 0);
  if (totalSize > MAX_ATTACHMENTS_BYTES) throw new MailerError('E-VALIDATION', 'Attachments are too large.', `Total attachment size must stay under ${Math.round(MAX_ATTACHMENTS_BYTES / 1024 / 1024)}MB.`);

  const uploaded = await Promise.all(attachments.map(uploadAttachment));
  const payload = await zohoRequest<ZohoEnvelope<{ messageId?: string; mailId?: string }>>('/messages', {
    method: 'POST',
    body: JSON.stringify({
      fromAddress: config().from,
      toAddress: args.to,
      subject: args.subject,
      content: args.html,
      mailFormat: 'html',
      encoding: 'UTF-8',
      ...(args.replyTo ? { replyToAddress: args.replyTo } : {}),
      ...(uploaded.length ? { attachments: uploaded } : {}),
    }),
  });
  const id = String(payload.data?.messageId ?? payload.data?.mailId ?? '');
  if (!id) throw new MailerError('E-ZOHO-RESPONSE', 'Zoho accepted the request but did not return a message ID.', 'Check the Zoho Sent folder before retrying to avoid a duplicate.');
  return { id };
}

export async function sendReply(args: {
  messageId: string; to: string; subject: string; html: string; replyTo?: string;
}): Promise<{ id: string }> {
  if (!/^\d+$/.test(args.messageId)) throw new MailerError('E-ZOHO-THREAD', 'Invalid reply message ID.', 'Refresh the thread and try again.');
  const payload = await zohoRequest<ZohoEnvelope<{ messageId?: string; mailId?: string }>>(
    `/messages/${encodeURIComponent(args.messageId)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        fromAddress: config().from,
        toAddress: args.to,
        subject: args.subject,
        content: args.html,
        mailFormat: 'html',
        encoding: 'UTF-8',
        action: 'reply',
        ...(args.replyTo ? { replyToAddress: args.replyTo } : {}),
      }),
    },
  );
  const id = String(payload.data?.messageId ?? payload.data?.mailId ?? '');
  if (!id) throw new MailerError('E-ZOHO-RESPONSE', 'Zoho accepted the reply but did not return a message ID.', 'Check the Zoho Sent folder before retrying to avoid a duplicate.');
  return { id };
}

export async function verifyMailer(): Promise<void> {
  const folderId = config().folderId;
  const query = new URLSearchParams({ folderId, limit: '1', start: '1', includeto: 'true' });
  const payload = await zohoRequest<ZohoEnvelope<Record<string, unknown>[]>>(`/messages/view?${query}`);
  arrayData(payload, 'checking the Zoho mailbox');
}

export async function fetchUrlAttachment(url: string, filename?: string): Promise<OutgoingAttachment> {
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new MailerError('E-ATTACHMENT-FETCH', 'Could not fetch the template attachment.', `Check the URL is reachable: ${(err as Error)?.message ?? String(err)}`);
  }
  if (!response.ok) throw new MailerError('E-ATTACHMENT-FETCH', `Template attachment URL returned ${response.status}.`, 'Make sure the link is shared “anyone with the link” and reachable without login.');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_ATTACHMENTS_BYTES) throw new MailerError('E-VALIDATION', 'Template attachment is too large.', `Must stay under ${Math.round(MAX_ATTACHMENTS_BYTES / 1024 / 1024)}MB.`);
  return {
    filename: filename?.trim() || url.split('/').pop() || 'attachment',
    mimeType: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream',
    base64: buffer.toString('base64'),
  };
}
