/**
 * pot-git-gc-routine — the per-pot-home G-9 gc cadence
 * (p2p-git-live-activation-2026-07-09 / P-205). A `harness_shared.routines`
 * row with `target_role='system:pot-git-gc'`, `tier='ephemeral'`
 * (schedule-inventory-and-ephemeral-tier-2026-06-26 P-010/D-006) — a
 * frequent in-process cadence armed by the per-host ephemeral executor
 * (`lib/dbos/ephemeral-executor.ts`), NEVER a bare `setInterval`
 * (`lint:no-raw-setinterval`).
 *
 * Mirrors git-sync-routine.ts's shape (its own bespoke `*-routine.ts`
 * companion to a `*-action.ts` system action) rather than going through
 * blueprint `triggers.schedule` materialization: gc is a HOME-level concern
 * (one shared hive-git bare store per (potHomeSlug, repoKey) — storage.ts's
 * `hiveGitRepoPath`), not a per-blueprint-install generic cadence, so it gets
 * its own seed/read/remove trio exactly like git-sync's.
 *
 * The row carries NO cron / next_fire_at (ephemeral rows are excluded from
 * the DBOS `routinesTick`'s `tier='durable'` filter — schedule-next
 * computation is meaningless here); `trigger_config.interval_sec` is the
 * cadence the ephemeral executor reads directly.
 *
 * Idempotent on (install_slug, name) — the routines table's existing unique
 * key (git-sync-any-hive-2026-06-12). `installSlug` here is the hive HOME's
 * own harness install slug (== `potHomeSlug`), so one row per home, not per
 * member.
 */
import type { Sql } from 'postgres';
import { getOrgPg, type RoutineRow } from '@papercusp/db-org';

/**
 * POT LEXICON (retire-mug-kettle-su-only-2026-08-09 P-051). Renamed from
 * `hive-git-gc` / `system:hive-git-gc`. This routine is POT SUBSTRATE, not
 * mug/kettle/cup tier: it gc's the p2p hive-git bare store behind a Pot's git
 * plane and self-gates on `getPotGitMode`, consulting no retirement flag. D-003
 * KEEPS pot substrate, so the settlement here is RENAME, not retire.
 *
 * ⚠ The routines table's unique key is (install_slug, name), and `routineId()`
 * derives the row id from `name` — so changing this VALUE re-keys the row. The
 * three live rows were migrated in the same change (P-051); a fresh upsert
 * against a pre-migration row would otherwise INSERT a duplicate rather than
 * update in place.
 */
export const POT_GIT_GC_ROUTINE_NAME = 'pot-git-gc';
export const POT_GIT_GC_TARGET = 'system:pot-git-gc';
/** Default cadence: hourly. gc is a bounded-but-not-free sweep (`git gc --prune=now` over a
 *  potentially large shared ODB) — hourly is frequent enough to bound namespace-ref growth
 *  between publishes without contending with every git-sync tick (every 3 min). */
export const DEFAULT_POT_GIT_GC_INTERVAL_SEC = 60 * 60;

export interface PotGitGcRoutineInput {
  /** Owning workspace_id (routines.workspace_id is NOT NULL, no default). */
  workspaceId: string;
  /** The hive HOME's own harness install slug. */
  potHomeSlug: string;
  /** storage.ts's `repoKey` — which bare store under this hive-home to gc
   *  (the primary hive-git store; work-distribution scope repos are a
   *  separate concern — see foreign-mirror-quarantine.ts). */
  repoKey: string;
  intervalSec?: number;
  keepPublishedRefsPerNamespace?: number;
  /** Defaults ACTIVE — the caller (the hiveGit.mode activation path) only
   *  calls this once mode has already moved off `legacy`, so there is no
   *  "seed dark, arm later" step here (unlike a Class-C frontier loop). */
  active?: boolean;
}

