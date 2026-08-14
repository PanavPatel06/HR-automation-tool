'use client';
import { useAction, ResultBanner } from './useAction';

type Check = { check: string; ok: boolean; detail: string; fix: string };

export function PreflightButton() {
  const { run, busy, result, clear } = useAction();
  const checks = (result?.result as unknown as { checks?: Check[] })?.checks ?? [];
  const summary = (result?.result as unknown as { summary?: string })?.summary;

  return (
    <>
      <button className="primary" disabled={busy !== null} onClick={() => run('preflight')}>
        {busy === 'preflight' ? 'Checking…' : 'Run preflight'}
      </button>

      {result && !result.ok && checks.length === 0 ? <div style={{ marginTop: 12 }}><ResultBanner result={result} onClose={clear} /></div> : null}

      {checks.length ? (
        <div style={{ marginTop: 14 }}>
          <div className={`banner ${checks.every((c) => c.ok) ? 'ok' : 'warn'}`}>
            <span>{checks.every((c) => c.ok) ? '✓' : '!'}</span>
            <div style={{ flex: 1 }}><strong>{summary}</strong></div>
            <button className="ghost sm" onClick={clear}>Dismiss</button>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th style={{ width: 40 }}></th><th>Check</th><th>Detail</th><th>Fix</th></tr></thead>
              <tbody>
                {checks.map((c) => (
                  <tr key={c.check} className={c.ok ? '' : 'row-failed'}>
                    <td>{c.ok ? '✓' : '✖'}</td>
                    <td>{c.check}</td>
                    <td className="muted mono">{c.detail}</td>
                    <td className="muted" style={{ maxWidth: 380 }}>{c.fix}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}
