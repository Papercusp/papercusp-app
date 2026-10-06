/** Linux-only, bounded diagnostic for THIS WDIO driver's packaged app subtree.
 * schedstat counters are ns, not ticks; the main task is sampled explicitly.
 * https://docs.kernel.org/scheduler/sched-stats.html#proc-pid-schedstat
 * This identifies CPU/runqueue/sleep intervals, never JavaScript call stacks. */
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  linuxPpidFromProcStat, linuxProcessIdentityFromStat, linuxProcStateFromStat,
  readProcessIdentity,
} from '../../../packages/operator-core/lib/process-identity';

interface ProcReader {
  read(file: string): string;
  readBounded?(file: string, maxBytes: number): string;
  list(file: string): string[];
  link(file: string): string;
}
const liveProc: ProcReader = {
  read: (file) => readFileSync(file, 'utf8'),
  readBounded: (file, maxBytes) => {
    const fd = openSync(file, 'r');
    try {
      const data = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < data.length) {
        const bytes = readSync(fd, data, length, data.length - length, null);
        if (!bytes) return data.subarray(0, length).toString('utf8');
        length += bytes;
      }
      throw new Error('Native environment exceeds byte bound');
    } finally { closeSync(fd); }
  },
  list: (file) => readdirSync(file),
  link: (file) => readlinkSync(file),
};
export interface NativeProbeOptions {
  driverPid: number;
  driverIdentity: string;
  appPath: string;
  stacks?: boolean;
  stackDelayMs?: number;
  environment?: boolean;
  outputDescriptors?: boolean;
  debugFile?: string;
}

const MAX_TRACKED_IDENTITIES = 64;
interface PreviouslyOwnedProcess {
  pid: number;
  identity: string;
  kind: 'app' | 'webkit';
  appPid: number;
  appIdentity: string;
  readCompletedEpochMs: number;
}

/** Check only identities already observed in the owned subtree. A missing proc
 * entry cannot establish an exit signal or a wait/reaping receipt: these targets
 * are not children of this sampler. Do not rediscover by executable/name. */
