import { readTabs, parseConfig, SheetsError } from '../../lib/sheets';
import { RepliesTable } from '../../components/RepliesTable';
import { ErrorBanner } from '../../components/Pills';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function RepliesPage() {
  let data;
  try {
    data = await readTabs(['Replies', 'Config']);
  } catch (err) {
    const e = err as SheetsError;
    return <><div className="eyebrow">Inbox</div><h1>Replies</h1><ErrorBanner error={{ code: e.code, message: e.message, hint: e.hint }} /></>;
  }

  const config = parseConfig(data.Config);
  const min = Number(config.reply_confidence_min ?? 0.7);

  return (
    <>
      <div className="eyebrow">Inbox</div>
      <h1>Replies</h1>
      <p className="page-sub">
        Candidate replies, sorted with the uncertain ones first. Anything classified below{' '}
        {min.toFixed(2)} confidence is marked for a human rather than acted on.
      </p>
      <RepliesTable replies={data.Replies} minConfidence={min} />
    </>
  );
}
