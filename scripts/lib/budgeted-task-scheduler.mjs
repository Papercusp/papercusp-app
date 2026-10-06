import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withFsMutex } from "./fs-mutex.mjs";
// EI-21442389733525112: `task-exit-class.mjs` is dependency-free by design, so importing it
// here cannot reintroduce the coupling its own header warns about — and it is the one module
// that owns the refusal marker's grammar, for both the emitter below and the reader in
// `bash_output.ts`. A refusal that does not carry this marker is indistinguishable from a
// red test suite at every caller.
import { formatTaskBudgetRefusal } from "./task-exit-class.mjs";

export const DURATION_HISTORY_VERSION = 1;
// EI-21669294176320490: the scheduler's worker/task counters are local to one
// Node invocation.  A fleet of concurrent `test:affected` processes could
// therefore each admit its own "bounded" pool and multiply Vitest workers and
// Postgres clients until the host's acquire queues starved.  Reuse the proven
// filesystem mutex so the admission boundary is shared across invocations.
//
// Keep the stale window longer than the largest bounded test-process timeout:
// `withFsMutex` also confirms a same-host dead owner with kill(pid, 0), so a
// crashed holder is still reclaimed immediately without allowing a live,
// long-running test to be mistaken for an abandoned lock.
const SHARED_TEST_PROCESS_ADMISSION_MUTEX = "papercusp-test-process-admission";
// WI-1746759: the release gate's OWN admission lane.
//
// `runBudgetedTasks` takes this mutex ONCE PER SHARD (see the run-budget note below), so on
// the shared lane the gate does not queue once — it re-queues per shard, and every re-entry
// lands at the BACK of the FIFO queue behind whoever arrived meanwhile. Measured on the
// 2026-08-31T12:23:04Z run: `shards=17`, 46 `AFFECTED_TESTS_ADMISSION_QUEUED` notices, ZERO
// acquisitions in 45 minutes, and the run then died on the run budget having executed no
// tests at all (`tasks=130 failed=0 undeterminedTasks=130`). That is a NON-VERDICT, not a
// red — the gate learned nothing about the code and still consumed its hourly slot.
//
// `scripts/pc-heavy.sh` already exempts the gate from the OUTER semaphore and states the
// policy in as many words — "this exempts it from ADMISSION, never from PRIORITY" — keeping
// it deferential via `nice 10 + ionice 7` (EI-78) rather than by queueing. That exemption
// stopped short of this inner mutex, which is the layer that actually serializes. A separate
// lane restores the stated policy instead of inventing a new one: the gate's shards contend
// only with EACH OTHER, so it still runs one test process at a time and neither the gate nor
// the fleet is starved by the other.
//
// ⚠ DERIVED from the shared name, never hand-written. `isSharedAdmissionTimeout` below
// classifies a timeout by `message.includes(SHARED_TEST_PROCESS_ADMISSION_MUTEX)`, so
// EXTENDING the base name is what keeps a gate timeout classified as admission-starved.
// Give this lane an unrelated name and that check returns false for the gate: the error
// re-throws instead of becoming `status=refused reason=admission-starved`, no
// AFFECTED_TESTS_RESULT line is emitted, and green-checkpoint records a lost run — the exact
// failure WI-1490656 exists to prevent, landing only on the one caller nobody watches live.
const RELEASE_GATE_ADMISSION_MUTEX = `${SHARED_TEST_PROCESS_ADMISSION_MUTEX}-release-gate`;
const SHARED_TEST_PROCESS_ADMISSION_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const SHARED_TEST_PROCESS_ADMISSION_STALE_MS = 2 * 60 * 60 * 1_000;
const SHARED_TEST_PROCESS_ADMISSION_RETRY_MS = 250;
// WI-1490656: how often a still-queued caller re-announces itself. One notice at t≈0 is
// invisible to any observer who attaches later, which is how a queued run gets
// misdiagnosed as a wedge.
const SHARED_TEST_PROCESS_ADMISSION_NOTICE_INTERVAL_MS = 60 * 1_000;
// The whole-invocation queue budget. `SHARED_TEST_PROCESS_ADMISSION_TIMEOUT_MS` bounds ONE
// `withFsMutex` acquisition, and a sharded run acquires once PER SHARD — so the bound
// everyone believes is 4h is really shards × 4h (measured: a 126-task near-tree-wide gate
// run plans 16 shards ⇒ a 64h worst case). The green-checkpoint holds its singleton run
// lock for that entire time, so every later fire records `skipped-locked` and the gate
// stops producing verdicts at all. Bound the SUM instead, well inside the gate's own
// hourly cadence, so a starved run fails loudly and frees the lock for the next fire.
export const SHARED_TEST_PROCESS_ADMISSION_RUN_BUDGET_MS = 45 * 60 * 1_000;

/**
 * WI-1746759: which admission lane THIS process belongs in.
 *
 * ⚠ Keyed on `PC_HEAVY_RELEASE_GATE` ONLY — deliberately NOT `GREEN_CHECKPOINT`, and the two
 * are not interchangeable here even though the gate's environment carries both. `pc-heavy.sh`
 * records why, from an incident: GREEN_CHECKPOINT is double-duty (it also drives
 * `describe.skipIf` in load-/network-sensitive tests), so agents legitimately export it BY
 * HAND to reproduce the gate's skip-set — and keying admission off it once meant
 * `GREEN_CHECKPOINT=1 npm run test:affected` bypassed that semaphore at nice 0, "re-opening
 * the very hole this wrapper closes". Keying a private admission LANE off it would repeat
 * that a layer down: any agent exporting the marker would leave the queue its peers wait in.
 * `PC_HEAVY_RELEASE_GATE` is the dedicated key, set by `buildGreenCheckpointEnv` and
 * inherited by the whole child tree, which is why it is the only safe discriminator.
 *
 * Matches pc-heavy.sh's own test (`[ "${PC_HEAVY_RELEASE_GATE:-}" = "1" ]`): the literal "1",
 * not truthiness, so an empty or absent value stays on the shared lane.
 */
export function admissionMutexName(env = process.env) {
  return env?.PC_HEAVY_RELEASE_GATE === "1"
    ? RELEASE_GATE_ADMISSION_MUTEX
    : SHARED_TEST_PROCESS_ADMISSION_MUTEX;
}

/**
 * Does this error mean "we never got admitted", as opposed to a real test failure?
 *
 * Lives HERE, beside the acquisition that produces it, so the producer and the classifier
 * cannot drift apart. A caller that misclassifies this exits with no verdict, which the
 * green-checkpoint records as a LOST RUN — the failure WI-1490656 is about — so the
 * coupling is pinned by a test that feeds this a REAL `withFsMutex` timeout rather than a
 * hand-written lookalike string.
 */
export function isSharedAdmissionTimeout(error) {
  const message = String(error?.message ?? error ?? "");
  return (
    /Timed out after \d+ms waiting for fs-mutex/.test(message) &&
    message.includes(SHARED_TEST_PROCESS_ADMISSION_MUTEX)
  );
}

// WI-1639265: the caller's WALL CLOCK, published by the launcher as absolute epoch ms.
//
// Everything above this line is an INTERNAL budget: the queue budget is a fixed constant,
// the per-acquisition timeout is a fixed constant, and neither has ever known how long the
// caller is actually allowed to live. The launcher does know — it sets `RuntimeMaxSec` on
// the unit — but systemd enforces that property against the manager, not against us, so the
// first this process hears of its own deadline is SIGKILL. A run killed that way exits with
// no `AFFECTED_TESTS_RESULT` line at all, which the green-checkpoint records as a LOST RUN
// and every liveness probe reads as a hang.
//
// Keep the name byte-identical to `TASK_DEADLINE_EPOCH_MS_ENV` in
// `packages/operator-core/lib/systemd-scope.ts` (the producer). The pairing is pinned by
// `affected-tests-deadline-admission.test.ts`, which reads BOTH sources, so a rename on
// either side fails there rather than silently reverting this to the pre-fix behaviour —
// an absent variable is indistinguishable from "no deadline was set" by design.
export const TASK_DEADLINE_EPOCH_MS_ENV = "PAPERCUSP_TASK_DEADLINE_EPOCH_MS";

/**
 * Read the launcher-published deadline, or null when there is none.
 *
 * Null means UNKNOWN, never "unbounded and fine": every check below is skipped on null, so
 * an unlaunched/unconfined run behaves exactly as it did before this existed.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number | null} absolute epoch ms
 */
export function readTaskDeadlineEpochMs(env = process.env) {
  const raw = Number(env?.[TASK_DEADLINE_EPOCH_MS_ENV]);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
}

export const TASK_DEADLINE_REFUSAL_MARKER = "TASK_DEADLINE_REFUSAL";

/**
 * Format the pre-flight refusal.
 *
 * `knownEstimateMs` is the history-based wall projection under the configured lane policy,
 * with sequential shards added together. Unknown tasks contribute zero and are reported
 * separately. Historical durations are a prognosis, not a guaranteed lower bound on the
 * next run. A run refused here has measured nothing; the marker says so.
 */
export function formatTaskDeadlineRefusal({
  remainingMs,
  knownEstimateMs,
  knownTasks,
  unknownTasks,
}) {
  return (
    `${TASK_DEADLINE_REFUSAL_MARKER} remainingMs=${Math.round(remainingMs)} ` +
    `knownEstimateMs=${Math.round(knownEstimateMs)} knownTasks=${knownTasks} ` +
    `unknownTasks=${unknownTasks} remedy=raise-caller-timeout — the lane-aware historical ` +
    `wall projection exceeds the remaining launch clock, so a kill part-way through with ` +
    `no verdict is predicted. Refusing before anything runs instead.`
  );
}

