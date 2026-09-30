'use client';
/**
 * Runs tab — the per-plan run-history + performance breakdown
 * (scheduled-recurring-plans-2026-06-16 P-024/P-025). Three altitudes:
 *   1. glance     — a last-N outcome health strip,
 *   2. rollup     — the summary header (success rate / median duration / cost / regression),
 *   3. drill-down — a run table → RunDetailPanel (reused) on ?run=<id>.
 * Plus duration + cost trend sparklines (P-025; result_summary domain-metric series is a
 * follow-on once listPlanRuns surfaces result_summary). Reads the plans.runHistory sync query
 * (enriched rows + server-computed rollup). nuqs ?run= drives the drill-down.
 */
import { useMemo } from 'react';
import { parseAsInteger, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import RunDetailPanel from './RunDetailPanel';
import type { TriggerRunVisibility } from './plans-api';

interface RunRow {
  id: number;
  runSeq: number | null;
  status: string;
  runType: string;
  trigger: string | null;
  outcome: string | null;
  durationMs: number | null;
  launchedAt: number;
  costUsd: number;
  workItems: { total: number; passed: number; failed: number; open: number };
  resultSummary: Record<string, unknown> | null;
  instancePlanSlug?: string | null;
  triggerRun?: TriggerRunVisibility | null;
}
interface Rollup {
  total: number;
  success: number;
  partial: number;
  failed: number;
  running: number;
  successRate: number;
  avgDurationMs: number | null;
  medianDurationMs: number | null;
  totalCostUsd: number;
  lastOutcome: string | null;
  regression: { lastFailed: boolean; slowRunIds: number[] };
}

interface Props {
  slug: string;
  planTitle?: string | null;
  currentContentHash?: string;
}

const OUTCOME_COLOR: Record<string, string> = {
  success: 'var(--good, #34d399)',
  failed: 'var(--bad, #fb7185)',
  partial: 'var(--warn, #fbbf24)',
};
function outcomeColor(o: string | null, status: string): string {
  if (status === 'running') return 'var(--accent, #38bdf8)';
  return (o && OUTCOME_COLOR[o]) || 'var(--fg-mute, #7f9bb4)';
}
function fmtDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
function fmtWhen(value: number | string): string {
  return new Date(value).toLocaleString();
}

const runColumns: ColumnDef<RunRow>[] = [
  {
    key: 'seq',
    header: '#',
    width: 0.55,
    toCopyText: (r) => String(r.runSeq ?? r.id),
    render: ({ row }) => <span style={{ color: 'var(--fg-dim, #b9d4e8)' }}>{row.runSeq ?? row.id}</span>,
  },
  {
    key: 'outcome',
    header: 'Outcome',
    width: 1.1,
    toCopyText: (r) => r.status === 'running' ? 'running' : r.outcome ?? '—',
    render: ({ row }) => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: outcomeColor(row.outcome, row.status), display: 'inline-block' }} />
        {row.status === 'running' ? 'running' : row.outcome ?? '—'}
      </span>
    ),
  },
  {
    key: 'cause',
    header: 'Cause',
    width: 1.9,
    toCopyText: (r) => r.triggerRun?.causeSummary ?? r.trigger ?? r.runType,
    render: ({ row }) => (
      <span
        aria-label={row.triggerRun ? `${row.triggerRun.causeSummary}; ${row.triggerRun.eventPattern}` : undefined}
        style={{ color: 'var(--fg-dim, #b9d4e8)' }}
      >
        {row.triggerRun?.causeSummary ?? row.trigger ?? row.runType}
      </span>
    ),
  },
  {
    key: 'policy',
    header: 'Policy',
    width: 1.35,
    toCopyText: (r) => r.triggerRun?.policyDetail ?? '—',
    render: ({ row }) => (
      <span
        data-trigger-disposition={row.triggerRun?.policyDisposition}
        style={{ color: row.triggerRun?.policyDisposition === 'failed' ? 'var(--bad, #fb7185)' : row.triggerRun?.policyDisposition === 'dropped' ? 'var(--warn, #fbbf24)' : 'var(--fg-dim, #b9d4e8)' }}
      >
        {row.triggerRun?.policyDetail ?? '—'}
      </span>
    ),
  },
  {
    key: 'instance',
    header: 'Plan instance',
    width: 1.7,
    toCopyText: (r) => r.triggerRun?.planRun?.instancePlanSlug ?? r.instancePlanSlug ?? '—',
    render: ({ row }) => {
      const run = row.triggerRun?.planRun;
      const slug = run?.instancePlanSlug ?? row.instancePlanSlug;
      if (!slug) return <span style={{ color: 'var(--fg-mute, #7f9bb4)' }}>—</span>;
      const progress = run?.workItems.total
        ? `${run.workItems.passed}/${run.workItems.total}`
        : null;
      const agents = run?.agents.length ? `${run.agents.length} agent${run.agents.length === 1 ? '' : 's'}` : null;
      return (
        <a
          href={`/admin/plans?plan=${encodeURIComponent(slug)}`}
          onClick={(event) => event.stopPropagation()}
        >
          {slug}
          {run ? <small style={{ display: 'block', color: 'var(--fg-mute, #7f9bb4)' }}>{[run.status, progress, agents].filter(Boolean).join(' · ')}</small> : null}
        </a>
      );
    },
  },
  {
    key: 'duration',
    header: 'Duration',
    width: 0.9,
    toCopyText: (r) => fmtDuration(r.durationMs),
    render: ({ row }) => <span style={{ color: 'var(--fg-dim, #b9d4e8)' }}>{fmtDuration(row.durationMs)}</span>,
  },
  {
    key: 'workItems',
    header: 'Work items',
    width: 0.9,
    toCopyText: (r) => r.workItems.total > 0 ? `${r.workItems.passed}/${r.workItems.total}` : '—',
    render: ({ row }) => <span style={{ color: 'var(--fg-dim, #b9d4e8)' }}>{row.workItems.total > 0 ? `${row.workItems.passed}/${row.workItems.total}` : '—'}</span>,
  },
  {
    key: 'cost',
    header: 'Cost',
    width: 0.75,
    toCopyText: (r) => r.costUsd > 0 ? `$${r.costUsd.toFixed(2)}` : '—',
    render: ({ row }) => <span style={{ color: 'var(--fg-dim, #b9d4e8)' }}>{row.costUsd > 0 ? `$${row.costUsd.toFixed(2)}` : '—'}</span>,
  },
  {
    key: 'when',
    header: 'When',
    width: 1.7,
    toCopyText: (r) => fmtWhen(r.triggerRun?.triggeredAt ?? r.launchedAt),
    render: ({ row }) => <span style={{ color: 'var(--fg-mute, #7f9bb4)' }}>{fmtWhen(row.triggerRun?.triggeredAt ?? row.launchedAt)}</span>,
  },
];

