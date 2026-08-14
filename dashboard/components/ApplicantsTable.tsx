'use client';
import { useMemo, useState } from 'react';
import type { Row } from '../lib/contract';
import { ACTIONABLE } from '../lib/contract';
import { StagePill, IntentPill } from './Pills';
import { shortDate } from '../lib/format';
import { useAction, ResultBanner } from './useAction';

/**
 * The main working surface: filter, select, act.
 *
 * Two rules drive the design:
 *   - A row that failed is red with its reason inline. Debugging must never
 *     require opening n8n.
 *   - Sending names every recipient in a confirmation before it happens. There
 *     is no path from one click to "email everyone".
 */
export function ApplicantsTable({ rows, roles, dryRun, sendEnabled }: {
  rows: Row[];
  roles: string[];
  dryRun: boolean;
  sendEnabled: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [stage, setStage] = useState('');
  const [role, setRole] = useState('');
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<Row | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);
  const { run, busy, result, clear } = useAction();

  const filtered = useMemo(() => rows.filter((r) => {
    if (stage && r.stage !== stage) return false;
    if (role && r.job_role !== role) return false;
    if (query) {
      const q = query.toLowerCase();
      if (![r.name, r.email, r.applicant_id, r.job_role].some((f) => String(f ?? '').toLowerCase().includes(q))) return false;
    }
    return true;
  }), [rows, stage, role, query]);

  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.applicant_id)), [rows, selected]);

  const canDraft = selectedRows.length > 0 && selectedRows.every((r) => ACTIONABLE.draft.includes(r.stage as never));
  const canApprove = selectedRows.length > 0 && selectedRows.every((r) => r.stage === 'DRAFTED');
  const canSend = selectedRows.length > 0 && selectedRows.every((r) => r.stage === 'APPROVED');

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const allShownSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.applicant_id));
  const toggleAll = () => setSelected(allShownSelected ? new Set() : new Set(filtered.map((r) => r.applicant_id)));

  async function act(action: string, payload: Record<string, unknown> = {}) {
    const res = await run(action, { ids: [...selected], ...payload });
    if (res.ok) setSelected(new Set());
    setConfirmSend(false);
  }

  return (
    <>
      <ResultBanner result={result} onClose={clear} />

      <div className="toolbar">
        <select value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="">All stages</option>
          {['NEW', 'DRAFTED', 'APPROVED', 'SENT', 'REPLIED', 'CLOSED', 'FAILED'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">All roles</option>
          {roles.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <input type="search" placeholder="Search name, email, id…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ minWidth: 220 }} />
        <span className="spacer" />
        <span className="muted">{filtered.length} of {rows.length} shown{selected.size ? ` · ${selected.size} selected` : ''}</span>
      </div>

      <div className="toolbar">
        <button className="primary" disabled={!canDraft || busy !== null} onClick={() => act('draft')}>
          {busy === 'draft' ? 'Generating…' : `Generate drafts${selected.size ? ` (${selected.size})` : ''}`}
        </button>
        <button disabled={!canApprove || busy !== null} onClick={() => act('approve')}>
          Approve{selected.size ? ` (${selected.size})` : ''}
        </button>
        <button disabled={selectedRows.length === 0 || !selectedRows.every((r) => r.stage === 'APPROVED') || busy !== null} onClick={() => act('unapprove')}>
          Unapprove
        </button>
        <button
          className={dryRun ? '' : 'danger'}
          disabled={!canSend || busy !== null || !sendEnabled}
          onClick={() => setConfirmSend(true)}
          title={!sendEnabled ? 'Sending is switched off in Settings' : undefined}
        >
          {dryRun ? 'Dry-run send' : 'Send'}{selected.size ? ` (${selected.size})` : ''}
        </button>
        <span className="spacer" />
        {selected.size ? <button className="ghost sm" onClick={() => setSelected(new Set())}>Clear selection</button> : null}
      </div>

      {!sendEnabled ? (
        <div className="banner info">
          <span>i</span>
          <div>Sending is <strong>off</strong>. Turn on <em>Sending (WF-03)</em> in Settings when you are ready.</div>
        </div>
      ) : null}

      {confirmSend ? (
        <div className="banner warn">
          <span>!</span>
          <div style={{ flex: 1 }}>
            <strong>
              {dryRun
                ? `Dry run: log ${selectedRows.length} email(s) without sending?`
                : `Really email ${selectedRows.length} candidate(s)? This cannot be undone.`}
            </strong>
            <div className="hint" style={{ marginTop: 6 }}>
              {selectedRows.slice(0, 12).map((r) => r.email).join(', ')}
              {selectedRows.length > 12 ? ` … and ${selectedRows.length - 12} more` : ''}
            </div>
            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
              <button className={dryRun ? 'primary' : 'danger'} onClick={() => act('send')} disabled={busy !== null}>
                {busy === 'send' ? 'Sending…' : dryRun ? 'Run dry send' : `Yes, send ${selectedRows.length}`}
              </button>
              <button onClick={() => setConfirmSend(false)}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input type="checkbox" checked={allShownSelected} onChange={toggleAll} aria-label="Select all shown" />
              </th>
              <th>Candidate</th>
              <th>Role</th>
              <th>Stage</th>
              <th>Reply</th>
              <th>Draft</th>
              <th>Updated</th>
              <th>Problem</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const failed = r.status === 'failed' || r.stage === 'FAILED';
              const blocked = r.status === 'blocked';
              return (
                <tr key={r.applicant_id || r._row} className={[failed ? 'row-failed' : '', blocked ? 'row-blocked' : '', selected.has(r.applicant_id) ? 'selected' : ''].filter(Boolean).join(' ')}>
                  <td>
                    <input
                      type="checkbox" checked={selected.has(r.applicant_id)}
                      disabled={!r.applicant_id}
                      onChange={() => toggle(r.applicant_id)}
                      aria-label={`Select ${r.name}`}
                    />
                  </td>
                  <td>
                    <div style={{ fontWeight: 550 }}>{r.name || <span className="muted">(no name)</span>}</div>
                    <div className="muted mono">{r.email}</div>
                  </td>
                  <td>
                    {r.job_role}
                    {r.category ? <div className="muted">{r.category}</div> : null}
                  </td>
                  <td><StagePill stage={r.stage} /></td>
                  <td><IntentPill intent={r.reply_state} /></td>
                  <td>
                    {r.email_html
                      ? <button className="ghost sm" onClick={() => setPreview(r)}>Preview</button>
                      : <span className="muted">—</span>}
                  </td>
                  <td className="muted">{shortDate(r.updated_at || r.created_at)}</td>
                  <td>
                    {r.error_code ? (
                      <div>
                        <span className="pill danger">{r.error_code}</span>
                        <div className="muted" style={{ marginTop: 3, maxWidth: 340 }}>{r.error_message}</div>
                      </div>
                    ) : <span className="muted">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 ? (
          <div className="empty">
            {rows.length === 0
              ? 'No applicants yet. Add rows to the Applicants tab (name, email, job_role) — WF-01 picks them up within 2 minutes.'
              : 'No applicants match these filters.'}
          </div>
        ) : null}
      </div>

      {preview ? (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="toolbar">
            <h2 style={{ margin: 0 }}>{preview.email_subject}</h2>
            <span className="spacer" />
            <button className="ghost sm" onClick={() => setPreview(null)}>Close</button>
          </div>
          <p className="sub">To {preview.name} &lt;{preview.email}&gt; · template {preview.template_id || '—'}</p>
          {/* The draft is rendered as HTML because that is exactly what the
              candidate receives; previewing anything else would defeat review. */}
          <div className="preview" dangerouslySetInnerHTML={{ __html: preview.email_html }} />
        </div>
      ) : null}
    </>
  );
}
