// batch-watchdog.mjs — the pure decision logic behind the per-batch process-level
// watchdog `scripts/affected-tests.mjs` applies to every workspace's test spawn
// (EI-19370814345784324).
//
// A test that blocks its vitest worker's event loop SYNCHRONOUSLY (a tight
// `mkdirSync` ENOENT/EEXIST spin was the observed case) makes vitest's own
// `testTimeout` unable to fire — that timeout is a timer on the very event loop
// the spin never yields, so the one bound that looks like it covers this is
// structurally incapable of firing. Measured 2026-08-02: a single wedged worker
// held the green-checkpoint gate (and every fleet deploy behind it) for 74
// minutes before being found and killed by hand.
//
// The fix has to live in the PARENT process, not the child's. `affected-tests`
// uses async `spawn`, so a parent-owned timer remains runnable even when the
// child's event loop is synchronously spinning. On expiry it kills the child's
// detached process group, not just the shallow npm wrapper, so descendants
// cannot keep the capture pipes open past the bound. This module extracts the
// timeout policy, attribution, and process-tree kill so the behavior is
// unit-testable with real objects instead of only a source-text regex assertion
// (which cannot catch a runtime fault on a path that, by construction, only
// ever runs once the gate is already red — see vitest-summary.mjs's own header
// for the same argument).

/**
 * Resolve the per-batch timeout in ms: an explicit positive override, or the
 * default. Deliberately generous relative to a normal suite run but well below
 * the ~120-minute green-checkpoint gate ceiling this exists to protect.
 *
 * @param {string | undefined} envValue raw `AFFECTED_BATCH_TIMEOUT_MS` value
 * @param {number} defaultMs fallback when unset / not a positive number
 * @returns {number}
 */
export function resolveBatchTimeoutMs(envValue, defaultMs) {
  const n = envValue ? Number(envValue) : NaN;
  return Number.isFinite(n) && n > 0 ? n : defaultMs;
}

/**
 * Resolve the watchdog for one task. Unknown tasks retain the configured floor;
 * tasks with history receive measured headroom, rounded up so small EWMA changes
 * do not churn the passing-verdict cache. The adaptive branch is capped below
 * the gate-wide ceiling, while an explicit operator override remains authoritative.
 *
 * @param {{ overrideMs?: number | null, floorMs: number, durationMs?: number | null,
 *   headroomMultiplier?: number, quantumMs?: number, maxMs: number }} opts
 * @returns {number}
 */
export function resolveTaskTimeoutMs({
  overrideMs,
  floorMs,
  durationMs,
  headroomMultiplier = 2,
  quantumMs = 5 * 60_000,
  maxMs,
}) {
  if (Number.isFinite(overrideMs) && overrideMs > 0) return overrideMs;
  if (!Number.isFinite(floorMs) || floorMs <= 0) {
    throw new TypeError('floorMs must be a positive finite number');
  }
  if (!Number.isFinite(maxMs) || maxMs < floorMs) {
    throw new TypeError('maxMs must be a finite number greater than or equal to floorMs');
  }
  if (!Number.isFinite(headroomMultiplier) || headroomMultiplier < 1) {
    throw new TypeError('headroomMultiplier must be a finite number greater than or equal to 1');
  }
  if (!Number.isFinite(quantumMs) || quantumMs <= 0) {
    throw new TypeError('quantumMs must be a positive finite number');
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) return floorMs;

  const measuredWithHeadroom = durationMs * headroomMultiplier;
  const rounded = Math.ceil(measuredWithHeadroom / quantumMs) * quantumMs;
  return Math.min(maxMs, Math.max(floorMs, rounded));
}

