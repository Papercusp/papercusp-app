/**
 * cluster-fork.ts — P3-2 node:cluster primitive (operator-scalability-event-loop-2026-06-16).
 *
 * The reusable fork / respawn / drain engine for clustering the operator HTTP host:
 * the PRIMARY process runs the background machinery (DBOS / git-sync / substrate —
 * which MUST be exactly one process) and forks N request-only WORKERS that each
 * serve the Hono handler on the SAME port via SO_REUSEPORT (the OS load-balances
 * accepts across them). This module is the deterministic core — who-am-I, fork the
 * fleet, respawn a crashed worker (bounded so a crash-looping worker can't
 * fork-bomb the box), drain on shutdown — with `node:cluster` INJECTED so it
 * unit-tests without spawning real processes.
 *
 * Multi-process-safety is the CALLER's contract (enforced + documented at the call
 * site, not here):
 *   1. PG pool sizing MUST count the workers (boundedOrgPoolMax `expectedProcesses`
 *      = resource-profile.processCount) or the per-process pools multiply past PG
 *      `max_connections` — the exact 2026-06-17 exhaustion this effort began with.
 *   2. Cross-process state (sync-invalidate fan-out, flag-bus, rate-limit-config
 *      bus) MUST ride PG LISTEN/NOTIFY (the pg-listen-hub), not in-proc buses — a
 *      write on worker A is invisible to an SSE stream pinned to worker B otherwise.
 *   3. Single-socket servers (endpoint-IPC, the PTY WS data plane) must run in the
 *      PRIMARY only — but both are desktop-only (off on the server cluster target),
 *      so the server cluster doesn't hit them.
 */
import nodeCluster from 'node:cluster';

export type ClusterRole = 'primary' | 'worker' | 'single';

/** The slice of `node:cluster` this engine needs (injected; the real module
 *  satisfies it structurally). */
export interface ClusterLike {
  readonly isPrimary: boolean;
  fork(env?: Record<string, string>): ClusterWorkerLike;
  on(event: 'exit', cb: (worker: ClusterWorkerLike, code: number, signal: string | null) => void): void;
  // The cluster-lag-watchdog (EI-1598/1608) listens for worker heartbeat IPC on the
  // primary; node:cluster satisfies this structurally. Additive overload — startCluster
  // itself only uses the 'exit' form.
  on(event: 'message', cb: (worker: ClusterWorkerLike, message: unknown) => void): void;
}
export interface ClusterWorkerLike {
  readonly id: number;
  readonly process: { pid?: number };
  kill(signal?: string): void;
  /** IPC send to this worker (structurally satisfied by the real `cluster.Worker`).
   *  EI-8816: the PRIMARY-side half of the booted-handles push-sync — see
   *  `ClusterHandle.broadcast` + `sync/hyperbee/cluster-booted-handles-sync.ts`. */
  send(message: unknown): void;
}

export interface StartClusterOpts {
  /** Request workers to fork. <=1 ⇒ run single-process inline (no fork). */
  workers: number;
  /** Run in the PRIMARY (background machinery) BEFORE forking. Not run in a worker. */
  onPrimary?: () => void;
  /** Run in each WORKER — and in the single process when workers<=1 — to start the
   *  HTTP server (with reusePort so siblings share the port). */
  onWorker: () => void;
  /** Env injected into EVERY forked worker (merged over the inherited env). The
   *  caller sets the worker contract here — `PAPERCUSP_BACKGROUND_WORKERS=0` (a
   *  worker is request-only; the primary owns the background machinery) +
   *  `PAPERCUSP_EXPECTED_OPERATOR_PROCS=<processCount>` (so each worker's PG pools
   *  are sized for the whole fleet, not the box alone). */
  workerEnv?: Record<string, string>;
  /** Injected for tests; defaults to `node:cluster`. */
  cluster?: ClusterLike;
  /** Max automatic respawns of crashed workers (crash-loop guard). Default workers*5.
   *  P-003 (mcp-reliability-hardening-2026-07-11): applied per ROLLING WINDOW
   *  (`respawnWindowMs`), NOT per primary lifetime. The lifetime cap was a shrink
   *  bomb: on a long-lived primary under a lag-recycle storm the budget only ever
   *  counted UP (observed 59/80 burned in one evening, 2026-07-10), and once
   *  exhausted every further worker death PERMANENTLY shrank the serving cluster
   *  until the next deploy restarted the primary. A rolling window still throttles
   *  a crash-loop to the same rate but lets a healthy-again cluster recover. */
  maxRespawns?: number;
  /** Rolling window for the maxRespawns budget (P-003). Default 600_000 (10 min). */
  respawnWindowMs?: number;
  /**
   * Boot-failure backstop (2026-06-25 inconsistent-release MODULE_NOT_FOUND incident).
   * OPT-IN: provide `onUnbootable` to arm it (legacy respawn-budget behavior otherwise).
   * A worker that exits within `bootGraceMs` of being forked never came up; if a whole
   * generation (`workers`) does so and NONE has ever stayed up past the grace window,
   * the build is UNBOOTABLE — respawning just storms (would burn the full `maxRespawns`
   * budget while serving nothing). Stop fast and call `onUnbootable` so the caller can
   * exit cleanly (letting a supervisor/deploy roll back) instead of flapping. A worker
   * that crashes AFTER surpassing the grace window (proving the build boots) is treated
   * as a normal runtime crash and respawned within budget — `onUnbootable` never fires
   * once any worker has been healthy.
   */
  onUnbootable?: (info: { consecutiveBootFailures: number; lastCode: number; lastSignal: string | null }) => void;
  /** Worker uptime (ms) past which a worker counts as "booted healthy". Default 10_000. */
  bootGraceMs?: number;
  /** Injected clock for the boot-grace measurement; defaults to `Date.now`. */
  now?: () => number;
  log?: (line: string) => void;
}

