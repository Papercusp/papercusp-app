/**
 * waitForOperatorReady — shared boot gate for the gym's dedicated operator
 * (EI-368). Replaces the per-runner `waitForHttp(…/llms.txt)` copies, which
 * accepted ANY HTTP response as "up": the hono listener binds BEFORE the DBOS
 * system-DB migration, so the probe could pass, the boot then abort
 * mid-migration (native Napi::Error), and the cycle's first pipeline call
 * surfaced only the downstream wreckage ("column was_forked_from does not
 * exist" on the half-migrated dbos schema) minutes later.
 *
 * Two legs:
 *  - READINESS, not liveness: poll GET /api/health/ready until the operator
 *    reports its configured shape is up (DBOS launched). A pinned checkout
 *    that predates the route (404) falls back to the legacy llms.txt liveness
 *    probe — never worse than before.
 *  - FAIL-FAST: the moment the spawned operator exits, reject with the exit
 *    code/signal + the boot-log tail, instead of polling out the timeout and
 *    letting a later pipeline call hit the corpse.
 */
import { readFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';

export interface WaitForOperatorReadyOpts {
  /** e.g. `http://127.0.0.1:3976` */
  baseUrl: string;
  /** The spawned gym-operator; omit when there is no process to watch. */
  child?: ChildProcess;
  timeoutMs: number;
  /** Boot log path — its tail rides every rejection message. */
  logPath?: string;
  pollMs?: number;
}

/** Last `lines` of the boot log, formatted for an error message ('' when unreadable). */
export function bootLogTail(logPath: string | undefined, lines = 15): string {
  if (!logPath) return '';
  try {
    const all = readFileSync(logPath, 'utf8').trimEnd().split('\n');
    return `\n--- boot log tail (${logPath}) ---\n${all.slice(-lines).join('\n')}`;
  } catch {
    return '';
  }
}

export interface SpawnGymOperatorWithRetryOpts {
  command: string;
  args: string[];
  spawnOptions: SpawnOptions;
  /** e.g. `http://127.0.0.1:3976` */
  baseUrl: string;
  timeoutMs: number;
  /** Boot log path — its tail rides every rejection message; reused across attempts. */
  logPath?: string;
  pollMs?: number;
  /** Total attempts (1 = no retry). Default 2 (one retry). */
  maxAttempts?: number;
  /** Called just before a retry, with the failure that triggered it. */
  onRetry?: (err: Error, attempt: number) => void;
  /** Test seam — defaults to node:child_process's `spawn`. */
  spawnFn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

/**
 * spawnGymOperatorWithRetry (EI-18157486989132279) — spawn + waitForOperatorReady
 * with ONE automatic retry, but ONLY when the operator process actually EXITED
 * during boot (a crash). On this heavily-parallel fleet, git-sync commits the
 * shared source tree every ~3min while a gym-operator boot's tsx/esbuild
 * transform re-reads the whole tree — so a boot can occasionally read a
 * half-written file, hit an esbuild TransformError, and exit(1) with a message
 * that LOOKS like a real syntax bug but is a transient partial-read (confirmed:
 * re-transforming the same file after the commit settled parses clean). A
 * respawn a few seconds later reads past the write.
 *
 * A bare readiness TIMEOUT (the operator never died, it just never became
 * ready — e.g. a real migration hang) is a DIFFERENT failure class a respawn
 * won't fix, so it is deliberately NOT retried — failing fast there beats
 * silently doubling the boot budget on a non-transient hang.
 */
export async function spawnGymOperatorWithRetry(opts: SpawnGymOperatorWithRetryOpts): Promise<ChildProcess> {
  const maxAttempts = opts.maxAttempts ?? 2;
  const spawnFn = opts.spawnFn ?? nodeSpawn;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const child = spawnFn(opts.command, opts.args, opts.spawnOptions);
    try {
      await waitForOperatorReady({
        baseUrl: opts.baseUrl,
        child,
        timeoutMs: opts.timeoutMs,
        logPath: opts.logPath,
        pollMs: opts.pollMs,
      });
      return child;
    } catch (err) {
      lastErr = err;
      // Best-effort cleanup of the failed attempt's process (group — callers
      // spawn with `detached: true`, so the pid is a process-group leader).
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
      const exitedDuringBoot = err instanceof Error && /^gym-operator exited during boot/.test(err.message);
      if (!exitedDuringBoot || attempt >= maxAttempts) throw err;
      opts.onRetry?.(err as Error, attempt);
    }
  }
  throw lastErr;
}

export async function waitForOperatorReady(opts: WaitForOperatorReadyOpts): Promise<void> {
  const pollMs = opts.pollMs ?? 1000;
  const deadline = Date.now() + opts.timeoutMs;
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null =
    opts.child && opts.child.exitCode !== null ? { code: opts.child.exitCode, signal: null } : null;
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    exited = { code, signal };
  };
  opts.child?.once('exit', onExit);
  try {
    let readyRouteAbsent = false;
    for (;;) {
      if (exited) {
        throw new Error(
          `gym-operator exited during boot (code=${exited.code}, signal=${exited.signal ?? 'none'})${bootLogTail(opts.logPath)}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `gym-operator not ready on ${opts.baseUrl} within ${Math.round(opts.timeoutMs / 1000)}s${bootLogTail(opts.logPath)}`,
        );
      }
      try {
        if (readyRouteAbsent) {
          // Pinned checkout predates /api/health/ready — legacy liveness probe.
          const r = await fetch(`${opts.baseUrl}/llms.txt`, { signal: AbortSignal.timeout(3000) });
          if (r.status > 0) return;
        } else {
          const r = await fetch(`${opts.baseUrl}/api/health/ready`, { signal: AbortSignal.timeout(3000) });
          if (r.status === 404) {
            readyRouteAbsent = true;
            continue; // re-probe immediately via the fallback
          }
          if (r.ok) return;
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally {
    opts.child?.removeListener('exit', onExit);
  }
}
