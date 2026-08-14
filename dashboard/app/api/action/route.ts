import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { requireSession } from '../../../lib/auth';
import { callN8n, N8nError, type N8nAction } from '../../../lib/n8n';
import { readTab, patchRows, setConfig, SheetsError, type Patch } from '../../../lib/sheets';
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
    if (err instanceof N8nError || err instanceof SheetsError) {
      return NextResponse.json({ ok: false, code: err.code, message: err.message, hint: err.hint }, { status: 502 });
    }
    return fail(500, 'E-UNKNOWN', (err as Error)?.message ?? 'Unexpected failure.', 'Check the Vercel function logs.');
  }
}
