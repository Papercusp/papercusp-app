/**
 * fleet-transition-sweep-action — the DERIVED half of the leader transition feed
 * (fleet-leadership-continuity-and-actuation-2026-08-01 P-009, D-008).
 *
 * Two of P-009's four new transitions have a real transition site and co-fire from
 * it (`fleet:claim-released:<slug>` from releaseWorkItem, `fleet:item-completed:<slug>`
 * from emitWorkItemSettledEvents). The other two have NONE:
 *
 *   - member-dead      — death is the ABSENCE of a write. Nothing happens at the
 *                        moment a member dies; a verdict merely becomes derivable.
 *   - context-critical — pressure is DERIVED from self-reported token counts, so
 *                        the bucket changes without any event of its own.
 *
 * member-left is a companion derived edge for a recorded, non-wakeable member
 * that still holds claims; it does not assert those claims are reclaimable.
 *
 * So they need a sweep, exactly as `fleet-drained-events.ts` documents for its own
 * computed condition. This is the sweep. It is deliberately thin: it gathers
 * observations through the SAME pipeline `fleet:assignments` uses (so a sweep
 * verdict can never disagree with what a leader would read), hands them to the
 * pure detector in `fleet-transition-events.ts`, and emits whatever crossings come
 * back.
 *
 * WHY A SWEEP IS STILL "PUSH, NOT POLL". One sweep for the whole box replaces N
 * leaders each polling their own fleet on their own clock — and, more to the point,
 * each BURNING A TURN to do it. The leader sleeps on an event; the substrate does
 * the looking. That is the whole trade this plan is making.
 *
 * THE PREVIOUS SNAPSHOT IS IN-PROCESS, ON PURPOSE. Edge detection needs the prior
 * observation, and this keeps it in module scope rather than a table. That is not
 * the storage-policy violation it looks like: a lost snapshot costs at most one
 * MISSED edge, once, on the sweep after a restart (the detector's first-sighting
 * rule then re-arms every member), and P-010 explicitly retains `loop:arm` as a
 * long fallback heartbeat precisely so a missed push degrades to a slower notice
 * rather than a lost one. Persisting it would buy a rare edge across restarts at
 * the cost of a table, a migration and a write every sweep. Same shape and
 * justification as the in-process throttle already in `work-items-events.ts`.
 */

import { groupByAgent, listFleetAssignments, type AgentAssignment } from '../../fleet/assignments';
import {
  decorateLoopMonitorStates,
  decorateParkedOn,
  reconcileWakeability,
  RECONCILE_WAKEABILITY_PRODUCTION_OPTIONS,
} from '../../agent-tools/fleet/assignments';
import type { SessionState } from '../../agent-tools/coordination/presence-wakeability';
import { fetchContextPressure, type ContextPressureBucket } from '../../agent-tools/coordination/context-pressure';
import { listParkedAwaitsForSubscribers } from '../../events/await/store';
import { readFleetAdmissionBlocks } from '../../agent-tools/coordination/fleet-scope-admission-blocks';
import { readFleetRepeatedRecoveryStates } from '../../fleet-repeated-recovery';
import {
  detectFleetAdmissionTransitions,
  detectFleetTransitions,
  emitFleetAdmissionTransitionEdge,
  emitFleetTransitionEdge,
  indexObservations,
  isActionableFleetObservation,
  type FleetAdmissionObservation,
  type FleetDeadLatchEntry,
  type FleetLeftLatchEntry,
  type FleetMemberObservation,
  type FleetTransitionEventsDeps,
} from '../../fleet-transition-events';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

type ObservableAgent = AgentAssignment & {
  sessionState?: SessionState | null;
  confirmLiveness?: boolean | null;
  wakeable?: boolean | null;
};

/**
 * The previous sweep's observations, keyed by (fleet, agent). Module-scoped and
 * best-effort by design — see the header note.
 */
let previousObservations = new Map<string, FleetMemberObservation>();

/** The previous sweep's fleet-level admission-block counts. */
let previousAdmissionObservations = new Map<string, number>();

