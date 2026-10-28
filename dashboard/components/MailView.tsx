'use client';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Row } from '../lib/contract';
import { isTruthy, STAGES } from '../lib/contract';
import { StagePill, CategoryPill } from './Pills';
import { shortDate, timeAgo } from '../lib/format';
import { findDuplicates, duplicateIds } from '../lib/duplicates';
import { useAction, ResultBanner, type PreparedEmail } from './useAction';

const PLACEHOLDER_RE = /\{\{\s*[a-zA-Z0-9_.]+\s*\}\}/;
const MAX_ATTACHMENTS_BYTES = 15 * 1024 * 1024;

type Attachment = { filename: string; mimeType: string; base64: string; size: number };
type Compose = { templateId: string; subject: string; html: string; instructions: string; attachments: Attachment[] };
const EMPTY_COMPOSE: Compose = { templateId: '', subject: '', html: '', instructions: '', attachments: [] };

type GroupBy = 'none' | 'stage' | 'role' | 'category';
type ComposeMode = 'new' | 'reply';
type MailMessage = {
  messageId: string; threadId: string; folderId: string; subject: string;
  fromAddress: string; toAddress: string; summary: string; sentDateInGMT: string;
  receivedTime: string; status: string; hasAttachment: string; content?: string; contentError?: string;
};

