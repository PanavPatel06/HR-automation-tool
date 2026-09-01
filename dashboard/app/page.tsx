import { readTabs, parseConfig, SheetsError } from '../lib/sheets';
import { isMailerConfigured } from '../lib/mailer';
import { MailView } from '../components/MailView';
import { ErrorBanner } from '../components/Pills';
import { pluralise } from '../lib/format';
import { findDuplicates } from '../lib/duplicates';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function HomePage() {
  let data;
  try {
    data = await readTabs(['Applicants', 'Templates', 'Config']);
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
  // The role list is whatever roles the sheet actually contains — one less tab
  // to keep in step, and it can never disagree with the candidate rows.
  const roles = [...new Set(applicants.map((a) => a.job_role).filter(Boolean))].sort();
  const categories = Array.isArray(config.categories) ? config.categories as string[] : [];

  // Read once here and once in MailView; both are cheap and this keeps the
  // stat card honest without threading another prop through.
  const duplicateCount = findDuplicates(applicants).length;

  const count = (fn: (r: (typeof applicants)[number]) => boolean) => applicants.filter(fn).length;
  const stats = [
    { label: 'Total', value: applicants.length, note: `${pluralise(roles.length, 'role')}` },
    { label: 'Awaiting draft', value: count((r) => r.stage === 'NEW'), note: 'click Draft to generate' },
    { label: 'Awaiting approval', value: count((r) => r.stage === 'DRAFTED'), note: 'needs a human' },
    { label: 'Ready to send', value: count((r) => r.stage === 'APPROVED'), note: config.dry_run ? 'dry run is ON' : 'live sending' },
    { label: 'Sent', value: count((r) => r.stage === 'SENT'), note: `${count((r) => r.stage === 'REPLIED')} marked replied` },
    { label: 'Needs attention', value: count((r) => Boolean(r.error_code)) + duplicateCount, note: duplicateCount ? `${pluralise(duplicateCount, 'duplicate')}` : 'failed or blocked' },
  ];

  return (
    <>
      <div className="eyebrow">Hiring pipeline</div>
      <h1><span className="accent">Inbox</span></h1>
      <p className="page-sub">
        Everyone in the Applicants tab, in one place. Work the pipeline in bulk, or open a
        candidate and write to them — say what the email should cover and the model drafts it,
        using their name and role from the sheet. The sheet is read fresh on every load;
        <strong> Refresh from sheet</strong> re-reads it without losing your place.
      </p>

      {config.dry_run ? (
        <div className="banner info">
          <span>i</span>
          <div>
            <strong>Dry run is on.</strong>{' '}
            <span className="hint">Sends are logged to EmailLog but no email leaves the building. Turn it off in Settings when you are ready.</span>
          </div>
        </div>
      ) : isMailerConfigured() ? (
        <div className="banner warn">
          <span>!</span>
          <div><strong>Live sending is enabled.</strong> <span className="hint">Approved drafts and one-off messages will reach real candidates.</span></div>
        </div>
      ) : (
        // Dry run off with no mailer behind it. Every send is refused rather
        // than logged as though it happened, so this is a broken deployment
        // and says so at the top of the page.
        <div className="banner danger">
          <span>⚠</span>
          <div>
            <strong>Sending is broken.</strong>{' '}
            <span className="hint">
              Dry run is off, but email sending is not configured — every send is refused, and nothing is recorded as sent.
              Set <code>RESEND_API_KEY</code> and <code>MAIL_FROM</code>, or turn dry run back on in Settings.
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
        roles={roles}
        categories={categories}
        mailerConfigured={isMailerConfigured()}
        dryRun={config.dry_run === true}
        sendEnabled={config.toggle_send === true}
        loadedAt={new Date().toISOString()}
      />
    </>
  );
}
