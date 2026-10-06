/**
 * operator Hono host — `@hono/node-server`.
 *
 * Serves the operator's full Hono API (`_hono/app.ts`, basePath `/api`) plus
 * the page-namespace handlers (`/wiki`, `/drizzle-studio`). Replaces the Next
 * route shim (`app/api/[[...route]]/route.ts`).
 *
 * Run:  tsx apps/operator/bin/hono-host.ts        (cwd: apps/operator)
 * Port: PAPERCUSP_HONO_PORT (default 3070 — the production operator host).
 *
 * This file is a pure entrypoint — it always boots when executed. The
 * side-effect-free request handler lives in `./host-handler.ts`.
 *
 * Final home (Phase H): moves to `apps/operator-vite/server/` once `_hono/`
 * relocates there. See operator-vite-migration-2026-05-20.md (Phase C/H).
 */
// ZEROTH: cap glibc malloc arenas by re-executing in place when the launcher did
// not (boot-malloc-arena.ts). It reads no flags and loads nothing, so it precedes
// the integrity preflight rather than making every uncapped boot run it twice.
import './boot-malloc-arena';
// MUST be first: runs the release-integrity preflight before the heavy import graph
// (host-bootstrap → @papercusp/plugin-loader → MCP SDK → mem0 …) evaluates, so an
// inconsistent checkout fails fast + named instead of crash-looping every worker on
// MODULE_NOT_FOUND. See boot-integrity-first.ts / the 2026-06-25 incident.
import './boot-integrity-first';
// SECOND: pin the runtime flag-override store install into the module
// evaluation order, BEFORE anything below resolves a flag (WI-4275 — bg-host
// booted every time without the store, so runtime `flags:set` kill-switches
// were silently invisible to background routines). See boot-flag-store.ts.
import './boot-flag-store';
// THIRD: reject a persistent main-port holder before the expensive Hono,
// bootstrap, native-addon, and cluster import graph evaluates.
import './hono-host-port-preflight';
import cluster from 'node:cluster';
import { createAdaptorServer } from '@hono/node-server';
import { listenWithEaddrinuseRetry } from '@papercusp/operator-core/lib/listen-with-eaddrinuse-retry';
import { BOOT_INTEGRITY_EXIT_CODE } from '@papercusp/operator-core/lib/boot-integrity-preflight';
import { runBootstrap, waitForBootMigrationGate } from './host-bootstrap';
import { externalIngressHandler, handler } from './host-handler';
import { externalIngressPort } from '@papercusp/operator-core/lib/auth/forwarded-request-trust';
import { configureIngressListener } from '@papercusp/operator-core/lib/own-tunnel/runtime';
import { markOwnTunnelListenerSeamConfigured } from '@papercusp/operator-core/lib/own-tunnel/service';
import {
  httpServingProcessRole,
  startRemoteAccessReconcilers,
} from '@papercusp/operator-core/lib/remote-access/boot-reconcilers';
import { workspacePinWarning } from '@papercusp/operator-core/lib/workspace-pin-guard';
import { requestOnlyHost } from '@papercusp/operator-core/lib/background-workers';
import { scheduleTranscriptSearchWarmup } from '@papercusp/operator-core/lib/transcript-search-warmup';
import {
  startEventLoopLagMonitor,
  setLagPublishTarget,
} from '@papercusp/operator-core/lib/event-loop-lag-monitor';
import { startLoopPressureGovernor } from '@papercusp/operator-core/lib/loop-pressure-governor';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import {
  startMemoryWatchdog,
  resolveMemoryWatchdogLimitMb,
  resolveMemoryWatchdogProactiveGcMb,
} from '@papercusp/operator-core/lib/memory-watchdog';
import { startEventLoopSentinel } from '@papercusp/operator-core/lib/event-loop-sentinel-host';
import {
  gracefulHostRecycle,
  installGracefulShutdown,
  installFatalDiagnostics,
} from '@papercusp/operator-core/lib/host-recycle';
import { markShuttingDown } from '@papercusp/operator-core/lib/shutdown-state';
// infra-fail-fast P-015 / D2 — canonical loopback-default bind host (locks P-027).
import { resolveBindHost } from '@papercusp/operator-core/lib/resolve-bind-host';
import { assertRemoteAuthReady } from '@papercusp/operator-core/lib/remote-auth-policy';
import { startInfraLivenessAlarm } from '@papercusp/operator-core/lib/system-health/liveness-alarm';
import { startConditionStalenessAlarm } from '@papercusp/operator-core/lib/system-health/condition-staleness-alarm';
import { startEscalationAgingAlarm } from '@papercusp/operator-core/lib/overwatch/escalation-aging-alarm';
import { startRoutineFireCancellationAlarm } from '@papercusp/operator-core/lib/dbos/routine-fire-cancellation-alarm';
import { startLagSelfRestart } from '@papercusp/operator-core/lib/system-health/lag-self-restart';
import {
  startWorkerHeartbeat,
  startClusterLagWatchdog,
  clusterLagWatchdogArmed,
} from '@papercusp/operator-core/lib/system-health/cluster-lag-watchdog';
import {
  startBootedHandlesBroadcaster,
  startWorkerBootedHandlesCache,
} from '@papercusp/operator-core/lib/sync/hyperbee/cluster-booted-handles-sync';
import { startBootedHandlesPgPublisher } from '@papercusp/operator-core/lib/sync/hyperbee/substrate-booted-handles-pg';
import {
  startPrimaryManagedTimersBroadcaster,
  startWorkerPrimaryManagedTimersCache,
} from '@papercusp/operator-core/lib/cluster-managed-timers-sync';
import {
  startWorkerStampPublisher,
  startWorkerStampReceiver,
  startPrimaryStampRelay,
} from '@papercusp/operator-core/lib/agent-state-stamp-cluster';
import {
  startPrimaryOwnerRpcRelay,
  startWorkerOwnerRpc,
  type OwnerRpcClusterLike,
} from '@papercusp/operator-core/lib/cluster-owner-rpc';
import nodeCluster from 'node:cluster';
import { startSinglePrimaryGuard } from '@papercusp/operator-core/lib/system-health/single-primary-check';
import { startPtyWsServer } from '@papercusp/operator-core/lib/pty-ws';
import {
  ensureInvalidationListener,
  stopInvalidationListener,
} from '@papercusp/operator-core/lib/sync-sse';
import { ensureFlagChangeListener } from '@papercusp/operator-core/lib/flag-change-listener';
import { startOperatorStateCacheCoherence } from '@papercusp/operator-core/lib/operator-state-pg';
import {
  startCluster,
  resolveClusterWorkers,
  describeClusterWorkersSource,
  resolveExpectedOperatorProcs,
} from '@papercusp/operator-core/lib/cluster-fork';
import { getResourceProfile } from '@papercusp/operator-core/lib/resource-profile';
import { isBenignHostError } from './host-benign-errors';
import { applyServerTimeouts } from './host-request-deadline';
import { pinSubstrateSocketForCluster } from '@papercusp/operator-core/lib/sync/hyperbee/substrate-socket-path';
import { pinSpawnerSocketForCluster } from '@papercusp/operator-core/lib/fleet/spawner-socket-path';
import { pinLspDaemonSocketForCluster } from '@papercusp/operator-core/lib/code-intelligence/lsp-daemon-socket';
import { pinSetupTokenForCluster } from '@papercusp/operator-core/lib/auth-setup-token';
import { runSubstrateSidecarServer } from '@papercusp/operator-core/lib/sync/hyperbee/substrate-sidecar-server';
import { runSpawnerSidecarServer } from '@papercusp/operator-core/lib/fleet/spawner-sidecar-server';
import { markSpawnOffloadHost } from '@papercusp/operator-core/lib/fleet/git-via-sidecar';
import { runGatewaySidecarMain } from '@papercusp/operator-core/lib/inference-gateway/sidecar-main';
import { runEmbedSidecarServer } from '@papercusp/operator-core/lib/memory/embed-sidecar-server';
import { runLiveHealthMonitorMain } from '@papercusp/operator-core/lib/resource-governor/live-health-monitor-main';
import { runAdmissionPrecheckWorkerFromEnvironment } from '@papercusp/operator-core/lib/release/admission-fix-precheck-managed';
import { assertMobileJwtSecretDurableForCluster } from '@papercusp/operator-core/lib/device-jwt';
import { installStdioPeerGuard } from '@papercusp/operator-core/lib/process-supervision/stdio-peer-guard';
import { notifySystemdReady } from '@papercusp/operator-core/lib/systemd-readiness';

