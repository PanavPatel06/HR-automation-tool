import { NextResponse } from 'next/server';
import { requireSession } from '../../../lib/auth';
import { getAttachmentData, isGmailConfigured, GmailError } from '../../../lib/gmail';

export const runtime = 'nodejs';

/**
 * Streams one real Gmail attachment back to the browser as a normal
 * download — a plain `<a href="...">` link, not a JSON action, so the
 * browser handles the save itself. Only reachable when Gmail is configured;
 * demo mode has no attachment bytes to serve (Replies rows carry no file
 * data, only the metadata the demo dataset invents).
 */
export async function GET(req: Request) {
  if (!(await requireSession())) return new NextResponse('Unauthorized', { status: 401 });
  if (!isGmailConfigured()) return new NextResponse('Gmail is not configured.', { status: 501 });

  const url = new URL(req.url);
  const messageId = url.searchParams.get('messageId') ?? '';
  const attachmentId = url.searchParams.get('attachmentId') ?? '';
  const filename = url.searchParams.get('filename') || 'attachment';
  const mimeType = url.searchParams.get('mimeType') || 'application/octet-stream';
  if (!messageId || !attachmentId) return new NextResponse('Missing messageId/attachmentId.', { status: 400 });

  try {
    const data = await getAttachmentData(messageId, attachmentId);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        'Content-Type': mimeType,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
        'Content-Length': String(data.length),
      },
    });
  } catch (err) {
    const e = err as GmailError;
    return new NextResponse(e.message || 'Failed to download attachment.', { status: 502 });
  }
}
