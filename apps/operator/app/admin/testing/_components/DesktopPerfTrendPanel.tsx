'use client';

/**
 * Desktop-perf trend panel (desktop-performance-suite-2026-07-20 P-010).
 *
 * Renders the last-N persisted desktop-performance runs (GET
 * /api/admin/testing/desktop-perf-trend) as a run strip + the latest run's
 * per-measure table with deltas vs the previous run — so a regression is
 * visible across runs, not just within one. Shown on the Test Runs tab when
 * the Desktop performance suite is selected; refetches when `refreshSignal`
 * changes (a run just finished).
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  DesktopPerfMeasureDelta,
  DesktopPerfTrendPoint,
} from '@papercusp/operator-core/lib/admin-test-suites-shared';
import { Button } from '../../../harness/Button';
import { Table } from '../../../harness/Table';

export function formatMeasureValue(value: number, unit: DesktopPerfMeasureDelta['unit']): string {
  if (unit === 'kb') return `${Math.round(value / 1024)}MB`;
  if (unit === 'count') return `${value}`;
  return `${Math.round(value)}ms`;
}

/** Signed delta string with a direction arrow; empty when there is no prior run. */
export function formatDelta(m: DesktopPerfMeasureDelta): string {
  if (m.deltaValue === null) return '—';
  if (m.deltaValue === 0) return '±0';
  const arrow = m.deltaValue > 0 ? '▲' : '▼';
  const mag = formatMeasureValue(Math.abs(m.deltaValue), m.unit);
  const pct = m.deltaPct === null ? '' : ` (${m.deltaValue > 0 ? '+' : '−'}${Math.abs(Math.round(m.deltaPct * 100))}%)`;
  return `${arrow} ${mag}${pct}`;
}

/** A regression = a budgeted measure that got slower/larger vs the prior run. */
export function isRegression(m: DesktopPerfMeasureDelta): boolean {
  return m.deltaValue !== null && m.deltaValue > 0 && m.budget !== null;
}

export default function DesktopPerfTrendPanel({ refreshSignal = 0 }: { refreshSignal?: number }) {
  const [trend, setTrend] = useState<DesktopPerfTrendPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/testing/desktop-perf-trend?limit=20', { cache: 'no-store' });
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
      const payload = (await res.json()) as { trend: DesktopPerfTrendPoint[] };
      setTrend(payload.trend ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  const latest = trend?.[0] ?? null;

  return (
    <div className="pc-test-card" data-testid="desktop-perf-trend">
      <div className="pc-test-card-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="pc-test-card-title" style={{ margin: 0 }}>Desktop-perf trend</h2>
        <Button variant="ghost" onClick={() => void load()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {error ? <div className="pc-test-card is-bad" style={{ padding: 12, marginTop: 8 }}>Error: {error}</div> : null}

      {trend && trend.length === 0 ? (
        <div className="pc-test-loading" style={{ marginTop: 8 }}>
          No desktop-performance runs recorded yet. Run the <strong>Desktop performance snapshot</strong> suite to capture a baseline.
        </div>
      ) : null}

      {trend && trend.length > 0 ? (
        <>
          <div className="pc-test-card-row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {trend.map((run) => (
              <span
                key={run.id}
                className={`pc-test-badge ${run.status === 'fail' ? 'is-poor' : run.status === 'warn' ? 'is-needs' : 'is-good'}`}
                title={`${run.source}${run.gitSha ? ` · ${run.gitSha.slice(0, 8)}` : ''}`}
              >
                {new Date(run.createdTs).toLocaleTimeString()} · {run.status}
              </span>
            ))}
          </div>

          {latest ? (
            <Table<DesktopPerfMeasureDelta>
              className="pc-test-perf-trend-table"
              style={{ marginTop: 12, fontSize: 13 }}
              rows={latest.measures}
              getRowKey={(m) => m.key}
              rowTestId={(m) => `perf-measure-${m.key}`}
              rowClassName={(m) => (isRegression(m) ? 'is-regression' : undefined)}
              columns={[
                { key: 'metric', header: 'Metric', render: (m) => <code>{m.key}</code> },
                {
                  key: 'latest',
                  header: 'Latest',
                  render: (m) => (
                    <span className={`pc-test-badge ${m.ok ? 'is-good' : 'is-poor'}`}>{formatMeasureValue(m.value, m.unit)}</span>
                  ),
                },
                {
                  key: 'budget',
                  header: 'Budget',
                  cellStyle: { color: 'var(--fg-mute)' },
                  render: (m) => (m.budget === null ? '—' : formatMeasureValue(m.budget, m.unit)),
                },
                {
                  key: 'delta',
                  header: 'Δ vs prev',
                  render: (m) => (
                    <span style={{ color: isRegression(m) ? 'var(--bad)' : 'var(--fg-mute)' }}>{formatDelta(m)}</span>
                  ),
                },
              ]}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
