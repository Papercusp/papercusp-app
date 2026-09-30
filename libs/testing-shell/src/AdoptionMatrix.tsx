'use client';
/**
 * <AdoptionMatrixPanel> — testing-spec adoption matrix: one row per package,
 * columns for each spec primitive (TESTING.md, unit/integration/property
 * tests, benches, Storybook, visual baselines, defineVitestConfig usage).
 *
 * Promoted verbatim out of Restart's
 * apps/web/components/dashboards/AdoptionMatrix into @papercusp/testing-shell
 * (testing-shell-cross-project) so any <TestingShell> host can surface an
 * "Adoption" tab. The lib names no endpoint or project concept: the host
 * injects the data via `load(signal)` and bumps `reloadKey` to re-scan (e.g.
 * when a project switcher changes). `load` is read through a ref so a new
 * inline callback identity each render does NOT trigger a refetch — only a
 * `reloadKey` change does (mirrors the original's `[project.id]` dependency).
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';

const alpha = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;

export interface AdoptionPackageStatus {
  workspace: string;
  name: string;
  hasTestingMd: boolean;
  hasUnitTestScript: boolean;
  hasIntegrationTestScript: boolean;
  hasVitestConfig: boolean;
  usesDefineVitestConfig: boolean;
  unitTestFiles: number;
  integrationTestFiles: number;
  benchFiles: number;
  propertyTestFiles: number;
  hasStorybook: boolean;
  hasLostPixelConfig: boolean;
  baselineCount: number;
  storyFiles: number;
}

export interface AdoptionMatrix {
  project: string;
  scannedAt: number;
  scanRoot: string;
  packages: AdoptionPackageStatus[];
  totals: {
    packages: number;
    withTestingMd: number;
    withUnitTests: number;
    withIntegrationTests: number;
    withStorybook: number;
    withVisualRegression: number;
    totalBaselines: number;
  };
}

export interface AdoptionMatrixPanelProps {
  /**
   * Fetch the matrix. The passed `signal` aborts when the panel unmounts or
   * `reloadKey` changes — wire it into `fetch(..., { signal })`.
   */
  load: (signal: AbortSignal) => Promise<AdoptionMatrix>;
  /** Re-run `load` whenever this changes (e.g. the selected project id). */
  reloadKey?: string;
}

const yes = (b: boolean, value?: number | string) =>
  b ? <span style={{ color: 'var(--good)' }}>{value !== undefined ? value : '✓'}</span>
    : <span style={{ color: 'var(--fg-mute)' }}>—</span>;

const num = (n: number) =>
  n > 0 ? <span style={{ color: 'var(--good)' }}>{n}</span>
        : <span style={{ color: 'var(--fg-mute)' }}>0</span>;

