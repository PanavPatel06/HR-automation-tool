'use client';
import { useEffect, useState } from 'react';
import type { Row } from '../lib/contract';
import { isTruthy } from '../lib/contract';
import { useAction, ResultBanner } from './useAction';
import { shortDate } from '../lib/format';

const AI_FIELD = '{{ai_body}}';

/**
 * Templates are where HR keeps control of tone. Two things are made obvious
 * here because they are the two things that surprise people:
 *   - a template containing {{ai_body}} spends model quota; one without it
 *     costs nothing;
 *   - AI-generated templates arrive inactive and must be read before use.
 */
export function TemplateManager({ templates, roles }: { templates: Row[]; roles: string[] }) {
  const { run, busy, result, clear } = useAction();
  const [preview, setPreview] = useState<Row | null>(null);
  const [brief, setBrief] = useState({ purpose: 'initial outreach to a job applicant', tone: 'warm, professional, concise', job_role: '', notes: '' });
  const [attachment, setAttachment] = useState({ attachment_url: '', attachment_name: '' });

  useEffect(() => {
    if (preview) setAttachment({ attachment_url: preview.attachment_url || '', attachment_name: preview.attachment_name || '' });
  }, [preview]);

  return (
    <>
      <ResultBanner result={result} onClose={clear} />

      <div className="panel">
        <h2>Generate a template</h2>
        <p className="sub">
          Describe the email you want. The result is saved <strong>inactive</strong> — read it, then
          activate it. Nothing a model wrote can reach a candidate before you do.
        </p>
        <div className="grid cols-2">
          <label>
            <div className="muted" style={{ marginBottom: 4 }}>Purpose</div>
            <input type="text" style={{ width: '100%' }} value={brief.purpose} onChange={(e) => setBrief({ ...brief, purpose: e.target.value })} />
          </label>
          <label>
            <div className="muted" style={{ marginBottom: 4 }}>Tone</div>
            <input type="text" style={{ width: '100%' }} value={brief.tone} onChange={(e) => setBrief({ ...brief, tone: e.target.value })} />
          </label>
          <label>
            <div className="muted" style={{ marginBottom: 4 }}>Role (optional)</div>
            <select style={{ width: '100%' }} value={brief.job_role} onChange={(e) => setBrief({ ...brief, job_role: e.target.value })}>
              <option value="">Any role</option>
              {roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label>
            <div className="muted" style={{ marginBottom: 4 }}>Extra instructions (optional)</div>
            <input type="text" style={{ width: '100%' }} value={brief.notes} onChange={(e) => setBrief({ ...brief, notes: e.target.value })} placeholder="e.g. mention our 4-day week" />
          </label>
        </div>
        <div style={{ marginTop: 12 }}>
          <button className="primary" disabled={busy !== null} onClick={() => run('template-generate', brief)}>
            {busy === 'template-generate' ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th><th>Scope</th><th>Subject</th><th>AI</th><th>File</th><th>Source</th><th>Status</th><th>Updated</th><th></th>
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => {
              const active = isTruthy(t.is_active);
              const usesAi = (t.html + t.subject).includes(AI_FIELD);
              return (
                <tr key={t.template_id}>
                  <td>
                    <div style={{ fontWeight: 550 }}>{t.name}</div>
                    <div className="muted mono">{t.template_id}</div>
                  </td>
                  <td>
                    {t.job_role || <span className="muted">any role</span>}
                    {t.category ? <div className="muted">{t.category}</div> : null}
                    {isTruthy(t.is_default) ? <div><span className="pill">default</span></div> : null}
                  </td>
                  <td className="truncate">{t.subject}</td>
                  <td>
                    {t.attachment_url
                      ? <a className="pill info" href={t.attachment_url} target="_blank" rel="noreferrer" title={t.attachment_url}>{t.attachment_name || 'file'} 📎</a>
                      : <span className="muted">none</span>}
                  </td>
                  <td>
                    {usesAi
                      ? <span className="pill info" title="Contains {{ai_body}} — spends model quota per applicant">personalised</span>
                      : <span className="pill" title="No model call — costs nothing">static</span>}
                  </td>
                  <td><span className="pill">{t.source || 'manual'}</span></td>
                  <td>{active ? <span className="pill ok">active</span> : <span className="pill">inactive</span>}</td>
                  <td className="muted">{shortDate(t.updated_at)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="ghost sm" onClick={() => setPreview(t)}>Preview</button>
                    <button
                      className="sm" disabled={busy !== null}
                      onClick={() => run('set-template-active', { template_id: t.template_id, active: !active })}
                    >
                      {active ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {templates.length === 0 ? (
          <div className="empty">
            No templates yet. Generate one above, or add a row to the Templates tab with{' '}
            <code>is_active = TRUE</code> and <code>is_default = TRUE</code>.
          </div>
        ) : null}
      </div>

      {preview ? (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="toolbar">
            <h2 style={{ margin: 0 }}>{preview.name}</h2>
            <span className="spacer" />
            <button className="ghost sm" onClick={() => setPreview(null)}>Close</button>
          </div>
          <p className="sub mono">{preview.subject}</p>

          <div className="grid cols-2" style={{ marginBottom: 12 }}>
            <label>
              <div className="muted" style={{ marginBottom: 4 }}>Attachment URL (Drive link, shared &quot;anyone with the link&quot;)</div>
              <input
                type="text" style={{ width: '100%' }} placeholder="https://drive.google.com/file/d/…/view"
                value={attachment.attachment_url}
                onChange={(e) => setAttachment({ ...attachment, attachment_url: e.target.value })}
              />
            </label>
            <label>
              <div className="muted" style={{ marginBottom: 4 }}>Shown as (optional)</div>
              <input
                type="text" style={{ width: '100%' }} placeholder="benefits-overview.pdf"
                value={attachment.attachment_name}
                onChange={(e) => setAttachment({ ...attachment, attachment_name: e.target.value })}
              />
            </label>
          </div>
          <p className="sub">
            Fetched fresh and attached to every email sent with this template. No upload here —
            paste a public link (Drive, Dropbox, …); nothing over{' '}
            {/* keep in sync with MAX_ATTACHMENTS_BYTES in dashboard/lib/mailer.ts */}15MB will send.
          </p>
          <button
            className="sm" disabled={busy !== null}
            onClick={() => run('set-template-attachment', { template_id: preview.template_id, ...attachment })}
            style={{ marginBottom: 16 }}
          >
            {busy === 'set-template-attachment' ? 'Saving…' : 'Save attachment'}
          </button>

          <div className="preview" dangerouslySetInnerHTML={{ __html: preview.html }} />
          <details className="hint-details" style={{ marginTop: 10 }}>
            <summary>Raw HTML</summary>
            <textarea readOnly rows={12} value={preview.html} style={{ marginTop: 8 }} />
          </details>
        </div>
      ) : null}
    </>
  );
}
