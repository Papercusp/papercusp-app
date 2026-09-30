/**
 * Run `git` in the SPAWNER SIDECAR instead of forking it from this process.
 *
 * ## Why this exists (EI-18808838427010743 — measured, not theorised)
 *
 * `fork()` must copy the calling process's page tables, so the parent-side cost
 * of `child_process.spawn` scales with the PARENT's RSS — and it is charged as
 * SYNCHRONOUS system time on the main thread, i.e. it blocks the event loop.
 * Measured on this box, 50× `git rev-parse` while varying only parent RSS:
 *
 * | parent RSS | parent cost per spawn | user | sys    |
 * |------------|-----------------------|------|--------|
 * | 105 MB     | 3.44 ms               | 0.99 | 2.45   |
 * | 575 MB     | 15.92 ms              | 0.79 | 15.13  |
 * | 1621 MB    | 56.23 ms              | 0.84 | 55.39  |
 * | 3194 MB    | 126.37 ms             | 1.16 | 125.21 |
 *
 * ≈ **40 ms of blocked event loop per GB of parent RSS**, essentially all
 * kernel time. The bg-host runs at ~4.2 GB, so every `git` call there cost
 * ~165 ms of dead loop — for commands git itself completes in ~4 ms (~97%
 * pure overhead, imposed by the caller's own footprint).
 *
 * A 150s CPU profile of the live bg-host showed the consequence: bursts at 98%
 * main-thread busy with **83% of it inside `spawn()`**, 32% duty cycle, and
 * multi-second stretches where the loop was effectively dead. That is what was
 * killing p2p peer sockets mid-transfer (EI-18808621019872598): UDX/hyperswarm
 * keepalives and timers cannot fire while the loop is blocked.
 *
 * Routing through the sidecar removes the fork from the big process entirely:
 * the sidecar is a small, long-lived process, so ITS fork is cheap (~3 ms), and
 * the caller pays only a Unix-socket round-trip. The child `git` runs exactly
 * as before — same argv, same cwd, same env, same output.
 *
 * ## Why here
 *
 * `harness/git-sync/run-git-sync.ts` already did this for the git-sync runner;
 * `sync/pot-git/storage.ts` did not, which is why the p2p path kept paying the
 * tax. Rather than fork the helper into a second copy, it is lifted here so
 * there is ONE implementation both import (repo convention: reuse-first —
 * extend, don't fork).
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pinModuleState } from '@papercusp/module-singleton';

import { isSidecarEnabledFromEnv } from '../process-supervision/sidecar-spawn-shared';
import { SPAWNER_SOCKET_ENV, resolveSpawnerSocketPath } from './spawner-socket-path';
import type { SpawnerCallOpts } from './spawner-ipc-client';
import { reapDeadSidecar, sidecarContainmentCurrent, type SidecarContainment } from './sidecar-exec-lifetime';

/** The shape every `RunGit` seam in the repo returns. */
export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The shape the STDIN seam returns — `stdout` is a **Buffer**, deliberately.
 *
 * `cat-file --batch` frames its output as
 * `<oid> SP <type> SP <size> LF <contents> LF`, so walking the frames needs
 * exact BYTE offsets; decoding to a string first shifts every offset on any
 * non-ASCII content and desynchronises the whole stream. Kept as a SEPARATE
 * type rather than widening `GitRunResult.stdout` to `string | Buffer`, which
 * would force every existing caller to narrow for a case it never sees.
 */
export interface GitStdinRunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/**
 * Memoised module handles.
 *
 * The dynamic `import()`s MUST NOT be re-done per call. Under `tsx` a dynamic
 * import goes through the ESM loader hooks and blocks on a SYNCHRONOUS
 * loader-thread round-trip (`makeSyncRequest`) — measured at 7.09% of the
 * bg-host main thread in the same profile that found the fork cost. Re-importing
 * on every git call would hand back a slice of the very stall this module
 * exists to remove.
 */
