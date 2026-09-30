'use client';
/**
 * Frontier — a dependency-free SVG cost/accuracy Pareto scatter
 * (impartial-benchmark-suite-2026-06-15 P-021 / BRIEF 10).
 *
 * The headline visual of the Evaluation surface's "External benchmarks" subtab
 * (D-007): one point per arm (Papercusp + Baseline A/B/C), X = cost (lower is
 * better), Y = accuracy / resolved (higher is better). The Pareto-optimal arms
 * — the set no other arm beats on BOTH cost and accuracy — are accented and
 * joined by the frontier line, so the plan's load-bearing claim ("we sit on a
 * strictly better cost/accuracy point, net of coordination overhead") reads at
 * a glance.
 *
 * Purely presentational: takes `points` and reads NO data itself — the
 * Evaluation scaffold (P-020) owns the @papercusp/sync read and feeds props,
 * keyed on the LOCKED arm vocab (`arms.ts`). Generic enough to plot any 2D
 * cost/score comparison (multiple points per arm — e.g. per-seed — are fine;
 * they just share the arm's color). This is NOT the gym's `frontier`, which is
 * an N-dimensional vector Pareto over train tasks (a list, not a 2D plane).
 *
 * Idiom mirrors BenchmarkTrend: exported pure cores (`paretoOptimal`,
 * `projectFrontier`) for tests, self-carried `pc-frontier__*` styles with
 * CSS-var fallbacks, aria-label + per-point <title> tooltips.
 */
import { useMemo } from 'react';
import { armColor, armLabel } from './arms';

export interface FrontierPoint {
  /** Display label (e.g. the arm's human name, or "papercusp · seed 2"). */
  label: string;
  /** X axis — lower is better (e.g. USD or tokens spent). */
  cost: number;
  /** Y axis — higher is better (e.g. resolved fraction / pass@1). */
  score: number;
  /** Arm id from the locked vocab — keys color/series (unknown → neutral). */
  arm: string;
}

export interface FrontierProps {
  points: FrontierPoint[];
  xLabel?: string;
  yLabel?: string;
  formatX?: (n: number) => string;
  formatY?: (n: number) => string;
  /** Ring every point of this arm (default: the treatment, 'papercusp'). */
  highlightArm?: string;
  width?: number;
  height?: number;
  caption?: string;
  emptyHint?: string;
}

interface PlottedPoint extends FrontierPoint {
  key: string;
  x: number;
  y: number;
  onFrontier: boolean;
}

const DEFAULT_W = 520;
const DEFAULT_H = 320;
const PAD = { top: 16, right: 96, bottom: 34, left: 52 };

const fmt2 = (n: number): string => (Math.round(n * 100) / 100).toString();
const keyOf = (p: FrontierPoint, i: number): string => `${p.arm}::${p.label}::${i}`;

/**
 * The 2D Pareto set: indices of points that no OTHER point beats on both axes
 * (lower cost AND higher score). P dominates Q iff P.cost ≤ Q.cost and
 * P.score ≥ Q.score with at least one strict; Q is then dominated. Identical
 * points don't dominate each other, so genuine ties both survive. Exported for
 * tests (returns the index set so duplicate labels/arms are unambiguous).
 */
export function paretoOptimal(points: readonly FrontierPoint[]): Set<number> {
  const keep = new Set<number>();
  points.forEach((p, i) => {
    const dominated = points.some(
      (q, j) =>
        j !== i &&
        q.cost <= p.cost &&
        q.score >= p.score &&
        (q.cost < p.cost || q.score > p.score),
    );
    if (!dominated) keep.add(i);
  });
  return keep;
}

/**
 * Project points into the plot box (scale-free, padded domains) + flag the
 * Pareto-optimal set. SVG y grows downward, so a higher score maps to a smaller
 * y. A degenerate (single value / all-equal) axis is centred rather than
 * dividing by zero. Exported for tests.
 */
