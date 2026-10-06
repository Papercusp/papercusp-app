/**
 * The spawner sidecar's generic "run a process and give me its output" seam,
 * behind the `process:exec` JSON-RPC method.
 *
 * Lives in its OWN module rather than inside spawner-sidecar-server.ts so it can
 * be tested against real `git` without importing the server, which pulls in
 * `spawnInvokeOnce` (the whole orchestrator-runner chain) purely to serve a
 * different RPC method. Nothing here knows about agent spawning.
 *
 * ## The fd handoff (WI-6404)
 *
 * `process:exec` originally piped stdout and returned it as a STRING on the
 * line-delimited JSON reply. That is fine for plumbing output (oids, refs,
 * `rev-parse`), and wrong for the `git cat-file --batch` seam, which carries
 * multi-MB blob CONTENTS whose exact byte offsets are load-bearing — frames are
 * `<oid> SP <type> SP <size> LF <contents> LF`, so a single shifted byte
 * desynchronises the whole stream.
 *
 * Sending those bytes inline would mean base64 (+33%, plus JSON escaping) and a
 * multi-MB `JSON.parse` on the MAIN THREAD at both ends — plausibly a bigger
 * stall than the ~165ms fork the sidecar exists to remove, which would defeat
 * the point entirely. So `stdinPath`/`stdoutPath` hand real FILE DESCRIPTORS to
 * the child instead: git reads and writes them at kernel level, the bytes never
 * enter this process or the JSON channel, and byte fidelity is structural
 * rather than promised.
 */
import * as fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { spawn, type StdioOptions } from 'node:child_process';
import { processGroupLifetime } from './process-group-lifetime';

import { isReadOnlyGitBatchExec } from '../git-batch';
import { gitSubcommandOf, qualifiesForLazyReceipt as qualifiesForLazyGitExec } from './sidecar-read-only-git';

import type { AdmissionContext, ResourceDemand } from '../resource-governor/admission';
import {
  admissionContextFromEnvironment,
  beginGovernedExecution,
  governedExecutionRuntime,
  type GovernedExecution,
} from '../resource-governor/execution';
import { activeWorkspaceId } from '../workspace-registry';

export const PROCESS_EXEC_CALLER_LABELS = {
  command: 'git-via-sidecar.runCommandViaSpawnerSidecar',
  stdin: 'git-via-sidecar.runGitStdinViaSpawnerSidecar',
} as const;

export type ProcessExecCallerLabel =
  (typeof PROCESS_EXEC_CALLER_LABELS)[keyof typeof PROCESS_EXEC_CALLER_LABELS];

export interface ExecParams {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Safe, static callsite identity for transport-fault diagnostics. */
  callerLabel?: ProcessExecCallerLabel;
  /** Optional no-output deadline. Unlike `timeoutMs` (the absolute hard
   * ceiling), this timer refreshes on observed stdout/stderr progress. File
   * output is sampled at idle deadlines, without copying its bytes into JS. */
  idleTimeoutMs?: number;
  timeoutMs?: number;
  /**
   * FD HANDOFF, input leg. When set, the child's stdin IS this file: the sidecar
   * opens it and passes the fd as `stdio[0]`, so the child reads it directly.
   * Absent ⇒ stdin is `'ignore'`, exactly as before.
   */
  stdinPath?: string;
  /**
   * FD HANDOFF, output leg. When set, the child's stdout is written STRAIGHT to
   * this file (see the module header for why). Absent ⇒ stdout is piped and
   * accumulated into `stdout`, exactly as before.
   */
  stdoutPath?: string;
  /** Explicit scope for the durable admission receipt. */
  workspaceId?: string;
  /** Stable caller identity for receipt ownership and operator visibility. */
  ownerId?: string;
  /** Optional retry key. Omitted calls are unique process starts. */
  idempotencyKey?: string;
  /** Typed nested lineage. When absent, the propagated process env is decoded. */
  admissionContext?: AdmissionContext;
  /** Bind dispatch to the server/connection observed before starting work.
   * Validated by the IPC server before admission, never by a durable receipt. */
  fence?: { serverGeneration: string; connectionId: string };
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Bytes the child wrote to `stdoutPath` (fd-handoff mode only), so the
   *  caller can cross-check the file it reads back against what git produced. */
  stdoutBytes?: number;
}