/**
 * Does this error mean "we were never going to fit inside our own deadline"?
 *
 * Lives beside the throw for the same reason `isSharedAdmissionTimeout` does: a caller that
 * misclassifies it exits with no verdict, which is the exact failure being fixed.
 */
export function isTaskDeadlineRefusal(error) {
  return String(error?.message ?? error ?? "").includes(TASK_DEADLINE_REFUSAL_MARKER);
}
// EI-21437241652128498 / EI-21437837415175286: one stateful test task first
// reached 1,517 cgroup tasks, then exhausted a 2,048-task capability scope while
// it was still progressing. A later operator-core pure lane reached 4,096 tasks
// and STILL produced a complete 2,840-file verdict, proving that 4,096 is valid
// child workload rather than shell headroom. Size one admitted task to that
// writer-owned measurement and keep a separate shell/scheduler reserve. An
// 8,192-task capability envelope therefore admits ONE high-fanout task, not two
// whose individually legitimate peaks can collide at the hard fork boundary.
// This is the cgroup that actually enforces fork(); a host-wide process count is
// not the relevant limit.
export const PIDS_PER_CONCURRENT_TASK = 4_096;
export const PIDS_RESERVE = 1_024;

const positiveInteger = (value, name) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${name} must be a positive integer; received ${String(value)}`,
    );
  }
  return parsed;
};

const nonNegativeInteger = (value, name) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      `${name} must be a non-negative integer; received ${String(value)}`,
    );
  }
  return parsed;
};

function readTaskCgroupLimit(
  fileName,
  {
    readFile = readFileSync,
    procCgroupPath = "/proc/self/cgroup",
    cgroupRoot = "/sys/fs/cgroup",
  } = {},
) {
  try {
    const unified = String(readFile(procCgroupPath, "utf8"))
      .split(/\r?\n/)
      .find((line) => line.startsWith("0::"));
    if (!unified) return null;
    const relative = unified.slice(3).trim().replace(/^\/+/, "");
    const raw = String(
      readFile(join(cgroupRoot, relative, fileName), "utf8"),
    ).trim();
    if (!raw || raw === "max") return null;
    return raw;
  } catch {
    return null;
  }
}

/** Read the hard memory.max of THIS task's cgroup. `max`/unreadable means unbounded. */
export function readTaskCgroupMemoryMaxMb(options = {}) {
  try {
    const raw = readTaskCgroupLimit("memory.max", options);
    if (raw == null) return null;
    const bytes = BigInt(raw);
    if (bytes < 0n) return null;
    return Number(bytes / (1024n * 1024n));
  } catch {
    return null;
  }
}

/** Read the hard pids.max of THIS task's cgroup. `max`/unreadable means unbounded. */
export function readTaskCgroupPidsMax(options = {}) {
  try {
    const raw = readTaskCgroupLimit("pids.max", options);
    if (raw == null) return null;
    const pids = BigInt(raw);
    if (pids < 0n || pids > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(pids);
  } catch {
    return null;
  }
}

/**
 * Read the cgroup pids controller's cumulative refused-fork counter for THIS task.
 * A null result means the controller/file is unavailable; zero is a real measurement.
 */
export function readTaskCgroupPidsEventMax(options = {}) {
  try {
    const raw = readTaskCgroupLimit("pids.events", options);
    if (raw == null) return null;
    const line = raw
      .split(/\r?\n/)
      .map((entry) => entry.trim().split(/\s+/))
      .find(([key]) => key === "max");
    if (!line || line.length !== 2) return null;
    const count = BigInt(line[1]);
    if (count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(count);
  } catch {
    return null;
  }
}

/** Return the refused-fork delta that invalidates a red run; green runs stay authoritative. */
export function pidsEventRefusalDelta({ start, end, hasFailures }) {
  if (!hasFailures || start == null || end == null) return 0;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 0;
  return Math.max(0, end - start);
}

const ROOT_NEAR_TREE_WIDE = [
  /^package(?:-lock)?\.json$/,
  /^tsconfig(?:\.[^.]+)*\.json$/,
  /^(?:vitest|vite|eslint|prettier|turbo|nx)(?:\.[^.]+)*\.(?:[cm]?[jt]s|json)$/,
];

/** Classify path blast radius before any child process is launched. */
export function classifyAffectedBlastRadius({
  changedPaths = [],
  runAll = false,
  derivationDegraded = false,
} = {}) {
  if (runAll)
    return {
      kind: "near-tree-wide",
      reason: "all-requested",
      triggerPaths: [],
    };
  if (derivationDegraded) {
    return {
      kind: "near-tree-wide",
      reason: "derivation-degraded",
      triggerPaths: [],
    };
  }
  const triggerPaths = [...new Set(changedPaths)]
    .filter((path) => ROOT_NEAR_TREE_WIDE.some((pattern) => pattern.test(path)))
    .sort();
  return triggerPaths.length
    ? {
        kind: "near-tree-wide",
        reason: "root-manifest-or-config",
        triggerPaths,
      }
    : { kind: "scoped", reason: "path-closure", triggerPaths: [] };
}

/** Deterministically partition a finalized task set; duplicates fail before launch. */
export function planAffectedTaskShards(
  tasks,
  {
    blastRadius = { kind: "scoped", reason: "path-closure", triggerPaths: [] },
    maxTasksPerShard = 8,
    taskKey = (_task, index) => String(index),
  } = {},
) {
  if (!Array.isArray(tasks)) throw new Error("tasks must be an array");
  const identities = tasks.map((task, index) => String(taskKey(task, index)));
  const seen = new Set();
  for (const identity of identities) {
    if (seen.has(identity))
      throw new Error(`duplicate affected task before sharding: ${identity}`);
    seen.add(identity);
  }
  const bounded = positiveInteger(maxTasksPerShard, "maxTasksPerShard");
  const shardSize =
    blastRadius.kind === "near-tree-wide" ? bounded : Math.max(tasks.length, 1);
  const shards = [];
  for (let offset = 0; offset < tasks.length; offset += shardSize) {
    shards.push({
      index: shards.length,
      tasks: tasks.slice(offset, offset + shardSize),
      taskKeys: identities.slice(offset, offset + shardSize),
    });
  }
  return {
    blastRadius,
    maxTasksPerShard: shardSize,
    taskCount: tasks.length,
    shards,
  };
}

export function formatAffectedTaskShardMarker(
  plan,
  taskCgroupMemoryMaxMb = null,
) {
  const cgroup =
    taskCgroupMemoryMaxMb == null
      ? ""
      : ` taskCgroupMemoryMaxMb=${taskCgroupMemoryMaxMb}`;
  return (
    `AFFECTED_TASK_SHARDS class=${plan.blastRadius.kind} reason=${plan.blastRadius.reason} ` +
    `tasks=${plan.taskCount} shards=${plan.shards.length} maxTasksPerShard=${plan.maxTasksPerShard}${cgroup}`
  );
}

/**
 * Collapse every inherited/test-runner worker spelling into one global ceiling.
 *
 * Vitest 4 reads VITEST_MAX_WORKERS, while older/config-specific paths still set
 * VITEST_MAX_FORKS or VITEST_MAX_THREADS. The green checkpoint deliberately exports only the
 * latter two as its two-fork safety rail. Taking the minimum keeps any pre-set ceiling binding;
 * an affected-tests-specific value may tighten that rail but can never silently widen it.
 */
export function resolveGlobalWorkerBudget({
  affectedWorkerBudget,
  vitestMaxWorkers,
  vitestMaxForks,
  vitestMaxThreads,
  fallback,
}) {
  const candidates = [
    ["AFFECTED_GLOBAL_WORKER_BUDGET", affectedWorkerBudget],
    ["VITEST_MAX_WORKERS", vitestMaxWorkers],
    ["VITEST_MAX_FORKS", vitestMaxForks],
    ["VITEST_MAX_THREADS", vitestMaxThreads],
  ].flatMap(([name, value]) =>
    value == null || value === "" ? [] : [positiveInteger(value, name)],
  );
  if (candidates.length === 0) return positiveInteger(fallback, "fallback");
  return Math.min(...candidates);
}

/**
 * Size one scheduler memory token from the largest CREDIBLE per-worker ceiling.
 *
 * The child inherits NODE_OPTIONS, so a V8 old-space pin is part of its possible footprint even
 * when AFFECTED_WORKER_MEMORY_MB is unset. Treat the explicit estimate and the inherited heap as
 * lower bounds rather than alternatives: an override may add native/RSS headroom, but it must not
 * make a 4 GiB heap look like a 1 GiB worker to the global admission budget.
 *
 * WI-10002092 (a RECURRENCE of EI-23242580927683488, which was closed as a stale-runtime report
 * with no source edit): "credible" is the load-bearing word, and a bare `Math.max` over every
 * inherited heap made it a lie. `--max-old-space-size` is a heap CEILING — the most V8 may grow
 * to before it OOMs — never a reservation. Agent shells here carry an ambient
 * `--max-old-space-size=131072` (128 GiB) for the ordinary reason anyone sets one: to avoid
 * spurious OOMs. Read as a per-worker DEMAND it made {@link resolveMemoryBudgetMb} refuse before
 * launch in every ~6 GiB agent task cgroup, so `test:affected` — the command CLAUDE.md prescribes
 * after every edit — ran ZERO tasks for every agent invoking it from its own shell.
 *
 * The discriminator is whether the envelope could ever pay for the number. A ceiling that FITS is
 * a credible deliberate sizing and still raises the token, so the gate's 4 GiB fork pin is
 * honoured exactly as before. A ceiling the envelope could never satisfy is not a claim about
 * footprint at all — no admission decision could meet it — so it carries no information and is
 * DISREGARDED, leaving the explicit estimate (or the caller's fallback) to size the token. The
 * honest refusal survives for the case it was actually built for: a cgroup too small to pay for
 * even one estimated worker still throws in {@link resolveMemoryBudgetMb}.
 *
 * Pass `taskCgroupMemoryMaxMb` to arm the credibility test. Omit it — or pass the `null` that
 * {@link readTaskCgroupMemoryMaxMb} returns for an unbounded/unreadable cgroup — and there is no
 * envelope to judge against, so every heap candidate stands and the prior behaviour is exact.
 * `cgroupReserveFraction` deliberately shares {@link MEMORY_RESERVE_FRACTION} and the reserve
 * arithmetic with `resolveMemoryBudgetMb`: the two rails must agree on what one task can pay for,
 * or this function credits a ceiling the admission check then refuses.
 *
 * Disregarding a candidate can only ever LOWER the resolved token, never widen it — the same
 * one-directional property `resolveMemoryBudgetMb` claims for itself.
 */
export function resolveWorkerMemoryMb({
  affectedWorkerMemoryMb,
  nodeOptions,
  fallback,
  taskCgroupMemoryMaxMb,
  cgroupReserveFraction = MEMORY_RESERVE_FRACTION,
  onNotice,
}) {
  const candidates = [positiveInteger(fallback, "fallback")];
  if (affectedWorkerMemoryMb != null && affectedWorkerMemoryMb !== "") {
    candidates.push(
      positiveInteger(affectedWorkerMemoryMb, "AFFECTED_WORKER_MEMORY_MB"),
    );
  }
  // Validated even when no cgroup is supplied: silently ignoring a nonsensical fraction is what
  // lets a caller believe a credibility test is armed when it is not.
  if (!(cgroupReserveFraction >= 0 && cgroupReserveFraction < 1)) {
    throw new Error(
      `cgroupReserveFraction must be in [0, 1); received ${String(cgroupReserveFraction)}`,
    );
  }
  const credibleCeilingMb =
    taskCgroupMemoryMaxMb == null || taskCgroupMemoryMaxMb === ""
      ? null
      : Math.floor(
          nonNegativeInteger(taskCgroupMemoryMaxMb, "taskCgroupMemoryMaxMb") *
            (1 - cgroupReserveFraction),
        );
  const heapPattern =
    /(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s+)(\d+)(?=\s|$)/g;
  for (const match of String(nodeOptions ?? "").matchAll(heapPattern)) {
    const heapMb = positiveInteger(match[1], "NODE_OPTIONS max-old-space-size");
    if (credibleCeilingMb != null && heapMb > credibleCeilingMb) {
      // Announced, never silent: a disregarded candidate changes the admitted concurrency, and an
      // unexplained change there is indistinguishable from the budget rail being broken again.
      onNotice?.(
        `NODE_OPTIONS --max-old-space-size=${heapMb}MB exceeds the ${credibleCeilingMb}MB this ` +
          `task cgroup can pay for (memory.max=${taskCgroupMemoryMaxMb}MB); treating it as a ` +
          `heap ceiling, not a per-worker reservation (WI-10002092)`,
      );
      continue;
    }
    candidates.push(heapMb);
  }
  return Math.max(...candidates);
}

/**
 * Headroom held back from MemAvailable before any worker token is paid for.
 *
 * EI-20801764054303492 route (a): the STARTUP budget ({@link resolveMemoryBudgetMb}) and the
 * PER-ADMISSION re-check ({@link admissibleWorkersForMemory}) must reserve the same slice, or the
 * two rails disagree about what "available" means and the run oscillates between them. Exported
 * as one constant so a future tuning change cannot move one and leave the other behind.
 *
 * It is also the ONLY thing standing in for memory a just-admitted child has not yet allocated:
 * a worker's 4 GiB heap materialises over its first minutes, so a reading taken right after an
 * admission still reports that memory as available. See the conservatism note on
 * {@link admissibleWorkersForMemory}.
 */
export const MEMORY_RESERVE_FRACTION = 0.25;

/**
 * Resolve the memory envelope that worker tokens are admitted against.
 *
 * WI-39472: the caller's default used to be `workerBudget * workerMemoryMb`, which made
 * `memoryWorkerBudget` identically equal to `workerBudget` — so the `Math.min` in
 * {@link resolveTaskBudget} could never bind and the memory rail was INERT. Nothing failed
 * loudly; the gate simply had no memory-awareness at all, which is why its concurrency had to
 * be pinned at a hardcoded worst-case 2 (green-checkpoint.ts:4588-4610 records the 8 -> 4 -> 2
 * walk, each step taken after a real OOM). A live clamp is the precondition for ever raising
 * that ceiling again: with it, a quiet box runs wide and a loaded box is throttled instead of
 * OOM-killed.
 *
 * MemAvailable, never MemFree/os.freemem(): free memory excludes reclaimable page cache and
 * reads catastrophically low on any box that has been up for a while, which would throttle the
 * scheduler to a single worker for no reason.
 *
 * SAFETY: the result is `min(ceiling, usable)`, so this can only ever LOWER the admitted budget
 * relative to the previous behaviour — it can never widen it. The floor of one worker's worth
 * keeps `memoryWorkerBudget >= 1`, so a memory-starved host still makes progress serially
 * rather than tripping the "cannot admit one token" throw.
 */
export function resolveMemoryBudgetMb({
  affectedGlobalMemoryMb,
  memAvailableMb,
  taskCgroupMemoryMaxMb,
  workerBudget,
  workerMemoryMb,
  reserveFraction = MEMORY_RESERVE_FRACTION,
  cgroupReserveFraction = MEMORY_RESERVE_FRACTION,
}) {
  const perWorker = positiveInteger(workerMemoryMb, "workerMemoryMb");
  const ceiling = positiveInteger(workerBudget, "workerBudget") * perWorker;
  const configured =
    affectedGlobalMemoryMb != null && affectedGlobalMemoryMb !== ""
      ? positiveInteger(affectedGlobalMemoryMb, "AFFECTED_GLOBAL_MEMORY_MB")
      : ceiling;
  // WI-41206: the MemAvailable reading no longer reduces the envelope. An explicit
  // AFFECTED_GLOBAL_MEMORY_MB override (handled above) is still honoured — that is an operator
  // deliberately setting a budget, which is the opposite of the machine imposing one.
  //
  // reserveFraction is still VALIDATED even though it no longer narrows anything: it is a public
  // argument, and silently ignoring a nonsensical value is exactly the failure mode that lets a
  // caller believe a budget is in force when it is not.
  if (!(reserveFraction >= 0 && reserveFraction < 1)) {
    throw new Error(
      `reserveFraction must be in [0, 1); received ${String(reserveFraction)}`,
    );
  }
  if (!(cgroupReserveFraction >= 0 && cgroupReserveFraction < 1)) {
    throw new Error(
      `cgroupReserveFraction must be in [0, 1); received ${String(cgroupReserveFraction)}`,
    );
  }
  void memAvailableMb;
  if (taskCgroupMemoryMaxMb == null || taskCgroupMemoryMaxMb === "")
    return configured;
  const cgroupMax = nonNegativeInteger(
    taskCgroupMemoryMaxMb,
    "taskCgroupMemoryMaxMb",
  );
  const cgroupBudget = Math.floor(cgroupMax * (1 - cgroupReserveFraction));
  if (cgroupBudget < perWorker) {
    throw new Error(
      `task cgroup memory.max=${cgroupMax}MB leaves ${cgroupBudget}MB after reserve, ` +
        `below one workerMemoryMb=${perWorker}MB token; refusing before launch ` +
        formatTaskBudgetRefusal({
          kind: "memory",
          unit: "mb",
          limit: cgroupMax,
          reserve: cgroupMax - cgroupBudget,
          requiredPerTask: perWorker,
        }),
    );
  }
  return Math.min(configured, cgroupBudget);
}

/**
 * Resolve the single resource envelope shared by every concurrently-running task.
 * Memory is represented as tokens per worker: the scheduler never admits more worker
 * tokens than either the worker ceiling OR the memory ceiling can pay for.
 */
export function resolveTaskBudget({
  workerBudget,
  memoryBudgetMb,
  workerMemoryMb,
  maxConcurrentTasks = 2,
  reserveWorkers = 1,
  taskCgroupPidsMax = null,
  pidsPerConcurrentTask = PIDS_PER_CONCURRENT_TASK,
  pidsReserve = PIDS_RESERVE,
}) {
  const configuredWorkerBudget = positiveInteger(workerBudget, "workerBudget");
  const configuredMemoryBudgetMb = positiveInteger(
    memoryBudgetMb,
    "memoryBudgetMb",
  );
  const configuredWorkerMemoryMb = positiveInteger(
    workerMemoryMb,
    "workerMemoryMb",
  );
  const configuredMaxConcurrentTasks = positiveInteger(
    maxConcurrentTasks,
    "maxConcurrentTasks",
  );
  const configuredReserveWorkers = positiveInteger(
    reserveWorkers,
    "reserveWorkers",
  );
  const configuredPidsPerConcurrentTask = positiveInteger(
    pidsPerConcurrentTask,
    "pidsPerConcurrentTask",
  );
  const configuredPidsReserve = nonNegativeInteger(pidsReserve, "pidsReserve");
  const configuredTaskCgroupPidsMax =
    taskCgroupPidsMax == null || taskCgroupPidsMax === ""
      ? null
      : nonNegativeInteger(taskCgroupPidsMax, "taskCgroupPidsMax");
  const memoryWorkerBudget = Math.floor(
    configuredMemoryBudgetMb / configuredWorkerMemoryMb,
  );
  if (memoryWorkerBudget < 1) {
    throw new Error(
      `memoryBudgetMb=${configuredMemoryBudgetMb} cannot admit one ` +
        `workerMemoryMb=${configuredWorkerMemoryMb} token`,
    );
  }
  const effectiveWorkerBudget = Math.min(
    configuredWorkerBudget,
    memoryWorkerBudget,
  );
  let pidsMaxConcurrentTasks = null;
  let effectivePidsPerConcurrentTask = configuredPidsPerConcurrentTask;
  let effectivePidsReserve = configuredPidsReserve;
  let pidsBudgetAdapted = false;
  if (configuredTaskCgroupPidsMax != null) {
    // A confined capability task can receive fewer pids than the conservative host-wide
    // envelope (for example pids.max=512 versus the default 4096-per-task + 1024 reserve).
    // That is a narrower scheduling budget, not proof that no test can run. Scale the two
    // configured terms together so one serial task still has a fitting envelope. Keep a true
    // refusal only for a cgroup that cannot contain even one process (pids.max=0).
    if (configuredTaskCgroupPidsMax === 0) {
      const usablePids = configuredTaskCgroupPidsMax - configuredPidsReserve;
      throw new Error(
        `task cgroup pids.max=${configuredTaskCgroupPidsMax} leaves ${Math.max(0, usablePids)} ` +
          `after pidsReserve=${configuredPidsReserve}, below one ` +
          `pidsPerConcurrentTask=${configuredPidsPerConcurrentTask} envelope; refusing before launch ` +
          formatTaskBudgetRefusal({
            kind: "pids",
            unit: "tasks",
            limit: configuredTaskCgroupPidsMax,
            reserve: configuredPidsReserve,
            requiredPerTask: configuredPidsPerConcurrentTask,
          }),
      );
    }
    const configuredPidsEnvelope =
      configuredPidsReserve + configuredPidsPerConcurrentTask;
    if (configuredTaskCgroupPidsMax < configuredPidsEnvelope) {
      // Preserve the configured reserve/envelope ratio while rounding to integral pids. The
      // per-task term gets the remainder, so effectiveReserve + effectivePerTask always fits.
      effectivePidsReserve = Math.min(
        configuredPidsReserve,
        Math.floor(
          (configuredTaskCgroupPidsMax * configuredPidsReserve) /
            configuredPidsEnvelope,
        ),
      );
      effectivePidsPerConcurrentTask = Math.min(
        configuredPidsPerConcurrentTask,
        configuredTaskCgroupPidsMax - effectivePidsReserve,
      );
      pidsBudgetAdapted = true;
    }
    const usablePids = configuredTaskCgroupPidsMax - effectivePidsReserve;
    pidsMaxConcurrentTasks = Math.floor(
      usablePids / effectivePidsPerConcurrentTask,
    );
    if (pidsMaxConcurrentTasks < 1) {
      throw new Error(
        `task cgroup pids.max=${configuredTaskCgroupPidsMax} leaves ${Math.max(0, usablePids)} ` +
          `after pidsReserve=${effectivePidsReserve}, below one ` +
          `pidsPerConcurrentTask=${effectivePidsPerConcurrentTask} envelope; refusing before launch ` +
          formatTaskBudgetRefusal({
            kind: "pids",
            unit: "tasks",
            limit: configuredTaskCgroupPidsMax,
            reserve: effectivePidsReserve,
            requiredPerTask: effectivePidsPerConcurrentTask,
          }),
      );
    }
  }
  const effectiveMaxConcurrentTasks = Math.min(
    configuredMaxConcurrentTasks,
    pidsMaxConcurrentTasks ?? configuredMaxConcurrentTasks,
  );
  const parallel =
    effectiveWorkerBudget > configuredReserveWorkers &&
    effectiveMaxConcurrentTasks > 1;

  return {
    workerBudget: configuredWorkerBudget,
    memoryBudgetMb: configuredMemoryBudgetMb,
    workerMemoryMb: configuredWorkerMemoryMb,
    memoryWorkerBudget,
    // EI-20801764054303492: WHICH term bound the budget. Without this, a gate log records the
    // resolved concurrency but not the reason for it, so the next incident has to re-derive the
    // whole chain from source to learn whether the memory rail engaged at all — which is exactly
    // how the rail stayed INERT unnoticed long enough to force the 8 -> 4 -> 2 fork walk.
    // 'memory' means the host measurement is what held concurrency down (raising the ceiling
    // would change nothing); 'ceiling' means the configured ceiling is binding and memory had
    // headroom to spare. Read this BEFORE proposing a ceiling change.
    boundBy: memoryWorkerBudget < configuredWorkerBudget ? "memory" : "ceiling",
    effectiveWorkerBudget,
    maxConcurrentTasks: effectiveMaxConcurrentTasks,
    configuredMaxConcurrentTasks,
    pidsMaxConcurrentTasks,
    taskCgroupPidsMax: configuredTaskCgroupPidsMax,
    pidsPerConcurrentTask: effectivePidsPerConcurrentTask,
    pidsReserve: effectivePidsReserve,
    configuredPidsPerConcurrentTask,
    configuredPidsReserve,
    pidsBudgetAdapted,
    taskBoundBy:
      pidsBudgetAdapted ||
      effectiveMaxConcurrentTasks < configuredMaxConcurrentTasks
        ? "pids"
        : "ceiling",
    reserveWorkers: configuredReserveWorkers,
    mode: parallel ? "parallel" : "serial",
    primaryWorkers: parallel
      ? effectiveWorkerBudget - configuredReserveWorkers
      : effectiveWorkerBudget,
    reserveLaneWorkers: parallel ? configuredReserveWorkers : 0,
  };
}

/**
 * How many worker tokens the host can pay for RIGHT NOW, from a fresh MemAvailable reading.
 *
 * EI-20801764054303492 route (a). The startup budget is resolved from a SINGLE reading taken
 * before any child exists, and a gate run lasts ~55 minutes on a box shared with a large agent
 * fleet — so by the time the tenth task is admitted, the reading the whole run's concurrency
 * rests on can be an hour stale and describe a machine that no longer exists. Re-measuring at
 * each admission is what makes "a quiet box runs wide, a loaded box throttles" actually TRUE,
 * rather than "the box was quiet once, so we run wide regardless".
 *
 * SAFETY — this can only ever LOWER admission, never widen it: the result is clamped by the
 * lane's configured width, which was itself already clamped by the startup budget. A missing or
 * unreadable measurement returns the lane width unchanged, so a non-Linux host or a /proc read
 * failure degrades to exactly the previous behaviour instead of throttling to one worker.
 *
 * FLOOR of one: a host that cannot pay for a single token still makes progress serially. The
 * alternative — refusing admission — would deadlock a run that is already under memory pressure,
 * which is the worst possible moment to stop making forward progress.
 *
 * ⚠ KNOWN CONSERVATISM GAP: a child's heap materialises over its first minutes, so a reading
 * taken moments after an admission still counts that memory as available. {@link
 * MEMORY_RESERVE_FRACTION} is the headroom standing in for it. Modelling the unrealised
 * remainder would need a per-child ramp estimate this scheduler does not have, and guessing it
 * wrong throttles a healthy box — so the gap is documented rather than approximated.
 */
export function admissibleWorkersForMemory({
  laneWorkers,
  workerMemoryMb,
  memAvailableMb,
  reserveFraction = MEMORY_RESERVE_FRACTION,
}) {
  const configuredLaneWorkers = positiveInteger(laneWorkers, "laneWorkers");
  // WI-41206 / remove-memory-derived-work-refusals-2026-08-24: memory NO LONGER narrows the
  // lane. This function used to return min(configured, floor(usable / perWorker)).
  //
  // The reasoning that survives: a reading is an OBSERVATION, not a configuration value, and
  // this scheduler was already the best-behaved memory consumer in the tree — it PACED rather
  // than refusing, precisely because "refusing admission would deadlock a run that is already
  // under memory pressure". The owner's call is that the same argument extends one step: a
  // host driven into paging should get SLOWER on its own, from actual contention, rather than
  // from us pre-emptively narrowing the lane on a snapshot that is stale the moment it is read.
  //
  // The arguments are retained (call sites unchanged) and the measurement is still logged via
  // `memAvailableMb=` in the stats line, so the concurrency decision stays auditable.
  // reserveFraction stays VALIDATED for the same reason as in resolveMemoryBudgetMb: silently
  // ignoring a nonsensical public argument lets a caller believe a limit is in force.
  if (!(reserveFraction >= 0 && reserveFraction < 1)) {
    throw new Error(
      `reserveFraction must be in [0, 1); received ${String(reserveFraction)}`,
    );
  }
  void memAvailableMb;
  void workerMemoryMb;
  return configuredLaneWorkers;
}

const finiteEstimate = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

function pendingTask(task, index, estimateMs) {
  return { task, index, estimateMs: finiteEstimate(estimateMs) };
}

/** Pick the longest KNOWN task. Unknowns retain declaration order. */
function takeLongest(pending) {
  let chosen = 0;
  let best = -1;
  for (let i = 0; i < pending.length; i++) {
    const estimate = pending[i].estimateMs;
    if (estimate != null && estimate > best) {
      best = estimate;
      chosen = i;
    }
  }
  return pending.splice(chosen, 1)[0];
}

/** Pick the shortest KNOWN task for the reserved lane. Unknowns retain declaration order. */
function takeShortest(pending) {
  let chosen = -1;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < pending.length; i++) {
    const estimate = pending[i].estimateMs;
    if (estimate != null && estimate < best) {
      best = estimate;
      chosen = i;
    }
  }
  if (chosen < 0) chosen = 0;
  return pending.splice(chosen, 1)[0];
}

/**
 * Project elapsed wall time for a planned run using the scheduler's actual lane policy.
 *
 * Historical durations are useful for a prognosis, but they are not a proof about the next
 * run: a task can be faster or slower than its history, and an unknown task contributes no
 * duration at all. Keep those facts explicit in the result. In particular, do not sum task
 * durations and call that a wall-time lower bound — the parallel lanes make that sum serial-
 * equivalent work, not elapsed time.
 *
 * The simulation mirrors an uncontended admission turn: the primary lane takes the
 * longest known pending task, the reserved lane takes the shortest known pending task, and the
 * next task on each lane starts when that lane becomes free. Shards are summed because
 * `runBudgetedTaskShards` runs them sequentially.
 */
export function estimateBudgetedTaskWallMs(plan, options) {
  if (!plan?.shards?.length) {
    return {
      projectedWallMs: 0,
      knownWorkMs: 0,
      knownTasks: 0,
      unknownTasks: 0,
      mode: "serial",
      maxConcurrentTasks: 0,
    };
  }

  const budget = resolveTaskBudget(options);
  const estimateFor =
    typeof options?.estimateMs === "function" ? options.estimateMs : () => null;
  let projectedWallMs = 0;
  let knownWorkMs = 0;
  let knownTasks = 0;
  let unknownTasks = 0;

  for (const shard of plan.shards) {
    const pending = shard.tasks.map((task, index) => {
      const estimateMs = finiteEstimate(estimateFor(task, index));
      if (estimateMs == null) unknownTasks += 1;
      else {
        knownTasks += 1;
        knownWorkMs += estimateMs;
      }
      return { task, index, estimateMs };
    });

    if (pending.length === 0) continue;
    if (budget.mode !== "parallel" || pending.length <= 1) {
      projectedWallMs += pending.reduce(
        (total, entry) => total + (entry.estimateMs ?? 0),
        0,
      );
      continue;
    }

    const lanes = [
      { readyAt: 0, take: takeLongest },
      { readyAt: 0, take: takeShortest },
    ];
    while (pending.length > 0) {
      // Keep ties on the primary lane: it is started first by Promise.all in the real runner.
      const lane = lanes[1].readyAt < lanes[0].readyAt ? lanes[1] : lanes[0];
      const entry = lane.take(pending);
      lane.readyAt += entry.estimateMs ?? 0;
    }
    projectedWallMs += Math.max(...lanes.map(({ readyAt }) => readyAt));
  }

  return {
    projectedWallMs,
    knownWorkMs,
    knownTasks,
    unknownTasks,
    mode: budget.mode,
    maxConcurrentTasks: budget.maxConcurrentTasks,
  };
}

/**
 * Run tasks under one global worker+memory envelope.
 *
 * In parallel mode the primary lane consumes all but the reserved worker tokens and
 * selects longest-first. The reserved lane consumes the remaining tokens and selects
 * shortest-first. This overlaps fixed per-leg overhead and short guards without ever
 * multiplying a per-workspace cap. A one-worker/memory-token budget collapses to serial.
 * Results are returned in declaration order regardless of completion order.
 */
function createBudgetedTaskRun(tasks, options) {
  const budget = resolveTaskBudget(options);
  const estimateMs = options.estimateMs ?? (() => null);
  const runTask = options.runTask;
  if (typeof runTask !== "function")
    throw new Error("runTask must be a function");
  const onTaskSettled = options.onTaskSettled;
  if (onTaskSettled != null && typeof onTaskSettled !== "function") {
    throw new Error("onTaskSettled must be a function when provided");
  }
  // EI-20801764054303492 route (a): an OPT-IN live reading. Absent ⇒ every allocation below is
  // byte-identical to the pre-clamp scheduler, which is the back-compat contract every existing
  // caller and test relies on. Present ⇒ admission re-checks memory and may only ever admit LESS.
  const readMemAvailableMb =
    typeof options.readMemAvailableMb === "function"
      ? options.readMemAvailableMb
      : null;

  const pending = tasks.map((task, index) =>
    pendingTask(task, index, estimateMs(task, index)),
  );
  const results = new Array(tasks.length);
  let activeWorkers = 0;
  let activeTasks = 0;
  let observedMaxWorkers = 0;
  let observedMaxMemoryMb = 0;
  let observedMaxTasks = 0;
  let firstError = null;
  let admissions = 0;
  // null (not 0) when no reader was supplied: "nobody measured" and "measured zero times" are
  // different facts, and the marker below distinguishes them by exactly this null.
  let memoryReadings = readMemAvailableMb ? 0 : null;
  let admissionClamps = 0;
  let minAdmittedWorkers = null;
  let lastMemAvailableMb = null;

  const clampByMemory = (laneWorkers) => {
    let reading;
    try {
      reading = readMemAvailableMb();
    } catch {
      // A THROWING instrument is a broken instrument, never a report of "no memory left". Admit
      // the unclamped lane width: a probe bug must not throttle a healthy box to one worker.
      return laneWorkers;
    }
    memoryReadings += 1;
    const measured = reading == null ? Number.NaN : Number(reading);
    lastMemAvailableMb = Number.isFinite(measured) ? measured : null;
    const admitted = admissibleWorkersForMemory({
      laneWorkers,
      workerMemoryMb: budget.workerMemoryMb,
      memAvailableMb: reading,
    });
    if (admitted < laneWorkers) admissionClamps += 1;
    return admitted;
  };

  // Re-measure before every admission EXCEPT the run's first: the startup reading that sized the
  // budget is still fresh at that point, so re-reading it there would add noise without adding
  // information. Every later admission is racing children whose heaps have grown since it.
  //
  // ⚠ LOAD-BEARING COMPOSITION — the first admission is UNMEASURED, so on its own this clamp does
  // NOT protect it: at an 8-worker/4GiB config that admission is 32GiB, the exact shape
  // green-checkpoint records as OOM-killing this box. It is safe ONLY because the STARTUP budget
  // is itself sized from a fresh reading (resolveMemoryBudgetMb, wired in affected-tests.mjs and
  // source-pinned by the WI-39472 guards), so a box that is already short on memory never reaches
  // admission #0 with a wide budget. Weaken that startup sizing and you silently unprotect the
  // first admission — the two halves only work together (EI-20801764054303492).
  const admitWorkersFor = (laneWorkers) => {
    if (!readMemAvailableMb) return laneWorkers;
    const admitted =
      admissions === 0 ? laneWorkers : clampByMemory(laneWorkers);
    minAdmittedWorkers =
      minAdmittedWorkers == null
        ? admitted
        : Math.min(minAdmittedWorkers, admitted);
    return admitted;
  };

  const runOne = async (entry, lane, workers) => {
    const memoryMb = workers * budget.workerMemoryMb;
    admissions += 1;
    activeWorkers += workers;
    activeTasks += 1;
    observedMaxWorkers = Math.max(observedMaxWorkers, activeWorkers);
    observedMaxMemoryMb = Math.max(
      observedMaxMemoryMb,
      activeWorkers * budget.workerMemoryMb,
    );
    observedMaxTasks = Math.max(observedMaxTasks, activeTasks);
    if (
      activeWorkers > budget.effectiveWorkerBudget ||
      activeWorkers * budget.workerMemoryMb > budget.memoryBudgetMb ||
      activeTasks > budget.maxConcurrentTasks
    ) {
      throw new Error(
        "budgeted task scheduler admitted work beyond its configured ceiling",
      );
    }
    const allocation = { lane, workers, memoryMb };
    try {
      const value = await runTask(entry.task, allocation, entry.index);
      const scheduled = {
        task: entry.task,
        index: entry.index,
        allocation,
        value,
      };
      results[entry.index] = scheduled;
      // Settlement is the durable-observation seam: callers that need to retain a completed
      // task before a long sibling (or the parent process) disappears can do so here, while
      // declaration-order result replay remains unchanged. Await the callback so a following
      // admission never outruns that persistence.
      if (onTaskSettled) await onTaskSettled(scheduled);
    } catch (error) {
      firstError ??= error;
      throw error;
    } finally {
      activeWorkers -= workers;
      activeTasks -= 1;
    }
  };

  const runLane = async (lane, workers, take, turn) => {
    while (pending.length > 0 && firstError == null && !turn.yielded) {
      // Let the initial concurrent wave start, then stop refilling when a peer
      // is queued. Both lanes drain before the holder releases its FIFO slot.
      if (
        admissions - turn.startedAdmissions >= budget.maxConcurrentTasks &&
        turn.hasWaiters && await turn.hasWaiters()
      ) turn.yielded = true;
      // The other lane may have settled or taken the final task during the read.
      if (turn.yielded || firstError != null || pending.length === 0) break;
      const entry = take(pending);
      await runOne(entry, lane, admitWorkersFor(workers));
    }
  };

  return async (hasWaiters) => {
    const turn = { startedAdmissions: admissions, yielded: false, hasWaiters };
    if (budget.mode === "parallel" && pending.length > 1) {
      // Promise.all rejects before its siblings settle. Stop new admissions and
      // drain the surviving child and its persistence before releasing the slot.
      const lanes = await Promise.allSettled([
        runLane("primary", budget.primaryWorkers, takeLongest, turn),
        runLane("reserved", budget.reserveLaneWorkers, takeShortest, turn),
      ]);
      const rejected = lanes.find((lane) => lane.status === "rejected");
      if (rejected) throw rejected.reason;
    } else {
      await runLane("serial", budget.effectiveWorkerBudget, takeLongest, turn);
    }

    return {
      results,
      pendingTasks: pending.length,
      stats: {
        ...budget,
        observedMaxWorkers,
        observedMaxMemoryMb,
        observedMaxTasks,
        memoryReadings,
        admissionClamps,
        minAdmittedWorkers,
        lastMemAvailableMb,
      },
    };
  };
}

/**
 * Run one scheduler invocation behind the shared test-process admission gate.
 *
 * The lock covers all active children, not just the synchronous
 * launch call: the child process and all of its Vitest descendants remain the
 * admitted resident workload until `runTask` settles.  `withFsMutex` releases
 * in a finally block and reclaims a stale/dead owner, so a failed or crashed
 * runner cannot leave later verification permanently wedged. A queued peer
 * stops lane refill after the initial wave; pending tasks resume through a
 * fresh FIFO ticket after all active work drains. State and queue spending
 * remain scoped to the complete invocation, rather than restarting per turn.
 *
 * EI-21921867787033533: under heavy fleet-wide load this mutex is a real,
 * intentional serialization point — most concurrent `test:affected` callers
 * are correctly BLOCKED here, one at a time, for as long as ~4h
 * (SHARED_TEST_PROCESS_ADMISSION_TIMEOUT_MS). Every liveness probe (systemd
 * ActiveState, process state, CPU%) reads a queued caller as "alive but doing
 * nothing", indistinguishable from a genuine wedge. `withFsMutex` already
 * supports an `onWaiting` callback for exactly this — fired once, the first
 * time a caller actually has to wait — but nothing wired it up here, so a
 * queued `test:affected` produced zero diagnostic output for however long it
 * queued. Wiring it in costs nothing on the (usual) uncontended path and
 * turns a silent multi-hour queue wait into one attributable stderr line the
 * moment it starts waiting.
 */
/**
 * Render a holder's owner record as ONE decision-shaped line.
 *
 * EI-21917992245424964: the notice previously interpolated the raw owner file, so every
 * re-announcement emitted eight lines of pretty-printed JSON whose four fields were all
 * about IDENTITY (pid/host/startedAt/name) and none about whether waiting was worth it.
 * Repeated on a 60s cadence for as long as the queue lasts, that is a lot of bytes saying
 * nothing a waiter can act on.
 *
 * `intent=undeclared` is emitted deliberately rather than omitted: a waiter must be able to
 * tell "the holder did not say" from "the holder said it is cheap". Silently dropping the
 * field makes those two read identically, which is the failure this whole change exists to
 * remove — one more confident-looking absence.
 *
 * Fails open to the raw text on any parse problem. This is a diagnostic printed while
 * something is already blocked; it must never be the thing that throws.
 */
export function formatAdmissionHolder(ownerText, now = Date.now()) {
  const raw = String(ownerText ?? "").trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;

  const bits = [];
  if (parsed.pid != null) bits.push(`pid=${parsed.pid}`);
  const acquiredAtMs = parsed.acquiredAt ? Date.parse(parsed.acquiredAt) : NaN;
  if (Number.isFinite(acquiredAtMs)) {
    const heldMs = now - acquiredAtMs;
    if (heldMs >= 0) bits.push(`held=${Math.round(heldMs / 1000)}s`);
  }
  const intent =
    parsed.intent && typeof parsed.intent === "object" && !Array.isArray(parsed.intent)
      ? parsed.intent
      : null;
  if (intent) {
    for (const [key, value] of Object.entries(intent)) bits.push(`${key}=${value}`);
  } else {
    bits.push("intent=undeclared");
  }
  return bits.length > 0 ? bits.join(" ") : raw;
}

/**
 * WI-2142172: tell the WAITER whether it can plausibly be admitted before its own budget
 * runs out — the one thing the queued notice never said.
 *
 * The measured failure: a 4-path run queued behind a 36-task holder whose declared projected
 * wait nearly filled the waiter's 2700s budget. Every input needed to see that was ALREADY on
 * the notice — the holder's projection, the waiter's elapsed, the waiter's budget — but nobody
 * did the arithmetic, so the line read as ordinary serialization for ~40 minutes and the run
 * ended `refused` with 28/28 undetermined and zero tasks measured. Nothing was broken; the
 * reader simply had no prognosis.
 *
 * The projection is deliberately NOT a proof: historical durations can be wrong and the
 * scheduler overlaps tasks. `etaProjectedSec` is a concurrency-aware estimate over the tasks
 * with history; `etaWorkSec` retains the serial-equivalent sum for diagnosis, not wall time.
 * Hence the warning text says projection and never claims starvation is proven. Two graded
 * warning bands remain useful: PROJECTED TO STARVE once the projection does not fit, ADMISSION
 * AT RISK once most of the remaining budget is committed to waiting, and silence below that.
 *
 * `etaFromTasks=0/n` is reported as an explicit unknown rather than silently skipped, for
 * the same reason `intent=undeclared` is: "the holder could not estimate" and "the holder
 * is nearly done" must never read alike. Legacy holders that only publish `etaMinSec` are
 * also treated as unknown because their serial sum cannot be converted to wall time here.
 *
 * Fails open to "". It is a diagnostic printed while something is already blocked; it must
 * never be the thing that throws.
 */
export function formatAdmissionProspect(ownerText, waiter, now = Date.now()) {
  try {
    const elapsedMs = Number(waiter?.elapsedMs);
    const budgetMs = Number(waiter?.budgetMs);
    if (
      !Number.isFinite(elapsedMs) ||
      !Number.isFinite(budgetMs) ||
      budgetMs <= 0
    )
      return "";

    const parsed = JSON.parse(String(ownerText ?? "").trim());
    const intent =
      parsed?.intent &&
      typeof parsed.intent === "object" &&
      !Array.isArray(parsed.intent)
        ? parsed.intent
        : null;
    if (!intent) return "";

    const etaProjectedSec = Number(intent.etaProjectedSec);
    if (!Number.isFinite(etaProjectedSec) || etaProjectedSec <= 0) {
      const legacyEtaSec = Number(intent.etaMinSec);
      return Number.isFinite(legacyEtaSec) && legacyEtaSec > 0
        ? ` — PROSPECT UNKNOWN: the holder reports legacy etaMinSec=${legacyEtaSec} ` +
            `as serial-equivalent work, not a concurrency-aware wall-time projection.`
        : "";
    }

    // A ratio whose numerator is 0 means the projection saw no duration history at all, so the
    // displayed estimate is really zero information wearing a number's clothes. Say so.
    const covered = /^(\d+)\s*\/\s*(\d+)$/.exec(
      String(intent.etaFromTasks ?? ""),
    );
    if (covered && Number(covered[1]) === 0) {
      return (
        ` — PROSPECT UNKNOWN: the holder's etaMinSec covers ${intent.etaFromTasks} of its ` +
        `tasks, so it carries no information about when you will be admitted.`
      );
    }

    const acquiredAtMs = parsed.acquiredAt
      ? Date.parse(parsed.acquiredAt)
      : NaN;
    const heldSec = Number.isFinite(acquiredAtMs)
      ? Math.max(0, (now - acquiredAtMs) / 1000)
      : 0;
    const holderRemainingSec = Math.max(0, etaProjectedSec - heldSec);
    const budgetRemainingSec = Math.max(0, (budgetMs - elapsedMs) / 1000);
    if (budgetRemainingSec <= 0) return "";

    // THE BAND MATTERS. Warn in two graded bands, both honest about uncertainty: at >=1.0 the
    // history-based projection exceeds the remaining budget; at >=0.5 most of the remaining
    // budget is committed to waiting. Below that, stay silent rather than manufacturing
    // reassurance from an estimate.
    const ratio = holderRemainingSec / budgetRemainingSec;
    if (ratio < 0.5) return "";

    const unknownTasks = Number(intent.etaUnknownTasks);
    const shared =
      `about ${Math.round(holderRemainingSec)}s of projected wall time remains for the holder ` +
      `(etaProjectedSec=${etaProjectedSec}` +
      `${intent.etaWorkSec != null ? `, etaWorkSec=${intent.etaWorkSec}` : ""}` +
      `${intent.etaMode ? `, mode=${intent.etaMode}` : ""}` +
      `${intent.etaConcurrency != null ? `, concurrency=${intent.etaConcurrency}` : ""}` +
      `${intent.etaFromTasks ? ` over ${intent.etaFromTasks} tasks` : ""}, held=` +
      `${Math.round(heldSec)}s); only ${Math.round(budgetRemainingSec)}s of your budget ` +
      `remains. This is a history-based projection, not a guarantee.` +
      (Number.isFinite(unknownTasks) && unknownTasks > 0
        ? ` ${Math.round(unknownTasks)} task(s) have no duration history.`
        : "");

    return ratio >= 1
      ? ` — ⚠ PROJECTED TO STARVE: ${shared} The projection exceeds your remaining budget; ` +
          `fall back to narrower verification NOW rather than discovering this at the budget wall.`
      : ` — ⚠ ADMISSION AT RISK: ${shared} Roughly ${Math.round(ratio * 100)}% of your ` +
          `remaining budget is already committed to waiting; consider falling back to ` +
          `narrower verification now.`;
  } catch {
    return "";
  }
}

