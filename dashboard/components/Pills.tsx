import { minutesSince, timeAgo } from '../lib/format';

const STAGE_TONE: Record<string, string> = {
  NEW: '', DRAFTED: 'info', APPROVED: 'warn', SENT: 'ok',
  REPLIED: 'ok', CLOSED: '', FAILED: 'danger',
};

export function StagePill({ stage }: { stage: string }) {
  return <span className={`pill ${STAGE_TONE[stage] ?? ''}`}>{stage || 'NEW'}</span>;
}

const INTENT_TONE: Record<string, string> = {
  interested: 'ok', declined: 'danger', question: 'info',
  out_of_office: '', unclear: 'warn', needs_human: 'warn', followup_due: 'warn',
};

export function IntentPill({ intent }: { intent: string }) {
  if (!intent || intent === 'none') return <span className="muted">—</span>;
  return <span className={`pill ${INTENT_TONE[intent] ?? ''}`}>{intent.replace(/_/g, ' ')}</span>;
}

export function SeverityPill({ severity }: { severity: string }) {
  const tone = severity === 'fatal' || severity === 'error' ? 'danger' : 'warn';
  return <span className={`pill ${tone}`}>{severity || 'error'}</span>;
}

/**
 * n8n going silent produces no errors — nothing runs, so nothing fails. The
 * heartbeat is the only way to see it, so a stale one is shown loudly.
 */
export function HeartbeatBanner({ lastSeen }: { lastSeen: string | undefined }) {
  const mins = minutesSince(lastSeen);
  if (mins <= 25) return null;
  return (
    <div className="banner danger">
      <span>⚠</span>
      <div>
        <strong>n8n has not checked in {lastSeen ? timeAgo(lastSeen) : 'ever'}.</strong>
        <div className="hint">
          WF-91 Heartbeat writes to RunLog every 10 minutes. If it has stopped, no workflow is
          running — the pipeline is silently stalled. Check the container is up and that WF-91 is
          active.
        </div>
      </div>
    </div>
  );
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
