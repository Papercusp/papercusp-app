/**
 * fleet:respawn-member — a fleet LEADER changes ONE member's BOOT-BAKED settings by draining +
 * relaunching it (per-member-declarative-launch-specs P-008, D-003). Boot-baked settings
 * (model / effort / account / contextSize / agent / compactionLimit) are fixed at process launch —
 * a running session cannot change them (unlike the runtime settings fleet:reconfigure-member
 * adjusts in place). So a respawn KILLS the old session (graceful SIGTERM via fleet:kill, releasing
 * its claims) and FRESH-LAUNCHES a replacement into the SAME fleet with the new declarative
 * MemberSpec (capability:launch-agent), which inherits the fleet's claim lane and mints a new
 * identity — one tool instead of a hand-rolled kill + relaunch.
 *
 * Scope: this routes the relaunch through capability:launch-agent (the headless-fleet-member door
 * the fleet already uses), so `carry` / `claimKinds` — which only fleet:launch-on-plan honors — are
 * NOT settable here (use fleet:reconfigure-member for the claim lane; fleet:launch-on-plan for a
 * carry change). Member resolution + leader/queen/owner auth are the shared resolveFleetMemberTarget.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { assembleRolePrompt } from '@papercusp/orchestrator/role-prompt';
import type { MemberSpec } from '../../agent-launch-core';
import killTool from '../fleet/kill';
import launchTool from '../capability/launch-agent';
import { resolveFleetMemberTarget } from './member-target';
import { getPresence } from '../coordination/presence';
import { listFleetPresence, type FleetPresenceRow } from '../coordination/presence-fleet';
import { sendMessage } from '../coordination/messages';
import { wakeRecipients } from '../coordination/inbox-wake';
import { findLiveHost } from '../../events/await/psu-pty-discovery';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { getSessionBrief } from '../../session-brief';
import { resolveProjectDir } from '../../spawn-config';
import { isSuTierRole } from '../../su-role-addendum';
import { PAIR_ROLE_IMPLEMENTER } from './pair-launch-options';
import { json, ROUTING_LADDER } from './_shared';
import { resolveSavedFleetLaunchSpec } from './saved-launch-spec';
import { readAgentConfig } from '../../agent-config';
import { resolveGoalLaunch } from '../../goal-launch-settings';
import {
  backendForModelSpec,
  CLOUD_MODEL_MENU,
  composeLaunchModelSpec,
  DEFAULT_MODEL_TIERS,
  splitModelSpec,
  type LaunchAgentBackend,
  type ModelTier,
} from '../../agent-config-constants';
import {
  getFleet,
  setFleetLaunchTransaction,
  type FleetLaunchTransaction,
} from '../../agent-fleets-store';
import { decideMemberRecovery, type MemberRecoveryDecision } from '../../fleet/member-recovery';
import { strandWedgedMember, type StrandMemberResult } from '../../fleet/member-recovery-actions';
import { listTasks, markStranded } from '../../task-manager/store';
import { freezeTask } from '../../task-manager/control';
import { emitFleetTransitionEdge } from '../../fleet-transition-events';

/** Default window to wait for the replacement's FIRST heartbeat before calling the respawn failed. */
const DEFAULT_VERIFY_SEC = 90;
// EI-21266158571232094: the two caller-controlled waits are each bounded at 300s, so the
// dispatch budget must cover a worst-case cooperative drain + replacement verification (600s)
// plus launch/serialization headroom. Without an explicit tool budget, the dispatch stack's 60s
// default (and the flat MCP deadline) aborts a valid respawn while it is still draining/verifying.
const RESPAWN_TIMEOUT_SEC = 660;
const VERIFY_POLL_MS = 3_000;
/** A live unmanaged session needs a bounded cooperative-drain window before it can be replaced. */
const DEFAULT_DRAIN_VERIFY_SEC = 90;
const DRAIN_POLL_MS = 3_000;
/** A presence row counts as the live replacement only if its heartbeat is this fresh. */
const VERIFY_FRESH_MS = 120_000;

/**
 * Older paired-fleet launches persisted the shorthand `implementer`, while the
 * paired launch contract now uses the registered `directed-implementer`
 * persona. Keep this compatibility mapping local to recovery: new launches
 * still validate and persist exactly the role the caller supplied.
 */
function normalizeRespawnRole(role?: string): string | undefined {
  const trimmed = role?.trim();
  if (!trimmed) return trimmed;
  return trimmed === 'implementer' ? PAIR_ROLE_IMPLEMENTER : trimmed;
}

/**
 * Mint the identity that the replacement process will use before launching it. A stable value
 * for an idempotent retry lets a deduped launch be verified against the same owner; an unkeyed
 * call gets a fresh identity. The owner id is deliberately opaque to roster ordering — two
 * concurrent respawns must never both select whichever new row happens to sort first.
 */
function replacementOwnerId(fleetSlug: string, memberOwnerId: string, idempotencyKey?: string): string {
  const key = idempotencyKey?.trim();
  if (key) {
    const digest = createHash('sha256')
      .update(`fleet:respawn-member\u0000${fleetSlug}\u0000${memberOwnerId}\u0000${key}`)
      .digest('hex')
      .slice(0, 32);
    return `su-respawn-${digest}`;
  }
  return `su-respawn-${randomUUID()}`;
}

const RESPAWN_HISTORY_LIMIT = 32;

function replaceMemberIds(ids: readonly string[] | undefined, drainedOwnerId: string, replacementOwnerId: string): string[] {
  return [...new Set((ids ?? []).map((ownerId) => ownerId === drainedOwnerId ? replacementOwnerId : ownerId))];
}

function addMemberId(ids: readonly string[], ownerId: string): string[] {
  return [...new Set([...ids, ownerId])];
}

function removeMemberId(ids: readonly string[], ownerId: string): string[] {
  return ids.filter((candidate) => candidate !== ownerId);
}

export type RespawnLaunchOutcome = 'launch-failed' | 'unverified' | 'verified';

/**
 * Reconcile a member replacement into the latest durable launch transaction without mutating the
 * transaction that was read. The old owner is retained only as governor history/retirement and
 * failure evidence; every recovery identity points at the replacement. The replacement starts
 * unresolved so a presence/worker verification is still required before it can leave retry state.
 */
export function reconcileRespawnLaunchTransaction(args: {
  transaction: FleetLaunchTransaction;
  drainedOwnerId: string;
  replacementOwnerId: string;
  now?: number;
}): FleetLaunchTransaction {
  const { transaction, drainedOwnerId, replacementOwnerId } = args;
  const now = args.now ?? Date.now();
  const replacement = (ids: readonly string[] | undefined) =>
    replaceMemberIds(ids, drainedOwnerId, replacementOwnerId);
  const unconfirmedMemberIds = replacement(transaction.unconfirmedMemberIds);
  if (!unconfirmedMemberIds.includes(replacementOwnerId)) unconfirmedMemberIds.push(replacementOwnerId);

  const retryOwnerIds = replacement(transaction.recovery.retryOwnerIds);
  if (!retryOwnerIds.includes(replacementOwnerId)) retryOwnerIds.push(replacementOwnerId);

  const priorGovernor = transaction.governor;
  const history = [...(priorGovernor?.history ?? [])];
  const alreadyRecorded = history.some(
    (event) => event.action === 'respawn' && event.ownerId === drainedOwnerId && event.replacementOwnerId === replacementOwnerId,
  );
  if (!alreadyRecorded) {
    history.push({
      at: now,
      action: 'respawn',
      transactionId: transaction.transactionId,
      ownerId: drainedOwnerId,
      replacementOwnerId,
      reason: `respawn-member replaced drained owner ${drainedOwnerId} with unresolved replacement ${replacementOwnerId}`,
    });
  }
  const governor = {
    version: 1 as const,
    // A legacy live member can be absent from the current transaction's probe cohort.
    // Merely replacing ids would then leave its freshly launched replacement unprobed too,
    // so no later governor tick could collect typed worker readiness for that seat. Every
    // respawn is a new boot and must enter the probe cohort regardless of whether the drained
    // identity was previously eligible for attestation.
    probeOwnerIds: addMemberId(
      replacement(priorGovernor?.probeOwnerIds ?? transaction.requestedMemberIds),
      replacementOwnerId,
    ),
    attestationAttempts: Object.fromEntries(
      Object.entries(priorGovernor?.attestationAttempts ?? {})
        .filter(([ownerId]) => ownerId !== drainedOwnerId && ownerId !== replacementOwnerId),
    ),
    retiredMemberIds: [
      ...new Set([
        ...(priorGovernor?.retiredMemberIds ?? []).filter((ownerId) => ownerId !== replacementOwnerId),
        drainedOwnerId,
      ]),
    ],
    history: history.slice(-RESPAWN_HISTORY_LIMIT),
    terminalVerdict: null,
    ...(priorGovernor?.capacity ? { capacity: priorGovernor.capacity } : {}),
  };

  return {
    ...transaction,
    state: 'partial',
    updatedAt: now,
    requestedMemberIds: replacement(transaction.requestedMemberIds),
    openedMemberIds: replacement(transaction.openedMemberIds),
    verifiedMemberIds: replacement(transaction.verifiedMemberIds),
    unconfirmedMemberIds,
    ...(transaction.workerReadyMemberIds
      ? { workerReadyMemberIds: transaction.workerReadyMemberIds.filter((ownerId) => ownerId !== drainedOwnerId && ownerId !== replacementOwnerId) }
      : {}),
    ...(transaction.workerAttestations
      ? { workerAttestations: transaction.workerAttestations.filter((attestation) => attestation.ownerId !== drainedOwnerId && attestation.ownerId !== replacementOwnerId) }
      : {}),
    failed: transaction.failed.map((failure) => ({ ...failure })),
    waves: transaction.waves.map((wave) => ({
      ...wave,
      ownerIds: replacement(wave.ownerIds),
      ...(wave.openedOwnerIds ? { openedOwnerIds: replacement(wave.openedOwnerIds) } : {}),
      ...(wave.verifiedOwnerIds ? { verifiedOwnerIds: replacement(wave.verifiedOwnerIds) } : {}),
    })),
    recovery: {
      ...transaction.recovery,
      retryOwnerIds,
      nextAction: `replacement ${replacementOwnerId} is pending respawn verification; do not replay the drained owner ${drainedOwnerId}`,
    },
    ...(transaction.requestedMembers
      ? {
          requestedMembers: transaction.requestedMembers.map((member) => ({
            ...member,
            ownerId: member.ownerId === drainedOwnerId ? replacementOwnerId : member.ownerId,
          })),
        }
      : {}),
    governor,
  };
}

