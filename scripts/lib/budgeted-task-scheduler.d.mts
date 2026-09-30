export interface TaskBudgetInput {
  workerBudget: number | string;
  memoryBudgetMb: number | string;
  workerMemoryMb: number | string;
  maxConcurrentTasks?: number | string;
  reserveWorkers?: number | string;
  taskCgroupPidsMax?: number | string | null;
  pidsPerConcurrentTask?: number | string;
  pidsReserve?: number | string;
}

export interface ResolvedTaskBudget {
  workerBudget: number;
  memoryBudgetMb: number;
  workerMemoryMb: number;
  memoryWorkerBudget: number;
  effectiveWorkerBudget: number;
  maxConcurrentTasks: number;
  configuredMaxConcurrentTasks: number;
  pidsMaxConcurrentTasks: number | null;
  taskCgroupPidsMax: number | null;
  pidsPerConcurrentTask: number;
  pidsReserve: number;
  taskBoundBy: "pids" | "ceiling";
  reserveWorkers: number;
  mode: "parallel" | "serial";
  primaryWorkers: number;
  reserveLaneWorkers: number;
  /**
   * Which constraint actually bound the budget. `resolveTaskBudget` always sets it
   * (budgeted-task-scheduler.mjs:140), but `formatTaskBudgetMarker` re-derives it with a
   * `??` fallback for stats objects assembled elsewhere — so it is optional here to keep
   * both callers representable.
   */
  boundBy?: "memory" | "ceiling";
  /**
   * The measured available memory, present only when the caller measured it — its
   * ABSENCE is meaningful (the marker omits the field rather than printing a guess), so
   * this is nullable as well as optional.
   */
  memAvailableMb?: number | string | null;
  /** Hard memory.max of the current task cgroup, when finite. */
  taskCgroupMemoryMaxMb?: number | string | null;
}

export interface TaskAllocation {
  lane: "primary" | "reserved" | "serial";
  workers: number;
  memoryMb: number;
}

/**
 * What `formatTaskBudgetObservedMarker` ACCEPTS. The admission terms are optional here on
 * purpose: the formatter is deliberately defensive so a hand-built stats object (tests, older
 * callers) still renders the legacy marker string. That tolerance is a real part of the
 * contract, so it is stated in the type rather than left to a runtime `?? `.
 */
export interface TaskSchedulerObserved extends ResolvedTaskBudget {
  observedMaxWorkers: number;
  observedMaxMemoryMb: number;
  observedMaxTasks: number;
  memoryReadings?: number | null;
  admissionClamps?: number | null;
  minAdmittedWorkers?: number | null;
  lastMemAvailableMb?: number | null;
}

/**
 * What `runBudgetedTasks` PRODUCES — the same shape with every admission term REQUIRED, because
 * a real run always populates all four. Keeping them required here is what stops a future
 * change from silently dropping one and under-reporting the clamp.
 */
export interface TaskSchedulerStats extends TaskSchedulerObserved {
  /**
   * How many times admission re-measured available memory, or `null` when no
   * `readMemAvailableMb` was supplied. `null` and `0` are DIFFERENT facts — "nobody measured"
   * vs "a reader was wired but never consulted" — and `formatTaskBudgetObservedMarker`
   * distinguishes them by exactly this null (EI-20801764054303492).
   */
  memoryReadings: number | null;
  /** Admissions the memory reading narrowed below the lane width. */
  admissionClamps: number;
  /** Narrowest width ever admitted, or `null` when no reader was supplied. */
  minAdmittedWorkers: number | null;
  /** Last finite reading, or `null` when unread/unreadable. */
  lastMemAvailableMb: number | null;
}

export function formatTaskBudgetObservedMarker(
  stats: TaskSchedulerObserved,
): string;

export interface ScheduledTaskResult<Task, Value> {
  task: Task;
  index: number;
  allocation: TaskAllocation;
  value: Value;
}

export interface BudgetedTaskRun<Task, Value> {
  results: Array<ScheduledTaskResult<Task, Awaited<Value>>>;
  stats: TaskSchedulerStats;
}

export interface AffectedBlastRadius {
  kind: "scoped" | "near-tree-wide";
  reason:
    | "path-closure"
    | "root-manifest-or-config"
    | "all-requested"
    | "derivation-degraded";
  triggerPaths: string[];
}

export interface AffectedTaskShard<Task> {
  index: number;
  tasks: Task[];
  taskKeys: string[];
}

export interface AffectedTaskShardPlan<Task> {
  blastRadius: AffectedBlastRadius;
  maxTasksPerShard: number;
  taskCount: number;
  shards: Array<AffectedTaskShard<Task>>;
}