/**
 * Decide what to do when a task's watchdog deadline expires (EI-20803703725014949).
 *
 * The deadline alone cannot tell the two cases apart, and this module's own header
 * says which one it exists to kill: a test that blocks its worker's event loop
 * SYNCHRONOUSLY. That case is *silent* — a spinning worker emits nothing, so its
 * output goes flat and stays flat. A legitimately slow suite does the opposite: it
 * keeps completing files and keeps emitting right into the wall. Killing on elapsed
 * time alone cannot separate them, so under fleet load it SIGKILLs live work and
 * reports a non-code red — the failure `BATCH_TIMEOUT_FLOOR_MS`'s own comment calls
 * "a coin flip on load". Measured 2026-08-18: green-checkpoint RUN 9 lost
 * `operator-core :: test:lane-stateful` at exactly 2700s with captured output still
 * climbing (762,401B @2340s -> 797,873B @2700s) — killed while demonstrably alive,
 * which red-pinned a candidate that carried every fix the gate was waiting for.
 *
 * The parent already samples that signal; it was simply never consulted before the
 * kill (`classifyBatchProgress` ran only afterwards, to word the report). So the
 * deadline becomes a CHECKPOINT rather than a verdict: still advancing -> extend by
 * one quantum; gone quiet -> kill exactly as before.
 *
 * Two properties make this safe to put in front of the gate's only hard bound:
 *
 * 1. MONOTONE. Every branch either kills at the same instant today's code would, or
 *    kills LATER. No input makes it kill EARLIER, so it cannot introduce a new red.
 * 2. STILL BOUNDED. Extensions stop at `maxMs` (90m), below the ~120m gate ceiling
 *    this watchdog protects. A wedge that emits nothing is killed at the original
 *    deadline; a wedge that *chatters* while wedged is bounded by the ceiling. The
 *    unbounded-hang class that motivated the watchdog stays closed.
 *
 * Missing evidence FAILS SAFE: an unusable `lastProgressAgeMs` kills on time, so a
 * caller that cannot measure progress keeps exactly today's behavior.
 *
 * @param {{ elapsedMs: number, lastProgressAgeMs?: number | null, maxMs: number,
 *   stallWindowMs?: number, extensionMs?: number }} opts
 * @returns {{ action: 'kill' | 'extend', reason: 'absolute-ceiling' | 'progress-unknown'
 *   | 'progress-stalled' | 'invalid-policy' | 'progress-advancing', extendByMs: number }}
 */
export function decideWatchdogExpiry({
  elapsedMs,
  lastProgressAgeMs,
  maxMs,
  stallWindowMs = 5 * 60_000,
  extensionMs = 5 * 60_000,
}) {
  const kill = (reason) => ({ action: 'kill', reason, extendByMs: 0 });

  // A bad policy constant must not silently disable the bound: fail toward the kill.
  if (
    !Number.isFinite(stallWindowMs) ||
    stallWindowMs <= 0 ||
    !Number.isFinite(extensionMs) ||
    extensionMs <= 0 ||
    !Number.isFinite(elapsedMs)
  ) {
    return kill('invalid-policy');
  }

  const remainingToCeilingMs = Number.isFinite(maxMs) ? maxMs - elapsedMs : 0;
  if (remainingToCeilingMs <= 0) return kill('absolute-ceiling');

  // No live reading -> behave exactly as the time-only watchdog did.
  if (!Number.isFinite(lastProgressAgeMs) || lastProgressAgeMs < 0) {
    return kill('progress-unknown');
  }

  // Output went flat and stayed flat: this is the wedge the watchdog exists for.
  if (lastProgressAgeMs > stallWindowMs) return kill('progress-stalled');

  return {
    action: 'extend',
    reason: 'progress-advancing',
    extendByMs: Math.min(extensionMs, remainingToCeilingMs),
  };
}

/**
 * The re-arming watchdog itself, with its clock and timer injected.
 *
 * This lives here rather than inline in `affected-tests.mjs` for the reason this
 * module's header already gives: a timer that, by construction, only does anything
 * once the gate is already red cannot be covered by a source-text assertion. With
 * `now`/`setTimer` injected, the whole extend-then-kill sequence is exercised with
 * real objects and no wall-clock wait.
 *
 * `noteProgress()` is the forward-progress signal — the caller calls it when child
 * output arrives, because a synchronously-spinning worker cannot emit any.
 *
 * @param {{ timeoutMs: number, maxMs: number, stallWindowMs?: number, extensionMs?: number,
 *   now?: () => number, setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (handle: any) => void,
 *   onExtend?: (decision: ReturnType<typeof decideWatchdogExpiry>) => void,
 *   onKill?: (decision: ReturnType<typeof decideWatchdogExpiry>) => void }} opts
 */
