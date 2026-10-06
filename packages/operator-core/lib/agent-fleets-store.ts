/**
 * agent-fleets-store — PG access to harness_shared.agent_fleets, the durable
 * named-fleet registry (named-su-agent-fleets-2026-06-29, D-001; migration 406).
 *
 * A fleet = a persistent named group of su agents. THIS ROW is the durable
 * identity: it survives all-members-killed, so the fleet stays selectable (D-003).
 * Live membership is a SOFT label on shared_presence (fleet_slug/fleet_role), NOT
 * here. `leaderOwnerId` is the current leader — the agent who created the fleet or
 * last took it on a handoff ("handoff agent becomes leader", D-002).
 *
 * Workspace-scoped: every query carries an explicit `WHERE workspace_id = $1`
 * (RLS is the backstop, mirroring hive-store.ts). Every fn takes an optional `sql`
 * client so integration tests can pass a per-file test schema.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { appendFleetMembershipEvent } from './fleet-membership-store';
import {
  allocateNextSchemeName,
  schemeByName,
  schemeForSlug,
  type ColorScheme,
} from './console-color-schemes';
import { trackDetached } from './detached-imports';
import type {
  FreshLaunchSessionProbe,
  FreshLaunchWorkerAttestation,
} from './agent-launch-core';
import { normalizeSuContextSize } from './su-context-size.mjs';
import {
  COUNT_EVIDENCE_COMPARISON_RULE,
  COUNT_EVIDENCE_SCHEMA_VERSION,
  type CountContractDimension,
  type CountCutoff,
  type CountEvidence,
} from './count-evidence-contract';

/** Typed fleet control state (coord-authority-hardening-2026-07-11 P-009 / H4). */
export type FleetControlState = 'active' | 'winding-down';

/**
 * D-008 / P-010: a pair is a fleet TYPE, not a parallel construct.
 *
 * - `single` — today's fleet, unchanged, and the DEFAULT. Every existing caller
 *   and every legacy row is a single fleet with no migration of behaviour.
 * - `paired` — N director↔implementer pairs. The launch OPTION SHAPE branches on
 *   this value (D-009): a single fleet takes today's flat knobs; a paired fleet
 *   takes the same knobs as two per-role groups. The branch is validated at the
 *   launch surface, never coerced.
 */
export type FleetType = 'single' | 'paired';

/**
 * The one non-default type. Readers narrow to this set defensively.
 *
 * `satisfies` rather than a `: readonly FleetType[]` annotation: the annotation
 * WIDENS the literals away, and a schema builder that wants to derive its
 * accepted values from this constant (goal-launch-settings' `fleetType`) then
 * cannot — leaving it to re-spell 'single' | 'paired' as a second declaration of
 * this same set. `satisfies` keeps the contract check AND the literal types, so
 * the set stays spelled exactly once.
 */
export const FLEET_TYPES = ['single', 'paired'] as const satisfies readonly FleetType[];

/**
 * Narrow an untrusted value (legacy NULL, a hand-forged string, a value written
 * by a newer release) to a FleetType. Mirrors the controlState defence: only the
 * non-default value is honoured, so anything unrecognised reads back 'single'
 * and a paired-only code path can never be entered by accident.
 */
export function asFleetType(value: unknown): FleetType {
  return value === 'paired' ? 'paired' : 'single';
}

export type FleetLaunchTransactionState = 'launching' | 'partial' | 'verified';
export type FleetLaunchFailurePhase = 'spawn' | 'verification' | 'attestation' | 'persistence';

export type FleetLaunchGovernorOutcome = 'productive' | 'unverified' | 'repairing' | 'failed';
export type FleetLaunchGovernorAction = 'none' | 'wait' | 'retry' | 'prune' | 'spawn' | 'respawn';

export interface FleetLaunchGovernorVerdict {
  version: 1;
  outcome: FleetLaunchGovernorOutcome;
  decidedAt: number;
  target: number;
  productiveCapacityFloor: number;
  liveMemberIds: string[];
  workerReadyMemberIds: string[];
  unreadyMemberIds: string[];
  unverifiedMemberIds: string[];
  /** Productive-capacity measurement used by the writer. Optional on verdicts
   * persisted before WI-2007032. */
  productiveMemberCount?: number | null;
  headcountBasis?: FleetHeadcountBasis;
  deficit?: number;
  action: FleetLaunchGovernorAction;
  reason: string;
}

/** Latest fleet-owned provider capacity decision used to size a governor wave.
 * This is persisted alongside the launch transaction so a capacity wall and
 * any residual shortfall remain visible after the routine tick settles. */
export interface FleetLaunchCapacitySnapshot {
  measuredAt: number;
  provider: string | null;
  requested: number;
  allowance: number;
  residualShortfall: number;
  measured: boolean;
  wall: string | null;
}

export interface FleetLaunchGovernorEvent {
  at: number;
  action: 'observe' | 'retry' | 'prune' | 'spawn' | 'respawn' | 'terminal';
  reason: string;
  transactionId?: string;
  ownerId?: string;
  replacementOwnerId?: string;
}

/** P-004: bounded recovery metadata co-located with the canonical launch
 * transaction. This is evidence about governor decisions, not a replacement
 * for process liveness, wakeability, claim progress, or completion authority. */
export interface FleetLaunchGovernorState {
  version: 1;
  /** Exact identities launched by this transaction's launcher and therefore
   * safe to refresh through the --launched-by correlation join. */
  probeOwnerIds: string[];
  attestationAttempts: Record<string, number>;
  retiredMemberIds: string[];
  history: FleetLaunchGovernorEvent[];
  terminalVerdict: FleetLaunchGovernorVerdict | null;
  /** Last fleet-owned provider capacity measurement for a refill wave. */
  capacity?: FleetLaunchCapacitySnapshot;
}

export interface FleetLaunchTransaction {
  version: 1;
  transactionId: string;
  /** Bounded lineage pointer when a governor wave supersedes a prior snapshot. */
  previousTransactionId?: string;
  /** The exact coord identity stamped into each member's --launched-by token.
   * Optional for transactions persisted before P-004. A missing value is
   * UNKNOWN and may never authorize a speculative replay. */
  launcherOwnerId?: string;
  state: FleetLaunchTransactionState;
  requestedAt: number;
  updatedAt: number;
  requestedMemberIds: string[];
  openedMemberIds: string[];
  verifiedMemberIds: string[];
  /** EI-20437060078324174: opened members whose verification window expired with
   *  NO observation either way — not failures, not verified. The resume path
   *  already excludes every opened id from retry, so these can never be
   *  double-spawned. Optional: transactions persisted before this field exist. */
  unconfirmedMemberIds?: string[];
  /** P-003: current four-stage worker-ready snapshot. Optional for transactions
   * persisted before the attestation contract existed. */
  workerReadyMemberIds?: string[];
  /** Latest typed per-member evidence merged on every verifier pass. */
  workerAttestations?: FreshLaunchWorkerAttestation[];
  /** P-004 governor consumption/decision record. Optional for legacy rows. */
  governor?: FleetLaunchGovernorState;
  failed: Array<{
    ownerId: string;
    phase: FleetLaunchFailurePhase;
    reason: string;
  }>;
  waves: Array<{
    index: number;
    ownerIds: string[];
    state: 'opening' | 'partial' | 'verified';
    openedOwnerIds?: string[];
    verifiedOwnerIds?: string[];
  }>;
  recovery: {
    retryOwnerIds: string[];
    nextAction: string;
  };
  requestedMembers?: Array<{
    index: number;
    ownerId: string;
    agent: string;
    model: string | null;
    account: string;
    carry: 'warm' | 'cold';
    headless: boolean;
  }>; 
}

/** Merge the latest per-session worker snapshot without losing prior waves.
 * Shared by the launch writer and the headcount governor so readiness remains
 * derived exactly once in agent-launch-core. */
export function mergeFleetLaunchWorkerAttestations(
  transaction: FleetLaunchTransaction,
  sessions: readonly Pick<FreshLaunchSessionProbe, 'ownerId' | 'workerAttestation'>[],
): void {
  const byOwner = new Map(
    (transaction.workerAttestations ?? [])
      .filter((attestation) => typeof attestation.ownerId === 'string' && attestation.ownerId.length > 0)
      .map((attestation) => [attestation.ownerId as string, attestation]),
  );
  for (const session of sessions) {
    if (!session.ownerId || !session.workerAttestation) continue;
    byOwner.set(session.ownerId, {
      ...session.workerAttestation,
      ownerId: session.ownerId,
    });
  }
  if (byOwner.size === 0) return;

  const requestedOrder = new Map(transaction.requestedMemberIds.map((ownerId, index) => [ownerId, index]));
  transaction.workerAttestations = [...byOwner.values()].sort((a, b) =>
    (requestedOrder.get(a.ownerId ?? '') ?? Number.MAX_SAFE_INTEGER) -
    (requestedOrder.get(b.ownerId ?? '') ?? Number.MAX_SAFE_INTEGER),
  );
  transaction.workerReadyMemberIds = transaction.requestedMemberIds.filter(
    (ownerId) => byOwner.get(ownerId)?.ready === true,
  );
}