// WI-41422: this entrypoint is also launched directly by desktop-dev/background
// task supervision, bypassing serve.ts (and its stdio guard). If that supervisor
// disappears, stdout/stderr become peer-gone sockets: an unguarded write emits an
// `error`, the process-level uncaughtException handler below diagnoses it through
// console.warn, and the failing diagnostic write recursively re-enters the same
// handler until the main thread and HTTP accept backlog saturate. Reuse the shared
// absorber before ANY sidecar divert or process-level fault handler can write.
// Idempotence makes this safe for the gateway divert, which installs it too.
installStdioPeerGuard();

// WI-3849: arm Node's diagnostic-report-on-SIGABRT as early as possible (before
// the sidecar divert, so every process type this entry can become — main host,
// cluster worker, or any sidecar — gets it) so the next native Napi::Error/
// SIGABRT crash captures a symbolized native+JS stack automatically instead of
// only a bare coredump. See host-recycle.ts's installFatalDiagnostics doc.
installFatalDiagnostics();

// ── EI-8810: sidecar re-exec divert ─────────────────────────────────────────
// The sidecar spawners (substrate / spawner / inference-gateway / embed) re-exec
// THEIR OWN bundle with a *_SIDECAR_MODE env var. On the packaged desktop that
// bundle is serve.mjs, whose main() carries this divert — but on the systemd
// bg-host deployment the bundle is THIS entry (dist-host/hono-host.mjs), which
// ignored the mode vars: the re-exec'd child booted the FULL host with the
// PARENT's inherited PAPERCUSP_HONO_PORT → EADDRINUSE → fatal exit → warm-up
// respawn — the all-day :3270 crash-loop that destabilized the substrate
// primary (2026-07-09, EI-8810). Divert BEFORE any host boot side-effect; each
// sidecar server keeps the process alive. Mirrors serve.ts main() exactly.
const sidecarMode: 'substrate' | 'spawner' | 'gateway' | 'embed' | 'resource-health' | 'lsp' | 'repair-precheck' | null =
  process.env.PAPERCUSP_SUBSTRATE_SIDECAR_MODE === '1'
    ? 'substrate'
    : process.env.PAPERCUSP_SPAWNER_SIDECAR_MODE === '1'
      ? 'spawner'
      : process.env.PAPERCUSP_GATEWAY_SIDECAR_MODE === '1'
        ? 'gateway'
        : process.env.PAPERCUSP_EMBED_SIDECAR_MODE === '1'
          ? 'embed'
          : process.env.PAPERCUSP_LSP_DAEMON_MODE === '1'
            ? 'lsp'
          : process.env.PAPERCUSP_RESOURCE_GOVERNOR_MONITOR_MODE === '1'
            ? 'resource-health'
            : process.env.PAPERCUSP_REPAIR_PRECHECK_WORKER_MODE === '1'
              ? 'repair-precheck'
            : null;
if (sidecarMode === 'substrate') runSubstrateSidecarServer();
if (sidecarMode === 'spawner') runSpawnerSidecarServer();
if (sidecarMode === 'lsp') {
  void import('@papercusp/operator-core/lib/code-intelligence/lsp-daemon-server').then(
    ({ runLspDaemonServer }) => runLspDaemonServer(),
    (error) => { console.error('[lsp-daemon] fatal boot:', error); process.exit(1); },
  );
}
if (sidecarMode === 'gateway') {
  runGatewaySidecarMain().catch((e) => {
    console.error('[inference-gateway] fatal:', e);
    process.exit(1);
  });
}
if (sidecarMode === 'embed') runEmbedSidecarServer();
if (sidecarMode === 'resource-health') {
  runLiveHealthMonitorMain().catch((e) => {
    console.error('[resource-governor-health] fatal:', e);
    process.exit(1);
  });
}
if (sidecarMode === 'repair-precheck') {
  void runAdmissionPrecheckWorkerFromEnvironment().then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error('[release:repair-queue] pre-check worker startup failed', error);
      process.exitCode = 1;
    },
  );
}
// WI-10002709: this process (primary AND every cluster worker — each re-evaluates
// this entry) is a request host whose RSS makes a local fork cost ~240 ms of dead
// event loop, so every sidecar-capable spawn seam should default to the spawner
// sidecar here, not only the two sites a drop-in opted in by name. In-memory on
// purpose (never an env var, which children would inherit); see
// markSpawnOffloadHost. A sidecar-mode process must never mark itself — the
// spawner sidecar executing through itself would recurse.
if (sidecarMode === null) markSpawnOffloadHost();