export async function runBudgetedTasks(tasks, options) {
  // WI-1490656: `console.error` cannot reach the affected-tests RUN LOG — that file is
  // written by the runner's own `logLine`/`errSync`, so the queued notice landed only on
  // stderr and was absent from all 993 run logs on this box. The run log is the artifact
  // the runner itself tells a triager to grep, so a queued caller looked silent in exactly
  // the place it was supposed to explain itself. Callers inject a sink that writes BOTH.
  const notify = options?.onAdmissionNotice ?? ((line) => console.error(line));
  const timeoutMs =
    Number(options?.admissionTimeoutMs) > 0
      ? Number(options.admissionTimeoutMs)
      : SHARED_TEST_PROCESS_ADMISSION_TIMEOUT_MS;
  const runTurn = createBudgetedTaskRun(tasks, options);
  let queuedMs = 0;
  let run;
  do {
    const remainingQueueMs = Math.max(1, timeoutMs - queuedMs);
    run = await withFsMutex(
    // WI-1746759: the release gate rides its own lane; everyone else shares one.
    admissionMutexName(),
    ({ hasWaiters } = {}) => runTurn(hasWaiters),
    {
      timeoutMs: remainingQueueMs,
      staleMs: SHARED_TEST_PROCESS_ADMISSION_STALE_MS,
      retryMs: SHARED_TEST_PROCESS_ADMISSION_RETRY_MS,
      waitingNoticeIntervalMs: SHARED_TEST_PROCESS_ADMISSION_NOTICE_INTERVAL_MS,
      // EI-21917992245424964: what this run IS, carried in the owner record so a blocked
      // peer can judge it without waking anyone. The caller owns the content because the
      // caller is the only layer that knows its own scope; this layer only forwards it.
      intent: options?.admissionIntent,
      onWaiting: ({ owner, elapsedMs }) => {
        // WI-2142172: the base sentence stays (starvation is genuinely not a hang), but it
        // is no longer the LAST word. When the holder's declared lower bound already
        // exceeds this waiter's remaining budget, the prospect clause says so outright, so
        // "normal serialization" can never again be the only thing a reader is told while
        // the run is in fact projected to measure nothing at all.
        notify(
          `AFFECTED_TESTS_ADMISSION_QUEUED waiting on the shared test-process ` +
            `admission mutex (${Math.round(elapsedMs / 1000)}s so far, budget ` +
            `${Math.round(remainingQueueMs / 1000)}s) — this is normal serialization under ` +
            `fleet load, not a hang; holder: ${formatAdmissionHolder(owner)}` +
            formatAdmissionProspect(owner, { elapsedMs, budgetMs: remainingQueueMs }),
          { kind: "queued", elapsedMs, budgetMs: remainingQueueMs },
        );
      },
      onAcquired: ({ waitedMs }) => {
        queuedMs += waitedMs;
        // `budgetMs` is the bound THIS acquisition was actually given. Reporting it is what
        // lets a caller (and a test) see the whole-run budget spending down across shards
        // instead of silently restarting at full value on every one.
        if (options?.onAdmissionAcquired)
          options.onAdmissionAcquired({ waitedMs, budgetMs: remainingQueueMs });
        if (waitedMs >= SHARED_TEST_PROCESS_ADMISSION_NOTICE_INTERVAL_MS) {
          notify(
            `AFFECTED_TESTS_ADMISSION_GRANTED after ${Math.round(waitedMs / 1000)}s queued`,
            { kind: "granted", waitedMs, budgetMs: remainingQueueMs },
          );
        }
      },
    },
  );
    if (run.pendingTasks > 0) notify(
      `AFFECTED_TESTS_ADMISSION_YIELD completedTasks=${tasks.length - run.pendingTasks} ` +
        `remainingTasks=${run.pendingTasks} — active children drained; rejoining the FIFO queue`,
      { kind: "yielded", budgetMs: Math.max(0, timeoutMs - queuedMs) },
    );
  } while (run.pendingTasks > 0);
  return { results: run.results, stats: run.stats };
}

