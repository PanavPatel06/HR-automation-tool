'use client';
import { useMemo, useState } from 'react';
import type { Row } from '../lib/contract';
import { isTruthy } from '../lib/contract';
import { CategoryPill } from './Pills';
import { timeAgo } from '../lib/format';
import { useAction, ResultBanner } from './useAction';

const PLACEHOLDER_RE = /\{\{\s*[a-zA-Z0-9_.]+\s*\}\}/;
const MAX_ATTACHMENTS_BYTES = 15 * 1024 * 1024;

type Attachment = { filename: string; mimeType: string; base64: string; size: number };
type Compose = { templateId: string; subject: string; html: string; instructions: string; attachments: Attachment[] };
const EMPTY_COMPOSE: Compose = { templateId: '', subject: '', html: '', instructions: '', attachments: [] };

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
 * The whole app: the people in the Applicants tab on the left, and the message
 * you are about to send them on the right.
 *
 * Two ways to write. Pick one person and the composer gives you a brief box —
 * say what the email should cover and the model writes it, pulling their name,
 * role, category and notes out of their sheet row. Or tick several people and
 * send one template, merged separately for each of them.
 *
 * There is no pipeline and no approval step, because there is nothing to
 * approve: whatever is in the box is what goes, and you are looking at it.
 * Sending is still blocked while a literal {{field}} is visible.
 */