// Resilience guard: the multi-tenant host must never let ONE bad inbound frame
// crash-loop :3070 for the entire fleet. Two known classes originate inside the
// `mcp-handler` dependency's detached write/parse pump and reach us as unhandled
// rejections we can't try/catch at the call site:
//   • EI-12  — a client disconnects mid-stream → enqueue onto an already-closed
//              ReadableStream controller (ERR_INVALID_STATE).
//   • EI-714 — a malformed JSON-RPC body → a JSON.parse SyntaxError in the pump.
// Both are client-caused + request-scoped (the only casualty should be that one
// request), so SWALLOW them; preserve fail-fast (exit) for everything else so
// real host bugs still surface. Classification lives in host-benign-errors.ts
// (unit-tested) so the predicate set is auditable, not buried inline.
process.on('unhandledRejection', (reason) => {
  if (isBenignHostError(reason)) {
    console.warn(
      '[hono-host] ignored benign client-caused error (request-scoped, host kept alive):',
      (reason as Error)?.message ?? reason,
    );
    return;
  }
  console.error('[hono-host] fatal unhandledRejection — exiting:', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  if (isBenignHostError(err)) {
    console.warn(
      '[hono-host] ignored benign client-caused error (uncaught, host kept alive):',
      err.message,
    );
    return;
  }
  console.error('[hono-host] fatal uncaughtException — exiting:', err);
  process.exit(1);
});

// Port/host: `PAPERCUSP_HONO_PORT`/`PAPERCUSP_BIND_HOST` are the explicit
// knobs (dev). The packaged desktop's Tauri main spawns the sidecar with
// the generic `PORT` it already sets for every sidecar — accept that as a
// fallback so G4 needs no extra env wiring. The bind host is deliberately
// NOT read from `HOSTNAME`: that generic var is routinely the machine's
// name in shells/containers, which silently turned the default into a
// non-loopback bind (audit P-027). Binding off-loopback now requires the
// explicit `PAPERCUSP_BIND_HOST` opt-in. (The packaged desktop set
// HOSTNAME=127.0.0.1 anyway, so it is unaffected.)
const port = Number(
  process.env.PAPERCUSP_HONO_PORT ?? process.env.PORT ?? 3070,
);
const hostname = resolveBindHost();
// P-016 / D-025: an off-loopback listener is never allowed to become reachable
// before its exact HTTPS origin policy exists. This runs before any listen().
const remoteAuthPolicy = assertRemoteAuthReady(hostname);
if (remoteAuthPolicy.remote) {
  console.log(`[hono-host] remote auth policy armed for ${remoteAuthPolicy.origins.length} exact HTTPS origin(s)`);
}

// EI-18734124566158657: a straggling peer process that recently held this exact
// port (another verify-tauri-headless.sh instance mid-teardown, a dev-restart
// still draining, …) can leave it genuinely bound for a few seconds AFTER a
// caller's ss-probe/`fed_pick_free_port` reported it free — the classic
// pick-then-bind TOCTOU race. Today that surfaces as a bare EADDRINUSE 'error'
// event with no listener attached, which Node re-raises as an uncaught
// exception straight into the process-level handler above ("[hono-host] fatal
// uncaughtException — exiting") — instant, no recovery, even though the
// straggler is typically gone within a second or two.
// listenWithEaddrinuseRetry (packages/operator-core/lib) retries a BOUNDED
// number of times with a short fixed delay before giving up: this absorbs a
// transient squatter without masking a genuine, persistent port conflict
// (which still fails — just a few seconds later — with the SAME fatal
// message callers already grep for, e.g. verify-tauri-headless.sh's own
// `EADDRINUSE.*:$DEV_PORT` check).
const LISTEN_RETRY_MAX_ATTEMPTS = Number(process.env.PAPERCUSP_LISTEN_EADDRINUSE_RETRIES ?? 8);
const LISTEN_RETRY_DELAY_MS = Number(process.env.PAPERCUSP_LISTEN_EADDRINUSE_RETRY_MS ?? 1000);

/**
 * Start the request-serving plane: the HTTP server + per-process loop monitors +
 * (opt-in) the PTY WS data plane + the RSS self-recycle watchdog. Runs in EACH
 * cluster worker — and, in single-process mode, in the one process. Everything
 * here is per-process state; the background machinery (runBootstrap) is separate.
 */
function startRequestServers(): void {
  // Export the resolved port so selfUrl() builds correct server-side self-fetch
  // origins inside this host (the operator brain's agentmcp MCP URL, the <spawn>
  // dispatch). Without it selfUrl() falls back to the :3055 dev default — post-
  // Vite-migration :3055 is the frontend SPA, not this API host.
  process.env.PORT = String(port);
  const requestOnly = requestOnlyHost();

  // WI-1547: eagerly start the `sync_invalidate` LISTEN in THIS process. The
  // cache-ECA invalidation (change stream → cache.bumpTags) rides the SSE
  // invalidation bus's single PG LISTEN, which otherwise starts lazily on the
  // first SSE subscribe — a reuseport cluster worker that only ever serves
  // MCP/tool HTTP never subscribes, so its L1 never saw a bump and cachedRead's
  // SWR served arbitrarily stale entries (the plans:get ~45-min-stale flap: 16
  // workers on :3070, exactly ONE holding the LISTEN). Fire-and-forget; the
  // helper retries with backoff and is loud on exhaustion.
  void ensureInvalidationListener();

  // WI-10004071: drop this worker's cached harness_registry / account-pool rows
  // when a SIBLING worker (or any other process) writes them, instead of serving
  // the stale row for the cache TTL. Rides the same sync_invalidate LISTEN.
  void startOperatorStateCacheCoherence().catch((err) => {
    console.warn('[hono-host] operator-state cache coherence did not start (TTL fallback only):', err);
  });

  // WI-6793: subscribe THIS process to cross-process runtime flag flips
  // (pg_notify from flag-override-store.set). Without it, a `flags:set`
  // executed in a peer process never reaches this one's sticky onFlagChange
  // subscribers (workspace-brain-scope's keying latch held a pre-flip value
  // in bg-host until restart). Fire-and-forget; bounded retry inside.
  void ensureFlagChangeListener();

  // EI-79 observability: a standing event-loop-lag gauge. Silent on a healthy
  // host; logs a single structured warning when p95 loop delay over a 10s window
  // crosses 100ms — the signal that the main thread is CPU-bound. Per-process:
  // each worker has its own event loop to watch.
  // infra round-3 F1: on the production host, also capture a short CPU profile
  // when the loop saturates (≥ critical p95), so the synchronous culprit is
  // identifiable instead of re-investigated from scratch each time. Rate-limited
  // (≤1 / 5 min), best-effort — EXCEPT under genuinely extreme, sustained lag
  // (WI-3797, 2026-07-10): captureCpuProfile()'s node:inspector Profiler
  // session relies on its own async post()/response completing over the SAME
  // event loop it's diagnosing, and this host's crash logs show 8x
  // `terminate called after throwing an instance of 'Napi::Error'` (native
  // abort — NOT a catchable JS exception, so the try/catch in
  // captureCpuProfile() cannot save it) landing immediately after
  // `[event-loop-lag]` p95 readings in the seconds range, correlated across
  // many cluster-worker PIDs during the same host-wide overload window. The
  // module's own header already documents this exact posture ("DELIBERATELY
  // DEFAULT-OFF... opt-in until validated under load") — this caller inverted
  // that default to on-by-default, and it has now failed that validation by
  // crash-looping the whole green-release operator. Reverting to the
  // module's own documented default (explicit opt-in only) until the
  // inspector-session crash itself is hardened.
  //
  // WI-5820 (owner-directed 2026-07-25) — that hardening is now HERE, and the gate
  // is a real flag instead of an env var:
  //   1. SAFETY CAP. The monitor's `profileMaxP95Ms` (default 3000ms) declines to
  //      profile a window that is too saturated, so the tens-of-seconds regime
  //      every WI-3797 crash actually landed in is structurally unreachable — the
  //      profiler can no longer be invoked where it natively aborts. Measured over
  //      12h on bg-host post-WI-5471: 2,937 windows, p95Ms max 1143ms, only 6
  //      crossing the 600ms trigger — so the cap excludes nothing real.
  //   2. RUNTIME KILL SWITCH. In July the only way to stop the crash loop was to
  //      edit code and redeploy, because the gate was `process.env`. FLAGS.
  //      LOOP_STALL_PROFILER flips in /admin/features in seconds. It is also read
  //      LAZILY (per saturated window, not latched at boot) — getFlag is fragile
  //      during host-boot, which is precisely how a boot-latched gate stays off
  //      forever without anyone noticing.
  // PAPERCUSP_LOOP_PROFILER remains honored for tests/dev only (see the monitor).
  startEventLoopLagMonitor({
    profileOnSaturation: () => getFlag(FLAGS.LOOP_STALL_PROFILER, 'operator-host'),
    // WI-38449: request workers are the processes carrying the live memory growth
    // (1.7-2.8 GB PSS each across the release cluster), but heap sampling used to
    // be armed only by the background primary and substrate sidecar. Keep the safe,
    // non-blocking sampler on in every request worker so the monitor's independent
    // high-RSS gate can name allocation sites without enabling a full V8 snapshot.
    // Reuse the existing shared threshold override; 2 GB is above the small primary
    // baseline while still crossing before the observed workers reach 2.8+ GB.
    heapSamplingOnHighRss: true,
    heapSamplingRssMb: Math.max(1, Number(process.env.PAPERCUSP_HEAP_SNAPSHOT_RSS_MB) || 2048),
  });

  // P5-2: closed-loop concurrency feedback. Reads the lag monitor's loopPressure()
  // (above) and, when this process's event loop is CRITICALLY saturated, makes the
  // fleet shed effective agent concurrency (AIMD multiplicative-decrease), ramping
  // back as the loop clears. Bounded under the user's cap + self-recovering.
  // Gated by LOOP_PRESSURE_GOVERNOR (default ON) — the operator's kill-switch.
  // getFlag is async (env override + PG-stored /admin/features override + default);
  // start the governor when it resolves true. Fire-and-forget — a few ms of start
  // latency at boot is harmless. Fail-OPEN to the default-on behavior if the flag
  // read fails (e.g. PG not ready yet): the governor is safe always-on (bounded
  // under the user's cap, self-recovering), so a read error must not silently
  // disable it.
  void getFlag(FLAGS.LOOP_PRESSURE_GOVERNOR, 'operator-host')
    .then((on) => {
      if (on) startLoopPressureGovernor();
    })
    .catch(() => startLoopPressureGovernor());

  const onListening = (boundPort: number): void => {
    console.log(`[hono-host] listening on http://${hostname}:${boundPort} (pid=${process.pid})`);
    notifySystemdReady();

    // Guardrail: a stray PAPERCUSP_WORKSPACE_ID pin silently rebinds every
    // non-request path on this multi-workspace host. Warn loudly at boot — a bare
    // `# TEMPORARY` comment in .env.local was not enough to stop one surviving.
    // (Logic + rationale in lib/workspace-pin-guard.ts, unit-tested.)
    const pinWarning = workspacePinWarning();
    if (pinWarning) console.warn(pinWarning);

    // WI-4734: pre-warm the interactive transcript-search path (module graph,
    // query embedder, PG pool, roster stores) so the FIRST human search after a
    // deploy restart is a warm ~300ms, not the full cold stack (owner-hit ~20s
    // on 2026-07-13). Per request worker (each has its own module graph + pool);
    // fire-and-forget after a short boot-settle delay; opt-out via
    // PAPERCUSP_DISABLE_SEARCH_WARMUP=1.
    // Search/embedder warming is intentionally deferred on request-only hosts:
    // the route remains available and warms on first use, while a short
    // secondary acceptance journey avoids loading the full search/corpus graph.
    if (!requestOnly) scheduleTranscriptSearchWarmup();
  };

  // P3-2 cluster-worker listen (INCIDENT 2026-06-18 fix): a cluster WORKER must bind
  // its OWN SO_REUSEPORT socket so the KERNEL load-balances accepts directly across
  // workers — INDEPENDENT of the primary. node:cluster's DEFAULT scheme round-robins
  // every accept THROUGH the primary, but the primary runs the heavy background
  // machinery (substrate/DBOS/git-sync) and can't service the accept-distribution IPC
  // when its loop is busy → workers never bind (the observed 0-listeners / ~150s hang).
  // `@hono/node-server` serve() can't forward `reusePort` (it calls listen(port,host,cb)),
  // so we build the server via createAdaptorServer and listen() ourselves with reusePort.
  // Both paths now go through listenWithEaddrinuseRetry (EI-18734124566158657) — the
  // SINGLE-PROCESS / primary path used to call serve() directly (which listens
  // internally with no bind-retry); it now builds the same createAdaptorServer and
  // listens itself, byte-identical to serve()'s own listen(port, hostname, cb) except
  // for the retry wrapper.
  const server: ReturnType<typeof createAdaptorServer> = createAdaptorServer({ fetch: handler });
  const httpServer = server as unknown as import('node:http').Server;

  // WI-41422: dev:restart targets this ONE verified Linux desktop-dev Hono
  // child with SIGUSR2. Drain first, then take the existing no-native-teardown
  // hard-exit path: live, process.exit(75) entered Node's addon teardown and
  // aborted with exit 134. The desktop wrapper now restarts after ANY
  // child-only exit (only a signal to the wrapper itself stops it), so the
  // child's exit status is not the supervision contract. Keep this
  // desktop-only: SIGUSR2 has no restart meaning on release/staging hosts.
  if (process.platform === 'linux' && process.env.DBOS__VMID === `desktop-dev-${port}`) {
    let desktopDevRestartRequested = false;
    process.on('SIGUSR2', () => {
      if (desktopDevRestartRequested) return;
      desktopDevRestartRequested = true;
      markShuttingDown();
      console.log(`[hono-host] SIGUSR2 — draining then hard-exiting desktop-dev listener (pid=${process.pid})`);
      gracefulHostRecycle({
        server: server as { close?: (cb?: () => void) => void },
        closeAdditionalResources: stopInvalidationListener,
        recycleExitCode: 75,
        // The request-only desktop child owns no background substrate lifecycle;
        // avoid turning a control-plane restart into native teardown work.
        skipSubstrateTeardown: true,
        // Avoid process.exit's native-addon teardown (live exit 134). Exit 75
        // remains only the fallback if the self-SIGKILL unexpectedly throws.
        hardExitOnRecycle: true,
        reason: 'a dev:restart desktop-dev SIGUSR2 recycle',
      });
    });
  }

  // onFatal reproduces the pre-existing behavior exactly: the process-level
  // `uncaughtException` handler above used to be what logged-and-exited on an
  // unrecoverable listen() error (Node re-raising an unhandled 'error' event as
  // an uncaught exception). Retries are exhausted (or the error isn't
  // EADDRINUSE) by the time this fires, so the same message + exit code apply.
  const onListenFatal = (err: NodeJS.ErrnoException): void => {
    console.error('[hono-host] fatal uncaughtException — exiting:', err);
    process.exit(1);
  };
  const listenOpts = {
    port,
    host: hostname,
    maxAttempts: LISTEN_RETRY_MAX_ATTEMPTS,
    retryDelayMs: LISTEN_RETRY_DELAY_MS,
    onFatal: onListenFatal,
  };
  if (cluster.isWorker) {
    listenWithEaddrinuseRetry(httpServer, {
      ...listenOpts,
      reusePort: true,
      onListening: () => onListening(port),
    });
  } else {
    listenWithEaddrinuseRetry(httpServer, { ...listenOpts, onListening: () => onListening(port) });
  }

  // external-app-access P-004 / R-7: the external-ingress listener. Opened only when
  // PAPERCUSP_EXTERNAL_INGRESS_PORT is set (P-009's tunnel setup sets it and points
  // the user's own tunnel here). It serves the same app, but every request runs as
  // external ingress, so no header can reach local trust. A bind failure is logged,
  // never fatal: the operator itself must keep serving the desktop.
  const ingressPort = externalIngressPort();
  if (ingressPort !== null && ingressPort !== port) {
    const ingressServer = createAdaptorServer({ fetch: externalIngressHandler });
    listenWithEaddrinuseRetry(ingressServer as unknown as import('node:http').Server, {
      ...listenOpts,
      port: ingressPort,
      ...(cluster.isWorker ? { reusePort: true } : {}),
      onFatal: (err: NodeJS.ErrnoException) => {
        console.error(`[hono-host] external-ingress listener on ${hostname}:${ingressPort} failed — tunnel traffic is NOT served:`, err);
      },
      onListening: () => {
        console.log(`[hono-host] external-ingress listener on ${hostname}:${ingressPort} (no local trust)`);
      },
    });
  } else if (ingressPort === null) {
    // external-app-access P-009: with no static port, the install's own tunnel
    // (lib/own-tunnel/service.ts) opens and closes the listener at runtime through this
    // seam — no restart. Loopback only: the tunnel's connector dials 127.0.0.1. Same
    // externalIngressHandler, so tunnel traffic can never reach local trust.
    let dynamic: { server: import('node:http').Server; port: number } | null = null;
    configureIngressListener({
      currentPort: () => dynamic?.port ?? null,
      open: (listenPort) =>
        new Promise<void>((resolve, reject) => {
          const srv = createAdaptorServer({ fetch: externalIngressHandler }) as unknown as import('node:http').Server;
          srv.once('error', reject);
          srv.listen({ port: listenPort, host: '127.0.0.1', ...(cluster.isWorker ? { reusePort: true } : {}) }, () => {
            srv.off('error', reject);
            dynamic = { server: srv, port: listenPort };
            console.log(`[hono-host] own-tunnel external-ingress listener on 127.0.0.1:${listenPort} (no local trust)`);
            resolve();
          });
        }),
      close: () =>
        new Promise<void>((resolve) => {
          const current = dynamic;
          dynamic = null;
          if (!current) return resolve();
          current.server.close(() => resolve());
          // The kill switch is instant: drop open keep-alive connections too.
          current.server.closeAllConnections();
          console.log(`[hono-host] own-tunnel external-ingress listener on 127.0.0.1:${current.port} closed`);
        }),
    });
    markOwnTunnelListenerSeamConfigured();
  }

  // B2 (infra-fail-fast-build-integrity P-006) — the "safe half": explicit inbound
  // Node server timeouts. OPT-IN (PAPERCUSP_HTTP_REQUEST_TIMEOUT_MS /
  // PAPERCUSP_HTTP_HEADERS_TIMEOUT_MS); unset → Node defaults unchanged. Marginal on
  // Node 25 (they bound request RECEIPT, not handler runtime — the handler-deadline
  // middleware in host-handler.ts covers the wedge), but the knobs let ops tune the
  // slow-loris / stuck-body ceiling without a code change.
  const appliedTimeouts = applyServerTimeouts(server as unknown as import('node:http').Server);
  if (
    appliedTimeouts.requestTimeout !== undefined ||
    appliedTimeouts.headersTimeout !== undefined ||
    appliedTimeouts.keepAliveTimeout !== undefined
  ) {
    console.log('[hono-host] applied inbound server timeouts (ms):', appliedTimeouts);
  }

  // PTY WebSocket data plane (opt-in via PAPERCUSP_PTY_WS_PORT — bin/dev sets
  // 3056). The HTTP control plane (/pty/spawn|input|resize|kill) lives in this
  // host's routes, and PiPanel PREFERS ws://:<port>/pty/<id> (AttachAddon) over
  // the SSE fallback. Must run in THIS process: the pty registry the WS attaches
  // to is in-process state shared with the spawn routes — which is precisely why
  // PTY is INCOMPATIBLE with multi-worker clustering (spawn + WS could land on
  // different workers).
  //
  // That incompatibility used to be documented here as "it's desktop/dev-only (off
  // on the server cluster target), so the two never coexist" — ASSUMED, never
  // enforced, and false in this deployment: papercup-dev-api.service.d/
  // 55-memory-envelope.conf sets PAPERCUSP_CLUSTER_WORKERS=6 alongside
  // PAPERCUSP_PTY_WS_PORT=3056, which silently broke (workers-1)/workers of all
  // terminal attaches on :3070 from 2026-06-18 onward (WI-10001638). Passing
  // `clusterWorkers` makes startPtyWsServer REFUSE and say so loudly instead.
  // Fail-soft on EADDRINUSE (a sibling already bound it).
  const ptyWsPort = Number(process.env.PAPERCUSP_PTY_WS_PORT ?? '');
  if (Number.isFinite(ptyWsPort) && ptyWsPort > 0) {
    startPtyWsServer({
      port: ptyWsPort,
      allowedOrigins: [...remoteAuthPolicy.origins],
      // Loopback and SSH-forwarded browsers remain the local compatibility
      // path even when this process also admits exact remote HTTPS origins.
      allowLocalhost: true,
      clusterWorkers,
    });
  }

  // Bounded-RSS self-recycle (per-process): the host leaks retained heap under
  // fleet load (~0.2 GB/min, no plateau); past ~4 GB the GC pauses stall the event
  // loop and intermittently break MCP mounts / invokes / health (2026-06-07).
  // Recycle at a high-water mark BELOW the stall zone — drain in-flight HTTP, then
  // exit; the systemd unit's `Restart=always` (RestartSec=5s) brings up a fresh
  // low-RSS process. See lib/memory-watchdog.ts.
  if (process.env.PAPERCUSP_MEMORY_WATCHDOG !== '0') {
    // Role-aware default (EI-1613, extended by EI-19484864948547581): the
    // dedicated BACKGROUND primary (the bg-host, BG=1) boots the substrate +
    // DBOS recovery and needs a far higher limit (12288) than a plain
    // request-only worker (3200). The old flat `|| 3200` default trips the
    // bg-host within minutes → recycle loop / (pre-fix) stay dead → routine-
    // engine freeze. The :3170 staging operator is also BG=0 but is NOT light
    // (measured born RSS ~5.5 GB), so it gets its own 10240 tier; the desktop
    // dev operator on :3270 is heavier still (measured ~10.6–11.6 GB born RSS)
    // and gets its own 16384 tier rather than inheriting 3200 and permanently
    // suppressing its own recycle. Resolved in code so a FRESH box is correct
    // without a box-local systemd drop-in; an explicit env still wins.
    const limitMb = resolveMemoryWatchdogLimitMb(process.env);
    // Proactive GC (the ROOT bg-host-freeze fix): force a full GC in the safe band
    // (default 60% of the recycle limit) so the heap never reaches the multi-GB
    // old-gen regime where a V8 mark-compact pause freezes the single event loop —
    // the "bg-host ticker frozen ~27 min" incident that reclaim-massacred queen/bee
    // spawns (EI-2186). `--max-old-space-size=131072` (box-wide) defeats V8's own
    // heap-paced GC, so this proactive sweep is what keeps the ticker alive. The
    // watchdog runtime-enables `--expose-gc` if NODE_OPTIONS lacks it (fresh-box
    // correct). Kill-switch: PAPERCUSP_MEMORY_PROACTIVE_GC=0. An explicit
    // PAPERCUSP_MEMORY_PROACTIVE_GC_MB overrides the threshold.
    const proactiveGcOff = process.env.PAPERCUSP_MEMORY_PROACTIVE_GC === '0';
    startMemoryWatchdog({
      limitMb,
      proactiveGcMb: proactiveGcOff
        ? 0
        : resolveMemoryWatchdogProactiveGcMb(process.env),
      onTrip: ({ rssMb, swapMb, committedMb }) => {
        // INVOCATION_ID = running under systemd (Restart=always). The tauri-dev
        // OWN-PORT operator is instead supervised by dev-operator-ifneeded.sh's
        // restart loop (WI-3042) — name the actual supervisor so a recycle in
        // either context reads correctly in the log.
        const supervisor = process.env.INVOCATION_ID
          ? 'systemd will restart'
          : 'expecting the spawning wrapper (dev-operator-ifneeded.sh restart loop) to restart';
        console.warn(
          `[memory-watchdog] committed-memory high-water mark tripped — draining + recycling host (${supervisor})`,
          // committedMb (VmRSS + VmSwap) is what tripped, and it is the only figure
          // to reason about here: under fleet load this box swaps, so rssMb alone
          // understates the process's real demand by 13-40% (WI-2145659). Both are
          // logged so a reader can see the split rather than infer it.
          { committedMb, rssMb, swapMb, limitMb },
        );
        // Drain in-flight HTTP before exit; the helper hard-exits after 8s if
        // the drain hangs. EI-9649: SKIP the P2P substrate teardown on a memory
        // recycle. A bare process.exit() abandoning those handles is the EI-127
        // resource-leak this drain exists to prevent — BUT a memory recycle
        // trips because RSS is over the cap, i.e. the substrate is large, and
        // tearing that much native Hypercore/Hyperswarm state down concurrently
        // throws an uncaught Napi::Error → SIGABRT below the JS layer (same
        // binding root cause as WI-3795/WI-3848/WI-3849). Unlike the SIGTERM +
        // lag-recycle paths, a memory recycle can fire while the loop is NOT
        // elevated, so gracefulHostRecycle's isSaturated skip does not catch it
        // and the crash turns a routine recycle into a hard SIGABRT + webview
        // reconnect flash. The process is fully exiting, so the OS reclaims the
        // sockets/fds/LISTEN backends anyway — skipping only defers the same
        // peer-timeout socket-linger the saturated path already accepts.
        // EI-10702: skipSubstrateTeardown does NOT prevent the Napi::Error/SIGABRT
        // (exit 134) — the WI-3849 coredumps proved the abort is thrown by a native
        // addon (onnxruntime-node / node-pty / sharp) during Node's ENV TEARDOWN on
        // process.exit(), not by the P2P substrate close (which the flag skips). So
        // ALSO hard-exit (SIGKILL self) once the HTTP drain is done: SIGKILL runs no
        // env cleanup and no native destructor/callback, so the abort has no path to
        // fire. The host is fully recycling (supervisor restarts a fresh low-RSS
        // process; the OS reclaims all resources), making a clean, deterministic exit
        // strictly better than the SIGABRT crash + coredump + webview recovery flash.
        gracefulHostRecycle({
          server: server as { close?: (cb?: () => void) => void },
          closeAdditionalResources: stopInvalidationListener,
          skipSubstrateTeardown: true,
          hardExitOnRecycle: true,
          // EI-16447: attribute the shared hard-exit log line to the ACTUAL
          // trigger — this is the only call site that is genuinely the memory
          // watchdog; the SIGTERM/lag-self-restart paths below no longer borrow
          // this same wording (WI-5434 chased a phantom RSS leak for hours
          // because a SIGTERM-triggered recycle logged as "a memory-watchdog
          // recycle" too).
          // Quote COMMITTED against the limit — they are the two sides of the
          // comparison that actually tripped. The old wording paired rssMb with
          // limitMb, which under swap renders a false inequality ("1779MB >=
          // 3200MB limit") in the one log line a reader trusts most (WI-2145659).
          reason: `a memory-watchdog committed-memory recycle (${committedMb}MB = ${rssMb}MB rss + ${swapMb}MB swap >= ${limitMb}MB limit)`,
        });
      },
    });
  }

  // Blocked-event-loop sentinel (EI-19465075959589134). The watchdog above bounds
  // RSS; this bounds LIVENESS, and neither covers the other. :3170 blocked its loop
  // at 2026-08-03 16:14:17Z and stayed wedged 30+ min while every signal read
  // healthy — port bound, pid alive, systemd active, TCP connects SUCCEEDING (the
  // kernel completes the handshake without the process). Its RSS at the sample
  // before the block was 2013MB against a 3200MB limit, and FALLING, so the memory
  // watchdog had nothing to act on and was right not to act.
  //
  // Why it cannot live on this thread: every existing guard samples from a timer on
  // the very loop whose blockage is the failure, so all of them go silent exactly
  // when it happens. The sentinel therefore runs on a worker_threads Worker (its own
  // loop, unaffected by a main-thread block — measured), reads a heartbeat counter
  // the main thread bumps into a SharedArrayBuffer, and SIGKILLs on sustained
  // staleness. SIGKILL specifically: a SIGTERM handler would be queued on the
  // blocked loop and never run. Fail-soft throughout — a spawn failure disables the
  // sentinel and leaves the host running. Kill-switch:
  // PAPERCUSP_EVENT_LOOP_SENTINEL=0 (or =observe to detect + log without killing).
  // EI-19484853609145439: wire the lag monitor's last-read percentiles into
  // the sentinel's SAME shared memory, so a kill/warn log from the (off-thread,
  // block-immune) sentinel carries the last observed loop-lag numbers even
  // though the lag monitor's own reader — a timer on the main loop — goes
  // silent for the whole duration of the block that triggered the sentinel.
  const sentinel = startEventLoopSentinel();
  setLagPublishTarget(sentinel.sab);

  // D4 (infra-fail-fast-build-integrity P-017): graceful HTTP connection-drain on
  // SIGTERM/SIGINT for the HTTP-SERVING process — the single-process host AND each
  // cluster worker. Node's default SIGTERM is an immediate exit that severs in-flight
  // requests, so a deploy / `systemctl restart` 502s anything mid-flight. Reuse the
  // memory-watchdog's bounded-drain idiom (stop accepting → drain in-flight HTTP →
  // tear down substrate → exit, 8s hard-exit backstop) but exit 0 (an intentional
  // stop, not the non-zero recycle code). The true-cluster PRIMARY serves no HTTP and
  // keeps its own worker-draining handler (gated to cluster mode below). Kill-switch:
  // PAPERCUSP_SIGTERM_DRAIN=0 restores Node's default immediate exit.
  // WI-3849 recurrence (2026-07-13): process.exit() itself runs Node's native
  // environment teardown, where onnxruntime/node-pty/sharp can throw an uncaught
  // Napi::Error. The staging host reproduced it on a routine sanctioned restart
  // and remained in do_exit past TimeoutStopSec. Drain first, then SIGKILL self:
  // no native teardown runs and systemd already owns the restart.
  if (process.env.PAPERCUSP_SIGTERM_DRAIN !== '0') {
    installGracefulShutdown({
      server: server as { close?: (cb?: () => void) => void },
      closeAdditionalResources: stopInvalidationListener,
      hardExitOnRecycle: true,
    });
  }

  // infra-self-healing-supervision-2026-06-19 (R4-2/R4-3/R4-4/R4-8): request-path
  // supervision. These run on a REQUEST worker — independent of the background DBOS
  // primary they watch — so they keep working when that primary freezes (the exact
  // failure that blinds the in-engine watchdog, 2026-06-19). All read-only + debounced
  // + env-killable; every failure degrades silently (best-effort, never crashes serving).
  //  • infra-liveness alarm (R4-3/R4-8): escalates to the owner when the routine engine
  //    or Queen goes dark, accounts are starved, or any health panel is critical — incl.
  //    a STALE health snapshot, which itself is the "bg tick frozen" signal.
  //  • single-primary guard (R4-2): escalates on != 1 live background primary (the silent
  //    0-primary routine death AND the >1 split-brain / appVersion-war catastrophe).
  //  • lag self-restart (R4-4 / EI-1598): recycles THIS worker when its loop stays
  //    critical for a sustained window — DEFAULT-OFF, arm with PAPERCUSP_LAG_SELF_RESTART=1
  //    once validated under load (the other reusePort workers serve through the recycle).
  //  • condition-staleness alarm (WI-2965): the periodic ACTOR for coord:conditions —
  //    a condition-keyed severe-event that stays OPEN past a threshold gets ONE reminder
  //    escalation, durably deduped/auto-resolved (mirrors the liveness alarm's EI-2146
  //    dedup shape). Closes the coord-conditions signal-actor-registry waiver.
  startInfraLivenessAlarm();
  startConditionStalenessAlarm();
  startEscalationAgingAlarm();
  //  • routine-fire-cancellation alarm (WI-35534): DBOS's own max-recovery-attempts
  //    cancellation can silently kill a still-ENQUEUED routineFire (empty error,
  //    catchup:'skip-old', no retry) while last_fired_at keeps advancing — invisible
  //    everywhere except dbos.workflow_status. Read-only visibility signal; does not
  //    touch the workflow or the routine (distinct from dbos-executor-reaper, which
  //    requeues a different DBOS state — started-but-no-output).
  startRoutineFireCancellationAlarm();
  startSinglePrimaryGuard();
  // P-002 (mcp-reliability-hardening-2026-07-11): recycle GRACEFULLY. The seam's
  // default is a bare process.exit(75), which severs every in-flight request on
  // this worker — measured 2026-07-10/11: 303 lag-recycles/24h, and 41.3% of all
  // agent-visible mcp-proxy 502s (read ECONNRESET / socket hang up) landed within
  // ±5s of one (vs 7.5% chance coverage). Route the exit through the SAME bounded
  // drain the memory-watchdog and SIGTERM paths use: markShuttingDown (stop
  // STARTING background work) → stop accepting → drain in-flight HTTP → exit 75
  // (8s hard backstop). gracefulHostRecycle's saturated-skip already avoids the
  // WI-3795 native substrate-teardown crash — which a lag-recycle would otherwise
  // ALWAYS risk, since its loop is 'critical' by definition at recycle time.
  startLagSelfRestart({
    // P-003: desynchronize sibling workers' recycles — pressure is box-correlated,
    // so without jitter many workers trip the identical sustain window in the same
    // beat (7 recycles in ~4 min observed 2026-07-10). +0..4 extra 15s checks.
    jitterChecks: 4,
    exit: (code) => {
      markShuttingDown();
      gracefulHostRecycle({
        server: server as { close?: (cb?: () => void) => void },
        closeAdditionalResources: stopInvalidationListener,
        recycleExitCode: code,
        // WI-3849: lag-recycle is another full process exit. Avoid the same
        // Node native env teardown that aborts on SIGTERM/memory recycle.
        hardExitOnRecycle: true,
        // EI-16447: distinct from the memory-watchdog reason above — see its
        // comment for why this matters.
        reason: 'an event-loop lag-self-restart recycle',
      });
    },
  });
}

// P3-2 (operator-scalability-event-loop-2026-06-16): optional node:cluster. DEFAULT
// OFF → single process: startCluster runs onPrimary() then onWorker() inline, and
// runBootstrap() is idempotent (globalThis guard), so the net boot is byte-identical
// to the pre-cluster sequence (runBootstrap → request servers). When PAPERCUSP_CLUSTER
// is enabled on a server-class host, the PRIMARY runs the background machinery
// (DBOS/git-sync/substrate — which MUST be exactly one process) and forks N
// request-only WORKERS — each a PAPERCUSP_BACKGROUND_WORKERS=0 host (the battle-tested
// :3170 request-only mode) that shares the port via cluster's built-in round-robin.
// Workers carry PAPERCUSP_EXPECTED_OPERATOR_PROCS so their PG pools are sized for the
// fleet and can't multiply past max_connections (the 2026-06-17 exhaustion).
// ENABLING is owner-gated: cross-process sync-invalidate needs the pg-listen-hub on,
// and it should be validated under the Tauri shell / a staging restart first.
const clusterWorkers = resolveClusterWorkers(process.env, getResourceProfile().httpWorkers);
// EI-8817/EI-8818: name the exact env var + value that drove this so a wrong
// resolution (e.g. an unintended multi-worker fork storm) is one-glance diagnosable
// from the boot log instead of ~30min of forensics re-deriving CLUSTER_WORKERS'
// precedence over CLUSTER by hand.
console.log(`[cluster] resolved ${clusterWorkers} worker(s) (source: ${describeClusterWorkersSource(process.env)})`);
// WI-38448: without a durable secret every reuse-port worker mints a different
// key, so the pairing response works only when later requests happen to land on
// its signer. Fail before forking. Sidecar re-execs do not serve device routes.
if (!sidecarMode) assertMobileJwtSecretDurableForCluster(clusterWorkers);
// PG-pool budget (R1 — infra-perf-robustness-audit-2026-06-18 conn-saturation). Every
// process sizes its org pools so `pool·procs ≤ max_connections`; the divisor is the
// count of operator processes sharing this PG. The bug it fixes: on an EMBEDDED-PG host
// `resource-profile.processCount` pins to ~1 (httpWorkers clamps to 1), so a clustered
// host sized each pool for ~1 proc → 68-conn pools across 3 cluster procs that each used
// <10 → ~89% saturation (the audit's R1). Size for the REAL cluster topology instead —
// `clusterWorkers + 1` (the N request workers + the background primary) — and honor an
// explicit operator override (the systemd drop-in, which can raise it to also account
// for the co-resident staging/aux operators on this box). `max(...)` so we never size
// for FEWER procs than actually exist (which would re-create the over-provisioning).
const expectedOperatorProcs = resolveExpectedOperatorProcs({
  clusterWorkers,
  profileProcessCount: getResourceProfile().processCount,
  explicit: process.env.PAPERCUSP_EXPECTED_OPERATOR_PROCS,
});
if (clusterWorkers > 1) {
  // Size THIS (primary) process's pools for the whole cluster; workers inherit via
  // the fork env below.
  process.env.PAPERCUSP_EXPECTED_OPERATOR_PROCS = String(expectedOperatorProcs);
}
// WI-1879: pin the substrate sidecar's IPC socket path BEFORE forking — see
// pinSubstrateSocketForCluster's doc for the full race (the substrate boots
// asynchronously deep inside onPrimary's runBootstrap(), well after cluster.fork()
// has already forked every worker off the pre-substrate-boot env, so each worker used
// to fall back to its OWN pid-keyed — nonexistent — socket path and the
// dogfood-substrate-boot-history route always degraded to `source:'main-fallback'`
// with an empty ring on every clustered host; found during P-059 / WI-1837).
const substrateSocketWorkerEnv = sidecarMode ? {} : pinSubstrateSocketForCluster(clusterWorkers);
// Same pin for the SPAWNER sidecar (plan spawner-sidecar-cluster-fanout-2026-08-12).
// The substrate got this in WI-1879; the spawner did not, and paid far more for it:
// its "already spawned" latch is module-scoped (per PROCESS), so each of N cluster
// workers resolved its OWN pid-keyed path, found nothing, and spawned a full ~450MB
// hono-host of its own. Measured 2026-08-12 at PAPERCUSP_CLUSTER=16: 16 sidecars,
// 9.5GB, 0.004 cores each. Pinning makes every worker resolve the PRIMARY's path, so
// the adoption probe in spawnSpawnerSidecar finds the sibling's sidecar and reuses it.
const spawnerSocketWorkerEnv = sidecarMode ? {} : pinSpawnerSocketForCluster(clusterWorkers);
const lspSocketWorkerEnv = sidecarMode ? {} : pinLspDaemonSocketForCluster(clusterWorkers);
// WI-10001497: mint + PRINT the first-time setup code once, here in the primary,
// BEFORE forking — then hand the same value to every worker via workerEnv. Two
// defects, one root: the token was module state (per-PROCESS), so each reusePort
// worker minted its own and a copied code verified only on the ~1/N chance the
// POST landed on the worker that printed it; and nothing called getSetupToken()
// at boot at all, so the code was minted by the FAILING request that needed it.
// Mirrors the two socket pins above; cluster-fork replays workerEnv on respawn,
// so a recycled worker keeps the same code. Cf. WI-38448's split MOBILE_JWT_SECRET.
const setupTokenWorkerEnv = sidecarMode ? {} : pinSetupTokenForCluster(clusterWorkers);
// EI-8810: in sidecar mode the divert above already started the sidecar server
// (which keeps the process alive) — the host boot below must not run at all.
const clusterHandle = sidecarMode ? null : startCluster({
  workers: clusterWorkers,
  workerEnv: {
    PAPERCUSP_BACKGROUND_WORKERS: '0',
    PAPERCUSP_EXPECTED_OPERATOR_PROCS: String(expectedOperatorProcs),
    ...substrateSocketWorkerEnv,
    ...spawnerSocketWorkerEnv,
    ...lspSocketWorkerEnv,
    ...setupTokenWorkerEnv,
  },
  onPrimary: () => {
    // WI-6793: the clustered PRIMARY runs the background machinery (DBOS,
    // routines, scout) but never startRequestServers — install the flag-change
    // LISTEN here too, or exactly the process holding the scout's keying latch
    // misses runtime flips. Idempotent with the worker-path call in single mode.
    void ensureFlagChangeListener();
    return runBootstrap(); // background machinery (single process in cluster mode)
  },
  onWorker: () => {
    // A worker is request-only: runBootstrap with background gated off (fork env),
    // then start the HTTP/loop servers. In single mode this is the same process as
    // onPrimary, so runBootstrap no-ops the second call.
    runBootstrap();
    // WI-5441/WI-5764 (public-release boot-window federation-capture-hole guard):
    // do NOT start accepting HTTP traffic until this process's own boot migrations
    // have applied. Request-only processes run the coordinated preflight in
    // waitForBootMigrationGate(); a failure rejects and exits before HTTP is
    // exposed. Background processes retain the bounded, fail-soft gate wait.
    // Previously startRequestServers() ran unconditionally right here,
    // immediately after the fire-and-forget runBootstrap() call, with NO
    // ordering guarantee against the still-running migration IIFE it kicked
    // off — so a write could land on a table whose federation-capture trigger
    // a slow/large migration set hadn't created yet, permanently and silently
    // never federating (su-72ce40f2's diagnosis, WI-5441, post 53143).
    void waitForBootMigrationGate().then(() => {
      startRequestServers();
      // external-app-access P-009 + P-008: open this process's own-tunnel listener now
      // (idempotent). A single-process host (one HTTP worker, e.g. the desktop app) never
      // enters the clusterWorkers > 1 primary block below, and it is the host singleton, so
      // it arms the relay reconciler here too (WI-10004423).
      startRemoteAccessReconcilers(httpServingProcessRole(clusterHandle));
      // Heartbeat the primary so the cluster-lag-watchdog can detect a SYNCHRONOUS wedge
      // (which freezes the worker-side lag-self-restart too) by heartbeat ABSENCE
      // (EI-1598/1608). DEFAULT-OFF; only meaningful in a forked worker (process.send).
      if (clusterWorkers > 1 && clusterLagWatchdogArmed()) startWorkerHeartbeat();
      // EI-8816: cache the primary's periodic booted-handles broadcast so this
      // request-only worker's substrate-status reads aren't a silent blind spot
      // (the substrate boots only on the primary; this worker's own listBootedHandles()
      // map is always empty). ALWAYS-ON when true-clustered — a correctness fix, not an
      // opt-in perf feature (unlike the lag watchdog above).
      if (clusterWorkers > 1) startWorkerBootedHandlesCache();
      // EI-19454206016477347: cache the primary's periodic managed-timers broadcast so
      // this worker's `/api/internal/managed-timers` route (the schedule-federation
      // probe target) can report the PRIMARY's own timers + DBOS schedules, not just
      // this worker's — the primary owns the background machinery but never itself
      // serves that route (SO_REUSEPORT always lands the request on a worker). Mirrors
      // the booted-handles cache immediately above; ALWAYS-ON when true-clustered for
      // the same reason.
      if (clusterWorkers > 1) startWorkerPrimaryManagedTimersCache();
      // EI-19327550671915579 (part 2 of EI-18735338283879820): also publish to the
      // cross-SERVICE PG fallback, unconditionally (no clusterWorkers gate) — this is
      // the leg that reaches a request-only host under the dedicated-bg-host topology
      // (:3070/:3270, each a SEPARATE systemd service from papercup-bg-host, where
      // node:cluster IPC can never apply at all). Runs in every single-process host
      // (this closure executes inline here too — see the file-header comment above),
      // and self-gates per-beat on isSubstrateOwnerProcess(), so a request-only host
      // simply never writes.
      startBootedHandlesPgPublisher({});
      // WI-6594: publish this worker's P-009 stamp declarations to the primary and
      // apply the ones it relays back from peers. Without this, an agent's
      // coord:declare-intent and its work_items:claim land on DIFFERENT workers and
      // no call can ever stamp both — measured live as intent_event_id and goal_ref
      // never co-occurring, which red the fleet gate via lint:plane-ratchet.
      // ALWAYS-ON when true-clustered: a correctness fix, like the cache above.
      if (clusterWorkers > 1) {
        startWorkerStampPublisher();
        startWorkerStampReceiver();
        // WI-10003626: serve owner-rpc requests for process-local runtimes this
        // worker holds (capability PTYs), and forward our own calls for runtimes
        // a sibling holds. Without it a PTY opened on worker A is unreachable from
        // the (N-1)/N of follow-up calls the kernel hands to other workers.
        startWorkerOwnerRpc();
      }
    }).catch((e) => {
      console.error(
        '[hono-host] request-serving startup withheld: migration preflight failed — refusing to serve this schema:',
        e instanceof Error ? e.message : e,
      );
      process.exit(1);
    });
  },
  // Boot-failure backstop (2026-06-25 incident): if a whole generation of workers
  // exits within the boot grace window and NONE ever stays up — an UNBOOTABLE build
  // (MODULE_NOT_FOUND / a boot-time throw the preflight manifest didn't enumerate) —
  // halt the respawn storm and exit the primary with the integrity code. A clean,
  // fast, distinct failure lets systemd/deploy-cli surface it and roll back to the
  // last-good build, instead of flapping every worker for ~35 min (the all-pages
  // outage). A worker that crashes AFTER serving still respawns normally.
  onUnbootable: ({ consecutiveBootFailures, lastCode, lastSignal }) => {
    console.error(
      `[hono-host] cluster UNBOOTABLE: ${consecutiveBootFailures} worker(s) failed to boot and none ` +
        `stayed up (last exit code=${lastCode} signal=${lastSignal}). Exiting the primary (${BOOT_INTEGRITY_EXIT_CODE}) ` +
        `so the supervisor/deploy rolls back to the last-good build rather than crash-looping. See the ` +
        `[boot-integrity] line above for the likely missing module(s); run \`npm ci\` in this checkout if persistent.`,
    );
    process.exit(BOOT_INTEGRITY_EXIT_CODE);
  },
});

// Graceful drain on shutdown.
//  • The HTTP-serving processes — the single-process host AND each cluster WORKER —
//    drain in-flight HTTP on SIGTERM inside startRequestServers (D4/P-017), exiting 0.
//  • The TRUE-CLUSTER PRIMARY serves no HTTP; it stops respawning + signals workers to
//    drain, then exits so systemd restarts clean. Single-process is ALSO role 'primary'
//    but serves HTTP, so it must NOT take this 2s-exit path (it would preempt the HTTP
//    drain) — hence the `clusterWorkers > 1` guard.
if (clusterHandle && clusterHandle.role === 'primary' && clusterWorkers > 1) {
  // Cluster-lag watchdog (EI-1598/1608): the primary SIGKILLs a worker that stops
  // heart-beating (a synchronous wedge the worker-side lag-self-restart can't catch);
  // the startCluster exit handler then respawns it (respawn-budget-aware). DEFAULT-OFF
  // — arm with PAPERCUSP_CLUSTER_LAG_WATCHDOG=1 once validated under load.
  const watchdog =
    clusterLagWatchdogArmed() && clusterHandle.workerById
      ? startClusterLagWatchdog({
          cluster: nodeCluster as unknown as Parameters<typeof startClusterLagWatchdog>[0]['cluster'],
          workerById: clusterHandle.workerById,
        })
      : undefined;
  // EI-8816: broadcast this primary's booted-handles snapshot to every worker so their
  // substrate-status reads aren't a silent blind spot. ALWAYS-ON (not gated behind an
  // arm flag like the lag watchdog above) — this closes a correctness bug, not an
  // opt-in perf feature.
  //
  // EI-18735338283879820: "always-on" means always-WIRED, not always-SENDING. The
  // broadcaster self-gates per beat on isSubstrateOwnerProcess(), so a request-only
  // primary (:3070/:3270 under the dedicated bg-host topology, which never boots the
  // substrate) stays SILENT instead of broadcasting its empty handle map — a fresh empty
  // snapshot is what fabricated `reachedSubstrateOwner:true, bootedCount:0`. The gate
  // lives in the library, not here, so no call site can reintroduce the false zero.
  const bootedHandlesBroadcaster = clusterHandle.broadcast
    ? startBootedHandlesBroadcaster({ broadcast: clusterHandle.broadcast })
    : undefined;
  // EI-19454206016477347: broadcast this primary's OWN managed-timer + DBOS-schedule
  // registries to every worker, so a caller probing ANY worker's
  // /api/internal/managed-timers route (the schedule-federation.ts probe target) also
  // learns what the primary itself has armed — the primary never itself serves that
  // route (SO_REUSEPORT always lands the request on a worker), so without this the
  // primary's timers are structurally invisible to the one surface built to inventory
  // them. ALWAYS-ON like the booted-handles broadcaster above: deliberately
  // UNGATED (no substrate-ownership check) — see cluster-managed-timers-sync.ts's
  // file-header doc for why that gate does not apply here.
  const primaryManagedTimersBroadcaster = clusterHandle.broadcast
    ? startPrimaryManagedTimersBroadcaster({ broadcast: clusterHandle.broadcast })
    : undefined;
  // EI-19327550671915579: also publish to the cross-SERVICE PG fallback from the
  // true-cluster primary — it never runs the onWorker closure above (only its forked
  // children do), so without this a true-clustered substrate owner would only ever
  // reach its OWN workers over cluster IPC, never a foreign process/host. Self-gates
  // the same way; a request-only primary under the dedicated-bg-host topology stays
  // silent here too.
  const bootedHandlesPgPublisher = startBootedHandlesPgPublisher({});
  // external-app-access P-009 + P-008 (D-031): the primary may own the own-tunnel connector
  // (cloudflared) and is the host singleton that dials the opt-in Papercusp relay; request
  // workers arm only their own-tunnel listener (above). Idempotent, never throws, and a pass
  // before boot migrations apply converges on a later tick.
  startRemoteAccessReconcilers('cluster-primary');
  // WI-6594: relay each worker's P-009 stamp declarations to every other worker.
  // The primary is the hub because only it holds a handle to every worker; it also
  // applies each patch locally, since it runs the background machinery whose own
  // tool calls are stamped from the same map.
  const stampRelay = clusterHandle.broadcast
    ? startPrimaryStampRelay({
        cluster: nodeCluster as unknown as Parameters<typeof startPrimaryStampRelay>[0]['cluster'],
        broadcast: clusterHandle.broadcast,
      })
    : undefined;
  // WI-10003626: deliver owner-rpc requests to the worker that owns the runtime,
  // and answer `owner_gone` authoritatively when that worker no longer exists.
  const ownerRpcRelay = startPrimaryOwnerRpcRelay({
    cluster: nodeCluster as unknown as OwnerRpcClusterLike,
  });
  const shutdown = (sig: 'SIGTERM' | 'SIGINT'): void => {
    // P-005: the true-cluster PRIMARY is the process that runs the auto-implement
    // dispatch loop (it owns the background machinery). It serves no HTTP, so it
    // does NOT go through installGracefulShutdown — mark the drain here too, so the
    // loop stops claiming new minutes-long workers as this primary exits.
    markShuttingDown();
    console.log(`[cluster] ${sig} — draining ${clusterHandle.workerCount} worker(s) + exiting primary`);
    watchdog?.stop(); // stop watching first so it doesn't fight the graceful drain
    bootedHandlesBroadcaster?.stop();
    primaryManagedTimersBroadcaster?.stop();
    bootedHandlesPgPublisher.stop();
    stampRelay?.stop();
    ownerRpcRelay.stop();
    clusterHandle.drain?.(sig);
    // WI-3849: the primary loads the same native modules as workers. Calling
    // process.exit() after worker drain still runs their hazardous env teardown;
    // SIGKILL after the bounded drain leaves cleanup to the OS/systemd and cannot
    // throw through node-addon-api.
    setTimeout(() => process.kill(process.pid, 'SIGKILL'), 2000).unref?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
