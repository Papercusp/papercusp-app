/**
 * gc-dead-loops — reap the `loop-<ownerId>` routine rows whose owning session is
 * long gone (agents-system-pane-split-2026-07-26 P-007).
 *
 * THE LEAK: `loop:arm` materialises one `harness_shared.routines` row per looping
 * session (`loop-<ownerId>`, `target_role = system:loop-wake`). `loop:end` and the
 * dead-man sweep deactivate it — nothing ever DELETES it. On 2026-07-26 the
 * workspace carried **770 loop rows, 750 of them dead**, accruing ~30/day since
 * June. The only deletes in the tree are targeted one-offs (rebind-identity moving
 * a loop between identities, pot:leave tearing down a member's rows); there was no
 * retention pass at all.
 *
 * WHY IT IS WORTH A SWEEP RATHER THAN A UI FILTER: the owner's complaint that
 * opened this plan was "the loops also shows loops that havent been active in
 * weeks", and the pane now folds dormant rows behind a count. But a fold over a
 * pile that grows forever is a band-aid: the count itself becomes noise, every
 * catalog read pays for 750 rows it will never render, and the next person to query
 * the routines table still meets them. Removing the rows is the fix; the fold is
 * the presentation.
 *
 * SAFETY — three independent conditions, all required:
 *
 *   1. the row is a LOOP (`name LIKE 'loop-%'` AND `target_owner_id IS NOT NULL`),
 *      so no system routine can ever match;
 *   2. it is INACTIVE — an armed loop is never touched regardless of age, because
 *      `active` is the owner's own switch and a long cadence is legitimate;
 *   3. its owning session has been silent for longer than the retention window,
 *      judged by `coord_presence.last_active_at`, with a MISSING presence row
 *      treated as silent (a reaped presence row is the strongest evidence the
 *      session is gone) — but only when the routine itself has also been quiet that
 *      long, so a brand-new loop whose presence row has not yet been written cannot
 *      be swept out from under itself.
 *
 * The default window is deliberately long (14 days). These rows cost bytes, not
 * correctness, and the failure mode of over-eager deletion — reaping a loop a
 * paused-but-real session intends to resume — is worse than keeping a dead row an
 * extra week.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

/** How long a loop's owning session must have been silent before its row is reaped. */
export const DEAD_LOOP_RETENTION_DAYS_DEFAULT = 14;

/** Never delete more than this in one pass — a runaway sweep should be slow, not total. */
export const DEAD_LOOP_MAX_PER_RUN_DEFAULT = 500;

export interface GcDeadLoopsOptions {
  /** Injectable client — the seam the integration test drives (mirrors gcScheduledPlanRuns). */
  sql?: Sql;
  retentionDays?: number;
  maxPerRun?: number;
  /** Report what WOULD be deleted without deleting it. */
  dryRun?: boolean;
  workspaceId?: string;
}

export interface GcDeadLoopsResult {
  /** Rows deleted (or, under dryRun, rows that matched). */
  reaped: number;
  /** A sample of reaped routine names, for the log line. */
  sample: string[];
  dryRun: boolean;
  retentionDays: number;
}

export async function gcDeadLoops(opts: GcDeadLoopsOptions = {}): Promise<GcDeadLoopsResult> {
  const sql = opts.sql ?? getOrgPg().sql;
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const retentionDays =
    Number.isFinite(opts.retentionDays) && (opts.retentionDays as number) > 0
      ? (opts.retentionDays as number)
      : DEAD_LOOP_RETENTION_DAYS_DEFAULT;
  const maxPerRun =
    Number.isFinite(opts.maxPerRun) && (opts.maxPerRun as number) > 0
      ? (opts.maxPerRun as number)
      : DEAD_LOOP_MAX_PER_RUN_DEFAULT;
  const dryRun = opts.dryRun === true;

  // Keep candidate selection, routine deletion, and matching fire-state cleanup in one
  // transaction. The owner can re-arm while a sweep is running; locking the selected
  // routine rows makes the inactive decision and its cleanup one atomic lifecycle cut.
  const cutoff = `${retentionDays} days`;
  return await sql.begin(async (tx) => {
    const candidates = await tx<Array<{ id: string; name: string }>>`
      SELECT r.id, r.name
        FROM harness_shared.routines r
        LEFT JOIN harness_shared.coord_presence p
               ON p.owner_id = r.target_owner_id
              AND p.workspace_id = r.workspace_id
       WHERE r.workspace_id = ${ws}
         AND r.name LIKE 'loop-%'
         AND r.target_owner_id IS NOT NULL
         AND r.active = false
         AND (p.last_active_at IS NULL OR p.last_active_at < now() - ${cutoff}::interval)
         AND (r.last_fired_at IS NULL OR r.last_fired_at < now() - ${cutoff}::interval)
         AND r.created_at < now() - ${cutoff}::interval
       ORDER BY r.last_fired_at ASC NULLS FIRST
       LIMIT ${maxPerRun}
       FOR UPDATE OF r`;

    const sample = candidates.slice(0, 5).map((c) => c.name);
    if (dryRun || candidates.length === 0) {
      return { reaped: candidates.length, sample, dryRun, retentionDays };
    }

    const ids = candidates.map((c) => c.id);
    const names = [...new Set(candidates.map((c) => c.name))];

    // recordFire keys state by install slug + loop name, but older loop materialisation
    // wrote '*' (and re-homing left prior slugs) in harness_slug. Match by workspace and
    // loop name so every historical residue is cleared. A same-name active routine wins:
    // it may have been re-armed under a new install slug while this stale row was being
    // swept, so preserve its fire-state for the live loop.
    await tx`
      DELETE FROM harness_shared.autoloop_state s
       WHERE s.workspace_id = ${ws}
         AND s.role = ANY(${names})
         AND s.role LIKE 'loop-%'
         AND NOT EXISTS (
           SELECT 1
             FROM harness_shared.routines live
            WHERE live.workspace_id = s.workspace_id
              AND live.name = s.role
              AND live.active = true
         )`;

    const deleted = await tx<Array<{ id: string }>>`
      DELETE FROM harness_shared.routines
       WHERE workspace_id = ${ws}
         AND id = ANY(${ids})
         AND name LIKE 'loop-%'
         AND active = false
      RETURNING id`;

    return { reaped: deleted.length, sample, dryRun: false, retentionDays };
  });
}
