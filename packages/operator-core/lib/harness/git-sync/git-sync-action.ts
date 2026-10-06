/**
 * The `system:git-sync` routine action (git-sync-auto-commit P-005/P-009/P-010/P-012).
 * Registered into the system-action registry; the routines engine runs it inline as
 * one durable DBOS step per due git-sync routine.
 *
 * Wraps the pure pipeline (`run-git-sync.ts`) with the live concerns:
 *   - P-009 LOCKS (git-sync-any-hive P-006: per-slug): hold the workspace-wide
 *     `git-sync` restart barrier shared, then `git-sync:<slug>` (exclusive,
 *     auto-registered on first acquire) + every name in the routine's
 *     `trigger_config.extra_lock_resources` (exclusive, must be human-registered)
 *     for the whole commit→submodule-push→pointer-bump→push sequence, so a peer
 *     agent's in-flight git work doesn't race a restart or another fire. The
 *     legacy papercup `git-sync` extra is filtered because it is now the shared
 *     barrier, not a second exclusive acquisition. Held by a peer → skip this
 *     tick (back-pressure). An UNREGISTERED extra resource → skip with a loud log
 *     (a deliberate coordination surface — never auto-registered). Every fire
 *     uses a unique lock owner so scheduled and manual paths contend even though
 *     both are represented by the `system:git-sync` action. SU-lock infra
 *     unavailable → proceed unlocked (the existing fail-open behavior remains
 *     an explicit degraded mode, with the next tick retrying the lock).
 *   - RUNTIME GATE (git-sync-any-hive P-008, action half): before anything else,
 *     a routine row pointing at a hive home / remote-hive view / non-local
 *     deployment / vanished or non-git checkout NO-OPS with a logged reason and a
 *     `last_status: 'skipped'` metadata patch instead of error-escalating.
 *   - P-010 ESCALATION: on a merge conflict, write a `git-sync-conflict` row to
 *     `harness_escalations` (the tree is already clean — the pipeline aborts the merge).
 *   - P-012 RESOLVER: spawn a `merge-resolver` role via the invoke route, deduped on
 *     the open escalation (one resolver per harness). A clean sync clears the escalation.
 *   - Records `{ last_synced_at, last_status, head_sha }` onto the routine's metadata.
 *   - Records `git_sync_activity` while the local commit stage and every bridged/P2P
 *     post-leg are still running, so `routines:list` cannot mistake local-stage
 *     completion for a terminal git-sync fire (EI-21049559233457671).
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { inWorkspaceTxn } from '../../agent-tools/locks/in-workspace-txn';
import { acquireWithContentionRetry, isWorkspaceContended } from '../../agent-tools/locks/contention-retry';
import {
  clearResourceExclusiveQueue,
  clearResourceWaiter,
  readResourceQueue,
  releaseAllResourcesForOwner,
  tryAcquireResource,
  tryReleaseResource,
  type ResourceAcquireResult,
} from '../../agent-tools/locks/su-lock-store';
import { describeStaleHolderVerdict, reclaimDeadExclusiveHolders } from '../../agent-tools/locks/resource-acquire-wait';
import { endedSessionOwners } from '../../agent-tools/locks/ended-session-owners';
import type { liveLockHoldingsStrict } from '../../agent-tools/locks/live-lock-paths';
// P-014: the commit-gate census is live locks ∪ restricted-disclosure holds.
import { isRestrictedHoldIntent, readGitSyncCensusStrict } from '../../personal-vault/git-sync-hold';
import { agentsForScopedFiles, type AttributionRosterEntry } from './git-sync-attribution';
import { loadHarnessRegistry, type ProjectEntry } from '../../harness-registry';
import { describeFetchError, loopbackFetch } from '../../loopback-fetch';
import { resolveLaunchTargetForEvent } from '../../blueprint/launch-blueprint';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { registerSystemAction, type SystemActionCtx, type SystemActionResult } from '../routines/system-actions';
import { getBuildInfo } from '../../build-info';
import { stripNulBytesDeep } from '../../coord-lifecycle/records';
import { requestOnlyHost } from '../../background-workers';
import { runCheckpointedStep } from '../../dbos/checkpointed-step';
import { gitSyncEligibility, type GitSyncEligibility } from './git-sync-eligibility';
import { getPotGitMode, type PotGitMode } from './hive-git-mode';
import {
  applyIntegrationPushTarget,
  integrationModeGovernsHarness,
  readPotIntegrationMode,
  resolveIntegrationPushRemote,
  type IntegrationPushDecision,
} from './pot-integration-mode';
import { fileSyncBackConflict, makeSyncBackConflictFilingDeps } from './sync-back';
import { parseGithubUrl } from '../clone-github';
import { fetchRepoPushPermission } from '../github-repo-permissions';
import {
  BRIDGE_CANONICAL_REF,
  BRIDGE_REMOTE_STAGING_REF,
  GITHUB_CREDENTIAL_HELPER_KEY,
  runGithubBridgeTick,
} from '../../sync/pot-git/github-bridge-tick';
import { resolveAnnouncementWatermark, runIntegratorTick } from '../../sync/pot-git/integrator-tick';
import { githubOriginNamespaceKey } from '../../sync/pot-git/github-ingress';
import { formatIntegratorTickStatus } from '../../sync/pot-git/integrator';
import { runWorktreeBridgeTick, WORKTREE_BRIDGE_RETRY_TTL_MS } from '../../sync/pot-git/worktree-bridge-tick';
import { catchUpWorktreeToWatermark } from '../../sync/pot-git/worktree-bridge';
import {
  type DivergenceObservation,
  type WorktreeDivergence,
  describeDivergenceTransition,
  nextWorktreeDivergence,
  parseWorktreeDivergence,
} from './worktree-divergence';
import {
  HiveEffectAuthorityError,
  loadHiveEffectAuthority,
  nextHivePublicationTerm,
  requireHiveEffectAuthority,
} from '../../sync/pot-git/hive-effect-authority';
import {
  runRefAnnouncePublishTick,
  runRefAnnounceReceiveTick,
  formatRefAnnounceReceiveCensus,
  formatRefAnnounceReceiveFreshness,
  REF_ANNOUNCE_RECEIVE_BATCH_LIMIT,
  decideRefAnnounceReceiveCursor,
  mergeParkedIntoReceiveBatch,
  REF_ANNOUNCE_RECEIVE_IDLE_MS,
  type ParkedRefAnnouncements,
  type RefAnnounceReceiveBatchRow,
} from '../../sync/pot-git/ref-announce-tick';
import {
  REF_ANNOUNCE_EVENT_KEY,
  REF_ANNOUNCE_SCHEMA_VERSION_CONTEXT,
  isSignedRefAnnouncement,
  verifyRefAnnouncement,
  type SignedRefAnnouncement,
  type AnnounceBudgetState,
} from '../../sync/pot-git/ref-announce';
import {
  formatConvergenceVerdict,
  formatReleaseConsistencyVerdict,
  judgeConvergence,
  judgeReleaseConsistency,
  selectConvergenceCandidates,
  type AnnouncedSnapshot,
  type ConvergenceState,
  type ConvergenceVerdict,
  type LocalMirror,
  type ReleaseConsistencyVerdict,
} from '../../sync/pot-git/convergence-probe';
import { readSigrefs, SIGREFS_REF } from '../../sync/pot-git/sigrefs';
import {
  STAGING_ADVANCE_EVENT_KEY,
  isSignedStagingAdvance,
  type SignedStagingAdvance,
  type EpochSeq,
} from '../../sync/pot-git/staging-advance';
// EI-19332963201820362: the ONLY sanctioned way to build a `worktree_bridge`
// metadata value. patchRoutineMetadata is a top-level jsonb merge, so writing
// that key REPLACES it wholesale — constructing it here means a writer cannot
// omit (i.e. silently DELETE) a field. Read that module's header before adding one.
import {
  decideWorktreeBridgePersistence,
  nextWorktreeBridgeState,
  shouldWarnAcceptFree,
} from './worktree-bridge-state';
import {
  defaultRunGit,
  deviceNamespaceKey,
  ensurePotGitRepo,
  hiveGitRepoPath,
  listNamespaces,
  pathExists,
  readNamespaceRef,
  sweepStalePackTmpFiles,
  type RunGit as PotGitRunGit,
} from '../../sync/pot-git/storage';
import { STAGING_REF } from '../../sync/pot-git/integrator';
import { reconcileProposedCompletionsAtCommit } from './completion-settlement-reconciler';
import {
  completeGithubBridgeState,
  completeOwnHeadPublishState,
  completeRefAnnounceState,
  type GitSyncRoutineMetadataPatch,
  type RefAnnounceRoutineState,
} from './routine-metadata-state';
import { canonicalRepoKey } from '../../sync/pot-git/repo-identity';
import {
  signedProtocolContextMatches,
  isSignedProtocolContext,
  type SignedProtocolScope,
  type SignedSnapshotFloor,
} from '../../sync/pot-git/signed-context';
import {
  assertGitServingCapability,
  guardGitServingSigner,
  validateGitServingState,
  type GitServingCapability,
  type GitServingRequest,
  type GitServingState,
} from '../../sync/pot-git/serving-capability';
import { getHiveBySlug } from '../../hive-store';
import { adoptRefusedRepoKey } from '../../sync/pot-git/adopt-refused-repo-key';
import {
  armNoSuchRepoBackoff,
  devicesToArmForNoSuchRepo,
  isNoSuchRepoBackoffActive,
  liftNoSuchRepoBackoffOnFreshAnnouncement,
  newestAnnouncementTsByDevice,
  noSuchRepoBackoffKey,
  noSuchRepoBackoffSecondsLeft,
} from './no-such-repo-backoff';
import { refAnnounceRepoEnvelope, refAnnounceTargetsRepo } from './ref-announce-repo-scope';
import {
  boundedUnshallowTimeoutMs,
  nextUnshallowBackoff,
  runOwnHeadPublishTick,
  type OwnHeadPublishTickOutcome,
  type OwnHeadUnshallowBackoffState,
} from '../../sync/pot-git/own-head-publish';
import { describePublishRefusal } from '../../sync/pot-git/publish-guard';
import { bootstrapFromPeer, hasPendingQuarantine } from '../../sync/pot-git/bootstrap';
import { fetchCoalescerKey, withFetchCoalescing } from '../../sync/pot-git/fetch-coalescer';
import { openHiveGitDuplexToDevice, type HiveGitDuplexRequest } from '../../sync/pot-git/peer-dial-registry';
import { Duplex } from 'node:stream';
// EI-18777176681958978: `potHomeSlug` here is the LOCAL registry handle
// (`entry.hive_slug ?? entry.slug`), which on a joiner can differ from the
// OWNER-authored scope the pot_members projection writes under — reading it directly
// returns an EMPTY roster. The *ForLocalPot wrapper resolves the federated scope first
// (a no-op on an owner).
import { listHiveMembersForLocalPot, loadRevokedHivePubkeysForLocalPotCached } from '../../federated-pot-scope';
import { loadRevokedPubkeysCached } from '../../sync/hyperbee/load-revoked-pubkeys';
import { pickHiveGitActor, type HiveGitActor } from './hive-git-actor';
import { loadCachedLocalAnnounceIdentity } from '../../sync/hyperbee/local-announce-identity';
import { signWithDeviceKey } from '../../identity/sign-with-device-key';
import { resolveAuthorCommsTier } from '../../sync/hyperbee/comms-tier-gate';
import { emitAwaitedEvent } from '../../events/await/engine';
import {
  decideContentQuarantineNotice,
  decideGitSyncEscalation,
  oversizedKey,
  selectContentNoticeRecipients,
  type ContentQuarantineNotice,
  type EscalationReason,
} from './git-sync-escalation';
import { deriveGenesisBaselineSha } from './genesis-baseline';
import { appendPipelineEvent } from './pipeline-events';
import { DEFAULT_CONTENT_DETECTORS } from '../../content-lint/registry';
import { contentSnapshotHash, detectorResultHash } from './content-guard';
import { checkDirtyMigrationReservations } from '../../migration-reservation';
import {
  runGitSync,
  runGitBounded,
  DEFAULT_MAX_BLOB_BYTES,
  DEFAULT_MAX_COMMIT_TOTAL_BYTES,
  gitTimeoutMsFor,
  discoverSubmodulesRecursive,
  listStashEntries,
  newStashEntries,
  partitionStashEntriesByAge,
  describeStashAge,
  type RunGit,
  type GitSyncConfig,
  type GitSyncOutcome,
  type GitSyncSkippedPath,
  type RepoConflict,
  type RepoError,
  type ScopedOversized,
  type ScopedContentError,
  type StrandedSubmodule,
} from './run-git-sync';
import {
  createLockDomainIdentity,
  mapLiveLockHoldingsForRepo,
  nestedInstallRepoPrefix,
  translateLiveLockHoldingsToRoot,
  type DomainLockHolding,
  type LockHoldingCoordinates,
} from './live-lock-coordinates';
import {
  emitGitSyncCommittedEvent,
  emitGitSyncEgressedEvent,
  emitGitSyncLockRetryEvent,
  emitResourceReleasedEvent,
  isSystemGitSyncHolder,
  snapshotGitSyncLockHolders,
  type GitSyncLockHolderSnapshot,
} from './git-sync-events';
import { parsePapercuspTrailers, recordCommitAttribution, type CommitAttributionRow } from '../../edit-attribution';
import { pinModuleState } from '@papercusp/module-singleton';
import {
  enqueueDependencyPrebuild,
  recoverQueuedDependencyPrebuild,
  runDependencyGenerationPrebuild,
  type DependencyPrebuildRequest,
} from '../../release/dependency-generation-prebuild';

const GIT_SYNC_OWNER = 'system:git-sync';
const LOCK_TTL_SEC = 600;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;
// Keep the lease refresh comfortably inside its expiry window. Long, progressing
// fetches can legitimately run well past LOCK_TTL_SEC; without a refresh the
// resource row expires mid-run and the next scheduled fire enters the same
// checkout concurrently (EI-20224276977835463).
const LOCK_HEARTBEAT_INTERVAL_MS = 60_000;
// Keep the writer-backed activity marker fresh without turning git child output
// into one metadata UPDATE per line. A stale marker is still useful evidence of
// a wedged phase; a moving marker proves only that the pipeline is producing
// progress, not that it has completed.
const GIT_SYNC_ACTIVITY_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Bound the period for which one fire may hold the git-sync resources without
 * making observable progress.  The idle deadline is deliberately one lease
 * lifetime: a stuck setup await therefore cannot keep the heartbeat renewing a
 * self-held lease forever.  Progress from the git runner re-arms this deadline;
 * the independent hard ceiling still bounds a chatty or otherwise misbehaving
 * action.  Both are environment-tunable for operators and deterministic tests.
 */
const DEFAULT_GIT_SYNC_ACTION_IDLE_TIMEOUT_MS = LOCK_TTL_SEC * 1000;
const DEFAULT_GIT_SYNC_ACTION_HARD_TIMEOUT_MS = 2 * 60 * 60_000;
// Completion settlement is best-effort post-commit bookkeeping. Bound one
// scheduled fire to half the three-minute cadence; rows updated by a partial
// pass move forward so a later fire can continue the remaining candidates.
const DEFAULT_GIT_SYNC_COMPLETION_SETTLEMENT_BUDGET_MS = 90_000;
const GIT_SYNC_ACTION_CLEANUP_TIMEOUT_MS = 15_000;

const positiveEnvMs = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** Public seams for focused liveness tests and operator diagnostics. */
export function gitSyncActionIdleTimeoutMs(): number {
  return positiveEnvMs(
    'PAPERCUSP_GIT_SYNC_ACTION_IDLE_TIMEOUT_MS',
    positiveEnvMs('PAPERCUSP_GIT_SYNC_ACTION_TIMEOUT_MS', DEFAULT_GIT_SYNC_ACTION_IDLE_TIMEOUT_MS),
  );
}

export function gitSyncActionHardTimeoutMs(): number {
  return positiveEnvMs('PAPERCUSP_GIT_SYNC_ACTION_HARD_TIMEOUT_MS', DEFAULT_GIT_SYNC_ACTION_HARD_TIMEOUT_MS);
}

function gitSyncCompletionSettlementBudgetMs(): number {
  return positiveEnvMs(
    'PAPERCUSP_GIT_SYNC_COMPLETION_SETTLEMENT_BUDGET_MS',
    DEFAULT_GIT_SYNC_COMPLETION_SETTLEMENT_BUDGET_MS,
  );
}

/** A timeout raised by the action-level liveness guard, distinct from git's own child timeout. */
export class GitSyncActionTimeoutError extends Error {
  readonly code = 'git_sync_action_timeout';
  readonly phase: string;
  readonly timeoutKind: 'idle' | 'hard';
  readonly timeoutMs: number;

  constructor(phase: string, timeoutKind: 'idle' | 'hard', timeoutMs: number) {
    super(`git-sync action timed out during ${phase} after ${timeoutMs}ms (${timeoutKind} liveness deadline)`);
    this.name = 'GitSyncActionTimeoutError';
    this.phase = phase;
    this.timeoutKind = timeoutKind;
    this.timeoutMs = timeoutMs;
  }
}

class GitSyncCompletionSettlementBudgetError extends Error {
  readonly code = 'git_sync_completion_settlement_budget';
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`git-sync completion settlement exceeded its ${timeoutMs}ms per-fire budget`);
    this.name = 'GitSyncCompletionSettlementBudgetError';
    this.timeoutMs = timeoutMs;
  }
}

interface GitSyncActionLivenessGuard {
  readonly signal: AbortSignal;
  readonly timedOut: boolean;
  readonly timeoutError: GitSyncActionTimeoutError | null;
  /** Mark real pipeline progress and re-arm the idle deadline. */
  touch(): void;
  /** Fail closed before starting a new operation after expiry. */
  assertActive(): void;
  /** Run one awaitable operation with a cancellation race that ignores late settlement. */
  run<T>(operation: () => Promise<T>, phase: string): Promise<T>;
  /** Wait for the timeout callback's best-effort cleanup, if expiry occurred. */
  waitForTimeoutCleanup(): Promise<void>;
  /** Stop both deadline timers after the lock-held critical section settles. */
  stop(): void;
}

/**
 * Create the action-level deadline/abort seam.  `run` does not merely use
 * Promise.race: it removes its abort listener and ignores a late promise
 * settlement, so a stale setup await cannot resume the pipeline after cleanup.
 */
function createGitSyncActionLivenessGuard(opts: {
  idleTimeoutMs: number;
  hardTimeoutMs: number;
  onTimeout: (error: GitSyncActionTimeoutError) => void | Promise<void>;
}): GitSyncActionLivenessGuard {
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleCheck: ReturnType<typeof setImmediate> | null = null;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let timedOut = false;
  let timeoutError: GitSyncActionTimeoutError | null = null;
  let activePhase = 'unidentified action phase';
  let timeoutCleanup: Promise<void> | null = null;

  const expire = (kind: 'idle' | 'hard'): void => {
    if (stopped || timedOut) return;
    timedOut = true;
    timeoutError = new GitSyncActionTimeoutError(
      activePhase,
      kind,
      kind === 'idle' ? opts.idleTimeoutMs : opts.hardTimeoutMs,
    );
    // Abort first. Guarded awaits reject immediately, but the owning action
    // must drain any started Git executions before stopping its lease heartbeat.
    controller.abort(timeoutError);
    timeoutCleanup = Promise.resolve()
      .then(() => opts.onTimeout(timeoutError!))
      .catch(() => {
        // Cleanup is also attempted by the owning finally block; a timer callback
        // must never create an unhandled rejection if that cleanup itself fails.
      });
  };

  const armIdle = (): void => {
    if (stopped || timedOut) return;
    if (idleTimer) clearTimeout(idleTimer);
    if (idleCheck) clearImmediate(idleCheck);
    idleCheck = null;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      // Match the child guards: after parent-loop delay, queued pipe progress
      // must be delivered in POLL before the action commits an idle verdict.
      // touch() cancels this candidate; the hard deadline remains independent.
      idleCheck = setImmediate(() => {
        idleCheck = null;
        expire('idle');
      });
      // Keep the one-shot verdict runnable even when a stalled await produces
      // no events before the hard deadline. stop/touch still cancel it.
    }, opts.idleTimeoutMs);
    idleTimer.unref?.();
  };

  const touch = (): void => {
    if (!stopped && !timedOut) armIdle();
  };

  hardTimer = setTimeout(() => expire('hard'), opts.hardTimeoutMs);
  hardTimer.unref?.();
  armIdle();

  const run = <T>(operation: () => Promise<T>, phase: string): Promise<T> => {
    if (stopped) return Promise.reject(new Error(`git-sync action is already stopped before ${phase}`));
    if (timedOut)
      return Promise.reject(timeoutError ?? new GitSyncActionTimeoutError(phase, 'idle', opts.idleTimeoutMs));
    activePhase = phase;
    touch();

    let work: Promise<T>;
    try {
      work = Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        controller.signal.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        finish();
        reject(timeoutError ?? new GitSyncActionTimeoutError(phase, 'idle', opts.idleTimeoutMs));
      };
      if (controller.signal.aborted) {
        onAbort();
        return;
      }
      controller.signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (value) => {
          if (settled) return;
          settled = true;
          finish();
          if (controller.signal.aborted) {
            reject(timeoutError ?? new GitSyncActionTimeoutError(phase, 'idle', opts.idleTimeoutMs));
            return;
          }
          touch();
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          finish();
          reject(error);
        },
      );
    });
  };

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    get timeoutError() {
      return timeoutError;
    },
    touch,
    assertActive: () => {
      if (timedOut) throw timeoutError ?? new GitSyncActionTimeoutError(activePhase, 'idle', opts.idleTimeoutMs);
      if (stopped) throw new Error('git-sync action liveness guard is stopped');
    },
    run,
    waitForTimeoutCleanup: async () => {
      if (timeoutCleanup) await timeoutCleanup;
    },
    stop: () => {
      stopped = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (idleCheck) clearImmediate(idleCheck);
      idleTimer = null;
      hardTimer = null;
      idleCheck = null;
    },
  };
}

/**
 * Resource locks coalesce a same-owner acquire into a lease refresh. That is
 * correct for one long-lived caller, but the cron and `git-sync:run` paths both
 * identify themselves as `system:git-sync`; sharing that owner would let two
 * fires enter the same checkout concurrently. Keep the stable identity for
 * broadcasts, but give every fire its own lock owner (including this host
 * process's PID) so the resource store's different-owner conflict path provides
 * real single-flight protection and a restarted background host can reclaim its
 * own definitely-dead lease.
 */
const newGitSyncLockOwner = (): string => `${GIT_SYNC_OWNER}:${process.pid}:${randomUUID()}`;

/**
 * Start the advisory dependency producer without making its long build part of
 * the git-sync critical path. The caller must have persisted the queued
 * handoff first; that ordering is what makes a process exit recoverable.
 */
function fireDependencyPrebuild(request: DependencyPrebuildRequest, source: 'published' | 'recovery'): void {
  void runDependencyGenerationPrebuild(request)
    .then((prebuildOutcome) => {
      console.log(
        `[git-sync] ${request.installSlug}: dependency prebuild ${prebuildOutcome} (${source}) for ${request.candidate.slice(0, 12)}`,
      );
    })
    .catch((error) => {
      // The gate's fail-closed fallback remains authoritative. Observable but
      // never allowed to turn a successful Git publication into a failed tick.
      console.warn(
        `[git-sync] ${request.installSlug}: dependency prebuild ${source} failed for ${request.candidate.slice(0, 12)}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    });
}

/**
 * A queued handoff can outlive the DBOS fire that created it. Every later
 * git-sync tick gets one cheap read and, when it finds a strict queued marker,
 * rehydrates the request from that marker rather than from ambient env/path
 * state. The producer's atomic claim makes concurrent recoveries harmless.
 */
function fireQueuedDependencyPrebuildRecovery(workspaceId: string, installSlug: string): void {
  void recoverQueuedDependencyPrebuild({ workspaceId, installSlug })
    .then((outcome) => {
      if (outcome !== 'none') {
        console.log(`[git-sync] ${installSlug}: dependency prebuild recovery ${outcome}`);
      }
    })
    .catch((error) => {
      console.warn(
        `[git-sync] ${installSlug}: queued dependency prebuild recovery failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    });
}

/**
 * EI-20366486129597369: invert `newGitSyncLockOwner` for the stale-holder
 * recovery path. Legacy UUID-only owners and every unrelated resource owner are
 * deliberately unrecognized, so they retain normal back-pressure semantics.
 */
export function parseGitSyncOwnerPid(owner: string): number | null {
  const m = /^system:git-sync:(\d+):/.exec(owner);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/**
 * The lock owners of the fires CURRENTLY in flight in THIS host process.
 *
 * `reclaimDeadExclusiveHolders` reclaims a lease whose owner PID is
 * definitively dead, or (EI-22078335832051825) whose owner is an agent SESSION
 * the shared liveness oracle calls `ended`. Neither instrument can see one
 * orphan class: a fire that acquired the lock and then stopped existing while
 * its HOST process kept running (a cancelled/reaped DBOS workflow — WI-1416's
 * reaper does exactly this — or any abort between the acquire and the `finally`
 * that releases). The row's PID is alive and its owner is not a session, so
 * both dead-holder tests decline; the fire that would have released it is
 * gone; so nothing frees it until the 600s TTL.
 * Worse, it is self-sustaining: every later tick reads it as a live peer and
 * skips, and when it finally expires the next tick can orphan a fresh one.
 * Measured 2026-08-27: 3h40m with ZERO commits fleet-wide, `git_sync_activity`
 * frozen at `active:false` the whole time (no fire ever entered the pipeline),
 * while the lease relayed in exact 600s hops that were never heartbeat-extended.
 *
 * Membership here is the falsifier the PID test cannot be: an owner naming THIS
 * pid that is NOT in this set belongs to a fire this process no longer has, so
 * it is provably an orphan. Pinned per the shared-package singleton rule — a
 * split module record would make the set read empty and turn every live fire's
 * own lease into a reclaim candidate.
 */
const gitSyncLockState = pinModuleState('@papercusp/operator-core.git-sync-lock-owners', () => ({
  inFlight: new Set<string>(),
}));

/** True when `owner` names this process but no fire here still holds it. */
export function isOrphanedSelfOwner(
  owner: string,
  // Injectable so the decision is testable without driving the process-wide
  // pinned set; production callers pass neither.
  inFlight: ReadonlySet<string> = gitSyncLockState.inFlight,
  selfPid: number = process.pid,
): boolean {
  return parseGitSyncOwnerPid(owner) === selfPid && !inFlight.has(owner);
}

/**
 * Return commits newly covered by a proven remote staging head. The bridge
 * emits the head on every up-to-date tick, but an exact-SHA waiter may target
 * an older commit carried by a later head. Restrict the ancestry walk to the
 * previous egress range when possible so a quiet tick does not re-emit an
 * entire repository's history; the event emitter always adds the head itself.
 * Best-effort: a failed local walk leaves the head signal intact.
 */
async function newlyEgressedCommitShas(
  headSha: string,
  repoPath: string,
  previousHeadSha: string | null,
): Promise<string[]> {
  if (previousHeadSha === headSha) return [];
  const range = previousHeadSha && FULL_COMMIT_SHA.test(previousHeadSha) ? `${previousHeadSha}..${headSha}` : headSha;
  const result = await defaultRunGit(['rev-list', '--topo-order', range], repoPath);
  if (result.code === 0) {
    return result.stdout
      .split(/\s+/)
      .map((sha) => sha.trim())
      .filter((sha) => FULL_COMMIT_SHA.test(sha));
  }
  // A stale/missing previous watermark must not suppress the ancestry proof;
  // retry against the head alone before falling back to the head-only event.
  if (range !== headSha) {
    const fallback = await defaultRunGit(['rev-list', '--topo-order', headSha], repoPath);
    if (fallback.code === 0) {
      return fallback.stdout
        .split(/\s+/)
        .map((sha) => sha.trim())
        .filter((sha) => FULL_COMMIT_SHA.test(sha));
    }
  }
  return [];
}

/**
 * Read the checkout-pinned GitHub helper without changing either checkout's
 * config. GitHub bridge work runs against a bare pot-git store, while the
 * registered clone may carry a per-account helper in `.git/config`; selecting
 * the last non-empty local value lets the bridge reuse that auth contract.
 */
export async function resolveGithubCredentialHelper(
  checkoutPath: string,
  runGit: PotGitRunGit = defaultRunGit,
): Promise<string | null> {
  if (!checkoutPath) return null;
  const result = await runGit(['config', '--local', '--get-all', GITHUB_CREDENTIAL_HELPER_KEY], checkoutPath);
  if (result.code !== 0) return null;
  const values = result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  return values.at(-1) ?? null;
}
/**
 * The `harness_escalations` row key for ALL git-sync escalations is
 * `(harness_slug, 'git-sync')` — a CONSTANT phase, deliberately NOT the lifecycle
 * phase ('staging'/'testing'/'production') and NOT the routine's branch
 * (git-sync-any-hive P-007, B-05 decision):
 *   - branch-derived phases would orphan an open escalation whenever the routine's
 *     branch changes (the clear-on-clean-pass UPDATE would target a different row),
 *     and would collide with the lifecycle-phase namespace;
 *   - the old constant 'staging' SHARED its row with other phase='staging' writers
 *     (auto-rebase's rebase_conflict, brainstorm) — they clobbered each other via
 *     ON CONFLICT DO UPDATE. A git-sync-owned phase ends that.
 * Consumer audit (2026-06-12): every reader is phase-loose for git-sync rows —
 * `git-pipeline-stats.ts` filters by kind='git-sync-conflict' only; the
 * `harness:escalation` tool / `getEscalation` (harness-readers.ts — the
 * merge-resolver's read path) selects by slug ordered by mtime_ms with no phase
 * filter; the improvements watchdog collectors filter by workspace only. The one
 * phase-keyed reader (`device-harnesses.ts`, joining on the harness's lifecycle
 * status phase) reads LIFECYCLE escalations — git-sync rows moving out of it is
 * intended. Open rows were migrated 'staging' → 'git-sync' in db migration 237.
 */
const ESCALATION_PHASE = 'git-sync';
const ESCALATION_KIND = 'git-sync-conflict';
/** EI-18: repeated push failures / oversized-file exclusions — needs a human/agent,
 *  but is NOT a merge conflict (no resolver dispatch). */
const ESCALATION_ERROR_KIND = 'git-sync-error';
/** The event key the `merge-resolution` launch blueprint declares (its trigger). */
const CONFLICT_EVENT = 'git-sync:conflict';

/**
 * The durable action result returned to an on-demand caller. Cron callers ignore
 * the value, but `git-sync:run` must not collapse a typed pipeline outcome into
 * a void promise and then guess from a HEAD delta (EI-20197846888469383).
 */
export type GitSyncFireOutcome =
  | GitSyncOutcome
  | {
      status: 'skipped';
      reason: string;
      blockedOn?: string;
      holders?: GitSyncLockHolderSnapshot[];
      /** WI-10004472: a DBOS recovery replay refused its locks and ended without diverging. */
      replayAbandoned?: true;
    };

/**
 * EI-438 content guard (git-sync-content-guard-2026-06-13 P-004/P-005). Broken
 * files (an .mdx that won't compile, a curly quote used as code) are quarantined
 * from the auto-commit by the content guard (run-git-sync) so they never reach
 * `staging`; the action layer escalates them + dispatches a `content-fixer`.
 *
 * Content escalations get their OWN phase ('git-sync-content'), a SEPARATE row
 * from the conflict/error escalation (phase 'git-sync') — so a content quarantine
 * and a merge conflict coexist + clear independently, never clobbering each other
 * on the single (harness_slug, phase) row. The content-fixer reads its files from
 * the `--git-sync-content-error` extra (below), not this row, so the phase-loose
 * `getEscalation` (mtime-ordered) reader can never feed it the wrong escalation.
 *
 * EI-17 rides this SAME pipeline: `outcome.contentErrors` also carries any dirty
 * deletion a surviving file still (relatively) imports (detectorKey
 * 'unsafe-deletion', see deletion-import-guard.ts) — this layer treats it exactly
 * like a broken .mdx (same quarantine/escalation/content-fixer dispatch/5-tick
 * human-escalation), no separate code path.
 */
const CONTENT_ESCALATION_PHASE = 'git-sync-content';
const CONTENT_ERROR_KIND = 'git-sync-content-error';
/** The event key the `content-fix` launch blueprint declares (its trigger). */
const CONTENT_ERROR_EVENT = 'git-sync:content-error';
/** After this many consecutive ticks with the file STILL broken, stop auto-dispatching
 *  the content-fixer and surface to a human (P-005: never an infinite silent fix loop).
 *  The file stays quarantined regardless, so `staging` is never at risk. */
const MAX_CONTENT_FIXER_ATTEMPTS = 5;

/**
 * EI-20402093158205519 (stranded-submodule census). A POPULATED but UNREGISTERED
 * submodule — a real worktree on disk that `.git/config` carries no
 * `submodule.<name>.url` for — is invisible to every leg of this pipeline:
 * `git submodule status` marks it '-', discovery skips it, so git-sync never
 * visits the repo and CANNOT commit its dirty files. The edit LOOKS landed (the
 * file is on disk and the local build is green) while a clean clone of the branch
 * does not have it at all. That divergence is the defect, and its signature is
 * SILENCE: the pass that strands the work is otherwise a perfectly clean 'synced'.
 *
 * Like the content guard this rides its OWN phase row, separate from the
 * conflict/error row ('git-sync'), so a strand and a merge conflict coexist and
 * clear independently. UNLIKE the content guard it dispatches no fixer, because
 * git-sync must not auto-resolve a strand: these worktrees are commonly parked on
 * deliberate detached pins, and registering one would fetch/merge/push it and
 * UNPIN it. Registering is the operator's call; losing the work silently is not.
 * The row is the whole deliverable — visible, queryable, and self-clearing on the
 * first pass that measures a clean tree.
 */
const STRAND_ESCALATION_PHASE = 'git-sync-strand';
const STRAND_KIND = 'git-sync-strand';

/** Coord identity for git-sync's own broadcasts (mirrors service-health's). */
const GIT_SYNC_IDENTITY: AgentIdentity = {
  ownerId: 'system:git-sync',
  ownerLabel: 'git-sync',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

/** The action-level knobs parsed from the routine's `trigger_config`: the pure
 *  pipeline config plus the lock surface (which never reaches `runGitSync`). */
interface ActionTrigger {
  config: GitSyncConfig;
  /**
   * Additional REGISTERED resource names to hold exclusively for the tick
   * (`trigger_config.extra_lock_resources`, git-sync-any-hive P-006). papercup's
   * row lists `['git-sync', 'libs-papercusp-submodule']`; the legacy `git-sync`
   * entry is the workspace-wide shared restart barrier and is filtered from this
   * exclusive list, while `libs-papercusp-submodule` remains an exclusive
   * back-off resource. Names here are a deliberate, human-registered
   * coordination surface — an UNKNOWN name skips the tick with a log, never
   * auto-registers.
   */
  extraLockResources: string[];
}

function configFromTrigger(triggerConfig: Record<string, unknown>): ActionTrigger {
  const extras = Array.isArray(triggerConfig.extra_lock_resources)
    ? triggerConfig.extra_lock_resources.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    : [];
  return {
    config: {
      push: triggerConfig.push !== false,
      pushSubmodules: triggerConfig.push_submodules !== false,
      pushSubmoduleOrigins:
        typeof triggerConfig.pushSubmoduleOrigins === 'boolean' ? triggerConfig.pushSubmoduleOrigins : undefined,
      branch: typeof triggerConfig.branch === 'string' ? triggerConfig.branch : undefined,
      remote: typeof triggerConfig.remote === 'string' ? triggerConfig.remote : undefined,
      maxBlobBytes: typeof triggerConfig.max_blob_bytes === 'number' ? triggerConfig.max_blob_bytes : undefined,
      maxCommitTotalBytes:
        typeof triggerConfig.max_commit_total_bytes === 'number' ? triggerConfig.max_commit_total_bytes : undefined,
    },
    extraLockResources: extras,
  };
}

/** The workspace-wide resource exclusively acquired by dev:restart and shared by
 *  every git-sync fire. A shared acquire lets different harnesses commit in
 *  parallel while making the restart's exclusive acquire atomic with the
 *  post-preflight window (WI-229179). */
const GIT_SYNC_RESTART_BARRIER_RESOURCE = 'git-sync';

/** The per-harness lock resource this slug's tick holds (P-006). */
const gitSyncResourceName = (slug: string): string => `git-sync:${slug}`;

type GitSyncLockMode = 'shared' | 'exclusive';

interface GitSyncLockRequest {
  resource: string;
  mode: GitSyncLockMode;
}

/** Minimal tagged-template seam over the txn handle (postgres-js `Sql`), so this
 *  module needs no direct `postgres` type dependency. */
type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

/**
 * Idempotently register the per-slug `git-sync:<slug>` resource (inside the SAME
 * inWorkspaceTxn as the acquire that follows). Without this, an unregistered name
 * makes `tryAcquireResource` return `{ ok:false, reason:'unknown_resource' }`,
 * which used to read as "held" → a PERMANENT silent no-op on any harness whose
 * name nobody had hand-registered. Modeled on sql/008-register-git-sync-resource.sql
 * (no register helper is exported from @papercusp/locks). ON CONFLICT DO NOTHING:
 * a human-edited row is never clobbered. ONLY the per-slug name is auto-registered —
 * extra_lock_resources names must already exist in the registry.
 */
export async function registerGitSyncResource(tx: SqlTag, slug: string): Promise<void> {
  const resource = gitSyncResourceName(slug);
  const description =
    `The automated git-sync pipeline for harness "${slug}" (commit + submodule push + merge + push to origin). ` +
    "Concurrent git-sync runs, or a run racing a peer's manual git work on this checkout, race the index/refs.";
  const ruleText =
    `The system:git-sync routine action holds exclusive(${resource}) for the whole ` +
    'commit -> submodule-push -> pointer-bump -> push sequence. A peer doing manual whole-tree git work in this ' +
    `harness's checkout can acquire exclusive(${resource}) to make its git-sync back off that tick.`;
  await tx`
    INSERT INTO agent_resource_registry
      (resource, description, rule_text, enforcement, match_patterns, coordination_domain_kind)
    VALUES (${resource}, ${description}, ${ruleText}, 'advisory', ARRAY[]::text[], 'workspace')
    ON CONFLICT (resource) DO NOTHING
  `;
}

/**
 * WI-562584: declare, on the registry row, that THIS resource's holders live in
 * the workspace domain — because that is the domain this action is about to
 * acquire it in (`cd = ctx.workspaceId || '*'`).
 *
 * Every member of the tick's lock set gets this, not just the auto-registered
 * per-slug name. That is the whole point: the names that were mis-resolved are
 * the `trigger_config.extra_lock_resources` ones, which are HUMAN-registered
 * (see {@link registerGitSyncResource}) and therefore never touched by the
 * INSERT above. An agent reading `resourceLockDomain()` previously inferred the
 * caller-tree domain for those names and was granted a lock in a namespace this
 * action never checks — mutual exclusion silently not holding.
 *
 * Derived, not hand-maintained: the value comes from the acquirer's own live
 * lock set, so an install that adds an extra resource tomorrow is covered
 * without an edit to shared operator-core code (which could not enumerate a
 * per-install config anyway).
 *
 * Failures are swallowed. The stamp makes a future acquire by a DIFFERENT actor
 * resolve the same domain; it is not a precondition of THIS acquire, and the
 * cross-domain conflict guard on the agent side already fails closed without
 * it. Aborting a commit over it would trade a real capability for a diagnostic.
 */
async function stampWorkspaceDomainKind(tx: SqlTag, slug: string, resource: string): Promise<void> {
  try {
    await tx`
      UPDATE agent_resource_registry
         SET coordination_domain_kind = 'workspace', updated_ts = clock_timestamp()
       WHERE resource = ${resource}
         AND coordination_domain_kind IS DISTINCT FROM 'workspace'
    `;
  } catch (err) {
    console.warn(
      `[git-sync] ${slug}: could not declare workspace coordination domain for "${resource}":`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

type AcquireState = 'acquired' | 'held' | 'contended' | 'error';
interface AcquireOutcome {
  state: AcquireState;
  /** The resource that blocked the acquisition (state 'held' or 'contended'). */
  blockedOn?: string;
  /** The store's refusal reason (state 'held') — 'unknown_resource' means the
   *  name isn't registered, not that a peer holds it. */
  blockedReason?: string;
  /** JSON-safe live holders returned by the resource-lock refusal. */
  holders?: GitSyncLockHolderSnapshot[];
}

/**
 * A git-sync fire never waits for an exclusive FIFO ticket: a refused acquire
 * is a terminal skipped fire. The resource store defaults to a terminal refusal
 * with no FIFO ticket; this path still removes any stale ticket left by an
 * older caller or an explicitly queued request before returning. Otherwise
 * resource_grant_cascade could grant a ticket to a fire that no longer exists,
 * creating a self-relaying 600s lease with nobody left to heartbeat or release
 * it (WI-209800 / D-104).
 *
 * Clear every queued git-sync owner, not only the current UUID. Historical
 * skipped fires may already have returned, and no live consumer can ever use
 * those tickets. Non-git-sync owners retain the generic FIFO contract.
 */
async function clearQueuedGitSyncOwners(
  tx: Parameters<typeof readResourceQueue>[0],
  coordinationDomain: string,
  resource: string,
): Promise<string[]> {
  const queue = await readResourceQueue(tx, { coordinationDomain, resource });
  const owners = [
    ...new Set(
      (queue.queue ?? [])
        .map((entry) => entry.owner)
        .filter((queuedOwner) => queuedOwner === GIT_SYNC_OWNER || queuedOwner.startsWith(`${GIT_SYNC_OWNER}:`)),
    ),
  ];
  for (const queuedOwner of owners) {
    await clearResourceExclusiveQueue(tx, coordinationDomain, resource, queuedOwner);
    await clearResourceWaiter(tx, coordinationDomain, resource, queuedOwner);
  }
  return owners;
}

async function releaseAll(cd: string, owner: string, acquired: GitSyncLockRequest[]): Promise<void> {
  // This fire is done with the lock either way — drop it from the in-flight set
  // FIRST, so that a release which fails below (TTL becomes the backstop, see the
  // warn) still leaves a row a later tick here can recognise as our orphan and
  // reclaim, instead of one that blocks this host for the full ten minutes.
  gitSyncLockState.inFlight.delete(owner);
  if (acquired.length === 0) return;
  try {
    // Every fire owns a unique token, so the store's existing owner-scoped bulk
    // release is exactly this cleanup operation. Use ONE workspace transaction
    // and ONE DELETE for the whole lock set. The previous per-resource loop took
    // the workspace advisory lock up to three times per fire; when several fires
    // settled together, those teardown transactions contended with each other,
    // routinely outliving the 15s cleanup budget and keeping dev:restart's
    // exclusive barrier draining for its full 45s (EI-22047168222679674).
    const released = await acquireWithContentionRetry(() =>
      inWorkspaceTxn(cd, owner, (tx) => releaseAllResourcesForOwner(tx, cd, owner)),
    );
    // The bulk store release bypasses locks:release and its broadcast helper.
    // Emit only after the transaction has removed each exclusive row so a
    // held_exclusive caller can await the truthful exact-resource boundary.
    for (const resource of released.exclusiveResources) {
      emitResourceReleasedEvent(resource, cd === '*' ? null : cd);
    }
  } catch (error) {
    // The bulk release is transactional: either every owner-scoped row is gone
    // or none is. Keep the TTL as the final backstop, but make the missed release
    // visible instead of claiming that the committed path is fully unlocked.
    console.warn(
      `[git-sync] lock-set release failed for ${acquired.map(({ resource }) => resource).join(', ')} after ${
        isWorkspaceContended(error) ? 'contention retries' : 'an infrastructure error'
      }; locks will expire at TTL (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/**
 * Refresh every acquired resource lock while the git pipeline is running.
 *
 * `tryAcquireResource` deliberately coalesces a same-owner acquire into a lease
 * refresh, so this uses the exact same store path and resource-domain contract as
 * the initial acquire. Only one refresh pass may be in flight; a slow lock-store
 * round trip must not build an unbounded interval backlog. The stop function
 * waits for an already-started pass before the caller releases the locks.
 */
function startLockHeartbeat(
  cd: string,
  slug: string,
  resources: GitSyncLockRequest[],
  owner: string,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;

  const refresh = async (): Promise<void> => {
    try {
      // Refresh the whole owner-scoped set under ONE workspace transaction.
      // Apart from cutting three advisory-lock acquisitions to one, this makes
      // stopLockHeartbeat wait for at most one contention-retry sequence during
      // cleanup instead of one sequence per resource. That bound is what lets an
      // exclusive restart drain converge under a multi-fire settle burst.
      const results = await acquireWithContentionRetry(() =>
        inWorkspaceTxn(cd, owner, async (tx) => {
          const refreshed: Array<{ resource: string; result: ResourceAcquireResult }> = [];
          for (const { resource, mode } of resources) {
            const result = await tryAcquireResource(tx, {
              coordinationDomain: cd,
              resource,
              mode,
              owner,
              ownerLabel: `git-sync:${slug}`,
              reason: `auto-commit ${slug}`,
              ttlSec: LOCK_TTL_SEC,
            });
            refreshed.push({ resource, result });
          }
          return refreshed;
        }),
      );
      for (const { resource, result } of results) {
        if (!result.ok) {
          console.error(
            `[git-sync] ${slug}: LOST exclusive lock ${resource} during lease refresh (${result.reason ?? 'refused'})`,
          );
        }
      }
    } catch (e) {
      console.warn(`[git-sync] ${slug}: lock-set heartbeat failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const timer = managedSetInterval(
    `git-sync-lock-heartbeat:${slug}`,
    LOCK_HEARTBEAT_INTERVAL_MS,
    () => {
      if (inFlight) return;
      inFlight = refresh().finally(() => {
        inFlight = null;
      });
    },
    { category: 'ephemeral-harness', classification: 'must-sample' },
  );

  return async () => {
    timer.stop();
    if (inFlight) await inFlight;
  };
}

// EI-1720 + worker-fire-path zombie spawns: the lock-acquire contention retry
// (acquireWithContentionRetry / isWorkspaceContended) now lives in the shared
// locks module (also used by file-lock-guard). Re-exported so the existing
// git-sync-action suite keeps importing acquireWithContentionRetry from here.
export { acquireWithContentionRetry } from '../../agent-tools/locks/contention-retry';

/**
 * WI-2140647: the orphan class documented at {@link gitSyncLockState} — a fire
 * that acquired a lease and then stopped existing while its host process kept
 * running (a cancelled/reaped DBOS workflow, or any abort between the acquire
 * and the `finally` that releases) — is already reclaimed for EXCLUSIVE
 * holders, but only reactively: the reclaim in the acquire loop below runs
 * only when a later acquire on the SAME resource is refused `held_exclusive`,
 * and even then it explicitly skips non-exclusive holders. A SHARED acquire
 * (the workspace-wide `GIT_SYNC_RESTART_BARRIER_RESOURCE`) almost never gets
 * refused that way — shared coalesces with shared — so a stale self-owned
 * SHARED hold is never swept by this process's own later ticks; it just sits
 * until its `LOCK_TTL_SEC` (600s) expiry. Meanwhile every stale SHARED holder
 * blocks dev:restart's exclusive drain (its 45s budget) and, once dev:restart
 * queues, can starve sibling ticks acquiring the same barrier.
 *
 * Proactive, unconditional (not gated on a refusal): every SHARED acquire
 * first sweeps that resource's live holders for ones this same PID owns but
 * has no in-flight fire for (per {@link isOrphanedSelfOwner}), and releases
 * them. Releasing also promotes any queued exclusive request on the resource
 * (`tryReleaseResource` → `promoteResourceExclusiveQueue`), which is what lets
 * a blocked dev:restart drain actually proceed instead of waiting out the TTL.
 * Cheap — one indexed SELECT plus, in the common case, zero releases.
 */
async function reclaimOrphanedSelfSharedHolds(
  tx: Parameters<typeof readResourceQueue>[0],
  coordinationDomain: string,
  resource: string,
): Promise<void> {
  const { holders } = await readResourceQueue(tx, { coordinationDomain, resource });
  for (const holder of holders) {
    if (holder.mode !== 'shared' || !isOrphanedSelfOwner(holder.owner)) continue;
    const released = await tryReleaseResource(tx, {
      coordinationDomain,
      owner: holder.owner,
      lockId: holder.lock_id,
    }).catch(() => null);
    if (released && released.released > 0) {
      console.error(
        `[git-sync] ORPHANED SELF SHARED-LEASE RECLAIMED — ${resource} holder ${holder.owner} ` +
          '(this process, but no fire here still holds it)',
      );
    }
  }
}

/** Acquire `git-sync:<slug>` (auto-registered) + every extra resource exclusively,
 *  or signal held/error (releasing partials). */
async function acquireLocks(
  cd: string,
  slug: string,
  resources: GitSyncLockRequest[],
  acquired: GitSyncLockRequest[],
  owner: string,
): Promise<AcquireOutcome> {
  const perSlug = gitSyncResourceName(slug);
  for (const { resource, mode } of resources) {
    const acquireOne = () =>
      acquireWithContentionRetry(() =>
        inWorkspaceTxn(cd, owner, async (tx) => {
          // Auto-register ONLY the per-slug name, in the same txn as its acquire.
          if (resource === perSlug) await registerGitSyncResource(tx as SqlTag, slug);
          // ...but declare the workspace domain for EVERY name in the lock set —
          // the extras are human-registered, and they are exactly the ones a
          // reader used to mis-resolve to the caller tree (WI-562584).
          await stampWorkspaceDomainKind(tx as SqlTag, slug, resource);
          // WI-2140647: sweep this SAME resource for orphaned self-owned SHARED
          // holds before acquiring — see reclaimOrphanedSelfSharedHolds' docstring.
          if (mode === 'shared') await reclaimOrphanedSelfSharedHolds(tx, cd, resource);
          const purgedOwners = await clearQueuedGitSyncOwners(tx, cd, resource);
          if (purgedOwners.length > 0) {
            console.error(
              `[git-sync] ABANDONED EXCLUSIVE QUEUE PURGED — ${slug} ${resource}: ` +
                `${purgedOwners.length} terminal fire ticket(s)`,
            );
          }
          return tryAcquireResource(tx, {
            coordinationDomain: cd,
            resource,
            mode,
            owner,
            ownerLabel: `git-sync:${slug}`,
            reason: `auto-commit ${slug}`,
            ttlSec: LOCK_TTL_SEC,
          });
        }),
      );
    let r: ResourceAcquireResult;
    try {
      // EI-1720: retry-with-backoff on a TRANSIENT pg 57014/55P03 so a load-driven
      // workspace-lock contention spike delays — but does not multi-minute-stall —
      // the commit, instead of skipping the tick outright.
      r = await acquireOne();
      if (!r.ok && (r.reason === 'held_exclusive' || r.reason === 'exclusive_pending')) {
        // A killed bg-host leaves a fresh-looking exclusive row behind. Give
        // this fire one proof-safe reclaim attempt before treating it as a live
        // peer; the helper scopes release by lock_id and accepts exactly two
        // verdicts: ESRCH on the pid the owner string embeds, or — for a holder
        // that names no pid, or whose pid is alive while its SESSION is gone —
        // an `ended` verdict from the shared liveness oracle
        // (EI-22078335832051825: an agent's `su-…` lease on git-sync:portal
        // outlived its session for the full TTL while coord:presence already
        // said `ended`). The oracle is presence-gated, so a peer host's own
        // fire owner is never mistaken for a dead session.
        let reclaimed = await reclaimDeadExclusiveHolders(
          cd,
          owner,
          r.holders ?? [],
          parseGitSyncOwnerPid,
          (info) => {
            console.error(
              `[git-sync] STALE LOCK RECLAIMED — ${slug} ${resource} holder ${info.holder.owner} ` +
                `(${describeStaleHolderVerdict(info)}); retrying the acquire`,
            );
          },
          endedSessionOwners,
        );
        // The orphan class the dead-PID test above structurally cannot see: a
        // lease taken by a fire of OURS that no longer exists while this process
        // does (see `gitSyncLockState`). Its PID is alive, so the reclaim
        // declines; nothing else will ever release it; and every later tick then
        // reads our own abandoned row as a live peer and skips. Falsify it with
        // the in-flight set rather than with liveness, and release by lock_id so
        // this can never touch a lease a concurrent fire here legitimately holds.
        for (const holder of r.holders ?? []) {
          if (holder.mode !== 'exclusive' || !isOrphanedSelfOwner(holder.owner)) continue;
          const released = await inWorkspaceTxn(cd, owner, (tx) =>
            tryReleaseResource(tx, { coordinationDomain: cd, owner: holder.owner, lockId: holder.lock_id }),
          ).catch(() => null);
          if (released && released.released > 0) {
            reclaimed = true;
            console.error(
              `[git-sync] ORPHANED SELF-LEASE RECLAIMED — ${slug} ${resource} holder ${holder.owner} ` +
                `(this process, but no fire here still holds it); retrying the acquire`,
            );
          }
        }
        if (reclaimed) r = await acquireOne();
      }
    } catch (e) {
      // Reaching here on contention means the load window outlasted the retries;
      // the next tick retries without running unlocked. A non-contention error is
      // SU-lock DB unreachable / not bootstrapped — proceed unlocked (best-effort).
      const contended = isWorkspaceContended(e);
      console.warn(
        `[git-sync] lock ${contended ? 'contended after retries' : 'infra unavailable'} (${resource}): ${e instanceof Error ? e.message : e}`,
      );
      await releaseAll(cd, owner, acquired);
      acquired.length = 0;
      return {
        state: contended ? 'contended' : 'error',
        ...(contended ? { blockedOn: resource, blockedReason: 'lock_contended' } : {}),
      };
    }
    if (!r.ok) {
      // A peer holds it (or an extra name is unregistered) — skip this tick,
      // retry next. This fire has no wait loop and is terminal now. Cancel any
      // stale/explicitly queued git-sync ticket and release a possible late
      // cascade grant atomically before returning; releasing by THIS owner
      // cannot touch the peer row.
      try {
        await acquireWithContentionRetry(() =>
          inWorkspaceTxn(cd, owner, async (tx) => {
            await clearQueuedGitSyncOwners(tx, cd, resource);
            await clearResourceExclusiveQueue(tx, cd, resource, owner);
            await clearResourceWaiter(tx, cd, resource, owner);
            await tryReleaseResource(tx, { coordinationDomain: cd, owner, resource });
          }),
        );
      } catch (error) {
        console.error(
          `[git-sync] ${slug}: failed to cancel terminal exclusive request for ${resource}; ` +
            `TTL remains the backstop (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      await releaseAll(cd, owner, acquired);
      acquired.length = 0;
      return {
        state: 'held',
        blockedOn: resource,
        blockedReason: r.reason,
        holders: snapshotGitSyncLockHolders(r.holders ?? []),
      };
    }
    // Mark this fire's owner live BEFORE the next resource is attempted: from
    // here on, a row naming it is legitimately held and must never be read as
    // an orphan (by a concurrent fire in this process, or by our own retry).
    gitSyncLockState.inFlight.add(owner);
    acquired.push({ resource, mode });
  }
  return { state: 'acquired' };
}

export type GitSyncPerInstallLeaseResult<T> =
  | { state: 'ran'; value: T }
  | {
      state: 'skipped';
      reason: string;
      blockedOn?: string;
      holders?: GitSyncLockHolderSnapshot[];
    };

/**
 * Run one post-local-sync operation under the existing per-install
 * `git-sync:<slug>` lease.
 *
 * The main git pipeline releases its restart barrier and checkout lock before
 * the post-legs begin, deliberately keeping a long P2P cold join out of the
 * local commit critical section. That release also means two host processes
 * can otherwise enter the bootstrap leg together and race-replace the whole
 * `routines.metadata.bootstrap` object. Re-acquiring only the per-install
 * resource closes that race without holding the restart barrier or configured
 * repository extras during network transfer.
 *
 * This path is fail-closed: lock-store failure skips the post-leg rather than
 * running a metadata writer without mutual exclusion. A scheduled next tick is
 * the retry mechanism. The heartbeat stops when the action-level liveness
 * signal aborts; the held row then expires at its ordinary TTL if the underlying
 * operation never settles, instead of an abandoned callback renewing forever.
 */
export async function runWithGitSyncPerInstallLease<T>(
  slug: string,
  workspaceId: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<GitSyncPerInstallLeaseResult<T>> {
  const coordinationDomain = workspaceId || '*';
  const resources: GitSyncLockRequest[] = [{ resource: gitSyncResourceName(slug), mode: 'exclusive' }];
  const acquired: GitSyncLockRequest[] = [];
  const owner = newGitSyncLockOwner();
  const lease = await acquireLocks(coordinationDomain, slug, resources, acquired, owner);
  if (lease.state !== 'acquired') {
    return {
      state: 'skipped',
      reason: lease.blockedReason ?? (lease.state === 'contended' ? 'lock_contended' : 'lock_infra_unavailable'),
      ...(lease.blockedOn ? { blockedOn: lease.blockedOn } : {}),
      ...(lease.holders ? { holders: lease.holders } : {}),
    };
  }

  const stopHeartbeat = startLockHeartbeat(coordinationDomain, slug, resources, owner);
  let heartbeatStop: Promise<void> | null = null;
  const stopHeartbeatOnce = (): Promise<void> => {
    if (!heartbeatStop) heartbeatStop = stopHeartbeat();
    return heartbeatStop;
  };
  const onAbort = (): void => {
    void stopHeartbeatOnce();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('git-sync per-install lease operation aborted');
    }
    return { state: 'ran', value: await operation() };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await stopHeartbeatOnce();
    await releaseAll(coordinationDomain, owner, acquired);
  }
}

/** The /invoke timeout for a merge-resolver run: it drains+takes the git-sync
 *  lock (≤120s) then merges, all within this ceiling. Used BOTH as the invoke
 *  `timeoutMs` AND as the floor the in-flight TTL must clear — one source of
 *  truth so the two can never drift apart. */
const RESOLVER_INVOKE_TIMEOUT_MS = 900_000;
/** Margin past the invoke timeout before a 'dispatched' marker is presumed stale —
 *  covers settle-recording latency + clock skew. */
const RESOLVER_INFLIGHT_MARGIN_MS = 5 * 60_000;
/** How long a 'dispatched' resolver is presumed to still be running before we'd
 *  re-dispatch (P-010). DERIVED from the invoke timeout (+ margin) so it ALWAYS
 *  exceeds it — a still-running resolver is never double-dispatched on the next
 *  conflict tick (git-sync-dx-hardening P-009: the audit's "TTL ≤ timeout" would
 *  have INVERTED this invariant and double-dispatched; the real fix is making the
 *  two constants one derivation, not free-floating magic numbers). Instance-tagging
 *  already re-dispatches a restart-orphaned run immediately; this TTL is only the
 *  backstop for a same-process run whose settle-recording never fires. */
const RESOLVER_INFLIGHT_MS = RESOLVER_INVOKE_TIMEOUT_MS + RESOLVER_INFLIGHT_MARGIN_MS;

/**
 * This operator process incarnation (P-006). Resolver/fixer dispatches are
 * FIRE-AND-FORGET `loopbackFetch` calls whose settle-recording `.then`/`.catch`
 * lives only in the dispatching process, so the marker retains this id for
 * forensic attribution. It is NOT a liveness oracle: several live operator
 * processes share the same routine row, and a reader seeing another instance's
 * marker does not mean that writer died. In-flight dedup therefore uses the
 * durable status + timestamp below; its TTL is the restart-orphan backstop.
 */
const PROCESS_INSTANCE_ID = `${process.pid}.${Date.now().toString(36)}`;

/**
 * Identity of the process/build that wrote a git-sync outcome. The
 * runtime-vintage row is the boot-time receipt; this marker is the routine's
 * own write-time receipt, so readers can distinguish a stale process that
 * kept ticking from a current one without inferring identity from the
 * checkout's present HEAD.
 */
interface GitSyncLoadedBuildIdentity {
  pid: number;
  instance: string;
  sha: string | null;
  version: string;
  recorded_at: number;
}

function loadedBuildIdentity(recordedAt: number): GitSyncLoadedBuildIdentity {
  const build = getBuildInfo();
  return {
    pid: process.pid,
    instance: PROCESS_INSTANCE_ID,
    sha: build.sha,
    version: build.version,
    recorded_at: recordedAt,
  };
}

/** The shape of the `metadata->'last_resolver'` marker the dedup reads. */
export interface ResolverMarker {
  status?: string;
  at?: number;
  /** The operator instance that fired the dispatch (P-006), retained for
   *  attribution only. Absent on legacy markers written before instance-tagging. */
  instance?: string;
}

/** Extra identity carried by the content-fixer marker. */
interface ContentFixerMarker extends ResolverMarker {
  /** Stable offender identity, independent of the detector's human message. */
  signature?: string;
  /** Consecutive content-error pass that produced this dispatch. */
  pass?: number;
  files?: string[];
}

/**
 * Whether a merge-resolver is GENUINELY in-flight for this harness — pure so the
 * dedup WINDOW is directly unit-testable (P-007: the window is keyed on PG
 * timestamps, never on git round-trip timing, so seconds of real fetch/push
 * latency are negligible against the minutes-scale RESOLVER_INFLIGHT_MS / 900s
 * resolver ceiling). This replaced the old "is an escalation open?" dedup, which
 * permanently suppressed the resolver after a SILENT dispatch failure. The rules:
 *   - never-run / already-settled (status !== 'dispatched') → NOT in flight (retry);
 *   - 'dispatched' from ANY instance → in flight until RESOLVER_INFLIGHT_MS
 *     lapses. Multiple live operator processes share this row, so instance
 *     inequality cannot prove an orphan; treating it as one caused overlapping
 *     6-GiB content-fixers and host memory PSI/OOM pressure (EI-20336929607862174);
 *   - the TTL is both the genuinely-slow-run ceiling and the restart-orphan
 *     backstop. A crashed writer may delay one retry, but can never spawn an
 *     unbounded concurrent repair storm.
 */
export function isResolverInFlight(lr: ResolverMarker | null | undefined, now: number, _instanceId: string): boolean {
  if (!lr || lr.status !== 'dispatched') return false; // never-run or already settled → retry
  // Instance ids are attribution, not liveness. A different id may be another
  // healthy operator process serving the same workspace, so only the durable TTL
  // may declare a dispatched marker stale.
  return typeof lr.at === 'number' && now - lr.at < RESOLVER_INFLIGHT_MS;
}

async function resolverInFlight(slug: string, workspaceId: string): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql<{ lr: ResolverMarker | null }[]>`
    SELECT metadata->'last_resolver' AS lr
      FROM harness_shared.routines
     WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
     LIMIT 1
  `;
  return isResolverInFlight(rows[0]?.lr, Date.now(), PROCESS_INSTANCE_ID);
}

async function writeGitSyncEscalation(slug: string, workspaceId: string, conflicts: RepoConflict[]): Promise<void> {
  const { sql } = getOrgPg();
  const scopes = conflicts.map((c) => c.scope);
  const body = JSON.stringify({
    kind: ESCALATION_KIND,
    harness_slug: slug,
    // Every (sub)repo that conflicted this pass — the escalation (UNIQUE per
    // harness+phase) carries them all so the resolver sees the full set.
    conflicts: conflicts.map((c) => ({ scope: c.scope, conflicted_files: c.conflictedFiles })),
    scope: scopes.join(', '),
    emitted_at: Date.now(),
    detail: `git-sync auto-merge conflicted in ${scopes.join(', ')}; trees aborted clean, merge-resolver dispatched.`,
  });
  await sql.unsafe(
    `INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (harness_slug, phase)
     DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`,
    [slug, ESCALATION_PHASE, body, Date.now(), workspaceId],
  );
}

/** Clear git-sync escalations of the given kinds after a clean sync (other kinds intact).
 *  `phase` defaults to the conflict/error phase; content escalations pass their own. */
async function clearGitSyncEscalation(slug: string, kinds: string[], phase: string = ESCALATION_PHASE): Promise<void> {
  const { sql } = getOrgPg();
  await sql.unsafe(
    `UPDATE harness_shared.harness_escalations
        SET escalation = NULL, mtime_ms = $2
      WHERE harness_slug = $1 AND phase = $3
        AND escalation IS NOT NULL
        AND (escalation::jsonb ->> 'kind') = ANY($4)`,
    [slug, Date.now(), phase, kinds],
  );
}

/**
 * EI-438 (P-004): write/refresh the `git-sync-content-error` escalation — the
 * human-visible record that broken files are quarantined (and, once it has failed
 * MAX_CONTENT_FIXER_ATTEMPTS ticks, that a human must step in). Its own phase row,
 * unconditional upsert (no other kind shares 'git-sync-content').
 */
async function writeGitSyncContentEscalation(
  slug: string,
  workspaceId: string,
  contentErrors: ScopedContentError[],
  consecutiveTicks: number,
  needsHuman: boolean,
): Promise<void> {
  const { sql } = getOrgPg();
  const files = contentErrors.map((c) => ({
    scope: c.scope,
    file: c.file,
    detector: c.detectorKey,
    error: c.error,
    // The detector scans dirty working-tree bytes, which may differ from HEAD.
    // Preserve the exact snapshot and verdict identity so the human escalation
    // remains reproducible after another edit or commit changes the file.
    ...(c.contentHash ? { contentHash: c.contentHash } : {}),
    ...(c.detectorResultHash ? { detectorResultHash: c.detectorResultHash } : {}),
  }));
  const list = contentErrors.map((c) => `${c.scope}/${c.file} [${c.detectorKey}]`).join(', ');
  const body = JSON.stringify({
    kind: CONTENT_ERROR_KIND,
    harness_slug: slug,
    files,
    consecutive_content_error_ticks: consecutiveTicks,
    needs_human: needsHuman,
    emitted_at: Date.now(),
    detail: needsHuman
      ? `git-sync content guard: ${files.length} file(s) STILL failing their content check after ${consecutiveTicks} ticks — the content-fixer could not repair them; a human must fix: ${list}. (They are quarantined — excluded from every auto-commit — so staging stays clean while they wait.)`
      : `git-sync quarantined ${files.length} broken file(s) (excluded from the auto-commit so staging stays clean); content-fixer dispatched: ${list}.`,
  });
  await sql.unsafe(
    `INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (harness_slug, phase)
     DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`,
    [slug, CONTENT_ESCALATION_PHASE, body, Date.now(), workspaceId],
  );
}

/**
 * EI-20402093158205519: write/refresh the `git-sync-strand` escalation — the
 * human-visible record that N populated-but-unregistered submodules hold tracked
 * work this pass could not reach. Its own phase row, unconditional upsert (no other
 * kind shares 'git-sync-strand'), so it can never clobber the conflict/error row.
 *
 * The body names the FILES, not just a count: the whole failure mode is an agent
 * believing an edit landed, so a reader must be able to see which edits did not
 * without going to hunt for them. `files` is already capped upstream (20/submodule).
 */
async function writeGitSyncStrandEscalation(
  slug: string,
  workspaceId: string,
  stranded: StrandedSubmodule[],
): Promise<void> {
  const { sql } = getOrgPg();
  const totalFiles = stranded.reduce((n, s) => n + s.trackedFiles, 0);
  const list = stranded.map((s) => `${s.path} (${s.trackedFiles} tracked file(s))`).join(', ');
  const body = JSON.stringify({
    kind: STRAND_KIND,
    harness_slug: slug,
    submodules: stranded.map((s) => ({ path: s.path, tracked_files: s.trackedFiles, files: s.files })),
    stranded_submodule_count: stranded.length,
    stranded_file_count: totalFiles,
    emitted_at: Date.now(),
    detail:
      `git-sync CANNOT COMMIT ${totalFiles} tracked file(s) in ${stranded.length} POPULATED but UNREGISTERED ` +
      `submodule(s): ${list}. They are absent from .git/config (no submodule.<name>.url), so ` +
      `'git submodule status' marks them '-' and discovery skips them entirely — the edits are NOT committed, ` +
      `NOT on origin, and a clean clone of this branch does not have them, even though they are on disk and the ` +
      `local build passes. Fix with: git submodule init <path> (idempotent; copies the .gitmodules URL into ` +
      `.git/config), then re-check the pin before the next tick. git-sync deliberately does NOT auto-resolve ` +
      `this — these worktrees are often parked on deliberate detached pins, and registering one here would ` +
      `fetch/merge/push it and UNPIN it.`,
  });
  await sql.unsafe(
    `INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (harness_slug, phase)
     DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`,
    [slug, STRAND_ESCALATION_PHASE, body, Date.now(), workspaceId],
  );
}

/**
 * EI-18: write/refresh the `git-sync-error` escalation (repeated push failures and/or
 * oversized-file exclusions). The (harness_slug, phase) row is SHARED with the
 * conflict escalation — the conditional DO UPDATE makes this a strict non-clobber:
 * an open `git-sync-conflict` (which a merge-resolver may be reading) always wins.
 */
async function writeGitSyncErrorEscalation(
  slug: string,
  workspaceId: string,
  info: {
    reasons: EscalationReason[];
    consecutiveErrorTicks: number;
    errors: RepoError[];
    oversized: ScopedOversized[];
  },
): Promise<void> {
  const { sql } = getOrgPg();
  const body = JSON.stringify({
    kind: ESCALATION_ERROR_KIND,
    harness_slug: slug,
    reasons: info.reasons,
    consecutive_error_ticks: info.consecutiveErrorTicks,
    errors: info.errors.map((e) => ({ scope: e.scope, message: e.message.slice(0, 500) })),
    oversized: info.oversized.map((f) => ({ scope: f.scope, path: f.path, size_bytes: f.sizeBytes })),
    emitted_at: Date.now(),
    detail:
      `git-sync needs attention: ${info.reasons.join(' + ')}` +
      (info.reasons.includes('push-failure')
        ? ` — push failed ${info.consecutiveErrorTicks} consecutive ticks (commits NOT reaching origin)`
        : '') +
      (info.oversized.length > 0
        ? ` — ${info.oversized.length} oversized file(s) excluded from auto-commit (gitignore or remove them)`
        : ''),
  });
  await sql.unsafe(
    `INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (harness_slug, phase)
     DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms
     WHERE harness_escalations.escalation IS NULL
        OR (harness_escalations.escalation::jsonb ->> 'kind') = $6`,
    [slug, ESCALATION_PHASE, body, Date.now(), workspaceId, ESCALATION_ERROR_KIND],
  );
}

/** Previous tick's EI-18 + content-guard counters from the routine metadata.
 *
 *  EI-21230011589307899 also reads the own-head-publish refusal recorded by the
 *  PREVIOUS tick's publish leg (that leg runs after the escalation decision, so this
 *  is the freshest value obtainable here) plus `last_publish_blocked_at`, the freeze
 *  point this reader saw one tick earlier — the pair is what distinguishes a NEW
 *  freeze (broadcast) from a persisting one (refresh the row silently). */
async function readEscalationCounters(
  slug: string,
  workspaceId: string,
): Promise<{
  errTicks: number;
  oversizedKeys: string[];
  contentTicks: number;
  contentSignature: string | null;
  /** EI-21906459740652039: consecutive ticks the cumulative-limit guard has peeled. */
  cumulativePeelTicks: number;
  publishRefusal: { refused: string; blockedAtCommit: string | null } | null;
  prevPublishBlockedAtCommit: string | null;
}> {
  const { sql } = getOrgPg();
  const rows = await sql<
    {
      et: number;
      lo: string[] | null;
      lb: string[] | null;
      ct: number;
      cs: string | null;
      cpt: number;
      pubrefused: string | null;
      pubblocked: string | null;
      lastpub: string | null;
    }[]
  >`
    SELECT coalesce((metadata->>'consecutive_error_ticks')::int, 0) AS et,
           array(SELECT jsonb_array_elements_text(coalesce(metadata->'last_oversized', '[]'::jsonb))) AS lo,
           array(SELECT jsonb_array_elements_text(coalesce(metadata->'last_bulk_excluded', '[]'::jsonb))) AS lb,
           coalesce((metadata->>'consecutive_content_error_ticks')::int, 0) AS ct,
           metadata->>'last_content_error_signature' AS cs,
           coalesce((metadata->>'consecutive_cumulative_peel_ticks')::int, 0) AS cpt,
           metadata->'own_head_publish'->>'refused' AS pubrefused,
           metadata->'own_head_publish'->>'blockedAtCommit' AS pubblocked,
           metadata->>'last_publish_blocked_at' AS lastpub
      FROM harness_shared.routines
     WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
     LIMIT 1
  `;
  const refused = rows[0]?.pubrefused ?? null;
  return {
    errTicks: rows[0]?.et ?? 0,
    // The escalation edge trigger historically read only last_oversized. The
    // reader now stores the two exclusion families separately, so retain the
    // union here to avoid re-broadcasting a cumulative peel as "new" on every
    // tick. Old rows simply have no `lb` and remain backwards compatible.
    oversizedKeys: [...new Set([...(rows[0]?.lo ?? []), ...(rows[0]?.lb ?? [])])],
    contentTicks: rows[0]?.ct ?? 0,
    contentSignature: rows[0]?.cs ?? null,
    cumulativePeelTicks: rows[0]?.cpt ?? 0,
    publishRefusal: refused ? { refused, blockedAtCommit: rows[0]?.pubblocked ?? null } : null,
    prevPublishBlockedAtCommit: rows[0]?.lastpub ?? null,
  };
}

/**
 * Spawn a merge-resolver role via the invoke route (P-012) — OBSERVABLY (GAP-2).
 *
 * The `/invoke` route is synchronous (it runs the agent to completion — up to the
 * timeoutMs below, now 900s), so we MUST NOT await it: this runs inside the git-sync
 * routine's DBOS step and blocking it for the resolver's full runtime would stall the
 * routines tick. (The resolver acquires the git-sync resource lock ITSELF when it merges;
 * git-sync's own locks are already released by the time control reaches here.) So this
 * stays fire-and-forget — but it is no longer SILENT:
 *   1. a durable `last_resolver: { status:'dispatched', … }` marker is written FIRST
 *      (awaited), so the attempt is recorded even if the process restarts mid-run;
 *   2. the eventual result (HTTP status, agent exitCode/timedOut, or a network error)
 *      is recorded when the dangling promise settles — instead of vanishing into a
 *      `void … .catch(console.warn)` that went to uncaptured stdout.
 * Query `metadata->'last_resolver'` on the routine to see whether the resolver ran.
 */
async function spawnMergeResolver(
  slug: string,
  workspaceId: string,
  conflicts: RepoConflict[],
  superprojectBranch: string,
): Promise<void> {
  // workspace-work-scope-policy-2026-09-04 P-008: git-sync keeps COMMITTING every
  // install, but an out-of-scope install gets no agent dispatched for its conflicts.
  {
    const { gateWorkScope } = await import('../../work-scope-policy');
    const scope = await gateWorkScope('git-sync:merge-resolver', { harness: slug });
    if (!scope.allowed) {
      console.warn(`[git-sync] ${slug}: merge-resolver dispatch skipped — ${scope.message}`);
      return;
    }
  }
  // unify-agent-launches-as-blueprints D-002/D-004: the launch is now DECLARATIVE.
  // The `merge-resolution` launch blueprint declares `triggers.event:
  // git-sync:conflict` + its role (decider merge-resolver); we resolve the role +
  // invoke URL from it by the event key, instead of hardcoding `role=merge-resolver`.
  // The conflict DETECTION + the in-flight dedup (`last_resolver`) + the observe
  // loop below stay git-sync's concern — behavior-preserving.
  const target = await resolveLaunchTargetForEvent(CONFLICT_EVENT, { installSlug: slug, workspaceId });
  if (!target) {
    console.warn(`[git-sync] no launch blueprint declares "${CONFLICT_EVENT}" — skipping merge-resolver dispatch`);
    return;
  }
  const { url } = target;
  const scopes = conflicts.map((c) => c.scope);
  const filesSummary = conflicts.map((c) => `${c.scope}: ${c.conflictedFiles.join(', ')}`).join('; ');
  // P-006: pre-compute authorship/intent for the conflicted files (deterministic, best-effort)
  // so the resolver integrates per each side's intent without spending tool calls to discover it.
  let authorship: Awaited<ReturnType<typeof computeConflictAuthorship>> = [];
  try {
    const { projectDirForSlug } = await import('../../operator-notes');
    const repoRoot = await projectDirForSlug(slug, workspaceId);
    if (repoRoot) authorship = await computeConflictAuthorship(repoRoot, conflicts);
  } catch {
    /* best-effort: the resolver prompt has a git-log fallback */
  }
  const dispatchedAt = Date.now();

  // (1) durable "dispatched" marker, awaited — observable even if (2) is lost.
  // Stamp THIS process instance for attribution; liveness is deliberately derived
  // from status + TTL because a different live operator instance shares this row.
  await recordResolverDispatch(slug, workspaceId, {
    at: dispatchedAt,
    status: 'dispatched',
    scopes,
    instance: PROCESS_INSTANCE_ID,
  });

  // Pipeline history (mig 177): log each resolver SETTLE (not the dispatch) so the
  // Git tab can show resolver success rate. Best-effort, like recordResolverDispatch.
  const logResolverSettle = (status: 'ok' | 'failed' | 'error', extra: Record<string, unknown>): Promise<void> =>
    appendPipelineEvent({
      workspaceId,
      installSlug: slug,
      kind: 'merge_resolver',
      status,
      detail: { scopes, ...extra },
    });

  // (2) async result recording. The /invoke route reads `extra` (forwarded to
  // invoke-once) — `kickoff` is for human readability only (the route ignores it);
  // the merge-resolver also reads the open escalation, which now lists every scope.
  loopbackFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      // P-007: the superproject branch comes from the routine's resolved config
      // (cfg.branch ?? 'main') — it is NOT papercup's 'staging' for other harnesses.
      kickoff: `Resolve the git-sync merge conflict(s) in ${scopes.join(', ')} (on the branch each conflicted repo has checked out — superproject = \`${superprojectBranch}\`, submodules = their own default). Conflicted: ${filesSummary}`,
      extra: ['--git-sync-conflict', JSON.stringify({ scopes, files: filesSummary, authorship })],
      // P-010: a real multi-file merge by a higher-effort model needs well beyond the
      // route's 90s default. The invoke-route ceiling is 1200s (the old "~300s ceiling"
      // comment was stale). It drains+takes the git-sync lock (≤120s) first, then merges;
      // RESOLVER_INFLIGHT_MS is DERIVED from this (+5min margin) so it always exceeds it
      // and we never re-dispatch a still-running resolver.
      timeoutMs: RESOLVER_INVOKE_TIMEOUT_MS,
    }),
  })
    .then(async (res) => {
      let exitCode: number | undefined;
      let timedOut: boolean | undefined;
      let detail = '';
      try {
        const j = (await res.json()) as {
          ok?: boolean;
          exitCode?: number;
          timedOut?: boolean;
          stderr?: string;
          decisionLine?: string;
        };
        exitCode = j?.exitCode;
        timedOut = j?.timedOut;
        if (j?.ok === false) detail = (j.decisionLine || j.stderr || '').slice(0, 400);
        const settled = res.ok && j?.ok !== false ? 'ok' : 'failed';
        await recordResolverDispatch(slug, workspaceId, {
          at: dispatchedAt,
          status: settled,
          httpStatus: res.status,
          exitCode,
          timedOut,
          detail,
        });
        await logResolverSettle(settled, { httpStatus: res.status, exitCode, timedOut, detail });
      } catch {
        const settled = res.ok ? 'ok' : 'failed';
        await recordResolverDispatch(slug, workspaceId, { at: dispatchedAt, status: settled, httpStatus: res.status });
        await logResolverSettle(settled, { httpStatus: res.status });
      }
    })
    .catch(async (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[git-sync] merge-resolver dispatch failed (${slug}): ${msg}`);
      await recordResolverDispatch(slug, workspaceId, { at: dispatchedAt, status: 'error', error: msg.slice(0, 300) });
      await logResolverSettle('error', { error: msg.slice(0, 300) });
    });
}

/** Record the merge-resolver dispatch lifecycle onto the routine metadata (GAP-2). */
async function recordResolverDispatch(slug: string, workspaceId: string, info: Record<string, unknown>): Promise<void> {
  try {
    await patchRoutineMetadata(slug, workspaceId, { last_resolver: info });
  } catch (e) {
    console.warn(`[git-sync] failed to record resolver dispatch (${slug}): ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * EI-438 content-fixer dedup (P-004): the SAME in-flight model as the
 * merge-resolver (`isResolverInFlight` is generic over the marker), keyed on its
 * OWN `last_content_fixer` routine-metadata marker so the two dispatchers never
 * suppress each other. A clean re-check tick clears the escalation.
 */
async function contentFixerInFlight(slug: string, workspaceId: string): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql<{ lr: ContentFixerMarker | null }[]>`
    SELECT metadata->'last_content_fixer' AS lr
      FROM harness_shared.routines
     WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
     LIMIT 1
  `;
  return isResolverInFlight(rows[0]?.lr, Date.now(), PROCESS_INSTANCE_ID);
}

/** Record the content-fixer dispatch lifecycle onto the routine metadata. */
async function recordContentFixerDispatch(
  slug: string,
  workspaceId: string,
  info: Record<string, unknown>,
): Promise<void> {
  try {
    await patchRoutineMetadata(slug, workspaceId, { last_content_fixer: info });
  } catch (e) {
    console.warn(`[git-sync] failed to record content-fixer dispatch (${slug}): ${e instanceof Error ? e.message : e}`);
  }
}

/** A quarantined importer is a dependency fence, not broken content a fixer can edit. */
function contentFixerEligibleErrors(contentErrors: readonly ScopedContentError[]): ScopedContentError[] {
  return contentErrors.filter((contentError) => contentError.detectorKey !== 'quarantined-importer');
}

/** Stable identity for one content-fixer job. Human detector messages are deliberately excluded.
 *  The separators are ASCII unit/record separators, never NUL: this value is persisted into
 *  routine metadata JSONB, which rejects \u0000, and a NUL here failed every outcome write
 *  (EI-24099226502437988 — origin froze because the bridge leg runs after that write). */
function contentFixerSignature(contentErrors: readonly ScopedContentError[]): string {
  return [...new Set(contentErrors.map((c) => `${c.scope}\u001f${c.file}\u001f${c.detectorKey}`))]
    .sort()
    .join('\u001e');
}

/** Persist human-actionable quarantine work through the existing condition-key upsert. */
async function upsertGitSyncContentHumanWorkItem(
  slug: string,
  workspaceId: string,
  contentErrors: readonly ScopedContentError[],
  consecutiveTicks: number,
): Promise<void> {
  const signature = contentFixerSignature(contentErrors);
  const signatureHash = createHash('sha256').update(signature).digest('hex').slice(0, 24);
  const files = contentErrors.map((c) => ({
    scope: c.scope,
    file: c.file,
    detector: c.detectorKey,
    error: c.error,
    // The detector scans dirty working-tree bytes, which may differ from HEAD.
    // Preserve the exact snapshot and verdict identity so the human escalation
    // remains reproducible after another edit or commit changes the file.
    ...(c.contentHash ? { contentHash: c.contentHash } : {}),
    ...(c.detectorResultHash ? { detectorResultHash: c.detectorResultHash } : {}),
  }));
  const fileList = files.map((f) => `${f.scope}/${f.file} [${f.detector}]: ${f.error}`).join('; ');
  const { upsertConditionWorkItem } = await import('../../coord/condition-upsert');
  await upsertConditionWorkItem(`git-sync-content:${slug}:${signatureHash}`, {
    kind: 'bug',
    title: `git-sync content quarantine needs a human (${files.length} file(s), ${signatureHash})`,
    summary:
      `The git-sync content fixer exhausted its ${MAX_CONTENT_FIXER_ATTEMPTS}-tick budget for this offender signature ` +
      `after ${consecutiveTicks} consecutive ticks. These files remain quarantined from auto-commit until repaired: ${fileList}`,
    severity: 'major',
    harness: slug,
    workspaceId,
    createdBy: GIT_SYNC_IDENTITY.ownerId,
    payload: {
      source: 'git-sync-content-guard',
      signature: signatureHash,
      consecutiveContentErrorTicks: consecutiveTicks,
      files,
    },
  });
}

/**
 * Atomically reserve a content-fixer dispatch.
 *
 * The old read-then-write sequence let two git-sync fires both observe a free
 * marker and enqueue the same fixer. The marker write is now the CAS: the row
 * is updated only when neither a live dispatch nor the same signature/pass is
 * already recorded.
 */
async function claimContentFixerDispatch(
  slug: string,
  workspaceId: string,
  rawMarker: ContentFixerMarker,
): Promise<boolean> {
  const { sql } = getOrgPg();
  // Same JSONB NUL rail as patchRoutineMetadata; the CAS compares the STRIPPED signature
  // so it matches what the marker actually persisted.
  const { value: marker } = stripNulBytesDeep(rawMarker);
  const signature = marker.signature ?? '';
  const pass = String(marker.pass ?? '');
  const staleBefore = Date.now() - RESOLVER_INFLIGHT_MS;
  try {
    const rows = (await sql.unsafe(
      `UPDATE harness_shared.routines
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
              updated_at = now()
        WHERE install_slug = $1
          AND workspace_id = $2
          AND target_role = 'system:git-sync'
          AND NOT (
            (
              metadata->'last_content_fixer'->>'status' = 'dispatched'
              AND COALESCE((metadata->'last_content_fixer'->>'at')::bigint, 0) > $4::bigint
            )
            OR (
              metadata->'last_content_fixer'->>'signature' = $5::text
              AND metadata->'last_content_fixer'->>'pass' = $6::text
            )
          )
        RETURNING true AS claimed`,
      [slug, workspaceId, JSON.stringify({ last_content_fixer: marker }), staleBefore, signature, pass],
    )) as Array<{ claimed?: boolean }>;
    return rows[0]?.claimed === true;
  } catch (e) {
    // Dedup is a safety rail. If its CAS cannot be established, leave the
    // quarantine visible and let a later tick retry instead of spawning blind.
    console.warn(`[git-sync] failed to claim content-fixer dispatch (${slug}): ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/**
 * Re-check the canonical content-detector registry against the current working
 * tree immediately before dispatch. Unknown cross-file guards (for example
 * unsafe-deletion) are retained: inability to re-prove them clean is not proof
 * that they disappeared.
 */
async function revalidateContentErrors(
  repoPath: string | null | undefined,
  contentErrors: readonly ScopedContentError[],
): Promise<ScopedContentError[]> {
  // Keep this temporary commit deferral in GitSyncOutcome, but never escalate or
  // dispatch it: no edit to the importer can release a live lock on its dependency.
  const fixerContentErrors = contentFixerEligibleErrors(contentErrors);
  if (!repoPath || fixerContentErrors.length === 0) return [...fixerContentErrors];
  const detectors = new Map(DEFAULT_CONTENT_DETECTORS.map((detector) => [detector.key, detector]));
  const root = resolve(repoPath);
  const checked = await Promise.all(
    fixerContentErrors.map(async (contentError) => {
      const detector = detectors.get(contentError.detectorKey);
      if (!detector) return contentError;
      const repo = resolve(root, contentError.scope === 'superproject' ? '.' : contentError.scope);
      const candidate = resolve(repo, contentError.file);
      if (candidate !== repo && !candidate.startsWith(`${repo}/`)) return contentError;
      let text: string;
      try {
        text = await readFile(candidate, 'utf8');
      } catch {
        // A gone/unreadable path may be a deletion/import guard finding. Keep
        // it quarantined rather than treating an unreadable file as clean.
        return contentError;
      }
      try {
        const inScope = await detector.matches(contentError.file, { repoPath: repo });
        if (!inScope) return null;
        const error = await detector.detect(contentError.file, text, { repoPath: repo });
        return error
          ? {
              ...contentError,
              error,
              contentHash: contentSnapshotHash(text),
              detectorResultHash: detectorResultHash(contentError.detectorKey, error),
            }
          : null;
      } catch {
        // The guard itself is fail-open during the commit path, but dispatch
        // revalidation fails closed so a detector failure cannot erase a real
        // quarantine from the escalation/fixer path.
        return contentError;
      }
    }),
  );
  return checked.filter((error): error is ScopedContentError => error !== null);
}

/**
 * Spawn a content-fixer via the invoke route (P-004) — fire-and-forget + observed,
 * the SAME shape as spawnMergeResolver. The fixer needs no git-sync lock: every
 * commit is gated by the content detector, so git-sync can never commit a
 * half-fixed file; the fixer just edits the named files and the next tick re-checks
 * + commits when they pass. It reads its file list from the `--git-sync-content-error`
 * extra (the open escalation is for human visibility, not the fixer's read path).
 */
async function spawnContentFixer(
  slug: string,
  workspaceId: string,
  contentErrors: ScopedContentError[],
  repoPath: string | null | undefined,
  pass: number,
): Promise<ScopedContentError[]> {
  // This is deliberately repeated after the action has released its git-sync
  // locks: the outcome handed to this post-leg can be stale by the time an
  // invoke request is created.
  const currentErrors = await revalidateContentErrors(repoPath, contentErrors);
  if (currentErrors.length === 0) {
    console.warn(`[git-sync] ${slug}: content-fixer dispatch suppressed — the canonical detector is clean`);
    return [];
  }
  // workspace-work-scope-policy-2026-09-04 P-008: quarantine still happens (staging
  // stays clean); only the fixer AGENT is withheld for an out-of-scope install.
  {
    const { gateWorkScope } = await import('../../work-scope-policy');
    const scope = await gateWorkScope('git-sync:content-fixer', { harness: slug });
    if (!scope.allowed) {
      console.warn(`[git-sync] ${slug}: content-fixer dispatch skipped — ${scope.message}`);
      return currentErrors;
    }
  }
  const target = await resolveLaunchTargetForEvent(CONTENT_ERROR_EVENT, { installSlug: slug, workspaceId });
  if (!target) {
    console.warn(`[git-sync] no launch blueprint declares "${CONTENT_ERROR_EVENT}" — skipping content-fixer dispatch`);
    return currentErrors;
  }
  const { url } = target;
  const files = currentErrors.map((c) => ({ scope: c.scope, file: c.file, detector: c.detectorKey, error: c.error }));
  const filePaths = files.map((f) => `${f.scope}/${f.file}`);
  const filesSummary = currentErrors.map((c) => `${c.scope}/${c.file} [${c.detectorKey}]: ${c.error}`).join('; ');
  const dispatchedAt = Date.now();
  // WI-37471: `unsafe-deletion` isn't a syntax fix (there's no syntax — the file
  // doesn't exist) and "restore vs. finish the deletion" is a judgment call about
  // intent the fixer cannot verify from the file system alone. Never tell it to
  // "fix the syntax" for this detectorKey — the persona's own rules escalate it.
  const hasUnsafeDeletion = currentErrors.some((c) => c.detectorKey === 'unsafe-deletion');
  const kickoffInstruction = hasUnsafeDeletion
    ? 'For each file: if its detector is `mdx` or `smart-quotes`, fix ONLY the flagged syntax; ' +
      'if its detector is `unsafe-deletion`, do NOT guess whether to restore the file or finish the ' +
      'deletion — escalate it per your persona\'s "when you cannot fix" instructions. ' +
      'Change nothing else, leave the tree clean, and do NOT push (the next git-sync tick re-checks + commits).'
    : 'Fix ONLY the syntax so each passes its detector, change nothing else, leave the tree clean, and do NOT push (the next git-sync tick re-checks + commits).';

  const dispatchMarker = {
    at: dispatchedAt,
    status: 'dispatched',
    files: filePaths,
    signature: contentFixerSignature(currentErrors),
    pass,
    instance: PROCESS_INSTANCE_ID,
  } satisfies ContentFixerMarker;
  // Fast path for the common in-flight case; the atomic claim below remains
  // mandatory because two fires can race between this read and the write.
  if (await contentFixerInFlight(slug, workspaceId)) return currentErrors;
  if (!(await claimContentFixerDispatch(slug, workspaceId, dispatchMarker))) return currentErrors;
  console.warn(`[git-sync] ${slug}: ${currentErrors.length} content error(s) quarantined — dispatching content-fixer`);

  const logSettle = (status: 'ok' | 'failed' | 'error', extra: Record<string, unknown>): Promise<void> =>
    appendPipelineEvent({
      workspaceId,
      installSlug: slug,
      kind: 'content_fixer',
      status,
      detail: { files: filePaths, ...extra },
    });

  // (2) async result recording. Fire-and-forget — never awaited inside the routine step.
  loopbackFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kickoff:
        `Fix the git-sync content-guard quarantine in ${slug}: ${files.length} file(s) fail their content detector and were EXCLUDED from the auto-commit so staging stays clean. ` +
        `${kickoffInstruction} Files: ${filesSummary}`,
      extra: ['--git-sync-content-error', JSON.stringify({ files })],
      // A small, mechanical syntax fix scoped to the named files — well under the
      // invoke route's 1200s ceiling. RESOLVER_INFLIGHT_MS (20 min) exceeds this so a
      // still-running fixer is never double-dispatched.
      timeoutMs: 600_000,
    }),
  })
    .then(async (res) => {
      let exitCode: number | undefined;
      let timedOut: boolean | undefined;
      let detail = '';
      try {
        const j = (await res.json()) as {
          ok?: boolean;
          exitCode?: number;
          timedOut?: boolean;
          stderr?: string;
          decisionLine?: string;
        };
        exitCode = j?.exitCode;
        timedOut = j?.timedOut;
        if (j?.ok === false) detail = (j.decisionLine || j.stderr || '').slice(0, 400);
        const settled = res.ok && j?.ok !== false ? 'ok' : 'failed';
        await recordContentFixerDispatch(slug, workspaceId, {
          ...dispatchMarker,
          status: settled,
          httpStatus: res.status,
          exitCode,
          timedOut,
          detail,
        });
        await logSettle(settled, { httpStatus: res.status, exitCode, timedOut, detail });
      } catch {
        const settled = res.ok ? 'ok' : 'failed';
        await recordContentFixerDispatch(slug, workspaceId, {
          ...dispatchMarker,
          status: settled,
          httpStatus: res.status,
        });
        await logSettle(settled, { httpStatus: res.status });
      }
    })
    .catch(async (e) => {
      // Preserve undici's underlying transport code (for example
      // `UND_ERR_SOCKET`) instead of persisting only the opaque `fetch failed`
      // message. The fixer marker is the live diagnostic used to distinguish
      // an egress failure from a repair that ran and failed its tests.
      const msg = describeFetchError(e);
      console.warn(`[git-sync] content-fixer dispatch failed (${slug}): ${msg}`);
      await recordContentFixerDispatch(slug, workspaceId, {
        ...dispatchMarker,
        status: 'error',
        error: msg.slice(0, 300),
      });
      await logSettle('error', { error: msg.slice(0, 300) });
    });
  return currentErrors;
}

/** EI-18775478513129278: the shape of a previously-recorded `bootstrap` metadata
 *  record, read back when a tick has no fresh `outcome` of its own so the durable
 *  on-disk-progress fields (namespaceCount/quarantineRefs/phase/shallow/deepenNext)
 *  can be carried forward instead of clobbered with 0/null. Loosely typed (every
 *  field optional/unknown-ish) because it comes back from `metadata->'bootstrap'`
 *  jsonb written by whatever build wrote the prior tick — never assume its shape. */
interface PriorBootstrapMeta {
  phase?: string | null;
  quarantineRefs?: number;
  shallow?: boolean | null;
  deepenNext?: number | null;
  namespaceCount?: number;
  // WI-37226: the RUN-LENGTH of consecutive dial misses, and when the current run
  // started. The miss warning below has always ended "persistent misses across many
  // ticks are the real signal" — and nothing counted them, so the one signal the log
  // names as real was the one thing it could not show. A single miss is noise (a
  // churning hello channel de-registers between ticks); a sustained run is not.
  consecutiveMisses?: number;
  firstMissAt?: number | null;
}

/** Read the `bootstrap` record a PRIOR tick wrote for this install.
 *
 *  Split out of the dial writer (WI-37226) because the no-topic-stub writer needs the
 *  same read: `patchRoutineMetadata` replaces the WHOLE `bootstrap` key, so any writer
 *  that omits a field DELETES it. That is not hypothetical here — it is the documented
 *  hazard at the stub writer (WI-6284) and the tick-to-tick field erasure of
 *  EI-18799556647570956. A miss-run counter is exactly the kind of field that would be
 *  silently zeroed by the other writer and read as "the run ended".
 */
async function readPriorBootstrapMeta(slug: string, workspaceId: string): Promise<PriorBootstrapMeta | null> {
  const { sql } = getOrgPg();
  const rows = await sql<{ bootstrap: PriorBootstrapMeta | null }[]>`
    SELECT metadata->'bootstrap' AS bootstrap
      FROM harness_shared.routines
     WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
     LIMIT 1
  `;
  return rows[0]?.bootstrap ?? null;
}

/** Consecutive dial misses before the miss warning ESCALATES.
 *
 *  Deliberately not 1: the miss log itself documents that one miss proves nothing about
 *  reachability. At the observed ~10-minute git-sync cadence this is ~an hour of an
 *  install making zero progress, which is no longer explicable as hello-channel churn.
 *  The escalation reports WALL-CLOCK duration alongside the count, so the message stays
 *  meaningful if the cadence ever changes and the count stops standing in for time.
 */
const BOOTSTRAP_PERSISTENT_MISS_THRESHOLD = 6;

/** A bounded forensic record for one completed git-sync tick. */
interface GitSyncHistoryEntry {
  ts: number;
  status: GitSyncOutcome['status'];
  dirty_path_count: number;
  committed_count: number;
  error: string | null;
  reaped: false;
  /** P-009 (ex-P-028, WI-10002596): what THIS tick withheld from its commit. The `last_*`
   *  fields are overwritten every tick, so on their own they cannot show that one file was
   *  held back for 18 ticks in a row, or that a path was locked out across one sweep then
   *  swept on the next. Paths are capped per entry; the counts are exact. */
  excluded: {
    locked_paths: string[];
    locked_count: number;
    oversized_count: number;
    bulk_count: number;
    quarantined: string[];
    quarantined_count: number;
  };
}

const GIT_SYNC_HISTORY_LIMIT = 30;
/** Per-entry path cap for `GitSyncHistoryEntry.excluded`, so 30 entries stay bounded. */
export const GIT_SYNC_HISTORY_EXCLUDED_PATHS_CAP = 20;

/** Merge a partial metadata patch onto the git-sync routine's JSONB.
 *
 *  The `workspace_id` predicate is LOAD-BEARING, not defensive: `install_slug` is NOT
 *  unique across workspaces, so an unscoped UPDATE here is UNBOUNDED — with N workspaces
 *  holding the same install slug, one tick overwrites all N tenants' routine metadata
 *  with this tenant's state, and that metadata is what `bootstrap.ok`/`bootstrap.converged`
 *  are read from (EI-18799539619330782).
 *
 *  Param order deliberately matches the signature ($1 slug, $2 workspaceId, $3 patch) —
 *  do not "simplify" workspaceId to a trailing $3 to avoid re-indexing test assertions.
 *
 *  NUL bytes are stripped before serialising: JSONB rejects \u0000 (22P05), so one NUL in
 *  any string — a git message, a path, a signature — failed the WHOLE write, and with it
 *  every leg after recordOutcome (EI-24099226502437988). */
async function patchRoutineMetadata(
  slug: string,
  workspaceId: string,
  rawPatch: GitSyncRoutineMetadataPatch,
  rawHistoryEntry?: GitSyncHistoryEntry,
): Promise<void> {
  const { sql } = getOrgPg();
  const { value: patch, stripped: patchStripped } = stripNulBytesDeep(rawPatch);
  const { value: historyEntry, stripped: historyStripped } = stripNulBytesDeep(rawHistoryEntry);
  if (patchStripped || historyStripped) {
    console.warn(`[git-sync] ${slug}: stripped NUL byte(s) from a routine metadata patch (JSONB rejects \\u0000)`);
  }
  if (historyEntry) {
    // Keep the latest metadata patch and the bounded history append in ONE UPDATE.
    // Reading the old array and appending inside the same row update prevents two
    // concurrent metadata writers from losing a tick. Invalid/legacy history values
    // are treated as empty rather than making the routine writer fail.
    await sql.unsafe(
      `UPDATE harness_shared.routines
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb || jsonb_build_object(
                    'git_sync_history',
                    COALESCE((
                      SELECT jsonb_agg(item ORDER BY ord)
                        FROM (
                          SELECT item, ord
                            FROM jsonb_array_elements(
                              (CASE
                                 WHEN jsonb_typeof(metadata->'git_sync_history') = 'array'
                                   THEN metadata->'git_sync_history'
                                 ELSE '[]'::jsonb
                               END) || jsonb_build_array($4::jsonb)
                            ) WITH ORDINALITY AS history(item, ord)
                           ORDER BY ord DESC
                           LIMIT ${GIT_SYNC_HISTORY_LIMIT}
                        ) AS retained
                    ), '[]'::jsonb)
                  ),
              updated_at = now()
        WHERE install_slug = $1 AND workspace_id = $2 AND target_role = 'system:git-sync'`,
      [slug, workspaceId, JSON.stringify(patch), JSON.stringify(historyEntry)],
    );
    return;
  }
  await sql.unsafe(
    `UPDATE harness_shared.routines
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb, updated_at = now()
      WHERE install_slug = $1 AND workspace_id = $2 AND target_role = 'system:git-sync'`,
    [slug, workspaceId, JSON.stringify(patch)],
  );
}

type GitSyncActivityPhase = 'local-sync' | 'post-legs' | 'completion-settlement' | 'complete' | 'error';
type GitSyncSettlementProgress = {
  completed: number;
  total: number;
  feature_id: string;
};
type GitSyncActivityMarker = {
  active: boolean;
  phase: GitSyncActivityPhase;
  started_at: number;
  updated_at: number;
  completed_at: number | null;
  outcome_status: GitSyncOutcome['status'] | null;
  /** The per-fire lock owner ties this durable marker back to the live resource lease. */
  owner: string;
  owner_pid: number;
  settlement_progress?: GitSyncSettlementProgress;
  /** EI-24496143892913296: the post-legs leg that just started (e.g. 'git-sync:ref-announce'). */
  leg?: string;
};
type GitSyncActivityFields = Omit<GitSyncActivityMarker, 'owner' | 'owner_pid'>;

/**
 * Writer-backed liveness for the whole git-sync action, not just its local commit
 * stage. `recordOutcome` runs before the GitHub bridge and P2P legs, so
 * `last_status: 'synced'` alone is deliberately not terminal evidence. Keep every
 * field in this object on every write: `patchRoutineMetadata` is a top-level JSONB
 * merge and nested omission would otherwise silently erase the marker's state.
 */
async function writeGitSyncActivity(
  slug: string,
  workspaceId: string,
  activity: GitSyncActivityMarker,
): Promise<void> {
  await patchRoutineMetadata(slug, workspaceId, { git_sync_activity: activity });
}

async function recordOutcome(
  slug: string,
  workspaceId: string,
  outcome: GitSyncOutcome,
  consecutiveErrorTicks: number,
  consecutiveContentErrorTicks: number,
  /** EI-18812945811758018: 'push' | 'commit-only:<reason>' — see effectivePushMode. */
  pushMode: string,
  /** EI-21230011589307899: the own-head-publish freeze point THIS tick's escalation
   *  decision acted on, persisted so the NEXT tick can tell a new freeze from a
   *  persisting one and broadcast only on the transition. */
  publishBlockedAtCommit: string | null,
  /** EI-21906459740652039: consecutive ticks the cumulative-limit guard has peeled,
   *  persisted so the next tick can tell a CHRONIC peel from a one-off one. */
  consecutiveCumulativePeelTicks: number,
): Promise<void> {
  const pushed = 'pushed' in outcome ? outcome.pushed : [];
  const merged = 'merged' in outcome ? outcome.merged : [];
  const mergeCompleted = outcome.mergeCompleted ?? [];
  // errors[] exists on both 'conflict' and 'error' outcomes — record it ALWAYS so a
  // sibling (sub)repo error on a conflict tick isn't invisible (it was: a non-error
  // status used to drop the error list entirely, e.g. a libs/papercusp push failure
  // hidden behind a libs/generic/sync conflict).
  const errors = 'errors' in outcome ? outcome.errors : [];
  const errorMessage = errors.map((e) => `${e.scope}: ${e.message}`).join('; ');
  const skippedPaths = outcome.skippedPaths ?? [];
  // Keep the public outcome's complete quarantine union for the commit/escalation
  // pipeline, but persist the two byte-guard families separately. `bulkExcluded`
  // is supplied by runGitSync; the reason-based fallback keeps injected callers
  // and older checkpoint payloads compatible.
  const bulkExcluded = (
    outcome.bulkExcluded ?? outcome.oversized.filter((f) => f.exclusionReason === 'cumulative-limit')
  ).filter((f) => f.exclusionReason === 'cumulative-limit');
  const oversized = outcome.oversized.filter((f) => f.exclusionReason !== 'cumulative-limit');
  // Keep every excluded path visible in the public outcome, but only count real
  // content failures against the fixer budget. A quarantined importer is a
  // temporary atomicity deferral that clears when its dependency can publish.
  const fixerContentErrors = contentFixerEligibleErrors(outcome.contentErrors);
  // A local commit can still be valid while the content guard leaves dirty files
  // out of it.  Do not publish that partial success as plain `synced`: the routine
  // headline is the first health signal most callers read.  Keep the precise local
  // outcome in `local_sync_status` and the file-level evidence in
  // `last_content_errors`; this status only makes the quarantine impossible to miss.
  const recordedStatus =
    outcome.contentErrors.length > 0 && (outcome.status === 'synced' || outcome.status === 'nothing')
      ? 'quarantined'
      : outcome.status;
  const localSyncRecordedAt = Date.now();
  await patchRoutineMetadata(
    slug,
    workspaceId,
    {
      last_status: recordedStatus,
      last_synced_at: localSyncRecordedAt,
      // EI-21647996938145436: this is a write-time receipt from the process that
      // actually ran the routine, not a re-derived checkout HEAD. The boot-time
      // runtime-vintage row answers the same question at host start; keeping this
      // marker on every outcome also covers long-lived ticks and stale-bundle
      // diagnosis when the boot report was missing or identity-less.
      loaded_build_identity: loadedBuildIdentity(localSyncRecordedAt),
      // EI-20315742298217655: the github-bridge leg runs after this write and may
      // promote an owner-actionable egress failure into the top-level last_status /
      // last_error fields. Keep the local commit stage explicit so readers can still
      // distinguish a clean/local commit result from a bridge-only failure. The head
      // value is sticky, just like the legacy head_sha field: only a new local commit
      // writes it, while nothing/error/conflict ticks preserve the last observed head.
      local_sync_status: outcome.status,
      // A tick with no locked-path exclusions supersedes any earlier lock skip.
      // JSONB patches are additive, so leaving these fields untouched makes a later
      // `synced` tick look contradictory (`last_status: synced` alongside an old
      // `last_skip_reason: locked-path`). Preserve the paths even when the unlocked
      // remainder synced: partial progress is useful evidence and is exactly the
      // case where a holder otherwise cannot tell that their file is still stranded.
      last_skip_reason: skippedPaths.length > 0 ? 'locked-path' : null,
      last_skipped_at: skippedPaths.length > 0 ? localSyncRecordedAt : null,
      last_skipped_paths: skippedPaths,
      last_pushed: pushed,
      // EI-18812945811758018: rides the SAME single write, so `last_pushed` is never
      // readable without the mode that says what an empty one MEANS for this member.
      push_mode: pushMode,
      last_merged: merged,
      // A successful merge stage is stronger evidence than `last_merged` (which only
      // reports a merge commit). Clear the proof on every tick that did not earn it so
      // a later reader can never mistake an old merge for this tick's evidence.
      last_merge_completed: mergeCompleted,
      last_merge_completed_at: mergeCompleted.length > 0 ? localSyncRecordedAt : null,
      last_conflicts: outcome.status === 'conflict' ? outcome.conflicts.map((c) => c.scope) : [],
      last_errors: errors.map((e) => `${e.scope}: ${e.message}`),
      // GAP-3: clear the stale single error on any non-error outcome (JSONB `||` keeps old keys).
      last_error: outcome.status === 'error' ? errorMessage : null,
      // EI-18 counters: ticks-of-uninterrupted-error + the true per-file oversized
      // set (scope:path keys). Cumulative-budget victims have a distinct field so a
      // reader cannot tell an individually-unpushable blob to "raise the total cap"
      // or vice versa.
      consecutive_error_ticks: consecutiveErrorTicks,
      last_oversized: oversized.map(oversizedKey),
      last_bulk_excluded: bulkExcluded.map(oversizedKey),
      // Both exclusion arrays are replaced on every completed outcome. This stamp
      // lets readers distinguish the latest measured sweep from legacy/stale rows
      // that only carried last_oversized.
      last_exclusions_at: localSyncRecordedAt,
      // EI-21906459740652039: the cumulative-limit guard's own consecutive-tick counter.
      // `last_oversized` alone cannot answer "has this been peeled every tick for hours?",
      // which is the condition that ran 13h unnoticed.
      consecutive_cumulative_peel_ticks: consecutiveCumulativePeelTicks,
      last_publish_blocked_at: publishBlockedAtCommit,
      // EI-438 content-guard counters: consecutive ticks with a quarantined file + the set.
      consecutive_content_error_ticks: consecutiveContentErrorTicks,
      last_content_errors: outcome.contentErrors.map((c) => `${c.scope}/${c.file} [${c.detectorKey}]`),
      last_content_error_signature:
        fixerContentErrors.length > 0 ? contentFixerSignature(fixerContentErrors) : null,
      // A measured-clean pass invalidates the prior dispatch identity. This is
      // intentionally in the same outcome write as the clean detector result.
      ...(fixerContentErrors.length === 0 ? { last_content_fixer: null } : {}),
      // WI-1416: a COMPLETED fire resets the consecutive-reap counter the executor
      // reaper increments on each cancel+requeue — so `reaped_count` reads as "reaps
      // since the last completed fire" (the git-sync-stall-watchdog's persistent-reap
      // signal), never a forever-growing total.
      reaped_count: 0,
      ...(outcome.status === 'synced' ? { head_sha: outcome.headSha, local_sync_head_sha: outcome.headSha } : {}),
    },
    {
      ts: localSyncRecordedAt,
      status: outcome.status,
      dirty_path_count: outcome.dirtyPathCount,
      committed_count: outcome.committedCount,
      error: errorMessage || null,
      reaped: false,
      excluded: {
        // `scope:path`, the same key shape as last_oversized / last_bulk_excluded.
        locked_paths: skippedPaths.slice(0, GIT_SYNC_HISTORY_EXCLUDED_PATHS_CAP).map((p) => `${p.scope}:${p.path}`),
        locked_count: skippedPaths.length,
        oversized_count: oversized.length,
        bulk_count: bulkExcluded.length,
        quarantined: outcome.contentErrors
          .slice(0, GIT_SYNC_HISTORY_EXCLUDED_PATHS_CAP)
          .map((c) => `${c.scope}:${c.file}`),
        quarantined_count: outcome.contentErrors.length,
      },
    },
  );
}

/**
 * WI-3072: recurrence guard for the EI-7685 class — an agent ran `git stash` on the
 * shared canonical staging tree (or a submodule) and it sat there silently, LOOKING
 * like vanished/reverted work to every other agent (git-sync only ever commits the
 * WORKING TREE; it never sees, let alone recovers, a stash). Detect any stash entry
 * NOT in the known baseline and broadcast loudly — a silent-fleet-work-vanish
 * detector, not a fix (stashing is sometimes deliberate; this only makes it VISIBLE).
 *
 * Deliberately outside the commit/push pipeline: PURELY ADDITIVE, read-only
 * (`git stash list`, never `pop`/`drop`/`apply`), and must NEVER throw or block a
 * commit/push — a detection failure here is silently skipped, not surfaced as a
 * sync error (this is a courtesy alert, not a safety gate). The known-SHA baseline
 * persists on the routine's own metadata (`known_stash_shas`), the same
 * `patchRoutineMetadata` mechanism `recordOutcome` already uses for
 * `last_pushed`/`last_conflicts` — no new table (reuse-first).
 */
async function checkForNewStashes(slug: string, workspaceId: string, superRepoPath: string): Promise<void> {
  try {
    const runGit: RunGit = (args, cwd) => runGitBounded(args, cwd, gitTimeoutMsFor(args));
    const subPaths = await discoverSubmodulesRecursive(runGit, superRepoPath);
    const repos: { scope: string; path: string }[] = [
      { scope: 'superproject', path: superRepoPath },
      ...subPaths.map((s) => ({ scope: s, path: join(superRepoPath, s) })),
    ];

    const { sql } = getOrgPg();
    const [row] = await sql<{ known: unknown }[]>`
      SELECT metadata->'known_stash_shas' AS known
        FROM harness_shared.routines
       WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
       LIMIT 1`;
    // EI-19449313204576061 — THE ROOT CAUSE. `metadata->'known_stash_shas'` returns SQL
    // NULL when the key has never been written, which is a categorically different fact
    // from "the baseline was recorded and it was empty". Collapsing both into `[]` made
    // the FIRST observation report every pre-existing stash as 🚨 NEW — which is exactly
    // what happened on 2026-08-03, broadcasting two stashes aged 12 and 13 WEEKS to the
    // whole fleet, with `git stash pop`/`drop` as the implied remedy on a shared tree
    // holding a peer's 36-file, +2205/-804 stash. The detector never observed those
    // stashes being created; it inferred "new" from the absence of its own baseline.
    const baselineRecorded = row !== undefined && row.known !== null && row.known !== undefined;
    const knownShas = Array.isArray(row?.known)
      ? (row.known as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];

    const allShas: string[] = [];
    const fresh: { scope: string; sha: string; subject: string; createdAt: string }[] = [];
    for (const r of repos) {
      const entries = await listStashEntries(runGit, r.path);
      for (const e of entries) allShas.push(e.sha);
      for (const e of newStashEntries(entries, knownShas)) fresh.push({ scope: r.scope, ...e });
    }

    // First observation ever: SEED the baseline silently. Anything present now predates
    // the detector, so there is nothing it can honestly call new.
    if (!baselineRecorded) {
      await patchRoutineMetadata(slug, workspaceId, { known_stash_shas: allShas });
      if (allShas.length > 0) {
        console.warn(
          `[git-sync] ${slug}: stash baseline BOOTSTRAPPED with ${allShas.length} pre-existing ` +
            `entr${allShas.length === 1 ? 'y' : 'ies'} — not alerting (a first observation cannot ` +
            `establish that anything is new). Future entries will diff against this baseline.`,
        );
      }
      return;
    }

    // Persist the CURRENT set every tick (not an ever-growing history) — a stash later
    // popped/dropped and never recreated should not linger in the baseline forever, and
    // an identical-content stash re-pushed after a drop legitimately re-alerts (it IS a
    // new event worth re-surfacing, not noise).
    await patchRoutineMetadata(slug, workspaceId, { known_stash_shas: allShas });
    if (fresh.length === 0) return;

    const nowMs = Date.now();
    const { recent, preExisting } = partitionStashEntriesByAge(fresh, nowMs);
    const describe = (e: (typeof fresh)[number]) =>
      `${e.scope}: ${e.sha.slice(0, 8)} (${describeStashAge(e, nowMs)}) "${e.subject.slice(0, 80)}"`;

    // Newly-VISIBLE but old entries are not an emergency and must never carry the
    // pop/drop prompt — a false urgency pointed at a destructive op on a shared tree is
    // worse than silence, and crying wolf trains agents to ignore the real signal.
    if (preExisting.length > 0) {
      console.warn(
        `[git-sync] ${slug}: ${preExisting.length} previously-unseen but PRE-EXISTING stash ` +
          `entr${preExisting.length === 1 ? 'y' : 'ies'} (older than 24h — NOT new work, no action implied): ` +
          `${preExisting.map(describe).join('; ')}`,
      );
    }
    if (recent.length === 0) return;

    const context =
      preExisting.length > 0
        ? ` (plus ${preExisting.length} older pre-existing entr${preExisting.length === 1 ? 'y' : 'ies'}, not counted above)`
        : '';
    const summary =
      `🚨 NEW git-stash entry on the canonical ${slug} tree (${recent.length})${context} — a stash HIDES ` +
      `uncommitted work from every agent (git-sync only ever commits the working tree, never a stash). ` +
      `INSPECT FIRST: 'git stash show --stat <sha>' (read-only) in the affected repo. Do NOT reflexively ` +
      `'stash pop'/'drop' — this checkout is shared, the stash is very likely a PEER's in-flight work, and ` +
      `popping it into a tree you don't own is the destructive-git-op class CLAUDE.md forbids. Recovery is ` +
      `the stash owner's call. ${recent.map(describe).join('; ')}`;
    console.warn(`[git-sync] ${slug}: ${summary}`);
    await sendMessage(GIT_SYNC_IDENTITY, { to: ['*'], summary, category: 'git-sync' }).catch(() => {});
  } catch (e) {
    console.warn(
      `[git-sync] ${slug}: stash-check failed (non-fatal, best-effort, never blocks the sync): ${e instanceof Error ? e.message : e}`,
    );
  }
}

// ── Runtime eligibility gate (git-sync-any-hive P-008, action half) ─────────────

/**
 * Belt-and-braces gate before the pipeline runs: a routine row pointing at a hive
 * HOME (non-repo state dir), a joiner-side remote-hive VIEW, a non-local
 * deployment, or a vanished / non-git checkout must NO-OP (logged + recorded as
 * skipped) instead of error-escalating every 10 minutes. The verdict (including
 * the on-disk vanished-checkout / missing-.git checks) is B-01's
 * `gitSyncEligibility` — the SAME module the seed sites consult, so seed time
 * and run time can never disagree on the vocabulary. Best-effort: an unreadable
 * registry FAILS OPEN (the pipeline's own path resolution will surface the error).
 */
async function gitSyncRuntimeGate(
  slug: string,
  workspaceId: string,
  repoPathOverride?: string | null,
): Promise<{ gate: GitSyncEligibility; entry?: ProjectEntry }> {
  let entry: ProjectEntry | undefined;
  try {
    entry = (await loadHarnessRegistry(workspaceId)).projects.find((p) => p.slug === slug);
  } catch (e) {
    console.warn(
      `[git-sync] ${slug}: registry unreadable for the eligibility gate — proceeding: ${e instanceof Error ? e.message : e}`,
    );
    return { gate: { eligible: true } };
  }
  // A vanished registry entry reads the same as a vanished checkout: no path.
  if (!entry) return { gate: { eligible: false, reason: 'no_path' } };
  // A manual fire pins the exact tree it measured before entering the action.
  // Validate that pinned path rather than silently gating a freshly-resolved
  // sibling checkout if the ambient registry changes underneath the call.
  const gatedEntry = repoPathOverride === undefined ? entry : { ...entry, path: repoPathOverride ?? '' };
  return { gate: gitSyncEligibility(gatedEntry), entry: gatedEntry };
}

/** P-004/P-006: build the live attribution roster (active agents + their declared files) from
 *  coord presence. Best-effort — a presence-read failure degrades to [] (no attribution). The lazy
 *  import breaks a load-time cycle (git-sync-action is loaded by the system-action registry). */
async function loadAttributionRoster(workspaceId: string | null): Promise<AttributionRosterEntry[]> {
  return (await loadPresenceAttribution(workspaceId)).roster;
}

/**
 * ONE presence read, TWO derived views (WI-37668).
 *
 * `roster` keeps the historical semantics: only agents that declared `current_files`, because an
 * entry with no files can attribute nothing.
 *
 * `declaredIntentByAgent` deliberately spans ALL live agents, files or not — it supplies a commit
 * SUBJECT, which needs no declared files to be meaningful. Deriving it from the FILTERED roster
 * was a real bug (caught on the live hot path 2026-08-10): the ledger's whole purpose is to
 * attribute agents who never declared files, and those are exactly the agents the filter drops —
 * so every sentinel intent fell through to the default subject and the recovery never fired.
 */
async function loadPresenceAttribution(
  workspaceId: string | null,
): Promise<{ roster: AttributionRosterEntry[]; declaredIntentByAgent: Map<string, string> }> {
  try {
    const { listPresence } = await import('../../agent-tools/coordination/presence');
    const recs = await listPresence({ workspaceId });
    const declaredIntentByAgent = new Map<string, string>();
    for (const r of recs) {
      const declared = (r.intent ?? '').trim();
      if (!isGenericLockIntent(declared) && !declaredIntentByAgent.has(r.ownerId)) {
        declaredIntentByAgent.set(r.ownerId, declared);
      }
    }
    const roster = recs
      .map((r) => ({
        agent: r.ownerId,
        agentLabel: r.ownerLabel ?? undefined,
        intent: r.intent ?? undefined,
        files: Array.isArray(r.currentFiles) ? r.currentFiles : [],
      }))
      .filter((e) => e.files.length > 0);
    return { roster, declaredIntentByAgent };
  } catch {
    return { roster: [], declaredIntentByAgent: new Map() };
  }
}

/**
 * A ledger `intent` that is really the LOCK HOOK'S OWN NAME, not a declared intent (WI-37668).
 *
 * The automatic per-edit file-lock hook acquires with `intent: f'PreToolUse:{tool_name}'`
 * (~/.papercusp/hooks/cc/pretooluse-locks-acquire.sh), and locks:acquire persists that verbatim
 * into the edit ledger. It is a lifecycle label, never a description of the work — and since it
 * is non-empty, `intentToSubject` would happily render it as a commit SUBJECT
 * ("PreToolUse:Edit (su · su-1bf26)"). Measured 2026-08-10: 3,180 of ~3,260 ledger rows in the
 * last 24h (97.5%) carry exactly this sentinel, so ungated it would be the subject of nearly
 * every attributed commit — strictly worse than the single `chore(git-sync): auto-commit`
 * it replaces, on the fleet-wide commit hot path.
 *
 * Treating it as ABSENT (so the agent's declared coord intent wins, else the default subject)
 * is the same precedent the lock hook already applies to its own blocked-peer message:
 * `intent = b.get('holder_intent') or b.get('intent')` — declared intent first, generic second.
 */
const GENERIC_LOCK_INTENT_RE = /^(?:Pre|Post)ToolUse:/i;

/** True when a roster `intent` is the lock hook's lifecycle label rather than declared work. */
export function isGenericLockIntent(intent: string | undefined | null): boolean {
  const line = (intent ?? '').trim();
  return line.length === 0 || GENERIC_LOCK_INTENT_RE.test(line);
}

/**
 * WI-37668: merge the ledger + presence rosters, recovering a real commit SUBJECT for ledger
 * entries whose `intent` is only the lock hook's sentinel.
 *
 * The ledger stays authoritative for WHICH FILES belong to WHICH AGENT (durable — it outlives
 * the session, which is the whole point of D-002); presence is consulted ONLY to supply the
 * agent's declared intent when the ledger's is a generic label. An agent with no usable intent
 * on either side yields `undefined`, which `intentToSubject` renders as
 * DEFAULT_GIT_SYNC_SUBJECT — today's message, never the sentinel.
 *
 * Pure + exported so the subject-recovery rule is guarded directly.
 */
export function mergeAttributionRosters(
  ledger: AttributionRosterEntry[],
  presence: AttributionRosterEntry[],
  /** Agent → declared intent, spanning ALL live agents (see loadPresenceAttribution). Omitted ⇒
   *  derived from `presence`, which is correct only when that array is itself unfiltered. */
  declaredIntents?: Map<string, string>,
): AttributionRosterEntry[] {
  const declaredIntentByAgent = declaredIntents ?? new Map<string, string>();
  if (!declaredIntents) {
    for (const p of presence) {
      const declared = (p.intent ?? '').trim();
      if (!isGenericLockIntent(declared) && !declaredIntentByAgent.has(p.agent)) {
        declaredIntentByAgent.set(p.agent, declared);
      }
    }
  }
  const repaired = ledger.map((e) => ({
    ...e,
    intent: isGenericLockIntent(e.intent) ? declaredIntentByAgent.get(e.agent) : e.intent?.trim(),
  }));
  return [...repaired, ...presence];
}

/** P-003 (deterministic-commit-workitem-attribution-2026-06-22): the attribution roster,
 *  preferring the DURABLE edit ledger (keyed by workspace) over live presence — so a commit is
 *  attributed even after the editing agent's session ended (D-002), and carries the work-item(s)
 *  it was claimed under. Ledger entries come FIRST so attributionMapForRepo's first-wins gives
 *  them priority; presence fills any files the ledger window missed (and supplies agentLabels).
 *  Best-effort throughout: a ledger-read failure degrades to presence, exactly as before. */
async function loadAttributionRosterMerged(workspaceId: string | null): Promise<AttributionRosterEntry[]> {
  let ledger: AttributionRosterEntry[] = [];
  try {
    // WI-37668: scope the ledger read by WORKSPACE, not by this repo's root. `repo_root` in the
    // ledger is the lock coordination domain (the repo root of whichever operator process served
    // locks:acquire), not the repo the edited files live in — keying on it matched zero rows and
    // made this whole flag inert. See readEditAttributionRoster's doc comment.
    const { readEditAttributionRoster } = await import('../../edit-attribution');
    ledger = (await readEditAttributionRoster({ workspaceId })).map((e) => ({
      agent: e.agent,
      intent: e.intent,
      files: e.files,
      workItems: e.workItems,
      planSlug: e.planSlug,
      sessionId: e.sessionId,
    }));
  } catch {
    /* best-effort: fall through to presence */
  }
  const { roster, declaredIntentByAgent } = await loadPresenceAttribution(workspaceId);
  return mergeAttributionRosters(ledger, roster, declaredIntentByAgent);
}

/** P-006 (assign-don't-broadcast / F5): recipients for a content-guard escalation — the agents who
 *  declared the quarantined files (ASSIGNED, not a fleet broadcast). Returns ['*'] when derived
 *  attribution is OFF or nothing matched, so it degrades to today's broadcast. Gated on the same
 *  GIT_SYNC_DERIVED_ATTRIBUTION flag as P-004 (both DERIVE who from presence). */
async function assigneesForContentErrors(
  slug: string,
  workspaceId: string | null,
  contentErrors: ScopedContentError[],
): Promise<string[]> {
  try {
    if (!(await getFlag(FLAGS.GIT_SYNC_DERIVED_ATTRIBUTION, slug))) return ['*'];
    const roster = await loadAttributionRoster(workspaceId);
    // Resolve the superproject root so absolute current_files normalize to repo-relative (lazy
    // import to keep the registry load-graph acyclic, like loadAttributionRoster's presence read).
    const { projectDirForSlug } = await import('../../operator-notes');
    const superRoot = (await projectDirForSlug(slug, workspaceId ?? undefined)) ?? undefined;
    const agents = agentsForScopedFiles(
      roster,
      contentErrors.map((c) => ({ scope: c.scope, file: c.file })),
      superRoot,
    );
    return agents.length ? agents : ['*'];
  } catch {
    return ['*'];
  }
}

/** P-009 / WI-10002596: the lock-plane prefix of a nested install (see nestedInstallRepoPrefix).
 *  The parent install's project dir is the authority; a failed lookup falls back to the
 *  slug tail, which is accepted only when the repo path actually ends with it. */
async function nestedInstallLockPrefix(
  slug: string,
  workspaceId: string | null,
  repoPath: string | null | undefined,
): Promise<string> {
  const slash = slug.indexOf('/');
  if (slash <= 0 || !repoPath) return '';
  let parentRoot: string | null = null;
  try {
    const { projectDirForSlug } = await import('../../operator-notes');
    parentRoot = (await projectDirForSlug(slug.slice(0, slash), workspaceId ?? undefined)) ?? null;
  } catch {
    parentRoot = null;
  }
  return nestedInstallRepoPrefix(slug, repoPath, parentRoot);
}

/** EI-24649116564770033: bound for each `rev-list`/`rev-parse` identity probe of a lock domain. */
const LOCK_DOMAIN_IDENTITY_TIMEOUT_MS = 10_000;

/**
 * EI-24649116564770033: the canonical root that lock paths are translated into — the
 * top-level repository (the parent, for a nested install). Lock domains are realpaths,
 * so the anchor is too. Null when there is no repo path: rows are then used unchanged.
 */
async function lockCoordinateAnchor(
  repoPath: string | null | undefined,
  nestedPrefix: string,
): Promise<string | null> {
  if (!repoPath) return null;
  const anchor = nestedPrefix
    ? resolve(repoPath, ...nestedPrefix.split('/').filter(Boolean).map(() => '..'))
    : resolve(repoPath);
  try {
    return await realpath(anchor);
  } catch {
    return anchor;
  }
}

/** P-009 (EI-24015486799447670): recipients for a content-quarantine notice. Attribution
 *  (above) plus the liveness oracle, so an alarm is never addressed only to an ended
 *  session. The selection rule lives in `selectContentNoticeRecipients` (unit-tested).
 *  Liveness is bounded and best-effort: a failed read leaves states unknown, which
 *  makes an alarm fall back to the broadcast rather than go silent. */
async function contentNoticeRecipients(
  slug: string,
  workspaceId: string | null,
  contentErrors: ScopedContentError[],
  notice: ContentQuarantineNotice,
): Promise<string[]> {
  const editors = await assigneesForContentErrors(slug, workspaceId, contentErrors);
  const attributed = editors.filter((e) => e !== '*');
  const states = new Map<string, string | null>();
  if (attributed.length > 0) {
    const { resolveSessionStates } = await import('../../agent-tools/coordination/liveness-oracle');
    const { withBoundedTimeout } = await import('../../bounded-timeout');
    const verdicts = await withBoundedTimeout(
      () => resolveSessionStates(attributed.map((ownerId) => ({ ownerId })), { hydratePerId: true }),
      { fallback: new Map(), timeoutMs: 5_000, label: 'git-sync content-notice liveness' },
    );
    for (const [id, v] of verdicts.value) states.set(id, v.sessionState);
  }
  return selectContentNoticeRecipients(notice, editors, (id) => states.get(id));
}

/**
 * EI-21743795611133311: tell the live edit-lock holders when git-sync had to
 * leave their dirty paths out of the commit. The lock TTL is only a backstop;
 * it does not make the omission visible to the agent who can release the lock.
 *
 * Group by holder so one agent holding several files receives one actionable
 * notice per tick. This is deliberately best-effort: a coordination-store
 * outage must never turn a successful partial commit into a failed git-sync
 * fire. The routine metadata + pipeline event retain the structured provenance
 * regardless of delivery.
 */
async function notifySkippedLockedPaths(
  slug: string,
  workspaceId: string,
  outcome: GitSyncOutcome,
): Promise<void> {
  const skippedPaths = outcome.skippedPaths ?? [];
  if (skippedPaths.length === 0) return;

  const byHolder = new Map<string, Array<Extract<GitSyncSkippedPath, { owner: string }>>>();
  for (const skipped of skippedPaths) {
    if (!('owner' in skipped)) continue;
    // P-014: a restricted-disclosure hold is not an edit lock. Its holder cannot lift it
    // with locks:release (only releasing the disclosure does), so telling them to on every
    // tick is noise. The routine metadata still records the skipped path and its intent.
    if (isRestrictedHoldIntent(skipped.intent)) continue;
    const holder = skipped.owner.trim();
    if (!holder) continue;
    const rows = byHolder.get(holder);
    if (rows) {
      if (!rows.some((row) => row.scope === skipped.scope && row.path === skipped.path)) rows.push(skipped);
    } else {
      byHolder.set(holder, [skipped]);
    }
  }

  for (const [holder, rows] of byHolder) {
    const pathDetails = rows
      .map((row) => `- ${row.scope}/${row.path}${row.intent.trim() ? ` — ${row.intent.trim()}` : ''}`)
      .join('\n');
    const count = rows.length;
    const partial =
      outcome.status === 'skipped-locked'
        ? 'No locked path could be committed this tick.'
        : `The unlocked remainder may have synced; this tick's local status is \`${outcome.status}\`.`;
    // EI-22176521893516708: NAME the path in the summary line, not only in the
    // body. The one-line notice is what an agent actually reads on a coord
    // surface, and a bare count sends it hunting through locks:queue to find
    // out that it is blocking itself — measured at 11 minutes in the report
    // that asked for this. Keep the leading "skipped N locked dirty path(s)"
    // wording intact: git-sync-action.test.ts matches on that prefix.
    const firstPath = `${rows[0].scope}/${rows[0].path}`;
    const summary =
      `git-sync skipped ${count} locked dirty ${count === 1 ? 'path' : 'paths'} on ${slug}` +
      ` (${firstPath}${count > 1 ? ` +${count - 1} more` : ''})` +
      ' — release your edit lock when done';
    const body =
      `git-sync on ${slug} could not include the following dirty path${count === 1 ? '' : 's'} because your live edit lock is still held:\n` +
      `${pathDetails}\n\n` +
      `${partial} This exclusion repeats on every tick until the lock is released.\n\n` +
      'If the edit is complete, call `locks:release { paths: [...] }` (or release the lock_id) now. ' +
      'If you are still editing, keep the lock and no action is needed.';
    await sendMessage(GIT_SYNC_IDENTITY, {
      to: [holder],
      summary,
      body,
      category: 'git-sync',
    }).catch(() => {});
  }

  const migrationReservations = skippedPaths.filter(
    (row): row is Extract<GitSyncSkippedPath, { reason: 'migration-reservation' }> =>
      'reason' in row && row.reason === 'migration-reservation',
  );
  if (migrationReservations.length === 0) return;

  let roster: AttributionRosterEntry[];
  try {
    roster = await loadAttributionRosterMerged(workspaceId);
  } catch (error) {
    console.warn(
      `[git-sync] ${slug}: could not load attribution for migration-reservation refusals: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  let superRoot: string | undefined;
  try {
    const { projectDirForSlug } = await import('../../operator-notes');
    superRoot = (await projectDirForSlug(slug, workspaceId)) ?? undefined;
  } catch {
    // Repo-relative edit-ledger entries still resolve without the checkout root.
  }

  const byAuthor = new Map<string, Array<Extract<GitSyncSkippedPath, { reason: 'migration-reservation' }>>>();
  for (const skipped of migrationReservations) {
    // agentsForScopedFiles resolves the right repo-relative map for each scope,
    // including nested repo paths; keep its established first-declared-wins rule.
    const [author] = agentsForScopedFiles(roster, [{ scope: skipped.scope, file: skipped.path }], superRoot);
    if (!author) continue;
    const rows = byAuthor.get(author) ?? [];
    if (!rows.some((row) => row.scope === skipped.scope && row.path === skipped.path)) rows.push(skipped);
    byAuthor.set(author, rows);
  }

  if (byAuthor.size === 0) {
    console.warn(
      `[git-sync] ${slug}: migration-reservation refusals had no matching file author in the attribution roster`,
    );
    return;
  }

  try {
    const { upsertConditionWorkItem } = await import('../../coord/condition-upsert');
    for (const [author, rows] of byAuthor) {
      const signature = [...new Set(rows.map((row) => `${row.scope}\u001f${row.path}`))].sort().join('\u001e');
      const signatureHash = createHash('sha256').update(signature).digest('hex').slice(0, 24);
      const fileList = rows.map((row) => `${row.scope}/${row.path}`).join(', ');
      const refusalDetails = rows.map((row) => `- ${row.scope}/${row.path}: ${row.detail}`).join('\n');
      try {
      await upsertConditionWorkItem(`git-sync-migration-reservation:${slug}:${author}:${signatureHash}`, {
        kind: 'bug',
        title: `git-sync migration reservation needs repair (${rows.length} migration(s), ${signatureHash})`,
        summary:
          `git-sync on ${slug} left these migrations out of the commit because their filenames do not match a reservation: ${fileList}\n` +
          `${refusalDetails}\n\n` +
          'To repair, run `npm run db:next-migration` to reserve the next number, rename the migration to the returned filename, and retry. Do not choose a number manually or reuse a number reserved for another migration.',
        severity: 'major',
        harness: slug,
        workspaceId,
        createdBy: GIT_SYNC_IDENTITY.ownerId,
        assignee: author,
        assignedBy: GIT_SYNC_IDENTITY.ownerId,
        payload: {
          source: 'git-sync-migration-reservation',
          author,
          signature: signatureHash,
          migrations: rows.map(({ scope, path, detail }) => ({ scope, path, detail })),
        },
      });
      } catch (error) {
        console.warn(
          `[git-sync] ${slug}: could not persist migration-reservation work item for ${author}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    console.warn(
      `[git-sync] ${slug}: could not load migration-reservation work-item upsert: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * P-004 (deterministic-commit-workitem-attribution-2026-06-22): after a synced tick, read the
 * `Papercusp-Work-Item/Agent/Session/Plan` trailers off the per-agent commits git-sync just made
 * (run-git-sync wrote them) + their changed files, and persist them as git_sync_commit_attribution
 * rows — the fast reverse-index the doc-drift (P-005) + merge-resolver (P-006) consumers join.
 * DETERMINISTIC + best-effort (D-006): pure git reads + a bulk insert, NO LLM. Dedup by commit_sha
 * (idempotent across ticks); bounded to the last 50 commits; superproject only for now (a
 * superproject commit that touched a submodule shows the gitlink path — submodule-inner attribution
 * is a follow-on). Never throws.
 */
async function recordSyncedCommitAttribution(slug: string, workspaceId: string): Promise<void> {
  try {
    const { projectDirForSlug } = await import('../../operator-notes');
    const repoRoot = await projectDirForSlug(slug, workspaceId);
    if (!repoRoot) return;
    const { runGit } = await import('../docs/git-runner');

    const logRes = await runGit(['log', '-n', '50', '--format=%H'], repoRoot);
    if (logRes.code !== 0) return;
    const shas = logRes.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (shas.length === 0) return;

    // Which of these are already recorded? (idempotent re-run across ticks.)
    const { sql } = getOrgPg();
    const existing = await sql<{ commit_sha: string }[]>`
      SELECT DISTINCT commit_sha FROM harness_shared.git_sync_commit_attribution
       WHERE commit_sha = ANY(${shas})`;
    const seen = new Set(existing.map((r) => r.commit_sha));

    const rows: CommitAttributionRow[] = [];
    for (const sha of shas) {
      if (seen.has(sha)) continue;
      const body = (await runGit(['show', '-s', '--format=%B', sha], repoRoot)).stdout;
      const t = parsePapercuspTrailers(body);
      // Only OUR attributed git-sync commits carry these — skip everything else.
      if (!t.agent && t.workItems.length === 0) continue;
      const filesRes = await runGit(['show', '--name-only', '--format=', sha], repoRoot);
      const files = filesRes.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const file of files) {
        const base = {
          workspaceId,
          harnessSlug: slug,
          repo: 'superproject',
          commitSha: sha,
          file,
          agentId: t.agent,
          sessionId: t.sessionId,
          planSlug: t.planSlug,
        };
        if (t.workItems.length === 0) {
          rows.push(base);
        } else {
          // one row per (file × work-item) — honest multiplicity (D-003).
          for (const wi of t.workItems) rows.push({ ...base, workItemId: wi });
        }
      }
    }
    await recordCommitAttribution(rows);
  } catch {
    // best-effort: commit attribution must never affect git-sync.
  }
}

/**
 * P-006 (deterministic-commit-workitem-attribution-2026-06-22): pre-compute authorship/intent
 * context for the conflicted files so the merge-resolver receives it WITHOUT spending tool calls
 * to discover it (D-006). Reads the recent commits that touched each conflicted file + their
 * `Papercusp-Work-Item/Agent` trailers (git-sync's per-agent commits write them; the commit
 * subject IS the authoring agent's intent). Deterministic git reads, best-effort: returns [] on
 * any failure — the merge-resolver.md prompt has a git-log fallback. Bounded to 20 files/scope.
 */
async function computeConflictAuthorship(
  repoRoot: string,
  conflicts: RepoConflict[],
): Promise<
  Array<{
    scope: string;
    file: string;
    recent: Array<{ sha: string; subject: string; workItems: string[]; agent?: string }>;
  }>
> {
  try {
    const { runGit } = await import('../docs/git-runner');
    const out: Array<{
      scope: string;
      file: string;
      recent: Array<{ sha: string; subject: string; workItems: string[]; agent?: string }>;
    }> = [];
    for (const c of conflicts) {
      // a submodule conflict's files are relative to the submodule repo; cd there (D-015).
      const repoDir = c.scope === 'superproject' ? repoRoot : `${repoRoot}/${c.scope}`;
      for (const file of c.conflictedFiles.slice(0, 20)) {
        // %x1f field-sep, %x1e record-sep so a multi-line %B body parses unambiguously.
        const res = await runGit(['log', '-n', '5', '--format=%H%x1f%B%x1e', '--', file], repoDir);
        if (res.code !== 0) continue;
        const recent = res.stdout
          .split('\x1e')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((block) => {
            const sep = block.indexOf('\x1f');
            const sha = (sep >= 0 ? block.slice(0, sep) : block).trim();
            const body = sep >= 0 ? block.slice(sep + 1) : '';
            const t = parsePapercuspTrailers(body);
            return {
              sha: sha.slice(0, 12),
              subject: body.split('\n')[0]?.trim() ?? '',
              workItems: t.workItems,
              agent: t.agent,
            };
          })
          .filter((r) => r.sha.length > 0);
        if (recent.length > 0) out.push({ scope: c.scope, file, recent });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The registered `system:git-sync` handler.
 *
 * WI-1416 (bg-host-freeze-eventloop-stall P-006): registered with `ownSteps`, so the
 * routine engine runs this at the WORKFLOW layer and the phases below checkpoint as
 * DBOS sub-steps (`git-sync:eligibility` → `git-sync:submodules` →
 * `git-sync:pointer-bump` → `git-sync:push` → `git-sync:record`). Before, the whole
 * handler was ONE opaque step recording no operation_output until it fully completed —
 * on the big tree that routinely takes >90s, so the executor reaper's orphan heuristic
 * cancelled+requeued every fire mid-flight (restart-from-scratch loop, ~1 commit/40min,
 * WI-1415). Checkpointed, the reaper sees genuine progress within seconds, and a
 * stalled/killed fire RESUMES from its last checkpoint. Every git phase is replay-safe
 * (see GitSyncStepRunner in run-git-sync.ts): a re-run commit is `nothing to commit`,
 * a re-run push is `Everything up-to-date` — no double-commit.
 */
async function handleGitSync(ctx: SystemActionCtx, repoPathOverride?: string | null): Promise<GitSyncFireOutcome> {
  const { installSlug: slug, workspaceId } = ctx;
  const { config: cfg, extraLockResources } = configFromTrigger(ctx.triggerConfig);
  const cd = workspaceId || '*';

  // STEP `git-sync:eligibility` — checkpoints within seconds of the fire starting, so
  // even a fire stalled in the lock/git phases below already shows function_id > 0.
  // Also stamps the `fire_started_at` breadcrumb: paired with `reaped_count` (stamped
  // by the executor reaper on each cancel, cleared by recordOutcome on completion) it
  // makes a persistent reap-loop a durable, queryable signal for the
  // git-sync-stall-watchdog. P-008 runtime gate: ineligible rows no-op (logged +
  // recorded), never escalate.
  //
  // WI-10004472: whether THIS execution ran the step body. DBOS replays a recorded
  // step from its operation_output without calling the body, so `false` here means
  // this is a recovery replay of a fire that had already passed eligibility. The lock
  // phase below is deliberately NOT a step, so such a replay can be refused a lock the
  // original held; see the abandon branch there.
  let eligibilityRanLive = false;
  const gate = await runCheckpointedStep(
    'git-sync:eligibility',
    async (): Promise<
      GitSyncEligibility & {
        hiveGitMode?: PotGitMode;
        hiveGitIdentity?: { potHomeSlug: string; repoKey: string };
        repoPath?: string;
        /** pot-review-integration-mode P-014: this tick's push target under hiveGit.integration. */
        integration?: IntegrationPushDecision;
      }
    > => {
      eligibilityRanLive = true;
      await patchRoutineMetadata(slug, workspaceId, { fire_started_at: Date.now() });
      const { gate: g, entry } = await gitSyncRuntimeGate(slug, workspaceId, repoPathOverride);
      if (!g.eligible) {
        await patchRoutineMetadata(slug, workspaceId, {
          last_status: 'skipped',
          local_sync_status: 'skipped',
          last_skip_reason: g.reason,
          last_skipped_at: Date.now(),
        });
        return g;
      }
      // github-bridge P-003 (S-5, run-time half): re-consult the hive's git mode
      // EVERY tick — a hive flipped legacy→bridged must stop origin-pushing without
      // a routine re-seed (the seeded trigger_config.push predates the flip). Only
      // resolved for hive members (hive_slug) / self_repo hive homes; getPotGitMode
      // is fail-open: absent/junk/store-error all read 'legacy' (today's behavior).
      const potHomeSlug = entry ? (entry.hive_slug ?? (entry.self_repo ? entry.slug : undefined)) : undefined;
      if (potHomeSlug && workspaceId) {
        const mode = await getPotGitMode(workspaceId, potHomeSlug);
        // pot-review-integration-mode P-014 (D-005/D-006): hiveGit.integration is
        // orthogonal to hiveGit.mode and re-read EVERY tick, so flipping a pot into
        // working-copy mode stops main-repo pushes on the next tick. Unlike the git
        // mode it fails CLOSED: an unreadable or malformed setting means commit-only.
        const integrationRead = await readPotIntegrationMode(workspaceId, potHomeSlug);
        // WI-10006333: a repo pot's HOME is the pot's own metadata repository, not the
        // subject a working copy protects, once a member holds the fork. Only that case
        // needs the full registry; a failed read stays governed (fail-closed).
        let governed = true;
        if (integrationRead.mode === 'review' && entry && !entry.hive_slug && !entry.fork_remote) {
          try {
            governed = integrationModeGovernsHarness(entry, (await loadHarnessRegistry(workspaceId)).projects);
          } catch {
            governed = true;
          }
        }
        const integration: IntegrationPushDecision = governed
          ? resolveIntegrationPushRemote({
              read: integrationRead,
              ...(entry?.fork_remote ? { forkRemote: entry.fork_remote } : {}),
            })
          : { kind: 'unchanged', reason: 'pot home repository — the working copy lives on a member (WI-10006333)' };
        const withIntegration = integration.kind === 'unchanged' ? {} : { integration };
        if (mode !== 'legacy' && entry)
          return {
            ...g,
            hiveGitMode: mode,
            hiveGitIdentity: { potHomeSlug, repoKey: canonicalRepoKey(entry) },
            ...(entry.path ? { repoPath: entry.path } : {}),
            ...withIntegration,
          };
        return { ...g, ...(entry?.path ? { repoPath: entry.path } : {}), ...withIntegration };
      }
      return { ...g, ...(entry?.path ? { repoPath: entry.path } : {}) };
    },
  );
  if (!gate.eligible) {
    console.log(`[git-sync] ${slug}: ineligible (${gate.reason}) — skipping this tick`);
    return { status: 'skipped', reason: gate.reason ?? 'ineligible' };
  }
  // The scoped eligibility snapshot already resolved the canonical tree. Keep
  // that ONE path through the entire tick; only the fail-open unreadable-registry
  // case needs a final workspace-scoped lookup. Explicit null from a manual fire
  // remains authoritative and must not fall back to ambient state.
  const repoPath =
    repoPathOverride !== undefined
      ? repoPathOverride
      : (gate.repoPath ?? (await (await import('../../operator-notes')).projectDirForSlug(slug, workspaceId)));
  // github-bridge P-003: on a bridged/p2p-only hive, member git-sync is COMMIT-ONLY —
  // the bridge writer (integrator lease holder) is the sole origin pusher (S-1).
  // The local commit still runs; the dedicated GitHub-ingress/admission and P2P
  // worktree-bridge legs below own remote-to-worktree flow.
  if (gate.hiveGitMode) {
    // EI-20232774599730947: do not bypass the P2P/GitHub admission path with a
    // second direct origin fetch+merge. In particular, a restored installer
    // seed retains an intentionally unrelated local lineage; retrying its
    // one-time transplant every tick eventually conflicts with ordinary local
    // git-sync commits and paints an otherwise healthy P2P writer red.
    cfg.reconcileSuperprojectOrigin = false;
    // WI-40066: a bridged GitHub hive still needs the fail-closed release-main
    // ancestry repair. The ordinary origin reconciler stays disabled (content
    // continues through GitHub admission + P2P), while runGitSync may record an
    // `ours` parent only when every main-only tree entry is already represented
    // exactly on local staging. A p2p-only hive has no GitHub release channel
    // and must not fetch one opportunistically.
    cfg.bridgeContainedReleaseMainOnCommitOnly = gate.hiveGitMode === 'bridged';
    if (cfg.push) {
      console.log(
        `[git-sync] ${slug}: hive git mode '${gate.hiveGitMode}' — commit-only this tick (the bridge owns origin pushes)`,
      );
      cfg.push = false;
      // EI-18689553108460319 + WI-6016: the bridge writer owns the
      // SUPERPROJECT's canonical refs — NOT an independently-hosted submodule
      // library that nothing else ever pushes. Only a runtime legacy→P2P flip
      // opts this previously-pushing member back in. A joiner whose persisted
      // config was already push:false and omitted this key must still push
      // nothing anywhere (AH-6). This opt-in requests publication; the fresh
      // owning-hive proof below still authorizes each submodule-origin push.
      if (cfg.pushSubmoduleOrigins === undefined) cfg.pushSubmoduleOrigins = true;
    }
  }
  // pot-review-integration-mode P-014 (D-006): a working-copy pot pushes its OWN
  // fork, never the main repository. Applied after the hive-git-mode block — a
  // bridged/p2p hive is already commit-only and its bridge leg honours fork_remote.
  const integrationCommitOnly = cfg.push ? await applyIntegrationPushTarget(slug, cfg, gate.integration, repoPath) : null;
  // EI-18812945811758018: the EFFECTIVE push mode for this tick, recorded later as part
  // of recordOutcome's SINGLE metadata write (never its own patch — a skipped tick must
  // still write nothing, and the settle write is asserted as the only one).
  //
  // Read surfaces need this to tell "this member never pushes, BY DESIGN" apart from
  // "the push leg is broken": an empty `last_pushed` means opposite things in those two
  // cases. Without it dev:pipeline_position read both as a fault and prescribed
  // `git-sync:run` — a lever structurally INERT on a bridged hive (a forced run commits
  // and still pushes nothing, exactly as designed).
  const effectivePushMode = cfg.push
    ? 'push'
    : gate.hiveGitMode
      ? `commit-only:${gate.hiveGitMode}`
      : integrationCommitOnly
        ? `commit-only:${integrationCommitOnly}`
        : 'commit-only:config';

  // P-006/WI-229179: acquire the workspace-wide restart barrier shared first,
  // then the per-slug resource (auto-registered) and the routine's extras
  // (papercup: legacy 'git-sync' + 'libs-papercusp-submodule' — the back-off
  // protocol). The legacy global name is filtered from the exclusive extras;
  // it is represented by the shared request below so dev:restart can acquire
  // it exclusively without serializing unrelated harness commits.
  // Locks stay at the WORKFLOW layer — deliberately NOT a checkpointed step, so a
  // resumed/replayed fire re-acquires them instead of trusting a checkpoint whose
  // lease may have expired mid-stall. Every fire gets a fresh owner token: if a
  // prior process still owns the lease, the replay must wait/skip rather than
  // coalescing with that potentially concurrent process.
  const seenResources = new Set<string>();
  const resourceCandidates: GitSyncLockRequest[] = [
    { resource: GIT_SYNC_RESTART_BARRIER_RESOURCE, mode: 'shared' },
    { resource: gitSyncResourceName(slug), mode: 'exclusive' },
    ...extraLockResources
      .filter((resource) => resource !== GIT_SYNC_RESTART_BARRIER_RESOURCE)
      .map((resource) => ({ resource, mode: 'exclusive' as const })),
  ];
  const resources = resourceCandidates.filter(({ resource }) => {
    if (seenResources.has(resource)) return false;
    seenResources.add(resource);
    return true;
  });
  const acquired: GitSyncLockRequest[] = [];
  const lockOwner = newGitSyncLockOwner();
  const withActivityOwner = (activity: GitSyncActivityFields): GitSyncActivityMarker => ({
    ...activity,
    owner: lockOwner,
    owner_pid: process.pid,
  });
  const writeActivity = (activity: GitSyncActivityFields): Promise<void> =>
    writeGitSyncActivity(slug, workspaceId, withActivityOwner(activity));
  const lock = await acquireLocks(cd, slug, resources, acquired, lockOwner);
  if (lock.state === 'held' || lock.state === 'contended') {
    const reason = lock.blockedReason ?? (lock.state === 'contended' ? 'lock_contended' : 'lock_held');
    if (lock.state === 'contended') {
      console.log(`[git-sync] ${slug}: lock contention persisted on ${lock.blockedOn} — skipping this tick`);
    } else if (lock.blockedReason === 'unknown_resource') {
      console.warn(
        `[git-sync] ${slug}: lock resource "${lock.blockedOn}" is not registered in agent_resource_registry — ` +
          'skipping this tick. Register it or remove it from trigger_config.extra_lock_resources.',
      );
    } else {
      const holderDescription = lock.holders?.some((holder) => isSystemGitSyncHolder(holder, slug))
        ? 'an in-flight git-sync auto-commit'
        : 'a peer';
      console.log(`[git-sync] ${slug}: ${holderDescription} holds ${lock.blockedOn} — skipping this tick`);
    }
    // WI-10004472: a REPLAYED eligibility step means DBOS is recovering a fire that
    // already got this far. If that original run held these locks, it recorded its
    // post-lock sub-steps (git-sync:submodules, :pointer-bump, …), and this skip
    // branch cannot reproduce them: the routine engine's next step would land on a
    // function id recorded under another name and DBOS would fail the whole workflow
    // ("git-sync:pointer-bump was recorded when system:git-sync:settle was
    // expected", observed 2026-10-01 00:52:32Z on four recovered fires after a
    // bg-host restart). Re-acquiring live on replay is deliberate (see above), so the
    // refusal itself is legitimate: end the replay WITHOUT any further DBOS operation
    // and let the next scheduled tick redo the work. No lock-retry event either: it
    // is fire-and-forget work started inside this workflow's context.
    if (!eligibilityRanLive && ctx.workflowId) {
      console.warn(
        `[git-sync] ${slug}: recovery replay of ${ctx.workflowId} refused ${lock.blockedOn ?? 'its locks'} ` +
          `(${reason}) — abandoning the replay instead of diverging from its recorded steps`,
      );
      await patchRoutineMetadata(slug, workspaceId, {
        last_status: 'skipped',
        local_sync_status: 'skipped',
        last_skip_reason: `replay_abandoned:${reason}`,
        last_skipped_at: Date.now(),
        last_skipped_paths: [],
      });
      return {
        status: 'skipped',
        reason,
        replayAbandoned: true,
        ...(lock.blockedOn ? { blockedOn: lock.blockedOn } : {}),
        ...(lock.holders ? { holders: lock.holders } : {}),
      };
    }
    // A held_exclusive refusal means the peer's resource row is still live. The
    // release/grant cascade owns the truthful wake for that row; emitting here
    // wakes waiters into the same no-delta refusal while the peer still holds it.
    // Other refusal classes retain the retry signal for their existing callers.
    if (lock.blockedOn && reason !== 'held_exclusive') {
      emitGitSyncLockRetryEvent(lock.blockedOn, reason, lock.holders ?? [], {
        scope: { installSlug: slug, workspaceId },
      });
    }
    // EI-22764118395439975: this fire reached the eligibility gate but never reached
    // runGitSync, so replace the previous local outcome with an explicit
    // non-attemptable status. Before this write, a healthy earlier `synced` outcome
    // survived every lock-refused fire; the stall watchdog then accumulated its
    // HEAD clock across those skips and broadcast "commits are NOT landing" even
    // though the checkout was clean and every DBOS workflow settled successfully.
    // `isCommitNotAttemptableStatus` already treats `skipped` as a clock re-arm —
    // the producer must actually record it at this terminal boundary.
    const skippedAt = Date.now();
    await patchRoutineMetadata(slug, workspaceId, {
      last_status: 'skipped',
      local_sync_status: 'skipped',
      last_skip_reason: reason,
      last_skipped_at: skippedAt,
      last_skipped_paths: [],
    });
    return {
      status: 'skipped',
      reason,
      ...(lock.blockedOn ? { blockedOn: lock.blockedOn } : {}),
      ...(lock.holders ? { holders: lock.holders } : {}),
    };
  }
  // Keep the resource lease alive from the moment it is acquired. Setup has
  // several awaits before the local pipeline starts, and a six-hundred-second
  // lease can otherwise expire while those reads are still in flight.
  const activityStartedAt = Date.now();
  const stopLockHeartbeat =
    lock.state === 'acquired' ? startLockHeartbeat(cd, slug, [...acquired], lockOwner) : async () => {};
  // The cancellation race bounds setup/metadata awaits, not OS process lifetime.
  // Reuse runGitSync's runner seam to track actual Git work independently of
  // the pipeline promise, which can be rejected by that race before child exit.
  const activeGitExecutions = new Set<Promise<unknown>>();
  // Timeout cleanup is single-flight. The timer callback and the owning finally
  // block can race: whichever notices expiry first must stop the heartbeat before
  // releasing the leases, while a late callback must never release a second time.
  let lockCleanup: Promise<void> | null = null;
  const cleanupLocks = (): Promise<void> => {
    if (lockCleanup) return lockCleanup;
    lockCleanup = (async () => {
      // Keep renewing leases throughout SIGTERM/SIGKILL and exit verification.
      // The cleanup budget below bounds DB cleanup only; it cannot certify exit.
      while (activeGitExecutions.size > 0) await Promise.allSettled([...activeGitExecutions]);
      await new Promise<void>((resolve) => {
        let finished = false;
        const finish = (): void => {
          if (finished) return;
          finished = true;
          if (timer) clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          console.warn(
            `[git-sync] ${slug}: lock cleanup exceeded ${GIT_SYNC_ACTION_CLEANUP_TIMEOUT_MS}ms; ` +
              'the resource TTL remains the final backstop',
          );
          finish();
        }, GIT_SYNC_ACTION_CLEANUP_TIMEOUT_MS);
        timer.unref?.();
        void (async () => {
          try {
            await stopLockHeartbeat();
          } catch (error) {
            console.warn(
              `[git-sync] ${slug}: lock heartbeat stop failed during cleanup: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          if (lock.state === 'acquired') {
            try {
              await releaseAll(cd, lockOwner, acquired);
            } catch (error) {
              console.warn(
                `[git-sync] ${slug}: lock release cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          finish();
        })();
      });
    })();
    return lockCleanup;
  };
  let timeoutActivity: Promise<void> | null = null;
  const recordTimeoutActivity = (error: GitSyncActionTimeoutError): Promise<void> => {
    if (timeoutActivity) return timeoutActivity;
    const failedAt = Date.now();
    timeoutActivity = patchRoutineMetadata(slug, workspaceId, {
      last_status: 'error',
      local_sync_status: 'error',
      last_error: error.message,
      last_errors: [`git-sync action timeout (${error.timeoutKind}) during ${error.phase}`],
      git_sync_activity: withActivityOwner({
        active: false,
        phase: 'error',
        started_at: activityStartedAt,
        updated_at: failedAt,
        completed_at: failedAt,
        outcome_status: null,
      }),
    }).catch((metadataError) => {
      console.warn(
        `[git-sync] ${slug}: could not record action timeout metadata: ${
          metadataError instanceof Error ? metadataError.message : String(metadataError)
        }`,
      );
    });
    return timeoutActivity;
  };
  const liveness = createGitSyncActionLivenessGuard({
    idleTimeoutMs: gitSyncActionIdleTimeoutMs(),
    hardTimeoutMs: gitSyncActionHardTimeoutMs(),
    onTimeout: async (error) => {
      // Record expiry promptly; cleanup itself fences on active Git settlement.
      const activity = recordTimeoutActivity(error);
      await cleanupLocks();
      await activity;
    },
  });
  let lastActivityHeartbeatAt = activityStartedAt - GIT_SYNC_ACTIVITY_HEARTBEAT_INTERVAL_MS;
  let activityHeartbeatWrite: Promise<void> = Promise.resolve();
  const enqueueActivityHeartbeat = (): void => {
    const updatedAt = Date.now();
    if (updatedAt - lastActivityHeartbeatAt < GIT_SYNC_ACTIVITY_HEARTBEAT_INTERVAL_MS) return;
    lastActivityHeartbeatAt = updatedAt;
    activityHeartbeatWrite = activityHeartbeatWrite
      .catch(() => {})
      .then(async () => {
        if (liveness.timedOut) return;
        await writeActivity({
          active: true,
          phase: 'local-sync',
          started_at: activityStartedAt,
          updated_at: updatedAt,
          completed_at: null,
          outcome_status: null,
        });
      })
      .catch((error) => {
        if (!liveness.timedOut) {
          console.warn(
            `[git-sync] ${slug}: activity heartbeat write failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      });
  };
  const guarded = <T>(phase: string, operation: () => Promise<T>): Promise<T> => liveness.run(operation, phase);
  let outcome: GitSyncOutcome;
  // These values are consumed by the post-pipeline escalation/recording tail;
  // the surrounding catch rethrows every setup failure before that tail runs.
  let prev!: Awaited<ReturnType<typeof readEscalationCounters>>;
  let attributionOn!: boolean;
  let docFreshnessModule: typeof import('../docs/sweep-after-sync') | null = null;
  let prevHeadSha: string | null = null;
  try {
    await guarded('activity-start', () =>
      writeActivity({
        active: true,
        phase: 'local-sync',
        started_at: activityStartedAt,
        updated_at: activityStartedAt,
        completed_at: null,
        outcome_status: null,
      }),
    );
    // EI-18: previous tick's counters BEFORE this tick overwrites them.
    prev = await guarded('read-escalation-counters', () => readEscalationCounters(slug, workspaceId));

    // Capture HEAD before the sync so the doc-freshness sweep (P-003) can diff the
    // exact paths this tick moved. Best-effort — never gate the sync on it.
    try {
      docFreshnessModule = await guarded('load-doc-freshness-module', () => import('../docs/sweep-after-sync'));
      prevHeadSha = await guarded('capture-pre-sync-head', () =>
        docFreshnessModule!.captureHeadSha(slug, workspaceId, repoPath),
      );
    } catch {
      if (liveness.timedOut) throw liveness.timeoutError;
      /* best-effort */
    }

    // EI-438 content-guard KILL-SWITCH (default ON): when OFF, pass an EMPTY detector
    // set so runGitSync commits exactly as before this plan (no quarantine/escalation/
    // fixer) — the instant off-switch on the shared commit path, no deploy needed. A
    // flag-infra error falls back to the default (ON), keeping the safety on.
    const contentGuardOn = await guarded('read-content-guard-flag', () => getFlag(FLAGS.GIT_SYNC_CONTENT_GUARD, slug));
    // EI-17 kill-switch: default ON (see FLAGS.GIT_SYNC_DELETION_GUARD doc). A flag-infra
    // error falls back to the default (ON), keeping the safety on — same as content-guard.
    const deletionGuardOn = await guarded('read-deletion-guard-flag', () =>
      getFlag(FLAGS.GIT_SYNC_DELETION_GUARD, slug),
    );
    // P-004 (git-sync-dx-hardening): derived commit attribution (default OFF). When ON, supply the
    // LIVE roster of active agents + their declared files (coord presence current_files) so runGitSync
    // peels per-agent commits. DERIVED, never authored — agents stay git-free. Flag-gated read; a
    // presence-read failure degrades to no attribution (today's single commit).
    attributionOn = await guarded('read-attribution-flag', () => getFlag(FLAGS.GIT_SYNC_DERIVED_ATTRIBUTION, slug));
    // WI-38594: diff-derived commit subjects (default ON) — subject = the staged diff,
    // intent line demoted to the body. OFF = pre-WI-38594 subjects, no deploy needed.
    const diffSubjectsOn = await guarded('read-diff-subjects-flag', () => getFlag(FLAGS.GIT_SYNC_DIFF_SUBJECTS, slug));
    // File locks are the automatic edit-plane authority. Keep git-sync's broad
    // whole-tree sweep from staging a peer's in-flight paths; the pure pipeline
    // maps these superproject-root-relative paths into each submodule before add.
    let liveLockHoldingRows: Awaited<ReturnType<typeof liveLockHoldingsStrict>>;
    // WI-10005576 / R-10: the census also reads THIS tree, so a write made inside an
    // active personal-disclosure window without a native edit tool is held too. An explicit
    // null repoPath (manual fire) names no tree, so there is nothing for the window read to scan;
    // the ledger-backed restricted holdings still apply.
    const readCensus = () =>
      readGitSyncCensusStrict(
        repoPath
          ? {
              window: {
                repoPath,
                runGit: (args, cwd) => runGitBounded(args, cwd, gitTimeoutMsFor(args), { signal: liveness.signal }),
              },
            }
          : {},
      );
    try {
      // EI-21876778499591361: ride out a TRANSIENT pg contention timeout on this read instead of
      // skipping the tick. Failing CLOSED below is right for an UNREADABLE lock plane — staging a
      // peer's transiently-truncated file is the harm it prevents — but a 57014/55P03 is not that:
      // it is this idempotent SELECT losing a lock race under load, and it self-clears. Skipping on
      // it stalls commits FLEET-WIDE at exactly the load where they matter most (observed
      // 2026-08-30: missed_intervals=3, no successful sync for >10min, 34 files stuck in the tree).
      //
      // Same class + same primitive as the acquire sites above, which this file already wraps —
      // contention-retry's own docstring names "call sites that SKIP the tick ... stall git-sync"
      // (EI-1720); this read was simply never wrapped. The retry sits INSIDE `guarded` so it sees
      // the RAW error, before the liveness wrapper. Non-contention faults still fail closed on the
      // first attempt, unchanged. ~6s of backoff against a 600s (LOCK_TTL_SEC) idle deadline.
      liveLockHoldingRows = await guarded('read-live-file-locks', () => acquireWithContentionRetry(readCensus));
    } catch (error) {
      if (liveness.timedOut) throw liveness.timeoutError;
      // This read is a safety gate: treating an unreadable lock plane as [] lets
      // runGitSync stage a peer's transiently-truncated file. Refuse the tick,
      // make the reason visible; the outer finally owns lease cleanup.
      const detail = error instanceof Error ? error.message : String(error);
      const skippedAt = Date.now();
      console.error(`[git-sync] ${slug}: live lock read failed (fail-closed) — skipping this tick: ${detail}`);
      try {
        await guarded('record-live-lock-read-failure', () =>
          patchRoutineMetadata(slug, workspaceId, {
            last_status: 'skipped',
            local_sync_status: 'skipped',
            last_skip_reason: 'live-lock-read-failed',
            last_skipped_at: skippedAt,
            last_skipped_paths: [],
            last_lock_read_error: detail,
            last_error: `live lock read failed (fail-closed): ${detail}`,
            last_errors: [`live-lock-read: ${detail}`],
            git_sync_activity: withActivityOwner({
              active: false,
              phase: 'error',
              started_at: activityStartedAt,
              updated_at: skippedAt,
              completed_at: skippedAt,
              outcome_status: null,
            }),
          }),
        );
      } catch (metadataError) {
        if (liveness.timedOut) throw liveness.timeoutError;
        // The primary console error above remains the visible signal if the
        // metadata store is unavailable; cleanup still runs in the outer finally.
        console.warn(
          `[git-sync] ${slug}: could not record live lock read failure metadata: ${
            metadataError instanceof Error ? metadataError.message : String(metadataError)
          }`,
        );
      }
      return { status: 'skipped', reason: 'live-lock-read-failed' };
    }
    // P-009 / WI-10002596: a NESTED install receives lock paths in its parent's root
    // coordinates; map them into this repo's own root so exclusion is not a silent no-op.
    const lockRepoPrefix = await nestedInstallLockPrefix(slug, workspaceId, repoPath);
    // EI-24649116564770033: each lock path is relative to ITS OWN coordination domain, and the
    // read above spans every domain. Translate into the top-level root's coordinates first, so
    // an unrelated repo's `package.json` lock cannot withhold ours and a submodule-root lock
    // protects the submodule file. One identity resolver per tick: nothing outlives it.
    const lockAnchorRoot = await lockCoordinateAnchor(repoPath, lockRepoPrefix);
    const lockDomainIdentity = createLockDomainIdentity((args, cwd) =>
      runGitBounded(args, cwd, LOCK_DOMAIN_IDENTITY_TIMEOUT_MS, { signal: liveness.signal }),
    );
    const toRepoLockCoordinates = async (
      rows: readonly DomainLockHolding[],
      report: boolean,
    ): Promise<LockHoldingCoordinates[]> => {
      let translated: LockHoldingCoordinates[] = [...rows];
      if (lockAnchorRoot) {
        const result = await translateLiveLockHoldingsToRoot(rows, lockAnchorRoot, lockDomainIdentity);
        translated = result.holdings;
        if (report && result.dropped.length > 0) {
          console.warn(
            `[git-sync] ${slug}: ignoring ${result.dropped.length} live lock(s) on another repository's files: ` +
              result.dropped
                .map((d) => `${d.path} (${d.reason} @ ${d.coordinationDomain}; ${d.owner}: ${d.intent})`)
                .join('; '),
          );
        }
      }
      return lockRepoPrefix ? mapLiveLockHoldingsForRepo(translated, lockRepoPrefix) : translated;
    };
    liveLockHoldingRows = await guarded('translate-live-file-locks', () =>
      toRepoLockCoordinates(liveLockHoldingRows, true),
    );

    let mergedAttributionRosterForTick: Promise<AttributionRosterEntry[]> | undefined;
    const loadAttributionRosterForTick = (): Promise<AttributionRosterEntry[]> => {
      if (!mergedAttributionRosterForTick) {
        mergedAttributionRosterForTick = loadAttributionRosterMerged(workspaceId);
      }
      return mergedAttributionRosterForTick;
    };

    // 'acquired' (locked) or 'error' (unlocked best-effort) → run.
    outcome = await guarded('run-git-sync', () =>
      runGitSync(slug, {
        repoPath,
        config: cfg,
        runGit: async (args, cwd) => {
          liveness.assertActive();
          const execution = runGitBounded(args, cwd, gitTimeoutMsFor(args), {
            signal: liveness.signal,
            onProgress: () => {
              liveness.touch();
              enqueueActivityHeartbeat();
            },
          });
          activeGitExecutions.add(execution);
          try {
            return await execution;
          } finally {
            activeGitExecutions.delete(execution);
          }
        },
        beforePush: gate.hiveGitMode
          ? async (args, cwd) => {
              // F6/D-022 covers independent submodule origins too. Resolve a live
              // owner signer for EACH attempt, bound to the tick's parent identity
              // and exact child argv/path, never to a member's advisory election.
              if (!gate.hiveGitIdentity) throw new HiveEffectAuthorityError();
              const { potHomeSlug, repoKey } = gate.hiveGitIdentity;
              const scope = await resolveHiveGitProtocolScope(workspaceId, potHomeSlug, repoKey);
              const owner = await loadHiveEffectAuthority(workspaceId, potHomeSlug, scope);
              const actor = owner ? await resolveHiveGitActor(workspaceId, slug, potHomeSlug, repoKey) : null;
              await requireHiveEffectAuthority(
                owner && actor
                  ? {
                      ...owner,
                      sign: async (bytes) => {
                        await actor.assertServing();
                        return owner.sign(bytes);
                      },
                    }
                  : null,
                scope,
                ['git-sync-push', cwd, ...args],
              );
            }
          : undefined,
        contentDetectors: contentGuardOn ? undefined : [],
        deletionGuard: deletionGuardOn,
        diffSubjects: diffSubjectsOn,
        // WI-10001350: keep newly armed migration files out of git-sync commits
        // unless the shared reservation ledger still authorizes their exact names.
        // Resolve the org client at callback time so the pure pipeline remains
        // DB-independent in tests and callers that inject a different checker.
        migrationReservationChecker: async (dirtyPaths) => {
          const { sql } = getOrgPg();
          return await checkDirtyMigrationReservations(sql, dirtyPaths);
        },
        // Holdings may be released during setup. Do not also copy them into
        // explicit exclusions, which intentionally survive every refresh.
        ...(liveLockHoldingRows.length > 0 ? { liveLockHoldings: liveLockHoldingRows } : {}),
        // Re-read the edit-lock plane at the final commit seam for every repo. The
        // initial census above protects setup, while this guarded callback closes
        // the longer submodule/guard window where a peer can acquire a lock.
        refreshLiveLockHoldings: async () => {
          const rows = await guarded('refresh-live-file-locks', () => acquireWithContentionRetry(readCensus));
          // Coordinate identity can perform Git reads too. Keep that await inside
          // the same cancellation guard, with its own phase so a stalled identity
          // lookup is not reported as a lock-census read.
          return guarded('translate-refreshed-live-file-locks', () => toRepoLockCoordinates(rows, false));
        },
        loadRoster: attributionOn ? loadAttributionRosterForTick : undefined,
        loadMigrationFenceRoster: loadAttributionRosterForTick,
        // WI-1416: checkpoint each pipeline phase (submodules → pointer-bump → push) as
        // a DBOS sub-step; a passthrough outside a workflow (fireGitSyncNow, tests).
        step: runCheckpointedStep,
        onProgress: () => {
          liveness.touch();
          enqueueActivityHeartbeat();
        },
        signal: liveness.signal,
      }),
    );
    // P-016 (pot-review-integration-mode): a working-copy pot's sync-back conflict
    // becomes ONE fix-it work-item in the pot, deduped on the sha-free title prefix
    // (watchdogKey) so a stuck merge never re-files on every upstream advance.
    // Best-effort: a filing failure never fails the tick.
    if (cfg.syncBack && outcome.syncBack?.status === 'conflict') {
      const syncBackCfg = cfg.syncBack;
      try {
        const filing = await fileSyncBackConflict(
          outcome.syncBack,
          syncBackCfg,
          makeSyncBackConflictFilingDeps({
            slug,
            workspaceId,
            cfg: syncBackCfg,
            conflictedFiles: outcome.syncBack.conflictedFiles,
          }),
        );
        if (filing.action !== 'none') console.log(`[git-sync] ${slug}: sync-back conflict work-item ${filing.action}: ${filing.id}`);
      } catch (err) {
        console.warn(`[git-sync] ${slug}: could not file the sync-back conflict work-item: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Do not let a queued local-sync heartbeat land after the post-legs marker
    // and regress the durable phase back to local-sync.
    await guarded('flush-activity-heartbeat', () => activityHeartbeatWrite);
  } catch (error) {
    if (error instanceof GitSyncActionTimeoutError) {
      // The timer callback normally starts this write in the same turn as the
      // abort. Calling it here as well closes the tiny ordering window where
      // the guarded promise rejects before that callback's microtask runs.
      await recordTimeoutActivity(error);
    } else {
      await writeActivity({
        active: false,
        phase: 'error',
        started_at: activityStartedAt,
        updated_at: Date.now(),
        completed_at: Date.now(),
        outcome_status: null,
      }).catch(() => {});
    }
    throw error;
  } finally {
    await cleanupLocks();
    await liveness.waitForTimeoutCleanup();
    liveness.stop();
  }

  // WI-3072: stash-detection recurrence guard — read-only (no lock needed), runs
  // regardless of the sync outcome (even a conflict/error tick should still surface a
  // surprise stash). Best-effort end-to-end, including resolving the repo path itself
  // (lazy-imported like the other operator-notes call sites in this file) — a failure
  // here must never break the tick this deep into the pipeline.
  try {
    if (repoPath) {
      await runCheckpointedStep('git-sync:stash-check', () => checkForNewStashes(slug, workspaceId, repoPath));
    }
  } catch {
    // Best-effort, silent degrade — mirrors loadAttributionRoster's fallback above:
    // an unresolvable repo path (or a load-graph hiccup) skips this courtesy check,
    // never the tick itself.
  }

  // P-003: count any tick whose errors[] is non-empty — a sibling push failure that
  // co-occurs with a conflict produces status 'conflict' (worst-outcome), which used
  // to RESET this counter to 0 every tick and defer the EI-18 push-failure escalation
  // indefinitely. The error LIST drives the counter now, not the worst status.
  const tickErrors = 'errors' in outcome ? outcome.errors : [];
  // The local guard ran while this fire held its git-sync lease. Re-check once
  // after that lease is released so a fixer that repaired/committed the file
  // during the post-lock window does not become a new work item.
  const revalidatedContentErrors = await revalidateContentErrors(repoPath, outcome.contentErrors);
  let nextActionableError = 0;
  const reportedContentErrors = outcome.contentErrors.flatMap((contentError) => {
    if (contentError.detectorKey === 'quarantined-importer') return [contentError];
    const current = revalidatedContentErrors[nextActionableError++];
    return current ? [current] : [];
  });
  if (reportedContentErrors.length !== outcome.contentErrors.length) {
    // Preserve importer deferrals for the partial-sync status and diagnostics;
    // the separate content-fixer signature below excludes them.
    outcome = { ...outcome, contentErrors: reportedContentErrors };
  }
  const errTicks = tickErrors.length > 0 ? prev.errTicks + 1 : 0;
  // EI-23989162263803651: the fixer budget belongs to the current offender signature,
  // not the routine-wide streak. A new file/detector set starts its own five-tick budget.
  const contentSignature =
    revalidatedContentErrors.length > 0 ? contentFixerSignature(revalidatedContentErrors) : null;
  const sameContentSignature = contentSignature !== null && contentSignature === prev.contentSignature;
  const prevSignatureContentTicks = sameContentSignature ? prev.contentTicks : 0;
  const contentTicks = contentSignature === null ? 0 : prevSignatureContentTicks + 1;
  // EI-21906459740652039: the cumulative-limit peel's own consecutive-tick counter.
  // Same shape as contentTicks, and for the same reason the content guard needed one:
  // the oversized BROADCAST is edge-triggered, so without a persisted count a peel
  // that never stops is indistinguishable from one that never happened again.
  const cumulativePeelTicks = outcome.oversized.some((f) => f.exclusionReason === 'cumulative-limit')
    ? prev.cumulativePeelTicks + 1
    : 0;

  // EI-22154166487566939: the local-sync guard above is stopped in its own finally
  // (~2773-2777) before this point, so the record step + all 7 post-legs legs below
  // previously ran with ZERO idle/hard-timeout protection — a hang in any one of them
  // wedged `phase: 'post-legs'` indefinitely with no error ever recorded. Give this
  // phase its OWN independent guard, scoped exactly to the try/finally immediately
  // below, rather than extending the local-sync guard's lifetime (which would leave
  // its timers armed-but-unstopped on the early `return` at the live-lock-read
  // failure path above, silently corrupting a later tick's activity metadata up to
  // hardTimeoutMs later).
  const postLegsLiveness = createGitSyncActionLivenessGuard({
    idleTimeoutMs: gitSyncActionIdleTimeoutMs(),
    hardTimeoutMs: gitSyncActionHardTimeoutMs(),
    onTimeout: async (error) => {
      // Same shape as the local-sync guard's onTimeout. cleanupLocks() is
      // memoized/idempotent — safe even though local-sync's finally already
      // called it once; by this phase it is normally already a no-op.
      const activity = recordTimeoutActivity(error);
      await cleanupLocks();
      await activity;
    },
  });
  // EI-24496143892913296: the activity marker was written once at 'post-legs' and after
  // that only by the settlement's own progress callback, so once settlement ended (or hit
  // its 90s budget) every later leg — bootstrap, own-head-publish, ref-announce,
  // integrator, worktree-bridge — ran under a marker still reading
  // phase:'completion-settlement' with a frozen N/200 and a frozen updated_at.
  // routines:list then reported a healthy fire as "in flight, still recording progress"
  // and, after three intervals, as stuck (observed 2026-09-28 and 2026-09-30).
  // `postLegsMarker` tracks the last phase this action wrote (null until the explicit
  // 'post-legs' write below); a leg boundary restamps it when the marker is not already
  // a fresh 'post-legs' one. A full-object write also drops the stale settlement_progress.
  let postLegsMarker: { phase: GitSyncActivityPhase; at: number } | null = null;
  const stampPostLegsBoundary = async (leg: string): Promise<void> => {
    if (postLegsMarker === null || postLegsLiveness.timedOut) return;
    // The settlement leg owns the marker through its own progress callback.
    if (leg === 'git-sync:completion-settlement') return;
    const now = Date.now();
    if (postLegsMarker.phase === 'post-legs' && now - postLegsMarker.at < GIT_SYNC_ACTIVITY_HEARTBEAT_INTERVAL_MS) {
      return;
    }
    postLegsMarker = { phase: 'post-legs', at: now };
    await writeActivity({
      active: true,
      phase: 'post-legs',
      started_at: activityStartedAt,
      updated_at: now,
      completed_at: null,
      outcome_status: outcome.status,
      leg,
    }).catch(() => {});
  };
  const guardedPostLegs = <T>(phase: string, operation: () => Promise<T>): Promise<T> =>
    postLegsLiveness.run(async () => {
      await stampPostLegsBoundary(phase);
      return operation();
    }, phase);

  try {
    // STEP `git-sync:record` — outcome recording + the whole escalation/dispatch tail as
    // ONE checkpoint: a resumed fire that already recorded never re-appends the pipeline
    // event or re-decides escalations (the resolver/fixer dispatches inside are further
    // deduped by their own in-flight markers).
    await guardedPostLegs('git-sync:record', () =>
      runCheckpointedStep('git-sync:record', () =>
        recordAndEscalateTick({
          slug,
          workspaceId,
          repoPath,
          outcome,
          errTicks,
          contentTicks,
          prevContentTicks: prev.contentTicks,
          prevSignatureContentTicks,
          prevOversizedKeys: prev.oversizedKeys,
          cumulativePeelTicks,
          // EI-21230011589307899: surface a frozen own-head publish. Read from the
          // previous tick's publish leg — see readEscalationCounters.
          publishRefusal: prev.publishRefusal,
          prevPublishBlockedAtCommit: prev.prevPublishBlockedAtCommit,
          cfgBranch: cfg.branch,
          maxBlobBytes: cfg.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES,
          maxCommitTotalBytes: cfg.maxCommitTotalBytes ?? DEFAULT_MAX_COMMIT_TOTAL_BYTES,
          attributionOn,
          pushMode: effectivePushMode,
        }),
      ),
    );

    // `recordOutcome` writes the local stage's status before any GitHub bridge or
    // P2P post-leg runs. Keep that local result visible, but explicitly mark the
    // whole action non-terminal until every later leg has settled.
    await writeActivity({
      active: true,
      phase: 'post-legs',
      started_at: activityStartedAt,
      updated_at: Date.now(),
      completed_at: null,
      outcome_status: outcome.status,
    });
    postLegsMarker = { phase: 'post-legs', at: Date.now() };

    // event-await-… P-102: git-sync:committed[:<sha>] — wake anyone awaiting "is my
    // edit a local git commit yet". Remote origin/staging egress is a distinct,
    // later git-sync:egressed event emitted by runGithubBridgeLeg.
    // Only on a real commit (status 'synced' ⇒ something moved + headSha is set);
    // fire-and-forget, never gates the tick, benign to replay past the record step.
    if (outcome.status === 'synced') {
      emitGitSyncCommittedEvent(outcome.headSha, { scope: { installSlug: slug, workspaceId } });
    }

    const reconcileCommittedCompletions = async (): Promise<GitSyncActionTimeoutError | undefined> => {
      if (outcome.status !== 'synced') return undefined;
      // EI-22795123930445264: a completion belongs to the checkout that owns its
      // exact blob identities, which may differ from the bookkeeping harness that
      // accepted the close. Resolve the emitted checkout through symlinks before
      // selecting manifests so a Portal commit can settle Papercusp-owned rows.
      const repositoryRoot = repoPath ? await realpath(repoPath).catch(() => resolve(repoPath)) : null;
      if (!repositoryRoot) return undefined;
      // The local-sync lock set is released before post-legs so network work does not
      // hold a restart drain open. Completion settlement is a separate bounded DB pass;
      // reacquire only the shared restart barrier around it so dev:restart cannot kill
      // bg-host halfway through a close. The fresh owner gives this lease an independent
      // lifetime from the already-cleaned-up local-sync owner.
      const settlementLockOwner = newGitSyncLockOwner();
      const settlementResources: GitSyncLockRequest[] = [
        { resource: GIT_SYNC_RESTART_BARRIER_RESOURCE, mode: 'shared' },
      ];
      const settlementAcquired: GitSyncLockRequest[] = [];
      const settlementLock = await acquireLocks(cd, slug, settlementResources, settlementAcquired, settlementLockOwner);
      if (settlementLock.state !== 'acquired') {
        const reason =
          settlementLock.blockedReason ??
          (settlementLock.state === 'contended' ? 'lock_contended' : 'lock_infra_unavailable');
        console.warn(
          `[git-sync] ${slug}: completion settlement skipped because the shared restart barrier was unavailable (${reason}); ` +
            'remaining candidates will be retried on a later fire',
        );
        return undefined;
      }
      const stopSettlementLockHeartbeat = startLockHeartbeat(cd, slug, settlementAcquired, settlementLockOwner);
      try {
        let lastSettlementProgressAt = 0;
        let settlementProgressWrite = Promise.resolve();
        let settlementTimeout: GitSyncActionTimeoutError | undefined;
        const settlementBudgetMs = gitSyncCompletionSettlementBudgetMs();
        const settlementController = new AbortController();
        const abortSettlementOnActionTimeout = () => {
          if (!settlementController.signal.aborted) {
            settlementController.abort(postLegsLiveness.signal.reason);
          }
        };
        postLegsLiveness.signal.addEventListener('abort', abortSettlementOnActionTimeout, { once: true });
        if (postLegsLiveness.signal.aborted) abortSettlementOnActionTimeout();
        let settlementBudgetTimer: ReturnType<typeof setTimeout> | null = null;
        const settlementBudget = new Promise<never>((_resolve, reject) => {
          settlementBudgetTimer = setTimeout(() => {
            const error = new GitSyncCompletionSettlementBudgetError(settlementBudgetMs);
            // Reject first so abort listeners cannot win the race with a generic
            // cancellation error instead of the expected budget outcome.
            reject(error);
            settlementController.abort(error);
          }, settlementBudgetMs);
          settlementBudgetTimer.unref?.();
        });
        try {
          await Promise.race([
            guardedPostLegs('git-sync:completion-settlement', () =>
              runCheckpointedStep('git-sync:completion-settlement', () =>
                reconcileProposedCompletionsAtCommit(
                  outcome.headSha,
                  {
                    installSlug: slug,
                    workspaceId,
                    repositoryRoot,
                  },
                  {
                    signal: settlementController.signal,
                    onProgress: ({ completed, total, featureId }) => {
                      if (settlementController.signal.aborted) return;
                      postLegsLiveness.touch();
                      const now = Date.now();
                      if (
                        completed !== total &&
                        now - lastSettlementProgressAt < GIT_SYNC_ACTIVITY_HEARTBEAT_INTERVAL_MS
                      ) {
                        return settlementProgressWrite;
                      }
                      lastSettlementProgressAt = now;
                      postLegsMarker = { phase: 'completion-settlement', at: now };
                      settlementProgressWrite = settlementProgressWrite
                        .catch(() => {})
                        .then(() =>
                          writeActivity({
                            active: true,
                            phase: 'completion-settlement',
                            started_at: activityStartedAt,
                            updated_at: now,
                            completed_at: null,
                            outcome_status: outcome.status,
                            settlement_progress: {
                              completed,
                              total,
                              feature_id: featureId,
                            },
                          }),
                        )
                        .catch(() => {});
                      return settlementProgressWrite;
                    },
                  },
                ),
              ),
            ),
            settlementBudget,
          ]);
        } catch (error) {
          if (error instanceof GitSyncCompletionSettlementBudgetError) {
            console.warn(
              `[git-sync] ${slug}: completion settlement exceeded its ${error.timeoutMs}ms per-fire budget; ` +
                'the remaining candidates will be retried on a later fire',
            );
          } else {
            console.warn(
              `[git-sync] ${slug}: completion settlement reconcile failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            if (error instanceof GitSyncActionTimeoutError) settlementTimeout = error;
          }
        } finally {
          if (settlementBudgetTimer) clearTimeout(settlementBudgetTimer);
          postLegsLiveness.signal.removeEventListener('abort', abortSettlementOnActionTimeout);
          // EI-24496143892913296: a progress write queued before the budget abort must land
          // BEFORE the next leg restamps the marker, or it overwrites that restamp with a
          // stale 'completion-settlement' N/total.
          await settlementProgressWrite.catch(() => {});
        }
        return settlementTimeout;
      } finally {
        await stopSettlementLockHeartbeat();
        await releaseAll(cd, settlementLockOwner, settlementAcquired);
      }
    };

    // github-bridge P-008 (D-003: piggyback, no new scheduler): on a BRIDGED hive,
    // one bridge pass per tick — ingress origin → admission → egress canonical →
    // divergence verdict (all FF-only; origin never forced). Its own checkpoint so
    // a resumed fire that already bridged never re-runs the pass. Kill-switch:
    // FLAGS.GITHUB_BRIDGE (default ON; the per-hive `hiveGit.mode` setting is the
    // real activation — this leg only exists when the gate resolved 'bridged'). Run
    // origin/staging egress before completion settlement: a large proposed-close
    // backlog must not hold the remote push behind its bounded bookkeeping pass.
    let bridgeFailed = false;
    let bridgeFailure: unknown;
    try {
      if (gate.hiveGitMode === 'bridged' && (await getFlag(FLAGS.GITHUB_BRIDGE, slug))) {
        await guardedPostLegs('git-sync:github-bridge', () =>
          runCheckpointedStep('git-sync:github-bridge', () => runGithubBridgeLeg(slug, workspaceId)),
        );
      }
    } catch (error) {
      bridgeFailed = true;
      bridgeFailure = error;
    }

    let settlementFailed = false;
    let settlementFailure: unknown;
    let settlementTimeout: GitSyncActionTimeoutError | undefined;
    try {
      settlementTimeout = await reconcileCommittedCompletions();
    } catch (error) {
      settlementFailed = true;
      settlementFailure = error;
    }
    if (bridgeFailed) throw bridgeFailure;
    if (settlementFailed) throw settlementFailure;
    if (settlementTimeout) throw settlementTimeout;

    // p2p-git-live-activation P-205 (WI-3591, G-8): on ANY non-legacy hive, one
    // bootstrap-tick pass per git-sync tick, BEFORE ref-announce (P-202) — a
    // genuinely cold local mirror (zero `refs/namespaces/*` yet) has nothing for
    // ref-announce/integrator/worktree-bridge to read; seeding it first lets
    // this SAME tick's later legs already see the seeded heads. Self-gates as a
    // fast no-op the moment ANY namespace exists locally (runBootstrapLeg's own
    // `listNamespaces` check) — this is what makes G-8 safe across a
    // legacy→bridged→p2p-only→legacy→bridged mode cycle with NO re-seed: once a
    // repo has been seeded (by this leg or by normal own-work commits), no
    // later tick — regardless of how many times mode flips — ever re-attempts
    // it, per bootstrap.ts's own re-run contract (bootstrap.integration.test.ts
    // "a re-run seeds only namespaces NEW on the peer; existing ones are
    // skipped untouched"). Own checkpoint so a resumed fire never re-attempts
    // past it.
    if (gate.hiveGitMode) {
      await guardedPostLegs('git-sync:bootstrap', () =>
        runCheckpointedStep('git-sync:bootstrap', async () => {
          const bootstrap = await runWithGitSyncPerInstallLease(
            slug,
            workspaceId,
            () => runBootstrapLeg(slug, workspaceId),
            postLegsLiveness.signal,
          );
          if (bootstrap.state === 'skipped') {
            const detail = bootstrap.blockedOn ? `${bootstrap.reason} on ${bootstrap.blockedOn}` : bootstrap.reason;
            const message =
              `[git-sync] ${slug}: bootstrap-tick stood down — per-install lease unavailable ` +
              `(${detail}); the next scheduled tick retries`;
            if (bootstrap.reason === 'lock_infra_unavailable') console.warn(message);
            else console.log(message);
          }
        }),
      );
    }

    // G-2a (WI-5146): on ANY non-legacy hive, publish THIS device's own worktree
    // branch head into its own namespace in the bare store — the `git push rad`
    // analogue and the FIRST link every leg below consumes. MUST run after the
    // bootstrap leg (own-head-first would warm a genuinely cold store and
    // permanently skip G-8's one-shot cold-join) and before ref-announce (so the
    // same tick that ingests a new head signs + announces it). The G-10 publish
    // guard runs INSIDE the tick, before the ref write makes objects servable.
    // Own checkpoint so a resumed fire never re-publishes past it.
    if (gate.hiveGitMode) {
      await guardedPostLegs('git-sync:own-head-publish', () =>
        runCheckpointedStep('git-sync:own-head-publish', () => runOwnHeadPublishLeg(slug, workspaceId, cfg.branch)),
      );
    }

    // p2p-git-live-activation P-202: on ANY non-legacy hive (bridged OR
    // p2p-only), one ref-announce-tick pass per git-sync tick — publish this
    // device's own namespace advance (if any) hive-wide, then process any
    // pending peer ref-announcements into the local mirror. Runs BEFORE the
    // integrator leg (P-203) so it reads freshly-fetched member heads this
    // same tick, not last tick's. Own checkpoint so a resumed fire never
    // re-announces/re-receives past it.
    if (gate.hiveGitMode) {
      await guardedPostLegs('git-sync:ref-announce', () =>
        runCheckpointedStep('git-sync:ref-announce', () => runRefAnnounceLeg(slug, workspaceId)),
      );
    }

    // p2p-git-live-activation P-203: on ANY non-legacy hive (bridged OR
    // p2p-only), one integrator-tick pass per git-sync tick — the lock-authority
    // lease holder merges member namespace heads into staging + announces the
    // advance hive-wide; every other member's tick is a fast, correct no-op
    // (`skipped: 'not-integrator'`). Own checkpoint so a resumed fire never
    // re-integrates/re-announces past it.
    if (gate.hiveGitMode) {
      await guardedPostLegs('git-sync:integrator', () =>
        runCheckpointedStep('git-sync:integrator', () => runIntegratorLeg(slug, workspaceId)),
      );
    }

    // P-302/Leg A: the integrator may advance refs/hive/staging and publish its
    // handoff token after the normal ref-announce pass above has already signed
    // this device's namespace. Refresh the signed snapshot immediately after the
    // integrator so those integrator-authored refs are announced in the SAME
    // git-sync tick. This pass is publish-only: receiving the same pending peer
    // announcements twice would double-drive fetch failures and their budgets.
    if (gate.hiveGitMode) {
      await guardedPostLegs('git-sync:ref-announce-post-integrator', () =>
        runCheckpointedStep('git-sync:ref-announce-post-integrator', () =>
          runRefAnnounceLeg(slug, workspaceId, { receive: false }),
        ),
      );
    }

    // p2p-git-live-activation P-204: on ANY non-legacy hive (bridged OR
    // p2p-only), one worktree-bridge-tick pass per git-sync tick — process any
    // pending `hive-git:staging-advance` announcements this device hasn't
    // consumed yet and ff-advance the local worktree (G-7c/G-7b). Every
    // member's tick runs this (including the integrator's own — its worktree
    // follows staging too). Own checkpoint so a resumed fire never re-processes
    // past it.
    if (gate.hiveGitMode) {
      await guardedPostLegs('git-sync:worktree-bridge', () =>
        runCheckpointedStep('git-sync:worktree-bridge', () => runWorktreeBridgeLeg(slug, workspaceId)),
      );
    }
  } catch (error) {
    // EI-22154166487566939: mirror the local-sync phase's outer catch (~2756-2761) —
    // a guardedPostLegs timeout rejects with GitSyncActionTimeoutError naming the
    // exact leg that hung (e.g. 'git-sync:github-bridge'); record that specific
    // diagnosis instead of the generic write below, which would otherwise erase
    // which leg hung.
    if (error instanceof GitSyncActionTimeoutError) {
      await recordTimeoutActivity(error);
    } else {
      await writeActivity({
        active: false,
        phase: 'error',
        started_at: activityStartedAt,
        updated_at: Date.now(),
        completed_at: Date.now(),
        outcome_status: outcome.status,
      }).catch(() => {});
    }
    throw error;
  } finally {
    // Guarantee the post-legs guard's timers are cleared on every exit from this
    // try (the happy path falling through, or the catch above rethrowing) —
    // mirrors the local-sync phase's own finally (~2773-2777) for its guard.
    await postLegsLiveness.waitForTimeoutCleanup();
    postLegsLiveness.stop();
  }

  // P-004 / WI-305952: derive the FINAL published candidate after every Git
  // post-leg has settled. Persist its queued handoff BEFORE the activity marker
  // becomes terminal. The ordering is the crash-safety boundary: a bounded
  // `git-sync:run` or a DBOS fire cancelled after this point leaves enough data
  // for the next tick to reconstruct and resume the producer.
  let dependencyPrebuildRequest: DependencyPrebuildRequest | null = null;
  if (outcome.status === 'synced' && FULL_COMMIT_SHA.test(outcome.headSha)) {
    dependencyPrebuildRequest = {
      workspaceId,
      installSlug: slug,
      candidate: outcome.headSha,
      integrationRoot: repoPath ?? '',
      toolingRoot: process.env.PAPERCUSP_INTEGRATION_ROOT?.trim() ?? '',
      queuedAtMs: Date.now(),
    };
  }
  if (gate.hiveGitMode && repoPath && (outcome.status === 'synced' || outcome.status === 'nothing')) {
    // A bridged/P2P post-leg can advance the worktree AFTER runGitSync returns.
    // Resolve HEAD now so the producer follows the exact candidate the gate will
    // see, not merely this device's earlier local commit. A failed final probe
    // retains the proven full local head above; the next git-sync tick retries.
    const finalHead = await runGitBounded(
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      repoPath,
      gitTimeoutMsFor(['rev-parse']),
    ).catch(() => null);
    const resolved = finalHead?.code === 0 ? finalHead.stdout.trim() : '';
    if (FULL_COMMIT_SHA.test(resolved) && (outcome.status === 'synced' || !prevHeadSha || resolved !== prevHeadSha)) {
      dependencyPrebuildRequest = {
        workspaceId,
        installSlug: slug,
        candidate: resolved,
        integrationRoot: repoPath,
        toolingRoot: process.env.PAPERCUSP_INTEGRATION_ROOT?.trim() ?? '',
        queuedAtMs: Date.now(),
      };
    }
  }

  // Missing roots are an explicit no-op (the legacy/manual launcher may not
  // expose PAPERCUSP_INTEGRATION_ROOT); a queued marker from an earlier tick is
  // still recovered below using the roots persisted in that marker.
  if (
    dependencyPrebuildRequest &&
    (!dependencyPrebuildRequest.integrationRoot || !dependencyPrebuildRequest.toolingRoot)
  ) {
    dependencyPrebuildRequest = null;
  }

  let dependencyPrebuildQueued = false;
  if (dependencyPrebuildRequest) {
    try {
      // This UPDATE is one atomic candidate handoff on the existing routine row.
      // Do not move it below the terminal activity write or turn it into a
      // fire-and-forget promise: that was the production loss window.
      dependencyPrebuildQueued = await enqueueDependencyPrebuild(dependencyPrebuildRequest);
    } catch (error) {
      const failedAt = Date.now();
      await writeActivity({
        active: false,
        phase: 'error',
        started_at: activityStartedAt,
        updated_at: failedAt,
        completed_at: failedAt,
        outcome_status: outcome.status,
      }).catch(() => {});
      throw error;
    }
  }

  const completedAt = Date.now();
  try {
    await writeActivity({
      active: false,
      phase: 'complete',
      started_at: activityStartedAt,
      updated_at: completedAt,
      completed_at: completedAt,
      outcome_status: outcome.status,
    });
  } catch (error) {
    // EI-22053184584978917: the preceding post-legs marker is active, so a
    // terminal-write failure must not leave this fire looking indefinitely in
    // flight. Record an explicit terminal error marker before rethrowing so the
    // routine engine retries the failed tick without a stale `post-legs` state.
    const failedAt = Date.now();
    await writeActivity({
      active: false,
      phase: 'error',
      started_at: activityStartedAt,
      updated_at: failedAt,
      completed_at: failedAt,
      outcome_status: outcome.status,
    }).catch((metadataError) => {
      // If the metadata store is still unavailable, preserve the original
      // failure for the retry path and make the fallback failure observable.
      console.warn(
        `[git-sync] ${slug}: could not record terminal activity-write failure: ${
          metadataError instanceof Error ? metadataError.message : String(metadataError)
        }`,
      );
    });
    throw error;
  }

  // Start only after the queued handoff and terminal activity are both durable.
  // If another process already owns this candidate, leave it alone; a queued
  // marker that outlives that process is picked up by the next tick's recovery.
  if (dependencyPrebuildRequest && dependencyPrebuildQueued) {
    fireDependencyPrebuild(dependencyPrebuildRequest, 'published');
  } else {
    // A false enqueue result can mean an equal candidate was already queued by
    // a process that then exited. Re-read through the recovery helper; it is a
    // no-op for ready/building/failed markers and safely claims a queued one.
    fireQueuedDependencyPrebuildRecovery(workspaceId, slug);
  }

  // P-003/D-004: documentation freshness is advisory follow-up work, not part of
  // Git publication. A 983-record Papercusp corpus sweep updated 175 rows over
  // ~8m17s while this call sat inside `git-sync:record`, delaying the GitHub bridge
  // and leaving the activity marker falsely looking stuck in local-sync. Queue the
  // same idempotent sweep only AFTER every Git post-leg and the terminal activity
  // write; its per-harness single-flight coalesces later commits while it runs.
  if (outcome.status === 'synced') {
    try {
      const docs = docFreshnessModule ?? (await import('../docs/sweep-after-sync'));
      docs.enqueueDocFreshnessSweepAfterSync({
        harnessSlug: slug,
        workspaceId,
        repoRoot: repoPath,
        prevSha: prevHeadSha ?? undefined,
        headSha: outcome.headSha,
      });
    } catch (error) {
      // Best-effort still means observable: a silent enqueue failure permanently
      // drops this commit's doc-drift range while Git publication appears healthy.
      console.warn(
        `[git-sync] ${slug}: failed to queue post-sync doc freshness: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return outcome;
}

/** The P-008 bridge leg of one bridged-hive git-sync tick. Best-effort: never
 *  throws (the code plane must keep syncing even when GitHub is unreachable);
 *  outcome + the `last_admitted` watermark persist on the routine metadata. */
export interface RemoteTrackingRefreshOutcome {
  refreshed: boolean;
  trackingRef: string;
  observedSha: string | null;
  detail?: string;
}

/**
 * Refresh the checkout's remote-tracking staging ref from a bridge-proven tip.
 *
 * Non-legacy git-sync deliberately skips the ordinary fetch+merge path: the
 * P2P admission and worktree bridge own content flow. That also means their
 * local-path/ref-less fetches can leave FETCH_HEAD fresh while
 * refs/remotes/origin/staging remains stale. Keep the two surfaces separate:
 * an explicit remote refspec refreshes only the tracking ref, never the
 * worktree, and the bridge's writer-backed egressHead is the proof that makes
 * this read-only-to-content repair appropriate. The ancestry check refuses to
 * bless a remote rewind/divergence as a freshness update.
 */
export async function refreshRemoteTrackingRefFromProvenTip(
  repoPath: string,
  provenTip: string,
  opts: {
    remote?: string;
    runGit?: RunGit;
    log?: (message: string) => void;
  } = {},
): Promise<RemoteTrackingRefreshOutcome> {
  const remote = opts.remote ?? 'origin';
  const runGit = opts.runGit ?? defaultRunGit;
  const trackingRef = `refs/remotes/${remote}/staging`;
  const sourceRef = BRIDGE_REMOTE_STAGING_REF;
  const unchanged = (detail?: string): RemoteTrackingRefreshOutcome => ({
    refreshed: false,
    trackingRef,
    observedSha: null,
    ...(detail ? { detail } : {}),
  });

  if (!FULL_COMMIT_SHA.test(provenTip)) return unchanged('bridge egress proof was not a full commit sha');

  try {
    // The explicit <source>:<destination> refspec is intentional. A plain
    // FETCH_HEAD-only fetch is exactly the P2P failure mode this repairs, and
    // no merge is allowed because P2P admission owns worktree content.
    const fetched = await runGit(['fetch', '--no-tags', remote, `${sourceRef}:${trackingRef}`], repoPath);
    if (fetched.code !== 0) {
      return unchanged(`could not refresh ${trackingRef}: ${(fetched.stderr || fetched.stdout).trim().slice(0, 240)}`);
    }

    const observed = await runGit(['rev-parse', '--verify', '--quiet', `${trackingRef}^{commit}`], repoPath);
    const observedSha = observed.code === 0 ? observed.stdout.trim() : '';
    if (!FULL_COMMIT_SHA.test(observedSha)) {
      return unchanged(`refresh completed but ${trackingRef} could not be resolved`);
    }

    const contains = await runGit(['merge-base', '--is-ancestor', provenTip, observedSha], repoPath);
    if (contains.code !== 0) {
      return {
        refreshed: false,
        trackingRef,
        observedSha,
        detail: `${trackingRef} at ${observedSha.slice(0, 12)} does not contain proven egress ${provenTip.slice(0, 12)}`,
      };
    }

    opts.log?.(
      `[git-sync] refreshed ${trackingRef} from proven bridge egress ${provenTip.slice(0, 12)} ` +
        `(observed ${observedSha.slice(0, 12)})`,
    );
    return { refreshed: true, trackingRef, observedSha };
  } catch (error) {
    return unchanged(`could not refresh ${trackingRef}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The persisted error cap (`github_bridge.errors` keeps the first 10). */
const GITHUB_BRIDGE_PERSISTED_ERRORS = 10;

/**
 * WI-10006470: the journal line for a GitHub-bridge error TRANSITION, or null.
 *
 * `github_bridge.errors` holds only the latest tick, so a streak that clears leaves no
 * cause behind (a 3-sweep "remote could not be contacted" fault on hello-world-3-pot,
 * 2026-10-06, could not be diagnosed after it cleared). Returns a line when errors
 * start or change, and when a previously failing bridge comes back clean; null for a
 * clean tick after a clean tick and for an identical repeat (already journaled).
 * `prevErrors` is the raw persisted value, so anything that is not a string array
 * counts as "no previous errors".
 */
export function githubBridgeErrorTransitionLine(
  slug: string,
  prevErrors: unknown,
  errors: readonly string[],
  divergence: string,
): string | null {
  const prev = Array.isArray(prevErrors) ? prevErrors.filter((e): e is string => typeof e === 'string') : [];
  const current = errors.slice(0, GITHUB_BRIDGE_PERSISTED_ERRORS);
  const signature = (list: readonly string[]) => list.join('\n');
  if (current.length > 0) {
    if (signature(current) === signature(prev)) return null;
    return `[github-bridge] ${slug}: tick errors (divergence=${divergence}): ${current.join(' | ').slice(0, 1500)}`;
  }
  if (prev.length > 0) {
    return `[github-bridge] ${slug}: tick errors cleared (divergence=${divergence}; previous: ${prev
      .join(' | ')
      .slice(0, 500)})`;
  }
  return null;
}

export async function runGithubBridgeLeg(
  slug: string,
  workspaceId: string,
  opts: { remote?: string } = {},
): Promise<void> {
  try {
    let entry: ProjectEntry | undefined;
    try {
      entry = (await loadHarnessRegistry(workspaceId)).projects.find((p) => p.slug === slug);
    } catch {
      return; // registry unreadable — next tick retries
    }
    if (!entry) return;
    const potHomeSlug = entry.hive_slug ?? (entry.self_repo ? entry.slug : undefined);
    if (!potHomeSlug) return;
    // WI-5168: the wire+store repoKey is the FEDERATED cross-device identity
    // (github_repository_id when known), never the local install `slug` —
    // see repo-identity.ts's module header for why keying on `slug` broke G-8
    // for any two devices whose install slugs differ (nearly always).
    const repoKey = canonicalRepoKey(entry);
    const bareRepoPath = hiveGitRepoPath(potHomeSlug, repoKey);
    const protocolScope = await resolveHiveGitProtocolScope(workspaceId, potHomeSlug, repoKey);
    const ownerKey = await loadHiveEffectAuthority(workspaceId, potHomeSlug, protocolScope);
    const bridgeActor = ownerKey ? await resolveHiveGitActor(workspaceId, slug, potHomeSlug, repoKey) : null;
    const effectAuthority =
      ownerKey && bridgeActor
        ? {
            ...ownerKey,
            sign: async (bytes: Buffer) => {
              await bridgeActor.assertServing();
              return ownerKey.sign(bytes);
            },
          }
        : null;

    // The admission watermark (P-005): the last ADMITTED github-origin head.
    const { sql } = getOrgPg();
    const rows = await sql<
      { la: string | null; wb_sha: string | null; prev_egress_head: string | null; prev_errors?: unknown }[]
    >`
      SELECT metadata->'github_bridge'->>'last_admitted' AS la,
             metadata->'worktree_bridge'->>'stagingSha' AS wb_sha,
             metadata->'github_bridge'->>'egress_head' AS prev_egress_head,
             metadata->'github_bridge'->'errors' AS prev_errors
        FROM harness_shared.routines
       WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
       LIMIT 1
    `;
    const lastAdmitted = rows[0]?.la ?? null;
    const prevEgressHead = rows[0]?.prev_egress_head ?? null;
    const prevBridgeErrors = rows[0]?.prev_errors;

    // Catch-up pin (WI-3500): the bare-side canonical mirror (refs/hive/staging)
    // is maintained on staging-advance ACCEPTANCE (worktree-bridge step 3.5),
    // but advances accepted before that pin shipped — or a failed pin — leave
    // the ref missing while the watermark is already persisted, and egress then
    // silently no-ops every tick. Re-derive it from the accepted watermark when
    // absent (update-ref itself refuses a sha whose object is missing, so a
    // pruned mirror can't produce a dangling canonical ref).
    const wbSha = rows[0]?.wb_sha ?? null;
    if (wbSha) {
      // WI-6282: a COLD device has no store yet — `hiveGitRepoPath` only COMPUTES
      // a path (it never creates, unlike `ensurePotGitRepo`), and this leg runs
      // BEFORE the bootstrap leg that does. Spawning git with a nonexistent cwd
      // makes Node report ENOENT ON THE BINARY, so the warning below used to read
      // "spawn git ENOENT" — i.e. "git is not installed", which sends whoever is
      // debugging a failed join looking for the wrong thing entirely.
      // LIVE-REPRODUCED on the P-302 rig 2026-07-27: exactly once, on the first
      // tick after the store was deliberately removed, never on a warm tick.
      // SKIP rather than create: the pin is meaningless on a store with no
      // objects (update-ref refuses a sha whose object is missing), and store
      // lifecycle belongs to the bootstrap leg, not here. This makes the failure
      // impossible instead of merely handled — the next tick, post-bootstrap,
      // finds a real store and pins normally.
      if (await pathExists(join(bareRepoPath, 'HEAD'))) {
        const existing = await defaultRunGit(['rev-parse', '--verify', '--quiet', BRIDGE_CANONICAL_REF], bareRepoPath);
        if (existing.code !== 0) {
          const pinned = await defaultRunGit(['update-ref', BRIDGE_CANONICAL_REF, wbSha], bareRepoPath);
          if (pinned.code !== 0) {
            // Name the PATH: `pinned.stderr` alone produced a message with no
            // path in it, which is why the original report could not tell a
            // missing cwd from a missing binary.
            console.warn(
              `[git-sync] ${slug}: bare canonical catch-up pin failed for ${bareRepoPath}: ${pinned.stderr.trim()}`,
            );
          }
        } else {
          // EI-18751829787526583: the ref EXISTS but can still be STALE — the
          // absent-only branch above never re-derives it. worktree-bridge's
          // step-3.5 `update-ref` (worktree-bridge.ts) is best-effort and
          // UNCHECKED, so it can fail without leaving canonical absent,
          // pinning it at an old sha instead. Egress then publishes exactly
          // that stale content and reports `upToDate`/`clear` — green — while
          // origin freezes (the incident this fixes: 21 commits / ~3h). Only
          // re-pin a STRICT ANCESTOR (never a diverged/ahead ref — that is a
          // different problem, not this pin's to silently resolve), and CAS
          // against what we just read so a genuinely concurrent legitimate
          // advance loses cleanly instead of being clobbered.
          const existingSha = existing.stdout.trim();
          if (existingSha && existingSha !== wbSha) {
            const isAncestor = await defaultRunGit(['merge-base', '--is-ancestor', existingSha, wbSha], bareRepoPath);
            if (isAncestor.code === 0) {
              const pinned = await defaultRunGit(
                ['update-ref', BRIDGE_CANONICAL_REF, wbSha, existingSha],
                bareRepoPath,
              );
              if (pinned.code !== 0) {
                console.warn(
                  `[git-sync] ${slug}: bare canonical stale re-pin failed for ${bareRepoPath} ` +
                    `(${existingSha.slice(0, 12)} → ${wbSha.slice(0, 12)}): ${pinned.stderr.trim()}`,
                );
              } else {
                console.warn(
                  `[git-sync] ${slug}: bare canonical ${BRIDGE_CANONICAL_REF} was STALE at ${existingSha.slice(0, 12)} ` +
                    `(behind accepted watermark ${wbSha.slice(0, 12)}) — re-pinned`,
                );
              }
            }
          }
        }
      }
    }

    // Upstream-write probe only when it can matter (a fork always wins — D-007b).
    let upstreamWrite: boolean | null = null;
    if (entry.github_remote && !entry.fork_remote) {
      const parsed = parseGithubUrl(entry.github_remote);
      if (parsed) upstreamWrite = await fetchRepoPushPermission(parsed.owner, parsed.repo);
    }

    // The bridge's bare store does not inherit the per-account helper that may
    // be pinned in the registered checkout's `.git/config` (oddsmith's
    // `gh-credential-ownerhandle.sh` is the live example). Read that local config
    // once and let the bridge apply it to network argv only; local bare-store
    // plumbing and the configured remote remain untouched.
    const githubCredentialHelper = await resolveGithubCredentialHelper(entry.path);

    const outcome = await runGithubBridgeTick({
      scope: protocolScope,
      authority: effectAuthority,
      potHomeSlug,
      workspaceId,
      repoKey,
      githubRemote: entry.github_remote,
      historySourcePath: entry.path,
      forkRemote: entry.fork_remote,
      branches: [entry.github_default_branch ?? 'main'],
      upstreamWrite,
      githubCredentialHelper,
      lastAdmitted,
      // EI-18751829787526583: the same watermark the catch-up pin above just
      // re-derived from — passed through as a BACKSTOP so a case the pin
      // declined to touch (diverged rather than a strict ancestor) or a
      // re-pin that itself failed still surfaces as `egress-canonical-stale`
      // instead of silently reading `divergence: clear`.
      expectedCanonicalSha: wbSha,
    });

    // WI-10006470: `github_bridge.errors` below is replaced wholesale every tick, so
    // once an error streak clears its cause is gone from PG. Journal the streak's
    // start/change and its clearing (never every repeat tick) so it stays recoverable.
    const bridgeErrorLine = githubBridgeErrorTransitionLine(
      slug,
      prevBridgeErrors,
      outcome.errors,
      outcome.verdict.action,
    );
    if (bridgeErrorLine) console.warn(bridgeErrorLine);

    // EI-22754766601034346: P2P/local-path fetches intentionally do not update
    // the checkout's refs/remotes/*, so a fresh bridge egress can coexist with a
    // stale origin/staging containment ref. Refresh only after upstream egress
    // proof; fork egress must not be misrepresented as origin egress.
    if (outcome.egressTarget === 'upstream' && outcome.egressHead && entry.path) {
      const refresh = await refreshRemoteTrackingRefFromProvenTip(entry.path, outcome.egressHead, {
        remote: opts.remote,
      });
      if (!refresh.refreshed && refresh.detail) {
        console.warn(`[git-sync] ${slug}: remote-tracking freshness refresh skipped — ${refresh.detail}`);
      }
    }

    // A bridge egress rejection is reported by the bridge escalation writer, but
    // this leg runs AFTER recordOutcome (which may have recorded a clean commit
    // tick). Promote owner-actionable bridge verdicts into the routine's primary
    // health metadata too; otherwise a missing GitHub workflow scope leaves
    // `last_status: synced` + `last_error: null` beside a red github_bridge row.
    // Self-healing bridge residues (for example a stale canonical ref) stay in
    // github_bridge only and must not turn the whole git-sync tick red.
    // Do not write local_sync_status/local_sync_head_sha here: those fields are
    // the stage-aware evidence recorded by recordOutcome immediately before this
    // leg, and must survive an egress-only failure for the watchdog to classify it
    // as a failing bridge leg rather than a commit strand.
    const ownerActionableBridgeFailure = outcome.verdict.action === 'escalate' && outcome.verdict.needsOwner;
    const bridgeError = ownerActionableBridgeFailure
      ? outcome.verdict.detail || outcome.errors.join('; ') || 'github-bridge owner action required'
      : null;

    await patchRoutineMetadata(slug, workspaceId, {
      ...(bridgeError
        ? {
            last_status: 'error',
            last_error: bridgeError,
            last_errors: outcome.errors.slice(0, 10),
          }
        : {}),
      github_bridge: completeGithubBridgeState({
        at: Date.now(),
        ran: outcome.ran,
        skipped: outcome.skipped ?? null,
        egress_target: outcome.egressTarget,
        ingressed: outcome.ingressed,
        egress: outcome.egress,
        last_admitted: outcome.lastAdmitted,
        divergence: outcome.verdict.action,
        needs_owner: outcome.verdict.needsOwner,
        agent_actionable: outcome.verdict.agentActionable === true,
        agent_remedies: outcome.verdict.agentRemedies ?? [],
        // WI-5738: the truthful egress watermark the origin-freshness watchdog
        // measures against (see GithubBridgeTickOutcome.egressHead).
        //
        // STICKY — a tick that egressed nothing must NOT erase it. This whole
        // `github_bridge` object is replaced wholesale on every patch, so
        // writing a bare `?? null` let one quiet tick (nothing to push, or the
        // leg skipped before egress) blank the field. The watchdog then falls
        // back to the ingress mirror of `github_default_branch` — the exact
        // signal proven blind in this incident, because the release pipeline
        // fast-forwards it hourly regardless of whether egress is wedged. So a
        // single quiet tick silently reverted the watchdog to the broken
        // detector it was fixed to stop using. The field means "what egress
        // LAST landed", so absence of a new observation must leave the last
        // one standing.
        egress_head: outcome.egressHead ?? prevEgressHead,
        errors: outcome.errors.slice(0, 10),
      }),
    });

    // EI-20331175777179195: a local `synced` outcome is NOT proof that a bridged
    // hive reached origin/staging. GithubBridgeTickOutcome.egressHead is populated
    // only when the remote staging ref was pushed or was already at canonicalSha.
    // Emit after the metadata write so a woken waiter can immediately verify the
    // same writer-backed watermark. A skipped/failed/no-egress tick emits nothing.
    if (outcome.egressHead) {
      const includedShas = await newlyEgressedCommitShas(outcome.egressHead, bareRepoPath, prevEgressHead);
      if (includedShas.length > 0) {
        emitGitSyncEgressedEvent(outcome.egressHead, { scope: { installSlug: slug, workspaceId } }, { includedShas });
      } else {
        emitGitSyncEgressedEvent(outcome.egressHead, { scope: { installSlug: slug, workspaceId } });
      }
    }
  } catch (e) {
    console.warn(`[git-sync] ${slug}: github-bridge pass failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** The G-2a own-head publish leg of one non-legacy-hive git-sync tick
 *  (WI-5146): resolve this device + the harness worktree and run ONE
 *  own-head-publish pass — worktree branch head → own namespace in the
 *  (hive, repo) bare store, G-10-guarded inside the tick. Best-effort like
 *  its sibling legs: never throws; a guard REFUSAL is logged loudly (a
 *  planted secret silently un-published is exactly the failure G-10 exists
 *  to make visible) and recorded on the routine metadata. */
/* WI-6243: the genesis-publish baseline moved to ./genesis-baseline.ts so it is
 * testable over the injected git seam (importing THIS module needs the action
 * suite's full mock harness). Both G-10 consumers below call it unchanged. */

/**
 * EI-19341838904344665: `outcome.headSha` is the worktree head JUDGED this tick —
 * current by construction, every tick — NOT what became servable. WI-5738 made
 * this publish INCREMENTAL: it CAS-writes `outcome.publishedSha`, which can trail
 * the head by hundreds of commits. Logging `headSha` beside "published" asserted a
 * sha was published when it was not — the false, authoritative-looking line that
 * produced two OPPOSITE wrong diagnoses from two separate agents during the
 * 2026-08-02 freeze (one read it as "the ref is stuck", the other as "the producer
 * is healthy"). Reports what actually became servable, and says plainly when
 * backlog remains (see EI-19341709637436070 for why the field is named
 * `backlogRemains`, not `drained`).
 *
 * Extracted as a pure function (rather than inlined at the `console.log` call
 * site) so the exact wording is unit-testable without running a real git tick.
 */
export function formatOwnHeadPublishedLine(slug: string, outcome: OwnHeadPublishTickOutcome): string {
  const published = outcome.publishedSha?.slice(0, 12) ?? 'nothing';
  const backlogNote = outcome.backlogRemains
    ? ` (BACKLOG REMAINS; worktree head ${outcome.headSha?.slice(0, 12)})`
    : '';
  return `[git-sync] ${slug}: own-head published ${outcome.branch}@${published} into own namespace${backlogNote}`;
}

/**
 * EI-24099226502437988: the own-head leg used to exit SILENTLY on its
 * preconditions (registry unreadable, no worktree path, no hive slug, no device
 * actor): no log line and no metadata write. On 2026-09-23 `own_head_publish`
 * froze at its last real run (22:15Z) while fires kept committing locally, and
 * origin/staging sat frozen for hours with nothing to say which exit had fired.
 *
 * Every exit now names itself: a warn line plus an `own_head_publish_skip`
 * metadata record, which the next real publish clears to null. The later of
 * `own_head_publish.at` and `own_head_publish_skip.at` is therefore the last time
 * the leg actually RAN. If both are stale while fires keep completing, the fires
 * are not reaching the post-legs at all.
 */
export type OwnHeadPublishSkipReason =
  | 'registry-unreadable'
  | 'no-worktree-path'
  | 'no-hive-slug'
  | 'no-device-actor'
  | 'leg-failed';

export interface OwnHeadPublishSkipRecord {
  at: number;
  reason: OwnHeadPublishSkipReason;
  detail: string | null;
}

const OWN_HEAD_PUBLISH_SKIP_MEANING: Record<OwnHeadPublishSkipReason, string> = {
  'registry-unreadable': 'the harness registry could not be read',
  'no-worktree-path': 'this install has no registry entry with a worktree path',
  'no-hive-slug': 'this install names no hive (no hive_slug and not self_repo)',
  'no-device-actor': 'no serving device actor resolved (serving not ready, or no device identity)',
  'leg-failed': 'the leg threw',
};

/** Pure so the exact wording is unit-testable without a real git tick. */
export function formatOwnHeadPublishSkipLine(
  slug: string,
  reason: OwnHeadPublishSkipReason,
  detail?: string | null,
): string {
  const tail = detail ? ` (${detail.slice(0, 300)})` : '';
  return (
    `[git-sync] ${slug}: own-head publish SKIPPED — ${reason}: ${OWN_HEAD_PUBLISH_SKIP_MEANING[reason]}${tail}; ` +
    `nothing published this tick, the next tick retries`
  );
}

/** Persist the skip. A failed write is logged, never thrown: the leg stays best-effort. */
async function persistOwnHeadPublishSkip(
  slug: string,
  workspaceId: string,
  reason: OwnHeadPublishSkipReason,
  detail: string | null,
): Promise<void> {
  const record: OwnHeadPublishSkipRecord = { at: Date.now(), reason, detail };
  try {
    await patchRoutineMetadata(slug, workspaceId, { own_head_publish_skip: record });
  } catch (e) {
    console.warn(`[git-sync] ${slug}: could not record own-head publish skip: ${e instanceof Error ? e.message : e}`);
  }
}

async function recordOwnHeadPublishSkip(
  slug: string,
  workspaceId: string,
  reason: OwnHeadPublishSkipReason,
  detail: string | null,
): Promise<void> {
  console.warn(formatOwnHeadPublishSkipLine(slug, reason, detail));
  await persistOwnHeadPublishSkip(slug, workspaceId, reason, detail);
}

async function runOwnHeadPublishLeg(slug: string, workspaceId: string, branch: string | undefined): Promise<void> {
  try {
    let entry: ProjectEntry | undefined;
    try {
      entry = (await loadHarnessRegistry(workspaceId)).projects.find((p) => p.slug === slug);
    } catch (e) {
      // The next tick retries.
      await recordOwnHeadPublishSkip(slug, workspaceId, 'registry-unreadable', e instanceof Error ? e.message : String(e));
      return;
    }
    if (!entry?.path) {
      await recordOwnHeadPublishSkip(
        slug,
        workspaceId,
        'no-worktree-path',
        entry ? 'the registry entry has no path' : 'no registry entry for this slug',
      );
      return;
    }
    const potHomeSlug = entry.hive_slug ?? (entry.self_repo ? entry.slug : undefined);
    if (!potHomeSlug) {
      await recordOwnHeadPublishSkip(slug, workspaceId, 'no-hive-slug', null);
      return;
    }
    // WI-5168: federated repoKey — see repo-identity.ts.
    const repoKey = canonicalRepoKey(entry);

    const actor = await resolveHiveGitActor(workspaceId, slug, potHomeSlug, repoKey);
    if (!actor?.devicePubkey) {
      // gh unauthenticated or serving not ready: no device identity to publish as.
      await recordOwnHeadPublishSkip(
        slug,
        workspaceId,
        'no-device-actor',
        actor
          ? 'the resolved actor has no device pubkey'
          : 'resolveHiveGitActor returned null; its serving line above names why',
      );
      return;
    }

    const genesisBaselineSha = await deriveGenesisBaselineSha(entry, branch);

    // WI-2142873: a shallow worktree's unshallow gets a budget strictly inside
    // this leg's idle deadline, and a failed attempt backs off (persisted), so an
    // unshallow that cannot finish no longer aborts the whole post-legs phase —
    // which silently starved ref-announce/integrator/worktree-bridge every tick.
    const { sql: unshallowSql } = getOrgPg();
    const unshallowRows = await unshallowSql<{ state: OwnHeadUnshallowBackoffState | null }[]>`
      SELECT metadata->'own_head_unshallow' AS state
        FROM harness_shared.routines
       WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
       LIMIT 1
    `;
    const priorUnshallow = unshallowRows[0]?.state ?? null;

    const outcome = await runOwnHeadPublishTick({
      potHomeSlug,
      repoKey,
      worktreePath: entry.path,
      branch,
      devicePubkeyBase64: actor.devicePubkey,
      genesisBaselineSha,
      workspaceId,
      unshallowTimeoutMs: boundedUnshallowTimeoutMs(gitSyncActionIdleTimeoutMs()),
      unshallowDeferredUntil: priorUnshallow?.nextAttemptAt ?? null,
    });
    const nextUnshallow = nextUnshallowBackoff(priorUnshallow, outcome.unshallow, Date.now());
    if (nextUnshallow !== priorUnshallow) {
      await patchRoutineMetadata(slug, workspaceId, { own_head_unshallow: nextUnshallow });
      if (nextUnshallow) {
        console.warn(
          `[git-sync] ${slug}: own-head unshallow failed (attempt ${nextUnshallow.failures}); ` +
            `deferring until ${new Date(nextUnshallow.nextAttemptAt).toISOString()} so later legs keep running`,
        );
      }
    }
    if (outcome.refused) {
      console.warn(
        `[git-sync] ${slug}: own-head publish REFUSED — ${describePublishRefusal(outcome.refused)}; ` +
          `head ${outcome.headSha?.slice(0, 12)} NOT published (namespace ref unchanged, nothing servable). ` +
          `Recovery (WI-5591, no restart needed): if this is a false positive, insert a row into ` +
          `harness_shared.secrets_guard_path_exemptions for the offending path(s) — the next tick will retry.`,
      );
    }
    if (outcome.exemptedFindings.length > 0) {
      // WI-5591 audit trail: a runtime path exemption suppressed finding(s) this
      // tick — always logged (whether or not the publish ultimately admitted) so
      // an exemption's use is never silent.
      console.warn(
        `[git-sync] ${slug}: own-head publish — ${outcome.exemptedFindings.length} secret-scanner finding(s) ` +
          `suppressed by a runtime path exemption: ${outcome.exemptedFindings
            .slice(0, 5)
            .map((f) => `${f.path}:${f.line} [${f.rule}]`)
            .join('; ')}`,
      );
    }
    if (outcome.errors.length) {
      console.warn(`[git-sync] ${slug}: own-head publish reported errors: ${outcome.errors.join('; ').slice(0, 500)}`);
    }
    if (outcome.changed) {
      console.log(formatOwnHeadPublishedLine(slug, outcome));
    }
    await patchRoutineMetadata(slug, workspaceId, {
      own_head_publish: completeOwnHeadPublishState({
        at: Date.now(),
        changed: outcome.changed,
        branch: outcome.branch,
        sha: outcome.headSha,
        // WI-7009: `sha` above is the worktree head JUDGED this tick — NOT what
        // became servable. WI-5738 made this publish INCREMENTAL: it drains the
        // range and CAS-writes `publishedSha` (the guard's furthest safe sha),
        // which can trail the head by hundreds of commits while the remainder
        // drains over following ticks. Recording only `sha` beside
        // `changed: true` reads on every health surface as "the head is
        // published", and that is precisely how a canonical-staging freeze hid
        // for ~6h on 2026-08-02: the namespace head sat ~114 commits back, so
        // the integrator could only announce shas that were ANCESTORS of the
        // already-accepted watermark; the bridge rejected each one
        // non-fast-forward — a TERMINAL reason, which skips-and-continues and
        // logs NOTHING — and `last_status` stayed 'synced' throughout. Every
        // field needed to see it was already computed here and then dropped
        // (`oversizedCommit`'s own doc-comment says it is named "so the health
        // layer can raise it" — the health layer was never given it).
        publishedSha: outcome.publishedSha ?? null,
        // EI-19341709637436070: persisted key renamed drained -> backlogRemains (was
        // named backwards — see OwnHeadPublishTickOutcome.backlogRemains's doc comment).
        // Alpha, no users: migrate the key outright rather than aliasing it.
        backlogRemains: outcome.backlogRemains ?? false,
        blockedAtCommit: outcome.blockedAtCommit ?? null,
        oversizedCommit: outcome.oversizedCommit ?? null,
        refused: outcome.refused?.refusalCode ?? null,
        // WI-5591: count of findings suppressed by a runtime path exemption
        // this tick — a health check reading `refused` alone would otherwise
        // stay blind to an exemption quietly keeping the plane un-wedged.
        exemptedFindingsCount: outcome.exemptedFindings.length,
      }),
      // EI-24099226502437988: the leg ran, so any earlier skip record is stale.
      own_head_publish_skip: null,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[git-sync] ${slug}: own-head publish leg failed: ${message}`);
    await persistOwnHeadPublishSkip(slug, workspaceId, 'leg-failed', message);
  }
}

/**
 * p2p-git-live-activation P-205 (WI-3591) / P-302 (dial wiring): the G-8
 * cold-clone bootstrap leg — the production path a fresh JOINER's git-sync
 * tick actually hits. Best-effort: never throws; outcome persists on the
 * routine metadata under the `bootstrap` key (distinct from
 * `ref_announce`/`integrator`/`worktree_bridge` so the four legs never
 * clobber each other's watermark).
 *
 * SELF-GATE (the "reachable but only when it matters" contract): fast no-op
 * unless the local hive-git bare store has ZERO `refs/namespaces/*` yet
 * (`listNamespaces` — storage.ts). Any prior namespace (this device's own
 * work, or a namespace already seeded by an earlier bootstrap tick) means
 * this leg has nothing to do — `bootstrapFromPeer` itself is also safe to
 * re-run (existing namespaces are left untouched per its own rewind-safety
 * contract), but gating here avoids paying a wildcard-fetch attempt on every
 * tick once a repo is warm.
 *
 * DIAL-REGISTRY (WI-3583, landed 2026-07-10; wired HERE 2026-07-10 P-302):
 * this leg used to always hand `bootstrapFromPeer` an already-destroyed stub
 * duplex (no way to name a peer to dial), the ONE of the four Phase-3 legs
 * left on that pre-WI-3583 shape after `runRefAnnounceLeg`/worktree-bridge
 * picked up the real dial. Same pattern as `runRefAnnounceLeg`'s `openStream`
 * above: resolve this harness's live swarm topic via
 * `getBootedHarness(...).swarm.topicHex`, pick any ONE attested member peer
 * that is not this device (bootstrap only needs ONE source — "the caller
 * picks any live peer", per bootstrap.ts's own doc), and dial it through
 * `openHiveGitDuplexToDevice`. Two fail-soft floors, neither ever throws: (a)
 * no live swarm join yet for this harness ⇒ an already-destroyed local stub,
 * same shape as before WI-3583; (b) no member peer other than self yet (a
 * lone device) ⇒ skip, nothing to bootstrap from. Either way a cold repo
 * reports the documented clean `ok:false` (`fetch-failed`, matching
 * `fetchOverDuplex`'s fail-soft contract) and retries next tick; only genuine
 * cross-machine reachability (Phase 3's live rig, P-302) exercises the happy
 * path end-to-end.
 */
/**
 * Resolve the live swarm topic for a hive-git-enabled LOCAL install, DEMANDING
 * a boot when the substrate isn't currently resident in this process
 * (WI-5247).
 *
 * The lookup key is deliberately the runnable install slug, NOT the pot-home
 * slug. They are identical on a hive home, which hid this distinction in the
 * original tests, but differ on a joined member (`hello-world` locally views
 * the `hello-world-3-pot` hive). `boot-all` indexes its in-memory handles by
 * that local registry entry; looking up the pot home on a joiner therefore
 * returned a permanent no-topic stub even while the joiner's actual swarm was
 * healthy and connected (WI-3496 physical Phase A, 2026-08-14).
 *
 * `getBootedHarness` only re-boots an engine the P-008 reaper EVICTED —  a
 * harness that was simply never booted in this process (a joined hive whose
 * workspace didn't happen to boot-sweep it, or any process restart with an
 * empty in-memory handle cache) falls through it as a silent, permanent
 * `null`: LAZY_SUBSTRATE_BOOT's "boot sweep boots only actively-demanded
 * harnesses" contract requires SOMETHING to register that demand, and
 * nothing did. Every git-sync tick for a hiveGit-enabled harness IS genuine
 * demand for its substrate, so treat "not currently booted" the same as
 * "evicted": fire a background `bootSingleHarness` (idempotent — coalesces
 * on its own `inflight` map, and a no-op once already booted, so calling it
 * every tick from every leg here is safe) so the substrate eventually comes
 * up and a LATER tick finds a live topic instead of the harness staying
 * stranded forever. Best-effort: never throws into the calling git-sync tick.
 */
interface HiveGitDialContext {
  /** Present only for an in-process swarm. A relocated sidecar owns its topic
   * and observability maps, so main-process diagnostics must stay UNKNOWN. */
  topicHex?: string;
  path: 'in-process' | 'sidecar' | 'sidecar-advertised';
  openDuplex(devicePubkeyBase64: string, request: HiveGitDuplexRequest): Promise<Duplex>;
}

interface RelocatedHiveGitDialHandle {
  openHiveGitDuplexToDevice(devicePubkeyBase64: string, request: HiveGitDuplexRequest): Promise<Duplex>;
}

function hasRelocatedHiveGitDial(handle: unknown): handle is RelocatedHiveGitDialHandle {
  return (
    typeof handle === 'object' &&
    handle !== null &&
    typeof (handle as Partial<RelocatedHiveGitDialHandle>).openHiveGitDuplexToDevice === 'function'
  );
}

/** P-514: only the process serving the requested hive/repository may choose
 * the signing identity and store generation. Discovery failures are retryable;
 * a gh login is never serving evidence. */
interface ServingHiveGitActor extends HiveGitActor {
  capability: GitServingCapability;
  sign(bytes: Buffer): Promise<Buffer>;
  assertServing(): Promise<void>;
}

interface GitServingRecoveryHandle {
  getGitServingCapability?(request: GitServingRequest): Promise<GitServingState>;
}

interface GitServingBootResult {
  state: 'booted' | 'already-booted' | 'failed' | 'deferred';
  error?: string;
}

export interface GitServingResolutionDeps {
  getBootedHarness?(workspaceId: string, harnessSlug: string): GitServingRecoveryHandle | null;
  bootSingleHarness?(workspaceId: string, harnessSlug: string): Promise<GitServingBootResult>;
  getPgGitServingCapability?(request: GitServingRequest): Promise<GitServingState>;
}

/**
 * Resolve the current serving-owner capability, recovering an omitted local
 * handle through the existing lazy-boot primitive before giving up.
 *
 * WI-10000734: the old fire-and-forget recovery discarded BootSingleResult.
 * When the owner snapshot was live but `handles=[]`, every git-sync leg
 * returned `absent`, launched the same background boot, and continued without
 * learning whether it failed. The next 10s publisher beat stayed empty and the
 * next 3m git-sync tick repeated the loop, stranding signed root publication.
 * Await the coalesced boot once, then read the newly registered in-process
 * handle immediately; a failure remains fail-closed but now carries its exact
 * reason instead of the misleading outer `no_device_identity` label.
 */
export async function resolveGitServingStateWithBootRecovery(
  request: GitServingRequest,
  deps: GitServingResolutionDeps = {},
): Promise<GitServingState> {
  const bootAll = deps.getBootedHarness && deps.bootSingleHarness ? null : await import('../../sync/hyperbee/boot-all');
  const getBootedHarness = deps.getBootedHarness ?? bootAll!.getBootedHarness;
  const bootSingleHarness = deps.bootSingleHarness ?? bootAll!.bootSingleHarness;
  const getPgGitServingCapability =
    deps.getPgGitServingCapability ??
    (await import('../../sync/hyperbee/substrate-booted-handles-pg')).getPgGitServingCapability;

  const readLocal = async (): Promise<GitServingState | null> => {
    let localAnswer: GitServingState | null = null;
    for (const servingSlug of new Set([request.installSlug, request.potHomeSlug])) {
      const handle = getBootedHarness(request.workspaceId, servingSlug);
      if (!handle) continue;
      const answer = validateGitServingState(await handle.getGitServingCapability?.(request), request);
      if (answer.status === 'ready') return answer;
      localAnswer ??= answer;
    }
    return localAnswer;
  };

  const local = await readLocal();
  if (local?.status === 'ready') return local;
  const advertised = validateGitServingState(await getPgGitServingCapability(request), request);
  if (advertised.status === 'ready') return advertised;
  // A real local handle answered, but is not currently serving this request.
  // bootSingleHarness would only return already-booted and cannot repair that
  // state; preserve its more direct evidence instead of obscuring it.
  if (local) return local;

  let boot: GitServingBootResult;
  try {
    boot = await bootSingleHarness(request.workspaceId, request.installSlug);
  } catch (error) {
    return {
      status: 'unknown',
      retryable: true,
      reason: `lazy serving recovery threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (boot.state === 'failed') {
    return {
      status: 'unknown',
      retryable: true,
      reason: `lazy serving recovery failed: ${boot.error ?? 'boot returned no error detail'}`,
    };
  }
  const recovered = await readLocal();
  if (recovered) return recovered;
  const refreshed = validateGitServingState(await getPgGitServingCapability(request), request);
  if (refreshed.status === 'ready') return refreshed;
  return {
    status: 'unknown',
    retryable: true,
    reason: `lazy serving recovery returned ${boot.state}, but no serving handle was registered (${refreshed.status}: ${refreshed.reason})`,
  };
}

export async function resolveHiveGitActor(
  workspaceId: string,
  installSlug: string,
  potHomeSlug: string,
  repoKey: string,
  deps: GitServingResolutionDeps = {},
): Promise<ServingHiveGitActor | null> {
  try {
    const request: GitServingRequest = {
      workspaceId,
      installSlug,
      potHomeSlug,
      scope: await resolveHiveGitProtocolScope(workspaceId, potHomeSlug, repoKey),
    };
    const resolve = (): Promise<GitServingState> => resolveGitServingStateWithBootRecovery(request, deps);
    const state = validateGitServingState(await resolve(), request);
    if (state.status !== 'ready') {
      console.warn(
        `[git-sync] ${installSlug}: serving unavailable (${state.status}: ${state.reason}); retry next tick`,
      );
      return null;
    }
    const capability = state.capability;
    const actor = pickHiveGitActor(state, request);
    if (!actor) return null;
    const { keychainId } = actor;
    return {
      ...actor,
      assertServing: () => assertGitServingCapability(capability, request, resolve),
      sign: guardGitServingSigner(capability, request, resolve, (bytes) => signWithDeviceKey(keychainId, bytes)),
    };
  } catch (error) {
    console.warn(
      `[git-sync] ${installSlug}: serving unavailable (unknown: ${error instanceof Error ? error.message : String(error)}); retry next tick`,
    );
    return null;
  }
}

async function resolveHiveGitDialContext(
  workspaceId: string,
  installSlug: string,
): Promise<HiveGitDialContext | undefined> {
  const { getBootedHarness, bootSingleHarness } = await import('../../sync/hyperbee/boot-all');
  const handle = getBootedHarness(workspaceId, installSlug);
  if (!handle) {
    // EI-20438405483051865: routines and the substrate owner can be separate OS
    // processes.  The boot-all registry is intentionally process-local, so a
    // healthy relocated handle is invisible here.  Reuse the existing
    // cross-service owner advertisement and accept it only for this exact
    // (workspace, install) pair; the open helper's FIRST RPC is an
    // existing-only boot (`createIfMissing:false`), so a stale/wrong socket can
    // never mint a store or identity.
    const { getPgRelocatedHarnessEndpoint } = await import('../../sync/hyperbee/substrate-booted-handles-pg');
    const advertised = await getPgRelocatedHarnessEndpoint(workspaceId, installSlug).catch(() => null);
    if (advertised) {
      return {
        path: 'sidecar-advertised',
        openDuplex: async (devicePubkeyBase64, request) => {
          const [{ openHiveGitDuplexViaExistingSidecar }, { workspacesRoot }] = await Promise.all([
            import('../../sync/hyperbee/remote-booted-harness'),
            import('../../workspace-registry'),
          ]);
          return openHiveGitDuplexViaExistingSidecar({
            socketPath: advertised.socketPath,
            workspaceRoot: join(workspacesRoot(), workspaceId),
            workspaceId,
            harnessSlug: installSlug,
            devicePubkeyBase64,
            request,
          });
        },
      };
    }
    void bootSingleHarness(workspaceId, installSlug).catch(() => {
      // best-effort demand-boot; a failure just leaves the harness unbooted
      // for this tick — the next tick's access retries.
    });
    return undefined;
  }
  if (hasRelocatedHiveGitDial(handle)) {
    return {
      path: 'sidecar',
      openDuplex: (devicePubkeyBase64, request) => handle.openHiveGitDuplexToDevice(devicePubkeyBase64, request),
    };
  }
  const topicHex = handle.swarm?.topicHex;
  if (!topicHex) return undefined;
  return {
    path: 'in-process',
    topicHex,
    openDuplex: (devicePubkeyBase64, request) =>
      openHiveGitDuplexToDevice(Buffer.from(topicHex, 'hex'), devicePubkeyBase64, request),
  };
}

/**
 * WI-6372 (fix D) — is our mirror actually LEVEL WITH THE POT, or merely the
 * result of a fetch that completed?
 *
 * `bootstrapFromPeer` answers "did a fetch succeed". That is NOT the same
 * question, and conflating them is what let WI-6364 run silently for 7 days: a
 * joiner served a complete, internally-consistent pack from a store frozen a
 * week earlier reported COLD JOIN COMPLETE and stamped `ok:true`.
 *
 * The correlator is the REF-ANNOUNCE plane, and its value comes entirely from
 * being a DIFFERENT channel: announcements ride the hive-keyed fed-event log,
 * so they are independent of `repoKey` and of the pot-git transport. A repoKey
 * divergence makes the two channels disagree while each looks internally
 * healthy — a disagreement no amount of asking pot-git about itself can
 * surface.
 *
 * Best-effort by contract: a probe failure must never break the tick (it is a
 * detector, not a gate), so everything here is caught and reported.
 */
type ConvergenceProbeVerdict = ConvergenceVerdict & {
  /** Health is tolerant of a progressing mirror; it is never release acceptance. */
  healthState: 'unknown' | 'level' | 'advancing' | 'stalled';
  /** Fail-closed exact snapshot agreement for release acceptance. */
  releaseConsistency: ReleaseConsistencyVerdict;
};

/**
 * The revoked device set git-sync's peer candidates are filtered by (WI-10006394): the
 * same harness-scope ∪ Hive-scope UNION that admission seeds from (boot.ts
 * `loadRevoked`), read through the same NOTIFY-invalidated caches. Each half fails
 * toward JUDGING: a revocation read that fails leaves the pre-fix candidate set, so an
 * outage can never silence a real NOT CONVERGED alarm.
 */
async function loadConvergenceRevokedSet(
  workspaceId: string,
  harnessSlug: string,
  potHomeSlug: string,
): Promise<Set<string>> {
  const revoked = new Set<string>();
  try {
    for (const pk of await loadRevokedPubkeysCached({ workspaceId, harnessSlug })) revoked.add(pk);
  } catch {
    // harness-scope read failed: judge as before
  }
  try {
    for (const pk of await loadRevokedHivePubkeysForLocalPotCached(workspaceId, potHomeSlug)) revoked.add(pk);
  } catch {
    // Hive-scope read failed: judge as before
  }
  return revoked;
}

async function runConvergenceProbe(input: {
  slug: string;
  workspaceId: string;
  potHomeSlug: string;
  repoPath: string;
  repoKey: string;
  candidateDevicePubkeys: string[];
}): Promise<ConvergenceProbeVerdict | null> {
  const { slug, workspaceId, potHomeSlug, repoPath, repoKey, candidateDevicePubkeys } = input;
  try {
    const { sql } = getOrgPg();
    const protocolScope = await resolveHiveGitProtocolScope(workspaceId, potHomeSlug, repoKey);
    // Read announcements INDEPENDENTLY of the ref-announce leg's own cursor:
    // that cursor is a CONSUMPTION watermark and has already moved past exactly
    // the rows we need to judge against. Deliberately NO sql cast on `version`
    // (one garbage row would throw the whole query) and no ORDER BY on it —
    // rows come back newest-first by `id` and the CURRENT (not highest) version
    // per device is taken in JS AFTER the signature check. The 500-row bound is
    // a scan ceiling: a device that has not announced within it simply cannot be
    // judged, which is the conservative direction (no alarm) rather than a false
    // one.
    //
    // `id` is selected and threaded through as `sequence` because it is the only
    // recency key that survives a re-key: `version` restarts on a fresh store
    // lineage, so ordering by it latches a permanent false alarm (WI-6372 fix D
    // defect — see convergence-probe.ts GUARD 7).
    const rows = await sql<{ id: string | number; ts: Date | string; body: Record<string, unknown> }[]>`
      SELECT id, ts, body
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${potHomeSlug}
         AND surface = 'messages'
         AND body->'fed_event'->>'key' = ${REF_ANNOUNCE_EVENT_KEY}
       ORDER BY id DESC
       LIMIT 500
    `;
    const announced: AnnouncedSnapshot[] = [];
    for (const row of rows) {
      const fe = row.body?.fed_event as { payload?: unknown } | undefined;
      // Same routing as the receive leg: judge THIS install only against
      // announcements addressed to it, or a submodule install reads the
      // superproject's counter as its own and latches NOT CONVERGED forever.
      const payload = fe?.payload;
      if (!isSignedRefAnnouncement(payload)) continue;
      if (payload.v === REF_ANNOUNCE_SCHEMA_VERSION_CONTEXT && isSignedProtocolContext(payload)) {
        if (!signedProtocolContextMatches(payload, protocolScope)) continue;
      } else if (!refAnnounceTargetsRepo(fe, { slug, potHomeSlug })) continue;
      // ANYTHING can write a fed-event row, so an unverified one must never be
      // able to pin this device NOT-CONVERGED forever. Verify against the
      // EMBEDDED key; hive membership is gated separately by the candidate set.
      if (!verifyRefAnnouncement(payload)) continue;
      // `id` is a bigint and may arrive as a string — coerce, and drop an
      // unparseable one rather than passing NaN into the recency comparison.
      const seq = typeof row.id === 'number' ? row.id : Number.parseInt(String(row.id), 10);
      const observedAtMs = row.ts instanceof Date ? row.ts.getTime() : Date.parse(String(row.ts));
      const storeGenerationRaw =
        payload.v === REF_ANNOUNCE_SCHEMA_VERSION_CONTEXT ? payload.store_generation : undefined;
      announced.push({
        devicePubkeyBase64: payload.device_pubkey,
        version: payload.version,
        sequence: Number.isSafeInteger(seq) ? seq : undefined,
        sigrefsOid: payload.sigrefs_oid,
        observedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : undefined,
        signedAtMs: payload.ts,
        storeGeneration:
          typeof storeGenerationRaw === 'string' && storeGenerationRaw.length > 0 ? storeGenerationRaw : undefined,
      });
    }

    // Read local sigrefs ONLY for devices that actually announced. GUARD 2 means
    // a device without an announcement can never be judged behind, so reading
    // its namespace is pure waste — and it is not cheap: each read spawns git
    // (twice, via readNamespaceRef + cat-file). Live-measured on the tower
    // 2026-07-27: 20 attested candidate devices but exactly ONE announcing peer,
    // i.e. ~38 of 40 subprocess spawns per tick, per harness, for nothing.
    const announcingDevices = new Set(announced.map((a) => a.devicePubkeyBase64));
    const local: LocalMirror[] = [];
    for (const device of candidateDevicePubkeys) {
      if (!announcingDevices.has(device)) continue;
      const [stored, sigrefsOid] = await Promise.all([
        readSigrefs(repoPath, device).catch(() => null),
        readNamespaceRef(repoPath, device, SIGREFS_REF).catch(() => null),
      ]);
      const storeGenerationRaw = (stored as (typeof stored & { store_generation?: unknown }) | null)?.store_generation;
      local.push({
        devicePubkeyBase64: device,
        version: stored?.version ?? null,
        sigrefsOid,
        storeGeneration:
          typeof storeGenerationRaw === 'string' && storeGenerationRaw.length > 0 ? storeGenerationRaw : undefined,
      });
    }

    const stateRows = await sql<{ convergence: { devices?: ConvergenceState } | null }[]>`
      SELECT metadata->'convergence' AS convergence
        FROM harness_shared.routines
       WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
       LIMIT 1
    `;
    const priorState = stateRows[0]?.convergence?.devices ?? null;

    const nowMs = Date.now();
    const healthVerdict = judgeConvergence({
      candidateDevicePubkeys,
      announced,
      local,
      priorState,
      nowMs,
    });
    const releaseConsistency = judgeReleaseConsistency({
      expectedDevicePubkeys: candidateDevicePubkeys,
      announced,
      local,
      nowMs,
    });
    const verdict: ConvergenceProbeVerdict = {
      ...healthVerdict,
      healthState:
        healthVerdict.judged === 0
          ? 'unknown'
          : !healthVerdict.converged
            ? 'stalled'
            : healthVerdict.behind.length > 0
              ? 'advancing'
              : 'level',
      releaseConsistency,
    };

    await patchRoutineMetadata(slug, workspaceId, {
      convergence: {
        at: nowMs,
        // Backwards-compatible health alias. This deliberately remains tolerant
        // of a progressing mirror and MUST NOT be used as release acceptance.
        converged: verdict.converged,
        healthState: verdict.healthState,
        judged: verdict.judged,
        behindCount: verdict.behind.length,
        notConverged: verdict.notConverged.map((d) => ({
          device: d.devicePubkeyBase64.slice(0, 12),
          announced: d.announced,
          local: d.local,
          stuckForMs: d.lagMs,
        })),
        summary: formatConvergenceVerdict(verdict),
        // Re-keys observed this tick. Persisted because "the peer's version fell
        // off a cliff" is otherwise reconstructed by hand across two ticks of
        // metadata, and it is the reason a persistence clock was dropped.
        lineageResets: verdict.lineageResets.map((r) => ({
          device: r.devicePubkeyBase64.slice(0, 12),
          priorAnnounced: r.priorAnnounced,
          announced: r.announced,
        })),
        // The per-device persistence watermark the NEXT tick carries forward.
        devices: verdict.state,
        // P-512: THE field release acceptance reads. V1 announcements have no
        // signed store generation, so they correctly remain UNKNOWN until the
        // P-513 versioned protocol supplies one; missing evidence never passes.
        releaseConsistency: {
          state: verdict.releaseConsistency.state,
          evaluatedAtMs: verdict.releaseConsistency.evaluatedAtMs,
          maxObservationAgeMs: verdict.releaseConsistency.maxObservationAgeMs,
          watermarkSequence: verdict.releaseConsistency.watermarkSequence,
          expectedDevicePubkeys: verdict.releaseConsistency.expectedDevicePubkeys,
          currentDevicePubkeys: verdict.releaseConsistency.currentDevicePubkeys,
          issues: verdict.releaseConsistency.issues.map((issue) => ({
            devicePubkeyBase64: issue.devicePubkeyBase64,
            code: issue.code,
            detail: issue.detail,
          })),
          summary: formatReleaseConsistencyVerdict(verdict.releaseConsistency),
        },
      },
    });

    if (!verdict.converged) {
      // The loudest line this leg can emit, and deliberately so: this is the
      // exact condition that previously printed nothing at all while every
      // green artifact kept saying the join had succeeded.
      console.warn(
        `[git-sync] ${slug}: pot-git NOT CONVERGED WITH THE POT — ${formatConvergenceVerdict(verdict)}. ` +
          `A completed fetch is NOT convergence: our mirror has not advanced while the pot announced newer ` +
          `snapshots on the (repoKey-independent) ref-announce plane. Treat any 'COLD JOIN COMPLETE' / ` +
          `bootstrap ok:true for this pot as UNSOUND until this clears. ` +
          `If a device named here is gone for good (a deleted VM, a wiped machine), revoking it stops it ` +
          `being judged (substrate:revoke_self_device reaches a device on a harness contributor row; one ` +
          `listed only on the Hive member row has no single-device revoke yet, WI-10006415). ` +
          (await describeRefAnnounceReceiveFreshness(slug, workspaceId)),
      );
    }
    return verdict;
  } catch (e) {
    console.warn(`[git-sync] ${slug}: convergence probe failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

export async function runBootstrapLeg(slug: string, workspaceId: string): Promise<void> {
  try {
    let entry: ProjectEntry | undefined;
    try {
      entry = (await loadHarnessRegistry(workspaceId)).projects.find((p) => p.slug === slug);
    } catch {
      return; // registry unreadable — next tick retries
    }
    if (!entry) return;
    const potHomeSlug = entry.hive_slug ?? (entry.self_repo ? entry.slug : undefined);
    if (!potHomeSlug) return;
    // WI-5168: federated repoKey — see repo-identity.ts.
    const repoKey = canonicalRepoKey(entry);

    // G-8 cold-start (live-caught on the P-302 rig, WI-3496): the bare store
    // must EXIST before any git runs against it — bootstrap.ts's documented
    // precondition ("The local bare repo must exist (G-1 ensurePotGitRepo)").
    // Without this, every runGit on a cold device dies `spawn git ENOENT`
    // (missing cwd), and the first store is only ever created by the LATER
    // own-head leg — which then poisons the warm check below forever.
    const repoPath = await ensurePotGitRepo(potHomeSlug, repoKey);

    // EI-18745600910177355: reclaim leaked partial packs HERE, before any of
    // the gates below can return early. `bootstrapFromPeer` also sweeps, but
    // the leg exits ahead of it on every "nothing to do" path — no attested
    // peers, no live dial path, already warm — and "no live dial path" is
    // PRECISELY the stuck state in which a joiner sits accumulating them tick
    // after tick (live-caught on the rig: 21 GB of orphans in a store that
    // could not dial anyone, so the sweep inside bootstrap was unreachable).
    // A joiner that cannot make progress is the one that most needs its disk
    // back. Best-effort, never throws into the tick.
    const swept = await sweepStalePackTmpFiles(repoPath).catch(() => null);
    if (swept && swept.removed.length > 0) {
      // Report the two reclaim kinds SEPARATELY. They are not the same event and
      // must not read as one: a temp pack is disk hygiene, while `shallow.lock`
      // is the thing that WEDGES the cold-join ladder — clearing it is the
      // moment a stuck joiner becomes able to make progress again, and it is the
      // single highest-signal line in this whole feature's logs. Live-caught on
      // the rig 2026-07-26: the unwedge printed as "reclaimed 1 orphaned pack
      // temp file(s), 0.00 GB", which names the wrong artifact AND rounds the
      // 41-byte lock to nothing — i.e. the one line a future debugger most needs
      // said, in effect, that nothing had happened.
      const unwedged = swept.removed.filter((n) => n.endsWith('.lock'));
      const packs = swept.removed.filter((n) => !n.endsWith('.lock'));
      if (packs.length > 0) {
        // MB, not GB: a 2-decimal GB reads "0.00" for anything under ~5 MB.
        console.log(
          `[git-sync] ${slug}: reclaimed ${packs.length} orphaned pack temp file(s), ` +
            `${(swept.bytesReclaimed / 1e6).toFixed(1)} MB`,
        );
      }
      if (unwedged.length > 0) {
        console.log(
          `[git-sync] ${slug}: cleared stranded ${unwedged.join(', ')} — ` +
            `the cold-join ladder was WEDGED (every shallow fetch failing) and can now advance`,
        );
      }
    }

    const actor = await resolveHiveGitActor(workspaceId, slug, potHomeSlug, repoKey);
    // Self-identification must NOT ride on gh reachability: resolveUsageActor
    // returns null whenever `gh` is unauthenticated or GET /user fails (rate
    // limit), and an undefined self here used to (a) let `find(d => d !==
    // undefined)` pick THIS device's own attestation on the home box — dialing
    // yourself never has a registry entry, so every tick reported the decoy
    // "no live dial path" — and (b) make the warm gate below count OUR OWN
    // namespace as a peer seed, silently skipping bootstrap forever. Fall back
    // to the persisted, keychain-verified announce-identity cache (no network).
    const selfDevicePubkey =
      actor?.devicePubkey ?? (await loadCachedLocalAnnounceIdentity().catch(() => null))?.devicePubkeyBase64;

    const members = await listHiveMembersForLocalPot(workspaceId, potHomeSlug);
    const memberDevicePubkeysBase64 = [
      ...new Set(members.flatMap((m) => m.deviceAttestations.map((a) => a.device_pubkey).filter(Boolean))),
    ];
    if (memberDevicePubkeysBase64.length === 0) return; // no attested peers to seed from yet

    // ALL non-self attested devices are candidates — a single `.find()` pick
    // wedged G-8 permanently when its one candidate was offline/stale (any
    // dead first candidate starved every later tick; live-caught on the P-303
    // reverse-leg drill 2026-07-17 with a live registered peer sitting unused).
    // ...except REVOKED ones (WI-10006394): a revoked device is never judged for
    // convergence and never dialed as a seed. Read only when there is a non-self
    // member to filter, so the common single-device case pays nothing.
    const revokedDevicePubkeys = memberDevicePubkeysBase64.some((d) => d !== selfDevicePubkey)
      ? await loadConvergenceRevokedSet(workspaceId, slug, potHomeSlug)
      : new Set<string>();
    const candidateDevicePubkeys = selectConvergenceCandidates({
      memberDevicePubkeys: memberDevicePubkeysBase64,
      selfDevicePubkey,
      revokedDevicePubkeys,
    });
    if (candidateDevicePubkeys.length === 0) return; // no unrevoked member peer other than self yet — nothing to seed from

    // WI-6372 (fix D) — CRITICAL PLACEMENT: the convergence probe runs HERE,
    // ABOVE the warm gate, and its position is the whole point of the fix.
    //
    // The warm gate below returns the moment a peer namespace exists with no
    // pending quarantine. A joiner that is SEEDED BUT STALE — the WI-6364 shape
    // exactly — satisfies that gate on every tick and therefore never re-enters
    // this leg at all, while the ref-announce leg keeps dialing under the same
    // diverged repoKey. So a probe placed on the cold-join path (or anywhere
    // after the gate) would never fire on precisely the machine that needs it:
    // the stuck one. Being above the gate is what makes this a detector of
    // ONGOING divergence rather than a post-condition of a join we happened to
    // run this tick.
    //
    // Its verdict never gates the leg — a detector that can block the thing it
    // watches is a second outage waiting to happen.
    const convergence = await runConvergenceProbe({
      slug,
      workspaceId,
      potHomeSlug,
      repoPath,
      repoKey,
      candidateDevicePubkeys,
    });

    // Warm means "already seeded from a PEER MEMBER's device" — nothing else
    // counts. Our own namespace is local (own-head-publish), and the
    // github-ingress namespace is ALSO locally synthesized (runGithubBridgeLeg
    // runs BEFORE this leg in the same tick, so on a GitHub-bridged repo the
    // very first tick writes the ingress namespace before we ever check —
    // live-caught on the WI-3496 rig: counting it made every bridged pot skip
    // G-8 cold-join forever). So the gate intersects the store's namespaces
    // with the ATTESTED MEMBER devices (excluding self): only a real peer
    // member's namespace proves a prior seed. A stale member-set false-cold
    // just re-runs bootstrapFromPeer, which is rewind-safe by contract.
    const memberNamespaceKeys = new Set(
      candidateDevicePubkeys.flatMap((d) => {
        try {
          return [deviceNamespaceKey(d)];
        } catch {
          return []; // malformed attestation pubkey — never counts as warm
        }
      }),
    );
    // WI-6189: a seeded peer namespace is NECESSARY but no longer SUFFICIENT.
    // The resumable ladder seeds all-or-nothing PER NAMESPACE, so a store can
    // hold a fully-seeded namespace while ANOTHER device's history is still
    // mid-ladder in quarantine. Testing only "does a peer namespace exist?"
    // (which was equivalent back when bootstrap was all-or-nothing) declares
    // that PARTIAL join complete and returns warm on every later tick, so the
    // ladder never runs again and the unfinished namespaces are stranded
    // forever — a silent partial cold-join that looks like a successful one.
    //
    // Live-caught on the P-302 rig 2026-07-26, in the very tick after the first
    // successful cold join: 5 namespaces seeded, 4 quarantine refs pending,
    // store permanently shallow, zero further bootstrap ticks.
    //
    // So: warm ⇔ seeded from a peer member AND nothing still staged. Re-running
    // with quarantine pending is safe and is the whole point — bootstrapFromPeer
    // is rewind-safe by contract and resumes from those very refs.
    const existing = await listNamespaces(repoPath);
    if (existing.some((n) => memberNamespaceKeys.has(n))) {
      const pending = await hasPendingQuarantine(repoPath).catch(() => false);
      if (!pending) return; // warm — seeded from a peer member, nothing left staged
    }

    // DIAL-REGISTRY (WI-3583) — see module doc above. Real per-device dial
    // once this harness has a live swarm topic; falls back to the same
    // pre-WI-3583 destroyed stub when it doesn't (private/local-only harness,
    // or not yet booted onto a swarm) — mirrors runRefAnnounceLeg's own
    // openStream floor exactly.
    const dialContext = await resolveHiveGitDialContext(workspaceId, slug);
    if (!dialContext) {
      const stub = new Duplex({
        read() {},
        write(_chunk, _enc, cb) {
          cb();
        },
      });
      // Swallow the destroy-time error BEFORE destroy(err) schedules it —
      // with no listener, Node emits an UNHANDLED 'error' next tick =
      // uncaughtException = the whole host exits (live-caught: this
      // crash-looped the tower bg-host at boot, WI-3496/WI-5177 —
      // bootstrapFromPeer awaits dropQuarantine before fetchOverDuplex can
      // attach its own listener). Same idiom as openHiveGitDuplexToDevice's
      // no-live-connection stub: callers read `.destroyed`, never 'error'.
      stub.on('error', () => {});
      stub.destroy(new Error('hive-git: no live swarm join for this harness yet'));
      const outcome = await bootstrapFromPeer(repoPath, stub, { selfDevicePubkey });
      // WI-37226: this writer replaces the WHOLE `bootstrap` key, so omitting the
      // miss-run fields DELETES them — and a deleted run reads as "the run ended",
      // i.e. it would silently CLEAR a real persistent-miss escalation. This path
      // attempts no dial at all, so it can neither advance a run nor end one: carry
      // the counter through untouched. (Precisely the accidental-erasure hazard the
      // WI-6284 comment below warns about, now with a field that would actually hurt.)
      const priorStubBootstrap = await readPriorBootstrapMeta(slug, workspaceId);
      await patchRoutineMetadata(slug, workspaceId, {
        bootstrap: {
          at: Date.now(),
          // WI-6284: say WHICH path produced this record. Until this existed, the
          // only way to tell a real dial from this destroyed-stub no-op was to
          // notice that the dial writer below emits `phase`/`rungs`/`shallow` and
          // this one does not — an accidental discriminator that one added key
          // here would have silently erased, on the exact record a release
          // reviewer uses to decide whether the live cold join ever ran.
          path: 'no-topic-stub',
          ok: outcome.ok,
          // `converged` remains the tolerant lag-health signal. P-512 adds the
          // fail-closed release predicate beside it so a reviewer cannot turn a
          // progressing/no-evidence health green into release acceptance.
          converged: convergence?.converged ?? null,
          healthState: convergence?.healthState ?? 'unknown',
          releaseConsistency: convergence?.releaseConsistency.state ?? 'unknown',
          namespaceCount: outcome.namespaces.length,
          skippedExisting: outcome.skippedExisting.length,
          // WI-37226: carried, not recomputed — see the note above the prior read.
          consecutiveMisses: priorStubBootstrap?.consecutiveMisses ?? 0,
          firstMissAt: priorStubBootstrap?.firstMissAt ?? null,
          // EI-18799556647570956: two host processes historically could run this
          // leg concurrently for the same install, and each `patchRoutineMetadata`
          // call replaces the WHOLE `bootstrap` key. WI-6500 now wraps both writer
          // paths in the per-install lease; retain this stamp so a pre-upgrade stale
          // process that does not yet honor the lease remains self-evident instead
          // of reading as a field regression. `instance` reuses
          // PROCESS_INSTANCE_ID (pid + process-start stamp, already used for the
          // resolver/content-fixer dispatch markers above) so all three "who wrote
          // this" stamps in this file share one identity, never three.
          writer: { pid: process.pid, instance: PROCESS_INSTANCE_ID, sha: getBuildInfo().sha },
        },
      });
      if (!outcome.ok) {
        console.warn(`[git-sync] ${slug}: bootstrap-tick reported errors: ${outcome.stderr.trim().slice(0, 500)}`);
      }
      return;
    }

    // Try each candidate until one seeds: a dial-registry miss (pre-destroyed
    // decoy duplex) costs nothing and moves on; a LIVE duplex whose fetch then
    // fails also moves on (bootstrapFromPeer is rewind-safe by contract, and a
    // half-dead channel must not starve a healthy later candidate). Attempts
    // are capped so a large member set can't stack fetch ceilings in one tick.
    const MAX_LIVE_ATTEMPTS = 3;
    const dialLog: string[] = [];
    let outcome: Awaited<ReturnType<typeof bootstrapFromPeer>> | null = null;
    let liveAttempts = 0;
    // WI-6418 (bootstrap half): ONE in-flight ladder per repo, process-wide.
    //
    // This is the fetch driver that matters for a cold join, and N staggered
    // git-sync routines all reach it for the SAME repo. Unguarded, each opens its
    // own session, and the serve side then refuses (or, pre-WI-6412, supersedes)
    // the transfer already streaming. A multi-GB pot needs longer than the
    // aggregate drive interval, so it restarts forever — at ANY throughput. The
    // ceiling is a PERIOD, not a RATE, which is why throughput work never moved it.
    //
    // Keyed on the REPO rather than (repo, device) because that is the unit the
    // PEER rations: `inFlightServes` in serve-wiring.ts is a process-wide Set whose
    // cap counts same-repo serves across every connection. It also matches this
    // loop's own rule below — it breaks on first progress instead of dialing a
    // second peer, since stacking another fetch ceiling only duplicates work the
    // next tick resumes anyway. Every candidate here mirrors the same
    // `+refs/namespaces/*`, so peers are interchangeable; that is exactly why
    // ref-announce keeps a per-DEVICE key (there each device is a different
    // namespace on a different remote process) and this leg must not.
    const ladder = await withFetchCoalescing(fetchCoalescerKey(repoPath, '<bootstrap-ladder>'), async () => {
      for (const peerDevicePubkeyBase64 of candidateDevicePubkeys) {
        if (liveAttempts >= MAX_LIVE_ATTEMPTS) break;
        // EI-15333: skip a peer we already know (within the backoff window)
        // definitively refuses this exact repo — never counts as a live
        // attempt (nothing was dialed), same as a registry no-path miss.
        const backoffKey = noSuchRepoBackoffKey(repoKey, peerDevicePubkeyBase64);
        if (isNoSuchRepoBackoffActive(backoffKey)) {
          dialLog.push(`${peerDevicePubkeyBase64.slice(0, 8)}:backoff(no-such-repo)`);
          continue;
        }
        const duplex = await dialContext.openDuplex(peerDevicePubkeyBase64, {
          repoKey,
          peerGithubUserId: actor?.githubUserId,
        });
        if (duplex.destroyed) {
          dialLog.push(`${peerDevicePubkeyBase64.slice(0, 8)}:no-path`);
          continue;
        }
        liveAttempts++;
        // WI-6189: hand the ladder a re-dial so ONE tick can climb several rungs
        // against this same peer — each rung is a separate `git fetch` and a
        // pot-git duplex serves exactly one. A dial that fails or comes back dead
        // resolves to null, which stops the ladder cleanly with its progress
        // already durable on disk.
        outcome = await bootstrapFromPeer(repoPath, duplex, {
          selfDevicePubkey,
          dial: async () => {
            const next = await dialContext
              .openDuplex(peerDevicePubkeyBase64, {
                repoKey,
                peerGithubUserId: actor?.githubUserId,
              })
              .catch(() => null);
            return next && !next.destroyed ? next : null;
          },
        });
        // Surface WHY a LIVE dial then failed — otherwise the tick log only ever
        // shows the generic ":failed" + fetch-transport's "duplex already
        // destroyed before fetch began", and the ACTUAL cause (the peer's serve
        // decision) is invisible on THIS machine, forcing a cross-machine
        // serve.log read to learn it (P-303 reverse-leg drill 2026-07-17: five
        // diagnosis wakes stalled on a reason the dialing box already received
        // over the wire). The peer's `refuse` frame destroys our client duplex
        // with `pot-git serve refused: <reason>` (serve-wiring.ts handleRefuse) —
        // no-such-repo / mode-legacy / scope-repo:* / not-serving — and a
        // transport drop destroys it with `serve channel closed`; node retains
        // whichever on `duplex.errored` (set synchronously by .destroy(err), so
        // no event-timing race). Fail-soft: absent/undefined ⇒ bare ":failed".
        const dialErr = (duplex as { errored?: Error | null }).errored;
        // WI-6189: a ladder that climbed rungs without finishing is HEALTHY
        // IN-PROGRESS, not a failure — reporting it as ":failed" is what made a
        // large cold-join look permanently broken when it was in fact advancing.
        dialLog.push(
          `${peerDevicePubkeyBase64.slice(0, 8)}:${
            outcome.ok
              ? 'ok'
              : outcome.progressed
                ? `progress(${outcome.phase} +${outcome.steps} rungs, ${outcome.quarantineRefs} refs staged${outcome.shallow ? ', still shallow' : ''})`
                : `failed${dialErr?.message ? `(${dialErr.message})` : ''}`
          }`,
        );
        // EI-15333: a definitive no-such-repo refusal (not a generic/transient
        // dial failure) arms the backoff so this exact pair stops being
        // re-dialed every tick.
        if (!outcome.ok && dialErr?.message?.includes('no-such-repo')) {
          armNoSuchRepoBackoff(backoffKey);
        }
        // WI-6364 (fix C, joiner half): the peer refused because the key we asked
        // for names a store IT ABANDONED, and told us what its store is really
        // called. Adopt it — this is the one repair channel that needs nothing but
        // the dial we just made (see adopt-refused-repo-key.ts). Deliberately NOT
        // arming any backoff: the whole point is that the NEXT tick dials again,
        // under the corrected key, against this same peer.
        const refusedKey = await adoptRefusedRepoKey(slug, dialErr?.message);
        if (refusedKey.adopted) {
          console.log(
            `[git-sync] ${slug}: pot-git RE-KEYED ${refusedKey.from ?? repoKey} → ${refusedKey.adopted} ` +
              `— peer ${peerDevicePubkeyBase64.slice(0, 8)} refused the old key as a store it has abandoned. ` +
              `The next tick bootstraps from the live store; the old one at ` +
              `${refusedKey.from ?? repoKey} is now orphaned locally and can be reclaimed.`,
          );
          break; // nothing more this tick can do under a key we just replaced
        }
        // Stop on a finished join, and ALSO on real durable progress: the rungs
        // this tick climbed are on disk, so re-dialing a second peer now would
        // only stack another fetch ceiling for work the next tick resumes anyway.
        if (outcome.ok || outcome.progressed) break;
      }
      // Hand the ladder's verdict back OUT rather than leaning on the closure's
      // write to `outcome`: TypeScript's control-flow analysis does not track
      // assignments made inside a nested function, so without this every read below
      // narrows to `never` and the whole reporting/metadata block stops
      // typechecking (the same trap that produced the priorBootstrap `never` errors).
      return outcome;
    });
    if (!ladder.ran) {
      // NOT a failure: a fetch for this repo is already streaming, so this tick
      // has nothing to add. Returning HERE — before patchRoutineMetadata — is
      // deliberate: that writer stamps `path: 'dialed'` unconditionally, so
      // falling through would record a dial that never happened AND overwrite the
      // durable ladder telemetry (phase/rungs/quarantineRefs) that
      // EI-18775478513129278 exists to carry forward. Progress stays on disk in
      // the quarantine refs, which are the resume checkpoint; the next tick
      // continues from there.
      console.log(`[git-sync] ${slug}: bootstrap-tick stood down — a fetch for this repo is already in flight`);
      return;
    }
    // Re-anchor the narrowing in THIS scope (see the closure's `return` above).
    outcome = ladder.result;
    // EI-18775478513129278: `outcome` stays null when this tick never got a
    // live dial at all (every candidate hit backoff or a registry miss) — the
    // "no live dial path" case. `rungs:0`/`ok:false` are HONEST for THIS tick
    // (nothing was dialed), but namespaceCount/quarantineRefs/phase/shallow/
    // deepenNext describe DURABLE ON-DISK ladder progress this tick never
    // touched — forcing them to 0/null erased the record of every earlier
    // rung a prior tick had climbed (a release reviewer's only surface for
    // "is this cold join progressing?"). Carry those fields forward from the
    // last recorded tick instead of clobbering them; only a tick that actually
    // dialed (a real `outcome`) gets to report a fresh disk read.
    let priorBootstrap: PriorBootstrapMeta | null = null;
    if (!outcome) {
      priorBootstrap = await readPriorBootstrapMeta(slug, workspaceId);
    }
    // WI-37226: run-length of consecutive dial misses. A real dial (any `outcome`,
    // including one that errored — it PROVED a live path existed) ends the run; only a
    // tick that never got a dial at all extends it.
    const missRunLength = outcome ? 0 : (priorBootstrap?.consecutiveMisses ?? 0) + 1;
    const missRunStartedAt = outcome ? null : (priorBootstrap?.firstMissAt ?? Date.now());
    await patchRoutineMetadata(slug, workspaceId, {
      bootstrap: {
        at: Date.now(),
        // WI-6284: see the stub writer above — this record must SAY it came from
        // a real dial rather than leaving a reader to infer it from key presence.
        path: 'dialed',
        ok: outcome?.ok ?? false,
        // See the stub writer above: fetch completion, lag health, and exact
        // release consistency are three distinct statements.
        converged: convergence?.converged ?? null,
        healthState: convergence?.healthState ?? 'unknown',
        releaseConsistency: convergence?.releaseConsistency.state ?? 'unknown',
        namespaceCount: outcome?.namespaces.length ?? priorBootstrap?.namespaceCount ?? 0,
        skippedExisting: outcome?.skippedExisting.length ?? 0,
        // WI-6189 ladder telemetry — the burn-down a watcher needs to tell a
        // converging cold-join from a stalled one WITHOUT a cross-machine log
        // read: staged refs should only ever grow, and `shallow` flips false
        // on the last rung before the namespaces appear.
        phase: outcome?.phase ?? priorBootstrap?.phase ?? null,
        rungs: outcome?.steps ?? 0,
        quarantineRefs: outcome?.quarantineRefs ?? priorBootstrap?.quarantineRefs ?? 0,
        shallow: outcome?.shallow ?? priorBootstrap?.shallow ?? null,
        deepenNext: outcome?.deepenNext ?? priorBootstrap?.deepenNext ?? null,
        // WI-37226: the promised "persistent misses" signal, made readable WITHOUT a
        // cross-machine log read — the same reason the WI-6189 ladder telemetry above
        // is persisted rather than only logged.
        consecutiveMisses: missRunLength,
        firstMissAt: missRunStartedAt,
        // EI-18799556647570956 / WI-6500: see the stub writer above — the shared
        // per-install lease serializes current processes, while this stamp keeps a
        // pre-upgrade writer that ignores the lease diagnosable.
        writer: { pid: process.pid, instance: PROCESS_INSTANCE_ID, sha: getBuildInfo().sha },
      },
    });
    if (!outcome) {
      // topicHex is in the message deliberately: a registry miss with a peer
      // PROVABLY registered means the handle's topic and the hello channel's
      // topic diverged — the one distinction the decoy stub otherwise erases
      // (live-caught P-303: every tick decoyed while a verified hello for the
      // exact requested device key sat registered).
      // EI-18740968796318403: say what `no-path` ACTUALLY means. It reads as
      // "the peer is unreachable / the topic is dead" and is neither — it means
      // the dial registry held no entry for that device AT THE INSTANT we looked,
      // which under hello-channel churn is routinely true of a peer that is
      // connected and exchanging data one second either side. That misreading
      // cost two separate investigations a wrong root cause (this item, and the
      // WI-6299 cold-join drill), so the log now carries the distinction.
      const topicLabel = dialContext.topicHex?.slice(0, 12) ?? 'sidecar-owned';
      const missBase =
        `[git-sync] ${slug}: bootstrap-tick: no candidate member device was registered in the pot-git dial registry at this instant ` +
        `(topic ${topicLabel}${dialContext.topicHex ? '…' : ''}, dial path ${dialContext.path}, dialed: ${dialLog.join(', ')})`;
      if (missRunLength >= BOOTSTRAP_PERSISTENT_MISS_THRESHOLD) {
        // WI-37226: this is the branch the old wording PROMISED and never had. Note what
        // it does NOT say: it names no cause. The single-miss text below is right that a
        // miss is not proof of unreachability, and the temptation on a long run is to
        // upgrade it to a diagnosis ("the peer is dark / the rig is at loginwindow").
        // That exact upgrade already cost TWO investigations a wrong root cause
        // (EI-18740968796318403 and the WI-6299 cold-join drill), so what escalates here
        // is the CONFIDENCE THAT SOMETHING IS WRONG plus the checks that discriminate —
        // never a verdict this code has no evidence for.
        const runMin = missRunStartedAt ? Math.max(1, Math.round((Date.now() - missRunStartedAt) / 60_000)) : 0;
        // WI-37574: of the three discriminators below, (2) is the ONE this process
        // can answer from its own memory — (1) needs the rig over SSH and (3) needs a
        // topic comparison, but the content-announce peer count for THIS topic is an
        // O(1) Map read we are already holding. Asking the READER to go measure it
        // cost two consecutive wakes a manual journal dig on EI-18808621019872598,
        // and its absence invited the wrong reading — "pot-git pairing is COMPLETELY
        // down", i.e. a swarm fault — when the swarm was healthy and simply had no
        // peer (the rig guest was dark; ARP FAILED).
        //
        // Dynamically imported for exactly the reason getBootedHarness is (see
        // resolveHiveGitDialContext): a static import drags swarm.ts's real module graph
        // into every caller's test, and swarm.ts pulls symbols from peer-dial-registry
        // that partial mocks do not provide.
        //
        // ⚠ It degrades to UNKNOWN, never to 0. "no peers" and "could not measure"
        // route the investigation to OPPOSITE conclusions, and this is a logging path
        // that must never throw.
        let swarmEvidence = 'contentPeers=UNKNOWN lastAnnounceRecv=UNKNOWN (swarm state unreadable this tick)';
        try {
          if (!dialContext.topicHex) {
            throw new Error('swarm observability is sidecar-owned');
          }
          const { contentPeerCountForTopic, lastContentAnnounceRecvMs } = await import('../../sync/hyperbee/swarm');
          const peers = contentPeerCountForTopic(dialContext.topicHex);
          const lastMs = lastContentAnnounceRecvMs(dialContext.topicHex);
          const lastTxt = lastMs == null ? 'never' : `~${Math.max(0, Math.round((Date.now() - lastMs) / 60_000))}m ago`;
          swarmEvidence = `contentPeers=${peers} lastAnnounceRecv=${lastTxt}`;
        } catch {
          // keep UNKNOWN — an unmeasurable swarm is not an empty one
        }
        console.warn(
          `${missBase}. ⚠ PERSISTENT-MISS ESCALATION: ${missRunLength} consecutive ticks over ~${runMin}m with ZERO dials ` +
            `for this install. That is past the point hello-channel churn explains — this run is a REAL signal, unlike any ` +
            `single miss. This log names NO cause; run these to discriminate: ` +
            `(1) is the peer PROCESS even up? on the macOS rig, bin/vm-rig/preflight-login.sh exits 2 on the kcpassword/` +
            `loginwindow silent-death class (WI-4070/EI-13010), which presents EXACTLY as a swarm wedge with no error; ` +
            `(2) ANSWERED IN-BAND, do not re-derive it — swarm content-announce state for THIS topic at this instant: ` +
            `${swarmEvidence}. Reading: contentPeers>0 ⇒ the peers ARE talking, so this is a registry/topic problem and ` +
            `NOT reachability; contentPeers=0 with lastAnnounceRecv=never ⇒ nothing has ever paired on this topic, which ` +
            `points at reachability (check 1). This is a MEASUREMENT, not a cause; ` +
            `(3) does the dial topic match the hello channel's topic (the divergence the topicHex above exists to expose). ` +
            `Run-length + start are persisted at routines.metadata->'bootstrap'.{consecutiveMisses,firstMissAt}.`,
        );
      } else {
        console.warn(
          `${missBase}. ` +
            `NOTE: "no-path" = registry miss at sample time, NOT proof the peer is unreachable — a churning hello channel ` +
            `de-registers between ticks. Retried next tick; persistent misses across many ticks are the real signal ` +
            `(this run: ${missRunLength}/${BOOTSTRAP_PERSISTENT_MISS_THRESHOLD} before escalation).`,
        );
      }
    } else if (outcome.progressed && !outcome.ok) {
      // WI-6189: in-progress, not broken. Logged at info so a converging
      // multi-tick cold-join reads as burn-down rather than a repeating error.
      console.log(
        `[git-sync] ${slug}: bootstrap-tick advanced (dialed: ${dialLog.join(', ')}): ` +
          `+${outcome.steps} rung(s) → ${outcome.quarantineRefs} refs staged, ` +
          `${outcome.shallow ? `still shallow (next deepen ${outcome.deepenNext})` : 'history complete, seeding next tick'}`,
      );
    } else if (!outcome.ok) {
      console.warn(
        `[git-sync] ${slug}: bootstrap-tick reported errors (dialed: ${dialLog.join(', ')}): ${outcome.stderr.trim().slice(0, 500)}`,
      );
    } else {
      // WI-6284: the COMPLETED cold join — the one event this whole feature
      // exists to produce, and until now the ONLY outcome of this leg with no
      // log branch at all (every failure and every partial had one). That
      // asymmetry is not cosmetic: on 2026-07-27 a deliberate cold-join drill on
      // the P-302 rig SUCCEEDED here — 2 namespaces seeded in 2 rungs, history
      // complete — and emitted nothing, so the drill was checkpointed as
      // "may never have run" and the answer had to be re-derived from
      // `harness_shared.routines.metadata->'bootstrap'` on a later wake. A
      // release whose open question is "does the live cold join work" cannot
      // have success be the silent case.
      // WI-6372/P-512: this line is the single most-trusted artifact this
      // feature produces. Fetch completion, tolerant health, and exact release
      // consistency must remain visibly separate; only exact CURRENT may say
      // the release snapshot is current.
      const completionLabel =
        convergence?.converged === false
          ? 'FETCH COMPLETE BUT HEALTH STALLED'
          : convergence?.releaseConsistency.state === 'current'
            ? 'COLD JOIN CURRENT'
            : `FETCH COMPLETE; RELEASE CONSISTENCY ${(
                convergence?.releaseConsistency.state ?? 'unknown'
              ).toUpperCase()}`;
      console.log(
        `[git-sync] ${slug}: bootstrap-tick ${completionLabel} (dialed: ${dialLog.join(', ')}): ` +
          `seeded ${outcome.namespaces.length} namespace(s) in ${outcome.steps ?? 0} rung(s)` +
          `${outcome.skippedExisting.length > 0 ? `, ${outcome.skippedExisting.length} already present` : ''}` +
          `${outcome.shallow ? ' — still shallow' : ' — history complete'}` +
          `${convergence?.converged === false ? ` — ${formatConvergenceVerdict(convergence)}` : ''}` +
          `${convergence ? ` — ${formatReleaseConsistencyVerdict(convergence.releaseConsistency)}` : ''}`,
      );
    }
  } catch (e) {
    console.warn(`[git-sync] ${slug}: bootstrap-tick failed: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * p2p-git-live-activation P-202: the ref-announce-tick leg of one non-legacy
 * hive's git-sync tick. Best-effort: never throws (the code plane must keep
 * committing even when this pass fails); the fed-event cursor + per-device
 * budget-state map persist on the routine metadata (the `lastAdmitted` idiom
 * above, under the `ref_announce` key — distinct from P-204's
 * `worktree_bridge` key and P-203's `integrator` key, so the three legs never
 * clobber each other's watermark).
 *
 * TWO SUB-LEGS, same repo (`hiveGitRepoPath(potHomeSlug, repoKey)` — one bare
 * store per (hive, repo) key holding every member's namespace, exactly like
 * the integrator/worktree-bridge legs read/write; `repoKey` is the FEDERATED
 * cross-device identity, WI-5168 / repo-identity.ts — never the local slug):
 *   1. PUBLISH — `runRefAnnouncePublishTick`: no-ops unless this device's own
 *      namespace advanced since its last sigrefs snapshot; on advance, emits
 *      the signed announcement hive-wide (local `emitAwaitedEvent` +
 *      federated `sendMessage` fed_event — the same two-emission idiom
 *      `runIntegratorLeg` uses for its staging-advance).
 *   2. RECEIVE — pending `hive-git:ref-announce` fed-events collected off
 *      `coord_event_log` since our watermark (the same collection shape
 *      `runWorktreeBridgeLeg` uses for `hive-git:staging-advance`), fed
 *      through `runRefAnnounceReceiveTick` against the local mirror.
 *
 * DIAL-REGISTRY (WI-3583, peer-dial-registry.ts, landed 2026-07-10): `openStream`
 * resolves this harness's live swarm topic via `getBootedHarness(...).swarm
 * .topicHex` and dials the announcing device through `openHiveGitDuplexToDevice`
 * — a real per-device Protomux fetch duplex over the same shared muxer P-201's
 * serve plane answers on. Two fail-soft floors, neither ever throws: (a) no
 * live swarm join yet for this harness (private/local-only, or not booted) ⇒
 * an already-destroyed local stub, same shape as before WI-3583; (b) a live
 * topic but no open connection to THIS device yet ⇒ `openHiveGitDuplexToDevice`
 * itself resolves an already-destroyed Duplex (its own documented contract).
 * Either way the fetch reports through the documented `fetch-failed` result
 * (matching `fetchOverDuplex`'s fail-soft contract) and the batch continues;
 * only genuine cross-machine reachability (Phase 3's live rig) exercises the
 * happy path end-to-end.
 */
/**
 * WI-2142873: the NOT CONVERGED alarm's missing half. It names the receive
 * leg's last persisted pass and cursor, so a leg that never runs (starved by an
 * earlier leg's action timeout) reads differently from one that runs and rejects.
 * Never throws: it is decoration on an alarm, not a new failure mode.
 */
async function describeRefAnnounceReceiveFreshness(slug: string, workspaceId: string): Promise<string> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ at: string | null; cursor: string | null }[]>`
      SELECT metadata->'ref_announce'->>'at' AS at, metadata->'ref_announce'->>'lastEventId' AS cursor
        FROM harness_shared.routines
       WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
       LIMIT 1
    `;
    return formatRefAnnounceReceiveFreshness(rows[0]?.at ?? null, rows[0]?.cursor ?? null, Date.now());
  } catch (e) {
    return `ref-announce receive freshness unreadable: ${e instanceof Error ? e.message : e}`;
  }
}

async function resolveHiveGitProtocolScope(
  workspaceId: string,
  potHomeSlug: string,
  repoKey: string,
): Promise<SignedProtocolScope> {
  let hive = await getHiveBySlug(workspaceId, potHomeSlug);
  if (!hive?.pubkeyBase64) {
    // WI-10003559: a member that joined via a bare invite link never learned the
    // Pot pubkey, so no row exists. Backfill it from already-received data,
    // verified against the join's link topic, then re-read. Every tick retries,
    // so a member whose first peer ref-announce arrives after boot heals then.
    const { healJoinedPotIdentity } = await import('../joined-pot-identity-heal');
    const heal = await healJoinedPotIdentity({ workspaceId, homeSlug: potHomeSlug });
    if (heal.status === 'healed') hive = await getHiveBySlug(workspaceId, potHomeSlug);
    if (!hive?.pubkeyBase64) {
      throw new Error(
        `pot-git: stable hive identity unavailable (identity heal: ${heal.status}` +
          `${heal.status === 'no-verified-candidate' ? `, ${heal.candidatesSeen} candidate(s)` : ''}` +
          `${heal.status === 'error' ? `: ${heal.reason}` : ''}); refusing unscoped protocol`,
      );
    }
  }
  return { hive_id: hive.pubkeyBase64, repo_key: repoKey };
}

/**
 * `servingDeps` lets a process that is NOT the serving owner (the P-521 F3
 * physical drill producer) run this exact leg while resolving the owner's
 * capability only from its cross-process advertisement — and never lazily
 * booting a second owner of its own. `onPublished` reports the announcement
 * THIS call signed and persisted, so that caller can tell its own publication
 * from one the owner's scheduled tick made in the same window.
 */
export async function runRefAnnounceLeg(
  slug: string,
  workspaceId: string,
  options: {
    receive?: boolean;
    servingDeps?: GitServingResolutionDeps;
    onPublished?: (announcement: { version: number; sigrefs_oid: string }) => void;
  } = {},
): Promise<void> {
  try {
    let entry: ProjectEntry | undefined;
    try {
      entry = (await loadHarnessRegistry(workspaceId)).projects.find((p) => p.slug === slug);
    } catch {
      return; // registry unreadable — next tick retries
    }
    if (!entry) return;
    const potHomeSlug = entry.hive_slug ?? (entry.self_repo ? entry.slug : undefined);
    if (!potHomeSlug) return;
    // WI-5168: federated repoKey — see repo-identity.ts.
    const repoKey = canonicalRepoKey(entry);
    const actor = await resolveHiveGitActor(workspaceId, slug, potHomeSlug, repoKey, options.servingDeps);
    if (!actor) return; // gh unauthenticated — no device identity to sign/announce as
    const protocolScope = await resolveHiveGitProtocolScope(workspaceId, potHomeSlug, repoKey);

    const members = await listHiveMembersForLocalPot(workspaceId, potHomeSlug);
    const memberDevicePubkeysBase64 = [
      ...new Set(members.flatMap((m) => m.deviceAttestations.map((a) => a.device_pubkey).filter(Boolean))),
    ];

    // P-505 cold-rejoin fence: sigrefs' normal rollback watermark lives in the
    // bare store itself. A deliberate full-store cold join removes that ref, so
    // retain this device's last published version in the already-durable routine
    // metadata and feed it back as a floor before signing the rebuilt namespace.
    // This is per git-sync routine/repo, and it never imports a peer-controlled
    // copy of our own namespace.
    const { sql } = getOrgPg();
    const stateRows = await sql<{ ref_announce: RefAnnounceRoutineState | null }[]>`
      SELECT metadata->'ref_announce' AS ref_announce
        FROM harness_shared.routines
       WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
       LIMIT 1
    `;
    const priorState = stateRows[0]?.ref_announce ?? null;
    const repoPath = hiveGitRepoPath(potHomeSlug, repoKey);
    const signedProtocolContext = actor.capability.context;
    const priorPublishVersion =
      priorState?.publishGeneration === signedProtocolContext.store_generation &&
      Number.isSafeInteger(priorState?.publishVersion)
        ? Math.max(0, priorState?.publishVersion ?? 0)
        : 0;
    const replayFloors: Record<string, SignedSnapshotFloor> = Object.fromEntries(
      Object.entries(priorState?.replayFloors ?? {}).filter(([, floor]) =>
        signedProtocolContextMatches(floor, protocolScope),
      ),
    );
    const sign = actor.sign;

    // 1. Publish: announce our own namespace advance, if any.
    const publishOutcome = await runRefAnnouncePublishTick({
      repoPath,
      devicePubkeyBase64: actor.devicePubkey,
      sign,
      // Same genesis contract as the own-head leg — without it the FIRST
      // sigrefs of a pre-existing repo judges the whole history and the flood
      // caps refuse it forever (peers then never fetch the repo at all).
      genesisBaselineSha: await deriveGenesisBaselineSha(entry, undefined),
      // WI-5738: runtime secrets-guard path exemptions apply here too.
      workspaceId,
      versionFloor: priorPublishVersion,
      context: signedProtocolContext,
    });
    if (publishOutcome.announcement) {
      await actor.assertServing();
      const announcement = publishOutcome.announcement;
      replayFloors[actor.devicePubkey] = {
        ...signedProtocolContext,
        version: announcement.version,
        sigrefs_oid: announcement.sigrefs_oid,
      };
      await emitAwaitedEvent({
        key: REF_ANNOUNCE_EVENT_KEY,
        summary: `hive-git ref-announce v${announcement.version} from ${actor.devicePubkey.slice(0, 12)}`,
        payload: announcement,
        source: 'git-sync-ref-announce',
      });
      const identity: AgentIdentity = {
        ownerId: 'git-sync-ref-announce',
        ownerLabel: 'git-sync-ref-announce',
        source: 'static-client',
        userId: null,
        workspaceId,
      };
      await actor.assertServing();
      await sendMessage(identity, {
        to: [],
        summary: `[fed-event] ${REF_ANNOUNCE_EVENT_KEY}`,
        harnessSlug: potHomeSlug,
        extra: {
          fed_event: {
            key: REF_ANNOUNCE_EVENT_KEY,
            payload: announcement,
            source: identity.ownerId,
            // Envelope tag naming WHICH install in this (multi-repo) hive
            // announced — the readers route on it. See ref-announce-repo-scope.ts.
            ...refAnnounceRepoEnvelope(slug),
          },
        },
      });
      // Persist only after the signed snapshot + announcement exist. A crash
      // before this write leaves the store-local version authoritative; a later
      // full-store rebuild resumes above the greatest version recorded here.
      await patchRoutineMetadata(slug, workspaceId, {
        ref_announce: completeRefAnnounceState({
          lastEventId: priorState?.lastEventId ?? 0,
          budgetStates: priorState?.budgetStates ?? {},
          publishVersion: Math.max(priorPublishVersion, announcement.version),
          publishGeneration: signedProtocolContext.store_generation,
          replayFloors,
          parked: priorState?.parked ?? {},
          at: Date.now(),
        }),
      });
      options.onPublished?.(announcement);
    }
    if (publishOutcome.errors.length) {
      console.warn(`[git-sync] ${slug}: ref-announce publish reported errors: ${publishOutcome.errors.join('; ')}`);
    }

    if (options.receive === false) return;
    if (memberDevicePubkeysBase64.length === 0) return; // no attested peers to receive from yet

    // 2. Receive: pending peer ref-announce fed-events since our watermark —
    // plus whatever last tick PARKED (read but could not mirror; P-203 Leg A).
    const lastEventId = priorState?.lastEventId ?? 0;
    const priorBudgetStates = new Map<string, AnnounceBudgetState | null>(
      Object.entries(priorState?.budgetStates ?? {}),
    );
    const priorParked: ParkedRefAnnouncements = priorState?.parked ?? {};
    const hasParked = Object.keys(priorParked).length > 0;

    const feRows = await sql<{ id: number; body: Record<string, unknown> }[]>`
      SELECT id, body
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${potHomeSlug}
         AND surface = 'messages'
         AND id > ${lastEventId}
         AND body->'fed_event'->>'key' = ${REF_ANNOUNCE_EVENT_KEY}
       ORDER BY id ASC
       LIMIT ${REF_ANNOUNCE_RECEIVE_BATCH_LIMIT}
    `;
    // Nothing new to receive. ⚠ NOT inherently a "fast no-op": the zero-row case is the
    // one where the scan runs to completion having found nothing, so it is the MOST
    // expensive outcome, not the cheapest — and since fed-events are rare relative to
    // total surface='messages' traffic, it is also the COMMON one. It is cheap only when
    // coord_event_log_fed_event_key_idx (migration 1038) is present to make it an index
    // probe; without that index this is a full parallel seq scan on every git-sync tick.
    // See EI-21893070865750886, which measured it at 1,408 buffers -> 3.
    if (feRows.length === 0 && !hasParked) return;

    const pending: RefAnnounceReceiveBatchRow[] = [];
    let maxRowId = lastEventId;
    for (const row of feRows) {
      maxRowId = Math.max(maxRowId, row.id);
      const fe = row.body?.fed_event as { payload?: unknown } | undefined;
      // A hive with many installs shares ONE announce stream; only rows
      // addressed to THIS install are ours to fetch. A skipped row still
      // advances the cursor above (it is another install's, not a failure).
      if (isSignedProtocolContext(fe?.payload)) {
        if (!signedProtocolContextMatches(fe.payload, protocolScope)) continue;
      } else if (!refAnnounceTargetsRepo(fe, { slug, potHomeSlug })) continue;
      if (fe && isSignedRefAnnouncement(fe.payload) && verifyRefAnnouncement(fe.payload)) {
        pending.push({ rowId: row.id, announcement: fe.payload });
      }
    }
    // Parked announcements are driven at the HEAD of the batch (a parked entry
    // superseded by a newer fresh row from its device is dropped here).
    const batch = mergeParkedIntoReceiveBatch(priorParked, pending);
    if (batch.length === 0) {
      // Rows existed (e.g. a malformed payload) but nothing usable — still
      // advance the cursor past them so a bad row can't loop forever. Nothing
      // was parked either (a parked row is always in the batch).
      await patchRoutineMetadata(slug, workspaceId, {
        ref_announce: completeRefAnnounceState({
          lastEventId: maxRowId,
          budgetStates: priorState?.budgetStates ?? {},
          publishVersion: Math.max(priorPublishVersion, publishOutcome.announcement?.version ?? 0),
          publishGeneration: signedProtocolContext.store_generation,
          replayFloors,
          parked: {},
          at: Date.now(),
        }),
      });
      return;
    }

    // A duplex that is already dead when the receive tick gets it: the tick
    // renders that as a `fetch-failed` carrying `message` as its stderr, which
    // is how a "we did not even dial, and here is why" outcome reaches the
    // operator log without inventing a second result shape.
    const destroyedStub = (message: string): Duplex => {
      const stub = new Duplex({
        read() {},
        write(_chunk, _enc, cb) {
          cb();
        },
      });
      // Same unhandled-'error' footgun as runBootstrapLeg's stub above —
      // attach the no-op listener BEFORE destroy(err) or the host dies
      // on an uncaughtException next tick.
      stub.on('error', () => {});
      stub.destroy(new Error(message));
      return stub;
    };
    // EI-15333, SECOND LEG. Which devices this tick genuinely put on the wire —
    // the arming gate below reads it. See that comment for why a bare stderr
    // test is not sufficient.
    const dialedThisTick = new Set<string>();

    // WI-10003594: a peer that ANNOUNCES this exact repo_key after refusing it
    // has since built the store, so the 30-min window no longer describes it.
    // Without this, a peer that recreated its store (the P-505 Phase A drill
    // does exactly that within ~3 min) was not dialed again for 30 min, longer
    // than the drill's 20-min verdict deadline. One lift per NEW announcement
    // keeps EI-15333's storm closed; see `liftNoSuchRepoBackoffOnFreshAnnouncement`.
    for (const [device, announcedTsMs] of newestAnnouncementTsByDevice(
      batch.map((p) => p.announcement),
      repoKey,
    )) {
      const lift = liftNoSuchRepoBackoffOnFreshAnnouncement(noSuchRepoBackoffKey(repoKey, device), announcedTsMs);
      if (lift) {
        console.info(
          `[git-sync] ${slug}: no-such-repo backoff for ${device.slice(0, 12)} on ${repoKey} lifted: ` +
            `peer announced this repo_key at ${new Date(lift.announcedTsMs).toISOString()}, after the refusal ` +
            `armed at ${new Date(lift.armedAtMs).toISOString()}; dialing this tick`,
        );
      }
    }

    const receiveOutcome = await runRefAnnounceReceiveTick({
      repoPath,
      pending: batch.map((p) => p.announcement),
      selfDevice: actor.devicePubkey,
      allowedDevices: memberDevicePubkeysBase64,
      budgetStates: priorBudgetStates,
      openStream: async (device) => {
        // EI-15333 — THE SAME REPAIR, ON THE LEG THAT ACTUALLY KEEPS DIALING.
        // The backoff was wired into `runBootstrapLeg` only, and this is the leg
        // that storms: that one returns early on a seeded store, while this one
        // re-drives EVERY pending announcement EVERY tick against a fed-event
        // cursor that a permanent refusal PINS (EI-15335 holds it below the
        // oldest failed row), so the held backlog is re-dialed forever and grows
        // as new announcements pile up behind it. Structurally identical to the
        // WI-6364 (fix C) miss below — a repair the stuck machine cannot reach is
        // not a repair. Rationale, the live 5.9-day stall it was caught on, and
        // why this is a backoff rather than a cursor-advance: see
        // `no-such-repo-backoff.ts`.
        const backoffKey = noSuchRepoBackoffKey(repoKey, device);
        if (isNoSuchRepoBackoffActive(backoffKey)) {
          return destroyedStub(
            `no-such-repo backoff: ${device.slice(0, 8)} definitively refused ${repoKey}; ` +
              `next dial in ${noSuchRepoBackoffSecondsLeft(backoffKey)}s`,
          );
        }
        // DIAL-REGISTRY (WI-3583) — see module doc above. Real per-device
        // dial once this harness has a live swarm topic; falls back to the
        // same pre-WI-3583 destroyed stub when it doesn't (private/local-only
        // harness, or not yet booted onto a swarm). `boot-all.ts` is a heavy,
        // wide-fan-out module (projections, coordination) this per-tick leaf
        // has no other reason to touch — imported dynamically, matching this
        // codebase's own convention for pulling in cross-cutting substrate
        // modules from a leaf call site (e.g. boot.ts's own
        // `await import('../../hive-membership-store')`), so it loads only
        // when a fetch is actually attempted, never at module-init time.
        const dialContext = await resolveHiveGitDialContext(workspaceId, slug);
        if (!dialContext) {
          return destroyedStub('hive-git: no live swarm join for this harness yet');
        }
        dialedThisTick.add(device);
        return dialContext.openDuplex(device, {
          repoKey,
          peerGithubUserId: actor.githubUserId,
        });
      },
      // WI-2039873: the transport default, NOT a bare 15s — see the constant's
      // doc for the livelock a 15s ceiling generated against serve-wiring's
      // 30s progress window on the two-machine rig.
      timeoutMs: REF_ANNOUNCE_RECEIVE_IDLE_MS,
      expectedContext: protocolScope,
      allowLegacy: false,
      replayFloors,
    });

    // EI-15335 / P-203 Leg A: the receive tick returns one result per driven
    // announcement, positionally aligned to `batch`. A `fetch-failed` result
    // means the announced namespace was NEVER mirrored. The cursor still
    // advances past everything read; the un-mirrored announcement is PARKED
    // (newest per device, persisted below) and re-driven next tick — never
    // silently dropped, and never allowed to pin the cursor for every other
    // announcer (the head-of-line block that starved a reachable peer on the
    // two-machine rig). See `decideRefAnnounceReceiveCursor`.
    const cursorDecision = decideRefAnnounceReceiveCursor(receiveOutcome.results, batch, maxRowId, priorParked);

    await patchRoutineMetadata(slug, workspaceId, {
      ref_announce: completeRefAnnounceState({
        lastEventId: cursorDecision.cursor,
        budgetStates: Object.fromEntries(receiveOutcome.budgetStates),
        publishVersion: Math.max(priorPublishVersion, publishOutcome.announcement?.version ?? 0),
        publishGeneration: signedProtocolContext.store_generation,
        replayFloors: receiveOutcome.replayFloors,
        parked: cursorDecision.parked,
        at: Date.now(),
      }),
    });
    // WI-2142873 detector: one census line per receive pass. Rejections were
    // never logged, so a 739-minute non-convergence showed ZERO receive lines
    // and nothing distinguished "the leg rejected everything" from "the leg
    // never ran". Now a live leg always leaves a line; silence means it did not run.
    console.info(
      formatRefAnnounceReceiveCensus(slug, receiveOutcome.results, {
        batch: batch.length,
        fromCursor: lastEventId,
        toCursor: cursorDecision.cursor,
        parked: Object.keys(cursorDecision.parked).length,
        rowsRead: feRows.length,
        limit: REF_ANNOUNCE_RECEIVE_BATCH_LIMIT,
      }),
    );
    for (const u of cursorDecision.unparked) {
      console.info(
        `[git-sync] ${slug}: parked ref-announce from ${u.device.slice(0, 12)} settled (${u.action}) at v${u.version} ` +
          `after ${u.attempts} tick(s) parked since ${new Date(u.parkedSinceMs).toISOString()}`,
      );
    }

    // EI-15333 (second leg): arm the backoff for a pair that was ACTUALLY
    // DIALED this tick and came back with a definitive `no-such-repo`. The
    // `dialedThisTick` gate is load-bearing — see `devicesToArmForNoSuchRepo`.
    for (const device of devicesToArmForNoSuchRepo(cursorDecision.fetchFailed, dialedThisTick)) {
      armNoSuchRepoBackoff(noSuchRepoBackoffKey(repoKey, device));
    }
    // Log fetch failures LOUDLY (the bootstrap leg already does) — otherwise a
    // missed receive is invisible: no operator signal distinguishes "nothing
    // to receive" from "receive failed".
    //
    // COLLAPSED per (device, reason): the cursor holds BELOW the oldest failed
    // row, so a stalled pair re-reads its whole held backlog every tick and
    // emitted one identical line per announcement per tick — nine lines every
    // ~5 min on the live tower stall above, growing with the age of the stall,
    // which is what buried the one line that actually distinguished the cause.
    // One line per distinct failure, carrying the event span it stands for.
    const failureGroups = new Map<string, { device: string; reason: string; detail: string; rowIds: number[] }>();
    for (const f of cursorDecision.fetchFailed) {
      // WI-6277: this line used to end in `${f.stderr}` and nothing else, which
      // on the ceiling path is the EMPTY STRING — a SIGKILLed git writes no
      // stderr. Live on the P-302 rig that produced a stuck replication cursor
      // whose operator line literally ended in a bare colon, with a timeout, a
      // transient dial miss and a real git error all printing identically.
      // Lead with the discriminator the transport already knew.
      // WI-6189: `code === -1` is an OVERLOADED sentinel (see TransportResult.code)
      // — a git that RAN and was then killed by a signal reports `close(null)`,
      // which `code ?? -1` folds onto the same value as a spawn that never
      // happened. Labelling every -1 "no git process ran" produced the live
      // self-contradiction `no git process ran: fatal: early EOF` on the tower —
      // git's own stderr inside the clause denying git ran — and that mislabel is
      // why a mid-stream truncation kept reading as a transport seam bug.
      // Non-empty stderr is positive proof a process ran, so only claim otherwise
      // when there is genuinely nothing to show.
      const detail = f.stderr.trim();
      const reason = f.timedOut
        ? `TIMED OUT (git SIGKILLed at the fetch ceiling)`
        : f.code === -1
          ? detail
            ? `git died without an exit status (killed by a signal, or the stream closed under it)`
            : `no git process ran`
          : `git exited ${f.code}`;
      const groupKey = `${f.device}\x00${reason}\x00${detail}`;
      const group = failureGroups.get(groupKey);
      if (group) group.rowIds.push(f.rowId);
      else failureGroups.set(groupKey, { device: f.device, reason, detail, rowIds: [f.rowId] });
    }
    for (const { device, reason, detail, rowIds } of failureGroups.values()) {
      // Name the SPAN, not just the first row: "9 announcements, events
      // 7431043..7646648" is the fact that says this is a held backlog rather
      // than a one-off miss, and it is the number that grows while the stall
      // persists.
      const span =
        rowIds.length === 1
          ? `event ${rowIds[0]}`
          : `${rowIds.length} announcements, events ${rowIds[0]}..${rowIds[rowIds.length - 1]}`;
      // A device that stays parked re-fails every tick for as long as it is
      // unreachable; log the first miss and then once every 6 ticks (~hourly at
      // the 10-min rig cadence) so a permanent stall stays visible without
      // burying the lines that distinguish a NEW failure.
      const parkedEntry = cursorDecision.parked[device];
      const attempts = parkedEntry?.attempts ?? 1;
      if (parkedEntry && attempts !== 1 && attempts % 6 !== 0) continue;
      console.warn(
        `[git-sync] ${slug}: ref-announce receive fetch FAILED for ${device.slice(0, 12)} (${span}); ` +
          (parkedEntry
            ? `parked v${parkedEntry.announcement.version} to re-dial next tick (attempt ${attempts}, ` +
              `since ${new Date(parkedEntry.parkedSinceMs).toISOString()}); cursor advanced to ${cursorDecision.cursor}: `
            : `superseded by a newer announcement from the same device this tick; cursor advanced to ${cursorDecision.cursor}: `) +
          reason +
          (detail ? `: ${detail}` : ` (no stderr)`),
      );
    }
    // WI-6364 (fix C) — THE SAME REPAIR, ON THE LEG THAT ACTUALLY RECEIVES IT.
    //
    // A `superseded-repo-key:<K>` refusal is the store holder telling us,
    // first-hand, what its store is really named, and for an already-established
    // member it is the ONLY repair channel left (the join link is long gone; the
    // announce frame needs the owner already running a build that publishes it).
    //
    // It was originally wired ONLY into the bootstrap leg's dial path — and that
    // is the bug this block fixes. The bootstrap leg returns early on any
    // already-seeded store, and on a diverged pair it may never dial at all,
    // while THIS leg keeps dialing and therefore keeps collecting the refusal
    // every single tick. Live-caught tower<->rig 2026-07-27: the rig took five
    // of these per tick for hours, running a build that CONTAINED the adoption
    // code, with the canonical key sitting in plain text in the error — and
    // adopted nothing, because the only receiver was on a leg it never reached.
    // Structurally the same mistake as a detector placed below the warm gate: a
    // repair the stuck machine cannot reach is not a repair.
    //
    // Idempotent by contract (`already-canonical` is a clean no-op on every
    // later refused dial), so running it on both legs is safe by construction.
    // One adoption per tick is enough — the re-key takes effect on the NEXT
    // tick, so stop at the first refusal that resolves.
    for (const f of cursorDecision.fetchFailed) {
      const adoption = await adoptRefusedRepoKey(slug, f.stderr);
      if (adoption.adopted) {
        console.warn(
          `[git-sync] ${slug}: pot-git RE-KEYED ${adoption.from ?? '(unpinned)'} → ${adoption.adopted} ` +
            `— peer ${f.device.slice(0, 8)} refused the old key on the ref-announce leg as a store it has ` +
            `abandoned. The next tick dials under the corrected key.`,
        );
        break;
      }
      // A refusal we RECEIVED and declined to act on is the failure mode that
      // hid this bug for hours, so it must never be silent. `already-canonical`
      // and `not-a-superseded-refusal` are the boring no-ops (every ordinary
      // transport failure lands there); anything else means the repair arrived
      // and we turned it down — say which guard did it.
      if (
        adoption.skipped &&
        adoption.skipped !== 'not-a-superseded-refusal' &&
        adoption.skipped !== 'already-canonical'
      ) {
        console.warn(
          `[git-sync] ${slug}: pot-git did NOT adopt the key peer ${f.device.slice(0, 8)} named in its refusal ` +
            `(${adoption.skipped}) — the pair stays diverged until this is resolved.`,
        );
        break;
      }
    }
    if (receiveOutcome.errors.length) {
      console.warn(`[git-sync] ${slug}: ref-announce receive reported errors: ${receiveOutcome.errors.join('; ')}`);
    }
  } catch (e) {
    console.warn(`[git-sync] ${slug}: ref-announce-tick failed: ${e instanceof Error ? e.message : e}`);
  }
}

const INTEGRATOR_ERROR_WARN_INTERVAL_MS = 10 * 60_000;
const integratorErrorWarningState = new Map<
  string,
  { fingerprint: string; lastWarnAt: number; suppressed: number }
>();

/**
 * Keep the current diagnosis durable in routine metadata every tick, but do
 * not repeat an identical prerequisite warning for every install cadence.
 * A changed diagnosis logs immediately; an unchanged one re-emits every ten
 * minutes with its suppressed count; a recovery clears the throttle so a
 * recurrence is visible immediately.
 */
export function formatIntegratorErrorWarning(
  slug: string,
  errors: readonly string[],
  nowMs = Date.now(),
): string | null {
  if (errors.length === 0) {
    integratorErrorWarningState.delete(slug);
    return null;
  }
  const fingerprint = errors.join('\u0000');
  const prior = integratorErrorWarningState.get(slug);
  if (
    prior?.fingerprint === fingerprint &&
    nowMs - prior.lastWarnAt < INTEGRATOR_ERROR_WARN_INTERVAL_MS
  ) {
    prior.suppressed += 1;
    return null;
  }
  const suppressed = prior?.suppressed ?? 0;
  integratorErrorWarningState.set(slug, { fingerprint, lastWarnAt: nowMs, suppressed: 0 });
  return (
    `[git-sync] ${slug}: integrator-tick reported errors: ${errors.join('; ')}` +
    (suppressed > 0 ? ` (${suppressed} identical warning${suppressed === 1 ? '' : 's'} suppressed)` : '')
  );
}

/** Test-only reset for the module-local warning window. */
export function resetIntegratorErrorWarningsForTest(): void {
  integratorErrorWarningState.clear();
}

/** Canonical integration uses the single owning hive (F6/D-022). The runtime
 * capability supplies serving/device/generation identity; the existing owner
 * key authorizes the effect. Publication term and sequence persist under the
 * git-sync lease. A missing owner stops this leg, never elects a replacement. */
async function runIntegratorLeg(slug: string, workspaceId: string): Promise<void> {
  // Every decline below used to be a bare `return` that recorded NOTHING, so a
  // hive whose canonical ref never advances looked identical to one with
  // nothing to integrate — `metadata.integrator` is written only on a real
  // announcement. That cost hours on the hello-world-3-pot canary: the elected
  // authority (the mac) had no bare store OR git-sync routine for the repo,
  // while the only capable machine (the tower) correctly declined as
  // non-authority, so NOBODY integrated and origin silently froze. Recording
  // the reason makes "why is canonical stuck" a one-query answer.
  // `skipped: null` is the advancing tick's status (formatIntegratorTickStatus).
  const decline = async (skipped: string | null, detail?: string): Promise<void> => {
    try {
      await patchRoutineMetadata(slug, workspaceId, {
        integrator_status: { at: Date.now(), skipped, detail: detail ?? null },
      });
    } catch {
      /* best-effort: diagnostics must never break the tick */
    }
  };
  try {
    let entry: ProjectEntry | undefined;
    try {
      entry = (await loadHarnessRegistry(workspaceId)).projects.find((p) => p.slug === slug);
    } catch {
      await decline('registry_unreadable');
      return; // next tick retries
    }
    if (!entry) return void (await decline('no_registry_entry'));
    const potHomeSlug = entry.hive_slug ?? (entry.self_repo ? entry.slug : undefined);
    if (!potHomeSlug) return void (await decline('no_hive_home'));
    // WI-5168: federated repoKey — see repo-identity.ts.
    const repoKey = canonicalRepoKey(entry);
    const actor = await resolveHiveGitActor(workspaceId, slug, potHomeSlug, repoKey);
    // gh unauthenticated — no device identity to sign/integrate as
    if (!actor) return void (await decline('no_device_identity'));
    const protocolScope = await resolveHiveGitProtocolScope(workspaceId, potHomeSlug, repoKey);

    const members = await listHiveMembersForLocalPot(workspaceId, potHomeSlug);
    const memberDevicePubkeysBase64 = [
      ...new Set(members.flatMap((m) => m.deviceAttestations.map((a) => a.device_pubkey).filter(Boolean))),
    ];
    if (memberDevicePubkeysBase64.length === 0) return void (await decline('no_attested_devices'));

    // WI-38968: lockAuthorityForHive deliberately adds SELF after applying its
    // peer eligibility filter, so an otherwise-empty election always makes
    // progress. That liveness floor is unsafe for the integrator when this
    // process's device key is NOT one of the Pot's admitted devices: SELF can
    // win, sign a staging-advance, and then every worktree bridge (including
    // this same process) correctly rejects the envelope as `wrong-device`.
    // Live papercusp reproduction 2026-08-14: the actor signed epoch 87 / seq
    // 17 for 37c20c2, while its own bridge consumed and terminally rejected the
    // event, freezing canonical + GitHub egress at 143af9. Never relax the
    // receiver gate to repair this. Refuse the unadmitted signer before the
    // election and name the identity drift in the existing status surface.
    if (!isIntegratorActorAdmitted(actor.devicePubkey, memberDevicePubkeysBase64)) {
      const detail =
        `local device ${actor.devicePubkey.slice(0, 12)} is not in the Pot's ` +
        `${memberDevicePubkeysBase64.length} attested device(s); refusing to sign a canonical advance`;
      console.warn(`[git-sync] ${slug}: ${detail}`);
      await decline('self_device_not_attested', detail);
      return;
    }

    // D-022: only the owning hive integrates. Presence or a progress timeout
    // cannot grant another device the right to commit canonical effects.
    const repoPath = hiveGitRepoPath(potHomeSlug, repoKey);
    if ((await defaultRunGit(['rev-parse', '--git-dir'], repoPath)).code !== 0) {
      return void (await decline('no_local_store'));
    }
    const ownerKey = await loadHiveEffectAuthority(workspaceId, potHomeSlug, protocolScope);
    if (!ownerKey)
      return void (await decline(
        'not_hive_owner',
        'Canonical integration stops without the owning hive key; member-head exchange continues.',
      ));
    const effectAuthority = {
      ...ownerKey,
      sign: async (bytes: Buffer) => {
        await actor.assertServing();
        return ownerKey.sign(bytes);
      },
    };

    const { sql } = getOrgPg();
    const rows = await sql<
      {
        integrator: {
          epoch: number;
          seq: number;
          authorityDevice?: string;
          storeGeneration?: string;
          stagingSha?: string | null;
        } | null;
        worktree_bridge: { epochSeq: EpochSeq | null; stagingSha?: string | null } | null;
        github_last_admitted: string | null;
      }[]
    >`
      SELECT metadata->'integrator' AS integrator, metadata->'worktree_bridge' AS worktree_bridge,
             metadata->'github_bridge'->>'last_admitted' AS github_last_admitted
        FROM harness_shared.routines
       WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
       LIMIT 1
    `;
    const prior = rows[0]?.integrator ?? null;

    const { epoch, priorSeq } = nextHivePublicationTerm(
      prior,
      actor.devicePubkey,
      actor.capability.context.store_generation,
      rows[0]?.worktree_bridge?.epochSeq?.epoch ?? 0,
    );

    const signedProtocolContext = actor.capability.context;
    const snapshots = await sql<{ state: RefAnnounceRoutineState | null }[]>`
      SELECT metadata->'ref_announce' AS state FROM harness_shared.routines
       WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
    `;
    const outcome = await runIntegratorTick({
      potHomeSlug,
      workspaceId,
      repoKey,
      memberDevicePubkeysBase64,
      integratorDevicePubkeyBase64: actor.devicePubkey,
      epoch,
      priorSeq,
      // Announcement watermark (see IntegratorTickInput.lastAnnouncedStagingSha):
      // comparing against the last ANNOUNCED staging (not just the per-pass ref
      // motion) is what makes the integrator-is-the-author case announce at all.
      // WI-10003781: prefer this integrator's own announcement record — the
      // bridge's accepted watermark lags it until the bridge leg (which runs
      // after this one) persists, and a pass in that window re-announced the
      // same sha under seq+1. Null (never announced) ⇒ the first one announces.
      lastAnnouncedStagingSha: resolveAnnouncementWatermark(
        prior,
        {
          epoch,
          authorityDevice: actor.devicePubkey,
          storeGeneration: actor.capability.context.store_generation,
        },
        rows[0]?.worktree_bridge?.stagingSha ?? null,
      ),
      // WI-10004249: never let an advance fall off what this machine already
      // accepted — a non-FF advance is terminally rejected and freezes egress.
      acceptedStagingFloorSha: rows[0]?.worktree_bridge?.stagingSha ?? null,
      context: signedProtocolContext,
      authority: effectAuthority,
      acceptedSnapshots: snapshots[0]?.state?.replayFloors ?? {},
      // WI-10003820: the bridge leg (which runs BEFORE this leg in the same
      // tick) persists the P-005-admitted github-origin head as
      // `github_bridge.last_admitted`. Feed exactly that watermark, keyed by
      // the same synthetic namespace the ingress wrote, so GitHub-side commits
      // reach canonical staging. Only the admitted watermark — never the raw
      // namespace head, which may carry an ingressed-but-blocked commit.
      admittedGithubOriginHead:
        entry.github_remote && rows[0]?.github_last_admitted
          ? { deviceHex: githubOriginNamespaceKey(entry.github_remote), sha: rows[0].github_last_admitted }
          : null,
      sign: actor.sign,
      resolveTier: async (devicePubkeyBase64) =>
        (await resolveAuthorCommsTier({ workspaceId, potHomeSlug, devicePubkey: devicePubkeyBase64 })).tier,
      deps: { isIntegrator: async () => true }, // gated above — skip the re-query
    });

    // A healthy authority that simply had nothing to merge must be
    // distinguishable from one that never ran: `metadata.integrator` is only
    // written on a real announcement, so without this an idle-but-working
    // integrator and a stalled one look identical (both absent). Record the
    // trust-gate counts too — a head QUEUED for ratification (below
    // AUTO_INTEGRATE_TIER) reads as "no advance" and cost a live diagnosis
    // (canary hello-world-3-pot: every device tier 'message' < 'steer', so
    // the integrator queued its own head forever with no visible reason).
    // WI-10003731: record EVERY tick that reached the integrator, an advance
    // included. The status is a jsonb merge, so writing only on "no advance"
    // left a stale no-advance note standing after staging moved. The detail
    // also names WHAT conflicted — without it a parked head needed an offline
    // `git merge-tree` replay in the pot-git store to diagnose.
    const tickStatus = formatIntegratorTickStatus({
      advanced: Boolean(outcome.announcement),
      staging: outcome.integration?.staging,
      gated: outcome.gated,
      parked: outcome.integration?.skippedConflicts ?? [],
      hostLocalResolved: outcome.integration?.resolvedHostLocalState?.length ?? 0,
      errorCount: outcome.errors.length,
    });
    await decline(tickStatus.skipped, tickStatus.detail);

    if (outcome.announcement) {
      await actor.assertServing();
      // Local wake for any same-machine waiter, then federate hive-wide (the
      // ref-announce.ts idiom) so every OTHER member's worktree-bridge driver
      // (P-204) wakes on the same key.
      await emitAwaitedEvent({
        key: STAGING_ADVANCE_EVENT_KEY,
        summary: `hive-git staging advanced to ${outcome.integration?.staging?.slice(0, 12)}`,
        payload: outcome.announcement,
        source: 'git-sync-integrator',
      });
      const identity: AgentIdentity = {
        ownerId: 'git-sync-integrator',
        ownerLabel: 'git-sync-integrator',
        source: 'static-client',
        userId: null,
        workspaceId,
      };
      await actor.assertServing();
      await sendMessage(identity, {
        to: [],
        summary: `[fed-event] ${STAGING_ADVANCE_EVENT_KEY}`,
        harnessSlug: potHomeSlug,
        extra: {
          fed_event: {
            key: STAGING_ADVANCE_EVENT_KEY,
            payload: outcome.announcement,
            source: identity.ownerId,
            // Repo scoping (WI-5395 family): staging-advance events are
            // hive-scoped, but a hive binds SEVERAL repos and the sha belongs
            // to exactly one — without this, every OTHER repo's worktree-bridge
            // consumes the event, fails `rev-parse` in its own store, and
            // holds its cursor retryable (live-caught: the papercusp install
            // wedged behind a hive-canary announcement minutes after the
            // bridged flip). Envelope metadata, NOT inside the signed payload.
            // WI-5168: the FEDERATED repoKey (see repo-identity.ts) — every
            // member device must filter on the SAME key the integrator
            // published under, which the local install `slug` is not.
            repo_key: repoKey,
          },
        },
      });
      await sql`
        UPDATE harness_shared.routines
           SET metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{integrator}',
             ${JSON.stringify({
               epoch,
               seq: outcome.announcement.seq,
               authorityDevice: actor.devicePubkey,
               storeGeneration: signedProtocolContext.store_generation,
               // WI-10003781: the announce watermark resolveAnnouncementWatermark reads.
               stagingSha: outcome.announcement.staging_sha,
               at: Date.now(),
             })}::text::jsonb
           )
         WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
      `;
      // WI-10005753 (p2p-git-live-activation-2026-07-09#D-055): no handoff
      // token is published here. Under F6/D-022 successor epochs come from
      // nextHivePublicationTerm (hive-effect-authority.ts), and nothing read
      // the per-advance token after authority-epoch.ts was deleted.
    }
    const warning = formatIntegratorErrorWarning(slug, outcome.errors);
    if (warning) console.warn(warning);
  } catch (e) {
    console.warn(`[git-sync] ${slug}: integrator-tick failed: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * The integrator signs an authority-bearing canonical advance, so its local
 * actor must pass the same exact device-membership gate as the receiver. Kept
 * pure/exported so the election's self-admission boundary has a direct
 * regression test instead of being inferred from an end-to-end mock.
 */
export function isIntegratorActorAdmitted(
  actorDevicePubkey: string,
  admittedDevicePubkeys: readonly string[],
): boolean {
  return actorDevicePubkey.length > 0 && admittedDevicePubkeys.includes(actorDevicePubkey);
}

/**
 * p2p-git-live-activation P-204: the worktree-bridge-tick leg of one
 * non-legacy hive's git-sync tick. Best-effort: never throws (the code plane
 * must keep committing even when this pass fails); outcome + the
 * `{epoch, seq, sha}` watermark + the fed-event cursor persist on the routine
 * metadata (the `lastAdmitted` idiom above).
 *
 * FED-EVENT COLLECTION: `hive-git:staging-advance` announcements land in this
 * machine's `harness_shared.coord_event_log` as a no-recipient, hive-scoped
 * `fed_event` row — either written locally (this device IS the integrator
 * and just emitted one, see `runIntegratorLeg`) or replicated from a peer's
 * machine (P-009 rail). Collected here directly off that table since the
 * last-processed row id (a persisted watermark) — the same "fed-event log
 * since a watermark" collection `ref-announce-tick.ts`'s header describes as
 * needed for P-202, scoped here to just the one `STAGING_ADVANCE_EVENT_KEY`.
 *
 * FETCH-ON-DEMAND (EI-14555 — closes the former OPENDUPLEX GAP): this leg now
 * wires `worktree-bridge-tick.ts`'s `openDuplex` seam through WI-3583's
 * per-peer dial registry (device pubkey → live swarm socket), the same way the
 * ref-announce leg wires its `openStream`. A pending announcement whose sha
 * isn't in the local mirror is FETCHED from the announcing device instead of
 * being rejected `unknown-sha` until the remote happens to re-announce.
 *
 * Two properties keep this safe on the machines where the old omission was
 * already correct:
 *   - the dial is PER-ANNOUNCEMENT CONDITIONAL (handleStagingAdvance skips it
 *     whenever the sha is already a local commit), so the integrator's own
 *     machine and any mirror kept current by P-202 never dial at all — and a
 *     SELF-announcement can't dial our own pubkey and wedge the cursor;
 *   - identity/topic resolution is best-effort, so a host with no gh identity
 *     or no swarm join silently keeps the pre-EI-14555 local-mirror behaviour.
 *
 * Consequence for the cursor: `fetch-failed` IS now reachable here, so the
 * P-505 cursor-hold below (retryable stop + age-bound TTL) is load-bearing
 * rather than defensive — it was already implemented for exactly this.
 */
async function runWorktreeBridgeLeg(slug: string, workspaceId: string): Promise<void> {
  try {
    let entry: ProjectEntry | undefined;
    try {
      entry = (await loadHarnessRegistry(workspaceId)).projects.find((p) => p.slug === slug);
    } catch {
      return; // registry unreadable — next tick retries
    }
    if (!entry) return;
    const potHomeSlug = entry.hive_slug ?? (entry.self_repo ? entry.slug : undefined);
    if (!potHomeSlug) return;
    // WI-5168: federated repoKey — see repo-identity.ts. Must match what
    // runIntegratorLeg published as `repo_key` on the staging-advance
    // fed-event (below), or this device's own bridge never sees it.
    const repoKey = canonicalRepoKey(entry);

    const members = await listHiveMembersForLocalPot(workspaceId, potHomeSlug);
    const memberDevicePubkeysBase64 = [
      ...new Set(members.flatMap((m) => m.deviceAttestations.map((a) => a.device_pubkey).filter(Boolean))),
    ];
    if (memberDevicePubkeysBase64.length === 0) return; // no attested devices yet

    const { sql } = getOrgPg();
    const rows = await sql<
      {
        worktree_bridge: {
          lastEventId: number;
          epochSeq: EpochSeq | null;
          stagingSha: string | null;
          /** EI-19332963201820362: consecutive ticks that consumed >=1
           *  announcement and accepted NONE. Optional — absent on any row
           *  written before this field existed. */
          acceptFreeTicks?: number | null;
          acceptFreeSince?: number | null;
        } | null;
        integrator: { epoch: number } | null;
        ref_announce: RefAnnounceRoutineState | null;
        worktree_divergence: unknown;
      }[]
    >`
      SELECT metadata->'worktree_bridge' AS worktree_bridge, metadata->'integrator' AS integrator,
             metadata->'ref_announce' AS ref_announce, metadata->'worktree_divergence' AS worktree_divergence
        FROM harness_shared.routines
       WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
       LIMIT 1
    `;
    const priorState = rows[0]?.worktree_bridge ?? null;
    // WI-10006476 / D-055: the persisted member/hive conflict fork, if any.
    const catchUpCtx = {
      slug,
      workspaceId,
      priorDivergence: parseWorktreeDivergence(rows[0]?.worktree_divergence),
    };
    const lastEventId = priorState?.lastEventId ?? 0;
    const priorWatermark = { epochSeq: priorState?.epochSeq ?? null, stagingSha: priorState?.stagingSha ?? null };

    // Pending hive-git:staging-advance fed-events since the watermark.
    const feRows = await sql<{ id: number; ts_ms: string | number | null; body: Record<string, unknown> }[]>`
      SELECT id, (extract(epoch FROM ts) * 1000)::bigint AS ts_ms, body
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${potHomeSlug}
         AND surface = 'messages'
         AND id > ${lastEventId}
         AND body->'fed_event'->>'key' = ${STAGING_ADVANCE_EVENT_KEY}
         AND body->'fed_event'->>'repo_key' = ${repoKey}
       ORDER BY id ASC
       LIMIT 200
    `;
    // Nothing new to bridge. ⚠ NOT inherently a "fast no-op" — same shape as the
    // ref-announce reader above: zero rows is the case where the scan completes having
    // found nothing, which is the most expensive outcome and the common one. This site
    // also filters `repo_key`, which is why coord_event_log_fed_event_key_idx (migration
    // 1038) carries repo_key as a TRAILING column after `id` — that lets this query
    // discard non-matching rows in-index (measured 1,992 buffers -> 40) without
    // disturbing the id-ordering the ref-announce readers depend on.
    // See EI-21893070865750886.
    const repoPath = hiveGitRepoPath(potHomeSlug, repoKey);
    const { projectDirForSlug } = await import('../../operator-notes');
    if (feRows.length === 0) {
      // WI-10003772: no new announcement, but the worktree may still trail the
      // ACCEPTED watermark (a deferred-dirty advance whose dirt has since
      // drained). Nothing re-announces that staging, so retry it here.
      const idleWorktreePath = priorWatermark.stagingSha ? await projectDirForSlug(slug, workspaceId) : null;
      if (idleWorktreePath && priorWatermark.stagingSha) {
        await runWorktreeCatchUp(catchUpCtx, repoPath, idleWorktreePath, priorWatermark.stagingSha);
      }
      return;
    }

    const pending: SignedStagingAdvance[] = [];
    /** Row id + age per PENDING entry, index-aligned with `pending` — the
     *  cursor-hold math (P-505) needs the stopped item's row id and age. */
    const pendingRows: { id: number; tsMs: number | null }[] = [];
    let maxRowId = lastEventId;
    for (const row of feRows) {
      maxRowId = Math.max(maxRowId, row.id);
      const fe = row.body?.fed_event as { payload?: unknown } | undefined;
      if (fe && isSignedStagingAdvance(fe.payload)) {
        pending.push(fe.payload);
        pendingRows.push({ id: row.id, tsMs: row.ts_ms === null ? null : Number(row.ts_ms) });
      }
    }
    if (pending.length === 0) {
      // Rows existed (e.g. a malformed payload) but nothing usable — still
      // advance the cursor past them so a bad row can't loop forever.
      // EI-19332963201820362: this write once omitted the accept-free census,
      // and because patchRoutineMetadata is a TOP-LEVEL jsonb merge that DELETED
      // it — one malformed row mid-freeze restarted the streak, so the detector
      // built to catch a stalled bridge went quiet during the stall. Building
      // the value through nextWorktreeBridgeState is what makes that omission
      // impossible rather than merely discouraged. Nothing was BRIDGED here
      // (consumed: 0), so the streak is CARRIED — not incremented, not reset.
      await patchRoutineMetadata(slug, workspaceId, {
        worktree_bridge: nextWorktreeBridgeState(priorState, {
          lastEventId: maxRowId,
          epochSeq: priorWatermark.epochSeq,
          stagingSha: priorWatermark.stagingSha,
          consumed: 0,
          accepted: 0,
          rejectedTerminal: {},
          nowMs: Date.now(),
        }),
      });
      return;
    }

    const worktreePath = await projectDirForSlug(slug, workspaceId);
    if (!worktreePath) return; // no checked-out tree for this slug — next tick retries

    // D-022: only the pinned hive signature grants publication authority.

    // EI-14555: fetch-on-demand, closing the last leg of WI-3583. The dial
    // registry (peer-dial-registry.ts) resolves device pubkey -> live swarm
    // socket, so a machine whose mirror lacks the announced sha now FETCHES it
    // instead of rejecting `unknown-sha` until the remote happens to re-announce.
    // Wired exactly like the ref-announce leg's `openStream` above.
    //
    // Identity here is BEST-EFFORT, deliberately unlike the ref-announce leg:
    // that leg must SIGN, so it returns early without an actor. This leg only
    // VERIFIES, so a machine with no gh identity (or not yet joined to a swarm)
    // must keep bridging exactly as before rather than lose the leg entirely —
    // we simply omit `openDuplex` and serve from the local mirror. The dial is
    // additionally per-announcement conditional inside handleStagingAdvance
    // (it only fires when the sha is genuinely missing), which is what makes it
    // safe to wire unconditionally on a self-announcing single-machine box.
    const actor = await resolveHiveGitActor(workspaceId, slug, potHomeSlug, repoKey);
    const dialContext = actor ? await resolveHiveGitDialContext(workspaceId, slug) : null;
    const openDuplex =
      actor && dialContext
        ? (devicePubkeyBase64: string): Promise<Duplex> =>
            dialContext.openDuplex(devicePubkeyBase64, {
              repoKey,
              peerGithubUserId: actor.githubUserId,
            })
        : undefined;

    const protocolScope = await resolveHiveGitProtocolScope(workspaceId, potHomeSlug, repoKey);
    const outcome = await runWorktreeBridgeTick({
      bareRepoPath: repoPath,
      worktreePath,
      pending,
      prior: priorWatermark,
      accept: {
        allowedDevices: memberDevicePubkeysBase64,
        expectedContext: protocolScope,
        allowLegacy: false,
        knownStoreGenerations: Object.fromEntries(
          Object.entries(rows[0]?.ref_announce?.replayFloors ?? {})
            .filter(([, floor]) => signedProtocolContextMatches(floor, protocolScope))
            .map(([device, floor]) => [device, floor.store_generation]),
        ),
      },
      ...(openDuplex ? { openDuplex } : {}),
    });

    // P-505 cursor-hold (the WI-3497 drop-forever fix): a stop (fetch-failed or
    // a RETRYABLE rejection — unknown-sha / ungranted-epoch) means the stopped
    // item and everything after it must RE-COLLECT next tick, so the cursor
    // only consumes rows strictly before it. Age-bound the hold: an item stuck
    // retryable past the TTL is a genuinely lost object, not a race — consume
    // it (loudly) so one poisoned row can never wedge the bridge forever.
    const persistenceDecision = decideWorktreeBridgePersistence({
      prior: priorState,
      maxRowId,
      pendingRows,
      outcome,
      nowMs: Date.now(),
    });
    const { cursorDecision, bridgeState } = persistenceDecision;
    const newCursor = cursorDecision.cursor;
    if (cursorDecision.expiredRow) {
      console.warn(
        `[git-sync] ${slug}: staging-advance fed-event row ${cursorDecision.expiredRow.id} stuck retryable past ` +
          `${Math.round(WORKTREE_BRIDGE_RETRY_TTL_MS / 3_600_000)}h — consuming it as lost (objects/token never federated)`,
      );
    }

    // EI-19332963201820362: the acceptance census + the accept-free streak.
    //
    // A tick that CONSUMED announcements and ACCEPTED none is the signature of
    // a bridge whose cursor is draining the announcement log while its
    // watermark stands still. One such tick is ordinary (a stale or replayed
    // envelope); a STEADY STATE of them is never healthy, and it is exactly
    // what hid a ~6h canonical-staging freeze on 2026-08-02 (85 commits with
    // no off-box copy) behind `last_status: 'synced'`, a null `last_error`,
    // and a `worktree_bridge.at` advancing every tick. Terminal rejections
    // ('non-fast-forward' for every announcement, because the namespace head
    // trailed the accepted watermark) skip-and-continue and logged NOTHING,
    // so no surface anywhere could distinguish it from a healthy idle bridge.
    // EI-19332963201820362: the census a health check reads. `consumed` and
    // `accepted` together answer "is this bridge idle, or starving?" — a
    // question no persisted field could answer before, and whose absence hid a
    // ~6h canonical-staging freeze behind `last_status: 'synced'`.
    //
    // The streak arithmetic lives in the helper because it is a THREE-way
    // decision (carry / increment / reset) that read as a two-way ternary here;
    // the collapsed case silently let a quiet tick erase an in-progress freeze
    // signal. See worktree-bridge-state.ts + its unit tests.
    await patchRoutineMetadata(slug, workspaceId, { worktree_bridge: bridgeState });

    // Warn on the STREAK, not on a single accept-free tick — one stale envelope
    // is not a fault and warning on it would train readers to ignore this line.
    // Re-warn periodically (not every tick) so a persistent freeze keeps a live
    // signal without flooding the log across hours.
    if (shouldWarnAcceptFree(bridgeState.acceptFreeTicks)) {
      const stuckForMs = bridgeState.acceptFreeSince === null ? null : Date.now() - bridgeState.acceptFreeSince;
      const byReason = Object.entries(outcome.terminalRejections)
        .map(([reason, n]) => `${reason}=${n}`)
        .join(',');
      console.warn(
        `[git-sync] ${slug}: worktree-bridge has accepted NOTHING for ${bridgeState.acceptFreeTicks} consecutive ticks` +
          (stuckForMs === null ? '' : ` (~${Math.round(stuckForMs / 60_000)}m)`) +
          ` while consuming announcements (this tick: ${bridgeState.consumed} consumed, 0 accepted` +
          (byReason ? `, terminal rejections ${byReason}` : '') +
          `). The watermark is standing still at ` +
          `epoch=${outcome.watermark.epochSeq?.epoch ?? 'null'},seq=${outcome.watermark.epochSeq?.seq ?? 'null'} — ` +
          `canonical staging is NOT advancing. Check whether our published namespace head trails the accepted ` +
          `watermark (own_head_publish.publishedSha vs .sha).`,
      );
    }

    if (outcome.errors.length) {
      console.warn(`[git-sync] ${slug}: worktree-bridge-tick reported errors: ${outcome.errors.join('; ')}`);
    }

    // WI-10003772: a tick that consumed announcements but accepted none
    // (stale / replayed / held) re-bridged nothing, so it is also the moment to
    // retry a worktree still trailing the accepted watermark.
    if (outcome.acceptedCount === 0 && outcome.watermark.stagingSha) {
      await runWorktreeCatchUp(catchUpCtx, repoPath, worktreePath, outcome.watermark.stagingSha);
    }
  } catch (e) {
    console.warn(`[git-sync] ${slug}: worktree-bridge-tick failed: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * WI-10003772 — the deferred-advance retry sweep for the worktree bridge. The
 * bridge persists the accepted watermark even when the worktree could not
 * follow (dirty overlap / diverged), and the event that carried it is already
 * consumed, so without this a member that cleans up its dirt stays on stale
 * staging until some OTHER advance happens to arrive. `catchUpWorktreeToWatermark`
 * is fetch-free and cheap when the worktree already contains the watermark, and
 * ff-only / dirty-safe otherwise, so it is safe to run on every idle tick.
 * Only a real advance or an error is logged per tick: deferred-dirty and a clean
 * diverged-manual are expected, self-describing waiting states and would flood
 * the log. A diverged-manual that CONFLICTS is different (WI-10006476 / plan
 * agent-capacity-and-cost-gcp-2026-09-30 D-055): it never resolves on its own,
 * so it is persisted in `metadata.worktree_divergence` and logged once when it
 * starts, when its path set changes, and when it clears.
 */
async function runWorktreeCatchUp(
  ctx: { slug: string; workspaceId: string; priorDivergence: WorktreeDivergence | null },
  repoPath: string,
  worktreePath: string,
  stagingSha: string,
): Promise<void> {
  const { slug } = ctx;
  const r = await catchUpWorktreeToWatermark(repoPath, worktreePath, stagingSha);
  try {
    const obs: DivergenceObservation =
      r.outcome === 'current' || r.outcome === 'advanced' || r.outcome === 'noop'
        ? { kind: 'contained' }
        : r.outcome === 'diverged-manual' && r.from
          ? { kind: 'diverged', localHead: r.from, hiveSha: stagingSha, paths: r.conflictPaths ?? null }
          : { kind: 'unknown' };
    const now = Date.now();
    const t = nextWorktreeDivergence(ctx.priorDivergence, obs, now);
    if (t.write) await patchRoutineMetadata(slug, ctx.workspaceId, { worktree_divergence: t.next });
    const line = describeDivergenceTransition(slug, ctx.priorDivergence, t, now);
    if (line) (t.log === 'cleared' ? console.log : console.warn)(line);
  } catch (e) {
    console.warn(`[git-sync] ${slug}: recording worktree divergence failed: ${e instanceof Error ? e.message : e}`);
  }
  if (r.outcome === 'advanced') {
    console.log(
      `[git-sync] ${slug}: worktree-bridge catch-up advanced the worktree ${r.from?.slice(0, 12) ?? '(unborn)'} -> ` +
        `${stagingSha.slice(0, 12)} (accepted watermark it had been trailing)`,
    );
  } else if (r.outcome === 'error') {
    console.warn(`[git-sync] ${slug}: worktree-bridge catch-up to ${stagingSha.slice(0, 12)} failed: ${r.detail}`);
  }
}

/** WI-1416: the outcome-recording + escalation/dispatch tail of one tick — runs as the
 *  `git-sync:record` checkpoint (see handleGitSync). */
async function recordAndEscalateTick(a: {
  slug: string;
  workspaceId: string;
  repoPath: string | null;
  outcome: GitSyncOutcome;
  errTicks: number;
  contentTicks: number;
  prevContentTicks: number;
  prevSignatureContentTicks: number;
  prevOversizedKeys: string[];
  /** EI-21906459740652039: consecutive ticks (incl. this one) the cumulative-limit
   *  guard peeled — persisted here and read back by the NEXT tick, so a CHRONIC peel
   *  the edge-triggered oversized broadcast structurally cannot see gets re-announced. */
  cumulativePeelTicks: number;
  /** EI-21230011589307899: the previous tick's own-head-publish refusal (or null when
   *  publishing cleanly), and the freeze point seen one tick before that. */
  publishRefusal: { refused: string; blockedAtCommit: string | null } | null;
  prevPublishBlockedAtCommit: string | null;
  cfgBranch: string | undefined;
  maxBlobBytes: number;
  maxCommitTotalBytes: number;
  attributionOn: boolean;
  /** EI-18812945811758018: 'push' | 'commit-only:<reason>' for THIS tick. */
  pushMode: string;
}): Promise<void> {
  const { slug, workspaceId, outcome, errTicks, contentTicks } = a;
  const mergeCompleted = outcome.mergeCompleted ?? [];
  const bulkExcluded = (
    outcome.bulkExcluded ?? outcome.oversized.filter((f) => f.exclusionReason === 'cumulative-limit')
  ).filter((f) => f.exclusionReason === 'cumulative-limit');
  const oversized = outcome.oversized.filter((f) => f.exclusionReason !== 'cumulative-limit');
  await recordOutcome(
    slug,
    workspaceId,
    outcome,
    errTicks,
    contentTicks,
    a.pushMode,
    a.publishRefusal?.blockedAtCommit ?? null,
    a.cumulativePeelTicks,
  );

  // Pipeline history (mig 177): log every tick so the /admin Git tab can show
  // sync/conflict/error rates over time (routines.metadata only keeps the LAST).
  await appendPipelineEvent({
    workspaceId,
    installSlug: slug,
    kind: 'git_sync',
    status: outcome.status,
    detail: {
      pushed: 'pushed' in outcome ? outcome.pushed : [],
      merged: 'merged' in outcome ? outcome.merged : [],
      mergeCompleted,
      conflicts:
        outcome.status === 'conflict'
          ? outcome.conflicts.map((c) => ({ scope: c.scope, files: c.conflictedFiles }))
          : [],
      errors: ('errors' in outcome ? outcome.errors : []).map((e) => ({
        scope: e.scope,
        message: e.message.slice(0, 300),
      })),
      oversized: oversized.length,
      bulkExcluded: bulkExcluded.length,
      contentErrors: outcome.contentErrors.length,
      dirtyPathCount: outcome.dirtyPathCount,
      committedCount: outcome.committedCount,
      skippedPaths: outcome.skippedPaths ?? [],
      consecutiveErrorTicks: errTicks,
      ...(outcome.status === 'synced' ? { headSha: outcome.headSha } : {}),
    },
  });

  await notifySkippedLockedPaths(slug, workspaceId, outcome);

  if (outcome.status === 'conflict') {
    // P-010/P-012: refresh the escalation (listing every conflicted scope) + dispatch
    // a resolver UNLESS one is genuinely in-flight. Sibling submodules still pushed (GAP-1).
    await writeGitSyncEscalation(slug, workspaceId, outcome.conflicts);
    if (!(await resolverInFlight(slug, workspaceId))) {
      const scopes = outcome.conflicts.map((c) => c.scope).join(', ');
      console.warn(`[git-sync] ${slug}: merge conflict(s) in ${scopes} — dispatching merge-resolver`);
      await spawnMergeResolver(slug, workspaceId, outcome.conflicts, a.cfgBranch ?? 'main');
    }
  } else if (
    outcome.status === 'synced' ||
    outcome.status === 'nothing' ||
    (outcome.status === 'error' && mergeCompleted.length > 0)
  ) {
    // A clean pass means any prior conflict is resolved — clear the escalation.
    // An error tick may also clear it, but only when the producer proved that its
    // merge stage completed without conflicts; a push failure alone is not proof.
    await clearGitSyncEscalation(slug, [ESCALATION_KIND]);
    // P-004 (deterministic-commit-workitem-attribution): persist the commit->work-item link
    // from the attributed commits git-sync just made (their trailers). Same flag-gate as the
    // attribution roster; best-effort + deterministic (no LLM). Only on 'synced' — a 'nothing'
    // tick made no new commits.
    if (a.attributionOn && outcome.status === 'synced') {
      await recordSyncedCommitAttribution(slug, workspaceId);
    }
  }

  // EI-438 content guard (P-004/P-005): broken files were QUARANTINED this tick
  // (excluded from the auto-commit so staging stays clean). Escalate + dispatch a
  // content-fixer (deduped), counting consecutive failing ticks so a file the fixer
  // can't repair surfaces to a human instead of looping forever. A clean tick clears
  // the escalation + resets the counter. INDEPENDENT of outcome.status — content
  // errors ride alongside on any status (like oversized), so this runs unconditionally.
  const contentErrors = await revalidateContentErrors(a.repoPath, outcome.contentErrors);
  if (contentErrors.length > 0) {
    const needsHuman = contentTicks >= MAX_CONTENT_FIXER_ATTEMPTS;
    await writeGitSyncContentEscalation(slug, workspaceId, contentErrors, contentTicks, needsHuman);
    // P-009 (EI-24015486799447670): editor notice on the FIRST quarantined tick, the alarm on
    // the fixer-budget transition, and a periodic re-alarm while it persists.
    const notice = decideContentQuarantineNotice({
      contentTicks,
      prevContentTicks: a.prevSignatureContentTicks,
      alarmTicks: MAX_CONTENT_FIXER_ATTEMPTS,
    });
    if (needsHuman) {
      // P-005: the fixer has had MAX_CONTENT_FIXER_ATTEMPTS ticks and the file is STILL
      // broken — STOP auto-dispatching (no infinite silent loop) and surface to a human
      // ONCE, on the transition. The file stays quarantined (never reaches staging), so
      // nothing is at risk while it waits for a human.
      if (notice === 'alarm' || notice === 'realarm') {
        const summary =
          (notice === 'realarm' ? `⚠ STILL QUARANTINED (re-alarm) — ` : '') +
          `git-sync: ${contentErrors.length} broken file(s) STILL failing their content check after ${contentTicks} ticks — ` +
          `the content-fixer couldn't repair them; a human is needed. Quarantined (staging stays clean): ` +
          contentErrors.map((c) => `${c.scope}/${c.file}`).join(', ');
        console.warn(`[git-sync] ${slug}: ${summary}`);
        try {
          await upsertGitSyncContentHumanWorkItem(slug, workspaceId, contentErrors, contentTicks);
        } catch (error) {
          console.warn(
            `[git-sync] ${slug}: could not persist content-quarantine work item: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // P-006: ASSIGN to the agents who edited the quarantined files (derived from presence),
        // not a fleet broadcast. Falls back to ['*'] when attribution is off / unattributable.
        const to = await contentNoticeRecipients(slug, workspaceId, contentErrors, notice);
        await sendMessage(GIT_SYNC_IDENTITY, { to, summary, category: 'git-sync' }).catch(() => {});
      }
    } else {
      const stillCurrent = await spawnContentFixer(slug, workspaceId, contentErrors, a.repoPath, contentTicks);
      if (notice === 'editor-first-tick' && stillCurrent.length > 0) {
        const to = await contentNoticeRecipients(slug, workspaceId, stillCurrent, notice);
        if (to.length > 0) {
          const summary =
            `git-sync QUARANTINED file(s) you edited: they failed a content check, so they (and any file ` +
            `importing them) are withheld from the auto-commit until they pass. Fix forward now; a ` +
            `content-fixer was also dispatched. ` +
            stillCurrent
              .map((c) => `${c.scope}/${c.file} [${c.detectorKey}]`)
              .join(', ')
              .slice(0, 600);
          await sendMessage(GIT_SYNC_IDENTITY, { to, summary, category: 'git-sync' }).catch(() => {});
        }
      }
      if (stillCurrent.length === 0) {
        await patchRoutineMetadata(slug, workspaceId, {
          consecutive_content_error_ticks: 0,
          last_content_errors: [],
          last_content_fixer: null,
        });
        await clearGitSyncEscalation(slug, [CONTENT_ERROR_KIND], CONTENT_ESCALATION_PHASE);
      }
    }
  } else if (a.prevContentTicks > 0 || outcome.contentErrors.length > 0) {
    if (outcome.contentErrors.length > 0) {
      await patchRoutineMetadata(slug, workspaceId, {
        consecutive_content_error_ticks: 0,
        last_content_errors: outcome.contentErrors.map((contentError) =>
          `${contentError.scope}/${contentError.file} [${contentError.detectorKey}]`,
        ),
        last_content_error_signature: null,
        last_content_fixer: null,
      });
    }
    // Clean re-check after a quarantine — the previously-broken files now pass: clear the
    // content-error escalation (mirror the merge-resolver's clean-pass clear). Gated on the
    // prior counter so a no-content tick doesn't issue a pointless UPDATE every 10 min.
    await clearGitSyncEscalation(slug, [CONTENT_ERROR_KIND], CONTENT_ESCALATION_PHASE);
  }

  // EI-20402093158205519 strand census: populated-but-unregistered submodules holding
  // tracked work this pass could not see. INDEPENDENT of outcome.status (like the
  // content guard) — a strand is orthogonal to whether the visible tree synced, and
  // the pass that strands work is otherwise a perfectly clean 'synced'.
  //
  // THREE-WAY on purpose. `null` means the census did not RUN (discovery failed, or a
  // submodulePaths override bypassed it), which is NOT the same as running and finding
  // nothing: treating it as clean would let an unmeasured pass retire a live warning —
  // the exact silence this field exists to break, reintroduced one level up. So an
  // unmeasured tick leaves any existing row untouched, and only a MEASURED clean tick
  // clears it.
  const stranded = outcome.strandedSubmodules;
  if (stranded === null) {
    // Not measured this pass — say nothing, retire nothing.
  } else if (stranded.length > 0) {
    console.warn(
      `[git-sync] ${slug}: ${stranded.length} unregistered submodule(s) hold uncommitted tracked work — ` +
        stranded.map((s) => `${s.path} (${s.trackedFiles})`).join(', '),
    );
    await writeGitSyncStrandEscalation(slug, workspaceId, stranded);
  } else {
    // Measured and clean: every populated submodule is registered (or has nothing dirty).
    // Unconditional, matching the conflict-clear above rather than the content path's
    // counter gate — there is no strand counter in routine metadata, and the clear is a
    // primary-key UPDATE guarded by `escalation IS NOT NULL`, so a no-strand tick costs
    // one statement that matches zero rows.
    await clearGitSyncEscalation(slug, [STRAND_KIND], STRAND_ESCALATION_PHASE);
  }

  // status === 'error' (no conflict): leave any open conflict escalation untouched;
  // errors aren't merge conflicts and shouldn't trigger/clear the resolver.

  // EI-18: repeated push failures / oversized exclusions must be LOUD — a silent
  // metadata-only error once accumulated 20h of unpushable history. The escalation
  // row never clobbers an open conflict escalation (conditional upsert); the coord
  // broadcast fires on transitions only.
  const decision = decideGitSyncEscalation({
    installSlug: slug,
    status: outcome.status,
    consecutiveErrorTicks: errTicks,
    errors: 'errors' in outcome ? outcome.errors : [],
    oversized: outcome.oversized,
    maxBlobBytes: a.maxBlobBytes,
    maxCommitTotalBytes: a.maxCommitTotalBytes,
    prevOversizedKeys: a.prevOversizedKeys,
    chronicCumulativeTicks: a.cumulativePeelTicks,
    publishRefusal: a.publishRefusal,
    prevPublishBlockedAtCommit: a.prevPublishBlockedAtCommit,
  });
  if (decision.escalate) {
    await writeGitSyncErrorEscalation(slug, workspaceId, {
      reasons: decision.reasons,
      consecutiveErrorTicks: errTicks,
      errors: 'errors' in outcome ? outcome.errors : [],
      oversized: outcome.oversized,
    });
  } else if (decision.clear) {
    await clearGitSyncEscalation(slug, [ESCALATION_ERROR_KIND]);
  }
  if (decision.broadcast) {
    console.warn(`[git-sync] ${slug}: ${decision.broadcast}`);
    await sendMessage(GIT_SYNC_IDENTITY, { to: ['*'], summary: decision.broadcast, category: 'git-sync' }).catch(
      () => {},
    );
  }
}

/**
 * Fire the git-sync action ONCE, on demand — the SAME work a cron tick does (lock,
 * content-guard, attribution, commit + push). Shared by the git-sync:run verb and by
 * release:deploy (fire-before-deploy so a (force-)deploy ships CURRENT staging, not a
 * stale tree when git-sync is lagging/wedged — WI-1320). Reads the routine's own
 * trigger_config so it behaves exactly like a tick; default config when the row is absent.
 */
export async function fireGitSyncNow(
  installSlug: string,
  workspaceId: string,
  repoPath?: string | null,
): Promise<GitSyncFireOutcome> {
  // WI-10000734: this is the shared ON-DEMAND seam used by both git-sync:run
  // and release:deploy. A request-only host can intentionally serve an older
  // green release while the dedicated background host carries current staging
  // authority code. Letting the request host execute this mutation produced a
  // late v2/no-hive-signature staging advance after the current host's v3
  // advance; the receiver correctly rejected it and origin froze. Scheduled
  // execution calls handleGitSync directly and is unaffected. Refuse every
  // manual caller here before reading the routine row or touching refs.
  if (requestOnlyHost()) {
    throw new Error(
      'git-sync on-demand fire refused on request-only host: route the mutation to the background-worker host',
    );
  }
  const { sql } = getOrgPg();
  const rows = (await sql`
    SELECT trigger_config FROM harness_shared.routines
     WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug} AND name = 'git-sync'
     LIMIT 1`) as Array<{ trigger_config: Record<string, unknown> | null }>;
  const triggerConfig = rows[0]?.trigger_config ?? {};
  return handleGitSync({ installSlug, workspaceId, triggerConfig, payloadTemplate: null }, repoPath);
}

/**
 * The scheduled (cron) entry point. The only engine-facing signal it forwards is
 * WI-10004472's `replayAbandoned`: the routine engine must end an abandoned
 * recovery replay without issuing its settle step.
 */
export async function gitSyncCronAction(ctx: SystemActionCtx): Promise<SystemActionResult | void> {
  const outcome = await handleGitSync(ctx);
  if (outcome.status === 'skipped' && 'replayAbandoned' in outcome && outcome.replayAbandoned) {
    return { replayAbandoned: { reason: outcome.reason } };
  }
}

// WI-1416: ownSteps — the handler checkpoints its OWN DBOS sub-steps, so the routine
// engine must run it at the WORKFLOW layer (nested inside the engine's single step,
// DBOS.runStep silently degrades to a plain call and nothing checkpoints).
// The routine engine only consumes its documented SystemActionResult hook
// (durable child spawns); the typed pipeline outcome is for on-demand callers
// such as git-sync:run, which invoke fireGitSyncNow directly. Keep the cron
// registration's contract explicit instead of leaking the action-specific
// result through the generic registry type.
registerSystemAction(
  'git-sync',
  gitSyncCronAction,
  // `scheduling: 'on-demand'` (EI-18752496371939475): one row per HARNESS, ensured by
  // `git-sync-routine.ts` as harnesses are registered — not a standing workspace-wide row a
  // seed script creates. A workspace with no harnesses yet legitimately has zero rows.
  { ownSteps: true, scheduling: 'on-demand' },
);
