/**
 * Plain-Node bridge for the TypeScript resource-governor execution seam.
 *
 * The two repository test CLIs are intentionally `.mjs` entrypoints: they are
 * also used by packaged installs where starting Node with a project-wide loader
 * is not an option.  Importing `execution.ts` directly from plain Node fails
 * because its internal imports are extensionless.  Load tsx only when a real
 * child is about to start, register the loader once, and keep the CLI itself
 * executable by `node scripts/*.mjs`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';

const EXECUTION_MODULE_URL = new URL(
  '../../packages/operator-core/lib/resource-governor/execution.ts',
  import.meta.url,
).href;
const WORKSPACE_MODULE_URL = new URL(
  '../../packages/operator-core/lib/workspace-registry.ts',
  import.meta.url,
).href;

let tsxRegistered = false;
let executionModulePromise = null;
let workspaceModulePromise = null;

/** Load the canonical TypeScript seam lazily, preserving direct Node CLI startup. */
export async function loadGovernedExecutionModule() {
  if (!executionModulePromise) {
    executionModulePromise = (async () => {
      const loader = await import('tsx/esm/api');
      if (!tsxRegistered) {
        // Keep the hook installed for the process lifetime.  Both runners can
        // admit several tasks concurrently, and unregistering after one import
        // would race a sibling's first import.
        loader.register();
        tsxRegistered = true;
      }
      return import(EXECUTION_MODULE_URL);
    })().catch((error) => {
      // A transient loader/module failure must be retryable on the next child,
      // rather than poisoning the process-local promise forever.
      executionModulePromise = null;
      throw error;
    });
  }
  return executionModulePromise;
}

async function loadWorkspaceModule() {
  if (!workspaceModulePromise) {
    workspaceModulePromise = loadGovernedExecutionModule()
      .then(() => import(WORKSPACE_MODULE_URL))
      .catch((error) => {
        workspaceModulePromise = null;
        throw error;
      });
  }
  return workspaceModulePromise;
}

/** Test-only cache reset; no production caller needs to unload the loader. */
export function resetGovernedTestProcessLoaderForTests() {
  executionModulePromise = null;
  workspaceModulePromise = null;
}

/** Resolve a concrete workspace without silently inventing a tenant. */
export async function resolveGovernedWorkspaceId(value, env = process.env) {
  const explicit = typeof value === 'string' ? value.trim() : '';
  if (explicit) return explicit;
  const ambient = String(env.PAPERCUSP_WORKSPACE_ID ?? env.PAPERCUSP_WORKSPACE ?? '').trim();
  if (ambient) return ambient;
  const registry = await loadWorkspaceModule();
  const resolved = String(registry.activeWorkspaceId?.() ?? '').trim();
  if (!resolved) throw new Error('resource-governor workspace id could not be resolved');
  return resolved;
}

/**
 * Stable, bounded idempotency identity for one resident test process.
 * @param {string} [scope]
 * @param {string} [identity]
 */
export function governedProcessIdempotencyKey(scope = 'test', identity = randomUUID()) {
  const label = String(scope).trim().replace(/[^A-Za-z0-9._:-]+/g, '_').slice(0, 72) || 'test';
  const digest = createHash('sha256').update(`${label}\0${String(identity)}`).digest('hex').slice(0, 40);
  return `test-process:${label}:${digest}`;
}

export const GOVERNED_TEST_PROCESS_DEFAULT_MEMORY_BYTES = 1024 * 1024 * 1024;
export const GOVERNED_TEST_PROCESS_DEFAULT_DISK_BYTES = 256 * 1024 * 1024;
export const GOVERNED_TEST_PROCESS_DEFAULT_FILE_DESCRIPTORS = 16;
export const GOVERNED_TEST_PROCESS_SAMPLE_INTERVAL_MS = 250;

/** Build a process reservation; measured peak values replace it at settlement. */
export function buildGovernedProcessDemand(options = {}) {
  const fileCount = Number.isFinite(options.fileCount)
    ? Math.max(1, Math.floor(options.fileCount))
    : 1;
  const memoryBytes = Number.isFinite(options.memoryBytes) && options.memoryBytes > 0
    ? Math.floor(options.memoryBytes)
    : GOVERNED_TEST_PROCESS_DEFAULT_MEMORY_BYTES;
  const diskBytes = Number.isFinite(options.diskBytes) && options.diskBytes > 0
    ? Math.floor(options.diskBytes)
    : GOVERNED_TEST_PROCESS_DEFAULT_DISK_BYTES;
  const fileDescriptors = Number.isFinite(options.fileDescriptors) && options.fileDescriptors > 0
    ? Math.floor(options.fileDescriptors)
    : GOVERNED_TEST_PROCESS_DEFAULT_FILE_DESCRIPTORS + fileCount;
  return {
    cpuWeight: Number.isFinite(options.cpuWeight) && options.cpuWeight >= 0 ? options.cpuWeight : 1,
    memoryBytes,
    diskBytes,
    fileDescriptors,
  };
}

