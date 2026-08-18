import { readTabs, isDemoMode, SheetsError } from '../../lib/sheets';
import { InboxView } from '../../components/InboxView';
import { ErrorBanner } from '../../components/Pills';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function InboxPage() {
  let data;
  try {
    data = await readTabs(['Applicants', 'Templates', 'Replies', 'JobRoles']);
  } catch (err) {
    const e = err as SheetsError;
    return <><div className="eyebrow">Inbox</div><h1>Inbox</h1><ErrorBanner error={{ code: e.code, message: e.message, hint: e.hint }} /></>;
  }

  return (
    <>
      <div className="eyebrow">Inbox</div>
      <h1>Inbox</h1>
      <p className="page-sub">
        One candidate, one thread. Load a template or let AI draft a reply, review it, then send —
        nothing reaches a candidate without that click.
      </p>
      <InboxView
        applicants={data.Applicants}
        templates={data.Templates}
        replies={data.Replies}
        roles={data.JobRoles.map((r) => r.title).filter(Boolean)}
        demoMode={isDemoMode()}
      />
    </>
  );
}
