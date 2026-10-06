/**
 * fleet:leader-brief — ONE-call fleet-health brief for a leader's own fleet
 * (fleet-reliability-verification-2026-07-10 P-007).
 *
 * Night-shift lesson (2026-07-09/10, ~45 leader wakes): the leader had to
 * hand-assemble "who's actually working / who's stuck / who hasn't answered
 * me / who's about to compact" EVERY monitor tick from separate presence +
 * assignments + inbox + item reads. This is that assembly, done once,
 * server-side: per-member { sessionState, verdict, lastToolCallAtAgeMs,
 * claims (doing/queued/load), stalled, unanswered directed messages (with
 * age), contextPressure, bench state (parkedOn) }.
 *
 * EI-9943 (session retrospective, fleet p2p-ship 2026-07-11/12): the SAME
 * night-shift pattern recurred one level up — 3 of 5 members ran a live
 * monitor loop for 58/37/19 turns each, structurally blocked on one member's
 * critical-path diagnosis, instead of parking on an event (fleet:bench
 * already existed but nobody staged it). `benchSuggestion` closes that gap:
 * a per-member flag, computed from signals this tool already decorates
 * (`stalled` + `verdict` + `parkedOn` — no new tracking), naming a member
 * that is alive/speaking-or-first-turn-done, not advancing, and not already
 * benched — the leader's one-glance cue to fleet:bench it onto the right gate.
 *
 * Deliberately THIN: it is fleet:assignments' existing decoration pipeline
 * (reconcileWakeability → decorateParkedOn → decorateLoopMonitorStates →
 * decorateMemberVerdicts → decorateProductiveToolCalls →
 * decorateContextPressure → decorateUnansweredDirected — all reused verbatim,
 * reuse-first, no forked logic) filtered to ONE fleet's members and reshaped
 * into a leader-lean per-member row (ages in ms, not raw timestamps; claims
 * collapsed to counts — the fields a leader's relaunch/re-steer/nudge
 * decision actually reads, not the full claim-ledger fleet:assignments
 * carries for the Queen's placement decision).
 *
 * Resolves the target fleet from the caller's durable leadership relation when
 * `fleet` is omitted. A sole led fleet is unambiguous; a multi-led caller must
 * pass `fleet` explicitly. The current presence membership remains a fallback
 * only when the caller leads no fleet (and the launch environment is a
 * failure-only fallback inside the presence resolver). coord:orient's monitor
 * mode folds this in for a fleet leader automatically (see orient.ts) — a
 * leader's monitor wake is then ONE round-trip instead of orient + a separate
 * fleet:assignments scan.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  readFleetLaneHealthDiagnosed,
  type FleetLaneHealthReadResult,
  type FleetLaneHealthUnavailable,
} from '../../fleet/lane-health';
import { canonicalExecutableWidth, exactPositiveSinglePlanSlugFromFilter } from '../../fleet/executable-frontier';
import { computeFleetUnderStaffedAlert, type FleetUnderStaffedEvaluation } from '../../fleet/under-staffed-alert';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { buildClaimableNowAggregate } from './leader-brief-aggregate';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity, deriveFleetMembership } from '../coordination/identity';
import type { AgentIdentity } from '../coordination/identity';
import { foldNeverDropFacts } from '../../agent-facts/store';
// P-025 / D-053: imported from the sink-neutral seam, NOT from
// `turn-start-orientation` directly — that module is the turn-start sink's own
// home, and a non-turn-start sink reaching into it is a layering inversion even
// though both names resolve to the same binding.
import { ORIENTATION_CLASS_REGISTRY } from '../../orientation-class-registry';
import type { RegisteredOrientationClass } from '../../orientation-class-registry';
import {
  getFleet,
  getFleetHeadcountTarget,
  listFleetsLedBy,
  projectFleetHeadcountState,
  type AgentFleetRecord,
  type FleetControlState,
  type FleetLaunchGovernorAction,
  type FleetLaunchGovernorOutcome,
  type FleetLaunchTransaction,
} from '../../agent-fleets-store';
import { takeFleetLeadership } from '../fleet_registry/take-leadership-core';
import {
  countedMemberSet,
  readFleetMemberSilence,
  type FleetMemberSilencePartition,
} from '../fleet_registry/silent-member';
import {
  ensureFleetLeaderControl,
  resolveFleetLeaderTransitionEventKeys,
  shouldMaintainFleetLeaderControl,
  type LeaderControlOutcome,
} from '../fleet_registry/leader-control';
import {
  decideLeadershipDisposition,
  buildNotLeaderNotice,
  type LeadershipDisposition,
  type NotLeaderNotice,
  type AutoClaimedNotice,
} from './leadership-disposition';
import { resolvePresenceFleet } from '../coordination/presence-fleet';
import { resolveSelfRef, markSelfRows, type SelfRef } from '../coordination/self-marker';
import { buildFleetPopulationLifecycle, selectFleetPopulation, type FleetPopulationCensus } from './fleet-population';
import { fleetEverMembers } from '../../fleet-membership-store';
import { listLatestStrandedByCoordOwners } from '../../task-manager/store';
import { COORD_ROLES } from '../coordination/roles';
import { listFleetRosterDiagnosed, liveFleetMemberIds, type ListFleetRosterResult } from '../../fleet/fleet-roster';
import {
  executingOwnersSince,
  shouldRecoverClaimFromHealth,
  type AgentAssignment,
  type ClaimHealth,
} from '../../fleet/assignments';
import { listPresence } from '../coordination/presence';
import { findLiveHost } from '../../events/await/psu-pty-discovery';
import { applyPsuHostAuthority } from '../coordination/liveness-oracle';
import {
  reconcileWakeability,
  RECONCILE_WAKEABILITY_PRODUCTION_OPTIONS,
  decorateParkedOn,
  decorateLoopMonitorStates,
  decorateMemberVerdicts,
  decorateProductiveToolCalls,
  decorateContextPressure,
  decorateUnansweredDirected,
  decorateDirectiveActuation,
  decorateCoordDeafness,
  VERDICT_SPEAKING_FRESH_MS,
  type MemberVerdict,
  type MonitorState,
} from './assignments';
import type { LifecycleBackoffInfo } from '../../harness/routines/loop';
import type { CoordDeafState } from '../coordination/inbox-read-freshness';
import type { SessionState } from '../coordination/presence-wakeability';
import type { WakeMode } from '../coordination/wake-mode';
import type { ContextPressureBucket } from '../coordination/context-pressure';
import type { RepeatedRecoveryAlert } from '../../fleet-repeated-recovery';
import type { UnansweredDirectedSummary } from '../coordination/unanswered-directed';
import type { DirectiveActuationSummary } from '../coordination/directive-effect';
import {
  readUnownedCriticalsForFleet,
  readOrphanedInFlightForFleet,
  partitionUnownedCriticalsByOrigin,
  type UnownedCriticalCandidate,
  type OrphanedInFlightCandidate,
} from '../../harness/improvements/unowned-critical-escalation';
import {
  readFleetAdmissionBlocks,
  type FleetAdmissionBlock,
  type FleetAdmissionBlockRead,
} from '../coordination/fleet-scope-admission-blocks';
import type { InvariantEvaluation } from './invariants';
import { listActiveComposedRoots, loadTreeLeaves } from '../../events/await/compose-store';
import {
  listActiveAnnouncements,
  listActiveAwaitsForKey,
  listVerifiedWaitTakeoversForSubscribers,
  type VerifiedWaitTakeoverAlert,
} from '../../events/await/store';
// P-027 / D-063: the announced-gate read + visibility-scope pairing now lives in
// ONE place shared with the turn-start sink. `announcementVisibleTo` is applied
// inside it, so this file no longer imports the predicate directly — that is the
// point: two hand-written copies of "list then scope" could diverge silently,
// each still rendering a plausible-but-differently-scoped gate list.
import { readVisibleAnnouncements } from '../../events/await/announced-gate-view';
import type { TimeoutBehavior } from '../../events/await/types';
import type { FilterNode } from '../../scheduler/claim-spec';
import { withBoundedTimeout } from '../../bounded-timeout';
import { fetchGatewayHeadroom } from '../../inference-gateway/observability';
import { buildCapacityReport } from '../../fleet/capacity-dispatch';
import type { AccountProvider } from '../../deployment/account-pool';
import { providerForModel, readProviderAvailability } from './capacity';
import type { FleetBriefDelta } from '../../fleet-brief-delta';
import type { FleetCampaign } from './fleet-campaign';
import {
  computeMemberIdleVerdict,
  PRODUCTIVE_STALL_BUDGET_MS,
  summariseIdleCauses,
} from '../../fleet-member-idle-verdict';
import type { MemberIdleCause } from '../../fleet-member-idle-verdict';
import { computePoolReservation } from '../../fleet-pool-reservation';
import { buildPolicyParkedCapacity, resolveFleetParkResumePath } from '../../fleet-park-resume-path';
import { listWorkItems, WORK_ITEMS_MAX_LIMIT, type WorkItem } from '../../work-items';
import { readPlanHistoryContext, type PlanHistoryContext } from '../../prior-attempt-context';
import { readIssueOccurrenceCounts, type IssueOccurrenceCounts } from '../../issue-occurrence-ledger';
import {
  FLEET_METRICS_SCHEMA_VERSION,
  parseFleetMetricsResult,
  type FleetMetricsResult,
} from './fleet-metrics-contract';
import { resolveFleetMetricScope, type FleetMetricScopeResolution } from './fleet-metrics-scope';
import { buildFleetMetricsResult } from '../work_items/burn_down';
import { trimToByteBudget } from '../_bound-output';
import { LEADER_BRIEF_SHAPER_BUDGET_CHARS, shapeLeaderBrief } from './leader-brief-shape';
import { readLeaderCheckpointProgress, type LeaderCheckpointProgress } from './leader-brief-progress';
import { getLongCallsInFlight } from '../../in-flight-calls';
import { readDependencyBottlenecks, type DependencyBottleneckResult } from '../../dependency-traversal';
import { renderDependencyBottleneckMermaid } from '../../dependency-mermaid';
import { mapWithConcurrency } from '../../gym/concurrency';
import type {
  AgentObligation,
  AgentObligationAgenda,
  AgentObligationAction,
  AgentObligationProjection,
} from '../../agent-obligations';
import {
  computeLeaderBlockerStallView,
  DEFAULT_LEADER_BLOCKER_STALL_THRESHOLD_HOURS,
  type LeaderBlockerStallView,
} from '../../leader-blocker-stall-alert';
import { computeStalledItemRotation, type StalledItemRotation } from './stalled-item-rotation';

// EI-20226510994156306: a 50-member leader brief previously serialized ~66KB
// before the transport's own result cap. Keep the detailed, verbose rows small;
// the compact memberVerdicts index below preserves every member id + verdict so
// a leader can still identify who needs a targeted follow-up after transport
// trimming.
const LEADER_BRIEF_MEMBER_DETAIL_BUDGET = 8_000;
const LEADER_BRIEF_RESERVATION_DETAIL_BUDGET = 3_500;

/**
 * EI-21577690778811728: the leader brief has several independent, read-only
 * decorations and diagnostics after the roster/liveness barriers. Running all
 * of them serially adds their database latency and routinely crosses the MCP
 * 30-second transport deadline; running them unbounded would replace latency
 * with a connection/query burst during exactly the recovery window this tool
 * serves. Keep the fan-out deterministic and bounded.
 */
export const LEADER_BRIEF_READ_CONCURRENCY = 4;
export const LEADER_BRIEF_HEADCOUNT_TIMEOUT_MS = 3_000;

export type LeaderBriefSilentMembers =
  | { status: 'measured'; ownerIds: string[]; thresholdMs: number; paused: boolean }
  | { status: 'unknown'; reason: string };

/**
 * P-007 / R-17: name the live members the silence rule left out of
 * `headcount.current`. An unreadable roster or silence leg is `unknown` with a
 * reason — never an empty list, which would read as "nobody is silent".
 */
export function silentMembersSummary(
  liveMemberIds: readonly string[] | null,
  partition: FleetMemberSilencePartition | null,
): LeaderBriefSilentMembers {
  if (liveMemberIds == null) return { status: 'unknown', reason: 'live roster unreadable' };
  if (partition == null) return { status: 'unknown', reason: 'execution or await leg unreadable' };
  return {
    status: 'measured',
    ownerIds: [...partition.silent],
    thresholdMs: partition.thresholdMs,
    paused: partition.paused,
  };
}
/**
 * Keep optional leader-brief legs below the MCP transport budget. The roster
 * has its own larger, per-leg budget; everything after it is advisory and can
 * truthfully degrade to an absent/unknown block when the database is slow.
 */
export const LEADER_BRIEF_OPTIONAL_READ_TIMEOUT_MS = 750;
/**
 * The MCP clients used by fleet leaders abandon a call at ~30s. Per-leg bounds
 * protect individual reads, but dependency-ordered phases still add together.
 * Keep a whole-call backstop with enough margin for serialization/transport so
 * a slow database yields an explicit degraded brief instead of -32001/no body.
 */
export const LEADER_BRIEF_TOTAL_TIMEOUT_MS = 25_000;

export interface LeaderBriefFleetMetricsDeps {
  resolveScope(input: {
    workspaceId: string;
    harness: string;
    fleet: string;
    flowMode: 'current-spec';
  }): Promise<FleetMetricScopeResolution>;
  listItems(input: { harness: string; includeObservations: true; limit: number }): Promise<WorkItem[]>;
  readOccurrences(input: { workspaceId: string; harnessSlug: string; since: string }): Promise<IssueOccurrenceCounts>;
  build(
    resolution: FleetMetricScopeResolution,
    items: readonly WorkItem[],
    opts: {
      issueOccurrences: IssueOccurrenceCounts | PromiseLike<IssueOccurrenceCounts>;
      sourceCapExhausted: boolean;
      assignee?: string;
      /** P-001: scopes the feature-close claim history and fleet pause reads. */
      workspaceId?: string | null;
    },
  ): Promise<FleetMetricsResult>;
}

const LEADER_BRIEF_FLEET_METRICS_DEPS: LeaderBriefFleetMetricsDeps = {
  resolveScope: resolveFleetMetricScope,
  listItems: listWorkItems,
  readOccurrences: readIssueOccurrenceCounts,
  build: buildFleetMetricsResult,
};

/** A failed fleet-metrics leg is data, never an omitted/zero-looking block. */
export function leaderBriefFleetMetricsUnavailable(input: {
  fleet: string;
  harness: string | null;
  reason: string;
  recoverVia: string;
}): Extract<FleetMetricsResult, { ok: false }> {
  const parsed = parseFleetMetricsResult({
    ok: false,
    schemaVersion: FLEET_METRICS_SCHEMA_VERSION,
    error: 'fleet_metrics_unavailable',
    reason: input.reason,
    recoverVia: input.recoverVia,
    requested: {
      fleet: input.fleet,
      harness: input.harness ?? '(unresolved)',
      flowMode: 'current-spec',
      window: 'fleet-lifetime',
    },
  });
  if (parsed.ok) throw new Error('leader-brief unavailable fleet metrics parsed as a snapshot');
  return parsed;
}

/** P-005 / D-001: reuse work_items:burn_down's canonical resolver + builder. */
export async function readLeaderBriefFleetMetrics(
  input: { workspaceId: string; fleet: string; harness: string | null; assignee?: string },
  deps: LeaderBriefFleetMetricsDeps = LEADER_BRIEF_FLEET_METRICS_DEPS,
): Promise<FleetMetricsResult> {
  if (!input.harness) {
    return leaderBriefFleetMetricsUnavailable({
      fleet: input.fleet,
      harness: null,
      reason: 'fleet metric harness is unresolved',
      recoverVia: 'fleet:leader-brief { fleet, harness }',
    });
  }
  try {
    const itemsPromise = Promise.resolve(
      deps.listItems({
        harness: input.harness,
        includeObservations: true,
        limit: WORK_ITEMS_MAX_LIMIT,
      }),
    );
    // A failed item read must remain observed even when scope resolution fails
    // first; the metric leg is best-effort and must not create an unhandled
    // rejection while it is being abandoned.
    void itemsPromise.catch(() => undefined);
    const resolution = await deps.resolveScope({
      workspaceId: input.workspaceId,
      harness: input.harness,
      fleet: input.fleet,
      flowMode: 'current-spec',
    });
    if (!resolution.ok) return parseFleetMetricsResult(resolution);
    const issueOccurrences = deps.readOccurrences({
      workspaceId: input.workspaceId,
      harnessSlug: input.harness,
      since: resolution.scope.window.startAt,
    });
    // The builder consumes this promise after it has started its floor read, so
    // the two independent aggregate queries can overlap.
    void issueOccurrences.catch(() => undefined);
    const items = await itemsPromise;
    return await deps.build(resolution, items, {
      issueOccurrences,
      sourceCapExhausted: items.length >= WORK_ITEMS_MAX_LIMIT,
      assignee: input.assignee,
      workspaceId: input.workspaceId,
    });
  } catch (error) {
    return leaderBriefFleetMetricsUnavailable({
      fleet: input.fleet,
      harness: input.harness,
      reason: `canonical fleet metric read failed${error instanceof Error && error.message ? `: ${error.message}` : ''}`,
      recoverVia:
        `work_items:burn_down { harness: '${input.harness}', fleet: '${input.fleet}', ` +
        `window: 'fleet-lifetime', flowMode: 'current-spec' }`,
    });
  }
}

export async function runLeaderBriefWithinDeadline<T>(
  work: () => Promise<T>,
  fallback: T,
  timeoutMs = LEADER_BRIEF_TOTAL_TIMEOUT_MS,
): Promise<T> {
  const result = await withBoundedTimeout(work, {
    fallback,
    timeoutMs,
    label: 'fleet:leader-brief:total',
  });
  return result.value;
}

/** Consume the one canonical producer result at its existing tool sink. The
 * component pin goes to the invocation ledger's metadata callback; the public
 * structured brief remains the same object and is never rendered a second time. */
export async function bindLeaderBriefResult<T extends { data: Record<string, unknown> }>(
  result: T,
  scope: { fleet?: string; harness?: string; workspace?: string | null },
  metadata?: (data: Record<string, unknown>) => void,
  binder?: typeof import('../../agent-identities/source').bindSelectedIdentitySetting,
): Promise<T> {
  try {
    const bind = binder ?? (await import('../../agent-identities/source')).bindSelectedIdentitySetting;
    const data = result.data;
    const error = typeof data.error === 'string' ? data.error : null;
    const ineligible = Boolean(data.notLeader) || error === 'no_fleet' || error === 'ambiguous_fleet';
    const omission = data.ok === false || Boolean(data.notLeader)
      ? ineligible
        ? { reason: 'ineligible' as const }
        : { reason: 'unavailable' as const, errorRef: `fleet:leader-brief:${error ?? 'unknown'}` }
      : undefined;
    const summary = data.summary && typeof data.summary === 'object' ? data.summary as { fleet?: unknown } : null;
    const receipt = await bind({
      identityId: 'su.fleet-leader', contributionId: 'fleet-leader-brief', sourceTier: 'builtin',
      ...(omission ? { omission } : { value: data }),
      scope: { workspace: scope.workspace ?? null, harness: scope.harness ?? null,
        fleet: typeof summary?.fleet === 'string' ? summary.fleet : scope.fleet ?? null,
        sink: 'on-demand' },
      observedAt: new Date().toISOString(),
    });
    metadata?.({ identityContribution: receipt });
  } catch (error) {
    // The current public brief remains available even when its provenance
    // binding fails. Record the failure instead of fabricating a pinned value.
    metadata?.({ identityContribution: {
      identityId: 'su.fleet-leader', contributionId: 'fleet-leader-brief',
      status: 'unavailable', errorRef: 'fleet:leader-brief:identity-binding-failed',
      detail: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    } });
  }
  return result;
}

type LeaderBriefReadResult<T> = T extends () => Promise<infer R> ? R : never;

/** Run independent leader-brief reads with stable result order and bounded width. */
export async function runLeaderBriefReads<T extends readonly (() => Promise<unknown>)[]>(
  reads: T,
  concurrency = LEADER_BRIEF_READ_CONCURRENCY,
): Promise<{ [K in keyof T]: LeaderBriefReadResult<T[K]> }> {
  return (await mapWithConcurrency(reads, concurrency, (read) => read())) as {
    [K in keyof T]: LeaderBriefReadResult<T[K]>;
  };
}

/**
 * Bound a best-effort leader-brief leg. A bounded fan-out still hangs when one
 * member promise never settles, so every optional read uses this helper at the
 * leaf. The fallback keeps the caller's existing "unknown/absent" contract.
 */
async function boundedLeaderBriefRead<T>(
  label: string,
  work: () => Promise<T>,
  fallback: T,
  timeoutMs = LEADER_BRIEF_OPTIONAL_READ_TIMEOUT_MS,
): Promise<T> {
  try {
    const result = await withBoundedTimeout(work, {
      fallback,
      timeoutMs,
      label: `leader-brief:${label}`,
    });
    return result.value;
  } catch {
    // `withBoundedTimeout` catches rejected promises; this covers a synchronous
    // thunk failure as well, preserving the same fail-soft contract.
    return fallback;
  }
}

/**
 * Run optional reads with both bounded width and a per-leg deadline. The
 * regular fan-out helper intentionally has no fallback policy because callers
 * use it for already-bounded reads too; this companion makes the fail-soft
 * contract explicit at the call site for the broader full brief.
 */
export async function runBoundedLeaderBriefReads<T extends readonly (() => Promise<unknown>)[]>(
  reads: T,
  fallbacks: readonly unknown[],
  label: string,
  concurrency = LEADER_BRIEF_READ_CONCURRENCY,
  timeoutMs = LEADER_BRIEF_OPTIONAL_READ_TIMEOUT_MS,
): Promise<{ [K in keyof T]: LeaderBriefReadResult<T[K]> }> {
  if (reads.length !== fallbacks.length) {
    throw new Error('leader-brief bounded read fallback count mismatch for ' + label);
  }
  const boundedReads = reads.map(
    (read, index) => () => boundedLeaderBriefRead<unknown>(label + ':' + index, read, fallbacks[index], timeoutMs),
  );
  return (await runLeaderBriefReads(boundedReads as never, concurrency)) as {
    [K in keyof T]: LeaderBriefReadResult<T[K]>;
  };
}

function leaderBriefClaimabilityRecovery(fleet: string, harness?: string | null): string {
  return harness
    ? `work_items:claimable ${JSON.stringify({ harness, spec: fleet, breakdownOnly: true })}`
    : `scheduler:get_claim_spec ${JSON.stringify({ fleet, history: 0 })}, then ` +
        'work_items:claimable with that spec and its resolved harness';
}

/** Explicit fallback for the optional lane-health leg; UNKNOWN is never rendered as zero. */
export function leaderBriefLaneHealthUnavailable(input: {
  fleet: string;
  harness?: string | null;
}): FleetLaneHealthReadResult {
  const unavailable: FleetLaneHealthUnavailable = {
    code: 'leader-brief-budget-exceeded',
    stage: 'leader-brief',
    detail:
      `Fleet lane health did not settle inside the ${LEADER_BRIEF_OPTIONAL_READ_TIMEOUT_MS}ms ` +
      'optional-read deadline; the brief abandoned no unbounded aggregate and inferred no zero.',
    recoverVia: leaderBriefClaimabilityRecovery(input.fleet, input.harness),
    spec: null,
    basis: null,
  };
  return { laneHealth: null, unavailable };
}

/**
 * Bind lane health to the same whole-call allowance its leader-brief consumer owns.
 * The diagnosed reader refuses to start an issue aggregate that cannot fit.
 */
export async function readLeaderBriefLaneHealth(
  input: { fleet: string; harness?: string; workspaceId?: string | null },
  read: typeof readFleetLaneHealthDiagnosed = readFleetLaneHealthDiagnosed,
): Promise<FleetLaneHealthReadResult> {
  return read({
    ...input,
    issueFamilyTotalBudgetMs: LEADER_BRIEF_OPTIONAL_READ_TIMEOUT_MS,
  });
}

/** PURE: keep an unavailable admission read distinct from a measured zero. */
export function projectFleetAdmissionBlockRead(read: FleetAdmissionBlockRead): {
  blocks: FleetAdmissionBlock[];
  count: number | null;
} {
  return read.available ? { blocks: read.blocks, count: read.blocks.length } : { blocks: [], count: null };
}

/**
 * EI-21548894457555139: how long a call must have been in flight before it is worth
 * reporting on a member row (and before it suppresses `dormant` / `benchSuggestion`).
 *
 * Deliberately far SHORTER than VERDICT_SPEAKING_FRESH_MS (5 min). That constant asks
 * "did a call SETTLE recently enough to prove liveness?" — a backward-looking window
 * that must be generous. This one asks "is a call running RIGHT NOW?", which is a
 * present-tense fact needing no grace period; 30s is just long enough to exclude the
 * ordinary sub-second traffic that would otherwise fill the brief.
 */
const LONG_CALL_IN_FLIGHT_MS = 30_000;

export interface LeaderMonitoringBlindAdvisory {
  line: string;
  missingEventKeys: string[];
  arm: {
    tool: 'events:await';
    args: { event: string; note: string };
  };
}

/** Pure verdict over the same live-awaiter meaning written by events:catalog. */
export function computeLeaderMonitoringBlindAdvisory(input: {
  fleetSlug: string;
  eventKeys: readonly string[];
  liveAwaiters: ReadonlyMap<string, number>;
}): LeaderMonitoringBlindAdvisory | undefined {
  const missingEventKeys = input.eventKeys.filter((eventKey) => (input.liveAwaiters.get(eventKey) ?? 0) === 0);
  if (missingEventKeys.length === 0) return undefined;
  return {
    line:
      `You are monitoring blind: ${missingEventKeys.length}/${input.eventKeys.length} required fleet transition ` +
      `event key(s) have live_awaiters:0.`,
    missingEventKeys,
    arm: {
      tool: 'events:await',
      args: {
        event: `@fleet:${input.fleetSlug}`,
        note: `Restore a pushed transition wake for fleet ${input.fleetSlug}; leader control reconciles the durable profile watches.`,
      },
    },
  };
}

/**
 * Read the fleet's exact profile-derived transition keys from the existing
 * event-await store. Discovery is advisory, so any read/resolution failure omits
 * the block instead of degrading the rest of the leader brief.
 */
export async function readLeaderMonitoringBlindAdvisory(
  fleetSlug: string,
  readActiveAwaits: (eventKey: string) => Promise<readonly unknown[]> = listActiveAwaitsForKey,
  timeoutMs = LEADER_BRIEF_OPTIONAL_READ_TIMEOUT_MS,
): Promise<LeaderMonitoringBlindAdvisory | undefined> {
  try {
    const eventKeys = resolveFleetLeaderTransitionEventKeys({ fleetSlug });
    const reads = await runLeaderBriefReads(
      eventKeys.map(
        (eventKey) => () =>
          withBoundedTimeout(readActiveAwaits(eventKey), {
            fallback: null,
            timeoutMs,
            label: 'leader-brief:monitoring-blind-awaiters',
          }),
      ) as never,
    );
    const results = reads as Array<Awaited<ReturnType<typeof withBoundedTimeout<readonly unknown[] | null>>>>;
    // A timeout/error means the awaiter count is UNKNOWN. Do not turn that
    // into zero and emit a false "monitoring blind" alarm.
    if (results.some((result) => result.degraded || result.value == null)) return undefined;
    const counts = results.map((result, index) => {
      if (result.value == null) throw new Error('leader-brief:monitoring-blind-awaiters missing value');
      return [eventKeys[index], result.value.length] as const;
    });
    return computeLeaderMonitoringBlindAdvisory({
      fleetSlug,
      eventKeys,
      liveAwaiters: new Map(counts),
    });
  } catch {
    return undefined;
  }
}

export interface LeaderBriefAnnouncedGate {
  event: string;
  note: string | null;
  scope: string;
  announcedBy: string;
  fired: boolean;
  firedAt: string | null;
  awaiters: number;
}

/**
 * P-027: the acting leader cockpit must not reassemble its gate panel from a
 * second events:catalog call. Read every live announcement generation visible
 * to this fleet/plan/harness, including fired latches, and join the current
 * waiter count onto the same row. A successful empty read is `[]`; an absent
 * field means the discovery/count leg was unavailable and must never render as
 * "no gates".
 */
export async function readLeaderAnnouncedGates(
  input: {
    fleetSlug: string;
    planSlug?: string | null;
    harnessSlug?: string | null;
  },
  deps: {
    listAnnouncements?: typeof listActiveAnnouncements;
    listAwaits?: typeof listActiveAwaitsForKey;
    registry?: readonly RegisteredOrientationClass[];
  } = {},
): Promise<LeaderBriefAnnouncedGate[] | undefined> {
  // P-027: applicability is DECLARED in the shared orientation class registry,
  // not assumed here. Same consumption shape as `readLeaderNeverDropFacts`
  // (D-053): a STRUCTURED sink reads the declaration through
  // `RegisteredOrientationClass.id` and emits its own field, rather than
  // through `segments[].render` — pushing a rendered line into this JSON would
  // be the "second copy of the line" the registry exists to prevent. Reading
  // the declaration is what makes withdrawing the sink a ONE-LINE change in the
  // registry with no second edit here.
  const registry = deps.registry ?? ORIENTATION_CLASS_REGISTRY;
  const declared = registry.some(
    (entry) => entry.id === 'announcedGates' && entry.applicableSinks.includes('leader-brief'),
  );
  if (!declared) return undefined;
  const listAnnouncements = deps.listAnnouncements ?? listActiveAnnouncements;
  const listAwaits = deps.listAwaits ?? listActiveAwaitsForKey;
  const probe = await withBoundedTimeout(
    async () => {
      // P-027 / D-063: the read + visibility-scope pairing is shared with the
      // turn-start sink. `unfiredOnly: false` is this sink's own choice and is
      // the substantive difference — a leader cockpit must show FIRED latches,
      // which a per-turn block deliberately must not carry.
      const visible = await readVisibleAnnouncements(
        {
          scope: {
            fleetSlug: input.fleetSlug,
            planSlug: input.planSlug ?? null,
            harnessSlug: input.harnessSlug ?? null,
          },
          unfiredOnly: false,
          limit: 100,
        },
        { listAnnouncements },
      );
      return Promise.all(
        visible.map(async (announcement) => ({
          event: announcement.eventKey,
          note: announcement.note,
          scope: announcement.scopeKind
            ? `${announcement.scopeKind}${announcement.scopeRef ? ':' + announcement.scopeRef : ''}`
            : 'global',
          announcedBy: announcement.subscriberId,
          fired: !!announcement.firedAt && announcement.firedReason === 'event',
          firedAt: announcement.firedReason === 'event' ? announcement.firedAt : null,
          awaiters: (await listAwaits(announcement.eventKey)).length,
        })),
      );
    },
    {
      fallback: null,
      timeoutMs: 1_500,
      label: 'leader-brief:announced-gates',
    },
  );
  return probe.degraded || probe.value == null ? undefined : probe.value;
}

/**
 * P-025: the never-drop facts that apply to THIS leader's scope.
 *
 * WHY THE LEADER SINK NEEDS THIS AT ALL. A fleet leader has the widest blast
 * radius on the pot and, until this reader, received no dead-end / wall /
 * guard-rail facts at all — the "antidote absent where the poison is strongest"
 * failure EI-18725816532600240 established for cold wakes. Measured before
 * writing it: `neverDrop|never-drop` occurred 0 times in this file, against a
 * positive control (`announcedGates|announcement`) of 22 in the same file, so
 * the zero was a measurement rather than a broken grep.
 *
 * ⚠ HOW THIS CONSUMES THE SHARED REGISTRY — see plan decision D-053.
 * The registry (P-023 / D-015) declares each orientation class ONCE and every
 * applicable surface renders it FROM that declaration. But its segments are
 * LINE-oriented (`render` returns `string[]`), while this brief is a STRUCTURED,
 * field-capped payload. So a structured sink reuses the declaration through
 * `RegisteredOrientationClass.id` — which is typed `keyof OrientationState` —
 * and NOT through `segments[].render`. Pushing a rendered line into this JSON
 * payload would be exactly the "second copy of the line" the registry forbids.
 * That is why this reads the registry for applicability instead of hardcoding
 * the class: if `neverDropFacts` is ever withdrawn from the leader-brief sink,
 * this returns undefined without a second edit here.
 *
 * The FACTS themselves come from `foldNeverDropFacts` — the same reader
 * turn-start uses — so the two surfaces cannot drift on what counts as a
 * never-drop fact. Selectors mirror turn-start's: workspace scope plus this
 * leader's owner scope.
 */
export async function readLeaderNeverDropFacts(
  input: { ownerId: string | null; workspaceId: string },
  deps: {
    fold?: typeof foldNeverDropFacts;
    registry?: readonly RegisteredOrientationClass[];
  } = {},
): Promise<string[] | undefined> {
  const registry = deps.registry ?? ORIENTATION_CLASS_REGISTRY;
  const declared = registry.some(
    (entry) => entry.id === 'neverDropFacts' && entry.applicableSinks.includes('leader-brief'),
  );
  // Not declared for this sink ⇒ render nothing. Reading the declaration rather
  // than assuming it keeps `applicableSinks` the single source of truth.
  if (!declared) return undefined;
  const fold = deps.fold ?? foldNeverDropFacts;
  const selectors = [
    { scope: 'workspace' as const },
    ...(input.ownerId ? [{ scope: 'owner' as const, scopeRef: input.ownerId }] : []),
  ];
  const facts = await fold(selectors, { workspaceId: input.workspaceId });
  const keys = facts.map((fact) => fact.key).filter((key): key is string => Boolean(key));
  // Deduped because one key can resolve from both selectors; sorted so the
  // payload is stable across fold order and a diff means a real change.
  const unique = [...new Set(keys)].sort();
  // Successful-empty is ABSENT, not `[]`: an empty array in this payload reads
  // as "measured, none apply", which is indistinguishable from a degraded read.
  return unique.length > 0 ? unique : undefined;
}