/** A named-fleet registry row. */
export interface AgentFleetRecord {
  workspaceId: string;
  fleetSlug: string;
  title: string | null;
  description: string | null;
  /** Coord owner-id that created the fleet. */
  owner: string | null;
  /** The CURRENT leader's coord owner-id (D-002). Null when unset (e.g. the
   *  fleet persists but no agent currently leads it). */
  leaderOwnerId: string | null;
  /** Epoch-ms of the first complete liveness observation that the current
   *  registered leader is absent. It is independent of updatedAt, which also
   *  changes for ordinary fleet metadata. */
  leaderMissingSinceMs: number | null;
  /** The fleet's permanently-bound color-scheme NAME (console-color-schemes).
   *  Null on legacy rows created before the binding existed — resolveFleetScheme
   *  falls back to a deterministic slug hash for those. */
  colorScheme: string | null;
  /** P-009 (H4): the fleet's typed control state — 'active' | 'winding-down'
   *  (mig 575; fleet:pause aliases wind-down). PLATFORM state on the durable
   *  row, so late joiners read it at orient instead of missing a broadcast. */
  controlState: FleetControlState;
  /** D-008 / P-010: 'single' (default — today's fleet) | 'paired' (N director↔
   *  implementer pairs). PLATFORM state on the durable row, so a member reads
   *  its own fleet's type at orient rather than inferring it from launch args.
   *  Legacy rows and unrecognised values narrow to 'single' (asFleetType). */
  fleetType: FleetType;
  /** Invoker-stated reason for the current control state (advisory). */
  controlReason: string | null;
  /** Coord owner-id that set the current control state (audit). */
  controlBy: string | null;
  /** Epoch ms when the current control state was set. */
  controlAt: number | null;
  /** WI-2034563 / mig 1065: the DECLARED, LATCHING resume-gate event key for the
   *  current park directive (`fleet:<slug>:<gate>`). Members events:await this key
   *  instead of ending their loop wake-less; fleet:resume fires it. Null on an
   *  active fleet and on every legacy wind-down created before mig 1065 — which is
   *  why `resolveFleetParkResumePath` treats a null gate as "no path", preserving
   *  the pre-1065 behaviour for rows already parked. */
  controlResumeGate: string | null;
  /** WI-2034563 / mig 1065: optional epoch-ms deadline after which the park is
   *  OVERDUE. Bounds the capacity loss and is reported by fleet:leader-brief.
   *  Advisory: no read flips the state, so the stored control_state never lies. */
  controlExpiresAt: number | null;
  /** WI-2034563 / mig 1065: the park is deliberately TERMINAL — nobody is coming
   *  back. The only park shape that still authorizes a member's wake-less loop:end. */
  controlNoResumePath: boolean;
  /** P-003 / migration 830: the latest canary-first launch transaction, including
   * exact partial-cohort recovery identities. */
  lastLaunchTransaction: FleetLaunchTransaction | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateFleetInput {
  workspaceId: string;
  fleetSlug: string;
  title?: string | null;
  description?: string | null;
  owner?: string | null;
  leaderOwnerId?: string | null;
  /** Force a specific scheme name; omit to auto-allocate the next unused one. */
  colorScheme?: string | null;
  /** D-008 / P-010: fleet type. Omit for 'single' — today's behaviour. Applies
   *  on FIRST INSERT only, like title/description/owner (createFleetIfAbsent is
   *  idempotent; change an existing fleet's type via updateFleetMeta). */
  fleetType?: FleetType;
}

/** Validated launch recipe persisted for the headcount governor. */
export interface FleetHeadcountConfig {
  /** The launching plan, kept as provenance (governor labels + the terminal-plan
   * disarm). Absent for a pure claim-spec (claimKinds) drain fleet: its members
   * pull by the fleet claim spec, which is persisted in the claim-spec store and
   * is what governor top-ups use anyway (they launch plan-less). R-8 of
   * feature-drain-delivery-readiness-and-outcome-accounting-2026-10-01. */
  plan?: string;
  harness: string;
  agent: 'claude' | 'omp' | 'codex';
  model?: string;
  effort?: string;
  account?: string;
  /** Minimum worker-ready members required before the governor opens a
   * multi-member refill wave. Below this floor it launches one canary only. */
  productiveCapacityFloor?: number;
  /** R5 (interrupted-member-recovery-hardening-2026-09-01): the per-fleet
   * supervise/auto-topup GRANT. The headcount governor acts ONLY on fleets
   * whose persisted recipe carries `supervise: true`; FLEET_HEADCOUNT_GOVERNOR
   * stays the master gate above it. Absent/false = not granted — a recipe
   * persisted for reuse/respawn alone (D-008/WI-41145) is not supervision
   * consent. */
  supervise?: boolean;
  /** Background drain fleets default headless; false explicitly preserves visible placement. */
  headless?: boolean;
  role?: string;
  /** Inline fleet-specific first-turn brief, composed with the member baseline at launch. */
  brief?: string;
  launchContext?: string;
  contextSize?: 'trimmed' | 'steward';
  compactionLimit?: number;
  carry?: 'warm' | 'cold';
  extraArgs?: string[];
  /** P-005 / D-030 (unified-bug-pipeline-and-honest-queue-2026-10-05): the one
   * structured form of "do not top this fleet up". Before it, the rule lived in
   * plan prose, so a successor leader inherited it silently and a fleet ran with
   * zero workers while its leader recorded quiet wakes. Every rule is attributed
   * and EXPIRES; see resolveFleetTopUpRule. */
  topUpRule?: FleetTopUpRule;
}

export interface FleetHeadcountTarget {
  workspaceId: string;
  fleetSlug: string;
  /** Whether automatic restoration is enabled. Disabled rows intentionally
   * retain their launch recipe, so `target` alone cannot carry this state. */
  enabled: boolean;
  target: number;
  config: FleetHeadcountConfig;
  /** The durable row used the retired spelling and was normalized on read. */
  normalizedLegacyContextSize?: boolean;
  nextAttemptAt: number | null;
  backoffMs: number;
  lastError: string | null;
}

export type FleetHeadcountVerdict = 'disabled' | 'unknown' | 'at-target' | 'under-strength';
export type FleetHeadcountBasisKind =
  | 'agent-origin-execution-attested'
  | 'legacy-live-roster-fallback'
  | 'unknown';

// How far back a call still attests that a live member seat is productive. The
// rule that applies it (a pending non-keepalive await also counts) and why it
// replaced the old 60-minute window live beside the constant.
import { FLEET_MEMBER_SILENCE_THRESHOLD_MS } from './fleet/member-silence-threshold';
import {
  parseFleetTopUpRule,
  resolveFleetHeadcountHeld,
  type FleetHeadcountGovernance,
  type FleetHeadcountNotHeldReason,
  type FleetTopUpRule,
  type ResolvedFleetTopUpRule,
} from './fleet/top-up-rule';
export { FLEET_MEMBER_SILENCE_THRESHOLD_MS };

/** The exact population behind `FleetHeadcountState.current`.
 *
 * A launch heartbeat proves only that a process occupies a member seat, so
 * `current` is attested from RECENT AGENT-ORIGIN EXECUTION intersected with the
 * independently-live launch roster (`agentOriginToolCallOwnersSince`, the same
 * telemetry WI-583276 established as authoritative turn provenance).
 *
 * ⚠ WI-2034624: `current` must NEVER be scoped to the CURRENT LAUNCH
 * TRANSACTION. It once was — the intersection of `transaction.workerReadyMemberIds`
 * with the live roster — and a member launched by a PRIOR transaction, or
 * rebuilt by a carry-respawn, never re-enters that recorded set. The fleet then
 * reads permanently under-strength (measured 2026-09-01: `current 3` of target
 * 50, while 37 roster members were live and ~22 were demonstrably executing),
 * the governor keeps requesting replacements it does not need, and the churn
 * compounds — 144 ever-members in 13h on one fleet, 932 lifetime on its
 * predecessor. Transaction worker-readiness remains the right evidence for
 * verifying THAT TRANSACTION (prune/retry/wait), and the governor still uses it
 * for exactly that; it is not a population. `transactionWorkerReadyMembers` is
 * retained here as a DIAGNOSTIC only, never as the count.
 *
 * Legacy fleets carry no worker contract at all; their old live-roster behavior
 * is retained but named as a fallback. A failed roster or telemetry read stays
 * explicitly unknown rather than silently narrowing the population. */
export interface FleetHeadcountBasis {
  kind: FleetHeadcountBasisKind;
  liveRosterMembers: number | null;
  /** Live members with an agent-origin tool call inside the sizing window.
   * `null` when the telemetry leg failed or was not attempted. */
  executingMembers: number | null;
  /** DIAGNOSTIC ONLY — the current transaction's recorded worker-ready ids.
   * Never the population behind `current`; see the WI-2034624 note above. */
  transactionWorkerReadyMembers: number | null;
}

/** Canonical measurement shared by the read surfaces and the refill governor.
 * Keeping the population decision here prevents a truthful status read from
 * disagreeing with the writer that decides whether another member is needed. */
export interface FleetProductiveHeadcountMeasurement {
  current: number | null;
  basis: FleetHeadcountBasis;
}

/**
 * `executingMemberIds` is REQUIRED, not optional, and that is load-bearing: an
 * optional attestation is one a call site can silently omit, and omitting it is
 * precisely the WI-2034624 defect (a transaction-scoped population standing in
 * for a fleet-wide one). Making it required means the compiler names every
 * surface that must supply the evidence. `null` states honestly that the
 * telemetry leg failed or timed out; it must never be read as "nobody is
 * executing", so it resolves to UNKNOWN rather than to a narrower count.
 */
export function measureFleetProductiveHeadcount(
  transaction: FleetLaunchTransaction | null | undefined,
  liveMemberIds: readonly string[] | null,
  executingMemberIds: ReadonlySet<string> | null,
): FleetProductiveHeadcountMeasurement {
  const liveIds = liveMemberIds == null
    ? null
    : [...new Set(liveMemberIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const hasWorkerContract = transaction != null && (
    transaction.workerReadyMemberIds !== undefined ||
    transaction.workerAttestations !== undefined ||
    transaction.governor !== undefined
  );
  const recordedReadyIds = Array.isArray(transaction?.workerReadyMemberIds)
    ? [...new Set(transaction.workerReadyMemberIds.filter((id) => typeof id === 'string' && id.length > 0))]
    : null;
  // Attested seats, over the CANONICAL live roster — deliberately independent of
  // which launch transaction created each member (WI-2034624).
  const executingLive = liveIds != null && executingMemberIds != null
    ? liveIds.filter((ownerId) => executingMemberIds.has(ownerId))
    : null;

  if (liveIds == null) {
    return {
      current: null,
      basis: {
        kind: 'unknown',
        liveRosterMembers: null,
        executingMembers: null,
        transactionWorkerReadyMembers: recordedReadyIds?.length ?? null,
      },
    };
  }
  if (executingLive != null) {
    return {
      current: executingLive.length,
      basis: {
        kind: 'agent-origin-execution-attested',
        liveRosterMembers: liveIds.length,
        executingMembers: executingLive.length,
        transactionWorkerReadyMembers: recordedReadyIds?.length ?? null,
      },
    };
  }
  // No execution telemetry. A legacy fleet with no worker contract keeps its
  // historical live-roster reading; anything else stays honestly unknown rather
  // than falling back to the transaction-scoped population.
  if (transaction !== undefined && !hasWorkerContract) {
    return {
      current: liveIds.length,
      basis: {
        kind: 'legacy-live-roster-fallback',
        liveRosterMembers: liveIds.length,
        executingMembers: null,
        transactionWorkerReadyMembers: null,
      },
    };
  }
  return {
    current: null,
    basis: {
      kind: 'unknown',
      liveRosterMembers: liveIds.length,
      executingMembers: null,
      transactionWorkerReadyMembers: recordedReadyIds?.length ?? null,
    },
  };
}

/** One truthful current-vs-target projection shared by every fleet read surface.
 * `undefined` means the profile read failed; `null` means it succeeded and no
 * saved profile exists. A disabled profile may still carry target=1 for recipe
 * reuse, so its public target is deliberately null. */
export interface FleetHeadcountState {
  enabled: boolean | null;
  target: number | null;
  current: number | null;
  shortfall: number | null;
  underStrength: boolean | null;
  verdict: FleetHeadcountVerdict;
  /** P-005 / D-030: will the governor actually restore this fleet? `target` and
   * `verdict` describe a number; only this says whether anyone is acting on it.
   * null when the governance facts were not supplied or could not be read. */
  held: boolean | null;
  notHeldBecause: FleetHeadcountNotHeldReason | null;
  /** The fleet's no-top-up rule, resolved against the current leader and clock. */
  topUpRule: ResolvedFleetTopUpRule | null;
  basis: FleetHeadcountBasis;
  countEvidence: {
    productive: CountEvidence | null;
    liveRoster: CountEvidence | null;
    transactionWorkerReady: CountEvidence | null;
    note: string;
  };
}

export interface FleetHeadcountObservation {
  measuredAt?: string;
  scope?: Record<string, CountContractDimension>;
  /** P-005 / D-030: supply to resolve `held` / `notHeldBecause` / `topUpRule`. */
  governance?: FleetHeadcountGovernance;
}

function buildFleetHeadcountCountEvidence(
  measuredCurrent: number | null,
  basis: FleetHeadcountBasis,
  transaction: FleetLaunchTransaction | null | undefined,
  observation?: FleetHeadcountObservation,
): FleetHeadcountState['countEvidence'] {
  const measuredAt = observation?.measuredAt ?? new Date().toISOString();
  const scope = observation?.scope ?? {};
  const evidence = (args: {
    value: number | null;
    metricId: string;
    metricDefinition: string;
    populationId: string;
    populationSelector: CountContractDimension;
    populationDefinition: string;
    cutoff: CountCutoff;
    statusId: string;
    statusDefinition: string;
    writerId: string;
    zeroMeaning: string;
    axis: string;
  }): CountEvidence | null => args.value == null ? null : ({
    value: args.value,
    contract: {
      schemaVersion: COUNT_EVIDENCE_SCHEMA_VERSION,
      metric: { id: args.metricId, definition: args.metricDefinition },
      population: {
        id: args.populationId,
        selector: args.populationSelector,
        definition: args.populationDefinition,
      },
      cutoff: args.cutoff,
      status: { id: args.statusId, definition: args.statusDefinition },
      writer: { id: args.writerId, revision: 'fleet-headcount-contract-v1' },
      unit: { id: 'coord-owner', definition: 'distinct coordination owner ids' },
      exactness: { status: 'exact' },
      zeroMeaning: args.zeroMeaning,
      scope: { ...scope, headcountAxis: args.axis },
      measuredAt,
      comparisonRule: COUNT_EVIDENCE_COMPARISON_RULE,
    },
  });

  const liveRoster = evidence({
    value: basis.liveRosterMembers,
    metricId: 'fleet-live-roster-count',
    metricDefinition: 'members in the canonical live launch roster, excluding the leader',
    populationId: 'fleet-live-launch-roster',
    populationSelector: { source: 'liveFleetMemberIds', mode: 'launch', leaderExcluded: true },
    populationDefinition: 'the fleet roster rows currently considered live for launch capacity',
    cutoff: { kind: 'none' },
    statusId: 'live-roster-member',
    statusDefinition: 'member remains in the canonical live launch roster',
    writerId: 'liveFleetMemberIds',
    zeroMeaning: 'the live launch roster contains no non-leader members at measuredAt',
    axis: 'live-roster',
  });
  const transactionWorkerReady = evidence({
    value: basis.transactionWorkerReadyMembers,
    metricId: 'fleet-transaction-worker-ready-count',
    metricDefinition: 'worker-ready ids recorded only by the current launch transaction',
    populationId: 'current-launch-transaction-worker-ready',
    populationSelector: {
      transactionId: transaction?.transactionId ?? null,
      source: 'lastLaunchTransaction.workerReadyMemberIds',
    },
    populationDefinition: 'members whose four-stage readiness was persisted on this launch transaction only',
    cutoff: { kind: 'none' },
    statusId: 'transaction-worker-ready',
    statusDefinition: 'recorded ready by the current launch transaction; diagnostic only',
    writerId: 'refreshGovernorWorkerAttestation',
    zeroMeaning: 'this launch transaction recorded no worker-ready ids; it says nothing about members from earlier launches',
    axis: 'transaction-worker-ready',
  });
  const productive = evidence({
    value: measuredCurrent,
    metricId: 'fleet-productive-headcount',
    metricDefinition: 'the population used to size productive fleet capacity',
    populationId:
      basis.kind === 'agent-origin-execution-attested'
        ? 'live-roster-non-silent-intersection'
        : 'legacy-live-roster-fallback',
    populationSelector:
      basis.kind === 'agent-origin-execution-attested'
        ? {
            liveSource: 'liveFleetMemberIds(mode=launch)',
            executionSources: ['harness_shared.tool_invocations(call_origin=agent)', 'harness_shared.agent_activity'],
            waitSource: 'harness_shared.event_awaits(pending, unexpired, excluding coord:inbox-wake keepalive)',
          }
        : { source: 'liveFleetMemberIds', mode: 'launch', legacyFallback: true },
    populationDefinition:
      basis.kind === 'agent-origin-execution-attested'
        ? 'live non-leader fleet members that are not silent: a call in either tool ledger within the threshold, or parked on a declared await; in a paused fleet every live member'
        : 'legacy fleet live roster used only when no worker-attestation contract exists',
    cutoff:
      basis.kind === 'agent-origin-execution-attested'
        ? {
            kind: 'rolling-window',
            field: 'agent-origin-or-native-tool-activity',
            durationMs: FLEET_MEMBER_SILENCE_THRESHOLD_MS,
            end: 'measuredAt',
          }
        : { kind: 'none' },
    statusId:
      basis.kind === 'agent-origin-execution-attested'
        ? 'non-silent-live-member'
        : 'legacy-live-roster-member',
    statusDefinition:
      basis.kind === 'agent-origin-execution-attested'
        ? 'member is live and either appears in an execution ledger during the window or holds a pending declared await; heartbeats alone never qualify'
        : 'member is live in a legacy fleet with no modern worker contract',
    writerId:
      basis.kind === 'agent-origin-execution-attested'
        ? 'readFleetMemberSilence+measureFleetProductiveHeadcount'
        : 'measureFleetProductiveHeadcount/legacy-live-roster-fallback',
    zeroMeaning:
      basis.kind === 'agent-origin-execution-attested'
        ? 'every live member was silent for the threshold (heartbeats only, no declared await); this is not a transaction-ready count'
        : 'the legacy live roster contains no members',
    axis: 'productive',
  });
  return {
    productive,
    liveRoster,
    transactionWorkerReady,
    note:
      'These are three different populations. Productive headcount may be compared over time only to the productive contract; transaction worker-ready is diagnostic and never caps it.',
  };
}

export function projectFleetHeadcountState(
  profile: FleetHeadcountTarget | null | undefined,
  transaction: FleetLaunchTransaction | null | undefined,
  liveMemberIds: readonly string[] | null,
  executingMemberIds: ReadonlySet<string> | null,
  observation?: FleetHeadcountObservation,
): FleetHeadcountState {
  const { current: measuredCurrent, basis } = measureFleetProductiveHeadcount(
    transaction,
    liveMemberIds,
    executingMemberIds,
  );
  const countEvidence = buildFleetHeadcountCountEvidence(
    measuredCurrent,
    basis,
    transaction,
    observation,
  );
  const governed = resolveFleetHeadcountHeld(profile, observation?.governance);
  if (profile === undefined) {
    return {
      enabled: null,
      target: null,
      current: measuredCurrent,
      shortfall: null,
      underStrength: null,
      verdict: 'unknown',
      ...governed,
      basis,
      countEvidence,
    };
  }
  if (profile == null || !profile.enabled) {
    return {
      enabled: false,
      target: null,
      current: measuredCurrent,
      shortfall: null,
      underStrength: null,
      verdict: 'disabled',
      ...governed,
      basis,
      countEvidence,
    };
  }
  if (measuredCurrent == null) {
    return {
      enabled: true,
      target: profile.target,
      current: null,
      shortfall: null,
      underStrength: null,
      verdict: 'unknown',
      ...governed,
      basis,
      countEvidence,
    };
  }
  const shortfall = Math.max(0, profile.target - measuredCurrent);
  return {
    enabled: true,
    target: profile.target,
    current: measuredCurrent,
    shortfall,
    underStrength: shortfall > 0,
    verdict: shortfall > 0 ? 'under-strength' : 'at-target',
    ...governed,
    basis,
    countEvidence,
  };
}

/** Canonical mutation/read boundary for durable fleet launch profiles. */
export function normalizeFleetHeadcountConfig(raw: FleetHeadcountConfig | Record<string, unknown>): FleetHeadcountConfig {
  const config = { ...raw } as FleetHeadcountConfig & { contextSize?: unknown };
  if (config.contextSize !== undefined && config.contextSize !== null) {
    const normalized = normalizeSuContextSize(config.contextSize);
    if (!normalized.ok) throw new Error(normalized.error);
    config.contextSize = normalized.contextSize;
  }
  return config as FleetHeadcountConfig;
}

export interface FleetHeadcountAttempt extends FleetHeadcountTarget {
  claimedAt: number;
}

const HEADCOUNT_INITIAL_BACKOFF_MS = 60_000;
const HEADCOUNT_MAX_BACKOFF_MS = 15 * 60_000;

interface FleetRow {
  workspace_id: string;
  fleet_slug: string;
  title: string | null;
  description: string | null;
  owner: string | null;
  leader_owner_id: string | null;
  leader_missing_since_ms?: string | number | null;
  color_scheme: string | null;
  fleet_type: string | null;
  control_state: string | null;
  control_reason: string | null;
  control_by: string | null;
  control_at: string | number | null;
  control_resume_gate?: string | null;
  control_expires_at?: string | number | null;
  control_no_resume_path?: boolean | null;
  last_launch_transaction?: FleetLaunchTransaction | string | null;
  created_at: string | number;
  updated_at: string | number;
}

function rowToRecord(r: FleetRow): AgentFleetRecord {
  const lastLaunchTransaction =
    typeof r.last_launch_transaction === 'string'
      ? (JSON.parse(r.last_launch_transaction) as FleetLaunchTransaction)
      : r.last_launch_transaction ?? null;
  return {
    workspaceId: r.workspace_id,
    fleetSlug: r.fleet_slug,
    title: r.title,
    description: r.description,
    owner: r.owner,
    leaderOwnerId: r.leader_owner_id,
    leaderMissingSinceMs: r.leader_missing_since_ms == null ? null : Number(r.leader_missing_since_ms),
    colorScheme: r.color_scheme,
    // Defensive: only the one non-default state is honored; anything else
    // (legacy null, a hand-forged value) reads back 'active'.
    controlState: r.control_state === 'winding-down' ? 'winding-down' : 'active',
    // Same defence for the fleet type (D-008): a legacy row predating mig 964,
    // or any unrecognised value, reads back 'single' — so the paired-only code
    // paths can never be entered by a row that did not explicitly ask for them.
    fleetType: asFleetType(r.fleet_type),
    controlReason: r.control_reason ?? null,
    controlBy: r.control_by ?? null,
    controlAt: r.control_at == null ? null : Number(r.control_at),
    // mig 1065. A legacy row predating the migration returns undefined for all
    // three, which narrows to exactly the pre-1065 reading: no gate, no deadline,
    // not terminal. Never invent a resume path a park does not actually carry.
    controlResumeGate: r.control_resume_gate ?? null,
    controlExpiresAt: r.control_expires_at == null ? null : Number(r.control_expires_at),
    controlNoResumePath: r.control_no_resume_path === true,
    lastLaunchTransaction,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

/**
 * WI-2006 (P-101 publish leg): every fleet lifecycle write refreshes the
 * owner-signed directory card (p2p/fleet-directory-publish) so the fleet is
 * hive-browsable and its scope roster widens cross-node. Lazy dynamic import +
 * fire-and-forget: the store stays PG-pure, a publish fault never fails the
 * fleet write, and unit tests (which pass a per-file `sql` schema) never touch
 * identity/keychain/hive resolution.
 */
function refreshDirectoryCard(
  workspaceId: string,
  fleetSlug: string,
  opts?: { archived?: boolean; sql?: Sql },
): void {
  if (opts?.sql) return; // test-schema override ⇒ never publish for real
  void trackDetached(import('./p2p/fleet-directory-publish'))
    .then((m) => m.publishFleetDirectoryRecordBestEffort({ workspaceId, fleetSlug, archived: opts?.archived }))
    .catch(() => {});
}

// fleet_type is APPENDED (not slotted in beside color_scheme) so the positional
// $N binds in createFleetIfAbsent's VALUES stay stable — the insert reads in
// this exact order.
const COLS = `workspace_id, fleet_slug, title, description, owner, leader_owner_id, color_scheme, control_state, control_reason, control_by, control_at, created_at, updated_at, fleet_type, control_resume_gate, control_expires_at, control_no_resume_path, leader_missing_since_ms`;

/**
 * Derive a stable fleet_slug from a user-entered fleet NAME. The original name
 * is kept in `title`; this is the kebab-case handle (the durable id + env var
 * value + presence label). Always returns a non-empty slug.
 */
export function fleetSlugFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'fleet';
}

/** One fleet by its slug. */
export async function getFleet(
  workspaceId: string,
  fleetSlug: string,
  sql?: Sql,
): Promise<AgentFleetRecord | null> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT ${COLS}, to_jsonb(f)->'last_launch_transaction' AS last_launch_transaction
       FROM harness_shared.agent_fleets f
      WHERE workspace_id = $1 AND fleet_slug = $2 LIMIT 1`,
    [workspaceId, fleetSlug],
  )) as unknown as FleetRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Every persisted fleet in the workspace, newest first. (These persist even
 *  with zero live members — D-003 — so this is the psu "pick existing" list.) */
export async function listFleets(workspaceId: string, sql?: Sql): Promise<AgentFleetRecord[]> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT ${COLS}, to_jsonb(f)->'last_launch_transaction' AS last_launch_transaction
       FROM harness_shared.agent_fleets f WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  )) as unknown as FleetRow[];
  return rows.map(rowToRecord);
}

/** The one field a presence/routing read needs from a fleet row: whether it
 *  can currently absorb NEW work, alongside the slug it answers for. */
export interface FleetControlSummary {
  fleetSlug: string;
  /** Same defensive narrowing as {@link rowToRecord}: only the literal
   *  'winding-down' is honored; any other stored value (legacy null, a
   *  hand-forged string) reads back 'active'. */
  controlState: FleetControlState;
  controlReason: string | null;
}

/**
 * Batched control-state read for a BOUNDED set of fleet slugs
 * (coord:presence fleet-control-visibility, EI-22072194984361823).
 *
 * WHY NOT `listFleets` + a client-side filter: a workspace's fleet registry
 * never shrinks (D-003 — a fleet persists even after every member is killed),
 * so `listFleets` pages the whole historical population. A presence read
 * already knows exactly which fleet slugs its roster touches (the keys of
 * the map `fetchPresenceFleet` returns); this answers "is any of THOSE
 * fleets winding-down" with one query bounded to that set, on a hot poll
 * surface (coord:presence) where paging the full registry per call would be
 * a real cost.
 *
 * A requested slug with no matching row (deleted, or never registered — e.g.
 * a stale/hand-set coord_presence.fleet_slug label) is simply absent from
 * the returned map. Callers must treat "absent" the same as "active": this
 * mirrors `fleetControlWindDownRefusal`'s existing fail-OPEN policy — an
 * unresolvable fleet never fabricates a gate that was never set.
 */
export async function getFleetControlStates(
  workspaceId: string,
  fleetSlugs: readonly string[],
  sql?: Sql,
): Promise<Map<string, FleetControlSummary>> {
  const out = new Map<string, FleetControlSummary>();
  const slugs = [...new Set(fleetSlugs.filter((s): s is string => typeof s === 'string' && s.length > 0))];
  if (slugs.length === 0) return out;
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT fleet_slug, control_state, control_reason
       FROM harness_shared.agent_fleets
      WHERE workspace_id = $1 AND fleet_slug = ANY($2::text[])`,
    [workspaceId, slugs],
  )) as unknown as Array<{ fleet_slug: string; control_state: string | null; control_reason: string | null }>;
  for (const r of rows) {
    out.set(r.fleet_slug, {
      fleetSlug: r.fleet_slug,
      controlState: r.control_state === 'winding-down' ? 'winding-down' : 'active',
      controlReason: r.control_reason ?? null,
    });
  }
  return out;
}

/**
 * Every fleet this agent currently LEADS (agent_fleets.leader_owner_id), newest
 * first. Unlike presence membership — a single soft label that collapses to the
 * latest fleet joined — leadership is a per-fleet fact, so an agent that took
 * leadership of several fleets shows up here for ALL of them. This is the Scope-A
 * source for the multi-fleet terminal identity (WI-1963): "which fleets is this
 * agent in" as a SET, with no schema change.
 */
export async function listFleetsLedBy(
  workspaceId: string,
  leaderOwnerId: string,
  sql?: Sql,
): Promise<AgentFleetRecord[]> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT ${COLS}, to_jsonb(f)->'last_launch_transaction' AS last_launch_transaction
       FROM harness_shared.agent_fleets f
      WHERE workspace_id = $1 AND leader_owner_id = $2
      ORDER BY created_at DESC`,
    [workspaceId, leaderOwnerId],
  )) as unknown as FleetRow[];
  return rows.map(rowToRecord);
}

/**
 * Get-or-create a fleet. Idempotent: an existing (workspace, fleet_slug) row is
 * returned UNCHANGED; title/description/owner/leader apply only on first insert
 * (edit later via updateFleetMeta / setFleetLeader). `created` reflects insert.
 */
export async function createFleetIfAbsent(
  input: CreateFleetInput,
  sql?: Sql,
): Promise<{ record: AgentFleetRecord; created: boolean }> {
  const s = pg(sql);
  const now = Date.now();
  // Bind a color scheme at birth — per-fleet permanent visual identity. Caller
  // may force one; else allocate the next UNUSED catalog scheme so distinct
  // fleets look distinct. A wasted allocation on an idempotent no-op insert is
  // harmless: the existing row (ON CONFLICT DO NOTHING) keeps its first scheme.
  const colorScheme =
    input.colorScheme ?? (await allocateSchemeForWorkspace(input.workspaceId, sql));
  const inserted = (await s.unsafe(
    `INSERT INTO harness_shared.agent_fleets (${COLS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NULL, NULL, NULL, $8, $8, $9, NULL, NULL, false, NULL)
     ON CONFLICT (workspace_id, fleet_slug) DO NOTHING
     RETURNING ${COLS}`,
    [
      input.workspaceId,
      input.fleetSlug,
      input.title ?? null,
      input.description ?? null,
      input.owner ?? null,
      input.leaderOwnerId ?? null,
      colorScheme,
      now,
      // Narrow on the way IN as well as out: a caller that hands us a bad value
      // gets a 'single' fleet, never a row the readers would have to distrust.
      asFleetType(input.fleetType),
    ],
  )) as unknown as FleetRow[];
  // Create AND ensure both refresh the card: the ensure path self-heals fleets
  // that predate the publish leg, and the module's no-churn gate keeps an
  // unchanged card from re-federating on every launch.
  refreshDirectoryCard(input.workspaceId, input.fleetSlug, { sql });
  if (inserted[0]) return { record: rowToRecord(inserted[0]), created: true };
  const existing = await getFleet(input.workspaceId, input.fleetSlug, sql);
  if (!existing) {
    throw new Error(
      `createFleetIfAbsent: conflict on (${input.workspaceId}, ${input.fleetSlug}) but no row found`,
    );
  }
  return { record: existing, created: false };
}

/**
 * Set the current leader (D-002: the handoff agent becomes leader). Pass null to
 * clear. Idempotent; bumps updated_at. Returns null if the fleet doesn't exist.
 */
export async function setFleetLeader(
  workspaceId: string,
  fleetSlug: string,
  leaderOwnerId: string | null,
  sql?: Sql,
  expectedLeaderOwnerId?: string | null,
): Promise<AgentFleetRecord | null> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `UPDATE harness_shared.agent_fleets
        SET leader_owner_id = $3, leader_missing_since_ms = NULL, updated_at = $4
      WHERE workspace_id = $1 AND fleet_slug = $2
        AND ($5::boolean = false OR leader_owner_id IS NOT DISTINCT FROM $6::text)
      RETURNING ${COLS}`,
    [workspaceId, fleetSlug, leaderOwnerId, Date.now(), expectedLeaderOwnerId !== undefined, expectedLeaderOwnerId ?? null],
  )) as unknown as FleetRow[];
  if (rows[0]) refreshDirectoryCard(workspaceId, fleetSlug, { sql });
  return rows[0] ? rowToRecord(rows[0]) : null;
}

export interface MarkFleetLeaderMissingSinceInput {
  workspaceId: string;
  fleetSlug: string;
  /** Registry value observed before the complete presence read. */
  expectedLeaderOwnerId: string | null;
  /** Registry version observed before the complete presence read. */
  expectedUpdatedAtMs: number;
  /** Epoch-ms from the first complete observation of this absence episode. */
  observedAtMs: number;
}

/**
 * Start a leader-absence grace period from a complete liveness observation.
 * The caller must not invoke this for a partial/degraded roster. The expected
 * leader, unchanged observation version, and empty absence clock are checked
 * together, so an obsolete roster result cannot start a new absence episode.
 */
export async function markFleetLeaderMissingSince(
  input: MarkFleetLeaderMissingSinceInput,
  sql?: Sql,
): Promise<AgentFleetRecord | null> {
  if (!Number.isSafeInteger(input.expectedUpdatedAtMs) || !Number.isSafeInteger(input.observedAtMs)) {
    throw new RangeError('fleet leader-missing timestamps must be safe integer epoch milliseconds');
  }
  const rows = (await pg(sql).unsafe(
    `UPDATE harness_shared.agent_fleets
        SET leader_missing_since_ms = $5, updated_at = GREATEST(updated_at, $5)
      WHERE workspace_id = $1 AND fleet_slug = $2
        AND leader_owner_id IS NOT DISTINCT FROM $3::text
        AND updated_at = $4::bigint
        AND leader_missing_since_ms IS NULL
      RETURNING ${COLS}`,
    [input.workspaceId, input.fleetSlug, input.expectedLeaderOwnerId, input.expectedUpdatedAtMs, input.observedAtMs],
  )) as unknown as FleetRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

export interface ClearFleetLeaderMissingSinceInput {
  workspaceId: string;
  fleetSlug: string;
  expectedLeaderOwnerId: string | null;
  expectedLeaderMissingSinceMs: number;
  expectedUpdatedAtMs: number;
  observedAtMs: number;
}

/** Clear an absence episode only when the leader, clock, and row version still
 * match the values seen by the caller's complete liveness read. */
export async function clearFleetLeaderMissingSince(
  input: ClearFleetLeaderMissingSinceInput,
  sql?: Sql,
): Promise<AgentFleetRecord | null> {
  if (!Number.isSafeInteger(input.expectedLeaderMissingSinceMs) ||
      !Number.isSafeInteger(input.expectedUpdatedAtMs) ||
      !Number.isSafeInteger(input.observedAtMs)) {
    throw new RangeError('fleet leader-missing timestamps must be safe integer epoch milliseconds');
  }
  const rows = (await pg(sql).unsafe(
    `UPDATE harness_shared.agent_fleets
        SET leader_missing_since_ms = NULL, updated_at = GREATEST(updated_at, $5)
      WHERE workspace_id = $1 AND fleet_slug = $2
        AND leader_owner_id IS NOT DISTINCT FROM $3::text
        AND leader_missing_since_ms = $4::bigint
        AND updated_at = $6::bigint
      RETURNING ${COLS}`,
    [input.workspaceId, input.fleetSlug, input.expectedLeaderOwnerId,
      input.expectedLeaderMissingSinceMs, input.observedAtMs, input.expectedUpdatedAtMs],
  )) as unknown as FleetRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

export interface PromoteFleetLeaderIfMissingInput {
  workspaceId: string;
  fleetSlug: string;
  expectedLeaderOwnerId: string | null;
  expectedLeaderMissingSinceMs: number;
  expectedUpdatedAtMs: number;
  replacementLeaderOwnerId: string;
  nowMs: number;
  graceMs: number;
}

/**
 * Promote a live successor only after the stored first-seen absence clock has
 * aged past the grace period. Leader identity, first-seen timestamp, and the
 * grace threshold are a single PostgreSQL compare-and-swap predicate.
 */
export async function promoteFleetLeaderIfMissing(
  input: PromoteFleetLeaderIfMissingInput,
  sql?: Sql,
): Promise<AgentFleetRecord | null> {
  if (!Number.isSafeInteger(input.expectedLeaderMissingSinceMs) ||
      !Number.isSafeInteger(input.expectedUpdatedAtMs) ||
      !Number.isSafeInteger(input.nowMs) ||
      !Number.isSafeInteger(input.graceMs) || input.graceMs < 0) {
    throw new RangeError('fleet leader succession requires safe epoch milliseconds and a non-negative grace period');
  }
  const rows = (await pg(sql).unsafe(
    `UPDATE harness_shared.agent_fleets
        SET leader_owner_id = $4, leader_missing_since_ms = NULL, updated_at = $5
      WHERE workspace_id = $1 AND fleet_slug = $2
        AND leader_owner_id IS NOT DISTINCT FROM $3::text
        AND leader_missing_since_ms = $6::bigint
        AND leader_missing_since_ms <= $5::bigint - $7::bigint
        AND updated_at = $8::bigint
      RETURNING ${COLS}`,
    [input.workspaceId, input.fleetSlug, input.expectedLeaderOwnerId,
      input.replacementLeaderOwnerId, input.nowMs, input.expectedLeaderMissingSinceMs, input.graceMs,
      input.expectedUpdatedAtMs],
  )) as unknown as FleetRow[];
  if (rows[0]) refreshDirectoryCard(input.workspaceId, input.fleetSlug, { sql });
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/**
 * Set the fleet's typed CONTROL STATE (P-009 / H4): 'winding-down' | 'active'.
 * Records who flipped it, why, and when — the registry row is the durable
 * source late joiners read at orient. Idempotent re-sets refresh reason/by/at
 * (the newest invocation's word stands). Returns null if the fleet doesn't exist.
 *
 * WINDING-DOWN ALSO DISARMS THE HEADCOUNT GOVERNOR (WI-1454201). Winding a fleet
 * down means "stop new pulls"; leaving `headcount_target` armed meant the
 * top-up routine kept opening replacement members forever. Measured: fleet
 * `capless-inference-gateway-ship-2026-08-28` was wound down at 2026-08-30
 * 03:01Z on an already-shipped plan and the governor still relaunched a
 * DESKTOP member 20 times over the next 23h — each one booting, finding zero
 * claimable work, dying, and being replaced a minute later.
 *
 * `headcount_config` is deliberately PRESERVED: disabling automatic restoration
 * must not erase the boot-baked model/account/headless/carry contract a later
 * takeover, respawn, or explicit re-arm needs (same contract as
 * `setFleetHeadcountTarget(target: null)` and `getFleetHeadcountTarget`). So
 * resuming a fleet does NOT silently re-arm top-up — that is the safe
 * direction, and re-arming is an explicit `fleet:headcount-target` call.
 */
export async function setFleetControlState(
  workspaceId: string,
  fleetSlug: string,
  control: {
    state: FleetControlState;
    reason?: string | null;
    by?: string | null;
    /** WI-2034563: the declared, latching resume-gate key this park publishes for
     *  its members to await. Written only on a wind-down; a resume CLEARS it, so
     *  an active row can never carry a stale park's gate. */
    resumeGate?: string | null;
    /** WI-2034563: epoch-ms deadline bounding the park. Cleared on resume. */
    expiresAt?: number | null;
    /** WI-2034563: this park is deliberately terminal (nobody is coming back). */
    noResumePath?: boolean;
  },
  sql?: Sql,
  expectedLeaderOwnerId?: string | null,
  expected?: { state?: FleetControlState; updatedAtMs?: number },
): Promise<AgentFleetRecord | null> {
  const s = pg(sql);
  const now = Date.now();
  const hasExpectedState = expected?.state !== undefined;
  const hasExpectedUpdatedAt = expected?.updatedAtMs !== undefined;
  const rows = (await s.unsafe(
    `UPDATE harness_shared.agent_fleets
        SET control_state = $3, control_reason = $4, control_by = $5, control_at = $6, updated_at = $6,
            headcount_target = CASE WHEN $3::text = 'winding-down' THEN NULL ELSE headcount_target END,
            headcount_next_attempt_at =
              CASE WHEN $3::text = 'winding-down' THEN NULL ELSE headcount_next_attempt_at END,
            headcount_backoff_ms = CASE WHEN $3::text = 'winding-down' THEN 0 ELSE headcount_backoff_ms END,
            headcount_last_error = CASE WHEN $3::text = 'winding-down' THEN NULL ELSE headcount_last_error END,
            -- WI-2034563: the park's resume path belongs to the park. A resume
            -- clears all three so an ACTIVE row can never carry a dead park's gate
            -- or a lapsed deadline for a later reader to mistake for a live one.
            control_resume_gate =
              CASE WHEN $3::text = 'winding-down' THEN $13::text ELSE NULL END,
            control_expires_at =
              CASE WHEN $3::text = 'winding-down' THEN $14::bigint ELSE NULL END,
            control_no_resume_path =
              CASE WHEN $3::text = 'winding-down' THEN $15::boolean ELSE false END
      WHERE workspace_id = $1 AND fleet_slug = $2
        AND ($7::boolean = false OR leader_owner_id IS NOT DISTINCT FROM $8::text)
        AND ($9::boolean = false OR control_state = $10::text)
        AND ($11::boolean = false OR updated_at = $12::bigint)
      RETURNING ${COLS}`,
    [
      workspaceId,
      fleetSlug,
      control.state,
      control.reason ?? null,
      control.by ?? null,
      now,
      expectedLeaderOwnerId !== undefined,
      expectedLeaderOwnerId ?? null,
      hasExpectedState,
      expected?.state ?? null,
      hasExpectedUpdatedAt,
      expected?.updatedAtMs ?? null,
      control.resumeGate ?? null,
      control.expiresAt ?? null,
      control.noResumePath === true,
    ],
  )) as unknown as FleetRow[];
  if (rows[0]) refreshDirectoryCard(workspaceId, fleetSlug, { sql });
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Edit a fleet's directory metadata (title/description/type). No leader side effects.
 *  `fleetType` is how an EXISTING fleet is re-typed — createFleetIfAbsent is
 *  idempotent and therefore cannot change the type of a fleet that already
 *  exists (D-008/P-010). Omitted fields are left untouched (COALESCE). */
export async function updateFleetMeta(
  workspaceId: string,
  fleetSlug: string,
  meta: { title?: string | null; description?: string | null; fleetType?: FleetType },
  sql?: Sql,
): Promise<AgentFleetRecord | null> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `UPDATE harness_shared.agent_fleets
        SET title = COALESCE($3, title),
            description = COALESCE($4, description),
            fleet_type = COALESCE($6, fleet_type),
            updated_at = $5
      WHERE workspace_id = $1 AND fleet_slug = $2
      RETURNING ${COLS}`,
    [
      workspaceId,
      fleetSlug,
      meta.title ?? null,
      meta.description ?? null,
      Date.now(),
      // Narrow only when the caller actually asked for a change; passing NULL
      // leaves the stored type alone rather than silently resetting to 'single'.
      meta.fleetType === undefined ? null : asFleetType(meta.fleetType),
    ],
  )) as unknown as FleetRow[];
  if (rows[0]) refreshDirectoryCard(workspaceId, fleetSlug, { sql });
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Delete a fleet registry row. Idempotent. */
export async function deleteFleet(
  workspaceId: string,
  fleetSlug: string,
  sql?: Sql,
): Promise<boolean> {
  const s = pg(sql);
  const rows = (await s.begin(async (tx) => {
    const deleted = (await tx.unsafe(
      `DELETE FROM harness_shared.agent_fleets
        WHERE workspace_id = $1 AND fleet_slug = $2
        RETURNING fleet_slug`,
      [workspaceId, fleetSlug],
    )) as unknown as Array<{ fleet_slug: string }>;
    if (deleted.length === 0) return deleted;

    // Membership history is append-only and fleet-membership-store owns writes.
    // A registry deletion must append leave facts for owners whose latest fact
    // still names this fleet; otherwise fleet_assignment and fleetSlugOfAgent
    // keep projecting the deleted slug and fleet:* emitters can wake stale
    // sessions indefinitely.
    const currentMembers = (await tx.unsafe(
      `WITH candidate_owners AS (
         SELECT DISTINCT workspace_id, owner_id
           FROM harness_shared.fleet_membership_events
          WHERE workspace_id = $1 AND fleet_slug = $2
       ),
       latest_memberships AS (
         SELECT DISTINCT ON (e.workspace_id, e.owner_id)
                e.workspace_id, e.owner_id, e.owner_label, e.fleet_slug
           FROM harness_shared.fleet_membership_events e
           JOIN candidate_owners c
             ON c.workspace_id = e.workspace_id
            AND c.owner_id = e.owner_id
          ORDER BY e.workspace_id, e.owner_id, e.id DESC
       )
       SELECT owner_id, owner_label
         FROM latest_memberships
        WHERE fleet_slug = $2`,
      [workspaceId, fleetSlug],
    )) as unknown as Array<{ owner_id: string; owner_label: string | null }>;
    for (const member of currentMembers) {
      await appendFleetMembershipEvent(
        {
          workspaceId,
          ownerId: member.owner_id,
          ownerLabel: member.owner_label,
          fleetSlug: null,
          fleetRole: null,
          event: 'leave',
        },
        tx,
      );
    }
    return deleted;
  })) as unknown as Array<{ fleet_slug: string }>;
  // All current members leave in the same transaction as registry deletion.
  // Historical membership remains available through fleetEverMembers.
  // Archive (not delete) the directory card — remote projections need the
  // signed archived record to stop resolving members/scopes (D-006/H10).
  if (rows.length > 0) refreshDirectoryCard(workspaceId, fleetSlug, { archived: true, sql });
  return rows.length > 0;
}

// ─── Color schemes (fleet-color-schemes-2026-06-30) ──────────────────

/**
 * Pick the next catalog scheme NAME for a new fleet in this workspace: the first
 * scheme not already bound to a fleet here (so distinct fleets stay distinct).
 * Best-effort distinctness — there's a benign race if two fleets are created at
 * once, and the catalog wraps once every scheme is in use.
 */
async function allocateSchemeForWorkspace(workspaceId: string, sql?: Sql): Promise<string> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT color_scheme FROM harness_shared.agent_fleets
      WHERE workspace_id = $1 AND color_scheme IS NOT NULL`,
    [workspaceId],
  )) as unknown as Array<{ color_scheme: string }>;
  return allocateNextSchemeName(rows.map((r) => r.color_scheme));
}

