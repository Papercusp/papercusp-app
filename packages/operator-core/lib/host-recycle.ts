/**
 * host-recycle.ts — drain-then-exit recycle for the long-running Hono host.
 *
 * The memory-watchdog's onTrip must not bare-`process.exit()`: every booted
 * harness substrate handle holds a Hypercore, a Hyperswarm peer socket, and
 * close-hooks (PG LISTEN connection + outbox-drain timer). Abandoning them on
 * exit leaves swarm sockets lingering until peers time out and LISTEN slots
 * claimed into the next process's window — an EI-127 RSS/resource-leak
 * contributor (audit P-002).
 *
 * `gracefulHostRecycle` tears down the substrate CONCURRENTLY with the HTTP
 * drain (`server.close` waits for in-flight requests), exits only after BOTH
 * complete, and hard-exits after `hardExitMs` if either hangs.
 *
 * WI-3795: a cluster-wide restart/deploy SIGTERMs every worker in the cgroup
 * at once (`[cluster] SIGTERM — draining N worker(s)`); each independently
 * starts this same substrate teardown. Live evidence (2026-07-10, journalctl
 * on papercup-dev-api.service): dozens of these concurrent teardowns crash
 * with `terminate called after throwing an instance of 'Napi::Error'` →
 * SIGABRT, specifically when they land during a host event-loop-lag spike
 * (p99 in the hundreds-of-ms to low-seconds at the moment of the crash burst).
 * That failure mode is a raw C++ exception escaping a native P2P-substrate
 * binding's background thread — it happens BELOW the JS layer, so no
 * try/catch or Promise.race here can catch or bound it once the native close
 * has started (the crash always self-heals via cluster/systemd respawn — no
 * sustained outage — but it's needless SIGABRT churn during every
 * high-load restart). The only lever available at this layer is to not
 * START the risky native close in the first place when we already know the
 * loop is under pressure: `closeSubstrate()` is skipped (not merely bounded)
 * whenever `isSaturated()` reads true at drain time, trading a (pre-existing,
 * already-accepted per this file's own header) socket-lingers-until-peer-
 * timeout cost for avoiding the crash entirely. A full native-level fix needs
 * an attached debugger / core dump on a live repro, which is out of scope for
 * a headless fix — tracked as a follow-up.
 *
 * WI-3848 (a peer's live crash sample) showed this can fire at p95 as low as
 * ~400-700ms — BELOW event-loop-lag-monitor's default 600ms 'critical'
 * threshold for some of that range. So `isSaturated` defaults to
 * `isLoopElevated` (the 'elevated' OR 'critical' band, default >=120ms p95),
 * not the narrower `isLoopSaturated` ('critical' only, >=600ms) — the skip is
 * cheap and the observed crash range starts well below 'critical'.
 */

import { closeAllBootedHarnesses, dropAllReplicationLivenessTracking } from './sync/hyperbee/boot-all';
import { markGracefulDrainInstalled, markShuttingDown, runBeforeHostExitHooks } from './shutdown-state';
import { isLoopElevated } from './event-loop-lag-monitor';
export { installFatalDiagnostics, _resetFatalDiagnosticsForTests, type FatalDiagnosticsOpts } from './process-supervision/fatal-diagnostics';

/** The slice of `@hono/node-server`'s server this helper needs. */
export interface RecycleServerLike {
  close?: (cb?: () => void) => void;
}