export interface LeaderBriefMember {
  agentId: string;
  label: string | null;
  fleetRole: string | null;
  /** Age of this member's current coord:declare-intent text. Null means the
   *  roster could not resolve the declaration writer timestamp. */
  intentAgeSec: number | null;
  /** Canonical roster verdict: the declaration is not being actively progressed. */
  intentStale: boolean | null;
  /** Canonical roster verdict: activity is fresh but the declaration lags it. */
  intentDivergent: boolean | null;
  /** P-012: the resolving action for an intent signal. The raw booleans above
   *  remain inspectable; this block tells a leader what to do with them. */
  intentAttention?: LeaderBriefMemberIntentAttention;
  /** EI-19931924184335892: `'recorded'` is a LIVE verdict (session ended_at IS NULL) —
   *  it means "not coord-wakeable" (no live inbox-wake await registered), NEVER
   *  "not-live"/dead. Do not read it as evidence to reclaim a claim; cross-check
   *  `lastToolCallAgeMs`/`verdict` before treating any non-`'live'`-looking
   *  sessionState as a reason to act — a session can be `recorded` and actively
   *  making tool calls at the same time. Only `'ended'`/`'suspect'`/`'draining'`
   *  are genuine not-live-or-going-away verdicts. */
  sessionState: SessionState | null;
  /** EI-21125380796386851: whether a directed wake can still reach this row.
   *  `suspect` + true is recoverable; null means the oracle did not resolve. */
  wakeable: boolean | null;
  verdict: MemberVerdict | null;
  wakeMode: WakeMode | null;
  /** Healthy engine-loop lifecycle; null when this is ordinary work. */
  monitorState: MonitorState | null;
  /** Scheduled next engine fire for monitoring/waiting owners. */
  nextFireAt: string | null;
  /** WI-5345: the member's engine loop's armed MODE ('work'|'monitor'), surfaced inline so a
   *  leader can tell a genuinely wedged pure-monitor loop from a healthy work loop that is
   *  simply between items (verdict:monitoring + doing:null looks identical for both without
   *  this) — orthogonal to `monitorState`, which is the lifecycle verdict, not the armed mode.
   *  Null when no active loop. */
  loopMode: 'work' | 'monitor' | null;
  /** EI-19381528967421062: present ONLY while this member's loop is backed off from a
   *  provider wall (rate-limit/usage-cap) — `nextFireAt` above reflects that wait, NOT a
   *  normal cadence tick, and `active:true` alone cannot say so. A leader reading this row
   *  can tell "healthy, next tick in 60s" from "silenced until `until`" without a separate
   *  per-owner `loop:status` call. Absent (not null) when the loop is healthy — matches
   *  `unanswered`/`parkedOn`'s "present only when it matters" convention. See
   *  computeLifecycleBackoff (harness/routines/loop.ts). */
  throttled?: LifecycleBackoffInfo;
  /** ms since the member's last recorded tool call; null = never (still booting). */
  lastToolCallAgeMs: number | null;
  doing: unknown;
  /** Every currently-held work-item id (bounded by the member's actual claim list). */
  workItemIds: string[];
  /** Same canonical held-item checkpoint reader as carry, not a copied loop narrative. */
  checkpointProgress?: LeaderCheckpointProgress;
  /** P-006: per-held-work-item claim-progress health. Present only when at least one held work-item has a derived verdict. */
  claimHealth?: Record<string, ClaimHealth>;
  queuedCount: number;
  load: number;
  /** A held claim has no last_progress_at/taken_at progress in >10min (claim-progress
   *  signal, not liveness). EI-19931924184335892: forced to `false` whenever
   *  `lastToolCallAgeMs` proves the member is speaking right now (within
   *  VERDICT_SPEAKING_FRESH_MS) — a fresh real tool call outranks the checkpoint
   *  heuristic, so this can never read `true` beside a lastToolCallAgeMs that itself
   *  disproves it. */
  stalled: boolean;
  contextPressure: ContextPressureBucket | null;
  /** Seconds since the cached estimate behind contextPressure was recorded.
   *  null means the estimate age is unavailable. */
  contextPressureAgeSec: number | null;
  /** coord-delivery-residual-gaps P-001: this LIVE member has not read its
   *  coord mail for a whole budget window despite fresh activity — a
   *  coord:send to it will NOT be seen until it wakes/settles. Absent when
   *  reading normally. ('missing' needs a session start time, which the
   *  assignments path doesn't carry — expect 'stale' here; coord:presence
   *  carries the full classification.) */
  coordHook?: CoordDeafState;
  /** Directed messages to this member with no reply/ack yet — absent when none. */
  unanswered?: UnansweredDirectedSummary;
  /** P-013: of YOUR directives to this member that named a required side effect
   *  (`coord:send { expectEffect }`), how many the LEDGER shows were carried out.
   *  Absent when you sent none — never a zeroed block (see decorateDirectiveActuation).
   *  Distinct from `unanswered`: that is what they SAID, this is what happened.
   *  P-030: named `directiveActuation`, NOT `directives` — the root
   *  `ownerDirectives` projection on this same payload carries the owner's turns,
   *  and one field name spanning both concepts is actively misleading. */
  directiveActuation?: DirectiveActuationSummary;
  /** Active non-inbox-wake events:await keys — a deliberately-benched member.
   *  EI-18732218464905145: a composed (`spec`) registration renders as ONE
   *  `ComposedParkEntry` (its any/all/k-of-n mode + its OWN deadline), never as
   *  flat sibling strings alongside its own leaves — see resolveComposedParkedOn. */
  parkedOn?: Array<string | ComposedParkEntry>;
  /** Authoritative verified-wait failures that require owner wake/takeover. */
  verifiedWaitTakeovers?: VerifiedWaitTakeoverAlert[];
  /** EI-9943: this member is alive/speaking (burning real turns) but its work
   *  is NOT advancing and it is not already benched — the "live-loop-polling
   *  on a peer's critical path" pattern (fleet p2p-ship, 2026-07-11/12: 3 of 5
   *  members ran a live monitor loop for 58/37/19 turns each, structurally
   *  blocked on one member's diagnosis, instead of parking on an event).
   *  A one-glance nudge toward `fleet:bench { member, wakeEvent }` — never
   *  auto-applied, since only the leader knows the right gate to park on. */
  benchSuggestion?: {
    /** EI-18681259560385029: which branch fired. `idle-with-claimable` is the one a
     *  leader must NOT act on by benching — see computeBenchSuggestion. */
    kind: 'stalled-no-mcp' | 'laneless-idle' | 'idle-with-claimable';
    reason: string;
    item: string | null;
    itemTitle: string | null;
  };
  /** EI-18730414627683753: this member has NO self-wake mechanism at all — no active
   *  engine loop, not parked on any event, holding no claim. Nothing will bring it back;
   *  the leader must coord:send { wake: 'required' } it NOW. Independent of
   *  `benchSuggestion` (a laneless-idle member with a healthy armed loop is NOT dormant —
   *  it will re-cycle on its own next tick). See computeDormantAlert. */
  dormant?: true;
  /** ms since the member's last PRODUCTIVE (non-housekeeping) tool call; null = no
   *  productive call on record at all (still booting, or genuinely never done any work).
   *  See HOUSEKEEPING_TOOL_NAMES + computeSpinningAlert. */
  productiveToolCallAgeMs: number | null;
  /** EI-19307414464301772: this member is alive and visibly taking turns
   *  (`lastToolCallAgeMs` fresh — every OTHER liveness surface reads this as healthy)
   *  but its last PRODUCTIVE tool call is stale well past budget — it is burning turns
   *  on nothing but the per-turn housekeeping set. Distinct from `stalled` (housekeeping
   *  calls keep that clock reset) and from `benchSuggestion`'s laneless-idle branch (a
   *  healthy drain member cycling scheduler:get_next is laneless-idle but not spinning —
   *  get_next is productive). See computeSpinningAlert. */
  spinning?: true;
  /** P-004/R-4: this member's held item has had no MATERIAL advancement (authored
   *  checkpoint or state transition since the claim) for STALLED_ITEM_ROTATION_THRESHOLD_MS
   *  while ready items wait in the fleet claim set. Measures the ITEM, not the worker, so a
   *  busy member doing status reads is still named. Absent when the fleet is paused, the
   *  member is inside an instrumented long test, or no ready item waits. See
   *  stalled-item-rotation.ts. */
  stalledItem?: StalledItemRotation;
  /** EI-21548894457555139: this member is INSIDE a tool call right now that has been
   *  running longer than LONG_CALL_IN_FLIGHT_MS — it is working, not idle.
   *
   *  Every other field on this row is derived from SETTLED calls
   *  (`lastToolCallAgeMs`, `productiveToolCallAgeMs`) or from a presence snapshot
   *  (`load`, `doing`), and a call that has not returned yet has written none of them.
   *  So a member 20 minutes into one long call and a member doing nothing produce the
   *  SAME observable on every other signal here — which is exactly how this row once
   *  reported `dormant:true` + a `laneless-idle` bench suggestion for a member that was
   *  working hard. Present ⇒ suppresses both of those verdicts (see computeDormantAlert
   *  and computeBenchSuggestion).
   *
   *  Exception-only: absent for the overwhelming majority of calls, which settle in
   *  milliseconds. ABSENCE IS NOT PROOF OF IDLENESS — the registry behind it is
   *  process-local (see in-flight-calls.ts), so read absent as "nothing observed",
   *  never as "this member is idle". */
  longCallInFlight?: { tool: string; ageSec: number };
  /** P-009: this member's most recent STRANDED close on the task ledger — a task that
   *  stopped in the escape/anomaly class rather than in good order.
   *
   *  READ `reason`, NOT just `disposition`. Two different writers strand a task and this
   *  block surfaces BOTH, because a leader triaging a quiet member wants either:
   *    - `fleet:respawn-member` containment (P-009): a kill or cooperative drain it could
   *      not VERIFY, so it froze the member's tasks and recorded the cause; or
   *    - the task reconciler's reap: a row absent from the process scan (measured on this
   *      box, the majority — reasons of the form `process identity …`).
   *  `disposition:'stranded'` alone therefore does NOT mean a recovery attempt ran. Only
   *  the reason distinguishes them, which is why it gets a longer shaper budget than the
   *  other fields on this row.
   *
   *  Surfaced here because a stranded member is the one case where every other signal on
   *  this row reads as benign: the processes are frozen or gone, so it makes no tool calls
   *  and emits no heartbeat — indistinguishable from a member that finished cleanly and
   *  went quiet. Before this, the reason existed only on the transition edge and the ledger
   *  row, neither of which a leader reads while triaging a roster.
   *
   *  `strandedAt` is load-bearing for the same reason: the ledger keeps closed rows, so a
   *  member stranded days ago still carries a block. Age it before acting on it.
   *
   *  Exception-only: absent for every member with no stranded close. Absence is NOT a
   *  verdict that recovery succeeded — the read is bounded and may simply not have run. */
  recovery?: {
    disposition: 'stranded';
    /** The cause recorded at containment (the same string carried on the transition edge). */
    reason: string | null;
    /** The frozen task, so a leader can go straight to processes:list / logs:read. */
    taskId: string;
    strandedAt: string | null;
  };
  /** D-007: two or more fully observed recovery-only cycles. Diagnostic only;
   * the nested authority bit prevents this signal from being read as permission
   * to kill, reclaim, duplicate, or widen a member's work. */
  repeatedRecovery?: RepeatedRecoveryAlert;
  isSelf?: true;
}

/**
 * P-026 / D-016: the owner's pending/open turns are a leader obligation, not
 * the member-directed actuation ledger below. Keep this root projection
 * deliberately separate from `members[].directiveActuation`, whose meaning is
 * DirectiveActuationSummary (what the leader asked members to do and what was
 * observed). P-030 renamed that member field off `directives` precisely so the
 * two can no longer be confused by name alone. The action surface only carries `recoveryRef`; `targetRef` is
 * diagnostic provenance for provider rows and is not an owner-facing call.
 */
export interface LeaderBriefOwnerDirective {
  id: string;
  status: AgentObligation['status'];
  title: string;
  priority: AgentObligation['priority'];
  applicableDemand: number;
  ageMs?: number;
  action?: Pick<AgentObligationAction, 'kind' | 'summary' | 'tool' | 'args' | 'recoveryRef' | 'continuesCurrentWork'>;
  authority: AgentObligation['authority'];
  evidence: AgentObligation['evidence'];
}

export interface LeaderBriefOwnerDirectives {
  schemaVersion: AgentObligationAgenda['schemaVersion'];
  evaluatedAt: string;
  sourceGeneration: string;
  state: 'known' | 'unknown';
  directives: LeaderBriefOwnerDirective[];
  projection: Pick<AgentObligationProjection, 'text' | 'receipt'>;
  detailRef: string;
  read: { elapsedMs: number; degradedSources: string[] };
}

/** Pure owner-directive projection used by the live brief and its tests. */
export function projectLeaderBriefOwnerDirectives(input: {
  agenda: AgentObligationAgenda;
  projection: AgentObligationProjection;
  read: { elapsedMs: number; degradedSources: string[] };
  detailRef?: string;
}): LeaderBriefOwnerDirectives {
  const evaluations = input.agenda.evaluations.filter((entry) => entry.family === 'owner-directive');
  const directives = evaluations
    .filter((entry) => entry.status !== 'not-applicable')
    .map((entry) => ({
      id: entry.id,
      status: entry.status,
      title: entry.title,
      priority: entry.priority,
      applicableDemand: entry.applicableDemand,
      ...(entry.ageMs == null ? {} : { ageMs: entry.ageMs }),
      ...(entry.action
        ? {
            action: {
              kind: entry.action.kind,
              summary: entry.action.summary,
              ...(entry.action.tool ? { tool: entry.action.tool } : {}),
              ...(entry.action.args ? { args: entry.action.args } : {}),
              ...(entry.action.recoveryRef ? { recoveryRef: entry.action.recoveryRef } : {}),
              ...(entry.action.continuesCurrentWork ? { continuesCurrentWork: true } : {}),
            },
          }
        : {}),
      authority: entry.authority,
      evidence: entry.evidence,
    }));
  return {
    schemaVersion: input.agenda.schemaVersion,
    evaluatedAt: input.agenda.evaluatedAt,
    sourceGeneration: input.agenda.sourceGeneration,
    state: evaluations.some((entry) => entry.status === 'unknown') ? 'unknown' : 'known',
    directives,
    projection: { text: input.projection.text, receipt: input.projection.receipt },
    detailRef: input.detailRef ?? 'fleet:leader-brief { payloadTier:"full" }',
    read: input.read,
  };
}

export interface LeaderBriefObligationProjections<A> {
  agentObligations: A | null;
  ownerDirectives: LeaderBriefOwnerDirectives | null;
}

/**
 * P-026 / D-016: the first of the two hops that put a leader's owner-directive
 * projection ON the brief — reading it off an obligation read that is itself
 * optional and best-effort. Extracted so the WIRING is reachable by a test:
 * `projectLeaderBriefOwnerDirectives` above was already guarded, but nothing
 * drove the assembly, so a mutation that hard-nulled this selection left the
 * suite green (WI-10002415).
 */
export function selectLeaderBriefObligationFields<A>(
  obligationProjections: LeaderBriefObligationProjections<A> | null | undefined,
): LeaderBriefObligationProjections<A> {
  return {
    agentObligations: obligationProjections?.agentObligations ?? null,
    ownerDirectives: obligationProjections?.ownerDirectives ?? null,
  };
}

/**
 * The second hop. The brief carries each field ONLY when it has one, so an
 * absent obligation read stays absent instead of rendering as an explicit
 * null. Field order is load-bearing: agent obligations first, then owner
 * directives — D-016 keeps owner turns a distinct leader obligation, never
 * folded into `members[].directiveActuation` (the leader→member
 * DirectiveActuationSummary, P-030).
 */
export function leaderBriefObligationFields<A>(
  fields: LeaderBriefObligationProjections<A>,
): { agentObligations?: A; ownerDirectives?: LeaderBriefOwnerDirectives } {
  return {
    ...(fields.agentObligations ? { agentObligations: fields.agentObligations } : {}),
    ...(fields.ownerDirectives ? { ownerDirectives: fields.ownerDirectives } : {}),
  };
}

export interface LeaderBriefMemberVerdict {
  agentId: string;
  verdict: MemberVerdict | null;
  idleCause: MemberIdleCause;
}

export interface LeaderBriefLaunchWorkerAttestation {
  transactionId: string;
  state: FleetLaunchTransaction['state'];
  requested: number;
  observed: number;
  ready: number;
  workerReadyMemberIds: string[];
  governorVerdict?: {
    outcome: FleetLaunchGovernorOutcome;
    action: FleetLaunchGovernorAction;
    decidedAt: number;
    target: number;
    productiveCapacityFloor: number;
    reason: string;
  };
  members: Array<{
    ownerId: string | null;
    ready: boolean;
    stages: {
      agentCall: string;
      durableWake: string;
      schedulerPull: string;
      disposition: string;
    };
    failures: string[];
  }>;
}

/** Compact the durable transaction evidence without re-deriving any stage. */
export function compactLaunchWorkerAttestation(
  transaction: FleetLaunchTransaction | null | undefined,
): LeaderBriefLaunchWorkerAttestation | undefined {
  if (
    !transaction ||
    (transaction.workerAttestations == null &&
      transaction.workerReadyMemberIds == null &&
      transaction.governor?.terminalVerdict == null)
  ) {
    return undefined;
  }
  const workerReadyMemberIds = [...new Set(transaction.workerReadyMemberIds ?? [])];
  const members = (transaction.workerAttestations ?? []).map((attestation) => ({
    ownerId: attestation.ownerId,
    ready: attestation.ready,
    stages: {
      agentCall: attestation.stages.agentCall.status,
      durableWake: attestation.stages.durableWake.status,
      schedulerPull: attestation.stages.schedulerPull.status,
      disposition: attestation.stages.disposition.status,
    },
    failures: attestation.failures.map((failure) => failure.code),
  }));
  return {
    transactionId: transaction.transactionId,
    state: transaction.state,
    requested: transaction.requestedMemberIds.length,
    observed: members.length,
    ready: workerReadyMemberIds.length,
    workerReadyMemberIds,
    ...(transaction.governor?.terminalVerdict
      ? {
          governorVerdict: {
            outcome: transaction.governor.terminalVerdict.outcome,
            action: transaction.governor.terminalVerdict.action,
            decidedAt: transaction.governor.terminalVerdict.decidedAt,
            target: transaction.governor.terminalVerdict.target,
            productiveCapacityFloor: transaction.governor.terminalVerdict.productiveCapacityFloor,
            reason: transaction.governor.terminalVerdict.reason,
          },
        }
      : {}),
    members,
  };
}

export type LeaderBriefBenchSuggestionKind = NonNullable<LeaderBriefMember['benchSuggestion']>['kind'];

export interface LeaderBriefBenchSuggestion {
  /** The member identity required by fleet:bench. */
  agentId: string;
  /** Keep the branch visible so idle-with-claimable is not mistaken for a bench remedy. */
  kind: LeaderBriefBenchSuggestionKind;
}

export interface LeaderBriefRepeatedRecovery {
  agentId: string;
  consecutiveRecoveryOnlyCycles: number;
  action: 'diagnose';
  takeoverAuthorized: false;
}

export type LeaderBriefIntentAttentionKind = 'intent-stale' | 'intent-divergent';
export type LeaderBriefIntentAttentionAction = 'verify-ownership-before-reclaim' | 'request-intent-refresh';

export interface LeaderBriefMemberIntentAttention {
  kind: LeaderBriefIntentAttentionKind;
  action: LeaderBriefIntentAttentionAction;
  reason: string;
}

/** Complete identity/action index for intent attention. The verbose member
 * sample is byte-bounded, so a summary count without this index would tell a
 * leader that intervention is needed while hiding the target. */
export interface LeaderBriefIntentAttention {
  agentId: string;
  kind: LeaderBriefIntentAttentionKind;
  action: LeaderBriefIntentAttentionAction;
}

/** P-012: turn the canonical roster's intent signals into one resolving action.
 * Staleness dominates divergence because a non-progressing declaration must be
 * verified before asking its owner to rewrite text. Unknown/false stays absent. */
export function computeIntentAttention(input: {
  agentId: string;
  sessionState?: SessionState | null;
  intentAgeSec?: number | null;
  intentStale?: boolean | null;
  intentDivergent?: boolean | null;
}): LeaderBriefMemberIntentAttention | undefined {
  if (input.intentStale === true) {
    const age = input.intentAgeSec == null ? 'unknown age' : `${input.intentAgeSec}s old`;
    const state = input.sessionState == null ? 'unknown session state' : `sessionState:${input.sessionState}`;
    return {
      kind: 'intent-stale',
      action: 'verify-ownership-before-reclaim',
      reason:
        `Declared intent is unreliable (${age}; ${state}). Verify ${input.agentId}'s live assignments ` +
        'and work-item checkpoint before reclaiming or treating the declaration as active ownership.',
    };
  }
  if (input.intentDivergent === true) {
    const age = input.intentAgeSec == null ? 'unknown age' : `${input.intentAgeSec}s old`;
    return {
      kind: 'intent-divergent',
      action: 'request-intent-refresh',
      reason:
        `Member activity is fresh but its declared intent is ${age}. Ask ${input.agentId} to refresh ` +
        'coord:declare-intent before using the declaration as evidence of its current lane.',
    };
  }
  return undefined;
}

export function compactLeaderBriefIntentAttention(
  members: ReadonlyArray<Pick<LeaderBriefMember, 'agentId' | 'intentAttention'>>,
): LeaderBriefIntentAttention[] {
  return members.flatMap(({ agentId, intentAttention }) =>
    intentAttention == null ? [] : [{ agentId, kind: intentAttention.kind, action: intentAttention.action }],
  );
}

/**
 * EI-20226510994156306: retain the complete member identity/verdict index even
 * when the verbose `members` rows must be bounded for the MCP/ptool transport.
 * This is deliberately pure and compact: the leader can use the ids to issue a
 * narrow follow-up instead of treating a truncated full-tier fetch as a failure.
 */
export function compactLeaderBriefMemberVerdicts(
  members: ReadonlyArray<{
    agentId: string;
    verdict: MemberVerdict | null;
    idleVerdict: { cause: MemberIdleCause };
  }>,
): LeaderBriefMemberVerdict[] {
  return members.map(({ agentId, verdict, idleVerdict }) => ({
    agentId,
    verdict,
    idleCause: idleVerdict.cause,
  }));
}

/**
 * EI-21242929839064139: preserve every actionable bench target independently of
 * the bounded verbose `members` sample. The member rows are ordered for detail
 * density, while this compact index is the stable identity surface a leader uses
 * to decide which member can be passed to fleet:bench.
 */
export function compactLeaderBriefBenchSuggestions(
  members: ReadonlyArray<Pick<LeaderBriefMember, 'agentId' | 'benchSuggestion'>>,
): LeaderBriefBenchSuggestion[] {
  return members.flatMap(({ agentId, benchSuggestion }) =>
    benchSuggestion == null ? [] : [{ agentId, kind: benchSuggestion.kind }],
  );
}

/** Complete exceptional identity index for the repeated-recovery diagnostic. */
export function compactLeaderBriefRepeatedRecovery(
  members: ReadonlyArray<Pick<LeaderBriefMember, 'agentId' | 'repeatedRecovery'>>,
): LeaderBriefRepeatedRecovery[] {
  return members.flatMap(({ agentId, repeatedRecovery }) =>
    repeatedRecovery == null
      ? []
      : [
          {
            agentId,
            consecutiveRecoveryOnlyCycles: repeatedRecovery.consecutiveRecoveryOnlyCycles,
            action: repeatedRecovery.action,
            takeoverAuthorized: repeatedRecovery.takeoverAuthorized,
          },
        ],
  );
}

/** Keep flagged rows at the head of the bounded detail sample without changing
 * the relative order within the flagged and unflagged groups. */
export function prioritizeBenchSuggestedMembers<T extends { benchSuggestion?: unknown }>(members: readonly T[]): T[] {
  return [
    ...members.filter((member) => member.benchSuggestion != null),
    ...members.filter((member) => member.benchSuggestion == null),
  ];
}

/** Put every actionable member first in the bounded detail sample. The compact
 * identity indexes remain complete; this only makes their richer reasons likely
 * to survive the common payload tier. */
export function prioritizeActionableMembers<
  T extends { benchSuggestion?: unknown; intentAttention?: unknown; repeatedRecovery?: unknown },
>(members: readonly T[]): T[] {
  return [
    ...members.filter(
      (member) => member.benchSuggestion != null || member.intentAttention != null || member.repeatedRecovery != null,
    ),
    ...members.filter(
      (member) => member.benchSuggestion == null && member.intentAttention == null && member.repeatedRecovery == null,
    ),
  ];
}

/**
 * WI-37161: the SAME shared-inference-pool verdict `fleet:capacity` reports, trimmed to the
 * fields the idle-member alerts below need to tell "queued for inference" apart from "declining
 * work" / "floor-gated". Deliberately a DIFFERENT signal from a member's own `throttled`
 * (LifecycleBackoffInfo) — that fires only once THIS member has personally hit a provider wall
 * and its engine loop backed off; the account POOL can be degraded/exhausted for every member at
 * once while none of them has individually backed off yet (the observed incident: `throttled: 0`
 * fleet-wide while `fleet:capacity` reported `degraded:true, factor:0`).
 */
export interface PoolDegradedState {
  poolExhausted: boolean;
  degraded: boolean;
  /** Pool spare-capacity factor in [0,1] — 0 means no fresh capacity at all. */
  factor: number;
  queueDepth: number | null;
  usableAccounts: number | null;
  availableAccounts: number | null;
}

/**
 * WI-37161: best-effort, fail-soft read of the live inference-pool capacity oracle — reuses
 * `buildCapacityReport` + `readBeeProviderAvailability` VERBATIM (the exact read `fleet:capacity`
 * performs; not forked) so this can never disagree with what a leader sees calling that tool by
 * hand. Fails soft to `null` (UNKNOWN), never to "healthy" — an unread pool state must not
 * silence a real starvation signal, matching this file's `laneGating`/`fleetPaused` convention.
 */
export function fleetCapacityProviderForMembers(
  members: ReadonlyArray<{
    agentId?: string;
    model?: string | null;
    alive?: boolean;
    verdict?: MemberVerdict | null;
    fleetRole?: string | null;
  }>,
  agentByOwner: ReadonlyMap<string, 'claude' | 'omp' | 'codex' | null | undefined> = new Map(),
): AccountProvider | null {
  const providers = new Set(
    members
      // Historical identities can remain on the roster after a fleet is respawned onto a
      // different backend. They are not consuming inference now and must not turn a uniform
      // live fleet into an apparent mixed-provider fleet.
      .filter((member) => member.alive !== false && member.verdict !== 'dead')
      // WI-41005: the LEADER is an observer of this pool, not a puller from it. A psu leader
      // routinely runs a different backend from the fleet it supervises (a Claude-Code leader
      // over Codex workers is the common shape), and counting its row made every such fleet
      // read as mixed-provider — so `poolCapacity` was null forever and `blockedAt` told the
      // leader the pool "could NOT be read" no matter how many times it probed. Measured on
      // nonp2p-bug-drain-luna-max-20260820: 33 codex workers + 1 claude leader = suppressed,
      // while its uniformly-codex sibling read healthy in the same instant. The question this
      // resolves is "which pool do my MEMBERS pull from", so the observer is not part of it.
      .filter((member) => member.fleetRole !== 'leader')
      .map((member) => {
        const modelProvider = providerForModel(member.model ?? undefined);
        if (modelProvider) return modelProvider;

        // Visible PSU sessions do not have a spawned_agents row, so their roster model_tier
        // is legitimately null. adv_sessions.agent is the authoritative backend for those
        // members. OMP remains unknown here because its provider comes from its model, not
        // from the OMP client itself.
        const agent = member.agentId ? agentByOwner.get(member.agentId) : null;
        if (agent === 'codex') return 'codex';
        if (agent === 'claude') return 'claude';
        return null;
      })
      .filter((provider): provider is AccountProvider => provider != null),
  );
  return providers.size === 1 ? [...providers][0] : null;
}

export async function readPoolDegradedState(provider: AccountProvider): Promise<PoolDegradedState | null> {
  try {
    const hr = await fetchGatewayHeadroom({ timeoutMs: 1500, provider });
    const accountAvailability = await readProviderAvailability(provider);
    const report = buildCapacityReport(hr, { clampArmed: false, accountAvailability });
    return {
      poolExhausted: report.poolExhausted,
      degraded: report.degraded,
      factor: report.factor,
      queueDepth: report.queueDepth,
      usableAccounts: report.usableAccounts,
      availableAccounts: report.availableAccounts,
    };
  } catch {
    return null;
  }
}

/**
 * WI-37161: true exactly when the shared inference pool is congested ENOUGH that an idle member
 * is more likely queued-for-inference than declining/floor-blocked work. A `poolExhausted` read
 * is sufficient on its own: the capacity writer sets it when the cross-checked provider has no
 * usable accounts, even when the gateway queue is empty because requests cannot be admitted to a
 * real account. A merely `degraded` pool still needs a nonzero gateway queue — an imperfect pool
 * with no queued requests is not currently starving anyone.
 */
function isPoolCongested(p: PoolDegradedState | null | undefined): p is PoolDegradedState {
  return p != null && (p.poolExhausted || (p.degraded && (p.queueDepth ?? 0) > 0));
}

/** PURE: exported for direct unit-testing (no PG/DI ceremony needed).
 *  Two independent branches, both gated on NOT already benched (`parkedOn` empty —
 *  benching an already-benched member is a no-op the leader doesn't need surfaced again):
 *
 *  EI-9943 — a member `speaking`/`first-turn-done` (burning real turns) holding a claim
 *  `stalled` already marks as not-advancing. Reuses `stalled`/`verdict`/`parkedOn` verbatim
 *  (the SAME signals fleet:assignments' stalled_claims / fleet:bench's parkedOn already
 *  compute) — no new tracking, no wake-count state.
 *
 *  EI-13846 — LANELESS-IDLE: a member alive and cycling (any verdict but dead/booted/joined —
 *  NOT restricted to speaking/first-turn-done, since `deriveMemberVerdict` returns a healthy
 *  loop's `monitorState` in preference to those, so a loop-armed member essentially never
 *  reports them) holding ZERO claims and nothing queued. `stalled` can't see this case at all
 *  (it requires load>0). This is the branch closing the incident that motivated EI-9943 in the
 *  first place but that the original, narrower check could never catch: a drained-lane member
 *  cycling get_next-miss -> re-park -> wake with no claim, benchSuggestion staying 0 all
 *  night. A member with no loop is handled by the separate `dormant` alert: it is already
 *  quiet and must be woken, not benched onto another wake source. */
