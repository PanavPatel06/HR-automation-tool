import { readTab, SheetsError } from '../../lib/sheets';
import { ErrorBanner } from '../../components/Pills';
import { PreflightButton } from '../../components/PreflightButton';
import { shortDate } from '../../lib/format';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Diagnostics. Two things only: run the credential checks, and read the
 * send history — which is the audit trail for the one action in this app that
 * reaches a real person.
 */
export default async function ConsolePage() {
  let log;
  try {
    log = await readTab('EmailLog');
  } catch (err) {
    const e = err as SheetsError;
    return <><div className="eyebrow">Diagnostics</div><h1>Console</h1><ErrorBanner error={{ code: e.code, message: e.message, hint: e.hint }} /></>;
  }

  const today = new Date().toISOString().slice(0, 10);
  const todays = log.filter((r) => r.at.startsWith(today));
  const sentToday = todays.filter((r) => r.result === 'sent' && r.dry_run !== 'true').length;
  const failedToday = todays.filter((r) => r.result === 'failed').length;
  const recent = [...log].sort((a, b) => (b.at || '').localeCompare(a.at || '')).slice(0, 100);

  return (
    <>
      <div className="eyebrow">Diagnostics</div>
      <h1>Console</h1>
      <p className="page-sub">Credential checks and the send history. Start here when something looks wrong.</p>

      <div className="grid cols-3" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="label">Delivered today</div>
          <div className="value">{sentToday}</div>
          <div className="note">real sends, excluding dry runs</div>
        </div>
        <div className="stat">
          <div className="label">Failed today</div>
          <div className="value">{failedToday}</div>
          <div className="note">{failedToday ? 'see the log below' : 'nothing rejected'}</div>
        </div>
        <div className="stat">
          <div className="label">Logged all time</div>
          <div className="value">{log.length}</div>
          <div className="note">every send attempt ever made</div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <h2>Preflight</h2>
        <p className="sub">Checks every credential without writing a row or sending an email.</p>
        <PreflightButton />
      </div>

      <div className="panel">
        <h2>Email log</h2>
        <p className="sub">The last {recent.length} send attempt(s), newest first. Written before the sheet is updated, so a send is never missing from here.</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>When</th><th>To</th><th>Subject</th><th>Result</th><th>Message id</th></tr>
            </thead>
            <tbody>
              {recent.map((r, i) => (
                <tr key={`${r.at}-${i}`} className={r.result === 'failed' ? 'row-failed' : ''}>
                  <td className="muted">{shortDate(r.at)}</td>
                  <td className="mono">{r.to}</td>
                  <td className="truncate">{r.subject}</td>
                  <td>
                    {r.result === 'failed'
                      ? <span className="pill danger" title={r.error_message}>{r.error_code || 'failed'}</span>
                      : r.dry_run === 'true'
                        ? <span className="pill">dry run</span>
                        : <span className="pill ok">sent</span>}
                  </td>
                  <td className="muted mono truncate">{r.provider_message_id || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {recent.length === 0 ? <div className="empty">Nothing sent yet.</div> : null}
        </div>
      </div>
    </>
  );
}
