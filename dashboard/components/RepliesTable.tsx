'use client';
import { useState } from 'react';
import type { Row } from '../lib/contract';
import { IntentPill } from './Pills';
import { shortDate } from '../lib/format';
import { useAction, ResultBanner } from './useAction';

/**
 * Replies the model was not confident about are surfaced first, because they
 * are the ones a human actually has to look at.
 */
export function RepliesTable({ replies, minConfidence }: { replies: Row[]; minConfidence: number }) {
  const { run, busy, result, clear } = useAction();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [onlyUnhandled, setOnlyUnhandled] = useState(true);

  const shown = replies
    .filter((r) => (onlyUnhandled ? !r.handled_at : true))
    .sort((a, b) => {
      const aLow = Number(a.confidence) < minConfidence ? 0 : 1;
      const bLow = Number(b.confidence) < minConfidence ? 0 : 1;
      if (aLow !== bLow) return aLow - bLow;
      return b.received_at.localeCompare(a.received_at);
    });

  const toggle = (id: string) => setSelected((p) => {
    const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  return (
    <>
      <ResultBanner result={result} onClose={clear} />
      <div className="toolbar">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={onlyUnhandled} onChange={(e) => setOnlyUnhandled(e.target.checked)} />
          Unhandled only
        </label>
        <span className="spacer" />
        <button
          disabled={selected.size === 0 || busy !== null}
          onClick={async () => { const r = await run('mark-reply-handled', { thread_ids: [...selected] }); if (r.ok) setSelected(new Set()); }}
        >
          Mark handled{selected.size ? ` (${selected.size})` : ''}
        </button>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 32 }}></th>
              <th>From</th><th>Intent</th><th>Confidence</th><th>Message</th><th>Received</th><th>Handled</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const low = Number(r.confidence) < minConfidence;
              return (
                <tr key={`${r.thread_id}-${r.received_at}`} className={low && !r.handled_at ? 'row-blocked' : ''}>
                  <td><input type="checkbox" checked={selected.has(r.thread_id)} onChange={() => toggle(r.thread_id)} aria-label="Select reply" /></td>
                  <td>
                    <div className="mono">{r.from}</div>
                    <div className="muted mono">{r.applicant_id}</div>
                  </td>
                  <td>
                    <IntentPill intent={r.classified_intent} />
                    {low ? <div className="muted" style={{ marginTop: 3, fontSize: 12 }}>escalated to a human</div> : null}
                  </td>
                  <td className="num mono">{r.confidence ? Number(r.confidence).toFixed(2) : '—'}</td>
                  <td style={{ maxWidth: 420 }}>{r.snippet}</td>
                  <td className="muted">{shortDate(r.received_at)}</td>
                  <td>{r.handled_at ? <span className="pill ok">handled</span> : <span className="pill warn">open</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 ? (
          <div className="empty">
            {replies.length === 0
              ? 'No replies yet. WF-04 polls the mailbox every 5 minutes and matches replies by thread id.'
              : 'Nothing unhandled. Untick the filter to see everything.'}
          </div>
        ) : null}
      </div>
    </>
  );
}