function observeMissingOwnedProcess(target: PreviouslyOwnedProcess, boot: string,
  discoveryIncomplete: boolean, proc: ProcReader) {
  const readStartedEpochMs = Date.now();
  type StatRead = { status: 'captured'; stat: string } | { status: 'missing' | 'unavailable' };
  const read = (): StatRead => {
    try {
      const file = `/proc/${target.pid}/stat`;
      const stat = proc.readBounded ? proc.readBounded(file, 4096) : proc.read(file);
      return Buffer.byteLength(stat) <= 4096 ? { status: 'captured', stat } : { status: 'unavailable' };
    } catch (error) {
      return { status: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unavailable' };
    }
  };
  let status: 'procfs-missing' | 'identity-replaced' | 'same-identity-present' | 'zombie' | 'unavailable' = 'unavailable';
  let state: string | null = null;
  let parentPid: number | null = null;
  try {
    const before = read();
    const after = read();
    if (proc.read('/proc/sys/kernel/random/boot_id').trim() === boot) {
      if (before.status === 'missing' && after.status === 'missing') status = 'procfs-missing';
      else if (before.status === 'captured' && after.status === 'captured') {
        const beforeIdentity = linuxProcessIdentityFromStat(boot, before.stat);
        const afterIdentity = linuxProcessIdentityFromStat(boot, after.stat);
        if (beforeIdentity && beforeIdentity === afterIdentity) {
          if (afterIdentity !== target.identity) status = 'identity-replaced';
          else {
            state = linuxProcStateFromStat(after.stat);
            parentPid = linuxPpidFromProcStat(after.stat);
            if (state !== null && parentPid !== null) status = state === 'Z' ? 'zombie' : 'same-identity-present';
            else { state = null; parentPid = null; }
          }
        }
      }
    }
  } catch { /* Unknown read/reboot evidence stays unavailable; never serialize raw errors. */ }
  return { pid: target.pid, identity: target.identity, kind: target.kind,
    appPid: target.appPid, appIdentity: target.appIdentity,
    lastOwnedReadCompletedEpochMs: target.readCompletedEpochMs,
    readStartedEpochMs, readCompletedEpochMs: Date.now(), discoveryIncomplete,
    status, state, parentPid, signal: null, exitCode: null,
    reaping: status === 'zombie' ? 'not-reaped' as const : 'unknown' as const };
}

// Exact keys, never a prefix allowlist or an inherited process.env snapshot.
const ENVIRONMENT_KEYS = ['GST_REGISTRY', 'GST_REGISTRY_1_0', 'GST_REGISTRY_UPDATE',
  'GST_REGISTRY_FORK', 'GST_PLUGIN_PATH', 'GST_PLUGIN_PATH_1_0',
  'GST_PLUGIN_SYSTEM_PATH', 'GST_PLUGIN_SYSTEM_PATH_1_0', 'GST_PLUGIN_SCANNER',
  'GST_PLUGIN_SCANNER_1_0', 'GST_DEBUG', 'GST_DEBUG_FILE', 'XDG_CACHE_HOME'] as const;
const MAX_ENVIRONMENT_BYTES = 128 * 1024;
const MAX_ENVIRONMENT_VALUE_BYTES = 4096;
type EnvironmentKey = typeof ENVIRONMENT_KEYS[number];
type NativeEnvironment = { readStartedEpochMs: number; readCompletedEpochMs: number } & (
  { status: 'captured'; values: Record<EnvironmentKey,
    { status: 'present'; value: string } | { status: 'absent' }> } |
  { status: 'unavailable'; reason: 'read-failed' | 'invalid-or-oversized' }
);

function readNativeEnvironment(pid: number, proc: ProcReader): NativeEnvironment {
  const readStartedEpochMs = Date.now();
  const timing = () => ({ readStartedEpochMs, readCompletedEpochMs: Date.now() });
  let raw: string;
  try {
    const file = `/proc/${pid}/environ`;
    raw = proc.readBounded ? proc.readBounded(file, MAX_ENVIRONMENT_BYTES) : proc.read(file);
  } catch {
    // A proc reader's error may contain raw environment data; do not serialize it.
    return { ...timing(), status: 'unavailable', reason: 'read-failed' };
  }
  if (Buffer.byteLength(raw) > MAX_ENVIRONMENT_BYTES || (raw && !raw.endsWith('\0'))) {
    return { ...timing(), status: 'unavailable', reason: 'invalid-or-oversized' };
  }
  const values = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, { status: 'absent' }])) as
    Extract<NativeEnvironment, { status: 'captured' }>['values'];
  for (const entry of raw.split('\0')) {
    const separator = entry.indexOf('=');
    const key = entry.slice(0, separator) as EnvironmentKey;
    if (separator < 0 || !ENVIRONMENT_KEYS.includes(key)) continue;
    const value = entry.slice(separator + 1);
    if (values[key].status !== 'absent' || Buffer.byteLength(value) > MAX_ENVIRONMENT_VALUE_BYTES) {
      return { ...timing(), status: 'unavailable', reason: 'invalid-or-oversized' };
    }
    values[key] = { status: 'present', value };
  }
  return { ...timing(), status: 'captured', values };
}

const MAX_DESCRIPTOR_BYTES = 4096;
const MAX_DEBUG_FILE_DESCRIPTORS = 256;
type NativeOutputDescriptor = { fd: number } & (
  { status: 'captured'; target: string; inode: string; mountId: string; flags: string; position: string } |
  { status: 'unavailable'; reason: 'read-failed' | 'invalid-or-oversized' | 'descriptor-changed' }
);

