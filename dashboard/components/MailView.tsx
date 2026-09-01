'use client';
import { useMemo, useState } from 'react';
import type { Row } from '../lib/contract';
import { isTruthy, ACTIONABLE, STAGES } from '../lib/contract';
import { StagePill, IntentPill, CategoryPill } from './Pills';
import { shortDate, timeAgo } from '../lib/format';
import { useAction, ResultBanner } from './useAction';
// Type-only imports — erased at compile time, so lib/gmail.ts's `server-only`
// guard never ends up in this client bundle. See useAction.tsx.
import type { GmailMessage, GmailAttachmentMeta } from '../lib/gmail';

const PLACEHOLDER_RE = /\{\{\s*[a-zA-Z0-9_.]+\s*\}\}/;
const MAX_ATTACHMENTS_BYTES = 15 * 1024 * 1024;

type Attachment = { filename: string; mimeType: string; base64: string; size: number };
type Compose = { templateId: string; subject: string; html: string; instructions: string; attachments: Attachment[] };
const EMPTY_COMPOSE: Compose = { templateId: '', subject: '', html: '', instructions: '', attachments: [] };

type GroupBy = 'none' | 'stage' | 'role' | 'category' | 'intent';

type ThreadItem =
  | { kind: 'sent'; at: string; subject: string; html: string }
  | { kind: 'reply'; at: string; from: string; intent: string; snippet: string; handled: boolean }
  | { kind: 'gmail'; at: string; from: string; to: string; subject: string; html: string; text: string; attachments: GmailAttachmentMeta[]; inbound: boolean };

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** File -> base64, chunked so String.fromCharCode doesn't blow the call stack on large files. */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/**
 * The merged Applicants + Inbox surface: work the pipeline in bulk from the
 * list on the left (draft / approve / send, same rules as before), or open
 * one candidate to see their whole thread and reply — by template, by hand,
 * or with AI — with real Gmail import/send layered in when it's configured
 * (see lib/gmail.ts) and simulated the same way as before when it isn't.
 *
 * Two rules carried over unchanged from Inbox:
 *   - AI only ever fills the compose box; a human still has to press Send.
 *   - Sending is blocked while a literal {{field}} is still visible.
 */
