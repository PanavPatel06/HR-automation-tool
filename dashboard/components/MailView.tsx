'use client';
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Row } from '../lib/contract';
import { isTruthy, ACTIONABLE, STAGES } from '../lib/contract';
import { StagePill, CategoryPill } from './Pills';
import { shortDate, timeAgo } from '../lib/format';
import { findDuplicates, duplicateIds } from '../lib/duplicates';
import { useAction, ResultBanner } from './useAction';

const PLACEHOLDER_RE = /\{\{\s*[a-zA-Z0-9_.]+\s*\}\}/;
const MAX_ATTACHMENTS_BYTES = 15 * 1024 * 1024;

type Attachment = { filename: string; mimeType: string; base64: string; size: number };
type Compose = { templateId: string; subject: string; html: string; instructions: string; attachments: Attachment[] };
const EMPTY_COMPOSE: Compose = { templateId: '', subject: '', html: '', instructions: '', attachments: [] };

type GroupBy = 'none' | 'stage' | 'role' | 'category';

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
 * The whole app: the candidate list on the left (from the Applicants tab),
 * and on the right the message you are about to send them.
 *
 * The composer's centre of gravity is the instructions box. You pick a
 * candidate, say what the email should cover in plain English, and the model
 * writes it — their name, role and category come from their sheet row, so you
 * never type those. A template is optional, either as a starting point or as a
 * style reference for the model.
 *
 * Two rules hold whichever way the message got written:
 *   - AI only ever fills the compose box; a human still has to press Send.
 *   - Sending is blocked while a literal {{field}} is still visible.
 *
 * Nothing here reads the candidate's mailbox. Their replies arrive in whatever
 * inbox company_email points at, and a human reads them there.
 */
