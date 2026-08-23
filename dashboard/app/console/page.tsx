import { readTabs, SheetsError } from '../../lib/sheets';
import { ErrorConsole } from '../../components/ErrorConsole';
import { ErrorBanner } from '../../components/Pills';
import { PreflightButton } from '../../components/PreflightButton';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function ConsolePage() {
  let data;
  try {
    data = await readTabs(['Errors', 'RunLog', 'EmailLog']);
  } catch (err) {
    const e = err as SheetsError;
    return <><div className="eyebrow">Diagnostics</div><h1>Console</h1><ErrorBanner error={{ code: e.code, message: e.message, hint: e.hint }} /></>;
  }

  const today = new Date().toISOString().slice(0, 10);
  const openErrors = data.Errors.filter((e) => e.resolved !== 'TRUE');
  const sentToday = data.EmailLog.filter((r) => r.at.startsWith(today) && r.result === 'sent').length;
  const failedToday = data.EmailLog.filter((r) => r.at.startsWith(today) && r.result === 'failed').length;

  return (
    <>
      <div className="eyebrow">Diagnostics</div>
      <h1>Console</h1>
      <p className="page-sub">Health, errors and run history. Start here when something looks wrong.</p>

      <div className="grid cols-3" style={{ marginBottom: 16 }}>
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
          <div className="label">Runs recorded</div>
          <div className="value">{data.RunLog.length}</div>
          <div className="note">historical — see Recent runs below</div>
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

      <ErrorConsole errors={data.Errors} runs={data.RunLog} />
    </>
  );
}
