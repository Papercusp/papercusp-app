/**
 * The precompute substrate for expensive DERIVED sync-resolver reads
 * (precompute-derived-sync-reads-2026-07-19 P-002, WI-5460).
 *
 * ── The problem this exists to remove ────────────────────────────────────────
 * An audit timed all 200 registered sync `queryName`s. Three exceeded 12s
 * (`learning.soakReport` 27.3s, `storage.usage` 20.0s, `plans.lint` 13.8s) while
 * pure DB reads on the same host were 3-20ms. Each ran expensive derived work --
 * a `journalctl` subprocess, a recursive du-style disk walk, a full-corpus plan
 * lint -- SYNCHRONOUSLY on a user-facing read, per page load, uncached.
 *
 * ── The shape of the fix ─────────────────────────────────────────────────────
 * A producer registers its compute here. A scheduled routine
 * (`system:precompute-derived-reads`) runs the due producers and writes each
 * result to `harness_shared.derived_read_snapshots`. The resolver then does a
 * plain SELECT. The cost moves to write-time, where no user is waiting.
 *
 * ── Why not a cache (D-001, owner-chosen) ────────────────────────────────────
 * A cache still pays the FULL cost on cold load, so the first user of every TTL
 * window eats the 20s. And decisively: the shipped desktop app runs embedded
 * Postgres on hosts with no systemd (macOS, containers), where `journalctl` does
 * not exist at all -- a read path that shells out to a host binary there does not
 * degrade, it fails permanently. Precompute + a capability-detecting producer is
 * the only shape that is correct on the real shipping target.
 *
 * ── The invariant that keeps this honest (D-003) ─────────────────────────────
 * A READ NEVER COMPUTES. `readDerivedSnapshot` returns the last snapshot, or an
 * empty result with a staleness marker, and lets the routine fill it. A
 * compute-on-miss path would reintroduce exactly the cold-load stall this exists
 * to remove -- it is the single most tempting wrong turn here, so it is stated
 * as an invariant rather than left to judgment.
 *
 * The one exception is the explicit flag-OFF escape hatch: with
 * FLAGS.PRECOMPUTE_DERIVED_READS off, reads fall back to inline compute, i.e.
 * the exact pre-fix behavior. That is a deliberate kill-switch, not a miss path.
 */
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { systemDistinctId } from '../flag-distinct-id';
import { activeWorkspaceId } from '../workspace-registry';
import { trackDetached } from '../detached-imports';

/** Sentinel `harness_slug` for a workspace-global producer (see the migration). */
const GLOBAL_SCOPE = '';

export interface DerivedReadProducer<T = unknown> {
  /** Stable key; by convention the sync queryName it serves (e.g. 'storage.usage'). */
  key: string;
  /**
   * How stale a snapshot may get before the routine recomputes it. The routine's
   * own cron sets the FLOOR on freshness; this sets the ceiling on how often an
   * expensive producer actually runs.
   */
  ttlMs: number;
  /**
   * Bump when the payload SHAPE changes. A snapshot written by an older version
   * is ignored by readers rather than fed to a client that no longer understands
   * it (it reads as a miss, and the routine overwrites it on the next fire).
   */
  producerVersion: number;
  /** 'workspace' ⇒ one snapshot per workspace; 'harness' ⇒ one per harness. */
  scope: 'workspace' | 'harness';
  /**
   * Opt OUT of the default `precompute-derived-reads` sweep (EI-19457924854150358).
   * Such a producer runs ONLY when named explicitly in `refreshDerivedReads({ only })`.
   * By default that means its dedicated routine owns the fill and a read never warms
   * it (EI-19480218051289304). `refreshOnRead` is the explicit demand-driven variant:
   * a missing/stale read schedules the named refresh instead of a periodic routine.
   *
   * ⚠ This exists because `ttlMs` alone CANNOT express "too expensive for the shared
   * tick". Producers run SEQUENTIALLY (see refreshDerivedReads below) and the routine
   * is seeded `concurrency: 'skip'`, so a producer's cost is charged to the whole
   * sweep on every pass where it is due — not amortised by its ttl. The ttl-ascending
   * ordering (WI-5471) bounds head-of-line blocking only while the heaviest producer
   * is seconds-scale (soakReport ~27s, storage.usage ~20s, plans.lint ~13.8s). A
   * MINUTES-scale producer defeats it outright: it holds the loop long enough that the
   * next several 2-min ticks are skipped, starving the liveness-sensitive short-ttl
   * producers (serviceHealth, ttl 90s — the short cadence exists for it).
   *
   * So the rule is about DURATION, not frequency: if `compute` can take longer than
   * roughly one cron interval, set this and give it its own routine. A long ttl is
   * NOT a substitute — it changes how OFTEN you pay the cost, never how LONG the
   * shared tick is blocked when you do.
   */
  excludeFromDefaultSweep?: boolean;
  /**
   * Refresh a missing OR stale snapshot in the background when a read observes it.
   * The read still returns immediately and never awaits `compute` (D-003).
   *
   * Pair this with `excludeFromDefaultSweep` for a demand-driven producer: zero
   * reads means zero computes, while the first real consumer heals an absent or
   * expired snapshot. An excluded producer without this flag is owned solely by
   * its dedicated routine and must never be warmed by a reader.
   */
  refreshOnRead?: boolean;
  /** The expensive computation. Runs on the routine's thread, never a read. */
  compute: (ctx: { workspaceId: string; harnessSlug: string }) => Promise<T>;
}