let sidecarModulesPromise: Promise<{
  spawnSpawnerSidecar: () => Promise<unknown>;
  SpawnerIpcClient: new (socketPath?: string) => {
    call<T>(method: string, params: unknown, opts?: SpawnerCallOpts): Promise<T>;
    close(): void;
  };
  getSpawnerIpcClient: () => {
    call<T>(method: string, params: unknown, opts?: SpawnerCallOpts): Promise<T>;
  };
}> | null = null;

function loadSidecarModules(): NonNullable<typeof sidecarModulesPromise> {
  if (!sidecarModulesPromise) {
    sidecarModulesPromise = (async () => {
      const [{ spawnSpawnerSidecar }, { getSpawnerIpcClient, SpawnerIpcClient }] = await Promise.all([
        import('./spawner-sidecar-spawn'),
        import('./spawner-ipc-client'),
      ]);
      return { spawnSpawnerSidecar, getSpawnerIpcClient, SpawnerIpcClient } as never;
    })().catch((e) => {
      // Never cache a failed load — a transient failure must not permanently
      // pin every future call onto the local-spawn fallback.
      sidecarModulesPromise = null;
      throw e;
    });
  }
  return sidecarModulesPromise;
}

/**
 * SPAWN-OFFLOAD HOST marker (WI-10002709).
 *
 * The per-site opt-in vars below made every NEW sidecar-capable site default to a
 * LOCAL fork on any host that did not also set the global
 * `PAPERCUSP_SPAWNER_SIDECAR=1`. The bg-host sets the global var; the request
 * operator (`hono-host.ts`, :3070/:3170) never did — it opted in two sites by
 * name (the WI-7160 drop-in: DEV_DEPLOY + SYSTEM_HEALTH). So git-pipeline-position,
 * git-pipeline-hives, harness docs, git-sync and pot-git all kept forking from a
 * ~2 GB cluster worker, and every site added later for the bg-host silently stayed
 * local there. Measured on :3070 2026-09-23: the synchronous part of an async
 * `spawn()` is ~240 ms p50 at 2 GB RSS (vs ~2 ms at 40 MB), and spawn self-time
 * under gitPipelinePosition + probeServiceStart was ~45% of main-thread samples in
 * one sentinel window.
 *
 * The fix is a HOST property, not a per-site one: the request host declares itself
 * with {@link markSpawnOffloadHost} at boot, and then every seam defaults to the
 * sidecar there. It is deliberately IN-MEMORY and never an env var: an env var is
 * inherited by every agent shell / test run that host spawns (terminal-spawn only
 * scrubs the per-site vars), and routing THOSE through a possibly-degraded sidecar
 * is the WI-37487 flake class. Pinned so a split module record cannot give the
 * boot code and a seam two different answers.
 */
const __spawnOffloadHost = pinModuleState<{ marked: boolean }>(
  '@papercusp/operator-core.fleet.git-via-sidecar.spawn-offload-host',
  () => ({ marked: false }),
);

/** Declare THIS process a spawn-offload host (the request operator). Idempotent. */
export function markSpawnOffloadHost(): void {
  __spawnOffloadHost.marked = true;
}

/** Whether {@link markSpawnOffloadHost} was called in this process. */
export function isSpawnOffloadHost(): boolean {
  return __spawnOffloadHost.marked;
}

/** Test-only: undo {@link markSpawnOffloadHost}. */
export function resetSpawnOffloadHostForTest(): void {
  __spawnOffloadHost.marked = false;
}

/**
 * Is the spawner sidecar enabled for this caller?
 *
 * Precedence, first match wins:
 *   1. `PAPERCUSP_SPAWNER_SIDECAR_MODE=1` → OFF (this IS the sidecar; never recurse).
 *   2. `explicitVar` set → as set. The caller's own opt-in/opt-out override,
 *      letting one subsystem be switched independently while a change is being
 *      rolled out or bisected (and the kill-switch for this default).
 *   3. `PAPERCUSP_SPAWNER_SIDECAR=1` → ON (the bg-host).
 *   4. Otherwise ON iff this process is a {@link markSpawnOffloadHost marked}
 *      spawn-offload host AND a spawner socket is already established for it
 *      (`PAPERCUSP_SPAWNER_IPC_SOCKET`, pinned at boot for a clustered host or set
 *      by the first sidecar spawn). The socket condition keeps a single-process
 *      host that has never needed a sidecar (the desktop) from spawning one just
 *      for git; the marker keeps inherited env from turning children on.
 */