export function projectFrontier(
  points: readonly FrontierPoint[],
  dims: { width?: number; height?: number } = {},
): { points: PlottedPoint[]; frontierPath: string } {
  const W = dims.width ?? DEFAULT_W;
  const H = dims.height ?? DEFAULT_H;
  if (points.length === 0) return { points: [], frontierPath: '' };

  const costs = points.map((p) => p.cost);
  const scores = points.map((p) => p.score);
  let xlo = Math.min(...costs);
  let xhi = Math.max(...costs);
  let ylo = Math.min(...scores);
  let yhi = Math.max(...scores);
  const xpad = (xhi - xlo) * 0.08 || Math.max(Math.abs(xhi) * 0.1, 1);
  const ypad = (yhi - ylo) * 0.08 || Math.max(Math.abs(yhi) * 0.1, 1);
  xlo -= xpad; xhi += xpad;
  ylo = Math.max(0, ylo - ypad); yhi += ypad; // scores non-negative; no unit ceiling
  const xspan = xhi - xlo || 1;
  const yspan = yhi - ylo || 1;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const optimal = paretoOptimal(points);

  const plotted: PlottedPoint[] = points.map((p, i) => ({
    ...p,
    key: keyOf(p, i),
    x: PAD.left + ((p.cost - xlo) / xspan) * plotW,
    y: PAD.top + (1 - (p.score - ylo) / yspan) * plotH,
    onFrontier: optimal.has(i),
  }));

  // Frontier line: optimal points left→right by cost (ties: higher score first).
  const frontier = plotted
    .filter((p) => p.onFrontier)
    .sort((a, b) => a.cost - b.cost || b.score - a.score);
  const frontierPath = frontier.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  return { points: plotted, frontierPath };
}

export function Frontier({
  points,
  xLabel = 'cost ($)',
  yLabel = 'resolved',
  formatX = fmt2,
  formatY = fmt2,
  highlightArm = 'papercusp',
  width = DEFAULT_W,
  height = DEFAULT_H,
  caption,
  emptyHint = 'No runs to compare yet.',
}: FrontierProps) {
  const { points: plotted, frontierPath } = useMemo(
    () => projectFrontier(points, { width, height }),
    [points, width, height],
  );

  if (plotted.length === 0) {
    return (
      <figure className="pc-frontier pc-frontier--empty" aria-label={emptyHint}>
        {caption && <figcaption className="pc-frontier__caption">{caption}</figcaption>}
        <div className="pc-frontier__empty" data-testid="frontier-empty">{emptyHint}</div>
        <FrontierStyles />
      </figure>
    );
  }

  const costs = points.map((p) => p.cost);
  const scores = points.map((p) => p.score);
  const nOptimal = plotted.filter((p) => p.onFrontier).length;

  return (
    <figure
      className="pc-frontier"
      aria-label={`Cost/accuracy Pareto scatter of ${plotted.length} points (${xLabel} ${formatX(Math.min(...costs))}–${formatX(Math.max(...costs))}, ${yLabel} ${formatY(Math.min(...scores))}–${formatY(Math.max(...scores))}); ${nOptimal} on the frontier`}
    >
      {caption && <figcaption className="pc-frontier__caption">{caption}</figcaption>}
      <svg viewBox={`0 0 ${width} ${height}`} role="img" preserveAspectRatio="xMidYMid meet">
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={height - PAD.bottom} className="pc-frontier__axisline" />
        <line x1={PAD.left} x2={width - PAD.right} y1={height - PAD.bottom} y2={height - PAD.bottom} className="pc-frontier__axisline" />
        <text x={PAD.left} y={height - PAD.bottom + 22} textAnchor="start" className="pc-frontier__axis">{formatX(Math.min(...costs))}</text>
        <text x={width - PAD.right} y={height - PAD.bottom + 22} textAnchor="end" className="pc-frontier__axis">{formatX(Math.max(...costs))}</text>
        <text x={(PAD.left + width - PAD.right) / 2} y={height - 6} textAnchor="middle" className="pc-frontier__axislabel">{xLabel} →</text>
        <text x={PAD.left - 8} y={PAD.top + 4} textAnchor="end" className="pc-frontier__axis">{formatY(Math.max(...scores))}</text>
        <text x={PAD.left - 8} y={height - PAD.bottom} textAnchor="end" className="pc-frontier__axis">{formatY(Math.min(...scores))}</text>
        <text transform={`translate(14 ${(PAD.top + height - PAD.bottom) / 2}) rotate(-90)`} textAnchor="middle" className="pc-frontier__axislabel">↑ {yLabel}</text>

        {frontierPath.includes(' ') && (
          <polyline className="pc-frontier__line" points={frontierPath} fill="none" />
        )}

        {plotted.map((p) => {
          const color = armColor(p.arm);
          return (
            <g key={p.key} data-testid="frontier-point" data-arm={p.arm} data-frontier={p.onFrontier ? '1' : '0'}>
              {highlightArm === p.arm && <circle cx={p.x} cy={p.y} r={9} className="pc-frontier__ring" fill="none" />}
              <circle
                cx={p.x}
                cy={p.y}
                r={p.onFrontier ? 5.5 : 4}
                fill={color}
                className={p.onFrontier ? 'pc-frontier__dot pc-frontier__dot--opt' : 'pc-frontier__dot'}
              >
                <title>{`${p.label} · ${armLabel(p.arm)} · ${xLabel} ${formatX(p.cost)} · ${yLabel} ${formatY(p.score)}${p.onFrontier ? ' · Pareto-optimal' : ''}`}</title>
              </circle>
              <text x={p.x + 8} y={p.y + 3.5} className={p.onFrontier ? 'pc-frontier__plabel pc-frontier__plabel--opt' : 'pc-frontier__plabel'}>{p.label}</text>
            </g>
          );
        })}
      </svg>
      <FrontierStyles />
    </figure>
  );
}

