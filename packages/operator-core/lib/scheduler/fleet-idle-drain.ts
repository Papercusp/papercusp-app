/**
 * fleet-idle-drain — push "the fleet has nothing left to pull RIGHT NOW" instead of
 * leaving a leader to burn-down-watch fleet:assignments (fleet-leader-frictions-six-
 * improvements-2026-07-10 P-006 / WI-3763, closeout-lane p2p-parity-closeout-lanes-
 * 2026-07-10 P-003).
 *
 * THREE signals, ANDed:
 *   1. the claim-spec VIEW is empty — a member's scheduler:get_next (getNextForBee)
 *      just found zero eligible items under (global floors AND its resolved
 *      spec.view.filter). This rides the ALREADY-PERFORMED query — no extra SQL, no
 *      new poll/tick (repo scheduling policy: no bare setInterval, no new scheduler —
 *      see /internal/docs/agent-insights/two-tier-scheduler-and-timer-visibility).
 *      It is a MORE ACCURATE "drained" than fleet-drained-events.ts's plan-item-
 *      status check: a plan can still carry open items (blocked, or excluded by this
 *      fleet's spec filter) while genuinely having nothing any member can pull now.
 *   2. every member of the fleet is IDLE — none is `speaking` (MemberVerdict,
 *      EI-8995) — so an empty view caught mid-beat, while another member is still
 *      actively working the last few items, never fires a false drain.
 *   3. the shared emit boundary re-reads the caller-neutral, family-complete fleet
 *      lane oracle and requires claimable === 0. A miss caused by retry exhaustion,
 *      a transient floor, or a stale runtime can therefore never terminate a live
 *      queue. UNKNOWN/read failure suppresses the event.
 *
 * Fires the SAME `fleet:drained:<slug>` key fleet-drained-events.ts emits (reused
 * verbatim, not duplicated) — a leader awaits ONE key regardless of which detector
 * caught the drain.
 *
 * PURE core (`allFleetMembersIdle`) + injectable seams for the effectful orchestrator
 * (`maybeEmitFleetIdleDrain`), the same discipline as fleet-drained-events.ts /
 * session-compacted-events.ts: no PG in the arithmetic, fire-and-forget, never throws
 * — a detector failure must never break the get_next miss it rides on.
 */
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { emitFleetDrainedEvent } from '../fleet-drained-events';
import {
  groupByAgent,
  lastToolCallAtByOwner,
  listFleetAssignments,
  type AgentAssignment,
} from '../fleet/assignments';
import { deriveMemberVerdict } from '../agent-tools/fleet/assignments';
import { latestFleetMembership } from '../fleet-membership-store';

/** Debounce: don't re-emit for the same fleet more often than this. An awaiter needs
 *  exactly one wake; a fleet whose idle members keep polling get_next while nothing
 *  is claimable shouldn't spam repeat emits for the SAME drained state. */
export const IDLE_DRAIN_DEBOUNCE_MS = 2 * 60_000;

/** Process-local last-emit tracker, per fleet slug. Best-effort: a restart or a
 *  second host resets it, which only costs one harmless extra emit — never a missed
 *  one (a re-emit of an already-resolved key is a no-op for a settled awaiter). */
const lastEmittedAt = new Map<string, number>();

/** Test seam: clear the debounce state between cases. */
export function resetIdleDrainDebounce(): void {
  lastEmittedAt.clear();
}

export interface IdleDrainDeps {
  emit?: (fleetSlug: string) => void;
  listAssignments?: typeof listFleetAssignments;
  fetchLastToolCalls?: typeof lastToolCallAtByOwner;
  fetchMembership?: typeof latestFleetMembership;
  now?: () => number;
}

/**
 * PURE: every member of the fleet is idle (verdict !== 'speaking'). An empty member
 * list is NOT idle — there is nothing to observe, so never fire on a ghost fleet.
 */
export function allFleetMembersIdle(
  members: readonly Pick<AgentAssignment, 'agentId' | 'present' | 'alive' | 'stalled' | 'load'>[],
  lastToolCallMsByAgent: ReadonlyMap<string, number | null>,
  nowMs: number = Date.now(),
): boolean {
  if (members.length === 0) return false;
  return members.every(
    (m) =>
      deriveMemberVerdict(
        {
          present: m.present,
          alive: m.alive,
          stalled: m.stalled,
          load: m.load,
          lastToolCallAtMs: lastToolCallMsByAgent.get(m.agentId) ?? null,
        },
        nowMs,
      ) !== 'speaking',
  );
}

/**
 * Given that `cupId`'s scheduler:get_next JUST MISSED (its claim-spec view found
 * zero eligible items — signal 1), check whether `cupId`'s fleet is ALSO fully idle
 * (signal 2) and, if so, emit `fleet:drained:<slug>`. Debounced, fire-and-forget,
 * never throws. A no-op for a caller that belongs to no fleet.
 */
export function maybeEmitFleetIdleDrain(
  cupId: string,
  workspaceId: string | undefined,
  deps: IdleDrainDeps = {},
): void {
  // The default emitter runs after this detached check. Preserve the workspace
  // captured by the scheduler call; resolving it again inside the detached
  // promise could fall through to the process-global workspace and prove the
  // wrong fleet lane empty. Injected test emitters keep their existing shape.
  const emit =
    deps.emit ??
    ((fleetSlug: string) =>
      emitFleetDrainedEvent(fleetSlug, {
        workspaceId,
      }));
  const listAssignments = deps.listAssignments ?? listFleetAssignments;
  const fetchLastToolCalls = deps.fetchLastToolCalls ?? lastToolCallAtByOwner;
  const fetchMembership = deps.fetchMembership ?? latestFleetMembership;
  const now = deps.now ?? Date.now;
  void Promise.resolve()
    .then(async () => {
      const ws = workspaceId ?? DEFAULT_COORD_WORKSPACE;
      const membership = await fetchMembership(ws, cupId);
      const fleetSlug = membership?.fleetSlug;
      if (!fleetSlug) return; // not a fleet member — no fleet to derive drain for

      const nowMs = now();
      const lastEmit = lastEmittedAt.get(fleetSlug);
      if (lastEmit != null && nowMs - lastEmit < IDLE_DRAIN_DEBOUNCE_MS) return;

      const rows = await listAssignments({});
      const members = groupByAgent(rows).filter((a) => a.fleetSlug === fleetSlug);
      if (members.length === 0) return;

      const lastCalls = await fetchLastToolCalls(members.map((m) => m.agentId));
      const lastCallsMs = new Map<string, number | null>();
      for (const m of members) {
        const iso = lastCalls.get(m.agentId);
        const ms = iso ? Date.parse(iso) : null;
        lastCallsMs.set(m.agentId, Number.isFinite(ms as number) ? (ms as number) : null);
      }

      if (!allFleetMembersIdle(members, lastCallsMs, nowMs)) return;

      lastEmittedAt.set(fleetSlug, nowMs);
      emit(fleetSlug);
    })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[fleet-idle-drain] check failed: ${msg}`);
    });
}
