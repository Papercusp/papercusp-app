/** PUI's pipe transport for the native Codex and OMP RPC servers. The native
 * process still owns inference/tools/history; the existing task manager owns
 * its process tree. No terminal, shell quoting, or provider loop is involved. */
import { randomUUID } from 'node:crypto';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { startSupervisorBeat } from '../../../apps/operator/scripts/psu-launcher.mjs';
import { managedSpawn } from './task-manager/managed-spawn';
import { killTask } from './task-manager/control';
import type { TaskSpec } from './task-manager/types';
import { redactSensitiveText } from './sensitive-text';
import { processMonotonicClock } from './process-monotonic-clock';

export type RpcFrame = Record<string, unknown>;
/** Process-local observations, not provider dispatch or billing receipts. A
 * write-started receipt records the attempt to enqueue a native RPC command;
 * only write-completed confirms the pipe accepted it, not native execution.
 * Received frames are stamped before response resolution or user callbacks.
 */
export interface SuStdioReceipt {
  peerId: string;
  sequence: number;
  clockId: string;
  atMs: number;
  phase: 'write-started' | 'write-completed' | 'write-failed' | 'received';
  frame: RpcFrame;
}
export interface SuStdioPeer {
  request(frame: RpcFrame, timeoutMs?: number): Promise<RpcFrame>;
  send(frame: RpcFrame): void;
  done: Promise<void>;
  close(): Promise<void>;
  pid(): number | null;
  /** Optional for older peer implementations. A missing state cannot prove a
   * complete receipt population. Read after close(), not just turn/completed. */
  receiptState?(): SuStdioReceiptState;
}
export interface SuStdioReceiptState {
  peerId: string;
  clockId: string;
  emitted: number;
  enabled: boolean;
  sinkFailed: boolean;
  exited: boolean;
  pendingWrites: number;
}
export interface SuStdioPeerOptions {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  workspaceId: string;
  spec: TaskSpec;
  ownerId: string;
  onMessage(frame: RpcFrame): void;
  /** Optional synchronous evidence sink. Throwing fails the peer visibly;
   * callers must not dispatch again after an uncertain write. */
  onReceipt?(receipt: SuStdioReceipt): void;
}