export interface GracefulRecycleOpts {
  /**
   * EI-24863236643374267: synchronous work to run right before the process exits
   * (before `killSelf` / `exit`). Default: `runBeforeHostExitHooks` from
   * shutdown-state.ts, where children that must outlive the drain (the spawner
   * sidecar) register their stop. Overridden in tests.
   */
  beforeExit?: () => void;
  server: RecycleServerLike;
  /** Hard-exit backstop if the drain or the substrate teardown hangs. Default 8000. */
  hardExitMs?: number;
  /**
   * Close host-owned process resources (for example PG LISTEN clients) during
   * every recycle path, including when native substrate teardown is skipped.
   * Best-effort: a failure must not prevent the bounded exit path.
   */
  closeAdditionalResources?: () => Promise<unknown>;
  /**
   * Exit code on recycle. NON-ZERO (default 75 = EX_TEMPFAIL) so the host restarts
   * under `Restart=on-failure` as well as `Restart=always` (EI-1613, R4-1). The
   * SIGTERM/deploy drain path is separate and still exits 0 (an intentional stop).
   */
  recycleExitCode?: number;
  /** Test seam — defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Test seam — defaults to `closeAllBootedHarnesses`. */
  closeSubstrate?: () => Promise<unknown>;
  /**
   * Test seam — defaults to `isLoopElevated` (event-loop-lag-monitor.ts): the
   * 'elevated' OR 'critical' band (default p95 >=120ms), NOT the narrower
   * 'critical'-only `isLoopSaturated` (default >=600ms). WI-3795/WI-3848: when
   * the loop is ALREADY under pressure at the moment the drain starts, skip
   * attempting the substrate close entirely (see the WI-3795/WI-3848 note
   * below `closeSubstrate` in this file's header doc — live crash evidence
   * showed this can fire below the 'critical' threshold).
   */
  isSaturated?: () => boolean;
  /**
   * UNCONDITIONALLY skip the native substrate close (independent of
   * `isSaturated`). EI-9649: a MEMORY-watchdog recycle is inherently high-risk
   * for the P2P-substrate teardown — RSS is over the cap precisely because the
   * substrate (Hypercores/Hyperswarm sessions across every booted harness) is
   * large, so tearing that much native state down concurrently is exactly the
   * op that throws the uncaught `Napi::Error` → SIGABRT (same binding root cause
   * as WI-3795/WI-3848/WI-3849). Unlike the SIGTERM/lag paths, a memory recycle
   * can trip while the event loop is NOT yet elevated (RSS crosses the cap in a
   * calm loop), so the `isSaturated` skip does not fire and the risky close runs
   * and crashes the process below the JS layer — turning a routine recycle into
   * a hard crash + webview reconnect flash. Since the process is fully exiting
   * (systemd/supervisor restarts a fresh low-RSS host) the OS reclaims every
   * socket/fd/PG-LISTEN backend on exit anyway; the only cost of skipping is the
   * same "sockets linger until peer timeout" this file already accepts under
   * saturation — strictly cheaper than a SIGABRT. Default false (SIGTERM + lag
   * paths keep their existing `isSaturated`-gated behavior unchanged).
   */
  skipSubstrateTeardown?: boolean;
  /**
   * EI-16949: test seam — defaults to `dropAllReplicationLivenessTracking`
   * (boot-all.ts). Called whenever the REAL substrate teardown is skipped
   * (`skipSubstrateTeardown` or `isSaturated()`), so the pure-JS/PG
   * replication-liveness registry cleanup (which auto-resolves any durable EI
   * a latched stall alarm filed) still runs even though the risky native
   * close does not — see dropAllReplicationLivenessTracking's own doc for the
   * orphaned-EI leak this closes.
   */
  dropReplicationTracking?: () => Promise<unknown>;
  /**
   * EI-10702: once the HTTP drain is done, exit via a NO-CLEANUP hard termination
   * (SIGKILL to self) instead of `process.exit(code)`. `process.exit()` runs Node's
   * environment teardown, and the WI-3849 coredump forensics (see this file's
   * `installFatalDiagnostics` doc) proved the recurring `Napi::Error` → C++
   * `terminate` → SIGABRT (exit 134) is thrown DURING that teardown by a native
   * addon still mapped into the process — onnxruntime-node, @lydell/node-pty, or
   * sharp (the only mapped addons that even link the `Napi::Error` C++ class),
   * from an in-flight AsyncWorker completion / a child-exit callback firing as the
   * env is torn down. Critically, the P2P substrate is NOT the thrower (2 of 4 live
   * coredumps aborted with `closeAllBootedHarnesses()` skipped entirely), so
   * `skipSubstrateTeardown` does not — and cannot — prevent it: EI-9649's mitigation
   * covered the wrong path. A memory-watchdog recycle is fully exiting anyway
   * (systemd/supervisor restarts a fresh low-RSS host; the OS reclaims every
   * socket/fd/thread on exit), so we SIGKILL ourselves — an uncatchable, immediate
   * termination that runs NO env cleanup and NO native destructor/callback, so the
   * abort has no path to fire. The exit becomes deterministic (no coredump, no
   * `terminate called…` stderr, no exit 134). Default false: the SIGTERM/lag paths
   * keep `process.exit` so an intentional deploy stop retains its controllable exit
   * code (they drain cleanly under `Restart=on-failure`/`always` regardless).
   */
  hardExitOnRecycle?: boolean;
  /**
   * Test seam for the no-cleanup hard exit (`hardExitOnRecycle`). Default:
   * `process.kill(process.pid, 'SIGKILL')`. Overridden in tests to assert the
   * recycle takes the no-cleanup path — and so a test never actually SIGKILLs the
   * runner.
   */
  killSelf?: () => void;
  /**
   * Human-readable cause of THIS recycle, folded into the `[host-recycle]
   * hard-exit` log line below. EI-16447: every `hardExitOnRecycle` caller used
   * to share one hardcoded "a memory-watchdog recycle" string regardless of
   * actual trigger — so a SIGTERM drain (`installGracefulShutdown`) or a
   * lag-self-restart recycle logged as if the memory watchdog had tripped.
   * That false attribution sent a real investigation (WI-5434) hours down the
   * wrong path (RSS-leak theories) chasing a restart storm that was actually
   * `papercup-staging-sync.timer`'s by-design 5-minute freshness restart
   * (SIGTERM → `installGracefulShutdown`) tracking git-sync's near-continuous
   * commit cadence. Callers should pass the real cause; default is generic
   * (never assume "memory-watchdog" — that was precisely the bug).
   */
  reason?: string;
}