/** Run deterministic shards sequentially while preserving declaration-order results. */
export async function runBudgetedTaskShards(plan, options) {
  if (!plan?.shards?.length) {
    throw new Error(
      "runBudgetedTaskShards requires at least one planned shard",
    );
  }
  const results = [];
  let aggregate = null;
  const shardStats = [];
  // WI-1490656: carry ONE queue budget across every shard. Each shard is its own
  // `withFsMutex` acquisition whose `timeoutMs` restarts at zero, so without this the run's
  // real admission bound is shards × per-acquisition timeout. Spend the budget down as
  // shards actually queue; time spent RUNNING tests is not queue time and never counts
  // against it, because `withFsMutex` stops measuring the moment it grants.
  const runBudgetMs =
    Number(options?.admissionRunBudgetMs) > 0
      ? Number(options.admissionRunBudgetMs)
      : SHARED_TEST_PROCESS_ADMISSION_RUN_BUDGET_MS;

  // WI-1639265: admission can now see the caller's wall clock.
  //
  // `runBudgetMs` above bounds QUEUE time only, and it is a fixed internal constant. Nothing
  // compared it against how long this process is actually allowed to live, so a run launched
  // with a short `RuntimeMaxSec` could spend its entire life queued — perfectly within budget
  // — and be SIGKILLed the moment it finally got to work. The inversion worth naming: the
  // dangerous caller is the CONSERVATIVE-looking one. A generous timeout sits well above the
  // queue budget and is never squeezed; it is the caller who passes a modest timeout, trying
  // to be tidy, who buys a run that cannot fit.
  //
  // `options.deadlineEpochMs === undefined` reads the launcher's env; an explicit `null`
  // disables the check (tests, and any caller that genuinely has no deadline).
  const deadlineEpochMs =
    options?.deadlineEpochMs === undefined
      ? readTaskDeadlineEpochMs()
      : options.deadlineEpochMs;
  const deadlineNotify =
    options?.onAdmissionNotice ?? ((line) => console.error(line));
  // Reuse the same concurrent-lane projection as admission ETA. Summed task durations
  // describe serial-equivalent work and can falsely refuse a run that fits in parallel.
  const projectedKnownWork = (taskPlan) => {
    const { projectedWallMs, knownTasks, unknownTasks } =
      estimateBudgetedTaskWallMs(taskPlan, options);
    return { knownEstimateMs: projectedWallMs, knownTasks, unknownTasks };
  };

  if (deadlineEpochMs != null) {
    const remainingMs = deadlineEpochMs - Date.now();
    if (remainingMs <= runBudgetMs) {
      deadlineNotify(
        `AFFECTED_TESTS_DEADLINE_TIGHT remainingMs=${Math.round(remainingMs)} ` +
          `queueBudgetMs=${runBudgetMs} — the shared-admission QUEUE budget alone can consume ` +
          `this run's entire wall clock, so a fully-queued run would be killed before it ran a ` +
          `single test. Raise the launching timeout above ` +
          `${Math.ceil(runBudgetMs / 60_000)}min, or lower admissionRunBudgetMs to match it.`,
        { kind: "deadline-tight", remainingMs, budgetMs: runBudgetMs },
      );
    }
    // PRE-FLIGHT ONLY, over the whole plan. Refusing here costs nothing — nothing has run —
    // and turns "killed with no verdict" into an attributable refusal. Deliberately NOT
    // re-raised between shards: by then earlier shards hold real results, and throwing them
    // away to report a deadline would trade a measured verdict for a predicted one.
    const preflight = projectedKnownWork(plan);
    if (remainingMs <= 0 || preflight.knownEstimateMs > remainingMs) {
      throw new Error(formatTaskDeadlineRefusal({ remainingMs, ...preflight }));
    }
  }

  let queuedSoFarMs = 0;
  for (const shard of plan.shards) {
    if (deadlineEpochMs != null) {
      const remainingMs = deadlineEpochMs - Date.now();
      const upcoming = projectedKnownWork({ ...plan, shards: [shard] });
      if (upcoming.knownEstimateMs > remainingMs) {
        deadlineNotify(
          `AFFECTED_TESTS_DEADLINE_SHORTFALL shard=${shard.index} ` +
            `remainingMs=${Math.round(remainingMs)} ` +
            `knownEstimateMs=${Math.round(upcoming.knownEstimateMs)} ` +
            `knownTasks=${upcoming.knownTasks} unknownTasks=${upcoming.unknownTasks} — this ` +
            `shard is expected to outlive the run's deadline, so a kill part-way through it is ` +
            `likely. Results already settled by earlier shards remain valid.`,
          { kind: "deadline-shortfall", shard: shard.index, remainingMs },
        );
      }
    }
    const run = await runBudgetedTasks(shard.tasks, {
      ...options,
      admissionTimeoutMs: Math.max(1, runBudgetMs - queuedSoFarMs),
      onAdmissionAcquired: ({ waitedMs, budgetMs }) => {
        queuedSoFarMs += waitedMs;
        if (options?.onAdmissionAcquired) options.onAdmissionAcquired({ waitedMs, budgetMs });
      },
    });
    shardStats.push({
      index: shard.index,
      taskCount: shard.tasks.length,
      ...run.stats,
    });
    for (const entry of run.results)
      results.push({ ...entry, index: results.length });
    if (!aggregate) {
      aggregate = { ...run.stats };
      continue;
    }
    aggregate.observedMaxWorkers = Math.max(
      aggregate.observedMaxWorkers,
      run.stats.observedMaxWorkers,
    );
    aggregate.observedMaxMemoryMb = Math.max(
      aggregate.observedMaxMemoryMb,
      run.stats.observedMaxMemoryMb,
    );
    aggregate.observedMaxTasks = Math.max(
      aggregate.observedMaxTasks,
      run.stats.observedMaxTasks,
    );
    aggregate.admissionClamps += run.stats.admissionClamps;
    aggregate.memoryReadings =
      aggregate.memoryReadings == null || run.stats.memoryReadings == null
        ? null
        : aggregate.memoryReadings + run.stats.memoryReadings;
    aggregate.minAdmittedWorkers =
      aggregate.minAdmittedWorkers == null
        ? run.stats.minAdmittedWorkers
        : run.stats.minAdmittedWorkers == null
          ? aggregate.minAdmittedWorkers
          : Math.min(
              aggregate.minAdmittedWorkers,
              run.stats.minAdmittedWorkers,
            );
    aggregate.lastMemAvailableMb = run.stats.lastMemAvailableMb;
  }
  return { results, stats: aggregate, shardStats, shardPlan: plan };
}