/**
 * How far before this baseline began a block may have been raised and still be
 * announced on a fleet's first sighting. It covers the restart gap: a block raised
 * while the old sweep process was dying or before this one's first tick was never
 * announced by either. Blocks older than this were visible to the previous process,
 * which already announced them.
 */
export const ADMISSION_FIRST_SIGHTING_GRACE_MS = 10 * 60 * 1000;

/**
 * Where this process's admission baseline begins (WI-10003609). Unlike the member
 * snapshot above, losing the admission snapshot does not MISS an edge; it
 * DUPLICATES one. The admission detector treats a missing baseline as zero, so the
 * first sweep after every restart re-announced each still-listed block as a 0-to-N
 * rise and woke the leader for nothing (measured twice on fleet p013-bcd). Blocks
 * carry their own timestamp, so gating the first sighting on it costs no storage.
 */
let admissionBaselineSinceMs = Date.now() - ADMISSION_FIRST_SIGHTING_GRACE_MS;

/**
 * The member-dead latch (detector rule 3) — which members have already had a
 * member-dead edge fired, and how long they have read non-dead since.
 *
 * Module-scoped for the same reason the snapshot above is, and losing it is
 * cheaper than losing the snapshot: a restart costs at most ONE duplicate notice
 * per already-dead member, where the flap it suppresses was measured at dozens
 * per member per day (EI-22125312396899848).
 */
let memberDeadLatch = new Map<string, FleetDeadLatchEntry>();
let memberLeftLatch = new Map<string, FleetLeftLatchEntry>();

/** Test-only: forget the previous snapshot so cases don't cross-contaminate. */
export function __resetFleetTransitionSnapshotForTests(opts: { admissionBaselineSinceMs?: number } = {}): void {
  previousObservations = new Map();
  previousAdmissionObservations = new Map();
  admissionBaselineSinceMs = opts.admissionBaselineSinceMs ?? Date.now() - ADMISSION_FIRST_SIGHTING_GRACE_MS;
  memberDeadLatch = new Map();
  memberLeftLatch = new Map();
}

/**
 * Gather one round of observations through the SAME pipeline `fleet:assignments`
 * uses — grouped assignments, then the shared wakeability oracle for
 * `sessionState`, then the context-pressure buckets. Reusing it (rather than a
 * bespoke query) is what stops a sweep verdict drifting from the verdict a leader
 * would read for itself.
 *
 * Agents in NO fleet are dropped: their transitions are nobody's fleet event.
 */