function settleRespawnLaunchTransaction(
  transaction: FleetLaunchTransaction,
  replacementOwnerId: string,
  outcome: RespawnLaunchOutcome,
  reason: string | undefined,
): FleetLaunchTransaction {
  const next: FleetLaunchTransaction = {
    ...transaction,
    requestedMemberIds: [...transaction.requestedMemberIds],
    openedMemberIds: [...transaction.openedMemberIds],
    verifiedMemberIds: [...transaction.verifiedMemberIds],
    unconfirmedMemberIds: [...(transaction.unconfirmedMemberIds ?? [])],
    failed: transaction.failed.map((failure) => ({ ...failure })),
    waves: transaction.waves.map((wave) => ({
      ...wave,
      ownerIds: [...wave.ownerIds],
      ...(wave.openedOwnerIds ? { openedOwnerIds: [...wave.openedOwnerIds] } : {}),
      ...(wave.verifiedOwnerIds ? { verifiedOwnerIds: [...wave.verifiedOwnerIds] } : {}),
    })),
    recovery: { ...transaction.recovery, retryOwnerIds: [...transaction.recovery.retryOwnerIds] },
    ...(transaction.workerReadyMemberIds ? { workerReadyMemberIds: [...transaction.workerReadyMemberIds] } : {}),
    ...(transaction.workerAttestations ? { workerAttestations: transaction.workerAttestations.map((attestation) => ({ ...attestation })) } : {}),
    ...(transaction.requestedMembers ? { requestedMembers: transaction.requestedMembers.map((member) => ({ ...member })) } : {}),
    ...(transaction.governor
      ? {
          governor: {
            ...transaction.governor,
            probeOwnerIds: [...transaction.governor.probeOwnerIds],
            attestationAttempts: { ...transaction.governor.attestationAttempts },
            retiredMemberIds: [...transaction.governor.retiredMemberIds],
            history: [...transaction.governor.history],
            terminalVerdict: transaction.governor.terminalVerdict,
          },
        }
      : {}),
  };

  if (outcome === 'verified') {
    next.openedMemberIds = addMemberId(next.openedMemberIds, replacementOwnerId);
    next.verifiedMemberIds = addMemberId(next.verifiedMemberIds, replacementOwnerId);
    next.unconfirmedMemberIds = removeMemberId(next.unconfirmedMemberIds ?? [], replacementOwnerId);
    next.recovery.retryOwnerIds = removeMemberId(next.recovery.retryOwnerIds ?? [], replacementOwnerId);
    next.recovery.nextAction = `respawn replacement ${replacementOwnerId} verified`;
  } else if (outcome === 'unverified') {
    next.openedMemberIds = addMemberId(next.openedMemberIds, replacementOwnerId);
    next.verifiedMemberIds = removeMemberId(next.verifiedMemberIds ?? [], replacementOwnerId);
    next.unconfirmedMemberIds = addMemberId(next.unconfirmedMemberIds ?? [], replacementOwnerId);
    next.recovery.retryOwnerIds = addMemberId(next.recovery.retryOwnerIds, replacementOwnerId);
    next.recovery.nextAction = reason ?? `respawn replacement ${replacementOwnerId} launched but remains unverified`;
  } else {
    next.openedMemberIds = removeMemberId(next.openedMemberIds ?? [], replacementOwnerId);
    next.verifiedMemberIds = removeMemberId(next.verifiedMemberIds ?? [], replacementOwnerId);
    next.unconfirmedMemberIds = removeMemberId(next.unconfirmedMemberIds ?? [], replacementOwnerId);
    next.recovery.retryOwnerIds = addMemberId(next.recovery.retryOwnerIds, replacementOwnerId);
    next.recovery.nextAction = reason ?? `respawn replacement ${replacementOwnerId} failed to launch`;
    if (!next.failed.some((failure) => failure.ownerId === replacementOwnerId && failure.phase === 'spawn')) {
      next.failed.push({ ownerId: replacementOwnerId, phase: 'spawn', reason: next.recovery.nextAction });
    }
  }

  const verified = new Set(next.verifiedMemberIds);
  next.waves = next.waves.map((wave) => {
    if (!wave.ownerIds.includes(replacementOwnerId)) return wave;
    let opened = [...(wave.openedOwnerIds ?? [])];
    let verifiedInWave = [...(wave.verifiedOwnerIds ?? [])];
    if (outcome === 'launch-failed') {
      opened = removeMemberId(opened, replacementOwnerId);
      verifiedInWave = removeMemberId(verifiedInWave, replacementOwnerId);
    } else {
      opened = addMemberId(opened, replacementOwnerId);
      verifiedInWave = outcome === 'verified'
        ? addMemberId(verifiedInWave, replacementOwnerId)
        : removeMemberId(verifiedInWave, replacementOwnerId);
    }
    return {
      ...wave,
      openedOwnerIds: opened,
      verifiedOwnerIds: verifiedInWave,
      state: outcome === 'verified' && wave.ownerIds.length > 0 && wave.ownerIds.every((ownerId) => verifiedInWave.includes(ownerId))
        ? 'verified'
        : 'partial',
    };
  });
  next.state = next.requestedMemberIds.length > 0 && next.requestedMemberIds.every((ownerId) => verified.has(ownerId))
    ? 'verified'
    : 'partial';
  return next;
}

export interface PersistRespawnLaunchTransactionOptions {
  workspaceId: string;
  fleetSlug: string;
  drainedOwnerId: string;
  replacementOwnerId: string;
  outcome: RespawnLaunchOutcome;
  /** The transaction id observed before draining. A different id is a newer launch and is preserved. */
  expectedTransactionId?: string | null;
  reason?: string;
  now?: () => number;
  getFleetFn?: typeof getFleet;
  setFleetLaunchTransactionFn?: typeof setFleetLaunchTransaction;
}

export type PersistRespawnLaunchTransactionResult =
  | { ok: true; attempts: number; transaction: FleetLaunchTransaction }
  | { ok: false; attempts: number; reason: 'no-transaction' | 'read-failed' | 'newer-transaction' | 'cas-exhausted'; error?: string; preservedTransactionId?: string };

/** Persist respawn reconciliation with a bounded CAS retry, never overwriting a newer launch. */
export async function persistRespawnLaunchTransaction(
  opts: PersistRespawnLaunchTransactionOptions,
): Promise<PersistRespawnLaunchTransactionResult> {
  const getFleetFn = opts.getFleetFn ?? getFleet;
  const setFleetLaunchTransactionFn = opts.setFleetLaunchTransactionFn ?? setFleetLaunchTransaction;
  const hasExpectedTransaction = opts.expectedTransactionId !== undefined;
  let lastError: string | undefined;
  let readFailures = 0;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let fleet: Awaited<ReturnType<typeof getFleet>>;
    try {
      fleet = await getFleetFn(opts.workspaceId, opts.fleetSlug);
    } catch (error) {
      readFailures += 1;
      lastError = error instanceof Error ? error.message : String(error);
      continue;
    }
    const current = fleet?.lastLaunchTransaction ?? null;
    if (!current) return { ok: false, attempts: attempt, reason: 'no-transaction' };
    if (hasExpectedTransaction && current.transactionId !== opts.expectedTransactionId) {
      return {
        ok: false,
        attempts: attempt,
        reason: 'newer-transaction',
        preservedTransactionId: current.transactionId,
      };
    }

    const now = opts.now?.() ?? Date.now();
    const reconciled = reconcileRespawnLaunchTransaction({
      transaction: current,
      drainedOwnerId: opts.drainedOwnerId,
      replacementOwnerId: opts.replacementOwnerId,
      now,
    });
    const next = settleRespawnLaunchTransaction(
      reconciled,
      opts.replacementOwnerId,
      opts.outcome,
      opts.reason,
    );
    try {
      const persisted = await setFleetLaunchTransactionFn({
        workspaceId: opts.workspaceId,
        fleetSlug: opts.fleetSlug,
        transaction: next,
        expectedRevision: {
          transactionId: current.transactionId,
          updatedAt: current.updatedAt,
        },
      });
      if (persisted) return { ok: true, attempts: attempt, transaction: next };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    ok: false,
    attempts: 3,
    reason: readFailures === 3 ? 'read-failed' : 'cas-exhausted',
    ...(lastError ? { error: lastError } : {}),
  };
}