export function gitSidecarEnabled(
  explicitVar?: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const modeVar = 'PAPERCUSP_SPAWNER_SIDECAR_MODE';
  if (env[modeVar] === '1') return false;
  if (explicitVar && env[explicitVar] != null) {
    return isSidecarEnabledFromEnv({ enableVar: 'PAPERCUSP_SPAWNER_SIDECAR', modeVar, explicitVar }, env);
  }
  if (isSidecarEnabledFromEnv({ enableVar: 'PAPERCUSP_SPAWNER_SIDECAR', modeVar }, env)) return true;
  return isSpawnOffloadHost() && Boolean(env[SPAWNER_SOCKET_ENV]?.trim());
}

/**
 * Sidecar-fallback accounting (EI-18808838427010743).
 *
 * {@link runGitViaSpawnerSidecar} REJECTS when the sidecar is unreachable, and
 * every caller is expected to catch that and fall back to a local spawn — by
 * design, so a sidecar fault degrades performance instead of breaking git.
 *
 * That design has a hole, and it is the reason this exists: the degradation is
 * precisely the ~40 ms/GB fork stall this whole subsystem was built to remove.
 * From a 5.4 GB bg-host that is ~165 ms of dead event loop on EVERY git call —
 * the original CRITICAL condition, silently restored. Each call site used to
 * log once per distinct reason, which makes a sidecar that has been down for an
 * hour indistinguishable from one that blipped once at boot: the only evidence
 * is a single old log line. A mitigation whose failure is unobservable is not a
 * fix, so every fallback is COUNTED, here, in the one module all call sites
 * already import — not in seven private warn-once sets.
 *
 * Counting is the point rather than logging: a RATE is what separates "one
 * transient reconnect" from "every git call is paying 165 ms right now".
 */
export interface SidecarFallbackSubsystemStats {
  readonly count: number;
  readonly firstAtMs: number;
  readonly lastAtMs: number;
  readonly lastReason: string;
}

export interface SidecarFallbackStats {
  readonly total: number;
  readonly bySubsystem: Readonly<Record<string, SidecarFallbackSubsystemStats>>;
}

interface MutableFallbackEntry {
  count: number;
  firstAtMs: number;
  lastAtMs: number;
  lastReason: string;
}

/**
 * PINNED, not a bare module-scoped Map, and the reason is specific to a
 * detector: a split module record gives each copy its own counters, so the
 * reader sees one shard and UNDER-reports. An under-reporting fallback counter
 * reads exactly like a healthy process — the one failure this must not have.
 */
const __sidecarFallbacks = pinModuleState<{
  bySubsystem: Map<string, MutableFallbackEntry>;
  lastWarnAtMs: Map<string, number>;
}>('@papercusp/operator-core.fleet.git-via-sidecar.fallbacks', () => ({
  bySubsystem: new Map(),
  lastWarnAtMs: new Map(),
}));

/**
 * Re-warn cadence per subsystem. The hot ref-read path cannot afford a log line
 * per git call (that cost is itself worth profiling), but silence forever is
 * what hid the regression — so: warn immediately, then at most this often,
 * carrying the cumulative count so a persistent fault stays loud.
 */
const FALLBACK_WARN_INTERVAL_MS = 60_000;

