/**
 * A graceful host restart must not spend a DBOS workflow's recovery budget (WI-10004954).
 *
 * THE MECHANISM (DBOS SDK 4.27.x, pinned by graceful-shutdown-recovery-credit.test.ts):
 *   - Every time a queued workflow is DEQUEUED, the claim flip ENQUEUED→PENDING runs
 *     `recovery_attempts = recovery_attempts + 1` (system_database.js).
 *   - On boot, `recoverPendingWorkflows` re-enqueues every PENDING workflow the executor
 *     owned (`reenqueueWorkflowsForRecovery`), so the next dequeue charges it again.
 *   - The claim refuses a workflow once `claimedAttempts > maxRecoveryAttempts + 1`
 *     (dbos-executor.js) and marks it MAX_RECOVERY_ATTEMPTS_EXCEEDED.
 * So EVERY bg-host restart (a deploy, a dev:restart, a peer reloading its fix) costs each
 * in-flight workflow one attempt. routineFire registers `maxRecoveryAttempts: 5`, so the
 * 24h P-005 bulk-dedup fire dead-lettered at 7 dequeues on 2026-10-01 after a day of
 * routine restarts. Its successor reached 3 dequeues in its first 23 minutes.
 *
 * WHAT maxRecoveryAttempts IS FOR: stopping a POISON workflow (one that takes its process
 * down) from crash-looping the host. A graceful SIGTERM is not that. So a graceful
 * shutdown gives each in-flight workflow back the attempt the next dequeue will charge.
 * Crashes, OOM kills, a memory-watchdog recycle, and SIGKILL still count, so poison
 * protection is unchanged.
 *
 * WHY TWO HALVES (a marker at the signal, the credit at the next boot):
 * The first version ran the PG credit inside the SIGTERM handler. It never landed in
 * production: on 2026-10-01 18:14:25Z bg-host's SIGTERM drain found the event loop under
 * pressure, skipped teardown, and SIGKILLed itself about a second later
 * (host-recycle.ts `gracefulHostRecycle`). The async credit had not settled, so it logged
 * nothing and the in-flight P-005 fire went from 4 to 5 attempts. A shutdown path that
 * may SIGKILL itself at any moment cannot be trusted with a network round-trip.
 * So the signal handler only does a synchronous local write, placed in FRONT of every
 * other listener, and the next boot applies the credit before `DBOS.launch()` recovers
 * anything, on an unloaded process with a fresh connection.
 *
 * WHY A FILE, NOT POSTGRES: the marker must be written synchronously from a signal handler
 * that can be followed by a self-SIGKILL within a second, under event-loop and pool
 * pressure. Postgres is exactly what failed there. The file is consumed (deleted) by the
 * next boot, so it holds no lasting state.
 *
 * BOUNDS: only workflows with an explicit DBOS deadline are credited, so a workflow that
 * somehow keeps provoking graceful restarts still ends at its own deadline (routineFire
 * always has one, `routineFireTimeoutMs`). A marker older than
 * GRACEFUL_SHUTDOWN_MARKER_MAX_AGE_MS, written by another executor, or written by this
 * same process is ignored.
 *
 * FAIL-SAFE: every failure path (no executor id, an unwritable marker, a corrupt or stale
 * marker, a PG error, the statement timeout) leaves the attempt counted, which is the
 * pre-fix behaviour. The marker is deleted BEFORE the credit runs, so one shutdown can
 * never be credited twice.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';

/** The boot-time credit runs before DBOS.launch() on an unloaded process. */
export const GRACEFUL_RECOVERY_CREDIT_STATEMENT_TIMEOUT_MS = 5_000;

/**
 * A marker older than this is not trusted. Covers a slow stop + rebuild + boot; refuses a
 * marker left by a SIGTERM that did not end the process, followed much later by a crash.
 */
export const GRACEFUL_SHUTDOWN_MARKER_MAX_AGE_MS = 30 * 60_000;

export const GRACEFUL_SHUTDOWN_MARKER_SCHEMA = 'dbos-graceful-shutdown-v1';

