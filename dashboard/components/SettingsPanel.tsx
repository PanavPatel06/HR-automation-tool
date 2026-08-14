'use client';
import type { Row } from '../lib/contract';
import { TOGGLES } from '../lib/contract';
import { useAction, ResultBanner } from './useAction';
import { timeAgo } from '../lib/format';

type RunSummary = { workflow: string; finished_at: string; status: string; notes: string };

/**
 * The function toggles from the project goal: one switch per automation, each
 * showing whether it is on and when it last did anything.
 *
 * The switches write to the Config tab; every workflow reads its own toggle as
 * its first step and no-ops when it is off. That means a toggle takes effect
 * immediately without redeploying anything, and it works even if this dashboard
 * is down — HR can flip the cell in the sheet.
 */
export function SettingsPanel({ config, runs }: { config: Row[]; runs: RunSummary[] }) {
  const { run, busy, result, clear } = useAction();
  const byKey = Object.fromEntries(config.map((r) => [r.key, r]));

  const isOn = (key: string) => ['true', 'yes', '1', 'on'].includes(String(byKey[key]?.value ?? '').toLowerCase());
  const lastRun = (workflow: string) => runs
    .filter((r) => r.workflow.startsWith(workflow))
    .sort((a, b) => b.finished_at.localeCompare(a.finished_at))[0];

  const dryRun = isOn('dry_run');

  const settable = config.filter((r) => !TOGGLES.some((t) => t.key === r.key) && r.key !== 'dry_run');

  return (
    <>
      <ResultBanner result={result} onClose={clear} />

      <div className={`banner ${dryRun ? 'info' : 'warn'}`}>
        <span>{dryRun ? 'i' : '!'}</span>
        <div style={{ flex: 1 }}>
          <strong>Dry run is {dryRun ? 'ON' : 'OFF'}.</strong>{' '}
          <span className="hint">
            {dryRun
              ? 'Sends are recorded in EmailLog but no email leaves the building. Keep this on until a full dry run looks right.'
              : 'Approved drafts will reach real candidates.'}
          </span>
        </div>
        <button
          className={dryRun ? 'danger' : 'primary'}
          disabled={busy !== null}
          onClick={() => {
            const next = dryRun ? 'false' : 'true';
            if (dryRun && !confirm('Turn OFF dry run? Approved drafts will then be emailed to real candidates.')) return;
            run('set-config', { key: 'dry_run', value: next });
          }}
        >
          {dryRun ? 'Go live' : 'Back to dry run'}
        </button>
      </div>

      <div className="panel">
        <h2>Automations</h2>
        <p className="sub">
          Each switch writes to the Config tab. Workflows check their own toggle first and stop
          immediately when it is off — so turning something off takes effect on the next run,
          with no redeploy.
        </p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Function</th><th>Workflow</th><th>What it does</th><th>Last run</th><th style={{ width: 110 }}>State</th></tr></thead>
            <tbody>
              {TOGGLES.map((t) => {
                const on = isOn(t.key);
                const last = lastRun(t.workflow);
                return (
                  <tr key={t.key}>
                    <td style={{ fontWeight: 550 }}>{t.label}</td>
                    <td className="mono muted">{t.workflow}</td>
                    <td className="muted" style={{ maxWidth: 380 }}>{t.description}</td>
                    <td className="muted">
                      {last ? (
                        <>
                          {timeAgo(last.finished_at)}
                          <div><span className={`pill ${last.status === 'ok' ? 'ok' : last.status === 'failed' ? 'danger' : ''}`}>{last.status}</span></div>
                        </>
                      ) : <span className="muted">never</span>}
                    </td>
                    <td>
                      <button
                        className={on ? '' : 'primary'}
                        disabled={busy !== null}
                        onClick={() => run('set-config', { key: t.key, value: on ? 'false' : 'true' })}
                      >
                        {on ? 'On' : 'Off'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>Other settings</h2>
        <p className="sub">Edit these in the Config tab of the spreadsheet. Shown here so you can see what is in effect.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Key</th><th>Value</th><th>Type</th><th>What it controls</th></tr></thead>
            <tbody>
              {settable.map((r) => (
                <tr key={r.key}>
                  <td className="mono">{r.key}</td>
                  <td className="mono truncate">{r.value}</td>
                  <td className="muted">{r.type}</td>
                  <td className="muted" style={{ maxWidth: 420 }}>{r.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
