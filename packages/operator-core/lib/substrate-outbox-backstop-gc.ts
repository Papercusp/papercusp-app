/**
 * substrate-outbox-backstop-gc.ts — a GLOBAL backstop GC for substrate_outbox.
 *
 * The per-harness inline GC (sync/hyperbee/outbox-drain.ts) only runs for a
 * BOOTED harness and only deletes THAT scope's DRAINED rows. So rows captured
 * under a (workspace_id, harness_slug) whose substrate is NOT booted have no
 * drain AND no inline GC — they accumulate forever. The common cause is a
 * workspace MIS-ROUTE: a write path that silently defaults `workspace_id` to
 * 'default' while the harness's substrate boots under its real workspace, so
 * every capture orphans. (Observed 2026-06-15: 5.3 GB / 53k rows, dominated by
 * papercup plan-family captures under 'default'; plan
 * operator-memory-and-psu-resilience-2026-06-14, D-009/D-014/D-016.) That is
 * the EI-126 102 GB unbounded-outbox class.
 *
 * This backstop, on a DBOS schedule (dbos/periodic-workflows.ts), deletes:
 *   - any DRAINED row past the 24h retention (covers orphaned-scope drained
 *     rows the per-scope inline GC never reaches), and
 *   - any UNDRAINED row older than ORPHAN_UNDRAINED_RETENTION_MS — a healthy
 *     drain marks a row within seconds, so a row left undrained this long is, by
 *     definition, not being drained (orphaned / mis-routed / unmapped table), and
 *   - any UNDRAINED row from a one-shot EPHEMERAL test-hive slug
 *     (EPHEMERAL_SLUG_PATTERNS, e.g. contract-test-*) older than the much shorter
 *     EPHEMERAL_UNDRAINED_RETENTION_MS — these never drain (the hive is torn down
 *     after capture) and would otherwise sit the full 48h, so they are reaped
 *     promptly (infra-fail-fast-build-integrity-2026-06-19 P-010).
 *   - any UNDRAINED row captured under harness_slug='*' older than the short
 *     WILDCARD_UNDRAINED_RETENTION_MS — wildcard is not a concrete harness and
 *     therefore no drain loop can ever boot for it (EI-7179).
 *   - any UNDRAINED row captured under a (workspace_id, harness_slug) pair absent
 *     from the current harness registry older than NON_REGISTRY_UNDRAINED_RETENTION_MS.
 *     A non-registry pair has no boot owner, so waiting 48h just leaves the health
 *     invariant red on rows that cannot drain.
 *
 * It only touches the federation-event QUEUE (substrate_outbox), never the
 * canonical tables (harness_plans / *_consolidated / …). The conservative
 * windows preserve every recent / in-flight row, so it is safe to run globally
 * regardless of which workspaces are booted. It durably bounds the table no
 * matter which tool mis-routes a workspace in the future.
 */

import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

/** Drained rows older than this are GC'd globally. Matches the inline 24h bar
 *  (outbox-drain.ts OUTBOX_GC_AGE_MS) so the two never disagree. */
export const DRAINED_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Undrained rows older than this are treated as orphaned and GC'd. Generous
 *  margin over the ~1s merge-poll cadence — a row a booted drain owns is marked
 *  within seconds, so 48h cannot evict an in-flight row of a healthy scope. */
export const ORPHAN_UNDRAINED_RETENTION_MS = 48 * 60 * 60 * 1000;

/** Undrained rows from a one-shot EPHEMERAL test-hive slug are GC'd on this much
 *  shorter TTL. The contract-test integration suite (and similar) creates a hive,
 *  captures a couple of outbox rows, then tears the hive down — so those rows NEVER
 *  drain (no booted substrate owns them) and would otherwise sit for the full 48h
 *  ORPHAN_UNDRAINED_RETENTION_MS window. They are known-dead the moment they're
 *  captured. (infra-fail-fast-build-integrity-2026-06-19 P-010: ~132 dead
 *  contract-test hives × ~2 rows accumulating continuously.) 2h is still vastly
 *  longer than the ~1s drain cadence, so it can never drop an in-flight row of a
 *  real scope that merely shares the prefix. */
export const EPHEMERAL_UNDRAINED_RETENTION_MS = 2 * 60 * 60 * 1000;

/** Undrained rows captured under harness_slug='*' are known-undrainable: the
 *  substrate boot/drain contract is per concrete harness slug, and work-item
 *  scope validation now rejects `harness:*`. Keep a short grace window in case
 *  an old live process still emits one during rollout, then reap it so the
 *  outbox health invariant measures drainable backlog instead of permanent
 *  wildcard residue. */
export const WILDCARD_UNDRAINED_RETENTION_MS = 5 * 60 * 1000;

