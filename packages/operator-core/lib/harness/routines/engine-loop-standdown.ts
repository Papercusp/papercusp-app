/**
 * engine-loop-standdown.ts — the STOOD-DOWN signal for the unguarded-halt
 * rescue (EI-21275606411048371, recurring class of EI-18734910825871393).
 *
 * THE DEFECT: the rescue wakes an idle, empty-handed member of an ACTIVE fleet
 * whenever its effective claim spec admits work. For a member whose DIRECTED
 * obligation completed and which then wound down deliberately (`loop:end`),
 * the fleet-wide queue is not its work — yet the sweep kept waking it every
 * throttle hour: wake → verify nothing scoped → halt again → wake. Each cycle
 * a full billable turn spent re-discovering "nothing to do", indefinitely,
 * because every verification turn refreshes `last_tool_call_at` back INTO the
 * idle window. Reproduced twice on 2026-08-23 (deliveries #135568, #136380)
 * and repeatedly in the dropped predecessor row.
 *
 * THE SIGNAL: `loop:end` is the persona-mandated wind-down act, and it leaves
 * first-class scheduling state behind — the engine-loop routine row
 * (`harness_shared.routines`, name `loop-<ownerId>`, `target_owner_id` set).
 * An owner who HAS such a row and whose rows are now ALL `active=false` stood
 * down (or was paused by an equally deliberate engine guard — the cost-cap
 * exists to stop spend, and rescuing around it would defeat it). An owner with
 * NO row never armed a loop: the silent stall WI-6054 built the rescue for is
 * exactly them, so they stay fully rescuable. An ACTIVE loop never reaches the
 * halt predicate at all, so suppression cannot touch a working agent.
 *
 * LIFT (all natural, no extra state): `loop:arm` flips the row active; a
 * dispatch/kickoff messages the member directly (inbox-wake, not this sweep);
 * a new claim trips the empty-handed filter; a fleet wind-down drops the whole
 * fleet at source.
 *
 * FAIL-OPEN by contract: a reader error must degrade to NO suppression (the
 * pre-fix behavior) — a missed suppression costs one throttled wake, while a
 * wrong permanent suppression strands a genuinely recoverable halt. Callers
 * treat a rejected read as `null` and pass everything through.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

/** One `loop:arm` routine row observed for an owner — only what the decision needs. */
export interface EngineLoopRow {
  active: boolean;
}

/** ownerId → every engine-loop routine row found for that owner (absent = never armed). */
export type EngineLoopRowsByOwner = Record<string, readonly EngineLoopRow[]>;

/**
 * PURE: has this owner deliberately STOOD DOWN — armed an engine loop at some
 * point, and every such loop row is now inactive?
 *
 * - No rows at all → FALSE (never armed ⇒ the rescuable silent-stall case).
 * - Any row still active → FALSE (a live loop means they are mid-mission; the
 *   halt predicate would not have selected them anyway — defense in depth).
 * - ≥1 row, all inactive → TRUE (the deliberate wind-down marker).
 */
export function isStoodDownOwner(
  rows: EngineLoopRowsByOwner | null | undefined,
  ownerId: string,
): boolean {
  const owned = rows?.[ownerId];
  if (!owned || owned.length === 0) return false;
  return owned.every((r) => !r.active);
}

/** Same loop identity `gc-dead-loops` uses: `name LIKE 'loop-%'` AND a non-null
 *  `target_owner_id`. Never keyed on `target_role` alone — the role marker has
 *  drifted before (WI-37571 class); the name+owner pair is the established seam. */
export async function readEngineLoopRowsByOwner(
  ownerIds: readonly string[],
  opts: { sql?: Sql; workspaceId?: string } = {},
): Promise<EngineLoopRowsByOwner> {
  if (ownerIds.length === 0) return {};
  const sql = opts.sql ?? getOrgPg().sql;
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<{ target_owner_id: string; active: boolean }[]>`
    SELECT r.target_owner_id, r.active
      FROM harness_shared.routines r
     WHERE r.workspace_id = ${ws}
       AND r.name LIKE 'loop-%'
       AND r.target_owner_id IS NOT NULL
       AND r.target_owner_id = ANY(${[...ownerIds]})`;
  const byOwner: Record<string, EngineLoopRow[]> = {};
  for (const row of rows) {
    (byOwner[row.target_owner_id] ??= []).push({ active: Boolean(row.active) });
  }
  return byOwner;
}