export function createProgressAwareWatchdog({
  timeoutMs,
  maxMs,
  stallWindowMs,
  extensionMs,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  onExtend = () => {},
  onKill = () => {},
}) {
  const startedAt = now();
  let lastProgressAt = startedAt;
  let handle = null;
  let deadlineMs = timeoutMs;
  let killReason = null;
  let extensions = 0;
  let stopped = false;

  const arm = (delayMs) => {
    handle = setTimer(expire, delayMs);
    handle?.unref?.();
  };

  function expire() {
    if (stopped) return;
    const elapsedMs = now() - startedAt;
    const decision = decideWatchdogExpiry({
      elapsedMs,
      lastProgressAgeMs: now() - lastProgressAt,
      maxMs,
      stallWindowMs,
      extensionMs,
    });
    if (decision.action === 'extend') {
      extensions += 1;
      deadlineMs = elapsedMs + decision.extendByMs;
      onExtend(decision);
      arm(decision.extendByMs);
      return;
    }
    killReason = decision.reason;
    onKill(decision);
  }

  arm(timeoutMs);

  return {
    /** Child output arrived: forward progress is real. */
    noteProgress() {
      lastProgressAt = now();
    },
    /** The task settled on its own; the watchdog must not fire afterwards. */
    stop() {
      stopped = true;
      if (handle != null) clearTimer(handle);
    },
    get deadlineMs() {
      return deadlineMs;
    },
    get killReason() {
      return killReason;
    },
    get extensions() {
      return extensions;
    },
    /**
     * How long child output has been FLAT, in ms — the same `lastProgressAt`
     * the kill policy already consults, exposed so a LOG READER can see it too.
     *
     * WI-41180 / EI-21223031134313862: an idle-deadlocked task keeps emitting
     * `AFFECTED_TASK_PROGRESS state=running` with a rising `elapsedSec` while
     * consuming zero CPU, so a wedged run is byte-indistinguishable from a slow
     * one until the watchdog kills it (2700s here). Agents therefore WAIT on
     * runs that are already dead — measured twice on 2026-08-24, ~40min lost.
     *
     * This is READ-ONLY and deliberately changes no timing: the watchdog's
     * MONOTONE property (no input makes it kill EARLIER, so it cannot introduce
     * a new red) is exactly what protects live-but-slow work from being SIGKILLed
     * under fleet load, and it must not be traded away for faster detection.
     * Surfacing the signal costs nothing and needs no such trade.
     */
    get msSinceProgress() {
      return now() - lastProgressAt;
    },
  };
}

/**
 * Did THIS `spawnSync` result come from our own batch-level watchdog kill,
 * rather than the child's own normal exit or an unrelated external signal
 * (an operator's manual kill, the kernel OOM killer — both can also send
 * SIGKILL)? `signal === killSignal` alone is ambiguous; requiring the elapsed
 * wall-clock to have essentially cleared the configured window is what makes
 * the attribution positive rather than a guess.
 *
 * @param {{ signal: string | null, status: number | null, elapsedMs: number }} result
 * @param {{ killSignal: string, timeoutMs: number, slackMs?: number }} opts
 * @returns {boolean}
 */
export function isWatchdogTimeout(result, { killSignal, timeoutMs, slackMs = 2000 }) {
  return (
    result.signal === killSignal &&
    result.status === null &&
    (result.elapsedMs ?? 0) >= timeoutMs - slackMs
  );
}

/**
 * Kill a spawned task's whole process group, falling back to the direct child
 * only when the group is unavailable. Callers must spawn the child with
 * `detached: true` so its pid is also the process-group id.
 *
 * Killing only the npm/vitest wrapper is not enough: descendants retain the
 * captured stdout/stderr pipes, so Node's `close` event can arrive minutes
 * after the watchdog fired. The group kill makes the watchdog a real bound on
 * the task tree rather than merely a signal sent to its shallowest process.
 *
 * @param {{ pid?: number, kill?: (signal: string) => unknown } | null | undefined} child
 * @param {string} signal
 * @returns {'group' | 'child' | 'gone'}
 */
export function killSpawnedProcessTree(child, signal) {
  const pid = child?.pid;
  if (process.platform !== 'win32' && Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(-pid, signal);
      return 'group';
    } catch {
      // The group may have exited between the timeout firing and this call.
      // Fall through so a still-live direct child cannot escape the bound.
    }
  }
  try {
    child?.kill?.(signal);
    return 'child';
  } catch {
    return 'gone';
  }
}

// Vitest's per-file rollup rows are the only output that proves a file completed.
// Do not count arbitrary `.test.ts` mentions: failure details, stack traces, and
// reporter metadata mention paths too, but none of those establish forward progress.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const COMPLETED_FILE_ROW_RE = /^\s*[✓❯]\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s+\([^)]*\)\s+(\d+(?:\.\d+)?)ms\s*$/;
const TOTAL_FILES_RE = /^\s*Test Files\b.*\((\d+)\)\s*$/m;