function procField(text, field) {
  const match = new RegExp(`^${field}:\\s+([0-9]+)\\s*(?:kB)?$`, 'm').exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function procStatus(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/status`, 'utf8');
    const parent = procField(text, 'PPid');
    const rssKb = procField(text, 'VmHWM') ?? procField(text, 'VmRSS');
    return {
      parentPid: parent == null ? null : Math.floor(parent),
      rssBytes: rssKb == null ? null : rssKb * 1024,
    };
  } catch {
    return null;
  }
}

function procCpuMicros(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = text.lastIndexOf(')');
    if (commandEnd < 0) return null;
    const fields = text.slice(commandEnd + 2).trim().split(/\s+/);
    const user = Number(fields[11]);
    const system = Number(fields[12]);
    if (!Number.isFinite(user) || !Number.isFinite(system)) return null;
    // Linux's normal user-HZ is 100.  This is a relative delta, so retaining
    // the historical conversion is sufficient even on a non-standard host.
    return (user + system) * 10_000;
  } catch {
    return null;
  }
}

/**
 * Above this many pids the per-pid children walk stops paying for itself (measured 2026-10-01:
 * 390-620 ms on 1,600-3,850-pid churning trees, more than the host-wide scan), so the walk
 * hands over to the scan.  Test trees are a handful of pids.
 */
export const GOVERNED_PROCESS_TREE_WALK_PID_CAP = 512;

/**
 * Children of one pid from its threads' `/proc/<pid>/task/<tid>/children` files.  Returns
 * null when the kernel lacks CONFIG_PROC_CHILDREN, so the caller falls back to the scan;
 * an exited pid reads as childless, exactly as the scan would see it.
 */
function procChildPids(pid) {
  let tids;
  try {
    tids = readdirSync(`/proc/${pid}/task`);
  } catch {
    return [];
  }
  const children = [];
  for (const tid of tids) {
    let text;
    try {
      text = readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT' && tid === String(pid)) {
        // The leader's task dir exists for as long as the pid does, so ENOENT on its children
        // file means the file is unsupported, unless the pid exited in between.
        try {
          readdirSync(`/proc/${pid}/task`);
        } catch {
          return children;
        }
        return null;
      }
      continue; // A thread exited between readdir and read.
    }
    for (const token of text.split(/\s+/)) {
      if (/^\d+$/.test(token)) children.push(Number(token));
    }
  }
  return children;
}

/** The host-wide scan: one /proc/<pid>/status read per pid on the box, then a PPid join. */
function scanProcessTreePids(rootPid) {
  const children = new Map();
  let entries;
  try {
    // Names only: `withFileTypes` lstat()s entries, and a pid exiting mid-scan
    // then throws ENOENT for the whole listing, collapsing the tree to its root
    // (EI-24661719545676832). procStatus() rejects any non-pid name below.
    entries = readdirSync('/proc');
  } catch {
    return [rootPid];
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const status = procStatus(pid);
    if (status?.parentPid == null) continue;
    const siblings = children.get(status.parentPid) ?? [];
    siblings.push(pid);
    children.set(status.parentPid, siblings);
  }
  const result = [rootPid];
  for (let index = 0; index < result.length; index += 1) {
    for (const pid of children.get(result[index]) ?? []) {
      if (!result.includes(pid)) result.push(pid);
    }
  }
  return result;
}

/** Breadth-first walk of ONE tree through its children files; null hands over to the scan. */
function walkProcessTreePids(rootPid, pidCap, readChildren) {
  const result = [rootPid];
  const seen = new Set(result);
  for (let index = 0; index < result.length; index += 1) {
    const children = readChildren(result[index]);
    if (children == null) return null;
    for (const pid of children) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      result.push(pid);
    }
    if (result.length > pidCap) return null;
  }
  return result;
}

/**
 * The pids of one process tree, root first, and how they were found.  WI-10004924: the scan reads
 * /proc/<pid>/status for every pid on the host (~9.5k here, ~310 ms CPU per call) to find a few
 * descendants, and the 250 ms sampler re-ran it back to back, burning ~0.5 core per test run.  The
 * walk reads only the tree (0.3 ms on a 6-pid tree).  The scan stays as the fallback when the
 * kernel lacks per-task children files or the tree outgrows the walk.  `method: 'scan'` forces it.
 */
export function resolveGovernedProcessTree(
  rootPid,
  { method = 'auto', pidCap = GOVERNED_PROCESS_TREE_WALK_PID_CAP, readChildren = procChildPids } = {},
) {
  if (process.platform !== 'linux' || !Number.isInteger(rootPid) || rootPid <= 0) {
    return { pids: [rootPid], method: 'none' };
  }
  if (method !== 'scan') {
    const walked = walkProcessTreePids(rootPid, pidCap, readChildren);
    if (walked != null) return { pids: walked, method: 'walk' };
  }
  return { pids: scanProcessTreePids(rootPid), method: 'scan' };
}

function processTreePids(rootPid) {
  return resolveGovernedProcessTree(rootPid).pids;
}

/** Fail-soft aggregate resource snapshot for one child process tree. */
export function readGovernedProcessResourceSnapshot(pid) {
  const pids = processTreePids(pid);
  let cpuMicros = 0;
  let rssBytes = 0;
  let fileDescriptors = 0;
  let cpuMeasured = false;
  let rssMeasured = false;
  let fdMeasured = false;
  for (const childPid of pids) {
    const cpu = procCpuMicros(childPid);
    if (cpu != null) {
      cpuMicros += cpu;
      cpuMeasured = true;
    }
    const status = procStatus(childPid);
    if (status?.rssBytes != null) {
      rssBytes += status.rssBytes;
      rssMeasured = true;
    }
    if (process.platform === 'linux') {
      try {
        fileDescriptors += readdirSync(`/proc/${childPid}/fd`).length;
        fdMeasured = true;
      } catch {
        // The process may exit between status and fd reads.
      }
    }
  }
  return {
    cpuMicros: cpuMeasured ? cpuMicros : null,
    rssBytes: rssMeasured ? rssBytes : null,
    fileDescriptors: fdMeasured ? fileDescriptors : null,
  };
}

/**
 * Sample peak process residency while a child is alive.  The reader and clock
 * are injectable so the accounting contract is testable without procfs.
 */
export function createGovernedProcessDemandSampler(
  planned,
  { readSnapshot = readGovernedProcessResourceSnapshot, intervalMs = GOVERNED_TEST_PROCESS_SAMPLE_INTERVAL_MS, now = Date.now } = {},
) {
  let pid = null;
  let timer = null;
  let stopped = false;
  let peakRss = null;
  let peakFds = null;
  let firstCpu = null;
  let lastCpu = null;
  let firstAt = null;
  let lastAt = null;
  let cpuWeight = null;
  let stoppedDemand = null;

  const scheduleNextSample = () => {
    if (stopped || pid == null) return;
    // Do not use setInterval here. `readGovernedProcessResourceSnapshot` is
    // synchronous and scans procfs; on a busy host one sample can take as long
    // as (or longer than) the nominal interval. A fixed interval then keeps the
    // timer continuously due, monopolizes this runner's event loop, and can
    // starve the watchdog that is meant to reap a wedged Vitest process.
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      sample();
      scheduleNextSample();
    }, intervalMs);
    timer.unref?.();
  };

  const sample = () => {
    if (stopped || pid == null) return;
    let snapshot;
    try {
      snapshot = readSnapshot(pid);
    } catch {
      return;
    }
    const at = now();
    if (Number.isFinite(snapshot?.rssBytes)) peakRss = peakRss == null ? snapshot.rssBytes : Math.max(peakRss, snapshot.rssBytes);
    if (Number.isFinite(snapshot?.fileDescriptors)) peakFds = peakFds == null ? snapshot.fileDescriptors : Math.max(peakFds, snapshot.fileDescriptors);
    if (Number.isFinite(snapshot?.cpuMicros)) {
      if (firstCpu == null) {
        firstCpu = snapshot.cpuMicros;
        firstAt = at;
      }
      lastCpu = snapshot.cpuMicros;
      lastAt = at;
      if (firstAt != null && lastAt > firstAt && firstCpu != null && lastCpu != null) {
        cpuWeight = Math.max(0.01, (lastCpu - firstCpu) / ((lastAt - firstAt) * 1_000));
      }
    }
  };

  return {
    attach(nextPid) {
      if (stopped || !Number.isInteger(nextPid) || nextPid <= 0) return;
      pid = nextPid;
      sample();
      scheduleNextSample();
    },
    sample,
    stop(extra = {}) {
      if (stoppedDemand) return stoppedDemand;
      if (!stopped) sample();
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      stoppedDemand = {
        cpuWeight: extra.cpuWeight ?? cpuWeight ?? planned?.cpuWeight ?? 1,
        memoryBytes: extra.memoryBytes ?? peakRss ?? planned?.memoryBytes,
        diskBytes: extra.diskBytes ?? planned?.diskBytes,
        fileDescriptors: extra.fileDescriptors ?? peakFds ?? planned?.fileDescriptors,
      };
      return stoppedDemand;
    },
  };
}

/** Classify whether a child produced a trustworthy test verdict. */
export function classifyGovernedTestProcessOutcome(outcome = {}) {
  const output = `${outcome.stdout ?? ''}\n${outcome.stderr ?? ''}\n${outcome.output ?? ''}`;
  const timedOut = outcome.timedOut === true || outcome.__watchdogTimedOut === true || outcome.watchdogTimedOut === true;
  if (timedOut) return { kind: 'cancel', reason: 'test process timed out before a verdict was produced' };
  if (outcome.aborted === true) return { kind: 'cancel', reason: 'test process was aborted before a verdict was produced' };
  if (outcome.spawnError || outcome.__spawnError) {
    return { kind: 'cancel', reason: `test process spawn failed: ${outcome.spawnError ?? outcome.__spawnError}` };
  }
  const code = outcome.code ?? outcome.status ?? null;
  const signal = outcome.signal ?? null;
  if (outcome.error && (code == null || code < 0 || output.trim() === '')) {
    return { kind: 'cancel', reason: `test process failed to start: ${outcome.error.message ?? outcome.error}` };
  }
  if (/TEST_FILE_WATCHDOG|TEST_FILE_ROUTE_ERROR|worker\s+(?:exited|crash)|TasksMax|SIG(?:TERM|KILL)/i.test(output)) {
    return { kind: 'cancel', reason: 'test worker/route exited without a trustworthy verdict' };
  }
  if (code == null || signal) {
    return {
      kind: 'cancel',
      reason: `test process exited without a trustworthy verdict (code=${code ?? 'null'} signal=${signal ?? 'none'})`,
    };
  }
  return { kind: 'release', actualDemand: outcome.actualDemand };
}

/** Add a typed lineage context to a child environment. */
export function withGovernedAdmissionContext(env, context) {
  return { ...env, PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify(context) };
}

/**
 * PG contention codes `pg-bounded-txn.ts` raises as `OrgTxnTimeoutError`, whose own
 * message ends "— retry shortly".  55P03 = lock_timeout waiting on a row/advisory lock,
 * 57014 = statement_timeout.  Both mean "the database was busy", never "your work is
 * wrong".  postgres.js can also reject the admission client with a transport lifecycle
 * code (`CONNECTION_ENDED` or `CONNECTION_DESTROYED`) while PgBouncer is replacing a
 * dead connection; that is the same transient pre-launch condition and is safe to retry.
 * Until these cases are handled at this seam, the rejection is flattened into
 * `GOVERNED_ADMISSION_FAILED` and rendered as `could not launch Vitest`, so a transient
 * database condition is reported as a Vitest launch failure over a run that measured
 * nothing.
 */
const RETRYABLE_ADMISSION_PG_CODES = new Set(['55P03', '57014']);
const RETRYABLE_ADMISSION_CONNECTION_CODES = new Set(['CONNECTION_ENDED', 'CONNECTION_DESTROYED']);
const DEFAULT_ADMISSION_RETRY_ATTEMPTS = 3;
const DEFAULT_ADMISSION_RETRY_BASE_MS = 250;
/** Emitted on every retry so fleet-wide DB contention stays VISIBLE. */
export const GOVERNED_ADMISSION_RETRY_MARKER = 'GOVERNED_ADMISSION_RETRY';

/**
 * Is this admission rejection one the database itself told us to retry?
 *
 * Detected by PROPERTY, never `instanceof`: this repo's module graph can legitimately
 * produce two copies of a class (tsx's CJS preflight beside the ESM loader, a symlinked
 * `node_modules/@papercusp/*`, a bundled copy beside source), and an `instanceof` check
 * silently answers false across that split — failing closed in the direction that looks
 * like "not retryable", which is indistinguishable from the bug being unfixed.
 *
 * The `cause` chain is walked to a bounded depth because the governor may wrap the
 * originating PG error rather than rethrowing it; the depth bound keeps a cyclic or
 * pathologically deep chain from turning this predicate into a hang.
 */
export function isRetryableAdmissionFailure(error, maxDepth = 4) {
  for (let node = error, depth = 0; node && typeof node === 'object' && depth <= maxDepth; depth++) {
    if (retryableAdmissionCode(node)) return true;
    node = node.cause;
  }
  return false;
}

/**
 * Run a child behind one durable process receipt.  A valid inherited context
 * means the caller already owns the resident process receipt, so no second
 * admission is created; the same typed context is simply forwarded.
 *
 * The callback receives `(context, childEnv, { inherited })` and must resolve
 * only after the child lifetime has ended.  That keeps the lease alive through
 * the actual process, rather than releasing it immediately after `spawn()`.
 *
 * A retryable ADMISSION failure (see `isRetryableAdmissionFailure`) is retried with
 * bounded exponential backoff.  ⛔ THE CONSTRAINT THAT MAKES THIS SAFE, and the reason
 * it is not simply `catch { retry }`: only a failure from BEFORE the child started may
 * be retried.  `started` flips the instant the callback is entered, which happens only
 * after admission has succeeded — so a rejection carrying `started === true` arrived at
 * or after child launch, and retrying it would RE-RUN TESTS.  That case rethrows
 * immediately regardless of how retryable the error looks.
 */
export async function runGovernedTestProcess(options, run) {
  if (!options || typeof options !== 'object') throw new Error('governed test process options are required');
  if (typeof run !== 'function') throw new Error('governed test process callback is required');
  const env = { ...(options.env ?? process.env) };
  const api = options.executionApi ?? await loadGovernedExecutionModule();
  const inherited = api.admissionContextFromEnvironment?.(env.PAPERCUSP_ADMISSION_CONTEXT);
  if (inherited) {
    return run(inherited, withGovernedAdmissionContext(env, inherited), { inherited: true });
  }

  const workspaceId = await resolveGovernedWorkspaceId(options.workspaceId, env);
  const timeoutMs = options.timeoutMs;
  const leaseTtlMs = options.leaseTtlMs ?? api.governedExecutionLeaseTtlForTimeout?.(timeoutMs);
  const operation = {
    workspaceId,
    namespace: options.namespace ?? 'test-process',
    owner: options.owner,
    admissionClass: options.admissionClass ?? 'process',
    demand: options.demand ?? { cpuWeight: 1 },
    idempotencyKey: options.idempotencyKey ?? governedProcessIdempotencyKey(options.owner),
    // WI-638180: every caller of this bridge is a one-shot CLI (`test-files.mjs`,
    // `affected-tests.mjs`). A top-level admission on the process-wide `getOrgPg()`
    // pool leaves PgBouncer sockets nothing can close, so the runner completes all
    // of its work and then never exits — indistinguishable, to a supervisor, from a
    // wedged test run. Ask for a dedicated client that closes on settlement instead.
    // `dedicatedClient: false` opts a long-lived embedder back onto the shared pool.
    dedicatedClient: options.dedicatedClient !== false,
    ...(options.payloadRef ? { payloadRef: options.payloadRef } : {}),
    ...(options.parent ? { parent: options.parent } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
    ...(leaseTtlMs != null ? { leaseTtlMs } : {}),
    ...(options.settle ? { settle: options.settle } : {}),
    ...(options.measureActualDemand ? { measureActualDemand: options.measureActualDemand } : {}),
  };
  const maxAttempts = Math.max(1, options.admissionRetryAttempts ?? DEFAULT_ADMISSION_RETRY_ATTEMPTS);
  const backoffBaseMs = options.admissionRetryBaseMs ?? DEFAULT_ADMISSION_RETRY_BASE_MS;
  // Injected in tests so a bounded-retry assertion costs no wall-clock, and so the
  // retry path can be exercised without a real governor or a real database.
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((line) => console.error(line));

  for (let attempt = 1; ; attempt++) {
    // Scoped PER ATTEMPT, not per call: a later attempt must judge its own launch, not
    // inherit a previous one's.
    let started = false;
    try {
      return await api.runGovernedOperation(operation, (context) => {
        started = true;
        return run(context, withGovernedAdmissionContext(env, context), { inherited: false });
      });
    } catch (error) {
      // `started` first: a post-launch failure is never retried, however retryable the
      // error looks. Re-running tests is a worse outcome than surfacing the error.
      if (started || attempt >= maxAttempts || !isRetryableAdmissionFailure(error)) throw error;
      const delayMs = backoffBaseMs * 2 ** (attempt - 1);
      // A silent retry would hide fleet-wide DB contention — real signal about the box,
      // and an invisible mitigation is how a degradation becomes permanent.
      log(
        `${GOVERNED_ADMISSION_RETRY_MARKER} attempt=${attempt + 1}/${maxAttempts} ` +
          `pgCode=${admissionFailureCode(error) ?? 'unknown'} delayMs=${delayMs} ` +
          `owner=${options.owner ?? 'unknown'}`,
      );
      await sleep(delayMs);
    }
  }
}

/** Execute a finite byte-input diagnostic under the existing process lifecycle.
 * The child starts only after admission, receives its typed context, and keeps
 * the receipt until execFile has observed exit and pipe EOF. Output and input
 * stay in memory; callers persist only their own redacted diagnostics.
 * @param {string} executable
 * @param {string[]} args
 * @param {Uint8Array} input
 * @param {{ timeoutMs: number, maxBuffer: number, namespace: string, workspaceId?: string, owner?: string, env?: NodeJS.ProcessEnv, executionApi?: any }} options
 * @returns {Promise<{status: number|null, signal: NodeJS.Signals|null, stdout: string, stderr: string, error?: {code: string}, actualDemand: any}>}
 */
export function selectGovernedByteProcessFailure(execError, inputError, inputByteLength, exitCode) {
  if (execError) return execError;
  // A command that consumes no input may close stdin before the empty write
  // finishes. Its EPIPE says nothing about a successful child result.
  if (inputByteLength === 0 && exitCode === 0 && inputError?.code === 'EPIPE') return undefined;
  return inputError;
}

export async function executeGovernedByteProcess(executable, args, input, options) {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 ||
      !Number.isSafeInteger(options.maxBuffer) || options.maxBuffer < 1)
    throw new TypeError('Native diagnostic requires finite timeout and output bounds');
  const demand = { cpuWeight: 1,
    memoryBytes: Math.max(GOVERNED_TEST_PROCESS_DEFAULT_MEMORY_BYTES, input.byteLength + options.maxBuffer),
    fileDescriptors: 3 };
  return runGovernedTestProcess({
    ...options, demand,
    owner: options.owner ?? process.env.PAPERCUSP_SID ?? `native-diagnostic:${process.pid}`,
    settle: result => result.error || result.status !== 0
      ? { kind: 'cancel', reason: 'native diagnostic did not complete successfully' }
      : { kind: 'release', actualDemand: result.actualDemand },
  }, async (_context, childEnv) => await new Promise(resolveResult => {
    const sampler = createGovernedProcessDemandSampler(demand);
    let inputError;
    const child = execFile(executable, args, {
      env: childEnv, encoding: 'utf8', timeout: options.timeoutMs, maxBuffer: options.maxBuffer,
    }, (error, stdout, stderr) => {
      const failure = selectGovernedByteProcessFailure(error, inputError, input.byteLength, child.exitCode);
      resolveResult({ status: child.exitCode, signal: child.signalCode, stdout, stderr,
        error: failure && typeof failure.code === 'string' ? { code: failure.code } : undefined,
        actualDemand: sampler.stop() });
    });
    sampler.attach(child.pid);
    child.stdin?.on('error', error => { inputError = error; });
    child.stdin?.end(input);
  }));
}

/** The contention code that made a rejection retryable, for the retry marker. */
function retryableAdmissionCode(node) {
  if (typeof node.pgCode === 'string' && RETRYABLE_ADMISSION_PG_CODES.has(node.pgCode)) return node.pgCode;
  if (typeof node.code === 'string' && RETRYABLE_ADMISSION_CONNECTION_CODES.has(node.code)) return node.code;
  if (typeof node.message === 'string') {
    const match = /\b(CONNECTION_ENDED|CONNECTION_DESTROYED)\b/.exec(node.message);
    if (match) return match[1];
  }
  return null;
}

function admissionFailureCode(error, maxDepth = 4) {
  for (let node = error, depth = 0; node && typeof node === 'object' && depth <= maxDepth; depth++) {
    const code = retryableAdmissionCode(node);
    if (code) return code;
    node = node.cause;
  }
  return null;
}
