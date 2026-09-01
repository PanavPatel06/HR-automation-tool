'use client';
import type { Row } from '../lib/contract';
import { TOGGLES } from '../lib/contract';
import { useAction, ResultBanner } from './useAction';

/**
 * One switch per thing that costs money or reaches a person.
 *
 * The switches write to the Config tab; the actions in
 * app/api/action/route.ts check their own toggle first and refuse to run when
 * it is off. A toggle takes effect immediately without redeploying anything,
 * and it works even if this dashboard is down — HR can flip the cell in the
 * sheet directly.
 */
export function SettingsPanel({ config }: { config: Row[] }) {
  const { run, busy, result, clear } = useAction();
  const byKey = Object.fromEntries(config.map((r) => [r.key, r]));

  const isOn = (key: string) => ['true', 'yes', '1', 'on'].includes(String(byKey[key]?.value ?? '').toLowerCase());

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
              : 'Anything you send reaches a real candidate.'}
          </span>
        </div>
        <button
          className={dryRun ? 'danger' : 'primary'}
          disabled={busy !== null}
          onClick={() => {
            const next = dryRun ? 'false' : 'true';
            if (dryRun && !confirm('Turn OFF dry run? Messages will then be emailed to real candidates.')) return;
            run('set-config', { key: 'dry_run', value: next });
          }}
        >
          {dryRun ? 'Go live' : 'Back to dry run'}
        </button>
      </div>

      <div className="panel">
        <h2>Master switches</h2>
        <p className="sub">Each switch writes to the Config tab and takes effect on the next click.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Function</th><th>What it does</th><th style={{ width: 110 }}>State</th></tr></thead>
            <tbody>
              {TOGGLES.map((t) => {
                const on = isOn(t.key);
                return (
                  <tr key={t.key}>
                    <td style={{ fontWeight: 550 }}>{t.label}</td>
                    <td className="muted" style={{ maxWidth: 380 }}>{t.description}</td>
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