/**
 * Parse the progress evidence available in a captured Vitest report.
 *
 * This intentionally returns an "observed" signal, not a claim that the child
 * was advancing at the instant it was killed: `spawnSync` only gives this parent
 * the captured bytes after the native wait ends, so those bytes have no timestamps.
 * A caller with a live stream may pass `lastProgressAgeMs` to
 * `classifyBatchProgress` when it has that stronger evidence.
 *
 * @param {string | null | undefined} output captured child output; null means it was streamed
 * @param {{ totalFiles?: number }} [opts]
 * @returns {{ available: boolean, completedFiles: number, totalFiles: number | null,
 *   completedFilePaths: string[], lastCompletedFile: string | null, lastDurationMs: number | null,
 *   completionRows: number }}
 */
export function parseBatchProgress(output, { totalFiles } = {}) {
  const suppliedTotal = Number.isInteger(totalFiles) && totalFiles > 0 ? totalFiles : null;
  if (typeof output !== 'string') {
    return {
      available: false,
      completedFiles: 0,
      totalFiles: suppliedTotal,
      completedFilePaths: [],
      lastCompletedFile: null,
      lastDurationMs: null,
      completionRows: 0,
    };
  }

  const paths = new Set();
  let lastCompletedFile = null;
  let lastDurationMs = null;
  let completionRows = 0;
  for (const line of output.replace(ANSI_RE, '').split(/\r?\n/)) {
    const match = COMPLETED_FILE_ROW_RE.exec(line);
    if (!match) continue;
    completionRows += 1;
    paths.add(match[1]);
    lastCompletedFile = match[1];
    lastDurationMs = Number(match[2]);
  }

  const summaryTotal = TOTAL_FILES_RE.exec(output.replace(ANSI_RE, ''));
  const reportedTotal = summaryTotal ? Number(summaryTotal[1]) : null;
  return {
    available: true,
    completedFiles: paths.size,
    totalFiles: suppliedTotal ?? (Number.isInteger(reportedTotal) && reportedTotal > 0 ? reportedTotal : null),
    completedFilePaths: [...paths],
    lastCompletedFile,
    lastDurationMs,
    completionRows,
  };
}

/**
 * Classify progress without upgrading weak evidence into a spin diagnosis.
 *
 * `lastProgressAgeMs` is optional because the current synchronous capture path
 * cannot measure it. Only an explicitly stale live-stream reading earns the
 * `stalled` classification; a captured report is merely observed or unknown.
 *
 * @param {{ available: boolean, completedFiles: number }} progress
 * @param {{ lastProgressAgeMs?: number, staleAfterMs?: number }} [opts]
 * @returns {'unknown' | 'no-progress-observed' | 'progress-observed' | 'advancing' | 'stalled'}
 */
export function classifyBatchProgress(progress, { lastProgressAgeMs, staleAfterMs = 10_000 } = {}) {
  if (!progress?.available) return 'unknown';
  if (Number.isFinite(lastProgressAgeMs)) {
    return lastProgressAgeMs > staleAfterMs ? 'stalled' : 'advancing';
  }
  return progress.completedFiles > 0 ? 'progress-observed' : 'no-progress-observed';
}

/**
 * Render the evidence for a watchdog diagnostic. The wording is deliberately
 * conservative when output timing is unavailable: it never tells a triager to
 * hunt a spinning test based on a path mention or on an empty capture alone.
 *
 * @param {{ available: boolean, completedFiles: number, totalFiles: number | null }} progress
 * @param {ReturnType<typeof classifyBatchProgress>} classification
 * @returns {string}
 */
export function formatBatchProgress(progress, classification = classifyBatchProgress(progress)) {
  if (!progress?.available) return 'progress UNKNOWN (output was streamed, not captured)';
  const count = progress.totalFiles ? `${progress.completedFiles}/${progress.totalFiles}` : `${progress.completedFiles}`;
  if (classification === 'advancing') return `${count} test file(s) done; progress still advancing`;
  if (classification === 'stalled') return `${count} test file(s) done; progress stopped (spin is now a supported hypothesis)`;
  if (classification === 'no-progress-observed') {
    return `no completed test-file rows observed (capture has no timing; cannot infer a spin)`;
  }
  return `${count} test file(s) done; completion rows observed, but capture has no timing (do not infer a spin)`;
}