const REGISTRY = new Map<string, DerivedReadProducer>();

export function registerDerivedRead<T>(producer: DerivedReadProducer<T>): void {
  if (REGISTRY.has(producer.key)) {
    // Not fatal: module re-entry under a hot reload re-registers. Last wins.
    console.warn(`[derived-reads] re-registering producer "${producer.key}"`);
  }
  REGISTRY.set(producer.key, producer as DerivedReadProducer);
}

export function listDerivedReadProducers(): DerivedReadProducer[] {
  return [...REGISTRY.values()];
}

/** Test seam — drop registrations between cases. */
export function __clearDerivedReadRegistryForTest(): void {
  REGISTRY.clear();
}

export interface DerivedSnapshotMeta {
  /** Epoch ms the payload was computed; null when no snapshot exists yet. */
  computedAt: number | null;
  /** How long that compute took, for the Settings/observability surfaces. */
  computeMs: number | null;
  /** True when there is no usable snapshot (never computed, or shape-superseded). */
  missing: boolean;
  /** True when the snapshot is older than the producer's ttl (still served). */
  stale: boolean;
  /** Last compute error, if the most recent refresh failed. */
  error: string | null;
  /** False when the flag is OFF and this result came from an inline compute. */
  precomputed: boolean;
}

export interface DerivedSnapshotResult<T> {
  payload: T | null;
  meta: DerivedSnapshotMeta;
}

/**
 * Keys with a background warm-up in flight. Without this, every viewer of a cold
 * panel — and every 3s sync poll — would each kick off its own 70s disk walk, so
 * the miss path would DDoS the operator precisely when it is least able to cope.
 * Module-scoped because the stampede to prevent is within one process.
 */
const warmingKeys = new Set<string>();

/**
 * Keys whose read-driven refresh was DECLINED because their own routine owns the fill.
 * Logged once per key per process: a missing panel is worth explaining, but the
 * read that finds it missing runs on every 3s sync poll.
 */
const declinedWarmKeys = new Set<string>();

/** Fire-and-forget fill for a missing or stale snapshot. Never awaited by a read. */
function refreshSnapshotFromRead(key: string, workspaceId: string, harnessSlug: string): void {
  // EI-19480218051289304: an `excludeFromDefaultSweep` producer does NOT warm
  // from a read by default. The named refresh (`only: [key]`) overrides exclusion,
  // so allowing it implicitly would put a dedicated-routine producer back onto an
  // unscheduled trigger. WI-7230 adds the deliberate exception: `refreshOnRead`
  // marks a producer as demand-driven, where the absence of reads is the scheduling
  // policy and a deduplicated background refresh is exactly the requested behavior.
  const excludedProducer = REGISTRY.get(key);
  if (excludedProducer?.excludeFromDefaultSweep && !excludedProducer.refreshOnRead) {
    if (!declinedWarmKeys.has(key)) {
      declinedWarmKeys.add(key);
      console.warn(
        `[derived-reads] snapshot "${key}" is missing; NOT warming from a read — ` +
          `this excludeFromDefaultSweep producer is filled only by its own dedicated routine.`,
      );
    }
    return;
  }

  const guard = `${workspaceId}::${harnessSlug}::${key}`;
  if (warmingKeys.has(guard)) return;
  warmingKeys.add(guard);
  void refreshDerivedReads({ workspaceId, harnessSlug, only: [key], force: true })
    .catch((err) => {
      console.warn(`[derived-reads] background warm-up for "${key}" failed:`, err instanceof Error ? err.message : err);
    })
    .finally(() => {
      warmingKeys.delete(guard);
    });
}

