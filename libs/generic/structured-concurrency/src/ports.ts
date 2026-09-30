/**
 * ports — the injected seams. Everything host-specific (durable storage, lock release,
 * notification, escalation) enters the toolkit through one of these. A host implements
 * the stores over its substrate (PG, in-memory, …) and binds the effects to its
 * coordination layer; the algorithms in nursery/supervision/governor/saga name none of
 * it.
 */
import type { IntensityResult, SpawnNode, SpawnStatus, RestartStrategy } from './types';

// ── Spawn-tree store ──────────────────────────────────────────────────────────────

export interface RecordSpawnInput {
  spawnId: string;
  workspaceId: string;
  runId: string;
  childRole: string;
  harnessSlug?: string | null;
  parentSpawnId?: string | null;
  parentRole?: string | null;
  featureId?: string | null;
  chunkId?: string | null;
  planSlug?: string | null;
  itemId?: string | null;
  /** Resource-owning identity — REQUIRED for transitive cancellation to release this
   *  node's locks/claims. Pass it whenever the spawner knows it. */
  sessionOwner?: string | null;
  coordinationDomain?: string;
  restartStrategy?: RestartStrategy;
  status?: SpawnStatus;
  /** Opaque host annotations: the model spec/tier this spawn was resolved to run at
   *  (per-spawn override observability). Carried, never interpreted. */
  modelSpec?: string | null;
  modelTier?: string | null;
  /** Opaque host annotation: the parent-authored brief that started this spawn. */
  brief?: string | null;
}

export interface FinishSpawnInput {
  spawnId: string;
  workspaceId: string;
  status: SpawnStatus;
  exitCode?: number | null;
  errorMessage?: string | null;
  outputTail?: string | null;
}

export interface SubtreeQuery {
  workspaceId: string;
  rootSpawnId: string;
  /** Include the root itself (default true). */
  includeRoot?: boolean;
}

/**
 * Outcome of the atomic phase-1 cancel: which active nodes this call transitioned, which
 * were already terminal, and a host-defined tally of the resources released in the same
 * transaction (e.g. `{ claims: n, planClaims: m }`). The toolkit treats `resourcesReleased`
 * as opaque counts to report back; it never inspects the keys.
 */
export interface CancelActiveResult {
  cancelled: SpawnNode[];
  alreadyTerminal: string[];
  resourcesReleased: Record<string, number>;
}

/** A handle for one in-flight intensity transaction (FOR-UPDATE row lock semantics). */
export interface RestartWindowRow {
  restartCount: number;
  restartWindowStart: Date | null;
}

/**
 * The durable spawn tree. All compound operations that need atomicity are single
 * methods so the implementation owns the transaction boundary (a PG `BEGIN … FOR
 * UPDATE`, an in-memory mutex, …). The toolkit never assembles its own transaction.
 */
export interface SpawnTreeStore {
  recordSpawn(input: RecordSpawnInput): Promise<void>;
  finishSpawn(input: FinishSpawnInput): Promise<void>;
  getSpawn(workspaceId: string, spawnId: string): Promise<SpawnNode | null>;
  getSubtree(query: SubtreeQuery): Promise<SpawnNode[]>;
  /** Count ACTIVE descendants of a parent, transitively (the completion-gate input). */
  openChildren(workspaceId: string, parentSpawnId: string): Promise<number>;
  /** Direct children of a parent (one level), ordered oldest-first. */
  directChildren(workspaceId: string, parentSpawnId: string): Promise<SpawnNode[]>;
  /**
   * Atomically: read the subtree, mark every ACTIVE node cancelled with `reason`, and
   * release each node's host-specific resources (claims) — all in ONE transaction.
   * Idempotent: a node already terminal is left untouched and reported in
   * `alreadyTerminal`. Returns the nodes THIS call transitioned.
   */
  cancelActiveSubtree(opts: { workspaceId: string; rootSpawnId: string; reason: string }): Promise<CancelActiveResult>;
  /**
   * Atomically record one restart against a spawn's sliding window (row-locked so two
   * concurrent crash reports can't both read count=N). `decide` is the pure windowing
   * policy; the store supplies the locked row and persists the decision. Returns null
   * if the spawn is gone.
   */
  recordRestartIntensity(
    opts: { workspaceId: string; spawnId: string; maxRestarts: number; windowSec: number },
    decide: (row: RestartWindowRow, nowMs: number) => IntensityDecision,
  ): Promise<IntensityResult | null>;
  /** Mark a set of spawns 'restarting' (clearing finished_at) — the orchestrator re-runs them. */
  markRestarting(workspaceId: string, spawnIds: string[]): Promise<void>;
  /** Mark a spawn 'failed' with a reason (the crash-loop root). */
  markFailed(workspaceId: string, spawnId: string, reason: string): Promise<void>;
}

