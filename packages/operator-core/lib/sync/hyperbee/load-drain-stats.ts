/**
 * loadSubstrateDrainStats — EI-1618 / EI-1599 drain-health read.
 *
 * One grouped read over `harness_shared.substrate_outbox` for the
 * federation-status route's `resolveDrainStats` (Brief M / G-004). Pure logic
 * with an injectable `runQuery` (mirrors `loadClaimAttemptStats`); defensive
 * against a missing table → empty map.
 *
 * WHY this matters: a row sits in `substrate_outbox` from the moment a local
 * federated write is captured until the drain folds it into this peer's
 * Hypercore log (`outbox-drain.ts` sets `drained_at = Date.now()`). A row that
 * stays undrained for a long time means content was CAPTURED but is NOT
 * federating — the EI-681 silent-stall class (harness booted, outbox never
 * drains / never joins the topic). Boot-health alone reports such a harness as
 * "healthy"; this read is what `assessHarnessSubstrateHealth` consumes to flip
 * it off "healthy".
 *
 * COLUMN NOTE: `ts` is the operation's wire/LWW timestamp and can be historical
 * during backfill. The local enqueue timestamp is `enqueued_at_ms` (migration
 * 1131), while the drain marker remains `drained_at`; all are BIGINT epoch-ms.
 * Oldest-undrained age = `Date.now() - MIN(enqueued_at_ms)`, computed here, not
 * from the wire timestamp.
 *
 * QUARANTINED ROWS ARE EXCLUDED (mig 645, WI-3896 follow-up): a row that
 * outbox-drain.ts's per-row poison quarantine has stamped `quarantined_at` on
 * is DELIBERATELY left undrained forever (a triage decision, not a stall —
 * see outbox-drain.ts's WI-3896 doc-comment) and must NOT count toward this
 * read's undrained/oldest-age. Before this exclusion, a single permanently-
 * quarantined poison row kept a harness's `oldestUndrainedAgeMs` growing
 * without bound, so `plan-drain-reconcile.ts`'s federation-drain-reconcile
 * refiled a fresh "Federation stall" bug forever (every time the previous one
 * was closed) even though the harness was healthy and draining fresh writes
 * in near-real-time — the live papercusp incident this migration fixes.
 */

export interface SubstrateDrainStat {
  /** Rows with `drained_at IS NULL` for this (workspace, harness). */
  undrainedCount: number;
  /** `now - MIN(ts)` of those rows in ms; null when none / not measured. */
  oldestUndrainedAgeMs: number | null;
}

export interface LoadSubstrateDrainStatsOpts {
  runQuery: <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;
  /** Override for tests; defaults to Date.now(). */
  nowMs?: number;
}

interface RawDrainRow {
  workspace_id: string;
  harness_slug: string;
  undrained: string | number;
  oldest_enqueued_at_ms: string | number | null;
}

function toNum(v: string | number | null): number {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Returns a Map keyed `${workspace_id}::${harness_slug}` → drain stat, for the
 * route to feed a SYNC `resolveDrainStats(ws, slug)` (the in-process status
 * composer resolves per-harness synchronously, so the PG read must be
 * prefetched into a map). Only rows with `undrainedCount > 0` are mapped — a
 * harness with a fully-drained outbox is simply absent (the resolver defaults it
 * to zero-drain). Any error → empty map (honest zero-drain; never throws the
 * caller's read).
 */
export async function loadSubstrateDrainStats(
  opts: LoadSubstrateDrainStatsOpts,
): Promise<Map<string, SubstrateDrainStat>> {
  const now = opts.nowMs ?? Date.now();
  const out = new Map<string, SubstrateDrainStat>();
  let rows: RawDrainRow[];
  try {
    rows = await opts.runQuery<RawDrainRow>(
      `SELECT workspace_id, harness_slug,
              COUNT(*) AS undrained,
              MIN(enqueued_at_ms) AS oldest_enqueued_at_ms
         FROM harness_shared.substrate_outbox
        WHERE drained_at IS NULL
          AND quarantined_at IS NULL
        GROUP BY workspace_id, harness_slug`,
      [],
    );
  } catch {
    return out; // missing table / PG-less → honest zero drain
  }
  for (const r of rows) {
    const undrainedCount = toNum(r.undrained);
    if (undrainedCount <= 0) continue;
    let oldestUndrainedAgeMs: number | null = null;
    if (r.oldest_enqueued_at_ms != null) {
      const oldest = toNum(r.oldest_enqueued_at_ms);
      // Clamp clock skew (a capture ts slightly ahead of `now`) to 0 rather than
      // reporting a negative age.
      if (oldest > 0) oldestUndrainedAgeMs = Math.max(0, now - oldest);
    }
    out.set(`${r.workspace_id}::${r.harness_slug}`, {
      undrainedCount,
      oldestUndrainedAgeMs,
    });
  }
  return out;
}
