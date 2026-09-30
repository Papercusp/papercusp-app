/**
 * capability:bash_output — read incremental output from a background shell job
 * started by `capability:bash` (run_in_background). Mirrors the native
 * BashOutput tool: each call returns the output produced SINCE the last read
 * (use `peek` to read without advancing the cursor) plus the job's status.
 * Part of P-010 (`agent-capability-confinement-2026-06-13`).
 */

import { z } from 'zod';
import { execFile } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import {
  BASH_TEST_MEMORY_MAX_BYTES,
  BASH_TEST_TASKS_MAX,
  JOB_LOG_END_MARKER_PREFIX,
  JOB_LOG_DIED_MARKER_PREFIX,
  detectBufferingLastStage,
  detectSelfOutputRedirect,
  formatJobLogDiedMarker,
  formatBufferingPipelineAdvice,
  formatSelfRedirectAdvice,
  getJob,
  readJobOutput,
  scratchDir,
  type BashStatus,
  type BashJob,
} from './bash-jobs';
import { backgroundTypecheckVerdict } from './background-typecheck-verdict';
import { capturedExitMismatch } from './captured-exit-verdict';
import { coresBetween, readCgroupCpuSample, MIN_SAMPLE_GAP_MS } from './cgroup-cpu';
import { getTask, getTaskByBashJobId } from '../../task-manager/store';
import { isTerminalState, serviceUnitForTask, type TaskRow } from '../../task-manager/types';
import { readProcessIdentity } from '../../process-identity';
import { readProcessCgroupPath, readProcessCmdline } from '../../task-manager/cgroup-read';
import {
  hasForkStarvationEvidence,
  parseTaskBudgetRefusal,
} from '../../../../../scripts/lib/task-exit-class.mjs';

/**
 * Cap on the spill log we will read whole to classify a dead typecheck. A tsc
 * log is small (apps/operator's 850-diagnostic run is ~200KB), so this only ever
 * trips for something that is not the case we are classifying — and the retained
 * in-memory tail is the safe fallback, since the OOM/abort signature is written
 * LAST.
 */
const MAX_VERDICT_LOG_BYTES = 16 * 1024 * 1024;

/**
 * The full job output, for verdict classification only. Falls back to the
 * retained tail whenever the spill log is unreadable or implausibly large —
 * never throws, because a failure to classify must degrade to "no verdict", not
 * to a failed poll.
 */
function readJobLogForVerdict(job: BashJob): string {
  try {
    if (statSync(job.logPath).size > MAX_VERDICT_LOG_BYTES) return job.buffer;
    return readFileSync(job.logPath, 'utf8');
  } catch {
    return job.buffer;
  }
}

/** Tail this many bytes of a stranded job's log when the in-memory registry
 *  missed but the file survived on disk (EI-8855). */
export const STRANDED_LOG_TAIL_BYTES = 8_000;

/**
 * Keep the full body available for a filtered stranded-log read only while it
 * remains within the same bounded-read ceiling used by verdict inspection. A
 * larger log still gets its tail, but is never loaded wholesale just to apply
 * a caller-supplied regex.
 */
const MAX_STRANDED_LOG_CONTENT_BYTES = MAX_VERDICT_LOG_BYTES;

/**
 * EI-8855: the in-memory job registry (bash-jobs.ts) assumes "the operator is one
 * long-lived process" — false on a shared dev box where a DIFFERENT agent's
 * routine `systemctl --user restart papercup-*-api.service` (a common, documented
 * workflow — see repo-conventions § two-port model) kills the WHOLE service cgroup,
 * wiping every in-flight capability:bash background job's registry entry AND the
 * job's own child process in one shot. The caller then sees a bare "unknown_bash_id"
 * indistinguishable from a typo'd id or a truly-vanished job. Since the log path is
 * DETERMINISTIC from `stateDir` + `bash_id` (no registry needed), we can check
 * whether that file exists on disk even after the in-memory entry is gone, and
 * report the REAL diagnosis (stranded by a restart, not "wrong id") plus the
 * output the job DID produce before it died — instead of a dead end.
 *
 * EI-18666279107998059: also returns the log file's `birthtimeMs` (creation time,
 * a proxy for the job's own start time) so the caller can tell a genuine operator
 * restart apart from the job's OWN process dying independently — see
 * `diagnoseStrandedCause`. */
export type StrandedJobLog = {
  logPath: string;
  sizeBytes: number;
  tail: string;
  /** Full bounded body, present when the spill log fits the read ceiling. */
  content?: string;
  birthtimeMs: number;
};

/** Read only the final bounded tail of a spill log that is too large to retain whole. */
function readStrandedLogTail(logPath: string, sizeBytes: number): string {
  const bytesToRead = Math.min(sizeBytes, STRANDED_LOG_TAIL_BYTES);
  if (bytesToRead <= 0) return '';
  const buffer = Buffer.alloc(bytesToRead);
  const fd = openSync(logPath, 'r');
  let bytesRead = 0;
  try {
    while (bytesRead < bytesToRead) {
      const read = readSync(fd, buffer, bytesRead, bytesToRead - bytesRead, sizeBytes - bytesToRead + bytesRead);
      if (read === 0) break;
      bytesRead += read;
    }
  } finally {
    closeSync(fd);
  }
  return buffer.subarray(0, bytesRead).toString('utf8');
}

/** Read a known spill-log path without reconstructing it from this worker's stateDir. */
export function strandedJobLookupAtPath(logPath: string): StrandedJobLog | null {
  try {
    const st = statSync(logPath);
    if (!st.isFile()) return null;
    if (st.size <= MAX_STRANDED_LOG_CONTENT_BYTES) {
      const content = readFileSync(logPath, 'utf8');
      const tail = content.length > STRANDED_LOG_TAIL_BYTES ? content.slice(-STRANDED_LOG_TAIL_BYTES) : content;
      return { logPath, sizeBytes: st.size, tail, content, birthtimeMs: st.birthtimeMs };
    }
    return {
      logPath,
      sizeBytes: st.size,
      tail: readStrandedLogTail(logPath, st.size),
      birthtimeMs: st.birthtimeMs,
    };
  } catch {
    return null;
  }
}

export function strandedJobLookup(bashId: string, stateDir: string | undefined): StrandedJobLog | null {
  const logPath = join(scratchDir(stateDir), `bash-${bashId}.log`);
  return strandedJobLookupAtPath(logPath);
}

/**
 * EI-18666279107998059: decide WHICH of the two known causes actually explains a
 * stranded job, instead of asserting the more dramatic one ("the operator
 * restarted") as fact with no evidence check (the EI-16635 bug this superseded —
 * confirmed live: a job's tracking went stranded while `dev:service_health` showed
 * zero restarts, so the true cause was the job's OWN process dying independently).
 *
 * The check is simple and needs no extra I/O: THIS operator process's own
 * `process.uptime()` tells us exactly when it started. If it started AFTER the
 * job's log file was created, the operator must have restarted at some point
 * after the job began running — a restart is CONFIRMED.
 *
 * The other branch is the one that keeps getting mis-stated, so state it
 * precisely: if this process has been running continuously since before the job
 * started, a restart is IMPOSSIBLE (this very process would not exist to answer
 * the call). That rules out ONE cause. It says NOTHING about whether the job's
 * own process is still running — and on this box the overwhelmingly common
 * explanation is a job QUEUED behind pc-heavy's slot clamp, alive and simply not
 * producing output yet. Hence `job_liveness_unknown`, not `job_process_gone`:
 * the token names what this check can establish, which is the absence of one
 * cause, not the presence of a death.
 *
 * That distinction is not cosmetic — the two states have OPPOSITE correct
 * responses (keep waiting vs re-run), and re-running a queued heavy job adds
 * load to the very queue whose depth caused the missing output. Reported four
 * times independently (EI-19304682667917795, EI-19310882583645327,
 * EI-19327967209159644, EI-19332191089874223) before the code was corrected:
 * EI-18666279107998059 fixed the advice PROSE to hedge correctly but left the
 * `reason` field — the one callers branch on — asserting the confirmed-dead
 * token. Prose that contradicts its own status code loses to the status code.
 *
 * `job_process_gone` now has exactly one emitter: the ledger-confirmed terminal
 * state above, which really did observe an exit.
 */
export function diagnoseStrandedCause(opts: {
  jobBirthtimeMs: number;
  /** Defaults to the real `process.uptime()` — injectable for deterministic tests. */
  processUptimeMs?: number;
  /** Defaults to `Date.now()` — injectable for deterministic tests. */
  now?: number;
}): 'stranded_by_operator_restart' | 'job_liveness_unknown' {
  const now = opts.now ?? Date.now();
  const processUptimeMs = opts.processUptimeMs ?? process.uptime() * 1000;
  const processStartedAtMs = now - processUptimeMs;
  return processStartedAtMs > opts.jobBirthtimeMs ? 'stranded_by_operator_restart' : 'job_liveness_unknown';
}