/**
 * Resolve a fleet record to its concrete {@link ColorScheme}: the persisted
 * binding if present, else a deterministic slug-hash fallback for legacy rows.
 * Always returns a real catalog scheme.
 */
export function resolveFleetScheme(record: AgentFleetRecord): ColorScheme {
  return schemeByName(record.colorScheme) ?? schemeForSlug(record.fleetSlug);
}

/** The bound scheme for a fleet slug, or null if the fleet doesn't exist. */
export async function getFleetScheme(
  workspaceId: string,
  fleetSlug: string,
  sql?: Sql,
): Promise<ColorScheme | null> {
  const fleet = await getFleet(workspaceId, fleetSlug, sql);
  return fleet ? resolveFleetScheme(fleet) : null;
}

/**
 * Override a fleet's bound scheme (the otherwise-immutable binding) — the
 * `fleet:recolor` escape hatch. Returns null if the fleet doesn't exist.
 */
export async function setFleetScheme(
  workspaceId: string,
  fleetSlug: string,
  schemeName: string,
  sql?: Sql,
): Promise<AgentFleetRecord | null> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `UPDATE harness_shared.agent_fleets
        SET color_scheme = $3, updated_at = $4
      WHERE workspace_id = $1 AND fleet_slug = $2
      RETURNING ${COLS}`,
    [workspaceId, fleetSlug, schemeName, Date.now()],
  )) as unknown as FleetRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Result of {@link claimFleetLaunchSlot}: the caller either WON the slot (proceed to
 *  spawn; `at` is the recorded claim time, needed to release on a fully-failed spawn)
 *  or lost to a fresh prior launch (suppress — `priorAt`/`priorCount` feed the notice). */
