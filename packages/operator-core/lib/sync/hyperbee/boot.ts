/**
 * Single-function composer: bring a harness's Model B sync substrate
 * fully online.
 *
 * Plan: papercusp-substrate-model-b-rewrite-2026-05-31 (Stage 4).
 *
 * Model B replaces the multi-writer Autobase with ONE signed,
 * append-only log PER PEER (`openOwnLog`) plus a read-merge over the
 * admitted set of logs (`mergeAdmittedLogs`). This composer:
 *
 *   1. Opens / creates the per-harness corestore.
 *   2. Opens the peer's OWN writable log (`openOwnLog`).
 *   3. Registers all per-table PG projection writers.
 *   4. Drives a read-merge over the admitted set (own log + any remote
 *      logs admitted at runtime via the swarm announce channel) into PG.
 *
 * Production call site (instrumentation-node.ts / host-bootstrap.ts):
 *
 *   await awaitEnsurePaths();              // P-031a — both ensure paths complete
 *   const harnesses = await loadHarnessRegistry(workspaceId);
 *   for (const h of harnesses) {
 *     handles.set(h.slug, await bootHarnessSubstrate({
 *       workspaceRoot,
 *       workspaceId,
 *       harnessSlug: h.slug,
 *     }));
 *   }
 *
 * What this function does NOT do:
 *   - PG → substrate write hooks. Those land per-table as call sites
 *     opt into "fan out my PG write to my own log too." Until then the
 *     substrate only consumes admitted ops; local writes still flow
 *     through PG-direct.
 */

import {
  getHarnessStore,
  closeHarnessStore,
  getHarnessScopedStore,
  closeHarnessScopedStore,
  harnessStorePath,
  type HarnessStoreOpts,
} from './corestore';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { randomUUID } from 'node:crypto';
import { issueGitServingCapability, type GitServingRequest, type GitServingState } from '../pot-git/serving-capability';
import { openOwnLog, openRemoteLog, type OwnLog, type PeerLogOp, type RemoteLog } from './peer-log';
// P-004 (WI-1840, WI-183 class): the replication-liveness registry — read-time
// per-log verdicts (live/no_replicator/frozen/…) for the status surfaces + the
// durable-EI escalation on a sustained stall. Fed once per admitted remote log
// per merge pass, right next to the legacy checkReplicationStall sampling.
import {
  sampleReplicationLiveness,
  // WI-5781: the expected-but-unadmitted axis — fed from `pendingPeers`, the
  // one signal that can see a log which never made it into `admitted` at all.
  sampleUnadmittedPeer,
  clearUnadmittedPeer,
  dropReplicationLogState,
  dropReplicationLiveness,
  setDhtUniverseAssertion,
  setReplicationRepairHandler,
  // EI-20453145044075727: intra-pass heartbeat — see onCursorAdvance below.
  touchReplicationLivenessSamples,
  type ReplicationStallEpisode,
} from './replication-liveness';
import { stampOpHlc } from './hlc-stamp';
import type { HlcClock } from '@papercusp/locks-core';
import {
  createMergeCursor,
  createMergeProgressProbe,
  createPgMergeCursorSeedCache,
  describeMergeProgress,
  mergeAdmittedLogsIncremental,
  seedCursorFromSnapshots,
  persistCursor,
  combineSnapshotApplyMarks,
  snapshotApplyMarkOf,
  snapshotApplyMarks,
  DEFAULT_GET_TIMEOUT_MS,
  type AdmittedLog,
  type CancellableReadLog,
  type PrefetchRange,
  type MergeCursorPeerLifecycleUpdate,
  type MergeCursorStore,
  type MergeApplyFailure,
  type SnapshotApplyMark,
} from './read-merge';
import { DeferralEvictionReFold } from './eviction-refold';
import { discoverOwnCompactionAnchor as discoverOwnCompactionAnchorOf } from './own-compaction-anchor';
import {
  formatSnapshotFoldProgress,
  isSeedableForUnfilteredFold,
  OWN_COMPACTION_ANCHOR_RETRY_BASE_MS,
  OWN_COMPACTION_FAILURE_BACKOFF_BASE_MS,
  ownCompactionBackoffMs,
  produceLogSnapshot,
  shouldCompactOwnLog,
  snapshotCompactThreshold,
  SnapshotAbortedError,
  throttleSnapshotFoldProgress,
  type ProduceSnapshotResult,
  type SnapshotFoldCheckpointStore,
  type SnapshotFoldWorkerFactory,
} from './log-snapshot';
import { fileSnapshotFoldCheckpointStore, SnapshotFoldWorker } from './snapshot-fold-offload';
import { join as joinPath } from 'node:path';
import { papercuspRoot } from '../../papercusp-root';
import {
  loadLiveGovernorReceiptSnapshotKeys,
  loadOwnCompactionEnvelopeKeys,
} from './governor-receipt-snapshot-census';
import type {
  GovernorReceiptEnvelopeKeys,
  GovernorReceiptSnapshotFilter,
} from './governor-receipt-snapshot-filter';

/**
 * WI-10002836 — how often a long own-log compaction reports its fold position. One
 * row per minute keeps a 30-minute full-history fold legible, both in boot history
 * and in the journal, without flooding PG. A fold shorter than this emits nothing.
 */
export const OWN_COMPACTION_PROGRESS_INTERVAL_MS = 60_000;
import type { OpEnvelope } from './op-envelope-types';
import { buildHiveRekeyBootDeps, type HiveRekeyBootDeps } from './hive-epoch-boot-deps';
import { drainQueuedEpochContent, type DrainedEpoch } from './hive-epoch-op-gate';
import { PendingMembershipContent, reapplyDrainedMemberContent } from './pending-membership-content';
import { acceptOpVersion, CURRENT_SCHEMA_VERSION, type SchemaVersionAlert } from './schema-version';
import { schemaVersionEvents } from './schema-version';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import {
  formatMemoryFederationDegradedWarn,
  readMemoryFederationFlagOnce,
  type MemoryFederationFlagRead,
} from './memory-federation-flag-read';
import { loadRevokedPubkeysCached } from './load-revoked-pubkeys';
import {
  registerAllHarnessProjections,
  buildHarnessProjectionApply,
  type HarnessProjectionApply,
} from './projections/register-all';
import { createPlanPartsRecomposeBatch } from './projections/harness-plan-parts';
import { startBootstrapProgressPoller } from './bootstrap-progress-poller';
import { recordBootEvent, type BootHistoryKind } from './boot-history';
import { resolveSeedLogAdmissions, validateSeedReplicaForAdmission } from './seed-log-admission';
import { SEED_EXCLUDED_TABLES } from './seed-excluded-tables';
import type Corestore from 'corestore';
import { bindingResolvesHiveHomeProjection, deriveSwarmTopic, type SwarmBinding } from './derive-swarm-topic';
import {
  joinHarnessSwarm,
  getSharedSwarm,
  getDhtUniverseAssertion,
  type AnnounceConnectionContext,
  type HyperswarmLike,
  type SwarmHandle,
} from './swarm';
// ── P-006 §5.1–§5.3 scoped-log federation (P-108) ── scoped cores live in a
// SEPARATE never-`replicate()`d corestore and are served per-connection through
// the fail-closed roster gate; the coordinator hangs off the announce exchange.
import { ScopeCoreRegistry, type ScopedStoreLike } from './scope-cores';
import { ScopeFederation } from './scope-federation';
import { getScopeRoster } from '../../p2p/scope-roster';
import { PgFleetDirectory } from '../../p2p/fleet-directory';
import { bumpRefusedOpCounter } from '../../p2p/receipts';
import { formatScopeId, type ScopeId } from '../pot-git/scope-repo';
import { offloadReplicationToSidecar } from './substrate-replication-offload';
import {
  buildAnnounce,
  buildLogSupersession,
  verifyAnnounceDetailed,
  verifyLogSupersession,
  type SignedAnnounce,
} from './announce';
import { readSupersededOwnLogKeys } from './own-log-supersession';
import {
  makeAdmissionDecider,
  announceSlugInScope,
  trustedHiveMemberDeviceAdmission,
  type AdmissionInput,
  type AdmissionResult,
} from './read-admission';
import {
  resolveLocalAnnounceIdentity,
  resolveLocalAnnounceIdentityFromHiveMembers,
  type ResolveLocalAnnounceIdentityOpts,
  type LocalAnnounceIdentity,
} from './local-announce-identity';
import { buildVerifyBindingAdapter } from './verify-binding-adapter';
import { signWithDeviceKey } from '../../identity/sign-with-device-key';
import { recordTelemetryReport } from '../../record-telemetry';
import { TELEMETRY_KINDS, type TelemetryKind } from '../../telemetry-kinds';
// ── Owner-enforcement (plan shared-hive-owner-enforcement-2026-06-19) ── the single
// merge-seam where every inbound op is checked against the owner's signed Hive policy:
// EN-2 rate (inner) wrapped by EN-4 ban/allowlist/takedown/content (outer). Default-off
// (no policy ⇒ passthrough). Composition is proven by policy-admission.apply.test.ts.
import type { HivePolicy } from '../../hive-policy-schema';
import { getHivePolicyCached } from '../../hive-policy-store';
import { isContentTakenDown } from '../../hive-moderation';
import { MemberRateLimiter } from './rate-limiter';
import { EliteNicheRateLimiter } from './elite-niche-rate-limiter';
import { registerRateLimiter, unregisterRateLimiter } from './rate-limiter-registry';
import { makeRateLimitedApply } from './rate-limit-admission';
import { makePolicyEnforcedApply } from './policy-admission';

/**
 * Memoises a dynamic `import()` so a call site that runs per-op / per-announce /
 * per-merge-pass (as opposed to once at process boot) pays the tsx ESM-loader
 * synchronous loader-thread round-trip (`makeSyncRequest` — WI-6402, 11.84% of
 * the bg-host main thread in profile) only ONCE per process, not once per call.
 *
 * A failed load is explicitly NOT cached — the promise is reset to `null` on
 * rejection so a transient import failure cannot permanently pin every later
 * call onto a degraded/fallback path. Same discipline as
 * `packages/operator-core/lib/fleet/git-via-sidecar.ts:loadSidecarModules`,
 * generalised so this file's dozen-plus per-call dynamic-import sites don't
 * each hand-roll the same module-scoped promise.
 *
 * The `load` thunk is not invoked until the FIRST call to the returned
 * function — this module-scope `const` does not eagerly import anything at
 * module-evaluation time, so it preserves the deliberate runtime-import
 * cycle-avoidance some call sites rely on (e.g. `./boot-all`, which imports
 * this module back).
 */
export function memoizeDynamicImport<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => {
    if (!cached) {
      cached = load().catch((e: unknown) => {
        cached = null;
        throw e;
      });
    }
    return cached;
  };
}

// Modules dynamically `import()`ed from per-call/per-tick hot paths below
// (merge passes, per-announce admission, per-op identity resolution) —
// memoised once per process instead of re-resolved on every invocation.
const loadHiveFederationModule = memoizeDynamicImport(() => import('../../hive-federation'));
const loadFederatedPotScopeModule = memoizeDynamicImport(() => import('../../federated-pot-scope'));
const loadHiveMembershipStoreModule = memoizeDynamicImport(() => import('../../hive-membership-store'));
const loadHarnessRegistryModule = memoizeDynamicImport(() => import('../../harness-registry'));
const loadHiveMemberIdentitySetModule = memoizeDynamicImport(() => import('./hive-member-identity-set'));
const loadHiveIdentityModule = memoizeDynamicImport(() => import('../../hive-identity'));
const loadReplicationStallEiModule = memoizeDynamicImport(() => import('./replication-stall-ei'));
const loadHiveMembershipAdmissionModule = memoizeDynamicImport(() => import('../../hive-membership-admission'));
const loadPotCanonicalSlugReconcileModule = memoizeDynamicImport(() => import('../../pot-canonical-slug-reconcile'));
// `./boot-all` imports THIS module back — a static import would cycle, so this
// stays a runtime import; memoising only caches the RESULT after the first
// (still-lazy, still-runtime) call, it does not change when the import fires.
const loadBootAllModule = memoizeDynamicImport(() => import('./boot-all'));

/** Short human label for a dropped peer, for the boot-history message field.
 *  Truncates the (long) Noise key to its first 8 hex chars. */
function peerLabel(keyHex?: string, ip?: string): string {
  const parts: string[] = [];
  if (keyHex) parts.push(`key=${keyHex.slice(0, 8)}`);
  if (ip) parts.push(`ip=${ip}`);
  return parts.join(' ') || 'unknown peer';
}

/** Polled-merge fallback interval (ms). The own log + admitted remotes are
 *  re-merged on this cadence in addition to the on-admit + initial passes. */
const MERGE_POLL_MS = 1000;
/**
 * Coalesce adjacent own-log appends into one fresh signed writer-progress
 * announce. Outbox drains append sequentially and may carry hundreds of rows;
 * re-signing once per row would turn the liveness signal into avoidable crypto
 * load, while a 25ms edge is still effectively immediate compared with the
 * 1s merge poll and the prior five-minute periodic reflush fallback.
 */
const WRITER_PROGRESS_ANNOUNCE_DEBOUNCE_MS = 25;
/**
 * WI-183: default grace window (ms) for the replication-stall detector — how
 * long an admitted remote log may show zero live replicator peers, after
 * having shown at least one before, before it's treated as a genuine stall
 * rather than the ordinary churn of the two-speed swarm re-peer cadence
 * (`DEFAULT_SUBSTRATE_FAST_WINDOW_MS`/`_SLOW_REFRESH_MS` in swarm.ts, which
 * can legitimately take a while to re-pair). 3 minutes comfortably exceeds
 * both.
 */
const DEFAULT_REPLICATION_STALL_GRACE_MS = 3 * 60 * 1000;
/**
 * EI-18723690188615364: default deferral budget for the post-repair
 * confirmation window's zero-live-peers branch. 5 × the 180s default grace
 * ≈ 15 minutes — far longer than the few-seconds mid-reconnect WI-5481's
 * re-arm exists to ride out, but finite, so a log that never regains a
 * replicator peer stops deferring silently forever.
 */
const DEFAULT_REPAIR_CONFIRMATION_MAX_DEFERRALS = 5;
/** Default pending-retry interval (ms). A pending peer is re-checked on this
 *  cadence until it becomes verified, conclusively fails, or exceeds the grace
 *  window. D-006. */
const DEFAULT_PENDING_RETRY_MS = 5000;
/**
 * Boot-scoped grace window for pending peers (ms). Once a peer has been in the
 * pending set longer than this, it is removed with 'announce_rejected' rather
 * than retried forever. This is deliberately short (vs a ~24h binding-propagation
 * window): the boot session may not live that long, and the peer will
 * re-announce on the next boot. 30 minutes is
 * enough for normal GitHub propagation lag while bounding the retry budget.
 */
const BOOT_PENDING_GRACE_MS = 30 * 60 * 1000; // 30 minutes
/**
 * WI-752 / FED-2 — JOIN-retry self-heal. The boot-time swarm join is one-shot;
 * a TRANSIENT failure (DHT not ready, a gh-identity / keychain blip, a momentary
 * network fault) lands the harness LOCAL-ONLY with NO swarm join to refresh, and
 * pre-WI-752 it stayed local-only until an operator RESTART. So a failed join is
 * retried on a bounded exponential backoff (base → cap) until it succeeds —
 * federation then establishes with no restart, and a PERMANENT cause (genuinely
 * unauthenticated, etc.) simply backs off at the cap, self-healing the instant
 * the cause clears (e.g. a gh token is restored). `swarmJoinRetryMs: 0` disables.
 */
const DEFAULT_SWARM_JOIN_RETRY_MS = 15_000;
const SWARM_JOIN_RETRY_CAP_MS = 5 * 60 * 1000; // 5 minutes

/**
 * WI-10003427 — pass-level merge watchdog. Every admission is drained INSIDE a
 * merge pass (drainAdmissionQueue under the merge gate), so a pass that never
 * settles silently starves every later announce: no announce_admitted /
 * rejected / pending line, and the harness still reads "healthy". While a pass
 * stays in flight past this threshold, a `merge_stalled` boot event names the
 * stage it is sitting in (re-armed with doubling back-off up to the cap), and
 * an announce queued for this long records `announce_admission_stalled`.
 * Diagnostic only — never cancels the pass. `mergePassStallMs: 0` disables.
 */
const MERGE_PASS_STALL_MS = 120_000;
const MERGE_PASS_STALL_MAX_REARM_MS = 30 * 60 * 1000;
// Stage 6 (DoS Phase-4 reshape): cap how many ops the merge ingests from any
// single author per pass. A noisy/Sybil peer bloats only its OWN log, so this
// bounds per-pass ingest rather than mitigating a shared-structure flood.
const MAX_OPS_PER_AUTHOR = 50_000;
// Fix 4: bound each per-remote `core.update({wait:true})` inside `mergeNow` so a
// connected-but-stalled peer can't hold the `merging` lock forever (which would
// stall own-log progress + every other remote). Reuse the same few-second bound
// the read-merge uses for its per-op `get` (DEFAULT_GET_TIMEOUT_MS).
const UPDATE_TIMEOUT_MS = DEFAULT_GET_TIMEOUT_MS;

/**
 * Race a promise against a timeout. Resolves with the promise's value, or
 * REJECTS with a timeout error once `ms` elapses (the caller's `try/catch`
 * treats a timed-out update as "merge at last-known length"). The timer is
 * `unref`'d so it never keeps the event loop alive on its own, and cleared as
 * soon as either side settles. A non-positive `ms` disables the bound (awaits
 * the promise directly — used by tests over instant fakes).
 */
function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('update timed out')), ms);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * A local write the per-table helpers append to the own log. Mirrors the
 * fields the old Autobase `OpEnvelope` carried for put/del ops; `writerPubkey`
 * is mapped onto the single-writer log's `author_pubkey`.
 */
export interface LocalWriteOp {
  type: 'put' | 'del';
  table: string;
  hbKey: string;
  value?: unknown;
  ts: number;
  schema_version: number;
  /** Local-writer pubkey (hex), threaded to clobber-event attribution. */
  writerPubkey?: string;
  /**
   * Hybrid Logical Clock stamp (`encodeHlc` string, P-010). Normally left unset
   * by the per-table helpers — `handle.append` stamps it from the process HLC
   * clock so EVERY federated write carries a causal order key. A caller may
   * pre-set it (the stamp is preserved, not overwritten) e.g. to replay a
   * captured HLC.
   */
  hlc?: string;
  /**
   * Hive epoch RE-KEY (C-001 read-plane revocation, shared-hive-rekey-2026-06-19,
   * gated on `papercusp-hive-rekey`): the epoch this op's `value` payload was
   * encrypted under. Stamped by the capture-wire (outbox-drain) from the injected
   * EpochEncryptCapability's returned `{ epoch }` for selected hive-content ops;
   * the apply-side decrypt-gate reads it to resolve the wrapped epoch key
   * (EpochKeyProvider) + `decryptOpPayload`. Absent ⇒ plaintext op (today's path +
   * the admission/key/policy ops that must stay readable). The read-side twin is
   * `OpEnvelope.epoch`.
   */
  epoch?: number;
}

export interface BootHarnessOpts {
  workspaceRoot: string;
  workspaceId: string;
  harnessSlug: string;
  /**
   * Optional swarm binding. When present, the harness joins a
   * Hyperswarm topic + exchanges signed announces with peers, admitting
   * remote per-peer logs that pass the D-004 read-admission decision.
   * Omit (or pass null) for `state: private` harnesses that stay
   * single-engineer.
   *
   * v5 §0.2.7 + addendum 1 — pass `{ kind: 'gh', github_repository_id }`
   * for the canonical post-binding topic. Pre-binding dev mode can
   * pass `{ kind: 'local', workspace_id, harness_slug }`.
   */
  swarmBinding?: SwarmBinding | null;
  /**
   * Test seam — supply a fake swarm. Runtime callers leave this
   * undefined; bootHarnessSubstrate lazy-imports the real swarm via
   * getSharedSwarm() (one Hyperswarm per process).
   */
  swarmOverride?: HyperswarmLike;
  /**
   * WI-2105 REV fix — INJECTED durable merge-cursor store. The production folder
   * (substrate-sidecar-host) reads the SUBSTRATE_MERGE_CURSOR_PG flag and passes
   * a PG-backed store so a bg-host restart RESUMES each log's fold from PG instead
   * of re-folding from 0 (the REV restart loop). Omit / null ⇒ the cursor is
   * in-memory only — byte-identical to the pre-fix behavior, and hermetic for the
   * many merge tests that must not touch the shared PG cursor table.
   */
  mergeCursorStore?: MergeCursorStore | null;
  /**
   * WI-3985 test seam for the live memory-federation receive gate. Production
   * resolves MEM0_FEDERATION_EGRESS; boot snapshots it once per serialized
   * merge pass and threads that snapshot into the memory projection.
   */
  memoryFederationFlagOn?: () => Promise<boolean>;
  /**
   * Merge-poll interval override (ms). Tests set this to 0 to disable the
   * timer and drive `mergeNow()` by hand. Default 1000.
   */
  mergePollMs?: number;
  /**
   * WI-10002836 test seam: minimum spacing (ms) between own-compaction progress rows.
   * Default `OWN_COMPACTION_PROGRESS_INTERVAL_MS`. Tests pass 0 to record every window.
   */
  ownCompactionProgressIntervalMs?: number;
  /**
   * WI-10002836 test seams: the fold-worker factory (default `SnapshotFoldWorker.open`) and
   * the first backoff after a failed own compaction (default
   * `OWN_COMPACTION_FAILURE_BACKOFF_BASE_MS`), so a test can fail one run and watch the retry.
   */
  ownCompactionFoldWorker?: SnapshotFoldWorkerFactory;
  ownCompactionFailureBackoffBaseMs?: number;
  /**
   * P-006 test seam: where the own compaction persists its resume checkpoint. Default: a
   * file under `<papercuspRoot>/snapshot-fold-checkpoints/`, keyed by workspace, harness and
   * own-log key. `null` disables resume.
   */
  ownCompactionCheckpointStore?: SnapshotFoldCheckpointStore | null;
  /**
   * P-530 test seam. Production reads the current work_items-backed legacy receipt
   * keys immediately after capturing the own-log boundary, for the own compaction and
   * the release cut's head snapshot alike; tests inject a census without touching
   * PostgreSQL.
   */
  loadOwnCompactionGovernorReceiptKeys?: (workspaceId: string) => Promise<readonly string[]>;
  /**
   * D-024 test seam. Production loads the Hive's epoch keys (load-only, never minting) so
   * the P-530 filter can open `{__rekey}` rows; tests inject keys or none.
   */
  loadOwnCompactionEnvelopeKeys?: (workspaceId: string, potId: string) => Promise<GovernorReceiptEnvelopeKeys>;
  /**
   * WI-6324 test seam: managed recurring timers are inert under Vitest by
   * default. The zombie-socket integration repro opts in ONLY the independent
   * replication-liveness timer so it can verify that detection continues while
   * the serialized merge pass is blocked. Production callers leave undefined.
   */
  allowReplicationLivenessTimerInTest?: boolean;
  /**
   * WI-183: how long (ms) an admitted remote log may show zero live
   * replicator peers, after having previously shown at least one, before
   * `checkReplicationStall` records a `replication_stalled` boot event.
   * Tests shrink this to exercise the detector without a real wait.
   * Default `DEFAULT_REPLICATION_STALL_GRACE_MS` (3 minutes).
   */
  replicationStallGraceMs?: number;
  /**
   * WI-5686: SEPARATE grace (ms) for the replication-liveness registry's
   * connected_never_replicated (zombie-socket) axis only — the no_replicator
   * and frozen axes (and the legacy checkReplicationStall above) always use
   * `replicationStallGraceMs`. Defaults to `replicationStallGraceMs` when
   * omitted, so a caller that only ever set the one option keeps identical
   * behavior. See `SampleReplicationLivenessOpts.connectedNeverReplicatedGraceMs`
   * for the full rationale — sharing one grace value across all three axes
   * made no_replicator false-fire (with its disruptive repair-on-detect
   * session tear-down) on every ordinary cold-restart cycle whenever the
   * zombie axis was intentionally shortened (WI-5634's rig soak override).
   */
  connectedNeverReplicatedGraceMs?: number;
  /**
   * WI-38376: SEPARATE grace (ms) for the replication-liveness registry's
   * `frozen` axis only. Defaults to `replicationStallGraceMs` when omitted, so
   * a caller that only ever set the one option keeps identical behavior. See
   * `SampleReplicationLivenessOpts.frozenGraceMs` for the full rationale — in
   * short, WI-5686 gave the zombie axis its own knob and left `frozen` sharing
   * the 180s default, which is 2x the 90s SLA replication_soak enforces, so
   * the one axis that covers "replicator attached, writer ahead, nothing
   * arriving" could never fire before that scenario gave up.
   */
  frozenGraceMs?: number;
  /**
   * EI-18723690188615364: how many times the post-repair confirmation window
   * may defer judgment because the sample it landed on showed ZERO live
   * replicator peers (the WI-5481 mid-reconnect case) before it gives up and
   * records a `replication_repair_confirmation_abandoned` verdict instead of
   * re-arming forever in silence. Tests shrink this to exercise the bound
   * without burning a pass per deferral.
   * Default `DEFAULT_REPAIR_CONFIRMATION_MAX_DEFERRALS` (5) — ≈15 minutes at
   * the default 180s grace.
   */
  repairConfirmationMaxDeferrals?: number;
  /**
   * Test seam — override the read-admission binding check. Production leaves
   * this undefined and the real `buildVerifyBindingAdapter` (verifyAttestation
   * on the announce's attestation_gist_id — write-free join) is used. Tests
   * inject a pure predicate so `onAnnounce` admit/reject/pending can be exercised
   * without network.
   *
   * Returns `'verified' | 'pending' | 'fail'` (D-002 / D-006 3-state).
   */
  verifyBindingOverride?: (
    devicePubkeyBase64: string,
    githubLogin: string,
    githubUserId: number,
    attestationGistId: string,
  ) => Promise<'verified' | 'pending' | 'fail'>;
  /**
   * Pending-retry interval override (ms). Tests set this to a small value
   * (e.g. 10ms) to drive the retry tick without sleeping. Default 5000.
   * Set to 0 to disable the retry timer entirely (tests that don't need it).
   */
  pendingRetryMs?: number;
  /**
   * Max pending peers whose channel-2 binding is retried in ONE
   * `retryPendingOnce()` pass. Peers are swept ROUND-ROBIN across passes from
   * a persistent log-key cursor, so the GitHub API call rate is bounded
   * independently of the pending-peer count. Non-finite / non-positive values
   * fall back to the default; there is deliberately no unbounded setting.
   */
  pendingRetryBatchSize?: number;
  /**
   * Test seam for the pending-retry timer. Production uses global setTimeout /
   * clearTimeout. Tests can capture the callback and invoke one retry tick
   * directly, avoiding wall-clock sleeps around real corestore I/O.
   */
  pendingRetrySetTimeout?: typeof setTimeout;
  pendingRetryClearTimeout?: typeof clearTimeout;
  /**
   * WI-752 / FED-2 substrate-swarm self-heal cadence (ms), forwarded to
   * `joinHarnessSwarm`. Production leaves these undefined → the proven defaults
   * (`DEFAULT_SUBSTRATE_REFRESH_MS` / `_FAST_WINDOW_MS` / `_SLOW_REFRESH_MS`) so
   * a dropped/aged-out peer re-pairs without an operator restart. Tests set a
   * small `swarmRefreshMs` to drive the re-peer loop quickly, or `0` to disable
   * it (and drive `discovery.refresh()` by hand). See swarm.ts.
   */
  swarmRefreshMs?: number;
  swarmFastWindowMs?: number;
  swarmSlowRefreshMs?: number;
  /** WI-10005270: cap on the stalled-log refresh backoff (swarm.ts `stalledMaxRefreshMs`). */
  swarmStalledMaxRefreshMs?: number;
  /**
   * WI-752 / FED-2 join-retry base interval (ms). When the boot-time swarm join
   * FAILS (→ local-only), retry it on a bounded exponential backoff starting at
   * this value (capped at `SWARM_JOIN_RETRY_CAP_MS`) until it succeeds — so a
   * transient join failure self-heals with no operator restart. Default
   * `DEFAULT_SWARM_JOIN_RETRY_MS`; `0` disables the retry (tests).
   */
  swarmJoinRetryMs?: number;
  /**
   * Fired ONCE when the WI-752 join-retry attaches the swarm AFTER boot. Anything
   * wired against the boot-time `swarm: null` handle (the presence announce's
   * gossip registration no-ops without a swarm and is then marked wired forever —
   * the 2026-07-17 bg-host boot lost presence-gossip for its whole lifetime this
   * way) must re-wire here. boot-all passes `markSendSideUnwired + re-wire`.
   */
  onSwarmJoinRecovered?: () => void;
  /**
   * Test seam (A-003) — override how the joiner's hive-home projection slug is
   * resolved. Production leaves this undefined and `resolveHiveHomeProjectionSlug`
   * imports the real `joinerPotHomeSlug` (reads the remote_hive registry). Tests
   * inject a resolver (e.g. one that returns `null` at boot then the hive-home slug
   * on the `rekey` call) to exercise the buffer→replay-on-rebind path WITHOUT the
   * registry or a live swarm. Called only when `swarmBinding.kind === 'hive'`.
   */
  joinerPotHomeSlugOverride?: (workspaceId: string, harnessSlug: string) => Promise<string | null | undefined>;
  /**
   * Test seam (WI-559 / WI-2105) — override how the OWNER's hive-home slug is
   * resolved (the real `potHomeSlugForHarness`, which reads the harness_registry
   * for `hive`-kind / `hive_slug` / PG-identity fallback). Production leaves this
   * undefined and boot imports the real resolver. Tests inject one to exercise the
   * content-guard-home resolution WITHOUT the registry — e.g. an OWNED-hive member
   * harness (`hive-canary`) whose home (`papercusp`) ≠ own slug and whose joiner
   * rebind is null, to assert cross-member content APPLIES via `contentGuardHiveHome`
   * (not a no-hiveHome drop) while the hive-home projection rebind stays OFF (no
   * double-apply). Gated on `bindingResolvesHiveHomeProjection` like the real path.
   */
  potHomeSlugForHarnessOverride?: (workspaceId: string, harnessSlug: string) => Promise<string | null | undefined>;
  /**
   * Test seam — override the boot-scope re-key dependency composition. Production
   * leaves this undefined and builds the real crypto/provider stack. Passing null
   * explicitly disables the build for hermetic unit tests; the override is honored
   * both at initial boot and during a re-key rebuild so a test never reaches PG by
   * accident through the re-key lifecycle.
   */
  rekeyDepsOverride?: HiveRekeyBootDeps | null;
  /**
   * Test seam — override the projection apply sink. Production leaves this
   * undefined and the per-harness scoped apply (`buildHarnessProjectionApply`,
   * which routes ops to THIS harness's own projection set) is used. Tests
   * inject a capturing apply to assert which ops merge, without the real PG
   * projections or the (collision-prone) global registry.
   */
  applyOverride?: (op: OpEnvelope) => Promise<boolean>;
  /**
   * Test seam — override how THIS peer's signed announce identity is resolved
   * and signed. Production leaves this undefined: the announce identity is
   * resolved via the real `resolveLocalAnnounceIdentity` (gh-token `GET /user`
   * + OS keychain device keypair) and signed via `signWithDeviceKey`
   * (keychain-held Ed25519 private key).
   *
   * BOTH sub-seams are needed for an offline transport test (e.g.
   * `two-peer-swarm.test.ts`) because:
   *   - `resolveOpts` lets the test inject a fake `resolveGithubUser` (distinct
   *     per peer) and a self-generated Ed25519 keypair (via `loadKeypair` +
   *     `keychainId`), so the resolver never calls the real `gh` token / OS
   *     keychain (which throw / pollute the user's identity in a test runner).
   *   - `sign` REPLACES `signWithDeviceKey`. Even with an injected keypair, the
   *     default signer reads the private key from the OS keychain by
   *     `keychainId` — which the test's generated key isn't stored under. The
   *     signer override lets the test sign the announce with the matching
   *     in-test private key, so `verifyAnnounce` (which checks the sig against
   *     the announced `device_pubkey`) passes over the real wire.
   *
   * No-op for production callers: when undefined, `resolveOpts` defaults to
   * `{}` (merged into the real resolver with only `logCoreKeyHex` set, i.e.
   * current behavior) and `sign` defaults to `signWithDeviceKey(keychainId, …)`.
   */
  announceIdentityOverride?: {
    /**
     * Partial `ResolveLocalAnnounceIdentityOpts` merged into the
     * `resolveLocalAnnounceIdentity({ logCoreKeyHex, ...resolveOpts })` call.
     * `logCoreKeyHex` is always supplied by boot from the own log; any
     * `logCoreKeyHex` here is ignored (overwritten by boot's value).
     */
    resolveOpts?: Partial<ResolveLocalAnnounceIdentityOpts>;
    /**
     * Replacement announce signer. Receives the resolved `keychainId` and the
     * canonical bytes to sign; returns the raw 64-byte Ed25519 signature
     * (`buildAnnounce` base64-encodes it). Defaults to
     * `signWithDeviceKey(keychainId, bytes)`.
     */
    sign?: (keychainId: string, bytes: Buffer) => Promise<Buffer>;
  };
  /**
   * Test seam — override the revoked-pubkeys loader. Production leaves this
   * undefined and the real `loadRevokedPubkeys({ workspaceId, harnessSlug })`
   * (reads `harness_shared.contributors.revoked_pubkeys` from PG) is used.
   * Tests inject a pure async factory returning a Set<string> so startup
   * enforcement + merge-refresh can be exercised without a real database.
   *
   * The loader is called TWICE:
   *   (1) At startup, before the swarm is joined, to seed `revoked` so
   *       already-revoked peers are refused on their very first announce.
   *   (2) After every successful merge pass, to pick up mid-session
   *       replicated revocations (new pubkeys → drop their admitted logs).
   *
   * D-002 decision seam.
   */
  loadRevokedOverride?: () => Promise<Set<string>>;
  /**
   * Test seam (WI-559 + D-002) — override the same-hive membership lookup. Production
   * leaves this undefined and the real `resolveHiveMemberDeviceSet(workspaceId, potHomeSlug)`
   * (reads all member device pubkeys from the federated `hive_members` PG table) is used. Tests
   * inject a pure async loader returning ALL member device pubkeys for the hive — no
   * github_user_id needed (D-002: admit by AUTHOR IDENTITY / device_pubkey ∈ hive_members).
   */
  loadHiveMembersOverride?: (potHomeSlug: string) => Promise<string[]>;
  /**
   * Test seam (WI-787 / WI-780) — resolve the OWNER device pubkey the SIGNED, gh-verified
   * hive-announce binds to a joined `hive_pubkey` (`owner_device_pubkey`, captured at join
   * from the verified directory descriptor and persisted on `harness_shared.pots`).
   * Production leaves this undefined and the real `loadHiveOwnerDevicePubkey(workspaceId,
   * hivePubkey)` (reads `hives.owner_device_pubkey` from PG, fail-closed to null) is used.
   * Used ONLY to BOOTSTRAP-admit the owner's OWN log on a fresh joiner whose `hive_members`
   * is still empty — the WI-780 bootstrap deadlock (the roster that would admit the owner
   * lives inside the owner's un-merged log). Admits ONLY the one bound device; never widens
   * admission to any other device, so the WI-259 membership guard stays intact. `workspaceId`
   * is closed over by boot; the loader receives `(hivePubkey)`.
   */
  ownerDeviceForHiveOverride?: (hivePubkey: string) => Promise<string | null>;
  /**
   * Test seam (D-053) — resolve the OWNER device pubkey to bootstrap-admit when this peer
   * boots on a `kind:'topic'` binding (a real invite/link joiner learns the Hive's TOPIC
   * HASH, not its pubkey, so it cannot key `ownerDeviceForHiveOverride`/`loadHiveOwnerDevicePubkey`
   * by pubkey). Production leaves this undefined and the real path recovers the pubkey from the
   * verified `hive_directory_cache` by deriving each cached hive's topic and matching `topic_hex`.
   * Receives `(topicHex)`; `workspaceId` is closed over by boot. Same one-bound-owner-device
   * guarantee as `ownerDeviceForHiveOverride`.
   */
  ownerDeviceForTopicOverride?: (topicHex: string) => Promise<string | null>;
  /**
   * Test seam (WI-1544 root cause #3) — replace `openRemoteLog` inside the
   * merge-gated admission drain so a unit test can make the open THROW (the
   * one-shot silent-loss class: a drain failure used to lose the announce
   * frame forever — no re-buffer, no re-announce). Production leaves this
   * undefined and uses the real `openRemoteLog`.
   */
  openRemoteLogOverride?: (store: Corestore, logKeyHex: string) => Promise<RemoteLog>;
  /**
   * Test seam (WI-10002600) — the own-log keys this device has retired, which
   * its own-log announce lists as superseded. Production derives them from the
   * `<store>.forked-<key>-<stamp>` directories an own-log fork recovery leaves
   * beside the store (own-log-supersession.ts).
   */
  supersededOwnLogKeysOverride?: () => Promise<string[]>;
  /**
   * Slow re-verify interval (ms). At this cadence, every admitted peer's
   * channel-2 binding is re-checked via `verifyBinding`. A conclusive `'fail'`
   * drops the peer from the admitted set (but does NOT add it to the published
   * `revoked` blocklist — a deleted GitHub branch may be re-published later;
   * normal admission re-admits it if the binding returns). `'pending'` / a thrown
   * error keeps the peer (fail-open per D-004).
   *
   * The GitHub `verifyBinding` I/O runs LOCKLESS — OFF the `merging` lock
   * (P-002). `mergeNow` only KICKS OFF the verify (throttled to at most once per
   * `reverifyIntervalMs`) fire-and-forget and APPLIES the resulting conclusive-
   * fail drops under the gate via a drop queue. This keeps zero network I/O under
   * the merge lock so a large admitted set can't freeze read-merge convergence.
   *
   * Channel-2 reads hit the GitHub API; keep this cadence slow (default
   * 15 min). The per-pass call COUNT is bounded independently of membership by
   * `reverifyBatchSize` (P-021), so this interval sets the API rate on its own:
   * `reverifyBatchSize` calls per `reverifyIntervalMs`.
   *
   * Set to `0` to disable the automatic throttle-in-mergeNow kick-off entirely
   * (tests drive `reverifyAdmitted()` + `mergeNow()` by hand via the handle).
   * Default 15 min.
   */
  reverifyIntervalMs?: number;
  /**
   * Max admitted peers whose channel-2 binding is re-verified in ONE
   * `reverifyAdmitted()` pass (P-021). Peers are swept ROUND-ROBIN across passes
   * from a persistent cursor, so the GitHub API call RATE is O(1) in membership
   * instead of O(N):
   *
   *   calls/hour    = reverifyBatchSize × (3_600_000 / reverifyIntervalMs)
   *   full-sweep    = ceil(N / reverifyBatchSize) × reverifyIntervalMs
   *
   * Why this is not optional at scale: `verifyBinding` passes `skipCache: true`
   * (revocation must not be masked by the 24h success cache), so EVERY peer in a
   * pass is a real API request. Unbounded, a 15-min cadence spends 4N calls/hour
   * and blows GitHub's 5,000/hr limit at ~1,250 admitted members — and because a
   * rate-limited check returns `'pending'`, fail-open (D-004) converts that into
   * "revocation is silently never detected", not a loud failure.
   *
   * The default (256) is the documented per-hive peer ceiling
   * (`harden-shared-hive-to-256-peers`), so at or below the supported scale a
   * pass still sweeps every peer and behaviour is UNCHANGED; past it the rate
   * stays pinned at 1,024 calls/hour (~20% of the GitHub budget) and the
   * full-sweep period stretches instead. Non-finite / non-positive values fall
   * back to the default — there is deliberately no "unbounded" setting, since
   * that is the bug this bounds.
   */
  reverifyBatchSize?: number;
  /**
   * Telemetry sink for conclusive admission rejections (P-004). Defaults to
   * enqueuing a `substrate_admission_rejected` diagnostic report via
   * `recordTelemetryReport` (which `flushTelemetry` forwards to PostHog when the
   * user has opted in). Injected in tests to assert the emit without touching
   * PG/PostHog. MUST be best-effort — telemetry never gates admission, so the
   * default swallows errors and the call site does not await it.
   */
  recordTelemetryOverride?: (kind: TelemetryKind, payload: Record<string, unknown>) => void;
  /**
   * Test seam — a PER-HANDLE HLC clock for the SEND seam (`stampOpHlc`) instead
   * of the process-global `processHlc()`. Production leaves this undefined (one
   * clock per process is correct — every local write is monotone w.r.t. the
   * others). A test harness simulating MULTIPLE peers in ONE process MUST pass a
   * distinct clock per peer: real peers are separate processes with independent
   * clocks, so a shared global clock lets two peers' concurrent drains interleave
   * the same counter and decide cross-peer LWW by drain-race instead of causal
   * order. Pair it with the same clock on the apply seam's `ApplyOpOpts.hlcClock`
   * (the RECV seam) so receive-advances land on the right peer's clock.
   */
  hlcClock?: HlcClock;
  /**
   * SUBSTRATE_SIDECAR Option B test seam (WI-604). Production leaves this
   * undefined: the offload is gated by the real OFF-by-default SUBSTRATE_SIDECAR
   * flag and routes through `offloadReplicationToSidecar` (the real sidecar child
   * + IPC client). A test injects a `(socket, peerInfo) => boolean` to drive the
   * connection handler's offload branch deterministically WITHOUT spawning the
   * sidecar — e.g. to assert the in-process `store.replicate` is bypassed when the
   * offload claims the socket. When defined it is the SOURCE OF TRUTH (the flag
   * read is skipped) so a test never depends on global flag state.
   */
  sidecarOffloadOverride?: (socket: unknown, peerInfo?: unknown) => boolean;
  /**
   * TEST SEAM (WI-1910 hardening): stands in for `getHarnessScopedStore` in the
   * P-006 scoped-log init so a test can make the scoped layer STALL (a promise
   * that never settles) or fail, without touching the real scoped corestore.
   * The scoped init is best-effort and runs OFF the join critical path — this
   * seam exists to prove that property (a stalled scoped dep must never block
   * `swarm.join`).
   */
  scopedStoreOverride?: () => Promise<unknown>;
  /**
   * Bound (ms) on the post-join wait for the P-006 scoped-log init to settle
   * before `joinForBinding` returns (default 10s). Normally the init settles
   * long before the swarm join does; on timeout the join returns with the
   * scoped layer still null and the init keeps wiring in the background
   * (every consumer null-guards). Tests set this small to exercise the
   * timeout path deterministically.
   */
  scopedInitWaitMs?: number;
  /**
   * WI-10003427: how long a merge pass may stay in flight (and an announce may
   * wait queued behind it) before `merge_stalled` / `announce_admission_stalled`
   * boot events are recorded. Default MERGE_PASS_STALL_MS; 0 disables. Tests
   * set it small to exercise the watchdog deterministically.
   */
  mergePassStallMs?: number;
}

/** The slice of a booted harness's resolved announce identity that peers can
 *  observe (device + account) plus the keychain that signs as it. See
 *  `BootedHarnessHandle.announceIdentity`. */
export type BootedAnnounceIdentity = Pick<
  LocalAnnounceIdentity,
  'devicePubkeyBase64' | 'githubUserId' | 'githubLogin' | 'keychainId'
>;

/** What one own-log compaction did (`BootedHarnessHandle.compactOwnLogNow`). */
export type OwnCompactionOutcome =
  | {
      ok: true;
      appended: boolean;
      coversUpTo: number;
      chunkCount: number;
      rowCount: number;
      /** P-530: absent legacy governor receipts left out of the set. */
      droppedGovernorReceipts: number;
      /** P-530: size of the PG census the drop was checked against. */
      liveGovernorReceiptKeys: number;
      /** D-024: candidate `{__rekey}` rows the filter could not open (kept). */
      unopenedGovernorEnvelopes: number;
      /** D-024: epochs the filter held a key for (0 ⇒ every encrypted row is kept). */
      envelopeKeyEpochs: number;
      /** D-025: how long live appends on the own log waited for this set's build + append. */
      appendsHeldMs?: number;
      elapsedMs: number;
    }
  | { ok: false; error: string; elapsedMs: number };

export interface BootedHarnessHandle {
  workspaceId: string;
  harnessSlug: string;
  /** The Corestore — for swarm replication wiring + introspection. */
  store: Corestore;
  /** The peer's OWN writable single-writer log. Local appends go here
   *  (incl. the orchestrator's LWW advisory feature claim — Stage 5). Typed
   *  as the writable `OwnLog` (a superset of `AdmittedLog`) so the claim path
   *  can `append` directly. */
  ownLog: OwnLog;
  /**
   * Append a local put/del op to the peer's OWN log. Convenience over
   * `ownLog.append` for the per-table write helpers (write-contributor-row /
   * write-feature-queue / write-working-set) that previously appended to the
   * Autobase. Maps the op's `writerPubkey` onto the single-writer log's
   * required `author_pubkey`.
   *
   * STAGE-5 TODO: the orchestrator claim path (feature-claim.ts) and a real
   * device `author_pubkey` thread through here when the claim/write rewrite
   * lands; today `author_pubkey` falls back to `writerPubkey ?? ''`.
   */
  append(op: LocalWriteOp): Promise<void>;
  /**
   * The admitted-set: keyHex → log. Seeded with the own log; the swarm
   * announce channel adds remote logs that pass read-admission (4b).
   */
  admitted: Map<string, AdmittedLog>;
  /** Run a single read-merge pass over the admitted set into PG. Resolves
   *  with the number of ops applied. Idempotent + safe to call concurrently
   *  (it serializes internally). */
  mergeNow(): Promise<number>;
  /**
   * P-019 (D-012) — append ONE fresh head `__snapshot__` to the own log, NOW, and
   * resolve with what landed. Serviced inside the serialized merge block, so it can
   * never race a merge pass.
   *
   * The caller is a RELEASE CUT on a box where this process holds the corestore: the
   * cutter opens the store read-only (WI-4487, no outage) and therefore cannot append
   * the head snapshot a `--sparse` cut requires. Without a snapshot inside
   * `SNAPSHOT_SCAN_LOOKBACK` of the tail, `computeSparseFrom` returns 0 and the
   * "sparse" seed silently ships the FULL core — how a 1.9 GB seed labelled sparse
   * shipped on 2026-07-21 and went unnoticed for three weeks.
   *
   * NOT gated on the `SUBSTRATE_LOG_SNAPSHOT` producer flag — see the call site.
   *
   * ⚠ EXPENSIVE and SYNCHRONOUS with respect to merging: it reads the whole own log,
   * so the merge loop stalls for its duration. One-shot and request-driven on purpose.
   * Concurrent callers COALESCE onto one snapshot. Rejects if the engine is stopped;
   * a failed merge pass does NOT reject — the request is serviced by the next pass, so
   * the DEADLINE belongs to the caller.
   */
  produceHeadSnapshotNow(): Promise<ProduceSnapshotResult>;
  /**
   * p2p-join-catchup-speed D-023 — run ONE own-log compaction now, whether or not the
   * proportional cadence says it is due, and resolve with its outcome. It is the
   * periodic compaction (worker-thread fold, P-530 receipt census, off the merge gate),
   * started on request, so a fold-time policy change reaches the next joiner without
   * waiting for the log to grow by a whole live-state again.
   *
   * Waits for an in-flight compaction, then runs its own; concurrent callers COALESCE.
   * Rejects when the engine is stopped, the producer flag is off, or the cadence anchor
   * is still unknown (WI-10002836). A compaction that fails resolves `ok: false`.
   */
  compactOwnLogNow(): Promise<OwnCompactionOutcome>;
  /**
   * Handle an inbound signed announce from a peer (called by the swarm
   * connection handler in 4b). Verifies the sig, runs the admission
   * decision, and on admit opens + admits the peer's remote log and
   * triggers a merge. When the swarm supplies the per-connection `ctx`
   * (P-006 §5.2/§5.3), an ADMITTED frame additionally drives the scoped-log
   * flow: serve gate → disclosed-core admission → directed follow-up.
   */
  onAnnounce(frame: SignedAnnounce, ctx?: AnnounceConnectionContext): Promise<AdmissionResult>;
  /**
   * Subscribe to peer admissions (audit P-022): fires once per newly-admitted
   * remote log with the log key + the post-admission admitted-set size.
   * Replaces 100ms `admitted.size` polling in the perf rigs. Returns an
   * unsubscribe fn. Best-effort: a throwing listener is swallowed and never
   * breaks admission or the merge pass.
   */
  onAdmitted(listener: (info: { logKeyHex: string; admittedSize: number }) => void): () => void;
  /**
   * Revoke a device pubkey (D-004). Revocation = drop the pubkey from the
   * admitted set + stop reading every log it announced:
   *   (a) add the pubkey to the `revoked` set so a re-announce is refused
   *       (`reason:'revoked'`);
   *   (b) look up all of the pubkey's `log_core_key` values and remove those
   *       logs from the admitted set (so the next merge no longer reads them);
   *   (c) re-merge so the merge set reflects the removal immediately.
   * Best-effort + idempotent: revoking an unknown / already-revoked pubkey is a
   * no-op (the pubkey is still added to `revoked` so a future announce is
   * refused). Takes the RAW base64 device pubkey (the announce's
   * `device_pubkey`), NOT the hypercore `log_core_key`.
   */
  revoke(devicePubkey: string): Promise<void>;
  /**
   * LOCKLESS channel-2 re-verify producer (rev-v2 Component A; P-002). Exposed
   * for testing so `reverifyIntervalMs: 0` tests can drive it by hand.
   *
   * For each admitted peer EXCEPT the own log, calls `verifyBinding` with the
   * peer's recorded `{devicePubkey, githubLogin, githubUserId, attestationGistId}`:
   *   - `'fail'` (conclusive) → ENQUEUES the peer's logKey for a drop. The drop
   *     (delete from `admitted` + `admittedIdentities` + `pubkeyToLogKeys`, plus a
   *     `peer_revoked` boot-history event) is APPLIED on a SUBSEQUENT merge pass
   *     under the gate — NOT synchronously here. Does NOT add to the published
   *     `revoked` set (a GitHub-deleted binding may be re-published; normal
   *     admission re-admits if it returns).
   *   - `'pending'` / thrown error → keeps the peer (fail-open per D-004).
   *
   * Does ZERO mutation of the shared `admitted` maps, so it is SAFE to call
   * WITHOUT holding the `merging` flag (that is the whole point of P-002 — the
   * GitHub I/O is off the merge lock). To observe a drop in a test, call this,
   * then `mergeNow()` to drain the queue under the gate.
   */
  reverifyAdmitted(): Promise<void>;
  /** Swarm handle. Null when this boot didn't join a swarm
   *  (private harness OR swarmBinding omitted). A live getter — `rekey()`
   *  reassigns it, so always read the current value. */
  readonly swarm: SwarmHandle | null;
  /** The device identity this harness's swarm announce and pot-git hello carry —
   *  the device peers file our socket under, and therefore the ONLY device a
   *  ref-announce / staging-advance from this harness may be signed as (a peer
   *  dials `announcement.device_pubkey`). Null until the first join resolves
   *  it, or when this boot never joined a swarm. Live getter, reassigned by
   *  `rekey()`. P-203 Leg A. */
  readonly announceIdentity: BootedAnnounceIdentity | null;
  /** Fresh authority from the process actually serving Git. Optional only for
   * older handles; callers must treat omission as unknown, never fall back. */
  getGitServingCapability?(request: GitServingRequest): Promise<GitServingState>;
  /** Re-key onto a NEW swarm topic IN PLACE: leave the old topic, join the topic
   *  derived from `binding`, keeping the store + own log + admitted set + merge
   *  loop alive. The "go shared" primitive — used when a harness joins/publishes
   *  a hive after boot and must switch from its gh:<repo_id> topic to the
   *  hive-pubkey topic WITHOUT a reboot (EI-681: a reboot breaks the owner's
   *  corestore replication-serving of its own log). No-op once closed. */
  rekey(binding: SwarmBinding): Promise<void>;
  /**
   * P-006 §5.1 — declare fleet scopes this peer PARTICIPATES in: mints an own
   * writable scoped log core per scope (idempotent) in the harness's SEPARATE
   * never-replicated scoped store; the scopes are disclosed/served per
   * §5.2/§5.3 on the next announce exchange (or `rediscloseScopes()` for the
   * immediate edge). Boot-scoped: `rekey()` re-applies the set to the fresh
   * coordinator. P-101 (fleet directory) is the production driver; a tier-1
   * boot leaves the set empty (FS-D5 structural inertness — the machinery is
   * live, nothing is disclosed or served).
   */
  ensureScopeParticipation(scopes: readonly ScopeId[]): Promise<void>;
  /**
   * D-017 n1 — the IMMEDIATE roster/epoch-mutation edge: re-run scoped-log
   * disclosure on EVERY live connection NOW. A scope newly hidden from a peer
   * is detached at once (§5.3 revocation edge); newly visible scopes are
   * served + disclosed. Without this, changes still converge within one
   * ANNOUNCE_REFLUSH (≤5 min) — this makes revocation take effect now. No-op
   * before the first swarm join.
   */
  rediscloseScopes(): Promise<void>;
  /** The scoped-log coordinator — null before the first swarm join or when the
   *  scoped layer failed to initialize (diagnostics + tests). */
  readonly scopeFederation: ScopeFederation | null;
  /**
   * Register a teardown hook run (once) on `close()`, BEFORE the swarm + store
   * tear down. The Stage-5 outbox wiring (boot-all.ts `wireOutboxForHarness`)
   * registers the `startOutboxDrain` stopper here so the LISTEN connection +
   * poll timer are released exactly once on shutdown without boot-all having to
   * track a parallel Map. Returns an unregister function (clears the hook if the
   * wiring is torn down independently of `close()`). Hooks are best-effort: a
   * throwing hook is caught + logged, never blocking the rest of teardown.
   */
  registerCloseHook(hook: () => void | Promise<void>): () => void;
  /** Cleanup. Idempotent. Runs close-hooks, then tears down swarm + merge
   *  poller + Corestore. (A re-key does NOT close — use `rekey()`, which leaves
   *  the old topic + joins the new one with the store/cores/streams alive.) */
  close(): Promise<void>;
}

/**
 * WI-559 + D-002 P-001: the PURE same-hive cross-member SCOPE decision, extracted so it is
 * unit-testable in isolation. A frame that has ALREADY passed the identity decider (sig +
 * channel-2 binding valid, NOT revoked — checked upstream, every call) and is out of this
 * harness's OWN slug scope is classified:
 *   - 'admit'         → device_pubkey is registered in the hive_members set (D-002 AUTHOR IDENTITY).
 *   - 'miss'          → a same-hive candidate (cross-slug + hive home known) whose membership
 *                       has NOT federated to us yet → caller BUFFERS it for retry
 *                       (the asymmetric A→B stall fix) instead of conclusively rejecting.
 *   - 'not-candidate' → not a same-hive cross-member (own/empty slug, or no hive home)
 *                       → caller falls through to the A-003 / conclusive paths.
 * It NEVER decides revocation or the read-cut (that is the identity decider, run BEFORE it).
 * github_user_id is intentionally NOT used — admission is by device_pubkey ∈ hive_members.
 */
export type SameHiveDecision = 'admit' | 'miss' | 'not-candidate';
export function classifySameHiveMember(input: {
  originSlug: string | null;
  ownSlug: string;
  hiveHome: string | null;
  devicePubkey: string;
  memberDevices: readonly string[];
  /**
   * D-023 BUG C — true when THIS box OWNS the hive (holds its private key = the membership
   * AUTHORITY). On a membership MISS a NON-owner correctly BUFFERS (WI-559: the member's row
   * will federate IN from the owner momentarily). But the OWNER is the SOURCE of membership —
   * a brand-new joiner's hive_members row is created by the owner's OWN admit seam
   * (admitAnnouncedPeerAsOwner → ownerAdmitOrPend → upsertHiveMember), which runs ONLY AFTER
   * the joiner's LOG is admitted. So an owner that buffers a verified joiner DEADLOCKS: the
   * row that would admit it is the row the admit would create. A joiner's member-harness slug
   * differs from the owner's home slug (join-hive freeSlug suffixing — joinHiveAsView), so the
   * joiner's announce is ALWAYS out of the owner's home-slug scope and reaches here as a MISS.
   * ADMIT it instead, so the admit seam runs the owner-signed policy (open ⇒ upsert; approval ⇒
   * pending; banned/revoked already refused upstream by the identity decider's `revoked` set).
   * This only widens SCOPE — sig + channel-2 binding + revocation are enforced upstream — so it
   * never weakens security; it closes the open-mode auto-admission gap (the boot.ts admit seam
   * WI-280 wired was unreachable for a brand-new cross-slug joiner without this).
   */
  isOwner?: boolean;
}): SameHiveDecision {
  const { originSlug, ownSlug, hiveHome, devicePubkey, memberDevices, isOwner } = input;
  // Not a cross-member candidate: absent/own-slug (handled upstream) or no hive home.
  if (!(originSlug != null && originSlug !== ownSlug)) return 'not-candidate';
  if (hiveHome == null) return 'not-candidate';
  // D-002: admit by AUTHOR IDENTITY — device already in the federated member set → admit.
  if (memberDevices.includes(devicePubkey)) return 'admit';
  // D-023 BUG C: the OWNER must not buffer a verified brand-new joiner (deadlock) — admit so its
  // own admit seam runs the policy + upserts the row. A non-owner → miss (buffer for retry).
  return isOwner ? 'admit' : 'miss';
}

/**
 * EI-18665254552552477: the PURE decision behind `joinHarnessSwarm`'s
 * `hasStalledLogs` self-heal signal — extracted so it is unit-testable in
 * isolation (the call site closes over `admitted`/`ownLog`/a forward-declared
 * `swarmHandle`, none of which are convenient to construct standalone).
 *
 * WI-1534's original mitigation only ever asked "does an ADMITTED remote log
 * show zero replicator peers" — a question that is silently undefined (falls
 * through to `false`, i.e. "not stalled") while `admitted` holds no remote
 * log at all. That pre-admission window is exactly backwards: zero admitted
 * remotes is the WORST stall this predicate can observe, not the healthiest,
 * yet it read as healthy and left the self-heal loop on the slow 60s
 * keepalive throughout it (root-caused live via EI-18662944242304583, gate
 * run 20260725-183831: 20.5min / 188 established connections / zero inbound
 * frames / zero admissions, entirely on the slow cadence).
 *
 * So: report stalled for either (a) an admitted remote log with zero
 * replicator peers (the original WI-1534 axis, unchanged), or (b) zero
 * admitted remotes AT ALL while `topicConnectionCount` is nonzero — i.e. we
 * have live swarm sockets on this topic and nothing has been admitted yet.
 * The live-connection leg is required (not "admitted is empty" alone) so a
 * genuinely solo/offline node still gets the slow cadence — the same
 * false-positive discipline rung (c)'s never-paired escalation already
 * applies (WI-5686: an axis with no live-peer guard fires for a peer that
 * simply isn't there).
 *
 * WI-10005287: `topicConnectionCount` MUST be topic-scoped
 * (`SwarmHandle.topicStallCandidateCount`). The swarm-wide
 * `liveConnectionCount` this used to receive counts the one shared socket per
 * peer for every local topic, so a peer serving only OTHER harnesses held leg
 * (b) true forever on every topic it does not share (measured on bg-host
 * 2026-10-02: 48 of 89 joins).
 */
export function computeHasStalledLogs(
  // `unknown` values (not `Partial<{ peersCount... }>>` directly) so a caller
  // can pass its real `Map<string, AdmittedLog>` without a variance fight —
  // same per-item cast convention this file already uses at every other
  // `peersCount()` read site (e.g. the `maybePeersCount` casts above).
  admitted: ReadonlyMap<string, unknown>,
  ownLogKeyHex: string,
  topicConnectionCount: number,
): boolean {
  let sawRemoteAdmitted = false;
  for (const [keyHex, rawLog] of admitted) {
    if (keyHex === ownLogKeyHex) continue;
    sawRemoteAdmitted = true;
    const log = rawLog as Partial<{ peersCount(): number | undefined }>;
    if (typeof log.peersCount !== 'function') continue;
    try {
      if (log.peersCount() === 0) return true;
    } catch {
      // treat a throwing probe as "not stalled" for this log
    }
  }
  if (sawRemoteAdmitted) return false;
  return topicConnectionCount > 0;
}

export async function bootHarnessSubstrate(opts: BootHarnessOpts): Promise<BootedHarnessHandle> {
  if (!opts.workspaceRoot) throw new Error('bootHarnessSubstrate: workspaceRoot required');
  if (!opts.workspaceId) throw new Error('bootHarnessSubstrate: workspaceId required');
  if (!opts.harnessSlug) throw new Error('bootHarnessSubstrate: harnessSlug required');

  recordBootEvent(opts.workspaceId, opts.harnessSlug, 'boot_start');
  try {
    return await bootHarnessSubstrateInner(opts);
  } catch (e) {
    recordBootEvent(opts.workspaceId, opts.harnessSlug, 'boot_fail', e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/**
 * Wrap an admitted log so the merge driver drops unknown-newer ops (the
 * D-024 schema-version gate that used to live in the Autobase apply). The
 * gate runs in the merge driver, NOT inside `mergeAdmittedLogs`, so the
 * merge stays a pure read→LWW→apply. `acceptOpVersion` emits the
 * "newer Papercusp available" alert once per (slug, version).
 */
function versionGatedLog(slug: string, log: AdmittedLog): CancellableReadLog {
  const maybePrefetch = (log as AdmittedLog & { prefetch?(start: number, end: number): PrefetchRange | undefined })
    .prefetch;
  const maybeCancellable = (log as CancellableReadLog).getCancellable;
  // Drop unknown-newer ops (D-024). acceptOpVersion alerts once.
  const gate = (op: PeerLogOp | null): PeerLogOp | null =>
    op && acceptOpVersion(slug, op.schema_version) ? op : null;
  return {
    get keyHex() {
      return log.keyHex;
    },
    get length() {
      return log.length;
    },
    async get(i: number): Promise<PeerLogOp | null> {
      return gate(await log.get(i));
    },
    // Forward the ranged-prefetch capability (EI-92) — the incremental merge
    // feature-detects it on the wrapped log.
    ...(typeof maybePrefetch === 'function'
      ? { prefetch: (start: number, end: number) => maybePrefetch.call(log, start, end) }
      : {}),
    // P-533: forward cancellable reads, gated like `get`.
    ...(typeof maybeCancellable === 'function'
      ? {
          getCancellable: (i: number) => {
            const read = maybeCancellable.call(log, i);
            return { op: read.op.then(gate), cancel: () => read.cancel() };
          },
        }
      : {}),
  };
}

async function bootHarnessSubstrateInner(opts: BootHarnessOpts): Promise<BootedHarnessHandle> {
  const storeOpts: HarnessStoreOpts = {
    workspaceRoot: opts.workspaceRoot,
    harnessSlug: opts.harnessSlug,
  };
  const store = await getHarnessStore(storeOpts);

  const slug = opts.harnessSlug;

  // ── Model B: the peer's OWN writable single-writer log. ──
  // Replaces the retired Autobase. Local writes append here (incl. the
  // orchestrator's LWW advisory feature claim); the merge driver reads it
  // (+ admitted remote logs) into PG.
  const ownLog = await openOwnLog(store, {
    workspaceId: opts.workspaceId,
    harnessSlug: slug,
  });

  // ── A-003 (shared-pot-release-testing Brief I): joiner hive-home projection
  // scope. ── When THIS harness is a member of a JOINED (remote_hive) Hive, its
  // `hive_members`/`hive_settings` projections must bind to the HIVE-HOME slug, not
  // the member slug — else the home-grained ops this member's merge reads off the
  // shared Hive topic are dropped (the member list/settings never reach the joiner,
  // and `loadRevokedHivePubkeys(<home>)` stays empty so a revoked member is never
  // refused). `joinerPotHomeSlug` returns the home slug ONLY for a true joiner
  // (the home is a remote_hive view) — null for an OWNED hive's member (whose home
  // harness owns the write side) or a non-hive harness. Gated on a `hive` swarm
  // binding so non-hive boots (every rig + most tests) skip the registry/identity
  // read entirely; fail-open — any error leaves today's member-slug binding.
  //
  // Resolved at boot AND re-resolved on `rekey`: a FIRST join boots the member on
  // the gh topic (no hive_slug yet → null) then re-keys onto the Hive topic AFTER
  // join stamps hive_slug + the remote_hive home (join-hive.ts steps 2/2b before
  // the 2c re-key), so the re-key is where the rebind actually engages. A later
  // restart boots straight onto the Hive topic with hive_slug set, engaging it here.
  const resolveHiveHomeProjectionSlug = async (
    binding: SwarmBinding | null | undefined,
  ): Promise<string | undefined> => {
    // WI-498 GAP 2: resolve the joiner hive-home projection for BOTH 'hive' and
    // 'topic' bindings — a DIRECT invite/link join boots on a 'topic' binding (the
    // link carries the topic hash, not the hive pubkey), and without this its member
    // never resolves a hive-home slug, so the OWNER's hive-home announce is out-of-
    // scope → buffered → grace-expired → rejected → no federation, even though the
    // peer is connected on the right topic (live-witnessed on the 2-machine rig). See
    // bindingResolvesHiveHomeProjection for the full rationale. Slug resolution stays
    // SELF-GATED by joinerPotHomeSlug (remote_hive view only → else null → fail-open),
    // so a non-hive 'topic' harness is unaffected, and the joiner rebind no longer
    // depends on prior DHT directory discovery.
    if (!bindingResolvesHiveHomeProjection(binding)) return undefined;
    try {
      // A-003 test seam: a test may inject `joinerPotHomeSlugOverride` to control
      // home resolution (null at boot, then the hive-home slug on rekey) without the
      // registry. Production leaves it undefined → the real registry-backed resolver.
      let resolved: string | undefined;
      if (opts.joinerPotHomeSlugOverride) {
        resolved = (await opts.joinerPotHomeSlugOverride(opts.workspaceId, opts.harnessSlug)) ?? undefined;
      } else {
        const { joinerPotHomeSlug } = await loadHiveFederationModule();
        // WI-1378 (federation roster-empty, no-restart path): read the registry FRESH
        // (bypass the 2s operator-state cache). This resolve runs on the in-place rekey
        // inside the substrate SIDECAR process (SUBSTRATE_SIDECAR) — a DIFFERENT process
        // from the join-hive registry write, so the writer's same-process cache
        // invalidation never reached here. A warm-stale cache made joinerPotHomeSlug
        // return null at rekey → next===prev(null) → the rebind block below skipped →
        // forceReFold never fired → the member-slug projection binding latched → the
        // owner's hive_members rows dropped forever (roster empty until a restart
        // cold-read). A fresh read sees the committed remote_hive/hive_slug (join-hive
        // awaits the mutateRegistry commit before the rekey RPC), so the rebind +
        // forceReFold re-fold engage on the no-restart path. Rare path — the hot
        // loadHarnessRegistry callers keep the cache; only this resolve reads fresh.
        resolved = (await joinerPotHomeSlug(opts.workspaceId, opts.harnessSlug, { fresh: true })) ?? undefined;
      }
      if (process.env.PAPERCUSP_A003_TRACE === '1') {
        console.error(
          `[A-003] ${new Date().toISOString()} resolve ${opts.harnessSlug}: joinerPotHomeSlug=${resolved ?? '<null>'}`,
        );
      }
      // WI-559 / EI-18775450536624845 — the FK-parent reconcile, deliberately sited
      // HERE. `resolved` is the FEDERATED scope the hive-home projections are about
      // to persist under; the joiner's LOCAL handle is what its `pots` row is keyed
      // by. When those two differ, `pot_members` has no FK parent under the
      // federated scope, so every inbound roster op fails `pot_members_pot_fkey`,
      // the merge pass aborts, and the WI-255 quarantine escalates it to permanent
      // row loss. Stamping `canonical_pot_home_slug` (migration 686) gives those
      // rows a parent WITHOUT renaming the local handle.
      //
      // This is the one point that runs on BOTH the cold boot AND the in-place
      // rekey — the two moments the binding is established — so a first join and a
      // restart are both covered, and it fires only when a rebind actually engaged.
      // Fully best-effort: reconcile never throws, and its result is not consulted,
      // because failing to IMPROVE the binding must never break a working Pot.
      if (resolved) {
        try {
          const { potHomeSlugForHarness } = await loadHiveFederationModule();
          const localHome = await potHomeSlugForHarness(opts.workspaceId, opts.harnessSlug, {
            fresh: true,
          });
          if (localHome && localHome !== resolved) {
            const { reconcilePotCanonicalSlug } = await loadPotCanonicalSlugReconcileModule();
            await reconcilePotCanonicalSlug(opts.workspaceId, localHome);
          }
        } catch {
          /* best-effort: a working binding must never fail over the FK repair */
        }
      }
      return resolved;
    } catch (e) {
      if (process.env.PAPERCUSP_A003_TRACE === '1') {
        console.error(
          `[A-003] ${new Date().toISOString()} resolve ${opts.harnessSlug}: joinerPotHomeSlug THREW: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return undefined; // fail-open: fall back to member-slug binding (today's behavior)
    }
  };
  // ── Per-admitted-peer identity store (rev-v2 Component A) ── populated at
  // admit time from the SignedAnnounce frame so `reverifyAdmitted()` can
  // re-call `verifyBinding(devicePubkey, githubLogin, githubUserId, gistId)`
  // without the original frame. Keyed by `log_core_key` (same key as `admitted`).
  // Cleaned up in every drop path: `revoke()`, `applyRevocationRefresh()`, and
  // the attestation re-verify drop inside `reverifyAdmitted()`. Declared HERE (above
  // `buildScopedApply`) so the WI-259 P-002 `resolveAuthorDevice` seam threads into the
  // content projections that `buildScopedApply` builds below; `resolveAuthorId` (the
  // rate limiter's, far below) reads this same map.
  type AdmittedIdentity = {
    devicePubkey: string;
    githubLogin: string;
    githubUserId: number;
    attestationGistId: string;
    /** Bootstrap/known-member admissions deliberately bypass channel-2 I/O. */
    channel2Verified: boolean;
  };
  type QueuedAdmission = {
    frame: SignedAnnounce;
    channel2Verified: boolean;
  };
  const admittedIdentities = new Map<string, AdmittedIdentity>();

  // WI-259 P-002 (membership-aware cross-member content apply): map an op's source-log
  // core key → the admission-VERIFIED device pubkey that vouched for that log (its
  // announce sig was checked against it AND it was a hive member — STEP 1 / P-001). The
  // 6 content projections' guard (`shouldApplyMemberContentOp`) re-checks this device ∈
  // the CURRENT member set (`resolveHiveMemberDeviceSet`) so a removed member's writes
  // stop applying. Keyed off `op.sourceLogKeyHex` (immutable, receiver-stamped) NOT
  // `op.author_pubkey` — the latter is caller-supplied (peer-log.ts:19), so a removed
  // member could spoof a still-member's pubkey to evade the write-cut. `null` when the
  // source log isn't admitted (own log / legacy op without a source key).
  const resolveAuthorDeviceNullLogged = new Set<string>();
  const resolveAuthorDevice = (sourceLogKeyHex: string): string | null => {
    const dev = admittedIdentities.get(sourceLogKeyHex)?.devicePubkey ?? null;
    // WI-2105 REV diag: a folded PEER op whose source log has NO resolvable device
    // identity makes the WI-259 member-content-guard DROP it permanently ('no-srcDevice')
    // — the tower↔VM REV-leg regression (17c98: resolveAuthorDevice(60da99e0) unresolved
    // at apply). Surface the exact unresolved log ONCE per key (deduped, best-effort) so
    // getBootHistory names it after the next restart — no force-bounce needed. Skips the
    // own log (its ops take the own-slug apply fast path; a null there is expected).
    if (
      dev === null &&
      sourceLogKeyHex &&
      sourceLogKeyHex !== ownLog.keyHex &&
      !resolveAuthorDeviceNullLogged.has(sourceLogKeyHex)
    ) {
      resolveAuthorDeviceNullLogged.add(sourceLogKeyHex);
      try {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'merge_error',
          `identity-gap: src-log ${sourceLogKeyHex.slice(0, 8)} unresolved (admittedIds=${admittedIdentities.size}, admitted?=${admitted.has(sourceLogKeyHex)}) → member-content DROP`,
        );
      } catch {
        /* diagnostic must never break resolution */
      }
    }
    return dev;
  };

  // ── WI-259 P-004 content-before-membership buffer (plan shared-hive-member-content-federation-
  // 2026-06-20) ── ONE per booted apply loop (stateful across merge passes, like rekeyDeps.pending).
  // The 6 content projections DEFER into it when the P-002 membership guard would drop a cross-member
  // op only because the author's hive_members row hasn't federated to this peer yet; the hive_members
  // projection DRAINS + re-applies on a member apply (the onMemberApplied hook). Inert (stays empty)
  // for a non-hive harness — the guard returns 'drop' (never 'defer') without a potHomeSlug. Threaded
  // into BOTH scopedApply (the real merge path) AND the global registry below.
  const pendingMemberContent = new PendingMembershipContent();

  // WI-559 / FED-1 (fed-b→fed-a "discovers 0"): the OWNER's hive-home harness must resolve the
  // WI-259 content-guard potHomeSlug too. `resolveHiveHomeProjectionSlug` (above) resolves only the
  // JOINER rebind via `joinerPotHomeSlug` (remote_hive view → null for an owner), so an owner's home
  // harness ran the 6 content projections with potHomeSlug=undefined → `decideMemberContentOp` hit
  // its no-hiveHome 'drop' branch for EVERY cross-member op → a member's content never materialized on
  // the owner. This closes the admit/apply ASYMMETRY: STEP-1 admission (`resolveSameHiveMember`)
  // already resolves the home as `hiveHomeProjectionSlug ?? potHomeSlugForHarness(ws, slug)`, but
  // STEP-2 apply only used `hiveHomeProjectionSlug`. We resolve the OWNER's own hive-home here and
  // thread it as the content-guard FALLBACK below (scoped to home === own slug, so a joiner keeps its
  // rebound `hiveHomeProjectionSlug` and the `??` is a no-op; a non-hive/non-owner harness → undefined).
  // GATED on `bindingResolvesHiveHomeProjection` — the SAME gate the joiner resolution above uses — so
  // a harness NOT on a hive/topic topic (the common boot path, e.g. a private 'local'/'gh' harness)
  // pays ZERO extra getOrgPg cost and is byte-identical to today; only a harness actually peered on a
  // hive topic (where it can receive cross-member content) does the one-shot owner-home lookup.
  // WI-2105 REV (no-hiveHome fix): resolve the hive-home ONCE for BOTH the projection-rebind
  // fallback (ownPotHomeSlug) AND the broader content-guard home (contentGuardHiveHome).
  const resolvedPotHomeSlug = await (async (): Promise<string | undefined> => {
    if (!bindingResolvesHiveHomeProjection(opts.swarmBinding)) return undefined;
    try {
      const resolve = opts.potHomeSlugForHarnessOverride ?? (await loadHiveFederationModule()).potHomeSlugForHarness;
      return (await resolve(opts.workspaceId, opts.harnessSlug)) ?? undefined;
    } catch {
      return undefined; // fail-open: today's behavior (no cross-member apply on the owner)
    }
  })();
  // WI-559/FED-1 projection-REBIND fallback: only the owner booting the HOME harness itself
  // (home === own slug) may rebind the hive-home projections (hiveScoped) — a member harness
  // must NOT (it would double-apply the owner's own rows as origin='remote'). IDENTICAL value
  // to the prior IIFE, so every existing ownPotHomeSlug ref is preserved.
  const ownPotHomeSlug = resolvedPotHomeSlug === opts.harnessSlug ? resolvedPotHomeSlug : undefined;
  // WI-2105 REV content-GUARD home: the member-content guard's member-set lookup needs the
  // hive-home for ANY hive-peered harness — INCLUDING an owned hive's member harness
  // (home ≠ own slug, hive owned-not-remote, e.g. hive-canary→papercusp) where ownPotHomeSlug
  // is undefined. Threaded as `memberContentHiveHome` (guard-only; does NOT drive the rebind).
  const contentGuardHiveHome = resolvedPotHomeSlug;
  // WI-3734 (owned-hive owner-side fold): the hive-home projection REBIND now also engages
  // for an OWNED hive's member harness (home ≠ own slug, hive owned-not-remote — the case
  // ownPotHomeSlug deliberately excludes). Without it this member fold demux-dropped every
  // home-grained op a PEER member drained (B→A pot_settings/pot_members silently lost, no
  // counter — the live-fed-gate content-matrix RED), because the pot-home scope that WOULD
  // apply them may never see the peer log (WI-183 zombie replicator) while THIS scope reads
  // it and throws the rows away. The WI-2105/WI-559 double-apply fear is closed by the
  // HOME-LOG EXCLUSION threaded below (`resolveHomeLogKeyHex`): ops sourced from the
  // locally-booted home's own log are skipped at this member scope — the home fold owns them.
  //
  // GATED to the OWNED case only (WI-5369 regression fix, found 2026-07-18): `resolvedPotHomeSlug`
  // is `potHomeSlugForHarness` — UNGATED on remote_hive, unlike `joinerPotHomeSlug`/
  // `hiveHomeProjectionSlug` above. Without this remote_hive check, this fallback ALSO fired for
  // a JOINED member during its legitimate home=<none> pre-rekey window (the registry already has
  // `hive_slug` set at that point; only `joinerPotHomeSlug`'s remote_hive check is what makes
  // `hiveHomeProjectionSlug` correctly stay null until the 2c rekey) — collapsing that window and
  // rebinding the hive-home projections BEFORE the rekey's forceReFold sequencing ever runs. Live
  // symptom: none yet (this bug was same-day, never shipped in a gate .deb); caught by
  // owner-roster-rebind-race.repro.integration.test.ts's own precondition assertion going red the
  // same day WI-3734 landed. A joined member's home is already correctly (and safely) resolved on
  // its own schedule via `hiveHomeProjectionSlug` — this fallback must stay OUT of that path and
  // only cover the genuinely-owned case.
  const memberHomeRebindSlug =
    resolvedPotHomeSlug && resolvedPotHomeSlug !== opts.harnessSlug
      ? await (async () => {
          try {
            const { loadHarnessRegistry } = await loadHarnessRegistryModule();
            const reg = await loadHarnessRegistry(opts.workspaceId);
            const homeEntry = reg.projects.find((p) => p.slug === resolvedPotHomeSlug);
            // A joined (remote_hive) home is owned by hiveHomeProjectionSlug's own
            // rekey-gated sequencing — never rebind it here.
            if (homeEntry?.remote_hive === true) return undefined;
          } catch {
            /* fail-open: skip the owned-fallback rebind on a registry-read error */
            return undefined;
          }
          return resolvedPotHomeSlug;
        })()
      : undefined;
  const resolveHomeLogKeyHex: (() => string | null) | undefined = memberHomeRebindSlug
    ? await (async () => {
        // Runtime import of ./boot-all (it imports this module — a static import would
        // cycle). The returned closure runs per-op at APPLY time, long after boot: the
        // home may boot after this member and still be excluded from then on; for a
        // JOINED hive the home slug is never locally booted → null → no exclusion.
        const { getBootedHarness } = await loadBootAllModule();
        return () => getBootedHarness(opts.workspaceId, memberHomeRebindSlug)?.ownLog.keyHex ?? null;
      })()
    : undefined;

  // WI-3985 — one flag read per serialized merge pass. The memory projection
  // used to resolve the live flag independently for every op, while the shared
  // merge cursor was persisted outside that decision. An OFF-gated memory op
  // therefore advanced the cursor and became indistinguishable from an applied
  // op. Keep the projection and apply-binding on one boot-owned snapshot.
  //
  // WI-10005919 — a read can DEGRADE (override store unreachable with nothing cached,
  // or a throw), and a degraded value is not the owner's setting. It is never allowed
  // to pass silently as OFF: every degraded read is logged with a running count, a
  // mid-run degraded read holds the last authoritative value, and a degraded boot
  // value that no pass consumed is not treated as an OFF state (see mergeOnePass).
  const readMemoryFederationFlag = () => readMemoryFederationFlagOnce(opts.memoryFederationFlagOn);
  let memoryFederationDegradedReads = 0;
  const warnMemoryFederationReadDegraded = (
    read: MemoryFederationFlagRead,
    when: 'boot' | 'pass',
    outcome: string,
  ): void => {
    memoryFederationDegradedReads += 1;
    console.warn(
      formatMemoryFederationDegradedWarn({
        workspaceId: opts.workspaceId,
        harnessSlug: opts.harnessSlug,
        when,
        read,
        degradedReadsThisBoot: memoryFederationDegradedReads,
        outcome,
      }),
    );
  };
  const bootMemoryFederationRead = await readMemoryFederationFlag();
  let memoryFederationEnabledForPass = bootMemoryFederationRead.value;
  // Whether memoryFederationEnabledForPass came from an authoritative read.
  let memoryFederationFlagAuthoritative = bootMemoryFederationRead.degraded === null;
  // Whether any merge pass has applied under a snapshot yet.
  let memoryFederationSnapshotConsumed = false;
  if (bootMemoryFederationRead.degraded !== null) {
    warnMemoryFederationReadDegraded(
      bootMemoryFederationRead,
      'boot',
      `provisional ${bootMemoryFederationRead.value ? 'ON' : 'OFF'} until the first pass re-reads`,
    );
  }
  const memoryFederationFlagSnapshot = async (): Promise<boolean> => memoryFederationEnabledForPass;

  // WI-2142064: one instance for this harness's whole boot lifetime (survives a
  // rekey rebuild of `scopedApply` below — `buildHarnessProjectionApply` builds a
  // FRESH set of projection instances each call, but the batch is threaded in by
  // reference each time, so its dirty set carries across rebuilds). Drained once
  // per merge pass in `mergeOnePass`'s `finally` — see there.
  const planPartsRecomposeBatch = createPlanPartsRecomposeBatch();

  const buildScopedApply = (potHomeSlug: string | undefined) =>
    buildHarnessProjectionApply({
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      ownLogKeyHex: ownLog.keyHex,
      recomposeBatch: planPartsRecomposeBatch,
      // WI-559/FED-1: fall back to the OWNER's own hive-home when the joiner rebind
      // (hiveHomeProjectionSlug) is null, so an owner's home harness engages the WI-259
      // membership guard instead of dropping every cross-member op (no-hiveHome). For a joiner
      // `potHomeSlug` is its rebound home (≠ null) so the fallbacks are a no-op. WI-3734:
      // `memberHomeRebindSlug` extends the fallback to an OWNED hive's member harness
      // (home ≠ own slug) — paired with the `resolveHomeLogKeyHex` exclusion below.
      potHomeSlug: potHomeSlug ?? ownPotHomeSlug ?? memberHomeRebindSlug,
      // WI-2105 REV: DECOUPLED content-guard home (member-set lookup) — broader than the
      // rebind fallback (covers an owned-hive member harness) and never drives hiveScoped.
      memberContentHiveHome: potHomeSlug ?? contentGuardHiveHome,
      resolveAuthorDevice,
      ...(resolveHomeLogKeyHex ? { resolveHomeLogKeyHex } : {}),
      pendingMemberContent,
      memoryFederationFlagOn: memoryFederationFlagSnapshot,
    });

  // WI-1544 (defect D): `rekey()` swaps topics IN PLACE, but `opts.swarmBinding` is
  // frozen at boot — every post-boot reader (owner-device resolve, the join-bootstrap
  // window, the swarm-join retry loop) must observe the CURRENT binding or it acts on
  // the pre-rekey topic (the retry loop could even rejoin the OLD topic during the
  // swarmHandle=null window mid-rekey). Kept current by rekey(); read it, not opts.
  let currentBinding: SwarmBinding | null = opts.swarmBinding ?? null;
  // WI-38344: a join-pot joiner can resolve its hive home before the first
  // announce arrives, so home resolution cannot identify the bootstrap phase.
  // Track the start of each join/rekey instead and bound the retry safety net
  // to the same finite grace budget used by pending-peer retries.
  let joinBootstrapStartedAt: number | null = null;
  // A known owner-device binding is conclusive evidence that a mismatching
  // device is not the owner; keep that adversarial path conclusive even while
  // the bounded bootstrap window is open.
  let joinedHiveOwnerDevice: string | null = null;
  // WI-2039866 (P-004): the GitHub user id THIS peer announces as (set once the announce
  // identity resolves in joinForBinding). The EN-4 owner exemption treats a remote log
  // bound to the same identity as one of the owner's own devices — the tower↔VM rig
  // is exactly that shape (one human, several attested devices), and its membership
  // allowlist must never be able to lock those devices out of each other.
  let localAnnounceGithubUserId: number | null = null;
  let hiveHomeProjectionSlug = await resolveHiveHomeProjectionSlug(opts.swarmBinding);
  // A-003 diagnostic (env-gated, off by default → zero test impact): show the
  // boot-time hive-home binding decision in the harness log so a live witness can
  // grep `[A-003]` to see whether the joiner rebind engaged + which slug. Every
  // line carries an ISO wall-clock timestamp right after the `[A-003]` tag so a
  // live witness can correlate it against PG joined_at / other frame's log
  // without back-computing timelines from scenario-order arithmetic. Set
  // PAPERCUSP_A003_TRACE=1 on the instance to enable.
  if (process.env.PAPERCUSP_A003_TRACE === '1') {
    console.error(
      `[A-003] ${new Date().toISOString()} boot ${opts.harnessSlug}: swarmBinding.kind=${opts.swarmBinding?.kind ?? '<none>'} hiveHomeProjectionSlug=${hiveHomeProjectionSlug ?? '<none>'}`,
    );
  }
  // WI-2105 REV diag (DURABLE, not env-gated): the effective member-content-guard
  // potHomeSlug for THIS harness's scoped apply = hiveHomeProjectionSlug ?? contentGuardHiveHome
  // (the DECOUPLED guard home — broader than the rebind fallback, so it now resolves for an
  // owned-hive member harness like hive-canary→papercusp). When it STILL resolves undefined for
  // a HIVE-PEERED HARNESS, decideMemberContentOp drops EVERY cross-member op with 'no-hiveHome'.
  // Post-fix this fires only on a residual case the fix does NOT cover (a swarm-bound harness
  // whose hive-home is genuinely unresolvable), so a non-hive / normally-resolved boot records
  // nothing (zero test/alerting impact); getBootHistory reveals it after the next restart.
  if (opts.swarmBinding && (hiveHomeProjectionSlug ?? contentGuardHiveHome) == null) {
    try {
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'merge_error',
        `hiveHome-resolve NONE→drop-all-cross-member: binding=${opts.swarmBinding.kind} projSlug=${hiveHomeProjectionSlug ?? '<none>'} guardHome=${contentGuardHiveHome ?? '<none>'}`,
      );
    } catch {
      /* diagnostic must never break boot */
    }
  }

  // ── C-001 re-key apply deps (shared-hive-rekey-2026-06-19, su-ee7e9) ── Built ONCE here
  // (like the rateLimiter): the decrypt gate + its pending-content buffer are stateful across
  // passes. null when the re-key is OFF for this harness (flag off / non-hive / no device
  // identity) ⇒ the per-pass applyImpl stays `enforcedApply`, byte-for-byte today. The
  // boot-deps helper owns the LocalDevice/crypto build behind a cheap flag-FIRST off-path, so
  // a non-rekey harness pays one cached flag read. Built BEFORE registerAllHarnessProjections
  // so the drain hook (below) can wire into the projection registration. `let`, NOT const:
  // rekey() REBUILDS it when a mid-session join resolves the hive-home (the boot build returned
  // null because the home was not yet bound) — see the rekey() rebind. The per-pass applyImpl +
  // drain re-read `rekeyDeps` each pass (mergeOnePass re-evaluates), so a rebuild takes effect
  // on the next pass with no reboot.
  const buildRekeyDeps = async (): Promise<HiveRekeyBootDeps | null> => {
    if (opts.rekeyDepsOverride !== undefined) return opts.rekeyDepsOverride;
    return buildHiveRekeyBootDeps({
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
    });
  };
  let rekeyDeps = await buildRekeyDeps();
  // ── Re-key DRAIN HOOK queue (su-c2a63) ── The hive_epoch_keys projection's
  // `onEpochKeyApplied(hive, epoch)` PUSHES here when a key row applies — RECORDING, not
  // draining (so it never re-enters the apply that is firing it). `mergeOnePass` drains it
  // AFTER each pass via `drainQueuedEpochContent`, re-applying the now-decryptable deferred
  // content. Empty + unused when the re-key is off. Shared boot-scope buffer — BOTH the
  // boot-time registration and the rekey() re-registration feed it via `recordEpochDrain`.
  const epochDrainQueue: DrainedEpoch[] = [];
  const recordEpochDrain = (potHomeSlug: string, epoch: number): void => {
    epochDrainQueue.push({ potHomeSlug, epoch });
  };

  // Wire the per-table PG projection writers into the GLOBAL registry too —
  // some non-Model-B callers (CLI introspection, single-harness contexts) still
  // read the global registry via `applyHyperbeeOpToPg`. Idempotent (re-running
  // overwrites by tableTag).
  registerAllHarnessProjections({
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    // WI-559/FED-1: owner-home fallback (see ownPotHomeSlug) so the global-registry content
    // projections also engage the WI-259 membership guard on an owner's home harness.
    // WI-3734: + the owned-member rebind fallback, paired with the home-log exclusion.
    potHomeSlug: hiveHomeProjectionSlug ?? ownPotHomeSlug ?? memberHomeRebindSlug,
    ...(resolveHomeLogKeyHex ? { resolveHomeLogKeyHex } : {}),
    // WI-2105 REV: DECOUPLED content-guard home for the global-registry apply path too.
    memberContentHiveHome: hiveHomeProjectionSlug ?? contentGuardHiveHome,
    // Drain hook: feed the queue ONLY when the re-key is active (rekeyDeps non-null) — else
    // the hive_epoch_keys projection's onEpochKeyApplied stays undefined (today's behavior).
    ...(rekeyDeps ? { onEpochKeyApplied: recordEpochDrain } : {}),
    // WI-259 P-004: share the content-before-membership buffer with the global registry too
    // (same instance as scopedApply's), so a non-Model-B / CLI apply path defers + drains
    // consistently. Inert for a non-hive harness.
    pendingMemberContent,
    memoryFederationFlagOn: memoryFederationFlagSnapshot,
  });

  // ── Per-harness scoped projection apply (D-021 collision fix). ──
  // The global registry is keyed by `tableTag`, so with 2+ booted harnesses the
  // LAST `registerAllHarnessProjections` wins and the global `applyHyperbeeOpToPg`
  // dispatches all ops to that one harness's projections — the others' ops are
  // silently dropped by the projections' `harness_slug` guard. This scoped apply
  // is bound to THIS harness's own projection set, so `mergeNow` applies each
  // harness's ops to its own projections with no cross-harness interference.
  //
  // G1 Provenance (P-002): pass ownLogKeyHex so the apply path can determine
  // origin from log-source (own log → 'local', admitted remote log → 'remote').
  // A-003: `let` (not `const`) so `rekey` can rebind the two hive projections when a
  // first-join re-keys this member onto the Hive topic (mergeOnePass reads the
  // CURRENT scopedApply each pass). An `applyOverride` (the rigs) is never rebuilt.
  let scopedApply = opts.applyOverride ?? buildScopedApply(hiveHomeProjectionSlug);

  // ── Owner-enforcement rate limiter (EN-2) ── STATEFUL across merge passes (its
  // per-(author,class) tumbling windows persist), so it is created ONCE here and
  // reused; the owner policy is re-snapshotted per pass below. Inert until an owner
  // sets a rate cap (no caps ⇒ the wrapper is a pure passthrough).
  const rateLimiter = new MemberRateLimiter();
  // F1-6/P-014: the sibling per-(source-author, niche) elite decider — STATEFUL like
  // rateLimiter (its per-(author,niche) tumbling windows persist across merge passes),
  // inert until an owner sets `hive_policy.rate.elitesPerNichePerHour`. Bounds a
  // source's elite concentration on ONE niche (the novelty-gift farm the per-source
  // rowsPerHour cap can't express); see elite-niche-rate-limiter.ts.
  const eliteNicheLimiter = new EliteNicheRateLimiter();
  // WI-253 (findings-EN-4.md "EN-1 GUI snapshot surface" fast-follow): register this
  // instance into the process-local registry so the owner-facing "member X at N/cap"
  // observability endpoint can read it. Additive only — the merge seam below still
  // closes over its OWN direct reference to `rateLimiter`; this is a second reference,
  // never a behavior change. Unregistered on close() below (see closeHooks).
  registerRateLimiter(opts.workspaceId, opts.harnessSlug, rateLimiter);

  // (rekeyDeps + epochDrainQueue are built above, before registerAllHarnessProjections, so
  // the re-key drain hook can wire into the projection registration — see there.)

  // ── Admitted-set ── keyHex → log. Seeded with the own log (which is
  // structurally an AdmittedLog). Remote logs are added on admit (4b).
  const admitted = new Map<string, AdmittedLog>();
  admitted.set(ownLog.keyHex, ownLog);

  // WI-38376: maximum VERIFIED writer-side length advertised for each admitted
  // remote log. A remote replica's local `length` advances only after blocks
  // arrive, so by itself it cannot distinguish "caught up" from "the writer is
  // ahead but this replica is frozen." Signed announce re-flushes carry that
  // missing high-water. This map is deliberately separate from `AdmittedLog`:
  // merge reads/cursors continue to use the actual local `log.length`, while
  // only replication liveness + repair confirmation use the maximum below.
  const advertisedLogHighWater = new Map<string, number>();
  const livenessKnownLength = (log: AdmittedLog): number =>
    Math.max(log.length, advertisedLogHighWater.get(log.keyHex) ?? 0);

  // ── WI-3288 (offline pot): admit the SEED's author logs ── The admitted-set
  // otherwise grows ONLY via swarm announce frames (4b below), so a packaged
  // install that cannot join the swarm (offline / gh-unauthenticated fresh box)
  // merges NOTHING: the WI-3232 seed restore replicated the hive's cores into
  // `store`, but no admission ever names them — pot visible, content empty.
  // The installer-shipped manifest (hash-verified, hive-matched, and already
  // trusted with the bundled epoch key) is the offline admission authority.
  // Ops from these logs apply with origin='remote' (log-source provenance —
  // never re-captured as this device's local writes), and hive-home content
  // takes the member-guard own-slug fast path, so no announce identity is
  // required. Best-effort: any throw degrades to today's swarm-only admission.
  try {
    const seedHiveHome = hiveHomeProjectionSlug ?? resolvedPotHomeSlug;
    if (seedHiveHome) {
      const seedLogAdmissions = await resolveSeedLogAdmissions({ potHomeSlug: seedHiveHome });
      for (const admission of seedLogAdmissions) {
        const { keyHex } = admission;
        if (keyHex === ownLog.keyHex || admitted.has(keyHex)) continue;
        const remote = await (opts.openRemoteLogOverride ?? openRemoteLog)(store, keyHex);
        const replicaVerdict = await validateSeedReplicaForAdmission(remote, admission);
        if (!replicaVerdict.ok) {
          // A manifest is a provenance claim, not proof that this target has
          // the corresponding bytes.  In particular, a stale sidecar can
          // expose a valid manifest while opening a different/empty store
          // (the observed 84f7 length=0/no-cursor episode).  Leave the key to
          // normal signed announce admission, which can recover once the
          // live peer is reachable; never put an unverifiable replica into
          // the merge set or its liveness-repair ladder.
          await remote.close?.().catch(() => {});
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'merge_error',
            `seed log skipped ${keyHex.slice(0, 8)}…: ${replicaVerdict.reason}`,
          );
          continue;
        }
        admitted.set(keyHex, remote);
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'seed_log_admitted' as BootHistoryKind,
          `seed ${keyHex.slice(0, 8)}… length=${admission.expectedLength} from=${admission.shippedFrom}`,
        );
      }
    }
  } catch (e) {
    recordBootEvent(
      opts.workspaceId,
      opts.harnessSlug,
      'merge_error',
      `seed-log admission failed (swarm-only admission continues): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // WI-183: replication-stall detector state, keyed by admitted remote
  // log_core_key. See `checkReplicationStall` (called from mergeOnePass, right
  // after each remote's `update()`) for the full rationale. Tracks, per remote
  // log that has EVER shown a live replicator peer, when it last did — and
  // whether we've already alarmed for the current stall episode (so a
  // sustained stall fires exactly once, not every merge tick).
  const replicationStallState = new Map<string, { lastNonZeroPeersAtMs: number; alarmed: boolean }>();
  const REPLICATION_STALL_GRACE_MS = opts.replicationStallGraceMs ?? DEFAULT_REPLICATION_STALL_GRACE_MS;
  // WI-5686: zombie axis gets its own grace, defaulting to the general one.
  const CONNECTED_NEVER_REPLICATED_GRACE_MS = opts.connectedNeverReplicatedGraceMs ?? REPLICATION_STALL_GRACE_MS;
  // WI-38376: frozen axis likewise, defaulting to the general one.
  const FROZEN_GRACE_MS = opts.frozenGraceMs ?? REPLICATION_STALL_GRACE_MS;
  // WI-6324: the independent dead-man sampler below continues only windows
  // opened by mergeOnePass's canonical, post-update sample. Starting a window
  // at raw admission time changes detector semantics (and can force-rejoin a
  // healthy-but-not-yet-sampled boot before its first merge observation).
  const canonicallySampledLivenessKeys = new Set<string>();

  // ── Revocation (D-004) ── the only blocklist. `revoked` holds device pubkeys
  // (base64) the read-admission decider refuses; `pubkeyToLogKeys` records every
  // device_pubkey → log_core_key association at admit time so `revoke()` can
  // find and drop ALL admitted logs announced by that device. A single device
  // legitimately announces multiple logs on one topic (member + hive-home),
  // while `admitted` is keyed by log_core_key and a revoke names only the
  // device_pubkey, so this multi-value reverse map is the bridge between them.
  const revoked = new Set<string>();
  const pubkeyToLogKeys = new Map<string, Set<string>>();
  // WI-10002600: log keys a device has retired by a verified own-log supersession,
  // → that device's pubkey. Refuses a late / out-of-order announce of the SAME key by
  // the SAME device (it declared the log dead); other devices are unaffected, so a
  // device can never use a supersession claim to block someone else's log.
  const supersededLogs = new Map<string, string>();

  function trackDeviceLog(devicePubkey: string, logKey: string): void {
    let logKeys = pubkeyToLogKeys.get(devicePubkey);
    if (!logKeys) {
      logKeys = new Set<string>();
      pubkeyToLogKeys.set(devicePubkey, logKeys);
    }
    logKeys.add(logKey);
  }

  function untrackDeviceLog(devicePubkey: string, logKey: string): void {
    const logKeys = pubkeyToLogKeys.get(devicePubkey);
    if (!logKeys) return;
    logKeys.delete(logKey);
    if (logKeys.size === 0) pubkeyToLogKeys.delete(devicePubkey);
  }

  /**
   * Remove one admitted remote log from every boot-scoped ownership/liveness
   * surface and release its Hypercore session. Callers persist the lifecycle
   * transition first so a device-wide revoke can write all sibling rows in one
   * ordered batch. The close is deliberately fire-and-forget: map removal is
   * the correctness boundary, while a live replicator can take seconds to tear
   * down and must not hold the merge/revoke hot path.
   */
  function dropAdmittedRemoteLog(logKey: string, devicePubkey: string | undefined, context: string): void {
    const droppedLog = admitted.get(logKey);
    admitted.delete(logKey);
    replicationStallState.delete(logKey);
    void dropReplicationLogState(opts.workspaceId, opts.harnessSlug, logKey);
    admittedIdentities.delete(logKey);
    advertisedLogHighWater.delete(logKey);
    if (devicePubkey) untrackDeviceLog(devicePubkey, logKey);

    if (droppedLog && typeof droppedLog.close === 'function') {
      void droppedLog.close().catch((e: unknown) => {
        console.error(`[boot] ${context}: closing session for ${peerLabel(logKey)} failed (non-fatal):`, e);
      });
    }
  }

  /** The admitted/pending identity of `logKey`, when this process knows it. */
  function knownLogOwner(logKey: string): string | undefined {
    return admittedIdentities.get(logKey)?.devicePubkey ?? pendingPeers.get(logKey)?.frame.device_pubkey;
  }

  /**
   * WI-10002600: does this frame carry a supersession that still has work to do
   * here (a listed key this same device still has admitted or pending)? Lets the
   * P-504 re-announce shortcut stay cheap without skipping an unapplied one.
   */
  function carriesUnappliedSupersession(frame: SignedAnnounce): boolean {
    const keys = frame.supersedes_log_keys;
    if (!Array.isArray(keys)) return false;
    return keys.some((k) => typeof k === 'string' && knownLogOwner(k.toLowerCase()) === frame.device_pubkey);
  }

  /**
   * WI-10002600: apply a verified own-log supersession. Runs inside the merge gate
   * (drainAdmissionQueue) AFTER the announcing log itself was admitted, so the
   * replacement is live before the old log is dropped.
   *
   * Only the log's OWN device may retire it: a key admitted (or pending) under another
   * device, a key whose owner is unknown (e.g. a seed-admitted log), and this node's own
   * log are all refused with a boot event. An unproven statement is ignored — the old
   * log then stays admitted, which is exactly the behaviour before this field existed.
   * Never throws: a supersession must not re-buffer the (already admitted) frame.
   */
  async function applyLogSupersession(frame: SignedAnnounce): Promise<void> {
    try {
      const verdict = verifyLogSupersession(frame);
      if (verdict.status === 'absent') return;
      if (verdict.status === 'invalid') {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_rejected',
          `supersession ${verdict.reason} ${peerLabel(frame.log_core_key)}`,
        );
        return;
      }
      const retire: string[] = [];
      for (const key of verdict.keys) {
        const owner = knownLogOwner(key);
        const refusal =
          key === ownLog.keyHex
            ? "names this node's own log"
            : owner !== undefined && owner !== frame.device_pubkey
              ? 'names a log owned by another device'
              : owner === undefined && admitted.has(key)
                ? 'names an admitted log with no known owner'
                : null;
        if (refusal) {
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'peer_log_superseded',
            `refused: ${peerLabel(frame.log_core_key)} ${refusal} (${peerLabel(key)})`,
          );
          continue;
        }
        supersededLogs.set(key, frame.device_pubkey);
        if (pendingPeers.get(key)?.frame.device_pubkey === frame.device_pubkey) {
          pendingPeers.delete(key);
        }
        if (admitted.has(key)) retire.push(key);
      }
      if (retire.length === 0) return;
      await persistPeerLifecycle(
        retire.map((logKeyHex) => ({
          logKeyHex,
          devicePubkey: frame.device_pubkey,
          state: 'retired' as const,
        })),
        'own-log supersession',
      );
      for (const key of retire) {
        dropAdmittedRemoteLog(key, frame.device_pubkey, 'own-log supersession');
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'peer_log_superseded',
          `${peerLabel(key)} superseded by ${peerLabel(frame.log_core_key)}`,
        );
      }
    } catch (e) {
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'merge_error',
        `own-log supersession failed for ${peerLabel(frame.log_core_key)}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  // WI-193 (G8): provenance tracking for the UN-REVOKE reconciliation below.
  // Holds ONLY pubkeys that entered `revoked` via the startup seed or
  // applyRevocationRefresh — i.e. from the PUBLISHED revoked-pubkeys list, never
  // from a live `revoke()` call. This is what lets applyRevocationRefresh safely
  // remove a pubkey no longer in the published list (an owner un-banning someone)
  // WITHOUT ever undoing an explicit, in-process `revoke()` (owner-ban / go-private
  // boundary) — a live revoke is authoritative and is never a member of this set
  // (revoke() also evicts it below, in case it was ALREADY refresh-sourced).
  const revokedViaRefresh = new Set<string>();
  // `admittedIdentities` (+ the WI-259 P-002 `resolveAuthorDevice` seam) is declared
  // ABOVE `buildScopedApply` so the content projections can thread the seam — see there.

  // ── Startup revocation seed (D-002) ── load PUBLISHED revocations BEFORE the
  // swarm is joined so any already-revoked peer is refused on first contact.
  //
  // ALWAYS called unconditionally — both the test-seam path (loadRevokedOverride
  // is a pure in-memory factory) and the production path (real loadRevokedPubkeys
  // against PG) seed `revoked` here, before `joinHarnessSwarm`.  This closes the
  // ~1s window where the swarm is live but the revoked set is still empty.
  //
  // FAKE-TIMER SAFETY: postgres.js uses setTimeout() for connection-pool timeouts.
  // Calling the real PG loader under `vi.useFakeTimers()` hangs indefinitely (the
  // timeout callback never fires until fake time is advanced, which happens AFTER
  // bootHarnessSubstrate returns). Tests that activate fake timers MUST supply
  // `loadRevokedOverride: async () => new Set()` (or a populated factory) so they
  // never reach the real PG loader.  Production callers always have real timers
  // and a live PG, so this is safe.
  //
  // Fail-open: a load failure records a boot event and continues.
  //
  // WI-10005183: both reads go through the NOTIFY-invalidated process cache
  // (revoked-set-cache.ts). This loader runs at the top of EVERY merge pass for
  // EVERY harness (~once a second each), and the published sets change a few times
  // a day — measured 162 identical queries/s on bg-host before the cache. The cache
  // serves nothing until it is attached to the live sync_invalidate LISTEN, and
  // every contributors / pot_members row write drops it, so a refresh here still
  // sees every committed revocation this process has heard about. The G7 ordering
  // and the WI-193 un-revoke reconciliation below are unchanged.
  const loadRevoked =
    opts.loadRevokedOverride ??
    (async () => {
      // Harness-scope revocations (the base set).
      const base = await loadRevokedPubkeysCached({
        workspaceId: opts.workspaceId,
        harnessSlug: opts.harnessSlug,
      });
      // Per-Hive admission (shared-hive-federation-2026-06-08 P-006 seam-1): when
      // this harness belongs to a Hive, UNION the Hive-scope revoked pubkeys so a
      // contributor revoked at the Hive grain is refused on EVERY member harness.
      // The read-admission decider is unchanged. Best-effort / fail-open: a hive
      // lookup failure leaves the harness-scope set intact.
      try {
        const { potHomeSlugForHarness } = await loadHiveFederationModule();
        const hiveHome = await potHomeSlugForHarness(opts.workspaceId, opts.harnessSlug);
        if (hiveHome) {
          // EI-18777176681958978: `potHomeSlugForHarness` returns the LOCAL handle, but the
          // revocations are projected under the OWNER-authored scope. Reading the local
          // handle on a joiner seeded an EMPTY revoked set — i.e. THIS seed, whose whole job
          // is refusing an already-revoked peer on first contact, refused nobody. Resolve
          // the federated scope first (a no-op on an owner).
          const { loadRevokedHivePubkeysForLocalPotCached } = await loadFederatedPotScopeModule();
          for (const pk of await loadRevokedHivePubkeysForLocalPotCached(opts.workspaceId, hiveHome)) {
            base.add(pk);
          }
        }
      } catch {
        // fail-open: harness-scope revocations still apply
      }
      return base;
    });
  try {
    const seeded = await loadRevoked();
    for (const pk of seeded) {
      revoked.add(pk);
      // WI-193 (G8): startup-seeded entries are refresh-sourced provenance —
      // eligible for un-revoke reconciliation if a later refresh drops them.
      revokedViaRefresh.add(pk);
    }
  } catch (e) {
    recordBootEvent(
      opts.workspaceId,
      opts.harnessSlug,
      'merge_error',
      `revoked-seed failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    // Fail-open: continue boot without the seeded set.
  }

  // ── Pending-peer retry set (D-006) ── peers whose channel-2 file hasn't
  // propagated yet. Stored as log_core_key → {frame, since} — one device
  // announces MULTIPLE logs on the same topic (A-003: a member log + the
  // hive-home log share a device), so a device-keyed buffer silently dropped
  // every log after the first (WI-1544 root cause #2). The retry timer
  // re-runs admission for each pending frame; on 'verified' the peer is admitted
  // normally; on conclusive failure or grace-window expiry the frame is removed
  // without admit. Revocation drops ALL of a device's buffered logs.
  const pendingPeers = new Map<string, { frame: SignedAnnounce; since: number }>();
  function purgePendingForDevice(devicePubkey: string): void {
    for (const [key, entry] of pendingPeers) {
      if (entry.frame.device_pubkey === devicePubkey) pendingPeers.delete(key);
    }
  }

  // ── Revocation refresh helper (D-002) ── load the current published revoked set
  // from PG (via `loadRevoked`) and union any NEW pubkeys into `revoked`. For each
  // newly-added pubkey that is CURRENTLY admitted, apply the same drop steps
  // `revoke()` uses. Fail-open: a load failure is caught by the caller.
  // IMPORTANT: callers MUST hold the `merging` flag or otherwise guarantee
  // single-threaded access to `admitted` / `pendingPeers` while this runs.
  //
  // WI-193 (G8 fix): also RECONCILES un-revocations. `revoked` was previously
  // monotonic for the life of the handle (union-only) — dropping a pubkey from
  // the published list never re-admitted it; the only recovery was a full
  // reboot. Now, any pubkey whose provenance is REFRESH-SOURCED
  // (`revokedViaRefresh` — i.e. it was never named in a live `revoke()` call)
  // and that is no longer present in the freshly-loaded published set is
  // removed from `revoked`, re-admitting it on its next announce. A pubkey
  // revoked via a live `revoke()` call is NEVER a member of `revokedViaRefresh`
  // (revoke() evicts it there too), so this reconciliation can never silently
  // undo an explicit owner-initiated revoke — only ever a published-list entry
  // that the owner has since removed.
  async function applyRevocationRefresh(): Promise<void> {
    const refreshed = await loadRevoked();
    for (const pk of refreshed) {
      if (!revoked.has(pk)) {
        // New revocation discovered from PG.
        revoked.add(pk);
        revokedViaRefresh.add(pk);
        // Drop from the pending-retry set — a revoked peer must never be retried.
        purgePendingForDevice(pk);
        // If the device is currently admitted, drop every log it announced.
        const logKeys = [...(pubkeyToLogKeys.get(pk) ?? [])];
        if (logKeys.length > 0) {
          await persistPeerLifecycle(
            logKeys.map((logKey) => ({
              logKeyHex: logKey,
              devicePubkey: pk,
              state: 'retired' as const,
            })),
            'published revoke',
          );
          for (const logKey of logKeys) {
            dropAdmittedRemoteLog(logKey, pk, 'published revoke');
            recordBootEvent(opts.workspaceId, opts.harnessSlug, 'peer_revoked', peerLabel(logKey));
          }
        }
      }
    }
    // Un-revoke reconciliation (G8): only refresh-sourced entries are eligible.
    for (const pk of [...revokedViaRefresh]) {
      if (!refreshed.has(pk)) {
        await persistPeerLifecycleForDevice(pk, 'active', 'published un-revoke');
        revoked.delete(pk);
        revokedViaRefresh.delete(pk);
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'peer_unrevoked',
          `pubkey ${pk.slice(0, 12)}… dropped from the published revoked list — re-admissible`,
        );
      }
    }
  }

  // ── Channel-2 re-verify for admitted peers (rev-v2 Component A) ──
  //
  // Design (harden-shared-hive-to-256-peers P-002): the GitHub `verifyBinding`
  // I/O runs LOCKLESS — OFF the merge lock — mirroring the admissionQueue
  // deferred-mutation pattern. The OLD design awaited a SERIAL `verifyBinding`
  // call per admitted peer INSIDE the merge pass under the `merging` lock; at
  // 256 peers that's ~256 serial network round-trips holding the lock for tens
  // of seconds → read-merge convergence FREEZE. Now:
  //   • `reverifyAdmitted()` (the producer) snapshots `admittedIdentities`, makes
  //     the `verifyBinding` calls OFF the lock, and ENQUEUES each conclusive-`fail`
  //     logKey into `reverifyDropQueue`. It MUTATES nothing shared.
  //   • `drainReverifyDropQueue()` (the consumer) applies those drops UNDER the
  //     merge gate at the TOP of each pass, right alongside `drainAdmissionQueue()`
  //     (delete from the three maps + a `peer_revoked` boot-event).
  //   • `maybeReverifyAdmitted()` (still under the lock) only drains the drop queue
  //     and, when the cadence has elapsed and no verify is already in flight, KICKS
  //     OFF the lockless producer as a non-awaited `void (async …)()`. NET: zero
  //     GitHub I/O under the merge lock.
  // The slow cadence is enforced by `lastReverifyAt`; `reverifyInFlight` coalesces
  // so a long verify never stacks up behind every poll tick.
  //
  // Re-admit path: a channel-2-fail drop does NOT add the pubkey to the published
  // `revoked` set. A GitHub-deleted binding is a GitHub-side revocation, not a
  // permanent blocklist entry — if the binding is re-published the peer can
  // re-announce and be admitted through normal admission. This differs from
  // revoke() (which adds to `revoked` so a re-announce is permanently refused)
  // and is intentional: let normal admission re-verify rather than blocklisting.
  //
  // Scaling (shared-hive-cross-machine-scale-10k P-021): a pass verifies at most
  // `reverifyBatchSize` peers, walked ROUND-ROBIN from `reverifyCursor`, so the
  // GitHub call rate is O(1) in membership rather than O(N). Off-lock (P-002)
  // fixed the CONVERGENCE half of the problem — the merge lock is no longer held
  // across the sweep — but the calls themselves stayed O(N) per pass, which at
  // the 15-min cadence is 4N calls/hour and exceeds GitHub's 5,000/hr limit
  // around ~1,250 members. That failure is SILENT rather than loud: a
  // rate-limited check comes back `'pending'`, and fail-open (D-004) keeps the
  // peer — so past the limit revocation simply stops being detected. Bounding
  // the batch trades sweep LATENCY (every peer still gets checked, just after
  // ceil(N/batch) passes) for a rate that cannot run away.
  //
  // Peers are ordered by logKey so the walk is deterministic and stable under
  // concurrent admits/drops: the cursor is a KEY, not an index, so an insertion
  // or removal elsewhere in the ring cannot make the sweep skip or re-visit a
  // peer. Wrap-around resumes at the smallest key.

  /** Timestamp of the last `reverifyAdmitted` KICK-OFF (ms). 0 = never. */
  let lastReverifyAt = 0;

  /**
   * P-021 round-robin cursor: the logKey most recently re-verified. The next
   * pass resumes at the smallest admitted logKey STRICTLY GREATER than this,
   * wrapping to the smallest key overall when the tail is exhausted. `null`
   * (never swept) starts at the smallest key.
   */
  let reverifyCursor: string | null = null;

  // P-002: logKeys whose channel-2 binding came back a conclusive `'fail'` from
  // the LOCKLESS `reverifyAdmitted()` producer. Drained + applied UNDER the merge
  // gate by `drainReverifyDropQueue()` at the top of each pass (mirror of
  // `admissionQueue`). `reverifyInFlight` coalesces overlapping verify runs.
  const reverifyDropQueue: string[] = [];
  let reverifyInFlight = false;

  const DEFAULT_REVERIFY_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
  const reverifyIntervalMs = Number.isFinite(opts.reverifyIntervalMs as number)
    ? (opts.reverifyIntervalMs as number)
    : DEFAULT_REVERIFY_INTERVAL_MS;

  // P-021: max peers re-verified per pass. Default = the documented 256-peer
  // per-hive ceiling, so at or below the supported scale a pass still sweeps
  // everyone (unchanged behaviour) while larger hives are rate-bounded. A
  // non-finite / non-positive value is NOT "unbounded" — it falls back to the
  // default, because unbounded is precisely the bug being fixed.
  const DEFAULT_REVERIFY_BATCH_SIZE = 256;
  const reverifyBatchSize =
    Number.isFinite(opts.reverifyBatchSize as number) && (opts.reverifyBatchSize as number) > 0
      ? Math.floor(opts.reverifyBatchSize as number)
      : DEFAULT_REVERIFY_BATCH_SIZE;

  // The `verifyBinding` function used for re-verification: the same one wired
  // into the admission decider (verifyBindingOverride in tests; real adapter in
  // production). Captured here as a stable reference.
  const verifyBinding = opts.verifyBindingOverride ?? buildVerifyBindingAdapter();

  /**
   * LOCKLESS channel-2 re-verify PRODUCER (P-002). Snapshots `admittedIdentities`
   * and makes the SERIAL GitHub `verifyBinding` calls OFF the merge lock — at most
   * `reverifyBatchSize` of them per pass, walked round-robin from `reverifyCursor`
   * so the API rate is bounded independently of membership (P-021). It does
   * NOT mutate `admitted` / `admittedIdentities` / `pubkeyToLogKeys`; instead it
   * ENQUEUES each peer whose binding returns a conclusive `'fail'` into
   * `reverifyDropQueue`, which `drainReverifyDropQueue()` applies UNDER the merge
   * gate on a subsequent pass. Peers on `'pending'` / `'verified'` / a thrown
   * (transient) error are KEPT (fail-open per D-004) — only a conclusive `'fail'`
   * enqueues a drop. A drop does NOT add the pubkey to the published `revoked`
   * set (a GitHub-side removal is re-admittable; normal admission re-admits if the
   * binding returns).
   *
   * SAFE to call without holding the `merging` flag: it only READS a snapshot and
   * pushes logKeys onto the queue. The snapshot is taken up front so concurrent
   * merge-pass mutations (revoke / refresh drops) can't corrupt iteration; the
   * drain re-checks liveness before applying, so a peer already gone by drain time
   * is skipped.
   */
  async function reverifyAdmitted(): Promise<void> {
    // Snapshot identities up front so the off-lock awaits below iterate a stable
    // set even if a concurrent merge pass mutates the live maps. (Only admitted
    // PEERS have an identity entry — the own log is absent, so it is never
    // re-verified or enqueued.) Own-log and identity-less entries are dropped
    // HERE rather than skipped in the loop so they cannot consume a batch slot.
    const snapshot = [...admittedIdentities.entries()]
      .filter(([logKey, identity]) => logKey !== ownLog.keyHex && !!identity && identity.channel2Verified)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (snapshot.length === 0) return;

    // P-021: resume the round-robin at the first key strictly after the cursor;
    // wrap to the smallest key when the cursor is unset or past the tail. Since
    // the cursor is a KEY (not an index) this stays correct across concurrent
    // admits/drops — a peer added behind the cursor is simply picked up on the
    // next wrap, and a removed peer costs nothing.
    let startIdx = 0;
    if (reverifyCursor !== null) {
      const found = snapshot.findIndex(([logKey]) => logKey > reverifyCursor!);
      startIdx = found === -1 ? 0 : found;
    }

    // Never verify more than the whole ring in one pass, even if the batch size
    // exceeds membership (which is the ≤256-peer case: one pass = a full sweep).
    const take = Math.min(reverifyBatchSize, snapshot.length);

    for (let i = 0; i < take; i++) {
      const [logKey, identity] = snapshot[(startIdx + i) % snapshot.length]!;
      if (!identity) continue;
      // Advance the cursor as each peer is SELECTED, not on success, so a
      // thrown/transient verify still makes forward progress instead of pinning
      // the sweep on one unreachable peer forever.
      reverifyCursor = logKey;

      let result: 'verified' | 'pending' | 'fail';
      try {
        result = await verifyBinding(
          identity.devicePubkey,
          identity.githubLogin,
          identity.githubUserId,
          identity.attestationGistId,
        );
      } catch (e) {
        // Transient / network error — keep the peer (fail-open per D-004).
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_error',
          `reverify transient error for ${peerLabel(logKey)}: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }

      if (result === 'fail') {
        // Conclusive channel-2 revocation: ENQUEUE the drop. The actual map
        // mutation + `peer_revoked` event happen in `drainReverifyDropQueue()`
        // under the merge gate — never here, off the lock.
        reverifyDropQueue.push(logKey);
      }
      // 'pending' or 'verified': keep the peer (fail-open; only conclusive fail drops).
    }
  }

  /**
   * Apply queued channel-2 re-verify drops. MUST run under the merge gate
   * (called at the top of `mergeOnePass`, alongside `drainAdmissionQueue`, and
   * from `maybeReverifyAdmitted`). Idempotent: a peer already dropped between
   * enqueue and drain (e.g. by `revoke()` / `applyRevocationRefresh`) is skipped
   * without a duplicate event. Does NOT add to the published `revoked` set.
   */
  function drainReverifyDropQueue(): void {
    while (reverifyDropQueue.length > 0) {
      const logKey = reverifyDropQueue.shift()!;
      // Never drop the own log (defensive; the producer never enqueues it).
      if (logKey === ownLog.keyHex) continue;
      // Already gone (revoked / refreshed away since enqueue) → skip silently.
      if (!admitted.has(logKey) && !admittedIdentities.has(logKey)) continue;
      const identity = admittedIdentities.get(logKey);
      if (identity?.devicePubkey) {
        void persistPeerLifecycle(
          [{ logKeyHex: logKey, devicePubkey: identity.devicePubkey, state: 'retired' }],
          'channel-2 reverify drop',
        );
      }
      // Remove only this log from the device's reverse-map set. A sibling log
      // from the same device may still be admitted (for example when the
      // bounded reverify batch processed only one of the pair).
      dropAdmittedRemoteLog(logKey, identity?.devicePubkey, 'channel-2 reverify drop');
      recordBootEvent(opts.workspaceId, opts.harnessSlug, 'peer_revoked', `channel-2 revoked ${peerLabel(logKey)}`);
    }
  }

  /**
   * Called inside `mergeOnePass` under the `merging` lock. Does ZERO GitHub I/O
   * under the lock: it only (1) drains any drops the lockless producer already
   * enqueued, and (2) when `reverifyIntervalMs` has elapsed and no verify is in
   * flight, KICKS OFF the lockless `reverifyAdmitted()` producer fire-and-forget
   * (mirroring the owner-admit fire-and-forget in `drainAdmissionQueue`). The
   * producer runs OFF the lock and requests a merge pass when it has drops to
   * apply. A no-op kick-off when `reverifyIntervalMs <= 0` (disabled — tests drive
   * `reverifyAdmitted()` + `mergeNow()` directly via the handle).
   */
  async function maybeReverifyAdmitted(): Promise<void> {
    // Apply drops a prior off-lock verify enqueued (cheap; usually empty).
    drainReverifyDropQueue();
    if (reverifyIntervalMs <= 0) return;
    const now = Date.now();
    if (now - lastReverifyAt < reverifyIntervalMs) return;
    if (reverifyInFlight) return; // coalesce: a verify is already running off-lock
    lastReverifyAt = now;
    reverifyInFlight = true;
    // Fire-and-forget: the GitHub I/O runs OFF the merge lock (mirrors the
    // owner-admit fire-and-forget in drainAdmissionQueue). When the producer
    // enqueues drops it requests a merge pass to apply them under the gate.
    void (async () => {
      try {
        await reverifyAdmitted();
        if (reverifyDropQueue.length > 0) {
          // Request a pass to drain the drops under the gate (coalesces with any
          // in-flight/poll pass). NOT awaited — this runs off the lock.
          void mergeNow();
        }
      } catch (e) {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_error',
          `reverify run failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        reverifyInFlight = false;
      }
    })();
  }

  // ── Read-merge driver ── replaces the old Autobase read-loop. A pass:
  //   1. drain queued admissions (audit P-022 — see admissionQueue below).
  //   2. update() every REMOTE log first (the spike found remote `length`
  //      is stale until update() — own log is always current so skip it).
  //   3. version-gate each log (drop unknown-newer ops, D-024).
  //   4. mergeAdmittedLogs → LWW → existing projection writers → PG.
  // Serialized via the `inflightMerge` gate so the poll + on-admit + initial
  // passes don't race a half-applied merge.
  let stopped = false;
  // Teardown hooks (Stage 5 outbox drain stopper, etc.) run once on close().
  const closeHooks = new Set<() => void | Promise<void>>();
  // WI-253: drop this harness's rate-limiter registry entry on close so a stopped
  // harness is never served as if its limiter were still live.
  closeHooks.add(() => unregisterRateLimiter(opts.workspaceId, opts.harnessSlug));
  // EI-79 residual (p2p-performance-suite P-013): the INCREMENTAL merge cursor.
  // Replaces the lengths-snapshot steady-state skip with per-log read cursors +
  // a materialized winner-meta fold, so a changed tick decodes only the DELTA
  // (O(new ops)) instead of re-decoding + re-folding + re-applying the entire
  // history (O(total-history) — the original EI-79 burn; the snapshot skip only
  // rescued the *idle* tick). Also fixes EI-91: the per-log read budget is now
  // a per-PASS chunk the cursor advances through, so history beyond 50k ops is
  // delayed across passes, never silently dropped. The cursor is in-memory;
  // boot's first pass is the full-history fold (same cost as the old backfill).
  //
  // INVARIANT: the cursor's fold state is only valid for a stable log SET.
  // A log REMOVAL (revoke / channel-2 drop) resets the cursor — the next pass
  // re-folds the remaining logs from index 0 (exactly what the old full
  // re-merge did after a drop). A log ADDITION is additive (its cursor starts
  // at 0; lwwPick's total order makes fold order irrelevant) — no reset.
  let mergeCursor = createMergeCursor();
  // LIVE OFF→ON recovery is intentionally separate from the shared cursor: the
  // normal merge must keep advancing unrelated tables while memory federation
  // is dark. On enable, this cursor re-reads history but applies only memory ops.
  let memoryReplayCursor: ReturnType<typeof createMergeCursor> | null = null;

  // WI-2105 REV fix (FLAG-GATED, default ON): durable per-log merge-cursor
  // persistence. Seed each log's fold position from PG BEFORE the first fold and
  // checkpoint it persist-after-apply DURING the fold, so a bg-host restart
  // resumes each log where it left off instead of re-folding from 0 (which
  // starved routinesTick → the bghost-watchdog restart loop → the REV leg never
  // reached tail). Unlike snapshot-seeding (own-log only), this resumes ANY
  // admitted log, incl. an orphaned peer log the tower can't snapshot (e06b8704).
  // OFF ⇒ store is null ⇒ no seed + no persist hook ⇒ byte-identical to today.
  // EI-20317490590418053: load the durable seed set once, but copy only CURRENTLY
  // admitted keys into the live cursor. The cache remains available for remotes
  // admitted later in this boot; a real cursor RESET invalidates it permanently,
  // so a shrunk/forked/removed/rebound log can never seed past an invalid tail.
  // INJECTED by the production caller (substrate-sidecar-host builds the
  // PG-backed store for sidecar boots; boot-all injects the process-global
  // factory bootSubstrateWithFallback installs for in-process boots — WI-3297.
  // Both read the same SUBSTRATE_MERGE_CURSOR_PG flag). Default null ⇒
  // in-memory cursor only, so this function stays PG-free and every merge
  // test is hermetic unless it opts in.
  const pgMergeCursorStore: MergeCursorStore | null = opts.mergeCursorStore ?? null;
  const pgCursorSeedCache = pgMergeCursorStore ? createPgMergeCursorSeedCache() : null;

  // EI-18773697830188393 — the COLD-BOOT counterpart of the rekey's `forceReFold`.
  // A persisted cursor position claims "every op below this index was APPLIED", but
  // whether an op applies is decided by the pot-home projection scope it was folded
  // through (the federation demux key) — EXACTLY the value `buildScopedApply` binds
  // below. An op folded under a WRONG hive-home binding is demux-DROPPED while the
  // cursor still advances past it, so correcting the binding is not enough: the next
  // cold boot would seed from that stale progress and resume past the very rows it
  // dropped (WI-559 live: fed-b's `pot_members` stayed empty after the demux fix
  // because ~49.7k already-"done" owner rows were never re-folded). `forceReFold`
  // covers only the mid-session REKEY (see rekey() below), never a cold boot.
  //
  // So the fold's SCOPE is stamped on the persisted progress and re-checked on load
  // (migration 685): a changed binding simply seeds nothing → fold from 0 → the
  // dropped rows re-apply through the corrected scope, idempotently (LWW put/del).
  // Read LIVE at every call — `hiveHomeProjectionSlug` is reassigned by the rekey
  // rebind, and the re-fold that rebind triggers must persist under the NEW stamp.
  // Mirrors `buildScopedApply`'s `potHomeSlug` expression exactly (line ~1161); if
  // that fallback chain ever changes, this must change with it or a boot will either
  // re-fold forever (stamp never matches) or resume across a real scope change.
  const currentProjectionBinding = (): string | null =>
    hiveHomeProjectionSlug ?? ownPotHomeSlug ?? memberHomeRebindSlug ?? null;
  const currentApplyBinding = (): string | null => {
    const projectionBinding = currentProjectionBinding();
    // OFF preserves the legacy binding exactly. ON uses a distinct stamp, so a
    // cold boot cannot seed from progress recorded while memory applies no-op'd.
    return memoryFederationEnabledForPass
      ? `${projectionBinding ?? '<none>'}::mem0-federation-egress=on`
      : projectionBinding;
  };
  // WI-10005575: the same projection scope under the OTHER memory-federation state.
  // A fresh boot whose flag read degrades (an empty override cache plus a timed-out
  // store read serves the dark default) resolves the other stamp, finds no rows under
  // its own, and used to re-fold every log from 0 for hours. Progress stamped ON is a
  // superset of an OFF fold, so an OFF pass may resume from it outright; progress
  // stamped OFF skipped memory applies, so an ON pass resumes from it and owes a
  // memory-only replay (the same remedy as the live OFF→ON edge).
  const memoryToggledApplyBinding = (): string | null => {
    const projectionBinding = currentProjectionBinding();
    return memoryFederationEnabledForPass
      ? projectionBinding
      : `${projectionBinding ?? '<none>'}::mem0-federation-egress=on`;
  };

  // Keep lifecycle transitions in event order even when a caller deliberately
  // does not await the metadata write (the channel-2 drop path must stay
  // synchronous so it cannot perturb merge-pass scheduling). Without this
  // chain, a slow `retired` upsert can complete after a rapid re-admission's
  // `active` upsert and leave durable state describing the opposite of the
  // live admitted set. The tail always resolves: metadata failures are
  // recorded below and never poison later transitions.
  let peerLifecycleWriteTail: Promise<void> = Promise.resolve();

  function enqueuePeerLifecycleWrite(context: string, write: () => Promise<void>): Promise<void> {
    const result = peerLifecycleWriteTail.then(write).catch((e) => {
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'merge_error',
        `peer-lifecycle ${context}: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
    peerLifecycleWriteTail = result;
    return result;
  }

  /**
   * Persist identity/lifecycle evidence without making metadata availability a
   * prerequisite for admission, revocation, or merge progress. The canonical PG
   * cursor store exposes this seam; position-only test/in-memory stores omit it.
   */
  function persistPeerLifecycle(updates: readonly MergeCursorPeerLifecycleUpdate[], context: string): Promise<void> {
    const lifecycle = pgMergeCursorStore?.peerLifecycle;
    if (!lifecycle || updates.length === 0) return Promise.resolve();
    const applyBinding = currentApplyBinding();
    return enqueuePeerLifecycleWrite(context, () => lifecycle.upsert(updates, applyBinding));
  }

  /**
   * An explicit published-list un-revoke names only a device. Recover its
   * durable log mapping from the lifecycle store; rows without identity remain
   * unknown because silence or historical cursor presence is never evidence.
   */
  function persistPeerLifecycleForDevice(
    devicePubkey: string,
    state: MergeCursorPeerLifecycleUpdate['state'],
    context: string,
  ): Promise<void> {
    const lifecycle = pgMergeCursorStore?.peerLifecycle;
    if (!lifecycle) return Promise.resolve();
    const applyBinding = currentApplyBinding();
    return enqueuePeerLifecycleWrite(context, async () => {
      const rows = await lifecycle.load();
      const updates: MergeCursorPeerLifecycleUpdate[] = [];
      for (const row of rows.values()) {
        if (row.devicePubkey === devicePubkey) {
          updates.push({ logKeyHex: row.logKeyHex, devicePubkey, state });
        }
      }
      if (updates.length > 0) {
        await lifecycle.upsert(updates, applyBinding);
      }
    });
  }

  // A-003 apply-side determinism (su-81f2e): set by rekey() after a hive-home
  // projection rebind to force ONE full re-fold of all admitted logs through the
  // freshly-rebound scopedApply. The owner's hive_members op may have been admitted
  // AND folded (cursor-marked done) during the home=<none> boot window — when the
  // hive_members projection was still bound to the MEMBER slug, so the op dropped at
  // hive-members.ts (row.hive_home_slug !== member slug) and never re-applied (the
  // cursor says done; the log SET didn't change so the log-removal reset never fires).
  // Re-folding from index 0 re-applies it through the now-hive-home-bound projection
  // → roster row lands → the pendingMemberContent drain fires. Checked + cleared UNDER
  // the merge gate (top of mergeOnePass), so it never races an in-flight pass.
  let forceReFold = false;
  // A binding-changing rekey may reload durable progress stamped for the NEW
  // binding after the cursor reset. Every structural reset (removed/truncated
  // log or evicted deferred state) must still disable PG seeding for this boot.
  let forceReFoldCanReloadPgSeed = false;

  // p2p-join-catchup-speed P-522 (WI-10002899): the deferral-eviction re-fold policy
  // (eviction-refold.ts). An eviction owes a re-fold that is paid once the fold has
  // settled, as a rewind to the deferral floors rather than a cursor reset. The old
  // next-pass reset livelocked a joiner: P-007 run #1 reset log 5b00878b to 0 about
  // every 2 min, before the fold could reach the epoch-key rows near the tail.
  const evictionReFold = new DeferralEvictionReFold();
  // P-528 / P-002: ops each pass skipped in memory. The pass result counts them but
  // nothing reported them, so P-007 run #8 could judge P-528 only by tail ops/s.
  // Logged at most once a minute, and only while skips accrue.
  const foldSkips = { superseded: 0, storedOrder: 0, sinceLog: 0, loggedAt: Date.now() };
  const deferralBuffersHold = (): boolean => (rekeyDeps?.pending.size() ?? 0) > 0 || pendingMemberContent.size() > 0;

  // substrate-peer-log-compaction-2026-06-13 (design A, D-005) — FLAG-GATED.
  // WI-3370 (2026-07-10) split ONE boolean into two: (a) the READER —
  // SUBSTRATE_LOG_SNAPSHOT_READER (default ON) — seeds a fresh/reset cursor at
  // each log's latest `__snapshot__` index so a new joiner folds from the
  // snapshot instead of replaying full history (P-007); and (b) the PRODUCER —
  // SUBSTRATE_LOG_SNAPSHOT (default ON since p2p-join-catchup-speed P-005) —
  // periodically compacts the OWN log once ops since its last snapshot reach
  // `snapshotCompactThreshold` (P-003's proportional cadence). Both flags are read ONCE at boot (boot-scoped, like
  // the authority transports — a runtime flip needs a reboot to take effect).
  // producerEnabled OFF ⇒ no NEW snapshot ops produced (no-op); readerEnabled OFF
  // ⇒ cursor never seeds from a snapshot, folds from 0 instead — either OFF is
  // byte-identical to pre-P-011 intent. `lastSnapshotCoversUpTo` (the producer's
  // own compaction-cadence anchor) is seeded from the existing latest snapshot
  // only when the PRODUCER is enabled, so a restart (the watchdog recycles ~every
  // 12 min) does NOT re-compact a log that hasn't grown a threshold since.
  const snapshotReaderEnabled = await getFlag(FLAGS.SUBSTRATE_LOG_SNAPSHOT_READER, 'system').catch(() => false);
  const snapshotProducerEnabled = await getFlag(FLAGS.SUBSTRATE_LOG_SNAPSHOT, 'system').catch(() => false);
  // p2p-join-catchup-speed P-003: the cadence is PROPORTIONAL to the prior snapshot's
  // row count (`snapshotCompactThreshold`, bar R-6), so the anchor carries that set's
  // size too. `lastOwnCompactionSet` is the unfiltered set this engine may seed its
  // next compaction from; a filtered (release-cut head) set is never a seed for it.
  let lastSnapshotCoversUpTo = 0;
  let lastSnapshotRowCount = 0;
  let lastOwnCompactionSet: { coversUpTo: number; chunkCount: number } | null = null;
  /** The off-gate own compaction (periodic or requested), when one is running (`runOwnCompaction`). */
  let ownCompactionInFlight: Promise<unknown> | null = null;
  /**
   * WI-10002836 — whether the cadence anchor above is KNOWN: the latest set was found, or
   * the scan genuinely reached index 0 without one. Until then the own compaction does not
   * run; the merge pass retries the discovery instead.
   *
   * MEASURED 2026-09-24 on the tower: at 00:45Z and 01:52Z boot logged `lastCoversUpTo=0`
   * on a log whose newest set was ~48k blocks from the tail. A bounded read timed out under
   * load, `findLatestCompleteSnapshot` turned that `unreadable` outcome into `null`, and
   * boot read `null` as "never snapshotted", which armed a fold of all 7.76M ops from 0.
   * `null` is right for a reader (fold from 0 is correct, just slower). For the producer it
   * is the wrong answer: "I could not read the tail" means "ask again", not "start over".
   */
  let ownCompactionAnchorKnown = false;
  /** Epoch ms before which the anchor discovery is not retried (0 = no backoff). */
  let ownCompactionAnchorRetryAt = 0;
  let ownCompactionAnchorFailures = 0;
  /**
   * WI-10002836 — epoch ms before which a FAILED compaction is not re-run (0 = no backoff).
   * Without it a compaction that fails deterministically (a worker OOM on a live set larger
   * than its cap) restarts its full fold on the very next merge pass, forever.
   */
  let ownCompactionRetryAt = 0;
  let ownCompactionFailures = 0;
  /** Aborted by close(): releases a compaction that is still queued for a fold slot. */
  const ownCompactionAbort = new AbortController();

  /** Discover the cadence anchor (own-compaction-anchor.ts). Returns the boot-row token. */
  async function discoverOwnCompactionAnchor(): Promise<string> {
    const anchor = await discoverOwnCompactionAnchorOf(ownLog);
    if (anchor.known) {
      ownCompactionAnchorKnown = true;
      lastSnapshotCoversUpTo = anchor.lastCoversUpTo;
      lastSnapshotRowCount = anchor.lastRows;
      if (anchor.seedSet) lastOwnCompactionSet = anchor.seedSet;
    }
    return anchor.outcome;
  }

  if (snapshotProducerEnabled) {
    const anchor = await discoverOwnCompactionAnchor();
    // P-005: the cadence anchor this boot will compact against. Without it, a box
    // whose producer is ON but whose log has not grown a threshold since its last set
    // is indistinguishable from one whose producer never ran.
    try {
      const threshold = snapshotCompactThreshold(lastSnapshotRowCount);
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'own_log_compaction',
        `own log compaction anchor: producer=on ownLogLength=${ownLog.length} lastCoversUpTo=${lastSnapshotCoversUpTo} ` +
          `lastRows=${lastSnapshotRowCount} threshold=${threshold} ` +
          `due=${ownCompactionAnchorKnown ? shouldCompactOwnLog(ownLog.length, lastSnapshotCoversUpTo, threshold) : 'deferred'} ` +
          `anchor=${anchor}`,
      );
    } catch {
      // observability must never fail boot
    }
  }

  // P-019 (D-012) — the ON-DEMAND head snapshot. A release cut taken on a box where
  // THIS process holds the corestore (the WI-4487 no-outage path) cannot append the
  // head snapshot a `--sparse` cut requires: the cutter opens the store READ-ONLY and
  // holds no write lock. So the cutter asks US to append it, and we service the
  // request INSIDE the serialized merge block — the same place, and for the same
  // reason, as the periodic compaction above: an append racing a merge pass is the
  // one thing this engine must never do.
  //
  // Deliberately NOT gated on `snapshotProducerEnabled`. That dark flag rations the
  // PERIODIC producer, whose cross-machine convergence is P-008-unverified. This is a
  // one-shot, operator-requested append at release-cut time — precisely what the
  // QUIESCED cut branch already does unconditionally today
  // (cut-seed-cli.ts `refreshCorestoreStateForSeed`, which calls produceLogSnapshot
  // with no flag check). Gating it here would make the no-outage cut strictly weaker
  // than the outage-taking one it exists to replace, for no new exposure: the two cut
  // paths append the SAME op at the SAME point in the cut. See plan
  // memory-corpus-hygiene-and-release-distribution-2026-08-03 D-012.
  let pendingHeadSnapshot: {
    resolve: (r: ProduceSnapshotResult) => void;
    reject: (e: unknown) => void;
  } | null = null;

  // ── SUBSTRATE_SIDECAR Option B replication-offload (WI-604) ── FLAG-GATED, dark.
  // Read ONCE at boot (boot-scoped, like the snapshot + authority transports). When
  // ON, the swarm connection handler hands each accepted peer socket to the sidecar
  // for `corestore.replicate()` (offloading merkle-verify CPU + replication RSS — the
  // EI-79 win) INSTEAD of replicating in-process; the substrate engine + own log +
  // every `handle.append()` caller stay in-process untouched. OFF (the default) ⇒ the
  // offload seam is never passed to joinHarnessSwarm, so replication is byte-identical
  // in-process. A test may force it via `sidecarOffloadOverride` without the flag.
  const sidecarOffloadEnabled =
    opts.sidecarOffloadOverride !== undefined
      ? false // an explicit override seam is the source of truth (see joinForBinding)
      : await getFlag(FLAGS.SUBSTRATE_SIDECAR, 'system').catch(() => false);

  // ── Admission queue (audit P-022, EI-115/EI-116 contributor) ── admitPeer
  // used to mutate admitted/pubkeyToLogKeys/admittedIdentities directly while a
  // merge pass could be iterating them, and its mergeNow() no-op'd against an
  // in-flight pass, deferring the newly-admitted log to the next 1s poll.
  // Admissions now QUEUE here and are drained at the top of each pass under
  // the merge gate; mergeNow coalesces (a request landing mid-pass re-runs the
  // pass before the gate releases), so awaiting mergeNow after a queue push
  // always covers that admission.
  const admissionQueue: QueuedAdmission[] = [];

  // ── WI-3684 repair-on-detect: replication-liveness episode → ACTIVE repair ──
  // The liveness registry DETECTS a connected-but-dead log (the ef7a8160 class:
  // swarm holds live connections, the core never attaches a replicator this
  // process lifetime) but nothing REPAIRED it — every fire was a dead end that
  // ended in a blind bg-host restart, and each restart-under-load re-rolled the
  // dice on a differently part-wired plane. The repair for the zombie class is
  // a SESSION RE-ATTACH: close the stale Corestore session and re-open it,
  // which re-registers the core with the replication muxer on every live swarm
  // stream. Episodes fire INSIDE a merge pass (the sampler rides it), and a
  // re-attach mutates `admitted` — so the handler only ENQUEUES, and
  // `drainRepairQueue()` applies the swap UNDER the merge gate at the top of
  // the next pass (the admissionQueue / reverifyDropQueue pattern).
  //
  // WI-4241: widened to also cover 'frozen' (replicator attached, writer ahead,
  // zero ingest progress past grace). Originally scoped to ONLY
  // 'connected_never_replicated' on the assumption that a re-attach "does not
  // address" the frozen/blocks-stuck case — but code-tracing the WI-4070/WI-183
  // stall (mergedPosition stuck at 0 despite a genuine peersCount>0 replicator
  // peer, tens of thousands of known ops, 21h+) found the opposite: the actual
  // hang is `read-merge.ts`'s per-op `log.get(pos)` never resolving (timing out
  // every ~1Hz pass, retry-next-pass forever) — a STALE in-memory Hypercore
  // replicator-peer object whose block-request channel silently died, which is
  // exactly the zombie-session state a re-attach exists to fix. 'no_replicator'
  // (peersCount back to 0) still stays OUT of scope — that already has the
  // WI-752/WI-1534 swarm self-heal re-peer loop, which operates a level below
  // (re-establishing the swarm connection itself) and a session re-attach can't
  // help a peer that isn't connected at all. The attempt cap is per process
  // lifetime (episodes are edge-latched, so a failed repair cannot storm; the
  // cap guards the recover→re-stall flap case), shared across both kinds per
  // log so a log flapping between the two classes can't double the budget.
  const repairQueue: string[] = [];
  const repairAttempts = new Map<string, number>();
  // WI-5340: the episode `kind` that most recently drove a repair enqueue for
  // this log — read back by drainRepairQueue to label the post-repair
  // confirmation record (informational only; the confirmation JUDGES success
  // generically via mergedPosition/peersCount, not by re-checking the kind).
  const repairEpisodeKind = new Map<string, string>();
  const REPAIR_MAX_ATTEMPTS_PER_LOG = 3;
  const REPAIRABLE_EPISODE_KINDS = new Set(['connected_never_replicated', 'frozen']);
  // WI-5340 (WI-5332 Direction #1): replication-liveness.ts's alarm latches
  // (alarmedConnectedNever / alarmedFrozen) are EDGE-triggered — dispatchRepair
  // fires once per false→true transition and the latch clears ONLY on a
  // genuine observed recovery. If a re-attach does NOT actually fix the
  // zombie, the latch stays set forever within this process's lifetime, so
  // dispatchRepair — and therefore `enqueueRepairAttempt` below — never fires
  // again for that log: `repairAttempts` gets stuck at 1 and the 3-attempt
  // ladder is structurally unreachable via genuine in-process escalation.
  //
  // Fix: track a bounded "did the repair actually work" confirmation window
  // per logKeyHex, stamped by `drainRepairQueue` right after it applies a
  // re-attach. `checkRepairConfirmation` (called from the SAME per-log sample
  // mergeOnePass already takes for `sampleReplicationLiveness`) judges it once
  // the window elapses and, on failure, calls `enqueueRepairAttempt` DIRECTLY —
  // bypassing replication-liveness.ts's edge-latch entirely, so a genuinely
  // ineffective repair reaches attempt 2/3 within a single process lifetime
  // instead of only via WI-5332's cross-restart durable-EI shortcut.
  interface RepairConfirmation {
    /**
     * Start of the CURRENT judgment window. Note this is RE-STAMPED by the
     * zero-peers deferral branch (WI-5481) — so it is the window clock, NOT
     * the incident clock. For "how long has this log actually been broken",
     * read `repairAppliedAtMs` instead (EI-18723690188615364).
     */
    appliedAtMs: number;
    /**
     * EI-18723690188615364: when the re-attach this confirmation judges was
     * APPLIED — set once at stamp time and never re-stamped. The elapsed time
     * from here to the outcome IS the true incident duration, and nothing else
     * in the system records it: the repair-applied line reads as a 3-second
     * incident while the real user-visible outage ran ~8.5 minutes.
     */
    repairAppliedAtMs: number;
    /** mergedPosition observed at that moment — "did it advance since" is the test. */
    baselinePosition: number;
    kind: string;
    /**
     * EI-18723690188615364: how many times the zero-peers branch has deferred
     * judgment and re-armed. Bounded by REPAIR_CONFIRMATION_MAX_DEFERRALS so a
     * log cannot sit in silent, self-perpetuating deferral forever.
     */
    deferrals: number;
  }
  const repairConfirmations = new Map<string, RepairConfirmation>();
  /**
   * EI-18723690188615364: the deferral budget for the zero-peers branch of
   * `checkRepairConfirmation`. WI-5481 made that branch RE-ARM instead of
   * discard (correct — a `connected_never_replicated` repair forces a topic
   * rejoin, so the judged session is usually mid-reconnect with zero peers for
   * a few seconds right when grace elapses), but it re-armed UNBOUNDEDLY and
   * silently: a log that never regains a replicator peer defers forever and
   * emits nothing, indistinguishable from a healthy recovery.
   *
   * 5 deferrals × REPLICATION_STALL_GRACE_MS (180s default) ≈ 15 minutes —
   * orders of magnitude more than the few-seconds reconnect WI-5481 exists to
   * ride out, so the fix it landed is fully preserved. Past that budget the
   * confirmation is ABANDONED (recorded, not silently dropped) rather than
   * escalated: a log with a permanently-zero replicator count is the
   * `no_replicator` axis, owned by WI-752/WI-1534's swarm self-heal re-peer
   * loop — synthesizing more session re-attaches at it would be a retry storm
   * against a subsystem that is already handling it.
   */
  const REPAIR_CONFIRMATION_MAX_DEFERRALS =
    opts.repairConfirmationMaxDeferrals ?? DEFAULT_REPAIR_CONFIRMATION_MAX_DEFERRALS;
  // EI-13317 rung (b): harness-level cooldown for the repair-exhaustion →
  // forced-rejoin escalation below (NOT per-log — several admitted logs on
  // the same topic can stall together, and a topic-level rejoin already
  // covers all of them at once, so only ONE rejoin should fire per cooldown
  // window regardless of how many logs are involved). Deliberately SHORTER than
  // swarm.ts's 300s severed-link cadence: replication_soak (WI-5481) kills/
  // restarts a peer roughly every 90s and a connected_never_replicated
  // (zombie-socket) stall must recover WITHIN that 90s SLA every cycle — a 300s
  // cooldown gates every rejoin but the first, failing cycles 2..N. forceRejoin
  // is edge-latched (fires off a stall episode, not a timer) and only evicts idle
  // sockets + re-announces, so a 30s floor is safe from a rejoin storm.
  const REJOIN_ESCALATION_COOLDOWN_MS = 30_000;
  let lastRejoinEscalationMs = 0;
  // Escalate to the heavier topic-level forced rejoin (swarm.ts's
  // SwarmHandle.forceRejoin — the same lever rung (a)'s severed-link
  // escalation uses, triggered here off REPLICATION liveness instead of
  // zero-live-peers, which this failure shape never trips). Rate-limited
  // HARNESS-WIDE (not per-log — several admitted logs on the same topic can
  // stall together, and a topic-level rejoin already covers all of them at
  // once). `swarmHandle` is declared later in this function scope (assigned
  // once the join resolves) but by the time an episode can fire — mid a
  // merge pass, which requires the join to have already happened — it is
  // always set; same forward-reference pattern already used for
  // `swarmHandle?.liveConnectionCount` in the replication-liveness sampler
  // below. Shared by two callers (WI-5332): the in-process budget-exhausted
  // path below, and the cross-restart chronic-zombie path.
  function escalateToForcedRejoin(logKeyHex: string, kind: string, eventMessage: string): void {
    const now = Date.now();
    if (now - lastRejoinEscalationMs < REJOIN_ESCALATION_COOLDOWN_MS) {
      // WI-5639 (bug-drain-200k): this early-return used to be completely
      // silent — a genuinely NEW stall that arrives within the harness-wide
      // cooldown window of an EARLIER, unrelated rejoin gets no forced-rejoin
      // (by design: the cooldown assumes the earlier rejoin already covers
      // it), but nothing recorded that the skip happened. That left a
      // structurally unanswerable question during soak-SLA-miss triage:
      // "did this stall's prompt escalation actually get skipped by the
      // cooldown, or did it never reach here at all?" console.info (not
      // .warn/.error) for the same reason the success log below is
      // unguarded — meant to be always-on/grep-able, not test-suppressed.
      console.info(
        `[replication-liveness] repair-exhausted: forced-rejoin SKIPPED (cooldown ` +
          `${Math.round((REJOIN_ESCALATION_COOLDOWN_MS - (now - lastRejoinEscalationMs)) / 1000)}s ` +
          `remaining) log=${logKeyHex.slice(0, 12)}… harness=${opts.harnessSlug} kind=${kind} — ` +
          `assuming the earlier rejoin within this window already covers this stall`,
      );
      return;
    }
    lastRejoinEscalationMs = now;
    recordBootEvent(opts.workspaceId, opts.harnessSlug, 'replication_repair_exhausted', eventMessage);
    // console.info (not .error/.warn) — matches the repair-on-detect success
    // log just below (drainRepairQueue) which is also unguarded: this file's
    // vitest suite runs under vitest-fail-on-console (shouldFailOnError/Warn),
    // and this diagnostic is meant to be always-on/grep-able in production
    // logs (same rationale as that line), not a test-suppressed console.error.
    // WI-6324: report whether the swarm handle is actually ATTACHED. `void
    // swarmHandle?.forceRejoin()` swallows an unset handle silently — no promise is
    // created, so the `.catch` below never runs — which made "rejoin dispatched" and
    // "rejoin never attempted" produce byte-identical logs. The comment above claims
    // the handle is always set by the time an episode can fire; this makes that
    // claim OBSERVABLE instead of assumed, in production as well as under test.
    console.info(
      `[replication-liveness] repair-exhausted: forcing topic rejoin ` +
        `log=${logKeyHex.slice(0, 12)}… harness=${opts.harnessSlug} kind=${kind} ` +
        `swarm=${swarmHandle ? 'attached' : 'UNSET (rejoin NOT dispatched)'}`,
    );
    void swarmHandle?.forceRejoin().catch((e) => {
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'replication_repair_rejoin_failed',
        `${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }
  /**
   * WI-5340: the shared "enqueue a session-repair attempt for this log" path —
   * extracted from the replication-liveness episode handler so
   * `checkRepairConfirmation` (a SECOND caller, driven by the post-repair
   * confirmation window rather than a fresh liveness episode) shares the
   * exact same cap/exhaustion/chronic-zombie ladder instead of duplicating it.
   */
  function enqueueRepairAttempt(logKeyHex: string, kind: string): void {
    const attempts = repairAttempts.get(logKeyHex) ?? 0;
    if (attempts >= REPAIR_MAX_ATTEMPTS_PER_LOG) {
      // Session-level re-attach is exhausted for this log and it has STILL
      // re-stalled (the gate-run-050615 shape: swarm re-pairs repeatedly,
      // content replication never re-attaches — a per-log Corestore session
      // swap alone didn't fix it).
      escalateToForcedRejoin(
        logKeyHex,
        kind,
        `${peerLabel(logKeyHex)} repair budget exhausted ` +
          `(${REPAIR_MAX_ATTEMPTS_PER_LOG}/${REPAIR_MAX_ATTEMPTS_PER_LOG}) and re-stalled ` +
          `(${kind}) — forcing topic rejoin`,
      );
      return;
    }
    // WI-5332: this process's FIRST episode for this log — check whether a
    // durable EI is ALREADY open for this exact (harness, log, kind). Open
    // means a PRIOR process instance already stalled on this same zombie and
    // no recovery has been observed since (an EI only clears on genuine
    // ingest/replicator recovery — see replication-liveness.ts) — i.e. this
    // is not a fresh stall, it is the SAME chronic zombie surviving a process
    // restart. `repairAttempts` is a per-process-lifetime Map (mechanism (a)
    // in the item body): under restart-cadence disruption (a real sidecar
    // restart, or the live-fed-gate rig's restart_durability /
    // reconnect_catchup scenarios) it resets to 0 before ever reaching
    // REPAIR_MAX_ATTEMPTS_PER_LOG, so without this check the forced-rejoin
    // escalation above is structurally unreachable exactly when the
    // condition is chronic (every restart amnesties the budget). Best-effort
    // and fire-and-forget — never blocks the ordinary in-budget repair
    // enqueued below; a check failure/timing miss just falls back to the
    // ordinary per-process ladder for this cycle.
    if (attempts === 0) {
      void (async () => {
        let alreadyChronic = false;
        try {
          const m = await loadReplicationStallEiModule();
          alreadyChronic = await m.hasOpenReplicationStallEi({
            harnessSlug: opts.harnessSlug,
            logKeyHex,
            kind: kind as ReplicationStallEpisode['kind'],
          });
        } catch {
          /* best-effort — falls back to the ordinary per-process ladder */
        }
        if (!alreadyChronic) return;
        // The local budget is moot for a proven-chronic zombie — mark it
        // exhausted too so a same-process re-stall after this also escalates
        // immediately instead of waiting through another 3-attempt cycle.
        repairAttempts.set(logKeyHex, REPAIR_MAX_ATTEMPTS_PER_LOG);
        escalateToForcedRejoin(
          logKeyHex,
          kind,
          `${peerLabel(logKeyHex)} chronic zombie (${kind}): a durable EI for ` +
            `this exact log is already open from a PRIOR process instance — restart-cadence ` +
            `disruption would otherwise amnesty the session-repair budget every restart ` +
            `(WI-5332) — forcing topic rejoin without re-running it`,
        );
      })();
    }
    repairEpisodeKind.set(logKeyHex, kind);
    repairAttempts.set(logKeyHex, attempts + 1);
    if (!repairQueue.includes(logKeyHex)) repairQueue.push(logKeyHex);
  }

  /**
   * WI-5340: judge a completed repair once its confirmation window elapses.
   * Called from mergeOnePass's per-log sample (the SAME data
   * `sampleReplicationLiveness` already reads) — never on its own timer, so
   * it can only ever run at most once per merge pass per log, and only while
   * a confirmation is outstanding (the common case is a no-op Map lookup).
   *
   * Genuine recovery (ingest resumed OR caught up) clears the confirmation
   * and does nothing further — replication-liveness.ts's own recovery branch
   * independently clears ITS latch off the same sample, so the two are
   * consistent without coordinating directly. Otherwise: the repair did NOT
   * work — synthesize the next attempt via `enqueueRepairAttempt` directly,
   * which is precisely the call replication-liveness.ts's edge-latch cannot
   * make again on its own while still alarmed.
   *
   * WI-5481 (live-fed gate stamp=171739): a log with ZERO live peers right at
   * this exact judgment moment used to be treated as a permanent bail-out —
   * `repairConfirmations.delete()` ran unconditionally before the peers-count
   * check, so a zero-peer sample threw the confirmation away for good and no
   * later pass ever re-judged this log, even once a peer reconnected. That
   * is precisely the shape a `connected_never_replicated` repair produces: it
   * escalates straight to `escalateToForcedRejoin` (evicts the zombie socket
   * + fresh DHT join), so the very session this confirmation is judging is
   * almost always mid-reconnect — zero peers for a few seconds — right when
   * the grace window elapses. Evidence: serve.log showed "repair-on-detect:
   * re-attached replica session ... (attempt 1/3)" fire promptly after a
   * forced rejoin, then NO attempt 2/3 and NO exhaustion event for the rest
   * of the process — yet "recovered ... after 1105s/1080s swarm-connected-
   * but-dead" eventually fired, meaning the log truly was still stuck long
   * after grace elapsed; the confirmation had simply already been discarded.
   * Fix: a zero-peers sample RE-ARMS the confirmation (fresh `appliedAtMs`,
   * same baseline/kind) instead of deleting it, deferring judgment to a LATER
   * pass that actually observes a live peer — genuinely permanent
   * zero-replicator cases (the `no_replicator` axis — WI-752/WI-1534's swarm
   * self-heal loop, not this ladder) just leave the confirmation re-arming
   * forever, a harmless no-op Map entry, never retry-storming.
   */
  function checkRepairConfirmation(
    logKeyHex: string,
    mergedPosition: number,
    knownLength: number,
    peersCount: number | undefined,
  ): void {
    const confirmation = repairConfirmations.get(logKeyHex);
    if (!confirmation) return;
    if (Date.now() - confirmation.appliedAtMs < REPLICATION_STALL_GRACE_MS) return;
    const advanced = mergedPosition > confirmation.baselinePosition;
    // WI-6324: `knownLength` is the writer's length AS KNOWN TO OUR REPLICA, so it
    // only advances when replication is actually DELIVERING. On a zombie connection
    // that has delivered nothing it stays 0 — and a bare `knownLength <= mergedPosition`
    // then reads 0 <= 0 as "caught up", i.e. it treats "we know NOTHING about this
    // peer's log" as "we have EVERYTHING from it". That false confirmation deletes
    // the confirmation record and disarms the escalation ladder, so the connection
    // can never recover — in exactly the case the ladder exists for. Observed as a
    // deterministic red in the connected_never_replicated repro: the trace shows
    // `repair-confirmed: ingest recovered ... mergedPosition=0` two seconds after
    // the forced rejoin, and nothing ever lands afterwards.
    //
    // Catch-up therefore requires POSITIVE knowledge of the writer. With
    // knownLength === 0 there is no evidence of recovery, so we fall through to the
    // still-stalled branches below and the ladder keeps working. This costs nothing
    // for a genuinely empty log: there is no stall to confirm until something is
    // written, and the first delivered entry makes knownLength positive.
    //
    // NOTE this hazard is why every pre-existing test of this ladder hands it a
    // writer "well ahead" (length 1000) — the zero case was never exercised.
    const caughtUp = knownLength > 0 && knownLength <= mergedPosition;
    // EI-18723690188615364: elapsed since the repair was APPLIED (not since the
    // current window opened) — the true incident duration, reported on EVERY
    // outcome below so no branch is silent.
    const incidentS = Math.round((Date.now() - confirmation.repairAppliedAtMs) / 1000);
    const deferredNote = confirmation.deferrals > 0 ? ` after ${confirmation.deferrals} zero-peer deferral(s)` : '';
    if (advanced || caughtUp) {
      repairConfirmations.delete(logKeyHex);
      // EI-18723690188615364: genuine recovery used to `return` here having
      // logged NOTHING. That made the ~6min window between "repair applied" and
      // real recovery completely unreadable: an operator saw only the
      // repair-APPLIED line and concluded a 3-second incident, while the real
      // outage ran ~8.5 minutes. Success and indefinite deferral were both
      // silent and therefore indistinguishable from each other — the exact
      // reason WI-5673 stayed misdiagnosed for days. This is the ONLY place the
      // incident duration is knowable, so it is recorded here.
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'replication_repair_confirmed',
        `${peerLabel(logKeyHex)} (${confirmation.kind}): repair CONFIRMED ${incidentS}s after it ` +
          `was applied${deferredNote} — ${
            advanced
              ? `ingest resumed (mergedPosition ${confirmation.baselinePosition} → ${mergedPosition})`
              : `caught up (mergedPosition ${mergedPosition} >= knownLength ${knownLength})`
          }. That ${incidentS}s IS the real incident duration (the repair-applied line alone reads ` +
          `as an instant fix) (EI-18723690188615364)`,
      );
      // console.info (not .warn/.error) for the same reason as every other
      // diagnostic in this file: meant to be always-on/grep-able in a banked
      // serve.log, not suppressed by vitest-fail-on-console.
      console.info(
        `[replication-liveness] repair-confirmed: ingest recovered ${incidentS}s after repair` +
          `${deferredNote} log=${logKeyHex.slice(0, 12)}… harness=${opts.harnessSlug} ` +
          `kind=${confirmation.kind} mergedPosition=${mergedPosition}`,
      );
      return;
    }
    if ((peersCount ?? 0) <= 0) {
      // Still no live replicator peer — likely mid-reconnect after the
      // forced rejoin that applied this repair. Defer judgment instead of
      // discarding it: re-arm with a fresh window so the NEXT pass that
      // observes a live peer (or genuine progress) gets the real verdict.
      //
      // EI-18723690188615364: this branch was ALSO silent, and self-perpetuating
      // by design (it re-arms its own window every pass), so a log could sit in
      // deferral forever emitting nothing. Now bounded AND recorded.
      confirmation.deferrals += 1;
      if (confirmation.deferrals > REPAIR_CONFIRMATION_MAX_DEFERRALS) {
        repairConfirmations.delete(logKeyHex);
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'replication_repair_confirmation_abandoned',
          `${peerLabel(logKeyHex)} (${confirmation.kind}): ABANDONING repair confirmation ` +
            `${incidentS}s after the repair was applied — ${REPAIR_CONFIRMATION_MAX_DEFERRALS} ` +
            `deferral(s) elapsed and this log has NEVER observed a live replicator peer at a ` +
            `judgment moment, so the re-attach ladder can never judge it. Permanently-zero peers ` +
            `is the no_replicator axis (WI-752/WI-1534 swarm self-heal re-peer loop), not this ` +
            `ladder — deliberately NOT synthesizing another attempt (EI-18723690188615364)`,
        );
        console.info(
          `[replication-liveness] repair-confirmation ABANDONED after ` +
            `${REPAIR_CONFIRMATION_MAX_DEFERRALS} zero-peer deferrals (${incidentS}s since repair) ` +
            `log=${logKeyHex.slice(0, 12)}… harness=${opts.harnessSlug} kind=${confirmation.kind} ` +
            `— no live replicator peer; the no_replicator self-heal loop owns this`,
        );
        return;
      }
      confirmation.appliedAtMs = Date.now();
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'replication_repair_confirmation_deferred',
        `${peerLabel(logKeyHex)} (${confirmation.kind}): repair applied ${incidentS}s ago but ZERO ` +
          `live replicator peers at this judgment moment (likely mid-reconnect after the forced ` +
          `rejoin) — deferring judgment and re-arming the window ` +
          `(${confirmation.deferrals}/${REPAIR_CONFIRMATION_MAX_DEFERRALS}) (WI-5481)`,
      );
      console.info(
        `[replication-liveness] repair-confirmation DEFERRED ` +
          `(${confirmation.deferrals}/${REPAIR_CONFIRMATION_MAX_DEFERRALS}, ${incidentS}s since ` +
          `repair): zero live peers log=${logKeyHex.slice(0, 12)}… harness=${opts.harnessSlug} ` +
          `kind=${confirmation.kind} — still BROKEN, not recovered`,
      );
      return;
    }
    repairConfirmations.delete(logKeyHex); // one judgment per applied repair
    recordBootEvent(
      opts.workspaceId,
      opts.harnessSlug,
      'replication_repair_confirmation_failed',
      // EI-18723690188615364: this used to read `Date.now() - appliedAtMs`, which
      // the deferral branch above RE-STAMPS — so after any deferral it under-
      // reported "repair applied Ns ago" as the time since the last deferral
      // rather than since the repair. `repairAppliedAtMs` is never re-stamped.
      `${peerLabel(logKeyHex)} (${confirmation.kind}): repair applied ` +
        `${incidentS}s ago${deferredNote} but mergedPosition ` +
        `is still ${mergedPosition} (was ${confirmation.baselinePosition}) with a live replicator ` +
        `peer — ineffective repair, synthesizing the next attempt directly (WI-5340)`,
    );
    enqueueRepairAttempt(logKeyHex, confirmation.kind);
  }

  setReplicationRepairHandler(opts.workspaceId, opts.harnessSlug, (episode) => {
    if (!REPAIRABLE_EPISODE_KINDS.has(episode.kind)) return;
    // EI-13317 / WI-5481: connected_never_replicated is the zombie-socket class
    // (swarm shows live connections but this log has no replicator peer entry —
    // EI-18726252562537043: that can be EITHER side, our attach or the remote
    // never serving the core; do not assume it's our attach). A
    // per-log Corestore session re-attach CANNOT heal a dead socket — only a
    // forced rejoin (evict the zombie socket + fresh join, so corestore.replicate
    // re-attaches every log on the new connection) does. The ordinary ladder only
    // reaches that rejoin after REPAIR_MAX_ATTEMPTS_PER_LOG re-attaches, each
    // judged after REPLICATION_STALL_GRACE_MS (180s) — ~540s, far past the 90s
    // replication_soak SLA. So for THIS kind escalate PROMPTLY on the first
    // episode (deduped harness-wide by escalateToForcedRejoin's own cooldown, so
    // a later exhaustion/chronic escalation within the window won't double-fire).
    // Still enqueue the session re-attach below: it is the retry/confirmation
    // driver AND the heal for the broken-session-over-good-socket sub-case, and
    // it is the PRIMARY path for `frozen`, which a re-attach DOES heal (WI-4241).
    if (episode.kind === 'connected_never_replicated') {
      escalateToForcedRejoin(
        episode.logKeyHex,
        episode.kind,
        `${peerLabel(episode.logKeyHex)} connected_never_replicated (zombie-socket ` +
          `class) — prompt forced rejoin on first episode, bypassing the session-` +
          `re-attach ladder that cannot heal a dead socket within the ` +
          `replication_soak SLA (EI-13317/WI-5481)`,
      );
    }
    enqueueRepairAttempt(episode.logKeyHex, episode.kind);
  });

  /** Re-attach queued zombie logs. MUST run under the merge gate (mergeOnePass). */
  async function drainRepairQueue(): Promise<void> {
    while (repairQueue.length > 0) {
      const keyHex = repairQueue.shift()!;
      const current = admitted.get(keyHex);
      // Dropped/revoked between enqueue and drain — the drop IS the resolution
      // (EI-7788 semantics); and the own log is never repair material.
      if (!current || keyHex === ownLog.keyHex) continue;
      const attempt = repairAttempts.get(keyHex) ?? 1;
      try {
        try {
          await current.close?.();
        } catch {
          // stale-session close is best-effort — the fresh session IS the repair
        }
        const fresh = await (opts.openRemoteLogOverride ?? openRemoteLog)(store, keyHex);
        admitted.set(keyHex, fresh);
        // WI-5340: stamp a post-repair confirmation baseline — judged by
        // `checkRepairConfirmation` once REPLICATION_STALL_GRACE_MS has
        // elapsed (mergeOnePass's per-log sample). Overwrites any PRIOR
        // outstanding confirmation for this log (this repair supersedes it).
        const appliedNowMs = Date.now();
        repairConfirmations.set(keyHex, {
          appliedAtMs: appliedNowMs,
          // EI-18723690188615364: the immutable incident clock — `appliedAtMs`
          // is re-stamped by the zero-peers deferral branch, this is not.
          repairAppliedAtMs: appliedNowMs,
          baselinePosition: mergeCursor.positions.get(keyHex) ?? 0,
          kind: repairEpisodeKind.get(keyHex) ?? 'frozen',
          deferrals: 0,
        });
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'replication_repair',
          `re-attached replica session ${peerLabel(keyHex)} after connected_never_replicated ` +
            `(attempt ${attempt}/${REPAIR_MAX_ATTEMPTS_PER_LOG})`,
        );
        console.info(
          `[replication-liveness] repair-on-detect: re-attached replica session ` +
            `log=${keyHex.slice(0, 12)}… harness=${opts.harnessSlug} ` +
            `(attempt ${attempt}/${REPAIR_MAX_ATTEMPTS_PER_LOG})`,
        );
      } catch (e) {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'replication_repair_failed',
          `${peerLabel(keyHex)} (attempt ${attempt}/${REPAIR_MAX_ATTEMPTS_PER_LOG}): ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  // 'admitted' listeners (audit P-022): consumers (perf rigs) previously
  // polled handle.admitted.size on a 100ms timer to detect mesh-readiness —
  // emit directly at admission instead. Best-effort: a throwing listener
  // never breaks admission or the merge pass.
  const admittedListeners = new Set<(info: { logKeyHex: string; admittedSize: number }) => void>();
  function emitAdmitted(logKeyHex: string): void {
    for (const listener of [...admittedListeners]) {
      try {
        listener({ logKeyHex, admittedSize: admitted.size });
      } catch {
        // listener errors never break admission
      }
    }
  }

  /** Drain queued admissions. MUST run under the merge gate (mergeOnePass). */
  async function drainAdmissionQueue(): Promise<void> {
    const newlyResolvedSourceLogs: string[] = [];
    while (admissionQueue.length > 0) {
      const { frame, channel2Verified } = admissionQueue.shift()!;
      // Revocation can land BETWEEN enqueue and drain (the queue defers the
      // admission); admitting then would resurrect a revoked peer. The decider
      // checked `revoked` at announce time — re-check at drain time.
      if (revoked.has(frame.device_pubkey)) {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_rejected',
          `revoked-before-drain ${peerLabel(frame.log_core_key)}`,
        );
        continue;
      }
      // WI-10002600: this device already declared this log dead (own-log supersession).
      // A late or out-of-order announce of it must not resurrect a log nobody serves.
      if (supersededLogs.get(frame.log_core_key) === frame.device_pubkey) {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_rejected',
          `superseded-by-own-device ${peerLabel(frame.log_core_key)}`,
        );
        continue;
      }
      try {
        if (!admitted.has(frame.log_core_key)) {
          const remote = await (opts.openRemoteLogOverride ?? openRemoteLog)(store, frame.log_core_key);
          admitted.set(frame.log_core_key, remote);
          recordBootEvent(opts.workspaceId, opts.harnessSlug, 'announce_admitted', peerLabel(frame.log_core_key));
          emitAdmitted(frame.log_core_key);
        }
        // The remote session is now open/admitted. Record its multi-value
        // device reverse mapping and full identity so device-wide revocation
        // and per-log channel-2 reverify cleanup remain independently correct.
        const priorDevice = admittedIdentities.get(frame.log_core_key)?.devicePubkey;
        if (priorDevice && priorDevice !== frame.device_pubkey) {
          untrackDeviceLog(priorDevice, frame.log_core_key);
        }
        trackDeviceLog(frame.device_pubkey, frame.log_core_key);
        admittedIdentities.set(frame.log_core_key, {
          devicePubkey: frame.device_pubkey,
          githubLogin: frame.github_login,
          githubUserId: frame.github_user_id,
          attestationGistId: frame.attestation_gist_id,
          channel2Verified,
        });
        newlyResolvedSourceLogs.push(frame.log_core_key);
        await persistPeerLifecycle(
          [
            {
              logKeyHex: frame.log_core_key,
              devicePubkey: frame.device_pubkey,
              state: 'active',
            },
          ],
          'verified admission',
        );
        // The frame reached this point only after real signature verification,
        // identity/scope admission, the revoke-before-drain recheck, and a
        // successful remote-log open. Re-announces may arrive out of order, so
        // retain the maximum signed high-water rather than the newest value.
        if (frame.log_length !== undefined) {
          const prior = advertisedLogHighWater.get(frame.log_core_key) ?? 0;
          if (frame.log_length > prior) {
            advertisedLogHighWater.set(frame.log_core_key, frame.log_length);
          }
        }
        // WI-10002600: the replacement log is admitted; now retire the log(s) its device
        // re-keyed away from. Merge-gated (we are inside drainAdmissionQueue).
        await applyLogSupersession(frame);
        // WI-639 + WI-280 + WI-1585: the OWNER's trust-admit of an announced peer, gated on
        // the owner-signed membership policy. Runs for EVERY drained announce — NOT only the
        // first core-admission (WI-1585): announces arrive on (re)connect, and a peer whose
        // core is already admitted (presence flowing) still needs its membership refreshed —
        // the SECOND DEVICE of an already-member GitHub user would otherwise NEVER be
        // attested in this process lifetime (the ownerAdmitOrPend already_member branch is
        // the designed reconnect self-heal: idempotent upsert + BUG-B epoch-key re-grant).
        {
          // admitAnnouncedPeerAsOwner resolves the Hive
          // home (member→hive_slug via a fresh registry read, the WI-280 fix), self-gates to
          // the OWNER box, then routes the decision through ownerAdmitOrPend: open/allowlisted
          // → upsertHiveMember (+ idempotent epoch [0..current] re-grant); approval → record a
          // federated pending-join (NO trust-admit until pot:membership_decide approves);
          // banned/not-allowlisted → refuse. Open-mode is BYTE-EQUIVALENT to the prior
          // unconditional upsert. Core admission / revocation / read-cut+epoch / per-op
          // enforcement are untouched (their own seams). Fire-and-forget: drainAdmissionQueue
          // runs under the merge gate, so this must NOT block it.
          void (async () => {
            try {
              const { admitAnnouncedPeerAsOwner } = await loadHiveMembershipAdmissionModule();
              const res = await admitAnnouncedPeerAsOwner(
                {
                  workspaceId: opts.workspaceId,
                  harnessSlug: opts.harnessSlug,
                  peer: {
                    githubUserId: frame.github_user_id,
                    githubLogin: frame.github_login,
                    devicePubkey: frame.device_pubkey,
                    attestationGistId: frame.attestation_gist_id,
                  },
                },
                {
                  // The boot ALREADY resolved this harness's hive-home (and keeps it
                  // current across rekey rebinds) — hand it over instead of letting the
                  // default re-resolve via registry+PG reads per announce. In the
                  // substrate SIDECAR (and in-process test harnesses) those default
                  // reads can be unconfigured and threw per announce (WI-1460: the
                  // cross-peer suite died on the console.error; live, the admit
                  // silently skipped). Deterministic + free.
                  potHomeSlugForHarness: async () => hiveHomeProjectionSlug ?? ownPotHomeSlug ?? null,
                },
              );
              if (res.action === 'pending') {
                recordBootEvent(
                  opts.workspaceId,
                  opts.harnessSlug,
                  'announce_pending',
                  `${peerLabel(frame.log_core_key)} awaiting owner approval (hive ${res.potHomeSlug})`,
                );
              } else if (res.action === 'refuse') {
                recordBootEvent(
                  opts.workspaceId,
                  opts.harnessSlug,
                  'announce_rejected',
                  `${peerLabel(frame.log_core_key)} membership refused:${res.reason} (hive ${res.potHomeSlug})`,
                );
              }
            } catch (e) {
              const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
              // The grant failure inside upsertHiveMember already records a queryable
              // `rekey_grant_failed` boot-event; this catch only fires if the resolve /
              // membership write itself throws. Stay non-blocking (merge-gated), best-effort.

              console.error(`[hive-rekey] owner admit failed for ${peerLabel(frame.log_core_key)}: ${detail}`);
            }
          })();
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        recordBootEvent(opts.workspaceId, opts.harnessSlug, 'announce_error', msg);
        // WI-1544 root cause #3 (one-shot silent loss): the frame was already
        // shift()'d off the queue, announces are never re-delivered (sender-side
        // sentKeys dedup), and this catch was ring-only — a single throw here
        // (e.g. openRemoteLog racing a rekey) permanently stalled every A→B
        // surface until a restart. Re-buffer the frame into the D-006 pending
        // set so the retry tick re-runs the FULL admission, and say so on
        // stderr (the boot-history ring is in-memory only).
        if (
          !admitted.has(frame.log_core_key) &&
          !revoked.has(frame.device_pubkey) &&
          !pendingPeers.has(frame.log_core_key)
        ) {
          pendingPeers.set(frame.log_core_key, { frame, since: Date.now() });
        }

        console.error(
          `[hyperbee-admission] admit failed for ${peerLabel(frame.log_core_key)} — re-buffered for retry: ${msg}`,
        );
      }
    }
    if (newlyResolvedSourceLogs.length > 0) {
      await reapplyDrainedMemberContent(
        pendingMemberContent.drainForSourceLogKeys(newlyResolvedSourceLogs, Date.now()),
      );
    }
  }

  // The merge gate — one RUNNING pass + at most one PENDING follower.
  // A mergeNow() during a running pass coalesces onto the single follower,
  // which STARTS after the current pass finishes — so every caller's promise
  // resolves after a pass that began after its call (a queued admission is
  // always drained by then). BOUNDED on purpose: an earlier shape re-ran the
  // running chain while any re-run flag was set, so a steady caller stream
  // (the 1s poll under connection churn, where passes exceed 1s) re-armed it
  // forever and awaiters never resolved — peers stopped converging.
  let runningMerge: Promise<number> | null = null;
  let pendingMerge: Promise<number> | null = null;
  // WI-1544: stderr dedup state for the mergeOnePass outer catch (the poll
  // fires ~1Hz — a repeating failure logs once a minute, not 60 times).
  let lastMergeErrorMsg = '';
  let lastMergeErrorLogTs = 0;

  // WI-10003427: pass-level merge watchdog state (see MERGE_PASS_STALL_MS).
  const mergePassStallMs = Math.max(0, opts.mergePassStallMs ?? MERGE_PASS_STALL_MS);
  let mergePassStartedAt: number | null = null;
  let mergePassStage = 'idle';
  let mergePassStallTimer: ReturnType<typeof setTimeout> | null = null;
  // Stamped in place by the incremental fold (IncrementalMergeOpts.progress), so a
  // stall inside it names the log, position and phase — not just the stage.
  const mergeProgress = createMergeProgressProbe();
  /** Name the top-level await the running pass is about to enter. */
  function markMergeStage(stage: string): void {
    mergePassStage = stage;
  }
  function describeMergePass(): string {
    if (mergePassStartedAt == null) return `no pass in flight`;
    const base = `pass in flight ${Math.round((Date.now() - mergePassStartedAt) / 1000)}s at stage '${mergePassStage}'`;
    return mergePassStage.startsWith('incremental-merge') || mergePassStage === 'memory-replay-merge'
      ? `${base} (${describeMergeProgress(mergeProgress)})`
      : base;
  }
  function armMergePassWatchdog(delayMs: number): void {
    mergePassStallTimer = setTimeout(() => {
      mergePassStallTimer = null;
      if (mergePassStartedAt == null || stopped) return;
      const msg =
        `${describeMergePass()} — ${admissionQueue.length} queued admission(s) and every later ` +
        `merge wait behind it`;
      recordBootEvent(opts.workspaceId, opts.harnessSlug, 'merge_stalled', msg);
      console.error(`[read-merge] [${opts.workspaceId}/${opts.harnessSlug}] MERGE PASS STALL: ${msg}`);
      armMergePassWatchdog(Math.min(delayMs * 2, MERGE_PASS_STALL_MAX_REARM_MS));
    }, delayMs);
    mergePassStallTimer.unref?.();
  }
  /** mergeOnePass wrapped with the pass-level watchdog. Only ever called from mergeNow's gate. */
  async function runTrackedMergePass(): Promise<number> {
    const startedAt = Date.now();
    mergePassStartedAt = startedAt;
    mergePassStage = 'start';
    Object.assign(mergeProgress, createMergeProgressProbe());
    if (mergePassStallMs > 0) armMergePassWatchdog(mergePassStallMs);
    try {
      return await mergeOnePass();
    } finally {
      if (mergePassStallTimer) {
        clearTimeout(mergePassStallTimer);
        mergePassStallTimer = null;
      }
      const elapsedMs = Date.now() - startedAt;
      if (mergePassStallMs > 0 && elapsedMs >= mergePassStallMs) {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'merge_stall_cleared',
          `merge pass settled after ${Math.round(elapsedMs / 1000)}s (last stage '${mergePassStage}')`,
        );
      }
      mergePassStartedAt = null;
      mergePassStage = 'idle';
    }
  }
  function mergeNow(): Promise<number> {
    if (stopped) return Promise.resolve(0);
    if (!runningMerge) {
      runningMerge = runTrackedMergePass().finally(() => {
        runningMerge = null;
      });
      return runningMerge;
    }
    if (!pendingMerge) {
      pendingMerge = runningMerge
        .catch(() => 0)
        .then(() => {
          // The running pass's finally has already cleared runningMerge, so
          // this re-entry starts the follower pass (or coalesces anew).
          pendingMerge = null;
          return mergeNow();
        });
    }
    return pendingMerge;
  }

  // P-019 (D-012) — arm the one-shot head snapshot and kick a pass to service it.
  // COALESCES on a single in-flight request: two concurrent callers share one snapshot
  // and one O(history) read. Without this, the second `pendingHeadSnapshot = …` would
  // overwrite the first waiter and hang it forever — the shape that makes a "just set a
  // flag" request channel quietly unsafe under any concurrency at all.
  let inFlightHeadSnapshot: Promise<ProduceSnapshotResult> | null = null;
  function produceHeadSnapshotNow(): Promise<ProduceSnapshotResult> {
    if (inFlightHeadSnapshot) return inFlightHeadSnapshot;
    if (stopped) {
      // mergeNow() short-circuits to 0 when stopped, so an armed request would never be
      // serviced and the caller would wait forever. Say so instead.
      return Promise.reject(
        new Error(
          `[substrate] cannot produce an on-demand head snapshot for ${opts.workspaceId}::${opts.harnessSlug}: ` +
            'this harness engine is stopped/closing.',
        ),
      );
    }
    const p = new Promise<ProduceSnapshotResult>((resolve, reject) => {
      pendingHeadSnapshot = { resolve, reject };
    }).finally(() => {
      inFlightHeadSnapshot = null;
    });
    inFlightHeadSnapshot = p;
    // Fire-and-forget: the pass's own promise tells us nothing about the snapshot (the
    // snapshot's result arrives on `p`), and a merge-pass failure must not reject the
    // request — the pending flag survives and the next pass (poll cadence ~1Hz) services
    // it. The CALLER owns the deadline, not the engine.
    void mergeNow();
    return p;
  }

  /**
   * WI-183: replication-stall detector. Samples an admitted REMOTE log's live
   * replicator-peer count (`RemoteLog.peersCount()` — best-effort, `undefined`
   * on a fake/mock log in tests, which is a silent no-op here) and records a
   * `replication_stalled` boot event the first time it has held at zero for
   * `REPLICATION_STALL_GRACE_MS`, having shown at least one peer before.
   *
   * Deliberately edge-triggered (fires once per stall episode, not every merge
   * tick) and deliberately gated on "was replicating before" — a peer that has
   * NEVER shown a live replicator peer is just offline (ordinary churn, not a
   * bug); the WI-183 symptom is specifically a log that WAS replicating and
   * then silently stopped while the swarm otherwise reports the peer connected.
   * Clears (allows a future re-alarm) the moment peers are seen again.
   */
  function checkReplicationStall(log: AdmittedLog): void {
    const maybePeersCount = log as Partial<{ peersCount(): number | undefined }>;
    if (typeof maybePeersCount.peersCount !== 'function') return;
    const count = maybePeersCount.peersCount();
    if (count === undefined) return; // underlying core doesn't expose .peers
    const now = Date.now();
    if (count > 0) {
      // Replicating (again) — (re)seed the clock and clear any prior alarm so
      // a later stall re-fires.
      replicationStallState.set(log.keyHex, { lastNonZeroPeersAtMs: now, alarmed: false });
      return;
    }
    // count === 0. A state entry exists ONLY for a log we've seen with peers > 0
    // at least once (never created on a zero observation — see above) — so a
    // MISSING entry here means this log has never shown a live replicator peer:
    // ordinarily offline, not the WI-183 symptom, and must never alarm.
    const state = replicationStallState.get(log.keyHex);
    if (!state || state.alarmed) return;
    if (now - state.lastNonZeroPeersAtMs < REPLICATION_STALL_GRACE_MS) return;
    state.alarmed = true;
    recordBootEvent(
      opts.workspaceId,
      opts.harnessSlug,
      'replication_stalled',
      `log=${log.keyHex.slice(0, 12)}… has had 0 live replicator peers for ` +
        `${Math.round((now - state.lastNonZeroPeersAtMs) / 1000)}s (was previously replicating)`,
    );
  }

  /**
   * P-019 (D-012) — service a pending ON-DEMAND head snapshot.
   *
   * Called from the TOP of `mergeOnePass`, and the position is a fix, not a
   * preference. It first sat beside the periodic compaction near the END of the
   * pass — which is unreachable on an IDLE pass, because `if (!changed) return 0`
   * short-circuits well before it. A harness whose drain has just completed is idle
   * BY DEFINITION, and that is precisely the moment a release cut asks for this: the
   * request would have been armed, never serviced, and the cut would have hung until
   * its budget expired. Caught by the empty-own-log case in
   * `__tests__/on-demand-head-snapshot.test.ts`, which timed out at 60s.
   *
   * It runs INSIDE the serialized merge block for the same reason the periodic
   * compaction does: `produceLogSnapshot` APPENDS, and an append racing a pass is
   * exactly what the merge gate exists to prevent. Running at the top rather than the
   * bottom costs nothing in correctness — a merge pass reads the ADMITTED logs and
   * writes PG; it never appends to the own log, so the snapshot summarises the same
   * own-log state either way.
   *
   * ⚠ COST, and the whole reason this is request-driven rather than automatic:
   * produceLogSnapshot reads the ENTIRE own log ([0, length) — 461,475 blocks on this
   * box as of 2026-08-03), so it STALLS the merge loop for its duration. Survivable
   * precisely because it is one-shot and deliberate (a release cut is already waiting
   * on it). The elapsed time is recorded as a boot event so the stall is observable
   * after the fact instead of being an unexplained merge gap.
   *
   * Failure is DELIVERED to the requester, never swallowed: unlike the periodic
   * compaction (best-effort, nobody is waiting), a caller is awaiting this promise, and
   * a silent failure would leave the cut believing it has a head snapshot it does not
   * have — the exact silent-degrade D-012 traced.
   */
  /**
   * WI-37553 / EI-20019309044931698 — force this process's just-appended blocks out of the
   * RocksDB memtable into SSTs, so a SEPARATE read-only open (the seed cutter's) can see
   * them. `store.storage.flush()` bottoms out in `rocks.flush()` (hypercore-storage
   * index.js:766-767), the RocksDB memtable->SST flush.
   *
   * Corestore ships no TypeScript types for its internal storage handle, so the shape is
   * narrowed at the boundary — the same `.storage.readOnly` guard corestore itself applies
   * before flushing (corestore/index.js:312).
   *
   * DELIBERATELY LOUD when the handle is missing. Silently skipping would re-create the
   * exact silent degrade this exists to remove — the cutter would be told `appended: true`
   * and then read a store without the snapshot — and it would do so invisibly on a future
   * corestore upgrade that renames the accessor. A loud failure is recoverable; a silent
   * one costs a 52-minute release cut to discover.
   */
  async function flushStoreForExternalReaders(): Promise<void> {
    const storage = (store as unknown as { storage?: { readOnly?: boolean; flush?: () => Promise<void> } }).storage;
    if (!storage || typeof storage.flush !== 'function') {
      throw new Error(
        `[substrate] cannot flush the corestore for ${opts.workspaceId}::${opts.harnessSlug} before answering an ` +
          'on-demand head-snapshot request: store.storage.flush is not available (corestore internals moved?). ' +
          'Refusing to report a head snapshot the caller may not be able to read — see EI-20019309044931698.',
      );
    }
    // A read-only store cannot have unflushed writes of ours, so there is nothing to do.
    if (storage.readOnly) return;
    await storage.flush();
  }

  /**
   * p2p-join-catchup-speed P-003 (bar R-7) — the periodic own-log compaction, run OFF
   * the merge gate. Started by the merge pass, never awaited by it; `close()` awaits it
   * after the store is torn down (the WI-1631 discipline for in-flight work).
   *
   * Never rejects: a failure is a boot event, as it was when this ran inline. A
   * failure caused by the engine stopping underneath it is not recorded at all.
   */
  /**
   * P-005 (design A, flag-gated): compact the OWN log once it has grown past the threshold
   * since its last snapshot — append ONE additive snapshot set (no fork). The threshold is
   * proportional to the prior set's row count (p2p-join-catchup-speed P-003, bar R-6).
   *
   * KICKED OFF, NOT AWAITED (bar R-7). The first compaction of a long log folds its whole
   * history (7.75M ops on the tower's papercusp pot), and awaiting it in the merge pass held
   * the merge gate for that entire read. A merge pass never appends to the own log (see
   * servicePendingHeadSnapshot), ordinary writes already append outside this gate, and
   * produceLogSnapshot re-anchors to appends that land during its read (WI-37526) — so the
   * gate bought no safety for this read. The in-flight guard keeps one compaction at a time;
   * the head-snapshot path waits for it so two producers never append concurrently.
   *
   * WI-10002836: never from an UNKNOWN anchor (retry the discovery instead, in the same
   * one-at-a-time slot), and never again before a failed run's backoff expires. Called at the
   * TOP of every merge pass. It used to sit below the `!changed` idle early-return, so a pot
   * whose cursor had caught up never compacted however far past its threshold it was
   * (measured: quartermaster-ops `due=true` on every boot for a day, no compaction), and a
   * failed run or an unknown anchor on an idle pot could never be retried.
   */
  function maybeStartOwnCompaction(): void {
    if (!snapshotProducerEnabled || ownCompactionInFlight || stopped) return;
    const now = Date.now();
    if (!ownCompactionAnchorKnown) {
      if (now >= ownCompactionAnchorRetryAt) {
        ownCompactionInFlight = retryOwnCompactionAnchor().finally(() => {
          ownCompactionInFlight = null;
        });
      }
    } else if (
      now >= ownCompactionRetryAt &&
      shouldCompactOwnLog(ownLog.length, lastSnapshotCoversUpTo, snapshotCompactThreshold(lastSnapshotRowCount))
    ) {
      ownCompactionInFlight = runOwnCompaction().finally(() => {
        ownCompactionInFlight = null;
      });
    }
  }

  /**
   * WI-10002836 — re-run the cadence-anchor discovery that boot could not complete. Runs in
   * the own-compaction slot, never under the merge gate. Never rejects.
   */
  async function retryOwnCompactionAnchor(): Promise<void> {
    const anchor = await discoverOwnCompactionAnchor();
    if (!ownCompactionAnchorKnown) {
      ownCompactionAnchorFailures += 1;
      const backoffMs = ownCompactionBackoffMs(ownCompactionAnchorFailures, OWN_COMPACTION_ANCHOR_RETRY_BASE_MS);
      ownCompactionAnchorRetryAt = Date.now() + backoffMs;
      // One row per doubling, not per attempt, so a long outage stays a handful of rows.
      if ((ownCompactionAnchorFailures & (ownCompactionAnchorFailures - 1)) !== 0) return;
    } else {
      ownCompactionAnchorFailures = 0;
      ownCompactionAnchorRetryAt = 0;
    }
    try {
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'own_log_compaction',
        `own log compaction anchor retry: anchor=${anchor} failures=${ownCompactionAnchorFailures} ` +
          `lastCoversUpTo=${lastSnapshotCoversUpTo} lastRows=${lastSnapshotRowCount} ` +
          (ownCompactionAnchorKnown
            ? `due=${shouldCompactOwnLog(ownLog.length, lastSnapshotCoversUpTo, snapshotCompactThreshold(lastSnapshotRowCount))}`
            : `nextAttemptInMs=${ownCompactionAnchorRetryAt - Date.now()}`),
      );
    } catch {
      // observability must never fail the compaction
    }
  }

  /**
   * P-530 / D-024 — the governor-receipt filter for one own-log snapshot. The own
   * compaction and the release cut's head snapshot both use it (WI-10003060), so every
   * set this log publishes drops the same dead receipts. The boundary is captured BEFORE
   * the PG census: a receipt appended after the census is at/above this index and the
   * transform keeps it automatically; a row already present in PG is kept through the
   * exact qualified-key set.
   */
  async function loadGovernorReceiptFilter(): Promise<GovernorReceiptSnapshotFilter> {
    const maxSourceIndexExclusive = ownLog.length;
    const liveQualifiedKeys = await (
      opts.loadOwnCompactionGovernorReceiptKeys ?? loadLiveGovernorReceiptSnapshotKeys
    )(opts.workspaceId);
    // D-024: own-log engineer-issues rows are hive-epoch envelopes, so the filter sees a
    // receipt only through these keys. A failed load keeps every encrypted row; the
    // outcome then reports them as unopened instead of reading as "no receipts".
    const envelopePotId = rekeyDeps?.potHomeSlug;
    const envelopeKeys = envelopePotId
      ? await (opts.loadOwnCompactionEnvelopeKeys ?? loadOwnCompactionEnvelopeKeys)(
          opts.workspaceId,
          envelopePotId,
        ).catch((e: unknown) => {
          console.error(
            `[snapshot] own-log snapshot: epoch keys for ${envelopePotId} unavailable; ` +
              `encrypted receipts stay in the set: ${e instanceof Error ? e.message : String(e)}`,
          );
          return null;
        })
      : null;
    return { maxSourceIndexExclusive, liveQualifiedKeys, ...(envelopeKeys ? { envelopeKeys } : {}) };
  }

  let checkpointStoreMemo: SnapshotFoldCheckpointStore | null | undefined;
  /** P-006 — the own compaction's resume checkpoint (see `ownCompactionCheckpointStore` in the opts). */
  function ownCompactionCheckpointStore(): SnapshotFoldCheckpointStore | null {
    if (checkpointStoreMemo !== undefined) return checkpointStoreMemo;
    if (opts.ownCompactionCheckpointStore !== undefined) {
      checkpointStoreMemo = opts.ownCompactionCheckpointStore;
    } else {
      const safe = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, '_');
      checkpointStoreMemo = fileSnapshotFoldCheckpointStore(
        joinPath(
          papercuspRoot(),
          'snapshot-fold-checkpoints',
          `${safe(opts.workspaceId)}__${safe(opts.harnessSlug)}__${ownLog.keyHex}.json`,
        ),
      );
    }
    return checkpointStoreMemo;
  }

  async function runOwnCompaction(trigger: 'cadence' | 'requested' = 'cadence'): Promise<OwnCompactionOutcome> {
    const startedAt = Date.now();
    const previousCoversUpTo = lastSnapshotCoversUpTo;
    try {
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'own_log_compaction',
        `own log compaction started: ownLogLength=${ownLog.length} lastCoversUpTo=${previousCoversUpTo} ` +
          `threshold=${snapshotCompactThreshold(lastSnapshotRowCount)} seeded=${lastOwnCompactionSet ? 'yes' : 'no'}` +
          (trigger === 'requested' ? ' trigger=requested' : ''),
      );
    } catch {
      // observability must never fail the compaction
    }
    try {
      const governorReceiptFilter = await loadGovernorReceiptFilter();
      const liveGovernorReceiptKeys = governorReceiptFilter.liveQualifiedKeys.length;
      const envelopeKeyEpochs = governorReceiptFilter.envelopeKeys?.keys.length ?? 0;
      const snap = await produceLogSnapshot(ownLog, {
        now: Date.now(),
        schemaVersion: CURRENT_SCHEMA_VERSION,
        governorReceiptFilter,
        ...(lastOwnCompactionSet ? { priorSnapshotHint: lastOwnCompactionSet } : {}),
        shouldAbort: () => stopped,
        // WI-10002855: the fold runs in a worker thread. Inline, the first full-history
        // fold held this host's event loop for 30+ min (lag p50 2.8s, PG connects timed
        // out, routines and git-sync stalled). No inline fallback: a worker failure
        // fails this compaction (recorded below) instead of freezing the host.
        foldWorker:
          opts.ownCompactionFoldWorker ??
          ((init) => SnapshotFoldWorker.open(init, { signal: ownCompactionAbort.signal })),
        // P-006: a fold interrupted by a bg-host restart resumes from its cursor, not index 0.
        ...(ownCompactionCheckpointStore() ? { foldCheckpoint: ownCompactionCheckpointStore()! } : {}),
        // WI-10002836: without a position the first full-history fold (7.76M ops on the
        // tower) was indistinguishable from a hang for its whole 30-minute run.
        onProgress: throttleSnapshotFoldProgress(
          (progress) => {
            try {
              recordBootEvent(
                opts.workspaceId,
                opts.harnessSlug,
                'own_log_compaction',
                `own log compaction progress: ${formatSnapshotFoldProgress(progress)} ` +
                  // The HOST's heap; the fold's own heap is `workerHeapUsedMb` above (WI-10002836).
                  `mainHeapUsedMb=${Math.round(process.memoryUsage().heapUsed / 1_048_576)} ` +
                  `elapsedMs=${Date.now() - startedAt}`,
              );
            } catch {
              // observability must never fail the compaction
            }
          },
          { minIntervalMs: opts.ownCompactionProgressIntervalMs ?? OWN_COMPACTION_PROGRESS_INTERVAL_MS },
        ),
      });
      ownCompactionFailures = 0;
      ownCompactionRetryAt = 0;
      const outcome: OwnCompactionOutcome = {
        ok: true,
        appended: snap.appended,
        coversUpTo: snap.coversUpTo,
        chunkCount: snap.chunkCount,
        rowCount: snap.rowCount,
        droppedGovernorReceipts: snap.droppedGovernorReceipts ?? 0,
        liveGovernorReceiptKeys,
        unopenedGovernorEnvelopes: snap.unopenedGovernorEnvelopes ?? 0,
        envelopeKeyEpochs,
        ...(snap.appendsHeldMs !== undefined ? { appendsHeldMs: snap.appendsHeldMs } : {}),
        elapsedMs: Date.now() - startedAt,
      };
      if (!snap.appended) return outcome;
      lastSnapshotCoversUpTo = snap.coversUpTo;
      lastSnapshotRowCount = snap.rowCount;
      lastOwnCompactionSet = { coversUpTo: snap.coversUpTo, chunkCount: snap.chunkCount };
      try {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'own_log_compaction',
          `own log compaction: coversUpTo=${snap.coversUpTo} chunks=${snap.chunkCount} rows=${snap.rowCount} ` +
            `droppedGovernorReceipts=${snap.droppedGovernorReceipts ?? 0} ` +
            `liveGovernorReceiptKeys=${liveGovernorReceiptKeys} ` +
            `unopenedGovernorEnvelopes=${snap.unopenedGovernorEnvelopes ?? 0} ` +
            `envelopeKeyEpochs=${envelopeKeyEpochs} ` +
            `appendsHeldMs=${snap.appendsHeldMs ?? 'none'} ` +
            `grewBy=${snap.coversUpTo - previousCoversUpTo} nextThreshold=${snapshotCompactThreshold(snap.rowCount)} ` +
            `elapsedMs=${Date.now() - startedAt} mergeGateHeld=false`,
        );
      } catch {
        // observability must never fail the compaction
      }
      return outcome;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (stopped || e instanceof SnapshotAbortedError) {
        return { ok: false, error: `aborted: ${error}`, elapsedMs: Date.now() - startedAt };
      }
      ownCompactionFailures += 1;
      const backoffMs = ownCompactionBackoffMs(
        ownCompactionFailures,
        opts.ownCompactionFailureBackoffBaseMs ?? OWN_COMPACTION_FAILURE_BACKOFF_BASE_MS,
      );
      ownCompactionRetryAt = Date.now() + backoffMs;
      try {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'own_log_compaction',
          `log compaction failed after elapsedMs=${Date.now() - startedAt}: ${error} ` +
            `(failures=${ownCompactionFailures} nextAttemptInMs=${backoffMs})`,
        );
      } catch {
        // observability must never fail the compaction
      }
      return { ok: false, error, elapsedMs: Date.now() - startedAt };
    }
  }

  // p2p-join-catchup-speed D-023 — ONE own compaction on request, outside the
  // proportional cadence. The cadence spaces sets by the prior set's row count
  // (1.9M ops on the tower's papercusp pot), so a fold-time policy change such as
  // P-530's receipt drop reaches no joiner until the log has grown that far again.
  // Same slot, same fold worker and same census as the periodic run: it waits for an
  // in-flight compaction instead of racing it (two producers appending at once lose an
  // anchor race), and concurrent requests COALESCE onto one run.
  let inFlightRequestedCompaction: Promise<OwnCompactionOutcome> | null = null;
  function compactOwnLogNow(): Promise<OwnCompactionOutcome> {
    if (inFlightRequestedCompaction) return inFlightRequestedCompaction;
    const refuse = (why: string) =>
      Promise.reject(
        new Error(`[substrate] cannot compact the own log of ${opts.workspaceId}::${opts.harnessSlug} now: ${why}`),
      );
    if (stopped) return refuse('this harness engine is stopped/closing.');
    if (!snapshotProducerEnabled) return refuse('the snapshot producer flag (SUBSTRATE_LOG_SNAPSHOT) is off.');
    const p = (async (): Promise<OwnCompactionOutcome> => {
      while (ownCompactionInFlight) await ownCompactionInFlight;
      if (stopped) throw new Error('engine stopped while waiting for the in-flight compaction');
      // WI-10002836: never from an UNKNOWN anchor. The merge pass retries the discovery.
      if (!ownCompactionAnchorKnown) {
        throw new Error('the compaction anchor is not known yet (discovery is retried by the merge pass); try again');
      }
      const run = runOwnCompaction('requested');
      ownCompactionInFlight = run.finally(() => {
        ownCompactionInFlight = null;
      });
      return run;
    })().finally(() => {
      inFlightRequestedCompaction = null;
    });
    inFlightRequestedCompaction = p;
    return p;
  }

  async function servicePendingHeadSnapshot(): Promise<void> {
    if (!pendingHeadSnapshot) return;
    // Two producers must never append to the own log at once (each verifies its own
    // anchor, and the loser would fail as an anchor race). A release cut asking for a
    // head snapshot therefore waits for an in-flight periodic compaction; this is the
    // one place the merge gate still waits on a compaction, and only during a cut.
    if (ownCompactionInFlight) await ownCompactionInFlight;
    const waiter = pendingHeadSnapshot;
    pendingHeadSnapshot = null;
    const startedAt = Date.now();
    const lengthBefore = ownLog.length;
    try {
      // WI-10003060 — the cut ships this set as the published seed, so it drops the same
      // dead governor receipts as the own compaction. Without the filter a cut that seeds
      // from an unfiltered set, or folds from 0, re-ships them (56% of set@7711093's rows,
      // plan p2p-join-catchup-speed D-019). A failed census costs a larger seed, never a
      // wrong one, so the cut proceeds unfiltered instead of failing.
      const governorReceiptFilter = await loadGovernorReceiptFilter().catch((e: unknown) => {
        console.error(
          `[snapshot] head snapshot: governor-receipt census failed; the set keeps every receipt: ` +
            (e instanceof Error ? e.message : String(e)),
        );
        return null;
      });
      const snap = await produceLogSnapshot(ownLog, {
        now: Date.now(),
        schemaVersion: CURRENT_SCHEMA_VERSION,
        ...(governorReceiptFilter ? { governorReceiptFilter } : {}),
        // EI-20108164746219771 — the SERVER installer shipped the build box's machine
        // label. This snapshot is the one a no-outage release cut ships: the cutter opens
        // READ-ONLY (we hold the write lock), asks for this via the head-snapshot route,
        // and then ships `[coreSparseFrom, len)` — a span that IS this snapshot's chunks.
        // Filtering here is therefore what keeps `presence` out of every published seed.
        //
        // POLICY, NOT A PARAMETER — deliberately not plumbed through the route. The route
        // is `auth: 'loopback'` and documents the release cut as its only caller, so a
        // caller-supplied table list would buy nothing and hand any loopback process the
        // ability to drop arbitrary tables out of the owner's LIVE own log.
        //
        // ⚠ IT DOES MUTATE THE LIVE LOG, and that is the cost to understand before adding
        // a table: readers fold FORWARD from the newest complete snapshot, so a row
        // omitted here is unreachable for anyone seeding from it. For `presence` that
        // self-heals within one 30s keep-alive (presence-announce.ts DEFAULT_REFRESH_MS);
        // for a table with real history it would be silent data loss. See
        // ./seed-excluded-tables.
        excludeTables: SEED_EXCLUDED_TABLES,
        // P-003: under the proportional cadence the last unfiltered set can be far past
        // the producer's tail-scan window, so without the hint a cut folds from 0 (the
        // ~7h failure mode). An unfiltered set is a safe seed for this filtered fold:
        // `SnapshotRowFolder.add` drops the excluded tables from its rows again.
        ...(lastOwnCompactionSet ? { priorSnapshotHint: lastOwnCompactionSet } : {}),
      });
      if (snap.appended) {
        // The cadence restarts from this set, and the anchor is now known. It excludes
        // only `SEED_EXCLUDED_TABLES`, which all regenerate (pinned by
        // seed-excluded-tables.test.ts), so it is also the unfiltered compaction's seed
        // (WI-10002836). Before, the next compaction had to find a set on its own, and on
        // a log whose only sets were these it folded the whole history from 0.
        lastSnapshotCoversUpTo = snap.coversUpTo;
        lastSnapshotRowCount = snap.rowCount;
        ownCompactionAnchorKnown = true;
        if (isSeedableForUnfilteredFold(SEED_EXCLUDED_TABLES)) {
          lastOwnCompactionSet = { coversUpTo: snap.coversUpTo, chunkCount: snap.chunkCount };
        }
      }

      // EI-20019309044931698 — flush the just-appended snapshot to SSTs BEFORE the
      // waiter is resolved, so `appended:true` cannot be observed by a release cut
      // while the only on-disk copy of those blocks is still WAL.
      //
      // WHY, precisely — the filed diagnosis ("the memtable is unflushed, so the
      // snapshot blocks are INVISIBLE to a read-only open") is MEASURABLY WRONG, and
      // the distinction decides what this call is allowed to promise. A read-only
      // RocksDB open uses walRecoveryMode POINT_IN_TIME and REPLAYS the WAL, so the
      // blocks are already visible unflushed. Measured cross-process (writer held
      // open, child doing the readOnly open form from seed-provider-corestore.ts:366):
      // with NO flush at all the child saw all 245 blocks; a positive control reading
      // a frozen copy correctly saw only 200, so the probe could in fact detect
      // staleness. The filing's own evidence agrees — its ENOENT was on `002810.log`,
      // a WAL file, i.e. the open was READING the WAL, not missing the data.
      //
      // What the flush actually buys is therefore NOT visibility but INDEPENDENCE
      // from the WAL: once these blocks are in an SST, the cutter's read-only open no
      // longer needs the WAL segments the live writer is rotating and deleting
      // underneath it — which is the open-time race (mechanism (a)) that has direct
      // evidence. It is a mitigation of that race, NOT a fix for it; the durable fix
      // is to cut from a RocksDB CHECKPOINT (a consistent hard-linked dir), which
      // removes the race class outright.
      //
      // ⚠ It MUST be `storage.db.flush()`. `storage.flush()` targets the root RocksDB
      // session, pinned to the 'default' column family, while hypercore data lives in
      // 'corestore' — measured at 0 new SSTs, i.e. a silent no-op. See the deliberate
      // non-declaration of `storage.flush()` in holepunch.d.ts.
      //
      // Never fatal: the data is durable-enough in the WAL either way (measured
      // above), so a flush failure is a DEGRADATION, not a lost snapshot — rejecting
      // here would convert a perfectly usable snapshot into a hard cut failure.
      // Recorded in the boot event so a silent degradation stays observable.
      let flushed: boolean | 'skipped' = 'skipped';
      if (snap.appended) {
        try {
          await store.storage.db.flush();
          flushed = true;
        } catch {
          flushed = false;
        }
      }

      try {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'peer_capped',
          `on-demand head snapshot: appended=${snap.appended} coversUpTo=${snap.coversUpTo} ` +
            `chunks=${snap.chunkCount} rows=${snap.rowCount} readBlocks=${lengthBefore} ` +
            `receiptFilter=${governorReceiptFilter ? 'on' : 'off'} ` +
            `droppedGovernorReceipts=${snap.droppedGovernorReceipts ?? 0} ` +
            `unopenedGovernorEnvelopes=${snap.unopenedGovernorEnvelopes ?? 0} ` +
            `appendsHeldMs=${snap.appendsHeldMs ?? 'none'} ` +
            `flushedToSst=${flushed} mergeStalledMs=${Date.now() - startedAt}`,
        );
      } catch {
        // observability must never abort the merge pass
      }
      // WI-37553 / EI-20019309044931698 — FLUSH BEFORE ANSWERING `appended: true`.
      //
      // The only caller of this on-demand path is the seed CUTTER, which appends a head
      // snapshot here and then opens this SAME store READ-ONLY, from a separate process,
      // seconds later. A read-only RocksDB open sees FLUSHED SSTs — never this process's
      // memtable — so the freshest blocks, i.e. the snapshot chunks we just wrote, are
      // precisely the ones it cannot see.
      //
      // Measured 2026-08-09: a COMPLETE, in-window 44-chunk set read as ABSENT to that
      // open (0 read timeouts, 24ms slowest get — the blocks were not slow, they were not
      // in the view). computeSparseFrom therefore fell back to "ship FULL history" and
      // seed-degradation-guard refused a 5.62 GB seed ~52 minutes into a release cut. Note
      // the guard's printed remedy ("append a fresh head snapshot") is actively
      // counter-productive against this: the FRESHER the snapshot, the LESS likely it is
      // flushed.
      //
      // Answering `appended: true` while the data is invisible to the caller IS the silent
      // degrade this function's doc comment already forbids — just one layer below where
      // D-012 saw it. So the flush is INSIDE the try: if it fails, the requester is
      // rejected rather than told it has a head snapshot it cannot read.
      if (snap.appended) await flushStoreForExternalReaders();
      waiter.resolve(snap);
    } catch (e) {
      waiter.reject(e);
    }
  }

  /** One serialized merge pass. Only ever called from mergeNow's gate. */
  async function mergeOnePass(): Promise<number> {
    // P-019 — BEFORE anything that can return early (notably the `!changed` idle
    // short-circuit further down). See servicePendingHeadSnapshot's doc comment.
    markMergeStage('head-snapshot');
    await servicePendingHeadSnapshot();
    // WI-10002836 — also before the idle early-return, for the same reason.
    maybeStartOwnCompaction();
    try {
      // Snapshot the dynamic memory gate under the merge lock before any cursor
      // binding, seeding, or projection apply for this pass. A live OFF→ON edge
      // starts one memory-only replay; OFF cancels an incomplete replay.
      markMergeStage('memory-federation-flag');
      const memoryFederationRead = await readMemoryFederationFlag();
      let memoryFederationEnabledNow = memoryFederationRead.value;
      if (memoryFederationRead.degraded !== null) {
        if (memoryFederationFlagAuthoritative) {
          // WI-10005919: hold the last authoritative value. Adopting the degraded OFF
          // would cancel an in-flight memory replay and flip the apply binding, and the
          // next good read would then start a full memory-only replay from 0.
          memoryFederationEnabledNow = memoryFederationEnabledForPass;
          warnMemoryFederationReadDegraded(
            memoryFederationRead,
            'pass',
            `holding ${memoryFederationEnabledNow ? 'ON' : 'OFF'} (last authoritative value)`,
          );
        } else {
          warnMemoryFederationReadDegraded(
            memoryFederationRead,
            'pass',
            `no authoritative value yet, running this pass ${memoryFederationEnabledNow ? 'ON' : 'OFF'}`,
          );
        }
      }
      if (!memoryFederationEnabledNow) {
        memoryReplayCursor = null;
      } else if (
        !memoryFederationEnabledForPass &&
        (memoryFederationFlagAuthoritative || memoryFederationSnapshotConsumed)
      ) {
        // A live OFF→ON edge. WI-10005919: a degraded boot value that no pass ever
        // applied under is not an OFF state, so it owes no replay; the cursor seed
        // below decides from persisted progress whether memory was missed.
        memoryReplayCursor = createMergeCursor();
      }
      memoryFederationEnabledForPass = memoryFederationEnabledNow;
      if (memoryFederationRead.degraded === null) memoryFederationFlagAuthoritative = true;
      memoryFederationSnapshotConsumed = true;

      // WI-3852 (F2 of WI-898): a bucket EVICTED from either content-deferral buffer (epoch-
      // key-not-yet-local / member-not-yet-federated) since the last pass has NO recovery path
      // short of a process restart, because there is otherwise no steady-state re-fold in
      // production — createMergeCursor only resets at boot / log-set change / an explicit
      // forceReFold below. Poll-and-clear each buffer's eviction signal once per pass (cheap:
      // O(1) flag reads, false in the overwhelmingly common case of zero evictions). A hit
      // owes a re-fold that re-encounters (and, for a still-relevant deferral, re-applies)
      // the evicted op without waiting on a restart. P-522: it is paid below once the fold
      // has settled, as a rewind to the deferral floors (see `evictionReFold`).
      // Both signals are read every pass, so neither can stay latched behind the other.
      // D-016: a drop owes the re-fold only once its blocker has cleared (the buffers release
      // it when the epoch key or the author's member row applies), and it is paid from the
      // drop's own log position. Every drop is logged, owed or not, so a re-fold is traceable.
      for (const [label, drops] of [
        ['epoch', rekeyDeps?.pending.dropped],
        ['member', pendingMemberContent.dropped],
      ] as const) {
        if (!drops) continue;
        const { evicted, expired } = drops.takeDropCounts();
        if (evicted + expired > 0) {
          console.warn(
            `[read-merge] [${opts.workspaceId}/${opts.harnessSlug}] D-016 ${label} deferrals dropped: ` +
              `evicted=${evicted} expired=${expired}; blockers still pending=${drops.blockerCount}`,
          );
        }
        const owed = drops.takeOwed();
        if (!owed) continue;
        evictionReFold.noteOwed(owed);
        console.warn(
          `[read-merge] [${opts.workspaceId}/${opts.harnessSlug}] D-016 ${label} blocker cleared: ` +
            `${owed.drops} dropped op(s) owe a re-fold from ` +
            ([...owed.floors].map(([k, p]) => `${k.slice(0, 12)}@${p}`).join(', ') || 'no recorded position') +
            (owed.sourceless ? ' (some had no position: coarse floors)' : ''),
        );
      }
      // D-016: a catching-up fold must not expire member content by wall clock (see holdExpiry).
      // P-538: "catching up" is any log behind its length, including one that stalled.
      pendingMemberContent.holdExpiry(!evictionReFold.isCaughtUp);

      // Queued admissions land first so THIS pass merges them (P-022).
      markMergeStage('drain-admissions');
      await drainAdmissionQueue();

      // Apply any channel-2 re-verify drops the LOCKLESS producer enqueued
      // (P-002) — mirror of drainAdmissionQueue: the GitHub I/O ran off the
      // merge lock; this only applies its conclusive-fail results under the gate.
      drainReverifyDropQueue();

      // WI-3684 repair-on-detect: apply queued zombie-log session re-attaches
      // under the same gate (see drainRepairQueue above) — the liveness episode
      // that enqueued them fired inside a PRIOR pass.
      markMergeStage('drain-repairs');
      await drainRepairQueue();

      // ── Revocation refresh BEFORE collecting the merge set (G7 fix) ──
      // A published revocation that has propagated to this peer's loader (e.g.
      // A's revoked_pubkeys row federated to B's PG) must drop the revoked
      // peer's log from `admitted` *before* this pass reads it — otherwise a
      // peer revoked in the SAME cycle as it appends new ops gets ONE final
      // merge of those ops (the refresh used to run only AFTER the merge body,
      // so a `changed` pass ingested the revoked-era ops before the drop). This
      // mirrors the ordering `revoke()` already uses: delete from `admitted`,
      // THEN merge. The cursor-reset check below sees the removed log and
      // re-folds the survivors without it. Fail-open per D-002 — and isolated
      // (WI-1544): a loadRevoked() throw at the TOP of the pass used to reach
      // the outer catch and abort EVERY pass, ring-only, silently stalling all
      // federation. A failed refresh now skips only the refresh; the next pass
      // retries it.
      markMergeStage('revocation-refresh');
      try {
        await applyRevocationRefresh();
      } catch (e) {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'merge_error',
          `revocation-refresh: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      const logs: AdmittedLog[] = [];
      const rawLogsByKey = new Map<string, AdmittedLog>();
      for (const log of admitted.values()) {
        // Refresh remote logs so `length` reflects the writer's appends.
        // The own log is the local source of truth; calling update() on it
        // is unnecessary (and it has no `update`), so only remotes refresh.
        if (log.keyHex !== ownLog.keyHex) {
          const maybeRemote = log as Partial<{ update(): Promise<void> }>;
          if (typeof maybeRemote.update === 'function') {
            try {
              // Bound the per-remote update() the same way read-merge bounds its
              // per-op get(): a connected-but-stalled peer's core.update({wait})
              // can block forever, and we hold the `merging` lock across the
              // whole pass — so an unbounded await here would stall own-log
              // progress AND every other remote. Race it against a timeout;
              // a timed-out remote is merged at its last-known length (the
              // catch already tolerates a failed update), and the next pass
              // retries. Per-remote so one stalled peer doesn't block others.
              markMergeStage('remote-update');
              await raceWithTimeout(maybeRemote.update(), UPDATE_TIMEOUT_MS);
            } catch {
              // A remote that can't refresh (peer offline / stream closed /
              // timed out) is merged at its last-known length; next pass retries.
            }
          }
          // WI-183: sample this remote's live replicator-peer count and alarm
          // on a sustained stall. Best-effort — never lets a detector hiccup
          // block the merge pass it rides.
          try {
            checkReplicationStall(log);
          } catch {
            // diagnostic-only — swallow
          }
        }
        rawLogsByKey.set(log.keyHex, log);
        logs.push(versionGatedLog(slug, log));
      }

      // ── WI-5781: the EXPECTED-but-unadmitted axis ──────────────────────────
      // Everything above samples logs from `admitted`, so the detector can only
      // ever report on logs it already attached. A log that never gets admitted
      // is never iterated, never sampled, and emits NOTHING — "broken" and
      // "healthy" become the same observable (silence), and the repair ladder
      // never runs because nothing ever detects.
      //
      // `pendingPeers` is precisely the set of peers we ACCEPTED an announce
      // from and are therefore SUPPOSED to be replicating, but have not
      // admitted. Sampling it makes that failure a first-class alarm with the
      // same durable-EI escalation as every other axis. Best-effort and fully
      // isolated, exactly like the per-log samples: a detector hiccup must
      // never break the merge pass it rides on.
      try {
        for (const [pendingKeyHex, pendingEntry] of pendingPeers) {
          // An admitted key should never also be pending, but clear defensively
          // so a transient overlap can't leave a latched alarm behind.
          if (admitted.has(pendingKeyHex)) {
            clearUnadmittedPeer(opts.workspaceId, opts.harnessSlug, pendingKeyHex);
            continue;
          }
          sampleUnadmittedPeer(
            opts.workspaceId,
            opts.harnessSlug,
            {
              keyHex: pendingKeyHex,
              pendingSinceMs: pendingEntry.since,
              reason: 'buffered awaiting membership (announce accepted, admission not granted)',
            },
            { graceMs: REPLICATION_STALL_GRACE_MS },
          );
        }
        // A peer that left the pending set by being ADMITTED must clear its
        // alarm so the durable EI auto-resolves; without this the recovery is
        // never reported and the EI stays open after replication is healthy.
        for (const admittedKeyHex of admitted.keys()) {
          if (!pendingPeers.has(admittedKeyHex)) {
            clearUnadmittedPeer(opts.workspaceId, opts.harnessSlug, admittedKeyHex);
          }
        }
      } catch {
        // diagnostic-only — swallow
      }

      // Log-set change detection: any cursor entry whose log is GONE from the
      // admitted set invalidates the fold state (its winners must be re-derived
      // without that log's ops) → reset and re-fold from zero this pass.
      const logKeys = new Set(logs.map((l) => l.keyHex));
      for (const known of mergeCursor.positions.keys()) {
        if (!logKeys.has(known)) {
          mergeCursor = createMergeCursor();
          if (memoryReplayCursor) memoryReplayCursor = createMergeCursor();
          pgCursorSeedCache?.invalidate();
          break;
        }
      }

      // A-003 apply-side: a rekey rebind asked for a full re-fold (re-apply every
      // admitted log through the newly-bound projections). Reset HERE, under the merge
      // gate, mirroring the log-removal reset above — one-shot, cleared immediately so
      // steady-state passes are unaffected. Placed before snapshot seeding (below) so a
      // re-fold behaves identically to the log-removal reset path.
      if (forceReFold) {
        mergeCursor = createMergeCursor();
        // A real apply-binding change selects an independent, scope-stamped PG
        // seed set; the binding-aware cache below reloads it safely. Same-binding
        // re-folds and every structural reset must start from zero instead. So must
        // a reset that also pays an owed eviction re-fold (P-522): durable progress
        // may sit past the evicted ops.
        if (!forceReFoldCanReloadPgSeed || evictionReFold.isOwed) pgCursorSeedCache?.invalidate();
        forceReFold = false;
        forceReFoldCanReloadPgSeed = false;
      }

      // P-522 (WI-10002899): pay an owed deferral-eviction re-fold once the fold has
      // settled. A cursor replaced above already pays it by re-reading from its seeds.
      const reFold = evictionReFold.settle(mergeCursor);
      if (reFold.kind === 'rewound') {
        console.warn(
          `[read-merge] [${opts.workspaceId}/${opts.harnessSlug}] P-522 eviction re-fold: rewound ` +
            (reFold.moved.length === 0
              ? 'no log (every cursor already at its floor)'
              : reFold.moved.map((m) => `${m.keyHex.slice(0, 12)}→${m.floor}`).join(', ')),
        );
      } else if (reFold.kind === 'reset') {
        // Deferrals buffered across a cursor replacement came from positions no floor
        // records. Only a full re-fold is sure to reach them.
        mergeCursor = createMergeCursor();
        pgCursorSeedCache?.invalidate();
        console.warn(
          `[read-merge] [${opts.workspaceId}/${opts.harnessSlug}] P-522 eviction re-fold: full reset ` +
            '(deferrals were buffered across a cursor replacement, so no floor is known)',
        );
      }
      // P-541: re-decide the member TTL hold now that this pass's admissions, lengths and
      // cursor moves are known. The hold set at the top of the pass reads the LAST pass, which
      // never saw a log admitted since, a replaced cursor or the rewind just paid.
      evictionReFold.noteUnpositioned(logs, mergeCursor);
      pendingMemberContent.holdExpiry(!evictionReFold.isCaughtUp);

      // WI-2105 + EI-20317490590418053 (flag-gated, default ON): load PG once,
      // but seed only keys admitted in THIS pass. The boot-lifetime cache is
      // reused for a remote admitted later, without placing absent keys into the
      // live cursor (where the log-removal invariant would mistake them for a
      // removal and reset the fold). Runs BEFORE snapshot seeding so a durable PG
      // resume position takes precedence; snapshot seeding fills only the rest.
      // Isolated (WI-1544): a load failure means "start at 0" (slower, correct) —
      // never aborts the pass via the outer catch.
      if (pgMergeCursorStore && pgCursorSeedCache) {
        markMergeStage('pg-cursor-seed');
        try {
          const applyBinding = currentApplyBinding();
          const fallbackBinding = memoryToggledApplyBinding();
          const seededFromFallback = await pgCursorSeedCache.seed(
            mergeCursor,
            pgMergeCursorStore,
            applyBinding,
            logKeys,
            fallbackBinding,
          );
          if (seededFromFallback.size > 0) {
            const owesMemoryReplay = memoryFederationEnabledForPass;
            if (owesMemoryReplay && !memoryReplayCursor) memoryReplayCursor = createMergeCursor();
            console.warn(
              `[read-merge] [${opts.workspaceId}/${opts.harnessSlug}] WI-10005575: seeded ` +
                `${seededFromFallback.size} log(s) from cursor progress stamped '${fallbackBinding}' ` +
                `(this pass binds '${applyBinding}'), instead of re-folding them from 0` +
                (owesMemoryReplay ? '; started a memory-only replay for the memory ops that stamp skipped.' : '.'),
            );
          }
        } catch (e) {
          // F4: an unreadable durable cursor may be holding an unapplied entry
          // at zero. Snapshot skipping is unsafe until that state is known.
          for (const key of logKeys) {
            if (!mergeCursor.positions.has(key)) mergeCursor.positions.set(key, 0);
          }
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'merge_error',
            `pg-cursor-seed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // P-007 (design A, flag-gated): seed a FRESH/reset cursor at each log's
      // latest snapshot so a new joiner (or a post-reset re-fold) starts from the
      // snapshot, not index 0. Idempotent — only seeds logs with no cursor
      // position yet, so steady-state passes are O(logs) cheap `.has()` checks.
      // OFF ⇒ never called ⇒ cursor seeds at 0 (unchanged).
      if (snapshotReaderEnabled) {
        // WI-1544 isolation: a seed failure means "start that log at 0" (slower,
        // still correct) — it must never abort the pass via the outer catch.
        markMergeStage('snapshot-seed');
        try {
          await seedCursorFromSnapshots(logs, mergeCursor);
          // WI-3985: the live OFF→ON memory replay is also a FRESH cursor. Reuse
          // the same complete-snapshot seed as every other fresh/reset fold so a
          // large peer log reconstitutes its current memory winners from the
          // snapshot plus tail instead of decoding its entire history from 0.
          // Torn/incomplete sets still fail closed inside seedCursorFromSnapshots
          // and leave this cursor unseeded for the slower full replay.
          if (memoryReplayCursor) {
            await seedCursorFromSnapshots(logs, memoryReplayCursor);
          }
        } catch (e) {
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'merge_error',
            `snapshot-seed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // P-522: the deferral floors, taken after seeding so they are where this pass's fold
      // starts.
      // D-016: an unreleased drop with no recorded position still depends on the coarse floors.
      evictionReFold.markFloors(
        mergeCursor,
        deferralBuffersHold() ||
          (rekeyDeps?.pending.dropped.holdsSourceless ?? false) ||
          pendingMemberContent.dropped.holdsSourceless,
      );

      // P-004 + EI-20317490590418053: sample liveness AFTER durable/snapshot
      // seeding, so the detector sees the cursor position the merge will really
      // use. Also expose the pending-work queue built by the same smallest-
      // backlog-first comparator as the merge below. A remote waiting behind an
      // active backlog head is healthy-but-queued, not attached-but-frozen; the
      // registry suppresses only that false frozen axis while preserving its
      // sampling-stale dead-man and no-replicator verdicts.
      const mergeBacklog = [...logs]
        .filter((log) => log.length > (mergeCursor.positions.get(log.keyHex) ?? 0))
        .sort(
          (a, b) =>
            a.length -
            (mergeCursor.positions.get(a.keyHex) ?? 0) -
            (b.length - (mergeCursor.positions.get(b.keyHex) ?? 0)),
        );
      const mergeQueueIndex = new Map(mergeBacklog.map((log, index) => [log.keyHex, index]));
      const mergeQueueHeadKeyHex = mergeBacklog[0]?.keyHex;
      for (const log of rawLogsByKey.values()) {
        if (log.keyHex === ownLog.keyHex) continue;
        try {
          const maybePeers = log as Partial<{ peersCount(): number | undefined }>;
          const livenessPeersCount = typeof maybePeers.peersCount === 'function' ? maybePeers.peersCount() : undefined;
          const livenessMergedPosition = mergeCursor.positions.get(log.keyHex) ?? 0;
          const knownWriterLength = livenessKnownLength(log);
          const queueIndex = mergeQueueIndex.get(log.keyHex);
          sampleReplicationLiveness(
            opts.workspaceId,
            opts.harnessSlug,
            {
              keyHex: log.keyHex,
              knownLength: knownWriterLength,
              localLength: log.length,
              mergedPosition: livenessMergedPosition,
              peersCount: livenessPeersCount,
              swarmConnections: swarmHandle?.liveConnectionCount,
              ...(queueIndex !== undefined ? { mergeQueueIndex: queueIndex, mergeQueueHeadKeyHex } : {}),
            },
            {
              graceMs: REPLICATION_STALL_GRACE_MS,
              connectedNeverReplicatedGraceMs: CONNECTED_NEVER_REPLICATED_GRACE_MS,
              frozenGraceMs: FROZEN_GRACE_MS,
            },
          );
          canonicallySampledLivenessKeys.add(log.keyHex);
          checkRepairConfirmation(log.keyHex, livenessMergedPosition, knownWriterLength, livenessPeersCount);
        } catch {
          // diagnostic-only — swallow
        }
      }

      // EI-79 steady-state skip (cursor form): nothing new past any log's
      // cursor → skip decode/fold/apply entirely. Lengths are post-update()
      // so growth is caught promptly; the cadenced refresh/reverify hooks
      // below still run.
      let changed = false;
      for (const log of logs) {
        if (log.length > (mergeCursor.positions.get(log.keyHex) ?? 0)) {
          changed = true;
          break;
        }
      }
      if (!changed && !memoryReplayCursor) {
        evictionReFold.noteIdle(); // P-522: every log is at its length
        // applyRevocationRefresh + drainReverifyDropQueue already ran at the top
        // of this pass; on the idle tick maybeReverifyAdmitted only re-drains and
        // (cadence permitting) kicks off the LOCKLESS verify — zero I/O here.
        // Isolated (WI-1544): a reverify kick-off failure never aborts the pass.
        markMergeStage('reverify-admitted');
        try {
          await maybeReverifyAdmitted();
        } catch (e) {
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'merge_error',
            `reverify: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        return 0;
      }

      // ── Owner-enforcement seam (plan shared-hive-owner-enforcement-2026-06-19) ──
      // Read the owner-SIGNED Hive policy ONCE per merge pass. This runs only past the
      // !changed guard above (a pass with new content to merge) — an idle / un-policed
      // harness pays NOTHING extra PG-connection overhead (EI-8685: a pass WITH new
      // content still previously paid a full uncached PG round-trip on every single
      // tick, which is exactly the added-per-pass cost the p2p-perf merge.delta-tick
      // regression measured — a policy changes rarely and already tolerates seconds of
      // federation lag, so a short-TTL cache is the right tradeoff here; see
      // getHivePolicyCached's doc comment). The policy is scoped to the Hive home
      // (hiveHomeProjectionSlug rebinds on the joiner re-key; the owner's home harness is
      // its own slug). null ⇒ no policy ⇒ no enforcement.
      // WI-5783 FIX: the enforcement seam used to fall back to bare `opts.harnessSlug`
      // when `hiveHomeProjectionSlug` is undefined — correct for a genuine JOINER
      // (pre-rekey) or the owner's OWN home-scoped boot (where `opts.harnessSlug` IS
      // the home slug), but WRONG for an OWNED hive's MEMBER-scoped boot on the
      // OWNER's own machine (e.g. a from-repo owner also runs a separate boot/merge
      // loop for its member harness, alongside its home-harness boot). That member
      // boot's `opts.harnessSlug` is the MEMBER slug, not the Hive's home/policy slug,
      // so `getHivePolicyCached` silently missed (null) and EN-4/EN-3/EN-2 enforcement
      // no-opped for every op this loop merged — while the owner's home-scoped boot
      // loop, racing the SAME merge, enforced correctly. This is why AK-ban read as
      // flaky (PASS/FAIL alternating on which boot loop happened to apply the probed
      // op first), not a clean always-fails bug — confirmed live via a one-shot
      // [EN-4-TRACE] instrumentation (this fix supersedes it): on A, the
      // harnessSlug='hello-world' (member) boot showed
      // `hiveHomeProjectionSlug=<none> policyScopeSlug=hello-world ownerPolicyNull=true`
      // at the exact moment the harnessSlug='hello-world-pot' (home) boot on the SAME
      // instance correctly showed `policyScopeSlug=hello-world-pot ownerPolicyNull=false
      // bannedGithubIds=["<B>"]` — i.e. two boot loops on ONE process, one policed, one
      // not, for the identical Hive.
      //
      // `resolvedPotHomeSlug` (computed above, WI-2105 REV/WI-559 FED-1) already solves
      // exactly this for the member-content guard: `potHomeSlugForHarness(workspaceId,
      // opts.harnessSlug)` resolves the OWNING hive's home slug for ANY harness — the
      // home boot itself (trivially resolvedPotHomeSlug === opts.harnessSlug), an owned
      // hive's member boot (resolves to the pot/home slug — the fix), a genuine joiner
      // pre-rekey (gated off by `bindingResolvesHiveHomeProjection`, unaffected), and a
      // non-hive harness (undefined, unaffected — falls through to opts.harnessSlug
      // unchanged). Reusing it here closes the admit/apply-style asymmetry the same way
      // WI-559/FED-1 closed it for the content guard: hiveHomeProjectionSlug (joiner
      // rebind) wins when set, else the general hive-home resolution, else this boot's
      // own slug (today's fallback, preserved for the non-hive-peered case).
      const policyScopeSlug = hiveHomeProjectionSlug ?? resolvedPotHomeSlug ?? opts.harnessSlug;
      markMergeStage('hive-policy');
      const ownerPolicy: HivePolicy | null =
        (await getHivePolicyCached(opts.workspaceId, policyScopeSlug).catch(() => null))?.policy ?? null;
      // Compose the single enforcement decorator EXACTLY as policy-admission.ts documents:
      // EN-2 rate (inner) wrapped by EN-4 ban → allowlist → takedown → content (outer),
      // over the CURRENT scopedApply (which `rekey` may have rebound). With no policy this
      // is `scopedApply` itself — byte-for-byte the prior behavior. Author attribution keys
      // off the unforgeable receiver-stamped sourceLogKeyHex via admittedIdentities; an
      // author-dependent rule with an unresolved author fails CLOSED (the wrappers' contract).
      // WI-2039866 (P-004): per-pass dedupe so a multi-million-op replay of a locked-out
      // log bumps each (reason, author, table) witness once per pass, not once per op.
      const policyDropSeen = new Set<string>();
      const enforcedApply = ownerPolicy
        ? makePolicyEnforcedApply({
            currentPolicy: () => ownerPolicy,
            resolveAuthor: (k) => {
              const id = admittedIdentities.get(k);
              return id ? { githubUserId: id.githubUserId, githubUsername: id.githubLogin } : null;
            },
            ownLogKeyHex: ownLog.keyHex,
            isContentTakenDown: (policy, op) => isContentTakenDown(policy, op.hbKey ?? ''),
            // Owner exemption (policy-admission.ts header, WI-2039866): the pot owner's own
            // devices are never locked out of the owner's pot by the membership layers.
            // Joiner side: the source log's device IS the device that vouched this peer in.
            // Owner side (and owner-device ↔ owner-device): the source log is bound to the
            // SAME GitHub identity this peer announces as (`localAnnounceGithubUserId`).
            isOwnerSourceLog: (k) => {
              const id = admittedIdentities.get(k);
              if (!id) return false;
              if (joinedHiveOwnerDevice && id.devicePubkey === joinedHiveOwnerDevice) return true;
              return localAnnounceGithubUserId != null && id.githubUserId === localAnnounceGithubUserId;
            },
            // A policy drop is a visible witness, never a silent cursor advance: one
            // boot-history event + one refused-op counter bump per (reason, author,
            // table) per pass. Best-effort — observability must never abort the merge.
            onDrop: (info) => {
              const key = `${info.reason}|${info.author ?? 'unresolved'}|${info.table ?? '?'}`;
              if (policyDropSeen.has(key)) return;
              policyDropSeen.add(key);
              try {
                recordBootEvent(
                  opts.workspaceId,
                  opts.harnessSlug,
                  'policy_drop',
                  `${info.reason} author=${info.author ?? '<unresolved>'} table=${info.table ?? '?'} scope=${policyScopeSlug}`,
                );
              } catch {
                // observability must never abort the merge pass
              }
              void bumpRefusedOpCounter({
                workspaceId: opts.workspaceId,
                potSlug: policyScopeSlug,
                reason: `policy:${info.reason}`,
              }).catch(() => {});
            },
            apply: makeRateLimitedApply({
              limiter: rateLimiter,
              nicheLimiter: eliteNicheLimiter,
              ownLogKeyHex: ownLog.keyHex,
              resolveAuthorId: (k) => admittedIdentities.get(k)?.githubUserId ?? null,
              currentCaps: () => ownerPolicy.rate ?? null,
              apply: scopedApply,
            }),
          })
        : scopedApply;

      // C-001 re-key decrypt-gate seam (compose contract: findings-EN-4.md). The re-key's
      // epoch DECRYPT-gate, when armed, wraps the enforcement stack OUTERMOST
      // (decrypt → EN-4 → EN-2 → scopedApply) so policy/rate see PLAINTEXT and an
      // undecryptable op — the read-cut — drops before spending rate budget / content checks.
      // OWNERSHIP (op-path division, su-ee7e9 2026-06-19): the re-key lane owns `decryptGate`
      // + flips `rekeyOn` to the papercusp-hive-rekey flag (and may hoist both to boot scope
      // with the epoch-key deps). Identity stub today ⇒ `applyImpl === enforcedApply`,
      // byte-for-byte unchanged. ONE owner per this expression — never raced.
      const durableCursorPositions = (): ReadonlyMap<string, number> => {
        if (!memoryReplayCursor) return mergeCursor.positions;
        const conservative = new Map<string, number>();
        for (const [keyHex, mainPosition] of mergeCursor.positions) {
          conservative.set(keyHex, Math.min(mainPosition, memoryReplayCursor.positions.get(keyHex) ?? 0));
        }
        return conservative;
      };
      // P-008: the snapshot bookkeeping stamped beside those positions. While the
      // WI-3985 replay runs, the durable position is the LOWER of the two cursors,
      // so the resumed reader must owe every set and hole either cursor owes.
      const durableSnapshotMarks = (): Map<string, SnapshotApplyMark> => {
        const marks = snapshotApplyMarks(mergeCursor);
        if (!memoryReplayCursor) return marks;
        for (const [keyHex, mark] of marks) {
          marks.set(keyHex, combineSnapshotApplyMarks(mark, snapshotApplyMarkOf(memoryReplayCursor, keyHex)));
        }
        return marks;
      };
      const persistDurableCursor = (): Promise<void> | undefined =>
        pgMergeCursorStore
          ? persistCursor(
              durableCursorPositions(),
              pgMergeCursorStore,
              currentApplyBinding(),
              new Map<string, MergeApplyFailure>(
                [...(mergeCursor.applyFailures ?? []), ...(memoryReplayCursor?.applyFailures ?? [])]
                  // When both cursors defer the same log, retain the earliest
                  // unresolved operation alongside the conservative position.
                  .sort((a, b) => b[1].position - a[1].position),
              ),
              durableSnapshotMarks(),
            )
          : undefined;

      const mergeOpts = {
        // D-021: route through THIS harness's scoped projection apply, not the
        // global registry (which the last-booted harness would own). EN-4: wrapped by
        // the owner-enforcement seam above (passthrough = scopedApply when no policy); the
        // C-001 re-key decrypt-gate (su-ee7e9) wraps THAT OUTERMOST when armed — built once
        // at boot scope (`rekeyDeps`, null ⇒ enforcedApply byte-for-byte). decrypt → EN-4 →
        // EN-2 → scopedApply, so policy/rate see PLAINTEXT and an undecryptable op (the
        // read-cut / defer) drops before spending rate budget / content checks.
        applyImpl: rekeyDeps ? rekeyDeps.epochGate(enforcedApply) : enforcedApply,
        // p2p-join-catchup-speed-2026-09-23 P-524: when the gate defers an op for want of
        // this device's epoch key, look ahead on that log for the key row and apply it
        // before folding on. A fresh joiner's key row is written at its admission, after
        // the content it unlocks, so without this every row defers until the fold reaches it.
        ...(rekeyDeps?.keySeek ? { keySeek: rekeyDeps.keySeek } : {}),
        // The old per-author cap, reshaped: a per-PASS read budget. A log with
        // more backlog than this advances chunk-by-chunk across the 1Hz poll
        // (≈50k ops/sec/log ingest ceiling) instead of losing its tail (EI-91).
        maxOpsPerPass: MAX_OPS_PER_AUTHOR,
        // WI-2141796: name the cursor OWNER in read-stall / quarantine lines. One
        // log is folded by many harnesses at many positions, so a line naming only
        // the log is ambiguous across all of them (39 cursors on cb54460d98d8).
        cursorLabel: `${opts.workspaceId}/${opts.harnessSlug}`,
        // WI-10003427: the pass watchdog's stall line reads this (describeMergePass).
        progress: mergeProgress,
        // p2p-join-catchup-speed-2026-09-23 P-002 (WI-10002479): look up the stored PG order
        // for each window of upcoming ops so a replayed op strictly older than its row is
        // skipped in memory instead of paying an apply the LWW guard would reject. Reads
        // through the CURRENT scopedApply (rebuilt on rekey). A rig's applyOverride has no
        // projection set, so it keeps today's behavior.
        ...(opts.applyOverride
          ? {}
          : {
              prefetchStoredOrder: (entries: readonly { table: string; key: string }[]) =>
                (scopedApply as HarnessProjectionApply).prefetchStoredOrder(entries),
              // P-528 (D-018 #3): skip a put a later put in the same window supersedes, for
              // the projections that allow it. Measured on P-007 run #7: 62% of a fresh
              // joiner's tail was such puts.
              skipSuperseded: (table: string, hbKey: string) =>
                (scopedApply as HarnessProjectionApply).supersedablePut(table, hbKey),
            }),
        // Surface standing backlog in boot-history (best-effort observability).
        onBacklog: (keyHex: string, position: number, length: number) => {
          try {
            recordBootEvent(
              opts.workspaceId,
              opts.harnessSlug,
              'peer_capped',
              `${keyHex.slice(0, 8)} backlog ${position}/${length}`,
            );
          } catch {
            // observability must never abort the merge pass
          }
        },
        // WI-2105 REV fix (flag-gated, default ON): persist the cursor's per-log
        // positions to PG as the fold advances (persist-after-apply — fired
        // intra-pass so a large-backlog pass that outlasts the 240s watchdog
        // still checkpoints progress). Best-effort: persistCursor's throw is
        // swallowed inside the merge so a failed save can't abort a pass.
        //
        // EI-20453145044075727: ALSO — unconditionally, not gated on
        // pgMergeCursorStore — feed the replication-liveness dead-man sampler
        // an intra-pass heartbeat here. `sampleReplicationLiveness` only runs
        // once per pass, at the top, so a large-backlog pass that legitimately
        // outlasts SAMPLING_STALE_AFTER_MS (60s, far shorter than the 240s
        // watchdog this hook already accounts for above) left both the
        // actively-folding log AND any log merely queued behind it reading
        // sampling_stale for the whole pass, even with the handle healthy and
        // booted. Touching lastSampleMs only (never the replication axes
        // themselves) proves exactly what's needed: the merge loop is still
        // alive and making progress. Best-effort — a touch failure must never
        // abort the merge pass.
        onCursorAdvance: (positions: ReadonlyMap<string, number>) => {
          try {
            touchReplicationLivenessSamples(opts.workspaceId, opts.harnessSlug, positions.keys());
          } catch {
            // diagnostic-only
          }
          return persistDurableCursor();
        },
      };
      // WI-2105 REV acceleration (17c98): fold the log with the SMALLEST remaining
      // backlog first, so a nearly-caught-up REV carrier (the VM member log
      // 60da99e0) reaches tail — and PG-persists — before an orphaned 70k-op log
      // (e06b8704) monopolizes the pre-watchdog window. Fold order is LWW-
      // irrelevant (see the mergeCursor invariant above), so this changes only
      // convergence latency, never the folded result. A shallow copy — the
      // canonical `logs` order (used by the changed-check + snapshot seed) is kept.
      const orderedLogs = [...logs].sort(
        (a, b) =>
          a.length -
          (mergeCursor.positions.get(a.keyHex) ?? 0) -
          (b.length - (mergeCursor.positions.get(b.keyHex) ?? 0)),
      );
      const positionsBeforeFold = new Map(mergeCursor.positions);
      markMergeStage('incremental-merge');
      let result = await mergeAdmittedLogsIncremental(orderedLogs, mergeCursor, mergeOpts);
      // EI-79 step 3 (correctness escape hatch): a TRUNCATED log (length dropped
      // below its cursor — a reset/forked peer log) invalidates the standing fold.
      // Reset the cursor and re-fold all logs from scratch THIS pass (the same
      // response as a log removal). One retry suffices: the reset cursor starts
      // every position at 0, so it can't re-trigger truncation.
      if (result.truncated) {
        try {
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'peer_capped',
            'truncated log → cursor reset + full re-fold',
          );
        } catch {
          // observability must never abort the merge pass
        }
        mergeCursor = createMergeCursor();
        if (memoryReplayCursor) memoryReplayCursor = createMergeCursor();
        pgCursorSeedCache?.invalidate();
        // Reset positions ⇒ orderedLogs is now length-ascending, still a valid
        // fold order (WI-2105 acceleration); reuse it rather than re-sorting.
        markMergeStage('incremental-merge (truncation re-fold)');
        result = await mergeAdmittedLogsIncremental(orderedLogs, mergeCursor, mergeOpts);
      }
      // P-522: whether this pass left every log unable to advance further (the re-fold gate).
      evictionReFold.noteFold(logs, mergeCursor, positionsBeforeFold);
      let { applied } = result;
      const passSkips = (result.supersededSkips ?? 0) + (result.storedOrderSkips ?? 0);
      if (passSkips > 0) {
        foldSkips.superseded += result.supersededSkips ?? 0;
        foldSkips.storedOrder += result.storedOrderSkips ?? 0;
        foldSkips.sinceLog += passSkips;
        const sinceMs = Date.now() - foldSkips.loggedAt;
        if (sinceMs >= 60_000) {
          console.log(
            `[read-merge] [${opts.workspaceId}/${opts.harnessSlug}] fold skips: ${foldSkips.sinceLog} op(s) ` +
              `in the last ${Math.round(sinceMs / 1000)}s; totals superseded=${foldSkips.superseded} (P-528), ` +
              `storedOrder=${foldSkips.storedOrder} (P-002)`,
          );
          foldSkips.sinceLog = 0;
          foldSkips.loggedAt = Date.now();
        }
      }

      // WI-3985 LIVE OFF→ON repair. Run the ordinary main merge first, then
      // incrementally re-read admitted history with a separate cursor. Only the
      // memory table reaches the exact same decrypt/enforcement/scoped apply
      // stack; every unrelated op merely advances the replay cursor. While the
      // replay is active, persist min(main,replay) under the ON binding so a
      // crash resumes conservatively. Once caught up, publish the full main
      // positions and return to the steady-state idle fast path.
      if (memoryReplayCursor) {
        const replayOpts = {
          ...mergeOpts,
          applyImpl: (op: OpEnvelope) =>
            op.table === 'p2p-memories-by-id' ? mergeOpts.applyImpl(op) : Promise.resolve(false),
          onCursorAdvance: () => persistDurableCursor(),
          // P-524: this sink drops every non-memory op, so a seek here could not apply
          // the key row it finds; the main fold's seek supplies the key.
          keySeek: undefined,
        };
        markMergeStage('memory-replay-merge');
        let replayResult = await mergeAdmittedLogsIncremental(orderedLogs, memoryReplayCursor, replayOpts);
        if (replayResult.truncated) {
          memoryReplayCursor = createMergeCursor();
          replayResult = await mergeAdmittedLogsIncremental(orderedLogs, memoryReplayCursor, replayOpts);
        }
        applied += replayResult.applied;
        if (replayResult.caughtUp) {
          memoryReplayCursor = null;
          if (pgMergeCursorStore) {
            await persistCursor(
              mergeCursor.positions,
              pgMergeCursorStore,
              currentApplyBinding(),
              mergeCursor.applyFailures ?? new Map(),
              snapshotApplyMarks(mergeCursor),
            );
          }
        }
      }

      // ── C-001 re-key DRAIN HOOK (su-c2a63) ── A `hive_epoch_keys` row applying THIS pass
      // fired `onEpochKeyApplied` → queued its (hive, epoch). Re-apply the deferred epoch-N
      // content for those epochs (decryptable now the key is local) through THIS pass's
      // applyImpl (decrypt → EN-4 → EN-2 → scopedApply — the same path). No-op when the
      // re-key is off (queue stays empty) or nothing was deferred (the common keys-first
      // ordering). Bounded + non-re-entrant (content ops never fire onEpochKeyApplied). The
      // P-008 witness can't exercise this (it orders keys-first), so without it a REMAINING
      // member that receives content before its key would silently lose it — this is the
      // pre-ship convergence guarantee. Runs inside the serialized merge block.
      if (rekeyDeps && epochDrainQueue.length > 0) {
        // WI-1544 isolation: the pass already merged its ops — a drain failure
        // must not discard that progress via the outer catch (the queue keeps
        // its entries; the next keyed pass re-drains).
        markMergeStage('epoch-content');
        try {
          await drainQueuedEpochContent({
            pending: rekeyDeps.pending,
            drainQueue: epochDrainQueue,
            applyImpl: mergeOpts.applyImpl,
            hasEpochKey: rekeyDeps.hasEpochKey,
          });
        } catch (e) {
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'merge_error',
            `epoch-drain: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // (The periodic own-log compaction is kicked off at the TOP of the pass, before
      // the idle early-return — see `maybeStartOwnCompaction`, WI-10002836.)

      // ── Merge-refresh (D-002): the revocation refresh now runs at the TOP of
      // the pass (G7 fix) — BEFORE the merge set is collected — so a peer revoked
      // via the published list is dropped before its log is read, never getting a
      // final merge of its revoked-era ops. (It used to run only here, after the
      // merge body, which let a `changed` pass ingest those ops before the drop.)
      // Kept inside the serialized merge block, under the merging lock, exactly as
      // before; no re-entrancy into mergeNow.

      // ── Channel-2 re-verify (rev-v2 Component A; P-002): the GitHub I/O runs
      // LOCKLESS. Here, under the merge gate, `maybeReverifyAdmitted` only drains
      // any conclusive-fail drops the off-lock producer enqueued and (cadence
      // permitting, and if no verify is in flight) KICKS OFF the next verify
      // fire-and-forget. It is a no-op kick-off when:
      //   (a) reverifyIntervalMs <= 0 (disabled; tests drive reverifyAdmitted directly), or
      //   (b) the slow cadence hasn't elapsed since the last kick-off.
      // No `verifyBinding` network call ever runs under this lock.
      // Isolated (WI-1544): the pass's `applied` count is already earned —
      // a reverify kick-off failure must not turn it into a merge_error+0.
      markMergeStage('reverify-admitted (post-merge)');
      try {
        await maybeReverifyAdmitted();
      } catch (e) {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'merge_error',
          `reverify: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      return applied;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      recordBootEvent(opts.workspaceId, opts.harnessSlug, 'merge_error', msg);
      // WI-1544: this catch was ring-only (in-memory, lost on restart) — a
      // persistently-throwing pass silently stalled ALL federation with zero
      // serve.log evidence. Mirror to stderr, deduped: log when the message
      // changes or at most once a minute for a repeating one.
      if (msg !== lastMergeErrorMsg || Date.now() - lastMergeErrorLogTs > 60_000) {
        lastMergeErrorMsg = msg;
        lastMergeErrorLogTs = Date.now();

        console.error(
          `[hyperbee-merge] merge pass FAILED harness=${opts.harnessSlug}: ${e instanceof Error ? (e.stack ?? msg) : msg}`,
        );
      }
      return 0;
    } finally {
      // WI-2142064: drain whatever this pass (or an earlier pass that threw before
      // its own drain ran — entries simply carry over) marked dirty. `drain()`
      // never rejects (fail-soft per plan internally), so this can't turn a
      // settled pass into a thrown/masked result; a `finally` guarantees it runs
      // on every exit path (success, early return, or the catch above) without
      // needing to duplicate the call at each one.
      markMergeStage('plan-parts-recompose');
      await planPartsRecomposeBatch.drain();
    }
  }

  // P-066 bootstrap-progress tracker. Polls ownLog.length each second;
  // feeds the BootstrapProgressIndicator via /api/harness/:slug/
  // bootstrap-progress. Cheap; idempotent across reboots (keys by
  // (workspaceId, slug)).
  const progressPoller = startBootstrapProgressPoller({
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    readLength: () => ownLog.length,
  });

  // Initial backfill merge + a polled fallback. On-remote-append merges
  // are driven by `onAnnounce` (4b) calling mergeNow after each admit.
  void mergeNow();
  const mergePollMs = Number.isFinite(opts.mergePollMs as number) ? (opts.mergePollMs as number) : MERGE_POLL_MS;
  /**
   * WI-6324: liveness sampling must not depend on the serialized merge pass
   * completing. A genuinely dead remote can hold that pass inside
   * `core.update()` / bounded per-op reads for longer than the zombie grace;
   * when sampling lived only inside `mergeOnePass`, the first sample opened the
   * connected-never-replicated window and the blocked pass prevented every
   * subsequent sample, so the detector could never mature and fire the repair
   * that would unblock it.
   *
   * Reuse the existing merge cadence and the same replication-liveness registry
   * + repair handler. This is deliberately a cheap, synchronous observation of
   * already-open logs (no update/get/network I/O) and does not touch the merge
   * cursor or apply path. The in-pass sample remains richer (queue position and
   * post-update lengths); this independent sample is the dead-man path that
   * keeps the detector alive while that pass is wedged.
   */
  const sampleAdmittedLivenessOutsideMerge = (): void => {
    if (stopped) return;
    for (const log of admitted.values()) {
      if (log.keyHex === ownLog.keyHex) continue;
      if (!canonicallySampledLivenessKeys.has(log.keyHex)) continue;
      try {
        const maybePeers = log as Partial<{ peersCount(): number | undefined }>;
        const peersCount = typeof maybePeers.peersCount === 'function' ? maybePeers.peersCount() : undefined;
        sampleReplicationLiveness(
          opts.workspaceId,
          opts.harnessSlug,
          {
            keyHex: log.keyHex,
            knownLength: livenessKnownLength(log),
            localLength: log.length,
            mergedPosition: mergeCursor.positions.get(log.keyHex) ?? 0,
            peersCount,
            swarmConnections: swarmHandle?.liveConnectionCount,
          },
          {
            graceMs: REPLICATION_STALL_GRACE_MS,
            connectedNeverReplicatedGraceMs: CONNECTED_NEVER_REPLICATED_GRACE_MS,
            frozenGraceMs: FROZEN_GRACE_MS,
          },
        );
      } catch {
        // Diagnostic/repair sampling must never interrupt the booted handle.
      }
    }
  };
  // Poll-driven merge cadence. The revocation refresh now runs INSIDE mergeNow
  // under the merging lock (see above), so the poll-timer callback only needs
  // to call mergeNow() — no separate out-of-lock refresh here.
  const mergeTimer =
    mergePollMs > 0
      ? managedSetInterval(
          'hyperbee-merge-poll',
          mergePollMs,
          async () => {
            await mergeNow();
          },
          { category: 'lifecycle', instanced: true },
        )
      : null;
  const livenessTimer =
    mergePollMs > 0
      ? managedSetInterval('hyperbee-replication-liveness-poll', mergePollMs, sampleAdmittedLivenessOutsideMerge, {
          category: 'lifecycle',
          instanced: true,
          allowInTest: opts.allowReplicationLivenessTimerInTest,
        })
      : null;

  // ── Read-admission decider (4c) ── the D-004 + D-002 sig+binding decision
  // applied to an inbound announce. verifyBinding wires the write-free adapter
  // (verifyAttestation over the announce's attestation gist id — gists are
  // public, so no shared-repo context / gh-token is needed). Returns 3-state
  // 'verified'|'pending'|'fail'. Fail-closed: a missing/forged gist admits
  // nothing, so only the own log is merged.
  const admit = makeAdmissionDecider({
    // Reuse the same `verifyBinding` adapter captured above for the re-verify
    // path — one adapter instance shared by admission and re-verify (so the
    // override seam in tests is a single assignment that affects both).
    verifyBinding,
    // D-004: the live revocation set. The decider checks it FIRST (a revoked
    // pubkey is denied regardless of sig/binding), so a revoked peer's
    // re-announce is refused with reason 'revoked'. The set is mutated by
    // `revoke()` below; the decider closes over the same Set instance.
    revoked,
  });

  // D-002 P-001: the same-hive membership lookup (test seam or real resolveHiveMemberDeviceSet).
  // Returns ALL device pubkeys for the hive — no github_user_id (D-002: admit by AUTHOR IDENTITY).
  // Never throws (fail-closed to empty set → not-a-member → buffer).
  const loadHiveMembers: (potHomeSlug: string) => Promise<string[]> =
    opts.loadHiveMembersOverride ??
    (async (potHomeSlug) => {
      const { resolveHiveMemberDeviceSet } = await loadHiveMemberIdentitySetModule();
      const set = await resolveHiveMemberDeviceSet(opts.workspaceId, potHomeSlug).catch(() => new Set<string>());
      return [...set];
    });

  // WI-787 / WI-780 — owner-log BOOTSTRAP seam: resolve the OWNER device pubkey the SIGNED,
  // gh-verified hive-announce binds to a joined `hive_pubkey` (`owner_device_pubkey`,
  // captured at join from the verified directory descriptor and persisted on
  // `harness_shared.pots`). Used ONLY by the owner-bootstrap admit in resolveSameHiveMember.
  // Fail-closed to null (no bootstrap) on any error — never throws into the swarm handler.
  const ownerDeviceForHive: (hivePubkey: string) => Promise<string | null> =
    opts.ownerDeviceForHiveOverride ??
    (async (hivePubkey) => {
      const { loadHiveOwnerDevicePubkey } = await loadHiveMembershipStoreModule();
      return loadHiveOwnerDevicePubkey(opts.workspaceId, hivePubkey).catch(() => null);
    });

  // D-053 — owner-bootstrap for a TOPIC-bound joiner. A real invite/link joiner boots on a
  // `{ kind:'topic', topic_hex }` binding (boot-all.ts defaultResolveSwarmBinding step 2: it
  // learns the Hive's TOPIC HASH from the link, NOT its pubkey, so it cannot rebuild a `hive:`
  // binding) — so `opts.swarmBinding.hive_pubkey` is ABSENT and the by-pubkey owner-bootstrap
  // (gated on `kind==='hive'`) never fires, leaving an empty-roster joiner unable to admit the
  // owner (the live cross-machine RECEIVE-side blocker: 0 roster / 0 epoch / 0 content). Recover
  // the bound hive's pubkey from the VERIFIED hive-directory cache by deriving each cached hive's
  // topic and matching `topic_hex`, then return that descriptor's owner device. Same one-device
  // guarantee as `ownerDeviceForHive`; fail-closed to null. The directory only records
  // descriptors that passed `verifyHiveAnnounce`, so the binding is cryptographically verified.
  const ownerDeviceForTopic: (topicHex: string) => Promise<string | null> =
    opts.ownerDeviceForTopicOverride ??
    (async (topicHex) => {
      const want = topicHex.toLowerCase();
      const { loadHiveOwnerDeviceBindings } = await loadHiveMembershipStoreModule();
      const bindings = await loadHiveOwnerDeviceBindings(opts.workspaceId).catch(() => []);
      for (const b of bindings) {
        let derived: string;
        try {
          derived = deriveSwarmTopic({ kind: 'hive', hive_pubkey: b.hivePubkey }).toString('hex').toLowerCase();
        } catch {
          continue; // a malformed cached pubkey can't derive a topic — skip it
        }
        if (derived === want) return b.ownerDevicePubkey;
      }
      return null;
    });

  // D-053 — resolve the owner device to bootstrap-admit for the CURRENTLY-JOINED hive,
  // regardless of the binding KIND: a `hive` binding carries the pubkey directly; a `topic`
  // binding (the invite/link joiner) recovers it from the directory cache by topic match. Used
  // by BOTH owner-bootstrap sites (admitsAsKnownHiveMember + resolveSameHiveMember) so they
  // can't drift. Returns null for a non-hive/non-topic binding (no hive to bootstrap).
  const resolveJoinedHiveOwnerDevice = async (): Promise<string | null> => {
    // WI-1544 defect D: read the CURRENT binding (rekey() updates it), not the
    // boot-time opts snapshot — post-rekey the owner lookup must key off the
    // NEW hive/topic or the bootstrap-admit vouches for the wrong hive.
    const binding = currentBinding;
    if (!binding) {
      joinedHiveOwnerDevice = null;
      return null;
    }
    const resolved =
      binding.kind === 'hive'
        ? await ownerDeviceForHive(binding.hive_pubkey).catch(() => null)
        : binding.kind === 'topic'
          ? await ownerDeviceForTopic(binding.topic_hex).catch(() => null)
          : null;
    joinedHiveOwnerDevice = resolved;
    // A→B owner-admit diagnostic (PAPERCUSP_A003_TRACE, off by default/in tests): did the
    // directory cache resolve the joined hive's owner device? `<null>` here is the live A→B
    // root — the owner-bootstrap admit + the roster member-set both depend on this resolving.
    if (process.env.PAPERCUSP_A003_TRACE === '1') {
      console.error(
        `[A-003] ${new Date().toISOString()} owner-resolve ${opts.harnessSlug}: binding.kind=${binding.kind} ` +
          `${binding.kind === 'hive' ? `hive_pubkey=${binding.hive_pubkey.slice(0, 10)}` : binding.kind === 'topic' ? `topic=${binding.topic_hex.slice(0, 12)}` : ''} ` +
          `→ ownerDevice=${resolved ? resolved.slice(0, 10) : '<null>'}`,
      );
    }
    return resolved;
  };

  /**
   * Admit (or reject) an inbound signed announce. Verifies the sig, runs the
   * D-004 + D-002 decision, and on admit opens + admits the peer's remote log
   * and merges. On 'pending', stores the peer for retry (D-006). Defensive:
   * never throws into the swarm handler.
   */
  // P-004: best-effort telemetry sink for conclusive admission rejections.
  // Defaults to enqueuing a diagnostic report (flushTelemetry forwards it to
  // PostHog when the user has opted in); never awaited and never throws, so it
  // can't add latency to or fail the admission path. Tests inject a capturing
  // override.
  const emitTelemetry: (kind: TelemetryKind, payload: Record<string, unknown>) => void =
    opts.recordTelemetryOverride ??
    ((kind, payload) => {
      void recordTelemetryReport({ kind, payload }).catch(() => {});
    });

  // WI-559: the same-hive cross-member SCOPE decision, SHARED by onAnnounce + retryPendingOnce so
  // the two paths can't drift. Precondition: the IDENTITY decider `admit()` has ALREADY passed for
  // this frame (sig + channel-2 binding valid, NOT revoked — revoked is checked FIRST, every call,
  // incl. each retry tick). This only widens SCOPE (slug → identity-membership); it NEVER bypasses
  // revocation or the read-cut. An out-of-own-scope frame is admitted iff its github_user_id is a
  // member of THIS harness's hive AND its device is one of that member's REGISTERED pubkeys. If we
  // have a hive home but that membership has NOT federated to us yet — the asymmetric A→B stall: B
  // permanently DROPS A's writer core because announces are not re-delivered and B's hive_members
  // lacked A at announce time — BUFFER the frame for retry instead of conclusively rejecting. The
  // 5s retry loop re-runs admit() (revoked re-checked) + this check each tick and admits the instant
  // A federates in, or drops it after the 30-min grace. So a REVOKED / READ-CUT peer can NEVER be
  // admitted via this buffer: admit() refuses it first on every retry, keeping the C-001 read cut
  // intact (shared-hive-rekey). Returns the AdmissionResult to RETURN (admit, or pending-buffered),
  // or null when this is not a same-hive-member candidate (caller falls through to A-003 / conclusive).
  async function resolveSameHiveMember(
    frame: SignedAnnounce,
    channel2Verified: boolean,
  ): Promise<AdmissionResult | null> {
    const originSlug = frame.harness_slug ?? null;
    if (!(originSlug != null && originSlug !== slug)) return null;
    const { potHomeSlugForHarness } = await loadHiveFederationModule();
    const myHiveHome =
      hiveHomeProjectionSlug ?? (await potHomeSlugForHarness(opts.workspaceId, opts.harnessSlug).catch(() => null));
    if (myHiveHome == null) return null;
    // WI-787 / WI-780 — owner-log BOOTSTRAP admission (the keystone). A fresh joiner's
    // hive_members is EMPTY, so the OWNER's own announce 'miss'es below and buffers
    // forever — yet the roster that would admit the owner lives INSIDE the owner's
    // still-un-merged log (bootstrap deadlock). Break it by trusting the ONE device the
    // SIGNED, gh-verified hive-announce binds to THIS joined hive: its owner_device_pubkey.
    // Admit ONLY that exact device, gated on the frame's joined hive
    // (swarmBinding.hive_pubkey) — never on github_user_id alone and never any OTHER device
    // (that would hole the WI-259 membership guard). The IDENTITY decider (sig + channel-2
    // binding) has already passed for this frame upstream, so the device is gh-attested too.
    // D-053: resolve the joined hive's owner device for BOTH binding kinds (a topic-bound
    // invite/link joiner has no `hive_pubkey` — recover it from the directory cache by topic).
    const ownerDevice = await resolveJoinedHiveOwnerDevice();
    if (ownerDevice && frame.device_pubkey === ownerDevice) {
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'announce_admitted',
        `owner_bootstrap hive=${myHiveHome} ${peerLabel(frame.log_core_key)}`,
      );
      return admitPeer(frame, channel2Verified);
    }
    const memberDevices = await loadHiveMembers(myHiveHome);
    const isKnownMember = memberDevices.includes(frame.device_pubkey);
    // D-023 BUG C owner-gate: on a membership MISS, am I the OWNER of this hive (hold its private
    // key)? The owner must ADMIT a verified brand-new joiner (whose member slug is out of our
    // home-slug scope) instead of buffering it, else admitAnnouncedPeerAsOwner (the upsert seam)
    // never runs and the open-mode auto-admission deadlocks. Resolved ONLY
    // on a miss (skip the keychain read on the common already-a-member path).
    // WI-1981 wake-#5515: canonical ownership (held key MATCHES the hives-row / registry
    // pubkey), not mere key presence — a divergent local key must not make this box
    // admit joiners as if it were the owner.
    const isOwner =
      !isKnownMember &&
      (await loadHiveIdentityModule()
        .then((m) => m.isCanonicalHiveOwner(opts.workspaceId, myHiveHome))
        .catch(() => false));
    const decision = classifySameHiveMember({
      originSlug,
      ownSlug: slug,
      hiveHome: myHiveHome,
      devicePubkey: frame.device_pubkey,
      memberDevices,
      isOwner,
    });
    if (decision === 'admit') {
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'announce_admitted',
        `${isKnownMember ? 'same_hive_member' : 'owner_admit_joiner'} origin=${originSlug} hive=${myHiveHome} ${peerLabel(frame.log_core_key)}`,
      );
      return admitPeer(frame, channel2Verified);
    }
    // decision === 'miss' here (the pre-checks above already returned null for 'not-candidate').
    // MEMBERSHIP-MISS (WI-559) — plausible same-hive cross-member whose hive_members row has not
    // federated to us yet → BUFFER for retry instead of a conclusive drop. Idempotent: a no-op when
    // already pending (preserving its grace clock), and the boot event is recorded ONLY on the first
    // buffering so the 5s retry re-checks don't spam the log.
    if (!pendingPeers.has(frame.log_core_key)) {
      pendingPeers.set(frame.log_core_key, { frame, since: Date.now() });
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'announce_pending',
        `membership_miss origin=${originSlug} hive=${myHiveHome} ${peerLabel(frame.log_core_key)}`,
      );
    }
    return { admit: false, reason: 'pending' };
  }

  async function admitsAsKnownHiveMember(frame: SignedAnnounce, sigValid: boolean): Promise<boolean> {
    if (!sigValid || revoked.has(frame.device_pubkey)) return false;
    // WI-797 — owner-log BOOTSTRAP at the IDENTITY stage (the keystone's missing half),
    // HOISTED ABOVE the `myHiveHome == null` gate (recv-but-no-admit-during-rekey fix; the
    // live-pinned A→B blocker). A fresh joiner's hive_members is EMPTY, so the OWNER's own
    // announce fails the gist-binding gate (`admit()` → 'binding_invalid' whenever the owner's
    // live attestation gist is unresolvable in the fresh-join window) and is CONCLUSIVELY
    // rejected in `onAnnounce` BEFORE `resolveSameHiveMember`'s owner-bootstrap (which only
    // runs AFTER a positive identity decision) can ever rescue it — the bootstrap deadlock the
    // A1 keystone (WI-787) was supposed to break. Admit the ONE directory-verified owner device
    // of the JOINED hive here, bypassing the gist gate.
    //
    // WHY ABOVE THE GATE: a fresh joiner boots home=<none> (its hive-home SLUG resolves only at
    // the 2c rekey), and the owner's announce arrives in that window. `resolveJoinedHiveOwnerDevice`
    // resolves the owner device from the swarm BINDING (`hive_pubkey` / `topic_hex`) + the seeded
    // directory cache — it does NOT need the resolved hive-home slug — so gating it behind
    // `myHiveHome != null` (the prior bug) DROPPED the owner frame (→ binding_invalid → conclusive
    // reject, NOT buffered), leaving the rekey replay nothing to re-drive → A→B never federated
    // (live-pinned via announce-debug: B RECEIVES A's owner announce but processes it at home=<none>).
    // Running the bootstrap FIRST lets the owner frame pass IDENTITY at home=<none> → the A-003
    // `scope_unresolved` buffer in `onAnnounce` holds it → `retryPendingOnce` (which re-runs THIS
    // fn) admits it once the rekey resolves the home.
    //
    // Identical cryptographic guarantee as the `resolveSameHiveMember` copy — the
    // `(hive_pubkey → owner_device_pubkey)` binding read by `ownerDeviceForHive`/`ownerDeviceForTopic`
    // comes from the offline hive-directory cache, which only records descriptors that passed
    // `verifyHiveAnnounce` (Ed25519 sig + the owner_device↔hive_pubkey binding). Strictly the ONE
    // bound owner device; `sigValid` is already checked above; never widens to github_user_id alone
    // or any other device (that would hole the WI-259 membership guard). D-053: BOTH binding kinds
    // (a topic-bound invite/link joiner has no `hive_pubkey` — recover it from the cache by topic).
    const ownerDevice = await resolveJoinedHiveOwnerDevice();
    // A→B owner-admit diagnostic (PAPERCUSP_A003_TRACE): did the IDENTITY-stage owner-bootstrap
    // fire + match this frame's device? match=true ⇒ B admits the owner log (the keystone);
    // match=false with ownerDevice=<null> ⇒ cache didn't resolve the owner (the live A→B root).
    if (process.env.PAPERCUSP_A003_TRACE === '1') {
      console.error(
        `[A-003] ${new Date().toISOString()} owner-admit ${opts.harnessSlug}: ownerDevice=${ownerDevice ? ownerDevice.slice(0, 10) : '<null>'} ` +
          `frame.device=${frame.device_pubkey.slice(0, 10)} match=${!!(ownerDevice && frame.device_pubkey === ownerDevice)}`,
      );
    }
    if (ownerDevice && frame.device_pubkey === ownerDevice) return true;
    // Member admission (below) needs the resolved hive-home slug — resolve it AFTER the
    // binding-only owner-bootstrap above, so a home=<none> joiner still bootstrap-admits the owner.
    const { potHomeSlugForHarness } = await loadHiveFederationModule();
    const myHiveHome =
      hiveHomeProjectionSlug ?? (await potHomeSlugForHarness(opts.workspaceId, opts.harnessSlug).catch(() => null));
    if (myHiveHome == null) return false;
    const memberDevices = await loadHiveMembers(myHiveHome);
    return trustedHiveMemberDeviceAdmission({
      devicePubkey: frame.device_pubkey,
      sigValid,
      memberDevices,
      revoked,
    });
  }

  // WI-1544 (round-1 live REJECT) — is this boot still inside its hive-JOIN bootstrap window?
  // True for a JOINER boot (a `hive`/`topic` swarm binding — an invite/link joiner) during the
  // bounded interval after joinForBinding starts. The home may already be resolved by the time
  // the first announce arrives (WI-38344), so home-null is not a safe proxy for this phase. Inside this
  // window an identity-stage `binding_invalid` is NOT conclusive: the owner's log announce
  // races the hive-directory descriptor + the rekey by milliseconds, so the gist gate can
  // conclusively 'fail' BEFORE the verified owner-device binding (resolveJoinedHiveOwnerDevice)
  // or the federated roster can vouch for the frame — and announces are never re-delivered,
  // so a conclusive reject here is a PERMANENT A→B stall. Live-pinned on the WI-1544
  // Docker-frames rig: recv → owner-resolve=<null> (directory not yet populated) →
  // binding_invalid → dropped; the rekey resolved moments later with nothing left to replay.
  // Buffering instead admits NOTHING by itself: the frame still has to pass
  // admitsAsKnownHiveMember / admit() on a retry tick (revocation re-checked every tick),
  // and BOOT_PENDING_GRACE_MS caps the buffer. bad_sig / revoked stay conclusive always.
  // A standalone (non-joiner) boot never enters this window, keeping conclusive-reject
  // observability for genuinely foreign frames.
  const inJoinBootstrapWindow = (): boolean => {
    if (joinBootstrapStartedAt == null) return false;
    const elapsedMs = Date.now() - joinBootstrapStartedAt;
    return (
      elapsedMs >= 0 &&
      elapsedMs <= BOOT_PENDING_GRACE_MS &&
      joinedHiveOwnerDevice == null &&
      (currentBinding?.kind === 'hive' || currentBinding?.kind === 'topic')
    );
  };

  /**
   * P-504 / WI-2141185 — IDEMPOTENT RE-ADMISSION.
   *
   * A peer re-sends its signed announce on every writer-progress tick
   * (`refreshAnnounce`, 25 ms debounce) and on every re-pair, and the shared
   * swarm socket fans each received frame out to EVERY local harness entry on
   * the topic (~38 on the tower). Running the full admission path again for a
   * peer that is ALREADY admitted under the SAME identity costs, per harness
   * per frame: a hive-members PG read (`loadHiveMembers`), a boot-history PG
   * insert + mirrored log line (`announce_admitted … same_hive_member`), and a
   * merge poke. Measured 2026-09-02 on the tower: 35k announce_admitted lines/min,
   * PG pool starvation, +100 MB RSS/min and three V8 OOM aborts.
   *
   * Such a frame is a presence/progress poke, not a new admission: once the
   * signature verifies (cheap, in-process) it is answered `admit` without
   * touching PG, the boot history, or the merge gate. Remote appends still
   * reach us via hypercore replication + the periodic merge poll, and
   * revocation still lands via `revoke()` (explicit, immediate) and the
   * periodic `reverifyAdmitted` sweep — the incidental per-announce membership
   * re-read this replaces was never the designed revocation path. ANY identity
   * change (device, login, user id, attestation) or a revoked device falls
   * through to the full path, which is what decides what to do about it.
   */
  function isSameIdentityReannounce(frame: SignedAnnounce): boolean {
    if (!admitted.has(frame.log_core_key)) return false;
    const prior = admittedIdentities.get(frame.log_core_key);
    if (!prior) return false;
    if (revoked.has(frame.device_pubkey)) return false;
    return (
      prior.devicePubkey === frame.device_pubkey &&
      prior.githubLogin === frame.github_login &&
      prior.githubUserId === frame.github_user_id &&
      prior.attestationGistId === frame.attestation_gist_id
    );
  }
  let reannouncesSuppressed = 0;
  const REANNOUNCE_SUPPRESSION_LOG_EVERY = 5000;
  function noteSuppressedReannounce(frame: SignedAnnounce): void {
    reannouncesSuppressed++;
    // Bounded observability: one line on the first suppression and one per
    // 5,000 thereafter — never one per frame (a per-frame line IS the flood).
    if (reannouncesSuppressed === 1 || reannouncesSuppressed % REANNOUNCE_SUPPRESSION_LOG_EVERY === 0) {
      console.log(
        `[boot] re-announce suppressed (already admitted, same identity; P-504) harness=${opts.harnessSlug} ` +
          `count=${reannouncesSuppressed} ${peerLabel(frame.log_core_key)}`,
      );
    }
  }

  async function onAnnounce(frame: SignedAnnounce): Promise<AdmissionResult> {
    let decision: AdmissionResult;
    let channel2Verified = true;
    try {
      const verifyResult = verifyAnnounceDetailed(frame);
      const sigValid = verifyResult.ok;
      // WI-1662: a stale_ts rejection means the sig itself is VALID but the sender's
      // clock is >5min off — record this distinctly (alongside the announce_rejected
      // this frame still gets below) so it doesn't read identically to a forged sig.
      if (verifyResult.reason === 'stale_ts') {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_clock_skew',
          `peer clock >5min off this machine — check clock/NTP ${peerLabel(frame.log_core_key)}`,
        );
      }
      // P-504: a same-identity re-announce from an already-admitted peer is a
      // poke, not an admission — answer it without PG, boot history, or a merge.
      // WI-10002600: unless it carries a supersession this node has not applied yet.
      if (sigValid && isSameIdentityReannounce(frame) && !carriesUnappliedSupersession(frame)) {
        noteSuppressedReannounce(frame);
        return { admit: true };
      }
      const input: AdmissionInput = {
        device_pubkey: frame.device_pubkey,
        github_login: frame.github_login,
        github_user_id: frame.github_user_id,
        attestation_gist_id: frame.attestation_gist_id,
        sigValid,
      };
      const admittedByKnownMember = await admitsAsKnownHiveMember(frame, sigValid);
      channel2Verified = !admittedByKnownMember;
      decision = admittedByKnownMember ? { admit: true } : await admit(input);
    } catch (e) {
      recordBootEvent(opts.workspaceId, opts.harnessSlug, 'announce_error', e instanceof Error ? e.message : String(e));
      return { admit: false, reason: 'binding_invalid' };
    }
    if (!decision.admit) {
      // WI-1544: inside the join-bootstrap window a conclusive `binding_invalid` is
      // reclassified as RETRYABLE — buffered for the rekey replay / retry tick (see
      // inJoinBootstrapWindow above). Distinct label so a live grep can tell this buffer
      // from the D-006 gist-propagation 'pending'.
      if (decision.reason === 'binding_invalid' && inJoinBootstrapWindow()) {
        if (!pendingPeers.has(frame.log_core_key)) {
          pendingPeers.set(frame.log_core_key, { frame, since: Date.now() });
        }
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_pending',
          `binding_unverified_window ${peerLabel(frame.log_core_key)}`,
        );
        if (process.env.PAPERCUSP_A003_TRACE === '1') {
          console.error(
            `[A-003] ${new Date().toISOString()} reclassify ${opts.harnessSlug}: binding_invalid → pending (join window, home=<none>) peer=${peerLabel(frame.log_core_key)} ` +
              `device=${frame.device_pubkey.slice(0, 10)} gh=${frame.github_login}/${frame.github_user_id} gist=${frame.attestation_gist_id || '<empty>'}`,
          );
        }
        return { admit: false, reason: 'pending' };
      }
      if (decision.reason === 'pending') {
        // D-006: channel-2 file not yet visible on GitHub. Store this peer for
        // retry within the boot grace window; do NOT permanently reject.
        if (!pendingPeers.has(frame.log_core_key)) {
          pendingPeers.set(frame.log_core_key, { frame, since: Date.now() });
        }
        recordBootEvent(opts.workspaceId, opts.harnessSlug, 'announce_pending', peerLabel(frame.log_core_key));
      } else {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_rejected',
          `${decision.reason} ${peerLabel(frame.log_core_key)}`,
        );
        // P-004: forward the rejection to the diagnostic-telemetry pipeline
        // (PostHog when opted in) — a fleet-health signal for canonicalisation
        // drift / stale revocation / forgery attempts. Truncated peer label only.
        emitTelemetry(TELEMETRY_KINDS.substrate_admission_rejected, {
          harness_slug: opts.harnessSlug,
          reason: decision.reason,
          peer: peerLabel(frame.log_core_key),
        });
      }
      return decision;
    }
    // A-003 (a′): slug-aware admission scope. The decider above is IDENTITY-only
    // (sig + channel-2 binding + revocation) and every harness registers ALL
    // projections — so on a topic carrying MULTIPLE local harnesses' log announces
    // (dc9db's (a′) swarm.ts: the hive-home log broadcast alongside a member's on
    // the one channel), an identity-valid frame for ANOTHER harness's scope would
    // be admitted + cross-merged (e.g. the OWNER's hive-home harness applying a
    // member-log's features into the hive-home schema = pollution). The frame
    // carries a SIGNED `harness_slug`; admit a remote log ONLY into the harness
    // scope that should hold it: this harness's OWN slug, OR — for a JOINER's
    // member harness — the hive-home slug it rebinds (`hiveHomeProjectionSlug` =
    // joinerPotHomeSlug(self), the receive-side rebind; live across rekey). ABSENT
    // (legacy / single-harness peer) → admit (backward-compatible: the field
    // post-dates single-harness federation + the two-hive integration test).
    const originSlug = frame.harness_slug ?? null;
    const inScope = announceSlugInScope(originSlug, slug, hiveHomeProjectionSlug);
    // A-003 diagnostic (env-gated): the per-frame slug-filter decision — so a live
    // witness can grep `[A-003] slug-filter` to see whether a joiner's member harness
    // ADMITS the owner's hive-home log (origin=<hive-home> → ADMIT requires
    // home=<hive-home>, i.e. the rebind resolved) or REJECTs it. Each line now carries
    // an ISO wall-clock timestamp right after the `[A-003]` tag for cross-frame
    // timeline correlation.
    if (process.env.PAPERCUSP_A003_TRACE === '1') {
      console.error(
        `[A-003] ${new Date().toISOString()} slug-filter ${opts.harnessSlug}: origin=${originSlug ?? '<none>'} own=${slug} ` +
          `home=${hiveHomeProjectionSlug ?? '<none>'} → ${inScope ? 'ADMIT' : 'REJECT'} ` +
          `peer=${peerLabel(frame.log_core_key)}`,
      );
    }
    if (!inScope) {
      // WI-259 STEP 1 + WI-559: a SAME-HIVE cross-member log is admitted by VERIFIED IDENTITY
      // (github_user_id ∈ this hive's members AND device registered), even when its signed slug is
      // out of this harness's own/rebind scope — `hive_members` is federated (P-006) where the
      // per-workspace `harness_registry` is not. SAFETY: this only lets the member's LOG replicate;
      // every projection's apply drops a wrong-slug op, so cross-member CONTENT does not land in PG
      // until WI-259 STEP 2 opts it in. Ordered BEFORE the A-003 buffer so a member log is admitted
      // immediately. On a membership-MISS (hive home resolved but not yet federated A in) the helper
      // BUFFERS for retry rather than letting the frame fall through to a conclusive drop (the WI-559
      // asymmetric-stall fix). Shared with retryPendingOnce so the decision can't drift.
      const sameHive = await resolveSameHiveMember(frame, channel2Verified);
      if (sameHive) return sameHive;
      // A-003 fix: the slug scope can be UNRESOLVED at admit time. A joiner's member
      // harness only learns its hive-home slug at the 2c re-key (`hiveHomeProjectionSlug`
      // is set by `rekey`'s rebind, AFTER boot opens the topic + onAnnounce goes live).
      // If the owner's hive-home log announce races in during that `home=<none>` window,
      // a CONCLUSIVE out-of-scope reject would drop it permanently (announces are not
      // re-delivered) → the hive-home log never federates (the live-RED bug the witness
      // caught). So: while home is UNRESOLVED and the origin is some OTHER harness's slug
      // (a hive-home candidate that the pending rebind may bring in-scope), buffer the
      // frame for retry instead of rejecting — `retryPendingOnce` re-checks the slug
      // scope against the now-resolved `hiveHomeProjectionSlug` and admits iff in-scope.
      // Once home IS resolved, an out-of-scope frame is genuinely foreign → conclusive.
      if (hiveHomeProjectionSlug == null && originSlug != null && originSlug !== slug) {
        if (!pendingPeers.has(frame.log_core_key)) {
          pendingPeers.set(frame.log_core_key, { frame, since: Date.now() });
        }
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_pending',
          `scope_unresolved origin=${originSlug} own=${slug} ${peerLabel(frame.log_core_key)}`,
        );
        return { admit: false, reason: 'pending' };
      }
      // The NORMAL broadcast-filtering outcome (one topic, many harnesses) — not an
      // alarm. Recorded for observability; NOT forwarded to the admission-rejection
      // telemetry (it is not a forgery / binding failure). Conclusive (never retried).
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'announce_rejected',
        `out-of-scope origin=${originSlug} own=${slug} ${peerLabel(frame.log_core_key)}`,
      );
      return { admit: false, reason: 'out_of_scope' };
    }
    return admitPeer(frame, channel2Verified);
  }

  /**
   * Queue + admit a peer's remote log and trigger a merge. The map mutations
   * (admitted/pubkeyToLogKeys/admittedIdentities) happen inside the merge gate
   * (drainAdmissionQueue) so an in-flight pass never races them, and the
   * coalescing mergeNow guarantees the admission is processed before the
   * returned promise resolves (audit P-022). Extracted so the pending-retry
   * path uses the same logic as the initial admit path.
   */
  async function admitPeer(frame: SignedAnnounce, channel2Verified: boolean): Promise<AdmissionResult> {
    admissionQueue.push({ frame, channel2Verified });
    // WI-10003427: an admission decided here only LANDS when a merge pass drains the
    // queue. If that pass is wedged, this await never settles and the peer is silently
    // never admitted (no announce_admitted/rejected/pending). Name the blocker loudly.
    const queuedAt = Date.now();
    const waitTimer =
      mergePassStallMs > 0
        ? setTimeout(() => {
            const msg =
              `${peerLabel(frame.log_core_key)} identity-admitted but queued ` +
              `${Math.round((Date.now() - queuedAt) / 1000)}s with no drain — blocked behind merge ${describeMergePass()}`;
            recordBootEvent(opts.workspaceId, opts.harnessSlug, 'announce_admission_stalled', msg);
            console.error(`[boot] ADMISSION STALL harness=${opts.harnessSlug} ${msg}`);
          }, mergePassStallMs)
        : null;
    waitTimer?.unref?.();
    try {
      await mergeNow();
    } finally {
      if (waitTimer) clearTimeout(waitTimer);
    }
    return { admit: true };
  }

  /**
   * Revoke a device pubkey (D-004). Adds it to the `revoked` set (so a future
   * announce is refused), drops all of its admitted logs (so the next merge
   * stops reading them), drops it from the pending-retry set (D-006: a revoked peer
   * must never be retried), and re-merges so the removal takes effect immediately.
   * Best-effort + idempotent: an unknown / already-revoked pubkey still gets
   * added to `revoked` (a no-op for the set) and skips the log drops.
   */
  async function revoke(devicePubkey: string): Promise<void> {
    // (a) Block future admits + re-announces (decider checks `revoked` first).
    revoked.add(devicePubkey);
    // WI-193 (G8): a LIVE revoke is authoritative — evict from the refresh-sourced
    // provenance set (in case this pubkey was ALREADY refresh-tracked) so a later
    // published-list refresh can never silently reconcile this revoke away.
    revokedViaRefresh.delete(devicePubkey);
    // (a2) Drop ALL of this device's buffered logs from the pending-retry set —
    // a revoked peer must never be retried even if its channel-2 file eventually
    // appears.
    purgePendingForDevice(devicePubkey);
    // (b) Drop every already-admitted log for this pubkey, if any. A device can
    // legitimately announce both its member log and the hive-home log.
    const logKeys = [...(pubkeyToLogKeys.get(devicePubkey) ?? [])];
    if (logKeys.length > 0) {
      await persistPeerLifecycle(
        logKeys.map((logKey) => ({
          logKeyHex: logKey,
          devicePubkey,
          state: 'retired' as const,
        })),
        'explicit revoke',
      );
      for (const logKey of logKeys) {
        dropAdmittedRemoteLog(logKey, devicePubkey, 'explicit revoke');
        recordBootEvent(opts.workspaceId, opts.harnessSlug, 'peer_revoked', peerLabel(logKey));
      }
    }
    // (c) Re-merge so the merge set no longer includes the revoked log.
    await mergeNow();
  }

  // ── Pending-peer retry loop (D-006) ── revisits peers that returned
  // 'pending' (channel-2 file not yet visible) at each tick. For each pending
  // peer the decider is re-run with a fresh sig check; on 'verified' the peer
  // is admitted normally; on conclusive failure (binding_invalid/bad_sig/revoked)
  // or once the boot-scoped grace window has passed, the peer is removed
  // (announce_rejected). Each pass handles at most `pendingRetryBatchSize`
  // peers, round-robin by log key, so a large pending set cannot turn the 5s
  // cadence into an unbounded GitHub API sweep. `.unref()`'d so the timer never
  // keeps the process alive and cleared in `close()` alongside the merge timer.
  //
  // RE-ENTRANCY (audit P-022): sequential rescheduling, NOT a bare
  // setInterval(async …) — the old interval could fire a second tick while the
  // first still awaited admit()/admitPeer(), double-processing the same
  // pending peers. The next tick now arms only after the current one finishes.
  const pendingRetryMs = Number.isFinite(opts.pendingRetryMs as number)
    ? (opts.pendingRetryMs as number)
    : DEFAULT_PENDING_RETRY_MS;
  // Keep the 5s retry cadence useful for small pending sets while bounding the
  // API rate for large sets. A non-finite / non-positive value is NOT
  // "unbounded" — it falls back to the fixed default, because unbounded is
  // precisely the defect this guard prevents.
  const DEFAULT_PENDING_RETRY_BATCH_SIZE = 4;
  const pendingRetryBatchSize =
    Number.isFinite(opts.pendingRetryBatchSize as number) && (opts.pendingRetryBatchSize as number) > 0
      ? Math.max(1, Math.floor(opts.pendingRetryBatchSize as number))
      : DEFAULT_PENDING_RETRY_BATCH_SIZE;
  /**
   * Round-robin cursor for pending retries. The next pass starts at the
   * smallest pending log key STRICTLY GREATER than this key, wrapping to the
   * smallest key when the tail is exhausted. A key (rather than an index)
   * keeps the walk stable when peers are admitted or removed between passes.
   */
  let pendingRetryCursor: string | null = null;
  const pendingRetrySetTimeout = opts.pendingRetrySetTimeout ?? setTimeout;
  const pendingRetryClearTimeout = opts.pendingRetryClearTimeout ?? clearTimeout;
  let pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;
  // WI-1631: the promise of a CURRENTLY-EXECUTING retry tick, if any. `close()`
  // clearing `pendingRetryTimer` only cancels a still-SCHEDULED timer — a tick
  // that already fired and is mid-`retryPendingOnce()` (e.g. awaiting an
  // openRemoteLog call) keeps running in the background after `close()`
  // resolves, unawaited, and can still hit the tick's own `console.error(...)`
  // calls afterward — racing a caller that restores a `console.error` spy right
  // after `close()` returns (as boot.test.ts's WI-1544 #3 tests do), and
  // tripping vitest-fail-on-console on an already-restored, tracked
  // console.error. `close()` awaits this so no tick can straggle past it.
  let inFlightPendingRetryTick: Promise<void> | null = null;
  // WI-1544: once-per-peer stderr dedup for retry-tick failures (the tick fires
  // every ~5s for up to 30min — one line per peer is signal, 360 are noise).
  const loggedRetryErrorKeys = new Set<string>();
  async function retryPendingOnce(): Promise<void> {
    if (stopped || pendingPeers.size === 0) return;
    const nowMs = Date.now();
    // Snapshot + sort keys to iterate safely while the map mutates and to make
    // the persistent cursor deterministic across peers joining/leaving.
    const keys = [...pendingPeers.keys()].sort();
    if (keys.length === 0) return;
    let startIdx = 0;
    if (pendingRetryCursor !== null) {
      const found = keys.findIndex((logCoreKey) => logCoreKey > pendingRetryCursor!);
      startIdx = found === -1 ? 0 : found;
    }
    const take = Math.min(pendingRetryBatchSize, keys.length);
    for (let i = 0; i < take; i++) {
      const logCoreKey = keys[(startIdx + i) % keys.length]!;
      // Advance on selection, not on success, so a thrown/transient verify
      // still makes forward progress instead of pinning the sweep forever.
      pendingRetryCursor = logCoreKey;
      const entry = pendingPeers.get(logCoreKey);
      if (!entry) continue; // removed between snapshot + loop body
      // Grace-window expiry: remove + reject, don't retry forever.
      if (nowMs - entry.since > BOOT_PENDING_GRACE_MS) {
        pendingPeers.delete(logCoreKey);
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_rejected',
          `pending_grace_expired ${peerLabel(entry.frame.log_core_key)}`,
        );
        continue;
      }
      // Re-verify: re-build the AdmissionInput from the stored frame.
      // Pass { nowMs: entry.since } so freshness is checked relative to
      // the arrival timestamp, NOT the current wall-clock. The announce
      // was fresh when it arrived (validated in onAnnounce). Re-running
      // freshness against Date.now() would cap the effective retry window
      // at DEFAULT_ANNOUNCE_WINDOW_MS (5 min), defeating the 30-min
      // BOOT_PENDING_GRACE_MS grace window that the pending-retry exists for.
      try {
        const verifyResult = verifyAnnounceDetailed(entry.frame, { nowMs: entry.since });
        const sigValid = verifyResult.ok;
        // WI-1662: same distinct clock-skew signal as onAnnounce, above.
        if (verifyResult.reason === 'stale_ts') {
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'announce_clock_skew',
            `peer clock >5min off this machine (pending-retry) — check clock/NTP ${peerLabel(entry.frame.log_core_key)}`,
          );
        }
        const input: AdmissionInput = {
          device_pubkey: entry.frame.device_pubkey,
          github_login: entry.frame.github_login,
          github_user_id: entry.frame.github_user_id,
          attestation_gist_id: entry.frame.attestation_gist_id,
          sigValid,
        };
        const admittedByKnownMember = await admitsAsKnownHiveMember(entry.frame, sigValid);
        const channel2Verified = !admittedByKnownMember;
        const decision = admittedByKnownMember ? ({ admit: true } as const) : await admit(input);
        if (decision.admit) {
          // A-003 + WI-559: identity is re-verified (admit() above re-checked revocation); now
          // re-resolve SCOPE against the now-current state, in the SAME order as onAnnounce.
          //  (1) slug scope — the joiner's hive-home rebind (`hiveHomeProjectionSlug`) may have
          //      landed since this frame was buffered → admit if now in-scope.
          //  (2) else, the same-hive MEMBERSHIP — A's `hive_members` row may have federated in
          //      since the buffer (the WI-559 asymmetric-stall case). resolveSameHiveMember admits
          //      if A is now a member, re-buffers (idempotent, grace clock preserved) on a still-
          //      missing membership, or returns null when this is not a same-hive candidate.
          //  (3) else (not a same-hive candidate) AND home RESOLVED → genuinely foreign → conclusive
          //      reject; home still unresolved → keep pending for the next tick.
          const originSlug = entry.frame.harness_slug ?? null;
          const inScope = announceSlugInScope(originSlug, slug, hiveHomeProjectionSlug);
          if (inScope) {
            // WI-1544 root cause #3: this used to delete BEFORE the awaited
            // admit — any throw inside the merge-gated drain made the frame a
            // one-shot silent loss (gone from every buffer; announces never
            // re-flow). Admit first; drop the buffer entry only once the log
            // actually landed in `admitted` (a failed drain re-buffers the
            // frame into pendingPeers — an unconditional delete here would
            // erase that re-buffered entry).
            await admitPeer(entry.frame, channel2Verified);
            if (admitted.has(logCoreKey)) pendingPeers.delete(logCoreKey);
          } else {
            const sameHive = await resolveSameHiveMember(entry.frame, channel2Verified);
            if (sameHive?.admit) {
              // resolveSameHiveMember admitted it (called admitPeer) → stop
              // retrying — but only once the log actually landed in `admitted`
              // (WI-1544: a failed drain re-buffers; delete only on success).
              if (admitted.has(logCoreKey)) pendingPeers.delete(logCoreKey);
            } else if (sameHive && sameHive.reason === 'pending') {
              // membership still not federated → leave pending (it re-buffered idempotently).
            } else if (hiveHomeProjectionSlug != null) {
              // not a same-hive candidate AND home resolved → genuinely foreign → conclusive.
              pendingPeers.delete(logCoreKey);
              recordBootEvent(
                opts.workspaceId,
                opts.harnessSlug,
                'announce_rejected',
                `out-of-scope origin=${originSlug} own=${slug} ${peerLabel(entry.frame.log_core_key)}`,
              );
            }
            // else: home still unresolved → leave pending for the next retry tick.
          }
        } else if (
          decision.reason !== 'pending' &&
          // WI-1544: a `binding_invalid` re-check inside the join-bootstrap window is NOT
          // conclusive (same rule as onAnnounce) — leave it pending for the rekey replay.
          !(decision.reason === 'binding_invalid' && inJoinBootstrapWindow())
        ) {
          // Conclusive failure (binding_invalid / bad_sig / revoked) —
          // stop retrying.
          pendingPeers.delete(logCoreKey);
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'announce_rejected',
            `${decision.reason} ${peerLabel(entry.frame.log_core_key)}`,
          );
        }
        // If still 'pending', leave in the map for the next tick.
      } catch (e) {
        // Defensive: a tick failure never kills the retry chain — but it is
        // NOT silent anymore (WI-1544: a silently-swallowed retry error looks
        // identical to "still pending" and can hide a permanent stall). Ring
        // every time; stderr once per peer.
        const msg = e instanceof Error ? e.message : String(e);
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_error',
          `pending-retry ${peerLabel(entry.frame.log_core_key)}: ${msg}`,
        );
        if (!loggedRetryErrorKeys.has(logCoreKey)) {
          loggedRetryErrorKeys.add(logCoreKey);

          console.error(
            `[hyperbee-admission] pending-retry failed for ${peerLabel(entry.frame.log_core_key)} (kept pending; will retry until grace expiry): ${msg}`,
          );
        }
      }
    }
  }
  function armPendingRetry(): void {
    if (pendingRetryMs <= 0 || stopped) return;
    // The callback stays `async` (its returned promise resolves only once the
    // whole tick — including the re-arm — is done) so a caller that awaits
    // what `pendingRetrySetTimeout` schedules (the real setTimeout ignores
    // the return value; test doubles like admission-pending-retry.test.ts's
    // capturePendingRetryTimer().run() explicitly `await cb()`) keeps seeing
    // the exact same synchronization it always has. `inFlightPendingRetryTick`
    // is set synchronously, before this callback's first await, purely so
    // close() (running from a DIFFERENT call stack, e.g. concurrently with an
    // already-fired real timer tick) can also find and await it — see close().
    const timer = pendingRetrySetTimeout(async () => {
      const tick = (async () => {
        try {
          await retryPendingOnce();
        } catch {
          // Defensive: a tick failure must never kill the retry chain.
        } finally {
          armPendingRetry(); // arm the NEXT tick only after this one finished
        }
      })();
      inFlightPendingRetryTick = tick;
      try {
        await tick;
      } finally {
        if (inFlightPendingRetryTick === tick) inFlightPendingRetryTick = null;
      }
    }, pendingRetryMs);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    pendingRetryTimer = timer;
  }
  armPendingRetry();

  // ── Hyperswarm replication + announce exchange (4b) ──
  // Joins the swarm topic; the connection handler replicates the corestore
  // AND opens the `papercusp/announce` channel — sending OUR signed announce
  // and routing inbound announces to `onAnnounce` (admit → open remote log →
  // merge). Only fires for harnesses that pass swarmBinding; `state: private`
  // harnesses (no binding) stay local-only. Defensive: swarm join / identity
  // resolution failures don't fail the boot — the harness still works as a
  // single-peer substrate.
  let swarmHandle: SwarmHandle | null = null;
  // P-203 Leg A (2026-09-02): the identity THIS harness's swarm announce + pot-git
  // hello actually carry — the device every peer files our socket under. Exposed
  // on the handle (`announceIdentity`) so the git-sync hive legs sign, announce
  // and dial as the SAME device; resolving it independently (the gh-CLI login
  // actor) split the two on the tower — gh=papercupai, announce=ownerhandle — so every
  // ref-announce named a device no peer had a socket for. Reassigned by rekey().
  let announceIdentity: LocalAnnounceIdentity | null = null;
  let gitServingHome: string | null = null;
  let gitServingRuntimeId = randomUUID();
  let writerProgressAnnounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * A local append changes the signed writer high-water. Push that change while
   * the peer connection is live so an attached-but-frozen receiver can arm its
   * existing `replication_frozen` detector immediately instead of waiting for
   * the five-minute loss-recovery sweep. Best-effort: Hypercore replication is
   * still the transport; this announce is the liveness/repair witness.
   */
  function scheduleWriterProgressAnnounce(): void {
    if (stopped || writerProgressAnnounceTimer) return;
    writerProgressAnnounceTimer = setTimeout(() => {
      writerProgressAnnounceTimer = null;
      if (stopped) return;
      try {
        swarmHandle?.refreshAnnounce?.();
      } catch {
        // Best-effort liveness signal; periodic reflush remains the fallback.
      }
    }, WRITER_PROGRESS_ANNOUNCE_DEBOUNCE_MS);
    writerProgressAnnounceTimer.unref?.();
  }
  // ── P-006 scoped-log federation state (P-108). The REGISTRY is boot-scoped
  // (own/admitted scoped cores survive a rekey — the store stays open); the
  // COORDINATOR is rebuilt per joinForBinding because it binds the resolved
  // announce identity + signer. `participatingScopes` is the durable declared
  // set so a rekey re-applies it to the fresh coordinator.
  let scopeRegistry: ScopeCoreRegistry | null = null;
  let scopeFederation: ScopeFederation | null = null;
  const participatingScopes = new Map<string, ScopeId>();

  /**
   * The swarm-facing announce hook: base admission first, then — for an
   * ADMITTED frame on a connection that supplied `ctx` — the scoped-log flow
   * (§5.3 serve gate → §5.2 disclosed-core admission → loop-damped directed
   * follow-up). Fire-and-forget: scoped handling never blocks or fails base
   * admission, and an unverified/rejected/pending frame NEVER reaches the
   * scoped layer (frame.github_user_id is only trustworthy once admitted).
   */
  async function onAnnounceWithConnection(
    frame: SignedAnnounce,
    ctx?: AnnounceConnectionContext,
  ): Promise<AdmissionResult> {
    const decision = await onAnnounce(frame);
    if (decision.admit && ctx && scopeFederation) {
      void scopeFederation.onPeerAnnounce(frame, ctx).catch(() => {});
    }
    return decision;
  }

  async function resolveKnownHiveMemberAnnounceIdentityForBinding(
    binding: SwarmBinding,
  ): Promise<LocalAnnounceIdentity | null> {
    if (binding.kind !== 'hive') return null;
    const { potHomeSlugForHarness } = await loadHiveFederationModule();
    const potHomeSlug =
      hiveHomeProjectionSlug ?? (await potHomeSlugForHarness(opts.workspaceId, opts.harnessSlug).catch(() => null));
    if (!potHomeSlug) return null;
    // EI-18777176681958978: `hiveHomeProjectionSlug` is already the federated scope, but the
    // `potHomeSlugForHarness` FALLBACK is the local handle — resolve either way (idempotent
    // on an already-federated scope) so this identity resolve can't read an empty roster.
    const { listHiveMembersForLocalPot } = await loadFederatedPotScopeModule();
    const members = await listHiveMembersForLocalPot(opts.workspaceId, potHomeSlug).catch(() => []);
    return resolveLocalAnnounceIdentityFromHiveMembers({ members });
  }

  // Join (or RE-KEY to) the swarm topic derived from `binding`, using THIS
  // boot's LIVE store + own log + onAnnounce. Extracted so `rekey()` can re-run
  // it against a NEW binding WITHOUT tearing down the store / open cores /
  // replication streams / merge loop. EI-681: a full reboot (close + boot)
  // disrupts the OWNER's corestore replication-SERVING of its own log core — the
  // re-keyed owner admits the joiner + connects but never UPLOADS its log, so
  // the feature never crosses. Re-keying in place leaves the replication streams
  // intact, so serving continues seamlessly onto the new topic.
  async function joinForBinding(binding: SwarmBinding): Promise<void> {
    // WI-38344: set this before the first await so announces racing the join
    // setup are covered even when the joiner's home is already resolved.
    joinBootstrapStartedAt = Date.now();
    joinedHiveOwnerDevice = null;
    // WI-1910 hardening: 'join_started' BEFORE the first await. The run-#5
    // forensics had no signal separating "joinForBinding never ran" from "it
    // ran and wedged on an await" — both looked like a silent local-only
    // harness. With this witness, join_started with neither join_succeeded
    // nor swarm_join_failed = wedged mid-join; absent entirely = never called.
    recordBootEvent(opts.workspaceId, opts.harnessSlug, 'join_started', `binding=${binding.kind}`);
    try {
      const swarm = opts.swarmOverride ?? (await getSharedSwarm());
      // WI-3604 (split-DHT-universe recurrence guard): the assertion is
      // computed once per PROCESS (memoized alongside the shared swarm's
      // construction in getSharedSwarm) — record it durably per HARNESS here,
      // on every join, so a harness that joins later still gets flagged and
      // the boot-history ring shows it happened at THIS join. `swarmOverride`
      // callers (unit tests) never construct the real shared swarm, so the
      // assertion is `null` there — skip silently rather than false-positive.
      const dhtAssertion = getDhtUniverseAssertion();
      if (dhtAssertion) {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          dhtAssertion.ok ? 'dht_universe_ok' : 'dht_universe_mismatch',
          dhtAssertion.detail,
        );
        setDhtUniverseAssertion(opts.workspaceId, opts.harnessSlug, dhtAssertion);
      }
      const topic = deriveSwarmTopic(binding);
      // Build OUR announce: bind our log core to our device identity. For Hive
      // topics, prefer the durable local hive_members+keychain binding so a
      // known member can rejoin during a GitHub outage; fall back to live GitHub
      // identity resolution for first-time/non-Hive announces. Throws (→ caught
      // below) when neither path can resolve, keeping the harness local-only
      // rather than joining without an announce.
      const knownHiveIdentity = opts.announceIdentityOverride
        ? null
        : await resolveKnownHiveMemberAnnounceIdentityForBinding(binding);
      const identity =
        knownHiveIdentity ??
        (await resolveLocalAnnounceIdentity({
          // Spread the test override FIRST so boot's own `logCoreKeyHex` always
          // wins (the announce must bind THIS peer's actual log core).
          ...(opts.announceIdentityOverride?.resolveOpts ?? {}),
          logCoreKeyHex: ownLog.keyHex,
        }));
      announceIdentity = identity;
      // WI-2039866: feed the EN-4 owner exemption (mergeOnePass) the identity peers
      // actually attribute this device to — the announce identity, NOT the gh-CLI login
      // (on the tower those differ: gh=papercupai, announce=ownerhandle, and the gap is what
      // produced an allowlist that excluded the owner's own devices).
      localAnnounceGithubUserId = identity.githubUserId;
      // The signer defaults to the keychain-backed `signWithDeviceKey`; tests
      // inject a signer over a self-generated keypair so no OS keychain is
      // touched (see `announceIdentityOverride`).
      const signAnnounce = opts.announceIdentityOverride?.sign ?? signWithDeviceKey;
      // WI-559 issue-2 — FRESH-ANNOUNCE-PER-CONNECTION. The announce BODY is static (this peer's
      // device identity + log core + signed origin slug); only `ts`+`sig` change per build. A single
      // frozen-`ts` frame built ONCE at boot is rejected by the peer's `verifyAnnounce` the moment it
      // is >5min old (DEFAULT_ANNOUNCE_WINDOW_MS) — so EVERY post-window / post-reconnect / post-reboot
      // connection sent a STALE announce → the peer admitted nothing → both sides stuck on own-only
      // admitted sets (the WI-559 stale-peering root cause, distinct from the membership-miss path).
      // So pass a FACTORY that re-stamps (current ts) + re-signs per connection; `ourAnnounce` (the
      // initial build) seeds the static log_core_key (swarm entry key) + the first send.
      const signOurAnnounce = (bytes: Buffer) => signAnnounce(identity.keychainId, bytes);
      // WI-10002600: the own-log keys this device retired in an own-log fork recovery,
      // signed ONCE here (the statement names only the device + the current own-log key,
      // never `ts`) and carried on every own-log announce so each peer drops the dead log.
      // Best-effort: a failure leaves the announce exactly as it was before this field.
      let ownLogSupersession: Awaited<ReturnType<typeof buildLogSupersession>> = {};
      try {
        const superseded = await (
          opts.supersededOwnLogKeysOverride ?? (() => readSupersededOwnLogKeys(harnessStorePath(storeOpts)))
        )();
        ownLogSupersession = await buildLogSupersession(
          { device_pubkey: identity.devicePubkeyBase64, log_core_key: ownLog.keyHex },
          superseded,
          signOurAnnounce,
        );
        if (ownLogSupersession.supersedes_log_keys) {
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'peer_log_superseded',
            `announcing own-log supersession: ${ownLogSupersession.supersedes_log_keys
              .map((k) => peerLabel(k))
              .join(', ')} replaced by ${peerLabel(ownLog.keyHex)}`,
          );
        }
      } catch (e) {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'announce_error',
          `own-log supersession skipped: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const announceBody = {
        device_pubkey: identity.devicePubkeyBase64,
        github_user_id: identity.githubUserId,
        github_login: identity.githubLogin,
        attestation_gist_id: identity.attestationGistId,
        log_core_key: ownLog.keyHex,
        // A-003 (a′): the SIGNED origin-harness slug. When multiple local harnesses share one hive
        // topic (the hive-home log alongside a member's — dc9db's swarm.ts broadcasts each on the
        // single channel), the peer's onAnnounce slug-filter uses this to admit a log only into the
        // harness scope that should hold it. Absent on legacy peers → the filter treats absent as admit.
        harness_slug: opts.harnessSlug,
        ...ownLogSupersession,
      };
      // WI-38376: compute log_length at EACH fresh/re-flush build, not once at
      // boot. The periodic announce sweep is the writer-progress heartbeat.
      const buildOurAnnounce = () => buildAnnounce({ ...announceBody, log_length: ownLog.length }, signOurAnnounce);
      const ourAnnounce = await buildOurAnnounce();
      // ── P-006 scoped-log federation coordinator (P-108). Best-effort: a
      // failure here leaves the scoped layer off (null) without failing the
      // join — base federation is independent of it. The scoped store is a
      // SEPARATE corestore that is NEVER passed to store.replicate (the §5.3
      // fail-closed premise); the roster/epoch reads federate under the hive
      // home slug when one is bound (grants/epochs live there), else our own.
      //
      // WI-1910 hardening: DEFERRED off the join critical path. This block
      // holds three awaits against best-effort deps (scoped corestore open,
      // PG fleet-directory read, ensureOwnScopes) — a NON-SETTLING one used
      // to wedge the entire join silently BEFORE swarm.join (no joined-topic,
      // no join-FAILED, zero dials: exactly the WI-1910 rig signature, and
      // the one hypothesis the run-#5 logs could not cheaply distinguish).
      // So it is kicked off here un-awaited; the join awaits it AFTER
      // swarm.join with a bounded wait (below), so the scoped layer is
      // normally wired before boot returns but can only ever DELAY the join,
      // never block it. On a late settle it wires in the background — every
      // consumer (onAnnounce :2814, declareParticipatingScopes, the handle
      // getter) null-guards. The closure catches internally and never rejects.
      const scopedInitDone = (async () => {
        try {
          const scopedStore = opts.scopedStoreOverride
            ? await opts.scopedStoreOverride()
            : await getHarnessScopedStore(storeOpts);
          if (!scopeRegistry) {
            // Narrowed at the boundary (scope-cores.ts convention): Corestore
            // sessions structurally satisfy ScopedSessionLike.
            scopeRegistry = new ScopeCoreRegistry(scopedStore as unknown as ScopedStoreLike);
          }
          const rosterPotSlug = hiveHomeProjectionSlug ?? opts.harnessSlug;
          // P-101: the fleet directory widens the scope roster from owner-only to
          // owner ∪ publisher-set, and seeds this peer's participating scopes from
          // its directory records (owner or publisher of a live fleet ⇒ participant).
          const fleetDirectory = new PgFleetDirectory({
            workspaceId: opts.workspaceId,
            potSlug: rosterPotSlug,
          });
          scopeFederation = new ScopeFederation({
            registry: scopeRegistry,
            roster: getScopeRoster({
              workspaceId: opts.workspaceId,
              potSlug: rosterPotSlug,
              directory: fleetDirectory,
            }),
            selfGithubUserId: identity.githubUserId,
            buildScopedAnnounce: (scopedLogs) =>
              buildAnnounce({ ...announceBody, log_length: ownLog.length, scoped_logs: scopedLogs }, signOurAnnounce),
            // M15/D-004: every refused scoped entry is a visible counter + boot
            // event, never a silent drop. Best-effort (PG may be unavailable in
            // rigs); the boot event is the always-on local witness.
            onRefusal: (r) => {
              const reason =
                r.kind === 'inbound-announce'
                  ? `scoped-announce:${r.refusal.reason}`
                  : `scoped-${r.kind}:${r.refusal.reason}`;
              recordBootEvent(opts.workspaceId, opts.harnessSlug, 'announce_rejected', reason);
              void bumpRefusedOpCounter({
                workspaceId: opts.workspaceId,
                potSlug: rosterPotSlug,
                reason,
              }).catch(() => {});
            },
          });
          // P-101 driver: union the directory-derived participation (fleets this
          // identity owns or publishes to) into the durable declared set. Best-
          // effort — a PG/directory failure leaves explicit declarations intact.
          const directoryScopes = await fleetDirectory
            .listParticipatingScopes(identity.githubUserId)
            .catch(() => [] as ScopeId[]);
          for (const s of directoryScopes) participatingScopes.set(formatScopeId(s), s);
          if (participatingScopes.size > 0) {
            await scopeFederation.ensureOwnScopes([...participatingScopes.values()]);
          }
        } catch (e) {
          scopeFederation = null;
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'announce_error',
            `scoped-log layer unavailable: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      })();
      // SUBSTRATE_SIDECAR Option B (WI-604): build the replication-offload seam.
      // A test override wins; else, when the OFF-by-default flag is ON, route each
      // accepted peer socket to the sidecar via offloadReplicationToSidecar.
      // undefined (flag OFF + no override) ⇒ joinHarnessSwarm replicates in-process,
      // byte-identical to today.
      const offloadReplication: ((socket: unknown, peerInfo?: unknown) => boolean) | undefined =
        opts.sidecarOffloadOverride ??
        (sidecarOffloadEnabled
          ? (socket: unknown) =>
              offloadReplicationToSidecar(socket, {
                workspaceId: opts.workspaceId,
                harnessSlug: opts.harnessSlug,
                workspaceRoot: opts.workspaceRoot,
                onResult: (r) => {
                  recordBootEvent(
                    opts.workspaceId,
                    opts.harnessSlug,
                    r.ok ? 'peer_connected' : 'swarm_join_failed',
                    r.ok
                      ? `sidecar-replicating conn=${r.connectionId ?? '?'}`
                      : `sidecar handoff failed: ${r.error ?? 'unknown'}`,
                  );
                },
              })
          : undefined);
      // The early-boot hive-home resolve (`resolvedPotHomeSlug`, ~L956) is
      // deliberately fail-open (`catch → undefined`), so ONE transient
      // PG/registry hiccup during boot silently latches hiveGitServe +
      // hiveGitDial OFF for the ENTIRE process lifetime: the box wires every
      // other topic's planes on new connections but never this one's, and every
      // bootstrap fetch fails 'no live dial path' until an unrelated restart.
      // (Investigated as the suspected fence-26 / P-303 reverse-leg cause
      // 2026-07-17 — that incident turned out to be a WI-183 zombie connection
      // instead, but the latch is real and stays fixed.) Unlatch here, at join
      // time (joinForBinding also runs on rejoin/rekey — a genuinely later
      // moment than the early-boot read): serve needs the home slug, so
      // re-resolve it with bounded retries ({ fresh } past attempt 0 to dodge a
      // poisoned operator-state cache, WI-1378) and record the terminal failure
      // LOUDLY instead of dropping it. An explicit test override is
      // authoritative — no retry, its early-boot answer stands.
      let hiveGitHomeSlug = hiveHomeProjectionSlug ?? contentGuardHiveHome;
      if (
        hiveGitHomeSlug == null &&
        bindingResolvesHiveHomeProjection(binding) &&
        !opts.potHomeSlugForHarnessOverride
      ) {
        for (let attempt = 0; attempt < 3 && hiveGitHomeSlug == null; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, attempt === 1 ? 1_000 : 4_000));
          try {
            const { potHomeSlugForHarness } = await loadHiveFederationModule();
            hiveGitHomeSlug =
              (await potHomeSlugForHarness(
                opts.workspaceId,
                opts.harnessSlug,
                attempt > 0 ? { fresh: true } : undefined,
              )) ?? undefined;
          } catch {
            // transient read failure — retry (that transiency latching the
            // planes off is exactly the defect this loop exists to close)
          }
        }
        if (hiveGitHomeSlug == null) {
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'merge_error',
            'hiveGit home-resolve failed after join-time retries — pot-git SERVE stays off for this join (dial is binding-gated and unaffected)',
          );
        }
      } else if (hiveGitHomeSlug == null && binding?.kind === 'gh') {
        // EI-18804225902691617: `bindingResolvesHiveHomeProjection` deliberately
        // excludes 'gh' above so the common case (a plain gh-bound harness that is
        // never going to be a hive member — the overwhelming majority of boots) pays
        // zero extra cost and stays completely silent, which is correct. But
        // boot.ts's own join-sequencing comment (~L1066) documents a real transient
        // — and, if the re-key never completes or gets reverted, PERMANENT — state
        // where a harness IS a hive member (join-hive.ts has already stamped
        // hive_slug in the registry) while its swarm binding is STILL 'gh' (the
        // re-key hasn't landed): `hiveGitServe`/`hiveGitDial` are then omitted for
        // the entire process lifetime with NO boot event and NO log line at all.
        // One cheap, NON-retried registry read distinguishes the two: if this
        // harness's home resolves to something despite the gh binding, we're in
        // that reachable stuck-mid-join state and it is worth saying so loudly; if
        // it resolves to nothing (the ordinary non-hive-forever gh harness), stay
        // silent exactly as before — this branch must never become per-boot noise
        // for the common case. Deliberately reports only; does NOT assign
        // hiveGitHomeSlug — serve stays gated off for a gh binding exactly as
        // before, unchanged from today's behavior.
        try {
          const resolve =
            opts.potHomeSlugForHarnessOverride ?? (await loadHiveFederationModule()).potHomeSlugForHarness;
          const maybeHiveHome = (await resolve(opts.workspaceId, opts.harnessSlug)) ?? undefined;
          if (maybeHiveHome) {
            recordBootEvent(
              opts.workspaceId,
              opts.harnessSlug,
              'merge_error',
              'pot-git serve stays off: harness still on its gh binding, hive re-key has not engaged (dial is binding-gated and unaffected)',
            );
          }
        } catch {
          // best-effort diagnostic only — never let this probe affect the join
        }
      }
      gitServingHome = null;
      gitServingRuntimeId = randomUUID();
      swarmHandle = await joinHarnessSwarm({
        store,
        topic,
        swarm,
        ourAnnounce,
        buildOurAnnounce,
        onAnnounce: onAnnounceWithConnection,
        offloadReplication,
        // WI-752 / FED-2: forward the self-heal re-peer cadence (defaults applied
        // inside joinHarnessSwarm when these are undefined).
        refreshMs: opts.swarmRefreshMs,
        fastWindowMs: opts.swarmFastWindowMs,
        slowRefreshMs: opts.swarmSlowRefreshMs,
        stalledMaxRefreshMs: opts.swarmStalledMaxRefreshMs,
        // WI-1534 anti-entropy: re-arm the self-heal loop's FAST cadence
        // (WI-10005270: for one fast window, then an exponential backoff to
        // stalledMaxRefreshMs) whenever an admitted remote log has zero live replicator peers —
        // on a quiescent hive (no connection churn) this is the ONLY thing
        // that re-arms it; otherwise it settles into the 60s slow keepalive
        // and a genuinely stalled/zombie peer can go unresynced for as long
        // as it takes an UNRELATED event to coincidentally trigger a working
        // reconnect (the observed 80+min stall). EI-18665254552552477 extended
        // this to the PRE-admission window too (zero admitted remotes used to
        // read as healthy, which is backwards — see computeHasStalledLogs's
        // docstring). Pure decision extracted to computeHasStalledLogs (unit
        // tested in isolation); this closure only supplies its three live
        // inputs. Best-effort (never throws past this call — a throwing probe
        // or a throwing `swarmHandle` getter is treated as "not stalled") and
        // cheap (Map scan, no I/O). `swarmHandle` is a forward reference
        // (declared later, assigned once the join resolves) — safe here
        // because this callback is only ever invoked from a refresh tick,
        // which cannot fire before the join settles; same convention as
        // `escalateToForcedRejoin`'s `swarmHandle?.forceRejoin()` above.
        hasStalledLogs: () => {
          try {
            // WI-10005287: the TOPIC-scoped socket count, never the swarm-wide
            // liveConnectionCount (see topicStallCandidateCount's doc).
            return computeHasStalledLogs(admitted, ownLog.keyHex, swarmHandle?.topicStallCandidateCount ?? 0);
          } catch {
            return false;
          }
        },
        // P-201 (p2p-git-live-activation-2026-07-09): register the hive-git
        // serve plane only for a harness actually bound to a hive home — a
        // non-hive harness (both home resolutions undefined) never wires it, so
        // it stays byte-for-byte unchanged. Per-request mode gating (legacy vs
        // bridged/p2p-only) happens live inside the wiring itself.
        // WI-3496 rig finding: `hiveHomeProjectionSlug` alone is the JOINER
        // rebind (null for the hive OWNER — the same owner-side asymmetry
        // WI-559/FED-1 and WI-2105 fixed for the content projections), so the
        // owner never wired serve OR dial and every cross-machine pot-git
        // fetch involving the owner hung to the client's 120s timeout (its
        // channel-open had no pair()). `?? contentGuardHiveHome` resolves the
        // hive-home for ANY hive-peered harness (owner home + owned-hive
        // member harness included), exactly like the scoped-apply fallback.
        ...(hiveGitHomeSlug
          ? {
              hiveGitServe: {
                potHomeSlug: hiveGitHomeSlug,
                workspaceId: opts.workspaceId,
              },
            }
          : {}),
        // WI-3583: register the device-pubkey -> live-socket dial registry
        // alongside the serve plane, same hive-only gate — P-204's
        // worktree-bridge-tick and P-202's ref-announce receive-tick both
        // need to resolve "the device that signed this staging-advance /
        // ref-announce" to a live socket to dial, which is exactly what
        // wireHiveGitDial (peer-dial-registry.ts) populates on every
        // connection, symmetric with wireHiveGitServe above.
        // WI-3641: sign our hello frame with the same identity keypair that
        // signs our announce — the peer's serve-side verifies it before
        // binding `selfDevicePubkeyBase64` to the live socket, so a scope-repo
        // fetch can be authorized against a PROVEN device identity.
        // WI-3496: same owner-side gate fix as hiveGitServe above — without it
        // the owner never sent a hello, so joiners could never resolve the
        // owner's device to a socket (G-8 cold-join structurally impossible).
        // The dial plane needs NO resolved home slug — only "is this a
        // hive/topic binding", a pure function of the binding we are joining —
        // so gate it on the binding alone instead of the PG-dependent slug
        // resolve (fail-open at boot), which could latch dial off for the
        // process lifetime on one transient read failure; serve above keeps
        // the slug gate (it genuinely needs the slug), hardened by the
        // join-time retry.
        ...(bindingResolvesHiveHomeProjection(binding)
          ? { hiveGitDial: { selfDevicePubkeyBase64: identity.devicePubkeyBase64, sign: signOurAnnounce } }
          : {}),
        onPeerConnected: (keyHex, info) => {
          // EI-18682571591024156: `peer_connected` fires on SIGNALLING success (the
          // Noise handshake completes as a DHT RPC over a UDX stream that has
          // carried zero bytes), NOT on a demonstrated data path. Say so in the
          // detail + the log line, and carry hyperdht's own signalling outcome
          // (relayed / addresses) that we previously discarded — so a reader of
          // this line can tell "punched path believed up" from "relayed" instead
          // of inferring it from an RTO timeout 13s later.
          const pathBits = info?.path.present
            ? ` relayed=${info.path.relayed ?? '?'}` +
              (info.path.serverAddress ? ` server=${info.path.serverAddress}` : '') +
              (info.path.clientAddress ? ` client=${info.path.clientAddress}` : '') +
              (info.path.relayHost ? ` relay=${info.path.relayHost}:${info.path.relayPort ?? '?'}` : '')
            : ' path=unknown';
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'peer_connected',
            `signalling-only (data path NOT yet demonstrated)${pathBits}`,
          );

          console.info(
            `[swarm] peer_connected(signalling-only) harness=${opts.harnessSlug}` +
              (keyHex ? ` peer=${keyHex.slice(0, 12)}…` : '') +
              pathBits,
          );
        },
        // EI-18682571591024156: the honest counterpart — a peer that reported
        // connected and then closed having never received a byte. Recorded as a
        // replication stall (it IS one: the transport looked alive and no data
        // ever crossed), so the failure is visible in boot-history instead of
        // surfacing only as a generic ~13s UV_ETIMEDOUT.
        onDataPathNeverUp: (dp) => {
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'replication_stalled',
            `data path never came up: ${peerLabel(dp.remotePublicKeyHex, dp.remoteIp)} ` +
              `ageMs=${dp.ageMs} bytesTx=${dp.wire.bytesTransmitted ?? '?'} bytesRx=0 ` +
              `relayed=${dp.path.present ? (dp.path.relayed ?? '?') : 'unknown'}`,
          );
        },
        onPeerRejected: (keyHex, ip) => {
          recordBootEvent(opts.workspaceId, opts.harnessSlug, 'peer_rejected', peerLabel(keyHex, ip));
          // WI-5355/WI-5481 diagnosability: onPeerRejected/onPeerRateLimited
          // previously ONLY wrote to the in-process boot-history ring buffer
          // (no HTTP surface reachable from these rig containers was found
          // during live debugging of the "topic never re-pairs" class) — a
          // banned/rejected peer was invisible in serve.log, so a process-
          // global swarm-guard ban (see swarm-guard.ts's CONN_RATE + 10-minute
          // DEFAULT_BAN_TTL_MS) looked identical to "the DHT/discovery layer
          // never recovers", sending prior investigation down the topic-
          // gossip escalation-ladder path instead. Log it plainly so the next
          // live rig run makes this branch directly visible.
          console.warn(
            `[swarm] ⚠ peer_rejected harness=${opts.harnessSlug}` +
              (keyHex ? ` peer=${keyHex.slice(0, 12)}…` : '') +
              (ip ? ` ip=${ip}` : ''),
          );
        },
        onPeerRateLimited: (keyHex, ip) => {
          recordBootEvent(opts.workspaceId, opts.harnessSlug, 'peer_rate_limited', peerLabel(keyHex, ip));
          // WI-5355/WI-5481: this peer key+IP just tripped the process-global
          // swarm-guard connection-rate ceiling (CONN_RATE) and is now BANNED
          // for DEFAULT_BAN_TTL_MS (10 minutes) — Hyperswarm's firewall will
          // reject its key pre-handshake for the whole cooldown, so EVERY
          // topic/harness sharing this peer goes dark simultaneously. That
          // symptom ("never paired"/"severed" for minutes at a time despite
          // refresh() ticking) is otherwise indistinguishable from a stale-
          // DHT-state discovery-layer wedge — see this same rig's serve.log
          // for a burst of rapid "swarm connection #N" churn just before this
          // line, which is the likely trigger.
          console.error(
            `[swarm] ⚠ peer_rate_limited harness=${opts.harnessSlug}` +
              (keyHex ? ` peer=${keyHex.slice(0, 12)}…` : '') +
              (ip ? ` ip=${ip}` : '') +
              ' — peer is now BANNED for the guard cooldown; every topic/harness sharing it will look wedged until the ban expires.',
          );
        },
        // P-008 (harden-shared-hive-to-256-peers): turn P-004's process-global
        // near-cap signal into a DURABLE, queryable boot-event. Hyperswarm
        // SILENTLY stops accepting once maxPeers is reached (peer N+1 never
        // connects, no error) — recording it makes approaching/hitting the 256
        // ceiling VISIBLE: the remedy is raising PAPERCUSP_SWARM_MAX_PEERS /
        // scaling the box, or (past 256 active) the trigger to un-defer the
        // relay/sharding re-architecture.
        onNearPeerCap: (info) => {
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'peer_cap_near',
            `${info.liveConnections}/${info.maxPeers} swarm peer connections` +
              (info.atCap
                ? ' — AT CAP: new peers are being silently refused; raise PAPERCUSP_SWARM_MAX_PEERS or scale the box'
                : ' — approaching the peer cap') +
              // WI-6063: record WHICH topics hold the budget, biggest first. At
              // the cap the actionable question is never "how full" but "full of
              // what" — a total alone sends the reader back to the logs.
              (info.topics && info.topics.length > 0
                ? ` · per-topic: ${[...info.topics]
                    .sort((a, b) => b.peers - a.peers)
                    .map(
                      (t) =>
                        `${t.topicHex.slice(0, 8)}…=${t.peers}` +
                        (t.fairShare !== null ? `/${t.fairShare}` : '') +
                        (t.dialPaused ? '(paused)' : ''),
                    )
                    .join(' ')}`
                : ''),
          );
        },
        // WI-6063: durable, edge-triggered record of this topic's dial throttling.
        // The fairness bound's failure mode is SILENT starvation — visually
        // identical to the bug it fixes — so a queryable transition history is
        // what makes it verifiable instead of merely asserted.
        onTopicDialThrottle: (info) => {
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'peer_dial_throttled',
            info.paused
              ? `outbound dialling PAUSED — topic holds ${info.peers} peers vs a fair share of ` +
                  `${info.fairShare} (${info.liveConnections}/${info.maxPeers} live across ` +
                  `${info.topicCount} topics); still announcing + accepting inbound`
              : `outbound dialling RESUMED — topic back within its share ` +
                  `(${info.peers}/${info.fairShare}, ${info.liveConnections}/${info.maxPeers} live)`,
          );
        },
      });

      gitServingHome = hiveGitHomeSlug ?? null;
      console.info(
        `[swarm] joined topic ${topic.toString('hex').slice(0, 16)}… ` +
          `harness=${opts.harnessSlug} (announcing as github_user_id=${identity.githubUserId})`,
      );
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'join_succeeded',
        `topic=${topic.toString('hex').slice(0, 16)}…`,
      );
      // WI-1910 hardening: bounded wait for the deferred scoped-log init.
      // Normally it settled long before the swarm join did, so this is a
      // no-op; a stalled dep delays return by at most scopedInitWaitMs and
      // is recorded LOUDLY (a silently-absent scoped layer is the same
      // invisible-failure class as the silently-local-only harness below).
      {
        const scopedWaitMs = opts.scopedInitWaitMs ?? 10_000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([
          scopedInitDone.then(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(true), scopedWaitMs);
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (timedOut) {
          recordBootEvent(
            opts.workspaceId,
            opts.harnessSlug,
            'announce_error',
            `scoped-log layer init still pending after ${scopedWaitMs}ms — ` +
              `join continued without it; it wires in the background if/when it settles`,
          );
        }
      }
    } catch (e) {
      // Swarm join failed (DHT unreachable / port blocked / gh-auth or keychain
      // can't resolve the announce identity / etc). Record + continue — local
      // writes still work. ALSO log to stderr: a silently-local-only harness is
      // a real federation regression that was previously invisible (only landed
      // in in-memory boot-history), which masked packaged two-instance debugging.
      gitServingHome = null;
      const msg = e instanceof Error ? e.message : String(e);
      recordBootEvent(opts.workspaceId, opts.harnessSlug, 'swarm_join_failed', msg);

      console.warn(`[swarm] join FAILED harness=${opts.harnessSlug} — staying local-only: ${msg}`);
    }
  }

  if (currentBinding) {
    await joinForBinding(currentBinding);
  }

  // ── WI-752 / FED-2 JOIN-retry self-heal ──
  // The join above is one-shot. When it FAILED (swarmHandle stayed null — DHT
  // not ready, a gh-identity / keychain blip, a transient fault) the harness is
  // local-only and, pre-WI-752, would stay so until an operator RESTART. Retry
  // it on a bounded exponential backoff (sequential self-rearming setTimeout,
  // P-022 pattern) until it joins; back off to the cap on a persistent failure
  // so it never hammers, and stop the instant it succeeds. `unref()`'d; cleared
  // in close() (with `stopped` guarding a mid-tick re-arm).
  const swarmJoinRetryBaseMs = Number.isFinite(opts.swarmJoinRetryMs as number)
    ? (opts.swarmJoinRetryMs as number)
    : DEFAULT_SWARM_JOIN_RETRY_MS;
  let swarmJoinRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let swarmJoinRetryDelay = swarmJoinRetryBaseMs;
  function armSwarmJoinRetry(): void {
    if (swarmJoinRetryBaseMs <= 0 || stopped) return;
    if (swarmHandle !== null || !currentBinding) return; // already federating / nothing to join
    swarmJoinRetryTimer = setTimeout(async () => {
      swarmJoinRetryTimer = null;
      if (stopped || swarmHandle !== null || !currentBinding) return;
      // joinForBinding swallows its own errors (records swarm_join_failed); it
      // sets swarmHandle on success. WI-1544 defect D: join the CURRENT binding —
      // a retry firing inside a rekey's swarmHandle=null window must join the
      // NEW topic, never re-join the boot-time one from the opts snapshot.
      await joinForBinding(currentBinding);
      if (swarmHandle !== null) {
        console.info(
          `[swarm] join RECOVERED via retry harness=${opts.harnessSlug} — federation re-established without a restart`,
        );
        try {
          opts.onSwarmJoinRecovered?.();
        } catch {
          /* a re-wire hook failure must never kill the retry loop's tail */
        }
        return; // joined — stop retrying
      }
      swarmJoinRetryDelay = Math.min(swarmJoinRetryDelay * 2, SWARM_JOIN_RETRY_CAP_MS);
      armSwarmJoinRetry();
    }, swarmJoinRetryDelay);
    if (typeof (swarmJoinRetryTimer as { unref?: () => void }).unref === 'function') {
      (swarmJoinRetryTimer as { unref: () => void }).unref();
    }
  }
  if (currentBinding && swarmHandle === null) {
    armSwarmJoinRetry();
  }

  recordBootEvent(opts.workspaceId, opts.harnessSlug, 'boot_ok');

  return {
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    store,
    ownLog,
    async append(op: LocalWriteOp): Promise<void> {
      // P-010 SEND seam: stamp a causal HLC on every federated write so
      // `lwwPick` orders cross-peer conflicts by HLC, not bare wall-clock `ts`.
      // A pre-set `op.hlc` is preserved. This is the single choke point every
      // LWW producer funnels through (the CDC drain + the log-first queue /
      // working-set / contributor / presence helpers all call `handle.append`);
      // the append-only claim path uses the raw `ownLog.append` and correctly
      // carries no HLC (claims are distinct-key per attempt, never LWW).
      const stamped = stampOpHlc(op, opts.hlcClock);
      await ownLog.append({
        type: stamped.type,
        table: stamped.table,
        hbKey: stamped.hbKey,
        value: stamped.value,
        ts: stamped.ts,
        schema_version: stamped.schema_version,
        hlc: stamped.hlc,
        // STAGE-5: thread the real device pubkey. Until then attribute to
        // the write's clobber pubkey (or empty), which the merge tolerates.
        author_pubkey: stamped.writerPubkey ?? '',
        // WI-808: carry the epoch stamp onto the WIRE op. The outbox drain's
        // EpochEncryptCapability sets `op.epoch` (+ encrypts `value`) for selected
        // hive-content ops; without this the stamp was dropped here, so the
        // receiver's decrypt-gate saw `epoch == null` and silently dropped every
        // encrypted content op. Absent on plaintext ops (json omits undefined).
        epoch: stamped.epoch,
      });
      scheduleWriterProgressAnnounce();
    },
    admitted,
    mergeNow,
    produceHeadSnapshotNow,
    compactOwnLogNow,
    onAnnounce: onAnnounceWithConnection,
    async ensureScopeParticipation(scopes: readonly ScopeId[]): Promise<void> {
      for (const s of scopes) participatingScopes.set(formatScopeId(s), s);
      if (scopeFederation) await scopeFederation.ensureOwnScopes(scopes);
    },
    async rediscloseScopes(): Promise<void> {
      await scopeFederation?.redisclose();
    },
    get scopeFederation(): ScopeFederation | null {
      return scopeFederation;
    },
    onAdmitted(listener) {
      admittedListeners.add(listener);
      return () => {
        admittedListeners.delete(listener);
      };
    },
    revoke,
    reverifyAdmitted,
    // A live getter (not a snapshot): `rekey()` reassigns the inner
    // `swarmHandle`, so callers must observe the CURRENT topic, not the one
    // captured at boot return.
    get swarm(): SwarmHandle | null {
      return swarmHandle;
    },
    get announceIdentity(): BootedAnnounceIdentity | null {
      if (!announceIdentity) return null;
      const { devicePubkeyBase64, githubUserId, githubLogin, keychainId } = announceIdentity;
      return { devicePubkeyBase64, githubUserId, githubLogin, keychainId };
    },
    async getGitServingCapability(request): Promise<GitServingState> {
      const { resolveServingStoreContext } = await import('../pot-git/signed-context-store');
      return issueGitServingCapability(request, {
        current: () =>
          !stopped && swarmHandle && announceIdentity && gitServingHome
            ? {
                runtimeId: gitServingRuntimeId,
                workspaceId: opts.workspaceId,
                potHomeSlug: gitServingHome,
                topicHex: swarmHandle.topicHex,
                identity: announceIdentity,
              }
            : null,
        resolveContext: resolveServingStoreContext,
      });
    },
    async rekey(binding: SwarmBinding): Promise<void> {
      // EI-681: re-key onto a NEW swarm topic IN PLACE — leave the old topic and
      // join the new one while keeping the store + own log + admitted set + merge
      // loop ALIVE. A full reboot (close + boot) disrupted the OWNER's corestore
      // replication-serving of its own log core (it admitted + connected to the
      // joiner but never UPLOADED its log → the feature never crossed). Re-keying
      // in place never tears down the replication streams, so serving continues.
      if (stopped) return;
      // WI-1544 defect D: publish the new binding FIRST so every reader
      // (owner resolve, bootstrap window, the swarm-join retry) sees the
      // rekey target throughout the close→rejoin window below.
      currentBinding = binding;
      gitServingHome = null;
      gitServingRuntimeId = randomUUID();
      const previous = swarmHandle;
      swarmHandle = null;
      if (previous) {
        try {
          await previous.close();
        } catch {
          // leaving the old topic is best-effort; the new join is what matters
        }
      }
      // A-003 (a′): re-resolve the joiner hive-home scope + rebind the two hive
      // projections BEFORE joining the new topic. A FIRST join re-keys this member
      // onto the Hive topic AFTER join-hive.ts stamps hive_slug + the remote_hive
      // home view (2/2b precede the 2c re-key), so the home is now resolvable.
      // ORDER MATTERS (A-003 live-RED root cause): `joinForBinding` opens the topic
      // and its onAnnounce begins admitting inbound frames — including the OWNER's
      // hive-home log announce. The onAnnounce slug-filter reads `hiveHomeProjection
      // Slug`; if we joined FIRST, A's hive-home announce could race in with the home
      // still UNRESOLVED → the slug-filter rejects it (and announces are not
      // re-delivered) → the hive-home log never federates to the joiner. The
      // resolution depends only on `binding` (+ the registry), never on the join, so
      // doing it first is safe. An `applyOverride` (the rigs) is never rebuilt — the
      // rig owns its apply. The next merge pass reads the new scopedApply
      // (mergeOnePass re-evaluates `applyImpl` each pass).
      if (!opts.applyOverride) {
        const next = await resolveHiveHomeProjectionSlug(binding);
        if (process.env.PAPERCUSP_A003_TRACE === '1') {
          console.error(
            `[A-003] ${new Date().toISOString()} rekey ${opts.harnessSlug}: binding.kind=${binding?.kind ?? '<none>'} next=${next ?? '<none>'} prev=${hiveHomeProjectionSlug ?? '<none>'} rebind=${next !== hiveHomeProjectionSlug}`,
          );
        }
        if (next !== hiveHomeProjectionSlug) {
          const previousApplyBinding = currentApplyBinding();
          hiveHomeProjectionSlug = next;
          scopedApply = buildScopedApply(next);
          // ── Re-key GATE LIFECYCLE (su-c2a63, Gate 3) ── A mid-session join resolves the
          // hive-home (home <none> → the hive-home slug), making THIS harness a hive member
          // NOW. The boot-time buildHiveRekeyBootDeps returned null (not yet a hive), so without
          // this rebuild the member keeps applyImpl=enforcedApply (NO decrypt gate) until a
          // reboot → flag-on it would project raw __rekey ciphertext as content (garbage).
          // Rebuild beside the scopedApply rebind (the proven A-003 in-place path): `next` is
          // now the resolved hive-home, so buildHiveRekeyBootDeps builds the gate + a fresh
          // PendingEpochContent. Flag-dark (off ⇒ null ⇒ byte-for-byte). The next merge pass
          // re-reads rekeyDeps (applyImpl@mergeOpts + the per-pass drain), so it takes effect
          // with no reboot. NOTE: this rebind block runs on EVERY home-resolving rekey,
          // including the sameTopic in-place path (which skips only close+rejoin) — so a
          // same-topic first-join still rebuilds the gate. This is the witness's B path (a
          // mid-session joiner): without it K1 (B reads F-CTRL) can't pass.
          rekeyDeps = await buildRekeyDeps();
          registerAllHarnessProjections({
            workspaceId: opts.workspaceId,
            harnessSlug: opts.harnessSlug,
            potHomeSlug: next,
            // Re-wire the drain hook onto the re-registered hive_epoch_keys projection (shared
            // boot-scope epochDrainQueue via recordEpochDrain) when the re-key is now active.
            ...(rekeyDeps ? { onEpochKeyApplied: recordEpochDrain } : {}),
            // WI-259 P-004: keep the content-before-membership buffer wired on the joiner rebind
            // (a mid-session join makes this harness a hive member — content may now defer/drain).
            pendingMemberContent,
            memoryFederationFlagOn: memoryFederationFlagSnapshot,
          });
          // A-003 apply-side determinism: the hive_members/hive_settings projections just
          // rebound from the member slug to the hive-home slug. An owner log admitted +
          // folded during the prior home=<none> window applied its hive_members op against
          // the OLD (member-slug) binding → it was dropped → empty roster → A's content
          // defers forever. Force the next merge pass to re-fold all admitted logs through
          // the NEW binding so that op re-applies and lands. Driven by the mergeNow() below.
          forceReFold = true;
          forceReFoldCanReloadPgSeed = previousApplyBinding !== currentApplyBinding();
        }
      } else if (process.env.PAPERCUSP_A003_TRACE === '1') {
        console.error(`[A-003] ${new Date().toISOString()} rekey ${opts.harnessSlug}: SKIPPED (applyOverride present)`);
      }
      await joinForBinding(binding);
      // A-003 fix (c) — replay-on-rebind. The rekey is the exact moment
      // `hiveHomeProjectionSlug` becomes known (a first join re-keys the member onto
      // the Hive topic only AFTER join-hive stamps hive_slug + the remote_hive home).
      // The owner's hive-home log announce that raced in during the `home=<none>`
      // boot window was BUFFERED (not rejected) by onAnnounce as `scope_unresolved`.
      // Re-drive the pending set NOW, against the freshly-resolved home, so that
      // hive-home log is admitted at the rebind instant — rather than waiting up to
      // `pendingRetryMs` (5s) for the periodic tick. That timer latency was the
      // residual live-RED window: the content-matrix / from-repo witness samples
      // hive_settings/hive_members within seconds of join, before the tick admits the
      // log. Idempotent + re-entrancy-safe (retryPendingOnce no-ops on an empty set;
      // mergeNow serializes internally), so racing the periodic tick is harmless.
      await retryPendingOnce();
      // A-003 apply-side determinism (su-81f2e): drive the re-fold requested by the
      // rebind block above. retryPendingOnce only re-ADMITS still-pending peers — but
      // the live A→B failure is an owner log that was ALREADY admitted (bootstrap-admit
      // at home=<none>) and folded BEFORE the rebind, so its hive_members op dropped
      // against the member-slug binding and the cursor marked it done. This mergeNow
      // consumes forceReFold (set on rebind) → resets the cursor → re-folds every admitted
      // log through the now-hive-home-bound scopedApply → A's roster row re-applies →
      // hive-members.ts drains the deferred member content → A's content lands. Idempotent
      // (LWW upserts), one-shot (flag cleared under the gate), coalesces with the periodic
      // merge. This is the deterministic replacement for the scheduling-dependent behaviour
      // that PAPERCUSP_A003_TRACE's stderr delay accidentally flipped green (run31 vs run32).
      await mergeNow();
    },
    registerCloseHook(hook: () => void | Promise<void>): () => void {
      closeHooks.add(hook);
      return () => {
        closeHooks.delete(hook);
      };
    },
    async close() {
      stopped = true;
      // WI-10002836: a compaction still QUEUED for a fold slot must not hold close() hostage.
      ownCompactionAbort.abort();
      if (writerProgressAnnounceTimer) {
        clearTimeout(writerProgressAnnounceTimer);
        writerProgressAnnounceTimer = null;
      }
      // P-004 (WI-1840): drop this harness's replication-liveness tracking so a
      // closed handle never reads as 'sampling_stale' on a status surface.
      try {
        await dropReplicationLiveness(opts.workspaceId, opts.harnessSlug);
      } catch {
        /* best-effort */
      }
      // Run teardown hooks (e.g. the Stage-5 outbox drain stopper) FIRST, before
      // the store/swarm tear down — a drain mid-flight should stop appending to
      // an about-to-close store. Best-effort: a throwing hook is logged, not
      // fatal, and each hook runs once (the Set is drained as we go).
      const hooks = [...closeHooks];
      closeHooks.clear();
      for (const hook of hooks) {
        try {
          await hook();
        } catch (e) {
          console.error(
            `[boot.close] close-hook failed for ${opts.workspaceId}::${opts.harnessSlug}:`,
            e instanceof Error ? e.message : String(e),
          );
        }
      }
      // Stop the progress poller first so it doesn't read ownLog.length on
      // an about-to-close store.
      progressPoller.stop();
      // Stop the merge poller + pending-retry timer before the store closes
      // (a get() against a closing store throws; mergeNow bails on `stopped`,
      // but clear cleanly).
      if (mergeTimer) {
        try {
          mergeTimer.stop();
        } catch {
          // no-op
        }
      }
      if (livenessTimer) {
        try {
          livenessTimer.stop();
        } catch {
          // no-op
        }
      }
      if (pendingRetryTimer) {
        try {
          // The retry loop is a self-rearming setTimeout chain (P-022);
          // `stopped` (set above) prevents a mid-tick re-arm.
          pendingRetryClearTimeout(pendingRetryTimer);
        } catch {
          // no-op
        }
      }
      // WI-1631: clearTimeout above only cancels a still-SCHEDULED tick — a
      // tick that already FIRED and is mid-flight (e.g. awaiting
      // openRemoteLog inside retryPendingOnce) is NOT cancelled and keeps
      // running after close() would otherwise resolve. Await it here so any
      // console.error / side effect it still produces happens before close()
      // returns, not stragglingly after (the race a caller that restores a
      // console.error spy right after close() — e.g. a test's cleanup stack —
      // would otherwise lose to).
      if (inFlightPendingRetryTick) {
        try {
          await inFlightPendingRetryTick;
        } catch {
          // no-op — the tick's own catch already handled/logged its error.
        }
      }
      if (swarmJoinRetryTimer) {
        try {
          // WI-752 join-retry — same self-rearming-chain shape; `stopped`
          // (set above) prevents a mid-tick re-arm.
          clearTimeout(swarmJoinRetryTimer);
        } catch {
          // no-op
        }
      }
      // Leave the swarm before tearing down the store so we stop receiving
      // peer replication onto an about-to-close corestore.
      if (swarmHandle) {
        try {
          await swarmHandle.close();
        } catch {}
      }
      // Close via closeHarnessStore (NOT a bare store.close()) so the closed
      // Corestore is EVICTED from the getHarnessStore cache — a bare close would
      // leave the dead instance cached and trip "Corestore is closed" on the next
      // boot. (A re-key never reaches here: rekeyHarness/handle.rekey leave the
      // old topic + join the new one WITHOUT closing the store — see boot-all.ts.)
      try {
        await closeHarnessStore(storeOpts);
      } catch {}
      // P-006: the scoped store is a separate Corestore instance — close +
      // evict it the same way (it was only opened if a swarm join ran).
      try {
        await closeHarnessScopedStore(storeOpts);
      } catch {}
      // P-003: an off-gate compaction may still be folding. Awaited AFTER the store
      // closes so its reads fail fast instead of finishing an O(history) fold; it saw
      // `stopped` and appends nothing (`shouldAbort`). It never rejects.
      if (ownCompactionInFlight) await ownCompactionInFlight;
      recordBootEvent(opts.workspaceId, opts.harnessSlug, 'close');
    },
  };
}

/**
 * Subscribe to the substrate's schema-version alerts. Returns an
 * unsubscribe function. The UI surfaces these as "newer Papercusp
 * available" toasts per D-024.
 */
export function onSchemaVersionAlert(handler: (alert: SchemaVersionAlert) => void): () => void {
  schemaVersionEvents.on('alert', handler);
  return () => {
    schemaVersionEvents.off('alert', handler);
  };
}