function summarizeRespawnLaunchTransaction(result: PersistRespawnLaunchTransactionResult): Record<string, unknown> {
  if (result.ok) {
    return {
      status: 'persisted',
      attempts: result.attempts,
      transactionId: result.transaction.transactionId,
    };
  }
  return {
    status: result.reason,
    attempts: result.attempts,
    ...(result.error ? { error: result.error } : {}),
    ...(result.preservedTransactionId ? { preservedTransactionId: result.preservedTransactionId } : {}),
  };
}

export interface AwaitReplacementResult {
  verified: boolean;
  newMemberOwnerId: string | null;
  waitedMs: number;
  /** Owners seen in the fleet at the end of the wait — the evidence behind a `false`. */
  rosterOwnerIds: string[];
}

/**
 * Wait for a NEW live member to appear in the fleet's presence roster after a launch.
 *
 * Why this exists (EI: fleet:respawn-member false success): capability:launch-agent returns
 * as soon as it has spawned the member's TERMINAL, and the terminal's launch script ends in
 * `exec "$SHELL" -l` — so when the agent CLI dies before its first turn (an exhausted account
 * pool, a bad model spec, a missing credential) you are left with a live pid, a live terminal,
 * and NO agent, while the launcher reports success. An agent that actually booted writes a
 * coord_presence row; nothing else does. So the roster is the only sound oracle, and a respawn
 * that cannot observe one must report failure rather than inherit the launcher's optimism.
 *
 * All IO is injected so this unit-tests without PG or real time.
 */
export async function awaitReplacementMember(opts: {
  before: Set<string>;
  /** Exact owner pre-pinned for this launch; required to disambiguate concurrent respawns. */
  expectedOwnerId?: string;
  list: () => Promise<FleetPresenceRow[]>;
  timeoutMs: number;
  intervalMs?: number;
  freshMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Stop a speculative verifier when the nested launch fails before returning. */
  cancel?: Promise<void>;
  shouldStop?: () => boolean;
  /** Defer the first roster read one turn so an immediately failed launch can cancel cleanly. */
  deferFirstPoll?: boolean;
}): Promise<AwaitReplacementResult> {
  const {
    before,
    expectedOwnerId,
    list,
    timeoutMs,
    intervalMs = VERIFY_POLL_MS,
    freshMs = VERIFY_FRESH_MS,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    cancel,
    shouldStop,
    deferFirstPoll = false,
  } = opts;
  const startedAt = now();
  // Bound the loop by ITERATIONS as well as by the clock: the deadline test alone spins forever if
  // `now` ever fails to advance, and a tool call that never returns is a worse failure than a
  // slightly early give-up.
  const maxPolls = Math.ceil(timeoutMs / Math.max(1, intervalMs)) + 2;
  let rosterOwnerIds: string[] = [];
  if (deferFirstPoll) {
    const stopped = cancel
      ? await Promise.race([
          sleep(0).then(() => false),
          cancel.then(() => true),
        ])
      : (await sleep(0), false);
    if (stopped || shouldStop?.()) {
      return { verified: false, newMemberOwnerId: null, waitedMs: now() - startedAt, rosterOwnerIds };
    }
  }
  for (let poll = 0; ; poll += 1) {
    if (shouldStop?.()) {
      return { verified: false, newMemberOwnerId: null, waitedMs: now() - startedAt, rosterOwnerIds };
    }
    let rows: FleetPresenceRow[] = [];
    try {
      rows = await list();
    } catch {
      // A transient read failure is not evidence either way — keep polling until the deadline.
    }
    if (shouldStop?.()) {
      return { verified: false, newMemberOwnerId: null, waitedMs: now() - startedAt, rosterOwnerIds };
    }
    rosterOwnerIds = rows.map((r) => r.ownerId);
    const at = now();
    const fresh = rows.find((r) => {
      // A keyed retry may observe the already-present owner from its original launch, so the
      // exact pre-pin takes precedence over the before-roster heuristic. Without the pin, the
      // old heuristic remains available to callers/tests that only need generic new-row polling.
      const identityMatches = expectedOwnerId != null ? r.ownerId === expectedOwnerId : !before.has(r.ownerId);
      return identityMatches && at - new Date(r.heartbeatAt).getTime() <= freshMs;
    });
    if (fresh) {
      return { verified: true, newMemberOwnerId: fresh.ownerId, waitedMs: at - startedAt, rosterOwnerIds };
    }
    if (at - startedAt + intervalMs > timeoutMs || poll + 1 >= maxPolls) {
      return { verified: false, newMemberOwnerId: null, waitedMs: at - startedAt, rosterOwnerIds };
    }
    if (cancel) {
      const stopped = await Promise.race([
        sleep(intervalMs).then(() => false),
        cancel.then(() => true),
      ]);
      if (stopped || shouldStop?.()) {
        return { verified: false, newMemberOwnerId: null, waitedMs: now() - startedAt, rosterOwnerIds };
      }
    } else {
      await sleep(intervalMs);
    }
  }
}

export interface AwaitMemberDrainResult {
  verified: boolean;
  terminal: 'absent' | 'ended' | null;
  sessionState: string | null;
  waitedMs: number;
  /** Owners seen in the fleet at the end of the wait — the evidence behind a `false`. */
  rosterOwnerIds: string[];
}

/**
 * Wait until the old member is provably gone before replacing an unmanaged session.
 *
 * `fleet:kill` deliberately refuses to signal an omp-hook session with no managed psu-pty
 * host. A cooperative yield is therefore the only safe drain path: the member must observe
 * the durable request, release its claims/locks, and end. Presence disappearance is sufficient;
 * when the row is retained during cleanup, the shared liveness oracle's authoritative `ended`
 * verdict is the second accepted terminal signal. Unknown/read failures never count as drained.
 */