/**
 * Sidecar CIRCUIT BREAKER (WI-10000740).
 *
 * Counting the fallbacks (above) made a dead sidecar VISIBLE; it did not make it
 * CHEAP. Every seam below calls `spawnSpawnerSidecar()` on every git call, and
 * when the sidecar cannot come up — its owner pid is gone, the socket is stale,
 * the respawn window is exhausted — each call waits the FULL startup timeout
 * (10s, `spawner-sidecar-spawn.ts`) before rejecting onto the local fallback.
 * A phase that runs hundreds of sequential git ops then turns into ~10s × N of
 * pure waiting. Measured 2026-09-08 on the papercusp green-checkpoint: the
 * post-suite repair-dispatch phase logged 265+ `Spawner sidecar startup
 * timeout` fallbacks over ~35 min, alive at ~15% of a core, holding the shared
 * run-lock the whole time — so the next verification could not even start.
 *
 * The breaker turns that into a bounded cost: after
 * {@link SIDECAR_BREAKER_TRIP_AFTER} CONSECUTIVE real fallbacks the seams
 * reject IMMEDIATELY (no module load, no spawn attempt, no 10s wait) with a
 * {@link SidecarCircuitOpenError} for {@link SIDECAR_BREAKER_COOLDOWN_MS};
 * then exactly ONE call is let through as a half-open probe (the rest keep
 * short-circuiting while it is in flight); a probe that succeeds CLOSES the
 * breaker, a probe that fails re-opens it for another cooldown. Callers change
 * nothing — the rejection lands in the same `catch` that already falls back to
 * a local spawn, and `noteSidecarFallback` still counts it (a short-circuited
 * call DOES pay the local fork, which is what the counter measures).
 *
 * The breaker is process-global, not per subsystem: there is one sidecar per
 * owner process, so when it is down it is down for every seam. The state is
 * PINNED for the same reason the counters are — a split module record would
 * give each copy its own breaker, and a breaker that never trips because its
 * failures are being counted in another shard reads exactly like a healthy
 * sidecar.
 */
export const SIDECAR_BREAKER_TRIP_AFTER = 3;
export const SIDECAR_BREAKER_COOLDOWN_MS = 60_000;
/**
 * A half-open probe that never reports back (a caller that swallowed the
 * rejection without `noteSidecarFallback`) must not pin the breaker half-open
 * forever: past this age the next call is allowed to probe again.
 */
export const SIDECAR_BREAKER_PROBE_STALE_MS = 2 * SIDECAR_BREAKER_COOLDOWN_MS;

/**
 * The rejection a seam raises while the breaker is open. Distinct class so
 * {@link noteSidecarFallback} can tell a SHORT-CIRCUITED fallback (the breaker
 * working) from a REAL one (the sidecar failing) — only the latter feeds the
 * trip counter, otherwise the breaker would re-trip on its own rejections and
 * never half-open.
 */
export class SidecarCircuitOpenError extends Error {
  readonly code = 'SIDECAR_CIRCUIT_OPEN' as const;
  constructor(readonly retryAfterMs: number) {
    super(
      `spawner sidecar circuit OPEN — skipping the sidecar for ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s ` +
        `(${SIDECAR_BREAKER_TRIP_AFTER} consecutive real fallbacks; local spawn is being used instead)`,
    );
    this.name = 'SidecarCircuitOpenError';
  }
}

interface MutableBreakerState {
  /** Real (non-short-circuited) fallbacks since the last sidecar success. */
  consecutiveFailures: number;
  /** When the breaker last opened; null while closed. */
  openedAtMs: number | null;
  /** When the current half-open probe was let through; null when none is in flight. */
  probeStartedAtMs: number | null;
  /** Lifetime count of closed→open transitions in this process. */
  trips: number;
  /** Lifetime count of calls the breaker short-circuited (each one saved a startup-timeout wait). */
  shortCircuited: number;
}

const __sidecarBreaker = pinModuleState<MutableBreakerState>(
  '@papercusp/operator-core.fleet.git-via-sidecar.breaker',
  () => ({
    consecutiveFailures: 0,
    openedAtMs: null,
    probeStartedAtMs: null,
    trips: 0,
    shortCircuited: 0,
  }),
);

export interface SidecarBreakerSnapshot {
  readonly state: 'closed' | 'open' | 'half-open';
  readonly consecutiveFailures: number;
  readonly openedAtMs: number | null;
  readonly trips: number;
  readonly shortCircuited: number;
  /** ms until the next probe is allowed; 0 when closed or already half-open. */
  readonly retryAfterMs: number;
}