/**
 * Stop accepting new connections, drain in-flight HTTP, tear down the P2P
 * substrate, then exit with `recycleExitCode` (NON-ZERO, default 75) so systemd
 * restarts the host under `Restart=on-failure` as well as `Restart=always`
 * (EI-1613, R4-1). Never throws; never exits more than once.
 */
export function gracefulHostRecycle(opts: GracefulRecycleOpts): void {
  const hardExitMs = opts.hardExitMs ?? 8000;
  const recycleExitCode = opts.recycleExitCode ?? 75;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const closeAdditionalResources = opts.closeAdditionalResources ?? (async () => {});
  const closeSubstrate = opts.closeSubstrate ?? closeAllBootedHarnesses;
  const isSaturated = opts.isSaturated ?? isLoopElevated;
  const skipSubstrateTeardown = opts.skipSubstrateTeardown ?? false;
  const dropReplicationTracking =
    opts.dropReplicationTracking ?? dropAllReplicationLivenessTracking;
  const hardExitOnRecycle = opts.hardExitOnRecycle ?? false;
  const killSelf =
    opts.killSelf ?? (() => process.kill(process.pid, 'SIGKILL'));
  // EI-16447: identify the ACTUAL trigger in the hard-exit log line — never
  // hardcode "memory-watchdog" here, every hardExitOnRecycle caller shares this
  // path (memory-watchdog trip, SIGTERM/SIGINT drain, lag-self-restart) and a
  // wrong/generic attribution misdirects the next debugging pass (see the
  // `reason` doc above).
  const reason = opts.reason ?? 'a recycle';

  let exited = false;
  const beforeExit = opts.beforeExit ?? runBeforeHostExitHooks;
  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    // EI-24863236643374267: stop children that were kept alive THROUGH the drain
    // (the spawner sidecar serves git off the main thread until here). This is the
    // last point that can act: the SIGKILL below never fires Node's 'exit' event.
    try {
      beforeExit();
    } catch {
      /* runBeforeHostExitHooks already isolates each hook; never block the exit */
    }
    // EI-10702: skip Node's env teardown — that is where a native addon
    // (onnxruntime-node / node-pty / sharp) throws the uncaught Napi::Error →
    // SIGABRT (exit 134). A SIGKILL to self runs no destructor/callback, so the
    // abort cannot fire. Log FIRST (SIGKILL is immediate and won't flush a
    // deferred write), then kill. Fall back to process.exit only if the kill
    // itself throws (never for a self-SIGKILL).
    if (hardExitOnRecycle) {
      console.warn(
        `[host-recycle] hard-exit (SIGKILL self, no native teardown) — ${reason} exits WITHOUT running the Node env teardown that fires the onnxruntime/node-pty/sharp Napi::Error → SIGABRT (EI-10702); the process is fully exiting so the OS reclaims every socket/fd/thread on exit`,
      );
      try {
        killSelf();
        return;
      } catch {
        // SIGKILL failed (should be impossible for self) — fall through to exit.
      }
    }
    exit(code);
  };

  const hardExit = setTimeout(() => exitOnce(recycleExitCode), hardExitMs);
  (hardExit as { unref?: () => void }).unref?.();

  // Process-owned LISTEN clients are independent of the native substrate. Run
  // their explicit close in every path, including saturated/skip-substrate
  // exits where `closeSubstrate` is deliberately not called.
  const additionalResourcesDown = (async () => {
    try {
      await closeAdditionalResources();
    } catch {
      // Best-effort: resource cleanup must never block the bounded recycle.
    }
  })();

  // Substrate teardown starts immediately, concurrent with the HTTP drain —
  // UNLESS the loop is already under pressure (WI-3795/WI-3848): starting the
  // native P2P-substrate close under that condition is what triggers the
  // Napi::Error/SIGABRT crash (observed as low as p95 ~400-700ms, below the
  // 'critical' band), and a bounded/caught wrapper here can't prevent it (the
  // throw escapes below the JS layer). Skipping the attempt trades the same
  // pre-existing "sockets linger until peer timeout" cost this file already
  // accepts for a clean exit instead of a crash.
  // EI-16949: best-effort, never blocks/throws — see dropReplicationTracking's doc.
  const dropReplicationTrackingSafely = async (): Promise<void> => {
    try {
      const dropped = (await dropReplicationTracking()) as unknown;
      const n = Array.isArray(dropped) ? dropped.length : undefined;
      console.warn(
        `[host-recycle] real substrate teardown skipped — still dropped replication-liveness tracking${n !== undefined ? ` for ${n} harness(es)` : ''} so any latched stall alarm's durable EI auto-resolves instead of orphaning open`,
      );
    } catch {
      /* best-effort */
    }
  };

  const substrateDown = (async () => {
    if (skipSubstrateTeardown) {
      console.warn(
        '[host-recycle] skipping substrate teardown (skipSubstrateTeardown) — a memory-watchdog recycle tears down a large substrate that can throw an uncaught Napi::Error/SIGABRT below the JS layer regardless of loop pressure (EI-9649); the OS reclaims sockets/fds/LISTEN backends on exit, so this only defers the same peer-timeout socket-linger already accepted under saturation',
      );
      await dropReplicationTrackingSafely();
      return;
    }
    if (isSaturated()) {
      console.warn(
        '[host-recycle] event loop under pressure at drain time — skipping substrate teardown to avoid the WI-3795/WI-3848 Napi::Error/SIGABRT race (sockets will linger until peer timeout, same as an abandoned-on-crash exit)',
      );
      await dropReplicationTrackingSafely();
      return;
    }
    try {
      await closeSubstrate();
    } catch {
      // best-effort: a teardown failure must never block the recycle
    }
  })();
  const teardownDown = Promise.all([additionalResourcesDown, substrateDown]);

  try {
    if (typeof opts.server.close === 'function') {
      opts.server.close(() => {
        void teardownDown.then(() => {
          clearTimeout(hardExit);
          exitOnce(recycleExitCode);
        });
      });
    }
    // No close fn → nothing drains HTTP; the hard-exit backstop fires after
    // the substrate teardown window.
  } catch {
    void substrateDown.then(() => exitOnce(recycleExitCode));
  }
}