function readOutputDescriptor(pid: number, fd: number, proc: ProcReader): NativeOutputDescriptor {
  const base = `/proc/${pid}`;
  const readInfo = () => {
    const file = `${base}/fdinfo/${fd}`;
    const raw = proc.readBounded ? proc.readBounded(file, MAX_DESCRIPTOR_BYTES) : proc.read(file);
    if (Buffer.byteLength(raw) > MAX_DESCRIPTOR_BYTES) throw new RangeError();
    const values: Record<string, string> = {};
    for (const key of ['pos', 'flags', 'mnt_id', 'ino']) {
      const matches = [...raw.matchAll(new RegExp(`^${key}:\\s*([0-9]+)\\s*$`, 'gm'))];
      if (matches.length !== 1) throw new RangeError();
      values[key] = matches[0][1];
    }
    if (!/^[0-7]+$/.test(values.flags)) throw new RangeError();
    return values;
  };
  try {
    const target = proc.link(`${base}/fd/${fd}`);
    if (!target || Buffer.byteLength(target) > MAX_DESCRIPTOR_BYTES) throw new RangeError();
    const before = readInfo();
    const after = readInfo();
    if (proc.link(`${base}/fd/${fd}`) !== target ||
        ['ino', 'mnt_id', 'flags'].some((key) => before[key] !== after[key])) {
      return { fd, status: 'unavailable', reason: 'descriptor-changed' };
    }
    // Position may advance while the target writes; preserve the later observation.
    return { fd, status: 'captured', target, inode: after.ino, mountId: after.mnt_id,
      flags: after.flags, position: after.pos };
  } catch (error) {
    return { fd, status: 'unavailable',
      reason: error instanceof RangeError ? 'invalid-or-oversized' : 'read-failed' };
  }
}

function readNativeOutput(pid: number, debugFile: string | undefined, proc: ProcReader) {
  const readStartedEpochMs = Date.now();
  const descriptors = [1, 2].map((fd) => readOutputDescriptor(pid, fd, proc));
  let debugFileStatus: 'not-requested' | 'captured' | 'not-open' | 'unavailable' = 'not-requested';
  if (debugFile && debugFile !== '-') {
    debugFileStatus = 'unavailable';
    try {
      // Match only the explicitly requested path; do not serialize unrelated targets.
      if (!path.isAbsolute(debugFile) || Buffer.byteLength(debugFile) > MAX_DESCRIPTOR_BYTES ||
          debugFile.includes('%r')) throw new RangeError();
      const target = debugFile.replaceAll('%p', String(pid));
      const fds = proc.list(`/proc/${pid}/fd`);
      if (fds.length > MAX_DEBUG_FILE_DESCRIPTORS) throw new RangeError();
      debugFileStatus = 'not-open';
      let discoveryIncomplete = false;
      let matched = false;
      for (const entry of fds) {
        if (!/^[0-9]+$/.test(entry) || !Number.isSafeInteger(Number(entry))) {
          discoveryIncomplete = true;
          continue;
        }
        try {
          if (proc.link(`/proc/${pid}/fd/${entry}`) !== target) continue;
        } catch { discoveryIncomplete = true; continue; }
        matched = true;
        const descriptor = readOutputDescriptor(pid, Number(entry), proc);
        if (descriptor.status === 'captured' && descriptor.target !== target) {
          descriptors.push({ fd: Number(entry), status: 'unavailable', reason: 'descriptor-changed' });
          debugFileStatus = 'unavailable';
        } else {
          descriptors.push(descriptor);
          debugFileStatus = descriptor.status === 'captured' ? 'captured' : 'unavailable';
        }
        break;
      }
      if (!matched && discoveryIncomplete) debugFileStatus = 'unavailable';
    } catch { /* Bounded/unavailable discovery is separate from stdout/stderr. */ }
  }
  return { readStartedEpochMs, readCompletedEpochMs: Date.now(), descriptors, debugFileStatus };
}
export function parseSchedstat(value: string) {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 3 || fields.some((field) => !/^\d+$/.test(field))) {
    throw new Error('Invalid schedstat: expected CPU ns, runqueue ns, timeslices');
  }
  // Keep cumulative counters exact beyond Number.MAX_SAFE_INTEGER.
  return { cpuNs: fields[0], runqueueNs: fields[1], timeslices: fields[2] };
}
export function schedstatDelta(before: ReturnType<typeof parseSchedstat>, after: ReturnType<typeof parseSchedstat>) {
  const delta = (key: keyof typeof before) => {
    const value = BigInt(after[key]) - BigInt(before[key]);
    if (value < 0n) throw new Error('schedstat counter reset; process lifetime changed');
    return value;
  };
  return { cpuMs: Number(delta('cpuNs')) / 1e6, runqueueMs: Number(delta('runqueueNs')) / 1e6,
    timeslices: Number(delta('timeslices')) };
}

/** Discover through every task's children: GLib can spawn from a worker thread.
 * No global /proc name match, inherited environment, or PID-only attribution. */
