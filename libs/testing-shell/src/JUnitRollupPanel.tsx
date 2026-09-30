'use client';
/**
 * <JUnitRollupPanel> — shared CI/JUnit results view: per-file rollup + grand
 * totals + a failing-cases list (P-012 of testing-shell-cross-project).
 *
 * The shell had no "ingest CI output" view; this fills that gap for any host.
 * Lifted out of Restart's apps/web/app/tests/CiResultsPanel so both projects
 * render the identical rollup. The host parses its junit*.xml (the lib stays
 * fs/dep-free) and passes the normalized `cases`; this calls the pure
 * `aggregateJUnitCases` and renders. Styling uses the shared theme vars the
 * rest of the shell uses, so it themes correctly in both apps.
 */
import { type ReactElement, type ReactNode } from 'react';
import { aggregateJUnitCases, type JUnitCase } from './junit';

export interface JUnitRollupPanelProps {
  /** Normalized cases (host parsed its junit*.xml into the lib's JUnitCase shape). */
  cases: JUnitCase[];
  /** Scan root, shown in the header + empty-state hint. */
  scanRoot?: string;
  /** Max failing cases to list. Default 50. */
  maxFailing?: number;
  /** Optional content rendered below the tables (e.g. a host runnable section). */
  footer?: ReactNode;
}

function fmtDur(s: number): string {
  if (s < 1) return `${Math.round(s * 1000)}ms`;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
}

const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 13 };
const thStyle: React.CSSProperties = { padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid var(--border)', color: 'var(--fg-dim)', fontWeight: 500, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 };
const tdStyle: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid var(--border)' };

function Stat({ label, value, color }: { label: string; value: number | string; color: string }): ReactElement {
  return (
    <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 4, padding: 12 }}>
      <div style={{ fontSize: 11, color: 'var(--fg-mute)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, marginTop: 4, color }}>{value}</div>
    </div>
  );
}

export default function JUnitRollupPanel({ cases, scanRoot, maxFailing = 50, footer }: JUnitRollupPanelProps): ReactElement {
  const agg = aggregateJUnitCases(cases);
  const t = agg.totals;
  const failed = cases.filter((c) => c.status === 'failed' || c.status === 'errored').slice(0, maxFailing);

  return (
    <div style={{ padding: 24, overflow: 'auto', height: '100%', color: 'var(--fg)', fontFamily: 'system-ui, sans-serif' }}>
      <p style={{ margin: '0 0 16px', color: 'var(--fg-dim)', fontSize: 13 }}>
        Rolled up from <code>junit*.xml</code>{scanRoot ? <> under <code>{scanRoot}</code></> : null}.
      </p>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 12, marginBottom: 24 }}>
        <Stat label="Files" value={t.files} color="var(--fg-dim)" />
        <Stat label="Cases" value={t.cases} color="var(--fg-dim)" />
        <Stat label="Passed" value={t.passed} color="var(--good)" />
        <Stat label="Failed" value={t.failed} color="var(--bad)" />
        <Stat label="Errored" value={t.errored} color="var(--warn)" />
        <Stat label="Skipped" value={t.skipped} color="var(--fg-dim)" />
        <Stat label="Total time" value={fmtDur(t.durationSec)} color="var(--fg-dim)" />
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 8px' }}>
          By file ({agg.files.length})
        </h2>
        {agg.files.length === 0 ? (
          <div style={{ background: 'var(--bg-2)', border: '1px dashed var(--border)', borderRadius: 4, padding: 24, color: 'var(--fg-dim)', fontSize: 13 }}>
            No <code>junit*.xml</code> found{scanRoot ? <> under <code>{scanRoot}</code></> : null}. Run a suite with
            {' '}<code>CI=true npm test</code> to emit JUnit output.
          </div>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>File</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Pass</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Fail</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Skip</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Err</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Total</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Duration</th>
              </tr>
            </thead>
            <tbody>
              {agg.files.map((f) => (
                <tr key={f.file}>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 500, color: f.failed > 0 || f.errored > 0 ? 'var(--bad)' : 'var(--good)' }}>{f.project}</div>
                    <div style={{ fontSize: 11, color: 'var(--fg-mute)' }}>{f.file}</div>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--good)' }}>{f.passed}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: f.failed > 0 ? 'var(--bad)' : 'var(--fg-mute)' }}>{f.failed}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--fg-dim)' }}>{f.skipped}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: f.errored > 0 ? 'var(--warn)' : 'var(--fg-mute)' }}>{f.errored}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{f.total}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--fg-dim)' }}>{fmtDur(f.durationSec)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {failed.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--bad)', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 8px' }}>
            Failing cases ({failed.length})
          </h2>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Workspace</th>
                <th style={thStyle}>Suite</th>
                <th style={thStyle}>Test</th>
                <th style={thStyle}>Failure</th>
              </tr>
            </thead>
            <tbody>
              {failed.map((c, i) => (
                <tr key={`${c.file}::${c.suite}::${c.test}::${i}`}>
                  <td style={{ ...tdStyle, color: 'var(--fg-dim)' }}>{c.project}</td>
                  <td style={tdStyle}>{c.suite}</td>
                  <td style={{ ...tdStyle, color: 'var(--bad)' }}>{c.test}</td>
                  <td style={{ ...tdStyle, color: 'var(--fg-dim)', maxWidth: 600, overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>{c.failure}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {footer}
    </div>
  );
}
