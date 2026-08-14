import { readTabs, SheetsError } from '../../lib/sheets';
import { SettingsPanel } from '../../components/SettingsPanel';
import { ErrorBanner } from '../../components/Pills';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function SettingsPage() {
  let data;
  try {
    data = await readTabs(['Config', 'RunLog']);
  } catch (err) {
    const e = err as SheetsError;
    return <><h1>Settings</h1><ErrorBanner error={{ code: e.code, message: e.message, hint: e.hint }} /></>;
  }

  return (
    <>
      <h1>Settings</h1>
      <p className="page-sub">Switch each automation on or off, and see when it last ran.</p>
      <SettingsPanel
        config={data.Config}
        runs={data.RunLog.map((r) => ({ workflow: r.workflow, finished_at: r.finished_at, status: r.status, notes: r.notes }))}
      />
    </>
  );
}