export interface ExecProcessDeps {
  beginExecution?: (params: ExecParams) => Promise<GovernedExecution>;
  /** Control stays local to the sidecar; AbortSignal is never serialized. */
  signal?: AbortSignal;
  onPid?: (pid: number) => void;
  onOutputActivity?: () => void;
  /** Injectable grace for real-process cancellation tests. */
  killGraceMs?: number;
  /**
   * How long a read-only git exec (see `qualifiesForLazyReceipt`) may run before
   * it mints its durable admission receipt. `0` restores eager admit-before-spawn
   * for EVERY command. Default `SIDECAR_LAZY_RECEIPT_DELAY_MS`. Commands that do
   * not qualify are always admitted eagerly, whatever this says.
   */
  lazyReceiptMs?: number;
}

/**
 * WI-10004674 / WI-10003465 — a read-only git exec lives ~4 ms, but its durable
 * receipt costs four awaited PG statements (admit INSERT, lease UPDATE,
 * markRunning UPDATE, release UPDATE). Fleet-wide that is ~10 execs/s = ~40
 * statements/s through the sidecar's 2-connection pool on a WAL-saturated disk:
 * measured enqueue->complete p50 0.5-3.5 s per read against 5 ms for bare git,
 * and ~59% of native-PG WAL. The receipt is observe-only evidence here
 * (decision reason `observe-only-targeted-lease`), so a read that is already
 * finished by the time anyone could look at the ledger does not need one.
 *
 * A qualifying exec therefore spawns FIRST and mints its receipt only if it is
 * still running after this delay. Slow reads (a network `ls-remote`, a huge
 * `log`) keep full ledger visibility, merely `delay` late.
 */
export const SIDECAR_LAZY_RECEIPT_DELAY_MS = 750;

/**
 * The read-only git classification (which subcommands may defer their receipt)
 * lives in `sidecar-read-only-git.ts` so the CLIENT-side latency sampler shares
 * one definition without importing this module's resource-governor/PG chain.
 * Re-exported here so every existing importer keeps working.
 */
export { gitSubcommandOf, qualifiesForLazyReceipt } from './sidecar-read-only-git';

/** Lazy admission covers ordinary read-only Git and the strictly verified dev-deploy batch. */
export function qualifiesForLazyReceiptProcess(
  params: Pick<ExecParams, 'command' | 'args'>,
): boolean {
  return qualifiesForLazyGitExec(params) || isReadOnlyGitBatchExec(params);
}

/** What `execProcess` needs from the durable receipt, whether minted eagerly or late. */
interface ReceiptHandle {
  /** Env override handed to the child (its nested-lineage context). */
  readonly childEnv: Record<string, string>;
  /** Call right after spawn: starts the lazy mint timer (no-op when eager). */
  armAfterSpawn(): void;
  finish(demand: ResourceDemand): Promise<void>;
  cancel(reason: string): Promise<void>;
}

function eagerReceipt(execution: GovernedExecution): ReceiptHandle {
  return {
    childEnv: { PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify(execution.context) },
    armAfterSpawn: () => {},
    // Eager settlement failures propagate: the caller reports them in stderr.
    finish: async (demand) => { await execution.finish(demand); },
    cancel: async (reason) => { await execution.cancel(reason); },
  };
}

function lazyReceipt(
  begin: (params: ExecParams) => Promise<GovernedExecution>,
  params: ExecParams,
  delayMs: number,
): ReceiptHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let minting: Promise<void> | null = null;
  let execution: GovernedExecution | null = null;
  const settle = async (op: (e: GovernedExecution) => Promise<unknown>): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (minting) await minting;
    if (!execution) return; // finished before the delay: no receipt was ever minted
    // Evidence only: a late receipt is bookkeeping for a read that already
    // succeeded, so its settlement failure must not turn that result into an error.
    await op(execution).catch(() => undefined);
  };
  return {
    // The child inherits the caller-supplied parent lineage; there is no receipt of its own yet.
    childEnv: params.admissionContext
      ? { PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify(params.admissionContext) }
      : {},
    armAfterSpawn: () => {
      timer = setTimeout(() => {
        timer = null;
        minting = begin(params).then(
          (e) => { execution = e; },
          () => undefined, // best-effort: never disturbs a running read
        );
      }, delayMs);
      timer.unref?.();
    },
    finish: (demand) => settle((e) => e.finish(demand)),
    cancel: (reason) => settle((e) => e.cancel(reason)),
  };
}

