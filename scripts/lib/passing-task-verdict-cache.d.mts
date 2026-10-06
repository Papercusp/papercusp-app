export const PASSING_TASK_VERDICT_CACHE_VERSION: number;
export const PASSING_TASK_VERDICT_IMPLEMENTATION_VERSION: string;
export const PASSING_TASK_VERDICT_CACHE_MAX_GROUPS: number;
export const PASSING_TASK_VERDICT_CROSS_RUN_GROUP: string;
export const PC_HEAVY_VOLATILE_IDENTITY_ENV: readonly string[];
/** WI-10003603: per-invocation transport paths affected-tests stamps into a task's child env; never a task input. */
export const AFFECTED_TESTS_TRANSPORT_IDENTITY_ENV: readonly string[];
export const PASSING_TASK_SHARED_ROOT_INPUTS: readonly string[];
export const PASSING_TASK_SHARED_RUNTIME_INPUTS: readonly string[];
export const PASSING_TASK_SHARED_MODULE_INPUTS: readonly string[];

export interface PassingTaskVerdictIdentity {
  taskKey: string;
  fingerprint: string;
  components: {
    command: string;
    environment: string;
    gateConfig: string;
    implementation: string;
    dependencyClosure: string;
  };
}

export interface PassingTaskVerdictCache {
  version: number;
  groups: Record<string, {
    updatedAt: string;
    entries: Record<string, {
      fingerprint: string;
      components: PassingTaskVerdictIdentity["components"];
      passedAt: string;
    }>;
  }>;
}

export function stableJson(value: unknown): string;
export function passingTaskVerdictIdentityEnvironment(
  environment: Record<string, unknown>,
): {
  environment: Record<string, unknown>;
  proofGroupApplied: boolean;
  cacheGroup: string | null;
};
export function passingTaskVerdictCrossRunIdentityEnvironment(
  environment: Record<string, unknown>,
): {
  environment: Record<string, unknown>;
  cacheGroup: string;
};
/**
 * gateConfig analogue of `passingTaskVerdictCrossRunIdentityEnvironment`: drops the fields that
 * describe how much machine/time a run was handed (`affectedBase`, and the duration-history-derived
 * `batchTimeout.effectiveMs`/`.source`) while keeping the static timeout policy, so two runs over a
 * byte-identical tree produce the same cross-run identity.
 */
export function passingTaskVerdictCrossRunGateConfig(
  gateConfig: Record<string, unknown>,
): Record<string, unknown>;
export function formatPassingTaskVerdictSummary(
  decisions: Array<{ status?: string; reason?: string }>,
  options?: {
    proofGroupApplied?: boolean;
    cacheGroup?: string | null;
    // Present in the runtime since the cross-run work; omitting it here made a legal call fail
    // typecheck as an excess property (same drift class as EI-21641681059912531).
    cacheScope?: string | null;
  },
): string;
export function namespacePassingTaskVerdictDecision<
  Decision extends { hit: boolean; reason?: string },
>(
  decision: Decision,
  namespace: string,
): Omit<Decision, "reason"> & { reason: string };
export function emptyPassingTaskVerdictCache(): PassingTaskVerdictCache;
export function readPassingTaskVerdictCache(path: string): {
  cache: PassingTaskVerdictCache;
  reason: string;
};
export function writePassingTaskVerdictCacheAtomic(
  path: string,
  cache: PassingTaskVerdictCache,
  nonce?: string,
): void;
export function passingTaskVerdictCacheEntry(
  cache: PassingTaskVerdictCache,
  cacheGroup: string | null,
  taskKey: string,
): PassingTaskVerdictCache["groups"][string]["entries"][string] | undefined;
/**
 * Shared so `passingTaskVerdictDependencyProvenance` cannot drift from the hash it delegates to —
 * they returned different declared shapes once, and only the .d.mts knew.
 */
export type DependencyClosureProof =
  | {
      ok: true;
      hash: string;
      /** Membership only — moves when a file enters/leaves the closure, not when bytes change. */
      listHash: string;
      fileCount: number;
      /** The sorted closure, so a miss can be diffed without re-deriving it. */
      files: string[];
    }
  | { ok: false; reason: string };
export type ResolvedDependencyClosureProof = Extract<
  DependencyClosureProof,
  { ok: true }
>;

export function hashDependencyFileSet(args: {
  root: string;
  files: string[];
  unavailable?: string[];
  digestCache?: Map<string, unknown>;
}): DependencyClosureProof;
export type SharedInputProvenance =
  | { ok: true; files: string[] }
  | { ok: false; reason: string };
export function passingTaskVerdictSharedInputProvenance(args: {
  root: string;
  trackedScan: { files: string[]; unscannedPresent: string[] };
}): SharedInputProvenance;
export type TaskVerdictDependencyProvenance =
  | {
      ok: true;
      /** Workspace/dependency inputs that describe what the task semantically tests. */
      semantic: ResolvedDependencyClosureProof;
      /** Shared runner/config inputs that describe how the task executes. */
      execution: ResolvedDependencyClosureProof | null;
      /** Legacy aggregate fields; new cache identity code must use `semantic`. */
      hash: string;
      listHash: string;
      fileCount: number;
      files: string[];
    }
  | { ok: false; reason: string };