/** The breaker's current state — a health read, never a control. */
export function getSidecarBreakerState(nowMs: number = Date.now()): SidecarBreakerSnapshot {
  const b = __sidecarBreaker;
  let state: SidecarBreakerSnapshot['state'] = 'closed';
  let retryAfterMs = 0;
  if (b.openedAtMs !== null) {
    const elapsed = nowMs - b.openedAtMs;
    if (elapsed < SIDECAR_BREAKER_COOLDOWN_MS) {
      state = 'open';
      retryAfterMs = SIDECAR_BREAKER_COOLDOWN_MS - elapsed;
    } else {
      state = 'half-open';
    }
  }
  return {
    state,
    consecutiveFailures: b.consecutiveFailures,
    openedAtMs: b.openedAtMs,
    trips: b.trips,
    shortCircuited: b.shortCircuited,
    retryAfterMs,
  };
}

/**
 * Gate every sidecar seam: throws {@link SidecarCircuitOpenError} while the
 * breaker is open, lets exactly one probe through once the cooldown has
 * elapsed, and is a no-op while closed. Called BEFORE the module load and the
 * spawn attempt, which is the whole point — nothing that can wait 10s runs
 * behind an open breaker.
 */
function assertSidecarCircuitClosed(nowMs: number = Date.now()): void {
  const b = __sidecarBreaker;
  if (b.openedAtMs === null) return;
  const elapsed = nowMs - b.openedAtMs;
  if (elapsed < SIDECAR_BREAKER_COOLDOWN_MS) {
    b.shortCircuited += 1;
    throw new SidecarCircuitOpenError(SIDECAR_BREAKER_COOLDOWN_MS - elapsed);
  }
  // Cooldown elapsed: half-open. One probe at a time; a stale probe (its caller
  // never reported back) is abandoned rather than pinning us here.
  if (b.probeStartedAtMs !== null && nowMs - b.probeStartedAtMs < SIDECAR_BREAKER_PROBE_STALE_MS) {
    b.shortCircuited += 1;
    throw new SidecarCircuitOpenError(1_000);
  }
  b.probeStartedAtMs = nowMs;
}

/** A sidecar call completed: the sidecar is reachable, so close the breaker. */
function noteSidecarSuccess(): void {
  const b = __sidecarBreaker;
  b.consecutiveFailures = 0;
  b.openedAtMs = null;
  b.probeStartedAtMs = null;
}

/**
 * Record that `subsystem` fell back to a local spawn because the sidecar was
 * unavailable. Safe to call on every fallback — it is two Map operations and,
 * at most once a minute per subsystem, one `console.warn`. A REAL failure
 * (anything but the breaker's own {@link SidecarCircuitOpenError}) also feeds
 * the circuit breaker above.
 */
export function noteSidecarFallback(subsystem: string, e: unknown, nowMs: number = Date.now()): void {
  const reason = e instanceof Error ? e.message : String(e);
  if (!(e instanceof SidecarCircuitOpenError)) {
    const b = __sidecarBreaker;
    b.consecutiveFailures += 1;
    b.probeStartedAtMs = null;
    if (b.consecutiveFailures >= SIDECAR_BREAKER_TRIP_AFTER) {
      // No separate warn here: the trip rides the throttled per-subsystem line
      // below (see `breakerNote`), so the hot path still emits at most one warn
      // per interval — the invariant git-via-sidecar-fallback-stats.test.ts pins.
      if (b.openedAtMs === null) b.trips += 1;
      b.openedAtMs = nowMs;
    }
  }
  const prev = __sidecarFallbacks.bySubsystem.get(subsystem);
  if (prev) {
    prev.count += 1;
    prev.lastAtMs = nowMs;
    prev.lastReason = reason;
  } else {
    __sidecarFallbacks.bySubsystem.set(subsystem, {
      count: 1,
      firstAtMs: nowMs,
      lastAtMs: nowMs,
      lastReason: reason,
    });
  }

  const lastWarnAtMs = __sidecarFallbacks.lastWarnAtMs.get(subsystem);
  if (lastWarnAtMs !== undefined && nowMs - lastWarnAtMs < FALLBACK_WARN_INTERVAL_MS) return;
  __sidecarFallbacks.lastWarnAtMs.set(subsystem, nowMs);

  const entry = __sidecarFallbacks.bySubsystem.get(subsystem)!;
  const since =
    entry.count > 1 ? ` (${entry.count} fallbacks since ${new Date(entry.firstAtMs).toISOString()})` : '';
  const breaker = getSidecarBreakerState(nowMs);
  const breakerNote =
    breaker.state === 'closed'
      ? ''
      : ` [circuit ${breaker.state}: ${breaker.shortCircuited} call(s) skipped the sidecar, trips=${breaker.trips}]`;
  console.warn(`[${subsystem}] spawner-sidecar git unavailable, using local spawn${since}${breakerNote}: ${reason}`);
}

