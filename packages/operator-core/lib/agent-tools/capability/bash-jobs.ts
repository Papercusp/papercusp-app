/**
 * bash-core + background-job registry for the `capability:bash*` tools.
 *
 * Part of P-010 (`agent-capability-confinement-2026-06-13`): the capability
 * defineTool surface. The `bash` tool is a THIN wrapper over a real shell
 * (D-004 — no reimplementation) that replicates the native Bash tool's I/O
 * ergonomics: combined output streaming, truncation/overflow-to-file, and
 * async/background job semantics (a 5-min build cannot be one blocking HTTP
 * request).
 *
 * IN-MEMORY REGISTRY — deliberate exception to the PG-by-default storage policy.
 * A *running child process handle* is inherently in-memory and process-bound;
 * it cannot be serialized to PG. This is the same exception class the storage
 * policy carves out for long-lived byte streams / live PTY sessions. The
 * DURABLE artifact (full output) is spilled to a scratch file under
 * `<stateDir>/scratch/`; only the live handle + read cursor live in the Map.
 * The operator (Hono host) is one long-lived process, so a background job
 * registered on one MCP `tools/call` is readable by a later `capability:bash_output`
 * call against the same operator — exactly how the native Bash background tool
 * holds its shell in the CLI process.
 */

import { execFile, spawn as childSpawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, readdirSync, readFileSync, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { augmentedSpawnPath, resolveBin } from '../../plugin-spawn-impl';
import {
  assertCapabilitySandboxAvailable,
  buildCapabilitySandboxCommand,
  scrubExecEnv,
  type BuildSandboxOpts,
} from './exec-sandbox';
import { resolveAgentMcpBaseUrl } from '../../mcp-base-url';
import {
  composeStreamingRedactors,
  createStreamingPatternRedactor,
  SYSTEMD_RUNNER_OUTPUT_PATH_ENV,
  SYSTEMD_RUNNER_REDACTIONS_ENV,
} from '../../systemd-scope-env-runner.mjs';
import { redactSelfIdentifyingSecrets, SELF_IDENTIFYING_SECRET_PATTERN } from '../../sensitive-text';
import {
  absCgroupDir,
  CGROUP_ROOT,
  parseCgroupInt,
  parseCgroupProcs,
  parseCpuStatUsageUsec,
  parseProcCgroup,
  parseProcCmdline,
} from '../../task-manager/cgroup-read';
import {
  beginSyncEnrolment,
  completeSyncEnrolment,
  finishSyncEnrolment,
  syncEnrolmentScopePath,
} from '../../task-manager/enroll-sync';
import {
  isReadOnlyHeadPipeline,
  isReadOnlyPsPpidPipeline,
  isReadOnlyRgCountPipeline,
} from './bash-effect';
import { onTaskKillRequested } from '../../task-manager/kill-notify';
import { warmScopeProbe } from '../../task-manager/managed-spawn';
import type { CgroupCpuSample } from './cgroup-cpu';

// Warm the systemd-scope probe at module load so the FIRST background job can
// already be confined. Fire-and-forget by design: a job must never wait on, or be
// refused by, the task manager's own readiness (task-manager P-008).
warmScopeProbe();

/** Inline output cap (chars). Output beyond this spills to the scratch log and
 *  the inline result carries head+tail + the log path. Mirrors the native
 *  tool's overflow-to-file behavior. */
export const INLINE_OUTPUT_CAP = 30_000;
/** Maximum size of one line delivered through the foreground output stream. */
export const STREAM_LINE_OUTPUT_CAP = INLINE_OUTPUT_CAP;
/** Marker emitted in the stream when one output line exceeds the line cap. */
export const STREAM_LINE_TRUNCATION_MARKER = `[capability:bash] line truncated after ${STREAM_LINE_OUTPUT_CAP} characters`;
/** Hard ceiling on retained in-memory output per job (bytes). Beyond this the
 *  in-memory tail is trimmed (the full stream is still on disk). 5 MB. */
const MEM_BUFFER_CAP = 5 * 1024 * 1024;
/** Default + max command wall-clock (ms) for the legacy blocking runner used
 *  by capability:inspect. capability:bash ordinary calls use DEFAULT_TIMEOUT_MS
 *  as their independent execution deadline but yield the durable job at the
 *  shorter response window instead of holding the request open. */
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
/**
 * Default + max wall-clock (ms) for a BACKGROUND job — deliberately NOT the
 * foreground pair above (WI-6677).
 *
 * A background job exists precisely to OUTLIVE the call that started it, so
 * inheriting the foreground default made the tool kill the jobs it exists for.
 * The trap was exact: the repo CLAUDE.md tells every agent "for anything that
 * runs longer than ~1–2 min, start it with run_in_background:true", and the
 * inherited default was 2 minutes — so the documented remedy SIGKILLed precisely
 * the jobs it recommended, unless the caller happened to also pass `timeout`.
 * Nothing in the tool description said the timeout applied to background jobs
 * at all. Filed twice from opposite directions: a P-205 acceptance drill
 * (4.9GB deb extract, dead at exactly 120s) and an as-committed test run whose
 * 489MB temp tree leaked because the SIGKILL skipped the script's cleanup.
 *
 * The 10-minute foreground ceiling was the other half: this repo's own green
 * checkpoint suite runs ~55 min, so the ceiling made the tool structurally
 * unable to host the longest jobs anyone would want to background. These
 * bounds are still bounds — a background job is not immortal — but they are
 * sized to real work rather than to a blocking request.
 */
export const DEFAULT_BACKGROUND_TIMEOUT_MS = 4 * 60 * 60 * 1_000; // 4h
export const MAX_BACKGROUND_TIMEOUT_MS = 12 * 60 * 60 * 1_000; // 12h

/**
 * A background test runner is the highest-fanout arbitrary command this door
 * launches.  The 2026-08-22 incident reached 1,517 cgroup pids and 19.4 GiB
 * peak RSS from one unbudgeted `npx vitest run`, while dozens of peer tasks were
 * active.  Keep the ceiling local to that task's transient service: an OOM or
 * pid ceiling must fail the test run, never turn into host-wide reclaim/PSI.
 *
 * These are hard defaults, not host-global tuning knobs.  Callers that need the
 * deliberately larger green-checkpoint envelope already have the dedicated
 * checkpoint launcher and its capacity policy; arbitrary `capability:bash`
 * tests must not silently inherit an unbounded reserved-machine budget.
 */
export const BASH_TEST_MEMORY_MAX_BYTES = 16 * 1024 ** 3;
// Keep this above the measured legitimate subtree, not merely above its first
// sample. A 512-task scope rejected forks, and the first correction to 2,048
// failed the same way on 2026-08-25: the durable task ledger recorded
// pidsCurrent=2,048 exactly while systemd recorded only 10.9 GiB peak RSS under
// this door's 16 GiB cap. The affected runner then surfaced `fork: Resource
// temporarily unavailable`, bash lost the child's `wait_for` record, and no
// suite verdict existed. A follow-up operator-core lane then reached 4,096 and
// STILL produced a complete 2,840-file verdict: that count is legitimate workload,
// not spare capacity. An outer pc-heavy/affected scheduler sharing the same scope
// must retain enough tasks to poll, wait, and write its result marker while the
// child sits at that measured peak. 8,192 keeps a finite task-local blast radius
// under the existing 16 GiB memory cap; the affected scheduler's 4,096-task
// envelope keeps one high-fanout suite at a time inside it.
export const BASH_TEST_TASKS_MAX = 8_192;

const TEST_SEGMENT_PREFIX = String.raw`(?:^|(?:&&|\|\||;|\n)\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*`;
const DIRECT_TEST_RUNNER_RE = new RegExp(
  `${TEST_SEGMENT_PREFIX}(?:(?:npx|bunx|pnpm\\s+exec|yarn\\s+dlx)\\s+)?` +
    String.raw`(?:vitest|jest|mocha|ava|pytest|playwright\s+test|cargo\s+test|go\s+test)(?:\s|$)`,
  'i',
);
const PACKAGE_TEST_SCRIPT_RE = new RegExp(
  `${TEST_SEGMENT_PREFIX}(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?test(?::[A-Za-z0-9_.-]+)?(?:\\s|$)`,
  'i',
);

/** Conservative shell-segment classifier for the test budget above.
 *
 * It intentionally requires the runner at the start of a shell segment.  A
 * diagnostic such as `rg vitest` must not acquire a 16 GiB budget merely for
 * mentioning a runner name, while `cd pkg && npx vitest run` must.  This is
 * policy classification only; the command is still executed byte-for-byte.
 */
export function isBackgroundTestCommand(command: string): boolean {
  return DIRECT_TEST_RUNNER_RE.test(command) || PACKAGE_TEST_SCRIPT_RE.test(command);
}

/** Reserved child-env provenance for long-running physical drills. Only the
 * durable background seam may mint this marker; callers cannot override it. */
export const CAPABILITY_BASH_BACKGROUND_TASK_ID_ENV = 'PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID';
/** Reserved child-env marker for commands launched through capability:bash's
 * ordinary, response-waiting seam. The command is a durable job and survives a
 * response-window yield, but its separate execution deadline or caller abort
 * can still terminate the whole process tree. Mutation probes use this marker
 * to refuse in-tree mutations before touching a tracked file. The handler owns
 * the marker; callers cannot forge or clear it through command environment
 * input. */
export const CAPABILITY_BASH_FOREGROUND_ENV = 'PAPERCUSP_CAPABILITY_BASH_FOREGROUND';
export const CAPABILITY_BASH_FOREGROUND_TIMEOUT_ENV = 'PAPERCUSP_CAPABILITY_BASH_FOREGROUND_TIMEOUT_MS';
export const PC_HEAVY_DURABLE_CALLER_ENV = 'PC_HEAVY_DURABLE_CALLER';
/**
 * Grace between SIGTERM and SIGKILL when a job hits its OWN deadline (WI-6677).
 * The deadline path used to SIGKILL outright, which no `trap`/`finally` can
 * observe — so every timed-out job leaked whatever it was mid-way through
 * creating (temp trees, checkouts, a left-running sidecar). Matching `killJob`'s
 * terminate-then-escalate shape gives cleanup a chance to run and still
 * guarantees the process dies.
 */
export const TIMEOUT_SIGTERM_GRACE_MS = 10_000;
/** Keep at most this many finished jobs around for late `bash_output` reads. */
const MAX_RETAINED_JOBS = 64;

/**
 * EI-19315037905600226 — the stable marker `scripts/pc-heavy.sh` writes to STDERR
 * the INSTANT it stops waiting for a semaphore slot and is about to hand off to the
 * caller's real command. Before that point a `capability:bash`-run command wrapped
 * in pc-heavy can sit QUEUED for minutes (default up to `PC_HEAVY_TIMEOUT_SEC`,
 * 900s) on a loaded box — and this job's OWN wall-clock deadline (below) is not
 * exempt from that wait, so a job SIGKILLed while still queued produces a
 * "deadline reached" message that reads byte-identical to one killed mid-execution.
 * Two agents independently burned real time on that ambiguity the same day: one
 * relaunched into the same wall three times believing the platform was broken, the
 * other nearly recorded a run that never executed as a green verification.
 *
 * Grepping the job's own output for this marker at deadline time (best-effort —
 * absent for any job that never calls pc-heavy.sh at all, which is a legitimate,
 * uninformative case) lets the deadline message say which one it was whenever the
 * answer IS knowable, instead of leaving every deadline equally ambiguous.
 *
 * Keep this literal string in sync with the `echo` in scripts/pc-heavy.sh —
 * asserted by that script's own test suite (pc-heavy.test.ts) and by this file's
 * `queued-while-killed` deadline test.
 */
export const PC_HEAVY_SLOT_ACQUIRED_MARKER = '[pc-heavy] slot acquired — starting real work';

/**
 * A generic preflight failure marker. Managed witness commands are often inline
 * capability:bash payloads rather than checked-in repository scripts, so the
 * shared background seam cannot know their marker names ahead of time. Keep the
 * match deliberately narrow: an uppercase marker ending in `_PREFLIGHT_FAIL`,
 * such as `WI40905_PREFLIGHT_FAIL`, is an authenticated-enough signal to add
 * diagnostic context; ordinary prose containing "preflight failed" is not.
 */
const PREFLIGHT_FAILURE_MARKER_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_PREFLIGHT_FAIL\b/;
const PREFLIGHT_FAILURE_SCAN_TAIL = 128;

export const PREFLIGHT_ATTRIBUTION_SNAPSHOT_PREFIX = '[capability:bash] PREFLIGHT ATTRIBUTION SNAPSHOT';
const PREFLIGHT_SNAPSHOT_MAX_PROCESSES = 16;
const PREFLIGHT_SNAPSHOT_MAX_PROCESS_SCAN = 128;
const PREFLIGHT_SNAPSHOT_MAX_CMDLINE = 240;
const PREFLIGHT_SNAPSHOT_MAX_FIELD = 600;

/** Find the marker that should trigger a live attribution snapshot. */
export function detectPreflightFailureMarker(output: string): string | null {
  return PREFLIGHT_FAILURE_MARKER_RE.exec(output)?.[0] ?? null;
}

/**
 * Chunk-boundary-safe detector for generic preflight markers. The detector keeps
 * only a small suffix, so a pathological command cannot make the registry retain
 * its entire output a second time merely to recognize one marker.
 */
function createPreflightFailureMarkerDetector(): {
  push: (chunk: string) => string | null;
  seen: () => string | null;
} {
  let suffix = '';
  let marker: string | null = null;
  return {
    push(chunk: string): string | null {
      if (marker || !chunk) return marker;
      const candidate = suffix + chunk;
      marker = detectPreflightFailureMarker(candidate);
      suffix = candidate.slice(-PREFLIGHT_FAILURE_SCAN_TAIL);
      return marker;
    },
    seen: () => marker,
  };
}

export interface PreflightAttributionProcess {
  pid: number;
  /** Lifetime CPU ticks from `/proc/<pid>/stat`; not an instantaneous rate. */
  cpuTicks: number | null;
  cgroupPath: string | null;
  command: string;
}

export interface PreflightAttributionSnapshot {
  marker: string;
  capturedAt: string;
  /** Host-wide, because `/proc/loadavg` is not cgroup-scoped. */
  loadavg: string | null;
  cpuPressure: string | null;
  jobCgroupPath: string | null;
  jobCgroup: {
    memoryCurrent: number | null;
    memoryPeak: number | null;
    cpuUsageUsec: number | null;
    pidsCurrent: number | null;
    pids: number[];
  } | null;
  /** A bounded sample, sorted by lifetime CPU ticks when available. */
  processes: PreflightAttributionProcess[];
  scannedProcessCount: number;
  omittedProcessCount: number;
}

export interface PreflightAttributionCaptureOptions {
  marker: string;
  pid?: number | null;
  /** Prefer the task-manager path: the child may exit before the close handler. */
  jobCgroupPath?: string | null;
  now?: () => number;
  procRoot?: string;
  cgroupRoot?: string;
  readText?: (path: string) => string | null;
  readDir?: (path: string) => string[];
  redactValues?: readonly string[];
}

function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function defaultReadDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function finiteNonNegativeNumber(raw: string | null): number | null {
  if (raw == null || raw.trim() === '') return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** `/proc/<pid>/stat` CPU fields, without pretending they are a current rate. */
function parseProcessCpuTicks(stat: string | null): number | null {
  if (!stat) return null;
  const closeParen = stat.lastIndexOf(')');
  if (closeParen < 0) return null;
  const fields = stat
    .slice(closeParen + 1)
    .trim()
    .split(/\s+/);
  const user = finiteNonNegativeNumber(fields[11] ?? null);
  const system = finiteNonNegativeNumber(fields[12] ?? null);
  return user == null || system == null ? null : user + system;
}

function boundedSnapshotText(value: string | null, maxLength: number): string | null {
  if (value == null) return null;
  const normalized = value
    .replace(/\0/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  if (!normalized) return null;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function redactSnapshotText(value: string | null, redactValues: readonly string[] | undefined): string | null {
  if (value == null) return value;
  let safe = value;
  for (const secret of redactValues ?? []) {
    if (secret) safe = safe.split(secret).join('[REDACTED]');
  }
  // WI-10003538: a process cmdline can carry a credential SHAPE the operator
  // never bound (e.g. `curl -H "Authorization: token ghp_…"`).
  return redactSelfIdentifyingSecrets(safe);
}

/**
 * Capture the live evidence available at the instant a preflight marker is
 * observed. This is intentionally synchronous and bounded: it runs on a child
 * output callback, must never hold the operator open, and must fail soft when a
 * process or cgroup disappears during the read. The result is explicitly
 * current evidence; it cannot explain an earlier load spike retroactively.
 */
export function capturePreflightAttributionSnapshot(
  options: PreflightAttributionCaptureOptions,
): PreflightAttributionSnapshot {
  const procRoot = options.procRoot ?? '/proc';
  const cgroupRoot = options.cgroupRoot ?? CGROUP_ROOT;
  const readText = options.readText ?? defaultReadText;
  const readDir = options.readDir ?? defaultReadDir;
  const now = options.now ?? Date.now;
  const pid = options.pid != null && Number.isInteger(options.pid) && options.pid > 0 ? options.pid : null;
  const jobCgroupPath =
    options.jobCgroupPath ?? (pid == null ? null : parseProcCgroup(readText(`${procRoot}/${pid}/cgroup`) ?? ''));
  const jobCgroupDir = jobCgroupPath == null ? null : absCgroupDir(jobCgroupPath, cgroupRoot);
  const jobPids = jobCgroupDir == null ? [] : parseCgroupProcs(readText(`${jobCgroupDir}/cgroup.procs`) ?? '');
  const jobCgroup =
    jobCgroupDir == null
      ? null
      : {
          memoryCurrent: parseCgroupInt(readText(`${jobCgroupDir}/memory.current`)),
          memoryPeak: parseCgroupInt(readText(`${jobCgroupDir}/memory.peak`)),
          cpuUsageUsec: parseCpuStatUsageUsec(readText(`${jobCgroupDir}/cpu.stat`)),
          pidsCurrent: parseCgroupInt(readText(`${jobCgroupDir}/pids.current`)),
          pids: jobPids.slice(0, PREFLIGHT_SNAPSHOT_MAX_PROCESSES),
        };

  // Always include the managed job's own members, even when the bounded host
  // sample does not reach their PIDs. The remaining sample gives a next failure
  // a small, cgroup-labelled view of the host pressure sources without dumping
  // an unbounded /proc tree into a durable job log.
  const candidateNames = readDir(procRoot)
    .filter((name) => /^\d+$/.test(name))
    .sort((a, b) => Number(a) - Number(b));
  const candidatePids = new Set<number>(jobPids.slice(0, PREFLIGHT_SNAPSHOT_MAX_PROCESSES));
  for (const name of candidateNames.slice(0, PREFLIGHT_SNAPSHOT_MAX_PROCESS_SCAN)) {
    const candidate = Number(name);
    if (Number.isInteger(candidate) && candidate > 0) candidatePids.add(candidate);
  }

  const processes: PreflightAttributionProcess[] = [];
  for (const candidate of candidatePids) {
    const command =
      redactSnapshotText(
        boundedSnapshotText(
          parseProcCmdline(readText(`${procRoot}/${candidate}/cmdline`)),
          PREFLIGHT_SNAPSHOT_MAX_CMDLINE,
        ),
        options.redactValues,
      ) ?? '[unreadable cmdline]';
    const stat = readText(`${procRoot}/${candidate}/stat`);
    const cgroupPath = parseProcCgroup(readText(`${procRoot}/${candidate}/cgroup`) ?? '');
    processes.push({
      pid: candidate,
      cpuTicks: parseProcessCpuTicks(stat),
      cgroupPath,
      command,
    });
  }
  processes.sort((a, b) => (b.cpuTicks ?? -1) - (a.cpuTicks ?? -1) || a.pid - b.pid);

  return {
    marker: options.marker,
    capturedAt: new Date(now()).toISOString(),
    loadavg: boundedSnapshotText(readText(`${procRoot}/loadavg`), PREFLIGHT_SNAPSHOT_MAX_FIELD),
    cpuPressure: boundedSnapshotText(readText(`${procRoot}/pressure/cpu`), PREFLIGHT_SNAPSHOT_MAX_FIELD),
    jobCgroupPath,
    jobCgroup,
    processes: processes.slice(0, PREFLIGHT_SNAPSHOT_MAX_PROCESSES),
    scannedProcessCount: candidatePids.size,
    omittedProcessCount: Math.max(0, candidatePids.size - PREFLIGHT_SNAPSHOT_MAX_PROCESSES),
  };
}

function snapshotValue(value: string | number | null | undefined): string {
  return value == null ? 'unknown' : String(value);
}

/** Render the bounded live evidence as a log-only diagnostic block. */
export function formatPreflightAttributionSnapshot(snapshot: PreflightAttributionSnapshot): string {
  const lines = [
    `\n${PREFLIGHT_ATTRIBUTION_SNAPSHOT_PREFIX}: marker=${snapshot.marker} captured=${snapshot.capturedAt} basis=current-best-effort; this snapshot is NOT historical attribution`,
    `loadavg=${snapshotValue(snapshot.loadavg)}`,
    `cpu_pressure=${snapshotValue(snapshot.cpuPressure)}`,
    `job_cgroup=${snapshotValue(snapshot.jobCgroupPath)}`,
  ];
  if (snapshot.jobCgroup) {
    lines.push(
      `job_cgroup_metrics memory.current=${snapshotValue(snapshot.jobCgroup.memoryCurrent)} memory.peak=${snapshotValue(snapshot.jobCgroup.memoryPeak)} cpu.usage_usec=${snapshotValue(snapshot.jobCgroup.cpuUsageUsec)} pids.current=${snapshotValue(snapshot.jobCgroup.pidsCurrent)} members=${snapshot.jobCgroup.pids.join('|') || 'none'}`,
    );
  } else {
    lines.push('job_cgroup_metrics unavailable');
  }
  lines.push(
    `process_sample scanned=${snapshot.scannedProcessCount} returned=${snapshot.processes.length} omitted=${snapshot.omittedProcessCount} (cpu_ticks are lifetime counters, not instantaneous rates)`,
  );
  for (const process of snapshot.processes) {
    lines.push(
      `process pid=${process.pid} cpu_ticks=${snapshotValue(process.cpuTicks)} cgroup=${snapshotValue(process.cgroupPath)} cmd=${process.command}`,
    );
  }
  lines.push('end_preflight_attribution_snapshot\n');
  return lines.join('\n');
}

/**
 * A temp dir given to every capability-exec'd child, overriding whatever ephemeral
 * `TMPDIR` the operator inherited (EI-5912). The capability exec-sandbox (srt / the
 * bwrap `--tmpfs /tmp`) mounts a FRESH writable `/tmp`, so an inherited per-session
 * `TMPDIR=/tmp/claude/<runid>` does NOT exist inside the sandbox — a tool that does
 * `mkdir $TMPDIR/<x>` (vitest's SSR dir) then ENOENTs and the SANCTIONED test runner
 * (`capability:inspect { check:'test' }`) is unusable, forcing agents back to raw
 * bash. `/tmp` (the sandbox tmpfs root) always exists + is writable there (verified),
 * and is the sensible default TMPDIR unsandboxed too. Injected BEFORE the caller's
 * explicit `env`, so a caller that deliberately sets TMPDIR still wins. */
export const CAPABILITY_SANDBOX_TMPDIR = '/tmp';

export type BashStatus = 'running' | 'completed' | 'failed' | 'killed' | 'timed_out';

export interface BashJob {
  id: string;
  command: string;
  cwd: string;
  child: ChildProcess;
  startedAt: number;
  endedAt: number | null;
  status: BashStatus;
  exitCode: number | null;
  /** Retained tail of combined stdout+stderr (trimmed at MEM_BUFFER_CAP). */
  buffer: string;
  /** Total bytes ever produced (not just retained). */
  totalBytes: number;
  /** Absolute path to the full output spill log. */
  logPath: string;
  /** Index into `buffer` already returned by bash_output (incremental reads). */
  readCursor: number;
  logStream: WriteStream | null;
  /** Present only while the launching request can receive output events.
   * Cleared atomically when its response completes or yields so a durable job
   * neither emits into nor retains a closed request context. */
  responseStream?: (chunk: string) => void;
  /** A confined transient service writes command bytes + JOB END directly to
   *  the spill file. The operator keeps an append-only stream for its bounded
   *  diagnostics, but must not duplicate the runner's mirrored command bytes. */
  runnerOwnsLog?: boolean;
  /**
   * task-manager-no-escape-2026-07-27 P-008 — the DURABLE half of this job's
   * identity. The Map above dies with the operator process (EI-8855: any agent
   * restarting it wipes every handle, which is why an inherited "job COMPLETED"
   * claim has to be re-verified against the OS). The ledger row does not, and the
   * cgroup scope makes the job's whole subtree addressable without a pid.
   * Present for startBackground jobs, including capability:bash ordinary calls
   * that may yield. The legacy runForeground helper has no BashJob object.
   */
  taskId?: string;
  scopeUnit?: string | null;
  /**
   * EI-20051445912325691 — the previous cgroup CPU sample taken by `bash_output`, so a poll
   * can report cores burned SINCE THE LAST READ at zero added latency instead of pausing to
   * take a second sample every time. It lives on the job (whose registry is already a pinned
   * singleton) rather than in a module-level Map in the tool, which would be exactly the
   * split-module-state hazard `pinModuleState` exists for.
   *
   * A stale entry is harmless: `coresBetween` refuses any window that is too short, and
   * refuses a NEGATIVE usage delta, which is what a torn-down-and-recreated scope or a reused
   * pid produces.
   */
  lastCpuSample?: CgroupCpuSample | null;
  /** WI-6677: the EFFECTIVE execution wall-clock at which this durable job is
   *  terminated, independent of the launching request's response window. */
  timeoutMs?: number;
  /** Epoch ms of that deadline (`startedAt + timeoutMs`). */
  deadlineAt?: number;
}

const JOBS = new Map<string, BashJob>();

/**
 * EI-21905196224862433 — mirror `killJob`'s own synchronous kill-intent flip
 * for an EXTERNALLY-initiated kill (`processes:kill`, control.ts's
 * `killTask`), which has no reference to this module's job objects and so
 * cannot call `killJob` itself. See kill-notify.ts's header for the full
 * root-cause writeup: a confined job's watched child is the
 * `systemd-run --pipe --wait` client, which exits 0 once the unit is gone
 * regardless of whether it was killed — the close handler's naive
 * `code === 0` check cannot tell the difference on its own, so kill-INTENT
 * must be recorded before the client can possibly have exited. Registered
 * once at module load; `taskId` is `BashJob.taskId` (the task-manager ledger
 * id), NOT this module's own `id`/`bash_id` — JOBS is keyed by the latter, so
 * a linear scan is required. JOBS is bounded (MAX_RETAINED_JOBS finished jobs
 * plus whatever is currently running), so this is cheap.
 */
onTaskKillRequested((taskId, _signal) => {
  for (const job of JOBS.values()) {
    if (job.taskId === taskId && job.status === 'running') {
      // Same permanent kill-intent semantics as killJob(): this must stick
      // even if the process later exits cleanly on its own before the signal
      // takes effect (SIGTERM grace period, a trap, ...).
      job.status = 'killed';
    }
  }
});

/** Resolve + create the scratch dir for output spill. */
export function scratchDir(stateDir: string | undefined): string {
  const base = stateDir && stateDir.trim() ? stateDir : join(tmpdir(), 'papercusp-capability');
  const dir = join(base, 'scratch');
  // Owner-only when created here; files inside are 0600 regardless (SPILL_LOG_MODE).
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Spawn `bash -o pipefail -c <command>` with an augmented PATH (the operator
 *  sidecar's PATH often omits node/npx/git locations — same fix as
 *  pluginSpawnImpl). stdin is closed; combined stdout+stderr are piped.
 *
 *  `-o pipefail` (EI-13414): without it, bash's reported exit code for a
 *  piped command (`cmd | tail -N`, `| head`, `| grep`, …) is the LAST
 *  command's exit code, not the pipeline's — so `real-test-runner | tail -60`
 *  reports the tool's own exit 0 even when the runner FAILED, silently
 *  masking a real failure as a clean pass to whichever agent is trusting
 *  `exitCode`/`isError` as completion evidence (the exact near-miss that
 *  filed this bug: a real `1 non-quarantined task(s) failed` was reported as
 *  exit 0). `pipefail` makes the reported exit code the right-most non-zero
 *  status in the pipeline (or zero if all succeed) — the same fix a diligent
 *  caller is told to apply by hand (`set -o pipefail`); applying it at the
 *  spawn layer protects every agent using this shared shell tool, not just
 *  ones who remembered to opt in. A caller that truly wants "ignore this
 *  stage's exit code" still has the standard escape hatch (`cmd || true`,
 *  `cmd; true`) — same as any pipefail-enabled shell.
 *
 *  When `sandboxEnabled`, the `bash -c` runs inside the existing SRT/bwrap OS
 *  sandbox. Optional trusted-owner rollout remains fail-open for compatibility;
 *  `sandboxRequired` (confined work) refuses before spawn if no wrapper works. */
function spawnShell(
  command: string,
  cwd: string,
  env: Record<string, string> | undefined,
  sandboxEnabled = false,
  sandboxRequired = false,
  background = false,
  /** task-manager P-008: wrap the resolved argv into this job's cgroup scope.
   *  Applied AFTER the sandbox decision so bwrap still wraps the payload and the
   *  scope wraps bwrap — the confinement layers nest rather than compete. */
  wrapScope?: (
    binary: string,
    argv: string[],
    env?: Readonly<Record<string, string | undefined>>,
    cwd?: string,
  ) => { binary: string; argv: string[] },
  /** Per-job nonce for an authenticated command-not-found marker. Generic
   *  `command not found` text is ordinary child output (test fixtures emit it),
   *  so it cannot safely determine this wrapper's exit status. */
  missingCommandToken?: string,
  /** Deterministic unit-test seam for wrapper availability; never caller input. */
  sandboxBuildOpts?: Omit<BuildSandboxOpts, 'enabled' | 'required' | 'background'>,
): ChildProcess {
  const spawnPath = augmentedSpawnPath(cwd);
  const instrumentedCommand = missingCommandToken
    ? instrumentMissingCommandFailures(command, missingCommandToken)
    : command;
  // EI-1617: scrubExecEnv replaces the old stripHostX-only passthrough — an
  // ALLOWLIST (PATH/HOME/locale/toolchain vars + the couple of Papercusp
  // plumbing vars this path needs), not a denylist, so the operator's OWN
  // secrets (DB creds, webhook/JWT secrets, session keys, …) never reach a
  // bee's shell command. DISPLAY/XAUTHORITY/WAYLAND_DISPLAY are dropped too
  // (not in the allowlist) — strictly narrower than stripHostX, so the old
  // host-X isolation still holds.
  const inheritedEnv = normalizeInheritedOperatorUrl(scrubExecEnv(process.env));
  const decision = buildCapabilitySandboxCommand(
    { cmd: [resolveBin('bash', spawnPath), '-o', 'pipefail', '-c', instrumentedCommand], cwd },
    // EI-16635: `background` (true for startBackground's run_in_background jobs)
    // tells the sandbox builder to omit bwrap's `--die-with-parent` — that flag
    // is incompatible with a job contractually meant to outlive this spawn call.
    { ...sandboxBuildOpts, enabled: sandboxEnabled, required: sandboxRequired, background },
  );
  assertCapabilitySandboxAvailable(decision, cwd);
  if (sandboxEnabled && !decision.sandboxed) {
    console.warn(
      `[capability:bash] exec-sandbox enabled but ${decision.reason} — running unsandboxed in the operator process (cwd ${cwd})`,
    );
  }
  // Build the payload environment once, after the inherited env has been
  // scrubbed and the cwd-specific toolchain PATH has been finalized. A
  // transient systemd SERVICE is started by the user manager, so it does not
  // inherit this process's environment; passing only the caller's explicit
  // env to `wrapScope` silently dropped the scrubbed identity and PATH that
  // `childSpawn` still received.
  const childEnv = {
    ...inheritedEnv,
    TMPDIR: CAPABILITY_SANDBOX_TMPDIR,
    TMP: CAPABILITY_SANDBOX_TMPDIR,
    TEMP: CAPABILITY_SANDBOX_TMPDIR,
    ...(env ?? {}),
    PATH: spawnPath,
  };
  // EI-21229453838112711: `cwd` MUST be handed to the wrapper, not only to
  // childSpawn below. A background bash job is enrolled as a transient systemd
  // SERVICE, and a service payload does not inherit this process's cwd — the
  // childSpawn `cwd` applies to the systemd-run client only, leaving the real
  // command in $HOME.
  const launch = wrapScope
    ? wrapScope(decision.binary, decision.argv, childEnv, cwd)
    : { binary: decision.binary, argv: decision.argv };
  const child = childSpawn(launch.binary, launch.argv, {
    cwd,
    // ISOLATION (2026-06-19 keystroke-leak fix): strip the operator's host X session
    // (DISPLAY=:0 / gdm XAUTHORITY) so a bee shell can NEVER inherit the seat. A GUI
    // command only reaches a display when the caller (bash.ts) explicitly bound a
    // LEASED sandbox DISPLAY in `env`; with no lease there is no DISPLAY at all.
    // TMPDIR/TMP/TEMP → a dir that EXISTS inside the exec-sandbox (EI-5912): after
    // stripHostX (which keeps the inherited, possibly-ephemeral TMPDIR) but BEFORE
    // the caller's explicit `env`, so a deliberate caller override still wins.
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    // OWN PROCESS GROUP (capability-bash-orphan-kill-2026-06-21): `detached:true`
    // makes the child (bash, or the bwrap wrapper) a process-group leader
    // (pgid === child.pid on Linux). That is what lets a timeout/abort kill the
    // WHOLE tree — bash AND every descendant it spawned (grep/ugrep/build/…) — via
    // process.kill(-pid). Without it, killing only the bash parent ORPHANS its
    // children (reparented to init), which keep running at full CPU: the runaway
    // 58-min ugrep that starved the operator event loop → :3070 wedge. We never
    // unref() the child, so the operator still tracks + reaps it normally.
    detached: true,
  });
  return child;
}

function normalizeInheritedOperatorUrl(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const raw = env.PAPERCUSP_OPERATOR_URL?.trim();
  if (!raw) return env;
  const hadMcpSuffix = /\/api\/mcp\/?$/.test(raw);
  const base = raw.replace(/\/api\/mcp\/?$/, '').replace(/\/$/, '');
  const routedBase = resolveAgentMcpBaseUrl(base);
  if (routedBase === base) return env;
  return {
    ...env,
    PAPERCUSP_OPERATOR_URL: hadMcpSuffix ? `${routedBase}/api/mcp` : routedBase,
  };
}

/**
 * Kill a spawned command's ENTIRE process group, not just the bash parent.
 * spawnShell runs `detached:true`, so the child is its own process-group leader
 * (pgid === child.pid); signalling the NEGATIVE pid reaches bash and every
 * descendant it spawned. Without this a timed-out / aborted command leaves
 * orphaned grandchildren (e.g. ugrep) running at 100% CPU — the wedge root cause
 * (capability-bash-orphan-kill-2026-06-21). Falls back to a direct child kill if
 * the group signal fails (child already exited / pid reused). Never throws.
 */
function killProcessTree(child: ChildProcess, sig: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, sig); // negative pid → the whole process group
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* already exited */
    }
  }
}

/**
 * EI-24498234296505540 — backoff (ms) between attempts to reach a confined job's
 * transient `.service` unit after systemd REFUSED the request. ~25s in total, so
 * a `daemon-reload` (measured 0.9s under gate load; >10s has been observed on
 * this box) cannot outlast the schedule.
 */
export const SERVICE_UNIT_SIGNAL_RETRY_DELAYS_MS: readonly number[] = [
  50, 100, 200, 400, 800, 1_600, 3_200, 6_400, 12_800,
];

type ServiceSignalTarget = Pick<BashJob, 'scopeUnit' | 'exitCode' | 'endedAt'>;

/** A transient service is no longer in the systemd-run client's process group.
 * Signal the service unit as well as the client so in-memory kill/timeout paths
 * have the same whole-job semantics as the durable task-manager path.
 *
 * EI-24498234296505540 — a kill can be requested before the unit is LIVE. The
 * client's StartTransientUnit call queues behind anything that stalls the user
 * manager (measured: an 889ms `daemon-reload`), so for that window the unit is
 * either not loaded yet or loaded with its start job still pending. The old
 * `systemctl kill` lost the signal both ways and nothing re-sent it. "Not loaded"
 * failed and the error was swallowed. A loaded unit with no processes yet
 * returns exit 0 on systemd 255, having signalled nothing. The job still read
 * `killed`, and the payload then ran to completion (an abort that did not abort).
 *
 * So the unit is STOPPED, not killed. `stop --no-block` cancels a pending start
 * job, and on a live unit it sends SIGTERM to the whole control group, the same
 * set `kill` reached, so a TERM trap still runs before the job is seen to end.
 * A "not loaded" refusal is retried on the schedule above. SIGTERM retries only
 * while the job is still running. SIGKILL retries whatever the client does,
 * because the caller kills the client's process group alongside it: the
 * client's exit says nothing about a unit that has not started yet.
 */
export function signalServiceUnit(job: ServiceSignalTarget, sig: NodeJS.Signals, attempt = 0): void {
  const unit = job.scopeUnit;
  if (!unit?.endsWith('.service')) return;
  if (sig === 'SIGKILL') {
    try {
      execFile('systemctl', ['--user', 'kill', '--signal=SIGKILL', unit], { timeout: 15_000 }, () => {});
    } catch {
      /* the stop below still takes the unit down */
    }
  }
  try {
    execFile('systemctl', ['--user', '--no-block', 'stop', unit], { timeout: 15_000 }, (err) => {
      if (!err) return;
      if (sig !== 'SIGKILL' && (job.exitCode !== null || job.endedAt !== null)) return;
      const delay = SERVICE_UNIT_SIGNAL_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) return;
      setTimeout(() => signalServiceUnit(job, sig, attempt + 1), delay).unref();
    });
  } catch {
    /* the client process-group signal below remains the best effort fallback */
  }
}