/**
 * EI-18759519171684432: `diagnoseStrandedCause` above only rules out ONE cause (a
 * whole-operator restart) — it was never sound evidence that the job's OWN process
 * actually died, yet the handler asserted exactly that ("CONFIRMED NOT the cause …
 * the job's OWN process died independently") with no process check at all. Live
 * repro: a `test:affected` run was still executing (confirmed via `ps`, log file
 * still growing) while this verdict told the caller to re-run it — doubling the
 * load on an already-loaded box.
 *
 * The durable task-manager ledger (task-manager-no-escape-2026-07-27) is the fix:
 * `startBackground` stamps every job's ledger row with `detail.bashJobId` and its
 * spawned `pid` + `processIdentity` (a boot-id+start-ticks pair immune to PID
 * reuse — D-011), and that row survives exactly the failure that wipes the
 * in-memory JOBS map (an operator restart, or eviction under load). So instead of
 * inferring liveness from operator uptime, RE-PROBE the recorded pid's identity now
 * and compare: if it still matches, the process is CONFIRMED alive regardless of
 * what happened to the in-memory tracking. If the ledger itself already recorded a
 * terminal exit, that is stronger evidence than any heuristic. Only when neither
 * signal is available do we fall back to the uptime heuristic (below).
 */
export type LedgerLivenessVerdict =
  | { kind: 'confirmed_alive'; pid: number; scopeUnit: string | null; taskId: string }
  | {
      kind: 'confirmed_dead';
      state: string;
      exitCode: number | null;
      exitReason: string | null;
      /** Was this job's process running inside its own systemd scope (task-manager
       *  confined) or as a direct, unconfined child of the operator process? See
       *  the advice-building note at the `job_process_gone` handler branch below —
       *  this is what lets the advice explain a `stranded` verdict instead of
       *  reporting it as an unattributed mystery (EI-19315479997523199). */
      confined: boolean;
    }
  | { kind: 'no_ledger_row' }
  | { kind: 'ledger_inconclusive' };

/**
 * `processes:kill` addresses a durable task by taskId. The systemd scope is
 * diagnostic metadata returned by bash_output, not an accepted kill argument.
 */
export function confirmedAliveStopAdvice(): string {
  return 'To stop it, use processes:kill with the taskId below — never a bare kill.';
}

/**
 * Explain a ledger-confirmed stranded job without overstating what confinement
 * guarantees. A `systemd-run --scope` payload is outside the operator service's
 * cgroup, but the `systemd-run` monitor remains the operator's child. A routine
 * :3070/:3170 restart can therefore kill that monitor and end the sibling scope
 * too (EI-20219872509843731, observed across a restart wave on 2026-08-12).
 */
export function strandedJobAdvice(confined: boolean): string {
  return confined
    ? ' This job was CONFINED in its own systemd scope (task-manager), but the current ' +
        '`systemd-run --scope` monitor is still a child of the launching operator. A routine ' +
        ':3070/:3170 restart can end the scope, so confinement is a resource boundary, not a ' +
        'restart-durability guarantee. Check the operator service journal around the scope end ' +
        'time before attributing it to OOM or a manual `processes:kill`.'
    : ' This job was UNCONFINED (task-manager confinement was off, or its probe failed, at the moment ' +
        'it spawned), so it ran as a direct child of the operator process — the far more likely ' +
        'explanation is the routine, documented one: a peer restarted :3070/:3170 mid-job (repo-' +
        'conventions § two-port model) and every OTHER unconfined in-flight background job died with it. ' +
        'Not a bug in your command.';
}

export interface TaskProcessLivenessProbe {
  processIdentity: string | null;
  cgroupPath: string | null;
  cmdline: string;
}

function probeTaskProcess(pid: number): TaskProcessLivenessProbe {
  return {
    processIdentity: readProcessIdentity(pid),
    cgroupPath: readProcessCgroupPath(pid),
    cmdline: readProcessCmdline(pid),
  };
}

export function diagnoseFromLedger(
  row: TaskRow | null,
  probe: (pid: number) => TaskProcessLivenessProbe = probeTaskProcess,
): LedgerLivenessVerdict {
  if (!row) return { kind: 'no_ledger_row' };
  if (isTerminalState(row.state)) {
    return {
      kind: 'confirmed_dead',
      state: row.state,
      exitCode: row.exitCode ?? null,
      exitReason: row.exitReason ?? null,
      confined: row.confined,
    };
  }
  // pending/running/unaccounted/foreign: the ledger THINKS a process is alive.
  // Re-probe the stable identity + owned cgroup before calling a verifier alive.
  // The command line is intentionally NOT a liveness pin: a shell can naturally
  // exec the workload (npm/tsc/etc.) while retaining the same boot/start identity
  // and cgroup. Requiring byte-identical argv made the first recovery read green
  // and a later read downgrade the same live job to `job_liveness_unknown`.
  // Missing identity/cgroup data still fails closed to inconclusive; liveness is
  // never inferred from a partial pin set.
  if (row.pid && row.processIdentity && row.confined && row.scopeUnit && row.cgroupPath) {
    const now = probe(row.pid);
    if (now.processIdentity === row.processIdentity && now.cgroupPath === row.cgroupPath) {
      return { kind: 'confirmed_alive', pid: row.pid, scopeUnit: row.scopeUnit ?? null, taskId: row.taskId };
    }
  }
  // The kernel disagrees with the ledger's non-terminal state (or we lack enough
  // to re-probe), but we never OBSERVED an exit — asserting death here would be the
  // exact overclaim this fix exists to remove. Let the reconciler (which runs
  // regardless) settle this row to `stranded` in its own time; report honestly that
  // this read could not confirm either way.
  return { kind: 'ledger_inconclusive' };
}

type ScopeActiveExec = (
  file: string,
  args: readonly string[],
  options: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr?: string }>;

let scopeExecFile: ScopeActiveExec | null = null;
function runScopeActiveExec(
  file: string,
  args: readonly string[],
  options: { timeout?: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr?: string }> {
  if (!scopeExecFile) scopeExecFile = promisify(execFile) as unknown as ScopeActiveExec;
  return scopeExecFile(file, args, options);
}
const LIVE_SCOPE_ACTIVE_STATES = new Set(['active', 'activating', 'reloading', 'deactivating']);

/**
 * Ask the user systemd whether a durable bash-job service is still active.
 *
 * The PID/cgroup identity probe above is the strongest proof when all of its
 * pins are available, but a freshly enrolled scope can briefly have an
 * inconclusive row while its child is already queued behind pc-heavy. The unit
 * name is minted from the task id and is independent of the worker-local JOBS
 * map, PID timing, and cgroup-read races. Only accept the canonical service
 * name for a confined bash-job row; an arbitrary unit must never become a
 * liveness oracle. Failing to query systemd remains inconclusive, never dead.
 */
export async function taskScopeIsActive(
  row: Pick<TaskRow, 'taskId' | 'class' | 'confined' | 'scopeUnit'>,
  execFn: ScopeActiveExec = runScopeActiveExec,
): Promise<boolean> {
  if (row.class !== 'bash-job' || !row.confined || !row.scopeUnit) {
    return false;
  }
  try {
    // Keep malformed or legacy rows fail-soft too: a liveness read must never
    // turn bad ledger metadata into a handler exception.
    if (row.scopeUnit !== serviceUnitForTask(row.taskId)) return false;
    const { stdout } = await execFn('systemctl', ['--user', 'show', '-p', 'ActiveState', '--value', row.scopeUnit], {
      timeout: 2_000,
      maxBuffer: 64 * 1024,
    });
    return LIVE_SCOPE_ACTIVE_STATES.has(stdout.trim());
  } catch {
    return false;
  }
}

/** Max length of an agent-supplied `filter` regex (ReDoS surface bound). */
const MAX_FILTER_LEN = 200;

/**
 * Heuristic for a catastrophic-backtracking (ReDoS) pattern: a quantified GROUP
 * whose body itself contains a quantifier — `(a+)+`, `(.*)*`, `(a{2,})+`, `(.+){8}`.
 * This is the classic nested-quantifier signature; it runs in the shared OPERATOR
 * process, where a hang would block every concurrent agent's MCP calls, so we
 * reject rather than risk it. Approximate (not a full safe-regex analysis) but it
 * covers the common exponential-blowup classes.
 */
function isLikelyCatastrophicRegex(re: string): boolean {
  return /\([^)]*[+*}][^)]*\)\s*[+*{]/.test(re);
}

/**
 * EI-22076120901648689: agents routinely write filters in the PCRE/Perl/Go
 * convention of a bare inline-flag prefix — `(?i)word`, `(?im)^err` — to mean
 * "apply these flags to the rest of the pattern". JavaScript's RegExp has no
 * such bare form (its 2023 modifiers proposal only recognizes the wrapping
 * `(?i:...)` group form), so `new RegExp('(?i)word')` always throws
 * `SyntaxError: Invalid group`. Since this tool's own schema says it "mirrors
 * the native BashOutput filter", that throw reads as a server mismatch rather
 * than a caller mistake. Recognized letters are lifted onto JS's RegExp
 * flags instead of being rejected; an unrecognized letter (e.g. PCRE `x` for
 * free-spacing mode, which JS has no equivalent for) is left alone so the
 * normal invalid-regex fallback below still applies.
 */
const PCRE_INLINE_FLAGS_PREFIX = /^\(\?([a-zA-Z]+)\)/;
const SUPPORTED_JS_FLAG_CHARS = new Set(['i', 'm', 's']);

/**
 * Strip a leading PCRE-style bare inline-flag group (`(?i)`, `(?im)`, …) off
 * `pattern` and translate it to JS RegExp flags, when every flag letter has a
 * JS equivalent. Otherwise returns `pattern` unchanged with no flags, so the
 * caller's normal `new RegExp` attempt (and its error-fallback path) runs
 * exactly as before.
 */
