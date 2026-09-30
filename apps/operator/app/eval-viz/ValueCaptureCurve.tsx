'use client';
/**
 * ValueCaptureCurve — $ captured vs budget spent, one line per arm
 * (impartial-benchmark-suite-2026-06-15 P-030 / BRIEF 10, Hive layer L3).
 *
 * The Evaluation surface's "Value" subtab (D-010): under a FIXED budget, how much
 * real value ($) does the Queen's placement capture vs the naive scheduler? Each
 * arm is a cumulative curve (value captured as budget is spent) over a $-weighted
 * backlog — SWE-Lancer / UpBench (P-027). The higher curve at the budget cap wins;
 * the optional budget-cap reference line marks where the comparison is read.
 *
 * Purely presentational: series come from the value-capture runner (P-027) via
 * the surface; reads no data itself. Arm → color via `arms.ts`. Idiom mirrors the
 * sibling eval-viz charts (exported pure projection, self-carried styles, aria +
 * tooltips, empty state).
 */
import { useMemo } from 'react';
import { armColor, armLabel } from './arms';

export interface ValuePoint {
  /** Cumulative budget spent ($) — the x axis. */
  budget: number;
  /** Cumulative value captured ($) — the y axis. */
  valueCaptured: number;
}

export interface ValueSeries {
  arm: string;
  points: ValuePoint[];
}

export interface ValueCaptureCurveProps {
  series: ValueSeries[];
  /** Fixed-budget reference line ($) — where the comparison is read. */
  budgetCap?: number;
  /** Highlight the treatment arm (default 'hive'). */
  highlightArm?: string;
  xLabel?: string;
  yLabel?: string;
  format?: (n: number) => string;
  caption?: string;
  width?: number;
  height?: number;
  emptyHint?: string;
}

interface ProjectedSeries {
  arm: string;
  path: string;
  end: { x: number; y: number; valueCaptured: number; budget: number } | null;
}

const DEFAULT_W = 520;
const DEFAULT_H = 300;
const PAD = { top: 16, right: 80, bottom: 30, left: 52 };

const fmtUsd = (n: number): string => `$${n >= 100 ? Math.round(n) : Math.round(n * 100) / 100}`;

/**
 * Project each arm's curve into the plot box over a shared domain (x = budget,
 * y = value captured), padding the top and flooring both axes at 0. budgetCap
 * is folded into the x domain so its reference line is always in view. Points
 * are sorted by budget. Exported for tests.
 */
export function projectValueCurves(
  series: readonly ValueSeries[],
  opts: { width?: number; height?: number; budgetCap?: number } = {},
): { series: ProjectedSeries[]; xMax: number; yMax: number; capX: number | null } {
  const W = opts.width ?? DEFAULT_W;
  const H = opts.height ?? DEFAULT_H;
  const allPts = series.flatMap((s) => s.points);
  if (allPts.length === 0) return { series: [], xMax: 0, yMax: 0, capX: null };

  const xMaxRaw = Math.max(opts.budgetCap ?? 0, ...allPts.map((p) => p.budget));
  const yMaxRaw = Math.max(...allPts.map((p) => p.valueCaptured));
  const xMax = xMaxRaw * 1.04 || 1;
  const yMax = yMaxRaw * 1.08 || 1;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const px = (b: number) => PAD.left + (b / xMax) * plotW;
  const py = (v: number) => PAD.top + (1 - v / yMax) * plotH;

  const projected: ProjectedSeries[] = series.map((s) => {
    const sorted = [...s.points].sort((a, b) => a.budget - b.budget);
    const path = sorted.map((p) => `${px(p.budget).toFixed(1)},${py(p.valueCaptured).toFixed(1)}`).join(' ');
    const last = sorted[sorted.length - 1];
    return {
      arm: s.arm,
      path,
      end: last ? { x: px(last.budget), y: py(last.valueCaptured), valueCaptured: last.valueCaptured, budget: last.budget } : null,
    };
  });

  return { series: projected, xMax, yMax, capX: opts.budgetCap != null ? px(opts.budgetCap) : null };
}

