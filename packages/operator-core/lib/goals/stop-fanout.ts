/**
 * The host half of the goal stop seam — what actually happens when a goal moves to
 * `paused`, `killed` or `achieved` (EI-20013729460455061; `achieved` added by WI-37832,
 * which found the SUCCESS terminal was the one status that wound nothing down).
 *
 * Installed into `@papercusp/agent-mcp` at MODULE LOAD, the same way
 * capability-tier-overrides installs its resolver. It is imported from the
 * agent-tools index so loading the tool surface wires it; `stop-fanout-installed.test.ts`
 * fails if that import is ever dropped, because an uninstalled seam would restore
 * the exact silent no-op this module exists to remove.
 *
 * ── SCOPE, AND WHY IT IS NARROW ──────────────────────────────────────────────
 *
 * PLACEMENT is gated only on pots this goal OWNS. `goal_pots.role` is
 * load-bearing here (migration 765, D-019/D-021): `owner` is the single goal
 * permitted to place work into a pot, while a `contributing` link is driven by
 * a DIFFERENT goal's placement. Stopping a contributing pot would halt work
 * this goal does not own — so contributing links are listed in the report and
 * deliberately left running.
 *
 * LOOPS are disarmed only for sessions ATTRIBUTED to this goal — a GOAL-mode
 * `agent_modes` row whose `subject` is this goal id. The tempting alternative,
 * "disarm every active loop in the goal's pots", is a fleet-wide kill switch
 * fired by a label change: a goal's pot is routinely `papercusp` itself, where
 * dozens of unrelated su sessions hold active loops. Verified live 2026-08-09 —
 * `harness_shared.routines` carried many active `loop-su-*` rows on `install_slug =
 * 'papercusp'`, none of them belonging to any goal.
 *
 * ── WHY IT REPORTS WHAT IT DID NOT STOP ──────────────────────────────────────
 *
 * EI-19995648221353323 measured the failure this must not repeat: pot pause is a
 * placement GATE, not a throttle. It bounds new Mug placements and exerts zero
 * backpressure on sessions already alive with armed self-wake loops — so a pot read
 * "paused, maxBees 1" while 73 distinct owners ran it at 8-13k calls/hour and drained
 * the account pool to exhaustion. The steering surface reported a state that was not
 * the state of the system, and every downstream capacity decision was made on that
 * false premise.
 *
 * So this returns `unattributedActiveLoops`: active loops running in the goal's own
 * pots that could NOT be tied to the goal and were left alone. That is the
 * detector EI-19995648221353323 asks for, delivered at the moment the stop intent is
 * expressed rather than discovered days later from the pool. A caller that renders
 * only `status` will still be wrong — which is why `degraded` is set alongside it.
 */

import type { Sql } from 'postgres';

import { getOrgPg, potsForGoal, unlinkPot } from '@papercusp/db-org';
import {
  setGoalTransitionExecutor,
  isStoppingStatus,
  isTerminalStatus,
  type GoalTransitionInput,
  type GoalTransitionReport,
  type GoalStopInput,
  type GoalStopReport,
  type GoalResumeReport,
} from '@papercusp/agent-mcp';
import { pausePotState, resumePotState } from '../pot/pause-core';
import { deactivateLoop, loopRoutineName } from '../harness/routines/loop';
import { clearImpliedModes, setMode } from '../modes/store';
import { windDownGoalFleet } from '../agent-tools/fleet_registry/control-core';
import { readGoalHolderRows } from './holder';

/**
 * Session owner ids running GOAL mode for this goal. Presence of the row IS the
 * attribution: clearing a mode DELETEs it (modes/store.ts), so there is no enabled
 * flag to filter on.
 *
 * P-001: goes through the canonical holder read, but deliberately takes the
 * UNFILTERED holder list rather than `.live`. STOP is the one goal-holder read
 * where liveness must NOT narrow the set: the whole point is to disarm every
 * session ever attributed to this goal, and a holder the oracle calls dead may
 * still hold an armed loop that will wake it (that combination — a row whose
 * session is gone but whose loop is not — is precisely the residue stop exists
 * to clear). Disarming a genuinely-dead owner's loop is a harmless no-op;
 * skipping a live one is a fleet still burning after the owner pressed stop.
 */