/**
 * WI-1064487 — for a CONFINED job the payload is NOT in the client's process
 * group (see signalServiceUnit's note directly above), so killing that group
 * kills the systemd-run CLIENT while the payload's own TERM trap is still
 * running. The client runs `systemd-run --pipe --wait`, so it exits on its own
 * once the unit terminates, carrying the payload's real exit status. Signalling
 * the UNIT ALONE therefore preserves the causal order the whole
 * SIGTERM-before-SIGKILL design depends on: cleanup runs, THEN the job is
 * observed to end.
 *
 * Killing the client too is what made `endedAt` mean "the client is gone"
 * rather than "the job finished and its cleanup ran" — so a waiter released on
 * endedAt could read the job's side effects before its trap had written them —
 * and what pinned `job.exitCode` at null for every confined job, which in turn
 * made the escalation's `exitCode === null` guard below fire unconditionally
 * instead of distinguishing the two cases it was written to distinguish.
 *
 * SIGKILL is the deliberate exception: it is the escalation of last resort and
 * must still reach both, precisely so that a unit signal which never lands
 * cannot leave the job running forever.
 */
function killJobProcessTree(job: BashJob, sig: NodeJS.Signals): void {
  signalServiceUnit(job, sig);
  // Only a `.service` unit is separately signalable (signalServiceUnit ignores
  // anything else), so only that case may skip the process-group kill — a
  // `.scope` or unconfined job still needs it or nothing would stop it.
  if (sig !== 'SIGKILL' && job.scopeUnit?.endsWith('.service')) return;
  killProcessTree(job.child, sig);
}

