/**
 * wake-frontier-guard — the STRUCTURAL guard behind pot:declare-wake (EI-309).
 *
 * The Mug wedged a live autonomous loop by declaring an event-only ("subscribe
 * to work_items:create, place when created") wake while WI-116/WI-117 ALREADY
 * existed unplaced in her home harness — so with no time-wake and the items
 * sitting in `todo`/unassigned, nothing fired until an unrelated create or the 24h
 * watchdog. Root cause (EI-309 thread): she ran the decentralized-claim mental
 * model (pipeline workers self-claim) inside a Pot where SHE is the only
 * dispatcher — "steering" places nothing. The D-012/EI-286 lesson is that the
 * Mug's self-reports can't be trusted, so the fix is CODE, not just persona:
 * refuse a wake that has NO time component while the home harness still has
 * unplaced work, forcing her to either place it or arm a time-wake.
 *
 * Pure decider (`evaluateWakeFrontierGuard`) + the frontier query
 * (`listUnplacedPotFrontier`), split so the decision unit-tests with no PG.
 */
import type postgres from 'postgres';
import { frontierPlacementKindClause } from '../datatype-frontier-placement';
import { admittedWhereSql, autoPickableWhereSql } from '../work-items-admission';
import { SUMMARY_INACTIVE_UNIT_STATES } from './placement-watchdog';

export interface WakeFrontierGuardInput {
  /** Whether the declaration sets a time component (`at`/`inSeconds`). A timer
   *  will re-wake the Mug to place work, so a frontier is fine then. */
  hasTimeWake: boolean;
  /** Unplaced (todo, unassigned) work-item ids in the home harness. */
  frontierIds: string[];
  /** Non-terminal placements (working/recovering) the Mug has IN FLIGHT —
   *  drive-to-empty (mug-autonomous-execution B-09 / P-030). An event-only/none
   *  wake while these exist risks her never re-waking to verify they completed
   *  (the same wedge class as an unplaced frontier): a `working` cup that finishes
   *  fires a wake, but if she armed no wake it lands as woken:0 voicemail, and a
   *  `recovering` unit needs her to re-place it. So she must keep a time cadence
   *  until every placement is terminal. Optional (default none). */
  openPlacementIds?: string[];
}

export interface WakeFrontierRefusal {
  error: 'frontier_not_empty';
  message: string;
  frontier: string[];
  /** Non-terminal placements that also block the idle (P-030), if any. */
  placements: string[];
}

/**
 * Refuse a declaration with NO time component while the Mug still has work that
 * a no-time wake would strand: unplaced todo work in the home harness (EI-309), or
 * non-terminal placements she must drive to completion (P-030). A time-wake, or
 * BOTH an empty frontier AND no open placements, passes. Returns the refusal or
 * null to allow.
 */
export function evaluateWakeFrontierGuard(input: WakeFrontierGuardInput): WakeFrontierRefusal | null {
  if (input.hasTimeWake) return null; // a timer re-wakes to place / monitor — fine
  const frontier = input.frontierIds;
  const placements = input.openPlacementIds ?? [];
  if (frontier.length === 0 && placements.length === 0) return null; // nothing pending

  const parts: string[] = [];
  if (frontier.length > 0) {
    const shown = frontier.slice(0, 10);
    const more = frontier.length - shown.length;
    parts.push(
      `${frontier.length} unplaced todo work-item(s) (${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}) — ` +
        `PLACE them this turn (spawn/dispatch a cup)`,
    );
  }
  if (placements.length > 0) {
    const shown = placements.slice(0, 10);
    const more = placements.length - shown.length;
    parts.push(
      `${placements.length} non-terminal placement(s) still in flight (${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}) — ` +
        `DRIVE them to completion (re-place any recovering, verify each reaches terminal)`,
    );
  }
  return {
    error: 'frontier_not_empty',
    message:
      `Refusing an event-only/none wake: ${parts.join('; and ')}. In a Pot YOU are the dispatcher AND you drive ` +
      `every placement to completion (B-09); an event-only/none wake leaves this work stranded. Place/drive it now, ` +
      `or arm a time-wake (inSeconds/at) so you re-wake to finish it. Pass force:true only if you deliberately intend ` +
      `to leave it.`,
    frontier,
    placements,
  };
}

