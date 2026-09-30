/**
 * VACATE (never transfer) the drain fleet's leader seat when a GOAL holder loses its lease.
 *
 * EI-22402152554463916, observed end-to-end 2026-09-05 06:19-06:31Z: the holder election
 * moved the `work-on-everything-813959` lease and correctly disarmed the outgoing holder's
 * loop, but left that holder as the REGISTERED leader of the goal's drain fleet. The result
 * is worse than a leaderless fleet: a stood-down leader is a FILLED slot that never acts, and
 * every liveness surface reports it live and heartbeat-fresh — which is true, the session is
 * alive, it is merely contractually barred from acting in that role. Four members then starved
 * on a PAUSED control state only the registered leader could lift, and a blocking ruling was
 * escalated to the one agent that must not answer it.
 *
 * WHY VACATE RATHER THAN RE-SEAT. The incoming holder must NOT inherit the seat: the GOAL
 * contract says the drain fleet is led by a launched agent, not by the portfolio manager, so
 * transferring it would leave nobody managing the goal — a different failure, and the goal
 * steward declined the seat three times for exactly this reason (EI-22402152554463916 post
 * 88288). Vacating instead yields a genuinely VACANT slot, which the system already knows how
 * to see and to fill:
 *   - `system-health/compute.ts` counts `leaderlessFleets` and `thresholds.ts` warns on it,
 *     so the gap becomes visible instead of masquerading as a healthy live leader;
 *   - `fleet_registry/status.ts` treats a null leader as claimable, so a launched member can
 *     take the seat through the ordinary `fleet:take-leadership` door.
 *
 * `setFleetLeader(..., null)` is an EXISTING supported transition, not a new mechanism —
 * `fleet_registry/leave.ts` already leaves an active fleet leaderless the same way.
 *
 * Every outcome is reported rather than thrown: this runs inside the holder-handoff delivery
 * seam, whose primary duty is to disarm and notify the outgoing holder. A drain-fleet problem
 * must never cost the stand-down itself.
 */
import { getFleet, setFleetLeader } from '../agent-fleets-store';
import { setPresenceFleet } from '../agent-tools/coordination/presence';
import { retireFleetLeaderWatches } from '../agent-tools/fleet_registry/leader-control';
import { getOrgPg } from '@papercusp/db-org';

/**
 * Why the seat was, or was not, vacated.
 *
 * Only `vacated` is a mutation. The rest are all legitimate no-ops, and they are kept
 * DISTINCT on purpose: "this goal declares no drain fleet" and "someone else already leads
 * it" are the two readings an operator would otherwise have to guess between when auditing
 * an election that changed nothing.
 */
export type DrainFleetVacancyReason =
  | 'vacated'
  | 'no-drain-fleet'
  | 'fleet-missing'
  | 'not-leader'
  | 'superseded'
  | 'error';

export interface DrainFleetVacancyOutcome {
  /** The goal's declared drain fleet, when it has one. */
  fleetSlug: string | null;
  /** True only when this call actually cleared the seat. */
  vacated: boolean;
  reason: DrainFleetVacancyReason;
  /** Present for `error` — the failure is reported, never thrown. */
  detail?: string;
}

export interface VacateDrainFleetLeadershipDeps {
  readDrainFleetSlug: (workspaceId: string, goalId: string) => Promise<string | null>;
  readLeader: (workspaceId: string, fleetSlug: string) => Promise<{ leaderOwnerId: string | null } | null>;
  clearLeader: (workspaceId: string, fleetSlug: string, expectedLeaderOwnerId: string) => Promise<boolean>;
  demotePresence: (workspaceId: string, ownerId: string, fleetSlug: string) => Promise<void>;
  retireWatches: (ownerId: string, fleetSlug: string) => Promise<void>;
}

const DEFAULT_DEPS: VacateDrainFleetLeadershipDeps = {
  // The goal's `metadata.drainFleet` declaration (written by `mintDrainFleetForGoal`) is the
  // canonical identity of the drain fleet; nothing on the fleet row carries a family, which is
  // why it is read rather than inferred. Same read as the headcount governor's.
  readDrainFleetSlug: async (workspaceId, goalId) => {
    const rows = await getOrgPg().sql<{ drain_fleet: string | null }[]>`
      SELECT metadata->>'drainFleet' AS drain_fleet
        FROM harness_shared.goals
       WHERE id = ${goalId} AND workspace_id = ${workspaceId}
       LIMIT 1`;
    return rows[0]?.drain_fleet ?? null;
  },
  readLeader: async (workspaceId, fleetSlug) => await getFleet(workspaceId, fleetSlug),
  // CAS on the outgoing holder: if a member took the seat between our read and our write, the
  // update matches nothing and we correctly leave the NEW leader in place.
  clearLeader: async (workspaceId, fleetSlug, expectedLeaderOwnerId) =>
    (await setFleetLeader(workspaceId, fleetSlug, null, undefined, expectedLeaderOwnerId)) !== null,
  demotePresence: async (workspaceId, ownerId, fleetSlug) => {
    await setPresenceFleet(workspaceId, ownerId, fleetSlug, 'member');
  },
  retireWatches: async (ownerId, fleetSlug) => {
    await retireFleetLeaderWatches(ownerId, fleetSlug);
  },
};

/**
 * Clear the outgoing holder from the drain fleet's leader seat, leaving it genuinely vacant.
 *
 * Mutates ONLY when the outgoing holder is still the registered leader. If the seat is already
 * held by someone else, that agent is leading legitimately and is left untouched.
 */
export async function vacateDrainFleetLeadership(
  workspaceId: string,
  goalId: string,
  outgoingOwnerId: string,
  deps: VacateDrainFleetLeadershipDeps = DEFAULT_DEPS,
): Promise<DrainFleetVacancyOutcome> {
  let fleetSlug: string | null = null;
  try {
    fleetSlug = await deps.readDrainFleetSlug(workspaceId, goalId);
    if (!fleetSlug) return { fleetSlug: null, vacated: false, reason: 'no-drain-fleet' };

    const fleet = await deps.readLeader(workspaceId, fleetSlug);
    if (!fleet) return { fleetSlug, vacated: false, reason: 'fleet-missing' };

    // The seat is only ours to clear while the STOOD-DOWN agent still holds it. A different
    // leader here is the healthy outcome this fix exists to produce, so never disturb it.
    if (fleet.leaderOwnerId !== outgoingOwnerId) {
      return { fleetSlug, vacated: false, reason: 'not-leader' };
    }

    if (!(await deps.clearLeader(workspaceId, fleetSlug, outgoingOwnerId))) {
      return { fleetSlug, vacated: false, reason: 'superseded' };
    }

    // The registry seat is now empty. Bring the outgoing holder's own labels in line so it
    // does not keep reading as this fleet's leader on presence-derived surfaces.
    await deps.demotePresence(workspaceId, outgoingOwnerId, fleetSlug);
    // Its standing leader-transition watches outlive the role unless retired; best-effort,
    // exactly as the take-leadership path treats them.
    await deps.retireWatches(outgoingOwnerId, fleetSlug).catch(() => {});

    return { fleetSlug, vacated: true, reason: 'vacated' };
  } catch (error) {
    return {
      fleetSlug,
      vacated: false,
      reason: 'error',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
