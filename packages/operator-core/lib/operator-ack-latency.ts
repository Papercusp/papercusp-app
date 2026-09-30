/**
 * Adaptive unconsumed-threshold computation (final v5 polish item).
 *
 * The static 4-min "unconsumed" threshold is right for harnesses with
 * a ~60s cadence but wrong for slow ones. This module computes the
 * median dispatched→consumed latency per `target_harness` from
 * `audit_log` over the trailing 7 days, returning a per-harness
 * threshold of `1.5 × median, clamped to [60s, 30min]`.
 *
 * Caller (the panel) reads this on open + every 30min, applies the
 * per-harness threshold to the existing age-vs-glyph rule.
 */

import { withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';

const MIN_THRESHOLD_MS = 60_000;
const MAX_THRESHOLD_MS = 30 * 60_000;
const DEFAULT_THRESHOLD_MS = 4 * 60_000;
const SAMPLE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_SAMPLES = 3;

export interface AckLatencyTable {
  /** Per target_harness: ms threshold to treat 'dispatched' as 'unconsumed'. */
  perHarness: Record<string, number>;
  /** Fallback when a harness isn't represented in the table. */
  fallbackMs: number;
}

interface DispatchedRow {
  ts: number;
  subject: string;
  details: { target?: string };
}

interface AckedRow {
  ts: number;
  subject: string;
}

export async function computeAckLatencyTable(): Promise<AckLatencyTable> {
  const fallbackMs = DEFAULT_THRESHOLD_MS;
  let dispatched: DispatchedRow[] = [];
  let acked: AckedRow[] = [];
  try {
    const workspaceId = activeWorkspaceId();
    [dispatched, acked] = await withWorkspace(workspaceId, async (tx) => {
      const cutoff = Date.now() - SAMPLE_WINDOW_MS;
      const d = await tx<DispatchedRow[]>`
        SELECT ts, subject, details
          FROM harness_shared.audit_log
         WHERE actor  = 'system:operator'
           AND action = 'operator.dispatched'
           AND ts     >= ${cutoff}
      `;
      const a = await tx<AckedRow[]>`
        SELECT ts, subject
          FROM harness_shared.audit_log
         WHERE actor  = 'system:operator'
           AND action = 'operator.consumed'
           AND ts     >= ${cutoff}
      `;
      return [d, a];
    });
  } catch {
    return { perHarness: {}, fallbackMs };
  }

  return reduceLatency(dispatched, acked, fallbackMs);
}

/**
 * Pure-function core of computeAckLatencyTable — exported so unit tests
 * can exercise the bucket/median/clamp logic without a live PG.
 */
export function reduceLatency(
  dispatched: DispatchedRow[],
  acked: AckedRow[],
  fallbackMs = DEFAULT_THRESHOLD_MS,
): AckLatencyTable {
  // Build dispatch_ts by card_id + the card's target harness.
  const dispatchTsById = new Map<string, { ts: number; target: string }>();
  for (const r of dispatched) {
    if (!r.details?.target) continue;
    dispatchTsById.set(r.subject, { ts: r.ts, target: r.details.target });
  }

  // For each consumed row, look up its dispatch ts and bucket the
  // latency by target_harness.
  const buckets = new Map<string, number[]>();
  for (const r of acked) {
    const d = dispatchTsById.get(r.subject);
    if (!d) continue;
    const latency = r.ts - d.ts;
    if (latency <= 0 || latency > 24 * 60 * 60 * 1000) continue;
    const cur = buckets.get(d.target) ?? [];
    cur.push(latency);
    buckets.set(d.target, cur);
  }

  const perHarness: Record<string, number> = {};
  for (const [target, latencies] of buckets) {
    if (latencies.length < MIN_SAMPLES) continue;
    latencies.sort((a, b) => a - b);
    const median = latencies[Math.floor(latencies.length / 2)];
    const threshold = Math.max(MIN_THRESHOLD_MS, Math.min(MAX_THRESHOLD_MS, Math.round(median * 1.5)));
    perHarness[target] = threshold;
  }

  return { perHarness, fallbackMs };
}