/**
 * The home harness's unplaced FRONTIER: feature-family work-items (feature /
 * research-task / chunk) that are `todo` and unassigned (`taken_by` null/empty) —
 * exactly what `claimNextWorkItem` would dispatch. Oldest-first, capped.
 *
 * WI-3300 — G2-ADMISSION excluded, mirroring survey.ts's fetchFrontierRows
 * (EI-8498). Without this, a remote+un-admitted (quarantined) item in the home
 * harness reads as "unplaced frontier" here even though the Mug genuinely
 * cannot place it (it's gated on auditor admission, not on her dispatch) — forcing
 * `pot:declare-wake` to keep refusing a no-time-wake declaration ("PLACE them this
 * turn") for work she has no lever to place. Applying the SAME predicate here
 * keeps this guard's notion of "placeable" consistent with what placement can
 * actually pick up.
 */
export async function listUnplacedPotFrontier(
  sql: postgres.Sql,
  workspaceId: string,
  harnessSlug: string,
  limit = 25,
): Promise<string[]> {
  const rows = await sql<{ feature_id: string }[]>`
    SELECT feature_id
      FROM harness_shared.harness_features_consolidated f
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND ${frontierPlacementKindClause(sql, workspaceId)}
       -- work-item-status-full-unify (2026-07-19, migration 638): feature-family status
       -- 'todo' was rewritten to the unified claimable token 'open'. This literal was
       -- never updated, so since that migration this guard has silently seen an EMPTY
       -- frontier for genuinely-unplaced work — letting the Mug declare a no-time wake
       -- exactly when this guard exists to refuse it (same root cause as survey.ts's
       -- fetchFrontierRows, EI-18690462961089460).
       AND status = 'open'
       AND (taken_by IS NULL OR taken_by = '')
       AND ${autoPickableWhereSql(sql, workspaceId)}
       AND ${admittedWhereSql(sql)}
       -- EI-13695: a row carrying a surviving work-item checkpoint is RECONCILE
       -- work, not fresh placeable frontier — mirroring survey.ts's
       -- fetchFrontierRows so this guard never demands "PLACE it this turn" for
       -- an item the survey (correctly) withholds from placement.
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.carry_notes cn
          WHERE cn.workspace_id = f.workspace_id
            AND cn.scope IN ('workitem:' || f.harness_slug || ':' || f.feature_id, 'workitem:*:' || f.feature_id)
            AND btrim(cn.note) <> '')
     ORDER BY created_ts ASC
     LIMIT ${limit}`;
  return rows.map((r) => r.feature_id);
}

/**
 * The Mug's non-terminal placements (P-030 drive-to-empty): pot_placements
 * rows in `working`/`recovering` (NOT cursed/stranded — those are escalated to the
 * owner, no longer the Mug's to drive) WHOSE SUBJECT WORK-ITEM IS STILL LIVE.
 *
 * EI-7641: a `pot_placements` row does not always converge when its subject unit
 * reaches terminal (passed/deprecated/resolved/closed) or gets deliberately parked
 * (blocked/needs-human) — the completion-reconcile GC (evaluateTerminalPlacementReconcile,
 * `reconcileOnePot`) only revisits units that still have a recent cup-spawn candidate,
 * not a periodic full sweep (the same staleness `summarizeOpenPlacements` already
 * guards against for the brief-facing summary). Left un-joined, this guard forced
 * EVERY no-time Mug wake to `force:true` past a list of ids that were already done,
 * deprecated, or owner-parked with zero live claim and no policy avenue to progress.
 * So: LEFT JOIN the live unit and require it to (a) still exist and (b) NOT be in
 * SUMMARY_INACTIVE_UNIT_STATES (terminal ∪ parked) — mirroring summarizeOpenPlacements'
 * own join exactly, so the two never diverge on what counts as "still open".
 *
 * Best-effort: the table may not exist yet on a host whose migration is pending →
 * return [] (the guard simply doesn't fire on placements there; the unplaced-frontier
 * leg still works).
 */
export async function listNonTerminalPlacements(
  sql: postgres.Sql,
  workspaceId: string,
  installSlug: string,
  limit = 25,
): Promise<string[]> {
  try {
    const rows = await sql<{ work_item_id: string }[]>`
      SELECT p.work_item_id
        FROM harness_shared.pot_placements p
        LEFT JOIN harness_shared.harness_features_consolidated f
          ON f.workspace_id = p.workspace_id
         AND f.feature_id = p.work_item_id
       WHERE p.workspace_id = ${workspaceId}
         AND p.install_slug = ${installSlug}
         AND p.status IN ('working', 'recovering')
         AND f.feature_id IS NOT NULL
         AND f.status <> ALL(${SUMMARY_INACTIVE_UNIT_STATES}::text[])
       ORDER BY p.updated_at ASC
       LIMIT ${limit}`;
    return rows.map((r) => r.work_item_id);
  } catch {
    return [];
  }
}