/** Append a chunk to a job's in-memory tail (trimmed) + spill log + totals. */
function appendOutput(job: BashJob, chunk: string): void {
  job.totalBytes += Buffer.byteLength(chunk, 'utf8');
  job.buffer += chunk;
  if (job.buffer.length > MEM_BUFFER_CAP) {
    const overflow = job.buffer.length - MEM_BUFFER_CAP;
    job.buffer = job.buffer.slice(overflow);
    job.readCursor = Math.max(0, job.readCursor - overflow);
  }
  if (!job.runnerOwnsLog) {
    try {
      job.logStream?.write(chunk);
    } catch {
      /* a spill-write fault must not crash the job */
    }
  }
}

/**
 * EI-18764990059061608 — the terminal marker every job's spill log ends with once
 * it reaches a terminal state, so a caller that reads the log FILE directly
 * (`cat`/Read on `log_path`, bypassing `capability:bash_output`'s own `status`
 * field entirely) can tell "finished, genuinely no output" from "still running,
 * nothing flushed yet" without an extra call. The two states are otherwise
 * byte-identical to a raw file read — that ambiguity is exactly what closed a
 * red typecheck as a clean claim in the filed bug.
 *
 * Its ABSENCE from a raw read means no terminal marker has been durably recorded
 * yet — it does NOT prove that the job is still running. A job can die before its
 * close handler gets to this write (for example when the operator is killed), in
 * which case the recovery path appends a JOB DIED marker once the task ledger
 * confirms the unobserved death. Never read an empty/partial file lacking either
 * marker as evidence of a clean or completed result. Kept as one exported, pure
 * formatter (rather than inlined at each of the three call sites) so the exact
 * text can be asserted in a test and can never drift between them.
 */
export const JOB_LOG_END_MARKER_PREFIX = '[capability:bash] JOB END';
export const JOB_LOG_DIED_MARKER_PREFIX = '[capability:bash] JOB DIED';

export function formatJobLogEndMarker(status: BashStatus, exitCode: number | null, endedAtMs: number): string {
  return (
    `\n${JOB_LOG_END_MARKER_PREFIX}: status=${status} exit=${exitCode ?? 'null'} at ${new Date(endedAtMs).toISOString()}` +
    ' — this line marks the job reaching an OBSERVED terminal state; if it is ABSENT, no terminal marker has ' +
    'been durably recorded yet: the job may still be running, or it may have died before its close handler wrote ' +
    'JOB END. Check capability:bash_output/task ledger; recovery writes JOB DIED after a ledger-confirmed ' +
    'unobserved death.\n'
  );
}

/**
 * Marker written by `capability:bash_output` after the durable task ledger
 * confirms that a background job reached a terminal state without the child
 * close handler recording its normal JOB END line. This is intentionally a
 * separate marker: an unobserved death must never be presented as a clean exit,
 * and the absence of JOB END must not leave a raw log reader believing the job
 * is still running forever.
 */
export function formatJobLogDiedMarker(
  state: string,
  exitCode: number | null,
  exitReason: string | null,
  endedAtMs: number,
): string {
  return (
    `\n${JOB_LOG_DIED_MARKER_PREFIX}: state=${state} exit=${exitCode ?? 'null'} at ${new Date(endedAtMs).toISOString()}` +
    ` reason=${JSON.stringify(exitReason)} — this line records a ledger-confirmed terminal state after the child ` +
    'exit was not observed; it is NOT a clean-exit marker.\n'
  );
}

/**
 * EI-19915289191989412 — commands whose LAST pipeline stage is a buffering
 * filter (`tail`, `head`, `sort`, `uniq`, `wc`, …) do not flush any output
 * until the WHOLE pipeline exits: `some-long-command | tail -45` is a natural
 * idiom for bounding what you'll read back, but it means a background job's
 * spill log — and `capability:bash_output`'s `total_bytes_written` — stays at
 * exactly 0 for the job's entire runtime, then fills all at once at exit. A
 * caller polling that job sees a well-formed, confident-looking EMPTY result
 * that is indistinguishable from "never started" / "produced nothing", which
 * invites re-running (doubling the load) rather than just waiting for the
 * `JOB_LOG_END_MARKER_PREFIX` line.
 *
 * This is a best-effort HEURISTIC on the raw shell text, not a real parser —
 * false negatives (an unrecognized buffering stage) are fine, the only thing
 * that matters is not producing a false ALARM on a command that streams fine.
 */
const BUFFERING_LAST_STAGE_COMMANDS = new Set(['tail', 'head', 'sort', 'uniq', 'wc', 'column', 'less', 'more']);

/** Split a shell command on top-level `|` (pipeline stages), respecting single-
 *  and double-quoted spans and leaving `||` (logical OR) untouched. Not a real
 *  shell parser — good enough to find the LAST pipeline stage of a typical
 *  `cmd 2>&1 | tail -45` idiom. */
