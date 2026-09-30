'use client';
/**
 * MastBreakdown — MAS coordination-failure taxonomy rates, grouped by arm
 * (impartial-benchmark-suite-2026-06-15 P-030 / BRIEF 10, Hive layer L4).
 *
 * The Evaluation surface's "Coordination" subtab (D-010) — the most
 * differentiated AND most impartial Hive claim. The MAST study (NeurIPS 2025,
 * 1,600+ traces) found multi-agent systems fail 41–86% of the time in prod, with
 * token-duplication 53–86% and interagent-misalignment 36.9%. This plots OUR
 * measured per-arm rates for the four MAST failure modes (lower is better) with
 * that published failure range shaded as a reference band — so "the Hive's
 * coordination substrate (locks, work_item dedup/redundancy-judge, durable
 * hand-offs) keeps these rates below the published MAS baseline" reads directly.
 *
 * Bars are colored by FAILURE MODE (arm is the group/x axis), unlike the
 * arm-keyed charts. Purely presentational: rates come from `@papercusp/bench-metrics`
 * MAST instrumentation (P-026) via the surface. Idiom mirrors the sibling
 * eval-viz charts (exported pure core, self-carried styles, aria + tooltips).
 */
import { useMemo } from 'react';
import { armLabel } from './arms';

export interface MastArmRates {
  arm: string;
  /** Each rate is a fraction 0–1 (share of traces exhibiting the mode). */
  duplication: number;
  coordinationBreakdown: number;
  misalignment: number;
  redundant: number;
}

export interface MastBreakdownProps {
  arms: MastArmRates[];
  /** Published MAS-failure reference range (default 0.41–0.86, the MAST baseline). */
  baselineBand?: { lo: number; hi: number };
  format?: (n: number | null | undefined) => string;
  caption?: string;
  width?: number;
  emptyHint?: string;
}

interface MastMode {
  key: keyof Omit<MastArmRates, 'arm'>;
  label: string;
  color: string;
}

/** The four MAST failure modes, in display order, each with a fixed series color. */
export const MAST_MODES: readonly MastMode[] = [
  { key: 'duplication', label: 'duplication', color: '#fbbf24' }, // amber
  { key: 'coordinationBreakdown', label: 'coord. breakdown', color: '#fb7185' }, // rose
  { key: 'misalignment', label: 'misalignment', color: '#a78bfa' }, // violet
  { key: 'redundant', label: 'redundant work', color: 'var(--accent, #38bdf8)' }, // accent
] as const;

const DEFAULT_W = 520;
const H = 300;
const PAD = { top: 16, right: 14, bottom: 46, left: 40 };

const fmtPct = (n: number | null | undefined): string => (n == null ? '—' : `${Math.round(n * 100)}%`);

/**
 * Total coordination-failure load per arm = sum of the four mode rates (a single
 * comparable scalar; lower is better). Exported for tests / sorting / labels.
 */
export function mastTotal(arm: MastArmRates): number {
  return arm.duplication + arm.coordinationBreakdown + arm.misalignment + arm.redundant;
}