export async function gatherFleetObservations(): Promise<FleetMemberObservation[]> {
  // `reconcileWakeability` WRITES `sessionState` onto the rows it is handed, but
  // `AgentAssignment` does not declare the field — so the widened row type has to
  // be named here, or the reconciled result narrows straight back to
  // `AgentAssignment` and reading `.sessionState` off it is a type error.
  let agents: ObservableAgent[];
  try {
    agents = groupByAgent(await listFleetAssignments({}));
  } catch {
    // The sweep is a derived notification path. A transient roster read failure
    // must not fail the routine or turn a partial read into a mass-death verdict.
    return [];
  }
  const fleeted = agents.filter((a) => Boolean(a.fleetSlug));
  if (fleeted.length === 0) return [];

  // Best-effort on both legs: a degraded liveness or pressure read must produce a
  // sweep with UNKNOWN fields, never a thrown sweep. An unknown never fires (the
  // detector only fires on a crossing INTO a known-bad state), so a degraded read
  // is silent rather than a false alarm.
  const recoveryMembers = fleeted.map((agent) => ({
    ownerId: agent.agentId,
    isRegisteredLeader: agent.fleetRole === 'leader',
    hasProgressingClaim: agent.claims.some((claim) => claim.activity === 'progressing'),
  }));
  const [withLiveness, pressure, repeatedRecovery] = await Promise.all([
    reconcileWakeability(
      fleeted,
      undefined,
      undefined,
      undefined,
      undefined,
      RECONCILE_WAKEABILITY_PRODUCTION_OPTIONS,
    ).catch(() => fleeted),
    fetchContextPressure(fleeted.map((a) => a.agentId)).catch(() => new Map<string, string>()),
    readFleetRepeatedRecoveryStates(recoveryMembers).catch(() => new Map()),
  ]);

  // Keep the transition detector on the same parked-loop truth as
  // fleet:assignments. A raw fleet_assignment row can still carry a stale
  // progress-stalled bit while the member is healthily waiting for its next
  // wake or parked on an exact dependency event. If the loop read is
  // unavailable, leave stalled unknown so this sweep cannot manufacture an
  // actionable member-stalled edge from a partial read.
  let loopStateKnown = true;
  try {
    await decorateParkedOn(withLiveness, (ids) => listParkedAwaitsForSubscribers(ids));
  } catch {
    // A missing parked-await read is safe to degrade; the loop state below can
    // still suppress a false positive when it reports an active healthy loop.
  }
  try {
    await decorateLoopMonitorStates(withLiveness);
  } catch {
    loopStateKnown = false;
  }

  return withLiveness
    .filter((a): a is typeof a & { fleetSlug: string } => Boolean(a.fleetSlug))
    .map((a) => ({
      agentId: a.agentId,
      fleetSlug: a.fleetSlug,
      sessionState: a.sessionState ?? null,
      contextPressure: pressure.get(a.agentId) ?? null,
      wakeable: a.wakeable ?? null,
      claimCount: a.claims.length,
      claimKeys: a.claims.map((claim) => JSON.stringify([
        claim.type, claim.harnessSlug, claim.planSlug, claim.id,
      ])),
      stalled: loopStateKnown ? a.stalled === true : null,
      consecutiveRecoveryOnlyCycles:
        repeatedRecovery.get(a.agentId)?.status === 'measured'
          ? repeatedRecovery.get(a.agentId)?.consecutiveRecoveryOnlyCycles ?? null
          : null,
      isRegisteredLeader: a.fleetRole === 'leader',
      hasProgressingClaim: a.claims.some((claim) => claim.activity === 'progressing'),
    }));
}

/** Re-read one member's control state for the last-responsible-moment emit guard. */
async function gatherCurrentFleetMemberObservation(
  fleetSlug: string,
  agentId: string,
): Promise<
  Pick<
    FleetMemberObservation,
    'sessionState' | 'wakeable' | 'claimCount' | 'isRegisteredLeader' | 'hasProgressingClaim' | 'stalled'
  > | null
> {
  const agents = groupByAgent(await listFleetAssignments({ fleet: fleetSlug, agent: agentId }));
  const member = agents.find((agent) => agent.fleetSlug === fleetSlug);
  if (!member) return null;
  const [reconciled] = await reconcileWakeability(
    [member as ObservableAgent],
    undefined,
    undefined,
    undefined,
    undefined,
    RECONCILE_WAKEABILITY_PRODUCTION_OPTIONS,
  );
  await decorateParkedOn([reconciled], (ids) => listParkedAwaitsForSubscribers(ids));
  await decorateLoopMonitorStates([reconciled]);
  return {
    sessionState: reconciled?.sessionState ?? null,
    wakeable: reconciled?.wakeable ?? null,
    claimCount: reconciled?.claims.length ?? 0,
    isRegisteredLeader: reconciled?.fleetRole === 'leader',
    hasProgressingClaim: reconciled?.claims.some((claim) => claim.activity === 'progressing') ?? false,
    stalled: reconciled?.stalled === true,
  };
}

/**
 * Gather one round of fleet-level admission observations. Admission blocks are
 * already a bounded, fail-soft leader-brief read; this sweep only needs their
 * distinct count to detect a rising block edge. Keep measured zeroes in the
 * snapshot so a block that clears and later reappears is a real new crossing;
 * keep unavailable reads as null so they cannot manufacture a clear edge.
 */