async function attributedOwners(
  sql: ReturnType<typeof getOrgPg>['sql'],
  workspaceId: string,
  goalId: string,
): Promise<string[]> {
  const rows = await readGoalHolderRows(sql as unknown as Sql, {
    workspaceId,
    goalIds: [goalId],
  });
  return [...new Set(rows.map((r) => r.ownerId))];
}

/**
 * Active engine loops running in these pots that are NOT in `sparedNames`.
 * Counted AFTER the disarms so it reports what is still burning, not what was.
 */
async function countUnattributedActiveLoops(
  sql: ReturnType<typeof getOrgPg>['sql'],
  workspaceId: string,
  pots: string[],
  stoppedNames: string[],
): Promise<number> {
  if (pots.length === 0) return 0;
  const [row] = await sql<Array<{ n: string }>>`
    SELECT count(*)::text AS n
      FROM harness_shared.routines
     WHERE workspace_id = ${workspaceId}
       AND install_slug = ANY(${pots})
       AND active = TRUE
       AND target_role = 'system:loop-wake'
       ${stoppedNames.length ? sql`AND name <> ALL(${stoppedNames})` : sql``}
  `;
  return row ? Number(row.n) : 0;
}

/** The standing drain fleet declared by goals:start, if this goal has one. */
async function readGoalDrainFleet(
  sql: ReturnType<typeof getOrgPg>['sql'],
  workspaceId: string,
  goalId: string,
): Promise<string | null> {
  const [row] = await sql<Array<{ drain_fleet: string | null }>>`
    SELECT metadata ->> 'drainFleet' AS drain_fleet
      FROM harness_shared.goals
     WHERE workspace_id = ${workspaceId}
       AND id = ${goalId}
  `;
  const fleet = row?.drain_fleet?.trim();
  return fleet || null;
}

