import { readTab, SheetsError } from '../../lib/sheets';
import { SettingsPanel } from '../../components/SettingsPanel';
import { ErrorBanner } from '../../components/Pills';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function SettingsPage() {
  let config;
  try {
    config = await readTab('Config');
  } catch (err) {
    const e = err as SheetsError;
    return <><div className="eyebrow">Configuration</div><h1>Settings</h1><ErrorBanner error={{ code: e.code, message: e.message, hint: e.hint }} /></>;
  }

  return (
    <>
      <div className="eyebrow">Configuration</div>
      <h1>Settings</h1>
      <p className="page-sub">Switch each bulk action on or off.</p>
      <SettingsPanel config={config} />
    </>
  );
}