/**
 * Receipt metadata. A git receipt also names its SUBCOMMAND and whether it was
 * eligible for the lazy path: the ledger carries no argv, so without these a
 * "which git execs still mint receipts after the lazy-receipt fix" question is
 * unanswerable — a read-only subcommand here is a read that outlived the delay,
 * a non-read-only one was always going to be eager (WI-10004674 done-when (b)).
 * Derived deterministically from `params`, so a retry under the same
 * idempotency key keeps the same request digest.
 */
export function sidecarReceiptMetadata(
  params: Pick<ExecParams, 'command' | 'args'>,
): Record<string, string | boolean> {
  const base = { processKind: 'sidecar-exec', command: params.command };
  if (params.command === 'git') {
    return {
      ...base,
      gitSubcommand: gitSubcommandOf(params.args ?? []) ?? 'unknown',
      readOnlyGit: qualifiesForLazyGitExec(params),
    };
  }
  if (isReadOnlyGitBatchExec(params)) {
    return { ...base, gitSubcommand: 'batch', readOnlyGit: true };
  }
  return base;
}

async function beginSidecarProcessExecution(params: ExecParams): Promise<GovernedExecution> {
  const workspaceId =
    params.workspaceId?.trim() ||
    params.env?.PAPERCUSP_WORKSPACE_ID?.trim() ||
    params.env?.PAPERCUSP_WORKSPACE?.trim() ||
    activeWorkspaceId();
  const parent =
    params.admissionContext ??
    admissionContextFromEnvironment(params.env?.PAPERCUSP_ADMISSION_CONTEXT) ??
    admissionContextFromEnvironment(process.env.PAPERCUSP_ADMISSION_CONTEXT);
  const idempotencyKey = params.idempotencyKey?.trim() || `sidecar-process:${process.pid}:${randomUUID()}`;
  return beginGovernedExecution(
    {
      idempotencyKey,
      admissionClass: 'process',
      demand: { cpuWeight: 1 },
      payloadRef: `process:${params.command}`,
      parent,
      metadata: sidecarReceiptMetadata(params),
    },
    { owner: params.ownerId?.trim() || params.env?.PAPERCUSP_SID?.trim() || `spawner-sidecar:${process.pid}` },
    governedExecutionRuntime(workspaceId, 'agent-process'),
  );
}