export function collectOwnedWebKitSample(options: NativeProbeOptions, proc: ProcReader = liveProc,
  capturedEnvironmentIdentities: ReadonlySet<string> = new Set(),
  previouslyOwned: readonly PreviouslyOwnedProcess[] = []) {
  if (previouslyOwned.length > MAX_TRACKED_IDENTITIES) throw new Error('Native diagnostic exceeds 64-identity bound');
  if (previouslyOwned.some(({ pid, identity }) => !Number.isSafeInteger(pid) || pid <= 0 ||
      !/^linux:[^:]+:[0-9]+$/.test(identity))) throw new Error('Native diagnostic invalid previously observed identity');
  const readStartedEpochMs = Date.now();
  const started = performance.now();
  const boot = proc.read('/proc/sys/kernel/random/boot_id').trim();
  const identity = (pid: number) => linuxProcessIdentityFromStat(boot, proc.read(`/proc/${pid}/stat`));
  if (!boot || identity(options.driverPid) !== options.driverIdentity) {
    throw new Error('Native diagnostic driver identity changed');
  }
  type Ancestor = { pid: number; identity: string };
  type Node = { pid: number; identity: string; app: Ancestor | null; ancestry: Ancestor[] };
  const queue: Node[] = [{ pid: options.driverPid, identity: options.driverIdentity, app: null, ancestry: [] }];
  const seen = new Set<number>();
  const processes: Array<{ pid: number; identity: string; kind: 'app' | 'webkit'; ancestry: Ancestor[];
    appPid: number; appIdentity: string; state: string | null; wchan: string | null;
    environment?: NativeEnvironment;
    output?: ReturnType<typeof readNativeOutput>;
    schedstat: ReturnType<typeof parseSchedstat>; readStartedEpochMs: number; readCompletedEpochMs: number }> = [];
  const unavailable: string[] = [];
  while (queue.length) {
    const node = queue.shift()!;
    if (seen.has(node.pid)) continue;
    seen.add(node.pid);
    if (seen.size > 64) throw new Error('Native diagnostic subtree exceeds 64-process bound');
    try {
      if (identity(node.pid) !== node.identity) throw new Error('process identity changed during discovery');
      const exe = proc.link(`/proc/${node.pid}/exe`);
      const app = exe === options.appPath ? { pid: node.pid, identity: node.identity } : node.app;
      const kind = exe === options.appPath ? 'app' : path.basename(exe) === 'WebKitWebProcess' ? 'webkit' : null;
      if (kind && app) {
        const task = `/proc/${node.pid}/task/${node.pid}`;
        const sampleStarted = Date.now();
        const mainStat = proc.read(`${task}/stat`);
        const schedstat = parseSchedstat(proc.read(`${task}/schedstat`));
        let wchan: string | null = null;
        try { wchan = proc.read(`${task}/wchan`).trim(); } catch { /* explicitly unavailable */ }
        const validate = () => {
          if (linuxProcessIdentityFromStat(boot, mainStat) !== node.identity ||
              identity(node.pid) !== node.identity || identity(app.pid) !== app.identity ||
              proc.link(`/proc/${node.pid}/exe`) !== exe || proc.link(`/proc/${app.pid}/exe`) !== options.appPath ||
              proc.read('/proc/sys/kernel/random/boot_id').trim() !== boot) {
            throw new Error('process/app identity changed during sampling');
          }
          const chain = [...node.ancestry, { pid: node.pid, identity: node.identity }];
          for (let i = 0; i < chain.length; i++) {
            const stat = proc.read(`/proc/${chain[i].pid}/stat`);
            if (linuxProcessIdentityFromStat(boot, stat) !== chain[i].identity ||
                (i > 0 && linuxPpidFromProcStat(stat) !== chain[i - 1].pid)) {
              throw new Error('owned ancestry changed during sampling');
            }
          }
        };
        // Bracket the environment read with the same owned lifetime proof.
        validate();
        const environment = options.environment && !capturedEnvironmentIdentities.has(`${node.pid}:${node.identity}`)
          ? readNativeEnvironment(node.pid, proc) : undefined;
        const output = options.outputDescriptors ? readNativeOutput(node.pid, options.debugFile, proc) : undefined;
        if (environment || output) validate();
        processes.push({ pid: node.pid, identity: node.identity, kind, ancestry: node.ancestry,
          appPid: app.pid, appIdentity: app.identity, state: linuxProcStateFromStat(mainStat), wchan, schedstat,
          ...(environment ? { environment } : {}),
          ...(output ? { output } : {}),
          readStartedEpochMs: sampleStarted, readCompletedEpochMs: Date.now() });
      }
      const tasks = proc.list(`/proc/${node.pid}/task`);
      if (tasks.length > 256) throw new Error('process exceeds 256-task discovery bound');
      for (const tid of tasks) {
        if (!/^\d+$/.test(tid)) continue;
        const children = proc.read(`/proc/${node.pid}/task/${tid}/children`).trim();
        for (const child of children ? children.split(/\s+/) : []) {
          if (!/^[1-9]\d*$/.test(child)) throw new Error('invalid child PID');
          const pid = Number(child);
          const stat = proc.read(`/proc/${pid}/stat`);
          const childIdentity = linuxProcessIdentityFromStat(boot, stat);
          if (linuxPpidFromProcStat(stat) !== node.pid || !childIdentity) continue;
          queue.push({ pid, identity: childIdentity, app,
            ancestry: [...node.ancestry, { pid: node.pid, identity: node.identity }] });
        }
      }
      if (identity(node.pid) !== node.identity) throw new Error('ancestor identity changed during discovery');
    } catch (error) {
      unavailable.push(`${node.pid}: ${String(error).slice(0, 200)}`);
    }
  }
  const current = new Set(processes.map(({ pid, identity }) => `${pid}:${identity}`));
  const lifecycle = previouslyOwned.filter(({ pid, identity }) => !current.has(`${pid}:${identity}`))
    .map((target) => observeMissingOwnedProcess(target, boot, unavailable.length > 0, proc));
  if (proc.read('/proc/sys/kernel/random/boot_id').trim() !== boot ||
      identity(options.driverPid) !== options.driverIdentity) throw new Error('Native diagnostic driver exited/reused (identity/boot changed)');
  let runqueueMeasured = false;
  try { runqueueMeasured = proc.read('/proc/sys/kernel/sched_schedstats').trim() === '1'; } catch { /* unknown */ }
  return { readStartedEpochMs, readCompletedEpochMs: Date.now(), readDurationMs: performance.now() - started,
    clock: 'Date.now' as const, counterUnit: 'ns' as const, task: 'main' as const,
    runqueueMeasured, processes, unavailable, lifecycle };
}

