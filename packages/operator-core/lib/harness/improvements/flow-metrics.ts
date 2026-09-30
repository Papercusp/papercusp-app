/**
 * flow-metrics.ts — FLOW (not stock) metrics for the self-improvement loop
 * (learning-system-audit-improvements-2026-06-09 P-041).
 *
 * The Learning tab's scoreboard counts STOCKS (total captured / open / resolved)
 * — numbers that only ever grow and say nothing about whether the loop is
 * actually cycling. This module computes the FLOWS:
 *
 *   - `captured7d` / `resolved7d` — items created vs resolved/closed in the
 *     trailing 7 days. Resolution time is approximated by `updatedAt` on a
 *     resolved/closed item (the lifecycle write IS the state transition — same
 *     approximation the recurrence-decay clock uses, see digest.ts).
 *   - `medianOpenAgeDays` — is the open backlog fresh churn or sediment?
 *   - `recurringSignatureCount` — passed through from the digest's
 *     `recurringSignatures` (computed once there — NOT re-derived here).
 *   - `watchdog` — is the hard feed-in alive? last tick + ticks/captures in 24h.
 *
 * `computeImprovementFlow` is PURE over injected rows (unit-testable without
 * PG); `readWatchdogFlowTicks` is the thin PG read beside it, using the same
 * `getOrgPg()` access the neighboring watchdog readers use.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { ImprovementCandidate } from './policy';
import type { DispatchStats } from './dispatch-ledger';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Minimal watchdog tick row the flow rollup needs (injected — see readWatchdogFlowTicks). */
export interface WatchdogFlowTick {
  /** tick_at, epoch ms. */
  tickAtMs: number;
  /** How many improvements that tick captured (length of the `captured` id array). */
  capturedCount: number;
}

export interface ImprovementFlow {
  /** Items created in the trailing 7 days. */
  captured7d: number;
  /** Items whose state is resolved/closed AND whose last update is in the trailing 7 days. */
  resolved7d: number;
  /** captured7d − resolved7d. Positive = the backlog grew this week. */
  net7d: number;
  /** Median age (days, 0.1 precision) of the OPEN items; null when nothing is open. */
  medianOpenAgeDays: number | null;
  /** Count of recurring friction signatures — from digest.recurringSignatures (reused, not re-derived). */
  recurringSignatureCount: number;
  watchdog: {
    /** ISO timestamp of the most recent tick, or null if the watchdog never ticked. */
    lastTickAt: string | null;
    /** Ticks in the trailing 24h. */
    ticks24h: number;
    /** Improvements captured by ticks in the trailing 24h. */
    captured24h: number;
  };
  /**
   * Auto-implement dispatch ledger rollup (consume-edges P-010 / B-04) — is the
   * BACK edge cycling (fired vs actually fixed, in-progress vs presumed-dead)?
   * Computed once in dispatch-ledger.ts and passed through (not re-derived
   * here, same rule as recurringSignatureCount); null when the ledger read
   * failed or wasn't attempted.
   */
  dispatch: DispatchStats | null;
}

function parseMs(ts: string | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface ComputeImprovementFlowOptions {
  /** Now, in ms — passed for deterministic tests; the resolver passes Date.now(). */
  nowMs?: number;
  /** digest.recurringSignatures.length — the digest already computed it; pass it through. */
  recurringSignatureCount?: number;
  /** computeDispatchStats(...) over the ledger read — passed through, not re-derived. */
  dispatchStats?: DispatchStats | null;
}

/**
 * Pure flow rollup over the candidate + watchdog-tick rows. Deterministic given
 * `nowMs`; no PG, no clock reads.
 */
export function computeImprovementFlow(
  candidates: ImprovementCandidate[],
  ticks: WatchdogFlowTick[],
  opts: ComputeImprovementFlowOptions = {},
): ImprovementFlow {
  const nowMs = opts.nowMs ?? Date.now();
  const weekStart = nowMs - 7 * DAY_MS;
  const dayStart = nowMs - DAY_MS;

  let captured7d = 0;
  let resolved7d = 0;
  const openAges: number[] = [];
  for (const c of candidates) {
    const createdMs = parseMs(c.createdAt);
    if (createdMs !== null && createdMs >= weekStart && createdMs <= nowMs) captured7d += 1;

    const state = c.state ?? 'open';
    if (state === 'open') {
      if (createdMs !== null) openAges.push(Math.max(0, (nowMs - createdMs) / DAY_MS));
      continue;
    }
    // resolved/closed — approximate the resolution time by the last lifecycle
    // update (updated_at), same clock the recurrence-decay matcher reads.
    const resolvedMs = parseMs(c.updatedAt) ?? createdMs;
    if (resolvedMs !== null && resolvedMs >= weekStart && resolvedMs <= nowMs) resolved7d += 1;
  }
  openAges.sort((a, b) => a - b);
  const med = median(openAges);

  let lastTickMs: number | null = null;
  let ticks24h = 0;
  let captured24h = 0;
  for (const t of ticks) {
    if (lastTickMs === null || t.tickAtMs > lastTickMs) lastTickMs = t.tickAtMs;
    if (t.tickAtMs >= dayStart && t.tickAtMs <= nowMs) {
      ticks24h += 1;
      captured24h += t.capturedCount;
    }
  }

  return {
    captured7d,
    resolved7d,
    net7d: captured7d - resolved7d,
    medianOpenAgeDays: med === null ? null : Math.round(med * 10) / 10,
    recurringSignatureCount: opts.recurringSignatureCount ?? 0,
    watchdog: {
      lastTickAt: lastTickMs === null ? null : new Date(lastTickMs).toISOString(),
      ticks24h,
      captured24h,
    },
    dispatch: opts.dispatchStats ?? null,
  };
}

/**
 * PG read for the watchdog half of the flow: the most recent tick rows
 * (tick_at + captured count), newest-first. Bounded — the watchdog ticks
 * ~96/day/host and rows are retention-pruned, so the cap comfortably covers
 * the 24h window while still carrying the true last tick even when it's old.
 */
export async function readWatchdogFlowTicks(
  workspaceId: string,
  opts: { limit?: number } = {},
): Promise<WatchdogFlowTick[]> {
  const { sql } = getOrgPg();
  const limit = Math.min(Math.max(1, opts.limit ?? 1000), 2000);
  const rows = await sql<{ tick_at: Date | string; captured_count: number }[]>`
    SELECT tick_at, COALESCE(array_length(captured, 1), 0) AS captured_count
      FROM harness_shared.watchdog_ticks
     WHERE workspace_id = ${workspaceId}
     ORDER BY tick_at DESC
     LIMIT ${limit}`;
  return rows
    .map((r) => ({
      tickAtMs: r.tick_at instanceof Date ? r.tick_at.getTime() : Date.parse(String(r.tick_at)),
      capturedCount: Number(r.captured_count) || 0,
    }))
    .filter((t) => !Number.isNaN(t.tickAtMs));
}