/**
 * Every sidecar fallback recorded in this process. A non-zero, still-CLIMBING
 * count means git calls are currently paying the full fork cost.
 */
export function getSidecarFallbackStats(): SidecarFallbackStats {
  const bySubsystem: Record<string, SidecarFallbackSubsystemStats> = {};
  let total = 0;
  for (const [subsystem, entry] of __sidecarFallbacks.bySubsystem) {
    bySubsystem[subsystem] = { ...entry };
    total += entry.count;
  }
  return { total, bySubsystem };
}

/** Test-only: clear the accounting (and the breaker) between cases. */
export function resetSidecarFallbackStatsForTest(): void {
  __sidecarFallbacks.bySubsystem.clear();
  __sidecarFallbacks.lastWarnAtMs.clear();
  __sidecarBreaker.consecutiveFailures = 0;
  __sidecarBreaker.openedAtMs = null;
  __sidecarBreaker.probeStartedAtMs = null;
  __sidecarBreaker.trips = 0;
  __sidecarBreaker.shortCircuited = 0;
}

/**
 * Execute `git <args>` inside the spawner sidecar. A pre-dispatch failure
 * rejects for local fallback. Signal-bearing calls retain their lifetime on
 * transport loss: they drain before resolving, and a lost result is unknown,
 * never permission to replay. See runCommandViaSpawnerSidecar.
 *
 * The sidecar owns the real kill-timeout; the client timeout is deliberately
 * slack so it cannot race a legitimate timeout RESPONSE coming back.
 */
export async function runGitViaSpawnerSidecar(
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  opts: { idleTimeoutMs?: number; signal?: AbortSignal; onProgress?: () => void } = {},
): Promise<GitRunResult> {
  return runCommandViaSpawnerSidecar('git', args, {
    cwd, timeoutMs, env, idleTimeoutMs: opts.idleTimeoutMs,
    signal: opts.signal, onProgress: opts.onProgress,
  });
}

/**
 * Execute ANY `command <args>` inside the spawner sidecar (WI-10002709) — the
 * same `process:exec` transport the git seam uses, which never restricted the
 * command. For non-git spawns on a request host (systemctl / ps in the systemd
 * probe) that would otherwise fork from the big process.
 *
 * A pre-dispatch problem (circuit open, sidecar unreachable, missing containment)
 * rejects for local fallback via {@link noteSidecarFallback}. Signal-bearing
 * calls recover after dispatch without rejecting into a possible duplicate
 * mutation; calls without a signal retain the legacy transport-error contract.
 * A child that ran and exited non-zero resolves with its code. `code: -1` with stderr
 * starting `spawner sidecar ` is the sidecar's OWN infrastructure fault (handoff /
 * admission / could-not-spawn, see sidecar-exec-process.ts) —
 * {@link isSidecarInfrastructureFault} names it so callers can fall back instead
 * of reporting it as the child's answer.
 */