export type FleetLaunchSlot =
  | { won: true; at: number }
  | { won: false; priorAt: number; priorCount: number };

/**
 * Atomically claim a fleet's launch slot — the fleet:launch-on-plan idempotency guard.
 * ONE winner per (workspace, fleet) per `windowMs`, across ALL operator workers: the
 * check-and-set runs as a single SQL UPDATE, replacing the per-worker in-process Map
 * that let a weak model open 6 member waves in 40s on 2026-07-03 (each re-fire landed
 * on a different :3070 worker whose map was empty). Call AFTER createFleetIfAbsent —
 * the row must exist; a missing row fails OPEN (won, unrecorded) rather than wedging
 * the launch. `now` is injectable for deterministic window tests.
 *
 * `allowCountIncreaseWithinWindow` is the canary-first/top-up exception (EI-13483):
 * a strictly higher declarative target may atomically advance the slot while a
 * verified member is already live. The comparison and update remain ONE SQL
 * statement, so concurrent callers asking for the same higher target still yield
 * exactly one winner. Callers that use `count` as a wave size keep the historical
 * time-window-only behavior by leaving the option false.
 */
export async function claimFleetLaunchSlot(opts: {
  workspaceId: string;
  fleetSlug: string;
  count: number;
  windowMs: number;
  allowCountIncreaseWithinWindow?: boolean;
  now?: number;
  sql?: Sql;
}): Promise<FleetLaunchSlot> {
  const s = pg(opts.sql);
  const now = opts.now ?? Date.now();
  const won = (await s.unsafe(
    `UPDATE harness_shared.agent_fleets
        SET last_launch_at = $3, last_launch_count = $4, updated_at = $3
      WHERE workspace_id = $1 AND fleet_slug = $2
        AND (
          last_launch_at IS NULL
          OR last_launch_at < $5
          OR ($6 AND COALESCE(last_launch_count, 0) < $4)
        )
      RETURNING fleet_slug`,
    [
      opts.workspaceId,
      opts.fleetSlug,
      now,
      opts.count,
      now - opts.windowMs,
      opts.allowCountIncreaseWithinWindow ?? false,
    ],
  )) as unknown as Array<{ fleet_slug: string }>;
  if (won.length > 0) return { won: true, at: now };
  const prior = (await s.unsafe(
    `SELECT last_launch_at, last_launch_count FROM harness_shared.agent_fleets
      WHERE workspace_id = $1 AND fleet_slug = $2`,
    [opts.workspaceId, opts.fleetSlug],
  )) as unknown as Array<{ last_launch_at: string | number | null; last_launch_count: number | null }>;
  if (!prior[0] || prior[0].last_launch_at == null) return { won: true, at: now }; // fleet row vanished — fail open
  return { won: false, priorAt: Number(prior[0].last_launch_at), priorCount: Number(prior[0].last_launch_count ?? 0) };
}

