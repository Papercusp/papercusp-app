/**
 * P-005 / D-030 step 6: the read behind the fleet-staffing obligation in a
 * leader's Orientation.
 *
 * For every fleet the session leads that is still active, it measures productive
 * headcount through the SAME primitives leader-brief and the headcount governor
 * use — getFleetHeadcountTarget, liveFleetMemberIds(…, 'launch'),
 * readFleetMemberSilence → countedMemberSet, and projectFleetHeadcountState with
 * the governor's eligibility facts — then evaluates computeFleetUnderStaffedAlert
 * on the result. Nothing here is a new measurement; it is the brief's measurement
 * delivered to the leader on every wake, which is what lets a leader loop notice
 * an empty fleet without calling fleet:leader-brief first.
 *
 * Unknown is not zero: a leg that fails yields `evaluation: null` with a reason,
 * never a measured shortfall. Winding-down fleets are skipped (D-030 (6): the
 * obligation clears when the fleet winds down).
 *
 * Collaborators are injectable so the logic is unit-testable without vi.mock;
 * the defaults load lazily, matching every other default obligation dep.
 */
import type { AgentFleetRecord, FleetHeadcountState, FleetHeadcountTarget } from '../agent-fleets-store';
import type { FleetUnderStaffedEvaluation } from './under-staffed-alert';
import { computeFleetUnderStaffedAlert } from './under-staffed-alert';

export interface FleetStaffingRow {
  fleetSlug: string;
  /** null when any leg could not be measured: unknown, never zero. */
  evaluation: FleetUnderStaffedEvaluation | null;
  /** Why the evaluation is null. */
  unknownReason?: string;
}

/** A leader leading more fleets than this is already an anomaly; bound the fan-out. */
export const FLEET_STAFFING_MAX_FLEETS = 4;

export interface FleetStaffingReadDeps {
  listFleetsLedBy: (workspaceId: string, ownerId: string) => Promise<AgentFleetRecord[]>;
  headcountTarget: (workspaceId: string, fleetSlug: string) => Promise<FleetHeadcountTarget | null>;
  liveMemberIds: (workspaceId: string, fleetSlug: string) => Promise<string[] | null>;
  /** The governor's silence seam: the members that count as productive, or null when unread. */
  countedMemberIds: (liveMemberIds: readonly string[]) => Promise<Set<string> | null>;
  /** null when the flag read failed: unknown, never a fabricated OFF. */
  governorFlagOn: () => Promise<boolean | null>;
  projectHeadcount: (
    profile: FleetHeadcountTarget | null,
    fleet: AgentFleetRecord,
    liveMemberIds: string[],
    counted: Set<string> | null,
    governorFlagOn: boolean | null,
    workspaceId: string,
  ) => FleetHeadcountState;
}

/** Every default except projectHeadcount, which needs an awaited import (see defaultProjectHeadcount). */
export function defaultFleetStaffingReadDeps(): Omit<FleetStaffingReadDeps, 'projectHeadcount'> {
  return {
    listFleetsLedBy: async (workspaceId, ownerId) =>
      (await import('../agent-fleets-store')).listFleetsLedBy(workspaceId, ownerId),
    headcountTarget: async (workspaceId, fleetSlug) =>
      (await import('../agent-fleets-store')).getFleetHeadcountTarget(workspaceId, fleetSlug),
    liveMemberIds: async (workspaceId, fleetSlug) =>
      (await import('./fleet-roster')).liveFleetMemberIds(fleetSlug, workspaceId, 'launch'),
    countedMemberIds: async (liveMemberIds) => {
      const { readFleetMemberSilence, countedMemberSet } = await import(
        '../agent-tools/fleet_registry/silent-member'
      );
      // Winding-down fleets never reach here, so the fleet is not paused.
      return countedMemberSet(await readFleetMemberSilence(liveMemberIds, { fleetPaused: false }));
    },
    governorFlagOn: async () => {
      try {
        const [{ FLAGS }, { getFlag }] = await Promise.all([
          import('@papercusp/flags'),
          import('@papercusp/flags/server'),
        ]);
        return (await getFlag(FLAGS.FLEET_HEADCOUNT_GOVERNOR, 'system')) === true;
      } catch {
        return null;
      }
    },
  };
}

async function defaultProjectHeadcount(): Promise<FleetStaffingReadDeps['projectHeadcount']> {
  const { projectFleetHeadcountState } = await import('../agent-fleets-store');
  return (profile, fleet, liveMemberIds, counted, governorFlagOn, workspaceId) =>
    projectFleetHeadcountState(profile, fleet.lastLaunchTransaction ?? null, liveMemberIds, counted, {
      measuredAt: new Date().toISOString(),
      scope: { workspace: workspaceId, fleet: fleet.fleetSlug },
      governance: {
        governorFlagOn,
        controlState: fleet.controlState ?? null,
        leaderOwnerId: fleet.leaderOwnerId ?? null,
      },
    });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One row per active fleet the owner leads (at most FLEET_STAFFING_MAX_FLEETS,
 * newest first). An empty array means the owner leads no active fleet. A failed
 * fleet listing THROWS, so the caller's bounded read reports the whole source
 * degraded instead of a measured "leads nothing".
 */
export async function readLedFleetStaffing(
  input: {
    workspaceId: string;
    ownerId: string;
    /** Measure only this fleet (filtered BEFORE the fan-out bound, so it is never cut by it). */
    onlyFleetSlug?: string;
  },
  deps?: Partial<FleetStaffingReadDeps>,
): Promise<FleetStaffingRow[]> {
  const d: FleetStaffingReadDeps = {
    ...defaultFleetStaffingReadDeps(),
    ...deps,
    projectHeadcount: deps?.projectHeadcount ?? (await defaultProjectHeadcount()),
  };
  const led = (await d.listFleetsLedBy(input.workspaceId, input.ownerId))
    .filter((fleet) => fleet.controlState !== 'winding-down')
    .filter((fleet) => input.onlyFleetSlug == null || fleet.fleetSlug === input.onlyFleetSlug)
    .slice(0, FLEET_STAFFING_MAX_FLEETS);
  if (led.length === 0) return [];
  const governorFlagOn = await d.governorFlagOn().catch(() => null);
  return Promise.all(
    led.map(async (fleet): Promise<FleetStaffingRow> => {
      const unknown = (unknownReason: string): FleetStaffingRow => ({
        fleetSlug: fleet.fleetSlug,
        evaluation: null,
        unknownReason,
      });
      try {
        const [profile, liveIds] = await Promise.all([
          d.headcountTarget(input.workspaceId, fleet.fleetSlug),
          d.liveMemberIds(input.workspaceId, fleet.fleetSlug),
        ]);
        if (liveIds == null) return unknown('the live roster could not be read');
        const counted = await d.countedMemberIds(liveIds);
        if (counted == null) return unknown('which live members are productive could not be read');
        const headcount = d.projectHeadcount(profile, fleet, liveIds, counted, governorFlagOn, input.workspaceId);
        const evaluation = computeFleetUnderStaffedAlert({
          headcount,
          controlState: fleet.controlState ?? null,
          fleetPaused: false,
        });
        return evaluation ? { fleetSlug: fleet.fleetSlug, evaluation } : unknown('productive headcount is unmeasured');
      } catch (err) {
        return unknown(`headcount read failed: ${message(err)}`);
      }
    }),
  );
}