export function MailView({ applicants, templates, roles, categories: configCategories, mailerConfigured, dryRun, sendEnabled, loadedAt }: {
  applicants: Row[];
  templates: Row[];
  roles: string[];
  categories: string[];
  mailerConfigured: boolean;
  dryRun: boolean;
  sendEnabled: boolean;
  /** When the server read the sheet for this render. */
  loadedAt: string;
}) {
  const { run, busy, result, clear } = useAction();
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
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
  const [categoryDraft, setCategoryDraft] = useState('');
  const [bulkCategory, setBulkCategory] = useState('');
  const [showNewContact, setShowNewContact] = useState(false);
  const [newContact, setNewContact] = useState({ name: '', email: '', role: '', category: '', notes: '' });
  const [emailDraft, setEmailDraft] = useState('');

  const activeTemplates = useMemo(() => templates.filter((t) => isTruthy(t.is_active)), [templates]);

  // Redundancy in the sheet. A repeated applicant_id makes every action target
  // the first matching row silently, so it is worth surfacing where the rows
  // actually are — see lib/duplicates.ts.
  const duplicates = useMemo(() => findDuplicates(applicants), [applicants]);
  const dupIds = useMemo(() => duplicateIds(duplicates), [duplicates]);

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

  const list = useMemo(() => applicants
    .filter((a) => a.applicant_id)
    .filter((a) => !role || a.job_role === role)
    .filter((a) => !stage || a.stage === stage)
    .filter((a) => !category || a.category === category)
    .filter((a) => {
      if (!query) return true;
      const q = query.toLowerCase();
      return [a.name, a.email, a.applicant_id, a.job_role, a.notes].some((f) => String(f ?? '').toLowerCase().includes(q));
    })
    .sort((a, b) => (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || '')),
    [applicants, role, stage, category, query]);

  const groupedList = useMemo(() => {
    if (groupBy === 'none') return [{ key: '', rows: list }];
    const keyOf = (a: Row) => {
      if (groupBy === 'stage') return a.stage || 'NEW';
      if (groupBy === 'role') return a.job_role || 'No role';
      return a.category || 'Uncategorised';
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
  }, [list, groupBy]);

  const selected = useMemo(() => applicants.find((a) => a.applicant_id === selectedId) ?? null, [applicants, selectedId]);

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
    setAttachError(null);
    const row = applicants.find((a) => a.applicant_id === id);
    setCategoryDraft(row?.category ?? '');
    setEmailDraft(row?.email ?? '');
    clear();
  }

  // The sheet is edited outside this app — by hand, by a form, by a paste — so
  // this page can be stale the moment it loads. router.refresh() re-runs the
  // server components (the page is force-dynamic, so that is a fresh read of
  // Sheets) without a full navigation, keeping selection and scroll.
  function refreshFromSheet() {
    clear();
    startRefresh(() => router.refresh());
  }

  async function saveEmail() {
    if (!selected) return;
    await run('set-email', { applicant_id: selected.applicant_id, email: emailDraft.trim() });
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
      job_role: newContact.role, category: newContact.category.trim(), notes: newContact.notes.trim(),
    });
    if (res.ok && res.result?.applicant_id) {
      select(res.result.applicant_id);
      setNewContact({ name: '', email: '', role: '', category: '', notes: '' });
      setShowNewContact(false);
    }
  }

  async function useTemplate() {
    if (!selected) return;
    const res = await run('reply-template-fill', { applicant_id: selected.applicant_id, template_id: compose.templateId });
    if (res.ok && res.result) setCompose((c) => ({ ...c, subject: res.result?.subject ?? '', html: res.result?.html ?? '' }));
  }

  async function writeWithAI() {
    if (!selected) return;
    const res = await run('reply-ai-draft', {
      applicant_id: selected.applicant_id, template_id: compose.templateId, instructions: compose.instructions,
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
  // Live sending with no mailer configured is a broken deployment: the server
  // refuses it outright (E-CONFIG-MISSING) rather than pretending, so the UI
  // says so up front instead of letting someone click into the error.
  const sendingBroken = !dryRun && !mailerConfigured;
  const willSendForReal = !dryRun && mailerConfigured;
  // sendEnabled is the Settings master switch. Enforced server-side as well;
  // this only saves the round trip.
  const canSendReply = Boolean(compose.subject.trim() && compose.html.trim() && !hasPlaceholder && sendEnabled && !sendingBroken);
  // The model needs something to go on: either a brief, or a template to
  // rewrite. Matches the server-side check in reply-ai-draft.
  const canWriteWithAI = Boolean(compose.instructions.trim() || compose.templateId);

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
          title={sendingBroken ? 'Dry run is off but email sending is not configured — sending is refused' : !sendEnabled ? 'Sending is switched off in Settings' : undefined}
        >
          {dryRun ? 'Dry-run send' : 'Send'}{checked.size ? ` (${checked.size})` : ''}
        </button>
        <span className="spacer" />
        {checked.size ? <button className="ghost sm" onClick={() => setChecked(new Set())}>Clear selection</button> : null}
        <span className="muted" style={{ fontSize: 12 }}>Sheet read {timeAgo(loadedAt)}</span>
        <button
          className="ghost sm" onClick={refreshFromSheet} disabled={refreshing}
          title="Re-read the Applicants, Templates and Config tabs from Google Sheets"
        >
          {refreshing ? 'Refreshing…' : '⟳ Refresh from sheet'}
        </button>
      </div>

      {duplicates.length ? (
        <div className="banner warn">
          <span>!</span>
          <div>
            <strong>
              {duplicates.length === 1 ? '1 duplicate' : `${duplicates.length} duplicates`} in the Applicants tab.
            </strong>
            <div className="hint" style={{ marginTop: 6 }}>
              {duplicates.map((d) => (
                <div key={`${d.kind}-${d.value}`}>
                  {d.kind === 'applicant_id'
                    ? <>Id <span className="mono">{d.value}</span> is on {d.rows.length} rows — every action on it silently hits the first one. </>
                    : <><span className="mono">{d.value}</span> is on {d.rows.length} rows — they will be emailed {d.rows.length} times. </>}
                  Sheet row{d.rows.length === 1 ? '' : 's'} {d.rows.map((r) => r._row).join(', ')}.
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

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
              <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Adds a row to the Applicants tab.</div>
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
                  <input type="text" list="role-suggestions" style={{ width: '100%' }} value={newContact.role} onChange={(e) => setNewContact((c) => ({ ...c, role: e.target.value }))} />
                </label>
                <label>
                  <div className="muted" style={{ marginBottom: 4, fontSize: 12 }}>Category (optional)</div>
                  <input type="text" list="category-suggestions" style={{ width: '100%' }} value={newContact.category} onChange={(e) => setNewContact((c) => ({ ...c, category: e.target.value }))} />
                </label>
              </div>
              <label style={{ display: 'block', marginBottom: 8 }}>
                <div className="muted" style={{ marginBottom: 4, fontSize: 12 }}>Notes (given to the AI as context)</div>
                <input type="text" style={{ width: '100%' }} value={newContact.notes} onChange={(e) => setNewContact((c) => ({ ...c, notes: e.target.value }))} placeholder="e.g. referred by Meera, strong React portfolio" />
              </label>
              <button className="primary sm" disabled={!newContact.email.trim() || busy !== null} onClick={startConversation}>
                {busy === 'start-conversation' ? 'Adding…' : 'Add candidate'}
              </button>
            </div>
          ) : null}
          <datalist id="role-suggestions">
            {roles.map((r) => <option key={r} value={r} />)}
          </datalist>

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
                        <span className="inbox-item-name">{a.name || '(no name)'}</span>
                        <span className="muted" style={{ fontSize: 11, flex: 'none' }}>{timeAgo(a.updated_at || a.created_at)}</span>
                      </div>
                      <div className="muted" style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        {a.job_role} <StagePill stage={a.stage} /> <CategoryPill category={a.category} />
                        {dupIds.has(a.applicant_id) ? <span className="pill warn" title="Shares an id or email with another row">duplicate</span> : null}
                      </div>
                      <div className="inbox-item-snippet muted">
                        {a.sent_at ? `Last emailed ${timeAgo(a.sent_at)}` : 'Not emailed yet.'}
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
            <div className="empty">Select a candidate on the left to write to them.</div>
          </div>
        ) : (
          <div>
            <div className="panel">
              <div className="toolbar" style={{ marginBottom: 4 }}>
                <div>
                  <h2 style={{ margin: 0 }}>{selected.name || '(no name)'}</h2>
                  <div className="muted mono" style={{ fontSize: 12 }}>{selected.email || 'no email address'}</div>
                </div>
                <span className="spacer" />
                <StagePill stage={selected.stage} />
                <CategoryPill category={selected.category} />
              </div>
              <div className="toolbar" style={{ marginTop: 6, marginBottom: 0 }}>
                <span className="muted" style={{ fontSize: 13 }}>
                  {selected.job_role || 'No role'} · <span className="mono">{selected.applicant_id}</span>
                </span>
              </div>
              {/* A row can arrive with a missing or typo'd address; sending
                  refuses those, so it is fixable here rather than in the sheet. */}
              <div className="toolbar" style={{ marginTop: 6, marginBottom: 0 }}>
                <span className="muted" style={{ fontSize: 12 }}>Email</span>
                <input
                  type="email" value={emailDraft} onChange={(e) => setEmailDraft(e.target.value)}
                  placeholder="name@example.com" style={{ width: 260 }}
                />
                <button
                  className="sm" disabled={busy !== null || !emailDraft.trim() || emailDraft.trim() === (selected.email || '')}
                  onClick={saveEmail}
                >
                  {busy === 'set-email' ? 'Saving…' : 'Save'}
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
              {/* Whatever is in their notes cell — the model is given this
                  verbatim, so it is worth seeing before writing to them. */}
              {selected.notes ? (
                <div className="muted" style={{ fontSize: 13, marginTop: 10, fontStyle: 'italic' }}>{selected.notes}</div>
              ) : null}
            </div>

            {/* The last email we sent, straight from the sheet row. There is no
                inbound half — candidates reply into a real mailbox, not here. */}
            {selected.email_html ? (
              <div className="thread">
                <div className="bubble bubble-sent">
                  <div className="bubble-meta">
                    <strong>You</strong><span className="muted">→ {selected.email}</span>
                    <span className="spacer" />
                    <span className="muted">{selected.sent_at ? shortDate(selected.sent_at) : 'draft, not sent'}</span>
                  </div>
                  <div className="bubble-subject">{selected.email_subject}</div>
                  <div className="preview" dangerouslySetInnerHTML={{ __html: selected.email_html }} />
                </div>
              </div>
            ) : null}

            <div className="panel">
              <h2>Write to {selected.name?.split(' ')[0] || 'this candidate'}</h2>
              <p className="sub">
                Say what the email should cover — their name{selected.job_role ? `, the ${selected.job_role} role` : ''}
                {selected.notes ? ', your notes on them' : ''} and the branding are filled in from the sheet,
                so you never type those.
                {sendingBroken
                  ? ' Dry run is off but email sending is not configured — sending is refused until that is fixed. Nothing is being logged as sent.'
                  : willSendForReal ? ' Sending is live: this will reach them for real.'
                  : mailerConfigured ? ' Dry run is on — this will be logged, not delivered, until you turn it off in Settings.'
                  : ' Email sending is not configured and dry run is on — this will be simulated, not delivered.'}
              </p>

              <label style={{ display: 'block', marginBottom: 12 }}>
                <div className="muted" style={{ marginBottom: 4 }}>What should this email say?</div>
                <textarea
                  rows={3} value={compose.instructions}
                  onChange={(e) => setCompose((c) => ({ ...c, instructions: e.target.value }))}
                  placeholder={`e.g. invite ${selected.name?.split(' ')[0] || 'them'} to a 30-minute intro call next week, mention it is remote, ask for two time slots`}
                />
              </label>

              <label style={{ display: 'block', marginBottom: 12 }}>
                <div className="muted" style={{ marginBottom: 4 }}>Base it on a template (optional)</div>
                <select style={{ width: '100%' }} value={compose.templateId} onChange={(e) => setCompose((c) => ({ ...c, templateId: e.target.value }))}>
                  <option value="">No template — write from the instructions alone</option>
                  {activeTemplates.map((t) => (
                    <option key={t.template_id} value={t.template_id}>{t.name}{t.job_role ? ` — ${t.job_role}` : ''}</option>
                  ))}
                </select>
              </label>

              <div className="toolbar">
                <button
                  className="primary" disabled={busy !== null || !canWriteWithAI} onClick={writeWithAI}
                  title={canWriteWithAI ? undefined : 'Type what the email should say, or pick a template'}
                >
                  {busy === 'reply-ai-draft' ? 'Writing…' : '✨ Write with AI'}
                </button>
                <button
                  disabled={busy !== null || !compose.templateId} onClick={useTemplate}
                  title={compose.templateId ? 'Fill the template in as-is, no model call' : 'Pick a template first'}
                >
                  {busy === 'reply-template-fill' ? 'Loading…' : 'Use template as-is'}
                </button>
                <span className="spacer" />
                {compose.subject || compose.html || compose.attachments.length ? <button className="ghost sm" onClick={() => setCompose(EMPTY_COMPOSE)}>Clear</button> : null}
              </div>

              <label style={{ display: 'block', marginBottom: 10, marginTop: 12 }}>
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