/**
 * Release a launch slot claimed at `at` — ONLY when the launch it guarded opened
 * nothing (every spawn failed), so an immediate legitimate retry isn't suppressed
 * for the whole window. Guarded by `last_launch_at = at` so it never clears a
 * NEWER launch's claim.
 */
export async function releaseFleetLaunchSlot(opts: {
  workspaceId: string;
  fleetSlug: string;
  at: number;
  sql?: Sql;
}): Promise<void> {
  const s = pg(opts.sql);
  await s.unsafe(
    `UPDATE harness_shared.agent_fleets
        SET last_launch_at = NULL, last_launch_count = NULL
      WHERE workspace_id = $1 AND fleet_slug = $2 AND last_launch_at = $3`,
    [opts.workspaceId, opts.fleetSlug, opts.at],
  );
}

/** Persist the exact canary-first launch/recovery transaction on the existing
 * fleet registry row. This is intentionally one versioned JSONB column rather
 * than a parallel launch store (P-003 / D-003). */
export async function setFleetLaunchTransaction(opts: {
  workspaceId: string;
  fleetSlug: string;
  transaction: FleetLaunchTransaction | null;
  /** Optional compare-and-set guard for a caller that read, derived, then writes
   * a launch transaction. The governor and launch completion path share this
   * JSONB cell; without the revision guard an older governor snapshot can erase
   * a newer launch after it loses the independent launch slot. Omit only for an
   * authoritative/unconditional replacement. */
  expectedRevision?: {
    transactionId: string | null;
    updatedAt: number | null;
  } | null;
  sql?: Sql;
}): Promise<boolean> {
  const s = pg(opts.sql);
  const guarded = opts.expectedRevision !== undefined;
  const expectedTransactionId = opts.expectedRevision?.transactionId ?? null;
  const expectedUpdatedAt = opts.expectedRevision?.updatedAt ?? null;
  const rows = (await s.unsafe(
    `UPDATE harness_shared.agent_fleets
        SET last_launch_transaction = $3::text::jsonb, updated_at = $4
      WHERE workspace_id = $1 AND fleet_slug = $2
        AND (
          $5::boolean = FALSE
          OR (
            $6::text IS NULL
            AND last_launch_transaction IS NULL
          )
          OR (
            $6::text IS NOT NULL
            AND (
              CASE jsonb_typeof(last_launch_transaction)
                WHEN 'string' THEN (last_launch_transaction #>> '{}')::jsonb
                ELSE last_launch_transaction
              END
            ) @> jsonb_build_object(
              'transactionId', $6::text,
              'updatedAt', $7::bigint
            )
          )
        )
      RETURNING fleet_slug`,
    [
      opts.workspaceId,
      opts.fleetSlug,
      opts.transaction == null ? null : JSON.stringify(opts.transaction),
      Date.now(),
      guarded,
      expectedTransactionId,
      expectedUpdatedAt,
    ],
  )) as unknown as Array<{ fleet_slug: string }>;
  return rows.length > 0;
}