function messageDate(value: string): string {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : value;
}

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
 * For new email, you describe what it should cover and the model writes it.
 * For replies, the candidate's latest email supplies the context; extra
 * guidance is optional. Their name, role and category come from the sheet.
 * A template can guide either mode.
 *
 * AI drafts stay in the single-message composer or bulk review list until HR
 * explicitly confirms sending. Sending is blocked while a literal {{field}}
 * is still visible.
 *
 * Candidate membership stays in Applicants. Mail and conversation bodies are
 * fetched live from Zoho and are never written into the spreadsheet.
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
  const [showBulkComposer, setShowBulkComposer] = useState(false);
  const [bulkMode, setBulkMode] = useState<'reply' | 'template'>('reply');
  const [bulkTemplateId, setBulkTemplateId] = useState('');
  const [bulkInstructions, setBulkInstructions] = useState('');
  const [bulkPrepared, setBulkPrepared] = useState<PreparedEmail[]>([]);
  const [confirmBulkSend, setConfirmBulkSend] = useState(false);
  const [composeMode, setComposeMode] = useState<ComposeMode>('new');
  const [compose, setCompose] = useState<Compose>(EMPTY_COMPOSE);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [categoryDraft, setCategoryDraft] = useState('');
  const [bulkCategory, setBulkCategory] = useState('');
  const [showNewContact, setShowNewContact] = useState(false);
  const [newContact, setNewContact] = useState({ name: '', email: '', role: '', category: '', notes: '' });
  const [emailDraft, setEmailDraft] = useState('');
  const [mailMessages, setMailMessages] = useState<MailMessage[]>([]);
  const [mailLoading, setMailLoading] = useState(false);
  const [mailError, setMailError] = useState('');
  const [activeThreadId, setActiveThreadId] = useState('');
  const [threadMessages, setThreadMessages] = useState<MailMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState('');

  const activeTemplates = useMemo(() => templates.filter((t) => isTruthy(t.is_active)), [templates]);
  const selectedTemplate = useMemo(() => activeTemplates.find((t) => t.template_id === compose.templateId), [activeTemplates, compose.templateId]);

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

  const replyTarget = useMemo(() => {
    if (!selected?.email) return null;
    return [...threadMessages].reverse().find((message) =>
      message.fromAddress.toLowerCase().includes(selected.email.toLowerCase()),
    ) ?? null;
  }, [selected, threadMessages]);

  const mailThreads = useMemo(() => {
    const groups = new Map<string, MailMessage[]>();
    for (const message of mailMessages) {
      const id = message.threadId || message.messageId;
      groups.set(id, [...(groups.get(id) ?? []), message]);
    }
    return [...groups.entries()].map(([id, messages]) => ({
      id,
      messages,
      latest: messages[messages.length - 1],
      subject: messages[messages.length - 1]?.subject || '(no subject)',
    })).sort((a, b) => Number(b.latest?.sentDateInGMT || b.latest?.receivedTime) - Number(a.latest?.sentDateInGMT || a.latest?.receivedTime));
  }, [mailMessages]);

  async function loadCandidateMessages(applicantId: string) {
    setMailLoading(true);
    setMailError('');
    setMailMessages([]);
    setActiveThreadId('');
    setThreadMessages([]);
    setThreadError('');
    try {
      const response = await fetch(`/api/inbox?applicant_id=${encodeURIComponent(applicantId)}`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.hint || payload.message || 'Could not load Zoho messages.');
      setMailMessages(payload.data ?? []);
    } catch (err) {
      setMailError((err as Error).message || 'Could not load Zoho messages.');
    } finally {
      setMailLoading(false);
    }
  }

  async function loadThread(threadId: string) {
    if (!selected) return;
    setActiveThreadId(threadId);
    setThreadLoading(true);
    setThreadError('');
    setThreadMessages([]);
    try {
      const response = await fetch(`/api/inbox?applicant_id=${encodeURIComponent(selected.applicant_id)}&thread_id=${encodeURIComponent(threadId)}`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.hint || payload.message || 'Could not load this conversation.');
      setThreadMessages(payload.data ?? []);
    } catch (err) {
      setThreadError((err as Error).message || 'Could not load this conversation.');
    } finally {
      setThreadLoading(false);
    }
  }

  useEffect(() => {
    if (selectedId) void loadCandidateMessages(selectedId);
    else {
      setMailMessages([]);
      setActiveThreadId('');
      setThreadMessages([]);
    }
    // Loading is intentionally refreshed on candidate selection only; explicit refresh is available in the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const checkedRows = useMemo(() => applicants.filter((a) => checked.has(a.applicant_id)), [applicants, checked]);

  function toggleChecked(id: string) {
    setBulkPrepared([]);
    setConfirmBulkSend(false);
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function prepareBulkMessages() {
    if (!checkedRows.length) return;
    const res = await run('bulk-message-prepare', {
      ids: checkedRows.map((row) => row.applicant_id),
      message_mode: bulkMode,
      template_id: bulkTemplateId,
      instructions: bulkInstructions,
    });
    setBulkPrepared(res.result?.items ?? []);
    setConfirmBulkSend(false);
  }

  async function sendBulkMessages() {
    if (!bulkPrepared.length) return;
    const res = await run('bulk-message-send', {
      template_id: bulkTemplateId,
      items: bulkPrepared,
    });
    if (res.ok) {
      setChecked(new Set());
      setBulkPrepared([]);
      setConfirmBulkSend(false);
      setShowBulkComposer(false);
    } else if (res.code === 'E-NETWORK') {
      // The server may have completed the send before the network failed.
      // Drop this batch so a second click cannot resend the same messages.
      setBulkPrepared([]);
      setConfirmBulkSend(false);
    }
  }

  function select(id: string) {
    setSelectedId(id);
    setBulkPrepared([]);
    setConfirmBulkSend(false);
    setComposeMode('new');
    setCompose(EMPTY_COMPOSE);
    setAttachError(null);
    const row = applicants.find((a) => a.applicant_id === id);
    setCategoryDraft(row?.category ?? '');
    setEmailDraft(row?.email ?? '');
    setMailError('');
    setThreadError('');
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
      message_mode: composeMode,
      ...(composeMode === 'reply' && replyTarget ? {
        reply_context: {
          subject: replyTarget.subject,
          from: replyTarget.fromAddress,
          content: replyTarget.content,
        },
      } : {}),
    });
    if (res.ok && res.result) setCompose((c) => ({ ...c, subject: res.result?.subject ?? c.subject, html: res.result?.html ?? c.html }));
  }

  async function send() {
    if (!selected) return;
    if (composeMode === 'reply' && !replyTarget) return;
    const res = await run('send-reply', {
      applicant_id: selected.applicant_id, template_id: compose.templateId, subject: compose.subject, html: compose.html,
      message_mode: composeMode,
      ...(composeMode === 'reply' && replyTarget ? { reply_message_id: replyTarget.messageId } : {}),
      attachments: compose.attachments.map(({ filename, mimeType, base64 }) => ({ filename, mimeType, base64 })),
    });
    if (res.ok) {
      setCompose(EMPTY_COMPOSE);
      setComposeMode('new');
      await loadCandidateMessages(selected.applicant_id);
      if (activeThreadId) await loadThread(activeThreadId);
    }
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
  const canReply = Boolean(activeThreadId && replyTarget && !threadLoading);
  // In reply mode the incoming email itself is the prompt, so instructions
  // and templates are optional. New emails still need a brief or template.
  const canWriteWithAI = composeMode === 'reply'
    ? Boolean(replyTarget?.content?.trim())
    : Boolean(compose.instructions.trim() || compose.templateId);

  return (
    <>
      <ResultBanner result={result} onClose={clear} />

      <div className="toolbar">
        <button
          className="primary"
          disabled={!checkedRows.length || busy !== null}
          onClick={() => {
            setShowBulkComposer((open) => !open);
            setBulkPrepared([]);
            setConfirmBulkSend(false);
          }}
        >
          {showBulkComposer ? 'Close bulk email' : `Bulk email${checkedRows.length ? ` (${checkedRows.length})` : ''}`}
        </button>
        <span className="spacer" />
        {checked.size ? <button className="ghost sm" onClick={() => {
          setChecked(new Set());
          setBulkPrepared([]);
          setConfirmBulkSend(false);
        }}>Clear selection</button> : null}
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

      {showBulkComposer ? (
        <section className="panel" style={{ padding: 16, marginBottom: 14 }}>
          <h3 style={{ margin: '0 0 6px' }}>Bulk email for selected candidates</h3>
          <p className="muted" style={{ margin: '0 0 14px', fontSize: 13 }}>
            Prepare a personalized message for each of the {checkedRows.length} selected candidate(s). Their pipeline stage does not block bulk email.
          </p>

          <fieldset style={{ border: 0, padding: 0, margin: '0 0 14px' }}>
            <legend className="muted" style={{ marginBottom: 6, fontSize: 13 }}>Message type</legend>
            <div className="toolbar" role="group" aria-label="Bulk email message type">
              <button
                type="button" className={bulkMode === 'reply' ? 'primary sm' : 'sm'}
                aria-pressed={bulkMode === 'reply'} disabled={busy !== null}
                onClick={() => { setBulkMode('reply'); setBulkPrepared([]); setConfirmBulkSend(false); }}
              >Reply to latest response</button>
              <button
                type="button" className={bulkMode === 'template' ? 'primary sm' : 'sm'}
                aria-pressed={bulkMode === 'template'} disabled={busy !== null}
                onClick={() => { setBulkMode('template'); setBulkPrepared([]); setConfirmBulkSend(false); }}
              >Send using a template</button>
            </div>
          </fieldset>

          <label style={{ display: 'block', marginBottom: 12 }}>
            <div className="muted" style={{ marginBottom: 4 }}>
              {bulkMode === 'reply' ? 'Template style (optional)' : 'Template'}
            </div>
            <select
              style={{ width: '100%' }} value={bulkTemplateId}
              onChange={(event) => { setBulkTemplateId(event.target.value); setBulkPrepared([]); setConfirmBulkSend(false); }}
            >
              <option value="">{bulkMode === 'reply' ? 'No template — reply from each candidate’s message' : 'Choose a template'}</option>
              {activeTemplates.map((template) => (
                <option key={template.template_id} value={template.template_id}>
                  {template.name}{template.job_role ? ` — ${template.job_role}` : ''}
                </option>
              ))}
            </select>
          </label>

          {bulkMode === 'reply' ? (
            <label style={{ display: 'block', marginBottom: 12 }}>
              <div className="muted" style={{ marginBottom: 4 }}>Extra guidance for replies (optional)</div>
              <textarea
                rows={2} value={bulkInstructions}
                onChange={(event) => { setBulkInstructions(event.target.value); setBulkPrepared([]); setConfirmBulkSend(false); }}
                placeholder="e.g. Thank them for the reply and ask for their availability next week."
              />
            </label>
          ) : null}

          <div className="toolbar">
            <button
              className="primary" disabled={busy !== null || (bulkMode === 'template' && !bulkTemplateId)}
              onClick={prepareBulkMessages}
            >
              {busy === 'bulk-message-prepare' ? 'Preparing messages…' : `Prepare ${checkedRows.length} message(s)`}
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              {bulkMode === 'reply'
                ? 'AI uses each candidate’s latest Zoho response. Review every draft before sending.'
                : 'The selected template is filled with each candidate’s details. Review before sending.'}
            </span>
          </div>

          {bulkPrepared.length ? (
            <div style={{ marginTop: 16 }}>
              <h4 style={{ margin: '0 0 8px' }}>Review {bulkPrepared.length} prepared message(s)</h4>
              <div style={{ display: 'grid', gap: 10 }}>
                {bulkPrepared.map((item) => (
                  <details key={item.applicant_id} className="panel" style={{ padding: 12 }}>
                    <summary style={{ cursor: 'pointer' }}>
                      <strong>{item.name || item.email}</strong> <span className="muted">({item.email}) — {item.subject}</span>
                    </summary>
                    <iframe
                      title={`Message preview for ${item.name || item.email}`}
                      sandbox="" srcDoc={item.html}
                      style={{ width: '100%', minHeight: 240, marginTop: 10, background: '#fff', border: '1px solid var(--line)', borderRadius: 8 }}
                    />
                  </details>
                ))}
              </div>

              <div className="toolbar" style={{ marginTop: 12 }}>
                <button
                  className={dryRun ? 'primary' : 'danger'}
                  disabled={busy !== null || !sendEnabled || sendingBroken}
                  title={sendingBroken ? 'Dry run is off but email sending is not configured' : !sendEnabled ? 'Sending is switched off in Settings' : undefined}
                  onClick={() => setConfirmBulkSend(true)}
                >
                  {dryRun ? `Log ${bulkPrepared.length} dry-run message(s)` : `Send ${bulkPrepared.length} message(s)`}
                </button>
                <button className="ghost sm" disabled={busy !== null} onClick={() => { setBulkPrepared([]); setConfirmBulkSend(false); }}>
                  Discard drafts
                </button>
                {!sendEnabled ? <span className="muted" style={{ fontSize: 12 }}>Turn on Sending in Settings to continue.</span> : null}
                {sendingBroken ? <span className="muted" style={{ fontSize: 12 }}>Configure Zoho mail credentials for live sending.</span> : null}
              </div>
            </div>
          ) : null}

          {confirmBulkSend && bulkPrepared.length ? (
            <div className="banner warn" style={{ marginTop: 12 }}>
              <span>!</span>
              <div style={{ flex: 1 }}>
                <strong>
                  {dryRun
                    ? `Log ${bulkPrepared.length} message(s) as a dry run? They will not be delivered.`
                    : `Send these ${bulkPrepared.length} personalized message(s) now?`}
                </strong>
                <div className="hint" style={{ marginTop: 6 }}>
                  {bulkPrepared.map((item) => item.email).join(', ')}
                </div>
                <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                  <button className={dryRun ? 'primary' : 'danger'} disabled={busy !== null} onClick={sendBulkMessages}>
                    {busy === 'bulk-message-send' ? 'Sending…' : dryRun ? 'Confirm dry run' : 'Confirm and send'}
                  </button>
                  <button disabled={busy !== null} onClick={() => setConfirmBulkSend(false)}>Cancel</button>
                </div>
              </div>
            </div>
          ) : null}
        </section>
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
                      type="checkbox" className="inbox-item-check" checked={checked.has(a.applicant_id)} disabled={busy !== null}
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

            <div className="panel" style={{ marginTop: 14 }} aria-live="polite">
              <div className="toolbar" style={{ marginBottom: 10 }}>
                <div>
                  <h2 style={{ margin: 0 }}>Zoho conversations</h2>
                  <div className="muted" style={{ fontSize: 12 }}>Loaded live for this candidate; message bodies are not saved to Sheets.</div>
                </div>
                <span className="spacer" />
                <button className="sm" disabled={mailLoading} onClick={() => void loadCandidateMessages(selected.applicant_id)}>
                  {mailLoading ? 'Loading…' : 'Refresh mail'}
                </button>
              </div>

              {mailLoading ? (
                <div className="empty" role="status">Loading Zoho messages… The first request after the service wakes may take a little longer.</div>
              ) : null}
              {mailError ? <div className="banner danger"><span>⚠</span><div>{mailError}</div></div> : null}
              {!mailLoading && !mailError && mailThreads.length === 0 ? (
                <div className="empty">No Zoho messages found for this email address.</div>
              ) : null}

              {mailThreads.length ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 0.8fr) minmax(0, 1.6fr)', gap: 12 }}>
                  <div className="inbox-list" style={{ maxHeight: 360, overflowY: 'auto' }}>
                    {mailThreads.map((thread) => (
                      <button
                        type="button" key={thread.id}
                        className={`inbox-item-body${thread.id === activeThreadId ? ' active' : ''}`}
                        style={{ width: '100%', textAlign: 'left', padding: 10 }}
                        onClick={() => void loadThread(thread.id)}
                      >
                        <strong>{thread.subject}</strong>
                        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                          {thread.messages.length} message(s) · {shortDate(messageDate(thread.latest.sentDateInGMT || thread.latest.receivedTime))}
                        </div>
                        <div className="inbox-item-snippet muted">{thread.latest.summary || thread.latest.fromAddress}</div>
                      </button>
                    ))}
                  </div>

                  <div>
                    {!activeThreadId ? <div className="inbox-empty-pane empty">Select a conversation to load its full messages.</div> : null}
                    {threadLoading ? <div className="inbox-empty-pane empty" role="status">Loading full conversation from Zoho…</div> : null}
                    {threadError ? <div className="banner danger"><span>⚠</span><div>{threadError}</div></div> : null}
                    {!threadLoading && !threadError && threadMessages.length === 0 && activeThreadId ? (
                      <div className="inbox-empty-pane empty">Zoho returned no messages for this conversation. Refresh the mail list and try again.</div>
                    ) : null}
                    {!threadLoading && threadMessages.map((message) => (
                      <article key={message.messageId} className="bubble" style={{ marginBottom: 10, overflow: 'hidden' }}>
                        <div className="bubble-meta">
                          <strong>{message.fromAddress || 'Unknown sender'}</strong>
                          <span className="muted">→ {message.toAddress || 'recipient'}</span>
                          <span className="spacer" />
                          <span className="muted">{shortDate(messageDate(message.sentDateInGMT || message.receivedTime))}</span>
                        </div>
                        <div className="bubble-subject">{message.subject}</div>
                        {message.contentError ? (
                          <div className="banner warn" role="status"><span>!</span><div>Message details could not be loaded: {message.contentError}</div></div>
                        ) : null}
                        <iframe
                          title={`Email from ${message.fromAddress || 'unknown sender'}`}
                          sandbox=""
                          referrerPolicy="no-referrer"
                          style={{ width: '100%', minHeight: 180, height: 260, border: 0, background: 'white', borderRadius: 8 }}
                          srcDoc={`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${message.content || (message.contentError ? '<p>(Message body unavailable.)</p>' : '<p>(No message body returned.)</p>')}</body></html>`}
                        />
                      </article>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            {/* Retained applicant draft/sent snapshot; full mailbox history above is live from Zoho. */}
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

              <fieldset style={{ border: 0, padding: 0, margin: '0 0 16px' }}>
                <legend className="muted" style={{ marginBottom: 6, fontSize: 13 }}>Message type</legend>
                <div className="toolbar" role="group" aria-label="Choose whether to send a new email or reply">
                  <button
                    type="button" className={composeMode === 'new' ? 'primary sm' : 'sm'}
                    aria-pressed={composeMode === 'new'} disabled={busy !== null}
                    onClick={() => setComposeMode('new')}
                  >New email</button>
                  <button
                    type="button" className={composeMode === 'reply' ? 'primary sm' : 'sm'}
                    aria-pressed={composeMode === 'reply'} disabled={busy !== null || !canReply}
                    title={canReply ? `Reply to ${replyTarget?.fromAddress}` : 'Open a conversation with a response from this candidate first'}
                    onClick={() => setComposeMode('reply')}
                  >Reply to response</button>
                </div>
                {composeMode === 'reply' && replyTarget ? (
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    Replying to “{replyTarget.subject}” from {replyTarget.fromAddress}.
                  </div>
                ) : composeMode === 'reply' ? (
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    Open a conversation containing a response from this candidate to enable replies.
                  </div>
                ) : null}
              </fieldset>

              <label style={{ display: 'block', marginBottom: 12 }}>
                <div className="muted" style={{ marginBottom: 4 }}>
                  {composeMode === 'reply' ? 'Guidance for your reply (optional)' : 'What should this email say?'}
                </div>
                <textarea
                  rows={3} value={compose.instructions}
                  onChange={(e) => setCompose((c) => ({ ...c, instructions: e.target.value }))}
                  placeholder={composeMode === 'reply'
                    ? 'Optional: add guidance for the response. Leave blank to draft a reply based on the candidate’s email.'
                    : `e.g. invite ${selected.name?.split(' ')[0] || 'them'} to a 30-minute intro call next week, mention it is remote, ask for two time slots`}
                />
              </label>

              <label style={{ display: 'block', marginBottom: 12 }}>
                <div className="muted" style={{ marginBottom: 4 }}>Base it on a template (optional)</div>
                <select style={{ width: '100%' }} value={compose.templateId} onChange={(e) => setCompose((c) => ({ ...c, templateId: e.target.value }))}>
                  <option value="">{composeMode === 'reply' ? 'No template — respond to the candidate’s email' : 'No template — write from the instructions alone'}</option>
                  {activeTemplates.map((t) => (
                    <option key={t.template_id} value={t.template_id}>{t.name}{t.job_role ? ` — ${t.job_role}` : ''}</option>
                  ))}
                </select>
              </label>

              <div className="toolbar">
                <button
                  className="primary" disabled={busy !== null || !canWriteWithAI} onClick={writeWithAI}
                  title={canWriteWithAI ? undefined : composeMode === 'reply'
                    ? 'Load the candidate’s email body to enable AI replies'
                    : 'Type what the email should say, or pick a template'}
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
                  disabled={!canSendReply || busy !== null || (composeMode === 'reply' && !canReply)} onClick={send}
                  title={!sendEnabled ? 'Sending is switched off in Settings' : undefined}
                >
                  {busy === 'send-reply' ? 'Sending…' : composeMode === 'reply' ? (willSendForReal ? 'Send reply for real' : 'Send reply') : (willSendForReal ? 'Send new email for real' : 'Send new email')}
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
