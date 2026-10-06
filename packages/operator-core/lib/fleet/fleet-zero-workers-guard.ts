/**
 * P-005 / D-030 step 7: a fleet-leader monitor cannot record a quiet wake while
 * the fleet it leads has zero productive workers.
 *
 * `loop:checkpoint` without `monitorDelta:true` is how a monitor loop records a
 * quiet wake. Measured before this guard (D-030 (d)): a leader could do that at
 * any headcount, and the no-delta budget made it free, so a fleet sat at 0
 * workers through wake after wake while its leader reported "nothing changed".
 *
 * The guard REFUSES only when every fact is measured: the caller's active loop is
 * a monitor whose authority is `fleet-leader`, the call is not a delta, the fleet
 * is still active and led by the caller, and its productive headcount is 0.
 * Anything unmeasured fails OPEN with a warning: unknown is not zero, and a
 * checkpoint refused on a guess would cost the cold successor its carry-note.
 *
 * The measurement is the same one the brief and the leader's Orientation use
 * (readLedFleetStaffing), so the three surfaces cannot disagree about a fleet.
 */
import type { FleetStaffingRow } from './fleet-staffing-read';

export const FLEET_ZERO_WORKERS_REPAIRS = [
  'fleet:headcount-target { target, supervise:true }',
  'fleet:launch-on-plan',
  'fleet:wind-down',
] as const;

export type FleetZeroWorkersVerdict =
  | { action: 'allow'; warning?: string }
  | { action: 'refuse'; fleetSlug: string; message: string; repairs: readonly string[] };

/**
 * PURE. `fleetSlug` is the fleet named by the caller's fleet-leader monitor
 * authority (null: no such monitor). `row` is that fleet's staffing measurement:
 * null when the caller no longer leads it as an active fleet, 'unknown' when the
 * read itself failed.
 */
export function decideFleetZeroWorkers(input: {
  monitorDelta: boolean;
  fleetSlug: string | null | 'unknown';
  row: FleetStaffingRow | null | 'unknown';
}): FleetZeroWorkersVerdict {
  if (input.monitorDelta) return { action: 'allow' };
  if (input.fleetSlug === 'unknown') {
    return {
      action: 'allow',
      warning:
        'fleet_zero_workers not checked: whether this loop is a fleet-leader monitor could not be read. ' +
        'Unknown is not zero, so the checkpoint was allowed.',
    };
  }
  if (input.fleetSlug == null || input.row == null) return { action: 'allow' };
  if (input.row === 'unknown' || input.row.evaluation == null) {
    const why =
      input.row === 'unknown' ? 'the staffing read failed' : (input.row.unknownReason ?? 'headcount is unmeasured');
    return {
      action: 'allow',
      warning:
        `fleet_zero_workers not checked for fleet ${input.fleetSlug}: ${why}. Unknown is not zero, so the ` +
        `checkpoint was allowed; confirm with fleet:leader-brief { fleet: '${input.fleetSlug}' }.`,
    };
  }
  const e = input.row.evaluation;
  if (e.current !== 0) return { action: 'allow' };
  const target = e.target != null ? ` against target ${e.target}` : ' and no headcount target';
  const held =
    e.held === true
      ? ' The governor holds it, so if it is still empty its relaunch is failing.'
      : e.held === false
        ? ` Nothing will restore it (${e.notHeldBecause ?? 'not held'}).`
        : ' Whether the governor holds it could not be read.';
  return {
    action: 'refuse',
    fleetSlug: input.row.fleetSlug,
    message:
      `Fleet ${input.row.fleetSlug}, which this monitor loop leads, has 0 productive workers${target}.${held} ` +
      'A quiet wake (no monitorDelta) cannot be recorded while the fleet is empty. Staff it, wind it down, ' +
      'or, if this wake really changed something, re-send with monitorDelta:true.',
    repairs: FLEET_ZERO_WORKERS_REPAIRS,
  };
}

export interface FleetZeroWorkersGuardDeps {
  /** The fleet of the owner's active fleet-leader monitor loop, or null when none. Throws on a failed read. */
  monitorFleet: (input: { workspaceId: string; ownerId: string }) => Promise<string | null>;
  /** That fleet's staffing row, or null when the owner does not lead it as an active fleet. Throws on a failed read. */
  staffing: (input: { workspaceId: string; ownerId: string; fleetSlug: string }) => Promise<FleetStaffingRow | null>;
}

export function defaultFleetZeroWorkersGuardDeps(): FleetZeroWorkersGuardDeps {
  return {
    monitorFleet: async ({ workspaceId, ownerId }) => {
      const [{ getOrgPg }, { readPersistedMonitorConfig }] = await Promise.all([
        import('@papercusp/db-org'),
        import('../harness/routines/monitor-standdown'),
      ]);
      // Same predicate as recordMonitorDelta: the owner's ACTIVE recurring monitor loop.
      const rows = await getOrgPg().sql<Array<{ payload_template: unknown }>>`
        SELECT payload_template
          FROM harness_shared.routines
         WHERE workspace_id = ${workspaceId}
           AND target_owner_id = ${ownerId}
           AND active = TRUE
           AND reschedule_interval_sec IS NOT NULL
           AND payload_template->>'mode' = 'monitor'`;
      for (const row of rows) {
        const authority = readPersistedMonitorConfig(row.payload_template)?.authority;
        if (authority?.kind === 'fleet-leader') return authority.fleet;
      }
      return null;
    },
    staffing: async ({ workspaceId, ownerId, fleetSlug }) => {
      const { readLedFleetStaffing } = await import('./fleet-staffing-read');
      const rows = await readLedFleetStaffing({ workspaceId, ownerId, onlyFleetSlug: fleetSlug });
      return rows.find((row) => row.fleetSlug === fleetSlug) ?? null;
    },
  };
}

/** Reads, then decides. Never throws: a failed read becomes a fail-open warning. */
export async function checkFleetZeroWorkers(
  input: { workspaceId: string; ownerId: string; monitorDelta: boolean },
  deps: FleetZeroWorkersGuardDeps = defaultFleetZeroWorkersGuardDeps(),
): Promise<FleetZeroWorkersVerdict> {
  if (input.monitorDelta) return { action: 'allow' };
  const owner = { workspaceId: input.workspaceId, ownerId: input.ownerId };
  let fleetSlug: string | null | 'unknown';
  try {
    fleetSlug = await deps.monitorFleet(owner);
  } catch {
    fleetSlug = 'unknown';
  }
  if (fleetSlug == null || fleetSlug === 'unknown') {
    return decideFleetZeroWorkers({ monitorDelta: false, fleetSlug, row: null });
  }
  let row: FleetStaffingRow | null | 'unknown';
  try {
    row = await deps.staffing({ ...owner, fleetSlug });
  } catch {
    row = 'unknown';
  }
  return decideFleetZeroWorkers({ monitorDelta: false, fleetSlug, row });
}