/** Undrained rows whose (workspace_id, harness_slug) pair is not in the current
 *  harness registry are orphaned for the same reason as wildcard rows: no drain
 *  loop can be started for a non-existent registry project. Keep a grace window
 *  for registry/write-order races, then reap them so the health check focuses on
 *  drainable backlog. */
export const NON_REGISTRY_UNDRAINED_RETENTION_MS = 5 * 60 * 1000;

/** SQL LIKE patterns identifying one-shot EPHEMERAL test-hive slugs whose captures
 *  will never drain. Kept deliberately narrow (only the unambiguous one-shot
 *  contract-test pattern) — recurring test routines (xbench/p016/canary) legitimately
 *  boot + drain, so they are NOT matched and fall to the normal 48h orphan TTL. */
export const EPHEMERAL_SLUG_PATTERNS: readonly string[] = ['contract-test-%'];

/** Max rows deleted per sweep — bounded so a first/large sweep holds row locks
 *  briefly; the next tick clears any remainder. */
export const BACKSTOP_GC_BATCH = 50_000;

export interface BackstopGcCutoffs {
  /** drained rows older than this (epoch-ms) are GC'd. */
  drainedBefore: number;
  /** undrained rows (any scope) older than this are GC'd as orphaned. */
  undrainedBefore: number;
  /** undrained rows from an ephemeral test-hive slug older than this are GC'd. */
  ephemeralUndrainedBefore: number;
  /** undrained wildcard rows older than this are GC'd. */
  wildcardUndrainedBefore: number;
  /** undrained rows for non-registry harness pairs older than this are GC'd. */
  nonRegistryUndrainedBefore: number;
  /** the ephemeral-slug LIKE patterns the ephemeral cutoff applies to. */
  ephemeralSlugPatterns: readonly string[];
}

/** Pure: derive the three retention cutoffs from a clock. Unit-testable without PG;
 *  the SQL in runSubstrateOutboxBackstopGc consumes exactly these. */
export function backstopGcCutoffs(now: number): BackstopGcCutoffs {
  return {
    drainedBefore: now - DRAINED_RETENTION_MS,
    undrainedBefore: now - ORPHAN_UNDRAINED_RETENTION_MS,
    ephemeralUndrainedBefore: now - EPHEMERAL_UNDRAINED_RETENTION_MS,
    wildcardUndrainedBefore: now - WILDCARD_UNDRAINED_RETENTION_MS,
    nonRegistryUndrainedBefore: now - NON_REGISTRY_UNDRAINED_RETENTION_MS,
    ephemeralSlugPatterns: EPHEMERAL_SLUG_PATTERNS,
  };
}

export interface BackstopGcOptions {
  /** epoch-ms clock override (tests). Defaults to Date.now(). */
  now?: number;
  /** sql handle override (tests). Defaults to the org admin pool (RLS-bypass). */
  sql?: postgres.Sql;
  /**
   * WI-1634 (WI-900 M3 residual): currently-STARTED (workspaceId, installSlug) pairs
   * whose undrained rows are EXEMPT from the 48h orphan reap. A started hive's drain
   * may be legitimately HALTED on a recoverable cause (e.g. an epoch key not yet
   * local on this device — the C-001 re-key path outbox-drain.ts halts+retries on;
   * WI-887 shrinks how often/long this happens but does not eliminate it) — that is
   * NOT the same thing as a truly-orphaned / mis-routed harness_slug this GC exists
   * to catch (M1's dominant real-world case: a write path that silently defaults
   * workspace_id, so NO hive is ever started under that (workspace, slug) pair at
   * all). Keying the exemption on the EXACT (workspace_id, harness_slug) pair means
   * a mis-routed/retired-slug row (e.g. a pre-rename 'papercup' capture) still falls
   * OUTSIDE the exemption — the currently-started hive lives under the NEW slug, not
   * the orphaned one — so M1's original catch is preserved. Defaults to `[]` (no
   * exemption — today's behavior, and test-safe: this function must stay a pure
   * function of its OWN injected `sql`, never a second untracked connection) — the
   * production scheduler (dbos/periodic-workflows.ts) passes the real
   * `listStartedHives()` read explicitly.
   */
  startedHives?: ReadonlyArray<{ workspaceId: string; installSlug: string }>;
}