/** The pure windowing decision recordRestartIntensity asks the toolkit to make. */
export interface IntensityDecision {
  count: number;
  windowStartMs: number;
  windowReset: boolean;
  intensityExceeded: boolean;
}

// ── Lock-release + notify effects (transitive cancellation) ─────────────────────────

/** A (lock partition, owner) pair whose every lock should be released. */
export interface LockTarget {
  coordinationDomain: string;
  owner: string;
}

export interface LockReleaseResult {
  /** Distinct owners whose locks were swept. */
  owners: string[];
  /** File-lock paths freed. */
  filePathsReleased: number;
  /** Named resource locks freed. */
  resourcesReleased: number;
}

/** The injected "release every lock these owners hold, NOW" effect. */
export type LockReleaser = (targets: LockTarget[]) => Promise<LockReleaseResult>;

/** The coord cancellation notice the nursery pushes to each cancelled descendant. */
export interface CancelNotice {
  toOwners: string[];
  rootSpawnId: string;
  reason: string;
  cancelledSpawnIds: string[];
}
export type CancelNotifier = (notice: CancelNotice) => Promise<void>;

/** The injected human-escalation effect (used when a crash-loop breaches the budget). */
export type EscalateFn = (input: { severity: 'blocker'; summary: string; body?: string }) => Promise<{ msg_id: string }>;

// ── Governor store (backpressure) ───────────────────────────────────────────────────

export interface BucketRow {
  capacity: number;
  refillPerSec: number;
  tokens: number;
  updatedAtMs: number | null;
}
export interface CircuitRow {
  state: 'closed' | 'open' | 'half_open';
  failures: number;
  threshold: number | null;
  cooldownSec: number | null;
  openedAtMs: number | null;
}
export interface CreditRow {
  credits: number;
  creditMax: number | null;
}

/** A patch to a circuit row. An absent field is left unchanged (so a single write can
 *  flip just the state, or state+failures+opened-at together). */
export interface CircuitPatch {
  state?: 'closed' | 'open' | 'half_open';
  failures?: number;
  /** When present, set cb_opened_at to this wall-clock ms; absent = leave unchanged. */
  openedAtMs?: number;
}

/** A transactional unit-of-work over the governor rows (FOR-UPDATE read + write). */
export interface GovernorTx {
  lockCircuit(workspaceId: string, scopeKey: string): Promise<CircuitRow | null>;
  setCircuit(workspaceId: string, scopeKey: string, patch: CircuitPatch): Promise<void>;
  lockBucket(workspaceId: string, scopeKey: string): Promise<BucketRow | null>;
  setBucketTokens(workspaceId: string, scopeKey: string, tokens: number, nowMs: number): Promise<void>;
  lockCredit(workspaceId: string, scopeKey: string): Promise<CreditRow | null>;
  consumeCredit(workspaceId: string, scopeKey: string): Promise<void>;
}

export interface GovernorStore {
  configureBucket(opts: { workspaceId: string; scopeKey: string; capacity: number; refillPerSec: number; tokens?: number; nowMs?: number }): Promise<void>;
  configureCircuit(opts: { workspaceId: string; scopeKey: string; threshold: number; cooldownSec: number }): Promise<void>;
  configureCredits(opts: { workspaceId: string; scopeKey: string; credits: number; max?: number }): Promise<void>;
  grantCredits(opts: { workspaceId: string; scopeKey: string; n: number }): Promise<number>;
  recordCircuitSuccess(opts: { workspaceId: string; scopeKey: string }): Promise<void>;
  /** Run `fn` inside a single transaction (every lock* read is FOR-UPDATE; writes commit at the end). */
  transaction<T>(fn: (tx: GovernorTx) => Promise<T>): Promise<T>;
}

// ── Saga journal + tombstone store ──────────────────────────────────────────────────

export interface SagaStepLog {
  name: string;
  status: 'pending' | 'done' | 'failed' | 'compensated' | 'compensate_failed';
  error?: string;
}

export interface SagaJournal {
  create(opts: { workspaceId: string; sagaId: string; name: string; steps: SagaStepLog[] }): Promise<void>;
  update(opts: { workspaceId: string; sagaId: string; steps: SagaStepLog[]; status: string; error?: string }): Promise<void>;
}

export interface TombstoneRef {
  workspaceId: string;
  refKind: string;
  refId: string;
}

export interface TombstoneStore {
  upsert(ref: TombstoneRef, opts: { reason: string; deletedBy: string | null; deletedAtMs: number; gcAfterMs: number }): Promise<void>;
  restore(ref: TombstoneRef): Promise<boolean>;
  isTombstoned(ref: TombstoneRef): Promise<boolean>;
  /** Remove tombstones past `nowMs` (and not restored); return the `<kind>:<id>` refs now safe to
   *  physically destroy. `nowMs` omitted ⇒ the store uses its own wall clock. */
  gcExpired(opts: { workspaceId: string; refKind?: string; nowMs?: number }): Promise<string[]>;
}