export function emptyDurationHistory() {
  return { version: DURATION_HISTORY_VERSION, tasks: {} };
}

export function readDurationHistory(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed?.version !== DURATION_HISTORY_VERSION ||
      !parsed.tasks ||
      typeof parsed.tasks !== "object"
    ) {
      // EI-20806073740910935: a silent discard here is indistinguishable from
      // "first run, no history yet" — and it disarms every watchdog bound for
      // the whole run. Say WHY the history was thrown away.
      process.stderr.write(
        `[budgeted-task-scheduler] duration history at ${path} DISCARDED: ` +
          `version=${JSON.stringify(parsed?.version)} (want ${DURATION_HISTORY_VERSION}), ` +
          `tasks=${parsed?.tasks ? typeof parsed.tasks : "missing"} — starting empty\n`,
      );
      return emptyDurationHistory();
    }
    return parsed;
  } catch (err) {
    // ENOENT is the expected first-run case and stays quiet. ANYTHING else
    // (EMFILE/EIO/EACCES/parse error on a present file) silently disarmed the
    // watchdog estimator for an entire gate run on 2026-08-18 (run 10, all 36
    // progress lines durationEstimateMs=unknown while the file was valid) —
    // EI-20806073740910935. A single loud line makes the next occurrence
    // self-diagnosing.
    if (err?.code !== "ENOENT") {
      process.stderr.write(
        `[budgeted-task-scheduler] duration history READ FAILED at ${path}: ` +
          `${err?.code ?? err?.name ?? "error"} ${err?.message ?? ""} — starting empty ` +
          `(EI-20806073740910935: all duration estimates will print unknown this run)\n`,
      );
    }
    return emptyDurationHistory();
  }
}

