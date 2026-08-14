import { readTabs, parseConfig, SheetsError } from '../lib/sheets';
import { ApplicantsTable } from '../components/ApplicantsTable';
import { HeartbeatBanner, ErrorBanner } from '../components/Pills';
import { pluralise } from '../lib/format';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function ApplicantsPage() {
  let data;
  try {
    data = await readTabs(['Applicants', 'JobRoles', 'Config', 'RunLog']);
  } catch (err) {
    const e = err as SheetsError;
    return (
      <>
        <h1>Applicants</h1>
        <ErrorBanner error={{ code: e.code, message: e.message, hint: e.hint }} />
      </>
    );
  }

  const config = parseConfig(data.Config);
  const applicants = data.Applicants;
  const roles = data.JobRoles.filter((r) => r.is_open !== 'FALSE').map((r) => r.title).filter(Boolean);

  const heartbeat = data.RunLog
    .filter((r) => r.workflow === 'WF-91 Heartbeat')
    .sort((a, b) => b.finished_at.localeCompare(a.finished_at))[0];

  const count = (fn: (r: (typeof applicants)[number]) => boolean) => applicants.filter(fn).length;
  const stats = [
    { label: 'Total', value: applicants.length, note: `${pluralise(roles.length, 'open role')}` },
    { label: 'Awaiting draft', value: count((r) => r.stage === 'NEW'), note: 'picked up automatically' },
    { label: 'Awaiting approval', value: count((r) => r.stage === 'DRAFTED'), note: 'needs a human' },
    { label: 'Ready to send', value: count((r) => r.stage === 'APPROVED'), note: config.dry_run ? 'dry run is ON' : 'live sending' },
    { label: 'Sent', value: count((r) => r.stage === 'SENT'), note: `${count((r) => r.stage === 'REPLIED')} replied` },
    { label: 'Needs attention', value: count((r) => Boolean(r.error_code)), note: 'failed or blocked' },
  ];

  return (
    <>
      <h1>Applicants</h1>
      <p className="page-sub">
        The pipeline, end to end. Rows arrive from the Applicants tab; everything after that happens here.
      </p>

      <HeartbeatBanner lastSeen={heartbeat?.finished_at} />

      {config.dry_run ? (
        <div className="banner info">
          <span>i</span>
          <div>
            <strong>Dry run is on.</strong>{' '}
            <span className="hint">Sends are logged to EmailLog but no email leaves the building. Turn it off in Settings when you are ready.</span>
          </div>
        </div>
      ) : (
        <div className="banner warn">
          <span>!</span>
          <div><strong>Live sending is enabled.</strong> <span className="hint">Approved drafts will reach real candidates.</span></div>
        </div>
      )}

      <div className="grid cols-4" style={{ marginBottom: 18 }}>
        {stats.map((s) => (
          <div className="stat" key={s.label}>
            <div className="label">{s.label}</div>
            <div className="value">{s.value}</div>
            <div className="note">{s.note}</div>
          </div>
        ))}
      </div>

      <ApplicantsTable
        rows={applicants}
        roles={roles}
        dryRun={config.dry_run === true}
        sendEnabled={config.toggle_send === true}
      />
    </>
  );
}