/** Persist or disable the target recipe. This is intentionally separate from COLS so
 * legacy fleet reads remain compatible with pre-600 test schemas. */
export async function setFleetHeadcountTarget(opts: {
  workspaceId: string;
  fleetSlug: string;
  target: number | null;
  config?: FleetHeadcountConfig;
  /** P-005 / D-030: the no-top-up rule this write ratifies. A write WITHOUT one
   * clears any stored rule: re-arming ends a rule, and a system disarm (terminal
   * plan) must never leave a rule whose lapse would re-arm a finished fleet. */
  topUpRule?: FleetTopUpRule;
  sql?: Sql;
}): Promise<void> {
  const s = pg(opts.sql);
  if (opts.target == null) {
    // The rule rides the PRESERVED recipe: a disabled row keeps headcount_config
    // for takeover/respawn, so `||` merges into it and `-` strips from it. A row
    // with no recipe has nothing a rule could ever restore, so it stays NULL.
    // Only an OBJECT recipe is edited: on a jsonb scalar `-` throws and `||`
    // wraps both sides into an array, so any other shape is left as it was.
    // `$4::text::jsonb` (not `$4::jsonb`): see the non-null branch below.
    await s.unsafe(
      `UPDATE harness_shared.agent_fleets
          SET headcount_target = NULL,
              headcount_config = CASE
                WHEN headcount_config IS NULL OR jsonb_typeof(headcount_config) <> 'object' THEN headcount_config
                WHEN $4::text IS NULL THEN headcount_config - 'topUpRule'
                ELSE headcount_config || jsonb_build_object('topUpRule', $4::text::jsonb)
              END,
              headcount_next_attempt_at = NULL, headcount_backoff_ms = 0,
              headcount_last_error = NULL, updated_at = $3
        WHERE workspace_id = $1 AND fleet_slug = $2`,
      [opts.workspaceId, opts.fleetSlug, Date.now(), opts.topUpRule ? JSON.stringify(opts.topUpRule) : null],
    );
    return;
  }
  if (!opts.config) throw new Error('headcount target requires a launch configuration');
  const { topUpRule: _staleRule, ...rest } = normalizeFleetHeadcountConfig(opts.config);
  const config: FleetHeadcountConfig = opts.topUpRule ? { ...rest, topUpRule: opts.topUpRule } : rest;
  // `$4::text::jsonb`, never `$4::jsonb`: a client that learns the parameter's
  // type (the test fixture's does) JSON-encodes the already-stringified recipe a
  // second time, storing a jsonb STRING scalar that every jsonb operator above
  // then misreads. Typed as text, every client sends the raw string and the
  // server parses it into an object.
  await s.unsafe(
    `UPDATE harness_shared.agent_fleets
        SET headcount_target = $3, headcount_config = $4::text::jsonb,
            headcount_next_attempt_at = NULL, headcount_backoff_ms = 0,
            headcount_last_error = NULL, updated_at = $5
      WHERE workspace_id = $1 AND fleet_slug = $2`,
    [opts.workspaceId, opts.fleetSlug, opts.target, JSON.stringify(config), Date.now()],
  );
}