export async function gatherFleetAdmissionObservations(): Promise<FleetAdmissionObservation[]> {
  let agents: ObservableAgent[];
  try {
    agents = groupByAgent(await listFleetAssignments({}));
  } catch {
    return [];
  }

  const fleeted = agents.filter((agent): agent is ObservableAgent & { fleetSlug: string } => Boolean(agent.fleetSlug));
  if (fleeted.length === 0) return [];

  // Admission notices are append-only and remain visible for 24 hours. Reconcile
  // the roster before reading them so a recorded/ended former member cannot keep
  // manufacturing an actionable leader wake after it has left the fleet. Unknown
  // enrichment fails open: isActionableFleetObservation only excludes the exact
  // recorded + non-wakeable + claimless stand-down shape.
  const withLiveness = await reconcileWakeability(
    fleeted,
    undefined,
    undefined,
    undefined,
    undefined,
    RECONCILE_WAKEABILITY_PRODUCTION_OPTIONS,
  ).catch(() => fleeted);
  const fleets = [...new Set(fleeted.map((agent) => agent.fleetSlug))].sort();
  return Promise.all(
    fleets.map(async (fleetSlug) => {
      try {
        const liveMemberIds = withLiveness
          .filter(
            (agent) =>
              agent.fleetSlug === fleetSlug &&
              agent.sessionState !== 'ended' &&
              isActionableFleetObservation({
                sessionState: agent.sessionState ?? null,
                wakeable: agent.wakeable ?? null,
                claimCount: agent.claims.length,
              }),
          )
          .map((agent) => agent.agentId)
          .sort();
        const read = await readFleetAdmissionBlocks(fleetSlug, { liveMemberIds });
        if (!read.available) return { fleetSlug, blockedCount: null };
        const times = read.blocks.map((block) => block.atMs).filter((atMs) => Number.isFinite(atMs));
        return {
          fleetSlug,
          blockedCount: read.blocks.length,
          newestBlockAtMs: times.length > 0 ? Math.max(...times) : null,
        };
      } catch {
        // `readFleetAdmissionBlocks` is already fail-soft in production, but
        // preserve the boundary if a test seam or future implementation throws.
        return { fleetSlug, blockedCount: null };
      }
    }),
  );
}

/** Injectable seams so the sweep unit-tests without PG. */
export interface FleetTransitionSweepDeps extends FleetTransitionEventsDeps {
  gather?: () => Promise<FleetMemberObservation[]>;
  gatherAdmissions?: () => Promise<FleetAdmissionObservation[]>;
}

/**
 * Run one sweep: observe, detect the crossings against the previous snapshot, emit
 * them, and keep the snapshot for next time. Returns the edges it fired, so the
 * routine can log a count and tests can assert without reading the emitter.
 *
 * The snapshot is advanced even when nothing fired — that is what makes the NEXT
 * sweep able to see a crossing.
 */