export async function executeGoalStop(input: GoalStopInput): Promise<GoalStopReport> {
  // goals:update supplies its transaction so the terminal goal status and the
  // relationship tombstones commit or roll back together. Watchdog and rollup
  // callers omit it and retain the normal host-connection behavior.
  const sql = input.sql ?? getOrgPg().sql;
  const { goalId, workspaceId, status } = input;

  const links = await potsForGoal(sql, { workspaceId, goalId });
  const owned = links.filter((l) => l.role === 'owner').map((l) => l.harnessSlug);
  const contributing = links.filter((l) => l.role !== 'owner').map((l) => l.harnessSlug);

  // ── Tier 1: gate placement on the pots this goal owns ──────────────────────
  const potsStopped: string[] = [];
  for (const slug of owned) {
    await pausePotState(sql, workspaceId, slug);
    potsStopped.push(slug);
  }

  // ── Tier 2: disarm the loops of sessions attributed to this goal ───────────
  // This is the half with actual teeth: a placement gate alone leaves every live
  // self-waking session running (EI-19995648221353323).
  const owners = await attributedOwners(sql, workspaceId, goalId);
  const loopsStopped: string[] = [];
  for (const ownerId of owners) {
    // deactivateLoop is guarded `AND active = TRUE`, so a false return means the
    // session had no armed loop — not a failure.
    if (
      await deactivateLoop(ownerId, {
        sql,
        actor: 'goal-stop-fanout',
        reason: `goal ${goalId} entered ${status} — goal-stop fan-out`,
      })
    ) {
      loopsStopped.push(ownerId);
    }
  }

  // ── Tier 3: retire the GOAL-mode rows, but ONLY once the goal is OVER ──────
  // A pause KEEPS them: they are the attribution index the resume arm reads, so
  // clearing them here would leave resume unable to name the sessions it reports on.
  const { modesCleared, modesLeftArmed } = isTerminalStatus(status)
    ? await clearGoalModes(sql, workspaceId, goalId, owners, input.actor ?? null)
    : { modesCleared: [], modesLeftArmed: [] };

  // ── Tier 4: retire the standing drain fleet, but ONLY once the goal is OVER ─
  // A paused goal must keep its fleet and its GOAL-mode rows so resume can restore
  // placement and still report the sessions it previously attributed. Terminal
  // goals, however, must leave no active fleet mission behind to re-wake them.
  const drainFleet = isTerminalStatus(status)
    ? await readGoalDrainFleet(sql, workspaceId, goalId)
    : null;
  let drainFleetWoundDown: boolean | null = null;
  let drainFleetWindDownError: string | null = null;
  if (drainFleet) {
    try {
      const result = await windDownGoalFleet({
        workspaceId,
        fleetSlug: drainFleet,
        goalId,
        status,
        actor: input.actor ?? null,
      });
      // A missing row is already terminal from the fleet's perspective (for
      // example, a compensating rollback); never turn that into a false alarm.
      drainFleetWoundDown = result.ok || result.error === 'fleet_not_found';
      if (!result.ok && result.error !== 'fleet_not_found') {
        drainFleetWindDownError = result.error ?? result.message ?? 'unknown fleet wind-down failure';
      }
    } catch (error) {
      drainFleetWoundDown = false;
      drainFleetWindDownError = error instanceof Error ? error.message : String(error);
    }
  }

  // A terminal goal no longer owns any pot. Tombstone only this goal's owner
  // links: contributing links describe a secondary relationship and are not
  // part of this stop fan-out's ownership authority. Use the canonical writer
  // so cleanup is idempotent and preserves the historical row. Paused goals
  // deliberately keep their links so the active transition can resume them.
  if (isTerminalStatus(status)) {
    for (const harnessSlug of owned) {
      await unlinkPot(sql as unknown as Sql, {
        workspaceId,
        goalId,
        harnessSlug,
        by: input.actor ?? 'goal-stop-fanout',
      });
    }
  }

  // ── The honest gap ─────────────────────────────────────────────────────────
  const unattributedActiveLoops = await countUnattributedActiveLoops(
    sql,
    workspaceId,
    owned,
    loopsStopped.map((o) => loopRoutineName(o)),
  );

  return {
    goalId,
    status,
    potsStopped,
    potsSkippedContributing: contributing,
    loopsStopped,
    unattributedActiveLoops,
    modesCleared,
    modesLeftArmed,
    drainFleet,
    drainFleetWoundDown,
    drainFleetWindDownError,
    // Degraded when the stop is materially incomplete: real burn continues in the
    // goal's own pots, a session is still being told this goal is its mission, OR
    // the terminal goal's standing fleet could not be retired.
    degraded:
      unattributedActiveLoops > 0 ||
      modesLeftArmed.length > 0 ||
      drainFleetWoundDown === false,
  };
}

/**
 * Clear the GOAL-mode row of every session attributed to this goal.
 *
 * Routed through `setMode({ enabled: false })` rather than a raw DELETE on purpose —
 * that path carries three things a hand-written DELETE would silently drop: the
 * OWNER-STICKY guard, the `agent_mode_changes` audit row, and the
 * `notifyAgentOrdersChanged` push that keeps the agent's Orders panel from showing a
 * mission it no longer has. It is also safe by construction: setMode no-ops unless the
 * incumbent on that axis IS goal mode, so it cannot clobber a different overlay.
 *
 * A refusal is REPORTED, never bypassed. An `ownerDirected` row belongs to a human
 * instruction, and this fan-out is not an owner-authority channel (`ownerAuthorized =
 * isSelf || callerIsOwnerAuthority`) — passing `callerIsOwnerAuthority` here to force
 * it through would let a goal status change override the owner, which is a worse
 * defect than the stale row it would fix.
 */
