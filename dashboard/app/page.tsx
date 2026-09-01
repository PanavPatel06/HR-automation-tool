import { readTabs, parseConfig, isDemoMode, SheetsError } from '../lib/sheets';
import { isGmailConfigured } from '../lib/gmail';
import { MailView } from '../components/MailView';
import { ErrorBanner } from '../components/Pills';
import { pluralise } from '../lib/format';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function HomePage() {
  let data;
  try {
    data = await readTabs(['Applicants', 'Templates', 'Replies', 'JobRoles', 'Config']);
  } catch (err) {
    const e = err as SheetsError;
    return (
      <>
        <div className="eyebrow">Hiring pipeline</div>
        <h1><span className="accent">Inbox</span></h1>
        <ErrorBanner error={{ code: e.code, message: e.message, hint: e.hint }} />
      </>
    );
  }

  const config = parseConfig(data.Config);
  const applicants = data.Applicants;
  const roles = data.JobRoles.filter((r) => r.is_open !== 'FALSE').map((r) => r.title).filter(Boolean);
  const categories = Array.isArray(config.categories) ? config.categories as string[] : [];

  const count = (fn: (r: (typeof applicants)[number]) => boolean) => applicants.filter(fn).length;
  const stats = [
    { label: 'Total', value: applicants.length, note: `${pluralise(roles.length, 'open role')}` },
    { label: 'Awaiting draft', value: count((r) => r.stage === 'NEW'), note: 'click Draft to generate' },
    { label: 'Awaiting approval', value: count((r) => r.stage === 'DRAFTED'), note: 'needs a human' },
    { label: 'Ready to send', value: count((r) => r.stage === 'APPROVED'), note: config.dry_run ? 'dry run is ON' : 'live sending' },
    { label: 'Sent', value: count((r) => r.stage === 'SENT'), note: `${count((r) => r.stage === 'REPLIED')} replied` },
    { label: 'Needs attention', value: count((r) => Boolean(r.error_code)), note: 'failed or blocked' },
  ];

  return (
    <>
      <div className="eyebrow">Hiring pipeline</div>
      <h1><span className="accent">Inbox</span></h1>
      <p className="page-sub">
        Every candidate, one place. Work the pipeline in bulk, or open a thread to reply — by
        template, by hand, or with AI — before anything goes out.
      </p>

      {config.dry_run ? (
        <div className="banner info">
          <span>i</span>
          <div>
            <strong>Dry run is on.</strong>{' '}
            <span className="hint">Sends are logged to EmailLog but no email leaves the building. Turn it off in Settings when you are ready.</span>
          </div>
        </div>
      ) : isGmailConfigured() ? (
        <div className="banner warn">
          <span>!</span>
          <div><strong>Live sending is enabled.</strong> <span className="hint">Approved drafts and Inbox replies will reach real candidates.</span></div>
        </div>
      ) : (
        // Dry run off with no mailbox behind it. Every send is refused rather
        // than logged as though it happened, so this is a broken deployment
        // and says so at the top of the page.
        <div className="banner danger">
          <span>⚠</span>
          <div>
            <strong>Sending is broken.</strong>{' '}
            <span className="hint">
              Dry run is off, but Gmail is not configured — every send is refused, and nothing is recorded as sent.
              Set the three <code>GMAIL_*</code> variables (<code>npm run gmail:oauth</code>), or turn dry run back on in Settings.
            </span>
          </div>
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

      <MailView
        applicants={applicants}
        templates={data.Templates}
        replies={data.Replies}
        roles={roles}
        categories={categories}
        demoMode={isDemoMode()}
        gmailConfigured={isGmailConfigured()}
        dryRun={config.dry_run === true}
        sendEnabled={config.toggle_send === true}
      />
    </>
  );
}