function splitTopLevelPipes(command: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      cur += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      cur += ch;
      continue;
    }
    if (!inSingle && !inDouble && ch === '|') {
      if (command[i + 1] === '|') {
        cur += '||';
        i++;
        continue;
      }
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/**
 * Returns the buffering command name (`'tail'`, `'head'`, …) if `command`'s
 * LAST top-level pipeline stage is one of the known output-buffering filters,
 * else `null`. A command with no pipe at all always returns `null`.
 */
export function detectBufferingLastStage(command: string): string | null {
  const stages = splitTopLevelPipes(command);
  if (stages.length < 2) return null;
  const last = stages[stages.length - 1].trim();
  // Skip any leading inline env assignments (`FOO=bar tail -45`).
  const m = /^(?:[A-Za-z_][\w]*=\S+\s+)*(\S+)/.exec(last);
  if (!m) return null;
  const base = m[1].split('/').pop() ?? m[1];
  return BUFFERING_LAST_STAGE_COMMANDS.has(base) ? base : null;
}

/**
 * A shell-backgrounded child does not have the lifetime callers expect from
 * `run_in_background:true`: the task service owns the shell's cgroup, and the
 * service tears that cgroup down as soon as the shell exits. `nohup`, `setsid`,
 * and `disown` change signal/session handling, but they do not move a process
 * out of that cgroup. The common failure therefore looks like a successful
 * launch followed by a silent empty file.
 *
 * This is intentionally a conservative, quote- and heredoc-aware heuristic,
 * not a shell parser. A bare `&` is safe when the same command later waits for
 * the child (`cmd & wait`, or one child followed by `wait "$!"`), so those
 * forms remain valid. Multiple backgrounded children require a bare `wait`
 * after the last one; `wait "$!"` only proves one child was joined.
 */
export interface UntrackedShellBackgrounding {
  operator: '&' | 'coproc';
  excerpt: string;
  backgroundCount: number;
}

interface ShellWaitObservation {
  index: number;
  hasArgument: boolean;
}

interface ShellWaitSummary {
  hasWait: boolean;
  hasBareWait: boolean;
}

const SHELL_WAIT_PREFIXES = new Set(['builtin', 'command']);
const SHELL_COMMAND_KEYWORDS = new Set(['!', 'do', 'elif', 'else', 'if', 'then', 'until', 'while', '{']);

/**
 * Mask here-document bodies while preserving newlines and source indexes.
 * Operators in a script body are data, not operators of the outer command.
 */
function maskShellHeredocBodies(command: string): string {
  const lines = command.split('\n');
  const masked: string[] = [];
  let pending: Array<{ delimiter: string; stripTabs: boolean }> = [];

  const heredocDelimiters = (line: string): Array<{ delimiter: string; stripTabs: boolean }> => {
    const found: Array<{ delimiter: string; stripTabs: boolean }> = [];
    let quote: "'" | '"' | null = null;
    let escaped = false;
    for (let i = 0; i < line.length - 1; i += 1) {
      const ch = line[i]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quote) {
        if (ch === '\\' && quote === '"') escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch !== '<' || line[i + 1] !== '<' || line[i + 2] === '<') continue;
      let cursor = i + 2;
      const stripTabs = line[cursor] === '-';
      if (stripTabs) cursor += 1;
      while (/\s/.test(line[cursor] ?? '')) cursor += 1;
      const delimiterQuote = line[cursor] === "'" || line[cursor] === '"' ? line[cursor] : null;
      if (delimiterQuote) cursor += 1;
      const start = cursor;
      while (cursor < line.length && !/\s/.test(line[cursor]!)) cursor += 1;
      const delimiter = line.slice(start, cursor).replace(/^['"]|['"]$/g, '');
      if (delimiter) found.push({ delimiter, stripTabs });
      i = Math.max(i, cursor - 1);
    }
    return found;
  };

  for (const line of lines) {
    if (pending.length > 0) {
      masked.push('');
      const current = pending[0]!;
      const probe = current.stripTabs ? line.replace(/^\t+/, '') : line;
      if (probe.trim() === current.delimiter) pending.shift();
      continue;
    }
    masked.push(line);
    pending = heredocDelimiters(line);
  }
  return masked.join('\n');
}

function shellOperatorExcerpt(command: string, index: number): string {
  const start = Math.max(0, index - 48);
  const end = Math.min(command.length, index + 72);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < command.length ? '…' : '';
  return `${prefix}${command.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}

/**
 * Mask quoted strings and comments while preserving indexes. This is only used
 * to find shell function declarations and trap registrations; the original
 * source is retained for inspecting the cleanup body afterward.
 */
function maskShellQuotesAndComments(command: string): string {
  const chars = command.split('');
    let quote: "'" | '"' | null = null;
  let escaped = false;
  let inComment = false;

  for (let i = 0; i < chars.length; i += 1) {
    const ch = command[i]!;
    if (inComment) {
      if (ch === '\n') inComment = false;
      else chars[i] = ' ';
      continue;
    }
    if (quote) {
      if (ch === '\n') {
        // Keep line boundaries so command-list matching remains index-stable.
        escaped = false;
        continue;
      }
      chars[i] = ' ';
      if (escaped) {
        escaped = false;
      } else if (ch === '\\' && quote === '"') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      chars[i] = ' ';
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /[\s;|&(){}]/.test(command[i - 1]!))) {
      chars[i] = ' ';
      inComment = true;
    }
  }
  return chars.join('');
}

function findMatchingShellBrace(source: string, openingIndex: number): number | null {
  let depth = 1;
  for (let i = openingIndex + 1; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && --depth === 0) return i;
  }
  return null;
}

/**
 * Inspect a shell fragment for command-position `wait` builtins. This mirrors
 * the detector's conservative token rules, but deliberately ignores `&` and
 * records only wait shape; it is used for EXIT cleanup bodies whose source
 * position can precede the background child they join.
 */
function summarizeShellWaits(source: string): ShellWaitSummary {
  const waits: ShellWaitObservation[] = [];
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let token = '';
  let tokenStart = -1;
  let commandPosition = true;
  let redirectTarget = false;
  let currentWait: ShellWaitObservation | null = null;

  const flushToken = (): void => {
    if (!token) return;
    const value = token;
    const start = tokenStart;
    const wasRedirectTarget = redirectTarget;
    token = '';
    tokenStart = -1;
    redirectTarget = false;

    if (wasRedirectTarget) return;
    if (currentWait) currentWait.hasArgument = true;
    if (!commandPosition) return;
    if (value === 'wait') {
      currentWait = { index: start, hasArgument: false };
      waits.push(currentWait);
      commandPosition = false;
      return;
    }
    if (SHELL_WAIT_PREFIXES.has(value) || SHELL_COMMAND_KEYWORDS.has(value) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      commandPosition = true;
    } else {
      commandPosition = false;
    }
  };

  const separator = (): void => {
    flushToken();
    currentWait = null;
    commandPosition = true;
    redirectTarget = false;
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (escaped) {
      token += ch;
      escaped = false;
      continue;
    }
    if (quote) {
      token += ch;
      if (ch === '\\' && quote === '"') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (tokenStart < 0) tokenStart = i;
      token += ch;
      quote = ch;
      continue;
    }
    if (ch === '\\') {
      if (tokenStart < 0) tokenStart = i;
      token += ch;
      escaped = true;
      continue;
    }
    if (ch === '#' && (i === 0 || /[\s;|&(){}]/.test(source[i - 1]!))) {
      flushToken();
      while (i + 1 < source.length && source[i + 1] !== '\n') i += 1;
      continue;
    }
    if (ch === '&' && source[i + 1] === '&') {
      separator();
      i += 1;
      continue;
    }
    if (ch === '&' || ch === '|' || ch === ';' || ch === '\n') {
      separator();
      if (ch === '|' && source[i + 1] === '|') i += 1;
      continue;
    }
    if (ch === '>' || ch === '<') {
      flushToken();
      redirectTarget = true;
      continue;
    }
    if (ch === '(' || ch === '{') {
      flushToken();
      currentWait = null;
      commandPosition = true;
      redirectTarget = false;
      continue;
    }
    if (ch === ')' || ch === '}') {
      flushToken();
      currentWait = null;
      commandPosition = false;
      redirectTarget = false;
      continue;
    }
    if (/\s/.test(ch)) {
      flushToken();
      continue;
    }
    if (tokenStart < 0) tokenStart = i;
    token += ch;
  }
  flushToken();

  return {
    hasWait: waits.length > 0,
    hasBareWait: waits.some((wait) => !wait.hasArgument),
  };
}

/**
 * Find a wait registered for the shell's EXIT cleanup, even when its function
 * definition or quoted trap handler appears before the background operator.
 * Only a trap explicitly targeting EXIT qualifies; arbitrary quoted prose and
 * non-EXIT traps remain invisible to this exception.
 */
function summarizeExitCleanupWaits(command: string): ShellWaitSummary {
  const source = maskShellHeredocBodies(command);
  const masked = maskShellQuotesAndComments(source);
  const functions = new Map<string, ShellWaitSummary>();
  const functionPattern =
    /(?:^|[;{}\n])\s*(?:function\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*\))?|([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\))\s*\{/g;

  for (const match of masked.matchAll(functionPattern)) {
    const name = match[1] ?? match[2];
    if (!name || match.index == null) continue;
    const openingIndex = match.index + match[0].lastIndexOf('{');
    const closingIndex = findMatchingShellBrace(masked, openingIndex);
    if (closingIndex == null) continue;
    functions.set(name, summarizeShellWaits(source.slice(openingIndex + 1, closingIndex)));
  }

  const trapPrefix = String.raw`(?:^|[;|&{}\n()])\s*(?:(?:then|do|else|elif|if|while|until|!|command|builtin)\s+)*trap\s+(?:--\s+)?`;
  const events: Array<{ index: number; summary: ShellWaitSummary }> = [];
  const empty: ShellWaitSummary = { hasWait: false, hasBareWait: false };
  const isShellLevel = (index: number): boolean => {
    let quote: "'" | '"' | null = null;
    let escaped = false;
    for (let cursor = 0; cursor < index; cursor += 1) {
      const ch = source[cursor]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quote) {
        if (quote === '"' && ch === '\\') escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === "'" || ch === '"') quote = ch;
    }
    return quote === null;
  };
  const namedTrapPattern = new RegExp(`${trapPrefix}([A-Za-z_][A-Za-z0-9_]*)\\s+EXIT\\b`, 'g');
  for (const match of masked.matchAll(namedTrapPattern)) {
    const name = match[1];
    events.push({ index: match.index ?? 0, summary: name ? functions.get(name) ?? empty : empty });
  }

  const singleQuotedTrapPattern = new RegExp(`${trapPrefix}'([^']*)'\\s+EXIT\\b`, 'g');
  for (const match of source.matchAll(singleQuotedTrapPattern)) {
    if (!isShellLevel(match.index ?? 0)) continue;
    events.push({ index: match.index ?? 0, summary: summarizeShellWaits(match[1] ?? '') });
  }
  const doubleQuotedTrapPattern = new RegExp(`${trapPrefix}"((?:\\\\.|[^"\\\\])*)"\\s+EXIT\\b`, 'g');
  for (const match of source.matchAll(doubleQuotedTrapPattern)) {
    if (!isShellLevel(match.index ?? 0)) continue;
    events.push({ index: match.index ?? 0, summary: summarizeShellWaits(match[1] ?? '') });
  }

  // `trap - EXIT` and `trap '' EXIT` clear a previously installed handler.
  const clearTrapPattern = new RegExp(`${trapPrefix}(?:-|''|"")\\s+EXIT\\b`, 'g');
  for (const match of source.matchAll(clearTrapPattern)) {
    if (!isShellLevel(match.index ?? 0)) continue;
    events.push({ index: match.index ?? 0, summary: empty });
  }
  events.sort((a, b) => a.index - b.index);
  return events.length > 0 ? events[events.length - 1]!.summary : empty;
}

/**
 * Detect a background child that the shell can leave behind when it exits.
 * `wait` recognition only accepts a command-position builtin, so prose such as
 * `echo "cmd & wait"` and `echo wait` do not satisfy the guard.
 */
export function detectUntrackedShellBackgrounding(command: string): UntrackedShellBackgrounding | null {
  const source = maskShellHeredocBodies(command);
  const backgroundIndexes: number[] = [];
  const coprocIndexes: number[] = [];
  const waits: ShellWaitObservation[] = [];

  let quote: "'" | '"' | null = null;
  let escaped = false;
  let token = '';
  let tokenStart = -1;
  let commandPosition = true;
  let redirectTarget = false;
  let currentWait: ShellWaitObservation | null = null;
  let arithmeticParenDepth = 0;

  const flushToken = (): void => {
    if (!token) return;
    const value = token;
    const start = tokenStart;
    const wasRedirectTarget = redirectTarget;
    token = '';
    tokenStart = -1;
    redirectTarget = false;

    if (wasRedirectTarget) return;

    if (currentWait) currentWait.hasArgument = true;
    if (!commandPosition) return;

    if (value === 'wait') {
      currentWait = { index: start, hasArgument: false };
      waits.push(currentWait);
      commandPosition = false;
      return;
    }
    if (value === 'coproc') {
      coprocIndexes.push(start);
      commandPosition = false;
      return;
    }

    // Keep command position through shell assignments and the two builtins that
    // can validly introduce another builtin. `env wait`/`nohup wait` are not
    // treated as waits because they do not invoke Bash's wait builtin.
    if (SHELL_WAIT_PREFIXES.has(value) || SHELL_COMMAND_KEYWORDS.has(value) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      commandPosition = true;
    } else {
      commandPosition = false;
    }
  };

  const separator = (): void => {
    flushToken();
    currentWait = null;
    commandPosition = true;
    redirectTarget = false;
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (escaped) {
      token += ch;
      escaped = false;
      continue;
    }
    if (quote) {
      token += ch;
      if (ch === '\\' && quote === '"') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (tokenStart < 0) tokenStart = i;
      token += ch;
      quote = ch;
      continue;
    }
    if (ch === '\\') {
      if (tokenStart < 0) tokenStart = i;
      token += ch;
      escaped = true;
      continue;
    }
    // Bash uses the same ampersand character for bitwise/logical arithmetic
    // operators inside `(( ... ))` and `$(( ... ))`. Those ampersands are
    // expression data, not shell background operators. Track the arithmetic
    // parentheses so the backgrounding guard does not reject valid commands.
    if (ch === '(' && source[i - 1] === '(') {
      arithmeticParenDepth = 1;
      continue;
    }
    if (arithmeticParenDepth > 0) {
      if (ch === '(') {
        arithmeticParenDepth += 1;
        continue;
      }
      if (ch === ')') {
        arithmeticParenDepth -= 1;
        continue;
      }
      if (ch === '&') continue;
    }
    if (ch === '#' && (i === 0 || /[\s;|&()]/.test(source[i - 1]!))) {
      flushToken();
      while (i + 1 < source.length && source[i + 1] !== '\n') i += 1;
      continue;
    }
    if (ch === '&' && source[i + 1] === '&') {
      separator();
      i += 1;
      continue;
    }
    if (ch === '&') {
      if (source[i + 1] === '>' || source[i - 1] === '>' || source[i - 1] === '|' || source[i + 1] === '&') {
        if (tokenStart < 0) tokenStart = i;
        token += ch;
        continue;
      }
      flushToken();
      backgroundIndexes.push(i);
      currentWait = null;
      commandPosition = true;
      redirectTarget = false;
      continue;
    }
    if (ch === '|' && source[i + 1] === '|') {
      separator();
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|') {
      separator();
      continue;
    }
    if (ch === '>' || ch === '<') {
      flushToken();
      redirectTarget = true;
      continue;
    }
    if (ch === '(' || ch === '{') {
      flushToken();
      currentWait = null;
      commandPosition = true;
      redirectTarget = false;
      continue;
    }
    if (ch === ')' || ch === '}') {
      flushToken();
      currentWait = null;
      commandPosition = false;
      redirectTarget = false;
      continue;
    }
    if (/\s/.test(ch)) {
      flushToken();
      continue;
    }
    if (tokenStart < 0) tokenStart = i;
    token += ch;
  }
  flushToken();

  const asyncIndexes = [...backgroundIndexes, ...coprocIndexes].sort((a, b) => a - b);
  if (asyncIndexes.length === 0) return null;
  const lastAsyncIndex = asyncIndexes[asyncIndexes.length - 1]!;
  const waitsAfterLastAsync = waits.filter((wait) => wait.index > lastAsyncIndex);
  const exitCleanupWaits = summarizeExitCleanupWaits(command);
  const joined =
    asyncIndexes.length === 1
      ? waitsAfterLastAsync.length > 0 || exitCleanupWaits.hasWait
      : waitsAfterLastAsync.some((wait) => !wait.hasArgument) || exitCleanupWaits.hasBareWait;
  if (joined) return null;

  const operatorIndex =
    coprocIndexes.length > 0 && coprocIndexes[coprocIndexes.length - 1]! > lastAsyncIndex
      ? coprocIndexes[coprocIndexes.length - 1]!
      : lastAsyncIndex;
  return {
    operator: coprocIndexes.includes(operatorIndex) ? 'coproc' : '&',
    excerpt: shellOperatorExcerpt(command, operatorIndex),
    backgroundCount: asyncIndexes.length,
  };
}