export interface BudgetedTaskWallProjection {
  /** History-based elapsed-wall projection; unknown task durations contribute zero. */
  projectedWallMs: number;
  /** Serial-equivalent sum retained for diagnosis; it is not elapsed wall time. */
  knownWorkMs: number;
  knownTasks: number;
  unknownTasks: number;
  mode: "parallel" | "serial";
  maxConcurrentTasks: number;
}

export interface DurationHistoryEntry {
  durationMs: number;
  samples: number;
  updatedAt: string;
  /**
   * Decayed high-water duration. OPTIONAL because a legacy entry written before the peak was
   * tracked has no `peakMs`, and every reader (timeoutDurationEstimate, mergeDurationHistory)
   * treats a missing value as "seed from the EWMA" rather than zero.
   */
  peakMs?: number;
}

export interface DurationHistory {
  version: number;
  tasks: Record<string, DurationHistoryEntry>;
}

export const DURATION_HISTORY_VERSION: number;
export const PIDS_PER_CONCURRENT_TASK: number;
export const PIDS_RESERVE: number;

export function resolveGlobalWorkerBudget(input: {
  affectedWorkerBudget?: number | string;
  vitestMaxWorkers?: number | string;
  vitestMaxForks?: number | string;
  vitestMaxThreads?: number | string;
  fallback: number | string;
}): number;

/**
 * WI-10002092: `taskCgroupMemoryMaxMb` arms the credibility test that stops an inherited
 * `--max-old-space-size` heap CEILING being read as a per-worker RESERVATION. Omit it (or pass
 * the `null` an unbounded/unreadable cgroup yields) and every heap candidate stands, which is the
 * pre-fix behaviour. `onNotice` reports each disregarded candidate.
 */
export function resolveWorkerMemoryMb(input: {
  affectedWorkerMemoryMb?: number | string;
  nodeOptions?: string;
  fallback: number | string;
  taskCgroupMemoryMaxMb?: number | string | null;
  cgroupReserveFraction?: number;
  onNotice?: (line: string) => void;
}): number;

/**
 * Headroom held back from MemAvailable before any worker token is paid for — shared by the
 * startup budget (resolveMemoryBudgetMb) and the per-admission re-check
 * (admissibleWorkersForMemory) so the two rails cannot drift apart (EI-20801764054303492).
 */
export const MEMORY_RESERVE_FRACTION: number;

export function resolveMemoryBudgetMb(input: {
  affectedGlobalMemoryMb?: number | string;
  memAvailableMb?: number | string | null;
  taskCgroupMemoryMaxMb?: number | string | null;
  workerBudget: number | string;
  workerMemoryMb: number | string;
  reserveFraction?: number;
  cgroupReserveFraction?: number;
}): number;

export function readTaskCgroupMemoryMaxMb(input?: {
  readFile?: (path: string, encoding: string) => string | Buffer;
  procCgroupPath?: string;
  cgroupRoot?: string;
}): number | null;

export function readTaskCgroupPidsMax(input?: {
  readFile?: (path: string, encoding: string) => string | Buffer;
  procCgroupPath?: string;
  cgroupRoot?: string;
}): number | null;

export function readTaskCgroupPidsEventMax(input?: {
  readFile?: (path: string, encoding: string) => string | Buffer;
  procCgroupPath?: string;
  cgroupRoot?: string;
}): number | null;

export function pidsEventRefusalDelta(input: {
  start: number | null;
  end: number | null;
  hasFailures: boolean;
}): number;

export function classifyAffectedBlastRadius(input?: {
  changedPaths?: string[];
  runAll?: boolean;
  derivationDegraded?: boolean;
}): AffectedBlastRadius;

export function planAffectedTaskShards<Task>(
  tasks: Task[],
  options?: {
    blastRadius?: AffectedBlastRadius;
    maxTasksPerShard?: number | string;
    taskKey?: (task: Task, index: number) => string | number;
  },
): AffectedTaskShardPlan<Task>;

/**
 * Project elapsed wall time using the scheduler's actual longest/shortest concurrent lanes.
 * This is a history-based estimate, not a lower-bound proof; `knownWorkMs` is the separate
 * serial-equivalent sum and `unknownTasks` makes uncovered work explicit.
 */
export function estimateBudgetedTaskWallMs<Task>(
  plan: AffectedTaskShardPlan<Task>,
  options: TaskBudgetInput & {
    estimateMs?: (task: Task, index: number) => number | null | undefined;
  },
): BudgetedTaskWallProjection;

export function formatAffectedTaskShardMarker(
  plan: AffectedTaskShardPlan<unknown>,
  taskCgroupMemoryMaxMb?: number | null,
): string;