export function MailView({ applicants, templates, roles, mailerConfigured, dryRun, sendEnabled, aiEnabled }: {
  applicants: Row[];
  templates: Row[];
  roles: string[];
  mailerConfigured: boolean;
  dryRun: boolean;
  sendEnabled: boolean;
  aiEnabled: boolean;
}) {
  const { run, busy, result, clear } = useAction();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  const [compose, setCompose] = useState<Compose>(EMPTY_COMPOSE);
  const [bulkTemplateId, setBulkTemplateId] = useState('');
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newContact, setNewContact] = useState({ name: '', email: '', role: '', category: '', notes: '' });

  const activeTemplates = useMemo(() => templates.filter((t) => isTruthy(t.is_active)), [templates]);

  const list = useMemo(() => applicants
    .filter((a) => a.applicant_id)
    .filter((a) => !role || a.job_role === role)
    .filter((a) => {
      if (!query) return true;
      const q = query.toLowerCase();
      return [a.name, a.email, a.job_role, a.category, a.notes].some((f) => String(f ?? '').toLowerCase().includes(q));
    })
    .sort((a, b) => (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || '')),
    [applicants, role, query]);

  const selected = useMemo(() => applicants.find((a) => a.applicant_id === selectedId) ?? null, [applicants, selectedId]);
  const checkedRows = useMemo(() => applicants.filter((a) => checked.has(a.applicant_id)), [applicants, checked]);

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
    clear();
  }

  async function addApplicant() {
    const res = await run('add-applicant', {
      name: newContact.name.trim(), email: newContact.email.trim(),
      job_role: newContact.role.trim(), category: newContact.category.trim(), notes: newContact.notes.trim(),
    });
    if (res.ok && res.result?.applicant_id) {
      select(res.result.applicant_id);
      setNewContact({ name: '', email: '', role: '', category: '', notes: '' });
      setShowNew(false);
    }
  }

  async function composeWith(action: 'compose-template' | 'compose-ai') {
    if (!selected) return;
    const res = await run(action, {
      applicant_id: selected.applicant_id, template_id: compose.templateId, instructions: compose.instructions,
    });
    if (res.ok && res.result) setCompose((c) => ({ ...c, subject: res.result?.subject ?? c.subject, html: res.result?.html ?? c.html }));
  }

  async function sendOne() {
    if (!selected) return;
    const res = await run('send', {
      applicant_id: selected.applicant_id, subject: compose.subject, html: compose.html,
      attachments: compose.attachments.map(({ filename, mimeType, base64 }) => ({ filename, mimeType, base64 })),
    });
    if (res.ok) setCompose(EMPTY_COMPOSE);
  }

  async function sendBulk() {
    const res = await run('send', { ids: [...checked], template_id: bulkTemplateId });
    if (res.ok) { setChecked(new Set()); setBulkTemplateId(''); }
    setConfirmBulk(false);
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
  const canSendAtAll = sendEnabled && !sendingBroken;
  const canSendOne = Boolean(compose.subject.trim() && compose.html.trim() && !hasPlaceholder && canSendAtAll);
  // The model needs something to go on: a brief, or a template to rework.
  const canWriteWithAI = aiEnabled && Boolean(compose.instructions.trim() || compose.templateId);
  const sendBlockedReason = sendingBroken
    ? 'Dry run is off but email sending is not configured — sending is refused'
    : !sendEnabled ? 'Sending is switched off in Settings' : undefined;

  return (
    <>
      <ResultBanner result={result} onClose={clear} />

      {checked.size ? (
        <div className="panel" style={{ marginBottom: 14 }}>
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <strong>{checked.size} selected</strong>
            <span className="muted" style={{ fontSize: 12 }}>Send one template to all of them, merged with each person&apos;s own row.</span>
            <span className="spacer" />
            <select value={bulkTemplateId} onChange={(e) => setBulkTemplateId(e.target.value)} style={{ minWidth: 220 }}>
              <option value="">Pick a template…</option>
              {activeTemplates.map((t) => (
                <option key={t.template_id} value={t.template_id}>{t.name}{t.job_role ? ` — ${t.job_role}` : ''}</option>
              ))}
            </select>
            <button
              className={willSendForReal ? 'danger' : 'primary'}
              disabled={!bulkTemplateId || busy !== null || !canSendAtAll}
              onClick={() => setConfirmBulk(true)}
              title={sendBlockedReason}
            >
              {dryRun ? `Dry-run send to ${checked.size}` : `Send to ${checked.size}`}
            </button>
            <button className="ghost sm" onClick={() => { setChecked(new Set()); setConfirmBulk(false); }}>Clear</button>
          </div>

          {confirmBulk ? (
            <div className="banner warn" style={{ marginTop: 12 }}>
              <span>!</span>
              <div style={{ flex: 1 }}>
                <strong>
                  {dryRun ? `Dry run: log ${checkedRows.length} email(s) without sending?` : `Really email ${checkedRows.length} candidate(s)? This cannot be undone.`}
                </strong>
                <div className="hint" style={{ marginTop: 6 }}>
                  {checkedRows.slice(0, 12).map((r) => r.email).join(', ')}{checkedRows.length > 12 ? ` … and ${checkedRows.length - 12} more` : ''}
                </div>
                <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                  <button className={dryRun ? 'primary' : 'danger'} onClick={sendBulk} disabled={busy !== null}>
                    {busy === 'send' ? 'Sending…' : dryRun ? 'Run dry send' : `Yes, send ${checkedRows.length}`}
                  </button>
                  <button onClick={() => setConfirmBulk(false)}>Cancel</button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="inbox-layout">
        <div className="inbox-list-wrap">
          <div className="toolbar">
            <input type="search" placeholder="Search name, email, role, notes…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ minWidth: 0, flex: 1 }} />
            <button type="button" className="ghost sm" onClick={() => setShowNew((v) => !v)}>
              {showNew ? 'Cancel' : '+ New'}
            </button>
          </div>

          {showNew ? (
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
                  <div className="muted" style={{ marginBottom: 4, fontSize: 12 }}>Role</div>
                  <input type="text" list="role-suggestions" style={{ width: '100%' }} value={newContact.role} onChange={(e) => setNewContact((c) => ({ ...c, role: e.target.value }))} />
                </label>
                <label>
                  <div className="muted" style={{ marginBottom: 4, fontSize: 12 }}>Category</div>
                  <input type="text" style={{ width: '100%' }} value={newContact.category} onChange={(e) => setNewContact((c) => ({ ...c, category: e.target.value }))} />
                </label>
              </div>
              <label style={{ display: 'block', marginBottom: 8 }}>
                <div className="muted" style={{ marginBottom: 4, fontSize: 12 }}>Notes (given to the AI as context)</div>
                <input type="text" style={{ width: '100%' }} value={newContact.notes} onChange={(e) => setNewContact((c) => ({ ...c, notes: e.target.value }))} placeholder="e.g. referred by Meera, strong React portfolio" />
              </label>
              <button className="primary sm" disabled={!newContact.email.trim() || busy !== null} onClick={addApplicant}>
                {busy === 'add-applicant' ? 'Adding…' : 'Add candidate'}
              </button>
            </div>
          ) : null}
          <datalist id="role-suggestions">
            {roles.map((r) => <option key={r} value={r} />)}
          </datalist>

          <div className="toolbar" style={{ marginBottom: 8 }}>
            <select value={role} onChange={(e) => setRole(e.target.value)} style={{ flex: 1 }}>
              <option value="">All roles</option>
              {roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>

          <div className="inbox-list">
            {list.map((a) => (
              <div key={a.applicant_id} className={`inbox-item${a.applicant_id === selectedId ? ' active' : ''}`}>
                <input
                  type="checkbox" className="inbox-item-check" checked={checked.has(a.applicant_id)}
                  onChange={() => toggleChecked(a.applicant_id)} aria-label={`Select ${a.name || a.email}`}
                />
                <button type="button" className="inbox-item-body" onClick={() => select(a.applicant_id)}>
                  <div className="inbox-item-top">
                    <span className="inbox-item-name">{a.name || '(no name)'}</span>
                    <span className="muted" style={{ fontSize: 11, flex: 'none' }}>
                      {a.last_sent_at ? timeAgo(a.last_sent_at) : ''}
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    {a.job_role} <CategoryPill category={a.category} />
                  </div>
                  <div className="inbox-item-snippet muted">
                    {a.last_subject || a.notes || 'Not written to yet.'}
                  </div>
                </button>
              </div>
            ))}
            {list.length === 0 ? <div className="empty">No candidates match.</div> : null}
          </div>
        </div>

        {!selected ? (
          <div className="panel inbox-empty-pane">
            <div className="empty">Pick someone on the left to write to them, or tick several to send one template to all of them.</div>
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
                <CategoryPill category={selected.category} />
              </div>
              <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                {selected.job_role || 'No role'} · <span className="mono">{selected.applicant_id}</span>
                {selected.last_sent_at ? <> · last written to {timeAgo(selected.last_sent_at)}</> : null}
              </div>
              {selected.notes ? (
                <div className="muted" style={{ fontSize: 13, marginTop: 8, fontStyle: 'italic' }}>{selected.notes}</div>
              ) : null}
            </div>

            <div className="panel">
              <h2>Write to {selected.name?.split(' ')[0] || 'this candidate'}</h2>
              <p className="sub">
                Say what the email should cover — their name{selected.job_role ? `, the ${selected.job_role} role` : ''}
                {selected.notes ? ', your notes on them' : ''} and the branding are filled in from the sheet.
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
                <div className="muted" style={{ marginBottom: 4 }}>Template (optional)</div>
                <select style={{ width: '100%' }} value={compose.templateId} onChange={(e) => setCompose((c) => ({ ...c, templateId: e.target.value }))}>
                  <option value="">None — write from the brief alone</option>
                  {activeTemplates.map((t) => (
                    <option key={t.template_id} value={t.template_id}>{t.name}{t.job_role ? ` — ${t.job_role}` : ''}</option>
                  ))}
                </select>
              </label>

              <div className="toolbar">
                <button
                  className="primary" disabled={busy !== null || !canWriteWithAI} onClick={() => composeWith('compose-ai')}
                  title={!aiEnabled ? 'AI writing is switched off in Settings' : canWriteWithAI ? undefined : 'Type what the email should say, or pick a template'}
                >
                  {busy === 'compose-ai' ? 'Writing…' : '✨ Write with AI'}
                </button>
                <button
                  disabled={busy !== null || !compose.templateId} onClick={() => composeWith('compose-template')}
                  title={compose.templateId ? 'Fill the template in as-is — no model call' : 'Pick a template first'}
                >
                  {busy === 'compose-template' ? 'Loading…' : 'Use template as-is'}
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
                  disabled={!canSendOne || busy !== null} onClick={sendOne}
                  title={sendBlockedReason}
                >
                  {busy === 'send' ? 'Sending…' : willSendForReal ? 'Send for real' : 'Send'}
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
