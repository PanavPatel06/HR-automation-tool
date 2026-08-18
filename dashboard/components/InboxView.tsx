'use client';
import { useMemo, useState } from 'react';
import type { Row } from '../lib/contract';
import { isTruthy } from '../lib/contract';
import { StagePill, IntentPill } from './Pills';
import { shortDate, timeAgo } from '../lib/format';
import { useAction, ResultBanner } from './useAction';

const PLACEHOLDER_RE = /\{\{\s*[a-zA-Z0-9_.]+\s*\}\}/;

type Compose = { templateId: string; subject: string; html: string; instructions: string };
const EMPTY_COMPOSE: Compose = { templateId: '', subject: '', html: '', instructions: '' };

/**
 * One candidate, one thread — the mail-client view the table pages don't
 * give you. Two rules carried over from the rest of the dashboard:
 *   - AI only ever fills the compose box; a human still has to press Send.
 *   - Sending is blocked client-side (and re-checked server-side) while a
 *     literal {{field}} is still visible — the same "never send a visible
 *     placeholder" rule template.js enforces for the bulk pipeline.
 */
export function InboxView({ applicants, templates, replies, roles, demoMode }: {
  applicants: Row[];
  templates: Row[];
  replies: Row[];
  roles: string[];
  demoMode: boolean;
}) {
  const { run, busy, result, clear } = useAction();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  const [compose, setCompose] = useState<Compose>(EMPTY_COMPOSE);

  const activeTemplates = useMemo(() => templates.filter((t) => isTruthy(t.is_active)), [templates]);

  const unhandledByApplicant = useMemo(() => {
    const s = new Set<string>();
    for (const r of replies) if (!r.handled_at) s.add(r.applicant_id);
    return s;
  }, [replies]);

  const latestReplyByApplicant = useMemo(() => {
    const map = new Map<string, Row>();
    for (const r of replies) {
      const cur = map.get(r.applicant_id);
      if (!cur || r.received_at > cur.received_at) map.set(r.applicant_id, r);
    }
    return map;
  }, [replies]);

  const list = useMemo(() => applicants
    .filter((a) => a.applicant_id)
    .filter((a) => !role || a.job_role === role)
    .filter((a) => {
      if (!query) return true;
      const q = query.toLowerCase();
      return [a.name, a.email, a.applicant_id, a.job_role].some((f) => String(f ?? '').toLowerCase().includes(q));
    })
    .sort((a, b) => {
      const aUnread = unhandledByApplicant.has(a.applicant_id) ? 0 : 1;
      const bUnread = unhandledByApplicant.has(b.applicant_id) ? 0 : 1;
      if (aUnread !== bUnread) return aUnread - bUnread;
      return (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || '');
    }), [applicants, role, query, unhandledByApplicant]);

  const selected = useMemo(() => applicants.find((a) => a.applicant_id === selectedId) ?? null, [applicants, selectedId]);
  const threadReplies = useMemo(
    () => replies.filter((r) => r.applicant_id === selectedId).sort((a, b) => a.received_at.localeCompare(b.received_at)),
    [replies, selectedId]
  );

  function select(id: string) {
    setSelectedId(id);
    setCompose(EMPTY_COMPOSE);
    clear();
  }

  async function useTemplate() {
    if (!selected) return;
    const res = await run('reply-template-fill', { applicant_id: selected.applicant_id, template_id: compose.templateId });
    if (res.ok && res.result) setCompose((c) => ({ ...c, subject: res.result?.subject ?? '', html: res.result?.html ?? '' }));
  }

  async function writeWithAI() {
    if (!selected) return;
    const res = await run('reply-ai-draft', { applicant_id: selected.applicant_id, template_id: compose.templateId, instructions: compose.instructions });
    if (res.ok && res.result) setCompose((c) => ({ ...c, subject: res.result?.subject ?? c.subject, html: res.result?.html ?? c.html }));
  }

  async function send() {
    if (!selected) return;
    const res = await run('send-reply', { applicant_id: selected.applicant_id, template_id: compose.templateId, subject: compose.subject, html: compose.html });
    if (res.ok) setCompose(EMPTY_COMPOSE);
  }

  const hasPlaceholder = PLACEHOLDER_RE.test(compose.subject) || PLACEHOLDER_RE.test(compose.html);
  const canSend = Boolean(compose.subject.trim() && compose.html.trim() && !hasPlaceholder);

  return (
    <>
      <ResultBanner result={result} onClose={clear} />

      <div className="inbox-layout">
        <div className="inbox-list-wrap">
          <div className="toolbar">
            <input type="search" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ minWidth: 0, flex: 1 }} />
          </div>
          <div className="toolbar" style={{ marginBottom: 8 }}>
            <select value={role} onChange={(e) => setRole(e.target.value)} style={{ width: '100%' }}>
              <option value="">All roles</option>
              {roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="inbox-list">
            {list.map((a) => (
              <button
                key={a.applicant_id}
                type="button"
                className={`inbox-item${a.applicant_id === selectedId ? ' active' : ''}`}
                onClick={() => select(a.applicant_id)}
              >
                <div className="inbox-item-top">
                  <span className="inbox-item-name">
                    {unhandledByApplicant.has(a.applicant_id) ? <span className="unread-dot" aria-hidden="true" /> : null}
                    {a.name || '(no name)'}
                  </span>
                  <span className="muted" style={{ fontSize: 11, flex: 'none' }}>{timeAgo(a.updated_at || a.created_at)}</span>
                </div>
                <div className="muted" style={{ fontSize: 12 }}>{a.job_role}{a.category ? ` · ${a.category}` : ''}</div>
                <div className="inbox-item-snippet muted">
                  {latestReplyByApplicant.get(a.applicant_id)?.snippet || (a.email_html ? 'No reply yet.' : 'No messages yet.')}
                </div>
              </button>
            ))}
            {list.length === 0 ? <div className="empty">No applicants match.</div> : null}
          </div>
        </div>

        {!selected ? (
          <div className="panel inbox-empty-pane">
            <div className="empty">Select a candidate on the left to see their thread.</div>
          </div>
        ) : (
          <div>
            <div className="panel">
              <div className="toolbar" style={{ marginBottom: 4 }}>
                <div>
                  <h2 style={{ margin: 0 }}>{selected.name || '(no name)'}</h2>
                  <div className="muted mono" style={{ fontSize: 12 }}>{selected.email}</div>
                </div>
                <span className="spacer" />
                <StagePill stage={selected.stage} />
              </div>
              <div className="muted" style={{ fontSize: 13 }}>
                {selected.job_role}{selected.category ? ` · ${selected.category}` : ''} · <span className="mono">{selected.applicant_id}</span>
              </div>
            </div>

            <div className="thread">
              {selected.email_html ? (
                <div className="bubble bubble-sent">
                  <div className="bubble-meta">
                    <strong>You</strong><span className="muted">→ {selected.email}</span>
                    <span className="spacer" />
                    <span className="muted">{shortDate(selected.sent_at || selected.updated_at)}</span>
                  </div>
                  <div className="bubble-subject">{selected.email_subject}</div>
                  <div className="preview" dangerouslySetInnerHTML={{ __html: selected.email_html }} />
                </div>
              ) : null}

              {threadReplies.map((r, i) => (
                <div className="bubble bubble-reply" key={`${r.thread_id}-${i}`}>
                  <div className="bubble-meta">
                    <strong>{selected.name || r.from}</strong>
                    <IntentPill intent={r.classified_intent} />
                    <span className="spacer" />
                    <span className="muted">{shortDate(r.received_at)}</span>
                  </div>
                  <div>{r.snippet}</div>
                  <div style={{ marginTop: 6 }}>
                    {r.handled_at ? <span className="pill ok">handled</span> : <span className="pill warn">open</span>}
                  </div>
                </div>
              ))}

              {!selected.email_html && threadReplies.length === 0 ? (
                <div className="empty">No messages in this thread yet — send the first one below.</div>
              ) : null}
            </div>

            <div className="panel">
              <h2>Reply</h2>
              <p className="sub">Load a template, write it yourself, or let AI draft it — review before sending either way.</p>

              <div className="grid cols-2" style={{ marginBottom: 12 }}>
                <label>
                  <div className="muted" style={{ marginBottom: 4 }}>Template</div>
                  <select style={{ width: '100%' }} value={compose.templateId} onChange={(e) => setCompose((c) => ({ ...c, templateId: e.target.value }))}>
                    <option value="">Blank message</option>
                    {activeTemplates.map((t) => (
                      <option key={t.template_id} value={t.template_id}>{t.name}{t.job_role ? ` — ${t.job_role}` : ''}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <div className="muted" style={{ marginBottom: 4 }}>Extra instructions for AI (optional)</div>
                  <input
                    type="text" style={{ width: '100%' }} value={compose.instructions}
                    onChange={(e) => setCompose((c) => ({ ...c, instructions: e.target.value }))}
                    placeholder="e.g. confirm the interview is remote"
                  />
                </label>
              </div>

              <div className="toolbar">
                <button disabled={busy !== null} onClick={useTemplate}>
                  {busy === 'reply-template-fill' ? 'Loading…' : '✍️ Write manually'}
                </button>
                <button
                  disabled={busy !== null || !demoMode} onClick={writeWithAI}
                  title={!demoMode ? 'AI reply drafting is demo-mode only' : undefined}
                >
                  {busy === 'reply-ai-draft' ? 'Writing…' : '✨ Write with AI'}
                </button>
                <span className="spacer" />
                {compose.subject || compose.html ? <button className="ghost sm" onClick={() => setCompose(EMPTY_COMPOSE)}>Clear</button> : null}
              </div>

              <label style={{ display: 'block', marginBottom: 10 }}>
                <div className="muted" style={{ marginBottom: 4 }}>Subject</div>
                <input type="text" style={{ width: '100%' }} value={compose.subject} onChange={(e) => setCompose((c) => ({ ...c, subject: e.target.value }))} />
              </label>
              <label style={{ display: 'block' }}>
                <div className="muted" style={{ marginBottom: 4 }}>Message (HTML)</div>
                <textarea rows={9} value={compose.html} onChange={(e) => setCompose((c) => ({ ...c, html: e.target.value }))} />
              </label>

              {hasPlaceholder ? (
                <div className="banner warn" style={{ marginTop: 10 }}>
                  <span>!</span>
                  <div>Still has an unfilled <span className="mono">{'{{field}}'}</span> — fill it in before sending.</div>
                </div>
              ) : null}

              {compose.html ? (
                <details className="hint-details" style={{ marginTop: 10 }}>
                  <summary>Preview</summary>
                  <div className="preview" style={{ marginTop: 8 }} dangerouslySetInnerHTML={{ __html: compose.html }} />
                </details>
              ) : null}

              <div className="toolbar" style={{ marginTop: 14 }}>
                <button
                  className="primary" disabled={!canSend || busy !== null || !demoMode} onClick={send}
                  title={!demoMode ? 'Sending an ad-hoc reply is demo-mode only' : undefined}
                >
                  {busy === 'send-reply' ? 'Sending…' : 'Send'}
                </button>
                {!demoMode ? <span className="muted">Ad-hoc replies only send in demo mode for now.</span> : null}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