type NativeTarget = ReturnType<typeof collectOwnedWebKitSample>['processes'][number];
/** Explicit diagnostic only: ptrace stops the target, so these runs cannot certify
 * latency. Validate the whole owned ancestry immediately before and after attach.
 * Capture the post-attach clock and library mappings with the frames so stripped
 * addresses can be resolved offline without downloading symbols during the run.
 * Never enable downloads, user init files, or an unbounded debugger session. */
export function captureOwnedNativeStacks(options: NativeProbeOptions, target: NativeTarget,
  proc: ProcReader = liveProc,
  run: (pid: number) => string = (pid) => execFileSync('sudo', ['-n', 'timeout',
    '--signal=TERM', '--kill-after=1s', '2s', 'gdb', '--batch', '--nx', '--nh',
    '-iex', 'set debuginfod enabled off', '-iex', 'set auto-load off',
    '-ex', 'set pagination off', '-ex', `attach ${pid}`,
    '-ex', 'python import time; print("NATIVE_STACK_STOP_EPOCH_MS=%d" % (time.time_ns() // 1000000))',
    '-ex', 'info proc mappings',
    '-ex', 'thread apply all bt 16', '-ex', 'detach', '-ex', 'quit'], {
    encoding: 'utf8', timeout: 4_000, maxBuffer: 256 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })) {
  const startedEpochMs = Date.now();
  const started = performance.now();
  let output: string | undefined;
  let postValidated = false;
  let stoppedEpochMs: number | undefined;
  const validate = () => {
    const current = collectOwnedWebKitSample(options, proc).processes.find(({ pid }) => pid === target.pid);
    if (!current || current.kind !== 'webkit' || current.identity !== target.identity ||
        current.appIdentity !== target.appIdentity ||
        JSON.stringify(current.ancestry) !== JSON.stringify(target.ancestry)) {
      throw new Error('Native stack target identity/owned ancestry changed');
    }
    return current;
  };
  try {
    validate();
    output = run(target.pid);
    if (Buffer.byteLength(output) > 256 * 1024) throw new Error('Native stack output exceeds byte bound');
    const after = validate();
    postValidated = true;
    if (after.state === 'T' || after.state === 't') throw new Error('Native stack target remained stopped');
    // GDB can exit zero after a refused attach; exit status alone is not proof.
    if (!/\[Inferior .* detached\]/.test(output) || !/^#0\s+/m.test(output)) {
      throw new Error('Native stack capture has no frame/detach proof');
    }
    const stopMarkers = [...output.matchAll(/^NATIVE_STACK_STOP_EPOCH_MS=(\d{13})$/gm)];
    if (stopMarkers.length !== 1) throw new Error('Native stack capture has no unique post-attach clock');
    stoppedEpochMs = Number(stopMarkers[0][1]);
    if (!Number.isSafeInteger(stoppedEpochMs) || stoppedEpochMs < startedEpochMs ||
        stoppedEpochMs > Date.now()) throw new Error('Native stack post-attach clock is outside capture');
    const mappingLines = output.split('\n').filter((line) =>
      /^\s*0x[0-9a-f]+\s+0x[0-9a-f]+/.test(line) &&
      /\/(?:libwebkit2gtk|libjavascriptcoregtk)-4\.1\.so\.0(?:\.[0-9]+)*(?:\s+\(deleted\))?\s*$/.test(line));
    if (!mappingLines.some((line) => line.includes('/libwebkit2gtk-4.1.so.0'))) {
      throw new Error('Native stack capture has no WebKit mapping for offline symbols');
    }
    return { kind: 'native-stack' as const, status: 'captured' as const,
      startedEpochMs, stoppedEpochMs, completedEpochMs: Date.now(), durationMs: performance.now() - started,
      pid: target.pid, identity: target.identity, ancestry: target.ancestry,
      observerEffect: 'debugger attachment stops target; diagnostic, not latency acceptance',
      mappingLines: mappingLines.slice(0, 40), output };
  } catch (error) {
    // Keep bounded debugger evidence only after the owned identity was checked
    // again. A post-attach PID/ancestry race must never retain a peer's stack.
    const retainedOutput = postValidated && output && Buffer.byteLength(output) <= 256 * 1024
      ? output : undefined;
    return { kind: 'native-stack' as const, status: 'unavailable' as const,
      startedEpochMs, completedEpochMs: Date.now(), durationMs: performance.now() - started,
      pid: target.pid, identity: target.identity, ancestry: target.ancestry,
      stoppedEpochMs: postValidated ? stoppedEpochMs : undefined,
      error: String(error).slice(0, 500), output: retainedOutput };
  }
}

