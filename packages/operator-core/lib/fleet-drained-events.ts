/**
 * fleet-drained-events — bridge "a fleet's work just drained" to the await primitive
 * (event-await-discoverability-and-coverage-2026-07-03 P-105 deferred tail, D-006;
 * WI-1830).
 *
 * When the LAST claimable item in a fleet's plan lane flips done, fire an awaitable key
 * so a fleet leader can
 *
 *   events:await { event: "fleet:drained:<my-fleet-slug>" }   // sleep until the fleet is done
 *
 * then loop:end + scorecard, INSTEAD of re-polling fleet:assignments. The fleet slug lives
 * IN the key (a required param), so a leader waiting on ITS fleet wakes only for that fleet.
 *
 * WHY A DERIVED DETECTOR (not a 1-line emit): unlike the other Phase-2 keys
 * (service/plan-item/claim-released) there is no single transition site that MEANS "the
 * fleet drained" — it is a COMPUTED condition (are all the fleet's lanes terminal?). This
 * module supplies (a) the pure drain arithmetic + (b) a fire-and-forget emitter, and is
 * driven from the ONE transition that can flip a fleet into drained: a plan item going
 * →done (wired in plans:set-status). Because set-status only fires on a real →done edge AND
 * we additionally gate on "this flip left the plan with zero open items", that edge identifies a
 * drain CANDIDATE. The shared emit boundary then re-reads the family-complete fleet claim-lane
 * oracle and fires only when its effective claimable count is exactly zero.
 *
 * SCOPE: plan terminality + the assignment snapshot discover candidate fleets; the persisted
 * fleet claim spec + family-complete lane-health reader decides whether each candidate is truly
 * drained. An unclaimed issue/feature backlog is therefore visible to the final decision even
 * though it is absent from fleet_assignment. Missing spec, unreadable lane state, or any positive
 * claimable count fails closed to NO event.
 *
 * PURE core + injectable seams (session-compacted-events.ts / plan-item-events.ts
 * discipline): no PG / IO / clock in the arithmetic; the emit + the assignment read are the
 * only effects and both are injectable, so the whole module unit-tests without PG.
 */

import { emitAwaitedEvent } from './events/await/engine';
import { listFleetAssignments, type FleetAssignmentRow } from './fleet/assignments';
import type { FleetLaneHealth } from './fleet/lane-health';
import { resolveConcreteWorkspaceId } from './workspace-registry';

/** Terminal plan-item statuses — a finished item (mirrors plans/set-status isTerminalStatus). */
export const TERMINAL_ITEM_STATUSES = ['done', 'dropped'] as const;

/** Is this stored item status terminal (the item is finished, held/assigned by no one)? */
export function isTerminalItemStatus(status: string): boolean {
  return status === 'done' || status === 'dropped';
}

/** Count the plan items that are NOT terminal (todo/wip/blocked/needs-human) — the
 *  still-CLAIMABLE work. Only `storedStatus` is read, so any item-shaped object works. */
export function countOpenItems(items: readonly { storedStatus: string }[]): number {
  let open = 0;
  for (const it of items) if (!isTerminalItemStatus(it.storedStatus)) open += 1;
  return open;
}

/**
 * A plan is DRAINED when it has ≥1 item and every one is terminal (no claimable work
 * remains). An EMPTY plan is NOT a drain — there was never any work to finish, so a leader
 * awaiting drain should not be woken by a skeleton plan.
 */
export function isPlanDrained(items: readonly { storedStatus: string }[]): boolean {
  return items.length > 0 && countOpenItems(items) === 0;
}

/**
 * Expected fail-soft noise for a best-effort fire-and-forget emit (never warn, or
 * vitest-fail-on-console flakes rig tests): a partial test schema ("… does not exist"), or
 * the async query outliving its Postgres pool (CONNECTION_ENDED/DESTROYED). Else warn.
 */
function failSoft(scope: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  if (/does not exist/.test(msg)) return;
  const code = (e as { code?: unknown } | null)?.code;
  if (
    code === 'CONNECTION_ENDED' ||
    code === 'CONNECTION_DESTROYED' ||
    /CONNECTION_ENDED|CONNECTION_DESTROYED|Connection ended/i.test(msg)
  ) {
    return;
  }
  console.warn(`[fleet-drained-events] ${scope} emit failed: ${msg}`);
}

