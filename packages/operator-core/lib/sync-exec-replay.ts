/**
 * WI-10005261: run a SYNCHRONOUS, exec-injected probe without blocking the event loop.
 *
 * Several read-only probes (`checkActiveCheckpointRun`, `currentCheckpointCandidate`, …) are
 * written as sync functions that take an injected `ExecSyncLike`. Handing them a `spawnSync`
 * exec from an operator tool handler blocks the main thread for every git/systemctl call: a
 * sentinel profile (stall-1790903715731, 2026-10-02T01:15Z) attributed 98.6% of one event-loop
 * stall to `realResolveGateCandidates` doing exactly that. Main-thread stalls are what the
 * sentinel wedge-kills the host for, dropping every MCP session on it.
 *
 * Record/replay instead of a rewrite: the probe runs unchanged against an exec that answers
 * ONLY from a cache. The first call it cannot answer is recorded and gets a placeholder
 * failure result; that pass's return value is discarded, the recorded call runs ASYNC
 * (`execFile`), and the probe re-runs from the top with one more answer cached. A pass that
 * makes no uncached call is a complete, faithful execution: every exec call in it returned the
 * real result, in the same order a sync run would have issued them.
 *
 * Preconditions (the caller's responsibility): the probe must be side-effect free apart from
 * its exec calls, because it runs once per distinct exec call. Read-only git/systemctl probes
 * qualify. Only the first miss per pass is fetched, because later calls in that pass branch on a
 * placeholder and may never be issued by a real run.
 */
import { execFile, type ExecSyncOptions } from 'node:child_process';

import { pinModuleState } from '@papercusp/module-singleton';

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Structurally identical to release-checkpoint-launch's `ExecSyncLike`. */
export type ReplayExecSync = (cmd: string, args: string[], options?: ExecSyncOptions) => ExecResult;

export type AsyncExec = (cmd: string, args: string[], options?: ExecSyncOptions) => Promise<ExecResult>;

/** Generous bound: real probes issue ~2-8 distinct calls; a probe that keeps inventing new ones is a bug. */
export const SYNC_EXEC_REPLAY_MAX_PASSES = 32;

const PENDING: ExecResult = Object.freeze({ status: null, stdout: '', stderr: 'sync-exec-replay: result pending' });

export class SyncExecReplayExhaustedError extends Error {
  constructor(readonly maxPasses: number) {
    super(`sync-exec-replay: probe still issued uncached exec calls after ${maxPasses} passes`);
    this.name = 'SyncExecReplayExhaustedError';
  }
}

export interface SyncExecReplayResult<T> {
  value: T;
  /** Distinct exec calls actually run (async). */
  execCalls: number;
  /** Probe executions, including the final complete one. */
  passes: number;
}

function callKey(cmd: string, args: readonly string[]): string {
  return JSON.stringify([cmd, args]);
}

export async function runSyncWithAsyncExec<T>(
  probe: (exec: ReplayExecSync) => T,
  asyncExec: AsyncExec,
  opts: { maxPasses?: number } = {},
): Promise<SyncExecReplayResult<T>> {
  const cache = new Map<string, ExecResult>();
  const maxPasses = opts.maxPasses ?? SYNC_EXEC_REPLAY_MAX_PASSES;
  for (let pass = 1; pass <= maxPasses; pass++) {
    const misses: Array<{ cmd: string; args: string[]; options?: ExecSyncOptions }> = [];
    const exec: ReplayExecSync = (cmd, args, options) => {
      const hit = cache.get(callKey(cmd, args));
      if (hit) return hit;
      if (misses.length === 0) misses.push({ cmd, args: [...args], options });
      return PENDING;
    };
    let value: T;
    try {
      value = probe(exec);
    } catch (err) {
      // A throw on a placeholder result is an artefact of an incomplete pass; a throw on a
      // complete pass is the probe's real behaviour and must surface.
      if (misses.length === 0) throw err;
      value = undefined as T;
    }
    const miss = misses[0];
    if (!miss) return { value, execCalls: cache.size, passes: pass };
    cache.set(callKey(miss.cmd, miss.args), await asyncExec(miss.cmd, miss.args, miss.options));
  }
  throw new SyncExecReplayExhaustedError(maxPasses);
}

/**
 * Async exec with `spawnSync`-compatible result semantics: `status` is the exit code, or null
 * when the child was killed (timeout) or never started (ENOENT). Never rejects.
 */