/** Delay debugger attachment from the first observation of an owned WebKit
 * lifetime. A page-relative queue interval can be correlated with the native
 * sample timestamps after the run; a capture outside it is not queue evidence.
 * The global cap still applies if WebKit replaces its process mid-run. */
export function parseNativeStackDelayMs(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('Native stack delay must be an integer from 0 to 15000 ms');
  const delay = Number(value);
  if (!Number.isSafeInteger(delay) || delay > 15_000) {
    throw new Error('Native stack delay must be an integer from 0 to 15000 ms');
  }
  return delay;
}

export class NativeStackCaptureSchedule {
  private targetKey: string | null = null;
  private firstSeenEpochMs = 0;
  private lastCaptureEpochMs = Number.NEGATIVE_INFINITY;
  private captures = 0;

  constructor(readonly delayMs: number) {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 15_000) {
      throw new Error('Native stack delay must be an integer from 0 to 15000 ms');
    }
  }

  due(targetKey: string | null, epochMs: number): boolean {
    if (targetKey === null) return false;
    if (targetKey !== this.targetKey) {
      this.targetKey = targetKey;
      this.firstSeenEpochMs = epochMs;
      this.lastCaptureEpochMs = Number.NEGATIVE_INFINITY;
    }
    if (this.captures >= 3 || epochMs - this.firstSeenEpochMs < this.delayMs ||
        epochMs - this.lastCaptureEpochMs < 1_000) return false;
    this.captures++;
    this.lastCaptureEpochMs = epochMs;
    return true;
  }
}