export async function awaitMemberDrain(opts: {
  memberOwnerId: string;
  list: () => Promise<FleetPresenceRow[]>;
  resolveState: () => Promise<string | null>;
  timeoutMs: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<AwaitMemberDrainResult> {
  const {
    memberOwnerId,
    list,
    resolveState,
    timeoutMs,
    intervalMs = DRAIN_POLL_MS,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  } = opts;
  const startedAt = now();
  const maxPolls = Math.ceil(timeoutMs / Math.max(1, intervalMs)) + 2;
  let rosterOwnerIds: string[] = [];
  let sessionState: string | null = null;
  for (let poll = 0; ; poll += 1) {
    try {
      const rows = await list();
      rosterOwnerIds = rows.map((r) => r.ownerId);
      if (!rosterOwnerIds.includes(memberOwnerId)) {
        const at = now();
        return { verified: true, terminal: 'absent', sessionState: null, waitedMs: at - startedAt, rosterOwnerIds };
      }
    } catch {
      // A failed roster read is not evidence of absence; continue to the liveness oracle.
    }

    try {
      sessionState = await resolveState();
    } catch {
      sessionState = null;
    }
    if (sessionState === 'ended') {
      const at = now();
      return { verified: true, terminal: 'ended', sessionState, waitedMs: at - startedAt, rosterOwnerIds };
    }

    const at = now();
    if (at - startedAt + intervalMs > timeoutMs || poll + 1 >= maxPolls) {
      return { verified: false, terminal: null, sessionState, waitedMs: at - startedAt, rosterOwnerIds };
    }
    await sleep(intervalMs);
  }
}

async function readMemberSessionState(ownerId: string): Promise<string | null> {
  const { resolveSessionStates } = await import('../coordination/liveness-oracle');
  const verdicts = await resolveSessionStates(
    [{ ownerId }],
    // This cohort is a named fleet member, not a nursery cup. A retained parked row with no
    // psu-pty host is therefore authoritative evidence that the unmanaged session ended.
    { hydratePerId: true, psuHostAuthority: true },
  );
  return verdicts.get(ownerId)?.sessionState ?? null;
}

/** fleet:kill returns the bulk envelope `{ data: { ok, results, counts } }` — success is
 * zero failed items, which the envelope's own derived `ok` now also reports. This reads
 * `counts.failed` directly because it must then distinguish WHICH failure it saw: a
 * structured not_found for the already-resolved fleet member is the idempotent already-dead
 * precondition, not a hard failure, and a boolean cannot carry that. */
function killOutcome(res: unknown): { ok: boolean; alreadyGone: boolean; unmanaged: boolean; data: Record<string, unknown> } {
  const data = ((res as { data?: unknown }).data ?? {}) as Record<string, unknown>;
  const counts = data.counts as { failed?: number } | undefined;
  const results = data.results as { ok?: boolean; code?: string; error?: string }[] | undefined;
  const failed = counts?.failed ?? results?.filter((r) => r.ok === false).length ?? 0;
  // `resolveFleetMemberTarget` already proved this owner belongs to the fleet. If fleet:kill
  // then reports its host as absent, the requested drain is already satisfied: there is no old
  // process left that could race the replacement. Treat only the structured not_found result as
  // this idempotent already-dead case; every other kill failure must still abort the relaunch.
  const alreadyGone = failed > 0 && Boolean(results?.length) && results!.every(
    (r) => r.ok === false && (r.code === 'not_found' || r.error === 'not_found'),
  );
  const unmanaged = failed > 0 && Boolean(results?.some((r) => r.ok === false && r.code === 'live_unmanaged'));
  return { ok: failed === 0, alreadyGone, unmanaged, data };
}

/**
 * P-009: turn a refusal into a CONTAINED, MARKED failure.
 *
 * Both refusal paths below (a kill that failed, and an unmanaged member that ignored its drain
 * request) used to end at `return json({ ok:false, ... })`. That answer is correct about the one
 * thing it says — do not launch a replacement — and silent about everything the leader actually
 * needs: the old member is still live, still holding its claims, and nothing anywhere records
 * that it is wedged. The leader's only evidence is a failed tool call, which nothing else reads.
 * That is the "indefinitely live wedge" P-009's acceptance forbids.
 *
 * So the refusal now also freezes the member's tasks, marks them `stranded` with the cause, and
 * emits the transition edge carrying that same cause. The decision itself is made by the pure
 * core so the six acceptance scenarios are unit tests, not fixtures.
 */
async function containWedgedMember(args: {
  workspaceId: string;
  fleetSlug: string;
  memberOwnerId: string;
  leaderOwnerId: string;
  attemptKey: string;
  kill: 'failed' | 'unmanaged';
  drain?: 'unverified';
}): Promise<{ decision: MemberRecoveryDecision; recovery: StrandMemberResult }> {
  const decision = decideMemberRecovery({
    fleetSlug: args.fleetSlug,
    memberOwnerId: args.memberOwnerId,
    leaderOwnerId: args.leaderOwnerId,
    attemptKey: args.attemptKey,
    kill: args.kill,
    drain: args.drain,
    now: Date.now(),
  });
  const recovery = await strandWedgedMember(
    {
      workspaceId: args.workspaceId,
      fleetSlug: args.fleetSlug,
      memberOwnerId: args.memberOwnerId,
      decision,
    },
    {
      listTasks: (filter) => listTasks({ workspaceId: filter.workspaceId, coordOwnerId: filter.coordOwnerId }),
      freezeTask: async (taskId) => {
        const outcome = await freezeTask(taskId);
        return { ok: outcome.ok, error: 'error' in outcome ? String(outcome.error) : undefined };
      },
      markStranded: (verdicts) => markStranded(verdicts),
      emitTransition: (edge) =>
        emitFleetTransitionEdge({
          kind: edge.kind as 'member-stalled',
          fleetSlug: edge.fleetSlug,
          agentId: edge.memberOwnerId,
          // The transition surface takes from/to strings for its summary line; the CAUSE rides in
          // `to` so a reader of the event gets it without a second lookup, which is exactly the
          // acceptance criterion ("transition events carry the reason").
          to: `stranded: ${edge.reason}`,
          from: 'live',
        }),
      // Fail-soft: this runs on a path where something has already gone wrong, so a second
      // failure must degrade the report rather than replace it with an exception.
      onError: () => {},
    },
  );
  return { decision, recovery };
}

/** capability:launch-agent returns human-readable TEXT + an `isError` flag (not JSON) —
 *  success is `!isError`. */
function launchOutcome(res: unknown): { ok: boolean; text: string } {
  const env = res as { isError?: boolean; content?: { text?: string }[] };
  return { ok: !env.isError, text: env.content?.[0]?.text ?? '' };
}

type RespawnFailureHeadcount = {
  target: number;
  current: number | null;
  shortfall: number | null;
  underStrength: boolean | null;
  verdict: 'at-target' | 'under-strength' | 'unknown';
  memberOwnerIds?: string[];
};

/**
 * Read the fleet's member-seat census after a replacement launch fails. A failed launch does not
 * itself prove that the fleet is down a member: another live member may already satisfy the
 * saved target (the common over-capacity/ghost-drain case). Keep a failed roster read UNKNOWN so
 * a transient diagnostic failure cannot be misreported as either a healthy or under-strength
 * fleet. The drained owner and durable fleet leader do not occupy member seats.
 */
async function readRespawnFailureHeadcount(opts: {
  target: number;
  drainedOwnerId: string;
  leaderOwnerId: string | null;
  list: () => Promise<FleetPresenceRow[]>;
}): Promise<RespawnFailureHeadcount> {
  try {
    const excluded = new Set([opts.drainedOwnerId, opts.leaderOwnerId].filter((id): id is string => Boolean(id)));
    const memberOwnerIds = [...new Set((await opts.list())
      .map((row) => row.ownerId)
      .filter((ownerId) => !excluded.has(ownerId)))];
    const current = memberOwnerIds.length;
    const shortfall = Math.max(0, opts.target - current);
    return {
      target: opts.target,
      current,
      shortfall,
      underStrength: shortfall > 0,
      verdict: shortfall > 0 ? 'under-strength' : 'at-target',
      memberOwnerIds,
    };
  } catch {
    return {
      target: opts.target,
      current: null,
      shortfall: null,
      underStrength: null,
      verdict: 'unknown',
    };
  }
}

function respawnFailureMessage(headcount: RespawnFailureHeadcount): string {
  if (headcount.verdict === 'at-target') {
    return (
      `old member drained but the replacement launch FAILED — the fleet remains at target ` +
      `(${headcount.current} LIVE member${headcount.current === 1 ? '' : 's'} of ${headcount.target}); ` +
      'do not relaunch a replacement.'
    );
  }
  if (headcount.verdict === 'under-strength') {
    return (
      `old member drained but the replacement launch FAILED — the fleet is under-strength ` +
      `(${headcount.current} LIVE member${headcount.current === 1 ? '' : 's'} of ${headcount.target}, ` +
      `SHORT BY ${headcount.shortfall}); retry the replacement launch (capability:launch-agent).`
    );
  }
  return (
    `old member drained but the replacement launch FAILED — the live fleet headcount could not ` +
    `be verified against target ${headcount.target}; do not assume the fleet is down one member. ` +
    'Re-read fleet:status before retrying.'
  );
}

/**
 * Validate the persisted persona before respawn-member performs its destructive drain.
 * capability:launch-agent runs the same prompt assembly check, but that check occurs only
 * after this orchestration has already killed the old member. Recovery must fail closed before
 * that side effect when a saved role has gone stale or was never registered for the harness.
 */
async function preflightSavedPersonaRole(opts: {
  role?: string;
  harness: string;
  workspaceId: string;
}): Promise<
  | { ok: true }
  | { ok: false; error: 'saved_role_invalid' | 'saved_role_preflight_failed'; role: string; message: string }
> {
  const role = opts.role?.trim();
  if (!role || role === 'su' || isSuTierRole(role)) return { ok: true };

  let projectDir: string | null;
  try {
    projectDir = await resolveProjectDir(opts.harness, opts.workspaceId);
  } catch (error) {
    return {
      ok: false,
      error: 'saved_role_preflight_failed',
      role,
      message:
        `Could not validate persisted persona role \`${role}\` for harness \`${opts.harness}\`: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'The old member was NOT killed and no replacement was launched.',
    };
  }
  if (!projectDir) {
    return {
      ok: false,
      error: 'saved_role_preflight_failed',
      role,
      message:
        `Could not validate persisted persona role \`${role}\`: harness \`${opts.harness}\` ` +
        `is not registered in workspace \`${opts.workspaceId}\`. ` +
        'The old member was NOT killed and no replacement was launched.',
    };
  }

  try {
    assembleRolePrompt({
      slug: opts.harness,
      projectDir,
      role,
      mode: 'chat',
    });
  } catch (error) {
    return {
      ok: false,
      error: 'saved_role_invalid',
      role,
      message:
        `Invalid persona role \`${role}\` for the persisted respawn member: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'Omit the stale role, set `role:"su"`, or choose a registered persona. ' +
        'Put lane/job names in `brief` or `label`. NO agents were spawned and NO terminals were opened. ' +
        'The old member was NOT killed and no replacement was launched.',
    };
  }
  return { ok: true };
}

type SavedModelPreflightResult =
  | { ok: true; model?: string; backend: LaunchAgentBackend | null }
  | {
      ok: false;
      error: 'saved_model_invalid' | 'saved_model_preflight_failed' | 'saved_model_backend_mismatch';
      model?: string;
      agent?: string;
      backend?: LaunchAgentBackend;
      message: string;
    };

/**
 * Validate the saved model/effort/backend tuple before respawn-member drains the old process.
 * The launcher accepts a broad model string at its boundary, but a recovery path must not kill a
 * healthy member and then discover that the replacement's first gateway request will 404. The
 * effective tier menu is the owner-configured catalog (falling back to the committed menu), while
 * CLOUD_MODEL_MENU covers the native aliases that are valid even when a custom tier menu omits
 * them. `backendForModelSpec` is the shared classifier: it recognizes both catalogued aliases and
 * unambiguous open-set Codex/Claude ids (including `gpt-5.5`), while still returning null for an
 * unrecognized model instead of guessing a backend.
 */
async function preflightSavedModel(opts: {
  model?: string;
  effort?: string;
  agent?: string;
  workspaceId: string;
}): Promise<SavedModelPreflightResult> {
  let config: Awaited<ReturnType<typeof readAgentConfig>>;
  try {
    config = await readAgentConfig();
  } catch (error) {
    return {
      ok: false,
      error: 'saved_model_preflight_failed',
      model: opts.model,
      agent: opts.agent,
      message:
        `Could not read the registered model catalog for workspace \`${opts.workspaceId}\`: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'The old member was NOT killed and no replacement was launched.',
    };
  }

  const tiers: readonly ModelTier[] = config.tiers && config.tiers.length > 0 ? config.tiers : DEFAULT_MODEL_TIERS;
  let composedModel: string | undefined;
  try {
    composedModel = composeLaunchModelSpec(opts.model, opts.effort);
  } catch (error) {
    return {
      ok: false,
      error: 'saved_model_invalid',
      model: opts.model,
      agent: opts.agent,
      message:
        `The saved model/effort combination is invalid: ${error instanceof Error ? error.message : String(error)}. ` +
        'The old member was NOT killed and no replacement was launched.',
    };
  }

  const requestedAgent = opts.agent?.trim().toLowerCase();
  const explicitAgent: LaunchAgentBackend | null =
    requestedAgent === 'claude' || requestedAgent === 'claude-code'
      ? 'claude'
      : requestedAgent === 'codex'
        ? 'codex'
        : requestedAgent === 'omp'
          ? 'omp'
          : null;
  if (requestedAgent && !explicitAgent) {
    return {
      ok: false,
      error: 'saved_model_invalid',
      model: composedModel ?? opts.model,
      agent: opts.agent,
      message:
        `The saved launch agent \`${opts.agent}\` is not one of claude, codex, or omp. ` +
        'The old member was NOT killed and no replacement was launched.',
    };
  }

  // An omitted model means "use the backend default". It is still safe to preserve for legacy
  // launch rows, provided any explicitly persisted agent is itself a recognized backend.
  if (!composedModel) return { ok: true, model: composedModel, backend: explicitAgent };

  const modelBackend = backendForModelSpec(composedModel);
  // `backendForModelSpec` uses the spawn vocabulary (`claude-code`), while this
  // recovery tool's persisted launch records use the legacy `claude` spelling.
  const backend: LaunchAgentBackend | null =
    modelBackend?.backend === 'claude-code' ? 'claude' : modelBackend?.backend ?? null;
  const catalogModel = splitModelSpec(composedModel).model?.replace(/\[[^\]]+\]$/, '').toLowerCase() ?? null;
  const inEffectiveTiers = tiers.some(
    (tier) => splitModelSpec(tier.spec).model?.replace(/\[[^\]]+\]$/, '').toLowerCase() === catalogModel,
  );
  const inCloudMenu = CLOUD_MODEL_MENU.some(
    (choice) => splitModelSpec(choice.value).model?.replace(/\[[^\]]+\]$/, '').toLowerCase() === catalogModel,
  );

  if (!backend) {
    return {
      ok: false,
      error: 'saved_model_invalid',
      model: composedModel,
      agent: opts.agent,
      message:
        `The saved model \`${composedModel}\` is not registered in the effective model tiers or ` +
        `CLOUD_MODEL_MENU, so its launch backend cannot be determined. ` +
        'Choose a registered model before retrying. The old member was NOT killed and no replacement was launched.',
    };
  }

  // Native Claude aliases are only safe when the current catalog still exposes them. OMP is a
  // multi-provider backend, so it may run a registered native cloud model explicitly; provider/id
  // models are likewise classified as OMP by launchAgentBackendForModel and need no native menu row.
  // A CONCRETE versioned id of a menu family (`claude-sonnet-5-5`, the spelling a goal's own
  // launchSettings use and capability:launch-agent accepts) is not a typo of the alias the menu
  // carries (`sonnet`). Requiring the exact alias refused the goal's own configured model and,
  // via the `[1m]`-stripped comparison above, every versioned id (EI-24909345582884838). The
  // family prefix must still be a menu family: `claude-sonet-5` stays refused.
  const inClaudeMenuFamily =
    catalogModel !== null &&
    CLOUD_MODEL_MENU.some(
      (choice) =>
        choice.backend === 'claude' &&
        new RegExp(`^claude-${choice.value.toLowerCase().replace(/[^a-z0-9]/g, '')}(-|$)`).test(catalogModel),
    );
  if (backend === 'claude' && !inEffectiveTiers && !inCloudMenu && !inClaudeMenuFamily) {
    return {
      ok: false,
      error: 'saved_model_invalid',
      model: composedModel,
      agent: opts.agent,
      backend,
      message:
        `The saved Claude model \`${composedModel}\` is not present in the effective model tiers or ` +
        `CLOUD_MODEL_MENU. The old member was NOT killed and no replacement was launched.`,
    };
  }

  // Keep OMP's documented multi-provider behavior: it can run either native cloud family. Native
  // Claude/Codex CLIs, however, must agree with the model classifier or the replacement will boot
  // with an unrunnable model and only surface the failure on its first gateway request.
  if (explicitAgent && explicitAgent !== 'omp' && explicitAgent !== backend) {
    return {
      ok: false,
      error: 'saved_model_backend_mismatch',
      model: composedModel,
      agent: opts.agent,
      backend,
      message:
        `The saved model \`${composedModel}\` belongs to the \`${backend}\` backend, but the saved ` +
        `launch requested agent \`${opts.agent}\`. The old member was NOT killed and no replacement was launched.`,
    };
  }

  return { ok: true, model: composedModel, backend };
}