export async function startSuStdioPeer(options: SuStdioPeerOptions): Promise<SuStdioPeer> {
  const { child, taskId } = await managedSpawn(options.binary, options.args, options.spec, {
    workspaceId: options.workspaceId,
    spawnOptions: { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] },
  });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error('Structured engine has no protocol pipes');
  const pending = new Map<string, { resolve(value: RpcFrame): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let closed = false;
  let exited = false;
  let buffer = '';
  let stderr = '';
  let stderrTruncated = false;
  const peerId = randomUUID();
  let receiptSequence = 0;
  let receiptSinkFailed = false;
  let pendingWrites = 0;
  function receipt(phase: SuStdioReceipt['phase'], frame: RpcFrame): void {
    if (!options.onReceipt) return;
    try {
      options.onReceipt({ peerId, sequence: ++receiptSequence, clockId: processMonotonicClock.id,
        atMs: processMonotonicClock.now(), phase, frame: structuredClone(frame) });
    } catch (error) { receiptSinkFailed = true; throw error; }
  }
  const diagnosticSecrets = Object.entries(options.env)
    .filter(([key]) => /token|secret|password|credential|authorization|api.?key|database.?url|dsn/i.test(key))
    .map(([, value]) => value);
  function nativeFailure(message: string): Error {
    // If the retained tail starts mid-line, discard that fragment before
    // redaction so a clipped credential prefix cannot evade the shared guard.
    const tail = stderrTruncated ? stderr.slice(stderr.indexOf('\n') < 0 ? stderr.length : stderr.indexOf('\n') + 1) : stderr;
    const diagnostic = redactSensitiveText([message, tail.trim()].filter(Boolean).join('\n'), diagnosticSecrets)
      .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]');
    return new Error(diagnostic.slice(-3000));
  }
  let heartbeat: ManagedHandle | undefined;
  let resolveExit!: () => void;
  let rejectExit!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  // Startup can fail before the caller receives this peer. Keep the rejection
  // observed while preserving it for the engine's lifecycle supervisor.
  void done.catch(() => undefined);
  function rejectPending(error: Error): void {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  }
  function fail(error: Error): void {
    rejectPending(error);
    rejectExit(error);
    void close().catch((failure) => console.warn('[su-session] protocol teardown failed', failure));
  }
  function send(frame: RpcFrame): void {
    if (closed || exited || child.stdin!.destroyed) throw new Error('Structured engine connection is closed');
    // Serialize before recording an attempt: a serialization error never
    // reached the native pipe. Capture the serialized value so later caller
    // mutation cannot rewrite the evidence of what was actually enqueued.
    const line = JSON.stringify(frame);
    const sent = options.onReceipt ? JSON.parse(line) as RpcFrame : frame;
    try {
      receipt('write-started', sent);
      pendingWrites++;
      child.stdin!.write(`${line}\n`, (error) => {
        pendingWrites--;
        try { receipt(error ? 'write-failed' : 'write-completed', sent); }
        catch (failure) { fail(failure instanceof Error ? failure : new Error(String(failure))); return; }
        if (error) fail(error);
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
  // Pipe streams emit their own errors, independently of ChildProcess. A
  // failed write invokes its callback AND emits on stdin; observing only the
  // callback still leaves EPIPE uncaught in the supervising process.
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  child.stderr.on('error', fail);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    // A corrupt peer must fail visibly, never retain an unbounded partial frame.
    if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { fail(new Error('Structured engine frame exceeds 16 MiB')); return; }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line) continue;
      try {
        const frame = JSON.parse(line) as RpcFrame;
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Structured engine emitted a non-object frame');
        // Separate the retained observation from the mutable response/event
        // objects exposed to consumers. A slow callback cannot move its clock.
        receipt('received', frame);
        const id = frame.id == null ? null : String(frame.id);
        const response = frame.type === 'response' || (!frame.method && ('result' in frame || 'error' in frame));
        const request = id && response ? pending.get(id) : undefined;
        if (request && id) {
          pending.delete(id); clearTimeout(request.timer);
          if (frame.success === false || frame.error) {
            const error = frame.error;
            request.reject(new Error(typeof error === 'string' ? error : JSON.stringify(error)));
          } else request.resolve((frame.result ?? frame.data ?? {}) as RpcFrame);
        } else options.onMessage(frame);
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return; }
    }
  });
  // Startup can fail before a structured response exists. Retain a bounded
  // tail and scrub it before it crosses the host's error/event boundary.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    if (stderr.length > 16_384) { stderr = stderr.slice(-16_384); stderrTruncated = true; }
  });
  child.on('error', fail);
  child.once('close', (code, signal) => {
    exited = true; heartbeat?.stop();
    const error = nativeFailure(`Structured engine exited (${signal ?? code ?? 'unknown'}) before acknowledging the request`);
    rejectPending(error);
    if (closed || (code === 0 && !signal)) resolveExit();
    else rejectExit(error);
  });
  if (child.pid) startSupervisorBeat(options.ownerId, {
    pid: child.pid, operatorUrl: options.env.PAPERCUSP_OPERATOR_URL,
    onTerminalSession: () => { void close().catch((error) => console.warn('[su-session] terminal cleanup failed', error)); },
    setIntervalImpl: (callback: () => void, ms: number) => {
      // D-004: 'must-sample' — this proves the engine PROCESS is still alive, and
      // there is no event source to subscribe to for that (the doc names PID
      // liveness as the canonical must-sample case). A dead process emits nothing,
      // which is precisely why its absence can only be sampled.
      heartbeat = managedSetInterval('su-session-engine-heartbeat', ms, callback, { category: 'liveness', instanced: true, classification: 'must-sample' });
      return {};
    },
  });
  async function waitForExit(ms: number): Promise<boolean> {
    if (exited) return true;
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([new Promise<void>((resolve) => child.once('close', resolve)),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
      return exited;
    } finally { clearTimeout(timer!); }
  }
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true; heartbeat?.stop();
    rejectPending(new Error('Structured engine closed before acknowledgement'));
    child.stdin!.end();
    closing = (async () => {
      if (await waitForExit(5_000)) return;
      const result = await killTask(taskId, { signal: 'SIGKILL', includeSubtree: true, reapTerminalResidue: true });
      // `incomplete` after an explicit SIGKILL means the signal WAS delivered
      // but a process of the scope (typically one blocked in uninterruptible
      // I/O) outlived the task manager's verification window; the kernel
      // applies the kill when its syscall returns and the task stays tracked
      // for reconciliation. The engine is torn down once its own process
      // exits, so wait for that instead of failing (WI-10004247: a loaded
      // release host left one D-state process and failed exact resume).
      const pending = !result.ok && result.error === 'incomplete';
      if (!result.ok && result.error !== 'already_gone' && !pending) {
        throw nativeFailure(`Structured engine teardown failed: ${result.error}${result.detail ? `: ${result.detail}` : ''}`);
      }
      if (!(await waitForExit(pending ? 30_000 : 5_000))) {
        throw nativeFailure(`Structured engine did not exit after tracked teardown${pending && result.detail ? `: ${result.detail}` : ''}`);
      }
    })();
    return closing;
  }
  return {
    send, done, close, pid: () => child.pid ?? null,
    receiptState: () => ({ peerId, clockId: processMonotonicClock.id, emitted: receiptSequence,
      enabled: Boolean(options.onReceipt), sinkFailed: receiptSinkFailed, exited, pendingWrites }),
    request(frame, timeoutMs = 45_000) {
      const id = `pui-${randomUUID()}`;
      return new Promise<RpcFrame>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Structured engine acknowledgement timed out; delivery is unknown, do not replay automatically'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { send({ ...frame, id }); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
  };
}
