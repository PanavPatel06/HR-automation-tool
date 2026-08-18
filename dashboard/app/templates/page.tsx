import { readTabs, SheetsError } from '../../lib/sheets';
import { TemplateManager } from '../../components/TemplateManager';
import { ErrorBanner } from '../../components/Pills';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function TemplatesPage() {
  let data;
  try {
    data = await readTabs(['Templates', 'JobRoles']);
  } catch (err) {
    const e = err as SheetsError;
    return <><div className="eyebrow">Content system</div><h1>Templates</h1><ErrorBanner error={{ code: e.code, message: e.message, hint: e.hint }} /></>;
  }

  return (
    <>
      <div className="eyebrow">Content system</div>
      <h1>Templates</h1>
      <p className="page-sub">
        The shell every email is built from. Most specific match wins: role + category beats
        role, which beats the default.
      </p>
      <TemplateManager
        templates={data.Templates}
        roles={data.JobRoles.map((r) => r.title).filter(Boolean)}
      />
    </>
  );
}
