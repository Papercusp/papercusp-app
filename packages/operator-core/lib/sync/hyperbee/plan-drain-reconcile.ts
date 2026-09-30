/**
 * plan-drain-reconcile — WI-254 (EI-1618 item 2): the PURE detection core of the
 * periodic federation-drain reconcile.
 *
 * EI-1618's on-READ surface (federation-status route + the desktop) flips a
 * harness off "healthy" when its `substrate_outbox` is undrained past threshold —
 * but only when something READS it. WI-254 adds the proactive half: a routine
 * tick reconciles the drain state of the LIVE booted harnesses and flags any that
 * are stalled, so a silent-federation stall (the EI-681 class: captured but not
 * federating) is caught without a reader, and is surfaced BEFORE the
 * substrate-outbox-backstop-GC drops the undrained-orphaned rows.
 *
 * This module is PURE (no PG, no registry, no side effects) so the stall logic is
 * unit-testable in isolation — the action wrapper (run-drain-reconcile.ts) feeds
 * it `load-drain-stats` output over `listBootedHandles()` and raises the deduped
 * alert. Thresholds (`DRAIN_STALLED_MS` / `DRAIN_UNHEALTHY_MS`) DELIBERATELY
 * DIVERGE from `assessHarnessSubstrateHealth`'s on-read drain ladder (60s
 * degraded / 5m unhealthy) as of 2026-07-19 — see `DRAIN_STALLED_MS`'s doc
 * comment for why: this reconcile files a DURABLE tracked bug per breach (unlike
 * the ephemeral on-read verdict), so it needs a materially higher bar to avoid
 * flooding the tracker with noise from routine host-recycle catch-up gaps.
 */
import type { SubstrateDrainStat } from './load-drain-stats';

/**
 * Oldest-undrained age (ms) past which an outbox counts as stalled (≥ this →
 * degraded) FOR THIS PROACTIVE, DURABLE-FILING RECONCILE. Originally set to mirror
 * `assessHarnessSubstrateHealth`'s on-read `drainStalledThresholdMs` (60s) 1:1 — but
 * live evidence (2026-07-19, papercusp harness: 24 duplicate "Federation stall" bugs
 * filed in ~12h, each investigated + closed as self-resolved by a separate agent)
 * showed that 1:1 mirroring was WRONG for this call site specifically: the on-read
 * verdict in `health.ts` is EPHEMERAL (recomputed per read, free to be sensitive —
 * a momentary "degraded" in the UI costs nothing), while THIS reconcile FILES A
 * DURABLE TRACKED BUG on every breach (dedup'd per-harness, but re-opens on every
 * fresh recurrence) — a materially higher-cost action that deserves a higher bar.
 * Root cause of the noise: this dev box's `papercup-staging-api`/`papercup-dev-api`
 * hosts routinely self-recycle every ~5-8min (host-recycle SIGKILL, see journalctl),
 * which tears down + re-establishes the in-process outbox-drain loop each time; the
 * observed capture→drain catch-up gap after a recycle was consistently ~90-130s —
 * comfortably past the old 60s bar (hence the flood) but a normal, self-healing
 * artifact of the recycle cadence, not a genuine stall. `outbox-drain.ts` already
 * has its own, better-tuned, restart-resilient detectors for a GENUINE wedge
 * (`DRAIN_BACKLOG_STALL_MS` — 10min zero-progress; `DRAIN_BACKLOG_AGE_STALL_MS` /
 * `DRAIN_BACKLOG_SIZE_STALL_THRESHOLD` — 1h / 2000 rows, PROGRESS-INDEPENDENT), so
 * this reconcile no longer needs to be maximally sensitive to serve its stated
 * purpose ("catch a silent stall before the 48h backstop-GC drops the rows" — a
 * huge no-race margin survives at any of these values). 5min clears the observed
 * noise floor (~130s) with >2x margin while staying far tighter than the other
 * detectors, so a real stall is still filed promptly. Deliberately DIVERGES from
 * `assessHarnessSubstrateHealth`'s on-read threshold now — see that function's own
 * (unchanged) default for the live-UI verdict. */
export const DRAIN_STALLED_MS = 5 * 60_000;
/** Oldest-undrained age (ms) past which a stall is unhealthy (≥ this → unhealthy).
 *  See `DRAIN_STALLED_MS` above for why this reconcile's thresholds were raised off
 *  `assessHarnessSubstrateHealth`'s on-read ladder (2026-07-19 noise-storm fix).
 *  20min keeps a healthy margin above `DRAIN_STALLED_MS` and above
 *  `outbox-drain.ts`'s own 10min no-progress detector, so an 'unhealthy' filing
 *  here means something has stayed bad well past what the other detectors already
 *  independently caught. */
export const DRAIN_UNHEALTHY_MS = 20 * 60_000;

/** One booted harness's drain state, as the action gathers it. */
export interface DrainReconcileInput {
  workspaceId: string;
  harnessSlug: string;
  drain: SubstrateDrainStat;
}

/** A flagged stall — one booted harness whose outbox is captured-but-not-federating. */
export interface DrainStallFlag {
  workspaceId: string;
  harnessSlug: string;
  undrainedCount: number;
  /** Non-null + ≥ DRAIN_STALLED_MS by construction. */
  oldestUndrainedAgeMs: number;
  severity: 'degraded' | 'unhealthy';
}

export interface PlanDrainReconcileOpts {
  stalledMs?: number;
  unhealthyMs?: number;
}

/**
 * Pure tick planning: which booted harnesses are stalled (undrained rows whose
 * oldest age ≥ the stall threshold). Only flags a harness with `undrainedCount > 0`
 * AND a measured `oldestUndrainedAgeMs ≥ stalledMs` — a harness with a
 * briefly-undrained outbox (rows between the capture and the next drain tick, or a
 * routine host-recycle catch-up gap) or a fully-drained outbox is NOT flagged.
 * Severity escalates to `unhealthy` at `DRAIN_UNHEALTHY_MS`.
 *
 * NB the input is expected to cover only LIVE booted harnesses (the action maps
 * over listBootedHandles) — dead/test hive slugs are never booted, so they never
 * reach here; their undrained debris is the GC's concern (infra-fail-fast C2), not
 * a federation-stall alert. That is the natural detection/remediation seam.
 */
export function planDrainReconcile(
  inputs: DrainReconcileInput[],
  opts: PlanDrainReconcileOpts = {},
): DrainStallFlag[] {
  const stalledMs = opts.stalledMs ?? DRAIN_STALLED_MS;
  const unhealthyMs = opts.unhealthyMs ?? DRAIN_UNHEALTHY_MS;
  const flags: DrainStallFlag[] = [];
  for (const i of inputs) {
    const { undrainedCount, oldestUndrainedAgeMs } = i.drain;
    if (
      undrainedCount > 0 &&
      oldestUndrainedAgeMs != null &&
      oldestUndrainedAgeMs >= stalledMs
    ) {
      flags.push({
        workspaceId: i.workspaceId,
        harnessSlug: i.harnessSlug,
        undrainedCount,
        oldestUndrainedAgeMs,
        severity: oldestUndrainedAgeMs >= unhealthyMs ? 'unhealthy' : 'degraded',
      });
    }
  }
  return flags;
}

/** Stable dedup key for one harness's stall — one captureImprovement per stalled
 *  harness (refiled only when it clears + recurs), never one alert per tick. */
export function drainStallWatchdogKey(workspaceId: string, harnessSlug: string): string {
  return `federation-drain-stall:${workspaceId}:${harnessSlug}`;
}