export function MastBreakdown({
  arms,
  baselineBand = { lo: 0.41, hi: 0.86 },
  format = fmtPct,
  caption,
  width = DEFAULT_W,
  emptyHint = 'No coordination traces yet — run a backlog with each arm to measure MAST failure rates.',
}: MastBreakdownProps) {
  const maxRate = useMemo(
    () => Math.max(1e-9, baselineBand?.hi ?? 0, ...arms.flatMap((a) => MAST_MODES.map((m) => a[m.key]))),
    [arms, baselineBand],
  );

  if (arms.length === 0) {
    return (
      <figure className="pc-mast pc-mast--empty" aria-label={emptyHint}>
        {caption && <figcaption className="pc-mast__caption">{caption}</figcaption>}
        <div className="pc-mast__empty" data-testid="mast-empty">{emptyHint}</div>
        <MastStyles />
      </figure>
    );
  }

  // Domain 0..ceil(maxRate to a sensible top); rates are fractions, cap at 1.
  const yTop = Math.min(1, Math.max(maxRate, baselineBand?.hi ?? 0));
  const plotW = width - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + (1 - v / (yTop || 1)) * plotH;
  const groupW = plotW / arms.length;
  const barW = Math.min(16, (groupW - 10) / MAST_MODES.length);

  const bandLo = baselineBand ? y(Math.min(baselineBand.lo, yTop)) : null;
  const bandHi = baselineBand ? y(Math.min(baselineBand.hi, yTop)) : null;

  return (
    <figure
      className="pc-mast"
      aria-label={`MAST coordination-failure rates by arm (lower is better)${baselineBand ? `, vs the published ${format(baselineBand.lo)}–${format(baselineBand.hi)} MAS-failure band` : ''}. ${arms.map((a) => `${armLabel(a.arm)} total ${format(mastTotal(a))}`).join(', ')}`}
    >
      {caption && <figcaption className="pc-mast__caption">{caption}</figcaption>}
      <svg viewBox={`0 0 ${width} ${H}`} role="img" preserveAspectRatio="xMidYMid meet">
        {/* published MAS-failure reference band */}
        {bandLo != null && bandHi != null && (
          <g data-testid="mast-band">
            <rect x={PAD.left} y={bandHi} width={plotW} height={Math.max(0, bandLo - bandHi)} className="pc-mast__band" />
            <text x={width - PAD.right} y={bandHi - 3} textAnchor="end" className="pc-mast__bandlabel">published MAS failure {format(baselineBand!.lo)}–{format(baselineBand!.hi)}</text>
          </g>
        )}

        {/* y axis ticks */}
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={H - PAD.bottom} className="pc-mast__axisline" />
        <text x={PAD.left - 6} y={PAD.top + 4} textAnchor="end" className="pc-mast__axis">{format(yTop)}</text>
        <text x={PAD.left - 6} y={H - PAD.bottom} textAnchor="end" className="pc-mast__axis">0%</text>

        {/* per-arm groups */}
        {arms.map((a, gi) => {
          const gx = PAD.left + gi * groupW + (groupW - barW * MAST_MODES.length) / 2;
          return (
            <g key={a.arm} data-testid="mast-group" data-arm={a.arm}>
              {MAST_MODES.map((m, mi) => {
                const v = a[m.key];
                const by = y(v);
                return (
                  <rect
                    key={m.key}
                    x={gx + mi * barW}
                    y={by}
                    width={Math.max(1, barW - 2)}
                    height={Math.max(0, H - PAD.bottom - by)}
                    fill={m.color}
                    className="pc-mast__bar"
                  >
                    <title>{`${armLabel(a.arm)} · ${m.label}: ${format(v)}`}</title>
                  </rect>
                );
              })}
              <text x={PAD.left + gi * groupW + groupW / 2} y={H - PAD.bottom + 14} textAnchor="middle" className="pc-mast__armlabel">{armLabel(a.arm)}</text>
            </g>
          );
        })}
      </svg>
      <div className="pc-mast__legend" aria-hidden="true">
        {MAST_MODES.map((m) => (
          <span key={m.key} className="pc-mast__legenditem">
            <span className="pc-mast__legenddot" style={{ background: m.color }} />{m.label}
          </span>
        ))}
      </div>
      <MastStyles />
    </figure>
  );
}

function MastStyles() {
  return (
    <style>{`
      .pc-mast { margin: 0 0 4px; padding: 10px 12px 6px; border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); border-radius: 12px; background: var(--bg-2, rgba(255, 255, 255, 0.03)); }
      .pc-mast__caption { margin: 0 0 4px; font-size: 11px; font-weight: 650; color: var(--fg-mute, #7f9bb4); }
      .pc-mast svg { display: block; width: 100%; height: auto; }
      .pc-mast__empty { padding: 28px 8px; text-align: center; font-size: 12px; color: var(--fg-mute, #7f9bb4); }
      .pc-mast__band { fill: rgba(251, 113, 133, 0.1); stroke: rgba(251, 113, 133, 0.28); stroke-width: 1; stroke-dasharray: 4 4; }
      .pc-mast__bandlabel { fill: var(--bad, #fb7185); font-size: 9px; opacity: 0.85; }
      .pc-mast__axisline { stroke: var(--border-strong, rgba(125, 211, 252, 0.3)); stroke-width: 1; }
      .pc-mast__axis { fill: var(--fg-mute, #7f9bb4); font-size: 9.5px; font-variant-numeric: tabular-nums; }
      .pc-mast__bar { opacity: 0.85; }
      .pc-mast__armlabel { fill: var(--fg-dim, #b9d4e8); font-size: 10px; }
      .pc-mast__legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 6px; }
      .pc-mast__legenditem { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; color: var(--fg-mute, #7f9bb4); }
      .pc-mast__legenddot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
    `}</style>
  );
}