/** Injectable seams for tests. */
export interface FleetDrainedEventsDeps {
  emit?: typeof emitAwaitedEvent;
  /** Load the fleet_assignment rows to derive fleet↔plan membership (default: the live
   *  view over ALL scopes). Injected for tests. */
  listAssignments?: () => Promise<FleetAssignmentRow[]>;
  /** Current, family-complete fleet claimability proof. `null` is UNKNOWN and
   *  therefore suppresses the control-plane event; it is never coerced to zero. */
  readLaneHealth?: (args: {
    fleet: string;
    workspaceId?: string | null;
  }) => Promise<FleetLaneHealth | null>;
  /** Capture the caller's concrete workspace before the detached promise runs. */
  workspaceId?: string;
}

async function readLaneHealthDefault(args: {
  fleet: string;
  workspaceId?: string | null;
}): Promise<FleetLaneHealth | null> {
  const { readFleetLaneHealth } = await import('./fleet/lane-health');
  return readFleetLaneHealth(args);
}

/**
 * Verify and fire `fleet:drained:<fleetSlug>` for one candidate fleet. Awaiter-only (no `to`
 * push): the audience is whoever registered interest in this fleet. Fire-and-forget; never
 * throws — an oracle/emit failure can never break the status flip that triggered it, and can
 * never masquerade as a measured zero.
 */
export function emitFleetDrainedEvent(fleetSlug: string, deps: FleetDrainedEventsDeps = {}): void {
  const emit = deps.emit ?? emitAwaitedEvent;
  const readLaneHealth = deps.readLaneHealth ?? readLaneHealthDefault;
  // Resolve synchronously while the request/tool ALS scope is still unquestionably
  // present. The detached continuation must never fall through to another workspace.
  const workspaceId = resolveConcreteWorkspaceId(deps.workspaceId);
  void Promise.resolve()
    .then(async () => {
      // F-FIX-052: plan terminality and one member's scheduler miss are candidate
      // signals, not proof that the whole fleet lane drained. Both producers converge
      // here, so require the same family-complete, caller-neutral oracle used by
      // fleet:leader-brief. UNKNOWN/read failure is not zero and fails closed.
      const laneHealth = await readLaneHealth({ fleet: fleetSlug, workspaceId });
      if (laneHealth?.effective.claimable !== 0) return;

      await emit({
        key: `fleet:drained:${fleetSlug}`,
        summary: `fleet ${fleetSlug} drained — authoritative claimability is zero`,
        payload: {
          fleetSlug,
          claimableProof: {
            value: 0,
            basis: laneHealth.effective.basis,
            spec: laneHealth.spec.ref,
            harness: laneHealth.spec.harness,
          },
        },
        source: 'fleet',
      });
    })
    .catch((e: unknown) => failSoft(`drained-event for ${fleetSlug}`, e));
}

/**
 * PURE: which fleets — given that `planSlug` just reached zero open items — are drain
 * CANDIDATES, derived from a snapshot of the fleet_assignment rows. A CANDIDATE is any fleet
 * with a presence/claim row on `planSlug`; it counts as drained iff it holds NO OTHER active
 * (non-terminal, non-presence) claim on a DIFFERENT plan (an in-flight lane elsewhere means
 * the fleet is not done). The emitter performs the authoritative final proof. Deterministic
 * order (slug-sorted) so callers/tests are stable.
 */
export function drainedFleetsForPlan(planSlug: string, rows: readonly FleetAssignmentRow[]): string[] {
  const candidates = new Set<string>();
  for (const r of rows) if (r.planSlug === planSlug && r.fleetSlug) candidates.add(r.fleetSlug);
  const drained: string[] = [];
  for (const fleet of candidates) {
    const hasOtherActiveLane = rows.some(
      (r) =>
        r.fleetSlug === fleet &&
        r.source !== 'presence' &&
        r.claimActive !== false &&
        r.planSlug != null &&
        r.planSlug !== planSlug,
    );
    if (!hasOtherActiveLane) drained.push(fleet);
  }
  return drained.sort();
}

/**
 * Orchestrate the drain emit for a plan that JUST drained (its last item flipped done and
 * `isPlanDrained` is true — the caller establishes this before calling). Loads the fleet
 * membership snapshot, computes the drained fleets, and fires `fleet:drained:<slug>` for
 * each. Fire-and-forget; never throws.
 */
export function emitFleetDrainedForPlan(planSlug: string, deps: FleetDrainedEventsDeps = {}): void {
  const load = deps.listAssignments ?? (() => listFleetAssignments({}));
  const workspaceId = resolveConcreteWorkspaceId(deps.workspaceId);
  void Promise.resolve()
    .then(async () => {
      const rows = await load();
      for (const fleet of drainedFleetsForPlan(planSlug, rows)) {
        emitFleetDrainedEvent(fleet, { ...deps, workspaceId });
      }
    })
    .catch((e: unknown) => failSoft(`drained-scan for plan ${planSlug}`, e));
}
