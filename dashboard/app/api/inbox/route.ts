import { NextResponse } from 'next/server';
import { requireSession } from '../../../lib/auth';
import { readTab, SheetsError } from '../../../lib/sheets';
import { getConversation, listCandidateMessages, MailerError } from '../../../lib/mailer';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function failure(status: number, code: string, message: string, hint = '') {
  return NextResponse.json({ ok: false, code, message, hint }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Live mailbox reads are gated by the current Applicants sheet roster. No
 * message bodies are written to Sheets, disk, or an application cache.
 */
export async function GET(request: Request) {
  if (!(await requireSession())) return failure(401, 'E-AUTH', 'Your session has expired.', 'Sign in again.');

  const params = new URL(request.url).searchParams;
  const applicantId = params.get('applicant_id')?.trim() ?? '';
  const threadId = params.get('thread_id')?.trim() ?? '';
  if (!applicantId) return failure(400, 'E-BADREQ', 'Choose a candidate first.');

  try {
    const applicants = await readTab('Applicants');
    const applicant = applicants.find((row) => row.applicant_id === applicantId);
    if (!applicant) return failure(404, 'E-NOTFOUND', 'This candidate is no longer in the Applicants sheet.', 'Refresh the dashboard roster.');
    if (!applicant.email) return failure(422, 'E-VALIDATION', 'This candidate has no email address.', 'Add a valid address in the Applicants sheet.');

    const data = threadId
      ? await getConversation(applicant.email, threadId)
      : await listCandidateMessages(applicant.email);

    return NextResponse.json({ ok: true, data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof SheetsError || err instanceof MailerError) {
      return failure(502, err.code, err.message, err.hint);
    }
    return failure(500, 'E-UNKNOWN', 'Could not load this Zoho conversation.', 'Check the server logs and retry.');
  }
}