/** Test seam — drop in-flight warm-up guards between cases. */
export function __clearWarmingKeysForTest(): void {
  warmingKeys.clear();
  declinedWarmKeys.clear();
}

const MISSING_META: DerivedSnapshotMeta = {
  computedAt: null,
  computeMs: null,
  missing: true,
  stale: false,
  error: null,
  precomputed: true,
};

/**
 * Read a producer's latest snapshot. NEVER computes (D-003) unless the flag is
 * explicitly OFF, in which case it falls back to inline compute -- the pre-fix
 * behavior, kept as a live escape hatch.
 */
export async function readDerivedSnapshot<T>(
  key: string,
  opts: { harnessSlug?: string } = {},
): Promise<DerivedSnapshotResult<T>> {
  const producer = REGISTRY.get(key);
  if (!producer) {
    console.warn(`[derived-reads] read of unregistered producer "${key}"`);
    return { payload: null, meta: MISSING_META };
  }

  const workspaceId = activeWorkspaceId();
  const harnessSlug = producer.scope === 'workspace' ? GLOBAL_SCOPE : (opts.harnessSlug ?? GLOBAL_SCOPE);

  let enabled = true;
  try {
    enabled = await getFlag(FLAGS.PRECOMPUTE_DERIVED_READS, systemDistinctId());
  } catch {
    // Flag read failed -- prefer the precomputed path (the correct behavior on
    // the shipping target) rather than silently falling back to a 20s inline walk.
    enabled = true;
  }

  if (!enabled) {
    const startedAt = Date.now();
    const payload = (await producer.compute({ workspaceId, harnessSlug })) as T;
    return {
      payload,
      meta: {
        computedAt: startedAt,
        computeMs: Date.now() - startedAt,
        missing: false,
        stale: false,
        error: null,
        precomputed: false,
      },
    };
  }

  const { sql } = getOrgPg();
  const rows = (await sql`
    SELECT payload, computed_at, compute_ms, producer_version, error
      FROM harness_shared.derived_read_snapshots
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND key = ${key}
     LIMIT 1
  `) as Array<{
    payload: unknown;
    computed_at: string | number | null;
    compute_ms: number | null;
    producer_version: number | null;
    error: string | null;
  }>;

  const row = rows[0];
  // A snapshot from an older producer version is treated as absent: serving a
  // superseded SHAPE to a client is worse than serving nothing.
  if (!row || Number(row.producer_version ?? 1) !== producer.producerVersion) {
    // Kick a BACKGROUND fill so a cold database heals itself instead of showing
    // an empty panel until the next cron tick (up to 5 minutes on a fresh
    // install, or right after a producerVersion bump).
    //
    // This does NOT violate D-003: the read still returns immediately and never
    // awaits the compute. The invariant is "a read never WAITS on the expensive
    // work", not "a miss is never noticed" — a read that blocked here would be
    // exactly the cold-load stall precompute exists to remove.
    //
    // WI-7226: but do NOT warm when the stored version is NEWER than ours —
    // this process is the superseded one, its write would be refused by the
    // downgrade guard, and warming on every read turns a rolling deploy into a
    // compute storm. Return the miss and let the newer process serve.
    const storedVersion = row ? Number(row.producer_version ?? 1) : null;
    if (storedVersion == null || storedVersion <= producer.producerVersion) {
      refreshSnapshotFromRead(producer.key, workspaceId, harnessSlug);
    }
    return { payload: null, meta: MISSING_META };
  }

  const computedAt = Number(row.computed_at ?? 0) || null;
  const stale = computedAt !== null && Date.now() - computedAt > producer.ttlMs;
  // WI-7230: a demand-driven producer has no periodic sweep to heal a stale
  // snapshot. Notice the stale read, return the last-known-good payload NOW,
  // and refresh behind it. `warmingKeys` collapses repeated readers to one
  // in-process compute, exactly as it does for a cold miss.
  if (stale && producer.refreshOnRead) {
    refreshSnapshotFromRead(producer.key, workspaceId, harnessSlug);
  }
  return {
    payload: row.payload as T,
    meta: {
      computedAt,
      computeMs: row.compute_ms ?? null,
      missing: false,
      stale,
      error: row.error ?? null,
      precomputed: true,
    },
  };
}

/**
 * Convenience for the common resolver shape: a snapshot holding an ARRAY of rows.
 * Returns `[]` on a miss so a panel renders empty rather than throwing, and
 * attaches the staleness meta to `rows[0]._meta` following the house
 * `attachListMeta` convention so a panel can show "as of HH:MM".
 */