export interface ClusterHandle {
  role: ClusterRole;
  /** Workers actually forked (0 in single mode / inside a worker). */
  workerCount: number;
  /** PRIMARY only: stop respawning + signal every worker to exit (graceful drain).
   *  Wire to SIGTERM/SIGINT at the call site. No-op in worker/single roles. */
  drain?: (signal?: string) => void;
  /** PRIMARY only: resolve a LIVE forked worker by id (removed on exit), so an external
   *  supervisor (cluster-lag-watchdog, EI-1598/1608) can SIGKILL a wedged worker and let
   *  the respawn handler recover it. Undefined in worker/single roles. */
  workerById?: (id: number) => ClusterWorkerLike | undefined;
  /** PRIMARY only: IPC-send `message` to every currently-LIVE forked worker (best-effort;
   *  a worker mid-exit is silently skipped rather than throwing). EI-8816: lets the primary
   *  push its `listBootedHandles()` snapshot to request-only workers, which otherwise read an
   *  always-empty process-local map (the substrate boot state lives only on the primary) —
   *  see `sync/hyperbee/cluster-booted-handles-sync.ts`. Undefined in worker/single roles. */
  broadcast?: (message: unknown) => void;
  /** PRIMARY only: how many forked workers are LIVE right now (P-003 shrink visibility —
   *  a health surface can compare this against the configured target). Undefined in
   *  worker/single roles. */
  liveWorkerCount?: () => number;
}

/**
 * Resolve the request-worker count from env + the host's recommendation. DEFAULT-OFF
 * (1 = single process): `'auto'`/`'on'`/`'true'` ⇒ `recommendedWorkers`
 * (resource-profile.httpWorkers — itself 1 on a laptop/workstation/embedded-PG host);
 * any positive number, INCLUDING the literal string `'1'`, ⇒ exactly that many workers
 * (so `'1'` means "run exactly one worker", matching what every caller who writes it
 * actually means — see below); unset / `'0'` / `'off'` / `'false'` / junk ⇒ 1. A
 * process-MODEL boot switch (infra), not a runtime feature flag — hence env, not a
 * FLAG (cf. PAPERCUSP_BACKGROUND_WORKERS / PAPERCUSP_UTILITY_HOST). Pure + exported
 * for tests; the caller reads `process.env` + the profile.
 *
 * EI-8817/EI-8818 (2026-07-09): `'1'` used to alias `'auto'`/`'on'`/`'true'` and
 * resolve to `recommendedWorkers` (often the profile's per-core count — 15 on a
 * 128-core box) instead of "one worker". Two different agents independently set
 * `PAPERCUSP_CLUSTER_WORKERS=1` intending a single-process pin and instead triggered a
 * multi-worker fork storm that knocked over the shared dev host twice in one day. No
 * caller in this repo ever set the literal `'1'` intending "auto" (production configs
 * that want the profile recommendation write `'auto'`; the ones that want an explicit
 * worker count write that number, e.g. `'2'`/`'16'`) — so `'1'` now means what it looks
 * like it means, and `'auto'`/`'on'`/`'true'` remain the only spellings of "use the
 * host's recommended worker count".
 */
/**
 * Diagnosability companion to `resolveClusterWorkers` (EI-8818 proposal (c)): names
 * WHICH env var actually drove the resolution (CLUSTER_WORKERS takes precedence over
 * CLUSTER when both are set — the exact thing that made the 2026-07-09 incidents take
 * ~30min of forensics, since a `CLUSTER=0` pin can be silently shadowed) so a boot log
 * line can show it at a glance instead of a responder re-deriving it from source. Pure
 * + exported for tests; call alongside `resolveClusterWorkers` with the same `env`.
 */