function FrontierStyles() {
  return (
    <style>{`
      .pc-frontier { margin: 0 0 4px; padding: 10px 12px 6px; border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); border-radius: 12px; background: var(--bg-2, rgba(255, 255, 255, 0.03)); }
      .pc-frontier__caption { margin: 0 0 4px; font-size: 11px; font-weight: 650; color: var(--fg-mute, #7f9bb4); }
      .pc-frontier svg { display: block; width: 100%; height: auto; }
      .pc-frontier__empty { padding: 28px 8px; text-align: center; font-size: 12px; color: var(--fg-mute, #7f9bb4); }
      .pc-frontier__axisline { stroke: var(--border-strong, rgba(125, 211, 252, 0.3)); stroke-width: 1; }
      .pc-frontier__axis { fill: var(--fg-mute, #7f9bb4); font-size: 9.5px; font-variant-numeric: tabular-nums; }
      .pc-frontier__axislabel { fill: var(--fg-mute, #7f9bb4); font-size: 10px; font-weight: 600; }
      .pc-frontier__line { stroke: var(--accent, #38bdf8); stroke-width: 1.75; stroke-linejoin: round; stroke-linecap: round; stroke-dasharray: 5 4; opacity: 0.85; }
      .pc-frontier__dot { stroke: var(--bg-1, rgba(6, 18, 26, 0.9)); stroke-width: 1.5; opacity: 0.7; }
      .pc-frontier__dot--opt { opacity: 1; }
      .pc-frontier__ring { stroke: var(--good, #34d399); stroke-width: 2; }
      .pc-frontier__plabel { fill: var(--fg-dim, #b9d4e8); font-size: 10px; }
      .pc-frontier__plabel--opt { fill: var(--fg, #e7f7ff); font-weight: 600; }
    `}</style>
  );
}
