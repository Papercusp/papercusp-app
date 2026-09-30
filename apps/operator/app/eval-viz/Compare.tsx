'use client';
/**
 * Compare — a per-task A/B score-delta table with inline delta bars
 * (impartial-benchmark-suite-2026-06-15 P-021 / BRIEF 10).
 *
 * Lifted + generalized from the gym dashboard's `compare` tab (the original
 * task/A/B/Δ table). Two consumers:
 *   • the Evaluation surface's "Report" subtab — `papercusp` (treatment) vs each
 *     baseline A/B/C, per task, so the system-value delta (D-001) reads per
 *     instance with a headline mean-Δ + win/tie/loss line;
 *   • the gym `compare` tab, which now renders this shared component.
 *
 * Δ = treatment − baseline: positive (green) = the treatment won that row.
 * Purely presentational — the caller owns data fetch, the arm/variant pickers,
 * and the loading/error/unavailable states. `baseline`/`treatment` are arm ids
 * from the locked vocab (`arms.ts`); unknown ids fall back to the raw string.
 *
 * Idiom mirrors BenchmarkTrend / Frontier: an exported pure core
 * (`summarizeDeltas`) for tests + self-carried `pc-compare__*` styles.
 */
import { useMemo, type HTMLAttributes } from 'react';
import { VirtualGrid, type ColumnDef } from '@papercusp/grid-core';
import { armLabel } from './arms';

export interface ComparePerTaskRow {
  /** Row label — a task / instance id. */
  label: string;
  /** Baseline-arm score; null when that arm has no scored run for this row. */
  baseline: number | null;
  /** Treatment-arm score; null when that arm has no scored run for this row. */
  treatment: number | null;
}

export interface CompareSummary {
  /** Rows where BOTH scores are present (the comparable set). */
  n: number;
  meanBaseline: number | null;
  meanTreatment: number | null;
  meanDelta: number | null;
  wins: number; // treatment > baseline
  losses: number; // treatment < baseline
  ties: number; // equal
}

export interface CompareProps {
  /** Baseline arm id (column header via armLabel). */
  baseline: string;
  /** Treatment arm id (column header via armLabel). */
  treatment: string;
  perTask: ComparePerTaskRow[];
  format?: (n: number | null | undefined) => string;
  caption?: string;
  /** Render the mean-Δ + win/tie/loss footer (default true). */
  summary?: boolean;
  emptyHint?: string;
}

const fmt = (n: number | null | undefined): string =>
  n == null ? '—' : (Math.round(n * 100) / 100).toString();

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/**
 * Per-arm means + win/tie/loss over the COMPARABLE rows (both scores present).
 * Δ = treatment − baseline. Exported for tests.
 */
export function summarizeDeltas(rows: readonly ComparePerTaskRow[]): CompareSummary {
  const both = rows.filter(
    (r): r is ComparePerTaskRow & { baseline: number; treatment: number } =>
      r.baseline != null && r.treatment != null,
  );
  let wins = 0, losses = 0, ties = 0;
  for (const r of both) {
    if (r.treatment > r.baseline) wins++;
    else if (r.treatment < r.baseline) losses++;
    else ties++;
  }
  const meanBaseline = mean(both.map((r) => r.baseline));
  const meanTreatment = mean(both.map((r) => r.treatment));
  return {
    n: both.length,
    meanBaseline,
    meanTreatment,
    meanDelta: meanBaseline != null && meanTreatment != null ? meanTreatment - meanBaseline : null,
    wins,
    losses,
    ties,
  };
}

function deltaOf(r: ComparePerTaskRow): number | null {
  return r.baseline != null && r.treatment != null ? r.treatment - r.baseline : null;
}

function deltaClass(d: number | null): string {
  if (d == null || d === 0) return 'pc-compare__delta';
  return d > 0 ? 'pc-compare__delta pc-compare__delta--up' : 'pc-compare__delta pc-compare__delta--down';
}

function deltaText(d: number | null, format: (n: number | null | undefined) => string): string {
  if (d == null) return '—';
  return `${d > 0 ? '▲ ' : d < 0 ? '▼ ' : ''}${format(d)}`;
}

