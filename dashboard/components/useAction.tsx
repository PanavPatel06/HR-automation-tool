'use client';
import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
// Type-only: erased at compile time (isolatedModules), so lib/gmail.ts's
// `server-only` import never ends up in this client bundle.
import type { GmailMessage } from '../lib/gmail';

export type ActionResult = {
  ok: boolean;
  code?: string;
  message?: string;
  hint?: string;
  result?: {
    status?: string;
    notes?: string;
    items_ok?: number;
    items_failed?: number;
    warnings?: string[];
    errors?: Array<{ applicant_id?: string; code?: string; message?: string }>;
    // Inbox reply actions (reply-template-fill / reply-ai-draft) hand back a
    // draft for the compose box rather than a batch summary.
    subject?: string;
    html?: string;
    // gmail-sync hands back the applicant's real thread.
    messages?: GmailMessage[];
    // start-conversation hands back the id of the (new or existing) applicant.
    applicant_id?: string;
  };
};

/**
 * Shared hook for every dashboard action.
 *
 * It deliberately surfaces partial success: a batch where 8 of 10 drafts worked
 * is neither "ok" nor "failed", and hiding the 2 failures behind a green
 * checkmark is how silent breakage starts.
 */
export function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);

  const run = useCallback(async (action: string, payload: Record<string, unknown> = {}) => {
    setBusy(action);
    setResult(null);
    try {
      const res = await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      });
      const json: ActionResult = await res.json().catch(() => ({ ok: false, message: 'The server returned a response that was not JSON.' }));
      setResult(json);
      if (json.ok) router.refresh();
      return json;
    } catch (err) {
      const failure: ActionResult = {
        ok: false,
        code: 'E-NETWORK',
        message: (err as Error)?.message ?? 'Network error.',
        hint: 'The action may still have run. Check the Console page before retrying.',
      };
      setResult(failure);
      return failure;
    } finally {
      setBusy(null);
    }
  }, [router]);

  return { run, busy, result, clear: () => setResult(null) };
}

export function ResultBanner({ result, onClose }: { result: ActionResult | null; onClose: () => void }) {
  if (!result) return null;

  const failedCount = result.result?.items_failed ?? 0;
  const okCount = result.result?.items_ok ?? 0;
  const tone = !result.ok ? 'danger' : failedCount > 0 ? 'warn' : 'ok';

  return (
    <div className={`banner ${tone}`}>
      <span>{tone === 'ok' ? '✓' : tone === 'warn' ? '!' : '⚠'}</span>
      <div style={{ flex: 1 }}>
        <strong>
          {result.ok
            ? (failedCount > 0 ? `Partly done — ${okCount} succeeded, ${failedCount} failed` : (result.result?.notes || 'Done'))
            : `${result.code ? `${result.code} — ` : ''}${result.message}`}
        </strong>
        {result.ok && failedCount > 0 && result.result?.notes ? <div className="hint">{result.result.notes}</div> : null}
        {result.hint ? <div className="hint">{result.hint}</div> : null}
        {result.result?.warnings?.length ? (
          <div className="hint">Warnings: {result.result.warnings.join(', ')}</div>
        ) : null}
        {result.result?.errors?.length ? (
          <details className="hint-details" style={{ marginTop: 6 }}>
            <summary>{result.result.errors.length} failed item(s)</summary>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {result.result.errors.slice(0, 20).map((e, i) => (
                <li key={i} className="mono">{e.applicant_id ? `${e.applicant_id}: ` : ''}{e.code} — {e.message}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      <button className="ghost sm" onClick={onClose}>Dismiss</button>
    </div>
  );
}
