'use client';
/**
 * ThroughputBars — fleet throughput, one horizontal bar per arm
 * (impartial-benchmark-suite-2026-06-15 P-030 / BRIEF 10, Hive layer L2).
 *
 * The Evaluation surface's "Throughput" subtab (D-010): how much faster does the
 * Hive drain a whole backlog than the serial floor? The bar length is
 * `speedupVsSerial` (the dimensionless, comparable axis — OpenHands async-SWE
 * reports 1.8–3.7×), with a 1× reference line = the serial-backlog floor. Each
 * bar carries its tasks/hr + $/task + wall-clock in the label/tooltip so the
 * other (differently-united) throughput numbers are visible without a misleading
 * shared axis. When `speedupVsSerial` is null it is derived from wall-clock
 * (slowest arm = the 1× serial reference).
 *
 * Purely presentational: takes the per-arm aggregate from `@papercusp/bench-metrics`
 * (P-025) via the surface; reads no data itself. Arm → color via `arms.ts`.
 * Idiom mirrors Frontier/BenchmarkTrend (exported pure projection, self-carried
 * `pc-tput__*` styles, aria-label + <title> tooltips, empty state).
 */
import { useMemo } from 'react';
import { armColor, armLabel } from './arms';

export interface ThroughputArm {
  arm: string;
  tasksPerHour: number;
  costPerTask: number;
  wallClockMs: number;
  /** Speedup vs the serial floor (×). null = derive from wall-clock. */
  speedupVsSerial: number | null;
  /** Share of tasks completed with zero human gate (0–1) — the autonomy claim. Optional. */
  autonomyPct?: number;
}

export interface ThroughputBarsProps {
  arms: ThroughputArm[];
  /** Highlight the treatment arm (default 'hive'). */
  highlightArm?: string;
  format?: (n: number | null | undefined) => string;
  caption?: string;
  width?: number;
  emptyHint?: string;
}

interface ThroughputBar extends ThroughputArm {
  /** Resolved speedup (provided, or derived from wall-clock; serial floor = 1×). */
  speedup: number;
  derived: boolean;
}

const DEFAULT_W = 520;
const ROW_H = 30;
const PAD = { top: 14, right: 64, bottom: 26, left: 120 };

const fmtNum = (n: number | null | undefined): string =>
  n == null ? '—' : (Math.round(n * 100) / 100).toString();
const fmtUsd = (n: number): string => `$${n >= 100 ? Math.round(n) : Math.round(n * 100) / 100}`;
const fmtDur = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const h = ms / 3_600_000;
  if (h >= 1) return `${Math.round(h * 10) / 10}h`;
  const m = ms / 60_000;
  if (m >= 1) return `${Math.round(m)}m`;
  return `${Math.round(ms / 1000)}s`;
};

/**
 * Resolve each arm's speedup: prefer `speedupVsSerial`; else derive from
 * wall-clock as slowest/this (slowest arm ≈ the serial floor → ~1×). If no
 * wall-clock either, speedup = 1. Exported for tests.
 */
export function computeThroughputBars(arms: readonly ThroughputArm[]): ThroughputBar[] {
  const maxWall = Math.max(0, ...arms.map((a) => (Number.isFinite(a.wallClockMs) ? a.wallClockMs : 0)));
  return arms.map((a) => {
    let speedup: number;
    let derived = false;
    if (a.speedupVsSerial != null && Number.isFinite(a.speedupVsSerial)) {
      speedup = a.speedupVsSerial;
    } else if (maxWall > 0 && a.wallClockMs > 0) {
      speedup = maxWall / a.wallClockMs;
      derived = true;
    } else {
      speedup = 1;
      derived = true;
    }
    return { ...a, speedup, derived };
  });
}