export async function runCommandViaSpawnerSidecar(
  command: string,
  args: string[],
  opts: {
    cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv; idleTimeoutMs?: number;
    signal?: AbortSignal; onProgress?: () => void;
  },
): Promise<GitRunResult> {
  const aborted = (): GitRunResult => ({ code: -1, stdout: '', stderr: `${command} aborted before sidecar process start` });
  if (opts.signal?.aborted) return aborted();
  assertSidecarCircuitClosed();
  const { spawnSpawnerSidecar, getSpawnerIpcClient, SpawnerIpcClient } = await loadSidecarModules();
  await spawnSpawnerSidecar();
  if (opts.signal?.aborted) return aborted();
  const socketPath = resolveSpawnerSocketPath();
  // A drain revokes one connection. Give a cancellable command its own so it
  // cannot abort other calls multiplexed through the host's shared client.
  const isolated = opts.signal ? new SpawnerIpcClient(socketPath) : null;
  const client = isolated ?? getSpawnerIpcClient();
  let fence: { serverGeneration: string; connectionId: string } | undefined;
  let containment: SidecarContainment | undefined;
  let requestId: number | undefined;
  let cancelSent = false;
  const onAbort = (): void => {
    if (requestId === undefined || cancelSent) return;
    cancelSent = true;
    // This acknowledges a cancel REQUEST only. The process:exec response below
    // remains the exit receipt; callers must wait for it before releasing locks.
    void client.call('spawn:cancel', { requestId }, { timeoutMs: 5_000 }).catch(() => {});
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (isolated) {
      const preflight = await client.call<{
        processExecFence?: typeof fence;
        processExecContainment?: SidecarContainment | null;
      }>('spawn:cancel', {}, { timeoutMs: 5000 });
      fence = preflight.processExecFence;
      containment = preflight.processExecContainment ?? undefined;
      if (!fence?.serverGeneration || !fence.connectionId || !containment || !sidecarContainmentCurrent(containment)) {
        throw new Error('sidecar execution containment unavailable before dispatch');
      }
      if (opts.signal?.aborted) return aborted();
    }
    const res = await client.call<GitRunResult>(
      'process:exec',
      {
        command,
        args,
        cwd: opts.cwd,
        env: opts.env,
        timeoutMs: opts.timeoutMs,
        idleTimeoutMs: opts.idleTimeoutMs,
        ...(fence ? { fence } : {}),
      },
      {
        timeoutMs: opts.timeoutMs + 35_000,
        onOutputActivity: opts.onProgress,
        onRequestId: (id) => {
          requestId = id;
          if (opts.signal?.aborted) onAbort();
        },
      },
    );
    noteSidecarSuccess();
    return res;
  } catch (error) {
    // Before dispatch a rejection is safe for local fallback. Afterwards keep
    // the caller's repository lease until this exact execution cannot run.
    if (!isolated || !fence || !containment || requestId === undefined) throw error;
    isolated.close();
    const unknownResult = (): GitRunResult => ({
      code: -1, stdout: '',
      stderr: 'sidecar execution outcome unavailable after verified process exit; command was not replayed',
    });
    let nextWarning = 0;
    for (;;) {
      const recovery = new SpawnerIpcClient(socketPath);
      try {
        const drained = await recovery.call<{ exitConfirmed: boolean; result: GitRunResult | null }>(
          'process:drain', { ...fence, requestId }, { timeoutMs: 0 },
        );
        if (drained.exitConfirmed === true) return drained.result ?? unknownResult();
      } catch {
        // A reconnect may reach a newer server. Only the old kernel identity
        // and scope, never the new server or a kill acknowledgement, can settle it.
      } finally {
        recovery.close();
      }
      if (await reapDeadSidecar(containment)) return unknownResult();
      if (Date.now() >= nextWarning) {
        console.error('[spawner-sidecar] process exit remains unverified; retaining caller lease', { requestId, fence });
        nextWarning = Date.now() + 60_000;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    isolated?.close();
  }
}

/** True when a sidecar `process:exec` result is the sidecar's own fault, not the child's exit. */
export function isSidecarInfrastructureFault(res: { code: number; stderr: string }): boolean {
  return res.code === -1 && res.stderr.startsWith('spawner sidecar ');
}

/**
 * Per-process directory for the fd-handoff files (WI-6404).
 *
 * `/dev/shm` first (tmpfs — no disk write for a payload that is read and
 * unlinked immediately), falling back to `os.tmpdir()` where it is absent or
 * unwritable. Created 0700 and chmod'ed explicitly, because `mkdir`'s mode is
 * masked by umask and a pre-existing dir keeps its old mode: these files
 * briefly hold repo blob CONTENTS, so they must never be world-readable.
 *
 * Memoised, and never caches a failure — the same discipline
 * {@link loadSidecarModules} applies, and for the same reason: one transient
 * fault must not pin every later call onto the local-spawn fallback.
 */
let handoffDirPromise: Promise<string> | null = null;

function handoffDir(): Promise<string> {
  if (!handoffDirPromise) {
    handoffDirPromise = (async () => {
      const bases = ['/dev/shm', os.tmpdir()];
      let lastErr: unknown;
      for (const base of bases) {
        const dir = path.join(base, `papercusp-git-stdin-${process.pid}`);
        try {
          await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
          await fsp.chmod(dir, 0o700);
          return dir;
        } catch (e) {
          lastErr = e;
        }
      }
      throw new Error(`no writable handoff directory (tried ${bases.join(', ')}): ${String(lastErr)}`);
    })().catch((e) => {
      handoffDirPromise = null;
      throw e;
    });
  }
  return handoffDirPromise;
}

/** Monotonic suffix so concurrent calls in this process cannot collide. */
let handoffSeq = 0;

/**
 * Execute `git <args>` in the spawner sidecar with `stdin` fed to it and the
 * output returned as raw BYTES — the `cat-file --batch` / `--batch-check`
 * family (see {@link GitStdinRunResult} for why bytes).
 *
 * ## Why an fd handoff rather than the JSON line
 *
 * The RPC is line-delimited JSON in both directions, and this seam carries
 * multi-MB blob CONTENTS. Sending them inline would mean base64 (+33% plus
 * escaping) and a multi-MB `JSON.parse` on the MAIN THREAD at both ends —
 * plausibly a bigger stall than the ~165ms fork it removes, which would defeat
 * the entire point (this exists to stop blocking the event loop, so trading a
 * fork stall for a parse stall is self-defeating).
 *
 * So the JSON line stays CONTROL-ONLY (`stdinPath`/`stdoutPath` out;
 * `{ code, stderr, stdoutBytes }` back) and the payload travels out-of-band:
 * git reads and writes real fds at kernel level, and this side picks the
 * output up with an ASYNC `fs.readFile` on the libuv threadpool. Byte fidelity
 * is then structural rather than promised.
 *
 * Rejects on any sidecar problem — callers fall back to a local spawn, so a
 * fault here degrades performance, never correctness.
 */
export async function runGitStdinViaSpawnerSidecar(
  args: string[],
  cwd: string,
  stdin: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<GitStdinRunResult> {
  assertSidecarCircuitClosed();
  const { spawnSpawnerSidecar, getSpawnerIpcClient } = await loadSidecarModules();
  await spawnSpawnerSidecar();
  const dir = await handoffDir();
  const id = `${Date.now().toString(36)}-${(handoffSeq = (handoffSeq + 1) % 0xffffff).toString(36)}`;
  const stdinPath = path.join(dir, `${id}.in`);
  const stdoutPath = path.join(dir, `${id}.out`);
  try {
    // Pre-create BOTH 0600. The output file especially: if the sidecar created
    // it, its mode would follow the sidecar's umask, and it transiently holds
    // blob contents.
    await fsp.writeFile(stdinPath, stdin, { mode: 0o600 });
    await fsp.writeFile(stdoutPath, '', { mode: 0o600 });
    const res = await getSpawnerIpcClient().call<{
      code: number;
      stderr?: string;
      stdoutBytes?: number;
    }>(
      'process:exec',
      { command: 'git', args, cwd, env, timeoutMs, stdinPath, stdoutPath },
      { timeoutMs: timeoutMs + 35_000 },
    );
    const stdout = await fsp.readFile(stdoutPath);
    // A short read here would silently truncate a `--batch` stream and desync
    // the frame walk — which is exactly the corruption this design exists to
    // rule out, so it must fail loudly onto the local fallback, not quietly.
    if (typeof res.stdoutBytes === 'number' && res.stdoutBytes !== stdout.length) {
      throw new Error(
        `spawner sidecar handoff size mismatch: git wrote ${res.stdoutBytes} bytes, read back ${stdout.length}`,
      );
    }
    noteSidecarSuccess();
    return { code: res.code, stdout, stderr: res.stderr ?? '' };
  } finally {
    // Never leave blob contents lying around, on success or failure.
    await fsp.rm(stdinPath, { force: true }).catch(() => {});
    await fsp.rm(stdoutPath, { force: true }).catch(() => {});
  }
}