/** One fleet whose no-top-up rule has passed its `until`. */
export interface ExpiredFleetTopUpRule {
  workspaceId: string;
  fleetSlug: string;
  rule: FleetTopUpRule;
  config: FleetHeadcountConfig;
}

/**
 * P-005 / D-030: rules past their `until` on fleets that are not winding down.
 * A malformed rule is not listed (it cannot be trusted to restore anything); the
 * read surfaces already report it as an expired, malformed rule.
 */
export async function listExpiredFleetTopUpRules(
  workspaceId: string,
  now: number,
  sql?: Sql,
): Promise<ExpiredFleetTopUpRule[]> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT workspace_id, fleet_slug, headcount_config
       FROM harness_shared.agent_fleets
      WHERE workspace_id = $1
        AND headcount_config ? 'topUpRule'
        AND control_state IS DISTINCT FROM 'winding-down'
        AND jsonb_typeof(headcount_config->'topUpRule'->'until') = 'number'
        AND (headcount_config->'topUpRule'->>'until')::numeric <= $2
      ORDER BY updated_at ASC`,
    [workspaceId, now],
  )) as unknown as Array<{ workspace_id: string; fleet_slug: string; headcount_config: unknown }>;
  const out: ExpiredFleetTopUpRule[] = [];
  for (const row of rows) {
    const raw = typeof row.headcount_config === 'string' ? JSON.parse(row.headcount_config) : row.headcount_config;
    const rule = parseFleetTopUpRule((raw as { topUpRule?: unknown } | null)?.topUpRule);
    if (!rule) continue;
    out.push({
      workspaceId: row.workspace_id,
      fleetSlug: row.fleet_slug,
      rule,
      config: normalizeFleetHeadcountConfig(raw as Record<string, unknown>),
    });
  }
  return out;
}

/**
 * P-005 / D-030: end one expired rule. `restore:true` puts back what the rule
 * suspended (the target for 'target-disabled', the supervise grant for either
 * kind) so the governor holds the fleet again; `restore:false` only clears the
 * rule (used when the fleet's plan is terminal). Compare-and-set on the rule's
 * `until`: a re-ratification that lands first wins and this write is a no-op.
 * Returns whether this call ended the rule.
 */
export async function lapseFleetTopUpRule(opts: {
  workspaceId: string;
  fleetSlug: string;
  expectedUntil: number;
  restore: boolean;
  now?: number;
  sql?: Sql;
}): Promise<boolean> {
  const s = pg(opts.sql);
  const rows = (await s.unsafe(
    `UPDATE harness_shared.agent_fleets
        SET headcount_target = CASE
              WHEN $4::boolean
               AND headcount_config->'topUpRule'->>'kind' = 'target-disabled'
               AND jsonb_typeof(headcount_config->'topUpRule'->'suspendedTarget') = 'number'
                THEN (headcount_config->'topUpRule'->>'suspendedTarget')::int
              ELSE headcount_target
            END,
            headcount_config = (headcount_config - 'topUpRule') || CASE
              WHEN $4::boolean
               AND jsonb_typeof(headcount_config->'topUpRule'->'suspendedSupervise') = 'boolean'
                THEN jsonb_build_object('supervise', headcount_config->'topUpRule'->'suspendedSupervise')
              ELSE '{}'::jsonb
            END,
            headcount_next_attempt_at = NULL, headcount_backoff_ms = 0,
            headcount_last_error = NULL, updated_at = $5
      WHERE workspace_id = $1 AND fleet_slug = $2
        AND control_state IS DISTINCT FROM 'winding-down'
        AND jsonb_typeof(headcount_config->'topUpRule'->'until') = 'number'
        AND (headcount_config->'topUpRule'->>'until')::numeric = $3
      RETURNING fleet_slug`,
    [opts.workspaceId, opts.fleetSlug, opts.expectedUntil, opts.restore, opts.now ?? Date.now()],
  )) as unknown as Array<{ fleet_slug: string }>;
  return rows.length > 0;
}

function headcountRowToTarget(r: {
  workspace_id: string;
  fleet_slug: string;
  headcount_target: number | null;
  headcount_config: FleetHeadcountConfig | Record<string, unknown> | string;
  headcount_next_attempt_at: string | number | null;
  headcount_backoff_ms: string | number | null;
  headcount_last_error: string | null;
}): FleetHeadcountTarget {
  const rawConfig = typeof r.headcount_config === 'string' ? JSON.parse(r.headcount_config) : r.headcount_config;
  const normalizedLegacyContextSize = (rawConfig as { contextSize?: unknown })?.contextSize === 'full';
  const config = normalizeFleetHeadcountConfig(rawConfig as Record<string, unknown>);
  return {
    workspaceId: r.workspace_id,
    fleetSlug: r.fleet_slug,
    enabled: r.headcount_target != null,
    // A disabled governor still carries a canonical launch profile. Saved-spec
    // consumers reconstruct one member from that profile, while governor reads
    // continue filtering on headcount_target IS NOT NULL and stay disabled.
    target: Number(r.headcount_target ?? 1),
    config,
    ...(normalizedLegacyContextSize ? { normalizedLegacyContextSize: true } : {}),
    nextAttemptAt: r.headcount_next_attempt_at == null ? null : Number(r.headcount_next_attempt_at),
    backoffMs: Number(r.headcount_backoff_ms ?? 0),
    lastError: r.headcount_last_error ?? null,
  };
}

const HEADCOUNT_COLS = `workspace_id, fleet_slug, headcount_target, headcount_config,
  headcount_next_attempt_at, headcount_backoff_ms, headcount_last_error`;

/**
 * Read all enabled targets in one workspace.
 *
 * A WINDING-DOWN FLEET IS NEVER ENABLED (WI-1454201). `setFleetControlState`
 * already clears the target on wind-down, so this predicate is the second,
 * independent half of that fix: it also covers rows wound down by an older
 * build (or by a direct write) whose target was left armed. Both halves are
 * deliberate — either one alone leaves the trap re-armable.
 */
export async function listFleetHeadcountTargets(workspaceId: string, sql?: Sql): Promise<FleetHeadcountTarget[]> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT ${HEADCOUNT_COLS} FROM harness_shared.agent_fleets
      WHERE workspace_id = $1 AND headcount_target IS NOT NULL AND headcount_config IS NOT NULL
        AND control_state IS DISTINCT FROM 'winding-down'
      ORDER BY updated_at ASC`,
    [workspaceId],
  )) as unknown as Parameters<typeof headcountRowToTarget>[0][];
  return rows.map(headcountRowToTarget);
}

