import { parseConfig, readTab, SheetsError } from '../../lib/sheets';
import { TemplateManager } from '../../components/TemplateManager';
import { ErrorBanner } from '../../components/Pills';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function TemplatesPage() {
  let data: { templates: Awaited<ReturnType<typeof readTab>>; applicants: Awaited<ReturnType<typeof readTab>>; config: Awaited<ReturnType<typeof readTab>> };
  try {
    const [templates, applicants, config] = await Promise.all([readTab('Templates'), readTab('Applicants'), readTab('Config')]);
    data = { templates, applicants, config };
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
        templates={data.templates}
        roles={[...new Set(data.applicants.map((a) => a.job_role).filter(Boolean))].sort()}
        config={parseConfig(data.config)}
      />
    </>
  );
}
