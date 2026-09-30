#!/usr/bin/env node
// Find workspaces affected by a git diff and run their vitest suites.
//
// Usage:
//   node scripts/affected-tests.mjs [--base <ref>] [--integration] [--all]
//
// Defaults:
//   --base origin/main
//   runs the unit suite (`npm test`) per affected workspace
//
// Flags:
//   --integration   also run `npm run test:integration` where defined
//   --all           ignore git diff; run every workspace's tests
//   --dry           print what would run, don't run
//
// Diagnostics:
//   --print-affected                  print `AFFECTED_WS\t<name>`, one runnable
//                                      `AFFECTED_WS_CMD\t<workspace>\t<command>` per selected task,
//                                      and matching
//                                      `AFFECTED_GUARD\t<workspace>\t<script>\t<command>` lines, then exit
//   --changed-paths a/b.ts,c/d.mjs    derive the affected set from these paths instead of a git diff
//   --changed-paths=a/b.ts,c/d.mjs    equivalent `--flag=value` spelling
//
//   Together they answer "which suites would a change to THESE files run?" —
//     node scripts/affected-tests.mjs --changed-paths scripts/lint-tsc.mjs --print-affected
//   which a git-based probe cannot answer here: git-sync sweeps the whole tree, so no
//   real commit is ever scoped to just your paths.

import { execSync, execFileSync, spawn, spawnSync } from "node:child_process";
import {
  readFileSync,
  existsSync,
  appendFileSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadavg, availableParallelism, tmpdir, homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { parseQuarantineWorkspaces } from "./lib/quarantine.mjs";
import {
  parseSummaryFailedCounts,
  parseFailedTestFiles,
  countTimeoutSignatures,
  attributeFailedTask,
  renderFailingFilesSummary,
  failureEntryKey,
  classifyStaleFailureEntries,
  formatStaleFailureSummary,
  formatTreeDriftAdvisory,
  classifyFailureScope,
  formatFailureScopeSummary,
  formatSelectedFilesLine,
  emptyCoverage,
  foldTaskCoverage,
  formatCoverageFields,
  formatNotExecutedSummary,
} from "./lib/vitest-summary.mjs";
import {
  RELATED_FILTER_LIST_ENV,
  selectRelatedTests,
  playwrightOwnedTest,
  unitExcludedVitestTest,
  writeRelatedFilterList,
} from "./lib/related-tests.mjs";
import {
  EXECUTED_MAP_RESULT_ENV,
  EXECUTED_MAP_WORKSPACE_ENV,
  clearExecutedMapResult,
  executedMapResultPath,
  formatExecutedMapAlarmLines,
  formatExecutedMapResultLines,
  formatExecutedMapTotalLine,
  readExecutedMapResults,
  resolveTaskReportExpectation,
  summarizeExecutedMapResults,
  connectExecutedMapPg,
  executedMapEnabled,
  executedMapRecordingEnabled,
  formatExecutedMapLine,
  gitChangedBetween,
  loadExecutedSourceMap,
  loadPassDurations,
  loadReuseProofs,
} from "./lib/executed-source-map.mjs";
import {
  TEST_REUSE_SKIP_LIST_ENV,
  estimateReuseSavings,
  formatReuseAlarmLine,
  formatTestReuseLine,
  formatTestReuseTotalLine,
  reuseCandidates,
  reuseSoundnessAlarms,
  selectReusablePasses,
  testReuseAuditRate,
  testReuseEnabled,
  testReuseMaxAgeMs,
  writeReuseSkipList,
} from "./lib/test-pass-reuse.mjs";
import {
  decideRetry,
  deriveRetryBudget,
  formatRetryBudgetLine,
  formatRetryDecisionLine,
  formatRetryPoolLine,
} from "./lib/retry-failure-shape.mjs";
import { stripCommentsOnly } from "./lib/strip-comments-and-strings.mjs";
import { emptySuiteGuardArgs } from "./lib/empty-suite-guard.mjs";
// EI-21082046676950143: the lint:declared-consumed guard entry below keys on the guard's OWN
// declaring-path set rather than restating any of it — fields (`declaredIn`), columns (their
// migration), and the registry module itself. Import-safe: check-declared-consumed.mjs runs
// nothing at module scope behind its `import.meta.url === process.argv[1]` main guard.
import { declaringPaths as declaredConsumedPaths } from "./check-declared-consumed.mjs";

/** Frozen once: the guard's policed declaration sites, as an exact-path membership test. */
const DECLARED_CONSUMED_PATHS = new Set(declaredConsumedPaths());
import {
  summarizeDerivation,
  formatDerivationMarker,
  derivationBannerLines,
} from "./lib/changed-path-provenance.mjs";
import { applyWorkerCapEnv } from "./lib/worker-cap.mjs";
// Deliberately imported from lib/, NOT from scripts/test-files.mjs: that module
// runs top-level side effects (ensurePapercuspTmpdir, applyWorkerCapEnv) which
// must not be dragged onto the gate's runner (EI-21884510946030513).
import {
  createPreemptMarkerExclusive,
  reapPreemptMarkerDebris,
} from "./lib/preempt-markers.mjs";
import {
  TEST_CERTIFIED_REF,
  resolveTestCertifiedBase,
  decideWatermarkAdvance,
  baseSourceLine,
} from "./lib/test-certified-base.mjs";
import {
  resolveBatchTimeoutMs,
  resolveTaskTimeoutMs,
  createProgressAwareWatchdog,
  isWatchdogTimeout,
  killSpawnedProcessTree,
  parseBatchProgress,
  classifyBatchProgress,
  formatBatchProgress,
} from "./lib/batch-watchdog.mjs";
import { ensurePapercuspTmpdir } from "../libs/test-config/src/tmpdir-guard.ts";
import { sweepStaleTestScratch } from "../libs/test-config/src/hermetic-tmpdir.ts";

// EI-20767792192323374 — MUST happen HERE, in the launcher, and not in vitest.config.ts.
// Vitest fixes its module-cache root as a class field initializer (`_tmpDir = join(tmpdir(),
// nanoid())`) when `new Vitest()` is constructed, which `createVitest()` does BEFORE it loads any
// vitest config — so the identical call inside @papercusp/test-config's vitest-config.ts is always
// too late for it. Left unset, that root lands at bare `/tmp/<nanoid>`: un-namespaced,
// un-attributable, and in the blast radius of anything sweeping `/tmp/*`. On 2026-08-18 something
// swept it mid-run and 5,448 rows across 4,789 files failed with `ENOENT ... mkdir
// '/tmp/<nanoid>/ssr'` — the gate counted that as red #20 and froze every agent's deploys.
// This is the gate's own entrypoint, so it is the single highest-value call site.
ensurePapercuspTmpdir();
import { classifyTaskExit, isGatingFailure } from "./lib/task-exit-class.mjs";
import { formatTaskOutcomeFields } from "./lib/task-progress-line.mjs";
import {
  classifyResidualFailure,
  formatLoadSuspectNotice,
  formatLoadSuspectMarker,
} from "./lib/load-suspect.mjs";
import {
  classifyAffectedCargoFailure,
  shouldRunAffectedCargoSuite,
} from "./lib/cargo-result.mjs";
import { listFilesIncludingUntracked, listTrackedFiles } from "./lib/tracked-files.mjs";
import {
  classifyRetryTreeProvenance,
  formatRetryTreeProvenanceNotice,
  snapshotRetryTree,
} from "./lib/retry-tree-provenance.mjs";
// D-021/P-002: summed task work, measured per-run. The helper/marker retain their legacy
// "serial" names, but after budgeted scheduling the sum is serial-equivalent work rather than
// elapsed wall time. See scripts/lib/serial-phase.mjs.
import { formatSerialPhaseSummary } from "./lib/serial-phase.mjs";
import {
  classifyAffectedBlastRadius,
  durationEstimate,
  estimateBudgetedTaskWallMs,
  formatAffectedTaskShardMarker,
  formatTaskBudgetMarker,
  formatTaskBudgetObservedMarker,
  mergeDurationHistory,
  planAffectedTaskShards,
  pidsEventRefusalDelta,
  readDurationHistory,
  readTaskCgroupMemoryMaxMb,
  readTaskCgroupPidsEventMax,
  readTaskCgroupPidsMax,
  resolveGlobalWorkerBudget,
  resolveMemoryBudgetMb,
  resolveTaskBudget,
  resolveWorkerMemoryMb,
  isSharedAdmissionTimeout,
  isTaskDeadlineRefusal,
  runBudgetedTaskShards,
  runBudgetedTasks,
  timeoutDurationEstimate,
  writeDurationHistoryAtomic,
} from "./lib/budgeted-task-scheduler.mjs";
import {
  buildPassingTaskVerdictIdentity,
  closureDigestManifestPath,
  decidePassingTaskVerdict,
  diffClosureDigests,
  diffIdentityEnvDigests,
  formatClosureDeltaLine,
  formatIdentityEnvDeltaLine,
  identityEnvDigests,
  formatPassingTaskVerdictSummary,
  hashDependencyFileSet,
  mergeClosureDigestManifest,
  observedClosureDigests,
  readClosureDigestManifest,
  mergePassingTaskVerdictUpdates,
  namespacePassingTaskVerdictDecision,
  passingTaskVerdictCacheEntry,
  passingTaskVerdictCrossRunIdentityEnvironment,
  passingTaskVerdictCrossRunGateConfig,
  passingTaskVerdictDependencyProvenance,
  passingTaskVerdictIdentityEnvironment,
  passingTaskVerdictSharedInputProvenance,
  PASSING_TASK_VERDICT_CROSS_RUN_GROUP,
  passingTaskVerdictEntry,
  readPassingTaskVerdictCache,
  shouldStorePassingTaskVerdict,
  writePassingTaskVerdictCacheAtomic,
} from "./lib/passing-task-verdict-cache.mjs";
// WI-1048027 layer 2. Safe to import despite running on the crash path: ESM imports are
// hoisted and fully initialized before this module's body executes, so unlike a closure
// over a `let` declared further down (the TDZ hazard the abort block below is built
// around), this binding cannot be unresolved when emitAbortMarker fires.
import { formatTerminalCounterFields } from "./lib/terminal-counter-fields.mjs";
// EI-10542: this runner interleaves its own header/status lines (fd 1/2) with
// child suite output written synchronously via `stdio: 'inherit'`. On a non-TTY
// fd (the gate captures to a pipe/file) `console.*` is async-buffered and flushes
// AFTER the blocking spawnSync child has already written, so a workspace's output
// prints under another workspace's header. Emit our own lines synchronously so
// they stay glued to the child output they label. See scripts/lib/sync-write.mjs.
import {
  appendAllSync,
  writeAllSync,
  outSync as rawOutSync,
  errSync as rawErrSync,
} from "./lib/sync-write.mjs";
import {
  buildGovernedProcessDemand,
  classifyGovernedTestProcessOutcome,
  createGovernedProcessDemandSampler,
  governedProcessIdempotencyKey,
  runGovernedTestProcess,
} from "./lib/governed-test-process.mjs";

// EI-15802: an agent running this as a BACKGROUND task only sees the harness's
// own truncated tail (~150 lines) plus an exit-code notification — on a long
// combined JS+cargo run that window can cover only the FINAL suite's summary,
// so an agent trusting either the exit code alone or the truncated tail alone
// gets a false read in opposite directions (a real earlier failure hidden by a
// later 'exit 0' cargo pass, or vice versa). Always write the FULL run's output
// — this script's own header/status lines AND every child suite's stdout/stderr
// — to one discoverable, fixed-per-run log file, and print its path prominently
// at the very start (survives a truncated tail) and again at the end (both the
// success and failure summaries). `outSync`/`errSync` below shadow the raw
// sync-write helpers so every EXISTING call site in this file gets logged for
// free, with zero behavior change to what's written to the real fd.
// EI-18121314648626462: keying solely on process.pid is NOT collision-proof —
// under this host's heavy concurrent load (dozens of agents + the hourly
// green-checkpoint routine all running this script), Linux recycles PIDs
// within minutes, so two unrelated invocations (e.g. a staging-tree run and a
// papercusp-checkpoint-tree run started ~10min apart) can land on the SAME
// reused PID and silently append/overwrite each other's log — corrupting the
// "Full run log: ..." path every downstream verifier trusts as evidence. Add a
// short random nonce (independent of pid, time-of-day, and host clock skew) so
// two concurrent runs can never collide, while keeping the pid in the filename
// for human readability when correlating with `ps`/`top`.
// EI-19395701908500754: hoisted out of the path so the SAME token can stamp the
// per-FILE break-set line below. A green-checkpoint verdict log interleaves this
// run's output with the gate's own self-test fixtures, which emit identically-shaped
// lines; a token that is also in the `Full run log:` path is what lets a reader tie a
// break set to THIS run instead of to a fixture that hard-codes a different one.
const RUN_TOKEN = `${process.pid}-${randomBytes(4).toString("hex")}`;
/** WI-10003603: taskKey → the executed-source-map result file its initial invocation was given. */
const executedMapResultFiles = new Map();
/** WI-10003792: taskKey → whether that task's recorder is EXPECTED to report (resolved at arming). */
const executedMapReportExpectations = new Map();
// WI-41782: keep one attributable entry in the SHARED TMPDIR instead of one
// top-level file per invocation. The log deliberately outlives this process so a
// background-job notifier or later triager can read the complete verdict; deleting
// it from an exit handler would remove the evidence it exists to preserve, and a
// signal-killed process would not run that handler anyway. Reuse the existing
// lifecycle-independent, rotating age sweep instead: recent diagnostics remain for
// four hours, while every future invocation contributes cleanup without depending
// on the dying process to cooperate.
const RUN_LOG_ROOT = join(tmpdir(), "papercusp-affected-tests");
mkdirSync(RUN_LOG_ROOT, { recursive: true });
sweepStaleTestScratch(RUN_LOG_ROOT);
const RUN_LOG_PATH = join(RUN_LOG_ROOT, `${RUN_TOKEN}.log`);
// EI-21921867787033533: `Full run log: ${RUN_LOG_PATH}` was previously emitted to
// stdout/stderr ONLY on a clean terminal path (every `outSync`/`errSync` call further
// down this file) — so a run that WEDGES (reaches the shared test-process admission
// mutex, or any other silent-wait state, and never terminates) leaves an observer with
// no way to find its own log file short of guessing the `/tmp/papercusp-affected-tests/`
// naming pattern. Emit the path once, immediately, before any work that could hang —
// via `errSync` (not `console.error`/`process.stderr.write`) so it also lands in the
// log itself and stays inside the synchronous-write contract
// `affected-tests-stdout-ordering.test.ts` enforces on this file.
errSync(`Full run log: ${RUN_LOG_PATH}`);
// EI-21429853249887727: a near-tree-wide checkpoint forwarded 5,976 paths to
// lint:required-field-strands as ONE `--files=...` argument. Linux caps a single argv
// entry well below ARG_MAX, so node:child_process.spawn threw E2BIG synchronously and the
// entire gate died as `exit-without-verdict` after every recorded test had passed. Small
// scopes retain the readable inline form; large (or comma/newline-bearing) scopes reuse
// lint:tsc's JSON `--files-from=` response-file contract.
const FORWARDED_FILES_INLINE_MAX_BYTES = 32 * 1024;
const forwardedFilesResponsePaths = [];
function explicitFilesArgs(files) {
  if (!files.length) return [];
  const inline = `--files=${files.join(",")}`;
  if (
    Buffer.byteLength(inline, "utf8") <= FORWARDED_FILES_INLINE_MAX_BYTES &&
    files.every((file) => !/[\r\n,]/.test(file))
  ) {
    return [inline];
  }
  const responsePath = join(
    RUN_LOG_ROOT,
    `${RUN_TOKEN}-files-${forwardedFilesResponsePaths.length}.json`,
  );
  writeFileSync(responsePath, JSON.stringify(files), {
    flag: "wx",
    mode: 0o600,
  });
  forwardedFilesResponsePaths.push(responsePath);
  return [`--files-from=${responsePath}`];
}
function cleanupForwardedFilesResponses() {
  for (const responsePath of forwardedFilesResponsePaths.splice(0)) {
    try {
      unlinkSync(responsePath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        logLine(
          `AFFECTED_FILES_RESPONSE cleanup failed path=${responsePath}: ${String(error?.message ?? error)}\n`,
        );
      }
    }
  }
}
function logLine(text) {
  if (text == null || text === "") return;
  try {
    appendFileSync(RUN_LOG_PATH, String(text));
  } catch {
    // Logging must never fail the actual test run.
  }
}
function outSync(msg = "") {
  rawOutSync(msg);
  logLine(`${msg}\n`);
}
function errSync(msg = "") {
  rawErrSync(msg);
  logLine(`${msg}\n`);
}
// ── How the run ENDED, recorded in the run's own log (EI-18682539587976453) ──
// The `AFFECTED_TESTS_RESULT` line is emitted on every CLEAN exit path, and
// EI-18796017307093897's guard pins exactly that. But a run that is KILLED reaches
// none of them, so the marker's ABSENCE means either "still running" or "died" —
// and telling those two apart is precisely what a triager needs. Measured
// near-miss: a background test:affected killed at a compaction boundary left a log
// whose last line was a clean "0 errors" — byte-for-byte what a healthy in-progress
// run looks like at that instant. It was caught only by noticing a stale mtime and
// hunting for the process. Absence is not a signal; it is the lack of one.
//
// So every termination this process can OBSERVE now emits the marker exactly once,
// and for the ones it CANNOT observe — every signal, for the reason spelled out at
// the `process.on('exit')` block below — the BEGIN line carries the pid, so a reader
// holding a marker-less log settles "dead or still running" with `kill -0 <pid>`
// instead of a pgrep pattern that self-matches. Both halves are needed: a log is
// only self-identifying if EVERY way it can end is either stamped or classifiable.
let terminalEmitted = false;
// `--print-affected` is an ENUMERATION query, not a run: it deliberately emits no
// verdict marker so a parser gets a clean AFFECTED_WS/AFFECTED_GUARD list, and two
// tests pin that absence. Exempt it rather than teaching every caller to ignore a
// marker they were promised would not appear.
let terminalSuppressed = false;
// pc-heavy allocates this unique, absent path only for callers that opt into
// the after-ready barrier. The runner publishes it after derivation and before
// the first task starts; pc-heavy also removes it if this process is killed.
const preemptReadyFile =
  process.env.PC_HEAVY_PREEMPT_READY_FILE?.trim() || null;
let preemptReadyPublished = false;
// pc-heavy's after-ready wrapper also allocates a private finalization path. Once
// every initial task has settled, publish it before replaying task output and
// running the aggregate reporting/attribution steps below. Without this barrier,
// the PSI supervisor can freeze/SIGKILL the aggregate in the narrow gap after the
// last AFFECTED_TASK_OUTPUT_END but before AFFECTED_TESTS_RESULT is emitted.
const preemptFinalizationFile =
  process.env.PC_HEAVY_PSI_FINALIZATION_FILE?.trim() || null;
let preemptFinalizationPublished = false;
function cleanupPreemptReadyMarker() {
  if (!preemptReadyPublished || !preemptReadyFile) return;
  try {
    unlinkSync(preemptReadyFile);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      logLine(
        "PC_HEAVY_PREEMPT_READY cleanup failed: " +
          String(error?.message ?? error) +
          "\n",
      );
    }
  } finally {
    preemptReadyPublished = false;
  }
}
function cleanupPreemptFinalizationMarker() {
  if (!preemptFinalizationPublished || !preemptFinalizationFile) return;
  try {
    unlinkSync(preemptFinalizationFile);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      logLine(
        "PC_HEAVY_PSI_FINALIZATION cleanup failed: " +
          String(error?.message ?? error) +
          "\n",
      );
    }
  } finally {
    preemptFinalizationPublished = false;
  }
}
/**
 * Sweep abandoned markers out of the directory we just published into.
 *
 * Pure hygiene, and swallowed whole: our own barrier is already published by the
 * time this runs, so a misbehaving sweep cannot cost this run its protection,
 * and failing to tidy must never fail a gate run.
 *
 * @param {string} marker the marker this process owns — never judged
 * @param {string} label log prefix
 */
function reapPreemptMarkerNeighbours(marker, label) {
  try {
    const reaped = reapPreemptMarkerDebris(dirname(marker), { self: marker });
    if (reaped.length > 0) {
      logLine(label + " reaped-abandoned-markers count=" + reaped.length + "\n");
    }
  } catch {
    // Hygiene is never worth failing a run over.
  }
}
function publishPreemptReadyMarker() {
  if (!preemptReadyFile) return;
  try {
    // wx is deliberate: the wrapper owns a unique absent path, and an inherited
    // or accidentally shared marker must not be mistaken for this run's barrier.
    //
    // But a collision is only PROTECTING something when a LIVE owner holds the
    // path. Treating every EEXIST as fatal aborted the whole run with exit 75 —
    // and because this is `test:affected`, an abort means zero files were
    // measured, so infra debris read as a genuine red on the runner the
    // green-checkpoint gate itself invokes. `test-files.mjs` was fixed for this
    // in EI-21882371330313535; the copy here kept the fatal rule until
    // EI-21884510946030513. The asymmetric rule now lives in one place:
    // dead or long-stale debris is reclaimed, a live owner still wins, and
    // every ambiguous case resolves to LIVE.
    if (createPreemptMarkerExclusive(preemptReadyFile) === "reclaimed") {
      logLine(
        "PC_HEAVY_PREEMPT_READY reclaimed-stale-marker pid=" + process.pid + "\n",
      );
    }
    preemptReadyPublished = true;
    logLine("PC_HEAVY_PREEMPT_READY pid=" + process.pid + "\n");
  } catch (error) {
    errSync(
      "[affected-tests] refusing execution phase: could not publish the " +
        "pc-heavy after-ready marker: " +
        String(error?.message ?? error),
    );
    process.exit(75);
  }
  reapPreemptMarkerNeighbours(preemptReadyFile, "PC_HEAVY_PREEMPT_READY");
}
function publishPreemptFinalizationMarker() {
  if (!preemptFinalizationFile || preemptFinalizationPublished) return;
  try {
    // Same asymmetric rule as the after-ready marker above: pc-heavy owns this
    // unique absent path, so a collision is debris far more often than it is a
    // live peer — and aborting the finalization phase loses the verdict for a
    // run whose tests have all already completed.
    if (createPreemptMarkerExclusive(preemptFinalizationFile) === "reclaimed") {
      logLine(
        "PC_HEAVY_PSI_FINALIZATION reclaimed-stale-marker pid=" +
          process.pid +
          "\n",
      );
    }
    preemptFinalizationPublished = true;
    logLine("PC_HEAVY_PSI_FINALIZATION pid=" + process.pid + "\n");
  } catch (error) {
    errSync(
      "[affected-tests] refusing finalization phase: could not publish the " +
        "pc-heavy PSI finalization marker: " +
        String(error?.message ?? error),
    );
    process.exit(75);
  }
  reapPreemptMarkerNeighbours(
    preemptFinalizationFile,
    "PC_HEAVY_PSI_FINALIZATION",
  );
}
// Counters for the abort path, read through a swappable closure because the real
// bindings (`tasks`, `failed`, …) are declared ~1500 lines below: a closure over a
// not-yet-initialized `let` throws a TDZ ReferenceError, and a crash INSIDE the
// crash handler loses the verdict entirely — the failure this whole block exists to
// prevent. Upgraded in place once the real counters exist; until then zeros are the
// honest answer, because no task has run yet.
let plannedTaskCount = 0;
// WI-1048027 layer 2 — OBSERVATION counters, deliberately separate from the tally
// counters below. Run 4 died between OBSERVING a task exit 1 (a governed-admission
// error under a pgbouncer CONNECTION_CLOSED) and TALLYING it: the crash arrived from
// an async postgres.js `Immediate` callback, so `failed++` in the run loop never ran.
// The abort marker reports the tally, so the verdict read
// `tasks=121 failed=0 quarantinedFailed=0 timedOutTasks=0 undeterminedTasks=0` —
// every counter zero, which reads as "121 tasks ran, nothing failed" when in fact
// ~85 had started and one had already exited nonzero.
//
// These two are incremented at the moment an outcome is OBSERVED (inside emitProgress
// and the admission-error path), never at tally time, so they survive exactly the
// window that loses the tally. They are module-scope and initialized to 0, so both the
// pre-upgrade closure here and the upgraded one further down can read them with no TDZ
// risk — which is what lets an abort BEFORE the run loop stay honest too.
let observedNonzeroExits = 0;
let observedAdmissionErrors = 0;
let readTerminalCounters = () => ({
  tasks: plannedTaskCount,
  failed: 0,
  quarantinedFailed: 0,
  timedOutTasks: 0,
  undeterminedTasks: 0,
  observedNonzeroExits,
  observedAdmissionErrors,
});
/** Emit the terminal marker for a run that did NOT reach a clean verdict path. */
function emitAbortMarker(extra) {
  if (terminalEmitted || terminalSuppressed) return;
  terminalEmitted = true;
  const c = readTerminalCounters();
  // The same marker fields appear on every terminal path, so one grep classifies
  // any log — a reader must not need a second parser for the abnormal case.
  // WI-1048027 layer 2: the observation counters are appended TRAILING so the existing
  // prefix (through `undeterminedTasks=`) is byte-identical for anything already parsing
  // this line — the same additive discipline AFFECTED_TASK_PROGRESS uses.
  //
  // `tasks=` is the PLANNED count, not the started one. On an abort that reads as
  // "N tasks ran", which is how run 4's `tasks=121 failed=0` was nearly taken for a
  // clean sweep. The discrepancy note below states the contradiction in words rather
  // than leaving a reader to notice that two numbers disagree.
  errSync(
    `AFFECTED_TESTS_RESULT status=aborted tasks=${c.tasks} failed=${c.failed} ` +
      `quarantinedFailed=${c.quarantinedFailed} timedOutTasks=${c.timedOutTasks} ` +
      `undeterminedTasks=${c.undeterminedTasks} ${extra}` +
      formatTerminalCounterFields(c).text,
  );
}
// Written to the run log only — never stdout/stderr. Its job is to make the LOG
// self-identifying, and stdout carries parsed contracts (`--print-affected`) that
// gain nothing from it.
logLine(
  `AFFECTED_TESTS_BEGIN run=${RUN_TOKEN} pid=${process.pid} at=${new Date().toISOString()}` +
    ` (no AFFECTED_TESTS_RESULT below ⇒ this run never terminated on its own: check \`kill -0 ${process.pid}\`)\n`,
);
// ⚠⚠ DELIBERATELY NO SIGTERM/SIGINT TRAP HERE — it is the obvious fix, it is what
// EI-18682539587976453 proposed, and it MAKES THIS SCRIPT WORSE. Measured 2026-08-12
// on this file: with `process.on('SIGTERM', …)` registered, a group SIGTERM mid-run
// left the run ALIVE and marker-less 105s later, and it took a SIGKILL to reap.
//
// Two facts compose into that: (1) registering ANY listener for a signal removes its
// default disposition, so the process no longer dies on delivery; (2) a JS signal
// handler runs on the event loop, and this script's run loop is a SYNCHRONOUS chain
// of `spawnSync` calls that never yields a turn — so the handler that was supposed
// to write the marker cannot run until the whole run is over anyway. The trap thus
// buys no marker and costs promptness: it converts a killable runner into one that
// only SIGKILL can stop, against a repo whose kill discipline is load-bearing.
//
// SECOND, INDEPENDENT REASON (WI-42144) — the absence of this trap is what keeps a
// pc-heavy RETRY SERIES from emitting contradictory verdict lines, and that load is
// carried nowhere else. `npm run test:affected` runs under
// PC_HEAVY_RETRY_PREEMPTIONS=3, so one invocation can be up to 4 attempts. pc-heavy
// isolates only STDOUT between attempts; stderr stays inherited, and this script emits
// its whole FAILURE surface on stderr (`AFFECTED_TESTS_RESULT status=failed`,
// `AFFECTED_TESTS_FAILING_FILES`, the failing-task bullets) while `status=passed` goes
// to stdout. green-checkpoint parses the two streams concatenated. Today that is safe
// for exactly one reason: with no trap, a preempted attempt dies before reaching ANY
// terminal path, so it contributes no verdict line and there is nothing to duplicate —
// measured on /tmp/wi42118-affected.log, a real 4-attempt series carrying 4 derivation
// headers and ZERO verdict/attribution markers, including from an attempt whose
// test:lane-stateful task had genuinely exited 1 (per-task output is captured and
// replayed at the end, per the block below, so it never leaked a FAIL row either).
// Add the trap and a preempted attempt starts writing terminal markers into a stream
// that is NOT deduplicated. Fixing that would mean isolating stderr too, or moving the
// failure contracts onto stdout — not just adding the handler.
//
// What DOES work is below and above: `exit` covers every in-process way out (an
// uncaught exception, an unhandled rejection, an early exit that emits no verdict),
// and for a signal — where by construction nothing of ours can run — the BEGIN line's
// pid is the handle, so `kill -0 <pid>` settles "dead or still running" straight from
// the log. Generalizing to the other long-running scripts the filer named
// (green-checkpoint, deploy-cli): a signal trap is only a real option for a runner
// whose main loop is genuinely async, and it must still be paired with a SIGKILL
// escalation upstream. Check the loop before reaching for the trap.
// ── Transient pgbouncer errors are BOOKKEEPING failures, never a verdict ────────
// Measured 2026-09-05 22:30Z (papercusp gate run judging 92e07dd5, log
// 2026-09-05T22-30-02-970Z-base-50ed2739ec71-cand-92e07dd56fa1.log): at lane-pure
// 2406s, with 5 task exits already OBSERVED, the runner died on
//   PostgresError: query_wait_timeout  (severity FATAL, SQLSTATE 08P01)
// delivered from postgres.js's socket `data` handler as an UNHANDLED REJECTION
// (`triggerUncaughtException(err, true /* fromPromise */)`) with no application frame
// at all — the pooler gave up waiting for a server slot on a connection the governed
// admission client (scripts/lib/governed-test-process.mjs → process-wide getOrgPg())
// holds, so the rejection belonged to nobody's `await`. Node's default disposition
// turned that into a crash: `AFFECTED_TESTS_RESULT status=aborted
// reason=exit-without-verdict code=1`, a 60-minute suite lost, no failing-file list.
// WI-1048027 layer 2 (observedNonzeroExits above) already documents the SAME arrival
// path (an async postgres.js `Immediate` callback under CONNECTION_CLOSED).
//
// The admission/ledger writes are bookkeeping; the VERDICT is this script's job. So
// swallow ONLY the transient-pg shapes (log + count + continue) and re-throw everything
// else synchronously, which hands it back to the default uncaught-exception path with
// its stack intact — registering this listener must not widen what the runner survives.
// Mirrors `isRetriablePgReadError` in packages/operator-core/lib/operator-state-pg.ts
// (the orchestrator-side half of the same 2026-09-05 fix); kept local because this
// script deliberately imports nothing from operator-core.
let observedTransientPgErrors = 0;
function isTransientPgError(e) {
  const x = e && typeof e === "object" ? e : null;
  const code = x && typeof x.code === "string" ? x.code : "";
  const msg = x && typeof x.message === "string" ? x.message : String(e ?? "");
  return (
    code === "CONNECT_TIMEOUT" ||
    code === "CONNECTION_CLOSED" ||
    code === "08P01" ||
    /\bCONNECT_TIMEOUT\b/.test(msg) ||
    /\bCONNECTION_CLOSED\b/.test(msg) ||
    /\bquery_wait_timeout\b/.test(msg)
  );
}
process.on("unhandledRejection", (reason) => {
  if (!isTransientPgError(reason)) throw reason;
  observedTransientPgErrors += 1;
  const msg = reason && typeof reason === "object" && "message" in reason ? reason.message : String(reason);
  // errSync, never process.stderr.write: every runner-emitted line goes through the synchronous
  // fd helper so it stays ordered with child output AND lands in the run's own log
  // (affected-tests-stdout-ordering.test.ts detects a raw write on the AST).
  errSync(
    `[affected-tests] non-fatal transient pg error (unhandled rejection #${observedTransientPgErrors}, ` +
      `bookkeeping only — the run continues): ${String(msg).split("\n")[0]}`,
  );
});
process.on("exit", (code) => {
  cleanupPreemptReadyMarker();
  cleanupPreemptFinalizationMarker();
  cleanupForwardedFilesResponses();
  // Catches every remaining way out with no verdict: an uncaught exception, an
  // unhandled rejection, or an early process.exit() on a path that emits nothing
  // (e.g. the unrecognized-flag refusal). A clean path has already set the flag.
  emitAbortMarker(`reason=exit-without-verdict code=${code}`);
});
// The budgeted scheduler runs task children concurrently, so their byte streams cannot be
// inherited without interleaving one task under another task's header. Capture every task and
// replay it in declaration order after the initial pool drains. This also leaves every retry,
// summary cross-check, failure attributor, and the full run log on the same evidence path.
const captureOutput = () => true;

// ── Shared-host worker cap (WI-3792 follow-up, 2026-07-10) ──────────────────
// Vitest defaults each suite's fork pool to EVERY core. On the shared 128-core
// dev box that means ONE full-suite run spawns ~128 workers — and the gate,
// peers' runs, and agent sessions routinely overlap, so 2-3 concurrent suites
// put 300+ runnable tasks on the host (loadavg 1000-3000; twice this week the
// box melted: /tmp/pcv day + the ORT spin-pool day, both amplified by exactly
// this). Cap workers per suite at min(32, max(8, cores/4)) unless the caller
// already chose a cap. Wall-clock per suite gets slower; the HOST stays alive.
// VITEST_MAX_WORKERS is the vitest-4 name (verified: the only worker-cap env
// in vitest 4.1.8's dist); MAX_THREADS/MAX_FORKS kept as belts for any tree
// still on vitest ≤3.
//
// WI-5621 (2026-07-20): the static cap above only protects against ONE run's
// own worker count — it says nothing about how many OTHER concurrent
// test:affected/test:file invocations (this fleet routinely runs dozens) are
// already piling onto the same box. `applyWorkerCapEnv` adds an adaptive
// shrink term: when loadavg is already above the core count (the host is
// oversubscribed before this run even starts), the cap shrinks proportionally
// instead of unconditionally grabbing up to 32 more workers. See
// scripts/lib/worker-cap.mjs for the full rationale + the (unit-tested) pure
// function this wraps.
const WORKER_CAP = applyWorkerCapEnv({
  cores: availableParallelism(),
  load1: loadavg()[0],
});
// WI-10002092: the cgroup envelope is read HERE, before the memory token is sized, because the
// token's credibility test needs it. EI-20801764054303492's read-once rule is unchanged — this is
// still the single read, and the budget below plus the operator-visible marker consume THIS value.
const TASK_CGROUP_MEMORY_MAX_MB = readTaskCgroupMemoryMaxMb();
const SCHEDULER_WORKER_MEMORY_MB = resolveWorkerMemoryMb({
  affectedWorkerMemoryMb: process.env.AFFECTED_WORKER_MEMORY_MB,
  nodeOptions: process.env.NODE_OPTIONS,
  fallback: 1024,
  // WI-10002092 (recurrence of EI-23242580927683488): agent shells carry an ambient
  // `--max-old-space-size=131072`, which is a heap CEILING and not a 128 GiB-per-worker demand.
  // Without this envelope the pre-launch refusal fired for EVERY agent running test:affected from
  // its own ~6 GiB task cgroup, and zero tasks ran.
  taskCgroupMemoryMaxMb: TASK_CGROUP_MEMORY_MAX_MB,
  onNotice: (line) => errSync(line),
});
// The green checkpoint currently pins VITEST_MAX_FORKS/THREADS=2 but not
// VITEST_MAX_WORKERS. `applyWorkerCapEnv` fills the missing modern spelling from host load, which
// can be much larger. Collapse ALL spellings after that fill and take the minimum so the gate's
// pre-existing two-fork safety rail remains the global scheduler ceiling.
const SCHEDULER_WORKER_BUDGET = resolveGlobalWorkerBudget({
  affectedWorkerBudget: process.env.AFFECTED_GLOBAL_WORKER_BUDGET,
  vitestMaxWorkers: process.env.VITEST_MAX_WORKERS,
  vitestMaxForks: process.env.VITEST_MAX_FORKS,
  vitestMaxThreads: process.env.VITEST_MAX_THREADS,
  fallback: WORKER_CAP,
});
// WI-39472: MemAvailable is the kernel's own estimate of what a new allocation can actually get
// WITHOUT swapping — it counts reclaimable page cache, which MemFree and the node os free-memory
// reading do not (that API is deliberately NOT named here as a literal: a repo guard forbids the
// call, and a guard matching on a bare substring is tripped by the prose explaining it). On a
// long-lived box those two read catastrophically low and would throttle the scheduler to one
// worker for no reason. Returns null (not 0) when the reading is unavailable, so the caller can
// tell "no measurement" apart from "no memory".
function readMemAvailableMb() {
  try {
    const line = readFileSync("/proc/meminfo", "utf8").match(
      /^MemAvailable:\s+(\d+)\s+kB$/m,
    );
    return line ? Math.floor(Number(line[1]) / 1024) : null;
  } catch {
    return null; // non-Linux, or /proc not mounted — fall back to the ceiling.
  }
}
// WI-41206 / remove-memory-derived-work-refusals-2026-08-24: the host reading below is now pure
// TELEMETRY. It is still taken, still logged, and still surfaced in the operator-visible marker,
// but `resolveMemoryBudgetMb` no longer lets it narrow the admitted budget — concurrency here is
// worker/CPU-derived only. A host driven into paging slows itself through real contention rather
// than through a startup snapshot pre-emptively shrinking the lane.
//
// (Historical, WI-39472: this default USED to be `SCHEDULER_WORKER_BUDGET *
// SCHEDULER_WORKER_MEMORY_MB`, making `memoryWorkerBudget` identically equal to `workerBudget` so
// the Math.min could never bind. That inertness was then treated as a bug and the clamp was armed
// — which is what WI-41206 has now deliberately reversed. Do not "re-arm" it a second time
// without re-reading that plan; the inert behaviour is the INTENDED one.)
// EI-20801764054303492: read the host ONCE and keep the value, so the budget and the
// operator-visible marker report the SAME measurement. Two separate readFileSync calls would
// drift between them on a busy box, which makes the log unreadable exactly when it matters.
const MEM_AVAILABLE_MB = readMemAvailableMb();
// TASK_CGROUP_MEMORY_MAX_MB is read above, beside SCHEDULER_WORKER_MEMORY_MB — the memory token
// cannot be sized without it (WI-10002092). It is still read exactly once.
const TASK_CGROUP_PIDS_MAX = readTaskCgroupPidsMax();
// EI-21540797943980235: pids.max cannot be translated into a reliable worker cap because the
// controller counts threads and suites may spawn an unpredictable number of node/git/npm
// children. The cumulative refusal counter is the authoritative post-hoc detector: if it moves
// during a red run, the apparent failures are not a valid verdict. A green run remains valid —
// a child that failed to fork cannot manufacture a passing assertion.
const TASK_CGROUP_PIDS_EVENTS_MAX_START = readTaskCgroupPidsEventMax();
// EI-21472375431146082: a pre-launch TASK_BUDGET_REFUSAL (pids/memory ceiling below one
// task envelope — e.g. a confined cgroup with pids.max=0) used to escape
// as a raw throw, and the exit-handler fallback stamped it with the GENERIC
// `status=aborted reason=exit-without-verdict` — indistinguishable from any crash, and
// with tasks=0 failed=0 easy to skim as "nothing broke" when it means NOT MEASURED:
// zero tasks were launched and there is NO verdict. Classify it loudly instead.
function refuseOnTaskBudget(error) {
  const message = String(error?.message ?? error);
  if (!message.includes("TASK_BUDGET_REFUSAL")) return false;
  terminalEmitted = true; // suppress the exit-handler's generic abort duplicate
  errSync(
    `AFFECTED_TESTS_RESULT status=refused tasks=0 failed=n/a ` +
      `quarantinedFailed=0 timedOutTasks=0 undeterminedTasks=0 ` +
      `reason=TASK_BUDGET_REFUSAL ${message}`,
  );
  errSync(
    "NOT MEASURED — zero test tasks were launched; this run produced NO verdict and " +
      "must not be read as green. Re-run outside the constrained cgroup or raise its " +
      "ceiling (see the remedy in the refusal above).",
  );
  // Exit 78 (sysexits EX_CONFIG): refused by an environment ceiling, deliberately
  // distinct from the generic abort's exit 1 so tooling can classify without parsing.
  process.exit(78);
}
const SCHEDULER_CONFIG = (() => {
  try {
    return resolveTaskBudget({
      workerBudget: SCHEDULER_WORKER_BUDGET,
      memoryBudgetMb: resolveMemoryBudgetMb({
        affectedGlobalMemoryMb: process.env.AFFECTED_GLOBAL_MEMORY_MB,
        memAvailableMb: MEM_AVAILABLE_MB,
        taskCgroupMemoryMaxMb: TASK_CGROUP_MEMORY_MAX_MB,
        workerBudget: SCHEDULER_WORKER_BUDGET,
        workerMemoryMb: SCHEDULER_WORKER_MEMORY_MB,
      }),
      workerMemoryMb: SCHEDULER_WORKER_MEMORY_MB,
      maxConcurrentTasks: process.env.AFFECTED_MAX_CONCURRENT_TASKS ?? 2,
      reserveWorkers: 1,
      taskCgroupPidsMax: TASK_CGROUP_PIDS_MAX,
    });
  } catch (error) {
    // EI-21472375431146082: emit the loud refused verdict + exit 78 for a genuine
    // pre-launch budget refusal; rethrow anything else unchanged.
    refuseOnTaskBudget(error);
    throw error;
  }
})();
// WI-1669424: the sibling of WI-1492652, same class, same file. This default was `tmpdir()`,
// which resolves under /tmp/pcv here — a tree swept BOTH at boot (/etc/tmpfiles.d/tmp.conf
// sets `D /tmp 1777 root root 7d`, and capital D + `--remove` empties it) and mid-session.
// Losing this file is silent: readDurationHistory() treats a missing path as "first run, no
// history yet", so the scheduler just runs on cold estimates until it re-learns them.
//
// ⚠ ONLY THE DIRECTORY MOVES — same rule as the verdict cache below. The filename carries the
// history IDENTITY (the `v1` version constant, which readDurationHistory checks), so a
// relocation must not touch it. Note this store is deliberately NOT ROOT-scoped the way the
// verdict cache is: it was global under tmpdir(), and adding a scope here would be an identity
// change smuggled into a durability fix. (It also could not work — ROOT is defined below.)
//
// writeDurationHistoryAtomic() mkdirs recursively and renames atomically, so a missing dir is
// not a concern.
const TASK_DURATION_HISTORY_PATH =
  process.env.AFFECTED_TASK_HISTORY_PATH ??
  join(
    homedir(),
    ".papercusp",
    "cache",
    "papercusp-affected-task-durations-v1.json",
  );

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Accept the conventional `--flag=value` spelling for value-taking flags before
// the small parser below examines argv. Keeping one canonical [flag, value]
// representation means equals-form callers get the same positional-argument
// safety checks and changed-path cardinality reporting as space-form callers.
const VALUE_FLAGS = new Set([
  "--base",
  "--range-from",
  "--range-to",
  "--changed-paths",
  "--exclude",
]);
const args = process.argv.slice(2).flatMap((token) => {
  const equals = token.indexOf("=");
  const flag = equals > 0 ? token.slice(0, equals) : token;
  return equals > 0 && VALUE_FLAGS.has(flag)
    ? [flag, token.slice(equals + 1)]
    : [token];
});
const arg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")
    ? args[i + 1]
    : d;
};
const has = (k) => args.includes(k);

// This CLI has no positional-argument mode. Walk the argv tokens while skipping
// values belonging to the flags that accept them, so a second path after
// `--changed-paths first/path` cannot be silently discarded and narrow the run.
const positionalArgs = [];
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token.startsWith("--")) {
    if (VALUE_FLAGS.has(token) && args[i + 1] && !args[i + 1].startsWith("--"))
      i += 1;
    continue;
  }
  positionalArgs.push(token);
}

// WI-42146 / green-main-fast-2026-08-25 P-047 — LOOP 1: RADIUS INFLATION.
//
// `origin/main` only fast-forwards on a GREEN checkpoint, so using it as the diff
// base couples the SIZE of every run to the AGE of the outage. The decisions, the
// measurements and the fail-safe reasoning live in `./lib/test-certified-base.mjs`
// so they are reachable by a test without a git fixture; see also plan decision
// green-main-fast-2026-08-25#D-029 for why the SELECTOR is not the thing to fix.

/** Read-only git, hardened: ANY failure yields null so the caller falls back. */
function gitTry(argv) {
  try {
    return execFileSync("git", argv, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const explicitBase = arg("--base", process.env.AFFECTED_BASE || null);
const explicitBaseSha = explicitBase
  ? gitTry(["rev-parse", "--verify", "--quiet", `${explicitBase}^{commit}`])
  : null;
const resolvedBase = explicitBase
  ? {
      base: explicitBaseSha ?? explicitBase,
      source: "explicit",
      sha: explicitBaseSha,
      reason: explicitBaseSha ? "explicit-resolved" : "explicit-unresolved",
    }
  : resolveTestCertifiedBase({ git: gitTry, env: process.env });
// Say so out loud: a run whose radius came from somewhere other than the documented
// default must never be a silent difference when someone reads the log later.
if (resolvedBase.source === "watermark") {
  // Must be errSync, not process.stderr.write: every runner-emitted line goes through the
  // synchronous fd helpers so it stays ORDERED against inherit-mode child output (EI-10542,
  // pinned by affected-tests-stdout-ordering.test.ts). An async write can interleave into the
  // middle of a child's block and be misattributed to it. errSync also routes through logLine,
  // so this derivation line lands in the run's own log — process.stderr.write skipped it, which
  // meant the one line explaining where a run's radius came from was missing from the artifact
  // a later reader actually opens.
  errSync(baseSourceLine(resolvedBase));
}
const base = resolvedBase.base;
const runIntegration = has("--integration");
const runAll = has("--all");
// EI-19463337855465369: `--dry-run` is the more common CLI convention (npm,
// git, rsync, kubectl all use it) and this repo's own agent guidance points
// people at previewing before a heavy run — so it's the spelling an agent
// reaches for. Accept it as an alias rather than relying solely on the
// unknown-flag refusal below to catch it.
const dry = has("--dry") || has("--dry-run");
// P-016 (release-pipeline-resilience-2026-06-09 D-010): range + print-only mode for the
// green-checkpoint's longest-green-PREFIX salvage. With --range-from/--range-to, the
// changed-file set is the two-dot diff of that commit range (NOT the working tree), and
// --print-affected emits one `AFFECTED_WS\t<name>` line per affected workspace, one
// `AFFECTED_WS_CMD\t<workspace>\t<command>` line per selected task, plus one
// `AFFECTED_GUARD\t<workspace>\t<script>\t<command>` line per attached repo-wide guard, then exits
// WITHOUT running any tests — a cheap git+graph affected-set probe per candidate prefix.
const rangeFrom = arg("--range-from", null);
const rangeTo = arg("--range-to", null);
// A repo-wide guard that derives its subject from git must use the same base as this
// runner's authoritative changed-path derivation. In prefix mode, the two-dot range
// is the source of truth, so the guard's one-sided diff starts at rangeFrom. Resolve
// the forwarded ref once: a moving branch name is not a stable input to a cached proof.
const repoWideGuardBaseRef = rangeFrom && rangeTo ? rangeFrom : base;
const repoWideGuardBaseSha = repoWideGuardBaseRef
  ? gitTry([
      "rev-parse",
      "--verify",
      "--quiet",
      `${repoWideGuardBaseRef}^{commit}`,
    ])
  : null;
const repoWideGuardBase = repoWideGuardBaseSha ?? repoWideGuardBaseRef;
// --changed-paths a,b,c — compute the affected set from these paths instead of a
// git diff. See affectedWorkspaces() for why a git-based probe cannot answer
// "what would touching X select?" on this tree.
//
// Callers commonly receive a basename from a file-level test runner (for example,
// `request-kernel.ts`) rather than the repo-relative path the workspace graph and
// repo-wide guards require. Passing that basename through used to select ZERO
// workspaces and then forward an unresolvable `--files=request-kernel.ts` to both
// strand guards. Expand an explicit path against the complete present tree before
// using it for either purpose. A unique suffix match is the normal case; ambiguous
// matches are conservatively expanded so the probe cannot silently under-select.
//
// LAZY ON PURPOSE — do not collapse this back to an eagerly-evaluated IIFE.
// Building the corpus costs a measured 387ms: `listFilesIncludingUntracked` spawns
// git once for the superproject and once per declared submodule (39 spawns here) to
// enumerate 33,307 paths. That was ~49% of the CLI's entire 790ms startup, and it was
// paid on EVERY invocation — including the two cases that never read it:
//   • a git-diff run (no --changed-paths at all), where `changedPathsOverride` short-
//     circuits to null and normalizeExplicitChangedPath is never called; and
//   • the common explicit-path case, where `existsSync` below succeeds and the `||`
//     short-circuits before the corpus is ever touched.
// Only an unresolvable path (the basename-expansion case this corpus exists for) now
// pays for it, once. Measured 2026-08-31 on the repo-wide-invariant-guards suite, whose
// 71 `--dry` probes are almost pure CLI startup: 73.3s -> 41.5s (-43.3%), 105 tests and
// 0 non-passing on both sides. Single invocation with a resolvable path: 0.79s -> 0.34s.
// Equivalence was checked by diffing full CLI output across 10 probe shapes (explicit
// path, basename, submodule gitlink, multi-path, nonexistent, --print-affected): all
// identical once the pid-stamped log path and ambient memAvailableMb — both of which
// differ between two runs of the SAME binary — are normalized.
let explicitPathCorpusCache = null;
function explicitPathCorpus() {
  if (explicitPathCorpusCache !== null) return explicitPathCorpusCache;
  try {
    explicitPathCorpusCache = listFilesIncludingUntracked(ROOT).files;
  } catch {
    explicitPathCorpusCache = [];
  }
  return explicitPathCorpusCache;
}

function normalizeExplicitChangedPath(raw) {
  let path = String(raw ?? "").trim().replaceAll("\\", "/");
  if (!path) return [];

  if (isAbsolute(path)) {
    const repoRelative = relative(ROOT, resolve(path)).replaceAll("\\", "/");
    if (repoRelative && repoRelative !== "." && !repoRelative.startsWith("../") && repoRelative !== "..") {
      path = repoRelative;
    }
  } else {
    path = path.replace(/^\.\/+/, "");
  }

  // Preserve an explicitly named file/directory even when it is ignored and therefore
  // absent from the git-backed corpus. This also preserves submodule gitlink roots,
  // which are directories rather than file entries in the corpus.
  if (existsSync(resolve(ROOT, path)) || explicitPathCorpus().includes(path)) return [path];

  const matches = explicitPathCorpus().filter(
    (candidate) => candidate === path || candidate.endsWith(`/${path}`),
  );
  // A basename such as `index.ts` can legitimately have many owners. Expanding every
  // match widens the run, which is the only honest result when the caller omitted the
  // directory; retaining just one would make the affected set falsely narrow.
  return matches.length ? matches : [path];
}

const changedPathsOverride = (() => {
  const raw = arg("--changed-paths", null);
  if (raw == null) return null;
  const requested = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return [...new Set(requested.flatMap(normalizeExplicitChangedPath))];
})();
const printAffected = has("--print-affected");

// ── P-009 part (a): the `--coverage` passthrough ───────────────────────────────
//
// Plan design-to-code-coverage-seam-2026-09-02, decision D-028. Until this landed,
// NOTHING automated ever passed `--coverage`: the shared Vitest provider block in
// libs/test-config/src/vitest-config.ts was complete and functional but INERT, and
// this runner hard-rejected the flag, so the nightly's `--all --integration` step
// could not be fixed by appending it. That is why P-009's stated premise ("fed by
// the lcov P-007 emits") was false, and why the item is three parts — (a) here,
// (b) scripts/merge-coverage.ts, (c) scripts/patch-coverage.ts.
//
// FORWARDED ONLY TO TASKS THAT ACTUALLY RUN VITEST. A workspace script that is a
// composite shell line (`npm run a && npm run b`, how standalone packages aggregate
// their suites) gets `-- --coverage` appended to the LAST sub-command only — neither
// what the caller asked for nor visible in the exit code. Requiring the script text
// to invoke vitest directly excludes those, and excludes every non-vitest lint guard,
// rather than producing a partial report nobody can tell is partial. What was and was
// not instrumented is REPORTED (see the COVERAGE_PASSTHROUGH line below), because a
// silently partial lcov is what makes the downstream patch gate vacuous.
const coverageRequested = has("--coverage");

/** Does this workspace script invoke vitest directly (not via a composite line)? */
function scriptRunsVitestDirectly(scriptText) {
  return /(^|[\s;&|])vitest(\s|$)/.test(scriptText ?? "");
}

/** The coverage args to append for ONE task — empty unless `--coverage` applies. */
function coverageArgsFor(t) {
  if (!coverageRequested) return [];
  if (t.isInvariantGuard) return [];
  return scriptRunsVitestDirectly(t.ws.scripts?.[t.script]) ? ["--coverage"] : [];
}

// --related — narrow each affected workspace's run to the TEST FILES that could
// actually be reached by the changed files, instead of running its whole suite.
// See scripts/lib/related-tests.mjs for the measured narrowing (median ~5.4x in
// operator-core) and for why every rail widens back to the full suite on doubt.
//
// This remains opt-in relative to the historical `test:affected` command. The
// green-checkpoint deliberately invokes `npm run test:related`: unresolved graph
// edges, cross-package-only changes, and unsafe lane shapes widen back to a full
// workspace suite, while lint:required-field-strands, lint:tsc, repo-wide guards,
// migrations, and builds remain outside this narrowing.
const relatedOnly = has("--related");
const runElSuite = has("--el-suite");
const excludeArg = arg("--exclude", "");
const excludes = new Set(excludeArg.split(",").filter(Boolean));

// EI-19463337855465369: an argv token starting with `--` that none of the
// arg()/has() calls above consumed used to be silently DISCARDED — has()/
// arg() only ever ask "is this flag present"; neither one complains about a
// flag they don't recognize. A typo (or the `--dry-run` convention above,
// before the alias was added) matched nothing, and the script fell straight
// through to its DEFAULT action — which, unlike most CLIs' cheap default, is
// one of the heaviest jobs on this box: actually running the affected test
// suites. This is the same zero-or-unbounded-work-reported-as-clean family
// this repo already guards against elsewhere (a `tsc -p .` that typechecks
// zero files and reads clean; a `test:file -t <pattern>` that matches zero
// tests and reports `status=passed`) — here inverted: instead of silently
// doing LESS than asked, it silently did FAR MORE, with no "unknown flag"
// line to notice before the multi-minute run was already underway. Refuse
// instead of guessing.
const KNOWN_FLAGS = [
  "--base",
  "--integration",
  "--all",
  "--dry",
  "--dry-run",
  "--range-from",
  "--range-to",
  "--changed-paths",
  "--print-affected",
  "--related",
  "--el-suite",
  "--exclude",
  // P-009 (design-to-code-coverage-seam-2026-09-02) part (a): the Vitest coverage
  // passthrough. It is EXTENDED here rather than bypassing the unknown-flag refusal
  // below, because that refusal is the reason the flag could not simply be appended
  // to the nightly's `--all --integration` step — see coverageArgsFor() for what it
  // forwards and, deliberately, what it does not.
  "--coverage",
];
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array(b.length).fill(0),
  ]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}
function closestKnownFlag(flag) {
  let best = null;
  let bestDist = Infinity;
  for (const known of KNOWN_FLAGS) {
    const d = editDistance(flag, known);
    if (d < bestDist) {
      bestDist = d;
      best = known;
    }
  }
  // Only suggest something plausibly a typo of — a wild guess is worse than none.
  return bestDist <= 4 ? best : null;
}
function exactFileCommand(paths) {
  const rendered = paths.length > 0 ? paths.join(" ") : "<path/to/test-file>";
  return `npm run test:file -- ${rendered}`;
}
function printExactFileRecovery(paths) {
  errSync(
    "Root `npm test` runs affected workspaces; it does not forward Vitest flags or accept exact test-file operands.",
  );
  errSync(`For exact files use: ${exactFileCommand(paths)}`);
  errSync(
    'Put any additional Vitest arguments after a second `--` (for example: npm run test:file -- path/to/a.test.ts -- -t "case name").',
  );
}
const unknownFlags = args.filter(
  (a) => a.startsWith("--") && !KNOWN_FLAGS.includes(a),
);
if (unknownFlags.length > 0) {
  errSync(
    `affected-tests.mjs: unrecognized flag(s): ${unknownFlags.join(", ")}`,
  );
  for (const flag of unknownFlags) {
    // `--run <files>` is the conventional shape callers reach for when they
    // mistake this affected-workspace runner for Vitest. Edit-distance used to
    // suggest `--all`, which is valid but means the opposite (run MORE work).
    // Route that recognizable intent to the repository's existing exact-file
    // router instead of offering a syntactically-near, semantically-wrong flag.
    if (flag === "--run") continue;
    const suggestion = closestKnownFlag(flag);
    if (suggestion) errSync(`  did you mean ${suggestion}?`);
  }
  if (unknownFlags.includes("--run")) {
    errSync("");
    printExactFileRecovery(positionalArgs);
  }
  errSync("");
  errSync(`Known flags: ${KNOWN_FLAGS.join(" ")}`);
  errSync(
    "(see the usage comment at the top of scripts/affected-tests.mjs for what each does)",
  );
  errSync(
    "Refusing to run rather than silently ignoring the flag and running the full default job.",
  );
  process.exit(1);
}

if (positionalArgs.length > 0) {
  errSync(
    `affected-tests.mjs: unexpected positional argument(s): ${positionalArgs.join(", ")}`,
  );
  const allLookLikeTests = positionalArgs.every((value) =>
    /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(value),
  );
  if (allLookLikeTests) printExactFileRecovery(positionalArgs);
  else
    errSync(
      "This command accepts flags only; pass --changed-paths as one comma-delimited value (for example, --changed-paths path/to/a.ts,path/to/b.ts or --changed-paths=path/to/a.ts,path/to/b.ts) rather than separate positional paths.",
    );
  process.exit(1);
}

// Read quarantine.txt: BARE workspace-level entries (no `::`) get added to
// the whole-workspace quarantine set (logged as quarantined, not silently
// skipped). Per-file `ws::glob` entries are informational only here — vitest
// doesn't have a per-file skip flag from outside, and the PRECISE per-file
// quarantine match is green-checkpoint.ts's job (applyTestQuarantine), which
// only runs on a genuinely red exit code.
//
// WI-3371 (2026-07-09): this used to do `const [ws] = line.split('::'); if
// (ws) quarantined.add(ws)` — which added the WORKSPACE half of a per-file
// `ws::glob` entry too, so any operator-core failure (the biggest, most
// critical workspace, and the only one with per-file quarantine entries)
// silently stopped gating `npm run test:affected` entirely, contradicting
// this very comment. Fixed per explicit go-ahead from su-4d7a4628 (p2p lead)
// 2026-07-09 — expect NEW gating failures in the previously-masked
// hyperbee/p2p/substrate/federation suites; route fallout per area (hyperbee
// + federation → su-4d7a4628, hive-git → su-63834d42, coord-parity →
// su-4dc3b...), not "revert this fix".
const quarantineFile = join(ROOT, "quarantine.txt");
const quarantined = existsSync(quarantineFile)
  ? parseQuarantineWorkspaces(readFileSync(quarantineFile, "utf8"))
  : new Set();

// WI-3094: Node's execSync defaults maxBuffer to 1MB — comfortably exceeded by
// `git diff --name-only` output once `base` (origin/main) has drifted far enough
// behind HEAD (a live monorepo case: main only fast-forwards on a green
// checkpoint, so it can sit hundreds of commits behind staging for hours under
// fleet load). Observed live: a 460-commit-behind origin/main produced a 5.2MB
// `--name-only` diff, which overflowed the 1MB default and threw `spawnSync
// /bin/sh ENOBUFS` — caught by affectedWorkspaces()'s try/catch (which prints the
// loud EI-1989 banner) but still silently degrading every run to `--all` (every
// workspace), the exact slow-and-masked failure mode that banner exists to call
// out, not fix. 256MB (matching the vitest spawnSync maxBuffer just below) is
// ample headroom — even a full-repo `--name-only` diff is only a few MB — so the
// fast, correct affected-set path succeeds instead of falling back.
function sh(cmd) {
  return execSync(cmd, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

// EI-21082496866331715: the shared tree can move while a long suite is running. Capture the
// candidate ref before any child starts so a report can distinguish a file that was judged at the
// old ref from one that is still the same blob at report time. Git reads are fail-soft: inability
// to resolve a ref or blob is an attribution gap, not permission to call a failure stale.
function gitOutput(args) {
  try {
    return (
      execFileSync("git", args, {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

const RUN_START_HEAD = gitOutput(["rev-parse", "HEAD"]);

// Collect every file changed vs `base` — committed (base...HEAD), uncommitted
// (working tree vs HEAD), and untracked.
//
// `--ignore-submodules=dirty` (NOT `=all`) is load-bearing in both directions:
//
//  - it still tolerates the broken/retired submodules that forced `=all` here
//    originally: the shared staging checkout carries retired submodules (e.g.
//    libs/papercusp-db, libs/zero-harness) whose `.git` ref points at a missing
//    `.git/modules/...` gitdir, which aborts the diff with `fatal: not a git
//    repository: libs/papercusp-db/../../.git/modules/libs/papercusp-db`. That
//    fatal comes from git ENTERING the submodule to check whether its work tree
//    is dirty — exactly the step `dirty` skips. Before this was handled, the
//    failure was swallowed and the whole run silently degraded to `--all` (every
//    workspace) — slow, noisy, and it masked the real cause (EI-1989).
//
//  - but unlike `=all` it does NOT suppress GITLINK changes, i.e. "this
//    submodule now points at a new commit". A submodule's files never appear as
//    superproject paths (they live in another repo); the gitlink is the ONLY way
//    its changes can surface here. Under `=all`, a commit touching only
//    libs/generic/memory produced an EMPTY changed-file set, so the affected set
//    was empty, so ZERO tests ran and the gate went green having verified
//    nothing — for ~25 submodules, including the memory lib's 286 tests.
//
// Uncommitted work INSIDE a live submodule is what `dirty` drops, so probe for
// it separately (submoduleDirtyPaths) — that keeps the local pre-commit loop
// honest without reintroducing the fatal.
// `git ls-files --others` does not recurse into submodules, so it needs no such
// flag. Throws on a genuine git error so the caller can decide to warn or bail.
// EI-20812741760514969: the per-leg counts behind the derived set, recorded as it is
// computed and reported by the AFFECTED_DERIVATION marker below. Four legs go into one
// deduped list, and which one dominates is the whole diagnostic: a radius driven by
// `committed` means `base` has drifted (origin/main only fast-forwards on a green
// checkpoint, so it sits hundreds of commits behind under fleet load), while one driven by
// `uncommitted`/`untracked` really is the shared tree's in-flight work. Collapsed to a
// single total, the two are indistinguishable — and the filed report guessed wrong.
let changedPathLegs = null;
// The DEDUPED size of the derived set — recorded rather than recomputed, so the marker
// reports the list the run actually used and cannot drift from it as the legs are unioned.
let changedPathTotal = null;
// Set when the git derivation FAILED and the run degraded to every workspace. The marker
// reports that as its own source rather than as a legitimate `--all`: "we ran everything
// because you asked" and "we ran everything because we could not tell what changed" are
// different runs, and only the second is a bug (EI-1989's failure mode, in the log this time).
let derivationDegraded = false;
function changedFiles() {
  if (rangeFrom && rangeTo) {
    // P-016: two-dot range — files changed BY the commits in (rangeFrom, rangeTo]. No
    // working-tree / untracked component: we're probing a historical commit prefix for
    // the green-checkpoint salvage, not diffing the live tree.
    const inRange = sh(
      `git diff --name-only --ignore-submodules=dirty ${rangeFrom}..${rangeTo}`,
    )
      .split("\n")
      .filter(Boolean);
    changedPathTotal = inRange.length;
    return inRange;
  }
  const committed = sh(
    `git diff --name-only --ignore-submodules=dirty ${base}...HEAD`,
  )
    .split("\n")
    .filter(Boolean);
  const uncommitted = sh("git diff --name-only --ignore-submodules=dirty HEAD")
    .split("\n")
    .filter(Boolean);
  const untracked = sh("git ls-files --others --exclude-standard")
    .split("\n")
    .filter(Boolean);
  const submoduleDirty = submoduleDirtyPaths();
  changedPathLegs = {
    committed: committed.length,
    uncommitted: uncommitted.length,
    untracked: untracked.length,
    submoduleDirty: submoduleDirty.length,
  };
  const deduped = [
    ...new Set([...committed, ...uncommitted, ...untracked, ...submoduleDirty]),
  ];
  changedPathTotal = deduped.length;
  return deduped;
}

// The changed-path list REPO_WIDE_INVARIANT_GUARDS matches against, memoized so
// enabling a guard never re-shells the four git commands changedFiles() runs.
// Honours --changed-paths for the same reason affectedWorkspaces() does: it is
// the only way to test a selection rule hermetically on this tree, where
// git-sync sweeps everything and no real commit is ever scoped to your paths.
// Fails OPEN (empty list => no guard added): a guard is a safety net, and a net
// that converts a git hiccup into a hard failure of everyone's test loop is a
// worse trade than one that occasionally does not fire.
let invariantGuardChangedPathsCache = null;
function invariantGuardChangedPaths() {
  if (invariantGuardChangedPathsCache) return invariantGuardChangedPathsCache;
  if (changedPathsOverride)
    return (invariantGuardChangedPathsCache = changedPathsOverride);
  if (runAll) return (invariantGuardChangedPathsCache = []); // --all already runs every suite
  try {
    invariantGuardChangedPathsCache = changedFiles();
  } catch {
    invariantGuardChangedPathsCache = [];
  }
  return invariantGuardChangedPathsCache;
}

const AUTHORED_DOCS_ROOT = "apps/operator-docs/src/content/docs";
// WI-1399902 — the served-docs mirror guard's three subjects. DELIBERATELY NOT reusing
// AUTHORED_DOCS_ROOT above even though the source path is byte-identical today: that constant
// is scoped to the PG-canonical authored-doc corpus, and narrowing it to that projector's
// subset (a plausible future edit) would silently narrow THIS guard too — in the
// false-negative direction, which is the one nobody notices. Same tree, different owners.
const DOCS_MIRROR_SOURCE_ROOT = "apps/operator-docs/src/content/docs";
const DOCS_MIRROR_SERVED_ROOT = "apps/operator/public/internal/docs";
const DOCS_MIRROR_DETECTOR = "scripts/check-docs-mirror.mjs";
const AUTHORED_DOC_GUARD_SCRIPT = "gen:authored-docs:check";
const AUTHORED_DOC_PROJECTOR = "scripts/project-authored-docs.ts";
const AUTHORED_DOCS_CONFIG = ".papercusp/docs.json";
// Keep this mirror explicit, like scripts/project-authored-docs.ts: the files are owned by
// gen:doc-projections, so passing them to the PG-backed authored-doc check would make one
// generator's output look like a hand-edited authored document.
const GENERATOR_OWNED_AUTHORED_DOCS = new Set([
  "reference/agent-insights-index.md",
  "reference/blueprint-catalog.md",
  "reference/plans-index.md",
  "reference/role-registry.md",
  "reference/tool-catalog.md",
]);

/**
 * Narrow the authored-doc drift check to the candidate docs that exist on disk.
 *
 * A projector/config change can alter the whole corpus, so it deliberately returns no args and
 * leaves the check in full-corpus mode. A changed generated doc is likewise not an authored-doc
 * candidate; when it is the only matching path, returning [] preserves the full-corpus check.
 */
function authoredDocGuardArgs() {
  const changed = invariantGuardChangedPaths();
  if (
    changed.includes(AUTHORED_DOC_PROJECTOR) ||
    changed.includes(AUTHORED_DOCS_CONFIG)
  )
    return [];

  const docsPrefix = `${AUTHORED_DOCS_ROOT}/`;
  const docIds = [
    ...new Set(
      changed
        .filter((file) => file.startsWith(docsPrefix) && /\.mdx?$/.test(file))
        .map((file) => file.slice(docsPrefix.length))
        .filter(
          (docId) => !docId.startsWith("/") && !docId.split("/").includes(".."),
        )
        .filter((docId) => !GENERATOR_OWNED_AUTHORED_DOCS.has(docId))
        .filter((docId) => existsSync(join(ROOT, AUTHORED_DOCS_ROOT, docId))),
    ),
  ].sort();
  return docIds.length ? [`--files=${docIds.join(",")}`] : [];
}

function formatGuardArgs(args) {
  return args?.length ? ` (guard args: ${args.join(" ")})` : "";
}

/**
 * Quote one shell argument for the machine-readable --print-affected command field.
 * Keep the common npm/workspace/script spellings readable; quote forwarded paths and
 * other unusual values so copying the command cannot change its argument boundaries.
 */
function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text)
    ? text
    : `'${text.replace(/'/g, "'\"'\"'")}'`;
}

/**
 * The fourth AFFECTED_GUARD field is the exact workspace-aware invocation a consumer
 * can run. The first three fields remain unchanged for older parsers; the command is
 * additive and carries every forwarded guard argument (including --base/--files).
 */
function formatGuardCommand(guard) {
  const forwardedArgs = [
    ...(guard.guardArgs ?? []),
    ...(guard.guardBase ? ["--base", guard.guardBase] : []),
  ];
  const argv = [
    "npm",
    "run",
    "--silent",
    "--workspace",
    guard.workspace,
    guard.script,
    ...(forwardedArgs.length ? ["--", ...forwardedArgs] : []),
  ];
  return argv.map(shellQuote).join(" ");
}

/**
 * The exact runnable invocation for ONE workspace task — the AFFECTED_WS_CMD field.
 *
 * This MIRRORS spawnSpecFor()'s npm branch and must keep mirroring it: a STANDALONE
 * package (STANDALONE_PACKAGE_DIRS) is not an npm workspace, so `--workspace` does not
 * resolve for it — npm fails with "No workspaces found" and exits 1. Measured
 * 2026-09-02 (EI-22152426246970496):
 *
 *   npm run --workspace @papercusp/desktop test   -> npm error No workspaces found (exit 1)
 *   npm --prefix papercusp-desktop run test       -> runs the real suite  (exit 0)
 *
 * That matters because the exit-1 form measures ZERO tests while looking exactly like a
 * failing suite — the same false-red class this runner exists to prevent.
 *
 * Emitted as its own line kind rather than a fourth AFFECTED_WS field ON PURPOSE:
 * green-checkpoint.ts parses `AFFECTED_WS\t` with `.slice(...).trim()` into a Set of
 * workspace NAMES for its targeted re-verdict, so widening that line would silently
 * corrupt every name in the gate's own set. `AFFECTED_WS_CMD\t` does not match a
 * `startsWith("AFFECTED_WS\t")` filter, so every existing consumer is unaffected.
 */
function formatWorkspaceCommand(ws, script, extraArgs = []) {
  const argv = [
    ...(ws.standalone
      ? ["npm", "--prefix", ws.dir, "run", "--silent", script]
      : ["npm", "run", "--silent", "--workspace", ws.dir, script]),
    // P-009 part (a): a task that will be instrumented must PRINT as instrumented.
    // A printed command that omits a flag the real spawn adds is the same drift
    // this function's doc-comment exists to prevent, one flag further down.
    ...(extraArgs.length ? ["--", ...extraArgs] : []),
  ];
  return argv.map(shellQuote).join(" ");
}

/**
 * Every submodule path declared in `.gitmodules` (e.g. `libs/papercusp`), memoized.
 *
 * Exists because a submodule path is a CHANGED-PATH SHAPE in its own right, and the only
 * shape under which a change inside a submodule ever reaches this file: the diffs above run
 * `--ignore-submodules=dirty` and `submoduleDirtyPaths()` reports the submodule ROOT, so an
 * edit to `libs/papercusp/packages/locks/src/su-lock-store.ts` arrives here as the bare path
 * `libs/papercusp` — no extension, and matched by no file-family predicate. A guard whose
 * `appliesTo` tests only `/\.tsx?$/` therefore CANNOT attach for any submodule-internal
 * change, which is 39 submodules' worth of source (WI-38401; the 2026-08-12 ~14h `main`
 * freeze originated in exactly that blind spot).
 *
 * Fails OPEN (empty set) for the same reason `invariantGuardChangedPaths()` does.
 */
let gitmodulePathsCache = null;
function gitmodulePaths() {
  if (gitmodulePathsCache) return gitmodulePathsCache;
  try {
    gitmodulePathsCache = new Set(
      sh("git config --file .gitmodules --get-regexp path")
        .split("\n")
        .filter(Boolean)
        // The value is everything past the first space, so a path containing spaces
        // survives (splitting on whitespace would truncate it).
        .map((l) => l.slice(l.indexOf(" ") + 1).trim())
        .filter(Boolean),
    );
  } catch {
    gitmodulePathsCache = new Set(); // no .gitmodules (or unreadable) — nothing to probe
  }
  return gitmodulePathsCache;
}

// Live submodules with uncommitted work — the blind spot `--ignore-submodules=dirty`
// leaves. Returns submodule paths (e.g. `libs/generic/memory`), which map to a
// workspace exactly like a gitlink change does. Best-effort by design: a retired
// submodule whose gitdir is gone throws, and that is precisely the case we must
// swallow rather than let abort the run.
function submoduleDirtyPaths() {
  const paths = [...gitmodulePaths()];
  if (!paths.length) return [];
  const dirty = [];
  for (const p of paths) {
    try {
      // stdio pipe: a retired submodule's `fatal: cannot change to '<path>'` is an
      // EXPECTED, handled condition here. execSync forwards stderr to the parent by
      // default, so without this a swallowed error still prints a scary `fatal:` line
      // and reads like a broken run (the EI-1989 failure mode, in reverse).
      const out = execFileSync("git", ["-C", p, "status", "--porcelain"], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (out) dirty.push(p);
    } catch {
      // Retired/broken submodule — skip it, exactly as `=all` used to.
    }
  }
  return dirty;
}

const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

// STANDALONE packages: real, tested packages in this tree that are deliberately NOT
// npm workspaces, so `root.workspaces` cannot see them and this script used to run
// ZERO of their tests — including in the green gate, whose greenCmd is
// `npm run test:affected` (release-config.ts). papercusp-desktop is the case that
// exposed it (WI-6077): a git SUBMODULE with its own dependency graph and lockfile,
// whose ~20 guard suites (deb/sidecar/reaper/config + the live-federation rig
// selftests) protect exactly the release+packaging paths this repo ships, and none
// of them were reachable from any gate.
//
// ⚠ DO NOT "tidy" these into root.workspaces. Adding a submodule there changes npm's
// install/hoisting topology for a package that manages its own deps — a far larger and
// riskier change than the gate gap it would close. They are joined to the graph HERE
// instead, and marked `standalone` so spawnSpecFor() runs them with cwd=<dir> rather
// than `npm run --workspace <dir>`, which only resolves for genuine workspaces.
//
// Its Rust tests are NOT included and must not be: a separate cargo step already runs
// them (`test:rust` -> scripts/report-cargo-tests.mjs). The gap was only the JS/shell side.
//
// `libs/generic/sse` is the SECOND case, and it arrived here for a DIFFERENT reason than
// papercusp-desktop: not a deliberate exclusion, an OVERSIGHT. It is structurally identical
// to its listed siblings (`libs/generic/search`, `/memory`, `/sync` — all git submodules, no
// private lockfile, same layout) and simply never got added to `root.workspaces`, so every
// path under it mapped to NO workspace. MEASURED 2026-08-10 (EI-20027740706934564):
//
//   --changed-paths libs/generic/sse/src/index.ts  -> (nothing)  EXIT=0   ZERO workspaces
//   --changed-paths libs/generic/search/src/hybrid.ts -> @papercusp/search, @papercusp/web,
//                                                        @papercusp/operator-core, @papercusp/agent-mcp
//
// Cost of that hole, both directions: sse's own 18 test files / 183 tests never ran in the
// gate (greenCmd is `npm run test:affected`), AND none of the SEVEN packages that already
// DECLARE @papercusp/sse ran either — apps/operator + agent-mcp (`file:../../libs/generic/sse`),
// flags, agent-chat, tooldef-http, sync, desktop-ipc (`"*"`). Note the declarations were never
// the problem: the reverse-dep walk could not use them because the changed path never resolved
// to the package in the first place. This is the SSE transport — `HarnessSyncProvider` passes a
// literal syncType="SSE" with no runtime branch — i.e. the shipping desktop product's sync path.
// Latent rather than constantly-breaking for the same reason the `scripts/` hole was: git-sync
// sweeps the whole tree, so an sse change is nearly always co-committed with paths that DO
// select something. Invisible until the one sweep where it isn't.
//
// ⚠ Joined HERE rather than added to `root.workspaces` for a MEASURED reason, not a stylistic
// one: `package-lock.json` carries its OWN copy of the workspaces array (84 entries, exactly
// matching root package.json), and CI runs `npm ci` strict. Listing sse there without
// regenerating the lockfile breaks `npm ci`; regenerating it means a full `install:safe` that
// rewrites node_modules/.bin under every concurrent agent's in-flight test run. Normalizing it
// into a real workspace is the cleaner end-state and should be done in a quiet window — the
// lockfile already records it as `{"resolved":"libs/generic/sse","link":true}`, identical in
// shape to a listed sibling, so that change is small; it is the TIMING that makes it costly.
// Its `test` script was added in the same change (siblings all use the same `vitest run`);
// scripts are not recorded in lockfile package entries, so that half is lockfile-inert.
// EI-20028225708881148 — `libs/papercusp/packages/file-claim` is the SAME hole as sse above,
// found by widening the check-workspace-deps-complete guard and re-probing every non-workspace
// local package rather than only the one that surfaced. MEASURED 2026-08-10, before this line:
//
//   node scripts/affected-tests.mjs --changed-paths libs/papercusp/packages/file-claim/src/index.ts \
//     --print-affected        ->  ZERO AFFECTED_WS lines
//
// It is a real runtime dependency of the orchestrator's chunk-loop
// (worker-chunk-loop.ts, chunk-loop-driver.ts, run-worker-chunk-loop.ts,
// file-lock-queue-coordinator.ts) and of libs/papercusp/packages/locks' coordinator, and it is
// ALREADY DECLARED by three workspaces — apps/operator (`file:../../libs/papercusp/packages/file-claim`),
// orchestrator and locks (`"*"`). As with sse, the declarations were never the problem: the
// changed path resolved to no package, so the reverse-dep walk had nothing to walk FROM.
// Joining it here puts `@papercusp/file-claim` into wsByName, and reverseDeps then reaches those
// declarers on any change to it.
//
// ⚠ Unlike sse, file-claim has NO tests of its own (`vitest run --passWithNoTests`), so the value
// here is entirely in selecting its DECLARERS — notably the orchestrator's own
// file-lock-queue-coordinator.test.ts and its conformance suite, which exist precisely to keep the
// two FileClaimCoordinator backends (in-process FileLockQueue vs PG-backed SU-locks) aligned. A
// vocabulary package whose whole job is cross-backend conformance is the worst possible one to
// have unrouted: changing it is exactly when you need both backends' suites to run.
//
// Joined HERE rather than added to root.workspaces for the same MEASURED lockfile reason given
// for sse above — package-lock.json carries its own 84-entry workspaces array and CI runs
// `npm ci` strict; the lock already records file-claim as a link entry, so normalizing it is a
// small change whose cost is TIMING, not shape.
//
// WI-10003821 — tools/perf-test/wdio. The packaged-desktop WebdriverIO runner. Its
// perf-report.node-test.ts pins the runner's own invariants (reset-before-preflight, fixture
// continuity, stamp-only batch refusal, the binary build-time stamp the DESKTOP_PERF_GATE reads)
// and NO gate task selected it: `--changed-paths tools/perf-test/wdio/perf-report.ts` resolved to
// zero workspaces. It has its own node_modules and lockfile, like papercusp-desktop. Its `test`
// script is ONLY those headless guards; the typecheck + GUI suite that needs a packaged binary is
// `test:all` (perf:desktop and the scheduled desktop-perf run call that), because a gate box
// cannot boot the binary and a `test` that tries would be red on every change to this package.
const STANDALONE_PACKAGE_DIRS = [
  "papercusp-desktop",
  "libs/generic/sse",
  "libs/papercusp/packages/file-claim",
  "tools/perf-test/wdio",
];

// EI-19346163916263067 — NON-WORKSPACE SOURCE DIRECTORIES.
//
// The mapping in affectedWorkspaces() below matches a changed path against each
// WORKSPACE DIRECTORY. Root `scripts/` is not an npm workspace and holds no
// package.json, so EVERY path under it mapped to NOTHING: it contributed zero to
// the affected set. That directory is the repo's own gate machinery —
// affected-tests.mjs itself, lint-tsc*.mjs, gen-declarations.ts, next-migration.mjs,
// and the 53 `check-*.mjs` guards — i.e. the tooling that decides what gets tested
// was the one thing that tooling could not select tests for.
//
// The tests DO exist: 56 test files in packages/operator-core exercise root
// `scripts/` directly (every `check-*.mjs` guard test, lint-tsc.test.ts,
// generated-declarations.test.ts, typecheck-script.test.ts, the affected-tests-*
// guards). They were simply unreachable from the edit that needs them.
//
// MEASURED incidence before this fix (last 600 commits of staging): 106 commits
// touched `scripts/`; for 7 of them (6.6%) the computed affected set did NOT
// include operator-core, so those ~56 suites never ran — and one (33edac17e5)
// selected ZERO workspaces and reported `status=passed tasks=0` having run nothing.
// It is rare rather than never because git-sync sweeps the whole tree, so a commit
// is almost never scripts-only; that also means the hole is invisible until the
// one sweep where it isn't.
//
// Routed into `directlyChanged` (not appended after the walk) deliberately: these
// paths then behave exactly like a change to the owning workspace, reverse-deps
// included. Splitting the semantics would add a second selection rule whose
// divergence from the first nobody would notice.
const NON_WORKSPACE_PATH_ROUTES = [
  { prefix: "scripts/", workspace: "@papercusp/operator-core" },
  // CLAUDE.md is a PRESCRIPTIVE artifact spliced into every agent's prompt, and
  // its executable claims are asserted by operator-core's doc-claims suite
  // (false-premise-in-prescriptive-artifacts-2026-08-02 P-004). MEASURED before
  // adding it: `--changed-paths CLAUDE.md` selected ZERO workspaces, so the one
  // guard that checks this file did not run when this file changed — the guard
  // would have fired only via the full suite, hours later at the fleet gate,
  // which is the exact latency the check exists to remove.
  { prefix: "CLAUDE.md", workspace: "@papercusp/operator-core" },
  // WI-37840. `templates/` is SHIPPED CONTENT with no package.json of its own, and
  // the three guards that govern it are vitest files in operator-core
  // (template-bundle-integrity, template-docs-slugs, template-store-shadowing).
  // MEASURED before adding it: `--changed-paths templates/papercusp-ui/template.yaml`
  // selected ZERO workspaces and exited 0, while the same run against an
  // operator-core path selected five — so a templates-only commit ran no tests at
  // all, and "nothing to gate" is GREEN at the green-checkpoint. Every defect this
  // plan built guards for (a dangling docs: slug, an unvendored @papercusp/* import
  // in a template check, user-layer shadowing residue) is introduced by exactly that
  // shape of commit, so the guards were unreachable from the change they guard.
  { prefix: "templates/", workspace: "@papercusp/operator-core" },
  { prefix: "templates/", workspace: "@papercusp/deployment-driver" },
  // EI-21112293570332409. A SECOND route for the same prefix — the loop below applies
  // every matching route, it does not stop at the first, so this composes with the
  // operator-core row above rather than replacing it.
  //
  // The route above covers the three template guards that live in operator-core. It does
  // NOT cover `libs/generic/template-kit/src/templates-dir.test.ts`, which scans
  // `templates/*/checks/*` to enforce that every check naming a sibling template routes
  // the path through the tri-state resolver `checks/closure-manifests.ts` — the recurrence
  // guard for EI-21110451200329856, where BOTH official mobile app roots shipped checks
  // dereferencing `../../papercusp-<id>` paths that exist only in this repo's templates
  // dir and so were RED in every materialized app.
  //
  // MEASURED before adding it, with a positive control (2026-08-22):
  //   --changed-paths libs/generic/template-kit/src/templates-dir.test.ts
  //       -> AFFECTED_WS @papercusp/template-kit + 5 fallback   (control: selection works)
  //   --changed-paths templates/papercusp-android-app/checks/composition-integrity.test.ts
  //       -> 5 fallback workspaces, template-kit ABSENT         (guard did NOT run)
  //
  // So re-introducing the sibling-path defect in the guarded file left the guard that
  // exists to catch it unselected: scoped `test:affected` returned green, and the guard
  // would have fired only via the full suite at the green-checkpoint hours later. That is
  // the same "unreachable from the change they guard" shape the WI-37840 row above fixes,
  // one workspace over.
  { prefix: "templates/", workspace: "@papercusp/template-kit" },
];

// EI-19388389386110890 — REPO-WIDE INVARIANTS ENFORCED FROM ONE WORKSPACE.
//
// NON_WORKSPACE_PATH_ROUTES above fixes "this path maps to no workspace". This
// fixes the opposite shape: the path maps to its workspace perfectly well, but
// the CHECK that governs it lives in a DIFFERENT one, so the check never runs.
//
// child-output-guard.test.ts is the worked example. Its scope is the whole repo
// — it enumerates via `git ls-files --recurse-submodules`, ~20k TypeScript paths
// across 39 submodules — but it is a vitest file inside @papercusp/operator-core,
// so it is selected only when operator-core is affected. MEASURED 2026-08-03:
//
//   --changed-paths packages/operator-core/lib/terminal-spawn.ts
//       -> AFFECTED_WS @papercusp/operator-core, @papercusp/web   (guard runs)
//   --changed-paths apps/operator/lib/release/deploy-cli.ts
//       -> AFFECTED_WS @papercusp/web                             (guard does NOT run)
//
// So introducing a chunk-unsafe `stdout += String(chunk)` anywhere outside
// operator-core produced NO local signal — test:affected green, lint:tsc green
// (it is type-only) — and first surfaced hours later as a red FLEET gate that
// blocks every agent. That is the whole reported history of the class: five
// separate correct fixes (EI-19298378364087215, EI-19356631236774183, WI-6776,
// WI-6666/WI-6667), each caught at the most expensive possible moment, each
// looking like fresh breakage because each offender genuinely was new.
//
// A guard listed here runs whenever a changed path matches `appliesTo`, even if
// its owning workspace is not otherwise affected. It is a SEPARATE, NARROW task
// (never the workspace's whole `test` suite) precisely so it can be cheap enough
// to run on every change: the chunk-safe guard is 14 assertions, ~1s.
//
// Adding one is a deliberate act: the cost is paid by every agent on every edit,
// so it is only worth it for an invariant that is genuinely repo-wide AND whose
// violation is expensive to discover late. lint:no-raw-setinterval does NOT belong
// here because it genuinely has a blocking leg of its own (8 references in
// apps/operator/lib/release/green-checkpoint.ts, and it passes today) — that
// contrast is the argument for this list, not against it.
//
// ⚠ CORRECTED 2026-09-20 (WI-10002061): this sentence used to make the SAME claim
// for lint:no-unenrolled-spawn. That half was FALSE, and it survived review because
// the claim is true of the guard named beside it. Measured: no-unenrolled-spawn has
// an npm script but ZERO references in green-checkpoint.ts, so no blocking path ran
// its TREE SCAN. Its two process-group-only sites are now reasoned allowlist entries,
// and the repo-wide invariant registration below runs the green tree scan on source edits.
// Before that registration it nevertheless read as covered, because
// check-lint-guard-reachability.mjs credits the `test` category
// from no-unenrolled-spawn-guard.test.ts, which exercises only the PREDICATE against
// synthetic fixtures and never enumerates tracked files. The offenders were resolved
// before registration so this entry did not introduce a red leg for every source edit.
// MIRRORS `SOURCE_ROOTS` / `SCHEMA_FILE_REL` in scripts/check-partial-index-alignment.mjs.
// Deliberately COPIED rather than imported: this router is the entry point for every
// agent's test loop, and the guard mechanism above is documented to fail OPEN — a static
// import would let a load error in a lint script hard-fail everyone's `test:affected`,
// which is exactly the trade that comment rejects.
//
// Copying costs a drift risk, so the drift is ASSERTED, not trusted:
// `affected-tests-repo-wide-invariant-guards.test.ts` imports the real exports and fails
// if these lists disagree. Add a root there and this list must follow, or the guard
// silently stops firing for that root — the same "green because it stopped checking"
// shape the registry exists to prevent.
const PARTIAL_INDEX_SOURCE_ROOTS = [
  "packages/operator-core/lib",
  "packages/agent-mcp/src",
  "apps/operator/lib",
  "libs/papercusp/packages",
];
const PARTIAL_INDEX_SCHEMA_FILE =
  "libs/papercusp/libs/db/src/schema/generated.ts";

// WI-9573 / EI-20208711931756460. Mirrors SQL_DIR + SOURCE_ROOTS in
// scripts/check-migration-forward-compat.mjs — that lint scans parked migration artifacts
// and source consumers, so if either domain moves, this must follow or the guard silently
// stops firing (the same "green because it stopped checking" shape).
const MIGRATION_SQL_DIR = "libs/papercusp/libs/db/sql";
const MIGRATION_SOURCE_ROOTS = [
  "apps",
  "packages",
  "libs/papercusp/packages",
  "libs/papercusp/libs/db/src",
];

// EI-7667. Mirrors ROOTS in scripts/check-no-unthreaded-apply.mjs — that guard walks
// exactly these roots, so if its scan widens, this must follow or the guard silently
// stops firing on the new root.
const UNTHREADED_APPLY_SOURCE_ROOTS = ["packages", "libs", "apps"];

// okf-frontmatter-adoption-2026-08-08 P-006. MIRRORS OKF_SCAN_ROOTS in
// scripts/check-okf-conformance.mjs — mirrored, not imported, because this file is
// every agent's test-loop entry point and a static import would let a load error in
// that lint hard-fail everyone's test:affected. The mirror is asserted equal to the
// real exports by affected-tests-repo-wide-invariant-guards.test.ts; if the lint's
// scan widens, this must follow or the guard silently stops firing on the new root.
const OKF_SCAN_ROOTS = [
  "apps/operator-docs/src/content/docs/agent-insights/",
  "libs/papercusp/packages/harness/knowledge-packs/",
];

// WI-37605. MIRRORS `GC_TAG_SOURCE_ROOTS` in scripts/check-green-checkpoint-tag.mjs — that guard
// walks exactly these roots, so if its scan widens this must follow or the guard silently stops
// firing on the new root. Mirrored rather than imported for the reason stated above: this router is
// every agent's test-loop entry point, and a static import would let a load error in a lint script
// hard-fail everyone's test:affected. The mirror is asserted equal to the real export by
// affected-tests-repo-wide-invariant-guards.test.ts.
const GC_TAG_SOURCE_ROOTS = ["packages/operator-core/lib", "apps/operator/lib"];

// MIRRORS `EXIT_NOT_CHECKED` in scripts/lib/not-checked.mjs — mirrored, not imported, for the
// same reason as the roots above: this file is every agent's test-loop entry point, and a load
// error in a lint module must not hard-fail everyone's test:affected. Asserted equal to the real
// export by affected-tests-repo-wide-invariant-guards.test.ts.
//
// WHY THE RUNNER HAS TO KNOW THIS NUMBER AT ALL (WI-37826): the strand-guard family derives its
// subject from `git diff <base>`, so it answers THREE things, not two — 0 "checked, found
// nothing", 1 "checked, found something", 2 "I could not look". A gate that collapses those into
// `status !== 0` reads "I could not look" as "violation". That is not hypothetical here: a gate
// checkout is CLEAN BY CONSTRUCTION (the candidate is committed), so the working diff is empty
// and a registered strand guard examines zero files EVERY time — turning exit 2 into a
// permanent, content-free red on every candidate that touches a .ts file.
const EXIT_NOT_CHECKED = 2;

// WI-38089 — the declarations freshness guard must be reachable from the `.mjs` files it guards.
//
// `packages/operator-core/lib/generated-declarations.test.ts` execs `scripts/gen-declarations.ts
// --check`, comparing the 42 `.mjs` inputs declared in tsconfig.declarations.json against their
// committed `.d.mts`. It is a vitest file inside @papercusp/operator-core, so it was selected only
// when operator-core was otherwise affected. MEASURED 2026-08-12:
//
//   --changed-paths apps/operator/scripts/psu-launcher.mjs
//       -> AFFECTED_WS @papercusp/web ONLY                         (guard does NOT run)
//   --changed-paths packages/operator-core/lib/model-context-budget.mjs
//       -> AFFECTED_WS @papercusp/operator-core, ...               (guard runs)
//
// psu-launcher.mjs IS a declared input (tsconfig.declarations.json), so editing it without
// re-running `npm run gen:declarations` produced NO local signal — test:affected green, and the
// drift is type-only so lint:tsc is green too — and first surfaced as green-checkpoint red #9
// (candidate cc56ee43) an hour later, against a candidate its author had long moved past. That is
// the expensive shape this list exists for: the red lands on whoever is watching the gate rather
// than on whoever caused it. Two remediation commits in the preceding 4h are the same class:
// d41534e1 ("regenerate all generated declaration projections") and 00d79147.
//
// DERIVED from tsconfig.declarations.json rather than MIRRORED as a literal list — a deliberate
// deviation from the mirrored roots above. The config IS the set gen-declarations reads, so
// deriving makes drift structurally impossible rather than merely asserted. The stated reason those
// other lists are copied — "a static import would let a load error in a lint script hard-fail
// everyone's test:affected" — is about importing EXECUTABLE modules; this reads data, never
// executes it, and is wrapped so a malformed config cannot throw here.
//
// A quoted-`.mjs` regex, not JSON.parse: the config carries `//` comments, so JSON.parse rejects it
// outright (verified). An over-match — a quoted `.mjs` inside a comment — only widens attachment,
// which is the fail-safe direction; every real entry is quoted, so under-matching a declared input
// cannot happen.
const DECLARATIONS_CONFIG = "tsconfig.declarations.json";
let declarationInputsCache;
function declarationMjsInputs() {
  if (declarationInputsCache !== undefined) return declarationInputsCache;
  try {
    const raw = readFileSync(join(ROOT, DECLARATIONS_CONFIG), "utf8");
    const found = [...raw.matchAll(/"([^"\n]+\.mjs)"/g)].map((m) => m[1]);
    // An empty set would silently disable the guard, which is the failure mode this whole
    // registry exists to prevent — treat it as "could not read" and widen instead.
    declarationInputsCache = found.length > 0 ? new Set(found) : null;
  } catch {
    // Fail SAFE, not open. Elsewhere in this file failing open (no guard) is right because the
    // subject list is the CHANGED paths; here the subject is the guard's own scope, so an
    // unreadable config must not quietly stop it firing. Over-attaching costs ~6s; under-attaching
    // costs a fleet-blocking gate red discovered hours later.
    declarationInputsCache = null;
  }
  return declarationInputsCache;
}

const UNENROLLED_MJS_IMPORTS_DETECTOR =
  "scripts/check-unenrolled-mjs-imports.mjs";
const UNENROLLED_MJS_IMPORTS_FILE_ENUMERATOR = "scripts/lib/tracked-files.mjs";

// EI-21618443971639284 — the canonical SU prompt and its committed projections are
// generated by three scripts in two package trees. Keep this trigger set copied rather
// than importing the guard: affected-tests is every agent's test-loop entry point, so a
// load failure in a lint script must not hard-fail the runner. The registry test covers
// the source/projection selection and the guard's own test proves byte comparison.
const PROMPT_PROJECTION_TRIGGER_PATHS = new Set([
  "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
  "apps/operator/dist-sidecar/blueprints/base/prompts/su.md",
  "papercusp-desktop/src-tauri/env-sidecars/staging/harness/blueprints/base/prompts/su.md",
  "apps/operator/bin/bundle-host.sh",
  "papercusp-desktop/bin/build-desktop-sidecar.sh",
  "papercusp-desktop/bin/stage-env-sidecars.sh",
  "scripts/check-prompt-projections.mjs",
  "scripts/affected-tests.mjs",
  "packages/operator-core/package.json",
  "packages/operator-core/lib/__tests__/check-prompt-projections.test.ts",
  "packages/operator-core/lib/__tests__/affected-tests-repo-wide-invariant-guards.test.ts",
]);

// agent-launch-context-cost-2026-09-18 P-004 — the shrink-only ceilings on the PROSE
// half of a launch payload. WIRED REPO-WIDE because the subject spans trees that route
// to different suites and, for the largest surface, to NO suite at all: the project
// guide is the repo-ROOT CLAUDE.md, and the playbook bases and client overlays live
// under apps/operator/prompts while the renderer and the comparison live in
// operator-core. A prose edit is exactly the change that grows these surfaces and
// exactly the one ordinary workspace selection cannot route to the guard.
//
// Kept as a literal path set (the same fail-safe import boundary as
// PROMPT_PROJECTION_TRIGGER_PATHS) rather than a glob, so a new prose surface must be
// registered deliberately instead of being absorbed by a pattern.
const LAUNCH_PROSE_BUDGET_TRIGGER_PATHS = new Set([
  // The surfaces themselves. CLAUDE.md and AGENTS.md are two client projections of the
  // SAME harness_doc_parts, so a part edit re-projects both; each is governed separately
  // because their reader thresholds differ.
  "CLAUDE.md",
  "AGENTS.md",
  "apps/operator/prompts/papercusp-su-engineer.tools.md",
  "apps/operator/prompts/papercusp-su-power.tools.md",
  "apps/operator/prompts/papercusp-su.claude.md",
  "apps/operator/prompts/papercusp-su.codex.md",
  "apps/operator/prompts/papercusp-su.omp.md",
  "apps/operator/prompts/papercusp-compaction.base.md",
  "apps/operator/prompts/papercusp-compaction.claude.md",
  "apps/operator/prompts/papercusp-compaction.protocol.md",
  // The renderer: a splice change moves every measured number at once.
  "packages/operator-core/lib/desktop-install/papercusp-files.ts",
  // The gate, its comparison module, and its baseline — each decides what "clean" means,
  // so a change to any of them can move the verdict with no surface changing.
  "scripts/check-launch-prose-budget.ts",
  "scripts/launch-prose-budget-baseline.json",
  "packages/operator-core/lib/launch-prose-budget.ts",
  "packages/operator-core/lib/launch-prose-budget.test.ts",
  "scripts/affected-tests.mjs",
  "package.json",
  "packages/operator-core/package.json",
  "packages/operator-core/lib/__tests__/affected-tests-repo-wide-invariant-guards.test.ts",
]);

// identities-v1 P-024 — the exact-once splice contract spans authored prompt
// bases, derived identity/part documents, and packaged projections in different
// workspace trees. Keep the runner independent of the guard module (the same
// fail-safe import boundary as PROMPT_PROJECTION_TRIGGER_PATHS); the guard's
// Vitest coverage pins this routing set against representative paths.
const SU_SPLICE_MARKER_TRIGGER_PATHS = new Set([
  "libs/papercusp",
  "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
  "libs/papercusp/packages/harness/blueprints/base/prompts/su.kernel.md",
  "libs/papercusp/packages/harness/blueprints/base/prompts/su.practice.md",
  "libs/papercusp/packages/harness/blueprints/base/prompts/su.instance.md",
  "libs/papercusp/packages/orchestrator/src/blueprint/su-decomposition.ts",
  "apps/operator/prompts/papercusp-su-engineer.tools.md",
  "apps/operator/prompts/papercusp-su-power.tools.md",
  "apps/operator/prompts/papercusp-compaction.base.md",
  "packages/operator-core/lib/desktop-install/splice-tooling-overlay.ts",
  "packages/operator-core/lib/desktop-install/su-render-baseline.test.ts",
  "packages/operator-core/lib/desktop-install/__fixtures__/su-render-baseline/su.base.md",
  "packages/operator-core/lib/desktop-install/__fixtures__/su-render-baseline/baseline.json",
  "papercusp-desktop",
  "papercusp-desktop/src-tauri/env-sidecars/staging/harness/blueprints/base/prompts/su.md",
  "apps/operator/bin/bundle-host.sh",
  "papercusp-desktop/bin/build-desktop-sidecar.sh",
  "papercusp-desktop/bin/stage-env-sidecars.sh",
  "scripts/check-su-splice-markers.ts",
  "scripts/affected-tests.mjs",
  "packages/operator-core/package.json",
  "packages/operator-core/lib/__tests__/affected-tests-repo-wide-invariant-guards.test.ts",
]);

const REPO_WIDE_INVARIANT_GUARDS = [
  {
    // EI-24368307678871025 — the host's real esbuild graph must resolve imports
    // against the committed operator-core tree before a restart uses that graph.
    // The existing check builds into a temporary directory, so it cannot replace
    // the running host bundle. Keep this as a separate task: operator-core's
    // Vitest suite does not execute the host bundler.
    workspace: "@papercusp/operator-core",
    script: "lint:host-bundle-builds",
    appliesTo: (f) =>
      f === "apps/operator/bin/hono-host.ts" ||
      f === "apps/operator/bin/bundle-host.sh" ||
      f === "scripts/check-host-bundle-builds.mjs" ||
      f === "scripts/affected-tests.mjs" ||
      f === "packages/operator-core/package.json" ||
      f === "package.json" ||
      f === "package-lock.json" ||
      (/\.[cm]?[jt]sx?$/.test(f) &&
        !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(f) &&
        (f.startsWith("apps/operator/lib/") ||
          f.startsWith("packages/operator-core/lib/"))),
  },
  {
    // WI-10002061 — this guard scans tracked TS/TSX source across the entire tree.
    // Predicate-only unit tests cannot catch a newly introduced detached spawn,
    // and the root npm script was previously absent from every blocking runner.
    // Attach the real-tree scan to each source edit, including edits outside the
    // host workspace. Its own checker and routing configuration also attach.
    workspace: "@papercusp/operator-core",
    script: "lint:no-unenrolled-spawn",
    appliesTo: (f) =>
      (/\.tsx?$/.test(f) &&
        !/\.(?:test|spec)\.tsx?$/.test(f) &&
        !f.includes("node_modules/") &&
        !f.includes("_retired/")) ||
      f === "scripts/check-no-unenrolled-detached-spawn.mjs" ||
      f === "scripts/affected-tests.mjs" ||
      f === "packages/operator-core/package.json" ||
      f === "package.json",
  },
  {
    // The packaged WDIO runner lives outside npm workspaces. Its Node unit
    // suite is part of the package's `test` script, but the affected-workspace
    // router cannot select that package from a runner-only source edit. Run the
    // existing unit suite as a narrow guard so IPC receipt safety remains gated.
    workspace: "@papercusp/operator-core",
    script: "test:packaged-runner-unit",
    appliesTo: (f) =>
      f === "packages/operator-core/package.json" ||
      f === "scripts/affected-tests.mjs" ||
      (f.startsWith("tools/perf-test/wdio/") && /\.(?:[cm]?[jt]sx?|json)$/.test(f)),
  },
  {
    // deterministic-tool-definition-delivery-2026-09-21 P-005 — the tool-delivery
    // drift gate. `apps/operator/scripts/tool-delivery.generated.mjs` holds the
    // RESOLVED per-agent delivery map (which tools are advertised, at FULL or
    // COMPACT), derived from the live catalog measured at both tiers, the committed
    // demand snapshot, the floor registry, and a stated per-agent byte budget.
    //
    // WIRED REPO-WIDE rather than left to workspace selection because the drift is
    // NON-LOCAL by construction, and that is the whole defect this closes. Editing
    // ONE tool's schema or guidance changes ITS bytes, which changes what fits in a
    // fixed budget, which silently changes whether some OTHER, unrelated tool is
    // still advertised at all. The edited tool's own workspace suite has no reason
    // to know that, and the displaced tool's workspace was never selected — so the
    // agent population quietly loses a tool and nothing anywhere goes red.
    //
    // TRIGGER SCOPE covers the two things that can move the map: a TOOL DEFINITION
    // (the agent-tools source, where defineTool's description/guidance/argSchema
    // live) and the derivation's own inputs. Test files are excluded: they cannot
    // change a projected tool's wire bytes. It does NOT fire on ordinary source
    // edits elsewhere in the tree.
    // COST measured 2026-09-21 via this exact npm script: 14.83s, exit 0.
    //
    // Safe to wire NOW on the same precedent as the entries below: measured green
    // over the whole real tree FIRST (899 tools measured, 90 advertised at 99,898 B
    // of a 100,000 B budget, 0 overrun, check exit 0), and its falsifiability was
    // proven by mutation probe rather than assumed — a one-byte edit to the
    // artifact is CAUGHT (guard exit 1), so this cannot be a gate that passes by
    // measuring nothing.
    // Hosted by the operator-core workspace (a thin `tsx ../../scripts/...` shim) for
    // the same reason `lint:reachable-advisories` is: the loop below resolves
    // `guard.workspace` through the npm-workspaces map, and the ROOT monorepo package
    // is not a member of it — a root-named guard is silently skipped rather than
    // reported, which is how a wired-looking gate ends up never running.
    workspace: "@papercusp/operator-core",
    script: "gen:tool-delivery:check",
    appliesTo: (f) =>
      !f.includes("node_modules/") &&
      !f.endsWith(".test.ts") &&
      (f === "scripts/gen-tool-delivery.ts" ||
        f === "apps/operator/scripts/tool-delivery.generated.mjs" ||
        f === "apps/operator/lib/tool-delivery-floors.ts" ||
        f === "packages/operator-core/lib/agent-tools/tool-delivery-policy.ts" ||
        f === "packages/operator-core/lib/agent-tools/tool-demand-snapshot.json" ||
        f === "libs/generic/tooldef/src/compact-schema.ts" ||
        f.startsWith("packages/operator-core/lib/agent-tools/")),
  },
  {
    // security-boundary-remediation-and-usability-2026-09-04 P-007 / WI-2144851 —
    // the reachable-production-advisory gate. It attributes every npm advisory to the
    // workspace(s) that pull it in, gates only on the SHIPPING high/critical set, and
    // fails closed on an advisory it cannot attribute. Baseline is shrink-only
    // (scripts/reachable-advisories-baseline.json), exactly like KNOWN_DARK_FLAGS.
    //
    // WIRED REPO-WIDE rather than left to workspace selection because the subject is not
    // any workspace's source: it is the dependency GRAPH, and a new shipping advisory
    // enters through a manifest/lockfile edit in a workspace whose own suite has no
    // reason to know about it. Left unwired, the gate existed and was falsifiable but
    // nothing ran it — the state this entry closes.
    //
    // TRIGGER SCOPE is deliberately narrow: only a dependency-manifest change can
    // introduce or resolve an advisory, so it fires on package.json / package-lock.json,
    // on the gate itself, and on its baseline. It does NOT fire on ordinary source edits.
    // COST measured 2026-09-05 via this exact npm script: 15.34s, exit 0.
    //
    // Safe to wire NOW on the same precedent as the entries below: measured green over
    // the whole real tree FIRST (99 advisories -> 9 gating, all 9 baselined with a stated
    // reason, 0 NEW offenders), so registering it cannot red-pin the fleet on debt that
    // accrued while it slept.
    //
    // A network failure is NOT a red here: measureJson() in the gate retries the
    // registry-dependent audit and, if it still cannot measure, throws a message leading
    // with ADVISORY_GATE_UNDETERMINED, so a triager can tell "re-run this" from "patch a
    // dependency" without reading the gate's source.
    workspace: "@papercusp/operator-core",
    script: "lint:reachable-advisories",
    appliesTo: (f) =>
      !f.includes("node_modules/") &&
      (f === "package-lock.json" ||
        f === "package.json" ||
        f.endsWith("/package.json") ||
        f === "scripts/check-reachable-advisories.mjs" ||
        f === "scripts/reachable-advisories-baseline.json"),
  },
  {
    // security-boundary-remediation-and-usability-2026-09-04 P-007 / WI-2144851 —
    // the RUST/NATIVE half of the same advisory clause. The entry above covers the npm
    // graph; it is npm-only by construction (measured: 0 occurrences of cargo/rust/crate),
    // while papercusp-desktop/src-tauri/Cargo.lock pins 615 crates into the SHIPPED
    // desktop app with nothing scanning them at all. The source audit
    // (docs/audits/security-usability-2026-09-04.md:170) asked for JS *and* Rust and
    // closed with "Rust dependency and native-binary advisory scans were not run in this
    // audit"; the work-item text compressed that to "advisory/SBOM checks" and dropped
    // the word naming the surface.
    //
    // WIRED REPO-WIDE for the same reason as the npm entry: the subject is a dependency
    // GRAPH, not any workspace's source. It is doubly true here — papercusp-desktop is a
    // SUBMODULE and is deliberately absent from the root npm workspaces, so ordinary
    // workspace selection can never reach it.
    //
    // GATES ON VULNERABILITIES AT ANY SEVERITY, deliberately unlike the npm entry's
    // high/critical threshold. MEASURED 2026-09-05: every RustSec advisory over this
    // lockfile carries `severity: []` / `cvss: null`, so a high/critical filter selects
    // ZERO rows and prints a confident "0 gating" — a gate that reports success because
    // it measured nothing. The discriminator is `database_specific.informational`
    // instead: the 17 unmaintained + 1 unsound notices are reported and never gate.
    //
    // TRIGGER SCOPE is narrow on the same logic: only a manifest/lockfile change to the
    // SHIPPED crate can introduce or resolve an advisory here. It deliberately does NOT
    // fire on the six other Cargo.lock files in this tree (apps/tui, the pui-* helpers,
    // vendored tao/wry, the libs/papercusp desktop copy) — none of them ships.
    // COST measured 2026-09-05 via this exact npm script: 3.39s, exit 0.
    //
    // Safe to wire NOW on the same precedent as the entry above: measured green over the
    // whole real lockfile FIRST (21 advisory clusters -> 3 gating vulnerabilities, all 3
    // baselined with a stated reason, 0 NEW offenders), so registering it cannot red-pin
    // the fleet on debt that accrued while nothing was looking.
    //
    // A network failure is NOT a red: every OSV call retries, and an unmeasurable run
    // throws a message leading with RUST_ADVISORY_GATE_UNDETERMINED and exits 2, so a
    // triager can tell "re-run this" from "patch a crate" without reading the source.
    workspace: "@papercusp/operator-core",
    script: "lint:rust-advisories",
    appliesTo: (f) =>
      !f.includes("node_modules/") &&
      (f === "papercusp-desktop/src-tauri/Cargo.lock" ||
        f === "papercusp-desktop/src-tauri/Cargo.toml" ||
        f === "scripts/check-rust-advisories.mjs" ||
        f === "scripts/rust-advisories-baseline.json"),
  },
  {
    // security-boundary-remediation-and-usability-2026-09-04 P-007 / WI-2144851 — the
    // SBOM/inventory half of the same audit clause. The two advisory gates above each
    // scan exactly ONE hand-chosen lockfile; neither can see a dependency graph outside
    // its own scope, and a graph nobody scans is not "reported clean" — it is NOT
    // MEASURED, which reads identically from outside. This census DERIVES the lockfile
    // population from the filesystem and forces every row into an explicit bucket, so a
    // new blind spot fails loudly instead of being found months later by hand.
    //
    // TRIGGER SCOPE is deliberately the WIDEST of the three: the subject is the SET of
    // lockfiles, so the event that matters is one APPEARING anywhere in the tree — a path
    // no narrower matcher can enumerate in advance, because it does not exist yet. That is
    // also why it cannot be left to workspace selection: a lockfile added under a package
    // with no suite of its own selects nothing at all. The two blind spots that motivated
    // the file (papercusp-desktop/src-tauri/Cargo.lock, then its sibling package-lock.json)
    // both entered exactly this way.
    //
    // COST measured 2026-09-05 via this exact npm script: 0.6s, exit 0 — a filesystem walk
    // and 13 lockfile parses, no network. The syft SBOM emission is deliberately NOT on
    // this path (lint:lockfile-census:sbom is the separate on-demand entrypoint): syft is a
    // dev-box binary, not a pipeline dependency, and emitSbom REFUSES when it is absent
    // rather than skipping quietly, so wiring it here would red-pin any host without it.
    //
    // Safe to wire NOW on the same precedent as the two entries above: measured green over
    // the whole real tree FIRST (13 lockfiles, every one classified, 0 offenders), so
    // registering it cannot red-pin the fleet on debt that accrued while nothing looked.
    workspace: "@papercusp/operator-core",
    script: "lint:lockfile-census",
    appliesTo: (f) =>
      !f.includes("node_modules/") &&
      (f.endsWith("/package-lock.json") ||
        f === "package-lock.json" ||
        f.endsWith("/Cargo.lock") ||
        f === "Cargo.lock" ||
        f === "scripts/check-lockfile-census.mjs"),
  },
  {
    // open-source-release-2026-09-29 P-017 / D-001, WI-10003906 — the LICENSE gates
    // (owner directive #931: npm + Rust license checks block main). Siblings of the two
    // advisory gates above, over the SAME derived lockfile population (censusOrThrow), so
    // a new lockfile anywhere is license-checked with no list to update. A dependency whose
    // license is not permissive or weak-copyleft fails unless scripts/license-exceptions.json
    // records a review of its real license text.
    //
    // COST measured 2026-09-29: npm leg 0.3s (6 lockfiles, 3,399 packages, no network);
    // cargo leg 2.2s (7 lockfiles, 1,187 crates, `cargo metadata --offline`, falling back
    // to a networked resolve only when a crate is not cached). A resolve that still fails
    // exits 2 with LICENSE_GATE_RESULT status=undetermined — "re-run", never "clean".
    //
    // Safe to wire NOW: measured green over the whole real tree first (0 denied, 25 reviewed
    // exceptions, 70 weak-copyleft components reported), after nodebox was removed (P-018).
    workspace: "@papercusp/operator-core",
    script: "lint:npm-licenses",
    appliesTo: (f) =>
      !f.includes("node_modules/") &&
      (f.endsWith("/package-lock.json") ||
        f === "package-lock.json" ||
        f === "scripts/check-licenses.mjs" ||
        f === "scripts/license-exceptions.json" ||
        f === "scripts/check-lockfile-census.mjs"),
  },
  {
    // The cargo leg of the license gate above (WI-10003906). Same script, same exceptions
    // file; split so an npm-only change does not pay for a cargo resolve and vice versa.
    workspace: "@papercusp/operator-core",
    script: "lint:rust-licenses",
    appliesTo: (f) =>
      !f.includes("node_modules/") &&
      (f.endsWith("/Cargo.lock") ||
        f === "Cargo.lock" ||
        f.endsWith("/Cargo.toml") ||
        f === "scripts/check-licenses.mjs" ||
        f === "scripts/license-exceptions.json" ||
        f === "scripts/check-lockfile-census.mjs"),
  },
  {
    // restore-papercusp-main-green-2026-08-20 / WI-212675 — the tight-wall-clock-budget
    // guard (EI-20290625014691548). A test asserting `elapsed < 80ms` is green for its
    // author and red under the shared gate's load, so the defect class it catches is
    // exactly the one that lands on a stranger's candidate hours later; the guard
    // existed, was unit-tested, and ran over NOTHING until this entry (surfaced by
    // lint:guard-reachability as an unwired gate red).
    //
    // WIRED REPO-WIDE rather than left to workspace selection because its subject is
    // the SET of *.test.ts files under packages/, libs/ and apps/ (SCAN_ROOTS in the
    // script) — a tight budget lands with a test edit in whichever workspace, and that
    // workspace's own suite passes it by construction (the failure needs load).
    //
    // TRIGGER SCOPE is the guard's own scan set: any *.test.ts under its three roots,
    // plus the guard itself (its BASELINE lives inline, so a baseline edit IS a guard
    // edit). It does NOT fire on non-test source edits.
    //
    // COST measured 2026-09-05 via this exact script over the whole real tree: 0.64s,
    // exit 0 (floor 500ms, 8 files baselined, 0 offenders) — so registering it cannot
    // red-pin the fleet on debt that accrued while nothing ran it.
    workspace: "@papercusp/operator-core",
    script: "lint:test-timing-budgets",
    appliesTo: (f) =>
      f === "scripts/check-test-timing-budgets.mjs" ||
      (!f.includes("node_modules/") &&
        f.endsWith(".test.ts") &&
        (f.startsWith("packages/") ||
          f.startsWith("libs/") ||
          f.startsWith("apps/"))),
  },
  {
    // design-to-code-coverage-seam-2026-09-02 P-027 / WI-2143001 — the ordinary
    // gate lane is unit-only: it can drive HTTP/MCP observers but deliberately
    // cannot open real PG, while the broad integration lane can persist but may
    // never exercise either chokepoint. This one-file integration venue joins the
    // real route stack + projected-tool dispatcher to the canonical evidence store
    // and asserts both rows raise testing_surface_depth above zero.
    //
    // COST measured before registration on 2026-09-04: 21.53s through the canonical
    // test:file integration router (8.18s assertions, cached baseline schema). That
    // is far too expensive for an all-source predicate, so the trigger is limited
    // to the attribution subsystem, its two observer chokepoints, its two stable
    // probe definitions, and the runner/configuration that makes the venue reachable.
    // It deliberately has no hostSuiteRatchet: operator-core's ordinary host suite
    // is unit-only and therefore cannot substitute for this persistence proof.
    workspace: "@papercusp/operator-core",
    script: "test:coverage-attribution-venue",
    appliesTo: (f) =>
      f === "package.json" ||
      f === "packages/operator-core/package.json" ||
      f === "packages/operator-core/vitest.integration.config.ts" ||
      f === "scripts/affected-tests.mjs" ||
      f === "packages/operator-core/lib/endpoint-route/define-route.ts" ||
      f === "packages/operator-core/lib/endpoint-route/route-stack.ts" ||
      f === "packages/operator-core/lib/endpoint-route/routes/misc/health.ts" ||
      f === "packages/operator-core/lib/projected-tool-deps.ts" ||
      f === "packages/operator-core/lib/agent-tools/facts/list.ts" ||
      f.startsWith(
        "packages/operator-core/lib/coverage-census/attribution/",
      ),
  },
  {
    // EI-22189589517637049 — a tool authoring `guidance.returns` without a
    // registered `result:` schema was caught ONLY by the fleet green-checkpoint,
    // hours later and by a different agent. Measured 2026-09-02: the violation
    // count went 0 -> 2 in a single day (`scheduler:pull_ledger` 18:51Z,
    // `capability:bash_output` 21:45Z), each red-pinning the gate; the live guard
    // had not changed since 08:12Z, so this was a class, not an incident.
    //
    // WIRED REPO-WIDE rather than left to workspace selection because the whole
    // defect is that the signal arrives too late to teach the author. The live
    // authority (guidance-output-schema-live-guard.test.ts) imports the ~900-module
    // tool barrel — ~36s of import for ~24ms of assertions — so it is not something
    // anyone runs while editing one guidance string. This static scan needs no
    // barrel import and answers in well under a second.
    //
    // Safe to wire NOW on the same precedent as the entries below: measured green
    // over the whole real tree FIRST (exit 0, "1217 tool source file(s) scanned,
    // 2 mixed-content tool(s) exempt"), so registering it cannot red-pin the fleet
    // on defects accrued while it slept.
    //
    // TRIGGER SCOPE — the subject is any tool-defining source file under the roots
    // the guard itself enumerates (TOOL_ROOTS), plus the live guard whose
    // NON_OBJECT_RETURN_TOOLS exemptions this one DERIVES from: exempting a tool
    // there must re-run the scan that reads it. Keep this predicate in step with
    // TOOL_ROOTS in scripts/check-guidance-returns-schema.mjs.
    workspace: "@papercusp/operator-core",
    script: "lint:guidance-returns-schema",
    appliesTo: (f) =>
      f === "package.json" ||
      f === "packages/operator-core/package.json" ||
      f === "scripts/check-guidance-returns-schema.mjs" ||
      f ===
        "packages/operator-core/lib/agent-tools/guidance-output-schema-live-guard.test.ts" ||
      ((f.startsWith("packages/operator-core/lib/agent-tools/") ||
        f.startsWith("packages/agent-mcp/src/")) &&
        f.endsWith(".ts") &&
        !f.endsWith(".d.ts") &&
        !/\.test\.tsx?$/.test(f)),
  },
  {
    // EI-19324979765038953 — a comment attributing a PENDING action to an agent
    // session id (e.g. "su-37bf2 is DELETING this entry") reads as "handled" to every
    // later reader and froze `main` for hours when the named session vanished.
    //
    // WIRED REPO-WIDE, not left at test tier, because check-lint-guard-reachability
    // named the exact gap: the guard "enumerates the WHOLE tree but only runs when
    // packages/operator-core is affected" — so the same comment landing in
    // apps/operator would not have been scanned by the suite that owns it.
    //
    // Safe to wire NOW on the precedent below: measured green over the whole real
    // tree FIRST (15,462 files scanned, 0 findings) after fixing the 8 live
    // instances it found, so registering it cannot red-pin the fleet on defects
    // accrued while it slept.
    //
    // TRIGGER SCOPE — the subject is any comment-bearing source file, which is
    // exactly the extension set the guard itself enumerates; keep the two in step.
    workspace: "@papercusp/operator-core",
    script: "lint:no-agent-intent-comments",
    appliesTo: (f) =>
      f === "package.json" ||
      f === "scripts/check-no-agent-intent-comments.mjs" ||
      f === "scripts/lib/agent-intent-comment-patterns.mjs" ||
      /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|sh|bash|py|rs|sql|toml|yml|yaml)$/.test(f),
  },
  {
    // WI-39362 — check-lint-guard-reachability flagged this as the repo's ONLY
    // partially-covered guard: it "enumerates the WHOLE tree but only runs when
    // packages/operator-core is affected", so a pipefail/SIGPIPE regression in any
    // *.sh outside that workspace got no local signal and would first surface as a
    // red FLEET gate. REGISTERED rather than appended to ACKNOWLEDGED_PARTIAL_COVERAGE,
    // which is SHRINK-ONLY by design (check-lint-guard-reachability.mjs).
    //
    // Safe to wire NOW on the same precedent as the entries around it: measured green
    // over the whole real tree FIRST — exit 0, "115 pipefail script(s) scanned, 75
    // shape match(es), none with an unbounded producer" — so registering it cannot
    // red-pin the fleet on defects that accrued while it slept.
    //
    // TRIGGER SCOPE — the guard's subject is `git ls-files -z '*.sh'`, so the only
    // source change that can add an unbounded-producer site is a tracked shell
    // script; keep this predicate in step with that enumeration.
    workspace: "@papercusp/operator-core",
    script: "lint:pipefail-sigpipe",
    appliesTo: (f) =>
      f === "package.json" ||
      f === "packages/operator-core/package.json" ||
      f === "scripts/check-pipefail-sigpipe.mjs" ||
      f.endsWith(".sh"),
  },
  {
    // WI-1472680 — this guard was declared in package.json and run by NOTHING:
    // check-lint-guard-reachability reported it verbatim as "nothing runs it at all".
    // WIRED rather than retired, and the wiring is safe to do NOW because the
    // precondition that guard demands was measured first: a full run over the real
    // tree is green (exit 0, "every harness-naming tool argument is guarded by the
    // hive clamp or explicitly exempt (837 tools)"), so registering it cannot
    // red-pin the fleet on defects accrued while it slept.
    //
    // TRIGGER SCOPE — keyed to the SUBJECT, which is not a file walk. The guard
    // imports agent-tools/index.ts to populate the registry and then reads it via
    // listAllProjectedTools(), so what can regrow a hole is a tool definition or the
    // projection layer, never an arbitrary source file.
    workspace: "@papercusp/operator-core",
    script: "lint:harness-arg-coverage",
    appliesTo: (f) =>
      f === "package.json" ||
      f === "packages/operator-core/package.json" ||
      f === "scripts/check-harness-arg-coverage.ts" ||
      f.startsWith("packages/operator-core/lib/agent-tools/") ||
      f.startsWith("packages/agent-mcp/src/"),
  },
  {
    // WI-1472680 — same finding, same remedy: declared, run by nothing. Measured
    // green over the whole real tree before wiring ("OK — 0 unguarded teardown
    // sites").
    //
    // TRIGGER SCOPE — the guard enumerates `git ls-files -- ROOTS/**/*.integration.test.ts`,
    // so its subject is exactly the integration suites; an edit to one is the only
    // source change that can add an unguarded teardown site.
    workspace: "@papercusp/operator-core",
    script: "lint:integration-teardown-nullsafe",
    appliesTo: (f) =>
      f === "package.json" ||
      f === "packages/operator-core/package.json" ||
      f === "scripts/check-integration-teardown-nullsafe.mjs" ||
      /\.integration\.test\.[cm]?tsx?$/.test(f),
  },
  {
    // WI-1472680 — NOT unreachable but PARTIALLY covered: it enumerates the whole
    // tree (`git ls-files --recurse-submodules`) yet only ran when
    // packages/operator-core was affected, so every assertion it polices outside
    // that workspace went unenforced. Registering here is the remedy the reachability
    // guard names; appending to ACKNOWLEDGED_PARTIAL_COVERAGE is not available — that
    // set is shrink-only and already sits at its watermark of 2, and its own comment
    // says to register the guard instead.
    //
    // TRIGGER SCOPE — deliberately the whole TS family, because that IS the guard's
    // own enumeration. A narrower predicate would recreate the same partial coverage
    // under a different name.
    workspace: "@papercusp/operator-core",
    script: "lint:narrowing-gated-assertions",
    appliesTo: (f) =>
      f === "package.json" ||
      f === "packages/operator-core/package.json" ||
      f === "scripts/check-narrowing-gated-assertions.mjs" ||
      /\.[cm]?tsx?$/.test(f),
  },
  {
    // EI-22176104184812266 — same PARTIAL-COVERAGE class as the entry above, and the
    // sole hard failure of `lint:guard-reachability` when this was wired: the guard
    // "enumerates the WHOLE tree but only runs when packages/operator-core is
    // affected". Its subject is shell scripts, which live overwhelmingly OUTSIDE
    // operator-core (papercusp-desktop/bin, apps/operator/scripts/systemd, scripts/),
    // so the workspace trigger excluded almost everything it polices — a *.sh edit in
    // papercusp-desktop got no local signal and would first surface as a red FLEET gate.
    //
    // Safe to wire NOW on the precedent the entries above set: measured green over the
    // whole real tree FIRST (2026-09-02, "clean — 115 pipefail script(s) scanned, 75
    // shape match(es), none with an unbounded producer", exit 0), so registering it
    // cannot red-pin the fleet on defects accrued while it slept.
    //
    // TRIGGER SCOPE — the guard's own enumeration is `git ls-files -z '*.sh'`, so the
    // predicate is exactly tracked shell scripts plus the guard's own inputs. Keep the
    // two in step: widening the guard's glob without widening this predicate silently
    // recreates the partial coverage this entry exists to close.
    workspace: "@papercusp/operator-core",
    script: "lint:pipefail-sigpipe",
    appliesTo: (f) =>
      f === "package.json" ||
      f === "packages/operator-core/package.json" ||
      f === "scripts/check-pipefail-sigpipe.mjs" ||
      f.endsWith(".sh"),
  },
  {
    // EI-18697393226276295 — `vi.useFakeTimers()` in an integration test whose path reaches
    // unmocked real infra (PG/testcontainers/DBOS) stops that infra's own timers from ever
    // firing, and the suite HANGS: no assertion failure, no error, no output. The original
    // incident needed `kill -9` on the process tree. A failure with zero diagnostic signal
    // cannot be triaged from output, so it has to be prevented at edit time.
    //
    // TRIGGER SCOPE — keyed to the policed surface itself. Unlike the environmental cases
    // below, this damage IS introduced by a source edit (adding the call to a test file),
    // so a changed-path predicate catches it exactly. Plain `*.test.ts` is deliberately NOT
    // a trigger: 188 unit files fake timers correctly and must stay out of this.
    //
    // No hostSuiteRatchet. The operator suite proves the CLASSIFIER falsifiable
    // (fake-timers-integration-guard.test.ts asserts hazards are flagged, the live
    // clock-only call stays silent, and prose is not a call site), but it does not walk the
    // tracked tree — that filesystem scan is this task's job, same as lint:tests.
    workspace: "@papercusp/web",
    script: "lint:no-fake-timers-in-integration",
    appliesTo: (f) =>
      f === "package.json" ||
      // apps/operator/package.json is @papercusp/web's manifest — the one that must
      // DECLARE this script for the registry lookup above to find it. A root-only
      // declaration made the guard silently unroutable (registered, never attached), so
      // an edit to that manifest re-runs it.
      f === "apps/operator/package.json" ||
      f === "scripts/check-fake-timers-in-integration-tests.mjs" ||
      f ===
        "packages/operator-core/lib/__tests__/fake-timers-integration-guard.test.ts" ||
      /\.(?:integration|browser)\.test\.[cm]?tsx?$/.test(f),
  },
  {
    // EI-20863794002653922 — a node_modules entry that EXISTS but is HOLLOW (no readable
    // package.json) is invisible to every other guard here, and surfaces only as an
    // ERR_MODULE_NOT_FOUND naming a path instead of a cause. That is what red-lined the
    // gate in WI-39899: libs/generic/sse/node_modules lost the whole `typescript` package
    // and 3 of vitest's files, so `@papercusp/sse :: test` died before a single test ran
    // and read as a test failure it was not.
    //
    // TRIGGER SCOPE — deliberately narrow, and worth explaining because the obvious wider
    // choice is wrong. The damage is ENVIRONMENTAL: the original incident changed no
    // source file at all, so no appliesTo predicate over changed paths could have caught
    // it, and widening this to "every source file" would buy nothing while adding a
    // 144ms task to every change in the repo. What it CAN catch cheaply is the case where
    // a dependency-shape change lands and the install that followed it went partial — so
    // it is keyed to manifests, the lockfile, and this guard's own files. Catching the
    // no-source-change case belongs in a gate PREFLIGHT (run `npm run lint:partial-install`
    // directly), not in a changed-path predicate.
    //
    // No hostSuiteRatchet: this is a filesystem audit of the checkout, not a property the
    // operator suite can assert for us.
    workspace: "@papercusp/web",
    script: "lint:partial-install",
    appliesTo: (f) =>
      f === "package.json" ||
      f === "package-lock.json" ||
      f === "scripts/check-partial-install.mjs" ||
      f === "packages/operator-core/lib/__tests__/partial-install-guard.test.ts" ||
      /(?:^|\/)package(?:-lock)?\.json$/.test(f),
  },
  {
    // capless-adaptive-resource-governor P-012 — the replacement for capacity-limit
    // lint scans every executable source lane in its inventory. A workspace-local
    // test cannot protect a new start added under apps/, packages/, or scripts/ when
    // operator-core is otherwise unaffected, so route the exact scan surface here.
    workspace: "@papercusp/operator-core",
    script: "lint:resource-governor-enforcement",
    hostSuiteRatchet:
      "packages/operator-core/lib/resource-governor/state-snapshot.test.ts",
    appliesTo: (f) =>
      f === "package.json" ||
      f === "scripts/check-resource-governor-enforcement.mjs" ||
      (/^(?:apps|packages|scripts)\//.test(f) &&
        /\.(?:[cm]?[jt]sx?)$/.test(f) &&
        !/(?:^|\/)(?:_retired|dist|node_modules|public)\//.test(f) &&
        !/(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(f)),
  },
  {
    // WI-1341291 — the P-004 anti-rot gate requires every `category: 'watchdog'`
    // managedSetInterval in the tree to be declared in RECOVERY_MECHANISMS. Its population
    // comes from a filesystem scan over SCAN_ROOTS = packages, libs, apps
    // (recovery-dependency-scan.ts), but the gate itself lives in operator-core — so the
    // population it polices and the workspace that runs it are two different things, and
    // they only coincide by accident.
    //
    // MEASURED divergence (`--print-affected`, 2026-08-30), which is the whole reason this
    // entry exists — the gap is exactly one scan root wide, not general:
    //   packages/operator-core/**            -> operator-core selected  (gate runs)
    //   libs/generic/scheduled-registry/**   -> operator-core selected  (gate runs, via the
    //                                           dependency graph — incidental, not by design)
    //   apps/operator/bin/serve.ts           -> @papercusp/web ONLY     (gate does NOT run)
    // So a watchdog timer added under apps/** is inside the scan population but outside the
    // selection reach: its author gets no local signal, and it reds the gate FLEET-WIDE at the
    // next green-checkpoint for some unrelated agent to diagnose. apps/ is not hypothetical —
    // apps/operator/bin/serve.ts and apps/operator/lib/release/green-checkpoint.ts already
    // register managed timers.
    //
    // Declaring the routing here is what stops scan population and selection reach from
    // drifting apart again, rather than special-casing the one root that happens to be
    // exposed today.
    //
    // hostSuiteRatchet: the gate IS a vitest file in operator-core, so whenever operator-core's
    // full suite is selected the invariant is already re-run and this narrow task is skipped —
    // the apps/**-only change is the sole case that pays for it.
    //
    // TRIGGER SCOPE mirrors the scanner's own walk (SCAN_ROOTS + `.ts`, minus `.test.ts`,
    // `.integration.test.ts`, `.d.ts` and SKIP_DIRS) so the trigger cannot be narrower than the
    // population being policed. Keep the two in step: widening SCAN_ROOTS without widening this
    // predicate silently re-opens the same blind spot.
    workspace: "@papercusp/operator-core",
    script: "lint:recovery-timers-declared",
    hostSuiteRatchet:
      "packages/operator-core/lib/system-health/recovery-dependency-audit.test.ts",
    appliesTo: (f) =>
      f === "package.json" ||
      // operator-core's own manifest is where this script is DECLARED, and the registry
      // lookup above silently drops a guard whose script is missing from it. The
      // lint:no-fake-timers-in-integration entry was already caught by exactly that
      // (registered, never attached), so re-run on a manifest edit.
      f === "packages/operator-core/package.json" ||
      // The scanner's own sources need no line here: both live under packages/**.ts and
      // are already matched by the population predicate below.
      (/^(?:apps|packages|libs)\//.test(f) &&
        /\.ts$/.test(f) &&
        !/\.(?:test|integration\.test|d)\.ts$/.test(f) &&
        !/(?:^|\/)(?:node_modules|dist|build|\.next|target|coverage|\.turbo)\//.test(
          f,
        )),
  },
  {
    // EI-15951 — registry visibility is not execution. A canonical test can
    // match .papercusp/testing-domains.json while every real runner excludes
    // it; that exact hole left tools/eslint-rules tests permanently dead while
    // lint:tests stayed green. The strengthened lint resolves route ownership
    // plus each Vitest config's authoritative include/exclude contract, with
    // explicit Playwright and WebdriverIO contracts.
    //
    // This is a repository invariant rather than an operator-suite assertion:
    // changing ANY canonical test, runner config, workspace manifest, registry
    // projection, or either guard/router implementation can create the hole.
    // Keep it as a narrow task (no hostSuiteRatchet); the operator suite does
    // not execute this filesystem/config audit for us.
    workspace: "@papercusp/web",
    script: "lint:tests",
    appliesTo: (f) =>
      f === ".papercusp/testing-domains.json" ||
      f === "package.json" ||
      f === "package-lock.json" ||
      f.endsWith("/package.json") ||
      f === "apps/operator/scripts/lint-tests.ts" ||
      f === "libs/test-config/src/lane-split.ts" ||
      f === "libs/test-config/src/vitest-config.ts" ||
      f === "packages/operator-core/lib/test-executor-runnability.ts" ||
      f === "packages/operator-core/lib/test-executor-runnability.test.ts" ||
      f === "packages/operator-core/lib/testing-domains-registry.ts" ||
      f === "scripts/gen-testing-domains-contract.ts" ||
      f === "scripts/resolve-vitest-config-contracts.mjs" ||
      f === "scripts/test-files.mjs" ||
      /(^|\/)vitest(?:\.(?:integration|browser))?\.config\.[^/]+$/.test(f) ||
      /(^|\/)playwright\.config\.[^/]+$/.test(f) ||
      /(^|\/)wdio\.conf\.[^/]+$/.test(f) ||
      /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(f),
  },
  {
    // EI-20863794002653922 — a workspace-local Vitest directory survived npm reify
    // without its package.json/entrypoints. The package's own test task then failed
    // before collecting a single test, and test:affected classified the opaque
    // MODULE_NOT_FOUND as a code regression. No changed-path predicate can predict
    // this damage: it is mutable checkout state created outside git, so every affected
    // run must first prove the dependency substrate it is about to execute.
    //
    // Reuse the existing check-declared-deps-extracted detector rather than inventing
    // a gate-only classifier. The host script runs it under npm-install-safe's READ
    // mutex, so a legitimate concurrent reify is allowed to finish instead of being
    // observed halfway through. Healthy-tree cost is bounded to filesystem reads plus
    // the existing lockfile-selected runtime imports; retries occur only on a finding.
    workspace: "@papercusp/operator-core",
    script: "lint:dependency-integrity",
    // Deliberately NO hostSuiteRatchet: operator-core's Vitest suite unit-tests the
    // detector but does not inspect the real tree. Skipping this task when that suite
    // is selected would reopen the exact chicken-and-egg hole for package-local Vitest.
    appliesTo: () => true,
  },
  {
    // EI-21219848570251446 — a plain Vitest config bypasses the shared
    // admin-test-runs reporter, making testing:runs return a clean-looking
    // empty for an unmeasured workspace. This guard scans every declared
    // workspace config, so any config/package/lockfile change can regrow the
    // blind spot even when operator-core itself is not the changed workspace.
    workspace: "@papercusp/operator-core",
    script: "lint:vitest-config-enrollment",
    appliesTo: (f) =>
      f === "package.json" ||
      f === "package-lock.json" ||
      f === "scripts/check-vitest-config-enrollment.mjs" ||
      f ===
        "packages/operator-core/lib/vitest-config-enrollment-guard.test.ts" ||
      /(^|\/)package\.json$/.test(f) ||
      /(^|\/)vitest\.config\.[^/]+$/.test(f),
  },
  {
    // EI-20822558150340173 / D-046 — the substitution registry's DB projection had no
    // automatic caller of ANY kind. `seedSubstitutionRegistry()` is reachable only from
    // the manual `npm run seed:substitutions`, so editing a pair changed nothing about
    // what the PreToolUse gate enforces, indefinitely, while every local signal said the
    // change had shipped: the unit tests pass (they test the pairs), gen:tool-routing:check
    // is clean (CLAUDE.md is generated from the pairs), typecheck is clean, git-sync commits
    // it. MEASURED, not hypothetical: policy-violation:unsafe-dependency-install was widened
    // in code on 2026-08-14 (b97a2df61b) to claim named-package installs, CLAUDE.md has
    // documented that scope ever since, and the DB row still carried the narrower pattern on
    // 2026-08-18 — four days in which the documented block was inert for exactly the case the
    // widening was written to catch.
    //
    // This is the sibling situation to gen:tool-routing exactly: ONE list, TWO projections,
    // and until now only the one with a --check gate stayed correct. So the ungated
    // projection gets the same treatment, routed by the paths that can actually cause the
    // drift.
    //
    // WHY A GUARD AND NOT BOOT-TIME RE-SEEDING (the alternative D-046 weighed): re-seeding
    // on operator boot would make every booting operator a WRITER to the shared workspace's
    // enforcement rows, derived from its own checkout — and this box runs :3070 from the
    // release checkout and :3170/bg-host off the staging tree concurrently, so the live rows
    // would flap with whichever host restarted last. A check has no such blast radius.
    workspace: "@papercusp/operator-core",
    script: "seed:substitutions:check",
    // Exit 2 = EXIT_NOT_CHECKED, which this check returns when Postgres is unreachable
    // (nothing compared ⇒ nothing proved). Non-gating is what makes it safe to run in a
    // DB-less leg, and is the honest half of the bargain: the run is reported as "examined
    // NOTHING" rather than silently passing. It used to exit 0 in that case — a vacuous
    // green in a check whose whole job is to notice that something did not happen — which
    // D-046 fixed as the precondition for wiring it up here at all.
    notCheckedIsNonGating: true,
    // The pairs are the SOURCE the rows are derived from; a change to one is the only thing
    // that can put the registry out of date. Deliberately NOT every bash-substitution file:
    // the seeder reads pairs + their frozen fixtures, and widening this to the whole module
    // would attach a DB round-trip to edits (match.ts, report.ts, census.ts) that cannot
    // drift a row. The fixtures ARE included — a re-frozen sample changes the recomputed
    // verdict, which is a seeded field.
    appliesTo: (f) =>
      f.startsWith("packages/operator-core/lib/bash-substitution/pairs/") ||
      f.startsWith("packages/operator-core/lib/bash-substitution/fixtures/"),
  },
  {
    // WI-39420 (2026-08-16) — lint:di-seam-arity-strands wire-up. The guard scans EVERY
    // tracked .ts/.tsx source in the repo (defaultCandidateFiles in
    // scripts/check-di-seam-arity-strands.mjs), but its enforcing test lives in
    // @papercusp/operator-core — so a DI-seam arity-strand introduced in any OTHER
    // workspace would only be judged when operator-core happened to be independently
    // affected: the partial-enforcement hole check-lint-guard-reachability names.
    // Registering here routes the guard with every changed path it actually covers.
    // --fail blocks on NEW findings only; pre-wiring debt lives in the script's
    // shrink-only FAIL_BASELINE. Cheap: one tsc parse pass over candidate files, no DB.
    workspace: "@papercusp/operator-core",
    // The BASE guard name — the reachability census's coverage credit is an exact-name
    // lookup (`repoWideRegistered.has(row.name)`), and companion spellings like `:fail`
    // are collapsed into the base. operator-core's declaration of this name runs the
    // script in --fail mode (root's stays advisory for hand-runs): enforcement
    // strictness is a property of the enforcement declaration, not of the name.
    script: "lint:di-seam-arity-strands",
    // Exit 2 = EXIT_NOT_CHECKED (zero candidate files). A gate checkout's working diff
    // is empty by construction, so "examined nothing" must not red the gate.
    notCheckedIsNonGating: true,
    // Mirror of the script's own candidate filter: judge the changed path only if the
    // guard would actually scan it.
    appliesTo: (f) =>
      /\.tsx?$/.test(f) &&
      !/\.(test|spec|integration\.test)\.tsx?$/.test(f) &&
      !/(^|\/)(dist|build|node_modules|\.papercusp)\//.test(f) &&
      !f.startsWith("papercup-release/") &&
      !f.startsWith("papercup-checkpoint/"),
  },
  {
    // WI-1728261 (2026-08-31) — lint:deps-wiring-parity wire-up. Identical contract to
    // lint:di-seam-arity-strands above, and registered for the identical reason: the
    // guard enumerates EVERY tracked .ts/.tsx source (defaultCandidateFiles in
    // scripts/check-deps-wiring-parity.mjs) while its enforcing test lives in
    // @papercusp/operator-core, so a deps-seam divergence introduced in any OTHER
    // workspace would only be judged when operator-core happened to be independently
    // affected. check-lint-guard-reachability named exactly that hole on this guard's
    // first run ("enumerates the WHOLE tree but only runs when packages/operator-core
    // is affected"); this entry closes it.
    //
    // The guard's whole point is catching a concern wired at one production entry point
    // and silently missing at another — a defect that has recurred FOUR times in the
    // Scout lane alone — so scanning tree-wide while only ever RUNNING on one
    // workspace's changes would reproduce the very asymmetry it exists to detect.
    workspace: "@papercusp/operator-core",
    // The BASE guard name: the reachability census credits coverage by exact-name
    // lookup and collapses `:fail`-style companions into it. operator-core's
    // declaration of this name runs the script in --fail mode; root's stays advisory
    // for hand-runs. --fail blocks on NEW findings only — the 33 rows measured at
    // wiring time live in the script's shrink-only FAIL_BASELINE.
    script: "lint:deps-wiring-parity",
    // Exit 2 = EXIT_NOT_CHECKED (zero candidate files); a gate checkout's working diff
    // is empty by construction, so "examined nothing" must not red the gate.
    notCheckedIsNonGating: true,
    // Mirror of the script's own candidate filter, including the __tests__/__mocks__
    // exclusion this guard adds (it is deliberately production-vs-production only —
    // a FIXTURE omitting a seam is lint:optional-seam-strands' subject, not this one).
    appliesTo: (f) =>
      /\.tsx?$/.test(f) &&
      !/\.(test|spec|integration\.test)\.tsx?$/.test(f) &&
      !/(^|\/)(dist|build|node_modules|\.papercusp|__tests__|__mocks__)\//.test(f) &&
      !f.startsWith("papercup-release/") &&
      !f.startsWith("papercup-checkpoint/"),
  },
  {
    // EI-20551144708194616 — three guards that police papercusp-desktop/bin/*.sh live in
    // apps/operator (@papercusp/web), and the router's path->workspace map sends those two
    // to DISJOINT workspaces. Measured:
    //   papercusp-desktop/bin/release-local.sh              -> AFFECTED_WS @papercusp/desktop
    //   apps/operator/lib/release/<any of these>.test.ts    -> AFFECTED_WS @papercusp/web
    // So each guard ran only when apps/operator changed — precisely when its subject had NOT
    // moved. The one change that would reintroduce the regression was the one change that did
    // not run the test: the confidence of coverage with none of the coverage.
    //
    // These are invariants over SHELL SCRIPTS, not unit tests of a workspace's code, so
    // attaching them here (rather than relocating them into @papercusp/desktop) is the
    // faithful fix — the subject and its guard now route together no matter which workspace
    // a change selects. Each failure class is measured in whole release cuts: a signing-key
    // regression destroyed a tri-platform cut ~35 min in, and the rootfs/versionName ordering
    // regressions each fail the whole cut from inside a leg, ~10 min in. A fourth guard
    // (parallel-leg-supervisor) pins the CONCURRENT supervision that keeps such a failure
    // from also reaping its still-building siblings (EI-20549139616021387).
    workspace: "@papercusp/web",
    script: "test:release-script-guards",
    // Cheap by construction: all three are pure file READS + string assertions — no DB, no
    // network, no build — so this is runnable in GitHub CI exactly as it is here. Vitest exits
    // 1 when a named path matches nothing (verified: `passWithNoTests` is NOT set on this
    // script), so renaming a guard file fails loudly instead of silently guarding nothing.
    //
    // NO hostSuiteRatchet, deliberately — the fail-safe direction. @papercusp/web's own `test`
    // task does re-run these three files, but a ratchet is only honest when the guard's subject
    // and its host suite are selected by the SAME change, and here they are selected by disjoint
    // ones: that disjointness is the entire defect being fixed. Declaring a ratchet would let a
    // papercusp-desktop/bin change skip the guard on the strength of a suite that change does not
    // run — reintroducing the hole in a subtler form. (The registry test enforces this: it
    // rejected a ratchet naming a file outside the host workspace's own package.)
    appliesTo: (f) => f.startsWith("papercusp-desktop/bin/"),
  },
  {
    // WI-5472 — the SAME disjointness defect as the entry directly above, one directory over.
    // The guard's subject is papercusp-desktop/bin/lib/federation-asserts.sh; the guard itself
    // lives in @papercusp/operator-core (alongside the sibling desktop-shell guards, e.g.
    // live-federation-gate-k3-cut-verdict.test.ts). Measured 2026-08-17:
    //   papercusp-desktop/bin/lib/federation-asserts.sh -> AFFECTED_WS @papercusp/desktop
    //   packages/operator-core/lib/<this guard>.test.ts -> AFFECTED_WS @papercusp/operator-core
    // Disjoint, so without this entry the guard runs only when operator-core changes for some
    // unrelated reason — i.e. never when its subject actually moves.
    //
    // ⚠ The test CANNOT simply be relocated into @papercusp/desktop: that package is not in the
    // root `workspaces` list, so nothing under it is selected or run by the root vitest at all.
    // Attaching it here is the only way subject and guard travel together.
    //
    // The invariant: fed_hive_merge_probe / fed_coord_merge_probe must reach their 0/1 verdict
    // under `set -u` with RIG_HIVE_ID unset. When they do not, they die on an unbound `ws`, every
    // caller's `$( ... || true )` swallows it, and the federation-merge assertions read FAIL
    // whether or not federation works — a false RED that costs whole debugging sessions on the
    // transport layer, which is fine.
    workspace: "@papercusp/operator-core",
    script: "lint:federation-assert-nounset",
    // Cheap by construction: sources the shell lib with drv_psql stubbed — no PG, no network, no
    // sleeps (both probes short-circuit before their poll loops). 542ms measured. No
    // `--passWithNoTests`, so renaming the guard file fails loudly instead of guarding nothing.
    //
    // NO hostSuiteRatchet, deliberately — same reasoning as the entry above: operator-core's own
    // `test` task does re-run this file, but subject and host suite are selected by DISJOINT
    // changes, and that disjointness is the entire defect being fixed here. A ratchet would let a
    // federation-asserts.sh edit skip the guard on the strength of a suite that edit never runs.
    appliesTo: (f) => f === "papercusp-desktop/bin/lib/federation-asserts.sh",
  },
  {
    // EVL P-006 (expensive-verification-loops-2026-09-29, R-10/R-11) — the verification-harness
    // contract lint and the adoption test live in operator-core, but their SUBJECTS are the slow
    // harness scripts under scripts/ and papercusp-desktop/bin/ (plus llm-test.ts and the
    // contract lib). Those route to other workspaces, so without this entry a NEW slow harness
    // added without the contract (the R-10 falsifier) would never run the lint that forbids it.
    // Cheap: file reads, plus one bash + tsx planner dry-run per adopted shell harness.
    // NO hostSuiteRatchet, same reasoning as the entries above: subject and host suite are
    // selected by disjoint changes.
    workspace: "@papercusp/operator-core",
    script: "lint:vh-contract",
    appliesTo: (f) =>
      /^scripts\/[^/]+\.(sh|mjs|mts|ts)$/.test(f) ||
      /^papercusp-desktop\/bin\/(vm-rig\/)?[^/]+\.(sh|mjs|mts|ts)$/.test(f) ||
      f === "apps/operator/bin/llm-test.ts" ||
      f.startsWith("libs/generic/verification-harness/") ||
      f.startsWith("packages/operator-core/lib/verification-harness/") ||
      f === "packages/operator-core/lib/llm-testing/battery-harness.ts",
  },
  {
    // goal-live-holder-guarantee-2026-08-18 P-001 / D-003 — lint:no-raw-goal-holder-read.
    // The guard scans EVERY tracked .ts/.mjs in the repo for a raw read of "who holds this
    // goal" that skips the liveness fold, but its enforcing test lives in
    // @papercusp/operator-core. Without this entry, a bypass introduced in agent-mcp, the
    // sidecar, or a HUD model would only be judged when operator-core happened to be
    // independently affected — the partial-enforcement hole check-lint-guard-reachability
    // names, and precisely the hole that let the fold exist in two system-health sweeps and
    // nowhere else for the surfaces a human actually looks at.
    //
    // Cheap: pure text scan of tracked files, no tsc, no DB, no network.
    workspace: "@papercusp/operator-core",
    script: "lint:no-raw-goal-holder-read",
    // Mirror of the script's own isExcluded filter: judge a changed path only if the guard
    // would actually scan it.
    appliesTo: (f) =>
      /\.(ts|mjs|cjs)$/.test(f) &&
      !/\.(test|spec)\.[cm]?tsx?$/.test(f) &&
      !/(^|\/)(dist|build|node_modules|_retired|db-sql|env-sidecars)\//.test(
        f,
      ) &&
      !f.startsWith("papercup-release/") &&
      !f.startsWith("papercup-checkpoint/"),
  },
  {
    // WI-39608 — the guard that keeps `scripts/mutation-probe.sh`'s copy-paste EXAMPLE
    // runnable. Its three subjects do NOT route together: the two shell scripts select
    // @papercusp/operator-core (so the guard's own suite runs), but the test the example
    // NAMES lives under apps/operator/lib and selects @papercusp/web. Measured:
    //   scripts/mutation-probe.sh                            -> AFFECTED_WS @papercusp/operator-core
    //   scripts/verify-tauri-headless.sh                     -> AFFECTED_WS @papercusp/operator-core
    //   apps/operator/lib/verify-tauri-headless-bind-retry.test.ts -> AFFECTED_WS @papercusp/web
    // So deleting the PROBE_SCRIPT read from that test — i.e. reintroducing the exact
    // defect WI-39608 fixed — was the one change the guard would not have run for.
    //
    // The failure this prevents is not a broken example, it is a FALSE VERDICT ABOUT A
    // GUARD: with `{}` substituted into an env var nothing consumes, the probe measures
    // the unmutated tracked file and reports "mutant SURVIVED" for a guard that is fine.
    workspace: "@papercusp/operator-core",
    script: "lint:mutation-probe-example",
    // Cheap by construction: pure file reads + regex assertions — no DB, no network, no
    // subprocess, no build. 11ms measured. No `--passWithNoTests`, so renaming the guard
    // file fails loudly instead of silently guarding nothing.
    //
    // NO hostSuiteRatchet, deliberately — same reasoning as the two entries above.
    // operator-core's own `test` task does re-run this file, but the subject that most
    // needs the guard (the named test) is selected by a DISJOINT change, and that
    // disjointness is the entire hole being closed. A ratchet would let that edit skip
    // the guard on the strength of a suite the edit never runs.
    //
    // WI-39623 added the 4th subject. The guard now judges the PROJECTED copy of the
    // example too (in the composed corpus), and a projection lands as an ordinary edit to
    // that generated file — so without this entry the one change that rots the projected
    // copy would again be the change the guard does not run for. That is exactly the hole
    // the three entries above exist to close, one file further along the pipeline.
    appliesTo: (f) =>
      f === "scripts/mutation-probe.sh" ||
      f === "scripts/verify-tauri-headless.sh" ||
      f === "apps/operator/lib/verify-tauri-headless-bind-retry.test.ts" ||
      f ===
        "packages/operator-core/lib/doc-projection/claude-md-corpus.generated.md",
  },
  {
    // EI-20687080717457981 — the guard that keeps CLAUDE.md's "which commit carries your
    // change" command actually printing UTC. Same disjointness hole as the entry above,
    // one doc further along: the guard lives in operator-core, but its SUBJECT is the
    // PROJECTED doc, and a projection lands as an edit to `CLAUDE.md` /
    // `claude-md-corpus.generated.md` — neither of which is a `.tsx?` file, so the
    // workspace-selection rule cannot attach operator-core for it. Without this entry the
    // one change that can reintroduce the defect (re-editing the part, then projecting)
    // is the change the guard would not run for.
    //
    // The defect is worth a machine because it is INVISIBLE to review: `TZ=UTC git log
    // ... --format='%cI'` renders the COMMIT's own offset (`-04:00` here) and ignores TZ
    // entirely, so the output looks exactly like a UTC ISO-8601 stamp and is silently 4h
    // off. Every commit in this repo carries the box's own -04:00, so only a synthetic
    // foreign-offset commit can tell the two hypotheses apart — which is why the guard
    // builds one rather than asserting against real history.
    workspace: "@papercusp/operator-core",
    script: "lint:git-log-utc-claim",
    // Cheap by construction: file reads + one throwaway `git init` in os.tmpdir(), no DB
    // and no network. ~92ms measured. It shells out to `git`, which is a hard dependency
    // of every other guard here already.
    //
    // NO hostSuiteRatchet, deliberately — same reasoning as the entry above. operator-core's
    // own `test` task does re-run this file, but the subject that most needs the guard (the
    // projected doc) is selected by a DISJOINT change, and that disjointness is the hole.
    appliesTo: (f) =>
      f === "CLAUDE.md" ||
      f ===
        "packages/operator-core/lib/doc-projection/claude-md-corpus.generated.md",
  },
  {
    // EI-19341315235545734 — the guard that keeps CLAUDE.md's run/test section routing
    // AGENTS at `scripts/verify-tauri-headless.sh` rather than at the launch that opens a
    // window on the owner's live desktop. Same disjointness hole as the two entries above:
    // the guard lives in operator-core, its SUBJECT is the projected doc, and the change
    // that reintroduces the defect is a doc-part edit + projection — an edit to `CLAUDE.md`
    // / `AGENTS.md` / the corpus, none of which is a `.tsx?` file, so the workspace-selection
    // rule cannot attach operator-core for it.
    //
    // The defect is worth a machine because every individual sentence stays TRUE while it
    // regresses: `npm run dev` really is how you launch the desktop. What decays is which
    // command an agent copies FIRST, and on this box the wrong one inherits DISPLAY=:1 —
    // the owner's real desktop (WI-2648: synthetic input leaked into a real email draft;
    // WI-7101: a second `tauri dev` killed the owner's live desktop).
    workspace: "@papercusp/operator-core",
    script: "lint:headless-verify-entrypoint",
    // Cheap by construction: three file reads plus one `verify-tauri-headless.sh --help`,
    // which prints usage and exits 0 without booting Xvfb, cargo, or a sidecar. Measured
    // warm 2026-08-31: 44ms of test time, 381ms vitest duration — the same order as the
    // git-log entry above (66ms / 395ms), whose 6.4s wall clock is npm + vitest startup
    // that every entry in this list pays identically.
    //
    // NO hostSuiteRatchet, deliberately — same reasoning as the two entries above.
    // operator-core's own `test` task does re-run this file, but the subject that most needs
    // the guard (the projected doc) is selected by a DISJOINT change.
    appliesTo: (f) =>
      f === "CLAUDE.md" ||
      f === "AGENTS.md" ||
      f === "scripts/verify-tauri-headless.sh" ||
      f ===
        "packages/operator-core/lib/doc-projection/claude-md-corpus.generated.md",
  },
  {
    // WI-38089. See declarationMjsInputs() above for the measurement and the derive-vs-mirror
    // rationale.
    workspace: "@papercusp/operator-core",
    // ~6.1s measured (3 runs, warm): a `tsc --emitDeclarationOnly` into a temp dir, then a
    // byte-compare of 42 files. The most expensive entry in this list, which is why `appliesTo` is
    // the narrowest possible set — the declared inputs themselves — rather than every `.mjs`.
    script: "lint:declarations-fresh",
    // The ratchet is real: generated-declarations.test.ts execs the SAME `--check` invocation, so
    // when operator-core's own suite runs, this has genuinely already executed.
    hostSuiteRatchet:
      "packages/operator-core/lib/generated-declarations.test.ts",
    appliesTo: (f) => {
      // Adding an input without generating its `.d.mts` is a config edit, not a source edit, and
      // `--check` reports it as `missing` rather than `stale` — so the config itself must attach.
      if (f === DECLARATIONS_CONFIG) return true;
      const declared = declarationMjsInputs();
      if (!declared) return /\.mjs$/.test(f) || /\.d\.mts$/.test(f);
      if (declared.has(f)) return true;
      // Hand-editing a generated `.d.mts` is drift in the opposite direction: the committed
      // declaration no longer matches what the generator would emit.
      return (
        f.endsWith(".d.mts") && declared.has(f.replace(/\.d\.mts$/, ".mjs"))
      );
    },
  },
  {
    // WI-7025 — a TypeScript import of a real `.mjs` with neither a generated declaration
    // nor an explicit suppression is TS7016. `check-unenrolled-mjs-imports.mjs` already
    // scans the whole tree and its test contains a real-tree ratchet, but before this entry
    // it ran only when operator-core happened to be affected. A new import in apps/ or a
    // checked-out submodule therefore stayed green through test:affected and first red the
    // shared gate's later typecheck.
    //
    // The detector's subject is every non-retired TS/TSX source, not only files that currently
    // import `.mjs`: a new import can be introduced in any one of them. The config and both
    // files that define the detector's inputs/coverage also attach because changing either can
    // alter the verdict without changing a TS importer.
    workspace: "@papercusp/operator-core",
    script: "lint:no-unenrolled-mjs-imports",
    // check-unenrolled-mjs-imports.test.ts runs scan() over the real tree, so a host suite run
    // genuinely re-executes this invariant and should not pay for the narrow task twice.
    hostSuiteRatchet:
      "packages/operator-core/lib/__tests__/check-unenrolled-mjs-imports.test.ts",
    appliesTo: (f) =>
      ((f.endsWith(".ts") || f.endsWith(".tsx")) &&
        !f.endsWith(".d.ts") &&
        !f.includes("node_modules/") &&
        !f.includes("_retired/")) ||
      f === DECLARATIONS_CONFIG ||
      f === UNENROLLED_MJS_IMPORTS_DETECTOR ||
      f === UNENROLLED_MJS_IMPORTS_FILE_ENUMERATOR,
  },
  {
    // WI-1399902 — the served-docs completeness/freshness guard. Agents read the SERVED twin
    // under /internal/docs; a source page without its twin is a silent 404, and a twin whose
    // content predates its source hands the reader the exact instruction the edit was written
    // to delete. `lint:docs-mirror` detects both and, until now, ran on no blocking path.
    //
    // ⚠ SAME SHAPE AS lint:workspace-deps-complete ABOVE — "already enforced" is true and
    // irrelevant. .github/workflows/test.yml runs it, but git-sync stamps every commit
    // `[skip ci]` (measured 2026-08-31: 232 of the last 200 commit messages/bodies carry it),
    // and GitHub honors that marker for BOTH `push` and `pull_request` — so the two triggers
    // have never fired on a real advance (EI-18661485259809120). green-checkpoint dispatches
    // the workflow explicitly, but only AFTER it fast-forwards `main`: post-promotion. The
    // other caller is operator-docs' own `build:inner`, which runs the detector at the END of
    // a rebuild — i.e. only in the one state where it cannot fail. A check that runs only
    // after the repair it would demand is decoration.
    //
    // MEASURED, and the turnover is the finding: filed 2026-08-30T23:33Z naming 2 missing
    // pages; re-measured 2026-08-31T12:41Z — still red, but with 4 DIFFERENT pages, the
    // original 2 having been fixed by an unrelated rebuild. A completely fresh population in
    // ~13h is what continuous unattended drift looks like. The rebuild that cleared it also
    // rewrote 959 twins whose CONTENT had gone stale (build-system/vms.md was still serving
    // `nohup bash boot-windows.sh` against a source that had moved to a systemd unit).
    //
    // No hostSuiteRatchet: check-docs-mirror.test.ts exercises the detector's mapping rules
    // against FIXTURE trees and never execs it over the real corpus, so no suite run implies
    // this has executed — which is precisely why the tree stayed red behind a green suite.
    workspace: "@papercusp/operator-core",
    // 0.21-0.22s (3 runs measured 2026-08-31) — a pure fs walk, cheaper than every guard here.
    script: "lint:docs-mirror",
    // Both directions. Source: a page ADDED without a rebuild has no twin, and a page EDITED
    // without one leaves the twin stale. Served root: the OTHER direction — deleting a twin
    // breaks the pairing without touching a single source file. The detector itself attaches
    // because a change to the mapping rules re-judges all 959 pages at once.
    appliesTo: (f) =>
      f.startsWith(`${DOCS_MIRROR_SOURCE_ROOT}/`) ||
      f.startsWith(`${DOCS_MIRROR_SERVED_ROOT}/`) ||
      f === DOCS_MIRROR_DETECTOR,
  },
  {
    // WI-38239 — the drift detector for the PG-canonical authored-doc corpus (plan
    // claude-md-projection-from-pg-2026-08-10). `scripts/project-authored-docs.ts` called this
    // "a GATE" in its own header while NOTHING invoked it, and the cost was measured twice in
    // one day: four projected docs hand-edited and drifted ~20h before anyone noticed, then
    // testing/agent-e2e.mdx drifted AGAIN ~5h later. Both surfaced only by a hand-run command.
    //
    // Keyed on the CONTENT PATHS rather than on the projector, because the change this must
    // catch is a hand-edit to a projected doc — the projector itself is usually untouched when
    // the corpus drifts. The projector + its config attach too: a change to how projection is
    // computed can drift all 873 files at once without any doc being edited.
    //
    // Narrow by design, and that narrowness is what makes it proportionate: it fires ONLY when
    // a projected doc actually changes. A legitimate projector write leaves the file matching
    // its PG row, so the check passes; the only red it can produce is a genuine hand-edit,
    // whose remedy is one command (`--ingest --reconcile`, which preserves the edit into PG
    // rather than clobbering it).
    //
    // Runnable off-box by construction: `--check` SKIPS cleanly (exit 0, and it says it checked
    // nothing) when Postgres is unreachable, so attaching it here does not fail every GitHub CI
    // run — see the no-DB degrade note in project-authored-docs.ts. That degrade is what makes
    // registration honest rather than a permanently-red leg the fleet learns to ignore.
    workspace: "@papercusp/operator-core",
    script: AUTHORED_DOC_GUARD_SCRIPT,
    // No hostSuiteRatchet: authored-doc-projection.test.ts unit-tests the projection HELPERS,
    // it never execs `--check` over the real corpus, so no suite run implies this has executed.
    appliesTo: (f) =>
      f.startsWith(`${AUTHORED_DOCS_ROOT}/`) ||
      f === AUTHORED_DOC_PROJECTOR ||
      f === AUTHORED_DOCS_CONFIG,
  },
  {
    // EI-20272515693397454 — the SAME class as the entry above, one table over. There
    // `harness_docs.content` is canonical and the .mdx is the projection; here
    // `harness_doc_parts` is canonical and CLAUDE.md / AGENTS.md are the projections.
    // `gen:client-docs:check` is the only thing that asserts projected == on-disk, and it
    // ran on NO blocking path: a hand-edit to the generated CLAUDE.md JAMS the projector
    // (it correctly refuses to overwrite bytes it did not write), and that jam is both
    // sticky and SILENT — until someone happens to run the projector, no CLAUDE.md rule
    // change can be projected by anyone. One such jam sat undetected from 2026-08-12 to
    // 2026-08-16 and was cleared only because an unrelated agent tripped over it.
    //
    // ⚠ The reachability census does NOT catch this one: it credits the guard tier=`test`
    // because three doc-projection unit tests `import` symbols from
    // scripts/project-doc-parts.mjs — while their own headers state "NOTHING HERE READS
    // THE LIVE CLAUDE.md OR A DATABASE". Importing a guard's helpers is not running the
    // guard, so the census reported ENFORCED for a leg nothing ran. Filed separately.
    //
    // Runnable off-box by construction, and that is NEW here: `connect()` used to sit
    // outside the try, so an unreachable Postgres exited 1 with a stack trace. The check
    // path now SKIPS cleanly (exit 0, saying it checked nothing) — while --write and
    // --write-corpus still throw, because a mutation that silently no-ops against a
    // missing DB is worse than a loud failure.
    workspace: "@papercusp/operator-core",
    script: "gen:client-docs:check",
    // No hostSuiteRatchet, deliberately: project-doc-parts.test.ts and
    // load-claude-md-doc-parts.test.ts are fixture-only by their own stated design, and
    // doc-corpus.test.ts compares the committed corpus against the committed MANIFEST —
    // never the on-disk client files against a composition of the live rows. Declaring a
    // ratchet off those suites is exactly the phantom this registry forbids.
    appliesTo: (f) =>
      f === "CLAUDE.md" ||
      f === "AGENTS.md" ||
      f ===
        "packages/operator-core/lib/doc-projection/claude-md-corpus.generated.md" ||
      // A change to HOW projection is computed can drift every projected file at once
      // without any of them being edited.
      f === "scripts/project-doc-parts.mjs",
  },
  {
    // D-017/P-019 — deterministic carry-respawn pushes recovery into the
    // successor context. Reintroducing an unconditional first-call orient adds
    // one redundant full fold to every compaction and can double-run fallback
    // recovery. This source-tree guard is cheap and global across canonical
    // non-generated producer/prompt roots; it includes positive + negative
    // controls so a regex that silently stops firing cannot report green.
    workspace: "@papercusp/operator-core",
    script: "lint:post-compaction-recovery-contract",
    appliesTo: (f) =>
      f.startsWith("packages/operator-core/lib/") ||
      f.startsWith("apps/operator/prompts/") ||
      f.startsWith(
        "libs/papercusp/packages/harness/blueprints/base/prompts/",
      ) ||
      f === "scripts/check-post-compaction-recovery-contract.ts" ||
      f === "scripts/affected-tests.mjs",
  },
  {
    // WI-38239 — `gen:compaction:check` was one of the 8 orphaned `gen:*:check` guards the
    // census widening exposed (it ran on NO blocking path). It is the ONLY real-tree assertion
    // that the shipped compaction floor renders: compaction-strategy.test.ts exercises
    // renderCompactionStrategy over `mkdtemp` FIXTURES only, so a suite pass says nothing about
    // whether the actual `apps/operator/prompts/papercusp-compaction.base.md` still renders.
    //
    // That gap is not hypothetical. This is the file every psu session's compaction floor is
    // built from, and both failures it detects are silent today. MEASURED against a COPY of the
    // real prompts dir (tier-2 probe, tree untouched), the two branches are NOT symmetric:
    //   - missing/empty base  → renderer returns '' → exit 1. Reachable from CONTENT, and the
    //     install then writes NO strategy at all. Proven: deleting the base flipped the verdict
    //     while the unmutated copy passed.
    //   - PAPERCUSP-COMPACTION:CLIENT-OVERLAY marker survives → exit 1. NOT reachable from
    //     content — spliceAtMarker is `split(marker).join(content)`, so it replaces EVERY
    //     occurrence (a planted duplicate marker did not survive). This branch fires only if the
    //     splice implementation itself regresses, which is why splice-tooling-overlay.ts is in
    //     `appliesTo` below rather than the prompts alone.
    //
    // Cheap by construction: a two-file read + a string splice, no DB and no network, so it is
    // runnable in GitHub CI exactly as it is here.
    workspace: "@papercusp/operator-core",
    script: "gen:compaction:check",
    // No hostSuiteRatchet: compaction-strategy.test.ts is fixture-only (mkdtemp) and never
    // references gen-compaction.ts, so no suite run implies this has executed over the real
    // prompts dir. Declaring one would be the phantom ratchet the registry test forbids.
    appliesTo: (f) =>
      f === "apps/operator/prompts/papercusp-compaction.base.md" ||
      f === "apps/operator/prompts/papercusp-compaction.claude.md" ||
      f === "scripts/gen-compaction.ts" ||
      // The renderer and the splice/marker it depends on — the "overlay marker survived" half
      // of the check is a property of these two files, not of the prompts.
      f === "packages/operator-core/lib/desktop-install/papercusp-files.ts" ||
      f ===
        "packages/operator-core/lib/desktop-install/splice-tooling-overlay.ts",
  },
  {
    // WI-38239 — `gen:knowledge-packs:check`, same orphan cohort. The builtin packs' shared
    // items must stay byte-identical to their canonical `coding` source (sync-map.json);
    // hand-editing a mirror silently strands the other side.
    //
    // MEASURED, and it is why this is registered UNCONDITIONALLY rather than ratcheted:
    // pack-sync.test.ts asserts the same invariant over the real tree, and a pack edit does
    // today pull @papercusp/operator-core in (probed: editing knowledge-packs/work/*.md selects
    // it). But that coverage is an artifact of the dependency graph, not a declared premise —
    // precisely the assumption whose quiet breakage this registry already recorded once
    // (declaring @papercusp/db-org on operator-core silently disabled lint:migration-forward-compat).
    // A ratchet is also unavailable honestly: pack-sync.test.ts RE-IMPLEMENTS the comparison
    // rather than exercising gen-knowledge-packs.mjs, so the ratchet assertion would reject it.
    // Attaching unconditionally is the fail-safe direction that test's own message prescribes,
    // and the duplicate cost is a handful of file reads.
    workspace: "@papercusp/operator-core",
    script: "gen:knowledge-packs:check",
    appliesTo: (f) =>
      f.startsWith("libs/papercusp/packages/harness/knowledge-packs/") ||
      f === "scripts/gen-knowledge-packs.mjs",
  },
  {
    // EI-22373464081881716 — `gen:gitnexus-bridge:check` verifies that the shipped CommonJS
    // plugin artifact still matches the TypeScript source. The generator is declared in the
    // root package only, while the affected-tests registry executes workspace-owned scripts;
    // without this alias and route, the runtime-artifact parity test existed but could not
    // run from a change to the nested plugin submodule.
    //
    // The superproject reports any edit inside `libs/papercusp` as its bare gitlink path, so
    // that root is intentionally part of the trigger set. The generator, registry, and
    // workspace manifest are also included because each can change what this check enforces.
    workspace: "@papercusp/operator-core",
    script: "gen:gitnexus-bridge:check",
    appliesTo: (f) =>
      f === "libs/papercusp" ||
      f === "scripts/gen-gitnexus-bridge-runtime.mjs" ||
      f === "scripts/affected-tests.mjs" ||
      f === "packages/operator-core/package.json",
  },
  {
    // WI-2144666 — `gen:su-decomposition:check` verifies that the committed su identity
    // part documents and the pinned COMPOSITION_MODEL.md section still derive byte-for-byte
    // from the canonical su.md + tiling. The guard was declared only in root package.json,
    // but this registry executes workspace-owned scripts; exposing the same check through
    // operator-core makes the existing invariant reachable without adding a second checker.
    //
    // Measured 2026-09-05: the check passes on the current tree, is DB/network-free, and
    // completes in under one second. It is therefore safe to attach narrowly to every
    // source or derived file that can change the generator's result.
    workspace: "@papercusp/operator-core",
    script: "gen:su-decomposition:check",
    appliesTo: (f) =>
      f === "package.json" ||
      f === "packages/operator-core/package.json" ||
      f === "scripts/affected-tests.mjs" ||
      f === "libs/papercusp/packages/orchestrator/bin/gen-su-decomposition.ts" ||
      f === "libs/papercusp/packages/orchestrator/src/blueprint/su-decomposition.ts" ||
      f === "libs/papercusp/packages/orchestrator/src/blueprint/slots.ts" ||
      f === "libs/papercusp/packages/harness/paths.ts" ||
      f === "libs/papercusp/packages/orchestrator/docs/COMPOSITION_MODEL.md" ||
      f.startsWith("libs/papercusp/packages/harness/blueprints/"),
  },
  {
    // WI-38239 — `gen:tool-catalog:check`, the last WIRE-able member of the orphaned `gen:*:check`
    // cohort the census widening exposed. It guards `.papercusp/tool-catalog.json`, the 1.1MB
    // projection of the `defineTool` registry (docs-and-memory-as-projections D-002).
    //
    // TRACKED-VS-IGNORED DECIDES WIRE-VS-RETIRE, and here it decided AGAINST the generator's own
    // header: this generator and its openapi sibling BOTH claimed the artifact was "NOT committed"
    // — the sibling citing this one BY NAME as its justification. Measured against the tree that is
    // false (`git ls-files` returns it; `git check-ignore` does not), so a genuinely committed
    // artifact carries a genuine drift invariant. The openapi sibling was RETIRED on the opposite
    // measurement: that artifact IS gitignored, and `--check` treats a missing file as stale, so
    // wiring it would have red-pinned every fresh checkout. Two headers agreeing with each other is
    // not corroboration when one inherits from the other — verify against the tree.
    //
    // THE INVARIANT WAS ALREADY VIOLATED WHEN THIS ENTRY WAS WRITTEN, which is the case for wiring
    // it rather than an argument for it: the committed catalog was missing FOUR tools that exist in
    // the registry (db:migrations, issues:list, testing:runs, work_items:stranded) plus a batch of
    // edited descriptions/guidance. Nothing reported it, and the repo's own CLAUDE.md routing table
    // already documented three of the four as available to agents.
    //
    // The cost objection in that header — "it cold-imports the full ~300-tool registry" — is the
    // only real one, and it does not survive measurement: ~10s (3 runs: 10.2 / 9.6 / 10.6), 3/3
    // completions, idempotent (regenerate, then `--check` exits 0). It needs NO database and no
    // network — against a dead PG port with an empty PAPERCUSP_HOME it still exits 0 in 10.6s — so
    // it is runnable in GitHub CI exactly as it is here (the import registers definitions; pools
    // open lazily and nothing queries).
    workspace: "@papercusp/operator-core",
    script: "gen:tool-catalog:check",
    // No hostSuiteRatchet: nothing execs gen-tool-catalog.ts, and the only repo references to it
    // are the scaffold tool's instructional text. Declaring one would be the phantom ratchet the
    // registry test forbids.
    appliesTo: (f) =>
      // All 12 randomly sampled catalog entries define under agent-tools/; endpoint-route
      // contributes none (every one of the 729 entries carries BOTH an MCP name and an http path).
      // `.test.ts` is excluded deliberately — a test beside a tool registers nothing.
      (f.startsWith("packages/operator-core/lib/agent-tools/") &&
        !f.endsWith(".test.ts")) ||
      // The projection surface itself: `listAllProjectedTools` and `defineTool` decide WHAT is
      // projected and WHICH fields land, so a change here can move all 729 entries at once with no
      // tool file edited.
      (f.startsWith("packages/agent-mcp/src/") && !f.endsWith(".test.ts")) ||
      (f.startsWith("libs/generic/tooldef/src/") && !f.endsWith(".test.ts")) ||
      f === "scripts/gen-tool-catalog.ts" ||
      // Drift in the other direction: a hand-edit to the generated artifact.
      f === ".papercusp/tool-catalog.json",
  },
  {
    // WI-38239 — `gen:fleet-lessons:check`, the LAST of the eight orphaned `gen:*:check` guards.
    // It mirrors the machine-local curated fleet-lessons pack into the committed copy that ships.
    //
    // ⚠ READ THIS BEFORE TRUSTING A RED FROM IT. Wiring was blocked until 2026-08-13 by a real
    // defect, not by cost: the exporter copied the curated pack VERBATIM while the committed copy
    // had been backfilled to OKF v0.2 (okf_version / type:) by scripts/okf-backfill-packs.mjs. So
    // `--check` reported 4 files "differ" and told the reader to run the writer — and running it
    // would have STRIPPED those fields and turned `lint:okf-conformance` (which scans this exact
    // directory) RED. Two guards over the same files, each prescribing a state the other rejects,
    // with the red one prescribing the break. gen-fleet-lessons.ts now applies the OKF addition ON
    // EXPORT (okfExportBody), so what ships is conformant whatever the curated side holds and the
    // remedy this guard names is safe to run. Do NOT revert that without re-opening this question.
    //
    // The message's stated direction was also wrong and is worth distrusting on sight: it says the
    // committed copy is BEHIND, and the measured diff was the committed copy AHEAD by one metadata
    // line per file.
    //
    // HONEST LIMIT — what this canNOT catch: the drift that matters most is the fleet ADOPTING
    // knowledge into the curated pack, which changes NO repo file, so no path-triggered guard ever
    // fires for it. That case wants a scheduled sweep. What this DOES catch is a hand-edit to the
    // committed pack and a change to the exporter itself — worth having, and not to be quoted as
    // "the shipped pack is verified current".
    //
    // Cheap and off-fleet-safe by construction: ~1.5s (2 runs: 1.50 / 1.45), and with no shared
    // knowledge-packs root it prints "nothing to export (ok)" and exits 0 — so a CI runner or a
    // fresh clone, which has no curated pack, passes rather than red-pinning.
    workspace: "@papercusp/operator-core",
    script: "gen:fleet-lessons:check",
    // No hostSuiteRatchet: no test execs gen-fleet-lessons.ts, so no suite run implies this has
    // executed over the real pack.
    appliesTo: (f) =>
      f.startsWith(
        "libs/papercusp/packages/harness/knowledge-packs/fleet-lessons/",
      ) ||
      f === "scripts/gen-fleet-lessons.ts" ||
      // The OKF normalizers the exporter now depends on — a change to what they add changes what
      // this guard considers conformant output.
      f === "scripts/okf-backfill-packs.mjs" ||
      f === "scripts/okf-backfill-insights.mjs",
  },
  {
    // WI-38312 — `lint:sidecar-fallback-reported` (EI-20281745253229841) shipped enforcing
    // NOTHING: its only coverage was a logic-test of its predicate over fixtures, so
    // lint:guard-reachability went red for every agent whose change mapped into
    // operator-core — an unattributed `failed=1` with zero failing FILES, which reads as
    // "your change broke something" and sends each of them hunting in their own diff.
    //
    // It scans every tracked .ts, so anchoring it to operator-core's suite alone would
    // rebuild the same blind spot one level down: a bad fallback added in ANY other
    // workspace gets no local signal and first surfaces as a red fleet gate.
    //
    // Cost: ~0.8s (measured, 3 warm runs: 0.73/0.79/0.86). It was ~13s until this entry
    // forced the question — it read all 5,434 eligible files when only 6 mention a sidecar
    // entrypoint. A `git grep -l -F` prefilter does that selection in the index. The verdict
    // is unchanged BY MEASUREMENT, not by argument: git grep missed 0 of the 6 files an
    // exhaustive read found, and masking can only ever REMOVE matches, so the grep is a
    // strict superset of what the masked check can accept.
    workspace: "@papercusp/operator-core",
    script: "lint:sidecar-fallback-reported",
    // The ratchet is real: the guard's own test execs this SAME script over the real
    // tree, so when operator-core's suite runs it has genuinely already executed.
    hostSuiteRatchet:
      "packages/operator-core/lib/fleet/sidecar-fallback-reported-guard.test.ts",
    // Mirrors the guard's own eligibility filter — an unreported fallback can only be
    // introduced by a non-test .ts source, or by editing the guard/allowlist itself.
    appliesTo: (f) =>
      f === "scripts/check-sidecar-fallback-reported.mjs" ||
      (f.endsWith(".ts") &&
        !f.endsWith(".test.ts") &&
        !f.endsWith(".integration.test.ts") &&
        !f.includes("/dist/") &&
        !f.includes("node_modules")),
  },
  {
    // EI-19454727576364875 — a `lint:*` script is declared in a package.json, so editing a
    // package.json is the single edit that can ORPHAN a guard (add a script and wire it nowhere;
    // rename one a runner invokes by name; delete one a gate leg expects). The meta-guard that
    // detects exactly that already existed and was reachable only from a root npm script, i.e.
    // from nothing that any edit selects.
    //
    // ⚠ Registering it here was IMPOSSIBLE-IN-EFFECT until the early-exit ordering bug above was
    // fixed: root `package.json` maps to no workspace, so the guard loop was unreachable for the
    // very file this entry is keyed on. Registration would have looked correct and done nothing —
    // which is why the item it closes had concluded the only remedy was to route package.json to
    // a workspace and pay a whole suite for every root edit.
    workspace: "@papercusp/operator-core",
    script: "lint:guard-reachability",
    // No hostSuiteRatchet: no test file execs this detector, so it attaches unconditionally —
    // the fail-safe direction, and cheap because appliesTo is package.json-only.
    appliesTo: (f) => f === "package.json" || f.endsWith("/package.json"),
  },
  {
    // EI-21082046676950143 — `lint:declared-consumed` is a fast, precise guard (~12s, prints
    // "24 consumed · 0 UNCONSUMED"), but it was reachable only from a root npm script. Editing
    // a policed interface therefore selected NOTHING, and adding e.g. an optional field to
    // CellSpec surfaced only ~14 min later, inside test:lane-pure's declared-consumed-sweep.
    // Same orphaned-guard shape lint:guard-reachability above exists to catch.
    //
    // The policed paths are DERIVED from the guard's own registries (`declaringPaths()`),
    // never restated here (CLAUDE.md, derived-truth ladder rung 1). A hardcoded copy would
    // drift in the SILENT direction: the next field declared under a NEW `declaredIn`, or a
    // column added by a new migration, would quietly stop selecting this guard — which is
    // precisely the failure this entry closes, so re-introducing it one layer up would be
    // self-defeating. Both halves matter: DECLARED_FIELDS is 9 of the 24 policed rows, so a
    // fields-only key would look wired while missing most of the guard's own surface.
    //
    // ⚠ The entry alone is NOT sufficient: the runner execs `script` INSIDE `workspace`, so
    // it must also be declared in packages/operator-core/package.json. It was root-only until
    // this fix, and an entry naming a script its workspace does not declare registers cleanly
    // and does NOTHING — the same orphaned-guard shape again, one layer further up.
    workspace: "@papercusp/operator-core",
    script: "lint:declared-consumed",
    // No hostSuiteRatchet: declared-consumed-sweep.test.ts execs this detector only from a
    // slow lane, so attaching unconditionally is the fail-safe direction — and it is cheap,
    // being an exact-path membership test over a couple of dozen declaring files.
    appliesTo: (f) => DECLARED_CONSUMED_PATHS.has(f),
  },
  {
    // EI-20098997113620795 — `attributeFailedTask` must be able to name a failing FILE for every
    // test RUNNER the repo actually runs. Twice it could not, and neither time did anything fail:
    // an unreadable runner returns no file rows, which maps to the reason `no-file-rows`, whose
    // documented causes are "a worker crash, an OOM, a spawn error". So a red reported plausible
    // INFRASTRUCTURE while the failing file sat named in plain text a few lines up.
    //
    // Registered repo-wide because the TRIGGER is not a change to the attributor — it is a
    // workspace changing what it RUNS. Measured: `--changed-paths papercusp-desktop/package.json`
    // selects `@papercusp/desktop` and nothing else, so a workspace adopting a new runner would
    // never have selected the guard that exists to catch exactly that. Keying on package.json is
    // therefore the whole point; narrowing to "files that look test-related" would rebuild the
    // blind spot one level down, the same argument no-undrained-stdout-exit makes above.
    workspace: "@papercusp/operator-core",
    script: "lint:attributor-runner-coverage",
    // The ratchet IS the guard: this file is a plain vitest test inside operator-core's own
    // suite, so when that suite runs it has genuinely already executed — not assumed.
    hostSuiteRatchet:
      "packages/operator-core/lib/__tests__/attributor-runner-coverage.test.ts",
    appliesTo: (f) =>
      f === "package.json" ||
      f.endsWith("/package.json") ||
      f === "scripts/affected-tests.mjs" ||
      f === "scripts/lib/vitest-summary.mjs" ||
      f === "scripts/lib/test-runner-classes.mjs",
  },
  {
    // EI-20055889379250637 — `console.log(<unbounded>); process.exit()` truncates
    // through a PIPE (measured: only ~8 KiB escapes; a TTY and a `> file` redirect are
    // both synchronous and therefore fine). It is registered repo-wide for the same
    // reason as chunk-safe below: the defect appears when someone adds a `--json` mode
    // or an accumulating write to ANY CLI, and nobody knows in advance which file that
    // will be. Narrowing to "files that already print JSON" would rebuild the blind
    // spot one level down.
    workspace: "@papercusp/operator-core",
    script: "lint:no-undrained-stdout-exit",
    // The ratchet inside operator-core's suite EXECS the guard over REPO_ROOT (the
    // `describe('the tree is currently clean (ratchet)')` case), so deferring to the
    // host suite is genuinely safe here rather than assumed.
    hostSuiteRatchet:
      "packages/operator-core/lib/undrained-stdout-exit-guard.test.ts",
    appliesTo: (f) => /\.[cm]?[jt]sx?$/.test(f),
  },
  {
    // EI-20070078750133139 — the D-034 shape, 7th instance. `lint:no-raw-spawn` enumerates
    // the WHOLE tracked tree (every .ts outside _retired/node_modules/dist/*.test.ts) but its
    // only enforcement point was a vitest file in operator-core, so a bypass introduced
    // anywhere else got no local signal at all.
    //
    // It surfaced now rather than earlier because the census got MORE accurate, not because
    // the guard changed: EI-20064929206355679 made the shared stripper an AST parse, which
    // promoted this guard from "logic-test only" to enforced-but-partially-covered. A true
    // new finding — so the remedy is registration, NOT an append to
    // ACKNOWLEDGED_PARTIAL_COVERAGE (that set is shrink-only and says so).
    workspace: "@papercusp/operator-core",
    // The standalone SCRIPT. ⚠ operator-core did not DECLARE this script until this change —
    // a registration naming a workspace that lacks the script is INERT (silently skipped at
    // :815 while scoring as fully enforced), which is the exact trap WI-37454 found and now
    // fails on. The package.json declaration is half of this fix, not incidental to it.
    script: "lint:no-raw-spawn",
    // COST, measured before registering (this registry's own standing instruction). The guard
    // was ~11.8-12.1s — 50x what the entries here normally cost — because the AST stripper
    // above parses every scanned file. A provably-sound raw-text pre-filter in the guard
    // (skip files not containing `buildInvokeOnce`; blanking only removes text, so it cannot
    // hide a hit) brought it to ~0.95s, which is the same order as the guards already here.
    // Registering it at 12s would have taxed every fleet-wide test:affected run touching a
    // .ts file, so the pre-filter is what makes this entry affordable rather than a
    // regression traded for coverage.
    hostSuiteRatchet:
      "packages/operator-core/lib/dbos/no-raw-spawn-guard.test.ts",
    // MIRRORS `isExcluded` in scripts/check-no-raw-agent-spawn.mjs — deliberately copied
    // rather than narrowed: the predicate must match what the guard actually scans, and the
    // asymmetry (predicate wider or narrower than the scan) is the defect this registry
    // exists to prevent.
    appliesTo: (f) =>
      /\.ts$/.test(f) &&
      !f.endsWith(".test.ts") &&
      !f.startsWith("_retired/") &&
      !f.includes("/_retired/") &&
      !f.includes("/node_modules/") &&
      !f.includes("/dist/"),
  },
  {
    workspace: "@papercusp/operator-core",
    script: "lint:chunk-safe",
    // The guard script IS a vitest file in operator-core, so the host suite re-runs it
    // by construction — the one case where the skip needs no separate ratchet.
    hostSuiteRatchet: "packages/operator-core/lib/child-output-guard.test.ts",
    // Every TS-family source file: the guard's own enumeration is repo-wide, so
    // narrowing this to "files that spawn children" would re-create the blind
    // spot one level down — the point is that nobody knows in advance which file
    // is about to grow a stream accumulator.
    appliesTo: (f) => /\.[cm]?tsx?$/.test(f),
  },
  {
    // WI-9434 — the same shape as chunk-safe, one instance later. The lint's own
    // ratchet (`the tree is currently aligned`) execs it over the repo, but that
    // ratchet is a vitest file in operator-core, so it ran ONLY when operator-core
    // was independently affected — while the lint SCANS four roots. MEASURED:
    //   --changed-paths apps/operator/lib/release/green-checkpoint.ts
    //       -> AFFECTED_WS @papercusp/web        (3 of the 4 scanned roots escape)
    // A misaligned `->>` landing in apps/operator/lib therefore produced no local
    // signal and would first surface as a red FLEET gate.
    workspace: "@papercusp/operator-core",
    // The standalone SCRIPT (0.57-0.60s measured), NOT the 20-test vitest file
    // (7.66s — vitest startup dominates). The narrow task only needs the RATCHET
    // "does the tree violate the invariant"; the discrimination tests that prove the
    // detector works already run inside operator-core's own suite.
    script: "lint:partial-index-alignment",
    // `describe('the tree is currently aligned (ratchet)')` execs the SAME script over
    // REPO_ROOT inside operator-core's suite, so deferring to it is genuinely safe.
    hostSuiteRatchet:
      "packages/operator-core/lib/partial-index-alignment-guard.test.ts",
    appliesTo: (f) =>
      f === PARTIAL_INDEX_SCHEMA_FILE ||
      (/\.[cm]?tsx?$/.test(f) &&
        PARTIAL_INDEX_SOURCE_ROOTS.some((r) => f.startsWith(`${r}/`))),
  },
  {
    // WI-9573 / EI-20208711931756460 — the D-034 shape a THIRD time, and the most expensive instance yet.
    // lint:migration-forward-compat had NO local enforcement point at all: it was invoked
    // only by green-checkpoint (apps/operator/lib/release/green-checkpoint.ts), so a
    // migration author got zero signal and the violation first surfaced as a red FLEET
    // gate hours later, blocking every agent. That is not hypothetical — on 2026-08-03 it
    // red-pinned the gate for 4 consecutive runs on migrations 750/751/752/754/755, and
    // three other sessions hit the same wall independently the same day (see also
    // EI-19409083906144989, EI-19407054630567497).
    //
    // A .sql migration also maps to NO workspace test suite, so unlike the two guards
    // above there was no partial coverage to widen — the local signal was entirely absent.
    workspace: "@papercusp/operator-core",
    // The standalone script (~0.1s: it readdirs one directory and regex-scans 65 files).
    script: "lint:migration-forward-compat",
    appliesTo: (f) => {
      const isMigrationArtifact =
        f.startsWith(`${MIGRATION_SQL_DIR}/`) &&
        (f.endsWith(".sql") ||
          f.endsWith(".sql.DRAFT") ||
          f.endsWith(".sql.PENDING-CODE-DEPLOY"));
      const isSourceConsumer = MIGRATION_SOURCE_ROOTS.some(
        (root) => f.startsWith(`${root}/`) && /\.[cm]?[jt]sx?$/.test(f),
      );
      return isMigrationArtifact || isSourceConsumer;
    },
  },
  {
    // EI-20820551755839769 — the live-schema half of the prose-vector contract was a
    // correct detector with no route from the change class it polices. A migration can
    // add a harness_shared vector column at the stale width, while every unit test stays
    // green; this integration test is the only guard that enumerates the schema produced
    // by the committed migrations and rejects an unaccounted vector column.
    //
    // Run ONLY that contract, not operator-core's whole integration tier. The focused
    // target still uses vitest.integration.config.ts, so it receives the baseline-schema
    // globalSetup and measures the real migrated catalog.
    workspace: "@papercusp/operator-core",
    script: "test:integration:prose-vector-dims",
    appliesTo: (f) =>
      f.startsWith(`${MIGRATION_SQL_DIR}/`) &&
      (f.endsWith(".sql") ||
        f.endsWith(".sql.DRAFT") ||
        f.endsWith(".sql.PENDING-CODE-DEPLOY")),
  },
  {
    // WI-10004160 — the federated-column drift guard is the only check that a column added
    // to a federated CDC table is either carried by the federation mapper or declared
    // machine-local. It is an integration test, so the unit-layer operator-core task never
    // ran it and the local gate never passes `--integration`: it went unrun from 2026-08-29
    // to 2026-09-30 while 16 columns on 4 tables landed undeclared (7 of them the mig-1111
    // acceptance-BAR seed, which is what surfaced it — WI-10004146).
    //
    // Trigger on the two sides of the contract: a migration (adds the column) and the
    // mapper/projections (carry it), plus the test and the seams that can detach it.
    workspace: "@papercusp/operator-core",
    script: "test:integration:federated-column-completeness",
    appliesTo: (f) =>
      (f.startsWith(`${MIGRATION_SQL_DIR}/`) &&
        (f.endsWith(".sql") ||
          f.endsWith(".sql.DRAFT") ||
          f.endsWith(".sql.PENDING-CODE-DEPLOY"))) ||
      f === "packages/operator-core/lib/sync/hyperbee/feature-issue-op-keys.ts" ||
      (f.startsWith("packages/operator-core/lib/sync/hyperbee/projections/") &&
        /\.ts$/.test(f) &&
        !/\.test\.ts$/.test(f)) ||
      f === "packages/operator-core/lib/sync/hyperbee/__tests__/federated-column-completeness.integration.test.ts" ||
      f === "packages/operator-core/package.json" ||
      f === "packages/operator-core/vitest.integration.config.ts" ||
      f === "scripts/affected-tests.mjs",
  },
  {
    // WI-2141163 — P-003's real-Postgres queue recurrence suite was never reached by
    // the local green-checkpoint: operator-core's ordinary task is unit-layer and the
    // broad `test:integration` task is opt-in behind `--integration`, which the local
    // gate does not pass. Keep the remedy focused to the queue contract rather than
    // turning every affected run into the infeasible full integration sweep.
    //
    // The queue test imports `admission.ts` and `queue.ts`, builds its schema from the
    // shared work-item fixture, and applies migration 986 directly. The superproject
    // reports edits inside `libs/papercusp` as its bare gitlink, so both that shape and
    // the explicit nested path are covered. No hostSuiteRatchet is declared: the unit
    // suite deliberately excludes `*.integration.test.ts` and cannot replace this proof.
    workspace: "@papercusp/operator-core",
    script: "test:integration:resource-governor-queue",
    appliesTo: (f) =>
      f === "package.json" ||
      f === "packages/operator-core/package.json" ||
      f === "packages/operator-core/vitest.integration.config.ts" ||
      f === "scripts/affected-tests.mjs" ||
      f === "packages/operator-core/lib/resource-governor/admission.ts" ||
      f === "packages/operator-core/lib/resource-governor/queue.ts" ||
      f === "packages/operator-core/lib/resource-governor/queue.integration.test.ts" ||
      f === "packages/operator-core/test/_pg-helpers.ts" ||
      f === "packages/operator-core/test/_work-items-schema.ts" ||
      f === "libs/papercusp" ||
      f === `${MIGRATION_SQL_DIR}/986-resource-governor-work-item-queue-identity.sql`,
  },
  {
    // EI-23210600888560844 — sessions:read's private-Postgres regression suite was
    // present and green, but the ordinary operator-core task intentionally excludes
    // `*.integration.test.ts`, while the broad `test:integration` task is opt-in and
    // is not part of the main promotion command. Without this focused route, changes
    // to the SQL reader could pass the local gate while the only regression proof slept.
    //
    // Keep the trigger set to the reader's implementation/test seam plus the fixture,
    // integration config, package script, and runner that can silently detach it.
    // The sessions:search and filter modules are included because read.integration.test.ts
    // imports them through the public search→read composition; unrelated sessions tools
    // must not pay the private-Postgres test cost.
    workspace: "@papercusp/operator-core",
    script: "test:integration:sessions-read",
    appliesTo: (f) =>
      f === "package.json" ||
      f === "packages/operator-core/package.json" ||
      f === "packages/operator-core/vitest.integration.config.ts" ||
      f === "scripts/affected-tests.mjs" ||
      f === "packages/operator-core/lib/agent-tools/sessions/read.ts" ||
      f === "packages/operator-core/lib/agent-tools/sessions/read.integration.test.ts" ||
      f === "packages/operator-core/lib/agent-tools/sessions/_shared.ts" ||
      f === "packages/operator-core/lib/agent-tools/sessions/search.ts" ||
      f === "packages/operator-core/lib/agent-tools/search/filters.ts" ||
      f === "packages/operator-core/test/_pg-helpers.ts",
  },
  {
    // WI-4311 — the D-034 shape again, with the most delayed discovery of the set.
    // The canonical fix (WITH (FORCE) in makeDrop(), libs/test-config/src/pg-migrate.ts)
    // landed 2026-07-12, but four hand-rolled teardown sites kept the old
    // terminate-then-plain-drop shape and were found 22 DAYS later. Nothing local
    // flagged them, and nothing could: the offending file's own suite passes — the
    // damage is ~88 backends parked in DROP DATABASE state on the SHARED test
    // container, which surfaces as OTHER agents' CONNECT_TIMEOUTs. A violation whose
    // cost lands entirely on somebody else's test run is the exact profile this
    // registry exists for.
    workspace: "@papercusp/operator-core",
    // The standalone script (~1.0s measured, 3 runs — the same order as lint:chunk-safe
    // above, which this list already accepts at that price).
    script: "lint:drop-database-force",
    hostSuiteRatchet:
      "packages/operator-core/lib/drop-database-force-guard.test.ts",
    // Every TS-family file, for chunk-safe's stated reason: narrowing to "files that
    // currently talk to postgres" would re-create the blind spot one level down, and
    // the bug being guarded IS a NEW file hand-rolling its own teardown.
    appliesTo: (f) => /\.[cm]?tsx?$/.test(f),
  },
  {
    // WI-39630 — the D-034 shape, but the violation is INDEX-shaped rather than
    // source-shaped, which is why it went unseen across SEVENTEEN submodules at once.
    //
    // A path both tracked in the index AND matched by .gitignore is a contradiction git
    // settles as "tracked wins", so the ignore rule silently goes inert. Nothing errors
    // and no source file looks wrong — every affected submodule already had
    // `node_modules/` in its .gitignore, which is precisely why reading .gitignore files
    // could never have found it. Once peer npm churn deletes those files, they surface as
    // ` D` rows, git-sync hands git an explicit pathspec for an ignored path, git refuses
    // ("use -f"), and that repo's ENTIRE sync leg dies every tick — measured 2026-08-17 at
    // ~6,500 tracked paths and 16 consecutive failing ticks on dock-workbench.
    //
    // That cost profile is the registry's whole reason for existing: the offending repo's
    // own suite passes perfectly while EVERYONE's commits stop reaching :3070.
    workspace: "@papercusp/operator-core",
    // The standalone script (0.61s measured, 3 runs — between lint:partial-index-alignment's
    // 0.57-0.60s and lint:drop-database-force's ~1.0s, both already accepted here).
    script: "lint:no-tracked-node-modules",
    // Deliberately NO hostSuiteRatchet. tracked-node-modules-guard.test.ts exercises the
    // PREDICATE against injected listers — it never execs the guard against the real tree,
    // so it cannot re-run this invariant in-suite. Declaring a ratchet here would assert
    // exactly the kind of unverified premise EI-20026978310669562 was filed for. Absent a
    // ratchet the guard attaches unconditionally, which is the fail-safe direction and
    // affordable at 0.61s.
    // Deliberately EVERY changed path. Unlike its siblings there is no source pattern that
    // predicts this violation — it is armed by a `git add -f`, or by vendoring in a
    // submodule whose upstream committed its node_modules, neither of which need touch a
    // file this run would otherwise select. Narrowing by extension would reproduce the
    // exact blind spot that let 17 repos arrive here undetected.
    appliesTo: () => true,
  },
  {
    // WI-10002064 — the same INDEX-shaped D-034 violation as lint:no-tracked-node-modules
    // above, one layer in: not a directory that should never be tracked anywhere, but
    // build output tracked by a package that cannot even load it.
    //
    // packages/agent-mcp/dist/ tracked 144 files while package.json routed every
    // entrypoint to ./src/*. Unreachable by construction, so it drifted: dist/_bulk.js
    // kept returning the hard-coded `{ ok: true, ... }` envelope for 13 days after
    // src/_bulk.ts replaced it with `ok: failed === 0` — re-teaching, to a grep and to
    // the next reader, the exact false-success contract that removal retired. 66 of the
    // files were .d.ts that the current build config (`declaration: false`) cannot emit
    // at all. Nothing errored, and no source file looked wrong.
    workspace: "@papercusp/operator-core",
    // The standalone script (0.36-0.50s measured, 3 runs — cheaper than
    // lint:no-tracked-node-modules' 0.61s, already accepted here).
    script: "lint:no-tracked-src-entry-dist",
    // Deliberately NO hostSuiteRatchet, though one would be DEFENSIBLE here: unlike its
    // sibling, tracked-src-entry-dist-guard.test.ts does exec the guard against the real
    // tree. Declining it anyway is the fail-safe direction — a ratchet would make the
    // standalone leg depend on one test case continuing to exist, and silently drop the
    // invariant if a later edit weakened it. At 0.4s that insurance is free.
    // Deliberately EVERY changed path, for the sibling's stated reason: no source pattern
    // predicts this violation. It is armed by `git add -f`, by a build run that gets
    // swept into a commit, or by a package MOVING (the second instance found here lived
    // in the libs/generic/tooldef-http submodule, whose superproject ignore rule pointed
    // at a `packages/` path that no longer existed). None need touch a file this run
    // would otherwise select.
    appliesTo: () => true,
  },
  {
    // EI-22201289307647151 — the same D-034 shape as lint:no-tracked-node-modules just
    // above, one boundary over: a superproject .gitignore rule does not reach inside a
    // submodule, so 22 of 38 coverage-capable submodules had no local `coverage/` ignore
    // rule (one of them, libs/papercusp, already had 10 raw V8 coverage JSON files
    // TRACKED from an earlier accidental sweep). `--coverage` is opt-in today, so the
    // first tree-wide run to use it would sweep a generated report into every one of
    // those repos via git-sync — same class as EI-22195215129102176 (74 files /
    // +54,104 lines swept), just multiplied across every affected submodule at once.
    workspace: "@papercusp/operator-core",
    script: "lint:submodule-coverage-ignore",
    // Deliberately NO hostSuiteRatchet, for the same reason as lint:no-tracked-node-
    // modules directly above: submodule-coverage-ignore-guard.test.ts exercises the
    // PREDICATE against injected maps, never the real tree, so it cannot re-run this
    // invariant in-suite.
    // Deliberately EVERY changed path. Nothing about ADDING a submodule, or a submodule
    // gaining its first package.json/Cargo.toml, needs to touch a file this run would
    // otherwise select — narrowing by extension would reproduce the exact blind spot
    // that let 22 repos arrive here with no local rule.
    appliesTo: () => true,
  },
  {
    // EI-7667 — the D-034 shape again, and the reason this guard exists at all.
    // lint:no-unthreaded-apply SCANS packages/ libs/ apps/ for production call sites of
    // the hyperbee op-apply seam that fail to thread `ownLogKeyHex`, but its enforcement
    // point is a vitest file in operator-core. `applyOpVia` is DEFINED in operator-core,
    // so a new un-threaded call site there is caught by workspace selection alone — while
    // one in apps/ or libs/ importing that seam can leave operator-core unaffected and
    // escape entirely. Registering closes exactly that leg.
    //
    // Why the escape matters more here than the usual "a red lands later": an un-threaded
    // apply is invisible in BOTH the logs and the database (it restamps a remote row as a
    // local write with a newer-than-wire clock, so the genuine op then loses every LWW
    // compare and the record stays permanently shadowed). It survived four gate runs and
    // three wrong diagnoses on the p2p rig for that reason — this is a defect class the
    // fleet gate would NOT reliably surface, so local enforcement is the real backstop.
    workspace: "@papercusp/operator-core",
    // The standalone script (0.62-0.65s measured, 3 runs — between lint:partial-index-
    // alignment's 0.57-0.60s and lint:drop-database-force's ~1.0s, both accepted here).
    // Not the vitest file: the narrow task only needs the tree ratchet, and the controls
    // proving the detector can still fail already run inside operator-core's own suite.
    script: "lint:no-unthreaded-apply",
    // Mirrors ROOTS in scripts/check-no-unthreaded-apply.mjs — if that scan ever widens,
    // this must follow or the guard silently stops firing on the new root (the same
    // "green because it stopped checking" shape MIGRATION_SQL_DIR is annotated for).
    appliesTo: (f) =>
      /\.[cm]?tsx?$/.test(f) &&
      UNTHREADED_APPLY_SOURCE_ROOTS.some((r) => f.startsWith(`${r}/`)),
  },
  {
    // okf-frontmatter-adoption-2026-08-08 P-006 — the D-034 shape, this time for a
    // CONTENT corpus rather than a source one, which makes the escape total rather
    // than partial. MEASURED before wiring:
    //   --changed-paths <an agent-insights doc>   -> AFFECTED_WS @papercupai/operator-docs
    // and that workspace runs no suite covering the corpus, so an insight doc that
    // drops `type:` (or writes an unparseable `stale_after:`) produced NO local signal
    // whatsoever. The pack half is worse in kind: those files are written by CODE
    // (plan D-003), so the corpus can regress with no author involved at all and the
    // first notice would be a red on files nobody edited.
    workspace: "@papercusp/operator-core",
    // The standalone script (~1.0s measured — the same order as lint:chunk-safe and
    // lint:drop-database-force, both already accepted at that price). The narrow task
    // only needs the tree RATCHET; the discrimination tests proving the detector can
    // still fail live in docs-engine's own suite (okf-conformance.test.ts).
    script: "lint:okf-conformance",
    hostSuiteRatchet:
      "packages/operator-core/lib/okf-conformance-guard.test.ts",
    // Mirrors isOkfScannedFile() in check-okf-conformance.mjs: the two corpus roots,
    // the three extensions it opens, and the dot-path exclusion (Astro's loader never
    // sees those, so the lint does not judge them and routing on them would spend the
    // fleet's edit budget on a finding impossible by construction).
    appliesTo: (f) =>
      OKF_SCAN_ROOTS.some((r) => f.startsWith(r)) &&
      !f.split("/").some((seg) => seg.startsWith(".")) &&
      (f.endsWith(".md") ||
        f.endsWith(".mdx") ||
        /(^|\/)manifest\.ya?ml$/.test(f)),
  },
  {
    // WI-37454 — the D-034 shape again, caught as a LATENT gate red rather than a live one.
    // lint:no-retired-resurrection enumerates the WHOLE superproject index, but its only
    // enforcement point is a vitest file in operator-core
    // (packages/operator-core/lib/retired-resurrection-guard.test.ts), so it ran only when
    // operator-core was independently affected. `lint:guard-reachability` scored it
    // PARTIALLY COVERED and — being a blocking green-checkpoint leg — exited 1 at HEAD.
    //
    // It had not red-pinned the gate YET only because the lint legs are skipped once the
    // gate has already halted (`haltedBy ? null : …`, green-checkpoint.ts:5095): the
    // 10:01:04Z verdict was held by 6 test files, so the lint legs never ran. Those files
    // were already passing at HEAD, so the next clean run would have reached this leg and
    // red-pinned on it — the same surprise as WI-10589's "imminent gate red".
    workspace: "@papercusp/operator-core",
    // The standalone script (212/248/221ms measured over 3 runs) — the same order as
    // lint:chunk-safe and lint:drop-database-force, both already accepted at that price.
    // The narrow task only needs the tree RATCHET; the discrimination tests that prove the
    // detector can still fail live in operator-core's own suite.
    script: "lint:no-retired-resurrection",
    // EVERY tracked path, deliberately unnarrowed. The guard reads `git ls-files -s` with
    // no extension filter and matches on BLOB SHA (findResurrections in
    // check-retired-resurrection.mjs), so a resurrection is a content-identity fact about
    // any two paths — one under `_retired/`, one live — regardless of file type. Narrowing
    // this to a source-extension set (as chunk-safe's comment warns) would re-create the
    // blind spot one level down: a resurrected .css/.json/.md would escape the very guard
    // whose whole purpose is that nobody knows in advance which file gets un-retired.
    appliesTo: () => true,
  },
  {
    // EI-19971915610840229 — the SIBLING of the resurrection guard above, and it had
    // the same gap for longer. CLAUDE.md's retired-surfaces section closed with the
    // flat assertion "`lint:no-retired` guards re-imports", while NOTHING invoked the
    // script: it sat on the acknowledged-unreachable list in
    // check-lint-guard-reachability.mjs, doc-asserted and unenforced. A doc promising
    // a guard that never runs is worse than no guard, because it is quoted as
    // evidence — an agent re-importing a `_retired/` module reads that sentence and
    // concludes the boundary is being watched.
    //
    // Verified clean at wiring time (`npm run lint:no-retired` → exit 0, "no live
    // imports of _retired/ modules and no retired orchestrator-spawn fetch"), so
    // registering it cannot red anyone's loop on pre-existing debt.
    workspace: "@papercusp/operator-core",
    // ~1.39s over 3 runs — the same order as lint:chunk-safe (~1.0s), already
    // accepted here. It walks tracked sources via listTrackedFiles, which recurses
    // into all submodules (WI-6730).
    script: "lint:no-retired",
    // The TS/JS family the guard itself filters to (`/\.(ts|tsx|mjs|cjs|js)$/` in
    // check-no-retired-imports.mjs). Matched to the scan rather than to a workspace:
    // the guard reads the WHOLE tree including submodules, so enforcing it only when
    // operator-core happens to be affected is exactly the D-034 partial-coverage
    // shape the reachability checker flags.
    appliesTo: (f) => /\.(?:tsx?|[cm]?js)$/.test(f),
  },
  {
    // WI-37445 — and the point of this one is that it is the D-034 shape's MIRROR IMAGE.
    // The other entries are guards whose VIOLATIONS escape workspace selection. This guard
    // exists because a whole failure CLASS does: adding a runtime export strands every test
    // that mocks the module with an enumerating `vi.mock` factory, and `test:affected`
    // cannot select those tests even in principle — the diff touches the source module while
    // the file that breaks names it only inside a string literal. So the guard that reports
    // the gap must not be selected by the same mechanism that has the gap.
    workspace: "@papercusp/operator-core",
    // ~440ms typical, ~605ms worst case (3 runs measured; the worst case is the one that
    // actually walks the test corpus, which only happens when an export was added).
    // Cheaper than lint:chunk-safe and lint:okf-conformance, both accepted here at ~1.0s.
    script: "lint:vimock-export-strands",
    // ADVISORY — being registered here is what makes it SPEAK, printing the trigger into the
    // run of whoever added the export.
    //
    // ⚠ This comment used to read "it always exits 0, so it can never red the gate" — the
    // invariant that made registering it safe. WI-37806 broke it (correctly: a run that
    // examined nothing must not report success) without updating this entry, which ARMED a
    // fleet-wide gate red that had not fired yet only because the gate's checkout still ran
    // the older copy. A guard's exit contract is part of its REGISTRATION, not a private
    // detail — change one and this entry has to move with it.
    notCheckedIsNonGating: true,
    // The runner owns the authoritative diff base. Without forwarding it, this guard
    // defaults to HEAD and becomes NOT_CHECKED as soon as git-sync commits the edit
    // that selected it.
    forwardBase: true,
    // The same exact-path attribution as required-field-strands. In particular, a
    // superproject diff represents every submodule-internal edit as the bare gitlink path;
    // the guard expands that root against the forwarded base inside the owning repository.
    forwardChangedPaths: true,
    // Production TS-family files, plus submodule roots — the only changed-path shape under
    // which a runtime export added inside one of the 39 submodules reaches this registry.
    // Test/spec files are deliberately excluded: the guard skips them because their own
    // exports are not mocked production surfaces. Scheduling one would therefore guarantee
    // EXIT_NOT_CHECKED and turn an otherwise-green test-only affected run non-green.
    appliesTo: (f) =>
      (/\.[cm]?tsx?$/.test(f) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(f)) ||
      gitmodulePaths().has(f),
  },
  {
    // WI-38401 / EI-20020054576584970 — the sibling of the entry above, and the same
    // MIRROR-IMAGE shape: adding a REQUIRED field to an exported interface strands every
    // DEPENDENT that constructs it, and `test:affected` cannot select those in principle
    // (a scoped typecheck compiles the changed file plus what IT imports, never its
    // importers — build:typecheck states that limitation in its own `scopeToFiles`
    // contract). So the guard reporting the gap must not be selected by the mechanism
    // that has it.
    //
    // WHY THIS IS REGISTERED AT ALL, given the guard already existed: it ran on NO
    // automated path. Its only automated reach was a PostToolUse nudge hook, which fires
    // solely for Claude Code Edit|Write|MultiEdit sessions that have it registered —
    // nothing for a `psu` non-Claude client, a script-driven edit, or CI. MEASURED
    // (2026-08-12): `ActiveLockRow.lock_id` gained a required field in
    // libs/papercusp/packages/locks/, stranded its constructors, and froze `main` ~14h.
    // `npm run test:affected` was green throughout, because this guard was in it nowhere.
    //
    // ENFORCED TYPECHECK FORM — the guard's parser first checks whether the changed exported
    // shape actually added required fields. Only then does `--typecheck` invoke lint:tsc
    // with the exact operator-core changed files (and files referencing their exported
    // types), so ordinary edits pay only the ~1.7s parser cost while a real addition pays
    // the existing attributed check.
    //
    // `lint:required-field-strands` remains advisory for manual invocation. This registered
    // `:typecheck` alias is the affected-path enforcement rung: it fails when the changed
    // required field strands a construction site, while preserving the guard's existing
    // NOT_CHECKED/non-gating behavior when there is no attributable comparison.
    //
    // ~1.72-1.77s (3 runs measured through the workspace script, 9 files examined) — a
    // `git show` + TS parse per changed file, so cost tracks the working diff, which
    // git-sync keeps small by sweeping every few minutes.
    workspace: "@papercusp/operator-core",
    script: "lint:required-field-strands:typecheck",
    // Its subject is the WORKING DIFF, so a gate checkout — clean by construction — makes
    // it examine zero files and exit EXIT_NOT_CHECKED on every candidate. Non-gating is
    // therefore mandatory, not defensive; the strand-family declaration test in
    // affected-tests-repo-wide-invariant-guards.test.ts asserts it from the guard's own
    // `not-checked.mjs` import rather than from a hand-maintained list.
    notCheckedIsNonGating: true,
    // EI-21413078976809986: selection may be driven by --changed-paths after
    // git-sync has already committed the edit. The detector needs BOTH the
    // runner's comparison base (to recover the before-image) and the exact
    // triggering paths (to avoid widening to every unrelated staging change).
    // Omitting either makes the advisory exit NOT_CHECKED while the affected
    // runner reports a red with zero files examined.
    forwardBase: true,
    forwardChangedPaths: true,
    // No hostSuiteRatchet: check-required-field-strands.test.ts exercises the DETECTOR
    // over fixtures and never diffs the real tree, so operator-core's own suite running
    // implies nothing about this having executed.
    //
    // TS-family files, PLUS submodule roots. That second half is not a nicety: it is the
    // only shape under which a submodule-internal change reaches this registry at all
    // (see gitmodulePaths()), and the measured incident above lives inside one. A
    // `/\.tsx?$/`-only predicate would have left the exact class that froze `main`
    // unattached while looking fully wired.
    appliesTo: (f) => /\.[cm]?tsx?$/.test(f) || gitmodulePaths().has(f),
  },
  {
    // WI-37593 — the D-034 shape, and the one instance that corrupts THIS FILE'S OWN
    // reverse-dep walk, so every other guard's selection inherits the blind spot.
    //
    // MEASURED (2026-08-09, the ~2h20m fleet-gate freeze): `libs/generic/search/src/
    // hybrid.ts` gained `lexicalWithCascade()` and broke 3 fixtures in operator-core.
    //   --changed-paths libs/generic/search/src/hybrid.ts
    //       -> AFFECTED_WS @papercusp/search, @papercusp/web    (operator-core ABSENT)
    // Mechanism, read at the writer: the reverse-dep map above is built from
    // {dependencies, devDependencies, peerDependencies} ONLY. operator-core imports
    // @papercusp/search in 10+ files and declares it in NONE, so the edge does not
    // exist in the graph and the consumer is invisible. Nothing caught it locally; the
    // fleet gate went red 3x and `main` was frozen while four agents converged on it.
    //
    // ⚠ WHY REGISTER A GUARD THAT IS ALREADY "ENFORCED": it is enforced REMOTELY and
    // POST-PROMOTION only — .github/workflows/test.yml runs it, but git-sync stamps
    // every commit `[skip ci]`, so the push/pull_request triggers never fire
    // (EI-18661485259809120); green-checkpoint dispatches the workflow explicitly AFTER
    // it fast-forwards `main`. So the author of an undeclared import gets ZERO local
    // signal, and the fleet's own blocking verdict never runs it. lint:guard-reachability
    // therefore classifies it `[ci]` = enforced, which is true and still leaves exactly
    // the gap this registry exists to close. Do NOT read its absence from that census's
    // NOT-ENFORCED list as evidence the local path is covered.
    workspace: "@papercusp/operator-core",
    // 1.10-1.16s (3 runs measured) — between lint:chunk-safe and lint:drop-database-force
    // (~1.0s), both already accepted here at that price.
    script: "lint:workspace-deps-complete",
    // Mirrors the guard's OWN scan surface: `--include=*.ts` / `*.tsx`
    // (check-workspace-deps-complete.mjs:150-151). Deliberately NOT the wider
    // /\.[cm]?tsx?$/ the guards above use — matching more than it scans only wastes the
    // 1.1s, but the annotation would then lie about what it covers. `package.json` is the
    // OTHER direction and is why this is not a source-only predicate: DELETING a
    // declaration reintroduces the edge without touching a single import.
    appliesTo: (f) =>
      /\.tsx?$/.test(f) || f === "package.json" || f.endsWith("/package.json"),
  },
  {
    // EI-20863237237162828 (2026-08-19) — the OTHER direction of the guard directly
    // above. That one catches a local package IMPORTED BUT NOT DECLARED; this one
    // catches an external peer DECLARED BUT UNSATISFIABLE by the installed tree.
    //
    // Why it must be repo-wide rather than a workspace suite: the blast radius of a bad
    // peer range is not the workspace that declares it. npm resolves peers TREE-WIDE, so
    // `libs/papercusp-shared` declaring `dockview ^5` against an installed 6.6.1 broke
    // `npm install` for EVERY agent on EVERY package — and `npm run install:safe` is the
    // one sanctioned install path here, so while it was red there was no sanctioned way
    // to repair dependencies at all. The offending edit touched exactly one package.json
    // in a submodule; no workspace test suite covers that shape.
    workspace: "@papercusp/operator-core",
    script: "lint:peer-dep-conflicts",
    // Exit 2 = NOT CHECKED (no workspaces resolved, nothing installed to judge against,
    // or a range form the checker refuses to guess at). A gate checkout has no
    // node_modules by construction, so "examined nothing" must not red the fleet gate —
    // same contract as lint:di-seam-arity-strands above.
    notCheckedIsNonGating: true,
    // Peer declarations live ONLY in package.json; the versions they are judged against
    // move with the lockfile. Anything else cannot change this guard's verdict.
    appliesTo: (f) =>
      f === "package.json" ||
      f.endsWith("/package.json") ||
      f === "package-lock.json" ||
      f.endsWith("/package-lock.json"),
  },
  {
    // retire-mug-kettle-su-only-2026-08-09 P-016 — the recurrence guard for the
    // mug/kettle/cup retirement. Repo-wide because the thing it guards against is a NEW
    // entry point, and nobody knows in advance which file is about to grow one: the
    // console door (D-022) appeared in endpoint-route/routes/agent-mcp/, which no
    // narrower predicate would have thought to watch.
    workspace: "@papercusp/operator-core",
    // It shells out to scripts/mug-kettle-surface-census.mjs --json rather than
    // re-implementing its 8 detectors, so there is exactly ONE implementation of them.
    //
    // No runtime figure is quoted here on purpose. This line read "~3.4s" until 2026-08-31,
    // when the leg measured 98.2s end-to-end (48.3s of it the census subprocess) — a
    // hand-maintained code-describing number that drifted ~30x and was still being read as
    // current. Per the derived-truth ladder, a cost belongs where it is MEASURED, not
    // transcribed into a comment that nothing can falsify: the standing measurement lives on
    // plan gate-speed-round-2-2026-08-31 (D-003), and `testing:runs` / the gate's own
    // AFFECTED_TASK_PROGRESS lines are the live sources. Do not re-add a number here.
    script: "lint:no-ungated-mug-kettle",
    // Mirrors the union of all three scan surfaces: the census + role-door passes cover
    // executable TS/JS and Markdown prompts; P-005's current-guidance family also scans
    // maintained agentic template manifests/reference material in MDX, JSON, and YAML.
    // A stale execution prescription in template.yaml is just as material as one in GUIDE.md.
    appliesTo: (f) =>
      /\.[cm]?[jt]sx?$/.test(f) || /\.(?:mdx?|json|ya?ml)$/.test(f),
  },
  {
    // EI-21271940404773459 — a raw ESM self-exec check is safe in an isolated source
    // file but becomes true for every inlined module in the host's esbuild bundle. The
    // source ratchet and the bundle metafile check are both repo-wide invariants; route
    // the cheap source census whenever its scanned source surface or bundler seam moves.
    workspace: "@papercusp/web",
    script: "lint:no-hand-rolled-cli-entry",
    appliesTo: (f) =>
      f === "package.json" ||
      f.endsWith("/package.json") ||
      f === "package-lock.json" ||
      f.endsWith("/package-lock.json") ||
      f === "apps/operator/bin/bundle-host.sh" ||
      f === "apps/operator/bin/bundle-host-common.sh" ||
      f === "packages/operator-core/lib/util/cli-entry.ts" ||
      (/^(?:apps|libs|packages|scripts)\//.test(f) &&
        /\.(?:[cm]?[jt]sx?|mjs|cjs)$/.test(f) &&
        !/(?:^|\/)(?:\.git|\.next|_retired|build|coverage|dist|dist-host|dist-sidecar|node_modules|out|public|target)\//.test(
          f,
        ) &&
        !/(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(f) &&
        !f.endsWith(".d.ts")),
  },
  {
    // WI-38269 — the VACUOUS FLAG GUARD class, routed from the acceptance scorecard for
    // retire-mug-kettle-su-only-2026-08-09 (criterion `guards-bind-not-vacuous`).
    //
    // WHY REGISTERED HERE AT ALL, when the guard already has an enforcing test.
    // `packages/operator-core/lib/vacuous-flag-guard.test.ts` runs the scan over the real
    // tree, so check-lint-guard-reachability classifies it `test`/blocking. But the `test`
    // tier only fires when @papercusp/operator-core is independently affected — and the
    // motivating instance lived in `apps/operator-vite/src/components/adv/`, a DIFFERENT
    // workspace. So the one edit that produced the original defect is exactly the edit the
    // test tier would not have selected. That is the gap this list exists to close, and it
    // is the same argument the partial-index and green-checkpoint-tag entries make.
    //
    // ~2.4s measured (6,658 test files + 8,963 source files; two regex passes plus a
    // bounded, memoized import walk). Comparable to the mug-kettle entry above.
    workspace: "@papercusp/operator-core",
    script: "lint:vacuous-flag-guard",
    hostSuiteRatchet: "packages/operator-core/lib/vacuous-flag-guard.test.ts",
    // BOTH directions matter, which is why this is not a test-file-only predicate. The
    // defect appears when a TEST adds a flag mock — and, the actual motivating case, when
    // a SOURCE file DROPS its last flag read while the test that toggles it stays behind.
    // Narrowing to `*.test.*` would rebuild the blind spot one level down: AdvNowRunning.tsx
    // is the file that changed, and it is not a test.
    appliesTo: (f) => /\.[cm]?[jt]sx?$/.test(f),
  },
  {
    // WI-38314 — the UNREACHABLE-TIER MOCK class: a test whose mock DEFAULT supplies a
    // constant source predicate as the opposite constant, so every case in the file starts
    // in a state production cannot reach. Sibling of the vacuous-flag-guard entry above and
    // registered for the same reason, but the asymmetry it closes is different: that one
    // catches a knob that drives nothing, this one catches a knob that drives a branch
    // nothing can enter. Neither can see the other's defect.
    //
    // BOTH directions matter, so this is deliberately not a test-file-only predicate. The
    // defect appears when a TEST adds an impossible default — and, the harder direction,
    // when a SOURCE predicate COLLAPSES to a constant (a flag deletion, exactly what P-068
    // did to `mugKettleSystemEnabled`) and every pre-existing mock of it silently becomes
    // dead coverage without one test file changing. `pot/started.ts` is the file that
    // changed in the motivating case, and it is not a test.
    //
    // ~14s measured over 1,915 mocking test files plus the source sweep for constant
    // predicates — the heaviest entry here, but it runs only when a .ts/.tsx path changes
    // in an operator-core-affected run.
    workspace: "@papercusp/operator-core",
    script: "lint:no-unreachable-tier-mock",
    hostSuiteRatchet:
      "packages/operator-core/lib/unreachable-tier-mock-guard.test.ts",
    // EI-22703095921400106. NARROWER than the strand-family entries above, and for a different
    // reason: this guard's subject is the whole tracked tree, never a working diff, so it can
    // NEVER exit 2 for "examined nothing". Its ONLY EXIT_NOT_CHECKED path is a repository-index
    // fault — `git ls-files` failing with `index file smaller than expected` after
    // scripts/lib/git-index-fault.mjs has already retried a torn `.git/index` and it stayed
    // unreadable. MEASURED (affected run 471374-afdaa22b, 2026-09-08T14:14Z): the index was 0
    // bytes while git-sync was active, this guard and lint:di-seam-arity-strands both died, and
    // the runner reported them as failing lints against innocent code.
    //
    // So gating on it means gating the fleet's promotions on whether a shared-tree index write
    // happened to tear mid-read. An instrument that could not look must not red the gate — and
    // it must not silently pass either, which is why the guard prints a loud NOT CHECKED banner
    // rather than exiting 0.
    notCheckedIsNonGating: true,
    appliesTo: (f) => /\.[cm]?[jt]sx?$/.test(f),
  },
  {
    // WI-37605 — the D-034 shape again, and this one straddles the boundary in BOTH
    // directions, which is why neither workspace's own suite can hold it. The invariant
    // ("no executable line hardcodes the green-checkpoint production tag") is violated in
    // packages/operator-core (release-actions.ts, 24 sites) AND in apps/operator
    // (green-checkpoint.ts, 13 sites). A guard hosted in operator-core is not selected when
    // only green-checkpoint.ts changes — MEASURED and stated verbatim at the partial-index
    // entry above: `--changed-paths apps/operator/lib/release/green-checkpoint.ts` ->
    // AFFECTED_WS @papercusp/web. So the offender that produced the original report is
    // exactly the one an unregistered guard would miss.
    //
    // The violation is expensive to discover late in the specific way this list cares about:
    // it is invisible locally (it changes no behaviour and no test), and it surfaces as a
    // TRIAGER misreading a verdict log mid-incident — the captured suite line is
    // byte-identical to a real gate decision. Measured on the 4 newest verdict logs on
    // 2026-08-10: 6 impostor lines each.
    //
    // Verified clean at wiring time (`node scripts/check-green-checkpoint-tag.mjs` -> exit 0),
    // so registering it cannot red anyone's loop on pre-existing debt.
    workspace: "@papercusp/operator-core",
    // ~0.3s: a plain fs walk of two lib roots with a cheap `includes` pre-filter before the
    // quote-aware scanner ever runs. The SCRIPT, not the vitest file — the narrow task only
    // needs the ratchet; the discrimination controls that prove the detector works already
    // run inside operator-core's own suite (green-checkpoint-tag-guard.test.ts).
    script: "lint:green-checkpoint-tag",
    hostSuiteRatchet:
      "packages/operator-core/lib/green-checkpoint-tag-guard.test.ts",
    appliesTo: (f) =>
      /\.[cm]?tsx?$/.test(f) &&
      GC_TAG_SOURCE_ROOTS.some((r) => f.startsWith(`${r}/`)),
  },
  {
    // EI-20035436440627349 — the D-034 shape at its most literal: an unparseable module
    // does not break the workspace it lives in, it breaks every workspace that imports
    // it, and THIS FILE plus its scripts/lib/*.mjs helpers are themselves .mjs, so a
    // broken one corrupts the selection mechanism the other guards are chosen by.
    //
    // WHY IT EARNS A SLOT rather than being left to whoever runs a suite next: one
    // unparseable module reds every test file that transitively imports it; all of them
    // produce real FAIL rows; all attribute cleanly to a file; so the runner stamps its
    // most CONFIDENT label — `coverage=complete` — over a list of entirely innocent
    // files, with the culprit absent. `transformCulpritCount` (WI-37607) names the
    // culprit but only downstream, after a peer has already paid for the triage.
    //
    // Measured 2026-08-10, the incident that prompted it: a regex pasted verbatim into
    // a JSDoc block contained the comment terminator, making
    // scripts/lib/strip-comments-and-strings.mjs unparseable tree-wide. Caught by a
    // peer before git-sync swept it, so no broken commit landed — the window, not the
    // commit, is what this closes.
    workspace: "@papercusp/operator-core",
    // ~1.7-2.1s over 3 warm runs: 277 tracked .mjs through a parallel `node --check`
    // pool. Same order as lint:no-retired (~1.39s), which is accepted here.
    script: "lint:js-syntax",
    // NO hostSuiteRatchet ON PURPOSE. Declaring one would skip this guard exactly when
    // operator-core's full suite runs — i.e. on the biggest changesets — and the whole
    // point is that a parse break is tree-wide and instant. Unconditional attach is the
    // fail-safe direction this list documents above.
    //
    // .mjs ONLY. `.js`/`.cjs` would pull in large vendored bundles (the desktop
    // sidecar's monaco) whose baseline is unmeasured; the .mjs baseline was measured
    // clean FIRST (277/277 parse, exit 0 at wiring time), which is what lets this ship
    // ENFORCING instead of as a ratchet carrying debt.
    appliesTo: (f) => f.endsWith(".mjs"),
  },
  {
    // WI-5371 / WI-5673 — a Protomux carries AT MOST ONE hypercore/alpha channel per
    // discovery key, and every harness on this machine shares ONE peer socket. So a second
    // local replica of a remote key never attaches a replicator: it sits at peersCount 0
    // FOREVER while the socket stays live and every health surface reads healthy, then trips
    // replication_stalled -> repair-on-detect (which structurally cannot win the one slot) ->
    // repair-exhausted -> a FORCED TOPIC REJOIN that tears down the SHARED socket for the
    // healthy co-tenant harnesses too. `remote-core-host.ts` fixed it by keeping ONE core per
    // (machine, key) behind the `openRemoteLog` seam — but nothing stopped the next
    // `store.get({ key })` from re-arming it, and the failure is silent at the call site.
    workspace: "@papercusp/operator-core",
    script: "lint:no-unhosted-remote-core",
    // The ratchet IS the guard: no-unhosted-remote-core-guard.test.ts EXECS the real script
    // three times (violation -> exit 1, clean -> exit 0, own-log -> exit 0), so when
    // operator-core's suite runs the detector has genuinely executed, not been assumed.
    hostSuiteRatchet:
      "packages/operator-core/lib/no-unhosted-remote-core-guard.test.ts",
    // NARROW TRIGGER, BROAD SCAN — deliberate, and the asymmetry is the point. The script
    // always scans libs/packages/apps in full (~7.6s), so a violation planted anywhere is
    // caught by any in-scope edit; `appliesTo` only decides WHEN to pay that cost. Keyed on
    // the surfaces where a Corestore is actually in scope, because attaching ~7.6s to every
    // TS edit in the repo is not a trade this list accepts (the sibling guards above run
    // 1.4-2.1s). A new Corestore call site in a wholly unrelated tree is the residual gap;
    // it is caught the next time anything under these paths moves.
    appliesTo: (f) =>
      /^packages\/operator-core\/lib\/sync\//.test(f) ||
      /(^|\/)(corestore|peer-log|remote-core-host|scope-cores)\.ts$/.test(f) ||
      f.includes("/hyperbee/") ||
      f === "scripts/check-no-unhosted-remote-core.mjs",
  },
  {
    // WI-38351 — `lint:migrations` is a GATE lint that nothing ran locally, so the author of a
    // bad migration saw a GREEN `npm run test:affected` and the fleet found out hours later, as a
    // red green-checkpoint that blocks EVERY agent's deploy. Third occurrence of that class
    // (WI-38348 / migration 815, EI-20224121418388370, EI-10999): each time the detector already
    // existed, cost ~1.1s, and simply never ran at the one moment it was still cheap to fix.
    //
    // Its checks are all whole-corpus by construction — duplicate NNN, raw BEGIN/COMMIT, RENAME
    // CONSTRAINT, tenant DEFAULT, index-shape swap, and the reservation-row check that produced
    // all three reds — so a per-workspace suite can never stand in for it.
    workspace: "@papercusp/operator-core",
    script: "lint:migrations",
    // NO hostSuiteRatchet ON PURPOSE, and here that is load-bearing rather than conventional:
    // operator-core is pulled into the affected set for EVERY `libs/papercusp/**` path (see the
    // EI-20026978310669562 note on the runner loop below), so declaring a ratchet would skip this
    // guard on precisely the changesets it exists for. `lib/lint-migrations.test.ts` also unit-
    // tests the helpers against fixtures rather than exec'ing the real corpus, so no honest
    // ratchet is available to declare even if the skip were safe.
    //
    // Honest off-box: the reservation leg needs Postgres and SKIPS cleanly when it is unreachable
    // ("· reservation check skipped (PG unreachable: …)", exit 0), so this does not become a
    // permanently-red leg in GitHub CI — same degrade-not-fail property that made
    // gen:authored-docs:check registrable above.
    appliesTo: (f) =>
      // A nested submodule edit reaches this router as the bare gitlink root, not as
      // the migration file changed inside it. Invalidate the whole corpus for that
      // shape, or a migration can land without its reservation lint ever running.
      f === "libs/papercusp" ||
      // The migration corpus itself — the numbered .sql files every check above reads. Kept as a
      // directory test rather than an `^libs/papercusp/` anchor so a second scan dir (SCAN_DIRS in
      // lint-migrations.mjs / next-migration.mjs) is covered the day one is added.
      /(^|\/)libs\/db\/sql\/\d+-.*\.sql$/.test(f) ||
      // …and the three files that DECIDE what "clean" means. A change to the linter or to the
      // allocator that hands out the numbers can invalidate the whole corpus at once without any
      // .sql file moving, which is the same shape as the projector case above.
      f === "scripts/lint-migrations.mjs" ||
      f === "scripts/next-migration.mjs",
  },
  {
    // WI-5977 (explicit-presence as an ENFORCED convention). The item's own thesis is that
    // "a convention nobody enforces decays into advice", and that is literally what had
    // happened to its lint: `lint:explicit-presence` shipped (WI-6004), then ran on NO
    // blocking path for two weeks and sat in ACKNOWLEDGED_UNREACHABLE
    // (check-lint-guard-reachability.mjs) as "logic-test only". This registration is the
    // graduation.
    //
    // It gates on a COUNT RATCHET, not on zero. Measured 2026-08-13: 55 unallowlisted
    // candidates tree-wide with an empty ALLOW, so `--strict` would be a permanently-red
    // leg — the kind the fleet learns to ignore. `--ratchet` fails only when the count
    // RISES (baseline in .explicit-presence-baseline.json, ratchet-only-down), which is the
    // same shape as .mock-cast-escape-baseline.json.
    //
    // Deliberately NOT the guard's diff-scoped default mode: with no diff base that mode
    // prints "nothing new to check" and exits 0 having scanned NOTHING. A verifier that
    // reports success without measuring is the exact defect class WI-5977 is about, so the
    // wired invocation is the whole-tree one and its output states the count it measured.
    workspace: "@papercusp/operator-core",
    // ~13.5s (measured, 2 runs: 13.46 / 13.55) — the most expensive entry in this list, and
    // the reason `appliesTo` is pinned to the analyzer's own SCAN_ROOTS rather than every
    // .ts in the repo: a change outside those roots cannot move the count at all.
    script: "lint:explicit-presence",
    // No hostSuiteRatchet: check-explicit-presence.test.ts execs the analyzer's `--self-test`
    // (a positive control on the DETECTOR) but never the whole-tree `--ratchet`, so an
    // operator-core suite run does NOT imply this has executed. Declaring one anyway would
    // be the phantom ratchet affected-tests-repo-wide-invariant-guards.test.ts forbids —
    // and it is what let lint:migration-forward-compat silently stop attaching (see the
    // hostSuiteRatchet note at the selection loop below).
    appliesTo: (f) =>
      // The analyzer's SCAN_ROOTS, mirrored — and it only reads `.ts`, so nothing else under
      // them can move the count. Test files are NOT excluded even though the analyzer skips
      // them: attaching too often costs seconds, attaching too rarely is a silent coverage
      // hole, and only one of those two errors is recoverable.
      (/\.ts$/.test(f) &&
        (f.startsWith("packages/operator-core/lib/") ||
          f.startsWith("apps/operator/lib/") ||
          f.startsWith("libs/papercusp/"))) ||
      // The detector and its baseline decide what "clean" means, so a change to either can
      // move the verdict without any scanned file changing.
      f === "scripts/check-explicit-presence.mjs" ||
      f === ".explicit-presence-baseline.json",
  },
  {
    // EI-21618443971639284 — the canonical SU prompt is copied into the operator
    // dist-sidecar and the desktop's tracked staging sidecar. A stale generated copy
    // silently gives a packaged consumer an older persona, while the source and the
    // generated files route to different workspace suites. Run the exact-byte guard
    // whenever either projection, its source, a writer, or the guard's wiring changes.
    // No hostSuiteRatchet: the operator-core test only probes router selection and
    // falsifiability fixtures; it does not execute the real projection comparison.
    workspace: "@papercusp/operator-core",
    script: "lint:prompt-projections",
    appliesTo: (f) => PROMPT_PROJECTION_TRIGGER_PATHS.has(f),
  },
  {
    // identities-v1 P-024 — marker mismatches silently drop whole generated
    // persona sections. This exact-once guard is deliberately repo-wide because
    // its source and projections route to different workspaces/submodules.
    // Measured GREEN over the real tree BEFORE registration (2026-09-04):
    // 18 present artifacts checked, 0 violations, 0 skipped build outputs.
    // No hostSuiteRatchet: the focused Vitest proves the detector falsifiable,
    // but only this task evaluates every present artifact in the real tree.
    workspace: "@papercusp/operator-core",
    script: "lint:su-splice-markers",
    appliesTo: (f) => SU_SPLICE_MARKER_TRIGGER_PATHS.has(f),
  },
  {
    // agent-launch-context-cost-2026-09-18 P-004 — the shrink-only ceilings on the PROSE
    // half of a launch payload. The sibling budget (claude-seed-wire-budget) governs the
    // TOOLS half; measured 2026-09-18 a psu Claude launch is roughly 50/50 between them,
    // and nothing governed prose at all — the playbook render, the spliced project guide
    // and the compaction protocol each grew one well-argued paragraph at a time with no
    // aggregate. A per-paragraph justification process with no total is not a budget.
    //
    // WIRED REPO-WIDE, not left to workspace selection, for the reason given on
    // LAUNCH_PROSE_BUDGET_TRIGGER_PATHS: the largest governed surface is the repo-ROOT
    // CLAUDE.md, which no workspace suite owns, and the remaining surfaces straddle
    // apps/operator/prompts and operator-core.
    //
    // No hostSuiteRatchet, on the lint:su-splice-markers precedent directly above: the
    // operator-core Vitest proves the comparison falsifiable against fixtures (including
    // each way an upper-bound check goes green without measuring anything), but ONLY this
    // task renders the real playbook and measures the real tree.
    //
    // Measured GREEN over the real tree BEFORE registration (2026-09-18): 7 surfaces,
    // 816,220 B measured against 819,000 B of ceilings, 0 over, 0 unmeasured. Registering
    // it therefore cannot red-pin the fleet on debt that accrued while it slept.
    // COST measured 2026-09-18 via this exact npm script: 34.2s, exit 0 — the bulk is tsx
    // compiling the renderer's import graph, paid only when a prose surface actually changes.
    workspace: "@papercusp/operator-core",
    script: "lint:launch-prose-budget",
    appliesTo: (f) => LAUNCH_PROSE_BUDGET_TRIGGER_PATHS.has(f),
  },
  {
    // EI-19453217565223331 — `positions.deployed` is git ancestry, not proof that
    // the serving process loaded the new bytes.  The detector scans production
    // source across apps/packages/libs/scripts, so a new reader outside the
    // operator-core workspace must still receive a local signal.
    workspace: "@papercusp/operator-core",
    script: "lint:no-deployed-liveness-read",
    // The in-suite test executes the real detector over the tracked tree.  When
    // operator-core is already affected, that test is the host-suite ratchet and
    // the narrow task is skipped; outside edits attach this exact lint task.
    hostSuiteRatchet:
      "packages/operator-core/lib/__tests__/deployed-liveness-read-guard.test.ts",
    appliesTo: (f) =>
      f === "package.json" ||
      f === "packages/operator-core/package.json" ||
      f === "scripts/check-no-deployed-liveness-read.mjs" ||
      f ===
        "packages/operator-core/lib/__tests__/deployed-liveness-read-guard.test.ts" ||
      (/^(?:apps|packages|libs|scripts)\//.test(f) &&
        /\.(?:[cm]?[jt]sx?)$/.test(f) &&
        !/(?:^|\/)(?:_retired|dist|dist-sidecar|node_modules|build|\.next|target|coverage|env-sidecars)\//.test(
          f,
        )),
  },
  {
    // EI-20094472685960957 — `.papercusp/testing-domains.json` is DERIVED from
    // packages/operator-core/lib/testing-domains-registry.ts by
    // scripts/gen-testing-domains-contract.ts, and also COMMITTED (the harness Tests
    // tab reads it at runtime). Drift IS guarded — testing-domains-contract-freshness
    // .test.ts asserts `expect(committed).toBe(generated)` — so the defect was never
    // detection. It was WHERE detection landed: inside the full operator-core suite
    // (~3978 tests, minutes, and behind pc-heavy on a loaded box), by which point a
    // one-command fix presents as a red gate blocking every agent's deploys and
    // attributed to whoever is looking. Three occurrences of that exact shape
    // (WI-37793, EI-20081777912524409, WI-6235), the first two ~2.5h apart.
    //
    // The edit-time half of the fix regenerates the artifact while the source's lock
    // is still held (apps/operator/scripts/hooks/cc/regenerate-declaration-before-
    // lock-release.mjs), which makes the stale state unreachable for edits made
    // through a client's edit tool. THIS entry is the other half: it covers every
    // route that hook cannot see — `sed -i`, a client with no hooks enrolled, a human
    // editor — and turns a minutes-deep suite red into a seconds-deep named failure.
    //
    // NO hostSuiteRatchet, deliberately, and it is the one entry here where declaring
    // one would be actively wrong: the ratchet exists (the freshness test), but it
    // lives in the very workspace that editing the registry ALWAYS makes affected, so
    // declaring it would skip this guard in exactly its primary case and reinstate the
    // slow signal this entry was added to replace. Attaching unconditionally is also
    // the fail-safe direction the registry documents for narrow tasks.
    // COST measured 2026-09-05 via this exact script: 2.3s, exit 0.
    //
    // TRIGGER SCOPE mirrors the generator's DATA inputs plus the generator itself,
    // and — unlike the hook, which must not silently revert an edit the author is
    // still looking at — ALSO the emitted contract, so a hand-edit of the artifact
    // that slipped past pretooluse-generated-file-edit-guard is still caught.
    workspace: "@papercusp/operator-core",
    script: "gen:contract:check",
    appliesTo: (f) =>
      f === "package.json" ||
      f === "packages/operator-core/package.json" ||
      f === "packages/operator-core/lib/testing-domains-registry.ts" ||
      f === "packages/operator-core/lib/harness-testing-registry.ts" ||
      f === "scripts/gen-testing-domains-contract.ts" ||
      f === ".papercusp/testing-domains.json",
  },
  {
    // EI-20244970883634313 — the result-door OPT-OUT population guard. `skipResultDoor`
    // is a typed `ResultDoorSkipReason` union (WI-37843), so every opt-out already has to
    // state a reason from a closed set; what nothing prevented was a NEW opt-out being
    // added silently. The guard is shrink-only against an inline BASELINE of the 11 sites
    // measured when it landed, and `--list` reprints the measured population for
    // re-seeding (never a hand-run grep).
    //
    // WIRED REPO-WIDE rather than left to workspace selection because the subject is the
    // POPULATION of opt-outs across the tree: the guard scans `packages`, `libs` and
    // `apps` (ROOTS in scripts/check-result-door-optouts.mjs) while its enforcing test
    // lives in @papercusp/operator-core. Left at the `test` tier it would run only when
    // operator-core was independently affected, so an opt-out added under apps/ or libs/
    // would get NO local signal and first surface as a red fleet gate — and the census
    // would report it PARTIALLY covered, a set that is shrink-only at
    // PARTIAL_COVERAGE_HIGH_WATERMARK. Registering here is the remedy
    // check-lint-guard-reachability.mjs names for exactly this shape.
    //
    // TRIGGER SCOPE is every TypeScript source under the three scanned roots: an opt-out
    // is a `skipResultDoor: '<reason>'` assignment and any of those files can introduce
    // one, so it cannot be narrowed by path without losing the coverage this entry exists
    // to buy. Plus the guard itself, whose inline BASELINE is what a bad edit would widen.
    // COST measured 2026-09-05 via this exact npm script: 3.3s, exit 0 over the whole real
    // tree (11 known sites, 11 declarations, 0 NEW offenders) — measured green FIRST, on
    // the same precedent as the entries above, so wiring it cannot red-pin the fleet on
    // debt that accrued while it slept. Slower than the sub-second tasks here, and still
    // far cheaper than the operator-core suite this replaces as the signal path.
    //
    // NO hostSuiteRatchet, deliberately. The enforcing test
    // (packages/operator-core/lib/result-door-optout-guard.test.ts) does re-run the same
    // scanTree() assertion, but it lives in operator-core — the workspace an opt-out edit
    // elsewhere does NOT make affected — so declaring one would skip this guard in
    // precisely the cross-workspace case it was registered to cover.
    workspace: "@papercusp/operator-core",
    script: "lint:no-new-result-door-optout",
    appliesTo: (f) =>
      f === "scripts/check-result-door-optouts.mjs" ||
      (/^(?:packages|libs|apps)\//.test(f) &&
        /\.tsx?$/.test(f) &&
        !/(?:^|\/)(?:_retired|dist|dist-sidecar|node_modules|build|\.next|target|coverage|env-sidecars)\//.test(
          f,
        )),
  },
];

const workspaces = [
  ...expandWorkspaces(root.workspaces),
  ...STANDALONE_PACKAGE_DIRS.filter((d) =>
    existsSync(join(ROOT, d, "package.json")),
  ),
];
const standaloneDirs = new Set(STANDALONE_PACKAGE_DIRS);

function expandWorkspaces(patterns) {
  const out = [];
  for (const p of patterns) {
    if (p.includes("*")) {
      const base = p.replace(/\/\*$/, "");
      const baseDir = join(ROOT, base);
      if (!existsSync(baseDir)) continue;
      for (const entry of execSync(`ls -1 ${JSON.stringify(baseDir)}`, {
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter(Boolean)) {
        const dir = join(base, entry);
        if (existsSync(join(ROOT, dir, "package.json"))) out.push(dir);
      }
    } else if (existsSync(join(ROOT, p, "package.json"))) {
      out.push(p);
    }
  }
  return out;
}

const wsByName = new Map();
const wsByDir = new Map();
for (const dir of workspaces) {
  const pkg = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
  const meta = {
    dir,
    name: pkg.name,
    scripts: pkg.scripts || {},
    deps: depsOf(pkg),
    standalone: standaloneDirs.has(dir),
  };
  wsByName.set(pkg.name, meta);
  wsByDir.set(dir, meta);
}

function failureRepoPath(entry) {
  const workspace = wsByName.get(entry.workspace);
  const file = String(entry.file ?? "").replaceAll("\\", "/");
  // The parser returns workspace-relative paths. Reject an unexpected absolute/traversal path
  // rather than allowing a failure line to make us inspect a different workspace's blob.
  if (
    !workspace ||
    !file ||
    file.startsWith("/") ||
    file.split("/").some((part) => part === "..")
  ) {
    return null;
  }
  return `${workspace.dir}/${file}`;
}

function gitBlobAt(ref, repoPath) {
  return ref && repoPath
    ? gitOutput(["rev-parse", `${ref}:${repoPath}`])
    : null;
}

function depsOf(pkg) {
  return new Set(
    Object.keys({
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
      ...(pkg.peerDependencies || {}),
    }),
  );
}

// Reverse-dependency map: which workspaces depend on X?
const reverseDeps = new Map();
for (const ws of wsByDir.values()) {
  for (const dep of ws.deps) {
    if (!wsByName.has(dep)) continue;
    if (!reverseDeps.has(dep)) reverseDeps.set(dep, new Set());
    reverseDeps.get(dep).add(ws.name);
  }
}

/**
 * Forward local-dependency closure for dependency materialization.
 *
 * Affected-test propagation walks `reverseDeps` because a changed library makes
 * its consumers relevant. Materialization needs the opposite direction: once a
 * test/guard workspace is selected, include every local workspace it imports so
 * package-local toolchains remain available in the isolated checkpoint tree.
 */
function localDependencyWorkspaceClosure(startWorkspaces) {
  const closure = new Map();
  const queue = [...startWorkspaces];
  while (queue.length) {
    const ws = queue.shift();
    if (!ws || closure.has(ws.name)) continue;
    closure.set(ws.name, ws);
    for (const dependencyName of ws.deps) {
      const dependency = wsByName.get(dependencyName);
      if (dependency && !closure.has(dependency.name)) queue.push(dependency);
    }
  }
  return [...closure.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

// P-016 (D-010): print-only affected-set probe for the green-checkpoint longest-green-
// prefix salvage. The machine-readable lines are emitted AFTER the repo-wide guard
// selection below, so this probe reports the same guard tasks that a real run would
// attach. It still exits before any test task runs.

function affectedWorkspaces() {
  if (runAll) return [...wsByDir.values()];

  // --changed-paths <a,b,c>: compute the affected set from an EXPLICIT path list
  // instead of a git diff. Two uses, one mechanism (EI-19346163916263067):
  //   - "what would touching this file actually select?" — the question whose
  //     unanswerability let root `scripts/` map to zero workspaces unnoticed. On
  //     this tree a git-based probe cannot answer it: git-sync sweeps the WHOLE
  //     tree, so no real commit is ever scoped to the paths you care about, and
  //     the working-tree/untracked legs of changedFiles() fold in every peer's
  //     in-flight edits on top.
  //   - it makes the selection rules unit-testable hermetically (no repo history,
  //     no clean tree, no synthetic commits).
  // Read-only and selection-only — it cannot cause anything to run that a real
  // change to those same paths would not.
  if (changedPathsOverride) {
    return resolveAffected(changedPathsOverride);
  }

  let changed;
  try {
    changed = changedFiles();
  } catch (e) {
    // EI-8580: a shallow clone whose fetch horizon no longer overlaps
    // `base` (origin/main) fails `git diff base...HEAD` with something
    // like "no merge base" / "no common ancestor" — the diff needs the
    // merge-base commit, not just the tip. This is self-healing: a bounded
    // `git fetch --deepen=2000` is additive (never touches the working
    // tree) and, on a normal drift, restores the merge base outright. Try
    // that ONCE before giving up to --all, so a stale-but-fixable shallow
    // clone doesn't silently pay a full-tree run (and the unrelated flakes
    // that come with it) every single time.
    const looksLikeMergeBaseGap =
      /no merge base|no common ancestor|unrelated histories/i.test(e.message);
    let healed = false;
    if (looksLikeMergeBaseGap) {
      errSync("");
      errSync(
        `!!!!!! affected-tests: \`git diff\` against ${base} found no merge base — shallow clone horizon gap.`,
      );
      errSync(
        "!!!!!! Attempting a one-shot self-heal: git fetch --deepen=2000 origin main staging ...",
      );
      try {
        execSync("git fetch --deepen=2000 origin main staging", {
          cwd: ROOT,
          encoding: "utf8",
          stdio: "pipe",
        });
        changed = changedFiles();
        healed = true;
        errSync(
          "!!!!!! Self-heal succeeded — merge base restored, proceeding with the real affected set.",
        );
        errSync("");
      } catch (e2) {
        errSync(`!!!!!! Self-heal fetch/retry failed: ${e2.message}`);
        errSync("");
      }
    }
    if (!healed) {
      // `--ignore-submodules=dirty` (see changedFiles) means a broken retired
      // submodule no longer trips this — so a failure HERE is now a GENUINE git
      // problem, not the routine retired-submodule breakage. Make the
      // degrade-to-everything LOUD: the old fallback printed two quiet lines and
      // ran all ~80 workspaces, which read as a normal (if slow) run and hid the
      // real cause (EI-1989). A banner on stderr ensures it can't masquerade as
      // the intended fast path.
      errSync("");
      errSync(
        "!!!!!! affected-tests: COULD NOT COMPUTE THE AFFECTED SET !!!!!!",
      );
      errSync(`!!!!!! \`git diff\` against ${base} failed: ${e.message}`);
      errSync(
        "!!!!!! FALLING BACK TO --all (running EVERY workspace) — SLOW, and a BUG, not the intended path.",
      );
      errSync("!!!!!! Fix the git error above; do not rely on this fallback.");
      errSync("");
      derivationDegraded = true;
      return [...wsByDir.values()];
    }
  }

  return resolveAffected(changed);
}

// The path-set -> workspace-set rule, factored out so the --changed-paths probe
// (and its guard test) exercise the SAME code the real git-diff path does. Two
// copies of this that could drift would make the test prove nothing.
function resolveAffected(changed) {
  const directlyChanged = new Set();
  for (const file of changed) {
    let matchedAWorkspace = false;
    for (const ws of wsByDir.values()) {
      // `file === ws.dir` (no trailing slash) is the SUBMODULE case: a gitlink
      // change is reported as the bare directory, not as a path beneath it. Without
      // this arm, a submodule workspace can never be marked affected.
      if (
        file === ws.dir ||
        file === `${ws.dir}/package.json` ||
        file.startsWith(`${ws.dir}/`)
      ) {
        directlyChanged.add(ws.name);
        matchedAWorkspace = true;
      }
    }
    // Paths in a non-workspace source directory (see NON_WORKSPACE_PATH_ROUTES).
    // Deliberately a FALLBACK, not an override: if a real workspace ever owns the
    // path, that ownership wins and the route stays silent.
    if (matchedAWorkspace) continue;
    for (const route of NON_WORKSPACE_PATH_ROUTES) {
      if (!file.startsWith(route.prefix)) continue;
      if (wsByName.has(route.workspace)) directlyChanged.add(route.workspace);
    }
  }

  // Walk reverse-deps transitively
  const affected = new Set(directlyChanged);
  const queue = [...directlyChanged];
  while (queue.length) {
    const name = queue.shift();
    const dependents = reverseDeps.get(name);
    if (!dependents) continue;
    for (const d of dependents) {
      if (!affected.has(d)) {
        affected.add(d);
        queue.push(d);
      }
    }
  }

  return [...affected].map((name) => wsByName.get(name)).filter(Boolean);
}

/**
 * Detect "EL-relevant" file changes — persona, sync script, the test
 * itself, or any registered command def the agent might call. When
 * these change AND --integration is set, auto-enable --el-suite so the
 * operator's voice agent doesn't drift unnoticed.
 */
function elSuiteAutoTrigger() {
  if (runAll) return false; // user already opted into everything
  let changed;
  try {
    changed = changedFiles();
  } catch {
    return false;
  }
  return changed.some(
    (f) =>
      f === "apps/operator/prompts/operator.persona.md" ||
      f === "apps/operator/scripts/el-agent-sync.mjs" ||
      f === "apps/operator/scripts/el-suite-test.mjs" ||
      f.startsWith("apps/operator/lib/commands/defs/"),
  );
}
if (runIntegration && !runElSuite && elSuiteAutoTrigger()) {
  outSync("(EL-relevant files changed — auto-enabling --el-suite)");
  // mutate the flag so the task collector below picks it up
  // eslint-disable-next-line no-global-assign
  globalThis.__autoElSuite = true;
}

const affected = affectedWorkspaces();

// EI-19454727576364875 — there is DELIBERATELY no `if (!affected.length) exit` here, and it
// must not be reintroduced. It used to sit at this line, 46 lines above the
// REPO_WIDE_INVARIANT_GUARDS loop below, which made that loop unreachable whenever the changed
// paths mapped to no workspace. That silently defeated the mechanism in exactly the case it was
// built for: a guard is registered by `appliesTo(changedFile)` PRECISELY so it keeps running when
// its host workspace is not affected, and the change that routes NOWHERE (root package.json,
// tsconfig.base.json, the lockfile) is the one most likely to break something repo-wide.
//
// Measured before the fix: `--changed-paths package.json` printed
// `status=passed tasks=0 reason=no-affected-workspaces` while a guard registered with
// `appliesTo: (f) => f === 'package.json'` sat right there, matching, and never ran. The failure
// presented as GREEN — `tasks=0 … status=passed` is indistinguishable from "nothing needed
// checking", which is the expensive direction for a gate to fail in.
//
// The empty-affected case is now handled by the single `if (!tasks.length)` exit below, AFTER the
// guards have had their chance to attach. The per-workspace loop is already a no-op over an empty
// `affected`; `wsByName` is built from ALL workspaces, so a guard's host still resolves; and with
// no `test` task present the `hostSuiteRatchet` deferral cannot fire, so guards attach
// unconditionally — the fail-safe direction.

// ── PURE/STATEFUL LANE SPLIT (plan gate-suite-speedup-2026-08-12, P-003) ────────────────
// A workspace declaring BOTH lane scripts runs them INSTEAD of its single `test` task. The
// PURE lane (files that never touch the module registry — no vi.mock/doMock/resetModules)
// runs with vitest's top-level `isolate` OFF, so files SHARE a fork's module registry
// instead of cold-transpiling the package graph once per file; the STATEFUL lane keeps
// today's isolated behaviour. Together the two lanes run EXACTLY the file set `test` ran.
//
// `npm run test` itself is deliberately UNCHANGED and still runs the whole suite isolated.
// That is load-bearing, not incidental: the green-checkpoint's isolation and confirming
// co-execution re-runs reach a workspace through resolveWorkspaceTestInvocation
// (`npm run test --workspace <ws> -- <files>`), which sets no lane env — so those re-runs
// stay isolated BY CONSTRUCTION, and WI-6956 keeps its ability to classify "passes alone,
// fails co-executed" as a real concurrency defect rather than absorbing it.
const LANE_SCRIPTS = ["test:lane-pure", "test:lane-stateful"];
const hasLaneSplit = (ws) => LANE_SCRIPTS.every((s) => ws.scripts?.[s]);
/**
 * Do this workspace's already-queued tasks cover its FULL unit suite?
 *
 * The `hostSuiteRatchet` deferral below asks "is the host suite running?", and before the
 * lane split that was spelled `t.script === 'test'`. Under the split the full suite is the
 * UNION of the two lane tasks, so a literal 'test' check would silently answer NO and
 * re-attach EVERY ratchet-declaring guard as a separate npm invocation — each paying the
 * ~6.5s per-leg spawn the split exists to save. Fail-safe in direction, but it would eat a
 * large share of the gain, and nothing would report that it had.
 */
const coversHostSuite = (queued, wsName) =>
  queued.some((t) => t.ws.name === wsName && t.script === "test") ||
  LANE_SCRIPTS.every((s) =>
    queued.some((t) => t.ws.name === wsName && t.script === s),
  );

const tasks = [];
const excludedAffected = new Set();
for (const ws of affected) {
  if (excludes.has(ws.name)) {
    excludedAffected.add(ws.name);
    outSync(`(excluded ${ws.name})`);
    continue;
  }
  if (ws.scripts.test) {
    if (hasLaneSplit(ws))
      for (const script of LANE_SCRIPTS) tasks.push({ ws, script });
    else tasks.push({ ws, script: "test" });
  }
  // Static drift check between el-agent-sync TOOLS list and the
  // commands registry. Cheap (no network), catches the runtime crash
  // class that hit us yesterday ("Client tool not defined on client").
  // Always runs when present — no integration flag gate.
  if (ws.scripts["lint:el-tools"]) tasks.push({ ws, script: "lint:el-tools" });
  if (runIntegration && ws.scripts["test:integration"])
    tasks.push({ ws, script: "test:integration" });
  // EL Conv AI behavior suite. Hits the live agent; expensive (a few
  // EL minutes per run). Gated behind --integration AND --el-suite
  // because most operator changes don't affect persona/tools — opt-in
  // when you've touched prompts/operator.persona.md, scripts/el-agent-
  // sync.mjs, lib/commands/defs/**, or want to verify before a release.
  // Skips with exit 0 when EL credentials aren't available so CI
  // without an XI_API_KEY doesn't fail the gate.
  if (
    runIntegration &&
    (runElSuite || globalThis.__autoElSuite) &&
    ws.scripts["test:el-suite"]
  )
    tasks.push({ ws, script: "test:el-suite" });
}

// Repo-wide invariant guards (see REPO_WIDE_INVARIANT_GUARDS). Appended AFTER the
// per-workspace loop.
//
// EI-20026978310669562 — this skip used to read `t.script === 'test' || t.script ===
// guard.script`, justified as "that suite already contains the guard, so adding it
// there would just run the same assertions twice". That premise was ASSUMED per guard
// and true for only SOME of them, which made the skip a silent coverage hole with a
// trigger nobody would connect to it: the guard stopped attaching the moment the HOST
// workspace became affected for an unrelated reason. Measured — declaring
// @papercusp/db-org et al. on operator-core (a dependency-graph change, nothing to do
// with linting) pulled operator-core into the affected set for every libs/papercusp/**
// path, so a migration .sql change silently stopped running
// lint:migration-forward-compat: exactly the class WI-9573 wired this registry to
// prevent, re-opened by a change three files away.
//
// So the premise is now DECLARED (`hostSuiteRatchet`) rather than assumed, and asserted
// by affected-tests-repo-wide-invariant-guards.test.ts: a guard may only be skipped in
// favour of the host suite if it NAMES the in-suite ratchet that re-runs it, and that
// file must really exec it. A guard that declares nothing attaches unconditionally —
// the fail-safe direction, since the narrow tasks are sub-second by design.
const selectedInvariantGuards = [];
for (const guard of REPO_WIDE_INVARIANT_GUARDS) {
  const ws = wsByName.get(guard.workspace);
  if (!ws?.scripts?.[guard.script]) continue;
  if (excludes.has(ws.name)) continue;
  // Dedupe the guard against ITSELF unconditionally: queueing the identical narrow task
  // twice is pure waste and buys no coverage.
  if (tasks.some((t) => t.ws.name === ws.name && t.script === guard.script))
    continue;
  // Defer to the host workspace's full suite ONLY where a named ratchet re-runs this
  // invariant inside it.
  if (guard.hostSuiteRatchet && coversHostSuite(tasks, ws.name)) continue;
  if (!invariantGuardChangedPaths().some((f) => guard.appliesTo(f))) continue;
  const guardArgs =
    guard.script === AUTHORED_DOC_GUARD_SCRIPT
      ? authoredDocGuardArgs()
      : guard.forwardChangedPaths
        ? explicitFilesArgs(
            invariantGuardChangedPaths().filter((file) =>
              guard.appliesTo(file),
            ),
          )
        : [];
  selectedInvariantGuards.push({
    workspace: ws.name,
    script: guard.script,
    guardArgs,
    ...(guard.forwardBase ? { guardBase: repoWideGuardBase } : {}),
  });
  if (!printAffected)
    outSync(
      `(repo-wide invariant guard: ${ws.name} :: ${guard.script})${formatGuardArgs(guardArgs)}`,
    );
  tasks.push({
    ws,
    script: guard.script,
    // P-009 part (a): a repo-wide invariant guard is a NARROW re-run of one lint,
    // and it writes to the SAME <ws>/coverage directory as that workspace's real
    // suite. Instrumenting it would let a sub-second guard finish last and clobber
    // the full run's lcov with a near-empty one — under-reporting coverage, which
    // the patch gate then reports as uncovered changed lines. A false RED is not a
    // safer failure than a false green; both are wrong. coverageArgsFor() reads this.
    isInvariantGuard: true,
    notCheckedIsNonGating: Boolean(guard.notCheckedIsNonGating),
    ...(guard.forwardBase
      ? {
          guardBase: repoWideGuardBase,
          guardBaseResolved: repoWideGuardBaseSha != null,
        }
      : {}),
    ...(guardArgs.length ? { guardArgs } : {}),
  });
}

/**
 * Path aliases for a workspace, read from its tsconfig `compilerOptions.paths`.
 *
 * Only intra-package aliases matter here (`@/…`); a bare package specifier is out of
 * graph by design. Returning {} on any problem is SAFE, not lossy: an alias we cannot
 * resolve makes the importing file "unresolved", and related-tests.mjs treats an
 * unresolved file as reaching everything — so a missing mapping widens the run rather
 * than silently dropping edges from the graph.
 */
function tsconfigAliasesFor(wsRoot) {
  try {
    const tsconfigPath = join(wsRoot, "tsconfig.json");
    if (!existsSync(tsconfigPath)) return {};
    // Tolerate comments/trailing commas — tsconfig is JSON5-ish in practice.
    // Comments are masked by the SHARED stripper, never a local regex. A naive
    // `//`-to-end-of-line rule is string-literal-blind, so a tsconfig value that
    // merely CONTAINS " // " (measured: `"note": "ratio 1 // 2 is fine"`) is
    // truncated mid-string and JSON.parse throws. The catch below would swallow
    // that and return {}, silently dropping every alias — which makes each aliased
    // import unresolvable and fail-safes the whole workspace to "reaches
    // everything". Safe direction, but it disables narrowing INVISIBLY, which is
    // the failure mode this file can least afford to hide. Trailing commas are
    // stripped AFTER masking, so a comma inside a string is never touched either.
    const raw = stripCommentsOnly(
      readFileSync(tsconfigPath, "utf8"),
      tsconfigPath,
    ).replace(/,(\s*[}\]])/g, "$1");
    const cfg = JSON.parse(raw);
    const opts = cfg.compilerOptions ?? {};
    const baseUrl = join(wsRoot, opts.baseUrl ?? ".");
    const out = {};
    for (const [pattern, targets] of Object.entries(opts.paths ?? {})) {
      const target = Array.isArray(targets) ? targets[0] : null;
      if (typeof target !== "string") continue;
      // "@/*": ["./*"]  ->  prefix "@/" maps to <baseUrl>/
      const prefix = pattern.replace(/\*$/, "");
      const dir = join(baseUrl, target.replace(/\*$/, ""));
      out[prefix] = dir.endsWith("/") ? dir : dir + "/";
    }
    return out;
  } catch {
    return {};
  }
}

// --related: narrow each workspace's `test` task to the test files the change can
// actually reach. Everything else about the task list is untouched — in particular
// the repo-wide invariant guards above keep attaching exactly as they do without
// this flag, because they are the cross-cutting net that selection cannot replace.
//
// A task keeps `relatedFiles` only when the engine returns mode 'related'. Every
// other outcome leaves it undefined and therefore runs the FULL suite, which is the
// safe direction: over-running costs minutes, under-running certifies nothing.
let checkpointMaterializationSelection = null;
let checkpointTargetedReVerdictSelection = null;

// P-002 (gate-latency-selection-and-retry-policy-2026-09-06): the executed-source map. The
// static closure the selector computes is a SUPERSET; a map of what each test file actually
// executed (recorded by libs/test-config/src/executed-source-map-reporter.ts on clean-checkout
// runs, table harness_shared.test_executed_sources) lets `selectRelatedTests` drop tests the
// closure reaches only through a hub they never load. Everything about reaching that map is
// fail-OPEN: no database, no table, no HEAD, a slow read — each yields "no map" and the static
// selection stands. The rule that decides a prune lives in scripts/lib/related-tests.mjs.
async function resolveExecutedMapContext() {
  const inert = (reason) => ({
    enabled: false,
    reason,
    judgedSha: null,
    changedBetween: null,
    client: null,
    maps: new Map(),
  });
  if (!executedMapEnabled()) return inert("disabled-by-env");
  let judgedSha = null;
  try {
    judgedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    judgedSha = null;
  }
  if (!judgedSha) return inert("no-judged-sha");
  let client = null;
  try {
    client = await connectExecutedMapPg();
  } catch (err) {
    return inert(`pg-unavailable(${(err && err.message) || err})`);
  }
  return {
    enabled: true,
    reason: null,
    judgedSha,
    changedBetween: gitChangedBetween({ repoRoot: ROOT }),
    client,
    maps: new Map(),
  };
}

async function executedMapFor(ctx, wsName) {
  if (!ctx.enabled) return { map: null, rows: 0, error: null };
  if (ctx.maps.has(wsName)) return ctx.maps.get(wsName);
  let out;
  try {
    out = await Promise.race([
      loadExecutedSourceMap({ client: ctx.client, workspaceName: wsName, repoRoot: ROOT }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("executed-map read timed out")), 15_000).unref(),
      ),
    ]);
    out = { ...out, error: null };
  } catch (err) {
    out = { map: null, rows: 0, error: String((err && err.message) || err).replace(/\s+/g, " ") };
  }
  ctx.maps.set(wsName, out);
  return out;
}

if (relatedOnly) {
  const changedAbs = invariantGuardChangedPaths().map((f) => join(ROOT, f));
  const executedMapContext = await resolveExecutedMapContext();
  // The unit suite is narrowable whether it is one `test` script or a lane split.
  // Passing the selection to a LANE still runs that lane's own env + include set,
  // so each lane executes exactly (its files ∩ the selection) and lane semantics are
  // preserved. Integration, el-suite and the invariant guards are NOT narrowable:
  // each means something specific by "run" that a positional filter would quietly
  // change.
  const narrowable = (script) =>
    script === "test" || LANE_SCRIPTS.includes(script);
  const byWorkspace = new Map();
  let selectionFailedWide = false;

  for (const t of tasks) {
    if (!narrowable(t.script)) continue;
    // A zero-match positional filter is a FAILURE for a script without
    // --passWithNoTests. Narrowing legitimately produces zero matches for a lane, so
    // only narrow where an empty run is a clean pass; otherwise leave the task alone.
    if (!/--passWithNoTests\b/.test(t.ws.scripts?.[t.script] ?? "")) {
      selectionFailedWide = true;
      continue;
    }

    if (!byWorkspace.has(t.ws.name)) {
      const wsRoot = join(ROOT, t.ws.dir);
      const executedMap = await executedMapFor(executedMapContext, t.ws.name);
      let result;
      try {
        result = selectRelatedTests({
          rootDir: wsRoot,
          changedPaths: changedAbs,
          aliases: tsconfigAliasesFor(wsRoot),
          executedMap: executedMap.map,
          judgedSha: executedMapContext.judgedSha,
          changedBetween: executedMapContext.changedBetween,
        });
      } catch (err) {
        // A crash in selection must never be able to SHRINK a run. Fall back loudly.
        result = {
          mode: "full",
          selected: [],
          total: 0,
          reason: `selection-error(${(err && err.message) || err})`,
        };
      }
      // Only UNIT VITEST lanes are narrowable (see `narrowable` above), so a test another
      // runner owns OR the shared unit config excludes can never execute here. It reaches
      // vitest as a positional filter that matches nothing, and the router refuses the
      // entire partial-match run rather than false-greening it. The task then reds with ZERO
      // attributable test files — invisible to the test_runs ledger and isolation re-run.
      // EI-21440128879545486 was the Playwright form; EI-21576035258955946 was the same
      // failure with an explicit `*.integration.test.ts` path. Drop both classes here,
      // where "this selection feeds a unit vitest lane" is actually known.
      if (result.mode === "related" && result.selected.length > 0) {
        const ownedByPlaywright = playwrightOwnedTest(wsRoot);
        let droppedPlaywright = 0;
        let droppedUnitExcluded = 0;
        const runnable = result.selected.filter((f) => {
          if (ownedByPlaywright(f)) {
            droppedPlaywright += 1;
            return false;
          }
          if (unitExcludedVitestTest(f)) {
            droppedUnitExcluded += 1;
            return false;
          }
          return true;
        });
        if (droppedPlaywright > 0) {
          outSync(
            `RELATED_SELECTION_FOREIGN_RUNNER ws=${t.ws.name} runner=playwright dropped=${
              droppedPlaywright
            }`,
          );
        }
        if (droppedUnitExcluded > 0) {
          outSync(
            `RELATED_SELECTION_UNIT_EXCLUDED ws=${t.ws.name} layers=integration,browser dropped=${
              droppedUnitExcluded
            }`,
          );
        }
        if (runnable.length !== result.selected.length) {
          // An emptied selection is NOT narrowed to nothing: the `< 1` rail below turns it
          // into a full run, because "no vitest test is related" is a graph gap, not proof.
          result = { ...result, selected: runnable };
        }
      }
      byWorkspace.set(t.ws.name, { result, wsRoot });
      outSync(
        `RELATED_SELECTION ws=${t.ws.name} selected=${
          result.mode === "related" ? result.selected.length : result.total
        } total=${result.total} mode=${result.mode} reason=${result.reason}` +
          // P-001 (gate-latency-selection-and-retry-policy-2026-09-06): the widening share
          // is a tunable now, so the line says which value judged this workspace.
          (typeof result.threshold === "number"
            ? ` widenThreshold=${result.threshold}`
            : ""),
      );
      // P-002: one line per workspace saying whether the executed map narrowed anything and,
      // when it did not, which rail kept every test — a selection that did not shrink is
      // never silent about why.
      outSync(
        formatExecutedMapLine(t.ws.name, result.executedMap, executedMap.rows) +
          (executedMapContext.enabled ? "" : ` disabled=${executedMapContext.reason}`) +
          (executedMap.error ? ` error=${executedMap.error}` : ""),
      );
      if (result.mode !== "related" || result.selected.length < 1) {
        selectionFailedWide = true;
      }
    }

    const { result, wsRoot } = byWorkspace.get(t.ws.name);
    if (result.mode === "related") {
      // vitest takes positional filters as substring matches against test paths;
      // workspace-relative paths are what its `include` globs resolve against.
      t.relatedFiles = result.selected.map((f) => relative(wsRoot, f));
    }
  }
  if (executedMapContext.client) {
    try {
      await executedMapContext.client.end();
    } catch {
      /* the read is done; a close failure changes nothing */
    }
  }

  // `--related --print-affected` is the checkpoint's cheap, candidate-exact
  // pre-materialization query. Directory markers are emitted only when EVERY
  // selector decision is positive related evidence and at least one real selector
  // ran. A full/empty/error result emits no narrowing authority, so the checkpoint
  // keeps the historical full immutable dependency generation.
  if (printAffected && !selectionFailedWide && byWorkspace.size > 0) {
    const selectedWorkspaces = [
      ...new Map(tasks.map((task) => [task.ws.name, task.ws])).values(),
    ].sort((a, b) => a.dir.localeCompare(b.dir));
    const closure = localDependencyWorkspaceClosure(selectedWorkspaces);
    if (
      selectedWorkspaces.length > 0 &&
      closure.length >= selectedWorkspaces.length
    ) {
      checkpointMaterializationSelection = {
        relatedSelections: byWorkspace.size,
        affectedWorkspaceDirs: selectedWorkspaces.map((ws) => ws.dir),
        workspaceDirs: closure.map((ws) => ws.dir),
      };
      const affectedFiles = [...byWorkspace.entries()]
        .flatMap(([workspace, { result, wsRoot }]) =>
          result.selected.map((file) => ({
            workspace,
            file: relative(wsRoot, file).replaceAll("\\", "/"),
          })),
        )
        .sort((a, b) =>
          `${a.workspace}\0${a.file}`.localeCompare(`${b.workspace}\0${b.file}`),
        );
      const everyTaskIsCoveredByTheExactFileRunner = tasks.every((task) =>
        narrowable(task.script),
      );
      if (
        everyTaskIsCoveredByTheExactFileRunner &&
        selectedInvariantGuards.length === 0 &&
        affectedFiles.length > 0
      ) {
        checkpointTargetedReVerdictSelection = {
          affectedWorkspaces: [...new Set(affected.map((ws) => ws.name))].sort(),
          affectedFiles,
        };
      }
    }
  }
}

// ── WHERE THIS RUN'S BLAST RADIUS CAME FROM (EI-20812741760514969) ──
// Emitted BEFORE anything runs, on every path including `--print-affected`, because the
// symptom of a wrongly-scoped run is only "this is slower than I expected" — which reads as
// slowness, not as having measured one thing and run another. The marker is one greppable
// stdout line (existing consumers filter stdout by prefix, so it is inert for them); the
// loud banner goes to stderr and only for an UNSCOPED git derivation big enough that it
// cannot be one agent's edit.
//
// Report-only, deliberately: this WORKSPACE set remains authoritative for the green gate.
// `test:related` narrows unit files only after propagation; it never rewrites the candidate
// diff to one caller's paths or suppresses the cross-cutting guards above.
const derivationSource = derivationDegraded
  ? "git-fallback-all"
  : runAll
    ? "all"
    : changedPathsOverride
      ? "explicit"
      : rangeFrom && rangeTo
        ? "range"
        : "git-status";
const derivationSummary = summarizeDerivation({
  source: derivationSource,
  total: changedPathsOverride
    ? changedPathsOverride.length
    : (changedPathTotal ?? 0),
  legs: derivationSource === "git-status" ? (changedPathLegs ?? {}) : {},
  base: derivationSource === "git-status" ? base : null,
  // How far the base trails HEAD, which is what turns a big `committed` leg from an
  // alarming number into a diagnosis. Measured only when it is the number being explained,
  // and never allowed to fail the run: this whole block is disclosure, not a rail.
  baseCommitsBehind:
    derivationSource === "git-status"
      ? (() => {
          try {
            const n = Number(sh(`git rev-list --count ${base}..HEAD`));
            return Number.isFinite(n) ? n : null;
          } catch {
            return null;
          }
        })()
      : null,
  range: rangeFrom && rangeTo ? `${rangeFrom}..${rangeTo}` : null,
});
outSync(
  `${formatDerivationMarker(derivationSummary, {
    workspaces: affected.length,
    guards: selectedInvariantGuards.length,
    tasks: tasks.length,
  })} runStartHead=${RUN_START_HEAD ?? "unknown"}`,
);
for (const line of derivationBannerLines(derivationSummary, {
  workspaces: affected.length,
  tasks: tasks.length,
})) {
  errSync(line);
}

// P-009 part (a): say what `--coverage` actually reached. A partial instrumentation
// set is not a defect — a lint guard and a composite script are excluded on purpose —
// but an UNANNOUNCED partial set is, because the merged lcov downstream then looks
// like a complete report and the patch gate reports files it never measured as
// "changed but uninstrumented" with no way back to why. Emitted on stderr beside the
// AFFECTED_DERIVATION banner, and only when the flag was passed, so ordinary stdout
// stays byte-identical for every existing consumer of these lines.
if (coverageRequested) {
  const instrumented = tasks.filter((t) => coverageArgsFor(t).length > 0);
  const skipped = tasks.filter((t) => coverageArgsFor(t).length === 0);
  errSync(
    `COVERAGE_PASSTHROUGH instrumented=${instrumented.length} skipped=${skipped.length} ` +
      `of=${tasks.length} reportsAt=<workspace>/coverage/lcov.info ` +
      `merge='npm run coverage:merge'`,
  );
  for (const t of skipped) {
    const why = t.isInvariantGuard
      ? "repo-wide invariant guard (would clobber the workspace's real report)"
      : "script does not invoke vitest directly";
    errSync(`  COVERAGE_SKIPPED\t${t.ws.name} :: ${t.script}\t${why}`);
  }
  if (instrumented.length === 0) {
    errSync(
      "  ⚠ NO task was instrumented — the merged report would be empty and every patch-coverage\n" +
        "    verdict built on it vacuous. Widen the run, or drop --coverage.",
    );
  }
}

if (printAffected) {
  for (const ws of affected) outSync(`AFFECTED_WS\t${ws.name}`);
  // One line per SELECTED TASK, carrying the command that actually runs it. A bare
  // AFFECTED_WS name is not actionable: the obvious `npm run --workspace <name>` is
  // wrong for standalone packages, and a consumer cannot tell which from the name.
  // A workspace with no selected task emits no AFFECTED_WS_CMD line — that absence is
  // itself the signal that running it would measure nothing.
  for (const t of tasks) {
    outSync(
      `AFFECTED_WS_CMD\t${t.ws.name}\t${formatWorkspaceCommand(t.ws, t.script, coverageArgsFor(t))}`,
    );
  }
  for (const guard of selectedInvariantGuards) {
    outSync(
      `AFFECTED_GUARD\t${guard.workspace}\t${guard.script}\t${formatGuardCommand(guard)}`,
    );
  }
  if (relatedOnly) {
    if (checkpointMaterializationSelection) {
      const selection = checkpointMaterializationSelection;
      outSync(
        `RELATED_MATERIALIZATION_SELECTION status=selected relatedSelections=${selection.relatedSelections} ` +
          `affected=${selection.affectedWorkspaceDirs.length} closure=${selection.workspaceDirs.length}`,
      );
      for (const dir of selection.affectedWorkspaceDirs) {
        outSync(`RELATED_AFFECTED_WORKSPACE_DIR\t${dir}`);
      }
      for (const dir of selection.workspaceDirs) {
        outSync(`RELATED_DEPENDENCY_WORKSPACE_DIR\t${dir}`);
      }
    } else {
      outSync(
        "RELATED_MATERIALIZATION_SELECTION status=full reason=no-safe-positive-related-selection",
      );
    }
    if (checkpointTargetedReVerdictSelection) {
      const selection = checkpointTargetedReVerdictSelection;
      outSync(
        `RELATED_AFFECTED_FILES status=selected workspaces=${selection.affectedWorkspaces.length} files=${selection.affectedFiles.length}`,
      );
      for (const selected of selection.affectedFiles) {
        outSync(`RELATED_AFFECTED_FILE\t${selected.workspace}\t${selected.file}`);
      }
    } else {
      outSync(
        "RELATED_AFFECTED_FILES status=full reason=no-complete-exact-file-radius",
      );
    }
  }
  // An enumeration query, not a run: no verdict is owed, and two tests pin that
  // no AFFECTED_TESTS_RESULT appears here. Exempt it from the abort fallback.
  terminalSuppressed = true;
  process.exit(0);
}

if (!tasks.length) {
  // Two genuinely different empty outcomes, kept as DISTINCT reasons (EI-19454727576364875).
  // Collapsing them would hide the more interesting one: "workspaces were selected but none of
  // them declares a test script" is a coverage smell worth noticing, whereas "this change routes
  // nowhere at all" is the case that used to skip the repo-wide guards entirely.
  if (!affected.length) {
    outSync(
      "No affected workspaces (and no repo-wide invariant guard matched the changed paths).",
    );
    outSync(
      "AFFECTED_TESTS_RESULT status=passed tasks=0 failed=0 quarantinedFailed=0 timedOutTasks=0 undeterminedTasks=0 reason=no-affected-workspaces",
    );
  } else if (excludedAffected.size === affected.length) {
    outSync(
      `Affected: ${affected.map((w) => w.name).join(", ")} — all selected workspaces were excluded.`,
    );
    outSync(
      "AFFECTED_TESTS_RESULT status=passed tasks=0 failed=0 quarantinedFailed=0 timedOutTasks=0 undeterminedTasks=0 reason=all-excluded",
    );
  } else {
    outSync(
      `Affected: ${affected.map((w) => w.name).join(", ")} — but none declare a 'test' script.`,
    );
    outSync(
      "AFFECTED_TESTS_RESULT status=passed tasks=0 failed=0 quarantinedFailed=0 timedOutTasks=0 undeterminedTasks=0 reason=no-test-script",
    );
  }
  terminalEmitted = true;
  process.exit(0);
}

outSync(
  affected.length
    ? `Affected workspaces (${affected.length}): ${affected.map((w) => w.name).join(", ")}`
    : // Reachable since EI-19454727576364875: a change can route to NO workspace and still have
      // repo-wide invariant guards to run. Spelled out rather than printing an empty list, so a
      // triager reading the log is not left wondering whether the selection silently failed.
      "Affected workspaces (0) — repo-wide invariant guards only.",
);
// The task list is final here, so an abort from this point on can report the real
// planned count instead of the pre-selection zero.
plannedTaskCount = tasks.length;
outSync(`Running ${tasks.length} task(s):`);
for (const t of tasks) {
  const guardBase = t.guardBase ? ` (guard base: ${t.guardBase})` : "";
  outSync(
    `  - ${t.ws.name} :: ${t.script}${guardBase}${formatGuardArgs(t.guardArgs)}`,
  );
}
outSync(
  formatTaskBudgetMarker({
    ...SCHEDULER_CONFIG,
    memAvailableMb: MEM_AVAILABLE_MB,
    taskCgroupMemoryMaxMb: TASK_CGROUP_MEMORY_MAX_MB,
  }),
);
const taskKey = (task) => `${task.ws.name} :: ${task.script}`;
const TASK_BLAST_RADIUS = classifyAffectedBlastRadius({
  changedPaths: invariantGuardChangedPaths(),
  runAll,
  derivationDegraded,
});
const TASK_SHARD_MAX =
  process.env.AFFECTED_MAX_TASKS_PER_SHARD ??
  Math.max(8, SCHEDULER_CONFIG.maxConcurrentTasks * 4);
const TASK_SHARD_PLAN = planAffectedTaskShards(tasks, {
  blastRadius: TASK_BLAST_RADIUS,
  maxTasksPerShard: TASK_SHARD_MAX,
  taskKey,
});
outSync(
  formatAffectedTaskShardMarker(TASK_SHARD_PLAN, TASK_CGROUP_MEMORY_MAX_MB),
);
// EI-15802: printed EARLY (before any suite runs) and again in the final
// summary — a truncated background-task tail is more likely to still show
// this line than a full multi-suite run's early output, so it survives even
// when the rest of the header has already scrolled out of the retained tail.
outSync(
  `Full run log: ${RUN_LOG_PATH} (grep this — not just the exit code or a truncated tail — for the real per-suite verdict)`,
);

// Before the dry-run exit on purpose: `--dry` then shows what WOULD be reused (it only reads).
await armTestPassReuse(tasks);

if (dry) {
  outSync(
    `AFFECTED_TESTS_RESULT status=dry-run tasks=${tasks.length} failed=0 quarantinedFailed=0 timedOutTasks=0 undeterminedTasks=0`,
  );
  terminalEmitted = true;
  process.exit(0);
}

// P-008 (gate-file-level-test-reuse-2026-09-27, WI-10003476): per-test-file PASS reuse. A file
// whose clean-run pass proof (harness_shared.test_executed_sources, recorded by
// libs/test-config/src/executed-source-map-reporter.ts) is still valid at the judged sha is
// SKIPPED — the rule is scripts/lib/test-pass-reuse.mjs (D-004). Each unit vitest task gets a
// content-addressed skip list, carried to its vitest config by PC_TEST_REUSE_SKIP_LIST and applied
// as `exclude` (libs/test-config/src/test-pass-reuse-skip.ts, which re-checks run context and
// runner identity). Everything about reaching the proofs is fail-OPEN toward running MORE: kill
// switch, dirty checkout, no HEAD, no database, a slow read — each yields no skip list.
async function armTestPassReuse(taskList) {
  const unitTasks = taskList.filter(
    (t) =>
      (t.script === "test" || LANE_SCRIPTS.includes(t.script)) &&
      // An all-reused task runs zero files; only a script that treats that as a pass may skip.
      /--passWithNoTests\b/.test(t.ws.scripts?.[t.script] ?? ""),
  );
  if (unitTasks.length === 0) return;
  const off = (reason) => outSync(`TEST_PASS_REUSE applied=false reason=${reason}`);
  if (!testReuseEnabled()) return off("disabled-by-env");
  let judgedSha = null;
  try {
    judgedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    judgedSha = null;
  }
  if (!judgedSha) return off("no-judged-sha");
  // Drift is computed commit-to-commit, so an uncommitted edit (or an untracked file where a proof
  // read an absent path) would be invisible to it: reuse needs a checkout that IS the judged sha.
  let dirtyPaths = null;
  try {
    dirtyPaths = execFileSync("git", ["status", "--porcelain", "--ignore-submodules=none"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\n")
      .filter((l) => l.trim().length > 0);
  } catch {
    dirtyPaths = null;
  }
  if (dirtyPaths === null) return off("checkout-status-unknown");
  if (dirtyPaths.length > 0) {
    return off(
      `dirty-checkout(${dirtyPaths.length}: ${dirtyPaths
        .slice(0, 3)
        .map((l) => l.slice(3).trim())
        .join(",")})`,
    );
  }
  // The identity of the node the task will spawn (npm -> PATH node), not this process's: the
  // proof was stamped by the vitest process. vitest-config re-checks it against its own process.
  let runnerIdentity = null;
  try {
    runnerIdentity = execFileSync(
      "node",
      ["-p", "process.version + ' ' + process.platform + ' ' + process.arch"],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 },
    ).trim();
  } catch {
    runnerIdentity = null;
  }
  if (!runnerIdentity) return off("no-runner-identity");
  const runContext = process.env.GREEN_CHECKPOINT === "1" ? "green-checkpoint" : "clean-local";
  let client = null;
  try {
    client = await connectExecutedMapPg();
  } catch (err) {
    return off(`pg-unavailable(${String((err && err.message) || err).replace(/\s+/g, "_")})`);
  }
  const changedBetween = gitChangedBetween({ repoRoot: ROOT, relative: true });
  const maxAgeMs = testReuseMaxAgeMs();
  const auditRate = testReuseAuditRate();
  const nowMs = Date.now();
  const loaded = new Map();
  /** @type {{ tasks: number, summaries: Record<string, number>[], savedMs: number | null, unmeasured: number }} */
  const reuseTotals = { tasks: 0, summaries: [], savedMs: 0, unmeasured: 0 };
  try {
    for (const t of unitTasks) {
      if (!loaded.has(t.ws.name)) {
        let out;
        try {
          out = await Promise.race([
            loadReuseProofs({ client, workspaceName: t.ws.name, runContext }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("reuse-proof read timed out")), 15_000).unref(),
            ),
          ]);
          out = { ...out, error: null };
        } catch (err) {
          out = { proofs: new Map(), rows: 0, error: String((err && err.message) || err).replace(/\s+/g, "_") };
        }
        loaded.set(t.ws.name, out);
      }
      const { proofs, rows, error } = loaded.get(t.ws.name);
      const label = `${t.ws.name}::${t.script}`;
      if (error) {
        outSync(`TEST_PASS_REUSE ws=${label} applied=false reason=proofs-unavailable(${error})`);
        continue;
      }
      const wsRel = relative(ROOT, join(ROOT, t.ws.dir)).replaceAll("\\", "/");
      const prefix = wsRel === "" ? "" : `${wsRel}/`;
      const { skip, summary, watch } = selectReusablePasses({
        candidates: reuseCandidates({ wsRel, relatedFiles: t.relatedFiles, proofFiles: proofs.keys() }),
        proofs,
        judgedSha,
        changedBetween,
        runContext,
        runnerIdentity,
        nowMs,
        maxAgeMs,
        auditRate,
      });
      // P-012: the files reuse WOULD have skipped but that run this time; a red among them is a
      // TEST_PASS_REUSE_ALARM (phase C), judged on the first pass before any retry.
      if (watch.size > 0) t.reuseWatch = { watch, prefix };
      if (skip.length > 0) {
        t.reuseSkipList = writeReuseSkipList(RUN_LOG_ROOT, {
          files: skip.map((f) => f.slice(prefix.length)),
          runContext,
          runnerIdentity,
          judgedSha,
        });
      }
      // P-013: what the skip saved, from the files' last CI pass durations (a lower bound). A
      // failed read leaves the reuse decision untouched and only makes the estimate "unknown".
      let savings = { savedMs: 0, measured: 0, unmeasured: 0 };
      if (skip.length > 0) {
        try {
          const durations = await Promise.race([
            loadPassDurations({ client, files: skip }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("pass-duration read timed out")), 10_000).unref(),
            ),
          ]);
          savings = estimateReuseSavings(skip, durations);
        } catch {
          savings = null;
        }
      }
      reuseTotals.tasks += 1;
      reuseTotals.summaries.push(summary);
      if (savings === null) reuseTotals.savedMs = null;
      else {
        if (reuseTotals.savedMs !== null) reuseTotals.savedMs += savings.savedMs;
        reuseTotals.unmeasured += savings.unmeasured;
      }
      outSync(
        formatTestReuseLine(
          label,
          summary,
          ` rows=${rows} narrowed=${Array.isArray(t.relatedFiles)} ` +
            `minSavedTestMs=${savings === null ? "unknown" : savings.savedMs}`,
        ),
      );
    }
    if (reuseTotals.tasks > 0) outSync(formatTestReuseTotalLine(reuseTotals));
  } finally {
    try {
      await client.end();
    } catch {
      /* the read is done; a close failure changes nothing */
    }
  }
}

// AFFECTED_RETRY_FAILED=1 (the green-checkpoint sets it): re-run a FAILED
// workspace once before counting it. On the shared dev box the gate runs
// while the fleet is at load 70-95, and single-test timeout flakes were
// holding green `main` back for HOURS (2026-06-06 afternoon: consecutive
// not-greens whose identification re-run passed 8867/8867). A real
// regression fails both runs; a load flake almost never fails twice in a
// row. Default OFF so interactive `test:affected` keeps fail-fast feedback.
//
// EI-9103 (2026-07-10): interactive `test:affected` was NOT exempt from the
// same load-flake class the gate protects itself against — a fleet-load
// verification sweep false-failed 4 operator-core suites purely on wall-clock
// (60-80s, all pass in 6-8s isolated) because AFFECTED_RETRY_FAILED defaults
// OFF here. Every agent running the MANDATED test:affected sweep on a loaded
// box hit this and had to hand-triage (re-run + isolate) every time. Rather
// than flip the default globally (which would silently retry away a genuine
// regression on a quiet box too), auto-enable the SAME retry only when the
// box is actually loaded enough to plausibly cause it. loadavg is only
// comparable across machines after normalizing by the parallelism available
// to this process, so the threshold is expressed as loadavg per core. An
// explicit AFFECTED_RETRY_FAILED=0/1 always wins (still lets a caller force
// fail-fast even on a loaded box, or force retry on a quiet one).
const AUTO_RETRY_LOAD1_THRESHOLD = 1.0;
const RETRY_LOAD1_CORES = Math.max(1, availableParallelism());
const explicitRetryFailed = process.env.AFFECTED_RETRY_FAILED;
const currentLoad1 = loadavg()[0];
const currentLoadPerCore = currentLoad1 / RETRY_LOAD1_CORES;
// The load-suspect classifier and its output intentionally retain the raw
// load1 unit. Derive its equivalent raw threshold from the same per-core
// policy so the enabling and attribution comparisons cannot drift apart.
const retryLoad1Threshold =
  AUTO_RETRY_LOAD1_THRESHOLD * RETRY_LOAD1_CORES;
const retryFailed =
  explicitRetryFailed != null
    ? explicitRetryFailed === "1"
    : currentLoadPerCore > AUTO_RETRY_LOAD1_THRESHOLD;
if (explicitRetryFailed == null && retryFailed) {
  outSync(
    `>>> load1=${currentLoad1.toFixed(0)} (${currentLoadPerCore.toFixed(2)}/core) > ${AUTO_RETRY_LOAD1_THRESHOLD}/core — auto-enabling flake-absorbing retry ` +
      `(EI-9103; set AFFECTED_RETRY_FAILED=0 to force fail-fast anyway)`,
  );
}

// HARDEN-GATE (su-85e11 proposal, landed via brief 09 2026-06-10): when a
// workspace fails under AFFECTED_RETRY_FAILED, prefer re-running just the
// FAILED FILES in a FRESH process over re-running the whole workspace.
// Two flake classes the workspace-level retry handles poorly:
//   - cross-file state poisoning (vitest-fail-on-console catching another
//     file's late console output; shared bootstrap-graph state) — a fresh
//     process clears it where an identical full re-run can reproduce it;
//   - peer mid-edit transform errors on the shared tree — scoping the retry
//     to the failed files keeps the second run cheap (seconds, not a 10k-test
//     suite), so the gate's wall-clock stays bounded under load.
// Parse the vitest summary for failed files; when nothing parses (e.g. a
// non-vitest failure mode) fall back to the original full-workspace retry.
// EI-18819483316574031: this used to be a local copy of the rollup/FAIL regexes that
// did NOT strip ANSI, so on real (colourised) gate output it returned [] — silently
// downgrading the targeted fresh-process re-run of the actual failed files into a blunt
// whole-workspace retry. Now delegated to the shared, ANSI-stripping, unit-tested parser
// so it cannot drift from green-checkpoint.ts's copy again.
const parseFailedFiles = parseFailedTestFiles;
const FRESH_RETRY_MAX_FILES = 15; // a broader red is a real regression, not a flake

// EI-19370814345784324: a test that blocks its vitest worker's event loop SYNCHRONOUSLY
// (e.g. a tight `mkdirSync` ENOENT/EEXIST spin) makes vitest's own `testTimeout` unable to
// fire — that timeout is a timer on the very event loop the spin never yields, so the one
// bound that looks like it covers this is structurally incapable of firing. Measured
// 2026-08-02: a single wedged worker held the green-checkpoint gate (and every fleet
// deploy behind it) for 74 minutes before being found and killed by hand, with nothing up
// to the parent's 120-minute GREEN_CHECKPOINT_SUITE_TIMEOUT_MS backstop able to tell
// "wedged" from "legitimately slow" while it happened.
//
// The fix has to live in THIS process, not the child's. Each task is launched with async
// `spawn`, so this parent's timer remains runnable even when the child's event loop is
// synchronously spinning. The child leads a detached process group; on expiry the parent
// kills that whole group so npm/shell/vitest descendants cannot retain the capture pipes
// after the deadline. Default well below the 120m gate ceiling (generous for a legitimately
// slow full-workspace suite, but bounded), overridable for a caller who knows a specific
// workspace runs long. See scripts/lib/batch-watchdog.mjs for the unit-tested policy,
// attribution fallback, and process-tree kill.
// 45m, not 20m (EI-20268851913189733). The bound must exceed the LARGEST workspace's
// honest duration with headroom, or it stops being a watchdog and becomes a coin flip
// on load. Measured 2026-08-12: operator-core reported 3302 of its 4063 test files
// (81%) in 20.0m while still completing files at ~10ms each — i.e. it needs ~25m under
// fleet load, so the old default truncated the biggest leg MID-RUN and reported it as
// a wedge. green-checkpoint runs this same script and nothing overrides this env var,
// so that was a latent red-pin for every deploy. Still far below the ~120m gate
// ceiling this exists to protect, which is the bound that actually matters.
const BATCH_TIMEOUT_FLOOR_MS = 45 * 60_000;
const BATCH_TIMEOUT_MAX_MS = 90 * 60_000;
const BATCH_TIMEOUT_HEADROOM_MULTIPLIER = 2;
const BATCH_TIMEOUT_QUANTUM_MS = 5 * 60_000;
const BATCH_TIMEOUT_OVERRIDE_MS = resolveBatchTimeoutMs(
  process.env.AFFECTED_BATCH_TIMEOUT_MS,
  null,
);
const BATCH_KILL_SIGNAL = "SIGKILL";

// A PACKAGED install ships the whole suite (vitest, the test files, quarantine.txt,
// its own node at sidecar/bin/node) but has NO npm — by design. This script is
// reachable there (`node scripts/affected-tests.mjs --all`), so the only thing that
// made the suite unrunnable on a release build was re-spawning `npm run <script>`
// per workspace. When npm is absent, invoke the workspace's script directly instead.
// Every workspace `test`/`test:integration` script in this repo is a plain
// `vitest run …`, and `npm run` adds exactly two things we can reproduce: cwd =
// the workspace dir, and node_modules/.bin on PATH. Anything else fails LOUDLY
// rather than silently skipping — a suite that quietly runs nothing is the worst
// outcome for a release check.
const npmAvailable =
  spawnSync("npm", ["--version"], { stdio: "ignore" }).status === 0;
if (!npmAvailable) {
  outSync(
    "note: npm not found (packaged install?) — running each workspace's script directly.",
  );
}

/**
 * Reproduce what `npm run <script> --workspace <dir>` gives a script, without npm:
 * cwd = the workspace dir, and both the workspace's and the root's node_modules/.bin
 * on PATH. We also prepend THIS node's own directory, because a packaged install's
 * node lives at sidecar/bin/node and is not necessarily the `node` on PATH — without
 * it every `#!/usr/bin/env node` shebang in .bin/ fails to resolve.
 */
function spawnSpecFor(t, extraArgs) {
  if (npmAvailable) {
    // A STANDALONE package (see STANDALONE_PACKAGE_DIRS) is not an npm workspace, so
    // `--workspace <dir>` does not resolve for it — npm fails with "No workspaces
    // found". Run it the way a human would: `npm run <script>` with cwd = its own dir,
    // which resolves against ITS package.json and its own node_modules/.bin.
    if (t.ws.standalone) {
      const argv = [
        "run",
        t.script,
        ...(extraArgs.length ? ["--", ...extraArgs] : []),
      ];
      return { cmd: "npm", argv, cwd: join(ROOT, t.ws.dir) };
    }
    const argv = [
      "run",
      t.script,
      "--workspace",
      t.ws.dir,
      ...(extraArgs.length ? ["--", ...extraArgs] : []),
    ];
    return { cmd: "npm", argv, cwd: ROOT };
  }
  // No npm (a PACKAGED install — see the note above). The direct-exec fallback below
  // reproduces `npm run` for a script that is a single binary invocation; a standalone
  // package's aggregate `test` is a composite shell line (`npm run a && npm run b`),
  // which that fallback cannot honor. Fail LOUDLY rather than silently verifying
  // nothing — the stated principle for this whole code path.
  if (t.ws.standalone) {
    throw new Error(
      `${t.ws.name} :: "${t.script}" is a standalone package's aggregate script and needs npm, ` +
        `which is unavailable here (packaged install?). Run its suites individually, or skip ` +
        `standalone packages in this environment — do not treat this as a pass.`,
    );
  }
  const script = (t.ws.scripts[t.script] ?? "").trim();
  const [tool, ...rest] = script.split(/\s+/);
  const wsDir = join(ROOT, t.ws.dir);
  const binDirs = [
    join(wsDir, "node_modules", ".bin"),
    join(ROOT, "node_modules", ".bin"),
  ];
  const env = {
    ...process.env,
    PATH: [dirname(process.execPath), ...binDirs, process.env.PATH]
      .filter(Boolean)
      .join(":"),
  };
  // `node foo.mjs` → run it with the node we are already running under.
  if (tool === "node")
    return {
      cmd: process.execPath,
      argv: [...rest, ...extraArgs],
      cwd: wsDir,
      env,
    };
  // Anything else must be a node_modules/.bin entry (vitest, astro, tsx, …).
  // Spawn the bin itself so its shebang picks the right interpreter; PATH above
  // makes that resolve. Fail LOUDLY on a missing bin — a release check that
  // silently runs nothing is worse than one that stops.
  const bin = binDirs.map((d) => join(d, tool)).find((p) => existsSync(p));
  if (!bin) {
    throw new Error(
      `${t.ws.name} :: "${t.script}" is \`${script}\` — no \`${tool}\` in ${binDirs.join(" or ")}. ` +
        `Install npm, or add the missing dependency.`,
    );
  }
  return { cmd: bin, argv: [...rest, ...extraArgs], cwd: wsDir, env };
}

// ── P-003/D-003: conservative passing-task reuse across candidate refires ───
// setupTree() rebuilds the checkpoint checkout for every newer candidate. The cache therefore
// lives outside ROOT, but its filename is scoped to this checkout root so another pipeline/tree
// can never consume it accidentally. It is enabled for the real green checkpoint, the explicit
// `test:affected` bounded-resume wrapper, and the root ordinary `npm test` wrapper (which opts
// into the stable cross-run group below). `test:related`/`test:all*` and direct workspace runs
// remain fresh feedback. PAPERCUSP_TEST_RUN_GROUP is part of the complete child-env hash below,
// which normally confines reuse to one gate run. A frozen-repair verifier or pc-heavy retry
// series receives AFFECTED_TASK_VERDICT_PROOF_GROUP; only the CACHE identity substitutes that
// initial group while the real child keeps this process's own run group.
const TASK_VERDICT_CACHE_ENABLED =
  process.env.GREEN_CHECKPOINT === "1" ||
  process.env.AFFECTED_TASK_VERDICT_RESUME === "1";
// Ordinary local `npm test` has no gate-supplied proof group. It may use the existing stable
// cross-run proof only when the caller explicitly opted into resumable execution, and never
// while GREEN_CHECKPOINT is active (a gate without proof state must stay fail-closed).
const TASK_VERDICT_LOCAL_CROSS_RUN_ENABLED =
  process.env.AFFECTED_TASK_VERDICT_RESUME === "1" &&
  process.env.GREEN_CHECKPOINT !== "1";
const TASK_VERDICT_PROOF_GROUP_APPLIED =
  typeof process.env.AFFECTED_TASK_VERDICT_PROOF_GROUP === "string" &&
  process.env.AFFECTED_TASK_VERDICT_PROOF_GROUP.trim() !== "";
const { cacheGroup: TASK_VERDICT_PROCESS_CACHE_GROUP } =
  passingTaskVerdictIdentityEnvironment(process.env);
const TASK_VERDICT_LOCAL_CROSS_RUN_ONLY =
  TASK_VERDICT_LOCAL_CROSS_RUN_ENABLED &&
  !TASK_VERDICT_PROCESS_CACHE_GROUP;
// A local resumable run has no per-run proof group, so its sole lookup namespace is the stable
// cross-run group. Gate runs retain their caller-supplied per-run group and the fallback below.
const TASK_VERDICT_CACHE_GROUP =
  TASK_VERDICT_PROCESS_CACHE_GROUP ??
  (TASK_VERDICT_LOCAL_CROSS_RUN_ONLY
    ? PASSING_TASK_VERDICT_CROSS_RUN_GROUP
    : null);
const TASK_VERDICT_CACHE_SCOPE = TASK_VERDICT_LOCAL_CROSS_RUN_ONLY
  ? "cross-run"
  : TASK_VERDICT_PROCESS_CACHE_GROUP
    ? TASK_VERDICT_PROOF_GROUP_APPLIED
      ? "proof"
      : "current-run"
    : "missing";
const TASK_VERDICT_CACHE_ROOT_SCOPE = createHash("sha256")
  .update(ROOT)
  .digest("hex")
  .slice(0, 16);
// WI-1492652: this default USED to be `tmpdir()`, which resolves to /tmp/pcv here — and
// /etc/tmpfiles.d/tmp.conf sets `D /tmp 1777 root root 7d` while the boot unit runs
// `systemd-tmpfiles --create --remove --boot`. Capital D + --remove EMPTIES /tmp at every
// boot, so the whole verdict cache was destroyed on each reboot and the next gate run lost
// 100% of its cross-run reuse. (Measured: 0 of 7,866 /tmp entries predated the boot; 0 of
// 5,986 under /tmp/pcv. The cost is ~0.4% of runs — ~8 boots/81d against an hourly gate —
// NOT the ~18% originally filed on that item, which generalised a 2-of-11 window that
// happened to straddle a reboot.)
//
// ⚠ ONLY THE DIRECTORY MOVES. The filename still carries the cache IDENTITY — the `v2`
// version constant and the ROOT-scope hash — and must not be touched here: durability and
// identity are separate concerns, and a cache that HITS on a wrong identity would serve
// stale passing verdicts, i.e. FALSE GREENS. That is strictly worse than the cold cache
// this fixes, so never bundle an identity/version change into a relocation.
//
// The writer mkdirs recursively and renames atomically, so a missing dir is not a concern.
const TASK_VERDICT_CACHE_PATH =
  process.env.AFFECTED_TASK_VERDICT_CACHE_PATH ||
  join(
    homedir(),
    ".papercusp",
    "cache",
    `papercusp-affected-passing-verdicts-v2-${TASK_VERDICT_CACHE_ROOT_SCOPE}.json`,
  );
const taskVerdictCacheRead = TASK_VERDICT_CACHE_ENABLED
  ? readPassingTaskVerdictCache(TASK_VERDICT_CACHE_PATH)
  : null;
const taskVerdictDigestCache = new Map();
// D-008: programmer-error persist failures, counted so a broken store is visible on the summary
// line rather than only on a per-task stderr line. A non-empty list means reuse is BROKEN even
// though the suite itself is unaffected — the state that previously looked identical to health.
const taskVerdictPersistDefects = [];
const taskVerdictTrackedScan = TASK_VERDICT_CACHE_ENABLED
  ? listTrackedFiles(ROOT)
  : null;
const taskVerdictGuardKeys = new Set(
  selectedInvariantGuards.map(
    ({ workspace, script }) => `${workspace} :: ${script}`,
  ),
);
const taskVerdictSharedInputProvenance = TASK_VERDICT_CACHE_ENABLED
  ? passingTaskVerdictSharedInputProvenance({
      root: ROOT,
      trackedScan: taskVerdictTrackedScan,
    })
  : null;

/**
 * Selection base is not a runtime input for an ordinary workspace test. Repo-wide guards and
 * external integration suites are different: some derive their subject from base..HEAD, so their
 * real child environment and proof identity retain AFFECTED_BASE.
 */
function isOrdinaryReusableTask(t) {
  return (
    !taskVerdictGuardKeys.has(taskKey(t)) &&
    t.script !== "test:integration" &&
    t.script !== "test:el-suite"
  );
}

// WI-595883: what THIS run observed, so the NEXT run's `dependency-closure-changed` miss can name
// the moved path instead of reporting only that a hash differs. Read fails open — the sidecar can
// only ever improve an error message, so a missing or corrupt one must never affect the suite.
const TASK_VERDICT_CLOSURE_MANIFEST_PATH = closureDigestManifestPath(
  TASK_VERDICT_CACHE_PATH,
);
const taskVerdictClosureManifestRead = TASK_VERDICT_CACHE_ENABLED
  ? readClosureDigestManifest(TASK_VERDICT_CLOSURE_MANIFEST_PATH)
  : null;
/** taskKey -> { fileCount, listHash } for every semantic closure this run resolved. */
const taskVerdictClosureShapes = {};
// cacheGroup -> { envKey: digest } as this run computed it. Last writer wins: the identity
// environment is a property of the RUN, and the per-task variation that does exist
// (VITEST_MAX_*) is already stripped from the cross-run identity it is compared against.
const taskVerdictIdentityEnvByGroup = {};

function dependencyProvenanceForTask(t) {
  if (!TASK_VERDICT_CACHE_ENABLED) return null;
  if (t.guardBaseResolved === false) {
    return {
      ok: false,
      reason: "provenance-incomplete:affected-base-unresolved",
    };
  }
  const key = taskKey(t);
  const provenance = passingTaskVerdictDependencyProvenance({
    root: ROOT,
    taskKey: key,
    script: t.script,
    workspaceName: t.ws.name,
    workspaces: wsByName,
    trackedScan: taskVerdictTrackedScan,
    repoWideTaskKeys: taskVerdictGuardKeys,
    sharedInputProvenance: taskVerdictSharedInputProvenance,
    digestCache: taskVerdictDigestCache,
  });
  if (provenance?.ok) {
    const semantic = provenance.semantic;
    taskVerdictClosureShapes[key] = {
      fileCount: semantic.fileCount,
      listHash: semantic.listHash,
    };
  }
  return provenance;
}

/**
 * Explain one `dependency-closure-changed` miss on the line the A/B harness already greps.
 *
 * Best-effort by construction: a diagnostic that can abort the run would be strictly worse than
 * the unactionable string it replaces.
 */
function reportClosureDeltaForMiss(context, decision) {
  try {
    if (!TASK_VERDICT_CACHE_ENABLED || decision?.hit) return;
    const reason = String(decision?.reason ?? "");
    const manifestReason =
      taskVerdictClosureManifestRead?.reason ?? "manifest-disabled";
    const key = taskKey(context.t);
    if (reason.endsWith("environment-changed")) {
      // Namespacing is what tells us WHICH lookup produced the miss, and therefore which of the
      // two identity environments the stored entry was built from.
      const group = reason.startsWith("cross-run:")
        ? PASSING_TASK_VERDICT_CROSS_RUN_GROUP
        : TASK_VERDICT_CACHE_GROUP;
      const observed = taskVerdictIdentityEnvByGroup[group];
      if (!observed) return;
      errSync(
        formatIdentityEnvDeltaLine({
          taskKey: key,
          reason,
          manifestReason,
          delta: diffIdentityEnvDigests({
            prior: taskVerdictClosureManifestRead?.manifest?.identityEnv?.[group],
            observed,
          }),
        }),
      );
      return;
    }
    if (!reason.endsWith("dependency-closure-changed")) return;
    const provenance = context.cacheProvenance?.semantic;
    if (!provenance?.ok || !provenance.files) return;
    errSync(
      formatClosureDeltaLine({
        taskKey: key,
        reason,
        manifestReason,
        delta: diffClosureDigests({
          prior: taskVerdictClosureManifestRead?.manifest,
          observed: observedClosureDigests(ROOT, taskVerdictDigestCache),
          files: provenance.files,
          listHash: provenance.listHash,
          taskKey: key,
        }),
      }),
    );
  } catch {
    // Deliberately swallowed: see above.
  }
}

const taskVerdictGateConfig = {
  batchTimeout: {
    overrideMs: BATCH_TIMEOUT_OVERRIDE_MS,
    floorMs: BATCH_TIMEOUT_FLOOR_MS,
    headroomMultiplier: BATCH_TIMEOUT_HEADROOM_MULTIPLIER,
    quantumMs: BATCH_TIMEOUT_QUANTUM_MS,
    maxMs: BATCH_TIMEOUT_MAX_MS,
  },
  batchKillSignal: BATCH_KILL_SIGNAL,
  captureOutput: captureOutput(),
  scheduler: SCHEDULER_CONFIG,
  retryFailed,
  retryLoad1Threshold,
  freshRetryMaxFiles: FRESH_RETRY_MAX_FILES,
  runIntegration,
  runAll,
  runElSuite,
  laneScripts: LANE_SCRIPTS,
  excludes: [...excludes].sort(),
  quarantine: [...quarantined].sort(),
};

let failed = 0;
let quarantinedFailed = 0;
// A task that never established a trustworthy test verdict is NOT a real failed task, but it
// must keep the run non-green. Keep this count separate so gate triage does not invent a code
// failure from process-start starvation while the result marker still exposes the uncertainty.
let undeterminedTasks = 0;
// A guard REGISTERED `notCheckedIsNonGating: true` has declared UP FRONT that "I could not
// look" is its EXPECTED answer here. `lint:required-field-strands:typecheck` says so in its
// own registration: its subject is the WORKING DIFF, "so a gate checkout — clean by
// construction — makes it examine zero files and exit EXIT_NOT_CHECKED on every candidate.
// Non-gating is therefore mandatory, not defensive."
//
// Folding that answer into `undeterminedTasks` made the flag a promise this consumer never
// kept: classifyTaskExit correctly separated 'not-checked' from 'undetermined', and then both
// branches incremented the same gating counter. Every candidate scheduling such a guard was
// red-pinned by a guard that had explicitly declared it had no opinion — measured on candidate
// 57483d0491 (2026-08-30), where the gate's own log read "NOT CHECKED (exit 2) — verdict is
// UNDETERMINED; not retrying and keeping the affected-tests run non-green."
//
// Counted and reported LOUDLY below — missing coverage must stay visible, which was the real
// concern behind the old behaviour — but NOT gating, exactly as `quarantinedFailed` is. A guard
// WITHOUT the flag still classifies as a plain failure and lands in `failed`, so this can never
// turn an unregistered guard's silence into a green.
let notCheckedNonGating = 0;
// EI-19332556961886184: a non-quarantined failure whose own output ALSO shows a vitest
// hard-timeout signature ("Test/Hook timed out in Nms.") — tracked separately from
// `failed` so a triager can see "N failed, M of which show a timeout signature" instead
// of a bare "N failed" that collapses a load-correlated timeout and a real assertion
// break into the same red. Purely additive: never subtracted from `failed`, never
// changes the exit code or any retry/absorption decision.
let timedOutTasks = 0;
// P-006 / R-8 sub-requirement 5 — the test-coverage half of the verdict, which this path
// discarded while the CHEAP focused path (scripts/test-files.mjs) has stamped it since
// EI-19380376466745152. Folded at task settlement below; rendered onto the terminal
// AFFECTED_TESTS_RESULT line. NON-GATING by the same reasoning as `notCheckedNonGating`
// above: coverage that was not obtained is a non-verdict, and folding a non-verdict into a
// gating counter is what red-pinned candidate 57483d0491 for the whole fleet.
let coverage = emptyCoverage();
// The real counters now exist, so an abort during the run loop below — the long
// window this whole mechanism is about — reports what had actually happened when
// the signal landed, not the pre-run zeros. Declared here rather than at the top
// because a closure over these `let`s is a TDZ throw until this point.
readTerminalCounters = () => ({
  tasks: tasks.length,
  failed,
  quarantinedFailed,
  timedOutTasks,
  undeterminedTasks,
  // Carried through unchanged (WI-1048027 layer 2): these are observation counters, so
  // they must read the same before and after this upgrade. The tally fields above go
  // stale the instant the process dies mid-loop; these do not.
  observedNonzeroExits,
  observedAdmissionErrors,
});
// EI-2341 item 2: the final summary used to report only a COUNT of failed tasks,
// so finding WHICH task failed meant scrolling back through the whole run's
// interleaved output. Track names as we go and name them in the final summary.
const failedTaskNames = [];
const undeterminedTaskNames = [];
const notCheckedTaskNames = [];
// EI-19395701908500754: the per-FILE break set, accumulated as we go. `failedTaskNames`
// above names WORKSPACES; nothing named FILES, so triagers mined the gate's prose for
// them and got fixture paths. A failed task whose files cannot be named goes into
// `unattributedTasks` WITH ITS REASON rather than being silently absent — an empty file
// list must never be indistinguishable from "nothing failed".
const failedFileEntries = [];
const unattributedTasks = [];
// A retry can replace the initial task result with a rowless governed-admission or spawn
// failure. Keep the initial task-scoped bytes available for attribution, but use them only
// when the final retry output names no file; unioning both attempts would retain files that
// the fresh retry already proved passed.
const attributionFallbacks = [];
// WI-38300: failures that survived HARDEN-GATE absorption while the box was STILL loaded.
// They stay counted in `failed` — this list only drives the extra attribution a triager needs
// so nobody "fixes" tests that were never broken. See scripts/lib/load-suspect.mjs.
const loadSuspectTasks = [];
// WI-37607: the CULPRIT MODULES of any parse failure seen in a failed task's output. Accumulated
// separately from the two above because it is orthogonal to both: a module that fails to parse
// still yields FAIL rows for every file importing it, so the usual shape is a FULLY attributed
// break set (`coverage=complete`) whose every entry is a casualty. Measured 2026-08-09: 21 files,
// zero unattributed, one broken module — a peer mid-write on this shared tree.
const transformCulpritPaths = [];
// D-021/P-002: per-leg wall time, summed as SERIAL-EQUIVALENT task work. Before P-002 the tasks
// actually ran one at a time, so this was also phase wall time. They now overlap under the global
// scheduler envelope, which makes their sum useful work rather than elapsed time. A retry is
// recorded as an ADDITIONAL leg for the same task rather than folded into it, so flake-absorption
// cost stays separable from first-run cost.
const taskLegs = [];
// P-005: the phase's own WALL, derived from the legs rather than from a dispatch-boundary
// timestamp — a leg's end is now and its start is now minus its measured duration, so the
// earliest start and latest end ARE the phase envelope. This is the only place the number can be
// obtained: AFFECTED_TASK_PROGRESS lines carry no timestamps, and the log is not written in
// chronological order, so nothing downstream can reconstruct it from the transcript.
let phaseFirstStartMs = null;
let phaseLastEndMs = null;
const recordLeg = (task, ms) => {
  const end = Date.now();
  const start = end - (Number.isFinite(ms) && ms >= 0 ? ms : 0);
  if (phaseFirstStartMs === null || start < phaseFirstStartMs) phaseFirstStartMs = start;
  if (phaseLastEndMs === null || end > phaseLastEndMs) phaseLastEndMs = end;
  taskLegs.push({ name: `${task.ws.name} :: ${task.script}`, ms });
};
const taskContexts = tasks.map((t) => ({
  t,
  isQuarantined: quarantined.has(t.ws.name),
  coverageArgs: coverageArgsFor(t),
  // EI-11132: when this script declares --passWithNoTests AND the workspace genuinely
  // has matching test files on disk, disable passWithNoTests for THIS task.
  // A guard that diffs git must see the same base this runner used to select it;
  // otherwise a clean-after-git-sync tree looks like a no-op to the child process.
  guardArgs: [
    ...emptySuiteGuardArgs({
      scriptText: t.ws.scripts[t.script] ?? "",
      wsAbsDir: join(ROOT, t.ws.dir),
      script: t.script,
    }),
    ...(t.guardArgs ?? []),
    ...(t.guardBase ? ["--base", t.guardBase] : []),
  ],
  cacheProvenance: dependencyProvenanceForTask(t),
}));
const TASK_CONTEXT_SHARD_PLAN = planAffectedTaskShards(taskContexts, {
  blastRadius: TASK_BLAST_RADIUS,
  maxTasksPerShard: TASK_SHARD_MAX,
  taskKey: (context) => taskKey(context.t),
});
const durationHistory = readDurationHistory(TASK_DURATION_HISTORY_PATH);
const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;

/**
 * Async captured child runner. `spawn` keeps the parent event loop free so the scheduler can
 * overlap tasks, while buffering lets the reporting loop below replay whole task records in
 * declaration order. Each child gets ITS allocation as the Vitest cap; the sum is bounded by
 * SCHEDULER_CONFIG, so this cannot multiply the former per-workspace WORKER_CAP.
 */
function runCapturedTask(
  context,
  allocation,
  extraArgs = [],
  scriptOverride = null,
  journalLabel = "initial",
) {
  const spawnTask = scriptOverride
    ? { ...context.t, script: scriptOverride }
    : context.t;
  const spawnTaskKey = taskKey(spawnTask);
  // EI-20803703725014949: the WATCHDOG bound uses the peak-aware estimate, not
  // the ordering EWMA — an EWMA of a bimodal task (lane-stateful: ~7m vs ~45m)
  // collapses the timeout to the floor and turns it into a coin flip against
  // the honest slow mode. Ordering (estimateMs at runBudgetedTasks) keeps the EWMA.
  const taskDurationMs = timeoutDurationEstimate(durationHistory, spawnTaskKey);
  // P-004 (gate-latency-selection-and-retry-policy-2026-09-06): a RETRY carries its own budget,
  // derived by deriveRetryBudget from the first pass this runner just measured (and the task's
  // history), floored and capped. It replaces the history watchdog outright and is also the
  // progress-extension ceiling below, so the budget is a HARD bound: a retry that keeps emitting
  // past it is still killed. The initial pass is untouched — `__retry` is only ever set by the
  // retry pool.
  const retryBudgetMs =
    Number.isFinite(context.__retry?.budgetMs) && context.__retry.budgetMs > 0
      ? context.__retry.budgetMs
      : null;
  const taskTimeoutMs =
    retryBudgetMs ??
    resolveTaskTimeoutMs({
      overrideMs: BATCH_TIMEOUT_OVERRIDE_MS,
      floorMs: BATCH_TIMEOUT_FLOOR_MS,
      durationMs: taskDurationMs,
      headroomMultiplier: BATCH_TIMEOUT_HEADROOM_MULTIPLIER,
      quantumMs: BATCH_TIMEOUT_QUANTUM_MS,
      maxMs: BATCH_TIMEOUT_MAX_MS,
    });
  const taskTimeoutSource =
    retryBudgetMs != null
      ? "retry-budget"
      : BATCH_TIMEOUT_OVERRIDE_MS != null
        ? "override"
        : taskDurationMs == null || taskTimeoutMs === BATCH_TIMEOUT_FLOOR_MS
          ? "floor"
          : taskTimeoutMs === BATCH_TIMEOUT_MAX_MS
            ? "history-capped"
            : "history";
  const watchdogCeilingMs = retryBudgetMs ?? BATCH_TIMEOUT_MAX_MS;
  const {
    cmd,
    argv,
    cwd,
    env: specEnv,
    // `--related` narrowing applies ONLY to the initial, complete invocation. A
    // targeted retry already carries its own explicit file list in extraArgs, and
    // appending the selection there would widen the very run that exists to isolate
    // one file. (The passing-verdict cache keys on the full argv, so a narrowed run
    // gets a distinct identity and can never be replayed as a full-suite pass.)
  } = spawnSpecFor(spawnTask, [
    ...context.guardArgs,
    // P-009 part (a). Ahead of extraArgs because a targeted retry's extraArgs are
    // positional FILE paths, and vitest reads anything after them as more paths.
    // A retry therefore stays instrumented, which is what makes the merged report
    // describe the run that actually produced the verdicts.
    ...(context.coverageArgs ?? []),
    ...extraArgs,
  ]);
  // P-001 (gate-latency-selection-and-retry-policy-2026-09-06): the related selection used to
  // ride on argv here. `npm run … -- <files>` folds every argument into ONE `sh -c` string and
  // Linux caps a single argv entry at 128 KiB, so a 3,849-file operator-core selection
  // (~180 KB) would have died E2BIG — the 0.5 widening threshold merely hid that by never
  // narrowing past ~3,200 files. The selection now travels as a content-addressed JSON file
  // named by PC_TEST_FILTER_LIST, which @papercusp/test-config's defineVitestConfig applies to
  // `include` (intersecting a lane's explicit list, so lane semantics are preserved exactly as
  // the positional-filter form preserved them). Same scoping rule as before: only the initial,
  // complete invocation is narrowed; a targeted retry already carries its own file list.
  const relatedFilterList =
    extraArgs.length === 0 && Array.isArray(spawnTask.relatedFiles) && spawnTask.relatedFiles.length > 0
      ? writeRelatedFilterList(RUN_LOG_ROOT, spawnTask.relatedFiles)
      : null;
  // P-008 (gate-file-level-test-reuse-2026-09-27): the task's per-file pass-reuse skip list, armed
  // by armTestPassReuse. Same scoping as the related selection: only the initial, complete
  // invocation of the task's OWN script — a retry or override runs exactly what it names. A value
  // inherited from an outer environment is stripped, so a skip list never leaks across runs.
  const reuseSkipList =
    extraArgs.length === 0 && scriptOverride == null && spawnTask.reuseSkipList
      ? spawnTask.reuseSkipList
      : null;
  // WI-10003603: where this task's executed-source-map reporter reports what its flush DID. Same
  // scoping as the skip list (the initial, complete invocation of a recording task only), so the
  // phase-C report reads exactly one invocation per task. An inherited value is stripped.
  const recordsExecutedMap =
    executedMapRecordingEnabled() &&
    (spawnTask.script === "test" || LANE_SCRIPTS.includes(spawnTask.script));
  const executedMapResultFile =
    recordsExecutedMap && extraArgs.length === 0 && scriptOverride == null
      ? executedMapResultPath(RUN_LOG_ROOT, RUN_TOKEN, `${context.t.ws.name}::${context.t.script}`)
      : null;
  const {
    [TEST_REUSE_SKIP_LIST_ENV]: _inheritedReuseSkipList,
    [EXECUTED_MAP_RESULT_ENV]: _inheritedExecutedMapResult,
    ...parentEnv
  } = process.env;
  const childEnv = {
    ...parentEnv,
    ...(specEnv ?? {}),
    ...(relatedFilterList ? { [RELATED_FILTER_LIST_ENV]: relatedFilterList.path } : {}),
    ...(reuseSkipList ? { [TEST_REUSE_SKIP_LIST_ENV]: reuseSkipList.path } : {}),
    // P-002 (gate-latency-selection-and-retry-policy-2026-09-06): arm the executed-source-map
    // reporter on every unit vitest task (the `test` script and the lane split), naming the
    // workspace whose map it records. The reporter itself rails the recording to a CLEAN,
    // isolated, passing run — so on the shared dirty checkout this stamps and records nothing,
    // and only the gate's checkpoint checkout actually writes rows. Integration/el-suite/guard
    // tasks are not narrowable and get no stamp.
    ...(recordsExecutedMap ? { [EXECUTED_MAP_WORKSPACE_ENV]: spawnTask.ws.name } : {}),
    ...(executedMapResultFile ? { [EXECUTED_MAP_RESULT_ENV]: executedMapResultFile } : {}),
    // P-006 (design-to-code-coverage-seam-2026-09-02): arm coverage attribution for every task
    // this runner spawns, so a `test:affected` run contributes surface→test evidence the way
    // `testing:run` and the admin-UI runner already do. Inert unless a seam is exercised — the
    // first statement in each hook is a cached boolean (see coverage-census/attribution/context.ts).
    //
    // ⚠ THIS ARMS BOTH LANES AND ONLY ONE OF THEM CAN WRITE. The UNIT lane runs under
    // `setup-no-real-pg.ts` (PAPERCUSP_FORBID_REAL_PG=1) and the sink's flush stands down on that
    // rail by design, so unit tasks OBSERVE and never PERSIST. `--integration` carries no such
    // rail and is where a row can actually land. A zero from a unit-only run is therefore not a
    // coverage measurement at all; the falsifiable version of that claim is
    // packages/operator-core/lib/coverage-census/attribution/seam-reachability.test.ts.
    //
    // Note for the passing-task-verdict cache: this is part of the complete child-env hash, so
    // adding it invalidates cached verdicts ONCE. It is a constant thereafter, so reuse is
    // unaffected from the next run on.
    PAPERCUSP_TEST_ATTRIBUTION: "1",
    VITEST_MAX_WORKERS: String(allocation.workers),
    VITEST_MAX_FORKS: String(allocation.workers),
    VITEST_MAX_THREADS: String(allocation.workers),
  };
  // This runner can itself be the direct child of pc-heavy's once-only
  // after-ready/finalization barrier. Those marker paths belong to THIS
  // affected-tests process: forwarding them into a nested workspace-test
  // router makes that router collide with its live parent and refuse the test
  // with EEXIST before executing a single assertion. Nested children own no
  // outer barrier, so keep the same boundary testing:run already enforces.
  delete childEnv.PC_HEAVY_PREEMPT_READY_FILE;
  delete childEnv.PC_HEAVY_PSI_FINALIZATION_FILE;
  // Remove the selector from the REAL process, not merely from a hash clone. This makes the
  // ordinary-task contract structural: if a test starts reading AFFECTED_BASE later it observes
  // no task input, while base-dependent guards/integration suites keep the value unchanged.
  if (isOrdinaryReusableTask(context.t)) {
    delete childEnv.AFFECTED_BASE;
  }
  let cacheIdentity = null;
  let crossRunCacheIdentity = null;
  let cacheDecision = null;
  // Only the initial, complete task invocation is reusable. A targeted/fresh retry is evidence
  // used to classify a failure from THIS candidate, never a new passing verdict for the whole
  // task. That distinction prevents a one-file retry from being replayed as a full-suite pass.
  if (
    TASK_VERDICT_CACHE_ENABLED &&
    extraArgs.length === 0 &&
    scriptOverride == null
  ) {
    if (context.cacheProvenance?.ok) {
      const {
        environment: perRunCacheIdentityEnvironment,
        cacheGroup: perRunCacheGroup,
      } = passingTaskVerdictIdentityEnvironment(childEnv);
      let cacheIdentityEnvironment = perRunCacheIdentityEnvironment;
      let childCacheGroup = perRunCacheGroup;
      if (TASK_VERDICT_LOCAL_CROSS_RUN_ONLY && !perRunCacheGroup) {
        // No gate proof exists for ordinary local `npm test`; use the already-defined stable
        // cross-run identity instead of inventing a shared child PAPERCUSP_TEST_RUN_GROUP.
        const localCrossRun = passingTaskVerdictCrossRunIdentityEnvironment(childEnv);
        cacheIdentityEnvironment = localCrossRun.environment;
        childCacheGroup = localCrossRun.cacheGroup;
      }
      if (!childCacheGroup) {
        cacheDecision = { hit: false, reason: "proof-group-missing" };
      } else if (childCacheGroup !== TASK_VERDICT_CACHE_GROUP) {
        cacheDecision = { hit: false, reason: "proof-group-mismatch" };
      } else {
        // Everything in the identity EXCEPT the environment, which is the only component that
        // differs between the per-run and cross-run identities. Shared so the two can never
        // drift apart: a field added to one would otherwise silently weaken the other.
        const cacheIdentitySpec = {
          taskKey: taskKey(context.t),
          command: {
            cmd,
            argv,
            cwd,
            scriptText: spawnTask.ws.scripts[spawnTask.script] ?? null,
            // P-001: the selection left argv for an env-named file, so it is pinned here
            // EXPLICITLY (not just via the env hash) — a narrowed run must never be replayed
            // as a full-suite pass, and two different selections must never alias.
            relatedFilterDigest: relatedFilterList?.digest ?? null,
            // P-008: a run that skipped reused files is pinned by its skip list, so it can never
            // be replayed as a run that executed them.
            reuseSkipDigest: reuseSkipList?.digest ?? null,
          },
          gateConfig: {
            ...taskVerdictGateConfig,
            // `scheduler` is the RESOLVED HOST BUDGET (worker/fork allocation, concurrency, pid
            // envelope) that resolveTaskBudget derived from this box AT LAUNCH. It describes how
            // much machine the run was handed, never what the task exercises — and it moves with
            // host load on every invocation, so hashing it makes cross-run reuse structurally
            // unable to hit: the second of two identical local runs missed with
            // `gate-config-changed` every time until this was neutralised.
            //
            // This is the SAME quantity the environment component already normalises out on
            // purpose (VITEST_MAX_FORKS/WORKERS/THREADS — see the "ignores run group and fork
            // allocation" test); SCHEDULER_WORKER_BUDGET is derived from those very variables
            // (affected-tests.mjs:456-462), so gateConfig was silently re-admitting by another
            // route what the environment clone had just excluded. Excluding it here therefore
            // widens reuse by exactly NOTHING that was not already ratified as irrelevant.
            //
            // CACHE IDENTITY ONLY — the real scheduler config is untouched and still governs
            // execution. Measured: with this neutralised, run 2 of an unchanged pair reports
            // `cross-run:identity-match` and spawns zero tasks.
            scheduler: null,
            // A local run may derive its base from the test-certified watermark rather than an
            // exported AFFECTED_BASE variable. Include the resolved selector explicitly so a
            // watermark/base transition cannot silently reuse an older proof.
            affectedBase: base,
            batchTimeout: {
              ...taskVerdictGateConfig.batchTimeout,
              effectiveMs: taskTimeoutMs,
              source: taskTimeoutSource,
            },
          },
          dependencyHash: context.cacheProvenance.semantic.hash,
        };
        cacheIdentity = buildPassingTaskVerdictIdentity({
          ...cacheIdentitySpec,
          // Hashing happens inside the helper; raw environment values (including credentials) are
          // never written to the cache. Keeping the COMPLETE env is conservative: an unfamiliar
          // variable cannot silently become relevant without invalidating reuse.
          environment: cacheIdentityEnvironment,
        });
        cacheDecision = decidePassingTaskVerdict({
          enabled: true,
          cacheRead: taskVerdictCacheRead,
          entry: passingTaskVerdictCacheEntry(
            taskVerdictCacheRead.cache,
            childCacheGroup,
            taskKey(context.t),
          ),
          identity: cacheIdentity,
        });
        if (TASK_VERDICT_LOCAL_CROSS_RUN_ONLY) {
          cacheDecision = namespacePassingTaskVerdictDecision(
            cacheDecision,
            "cross-run",
          );
        }
        // EI-21577710345620735 — CROSS-RUN reuse. The lookup above is confined to THIS run's
        // group, which is why a red gate re-tests the ~100 tasks that already passed: their
        // proof exists, under last run's group, and is unreachable. On a per-run miss, retry
        // against the stable cross-run group.
        //
        // This does NOT weaken the gate. The cross-run entry is admitted by the SAME
        // decidePassingTaskVerdict identity check, whose dependencyHash is the content sha256
        // of the task's whole dependency closure and which fails closed on any enumeration gap.
        // A hit therefore means "this exact task, same command and config, and not one byte it
        // reads has changed" — re-running it could not produce different information.
        // Computed unconditionally, not just on a miss: a task that actually RUNS and passes has
        // to be storable under the cross-run group, or the very first run would write nothing for
        // the next one to reuse and the feature would be inert.
        const { environment: crossRunEnvironment, cacheGroup: crossRunGroup } =
          passingTaskVerdictCrossRunIdentityEnvironment(childEnv);
        crossRunCacheIdentity = buildPassingTaskVerdictIdentity({
          ...cacheIdentitySpec,
          // D-004/WI-1024071: selection base is task-shaped, not globally irrelevant. Ordinary
          // reusable children receive no AFFECTED_BASE at all and bind their actual workspace,
          // transitive dependency, runner, and config inputs in dependencyHash. Repo-wide guards
          // retain AFFECTED_BASE and, when they consume it, carry a resolved immutable --base in
          // their command identity; an unresolved required base disabled provenance above.
          // Normalising the selector-shaped gate field here therefore removes no real input.
          // ONE definition, shared with the test that proves it: the neutralised set and the
          // reason each field is self-invalidating live on
          // `passingTaskVerdictCrossRunGateConfig`, beside its environment-side sibling. The
          // derived task TIMEOUT is neutralised there too — it comes from duration history, so
          // every run moved the next run's gateConfig hash and reuse could never hit twice.
          gateConfig: passingTaskVerdictCrossRunGateConfig(cacheIdentitySpec.gateConfig),
          environment: crossRunEnvironment,
        });
        // WI-595883: per-variable digests, so the NEXT run's `environment-changed` miss names the
        // variable instead of asserting that one of ~126 moved. Digests only — this environment
        // carries live credentials and none of them are ever written to disk.
        taskVerdictIdentityEnvByGroup[crossRunGroup] =
          identityEnvDigests(crossRunEnvironment);
        if (TASK_VERDICT_CACHE_GROUP) {
          taskVerdictIdentityEnvByGroup[TASK_VERDICT_CACHE_GROUP] =
            identityEnvDigests(cacheIdentityEnvironment);
        }
        if (!cacheDecision.hit) {
          const crossRunDecision = decidePassingTaskVerdict({
            enabled: true,
            cacheRead: taskVerdictCacheRead,
            entry: passingTaskVerdictCacheEntry(
              taskVerdictCacheRead.cache,
              crossRunGroup,
              taskKey(context.t),
            ),
            identity: crossRunCacheIdentity,
          });
          cacheDecision = namespacePassingTaskVerdictDecision(
            crossRunDecision,
            "cross-run",
          );
        }
      }
    } else {
      cacheDecision = {
        hit: false,
        reason: context.cacheProvenance?.reason ?? "provenance-incomplete",
      };
    }
    reportClosureDeltaForMiss(context, cacheDecision);
    if (cacheDecision.hit) {
      return Promise.resolve({
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null,
        __elapsedMs: 0,
        __timeoutMs: taskTimeoutMs,
        __timeoutSource: taskTimeoutSource,
        __durationEstimateMs: taskDurationMs,
        __capturedBytes: 0,
        __cacheStatus: "hit",
        __cacheReason: cacheDecision.reason,
        __cacheIdentity: cacheIdentity,
        __crossRunCacheIdentity: crossRunCacheIdentity,
      });
    }
  }
  // One durable receipt covers the whole resident npm -> shell -> Vitest tree.
  // The scheduler's worker allocation is a reservation for this process, not a
  // second concurrency ceiling; the close path below replaces it with measured
  // peak residency before Governor.release(actualDemand).
  const processDemand = buildGovernedProcessDemand({
    memoryBytes: Math.max(1, allocation.memoryMb) * 1024 * 1024,
    diskBytes: MAX_CAPTURE_BYTES,
    fileDescriptors: 16 + Math.max(1, allocation.workers),
  });
  // A lane retry deliberately rewrites both `test:lane-pure` and
  // `test:lane-stateful` to the default `test` script for isolated execution.
  // If the durable identity includes only that rewritten task, two concurrent
  // retry-pool entries alias the same receipt and one fails as "not leaseable".
  // Retain the declared task key as the per-entry identity while also recording
  // the command shape that actually ran.
  const processIdentity = `${taskKey(context.t)}=>${taskKey(spawnTask)}:${journalLabel}`;
  // WI-10003603: registered only once the task really spawns (a cache hit returned above), so the
  // phase-C report never reads a result for a run that did not happen.
  if (executedMapResultFile) {
    clearExecutedMapResult(executedMapResultFile);
    executedMapResultFiles.set(taskKey(context.t), executedMapResultFile);
    // WI-10003792: judged from the task's REAL script + config, so a silent enrolled task alarms
    // and a task that never could report (non-vitest, exempt config) does not.
    executedMapReportExpectations.set(
      taskKey(context.t),
      resolveTaskReportExpectation({
        command: context.t.ws.scripts?.[context.t.script],
        wsDir: join(ROOT, context.t.ws.dir),
      }),
    );
  }
  const governedOptions = {
    workspaceId: process.env.PAPERCUSP_WORKSPACE_ID ?? process.env.PAPERCUSP_WORKSPACE,
    namespace: "affected-tests-process",
    owner: `affected-tests:${RUN_TOKEN}`,
    idempotencyKey: governedProcessIdempotencyKey("affected-tests", `${RUN_TOKEN}:${processIdentity}`),
    payloadRef: `affected-tests:${RUN_TOKEN}`,
    timeoutMs: taskTimeoutMs,
    demand: processDemand,
    metadata: {
      processKind: "affected-tests-task",
      task: processIdentity,
      workers: allocation.workers,
      timeoutMs: taskTimeoutMs,
    },
    env: childEnv,
    settle: classifyGovernedTestProcessOutcome,
  };
  return runGovernedTestProcess(
    governedOptions,
    (_admissionContext, governedEnv, { inherited }) => new Promise((resolveRun) => {
    const startedAt = Date.now();
    const stdout = [];
    const stderr = [];
    let capturedBytes = 0;
    let spawnError = null;
    let captureError = null;
    let settled = false;
    let watchdogTimedOut = false;
    const progressTask = JSON.stringify(taskKey(spawnTask));
    let child;
    const sampler = createGovernedProcessDemandSampler(processDemand);
    try {
      child = spawn(cmd, argv, {
        cwd,
        env: governedEnv,
        stdio: ["ignore", "pipe", "pipe"],
        // Own a process group so the watchdog can reap npm -> shell -> vitest ->
        // worker descendants together. A direct-child kill leaves descendants
        // holding these capture pipes and made a 45m timeout close at 49.8m.
        detached: true,
      });
    } catch (error) {
      // Node normally reports child startup failures through the `error` event, but
      // E2BIG is thrown synchronously before a ChildProcess exists. Letting that throw
      // escape rejects the scheduler shard and aborts the whole runner without naming
      // the task. Return the same captured-task shape as the async error path so the
      // reporting loop emits `>>> <workspace> spawn error`, counts one attributed red,
      // and still reaches an AFFECTED_TESTS_RESULT terminal verdict.
      spawnError =
        error instanceof Error
          ? error
          : new Error(String(error ?? "spawn failed"));
      const outcome = formatTaskOutcomeFields({
        status: 1,
        signal: null,
        settled: true,
      });
      const result = {
        status: 1,
        signal: null,
        stdout: "",
        stderr: "",
        error: spawnError,
        __elapsedMs: Date.now() - startedAt,
        __timeoutMs: taskTimeoutMs,
        __timeoutSource: taskTimeoutSource,
        __durationEstimateMs: taskDurationMs,
        __capturedBytes: 0,
        __watchdogTimedOut: false,
        __watchdogDeadlineMs: taskTimeoutMs,
        __watchdogKillReason: null,
        actualDemand: sampler.stop({ diskBytes: 0 }),
        __admissionReceiptId: _admissionContext.receiptId ?? null,
        __admissionInherited: inherited,
        ...(cacheDecision
          ? {
              __cacheStatus: "miss",
              __cacheReason: cacheDecision.reason,
              __cacheIdentity: cacheIdentity,
              __crossRunCacheIdentity: crossRunCacheIdentity,
            }
          : {}),
      };
      // EI-21495798160539116: publish the durable record BEFORE the live
      // settlement pulse. A supervisor may terminate the aggregate runner as
      // soon as it observes that pulse; the record must already be recoverable.
      result.__outputJournaled = journalCapturedTaskOutput(
        spawnTask,
        result,
        allocation,
        journalLabel,
      );
      rawErrSync(
        `AFFECTED_TASK_PROGRESS state=spawn-error task=${progressTask} ` +
          `elapsedSec=${Math.floor((Date.now() - startedAt) / 1000)} capturedBytes=0 ` +
          `stalledForSec=0 timeoutMs=${taskTimeoutMs} timeoutSource=${taskTimeoutSource} ` +
          `durationEstimateMs=${taskDurationMs ?? "unknown"} ` +
          `exitStatus=${outcome.exitStatus} signal=${outcome.signal} ` +
          `watchdogDeadlineMs=${taskTimeoutMs}`,
      );
      resolveRun(result);
      return;
    }
    // Start sampling only after the actual child exists. A queued wait is not
    // process residency and must not be charged to this receipt.
    sampler.attach(child.pid);
    // EI-21048499991398082: `status`/`signal` are Node's `child.close(code, signal)` pair,
    // which is MUTUALLY EXCLUSIVE by construction — a normal exit has a numeric `code` and a
    // `null` signal; a signal-killed process has a `null` code and a signal name. Both are
    // "known" the moment `close` fires. The two non-terminal call sites below
    // ("started"/"running"/"watchdog-extended"/"watchdog-firing") pass NEITHER argument, so
    // their `null` genuinely means "not yet knowable" — that is what `"pending"` is for.
    // Collapsing BOTH meanings of `null` onto the same `"pending"` string (the bug: a bare
    // `?? "pending"` with no way to tell the two apart) makes a TERMINAL line — e.g.
    // `state=finished exitStatus=0 signal=pending` — read as "this task's outcome is still
    // unresolved" even though `state=finished` already says it settled cleanly. A reader (or a
    // future log-summarizer) scanning for "which tasks have a fully-known outcome" by requiring
    // BOTH fields to be non-"pending" would then misclassify every clean pass as still-open —
    // exactly the false-red shape reported in EI-21048499991398082 ("exit-0 tasks reported as
    // FAILED"). `settled` distinguishes the two: only true from the `child.once("close", ...)`
    // call below, where a `null` field is a DEFINITE "not applicable" (`"none"`), never
    // "pending".
    // WI-1048027 layer 2: at most ONE increment per task. A task can emit a settled beat
    // more than once (a watchdog kill racing the child's own exit), and an observation
    // counter that double-counts is worse than no counter — it would manufacture a
    // phantom TALLY-UNDERCOUNT on a run that was actually tallied correctly.
    let countedNonzeroExit = false;
    const emitProgress = (
      state,
      status = null,
      signal = null,
      settled = false,
    ) => {
      // Deliberately bypass the ordered replay buffer: this tiny, self-identifying marker is
      // the live pulse consumed by green-checkpoint while the child output remains captured.
      // It contains no child bytes, so concurrent tasks cannot misattribute test output.
      const outcome = formatTaskOutcomeFields({ status, signal, settled });
      // Deliberately narrow: only an UNAMBIGUOUS non-clean settlement counts — a nonzero
      // numeric status, or death by signal. A settled beat carrying neither (status null,
      // no signal) is the "undetermined" case, which has its own counter; folding it in
      // here would inflate this one and cost it the credibility that makes the
      // TALLY-UNDERCOUNT note worth trusting.
      const exitedNonzero =
        (typeof status === "number" && status !== 0) || Boolean(signal);
      if (settled && exitedNonzero && !countedNonzeroExit) {
        countedNonzeroExit = true;
        observedNonzeroExits++;
      }
      rawErrSync(
        `AFFECTED_TASK_PROGRESS state=${state} task=${progressTask} ` +
          `elapsedSec=${Math.floor((Date.now() - startedAt) / 1000)} capturedBytes=${capturedBytes} ` +
          // WI-41180: `elapsedSec` rises identically whether the task is working or
          // idle-deadlocked, and `capturedBytes` only reveals a wedge by DIFFING two
          // beats — which a reader has to think to do, and an agent watching one beat
          // cannot do at all. `stalledForSec` states it outright, from the very
          // `lastProgressAt` the kill policy already consults. Read it, not elapsedSec,
          // to tell "slow" from "dead": a large value on `state=running` means the
          // child has emitted NOTHING for that long.
          `stalledForSec=${Math.floor(watchdog.msSinceProgress / 1000)} ` +
          `timeoutMs=${taskTimeoutMs} timeoutSource=${taskTimeoutSource} ` +
          `durationEstimateMs=${taskDurationMs ?? "unknown"} ` +
          `exitStatus=${outcome.exitStatus} signal=${outcome.signal} ` +
          // The EFFECTIVE deadline, which a progress-extension moves past taskTimeoutMs.
          // Reported so a log reader is never left computing a kill against a bound that
          // no longer applied. green-checkpoint consumes this line by prefix, so the
          // trailing field is additive.
          `watchdogDeadlineMs=${watchdog.deadlineMs}`,
      );
    };
    // EI-20803703725014949: the deadline is a CHECKPOINT, not a verdict. A synchronous
    // spin — the thing this watchdog exists to kill — is SILENT, so its output goes flat
    // and stays flat. A merely-slow suite keeps completing files and emits right into the
    // wall. Killing on elapsed time alone cannot tell them apart, so under fleet load this
    // SIGKILLed live work and red-pinned the gate for a non-code reason (RUN 9 lost
    // lane-stateful at exactly 2700s with captured output still climbing,
    // 762,401B@2340s -> 797,873B@2700s). The signal was already here: `capturedBytes`
    // advances on every chunk, and it was only ever read AFTER the kill to word the report.
    // Policy + its two safety properties (MONOTONE — never kills earlier than the time-only
    // watchdog did; BOUNDED — extensions stop at BATCH_TIMEOUT_MAX_MS, under the ~120m gate
    // ceiling) live in decideWatchdogExpiry, unit-tested with these measured numbers.
    const watchdog = createProgressAwareWatchdog({
      timeoutMs: taskTimeoutMs,
      // P-004: a retry's ceiling IS its budget (see retryBudgetMs above); the initial pass keeps
      // the gate-wide BATCH_TIMEOUT_MAX_MS so its extension policy is byte-identical to before.
      maxMs: watchdogCeilingMs,
      stallWindowMs: BATCH_TIMEOUT_QUANTUM_MS,
      extensionMs: BATCH_TIMEOUT_QUANTUM_MS,
      onExtend: () => emitProgress("watchdog-extended"),
      onKill: () => {
        if (settled) return;
        watchdogTimedOut = true;
        emitProgress("watchdog-firing");
        killSpawnedProcessTree(child, BATCH_KILL_SIGNAL);
      },
    });
    let progressTimer = null;
    const scheduleProgress = () => {
      progressTimer = setTimeout(() => {
        if (settled) return;
        emitProgress("running");
        scheduleProgress();
      }, 60_000);
      progressTimer.unref?.();
    };
    emitProgress("started");
    scheduleProgress();
    const capture = (chunks) => (chunk) => {
      capturedBytes += chunk.length;
      // The live forward-progress reading the watchdog consults at its deadline. Bytes
      // arriving IS progress: a synchronously-spinning worker cannot emit any.
      watchdog.noteProgress();
      if (capturedBytes <= MAX_CAPTURE_BYTES) {
        chunks.push(chunk);
      } else if (!captureError) {
        captureError = Object.assign(
          new Error(
            `${taskKey(context.t)} exceeded the ${MAX_CAPTURE_BYTES}-byte capture ceiling`,
          ),
          { code: "ENOBUFS" },
        );
        killSpawnedProcessTree(child, BATCH_KILL_SIGNAL);
      }
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      watchdog.stop();
      if (progressTimer) clearTimeout(progressTimer);
      const result = {
        status,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        error: captureError ?? spawnError,
        __elapsedMs: Date.now() - startedAt,
        __timeoutMs: taskTimeoutMs,
        __timeoutSource: taskTimeoutSource,
        __durationEstimateMs: taskDurationMs,
        __capturedBytes: capturedBytes,
        __watchdogTimedOut: watchdogTimedOut,
        __watchdogDeadlineMs: watchdog.deadlineMs,
        __watchdogKillReason: watchdog.killReason,
        actualDemand: sampler.stop({ diskBytes: capturedBytes }),
        __admissionReceiptId: _admissionContext.receiptId ?? null,
        __admissionInherited: inherited,
        ...(cacheDecision
          ? {
              __cacheStatus: "miss",
              __cacheReason: cacheDecision.reason,
              __cacheIdentity: cacheIdentity,
              __crossRunCacheIdentity: crossRunCacheIdentity,
            }
          : {}),
      };
      // The ordered console replay still waits for the whole shard, but its
      // durable counterpart cannot: a later task may run for minutes and the
      // aggregate process may be TERM/KILLed meanwhile. Persist this completed
      // task first, synchronously, then advertise state=finished.
      result.__outputJournaled = journalCapturedTaskOutput(
        spawnTask,
        result,
        allocation,
        journalLabel,
      );
      emitProgress(
        watchdogTimedOut
          ? "watchdog-killed"
          : captureError
            ? "capture-killed"
            : spawnError
              ? "spawn-error"
              : "finished",
        status,
        signal,
        /* settled */ true,
      );
      resolveRun(result);
    });
    }),
  ).catch((error) => {
    // Admission/loader failures are attributed to this task rather than
    // rejecting the scheduler shard and losing the terminal run marker.
    const message = error instanceof Error ? error.message : String(error);
    const result = {
      status: 1,
      signal: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error(message), { code: "GOVERNED_ADMISSION_FAILED" }),
      __elapsedMs: 0,
      __timeoutMs: taskTimeoutMs,
      __timeoutSource: taskTimeoutSource,
      __durationEstimateMs: taskDurationMs,
      __capturedBytes: 0,
      __watchdogTimedOut: false,
      __watchdogDeadlineMs: taskTimeoutMs,
      __watchdogKillReason: null,
      __governedAdmissionError: true,
      ...(cacheDecision
        ? {
            __cacheStatus: "miss",
            __cacheReason: cacheDecision.reason,
            __cacheIdentity: cacheIdentity,
            __crossRunCacheIdentity: crossRunCacheIdentity,
          }
        : {}),
    };
    result.__outputJournaled = journalCapturedTaskOutput(spawnTask, result, allocation, journalLabel);
    // WI-1048027 layer 2: THE run-4 case, counted at observation. This path never reaches
    // emitProgress, so it cannot double-count with the guard there. The task exits 1 without
    // ever running, and the run loop's `failed++` for it is exactly what run 4's crash
    // pre-empted — leaving a verdict of failed=0 while this admission error sat in the log
    // three lines above it.
    observedNonzeroExits++;
    observedAdmissionErrors++;
    rawErrSync(
      `AFFECTED_TASK_PROGRESS state=governed-admission-error task=${JSON.stringify(taskKey(spawnTask))} ` +
        `elapsedSec=0 capturedBytes=0 stalledForSec=0 timeoutMs=${taskTimeoutMs} ` +
        `timeoutSource=${taskTimeoutSource} durationEstimateMs=${taskDurationMs ?? "unknown"} ` +
        `exitStatus=1 signal=none reason=${JSON.stringify(message)}`,
    );
    return result;
  });
}

/**
 * Persist one completed task before the aggregate scheduler advances.
 *
 * Child bytes remain buffered for declaration-ordered console replay. The run
 * log has a different durability requirement: it must retain every task that
 * already settled even if a signal kills the parent while another task is still
 * running. The BEGIN/END envelope keeps settlement-ordered records attributable.
 */
function journalCapturedTaskOutput(t, r, allocation, label) {
  const task = JSON.stringify(taskKey(t));
  const outcome = formatTaskOutcomeFields({
    status: r.status,
    signal: r.signal,
    settled: true,
  });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  const lastOutput = stderr || stdout;
  const beforeFooter = lastOutput && !lastOutput.endsWith("\n") ? "\n" : "";
  const error = r.error ? JSON.stringify(r.error.message) : "none";
  try {
    appendAllSync(RUN_LOG_PATH, [
      `\nAFFECTED_TASK_OUTPUT_BEGIN task=${task} label=${label} ` +
        `lane=${allocation.lane} workers=${allocation.workers} memoryMb=${allocation.memoryMb} ` +
        `exitStatus=${outcome.exitStatus} signal=${outcome.signal} ` +
        `capturedBytes=${r.__capturedBytes ?? 0} error=${error}\n`,
      stdout,
      stderr,
      beforeFooter,
      `AFFECTED_TASK_OUTPUT_END task=${task} label=${label}\n`,
    ]);
    return true;
  } catch (error) {
    // Preserve the clean-run fallback: emitCapturedTaskOutput will still append
    // the child bytes later when this early journal write could not be completed.
    rawErrSync(
      `AFFECTED_TASK_OUTPUT_JOURNAL status=failed task=${task} label=${label} ` +
        `reason=${JSON.stringify(String(error?.message ?? error))}`,
    );
    return false;
  }
}

function emitCapturedTaskOutput(t, r, allocation, label = "initial") {
  outSync(
    `    scheduler ${label}: lane=${allocation.lane} workers=${allocation.workers} ` +
      `memoryMb=${allocation.memoryMb}`,
  );
  if (r.__cacheStatus) {
    outSync(
      `    AFFECTED_TASK_CACHE task=${JSON.stringify(taskKey(t))} ` +
        `status=${r.__cacheStatus} reason=${r.__cacheReason}`,
    );
  }
  if (r.error) errSync(`>>> ${t.ws.name} spawn error: ${r.error.message}`);
  writeAllSync(1, r.stdout ?? "");
  writeAllSync(2, r.stderr ?? "");
  // A settled task is already in the run log, before its finished pulse. Keep
  // the declaration-ordered console replay, but do not duplicate up to 256 MiB
  // of child output in the durable log. A failed early journal falls back here.
  if (!r.__outputJournaled) {
    logLine(r.stdout ?? "");
    logLine(r.stderr ?? "");
  }
}

/** Return the exact exit-0/vitest-summary contradiction that makes a first pass unsafe to reuse. */
function capturedTaskSummaryFailure(r) {
  if (r.status !== 0 || !captureOutput()) return null;
  const summary = parseSummaryFailedCounts(
    `${r.stdout ?? ""}${r.stderr ?? ""}`,
  );
  return summary && (summary.testFiles > 0 || summary.tests > 0)
    ? summary
    : null;
}

/**
 * Persist one clean first-pass verdict at task settlement, before any long sibling can be
 * preempted. This is deliberately fail-open: losing reuse costs time, never changes the verdict.
 */
function persistCleanFirstPassTaskVerdict({ task: context, value }) {
  const summaryFailure = capturedTaskSummaryFailure(value);
  if (
    !shouldStorePassingTaskVerdict({
      enabled: TASK_VERDICT_CACHE_ENABLED,
      cacheStatus: value.__cacheStatus,
      initialStatus: value.status,
      finalStatus: summaryFailure ? 1 : value.status,
      absorptionRan: false,
      identity: value.__cacheIdentity,
    })
  ) {
    return;
  }
  const key = taskKey(context.t);
  try {
    // Re-read immediately before every replace so a prior settlement (or serialized follower)
    // is retained. Node runs this synchronous critical section without interleaving callbacks;
    // same-directory rename keeps readers on either the old or new complete document.
    const latest = readPassingTaskVerdictCache(TASK_VERDICT_CACHE_PATH);
    let merged = latest.cache;
    if (!TASK_VERDICT_LOCAL_CROSS_RUN_ONLY && TASK_VERDICT_CACHE_GROUP) {
      merged = mergePassingTaskVerdictUpdates(
        merged,
        TASK_VERDICT_CACHE_GROUP,
        { [key]: passingTaskVerdictEntry(value.__cacheIdentity) },
      );
    }
    // EI-21577710345620735 — the same proof, also filed under the stable cross-run group so the
    // NEXT gate run can reach it. Folded into this one atomic replace rather than a second write:
    // two renames would let a reader observe a state where the task is proven for this run but
    // not the next, and the whole point is that those two facts are the same fact.
    // The else-branch must fall through to the per-run `merged` above. It once read
    // `perRunMerged`, a binding this function no longer declares: because the whole body is
    // wrapped in the try/catch below, that threw a ReferenceError which was swallowed and
    // reported as `AFFECTED_TASK_CACHE_WRITE status=failed`, i.e. reuse silently degraded to
    // "nothing is ever stored" instead of failing loudly. Keep this a plain identity fallback.
    if (value.__crossRunCacheIdentity) {
      merged = mergePassingTaskVerdictUpdates(
        merged,
        PASSING_TASK_VERDICT_CROSS_RUN_GROUP,
        { [key]: passingTaskVerdictEntry(value.__crossRunCacheIdentity) },
      );
    }
    writePassingTaskVerdictCacheAtomic(
      TASK_VERDICT_CACHE_PATH,
      merged,
      `${RUN_TOKEN}-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`,
    );
    outSync(
      `AFFECTED_TASK_CACHE_WRITE status=stored entries=1 task=${JSON.stringify(key)} ` +
        `path=${TASK_VERDICT_CACHE_PATH}`,
    );
  } catch (error) {
    // Classify, but NEVER let this abort the run. Two facts decide the shape of this handler:
    //
    //   1. A broken store is SAFE, only wasteful. It costs reuse, so the suite does MORE work,
    //      never less — it cannot cause an unverified task to be certified. Aborting a ~40min
    //      gate suite over a lost optimization would convert a harmless bug into the one thing
    //      this plan exists to prevent: a gate outage that blocks every agent's deploys. This
    //      callback is awaited inside runBudgetedTasks' try/catch, which RE-THROWS
    //      (budgeted-task-scheduler.mjs:734), so a throw here would do exactly that.
    //   2. The real defect in the `perRunMerged` regression was OBSERVABILITY, not tolerance:
    //      "reuse on, nothing reusable" (healthy) and "the store throws on every task" (broken)
    //      printed the same way, so nothing distinguished them.
    //
    // So: tolerate environmental failure exactly as before, and make the programmer-error class
    // COUNTED — surfaced on the summary line everyone already reads (defects=N below), instead
    // of only on a per-task stderr line nobody greps. Loud, not fatal. See plan D-008.
    if (error instanceof ReferenceError || error instanceof TypeError) {
      taskVerdictPersistDefects.push(`${key}: ${error.message}`);
      errSync(
        `AFFECTED_TASK_CACHE_WRITE status=defect task=${JSON.stringify(key)} ` +
          `reason=${error.message} (BUG in persistCleanFirstPassTaskVerdict — reuse is broken, ` +
          `suite continues)`,
      );
      return;
    }
    errSync(
      `AFFECTED_TASK_CACHE_WRITE status=failed task=${JSON.stringify(key)} ` +
        `reason=${error.message} (continuing without reuse)`,
    );
  }
}

/**
 * P-006 / R-8 sub-requirement 5 — fold one settled task's own output into the run's coverage
 * tally, at the same settlement seam the verdict cache already uses.
 *
 * Settlement is the right seam for the same reason it was right there: it is the ONLY point
 * that sees every task that actually ran, exactly once, with its captured output still in hand.
 * A task that never settles (admission starvation, the wall-clock deadline) is already counted
 * as `undeterminedTasks`, and deliberately contributes no coverage — reporting a zero for a task
 * that never started would be the same defect this whole tally exists to remove.
 *
 * FAIL-OPEN, and that is load-bearing: this callback is awaited inside runBudgetedTasks' own
 * try/catch, which RE-THROWS, so an exception here would abort a ~40min gate suite. The tally is
 * an OBSERVATION — losing it costs visibility and never certifies an unverified task — so a
 * broken tally must degrade to silence, never to a lost run. Same reasoning, and the same
 * loud-not-fatal shape, as its sibling above.
 */
function foldSettledTaskCoverage(scheduled) {
  try {
    const value = scheduled?.value ?? {};
    coverage = foldTaskCoverage(coverage, {
      task: taskKey(scheduled.task.t),
      output: `${value.stdout ?? ""}${value.stderr ?? ""}`,
    });
  } catch (error) {
    // Counted the same way a cache defect is: visible on a line a triager already greps,
    // never fatal. An unreadable tally is reported as unreadable, never as a measured zero.
    coverage = { ...coverage, unreadableTasks: coverage.unreadableTasks + 1 };
    errSync(
      `AFFECTED_TESTS_COVERAGE status=defect reason=${error.message} ` +
        `(BUG in foldSettledTaskCoverage — coverage accounting degraded, suite continues)`,
    );
  }
}

// WI-1490656: admission starvation must end as an ATTRIBUTABLE verdict, not a lost run.
// `runBudgetedTaskShards` now bounds the total time this invocation may spend queued on the
// shared admission mutex. When that budget is spent, `withFsMutex` throws — and at top level
// in an ESM module an uncaught rejection kills the process with no `AFFECTED_TESTS_RESULT`
// line, which is precisely the "exit-without-verdict" shape the gate records as a LOST RUN.
// Bounding the wait without this would only make the gate lose runs faster. Exit 78
// (EX_CONFIG) matches the pids-exhausted refusal: a red that is NOT a test verdict.
// The classifier lives beside the acquisition that throws (budgeted-task-scheduler.mjs) so
// a reworded error cannot silently stop being recognised here and quietly restore the
// lost-run behaviour.
//
// `let` + the declaration ABOVE the publication boundary on purpose: EI-21361599312981776
// pins that NOTHING may sit between `publishPreemptReadyMarker()` and the first task shard,
// so only the `try {` opener is allowed to intervene.
// EI-21917992245424964: what this run IS, published into the shared admission mutex's owner
// record so a BLOCKED peer can decide whether waiting is worth it without a coord round-trip
// and without this process being awake to answer. Measured 2026-08-30: a peer read "it is
// progressing, so I will not interrupt it" off a holder that had just entered a ~26-minute
// leg whose output nobody wanted, because the owner record carried identity and no value.
//
// Every field here is DERIVED from what the run has already computed, not separately
// declared — the acquisition sits below the derivation boundary (see the comment under
// `publishPreemptReadyMarker()`), so the scope and the task list are settled facts by now.
// A declared-and-forgotten field would rot; a derived one cannot.
//
// The admission projection is deliberately separate from serial-equivalent work. Tasks run
// through two concurrent scheduler lanes, so summing their histories is useful accounting but
// not elapsed wall time and not a lower bound. The scheduler helper simulates those lanes and
// returns a history-based wall-time projection with explicit coverage and uncertainty fields.
// `etaFromTasks=3/9` tells a reader how much of the run the projection actually saw; if it reads
// 0/9 the ETA means nothing and says so.
const admissionIntent = (() => {
  try {
    const projection = estimateBudgetedTaskWallMs(TASK_CONTEXT_SHARD_PLAN, {
      ...SCHEDULER_CONFIG,
      estimateMs: (context) =>
        durationEstimate(durationHistory, taskKey(context.t)),
    });
    const intent = {
      scope: derivationSource,
      paths: changedPathsOverride
        ? changedPathsOverride.length
        : (changedPathTotal ?? 0),
      workspaces: affected.length,
      tasks: tasks.length,
      etaProjectedSec: Math.round(projection.projectedWallMs / 1000),
      etaWorkSec: Math.round(projection.knownWorkMs / 1000),
      etaFromTasks: `${projection.knownTasks}/${tasks.length}`,
      etaUnknownTasks: projection.unknownTasks,
      etaMode: projection.mode,
      etaConcurrency: projection.maxConcurrentTasks,
    };
    // The holder's own declaration that its output is expendable — "kill me rather than
    // queue behind me". Opt-in and OMITTED when unset, never defaulted to false: absence
    // has to keep reading as "did not say", because a run that never considered the
    // question is not the same as one that decided it is load-bearing.
    if (process.env.AFFECTED_TESTS_DISCARDABLE === "1") intent.discardable = true;
    return intent;
  } catch {
    // Disclosure, not a rail. A run must never fail to start because it could not describe
    // itself; an undeclared holder is exactly the status quo this improves on.
    return undefined;
  }
})();

let initialPool;

// WI-1734042: a passing fresh-process retry is only a FLAKE when the two attempts
// observed the same candidate tree. Capture before the first child starts. The
// helper is fail-closed, so a git/status/read race becomes provenance-unknown.
const RUN_START_RETRY_TREE = snapshotRetryTree(ROOT);

// This is the irreversible execution boundary: derivation, dry-run, and empty
// task exits are all above it. Publish only now so an exclusive materializer
// retains priority during setup but cannot destroy the once-only task run after
// its task ledger has become authoritative.
publishPreemptReadyMarker();
try {
  initialPool = await runBudgetedTaskShards(TASK_CONTEXT_SHARD_PLAN, {
  ...SCHEDULER_CONFIG,
  // EI-20801764054303492 route (a): the startup budget is sized ONCE, from a reading taken before
  // any child exists. A long run's real memory picture drifts underneath it, so admission
  // re-measures and may only ever admit fewer workers than the ceiling already allows.
  readMemAvailableMb,
  estimateMs: (context) =>
    durationEstimate(durationHistory, taskKey(context.t)),
  runTask: (context, allocation) => runCapturedTask(context, allocation),
  onTaskSettled: (scheduled) => {
    // Coverage first: it is pure bookkeeping over output already in hand, while the verdict
    // cache does filesystem work whose environmental failures are tolerated. Ordering them
    // this way keeps a slow or failing cache write from costing the tally.
    foldSettledTaskCoverage(scheduled);
    persistCleanFirstPassTaskVerdict(scheduled);
  },
  // WI-1490656: send the shared-admission queue notices through `errSync`, so they land in
  // BOTH stderr and this run's own log. The scheduler's default sink is `console.error`,
  // which never reaches `RUN_LOG_PATH` — the file the BEGIN line explicitly tells a triager
  // to grep. A queued run therefore froze its log mid-run with no explanation and was read
  // as a hang (zero children + ep_poll + flat log is the same signature either way).
  onAdmissionNotice: (line) => errSync(line),
  // EI-21917992245424964: published into the mutex owner record for blocked peers.
  admissionIntent,
  });
} catch (error) {
  // WI-1639265: the run was launched with less wall clock than the work already known to be
  // queued needs. Same terminal shape as admission starvation, and for the same reason: the
  // alternative is a SIGKILL part-way through with no `AFFECTED_TESTS_RESULT` line at all,
  // which the gate records as a LOST RUN and a triager reads as a hang. Exit 78 (EX_CONFIG)
  // keeps it a red that is explicitly NOT a test verdict.
  if (isTaskDeadlineRefusal(error)) {
    errSync(
      `AFFECTED_TESTS_REFUSAL kind=deadline-insufficient detail=${String(error?.message ?? error)}`,
    );
    errSync(
      `AFFECTED_TESTS_RESULT status=refused reason=deadline-insufficient tasks=${tasks.length} ` +
        `failed=0 quarantinedFailed=0 timedOutTasks=0 undeterminedTasks=${tasks.length}`,
    );
    errSync(
      "NOT MEASURED — this run's launcher gave it a wall clock shorter than the work it was " +
        "asked to do, so it refused before running anything rather than being killed mid-suite " +
        "with no verdict. Nothing here is a test verdict. Re-fire with a longer timeout: the " +
        "TASK_DEADLINE_REFUSAL line above names the remaining clock and the KNOWN work (a lower " +
        "bound — unknown-duration tasks are counted as zero and reported separately).",
    );
    // EI-22431012667356741: the documented triage grep includes AFFECTED_EXIT, but this
    // deliberate refusal previously emitted only status=refused and NOT MEASURED. Publish the
    // known non-zero exit in the run log so a refusal cannot look like a clean run to a reader
    // who follows that grep without knowing this special path.
    errSync("AFFECTED_EXIT=78");
    terminalEmitted = true;
    errSync(`Full run log: ${RUN_LOG_PATH}`);
    process.exit(78);
  }
  if (!isSharedAdmissionTimeout(error)) throw error;
  errSync(`AFFECTED_TESTS_REFUSAL kind=admission-starved detail=${String(error?.message ?? error)}`);
  errSync(
    `AFFECTED_TESTS_RESULT status=refused reason=admission-starved tasks=${tasks.length} ` +
      `failed=0 quarantinedFailed=0 timedOutTasks=0 undeterminedTasks=${tasks.length}`,
  );
  errSync(
    "NOT MEASURED — this run spent its whole shared-admission budget queued behind another " +
      "test process and never got to run its tasks. Nothing here is a test verdict. The " +
      "holder is named in the AFFECTED_TESTS_ADMISSION_QUEUED lines above; re-fire once the " +
      "queue drains.",
  );
  terminalEmitted = true;
  errSync(`Full run log: ${RUN_LOG_PATH}`);
  process.exit(78);
}
// The initial pool has now journaled every settled task. Keep the external
// supervisor from freezing the aggregate while it replays those records,
// performs retries/cargo attribution, and emits the terminal result line.
publishPreemptFinalizationMarker();
for (const scheduled of initialPool.results) {
  if (scheduled.value.__cacheStatus !== "hit") {
    recordLeg(scheduled.task.t, scheduled.value.__elapsedMs);
  }
}
outSync(formatTaskBudgetObservedMarker(initialPool.stats));
if (TASK_VERDICT_CACHE_ENABLED) {
  outSync(
    formatPassingTaskVerdictSummary(
      initialPool.results.map(({ value }) => ({
        status: value.__cacheStatus,
        reason: value.__cacheReason,
      })),
      {
        proofGroupApplied: TASK_VERDICT_PROOF_GROUP_APPLIED,
        cacheGroup: TASK_VERDICT_CACHE_GROUP,
        // Without this the summary reports proofIdentity=current-run for an ordinary local
        // `npm test`, which reads as "confined to this run" — the opposite of what a cross-run
        // reuse run is doing. formatPassingTaskVerdictSummary already accepts cacheScope.
        cacheScope: TASK_VERDICT_CACHE_SCOPE,
      },
    ),
  );
  // D-008: a persist-path defect costs reuse without failing the suite, so it must be reported
  // where the cache is already being reported. Silence here is what let the regression survive.
  if (taskVerdictPersistDefects.length > 0) {
    errSync(
      `AFFECTED_TASK_CACHE_DEFECTS count=${taskVerdictPersistDefects.length} ` +
        `(reuse is broken — suite results are unaffected) ` +
        `first=${JSON.stringify(taskVerdictPersistDefects[0])}`,
    );
  }
  // WI-595883: record what this run saw, so the NEXT run's closure miss is explainable. Written
  // once per run rather than per task — the digests are shared across every task in the run, and
  // one 100KB sidecar is what keeps this affordable at all. Best-effort: a failure here costs a
  // future diagnostic, never a verdict.
  try {
    writePassingTaskVerdictCacheAtomic(
      TASK_VERDICT_CLOSURE_MANIFEST_PATH,
      mergeClosureDigestManifest({
        prior: readClosureDigestManifest(TASK_VERDICT_CLOSURE_MANIFEST_PATH).manifest,
        observed: observedClosureDigests(ROOT, taskVerdictDigestCache),
        taskShapes: taskVerdictClosureShapes,
        identityEnv: taskVerdictIdentityEnvByGroup,
      }),
      `${RUN_TOKEN}-closure-manifest`,
    );
  } catch (error) {
    errSync(
      `AFFECTED_TASK_CACHE_CLOSURE_MANIFEST status=failed reason=${JSON.stringify(String(error?.message ?? error))}`,
    );
  }
}
try {
  // Re-read immediately before the atomic replace so a run that finished while this one was
  // active is less likely to be overwritten. Atomicity guarantees readers never parse a torn
  // file; losing one racing observation merely leaves the prior estimate in place.
  const latestHistory = readDurationHistory(TASK_DURATION_HISTORY_PATH);
  const nextHistory = mergeDurationHistory(
    latestHistory,
    initialPool.results
      .filter(({ value }) => value.__cacheStatus !== "hit")
      .map(({ task, value }) => ({
        key: taskKey(task.t),
        durationMs: value.__elapsedMs,
      })),
  );
  writeDurationHistoryAtomic(
    TASK_DURATION_HISTORY_PATH,
    nextHistory,
    RUN_TOKEN,
  );
} catch (error) {
  errSync(
    `>>> duration history unavailable (continuing without it): ${error.message}`,
  );
}

// ── Retry planning (phase A) ────────────────────────────────────────────────────────────────
// Three phases where there used to be one loop. The old loop DECIDED, RAN and REPORTED each
// task's retry inline, so retries executed strictly one after another — each through its own
// single-task scheduler pool which, being alone, assumed the entire worker budget. Under P-004
// (gate-latency-selection-and-retry-policy-2026-09-06) every retry is decided first (P-003's
// failure-shape classifier plus a time budget), then ALL of them run through ONE budgeted pool
// under the same allocation model as the initial pass, and only then does the reporting loop
// replay them in declaration order. The replay is what preserves the synchronous stdout
// ordering affected-tests-stdout-ordering.test.ts pins: no child output is written to the
// console until its workspace header has been.
const isWatchdogTimedOutResult = (r) =>
  r.__watchdogTimedOut === true ||
  (r.__watchdogTimedOut == null &&
    isWatchdogTimeout(
      { signal: r.signal, status: r.status, elapsedMs: r.__elapsedMs },
      { killSignal: BATCH_KILL_SIGNAL, timeoutMs: r.__timeoutMs },
    ));
/**
 * The retry invocation for one decision, PC_TEST_LANE-aware (plan gate-suite-speedup-2026-08-12,
 * P-003).
 *
 * MEASURED 2026-08-13: a `test:lane-pure` leg failed 14 files; 10 of them passed when
 * re-run isolated, i.e. they were artifacts of the lane's own fork reuse, not defects.
 * The retry used to re-run them by re-invoking THE SAME SCRIPT, so `PC_TEST_LANE=pure`
 * was still set, the files ran non-isolated again, and the pollution reproduced — the
 * retry could not absorb the one class it was best placed to absorb.
 *
 * That is not merely a wasted retry. A surviving lane artifact is counted as a failing
 * FILE, and both this script's FRESH_RETRY_MAX_FILES and green-checkpoint's
 * ISOLATION_MAX_FILES are 15 — past which a red is declared a real regression and the
 * gate's isolation rescue is skipped entirely. So lane artifacts spend a budget that
 * exists to absorb genuine load flakes, and 10 of 15 is most of it.
 *
 * Fix: for a lane leg, retry the failed files under the DEFAULT `test` script. It sets
 * no lane env, so it resolves the default config and is ISOLATED BY CONSTRUCTION — the
 * same property the gate's own isolation and confirming co-execution re-runs rely on
 * (resolveWorkspaceTestInvocation). A genuine failure still fails this isolated re-run
 * exactly as it would with no lane split at all, so nothing is absorbed that shouldn't be.
 * A whole-workspace retry re-invokes the task's own script with no file list, exactly as
 * before.
 */
const retryInvocationFor = (t, decision, failedFiles) =>
  decision.mode === "fresh-files"
    ? hasLaneSplit(t.ws)
      ? { extraArgs: decision.retryFiles ?? failedFiles, scriptOverride: "test" }
      : { extraArgs: decision.retryFiles ?? failedFiles, scriptOverride: null }
    : { extraArgs: [], scriptOverride: null };

/** Per initial-pool index: everything the reporting loop needs to know about the retry. */
const retryPrep = new Map();
const retryPoolTasks = [];
for (const scheduled of initialPool.results) {
  const { t, isQuarantined } = scheduled.task;
  const r = scheduled.value;
  const prep = {
    watchdogTimedOut: isWatchdogTimedOutResult(r),
    gating: false,
    failedFiles: [],
    retryDecision: null,
    budget: null,
  };
  retryPrep.set(scheduled.index, prep);
  // A watchdog kill is reported, never retried — the reasoning is with the report in phase C.
  if (prep.watchdogTimedOut || !retryFailed) continue;
  // EI-20107132436867486: retry ONLY what this run would actually count against itself.
  // This used to read `r.status !== 0 && retryFailed && !isQuarantined`, which re-ran a
  // task the reporting branch below was about to forgive as non-gating — announcing a
  // WORKSPACE-shaped "FAILED — retrying once" for one guard that examined nothing, on
  // every run against a git-sync-swept tree (i.e. the normal case). Same predicate as the
  // reporting branch, so the two cannot drift apart again.
  if (
    !isGatingFailure(
      classifyTaskExit({
        status: r.status,
        notCheckedExitCode: EXIT_NOT_CHECKED,
        notCheckedIsNonGating: t.notCheckedIsNonGating,
        quarantined: isQuarantined,
        stdout: r.stdout,
        stderr: r.stderr,
        capturedBytes: r.__capturedBytes,
        elapsedMs: r.__elapsedMs,
        durationEstimateMs: r.__durationEstimateMs,
      }),
    )
  )
    continue;
  prep.gating = true;
  const firstPassOutput = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const failedFiles = parseFailedFiles(firstPassOutput);
  // P-003 (gate-latency-selection-and-retry-policy-2026-09-06): the retry exists to absorb
  // LOAD FLAKES, so it now fires only when the first pass's own output has a flake-class
  // signature (timeout, dropped connection, port conflict, late console, worker crash,
  // transform race), or when the red is tiny enough that a re-run costs seconds. A broad
  // deterministic red — 36 assertion diffs in gate run e70cd139 — re-ran the whole workspace
  // for 34 minutes and reproduced itself exactly; that pass is now skipped, and the decision
  // is one greppable AFFECTED_RETRY_DECISION / AFFECTED_RETRY_SKIPPED line either way. The
  // classifier is pure (scripts/lib/retry-failure-shape.mjs) and pinned by
  // affected-tests-retry-failure-shape.test.ts.
  const retryDecision = decideRetry({
    failedFiles,
    output: firstPassOutput,
    maxFiles: FRESH_RETRY_MAX_FILES,
  });
  prep.failedFiles = failedFiles;
  prep.retryDecision = retryDecision;
  if (!retryDecision.retry) continue;
  // P-004: the budget comes from what THIS run just measured (the first pass) and the task's
  // duration history, with headroom, floored and capped — never from the 45–90m suite watchdog
  // the retry used to inherit. runCapturedTask reads `__retry.budgetMs` as both its timeout
  // and its progress-extension ceiling, so the bound is hard.
  const budget = deriveRetryBudget({
    firstPassElapsedMs: r.__elapsedMs,
    durationEstimateMs: r.__durationEstimateMs,
  });
  prep.budget = budget;
  retryPoolTasks.push({
    ...scheduled.task,
    __retry: {
      index: scheduled.index,
      mode: retryDecision.mode,
      budgetMs: budget.budgetMs,
      ...retryInvocationFor(t, retryDecision, failedFiles),
    },
  });
}

// ── Retry execution (phase B): ONE pool ─────────────────────────────────────────────────────
// Never `Promise.all` over single-task pools: each such pool assumes the whole worker budget,
// so N of them in flight would admit N× the configured ceiling. One pool gives every retry the
// same global envelope the initial pass had, and the retries overlap exactly as far as that
// envelope allows.
const retryResults = new Map();
if (retryPoolTasks.length > 0) {
  const budgetSumMs = retryPoolTasks.reduce((sum, task) => sum + task.__retry.budgetMs, 0);
  errSync(formatRetryPoolLine({ phase: "start", tasks: retryPoolTasks.length, budgetSumMs }));
  const retryPoolStartedAt = Date.now();
  try {
    const retryPool = await runBudgetedTasks(retryPoolTasks, {
      ...SCHEDULER_CONFIG,
      readMemAvailableMb,
      // Ordering only (longest-first in the primary lane). A fresh-files re-run has no history
      // of its own and is short by construction, so it is left unknown and packs shortest-first.
      estimateMs: (context) =>
        context.__retry.mode === "whole-workspace"
          ? durationEstimate(durationHistory, taskKey(context.t))
          : null,
      onAdmissionNotice: (line) => errSync(line),
      admissionIntent,
      runTask: async (context, allocation) => {
        // WI-1734042: capture immediately before THIS child starts. This brackets the two
        // attempts without treating files written by the retry itself as input drift, and
        // makes the snapshot timing independent of the retry shape — and of its siblings.
        const retryStartTree = snapshotRetryTree(ROOT);
        const value = await runCapturedTask(
          context,
          allocation,
          context.__retry.extraArgs,
          context.__retry.scriptOverride,
          "retry",
        );
        // WI-38300: sampled IMMEDIATELY after the re-run, deliberately. loadavg()[0] is a
        // TRAILING 1-minute average, so a post-sample describes the load the RE-RUN itself
        // experienced — the thing in question. A pre-sample describes the first pass, which is
        // already known to have been high (it is what enabled absorption) and therefore
        // discriminates nothing. ⚠ Keep this line IMMEDIATELY after the re-run —
        // affected-tests-load-suspect.test.ts pins the adjacency — and never hoist it to the
        // reporting loop, which runs only after EVERY retry has settled.
        const load1AtRerun = loadavg()[0];
        recordLeg(context.t, value.__elapsedMs);
        return { ...value, __retryStartTree: retryStartTree, __load1AtRerun: load1AtRerun };
      },
    });
    for (const entry of retryPool.results) retryResults.set(entry.task.__retry.index, entry);
    errSync(
      formatRetryPoolLine({
        phase: "done",
        tasks: retryPoolTasks.length,
        budgetSumMs,
        wallMs: Date.now() - retryPoolStartedAt,
        settled: retryResults.size,
      }),
    );
  } catch (error) {
    // Fail-safe: a pool that could not run (admission starvation, a scheduler fault) leaves
    // every initial failure standing exactly as measured. This used to be an unhandled
    // rejection that ended the run with no AFFECTED_TESTS_RESULT line at all — a LOST RUN to
    // the gate — which is strictly worse than a red with its verdict.
    errSync(
      formatRetryPoolLine({
        phase: "aborted",
        tasks: retryPoolTasks.length,
        budgetSumMs,
        wallMs: Date.now() - retryPoolStartedAt,
        settled: retryResults.size,
        detail: String(error?.message ?? error),
      }),
    );
  }
}

// ── Reporting (phase C): declaration order ──────────────────────────────────────────────────
const executedMapReads = [];
for (const scheduled of initialPool.results) {
  const { t, isQuarantined, guardArgs } = scheduled.task;
  const initialTaskOutput = `${scheduled.value.stdout ?? ""}${scheduled.value.stderr ?? ""}`;
  outSync(
    `\n>>> ${t.ws.name} :: ${npmAvailable ? "npm " : ""}run ${t.script}${isQuarantined ? " [QUARANTINED]" : ""}`,
  );
  if (guardArgs.length) {
    outSync(
      `    (EI-11132 empty-suite guard: on-disk test files found — this run's --passWithNoTests is disabled)`,
    );
  }
  emitCapturedTaskOutput(t, scheduled.value, scheduled.allocation);
  // P-012 (gate-file-level-test-reuse-2026-09-27): a file the reuse rule WOULD have skipped (an
  // audit sample, or a freshly-expired clean proof) that failed on this fresh run means reuse can
  // hide a red. Judged on the FIRST pass (the output reuse would have replaced), before any retry;
  // the retry verdict printed below separates a flake from a reproduced capture gap.
  if (t.reuseWatch) {
    for (const alarm of reuseSoundnessAlarms({
      failedFiles: parseFailedFiles(initialTaskOutput),
      watch: t.reuseWatch.watch,
      prefix: t.reuseWatch.prefix,
    })) {
      errSync(formatReuseAlarmLine(`${t.ws.name}::${t.script}`, alarm));
    }
  }
  // WI-10003603: what this task's pass-proof recorder did, read from its result file. The
  // reporter's own line went to the task's stderr, which the gate discards.
  const executedMapResultFile = executedMapResultFiles.get(taskKey(t));
  if (executedMapResultFile) {
    const read = {
      ...readExecutedMapResults(executedMapResultFile),
      expectsReport: executedMapReportExpectations.get(taskKey(t))?.expectsReport ?? null,
    };
    executedMapReads.push(read);
    const label = `${t.ws.name}::${t.script}`;
    for (const line of formatExecutedMapResultLines(label, read)) outSync(line);
    for (const line of formatExecutedMapAlarmLines(label, read)) errSync(line);
  }
  let r = scheduled.value;
  const prep = retryPrep.get(scheduled.index);
  const { watchdogTimedOut } = prep;
  // WI-38300: absorption state, read by the reporting branch far below to decide whether a
  // surviving failure is a confident red or load-suspect residue. Declared out here because
  // the retry branch and the reporting branch are separate statements over the same task.
  let absorptionRan = false;
  let load1AtRerun = null;
  let residualFiles = [];
  let retryProvenance = null;
  if (watchdogTimedOut) {
    // Not retried: a wedge that reproduces once burns the exact same window again, turning
    // one bounded stall back into an unbounded-feeling one. Report it plainly and move on —
    // the next batch already proceeds either way (this is a per-batch bound, not a run-wide
    // one), so the gate stays attributable instead of a silent 2h hang.
    // EI-20268851913189733: this message used to ASSERT the spin cause. It has two
    // possible causes and it can TELL THEM APART from evidence it already holds, so
    // it must not send the reader hunting a file that does not exist. A spin STALLS
    // (progress stops, one file never finishes); an over-long suite keeps completing
    // files right into the wall. Observed 2026-08-12: operator-core reported 3302 of
    // 4063 files with the last ones passing in 9-15ms each — a timeout, reported as
    // a spin, which cost a real investigation.
    // A path mention is not progress: only Vitest's per-file rollup rows prove
    // that a file completed. Also preserve null for streamed TTY output; turning
    // it into an empty string would falsely report "no progress" and invite a
    // spin diagnosis from evidence this process never captured.
    const capturedOut =
      typeof r.stdout === "string" || typeof r.stderr === "string"
        ? `${r.stdout ?? ""}${r.stderr ?? ""}`
        : null;
    const progressEvidence = parseBatchProgress(capturedOut);
    const progress = formatBatchProgress(
      progressEvidence,
      classifyBatchProgress(progressEvidence),
    );
    errSync(
      `\n>>> ${t.ws.name} :: ${t.script} WATCHDOG-KILLED after ${(r.__elapsedMs / 60000).toFixed(1)}m with no exit ` +
        `(effective timeout=${r.__watchdogDeadlineMs ?? r.__timeoutMs}ms source=${r.__timeoutSource} ` +
        `durationEstimateMs=${r.__durationEstimateMs ?? "unknown"}; ` +
        `AFFECTED_BATCH_TIMEOUT_MS=${process.env.AFFECTED_BATCH_TIMEOUT_MS ?? "unset"}). ` +
        // EI-20803703725014949: the kill now carries the REASON it was chosen, so a
        // triager is not left inferring it. 'progress-stalled' is the real spin signal;
        // 'absolute-ceiling' means it kept emitting to the 90m bound; 'progress-unknown'
        // means no live reading existed and the time-only bound applied.
        `Kill reason: ${r.__watchdogKillReason ?? "unknown"}. ` +
        `NOT retrying. ${progress}. ` +
        `A synchronously-spinning test remains a hypothesis only when a live progress signal shows progress ` +
        `stopped; captured output without timing must not be used to assert a spin ` +
        `(EI-19370814345784324).`,
    );
  } else if (prep.gating) {
    // The decision and budget were made in phase A and the retry (if any) ran in phase B;
    // this branch only REPLAYS them, in declaration order, so the log reads exactly as the
    // serial version did: decision → budget → the re-run's own output → its verdict.
    const { failedFiles, retryDecision, budget } = prep;
    errSync(formatRetryDecisionLine(t.ws.name, retryDecision));
    if (!retryDecision.retry) {
      // Deliberately NOT retried; `absorptionRan` stays false so the reporting branch treats
      // the surviving failure as a confident red rather than load-suspect residue.
    } else {
      errSync(formatRetryBudgetLine(t.ws.name, budget));
      // P-006: a broad red re-runs only the files whose own failure entries carry a flake
      // signature (decision.retryFiles); the rest are deterministic and never re-run.
      const retryFiles = retryDecision.retryFiles ?? failedFiles;
      errSync(
        retryDecision.mode === "fresh-files"
          ? `\n>>> ${t.ws.name} FAILED — fresh-process re-run of ${retryFiles.length} of ${failedFiles.length} failed file(s) (HARDEN-GATE flake absorption): ${retryFiles.join(", ")}`
          : `\n>>> ${t.ws.name} FAILED — retrying once (AFFECTED_RETRY_FAILED, flake absorption)`,
      );
      const retried = retryResults.get(scheduled.index);
      if (!retried) {
        // The pool aborted before this retry settled (AFFECTED_RETRY_POOL phase=aborted above).
        // `absorptionRan` stays false: nothing was absorbed, and the first pass stands.
        errSync(
          `>>> ${t.ws.name} retry did not settle — retaining the initial failure.`,
        );
      } else {
        emitCapturedTaskOutput(t, retried.value, retried.allocation, "retry");
        r = retried.value;
        absorptionRan = true;
        load1AtRerun = retried.value.__load1AtRerun ?? null;
        if (isWatchdogTimedOutResult(r)) {
          errSync(
            `>>> ${t.ws.name} retry WATCHDOG-KILLED at its retry budget after ${(r.__elapsedMs / 60000).toFixed(1)}m ` +
              `(budgetMs=${budget.budgetMs} source=${budget.source} killReason=${r.__watchdogKillReason ?? "unknown"}) — ` +
              `a re-run that cannot finish inside twice its own reference is not a flake absorption; the failure stands.`,
          );
        }
        // WI-1734042: a passing fresh-process retry is only a FLAKE when the two attempts
        // observed the same candidate tree.
        retryProvenance = classifyRetryTreeProvenance(
          RUN_START_RETRY_TREE,
          retried.value.__retryStartTree,
        );
        if (r.status === 0 && retryProvenance.classification !== "flake") {
          errSync(
            `${formatRetryTreeProvenanceNotice({
              workspace: t.ws.name,
              ...retryProvenance,
            })} — retry passed, retaining the initial failure rather than claiming FLAKE absorption.`,
          );
          // Keep the retry output for diagnostics, but restore a failing status so
          // the first attempt remains gating when the tree was not comparable.
          r = {
            ...r,
            status:
              typeof scheduled.value.status === "number" && scheduled.value.status !== 0
                ? scheduled.value.status
                : 1,
          };
        }
        if (retryDecision.mode === "fresh-files") {
          // The residue is what SURVIVED the re-run, not what entered it. This used to be
          // assigned `failedFiles` — the PRE-retry set — while formatLoadSuspectNotice states
          // the files "failed the first pass AND the fresh-process re-run". Measured
          // 2026-08-13: a lane leg failed 14 files, the re-run left 4, and the notice named
          // all 14 — pointing gate triage at 10 files that had just passed. Re-parse the
          // RE-RUN's own output; fall back to the pre-retry set only when nothing parses, so
          // an unparseable failure still names something rather than silently naming none.
          const rerunFailedFiles = parseFailedFiles(
            `${r.stdout ?? ""}${r.stderr ?? ""}`,
          );
          // P-006: a subset retry (broad red, signatures pinned to a few files) leaves the
          // OTHER failed files un-run. They are deterministic by the classifier's reading and
          // stay in the residue; and since the retry's exit code speaks only for the subset,
          // a passing subset must not turn the task green — the first pass's status stands.
          const retriedSet = new Set(retryFiles);
          const notRetried = failedFiles.filter((f) => !retriedSet.has(f));
          const rerunResidue =
            rerunFailedFiles.length > 0
              ? rerunFailedFiles
              : r.status === 0
                ? []
                : failedFiles.filter((f) => retriedSet.has(f));
          residualFiles = [...new Set([...notRetried, ...rerunResidue])];
          if (notRetried.length > 0 && r.status === 0) {
            errSync(
              `>>> ${t.ws.name} re-run subset passed in a fresh process — ${retryFiles.length} file(s) ` +
                `${retryProvenance?.classification === "flake" ? "counted as FLAKES" : "not counted (tree moved)"}; ` +
                `${notRetried.length} deterministic file(s) were NOT re-run, so the failure stands: ${notRetried.join(", ")}`,
            );
            r = {
              ...r,
              status:
                typeof scheduled.value.status === "number" && scheduled.value.status !== 0
                  ? scheduled.value.status
                  : 1,
            };
          } else if (r.status === 0 && retryProvenance?.classification === "flake")
            errSync(
              `>>> ${t.ws.name} failed files passed in a fresh process — counted as a FLAKE, not a failure.`,
            );
        } else if (r.status === 0 && retryProvenance?.classification === "flake") {
          errSync(
            `>>> ${t.ws.name} passed on retry — counted as a FLAKE, not a failure.`,
          );
        }
      }
    }
  }
  // EI-18653696921091778: an exit code of 0 does NOT imply "no reds" — vitest can
  // print a summary reporting failed test files/tests yet still exit 0 (observed
  // live 2026-07-25, root cause not yet pinned down; load-dependent per the report).
  // Cross-check the captured summary text against the exit code whenever we have
  // it; a nonzero failed-count with a "successful" exit is treated as a failure —
  // fail-safe, since trusting the suspicious green would silently hold the gate
  // open for a genuinely red suite (the opposite mistake — an occasional false
  // failure on a truly-clean run — just costs a rerun, and is loudly explained).
  if (r.status === 0 && captureOutput()) {
    const summary = capturedTaskSummaryFailure(r);
    if (summary) {
      errSync(
        `\n⚠⚠ ${t.ws.name} exited 0 but its own vitest summary reports ${summary.testFiles} failed test file(s) / ` +
          `${summary.tests} failed test(s) — treating as a FAILURE (EI-18653696921091778: an exit-code/summary ` +
          `mismatch must never read as green). Full run log: ${RUN_LOG_PATH}`,
      );
      r = { ...r, status: 1 };
    }
  }
  if (r.status !== 0) {
    // WI-37830: the classification is a pure, unit-tested helper because every branch below
    // runs ONLY once a task has already failed — on a healthy tree that is never, so this
    // gate-protecting logic was previously reachable by no test and checkable only by
    // reading it. The retry decision above consults the SAME helper.
    const exitClass = classifyTaskExit({
      status: r.status,
      notCheckedExitCode: EXIT_NOT_CHECKED,
      notCheckedIsNonGating: t.notCheckedIsNonGating,
      quarantined: isQuarantined,
      stdout: r.stdout,
      stderr: r.stderr,
      capturedBytes: r.__capturedBytes,
      elapsedMs: r.__elapsedMs,
      durationEstimateMs: r.__durationEstimateMs,
    });
    if (exitClass === "undetermined") {
      undeterminedTasks++;
      const taskName = `${t.ws.name} :: ${t.script}`;
      undeterminedTaskNames.push(taskName);
      errSync(
        `\n  ⚠ ${taskName} UNDETERMINED — the child did not establish a trustworthy test verdict; ` +
          `not retrying and keeping the affected-tests run non-green.`,
      );
    } else if (exitClass === "not-checked") {
      // "I could not look" is not "I found a violation" — see EXIT_NOT_CHECKED above. Reported
      // LOUDLY rather than swallowed: the guard really did verify nothing, and a reader who
      // takes this run as coverage of the strand class would be wrong.
      //
      // But it does NOT gate. Reaching this branch at all means the task was registered
      // `notCheckedIsNonGating: true` — classifyTaskExit returns 'not-checked' only for such a
      // task — i.e. its registration declared in advance that this exact answer is expected
      // here. Gating on it anyway contradicted that declaration and, because these guards read
      // the WORKING DIFF (empty in a gate's clean checkout), red-pinned EVERY candidate
      // unconditionally. Keeping the coverage gap visible is handled by the loud line here plus
      // the AFFECTED_TESTS_NOT_CHECKED marker at the end of the run — not by failing the gate.
      notCheckedNonGating++;
      const taskName = `${t.ws.name} :: ${t.script}`;
      notCheckedTaskNames.push(taskName);
      errSync(
        `\n  ⚠ ${taskName} NOT CHECKED (exit ${EXIT_NOT_CHECKED}) — this guard verified NOTHING; ` +
          `not retrying, and NOT gating (registered notCheckedIsNonGating).\n` +
          `    This guard infers its subject from the working diff, which is empty in a clean\n` +
          `    checkout, so it has no opinion here. It speaks in a LOCAL run, where the edit\n` +
          `    that triggers it is still uncommitted. Do not read this run as coverage of that\n` +
          `    class — but it is not evidence of a break either, so it cannot fail the run.`,
      );
    } else if (exitClass === "quarantined") {
      quarantinedFailed++;
      errSync(`  (quarantined failure — not gating)`);
    } else {
      failed++;
      failedTaskNames.push(`${t.ws.name} :: ${t.script}`);
      // EI-19395701908500754: name the FILES, not just the workspace. Delegated to a
      // unit-tested helper for the same reason as the rendering below — this runs only
      // when the gate is already red, so nothing here is exercised on a green run.
      // EI-20342691406630303: a watchdog kill does not imply that the child produced no
      // parseable failure rows. A long suite can print its final Vitest summary immediately
      // before the watchdog lands. Always parse the captured bytes; `batch-timeout` is only
      // the reason to use when attribution genuinely has no file to return.
      const a = attributeFailedTask({
        workspace: t.ws.name,
        task: `${t.ws.name} :: ${t.script}`,
        captured: captureOutput(),
        output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
        fallbackOutput: initialTaskOutput,
        fallbackSource: "initial-task-output",
        fallbackReason: watchdogTimedOut ? "batch-timeout" : undefined,
      });
      failedFileEntries.push(...a.entries);
      unattributedTasks.push(...a.unattributed);
      transformCulpritPaths.push(...a.transformCulprits);
      if (a.attributionSource) {
        attributionFallbacks.push({
          task: `${t.ws.name} :: ${t.script}`,
          source: a.attributionSource,
        });
      }
      // EI-19332556961886184: surface a timeout signature right here, in the log a
      // triager reads, instead of letting it collapse into an indistinguishable red.
      // Only possible when the child's output was captured (a non-TTY / background
      // caller — see captureOutput() above); an interactive TTY run streamed straight
      // to the terminal via stdio:'inherit' and r.stdout/r.stderr are unset here.
      if (captureOutput()) {
        const timedOutCount = countTimeoutSignatures(
          `${r.stdout ?? ""}${r.stderr ?? ""}`,
        );
        if (timedOutCount > 0) {
          timedOutTasks++;
          errSync(
            `  ⚠ this run's output shows ${timedOutCount} vitest "timed out" signature(s) — this ` +
              `failure may be a wall-clock timeout artifact (load-correlated), NOT necessarily a real ` +
              `assertion failure. Verify before treating as a regression: grep the run log for ` +
              `"timed out in" (see AGENT-ENV/CLAUDE.md's assertion-vs-timeout recipe).`,
          );
        }
      }
      // WI-38300: absorption's own premise ("a real regression fails both runs; a load flake
      // almost never fails twice in a row") does NOT hold for the load class that AUTO-ENABLES
      // absorption — the retry is immediate, so it re-runs under the same load that caused the
      // first failure. When that is what happened, say so instead of rendering the residue as a
      // confident regression. The task stays COUNTED either way (residualGates); only the
      // attribution changes. Classification lives in a pure helper because this branch runs only
      // once the gate is already red — on a healthy tree, never.
      const residualClass = classifyResidualFailure({
        absorptionRan,
        rerunStatus: absorptionRan ? r.status : null,
        load1AtRerun,
        threshold: retryLoad1Threshold,
      });
      if (residualClass === "load-suspect") {
        loadSuspectTasks.push({
          task: `${t.ws.name} :: ${t.script}`,
          load1AtRerun,
          files: residualFiles,
        });
        errSync(
          formatLoadSuspectNotice({
            workspace: t.ws.name,
            load1AtRerun,
            threshold: retryLoad1Threshold,
            files: residualFiles,
          }),
        );
      }
    }
  }
}
// WI-10003603: one total per invocation, beside TEST_PASS_REUSE_TOTAL, so the gate's P-013 health
// record can say whether this round's clean run actually persisted any pass proofs.
if (executedMapReads.length > 0) {
  outSync(formatExecutedMapTotalLine(summarizeExecutedMapResults(executedMapReads)));
}

// ── D-021/P-002: serial-equivalent task work under the budgeted scheduler ────
// Emitted every run, so the answer is re-measured rather than inherited — a number this cheap to
// re-measure should never be quoted from memory. `--print-affected` runs zero tasks, so this
// emits nothing there and the tests pinning that path's marker-less output stay satisfied by
// construction rather than by an explicit exemption. Arithmetic + wording live in the helper.
for (const line of formatSerialPhaseSummary(taskLegs, {
  wallMs:
    phaseFirstStartMs !== null && phaseLastEndMs !== null
      ? phaseLastEndMs - phaseFirstStartMs
      : undefined,
}))
  outSync(line);

// ── P-009: Wire related cargo tests into the affected cadence ────────────────
// Run the Rust/cargo native suite reporter after all related Vitest tasks complete.
// The reporter records test results in harness_shared.test_runs (framework='cargo')
// so the Tests tab covers the desktop shell. A JS-only affected run does not own this
// native suite: coupling the two made unrelated Cargo admission pressure terminal-red the
// scoped JS verdict (EI-21851033142703518). Desktop-related and --all runs still gate on it.
const RUN_CARGO_SUITE = shouldRunAffectedCargoSuite({
  runAll,
  affectedWorkspaceNames: affected.map(({ name }) => name),
  excludedWorkspaceNames: [...excludes],
});
if (RUN_CARGO_SUITE) {
  outSync(
    `\n>>> Running cargo tests (P-009: papercusp-desktop/src-tauri Rust suite)...`,
  );
  try {
    const cargoReporter = resolve(ROOT, "scripts", "report-cargo-tests.mjs");
    const cargoManifest = resolve(
      ROOT,
      "papercusp-desktop",
      "src-tauri",
      "Cargo.toml",
    );
    // EI-15802: this suite runs LAST, so on a non-TTY (background-task) caller its
    // own summary is exactly what a fixed-size tail buffer retains — capture +
    // log it the same way as the vitest tasks above, instead of 'inherit'-only,
    // so an earlier JS/TS failure isn't hidden behind a trailing cargo pass/fail.
    const cargoRun = captureOutput()
      ? spawnSync(
          process.execPath,
          [cargoReporter, "--manifest-path", relative(ROOT, cargoManifest)],
          {
            cwd: ROOT,
            encoding: "utf8",
            maxBuffer: 256 * 1024 * 1024,
          },
        )
      : spawnSync(
          process.execPath,
          [cargoReporter, "--manifest-path", relative(ROOT, cargoManifest)],
          {
            cwd: ROOT,
            stdio: "inherit",
          },
        );
    if (captureOutput()) {
      writeAllSync(1, cargoRun.stdout ?? "");
      writeAllSync(2, cargoRun.stderr ?? "");
      logLine(cargoRun.stdout ?? "");
      logLine(cargoRun.stderr ?? "");
    }
    if (cargoRun.status !== 0) {
      const cargoOutput = `${cargoRun.stdout ?? ""}${cargoRun.stderr ?? ""}`;
      // EI-21950408988436927: a signal kill, an exit-75 admission refusal (the suite
      // never spawned) and a real Rust failure all arrive as one non-zero status, and
      // the middle case must never read as "a Rust test failed" — that sends a triager
      // into papercusp-desktop source that was never compiled. The classification is
      // pure and lives in cargo-result.mjs so it is reachable by test; this branch runs
      // only once cargo has ALREADY failed, so in-process it is exercised by nothing.
      // `gating` is true in every case: only the LABELLING is corrected, so a suite
      // that never ran still cannot let the gate go green.
      const cargoFailureClass = classifyAffectedCargoFailure({
        code: cargoRun.status,
        output: cargoOutput,
      });
      errSync(cargoFailureClass.message);
      if (cargoFailureClass.gating && !quarantined.has("papercusp-desktop")) {
        failed++;
        failedTaskNames.push("papercusp-desktop :: cargo test");
        // Not a vitest task — the vitest FAIL-row parser can never attribute it to files.
        // The task NAME stays stable (downstream repair-queue/GATE_HELD_BY consumers
        // match on it); the distinction rides in the structured reason.
        unattributedTasks.push({
          task: "papercusp-desktop :: cargo test",
          reason: cargoFailureClass.reason,
        });
      } else if (cargoFailureClass.gating) {
        // Quarantine demotes a cargo failure from the gating tally; it must not make the
        // failure disappear. Keep this parallel with the quarantined Vitest branch above so
        // AFFECTED_TESTS_RESULT still reports the observed failure in quarantinedFailed.
        quarantinedFailed++;
        errSync(`  papercusp-desktop :: cargo test (quarantined failure — not gating)`);
      }
    }
  } catch (err) {
    errSync(`>>> cargo test runner error: ${err.message}`);
    failed++;
    failedTaskNames.push("papercusp-desktop :: cargo test (runner error)");
    unattributedTasks.push({
      task: "papercusp-desktop :: cargo test (runner error)",
      reason: "non-vitest",
    });
  }
}

if (quarantinedFailed) {
  errSync(`\n${quarantinedFailed} quarantined task(s) failed (not gating).`);
}
if (notCheckedNonGating) {
  // Greppable, and deliberately distinct from AFFECTED_TESTS_UNDETERMINED: this one does NOT
  // affect the verdict. It names the coverage the run did not obtain so a reader never mistakes
  // a green run for evidence about these guards' invariants.
  errSync(
    `\nAFFECTED_TESTS_NOT_CHECKED tasks=${notCheckedNonGating} (not gating — each declared notCheckedIsNonGating)`,
  );
  for (const name of notCheckedTaskNames) errSync(`  - ${name}`);
}
// P-006 / R-8 sub-req 5 — emits `AFFECTED_TESTS_NOT_EXECUTED`, the sibling disclosure, and
// deliberately placed beside AFFECTED_TESTS_NOT_CHECKED rather than folded into it. Both name
// coverage the run did not obtain, but they are different facts: NOT_CHECKED is a guard that
// declared up front it would look at nothing, while AFFECTED_TESTS_NOT_EXECUTED is a suite that
// COLLECTED tests and executed none of them — the shape that reads identically to a pass
// (EI-19380376466745152). Non-gating for the same reason as its neighbour, and it says so on its
// own line. The token is named here, not just in the formatter, so a triager grepping THIS
// script for the marker they saw in a log lands on the emission site.
{
  const notExecuted = formatNotExecutedSummary(coverage);
  if (notExecuted) errSync(`\n${notExecuted}`);
}
// EI-18796017307093897: a caller observed a background `npm run test:affected`
// job report "completed, exit code 0" while this SAME run's own log said "1
// non-quarantined task(s) failed" — i.e. the wrapper/notification layer that
// relayed the exit code disagreed with what this script actually decided.
// Nothing in this script's own control flow can produce that divergence (the
// `process.exit(1)` below is inseparable from the failure message that
// precedes it — see the regression test asserting exactly that), so the most
// robust fix isn't inside this file's exit-code logic, it's giving every
// caller a way to verify the TRUE verdict independent of exit-code plumbing
// elsewhere. Emit one canonical, greppable, machine-parseable line — mirroring
// `scripts/test-files.mjs`'s `TEST_FILE_RESULT` line — whose `status` token is
// derived from the exact same `failed`/`quarantinedFailed`/`undeterminedTasks` counters that
// decide the exit code below, so an agent, a gate, or a background-task
// notifier can grep RUN_LOG_PATH for this line instead of trusting a
// possibly-misreported exit code alone.
const resultLine = (status) =>
  `AFFECTED_TESTS_RESULT status=${status} tasks=${tasks.length} failed=${failed} quarantinedFailed=${quarantinedFailed} timedOutTasks=${timedOutTasks} undeterminedTasks=${undeterminedTasks}` +
  // P-006 / R-8 sub-req 5. APPEND-ONLY, and that is the compatibility contract: green-checkpoint.ts
  // matches this line whole (SUITE_REFUSAL_LINE_RE) and every other reader tokenises `k=v`, so
  // trailing fields reach existing parsers inert. The prefix through `undeterminedTasks=` stays
  // byte-identical, exactly as the abort-path line above already promises.
  ` ${formatCoverageFields(coverage)}`;
// EI-19416573016968871: which files RAN, stated by the run itself. The verdict log already
// names the files that FAILED; without this counterpart "no FAIL row for X" is
// indistinguishable from "X never ran", and because test:affected only runs the workspaces
// the changed paths map into, the second case is common. That absence reads as a POSITIVE
// observation, so agents used it to DATE regressions and reached confident, wrong causal
// stories (measured 2026-08-03: two agents independently, one chasing an innocent commit).
//
// Emitted HERE — after `resultLine` is defined and BEFORE the refused/failed/passed
// branches — so it appears on every exit path that actually EXECUTED tasks. A run that
// PASSED is exactly when this matters most ("was X green at candidate Y?"), so gating it
// on failure the way the per-file break set is gated would miss the whole point.
//
// ⚠ DELIBERATELY ABSENT from the pre-execution exits, and that is load-bearing rather than
// an oversight. This line asserts which files RAN. The `--dry` exit and the two
// deadline-insufficient/admission-starved `refused` exits all terminate upstream of here
// with tasks SELECTED BUT NEVER RUN, so emitting there would publish a file list that
// never executed — reintroducing, one level down, precisely the "absence/presence reads as
// an execution fact" confusion this line exists to remove. Those paths already say what
// happened in their own `status=` token (`dry-run`, `refused`). Selection and execution are
// different questions; only this line's audience conflates them, so only it must not.
//
// `t.relatedFiles` is set only where narrowing actually produced a positional file list;
// any task without one ran WITHOUT such a list and is named in `unenumerated` rather than
// omitted. Omitting them is what would let `coverage=complete` lie.
const selectedFilesLine = () => {
  const entries = [];
  const unenumerated = [];
  for (const t of tasks) {
    if (Array.isArray(t.relatedFiles) && t.relatedFiles.length > 0) {
      for (const f of t.relatedFiles)
        entries.push({ workspace: t.ws.name, file: f.replaceAll("\\", "/") });
    } else {
      unenumerated.push({
        task: `${t.ws.name} :: ${t.script}`,
        reason: relatedOnly ? "not-narrowed" : "wide-run",
      });
    }
  }
  entries.sort((a, b) =>
    `${a.workspace}\0${a.file}`.localeCompare(`${b.workspace}\0${b.file}`),
  );
  return formatSelectedFilesLine({
    runToken: RUN_TOKEN,
    entries,
    unenumerated,
  });
};
errSync(selectedFilesLine());
const taskCgroupPidsEventsMaxEnd =
  failed || undeterminedTasks ? readTaskCgroupPidsEventMax() : null;
const refusedForks = pidsEventRefusalDelta({
  start: TASK_CGROUP_PIDS_EVENTS_MAX_START,
  end: taskCgroupPidsEventsMaxEnd,
  hasFailures: Boolean(failed || undeterminedTasks),
});
if (refusedForks > 0) {
  // Exit 78 (EX_CONFIG), matching the pre-launch task-budget refusal. Do not emit the normal
  // failed verdict or failing-file attribution: fork refusal makes the red UNDETERMINED and
  // presenting its partial failures as an ordinary test verdict is the defect this guards.
  errSync(
    `AFFECTED_TESTS_REFUSAL kind=pids-exhausted refusedForks=${refusedForks}`,
  );
  errSync(
    `${resultLine("refused")} reason=pids-exhausted refusedForks=${refusedForks}`,
  );
  errSync(
    "NOT MEASURED — the task cgroup refused one or more forks during this red run; " +
      "re-run the named tests outside the constrained scope before source triage.",
  );
  terminalEmitted = true;
  errSync(`Full run log: ${RUN_LOG_PATH}`);
  process.exit(78);
}
if (undeterminedTasks) {
  // A separate marker makes the attribution greppable without forcing triage to infer
  // "failed=0" means process-start uncertainty. The verdict line still says status=failed
  // and the process exits 1 below, so uncertainty can never be mistaken for green.
  errSync(`AFFECTED_TESTS_UNDETERMINED tasks=${undeterminedTasks}`);
  for (const name of undeterminedTaskNames) errSync(`  - ${name}`);
}
if (!failed && undeterminedTasks) {
  errSync(resultLine("failed"));
  terminalEmitted = true;
  errSync(`Full run log: ${RUN_LOG_PATH}`);
  process.exit(1);
}
if (failed) {
  errSync(`\n${failed} non-quarantined task(s) failed:`);
  for (const name of failedTaskNames) errSync(`  - ${name}`);
  // EI-19332556961886184: named separately from the list above so a triager sees the
  // distinction without having to scroll back through each task's own output.
  if (timedOutTasks) {
    errSync(
      `${timedOutTasks} of the ${failed} failed task(s) show a vitest "timed out" signature — ` +
        `verify before assuming a real assertion break (see the per-task note above / grep the run log).`,
    );
  }
  // EI-19395701908500754: the per-FILE break set, stated by the run itself. `resultLine`'s
  // failed=N counts TASKS; a triager needs FILES, and until now the only per-file signal in
  // a green-checkpoint verdict log was the gate's own prose — which its self-tests emit too,
  // so mining it returned fixture paths. Rendered by a unit-tested helper rather than inline:
  // this path runs only when the gate is ALREADY red, so a fault here would surface at the
  // worst possible moment and no source-text assertion could have caught it.
  // WI-37607: `transformCulprits` makes the summary lead with the PARSE failure when one is
  // present. Without it a peer's mid-write reads as `coverage=complete` over N innocent files —
  // measured 21 on this runner and 7 on the gate's own checkout, both stamped complete.
  for (const line of renderFailingFilesSummary({
    runToken: RUN_TOKEN,
    failedTaskCount: failed,
    entries: failedFileEntries,
    unattributed: unattributedTasks,
    transformCulprits: transformCulpritPaths,
    attributionFallbacks,
  })) {
    errSync(line);
  }
  // EI-21082496866331715: git-sync may commit a fix while a long task is still running. Compare
  // each named failure's blob at the captured start ref with the current HEAD, but keep this as an
  // advisory block: the existing task/file verdict contracts and exit code must not change.
  const reportHead = gitOutput(["rev-parse", "HEAD"]);
  const runStartBlobs = Object.create(null);
  const reportBlobs = Object.create(null);
  for (const entry of failedFileEntries) {
    const key = failureEntryKey(entry);
    const repoPath = failureRepoPath(entry);
    runStartBlobs[key] = gitBlobAt(RUN_START_HEAD, repoPath);
    reportBlobs[key] = gitBlobAt(reportHead, repoPath);
  }
  const staleFailureClassification = classifyStaleFailureEntries({
    entries: failedFileEntries,
    runStartBlobs,
    reportBlobs,
  });
  for (const line of formatStaleFailureSummary({
    runStartHead: RUN_START_HEAD,
    reportHead,
    stale: staleFailureClassification.stale,
  })) {
    errSync(line);
  }
  // WI-972025: the stale-failure block above only fires when a FAILING TEST FILE's own blob
  // moved. A failure caused by a mid-run rewrite of a module that file IMPORTS leaves both of
  // its blobs identical, so it classifies as `current` and the advisory stays silent — which is
  // exactly how a 53-minute run reported two phantom collection failures as confident reds
  // (see formatTreeDriftAdvisory's header for the measured case). HEAD moving is the signal
  // that check cannot produce, and this run already holds both refs. Advisory only: the exit
  // code and every existing verdict contract are untouched.
  const treeDrifted =
    RUN_START_HEAD && reportHead && RUN_START_HEAD !== reportHead;
  for (const line of formatTreeDriftAdvisory({
    runStartHead: RUN_START_HEAD,
    reportHead,
    changedPaths: treeDrifted
      ? (
          gitOutput([
            "diff",
            "--name-only",
            `${RUN_START_HEAD}..${reportHead}`,
          ]) ?? ""
        )
          .split("\n")
          .filter(Boolean)
      : [],
    commitCount: treeDrifted
      ? Number(
          gitOutput([
            "rev-list",
            "--count",
            `${RUN_START_HEAD}..${reportHead}`,
          ]) ?? "",
        ) || null
      : null,
  })) {
    errSync(line);
  }
  // EI-20072082961786945: the two advisories above answer "did the tree move" and "did THIS
  // failing file's blob move". Neither answers the question a triager asks FIRST — is this red
  // mine? — so the break set hands back a workspace + filename and the reader reconstructs the
  // answer by hand. Intersect each failure with the caller's OWN `--changed-paths` set, and when
  // there is no such set say that plainly rather than inventing a per-file verdict from a radius
  // the caller never chose. Advisory only, for the same reason as its two siblings: this is a
  // label that NARROWS a search, and the exit code / verdict lines must not carry a guess.
  for (const line of formatFailureScopeSummary({
    runToken: RUN_TOKEN,
    classification: classifyFailureScope({
      entries: failedFileEntries,
      callerPaths: changedPathsOverride,
      workspaceDirs: Object.fromEntries(
        [...wsByName].map(([name, ws]) => [name, ws.dir]),
      ),
    }),
    treeDrifted,
  })) {
    errSync(line);
  }
  // WI-38300: a SEPARATE greppable advisory, deliberately NOT a field on resultLine — that
  // line's shape is pinned by affected-tests-result-line.test.ts and parsed by
  // green-checkpoint, and widening a VERDICT contract to carry an ADVISORY is how advisories
  // come to be read as verdicts. Emitted only when there is load-suspect residue, so its
  // absence is the ordinary case and costs no output.
  if (loadSuspectTasks.length) {
    errSync(
      formatLoadSuspectMarker({
        tasks: loadSuspectTasks.length,
        files: loadSuspectTasks.reduce((n, e) => n + e.files.length, 0),
        maxLoad1: Math.max(...loadSuspectTasks.map((e) => e.load1AtRerun)),
        threshold: retryLoad1Threshold,
      }),
    );
  }
  errSync(resultLine("failed"));
  terminalEmitted = true;
  errSync(`Full run log: ${RUN_LOG_PATH}`);
  process.exit(1);
}
outSync("\nAll affected tests passed.");
outSync(resultLine("passed"));

// WI-42146 / P-047 — advance the test-certified watermark. STRICT by construction:
// this line is only reachable after every `failed` / `undeterminedTasks` exit above,
// and `decideWatermarkAdvance` refuses every run that measured less than its own full
// derived radius. Scope is read from RAW argv rather than a local variable a later
// refactor could redefine — but through the shared helper, because the CLI accepts
// `--changed-paths=foo` as well as `--changed-paths foo` and a bare `includes()`
// answers FALSE for the `=` form. That would let a one-file run certify the whole
// tree: the single mistake in this feature that actually corrupts a later radius.
try {
  const decision = decideWatermarkAdvance({
    env: process.env,
    argv: process.argv,
    failed,
    undeterminedTasks,
    timedOutTasks,
    // Certify the sha the run STARTED at, never current HEAD: git-sync commits the
    // shared tree continuously, so HEAD has very likely moved during a run this long,
    // and certifying it would vouch for commits no task ever saw.
    runStartHead: RUN_START_HEAD,
  });
  if (
    decision.advance &&
    gitTry(["update-ref", TEST_CERTIFIED_REF, decision.sha]) !== null
  ) {
    outSync(
      `AFFECTED_TEST_CERTIFIED ref=${TEST_CERTIFIED_REF} sha=${String(decision.sha).slice(0, 12)} ` +
        `tasks=${tasks.length} — the next unscoped run diffs from here instead of origin/main`,
    );
  }
} catch {
  /* advancing the watermark is an optimization; never fail a green run over it */
}
terminalEmitted = true;
outSync(`Full run log: ${RUN_LOG_PATH}`);
// WI-1334906: every OTHER terminal branch in this file (refusedForks, the
// undetermined-only path, the `failed` path, both zero-task branches, and
// `--print-affected`/dry-run) ends with an explicit `process.exit(N)`. This,
// the plain "all affected tests passed" branch — the common case for a
// healthy run with real tasks — was the ONE exception: it fell off the end
// of the module and relied on Node's default behavior of exiting once the
// event loop empties on its own.
//
// That default breaks the instant ANYTHING this run (or a tool one of its
// spawned tasks pulled in transitively, e.g. esbuild's persistent transform
// service) leaves a live handle behind — a pipe, a socket, an unref'd timer
// that got ref'd back. Measured: a green-checkpoint run whose suite had
// already finished (219 files, durable in `test_runs`) sat idle at ~0% CPU
// for 39+ minutes past completion with ZERO vitest workers left, its only
// surviving child an orphaned `esbuild --service` still holding the loop
// open — no verdict ever written, the shared run-lock held until killed,
// and the next scheduled fire refused `already_running`. Any red run was
// immune (it force-exits above); only the green path could wedge like this.
//
// Force the exit here exactly like every sibling branch already does, so a
// stray handle downstream can delay flushing this line but can never again
// cost the whole verdict. `terminalEmitted` is already true, so the `exit`
// handler's abort-marker guard (see emitAbortMarker) is a correct no-op.
process.exit(0);