export function describeClusterWorkersSource(env: {
  PAPERCUSP_CLUSTER_WORKERS?: string;
  PAPERCUSP_CLUSTER?: string;
}): string {
  if (env.PAPERCUSP_CLUSTER_WORKERS != null) return `PAPERCUSP_CLUSTER_WORKERS=${env.PAPERCUSP_CLUSTER_WORKERS}`;
  if (env.PAPERCUSP_CLUSTER != null) return `PAPERCUSP_CLUSTER=${env.PAPERCUSP_CLUSTER}`;
  return 'unset (default: 1 worker)';
}

export function resolveClusterWorkers(
  env: { PAPERCUSP_CLUSTER_WORKERS?: string; PAPERCUSP_CLUSTER?: string },
  recommendedWorkers: number,
): number {
  const raw = env.PAPERCUSP_CLUSTER_WORKERS ?? env.PAPERCUSP_CLUSTER;
  if (!raw || raw === '0' || raw === 'off' || raw === 'false') return 1;
  if (raw === 'auto' || raw === 'on' || raw === 'true') {
    return Math.max(1, Math.floor(Number.isFinite(recommendedWorkers) ? recommendedWorkers : 1));
  }
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : 1; // 0<x<1 floors to 0 ⇒ fall back to 1 ('1' ⇒ 1 worker, exactly
}

/**
 * The PG-pool-budget divisor (R1 — infra-perf-robustness-audit-2026-06-18): the count
 * of operator processes that SHARE this Postgres, so each process sizes its org pools
 * for `pool·procs ≤ max_connections` and can't multiply into the 2026-06-17 exhaustion.
 *
 * The bug it fixes: a clustered EMBEDDED-PG host took the divisor straight from
 * `resource-profile.processCount`, which pins to ~1 there (httpWorkers clamps to 1) — so
 * each pool was sized for ~1 proc and ballooned (≈68 conns held across 3 cluster procs
 * that each used <10 → ~89% saturation, the audit's R1). Size for the REAL cluster
 * topology — `clusterWorkers + 1` (the N request workers + the one background primary) —
 * never fewer than the profile's own count, and honor an explicit operator override (the
 * systemd drop-in, which may RAISE it to also count co-resident staging/aux operators on
 * the box). `max(...)` guarantees the divisor is never SMALLER than the processes that
 * actually exist — shrinking it is what re-creates the over-provisioning.
 *
 * Pure + exported for tests; the caller passes `process.env` + the profile.
 */
export function resolveExpectedOperatorProcs(opts: {
  clusterWorkers: number;
  profileProcessCount: number;
  explicit?: number | string | undefined;
}): number {
  const clusterProcs = opts.clusterWorkers > 1 ? Math.floor(opts.clusterWorkers) + 1 : 1;
  const profile =
    Number.isFinite(opts.profileProcessCount) && opts.profileProcessCount > 0
      ? Math.floor(opts.profileProcessCount)
      : 1;
  const explicit = Number(opts.explicit);
  return Math.max(
    profile,
    clusterProcs,
    Number.isFinite(explicit) && explicit > 0 ? Math.floor(explicit) : 0,
  );
}