export default defineTool({
  name: 'fleet:respawn-member',
  description:
    "Change ONE fleet member's BOOT-BAKED settings (model / effort / account / carry / contextSize / agent / compactionLimit) by draining + relaunching it (as its leader, an Overwatch pane, or the owner): the old session is killed (releasing its claims) and a fresh one is launched into the SAME fleet with the new spec (a new identity, the fleet's claim lane inherited). When no boot-baked override is supplied, it respawns the member with the canonical saved launch profile unchanged. `fleet` defaults to the one you lead. For RUNTIME settings that need no respawn (compaction limit alone, claim spec, a brief) use fleet:reconfigure-member. `claimKinds` is not settable here.",
  guidance: {
    when: 'Move a member to a different model/effort/account/carry/context-size/agent/role — anything fixed at launch — or recover it with the same saved profile.',
    notWhen:
      'For a RUNTIME tweak with no respawn (compaction limit, claim lane, a next-wake brief) — fleet:reconfigure-member. To seed claimKinds — fleet:launch-on-plan. To stand the whole fleet down — fleet:wind-down. To just kill (no replacement) — fleet:kill.',
    chaining: ROUTING_LADDER,
    seeAlso: [
      'fleet:reconfigure-member (runtime settings, no respawn)',
      'capability:launch-agent (the underlying fresh launch)',
      'fleet:kill (kill without replacement)',
      'fleet:status (who the members are)',
    ],
  },
  capability: 'fleet:respawn-member',
  requirePrincipal: false,
  // EI-20215222062407258: this orchestration awaits the drain, launch, and (by default)
  // up-to-90-second replacement-heartbeat verification without reading ctx.tx. Holding the
  // dispatcher's ambient workspace transaction across that wait lets Postgres terminate its
  // idle backend during a concurrent respawn wave, surfacing as a bare
  // `write CONNECTION_CLOSED 127.0.0.1:6432`. See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  // Keep the dispatcher and MCP transport deadline aligned with the bounded waits above. The
  // tools:invoke wrapper already uses the same 660s outer budget, so direct and nested calls both
  // remain alive until this finite orchestration has returned.
  timeoutSec: RESPAWN_TIMEOUT_SEC,
  agentRoles: [...SU_ROLES],
  args: z
    .object({
      member: z
        .string()
        .min(1)
        .describe('The member to respawn — its coord ownerId (or a unique prefix/substring). Must be a member of the fleet.'),
      fleet: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe('Fleet slug (or name — slugified). Defaults to the single fleet you lead.'),
      harness: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe("Harness slug for legacy launch-spec recovery. Defaults to the member's saved context or the session harness."),
      model: z.string().max(80).optional().describe('New model spec (e.g. "opus[1m]", "sonnet:high").'),
      effort: z.string().max(40).optional().describe('New reasoning effort (low|medium|high|xhigh|max) — composed onto the model spec.'),
      account: z.string().max(120).optional().describe('New account routing (default | auto | a pool account id).'),
      carry: z.enum(['warm', 'cold']).optional().describe('New warm/cold auto-mode carry for the relaunched member.'),
      contextSize: z.literal('trimmed').optional().describe('New psu --context-size for the relaunched member.'),
      agent: z.string().max(40).optional().describe('New agent CLI backing the member (e.g. claude | codex).'),
      compactionLimit: z.number().int().min(20_000).max(900_000).optional().describe('New soft compaction limit (tokens) baked at launch.'),
      role: z.string().min(1).max(120).optional().describe('New launch persona role (for example `su` or a registered harness persona).'),
      headless: z.boolean().optional().describe('Whether the replacement runs headless (default: preserve the fleet norm — headless for a background drain fleet).'),
      brief: z
        .string()
        .min(1)
        .max(4000)
        .optional()
        .describe("The replacement's FIRST TURN. Omit to use a generic 'you were respawned, resume your role (self-pull via scheduler:get_next)' brief."),
      reason: z.string().max(500).optional().describe('Why — recorded on the kill audit row.'),
      idempotencyKey: z
        .string()
        .max(200)
        .optional()
        .describe('Dedupe key for the relaunch: re-firing with the same key reports deduped instead of launching a second replacement.'),
      verifySec: z
        .number()
        .int()
        .min(0)
        .max(300)
        .optional()
        .describe(`Seconds to wait for the replacement's first heartbeat before reporting the respawn failed (default ${DEFAULT_VERIFY_SEC}). 0 skips verification and returns as soon as the launcher does — the launcher only knows it spawned a terminal, so ok:true then means "launch requested", not "agent exists".`),
      drainVerifySec: z
        .number()
        .int()
        .min(1)
        .max(300)
        .optional()
        .describe(`Seconds to wait for a cooperative unmanaged-session drain before refusing the replacement launch (default ${DEFAULT_DRAIN_VERIFY_SEC}); unlike verifySec, this safety check cannot be skipped.`),
    }),
  async handler(args, ctx) {
    // An empty delta is an intentional recovery operation: resolveSavedFleetLaunchSpec below
    // preserves the canonical profile and relaunches an identical replacement. Non-empty deltas
    // remain fail-closed against that profile and are audited by the resolver.
    // An empty delta is an intentional recovery operation: resolveSavedFleetLaunchSpec below
    // preserves the canonical profile and relaunches an identical replacement. Non-empty deltas
    // remain fail-closed against that profile and are audited by the resolver.
    const changed = { model: args.model, effort: args.effort, account: args.account, carry: args.carry, contextSize: args.contextSize, agent: args.agent, compactionLimit: args.compactionLimit, role: args.role, headless: args.headless };
    const changedFields = Object.entries(changed).filter(([, v]) => v != null).map(([k]) => k);

    const target = await resolveFleetMemberTarget(ctx, args.member, args.fleet);
    if (!target.ok) {
      return json(target as unknown as Record<string, unknown>, true);
    }
    const { slug, memberOwnerId, invokedAs, workspaceId, identity } = target;

    // Legacy launch rows predate the canonical fleet target and may omit the
    // harness/agent fields. Only use trusted recovery context to fill those
    // gaps: the target member's own pot context, the concrete caller harness,
    // and an explicit respawn agent override. Never default either field.
    const memberPresence = await getPresence(memberOwnerId).catch(() => null);
    const memberBrief = await getSessionBrief({ ownerId: memberOwnerId }).catch(() => null);
    const callerHarness = resolveConcreteHarnessSlug(args.harness, ctx) ?? '';
    const legacyHarness = memberBrief?.harnessSlug?.trim() || memberPresence?.potSlug?.trim() ||
      (callerHarness && callerHarness !== '*' && callerHarness !== 'all' ? callerHarness : undefined);

    // D-004/P-044: a respawn is a recovery, never a fresh reconstruction. Read
    // the canonical saved fleet profile BEFORE killing the old member, merge
    // only the explicit audited boot-setting delta, and preserve every omitted
    // field (plan/harness/account/carry/role/context/launch context included).
    const savedLaunchSpec = await resolveSavedFleetLaunchSpec({
      workspaceId,
      fleetSlug: slug,
      requested: {
        model: args.model,
        effort: args.effort,
        account: args.account,
        carry: args.carry,
        contextSize: args.contextSize,
        agent: args.agent,
        compactionLimit: args.compactionLimit,
        role: args.role,
        headless: args.headless,
        brief: args.brief,
      },
      allowDeltas: ['model', 'account', 'carry', 'contextSize', 'agent', 'compactionLimit', 'role', 'headless', 'brief'],
      reusePath: 'fleet:respawn-member -> capability:launch-agent',
      requireSaved: true,
      memberOwnerId,
      legacyFallbacks: {
        agent: args.agent,
        harness: legacyHarness,
      },
    });
    if (!savedLaunchSpec.ok) {
      return json(
        {
          ok: false,
          error: savedLaunchSpec.error,
          fleet: slug,
          member: memberOwnerId,
          message: savedLaunchSpec.message,
          conflicts: savedLaunchSpec.conflicts,
          provenance: savedLaunchSpec.provenance,
          reusePath: savedLaunchSpec.reusePath,
          killed: false,
        },
        true,
      );
    }
    if (!savedLaunchSpec.found) {
      // `requireSaved:true` makes this unreachable at runtime; retain an
      // explicit defense so a future resolver contract change cannot kill first.
      return json(
        {
          ok: false,
          error: 'saved_launch_spec_missing',
          fleet: slug,
          member: memberOwnerId,
          message: `No canonical saved launch spec exists for fleet '${slug}'; old member was NOT killed.`,
          killed: false,
        },
        true,
      );
    }

    const respawnRole = normalizeRespawnRole(savedLaunchSpec.effective.member.role);
    const rolePreflight = await preflightSavedPersonaRole({
      role: respawnRole,
      harness: savedLaunchSpec.effective.harness,
      workspaceId,
    });
    if (!rolePreflight.ok) {
      return json(
        {
          ok: false,
          error: rolePreflight.error,
          fleet: slug,
          member: memberOwnerId,
          role: rolePreflight.role,
          message: rolePreflight.message,
          killed: false,
          launched: false,
          launchSpec: {
            provenance: savedLaunchSpec.provenance,
            reusePath: savedLaunchSpec.reusePath,
            overrides: savedLaunchSpec.overrides,
            preservedFields: savedLaunchSpec.preservedFields,
          },
        },
        true,
      );
    }

    // Validate the composed saved model/backend against the current catalog before taking the
    // destructive snapshot/kill path. capability:launch-agent performs its own model handling,
    // but only after it has opened the replacement terminal — too late for recovery safety.
    const modelPreflight = await preflightSavedModel({
      model: savedLaunchSpec.effective.member.model,
      effort: savedLaunchSpec.effective.member.effort,
      agent: savedLaunchSpec.effective.member.agent,
      workspaceId,
    });
    if (!modelPreflight.ok) {
      return json(
        {
          ok: false,
          error: modelPreflight.error,
          fleet: slug,
          member: memberOwnerId,
          ...(modelPreflight.model ? { model: modelPreflight.model } : {}),
          ...(modelPreflight.agent ? { agent: modelPreflight.agent } : {}),
          ...(modelPreflight.backend ? { backend: modelPreflight.backend } : {}),
          message: modelPreflight.message,
          killed: false,
          launched: false,
          launchSpec: {
            provenance: savedLaunchSpec.provenance,
            reusePath: savedLaunchSpec.reusePath,
            overrides: savedLaunchSpec.overrides,
            preservedFields: savedLaunchSpec.preservedFields,
          },
        },
        true,
      );
    }

    // Validate the goal ceilings (maxAgents / maxPerFleet) BEFORE the destructive drain, the same
    // way the model/persona preflights above do (EI-24909345582884838). capability:launch-agent
    // runs this same check, but only AFTER the old member has been SIGTERMed — so a fleet already
    // AT maxPerFleet killed its member and then refused the replacement, leaving it a seat short.
    // A respawn is net-zero on headcount, so the member being replaced is excluded from the count
    // (it is still `live` while draining). The launcher repeats the check with the same exclusion
    // (`__respawnReplacesOwnerId`), so the two cannot disagree. An unresolved goal context or an
    // unreadable count fails OPEN here exactly as it does in the launcher; only a REAL refusal (or
    // a fatal goal-holder verdict the launcher would also throw on) stops the drain.
    // The caller is the one resolveFleetMemberTarget already authenticated (it is what the launcher
    // resolves from the same ctx), so reuse it rather than re-deriving identity here.
    const respawnCallerOwnerId = target.callerId;
    if (respawnCallerOwnerId) {
      let ceilingPreflight: Awaited<ReturnType<typeof resolveGoalLaunch>> | null = null;
      let ceilingPreflightError: string | null = null;
      try {
        ceilingPreflight = await resolveGoalLaunch({
          workspaceId,
          launcherOwnerId: respawnCallerOwnerId,
          goalRole: null,
          fleetSlug: slug,
          count: 1,
          excludeOwnerIds: [memberOwnerId],
        });
      } catch (error) {
        ceilingPreflightError = error instanceof Error ? error.message : String(error);
      }
      if (ceilingPreflightError !== null || ceilingPreflight?.refusal) {
        return json(
          {
            ok: false,
            error: ceilingPreflightError !== null ? 'goal_ceiling_preflight_failed' : 'goal_ceiling_refused',
            fleet: slug,
            member: memberOwnerId,
            ...(ceilingPreflight?.refusal ? { refusal: ceilingPreflight.refusal } : {}),
            message:
              (ceilingPreflight?.refusal?.message ??
                `Could not validate the goal launch ceilings before draining: ${ceilingPreflightError}.`) +
              ' The old member was NOT killed and no replacement was launched.',
            killed: false,
            launched: false,
            launchSpec: {
              provenance: savedLaunchSpec.provenance,
              reusePath: savedLaunchSpec.reusePath,
              overrides: savedLaunchSpec.overrides,
              preservedFields: savedLaunchSpec.preservedFields,
            },
          },
          true,
        );
      }
    }

    // Snapshot the transaction revision before the destructive drain. A respawn is allowed to
    // reconcile only the launch lineage it observed; if another launch starts while this one is
    // draining, persistRespawnLaunchTransaction reports and preserves that newer transaction.
    let expectedLaunchTransactionId: string | null | undefined;
    let launchTransactionReadError: string | undefined;
    try {
      const fleet = await getFleet(workspaceId, slug);
      expectedLaunchTransactionId = fleet?.lastLaunchTransaction?.transactionId ?? null;
    } catch (error) {
      launchTransactionReadError = error instanceof Error ? error.message : String(error);
    }
    const persistRespawnTransaction = (
      outcome: RespawnLaunchOutcome,
      reason?: string,
    ): Promise<PersistRespawnLaunchTransactionResult> => {
      if (launchTransactionReadError) {
        return Promise.resolve({
          ok: false,
          attempts: 0,
          reason: 'read-failed',
          error: launchTransactionReadError,
        });
      }
      return persistRespawnLaunchTransaction({
        workspaceId,
        fleetSlug: slug,
        drainedOwnerId: memberOwnerId,
        replacementOwnerId: replacementOwner,
        outcome,
        expectedTransactionId: expectedLaunchTransactionId,
        reason,
      });
    };

    // 0. Snapshot the fleet's roster BEFORE the kill, so the replacement is identified by being
    //    an owner-id that was not there before — a respawn mints a NEW identity, so "some member
    //    is present" is not evidence; "a member nobody had seen is present" is.
    let rosterBefore = new Set<string>();
    let rosterReadable = true;
    try {
      rosterBefore = new Set((await listFleetPresence(workspaceId, slug)).map((r) => r.ownerId));
    } catch {
      rosterReadable = false;
    }

    // 1. Drain the old session (graceful SIGTERM + close its terminal; releases its claims). If the
    //    kill fails we do NOT launch a replacement — otherwise two members race the same lane.
    const kill = killOutcome(
      await killTool.handler(
        { owner: memberOwnerId, reason: args.reason ?? `fleet:respawn-member (${changedFields.join(',') || 'saved profile'})`, close_terminal: true } as never,
        ctx,
      ),
    );
    let cooperativeDrain: AwaitMemberDrainResult | undefined;
    let cooperativeRequest: { msgId: string | null; wake: unknown } | undefined;
    if (!kill.ok && kill.unmanaged) {
      const summary = `cooperative replacement drain requested for ${memberOwnerId}`;
      const body =
        `The fleet leader is preparing a safe replacement for this unmanaged session. Do not start new work. ` +
        `Checkpoint your active work-item, release any claims and file locks you hold, write a one-line successor note, ` +
        `then end this unmanaged session/turn. The replacement will not launch until your presence disappears or the ` +
        `shared liveness oracle reports sessionState='ended'.`;
      let request: { msg_id?: string };
      try {
        request = await sendMessage(identity, { to: [memberOwnerId], summary, body, kind: 'yield' });
      } catch (error) {
        return json(
          {
            ok: false,
            error: 'cooperative_drain_failed',
            fleet: slug,
            member: memberOwnerId,
            killed: kill.data,
            message: `Could not persist the cooperative drain request (${error instanceof Error ? error.message : String(error)}) — NOT launching a replacement (would double-run the lane).`,
          },
          true,
        );
      }
      let wake: unknown;
      try {
        wake = await wakeRecipients([memberOwnerId], { summary, source: 'fleet:respawn-member', workspaceId });
      } catch (error) {
        return json(
          {
            ok: false,
            error: 'cooperative_drain_failed',
            fleet: slug,
            member: memberOwnerId,
            killed: kill.data,
            requestId: request.msg_id ?? null,
            message: `The cooperative drain request was persisted but its wake failed (${error instanceof Error ? error.message : String(error)}) — NOT launching a replacement (would double-run the lane).`,
          },
          true,
        );
      }
      cooperativeRequest = { msgId: request.msg_id ?? null, wake };
      cooperativeDrain = await awaitMemberDrain({
        memberOwnerId,
        list: () => listFleetPresence(workspaceId, slug),
        resolveState: () => readMemberSessionState(memberOwnerId),
        timeoutMs: (args.drainVerifySec ?? DEFAULT_DRAIN_VERIFY_SEC) * 1000,
      });
      if (!cooperativeDrain.verified) {
        // P-009 (the ignored-wake acceptance case): refusing to launch is necessary but not
        // sufficient. Contain and mark the member, so the leader inherits an actionable failure
        // instead of a live wedge whose only trace is this failed call.
        const contained = await containWedgedMember({
          workspaceId,
          fleetSlug: slug,
          memberOwnerId,
          leaderOwnerId: target.callerId,
          attemptKey: args.idempotencyKey ?? `drain-unverified:${request.msg_id ?? Date.now()}`,
          kill: 'unmanaged',
          drain: 'unverified',
        });
        return json(
          {
            ok: false,
            error: 'cooperative_drain_unverified',
            fleet: slug,
            member: memberOwnerId,
            killed: kill.data,
            requestId: request.msg_id ?? null,
            wake,
            verification: cooperativeDrain,
            recovery: contained.recovery,
            disposition: contained.decision.disposition,
            claims: contained.decision.claims,
            recoveryToken: contained.decision.token,
            message:
              `The unmanaged member did not reach a verified terminal state within ${args.drainVerifySec ?? DEFAULT_DRAIN_VERIFY_SEC}s — ` +
              'NOT launching a replacement (would double-run the lane). ' +
              `${contained.decision.reason}. ` +
              (contained.recovery.contained
                ? `Its ${contained.recovery.tasks.length} task(s) are FROZEN and marked stranded; its claims are preserved. Thaw with processes:freeze { resume:true } once you have decided, or force-release its claims and retry with a fresh idempotencyKey.`
                : contained.recovery.noTasksFound
                  ? 'No enrolled task rows were found for this member (an unmanaged session has none), so it could NOT be frozen — it may still be running. Resolve it by hand before retrying.'
                  : `Containment was INCOMPLETE (${contained.recovery.tasks.filter((t) => !t.frozen).length} of ${contained.recovery.tasks.length} task(s) could not be frozen) — the member may still be running.`),
          },
          true,
        );
      }
    }
    if (!kill.ok && !kill.alreadyGone && !kill.unmanaged) {
      // P-009 (the injected-kill-failure acceptance case). A failed kill is the one reading that
      // most needs containment: the process we asked to end did not end, so it is still holding
      // its lane and still capable of writing. Freeze first, then mark — marking a row stranded
      // while its process runs records a stop that did not happen.
      const contained = await containWedgedMember({
        workspaceId,
        fleetSlug: slug,
        memberOwnerId,
        leaderOwnerId: target.callerId,
        attemptKey: args.idempotencyKey ?? `kill-failed:${Date.now()}`,
        kill: 'failed',
      });
      return json(
        {
          ok: false,
          error: 'kill_failed',
          fleet: slug,
          member: memberOwnerId,
          killed: kill.data,
          recovery: contained.recovery,
          disposition: contained.decision.disposition,
          claims: contained.decision.claims,
          recoveryToken: contained.decision.token,
          message:
            'could not drain the old member — NOT launching a replacement (would double-run the lane). ' +
            `${contained.decision.reason}. ` +
            (contained.recovery.contained
              ? `Its ${contained.recovery.tasks.length} task(s) are FROZEN and marked stranded; its claims are preserved (NOT released — a frozen process still owns its lane). Diagnose, then either thaw (processes:freeze { resume:true }) or processes:kill { taskId } the subtree and retry with a fresh idempotencyKey.`
              : contained.recovery.noTasksFound
                ? 'No enrolled task rows were found for this member, so it could NOT be frozen — it may still be running. Resolve it by hand before retrying.'
                : `Containment was INCOMPLETE (${contained.recovery.tasks.filter((t) => !t.frozen).length} of ${contained.recovery.tasks.length} task(s) could not be frozen) — the member may still be running.`),
        },
        true,
      );
    }
    const drainOutcome = kill.unmanaged
      ? 'cooperatively-drained'
      : kill.alreadyGone
        ? 'already-dead'
        : 'killed';

    // Pre-pin the fresh process identity before dispatching capability:launch-agent. Presence
    // roster ordering is not a correlation key: overlapping respawns can both see the same two
    // new rows and return the first one. A stable pin also makes an idempotent launch replay
    // verifiable after capability:launch-agent reports deduped.
    const replacementOwner = replacementOwnerId(slug, memberOwnerId, args.idempotencyKey);

    // WI-2141730: claimAgentLaunch's idempotency claim row (Postgres INSERT...ON CONFLICT) safely
    // dedupes a TRUE-CONCURRENT double-fire of the SAME (fleetSlug, memberOwnerId, idempotencyKey)
    // triple, but that claim row carries a TTL. If a caller reuses the identical triple for a
    // genuinely SEPARATE respawn after the TTL has expired, while the FIRST replacement is still
    // alive, replacementOwnerId() mints the IDENTICAL su-respawn-<sha256> ownerId again — a second
    // live process would then share the first one's psu-pty meta file AND socket path (both are
    // named purely from sanitizeKey(ownerId)). findLiveHost's EI-151 cross-owner guard cannot catch
    // this: both hosts truthfully record the SAME ownerId, so it is not a sanitizeKey collision
    // between distinct owners — it is a genuine duplicate identity. Refuse loudly instead of
    // silently spawning a second process under an identity that already has a live host.
    const collidingLiveHost = findLiveHost(replacementOwner);
    if (collidingLiveHost) {
      return json(
        {
          ok: false,
          error: 'replacement_identity_already_live',
          fleet: slug,
          oldMember: memberOwnerId,
          replacementOwner,
          collidingPid: collidingLiveHost.pid,
          killed: kill.data,
          launched: false,
          message: `The freshly-minted replacement identity ${replacementOwner} already has a live psu-pty host (pid ${collidingLiveHost.pid}) — NOT launching a second process under the same ownerId (would double-run the lane and corrupt the shared meta/socket files). This means the same (fleetSlug, memberOwnerId, idempotencyKey) triple was reused after its launch claim TTL expired while the earlier replacement is still alive. Retry with a fresh idempotencyKey, or wait for the existing replacement to end first.`,
        },
        true,
      );
    }

    // 2. Fresh-launch the replacement into the SAME fleet from the RESOLVED
    //    canonical spec. The caller's explicit delta is already audited above;
    //    nothing omitted can now fall through to a system default.
    const brief =
      savedLaunchSpec.effective.member.brief ??
      `You were respawned into fleet '${slug}' ${changedFields.length > 0 ? `with new settings (${changedFields.join(', ')})` : 'with the canonical saved launch profile'}. Resume your role: if you are a self-pulling fleet member, pull work via scheduler:get_next, then verify + complete with evidence.`;
    const spec: MemberSpec = {
      ...savedLaunchSpec.effective.member,
      ...(respawnRole !== undefined ? { role: respawnRole } : {}),
      brief,
    };
    // Start the roster verifier immediately after invoking the nested launcher. The launcher
    // may spend up to 30s waiting for its native kickoff-proof receipt; starting verification
    // only after that await creates an unverified interval in which a healthy replacement can
    // already be live while the outer respawn still reports no evidence (EI-23092914186078936).
    // Invoke first, then start the verifier, so the first roster read can observe the exact
    // pre-pinned owner even in the direct-handler test seam; in production both proceed
    // concurrently while capability:launch-agent performs its preflight/spawn work.
    const launchRequest = launchTool.handler(
      {
        fleet: slug,
        count: 1,
        harness: savedLaunchSpec.effective.harness,
        ...(savedLaunchSpec.effective.plan ? { plan: savedLaunchSpec.effective.plan } : {}),
        members: [spec],
        __savedLaunchCarry: savedLaunchSpec.effective.member.carry,
        __respawnOwnerId: replacementOwner,
        // Net-zero headcount: the launcher's goal-ceiling check must not charge the seat of the
        // member this launch replaces (it may still read as `live` while its SIGTERM lands).
        __respawnReplacesOwnerId: memberOwnerId,
        ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
      } as never,
      ctx,
    );
    const verifySec = args.verifySec ?? DEFAULT_VERIFY_SEC;
    let cancelReplacementVerification: (() => void) | undefined;
    let replacementVerification: Promise<AwaitReplacementResult> | null = null;
    if (verifySec > 0 && rosterReadable) {
      let cancelled = false;
      let resolveCancellation!: () => void;
      const cancellation = new Promise<void>((resolve) => { resolveCancellation = resolve; });
      cancelReplacementVerification = () => {
        cancelled = true;
        resolveCancellation();
      };
      replacementVerification = awaitReplacementMember({
        before: rosterBefore,
        expectedOwnerId: replacementOwner,
        list: () => listFleetPresence(workspaceId, slug),
        timeoutMs: verifySec * 1000,
        cancel: cancellation,
        shouldStop: () => cancelled,
        deferFirstPoll: true,
      });
    }
    const launch = launchOutcome(await launchRequest);

    if (!launch.ok) {
      cancelReplacementVerification?.();
      if (replacementVerification) await replacementVerification;
      const headcount = await readRespawnFailureHeadcount({
        target: savedLaunchSpec.target,
        drainedOwnerId: memberOwnerId,
        leaderOwnerId: target.fleet.leaderOwnerId,
        list: () => listFleetPresence(workspaceId, slug),
      });
      const launchTransactionPersistence = await persistRespawnTransaction('launch-failed', launch.text || undefined);
      return json(
        {
          ok: false,
          fleet: slug,
          oldMember: memberOwnerId,
          replacementOwner,
          invokedAs,
          changed: changedFields,
          drainOutcome,
          killed: kill.data,
          launched: launch.text,
          ...(cooperativeRequest ? { cooperativeRequest, cooperativeDrain } : {}),
          launchSpec: {
            provenance: savedLaunchSpec.provenance,
            reusePath: savedLaunchSpec.reusePath,
            overrides: savedLaunchSpec.overrides,
            preservedFields: savedLaunchSpec.preservedFields,
          },
          verified: false,
          launchTransactionPersistence: summarizeRespawnLaunchTransaction(launchTransactionPersistence),
          headcount,
          message: respawnFailureMessage(headcount),
        },
        true,
      );
    }

    // 3. VERIFY the replacement actually booted. The launcher can only report that it spawned a
    //    terminal, and that terminal outlives a CLI that dies on its first call — so without this
    //    step ok:true means "a window opened", which reads as "the member is back" and is how a
    //    respawn silently leaves a fleet a member down (WI-6936).
    if (verifySec === 0 || !rosterReadable) {
      const launchTransactionPersistence = await persistRespawnTransaction(
        'unverified',
        `respawn replacement ${replacementOwner} launched but verification was ${rosterReadable ? 'skipped' : 'unavailable'}`,
      );
      return json({
        ok: true,
        fleet: slug,
        oldMember: memberOwnerId,
        replacementOwner,
        invokedAs,
        changed: changedFields,
        drainOutcome,
        killed: kill.data,
        launched: launch.text,
        ...(cooperativeRequest ? { cooperativeRequest, cooperativeDrain } : {}),
        launchSpec: {
          provenance: savedLaunchSpec.provenance,
          reusePath: savedLaunchSpec.reusePath,
          overrides: savedLaunchSpec.overrides,
          preservedFields: savedLaunchSpec.preservedFields,
        },
        verified: false,
        launchTransactionPersistence: summarizeRespawnLaunchTransaction(launchTransactionPersistence),
        verification: rosterReadable ? 'skipped' : 'unavailable',
        message: `Launch REQUESTED but NOT verified${rosterReadable ? ' (verifySec:0)' : ' (the fleet presence roster could not be read)'} — the launcher only knows it spawned a terminal, which survives a CLI that dies before its first turn. Confirm a real agent exists before relying on it: fleet:leader-brief { fleet:'${slug}', include_stale:true } and require a NEW member with loopMode set and a fresh heartbeat.`,
      });
    }

    const verify = replacementVerification
      ? await replacementVerification
      : await awaitReplacementMember({
          before: rosterBefore,
          expectedOwnerId: replacementOwner,
          list: () => listFleetPresence(workspaceId, slug),
          timeoutMs: verifySec * 1000,
        });
    const launchTransactionPersistence = await persistRespawnTransaction(
      verify.verified ? 'verified' : 'unverified',
      verify.verified
        ? undefined
        : `respawn replacement ${replacementOwner} launched but never appeared in the fleet roster within ${verifySec}s`,
    );

    return json(
      {
        ok: verify.verified,
        fleet: slug,
        oldMember: memberOwnerId,
        replacementOwner,
        invokedAs,
        changed: changedFields,
        drainOutcome,
        killed: kill.data,
        launched: launch.text,
        ...(cooperativeRequest ? { cooperativeRequest, cooperativeDrain } : {}),
        launchSpec: {
          provenance: savedLaunchSpec.provenance,
          reusePath: savedLaunchSpec.reusePath,
          overrides: savedLaunchSpec.overrides,
          preservedFields: savedLaunchSpec.preservedFields,
        },
        verified: verify.verified,
        launchTransactionPersistence: summarizeRespawnLaunchTransaction(launchTransactionPersistence),
        newMember: verify.newMemberOwnerId,
        waitedMs: verify.waitedMs,
        ...(verify.verified
          ? {}
          : {
              rosterOwnerIds: verify.rosterOwnerIds,
              message: `The replacement was LAUNCHED but never appeared in the fleet roster within ${verifySec}s — the terminal spawned and the agent CLI did not come up (an exhausted account pool, a bad model/agent spec, or a missing credential all present this way). The fleet is DOWN A MEMBER. Check fleet:capacity before relaunching; a spawn into an exhausted pool dies the same way again.`,
            }),
      },
      !verify.verified,
    );
  },
});