export function durationEstimate(history, key) {
  return finiteEstimate(history?.tasks?.[key]?.durationMs);
}

/**
 * The estimate the WATCHDOG BOUND must use — never the bare EWMA.
 *
 * EI-20803703725014949: operator-core::test:lane-stateful is BIMODAL (~7min vs
 * ~45min, both honest completions). An EWMA of a bimodal distribution settles
 * between the modes and describes neither, so a mostly-fast history collapses
 * the batch timeout to its floor and a legitimate slow-mode finish then races
 * a timer set at exactly its own duration — the "coin flip" the policy comment
 * in affected-tests.mjs explicitly forbids. Worse, a SIGKILLed leg records
 * elapsed≈timeout into the EWMA, so the estimate oscillates around the
 * coin-flip regime instead of ever escaping it (measured ~50% kill rate).
 *
 * A watchdog cares about the honest WORST case, not the typical case: take the
 * max of the EWMA and the decayed peak. Ordering keeps using durationEstimate
 * (the EWMA) — typical cost is the right input for scheduling.
 */
export function timeoutDurationEstimate(history, key) {
  const entry = history?.tasks?.[key];
  const ewma = finiteEstimate(entry?.durationMs);
  const peak = finiteEstimate(entry?.peakMs);
  if (ewma == null && peak == null) return null;
  return Math.max(ewma ?? 0, peak ?? 0);
}