export function computeBenchSuggestion(
  a: Pick<DecoratedAgent, 'stalled' | 'parkedOn' | 'doing'> & {
    verdict?: MemberVerdict | null;
    // EI-13846: optional (not Pick'd from DecoratedAgent, whose `load`/`queued` are
    // required) so existing call sites that predate the laneless-idle branch keep
    // compiling unchanged — `undefined` reads as "not laneless" (see below), never
    // a false trigger.
    load?: number;
    queued?: readonly unknown[];
    // WI-5973: the fleet LEADER running its monitor loop, correctly (per the
    // documented leader contract) held NO work-item claim — optional so
    // pre-existing call sites keep compiling unchanged; absent reads as "not
    // the leader's own monitor row", never a false suppression.
    fleetRole?: string | null;
    loopMode?: 'work' | 'monitor' | null;
    // EI-19412077774087262: a member at CRITICAL context that claims work ORPHANS the
    // claim — it runs out of context mid-item and dies holding it. So "wake it to claim"
    // is the wrong remedy for exactly that member, and the idle-with-claimable branch
    // below used to prescribe it unconditionally. Optional (same convention as the fields
    // above) so pre-existing call sites keep compiling; absent reads as "no pressure
    // signal", never a false suppression.
    contextPressure?: ContextPressureBucket | null;
    // EI-21578801728078768: session-log-only rows are authoritatively recorded as live but
    // have no coord wake await, so they are not runnable by a leader-directed wake. Keep
    // this optional for pre-existing pure callers that do not read the liveness oracle.
    sessionState?: SessionState | null;
    // EI-18833129079136289: a recent real tool call proves the member is actively
    // working between claims, so do not wake it just because the presence snapshot
    // has not reflected its next claim yet. Absent/null remains unknown and keeps the
    // existing fail-open idle diagnosis for callers that have not read liveness.
    lastToolCallAgeMs?: number | null;
    // EI-21548894457555139: the complement of lastToolCallAgeMs above. That field is
    // derived from SETTLED calls, so it goes stale precisely while a member sits inside
    // one long call — the case where it most needs to prove liveness. This field covers
    // exactly that window. Optional (same convention); absent reads as "not observed",
    // never as a false suppression.
    longCallInFlight?: { tool: string; ageSec: number } | null;
    /** P-006: progress-derived claim health for held work-items, separate from liveness/activity. */
    claimHealth?: readonly ClaimHealth[];
  },
  /**
   * EI-18681259560385029: the fleet's LIVE authoritative claimable count (the same
   * `claimableCount` work_items:claimable reports — spec_match AND all ~12 floors),
   * or `null` when it could not be read.
   *
   * THE THREE VALUES ARE THREE DIFFERENT FACTS AND MUST NOT COLLAPSE:
   *   > 0   → the queue is NOT empty; an idle member is a starvation symptom, and
   *           benching it is the WRONG remedy.
   *   === 0 → the queue is empty. EI-18689489507862177: this alone does NOT establish
   *           that the lane is DRAINED — a lane whose every matching row sits behind a
   *           claim floor reads 0 here too, and benching is the wrong remedy for that
   *           one as well. `laneGating` below is what separates the two.
   *   null  → UNKNOWN (read failed / no harness to scope by). Deliberately NOT
   *           folded into 0: doing so would silently restore the exact bug this
   *           parameter fixes — an unchecked "drained or scoped-out" assertion —
   *           and it would do so invisibly, forever. Unknown is surfaced by the
   *           aggregate, but it is not enough evidence for a bench suggestion.
   */
  claimableCount?: number | null,
  /**
   * EI-18689489507862177: the PRE-floor half of the same lane read — `matchedByFilter`
   * plus the per-floor `excluded` buckets that `readFleetLaneHealth` already fetches.
   * Absent = the gating was not read on this call; it is never inferred, because
   * inferring it is precisely the bug (see the `=== 0` note above).
   *
   *   matchedByFilter > 0 with claimableCount === 0 → GATED: the backlog exists and is
   *     being withheld by a floor. Bench is actively harmful — it parks the member on a
   *     completion event nothing can fire.
   *   matchedByFilter === 0 with claimableCount === 0 → genuinely drained.
   */
  laneGating?: { matchedByFilter: number; excluded?: Record<string, number> } | null,
  /**
   * EI-18703234178947959: the fleet's OWN durable control state — true when it is
   * `winding-down` (fleet:pause / fleet:wind-down, mig 575). Every idle-member branch
   * below diagnoses idleness as a FAULT and prescribes a remedy (wake it / bench it /
   * widen the spec), which is exactly backwards for a paused fleet: an idle member IS
   * the compliant response to the stand-down its owner ordered, and the claim path
   * (`fleetControlWindDownRefusal` → get_next's `windDown:true`) will refuse it work no
   * matter how many times it is woken.
   *
   * Live 2026-07-26, fleet bug-drain-200k: this brief reported `claimable_now: 2` +
   * `idleWithClaimableAlert` and told the leader to wake all 19 members to "re-run
   * scheduler:get_next", while that very oracle returned `windDown:true` (owner pause
   * standing since 2026-07-21). The 2 rows were real backlog — just real backlog
   * OUTSIDE this fleet's paused scope. Following the advice burns 19 wake-cycles
   * re-discovering the pause, once per polling tick, indefinitely.
   *
   * Deliberately does NOT suppress the `stalled-no-mcp` branch above: a member that
   * still HOLDS a claim and looks wedged during a pause is a genuine fault — indeed it
   * is precisely what blocks the stand-down from completing.
   *
   * `undefined`/absent reads as "not paused" (today's behavior), never a false
   * suppression — an unread control state must not silence a real starvation signal.
   */
  fleetPaused?: boolean | null,
  /**
   * EI-19313376980892266: this member's AUTHORITATIVE concurrency verdict — the same
   * `evaluateClaimConcurrency` result `scheduler:get_next` refuses on, read from
   * `work_items.taken_by` rather than from the presence layer.
   *
   * Why it must be passed in rather than derived from `a.load`: `load`/`workItemIds`
   * come from presence, and a PARKED item retains `taken_by` while dropping out of them.
   * `load === 0 && activeClaims >= 1` is therefore reachable, and in exactly that state
   * this function used to report `idle-with-claimable` for a member the scheduler was
   * structurally refusing. Live 2026-08-02: five members reported idle-with-claimable
   * were all AT CAPACITY; the leader broadcast twice and woke all five (woken:1 verified)
   * demanding work they were forbidden to take.
   *
   * `undefined`/absent reads as "not read on this call" and never suppresses — an
   * unread verdict must not silence a real starvation signal (same fail-open discipline
   * as `fleetPaused` above).
   */
  concurrency?: { blocked: boolean; activeClaims: number; heldIds: string[] } | null,
  /**
   * WI-37161: the live shared-inference-pool verdict (see `isPoolCongested`). Consulted ONLY by
   * the `idle-with-claimable` branch below, and ONLY to change its diagnosis/remedy — a congested
   * pool does NOT suppress the alert (the lane genuinely is not drained), it changes "wake it,
   * check the claim floor" into "it's queued for inference, do not wake, do not bench".
   * `undefined`/`null` reads as "not read on this call" and never suppresses.
   */
  poolCapacity?: PoolDegradedState | null,
): LeaderBriefMember['benchSuggestion'] {
  // EI-21548894457555139: a member INSIDE a long-running call is working, so there is
  // nothing to bench — and every bench branch below would misread it, because they all
  // key off `load`/`queued`/`doing` (a presence snapshot) or settled-call ages, none of
  // which an unreturned call has written. This is the FIRST check for the same reason
  // the dormant guard is: the remedy is what makes the misdiagnosis expensive.
  // `fleet:bench` parks the member on a completion event, so benching a member that is
  // mid-call sleeps it on top of live work.
  if (a.longCallInFlight) return undefined;
  if ((a.parkedOn?.length ?? 0) > 0) return undefined;
  const protectiveClaimHealth = a.claimHealth?.find((h) => !shouldRecoverClaimFromHealth(h));
  if (protectiveClaimHealth) return undefined;
  if (a.verdict === 'speaking' || a.verdict === 'first-turn-done') {
    if (a.stalled) {
      // EI-18679536216711688: `stalled` is derived purely from MCP tool-call
      // recency (tool_invocations), which goes silent by design during a long
      // foreground exec (a test run, a build) — no MCP round-trip happens until
      // the command returns. The prior text ("likely live-loop-polling a peer's
      // critical path") asserted a SPECIFIC, CONFIDENT cause the signal cannot
      // actually distinguish from "mid a long foreground exec" — a live incident
      // saw exactly that: a member mid test-run flagged stalled=true with this
      // fabricated diagnosis, and following the paired remedy (coord:send
      // { endTurn: true }) would have ESC'd a productive turn and destroyed
      // in-flight work. Report the OBSERVATION (no recent MCP call) and the
      // AMBIGUITY honestly instead of naming a wrong cause, and point at the one
      // cheap way to disambiguate before acting.
      return {
        kind: 'stalled-no-mcp',
        reason:
          'no recent MCP tool call while alive and holding a claim — may be genuinely wedged, ' +
          'OR mid a long foreground exec (a test run, a build) that emits no MCP calls until it ' +
          'returns; this signal cannot tell the two apart. Check sessions:timeline for recent ' +
          'local (Edit/Write/Bash) activity BEFORE concluding it is wedged or ending its turn — ' +
          'fleet:bench only once genuinely stuck is confirmed.',
        item: a.doing?.id ?? null,
        itemTitle: a.doing?.title ?? null,
      };
    }
  }
  // EI-21578801728078768: `recorded` is session-log liveness without a live coord
  // wake await. Such a row cannot receive the member-remediation wake/bench flow below;
  // excluding it prevents historical session rows from inflating idle_with_claimable.
  if (a.sessionState === 'recorded') return undefined;
  // WI-5973: a fleet LEADER running its monitor loop (fleetRole:'leader',
  // loopMode:'monitor') is SUPPOSED to hold zero work-item claims — that IS
  // the documented leader contract (monitor each wake: burn-down delta,
  // member liveness, completion-integrity audit, reclaim orphans; the leader
  // itself never pulls from the claim spec). The EI-13846 laneless-idle
  // heuristic below was written for MEMBERS pulling from a claim spec whose
  // lane may have drained — it does not apply to the leader's own row, whose
  // correct steady state IS "no claim, nothing queued". Observed live
  // 2026-07-26: the leader's own row carried this suggestion twice, and
  // FOLLOWING it (benching the leader onto a scoped event) is precisely the
  // failure the leader contract exists to prevent — the one agent responsible
  // for detecting member death would go to sleep. This does NOT suppress the
  // stalled-no-mcp branch above: a leader that DID take on work (load>0) and
  // looks wedged is still a genuine, reportable fault regardless of role.
  if (a.fleetRole === 'leader' && a.loopMode === 'monitor') return undefined;
  // EI-21285199425229320: a loopless member with no claim is already quiet; adding a
  // fleet:bench wake source increases future wake/token cost and does not suppress a live
  // loop. `computeDormantAlert` owns this shape and tells the leader to coord:wake it now.
  // Keep `undefined` distinct from `null`: older pure callers that did not provide loopMode
  // have not read the loop oracle, so they retain the historical fail-open behavior.
  if (a.loopMode === null) return undefined;
  // EI-13846: LANELESS-IDLE. `stalled` requires load>0 (a held claim not advancing), so
  // it is structurally blind to a member holding NO claim at all — and `deriveMemberVerdict`
  // returns the loop's `monitorState` (monitoring|waiting|parked-awaiting-capability) BEFORE
  // it ever considers speaking/first-turn-done/stalled, so any loop-armed member (the norm
  // for a drain fleet — every member here runs `loop:arm`) never reports 'speaking' or
  // 'first-turn-done' while its loop is healthy. Together this made benchSuggestion
  // structurally unable to fire for the exact incident it was built to catch: a member
  // whose lane drained kept cycling get_next-miss -> re-park -> wake with ZERO claims,
  // 'monitoring'/'waiting' verdict throughout (54 wakes / 272 tool calls overnight,
  // benchSuggestion stayed 0 the whole time). This branch is independent of `verdict`
  // beyond excluding the dead/booting states below, and independent of `stalled` (there is
  // no claim to be stalled on) — it fires whenever a member is alive, cycling (not merely
  // freshly booted), holds NO claim, has NOTHING queued, and is not already parked on an
  // event (excluded above).
  if (a.verdict == null) return undefined;
  if (a.verdict === 'dead' || a.verdict === 'booted' || a.verdict === 'joined') return undefined;
  // EI-18703234178947959: a PAUSED fleet's idle member is compliant, not starving —
  // see the `fleetPaused` parameter doc. Every branch below would misdiagnose it and
  // prescribe a remedy the claim path itself refuses to honor.
  if (fleetPaused) return undefined;
  if (a.load === 0 && (a.queued?.length ?? 0) === 0 && !a.doing) {
    // EI-19313376980892266: `a.load === 0` is a PRESENCE-layer reading and does NOT mean
    // the scheduler considers this member free — a parked/held item keeps `taken_by`, so
    // it counts against maxConcurrentClaims while contributing nothing to `load`. Every
    // branch below diagnoses idleness and prescribes waking or benching; for a member at
    // capacity both remedies are wrong, and "wake it" is the expensive one (the member
    // burns a turn re-discovering a refusal it cannot act on). Defer to the one oracle
    // instead of re-deriving capacity from a field that cannot see it.
    if (concurrency?.blocked) return undefined;
    // EI-22063840424661947: a laneless-idle suggestion is actionable as a bench target
    // only when this fleet's lane read positively established an empty post-floor queue.
    // An unread/timeout result is not an empty queue: fleet:bench rechecks the member's
    // exact lane and can correctly refuse with `bench_refused_queue_nonempty` (the live
    // incident found 1,490 claimable rows there). Keep the unknown state visible through
    // `claimable_now`, but never turn it into a bench suggestion that could park capacity
    // beside work.
    // `null` is the explicit live-read failure sentinel. An omitted value remains
    // the legacy pure-caller shape used by older projections, which do not claim to
    // have performed the fleet-lane read.
    if (claimableCount === null) return undefined;
    // EI-18681259560385029: the ORIGINAL text asserted "likely idle-cycling a drained or
    // scoped-out lane" UNCONDITIONALLY — a confident diagnosis of a fact it never checked.
    // When the queue is actually nonempty that sentence points a leader AWAY from the truth
    // ("lane drained, parking is correct") and its paired remedy (fleet:bench onto an event)
    // is precisely backwards: it puts the member to SLEEP next to work it should be taking.
    // Live 2026-07-26T04:32Z: five members carried this line while claimableCount was 2, and
    // the leader read it and stood the fleet down. Branch on the real number instead.
    if (claimableCount != null && claimableCount > 0) {
      // EI-18833129079136289: `load === 0`/`doing === null` is a presence snapshot,
      // not proof that this member is idle. A fresh tool call is the direct liveness
      // signal for the between-claims window; waking it would interrupt active work
      // and add another request before the member's current claim is visible here.
      if (a.lastToolCallAgeMs != null && a.lastToolCallAgeMs <= VERDICT_SPEAKING_FRESH_MS) {
        return undefined;
      }
      // WI-37161: the shared inference ACCOUNT POOL can be degraded/exhausted while claim
      // floors and the claim spec are perfectly healthy — an idle member here is most likely
      // QUEUED FOR INFERENCE (an in-flight scheduler:get_next or claim call sitting behind a
      // congested gateway), not declining work. `throttled` (LifecycleBackoffInfo, this file's
      // OTHER pool-shaped field) cannot see this: it only lights up once THIS member has
      // personally hit a provider wall and its OWN engine loop backed off, and a member merely
      // queued for inference has done neither. Checked BEFORE contextPressure below because it
      // is the more likely explanation fleet-wide (one congested pool vs. one member's context),
      // though the two are not mutually exclusive.
      //
      // Observed live 2026-08-09, fleet nonp2p-bug-drain: `throttled: 0` fleet-wide while
      // fleet:capacity reported `degraded:true, factor:0, sustainedlyLimitedAccounts:2/2 usable,
      // tier2 queueDepth 28` — the idle members' lastToolCallAgeMs (84s/207s/297s) were
      // consistent with an inference-queue wait, not with declining work. The OLD reason text
      // below ("wake it… if it still takes nothing, that is a claim-floor problem") sent the
      // leader toward work_items:claimable's excludedBreakdown, which in that incident was
      // healthy (claimableCount 293) — every diagnostic road it offered led away from the real
      // cause, and its own prescribed remedy (wake 6 more members) would have pushed 6 more
      // requests into the exact queue that was already starving the fleet.
      if (isPoolCongested(poolCapacity)) {
        return {
          kind: 'idle-with-claimable',
          reason:
            `alive with NO claim and nothing queued while ${claimableCount} item(s) ARE claimable, ` +
            `BUT the shared inference ACCOUNT POOL is ${poolCapacity.poolExhausted ? 'EXHAUSTED' : 'DEGRADED'} ` +
            `right now (factor ${poolCapacity.factor.toFixed(2)}` +
            (poolCapacity.usableAccounts != null ? `, ${poolCapacity.usableAccounts} usable account(s)` : '') +
            (poolCapacity.queueDepth != null
              ? `, ~${poolCapacity.queueDepth} request(s) already queued at the gateway`
              : '') +
            ') — this member is most likely QUEUED FOR INFERENCE, not declining work. DO NOT wake it: ' +
            'coord:send wake:required just adds another request behind the same congestion, worsening it. ' +
            'DO NOT fleet:bench it either — the lane is not drained. Re-check fleet:capacity before acting ' +
            'on this member; once it reports degraded:false/poolExhausted:false, THEN wake it if it is still ' +
            'idle a few wakes later.',
          item: null,
          itemTitle: null,
        };
      }
      // EI-19412077774087262: CRITICAL context inverts the remedy. The reason text below
      // prescribes "wake it to claim", which for a member at critical context is precisely
      // the wrong move — it claims, runs out of context mid-item, and dies HOLDING the
      // claim, converting an idle member into an orphaned work-item the leader then has to
      // reclaim. Observed live 2026-08-03T06:2xZ on nonp2p-bug-drain-0801: su-70390c8c sat
      // at contextPressure 'critical' with NO claim while this line told the leader it
      // "should be taking work". The member was in fact correct to hold off. Report the
      // SAME idle-with-claimable fact (the lane genuinely is not drained) but prescribe the
      // ordering that makes claiming safe, rather than a remedy the member must ignore.
      if (a.contextPressure === 'critical') {
        return {
          kind: 'idle-with-claimable',
          reason:
            `alive with NO claim and nothing queued while ${claimableCount} item(s) ARE claimable, ` +
            'BUT this member is at CRITICAL context pressure — it is idle CORRECTLY, not starving. ' +
            'DO NOT wake it to claim: claiming at critical context orphans the claim (it dies mid-item ' +
            'still holding it, which costs you a reclaim on top of the lost turn). DO NOT fleet:bench ' +
            'it either — the lane is not drained. The remedy is ORDERING, not dispatch: it must flush ' +
            '(work_items:checkpoint / loop:checkpoint) then self-compact (session:request-compaction ' +
            '{ autoContinue: true }), and it will pull on the next wake with a clean context. If it is ' +
            'still critical and unclaimed several wakes from now, THAT is the fault worth chasing.',
          item: null,
          itemTitle: null,
        };
      }
      return {
        kind: 'idle-with-claimable',
        reason:
          `alive with NO claim and nothing queued while ${claimableCount} item(s) ARE claimable ` +
          "right now under this fleet's own spec (EI-18681259560385029) — the lane is NOT drained. " +
          'DO NOT fleet:bench this member: benching sleeps it next to work it should be taking. ' +
          'Wake it to re-run scheduler:get_next (coord:send wake:required), and if it wakes and ' +
          "still takes nothing, that is a claim-floor problem — read work_items:claimable's " +
          'excludedBreakdown rather than assuming the member is at fault.',
        item: null,
        itemTitle: null,
      };
    }
    // EI-18689489507862177: `claimableCount === 0` is NOT proof the lane is drained — it is
    // equally the signature of a lane whose rows ALL sit behind claim floors. Live on
    // nonp2p-bug-drain-0725 2026-07-26T07:00Z: 108 rows matched the fleet's own filter while
    // claimable was 0 (federationDetector=50, claimHold=38, needsHuman=11, taken=8) and 5 of
    // 10 members idled. Asserting "VERIFIED drained" there is false, and its paired remedy is
    // actively harmful: fleet:bench sleeps those members on a completion event that cannot
    // fire, because nothing is in flight to complete. Same defect class as the branch above —
    // a confident diagnosis of a fact never checked — so it gets the same treatment: branch on
    // the pre-floor match count, which readFleetLaneHealth already has in hand.
    const gatedFloors = topExcludedFloors(laneGating?.excluded);
    const gated = claimableCount === 0 && (laneGating?.matchedByFilter ?? 0) > 0;
    if (gated) {
      return {
        kind: 'laneless-idle',
        reason:
          `alive with NO claim and nothing queued, but this lane is GATED, not drained: ` +
          `${laneGating?.matchedByFilter} row(s) match this fleet's own filter and 0 survive the ` +
          `claim floors` +
          (gatedFloors.length > 0 ? ` (${gatedFloors.map(([k, n]) => `${k}=${n}`).join(', ')}; buckets overlap)` : '') +
          '. DO NOT fleet:bench this member — benching parks it on a completion event that ' +
          'cannot fire, since nothing is in flight to complete. Act on the floor instead: ' +
          "clear/redirect the dominant exclusion above (work_items:claimable's excludedBreakdown " +
          'names it), or widen the spec via scheduler:set_claim_spec. If the gating is correct ' +
          'and permanent, the honest move is fleet:wind-down, not an idle member.',
        item: null,
        itemTitle: null,
      };
    }
    // Three distinct states remain, and they must not collapse into each other:
    //   drained  — claimable 0 AND the gating read confirmed 0 rows even MATCH the spec.
    //              Only here is the historical bench advice correct.
    //   unknown-gating — claimable 0 but no gating read on this call (a direct unit-test
    //              caller, or a partial read). We know the queue is empty; we do NOT know
    //              whether that is drainage or gating, so the reason stays explicit.
    const drainedVerified = claimableCount === 0 && laneGating != null;
    return {
      kind: 'laneless-idle',
      reason:
        'alive with NO claim, nothing queued, and not parked on an event — idle-cycling ' +
        (drainedVerified
          ? "a lane VERIFIED drained right now (0 claimable AND 0 rows even match this fleet's spec) "
          : claimableCount === 0
            ? 'a lane with 0 claimable, though whether that is drainage or claim-floor gating was NOT read on this brief '
            : 'a lane whose claimable queue could NOT be read on this brief (unknown, not verified drained) ') +
        'every wake instead of resting on a scoped completion event (EI-13846). ' +
        (drainedVerified
          ? 'fleet:bench it onto a scoped event, or confirm its claim spec still admits work.'
          : claimableCount === 0
            ? "Read work_items:claimable's excludedBreakdown before benching — a fully-GATED lane looks identical to a drained one from the claimable count alone."
            : 'Check work_items:claimable BEFORE benching — an unread queue is not an empty one.'),
      item: null,
      itemTitle: null,
    };
  }
  return undefined;
}

/**
 * EI-18730414627683753: the DORMANT alert — a member that has gone permanently silent
 * with NO self-wake mechanism whatsoever: no active engine loop (`loopMode` null), not
 * parked on any event (`parkedOn` empty), and holding no claim. Distinct from — and
 * independent of — computeBenchSuggestion's existing `laneless-idle` kind, which fires
 * for the SAME "alive, no claim, nothing queued" shape but does not distinguish a
 * loop-armed member that will re-cycle on its own next tick from one that has genuinely
 * gone silent forever. Both read identically in every existing summary counter
 * (`bench_suggested`/`laneless_idle`), which is exactly how the incident below went
 * undetected: every counter read healthy.
 *
 * Live 2026-07-26 (fleet push-not-poll, plan stop-discarded-dedup-and-audit-server-polling
 * -2026-07-26): 2 of 6 members completed their lane, reported completion correctly with
 * evidence, then went permanently dormant — verdict `first-turn-done`, `loopMode: null`,
 * `nextFireAt: null` — while `members/dead/stalled/orphaned` all read 0 problems. The
 * leader only caught it by manually reading `loopMode`+`nextFireAt` per member row.
 * (The always-armed coord:inbox-wake keepalive is NOT a counterexample: it only fires on
 * a peer/human message, never on a schedule, so it does not put a dormant member back to
 * work on its own.)
 *
 * Deliberately does NOT require the queue to be nonempty (unlike idle-with-claimable) or
 * empty (unlike laneless-idle/floor-starved) — a member with zero self-wake mechanism is
 * equally a problem regardless of what work exists, because NOTHING will bring it back to
 * check. Suppressed for a paused (winding-down) fleet, matching every sibling alert in
 * this file: an idle, loopless member IS the compliant response to an owner-ordered
 * stand-down, not a fault to surface.
 *
 * PURE: exported for direct unit-testing.
 */
export function computeDormantAlert(
  a: Pick<DecoratedAgent, 'load' | 'doing' | 'parkedOn'> & {
    verdict?: MemberVerdict | null;
    loopMode?: 'work' | 'monitor' | null;
    queued?: readonly unknown[];
    /** EI-21548894457555139: a tool call this member is INSIDE right now. Optional
     *  (same convention as the fields above) so pre-existing call sites keep compiling;
     *  absent reads as "not observed", never as a false suppression. */
    longCallInFlight?: { tool: string; ageSec: number } | null;
    /** P-006: progress-derived claim health for held work-items, separate from liveness/activity. */
    claimHealth?: readonly ClaimHealth[];
  },
  fleetPaused?: boolean | null,
): boolean {
  if (fleetPaused) return false;
  // EI-21548894457555139: a member INSIDE a long-running call is executing, and
  // `dormant` means the opposite — "no self-wake mechanism at all; nothing will bring
  // it back". Checked FIRST because every condition below is derived from settled
  // calls or a presence snapshot, and an unreturned call has written none of them: a
  // member 20 minutes into one call reads load 0 / no doing / no queue, which is
  // byte-identical to genuine dormancy. The prescribed remedy makes the error costly
  // rather than cosmetic — `dormant:true` tells the leader to WAKE it, interrupting
  // the very work the member is in the middle of.
  if (a.longCallInFlight) return false;
  if ((a.parkedOn?.length ?? 0) > 0) return false;
  if (a.loopMode != null) return false;
  if (a.load !== 0 || (a.queued?.length ?? 0) !== 0 || a.doing) return false;
  return a.verdict === 'speaking' || a.verdict === 'first-turn-done';
}

/**
 * How long a member's last PRODUCTIVE (non-housekeeping) tool call may lag behind its
 * last call OF ANY KIND before it counts as SPINNING. Generous by design — a healthy
 * loop's cadence is ~60s and legitimate thinking gaps between edits are common; 30 min
 * catches the failure mode this targets (the reported incident ran unnoticed for ~8h)
 * without tripping on normal pacing.
 */
export const SPINNING_BUDGET_MS = PRODUCTIVE_STALL_BUDGET_MS;

/**
 * EI-19307414464301772: the SPINNING alert. Observed live 2026-08-02 on fleet
 * nonp2p-bug-drain-0801: a member read `sessionState=live, verdict=monitoring,
 * lastToolCallAgeMs≈20s, stalled=false` — HEALTHY on every existing surface — while
 * its last 14 tool calls were entirely `coord:glance`/`activity:report`/
 * `journal:record-turn`/`flags:get`/`sessions:ingest-gate-event`, holding zero claims,
 * for ~8h, with 3 directed messages unanswered that whole time.
 *
 * `lastToolCallAtByOwner` (any tool call) is guaranteed fresh for an agent whose turns
 * are firing at all, so it structurally cannot see this. This alert instead compares it
 * against `lastProductiveToolCallAtByOwner` (see HOUSEKEEPING_TOOL_NAMES): a member alive
 * and visibly ticking (`lastToolCallAgeMs` within budget) whose last PRODUCTIVE call is
 * stale well past the same budget is spinning.
 *
 * Distinct from `stalled` — that requires NO tool call at all for 15 min
 * (VERDICT_STALL_MS), and housekeeping calls keep that clock reset even while nothing
 * productive happens, which is exactly why `stalled` missed the incident above. Also
 * distinct from `benchSuggestion`'s laneless-idle branch, which fires on zero claims
 * ALONE regardless of whether the member's calls are productive — a healthy drain
 * member cycling `scheduler:get_next` between claims is laneless-idle but NOT spinning
 * (`get_next` is a productive, agent-chosen call). Deliberately independent of
 * `load`/claims in the other direction too: a member holding a claim while spinning on
 * housekeeping is the MORE dangerous case (the claim looks alive to every other
 * surface while nothing advances it), not a lesser one, so this does not gate on
 * `load === 0` the way `computeDormantAlert` does.
 *
 * `productiveToolCallAgeMs: null` (no productive call on record at all) NEVER fires
 * this — a freshly-booted or newly-claiming member legitimately has no productive
 * history yet, and asserting "spinning" from an absence would be exactly the kind of
 * false-positive-from-missing-data this file's other alerts (`claimableCount: null`,
 * `laneGating: null`) are built to avoid. PURE: exported for direct unit-testing.
 */