/** Render the refusal returned before a durable task can be launched. */
export function formatUntrackedShellBackgroundAdvice(diagnostic: UntrackedShellBackgrounding): string {
  const operator = diagnostic.operator === 'coproc' ? '`coproc`' : 'a shell background operator (`&`)';
  return (
    `Refused: this command starts ${operator} without joining it before the shell exits ` +
    `(${diagnostic.excerpt}). The task service owns the shell's cgroup, so the child is reaped when the ` +
    `shell finishes; nohup/setsid/disown do not give it a different lifetime. Run the long-lived command ` +
    `as the foreground payload (remove the shell backgrounding), or use the dedicated service launcher for ` +
    `a different lifetime. If multiple in-task children are intentional, end the command with a bare ` +
    '`wait` after all of them.'
  );
}

/**
 * Explain how to preserve output from a buffering pipeline when the background
 * job's in-memory tracking is lost. Polling is a valid way to observe a healthy
 * job, but it cannot recover a buffered pipeline once the registry and terminal
 * marker are gone; a file redirect is the durable recovery path for a rerun.
 */
export function formatBufferingPipelineAdvice(stage: string, context: 'launch' | 'tracking-lost'): string {
  const redirect =
    `For a rerun, redirect output to a file you own (for example \`cmd > /tmp/job.log 2>&1; rc=$?; echo "EXIT=$rc" >> /tmp/job.log; exit $rc\`` +
    ` — capture \`$?\` into a variable and re-exit it, since a command ending in \`echo\` reports the echo's own ` +
    `exit status (always 0), not \`cmd\`'s) instead of piping through \`${stage}\``;
  if (context === 'tracking-lost') {
    return (
      `This job's last pipeline stage pipes through \`${stage}\`, which BUFFERS its output. ` +
      'Because tracking is already lost, do not keep polling for growing output or a JOB END marker: ' +
      'the buffered bytes and JOB END marker may be unrecoverable. Absence of JOB END is not proof the job is ' +
      'still running; the task ledger is authoritative, and capability:bash_output appends JOB DIED after it ' +
      'confirms an unobserved death. Read `log_path` directly for any retained output. ' +
      redirect
    );
  }
  return (
    ` NOTE: this command's last pipeline stage pipes through \`${stage}\`, which BUFFERS its output — the log will most likely stay at 0 bytes for the whole run and fill all at once at exit. ` +
    'An empty bash_output read here is NOT evidence the job has not started or produced nothing. If tracking is lost while this job runs, the buffered bytes may be unrecoverable and the JOB END marker may never be written. Its absence is not proof the job is still running; a ledger-confirmed unobserved death is recorded as JOB DIED. ' +
    redirect
  );
}

/**
 * A stdout redirect the command performs ITSELF (`>` / `>>` / `&>` / `&>>` /
 * `1>` to a file), which sends the job's output somewhere OTHER than the
 * capability's own log. EI-21301075566136325: for such a job, an empty
 * capability log (`total_bytes_written: 0`, `output_tail: ""`) is the EXPECTED
 * and CORRECT reading and carries no information about progress — rendering it
 * as "how far it got" turns "not measured" into what reads as "nothing
 * happened" (the repo's documented false-absence class), inviting the caller to
 * relaunch a live job.
 */
export interface SelfOutputRedirect {
  /** The redirect target as written (surrounding quotes stripped; may still
   *  contain `$vars` or command substitution when `literalPath` is false). */
  target: string;
  /** The operator observed: `>`, `>>`, `&>`, `&>>`, `1>`, or `1>>`. */
  op: string;
  /** True when `target` is a literal absolute path with no expansion
   *  characters — safe for a caller to stat as a progress probe. */
  literalPath: boolean;
}

interface HeredocDeclaration {
  delimiter: string;
  stripTabs: boolean;
}

/**
 * Commands commonly used only to probe or tear down a job. Their own stdout
 * redirects must not make the enclosing job look as if it redirected its
 * output away from the capability log (EI-23104327379801926).
 */
const COMMAND_LOCAL_REDIRECT_HELPERS = new Set(['cleanup', 'curl']);
// These builtins can own a file redirect without writing any command output.
// Treating their truncation as the background job's stdout target produces a
// false empty-log advisory (for example `: > "$LOG"; command &`).
const NO_OUTPUT_REDIRECT_COMMANDS = new Set([':', 'true', 'false']);
const REDIRECT_COMMAND_KEYWORDS = new Set([
  'case',
  'coproc',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'fi',
  'for',
  'function',
  'if',
  'in',
  'select',
  'then',
  'time',
  'until',
  'while',
]);
const SHELL_COMMAND_PREFIXES = new Set([
  'builtin',
  'command',
  'env',
  'exec',
  'nice',
  'nohup',
  'setsid',
  'sudo',
  'stdbuf',
]);

interface RedirectCandidate {
  redirect: SelfOutputRedirect;
  commandId: number;
  helperScope: boolean;
}

interface ShellCommandState {
  commandId: number;
  commandName: string | null;
  commandToken: string;
  commandTokenStart: number;
  commandPrefixPending: boolean;
}

/**
 * Read the delimiter from a heredoc operator outside shell quotes. The body is
 * not shell syntax, so a `>` in JavaScript, Markdown, or another embedded
 * language must not be mistaken for a stdout redirect by the advisory scanner.
 */
function readHeredocDeclaration(command: string, operatorIndex: number): HeredocDeclaration | null {
  if (command[operatorIndex + 1] !== '<' || command[operatorIndex + 2] === '<') return null;

  const lineEnd = command.indexOf('\n', operatorIndex + 2);
  if (lineEnd < 0) return null;

  let i = operatorIndex + 2;
  let stripTabs = false;
  if (command[i] === '-') {
    stripTabs = true;
    i++;
  }
  while (i < lineEnd && /[ \t]/.test(command[i])) i++;

  let delimiter = '';
  let quote: "'" | '"' | null = null;
  for (; i < lineEnd; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else delimiter += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '\\' && i + 1 < lineEnd) {
      delimiter += command[++i];
      continue;
    }
    if (/[ \t;|&<>]/.test(ch)) break;
    delimiter += ch;
  }

  return delimiter.length > 0 ? { delimiter, stripTabs } : null;
}

/** Return the character after a heredoc's delimiter line, or command.length. */
function skipHeredocBody(command: string, bodyStart: number, declaration: HeredocDeclaration): number {
  let lineStart = bodyStart;
  while (lineStart <= command.length) {
    const newline = command.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? command.length : newline;
    let line = command.slice(lineStart, lineEnd);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (declaration.stripTabs) line = line.replace(/^\t+/, '');
    if (line === declaration.delimiter) return newline < 0 ? command.length : newline + 1;
    if (newline < 0) return command.length;
    lineStart = newline + 1;
  }
  return command.length;
}

/**
 * Detects whether `command` redirects its OWN stdout to a file, anywhere in the
 * command (not just the last stage — `for i in …; do echo … >> /tmp/x; done`
 * counts). Skips stderr-only redirects (`2>`), fd dups (`>&2`, `2>&1`), process
 * substitution (`>(…)`), anything inside quotes, and redirects owned by the
 * command-local curl/cleanup helpers, no-output builtins, and commandless shell
 * redirects. Returns the LAST owned redirect (the conventional main one), or
 * `null`. Deliberately pragmatic, like
 * `detectBufferingLastStage`: this feeds an advisory note, so a rare miss just
 * preserves today's behavior.
 */
export function detectSelfOutputRedirect(command: string): SelfOutputRedirect | null {
  let inSingle = false;
  let inDouble = false;
  let commandId = 0;
  let commandName: string | null = null;
  let commandToken = '';
  let commandTokenStart = -1;
  let commandPrefixPending = false;
  let pendingFunctionName: string | null = null;
  let functionParenDepth = 0;
  const helperBraceScopes: boolean[] = [];
  const nestedCommandStates: ShellCommandState[] = [];
  const commandNames = new Map<number, string | null>();
  const candidates: RedirectCandidate[] = [];
  const pendingHeredocs: HeredocDeclaration[] = [];

  const commandBasename = (value: string): string => {
    const slash = value.lastIndexOf('/');
    return (slash >= 0 ? value.slice(slash + 1) : value).replace(/^['"]|['"]$/g, '');
  };

  const isCommandLocalHelperRedirect = (owner: string | null | undefined, redirect: SelfOutputRedirect): boolean => {
    const name = owner ? commandBasename(owner) : null;
    // A standalone curl that deliberately writes a report file is still the
    // managed command. Only the conventional health-check discard is helper
    // output; cleanup is helper-owned regardless of its discard target.
    return name === 'cleanup' || (name === 'curl' && redirect.target === '/dev/null');
  };

  const flushCommandToken = (): void => {
    if (!commandToken) return;
    const value = commandToken;
    commandToken = '';
    commandTokenStart = -1;
    const base = commandBasename(value);
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
    if (commandName !== null || assignment || REDIRECT_COMMAND_KEYWORDS.has(base)) return;
    if (commandPrefixPending) {
      if (base.startsWith('-') || assignment) return;
      commandPrefixPending = false;
      commandName = base;
      return;
    }
    if (SHELL_COMMAND_PREFIXES.has(base)) {
      commandPrefixPending = true;
      return;
    }
    commandName = base;
  };

  const startNewCommand = (): void => {
    flushCommandToken();
    commandNames.set(commandId, commandName);
    commandId += 1;
    commandName = null;
    commandToken = '';
    commandTokenStart = -1;
    commandPrefixPending = false;
    pendingFunctionName = null;
    functionParenDepth = 0;
  };

  const pushNestedCommand = (): void => {
    flushCommandToken();
    nestedCommandStates.push({
      commandId,
      commandName,
      commandToken,
      commandTokenStart,
      commandPrefixPending,
    });
    commandId += 1;
    commandName = null;
    commandToken = '';
    commandTokenStart = -1;
    commandPrefixPending = false;
    pendingFunctionName = null;
    functionParenDepth = 0;
  };

  const popNestedCommand = (): void => {
    flushCommandToken();
    const state = nestedCommandStates.pop();
    if (!state) {
      startNewCommand();
      return;
    }
    commandNames.set(commandId, commandName);
    commandId = state.commandId;
    commandName = state.commandName;
    commandToken = state.commandToken;
    commandTokenStart = state.commandTokenStart;
    commandPrefixPending = state.commandPrefixPending;
  };

  const helperScopeActive = (): boolean => helperBraceScopes.some(Boolean);

  for (let i = 0; i < command.length; i++) {
    if (command[i] === '\n' && !inSingle && !inDouble && pendingHeredocs.length > 0) {
      let bodyCursor = i + 1;
      for (const heredoc of pendingHeredocs) {
        bodyCursor = skipHeredocBody(command, bodyCursor, heredoc);
      }
      pendingHeredocs.length = 0;
      i = bodyCursor - 1;
      continue;
    }
    const ch = command[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (inSingle || inDouble) continue;

    // A backslash-newline is continuation whitespace, not a command boundary.
    if (ch === '\\' && command[i + 1] === '\n') {
      i += 1;
      continue;
    }

    if (functionParenDepth > 0) {
      if (ch === '(') functionParenDepth += 1;
      if (ch === ')') {
        functionParenDepth -= 1;
        if (functionParenDepth === 0) pendingFunctionName = commandName;
      }
      continue;
    }

    if (ch === '<') {
      flushCommandToken();
      if (command[i + 1] === '<') {
        const heredoc = readHeredocDeclaration(command, i);
        if (heredoc) {
          // Keep scanning the declaration line: a real redirect may follow the
          // heredoc (`cat <<EOF > /tmp/out`). Its body begins after the line.
          pendingHeredocs.push(heredoc);
        }
        i += 1;
        continue;
      }
      // Input redirects cannot own stdout. Skip their target so it cannot be
      // mistaken for the first command word in a redirect-before-command form.
      let j = i + 1;
      while (j < command.length && /\s/.test(command[j])) j++;
      let targetQuote: "'" | '"' | null = null;
      for (; j < command.length; j++) {
        const targetChar = command[j];
        if (targetQuote) {
          if (targetChar === targetQuote) targetQuote = null;
          continue;
        }
        if (targetChar === "'" || targetChar === '"') {
          targetQuote = targetChar;
          continue;
        }
        if (/[\s;|&<>()]/.test(targetChar)) break;
      }
      i = j - 1;
      continue;
    }

    if (ch === '\n' || ch === ';') {
      startNewCommand();
      continue;
    }
    if (ch === '&') {
      if (command[i + 1] === '>' || command[i - 1] === '>') continue;
      if (command[i + 1] === '&') i += 1;
      startNewCommand();
      continue;
    }
    if (ch === '|') {
      if (command[i + 1] === '|') i += 1;
      else if (command[i + 1] === '&') i += 1;
      startNewCommand();
      continue;
    }
    if (ch === '(') {
      const isFunctionDeclaration =
        commandName !== null && !REDIRECT_COMMAND_KEYWORDS.has(commandName) && /^\s*\)/.test(command.slice(i + 1));
      if (isFunctionDeclaration) {
        functionParenDepth = 1;
        continue;
      }
      pushNestedCommand();
      continue;
    }
    if (ch === ')') {
      popNestedCommand();
      continue;
    }
    if (ch === '{') {
      flushCommandToken();
      const functionPrefix = /(?:^|[;\n])\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*\))?\s*$/.exec(
        command.slice(0, i),
      );
      helperBraceScopes.push(
        (pendingFunctionName !== null && COMMAND_LOCAL_REDIRECT_HELPERS.has(commandBasename(pendingFunctionName))) ||
          (functionPrefix !== null && COMMAND_LOCAL_REDIRECT_HELPERS.has(functionPrefix[1])),
      );
      startNewCommand();
      continue;
    }
    if (ch === '}') {
      flushCommandToken();
      helperBraceScopes.pop();
      startNewCommand();
      continue;
    }
    if (/\s/.test(ch)) {
      flushCommandToken();
      continue;
    }
    if (ch === '>') {
      flushCommandToken();

      const prev = command[i - 1];
      let op: string;
      let opEnd = i + 1; // index just past the operator
      if (prev === '&' && command[i - 2] !== '>') {
        // `&>` / `&>>` — bash "both streams" redirect. (`>&` dup is handled below.)
        op = '&>';
      } else if (prev !== undefined && /\d/.test(prev)) {
        // A digit-prefixed redirect (`1>`, `2>`) only counts as an fd redirect
        // when the digit starts its own token; otherwise the digit is part of a
        // word (`echo hi1>f` still redirects stdout, with `hi1` the word).
        const beforeDigit = command[i - 2];
        const digitIsFd = beforeDigit === undefined || /[\s;|&(]/.test(beforeDigit);
        if (digitIsFd && prev !== '1') {
          // Stderr(-or-other-fd)-only redirect: stdout still reaches the
          // capability log, so this is not a self-output redirect. Skip past its
          // target so we do not re-trigger inside it.
          if (command[opEnd] === '>') opEnd++;
          i = opEnd;
          continue;
        }
        op = digitIsFd ? '1>' : '>';
      } else {
        op = '>';
      }
      if (command[opEnd] === '>') {
        op += '>';
        opEnd++;
      }
      // Fd dup (`>&1`, `1>&2`) or process substitution (`>(…)`) — not a file.
      if (command[opEnd] === '&' || command[opEnd] === '(') {
        i = opEnd;
        continue;
      }

      // Parse the target token (respecting quotes), tracking expansion characters.
      let j = opEnd;
      while (j < command.length && /\s/.test(command[j])) j++;
      let target = '';
      let hasExpansion = false;
      let tSingle = false;
      let tDouble = false;
      for (; j < command.length; j++) {
        const tc = command[j];
        if (tc === "'" && !tDouble) {
          tSingle = !tSingle;
          continue;
        }
        if (tc === '"' && !tSingle) {
          tDouble = !tDouble;
          continue;
        }
        if (!tSingle && !tDouble && /[\s;|&<>()]/.test(tc)) break;
        if (!tSingle && (tc === '$' || tc === '`')) hasExpansion = true;
        target += tc;
      }
      if (target.length > 0) {
        candidates.push({
          redirect: {
            target,
            op,
            literalPath: target.startsWith('/') && !hasExpansion && !/[*?]/.test(target),
          },
          commandId,
          helperScope: helperScopeActive(),
        });
      }
      i = j - 1;
      continue;
    }
    if (commandTokenStart < 0) commandTokenStart = i;
    commandToken += ch;
  }

  flushCommandToken();
  commandNames.set(commandId, commandName);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i]!;
    const owner = commandNames.get(candidate.commandId);
    if (
      candidate.helperScope ||
      owner == null ||
      NO_OUTPUT_REDIRECT_COMMANDS.has(commandBasename(owner)) ||
      isCommandLocalHelperRedirect(owner, candidate.redirect)
    ) {
      continue;
    }
    return candidate.redirect;
  }
  return null;
}