export async function execProcess(params: ExecParams, deps: ExecProcessDeps = {}): Promise<ExecResult> {
  const aborted = (): ExecResult => ({ code: -1, stdout: '', stderr: 'process aborted before spawn' });
  if (deps.signal?.aborted) return aborted();
  // Open the handoff files BEFORE spawning: a bad path must come back as a
  // normal non-zero result the caller can fall back from, never a thrown RPC
  // error (every caller's contract is degrade-to-local, not fail).
  let stdinHandle: fsp.FileHandle | undefined;
  let stdoutHandle: fsp.FileHandle | undefined;
  try {
    if (params.stdinPath) stdinHandle = await fsp.open(params.stdinPath, 'r');
    if (params.stdoutPath) stdoutHandle = await fsp.open(params.stdoutPath, 'w');
  } catch (e) {
    await stdinHandle?.close().catch(() => {});
    await stdoutHandle?.close().catch(() => {});
    return { code: -1, stdout: '', stderr: `spawner sidecar could not open a handoff file: ${String(e)}` };
  }

  const begin = deps.beginExecution ?? beginSidecarProcessExecution;
  const lazyDelayMs = qualifiesForLazyReceiptProcess(params) ? (deps.lazyReceiptMs ?? SIDECAR_LAZY_RECEIPT_DELAY_MS) : 0;
  let execution: ReceiptHandle;
  try {
    // Lazy: nothing to admit yet — the receipt is minted only if the read outlives the delay.
    execution = lazyDelayMs > 0 ? lazyReceipt(begin, params, lazyDelayMs) : eagerReceipt(await begin(params));
  } catch (e) {
    await stdinHandle?.close().catch(() => {});
    await stdoutHandle?.close().catch(() => {});
    return { code: -1, stdout: '', stderr: `spawner sidecar admission failed: ${String(e)}` };
  }

  // Admission may have waited while the caller cancelled. Do not create a
  // child after cancellation merely because the admission promise settled.
  if (deps.signal?.aborted) {
    try {
      await execution.cancel('sidecar process aborted before spawn');
    } catch (e) {
      return { ...aborted(), stderr: `sidecar process aborted before spawn; admission cancellation failed: ${String(e)}` };
    } finally {
      await stdinHandle?.close().catch(() => {});
      await stdoutHandle?.close().catch(() => {});
    }
    return aborted();
  }

  let result: ExecResult;
  try {
    result = await new Promise<ExecResult>((resolve) => {
      const stdio: StdioOptions = [
        stdinHandle ? stdinHandle.fd : 'ignore',
        stdoutHandle ? stdoutHandle.fd : 'pipe',
        'pipe',
      ];
      const child = spawn(params.command, params.args ?? [], {
        cwd: params.cwd,
        env: {
          ...process.env,
          ...(params.env ?? {}),
          ...execution.childEnv,
        },
        stdio,
        // Own the command's helper processes too. Keep the child referenced;
        // detached here creates a POSIX process group, not a fire-and-forget job.
        detached: process.platform !== 'win32',
      });
      // A lazy receipt's delay measures the child's runtime, not the setup before it.
      execution.armAfterSpawn();
      // Decode across chunk boundaries: a multi-byte UTF-8 character split between
      // two `data` events decodes to replacement chars under a plain
      // `String(chunk)`, silently corrupting output (e.g. a non-ASCII author or
      // subject in `git log`). StringDecoder holds the partial sequence back.
      const outDecoder = new StringDecoder('utf8');
      const errDecoder = new StringDecoder('utf8');
      let stdout = '';
      let stderr = '';
      let settled = false;
      let commandExited = false;
      let terminating = false;
      let spawnFailed = false;
      let hardTimer: ReturnType<typeof setTimeout> | null = null;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let idleCheck: ReturnType<typeof setImmediate> | null = null;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      let idleGeneration = 0;
      let exitGraceUsed = false;
      let observedStdoutBytes = 0;
      const childOutputFinished = (): boolean => {
        if (child.exitCode !== null || child.signalCode !== null) return true;
        const pipes = [child.stdout, child.stderr].filter((s): s is NonNullable<typeof s> => s != null);
        return pipes.length > 0 && pipes.every((s) => s.readableEnded);
      };
      let removeAbortListener = (): void => {};
      const groupLifetime = processGroupLifetime(child, (message) => { stderr += `\nsidecar ${message}`; });
      const signalCommand = groupLifetime.signal;
      const waitForCommandExit = async (): Promise<void> => {
        await groupLifetime.waitForExit();
        commandExited = true;
      };
      const clearTimers = (): void => {
        idleGeneration += 1;
        if (hardTimer) clearTimeout(hardTimer);
        if (idleTimer) clearTimeout(idleTimer);
        if (idleCheck) clearImmediate(idleCheck);
        idleCheck = null;
      };
      const stopGuards = (): void => {
        clearTimers();
        if (killTimer) clearTimeout(killTimer);
        removeAbortListener();
      };
      const reportOutput = (): void => {
        try { deps.onOutputActivity?.(); } catch { /* observer failure cannot own child lifetime */ }
      };
      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        stopGuards();
        resolve({ code: terminating ? -1 : code, stdout: stdout + outDecoder.end(), stderr: stderr + errDecoder.end() });
      };
      const timeoutMs = params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : 0;
      const idleTimeoutMs = params.idleTimeoutMs && params.idleTimeoutMs > 0 ? params.idleTimeoutMs : 0;
      const terminate = (reason: string): void => {
        if (settled || commandExited || terminating) return;
        terminating = true;
        clearTimers();
        stderr += `${stderr ? '\n' : ''}${params.command} ${(params.args ?? []).join(' ')} ${reason} — killed by the spawner sidecar guard`;
        signalCommand('SIGTERM');
        killTimer = setTimeout(() => signalCommand('SIGKILL'), deps.killGraceMs ?? 10_000);
        killTimer.unref?.();
        // A kill signal is not an exit receipt. Only close (or a spawn error)
        // may settle this call and let the caller release repository locks.
      };
      const armIdleTimer = (): void => {
        if (idleTimeoutMs <= 0 || settled || terminating) return;
        const generation = ++idleGeneration;
        if (idleTimer) clearTimeout(idleTimer);
        if (idleCheck) clearImmediate(idleCheck);
        idleCheck = null;
        idleTimer = setTimeout(() => {
          idleTimer = null;
          // A stalled parent can resume in TIMERS with child output already
          // waiting in an OS pipe. Let POLL deliver those bytes before deciding
          // the child was idle. A data event cancels this candidate and re-arms
          // the idle timer; the independent hard ceiling is never deferred.
          idleCheck = setImmediate(async () => {
            idleCheck = null;
            const current = (): boolean =>
              generation === idleGeneration && !settled && !commandExited && !terminating;
            if (!current()) return;
            if (stdoutHandle) {
              // A handed-off fd has no pipe events. Inspect its own inode,
              // not the path (which could have been replaced), only when the
              // existing idle deadline needs a verdict. A changed size is
              // observed output progress; an unchanged next sample can expire.
              // This is conservative by one sample interval after the final
              // write, while the independent absolute deadline stays exact.
              let bytes: number;
              try {
                bytes = (await stdoutHandle.stat()).size;
              } catch (error) {
                if (current()) terminate(`could not verify stdout-file progress: ${String(error)}`);
                return;
              }
              // Pipe progress, cancellation or close may have won while fstat
              // was pending. That newer state invalidates this idle candidate.
              if (!current()) return;
              if (bytes !== observedStdoutBytes) {
                observedStdoutBytes = bytes;
                reportOutput();
                armIdleTimer();
                return;
              }
            }
            // A stalled parent can also resume with the child's EOF/exit already
            // observed in POLL while 'close' — and so the exit fence that sets
            // commandExited — only lands after this CHECK phase. A child that has
            // finished its output is not idle: grant ONE more idle window for the
            // fence. A child that closed its pipes yet stays alive past it is
            // still killed, and the absolute deadline is never deferred.
            if (!exitGraceUsed && childOutputFinished()) {
              exitGraceUsed = true;
              armIdleTimer();
              return;
            }
            terminate(`made no output progress for ${idleTimeoutMs}ms`);
          });
          // A file-only child has no pipe traffic to wake POLL. Keep this
          // one-shot check referenced so it runs even when the next event
          // would otherwise be child close or the absolute deadline.
        }, idleTimeoutMs);
        idleTimer.unref?.();
      };
      if (timeoutMs > 0) {
        hardTimer = setTimeout(() => terminate(`timed out after ${timeoutMs}ms`), timeoutMs);
        hardTimer.unref?.();
      }
      armIdleTimer();
      const onAbort = (): void => terminate('aborted by caller');
      if (deps.signal) {
        removeAbortListener = () => deps.signal?.removeEventListener('abort', onAbort);
        deps.signal.addEventListener('abort', onAbort, { once: true });
        if (deps.signal.aborted) onAbort();
      }
      child.once('spawn', () => {
        try { if (child.pid) deps.onPid?.(child.pid); } catch { /* observer only */ }
      });
      // In fd-handoff mode `child.stdout` is null — git writes to the file itself.
      child.stdout?.on('data', (d: Buffer) => {
        stdout += outDecoder.write(d);
        reportOutput();
        armIdleTimer();
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += errDecoder.write(d);
        reportOutput();
        armIdleTimer();
      });
      child.on('error', async (e) => {
        spawnFailed = true;
        stderr += String(e);
        try {
          await execution.cancel(`sidecar process spawn error: ${String(e)}`);
        } catch (settlementError) {
          stderr += `; admission cancellation failed: ${String(settlementError)}`;
        } finally {
          finish(-1);
        }
      });
      child.on('close', async (code, signal) => {
        if (signal) stderr += `${stderr ? '\n' : ''}${params.command} terminated by signal ${signal}`;
        try {
          await waitForCommandExit();
          // Admission settlement can itself wait on IO. Remove kill timers
          // after command exit, before awaiting admission settlement.
          stopGuards();
          if (!spawnFailed) await execution.finish({ cpuWeight: 1 });
          finish(code ?? -1);
        } catch (settlementError) {
          stderr += `${stderr ? '\n' : ''}sidecar process admission settlement failed: ${String(settlementError)}`;
          finish(-1);
        }
      });
    });
  } catch (e) {
    let settlementError = '';
    try {
      await execution.cancel(`sidecar process spawn threw: ${String(e)}`);
    } catch (cancelError) {
      settlementError = `; admission cancellation failed: ${String(cancelError)}`;
    }
    result = { code: -1, stdout: '', stderr: `spawner sidecar could not spawn process: ${String(e)}${settlementError}` };
  }

  // Size the output BEFORE closing, so the caller can detect a short read.
  let stdoutBytes: number | undefined;
  if (stdoutHandle) {
    try {
      stdoutBytes = (await stdoutHandle.stat()).size;
    } catch {
      /* An fstat failure just means no cross-check is offered. */
    }
  }
  await stdinHandle?.close().catch(() => {});
  await stdoutHandle?.close().catch(() => {});
  return stdoutBytes === undefined ? result : { ...result, stdoutBytes };
}