/** Dependency-free inline sparkline over a numeric series (P-025). Themed to tokens. */
function Sparkline({ values, color, width = 160, height = 28 }: { values: number[]; color: string; width?: number; height?: number }) {
  if (values.length < 2) return <span style={{ color: 'var(--fg-mute, #7f9bb4)', fontSize: 11 }}>—</span>;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height} role="img" aria-label="trend" style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

export default function RunsPanel({ slug, planTitle, currentContentHash }: Props) {
  const [, setRun] = useQueryState('run', parseAsInteger);
  const { data, loading } = useSyncQuery<{ runs: RunRow[]; rollup: Rollup | null }>({
    queryName: 'plans.runHistory',
    args: { planSlug: slug },
  });
  const payload = data?.[0] ?? { runs: [], rollup: null };
  const runs = payload.runs ?? [];
  const rollup = payload.rollup;

  // Chronological (oldest→newest) for trend sparklines; runs arrive newest-first.
  const chrono = useMemo(() => [...runs].reverse(), [runs]);
  const durationSeries = useMemo(() => chrono.map((r) => r.durationMs ?? 0), [chrono]);
  const costSeries = useMemo(() => chrono.map((r) => r.costUsd ?? 0), [chrono]);
  // P-025: domain-metric series from each run's result_summary (numeric top-level keys).
  const metricSeries = useMemo(() => {
    const keys = new Set<string>();
    for (const r of chrono) {
      if (r.resultSummary) for (const [k, v] of Object.entries(r.resultSummary)) if (typeof v === 'number' && Number.isFinite(v)) keys.add(k);
    }
    return [...keys].sort().map((key) => {
      const values = chrono.map((r) => {
        const v = r.resultSummary?.[key];
        return typeof v === 'number' && Number.isFinite(v) ? v : 0;
      });
      let last: number | null = null;
      for (let i = chrono.length - 1; i >= 0; i--) {
        const v = chrono[i].resultSummary?.[key];
        if (typeof v === 'number' && Number.isFinite(v)) { last = v; break; }
      }
      return { key, values, last };
    });
  }, [chrono]);
  // Health strip: last 24 outcomes, newest on the right.
  const strip = useMemo(() => [...runs].slice(0, 24).reverse(), [runs]);

  if (!loading && runs.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-mute, #7f9bb4)', fontSize: 12 }}>
        No runs yet for <strong>{planTitle ?? slug}</strong>. Scheduled runs appear here once the plan is armed and fires
        (or after <code>plans:run-now</code>).
      </div>
    );
  }

  return (
    <div className="pc-plans__runs" style={{ padding: '8px 4px', color: 'var(--fg, #e7f7ff)' }}>
      {/* Glance — health strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: 'var(--fg-mute, #7f9bb4)', marginRight: 4 }}>Last {strip.length}:</span>
        {strip.map((r) => (
          <span
            key={r.id}
            role="img"
            aria-label={`#${r.runSeq ?? r.id} · ${r.outcome ?? r.status} · ${fmtDuration(r.durationMs)}`}
            style={{ width: 10, height: 10, borderRadius: 2, background: outcomeColor(r.outcome, r.status), display: 'inline-block' }}
          />
        ))}
        {loading && <span style={{ fontSize: 11, color: 'var(--fg-mute, #7f9bb4)' }}>loading…</span>}
      </div>

      {/* Rollup — summary header */}
      {rollup && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
            gap: 10,
            marginBottom: 14,
            padding: 10,
            border: '1px solid var(--border, rgba(125,211,252,0.15))',
            borderRadius: 8,
            background: 'var(--bg-1, #0b1220)',
          }}
        >
          <Stat label="Runs" value={`${rollup.total}`} sub={rollup.running ? `${rollup.running} running` : undefined} />
          <Stat label="Success rate" value={`${Math.round(rollup.successRate * 100)}%`} sub={`${rollup.success}✓ ${rollup.partial}~ ${rollup.failed}✗`} />
          <Stat label="Median duration" value={fmtDuration(rollup.medianDurationMs)} />
          <Stat label="Total cost" value={`$${rollup.totalCostUsd.toFixed(2)}`} />
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-mute, #7f9bb4)' }}>Duration trend</div>
            <Sparkline values={durationSeries} color="var(--accent, #38bdf8)" />
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-mute, #7f9bb4)' }}>Cost trend</div>
            <Sparkline values={costSeries} color="var(--warn, #fbbf24)" />
          </div>
        </div>
      )}

      {/* P-025: domain-metric series a routine published via result_summary */}
      {metricSeries.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-mute, #7f9bb4)', marginBottom: 6 }}>Domain metrics (result_summary)</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            {metricSeries.map((m) => (
              <div key={m.key} style={{ padding: 8, border: '1px solid var(--border, rgba(125,211,252,0.15))', borderRadius: 6, background: 'var(--bg-1, #0b1220)' }}>
                <div style={{ fontSize: 11, color: 'var(--fg-dim, #b9d4e8)' }}>{m.key}</div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{m.last ?? '—'}</div>
                <Sparkline values={m.values} color="var(--good, #34d399)" width={150} height={24} />
              </div>
            ))}
          </div>
        </div>
      )}

      {rollup?.regression.lastFailed && (
        <div style={{ marginBottom: 12, padding: '6px 10px', borderRadius: 6, fontSize: 12, color: 'var(--bad, #fb7185)', background: 'color-mix(in oklab, var(--bad, #fb7185), transparent 88%)' }}>
          ⚠ The most recent run failed.{rollup.regression.slowRunIds.length ? ` ${rollup.regression.slowRunIds.length} run(s) ran &gt;2× the median duration.` : ''}
        </div>
      )}

      {/* Drill-down — run table */}
      <div style={{ height: Math.min(620, 32 + runs.length * 38 + 4) }}>
        <RichGrid<RunRow>
          columns={runColumns}
          rows={runs}
          getRowId={(r) => String(r.id)}
          rowMinHeight={38}
          headerHeight={32}
          onRowClick={(r) => void setRun(r.id)}
        />
      </div>

      {/* Drill-down panel — self-gates on ?run= */}
      <RunDetailPanel planSlug={slug} planTitle={planTitle ?? null} currentContentHash={currentContentHash} />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--fg-mute, #7f9bb4)' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--fg-mute, #7f9bb4)' }}>{sub}</div>}
    </div>
  );
}
