import { readTabs, parseConfig, SheetsError } from '../lib/sheets';
import { isMailerConfigured } from '../lib/mailer';
import { MailView } from '../components/MailView';
import { ErrorBanner } from '../components/Pills';
import { pluralise } from '../lib/format';

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
        <div className="eyebrow">Hiring outreach</div>
        <h1><span className="accent">Candidates</span></h1>
        <ErrorBanner error={{ code: e.code, message: e.message, hint: e.hint }} />
      </>
    );
  }

  const config = parseConfig(data.Config);
  const applicants = data.Applicants.filter((a) => a.applicant_id);
  // The role list is whatever roles the sheet actually contains — one less tab
  // to keep in step, and it can never disagree with the candidate rows.
  const roles = [...new Set(applicants.map((a) => a.job_role).filter(Boolean))].sort();
  const written = applicants.filter((a) => a.last_sent_at).length;
  const activeTemplates = data.Templates.filter((t) => String(t.is_active).toUpperCase() === 'TRUE').length;

  const stats = [
    { label: 'Candidates', value: applicants.length, note: pluralise(roles.length, 'role') },
    { label: 'Written to', value: written, note: `${applicants.length - written} not yet` },
    { label: 'Templates', value: activeTemplates, note: 'active' },
  ];

  return (
    <>
      <div className="eyebrow">Hiring outreach</div>
      <h1><span className="accent">Candidates</span></h1>
      <p className="page-sub">
        Everyone in the Applicants tab. Pick someone and say what the email should cover — the
        model writes it using their name, role and notes from the sheet. Or tick several and send
        one template to all of them.
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
          <div><strong>Live sending is enabled.</strong> <span className="hint">Anything you send reaches a real candidate.</span></div>
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

      <div className="grid cols-3" style={{ marginBottom: 18 }}>
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
        mailerConfigured={isMailerConfigured()}
        dryRun={config.dry_run === true}
        sendEnabled={config.toggle_send === true}
        aiEnabled={config.toggle_ai !== false}
      />
    </>
  );
}