function routineId(installSlug: string, name: string): string {
  return `rt_${installSlug}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}

/**
 * Upsert the pot-home's `system:pot-git-gc` ephemeral routine. Re-running is
 * idempotent (ON CONFLICT updates trigger_config/target_role/tier/active only —
 * never clobbers a human-edited `active` toggle on a bare re-materialize; pass
 * `active` explicitly to change it, e.g. from the mode-flip call site).
 */
export async function upsertPotGitGcRoutine(sql: Sql, input: PotGitGcRoutineInput): Promise<{ id: string }> {
  const id = routineId(input.potHomeSlug, POT_GIT_GC_ROUTINE_NAME);
  const triggerConfig = JSON.stringify({
    interval_sec: input.intervalSec ?? DEFAULT_POT_GIT_GC_INTERVAL_SEC,
    pot_home_slug: input.potHomeSlug,
    repo_key: input.repoKey,
    ...(input.keepPublishedRefsPerNamespace != null
      ? { keep_published_refs_per_namespace: input.keepPublishedRefsPerNamespace }
      : {}),
  });
  const active = input.active ?? true;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, tier, next_fire_at, workspace_id)
    VALUES (
      ${id}, ${input.potHomeSlug}, ${POT_GIT_GC_ROUTINE_NAME}, 'cron',
      ${triggerConfig}::text::jsonb, ${POT_GIT_GC_TARGET},
      'skip', 'skip-old', ${active}, 'ephemeral', NULL, ${input.workspaceId}
    )
    ON CONFLICT (install_slug, name) DO UPDATE SET
      trigger_kind   = EXCLUDED.trigger_kind,
      trigger_config = EXCLUDED.trigger_config,
      target_role    = EXCLUDED.target_role,
      tier           = EXCLUDED.tier,
      active         = EXCLUDED.active,
      updated_at     = now()
    RETURNING id
  `;
  return { id: rows[0].id };
}

/** Read the hive-home's gc routine, or null if none seeded. */
export async function getPotGitGcRoutine(sql: Sql, potHomeSlug: string): Promise<RoutineRow | null> {
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT * FROM harness_shared.routines
     WHERE install_slug = ${potHomeSlug} AND target_role = ${POT_GIT_GC_TARGET}
     LIMIT 1
  `;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id ?? ''),
    installSlug: String(r.install_slug),
    name: String(r.name),
    triggerKind: r.trigger_kind as RoutineRow['triggerKind'],
    triggerConfig: (r.trigger_config ?? {}) as RoutineRow['triggerConfig'],
    targetRole: String(r.target_role),
    payloadTemplate: (r.payload_template ?? null) as RoutineRow['payloadTemplate'],
    concurrency: r.concurrency as RoutineRow['concurrency'],
    catchup: r.catchup as RoutineRow['catchup'],
    tier: (r.tier as RoutineRow['tier']) ?? 'ephemeral',
    active: Boolean(r.active),
    lastFiredAt: (r.last_fired_at ?? null) as Date | null,
    nextFireAt: (r.next_fire_at ?? null) as Date | null,
    rescheduleIntervalSec: r.reschedule_interval_sec == null ? null : Number(r.reschedule_interval_sec),
    targetOwnerId: (r.target_owner_id ?? null) as string | null,
  };
}

/** Set active/inactive without touching cadence/repo config (the hiveGit.mode
 *  flip-back-to-legacy path — stop gc'ing once p2p replication is off, but keep
 *  the row + its config for a later re-activation). */
export async function setPotGitGcRoutineActive(sql: Sql, potHomeSlug: string, active: boolean): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.routines
       SET active = ${active}, updated_at = now()
     WHERE install_slug = ${potHomeSlug} AND target_role = ${POT_GIT_GC_TARGET}
     RETURNING id
  `;
  return rows.length > 0;
}

/** Delete the hive-home's gc routine row entirely (the durable inverse of the
 *  seed — a hive teardown, mirroring git-sync's removeGitSyncRoutine). Returns
 *  true when a row was removed, false when none existed (idempotent). */
export async function removePotGitGcRoutine(sql: Sql, potHomeSlug: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    DELETE FROM harness_shared.routines
     WHERE install_slug = ${potHomeSlug} AND target_role = ${POT_GIT_GC_TARGET}
     RETURNING id
  `;
  return rows.length > 0;
}

/** Test/back-compat seam: resolve the admin pool the way the seeding spine does. */
export function defaultHiveGitGcSql(): Sql {
  return getOrgPg().sql;
}