export function execFileResult(cmd: string, args: string[], options: { timeout?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', timeout: options.timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ status: 0, stdout, stderr });
        const code = (err as { code?: unknown }).code;
        resolve({ status: typeof code === 'number' ? code : null, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

/**
 * EI-24852529885337741: single-flight + short reuse window for READ-ONLY git calls.
 *
 * Every fork of the ~1.7 GB operator costs ~160 ms of synchronous main-thread time (libuv
 * copies the page tables), however the child is awaited. A 600 s execve census of :3170
 * (2026-10-02 08:02-08:12Z) counted 560 forks; 191 were these probes' git reads
 * (`rev-parse HEAD`, `show -s --format=%ct`, `rev-list -1 --before=…`, `rev-parse --verify
 * ready`), arriving in bursts of 4-9 identical calls within ~1 s from concurrent callers. Replaying
 * the census through a 2 s memo keyed on the exact argv leaves 45 of the 191.
 *
 * A reused answer is at most `ttlMs` old. These probes already race the tree they read (git-sync
 * can move HEAD between any two of their calls), so that staleness adds no new class of error.
 * Only git subcommands that never write are shared, and a result with no exit status (timeout,
 * kill, missing binary) is shared only while in flight, never reused afterwards.
 */
export const GIT_READ_MEMO_TTL_MS = 2_000;

const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'rev-parse',
  'show',
  'rev-list',
  'log',
  'merge-base',
  'cat-file',
  'ls-tree',
  'for-each-ref',
]);

/** Above this many entries, a miss first drops every expired one (time-keyed argv never repeats). */
const GIT_READ_MEMO_PRUNE_AT = 64;

/** Index of the git subcommand in `args` (after `-C <dir>` / `-c <k=v>` / `--no-pager`), or -1. */
function gitSubcommandIndex(args: readonly string[]): number {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-C' || a === '-c') {
      i++;
      continue;
    }
    if (a === '--no-pager' || a.startsWith('--git-dir=') || a.startsWith('--work-tree=')) continue;
    return a.startsWith('-') ? -1 : i;
  }
  return -1;
}

/** The git subcommand of `args` (after `-C <dir>` / `-c <k=v>` / `--no-pager`), or null. */
export function gitSubcommand(args: readonly string[]): string | null {
  const i = gitSubcommandIndex(args);
  return i < 0 ? null : args[i]!;
}

/** A full object id, optionally followed by `:<path>` (a blob or tree inside that commit). */
const CONTENT_ADDRESSED_REV = /^[0-9a-f]{40}(?::.*)?$/;

/**
 * True when a read-only git call names ONLY immutable objects: every revision argument before
 * `--` is a full 40-hex id (optionally `<id>:<path>`), and there is at least one. Its answer can
 * never change, so sharing it cannot return a stale result, unlike `rev-parse HEAD` or
 * `ls-tree HEAD`, whose answer moves with every commit. Fail-safe: an option VALUE passed as a
 * separate argument (`-n 5`) does not look like an id, so such a call is reported false.
 */
export function gitReadIsContentAddressed(args: readonly string[]): boolean {
  const at = gitSubcommandIndex(args);
  if (at < 0 || !GIT_READ_SUBCOMMANDS.has(args[at]!)) return false;
  let revisions = 0;
  for (let i = at + 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') break;
    if (a.startsWith('-')) continue;
    if (!CONTENT_ADDRESSED_REV.test(a)) return false;
    revisions++;
  }
  return revisions > 0;
}

export interface GitReadMemoStats {
  hits: number;
  misses: number;
  entries: number;
}

export interface GitReadMemo {
  exec: AsyncExec;
  stats: () => GitReadMemoStats;
}

interface MemoEntry {
  promise: Promise<ExecResult>;
  settledAt: number | null;
}

/** Wrap `exec` so identical read-only git calls share one child (see GIT_READ_MEMO_TTL_MS). */
export function createGitReadMemo(
  exec: AsyncExec,
  opts: { ttlMs?: number; now?: () => number } = {},
): GitReadMemo {
  const ttlMs = opts.ttlMs ?? GIT_READ_MEMO_TTL_MS;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, MemoEntry>();
  let hits = 0;
  let misses = 0;
  const fresh = (e: MemoEntry, t: number) => e.settledAt === null || t - e.settledAt < ttlMs;

  const memoExec: AsyncExec = (cmd, args, options) => {
    const sub = cmd === 'git' ? gitSubcommand(args) : null;
    if (!sub || !GIT_READ_SUBCOMMANDS.has(sub)) return exec(cmd, args, options);
    const key = callKey(cmd, args);
    const t = now();
    const hit = entries.get(key);
    if (hit && fresh(hit, t)) {
      hits++;
      return hit.promise;
    }
    misses++;
    if (entries.size >= GIT_READ_MEMO_PRUNE_AT) {
      for (const [k, e] of entries) if (!fresh(e, t)) entries.delete(k);
    }
    const entry: MemoEntry = { promise: Promise.resolve(PENDING), settledAt: null };
    entry.promise = exec(cmd, [...args], options).then(
      (r) => {
        if (r.status === null) {
          if (entries.get(key) === entry) entries.delete(key);
        } else {
          entry.settledAt = now();
        }
        return r;
      },
      (err: unknown) => {
        if (entries.get(key) === entry) entries.delete(key);
        throw err;
      },
    );
    entries.set(key, entry);
    return entry.promise;
  };

  return { exec: memoExec, stats: () => ({ hits, misses, entries: entries.size }) };
}