export function ValueCaptureCurve({
  series,
  budgetCap,
  highlightArm = 'hive',
  xLabel = 'budget spent ($)',
  yLabel = 'value captured ($)',
  format = fmtUsd,
  caption,
  width = DEFAULT_W,
  height = DEFAULT_H,
  emptyHint = 'No value-capture runs yet — run a $-weighted backlog under a fixed budget.',
}: ValueCaptureCurveProps) {
  const { series: projected, xMax, yMax, capX } = useMemo(
    () => projectValueCurves(series, { width, height, budgetCap }),
    [series, width, height, budgetCap],
  );

  if (projected.length === 0) {
    return (
      <figure className="pc-value pc-value--empty" aria-label={emptyHint}>
        {caption && <figcaption className="pc-value__caption">{caption}</figcaption>}
        <div className="pc-value__empty" data-testid="value-empty">{emptyHint}</div>
        <ValueStyles />
      </figure>
    );
  }

  return (
    <figure
      className="pc-value"
      aria-label={`Value captured vs budget by arm. ${projected.filter((s) => s.end).map((s) => `${armLabel(s.arm)} ${format(s.end!.valueCaptured)} at ${format(s.end!.budget)}`).join(', ')}`}
    >
      {caption && <figcaption className="pc-value__caption">{caption}</figcaption>}
      <svg viewBox={`0 0 ${width} ${height}`} role="img" preserveAspectRatio="xMidYMid meet">
        {/* axes */}
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={height - PAD.bottom} className="pc-value__axisline" />
        <line x1={PAD.left} x2={width - PAD.right} y1={height - PAD.bottom} y2={height - PAD.bottom} className="pc-value__axisline" />
        <text x={PAD.left - 8} y={PAD.top + 4} textAnchor="end" className="pc-value__axis">{format(yMax)}</text>
        <text x={PAD.left - 8} y={height - PAD.bottom} textAnchor="end" className="pc-value__axis">$0</text>
        <text transform={`translate(14 ${(PAD.top + height - PAD.bottom) / 2}) rotate(-90)`} textAnchor="middle" className="pc-value__axislabel">↑ {yLabel}</text>
        <text x={(PAD.left + width - PAD.right) / 2} y={height - 4} textAnchor="middle" className="pc-value__axislabel">{xLabel} →</text>
        <text x={width - PAD.right} y={height - PAD.bottom + 16} textAnchor="end" className="pc-value__axis">{format(xMax)}</text>

        {/* fixed-budget reference line */}
        {capX != null && (
          <g data-testid="value-cap">
            <line x1={capX} x2={capX} y1={PAD.top - 4} y2={height - PAD.bottom} className="pc-value__cap" />
            <text x={capX} y={PAD.top - 6} textAnchor="middle" className="pc-value__caplabel">budget {format(budgetCap!)}</text>
          </g>
        )}

        {projected.map((s) => {
          const isHi = s.arm === highlightArm;
          const color = armColor(s.arm);
          return (
            <g key={s.arm} data-testid="value-series" data-arm={s.arm}>
              <polyline
                points={s.path}
                fill="none"
                stroke={color}
                className={isHi ? 'pc-value__line pc-value__line--hi' : 'pc-value__line'}
              />
              {s.end && (
                <>
                  <circle cx={s.end.x} cy={s.end.y} r={isHi ? 4 : 3} fill={color} className="pc-value__dot">
                    <title>{`${armLabel(s.arm)} · ${format(s.end.valueCaptured)} captured at ${format(s.end.budget)} budget`}</title>
                  </circle>
                  <text x={s.end.x + 6} y={s.end.y + 3.5} className={isHi ? 'pc-value__endlabel pc-value__endlabel--hi' : 'pc-value__endlabel'} fill={color}>{armLabel(s.arm)}</text>
                </>
              )}
            </g>
          );
        })}
      </svg>
      <ValueStyles />
    </figure>
  );
}

function ValueStyles() {
  return (
    <style>{`
      .pc-value { margin: 0 0 4px; padding: 10px 12px 6px; border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); border-radius: 12px; background: var(--bg-2, rgba(255, 255, 255, 0.03)); }
      .pc-value__caption { margin: 0 0 4px; font-size: 11px; font-weight: 650; color: var(--fg-mute, #7f9bb4); }
      .pc-value svg { display: block; width: 100%; height: auto; }
      .pc-value__empty { padding: 28px 8px; text-align: center; font-size: 12px; color: var(--fg-mute, #7f9bb4); }
      .pc-value__axisline { stroke: var(--border-strong, rgba(125, 211, 252, 0.3)); stroke-width: 1; }
      .pc-value__axis { fill: var(--fg-mute, #7f9bb4); font-size: 9.5px; font-variant-numeric: tabular-nums; }
      .pc-value__axislabel { fill: var(--fg-mute, #7f9bb4); font-size: 10px; font-weight: 600; }
      .pc-value__cap { stroke: var(--border-strong, rgba(125, 211, 252, 0.32)); stroke-width: 1; stroke-dasharray: 4 4; }
      .pc-value__caplabel { fill: var(--fg-mute, #7f9bb4); font-size: 9px; }
      .pc-value__line { fill: none; stroke-width: 1.75; stroke-linejoin: round; stroke-linecap: round; opacity: 0.7; }
      .pc-value__line--hi { stroke-width: 2.5; opacity: 1; }
      .pc-value__dot { stroke: var(--bg-1, rgba(6, 18, 26, 0.9)); stroke-width: 1.25; }
      .pc-value__endlabel { font-size: 10px; opacity: 0.85; }
      .pc-value__endlabel--hi { font-weight: 700; opacity: 1; }
    `}</style>
  );
}