const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const MAX_SAMPLES = 1200;

/** Keep diagnostic disk I/O outside the sampled startup interval. The byte bound
 * includes UTF-8 encoding, and an oversized record is rejected in its entirety. */
export class NativeSampleBuffer {
  private readonly lines: string[] = [];
  private finished = false;
  private bufferedBytes = 0;
  private maxReadDurationMs = 0;
  private maxSampleWorkMs = 0;
  private totalSampleWorkMs = 0;
  constructor(private readonly maxBytes = MAX_BUFFERED_BYTES, private readonly maxSamples = MAX_SAMPLES) {}

  add(sample: ReturnType<typeof collectOwnedWebKitSample>): boolean {
    if (this.finished || this.lines.length >= this.maxSamples) return false;
    const started = performance.now();
    const line = `${JSON.stringify({ kind: 'sample', ...sample })}\n`;
    const bytes = Buffer.byteLength(line);
    const accepted = this.bufferedBytes + bytes <= this.maxBytes;
    if (accepted) {
      this.lines.push(line);
      this.bufferedBytes += bytes;
      this.maxReadDurationMs = Math.max(this.maxReadDurationMs, sample.readDurationMs);
    }
    // Includes collection + serialization + insertion, never disk flushing.
    // This is sampler work, not a measurement of its effect on user latency.
    const workMs = sample.readDurationMs + performance.now() - started;
    this.totalSampleWorkMs += workMs;
    this.maxSampleWorkMs = Math.max(this.maxSampleWorkMs, workMs);
    return accepted;
  }

  finish(reason: string, elapsedMs: number): string | null {
    if (this.finished) return null;
    this.finished = true;
    const end = { kind: 'end', reason, samples: this.lines.length, bufferedBytes: this.bufferedBytes,
      maxReadDurationMs: this.maxReadDurationMs, maxSampleWorkMs: this.maxSampleWorkMs,
      totalSampleWorkMs: this.totalSampleWorkMs, elapsedMs, epochMs: Date.now() };
    const result = this.lines.join('') + `${JSON.stringify(end)}\n`;
    this.lines.length = 0;
    return result;
  }
}