function stripPcreInlineFlags(pattern: string): { pattern: string; flags: string } {
  const m = pattern.match(PCRE_INLINE_FLAGS_PREFIX);
  if (!m) return { pattern, flags: '' };
  const chars = m[1].split('');
  if (chars.length === 0 || !chars.every((c) => SUPPORTED_JS_FLAG_CHARS.has(c))) return { pattern, flags: '' };
  return { pattern: pattern.slice(m[0].length), flags: Array.from(new Set(chars)).join('') };
}

/**
 * Apply the native-BashOutput `filter` regex to an output chunk: keep only the
 * LINES matching `filter` (the caller advances the cursor over the full chunk
 * regardless, so non-matching lines aren't re-shown). Never throws or hangs: an
 * invalid OR ReDoS-prone OR over-long regex returns the unfiltered chunk plus an
 * `error` note (the filter runs in the shared operator process, so an
 * agent-supplied pattern must not be able to wedge it). A leading PCRE-style
 * bare inline-flag prefix (`(?i)`, `(?im)`, `(?is)`) is honored rather than
 * treated as invalid — see `stripPcreInlineFlags`. Exported pure for
 * deterministic unit testing (no subprocess).
 */
export function filterOutputLines(chunk: string, filter: string | undefined): { output: string; error?: string } {
  if (!filter) return { output: chunk };
  if (filter.length > MAX_FILTER_LEN) {
    return { output: chunk, error: `filter regex too long (>${MAX_FILTER_LEN} chars) — returning unfiltered output` };
  }
  if (isLikelyCatastrophicRegex(filter)) {
    return {
      output: chunk,
      error: 'filter regex rejected (ReDoS-prone nested quantifier) — returning unfiltered output',
    };
  }
  try {
    const { pattern, flags } = stripPcreInlineFlags(filter);
    const re = new RegExp(pattern, flags);
    return {
      output: chunk
        .split('\n')
        .filter((line) => re.test(line))
        .join('\n'),
    };
  } catch (err) {
    return {
      output: chunk,
      error: `invalid filter regex (${err instanceof Error ? err.message : String(err)}) — returning unfiltered output`,
    };
  }
}

type RecoveredJobStatus = Exclude<BashStatus, 'running'>;

/** Translate a terminal task-ledger row into the normal BashOutput status shape. */
export function terminalStatusFromLedger(
  row: TaskRow | null,
): { status: RecoveredJobStatus; exitCode: number | null } | null {
  if (!row || !isTerminalState(row.state)) return null;
  switch (row.state) {
    case 'exited':
      return { status: row.exitCode === 0 ? 'completed' : 'failed', exitCode: row.exitCode ?? null };
    case 'killed':
      return { status: 'killed', exitCode: row.exitCode ?? null };
    case 'timed_out':
      return { status: 'timed_out', exitCode: row.exitCode ?? null };
    case 'stranded':
    case 'ended_unobserved':
      // These states prove the task is over but deliberately carry no trustworthy
      // shell exit code. Preserve the error path instead of manufacturing success.
      return { status: 'failed', exitCode: row.exitCode ?? null };
    default:
      return null;
  }
}

export type TerminalResourceLimitFields = {
  failure_class: 'infrastructure-resource-limit';
  /**
   * Discriminated on `source` rather than nulling the sample fields: a pre-launch refusal
   * never took a cgroup sample, and reporting `observed_tasks: null` would claim a
   * measurement that does not exist. Each variant carries only the numbers its own evidence
   * actually produced.
   */
  resource_limit:
    | {
        kind: 'pids';
        observed_tasks: number;
        configured_tasks_max: number;
        source: 'task-ledger-cgroup-sample';
      }
    | {
        kind: 'pids';
        observed_tasks: number;
        configured_tasks_max: number;
        historical_pids_events_max: number;
        source: 'task-ledger-historical-pids-events';
      }
    | {
        kind: 'pids' | 'memory';
        unit: 'tasks' | 'mb';
        configured_limit: number;
        reserve: number;
        required_per_task: number;
        source: 'pre-launch-budget-refusal';
      };
  test_verdict?: 'undetermined';
  resource_advice: string;
};

/**
 * Turn a terminal ledger sample at the cgroup's hard TasksMax into an explicit
 * infrastructure verdict.
 *
 * EI-21437837415175286: a progressing `test:affected` run reached exactly 2,048
 * tasks in its 2,048-task capability scope. The next shell fork failed with
 * EAGAIN, pc-heavy lost bash's `wait_for` record, and callers received only
 * `status=failed exit=254` — indistinguishable from a real red suite even though
 * no AFFECTED_TESTS_RESULT existed. `pidsCurrent` is the reconciler's direct
 * cgroup `pids.current` sample and `tasksMax` is the budget written to that same
 * scope. Equality proves PRESSURE, not CAUSALITY: a Vitest run can touch TasksMax,
 * drain its workers, and still finish with a complete real-red summary. Attribute
 * the non-zero exit to this limit only when the log carries fork/spawn starvation
 * evidence, or when bash returns the observed wait-for-loss code 254.
 */
export function terminalResourceLimitFields(
  row: TaskRow | null,
  log = '',
): TerminalResourceLimitFields | null {
  if (!row || !isTerminalState(row.state)) return null;
  const testRun = row.detail?.workloadClass === 'test-run';
  const cleanExit = row.state === 'exited' && row.exitCode === 0;
  // Order is deliberate: the cgroup sample is the older, narrower evidence and keeps its exact
  // prior behaviour — including never firing on a clean exit, where a sample AT the cap proves
  // pressure, not causality. The refusal path below deliberately DOES run on a clean exit
  // (EI-21468591394619357): the marker is the scheduler's own statement that it refused before
  // launching anything, so a shell that still exited 0 — the trailing-echo idiom
  // `…; echo "EXIT=$?" >> log` reports the echo's status, not the suite's (real row
  // 0mt9a68dm1ejyc3in6q: exit 0, workloadClass=test-run, tasks=0) — is a MASKED abort, and
  // exit 0 is exactly the shape that must not be read as a green run. The two branches remain
  // mutually exclusive in practice anyway — a run refused before launch spawns no child, so
  // there is nothing for the ledger to have sampled.
  return (
    (cleanExit ? null : terminalCgroupSampleFields(row, log, testRun)) ??
    preLaunchBudgetRefusalFields(row, log, testRun)
  );
}

function terminalCgroupSampleFields(
  row: TaskRow,
  log: string,
  testRun: boolean,
): TerminalResourceLimitFields | null {
  const observed = row.pidsCurrent;
  const configured = row.tasksMax;
  if (
    observed == null ||
    configured == null ||
    !Number.isSafeInteger(observed) ||
    !Number.isSafeInteger(configured) ||
    observed < 0 ||
    configured <= 0
  ) {
    return null;
  }
  const atCurrentCap = observed >= configured;
  const causalEvidence = hasForkStarvationEvidence(log) || row.exitCode === 254;
  if (atCurrentCap && causalEvidence) {
    return {
      failure_class: 'infrastructure-resource-limit',
      resource_limit: {
        kind: 'pids',
        observed_tasks: observed,
        configured_tasks_max: configured,
        source: 'task-ledger-cgroup-sample',
      },
      ...(testRun ? { test_verdict: 'undetermined' as const } : {}),
      resource_advice:
        `This task reached its own cgroup TasksMax (${observed}/${configured}); its non-zero shell exit is ` +
        `${testRun ? 'an UNDETERMINED test run, not a red suite verdict' : 'an infrastructure resource-limit failure'}.`,
    };
  }

  // `pids.events:max` is cumulative for the lifetime of this task's unique cgroup. It
  // remains positive after workers drain, so it is the only surviving evidence when the
  // final `pids.current` sample has fallen below TasksMax. Do not let that historical signal
  // replace a complete test result: the cgroup may have experienced pressure earlier while
  // the runner still produced a trustworthy red summary.
  const historical = row.pidsEventsMax;
  if (
    historical == null ||
    !Number.isSafeInteger(historical) ||
    historical <= 0 ||
    hasCompleteTestVerdict(log)
  ) {
    return null;
  }
  return {
    failure_class: 'infrastructure-resource-limit',
    resource_limit: {
      kind: 'pids',
      observed_tasks: observed,
      configured_tasks_max: configured,
      historical_pids_events_max: historical,
      source: 'task-ledger-historical-pids-events',
    },
    ...(testRun ? { test_verdict: 'undetermined' as const } : {}),
    resource_advice:
      `This task's cgroup recorded ${historical} refused fork attempt${historical === 1 ? '' : 's'} ` +
      `at TasksMax ${configured}; its latest pids.current sample was ${observed}/${configured}. ` +
      `${testRun ? 'This is an UNDETERMINED test run, not a red suite verdict' : 'The non-zero shell exit is an infrastructure resource-limit failure'}.`,
  };
}