/**
 * Per-run decay for the recorded peak: slow enough that one honest slow-mode
 * completion protects roughly the next dozen runs (0.9^12 ≈ 0.28), fast enough
 * that a one-off pathological outlier does not pin the timeout forever.
 */
const PEAK_DECAY_PER_RUN = 0.9;

/** Keep a small EWMA so one loaded run informs ordering without pinning it forever. */
export function mergeDurationHistory(
  history,
  observations,
  now = new Date().toISOString(),
) {
  const next = {
    version: DURATION_HISTORY_VERSION,
    tasks: { ...(history?.tasks ?? {}) },
  };
  for (const observation of observations) {
    const durationMs = finiteEstimate(observation?.durationMs);
    const key = typeof observation?.key === "string" ? observation.key : "";
    if (!key || durationMs == null) continue;
    const prior = next.tasks[key];
    const samples =
      Number.isSafeInteger(prior?.samples) && prior.samples > 0
        ? prior.samples
        : 0;
    // A legacy entry has no peakMs; seed the decay base from its EWMA rather
    // than 0 so an upgrade never *lowers* an existing task's effective bound.
    const priorPeak =
      finiteEstimate(prior?.peakMs) ?? finiteEstimate(prior?.durationMs) ?? 0;
    next.tasks[key] = {
      durationMs:
        samples > 0
          ? Math.round(prior.durationMs * 0.75 + durationMs * 0.25)
          : Math.round(durationMs),
      peakMs: Math.max(
        Math.round(durationMs),
        Math.round(priorPeak * PEAK_DECAY_PER_RUN),
      ),
      samples: samples + 1,
      updatedAt: now,
    };
  }
  return next;
}