export function resolveTaskBudget(input: TaskBudgetInput): ResolvedTaskBudget;

/**
 * Per-admission memory re-check: clamps a lane's worker count to what the measured
 * MemAvailable (minus the reserve fraction) can afford. A missing/broken reading returns the
 * configured lane width unchanged — an instrument failure must never read as "no memory".
 */
export function admissibleWorkersForMemory(input: {
  laneWorkers: number | string;
  workerMemoryMb: number | string;
  memAvailableMb?: number | string | null;
  reserveFraction?: number;
}): number;

/**
 * WI-1490656 — observability + bounding for the shared `papercusp-test-process-admission`
 * mutex every scheduler invocation acquires.
 */
export interface AdmissionNoticeInfo {
  kind: 'queued' | 'granted';
  /** Present on `queued`: how long this acquisition has been waiting so far. */
  elapsedMs?: number;
  /** Present on `granted`: how long this acquisition ended up queued. */
  waitedMs?: number;
  /** The bound this acquisition was actually given. */
  budgetMs: number;
}

export interface SharedAdmissionOptions {
  /**
   * Sink for queue notices. DEFAULTS to `console.error`, which cannot reach the
   * affected-tests run log — the runner injects a sink that writes both, so a queued run
   * explains itself in the file its own BEGIN line tells a triager to grep.
   */
  onAdmissionNotice?: (line: string, info: AdmissionNoticeInfo) => void;
  /** Fires once per acquisition, with how long it queued and the bound it was given. */
  onAdmissionAcquired?: (info: { waitedMs: number; budgetMs: number }) => void;
  /**
   * EI-21917992245424964 — a self-description published into the admission mutex's owner
   * record, so a BLOCKED peer can judge whether waiting is worth it without a coord
   * round-trip and without this holder being awake to answer.
   *
   * Scalars only (bounded and key-capped by `fs-mutex`); anything else is dropped rather
   * than coerced, so a missing field keeps reading as "not declared".
   */
  admissionIntent?: Record<string, string | number | boolean>;
}

/**
 * EI-21917992245424964 — render a holder's owner record as ONE decision-shaped line for the
 * queued notice, which is re-announced for the whole wait. Emits `intent=undeclared` rather
 * than omitting the field, and falls open to the raw text on any parse failure.
 */
export function formatAdmissionHolder(ownerText: unknown, now?: number): string;

/**
 * WI-2142172 — render the WAITER's own prognosis as a clause appended to the queued notice:
 * can this caller plausibly be admitted before its budget runs out?
 *
 * Returns "" when there is nothing sound to say. The holder's `etaProjectedSec` is a
 * concurrency-aware history projection, not a proof, so warning text keeps the uncertainty
 * explicit (`PROJECTED TO STARVE` at >=1.0 of the remaining budget, `ADMISSION AT RISK` at
 * >=0.5) and never certifies safety. An ETA covering 0 tasks is reported as `PROSPECT UNKNOWN`
 * rather than skipped. Legacy holders that only publish `etaMinSec` are also unknown because
 * their serial-equivalent sum cannot establish wall time. Falls open to "" on any parse
 * failure; it prints while a caller is already blocked and must never be the thing that throws.
 */
export function formatAdmissionProspect(
  ownerText: unknown,
  waiter: { elapsedMs: number; budgetMs: number },
  now?: number,
): string;

/**
 * WI-1639265 — the launcher-published wall-clock deadline, absolute epoch ms.
 *
 * Must stay byte-identical to `TASK_DEADLINE_EPOCH_MS_ENV` in
 * `packages/operator-core/lib/systemd-scope.ts` (the producer); an ABSENT variable
 * legitimately means "no deadline was set", so a rename on either side would silently
 * restore the pre-fix behaviour. Pinned by `affected-tests-deadline-admission.test.ts`.
 */
export const TASK_DEADLINE_EPOCH_MS_ENV: 'PAPERCUSP_TASK_DEADLINE_EPOCH_MS';

/** The deadline, or null for UNKNOWN — never "unbounded and fine". */
export function readTaskDeadlineEpochMs(
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): number | null;

export const TASK_DEADLINE_REFUSAL_MARKER: 'TASK_DEADLINE_REFUSAL';

/**
 * `knownEstimateMs`/`knownTasks` are a LOWER BOUND over tasks with duration history;
 * `unknownTasks` is reported beside them so the sum is never read as a total.
 */
export function formatTaskDeadlineRefusal(input: {
  remainingMs: number;
  knownEstimateMs: number;
  knownTasks: number;
  unknownTasks: number;
}): string;