export default function AdoptionMatrixPanel({ load, reloadKey }: AdoptionMatrixPanelProps): ReactElement {
  const [data, setData] = useState<AdoptionMatrix | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Read `load` through a ref so the effect depends only on `reloadKey` — a
  // new inline callback identity each render must not retrigger the scan.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    setData(null);
    setError(null);
    const ac = new AbortController();
    loadRef.current(ac.signal)
      .then((d) => { if (!ac.signal.aborted) setData(d); })
      .catch((e) => { if (!ac.signal.aborted) setError(e?.message ?? String(e)); });
    return () => ac.abort();
  }, [reloadKey]);

  if (error) return <div style={{ background: alpha('var(--bad)', 20), border: '1px solid var(--bad)', padding: 12, borderRadius: 4, color: 'var(--bad)' }}>Scan failed: {error}</div>;
  if (!data) return <div style={{ color: 'var(--fg-dim)' }}>scanning…</div>;

  const { totals, packages } = data;

  return (
    <>
      {/* Top totals */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 12, marginBottom: 24 }}>
        <Stat label="Packages" value={totals.packages} />
        <Stat label="TESTING.md" value={`${totals.withTestingMd}/${totals.packages}`} pct={totals.withTestingMd / totals.packages} />
        <Stat label="Unit tests" value={`${totals.withUnitTests}/${totals.packages}`} pct={totals.withUnitTests / totals.packages} />
        <Stat label="Integration" value={`${totals.withIntegrationTests}/${totals.packages}`} pct={totals.withIntegrationTests / totals.packages} />
        <Stat label="Storybook" value={`${totals.withStorybook}/${totals.packages}`} pct={totals.withStorybook / totals.packages} />
        <Stat label="Visual reg" value={`${totals.withVisualRegression}/${totals.packages}`} pct={totals.withVisualRegression / totals.packages} />
        <Stat label="Baselines" value={totals.totalBaselines} />
      </section>

      <p style={{ fontSize: 12, color: 'var(--fg-mute)', marginBottom: 8 }}>
        Scanning <code>{data.scanRoot}</code>. Click any package name to copy its workspace path.
      </p>

      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={{ ...thStyle, textAlign: 'left' }}>Package</th>
            <th style={thStyle} title="TESTING.md present">📄</th>
            <th style={thStyle} title="Unit test files (excludes integration + property)">unit</th>
            <th style={thStyle} title="*.integration.test.ts files">integ</th>
            <th style={thStyle} title="*.property.test.ts (fast-check)">prop</th>
            <th style={thStyle} title="*.bench.ts (Vitest bench)">bench</th>
            <th style={thStyle} title="vitest.config.ts present">cfg</th>
            <th style={thStyle} title="Uses defineVitestConfig from @papercusp/test-config">DVC</th>
            <th style={thStyle} title="Storybook configured (.storybook/)">SB</th>
            <th style={thStyle} title="*.stories.tsx files">stories</th>
            <th style={thStyle} title="Lost Pixel config + baseline count">visual</th>
          </tr>
        </thead>
        <tbody>
          {packages.map((p) => (
            <tr key={p.workspace} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={tdLeftStyle}>
                <div style={{ fontWeight: 500 }}>{p.name}</div>
                <code style={{ fontSize: 10, color: 'var(--fg-mute)' }}>{p.workspace}</code>
              </td>
              <td style={tdStyle}>{yes(p.hasTestingMd)}</td>
              <td style={tdStyle}>{num(p.unitTestFiles)}</td>
              <td style={tdStyle}>{num(p.integrationTestFiles)}</td>
              <td style={tdStyle}>{num(p.propertyTestFiles)}</td>
              <td style={tdStyle}>{num(p.benchFiles)}</td>
              <td style={tdStyle}>{yes(p.hasVitestConfig)}</td>
              <td style={tdStyle}>{p.hasVitestConfig ? yes(p.usesDefineVitestConfig) : <span style={{ color: 'var(--fg-mute)' }}>—</span>}</td>
              <td style={tdStyle}>{yes(p.hasStorybook)}</td>
              <td style={tdStyle}>{num(p.storyFiles)}</td>
              <td style={tdStyle}>{p.hasLostPixelConfig ? num(p.baselineCount) : <span style={{ color: 'var(--fg-mute)' }}>—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Stat({ label, value, pct }: { label: string; value: number | string; pct?: number }) {
  const color = pct === undefined ? 'var(--fg-dim)'
              : pct >= 0.8 ? 'var(--good)'
              : pct >= 0.4 ? 'var(--warn)'
              : 'var(--bad)';
  return (
    <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 4, padding: 10 }}>
      <div style={{ fontSize: 10, color: 'var(--fg-mute)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4, color }}>{value}</div>
    </div>
  );
}

const tableStyle: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse',
  background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 4,
  fontSize: 12, color: 'var(--fg-dim)',
};
const thStyle: React.CSSProperties = {
  padding: '8px 8px', textAlign: 'center',
  borderBottom: '1px solid var(--border)', color: 'var(--fg-dim)', fontWeight: 500,
  fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5,
  whiteSpace: 'nowrap',
};
const tdStyle: React.CSSProperties = {
  padding: '6px 8px', textAlign: 'center', fontVariantNumeric: 'tabular-nums',
};
const tdLeftStyle: React.CSSProperties = {
  padding: '6px 8px', textAlign: 'left',
};