/**
 * EI-21111467164675531: the set of harness_slug values in `workspaceId` that
 * currently have SOME possible drain-loop owner — a `harness_registry`
 * project entry, or a currently-STARTED pot (the identical two conditions
 * this module's own NON_REGISTRY reap leg above checks via `NOT EXISTS`).
 * Exported so the outbox-health SLO monitor (`coord-invariant-actions.ts`
 * `runSharedHiveLeg`) can defer to the EXACT same classification this GC uses
 * instead of re-deriving a second copy that could disagree.
 *
 * Why this matters: a harness_slug with neither owner can NEVER boot a drain
 * loop, so its undrained rows are this GC's job alone (see the module header)
 * — yet this GC only sweeps on a 6-HOURLY cadence (`dbos/periodic-workflows.ts`
 * `outboxBackstopGc`), far coarser than the monitor's default 30-min age SLO.
 * Without this, the monitor fires — and re-files the SAME "shared-hive
 * invariant" bug every tick, forever — on a structurally undrainable row long
 * before this GC's next sweep can land, for a scope nobody can ever green (no
 * drain loop exists to fix). Live case: `larkfield-android-20260821`, a
 * harness with zero registry/started presence, alarmed on a single row aged
 * past the 30-min SLO although the GC had already reaped it by the time the
 * ticket was investigated.
 */
export async function loadKnownOutboxOwnerSlugs(
  sql: postgres.Sql,
  workspaceId: string,
  startedHives: ReadonlyArray<{ workspaceId: string; installSlug: string }> = [],
): Promise<Set<string>> {
  const rows = await sql<Array<{ slug: string | null }>>`
    SELECT DISTINCT project->>'slug' AS slug
      FROM harness_shared.harness_registry r,
           jsonb_array_elements(COALESCE(r.payload->'projects', '[]'::jsonb)) AS project
     WHERE r.workspace_id = ${workspaceId}`;
  const known = new Set<string>();
  for (const r of rows) if (r.slug) known.add(r.slug);
  for (const h of startedHives) if (h.workspaceId === workspaceId) known.add(h.installSlug);
  return known;
}

/**
 * Run one global backstop sweep. Returns the number of outbox rows deleted.
 * Best-effort: the caller (the scheduled tick) tolerates a thrown error.
 */
export async function runSubstrateOutboxBackstopGc(
  opts: BackstopGcOptions = {},
): Promise<{ deleted: number }> {
  const now = opts.now ?? Date.now();
  const sql = opts.sql ?? getOrgPg().sql;
  const c = backstopGcCutoffs(now);
  const started = opts.startedHives ?? [];
  const startedWs = started.map((h) => h.workspaceId);
  const startedSlugs = started.map((h) => h.installSlug);
  const rows = await sql<Array<{ n: number }>>`
    WITH del AS (
      DELETE FROM harness_shared.substrate_outbox
       WHERE id IN (
         SELECT id
           FROM harness_shared.substrate_outbox
          WHERE (drained_at IS NOT NULL AND drained_at < ${c.drainedBefore})
             OR (
                  drained_at IS NULL AND ts < ${c.undrainedBefore}
                  -- WI-1634: a currently-started hive's undrained rows are exempt —
                  -- its drain may be halted on a recoverable cause, not orphaned.
                  AND NOT EXISTS (
                    SELECT 1
                      FROM unnest(${startedWs}::text[], ${startedSlugs}::text[]) AS s(ws, slug)
                     WHERE s.ws = harness_shared.substrate_outbox.workspace_id
                       AND s.slug = harness_shared.substrate_outbox.harness_slug
                  )
                )
             OR (drained_at IS NULL     AND ts < ${c.ephemeralUndrainedBefore}
                 AND harness_slug LIKE ANY (${[...c.ephemeralSlugPatterns]}))
             OR (drained_at IS NULL AND ts < ${c.wildcardUndrainedBefore}
                 AND harness_slug = '*')
             OR (
                  drained_at IS NULL AND ts < ${c.nonRegistryUndrainedBefore}
                  -- Preserve the same started-hive exemption as the 48h orphan
                  -- clause: a running-but-not-registry-listed edge case is still
                  -- a possible owner, while a non-started non-registry pair is
                  -- provably orphaned.
                  AND NOT EXISTS (
                    SELECT 1
                      FROM unnest(${startedWs}::text[], ${startedSlugs}::text[]) AS s(ws, slug)
                     WHERE s.ws = harness_shared.substrate_outbox.workspace_id
                       AND s.slug = harness_shared.substrate_outbox.harness_slug
                  )
                  AND NOT EXISTS (
                    SELECT 1
                      FROM harness_shared.harness_registry r,
                           jsonb_array_elements(COALESCE(r.payload->'projects', '[]'::jsonb)) AS project
                     WHERE r.workspace_id = harness_shared.substrate_outbox.workspace_id
                       AND project->>'slug' = harness_shared.substrate_outbox.harness_slug
                  )
                )
          LIMIT ${BACKSTOP_GC_BATCH}
       )
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM del
  `;
  return { deleted: rows[0]?.n ?? 0 };
}