export interface GracefulShutdownOpts {
  server: RecycleServerLike;
  /** Signals that trigger the drain. Default ['SIGTERM', 'SIGINT']. */
  signals?: readonly NodeJS.Signals[];
  /** Test seam — defaults to `process.on`. */
  on?: (sig: NodeJS.Signals, cb: () => void) => void;
  /** Test seam — forwarded to gracefulHostRecycle (defaults to process.exit). */
  exit?: (code: number) => void;
  /** Forwarded to gracefulHostRecycle for process-owned resources such as PG LISTEN clients. */
  closeAdditionalResources?: () => Promise<unknown>;
  /** Test seam — forwarded to gracefulHostRecycle. */
  closeSubstrate?: () => Promise<unknown>;
  /** Test seam — forwarded to gracefulHostRecycle (EI-16949). */
  dropReplicationTracking?: () => Promise<unknown>;
  /** Test seam — forwarded to gracefulHostRecycle (WI-3795 saturated-skip check). */
  isSaturated?: () => boolean;
  /** Forwarded to gracefulHostRecycle (hard-exit backstop). */
  hardExitMs?: number;
  /**
   * Forwarded to gracefulHostRecycle. When true, the process SIGKILLs itself
   * AFTER the HTTP/substrate drain instead of calling process.exit(), so Node's
   * native environment teardown cannot fire the WI-3849 Napi::Error abort.
   * The supervising service is already stopping/restarting and the OS reclaims
   * every remaining native resource. Default false for library callers; the
   * operator host enables it for every real process-exit path.
   */
  hardExitOnRecycle?: boolean;
  /** Test seam for hardExitOnRecycle; forwarded to gracefulHostRecycle. */
  killSelf?: () => void;
  /** Test seam — defaults to console.log. */
  log?: (msg: string) => void;
  /**
   * Override the hard-exit log `reason` (see `GracefulRecycleOpts.reason`).
   * Default: `a <sig> drain (an external stop/restart request — …)`, derived
   * from the actual signal that triggered this drain.
   */
  reason?: string;
}