export function computeSpinningAlert(
  a: Pick<DecoratedAgent, 'parkedOn'> & {
    verdict?: MemberVerdict | null;
    lastToolCallAgeMs?: number | null;
    productiveToolCallAgeMs?: number | null;
  },
  fleetPaused?: boolean | null,
  budgetMs: number = SPINNING_BUDGET_MS,
): boolean {
  if (fleetPaused) return false;
  if ((a.parkedOn?.length ?? 0) > 0) return false;
  if (a.verdict == null) return false;
  if (a.verdict === 'dead' || a.verdict === 'booted' || a.verdict === 'joined') return false;
  const lastAge = a.lastToolCallAgeMs;
  if (lastAge == null || lastAge > budgetMs) return false;
  const prodAge = a.productiveToolCallAgeMs;
  if (prodAge == null) return false;
  return prodAge > budgetMs;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * EI-19313376980892266 item C — EVERY ALERT CARRIES ITS FALSIFIER.
 *
 * THE INCIDENT (2026-08-02, this file's own alerts): `idle_with_claimable` reported
 * 5 members idle beside a nonempty queue. All 5 were AT CAPACITY — the scheduler was
 * refusing them on maxConcurrentClaims. The leader broadcast twice and woke all five,
 * demanding work they were structurally forbidden to take.
 *
 * The alert's prose ALREADY said the right thing ("read work_items:claimable's
 * excludedBreakdown rather than assuming the member is at fault"). It was correct and
 * it was ignored, because prose advice gets BELIEVED while a query gets RUN. The fix
 * is therefore not better wording — it is shipping the alert with the command that
 * would DISPROVE it.
 *
 * TWO CONSTRAINTS, both learned the hard way:
 *
 * 1. INDEPENDENCE. Adopted from the ratified cell-assessment evidence contract
 *    (`cell-registry.ts`, D-004/D-006), whose evidence paths carry the same
 *    load: "a derived verdict over a raw leg adds interpretation but NO NEW
 *    INFORMATION — it is recomputable from the leg." A falsifier recomputed from the
 *    alert's own inputs can never contradict it, so it launders the alert's confidence
 *    instead of testing it. Each `measurement` below therefore names a reading the
 *    alert did NOT consult.
 *
 * 2. READ-ONLY. A check that mutates is not a check. This is not hypothetical: the
 *    obvious way to ask "would the scheduler admit this member" is
 *    `scheduler:get_next` — which has NO dry-run and ATOMICALLY CLAIMS. A leader
 *    "verifying" an idle-member alert that way claims the item themselves, which is
 *    precisely how this item's own author accumulated 5 claims against a cap of 1
 *    while diagnosing the fleet as idle. `work_items:claimable` is the READ-ONLY
 *    wrapper of that same oracle and is what every falsifier below uses instead.
 *    `alert-falsifier-reality.test.ts` fails the build on a mutating tool.
 *
 * Deliberately NOT auto-executed. Folding the falsifier's result back into the brief
 * would make it one more aggregate on the surface whose over-confidence caused the
 * incident — "a surface that is confidently wrong suppresses the check that would
 * catch it". The leader running it and reading raw output is the point.
 * ────────────────────────────────────────────────────────────────────────────── */
export interface AlertFalsifier {
  /** The tool the check calls. MUST be read-only — enforced by the reality test. */
  tool: string;
  /** The literal runnable one-liner. Its OUTPUT confirms or kills the alert. */
  check: string;
  /** The INDEPENDENT measurement it reads. Must NOT be an input the alert fired on. */
  measurement: string;
  /** The concrete output that KILLS this alert — and what to do instead. */
  kills: string;
}

type PositivePlanFilterVerdict = true | false | 'unknown';

interface PositivePlanFilterEvaluation {
  verdict: PositivePlanFilterVerdict;
  positivePlanSlugs: string[];
}

function uniquePlanSlugs(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/**
 * Extract only exact positive `plan` predicates from a filter tree. Negative,
 * broad, malformed, and `not`-nested predicates are deliberately ignored: this
 * detector is a fail-soft backstop for a settled positive lane, not a second
 * claim-spec evaluator.
 */
function positivePlanSlugsFromFilter(node: FilterNode | null | undefined): string[] {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  if ('not' in node) return [];
  if ('all' in node || 'any' in node) {
    const children = 'all' in node ? node.all : node.any;
    return uniquePlanSlugs(children.flatMap((child) => positivePlanSlugsFromFilter(child)));
  }
  const leaf = node as { field?: unknown; op?: unknown; value?: unknown };
  if (leaf.field !== 'plan') return [];
  if (leaf.op === '=' && typeof leaf.value === 'string') return uniquePlanSlugs([leaf.value]);
  if (leaf.op === 'in' && Array.isArray(leaf.value)) {
    return uniquePlanSlugs(leaf.value.filter((value): value is string => typeof value === 'string'));
  }
  return [];
}

/**
 * Return the one positive plan slug that EVERY admitting branch requires.
 * `any: [plan=P, kind=bug]` mentions one plan but also admits work outside it,
 * so it cannot define the fleet's whole executable frontier.
 */
export { exactPositiveSinglePlanSlugFromFilter };

export interface FleetHeadcountVsExecutableFrontierEvaluation {
  alert: boolean;
  planSlug: string;
  liveNonLeaderWorkers: number;
  readyWidth: number;
  claimable: number;
  executableWidth: number;
  excessWorkers: number;
  reason?: string;
  falsifier?: AlertFalsifier;
}

/**
 * WI-41173 / P-011: continuously apply fleet:launch-on-plan's executable-seat
 * definition after launch. Detector-only: it never resizes or benches.
 * Undefined means unknown/inapplicable/paused, never a fabricated false clean.
 */
export function computeFleetHeadcountVsExecutableFrontierAlert(input: {
  planSlug: string;
  liveNonLeaderWorkers: number;
  readyWidth: number | null;
  claimable: number | null;
  fleetPaused?: boolean | null;
  harness?: string | null;
  fleet?: string | null;
}): FleetHeadcountVsExecutableFrontierEvaluation | undefined {
  if (input.fleetPaused || !input.planSlug) return undefined;
  if (!Number.isSafeInteger(input.liveNonLeaderWorkers) || input.liveNonLeaderWorkers < 0) return undefined;

  const executableWidth = canonicalExecutableWidth(input);
  if (executableWidth == null) return undefined;
  const readyWidth = input.readyWidth as number;
  const claimable = input.claimable as number;
  const excessWorkers = Math.max(0, input.liveNonLeaderWorkers - executableWidth);
  const base = {
    planSlug: input.planSlug,
    liveNonLeaderWorkers: input.liveNonLeaderWorkers,
    readyWidth,
    claimable,
    executableWidth,
    excessWorkers,
  };
  if (excessWorkers === 0) return { alert: false, ...base };
  return {
    alert: true,
    ...base,
    falsifier: {
      tool: 'fleet:leader-brief',
      check: renderFalsifierCall('fleet:leader-brief', {
        fleet: input.fleet,
        harness: input.harness,
      }),
      measurement:
        'a FRESH point-in-time rebuild of the canonical live roster, exact-plan DAG, and ' +
        'fleet claim lane — independent of the prior response snapshot that fired this alert',
      kills:
        '`summary.fleetHeadcountVsExecutableFrontierAlert` is false/absent, or the fresh ' +
        'reason shows liveNonLeaderWorkers <= executableWidth → do not bench or relaunch ' +
        'anyone from the stale alert.',
    },
    reason:
      `${input.liveNonLeaderWorkers} live non-leader worker(s) exceed exact plan ` +
      `'${input.planSlug}' executableWidth=${executableWidth} ` +
      `(readyWidth=${readyWidth}, fleetClaimable=${claimable}) by ${excessWorkers}. ` +
      'The fleet was sized for an earlier frontier but now has workers that cannot all ' +
      'receive plan work. Re-run the read-only fresh-brief falsifier before choosing which ' +
      'excess lanes to bench; this detector never resizes the fleet itself (WI-41173).',
  };
}

/**
 * Evaluate only what positive plan predicates can prove about one declared
 * plan. Non-plan leaves are unknown, so a branch that could still admit the
 * member never produces a false divergence. `not` is unknown by design: a
 * negative scope is outside this detector's evidence contract.
 */
function evaluatePositivePlanFilter(
  node: FilterNode | null | undefined,
  declaredPlanSlug: string,
): PositivePlanFilterEvaluation {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return { verdict: 'unknown', positivePlanSlugs: [] };
  }
  if ('not' in node) return { verdict: 'unknown', positivePlanSlugs: [] };
  if ('all' in node || 'any' in node) {
    const children = 'all' in node ? node.all : node.any;
    if (!Array.isArray(children) || children.length === 0) {
      return { verdict: 'unknown', positivePlanSlugs: [] };
    }
    const evaluations = children.map((child) => evaluatePositivePlanFilter(child, declaredPlanSlug));
    const positivePlanSlugs = uniquePlanSlugs(evaluations.flatMap((evaluation) => evaluation.positivePlanSlugs));
    if ('all' in node) {
      if (evaluations.some((evaluation) => evaluation.verdict === false)) {
        return { verdict: false, positivePlanSlugs };
      }
      if (evaluations.every((evaluation) => evaluation.verdict === true)) {
        return { verdict: true, positivePlanSlugs };
      }
      return { verdict: 'unknown', positivePlanSlugs };
    }
    if (evaluations.some((evaluation) => evaluation.verdict === true)) {
      return { verdict: true, positivePlanSlugs };
    }
    if (evaluations.every((evaluation) => evaluation.verdict === false)) {
      return { verdict: false, positivePlanSlugs };
    }
    return { verdict: 'unknown', positivePlanSlugs };
  }
  const leaf = node as { field?: unknown; op?: unknown; value?: unknown };
  if (leaf.field !== 'plan') return { verdict: 'unknown', positivePlanSlugs: [] };
  if (leaf.op === '=' && typeof leaf.value === 'string' && leaf.value.length > 0) {
    return {
      verdict: leaf.value === declaredPlanSlug,
      positivePlanSlugs: [leaf.value],
    };
  }
  if (leaf.op === 'in' && Array.isArray(leaf.value)) {
    const positivePlanSlugs = uniquePlanSlugs(leaf.value.filter((value): value is string => typeof value === 'string'));
    if (positivePlanSlugs.length === 0) return { verdict: 'unknown', positivePlanSlugs };
    return {
      verdict: positivePlanSlugs.includes(declaredPlanSlug),
      positivePlanSlugs,
    };
  }
  return { verdict: 'unknown', positivePlanSlugs: [] };
}

export interface DeclaredPlanSpecDivergentMember {
  agentId: string;
  declaredPlanSlug: string;
}

/**
 * EI-21165759529778617: detect the structural starvation shape where a live
 * member has declared a plan that the fleet's effective positive plan scope
 * cannot admit. This compares the live member-plan declaration to the spec;
 * it never infers work-item ownership from presence fields such as
 * `claimedItems: []`, which is also emitted for genuine holders.
 *
 * The AST evaluator is intentionally conservative. It reports only plans that
 * are provably rejected by positive `=`/`in` predicates and stays silent for
 * missing, malformed, negative, or otherwise ambiguous filter evidence.
 * PURE: exported for direct unit-testing.
 */
export function computeDeclaredPlanSpecDivergenceAlert(input: {
  members: ReadonlyArray<{
    agentId: string;
    alive: boolean;
    declaredPlanSlug: string | null;
  }>;
  specFilter?: FilterNode | null;
  harness?: string | null;
  fleet?: string | null;
}):
  | {
      reason: string;
      falsifier: AlertFalsifier;
      positivePlanSlugs: string[];
      divergentMembers: DeclaredPlanSpecDivergentMember[];
    }
  | undefined {
  try {
    const positivePlanSlugs = positivePlanSlugsFromFilter(input.specFilter);
    if (positivePlanSlugs.length === 0) return undefined;
    const divergentMembers = input.members
      .filter(
        (member) =>
          member.alive === true && typeof member.declaredPlanSlug === 'string' && member.declaredPlanSlug.length > 0,
      )
      .filter((member) => evaluatePositivePlanFilter(input.specFilter, member.declaredPlanSlug!).verdict === false)
      .map((member) => ({ agentId: member.agentId, declaredPlanSlug: member.declaredPlanSlug! }));
    if (divergentMembers.length === 0) return undefined;

    const shownMembers = divergentMembers
      .slice(0, 8)
      .map((member) => `${member.agentId}=${member.declaredPlanSlug}`)
      .join(', ');
    const more = divergentMembers.length > 8 ? ` (+${divergentMembers.length - 8} more)` : '';
    return {
      positivePlanSlugs,
      divergentMembers,
      falsifier: {
        tool: 'fleet:assignments',
        check: renderFalsifierCall('fleet:assignments', { fleet: input.fleet }),
        measurement:
          'the FRESH live member declarations (`declaredPlanSlug`) from fleet:assignments — ' +
          "independent of this brief's roster snapshot and effective-spec read",
        kills:
          'no live member still declares a plan outside the positive plan predicates, or the ' +
          'current spec no longer carries those predicates → the divergence was stale; re-run ' +
          'fleet:leader-brief before acting.',
      },
      reason:
        `${divergentMembers.length} live member(s) declare a plan the fleet's effective claim spec ` +
        `cannot admit. Positive plan predicate(s): [${positivePlanSlugs.join(', ')}]. ` +
        `Divergent declarations: ${shownMembers}${more}. Their plan-item ownership can look ` +
        'healthy while work-item claims on the declared plan are refused; inspect the effective ' +
        'spec before nudging or replacing these members (EI-21165759529778617).',
    };
  } catch {
    // A malformed or unexpectedly shaped persisted filter must never take down
    // the health brief or manufacture an alert from incomplete evidence.
    return undefined;
  }
}

/**
 * Tools a falsifier may never call, because reading them CHANGES the thing being
 * measured. `scheduler:get_next` and the claim verbs take the item; `fleet:bench`
 * parks the member; `coord:send` wakes it. Enforced by the reality test rather than
 * left to review — the whole family is one plausible-looking edit away from a check
 * that silently claims work on the leader's behalf.
 */
export const FALSIFIER_FORBIDDEN_TOOLS: readonly string[] = [
  'scheduler:get_next',
  'work_items:claim',
  'work_items:claim_next',
  'fleet:bench',
  'coord:send',
];

/**
 * Render a tool call as the literal one-liner a leader can paste. Values are emitted
 * as they must be typed (strings quoted, scalars bare); null/undefined args are
 * dropped so an unresolved fleet/harness degrades to a still-runnable call rather
 * than one carrying `harness: null`. PURE — exported for direct unit-testing.
 */
export function renderFalsifierCall(tool: string, args: Record<string, unknown>): string {
  const parts = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? `'${v}'` : JSON.stringify(v)}`);
  return parts.length > 0 ? `${tool} { ${parts.join(', ')} }` : `${tool} {}`;
}

/**
 * P-005 / D-030 step 5: the brief's view of the UNDER-staff alert — the pure
 * evaluation plus the falsifier a fired alert must ship. The falsifier reads live
 * members and their claims straight from fleet:assignments, independent of the
 * productive-seat projection that fired the alert. PURE — exported so the wiring
 * is testable without the handler's DI ceremony.
 */
export function buildFleetUnderStaffedBriefAlert(input: {
  fleet: string | null | undefined;
  headcount: Parameters<typeof computeFleetUnderStaffedAlert>[0]['headcount'];
  /** null/undefined when the fleet record could not be read: the alert stays unknown. */
  controlState: string | null | undefined;
  fleetPaused?: boolean | null;
}): (FleetUnderStaffedEvaluation & { falsifier?: AlertFalsifier }) | undefined {
  const evaluation = computeFleetUnderStaffedAlert({
    headcount: input.headcount,
    controlState: input.controlState,
    fleetPaused: input.fleetPaused,
  });
  if (!evaluation?.alert) return evaluation;
  return {
    ...evaluation,
    falsifier: {
      tool: 'fleet:assignments',
      check: renderFalsifierCall('fleet:assignments', { fleet: input.fleet }),
      measurement:
        'each live member and the work-item it holds right now, read from presence and claims — ' +
        'not from the productive-seat count `summary.headcount.current` this alert fired on',
      kills:
        evaluation.target != null
          ? `${evaluation.target} or more members are live and each holds a claim → headcount.current ` +
            'under-read them; do not launch more workers from this alert.'
          : 'at least one live member holds a claim → the fleet is not empty; do not launch from this alert.',
    },
  };
}

const DARK_FLEET_MIN_MEMBERS = 3;
const DARK_FLEET_ACTIVITY_WINDOW_SEC = 30 * 60;

export type DarkFleetAlertEvaluation =
  | { alert: true; reason: string; falsifier: AlertFalsifier }
  | { alert: false; reason?: undefined; falsifier?: undefined }
  | { alert: null; reason: string; falsifier?: undefined };

/**
 * WI-41172 / P-010: the built-in form of the incident invariant
 * `fleet-is-dark-nobody-taking-turns`.
 *
 * Population is the canonical, UNFILTERED presence-primary roster. Do not feed
 * this the leader brief's displayed-member slice: that slice intentionally drops
 * stale-idle rows, which are precisely the rows a dark-fleet detector must count.
 * `lastActiveSecAgo` is derived by the roster from genuine coord activity and the
 * turn-parts writer; heartbeat freshness never qualifies as a turn.
 *
 * A degraded presence leg makes both membership and its activity timestamps
 * unverified. That state is in-band `null`, never a false clean `false` and never a
 * fabricated dark `true` from an assignments-only fallback.
 */
export function computeDarkFleetAlert(input: {
  roster: ReadonlyArray<{ lastActiveSecAgo?: number | null }>;
  presenceDegraded: boolean;
  fleet?: string | null;
}): DarkFleetAlertEvaluation {
  if (input.presenceDegraded) {
    return {
      alert: null,
      reason:
        'dark-fleet state is UNKNOWN because the canonical presence roster read degraded; ' +
        'membership and genuine-activity timestamps were not measured on this brief.',
    };
  }

  if (input.roster.length < DARK_FLEET_MIN_MEMBERS) return { alert: false };
  const recentActivity = input.roster.some(
    (member) =>
      typeof member.lastActiveSecAgo === 'number' &&
      Number.isFinite(member.lastActiveSecAgo) &&
      member.lastActiveSecAgo < DARK_FLEET_ACTIVITY_WINDOW_SEC,
  );
  if (recentActivity) return { alert: false };

  return {
    alert: true,
    falsifier: {
      tool: 'fleet:assignments',
      check: renderFalsifierCall('fleet:assignments', {
        fleet: input.fleet,
        include_stale: true,
      }),
      measurement:
        'per-member lastToolCallAt/verdict and progressing work from the assignments + ' +
        'agent-activity path — independent of the presence-derived lastActiveSecAgo values ' +
        'that fired this alert',
      kills:
        'any member shows a tool call within the last 30 minutes or a currently progressing ' +
        'claim → the fleet is working and the presence activity signal under-reported it; do ' +
        'not wake or relaunch the members on this alert.',
    },
    reason:
      `${input.roster.length} registered fleet member(s) show ZERO genuine activity in the ` +
      'last 30 minutes (WI-41172) — heartbeat keepalives do not count as turns. Run the ' +
      'independent fleet:assignments falsifier before acting; if it confirms the dark state, ' +
      'restore member turns now and diagnose the shared launch/loop/auth path instead of ' +
      'waiting for a member to recover itself.',
  };
}

export type FleetExecutionCollapseAlertEvaluation =
  | {
      alert: true;
      reason: string;
      evidence: FleetExecutionCollapseEvidence;
      falsifier: AlertFalsifier;
    }
  | { alert: false; reason?: never; falsifier?: never; evidence: FleetExecutionCollapseEvidence }
  | { alert: null; reason: string; falsifier?: never; evidence: FleetExecutionCollapseEvidence };

export interface FleetExecutionCollapseEvidence {
  rosterMembers: number;
  agentOriginMembers: number | null;
  heldClaimMembers: number;
  heldClaims: number;
  silentHeldClaimMembers: number | null;
  windowMs: number;
}

/** Keep a partial canonical-roster read visibly distinct from a measured empty fleet. */
export function leaderBriefRosterDegradation(degradedLegs: readonly string[]): {
  degraded?: true;
  degradedLegs?: string[];
} {
  const qualified = degradedLegs.filter(Boolean).map((leg) => `roster.${leg}`);
  return qualified.length > 0 ? { degraded: true, degradedLegs: qualified } : {};
}

/**
 * WI-583276: detect a fleet-wide execution collapse that heartbeat/lifecycle
 * surfaces cannot see.  A claim is evidence of work the fleet owns; an exact
 * `call_origin='agent'` row is evidence that a member actually got a turn.
 * Missing either required leg is UNKNOWN, never a false clean or a fabricated
 * collapse.  PURE: the reader supplies the canonical roster and telemetry set.
 */
export function computeFleetExecutionCollapseAlert(input: {
  roster: ReadonlyArray<{
    agentId: string;
    claims?: ReadonlyArray<{ active?: boolean | null; status?: string | null }>;
  }>;
  agentOriginOwnerIds: ReadonlySet<string> | null;
  telemetryDegraded?: boolean;
  presenceDegraded?: boolean;
  fleet?: string | null;
  windowMs?: number;
}): FleetExecutionCollapseAlertEvaluation {
  const windowMs = input.windowMs ?? 30 * 60_000;
  const rosterIds = new Set(input.roster.map((member) => member.agentId).filter(Boolean));
  const heldByOwner = input.roster.map((member) => {
    const claims = (member.claims ?? []).filter((claim) => claim.active !== false);
    return { agentId: member.agentId, claims };
  });
  const heldClaimMembers = heldByOwner.filter(({ claims }) => claims.length > 0).length;
  const heldClaims = heldByOwner.reduce((count, { claims }) => count + claims.length, 0);
  const baseEvidence = {
    rosterMembers: rosterIds.size,
    agentOriginMembers: null as number | null,
    heldClaimMembers,
    heldClaims,
    silentHeldClaimMembers: null as number | null,
    windowMs,
  };
  if (input.presenceDegraded || input.telemetryDegraded || input.agentOriginOwnerIds == null) {
    return {
      alert: null,
      reason:
        'fleet execution-collapse state is UNKNOWN because the canonical roster or exact agent-origin telemetry ' +
        'leg was not measured; zero calls must not be inferred from a failed read.',
      evidence: baseEvidence,
    };
  }
  const agentOriginMembers = [...input.agentOriginOwnerIds].filter((id) => rosterIds.has(id)).length;
  const silentHeldClaimMembers = heldByOwner.filter(
    ({ agentId, claims }) => claims.length > 0 && !input.agentOriginOwnerIds!.has(agentId),
  ).length;
  const evidence = { ...baseEvidence, agentOriginMembers, silentHeldClaimMembers };
  if (heldClaims === 0 || agentOriginMembers > 0) return { alert: false, evidence };
  return {
    alert: true,
    evidence,
    reason:
      `${heldClaimMembers} fleet member(s) hold ${heldClaims} non-terminal claim(s), but ZERO registered members ` +
      `produced an agent-origin tool call in the last ${Math.round(windowMs / 60_000)} minutes (WI-583276). ` +
      'Fresh heartbeats and housekeeping rows do not prove a turn; diagnose the shared inference/launch path before ' +
      'waking or reclaiming these claims.',
    falsifier: {
      tool: 'fleet:assignments',
      check: renderFalsifierCall('fleet:assignments', { fleet: input.fleet, include_stale: true }),
      measurement:
        'the independent assignments claim/progress and per-member liveness view; a progressing claim or recent ' +
        'agent turn disproves the fleet-wide stop',
      kills:
        'any member shows a progressing claim or a confirmed recent agent-origin turn → re-read the telemetry and ' +
        'do not treat the fleet as collapsed.',
    },
  };
}

/**
 * EI-15055 (fleet-members-parked-stall-2026-07-17): the ZERO-WIP-WITH-SUPPLY alert.
 * `parked` was a plain count with no severity — a leader reading `parked:7` next to
 * `unowned_criticals:8` had to notice the juxtaposition itself, and the live incident
 * (2026-07-17 ~14:58: the WHOLE fleet held 0 wip while 8 unowned critical bugs sat
 * unclaimed under a healthy claim-spec) went unnoticed for a while as a result. True
 * exactly when the WHOLE fleet holds no live work (fleet-wide load is 0), at least one
 * member is parked (sleeping on an event — e.g. `work-item:claimable`, which only
 * fires on a NEW create/release/unblock transition and so never wakes a member for
 * supply that already existed before it registered the await), AND known unowned
 * critical supply exists that this fleet's claim spec would admit. A parked member's
 * ~30-min await timeout eventually self-heals, but this lets a leader act NOW instead
 * of waiting out the timeout fleet-wide. PURE: exported for direct unit-testing.
 */
export function computeStrandedFleetAlert(input: {
  totalLoad: number;
  parkedCount: number;
  unownedCriticalCount: number;
  /** Falsifier context — a null harness/fleet still renders a runnable call. */
  harness?: string | null;
  fleet?: string | null;
}): { reason: string; falsifier: AlertFalsifier } | undefined {
  if (input.totalLoad > 0 || input.parkedCount === 0 || input.unownedCriticalCount === 0) return undefined;
  return {
    falsifier: {
      tool: 'work_items:claimable',
      check: renderFalsifierCall('work_items:claimable', {
        harness: input.harness,
        spec: input.fleet,
        breakdownOnly: true,
      }),
      // The alert fires on an unowned-CRITICAL scan, which never consults this
      // fleet's claim spec or the ~12 claim floors. This asks the claim oracle
      // itself whether those rows are actually admissible HERE.
      measurement:
        "post-floor claimable count under this fleet's OWN claim spec — the alert " +
        'counted unowned criticals harness-wide and never consulted the spec or the floors',
      kills:
        'claimableCount 0 → those criticals are NOT admissible to this fleet, so waking the ' +
        'parked members cannot let them claim. Fix the spec/floor (scheduler:set_claim_spec), ' +
        'not the members.',
    },
    reason:
      `fleet-wide wip is 0, ${input.parkedCount} member(s) are parked (sleeping on an event), and ` +
      `${input.unownedCriticalCount} unowned critical(s) this fleet's spec would admit are sitting ` +
      'unclaimed (EI-15055) — the parked event only fires on a NEW create/release/unblock, so it will ' +
      'never wake them for supply that already existed. Do not wait out the park timeout: wake the ' +
      'parked members (coord:send wake:required) so they re-run scheduler:get_next now, or re-verify the ' +
      'claim spec is actually admitting this supply.',
  };
}

/**
 * EI-18655873409999215: the SPEC-STARVED fleet alert — closes a blind spot in
 * computeStrandedFleetAlert (EI-15055) above. That check only fires when unowned
 * criticals THIS FLEET'S SPEC WOULD ADMIT are nonzero — but if the spec itself
 * matches ZERO rows, it admits nothing BY DEFINITION, so unownedCriticalCount is
 * always 0 too and the existing alert can never fire for exactly this shape.
 * Confirmed live 2026-07-25: p2p-release-lane rev7 (an `any:[oldFilter, newClause]`
 * widening revision, statically a superset of the incumbent filter) matched 0 of
 * ~1200 claimable rows for 4.5h — every member reported a clean "nothing
 * claimable, parking" (indistinguishable from a genuinely drained lane), and no
 * surface ever emitted a line about it. The write-time pool-collapse guard
 * (spec-pool-preview.ts) legitimately let this through: a provable-superset
 * revision skips the narrowing/collapse refusal by design (EI-18653814284166347),
 * and the fleet's OWN previous spec had already independently degraded to 0
 * (the noDelta exemption), so no refusal ever fired — only a warning on a single
 * tool-call response nobody was tailing live. This is the STANDING, always-checked
 * half the ticket asked for: "if a fleet's spec had never matched a single row,
 * would any surface emit one line? Today: no."
 *
 * Fires when the fleet holds no live work (mirrors the stranded-fleet shape above)
 * AND its OWN effective claim spec (bee row → fleet row → default) matches 0 rows
 * of a currently-nonempty claimable pool. PURE: exported for direct unit-testing.
 */
export function computeSpecStarvedFleetAlert(input: {
  totalLoad: number;
  specMatched: number;
  poolSize: number;
  harness?: string | null;
  fleet?: string | null;
}): { reason: string; falsifier: AlertFalsifier } | undefined {
  if (input.totalLoad > 0 || input.poolSize === 0 || input.specMatched > 0) return undefined;
  return {
    falsifier: {
      tool: 'work_items:claimable',
      check: renderFalsifierCall('work_items:claimable', {
        harness: input.harness,
        spec: input.fleet,
        breakdownOnly: true,
        sampleExcluded: 3,
      }),
      // This alert fires on previewSpecPoolEffect's PRE-floor compiled-filter count.
      // work_items:claimable is the POST-floor live oracle — a genuinely different
      // measurement (this file already notes the two read ~113 vs 4 on one fleet),
      // so it can contradict the alert rather than restate it.
      measurement:
        "the live claim oracle's POST-floor verdict + per-floor breakdown — the alert fired on " +
        "previewSpecPoolEffect's PRE-floor compiled-filter count, a different measurement",
      kills:
        'matchedByFilter > 0 → the filter IS matching rows and the lane is FLOOR-gated, not ' +
        'spec-starved. Act on the excludedBreakdown; editing view.filter would be the wrong fix.',
    },
    reason:
      `fleet-wide wip is 0 and this fleet's effective claim spec matches 0 of ${input.poolSize} claimable ` +
      "row(s) right now (EI-18655873409999215) — every member's scheduler:get_next will report a clean " +
      "scoped miss, indistinguishable from a genuinely drained lane. Check the spec's view.filter (a " +
      'not:/!= fence over a NULLABLE field, an "=" comparison against an array-typed field like `tags` ' +
      '— use `contains` instead, or a scope that no longer matches any open row) via ' +
      'scheduler:set_claim_spec — do not assume the lane is genuinely drained.',
  };
}

/**
 * fleet-lead-instrumentation-audit-2026-08-09 P-005: the SPEC-AUTHORSHIP alert — a fleet's
 * claim spec can be rewritten by another automated actor with nothing failing loudly.
 *
 * Observed live on this fleet: cup `s-1786236383559` took the spec to rev4, widening `kind`
 * from `[bug]` to `[bug,change]` against an owner-directed BUG scope and pulling ~907 mostly
 * nit/minor items into the lane. It was caught only because the leader happened to re-read
 * the spec by hand that wake — and nothing else COULD have caught it. Every write-time guard
 * in scheduler:set_claim_spec measures the spec's SHAPE (validity, fixed-cohort
 * admissibility, pool COLLAPSE), and a widening passes all of them by construction: the
 * collapse guard exists to catch a lane shrinking to nothing, so a lane growing past its
 * mandate is precisely the direction it is blind to.
 *
 * The signal costs nothing to emit. The brief ALREADY reads this record for the spec-starved
 * preview below and was discarding `updatedBy`/`revision` — so this is not a new probe, it is
 * metadata the existing read already had in hand.
 *
 * Fires when a fleet-level spec exists and its last write is NOT attributable to the agent
 * reading the brief — including an UNATTRIBUTED write (`updatedBy` unset), which is no more
 * verifiable than a foreign one. Stays silent when the reader itself is unresolvable: an
 * unattributable READER cannot be a wronged author, and firing on every unscoped read is how
 * an alert gets trained away. Self-clearing by design — the remedy (re-set the spec, which
 * ratifies the scope under your own authorship) is the same act that silences it.
 * PURE: exported for direct unit-testing.
 */
export function computeSpecAuthorshipAlert(input: {
  readerId: string | null;
  updatedBy: string | null;
  revision: number | null;
  updatedAt: string | null;
  harness?: string | null;
  fleet?: string | null;
}): { reason: string; falsifier: AlertFalsifier } | undefined {
  if (!input.readerId) return undefined;
  if (input.updatedBy && input.updatedBy === input.readerId) return undefined;
  const who = input.updatedBy ? `\`${input.updatedBy}\`` : 'an UNATTRIBUTED writer (the row carries no updated_by)';
  const when = input.updatedAt ? ` on ${input.updatedAt}` : '';
  return {
    falsifier: {
      tool: 'work_items:claimable',
      check: renderFalsifierCall('work_items:claimable', {
        harness: input.harness,
        spec: input.fleet,
        breakdownOnly: true,
        sampleExcluded: 3,
      }),
      // This alert fires on the cup_claim_specs row's AUTHORSHIP columns. The claim oracle
      // reports what the lane now ADMITS — a different question against a different table,
      // so it can contradict the alert instead of restating it.
      measurement:
        'what the lane ACTUALLY admits under the current spec, from the live claim oracle — ' +
        "the alert fired on the spec row's updated_by/revision, which say who wrote it and " +
        'never what it now selects',
      kills:
        'the admitted set matches the scope you intended → the rewrite was an honest merge, ' +
        'not a breach. Ratify it with scheduler:set_claim_spec so the lane carries your ' +
        'authorship again, which also clears this line — do not re-narrow a lane that is correct.',
    },
    reason:
      `this fleet's claim spec was last written by ${who}${when}, at revision ` +
      `${input.revision ?? 'unknown'} — not by you. A third-party rewrite is invisible by ` +
      "construction: set_claim_spec validates the spec's SHAPE and refuses a lane that " +
      'COLLAPSES, so a WIDENING passes every write-time guard (the observed breach took ' +
      '`kind` from [bug] to [bug,change], ~907 extra items against a bug-only mandate). Read ' +
      'the live filter with scheduler:get_claim_spec { fleet } and confirm the scope is the ' +
      'one you intended before trusting what your members are pulling.',
  };
}

/**
 * EI-18681259560385029: the IDLE-WITH-CLAIMABLE alert — the summary-level half of the
 * benchSuggestion wording fix above, and the third distinct hole in this family.
 *
 * The two existing fleet alerts are each structurally unable to fire for this shape:
 *  - computeStrandedFleetAlert (EI-15055) requires `parkedCount > 0` AND
 *    `unownedCriticalCount > 0`. The incident's members were NOT parked (the laneless-idle
 *    branch excludes parked members by construction) and the queued work was `major`, not
 *    `critical` — so it was excluded twice over.
 *  - computeSpecStarvedFleetAlert (EI-18655873409999215) requires `specMatched === 0`, i.e.
 *    a spec matching NOTHING. Here the spec was healthy and matching fine; the work was
 *    claimable and simply unclaimed. Correct by its own definition, blind to this.
 * So "idle members next to a nonempty queue" — the one state a drain fleet must never sit
 * in — had no alert at all, while `bench_suggested: 5` sat in the summary looking benign.
 *
 * Fires when work IS claimable under the fleet's own spec AND at least one member is
 * alive-but-idle (no claim, nothing queued, not parked). Deliberately does NOT require
 * fleet-wide zero wip (unlike both alerts above): a fleet where SOME members work and
 * others idle beside a filling queue is still starving, just more quietly.
 *
 * `claimableCount: null` (unreadable) NEVER fires it — an unknown queue is not evidence of
 * a full one, exactly as it is not evidence of an empty one. PURE: exported for unit-testing.
 */
export function computeIdleWithClaimableAlert(input: {
  claimableCount: number | null;
  idleMemberCount: number;
  /** EI-18703234178947959: the fleet's own control state is winding-down (owner-paused).
   *  Suppresses the alert entirely — see the defence-in-depth note below. */
  fleetPaused?: boolean | null;
  harness?: string | null;
  /** The members this alert is accusing — so its falsifier names a REAL one. */
  idleMemberIds?: readonly string[];
  /** WI-37161: the live shared-inference-pool verdict — see `isPoolCongested`. When the pool is
   *  degraded/exhausted with a nonzero gateway queue, the remedy below flips from "wake them" to
   *  "they're queued for inference, don't wake, re-check fleet:capacity" (same reasoning as the
   *  per-member idle-with-claimable branch in computeBenchSuggestion). `undefined`/`null` reads
   *  as "not read on this call" and never suppresses the alert itself. */
  poolCapacity?: PoolDegradedState | null;
}): { reason: string; falsifier: AlertFalsifier } | undefined {
  // EI-18703234178947959: never tell a leader to wake members of an owner-PAUSED fleet.
  // The rows counted here are real backlog, but backlog OUTSIDE this fleet's paused
  // scope: the claim path refuses it (`windDown:true`), so every wake this alert
  // prescribes is spent re-discovering the pause. Defence-in-depth — `idleMemberCount`
  // is already 0 for a paused fleet because computeBenchSuggestion suppresses the idle
  // branches at source, so this is the second, independent guard that keeps the alert
  // false-positive-proof if a future caller ever feeds it a differently-derived count.
  if (input.fleetPaused) return undefined;
  if (input.claimableCount == null || input.claimableCount <= 0) return undefined;
  if (input.idleMemberCount <= 0) return undefined;
  const accused = input.idleMemberIds?.[0];
  // WI-37161: see computeBenchSuggestion's identical check for the full incident writeup. The
  // summary-level alert must not repeat the same "wake them" advice the per-member branch just
  // stopped giving — a leader reading ONLY the summary (the common case: this is the ONE-glance
  // surface) would otherwise still be told to wake a fleet that is actually inference-queued.
  if (isPoolCongested(input.poolCapacity)) {
    const p = input.poolCapacity;
    return {
      falsifier: {
        tool: 'fleet:capacity',
        check: renderFalsifierCall('fleet:capacity', {}),
        // The live gateway/account-pool oracle — the SAME read this alert now consults, but
        // re-run fresh: capacity moves between the brief's read and the leader acting on it.
        measurement:
          'a FRESH read of the live gateway/account-pool capacity oracle (fleet:capacity) — ' +
          'this alert already consulted it once; re-running confirms the pool is STILL degraded ' +
          'before the leader waits instead of acting',
        kills:
          'degraded:false AND poolExhausted:false → the pool has recovered. If members are still ' +
          'idle beside a nonempty queue at that point, THEN wake them — the old remedy applies again.',
      },
      reason:
        `${input.idleMemberCount} member(s) are alive with NO claim while ${input.claimableCount} ` +
        `item(s) are claimable, BUT the shared inference account pool is ` +
        `${p.poolExhausted ? 'EXHAUSTED' : 'DEGRADED'} right now (factor ${p.factor.toFixed(2)}` +
        (p.usableAccounts != null ? `, ${p.usableAccounts} usable account(s)` : '') +
        (p.queueDepth != null ? `, ~${p.queueDepth} request(s) already queued at the gateway` : '') +
        ') — these members are most likely QUEUED FOR INFERENCE, not declining work. DO NOT wake ' +
        'them: coord:send { wake: "required" } just adds MORE requests behind the same congestion, ' +
        'amplifying the fault (WI-37161). DO NOT fleet:bench them either — the lane is not drained. ' +
        'Re-check fleet:capacity and act only once it reports degraded:false/poolExhausted:false.',
    };
  }
  return {
    falsifier: {
      tool: 'work_items:list',
      check: renderFalsifierCall('work_items:list', {
        harness: input.harness,
        assignee: accused ?? 'self',
        state: 'open',
      }),
      // THE incident this whole falsifier family exists for. The alert's idle count
      // comes from the brief's own per-member load projection; this reads the member's
      // holdings straight from the work-item ledger, which is what that projection is a
      // projection OF — so a member at its concurrency cap shows up here as a held row
      // even when the brief rendered it idle.
      measurement:
        "the named member's ACTUAL open holdings in the work-item ledger — independent of the " +
        "brief's own per-member load projection, which is the reading that mis-rendered " +
        'at-capacity members as idle',
      kills:
        'the member already holds an open item → it is AT its concurrency cap, not idle. The ' +
        'scheduler will refuse it and the wake demands work it is structurally forbidden to ' +
        'take. Repeat per accused member before waking any of them.',
    },
    reason:
      `${input.idleMemberCount} member(s) are alive with NO claim and nothing queued while ` +
      `${input.claimableCount} item(s) are claimable under this fleet's own spec right now ` +
      '(EI-18681259560385029) — idle members beside a nonempty queue is the one state a drain ' +
      'fleet must never sit in. This is NOT a drained lane and benching is the wrong remedy: ' +
      'coord:send { wake: "required" } those members so they re-run scheduler:get_next now. ' +
      "If they wake and still claim nothing, read work_items:claimable's excludedBreakdown — " +
      'a claim floor is holding the rows, not the members.',
  };
}