export function ThroughputBars({
  arms,
  highlightArm = 'hive',
  format = fmtNum,
  caption,
  width = DEFAULT_W,
  emptyHint = 'No throughput runs yet — drain a backlog with each arm to compare speed.',
}: ThroughputBarsProps) {
  const bars = useMemo(() => computeThroughputBars(arms), [arms]);

  if (bars.length === 0) {
    return (
      <figure className="pc-tput pc-tput--empty" aria-label={emptyHint}>
        {caption && <figcaption className="pc-tput__caption">{caption}</figcaption>}
        <div className="pc-tput__empty" data-testid="tput-empty">{emptyHint}</div>
        <ThroughputStyles />
      </figure>
    );
  }

  const height = PAD.top + PAD.bottom + bars.length * ROW_H;
  const plotW = width - PAD.left - PAD.right;
  // Scale so the largest speedup fills the plot; never below 1× so the reference shows.
  const maxSpeedup = Math.max(1, ...bars.map((b) => b.speedup));
  const x = (s: number) => PAD.left + (s / maxSpeedup) * plotW;
  const oneX = x(1);

  return (
    <figure
      className="pc-tput"
      aria-label={`Throughput by arm: ${bars.map((b) => `${armLabel(b.arm)} ${format(b.speedup)}× vs serial`).join(', ')}`}
    >
      {caption && <figcaption className="pc-tput__caption">{caption}</figcaption>}
      <svg viewBox={`0 0 ${width} ${height}`} role="img" preserveAspectRatio="xMidYMid meet">
        {/* 1× serial-floor reference */}
        <line x1={oneX} x2={oneX} y1={PAD.top - 4} y2={height - PAD.bottom} className="pc-tput__ref" />
        <text x={oneX} y={height - PAD.bottom + 16} textAnchor="middle" className="pc-tput__axis">1× serial</text>

        {bars.map((b, i) => {
          const y = PAD.top + i * ROW_H;
          const barW = Math.max(1, x(b.speedup) - PAD.left);
          const isHi = b.arm === highlightArm;
          return (
            <g key={b.arm} data-testid="tput-bar" data-arm={b.arm}>
              <text x={PAD.left - 8} y={y + ROW_H / 2 + 3.5} textAnchor="end" className={isHi ? 'pc-tput__armlabel pc-tput__armlabel--hi' : 'pc-tput__armlabel'}>{armLabel(b.arm)}</text>
              <rect
                x={PAD.left}
                y={y + 5}
                width={barW}
                height={ROW_H - 12}
                rx={3}
                fill={armColor(b.arm)}
                className={isHi ? 'pc-tput__bar pc-tput__bar--hi' : 'pc-tput__bar'}
              >
                <title>{`${armLabel(b.arm)} · ${format(b.speedup)}× vs serial${b.derived ? ' (derived from wall-clock)' : ''} · ${format(b.tasksPerHour)} tasks/hr · ${fmtUsd(b.costPerTask)}/task · ${fmtDur(b.wallClockMs)}${b.autonomyPct != null ? ` · ${Math.round(b.autonomyPct * 100)}% autonomous` : ''}`}</title>
              </rect>
              <text x={x(b.speedup) + 6} y={y + ROW_H / 2 + 3.5} className="pc-tput__val">
                {format(b.speedup)}× · {format(b.tasksPerHour)}/hr · {fmtUsd(b.costPerTask)}
              </text>
            </g>
          );
        })}
      </svg>
      <ThroughputStyles />
    </figure>
  );
}

function ThroughputStyles() {
  return (
    <style>{`
      .pc-tput { margin: 0 0 4px; padding: 10px 12px 6px; border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); border-radius: 12px; background: var(--bg-2, rgba(255, 255, 255, 0.03)); }
      .pc-tput__caption { margin: 0 0 4px; font-size: 11px; font-weight: 650; color: var(--fg-mute, #7f9bb4); }
      .pc-tput svg { display: block; width: 100%; height: auto; }
      .pc-tput__empty { padding: 28px 8px; text-align: center; font-size: 12px; color: var(--fg-mute, #7f9bb4); }
      .pc-tput__ref { stroke: var(--border-strong, rgba(125, 211, 252, 0.32)); stroke-width: 1; stroke-dasharray: 4 4; }
      .pc-tput__axis { fill: var(--fg-mute, #7f9bb4); font-size: 9.5px; font-variant-numeric: tabular-nums; }
      .pc-tput__armlabel { fill: var(--fg-dim, #b9d4e8); font-size: 11px; }
      .pc-tput__armlabel--hi { fill: var(--fg, #e7f7ff); font-weight: 700; }
      .pc-tput__bar { opacity: 0.78; }
      .pc-tput__bar--hi { opacity: 1; }
      .pc-tput__val { fill: var(--fg-mute, #7f9bb4); font-size: 9.5px; font-variant-numeric: tabular-nums; }
    `}</style>
  );
}