/**
 * Install the graceful-shutdown drain for the HTTP-serving process (the
 * single-process host + each cluster worker). On the FIRST SIGTERM/SIGINT it
 * stops accepting new connections, drains in-flight HTTP, tears down the
 * substrate, then exits 0 — an INTENTIONAL stop (deploy / `systemctl restart`),
 * distinct from the non-zero memory-watchdog recycle code.
 *
 * Without this, Node's default SIGTERM is an immediate exit that severs in-flight
 * requests, so a deploy restart 502s anything mid-flight (infra-fail-fast P-017).
 * Idempotent: a second signal while draining is ignored (the bounded
 * gracefulHostRecycle owns the hard-exit backstop). Best-effort — never throws.
 */
export function installGracefulShutdown(opts: GracefulShutdownOpts): void {
  const on = opts.on ?? ((sig: NodeJS.Signals, cb: () => void) => void process.on(sig, cb));
  const signals = opts.signals ?? (['SIGTERM', 'SIGINT'] as const);
  const log = opts.log ?? ((m: string) => console.log(m));
  // EI-24863236643374267: tell listeners that run BEFORE ours (a sidecar's SIGTERM
  // hook, registered at spawn time) that this drain will run and stop them at exit.
  markGracefulDrainInstalled();

  let draining = false;
  const drainAndExit = (sig: NodeJS.Signals): void => {
    if (draining) return;
    draining = true;
    // P-005: announce the drain process-wide BEFORE teardown so background work
    // that consults isShuttingDown() (the auto-implement dispatch loop) stops
    // STARTING new minutes-long workers that this drain would SIGKILL mid-fix.
    markShuttingDown();
    log(`[hono-host] ${sig} — draining in-flight HTTP + substrate, then exiting (pid=${process.pid})`);
    gracefulHostRecycle({
      server: opts.server,
      recycleExitCode: 0, // intentional stop, not the non-zero recycle code
      exit: opts.exit,
      closeAdditionalResources: opts.closeAdditionalResources,
      closeSubstrate: opts.closeSubstrate,
      dropReplicationTracking: opts.dropReplicationTracking,
      isSaturated: opts.isSaturated,
      hardExitMs: opts.hardExitMs,
      hardExitOnRecycle: opts.hardExitOnRecycle,
      // EI-16447: a ${sig} here is an EXTERNAL stop request (a deploy,
      // `systemctl restart`, or a timer like papercup-staging-sync's 5-min
      // freshness restart) — NOT the memory watchdog. Say so explicitly; the
      // shared hard-exit log line used to hardcode "memory-watchdog" for every
      // caller and sent a real investigation (WI-5434) chasing a phantom RSS
      // leak for hours when the actual cause was this intentional SIGTERM path.
      reason: opts.reason ?? `a ${sig} drain (an external stop/restart request — deploy, systemctl, or a sync timer — not the memory watchdog)`,
      killSelf: opts.killSelf,
    });
  };

  for (const sig of signals) on(sig, () => drainAndExit(sig));
}