function hasCompleteTestVerdict(log: string): boolean {
  // Strip SGR before matching Vitest's line-anchored summary. The affected-tests marker is
  // already plain machine-readable output and is a complete verdict when it says passed or
  // failed; `aborted` deliberately remains eligible for the historical evidence branch.
  // eslint-disable-next-line no-control-regex -- SGR is the ANSI sequence being stripped.
  const plain = log.replace(/\x1b\[[0-9;]*m/g, '');
  return (
    /\bAFFECTED_TESTS_RESULT\s+status=(?:passed|failed)\b/i.test(plain) ||
    /^\s*(?:Test Files|Tests)\s+\d+\s+failed\b/m.test(plain)
  );
}

/**
 * EI-21442389733525112: classify a run the scheduler refused BEFORE launching anything.
 *
 * The mid-run form of this failure is already handled above, but it is recognised from a
 * terminal `pids.current` sample at the cap — and a pre-launch refusal has no such sample
 * (`pidsCurrent` stays null), so it fell through as a bare `failed` / `exit 1`. Measured on
 * one real pair: `pids_current=512, tasks_max=512, exit=254` classified, while
 * `pids_current=NULL, tasks_max=512, exit=1` did not. Same root cause, and the unclassified
 * one is exactly the one an agent reads as a red suite — even though nothing ran, so zero
 * files were measured and the only honest verdict is "undetermined".
 *
 * The evidence therefore has to come from the log, where the scheduler states the refusal in
 * its own words. `parseTaskBudgetRefusal` owns that grammar jointly with the emitter.
 */
function preLaunchBudgetRefusalFields(
  row: TaskRow,
  log: string,
  testRun: boolean,
): TerminalResourceLimitFields | null {
  const refusal = parseTaskBudgetRefusal(log);
  if (!refusal) return null;
  const unitLabel = refusal.unit === 'mb' ? 'MB' : 'tasks';
  const cleanExit = row.state === 'exited' && row.exitCode === 0;
  // EI-21468591394619357: this row is TERMINAL by construction (the caller gates on
  // isTerminalState), so the old advice — processes:limit on THIS taskId — was unreachable
  // every time it was printed: the refused task exits within seconds of launch, and
  // processes:limit answers not_live/'state is exited' (verified against the real task
  // 0mt9a68dm1ejyc3in6q). The levers that exist apply at the NEXT launch: a relaunched
  // capability:bash command classified as a test run receives the test budget at spawn,
  // which admits the scheduler's reserve+envelope; targeted testing:run sidesteps the outer
  // scheduler entirely.
  const remedy =
    refusal.kind === 'pids'
      ? `relaunching it (test-classified commands are auto-budgeted TasksMax=${BASH_TEST_TASKS_MAX} at spawn, which admits the ${refusal.reserve}+${refusal.requiredPerTask} envelope), or running the specific files via testing:run`
      : `relaunching it (test-classified commands are auto-budgeted ${Math.floor(BASH_TEST_MEMORY_MAX_BYTES / (1024 * 1024))} MB memoryMaxMb at spawn), or running the specific files via testing:run`;
  return {
    failure_class: 'infrastructure-resource-limit',
    resource_limit: {
      kind: refusal.kind,
      unit: refusal.unit,
      configured_limit: refusal.limit,
      reserve: refusal.reserve,
      required_per_task: refusal.requiredPerTask,
      source: 'pre-launch-budget-refusal',
    },
    ...(testRun ? { test_verdict: 'undetermined' as const } : {}),
    resource_advice:
      `NOTHING RAN. The scheduler refused before launch: a ${refusal.kind} allowance of ` +
      `${refusal.limit} ${unitLabel} minus a ${refusal.reserve} ${unitLabel} reserve cannot admit one ` +
      `${refusal.requiredPerTask} ${unitLabel} task. ` +
      `${
        testRun
          ? cleanExit
            ? "Zero files were measured; this task's exit 0 is a trailing command's status, not a suite verdict — a masked abort, not a red suite verdict and not a green run"
            : 'Zero files were measured, so this non-zero exit is an UNDETERMINED test run, not a red suite verdict'
          : 'This is an infrastructure resource-limit failure, not a workload failure'
      }. ` +
      `This task has already exited, so processes:limit cannot reach it. Recover by ${remedy}.`,
  };
}

/**
 * Recover a terminal bash task when the durable detail bag did not carry its
 * process-local bash id. The ledger state is still authoritative for status;
 * the log path is the only remaining bounded output source. Live rows and
 * non-bash rows deliberately return null so their existing refusal paths stay
 * intact.
 */
function terminalBashTaskRecovery(
  row: TaskRow,
  filter: string | undefined,
): { payload: Record<string, unknown>; isError: boolean } | null {
  if (row.class !== 'bash-job') return null;
  const terminal = terminalStatusFromLedger(row);
  if (!terminal) return null;

  const stranded = row.logPath ? strandedJobLookupAtPath(row.logPath) : null;
  const inspected: StrandedJobLogInspection = stranded
    ? inspectStrandedJobLog(stranded, filter)
    : { terminal: null, output: '' };
  const output = !filter && inspected.output.length === 0 && stranded?.tail ? stranded.tail : inspected.output;
  return {
    payload: {
      ok: terminal.status === 'completed',
      task_id: row.taskId,
      status: terminal.status,
      exit_code: terminal.exitCode,
      running: false,
      ...(stranded ? { total_bytes: stranded.sizeBytes, total_bytes_written: stranded.sizeBytes } : {}),
      ...(row.logPath ? { log_path: row.logPath } : {}),
      recovered_from_ledger: true,
      ...(terminalResourceLimitFields(row, stranded?.content ?? stranded?.tail ?? '') ?? {}),
      ...(inspected.filterError ? { filter_error: inspected.filterError } : {}),
      output_tail: output,
      output,
    },
    isError: terminal.status !== 'completed',
  };
}

export interface StrandedJobLogInspection {
  terminal: { status: RecoveredJobStatus; exitCode: number | null } | null;
  /** A ledger-confirmed unobserved terminal marker appended by recovery. */
  died?: { status: 'failed'; state: string; exitCode: number | null };
  output: string;
  filterError?: string;
}

// The marker is written only after the child reaches a terminal state and the
// spill stream is flushed. It is therefore the durable completion evidence for
// a job whose in-memory BashJob entry was lost, even when the task ledger has not
// observed the close yet. A confined service runner can write a raw verdict first
// so reader loss never strands the log; when the operator survives, it appends a
// later normalized verdict after diagnostics. The LAST matching marker is
// authoritative. Anchor at the start of a line so ordinary command output
// containing the marker prefix cannot become a false terminal verdict.
const JOB_LOG_END_MARKER_RE = new RegExp(
  '^' +
    JOB_LOG_END_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    ': status=(completed|failed|killed|timed_out) exit=(null|-?\\d+) at [^\\n]*(?:\\n|$)',
  'gm',
);

/** Parse the durable terminal marker from a stranded job log tail. */
export function parseJobLogEndMarker(log: string): { status: RecoveredJobStatus; exitCode: number | null } | null {
  JOB_LOG_END_MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  let latest: RegExpExecArray | null = null;
  while ((match = JOB_LOG_END_MARKER_RE.exec(log)) !== null) latest = match;
  JOB_LOG_END_MARKER_RE.lastIndex = 0;
  if (!latest) return null;
  return {
    status: latest[1] as RecoveredJobStatus,
    exitCode: latest[2] === 'null' ? null : Number(latest[2]),
  };
}

const JOB_LOG_DIED_MARKER_RE = new RegExp(
  '^' +
    JOB_LOG_DIED_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    ': state=([^\\s]+) exit=(null|-?\\d+) at [^\\n]*(?:\\n|$)',
  'm',
);

/** Parse the recovery marker that records a ledger-confirmed unobserved death. */
export function parseJobLogDiedMarker(
  log: string,
): { status: 'failed'; state: string; exitCode: number | null } | null {
  const match = JOB_LOG_DIED_MARKER_RE.exec(log);
  if (!match) return null;
  return {
    status: 'failed',
    state: match[1]!,
    exitCode: match[2] === 'null' ? null : Number(match[2]),
  };
}

/**
 * Append the unobserved-death marker exactly once. The read-before-append makes
 * repeated `bash_output` recovery polls idempotent, while checking both marker
 * kinds preserves JOB END precedence if the child close handler wins a race with
 * the recovery read. A missing/unwritable log is deliberately best-effort: the
 * ledger verdict returned by the caller remains authoritative even when the
 * marker cannot be persisted.
 */
export function appendJobDiedMarker(
  logPath: string,
  state: string,
  exitCode: number | null,
  exitReason: string | null,
  endedAtMs = Date.now(),
): boolean {
  try {
    const existing = readFileSync(logPath, 'utf8');
    if (parseJobLogEndMarker(existing) || parseJobLogDiedMarker(existing)) return false;
    appendFileSync(logPath, formatJobLogDiedMarker(state, exitCode, exitReason, endedAtMs), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Ledger states where the process ended but no child close/exit was observed. */
export function isLedgerConfirmedUnobservedDeath(state: string): boolean {
  return state === 'stranded' || state === 'ended_unobserved';
}

/**
 * Inspect a stranded log once for both durable completion and filtered output.
 * Keeping these decisions together prevents the tracking-loss branches from
 * drifting away from the normal BashOutput filter contract.
 */
export function inspectStrandedJobLog(
  log: string | Pick<StrandedJobLog, 'tail' | 'content'>,
  filter: string | undefined,
): StrandedJobLogInspection {
  // A caller asking for a filter needs the whole bounded body so a match before
  // the retained tail is not silently reported as absent. Without a filter,
  // preserve the established tail-only recovery contract and memory bound.
  const body = typeof log === 'string' ? log : filter && log.content !== undefined ? log.content : log.tail;
  const filtered = filterOutputLines(body, filter);
  const terminal = parseJobLogEndMarker(body);
  const died = terminal ? null : parseJobLogDiedMarker(body);
  return {
    terminal,
    ...(died ? { died } : {}),
    output: filtered.output,
    ...(filtered.error ? { filterError: filtered.error } : {}),
  };
}

/**
 * EI-20051445912325691 — answer "is this job WORKING or WEDGED?" in the reply, instead of
 * leaving every caller to hand-roll it. "Is my job done?" is ~12% of all bash calls on this
 * box, and the hand-rolled answers are wrong in whichever direction is most expensive:
 * `ps -o %cpu` is a process-LIFETIME average; a tree walk that misses a descendant or a
 * double-fork returns a false 0 (measured: 0 cores reported for a tree burning 19.89); and
 * the cgroup recipe applied to a FOREGROUND call reads the OPERATOR's own cgroup instead —
 * measured 7.33 cores across 34 pids in the same window the job itself burned 0.91, a false
 * BUSY that can never read zero, so a dead job reads as alive and the caller keeps waiting.
 *
 * Computed here, that ambiguity is unrepresentable: it is always a tracked background job's
 * own scope, resolved from its pid, or it is null with a reason.
 *
 * ZERO ADDED LATENCY ON A POLL. The previous sample is kept on the job, so from the second
 * read onward this reports cores burned SINCE YOUR LAST READ — more useful than an instant
 * anyway, being the average over exactly the window you were waiting. The FIRST read has no
 * baseline and says so, rather than pausing the reply to manufacture one.
 *
 * Fails soft in every direction: a reason string, never a number, and never a throw — this is
 * diagnostic garnish on a tool whose actual job is returning output.
 */
export function sampleJobCpu(
  job: BashJob,
  deps: { readText?: (p: string) => string | null; now?: () => number } = {},
): { cpu_cores?: number; cpu_basis?: string; cpu_unavailable?: string } {
  const readText =
    deps.readText ??
    ((p: string) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    });
  try {
    if (job.status !== 'running') return { cpu_unavailable: 'job-not-running' };
    const next = readCgroupCpuSample(job.child?.pid ?? null, { readText, now: deps.now });
    if (!next) return { cpu_unavailable: 'cgroup-unreadable' };
    const prev = job.lastCpuSample ?? null;
    job.lastCpuSample = next;
    const cores = coresBetween(prev, next);
    if (cores == null) {
      return {
        cpu_unavailable: 'awaiting-second-sample',
        cpu_basis: `baseline sample taken; a RATE needs two readings at least ${MIN_SAMPLE_GAP_MS}ms apart — read again and this becomes a number`,
      };
    }
    const windowSec = Math.max(1, Math.round((next.atMs - prev!.atMs) / 1000));
    return {
      cpu_cores: Math.round(cores * 100) / 100,
      cpu_basis:
        `cores burned by this job's OWN cgroup over the ${windowSec}s since your last bash_output read ` +
        `(1.0 = one core saturated). CPU use is NOT payload progress: wrapper/queue work can burn multiple cores ` +
        `before the payload starts, so neither a nonzero value nor growing wrapper output distinguishes working from ` +
        `pc-heavy:waiting-for-slot. ~0 while status=running also does NOT mean finished. Confirm progress from a ` +
        `payload-emitted phase/test marker, not this number.`,
    };
  } catch {
    return { cpu_unavailable: 'cgroup-unreadable' };
  }
}

/**
 * EI-22068327735595657: agents naturally reach for `tail` on capability:bash_output
 * (mirroring capability:read's `tail:N` — and this tool's OWN response fields are
 * literally named `output_tail` in several recovery branches), and it kept failing
 * with a raw Zod "unrecognized key" error (2 independent reporters, promoted by the
 * improvement watchdog). Rather than merely improve the error message, make the
 * natural call WORK: `tail` trims whichever of `output`/`output_tail` the response
 * actually carries to its last N lines, applied UNIFORMLY as a post-processing step
 * over the handler's JSON payload — so every branch (running job, filtered,
 * stranded/recovered, terminal-ledger-recovered, …) gets tail support for free
 * without re-deriving it in each one. The read cursor still advances past the FULL
 * chunk regardless (exactly like `filter`) — `tail` only narrows what is RETURNED.
 */
export function truncateToTailLines(text: string, tail: number | undefined): string {
  if (tail === undefined || tail <= 0 || !text) return text;
  const lines = text.split('\n');
  return lines.length <= tail ? text : lines.slice(-tail).join('\n');
}

/** Fields carrying returned output text across every capability:bash_output response
 *  shape — the live happy path uses `output`; several stranded/recovery branches ALSO
 *  (or only) carry `output_tail`. Trimming both, when present, keeps `tail` correct
 *  regardless of which branch produced the payload. */
const OUTPUT_TEXT_FIELDS = ['output', 'output_tail'] as const;

export function applyOutputTail<T extends Record<string, unknown>>(payload: T, tail: number | undefined): T {
  if (tail === undefined || tail <= 0) return payload;
  let changed = false;
  const next: Record<string, unknown> = { ...payload };
  for (const field of OUTPUT_TEXT_FIELDS) {
    const value = next[field];
    if (typeof value === 'string') {
      const truncated = truncateToTailLines(value, tail);
      if (truncated !== value) {
        next[field] = truncated;
        changed = true;
      }
    }
  }
  return (changed ? next : payload) as T;
}

/** Apply `tail` to a tool result's JSON text content, uniformly across every
 *  capability:bash_output return branch. A non-JSON or unexpected content shape is
 *  left untouched — this only ever narrows an already-produced `output`/`output_tail`
 *  string field, never changes control flow or error status. */
export function applyOutputTailToResult<
  R extends { content: Array<{ type: string; text?: string }>; isError?: boolean },
>(result: R, tail: number | undefined): R {
  if (tail === undefined || tail <= 0) return result;
  return {
    ...result,
    content: result.content.map((item) => {
      if (item.type !== 'text' || typeof item.text !== 'string') return item;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(item.text) as Record<string, unknown>;
      } catch {
        return item;
      }
      return { ...item, text: JSON.stringify(applyOutputTail(parsed, tail)) };
    }),
  };
}

/**
 * Registered response contract. This tool authors `guidance.returns`, and
 * `guidance-output-schema-live-guard.test.ts` requires any tool that does so to
 * register the shape rather than let prose become a second, unverifiable type
 * system — `tools:find` renders this in preference to the prose.
 *
 * Deliberately a CORE schema with `.catchall()`, not an exhaustive union: the
 * response is branch-shaped (live / terminal / stranded / recovered /
 * resource-limited) and different branches legitimately carry different extra
 * keys. Declaring the stable, cross-branch fields honestly — and admitting the
 * rest — beats inventing a closed contract this handler would not keep.
 */
const bashOutputResultSchema = z
  .object({
    ok: z.boolean(),
    bash_id: z.string().optional(),
    task_id: z.string().optional(),
    status: z.string().optional(),
    running: z.boolean().optional(),
    exit_code: z.number().int().nullable().optional(),
    output: z.string().optional(),
    output_tail: z.string().optional(),
    // The three fields the `returns` prose above is about.
    tracking_lost: z.boolean().optional(),
    output_recoverable: z.boolean().optional(),
    liveness_proof: z.string().optional(),
    // Omitted rather than handed back unverified when not recoverable.
    log_path: z.string().optional(),
    total_bytes: z.number().int().nonnegative().optional(),
    // Set together on the cgroup TasksMax branch named in the description.
    failure_class: z.string().optional(),
    test_verdict: z.string().optional(),
    error: z.string().optional(),
    advice: z.string().optional(),
  })
  .catchall(z.unknown());

export default defineTool({
  name: 'capability:bash_output',
  description:
    'Read incremental output and status for a capability:bash background job by process-local bash_id or carry-safe task_id. If a terminal task reached cgroup TasksMax, returns failure_class=infrastructure-resource-limit and test_verdict=undetermined; never read that shell exit as a test red.',
  guidance: {
    when: 'Poll a capability:bash background job. After carry use task_id: it reattaches through the durable ledger and never starts a replacement. Repeated calls drain new output; terminal status includes the tail and exit code.',
    notWhen:
      'For a foreground command — its output is in the capability:bash result directly. A miss WITH a log tail means the job\'s in-memory tracking is gone while its log survived; three DISTINCT reason codes say what is known, never conflate them. `"tracking_lost_process_alive"` = CONFIRMED running (task-ledger pid re-probe) — do NOT re-run, keep polling. `"job_process_gone"` = CONFIRMED ended (the ledger observed a terminal state) — safe to re-run. `"job_liveness_unknown"` = only a whole-operator restart was ruled out; liveness is UNKNOWN and the job is most often alive but QUEUED behind pc-heavy\'s slot clamp — check `ps` for your command before re-running, or you add load to the very queue that is delaying it.',
    chaining:
      'capability:bash { run_in_background:true } → capability:bash_output { task_id } after carry (or { bash_id } in the launching context) → processes:kill { taskId } to stop early.',
    returns:
      'When `tracking_lost` is true, check `output_recoverable`: false means the spill log cannot be found on disk anywhere — the job may still be CONFIRMED alive (see `liveness_proof`), but polling will never return more output and `log_path` is omitted rather than handed back unverified; wait for a terminal status or verify another way instead of expecting a tail.',
    // EI-21543657511391052: `processes:kill`, not capability:bash_kill — the latter is
    // absent from trimmed surfaces (su) and refuses some principals, so it was a dead-end
    // pointer for exactly the callers most likely to need it.
    seeAlso: ['capability:bash (start the command)', 'processes:kill { taskId } (stop the backgrounded run)'],
  },
  result: bashOutputResultSchema,
  capability: 'capability:bash',
  requirePrincipal: false,
  // EI-20190459016345227: output polling does not read ctx.tx and can await
  // the durable task-ledger fallback while a live seed cut is running. Do not
  // retain the ambient workspace transaction across that control-path I/O.
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  args: z
    .object({
      bash_id: z
        .string()
        .min(1)
        .optional()
        .describe(
          'The process-local id returned by capability:bash (run_in_background). Use only in the launching context.',
        ),
      task_id: z
        .string()
        .min(1)
        .optional()
        .describe(
          'The durable task id returned by capability:bash. Preferred after compaction/carry; attachment never restarts the job.',
        ),
      filter: z
        .string()
        .optional()
        .describe(
          'Regex; only output LINES matching it are returned (the read cursor still advances past ALL output, matching or not). Mirrors the native BashOutput filter. A leading bare PCRE-style inline-flag prefix — (?i), (?im), (?is) — is honored as JS case-insensitive/multiline/dotAll flags rather than rejected as invalid.',
        ),
      peek: z.boolean().optional().describe('Read without advancing the read cursor (default false).'),
      tail: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Return only the LAST N lines of the output text in THIS response (whichever of `output`/`output_tail` it carries — every response branch, including stranded/recovered ones, is covered). The read cursor still advances past the ENTIRE chunk regardless, exactly like `filter` — this only narrows what is RETURNED. Composes with `filter`: filter is applied first, then tail keeps the last N of what remains.',
        ),
    })
    .superRefine((args, refinementCtx) => {
      // EI-21240465530065342: capability:bash hands the caller BOTH ids at
      // launch, so passing both back is the NATURAL recovery call — and it is
      // exactly the call an agent makes after a carry, when it still holds the
      // launch result. Rejecting that shape put a schema error on the one path
      // that recovers a job whose worker-local JOBS entry is gone. Only the
      // no-handle case is a real caller error here; a both-ids call that
      // disagrees is caught in the handler, where the ledger can adjudicate.
      if (!args.bash_id && !args.task_id) {
        refinementCtx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Pass at least one of bash_id or task_id.',
          path: ['bash_id'],
        });
      }
    }),
  async handler(args, ctx) {
    // EI-22068327735595657: the ENTIRE existing body below is unchanged and now
    // runs inside this IIFE; `tail` is applied uniformly to whatever it returns,
    // from whichever of the many branches below produced it — see
    // applyOutputTailToResult's doc comment for why this is a wrap rather than a
    // per-branch change.
    const result = await (async () => {
    // `bash_id` indexes the process-local JOBS map. `task_id` is the durable
    // carry-safe handle: resolve it once through the existing task ledger, then
    // reuse the exact same live-map/log/identity/terminal-marker path below.
    // This module deliberately does not import `startBackground`; attachment can
    // never turn a lookup miss into a duplicate launch.
    const workspaceId =
      ctx.workspaceId && ctx.workspaceId !== '*'
        ? ctx.workspaceId
        : ctx.principal?.workspaceId && ctx.principal.workspaceId !== '*'
          ? ctx.principal.workspaceId
          : undefined;
    let attachedLedgerRow: TaskRow | null = null;
    let bashId = args.bash_id;
    if (args.task_id) {
      if (!workspaceId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                reason: 'workspace_scope_required',
                task_id: args.task_id,
                advice: 'A concrete workspace scope is required to attach by durable task_id.',
              }),
            },
          ],
          isError: true,
        };
      }
      try {
        attachedLedgerRow = await getTask(args.task_id);
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                reason: 'task_ledger_unavailable',
                task_id: args.task_id,
                advice: `Could not read the durable task ledger; the job was NOT restarted. Retry attachment (${err instanceof Error ? err.message : String(err)}).`,
              }),
            },
          ],
          isError: true,
        };
      }
      // Treat a cross-workspace id exactly like a miss: callers cannot attach to
      // (or learn metadata about) another workspace's managed process.
      if (!attachedLedgerRow || attachedLedgerRow.workspaceId !== workspaceId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                reason: 'unknown_task_id',
                task_id: args.task_id,
                advice:
                  'No managed background shell job with this task_id exists in the current workspace. The job was NOT restarted.',
              }),
            },
          ],
          isError: true,
        };
      }
      const durableBashId = attachedLedgerRow.detail?.bashJobId;
      if (attachedLedgerRow.class !== 'bash-job' || typeof durableBashId !== 'string' || durableBashId.length === 0) {
        const terminalRecovery = terminalBashTaskRecovery(attachedLedgerRow, args.filter);
        if (terminalRecovery) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(terminalRecovery.payload) }],
            ...(terminalRecovery.isError ? { isError: true } : {}),
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                reason: 'task_not_attachable',
                task_id: args.task_id,
                advice:
                  'This task is not a capability:bash background job with a durable bash handle. It was NOT restarted.',
              }),
            },
          ],
          isError: true,
        };
      }
      // Both handles supplied: task_id is the durable, authoritative one and
      // wins. A bash_id that names a DIFFERENT job is a real caller error, not
      // a shape to silently resolve — reading the task_id job under a bash_id
      // the caller believes in is how a poll ends up reporting the wrong job's
      // output. Refuse, read nothing, and say which handle to send alone.
      if (args.bash_id && args.bash_id !== durableBashId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                reason: 'handle_mismatch',
                task_id: args.task_id,
                bash_id: args.bash_id,
                durable_bash_id: durableBashId,
                advice:
                  'bash_id and task_id identify DIFFERENT jobs. Nothing was read and no job was restarted. Send task_id alone (the durable handle, correct after a carry or across operator workers), or bash_id alone to read the process-local job in its launching context.',
              }),
            },
          ],
          isError: true,
        };
      }
      bashId = durableBashId;
    }

    // The schema enforces at least one handle. Keep the runtime guard because
    // direct handler tests/callers can bypass schema parsing.
    if (!bashId) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason: 'missing_job_handle' }) }],
        isError: true,
      };
    }

    const job = getJob(bashId);
    if (!job) {
      // The JOBS map is worker-local in the clustered operator. Pin the durable
      // lookup to this request's workspace before deciding that the id is gone;
      // otherwise a clean exit on a sibling worker is misread as an unknown job.
      const ledgerRow =
        attachedLedgerRow ?? (await getTaskByBashJobId(bashId, workspaceId ? { workspaceId } : {}).catch(() => null));
      const jobIdentity = {
        bash_id: bashId,
        ...(ledgerRow?.taskId ? { task_id: ledgerRow.taskId } : {}),
      };
      const ledgerVerdict = diagnoseFromLedger(ledgerRow);
      // The ledger path is authoritative across workers. Only fall back to the
      // local deterministic path when the durable path is absent/unreadable;
      // otherwise a stale same-ID file on this worker can mask a growing log.
      const stranded =
        (ledgerRow?.logPath ? strandedJobLookupAtPath(ledgerRow.logPath) : null) ??
        strandedJobLookup(bashId, ctx.stateDir);
      const recoveredResourceLimitFields = terminalResourceLimitFields(
        ledgerRow,
        stranded?.content ?? stranded?.tail ?? '',
      );
      if (stranded || ledgerRow) {
        const strandedLog: StrandedJobLogInspection = stranded
          ? inspectStrandedJobLog(stranded, args.filter)
          : { terminal: null, output: '' };
        // A log can grow between stat/read or be read through a stale worker's
        // cursor. When no filter was requested, prefer the independently
        // captured tail whenever the first inspection returned empty despite
        // bytes being present. A filter with no matches is legitimately empty.
        const recoveredStrandedOutput =
          !args.filter && strandedLog.output.length === 0 && stranded?.tail ? stranded.tail : strandedLog.output;
        const strandedOutput = {
          output_tail: recoveredStrandedOutput,
          ...(strandedLog.filterError ? { filter_error: strandedLog.filterError } : {}),
        };
        const recoveredLogPath = stranded?.logPath ?? ledgerRow?.logPath ?? undefined;

        // EI-21301075566136325: a command that redirects its OWN stdout writes
        // nothing to the capability log, so `total_bytes_written: 0` /
        // `output_tail: ""` is the EXPECTED reading for it — presenting that as
        // "how far it got" turns "not measured" into what reads as "the job got
        // nowhere" (the documented false-absence class), inviting a caller to
        // relaunch a live job. Detect the redirect from the ledger argv (the
        // raw command is always its last element — see startBackground), say so
        // wherever advice points at output_tail, and when the target is a
        // literal path, stat it and report the ACTUAL progress signal.
        const ledgerRawCommand =
          ledgerRow?.argv && ledgerRow.argv.length > 0 ? ledgerRow.argv[ledgerRow.argv.length - 1] : undefined;
        const selfRedirect = ledgerRawCommand ? detectSelfOutputRedirect(ledgerRawCommand) : null;
        const selfRedirectProbe =
          selfRedirect?.literalPath && selfRedirect.target !== '/dev/null'
            ? (() => {
                try {
                  const st = statSync(selfRedirect.target);
                  return { sizeBytes: st.size, mtimeMs: st.mtimeMs };
                } catch {
                  return null;
                }
              })()
            : null;
        const selfRedirectNote = selfRedirect ? ` ${formatSelfRedirectAdvice(selfRedirect, selfRedirectProbe)}` : '';
        const selfRedirectFields = selfRedirect
          ? {
              output_redirected_by_command: selfRedirect.target,
              ...(selfRedirectProbe
                ? {
                    redirect_target_bytes: selfRedirectProbe.sizeBytes,
                    redirect_target_mtime: new Date(selfRedirectProbe.mtimeMs).toISOString(),
                  }
                : {}),
            }
          : {};

        // EI-20011476155595470: a child killed outside the normal close path
        // can leave a durable terminal ledger row but no JOB END line in the
        // spill log. Make that state self-describing for raw log readers. Do
        // this only for the ledger's explicitly unobserved-death states; a
        // normal observed exit/kill/timeout keeps JOB END semantics, and the
        // JOB END marker still wins if it is already present in the log.
        const diedMarkerWritten =
          ledgerVerdict.kind === 'confirmed_dead' &&
          isLedgerConfirmedUnobservedDeath(ledgerVerdict.state) &&
          recoveredLogPath
            ? appendJobDiedMarker(
                recoveredLogPath,
                ledgerVerdict.state,
                ledgerVerdict.exitCode,
                ledgerVerdict.exitReason,
                ledgerRow?.endedAt && Number.isFinite(Date.parse(ledgerRow.endedAt))
                  ? Date.parse(ledgerRow.endedAt)
                  : Date.now(),
              )
            : false;

        // EI-20230176152308336: the durable JOB END marker is stronger than a
        // stale/non-terminal task-ledger row. The marker is appended from the
        // child close handler, so once it is present the job has a recoverable
        // terminal verdict even though the in-memory BashJob and/or its ledger
        // update may have been lost. An OBSERVED terminal ledger exit is stronger
        // still and wins a conflict with a later marker. `stranded` and
        // `ended_unobserved` prove only that the process is gone: they carry no
        // observed shell exit, so a durable JOB END must win over their generic
        // job_process_gone/re-run advice (EI-23696035248162547).
        if (
          strandedLog.terminal &&
          (ledgerVerdict.kind !== 'confirmed_dead' || isLedgerConfirmedUnobservedDeath(ledgerVerdict.state))
        ) {
          const markerOk = strandedLog.terminal.status === 'completed';
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: markerOk,
                  ...jobIdentity,
                  status: strandedLog.terminal.status,
                  exit_code: strandedLog.terminal.exitCode,
                  running: false,
                  ...(stranded ? { total_bytes: stranded.sizeBytes } : {}),
                  ...(recoveredLogPath ? { log_path: recoveredLogPath } : {}),
                  recovered_from_log_marker: true,
                  ...(recoveredResourceLimitFields ?? {}),
                  ...selfRedirectFields,
                  ...strandedOutput,
                  output: recoveredStrandedOutput,
                }),
              },
            ],
            ...(markerOk ? {} : { isError: true }),
          };
        }

        // A previous recovery read may already have appended JOB DIED. It is a
        // durable failed terminal verdict just like JOB END is a durable normal
        // terminal verdict, but never a success signal.
        if (strandedLog.died) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  ...jobIdentity,
                  status: strandedLog.died.status,
                  exit_code: strandedLog.died.exitCode,
                  running: false,
                  ...(stranded ? { total_bytes: stranded.sizeBytes } : {}),
                  ...(recoveredLogPath ? { log_path: recoveredLogPath } : {}),
                  recovered_from_died_marker: true,
                  ...(recoveredResourceLimitFields ?? {}),
                  ...selfRedirectFields,
                  ...strandedOutput,
                  output: strandedLog.output,
                }),
              },
            ],
            isError: true,
          };
        }

        const scopeActive =
          ledgerVerdict.kind === 'ledger_inconclusive' && ledgerRow ? await taskScopeIsActive(ledgerRow) : false;

        if (ledgerVerdict.kind === 'confirmed_alive' || scopeActive) {
          // EI-20218784292451325: a durable liveness proof is a successful
          // recovery, not a tool failure. The worker-local JOBS map may be
          // missing after a cross-worker read, but the task is still healthy;
          // surfacing `isError:true` made callers and the watchdog treat this
          // expected degraded read as a failed command. The recovered log is a
          // tail (there is no worker-local cursor), so say that explicitly while
          // preserving the normal running/status shape.
          // EI-19915289191989412: the "log tail will keep growing" promise below is
          // FALSE for a command whose last pipeline stage is a buffering filter
          // (`| tail -45`, `| head`, …) — that stage flushes nothing until the
          // whole pipeline exits, so `total_bytes_written` can legitimately sit at
          // 0 for the job's entire (confirmed-alive) run. `argv` is
          // `['bash', '-o', 'pipefail', '-c', <the raw command>]` (see
          // startBackground) — the raw command is always its LAST element.
          const processAlive = ledgerVerdict.kind === 'confirmed_alive' ? ledgerVerdict : null;
          const ledgerArgv = ledgerRow?.argv;
          const rawCommand = ledgerArgv && ledgerArgv.length > 0 ? ledgerArgv[ledgerArgv.length - 1] : undefined;
          const bufferingStage = rawCommand ? detectBufferingLastStage(rawCommand) : null;
          // EI-22185525501280167: a durable liveness proof (ledger pid re-probe, or
          // systemd ActiveState) says nothing about whether this job's OUTPUT
          // survived — `stranded` above already STAT'd every candidate log path, so
          // `stranded === null` means none of them currently exist. Live repro: a
          // reply confidently promised "the log tail will keep growing" and offered
          // `log_path` to "read directly", while that path 404'd and never would —
          // an unrecoverable-output job read identically to a merely-quiet one, and
          // the caller waited ~30 minutes on a tail that could never arrive. Never
          // advertise growth, or hand back a path, we have not verified exists.
          const logVerifiedOnDisk = stranded !== null;
          // A self-output redirect trumps the buffering-stage note: whatever the
          // pipeline stages do, the bytes land in the command's own file, so the
          // capability tail below will never grow (EI-21301075566136325).
          const growthAdvice = selfRedirect
            ? formatSelfRedirectAdvice(selfRedirect, selfRedirectProbe)
            : bufferingStage
              ? formatBufferingPipelineAdvice(bufferingStage, 'tracking-lost')
              : 'Keep polling capability:bash_output (the log tail below will keep growing as it runs)';
          const readPathAdvice = bufferingStage || selfRedirect ? '' : ', or read log_path directly';
          const outputAdvice = logVerifiedOnDisk
            ? 'It may be queued behind pc-heavy and still produce no new output. ' +
              'Do NOT re-run capability:bash — that would start a SECOND concurrent job and double the load. ' +
              `${growthAdvice}${readPathAdvice}.`
            : 'Its buffered OUTPUT IS UNRECOVERABLE: the spill log this job was writing to cannot be found on ' +
              'disk (checked every known location), so polling this job will never return new output — do not ' +
              'keep waiting on a tail that will never grow, and there is no log_path to read directly. Do NOT ' +
              're-run capability:bash — that would start a SECOND concurrent job and double the load. Wait for ' +
              'it to reach a terminal state instead (its exit code will be reported normally once observed), or ' +
              'verify its effect another route (e.g. testing:run for a test-run job).';
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: true,
                  ...jobIdentity,
                  status: 'running',
                  exit_code: null,
                  running: true,
                  ...((processAlive?.pid ?? ledgerRow?.pid) ? { pid: processAlive?.pid ?? ledgerRow?.pid } : {}),
                  scope_unit: processAlive?.scopeUnit ?? ledgerRow?.scopeUnit ?? null,
                  recovered_from_ledger: true,
                  ...(scopeActive
                    ? { recovered_from_scope: true, liveness_proof: 'systemd_active_state' }
                    : { liveness_proof: 'process_identity_and_cgroup' }),
                  tracking_lost: true,
                  output_recoverable: logVerifiedOnDisk,
                  output_is_tail: true,
                  ...(logVerifiedOnDisk && recoveredLogPath ? { log_path: recoveredLogPath } : {}),
                  ...(stranded ? { total_bytes: stranded.sizeBytes } : {}),
                  ...(stranded ? { total_bytes_written: stranded.sizeBytes } : {}),
                  ...(diedMarkerWritten ? { job_died_marker_written: true } : {}),
                  ...selfRedirectFields,
                  ...strandedOutput,
                  output: recoveredStrandedOutput,
                  advice: scopeActive
                    ? `This job's in-memory tracking is gone, but its durable systemd service ${ledgerRow?.scopeUnit} is ` +
                      'CONFIRMED ACTIVE — verified just now with systemd ActiveState, independent of the worker-local ' +
                      `registry and PID/cgroup probe. ${outputAdvice} To stop ${confirmedAliveStopAdvice()}`
                    : `This job's in-memory tracking is gone, but its real OS process (pid ${processAlive?.pid}` +
                      `${processAlive?.scopeUnit ? `, systemd scope ${processAlive.scopeUnit}` : ''}) is CONFIRMED ` +
                      'STILL RUNNING — verified just now via a process-identity re-probe against the durable task ' +
                      `ledger (immune to PID reuse), not a guess. ${outputAdvice} To stop ` +
                      confirmedAliveStopAdvice(),
                }),
              },
            ],
          };
        }

        if (ledgerVerdict.kind === 'confirmed_dead') {
          const terminal = terminalStatusFromLedger(ledgerRow);
          // A durable `exited`/0 row is authoritative success evidence even when
          // this worker missed both the live handle and the end-marker read. The
          // old branch treated every terminal row as job_process_gone, causing
          // successful Vitest/typecheck jobs to be reported as errors (EI-20232536598731015).
          if (terminal?.status === 'completed') {
            const exitMismatch = capturedExitMismatch({
              status: terminal.status,
              exitCode: terminal.exitCode,
              log: recoveredStrandedOutput,
            });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    ok: true,
                    ...jobIdentity,
                    status: terminal.status,
                    exit_code: terminal.exitCode,
                    running: false,
                    ...(stranded ? { total_bytes: stranded.sizeBytes } : {}),
                    ...(recoveredLogPath ? { log_path: recoveredLogPath } : {}),
                    recovered_from_ledger: true,
                    ...selfRedirectFields,
                    ...(exitMismatch
                      ? { exit_code_verdict: exitMismatch.headline, advice: exitMismatch.advice }
                      : {}),
                    ...strandedOutput,
                    output: recoveredStrandedOutput,
                  }),
                },
              ],
              ...(exitMismatch ? { isError: true } : {}),
            };
          }
          const exitDetail =
            (ledgerVerdict.exitCode !== null ? ` exit code ${ledgerVerdict.exitCode}` : '') +
            (ledgerVerdict.exitReason ? `: ${ledgerVerdict.exitReason}` : '');
          // EI-19315479997523199 — a `stranded` verdict (the ledger observed the
          // scope/pid vanish from the kernel with no exit code ever seen) used to
          // report the SAME generic "CONFIRMED it actually ended" advice as a clean
          // exit, leaving a job that silently evaporated mid-wait just as
          // unattributed as it was before the ledger existed. `confined` is the
          // one signal that tells the two `stranded` shapes apart:
          //   - UNCONFINED (task-manager was off at spawn time, or its probe
          //     failed): this job lived as a direct child of the operator
          //     process, so the far more likely explanation is the routine,
          //     documented one — a peer restarted :3070/:3170 mid-job (repo-
          //     conventions § two-port model) and took every unconfined
          //     in-flight background job down with it. Not a bug in the command.
          //   - CONFINED: the payload is outside the operator's cgroup, but the
          //     systemd-run --scope monitor is still its child. Killing that
          //     monitor during an operator restart can end the sibling scope too;
          //     confinement is not restart durability (EI-20219872509843731).
          const strandedAdvice =
            ledgerVerdict.state !== 'stranded'
              ? null
              : ledgerVerdict.confined
                ? strandedJobAdvice(true)
                : strandedJobAdvice(false);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  ...jobIdentity,
                  reason: 'job_process_gone',
                  ...(recoveredResourceLimitFields ?? {}),
                  advice:
                    "This job's in-memory tracking is gone, and the durable task ledger CONFIRMS it actually ended " +
                    `(state=${ledgerVerdict.state}${exitDetail}) — not a guess.${strandedAdvice ?? ''} Re-run ` +
                    `capability:bash if you still need the result; check output_tail below for how far it got.${selfRedirectNote}`,
                  ...(recoveredLogPath ? { log_path: recoveredLogPath } : {}),
                  ...(stranded ? { total_bytes_written: stranded.sizeBytes } : {}),
                  ...selfRedirectFields,
                  ...strandedOutput,
                }),
              },
            ],
            isError: true,
          };
        }

        // Without a surviving log there is no safe uptime-based fallback. The
        // ledger above has already had the chance to prove alive/dead; preserve
        // the existing unknown-id response rather than dereferencing a missing
        // birth time or inventing a restart cause.
        if (!stranded) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  ...jobIdentity,
                  reason: 'unknown_bash_id',
                  advice:
                    'No surviving output log is available for this background job. Re-run with capability:bash if you still need the result.',
                }),
              },
            ],
            isError: true,
          };
        }

        // EI-18666279107998059: EI-16635 stopped ASSERTING the restart cause as fact
        // but still couldn't tell the two causes apart, so every stranded job read
        // "here are two possible causes, go check yourself" even when this very
        // process's own uptime already proves which one it was (see
        // diagnoseStrandedCause). Do that check now — but this is a FALLBACK, only
        // reached when the ledger (above) had no row or could not confirm either
        // way, so word the verdict as the best available inference, not a fact
        // about the JOB's liveness (that overclaim is EI-18759519171684432 itself —
        // a whole-operator restart being ruled out never proved this job's own
        // process was gone).
        const cause = diagnoseStrandedCause({ jobBirthtimeMs: stranded.birthtimeMs });
        const ledgerCaveat =
          ledgerVerdict.kind === 'no_ledger_row'
            ? ' (no task-ledger record was found for this job to confirm further)'
            : ' (the task ledger still shows it non-terminal but could not confirm liveness — the process may have exited without the ledger observing it yet)';
        const advice =
          cause === 'stranded_by_operator_restart'
            ? "This job STARTED (its log file exists on disk) but its in-memory tracking is gone, and this operator process's own uptime is SHORTER than the job's age — CONFIRMED: the operator process that ran it restarted or was killed mid-job. A routine, common event on a shared dev box: any agent restarting :3070/:3170 kills every OTHER agent's in-flight background jobs too (repo-conventions § two-port model). It is NOT a wrong bash_id and not a bug in your command. Re-run capability:bash if you still need the result; check output_tail below for how far it got before dying."
            : `This job STARTED (its log file exists on disk) but its in-memory tracking is gone, and this operator process has been running continuously since BEFORE the job started — so a WHOLE-OPERATOR restart is ruled out${ledgerCaveat}. That does NOT confirm the job's own process died: before re-running, check yourself (e.g. \`ps\` for your command) — re-running while the original may still be alive doubles the load. If you can confirm it is really gone, re-run capability:bash; check output_tail below for how far it got.`;
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                ...jobIdentity,
                reason: cause,
                advice: `${advice}${selfRedirectNote}`,
                log_path: recoveredLogPath,
                total_bytes_written: stranded.sizeBytes,
                ...selfRedirectFields,
                ...strandedOutput,
              }),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              bash_id: bashId,
              reason: 'unknown_bash_id',
              advice:
                'No such background job (it may have been pruned, or the id is wrong). Re-run with capability:bash.',
            }),
          },
        ],
        isError: true,
      };
    }
    // Cursor advances over the FULL chunk (matching native BashOutput); the filter
    // only narrows what's RETURNED, so non-matching lines aren't re-shown next read.
    const fullChunk = readJobOutput(job, args.peek ?? false);
    const { output, error: filterError } = filterOutputLines(fullChunk, args.filter);
    const cpu = sampleJobCpu(job);
    // EI-20057167830211785: a backgrounded `tsc` that DIED (OOM, signal, bad
    // operand) emits a V8 dump and zero `error TS` lines, so every natural probe
    // — a grep count, an eyeball of the tail, this tool's own `output` — reads
    // exactly like a clean compile. The foreground paths already refuse that
    // reading; a backgrounded one had nowhere to say it, and backgrounding is
    // what agents are ROUTED to for any project too big for the ~50s foreground
    // cap. Deliberately computed from the SPILL LOG, not from `output`: `output`
    // is only the since-cursor chunk, so a caller that drained the log while the
    // job ran would be classified against an empty string.
    const jobLog = readJobLogForVerdict(job);
    const deadTypecheck = backgroundTypecheckVerdict({
      command: job.command,
      status: job.status,
      exitCode: job.exitCode,
      log: jobLog,
    });
    // Only checked when deadTypecheck didn't already claim the headline/advice
    // fields — the two verdicts share that slot and a dead typecheck is the
    // more specific, more actionable diagnosis when both would fire.
    const exitMismatch = deadTypecheck
      ? null
      : capturedExitMismatch({ status: job.status, exitCode: job.exitCode, log: jobLog });
    let terminalLedgerRow = attachedLedgerRow;
    if (job.status !== 'running' && (!terminalLedgerRow || !isTerminalState(terminalLedgerRow.state)) && job.taskId) {
      terminalLedgerRow = await getTask(job.taskId).catch(() => terminalLedgerRow);
    }
    const resourceLimitFields = terminalResourceLimitFields(terminalLedgerRow, jobLog);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            bash_id: job.id,
            ...(job.taskId ? { task_id: job.taskId } : {}),
            status: job.status,
            exit_code: job.exitCode,
            running: job.status === 'running',
            total_bytes: job.totalBytes,
            log_path: job.logPath,
            ...cpu,
            ...(filterError ? { filter_error: filterError } : {}),
            ...(resourceLimitFields ?? {}),
            ...(deadTypecheck
              ? {
                  typecheck_verdict: deadTypecheck.reason,
                  headline: deadTypecheck.headline,
                  advice: deadTypecheck.advice,
                }
              : exitMismatch
                ? {
                    exit_code_verdict: 'captured_exit_mismatch',
                    headline: exitMismatch.headline,
                    advice: exitMismatch.advice,
                  }
                : {}),
            output,
          }),
        },
      ],
      ...(deadTypecheck || exitMismatch ? { isError: true } : {}),
    };
    })();
    return applyOutputTailToResult(result, args.tail);
  },
});