export function Compare({
  baseline,
  treatment,
  perTask,
  format = fmt,
  caption,
  summary = true,
  emptyHint = 'No rows to compare.',
}: CompareProps) {
  const sum = useMemo(() => summarizeDeltas(perTask), [perTask]);
  const maxAbs = useMemo(
    () => Math.max(1e-9, ...perTask.map((r) => Math.abs(deltaOf(r) ?? 0))),
    [perTask],
  );
  const baseHdr = armLabel(baseline);
  const treatHdr = armLabel(treatment);
  const columns = useMemo<ColumnDef<ComparePerTaskRow>[]>(() => [
    {
      key: 'task',
      header: 'task',
      width: 2,
      toCopyText: (r) => r.label,
      render: ({ row }) => <span className="pc-compare__task" title={row.label}>{row.label}</span>,
    },
    {
      key: 'baseline',
      header: baseHdr,
      width: 1,
      toCopyText: (r) => format(r.baseline),
      render: ({ row }) => <span className="pc-compare__num">{format(row.baseline)}</span>,
    },
    {
      key: 'treatment',
      header: treatHdr,
      width: 1,
      toCopyText: (r) => format(r.treatment),
      render: ({ row }) => <span className="pc-compare__num">{format(row.treatment)}</span>,
    },
    {
      key: 'delta',
      header: 'Δ',
      width: 1,
      toCopyText: (r) => deltaText(deltaOf(r), format),
      render: ({ row }) => {
        const d = deltaOf(row);
        return <span className={`pc-compare__num ${deltaClass(d)}`}>{deltaText(d, format)}</span>;
      },
    },
    {
      key: 'bar',
      header: '',
      width: '110px',
      render: ({ row }) => {
        const d = deltaOf(row);
        const w = d == null ? 0 : (Math.abs(d) / maxAbs) * 100;
        return (
          <span className="pc-compare__barcell">
            <span
              className={d != null && d < 0 ? 'pc-compare__bar pc-compare__bar--down' : 'pc-compare__bar pc-compare__bar--up'}
              style={{ width: `${w}%` }}
              aria-hidden="true"
            />
          </span>
        );
      },
    },
  ], [baseHdr, format, maxAbs, treatHdr]);

  return (
    <figure className="pc-compare" aria-label={caption ?? `Score delta of ${treatHdr} versus ${baseHdr} across ${perTask.length} tasks`}>
      {caption && <figcaption className="pc-compare__caption">{caption}</figcaption>}
      {perTask.length === 0 ? (
        <div className="pc-compare__empty" data-testid="compare-empty">{emptyHint}</div>
      ) : (
        <>
          <div style={{ height: Math.min(620, 32 + perTask.length * 30 + 4) }}>
            <VirtualGrid<ComparePerTaskRow>
              columns={columns}
              rows={perTask}
              getRowId={(r) => r.label}
              rowMinHeight={30}
              headerHeight={32}
              estimateRowHeight={30}
              // `data-*` is a valid row attribute (RichGrid spreads it onto the row
              // root) but isn't a typed member of HTMLAttributes — cast so tsc accepts it.
              rowProps={() => ({ 'data-testid': 'compare-row' }) as HTMLAttributes<HTMLDivElement>}
            />
          </div>
          {summary && (
            <div className="pc-compare__summary" data-testid="compare-summary">
              <span>mean ({sum.n})</span>
              <span className="pc-compare__num">{format(sum.meanBaseline)}</span>
              <span className="pc-compare__num">{format(sum.meanTreatment)}</span>
              <span className={`pc-compare__num ${deltaClass(sum.meanDelta)}`}>{deltaText(sum.meanDelta, format)}</span>
              <span className="pc-compare__wl">
                <span className="pc-compare__delta--up">{sum.wins}W</span>·{sum.ties}T·<span className="pc-compare__delta--down">{sum.losses}L</span>
              </span>
            </div>
          )}
        </>
      )}
      <CompareStyles />
    </figure>
  );
}

function CompareStyles() {
  return (
    <style>{`
      .pc-compare { margin: 0; padding: 0; }
      .pc-compare__caption { margin: 0 0 6px; font-size: 11px; font-weight: 650; color: var(--fg-mute, #7f9bb4); }
      .pc-compare__num { display: block; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .pc-compare__task { display: block; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pc-compare__delta--up { color: var(--good, #34d399); }
      .pc-compare__delta--down { color: var(--bad, #fb7185); }
      .pc-compare__barcell { display: block; width: 90px; padding-right: 8px; }
      .pc-compare__bar { display: block; height: 6px; border-radius: 3px; min-width: 1px; }
      .pc-compare__bar--up { background: var(--good, #34d399); }
      .pc-compare__bar--down { background: var(--bad, #fb7185); }
      .pc-compare__empty { padding: 12px 8px; color: var(--fg-mute, #7f9bb4); opacity: 0.8; }
      .pc-compare__summary { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr 110px; gap: 0; padding: 6px 0; border-top: 2px solid var(--border-strong, rgba(125, 211, 252, 0.3)); font-size: 12px; font-weight: 650; color: var(--fg, #e7f7ff); }
      .pc-compare__summary > span { padding: 0 8px; }
      .pc-compare__wl { font-size: 11px; color: var(--fg-mute, #7f9bb4); }
    `}</style>
  );
}