export function MailView({ applicants, templates, replies, roles, categories: configCategories, demoMode, gmailConfigured, dryRun, sendEnabled }: {
  applicants: Row[];
  templates: Row[];
  replies: Row[];
  roles: string[];
  categories: string[];
  demoMode: boolean;
  gmailConfigured: boolean;
  dryRun: boolean;
  sendEnabled: boolean;
}) {
  const { run, busy, result, clear } = useAction();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  const [stage, setStage] = useState('');
  const [category, setCategory] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [confirmSend, setConfirmSend] = useState(false);
  const [compose, setCompose] = useState<Compose>(EMPTY_COMPOSE);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [gmailMessages, setGmailMessages] = useState<GmailMessage[] | null>(null);
  const [categoryDraft, setCategoryDraft] = useState('');
  const [bulkCategory, setBulkCategory] = useState('');
  const [showNewContact, setShowNewContact] = useState(false);
  const [newContact, setNewContact] = useState({ name: '', email: '', role: '', category: '' });

  const activeTemplates = useMemo(() => templates.filter((t) => isTruthy(t.is_active)), [templates]);

  // Categories actually in use, for the filter dropdown — no point offering
  // "Lead" to filter by if nobody has that category. The assignment picker
  // below instead suggests configCategories (Config's canonical allowed
  // list) merged with these, so it can also offer a category nobody has used
  // yet without inventing a whole "manage categories" screen.
  const usedCategories = useMemo(
    () => [...new Set(applicants.map((a) => a.category).filter(Boolean))].sort(),
    [applicants]
  );
  const categorySuggestions = useMemo(
    () => [...new Set([...configCategories, ...usedCategories])].sort(),
    [configCategories, usedCategories]
  );

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
    .filter((a) => !stage || a.stage === stage)
    .filter((a) => !category || a.category === category)
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
    }), [applicants, role, stage, category, query, unhandledByApplicant]);

  const groupedList = useMemo(() => {
    if (groupBy === 'none') return [{ key: '', rows: list }];
    const keyOf = (a: Row) => {
      if (groupBy === 'stage') return a.stage || 'NEW';
      if (groupBy === 'role') return a.job_role || 'No role';
      if (groupBy === 'category') return a.category || 'Uncategorised';
      return latestReplyByApplicant.get(a.applicant_id)?.classified_intent || 'no reply';
    };
    const map = new Map<string, Row[]>();
    for (const a of list) {
      const k = keyOf(a);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(a);
    }
    let keys = [...map.keys()];
    keys = groupBy === 'stage'
      ? keys.sort((x, y) => STAGES.indexOf(x as never) - STAGES.indexOf(y as never))
      : keys.sort();
    return keys.map((k) => ({ key: k, rows: map.get(k)! }));
  }, [list, groupBy, latestReplyByApplicant]);

  const selected = useMemo(() => applicants.find((a) => a.applicant_id === selectedId) ?? null, [applicants, selectedId]);
  const threadReplies = useMemo(
    () => replies.filter((r) => r.applicant_id === selectedId).sort((a, b) => a.received_at.localeCompare(b.received_at)),
    [replies, selectedId]
  );

  const threadItems = useMemo((): ThreadItem[] => {
    if (!selected) return [];
    const items: ThreadItem[] = [];
    if (selected.email_html) items.push({ kind: 'sent', at: selected.sent_at || selected.updated_at, subject: selected.email_subject, html: selected.email_html });
    for (const r of threadReplies) items.push({ kind: 'reply', at: r.received_at, from: r.from, intent: r.classified_intent, snippet: r.snippet, handled: Boolean(r.handled_at) });
    for (const m of gmailMessages ?? []) {
      items.push({
        kind: 'gmail', at: m.date, from: m.from, to: m.to, subject: m.subject, html: m.html, text: m.text,
        attachments: m.attachments, inbound: selected.email ? m.from.toLowerCase().includes(selected.email.toLowerCase()) : false,
      });
    }
    return items.sort((a, b) => a.at.localeCompare(b.at));
  }, [selected, threadReplies, gmailMessages]);

  const checkedRows = useMemo(() => applicants.filter((a) => checked.has(a.applicant_id)), [applicants, checked]);
  const canDraft = checkedRows.length > 0 && checkedRows.every((r) => ACTIONABLE.draft.includes(r.stage as never));
  const canApprove = checkedRows.length > 0 && checkedRows.every((r) => r.stage === 'DRAFTED');
  const canSend = checkedRows.length > 0 && checkedRows.every((r) => r.stage === 'APPROVED');

  function toggleChecked(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function select(id: string) {
    setSelectedId(id);
    setCompose(EMPTY_COMPOSE);
    setGmailMessages(null);
    setAttachError(null);
    setCategoryDraft(applicants.find((a) => a.applicant_id === id)?.category ?? '');
    clear();
  }

  async function bulkAct(action: string) {
    const res = await run(action, { ids: [...checked] });
    if (res.ok) setChecked(new Set());
    setConfirmSend(false);
  }

  async function saveCategory() {
    if (!selected) return;
    await run('set-category', { ids: [selected.applicant_id], category: categoryDraft.trim() });
  }

  async function applyBulkCategory() {
    if (!checked.size) return;
    const res = await run('set-category', { ids: [...checked], category: bulkCategory.trim() });
    if (res.ok) { setChecked(new Set()); setBulkCategory(''); }
  }

  async function startConversation() {
    const res = await run('start-conversation', {
      name: newContact.name.trim(), email: newContact.email.trim(),
      job_role: newContact.role, category: newContact.category.trim(),
    });
    if (res.ok && res.result?.applicant_id) {
      select(res.result.applicant_id);
      setNewContact({ name: '', email: '', role: '', category: '' });
      setShowNewContact(false);
    }
  }

  async function syncGmail() {
    if (!selected) return;
    const res = await run('gmail-sync', { applicant_id: selected.applicant_id });
    if (res.ok && res.result?.messages) setGmailMessages(res.result.messages);
  }

  async function useTemplate() {
    if (!selected) return;
    const res = await run('reply-template-fill', { applicant_id: selected.applicant_id, template_id: compose.templateId });
    if (res.ok && res.result) setCompose((c) => ({ ...c, subject: res.result?.subject ?? '', html: res.result?.html ?? '' }));
  }

  async function writeWithAI() {
    if (!selected) return;
    const latestGmail = [...(gmailMessages ?? [])].sort((a, b) => b.date.localeCompare(a.date))[0];
    const gmailContext = latestGmail ? (latestGmail.text || latestGmail.html.replace(/<[^>]+>/g, ' ')).trim().slice(0, 2000) : '';
    const res = await run('reply-ai-draft', {
      applicant_id: selected.applicant_id, template_id: compose.templateId, instructions: compose.instructions, gmail_context: gmailContext,
    });
    if (res.ok && res.result) setCompose((c) => ({ ...c, subject: res.result?.subject ?? c.subject, html: res.result?.html ?? c.html }));
  }

  async function send() {
    if (!selected) return;
    const res = await run('send-reply', {
      applicant_id: selected.applicant_id, template_id: compose.templateId, subject: compose.subject, html: compose.html,
      attachments: compose.attachments.map(({ filename, mimeType, base64 }) => ({ filename, mimeType, base64 })),
    });
    if (res.ok) setCompose(EMPTY_COMPOSE);
  }

  async function addFiles(fileList: FileList | null) {
    if (!fileList || !fileList.length) return;
    setAttachError(null);
    let total = compose.attachments.reduce((n, a) => n + a.size, 0);
    const added: Attachment[] = [];
    for (const file of Array.from(fileList)) {
      if (total + file.size > MAX_ATTACHMENTS_BYTES) {
        setAttachError(`Skipped "${file.name}" — attachments would exceed the ${formatBytes(MAX_ATTACHMENTS_BYTES)} limit.`);
        continue;
      }
      added.push({ filename: file.name, mimeType: file.type || 'application/octet-stream', base64: await fileToBase64(file), size: file.size });
      total += file.size;
    }
    setCompose((c) => ({ ...c, attachments: [...c.attachments, ...added] }));
  }

  const hasPlaceholder = PLACEHOLDER_RE.test(compose.subject) || PLACEHOLDER_RE.test(compose.html);
  // Live sending with no mailbox configured is a broken deployment: the
  // server refuses it outright (E-CONFIG-MISSING) rather than pretending, so
  // the UI says so up front instead of letting someone click into the error.
  const sendingBroken = !dryRun && !gmailConfigured;
  const willSendForReal = !dryRun && gmailConfigured;
  // sendEnabled is the Settings master switch. A reply is email leaving the
  // building too, so it answers to the same switch the bulk Send does —
  // enforced server-side as well; this only saves the round trip.
  const canSendReply = Boolean(compose.subject.trim() && compose.html.trim() && !hasPlaceholder && sendEnabled && !sendingBroken);

  return (
    <>
      <ResultBanner result={result} onClose={clear} />

      <div className="toolbar">
        <button className="primary" disabled={!canDraft || busy !== null} onClick={() => bulkAct('draft')}>
          {busy === 'draft' ? 'Generating…' : `Generate drafts${checked.size ? ` (${checked.size})` : ''}`}
        </button>
        <button disabled={!canApprove || busy !== null} onClick={() => bulkAct('approve')}>
          Approve{checked.size ? ` (${checked.size})` : ''}
        </button>
        <button disabled={checkedRows.length === 0 || !checkedRows.every((r) => r.stage === 'APPROVED') || busy !== null} onClick={() => bulkAct('unapprove')}>
          Unapprove
        </button>
        <button
          className={dryRun ? '' : 'danger'}
          disabled={!canSend || busy !== null || !sendEnabled || sendingBroken}
          onClick={() => setConfirmSend(true)}
          title={sendingBroken ? 'Dry run is off but Gmail is not configured — sending is refused' : !sendEnabled ? 'Sending is switched off in Settings' : undefined}
        >
          {dryRun ? 'Dry-run send' : 'Send'}{checked.size ? ` (${checked.size})` : ''}
        </button>
        <span className="spacer" />
        {checked.size ? <button className="ghost sm" onClick={() => setChecked(new Set())}>Clear selection</button> : null}
      </div>

      {checked.size ? (
        <div className="toolbar">
          <span className="muted" style={{ fontSize: 12 }}>Category for {checked.size} selected</span>
          <input
            type="text" list="category-suggestions" value={bulkCategory} onChange={(e) => setBulkCategory(e.target.value)}
            placeholder="e.g. Senior" style={{ width: 160 }}
          />
          <button className="sm" disabled={busy !== null} onClick={applyBulkCategory}>
            {busy === 'set-category' ? 'Applying…' : 'Set category'}
          </button>
        </div>
      ) : null}
      <datalist id="category-suggestions">
        {categorySuggestions.map((c) => <option key={c} value={c} />)}
      </datalist>

      {confirmSend ? (
        <div className="banner warn">
          <span>!</span>
          <div style={{ flex: 1 }}>
            <strong>
              {dryRun ? `Dry run: log ${checkedRows.length} email(s) without sending?` : `Really email ${checkedRows.length} candidate(s)? This cannot be undone.`}
            </strong>
            <div className="hint" style={{ marginTop: 6 }}>
              {checkedRows.slice(0, 12).map((r) => r.email).join(', ')}{checkedRows.length > 12 ? ` … and ${checkedRows.length - 12} more` : ''}
            </div>
            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
              <button className={dryRun ? 'primary' : 'danger'} onClick={() => bulkAct('send')} disabled={busy !== null}>
                {busy === 'send' ? 'Sending…' : dryRun ? 'Run dry send' : `Yes, send ${checkedRows.length}`}
              </button>
              <button onClick={() => setConfirmSend(false)}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="inbox-layout">
        <div className="inbox-list-wrap">
          <div className="toolbar">
            <input type="search" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ minWidth: 0, flex: 1 }} />
            <button type="button" className="ghost sm" onClick={() => setShowNewContact((v) => !v)}>
              {showNewContact ? 'Cancel' : '+ New'}
            </button>
          </div>

          {showNewContact ? (
            <div className="panel" style={{ padding: 12, marginBottom: 10 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Start a conversation with someone not yet in the pipeline.</div>
              <label style={{ display: 'block', marginBottom: 8 }}>
                <div className="muted" style={{ marginBottom: 4, fontSize: 12 }}>Name</div>
                <input type="text" style={{ width: '100%' }} value={newContact.name} onChange={(e) => setNewContact((c) => ({ ...c, name: e.target.value }))} />
              </label>
              <label style={{ display: 'block', marginBottom: 8 }}>
                <div className="muted" style={{ marginBottom: 4, fontSize: 12 }}>Email</div>
                <input type="email" style={{ width: '100%' }} value={newContact.email} onChange={(e) => setNewContact((c) => ({ ...c, email: e.target.value }))} />
              </label>
              <div className="grid cols-2" style={{ marginBottom: 8 }}>
                <label>
                  <div className="muted" style={{ marginBottom: 4, fontSize: 12 }}>Role (optional)</div>
                  <select style={{ width: '100%' }} value={newContact.role} onChange={(e) => setNewContact((c) => ({ ...c, role: e.target.value }))}>
                    <option value="">No role</option>
                    {roles.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </label>
                <label>
                  <div className="muted" style={{ marginBottom: 4, fontSize: 12 }}>Category (optional)</div>
                  <input type="text" list="category-suggestions" style={{ width: '100%' }} value={newContact.category} onChange={(e) => setNewContact((c) => ({ ...c, category: e.target.value }))} />
                </label>
              </div>
              <button className="primary sm" disabled={!newContact.email.trim() || busy !== null} onClick={startConversation}>
                {busy === 'start-conversation' ? 'Starting…' : 'Start conversation'}
              </button>
            </div>
          ) : null}
          <div className="toolbar" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
            <select value={role} onChange={(e) => setRole(e.target.value)} style={{ flex: 1, minWidth: 100 }}>
              <option value="">All roles</option>
              {roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <select value={stage} onChange={(e) => setStage(e.target.value)} style={{ flex: 1, minWidth: 100 }}>
              <option value="">All stages</option>
              {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="toolbar" style={{ marginBottom: 8 }}>
            <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ flex: 1 }}>
              <option value="">All categories</option>
              {usedCategories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="toolbar" style={{ marginBottom: 8 }}>
            <span className="muted" style={{ fontSize: 12 }}>Group by</span>
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)} style={{ flex: 1 }}>
              <option value="none">None</option>
              <option value="category">Category</option>
              <option value="stage">Stage</option>
              <option value="role">Role</option>
              <option value="intent">Reply intent</option>
            </select>
          </div>

          <div className="inbox-list">
            {groupedList.map((group) => (
              <div key={group.key || 'all'}>
                {group.key ? <div className="inbox-group-header">{group.key} <span className="muted">({group.rows.length})</span></div> : null}
                {group.rows.map((a) => (
                  <div key={a.applicant_id} className={`inbox-item${a.applicant_id === selectedId ? ' active' : ''}`}>
                    <input
                      type="checkbox" className="inbox-item-check" checked={checked.has(a.applicant_id)}
                      onChange={() => toggleChecked(a.applicant_id)} aria-label={`Select ${a.name}`}
                    />
                    <button type="button" className="inbox-item-body" onClick={() => select(a.applicant_id)}>
                      <div className="inbox-item-top">
                        <span className="inbox-item-name">
                          {unhandledByApplicant.has(a.applicant_id) ? <span className="unread-dot" aria-hidden="true" /> : null}
                          {a.name || '(no name)'}
                        </span>
                        <span className="muted" style={{ fontSize: 11, flex: 'none' }}>{timeAgo(a.updated_at || a.created_at)}</span>
                      </div>
                      <div className="muted" style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        {a.job_role} <StagePill stage={a.stage} /> <CategoryPill category={a.category} />
                      </div>
                      <div className="inbox-item-snippet muted">
                        {latestReplyByApplicant.get(a.applicant_id)?.snippet || (a.email_html ? 'No reply yet.' : 'No messages yet.')}
                      </div>
                    </button>
                  </div>
                ))}
              </div>
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
                <CategoryPill category={selected.category} />
              </div>
              <div className="toolbar" style={{ marginTop: 6, marginBottom: 0 }}>
                <span className="muted" style={{ fontSize: 13 }}>
                  {selected.job_role} · <span className="mono">{selected.applicant_id}</span>
                </span>
                <span className="spacer" />
                <button
                  className="ghost sm" disabled={busy !== null || !gmailConfigured} onClick={syncGmail}
                  title={!gmailConfigured ? 'Gmail is not configured — see dashboard/README.md' : "Import this candidate's real Gmail thread"}
                >
                  {busy === 'gmail-sync' ? 'Syncing…' : '⟳ Sync from Gmail'}
                </button>
              </div>
              <div className="toolbar" style={{ marginTop: 6, marginBottom: 0 }}>
                <span className="muted" style={{ fontSize: 12 }}>Category</span>
                <input
                  type="text" list="category-suggestions" value={categoryDraft}
                  onChange={(e) => setCategoryDraft(e.target.value)}
                  placeholder="Uncategorised" style={{ width: 180 }}
                />
                <button
                  className="sm" disabled={busy !== null || categoryDraft.trim() === (selected.category || '')}
                  onClick={saveCategory}
                >
                  {busy === 'set-category' ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>

            <div className="thread">
              {threadItems.map((item, i) => {
                if (item.kind === 'sent') return (
                  <div className="bubble bubble-sent" key={`sent-${i}`}>
                    <div className="bubble-meta"><strong>You</strong><span className="muted">→ {selected.email}</span><span className="spacer" /><span className="muted">{shortDate(item.at)}</span></div>
                    <div className="bubble-subject">{item.subject}</div>
                    <div className="preview" dangerouslySetInnerHTML={{ __html: item.html }} />
                  </div>
                );
                if (item.kind === 'reply') return (
                  <div className="bubble bubble-reply" key={`reply-${i}`}>
                    <div className="bubble-meta"><strong>{selected.name || item.from}</strong><IntentPill intent={item.intent} /><span className="spacer" /><span className="muted">{shortDate(item.at)}</span></div>
                    <div>{item.snippet}</div>
                    <div style={{ marginTop: 6 }}>{item.handled ? <span className="pill ok">handled</span> : <span className="pill warn">open</span>}</div>
                  </div>
                );
                return (
                  <div className={`bubble ${item.inbound ? 'bubble-reply' : 'bubble-sent'}`} key={`gmail-${i}`}>
                    <div className="bubble-meta">
                      <strong>{item.inbound ? (selected.name || item.from) : 'You'}</strong>
                      <span className="pill info">real Gmail</span>
                      <span className="spacer" /><span className="muted">{shortDate(item.at)}</span>
                    </div>
                    <div className="bubble-subject">{item.subject}</div>
                    {item.html ? <div className="preview" dangerouslySetInnerHTML={{ __html: item.html }} /> : <div>{item.text}</div>}
                    {item.attachments.length ? (
                      <div className="attachment-list">
                        {item.attachments.map((att) => (
                          <a
                            key={att.attachmentId} className="pill attachment-pill"
                            href={`/api/gmail-attachment?messageId=${encodeURIComponent(att.messageId)}&attachmentId=${encodeURIComponent(att.attachmentId)}&filename=${encodeURIComponent(att.filename)}&mimeType=${encodeURIComponent(att.mimeType)}`}
                          >
                            📎 {att.filename} <span className="muted">({formatBytes(att.size)})</span>
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {threadItems.length === 0 ? <div className="empty">No messages in this thread yet — send the first one below, or sync from Gmail.</div> : null}
            </div>

            <div className="panel">
              <h2>Reply</h2>
              <p className="sub">
                Load a template, write it yourself, or let AI draft it — review before sending either way.
                {sendingBroken
                  ? ' Dry run is off but Gmail is not configured — sending is refused until that is fixed. Nothing is being logged as sent.'
                  : willSendForReal ? ' Gmail is configured and dry run is off: this will send for real.'
                  : gmailConfigured ? ' Dry run is on — this will be logged, not delivered, until you turn it off in Settings.'
                  : ' Gmail is not configured and dry run is on — this will be simulated, not delivered.'}
              </p>

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
                <button disabled={busy !== null} onClick={useTemplate}>{busy === 'reply-template-fill' ? 'Loading…' : '✍️ Write manually'}</button>
                <button disabled={busy !== null} onClick={writeWithAI}>{busy === 'reply-ai-draft' ? 'Writing…' : '✨ Write with AI'}</button>
                <span className="spacer" />
                {compose.subject || compose.html || compose.attachments.length ? <button className="ghost sm" onClick={() => setCompose(EMPTY_COMPOSE)}>Clear</button> : null}
              </div>

              <label style={{ display: 'block', marginBottom: 10 }}>
                <div className="muted" style={{ marginBottom: 4 }}>Subject</div>
                <input type="text" style={{ width: '100%' }} value={compose.subject} onChange={(e) => setCompose((c) => ({ ...c, subject: e.target.value }))} />
              </label>
              <label style={{ display: 'block' }}>
                <div className="muted" style={{ marginBottom: 4 }}>Message (HTML)</div>
                <textarea rows={9} value={compose.html} onChange={(e) => setCompose((c) => ({ ...c, html: e.target.value }))} />
              </label>

              <div style={{ marginTop: 10 }}>
                <label className="ghost sm" style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer', padding: '5px 11px', borderRadius: 'var(--radius-pill)' }}>
                  📎 Attach files
                  <input type="file" multiple style={{ display: 'none' }} onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
                </label>
                {compose.attachments.length ? (
                  <div className="attachment-list" style={{ marginTop: 8 }}>
                    {compose.attachments.map((a, i) => (
                      <span key={`${a.filename}-${i}`} className="pill attachment-pill">
                        📎 {a.filename} <span className="muted">({formatBytes(a.size)})</span>
                        <button type="button" className="attachment-remove" aria-label={`Remove ${a.filename}`}
                          onClick={() => setCompose((c) => ({ ...c, attachments: c.attachments.filter((_, j) => j !== i) }))}
                        >×</button>
                      </span>
                    ))}
                  </div>
                ) : null}
                {attachError ? <div className="muted" style={{ fontSize: 12, marginTop: 6, color: 'var(--warn)' }}>{attachError}</div> : null}
              </div>

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
                  className={willSendForReal ? 'danger' : 'primary'}
                  disabled={!canSendReply || busy !== null} onClick={send}
                  title={!sendEnabled ? 'Sending is switched off in Settings' : undefined}
                >
                  {busy === 'send-reply' ? 'Sending…' : willSendForReal ? 'Send for real' : 'Send'}
                </button>
                {!sendEnabled ? <span className="muted" style={{ fontSize: 12 }}>Sending is off in Settings.</span> : null}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
