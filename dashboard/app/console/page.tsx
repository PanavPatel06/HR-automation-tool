import { readTabs, SheetsError } from '../../lib/sheets';
import { ErrorConsole } from '../../components/ErrorConsole';
import { ErrorBanner, HeartbeatBanner } from '../../components/Pills';
import { PreflightButton } from '../../components/PreflightButton';
import { timeAgo } from '../../lib/format';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function ConsolePage() {
  let data;
  try {
    data = await readTabs(['Errors', 'RunLog', 'EmailLog', 'Quota']);
  } catch (err) {
    const e = err as SheetsError;
    return <><div className="eyebrow">Diagnostics</div><h1>Console</h1><ErrorBanner error={{ code: e.code, message: e.message, hint: e.hint }} /></>;
  }

  const heartbeat = data.RunLog
    .filter((r) => r.workflow === 'WF-91 Heartbeat')
    .sort((a, b) => b.finished_at.localeCompare(a.finished_at))[0];

  const today = new Date().toISOString().slice(0, 10);
  const openErrors = data.Errors.filter((e) => e.resolved !== 'TRUE');
  const sentToday = data.EmailLog.filter((r) => r.at.startsWith(today) && r.result === 'sent').length;
  const failedToday = data.EmailLog.filter((r) => r.at.startsWith(today) && r.result === 'failed').length;

  // Latest quota snapshot per model, written by WF-02 after each batch.
  const latestQuota = Object.values(
    data.Quota.reduce<Record<string, (typeof data.Quota)[number]>>((acc, row) => {
      const key = `${row.provider}:${row.model}`;
      if (!acc[key] || row.updated_at > acc[key].updated_at) acc[key] = row;
      return acc;
    }, {}),
  );

  return (
    <>
      <div className="eyebrow">Diagnostics</div>
      <h1>Console</h1>
      <p className="page-sub">Health, errors and run history. Start here when something looks wrong.</p>

      <HeartbeatBanner lastSeen={heartbeat?.finished_at} />

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="label">Open problems</div>
          <div className="value">{openErrors.length}</div>
          <div className="note">{openErrors.filter((e) => e.severity === 'fatal').length} fatal</div>
        </div>
        <div className="stat">
          <div className="label">Sent today</div>
          <div className="value">{sentToday}</div>
          <div className="note">{failedToday} failed</div>
        </div>
        <div className="stat">
          <div className="label">n8n heartbeat</div>
          <div className="value" style={{ fontSize: 18 }}>{heartbeat ? timeAgo(heartbeat.finished_at) : 'never'}</div>
          <div className="note">expected every 10 min</div>
        </div>
        <div className="stat">
          <div className="label">Runs recorded</div>
          <div className="value">{data.RunLog.length}</div>
          <div className="note">across all workflows</div>
        </div>
      </div>

      <div className="panel">
        <h2>Preflight</h2>
        <p className="sub">
          Checks every credential, environment variable and Config key without writing or sending
          anything. Run it after any deploy or credential change — most mysterious breakage is
          config drift.
        </p>
        <PreflightButton />
      </div>

      {latestQuota.length ? (
        <div className="panel">
          <h2>Model quota today</h2>
          <p className="sub">Written by WF-02 after each drafting batch. Free-tier daily token budget is the binding constraint, not requests per minute.</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Provider</th><th>Model</th><th>Requests</th><th>Tokens</th><th>Resets</th></tr></thead>
              <tbody>
                {latestQuota.map((q) => {
                  const used = Number(q.tokens_used) || 0;
                  const limit = Number(q.tokens_limit) || 0;
                  const pct = limit ? Math.round((used / limit) * 100) : null;
                  return (
                    <tr key={`${q.provider}:${q.model}`}>
                      <td>{q.provider}</td>
                      <td className="mono">{q.model}</td>
                      <td className="num mono">{q.requests_used}{q.requests_limit ? ` / ${q.requests_limit}` : ''}</td>
                      <td className="num mono">
                        {used.toLocaleString()}{limit ? ` / ${limit.toLocaleString()}` : ''}
                        {pct !== null ? <span className={`pill ${pct > 85 ? 'danger' : pct > 60 ? 'warn' : 'ok'}`} style={{ marginLeft: 8 }}>{pct}%</span> : null}
                      </td>
                      <td className="muted">{q.window_reset_at ? timeAgo(q.window_reset_at).replace(' ago', '') : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <ErrorConsole errors={data.Errors} runs={data.RunLog} />
    </>
  );
}
