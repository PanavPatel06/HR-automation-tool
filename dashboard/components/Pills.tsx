const STAGE_TONE: Record<string, string> = {
  NEW: '', DRAFTED: 'info', APPROVED: 'warn', SENT: 'ok',
  REPLIED: 'ok', CLOSED: '', FAILED: 'danger',
};

export function StagePill({ stage }: { stage: string }) {
  return <span className={`pill ${STAGE_TONE[stage] ?? ''}`}>{stage || 'NEW'}</span>;
}

// Categories are open-ended (Config's `categories` key — Intern/Junior/Mid/
// Senior/Lead by default, but a real deployment can rename these), so there's
// no fixed name->tone map like STAGE_TONE. A hash picks a consistent tone per
// name instead, so the same category always renders the same colour without
// hardcoding what the categories are.
const PILL_TONES = ['', 'info', 'ok', 'warn', 'danger'];
function hashTone(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PILL_TONES[h % PILL_TONES.length];
}

export function CategoryPill({ category }: { category: string }) {
  if (!category) return null;
  return <span className={`pill ${hashTone(category)}`}>{category}</span>;
}

export function ErrorBanner({ error }: { error: { code?: string; message: string; hint?: string } }) {
  return (
    <div className="banner danger">
      <span>⚠</span>
      <div>
        <strong>{error.code ? `${error.code} — ` : ''}{error.message}</strong>
        {error.hint ? <div className="hint">{error.hint}</div> : null}
      </div>
    </div>
  );
}