/**
 * Explain that an empty capability log is the EXPECTED reading for a job that
 * redirects its own stdout, and point at the redirect target (with a fresh stat
 * of it, when the caller could take one) as the ACTUAL progress signal.
 */
export function formatSelfRedirectAdvice(
  redirect: SelfOutputRedirect,
  probe: { sizeBytes: number; mtimeMs: number } | null,
): string {
  if (redirect.target === '/dev/null') {
    return (
      `NOTE: this command discards its own stdout (\`${redirect.op} /dev/null\`), so an empty ` +
      'output_tail here is EXPECTED and says NOTHING about progress — judge liveness by the task ' +
      'ledger or `ps`, never by output volume.'
    );
  }
  const probeNote = probe
    ? ` Measured just now: \`${redirect.target}\` holds ${probe.sizeBytes} bytes, last written ${new Date(probe.mtimeMs).toISOString()}.`
    : '';
  return (
    `NOTE: this command redirects its own stdout (\`${redirect.op} ${redirect.target}\`), so the ` +
    'capability log legitimately holds nothing — an empty output_tail here means "not measured", ' +
    'NOT "the job produced nothing". Judge progress by that file instead: sample its size/mtime ' +
    'twice a few seconds apart (growth = alive and advancing).' +
    probeNote
  );
}

export interface RunOptions {
  command: string;
  cwd: string;
  stateDir: string | undefined;
  env?: Record<string, string>;
  /** Exact secret values that must never reach streamed output, retained output,
   *  or spill logs. Redaction happens before every one of those sinks and keeps
   *  enough suffix state to catch a value split across child-process chunks. */
  redactValues?: readonly string[];
  /** Per-event streamer while the launching request is still awaiting this job. */
  onChunk?: (chunk: string) => void;
  /** Whether to engage the existing SRT/bwrap execution sandbox. */
  sandboxEnabled?: boolean;
  /** Confined profile: wrapper unavailability refuses before the command starts. */
  sandboxRequired?: boolean;
  /** Server-owned wrapper overrides — never exposed as a tool argument. Tests use it
   *  as a deterministic seam; capability:bash sets `{ denyAllEgress: true, srtBin: null }`
   *  for a caller holding a personal disclosure (WI-10005589, BAR R-11). */
  sandboxBuildOpts?: Omit<BuildSandboxOpts, 'enabled' | 'required' | 'background'>;
  /** task-manager P-008 provenance — the agent id this job is FOR, and the
   *  work-item it is attributable to. Optional because a caller that does not know
   *  should say so (the row records `capability:bash`) rather than guess: a wrong
   *  attribution in a ledger built for attribution is worse than an honest gap. */
  launchedBy?: string;
  workItemId?: string | null;
  planSlug?: string | null;
  harnessSlug?: string | null;
  sessionId?: string | null;
  /** The live goal ref used to derive workItemId/planSlug. Diagnostic-only, so a
   *  future reader can distinguish "no goal" from a parser miss. */
  goalRef?: string | null;
}

export interface ForegroundResult {
  status: BashStatus;
  exitCode: number | null;
  output: string;
  totalBytes: number;
  truncated: boolean;
  logPath: string;
  durationMs: number;
}

/**
 * Bash reports a missing executable as exit 127, but that status can be hidden
 * by a successful outer command (for example, a command substitution piped
 * through `head`). Keep the capability result fail-loud even when the shell's
 * final status says that the wrapper command completed successfully.
 *
 * This is deliberately a diagnostic-only contract. It does not add a binary
 * to PATH or resolve through a host-private tool directory; a missing command
 * remains missing and the caller gets an actionable failed result instead of a
 * false green.
 */
export interface MissingCommandDiagnostic {
  command: string;
  line: string;
}

const MISSING_COMMAND_EXIT_CODE = 127;
const MISSING_COMMAND_SENTINEL_PREFIX = '[capability:bash] COMMAND NOT FOUND';
const MISSING_COMMAND_RE =
  /(?:^|\n)(?:[^:\r\n]+:\s+)*(?<command>[^\s:]+):\s+(?:command not found|not found)(?:\r?\n|$)/m;

export function detectMissingCommandDiagnostic(output: string): MissingCommandDiagnostic | null {
  const match = MISSING_COMMAND_RE.exec(output);
  const command = match?.groups?.command;
  if (!command) return null;
  return { command, line: match[0].trim() };
}

function instrumentMissingCommandFailures(command: string, token: string): string {
  // Bash invokes this function for a missing command, including one inside a
  // command substitution whose consumer later exits 0. The per-job token makes
  // the marker attributable to THIS wrapper rather than to arbitrary child
  // output (for example a test asserting a missing-command diagnostic).
  return (
    `command_not_found_handle() { printf '\\n${MISSING_COMMAND_SENTINEL_PREFIX} token=%s command=%s: command not found\\n' ` +
    `'${token}' "$1" >&2; return ${MISSING_COMMAND_EXIT_CODE}; };\n${command}`
  );
}

/**
 * `head` is an intentional early-exit consumer for bounded read-only
 * inspection. When a producer still has data, the kernel delivers SIGPIPE and
 * bash + pipefail reports 141. Normalize only that exact narrow shape; a
 * failing producer, a mutating/unknown command, or another consumer remains a
 * genuine non-zero result.
 */
export function normalizeExpectedSigpipeResult(
  command: string,
  status: BashStatus,
  exitCode: number | null,
): { status: BashStatus; exitCode: number | null } {
  if (status === 'failed' && exitCode === 141 && isReadOnlyHeadPipeline(command)) {
    return { status: 'completed', exitCode: 0 };
  }
  return { status, exitCode };
}

/**
 * Ripgrep uses exit code 1 for a valid no-match result. In a read-only count
 * pipeline, a downstream wc has already converted that result into a useful
 * zero count; pipefail must not turn it back into a failed capability call.
 */
export function normalizeExpectedRgNoMatchResult(
  command: string,
  status: BashStatus,
  exitCode: number | null,
): { status: BashStatus; exitCode: number | null } {
  if (status === 'failed' && exitCode === 1 && isReadOnlyRgCountPipeline(command)) {
    return { status: 'completed', exitCode: 0 };
  }
  return { status, exitCode };
}

/**
 * `ps --ppid <numeric-pid>` reports exit 1 when the parent currently has no
 * children. In the narrow read-only probe shape, an empty output is the valid
 * observation rather than a failed capability call. Require the empty output
 * so malformed ps invocations and real diagnostics retain their failure.
 */
export function normalizeExpectedPsPpidEmptyResult(
  command: string,
  status: BashStatus,
  exitCode: number | null,
  output: string,
): { status: BashStatus; exitCode: number | null } {
  if (status === 'failed' && exitCode === 1 && output.trim() === '' && isReadOnlyPsPpidPipeline(command)) {
    return { status: 'completed', exitCode: 0 };
  }
  return { status, exitCode };
}

function createMissingCommandMarkerDetector(token: string): { push: (chunk: string) => void; seen: () => boolean } {
  const marker = `${MISSING_COMMAND_SENTINEL_PREFIX} token=${token} `;
  let tail = '';
  let matched = false;
  return {
    push(chunk: string): void {
      if (matched || !chunk) return;
      const candidate = tail + chunk;
      matched = candidate.includes(marker);
      tail = candidate.slice(-Math.max(0, marker.length - 1));
    },
    seen: () => matched,
  };
}

function normalizeMissingCommandResult(
  status: BashStatus,
  exitCode: number | null,
  authenticatedMarkerSeen: boolean,
): { status: BashStatus; exitCode: number | null } {
  if (status !== 'completed' || !authenticatedMarkerSeen) return { status, exitCode };
  return { status: 'failed', exitCode: MISSING_COMMAND_EXIT_CODE };
}

export interface StreamingSecretRedactor {
  /** Consume one raw child-process chunk and return only the safe prefix. */
  push(chunk: string): string;
  /** Drain the final safe tail when the child reaches a terminal state. */
  flush(): string;
}

/**
 * Build a chunk-boundary-safe exact-value redactor.
 *
 * A naive `chunk.replace(secret, ...)` leaks whenever stdout/stderr delivers the
 * first half of a credential in one Buffer and the second half in the next. This
 * scanner retains at most `longestSecret.length - 1` trailing characters, which
 * is precisely the region where a not-yet-complete match can still begin. The
 * retained suffix is emitted only after the next chunk proves it is not part of
 * a secret, or from `flush()` once the process has ended.
 *
 * Values are sorted longest-first so overlapping credentials redact the most
 * specific value in one marker. Empty values are ignored: matching an empty
 * string would insert a marker between every character and provides no secrecy.
 */
export function createStreamingSecretRedactor(values: readonly string[] | undefined): StreamingSecretRedactor | null {
  const secrets = [...new Set((values ?? []).filter((value) => value.length > 0))].sort((a, b) => b.length - a.length);
  if (secrets.length === 0) return null;

  const longest = secrets[0]!.length;
  const marker =
    ['[REDACTED integration credential]', '[REDACTED]', '<removed>'].find((candidate) =>
      secrets.every((secret) => !candidate.includes(secret)),
    ) ??
    (() => {
      // A marker must not itself reproduce a short or human-readable secret
      // (for example a saved value literally equal to "REDACTED"). The private-use
      // fallback chooses a character absent from every finite input value, so the
      // replacement cannot contain any exact secret even in that adversarial case.
      for (let codePoint = 0xe000; codePoint <= 0x10ffff; codePoint += 1) {
        const candidate = String.fromCodePoint(codePoint);
        if (secrets.every((secret) => !secret.includes(candidate))) return candidate.repeat(8);
      }
      throw new Error('unable to construct a non-secret redaction marker');
    })();
  let pending = '';

  const scan = (input: string, startLimit: number): { output: string; consumed: number } => {
    let output = '';
    let index = 0;
    while (index < startLimit) {
      const match = secrets.find((secret) => input.startsWith(secret, index));
      if (match) {
        output += marker;
        index += match.length;
      } else {
        output += input[index];
        index += 1;
      }
    }
    return { output, consumed: index };
  };

  return {
    push(chunk: string): string {
      const input = pending + chunk;
      pending = '';
      const safeStartLimit = Math.max(0, input.length - (longest - 1));
      const { output, consumed } = scan(input, safeStartLimit);
      pending = input.slice(consumed);
      return output;
    },
    flush(): string {
      const input = pending;
      pending = '';
      return scan(input, input.length).output;
    },
  };
}

/**
 * Credential SHAPES redacted from every capability:bash output sink — inline
 * result, streamed chunks, bash_output reads and the spill log (WI-10003538).
 * Sourced from `sensitive-text.ts`; never fork the regex here.
 */
export const CAPABILITY_OUTPUT_REDACTION_PATTERNS = Object.freeze([SELF_IDENTIFYING_SECRET_PATTERN]);

/**
 * The complete capability:bash output redactor: exact operator-bound values
 * first, then self-identifying credential shapes. Never null — shape redaction
 * applies even when the call binds no integration credential, because the
 * command itself can print a token the operator never saw.
 */
export function createCapabilityOutputRedactor(values: readonly string[] | undefined): StreamingSecretRedactor {
  const redactor = composeStreamingRedactors(
    createStreamingSecretRedactor(values),
    createStreamingPatternRedactor(CAPABILITY_OUTPUT_REDACTION_PATTERNS),
  );
  if (!redactor) throw new Error('capability:bash output redaction patterns are empty');
  return redactor;
}

export interface StreamingLineCap {
  /** Consume a safe output chunk and return only the bounded stream portion. */
  push(chunk: string): string;
  /** Flush a final unterminated line once the child reaches a terminal state. */
  flush(): string;
}

/**
 * Bound foreground output events by logical line while leaving the spill log,
 * inline accumulation, and byte totals unchanged. Child-process chunks do not
 * align with lines, so this keeps a small suffix pending until it can tell
 * whether the line ends or continues past the cap.
 */
export function createStreamingLineCap(): StreamingLineCap {
  const marker = STREAM_LINE_TRUNCATION_MARKER;
  // Reserve room for the marker so the emitted line stays within the same cap
  // even when the marker is needed.
  const normalContentCap = STREAM_LINE_OUTPUT_CAP - marker.length;
  let lineLength = 0;
  let pending = '';
  let truncated = false;

  const resetLine = (): void => {
    lineLength = 0;
    pending = '';
    truncated = false;
  };

  return {
    push(chunk: string): string {
      if (!chunk) return '';

      let output = '';
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf('\n', offset);
        const end = newline === -1 ? chunk.length : newline;
        const segment = chunk.slice(offset, end);

        if (truncated) {
          // The marker has already been emitted; discard the rest of this
          // overlong line but preserve its line terminator for framing.
          if (newline === -1) break;
          output += '\n';
          resetLine();
          offset = newline + 1;
          continue;
        }

        pending += segment;
        if (lineLength + pending.length > STREAM_LINE_OUTPUT_CAP) {
          const remaining = Math.max(0, normalContentCap - lineLength);
          output += pending.slice(0, remaining) + marker;
          lineLength = STREAM_LINE_OUTPUT_CAP;
          pending = '';
          truncated = true;
          if (newline === -1) break;
          output += '\n';
          resetLine();
          offset = newline + 1;
          continue;
        }

        // Keep only enough suffix to decide whether a marker is needed. This
        // makes a line split across arbitrary child chunks behave like one
        // continuous line rather than resetting the cap on every event.
        const emitLength = Math.max(0, pending.length - marker.length);
        if (emitLength > 0) {
          output += pending.slice(0, emitLength);
          pending = pending.slice(emitLength);
          lineLength += emitLength;
        }

        if (newline !== -1) {
          output += pending + '\n';
          resetLine();
          offset = newline + 1;
        } else {
          break;
        }
      }
      return output;
    },

    flush(): string {
      if (truncated) {
        pending = '';
        return '';
      }
      const output = pending;
      pending = '';
      return output;
    },
  };
}