type CreditSql = Pick<Sql, 'begin'>;

/**
 * Give one recovery attempt back to every PENDING, deadline-bounded workflow owned by
 * `executorId`. Returns the ids credited. Never drops below zero.
 */
export async function creditGracefulShutdownRecoveryAttempts(
  sql: CreditSql,
  executorId: string,
): Promise<string[]> {
  if (!executorId) return [];
  const rows = await sql.begin(async (tx) => {
    await tx.unsafe(
      `SET LOCAL statement_timeout = ${GRACEFUL_RECOVERY_CREDIT_STATEMENT_TIMEOUT_MS}`,
    );
    return tx<{ workflow_uuid: string }[]>`
      UPDATE dbos.workflow_status
         SET recovery_attempts = recovery_attempts - 1
       WHERE executor_id = ${executorId}
         AND status = 'PENDING'
         AND recovery_attempts > 0
         AND workflow_deadline_epoch_ms IS NOT NULL
      RETURNING workflow_uuid`;
  });
  return (rows as unknown as { workflow_uuid: string }[]).map((r) => r.workflow_uuid);
}

export interface GracefulShutdownMarker {
  schema: typeof GRACEFUL_SHUTDOWN_MARKER_SCHEMA;
  executorId: string;
  pid: number;
  signal: 'SIGTERM' | 'SIGINT';
  /** epoch ms */
  at: number;
}

/** `$PAPERCUSP_HOME/run` (default `~/.papercusp/run`). */
export function defaultGracefulShutdownMarkerDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.PAPERCUSP_HOME || join(homedir(), '.papercusp'), 'run');
}

