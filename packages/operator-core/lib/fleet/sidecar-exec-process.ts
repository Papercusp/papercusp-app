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

import type { AdmissionContext } from '../resource-governor/admission';
import {
  admissionContextFromEnvironment,
  beginGovernedExecution,
  governedExecutionRuntime,
  type GovernedExecution,
} from '../resource-governor/execution';
import { activeWorkspaceId } from '../workspace-registry';

export interface ExecParams {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
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
      metadata: { processKind: 'sidecar-exec', command: params.command },
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

  let execution: GovernedExecution;
  try {
    execution = await (deps.beginExecution ?? beginSidecarProcessExecution)(params);
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
          PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify(execution.context),
        },
        stdio,
        // Own the command's helper processes too. Keep the child referenced;
        // detached here creates a POSIX process group, not a fire-and-forget job.
        detached: process.platform !== 'win32',
      });
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
      child.on('close', async (code) => {
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