/**
 * Run a command to completion in the foreground. Streams chunks via `onChunk`,
 * spills the full combined output to a scratch log, enforces a wall-clock
 * timeout, and aborts on `signal`. Returns the (possibly head+tail-trimmed)
 * inline output plus the spill path.
 */
export function runForeground(opts: RunOptions, signal: AbortSignal, timeoutMs: number): Promise<ForegroundResult> {
  return new Promise<ForegroundResult>((resolvePromise) => {
    const id = cryptoRandomId();
    const logPath = join(scratchDir(opts.stateDir), `bash-${id}.log`);
    const logStream = safeWriteStream(logPath);
    const startedAt = Date.now();
    const child = spawnShell(
      opts.command,
      opts.cwd,
      opts.env,
      opts.sandboxEnabled,
      opts.sandboxRequired,
      false,
      undefined,
      id,
      opts.sandboxBuildOpts,
    );

    let buffer = '';
    let totalBytes = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const redactor = createCapabilityOutputRedactor(opts.redactValues);
    const streamLineCap = createStreamingLineCap();
    const missingCommandDetector = createMissingCommandMarkerDetector(id);
    // Child streams can split a UTF-8 code point across arbitrary data events.
    // Keep one decoder per stream so incomplete sequences carry into the next
    // chunk instead of becoming replacement characters (WI-910499).
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let redactorFlushed = false;

    const appendSafeOutput = (s: string): void => {
      if (!s) return;
      missingCommandDetector.push(s);
      totalBytes += Buffer.byteLength(s, 'utf8');
      if (buffer.length < MEM_BUFFER_CAP) buffer += s;
      try {
        logStream?.write(s);
      } catch {
        /* ignore spill fault */
      }
      const streamed = streamLineCap.push(s);
      if (streamed) opts.onChunk?.(streamed);
    };
    const appendRawOutput = (s: string): void => {
      appendSafeOutput(redactor?.push(s) ?? s);
    };
    const flushRedactor = (): void => {
      if (redactorFlushed) return;
      redactorFlushed = true;
      appendSafeOutput(redactor?.flush() ?? '');
    };
    const onStdoutData = (b: Buffer): void => appendRawOutput(stdoutDecoder.write(b));
    const onStderrData = (b: Buffer): void => appendRawOutput(stderrDecoder.write(b));
    child.stdout?.on('data', onStdoutData);
    child.stderr?.on('data', onStderrData);

    const timer = setTimeout(
      () => {
        timedOut = true;
        killProcessTree(child, 'SIGKILL');
      },
      Math.min(timeoutMs, MAX_TIMEOUT_MS),
    );

    const onAbort = (): void => {
      aborted = true;
      killProcessTree(child, 'SIGKILL');
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    const finish = (status: BashStatus, exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      // Flush incomplete trailing bytes before the redactor and line-cap flushes
      // finalize their own suffix state.
      appendRawOutput(stdoutDecoder.end());
      appendRawOutput(stderrDecoder.end());
      // The suffix held for chunk-boundary matching must reach every safe sink
      // before output/truncation metadata is finalized.
      flushRedactor();
      const streamedTail = streamLineCap.flush();
      if (streamedTail) opts.onChunk?.(streamedTail);
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      const normalized = normalizeMissingCommandResult(status, exitCode, missingCommandDetector.seen());
      const truncated = buffer.length > INLINE_OUTPUT_CAP;
      const output = truncated ? headTail(buffer) : buffer;
      const result: ForegroundResult = {
        status: normalized.status,
        exitCode: normalized.exitCode,
        output,
        totalBytes,
        truncated: truncated || totalBytes > Buffer.byteLength(buffer, 'utf8'),
        logPath,
        durationMs: Date.now() - startedAt,
      };
      // EI-18764990059061608: the terminal marker goes to the SPILL LOG only —
      // never into `buffer`/`output` above, which callers (e.g. the EI-1617
      // secrets test) assert byte-exact. A foreground call already returns its
      // own `status` synchronously to the caller that awaited it; the marker is
      // for a SEPARATE reader tailing `logPath` mid-run (a large build, watched
      // from another tool call) who has no other way to see this job finish.
      try {
        logStream?.write(formatJobLogEndMarker(normalized.status, normalized.exitCode, Date.now()));
      } catch {
        /* best-effort; a spill-write fault must not affect the result */
      }
      // Resolve only AFTER the spill log has fully flushed to disk: a fire-and-forget
      // `end()` returns before createWriteStream's buffered writes reach the file, so a
      // caller (or test) that reads `logPath` synchronously could see a partially
      // flushed prefix — the tail is missing under I/O load. `end(cb)` fires the
      // callback on the stream's 'finish' event (flush complete). Resolve exactly once,
      // whether the flush completes or the stream errors (spill is best-effort).
      let resolved = false;
      const settleOnce = (): void => {
        if (resolved) return;
        resolved = true;
        resolvePromise(result);
      };
      if (logStream) {
        logStream.on('error', settleOnce);
        try {
          logStream.end(settleOnce);
        } catch {
          settleOnce();
        }
      } else {
        settleOnce();
      }
    };

    child.on('error', (err) => {
      const msg = `\n[spawn error] ${err instanceof Error ? err.message : String(err)}\n`;
      appendRawOutput(msg);
      finish('failed', null);
    });
    child.on('close', (code) => {
      const status: BashStatus = timedOut ? 'timed_out' : aborted ? 'killed' : code === 0 ? 'completed' : 'failed';
      const sigpipeNormalized = normalizeExpectedSigpipeResult(opts.command, status, code);
      const ppidNormalized = normalizeExpectedPsPpidEmptyResult(
        opts.command,
        sigpipeNormalized.status,
        sigpipeNormalized.exitCode,
        buffer,
      );
      const normalized = normalizeExpectedRgNoMatchResult(
        opts.command,
        ppidNormalized.status,
        ppidNormalized.exitCode,
      );
      finish(normalized.status, normalized.exitCode);
    });
  });
}

/**
 * Start a command in the background. Registers a {@link BashJob}, returns its id
 * immediately. Output streams to both the in-memory tail (for incremental
 * `bash_output` reads) and the spill log. Prunes finished jobs past the cap.
 */
export function startBackground(opts: RunOptions, timeoutMs: number): BashJob {
  pruneFinished();
  const id = cryptoRandomId();
  const logPath = join(scratchDir(opts.stateDir), `bash-${id}.log`);

  // WI-6677: clamp against the BACKGROUND ceiling, not the foreground one. Every
  // downstream use (the ledger's runtimeMaxSec, the kill timer, the exitReason a
  // later poll reads) must agree on this ONE number — the old code clamped inside
  // the timer only, so the ledger advertised a runtimeMaxSec the timer never
  // honoured.
  const effectiveTimeoutMs = Math.min(timeoutMs, MAX_BACKGROUND_TIMEOUT_MS);

  // task-manager P-008: mint the task id + confinement decision BEFORE the fork so
  // the scope name can go into the argv; the ledger WRITES happen afterwards,
  // fire-and-forget, and can never block or fail this spawn (see enroll-sync.ts).
  //
  // EI-21192501620501693: the task deadline is a REAL cgroup deadline, not only
  // an in-memory timer owned by this operator process. The old local-only timer
  // died on operator restart and left the confined subtree immortal. A process
  // deliberately daemonized inside this arbitrary-command task remains part of
  // the same task and is reaped at the caller-selected deadline; a service that
  // needs a separate lifetime belongs behind its dedicated launcher/chokepoint.
  const runtimeMaxSec = Math.max(1, Math.ceil(effectiveTimeoutMs / 1000));
  const isTestRun = isBackgroundTestCommand(opts.command);
  const testBudget = isTestRun ? { memoryMaxBytes: BASH_TEST_MEMORY_MAX_BYTES, tasksMax: BASH_TEST_TASKS_MAX } : {};
  const enrolment = beginSyncEnrolment({ class: 'bash-job', runtimeMaxSec, ...testBudget });
  const scopeCgroupPath = syncEnrolmentScopePath(enrolment, 'bash-job');
  const runnerOwnsLog = enrolment.confined && enrolment.unitKind === 'service';

  // Physical drills are long-running and must survive the interactive caller.
  // Force the marker AFTER caller-provided env so a native PTY or a forged
  // `opts.env` value cannot make an unenrolled spawn look durable. An explicit
  // empty value when the task-manager flag is OFF keeps the reserved name from
  // leaking a caller-supplied marker through this seam.
  const childEnv = { ...(opts.env ?? {}) };
  // These names are an authenticated operator→runner control seam, not caller
  // environment. Strip any supplied values first; on an unconfined fallback the
  // workload must not see even empty internal control fields.
  delete childEnv[SYSTEMD_RUNNER_OUTPUT_PATH_ENV];
  delete childEnv[SYSTEMD_RUNNER_REDACTIONS_ENV];
  Object.assign(childEnv, {
    [CAPABILITY_BASH_BACKGROUND_TASK_ID_ENV]: enrolment.enrolled ? enrolment.taskId : '',
    // EI-21434250273517260: the systemd-enrolled task is intentionally durable
    // across an operator-host restart. pc-heavy must keep its materializer
    // preemption policy, but must not mistake that old host PPID disappearing
    // for an orphaned workload and reap the still-authoritative task.
    [PC_HEAVY_DURABLE_CALLER_ENV]: enrolment.enrolled ? '1' : '',
  });
  if (runnerOwnsLog) {
    // EI-21437837415175286: systemd-run --pipe belongs to the restartable
    // operator host. Put the authoritative sink + redaction policy inside the
    // existing anonymous credential payload so the transient-service runner
    // keeps recording after that pipe reader disappears. The runner consumes
    // and deletes both fields before spawning the workload.
    childEnv[SYSTEMD_RUNNER_OUTPUT_PATH_ENV] = logPath;
    // WI-10003538: ship the SAME shape patterns so the restart-surviving log is
    // redacted identically to the live stream.
    childEnv[SYSTEMD_RUNNER_REDACTIONS_ENV] = Buffer.from(
      JSON.stringify({ values: opts.redactValues ?? [], patterns: CAPABILITY_OUTPUT_REDACTION_PATTERNS }),
      'utf8',
    ).toString(
      'base64',
    );
  }

  // EI-16635 / P-002: startBackground jobs are durable whether the caller asks
  // for immediate background return or waits through the bounded response
  // window, so the sandbox path (when enabled) must not die-with-parent.
  const child = spawnShell(
    opts.command,
    opts.cwd,
    childEnv,
    opts.sandboxEnabled,
    opts.sandboxRequired,
    true,
    enrolment.wrap,
    id,
    opts.sandboxBuildOpts,
  );
  // A service can finish before the job object and redactor are fully assembled.
  // Keep stdout/stderr flowing from the instant spawn returns, then replay the
  // tiny early prefix through the normal redaction/output path below.
  const earlyOutput: Array<{ stream: 'stdout' | 'stderr'; chunk: Buffer }> = [];
  const captureEarlyStdout = (b: Buffer): void => {
    earlyOutput.push({ stream: 'stdout', chunk: Buffer.from(b) });
  };
  const captureEarlyStderr = (b: Buffer): void => {
    earlyOutput.push({ stream: 'stderr', chunk: Buffer.from(b) });
  };
  child.stdout?.on('data', captureEarlyStdout);
  child.stderr?.on('data', captureEarlyStderr);
  const job: BashJob = {
    id,
    command: opts.command,
    cwd: opts.cwd,
    child,
    startedAt: Date.now(),
    endedAt: null,
    status: 'running',
    exitCode: null,
    buffer: '',
    totalBytes: 0,
    logPath,
    readCursor: 0,
    // The runner truncates exactly once, then owns command output + JOB END.
    // Keep only an O_APPEND stream here for operator-authored diagnostics such
    // as the preflight snapshot; appendOutput deliberately skips mirrored
    // command chunks while runnerOwnsLog is true.
    logStream: safeWriteStream(logPath, runnerOwnsLog ? 'a' : 'w'),
    responseStream: opts.onChunk,
    runnerOwnsLog,
    taskId: enrolment.taskId,
    scopeUnit: enrolment.scopeUnit,
    timeoutMs: effectiveTimeoutMs,
    deadlineAt: Date.now() + effectiveTimeoutMs,
  };
  JOBS.set(id, job);

  // The confined runner owns command bytes, while this append-only stream owns
  // operator diagnostics and the FINAL normalized marker. A runner marker can
  // already be present (and is the only marker after host-reader loss); when the
  // operator survives, its later marker supersedes the raw service verdict.
  const appendRunnerOwnedDiagnostic = (chunk: string): void => {
    if (!runnerOwnsLog || !chunk) return;
    try {
      job.logStream?.write(chunk);
    } catch {
      /* a spill-write fault must not crash the job */
    }
  };

  const redactor = createCapabilityOutputRedactor(opts.redactValues);
  const streamLineCap = opts.onChunk ? createStreamingLineCap() : null;
  const missingCommandDetector = createMissingCommandMarkerDetector(id);
  const preflightFailureDetector = createPreflightFailureMarkerDetector();
  // Decode each child stream incrementally so UTF-8 bytes split across data
  // events survive intact in retained output, stream callbacks, and spill logs.
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  let redactorFlushed = false;
  let streamLineCapFlushed = false;
  let preflightSnapshotWritten = false;
  const appendSafeOutput = (chunk: string): void => {
    if (!chunk) return;
    missingCommandDetector.push(chunk);
    appendOutput(job, chunk);
    const streamed = job.responseStream ? (streamLineCap?.push(chunk) ?? '') : '';
    if (streamed) job.responseStream?.(streamed);
    // The snapshot is deliberately log-only. Existing callers rely on the
    // in-memory output containing only the command's own bytes; attribution is
    // durable context for a later reader, not a second command result.
    if (preflightFailureDetector.push(chunk)) appendPreflightSnapshot();
  };
  const appendRawOutput = (chunk: string): void => appendSafeOutput(redactor?.push(chunk) ?? chunk);
  const flushRedactor = (): void => {
    if (redactorFlushed) return;
    redactorFlushed = true;
    const tail = redactor?.flush() ?? '';
    appendSafeOutput(tail);
  };
  const flushStreamLineCap = (): void => {
    if (streamLineCapFlushed) return;
    streamLineCapFlushed = true;
    const tail = job.responseStream ? (streamLineCap?.flush() ?? '') : '';
    if (tail) job.responseStream?.(tail);
  };

  const appendPreflightSnapshot = (): void => {
    if (preflightSnapshotWritten) return;
    const marker = preflightFailureDetector.seen();
    if (!marker) return;
    preflightSnapshotWritten = true;
    try {
      const snapshot = capturePreflightAttributionSnapshot({
        marker,
        pid: child.pid ?? null,
        jobCgroupPath: scopeCgroupPath,
        redactValues: opts.redactValues,
      });
      // Do not route this through appendOutput: the snapshot is diagnostic
      // garnish and must not alter totalBytes/readCursor or returned output.
      job.logStream?.write(formatPreflightAttributionSnapshot(snapshot));
    } catch {
      // A diagnostic failure must never change the command's terminal result.
      try {
        job.logStream?.write(
          `\n${PREFLIGHT_ATTRIBUTION_SNAPSHOT_PREFIX}: marker=${marker} unavailable (best-effort capture failed; not historical attribution)\n`,
        );
      } catch {
        /* the spill stream itself may already be closed */
      }
    }
  };

  // Attach before recording/enrolling the job. A transient service can execute
  // an immediate command and close before the later setup work yields; listeners
  // attached after that close lose its stdout/stderr entirely.
  const onStdoutData = (b: Buffer): void => appendRawOutput(stdoutDecoder.write(b));
  const onStderrData = (b: Buffer): void => appendRawOutput(stderrDecoder.write(b));
  child.stdout?.removeListener('data', captureEarlyStdout);
  child.stderr?.removeListener('data', captureEarlyStderr);
  child.stdout?.on('data', onStdoutData);
  child.stderr?.on('data', onStderrData);
  for (const { stream, chunk } of earlyOutput) {
    appendRawOutput((stream === 'stdout' ? stdoutDecoder : stderrDecoder).write(chunk));
  }

  completeSyncEnrolment(
    enrolment,
    {
      class: 'bash-job',
      // The command is the only honest title here, and it is what a human scanning
      // the pane will look for. Bounded so one pathological heredoc cannot bloat
      // every read of the table.
      title: opts.command.slice(0, 300),
      argv: ['bash', '-o', 'pipefail', '-c', opts.command],
      cwd: opts.cwd,
      launchedBy: opts.launchedBy ?? 'capability:bash',
      workItemId: opts.workItemId ?? null,
      planSlug: opts.planSlug ?? null,
      harnessSlug: opts.harnessSlug ?? null,
      sessionId: opts.sessionId ?? null,
      runtimeMaxSec,
      ...testBudget,
      logPath,
      detail: {
        bashJobId: id,
        sandboxed: Boolean(opts.sandboxEnabled),
        goalRef: opts.goalRef ?? null,
        workloadClass: isTestRun ? 'test-run' : 'other',
        budgetPolicy: isTestRun ? 'capability-bash-test-v1' : 'deadline-only-v1',
      },
    },
    child.pid ?? null,
  );

  const timer = setTimeout(() => {
    if (job.status !== 'running') return;
    job.status = 'timed_out';
    // WI-6677: SAY SO, in the job's own output. A silent death at a deadline the
    // caller never chose is indistinguishable from an OOM, a peer's pkill, or a
    // crash — and agents have burned real time hunting each of those. The line
    // lands in the spill log too, so it survives loss of the in-memory registry.
    //
    // EI-19315037905600226: a SECOND, narrower ambiguity hides inside "deadline
    // reached" itself — it does not say whether the job ever got to DO anything.
    // If the job's output never showed pc-heavy's slot-acquired marker, this
    // deadline is very likely a QUEUE timeout (killed waiting for a heavy-command
    // semaphore slot), not a real-work timeout — say so, whenever it's knowable.
    const neverAcquiredSlot = !job.buffer.includes(PC_HEAVY_SLOT_ACQUIRED_MARKER);
    const queuedHint = neverAcquiredSlot
      ? ` This job's output never showed pc-heavy's "slot acquired" marker — if it runs ` +
        `through scripts/pc-heavy.sh, it most likely died QUEUED on the heavy-command ` +
        `semaphore (see PC_HEAVY_TIMEOUT_SEC / host load) and never began real work, rather ` +
        `than timing out mid-execution. (If this job does not use pc-heavy.sh, disregard.)`
      : '';
    const deadlineDiagnostic =
      `\n[capability:bash] deadline reached: exceeded ${effectiveTimeoutMs}ms wall-clock.` +
      queuedHint +
      ` Sending SIGTERM (SIGKILL in ${TIMEOUT_SIGTERM_GRACE_MS}ms if it does not exit). ` +
      `For a longer job pass an explicit \`timeout\` (max ${MAX_BACKGROUND_TIMEOUT_MS}ms).\n`;
    appendRawOutput(deadlineDiagnostic);
    appendRunnerOwnedDiagnostic(deadlineDiagnostic);
    // SIGTERM first so the job's own trap/finally can clean up (temp trees,
    // checkouts, spawned sidecars). SIGKILL skips all of it, which is how a
    // timed-out job used to leak gigabytes.
    try {
      killJobProcessTree(job, 'SIGTERM');
    } catch {
      /* fall through to the SIGKILL escalation */
    }
    setTimeout(() => {
      // Liveness must be judged by `exitCode`, not `job.status` — the status was
      // flipped to 'timed_out' synchronously above, so testing it here would make
      // this escalation dead code. Same reasoning as killJob's grace timer below.
      if (job.exitCode === null) killJobProcessTree(job, 'SIGKILL');
    }, TIMEOUT_SIGTERM_GRACE_MS).unref();
  }, effectiveTimeoutMs);

  child.on('error', (err) => {
    const spawnDiagnostic = `\n[spawn error] ${err instanceof Error ? err.message : String(err)}\n`;
    appendRawOutput(spawnDiagnostic);
    appendRunnerOwnedDiagnostic(spawnDiagnostic);
    job.status = 'failed';
    job.endedAt = Date.now();
    clearTimeout(timer);
    appendRawOutput(stdoutDecoder.end());
    appendRawOutput(stderrDecoder.end());
    flushRedactor();
    flushStreamLineCap();
    job.responseStream = undefined;
    appendPreflightSnapshot();
    // EI-18764990059061608: see formatJobLogEndMarker's doc — this is what lets a
    // raw `cat`/Read of `logPath` (bypassing bash_output's own `status` field)
    // tell "finished" from "nothing written yet" without a second call.
    const terminalMarker = formatJobLogEndMarker(job.status, job.exitCode, job.endedAt);
    // The terminal marker is durable LOG metadata, not command output. Keeping
    // it out of the retained buffer preserves the ordinary-call result exactly
    // as command stdout+stderr while capability:bash_output reports terminal
    // status structurally.
    try {
      job.logStream?.write(terminalMarker);
    } catch {
      /* a spill-write fault must not affect the command result */
    }
    try {
      job.logStream?.end();
    } catch {
      /* ignore */
    }
    job.logStream = null;
    finishSyncEnrolment(
      enrolment,
      {
        state: 'exited',
        exitCode: null,
        exitReason: `spawn error: ${err instanceof Error ? err.message : String(err)}`,
      },
      { scopeCgroupPath },
    );
  });
  child.on('close', (code) => {
    if (job.status === 'running') {
      const sigpipeNormalized = normalizeExpectedSigpipeResult(opts.command, code === 0 ? 'completed' : 'failed', code);
      const ppidNormalized = normalizeExpectedPsPpidEmptyResult(
        opts.command,
        sigpipeNormalized.status,
        sigpipeNormalized.exitCode,
        job.buffer,
      );
      const normalized = normalizeExpectedRgNoMatchResult(
        opts.command,
        ppidNormalized.status,
        ppidNormalized.exitCode,
      );
      job.status = normalized.status;
      job.exitCode = normalized.exitCode;
    } else {
      job.exitCode = code;
    }
    job.endedAt = Date.now();
    clearTimeout(timer);
    const normalized = normalizeMissingCommandResult(job.status, job.exitCode, missingCommandDetector.seen());
    job.status = normalized.status;
    job.exitCode = normalized.exitCode;
    // Flush any incomplete UTF-8 bytes and redactor suffix before the attribution
    // block so the snapshot is guaranteed to follow all command output.
    appendRawOutput(stdoutDecoder.end());
    appendRawOutput(stderrDecoder.end());
    // Flush any redactor suffix before the attribution block so the snapshot
    // is guaranteed to precede the normal terminal marker in the durable log.
    flushRedactor();
    flushStreamLineCap();
    job.responseStream = undefined;
    appendPreflightSnapshot();
    // EI-18764990059061608: see formatJobLogEndMarker's doc.
    const terminalMarker = formatJobLogEndMarker(job.status, job.exitCode, job.endedAt);
    try {
      job.logStream?.write(terminalMarker);
    } catch {
      /* a spill-write fault must not affect the command result */
    }
    try {
      job.logStream?.end();
    } catch {
      /* ignore */
    }
    job.logStream = null;
    // `timed_out` is preserved distinctly rather than collapsed into a kill: the
    // ledger's job is to say WHY something ended, and "hit its own deadline" and
    // "someone killed it" are different answers to that.
    finishSyncEnrolment(
      enrolment,
      {
        state: job.status === 'timed_out' ? 'timed_out' : job.status === 'killed' ? 'killed' : 'exited',
        // The durable task ledger is the source behind `processes:list`, so it
        // must receive the same normalized verdict as the in-memory job and its
        // JOB END marker. A missing command hidden inside an otherwise-successful
        // pipeline has a child code of 0 but is normalized to failed/127 above;
        // recording the raw code made processes:list report a false green.
        exitCode: job.exitCode,
        exitReason: job.status === 'timed_out' ? `exceeded ${effectiveTimeoutMs}ms timeout` : null,
      },
      { scopeCgroupPath },
    );
  });

  return job;
}

export type BashJobResponseDisposition = 'terminal' | 'yielded';

/**
 * Wait only for the caller-facing response window. The execution deadline is
 * owned independently by {@link startBackground}; reaching this timer never
 * signals the job and therefore cannot restart, orphan, or kill it.
 *
 * A caller abort is different: it deliberately stops this SAME job through the
 * existing whole-tree kill path, then waits for the child close notification so
 * a returned terminal result does not race its cleanup.
 */
export function waitForJobResponse(
  job: BashJob,
  signal: AbortSignal,
  responseWindowMs: number,
): Promise<BashJobResponseDisposition> {
  if (job.endedAt !== null) {
    job.responseStream = undefined;
    return Promise.resolve('terminal');
  }

  return new Promise<BashJobResponseDisposition>((resolvePromise) => {
    let settled = false;
    let aborting = false;
    let abortFallback: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      clearTimeout(responseTimer);
      if (abortFallback) clearTimeout(abortFallback);
      signal.removeEventListener('abort', onAbort);
      job.child.removeListener('close', onTerminal);
      job.child.removeListener('error', onTerminal);
    };
    const finish = (disposition: BashJobResponseDisposition): void => {
      if (settled) return;
      settled = true;
      job.responseStream = undefined;
      cleanup();
      resolvePromise(disposition);
    };
    const onTerminal = (): void => finish('terminal');
    const onAbort = (): void => {
      if (aborting) return;
      aborting = true;
      job.responseStream = undefined;
      killJob(job);
      if (job.endedAt !== null) {
        finish('terminal');
        return;
      }
      // killJob escalates to SIGKILL after two seconds. This outer guard keeps a
      // pathological child from retaining a cancelled tool request forever.
      abortFallback = setTimeout(() => finish('terminal'), 5_000);
    };

    job.child.once('close', onTerminal);
    job.child.once('error', onTerminal);
    signal.addEventListener('abort', onAbort, { once: true });
    const responseTimer = setTimeout(
      () => {
        if (aborting) return;
        finish(job.endedAt === null ? 'yielded' : 'terminal');
      },
      Math.max(0, responseWindowMs),
    );

    // Close/abort can race listener registration. Re-read both after every
    // listener exists so neither edge can be lost.
    if (job.endedAt !== null) finish('terminal');
    else if (signal.aborted) onAbort();
  });
}