/**
 * Per-subsystem override/kill-switch for routing these probes through the spawner sidecar.
 * Shared with git-pipeline-position's realGit, whose reads run on the same hot path.
 */
export const SYNC_EXEC_SIDECAR_ENV = 'PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR';

/** Used only when a caller passes no timeout; the sidecar requires one. */
const SIDECAR_DEFAULT_TIMEOUT_MS = 30_000;

export interface SidecarFirstExecDeps {
  enabled?: () => boolean;
  viaSidecar?: (
    cmd: string,
    args: string[],
    opts: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  local?: AsyncExec;
  noteFallback?: (error: unknown) => void;
}

/**
 * An {@link AsyncExec} that runs the command in the small spawner sidecar when this process
 * is a spawn-offload host (bg-host), else locally. WI-10005145 / P-017: a captured bg-host
 * stall profile (2026-10-06 08:40Z) spent ~365 ms of the stall inside child_process.spawn
 * for realResolveGateCandidates' git reads. execFile is async, but fork cost scales with the
 * multi-GB parent heap and is paid synchronously on the main thread.
 *
 * Fallback rules match the other sidecar callers: a transport rejection or a sidecar
 * infrastructure fault runs the identical command locally (counted via noteSidecarFallback);
 * a child that ran and exited keeps its exit code; a negative code (killed, timed out) maps
 * to `status: null`, as execFileResult reports a killed child.
 */
export function createSidecarFirstExec(deps: SidecarFirstExecDeps = {}): AsyncExec {
  return async (cmd, args, options) => {
    const timeout = typeof options?.timeout === 'number' ? options.timeout : undefined;
    const local = (): Promise<ExecResult> =>
      deps.local ? deps.local(cmd, args, options) : execFileResult(cmd, args, { timeout });
    const mod = deps.viaSidecar && deps.enabled && deps.noteFallback
      ? null
      : await import('./fleet/git-via-sidecar');
    const enabled = deps.enabled ?? (() => mod!.gitSidecarEnabled(SYNC_EXEC_SIDECAR_ENV));
    if (!enabled()) return local();
    const viaSidecar = deps.viaSidecar ?? ((c, a, o) => mod!.runCommandViaSpawnerSidecar(c, a, o));
    const noteFallback = deps.noteFallback ?? ((e: unknown) => mod!.noteSidecarFallback('sync-exec-replay', e));
    let res: { code: number; stdout: string; stderr: string };
    try {
      res = await viaSidecar(cmd, [...args], {
        cwd: process.cwd(),
        timeoutMs: timeout ?? SIDECAR_DEFAULT_TIMEOUT_MS,
        env: process.env,
      });
    } catch (error) {
      noteFallback(error);
      return local();
    }
    if (res.code === -1 && res.stderr.startsWith('spawner sidecar ')) {
      noteFallback(new Error(res.stderr));
      return local();
    }
    return { status: res.code >= 0 ? res.code : null, stdout: res.stdout, stderr: res.stderr };
  };
}

/** One memo per process, pinned so a split module graph cannot halve its hit rate. */
const sharedGitReadMemo = pinModuleState('@papercusp/operator-core.sync-exec-replay.git-read-memo', () =>
  createGitReadMemo(createSidecarFirstExec()),
);

/**
 * `execFileResult` with read-only git calls shared through the process-wide memo. The default
 * async exec for checkpoint probes (release-checkpoint-launch's runCheckpointProbe and
 * git-pipeline-position's realResolveGateCandidates).
 */
export const execFileResultShared: AsyncExec = (cmd, args, options) => sharedGitReadMemo.exec(cmd, args, options);

/** Hit/miss counters of the process-wide memo, for diagnostics. */
export function gitReadMemoStats(): GitReadMemoStats {
  return sharedGitReadMemo.stats();
}