/** Write via same-directory rename: readers see either the old complete JSON or the new one. */
export function writeDurationHistoryAtomic(
  path,
  history,
  nonce = `${process.pid}-${Date.now()}`,
) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${nonce}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function formatTaskBudgetMarker(
  stats,
  prefix = "AFFECTED_TESTS_SCHEDULER",
) {
  // EI-20801764054303492 step 3: report the memory term and WHICH term bound, so a gate run's
  // concurrency decision is readable from its own log instead of re-derived from source. Both are
  // derived defensively rather than required, so a hand-built stats object (tests, older callers)
  // still formats. `memAvailableMb` is appended only when the caller measured it — its absence is
  // meaningful ("no measurement"), so it is omitted rather than printed as 0 or null.
  const boundBy =
    stats.boundBy ??
    (stats.memoryWorkerBudget < stats.workerBudget ? "memory" : "ceiling");
  const measured =
    stats.memAvailableMb == null
      ? ""
      : ` memAvailableMb=${stats.memAvailableMb}`;
  const cgroup =
    stats.taskCgroupMemoryMaxMb == null
      ? ""
      : ` taskCgroupMemoryMaxMb=${stats.taskCgroupMemoryMaxMb}`;
  const pids =
    stats.taskCgroupPidsMax == null
      ? ""
      : ` configuredMaxTasks=${stats.configuredMaxConcurrentTasks ?? stats.maxConcurrentTasks}` +
        ` pidsMaxTasks=${stats.pidsMaxConcurrentTasks ?? stats.maxConcurrentTasks}` +
        ` taskBoundBy=${stats.taskBoundBy ?? "ceiling"}` +
        ` taskCgroupPidsMax=${stats.taskCgroupPidsMax}` +
        ` pidsPerTask=${stats.pidsPerConcurrentTask ?? PIDS_PER_CONCURRENT_TASK}` +
        ` pidsReserve=${stats.pidsReserve ?? PIDS_RESERVE}` +
        (stats.pidsBudgetAdapted
          ? ` pidsBudgetAdapted=1 configuredPidsPerTask=${stats.configuredPidsPerConcurrentTask ?? PIDS_PER_CONCURRENT_TASK}` +
            ` configuredPidsReserve=${stats.configuredPidsReserve ?? PIDS_RESERVE}`
          : "");
  return (
    `${prefix} mode=${stats.mode} workerBudget=${stats.workerBudget} ` +
    `memoryBudgetMb=${stats.memoryBudgetMb} workerMemoryMb=${stats.workerMemoryMb} ` +
    `effectiveWorkers=${stats.effectiveWorkerBudget} maxTasks=${stats.maxConcurrentTasks} ` +
    `reserveWorkers=${stats.reserveWorkers} memoryWorkers=${stats.memoryWorkerBudget} ` +
    `boundBy=${boundBy}${measured}${cgroup}${pids}`
  );
}

export function formatTaskBudgetObservedMarker(stats) {
  // EI-20801764054303492 route (a): the per-admission clamp is only trustworthy if a run can say
  // whether it actually measured anything and whether that measurement ever bit. Appended ONLY
  // when a reader was wired (memoryReadings != null) — a hand-built stats object, and every
  // caller that passes no reader, keeps the exact legacy string.
  const admission =
    stats.memoryReadings == null
      ? ""
      : ` memReadings=${stats.memoryReadings} clamps=${stats.admissionClamps} ` +
        `minAdmittedWorkers=${stats.minAdmittedWorkers}`;
  return (
    `AFFECTED_TESTS_SCHEDULER_OBSERVED maxWorkers=${stats.observedMaxWorkers} ` +
    `maxMemoryMb=${stats.observedMaxMemoryMb} maxTasks=${stats.observedMaxTasks}${admission}`
  );
}