/**
 * Read one fleet's persisted launch profile without scanning every enabled
 * target. Unlike the governor reads above, this intentionally returns a saved
 * config even when headcount_target is NULL: disabling automatic restoration
 * must not erase the boot-baked model/account/headless/carry contract needed by
 * a later takeover, respawn, or explicit top-up.
 */
export async function getFleetHeadcountTarget(
  workspaceId: string,
  fleetSlug: string,
  sql?: Sql,
): Promise<FleetHeadcountTarget | null> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT ${HEADCOUNT_COLS} FROM harness_shared.agent_fleets
      WHERE workspace_id = $1 AND fleet_slug = $2
        AND headcount_config IS NOT NULL
      LIMIT 1`,
    [workspaceId, fleetSlug],
  )) as unknown as Parameters<typeof headcountRowToTarget>[0][];
  return rows[0] ? headcountRowToTarget(rows[0]) : null;
}

/** Claim one retry lease. The lease is the duplicate-suppression barrier between ticks.
 *  Refuses a winding-down fleet for the same reason as `listFleetHeadcountTargets`
 *  (WI-1454201) — this is the barrier a member is actually opened behind, so the
 *  predicate has to hold here even if a caller reached it without enumerating. */
export async function claimFleetHeadcountAttempt(opts: {
  workspaceId: string;
  fleetSlug: string;
  now?: number;
  leaseMs?: number;
  sql?: Sql;
}): Promise<FleetHeadcountAttempt | null> {
  const s = pg(opts.sql);
  const now = opts.now ?? Date.now();
  const leaseMs = opts.leaseMs ?? HEADCOUNT_INITIAL_BACKOFF_MS;
  const rows = (await s.unsafe(
    `UPDATE harness_shared.agent_fleets
        SET headcount_next_attempt_at = $3 + $4, updated_at = $3
      WHERE workspace_id = $1 AND fleet_slug = $2
        AND headcount_target IS NOT NULL AND headcount_config IS NOT NULL
        AND control_state IS DISTINCT FROM 'winding-down'
        AND (headcount_next_attempt_at IS NULL OR headcount_next_attempt_at <= $3)
      RETURNING ${HEADCOUNT_COLS}`,
    [opts.workspaceId, opts.fleetSlug, now, leaseMs],
  )) as unknown as Parameters<typeof headcountRowToTarget>[0][];
  if (!rows[0]) return null;
  return { ...headcountRowToTarget(rows[0]), claimedAt: now };
}

/** Record a completed top-up attempt and advance/reset exponential backoff. */
export async function recordFleetHeadcountAttempt(opts: {
  workspaceId: string;
  fleetSlug: string;
  succeeded: boolean;
  error?: string | null;
  now?: number;
  sql?: Sql;
}): Promise<void> {
  const s = pg(opts.sql);
  const now = opts.now ?? Date.now();
  if (opts.succeeded) {
    await s.unsafe(
      `UPDATE harness_shared.agent_fleets
          SET headcount_next_attempt_at = NULL, headcount_backoff_ms = 0,
              headcount_last_error = NULL, updated_at = $3
        WHERE workspace_id = $1 AND fleet_slug = $2`,
      [opts.workspaceId, opts.fleetSlug, now],
    );
    return;
  }
  await s.unsafe(
    `UPDATE harness_shared.agent_fleets
        SET headcount_backoff_ms = LEAST(${HEADCOUNT_MAX_BACKOFF_MS},
              GREATEST(${HEADCOUNT_INITIAL_BACKOFF_MS}, headcount_backoff_ms * 2)),
            headcount_next_attempt_at = $3 + LEAST(${HEADCOUNT_MAX_BACKOFF_MS},
              GREATEST(${HEADCOUNT_INITIAL_BACKOFF_MS}, headcount_backoff_ms * 2)),
            headcount_last_error = $4, updated_at = $3
      WHERE workspace_id = $1 AND fleet_slug = $2`,
    [opts.workspaceId, opts.fleetSlug, now, (opts.error ?? 'top-up failed').slice(0, 500)],
  );
}
