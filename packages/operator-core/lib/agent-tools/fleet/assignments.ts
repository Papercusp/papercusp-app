/**
 * fleet:assignments — query the canonical fleet-assignment state (state-not-chat-
 * fleet-state-2026-06-05, D-002 / P-003).
 *
 * THE state query for "who's running / what is X doing / is anyone on plan P".
 * Reads harness_shared.fleet_assignment (presence + plan-item claims/assignments +
 * work-item claims, claim-primary with holder liveness joined in) — one query, no
 * message-replay. Want to be NOTIFIED of changes instead? Subscribe the
 * 'fleet_assignment' PG NOTIFY channel (lib/fleet-assignment-bus). The coord inbox
 * is for messages addressed to you — not for deriving fleet state (D-001).
 */
import { z } from 'zod';
import { defineTool, readJsonResult, type SeeAlsoEntry } from '@papercusp/agent-mcp';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveSelfRef, markSelfRows } from '../coordination/self-marker';
import { selectFleetPopulation, withShownCount, withLivenessComposition } from './fleet-population';
import { COORD_ROLES } from '../coordination/roles';
import {
  fetchWakeability,
  type SessionState,
  type WakeabilitySignals,
} from '../coordination/presence-wakeability';
import { listPresence, type PresenceRecord } from '../coordination/presence';
import {
  fetchSelfWake,
  isStrandedMember,
  type SelfWakeSignals,
  type SelfWakeSource,
} from '../coordination/presence-selfwake';
import { deriveVerdict } from '../coordination/liveness-oracle';
import { findLiveHost } from '../../events/await/psu-pty-discovery';
import { endedRecordedOwnerIds, recordedLiveOwnerIds } from '../../adv-sessions';
import {
  groupByAgent,
  deriveClaimHealth,
  lastProductiveToolCallAtByOwner,
  lastToolCallAtByOwner,
  listFleetAssignments,
  isReclaimCandidate,
  isResidueCandidate,
  orphanedClaims,
  reconcileOrphanedWithVerdicts,
  resolveTerminalPlanItemResidue,
  stalledClaims,
  summarizeOrphan,
  shouldRecoverClaimFromHealth,
  type AgentAssignment,
  type FleetAssignmentRow,
  type HolderActivity,
} from '../../fleet/assignments';
import {
  getAllWakeModeOverrides,
  getDefaultWakeMode,
  resolveWakeModeFrom,
  type WakeMode,
} from '../coordination/wake-mode';
import {
  getAllPlanItemCoverage,
  compactCoverage,
  coverageCollisions,
  duplicateCoverage,
  type CoverageCollision,
  type CoverageDuplicate,
  type PlanItemCoverage,
} from '../../plan-item-coverage';
import { listParkedAwaitsForSubscribers } from '../../events/await/store';
import {
  fetchContextPressureReadings,
  type ContextPressureBucket,
  type ContextPressureReading,
} from '../coordination/context-pressure';
import {
  fetchUnansweredDirected,
  type UnansweredDirectedSummary,
} from '../coordination/unanswered-directed';
import { fetchDirectiveActuationSummaries } from '../coordination/directive-effect-read';
import type { DirectiveActuationSummary } from '../coordination/directive-effect';
import {
  classifyCoordDeafness,
  coordDeafBudgetMs,
  lastInboxReadAtBatch,
  type CoordDeafState,
} from '../coordination/inbox-read-freshness';
import { boundRowField, boundListField, trimToByteBudget } from '../_bound-output';
import { shapeFleetAssignments } from './assignments-shape';
import { getPlanRow, planItemsForRow, planSlugsForHarness } from '../plans/source';
import { resolveEffectiveStatusForItems } from '../plans/effective-status';
import { shapeDagFrontier, claimsFromCoverage, type DagFrontierView } from '../../fleet-dag-view';
import { getLoopStatuses, type LoopStatus, type LifecycleBackoffInfo } from '../../harness/routines/loop';
import { withBoundedTimeout } from '../../bounded-timeout';
import { getWorkItem, type WorkItem } from '../../work-items';
import {
  extractWorkItemIds,
  TERMINAL_WORK_ITEM_STATES,
} from '../work_items/mirror-guard';

/** Coverage levels most-covered → least, for sorting the rollup. Every member of
 *  CoverageLevel must appear: `indexOf` returns -1 for an unlisted one, which sorts
 *  it ABOVE 'complete' as if it were the most-covered band (pinned by a test). */
export const COVERAGE_ORDER = [
  'complete',
  'full',
  'partial',
  'held-stalled',
  'held-not-live',
  'unclaimed',
  'none',
];

/** A 'complete' coverage entry stays in the DEFAULT rollup only while its newest
 *  linked work-item update is this recent (EI-9015). */
export const COVERAGE_ACTIVE_WINDOW_MS = 7 * 24 * 3600 * 1000;

/**
 * Keep each fleet:assignments sub-read below the MCP client deadline. The
 * handler is a supervisory read: a slow optional leg must degrade its own
 * fields, not strand the whole roster (WI-3818 / EI-21526112676676081).
 */
export const FLEET_ASSIGNMENTS_SUBREAD_TIMEOUT_MS = 8_000;

const FLEET_ASSIGNMENTS_DEGRADED_LEG_ORDER = [
  'assignments',
  'intentWorkItems',
  'coverage',
  'harnessPlans',
  'wakeability',
  'recorded',
  'selfwake',
  'recordedEnded',
  'parkedOn',
  'contextPressure',
  'unanswered',
  'loop',
  'lastToolCalls',
  'wakeModeOverrides',
  'defaultWakeMode',
  'verdicts',
  'residue',
  'dag',
] as const;

/** Bound the extra intent-reference lookup independently of roster size. */
export const ABANDONED_INTENT_REF_CAP = 40;

export interface AbandonedIntentWorkItem {
  agentId: string;
  intent: string;
  workItemId: string;
  title: string;
  state: string;
  harness: string | null;
}

export type IntentWorkItemSnapshot = Pick<
  WorkItem,
  'id' | 'title' | 'state' | 'assignee' | 'harness'
>;

/** Keep population prefiltering and final detection on one reference grammar. */
export function hasIntentWorkItemReference(intent: string): boolean {
  return extractWorkItemIds(intent).length > 0;
}

/**
 * Detect the claimless-death blind spot (EI-21560781905286213): a member can
 * die after declaring a WI-/EI- intent but before it acquires the work-item.
 * Claim-primary orphan counters then have no row to inspect, so the lane looks
 * healthy precisely because ownership was never established.
 *
 * This is deliberately a detector, not a new ownership concept. The work item
 * must still resolve as non-terminal and unassigned, and the member's settled
 * lifecycle verdict must be dead.
 */
