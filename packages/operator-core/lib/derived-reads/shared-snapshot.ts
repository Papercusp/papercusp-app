/**
 * A cross-process SHARED SNAPSHOT over the same `harness_shared.derived_read_snapshots`
 * table the precompute substrate uses — but for a DIFFERENT access shape than a
 * derived-read producer (precompute-sync-reads-phase2 P-001).
 *
 * ── Why this is NOT a `registerDerivedRead` producer ─────────────────────────
 * A derived producer enforces D-003 ("a READ never computes"): the routine writes,
 * the resolver only SELECTs. That is correct for an expensive derived read whose
 * consumer can tolerate the routine's cron cadence.
 *
 * `overwatch.snapshot` / `health.snapshot` are DIFFERENT: they are already served
 * warm-and-live from an in-process `SystemHealth` cache that a 30s tick refreshes
 * and `notifySyncInvalidate`s (SSE-live on status change). Making them derived
 * producers would coarsen that 30s liveness down to the 2-min routine floor — the
 * "blindly precompute over a liveness pane" anti-pattern. The ONLY real gap is a
 * reader PROCESS that never runs the tick (the :3170 staging operator, a utility
 * host, or any process in the ~30s window right after boot): its in-process cache
 * is cold, so it pays the full ~15-collector aggregation (incl. the ~2.5s gateway
 * probe) on the user's read path.
 *
 * The fix is therefore a shared CACHE, not a producer: the tick (on whatever host
 * runs it) writes its computed `SystemHealth` here, and the COLD read path on any
 * OTHER process reads that shared row — a plain SELECT — instead of blocking on a
 * live recompute. The 30s tick + its invalidations stay the writer, so liveness is
 * unchanged; a cold reader simply gets the last shared snapshot (≤ the writer's
 * cadence old) instantly rather than recomputing from scratch.
 *
 * Table access lives HERE, in the derived-reads module that owns the table, rather
 * than raw SQL scattered across system-health — but it is deliberately kept out of
 * the producer REGISTRY so the D-003 read-never-computes invariant on real
 * producers stays clean.
 */
import { getOrgPg } from '@papercusp/db-org';

/** Sentinel `harness_slug` for a workspace-global snapshot (matches the substrate). */
const GLOBAL_SCOPE = '';

export interface SharedSnapshotResult<T> {
  payload: T;
  /** Epoch ms the payload was computed. */
  computedAt: number;
  /** Age in ms at read time. */
  ageMs: number;
}

/**
 * Persist a workspace-scoped shared snapshot under `key`. Idempotent upsert.
 * `version` gates shape compatibility: a reader passing a different version treats
 * the row as absent (never fed a stale shape). Fail-soft — a write failure is
 * swallowed by the caller; the in-process cache is still authoritative on the
 * writer host, so a failed shared write only forgoes the cross-process benefit.
 */
export async function writeSharedSnapshot<T>(
  key: string,
  workspaceId: string,
  payload: T,
  version: number,
): Promise<void> {
  const { sql } = getOrgPg();
  const now = Date.now();
  await sql`
    INSERT INTO harness_shared.derived_read_snapshots
      (workspace_id, harness_slug, key, payload, computed_at, compute_ms, producer_version, error, error_at, updated_at)
    VALUES (${workspaceId}, ${GLOBAL_SCOPE}, ${key},
            ${JSON.stringify(payload ?? null)}::text::jsonb,
            ${now}, NULL, ${version}, NULL, NULL, ${now})
    ON CONFLICT (workspace_id, harness_slug, key) DO UPDATE SET
      payload = EXCLUDED.payload,
      computed_at = EXCLUDED.computed_at,
      producer_version = EXCLUDED.producer_version,
      error = NULL,
      error_at = NULL,
      updated_at = EXCLUDED.updated_at
  `;
}

/**
 * Read the workspace-scoped shared snapshot for `key`. Returns null on a miss, a
 * version mismatch, or when the row is older than `maxAgeMs` (a too-stale shared
 * snapshot is worse than letting the caller decide to recompute). NEVER computes.
 */
export async function readSharedSnapshot<T>(
  key: string,
  workspaceId: string,
  version: number,
  maxAgeMs: number,
): Promise<SharedSnapshotResult<T> | null> {
  const { sql } = getOrgPg();
  const rows = (await sql`
    SELECT payload, computed_at, producer_version
      FROM harness_shared.derived_read_snapshots
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${GLOBAL_SCOPE}
       AND key = ${key}
     LIMIT 1
  `) as Array<{ payload: unknown; computed_at: string | number | null; producer_version: number | null }>;

  const row = rows[0];
  if (!row || Number(row.producer_version ?? 0) !== version) return null;

  const computedAt = Number(row.computed_at ?? 0) || 0;
  const ageMs = Date.now() - computedAt;
  if (computedAt <= 0 || ageMs > maxAgeMs) return null;

  return { payload: row.payload as T, computedAt, ageMs };
}