export function gracefulShutdownMarkerPath(dir: string, executorId: string): string {
  return join(dir, `dbos-graceful-shutdown-${executorId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

/** Synchronous and atomic (write a temp file, then rename). Throws on failure. */
export function writeGracefulShutdownMarker(dir: string, marker: GracefulShutdownMarker): string {
  mkdirSync(dir, { recursive: true });
  const path = gracefulShutdownMarkerPath(dir, marker.executorId);
  const tmp = `${path}.${marker.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(marker));
  renameSync(tmp, path);
  return path;
}

type SignalProcess = Pick<
  NodeJS.Process,
  'prependOnceListener' | 'removeListener' | 'listenerCount' | 'kill' | 'pid'
>;

export interface ArmGracefulShutdownMarkerOptions {
  executorId: string;
  /** Defaults to defaultGracefulShutdownMarkerDir(). */
  markerDir?: string;
  /** Injectable for tests; defaults to the real process. */
  proc?: SignalProcess;
  now?: () => number;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/**
 * Arm the graceful-shutdown marker for the process that runs DBOS. Returns a disarm
 * function. Fires at most once.
 *
 * The listener is PREPENDED, so it runs before the host's own drain handler, and it does
 * no async work: the marker is on disk before any other SIGTERM listener starts.
 * Adding a listener suppresses Node's default exit-on-signal, so if this turns out to be
 * the ONLY listener for the signal, it re-raises the signal straight after the write.
 */
export function armGracefulShutdownMarker(opts: ArmGracefulShutdownMarkerOptions): () => void {
  const proc: SignalProcess = opts.proc ?? process;
  const dir = opts.markerDir ?? defaultGracefulShutdownMarkerDir();
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.log(line));
  const warn = opts.warn ?? ((line: string) => console.warn(line));
  let fired = false;

  const handlers: Record<'SIGTERM' | 'SIGINT', () => void> = {
    SIGTERM: () => onSignal('SIGTERM'),
    SIGINT: () => onSignal('SIGINT'),
  };

  const disarm = (): void => {
    proc.removeListener('SIGTERM', handlers.SIGTERM);
    proc.removeListener('SIGINT', handlers.SIGINT);
  };

  function onSignal(sig: 'SIGTERM' | 'SIGINT'): void {
    // `once` already removed THIS signal's handler, so a count of 0 means nobody
    // else will terminate the process for this signal.
    const soleListener = proc.listenerCount(sig) === 0;
    disarm();
    if (fired) return;
    fired = true;
    if (opts.executorId) {
      try {
        const path = writeGracefulShutdownMarker(dir, {
          schema: GRACEFUL_SHUTDOWN_MARKER_SCHEMA,
          executorId: opts.executorId,
          pid: proc.pid,
          signal: sig,
          at: now(),
        });
        log(
          `[dbos-graceful-credit] ${sig}: marked a graceful shutdown of executor ` +
            `${opts.executorId} (${path}); the next boot credits its in-flight workflows`,
        );
      } catch (e) {
        warn(
          `[dbos-graceful-credit] ${sig}: could not write the graceful-shutdown marker, this ` +
            `restart counts as a recovery attempt: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if (soleListener) proc.kill(proc.pid, sig);
  }

  proc.prependOnceListener('SIGTERM', handlers.SIGTERM);
  proc.prependOnceListener('SIGINT', handlers.SIGINT);
  return disarm;
}

export type GracefulShutdownCreditResult =
  | { outcome: 'no-marker' }
  | { outcome: 'invalid'; reason: string }
  | { outcome: 'stale'; ageMs: number }
  | { outcome: 'credited'; ids: string[]; marker: GracefulShutdownMarker };

export interface ConsumeGracefulShutdownCreditOptions {
  sql: CreditSql;
  executorId: string;
  markerDir?: string;
  now?: () => number;
  maxAgeMs?: number;
  /** This process's pid; a marker this process wrote is never trusted. */
  pid?: number;
}

function errCode(e: unknown): string | undefined {
  return e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}

/**
 * Boot half: call BEFORE `DBOS.launch()`. If the previous process of this executor left a
 * fresh graceful-shutdown marker, delete it and credit the executor's in-flight
 * workflows. Every other case leaves the attempt counted.
 */
export async function consumeGracefulShutdownCredit(
  opts: ConsumeGracefulShutdownCreditOptions,
): Promise<GracefulShutdownCreditResult> {
  if (!opts.executorId) return { outcome: 'invalid', reason: 'no executor id' };
  const dir = opts.markerDir ?? defaultGracefulShutdownMarkerDir();
  const path = gracefulShutdownMarkerPath(dir, opts.executorId);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    if (errCode(e) === 'ENOENT') return { outcome: 'no-marker' };
    throw e;
  }
  // Consume first: a failure after this point loses one credit (the pre-fix behaviour)
  // and can never credit the same shutdown twice.
  try {
    unlinkSync(path);
  } catch (e) {
    if (errCode(e) !== 'ENOENT') throw e;
  }

  let marker: GracefulShutdownMarker;
  try {
    marker = JSON.parse(raw) as GracefulShutdownMarker;
  } catch {
    return { outcome: 'invalid', reason: 'unparseable marker' };
  }
  if (!marker || marker.schema !== GRACEFUL_SHUTDOWN_MARKER_SCHEMA) {
    return { outcome: 'invalid', reason: 'unknown marker schema' };
  }
  if (marker.executorId !== opts.executorId) {
    return { outcome: 'invalid', reason: `marker is for executor ${String(marker.executorId)}` };
  }
  if (typeof marker.at !== 'number' || !Number.isFinite(marker.at)) {
    return { outcome: 'invalid', reason: 'marker has no timestamp' };
  }
  if (marker.pid === (opts.pid ?? process.pid)) {
    return { outcome: 'invalid', reason: 'marker was written by this process' };
  }
  const ageMs = (opts.now ?? Date.now)() - marker.at;
  if (ageMs < 0 || ageMs > (opts.maxAgeMs ?? GRACEFUL_SHUTDOWN_MARKER_MAX_AGE_MS)) {
    return { outcome: 'stale', ageMs };
  }
  const ids = await creditGracefulShutdownRecoveryAttempts(opts.sql, opts.executorId);
  return { outcome: 'credited', ids, marker };
}