/**
 * EI-18689489507862177: the FLOOR-STARVED alert — the fourth distinct hole in this family,
 * and the one every preceding alert is structurally unable to see.
 *
 * THE SHAPE: the fleet's spec matches PLENTY of rows, but every one of them is withheld by
 * a claim floor, so `claimable` is 0 while members idle. The backlog is neither missing nor
 * mis-scoped — it is being held.
 *
 * Why each sibling is blind, by its own definition:
 *  - computeStrandedFleetAlert (EI-15055) requires `parkedCount > 0 && unownedCritical > 0`.
 *  - computeSpecStarvedFleetAlert (EI-18655873409999215) requires `specMatched === 0`.
 *    Here specMatched is large — that alert reads the lane as healthy.
 *  - computeIdleWithClaimableAlert (EI-18681259560385029) requires `claimableCount > 0`.
 *    Here it is exactly 0 — that alert reads the lane as drained.
 * So a fleet in this state trips nothing, and `claimable_now: 0` in the summary reads as a
 * clean drain. Confirmed live on nonp2p-bug-drain-0725, 2026-07-26T07:00Z: matchedByFilter
 * 108, claimable 0, 5 of 10 members at load 0 (federationDetector=50, claimHold=38,
 * needsHuman=11, taken=8) — and the per-member line advised benching all five.
 *
 * This is ALSO why the ticket's proposed `laneMatchCount` leader signal would not have
 * worked: on that fleet it reads 108 and looks healthy. The diagnostic pair is
 * (matchedByFilter > 0) AND (claimable === 0) — a match count alone means nothing.
 *
 * `claimable: null` (unreadable) NEVER fires it, mirroring the sibling above: an unknown
 * queue is not evidence of a held one. PURE: exported for direct unit-testing.
 */
export function computeFloorStarvedFleetAlert(input: {
  claimable: number | null;
  matchedByFilter: number | null;
  idleMemberCount: number;
  excluded?: Record<string, number> | null;
  /** EI-18703234178947959: same suppression as the sibling above — a paused fleet's
   *  idle members are complying, and this alert's remedies (clear the floor / widen the
   *  spec / wind the fleet down) are all moot or already done. */
  fleetPaused?: boolean | null;
  harness?: string | null;
  fleet?: string | null;
}): { reason: string; falsifier: AlertFalsifier } | undefined {
  if (input.fleetPaused) return undefined;
  if (input.claimable == null || input.claimable !== 0) return undefined;
  if (input.matchedByFilter == null || input.matchedByFilter <= 0) return undefined;
  if (input.idleMemberCount <= 0) return undefined;
  const floors = topExcludedFloors(input.excluded);
  return {
    falsifier: {
      tool: 'work_items:claimable',
      check: renderFalsifierCall('work_items:claimable', {
        harness: input.harness,
        spec: input.fleet,
        breakdownOnly: true,
        sampleExcluded: 5,
      }),
      // `sampleExcluded` is the row-level companion to the counts. The alert fires on
      // bucket COUNTS alone, and the holders are not recoverable from a count — so the
      // ids are new information, not a re-projection. The distinction matters most for
      // the `taken` bucket, which reads as "gated" but means "being worked".
      measurement:
        'the ROW IDENTITIES behind each floor bucket (excludedSample) — the alert fired on ' +
        'bucket COUNTS alone, from which the held rows and their holders cannot be recovered',
      kills:
        'the dominant bucket is `taken` and its sampled rows are held by live, progressing ' +
        'members → the lane is being WORKED, not gated. Clearing a floor or widening the spec ' +
        'would be the wrong act; there is nothing to fix.',
    },
    reason:
      `${input.idleMemberCount} member(s) are alive with NO claim while this fleet's spec matches ` +
      `${input.matchedByFilter} row(s) of which ZERO survive the claim floors ` +
      (floors.length > 0 ? `(${floors.map(([k, n]) => `${k}=${n}`).join(', ')}; buckets overlap) ` : '') +
      '(EI-18689489507862177) — the lane is GATED, not drained, and no other fleet alert can ' +
      'see this state. Do NOT fleet:bench these members: benching parks them on a completion ' +
      'event that cannot fire, because nothing is in flight to complete. Act on the dominant ' +
      'floor above — clear/redirect it, or widen the spec via scheduler:set_claim_spec. If the ' +
      'gating is correct and permanent, this fleet is done: fleet:wind-down is the honest call.',
  };
}

/**
 * The five layers a fleet can be blocked AT, in the order they physically dominate one
 * another. Named as a closed union rather than left implicit in prose because the whole
 * point of the verdict below is that exactly ONE of them is the leader's next action.
 */
export type FleetBlockLayer = 'fleet-paused' | 'inference-pool' | 'spec-scope' | 'claim-floors' | 'members';

/** The arbitrated answer to "is my fleet blocked, and AT WHICH LAYER". */
export interface FleetBlockVerdict {
  layer: FleetBlockLayer;
  /** Why THIS layer, stated so the reader can check it against the summary counts. */
  reason: string;
  /** The one action that addresses this layer. Deliberately singular. */
  remedy: string;
  /**
   * Sibling alerts that are TRUE but SUBORDINATE at this layer — named so a leader does
   * not act on them first. Empty is meaningful: nothing else was firing.
   */
  subordinate: string[];
  falsifier: AlertFalsifier;
}

/**
 * fleet-lead-instrumentation-audit-2026-08-09 P-019 (+P-012): the ARBITER over the alert
 * family above.
 *
 * THE GAP THIS CLOSES. Every alert above is individually correct and independently
 * computed, and the brief renders them FLAT. So a starved fleet trips several at once and
 * the leader — who has no precedence rule — picks one. Measured live on `nonp2p-bug-drain`
 * 2026-08-09T02:31Z: `fleet:leader-brief` said "DO NOT bench... wake it to re-run
 * scheduler:get_next" while `fleet:capacity` simultaneously said "place conservatively,
 * prefer a warm-inject over a fresh spawn". Both readings were TRUE. They pointed opposite
 * ways, and the brief offered nothing to choose between them (P-012). The leader-facing
 * question — "is my fleet blocked, and at which layer: pool, floors, spec, or the members
 * themselves?" — had no single answer anywhere (P-019).
 *
 * WHY PRECEDENCE, NOT SEVERITY. The order below is the physical dependency chain, not a
 * ranking of badness. A member cannot claim work without inference capacity; a claim floor
 * cannot be observed to withhold anything from a member that never got a turn. So every
 * lower layer's evidence is MEASURED THROUGH the layers above it, and reading a lower layer
 * while an upper one is blocked yields a confident wrong answer:
 *
 *   1. `fleet-paused`    — the leader paused this fleet. Every idle member is COMPLYING;
 *                          the other layers are not failing, they are switched off.
 *   2. `inference-pool`  — no capacity. Members physically cannot take turns, so they read
 *                          as idle at every other layer. This is the one that inverts the
 *                          remedy: the flat brief's advice here is "wake them", and a wake
 *                          adds another request behind the same congestion (WI-37161).
 *   3. `spec-scope`      — the spec admits nothing. Floors are not the constraint; there
 *                          is nothing for them to withhold.
 *   4. `claim-floors`    — the spec matches plenty and floors withhold all of it.
 *   5. `members`         — capacity fine, queue non-empty, work claimable, members still
 *                          idle. ONLY HERE is "wake them" the right act.
 *
 * The verdict fires only when the fleet is NOT progressing (some member idle, or paused) —
 * a fleet with every member working is not blocked at any layer and returns `undefined`
 * rather than a reassuring "layer: none" row that would just be one more thing to read.
 *
 * FAIL-SOFT DIRECTION. An UNREAD pool (`poolCapacity == null`) never satisfies layer 2, so
 * an unreadable substrate cannot manufacture a pool verdict — but it also must not silently
 * promote layer 5, whose remedy is the harmful one. When the pool is unread and the
 * remaining evidence would name `members`, the verdict says so in `reason` and the
 * falsifier sends the leader to probe the pool FIRST. Same discipline as
 * `readPoolDegradedState`: unknown is stated, never rounded to healthy.
 *
 * PURE: exported for direct unit-testing.
 */
export function computeFleetBlockVerdict(input: {
  fleetPaused?: boolean | null;
  poolCapacity?: PoolDegradedState | null;
  /** Post-floor claimable; null = unread (never folded into 0). */
  claimable: number | null;
  /** Pre-floor spec match count; null = unread. */
  matchedByFilter: number | null;
  /** Members idle beside a NONEMPTY queue (summary.idle_with_claimable). */
  idleMemberCount: number;
  /** Members idle beside an empty/unread queue (summary.laneless_idle). */
  lanelessIdleCount: number;
  harness?: string | null;
  fleet?: string | null;
}): FleetBlockVerdict | undefined {
  const idleTotal = input.idleMemberCount + input.lanelessIdleCount;
  if (!input.fleetPaused && idleTotal <= 0) return undefined;

  // Which siblings are TRUE right now, so a dominant layer can name what it is overruling.
  const firing: string[] = [];
  if (isPoolCongested(input.poolCapacity)) firing.push('pool congested');
  if (input.matchedByFilter === 0) firing.push('specStarvedAlert');
  if (input.claimable === 0 && (input.matchedByFilter ?? 0) > 0) firing.push('floorStarvedAlert');
  if ((input.claimable ?? 0) > 0 && input.idleMemberCount > 0) {
    firing.push('idleWithClaimableAlert');
  }
  const subordinateTo = (mine: string) => firing.filter((f) => f !== mine);

  if (input.fleetPaused) {
    return {
      layer: 'fleet-paused',
      reason:
        `This fleet's own control_state is paused/winding-down, and ${idleTotal} member(s) are ` +
        'idle BECAUSE OF THAT. No other layer is failing — they are switched off. Any alert ' +
        'below is describing a consequence of the pause, not an independent fault.',
      remedy: 'fleet:resume (or finish the wind-down) — nothing else here is actionable first.',
      subordinate: subordinateTo('fleet-paused'),
      falsifier: {
        tool: 'fleet:status',
        check: renderFalsifierCall('fleet:status', { fleet: input.fleet }),
        measurement: "the fleet's live control_state, read independently of this brief's snapshot",
        kills:
          'control_state is NOT paused/winding-down → the pause was lifted between reads; ' +
          're-run the brief and act on the layer it names instead.',
      },
    };
  }

  if (isPoolCongested(input.poolCapacity)) {
    const p = input.poolCapacity;
    return {
      layer: 'inference-pool',
      reason:
        `${idleTotal} member(s) idle while the shared inference pool is congested ` +
        `(factor ${p.factor}, queueDepth ${p.queueDepth ?? 'unknown'}, usableAccounts ` +
        `${p.usableAccounts ?? 'unknown'}). Those members are QUEUED FOR INFERENCE, not ` +
        'declining work — a member that cannot get a turn reads as idle at every other layer, ' +
        'which is why the alerts below fire simultaneously and mean nothing on their own.',
      remedy:
        'Wait for the pool, or add capacity (accounts:scale_out / accounts:link-start). Do NOT ' +
        'coord:send wake:required these members — a wake adds another request behind the same ' +
        'congestion and makes it worse (WI-37161). Do NOT fleet:bench them either: they are ' +
        'ready to work the moment capacity returns.',
      subordinate: subordinateTo('pool congested'),
      falsifier: {
        tool: 'accounts:probe-capacity',
        check: renderFalsifierCall('accounts:probe-capacity', { apply: true }),
        // The pool verdict is derived from a PROJECTION that can go stale while reporting
        // full confidence; the probe is a live upstream read. They are different sources,
        // which is the whole point — see `kills`.
        measurement:
          'the LIVE per-account upstream status (200 vs 429), independent of the cached ' +
          'headroom projection this verdict was computed from',
        kills:
          'accounts answer 200 → the projection is STALE and this verdict is a false positive; ' +
          'the pool is usable and you should re-read the brief for the real layer. Measured ' +
          'twice on 2026-08-09: fleet:capacity reported poolExhausted with usableAccounts 0 ' +
          'while 3 of 4 accounts answered 200. NEVER escalate a pool/egress fault to the owner ' +
          'on the projection alone — probe first.',
      },
    };
  }

  if (input.matchedByFilter === 0) {
    return {
      layer: 'spec-scope',
      reason:
        `${idleTotal} member(s) idle and this fleet's claim spec matches ZERO rows. The floors ` +
        'are not the constraint — there is nothing for them to withhold. The scope itself is ' +
        'the block.',
      remedy:
        'Widen the scope via scheduler:set_claim_spec, or fleet:wind-down if the lane is ' + 'genuinely finished.',
      subordinate: subordinateTo('specStarvedAlert'),
      falsifier: {
        tool: 'work_items:claimable',
        check: renderFalsifierCall('work_items:claimable', { harness: input.harness }),
        measurement:
          'the HARNESS-WIDE claimable pool, pre-spec-narrowing — a different question from ' +
          "this fleet's spec-scoped match count",
        kills:
          'the harness-wide pool is ALSO 0 → the queue is drained, not mis-scoped; widening ' +
          'the spec finds nothing and fleet:wind-down is the honest call.',
      },
    };
  }

  if (input.claimable === 0 && (input.matchedByFilter ?? 0) > 0) {
    return {
      layer: 'claim-floors',
      reason:
        `${idleTotal} member(s) idle while the spec matches ${input.matchedByFilter} row(s) of ` +
        'which ZERO survive the claim floors. The lane is GATED, not drained, and the pool is ' +
        'healthy — so this is the layer that is actually holding the work.',
      remedy:
        "Act on the dominant floor (work_items:claimable's excludedBreakdown), or widen the " +
        'spec. Do NOT bench these members — benching parks them on a completion event that ' +
        'cannot fire.',
      subordinate: subordinateTo('floorStarvedAlert'),
      falsifier: {
        tool: 'work_items:claimable',
        check: renderFalsifierCall('work_items:claimable', {
          harness: input.harness,
          spec: input.fleet,
          breakdownOnly: true,
          sampleExcluded: 5,
        }),
        measurement:
          'the ROW IDENTITIES behind each floor bucket — this verdict fired on bucket COUNTS, ' +
          'from which the holders cannot be recovered',
        kills:
          'the dominant bucket is `taken` and its rows are held by live, progressing members ' +
          '→ the lane is being WORKED, not gated; there is nothing to clear.',
      },
    };
  }

  if ((input.claimable ?? 0) > 0 && input.idleMemberCount > 0) {
    // The ONLY layer whose remedy is a wake — so it is also the one that must state, out
    // loud, when it was reached without being able to rule the pool out.
    const poolUnread = input.poolCapacity == null;
    return {
      layer: 'members',
      reason:
        `${input.idleMemberCount} member(s) are idle beside ${input.claimable} claimable row(s) ` +
        'with no upstream layer blocking them' +
        (poolUnread
          ? ' — EXCEPT that no single inference pool could be RESOLVED for this fleet, so layer 2 ' +
            'was not ruled out. That is not necessarily a failed read: it is also what a fleet ' +
            'spanning more than one provider looks like, and re-probing cannot change THAT. ' +
            'Check which before acting — this layer is the only one whose remedy (waking ' +
            'members) makes a congested pool WORSE.'
          : ' (pool read and healthy, spec matching, floors clear). The members themselves are ' + 'the block.'),
      remedy: poolUnread
        ? 'Run the falsifier FIRST. If it returns a healthy pool for the provider your MEMBERS ' +
          'run on, this was a resolution gap rather than congestion: coord:send { wake: "required" } ' +
          'those members so they re-run scheduler:get_next. If probing keeps leaving this ' +
          'unresolved, the fleet spans providers — read capacity per provider (WI-41005).'
        : 'coord:send { wake: "required" } those members so they re-run scheduler:get_next now.',
      subordinate: subordinateTo('idleWithClaimableAlert'),
      falsifier: poolUnread
        ? {
            tool: 'fleet:capacity',
            check: renderFalsifierCall('fleet:capacity', {}),
            measurement: 'the inference-pool state this brief could not read — the layer that dominates ' + 'this one',
            kills:
              'the pool is degraded/exhausted with a nonzero queue → this verdict is WRONG, the ' +
              'real layer is inference-pool, and waking these members worsens it.',
          }
        : {
            tool: 'work_items:claimable',
            check: renderFalsifierCall('work_items:claimable', {
              harness: input.harness,
              spec: input.fleet,
              breakdownOnly: true,
              sampleExcluded: 5,
            }),
            measurement:
              'the row identities behind the claimable count — whether those rows are genuinely ' +
              'available to THESE members',
            kills:
              'the claimable rows are all already `taken` by live members → the members are not ' +
              'idle-by-choice and there is nothing to wake them for.',
          },
    };
  }

  return undefined;
}

/**
 * EI-18681259560385029: IO shell for the alert above — the fleet's live authoritative
 * claimable count, or `null` when it genuinely could not be read.
 *
 * WI-5938: the implementation moved to `lib/fleet/lane-health.ts` so `fleet:bench` can
 * ENFORCE the invariant this file only states in prose ("DO NOT fleet:bench it either —
 * the lane is not drained"). It is re-exported here unchanged; see that module for the
 * full rationale, including why a second claimable count would be a bug rather than a
 * convenience (EI-19313376980892266).
 */
export type { FleetLaneHealth } from '../../fleet/lane-health';

/**
 * The dominant claim floors behind a gated lane, largest first — what the leader must
 * actually act on. Buckets OVERLAP by construction, so this ranks them rather than
 * pretending they partition the matched set.
 */