export function passingTaskVerdictDependencyProvenance(args: {
  root: string;
  taskKey: string;
  script: string;
  workspaceName: string;
  workspaces: Map<string, { dir: string; deps: string[] }>;
  trackedScan: { files: string[]; unscannedPresent: string[] };
  repoWideTaskKeys: Set<string>;
  sharedInputProvenance?: SharedInputProvenance | null;
  digestCache?: Map<string, unknown>;
}): TaskVerdictDependencyProvenance;
export function shouldStorePassingTaskVerdict(args: {
  enabled: boolean;
  cacheStatus?: string;
  initialStatus?: number | null;
  finalStatus?: number | null;
  absorptionRan: boolean;
  identity?: PassingTaskVerdictIdentity | null;
}): boolean;
export function buildPassingTaskVerdictIdentity(args: {
  taskKey: string;
  command: unknown;
  commandRoot?: string | null;
  environment: unknown;
  gateConfig: unknown;
  dependencyHash: string;
  implementationVersion?: string;
}): PassingTaskVerdictIdentity;
export function decidePassingTaskVerdict(args: {
  enabled: boolean;
  cacheRead?: { reason: string };
  entry?: PassingTaskVerdictCache["groups"][string]["entries"][string];
  identity?: PassingTaskVerdictIdentity | null;
}): { hit: boolean; reason: string };
export function passingTaskVerdictEntry(
  identity: PassingTaskVerdictIdentity,
  passedAt?: string,
): PassingTaskVerdictCache["groups"][string]["entries"][string];
export function mergePassingTaskVerdictUpdates(
  cache: PassingTaskVerdictCache,
  cacheGroup: string | null,
  updates: PassingTaskVerdictCache["groups"][string]["entries"],
  updatedAt?: string,
): PassingTaskVerdictCache;

// --- WI-595883: shell-volatile identity + miss diagnostics (plan D-010) ---

/** Written by the SHELL to describe the invocation, never the task. Cross-run identity only. */
export const SHELL_VOLATILE_IDENTITY_ENV: readonly string[];

/**
 * EI-21762403020037943 — env names `capability:bash` stamps into every child it spawns. They
 * describe WHICH DOOR the command was typed through, never what it exercises. Cross-run identity
 * only; derived-and-pinned by `affected-tests-passing-verdict-cache.test.ts`.
 */
export const CAPABILITY_BASH_SEAM_IDENTITY_ENV: readonly string[];

export const CLOSURE_DIGEST_MANIFEST_VERSION: number;
export const CLOSURE_DIGEST_MANIFEST_MAX_FILES: number;

/** `${kind}:${mode}:${digest}` — one file's identity AS THE CLOSURE HASH SEES IT. */
export type ClosureDigestToken = string;

export interface ClosureDigestManifest {
  version: number;
  updatedAt: string | null;
  /** repo-relative path -> digest token */
  files: Record<string, ClosureDigestToken>;
  /** taskKey -> closure shape */
  tasks: Record<string, { fileCount: number; listHash: string }>;
  /** cacheGroup -> { envKey: digest }. Digests only — this environment carries credentials. */
  identityEnv: Record<string, Record<string, string>>;
}

export function closureDigestManifestPath(cachePath: string): string;
export function emptyClosureDigestManifest(): ClosureDigestManifest;
export function closureDigestToken(value: {
  kind: string;
  mode: number;
  digest: string;
}): ClosureDigestToken;
export function observedClosureDigests(
  root: string,
  digestCache: Iterable<[string, unknown]> | null | undefined,
): Record<string, ClosureDigestToken>;
export function readClosureDigestManifest(path: string): {
  manifest: ClosureDigestManifest;
  reason: string;
};
export function mergeClosureDigestManifest(args: {
  prior?: ClosureDigestManifest | null;
  observed: Record<string, ClosureDigestToken>;
  taskShapes?: Record<string, { fileCount: number; listHash: string }>;
  identityEnv?: Record<string, Record<string, string>>;
  updatedAt?: string;
  cap?: number;
}): ClosureDigestManifest;

export interface ClosureDelta {
  fileCount: number;
  priorFileCount: number | null;
  membershipChanged: boolean;
  changedCount: number;
  unknownPriorCount: number;
  changed: string[];
  unknownPrior: string[];
  /** The hash moved while every covered file is byte-, mode- and membership-identical. */
  unexplained: boolean;
}

export function diffClosureDigests(args: {
  prior?: ClosureDigestManifest | null;
  observed?: Record<string, ClosureDigestToken> | null;
  files?: string[] | null;
  listHash?: string;
  taskKey?: string;
  limit?: number;
}): ClosureDelta;

export function identityEnvDigests(
  environment: Record<string, unknown> | null | undefined,
): Record<string, string>;

export interface IdentityEnvDelta {
  known: boolean;
  changedCount: number;
  addedCount: number;
  removedCount: number;
  changedKeys: string[];
  addedKeys: string[];
  removedKeys: string[];
  unexplained: boolean;
}

export function diffIdentityEnvDigests(args: {
  prior?: Record<string, string> | null;
  observed?: Record<string, string> | null;
  limit?: number;
}): IdentityEnvDelta;

/** Keys only — never a raw environment value. */
export function formatIdentityEnvDeltaLine(args: {
  taskKey: string;
  reason: string;
  delta: IdentityEnvDelta;
  manifestReason: string;
}): string;

export function formatClosureDeltaLine(args: {
  taskKey: string;
  reason: string;
  delta: ClosureDelta;
  manifestReason: string;
}): string;