export function getJob(id: string): BashJob | undefined {
  return JOBS.get(id);
}

/** Read the new output since the last read; advances the cursor unless `peek`. */
export function readJobOutput(job: BashJob, peek = false): string {
  const chunk = job.buffer.slice(job.readCursor);
  if (!peek) job.readCursor = job.buffer.length;
  return chunk;
}

/** Snapshot the output/status currently observable for one durable job. */
export function snapshotJobResult(job: BashJob, peek = false): ForegroundResult {
  const chunk = readJobOutput(job, peek);
  const retainedBytes = Buffer.byteLength(job.buffer, 'utf8');
  const truncated = chunk.length > INLINE_OUTPUT_CAP || job.totalBytes > retainedBytes;
  return {
    status: job.status,
    exitCode: job.exitCode,
    output: chunk.length > INLINE_OUTPUT_CAP ? headTail(chunk) : chunk,
    totalBytes: job.totalBytes,
    truncated,
    logPath: job.logPath,
    durationMs: (job.endedAt ?? Date.now()) - job.startedAt,
  };
}

/** Kill a job's process (SIGTERM, then SIGKILL after a grace period). */
export function killJob(job: BashJob): { ok: boolean; alreadyDone: boolean } {
  if (job.status !== 'running') return { ok: true, alreadyDone: true };
  try {
    killJobProcessTree(job, 'SIGTERM');
  } catch {
    /* fallthrough to SIGKILL */
  }
  setTimeout(() => {
    // NOTE: `job.status` is flipped to 'killed' below, SYNCHRONOUSLY, right after
    // the SIGTERM is sent — well before the process has actually exited. That
    // flip reflects kill-INTENT (a caller checking status should see "killed" as
    // soon as the kill is requested), not actual process death, so it must NOT be
    // used to decide whether the SIGKILL escalation is still needed: checking
    // `job.status === 'running'` here is always false and would silently make
    // this fallback dead code, defeating the grace-period safety net for a
    // process that ignores/survives SIGTERM. `exitCode` is set only by the real
    // `close` handler once the OS confirms the process has actually terminated —
    // that is the correct liveness signal for this guard.
    if (job.exitCode === null) {
      try {
        killJobProcessTree(job, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }, 2_000);
  job.status = 'killed';
  return { ok: true, alreadyDone: false };
}

/** Drop the oldest FINISHED jobs once we exceed the retention cap. Running jobs
 *  are never evicted. */
function pruneFinished(): void {
  if (JOBS.size <= MAX_RETAINED_JOBS) return;
  const finished = [...JOBS.values()]
    .filter((j) => j.status !== 'running')
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  for (const j of finished) {
    if (JOBS.size <= MAX_RETAINED_JOBS) break;
    JOBS.delete(j.id);
  }
}

/** Test-only: clear the registry. */
export function __resetBashJobs(): void {
  for (const j of JOBS.values()) {
    try {
      j.child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    try {
      j.logStream?.end();
    } catch {
      /* ignore */
    }
  }
  JOBS.clear();
}

function headTail(s: string): string {
  const half = Math.floor(INLINE_OUTPUT_CAP / 2);
  const head = s.slice(0, half);
  const tail = s.slice(s.length - half);
  const omitted = s.length - head.length - tail.length;
  return `${head}\n\n… [${omitted} chars omitted — full output in the log file] …\n\n${tail}`;
}

/** Spill logs hold full command output: owner-only, like the durable runner's (WI-10003538). */
export const SPILL_LOG_MODE = 0o600;

function safeWriteStream(path: string, flags: 'w' | 'a' = 'w'): WriteStream | null {
  try {
    const stream = createWriteStream(path, { flags, mode: SPILL_LOG_MODE });
    // EI-18764990059061608's own test suite surfaced this: a stream with no
    // 'error' listener turns ANY write-time fault (ENOSPC, EBADF, or a write
    // racing an `end()` issued elsewhere — e.g. __resetBashJobs tearing down a
    // just-killed job whose 'close' handler fires a moment later) into an
    // UNCAUGHT exception that can crash the whole operator process over what is
    // only a best-effort spill log. Losing the tail of a log is far cheaper than
    // that.
    stream.on('error', () => {
      /* best-effort spill; a write/close fault here must never crash the process */
    });
    return stream;
  } catch {
    return null;
  }
}

function cryptoRandomId(): string {
  return crypto.randomUUID().slice(0, 12);
}
