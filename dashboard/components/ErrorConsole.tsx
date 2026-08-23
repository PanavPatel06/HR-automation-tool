'use client';
import { useState } from 'react';
import type { Row } from '../lib/contract';
import { SEVERITY_ORDER } from '../lib/contract';
import { SeverityPill } from './Pills';
import { shortDate, timeAgo } from '../lib/format';
import { useAction, ResultBanner } from './useAction';

/**
 * The page you open when something is wrong. Every entry carries its typed
 * code, a human message, the fix, and the correlation id that ties it to a run.
 */
export function ErrorConsole({ errors, runs }: { errors: Row[]; runs: Row[] }) {
  const { run, busy, result, clear } = useAction();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showResolved, setShowResolved] = useState(false);

  const shown = errors
    .filter((e) => (showResolved ? true : e.resolved !== 'TRUE'))
    .sort((a, b) => {
      const sa = SEVERITY_ORDER[a.severity as keyof typeof SEVERITY_ORDER] ?? 1;
      const sb = SEVERITY_ORDER[b.severity as keyof typeof SEVERITY_ORDER] ?? 1;
      return sa !== sb ? sa - sb : b.at.localeCompare(a.at);
    })
    .slice(0, 200);

  const recentRuns = [...runs].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 40);

  const toggle = (id: string) => setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <>
      <ResultBanner result={result} onClose={clear} />

      <div className="panel">
        <h2>Open problems</h2>
        <p className="sub">Newest and most severe first. Resolving an entry only hides it — it does not retry anything.</p>

        <div className="toolbar">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
            Include resolved
          </label>
          <span className="spacer" />
          <button
            disabled={selected.size === 0 || busy !== null}
            onClick={async () => { const r = await run('resolve-error', { correlation_ids: [...selected] }); if (r.ok) setSelected(new Set()); }}
          >
            Mark resolved{selected.size ? ` (${selected.size})` : ''}
          </button>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 32 }}></th>
                <th>When</th><th>Code</th><th>Severity</th><th>Where</th><th>What happened</th><th>Fix</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e, i) => (
                <tr key={`${e.correlation_id}-${i}`} className={e.resolved === 'TRUE' ? '' : 'row-failed'}>
                  <td><input type="checkbox" checked={selected.has(e.correlation_id)} onChange={() => toggle(e.correlation_id)} aria-label="Select error" /></td>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{timeAgo(e.at)}</td>
                  <td><span className="pill danger">{e.error_code}</span></td>
                  <td><SeverityPill severity={e.severity} /></td>
                  <td>
                    <div className="mono">{e.workflow}</div>
                    <div className="muted mono">{e.node}{e.applicant_id ? ` · ${e.applicant_id}` : ''}</div>
                  </td>
                  <td style={{ maxWidth: 380 }}>{e.error_message}</td>
                  <td style={{ maxWidth: 320 }} className="muted">
                    {e.hint}
                    {e.retryable === 'true' ? <div><span className="pill warn" style={{ marginTop: 4 }}>retries automatically</span></div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 ? <div className="empty">Nothing broken. {errors.length > 0 ? 'All errors are resolved.' : ''}</div> : null}
        </div>
      </div>

      <div className="panel">
        <h2>Recent runs</h2>
        <p className="sub">Every workflow execution, newest first. A run with zero items usually means a toggle is off.</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Started</th><th>Workflow</th><th>Trigger</th><th>In</th><th>OK</th><th>Failed</th><th>Status</th><th>Notes</th></tr>
            </thead>
            <tbody>
              {recentRuns.map((r, i) => (
                <tr key={`${r.correlation_id}-${i}`} className={r.status === 'failed' ? 'row-failed' : r.status === 'partial' ? 'row-blocked' : ''}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{shortDate(r.started_at)}</td>
                  <td className="mono">{r.workflow}</td>
                  <td className="muted">{r.trigger}</td>
                  <td className="num">{r.items_in}</td>
                  <td className="num">{r.items_ok}</td>
                  <td className="num">{r.items_failed}</td>
                  <td>
                    <span className={`pill ${r.status === 'ok' ? 'ok' : r.status === 'failed' ? 'danger' : r.status === 'skipped' ? '' : 'warn'}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="muted" style={{ maxWidth: 420 }}>{r.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {recentRuns.length === 0 ? <div className="empty">No runs recorded yet.</div> : null}
        </div>
      </div>
    </>
  );
}