async function clearGoalModes(
  sql: ReturnType<typeof getOrgPg>['sql'],
  workspaceId: string,
  goalId: string,
  owners: string[],
  actor: string | null,
): Promise<{ modesCleared: string[]; modesLeftArmed: string[] }> {
  const modesCleared: string[] = [];
  const modesLeftArmed: string[] = [];
  for (const ownerId of owners) {
    const res = await setMode({
      sql,
      workspaceId,
      ownerId,
      modeId: 'goal',
      enabled: false,
      reason: `goal ${goalId} reached a terminal status — the mission it named is over`,
      setBy: actor ?? 'goal-stop-fanout',
    });
    // `noop` means the row was already gone (a concurrent clear, or the session
    // exited the mode itself) — that is the desired end state, not a failure, so it
    // is not reported as left-armed. Only a real refusal is.
    if (res.ok) {
      if (!res.noop) modesCleared.push(ownerId);
      // A terminal stop must also retire posture rows that this GOAL entry
      // implied. Run this after the source clear (and for a noop, where the
      // source was already gone) so a sticky refusal never removes overlays
      // while the GOAL row that justifies them is still active. Matching the
      // exact source mode + subject preserves direct/independent AUTO and
      // IDEATE rows and any overlays derived from another goal.
      await clearImpliedModes({
        sql,
        workspaceId,
        ownerId,
        source: { mode: 'goal', subject: goalId },
        reason: `goal ${goalId} reached a terminal status — retire implied posture rows`,
        setBy: actor ?? 'goal-stop-fanout',
      });
    } else {
      modesLeftArmed.push(ownerId);
    }
  }
  return { modesCleared, modesLeftArmed };
}

/**
 * Engine loops of sessions attributed to this goal that are currently DISARMED.
 *
 * A CURRENT-STATE measurement, not a replay of what the pause did — loop disarms have
 * no durable audit trail (`routine_loop_transitions` records only `parked`/`rearmed`,
 * measured 2026-08-09), so that table's silence about a disarm is not evidence of
 * anything. Rows that never existed are not counted: only a routine row that exists
 * and is inactive.
 */
async function countAttributedDisarmedLoops(
  sql: ReturnType<typeof getOrgPg>['sql'],
  owners: string[],
): Promise<number> {
  if (owners.length === 0) return 0;
  const names = owners.map((o) => loopRoutineName(o));
  const [row] = await sql<Array<{ n: string }>>`
    SELECT count(*)::text AS n
      FROM harness_shared.routines
     WHERE name = ANY(${names})
       AND active = FALSE
  `;
  return row ? Number(row.n) : 0;
}

/**
 * The resume half (WI-37615, plan D-013). NOT the inverse of the stop, by design.
 *
 * It restores PLACEMENT on the pots this goal owns — the thing the pause gated and
 * that nothing else can un-gate, because `pausePotState` marks the pause `deliberate`
 * precisely so the recovery sweep leaves it alone. The fleet re-forms from placement.
 *
 * It deliberately does NOT re-arm the loops the pause disarmed. Those belong to
 * SESSIONS, which are routinely dead by the time a goal resumes; re-arming a dead
 * session's loop is meaningless and re-arming a live re-tasked one is worse. The count
 * is REPORTED instead — same contract as the stop's `unattributedActiveLoops`: a caller
 * that renders only `status` will be wrong, so hand it the number that says so.
 */
export async function executeGoalResume(input: GoalTransitionInput): Promise<GoalResumeReport> {
  const { sql } = getOrgPg();
  const { goalId, workspaceId } = input;

  const links = await potsForGoal(sql, { workspaceId, goalId });
  const owned = links.filter((l) => l.role === 'owner').map((l) => l.harnessSlug);
  const contributing = links.filter((l) => l.role !== 'owner').map((l) => l.harnessSlug);

  const potsResumed: string[] = [];
  for (const slug of owned) {
    await resumePotState(workspaceId, slug);
    potsResumed.push(slug);
  }

  const owners = await attributedOwners(sql, workspaceId, goalId);
  const loopsLeftDisarmed = await countAttributedDisarmedLoops(sql, owners);

  return {
    goalId,
    status: 'active',
    potsResumed,
    potsSkippedContributing: contributing,
    loopsLeftDisarmed,
    timeWakeRestored: false,
    // Degraded when the resume is materially incomplete: placement is open again but
    // sessions that were pursuing this goal are still not looping.
    degraded: loopsLeftDisarmed > 0,
  };
}

/** Route a status move to the arm that handles it. */
export async function executeGoalTransition(
  input: GoalTransitionInput,
): Promise<GoalTransitionReport> {
  return isStoppingStatus(input.status)
    ? executeGoalStop({ ...input, status: input.status })
    : executeGoalResume(input);
}

// Install at module load — the same seam pattern as capability-tier-overrides.
setGoalTransitionExecutor((input) => executeGoalTransition(input));