export function startCluster(opts: StartClusterOpts): ClusterHandle {
  const cluster = opts.cluster ?? (nodeCluster as unknown as ClusterLike);
  const log = opts.log ?? ((m) => console.log(m));
  const workers = Math.max(1, Math.floor(Number.isFinite(opts.workers) ? opts.workers : 1));

  // Single-process: forking one worker buys nothing — run both roles inline.
  if (workers <= 1) {
    opts.onPrimary?.();
    opts.onWorker();
    return { role: 'single', workerCount: 0 };
  }

  // A forked worker: serve requests only (the background machinery is the primary's).
  if (!cluster.isPrimary) {
    opts.onWorker();
    return { role: 'worker', workerCount: 0 };
  }

  // Primary: background machinery first, then fork + supervise the request fleet.
  opts.onPrimary?.();
  const maxRespawns = opts.maxRespawns ?? workers * 5;
  const now = opts.now ?? Date.now;
  const bootGraceMs = opts.bootGraceMs ?? 10_000;
  const forked: ClusterWorkerLike[] = [];
  // Live id → worker, for drain (kill all) + the watchdog's workerById lookup. Removed
  // on exit so the lookup never hands back a dead worker (the respawn gets a fresh id).
  const byId = new Map<number, ClusterWorkerLike>();
  // id → fork timestamp, for the boot-failure backstop's grace measurement.
  const forkedAt = new Map<number, number>();
  const track = (w: ClusterWorkerLike): ClusterWorkerLike => {
    forked.push(w);
    byId.set(w.id, w);
    forkedAt.set(w.id, now());
    return w;
  };
  // P-003: rolling respawn budget — epoch-ms of respawns inside the current window.
  const respawnWindowMs = opts.respawnWindowMs ?? 600_000;
  const respawnTimes: number[] = [];
  let draining = false;
  let refillTimer: ReturnType<typeof setTimeout> | undefined;
  const pruneRespawnWindow = (): void => {
    while (respawnTimes.length && now() - respawnTimes[0] > respawnWindowMs) respawnTimes.shift();
  };
  const scheduleRefill = (): void => {
    if (refillTimer || draining || unbootable || maxRespawns <= 0 || byId.size >= workers) return;
    const oldest = respawnTimes[0];
    const delay = oldest == null ? 1 : Math.max(1, oldest + respawnWindowMs + 1 - now());
    refillTimer = setTimeout(() => {
      refillTimer = undefined;
      if (draining || unbootable) return;
      pruneRespawnWindow();
      while (byId.size < workers && respawnTimes.length < maxRespawns) {
        respawnTimes.push(now());
        track(cluster.fork(opts.workerEnv));
      }
      if (byId.size < workers) scheduleRefill();
    }, delay);
    refillTimer.unref?.();
  };
  // Boot-failure backstop state (armed only when opts.onUnbootable is set).
  let sawHealthy = false; // any worker has surpassed bootGraceMs (the build CAN boot)
  let consecutiveBootFailures = 0; // workers that exited inside the grace window, no healthy yet
  let unbootable = false; // gave up — stop respawning

  for (let i = 0; i < workers; i++) track(cluster.fork(opts.workerEnv));

  cluster.on('exit', (worker, code, signal) => {
    byId.delete(worker.id);
    const startedAt = forkedAt.get(worker.id);
    forkedAt.delete(worker.id);
    if (draining) return; // intentional shutdown — let workers go
    if (unbootable) return; // already declared the build unbootable — stop forking into the wall

    // Boot-failure backstop: distinguish a boot-time failure (exited within the grace
    // window, never came up) from a runtime crash (was healthy, then died → respawn).
    if (opts.onUnbootable) {
      const uptime = startedAt != null ? now() - startedAt : 0;
      if (uptime >= bootGraceMs) {
        sawHealthy = true;
        consecutiveBootFailures = 0;
      } else if (!sawHealthy) {
        consecutiveBootFailures += 1;
        if (consecutiveBootFailures >= workers) {
          unbootable = true;
          log(
            `[cluster] FATAL: ${consecutiveBootFailures} worker(s) exited within ${bootGraceMs}ms of fork ` +
              `and none ever stayed up — the build appears UNBOOTABLE (MODULE_NOT_FOUND / a boot-time throw). ` +
              `Halting the respawn storm (would have burned ${maxRespawns} respawns). last exit code=${code} signal=${signal}`,
          );
          opts.onUnbootable({ consecutiveBootFailures, lastCode: code, lastSignal: signal });
          return; // do NOT respawn — the caller decides what to do (exit/alert)
        }
      }
    }

    // P-003: prune the rolling window, then decide. A deny is NOT permanent —
    // once the window drains, the next exit respawns again (the cluster can
    // RECOVER its full size instead of shrinking until the next deploy).
    pruneRespawnWindow();
    if (respawnTimes.length >= maxRespawns) {
      log(
        `[cluster] ALARM worker ${worker.id} exited (code=${code} signal=${signal}); respawn budget exhausted ` +
          `(${respawnTimes.length}/${maxRespawns} respawns in the last ${Math.round(respawnWindowMs / 1000)}s) — NOT respawning now; ` +
          `serving ${byId.size}/${workers} workers (resumes when the window drains)`,
      );
      scheduleRefill();
      return;
    }
    respawnTimes.push(now());
    log(`[cluster] worker ${worker.id} exited (code=${code} signal=${signal}); respawning (${respawnTimes.length}/${maxRespawns} in window)`);
    track(cluster.fork(opts.workerEnv));
  });

  return {
    role: 'primary',
    workerCount: workers,
    drain(signal = 'SIGTERM') {
      draining = true;
      if (refillTimer) clearTimeout(refillTimer);
      refillTimer = undefined;
      for (const w of forked) {
        try {
          w.kill(signal);
        } catch {
          /* worker already gone */
        }
      }
    },
    workerById: (id) => byId.get(id),
    liveWorkerCount: () => byId.size,
    broadcast(message) {
      for (const w of byId.values()) {
        try {
          w.send(message);
        } catch {
          /* worker gone / channel closed — best-effort */
        }
      }
    },
  };
}