/** Does this error mean "we were never going to fit inside our own deadline"? */
export function isTaskDeadlineRefusal(error: unknown): boolean;

/** The whole-invocation queue budget shared across every shard of one run. */
export const SHARED_TEST_PROCESS_ADMISSION_RUN_BUDGET_MS: number;

/**
 * WI-1746759: which admission lane this process belongs in — the release gate gets its own,
 * everyone else shares one, so the gate's per-shard re-queueing cannot be starved by (and
 * cannot starve) ad-hoc agent runs.
 *
 * ⚠ Keyed on `PC_HEAVY_RELEASE_GATE === "1"` ONLY, never `GREEN_CHECKPOINT` — agents export
 * that second marker by hand to reproduce the gate's skip-set, so keying a private lane off
 * it would let any agent leave the queue its peers wait in.
 */
export function admissionMutexName(env?: Record<string, string | undefined>): string;

/**
 * True when an error means "never admitted" rather than "a test failed". A caller that
 * misclassifies it exits with no verdict, which the green-checkpoint records as a lost run.
 */
export function isSharedAdmissionTimeout(error: unknown): boolean;

export function runBudgetedTasks<Task, Value>(
  tasks: Task[],
  options: TaskBudgetInput & SharedAdmissionOptions & {
    /** Bound for THIS acquisition. Defaults to the per-acquisition admission timeout. */
    admissionTimeoutMs?: number;
    estimateMs?: (task: Task, index: number) => number | null | undefined;
    /**
     * OPT-IN live memory reading, consulted before every admission after the run's first.
     * ABSENT ⇒ allocations are byte-identical to the pre-clamp scheduler (the back-compat
     * contract). Present ⇒ admission may only ever admit FEWER workers, never more. A reader
     * that returns null/non-finite, or throws, leaves the lane width unchanged: a broken
     * instrument must not read as "no memory" (EI-20801764054303492).
     */
    readMemAvailableMb?: () => number | null | undefined;
    runTask: (
      task: Task,
      allocation: TaskAllocation,
      index: number,
    ) => Value | Promise<Value>;
    onTaskSettled?: (
      entry: ScheduledTaskResult<Task, Awaited<Value>>,
    ) => void | Promise<void>;
  },
): Promise<BudgetedTaskRun<Task, Value>>;

export function runBudgetedTaskShards<Task, Value>(
  plan: AffectedTaskShardPlan<Task>,
  options: TaskBudgetInput & SharedAdmissionOptions & {
    /**
     * Total queue time this run may spend across ALL shards. Each shard is its own
     * acquisition whose own timeout restarts at zero, so without one shared budget an
     * N-shard run's real admission bound is N × the per-acquisition timeout.
     */
    admissionRunBudgetMs?: number;
    /**
     * WI-1639265: the caller's absolute wall-clock deadline, epoch ms. OMITTED reads it from
     * `TASK_DEADLINE_EPOCH_MS_ENV`; an explicit `null` means "this caller has no deadline"
     * and skips every deadline check, which is the pre-fix behaviour exactly.
     */
    deadlineEpochMs?: number | null;
    estimateMs?: (task: Task, index: number) => number | null | undefined;
    readMemAvailableMb?: () => number | null | undefined;
    runTask: (
      task: Task,
      allocation: TaskAllocation,
      index: number,
    ) => Value | Promise<Value>;
    onTaskSettled?: (
      entry: ScheduledTaskResult<Task, Awaited<Value>>,
    ) => void | Promise<void>;
  },
): Promise<
  BudgetedTaskRun<Task, Value> & {
    shardStats: Array<
      TaskSchedulerStats & { index: number; taskCount: number }
    >;
    shardPlan: AffectedTaskShardPlan<Task>;
  }
>;

export function emptyDurationHistory(): DurationHistory;

export function readDurationHistory(path: string): DurationHistory;

export function durationEstimate(
  history: DurationHistory,
  key: string,
): number | null;

/**
 * Like {@link durationEstimate}, but for sizing a TIMEOUT rather than for ordering: it returns
 * the max of the EWMA and the decayed peak, so a bimodal task's slow mode keeps its headroom
 * through a run of fast completions.
 */
export function timeoutDurationEstimate(
  history: DurationHistory,
  key: string,
): number | null;

export function mergeDurationHistory(
  history: DurationHistory,
  observations: Array<{ key: string; durationMs: number }>,
  now?: string,
): DurationHistory;

export function writeDurationHistoryAtomic(
  path: string,
  history: DurationHistory,
  nonce?: string,
): void;

export function formatTaskBudgetMarker(
  stats: ResolvedTaskBudget,
  prefix?: string,
): string;