export async function readDerivedSnapshotRows<T>(key: string, opts: { harnessSlug?: string } = {}): Promise<T[]> {
  const { payload, meta } = await readDerivedSnapshot<T[]>(key, opts);
  const rows = Array.isArray(payload) ? payload : [];
  if (rows.length > 0 && rows[0] && typeof rows[0] === 'object') {
    (rows[0] as Record<string, unknown>)._meta = {
      ...((rows[0] as Record<string, unknown>)._meta as Record<string, unknown> | undefined),
      derivedRead: meta,
    };
  }
  return rows;
}

export interface RefreshOutcome {
  key: string;
  harnessSlug: string;
  refreshed: boolean;
  skippedFresh: boolean;
  computeMs: number | null;
  error: string | null;
}

/**
 * Compute + persist every producer whose snapshot is due. Called by the
 * `system:precompute-derived-reads` routine action.
 *
 * Replay-safe (routine handlers re-run from the top on recovery): every write is
 * an idempotent upsert, and a producer whose snapshot is still fresh is skipped,
 * so a replay costs a few SELECTs rather than re-running a 20s walk.
 *
 * A FAILING producer never clears a good payload. The last-known-good snapshot
 * keeps serving and the error is recorded alongside it -- a transient
 * `journalctl` hiccup must not blank the panel.
 */