export function topExcludedFloors(
  excluded: Record<string, number> | null | undefined,
  limit = 3,
): Array<[string, number]> {
  if (!excluded) return [];
  return Object.entries(excluded)
    .filter(([, n]) => typeof n === 'number' && n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

export type DecoratedAgent = AgentAssignment & {
  /** Terminal device from the visible psu launcher. Null/absent identifies a
   * headless member (or a pre-tty-tracking row), so it is not a psu-host
   * authority cohort. */
  tty?: string | null;
  sessionState?: SessionState | null;
  wakeable?: boolean | null;
  confirmLiveness?: boolean | null;
  verdict?: MemberVerdict;
  wakeMode?: WakeMode;
  lastToolCallAt?: string | null;
  /** EI-19307414464301772: last tool call excluding HOUSEKEEPING_TOOL_NAMES. */
  productiveToolCallAt?: string | null;
  parkedOn?: string[];
  /** EI-18732218464905145: the leader-legible collapse of `parkedOn` — set by
   *  `decorateComposedParkedOn` when a raw key is a `composed-root:<id>` sentinel.
   *  Absent (or equal to `parkedOn` verbatim) when the member holds no composed
   *  await, or the resolution read failed (fails open to the raw flat list). */
  parkedOnResolved?: Array<string | ComposedParkEntry>;
  verifiedWaitTakeovers?: VerifiedWaitTakeoverAlert[];
  contextPressure?: ContextPressureBucket | null;
  contextPressureAgeSec?: number | null;
  coordHook?: CoordDeafState | null;
  coordLastReadAgoSec?: number | null;
  unanswered?: UnansweredDirectedSummary;
  /** P-030: the leader→member actuation ledger. Deliberately NOT `directives`. */
  directiveActuation?: DirectiveActuationSummary;
  monitorState?: MonitorState | null;
  nextFireAt?: string | null;
  loopMode?: 'work' | 'monitor' | null;
  lifecycleBackoff?: LifecycleBackoffInfo | null;
  /** Genuine-activity age from the canonical presence/turn-parts roster fold. */
  lastActiveSecAgo?: number | null;
  /** Canonical coord-intent freshness signals from the fleet roster fold. */
  intentAgeSec?: number | null;
  intentStale?: boolean | null;
  intentDivergent?: boolean | null;
};

export interface LeaderDependencyBottleneckHolder {
  agentId: string;
  label: string | null;
  alive: boolean;
  sessionState: SessionState | null;
  verdict: MemberVerdict | null;
}

export interface LeaderDependencyBottleneckRow {
  rank: number;
  key: string;
  kind: 'plan_item' | 'work_item' | 'external';
  ref: string;
  status: string | null;
  title: string | null;
  workItemRefs: string[];
  openBlockedCount: number;
  lastProgressAt: string | null;
  hoursSinceProgress: number | null;
  holder: {
    state: 'held' | 'unowned';
    count: number;
    agents: LeaderDependencyBottleneckHolder[];
    truncated: boolean;
  };
}

export type LeaderDependencyBottleneckView =
  | {
      status: 'measured';
      population: DependencyBottleneckResult['population'] & {
        progressBasis: 'harness_shared.work_items.last_progress_at';
        holderBasis: 'reconciled-fleet-assignment-claims';
      };
      rows: LeaderDependencyBottleneckRow[];
      /** Work dependency health projection: same classifier output as the tool read. */
      findings?: DependencyBottleneckResult['findings'];
      /** Opt-in human renderer over the same SQL result as `rows`. */
      mermaid?: string;
    }
  | {
      status: 'unknown';
      reason: 'claim-spec-unread' | 'claim-spec-not-exact-plan' | 'plan-harness-unresolved' | 'read-failed';
      planSlug?: string;
      harnessSlug?: string;
    };

export type LeaderBlockerStallBriefView =
  | LeaderBlockerStallView
  | {
      status: 'unknown';
      alert: null;
      thresholdHours: number;
      checkedRows: 0;
      reason: string;
      unknown: {
        code: 'dependency-bottlenecks-unmeasured';
        sourceReason: Extract<LeaderDependencyBottleneckView, { status: 'unknown' }>['reason'];
      };
    };

/**
 * P-009 consumes P-006's already-measured rows exactly once. An unread P-006
 * view remains an explicit UNKNOWN alarm state; it must never collapse into a
 * clear result merely because there are no rows available to evaluate.
 */
export function buildLeaderBlockerStallBriefView(
  dependencyBottlenecks: LeaderDependencyBottleneckView,
  fleet?: string | null,
): LeaderBlockerStallBriefView {
  if (dependencyBottlenecks.status === 'measured') {
    return computeLeaderBlockerStallView({ rows: dependencyBottlenecks.rows, fleet });
  }
  return {
    status: 'unknown',
    alert: null,
    thresholdHours: DEFAULT_LEADER_BLOCKER_STALL_THRESHOLD_HOURS,
    checkedRows: 0,
    reason:
      `leader-blocker stall state is UNKNOWN: dependency bottlenecks were not measured ` +
      `(${dependencyBottlenecks.reason}).`,
    unknown: {
      code: 'dependency-bottlenecks-unmeasured',
      sourceReason: dependencyBottlenecks.reason,
    },
  };
}

/**
 * Join the graph-ranked blockers to the ALREADY reconciled fleet roster. Progress
 * age is derived only from the graph reader's canonical work_items.last_progress_at
 * value — never from a heartbeat, claim acquisition, or tool-call timestamp.
 */
export function buildLeaderDependencyBottleneckView(
  result: DependencyBottleneckResult,
  members: readonly DecoratedAgent[],
  nowMs = Date.now(),
): LeaderDependencyBottleneckView {
  const rows = result.rows.map((row, index): LeaderDependencyBottleneckRow => {
    const refs = new Set(row.workItemRefs.map((ref) => ref.toUpperCase()));
    const holdersById = new Map<string, LeaderDependencyBottleneckHolder>();
    for (const member of members) {
      const holds = member.claims.some(
        (claim) => claim.type === 'work-item' && claim.active && claim.id != null && refs.has(claim.id.toUpperCase()),
      );
      if (!holds) continue;
      holdersById.set(member.agentId, {
        agentId: member.agentId,
        label: member.label,
        alive: member.alive,
        sessionState: member.sessionState ?? null,
        verdict: member.verdict ?? null,
      });
    }
    const allHolders = [...holdersById.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
    const progressMs = row.lastProgressAt == null ? Number.NaN : Date.parse(row.lastProgressAt);
    const hoursSinceProgress = Number.isFinite(progressMs)
      ? Math.max(0, Math.floor((nowMs - progressMs) / 3_600_000))
      : null;
    return {
      rank: index + 1,
      key: row.key,
      kind: row.kind,
      ref: row.ref,
      status: row.status,
      title: row.title,
      workItemRefs: row.workItemRefs,
      openBlockedCount: row.openBlockedCount,
      lastProgressAt: row.lastProgressAt,
      hoursSinceProgress,
      holder: {
        state: allHolders.length > 0 ? 'held' : 'unowned',
        count: allHolders.length,
        agents: allHolders.slice(0, 3),
        truncated: allHolders.length > 3,
      },
    };
  });
  return {
    status: 'measured',
    population: {
      ...result.population,
      progressBasis: 'harness_shared.work_items.last_progress_at',
      holderBasis: 'reconciled-fleet-assignment-claims',
    },
    rows,
    findings: result.findings ?? [],
    ...(result.graph ? { mermaid: renderDependencyBottleneckMermaid(result.graph) } : {}),
  };
}

/**
 * EI-18732218464905145 (the WI-6095/EI-18731480441007330 false-deadlock incident):
 * a composed `events:await { spec }` registration stores ONE root node (its own
 * deadline/timeout-behavior, on `event_await_nodes`) plus N sibling LEAF rows on
 * `event_awaits` (each with `expires_ts: NULL` by design — the root owns it), and
 * an anchor `event_awaits` row keyed `composed-root:<rootId>` that
 * `listParkedAwaitsForSubscribers` (the shared read behind `parkedOn` everywhere:
 * fleet:assignments, coord:presence, this brief) returns as just another flat key.
 * The result: a leader reading `parkedOn` sees the root sentinel and its leaves as
 * N independent, seemingly-unbounded waits — exactly the misreading that produced a
 * false "permanent unbreakable deadlock" diagnosis live on this fleet. This type is
 * the single structured replacement: one entry per composed tree, carrying the
 * `any`/`all`/`k-of-n` semantics and the EFFECTIVE deadline in the same place a
 * leader already looks.
 */
export interface ComposedParkEntry {
  kind: 'composed';
  rootId: number;
  /** Derived from requiredCount vs. leaf count — 'any' (require 1), 'all'
   *  (require === total), or 'k-of-n' for anything in between. */
  mode: 'any' | 'all' | 'k-of-n';
  required: number;
  of: number;
  leaves: string[];
  /** The root node's OWN deadline — never NULL for a real timed composed await,
   *  unlike a leaf row's (always-NULL-by-design) expires_ts. */
  expiresTs: string | null;
  onTimeout: TimeoutBehavior;
}

/**
 * PURE (no I/O — unit-tests without PG): collapse a member's raw flat `parkedOn`
 * keys into the leader-legible form. A `composed-root:<id>` sentinel with a
 * resolved tree in `composedTrees` becomes ONE `ComposedParkEntry`, and every raw
 * key that is one of THAT tree's own leaves is dropped from the flat list (it is
 * now represented inside the entry, not duplicated beside it) — closing the "the
 * root is listed as a sibling of its own leaves" defect verbatim. A composed
 * sentinel with NO matching tree (the async lookup failed, or raced a fire/cancel)
 * is left as its raw string — fail OPEN, never silently drop information the raw
 * read actually returned. Every other (ordinary, non-composed) key passes through
 * unchanged.
 */
export function resolveComposedParkedOn(
  rawKeys: readonly string[],
  composedTrees: ReadonlyMap<
    number,
    { required: number; leaves: readonly string[]; expiresTs: string | null; onTimeout: TimeoutBehavior }
  >,
): Array<string | ComposedParkEntry> {
  if (rawKeys.length === 0) return [];
  const consumedLeafKeys = new Set<string>();
  const composedEntries: Array<string | ComposedParkEntry> = [];
  for (const key of rawKeys) {
    const m = /^composed-root:(\d+)$/.exec(key);
    if (!m) continue;
    const rootId = Number(m[1]);
    const tree = composedTrees.get(rootId);
    if (!tree) {
      composedEntries.push(key); // fail open: unresolved tree — keep the raw sentinel visible
      continue;
    }
    for (const leaf of tree.leaves) consumedLeafKeys.add(leaf);
    const of = tree.leaves.length;
    const mode: ComposedParkEntry['mode'] =
      tree.required >= of && of > 0 ? 'all' : tree.required <= 1 ? 'any' : 'k-of-n';
    composedEntries.push({
      kind: 'composed',
      rootId,
      mode,
      required: tree.required,
      of,
      leaves: [...tree.leaves],
      expiresTs: tree.expiresTs,
      onTimeout: tree.onTimeout,
    });
  }
  const plainKeys = rawKeys.filter((key) => !/^composed-root:\d+$/.test(key) && !consumedLeafKeys.has(key));
  return [...composedEntries, ...plainKeys];
}

/**
 * Resolve composed-await park state for a batch of agents (best-effort, per-agent
 * bounded, fail-soft): only agents whose raw `parkedOn` contains a
 * `composed-root:<id>` sentinel are read at all — the common case (an ordinary,
 * non-composed park, or no park) costs nothing extra. A read failure for one
 * agent's tree never blocks the others, and never blocks the brief as a whole —
 * it simply leaves that agent's `parkedOnResolved` unset, so `projectMember`
 * falls back to the raw flat list exactly as before this fix. Mutates in place,
 * matching `decorateParkedOn`'s own contract.
 */
export async function decorateComposedParkedOn<
  T extends { agentId: string } & Pick<DecoratedAgent, 'parkedOn' | 'parkedOnResolved'>,
>(
  agents: T[],
  deps: {
    listActiveComposedRoots?: typeof listActiveComposedRoots;
    loadTreeLeaves?: typeof loadTreeLeaves;
  } = {},
): Promise<T[]> {
  const listRoots = deps.listActiveComposedRoots ?? listActiveComposedRoots;
  const loadLeaves = deps.loadTreeLeaves ?? loadTreeLeaves;
  const candidates = agents.filter((a) => (a.parkedOn ?? []).some((k) => /^composed-root:\d+$/.test(k)));
  if (candidates.length === 0) return agents;
  await Promise.all(
    candidates.map(async (a) => {
      try {
        const rootsProbe = await withBoundedTimeout(listRoots(a.agentId), {
          fallback: [],
          timeoutMs: 1_500,
          label: 'leader-brief:composedParkedOn:roots',
        });
        const treeMap = new Map<
          number,
          { required: number; leaves: readonly string[]; expiresTs: string | null; onTimeout: TimeoutBehavior }
        >();
        await Promise.all(
          rootsProbe.value.map(async (root) => {
            const leavesProbe = await withBoundedTimeout(loadLeaves(root.id), {
              fallback: [],
              timeoutMs: 1_500,
              label: 'leader-brief:composedParkedOn:leaves',
            });
            treeMap.set(root.id, {
              required: root.requiredCount,
              leaves: leavesProbe.value.map((l) => l.eventKey),
              expiresTs: root.expiresTs,
              onTimeout: root.timeoutBehavior,
            });
          }),
        );
        a.parkedOnResolved = resolveComposedParkedOn(a.parkedOn ?? [], treeMap);
      } catch {
        /* best-effort — a resolution failure must never block the brief; parkedOn stays flat */
      }
    }),
  );
  return agents;
}

/**
 * PURE: scope the leader brief from the same presence-primary roster used by
 * fleet:status. Keeping this projection separate makes the membership parity
 * contract explicit: a live presence member is never dropped merely because
 * its assignment leg has no claim row yet.
 *
 * P-010: returns the CENSUS beside the rows. The membership filter here is
 * two-stage and only the second stage is discretionary — `fleetSlug === fleet`
 * decides who is on the roster at all, while the stale-idle cut decides who this
 * RESPONSE shows. Only the second is counted as `withheld`, because a member of
 * another fleet was never a candidate for this number; folding them in would make
 * `withheld` grow with unrelated fleets and read as mass concealment.
 */
export function selectLeaderBriefMembers(
  entries: readonly DecoratedAgent[],
  fleet: string,
  includeStale = false,
): { rows: DecoratedAgent[]; census: FleetPopulationCensus } {
  const ofThisFleet = entries.filter((entry) => entry.fleetSlug === fleet);
  return selectFleetPopulation(
    ofThisFleet,
    (entry) => includeStale || entry.claims.length > 0 || entry.alive,
    {
      population: `member(s) of fleet '${fleet}'`,
      basis:
        'A row is on the roster if presence records it in this fleet; it is shown here if it holds ' +
        'a claim or is alive (heartbeat-fresh), or unconditionally under include_stale.',
      withheldReason:
        'idle AND not heartbeat-fresh (stale-idle) — note this hides members precisely when they ' +
        'are dying, which is when the count matters most',
      reveal:
        'coord:presence { owner: "<agentId>" } (targeted stale-row lookup; broad stale-roster reads are unsupported)',
    },
    // EI-21550192883916303: the filter above keeps on `alive` (heartbeat
    // FRESHNESS), so the resulting total says nothing about how many members are
    // actually taking turns. These rows arrive already decorated, so the
    // composition is derived in the same pass as the filter.
    (entry) => entry.sessionState ?? null,
  );
}

/**
 * Reconcile a visible member's parked/wakeable projection with the psu-host
 * liveness authority. A dead host can leave a fresh heartbeat and inbox-wake
 * await behind, which otherwise makes leader-brief report a dead owner as
 * parked/wakeable. Nursery cups remain governed by their nursery state.
 */
export function reconcilePsuHostLiveness<T extends DecoratedAgent>(
  agents: T[],
  agentRoles: ReadonlyMap<string, string | null>,
  findHost: (ownerId: string) => unknown | null = findLiveHost,
): T[] {
  // Unification P-005: the rule itself now lives in the shared liveness
  // oracle (applyPsuHostAuthority) so it is no longer leader-brief-private —
  // any surface whose cohort is known-psu-hosted applies the SAME authority.
  // A role of `su` alone is not enough to establish that cohort: headless su
  // members also carry that role and legitimately have no local psu-pty host.
  // Match fleet:status's existing tty gate so a headless member cannot be
  // rewritten to ended merely because this operator cannot inject a terminal.
  const visibleRoles = new Map<string, string | null>();
  for (const agent of agents) {
    const role = agentRoles.get(agent.agentId);
    if (agent.tty != null && role != null && role !== 'cup') {
      visibleRoles.set(agent.agentId, role);
    }
  }
  return applyPsuHostAuthority(agents, visibleRoles, findHost);
}

/** PURE: exported for direct unit-testing (no PG/DI ceremony needed).
 *  `claimableCount` (EI-18681259560385029) is the fleet-wide live claimable total threaded
 *  into the per-member bench suggestion; `null`/omitted reads as UNKNOWN, never as 0. */
export function projectMember(
  a: DecoratedAgent,
  nowMs: number,
  claimableCount?: number | null,
  /** EI-18689489507862177: pre-floor match + per-floor exclusions, so the bench
   *  suggestion can tell a GATED lane from a drained one. Absent = not read. */
  laneGating?: { matchedByFilter: number; excluded?: Record<string, number> } | null,
  /** EI-18703234178947959: the fleet's own control_state is winding-down (owner-paused),
   *  so an idle member is compliant and carries no bench suggestion. Absent = not paused. */
  fleetPaused?: boolean | null,
  /** EI-19313376980892266: this member's authoritative concurrency verdict from the shared
   *  oracle (work_items.taken_by), NOT the presence layer's `load`. Absent = not read on
   *  this call, which suppresses nothing. */
  concurrency?: { blocked: boolean; activeClaims: number; heldIds: string[] } | null,
  /** WI-37161: the live shared-inference-pool verdict — see computeBenchSuggestion's
   *  `poolCapacity` param. Absent = not read on this call, which suppresses nothing. */
  poolCapacity?: PoolDegradedState | null,
  /** EI-21548894457555139: a tool call this member is INSIDE right now, from the
   *  operator's in-flight registry. Absent = nothing observed (which is NOT proof of
   *  idleness — the registry is process-local; see in-flight-calls.ts). */
  longCallInFlight?: { tool: string; ageSec: number } | null,
  /** P-009: this member's latest STRANDED containment from the task ledger. Absent = not
   *  read on this call (or never stranded) — which, like every other optional leg here,
   *  suppresses nothing and must not be read as "recovery succeeded". */
  recovery?: LeaderBriefMember['recovery'] | null,
  /** D-007: exception-only repeated-recovery state from the shared reader. */
  repeatedRecovery?: RepeatedRecoveryAlert | null,
): LeaderBriefMember {
  const lastMs = a.lastToolCallAt ? Date.parse(a.lastToolCallAt) : NaN;
  const prodMs = a.productiveToolCallAt ? Date.parse(a.productiveToolCallAt) : NaN;
  const lastToolCallAgeMs = Number.isFinite(lastMs) ? Math.max(0, nowMs - lastMs) : null;
  const productiveToolCallAgeMs = Number.isFinite(prodMs) ? Math.max(0, nowMs - prodMs) : null;
  // EI-19931924184335892: `a.stalled` is the raw per-CLAIM rollup (any held claim
  // with no last_progress_at/taken_at progress in >10min — see the fleet_assignment
  // view) — a claim-progress-checkpoint signal, NOT a liveness signal. It is already
  // suppressed by decorateLoopMonitorStates when the member's engine loop reports
  // itself healthy, but that suppression is contingent on the LOOP's own (separately
  // flaky — WI-6639) self-assessment, so it can miss. A fresh real tool call
  // (`lastToolCallAgeMs` within the same VERDICT_SPEAKING_FRESH_MS window this file
  // already uses everywhere else to mean "really working right now" — see
  // deriveMemberVerdict's `speaking` leg) is a STRONGER, more direct liveness proof
  // than either signal, so it overrides the same way here: a leader reading this row
  // must never see `stalled:true` beside a lastToolCallAgeMs that itself proves the
  // opposite. Live incident: sessionState:'recorded' (a LIVE-but-not-wake-dispatchable
  // state, not a "not-live" verdict as it was misread) + stalled:true +
  // lastToolCallAgeMs:~53000 led a leader to force-release a claim the holder closed,
  // with a committed evidenced fix, 8 minutes later.
  const speakingNow = lastToolCallAgeMs != null && lastToolCallAgeMs <= VERDICT_SPEAKING_FRESH_MS;
  const intentAttention = computeIntentAttention(a);
  const claimHealth = Object.fromEntries(
    a.claims
      .filter((claim) => claim.type === 'work-item' && claim.id && claim.claimHealth)
      .map((claim) => [claim.id as string, claim.claimHealth as ClaimHealth]),
  );
  return {
    agentId: a.agentId,
    label: a.label,
    fleetRole: a.fleetRole ?? null,
    intentAgeSec: a.intentAgeSec ?? null,
    intentStale: a.intentStale ?? null,
    intentDivergent: a.intentDivergent ?? null,
    ...(intentAttention ? { intentAttention } : {}),
    sessionState: a.sessionState ?? null,
    wakeable: a.wakeable ?? null,
    verdict: a.verdict ?? null,
    wakeMode: a.wakeMode === 'auto' || a.wakeMode === 'manual' ? a.wakeMode : null,
    monitorState: a.monitorState ?? null,
    nextFireAt: a.nextFireAt ?? null,
    loopMode: a.loopMode ?? null,
    ...(a.lifecycleBackoff ? { throttled: a.lifecycleBackoff } : {}),
    lastToolCallAgeMs,
    productiveToolCallAgeMs,
    doing: a.doing,
    workItemIds: a.claims.filter((claim) => claim.type === 'work-item' && claim.id).map((claim) => claim.id as string),
    ...(Object.keys(claimHealth).length > 0 ? { claimHealth } : {}),
    queuedCount: a.queued.length,
    load: a.load,
    stalled: a.stalled === true && !speakingNow,
    contextPressure: a.contextPressure ?? null,
    contextPressureAgeSec: a.contextPressureAgeSec ?? null,
    ...(a.coordHook ? { coordHook: a.coordHook } : {}),
    ...(a.unanswered ? { unanswered: a.unanswered } : {}),
    ...(a.directiveActuation ? { directiveActuation: a.directiveActuation } : {}),
    ...(() => {
      // EI-18732218464905145: prefer the composed-collapsed view when one was
      // resolved; fall back to the raw flat list (unresolved / non-composed /
      // resolution-failed) exactly as before this fix.
      const parked = a.parkedOnResolved ?? a.parkedOn;
      return parked && parked.length > 0 ? { parkedOn: parked } : {};
    })(),
    ...(a.verifiedWaitTakeovers && a.verifiedWaitTakeovers.length > 0
      ? { verifiedWaitTakeovers: a.verifiedWaitTakeovers }
      : {}),
    ...(() => {
      const suggestion = computeBenchSuggestion(
        {
          ...a,
          lastToolCallAgeMs,
          longCallInFlight,
          claimHealth: Object.values(claimHealth),
        },
        claimableCount,
        laneGating,
        fleetPaused,
        concurrency,
        poolCapacity,
      );
      return suggestion ? { benchSuggestion: suggestion } : {};
    })(),
    ...(computeDormantAlert({ ...a, longCallInFlight }, fleetPaused) ? { dormant: true } : {}),
    ...(() => {
      const stalledItem = computeStalledItemRotation(
        { agentId: a.agentId, sessionState: a.sessionState ?? null, claims: a.claims, longCallInFlight },
        nowMs,
        claimableCount,
        fleetPaused,
      );
      return stalledItem ? { stalledItem } : {};
    })(),
    ...(longCallInFlight ? { longCallInFlight } : {}),
    ...(computeSpinningAlert({ ...a, lastToolCallAgeMs, productiveToolCallAgeMs }, fleetPaused)
      ? { spinning: true }
      : {}),
    ...(recovery ? { recovery } : {}),
    ...(repeatedRecovery ? { repeatedRecovery } : {}),
  };
}

export default defineTool({
  name: 'fleet:leader-brief',
  profile: 'engineer',
  description:
    'Leader health brief for one fleet (yours by default). Per member: ' +
    'sessionState, `wakeable`, `verdict`, wakeMode, lastToolCallAgeMs, ' +
    'claims (doing/ids/queue/load), loop+nextFireAt, stalled, unanswered, contextPressure, ' +
    'parkedOn/resolved, benchSuggestion(s), dormant, spinning, ' +
    'throttled (provider-wall backoff; see `throttled.until`/`.reason`), ' +
    'unownedCriticals + unownedCriticalsFederated + abandonedUnclaimed.',
  guidance: {
    when:
      'AFTER a wake: "who is working / stuck / unanswered / about to compact across MY fleet". ' +
      'PARK, do not poll: events:await the fleet:*:<slug> keys (events:catalog) + ' +
      'work-item:claimable; loop:arm is then a LONG fallback heartbeat (15m+), never the ' +
      "monitor. Folded into coord:orient { mode:'monitor' }. " +
      'Spec: agent-insights/leading-a-fleet-without-polling.',
    notWhen:
      'A placement read over the WHOLE roster (fleet:assignments), ' +
      "or a member's message history (coord:inbox { agent }).",
    chaining:
      'A stalled/dead member → fleet:kill + relaunch, or a directed coord:send nudge. A nonzero ' +
      '`unanswered` → coord:send a follow-up or coord:catch-up. `benchSuggestion` set → ' +
      'fleet:bench onto the blocked-on gate; `dormant:true` → wake, never bench. ' +
      '`spinning:true` → coord:send{wake:"required"}. ' +
      'Nonzero `unownedCriticals`/`abandonedUnclaimed` → CLAIM it (release=no-op); the ' +
      '`…Federated` sibling is remote + unclaimable (WI-6846). ' +
      'Every `*Alert` ships `*AlertFalsifier` — RUN its `check` before acting; it confirms or ' +
      'KILLS the alert.',
    // Not counted against the P-011 prompt-weight budget (description + when/notWhen/
    // chaining are) — response documentation belongs here, demand-loaded via tools:find.
    returns:
      '`blockedAt` — READ IT FIRST. The arbitrated answer to "is my fleet blocked, and at ' +
      'WHICH layer": one of fleet-paused | inference-pool | spec-scope | claim-floors | ' +
      'members, with a single `remedy`, the `subordinate` alerts it overrules, and a ' +
      '`falsifier`. Absent ⇒ no layer is blocking (every member working), NOT "unknown". ' +
      'It exists because the `*Alert` booleans in `summary` are flat and CO-FIRE: a starved ' +
      'fleet trips several at once and they prescribe opposite acts (measured 2026-08-09 — ' +
      'the brief said "wake them" while fleet:capacity said "place conservatively"; both ' +
      'true). The layers are a physical dependency chain, not a severity ranking — each ' +
      "lower layer's evidence is measured THROUGH the ones above it, so a member starved of " +
      'inference reads as idle at every layer below. At `inference-pool` the flat advice ' +
      'inverts: a wake adds another request behind the same congestion and makes it WORSE ' +
      '(WI-37161). `members` is the ONLY layer whose remedy is a wake, and when the pool ' +
      'could not be read it says so rather than silently promoting itself.',
  },
  capability: 'work_items:read',
  // The default full response is intentionally rich, but the direct MCP result
  // door is smaller than a fleet-wide diagnostic. The domain shaper preserves
  // blockedAt + aggregate health + bounded intervention rows before the door can
  // cut JSON in the middle of the envelope. Explicit payloadTier:'full' remains
  // the unshaped escape hatch for programmatic/narrow callers.
  shape: {
    standard: (data) => shapeLeaderBrief(data, 'standard'),
    trimmed: (data) => shapeLeaderBrief(data, 'trimmed'),
    // AUDITED 2026-09-16 (WI-2145871). `shapeLeaderBrief` has TWO disjoint
    // emission paths, and this check can only ever exercise the first: five
    // `buildProjection` attempts, then — ONLY once all five exceed
    // LEADER_BRIEF_SHAPER_BUDGET_CHARS — a separately hand-built `emergency`
    // accumulator with a largely DIFFERENT key set. The envelope the check
    // synthesises is a few hundred bytes, so it always returns on attempt 1.
    // A key pinned on the strength of the normal path alone would therefore go
    // GREEN while production drops it at the budget ceiling: worse than no pin,
    // because the next reader counts it as guarded.
    //
    // So `preserve` is the INTERSECTION of what BOTH paths emit
    // UNCONDITIONALLY: `ok` (a literal in each initialiser) and
    // `leaderBriefProjection` (assigned unconditionally at the end of
    // buildProjection, and a literal in the emergency object). Both are written
    // by explicit assignment into a mutative accumulator — never spread — so the
    // row-vacuity sentinel cannot leak in and the pin has real teeth.
    //
    // Deliberately NOT pinned: `summary`/`blockedAt`/`fleetMetrics`/`campaign`
    // (conditional on the source key in both paths), and `specRevision`/`delta`/
    // `deltaSummary`/`idleCauses` — emitted by buildProjection but ABSENT from
    // the emergency tier, i.e. exactly the false-pin class above. `specRevision`
    // is the standing negative control in
    // .papercusp/scratch/leader-brief-contract-teeth.mts, which proves the
    // budget path is reached AND that a normal-path-only key really is dropped.
    //
    // `rows: 'members'` names the row family only to satisfy the synthetic
    // envelope: `returns` carries no `Each row: {…}` block, so `required` is
    // empty and the row axis is skipped. This is a PRESERVE-ONLY contract.
    contract: { rows: 'members', preserve: ['ok', 'leaderBriefProjection'] },
  },
  payloadTierCeilingChars: LEADER_BRIEF_SHAPER_BUDGET_CHARS,
  requirePrincipal: false,
  // EI-20192040030675541: this supervision read owns its individual
  // workspace-scoped reads and never touches ctx.tx. Keeping the dispatcher's
  // ambient transaction open across the roster/decorations/diagnostic awaits
  // pins an org-app pool slot and can leave the leader blind behind the 45s
  // acquisition deadline when the fleet is saturated.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    fleet: z
      .string()
      .max(120)
      .optional()
      .describe(
        "Fleet slug to brief. Defaults to the caller's sole durable led fleet; if the caller leads multiple fleets, pass this explicitly to avoid an ambiguous target. With no durable leadership, the current presence membership is a fallback (launch environment is failure-only).",
      ),
    harness: z.string().max(80).optional(),
    workspace: z.string().max(120).optional(),
    include_stale: z
      .boolean()
      .optional()
      .describe('Also include members with no claims and a stale heartbeat (default false — dead/idle noise).'),
    include_mermaid: z
      .boolean()
      .optional()
      .describe(
        'P-008: include a fenced Mermaid dependency graph for human review. Off by default; it is rendered from the SAME SQL result as dependencyBottlenecks. Use payloadTier:"full" for a large graph because bounded monitor tiers never clip invalid partial Mermaid.',
      ),
    unowned_critical_age_hours: z
      .number()
      .min(0)
      .max(168)
      .optional()
      .describe(
        'WI-5213: hours an unassigned critical must age before it surfaces here (0 = immediate; max 168). Default 4.',
      ),
    orphan_min_age_minutes: z
      .number()
      .min(0)
      .max(1440)
      .optional()
      .describe('Minutes an orphaned in-flight item must sit before it surfaces here. Default 0.'),
    since: z
      .string()
      .max(40)
      .optional()
      .describe(
        'P-022: measure `delta` from this ISO timestamp instead of your last wake. The snapshot-only axes (pool factor, prior spec revision) have no history to re-read at an arbitrary time and stay unavailable — they are never back-filled from a boundary they did not observe.',
      ),
  }),
  // Keep the rich supervision envelope available as structured content while
  // publishing the stable roots used by callers and guidance. The passthrough
  // is intentional: leader-brief grows diagnostic fields over time, and a
  // second hand-maintained exhaustive schema would recreate the drift this
  // contract is meant to prevent.
  result: z
    .object({
      ok: z.boolean().optional(),
      degraded: z.boolean().optional(),
      degradedLegs: z.array(z.string()).optional(),
      error: z.string().optional(),
      self: z.unknown().optional(),
      notLeader: z.unknown().optional(),
      leadershipClaimed: z.unknown().optional(),
      leaderControl: z.unknown().optional(),
      agentObligations: z.unknown().optional(),
      ownerDirectives: z.unknown().optional(),
      monitoringBlindAdvisory: z.unknown().optional(),
      blockedAt: z.unknown().optional(),
      summary: z.unknown().optional(),
      launchWorkerAttestation: z.unknown().optional(),
      dependencyBottlenecks: z.unknown().optional(),
      leaderBlockerStall: z.unknown().optional(),
      delta: z.unknown().optional(),
      deltaSummary: z.string().optional(),
      campaign: z.unknown().optional(),
      fleetMetrics: z.unknown().optional(),
      announcedGates: z.unknown().optional(),
      idleCauses: z.unknown().optional(),
      reservation: z.unknown().optional(),
      memberVerdicts: z.unknown().optional(),
      benchSuggestions: z.unknown().optional(),
      intentAttention: z.unknown().optional(),
      members: z.array(z.unknown()).optional(),
      // The bounded shaper emits truncation metadata (`{ total, shown }`),
      // while the emergency fallback emits the compact boolean `true`.
      // Keep both representations in the registered result contract so the
      // MCP output validator agrees with the runtime's two paths.
      membersTruncated: z
        .union([
          z.boolean(),
          z
            .object({
              total: z.number().int().nonnegative(),
              shown: z.number().int().nonnegative(),
            })
            .passthrough(),
        ])
        .optional(),
      membersReturned: z.number().int().nonnegative().optional(),
      membersHint: z.string().optional(),
      unownedCriticals: z.array(z.unknown()).optional(),
      unownedCriticalsFederated: z.array(z.unknown()).optional(),
      unownedCriticalsFederatedNote: z.string().optional(),
      abandonedUnclaimed: z.array(z.unknown()).optional(),
      abandonedUnclaimedAction: z.string().optional(),
      admissionBlocked: z.array(z.unknown()).optional(),
      admissionBlockedAction: z.string().optional(),
      customInvariants: z.unknown().optional(),
      customInvariantAlertReason: z.string().optional(),
      fleetPausedReason: z.string().optional(),
      specFilter: z.unknown().optional(),
      specRevision: z.unknown().optional(),
      specUpdatedBy: z.string().nullable().optional(),
      specUpdatedAt: z.unknown().optional(),
      harnessWidePool: z.unknown().optional(),
      specMatched: z.unknown().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    let actorWorkspace: string | null = null;
    let ownerId: string | undefined;
    // P-004/D-096: kept beyond the destructure because takeFleetLeadership needs
    // the whole identity (it heartbeats presence to label the new leader's row).
    let agentIdentity: AgentIdentity | undefined;
    try {
      const identity = resolveAgentIdentity(ctx);
      agentIdentity = identity;
      actorWorkspace = identity.workspaceId ?? null;
      ownerId = identity.ownerId;
    } catch {
      actorWorkspace = null;
    }
    const brief = await runLeaderBriefWithinDeadline(
      () =>
        buildLeaderBrief(args, {
          agentIdentity,
          ownerId,
          actorWorkspace,
          self: resolveSelfRef(ctx),
          // An AGENT calling its own brief is the case leadership bookkeeping was
          // written for: a fleet nobody leads is how a whole fleet dies unnoticed,
          // so the caller is installed when the seat is empty.
          allowLeadershipWrites: true,
          resolveCallerMembership: true,
        }),
      {
        data: {
          ok: false,
          error: 'leader_brief_deadline',
          hint:
            'The supervision read exceeded its 25s server budget and returned before the MCP client deadline. ' +
            'Retry once; persistent deadlines mean a leader-brief dependency is unhealthy, not that the fleet is empty.',
        },
      },
    );
    return bindLeaderBriefResult(brief, { fleet: args.fleet, harness: args.harness,
      workspace: args.workspace ?? actorWorkspace }, ctx.metadata);
  },
});

/**
 * Who the brief is computed AS, and what that caller is permitted to do.
 *
 * Extracted (popup-agent-state-coverage-2026-08-18 P-002) so a READ-ONLY viewer
 * — the HUD conversation popup, showing a leader what that leader itself reads —
 * can compute the identical brief without inheriting the tool handler's two
 * agent-shaped behaviours, both of which are wrong for a viewer and neither of
 * which a `payloadTier`/args knob could have turned off:
 *
 *  1. LEADERSHIP WRITES. `fleet:leader-brief` deliberately CLAIMS an empty
 *     leader seat (`takeFleetLeadership`) and refreshes the control row
 *     (`ensureFleetLeaderControl`). Correct for an agent; catastrophic for a
 *     UI read — opening a popup would install the human's session as leader of
 *     someone else's fleet, demoting whoever held it. `allowLeadershipWrites:
 *     false` skips BOTH; the `notLeader` NOTICE is still produced, because that
 *     is a read.
 *  2. AMBIENT FLEET RESOLUTION. The handler falls back to the CALLER's presence
 *     membership (and then the launch environment) when `fleet` is omitted. In
 *     the operator process that resolves to whatever fleet the operator itself
 *     was launched into — a real answer to the wrong question. A viewer passes
 *     `resolveCallerMembership: false` and MUST name the fleet.
 *
 * Everything else is identical by construction: this is the same function, not
 * a parallel reimplementation, so the popup cannot drift from what the agent is
 * told (the whole point of surfacing it).
 */
export interface LeaderBriefCaller {
  /** Full identity — required only for the leadership CLAIM (it heartbeats
   *  presence to label the new leader's row). Undefined for a viewer. */
  agentIdentity?: AgentIdentity;
  /**
   * The owner the brief is computed FOR. This is NOT bookkeeping: it scopes
   * `directiveActuation` (P-013 — the ledger's verdict on YOUR directives to
   * each member), so a viewer passes the VIEWED LEADER's ownerId to see what
   * that leader sees, not its own.
   */
  ownerId?: string;
  /** The caller's workspace, or null. Normalized through
   *  `resolveConcreteWorkspaceId` with `args.workspace` exactly as before. */
  actorWorkspace: string | null;
  /** Marks the caller's own row `isSelf`. Undefined ⇒ no row is marked. */
  self?: SelfRef;
  /** See LeaderBriefCaller's docblock §1. */
  allowLeadershipWrites: boolean;
  /** See LeaderBriefCaller's docblock §2. */
  resolveCallerMembership: boolean;
}

export type LeaderBriefFleetTarget =
  | { kind: 'explicit' | 'led' | 'presence'; fleet: string }
  | { kind: 'ambiguous'; fleets: string[] }
  | { kind: 'none' };

/**
 * Resolve the omitted-fleet target for an agent's own leader brief.
 *
 * Presence carries one latest-joined fleet label, while the registry records
 * every fleet an owner leads. A single durable leadership therefore wins over
 * presence. When several durable led fleets exist, choosing one from the
 * single presence label would still be an implicit target choice; callers must
 * pass `{ fleet }` to make that choice explicit.
 *
 * Read-only viewers deliberately do not get this ambient resolution. Their
 * caller bag sets `resolveCallerMembership: false` and the popup supplies an
 * explicit fleet, so an omitted fleet remains a no-target result.
 */
export function resolveLeaderBriefFleet(input: {
  explicitFleet?: string;
  presenceFleet: string | null;
  ledFleets: readonly string[];
  resolveCallerMembership: boolean;
}): LeaderBriefFleetTarget {
  if (input.explicitFleet !== undefined) {
    return input.explicitFleet ? { kind: 'explicit', fleet: input.explicitFleet } : { kind: 'none' };
  }
  if (!input.resolveCallerMembership) return { kind: 'none' };

  const ledFleets = [...new Set(input.ledFleets.filter((fleet) => Boolean(fleet)))];
  if (ledFleets.length === 1) return { kind: 'led', fleet: ledFleets[0] };
  if (ledFleets.length > 1) return { kind: 'ambiguous', fleets: ledFleets };
  return input.presenceFleet ? { kind: 'presence', fleet: input.presenceFleet } : { kind: 'none' };
}

/**
 * The refresh branch is a write hidden inside a health read. A typed fleet
 * wind-down is a durable stop boundary, so even the registered leader must not
 * be repaired back into an active loop by the next orient/leader-brief read.
 */
export function shouldRefreshLeaderControlForBrief(input: {
  disposition: LeadershipDisposition;
  allowLeadershipWrites: boolean;
  hasFleetRecord: boolean;
  ownerId?: string;
  controlState?: FleetControlState | null;
}): boolean {
  return (
    input.disposition.kind === 'is-leader' &&
    input.allowLeadershipWrites &&
    input.hasFleetRecord &&
    Boolean(input.ownerId) &&
    shouldMaintainFleetLeaderControl(input.controlState)
  );
}

/**
 * Recover the authority needed to refresh a leader's control watches after the
 * bounded fleet-record read degrades.
 *
 * `getFleet` uses `undefined` as its timeout/error fallback. That value must
 * never be interpreted as a real "no registered leader" row: doing so would
 * suppress repair for the actual leader, while allowing the exact-await
 * advisory below to report a false blind state. The independent
 * `listFleetsLedBy` query can positively establish only the current caller's
 * leadership; it cannot establish a vacant seat, so it is deliberately never
 * used to authorize takeover. A missing/failed corroboration remains null and
 * all leadership writes stay disabled.
 */
export async function recoverFleetRecordForLeaderControl(input: {
  workspaceId: string;
  fleetSlug: string;
  ownerId?: string;
  allowLeadershipWrites: boolean;
  fleetRecordResult: { value: AgentFleetRecord | null | undefined; degraded: boolean };
  listLedFleets?: typeof listFleetsLedBy;
  timeoutMs?: number;
}): Promise<AgentFleetRecord | null> {
  if (input.fleetRecordResult.value !== undefined) return input.fleetRecordResult.value;
  if (!input.fleetRecordResult.degraded || !input.allowLeadershipWrites || !input.ownerId) return null;

  const result = await withBoundedTimeout(
    () => (input.listLedFleets ?? listFleetsLedBy)(input.workspaceId, input.ownerId!),
    {
      fallback: [] as AgentFleetRecord[],
      timeoutMs: input.timeoutMs ?? LEADER_BRIEF_HEADCOUNT_TIMEOUT_MS,
      label: 'leader-brief:degraded-fleet-record-recovery',
    },
  );
  if (result.degraded) return null;
  return (
    result.value.find(
      (record) => record.fleetSlug === input.fleetSlug && record.leaderOwnerId === input.ownerId,
    ) ?? null
  );
}

/**
 * The READ half of `fleet:leader-brief` — every leg from roster through
 * decorations, alerts and the fleet-block verdict. Pure with respect to the
 * fleet registry when `allowLeadershipWrites` is false.
 */
export async function buildLeaderBrief(
  args: {
    fleet?: string;
    harness?: string;
    workspace?: string;
    include_stale?: boolean;
    include_mermaid?: boolean;
    unowned_critical_age_hours?: number;
    orphan_min_age_minutes?: number;
    since?: string;
  },
  caller: LeaderBriefCaller,
) {
  const { agentIdentity, ownerId, actorWorkspace, self, allowLeadershipWrites } = caller;
  // Resolve the workspace before the omitted-fleet lookup. `listFleetsLedBy`
  // is the durable per-fleet leadership authority, and unlike presence it can
  // answer for every fleet this owner leads.
  const workspaceId = resolveConcreteWorkspaceId(args.workspace, actorWorkspace);
  const membership = caller.resolveCallerMembership
    ? await boundedLeaderBriefRead('presence-fleet', () => resolvePresenceFleet(ownerId, deriveFleetMembership()), {
        fleetSlug: null as string | null,
        fleetRole: null,
      })
    : { fleetSlug: null as string | null, fleetRole: null };
  const ledFleets =
    args.fleet === undefined && caller.resolveCallerMembership && ownerId
      ? await boundedLeaderBriefRead(
          'led-fleets',
          async () => (await listFleetsLedBy(workspaceId, ownerId)).map((record) => record.fleetSlug),
          [],
        )
      : [];
  const target = resolveLeaderBriefFleet({
    explicitFleet: args.fleet,
    presenceFleet: membership.fleetSlug,
    ledFleets,
    resolveCallerMembership: caller.resolveCallerMembership,
  });
  if (target.kind === 'ambiguous') {
    return {
      data: {
        ok: false,
        error: 'ambiguous_fleet',
        fleets: target.fleets,
        hint:
          'Multiple fleets are led by this agent and its current presence does not identify one of them. ' +
          'Pass { fleet: "<slug>" } explicitly, or use fleet:assignments for a named fleet.',
      },
    };
  }
  const fleet = target.kind === 'none' ? null : target.fleet;
  if (!fleet) {
    return {
      data: {
        ok: false,
        error: 'no_fleet',
        hint:
          'No fleet resolvable from current presence or launch context and no { fleet } ' +
          'was passed. Pass { fleet: "<slug>" } explicitly, or use fleet:assignments for the ' +
          'whole-workspace roster.',
      },
    };
  }
  // EI-13820: ctx.workspaceId is the literal '*' sentinel for an unscoped su
  // session (EI-9013) — normalize through resolveConcreteWorkspaceId so '*'
  // never leaks into the roster/presence workspace filter (see the identical
  // fix + rationale in fleet:assignments' handler).
  // fleet:status's presence-primary roster is the membership authority. The
  // old claim-primary read omitted live idle members whose assignment view had
  // no row, so leader-brief and fleet:status reported different rosters.
  const rosterResult = await boundedLeaderBriefRead<ListFleetRosterResult>(
    'roster',
    () => listFleetRosterDiagnosed({ fleetSlug: fleet, workspaceId }),
    {
      entries: [],
      degradedLegs: ['presence', 'tier1', 'assignments', 'wakeability', 'recorded', 'selfwake'],
    },
    LEADER_BRIEF_HEADCOUNT_TIMEOUT_MS,
  );
  const [headcountTargetResult, headcountCurrentResult, fleetRecordResult] = await runLeaderBriefReads([
    () =>
      withBoundedTimeout(getFleetHeadcountTarget(workspaceId, fleet), {
        fallback: undefined,
        timeoutMs: LEADER_BRIEF_HEADCOUNT_TIMEOUT_MS,
        label: 'leader-brief:headcountTarget',
      }),
    () =>
      withBoundedTimeout(liveFleetMemberIds(fleet, workspaceId, 'launch'), {
        fallback: null,
        timeoutMs: LEADER_BRIEF_HEADCOUNT_TIMEOUT_MS,
        label: 'leader-brief:headcountCurrent',
      }),
    () =>
      withBoundedTimeout(getFleet(workspaceId, fleet), {
        fallback: undefined,
        timeoutMs: LEADER_BRIEF_HEADCOUNT_TIMEOUT_MS,
        label: 'leader-brief:fleetRecord',
      }),
  ] as const);
  // WI-2034624: `current` is attested from recent agent-origin execution over
  // the canonical live roster — never from the current launch transaction's
  // worker-ready set, which excludes every member a prior transaction or a
  // carry-respawn created. P-007 / R-17: the count goes through the SAME silence
  // seam as the headcount governor and `fleet:status` (readFleetMemberSilence), so
  // a member silent past the threshold — heartbeats only, no pending declared
  // await, fleet not paused — is excluded here exactly as the writer excludes it,
  // and is NAMED in `summary.silentMembers` instead of vanishing. Deliberately a
  // SEPARATE read from the WI-583276 collapse leg below (that one keys on
  // `tool_invocations` alone; this one unions the MCP and native tool ledgers).
  // A failed read stays UNKNOWN.
  const headcountSilenceRead = await withBoundedTimeout(
    headcountCurrentResult.value == null
      ? Promise.resolve(null)
      : readFleetMemberSilence(headcountCurrentResult.value, {
          fleetPaused:
            fleetRecordResult.value == null ? null : fleetRecordResult.value.controlState === 'winding-down',
        }),
    {
      fallback: null,
      timeoutMs: LEADER_BRIEF_HEADCOUNT_TIMEOUT_MS,
      label: 'leader-brief:headcountExecuting',
    },
  );
  const headcountExecutingRead = { value: countedMemberSet(headcountSilenceRead.value) };
  // A degraded `getFleet` result is not evidence of a vacant leader seat.
  // Corroborate only positive self-leadership before repairing control; the
  // recovery helper intentionally cannot authorize `takeFleetLeadership`.
  const controlFleetRecord = await recoverFleetRecordForLeaderControl({
    workspaceId,
    fleetSlug: fleet,
    ownerId,
    allowLeadershipWrites,
    fleetRecordResult,
  });
  const fleetRecord =
    fleetRecordResult.value !== undefined ? fleetRecordResult.value : controlFleetRecord;
  const fleetRecordReadAvailable = fleetRecordResult.value !== undefined || controlFleetRecord !== null;
  // P-005 / D-030: the governor's own eligibility facts, so `headcount.held` says
  // whether anything will actually restore this fleet. A failed flag read stays
  // null (unknown), never a fabricated OFF; an unread fleet record supplies no
  // governance at all, so `held` reads null rather than guessing.
  const governorFlagRead = await withBoundedTimeout(
    getFlag(FLAGS.FLEET_HEADCOUNT_GOVERNOR, 'system').then((on): boolean | null => on === true),
    {
      fallback: null,
      timeoutMs: LEADER_BRIEF_HEADCOUNT_TIMEOUT_MS,
      label: 'leader-brief:headcountGovernorFlag',
    },
  );
  const headcount = projectFleetHeadcountState(
    headcountTargetResult.value,
    fleetRecordReadAvailable ? (fleetRecord?.lastLaunchTransaction ?? null) : undefined,
    headcountCurrentResult.value,
    headcountExecutingRead.value,
    {
      measuredAt: new Date().toISOString(),
      scope: {
        workspace: workspaceId,
        fleet,
        ...(args.harness ? { harness: args.harness } : {}),
      },
      ...(fleetRecordReadAvailable
        ? {
            governance: {
              governorFlagOn: governorFlagRead.value,
              controlState: fleetRecord?.controlState ?? null,
              leaderOwnerId: fleetRecord?.leaderOwnerId ?? null,
            },
          }
        : {}),
    },
  );
  const rosterEntries: DecoratedAgent[] = rosterResult.entries.map((entry) => ({
    ...entry,
    ...(entry.wakeMode === 'auto' || entry.wakeMode === 'manual'
      ? { wakeMode: entry.wakeMode }
      : { wakeMode: undefined }),
  }));
  // WI-583276: exact turn provenance is a separate bounded leg. A failed read
  // remains UNKNOWN; an empty Set is a measured zero only when the query
  // completed successfully.
  const agentOriginRead = await withBoundedTimeout(executingOwnersSince(rosterEntries.map((entry) => entry.agentId)), {
    fallback: null,
    timeoutMs: LEADER_BRIEF_HEADCOUNT_TIMEOUT_MS,
    label: 'leader-brief:agent-origin-calls',
  });
  const executionCollapseAlert = computeFleetExecutionCollapseAlert({
    roster: rosterEntries,
    agentOriginOwnerIds: agentOriginRead.value,
    telemetryDegraded: agentOriginRead.degraded || agentOriginRead.value == null,
    presenceDegraded: rosterResult.degradedLegs.includes('presence'),
    fleet,
  });
  // WI-41172 / P-010: compute from the UNFILTERED canonical roster before
  // selectLeaderBriefMembers drops stale-idle entries. Presence degradation is
  // in-band UNKNOWN; an assignments-only fallback must never become a verdict.
  const darkFleetAlert = computeDarkFleetAlert({
    roster: rosterEntries,
    presenceDegraded: rosterResult.degradedLegs.includes('presence'),
    fleet,
  });
  // ── P-004 / D-096: leadership self-claim ────────────────────────────────
  // Decided from `rosterEntries` — the UNFILTERED roster — and NOT from
  // `grouped` below, which drops idle members with a stale heartbeat unless
  // include_stale is set. A live-but-idle leader is routinely absent from the
  // filtered view, and reading that as "no leader" would seize leadership from
  // someone still working. The whole rule is in leadership-disposition.ts.
  let notLeader: NotLeaderNotice | undefined;
  let leadershipClaimed: AutoClaimedNotice | undefined;
  let leaderControl: LeaderControlOutcome | undefined;
  let fleetCreatedAtMs: number | null = null;
  let launchWorkerAttestation: LeaderBriefLaunchWorkerAttestation | undefined;
  try {
    // Reuse the bounded fleet-record read that supplied the headcount transaction.
    // A second read could cross a launch-transaction update and make the
    // attestation block disagree with `summary.headcount` in one response.
    fleetCreatedAtMs = fleetRecord?.createdAt ?? null;
    launchWorkerAttestation = compactLaunchWorkerAttestation(fleetRecord?.lastLaunchTransaction);
    const registeredLeader = controlFleetRecord?.leaderOwnerId ?? null;
    const leaderRow = registeredLeader ? rosterEntries.find((e) => e.agentId === registeredLeader) : undefined;
    const disposition = decideLeadershipDisposition({
      callerOwnerId: ownerId,
      registeredLeader,
      leaderSessionState: leaderRow?.sessionState,
    });
    if (disposition.kind === 'not-leader') {
      // A READ — the notice only reports who the registered leader is, so a
      // read-only viewer still gets it.
      notLeader = buildNotLeaderNotice(disposition, fleet);
    } else if (
      disposition.kind === 'auto-claim' &&
      // P-002: a viewer never seizes a vacant leader seat. Without this a
      // human opening the popup would install their own session as leader of
      // a fleet they are merely looking at.
      allowLeadershipWrites &&
      fleetRecord &&
      agentIdentity &&
      ownerId &&
      shouldMaintainFleetLeaderControl(fleetRecord.controlState)
    ) {
      const out = await boundedLeaderBriefRead(
        'take-fleet-leadership',
        () =>
          takeFleetLeadership(workspaceId, fleetRecord, agentIdentity, ownerId, {
            harnessSlug: args.harness,
          }),
        null,
      );
      if (out) {
        leaderControl = out.control;
        leadershipClaimed = {
          claimed: true,
          reason: disposition.reason,
          previousLeader: out.previousLeader,
          notified: out.notified,
          note:
            disposition.reason === 'no-registered-leader'
              ? `'${fleet}' had NO registered leader; you are now installed as its leader. A fleet nobody leads is how a whole fleet dies unnoticed — you now own monitoring it.`
              : `The registered leader of '${fleet}' (${out.previousLeader}) is gone, so leadership passed to you. Nothing live was displaced.`,
        };
      }
    } else if (
      shouldRefreshLeaderControlForBrief({
        disposition,
        allowLeadershipWrites,
        hasFleetRecord: controlFleetRecord != null,
        ownerId,
        controlState: controlFleetRecord?.controlState,
      }) &&
      controlFleetRecord &&
      // Type-level only: the guard above already requires a defined ownerId
      // (`Boolean(input.ownerId)`), but it returns a plain boolean rather than a
      // type predicate, so it cannot NARROW `ownerId` (declared `string |
      // undefined`) for the write below. Restating it here is what lets
      // ensureFleetLeaderControl take its `string`. No behaviour change.
      ownerId != null
    ) {
      // Also a WRITE (it refreshes the leader's control row), so it is gated
      // too — a viewer reading a leader's brief must not touch that leader's
      // control state.
      leaderControl = await boundedLeaderBriefRead(
        'ensure-leader-control',
        () =>
          ensureFleetLeaderControl({
            workspaceId,
            ownerId,
            fleetSlug: fleet,
            harnessSlug: args.harness,
          }),
        undefined,
      );
    }
  } catch {
    /* best-effort: leadership bookkeeping must NEVER fail the health brief */
  }
  // P-015 / D-005: one profile-derived discovery advisory, read from the
  // existing event-await store after leader-control has had a chance to repair
  // the standing watches. No fleet metrics or populations are copied here.
  const monitoringBlindAdvisory = await boundedLeaderBriefRead(
    'monitoring-blind-advisory',
    () => readLeaderMonitoringBlindAdvisory(fleet),
    undefined,
  );
  // Reconcile liveness BEFORE selecting the population. A stale directed
  // wake can make a dead owner look `live` through recent agent_activity;
  // selecting first would bake that ghost into the census even after the
  // authoritative psu-host check marks the row ended.
  await boundedLeaderBriefRead(
    'reconcile-wakeability',
    () =>
      reconcileWakeability(
        rosterEntries,
        undefined,
        undefined,
        undefined,
        undefined,
        RECONCILE_WAKEABILITY_PRODUCTION_OPTIONS,
      ),
    rosterEntries,
  );
  // Missing host is a liveness signal only for known visible members. Keep
  // this best-effort so absent roles never reinterpret bootstrapping/remote
  // rows as desktop deaths.
  const presence = await boundedLeaderBriefRead<Awaited<ReturnType<typeof listPresence>>>(
    'presence-liveness',
    () => listPresence({ workspaceId }),
    [],
  );
  reconcilePsuHostLiveness(rosterEntries, new Map(presence.map((p) => [p.ownerId, p.agentRole] as const)));
  const { rows: grouped, census: memberCensus } = selectLeaderBriefMembers(rosterEntries, fleet, args.include_stale);
  await boundedLeaderBriefRead('decorate-parked-on', () => decorateParkedOn(grouped), grouped);
  // Keep the parked-on → loop → member-verdict dependency chain intact. The
  // remaining decorations are independent read-only overlays and are batched
  // below rather than paying their database latency serially.
  await boundedLeaderBriefRead('decorate-loop-monitor-states', () => decorateLoopMonitorStates(grouped), grouped);
  await boundedLeaderBriefRead('decorate-member-verdicts', () => decorateMemberVerdicts(grouped), grouped);
  await runBoundedLeaderBriefReads(
    [
      // EI-18732218464905145: collapse a composed-await park (root + leaf
      // sentinels) into ONE structured entry before projection — best-effort,
      // never blocks.
      () => decorateComposedParkedOn(grouped).catch(() => grouped),
      // EI-19307414464301772: the productive-only sibling of lastToolCallAt,
      // feeding computeSpinningAlert below — best-effort, never blocks.
      () => decorateProductiveToolCalls(grouped).catch(() => grouped),
      () => decorateContextPressure(grouped).catch(() => grouped),
      () => decorateUnansweredDirected(grouped).catch(() => grouped),
      // P-013: what the LEDGER says happened, beside what the member said.
      // Scoped to the caller's own directives — you are accountable for what
      // you instructed.
      () => decorateDirectiveActuation(grouped, ownerId).catch(() => grouped),
      () => decorateCoordDeafness(grouped).catch(() => grouped),
    ] as const,
    [grouped, grouped, grouped, grouped, grouped, grouped] as const,
    'decorations',
  );
  // P-005: a fired one-shot wait disappears from parkedOn, but its
  // authoritative stalled/absent verdict is durable. Surface that evidence
  // beside the member that must own the wake/takeover remedy.
  const [
    verifiedWaitTakeovers,
    unownedCriticalsAll,
    admissionBlockRead,
    orphanedInFlight,
    fleetLaneHealthRead,
    fleetPause,
    concurrencyByOwner,
    poolCapacity,
  ] = await runBoundedLeaderBriefReads(
    [
      () => listVerifiedWaitTakeoversForSubscribers(grouped.map((a) => a.agentId)).catch(() => []),
      // WI-5213: unowned criticals THIS fleet's claim spec would admit — read
      // failures already fail soft to [] inside readUnownedCriticalsForFleet.
      () =>
        readUnownedCriticalsForFleet({
          fleet,
          harness: args.harness,
          workspaceId,
          ageHours: args.unowned_critical_age_hours,
        }),
      // EI-18680302159738037: this fleet's refused member/item pairs. The
      // member verdict barrier above makes the live-id filter stable before
      // this independent read begins.
      () =>
        readFleetAdmissionBlocks(fleet, {
          harness: args.harness,
          liveMemberIds: grouped
            .filter((member) => member.alive !== false && member.verdict !== 'dead')
            .map((member) => member.agentId),
        }),
      () =>
        readOrphanedInFlightForFleet({
          fleet,
          harness: args.harness,
          workspaceId,
          minAgeMinutes: args.orphan_min_age_minutes,
        }),
      // EI-18681259560385029: read the fleet's LIVE claimable count before
      // projecting members; failures are UNKNOWN, never zero. EI-22687145239379284:
      // the issue aggregate may take ~20s, so the diagnosed reader receives this
      // leg's whole 750ms allowance and refuses to launch work that cannot fit it.
      () =>
        readLeaderBriefLaneHealth({
          fleet,
          harness: args.harness,
          workspaceId: actorWorkspace,
        }),
      // EI-18703234178947959: the fleet's own durable pause state. Fail-soft
      // to not-paused so a registry hiccup never silences a genuine alert.
      () =>
        (async (): Promise<{ paused: boolean; reason: string | null }> => {
          try {
            const { getFleet } = await import('../../agent-fleets-store');
            const rec = await getFleet(workspaceId, fleet);
            return rec?.controlState === 'winding-down'
              ? { paused: true, reason: rec.controlReason ?? null }
              : { paused: false, reason: null };
          } catch {
            return { paused: false, reason: null };
          }
        })(),
      // EI-19313376980892266: authoritative per-member concurrency, resolved
      // against this fleet's own spec limit and fail-soft to an empty map.
      () =>
        (async (): Promise<Map<string, { blocked: boolean; activeClaims: number; heldIds: string[] }>> => {
          try {
            const { readClaimConcurrencyBatch, getClaimSpecRecord, fleetSpecBeeKey } =
              await import('../../scheduler/claim-spec-store');
            const rec = await getClaimSpecRecord({
              cupId: fleetSpecBeeKey(fleet),
              workspaceId,
            }).catch(() => null);
            return await readClaimConcurrencyBatch({
              cupIds: grouped.map((a) => a.agentId),
              // actorWorkspace is string|null; the reader falls back to the
              // same default workspace when null.
              workspaceId: actorWorkspace ?? undefined,
              maxConcurrentClaims: rec?.spec.limits?.maxConcurrentClaims,
            });
          } catch {
            return new Map();
          }
        })(),
      // WI-37161 / EI-20243921934115652: resolve the shared inference pool for
      // this fleet's observed provider. The account/session read and pool
      // probe stay ordered internally, but are independent of other reads.
      () =>
        (async (): Promise<PoolDegradedState | null> => {
          try {
            const { advSessionsByCoordOwner } = await import('../../adv-sessions');
            const sessions = await advSessionsByCoordOwner();
            const capacityAgentByOwner = new Map(
              [...sessions].map(([ownerId, session]) => [ownerId, session.agent] as const),
            );
            const capacityProvider = fleetCapacityProviderForMembers(grouped, capacityAgentByOwner);
            return capacityProvider ? await readPoolDegradedState(capacityProvider) : null;
          } catch {
            return null;
          }
        })(),
    ] as const,
    [
      [] as VerifiedWaitTakeoverAlert[],
      [] as UnownedCriticalCandidate[],
      {
        available: false,
        blocks: null,
        reason: 'leader-brief optional admission-block read timed out or failed',
      } as FleetAdmissionBlockRead,
      [] as OrphanedInFlightCandidate[],
      leaderBriefLaneHealthUnavailable({ fleet, harness: args.harness }),
      { paused: false, reason: null },
      new Map<string, { blocked: boolean; activeClaims: number; heldIds: string[] }>(),
      null,
    ] as const,
    'optional-fleet-reads',
  );
  const fleetLaneHealth = fleetLaneHealthRead.laneHealth;
  const takeoversBySubscriber = new Map<string, VerifiedWaitTakeoverAlert[]>();
  for (const alert of verifiedWaitTakeovers) {
    const current = takeoversBySubscriber.get(alert.subscriberId) ?? [];
    current.push(alert);
    takeoversBySubscriber.set(alert.subscriberId, current);
  }
  for (const agent of grouped) {
    agent.verifiedWaitTakeovers = takeoversBySubscriber.get(agent.agentId) ?? [];
  }
  const { blocks: admissionBlocked, count: admissionBlockedCount } = projectFleetAdmissionBlockRead(admissionBlockRead);
  // WI-6846: a majority-remote-origin backlog reads as urgent unowned work a
  // leader is expected to act on, when in fact `origin:'remote'` rows are
  // structurally un-actionable here (cannot claim — the claimable pre-filter
  // already excludes them; cannot close — work_items:set_state refuses remote-
  // authored mutation locally). Partition so `unownedCriticals` stays a
  // trustworthy "CLAIM these" signal, and surface the remote-origin count
  // separately rather than dropping it.
  const { actionable: unownedCriticals, federatedUnresolvable: unownedCriticalsFederated } =
    partitionUnownedCriticalsByOrigin(unownedCriticalsAll);
  const admissionDependencyEscapes = admissionBlocked.filter((block) => block.dependencyEscape != null);
  const claimableNow = buildClaimableNowAggregate({
    fleet,
    requestedHarness: args.harness,
    laneHealth: fleetLaneHealth,
    unavailable: fleetLaneHealthRead.unavailable,
    fleetPaused: fleetPause.paused,
  });
  // P-005 / D-001: hydrate the rich, replace-full fleet snapshot through the
  // canonical scope resolver + burn-down builder. A missing harness or a slow
  // optional leg remains an explicit unavailable result with recoverVia;
  // omission/zero would falsely read as a measured empty fleet.
  const fleetMetricsHarness = args.harness ?? fleetLaneHealth?.spec.harness ?? null;
  const fleetMetricsFallback = leaderBriefFleetMetricsUnavailable({
    fleet,
    harness: fleetMetricsHarness,
    reason: 'canonical fleet metric read exceeded the leader-brief leg budget',
    recoverVia: fleetMetricsHarness
      ? `work_items:burn_down { harness: '${fleetMetricsHarness}', fleet: '${fleet}', window: 'fleet-lifetime' }`
      : 'fleet:leader-brief { fleet, harness }',
  });
  const fleetMetrics = await boundedLeaderBriefRead(
    'fleet-metrics',
    () =>
      readLeaderBriefFleetMetrics({
        workspaceId,
        fleet,
        harness: fleetMetricsHarness,
        assignee: ownerId,
      }),
    fleetMetricsFallback,
    LEADER_BRIEF_HEADCOUNT_TIMEOUT_MS,
  );
  const fleetLaneEffective = fleetLaneHealth?.effective ?? null;
  const fleetClaimableCount = fleetLaneEffective?.claimable ?? null;
  const fleetLaneGating =
    fleetLaneEffective?.matchedByFilter == null
      ? null
      : {
          matchedByFilter: fleetLaneEffective.matchedByFilter,
          ...(fleetLaneEffective.excluded ? { excluded: fleetLaneEffective.excluded } : {}),
        };
  const nowMs = Date.now();
  // EI-21548894457555139: one in-process read (no DB round-trip) of the calls currently
  // executing, so a member sitting inside a long call is not reported as idle/dormant.
  // Keyed by ownerId, keeping only the LONGEST-running call per member — that is the one
  // a leader triages, and getLongCallsInFlight already returns longest-first.
  const longCallByOwner = (() => {
    const byOwner = new Map<string, { tool: string; ageSec: number }>();
    try {
      for (const call of getLongCallsInFlight(LONG_CALL_IN_FLIGHT_MS, nowMs)) {
        if (!call.ownerId || byOwner.has(call.ownerId)) continue;
        byOwner.set(call.ownerId, { tool: call.toolName, ageSec: call.ageSec });
      }
    } catch {
      // A liveness read must never be able to fail the brief that carries it.
    }
    return byOwner;
  })();
  // P-009: the latest stranded containment per member, in ONE query for the whole roster.
  // Bounded like every other optional leg: a slow or failing ledger read degrades the
  // recovery annotation, never the brief that carries it. An empty map is therefore
  // "nothing surfaced", NOT "no member is stranded" — which is why the field's own doc
  // says absence is not a verdict.
  const [recoveryByOwner, repeatedRecoveryByOwner] = await Promise.all([
    boundedLeaderBriefRead(
      'member-recovery',
      async () => {
        const rows = await listLatestStrandedByCoordOwners(
          grouped.map((a) => a.agentId),
          { workspaceId },
        );
        return new Map(
          rows.map((r) => [
            r.coordOwnerId,
            { disposition: 'stranded' as const, reason: r.reason, taskId: r.taskId, strandedAt: r.endedAt },
          ]),
        );
      },
      new Map<string, NonNullable<LeaderBriefMember['recovery']>>(),
      LEADER_BRIEF_HEADCOUNT_TIMEOUT_MS,
    ),
    boundedLeaderBriefRead(
      'repeated-recovery',
      async () => {
        const { readFleetRepeatedRecoveryStates, repeatedRecoveryAlert } =
          await import('../../fleet-repeated-recovery');
        const states = await readFleetRepeatedRecoveryStates(
          grouped.map((member) => ({
            ownerId: member.agentId,
            isRegisteredLeader: member.fleetRole === 'leader',
            hasProgressingClaim: member.claims.some((claim) => claim.activity === 'progressing'),
          })),
          { workspaceId },
        );
        return new Map(
          [...states].flatMap(([ownerId, state]) => {
            const alert = repeatedRecoveryAlert(state);
            return alert ? [[ownerId, alert] as const] : [];
          }),
        );
      },
      new Map<string, RepeatedRecoveryAlert>(),
      LEADER_BRIEF_HEADCOUNT_TIMEOUT_MS,
    ),
  ]);
  const members = grouped.map((a) =>
    projectMember(
      a,
      nowMs,
      fleetClaimableCount,
      fleetLaneGating,
      fleetPause.paused,
      concurrencyByOwner.get(a.agentId) ?? null,
      poolCapacity,
      longCallByOwner.get(a.agentId) ?? null,
      recoveryByOwner.get(a.agentId) ?? null,
      repeatedRecoveryByOwner.get(a.agentId) ?? null,
    ),
  );
  // `self` now arrives on the caller bag (see LeaderBriefCaller): a viewer has
  // no row of its own in the fleet, so nothing is marked for it.
  const markedMembers = markSelfRows(members, self, 'agentId');
  const everMemberRead = await withBoundedTimeout(fleetEverMembers(fleet, { workspaceId }), {
    fallback: null,
    timeoutMs: LEADER_BRIEF_HEADCOUNT_TIMEOUT_MS,
    label: 'leader-brief:population-ever-members',
  });
  const everMemberIdsForPopulation = everMemberRead.value ?? new Set<string>();
  const populationLifecycle = buildFleetPopulationLifecycle({
    fleet,
    candidates: rosterEntries,
    everMemberIds: [...everMemberIdsForPopulation],
    everMembersAvailable: !everMemberRead.degraded && everMemberRead.value != null,
    everMembersReason: everMemberRead.degraded ? 'fleet membership read timed out or failed' : undefined,
    fleetStartedAtMs: fleetCreatedAtMs,
    observedAtMs: Date.now(),
    includeStale: args.include_stale,
    target: headcount,
    claimFlow:
      fleetClaimableCount == null
        ? null
        : {
            status: 'measured',
            population: 'current-runnable-roster',
            basis: 'leader-brief fleet roster and scheduler claimable aggregate',
            claimable: fleetClaimableCount,
            inFlight: members.reduce((count, member) => count + member.workItemIds.length, 0),
            orphaned: orphanedInFlight.length,
            stalled: members.filter((member) => member.verdict === 'stalled' || member.stalled).length,
            idle: members.filter(
              (member) =>
                member.benchSuggestion?.kind === 'idle-with-claimable' ||
                member.benchSuggestion?.kind === 'laneless-idle',
            ).length,
            criticalContext: members.filter((member) => member.contextPressure === 'critical').length,
          },
  }).snapshot;
  // ── WI-2034563 / P-008 leg (c): policy-parked capacity ────────────────────
  // The third hole behind the 2026-09-01 incident. Headcount reported the fleet
  // UNDER-STRENGTH while ~23 of its 45 members were alive, authorized, and simply
  // parked by the leader's own directive — and the natural response to
  // under-strength is to RELAUNCH, which buys nothing and costs a seat. Nothing in
  // this brief named the directive doing the parking, so there was no way to tell
  // parked capacity from missing capacity.
  //
  // Counted over the same canonical LIVE roster `headcount.current` is attested
  // from, so the two numbers describe one population. A failed roster read leaves
  // the row absent rather than reporting a fabricated zero — "0 parked" and "we
  // could not count" must never look alike here.
  const policyParked =
    headcountCurrentResult.value == null || !fleetRecordReadAvailable
      ? undefined
      : buildPolicyParkedCapacity({
          fleet,
          liveMembers: headcountCurrentResult.value.length,
          path: resolveFleetParkResumePath(fleetRecord, Date.now()),
        });
  const summary = {
    fleet,
    members: members.length,
    ...(policyParked ? { policyParked } : {}),
    // P-010: what `members` (and every count below it, all of which are filters
    // OVER the same list) is a count OF. Without this the number is only
    // comparable to itself: the same fleet read 11 / 11 / 14 / 8 / 9 across
    // leader-brief and fleet:assignments within minutes, each defensible, none
    // reconciled inline.
    population: memberCensus,
    populationLifecycle,
    // WI-41145: intended population beside exact current launch membership.
    // A disabled saved profile retains its launch recipe internally, but its
    // public target stays null so a reusable recipe cannot masquerade as an
    // active headcount commitment. Read failures remain in-band `unknown`.
    headcount,
    // P-007 / R-17: the live members `headcount.current` left out because they are
    // silent past the threshold (heartbeats only). Named so a leader can wake or
    // replace them; `unknown` when either silence leg was unreadable, never `[]`.
    silentMembers: silentMembersSummary(headcountCurrentResult.value, headcountSilenceRead.value),
    speaking: members.filter((m) => m.verdict === 'speaking').length,
    monitoring: members.filter((m) => m.monitorState === 'monitoring').length,
    waiting: members.filter((m) => m.monitorState === 'waiting').length,
    parked_awaiting_capability: members.filter((m) => m.monitorState === 'parked-awaiting-capability').length,
    stalled: members.filter((m) => m.verdict === 'stalled' || m.stalled).length,
    dead: members.filter((m) => m.verdict === 'dead').length,
    // EI-21238131879315614: `members` is live-first and may be transport-truncated,
    // so a bare dead count can name no visible row. Carry the exact member ids beside
    // the aggregate; the shaper bounds this list independently without losing the
    // identity needed to verify a relaunch/takeover decision.
    dead_member_ids: members.filter((m) => m.verdict === 'dead').map((m) => m.agentId),
    unanswered_directed: members.filter((m) => (m.unanswered?.count ?? 0) > 0).length,
    high_context: members.filter((m) => m.contextPressure === 'high').length,
    critical_context: members.filter((m) => m.contextPressure === 'critical').length,
    parked: members.filter((m) => (m.parkedOn?.length ?? 0) > 0).length,
    // P-012: raw intent signals already existed; this is the count of members
    // with a resolving action in `intentAttention` below.
    intent_attention: members.filter((m) => m.intentAttention != null).length,
    verified_wait_takeovers: members.reduce((count, member) => count + (member.verifiedWaitTakeovers?.length ?? 0), 0),
    // P-001 coord-deafness: live members NOT seeing their coord mail right
    // now — a coord:send to them silently queues until they settle/wake.
    coord_deaf: members.filter((m) => m.coordHook != null).length,
    // EI-9943: members alive+speaking but not advancing and not yet benched —
    // the live-loop-polling-on-a-blocker pattern this whole item targets.
    bench_suggested: members.filter((m) => m.benchSuggestion != null).length,
    // EI-18681259560385029: of those, the ones that must NOT be benched — alive,
    // unclaimed, and idle beside a queue that is NOT empty. `bench_suggested` alone
    // was read as benign (it counts a REMEDY); this counts a STARVATION SYMPTOM.
    idle_with_claimable: members.filter((m) => m.benchSuggestion?.kind === 'idle-with-claimable').length,
    // EI-18689489507862177: members idle against an EMPTY (or unread) queue. Distinct from
    // idle_with_claimable above, which by construction only counts them when claimable > 0
    // — so in a fully-GATED lane (claimable 0, spec matching plenty) that field reads 0 and
    // these members land here instead. This is the count computeFloorStarvedFleetAlert
    // keys on; without it the gated-lane alert could never fire.
    laneless_idle: members.filter((m) => m.benchSuggestion?.kind === 'laneless-idle').length,
    // EI-18730414627683753: members with ZERO self-wake mechanism (no loop, no park, no
    // claim) — distinct from laneless_idle above, which does not distinguish a healthy
    // loop-armed member (will re-cycle on its own) from one that will never wake again.
    // >0 here means the leader must wake these members NOW; waiting out a tick does nothing.
    dormant: members.filter((m) => m.dormant === true).length,
    // EI-19307414464301772: members alive and visibly taking turns whose calls are
    // entirely per-turn housekeeping (coord:glance/activity:report/journal:record-turn/
    // flags:get/sessions:ingest-gate-event) for well past budget — every OTHER surface
    // here (stalled, dead) reads these as healthy. >0 means wake it explicitly and
    // investigate; do not assume the loop will self-correct.
    spinning: members.filter((m) => m.spinning === true).length,
    // P-004/R-4: members whose held ITEM has not materially advanced past the stall
    // threshold while ready items wait in the fleet claim set. >0 means require one
    // accountable action per named member (see each member's `stalledItem.requiredAction`).
    stalled_item: members.filter((m) => m.stalledItem != null).length,
    // EI-19381528967421062: members whose loop is backed off from a provider wall right
    // now — `active:true`/`sessionState:parked` read identical to a healthy between-wakes
    // member on every OTHER surface. >0 here means those claims are stranded until
    // `throttled.until`, not lost; do not relaunch/reclaim solely on this, but do NOT read
    // the fleet as fully healthy either — see each member's `throttled` field for when.
    throttled: members.filter((m) => m.throttled != null).length,
    // D-007: members above the two-cycle threshold. The complete identity
    // index below makes every positive count actionable under shaping.
    repeated_recovery: members.filter((m) => m.repeatedRecovery != null).length,
    // P-002 / D-004: the count and the exact population that gives it meaning
    // are one wire value. A caller cannot retain the numeral while silently
    // dropping its fleet/spec/harness, and null carries an in-band reason.
    claimable_now: claimableNow,
    // WI-3818: make any incomplete canonical roster read explicit to callers
    // instead of silently presenting a partial membership list.
    degraded_roster_legs: rosterResult.degradedLegs,
    // WI-5213: unowned criticals (filing is not fixing) THIS fleet's claim
    // spec would admit — >0 here means an escalation the leader should act
    // on (reclaim/reassign/nudge), not weather to wait out. WI-6846: this is
    // now LOCAL-origin only (actionable here) — see unowned_criticals_federated.
    unowned_criticals: unownedCriticals.length,
    // WI-6846: origin:'remote' rows from the SAME spec-admitted set above —
    // this node can neither claim nor close them (see unownedCriticalsFederated
    // in the payload for the recovery-state list + note). Nonzero here is
    // explicitly NOT an escalation for THIS leader to act on.
    unowned_criticals_federated: unownedCriticalsFederated.length,
    // EI-18693470222331709: orphaned in-flight items (filing is not fixing, same
    // as unowned_criticals above) — >0 means near-complete work stranded by a
    // release/reap, the cheapest claimable win on this brief.
    // WI-6678: renamed from `orphaned_in_flight`. "Orphan" made every leader reach for
    // work_items:release (the standing "reclaim orphans" monitor instruction says so) —
    // but this condition REQUIRES assignee IS NULL, so a release cannot possibly clear
    // it and returns ok:true having done nothing. Observed live: a leader "reclaimed"
    // two of these and reported it to the owner, changing nothing. The only resolving
    // action is a member CLAIMING and finishing the item.
    abandoned_unclaimed: orphanedInFlight.length,
    // EI-18680302159738037: DISTINCT (item, member) pairs this fleet's own claim
    // spec refused in the last 24h. Unlike every other advisory here, the blocked
    // party already told you — as inbox mail, which is where it got buried. >0
    // means a member is structurally UNABLE to claim work it was pointed at, and
    // the only remedy is a spec write YOU make (scheduler:set_claim_spec); no
    // amount of member discipline clears it. See `admissionBlocked` for the rows.
    // P-005: this is a monotonic historical counter, not a live fleet gauge. Keep
    // it structurally separate so before/after readers cannot treat it as a snapshot.
    cumulative: {
      admission_blocked: admissionBlockedCount,
    },
    // P-006: the critical subset whose refused item is an unresolved dependency
    // of work the member already holds. Rows carry the exact dependency + three routes.
    admission_dependency_escapes: admissionBlockedCount == null ? null : admissionDependencyEscapes.length,
    // EI-18703234178947959: this fleet's own control_state is winding-down (fleet:pause /
    // fleet:wind-down). Emitted EXPLICITLY rather than left implicit, because it is the
    // reason the idle-member alerts above read 0/false: idle members are COMPLYING with
    // the pause, so "no alert" here means "no action needed", not "nothing was checked".
    // Lift with fleet:resume; until then the claim path refuses these members work.
    fleet_paused: fleetPause.paused,
    // WI-37161: the live shared-inference-pool verdict (the same read `fleet:capacity`
    // reports), surfaced HERE — not only folded into the per-member `throttled` field — so a
    // leader reading the summary alone can see the pool is degraded/exhausted even though
    // `throttled` (a DIFFERENT, per-member signal — see PoolDegradedState's doc comment) can
    // legitimately read 0 for every member at once while the pool itself is congested. null
    // means unread this call, never "healthy".
    pool_capacity: poolCapacity,
  };
  const totalLoad = members.reduce((sum, m) => sum + m.load, 0);
  // EI-15055: loud fleet-wide zero-wip-with-supply alert — see computeStrandedFleetAlert.
  const strandedFleetAlert = computeStrandedFleetAlert({
    totalLoad,
    parkedCount: summary.parked,
    unownedCriticalCount: unownedCriticals.length,
    harness: args.harness ?? null,
    fleet,
  });
  // EI-18655873409999215: the SPEC-STARVED alert — best-effort, fail-soft (a
  // preview error or missing spec must never break the brief). Measures the
  // fleet's OWN effective claim spec against the live claimable pool, the same
  // compiled-filter count scheduler:set_claim_spec's write-time guard uses.
  // EI-18681259560385029: idle members beside a NONEMPTY queue — the shape both alerts
  // below are structurally blind to (see computeIdleWithClaimableAlert).
  const idleWithClaimableAlert = computeIdleWithClaimableAlert({
    claimableCount: fleetClaimableCount,
    idleMemberCount: summary.idle_with_claimable,
    fleetPaused: fleetPause.paused,
    harness: args.harness ?? null,
    // The SAME predicate the count above is derived from, so the falsifier can never
    // name a member the alert is not actually accusing.
    idleMemberIds: members.filter((m) => m.benchSuggestion?.kind === 'idle-with-claimable').map((m) => m.agentId),
    poolCapacity,
  });
  // EI-18689489507862177: the GATED-lane twin of the alert above. `idle_with_claimable`
  // is 0 by construction in this state (its bench branch requires claimableCount > 0), so
  // this one counts laneless-idle members instead — keying it to idle_with_claimable would
  // ship an alert that can never fire.
  const floorStarvedAlert = computeFloorStarvedFleetAlert({
    claimable: fleetClaimableCount,
    matchedByFilter: fleetLaneEffective?.matchedByFilter ?? null,
    idleMemberCount: summary.laneless_idle,
    excluded: fleetLaneEffective?.excluded ?? null,
    fleetPaused: fleetPause.paused,
    harness: args.harness ?? null,
    fleet,
  });
  // fleet-lead-instrumentation-audit-2026-08-09 P-019/P-012: ARBITRATE the alerts above
  // into ONE dominant layer. Computed from the same inputs the siblings fired on (never a
  // second read), so it cannot disagree with them — it only ORDERS them.
  const blockedAt = computeFleetBlockVerdict({
    fleetPaused: fleetPause.paused,
    poolCapacity,
    claimable: fleetClaimableCount,
    matchedByFilter: fleetLaneEffective?.matchedByFilter ?? null,
    idleMemberCount: summary.idle_with_claimable,
    lanelessIdleCount: summary.laneless_idle,
    harness: args.harness ?? null,
    fleet,
  });
  let specStarvedAlert: { reason: string; falsifier: AlertFalsifier } | undefined;
  // WI-5937 acceptance #3: "leader-brief returns spec filter + both counts + per-member
  // doing in one read" — the fleet's OWN active view.filter (so a leader reads WHAT is
  // scoped without a separate scheduler:get_claim_spec round-trip) plus BOTH claimable
  // counts side by side: the harness-WIDE pool (what work_items:claimable{harness} would
  // show, pre-spec-narrowing) and the spec-scoped matched count (pre-floor) — the exact
  // pair whose conflation (1037 harness-wide vs 0 spec-scoped) produced the false
  // spec-starved ruling this item's own root-cause section documents. Best-effort/optional:
  // a preview failure must never block the rest of the brief.
  let specFilter: FilterNode | null | undefined;
  let harnessWidePool: number | undefined;
  let specMatched: number | undefined;
  // P-005: the spec row's own authorship, surfaced beside the filter it describes. A
  // leader reading `specFilter` alone cannot tell their own lane from one an automated
  // peer rewrote under them.
  let specRevision: number | undefined;
  let specUpdatedBy: string | null | undefined;
  let specUpdatedAt: string | null | undefined;
  let specAuthorshipAlert: { reason: string; falsifier: AlertFalsifier } | undefined;
  let declaredPlanSpecDivergenceAlert: ReturnType<typeof computeDeclaredPlanSpecDivergenceAlert> | undefined;
  let fleetHeadcountVsExecutableFrontierAlert: FleetHeadcountVsExecutableFrontierEvaluation | undefined;
  let leaderPlanSlug: string | null = null;
  let planHistory: PlanHistoryContext | undefined;
  // P-006: always in-band. A missing/exploded dependency read is UNKNOWN,
  // never an omitted field that a leader can mistake for a measured empty view.
  let dependencyBottlenecks: LeaderDependencyBottleneckView = {
    status: 'unknown',
    reason: 'claim-spec-unread',
  };
  try {
    const claimSpecStore = await boundedLeaderBriefRead(
      'claim-spec-store',
      () => import('../../scheduler/claim-spec-store'),
      null,
    );
    if (!claimSpecStore) throw new Error('claim-spec-store unavailable');
    const rec = await boundedLeaderBriefRead(
      'claim-spec-record',
      () => claimSpecStore.getClaimSpecRecord({ cupId: claimSpecStore.fleetSpecBeeKey(fleet), workspaceId }),
      null,
    );
    if (!rec) throw new Error('claim-spec record unavailable');
    if (rec.source !== 'default') {
      specFilter = rec.spec.view?.filter ?? null;
      specRevision = rec.revision ?? undefined;
      specUpdatedBy = rec.updatedBy;
      specUpdatedAt = rec.updatedAt;
      // P-005: computed from the record ALONE, and deliberately BEFORE the pool preview
      // below — the preview is the fragile half (it compiles the filter and counts the
      // pool), and coupling a drift signal to it would mean a preview outage silently
      // takes the drift check with it. That is the same class of blindness this alert
      // exists to report, one level up.
      specAuthorshipAlert = computeSpecAuthorshipAlert({
        readerId: ownerId ?? null,
        updatedBy: rec.updatedBy,
        revision: rec.revision,
        updatedAt: rec.updatedAt,
        harness: args.harness ?? null,
        fleet,
      });
      const effect = await boundedLeaderBriefRead(
        'spec-pool-effect',
        async () => {
          const { previewSpecPoolEffect } = await import('../../scheduler/spec-pool-preview');
          return previewSpecPoolEffect(rec.spec, { workspaceId, harness: args.harness ?? null });
        },
        null,
      );
      if (effect) {
        specStarvedAlert = computeSpecStarvedFleetAlert({
          totalLoad,
          specMatched: effect.matched,
          poolSize: effect.pool,
          harness: args.harness ?? null,
          fleet,
        });
        harnessWidePool = effect.pool;
        specMatched = effect.matched;
      }
    }
    declaredPlanSpecDivergenceAlert = computeDeclaredPlanSpecDivergenceAlert({
      members: grouped,
      specFilter: rec.spec.view?.filter,
      harness: args.harness ?? null,
      fleet,
    });
    // P-011: continuously re-run launch admission's executable-width definition
    // for a provably exact one-plan lane. Every unknown suppresses the detector.
    const exactPlanSlug = exactPositiveSinglePlanSlugFromFilter(rec.spec.view?.filter);
    leaderPlanSlug = exactPlanSlug;
    const planHarness = args.harness ?? rec.harnessSlug ?? fleetLaneHealth?.spec.harness ?? null;
    if (!exactPlanSlug) {
      dependencyBottlenecks = { status: 'unknown', reason: 'claim-spec-not-exact-plan' };
    } else if (!planHarness) {
      dependencyBottlenecks = {
        status: 'unknown',
        reason: 'plan-harness-unresolved',
        planSlug: exactPlanSlug,
      };
    } else {
      const [measured, readyWidth, history] = await runBoundedLeaderBriefReads(
        [
          () =>
            readDependencyBottlenecks({
              workspaceId,
              harnessSlug: planHarness,
              planSlug: exactPlanSlug,
              limit: 8,
              includeGraph: args.include_mermaid === true,
            }),
          async () => {
            const [{ getPlanRow, planItemsForRow }, { analyzePlanDagParallelism }] = await Promise.all([
              import('../plans/source'),
              import('../plans/plan-dag-parallelism'),
            ]);
            const planRow = await getPlanRow(exactPlanSlug, { workspaceId, harnessSlug: planHarness });
            return planRow ? analyzePlanDagParallelism(planItemsForRow(planRow)).readyWidth : null;
          },
          () => readPlanHistoryContext(exactPlanSlug, planHarness),
        ] as const,
        [null, null, null] as const,
        'plan-diagnostics',
      );
      planHistory = history ?? {
        status: 'unknown',
        brief: null,
        recovery: { tool: 'plans:get', args: { slug: exactPlanSlug, harness: planHarness, heading: 'History' } },
      };
      if (measured) {
        dependencyBottlenecks = buildLeaderDependencyBottleneckView(measured, grouped);
      } else {
        dependencyBottlenecks = {
          status: 'unknown',
          reason: 'read-failed',
          planSlug: exactPlanSlug,
          harnessSlug: planHarness,
        };
      }
      if (readyWidth != null) {
        const liveNonLeaderWorkers = grouped.filter(
          (member) => member.fleetRole !== 'leader' && member.alive !== false && member.verdict !== 'dead',
        ).length;
        fleetHeadcountVsExecutableFrontierAlert = computeFleetHeadcountVsExecutableFrontierAlert({
          planSlug: exactPlanSlug,
          liveNonLeaderWorkers,
          readyWidth,
          claimable: fleetClaimableCount,
          fleetPaused: fleetPause.paused,
          harness: planHarness,
          fleet,
        });
      }
    }
  } catch {
    /* best-effort — never block the brief on a spec-effect preview failure */
  }
  // P-005 / D-030 step 5: the UNDER-staff counterpart of the over-staff alert
  // above. Plan-independent: a fleet with zero workers is short whatever it drains.
  // An unread fleet record passes a null control state, so the alert stays unknown.
  const fleetUnderStaffed = buildFleetUnderStaffedBriefAlert({
    fleet,
    headcount,
    controlState: fleetRecordReadAvailable ? (fleetRecord?.controlState ?? null) : null,
    fleetPaused: fleetPause.paused,
  });
  const announcedGates = await boundedLeaderBriefRead(
    'announced-gates',
    () =>
      readLeaderAnnouncedGates({
        fleetSlug: fleet,
        planSlug: leaderPlanSlug,
        harnessSlug: args.harness ?? null,
      }),
    undefined,
  );
  // P-025: never-drop facts for this leader's scope. Bounded and best-effort
  // like every other optional leg — a guard-rail fact is worth surfacing, but
  // never worth failing the whole brief for.
  const neverDropFacts = await boundedLeaderBriefRead(
    'never-drop-facts',
    () => readLeaderNeverDropFacts({ ownerId: ownerId ?? null, workspaceId }),
    undefined,
  );
  // P-004 (shared-agent-obligations-and-briefs-2026-09-05): the SAME
  // evaluation path used by automatic turn-start orientation, projected to the
  // leader sink's wider budget. It is read-only and bounded per canonical
  // source; existing fleet diagnostics remain independent and intact.
  const obligationProjections = ownerId
    ? await boundedLeaderBriefRead(
        'agent-obligations',
        async () => {
          const { readAgentObligationAgenda, projectAgentObligationBrief } =
            await import('../../agent-obligation-reader');
          const read = await readAgentObligationAgenda({
            workspaceId,
            ownerId,
            planSlugs: leaderPlanSlug ? [leaderPlanSlug] : [],
            fleetSlug: fleet,
            launchCount: 1,
            sourceTimeoutMs: LEADER_BRIEF_OPTIONAL_READ_TIMEOUT_MS,
          });
          const readMeta = { elapsedMs: read.elapsedMs, degradedSources: read.degradedSources };
          const agentBrief =
            read.agenda.evaluations.length === 0
              ? null
              : {
                  ...projectAgentObligationBrief({
                    agenda: read.agenda,
                    sink: 'fleet:leader-brief',
                    detailRef: 'fleet:leader-brief { payloadTier:"full" } for complete obligation evidence',
                    maxEntries: 3,
                    maxChars: 1_600,
                    maxEstimatedTokens: 400,
                  }),
                  read: readMeta,
                };
          const ownerEvaluations = read.agenda.evaluations.filter(
            (entry) => entry.family === 'owner-directive' && entry.status !== 'not-applicable',
          );
          const ownerAgenda: AgentObligationAgenda = {
            ...read.agenda,
            evaluations: ownerEvaluations,
            primary: read.agenda.primary.filter((entry) => entry.family === 'owner-directive'),
          };
          const ownerBrief =
            ownerEvaluations.length === 0
              ? null
              : projectAgentObligationBrief({
                  agenda: ownerAgenda,
                  sink: 'fleet:leader-brief:owner-directives',
                  detail: 'action',
                  detailRef: 'fleet:leader-brief { payloadTier:"full" } for complete owner-directive evidence',
                  maxEntries: 12,
                  maxChars: 2_000,
                  maxEstimatedTokens: 500,
                });
          return {
            agentObligations: agentBrief ? { ...agentBrief, read: readMeta } : null,
            ownerDirectives: ownerBrief
              ? projectLeaderBriefOwnerDirectives({ agenda: ownerAgenda, projection: ownerBrief.projection, read: readMeta })
              : null,
          };
        },
        null,
        1_800,
      )
    : null;
  const { agentObligations, ownerDirectives } = selectLeaderBriefObligationFields(obligationProjections);
  // P-009: detector-only projection over P-006's existing graph/liveness/
  // progress rows. Do not re-read any of those sources here: one measured view
  // feeds both the ranked table and this tri-state alarm.
  const leaderBlockerStall = buildLeaderBlockerStallBriefView(dependencyBottlenecks, fleet);
  // P-014: leader-REGISTERED custom invariants, evaluated here alongside the
  // built-in alerts above. The built-ins are checks somebody thought to build in
  // advance; this is where a leader's own ad-hoc check lives instead of dying with
  // the turn that wrote it. Same best-effort discipline as the preview above — and
  // internally each invariant is isolated too, so one bad registry entry reports
  // itself as errored rather than costing the leader the rest of the brief.
  let customInvariants: InvariantEvaluation[] | undefined;
  let customInvariantAlert: { reason: string } | undefined;
  const invariantRead = await boundedLeaderBriefRead<InvariantEvaluation[] | undefined>(
    'custom-invariants',
    async () => {
      const { readFleetInvariantEvaluations } = await import('./invariants');
      return readFleetInvariantEvaluations({ workspaceId, fleetSlug: fleet });
    },
    undefined,
  );
  customInvariants = invariantRead;
  if (customInvariants) {
    const { computeCustomInvariantAlert } = await import('./invariants');
    customInvariantAlert = computeCustomInvariantAlert(customInvariants);
  }
  // P-023: the PER-MEMBER "why is this idle" verdict, computed AFTER `blockedAt` because it
  // is deliberately subordinate to it. Attributing idleness to a member while the pool is at
  // factor 0 is exactly the inversion P-002 measured; deriving a per-member answer
  // independently would reproduce that once per member, and a specific per-member reason
  // reads as BETTER evidence than a fleet-wide one, so it would be believed harder.
  const membersWithVerdict = markedMembers.map((m) => ({
    ...m,
    idleVerdict: computeMemberIdleVerdict(
      {
        sessionState: m.sessionState,
        load: m.load,
        stalled: m.stalled,
        lastToolCallAgeMs: m.lastToolCallAgeMs,
        productiveToolCallAgeMs: m.productiveToolCallAgeMs,
        longCallInFlight: m.longCallInFlight,
        contextPressure: m.contextPressure,
        throttled: (m as { throttled?: unknown }).throttled,
        loopMode: m.loopMode,
        nextFireAt: m.nextFireAt,
        parkedOn: m.parkedOn,
      },
      { blockedAtLayer: blockedAt?.layer ?? null, midTurnFreshnessMs: VERDICT_SPEAKING_FRESH_MS },
    ),
  }));
  const idleCauses = summariseIdleCauses(membersWithVerdict.map((m) => m.idleVerdict));
  // P-024 / D-013: the reservation plan. Built on the P-023 causes above rather than on a
  // second read of member state, so "who is holding work" cannot differ between the two
  // blocks. Recommends nothing at all when the pool is not scarce, and never recommends a
  // bench — the trade P-024 exists because the leader was forced to make.
  const reservation = computePoolReservation(
    membersWithVerdict.map((m) => ({ agentId: m.agentId, idleCause: m.idleVerdict.cause })),
    { factor: poolCapacity?.factor ?? null, queueDepth: poolCapacity?.queueDepth ?? null },
  );
  const memberVerdicts = compactLeaderBriefMemberVerdicts(membersWithVerdict);
  const benchSuggestions = compactLeaderBriefBenchSuggestions(membersWithVerdict);
  const intentAttention = compactLeaderBriefIntentAttention(membersWithVerdict);
  const repeatedRecovery = compactLeaderBriefRepeatedRecovery(membersWithVerdict);
  const detailMembers = prioritizeActionableMembers(membersWithVerdict);
  const claimsByOwner = new Map(grouped.map((agent) => [agent.agentId, agent.claims]));
  const activityByOwner = new Map(presence.map((agent) => [agent.ownerId, agent.lastActiveAt]));
  // Only the bounded reader's first three candidates cost a held-item read.
  const progress = await readLeaderCheckpointProgress(
    detailMembers.map((member) => ({
      agentId: member.agentId, claims: claimsByOwner.get(member.agentId) ?? [],
      lastActiveAt: activityByOwner.get(member.agentId),
    })),
    workspaceId,
    { timeoutMs: LEADER_BRIEF_OPTIONAL_READ_TIMEOUT_MS, nowMs },
  );
  const boundedMembers = trimToByteBudget(
    detailMembers.map((member) => ({
      ...member,
      ...(progress.has(member.agentId) ? { checkpointProgress: progress.get(member.agentId)! } : {}),
    })),
    LEADER_BRIEF_MEMBER_DETAIL_BUDGET,
  );
  const boundedReservationMembers = trimToByteBudget(reservation.members, LEADER_BRIEF_RESERVATION_DETAIL_BUDGET);
  const reservationForResponse = {
    ...reservation,
    members: boundedReservationMembers.kept,
    ...(boundedReservationMembers.truncated
      ? {
          membersTruncated: true,
          membersReturned: boundedReservationMembers.kept.length,
          membersHint:
            'Reservation details are bounded for transport; use memberVerdicts for the complete member index.',
        }
      : {}),
  };
  // P-022 / D-011: the wake-to-wake delta. Every field above this line is point-in-time,
  // which is what made "what changed since my last wake" a hand-reconstruction from
  // checkpoint prose. Boundary is REPORTED, never implied, and an axis with no baseline
  // reports available:false rather than a zero — a "nothing changed" that actually means
  // "I have no baseline" is the exact bug class this plan exists to catalogue.
  // Best-effort like its neighbours: a delta failure must not cost the leader the brief.
  let delta: FleetBriefDelta | undefined;
  let deltaSummary: string | undefined;
  if (ownerId) {
    const resolved = await boundedLeaderBriefRead(
      'fleet-brief-delta',
      async () => {
        const { resolveFleetBriefDelta } = await import('../../fleet-brief-delta-store');
        const fireCount = await boundedLeaderBriefRead(
          'fleet-brief-delta-fire-count',
          async () => {
            const { getLoopStatus } = await import('../../harness/routines/loop');
            return (await getLoopStatus(ownerId))?.fireCount ?? null;
          },
          null,
        );
        return resolveFleetBriefDelta({
          key: { workspaceId, fleetSlug: fleet, ownerId },
          harnessSlug: args.harness ?? null,
          observation: {
            at: new Date().toISOString(),
            // The ROSTER, not the shown list: a member going stale-idle drops out of
            // `members` but has not left the fleet, and reading that as a departure is
            // precisely the visibility-for-membership confusion P-010 documented.
            rosterSize: memberCensus.candidates ?? null,
            countedMembers: members.length,
            specRevision: specRevision ?? null,
            poolFactor: poolCapacity?.factor ?? null,
          },
          fireCount,
          since: args.since ?? null,
        });
      },
      null,
    );
    if (resolved) {
      delta = resolved.delta;
      deltaSummary = resolved.summary;
    }
  }
  // P-007: cross-epoch campaign measurements are derived live from authoritative
  // writers. Keep this adjacent to the existing wake delta: delta answers "what
  // changed since my last wake" while campaign answers "what has this fleet done
  // since the explicit/fleet-created boundary". Best-effort preserves the health
  // brief if any campaign reader is unavailable; individual axes carry their own
  // unavailable-not-zero verdicts.
  let campaign: FleetCampaign | undefined;
  if (fleetCreatedAtMs != null) {
    const campaignRead = await boundedLeaderBriefRead(
      'fleet-campaign',
      async () => {
        const { readFleetCampaign } = await import('./fleet-campaign');
        return readFleetCampaign({
          workspaceId,
          fleetSlug: fleet,
          fleetCreatedAtMs,
          since: args.since ?? null,
          harnessSlug: args.harness ?? null,
        });
      },
      undefined,
    );
    if (campaignRead) campaign = campaignRead;
  }
  return {
    data: {
      ok: true,
      ...leaderBriefRosterDegradation(rosterResult.degradedLegs),
      ...(self ? { self } : {}),
      // P-004/D-096: the caller is acting on this fleet without holding its
      // leadership. Surfaced BEFORE the summary so it is not lost under the
      // member rows — the value of this branch is that the caller learns it.
      ...(notLeader ? { notLeader } : {}),
      ...(leadershipClaimed ? { leadershipClaimed } : {}),
      ...(leaderControl ? { leaderControl } : {}),
      ...(monitoringBlindAdvisory ? { monitoringBlindAdvisory } : {}),
      // P-026 / D-016: owner turns are a distinct leader obligation. Do not
      // fold this into members[].directiveActuation, which is the
      // DirectiveActuationSummary for leader→member effects (P-030).
      ...leaderBriefObligationFields({ agentObligations, ownerDirectives }),
      // P-019/P-012: the arbitrated "which layer is blocking my fleet" verdict, placed
      // ABOVE the summary on purpose — the alert booleans below are flat and co-fire, and
      // reading them in field order is what produced the inverted remedy this fixes.
      // Absent ⇒ no layer is blocking (every member working), not "unknown".
      ...(blockedAt ? { blockedAt } : {}),
      summary: {
        ...summary,
        darkFleetAlert: darkFleetAlert.alert,
        fleetExecutionCollapseAlert: executionCollapseAlert.alert,
        fleetExecutionCollapse: {
          status: executionCollapseAlert.alert === null ? 'unknown' : 'measured',
          ...executionCollapseAlert.evidence,
        },
        strandedFleetAlert: strandedFleetAlert != null,
        specStarvedAlert: specStarvedAlert != null,
        declaredPlanSpecDivergenceAlert: declaredPlanSpecDivergenceAlert != null,
        ...(fleetHeadcountVsExecutableFrontierAlert
          ? { fleetHeadcountVsExecutableFrontierAlert: fleetHeadcountVsExecutableFrontierAlert.alert }
          : {}),
        // P-005 / D-030: absent = unknown or not applicable, never a clean false.
        ...(fleetUnderStaffed ? { fleetUnderStaffedAlert: fleetUnderStaffed.alert } : {}),
        // P-009: null is load-bearing — the dependency population was not
        // measured or one of the alarm's required row legs was unknown.
        leaderBlockerStallAlert: leaderBlockerStall.alert,
        // P-005: unlike its siblings this one is not about SUPPLY — it says the lane you
        // are reading was authored by someone else, so every other spec figure here
        // describes a scope you have not ratified.
        specAuthorshipAlert: specAuthorshipAlert != null,
        idleWithClaimableAlert: idleWithClaimableAlert != null,
        floorStarvedAlert: floorStarvedAlert != null,
        ...(customInvariants ? { customInvariantAlert: customInvariantAlert != null } : {}),
      },
      // P-003: compact projection of the SAME durable launch transaction fleet:status
      // returns wholesale. No liveness or claim state is re-derived here.
      ...(launchWorkerAttestation ? { launchWorkerAttestation } : {}),
      // P-006/D-005: static PULL view over the exact-plan claim-spec. Its
      // measured|unknown discriminator survives shaping; an unread graph never
      // becomes rows:[] or an absent field that looks like "no bottlenecks".
      dependencyBottlenecks,
      ...(planHistory ? { planHistory } : {}),
      // P-009/R7: observability only. This carries the triggering row and
      // independent read-only falsifier, but performs no remediation.
      leaderBlockerStall,
      // P-022: placed directly under the summary it differences. `deltaSummary` is the
      // one-line "since your last wake — members ±N, closes +N, spec rev X→Y, pool factor
      // A→B" a monitor tick actually reads; `delta` carries the per-axis availability so a
      // reader can tell an unmeasured axis from a quiet one.
      ...(delta ? { delta, deltaSummary } : {}),
      ...(campaign ? { campaign } : {}),
      // P-005 / D-004: current snapshot is distinct from the cursor-based
      // wake delta above and carries its own scope/window/population metadata.
      fleetMetrics,
      // P-027: successful-empty is explicit; absence means the bounded event
      // discovery leg was unavailable. The payload shaper caps verbose rows and
      // retains a truthful recovery pointer rather than clipping JSON.
      ...(announcedGates ? { announcedGates } : {}),
      // P-025: the never-drop facts in this leader's scope, rendered from the
      // shared orientation class declaration (D-053). ABSENT means either none
      // apply or the bounded read was unavailable — deliberately not `[]`, which
      // would read as a measured "none" and hide a degraded leg.
      ...(neverDropFacts ? { neverDropFacts } : {}),
      // P-023: counts by cause. A cause that never fired is ABSENT, not 0 — a zero row
      // invites reading an unpopulated cause as a measured absence.
      idleCauses,
      // P-024: included only when the pool is actually scarce. Under a healthy pool the plan
      // is "recommend nothing", and rendering that every wake would be one more always-present
      // block a leader learns to skip past.
      ...(reservation.scarcity.scarce ? { reservation: reservationForResponse } : {}),
      // EI-20226510994156306: this compact index is intentionally complete even when the
      // verbose member rows below are bounded. It is the stable recovery surface for a
      // 50-member fleet: every id + verdict remains available without a full-tier fetch.
      memberVerdicts,
      // EI-21242929839064139: unlike `members`, this exceptional slice is complete.
      // A leader must never see bench_suggested:N without the N target identities.
      benchSuggestions,
      // P-012: same complete exceptional-index contract for intent actionability.
      // A leader must never see intent_attention:N without every target + action.
      intentAttention,
      repeatedRecovery,
      members: boundedMembers.kept,
      ...(boundedMembers.truncated
        ? {
            membersTruncated: true,
            membersReturned: boundedMembers.kept.length,
            membersHint:
              'Verbose member rows are bounded for transport; use memberVerdicts for all ids/verdicts and narrow fleet:assignments { agent } for detail.',
          }
        : {}),
      ...(unownedCriticals.length > 0 ? { unownedCriticals } : {}),
      ...(unownedCriticalsFederated.length > 0
        ? {
            unownedCriticalsFederated,
            // WI-6846: carry the non-actionability with the finding, same discipline as
            // abandonedUnclaimedAction below — a bare count invites a leader to try to
            // claim/close these and hit a refusal for every one.
            unownedCriticalsFederatedNote:
              `${unownedCriticalsFederated.length} unowned critical(s) this fleet's spec would admit are ` +
              `origin:'remote' — authored on a DIFFERENT node. This node can neither claim them ` +
              `(already excluded from self-select) nor close them (work_items:set_state refuses to ` +
              `mutate a remote-authored row locally). Only the authoring peer resolving it, or ` +
              `federation delivering that resolution, clears one. Not this leader's escalation to act on.`,
          }
        : {}),
      ...(orphanedInFlight.length > 0
        ? {
            abandonedUnclaimed: orphanedInFlight,
            // WI-6678: carry the RESOLVING ACTION with the finding. The field name alone
            // could not carry it — and a leader acting on the wrong verb gets ok:true.
            abandonedUnclaimedAction:
              `${orphanedInFlight.length} item(s) show progress then abandonment, and are ALREADY unassigned. ` +
              `work_items:release does NOTHING here (it returns ok:true on the no-op — WI-6678). ` +
              `Resolve by CLAIMING them, or promote them with work_items:set_priority { priority } so the ` +
              `queue hands them to a member — the count falls only when one is claimed and finished.`,
          }
        : {}),
      ...(admissionBlocked.length > 0
        ? {
            admissionBlocked,
            // Same discipline as abandonedUnclaimedAction above: carry the RESOLVING
            // ACTION with the finding. It matters more here than anywhere else on this
            // brief, because the natural reading of "a member is not claiming its work"
            // is a discipline problem — and acting on that reading produces a fleet-wide
            // directive that cannot possibly help, which is exactly what happened in the
            // incident that filed this (EI-18680302159738037).
            // EI-22191915292755203: the routes offered here must NOT be limited to ones
            // that ADMIT the refused item. A claim-spec refusal is frequently the spec
            // WORKING AS INTENDED (the item is genuinely outside this fleet's declared
            // mission scope) — presenting only "widen the lane" / "route it to a member"
            // biases a leader toward dissolving their own mission constraint on every
            // refusal, even a correct one. "Leave it refused, no action needed" MUST be
            // offered as a first-class, equally-weighted option, not an implied default
            // the leader has to infer for themselves.
            // Front-loaded deliberately: the monitor projection CLIPS this to 220
            // chars, so the anti-misreading ("not discipline"), the "maybe correct —
            // leave it" option, and the lever (set_claim_spec) must all land inside the
            // first ~2 sentences or the clipped copy reads as a bare complaint that
            // omits the "do nothing" option entirely.
            admissionBlockedAction:
              `NOT member discipline; NOT necessarily wrong either — ${admissionBlocked.length} refusal(s) may ` +
              `be THIS fleet's claim spec working CORRECTLY. If the item is genuinely out of this fleet's ` +
              `mission scope, the right action is to do NOTHING — leave it refused; it stays claimable for ` +
              `whichever fleet/session's scope actually covers it. If it genuinely belongs here, only YOUR spec ` +
              `write clears it: scheduler:set_claim_spec { fleet, … } to widen the lane, or route the item to a ` +
              `member whose lane admits it. ` +
              (admissionDependencyEscapes.length > 0
                ? `${admissionDependencyEscapes.length} row(s) are typed DEPENDENCY ESCAPES: each names the ` +
                  `dependency and blocked held item ids, preserves the member's ownership, and carries three ` +
                  `routes (spec_widen, outside_lane_placement, leader_claim). `
                : '') +
              `Each row names the specId + revision that refused it; after a widen the member self-claims on its ` +
              `next scheduler:get_next, with no re-dispatch. \`occurrences\` > 1 means that member is stuck in a ` +
              `refusal LOOP, burning a wake each time — that still does NOT mean the refusal is wrong; widen ` +
              `deliberately, as a judgment call, never as a reflex to a high occurrences count.`,
          }
        : {}),
      // EI-19313376980892266 item C: every alert ships its FALSIFIER beside its reason
      // — the read-only one-liner whose output either confirms or KILLS the alert. The
      // reason is what the leader believes; the falsifier is what they can run. Emitted
      // as a sibling field rather than folded into the reason string so it survives a
      // truncating renderer and is machine-checkable (alert-falsifier-reality.test.ts).
      ...(strandedFleetAlert
        ? {
            strandedFleetAlertReason: strandedFleetAlert.reason,
            strandedFleetAlertFalsifier: strandedFleetAlert.falsifier,
          }
        : {}),
      ...(specStarvedAlert
        ? {
            specStarvedAlertReason: specStarvedAlert.reason,
            specStarvedAlertFalsifier: specStarvedAlert.falsifier,
          }
        : {}),
      ...(specAuthorshipAlert
        ? {
            specAuthorshipAlertReason: specAuthorshipAlert.reason,
            specAuthorshipAlertFalsifier: specAuthorshipAlert.falsifier,
          }
        : {}),
      ...(declaredPlanSpecDivergenceAlert
        ? {
            declaredPlanSpecDivergenceAlertReason: declaredPlanSpecDivergenceAlert.reason,
            declaredPlanSpecDivergenceAlertFalsifier: declaredPlanSpecDivergenceAlert.falsifier,
          }
        : {}),
      ...(fleetHeadcountVsExecutableFrontierAlert?.alert
        ? {
            fleetHeadcountVsExecutableFrontierAlertReason: fleetHeadcountVsExecutableFrontierAlert.reason,
            fleetHeadcountVsExecutableFrontierAlertFalsifier: fleetHeadcountVsExecutableFrontierAlert.falsifier,
          }
        : {}),
      ...(fleetUnderStaffed?.alert
        ? {
            fleetUnderStaffedAlertReason: fleetUnderStaffed.reason,
            fleetUnderStaffedAlertFalsifier: fleetUnderStaffed.falsifier,
          }
        : {}),
      ...(idleWithClaimableAlert
        ? {
            idleWithClaimableAlertReason: idleWithClaimableAlert.reason,
            idleWithClaimableAlertFalsifier: idleWithClaimableAlert.falsifier,
          }
        : {}),
      ...(floorStarvedAlert
        ? {
            floorStarvedAlertReason: floorStarvedAlert.reason,
            floorStarvedAlertFalsifier: floorStarvedAlert.falsifier,
          }
        : {}),
      ...(darkFleetAlert.reason ? { darkFleetAlertReason: darkFleetAlert.reason } : {}),
      ...(darkFleetAlert.alert === true ? { darkFleetAlertFalsifier: darkFleetAlert.falsifier } : {}),
      ...(executionCollapseAlert.reason ? { fleetExecutionCollapseAlertReason: executionCollapseAlert.reason } : {}),
      ...(executionCollapseAlert.alert === true
        ? { fleetExecutionCollapseAlertFalsifier: executionCollapseAlert.falsifier }
        : {}),
      // P-014: always carried when ANY invariant is registered — including the
      // all-satisfied case. A leader must be able to tell "my checks ran and found
      // nothing" from "my checks are not running", which a reason-only field cannot
      // express (that is the same false-clean shape the invariants exist to catch).
      ...(customInvariants ? { customInvariants } : {}),
      ...(customInvariantAlert ? { customInvariantAlertReason: customInvariantAlert.reason } : {}),
      // EI-18703234178947959: the owner's own stated pause reason, verbatim, so the
      // leader reads WHY the fleet is standing down without a second registry lookup.
      ...(fleetPause.paused && fleetPause.reason ? { fleetPausedReason: fleetPause.reason } : {}),
      // WI-5937 acceptance #3 — see the comment above the preview call: the fleet's own
      // active claim-spec filter, plus both claimable counts (harness-wide pool vs
      // spec-scoped matched) side by side, so a leader never has to compare member prose
      // against a summary count without the two authoritative reads one call away.
      ...(specFilter !== undefined ? { specFilter } : {}),
      // P-005: the filter's PROVENANCE, emitted whenever the filter itself is — a
      // revision the leader can diff wake-to-wake, and the identity that last moved it.
      // Present-but-null updatedBy is meaningful (an unattributed write), so these ride
      // the same presence test as specFilter rather than being dropped when null.
      ...(specRevision !== undefined ? { specRevision } : {}),
      ...(specUpdatedBy !== undefined ? { specUpdatedBy } : {}),
      ...(specUpdatedAt !== undefined ? { specUpdatedAt } : {}),
      ...(harnessWidePool !== undefined ? { harnessWidePool } : {}),
      ...(specMatched !== undefined ? { specMatched } : {}),
    },
  };
}