export async function runFleetTransitionSweep(deps: FleetTransitionSweepDeps = {}): Promise<number> {
  const gather = deps.gather ?? gatherFleetObservations;
  // Existing member-only tests inject `gather`; keep those tests hermetic by
  // making admission gathering explicit on an injected member gather. The
  // production action uses both default gathers.
  const gatherAdmissions = deps.gatherAdmissions ?? (deps.gather ? async () => [] : gatherFleetAdmissionObservations);
  const [rawObservations, admissionObservations] = await Promise.all([gather(), gatherAdmissions()]);
  const observations = rawObservations.filter(isActionableFleetObservation);
  const edges = detectFleetTransitions(previousObservations, observations, {
    deadLatch: memberDeadLatch,
    leftLatch: memberLeftLatch,
    nowMs: Date.now(),
  });
  const admissionEdges = detectFleetAdmissionTransitions(previousAdmissionObservations, admissionObservations, {
    firstSightingSinceMs: admissionBaselineSinceMs,
  });
  previousObservations = indexObservations(observations);
  // Merge measured values into the prior snapshot rather than replacing it.
  // An empty observation set can mean the outer roster read was unavailable,
  // and a per-fleet null means its optional block read was unavailable. Neither
  // is evidence of clearance. A genuine measured zero still overwrites the
  // prior count, so a later positive count remains a real new crossing.
  for (const observation of admissionObservations) {
    if (typeof observation.blockedCount === 'number' && Number.isFinite(observation.blockedCount)) {
      previousAdmissionObservations.set(observation.fleetSlug, observation.blockedCount);
    }
  }
  let emitDeps = deps;
  const memberDeadEdges = edges.filter((edge) => edge.kind === 'member-dead');
  const memberLeftEdges = edges.filter((edge) => edge.kind === 'member-left');
  const contextEdges = edges.filter((edge) => edge.kind === 'context-critical');
  const repeatedRecoveryEdges = edges.filter((edge) => edge.kind === 'repeated-recovery');
  const stalledEdges = edges.filter((edge) => edge.kind === 'member-stalled');
  if (
    (memberDeadEdges.length > 0 ||
      memberLeftEdges.length > 0 ||
      contextEdges.length > 0 ||
      stalledEdges.length > 0 ||
      repeatedRecoveryEdges.length > 0) &&
    !deps.gather
  ) {
    // The production sweep gathers a cached observation first, then supplies a
    // single shared current-state read to all detached edge emits. Keeping the
    // read lazy makes the revalidation happen after the sweep has yielded, which
    // is exactly the recovery-before-delivery race this guard closes.
    emitDeps = { ...deps };
    if (contextEdges.length > 0 && !deps.currentContextPressure) {
      const agentIds = [...new Set(contextEdges.map((edge) => edge.agentId))];
      let currentPressure: Promise<Map<string, ContextPressureBucket>> | null = null;
      emitDeps.currentContextPressure = async (agentId: string) => {
        currentPressure ??= fetchContextPressure(agentIds);
        return (await currentPressure).get(agentId) ?? null;
      };
    }
    if (!deps.currentMemberObservation) {
      emitDeps.currentMemberObservation = gatherCurrentFleetMemberObservation;
    }
  }
  for (const edge of edges) emitFleetTransitionEdge(edge, emitDeps);
  for (const edge of admissionEdges) emitFleetAdmissionTransitionEdge(edge, deps);
  return edges.length + admissionEdges.length;
}

/**
 * How often the control-state reconcile runs, independent of this sweep's own cadence.
 * The sweep ticks every minute because a transition edge is time-sensitive; a fleet that
 * has been dead for three days is not, and re-reading the whole registry every minute
 * would be pure waste. Module-scoped for the same reason the snapshot above is — losing
 * it to a restart costs one delayed pass, nothing more.
 */
const CONTROL_RECONCILE_INTERVAL_MS = 15 * 60 * 1000;
let lastControlReconcileMs = 0;

/** Test-only: let a case drive the reconcile without waiting out the interval. */
export function __resetFleetControlReconcileThrottleForTests(): void {
  lastControlReconcileMs = 0;
}

registerSystemAction('fleet-transition-sweep', async (ctx: SystemActionCtx) => {
  const fired = await runFleetTransitionSweep();
  // Only speak when something actually crossed — this runs every minute, and a
  // per-tick "swept, nothing to report" line is the log noise that trains readers
  // to filter the channel out.
  if (fired > 0) console.log(`[fleet-transition-sweep] fired ${fired} transition event(s)`);

  // WI-35718: reconcile DECLARED fleet control state against observed reality, on its own
  // slower clock. Rides this sweep rather than adding a routine — it needs the same fleet
  // view, and the repo's scheduling rule is to reuse an existing mechanism rather than
  // introduce a third one.
  const nowMs = Date.now();
  if (nowMs - lastControlReconcileMs < CONTROL_RECONCILE_INTERVAL_MS) return;
  lastControlReconcileMs = nowMs;
  try {
    const { reconcileFleetControlStates, defaultFleetControlReconcileDeps } = await import('./fleet-control-reconcile');
    const res = await reconcileFleetControlStates(await defaultFleetControlReconcileDeps(ctx.workspaceId));
    // Speak only on a real mutation. A wind-down is a registry write other components read,
    // so it must be attributable in the log; a quiet pass must not be.
    if (res.woundDown.length > 0) {
      console.log(
        `[fleet-control-reconcile] wound down ${res.woundDown.length} stale fleet(s): ` +
          `${res.woundDown.join(', ')} (considered ${res.considered})`,
      );
    }
  } catch (e) {
    // Never let the reconcile cost the transition sweep — that is the time-sensitive half.
    console.warn(`[fleet-control-reconcile] pass failed: ${e instanceof Error ? e.message : e}`);
  }
});