export async function refreshDerivedReads(ctx: {
  workspaceId: string;
  harnessSlug: string;
  /** Recompute regardless of ttl (used by the seed/backfill path). */
  force?: boolean;
  /** Restrict to these keys; default all registered. */
  only?: string[];
}): Promise<RefreshOutcome[]> {
  const { sql } = getOrgPg();
  const outcomes: RefreshOutcome[] = [];
  // Shortest-ttl FIRST (WI-5471): producers run sequentially, so a heavy long-walk
  // producer must never head-of-line-block the liveness-sensitive short-ttl ones in
  // the same pass. ttl already encodes "how fresh this must be" (see producers.ts
  // header), and the heavy producers (storage.usage 30m, plans.lint 6h) have the
  // longest ttls precisely because their signal moves slowly — so ordering by ttl
  // ascending refreshes serviceHealth/gitPipeline/dev.* (90s) before the multi-second
  // walks even on a pass where those walks are due. Producers are independent (each
  // writes its own snapshot key), so the order is free to choose.
  // EI-19457924854150358: an `excludeFromDefaultSweep` producer is skipped by the
  // DEFAULT pass (too long-running for the shared 2-min tick — see the field's doc)
  // but still runs when named explicitly in `only`, which is how its own dedicated
  // routine drives it. An explicit request always wins over the exclusion.
  const producers = listDerivedReadProducers()
    .filter((p) => (ctx.only ? ctx.only.includes(p.key) : !p.excludeFromDefaultSweep))
    .sort((a, b) => a.ttlMs - b.ttlMs);

  for (const producer of producers) {
    const harnessSlug = producer.scope === 'workspace' ? GLOBAL_SCOPE : ctx.harnessSlug;

    // One indexed-row read: freshness gate (non-force) AND the prior payload's
    // md5, so a refresh whose payload actually CHANGED can push-invalidate the
    // panes reading this key (push-audit 2026-07-26 — snapshots refreshed on
    // ttl but never notified, so long-open panes served "as of 2h ago" data
    // until a remount; the owner hit this on learning.releaseReadiness et al).
    const existing = (await sql`
      SELECT computed_at, producer_version, md5(payload::text) AS payload_md5
        FROM harness_shared.derived_read_snapshots
       WHERE workspace_id = ${ctx.workspaceId}
         AND harness_slug = ${harnessSlug}
         AND key = ${producer.key}
       LIMIT 1
    `) as Array<{ computed_at: string | number | null; producer_version: number | null; payload_md5: string | null }>;
    const row = existing[0];

    // WI-7226: a NEWER producerVersion already owns this key, so this process
    // is running superseded code. Recomputing would burn the producer's full
    // cost (13.8s plans.lint / 20s storage.usage / 27s soakReport) on EVERY
    // tick — the freshness check below counts a version mismatch as stale, so
    // it never backs off — and the write would be refused anyway by the
    // downgrade guard. Skip outright and let the newer process own it. Honored
    // even under `force`: force means "ignore the ttl", not "downgrade the row".
    if (row && Number(row.producer_version ?? 1) > producer.producerVersion) {
      outcomes.push({
        key: producer.key,
        harnessSlug,
        refreshed: false,
        skippedFresh: true,
        computeMs: null,
        error: null,
      });
      continue;
    }

    if (!ctx.force) {
      const fresh =
        row &&
        Number(row.producer_version ?? 1) === producer.producerVersion &&
        Date.now() - (Number(row.computed_at ?? 0) || 0) < producer.ttlMs;
      if (fresh) {
        outcomes.push({
          key: producer.key,
          harnessSlug,
          refreshed: false,
          skippedFresh: true,
          computeMs: null,
          error: null,
        });
        continue;
      }
    }

    const startedAt = Date.now();
    try {
      const payload = await producer.compute({ workspaceId: ctx.workspaceId, harnessSlug });
      const computeMs = Date.now() - startedAt;
      const written = (await sql`
        INSERT INTO harness_shared.derived_read_snapshots
          (workspace_id, harness_slug, key, payload, computed_at, compute_ms, producer_version, error, error_at, updated_at)
        VALUES (${ctx.workspaceId}, ${harnessSlug}, ${producer.key},
                ${JSON.stringify(payload ?? null)}::text::jsonb,
                ${startedAt}, ${computeMs}, ${producer.producerVersion}, NULL, NULL, ${Date.now()})
        ON CONFLICT (workspace_id, harness_slug, key) DO UPDATE SET
          payload = EXCLUDED.payload,
          computed_at = EXCLUDED.computed_at,
          compute_ms = EXCLUDED.compute_ms,
          producer_version = EXCLUDED.producer_version,
          error = NULL,
          error_at = NULL,
          updated_at = EXCLUDED.updated_at
        WHERE harness_shared.derived_read_snapshots.producer_version IS NULL
           OR harness_shared.derived_read_snapshots.producer_version <= EXCLUDED.producer_version
        RETURNING md5(payload::text) AS payload_md5
      `) as Array<{ payload_md5: string | null }>;
      // ── WI-7226: NEVER let an older producerVersion clobber a newer snapshot ──
      //
      // There is ONE row per (workspace, harness, key) but THREE long-running
      // writers on this box (:3170 staging, :3070 release, papercup-bg-host),
      // none of which hot-reload. So after any producerVersion bump they
      // disagree until each restarts. Without the WHERE above, the older one
      // overwrites the newer one, the newer READER then rejects the row
      // (`producer_version !== mine` → treated as absent, :204), and the read
      // goes INTERMITTENTLY EMPTY while both sides re-warm — measured live on
      // plans.lint: v4 written 03:57:01Z, clobbered back to v2 at 03:58:12Z,
      // ten consecutive reads returning 0 rows, ~14-22s of heavy compute burnt
      // per cycle. The read guard's own rule — "serving a superseded SHAPE is
      // worse than serving nothing" — has to hold on the WRITE side too, or it
      // is just a race the reader always loses.
      //
      // ⚠ A REFUSED update returns NO row, so `written[0]` is undefined. That
      // must read as "nothing changed" — firing notifySyncInvalidate here would
      // push subscribers to re-read a snapshot this process did not write.
      const refused = written.length === 0;
      const changed = !refused && (!row || written[0]?.payload_md5 !== row.payload_md5);
      if (changed) {
        void trackDetached(import('../sync-sse'))
          .then((m) => m.notifySyncInvalidate(producer.key))
          .catch(() => {});
      }
      outcomes.push({
        key: producer.key,
        harnessSlug,
        refreshed: true,
        skippedFresh: false,
        computeMs,
        error: null,
      });
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      // Record the failure WITHOUT touching payload/computed_at, so the
      // last-known-good result keeps serving.
      await sql`
        INSERT INTO harness_shared.derived_read_snapshots
          (workspace_id, harness_slug, key, payload, computed_at, producer_version, error, error_at, updated_at)
        VALUES (${ctx.workspaceId}, ${harnessSlug}, ${producer.key}, 'null'::jsonb, 0,
                ${producer.producerVersion}, ${message}, ${Date.now()}, ${Date.now()})
        ON CONFLICT (workspace_id, harness_slug, key) DO UPDATE SET
          error = EXCLUDED.error,
          error_at = EXCLUDED.error_at,
          updated_at = EXCLUDED.updated_at
      `;
      outcomes.push({
        key: producer.key,
        harnessSlug,
        refreshed: false,
        skippedFresh: false,
        computeMs: Date.now() - startedAt,
        error: message,
      });
    }
  }

  return outcomes;
}