/** A separate Node process continues sampling while WebKit's main task stalls. */
export function startNativeProcessProbe(driverPid: number, appPath: string, file: string,
  stacks = false): ChildProcess {
  if (process.platform !== 'linux') throw new Error('Native CPU diagnostic requires Linux /proc');
  const driverIdentity = readProcessIdentity(driverPid);
  if (!driverIdentity) throw new Error('Native CPU diagnostic cannot identify its driver');
  const stackDelayMs = stacks ? parseNativeStackDelayMs(process.env.PAPERCUSP_PERF_NATIVE_STACK_DELAY_MS) : 0;
  const options = { driverPid, driverIdentity, appPath: realpathSync(appPath), stacks, stackDelayMs, environment: true,
    outputDescriptors: true, debugFile: process.env.GST_DEBUG_FILE };
  // Exclusive create prevents a rerun from overwriting earlier diagnostic evidence.
  writeFileSync(file, `${JSON.stringify({ kind: 'header', schemaVersion: 'native-process-probe-v7',
    options, intervalMs: 100, maxDurationMs: 120_000, maxSamples: MAX_SAMPLES,
    persistence: 'buffered-until-finish', maxBufferedBytes: MAX_BUFFERED_BYTES,
    environment: { keys: ENVIRONMENT_KEYS, maxBytes: MAX_ENVIRONMENT_BYTES,
      maxValueBytes: MAX_ENVIRONMENT_VALUE_BYTES, persistence: 'once-per-pid-identity',
      source: 'owned process environment in procfs', limitation: 'initial process environment; later in-process changes may be invisible' },
    output: { descriptors: [1, 2], debugFile: options.debugFile ?? null,
      maxInfoBytes: MAX_DESCRIPTOR_BYTES, maxDebugFileDescriptors: MAX_DEBUG_FILE_DESCRIPTORS,
      persistence: 'per-sample-buffered', source: 'owned process file descriptors and fdinfo in procfs',
      limitation: 'descriptor topology, not syscall duration; requested debug path must also match measured native environment' },
    lifecycle: { maxIdentities: MAX_TRACKED_IDENTITIES, maxStatBytes: 4096,
      source: 'two bracketed procfs stat reads of previously observed owned identities',
      limitation: 'missing procfs entries and PID replacement do not prove a signal or reaping; no wait receipt is available for non-child targets' },
    stacks: stacks ? { maxCaptures: 3, intervalMs: 1_000, afterFirstOwnedWebKitMs: stackDelayMs,
      trigger: 'first observation of this owned WebKit PID identity; reset delay on replacement',
      debuggerTimeoutMs: 4_000, maxOutputBytes: 256 * 1024, latencyAcceptance: false,
      postAttachClock: 'Date.now via GDB Python before frames',
      mappings: 'libwebkit2gtk and libjavascriptcoregtk process mappings for offline symbols' } : null })}\n`, { flag: 'wx', mode: 0o600 });
  return fork(__filename, [JSON.stringify(options), file], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
}
export async function stopNativeProcessProbe(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    // Allow the bounded debugger to detach and the child to flush its evidence.
    const timeout = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 6_000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    if (child.connected) child.send('stop');
    else child.kill('SIGTERM');
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const options = JSON.parse(process.argv[2]) as NativeProbeOptions;
  const file = process.argv[3];
  const started = performance.now();
  const buffer = new NativeSampleBuffer();
  const capturedEnvironmentIdentities = new Set<string>();
  const previouslyOwned = new Map<string, PreviouslyOwnedProcess>();
  let samples = 0;
  let finished = false;
  const stackRows: ReturnType<typeof captureOwnedNativeStacks>[] = [];
  const stackSchedule = new NativeStackCaptureSchedule(options.stackDelayMs ?? 0);
  let timer: NodeJS.Timeout;
  const finish = (reason: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    // One append after sampling has stopped; no per-tick file writes.
    appendFileSync(file, buffer.finish(reason, performance.now() - started)! +
      stackRows.map((row) => `${JSON.stringify(row)}\n`).join(''));
    process.disconnect?.();
  };
  const tick = () => {
    if (finished) return;
    if (samples >= MAX_SAMPLES || performance.now() - started >= 120_000) return finish('bound');
    try {
      const sample = collectOwnedWebKitSample(options, liveProc, capturedEnvironmentIdentities,
        [...previouslyOwned.values()]);
      const newKeys = new Set(sample.processes.map(({ pid, identity }) => `${pid}:${identity}`)
        .filter((key) => !previouslyOwned.has(key)));
      if (previouslyOwned.size + newKeys.size > MAX_TRACKED_IDENTITIES) return finish('identity-bound');
      if (!buffer.add(sample)) return finish('buffer-bound');
      for (const row of sample.processes) {
        // Retain only lifetime references, not environment/descriptor snapshots.
        previouslyOwned.set(`${row.pid}:${row.identity}`, { pid: row.pid, identity: row.identity,
          kind: row.kind, appPid: row.appPid, appIdentity: row.appIdentity,
          readCompletedEpochMs: row.readCompletedEpochMs });
        if (row.environment) capturedEnvironmentIdentities.add(`${row.pid}:${row.identity}`);
      }
      samples++;
      if (samples === 1 && process.connected) process.send?.({ kind: 'sampling-started' });
      const target = sample.processes.find(({ kind }) => kind === 'webkit');
      if (options.stacks && target && stackSchedule.due(
        `${target.pid}:${target.identity}:${target.appIdentity}`, Date.now())) {
        stackRows.push(captureOwnedNativeStacks(options, target));
      }
      timer = setTimeout(tick, 100);
    } catch (error) { finish(`unavailable: ${String(error).slice(0, 300)}`); }
  };
  process.on('message', (message) => { if (message === 'stop') finish('stopped'); });
  process.on('disconnect', () => finish('launcher-disconnected'));
  process.on('SIGTERM', () => finish('terminated'));
  tick();
}