export function findAbandonedIntentWorkItems(
  agents: ReadonlyArray<
    Pick<AgentAssignment, 'agentId' | 'intent'> & { verdict?: MemberVerdict | null }
  >,
  itemsById: ReadonlyMap<string, IntentWorkItemSnapshot>,
): AbandonedIntentWorkItem[] {
  const out: AbandonedIntentWorkItem[] = [];
  const seen = new Set<string>();
  for (const agent of agents) {
    if (agent.verdict !== 'dead') continue;
    for (const workItemId of extractWorkItemIds(agent.intent)) {
      const item = itemsById.get(workItemId);
      if (!item || item.assignee || TERMINAL_WORK_ITEM_STATES.has(item.state.toLowerCase())) continue;
      const key = `${agent.agentId}\u0000${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        agentId: agent.agentId,
        intent: agent.intent,
        workItemId: item.id,
        title: item.title,
        state: item.state,
        harness: item.harness,
      });
    }
  }
  return out;
}

/**
 * EI-9015: the ACTIVE-scope coverage default. coord_links edges never expire, so the
 * unfiltered rollup replayed 60+ long-complete, unrelated plan entries on EVERY
 * mandated orient wake (the caller with no resolvable {agent} gets no inScope
 * narrowing at all). Default: keep everything still in motion (level !== 'complete'),
 * and keep 'complete' entries only when they are the caller's own lane
 * (`lanePlans`) or recently touched (~7d). An explicit `{plan}` query or
 * `fullCoverage:true` returns the untrimmed ledger. Pure — unit-tested directly.
 */
export function filterActiveCoverage(
  entries: PlanItemCoverage[],
  opts: {
    explicitPlan?: string | null;
    lanePlans?: Set<string> | null;
    fullCoverage?: boolean;
    now?: number;
  },
): PlanItemCoverage[] {
  if (opts.fullCoverage || opts.explicitPlan) return entries;
  const now = opts.now ?? Date.now();
  return entries.filter((c) => {
    if (c.level !== 'complete') return true;
    const hash = c.ref.indexOf('#');
    const plan = hash > 0 ? c.ref.slice(0, hash) : null;
    if (plan && opts.lanePlans?.has(plan)) return true;
    const ts = c.lastActivityAt?.getTime();
    return ts != null && now - ts <= COVERAGE_ACTIVE_WINDOW_MS;
  });
}

/**
 * Return the plan slugs represented by live linked coverage held by one or
 * more queried agents. An agent-scoped assignments read otherwise derives its
 * lane only from direct claim rows and the declared plan; a linked work-item
 * can be the sole evidence that the agent is working a plan item, so omitting
 * these refs makes duplicateCoverage silently inspect the wrong scope.
 *
 * Pure so the agent-scoped coverage boundary is regression-tested without PG.
 */
export function agentPlansFromLiveCoverage(
  entries: Iterable<PlanItemCoverage>,
  agentIds: ReadonlySet<string>,
): Set<string> {
  const plans = new Set<string>();
  if (agentIds.size === 0) return plans;
  for (const coverage of entries) {
    const hash = coverage.ref.indexOf('#');
    if (hash <= 0) continue;
    if (coverage.links.some((link) => link.holder != null && agentIds.has(link.holder))) {
      plans.add(coverage.ref.slice(0, hash));
    }
  }
  return plans;
}

/**
 * EI-6077 (detector gap): `AgentAssignment.alive` is heartbeat-freshness only
 * (the `fleet_assignment` view's `holder_alive`) — EI-6374 already downgrades it
 * for a CONFIRMED-ended session (adv_sessions.ended_at set), but a session that
 * is simply not coord-wakeable — no live `coord:inbox-wake:<id>` await, e.g. it
 * never registered one — still read `alive:true` here while coord:dispatch /
 * coord:send could not actually reach it. That mismatch is exactly what left the
 * Queen unable to tell "really runnable" from "just looks alive" without a
 * separate coord:presence call (the EI's filed evidence).
 *
 * Ports the SAME reconciliation fleet:status already applies (EI-5858,
 * fleet/fleet-roster.ts `foldFleetRoster`): derive `sessionState` from
 * coord:presence's own wakeability signal (P-001) and gate `alive` on it, so the
 * two "who's running" tools agree instead of leaving callers to cross-check both.
 *
 * Exported (not inlined in the handler) so it unit-tests with an injected
 * wakeability fetcher — no PG needed. Mutates `agents` in place and returns them;
 * a `fetchWakeabilityFn` rejection propagates — the caller decides best-effort.
 */
type ReconcilePresence = Pick<
  PresenceRecord,
  'heartbeatAt' | 'stale' | 'host' | 'pid' | 'source' | 'agentRole'
>;

export interface ReconcileWakeabilityOptions {
  /** Fetch presence-row liveness fields in one owner-scoped batch. */
  hydratePresence?: boolean;
  /** Enable the positive psu-host rescue for known non-cup roles. */
  psuHostPositiveAuthority?: boolean;
  /** Injectable batch presence read for PG-free tests and bounded callers. */
  fetchPresenceFn?: (ownerIds: string[]) => Promise<Map<string, ReconcilePresence>>;
  /** Injectable local psu-host lookup for PG-free tests. */
  findHostFn?: (ownerId: string) => unknown | null;
}

/** Production roster readers all need the same presence-backed psu-host leg. */
export const RECONCILE_WAKEABILITY_PRODUCTION_OPTIONS: ReconcileWakeabilityOptions = {
  hydratePresence: true,
  psuHostPositiveAuthority: true,
};

const fetchReconcilePresence: NonNullable<ReconcileWakeabilityOptions['fetchPresenceFn']> = async (ownerIds) => {
  const rows = await listPresence({ ownerIds });
  return new Map(
    rows.map((row) => [
      row.ownerId,
      {
        heartbeatAt: row.heartbeatAt,
        stale: row.stale,
        host: row.host,
        pid: row.pid,
        source: row.source,
        agentRole: row.agentRole,
      },
    ]),
  );
};

export async function reconcileWakeability<T extends AgentAssignment & { sessionState?: SessionState | null; confirmLiveness?: boolean | null; wakeable?: boolean | null; loopArmed?: boolean; selfWake?: SelfWakeSource }>(
  agents: T[],
  fetchWakeabilityFn: (ownerIds: string[]) => Promise<Map<string, WakeabilitySignals>> = fetchWakeability,
  fetchRecordedLiveFn: (ownerIds: string[]) => Promise<Set<string>> = recordedLiveOwnerIds,
  /** EI-19407725333778711: the forward-looking self-wake leg. Best-effort — a
   *  rejection degrades every row to "self-wake unknown" (fields absent) rather
   *  than failing the whole assignments read, because a supervisor losing one
   *  column must not cost it the roster it uses to supervise. */
  fetchSelfWakeFn: (ownerIds: string[]) => Promise<Map<string, SelfWakeSignals>> = fetchSelfWake,
  /** Positive session-log death evidence. A current recorded-live successor
   *  remains authoritative when both sets contain an owner. */
  fetchEndedRecordedFn: (ownerIds: string[]) => Promise<Set<string>> = endedRecordedOwnerIds,
  options: ReconcileWakeabilityOptions = {},
): Promise<T[]> {
  if (agents.length === 0) return agents;
  const ownerIds = agents.map((a) => a.agentId);
  const presence = options.hydratePresence
    ? await (options.fetchPresenceFn ?? fetchReconcilePresence)(ownerIds).catch(() => new Map())
    : new Map<string, ReconcilePresence>();
  const [wakeability, recordedLive, selfWake, recordedEnded] = await Promise.all([
    fetchWakeabilityFn(ownerIds),
    fetchRecordedLiveFn(ownerIds),
    fetchSelfWakeFn(ownerIds).catch(() => new Map<string, SelfWakeSignals>()),
    fetchEndedRecordedFn(ownerIds).catch(() => new Set<string>()),
  ]);
  const nowMs = Date.now();
  for (const a of agents) {
    const w = wakeability.get(a.agentId);
    if (!w) continue; // no signal (e.g. a federated peer) — leave heartbeat-only alive, sessionState unset.
    const p = presence.get(a.agentId);
    // Unification P-003: ONE derivation via the shared liveness oracle — the
    // recorded rescue, the zombie-await hardStale ceiling and the claims-held
    // suspect classification are all inside deriveVerdict now, identical to
    // coord:presence / fleet:status / the send-miss path.
    const v = deriveVerdict(
      {
        ownerId: a.agentId,
        heartbeatAt: p?.heartbeatAt ?? a.heartbeatAt,
        stale: p?.stale ?? !a.alive,
        host: p?.host,
        pid: p?.pid,
        source: p?.source,
        agentRole: p?.agentRole,
        claimsHeld: a.load > 0,
      },
      w,
      recordedLive,
      nowMs,
      undefined,
      {
        enabled: options.psuHostPositiveAuthority === true,
        negative: false,
        positive: options.psuHostPositiveAuthority === true,
        findHostFn: options.findHostFn ?? findLiveHost,
      },
      selfWake.get(a.agentId),
      recordedEnded,
    );
    a.sessionState = v.sessionState;
    // EI-21125380796386851: `suspect` is recoverable when the coordinator can
    // still deliver a wake. Keep the oracle's wakeability axis alongside the
    // session verdict so downstream lifecycle projections do not collapse that
    // state into terminal `dead`.
    a.wakeable = v.wakeable;
    // EI-19407725333778711: the forward-looking axis. Assigned only when the leg
    // actually resolved — an absent field means UNKNOWN, and must never be
    // written as `'none'`, which is an escalation-worthy claim.
    if (v.selfWake !== undefined) {
      a.loopArmed = v.loopArmed;
      a.selfWake = v.selfWake;
    }
    // WI-4400: the read is stale-ish when draining/suspect; expose the explicit
    // confirmation nudge through fleet:assignments (and coord:orient's me fold).
    a.confirmLiveness = v.confirmLiveness;
    if (v.sessionState === 'recorded') a.alive = true;
    if (v.sessionState === 'ended' || v.sessionState === 'suspect' || v.sessionState === 'draining') a.alive = false;
  }
  return agents;
}

/**
 * EI-8995 (one liveness verdict instead of three half-truths): the SINGLE derived
 * per-member lifecycle state a leader makes relaunch/re-steer decisions on. Fuses
 * the three signals that previously took a three-query join — heartbeat liveness
 * (`alive`), session state (`sessionState`, EI-6077), and REAL-work freshness
 * (last recorded tool invocation — the canary-first protocol's "a join event is
 * NOT liveness; verify a first turn" check, now a field):
 *
 *   dead            — session authoritatively ended, or no liveness evidence.
 *   stalled         — alive but not producing: a claim not advancing (the per-claim
 *                     stall signal) or holding work with no tool call in the window.
 *   speaking        — a tool call within the fresh window: REALLY working right now.
 *                     Outranks `stalled`: a speaking member with one stalled ITEM is a
 *                     re-steer (the item is in stalled[]), not a relaunch.
 *   first-turn-done — has completed real work (≥1 recorded tool call) but is not
 *                     currently fresh — between wakes / drained.
 *   joined          — coord presence registered, ZERO tool calls yet (boot window;
 *                     a join event is NOT liveness — this state names that
 *                     explicitly instead of leaving it to protocol memory).
 *   booted          — a live session that has not yet registered coord presence
 *                     (the bootstrap gap before `joined`).
 */
export type MonitorState = 'monitoring' | 'waiting' | 'parked-awaiting-capability';

export type MemberVerdict =
  | 'booted'
  | 'joined'
  | 'first-turn-done'
  | 'speaking'
  | MonitorState
  | 'stalled'
  | 'suspect'
  | 'dead';

/** A tool call within this window ⇒ `speaking` (really working right now). */
export const VERDICT_SPEAKING_FRESH_MS = 5 * 60_000;
/** Holding work-items with no tool call for this long ⇒ `stalled` (member-level). */
export const VERDICT_STALL_MS = 15 * 60_000;

/**
 * A healthy, reachable engine loop is productive lifecycle state, not absence
 * of work. An in-flight loop is `monitoring`; a loop between scheduled fires is
 * `waiting` (with nextFireAt); and an event-benched loop is explicitly
 * `parked-awaiting-capability`. A loop whose own dead-man verdict is stalled is
 * deliberately excluded so real failures still surface.
 */
export function deriveLoopMonitorState(
  loop: Pick<LoopStatus, 'active' | 'parked' | 'stalled'> | null | undefined,
  parkedOn: readonly string[] = [],
): MonitorState | null {
  if (!loop?.active || loop.stalled) return null;
  if (parkedOn.length > 0) return 'parked-awaiting-capability';
  return loop.parked ? 'monitoring' : 'waiting';
}

/**
 * Fold the loop engine's authoritative status into fleet lifecycle rows in one
 * batch. While the loop is healthy, stale item-progress timestamps do not make
 * the owner "stalled" or "declared-unclaimed": the loop state explains why it
 * is idle and when it will run again. The loop's own dead-man stall still wins.
 */
export async function decorateLoopMonitorStates<
  T extends AgentAssignment & {
    parkedOn?: string[];
    monitorState?: MonitorState | null;
    nextFireAt?: string | null;
    loopMode?: 'work' | 'monitor' | null;
    lifecycleBackoff?: LifecycleBackoffInfo | null;
  },
>(
  agents: T[],
  fetchStatuses: (ownerIds: string[]) => Promise<Map<string, LoopStatus>> = (ids) => getLoopStatuses(ids),
): Promise<
  Array<
    T & {
      monitorState: MonitorState | null;
      nextFireAt: string | null;
      loopMode: 'work' | 'monitor' | null;
      lifecycleBackoff: LifecycleBackoffInfo | null;
    }
  >
> {
  type Decorated = T & {
    monitorState: MonitorState | null;
    nextFireAt: string | null;
    loopMode: 'work' | 'monitor' | null;
    lifecycleBackoff: LifecycleBackoffInfo | null;
  };
  if (agents.length === 0) return agents as Decorated[];
  const statuses = await fetchStatuses(agents.map((a) => a.agentId));
  for (const a of agents) {
    const loop = statuses.get(a.agentId) ?? null;
    const state = deriveLoopMonitorState(loop, a.parkedOn ?? []);
    a.monitorState = state;
    a.nextFireAt = loop?.active ? loop.nextFireAt : null;
    // WI-5345: the loop's armed MODE ('work'|'monitor') is orthogonal to monitorState (the
    // lifecycle verdict) — surface it independently so a leader can tell a genuinely wedged
    // pure-monitor loop from a healthy work loop that is simply between items, without a
    // separate loop:status{ownerId} call.
    a.loopMode = loop?.active ? loop.mode : null;
    // EI-19381528967421062: a member whose loop backed off from a provider wall (rate-limit
    // / usage-cap) reads `active:true` with `nextFireAt` far in the future and NOTHING else
    // distinguishes that from "between wakes" — a leader reading this row alone cannot tell
    // "healthy, next tick in 60s" from "silenced for the next 100 minutes". Thread the SAME
    // derivation loop:status already computes (loop.lifecycleBackoff — see
    // computeLifecycleBackoff) so fleet:assignments/fleet:leader-brief carry it too, instead
    // of only being visible to a per-owner `loop:status` call the leader has to think to make.
    a.lifecycleBackoff = loop?.active ? (loop.lifecycleBackoff ?? null) : null;
    if (!state) continue;
    a.declaredUnclaimed = false;
    a.stalled = false;
    for (const claim of a.claims) {
      if (!claim.stalled) continue;
      claim.stalled = false;
      if (claim.activity === 'stalled') claim.activity = 'alive';
    }
    for (const item of a.queued) {
      if (item.activity === 'stalled') item.activity = 'alive';
    }
    if (a.doing?.activity === 'stalled') a.doing.activity = 'alive';
  }
  return agents as Decorated[];
}

/** Pure derivation — unit-tests without PG (the DI seam is decorateMemberVerdicts). */
export function deriveMemberVerdict(
  a: {
    present: boolean;
    alive: boolean;
    sessionState?: SessionState | null;
    /** The oracle's delivery axis; `suspect` is recoverable only when true. */
    wakeable?: boolean | null;
    /** The per-claim progress-stall rollup (AgentAssignment.stalled). */
    stalled: boolean;
    /** Work-item claims held (AgentAssignment.load). */
    load: number;
    /** Last recorded tool invocation (epoch ms), or null = none ever. */
    lastToolCallAtMs: number | null;
    /** WI-42457: last NON-housekeeping tool invocation (epoch ms) — the same
     *  `HOUSEKEEPING_TOOL_NAMES` exclusion `lastProductiveToolCallAtByOwner`
     *  applies. `null` means the member's ENTIRE tool history is housekeeping,
     *  i.e. it has never taken an agent-authored turn. `undefined` (field
     *  omitted) preserves the legacy any-tool behaviour, so no existing caller
     *  is stranded by this field's addition. */
    lastProductiveToolCallAtMs?: number | null;
    /** Healthy loop-owned monitor lifecycle, derived from the loop engine. */
    monitorState?: MonitorState | null;
    /** Active non-inbox-wake events:await registrations (decorateParkedOn).
     *  EI-15655: a member that ended/never armed its engine loop (so
     *  `monitorState` is null) but deliberately parked on a real event key
     *  — the "lane drained → park on an event" fleet-member pattern — has
     *  NO monitorState to short-circuit through, so without this field it
     *  fell through to the stale/quiet checks below and misread as
     *  stalled/first-turn-done. */
    parkedOn?: readonly string[] | null;
  },
  nowMs: number = Date.now(),
): MemberVerdict {
  // EI-18690950786179315: a CONFIRMED terminal sessionState (ended/suspect/draining
  // — the liveness oracle actually looked and found the session over) always wins:
  // truly dead. But `!a.alive` ALONE is a much weaker signal — it fires whenever
  // `reconcileWakeability` found NO wakeability row for this owner at all (e.g. its
  // coord_presence row is missing/expired, plausibly around a compaction respawn
  // that hasn't re-registered presence yet) — `sessionState` is then left unset,
  // not confirmed-dead. Previously that bare heartbeat-staleness short-circuited to
  // 'dead' unconditionally, even when a FRESH real tool call (the strongest
  // liveness signal this function has — see `speaking` below) proved the agent was
  // actively working: a leader saw a live, working agent's claims/state go
  // completely blank ("dead") mid-task, unable to tell it apart from a genuinely
  // gone holder. A fresh tool call now overrides a bare (unconfirmed) heartbeat-dead
  // read, matching this function's own "speaking outranks stalled" precedent.
  const speakingNow = a.lastToolCallAtMs != null && nowMs - a.lastToolCallAtMs <= VERDICT_SPEAKING_FRESH_MS;
  if (a.sessionState === 'ended' || a.sessionState === 'draining') return 'dead';
  // EI-21125380796386851: a suspect owner with a live inbox-wake await is
  // recoverable by waking it before any claim takeover. A suspect owner without
  // that delivery path remains terminal and must be reclaimed/relaunched.
  //
  // EI-21557715307606072: `wakeable:false` is also the transient shape while an
  // active member is already inside a turn (there is no inbox-wake await to
  // inject into). A fresh tool call is stronger evidence than that momentary
  // delivery gap, so preserve the member as speaking instead of putting it in
  // `dead_member_ids` and inviting a duplicate relaunch.
  if (a.sessionState === 'suspect') {
    if (speakingNow) return 'speaking';
    return a.wakeable === true ? 'suspect' : 'dead';
  }
  // EI-20980974612370508: a cold loop can be between wakes long enough for its
  // coord_presence heartbeat to disappear. The loop engine (and, below, a
  // registered event-await) is the stronger intentional-parking signal in that
  // gap; only a confirmed terminal session state above may override it.
  if (a.monitorState) return a.monitorState;
  // EI-15655 (fleet:leader-brief false-positive stalls): a member holding NO
  // claims that is deliberately parked on an events:await key is healthily
  // waiting for a pushed event, not "stuck between items" — this is the exact
  // "0 held claims is normal for a drain member mid-cycle" snapshot the leader
  // misread as dead-ended. Gated on `load === 0` so a member that ALSO holds a
  // genuinely stalled claim is never masked by an unrelated park.
  if (a.load === 0 && (a.parkedOn?.length ?? 0) > 0) return 'parked-awaiting-capability';
  if (!a.alive && !speakingNow) return 'dead';
  const last = a.lastToolCallAtMs;
  if (speakingNow) return 'speaking';
  // Member-level stall: not speaking AND (an item isn't advancing, or it holds work
  // and went quiet). `last == null` with load is NOT stalled — it has never taken a
  // turn, so it is still in the boot window (joined), not wedged mid-work.
  if (a.stalled || (a.load > 0 && last != null && nowMs - last > VERDICT_STALL_MS)) return 'stalled';
  // WI-42457: `first-turn-done` asserts REAL work ("≥1 recorded tool call"), but
  // `lastToolCallAtMs` counts HOOK-emitted housekeeping rows too, so a session
  // that never reached an assistant turn still satisfied `last != null`. Measured
  // on the P-003 acceptance canary su-respawn-829ef88b24abde91c8a6d37bdc2678a2:
  // its whole tool_invocations history was ONE `activity:report` (call_origin
  // 'hook'), it produced zero agent-authored tools — it died in the Codex
  // admission path — and this surface reported it first-turn-done. A launch that
  // never started then read as a launch that succeeded, which is strictly worse
  // than reporting nothing: the leader stops looking. A housekeeping-only history
  // is the `joined` boot window ("a join event is NOT liveness"), which is the
  // verdict that keeps the leader verifying instead of believing.
  //
  // Deliberately narrow: `speaking` (above) still fires on a fresh housekeeping
  // call — that IS live-process evidence, and "taking turns, doing nothing" is
  // computeSpinningAlert's job — and the `stalled` branch above is untouched, so
  // a housekeeping-only member HOLDING quiet claims still raises for relaunch
  // rather than being masked as a boot window.
  if (last != null && a.lastProductiveToolCallAtMs !== null) return 'first-turn-done';
  if (a.sessionState === 'recorded' || !a.present) return 'booted';
  return 'joined';
}

/**
 * Stamp each agent row with the derived `verdict`, its `wakeMode` (auto|manual —
 * a MANUAL member silently STAGES directed wakes for owner release, which a
 * leader cannot see anywhere else on this surface), and `lastToolCallAt`.
 * Batch reads: ONE tool-invocations top-1-per-owner query + ONE wake-mode
 * overrides read for the whole fleet. Exported with injectable fetchers so it
 * unit-tests without PG (the reconcileWakeability pattern). Mutates in place;
 * call AFTER reconcileWakeability so `sessionState` is already settled.
 */
export async function decorateMemberVerdicts<
  T extends AgentAssignment & {
    sessionState?: SessionState | null;
    wakeable?: boolean | null;
    verdict?: MemberVerdict;
    wakeMode?: WakeMode;
    lastToolCallAt?: string | null;
    monitorState?: MonitorState | null;
    parkedOn?: string[];
  },
>(
  agents: T[],
  fetchLastToolCalls: (ownerIds: string[]) => Promise<Map<string, string>> = lastToolCallAtByOwner,
  fetchWakeModeOverrides: () => Promise<Map<string, WakeMode>> = getAllWakeModeOverrides,
  fetchDefaultWakeMode: () => Promise<WakeMode> = getDefaultWakeMode,
  nowMs: number = Date.now(),
  // WI-42457: appended AFTER `nowMs` on purpose — inserting it earlier would
  // silently re-bind every existing positional caller's `nowMs` argument.
  fetchProductiveToolCalls: (
    ownerIds: string[],
  ) => Promise<Map<string, string>> = lastProductiveToolCallAtByOwner,
): Promise<T[]> {
  if (agents.length === 0) return agents;
  const [lastCalls, overrides, defaultMode, productiveCallsOrUnknown] = await Promise.all([
    fetchLastToolCalls(agents.map((a) => a.agentId)),
    fetchWakeModeOverrides(),
    fetchDefaultWakeMode(),
    // A THROWN fetch is "unknown", not "nobody worked": resolving it to null for
    // every member would flip a whole healthy fleet to `joined`. Unknown feeds
    // `undefined` below, which preserves the legacy any-tool verdict exactly.
    // (An empty map from the fail-soft fetcher itself still reads as "no
    // productive calls" and degrades toward `joined` — the conservative
    // direction: a leader keeps verifying rather than believing a first turn
    // that never happened.)
    fetchProductiveToolCalls(agents.map((a) => a.agentId)).catch(() => null),
  ]);
  for (const a of agents) {
    const iso = lastCalls.get(a.agentId) ?? null;
    const lastMs = iso ? Date.parse(iso) : null;
    const productiveIso = productiveCallsOrUnknown
      ? (productiveCallsOrUnknown.get(a.agentId) ?? null)
      : undefined;
    const productiveParsed = productiveIso == null ? productiveIso : Date.parse(productiveIso);
    a.lastToolCallAt = iso;
    a.verdict = deriveMemberVerdict(
      {
        present: a.present,
        alive: a.alive,
        sessionState: a.sessionState,
        wakeable: a.wakeable,
        stalled: a.stalled,
        load: a.load,
        lastToolCallAtMs: Number.isFinite(lastMs as number) ? lastMs : null,
        lastProductiveToolCallAtMs:
          productiveParsed === undefined || Number.isFinite(productiveParsed as number)
            ? productiveParsed
            : null,
        monitorState: a.monitorState,
        parkedOn: a.parkedOn,
      },
      nowMs,
    );
    a.wakeMode = resolveWakeModeFrom(overrides.get(a.agentId) ?? null, defaultMode);
  }
  return agents;
}

/**
 * EI-19307414464301772: stamp each agent row with `productiveToolCallAt` — the
 * last tool call that was NOT one of the per-turn housekeeping calls (see
 * `HOUSEKEEPING_TOOL_NAMES`). Companion to `decorateMemberVerdicts`'
 * `lastToolCallAt`, kept as its OWN decoration step (not folded into
 * `decorateMemberVerdicts`) so a caller that has no use for the spinning
 * signal pays for one fewer batched read — mirrors `decorateParkedOn`/
 * `decorateContextPressure`/etc. sitting beside `decorateMemberVerdicts`
 * rather than inside it. Exported with an injectable fetcher so it
 * unit-tests without PG (the `decorateMemberVerdicts` pattern). Mutates in
 * place; best-effort at the call site.
 */
export async function decorateProductiveToolCalls<
  T extends AgentAssignment & { productiveToolCallAt?: string | null },
>(
  agents: T[],
  fetchProductiveCalls: (ownerIds: string[]) => Promise<Map<string, string>> = lastProductiveToolCallAtByOwner,
): Promise<T[]> {
  if (agents.length === 0) return agents;
  const calls = await fetchProductiveCalls(agents.map((a) => a.agentId));
  for (const a of agents) {
    a.productiveToolCallAt = calls.get(a.agentId) ?? null;
  }
  return agents;
}

/**
 * P-001 (fleet-member-dx-improvements-2026-07-10, EI-9014): stamp each agent row
 * with `parkedOn` — the event keys of its ACTIVE non-inbox-wake events:await
 * registrations. An agent parked on a real key is DELIBERATELY idle (benched
 * awaiting a pushed event — typically a leader's "I'll emit when X greens"),
 * not abandoned: a leader sees who is parked on what without tracking benches
 * from memory, and the claim-discipline watch suppresses its nag (P-002).
 * DERIVED from the await store — no new state; the always-armed
 * `coord:inbox-wake:<id>` self-await never counts (every live agent holds one).
 * Exported with an injectable fetcher so it unit-tests without PG (the
 * decorateMemberVerdicts pattern). Mutates in place; best-effort at the call site.
 */
export async function decorateParkedOn<T extends AgentAssignment & { parkedOn?: string[] }>(
  agents: T[],
  fetchParkedAwaits: (
    ids: string[],
  ) => Promise<Array<{ subscriberId: string; eventKey: string }>> = listParkedAwaitsForSubscribers,
): Promise<T[]> {
  if (agents.length === 0) return agents;
  const rows = await fetchParkedAwaits(agents.map((a) => a.agentId));
  if (rows.length === 0) return agents;
  const byId = buildParkedOnMap(rows);
  for (const a of agents) {
    const keys = byId.get(a.agentId);
    if (keys && keys.length > 0) a.parkedOn = keys;
  }
  return agents;
}

/**
 * WI-3715 (fleet-leader-frictions-six-improvements-2026-07-10, P-001): the
 * `subscriberId → capped/deduped event-key list` grouping `decorateParkedOn`
 * above needs — pulled out so `coord:presence`'s own parkedOn overlay (the
 * item's other required surface) derives from the SAME cap/dedup rule
 * instead of re-implementing it, rather than forking a second copy.
 */
export function buildParkedOnMap(
  rows: ReadonlyArray<{ subscriberId: string; eventKey: string }>,
): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const r of rows) {
    const list = byId.get(r.subscriberId) ?? [];
    // Cap per-agent keys (a standing-watch hoarder shouldn't bloat every read).
    if (list.length < 6 && !list.includes(r.eventKey)) list.push(r.eventKey);
    byId.set(r.subscriberId, list);
  }
  return byId;
}

/**
 * P-007 (fleet-deltas-leader-primitives-2026-07-10): stamp each agent row with
 * `contextPressure` (ok|high|critical|null) — the fleet-health read of the SAME
 * watchdog-cached context signal the ambient gauge bands on (context-pressure.ts),
 * so a leader scanning fleet:assignments sees who is about to compact WITHOUT a
 * separate per-member coord:presence call. Exported with an injectable fetcher so
 * it unit-tests without PG (the decorateParkedOn pattern). Mutates in place;
 * best-effort at the call site.
 */
export async function decorateContextPressure<
  T extends AgentAssignment & {
    contextPressure?: ContextPressureBucket | null;
    contextPressureAgeSec?: number | null;
  },
>(
  agents: T[],
  fetchPressure: (ownerIds: string[]) => Promise<Map<string, ContextPressureReading | ContextPressureBucket>> =
    fetchContextPressureReadings,
): Promise<T[]> {
  if (agents.length === 0) return agents;
  const pressure = await fetchPressure(agents.map((a) => a.agentId));
  for (const a of agents) {
    const reading = pressure.get(a.agentId);
    a.contextPressure = typeof reading === 'string' ? reading : (reading?.bucket ?? null);
    a.contextPressureAgeSec = typeof reading === 'string' ? null : (reading?.ageSec ?? null);
  }
  return agents;
}

/**
 * P-007 (fleet-reliability-verification-2026-07-10): stamp each agent row with
 * `unanswered` — directed messages (never a broadcast/audience send) addressed
 * to this member with no reply/ack yet, from the recent lookback window
 * (see unanswered-directed.ts for the exact definitions). The night-shift gap
 * this closes: a leader hand-tracking "who hasn't answered me" from memory
 * across dozens of monitor wakes. Exported with an injectable fetcher so it
 * unit-tests without PG (the decorateContextPressure pattern). Mutates in
 * place; best-effort at the call site — a failure just omits the field.
 */
export async function decorateUnansweredDirected<
  T extends AgentAssignment & { unanswered?: UnansweredDirectedSummary },
>(
  agents: T[],
  fetchUnanswered: (ownerIds: string[]) => Promise<Map<string, UnansweredDirectedSummary>> = fetchUnansweredDirected,
): Promise<T[]> {
  if (agents.length === 0) return agents;
  const unanswered = await fetchUnanswered(agents.map((a) => a.agentId));
  for (const a of agents) {
    const u = unanswered.get(a.agentId);
    if (u) a.unanswered = u;
  }
  return agents;
}

/**
 * P-013 (fleet-leadership-continuity-and-actuation-2026-08-01): stamp each agent row
 * with `directives` — of the directives THIS leader sent that named a required side
 * effect (`coord:send { expectEffect }`), how many were actually CARRIED OUT.
 *
 * The sibling of `unanswered`, and deliberately a different question. `unanswered`
 * asks whether the member SAID something back; this asks whether the ledger shows the
 * thing happening. For a safety-critical instruction ("checkpoint before you
 * compact") those diverge exactly when it matters: an agent can answer "will do" and
 * then be killed before it does, and every existing surface reports that as answered.
 *
 * `fromId` scopes to the caller's OWN directives — a leader is accountable for the
 * instructions it issued, not for every message anyone ever sent that member.
 *
 * Injectable fetcher + mutate-in-place + best-effort at the call site, matching
 * decorateUnansweredDirected/decorateContextPressure exactly.
 */
export async function decorateDirectiveActuation<
  T extends AgentAssignment & { directiveActuation?: DirectiveActuationSummary },
>(
  agents: T[],
  fromId: string | undefined,
  fetchActuations: (
    ownerIds: string[],
    opts: { fromId?: string },
  ) => Promise<Map<string, DirectiveActuationSummary>> = fetchDirectiveActuationSummaries,
): Promise<T[]> {
  if (agents.length === 0) return agents;
  const summaries = await fetchActuations(
    agents.map((a) => a.agentId),
    fromId ? { fromId } : {},
  );
  for (const a of agents) {
    const d = summaries.get(a.agentId);
    // Only stamp a row that HAS expectations. A member nobody sent an
    // effect-bearing directive to must show no field at all, never a zeroed one —
    // an all-zero `directiveActuation` block reads as "I checked and they complied
    // with nothing", which is a claim we are not making.
    if (d && d.total > 0) a.directiveActuation = d;
  }
  return agents;
}

/**
 * coord-delivery-residual-gaps-2026-07-11 P-001: stamp each LIVE agent row with
 * `coordHook` ('stale' | 'missing' | null) + `coordLastReadAgoSec` — "is this
 * session actually SEEING its coord mail right now?". Every delivery leg's poll
 * is a real coord:inbox/orient row in tool_invocations, so deafness is
 * server-derivable: live + demonstrably active (fresh heartbeat) + no read for
 * a whole budget window ⇒ deaf (hook enrollment drifted, a runtime with no
 * injection leg, or one long foreground exec). NOTE: assignment rows carry no
 * session start time, so the never-read 'missing' class only fires here when a
 * `startedAt` is present on the row (leader-brief path leaves it absent →
 * stale-only); the coord:presence overlay carries the full classification.
 * Injectable fetcher for PG-free unit tests (the decorateContextPressure
 * pattern). Mutates in place; best-effort at the call site.
 */
export async function decorateCoordDeafness<
  T extends AgentAssignment & {
    sessionState?: SessionState | null;
    startedAt?: string | null;
    coordHook?: CoordDeafState | null;
    coordLastReadAgoSec?: number | null;
  },
>(
  agents: T[],
  fetchReads: (ownerIds: string[]) => Promise<Map<string, string>> = lastInboxReadAtBatch,
  nowMs: number = Date.now(),
  budgetMs: number = coordDeafBudgetMs(),
): Promise<T[]> {
  const live = agents.filter((a) => a.sessionState === 'live');
  if (live.length === 0) return agents;
  const reads = await fetchReads(live.map((a) => a.agentId));
  for (const a of live) {
    const hbMs = a.heartbeatAt ? Date.parse(a.heartbeatAt) : NaN;
    const verdict = classifyCoordDeafness(
      {
        sessionState: a.sessionState,
        lastActiveSecAgo: Number.isFinite(hbMs) ? Math.max(0, (nowMs - hbMs) / 1000) : null,
        startedAt: a.startedAt ?? null,
        lastReadAt: reads.get(a.agentId) ?? null,
      },
      nowMs,
      budgetMs,
    );
    if (verdict) {
      a.coordHook = verdict.state;
      a.coordLastReadAgoSec = verdict.lastReadAgoSec;
    }
  }
  return agents;
}

export default defineTool({
  name: 'fleet:assignments',
  profile: 'engineer',
  description:
    'The canonical "who\'s on what" query: per-agent presence + plan-item + work-item claims unified. `self`=your ownerId (your row is `isSelf:true`). Each live agent carries its ordered work-list — `doing`/`queued`/`load` — the placement read. Surfaces `orphaned`/`stalled` claims with a derived `verdict`+`action`: `orphan`/`reclaim` (holder gone) · `held-by-live-agent`/`ask` (live, uncheckpointed — never release) · `residue`/`close` (linked plan item already done/dropped — close, never release). Act on `summary.reclaimable_claims`/`residue_claims`, not raw counts. `progress` distinguishes `never-checkpointed` vs `stale-since`; each row also carries a lifecycle `verdict`, `wakeMode` (auto|manual), and `unanswered` message state. Read this, not a stale coord broadcast. Full field reference: /internal/docs/agent-insights/fleet-assignments-field-reference.',
  guidance: {
    when: 'Answering "who\'s running / what X is doing / X\'s work-list / how loaded X is / who\'s on plan P" — the state + placement-decision read, not coord:inbox scanning.',
    notWhen:
      'You want future-change notifications (subscribe the fleet_assignment change-feed) or full message history (coord:inbox).',
    chaining:
      'fleet:assignments { plan } → action:\'reclaim\' → work_items:release/plan_items:release, or take it; action:\'ask\' → coord:send + WAIT, never release; action:\'close\' → work_items:complete/set_state citing `residue`, NEVER release. Never assume "someone\'s on it" from a coord message; fleet:assignments { agent } before messaging them.',
    // Result-aware (D-003): the work_items:release pointer surfaces with a REAL
    // count ONLY when there are orphaned/stalled claims to reclaim — dynamically
    // gated so a clean fleet pays no "See also:" bloat. The two adjacent-lens
    // pointers are always relevant, so they stay static in the returned list.
    seeAlso: (result) => {
      const j = readJsonResult<{
        summary?: { reclaimable_claims?: number; residue_claims?: number };
      }>(result);
      // seeAlso runs on the SERIALIZED result — the {data} envelope may be TOON
      // on the MCP transport (readJsonResult → undefined). TOON renders nested
      // scalars as `reclaimable_claims: N` lines, so a cheap regex keeps the
      // conditional reclaim pointer alive on compact responses (fail-open to 0).
      const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
      const num = (key: string): number => Number(new RegExp(`\\b${key}\\b["']?\\s*:\\s*(\\d+)`).exec(text)?.[1] ?? 0);
      // WI-5975: count ONLY genuinely-reclaimable claims (holder gone). This
      // previously summed orphaned+stalled, so a fleet whose every "stalled"
      // claim was held by a live, actively-working agent still got told to go
      // free N claims — the tool prescribing the exact action the bug is about.
      const reclaimable = j?.summary?.reclaimable_claims ?? num('reclaimable_claims');
      // EI-18763117665515043: residue claims are NEVER counted into the
      // work_items:release nudge above — releasing residue just re-places
      // already-done work. They get their own pointer, to the close-it verbs.
      const residue = j?.summary?.residue_claims ?? num('residue_claims');
      const out: SeeAlsoEntry[] = [
        'coord:roster { view:"claims" } (the unified who-on-what-item lens)',
        "fleet:status (the fleet's leader + live members)",
      ];
      if (residue > 0) {
        out.unshift({
          tool: 'work_items:complete',
          reason: `close ${residue} claim${residue === 1 ? '' : 's'} whose linked plan item is already done/dropped (never release these)`,
        });
      }
      if (reclaimable > 0) {
        out.unshift({
          tool: 'work_items:release',
          reason: `free ${reclaimable} orphaned/stalled claim${reclaimable === 1 ? '' : 's'}`,
        });
      }
      return out;
    },
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  // EI-20228676874653267: this placement read resolves its own workspace and
  // DB accessors and never reads ctx.tx. Holding an ambient transaction across
  // the roster/decorations fan-out consumes an org-app slot for the whole call
  // and can strand concurrent fleet-control reads at acquire deadline.
  skipWorkspaceTx: true,
  // Fleet assignment responses are intentionally bounded to a placement-sized
  // payload, but can still exceed the generic result door when include_stale
  // exposes a large roster. The response remains structured JSON for ptool and
  // the model-facing reader can follow the payload's truncation hints instead
  // of receiving a JSON prefix plus a prose result-door footer.
  skipResultDoor: 'oversize-by-design',
  agentRoles: [...COORD_ROLES],
  args: z.object({
    agent: z
      .string()
      .max(120)
      .optional()
      .describe('Filter to one agent (ownerId or adopted agent-name) — "what is X doing".'),
    plan: z.string().max(200).optional().describe('Filter to one plan slug — "who\'s on P".'),
    fleet: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Filter to one fleet slug — "who\'s on fleet F". Matches fleet_slug on every row (presence + claims), independent of which plan(s) the fleet happens to be working — the correct scope when a fleet runs multiple plans (EI-18689331932953939).',
      ),
    harness: z.string().max(80).optional(),
    workspace: z.string().max(120).optional(),
    include_stale: z
      .boolean()
      .optional()
      .describe(
        'Also list stale idle agents (no claims, old heartbeat). Default false. Orphaned claims always show regardless.',
      ),
    include_lapsed: z
      .boolean()
      .optional()
      .describe('Include lapsed (expired, unreclaimed) plan-item leases. Default false.'),
    fullCoverage: z
      .boolean()
      .optional()
      .describe(
        "Include long-complete historical coverage entries (the full ledger). Default false: 'complete' entries are kept only for your lane plans or with recent (~7d) activity (EI-9015).",
      ),
    includeDag: z
      .boolean()
      .optional()
      .describe(
        "Also return the plan's DAG-filter frontier (EI-6949): every item the fleet's dependency DAG selects, with per-item status (ready|blocked|claimed|wip|done|dropped) + blockedBy/unresolvedBlockers/claimedBy/files + counts. Reuses the SAME plan-item DAG state the spawner admits from, so `ready` = what would be placed next. Requires `plan`; off by default (the frontier is fleet-level, kept off the per-agent presence path). Opt-in so the default read stays lean.",
      ),
  }),
  // context-trimming-tiers P-022: trimmed/standard sessions get the placement
  // decision core (summary + reclaimables + compact agent rows — see
  // assignments-shape.ts). The pui bee-dossier reads this over HTTP (no
  // ctx_tier) → always full.
  shape: {
    standard: (data) => shapeFleetAssignments(data, 'standard'),
    trimmed: (data) => shapeFleetAssignments(data, 'trimmed'),
    // WI-2145871: retires this tool's `unclassified-baseline` debt entry. The
    // shaper rebuilds its envelope from a hand-written key list, which is the
    // exact shape that dropped the top-level `scope` block once already
    // (EI-18763132241176410) — a self-scoped `agents:1, claims:0` then reads
    // identically to a measured-empty fleet. `ok` and `summary` are the two
    // keys that list emits UNCONDITIONALLY, so they are the ones a pin can
    // hold; the conditional blocks (`scope`, `self`, `degraded*`) are absent
    // from a well-formed result by design and cannot be guarded this way.
    contract: { rows: 'agents', preserve: ['ok', 'summary'] },
  },
  async handler(args, ctx) {
    // A READ — identity is used only to default the optional workspace filter
    // (null = all workspaces). Resolve it SOFTLY so a bare loopback caller (the
    // pui bee-dossier pane, the IPC sys:http bridge) can read the state without
    // an attributable coord identity — this is not a coordination write.
    let actorWorkspace: string | null = null;
    try {
      actorWorkspace = resolveAgentIdentity(ctx).workspaceId ?? null;
    } catch {
      actorWorkspace = null;
    }
    // `self` is a caller-relative filter token, not an ownerId that can be
    // passed through to the view. Resolve it before the query so the targeted
    // read actually returns the caller's rows (and never widens to a fleet-wide
    // read when an anonymous caller cannot resolve the token).
    const self = resolveSelfRef(ctx);
    const queryAgent =
      args.agent === 'self' ? self?.ownerId ?? '__unresolvable_self__' : args.agent;
    // F-M1 (workspace-data-isolation-leaks): when neither an explicit workspace nor
    // a resolved identity is present, default to the ACTIVE workspace rather than
    // null (= ALL workspaces), so a bare loopback caller no longer reads every
    // workspace's fleet state. The data layer still ORs in GLOBAL + the plan-store
    // DEFAULT_WORKSPACE_ID scope (EI-295), so claim rows are preserved.
    //
    // EI-13820: `ctx.workspaceId` is the literal '*' sentinel for an unscoped su
    // session (EI-9013 — the identical class already fixed in coord:orient's
    // compaction-recovery leg). A bare `?? actorWorkspace ?? activeWorkspaceId()`
    // treated '*' as a concrete workspace and passed it straight into
    // listFleetAssignments' `workspace_id = $1` equality filter, which no real row
    // ever matches — silently zeroing the caller's OWN presence/claims (agents:0,
    // alive:0, claims:0) even while e.g. fleet:leader-brief showed the same fleet
    // very much alive. resolveConcreteWorkspaceId skips '*'/blank candidates and
    // falls through to the concrete active workspace instead of leaking the
    // sentinel into the query.
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, actorWorkspace);
    const degradedLegs = new Set<string>();
    const boundedRead = async <T>(
      label: string,
      work: () => Promise<T>,
      fallback: T,
    ): Promise<T> => {
      const result = await withBoundedTimeout(work, {
        fallback,
        timeoutMs: FLEET_ASSIGNMENTS_SUBREAD_TIMEOUT_MS,
        label: `fleet:assignments:${label}`,
      });
      if (result.degraded) degradedLegs.add(label);
      return result.value;
    };

    // Start the independent top-level reads together. In particular, a stalled
    // assignment query must not prevent the coverage read from making progress,
    // and neither may hold the caller until the MCP client gives up.
    const rowsPromise = boundedRead(
      'assignments',
      () =>
        listFleetAssignments({
          workspaceId,
          agent: queryAgent,
          plan: args.plan,
          fleet: args.fleet,
          harness: args.harness,
          activeOnly: !args.include_lapsed,
        }),
      [] as FleetAssignmentRow[],
    );
    const coveragePromise = boundedRead(
      'coverage',
      () => getAllPlanItemCoverage(),
      new Map<string, PlanItemCoverage>(),
    );
    const harnessPlansPromise =
      args.harness && !args.plan
        ? boundedRead(
            'harnessPlans',
            () => planSlugsForHarness(workspaceId, args.harness as string),
            new Set<string>(),
          )
        : Promise.resolve<Set<string> | null>(null);
    const [rows, coverageRead, harnessPlans] = await Promise.all([
      rowsPromise,
      coveragePromise,
      harnessPlansPromise,
    ]);
    // P-010 (fleet-lead-instrumentation-audit-2026-08-09): the filter and the
    // number that describes it are derived together, so this response can say
    // WHICH population its `agents` count counted. Same fleet, same minutes:
    // leader-brief said 11 and 14, this tool said 8 and 9 — all correct, none
    // reconciled, so a leader comparing two of them sees members appear/vanish.
    const groupedAgents = groupByAgent(rows);
    const basePopulationPredicate = (g: AgentAssignment): boolean =>
      Boolean(args.include_stale || g.claims.length > 0 || g.alive);
    // Stale idle rows are normally filtered before liveness decoration. Preserve
    // only intent-bearing candidates long enough to settle their verdict and
    // inspect the referenced item; non-findings are removed below.
    let agents: (AgentAssignment & {
      sessionState?: SessionState | null;
      wakeable?: boolean | null;
      /** Stamped by decorateMemberVerdicts — the holder's last GENUINE work signal
       *  (WI-5975 reads it to tell a quiet-but-working holder from an absent one). */
      lastToolCallAt?: string | null;
      productiveToolCallAt?: string | null;
      contextPressure?: ContextPressureBucket | null;
      contextPressureAgeSec?: number | null;
      unanswered?: UnansweredDirectedSummary;
      parkedOn?: string[];
      monitorState?: MonitorState | null;
      nextFireAt?: string | null;
      loopMode?: 'work' | 'monitor' | null;
      verdict?: MemberVerdict;
    })[] = groupedAgents.filter(
      (g) => basePopulationPredicate(g) || hasIntentWorkItemReference(g.intent),
    );
    const runDecoration = async (label: string, work: () => Promise<unknown>): Promise<void> => {
      try {
        await work();
      } catch {
        // Preserve the pre-existing best-effort contract, but make the omitted
        // leg visible to the caller instead of silently returning a partial read.
        degradedLegs.add(label);
      }
    };

    // EI-6077 / P-001 / P-007: these reads are independent once the agent rows
    // exist. Start them together, with each underlying fetch bounded separately
    // so one slow PG leg cannot consume the whole handler's request budget.
    await Promise.all([
      runDecoration('wakeability', () =>
        reconcileWakeability(
          agents,
          (ids) =>
            boundedRead(
              'wakeability',
              () => fetchWakeability(ids),
              new Map<string, WakeabilitySignals>(),
            ),
          (ids) =>
            boundedRead(
              'recorded',
              () => recordedLiveOwnerIds(ids),
              new Set<string>(),
            ),
          (ids) =>
            boundedRead(
              'selfwake',
              () => fetchSelfWake(ids),
              new Map<string, SelfWakeSignals>(),
            ),
          (ids) =>
            boundedRead(
              'recordedEnded',
              () => endedRecordedOwnerIds(ids),
              new Set<string>(),
            ),
          RECONCILE_WAKEABILITY_PRODUCTION_OPTIONS,
        ),
      ),
      // P-001 (fleet-member-dx): stamp `parkedOn` — active non-inbox-wake
      // events:await keys — so a deliberately-benched member reads as parked,
      // not abandoned.
      runDecoration('parkedOn', () =>
        decorateParkedOn(agents, (ids) =>
          boundedRead(
            'parkedOn',
            () => listParkedAwaitsForSubscribers(ids),
            [] as Array<{ subscriberId: string; eventKey: string }>,
          ),
        ),
      ),
      runDecoration('contextPressure', () =>
        decorateContextPressure(agents, (ids) =>
          boundedRead(
            'contextPressure',
            () => fetchContextPressureReadings(ids),
            new Map<string, ContextPressureReading>(),
          ),
        ),
      ),
      runDecoration('unanswered', () =>
        decorateUnansweredDirected(agents, (ids) =>
          boundedRead(
            'unanswered',
            () => fetchUnansweredDirected(ids),
            new Map<string, UnansweredDirectedSummary>(),
          ),
        ),
      ),
    ]);

    // P-010: loop state depends on parkedOn (parked event keys change the
    // lifecycle verdict), so it starts after the independent first wave settles.
    await runDecoration('loop', () =>
      decorateLoopMonitorStates(agents, (ids) =>
        boundedRead(
          'loop',
          () => getLoopStatuses(ids),
          new Map<string, LoopStatus>(),
        ),
      ),
    );

    // EI-8995: verdicts depend on wakeability, parked events, and loop state;
    // their three source reads are independent and bounded in the helper call.
    await runDecoration('verdicts', () =>
      decorateMemberVerdicts(
        agents,
        (ids) =>
          boundedRead(
            'lastToolCalls',
            () => lastToolCallAtByOwner(ids),
            new Map<string, string>(),
          ),
        () =>
          boundedRead(
            'wakeModeOverrides',
            () => getAllWakeModeOverrides(),
            new Map<string, WakeMode>(),
          ),
        () =>
          boundedRead(
            'defaultWakeMode',
            () => getDefaultWakeMode(),
            'auto' as WakeMode,
          ),
      ),
    );
    const deadIntentWorkItemIds = [
      ...new Set(
        agents
          .filter((a) => a.verdict === 'dead')
          .flatMap((a) => extractWorkItemIds(a.intent)),
      ),
    ].slice(0, ABANDONED_INTENT_REF_CAP);
    const intentWorkItems = await boundedRead(
      'intentWorkItems',
      async () => {
        const resolved = await Promise.all(
          deadIntentWorkItemIds.map(async (id) => [id, await getWorkItem(id, args.harness)] as const),
        );
        return new Map(
          resolved.filter((entry): entry is readonly [string, WorkItem] => entry[1] != null),
        );
      },
      new Map<string, WorkItem>(),
    );
    const abandonedIntents = findAbandonedIntentWorkItems(agents, intentWorkItems);
    const abandonedIntentOwners = new Set(abandonedIntents.map((row) => row.agentId));
    const agentPopulation = selectFleetPopulation(
      groupedAgents,
      (g) => basePopulationPredicate(g) || abandonedIntentOwners.has(g.agentId),
      {
        population: 'agent(s) in scope',
        basis:
          'A row is in scope if this query resolved it (claim rows plus presence-only members); it ' +
          'is shown if it holds a claim, is alive (heartbeat-fresh), has an abandoned nonterminal ' +
          'unassigned WI-/EI- named in its dead member intent, or unconditionally under include_stale.',
        withheldReason: 'idle AND not heartbeat-fresh (stale-idle) with no abandoned intent item',
        reveal:
          'coord:presence { owner: "<agentId>" } (targeted stale-row lookup; broad stale-roster reads are unsupported)',
      },
    );
    agents = agentPopulation.rows;
    // EI-18698865231464142: `orphaned`/`stalled` below read straight off `rows`,
    // whose `.orphaned` was set by the DATA layer's endedRecordedOwnerIds-keyed
    // downgrade — which has no key for a non-session (role-string) holder like
    // 'improvement-runner'. `reconcileWakeability` above just settled the FULLER
    // wakeability-oracle `sessionState` for every agent, independent of whether it
    // has an adv_sessions row; propagate its confirmed-ended verdicts onto any
    // claim row that downgrade never reached, so a holder this tool itself reports
    // `sessionState:'ended'` for can never again vanish from BOTH reclaim lists.
    const oracleEndedOwners = new Set(
      agents.filter((a) => a.sessionState === 'ended').map((a) => a.agentId),
    );
    const reconciledRows = reconcileOrphanedWithVerdicts(rows, oracleEndedOwners);
    const orphans = orphanedClaims(reconciledRows);
    // agent-activity-liveness-truth P-002/P-005: a live-but-not-progressing holder
    // is NOT "covered" — surface stalled claims as reclaimable alongside orphans, so
    // no reader concludes "someone's on it" from a claim that isn't advancing.
    const healthyLoopOwners = new Set(
      agents.filter((a) => a.monitorState != null).map((a) => a.agentId),
    );
    // WI-5975: the holder-liveness map every reclaim-candidate row is summarized
    // against. `agents` is already decorated (reconcileWakeability →
    // `sessionState`, decorateMemberVerdicts → `lastToolCallAt`), so the
    // AUTHORITATIVE verdict is in hand here — it just never reached the rendered
    // rows, which is why a claim held by an agent heartbeating 2s ago was
    // reported to leaders in the same shape, and same reclaimable bucket, as a
    // claim whose holder was genuinely gone.
    const holderActivity = new Map<string, HolderActivity>(
      agents.map((a) => [
        a.agentId,
        {
          sessionState: a.sessionState ?? null,
          lastToolCallAt: a.lastToolCallAt ?? null,
          productiveToolCallAt: a.productiveToolCallAt ?? null,
          wakeable: a.wakeable ?? null,
          monitorState: a.monitorState ?? null,
          parkedOn: a.parkedOn ?? null,
        },
      ]),
    );
    // P-006: progress-derived claim health is the recovery guard, not just a rendered
    // decoration. Stale-claim recovery surfaces must not invite reclaim/takeover when
    // the richer writer evidence says the holder is healthy, deliberately waiting,
    // recoverable by wake, or internally contested. Only genuinely suspect progress
    // remains in the stalled/reclaimable bucket.
    const stalled = stalledClaims(reconciledRows).filter((row) => {
      if (row.agentId && healthyLoopOwners.has(row.agentId)) return false;
      const health = deriveClaimHealth(row, row.agentId ? (holderActivity.get(row.agentId) ?? null) : null);
      return shouldRecoverClaimFromHealth(health);
    });

    const rowByAgentAndId = new Map<string, FleetAssignmentRow>();
    for (const row of reconciledRows) {
      if (!row.agentId) continue;
      const id = row.itemId ?? row.workItemId;
      if (!id) continue;
      rowByAgentAndId.set(`${row.agentId}\0${id}`, row);
    }
    for (const agent of agents) {
      const holder = holderActivity.get(agent.agentId) ?? null;
      for (const claim of agent.claims) {
        const row = claim.id ? rowByAgentAndId.get(`${agent.agentId}\0${claim.id}`) : null;
        if (row) claim.claimHealth = deriveClaimHealth(row, holder);
      }
    }
    // EI-18763117665515043: a claim's liveness verdict is meaningless when the
    // claim's OWN linked plan item is already terminal (done/dropped) — the claim
    // is stale residue of finished work, not abandoned or quiet-but-live work.
    // Resolved over the reclaim-candidate set only (orphaned + stalled), the same
    // rows summarizeFor renders — never the whole fleet. Best-effort: a lookup
    // outage just leaves every row on the liveness-only verdict (today's behaviour).
    // The fallback's type is DERIVED from the function's own return type rather than
    // hand-restated. A structural copy of PlanItemLaneBlock here silently went stale when
    // that interface gained `reason` (TS2345 at the summarizeFor call below, +1 over
    // baseline — a fleet-wide gate red, since test:affected is type-blind and cannot see
    // it). Deriving it means the next field added there cannot reopen this.
    const residueMap = await boundedRead(
      'residue',
      () => resolveTerminalPlanItemResidue([...orphans, ...stalled]),
      new Map() as Awaited<ReturnType<typeof resolveTerminalPlanItemResidue>>,
    );
    const summarizeFor = (row: FleetAssignmentRow) =>
      summarizeOrphan(
        row,
        row.agentId ? (holderActivity.get(row.agentId) ?? null) : null,
        undefined,
        row.workItemId ? (residueMap.get(row.workItemId) ?? null) : null,
      );
    const orphanRows = orphans.map(summarizeFor);
    const stalledRows = stalled.map(summarizeFor);
    // WI-5975: only rows whose holder the oracle says is GONE are reclaimable.
    // A live holder that has not checkpointed is surfaced (it is still a real
    // "not visibly advancing" signal) but counted separately, so neither the
    // summary nor the work_items:release nudge below can advise reclaiming work
    // out from under an agent that is alive and mid-task.
    // EI-18763117665515043: residue rows (linked plan item already terminal) are
    // excluded from BOTH buckets — they are neither safely reclaimable-by-release
    // (that just re-places already-done work) nor a "live holder, go ask" case.
    const residueRows = [...orphanRows, ...stalledRows].filter(isResidueCandidate);
    const reclaimableRows = [...orphanRows, ...stalledRows].filter(isReclaimCandidate);
    const liveHeldRows = [...orphanRows, ...stalledRows].filter(
      (s) => !isReclaimCandidate(s) && !isResidueCandidate(s),
    );
    // Plan-item COVERAGE rollup: which plan items are being worked via a LINKED
    // work-item (or a direct claim) even when no plan-item lease names them — the
    // blind spot that makes plans:items show an actively-worked item as unworked.
    // Fuses work→plan_item edges + the work-item's liveness + any direct plan-item
    // claim. Filtered to the queried plan when `plan` is set; bounded for output.
    // Non-fatal — a coverage outage just omits the section.
    //
    // The SAME fused map also yields COVERAGE COLLISIONS (EI-6074): a plan item
    // directly claimed by one principal while a linked live work-item covering the
    // same deliverable is held by a DIFFERENT principal — the cross-claim-table
    // duplicate the per-type dedup floor can't see (orphaned/stalled both read 0
    // while two live bees run the same work). Surfaced as a reclaimable-grade
    // coordination smell so the Queen sees it without eyeballing intents.
    const COVERAGE_CAP = 60;
    let coverageOut: {
      plan: string;
      item: string;
      level: string;
      workers?: string[];
      links?: { id: string; rel: string; activity: string; terminal: boolean }[];
    }[] = [];
    let coverageTruncated = false;
    let collisions: CoverageCollision[] = [];
    let duplicates: CoverageDuplicate[] = [];
    // Reuse the bounded top-level coverage read for both the rollup and the
    // optional DAG frontier — one getAllPlanItemCoverage() call, not two. If
    // harness scoping failed, omit this section rather than widening an
    // uncertain scope to another harness.
    let covMap: Awaited<ReturnType<typeof getAllPlanItemCoverage>> | null =
      degradedLegs.has('coverage') ||
      (args.harness != null && !args.plan && degradedLegs.has('harnessPlans'))
        ? null
        : coverageRead;
    if (covMap) {
      try {
      // Scope to the queried plan (when set) the same way coverage is, so a
      // { plan } filter narrows both the coverage rollup AND the collision list.
      // P-003 (fleet-member-dx, EI-9017): an {agent}-scoped read (e.g. coord:orient's
      // `me` sub-read on every wake) previously still returned the WHOLE workspace
      // coverage table (~60 rows of other agents' plans) — coverage was plan-scoped
      // but never agent-scoped. When `agent` is set and `plan` is not, restrict the
      // rollup to the plans that agent actually touches (its claim rows + declared
      // plan + live linked coverage). An agent touching no plans gets an empty
      // rollup (correct — nothing it works is covered elsewhere); an explicit
      // {plan} still wins. Linked coverage must be included before duplicate/
      // collision detection so a plan represented only by a live work-item link
      // cannot disappear from the agent-scoped correctness view.
      const agentIds = args.agent && !args.plan
        ? new Set([
            args.agent,
            ...rows
              .filter((r) => r.agentId && (r.agentId === args.agent || r.agentName === args.agent))
              .map((r) => r.agentId as string),
          ])
        : null;
      const linkedAgentPlans = agentIds
        ? agentPlansFromLiveCoverage(covMap.values(), agentIds)
        : new Set<string>();
      const agentPlans: Set<string> | null =
        agentIds
          ? new Set(
              [
                ...rows.map((r) => r.planSlug),
                ...agents.map((a) => a.declaredPlanSlug),
                ...linkedAgentPlans,
              ].filter((s): s is string => typeof s === 'string' && s.length > 0),
            )
          : null;
      // EI-6176: a passed `harness` filter narrowed EVERY other section of this
      // read (rows/agents above are queried `WHERE harness_slug = args.harness`)
      // but was silently ignored here — the coverage rollup returned every OTHER
      // harness's plan-item coverage too (a hive-confined caller like
      // `fleet:assignments { harness: 'oddsmith' }` saw a sibling hive's plan
      // leak straight through, matching the harness_forbidden enforcement other
      // tools already apply to a `harness` arg). Scope to the queried harness's
      // OWN plans, ANDed with the plan/agent narrowing above (an explicit
      // `{ plan }` still wins outright — it names one plan directly).
      const inScope = (ref: string): boolean => {
        const hash = ref.indexOf('#');
        const plan = hash > 0 ? ref.slice(0, hash) : null;
        if (args.plan) return plan === args.plan;
        if (harnessPlans && (plan == null || !harnessPlans.has(plan))) return false;
        if (agentPlans) return plan != null && agentPlans.has(plan);
        return true;
      };
      const scoped = [...covMap.values()].filter((c) => inScope(c.ref));
      // Collisions are computed over the UNTRIMMED scope — the active-coverage
      // default below is a payload filter, never a correctness filter.
      collisions = coverageCollisions(scoped);
      // Same-principal duplicates use the same untrimmed scope: active-coverage
      // filtering is a payload reduction, never a correctness filter.
      duplicates = duplicateCoverage(scoped);
      const entries = filterActiveCoverage(scoped, {
        explicitPlan: args.plan ?? null,
        lanePlans: agentPlans,
        fullCoverage: args.fullCoverage,
      })
        // 'none' carries no signal worth surfacing here (it's the absence of coverage).
        .filter((c) => c.level !== 'none')
        // Most-covered first: complete/full/partial/unclaimed.
        .sort((a, b) => COVERAGE_ORDER.indexOf(a.level) - COVERAGE_ORDER.indexOf(b.level));
      coverageTruncated = entries.length > COVERAGE_CAP;
      coverageOut = entries.slice(0, COVERAGE_CAP).map((c) => {
        const hash = c.ref.indexOf('#');
        const compact = compactCoverage(c);
        return {
          plan: hash > 0 ? c.ref.slice(0, hash) : c.ref,
          item: hash > 0 ? c.ref.slice(hash + 1) : c.ref,
          level: compact.level,
          ...(compact.workers ? { workers: compact.workers } : {}),
          ...(compact.links ? { links: compact.links } : {}),
        };
      });
      } catch {
        // Non-fatal — omit the coverage section, but report the failed fold.
        degradedLegs.add('coverage');
        covMap = null;
      }
    }
    // DAG-filter frontier (EI-6949, includeDag): the whole set of items the plan's
    // dependency DAG selects, each with its disposition — a FLEET-level work-graph
    // view surfaced ONLY on request (never on the per-agent presence path, which
    // would duplicate this list across every agent's row). Reuses the SAME plan-item
    // DAG state the spawner admits from (effectiveStatus + unresolvedBlockers) + the
    // coverage map for claims, so `ready` is exactly what would be placed next.
    // Requires a plan; non-fatal (a read hiccup just omits the section).
    let dagView: DagFrontierView | null = null;
    if (args.includeDag && args.plan) {
      try {
        const row = await boundedRead(
          'dag',
          () => getPlanRow(args.plan as string, { workspaceId }),
          null as Awaited<ReturnType<typeof getPlanRow>>,
        );
        if (row) {
          const items = resolveEffectiveStatusForItems(planItemsForRow(row)).items;
          const claims = covMap ? claimsFromCoverage(covMap.values(), args.plan) : {};
          dagView = shapeDagFrontier(items, claims);
        }
      } catch {
        // Non-fatal — omit the dag section, but report the failed fold.
        degradedLegs.add('dag');
      }
    }
    // EI-21550192883916303: the stale-idle filter keeps on `alive` — heartbeat
    // FRESHNESS — so `summary.agents` is a population size, never an activity
    // measure. `sessionState` is only stamped by the decoration above, so unlike
    // leader-brief this census learns its composition here rather than in the
    // same pass as the filter. Derived ONCE, off the FULL decorated set that
    // `summary` describes, so the two publication sites below cannot disagree.
    const censusWithLiveness = withLivenessComposition(
      agentPopulation.census,
      agents,
      (a) => a.sessionState ?? null,
    );
    // Summary is computed over the FULL agent set so the counts stay accurate even
    // when the returned `agents` array is bounded below.
    const summary = {
      agents: agents.length,
      // P-010: which population `agents` counts, and what this response withheld.
      // `shown` is filled in below once the byte budget is known — the filter's
      // verdict and what survived transport are two different reductions, and a
      // single number cannot honestly stand for both.
      population: censusWithLiveness,
      alive: agents.filter((a) => a.alive).length,
      claims: rows.filter((r) => r.source !== 'presence').length,
      orphaned_claims: orphans.length,
      stalled_claims: stalled.length,
      // WI-5975: the two numbers a leader should actually act on. `reclaimable`
      // counts ONLY claims whose holder the oracle says is gone; `held_by_live_agent`
      // counts the quiet-but-alive ones, whose sanctioned action is ASK. The raw
      // orphaned/stalled counts above conflated them, which is how a reassign got
      // aimed at an agent that was working.
      reclaimable_claims: reclaimableRows.length,
      held_by_live_agent: liveHeldRows.length,
      // EI-18763117665515043: claims whose LINKED plan item is already terminal —
      // stale residue, not abandoned/quiet-but-live work. Close these (evidence
      // citing the plan item), never `work_items:release` them.
      residue_claims: residueRows.length,
      // EI-6074: distinct plan-item deliverables held by >1 principal via the
      // work-item↔plan-item coverage edge — the silent cross-table duplicate.
      coverage_collisions: collisions.length,
      // EI-21188799646985672: distinct non-terminal linked work-items held by
      // one principal for the same plan-item deliverable — the same-principal
      // duplicate that the cross-principal collision detector cannot see.
      coverage_duplicates: duplicates.length,
      // No claim exists to orphan, so this is a separate detector beside the
      // claim counters rather than another spelling of orphaned_claims.
      abandoned_intents: abandonedIntents.length,
      declared_unclaimed: agents.filter((a) => a.declaredUnclaimed).length,
      // P-001 (fleet-member-dx): members deliberately parked on an events:await —
      // idle-by-design, not stalled/abandoned.
      parked: agents.filter((a) => ((a as { parkedOn?: string[] }).parkedOn?.length ?? 0) > 0).length,
      // EI-19407725333778711: members that will NEVER act again unprompted —
      // `selfWake:'none'` while still reading as alive. Sits next to `parked`
      // on purpose: `parked` is the healthy idle state and this is the one that
      // is INDISTINGUISHABLE from it on every other field. Non-zero here means
      // re-arm their loops (`loop:arm`) or relaunch them; a leader reading
      // `agents:11, alive:11, parked:0` learned nothing about it before this.
      // Excludes rows where the leg did not resolve — unknown never counts.
      no_self_wake: agents.filter((a) =>
        isStrandedMember({
          sessionState: (a as { sessionState?: SessionState | null }).sessionState,
          selfWake: (a as { selfWake?: SelfWakeSource }).selfWake,
        }),
      ).length,
      monitoring: agents.filter((a) => a.monitorState === 'monitoring').length,
      waiting: agents.filter((a) => a.monitorState === 'waiting').length,
      parked_awaiting_capability: agents.filter(
        (a) => a.monitorState === 'parked-awaiting-capability',
      ).length,
      // P-021: total work-item load across live agents (the warm-inject signal).
      work_item_load: agents.reduce((n, a) => n + a.load, 0),
      // P-007: fleet-health headline — members whose context-pressure bucket is
      // high/critical right now (silent when 0, mirroring the ambient gauge's
      // quiet-below-LOUD philosophy).
      high_context: agents.filter((a) => a.contextPressure === 'high').length,
      critical_context: agents.filter((a) => a.contextPressure === 'critical').length,
      // P-007 (fleet-reliability-verification-2026-07-10): members with >=1
      // unanswered directed message right now — the mechanical "who hasn't
      // answered me" read a leader otherwise hand-tracks across wakes.
      unanswered_directed: agents.filter((a) => (a.unanswered?.count ?? 0) > 0).length,
    };
    // EI-1597: bound the agent-facing output so a large fleet (esp. include_stale)
    // can't overflow the agent result cap. `agents` is already sorted live-first, so
    // the byte-budget trim drops the least-relevant tail. Excerpt the long `intent`
    // text + cap each agent's `queued` work-list (head + `load` are what placement
    // reads; the full tail is reachable via a narrower { agent }/{ plan } query).
    // Internal callers + the UI read the data layer (groupByAgent) directly — unaffected.
    //
    // An explicit full payload is the framework's escape hatch from custom shaping.
    // The generic payload-tier dispatcher skips its shaper and hard ceiling for that
    // request, so this handler must not silently discard rows before the dispatcher
    // sees them (EI-22689299009865134). A full context tier is equivalent here: it is
    // the session-level form of the same caller-selected detail request.
    const tierCtx = ctx as {
      contextTier?: 'trimmed' | 'standard' | 'full';
      payloadTierOverride?: 'trimmed' | 'standard' | 'full';
    };
    const explicitFullRequest =
      tierCtx.payloadTierOverride === 'full' || tierCtx.contextTier === 'full';
    let agentsOut = explicitFullRequest ? agents : boundRowField(agents, 'intent', 280, 14_000);
    if (!explicitFullRequest) agentsOut = boundListField(agentsOut, 'queued', 8);
    const { kept: boundedAgents, truncated: agentsTruncated } = explicitFullRequest
      ? { kept: agentsOut, truncated: false }
      : trimToByteBudget(agentsOut, 22_000);
    // Self-identification overlay: top-level `self` names the caller's own
    // ownerId, and the caller's own agent row (keyed by `agentId`) is stamped
    // `isSelf:true`, so a reader of "who's on what" can tell which agent is
    // itself. Best-effort — an unattributable caller just gets no marker.
    const selfMarkedAgents = markSelfRows(boundedAgents, self, 'agentId');
    // P-010: the byte budget above is a SECOND reduction, independent of the
    // stale-idle filter — `summary.agents` stays the true count (that is
    // deliberate, see the comment where it is computed), which means the array
    // beside it can be shorter with nothing saying so. Record both.
    const summaryOut = {
      ...summary,
      population: withShownCount(
        censusWithLiveness,
        boundedAgents.length,
        'trimmed to the agent result byte budget (22KB, live-first order) — narrow with { agent } / { plan }',
      ),
    };
    // Keep the healthy payload byte-compatible with the existing tool, but make
    // every degraded fallback explicit when one fires. The fixed order makes a
    // concurrent fan-out deterministic for callers and tests.
    const degradedLegsOut = FLEET_ASSIGNMENTS_DEGRADED_LEG_ORDER.filter((leg) =>
      degradedLegs.has(leg),
    );
    // {data} envelope so the payload-tier shapers apply; HTTP consumers (the
    // pui bee-dossier pane) still read identical lossless JSON text.
    return {
      data: {
        ok: true,
        // A degraded read remains useful, but its counts/rows can be incomplete.
        // Name the exact bounded leg(s) so supervisors can distinguish that state
        // from a genuine empty fleet.
        ...(degradedLegsOut.length > 0
          ? { degraded: true, degradedLegs: degradedLegsOut }
          : {}),
        ...(self ? { self } : {}),
        summary: summaryOut,
        // WI-6762: SHIP THE SCOPE NEXT TO THE SCOPED COUNTS.
        //
        // Every number in `summary` is relative to the filters below, but the field
        // NAMES are fleet-shaped (`agents`, `alive`, `coverage_collisions`), so a
        // self-scoped read hands back `agents: 1` in vocabulary that reads as "the
        // fleet has one agent". coord:orient always scopes to the caller
        // (`fleet:assignments { agent: ownerId }`), so EVERY orient `me` block is a
        // one-agent read — and twice on 2026-08-01 an agent concluded from it that
        // the fleet was dead. One was an eleven-member fleet's leader
        // (EI-19282566865609166); the other nearly restarted the shared MCP proxy
        // under 22 live sessions believing the box idle (WI-6740).
        //
        // Both were patched at the READER before — fold leader-brief on a leader's
        // monitor/afterCompaction orient, give it result-door priority — but a
        // non-leader on an ordinary orient matches no such door, which is exactly how
        // the second one happened. Per-door mitigation cannot converge while the
        // payload itself keeps claiming authority. So state the scope in the payload:
        // `agents: 1` sitting beside `scope: { agent: 'su-…', selfScoped: true }` is
        // unmisreadable by ANY caller through ANY door, and costs nothing — these are
        // the args already in hand, not a second query.
        scope: {
          agent: args.agent ?? null,
          plan: args.plan ?? null,
          fleet: args.fleet ?? null,
          harness: args.harness ?? null,
          /** True when narrowed to the caller itself — then `summary.agents` is at
           *  most 1 BY CONSTRUCTION and says nothing about the fleet. For fleet-wide
           *  liveness use coord:presence / fleet:status, never this block. */
          // `self` has already been resolved to the caller's ownerId above, while
          // this echo intentionally retains the caller's original filter token.
          selfScoped: !!(
            self?.ownerId &&
            args.agent &&
            (args.agent === self.ownerId || args.agent === 'self')
          ),
          /** Whether ANY narrowing filter applied. false ⇒ the counts are workspace-wide. */
          filtered: !!(args.agent || args.plan || args.fleet || args.harness),
        },
        // Abandoned work first — the reason this view is claim-primary.
        orphaned: orphanRows,
        // Stalled work (no item-scoped progress in the window). WI-5975: each row
        // carries `verdict` + `action` — 'held-by-live-agent'/'ask' when the
        // oracle says the holder is live, 'orphan'/'reclaim' only when it is gone.
        // Read those, not the array name: presence in `stalled` is NOT permission
        // to reclaim.
        stalled: stalledRows,
        // Re-place these unassigned items; there is no claim to release.
        // Always present so zero means measured-clean.
        abandoned_intents: abandonedIntents,
        ...(liveHeldRows.length
          ? {
              live_holder_note:
                `${liveHeldRows.length} of the rows above are held by agents the presence oracle reports LIVE ` +
                `(verdict:'held-by-live-agent'). They are not abandoned — a missing checkpoint is not evidence of a ` +
                `stopped agent. ASK the holder before touching the claim; do not release it.`,
            }
          : {}),
        ...(residueRows.length
          ? {
              residue_note:
                `${residueRows.length} of the rows above are STALE RESIDUE (verdict:'residue') — each row's linked ` +
                `plan item (see its 'residue' field) is already done/dropped, so the claim is completed/abandoned ` +
                `work, regardless of whether its holder is alive or gone. CLOSE it with evidence citing the plan ` +
                `item's terminal status (work_items:complete / work_items:set_state); never work_items:release it ` +
                `— that just re-places already-finished work on the next self-select pass.`,
            }
          : {}),
        // Coverage collisions (EI-6074): two distinct principals resolving to the
        // same deliverable via the work-item↔plan-item coverage edge. Omitted when clean.
        ...(collisions.length ? { coverage_collisions: collisions } : {}),
        // Same-principal duplicate coverage (EI-21188799646985672): one holder
        // resolving the same deliverable through multiple distinct live linked
        // work-items. Omitted when clean, like the collision list above.
        ...(duplicates.length ? { coverage_duplicates: duplicates } : {}),
        // Plan-item coverage: items being worked via a linked work-item / direct
        // claim (even with no plan-item lease). 'none' is omitted (no signal).
        ...(coverageOut.length
          ? {
              coverage: coverageOut,
              ...(coverageTruncated
                ? {
                    coverage_truncated: true,
                    coverage_hint: `Coverage list trimmed to ${COVERAGE_CAP}; narrow with { plan }, or pass fullCoverage:true for the untrimmed historical ledger.`,
                  }
                : {}),
            }
          : {}),
        // DAG-filter frontier (includeDag) — omitted unless requested (+ a plan).
        ...(dagView ? { dag: dagView } : {}),
        agents: selfMarkedAgents,
        ...(agentsTruncated
          ? {
              agents_truncated: true,
              agents_returned: selfMarkedAgents.length,
              agents_hint:
                // WI-6762: said "summary.agents has the true total" — true only WITHIN
                // `scope`, and read as a fleet total by two agents on 2026-08-01.
                'Agent list trimmed to fit the result cap (sorted live-first). Narrow with { agent }/{ plan }/{ harness }; summary.agents is the true total WITHIN `scope` (see the scope block — when scope.filtered is true it is NOT a fleet-wide count; use coord:presence for that).',
            }
          : {}),
      },
    };
  },
});
