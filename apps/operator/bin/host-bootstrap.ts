/**
 * Side effects that the API entrypoint needs to run *once* per process:
 * plugin-route population, background watchers, sweepers, voice WS,
 * mobile push refreshers, the auto-loop ticker, the expirable registry.
 *
 * Split out from `app.ts` so that:
 *   - importing the Hono app for tests / operator-vite / IPC bridge is free
 *     of background-process side effects;
 *   - the route shim (`[[...route]]/route.ts`) and any future Hono host
 *     (`@hono/node-server` for operator-vite Phase C) call `runBootstrap()`
 *     explicitly, in the same order, on first request.
 *
 * `runBootstrap()` is idempotent — second and subsequent calls no-op via the
 * globalThis guard. Each underlying `start*()` / `ensure*()` is itself
 * idempotent (per their existing comments about Next dev module re-eval),
 * so even an accidental double-call from a different bootstrap path is safe.
 */
import { mountPluginApiRoutes } from '@papercusp/operator-core/lib/plugin-api-mount';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import cluster from 'node:cluster';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureHarnessFsWatcher } from '@papercusp/operator-core/lib/harness-fs-watcher';
import { ensureHarnessStatusSweep } from '@papercusp/operator-core/lib/harness-status-sweep';
import { ensureHostedWorkspaceHostRuntime } from '@papercusp/operator-core/lib/workspace-host/hosted-workspace-host-runtime';
import { startEventLoopLagMonitor } from '@papercusp/operator-core/lib/event-loop-lag-monitor';
import { isVmReleaseDistribution } from '@papercusp/operator-core/lib/vm-release-runtime-policy';
// ensureWaveAdvanceSweep — RETIRED (P-044): the 30s wave-advance poll is no longer
// started; all-waves-up-front promotion + the dispatch frontier replace it.
import { registerAllExpirables } from '@papercusp/operator-core/lib/expirable-registrations';
import { setLaunchBlueprintResolver, installedAwareLaunchResolver } from '@papercusp/operator-core/lib/blueprint/launch-blueprint';
import {
  backgroundWorkersEnabled,
  dbosLaunchesHere,
  requestOnlyHost,
  utilityHostEnabled,
} from '@papercusp/operator-core/lib/background-workers';
import { startClaudeCredentialSync } from '@papercusp/operator-core/lib/claude-credential-sync';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { startMobileVoiceWs } from '@papercusp/operator-core/lib/device-voice-ws';
import { startDesktopVoiceWs } from '@papercusp/operator-core/lib/voice-node/desktop-voice-ws';
import { startPushCredentialRefresher } from '@papercusp/operator-core/lib/device-push-credentials';
import { registerHostPlatform } from '@papercusp/host-platform';
import { desktopHostPlatform } from '@papercusp/host-platform/desktop';
import { runBootAddonPreflight } from '@papercusp/operator-core/lib/native-addon-preflight';
// [WI-37700] The cpu-task worker's crash-breaker announcement seam. `sendMessage` is
// imported DYNAMICALLY at the call site instead: coordination/messages.ts registers an
// onFlagChange listener at MODULE TOP LEVEL, and this notifier fires at most once per
// process, so a static edge here would pay that cost — and widen host-bootstrap's import
// graph for every consumer that merely imports this module — to no benefit.
import { configureCpuWorkerBreakerNotifier } from '@papercusp/operator-core/lib/cpu-task-worker';
import { validateHomeHarnessResolution, homeHarnessValidationFatal, isLikelyFreshInstallGap } from '@papercusp/operator-core/lib/startup/validate-home-harness';
import { applyToProcessEnv, readAgentConfig, agentCmdBootWarning } from '@papercusp/operator-core/lib/agent-config';
import { reportRuntimeVintageOnBoot } from '@papercusp/operator-core/lib/runtime-vintage';
import {
  gracefulStopChild,
  isSidecarEnabledFromEnv,
  registerSidecarShutdownHooks,
} from '@papercusp/operator-core/lib/process-supervision/sidecar-spawn-shared';
import { assertDbosWorkItemsImportContract } from '@papercusp/operator-core/lib/dbos/work-items-contract';
import { reconcileLegacyVoiceServices } from '@papercusp/operator-core/lib/voice-node/legacy-service-reconcile';
// The proxy's retry window, defined ONCE (WI-6738) and shared with psu-launcher.mjs, which
// must not give up while the proxy is still retrying on its behalf. Static (unlike the lazy
// proxy import below, which defers a heavy module used only in a fallback branch): this one
// is dependency-free and side-effect-free apart from reading env.
import { MCP_PROXY_RETRY_WINDOW_MS } from '../lib/mcp-proxy/budgets.mjs';
import { pinModuleState } from '@papercusp/module-singleton';
import { activeWorkspaceId } from '@papercusp/operator-core/lib/workspace-registry';
import {
  beginGovernedExecution,
  governedExecutionRuntime,
} from '@papercusp/operator-core/lib/resource-governor/execution';
import { agentMcpBootstrapFailureCode } from '@papercusp/operator-core/lib/endpoint-route/routes/transport/_mcp-uds-error';
import { dedupeInFlight } from '@papercusp/operator-core/lib/dedupe-in-flight';
import { withBoundedTimeout } from '@papercusp/operator-core/lib/bounded-timeout';

/**
 * All of this module's mutable state, pinned together at module scope ONCE.
 *
 * The run-once guard was already pinned by hand, but the two packaged-proxy
 * slots below were plain module-locals — a HALF-CLOSED pin. On a module split
 * that combination is worse than no pin: the guard correctly stops the second
 * record from bootstrapping, so whichever record spawned the proxy child owns
 * the only handle to it, while `stopPackagedMcpProxy` — registered as the
 * shutdown handler — can be reached on the OTHER record, see a null child, and
 * return without killing anything. The result is an orphaned proxy on :9071
 * surviving operator shutdown, with no error on any path.
 *
 * Pinned via the primitive rather than a hand-rolled Symbol.for so a future
 * re-split is reported by listModuleDuplications() instead of being
 * rediscovered the expensive way.
 */
const BOOTSTRAP_STATE = pinModuleState<{
  ran: boolean;
  packagedMcpProxyProcess: ChildProcess | null;
  packagedMcpProxyShutdownRequested: boolean;
  requestMigrationGateFlights: Map<string, Promise<void>>;
}>('@papercusp/web.host-bootstrap', () => ({
  ran: false,
  packagedMcpProxyProcess: null,
  packagedMcpProxyShutdownRequested: false,
  requestMigrationGateFlights: new Map(),
}));

// Declared AFTER the pin on purpose: host-bootstrap.startup-guards.test.ts slices
// the proxy-lifecycle source from this const to the next `/**`, so a doc comment
// between them would truncate that guard's window to nothing.
const PACKAGED_MCP_PROXY_SHUTDOWN_TIMEOUT_MS = 5_000;

// Injected by the esbuild host/desktop-sidecar recipes. It is absent under tsx/dev/test;
// read through typeof so source boot and unit tests never evaluate an undeclared global.
declare const __PAPERCUSP_BUNDLED_SIDECAR__: boolean | undefined;

function isBundledSidecar(): boolean {
  return typeof __PAPERCUSP_BUNDLED_SIDECAR__ !== 'undefined' && __PAPERCUSP_BUNDLED_SIDECAR__;
}

async function packagedMcpProxyAlive(port = 9071): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/__mcp_proxy_health`, {
      signal: AbortSignal.timeout(1_500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function startPackagedMcpProxy(): void {
  registerSidecarShutdownHooks({
    label: 'packaged-mcp-proxy',
    mode: 'async-with-exit',
    stop: stopPackagedMcpProxy,
  });

  const port = Number(process.env.PAPERCUSP_MCP_PROXY_PORT || 9071);
  void (async () => {
    if (BOOTSTRAP_STATE.packagedMcpProxyShutdownRequested) return;
    if (await packagedMcpProxyAlive(port)) return;
    // The health probe is asynchronous. A shutdown can begin while it is in
    // flight; never start a new child after the host has begun draining.
    if (BOOTSTRAP_STATE.packagedMcpProxyShutdownRequested) return;
    const sidecarDir = dirname(process.argv[1] || '');
    const proxyEntry = join(sidecarDir, 'mcp-proxy.mjs');
    const hasPackagedEntry = existsSync(proxyEntry);
    const workspaceId = activeWorkspaceId();
    const execution = await beginGovernedExecution(
      {
        idempotencyKey: `packaged-mcp-proxy:${process.pid}:${randomUUID()}`,
        admissionClass: 'mcp',
        demand: { cpuWeight: 0.25, memoryBytes: 128 * 1024 * 1024, fileDescriptors: 1 },
        payloadRef: `packaged-mcp-proxy:${port}`,
        metadata: { port, mode: hasPackagedEntry ? 'packaged-child' : 'in-process-fallback' },
      },
      { owner: `operator-host:${process.pid}` },
      governedExecutionRuntime(workspaceId, 'packaged-mcp-proxy'),
    );
    if (!hasPackagedEntry) {
      // A hot-patched serve.mjs on a pre-WI-3247 install has no mcp-proxy.mjs
      // beside it — but ~/.claude.json's desktop registration already bakes the
      // ${PAPERCUSP_OPERATOR_URL:-http://127.0.0.1:<port>} fallback, so leaving
      // the port dark turns every claude launched without that env into a dead
      // MCP door ("tools fetch failed" — owner-hit live on the mac VM,
      // 2026-07-07). Serve the proxy IN-PROCESS instead: same dynamic
      // operator.json target. It dies with this operator (unlike the detached
      // packaged child), but the next boot re-arms it and the sticky operator
      // port keeps direct pins valid across the gap.
      if (BOOTSTRAP_STATE.packagedMcpProxyShutdownRequested) {
        await execution.cancel('operator shutdown won before fallback import');
        return;
      }
      try {
        const { startMcpProxy, readOperatorJsonTarget } = await import('../lib/mcp-proxy/proxy');
        if (BOOTSTRAP_STATE.packagedMcpProxyShutdownRequested) {
          await execution.cancel('operator shutdown won before fallback listen');
          return;
        }
        const staticPort = Number(
          process.env.PAPERCUSP_MCP_PROXY_TARGET_PORT || process.env.PAPERCUSP_HONO_PORT || 3070,
        );
        const server = startMcpProxy({
          listenPort: port,
          resolveTarget: () =>
            readOperatorJsonTarget() ?? { host: '127.0.0.1', port: staticPort, source: 'fallback' },
          retryWindowMs: MCP_PROXY_RETRY_WINDOW_MS,
        });
        // startMcpProxy attaches no 'error' handler; without this an EADDRINUSE
        // (non-proxy squatter that failed the health probe above) would be an
        // uncaught 'error' event and kill the whole operator.
        server.on('error', (e) => {
          void execution.cancel((e as Error)?.message ?? String(e));
          console.warn(`[mcp-proxy] in-process fallback proxy failed on :${port}:`, (e as Error)?.message ?? e);
        });
        server.once('close', () => void execution.finish());
        console.log(
          `[mcp-proxy] packaged proxy entry missing at ${proxyEntry} — serving the MCP proxy IN-PROCESS on 127.0.0.1:${port} (stale-bundle fallback)`,
        );
      } catch (e) {
        await execution.cancel((e as Error)?.message ?? String(e));
        console.warn(
          `[mcp-proxy] packaged proxy entry missing at ${proxyEntry} and the in-process fallback failed; psu sessions will use direct discovery:`,
          (e as Error)?.message ?? e,
        );
      }
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [proxyEntry], {
      // Keep the packaged child in this process's lifecycle. The shutdown hook
      // below drains it and force-kills it after a bounded grace period.
      detached: false,
      stdio: 'ignore',
      env: {
        ...process.env,
        PAPERCUSP_MCP_PROXY_PORT: String(port),
        PAPERCUSP_MCP_PROXY_DYNAMIC_TARGET: '1',
        PAPERCUSP_MCP_PROXY_TARGET_HOST: process.env.PAPERCUSP_MCP_PROXY_TARGET_HOST || '127.0.0.1',
        PAPERCUSP_MCP_PROXY_TARGET_PORT: process.env.PAPERCUSP_MCP_PROXY_TARGET_PORT || process.env.PAPERCUSP_HONO_PORT || '3070',
        PAPERCUSP_MCP_PROXY_RETRY_MS: String(MCP_PROXY_RETRY_WINDOW_MS),
        PAPERCUSP_MCP_PROXY_BASE: process.env.PAPERCUSP_MCP_PROXY_BASE || `http://127.0.0.1:${port}`,
        PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify(execution.context),
      },
      });
    } catch (error) {
      await execution.cancel(error instanceof Error ? error.message : String(error));
      throw error;
    }
    BOOTSTRAP_STATE.packagedMcpProxyProcess = child;
    child.once('exit', () => {
      if (BOOTSTRAP_STATE.packagedMcpProxyProcess === child) {
        BOOTSTRAP_STATE.packagedMcpProxyProcess = null;
      }
      void execution.finish();
    });
    child.once('error', (e) => {
      if (BOOTSTRAP_STATE.packagedMcpProxyProcess === child) {
        BOOTSTRAP_STATE.packagedMcpProxyProcess = null;
      }
      void execution.cancel(e.message);
      console.warn('[mcp-proxy] packaged proxy child failed:', (e as Error)?.message ?? e);
    });
    console.log(`[mcp-proxy] packaged proxy spawned on 127.0.0.1:${port} (dynamic operator.json target)`);
  })().catch((e) => {
    console.warn('[mcp-proxy] packaged proxy spawn failed:', (e as Error)?.message ?? e);
  });
}

async function stopPackagedMcpProxy(): Promise<void> {
  // Set this before the first await so an in-flight health probe cannot spawn
  // a fresh child after SIGTERM/SIGINT has begun draining the operator.
  BOOTSTRAP_STATE.packagedMcpProxyShutdownRequested = true;
  const child = BOOTSTRAP_STATE.packagedMcpProxyProcess;
  if (!child) return;
  await gracefulStopChild(child, {
    timeoutMs: PACKAGED_MCP_PROXY_SHUTDOWN_TIMEOUT_MS,
    kill: (sig) => child.kill(sig),
  });
  if (BOOTSTRAP_STATE.packagedMcpProxyProcess === child) {
    BOOTSTRAP_STATE.packagedMcpProxyProcess = null;
  }
}

/**
 * WI-5441/WI-5764: await this BETWEEN `runBootstrap()` and
 * `startRequestServers()` (see hono-host.ts's onWorker) so no HTTP write can
 * reach a table whose federation-capture trigger a still-applying migration
 * set hasn't created yet — the root cause su-72ce40f2 diagnosed for the
 * boot-window class of WI-5441 (WI-5441 post 53143).
 *
 * A request-only host (PAPERCUSP_BACKGROUND_WORKERS=0 — the :3170 staging
 * operator, or a cluster-mode worker) runs the same advisory-lock-coordinated
 * `applyPendingMigrationsAtBoot` preflight here before it can serve. This is
 * schema setup, not shared-DB background machinery, and is deliberately
 * repeated per request process so a request-only host cannot silently depend
 * on a background host that may be absent or stale. A null/failed result is
 * rejected by the caller, which refuses to start HTTP rather than serving code
 * against an unresolved schema. On a backgroundWorkers host it polls the
 * boot-gate flag flipped right after `applyPendingMigrationsAtBoot()` returns
 * (see the substrate-boot IIFE above), and — matching this whole boot path's
 * log-and-continue philosophy — a timeout is logged and swallowed rather than
 * wedging boot: a permanently-stuck flag must never turn into a process that
 * never serves traffic.
 */
export async function waitForBootMigrationGate(timeoutMs = 20_000): Promise<void> {
  if (!backgroundWorkersEnabled()) {
    // runBootstrap's endpoint-IPC listener and hono-host's request-server gate
    // reach this concurrently. They used to run TWO boot-migration clients:
    // one could return null while its twin succeeded, leaving HTTP healthy but
    // silently suppressing the native agent listener as a generic runtime
    // error. Share one exact preflight (success or failure) across the burst.
    // The generic helper clears after settlement, so a genuinely later call
    // remains a fresh safety check rather than replaying stale migration state.
    return dedupeInFlight(
      BOOTSTRAP_STATE.requestMigrationGateFlights,
      'request-only-boot-migration',
      async () => {
        const { applyPendingMigrationsAtBoot } = await import('@papercusp/operator-core/lib/db-boot-migrate');
        const migrationAttempt = await withBoundedTimeout(
          () => applyPendingMigrationsAtBoot(),
          {
            fallback: null,
            timeoutMs,
            label: 'request-only boot migration preflight',
          },
        );
        if (migrationAttempt.degraded) {
          if (migrationAttempt.reason === 'error') {
            throw migrationAttempt.error instanceof Error
              ? migrationAttempt.error
              : new Error(
                  `[host-bootstrap] request-only migration preflight failed: ${migrationAttempt.errorMessage ?? 'unknown error'}`,
                );
          }
          throw new Error(
            `[host-bootstrap] request-only migration preflight ${migrationAttempt.reason ?? 'degraded'} after ${timeoutMs}ms`,
          );
        }
        const migrationResult = migrationAttempt.value;
        if (!migrationResult || migrationResult.failed.length > 0) {
          const failureSummary = migrationResult
            ? `${migrationResult.failed.length} migration(s) remain pending: ${migrationResult.failed
                .map((failure) => `${failure.file}: ${failure.error}`)
                .join('; ')}`
            : 'migration state could not be determined';
          throw new Error(`[host-bootstrap] request-only migration preflight failed: ${failureSummary}`);
        }
        const { markMigrationsAppliedForRequestGate } = await import(
          '@papercusp/operator-core/lib/sync/hyperbee/boot-gate'
        );
        markMigrationsAppliedForRequestGate();
      },
    );
  }
  try {
    const { awaitMigrationsAppliedForRequestGate } = await import(
      '@papercusp/operator-core/lib/sync/hyperbee/boot-gate'
    );
    await awaitMigrationsAppliedForRequestGate({ timeoutMs });
  } catch (e) {
    console.warn(
      `[host-bootstrap] migrations-applied request gate did not flip within ${timeoutMs}ms — starting the request server anyway (non-fatal; WI-5441/WI-5764 boot-window guard degrades open, it never wedges boot):`,
      e instanceof Error ? e.message : e,
    );
  }
}

/** Coord identity for the cpu-task breaker broadcast (mirrors supervision-reconcile's). */
const CPU_WORKER_BREAKER_IDENTITY = {
  ownerId: 'worker-breaker-watch',
  ownerLabel: 'worker-breaker-watch',
  source: 'static-client' as const,
  workspaceId: null,
  userId: null,
};

export function runBootstrap(): void {
  if (BOOTSTRAP_STATE.ran) return;
  BOOTSTRAP_STATE.ran = true;

  // Request-only hosts serve the HTTP/tool plane but do not own the host-wide
  // warmers, voice transports, or credential refreshers. Keep this predicate
  // separate from backgroundWorkersEnabled(): requestOnlyHost() is a pure
  // topology check with no VITEST short-circuit, so it remains correct for
  // explicit secondary hosts and for source-level boot guards.
  const requestOnly = requestOnlyHost();
  const utilityHost = utilityHostEnabled();
  if (requestOnly) {
    console.log('[host] request-only startup profile — deferring host-wide warmers and voice transports until an explicit request');
  }

  // [WI-37700] Give the cpu-task worker's crash-breaker a voice. The breaker latches
  // PERMANENTLY on repeated failure and the sync fallback is byte-identical, so a trip
  // is otherwise invisible — no error, no exit code, just the event-loop lag that module
  // exists to remove. Wired HERE rather than in a background-workers block on purpose:
  // runBootstrap runs in EVERY process, and on a clustered host the offload (and so the
  // breaker) lives independently in each forked request worker, which is exactly the
  // state /api/health/deep can only sample 1-of-N. `to: ['*']`, report-only — the
  // fallback keeps serving correct responses, so this is scheduled work, not a page.
  // try/catch + a void'd promise: a notifier on a degradation path must never throw into
  // a response handler or wedge boot.
  try {
    configureCpuWorkerBreakerNotifier((summary) => {
      void (async () => {
        const { sendMessage } = await import(
          '@papercusp/operator-core/lib/agent-tools/coordination/messages'
        );
        await sendMessage(CPU_WORKER_BREAKER_IDENTITY, {
          to: ['*'],
          summary,
          category: 'health',
          kind: 'message',
        });
      })().catch((e) => {
        console.warn('[cpu-task-worker] breaker broadcast failed (non-fatal):', (e as Error)?.message ?? e);
      });
    });
  } catch (e) {
    console.warn('[cpu-task-worker] breaker notifier wiring failed (non-fatal):', (e as Error)?.message ?? e);
  }

  // [harness-provided-cadence-ops-2026-06-26 D-007 / WI-1146] Make the launch-blueprint
  // resolver installed-aware (installed `~/.papercusp/blueprints` → built-in) — the same
  // resolution blueprint:validate/catalog use. Without this the default resolver is
  // built-in-ONLY, so a HARNESS-provided cadence blueprint (e.g. oddsmith-prospector)
  // fired by a `system:blueprint-run` routine throws `no built-in blueprint`. Purely
  // additive (built-in ids resolve identically). try/catch so it can never wedge boot.
  try {
    setLaunchBlueprintResolver(installedAwareLaunchResolver());
  } catch (e) {
    console.warn('[launch-resolver] installed-aware wiring failed (non-fatal):', (e as Error)?.message ?? e);
  }

  // Autonomous launchers (Queen/Overwatch/fleet) resolve backend + model from
  // process.env. The settings page persists those knobs in PG, so hydrate them
  // on boot before background wake machinery starts.
  void (async () => {
    try {
      applyToProcessEnv(await readAgentConfig());
    } catch (e) {
      console.warn('[agent-config] boot env hydration failed:', (e as Error)?.message ?? e);
    }
    // [EI-727] Fail loud BEFORE the first wake burns a turn silently discovering
    // this live — see agentCmdBootWarning's docstring. The agentProducedTurn
    // empty-output check (fleet/invoke-outcome.ts) already classifies the
    // resulting no-turn fire as failed/infra_loss rather than a silent `done`;
    // this is the earlier, cheaper signal.
    const warning = agentCmdBootWarning({
      AGENT_CMD: process.env.AGENT_CMD,
      CLAUDE: process.env.CLAUDE,
    });
    if (warning) console.warn(`[agent-config] ${warning}`);
  })();

  // [A2 infra-fail-fast-build-integrity-2026-06-19] Boot native-addon self-check.
  // Test-loads the required native addons (better-sqlite3 / mem0's store) under
  // the runtime Node and logs LOUDLY if one won't load — turning the 2026-06-19
  // outage (ABI-mismatched addon → mem0 load fail → every memory handler hangs
  // behind a green health check) into a visible boot error. SAFE by default: it
  // never exits unless PAPERCUSP_ADDON_PREFLIGHT_FATAL=1 (flag-gated until
  // validated, so it can't crashloop a healthy / memory-disabled host).
  // try/catch so the check itself can never wedge boot.
  try {
    runBootAddonPreflight();
  } catch (e) {
    console.warn('[addon-preflight] boot self-check errored (non-fatal):', (e as Error)?.message ?? e);
  }

  // [fleet-reliability-verification-2026-07-10 P-008] Self-report this runtime's
  // build identity into the deploys:vintage ledger so "is the fix actually
  // running there" resolves in one query instead of manual ssh + log-tailing.
  // `unit` defaults to a port-keyed hono-host label (dev-api/staging-api/prod all
  // run this same entrypoint on different ports) or 'desktop-sidecar' under a
  // packaged desktop install; PAPERCUSP_VINTAGE_UNIT overrides either default for
  // a deployment that wants a more specific label (e.g. a systemd unit name).
  try {
    const port = process.env.PAPERCUSP_HONO_PORT ?? process.env.PORT ?? '3070';
    const isDesktop = process.env.PAPERCUSP_DESKTOP === '1';
    const unit = process.env.PAPERCUSP_VINTAGE_UNIT?.trim() || (isDesktop ? 'desktop-sidecar' : `hono-host:${port}`);
    reportRuntimeVintageOnBoot(unit, {
      desktop: isDesktop,
      envOperatorId: process.env.PAPERCUSP_ENV_OPERATOR_ID || null,
      platform: process.platform,
      arch: process.arch,
      port,
    });
  } catch (e) {
    console.warn('[runtime-vintage] boot self-report wiring failed (non-fatal):', (e as Error)?.message ?? e);
  }

  // [EI-2224 startup validation] Home-harness slug resolution check. Fail-fast:
  // if the configured home harness slug doesn't resolve to a registered project,
  // fire-paths (dispatcher, overwatch, routines) will 404 silently and go dark.
  // This has happened twice (config drift + host restart). The validation
  // throws with a clear error if home harness is unregistered — loud failure
  // instead of silent 404 dispatcher dark.
  void (async () => {
    try {
      await validateHomeHarnessResolution();
      console.log('[home-harness] startup validation passed — home harness slug resolves');
    } catch (e) {
      // EI-9919: a packaged desktop's FIRST boot always fails this check before its
      // first-boot hive auto-provisioning (BUG-1 below) has necessarily completed —
      // that is an expected, self-resolving gap, not a real misconfiguration. Only
      // soften the wording when NO project is registered at all (the fresh-install
      // signature); a registered-but-wrong slug is genuine drift and stays loud.
      const freshInstallGap =
        process.env.PAPERCUSP_DESKTOP === '1' && (await isLikelyFreshInstallGap());
      if (freshInstallGap) {
        console.log(
          '[home-harness] startup validation: no project registered yet — expected on a ' +
          'fresh packaged install before first-boot hive provisioning completes (see BUG-1 ' +
          "below); this self-resolves once the papercusp hive is cloned + registered, on a " +
          'later boot. (Underlying check: ' + ((e as Error)?.message ?? e) + ')'
        );
      } else {
        console.error('[home-harness] STARTUP VALIDATION FAILED:', (e as Error)?.message ?? e);
      }
      // [shared-hive-public-release-2026-06-22 BUG-1] Do NOT crash the operator by
      // default. A fresh PACKAGED desktop install legitimately has no registered
      // home-harness project yet (the baked default slug 'papercusp' doesn't resolve
      // in the 'default' workspace until setup), and re-throwing here is an UNHANDLED
      // promise rejection → Node process exit → embedded-PG down → the app is dead on
      // first launch for every new user (caught by the 2-machine release rig). Mirror
      // the sibling addon-preflight policy above: log LOUDLY (preserves the EI-2224
      // "don't go dark silently" intent) and only hard-fail when explicitly opted in
      // — the dev/server operator (and CI/green-gate) can set
      // PAPERCUSP_HOME_HARNESS_VALIDATION_FATAL=1 to restore fail-fast.
      if (homeHarnessValidationFatal()) throw e;
    }
  })();

  // [EI-2224 startup validation / EI-10660 / EI-18678269428596559] Active routines must target
  // a REGISTERED harness. A routine whose install_slug no longer resolves still sits there
  // `active = true` while its fire-path 404s — it goes dark without an error, or worse, keeps
  // firing (git-sync / green-checkpoint singletons) against orphaned state. The drift that
  // causes it is boot-shaped (registry cleared/rebuilt, a host restart introducing a slug
  // mismatch), which is why the check belongs here. It was written for exactly this and then
  // never called from anywhere: a guard that nothing invokes is not a guard (EI-10660).
  // `enforceActiveRoutines` (not the bare validator) so a violation is auto-PAUSED here, not
  // just logged FATAL forever — see its doc comment for the concurrency + no-FK-cascade
  // rationale. Fail-soft like its siblings.
  void (async () => {
    try {
      const { enforceActiveRoutines } = await import(
        '@papercusp/operator-core/lib/startup/validate-active-routines'
      );
      const r = await enforceActiveRoutines();
      if (r.ok) console.log(`[routine-validation] startup validation passed — ${r.activeRoutineCount} active routine(s) resolve: [${r.activeRoutineNames.join(', ')}]`);
    } catch (e) {
      console.warn('[routine-validation] startup validation skipped (non-fatal):', (e as Error)?.message ?? e);
    }
  })();

  // [EI-10625 startup validation] Declared-vs-materialized learning singletons. The guard
  // above checks that the routines we HAVE resolve; this one checks that the routines we
  // DECLARED exist at all — a loop added to LEARNING_SINGLETONS whose routine row was never
  // materialized has no row to inspect, so no row-scanning check can ever see it. That is
  // how the memory recall canary (EI-10047) sat dead on arrival for its whole life: 0 runs,
  // no error, and a health panel that read `n/a`. Read-only + fail-soft: a boot must never
  // die over a health check, and healing is an explicit human act (--reconcile --execute).
  void (async () => {
    try {
      const { validateDeclaredSingletons } = await import(
        '@papercusp/operator-core/lib/startup/validate-declared-singletons'
      );
      // A fresh operator host's first boot validates before the asynchronous dogfood-hive
      // bootstrap has had a chance to register its first project. This applies to both the
      // packaged desktop and an isolated Hono host: in that known empty-workspace window,
      // every @singleton row is absent by construction, so running the detector produces a
      // misleading FATAL on a service that is serving normally. Defer only this recognized
      // fresh-install case. Once any project exists, keep the detector loud so a genuinely
      // established workspace cannot hide an unmaterialized learning loop behind the
      // first-boot exception.
      if (await isLikelyFreshInstallGap()) {
        console.log(
          '[declared-singletons] startup validation deferred — fresh install has no ' +
            'registered project yet; retry after first-boot hive provisioning',
        );
        return;
      }
      const r = await validateDeclaredSingletons();
      if (r.ok) console.log(`[declared-singletons] startup validation passed — ${r.checked} loop(s) materialized`);
      // The not-ok path already logged FATAL, naming each loop that will never run.
    } catch (e) {
      console.warn('[declared-singletons] startup validation skipped (non-fatal):', (e as Error)?.message ?? e);
    }
  })();

  // [D-007 startup validation] Always-on bespoke routines that are seeded but PAUSED. The two
  // guards above ask "do the routines we have resolve?" and "do the routines we declared
  // exist?" — neither asks "are the routines that must be RUNNING actually running?", and a
  // paused row answers yes to both. That gap let `unguarded-halt-rescue` — the sweep that
  // re-wakes silently-stopped agents — sit active=false for 11.9 days (measured 2026-08-08)
  // while the other six routines in its registry fired normally.
  //
  // `routines:set` now escalates at the pause instant (D-001), which is the primary rail. This
  // is the BACKSTOP for the case that rail cannot see: a flip that bypassed the tool. That is
  // not hypothetical — EI-18137248342636257 found active=false written through an UNAUDITED
  // path, with no audit_log row anywhere near the change.
  //
  // Boot is the right home precisely because it is SELF-ARMING: this checker must never become
  // a bespoke-seeded routine, since the failure class it detects ("the seed script nobody ever
  // ran") applies to it too, and it is the only thing that would catch that. Read-only and
  // fail-soft like its siblings — a boot must never die over a health check.
  //
  // PRIMARY-ONLY (cluster.isPrimary), UNLIKE the two guards above. They only console.log, so
  // running in all 17 :3070 cluster workers is merely redundant; this one ends in a
  // notifyAttention, and 17 workers reaching the same verdict would page the owner 17 times per
  // boot — the EI-19305266463631270 duplication bug with a human on the receiving end. The
  // routines table is shared, so one read per HOST is also the only non-wasteful shape.
  // `backgroundWorkersEnabled()` is NOT the gate: it is env-only and a fork inherits env.
  if (cluster.isPrimary) void (async () => {
    try {
      const [{ checkBespokeActiveSeeds, operatorHomeScope }, { getOrgPg }] = await Promise.all([
        import('@papercusp/operator-core/lib/harness/routines/bespoke-active-seeds-check'),
        import('@papercusp/db-org'),
      ]);
      const { installSlug, workspaceId } = operatorHomeScope();
      // A packaged desktop's first boot can reach this backstop before the asynchronous
      // dogfood-hive bootstrap registers its first project. In that known empty-workspace
      // window every bespoke active seed is absent by construction; defer the owner-facing
      // alarm until the next boot, when first-boot provisioning has had a chance to finish.
      // Once any project exists, keep the check loud so established workspaces cannot hide
      // a missing or paused always-on routine behind the fresh-install exception.
      if (process.env.PAPERCUSP_DESKTOP === '1' && (await isLikelyFreshInstallGap(workspaceId))) {
        console.log(
          '[bespoke-active-seeds] startup validation deferred — fresh packaged install has no ' +
            'registered project yet; retry after first-boot hive provisioning',
        );
        return;
      }
      const { sql } = getOrgPg();
      const r = await checkBespokeActiveSeeds({ sql: sql as unknown as never, installSlug, workspaceId });
      if (r.ok) {
        console.log(`[bespoke-active-seeds] startup validation passed — all always-on routines ACTIVE for "${installSlug}"`);
        return;
      }
      for (const e of r.missing)
        console.error(`[bespoke-active-seeds] MISSING: "${e.name}" has no row for "${e.installSlug}" — never seeded. Fix: tsx packages/operator-core/lib/harness/routines/${e.seedScript}`);
      for (const e of r.inactive)
        console.error(`[bespoke-active-seeds] INACTIVE: "${e.name}" is seeded but active=false for "${e.installSlug}" (reason: ${e.pauseReason ?? 'NONE RECORDED — flipped by an unaudited path'})`);
      // Present + ACTIVE but not executing — the case this check was blind to until the
      // ephemeral executor's boot-only rescan left `frozen-candidate-drift-sweep` permanently
      // dark with active=true. Reported separately because the repair differs from un-pausing.
      for (const e of r.dark)
        console.error(
          e.neverFired
            ? `[bespoke-active-seeds] DARK: "${e.name}" is ACTIVE for "${e.installSlug}" but has NEVER fired in the ${Math.round(e.ageSec / 60)}m since it was created — nothing is executing it (an ephemeral row seeded after this host booted gets no timer until the next boot or a syncEphemeralRoutine event)`
            : `[bespoke-active-seeds] DARK: "${e.name}" is ACTIVE for "${e.installSlug}" but last fired ${Math.round(e.ageSec / 60)}m ago, far past its declared ${e.intervalSec}s cadence`,
        );
      // Only the un-re-affirmed ones wake a human; a dated `reviewBy` is a deliberate hold.
      if (r.escalatable.length === 0) return;
      const { notifyAttention } = await import('@papercusp/operator-core/lib/attention-notify');
      // Seed writers may target different harnesses. Keep the existing one-slug notification
      // API and emit one alert per resolved scope rather than attributing every finding to the
      // operator home harness (which made hive-canary findings point at the wrong owner).
      const escalatableBySlug = new Map<string, typeof r.escalatable>();
      for (const entry of r.escalatable) {
        const scoped = escalatableBySlug.get(entry.installSlug);
        if (scoped) scoped.push(entry);
        else escalatableBySlug.set(entry.installSlug, [entry]);
      }
      for (const [targetInstallSlug, entries] of escalatableBySlug) {
        const names = entries.map((e) => e.name);
        await notifyAttention({
          kind: 'intervention',
          importance: 'high',
          harnessSlug: targetInstallSlug,
          title: `${names.length} always-on routine(s) are not running`,
          body:
            `${names.join(', ')} — seeded ACTIVE by default but currently missing or paused, and ` +
            `nothing re-arms them on their own. Detected at operator boot.`,
          data: { routines: names.join(','), installSlug: targetInstallSlug, event: 'always-on-routine-not-running' },
        });
      }
    } catch (e) {
      console.warn('[bespoke-active-seeds] startup validation skipped (non-fatal):', (e as Error)?.message ?? e);
    }
  })();

  // [EI-19298078028509573 startup visibility] Record the Postgres durability settings
  // (synchronous_commit / fsync / full_page_writes) on every boot. Purely observational —
  // never gates boot, never changes the setting — so that a post-crash "the row I know I
  // wrote is gone" investigation starts from a KNOWN fact (relaxed durability was in effect)
  // instead of rediscovering it hours in. Fail-soft like its siblings above.
  void (async () => {
    try {
      const { checkDurabilitySettings } = await import(
        '@papercusp/operator-core/lib/startup/validate-durability-settings'
      );
      await checkDurabilitySettings();
    } catch (e) {
      console.warn('[durability-settings] startup check skipped (non-fatal):', (e as Error)?.message ?? e);
    }
  })();

  // [EI-19389225060317498 startup visibility] The repoint (734) and readiness-resync (379)
  // triggers on work_items/work_item_deps must move TOGETHER — 734's own header only warns
  // about `repoint_qualified_refs_trg`, but readiness silently strands at the old
  // harness_slug if `wir_deps_sync_trg` alone is disabled during a bulk backfill (measured
  // in rename-drift-effectiveness.integration.test.ts). Purely observational — never gates
  // boot, never touches trigger state — so a disabled/missing coupled trigger is DETECTED
  // and logged loudly instead of silently trusted. Fail-soft like its startup/ siblings.
  void (async () => {
    try {
      const { checkRepointTriggersEnabled } = await import(
        '@papercusp/operator-core/lib/startup/validate-repoint-triggers'
      );
      await checkRepointTriggersEnabled();
    } catch (e) {
      console.warn('[repoint-trigger-guard] startup check skipped (non-fatal):', (e as Error)?.message ?? e);
    }
  })();

  // [cupboard-public-release-2026-07-12 P-001] Move the installed-packs root
  // `~/.papercusp/learning-packs/` → `~/.papercusp/knowledge-packs/`.
  //
  // The learning→knowledge-packs rename is HARD, with no read-time aliases
  // (knowledge-packs-2026-07-11 D-001): the loader now looks ONLY at the new
  // path. The builtin packs ship inside the app bundle and moved with the code,
  // but the INSTALLED root lives in the user's home — so an existing install has
  // real Comb-installed packs sitting under the old name that the new loader
  // cannot see. Without this move they don't error, they just silently VANISH
  // from the pack list. The move is the migration; there is no dual-read.
  //
  // Idempotent + fail-soft, like its siblings above: no legacy dir (the
  // fresh-install case) and an already-migrated root are both clean no-ops, and
  // a boot must never die over it — a failure here leaves the packs exactly
  // where they are and the NEXT boot retries.
  void (async () => {
    try {
      const { migrateInstalledRoot, migrateFleetLessonsToSharedRoot } = await import(
        '@papercusp/operator-core/lib/knowledge-packs/load-packs'
      );
      const r = await migrateInstalledRoot();
      if (r.moved) {
        console.log(`[knowledge-packs] migrated installed-packs root: ${r.from} → ${r.to}`);
      }
      // knowledge-pack-loop-integrity P-005: the GLOBAL fleet-lessons pack
      // moves out of the per-workspace installed root into the shared root
      // (same idempotent/fail-soft posture as the rename migration above).
      const fl = await migrateFleetLessonsToSharedRoot();
      if (fl.moved) {
        console.log(`[knowledge-packs] migrated fleet-lessons to the shared root: ${fl.from} → ${fl.to}`);
      }
    } catch (e) {
      console.warn('[knowledge-packs] installed-root migration skipped (non-fatal):', (e as Error)?.message ?? e);
    }
  })();

  // [ship-papercusp-as-single-hive 2026-06-23, owner-directed] On a PACKAGED desktop
  // install, ensure the `papercusp` dogfood hive exists — clone the repo on first
  // boot (too large to bundle, ~5GB) and home on it — so the app ships with
  // `papercusp` as its single hive instead of an empty/unresolved home (this is what
  // makes the home-harness validation ABOVE resolve on a fresh packaged install,
  // BUG-1). Desktop-only (never hijacks a dev/server operator's workspace),
  // flag-gated, fire-and-forget + non-fatal: a missing `gh` auth / no network / an
  // already-present hive all no-op cleanly and the NEXT boot retries.
  if (process.env.PAPERCUSP_DESKTOP === '1') {
    // WI-3247: packaged operators use dynamic per-boot ports. Keep psu/Claude/Codex
    // sessions pinned to a stable loopback front door that re-resolves operator.json
    // after restarts, instead of baking the current dynamic port into child env.
    startPackagedMcpProxy();

    // WI-5165: ONLY the process that may boot the substrate runs the hive bootstrap.
    // A packaged install runs several desktop-flagged operators (the main one plus the
    // dev-source env sidecars, which set PAPERCUSP_BACKGROUND_WORKERS=0 and log to
    // /dev/null); all of them used to race this block. A request-only sidecar could WIN
    // the self-admit race — registering the pot — then fail its own substrate boot on
    // boot-all's request-only-host guard, while the main operator saw the entry as
    // "already-present" and never booted either: the seeded pot shipped as an empty
    // shell (0 work items / plans despite the restored 855MB corestore).
    if (backgroundWorkersEnabled()) void (async () => {
      try {
        if (!(await getFlag(FLAGS.DOGFOOD_PAPERCUSP_POT, 'system'))) return;
        const { startBootstrapPapercuspHive } = await import(
          '@papercusp/operator-core/lib/harness/bootstrap-papercusp-hive'
        );
        // Single-flight: shares ONE run with the wizard's post-gh-auth
        // /api/desktop/bootstrap-pot/start trigger (no double clone).
        const res = await startBootstrapPapercuspHive().done;
        if (res.state !== 'skipped') {
          console.log(
            `[papercusp-hive] ${res.state}: ${res.slug ?? '(none)'}${res.path ? ` @ ${res.path}` : ''}`,
          );
        } else if (res.reason) {
          console.log(`[papercusp-hive] not created this boot: ${res.reason}`);
        }
      } catch (e) {
        console.warn('[papercusp-hive] bootstrap failed (non-fatal):', (e as Error)?.message ?? e);
      }
    })();
  }

  // [systemic-federation-activation 2026-07-01, owner-directed] Publish the canonical
  // `papercusp` hive's owner identity gist + announce it on EVERY operator boot — NOT
  // only PAPERCUSP_DESKTOP installs. The desktop-only bootstrap above meant a canonical
  // hive OWNED by a HEADLESS server operator (the dev/staging/prod backend that actually
  // holds the hive private key) never ran the Solution-C share path, so its identity gist
  // was never published and NO install could federate its content — a joiner with no gist
  // to adopt mints its own empty per-device hive (dogfood-silent-canonical-hive-join;
  // proven live 2026-07-01: owner `papercusp` hive with ~1.6k work items but no gist →
  // fresh install federated 0 items). shareExistingHive() is fully SELF-GATING and safe to
  // call on any box: it no-ops unless (a) DOGFOOD_PAPERCUSP_POT_SHARE is on, (b) `gh` is
  // signed in, AND (c) this box OWNS the hive (goSharedHive's first-device path returns
  // when it can't load the hive private key from the keychain); a gist/pubkey divergence
  // also self-skips. Idempotent (re-announces each boot), fire-and-forget + non-fatal.
  void (async () => {
    try {
      const { shareExistingHive } = await import(
        '@papercusp/operator-core/lib/harness/papercusp-hive-share'
      );
      await shareExistingHive();
    } catch (e) {
      console.warn(
        '[papercusp-hive] owner-side share failed (non-fatal):',
        (e as Error)?.message ?? e,
      );
    }
  })();

  // [dogfood-silent-canonical-hive-join P-017 / D-006/D-007/D-009] Install-time
  // provisioning of the LOCAL env operators (dev :3270 / prod :3070 / staging :3170 /
  // local :3055) from the already-cloned `papercup` source, so the cross-platform env
  // switcher (EnvSwitcherBar) — which self-hides on a single-operator install — lights up.
  // DEFAULT-ON under the desktop (WI-3285): every PAPERCUSP_DESKTOP=1 boot provisions
  // unless explicitly opted out with PAPERCUSP_PROVISION_ENV_OPERATORS=0. It originally
  // shipped dark behind an opt-IN (=1) that no build path exported — the classic
  // finished-work-ships-dark failure: every packaged install rendered all-dead switcher
  // buttons (owner-reported on the Windows build; "The buttons should all be
  // operational"). Never on a non-desktop host — the dev box's env operators are managed
  // by their own launchers. SAFE: every operator it spawns is REQUEST-ONLY
  // (PAPERCUSP_BACKGROUND_WORKERS=0) so the EI-126 single-writer invariant holds — only
  // THIS primary runs the shared-DB background machinery. Idempotent (skips ports already
  // served + this operator's own), graceful (missing tree/toolchain ⇒ that env is skipped;
  // the launcher npm-installs a dep-less seeded checkout once, best-effort),
  // fire-and-forget + non-fatal (a failure can never wedge boot; the launcher swallows its
  // own per-env errors). The launch is deferred ~20s so the PRIMARY's migrations + substrate
  // boot win the race against the request-only siblings (no cold-boot migration contention).
  if (
    !isVmReleaseDistribution() &&
    process.env.PAPERCUSP_DESKTOP === '1' &&
    process.env.PAPERCUSP_PROVISION_ENV_OPERATORS !== '0'
  ) {
    const armEnvOperators = setTimeout(() => {
      void (async () => {
        // Keep a local fallback because the canonical formatter is loaded by the
        // module import below; if that import fails, the failure path still needs
        // to emit the machine-readable terminal marker.
        let formatEnvOperatorPass2Result: (input: {
          status: 'ran' | 'skipped' | 'failed';
          spawned?: number;
          skipped?: number;
          reason?: string;
        }) => string = ({ status, spawned, skipped, reason }) => {
          const fields = [`[env-operators] PASS2_RESULT status=${status}`];
          if (spawned !== undefined) fields.push(`spawned=${spawned}`);
          if (skipped !== undefined) fields.push(`skipped=${skipped}`);
          if (reason !== undefined) fields.push(`reason=${reason}`);
          return fields.join(' ');
        };
        try {
          const {
            formatEnvOperatorPass2Result: canonicalFormatEnvOperatorPass2Result,
            launchEnvOperators,
            isTransientSkip,
          } = await import(
            '@papercusp/operator-core/lib/harness/env-operator-launcher'
          );
          formatEnvOperatorPass2Result = canonicalFormatEnvOperatorPass2Result;
          // [WI-3330] Launch the BUNDLED env operators (prod:3070/staging:3170/
          // release) FIRST — they need no source tree, so a fresh install gets them
          // within seconds instead of waiting out the ~8-10min first-boot source
          // extract below. dev(:3270)/local(:3055) skip on this pass ('no-source-tree'
          // — PAPERCUSP_DEV_SOURCE_ROOT is still unset) and spawn on the second pass
          // once the tree is extracted. launchEnvOperators skips already-reachable
          // operators, so the second call is idempotent for the bundled ones.
          const first = await launchEnvOperators();
          // Envs skipped only because their source tree is still being unpacked — they are
          // expected to spawn on pass 2. Naming them here (and CLOSING the deferral below,
          // whichever way it resolves) is what stops pass 1 reading as a terminal verdict
          // that dev/local are broken (EI-19442842364710969).
          const deferredIds = first.skipped
            .filter((s) => isTransientSkip(s.reason))
            .map((s) => s.id);
          console.log(
            `[env-operators] bundled pass (1/2): spawned=${first.spawned.length} skipped=${first.skipped.length}` +
              (deferredIds.length
                ? ` — ${deferredIds.join('+')} deferred to pass 2 (awaiting the source extract), NOT unavailable`
                : ''),
          );

          // [WI-3308] First-boot: extract the bundled dev/local runnable source
          // tree (if a source-bundled build shipped one at PAPERCUSP_SOURCE_ARCHIVE)
          // into the writable PAPERCUSP_DEV_SOURCE_DIR, then export
          // PAPERCUSP_DEV_SOURCE_ROOT so the launcher's defaultDetectSourceRoot runs
          // dev(:3270)/local(:3055) from it. No-op + non-fatal when no bundle shipped
          // (dev/local stay skipped 'no-source-tree', exactly as before this feature).
          let devSourceRoot: string | null = null;
          try {
            const { extractDevSourceTree } = await import('../lib/dev-source-extract');
            devSourceRoot = await extractDevSourceTree({
              archivePath: process.env.PAPERCUSP_SOURCE_ARCHIVE,
              targetDir: process.env.PAPERCUSP_DEV_SOURCE_DIR,
              log: (m) => console.log(m),
            });
            if (devSourceRoot) process.env.PAPERCUSP_DEV_SOURCE_ROOT = devSourceRoot;
          } catch (e) {
            console.warn(
              '[dev-source] extract failed (non-fatal):',
              (e as Error)?.message ?? e,
            );
          }

          // [WI-3330] Second pass — spawns dev/local from the freshly-extracted tree
          // now that PAPERCUSP_DEV_SOURCE_ROOT is set; the bundled operators from the
          // first pass are skipped as already-reachable. Only when the extract yielded
          // a source root (no bundle → nothing new to spawn, skip the redundant call).
          if (devSourceRoot) {
            const second = await launchEnvOperators();
            console.log(
              `[env-operators] source pass (2/2): spawned=${second.spawned.length} skipped=${second.skipped.length}`,
            );
            console.log(
              formatEnvOperatorPass2Result({
                status: 'ran',
                spawned: second.spawned.length,
                skipped: second.skipped.length,
              }),
            );
          } else if (deferredIds.length) {
            // CLOSE the deferral in the failure direction too. Without this the last word
            // on dev/local is "deferred to pass 2" and pass 2 never runs — a promise the
            // log never keeps, which is the same false-signal bug with the sign flipped.
            // ⚠ Deliberately does NOT contain the substring "source pass": the WI-3307
            // acceptance harness greps `[env-operators] source pass` to mean "pass 2 RAN",
            // so phrasing this failure line that way would make a failed extract score as
            // a PASS — the same reads-like-success-means-failure bug this change fixes.
            console.log(
              `[env-operators] pass 2 SKIPPED — no source tree was produced, so ${deferredIds.join(
                '+',
              )} are unavailable for this boot (now terminal, not pending)`,
            );
            console.log(
              formatEnvOperatorPass2Result({
                status: 'skipped',
                reason: 'no-source-tree',
                skipped: deferredIds.length,
              }),
            );
          } else {
            // No source archive was shipped, so there is no source pass to run. Emit the
            // terminal outcome anyway: consumers must distinguish "not applicable" from
            // "waiting for a pass" without parsing prose.
            console.log(
              formatEnvOperatorPass2Result({
                status: 'skipped',
                reason: 'no-source-archive',
              }),
            );
          }
        } catch (e) {
          console.log(
            formatEnvOperatorPass2Result({
              status: 'failed',
              reason: 'provisioning-error',
            }),
          );
          console.warn('[env-operators] provisioning failed (non-fatal):', (e as Error)?.message ?? e);
        }
      })();
    }, 20_000);
    armEnvOperators.unref?.();
  }

  // [power] P5-3 of operator-scalability-event-loop-2026-06-16 — detect the power
  // source ONCE and fold onBattery into the resource profile BEFORE the background
  // machinery reads it. Fire-and-forget + first thing at boot so it (a few fast fs
  // reads) almost always wins the race against the first getResourceProfile()
  // consumer; if it loses, or on a server we can't read, the profile defaults to
  // AC = full power — battery state never wrongly throttles a plugged-in host.
  void (async () => {
    try {
      const { primePowerSource } = await import('@papercusp/operator-core/lib/resource-profile');
      const source = await primePowerSource();
      if (source !== 'unknown') {
        console.log(`[power] source=${source} — P5-3 cadence/concurrency adjusted accordingly`);
      }
    } catch {
      /* non-fatal — defaults to AC / full power */
    }
  })();

  // [pg-budget] C0-4 of backend-connection-scaling-2026-06-17 — log this
  // process's worst-case PG connection ceiling vs the live max_connections, so a
  // future pool-sizing change can't silently re-create the 2026-06-17 connection
  // exhaustion. Fire-and-forget on EVERY host (the request-only :3170 was a top
  // holder); resilient if PG isn't ready yet.
  void (async () => {
    try {
      const { logConnectionBudget } = await import('@papercusp/db-org');
      await logConnectionBudget((m) => console.log(m));
    } catch {
      /* non-fatal diagnostic */
    }
  })();

  // HostPlatform registration — every getHostPlatform() consumer (agent:role,
  // operator:scanner prompt resolvers, …) throws without it. This call lived
  // ONLY in the retired instrumentation-node.ts (same story as the IPC server
  // start below) and was dropped, not ported, when that file was deleted
  // (5694e7d58) — prompts/get on every host threw from then on. The operator
  // is always either Tauri-hosted or a local-dev Node process — both are
  // "desktop" for HostPlatform purposes. A future server host would register
  // `serverHostPlatform` from its own entry point. try/catch: tests that
  // registered a mock before calling runBootstrap() must not crash the boot.
  try {
    registerHostPlatform(desktopHostPlatform);
  } catch (err) {
    console.warn('[host-platform] register failed (non-fatal):', err);
  }

  // Endpoint-IPC server — the webview→Tauri→Node fast path. The packaged
  // desktop spawns this sidecar with PAPERCUSP_IPC_ENABLE=1 and watches stdout
  // for the `PAPERCUSP_IPC_READY socket=<path>` handshake line within a 30s
  // window; the Rust client then connects and the operator SPA's /api fetch +
  // EventSource ride IPC. Under the papercusp:// origin (Phase 4, default-on)
  // this is load-bearing for STREAMING: if IPC never comes up, /api falls back
  // to the buffering custom_protocol handler and SSE stops streaming.
  //
  // This start used to live ONLY in the now-retired instrumentation-node.ts
  // (a Next hook the Hono host never runs), so packaged builds printed no
  // ready line → 30s timeout → IPC disabled → SSE buffered. Ported here, the
  // live boot path (mirrors the DBOS block below). Started first + fire-and-
  // forget so the handshake never waits on PG/migrations. Idempotent via the
  // runBootstrap guard above.
  //
  // Enablement: the packaged desktop sets PAPERCUSP_IPC_ENABLE=1 when it
  // spawns the sidecar. The DEV desktop (`npm run dev`) does NOT spawn the
  // packaged sidecar (it points the webview at an externally-run operator),
  // so it can't set that env — yet the webview still needs IPC to escape
  // libsoup's 6-socket-per-origin pool, or its on-demand /api fetches starve
  // behind the long-lived SSE streams and hang ("loading… forever"). So
  // default IPC ON in dev (NODE_ENV !== 'production'); opt out with
  // PAPERCUSP_IPC_ENABLE=0. The retired standalone webapp is the only other
  // dev consumer and an unused unix socket there is harmless.
  const ipcEnabled =
    process.env.PAPERCUSP_IPC_ENABLE === '1' ||
    (process.env.PAPERCUSP_IPC_ENABLE !== '0' && process.env.NODE_ENV !== 'production');
  // One publisher per selected operator port. Workers must not overwrite the
  // primary's agent endpoint with an otherwise-valid UI-only descriptor.
  if (ipcEnabled && cluster.isPrimary) {
    void (async () => {
      try {
        const [
          { startEndpointIpcServer },
          { PROJECTED_DEPS },
          { listAllProjectedTools },
          { writeEndpointIpcDiscovery },
        ] = await Promise.all([
          import('@papercusp/operator-core/lib/endpoint-ipc/server'),
          import('@papercusp/operator-core/lib/projected-tool-deps'),
          import('@papercusp/tooldef'),
          import('@papercusp/operator-core/lib/endpoint-ipc-discovery'),
        ]);
        // ⚠ [WI-10000287] This block used to claim the host handler's endpoint-route
        // graph imports `agent-tools/index` before runBootstrap() runs, "so the
        // registry is already populated". That was never true: nothing imports
        // `_mcp-host.ts` statically, so that graph is only pulled on the first MCP
        // request/registration. On a requestless primary the registry may therefore
        // still be empty at this point and discovery can publish a partial allowlist.
        // Deliberately NOT fixed here (separate concern from the kernel-resolver
        // install above, which does not populate the tool registry).
        // Do not import it again through the package alias here: in isolated
        // tsx sidecars the route-relative and package-alias specifiers can
        // evaluate the same tool module twice. `rubrics:propose` then throws
        // ToolRegistrationError before endpoint IPC publishes discovery.
        // Keep this bootstrap consumer read-only; the route graph owns the
        // registry's defineTool side effects.
        // Registry-driven IPC allowlist: a tool is IPC-eligible iff it declares
        // `expose: { ipc: true }` (must be self-contained — every safety check
        // + persistence side-effect in the tool, not the route). `sys:http` —
        // the privileged HTTP-over-IPC bridge, not a defineTool projection — is
        // added explicitly. (oracle:chat + agent_chats:chat are intentionally
        // NOT eligible — route-dependent; see their tool files.)
        const ipcEligible = listAllProjectedTools()
          .filter((t) => t.expose?.ipc === true)
          .map((t) => t.expose.mcp?.name)
          .filter((n): n is string => typeof n === 'string');
        const allowedTools = [...new Set([...ipcEligible, 'sys:http'])];
        const server = await startEndpointIpcServer({
          socketPath: process.env.PAPERCUSP_IPC_SOCKET || undefined,
          deps: PROJECTED_DEPS,
          allowedTools,
        });
        // Publish the running server so its ENGAGEMENT stays observable. Until
        // this line existed, `server` was a local const in this fire-and-forget
        // IIFE: only `socketPath` escaped and the handle was dropped, which made
        // `connectionCount()`/`acceptedTotal()` unreachable for the life of the
        // process — the bridge could be listening and carrying nothing with no
        // way to find out (WI-6512). Do not refactor this registration away; the
        // engagement collector is its only reader and silently observes nothing
        // without it.
        const { setLiveEndpointIpcServer } = await import(
          '@papercusp/operator-core/lib/endpoint-ipc/engagement'
        );
        setLiveEndpointIpcServer(server);
        // Publish the resolved socket so the DEV desktop — which didn't spawn
        // us and so can't read our stdout PAPERCUSP_IPC_READY handshake — can
        // discover + connect. Harmless in the packaged build (that path uses
        // the stdout line); one code path beats gating the write.
        await writeEndpointIpcDiscovery(server.socketPath);
        // Separate authenticated agent protocol, never the trusted UI principal.
        // One selected-port descriptor owner; cluster workers must not race it.
        if (cluster.isPrimary) {
          try {
            // Same readiness boundary as HTTP; UI IPC may advertise early for
            // boot progress, but agent writes must not outrun migrations.
            await waitForBootMigrationGate();
            const { startDesktopAgentMcp } = await import(
              '@papercusp/operator-core/lib/endpoint-route/routes/transport/_mcp-uds-bootstrap'
            );
            await startDesktopAgentMcp(
              server.socketPath, Number(process.env.PAPERCUSP_HONO_PORT) || 3070,
            );
          } catch (error) {
            // No credential or untrusted metadata in startup diagnostics.
            console.error(
              `[agent-mcp-uds] listener unavailable (${agentMcpBootstrapFailureCode(error)}); ` +
              'existing HTTP route retained',
            );
          }
        }
      } catch (err) {
        console.error('[endpoint-ipc] failed to start:', err);
      }
    })();
  }

  if (!requestOnly) {
    // Prewarm the OMP-SU bootstrap (file copies + `omp config set` shell-
    // outs). Request-only hosts defer this until an explicit /adv request so
    // a short acceptance host does not pay the full agent bootstrap graph.
    import('@papercusp/operator-core/lib/ensure-omp-su')
      .then(({ ensureOmpSuInstalled }) =>
        ensureOmpSuInstalled().catch((e) =>
          console.warn('[ensure-omp-su] prewarm failed (non-fatal):', e),
        ),
      )
      .catch((e) => console.warn('[ensure-omp-su] import failed (non-fatal):', e));

    // Plugin apiRoutes — populate the in-memory registry from disk. Request-only
    // hosts intentionally leave this lazy: `/plugins/*` dispatch calls
    // dispatchPluginApiRoute(), which builds the same registry on first use.
    // Keeping the request path lazy preserves plugin functionality without
    // loading every installed plugin during a short secondary-host journey.
    mountPluginApiRoutes()
      .then((r) => {
        console.log(`[plugin-mount] mounted=${r.mounted} skipped=${r.skipped} errors=${r.errors.length}`);
        for (const e of r.errors) {
          console.warn(`[plugin-mount] error: ${e}`);
        }
      })
      .catch((e) => {
        console.warn('[plugin-mount] unexpected rejection:', e);
      });

    // Eagerly warm the plugin host so plugin-contributed tools (repomix.pack,
    // gitnexus.*, design-phase.*) are in the projected-tool registry from boot.
    // Request-only hosts use the normal first-request lazy path instead.
    import('@papercusp/operator-core/lib/plugin-host-runtime')
      .then(({ getPluginHost }) => getPluginHost())
      .then((s) => {
        console.log(`[plugin-host] warmed at boot: loaded=${s.loaded.length} errors=${s.loadErrors.length}`);
      })
      .catch((e) => console.warn('[plugin-host] boot warm failed (non-fatal):', e));
  }

  // The legacy in-process AutoLoop ticker is RETIRED (autoloop-pot-operator-
  // rebuild P-010 / D-009) — scheduled decider fires ride the durable routines
  // engine (blueprint triggers.schedule → system:blueprint-run).
  // EI-368: the whole voice cluster is skipped on a headless utility host (the
  // gym-operator) — no human ever talks to it, the legs port-scan, and they
  // pull in the holepunch native stack (part of the Napi-abort suspect set).
  if (utilityHost) {
    console.log('[host] PAPERCUSP_UTILITY_HOST=1 — headless utility host: skipping voice cluster, hyperbee substrate, and embedder warm-up (EI-368)');
  } else if (!requestOnly) {
    startMobileVoiceWs();
  }
  if (!requestOnly) startPushCredentialRefresher();
  // data-sync-push-completion P-005/D-012: the DEBOUNCED append-heavy change-detector. ONE
  // host poll per append-heavy log table → a synthesized `<table>.changed` invalidation when
  // max(id) advances, so userActions.* / auditLog.* / toastLog.* consumers push-update WITHOUT
  // the per-row notify-storm the trigger exclusion (mig 376) avoids. It fires pg_notify, so it
  // serves clients on EVERY operator (incl. :3170, which runs no background workers) — hence NOT
  // gated on backgroundWorkersEnabled (resilient: no bg-host single point of failure). A 2nd host
  // also running it is harmless — the per-call short dedupe + react-query refetch-coalescing fold
  // the duplicate fires. Started UNCONDITIONALLY with the flag checked PER-TICK at runtime, not
  // here — getFlag is fragile at host-boot (see the INFERENCE_GATEWAY note below), so a boot-gate
  // risks "silently never started"; the per-tick check is the clean kill-switch.
  void (async () => {
    try {
      const { startAppendHeavyInvalidatorHost } = await import(
        '@papercusp/operator-core/lib/sync-resolver/append-heavy-invalidator'
      );
      startAppendHeavyInvalidatorHost({
        isEnabled: () => getFlag(FLAGS.APPEND_HEAVY_LIVE_INVALIDATION, 'operator-host'),
        log: (m) => console.log(m),
      });
      console.log('[append-heavy-invalidator] started — debounced live-invalidation for append-heavy logs');
    } catch (err) {
      console.error('[append-heavy-invalidator] failed to start:', err);
    }
  })();
  if (!requestOnly && !utilityHost) {
    // P2P voice channels: the local binary audio socket (holepunch-voice-channels
    // P-006/D-010). Cheap to start; the voice swarm itself is lazy (first join).
    void (async () => {
      try {
        const { startLocalVoiceSocket } = await import('@papercusp/operator-core/lib/voice-node/local-audio-socket');
        const { socketPath } = startLocalVoiceSocket();
        console.log(`[voice-node] local audio socket at ${socketPath}`);
        // The ONE shared EL/operator voice session (universal-voice-interface-2026-06-05):
        // hosted here and attached to the same socket bus, so desktop + tui both stream
        // into one session and both receive the input + response (Model A).
        const { startOperatorVoiceHost } = await import('@papercusp/operator-core/lib/voice-node/operator-voice-host');
        startOperatorVoiceHost();
      } catch (err) {
        console.error('[voice-node] failed to start local audio socket / operator voice host:', err);
      }
    })();
    // Desktop voice surface (P-015): bridge the local audio socket over a loopback
    // WS so the Tauri webview's getUserMedia path can reach the same voice-node.
    startDesktopVoiceWs();
    // Voice relay (P-013/D-009): when PG `voice_relay.serve` opts this operator
    // in as the fleet's reachable peer, run the blind-relay server firewalled
    // peers fall back through. No-op (null) everywhere else.
    void (async () => {
      try {
        const { maybeStartVoiceRelayServer } = await import('@papercusp/operator-core/lib/voice-node/voice-relay');
        await maybeStartVoiceRelayServer();
      } catch (err) {
        console.error('[voice-relay] bootstrap check failed:', err);
      }
    })();
  }
  // hive-frame-desktops-live-view P-012: on a desktop-enabled FRAME (the
  // bootstrap advertised a display pool), publish each ACTIVE display as a
  // screen track on the harness's video channel. Viewer-driven — a track
  // encodes only while the channel has an audience. No-op everywhere else.
  if (process.env.PAPERCUSP_DESKTOP_DISPLAYS && process.env.PAPERCUSP_DESKTOP_SCREEN_TRACKS !== '0') {
    void (async () => {
      try {
        const slug = (process.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES ?? '').split(',')[0]?.trim();
        if (!slug || slug === '*') return; // a Queen/control node hosts no displays
        const { startFrameScreenPublisher } = await import(
          '@papercusp/operator-core/lib/voice-node/screen-track/screen-publisher'
        );
        startFrameScreenPublisher({ harnessSlug: slug });
        console.log(`[screen-track] frame screen publisher up for '${slug}' (tracks follow the display-lease pool)`);
      } catch (err) {
        console.error('[screen-track] failed to start the frame screen publisher:', err);
      }
    })();
  }
  // device-intervention-watcher (60s poll) retired (P-021) — escalation /
  // smoke-fail now push at the source via notifyAttention from their
  // /api/internal/*-event producers; needs-human≥high from set-status.
  // (plan-review push retired with the harness_plan_review source — B-14/P-101.)

  // Harness FS watcher — mirrors .papercusp/{summary.md,pending-reviews,proposals}
  // to PG so panels can read via Zero push instead of polling. Idempotent;
  // pinned to globalThis to survive Next dev module re-evaluation.
  //
  // EI-3385: PRIMARY-ONLY. This does a recursive chokidar watch over every harness tree
  // (~62k inotify watches per process on a busy box). Run in every clustered REQUEST
  // worker it multiplied past the kernel watch ceiling and crash-looped :3070 at 32
  // workers. It's a single-writer FS→PG mirror; request workers read the mirrored rows
  // via @papercusp/sync, so exactly ONE process should run it. `cluster.isPrimary` is
  // the right gate: true on the cluster primary AND on a non-clustered single-process
  // host, false only on a forked request worker — so it keeps working in single-process
  // mode (:3170 / desktop) and stops multiplying across cluster workers. (Gating on
  // backgroundWorkersEnabled() would NOT work: the dev-api drop-in sets
  // PAPERCUSP_BACKGROUND_WORKERS=0 service-wide, so the primary reads it false too.)
  if (cluster.isPrimary) {
    try {
      ensureHarnessFsWatcher();
    } catch (e) {
      console.warn('[api] harness-fs-watcher failed to start:', (e as Error)?.message ?? e);
    }
  }

  // Phase 3: harness_status / harness_lanes sweeper. PID-liveness based —
  // clears stale `agent_runs.running` and `harness_lanes` rows whose
  // recorded PID is gone. (TTL-based sweeps for status/scan-locks/claims/
  // auth live in the expirable registry below.) Idempotent.
  //
  // EI-19305266463631270: PRIMARY-ONLY, for the SAME reason as the fs-watcher above and
  // the credential sync below — this was the only one of the three missing the guard.
  // Its internal stand-down (harness-status-sweep.ts) keys off backgroundWorkersEnabled(),
  // which the note at the fs-watcher above already explains cannot express "once per
  // host": the dev-api drop-in sets PAPERCUSP_BACKGROUND_WORKERS=0 service-wide, so on the
  // 16-worker :3070 release cluster it read false in all 17 processes, none of them stood
  // down, and all 17 armed a 30s PID-liveness sweep (measured: 4 distinct release-worker
  // pids caught issuing harness_lanes/agent_runs statements in one 40s sample, zero from
  // bg-host). The immediate cold-boot tick made every deploy a 17-way thundering herd too.
  //
  // Coverage is unchanged in every other topology: bg-host and the desktop (backgroundWorkers
  // ON, unclustered) still stand down and let the in-process-periodic scheduler own the sweep;
  // :3170 (request-only, unclustered) still arms it as the documented fallback — all three are
  // `cluster.isPrimary === true`, so the guard is a no-op for them.
  // [agent-virtual-desktops-2026-08-23 / WI-1064431] The outbound workspace-host
  // relay connector. Until this call the relay adapter had ZERO non-test importers,
  // so the hosted PTY plane and the P-013 desktop viewer were both libraries with no
  // host process — measured, not assumed.
  //
  // No-ops unless this host is an ENROLLED hosted workspace (the three
  // PAPERCUSP_HOSTED_* vars). Unenrolled is the normal state for a dev box, for the
  // control plane, and for every non-BYOC operator, so absence is silent by design —
  // warning about it would fire on nearly every host that runs this line.
  //
  // PRIMARY-ONLY, for the same reason as the two blocks above but with a sharper
  // failure: a forked request worker inherits the environment, so an unguarded call
  // would open one outbound connector PER worker (17 on the :3070 release cluster)
  // under ONE enrollment — and the broker keys connectors by binding, so they would
  // silently evict each other rather than erroring.
  if (cluster.isPrimary) {
    try {
      const hosted = ensureHostedWorkspaceHostRuntime();
      if (hosted) console.log('[api] hosted workspace-host connector started');
    } catch (e) {
      console.warn('[api] hosted workspace-host connector failed to start:', (e as Error)?.message ?? e);
    }
  }

  if (cluster.isPrimary) {
    try {
      ensureHarnessStatusSweep();
    } catch (e) {
      console.warn('[api] harness-status-sweep failed to start:', (e as Error)?.message ?? e);
    }
  }

  // Wave-advance sweep — RETIRED (dbos-system-completion P-044 / Path A). Under
  // all-waves-up-front promotion (`plans:promote { all_waves: true }`), every
  // wave is promoted at once with cross-wave ordering written as feature
  // `blocked_by` edges, so the P-042 dispatch frontier sequences the waves and
  // the next-wave-on-drain promotion this 30s poll did is redundant. The
  // newly-filed-work backstop is the orchestrator tick (`runOrchestratorTick`),
  // and the stuck-wave signal is now raised by the frontier (computeFrontier's
  // `stuck` → an I-STUCK issue in dispatchOneHarness). The sweep module is kept
  // (not deleted) for the revert; it is simply no longer started.
  //   try { ensureWaveAdvanceSweep(); } catch { … }   // ← retired

  // Claude OAuth credential sync — keeps the claudeAiOauth bundle converged
  // across ~/.claude and every per-session CLAUDE_CONFIG_DIR fork so rotating
  // refresh tokens never mutually invalidate (the every-terminal-relogin
  // cascade, claude-credential-sync-2026-06-10). Flag is consulted per pass.
  //
  // EI-3385: PRIMARY-ONLY (cluster.isPrimary). It watches per-session .claude config
  // files (an inotify watcher; its UNCAUGHT ENOSPC was the fatal crash at 32 workers).
  // One converger per host keeps the creds converged for everyone; request workers don't
  // each need their own watcher. (See the harness-fs-watcher note above for why the gate
  // is cluster.isPrimary rather than backgroundWorkersEnabled().)
  if (cluster.isPrimary) {
    try {
      startClaudeCredentialSync({
        isEnabled: () => getFlag(FLAGS.CLAUDE_CRED_SYNC, 'operator-host'),
      });
    } catch (e) {
      console.warn('[claude-cred-sync] failed to start:', (e as Error)?.message ?? e);
    }
  }

  // TTL-based row expiry. Replaces ad-hoc lazy-deletes scattered across
  // operator-scan-lock, operator-claims, harness_status stalled-detection,
  // auth.magic_links, auth.sessions. One sweep loop, registered tables.
  try {
    registerAllExpirables();
  } catch (e) {
    console.warn('[api] expirable-registry failed to start:', (e as Error)?.message ?? e);
  }

  // Opt-in dev-mode hot-reload — watches ~/.papercusp/global-plugins/ and
  // resets the in-process runtime cache whenever a manifest or entry file
  // changes. Production hosts should leave this off (default).
  if (process.env.PAPERCUSP_DEV_PLUGIN_WATCH === '1') {
    // Lazy import so the watcher's fs.watch handle isn't held in tests
    // that don't import this module's bootstrap code.
    import('@papercusp/operator-core/lib/plugin-host-runtime')
      .then(({ watchPluginsForReload }) => watchPluginsForReload())
      .catch((e) => console.warn('[plugin-host-watch] failed to arm:', e));
  }

  // P-004 of desktop-app-install-integration-2026-05-23.
  // When the sidecar is running inside Papercusp.app (Tauri exports
  // PAPERCUSP_DESKTOP=1), self-install the engineer-collaborator
  // files into ~/.papercusp/ on boot. Mirrors what
  // install-standalone-mcp.sh does for dev — best-effort, logs on
  // failure, idempotent on token + agent_id (per a03fb875).
  //
  // Plain dev (`npm run dev` without Tauri) leaves PAPERCUSP_DESKTOP
  // unset, so dev users still use the shell script explicitly per the
  // unchanged dev workflow.
  if (process.env.PAPERCUSP_DESKTOP === '1') {
    import('@papercusp/operator-core/lib/desktop-install/papercusp-files')
      .then(({ installPapercuspFiles }) => installPapercuspFiles())
      .then(async (r) => {
        const minted = [
          r.minted.token ? 'token' : null,
          r.minted.agentId ? 'agent-id' : null,
        ]
          .filter(Boolean)
          .join('+') || 'reused';
        console.log(
          `[desktop-install] papercusp-files ok (${minted}; playbook=${r.playbookWritten} ext=${r.extensionWritten})`,
        );
        // Register the user-level `papercusp-su` MCP into ~/.claude.json so a
        // desktop `psu → claude` session actually has its tools. Nothing else in
        // the cross-platform desktop boot did this (the omp/claude MCP merge sat
        // only in the Linux-only ensureOmpSuInstalled), which is why a mac user
        // hit "MCP tools aren't up". Reads the token + agent-id installPapercuspFiles
        // just minted; the env-interpolated url self-heals across the dynamic
        // operator port (psu exports PAPERCUSP_OPERATOR_URL). Best-effort, no-ops
        // cleanly when claude was never launched (~/.claude.json absent).
        try {
          const { installClaudeIntegration } = await import(
            '@papercusp/operator-core/lib/desktop-install/claude-integration'
          );
          // seedIfAbsent (WI-3091): on a DESKTOP clean install, CREATE a minimal
          // ~/.claude.json carrying papercusp-su when claude has never run, so the
          // first psu→claude session already has its MCP tools (the boot reconcile
          // otherwise no-ops because the file is still absent, then claude creates
          // it empty inside the session → zero tools, never self-heals).
          const c = await installClaudeIntegration({ seedIfAbsent: true });
          if (c.changed) console.log('[desktop-install] claude MCP ok (registered papercusp-su in ~/.claude.json)');
          else if (c.reason) console.log(`[desktop-install] claude MCP skipped (${c.reason})`);
        } catch (e) {
          console.warn('[desktop-install] claude MCP registration failed:', (e as Error)?.message ?? e);
        }
      })
      .catch((e) => {
        console.warn('[desktop-install] papercusp-files failed:', (e as Error)?.message ?? e);
      });
  }

  // Model B sync substrate boot. Always runs (the
  // PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE opt-in gate was removed in Stage 4d —
  // the per-peer-log substrate is now the default). Awaits the dogfood schema
  // + boot-gate, then boots every harness in the active workspace. Failures
  // roll up but don't block the host (each harness boot is independently
  // defensive — a swarm/identity failure leaves it local-only).
  // [EI-126] Secondary/test hosts (e.g. the staging operator on :3170) must NOT
  // run the shared-DB background machinery — federation projections + outbox
  // drains (hyperbee substrate), git-export drains, and DBOS scheduled workflows.
  // Two hosts doing this against one papercusp DB caused a DBOS appVersion war,
  // doubled drain loops, and a plan-content federation echo that rewrote single
  // plans ~100k times (a 102 GB substrate_outbox, 2026-06-08). Default ON; the
  // staging systemd unit sets PAPERCUSP_BACKGROUND_WORKERS=0 to be request-only.
  // The release operator (:3070) + the desktop have no override → stay ON.
  //
  // Activation without a unit edit: the explicit flag wins when set; otherwise
  // default ON everywhere EXCEPT the dev-box staging operator, which already sets
  // PAPERCUSP_HONO_PORT=3170 and is request-only by design (the release operator
  // on :3070 owns the shared-DB background machinery). Production ships the
  // desktop app with no :3170, so this branch defaults ON there — correct.
  // EI-312 leg 1: the rule moved to the ONE shared evaluation so the
  // module-scope boot effects in agent-tools/index.ts gate on the same thing.
  const backgroundWorkers = backgroundWorkersEnabled();
  if (!backgroundWorkers) {
    console.log(
      '[host] PAPERCUSP_BACKGROUND_WORKERS=0 — secondary host: skipping hyperbee substrate, git-export, and DBOS background machinery (EI-126)',
    );
  }

  // P-003 / D-006: the operator owns local voice.  Reconcile the old per-user VoiceMode units
  // once per host (not once per clustered request worker) before background machinery starts.
  // Whisper's historical unit points at a deleted script and otherwise burns a systemd restart
  // loop; runtime-masking it makes the repair survive an old default.target symlink.  Kokoro is
  // retained as a compatibility accelerator and is independently checked by the service
  // contract/live stack guard.  Non-Linux hosts return an explicit unsupported result, and a
  // systemctl failure is logged but never wedges operator boot.
  if (backgroundWorkers && cluster.isPrimary && !utilityHost) {
    void reconcileLegacyVoiceServices({ maskWhisper: true })
      .then((result) => {
        console.log(
          `[voice-node] legacy service reconciliation: whisper=${result.whisper.action} kokoro=${result.kokoro.action}`,
        );
        if (!result.whisper.ok) console.warn(`[voice-node] legacy Whisper reconciliation degraded: ${result.whisper.detail ?? 'unknown error'}`);
      })
      .catch((err) => {
        console.warn('[voice-node] legacy service reconciliation failed (non-fatal):', err instanceof Error ? err.message : String(err));
      });
  }

  // WI-2105: this host WILL decide substrate routing (bootSubstrateWithFallback
  // below — but only after migrations + boot-gate, a multi-second window in
  // which DBOS routines already tick). Arm the routing latch NOW so an early
  // bootSingleHarness WAITS for the decision instead of silently booting a
  // duplicate in-process engine beside the sidecar (the 2026-07-03 bg-host
  // tower↔VM outage: alreadyBooted=1 = the raced in-process engine). Import
  // ordering makes this safe without await: any bootSingleHarness caller must
  // resolve the same boot-all module first, and this .then was registered first.
  if (backgroundWorkers && !utilityHost) {
    void import('@papercusp/operator-core/lib/sync/hyperbee/boot-all')
      .then(({ markSubstrateBootRoutingPending }) => markSubstrateBootRoutingPending())
      .catch((e) =>
        console.warn(
          '[substrate-boot] failed to arm routing latch (non-fatal):',
          e instanceof Error ? e.message : e,
        ),
      );
  }

  // [infra-perf-reliability-audit-round4 P-014] Boot the event-loop-lag gauge on the
  // BACKGROUND primary too. The request plane (startRequestServers) boots it on every
  // HTTP worker, but in cluster mode the bg-host primary serves no HTTP — so it ran the
  // heavy DBOS/derive loop with NO lag monitor, leaving the perf-regression rig's
  // loop_lag_p95 perpetually null on the very process whose saturation matters most
  // (the "no event-loop-lag monitor on this thread" watchdog note that blocked Lane E
  // verification). Idempotent: in single-process mode startRequestServers' call returns
  // this one. Request-only workers (BACKGROUND_WORKERS=0) skip here and still get it via
  // the request plane. Profiler-on-saturation matches the request plane (PAPERCUSP_LOOP_
  // PROFILER=0 disables). Best-effort — a monitor failure must never wedge boot.
  if (backgroundWorkers) {
    try {
      startEventLoopLagMonitor({
        // WI-3797 (2026-07-10): this was reverted to explicit opt-in after a native
        // Napi::Error crash-loop under sustained lag. WI-5820 (2026-07-25) re-enables
        // it behind two guards — the monitor's profileMaxP95Ms safety cap (the
        // crash regime is now unreachable) and a runtime-flippable FLAGS gate read
        // lazily per saturated window. Full rationale + the measurements that sized
        // the cap are in the matching comment in hono-host.ts.
        // bg-host is the host this attribution is FOR: it is the one carrying the
        // chronic ~230/h stall band that WI-5471 deferred and WI-323/WI-344 were
        // dropped still waiting on.
        profileOnSaturation: () => getFlag(FLAGS.LOOP_STALL_PROFILER, 'operator-host'),
        // P-002 (bg-host-freeze-eventloop-stall-2026-06-30) was ON by default so the
        // 3.3->46 GB RSS leak self-captured a .heapsnapshot at high RSS without manual
        // operator access. That leak was ROOT-CAUSED + FIXED 2026-07-01 (claude-sessions.ts
        // fs-sweep churn; ~52x allocation-rate drop, RSS now sawtooths 2-9GB instead of
        // climbing unbounded) — so a FULL heap snapshot now fires routinely on ordinary
        // steady-state RSS, not just a genuine leak event. WI-3255 (event-loop stalls):
        // a full snapshot PAUSES the loop for its whole serialization (~30% loop-time on a
        // 9GB heap observed live) — on a healthy host this diagnostic is now COSTING more
        // loop time than it's worth, and it was itself inflating the very stalls under
        // investigation (feeding the red-queen MTTSH regression, EI-7947). Default OFF;
        // opt back in with PAPERCUSP_HEAP_SNAPSHOT=1 if a genuine new leak needs hunting.
        heapSnapshotOnHighRss: process.env.PAPERCUSP_HEAP_SNAPSHOT === '1',
        // The SAMPLING profiler (heapSamplingOnHighRss) is the safe alternative: O(1)
        // overhead, arms once at boot, dumps a few-KB .heapprofile INSTANTLY on the same
        // RSS trigger with top allocation sites — no loop pause. Keep it always on
        // regardless of the full-snapshot default above (previously it silently inherited
        // heapSnapshotOnHighRss's value, so disabling the snapshot would have also blinded
        // this free, non-blocking signal).
        heapSamplingOnHighRss: true,
      });
    } catch (e) {
      console.warn('[event-loop-lag] bg-primary monitor start failed (non-fatal):', e instanceof Error ? e.message : e);
    }
  }

  // Auth-config flag subscription warm (WI-6650 residual, 2026-09-29). The module now
  // arms its flag subscription on first READ instead of at import (so a partial
  // flags/server mock can still collect any test that reaches it), but its unpopulated
  // state is the PERMISSIVE one for the testing-full-access kill-switch. Every host —
  // utility hosts included, since any MCP dispatch reaches the gate-bypass resolver —
  // therefore subscribes at boot, exactly as the module-scope form used to. Dynamic,
  // like the warms below, so it does not widen this module's static import graph.
  void import('@papercusp/operator-core/lib/auth-config-overrides')
    .then(({ armAuthConfigRefresh }) => armAuthConfigRefresh())
    .catch((e) =>
      console.warn('[auth-config] boot flag-subscription warm failed (non-fatal):', e instanceof Error ? e.message : e),
    );

  // Best-effort memory warm-up (memory-backend-improve-and-hybrid P-004a; hoisted
  // EI-12962): fire one throwaway memory search so the user's first chat turn
  // doesn't pay the mem0-client + embedder cold-start (~4-5s measured live).
  // This MUST NOT live inside the backgroundWorkers block below — the DESKTOP
  // SIDECAR (the process that actually serves the owner's chat) runs with
  // PAPERCUSP_BACKGROUND_WORKERS=0, so the warmup silently never ran there and
  // every app launch served a cold first chat turn. Process-local warming is a
  // duty of ANY chat-serving host; only a utility host (EI-368: onnxruntime is
  // in the Napi-abort suspect set) skips it. Detached (never awaited); an
  // import failure is LOGGED, not swallowed — a silent no-op here cost weeks.
  if (!utilityHost) {
    void import('@papercusp/operator-core/lib/memory/warm')
      .then(({ warmMemoryEmbedder }) => warmMemoryEmbedder())
      .catch((e) =>
        console.warn('[memory-warm] boot warm-up import failed (non-fatal):', e instanceof Error ? e.message : e),
      );
  }

  if (backgroundWorkers)
    void (async () => {
    try {
      // [A1 handoff-coordination-dx-followups] Apply pending sql/*.sql to the
      // operator DB on boot. Embedded-pg applies them when ITS server boots, but
      // the native :5432 dev box has no such runner — so without this, a
      // migration added since the last restart stays unapplied (the silent
      // "missing column" gap). The helper reports failures instead of throwing
      // so the request plane can still come up, but the background plane MUST
      // fail closed below: running schema-dependent routines against an older
      // schema turns one pending migration into a fleet-wide retry storm.
      // Awaited here so migrations are in place BEFORE the boot-gate flips +
      // the substrate (which reads those tables) starts.
      const { applyPendingMigrationsAtBoot, applyPendingMigrationsNow } = await import(
        '@papercusp/operator-core/lib/db-boot-migrate'
      );
      const { awaitBootMigrationGate, raiseBootMigrationGateAlarm, clearBootMigrationGateAlarm } = await import(
        '@papercusp/operator-core/lib/boot-migration-gate'
      );
      const { hostIdentity } = await import('@papercusp/operator-core/lib/serving-host-identity');
      const gateHost = `${utilityHost ? 'utility' : 'bg'}-host:${hostIdentity()}`;
      // WI-10002822: the gate used to be one-shot — a failed apply withheld the
      // background plane (and with it every pot's P2P replication) until a human
      // restarted this host, even after the migration was applied out of band.
      // awaitBootMigrationGate re-checks on a bounded tick, pages once when the
      // plane stays withheld, and RETURNS once the gate passes, so everything
      // below — the substrate boot included — starts in place with no restart.
      await awaitBootMigrationGate({
        applyAtBoot: applyPendingMigrationsAtBoot,
        // Never re-call applyPendingMigrationsAtBoot: its once-per-process guard
        // returns null forever, which reads as "state could not be determined".
        applyRetry: () => applyPendingMigrationsNow({ broadcast: false }),
        onWithheld: async (failureSummary) => {
          // WI-2144760: resolve the substrate-routing latch explicitly when the
          // migration gate fails. Without this, an early standalone
          // bootSingleHarness waits the full 300s latch timeout and then falls
          // back to an in-process engine before bootSubstrateWithFallback can
          // install WI-3297's durable PG merge-cursor factory (and can race a
          // sidecar). The latch clears again when the gate recovers and
          // bootSubstrateWithFallback → setSubstrateBootDefaults runs below.
          try {
            const { markSubstrateBootRoutingFailed } = await import(
              '@papercusp/operator-core/lib/sync/hyperbee/boot-all'
            );
            markSubstrateBootRoutingFailed(`migration gate failed: ${failureSummary}`);
          } catch (e) {
            // The migration failure is already being surfaced. Keep this
            // secondary routing notification best-effort so a module-load issue
            // cannot turn the request-plane fail-soft boot into an unhandled
            // rejection.
            console.warn(
              '[boot-migrate] failed to publish substrate routing failure (non-fatal):',
              e instanceof Error ? e.message : e,
            );
          }
        },
        raiseAlarm: (alarm) => raiseBootMigrationGateAlarm(alarm, gateHost),
        clearAlarm: (alarm) => clearBootMigrationGateAlarm(alarm, gateHost),
      });
      // WI-5441/WI-5764 (public-release boot-window federation-capture-hole
      // guard): flip the request-serving gate the INSTANT migrations are
      // applied — i.e. the instant every table's substrate_outbox capture
      // trigger is guaranteed live — deliberately BEFORE the rest of this IIFE
      // (system-principals healing, bench reapers, the substrate boot itself
      // below) runs. hono-host.ts's onWorker awaits this (via
      // waitForBootMigrationGate) before calling startRequestServers(), so no
      // HTTP write can land on a table whose capture trigger a still-applying
      // migration set hasn't created yet (su-72ce40f2's WI-5441 diagnosis,
      // WI-5441 post 53143: startRequestServers() previously ran unconditionally
      // right after this whole substrate-boot IIFE was fired-and-forgotten, with
      // no ordering guarantee against a slow/large migration run). This point
      // is reachable only after a conclusive, failure-free migration result;
      // an unknown/failed result returned above before any background machinery
      // could start.
      try {
        const { markMigrationsAppliedForRequestGate } = await import(
          '@papercusp/operator-core/lib/sync/hyperbee/boot-gate'
        );
        markMigrationsAppliedForRequestGate();
      } catch (e) {
        console.warn(
          '[boot-migrate] failed to flip the request-serving migrations gate (non-fatal — request server proceeds on its own timeout):',
          e instanceof Error ? e.message : e,
        );
      }

      // [WI-10000287] Install the control-anchor kernel resolver BEFORE any background
      // machinery starts. This used to arrive as a side effect of the host handler's
      // import graph (_mcp-host.ts -> agent-tools/index -> events/index.ts), but that
      // edge was never eager: `_mcp-handler` reaches `_mcp-host` only through
      // `await import()`, and no production module imports `_mcp-host` statically, so
      // the install actually landed on the first MCP request. A requestless primary —
      // one that only runs routines — therefore started them with no live resolver.
      // Install it here, on the path that actually starts routines.
      // Do NOT "fix" this by re-adding the eager `agent-tools/index` import to
      // _mcp-host.ts: it would install nothing earlier (that module is still only
      // reached lazily) and would reintroduce the one-shot-process hang removed in
      // e78276c435e3. installControlAnchorKernelResolver() is a pure resolver
      // assignment — no listeners, no timers — and is idempotent with events/index.ts,
      // which keeps installing it for the lazy request/registration path.
      try {
        const { installControlAnchorKernelResolver } = await import(
          '@papercusp/operator-core/lib/projected-tool-deps'
        );
        installControlAnchorKernelResolver();
      } catch (e) {
        console.warn(
          '[kernel-resolver] FAILED to install the control-anchor kernel resolver before routines started — capability-envelope enforcement falls back to the default resolver until this host restarts:',
          e instanceof Error ? e.message : e,
        );
      }

      // [EI-2048] Self-heal system-principal capability drift on boot. A cap added in
      // code (e.g. operator's memory + locks grant) reaches an ALREADY-provisioned row
      // only via a forceless provision — which used to be a no-op (so the live row stayed
      // stale until someone manually re-POSTed /api/agent-mcp/provision) and whose only
      // alternative (`force`) ROTATES the bearer and breaks live connections.
      // provisionSystemPrincipals now reconciles caps ADDITIVELY in place (no rotation;
      // see provisioning.ts), so calling it forceless per workspace here brings every
      // operator/oracle row up to the code-defined cap set on each deploy — no token
      // churn, no manual step. Runs only on a background-workers host (primary), after
      // migrations (DB ready). Best-effort: a failure logs and never wedges boot.
      try {
        const { provisionSystemPrincipals } = await import('@papercusp/operator-core/lib/ensure-system-principals');
        const { readRegistry } = await import('@papercusp/operator-core/lib/workspace-registry');
        const { papercuspRoot } = await import('@papercusp/operator-core/lib/papercusp-root');
        const root = papercuspRoot();
        let healed = 0;
        for (const ws of readRegistry().workspaces) {
          const ensured = await provisionSystemPrincipals({ workspaceId: ws.id, papercuspRoot: root });
          healed += ensured.filter((e) => e.reconciled || e.rotated).length;
        }
        if (healed > 0) console.warn(`[system-principals] boot reconcile updated ${healed} principal cap set(s) (EI-2048)`);
      } catch (e) {
        console.warn('[system-principals] boot reconcile failed (non-fatal):', e instanceof Error ? e.message : e);
      }

      // [B-TOK-ROLL token-tracking] Refresh the model_pricing projection (migration
      // 334) from the canonical in-code MODEL_PRICES, right after migrations create
      // the table. The DB table is a derived snapshot for SQL-side $-transparency;
      // this UPSERT keeps it from drifting when MODEL_PRICES changes. Best-effort —
      // the helper swallows its own errors and never wedges boot.
      try {
        const { syncModelPricingFromCode } = await import(
          '@papercusp/operator-core/lib/harness-insights/model-pricing-sync'
        );
        await syncModelPricingFromCode();
      } catch (e) {
        console.warn('[model-pricing-sync] boot sync failed (non-fatal):', e instanceof Error ? e.message : e);
      }

      // [benchmark-evaluation-ui P-005 / D-022] Spend-safety reaper — AWAITED here,
      // right after migrations and BEFORE the boot-gate flips (so it runs before
      // the routines engine could re-arm an orphan's wake/git-sync). A UI-launched
      // bench run in flight when a host CRASHED (SIGKILL bypasses its teardown
      // finally) leaves an orphan hive whose routines would re-spin opus on this
      // restart. Reap any run whose liveness heartbeat is stale (>180s): dissolve
      // its hive (clears the Queen wake + DELETES the gym/scout learning-loop rows
      // + drops the schema) and freeze its status. Heartbeat-gated so a run
      // legitimately in flight in another LIVE host is untouched. The no-orphan
      // case (the norm) is a single fast SELECT → ~0 boot cost. try/catch so a
      // failure never wedges boot (the next restart retries).
      try {
        const { reapStaleBenchRuns } = await import('@papercusp/operator-core/lib/external-bench/run-launcher');
        const { reaped } = await reapStaleBenchRuns();
        if (reaped.length > 0) {
          console.warn(`[bench-reaper] reaped ${reaped.length} stale bench run(s): ${reaped.join(', ')}`);
        }
      } catch (e) {
        console.warn('[bench-reaper] boot reap failed (non-fatal):', e instanceof Error ? e.message : e);
      }

      // Backfill the preserved file-dir benchmark runs (~/.papercusp/bench-results/<id>/) into the
      // operational store so the Evaluation UI's Compare view has runs to render. Idempotent
      // (upsert by run id), cheap (a handful of dirs), and the ONLY thing that populates bench_runs
      // for imported/reference runs — without it the store stays empty and Compare shows nothing.
      // try/catch so a malformed run dir never wedges boot.
      try {
        const { importAllPreservedRuns } = await import('@papercusp/operator-core/lib/external-bench/run-store');
        const { imported, skipped } = await importAllPreservedRuns();
        if (imported.length > 0) {
          console.warn(`[bench-import] imported ${imported.length} preserved run(s): ${imported.join(', ')}${skipped.length ? ` (skipped ${skipped.length})` : ''}`);
        }
      } catch (e) {
        console.warn('[bench-import] boot import failed (non-fatal):', e instanceof Error ? e.message : e);
      }

      // EI-368: a headless utility host (gym-operator) wants the migrations
      // above but neither the embedder warm-up (onnxruntime) nor the dogfood
      // substrate (holepunch natives) — both are in the Napi-abort suspect set
      // and neither serves a short-lived dedicated instance.
      if (utilityHost) return;

      // The dogfood PG schema + change-notify/capture triggers are defined
      // entirely by migrations (000-baseline + 107/108), now applied above (or
      // by the embedded-pg boot) — no runtime schema-ensure here. Flip the
      // boot-gate so the substrate can start.
      const { markSqlMigrationsComplete, markRuntimeEnsureComplete } =
        await import('@papercusp/operator-core/lib/sync/hyperbee/boot-gate');
      markSqlMigrationsComplete();
      markRuntimeEnsureComplete();
      const { bootSubstrateWithFallback } = await import(
        '@papercusp/operator-core/lib/sync/hyperbee/substrate-boot-wrapper'
      );
      const t0 = Date.now();
      // WI-3684: no explicit perHarnessTimeoutMs here — an explicit value
      // short-circuits bootSingleHarness's PAPERCUSP_SUBSTRATE_BOOT_TIMEOUT_MS
      // env read (WI-1892's operator knob), which is set precisely for THIS
      // boot-storm path. The hardcoded 30_000 this replaces meant the 180s
      // drop-in never took effect and every loaded boot mass-timed-out at 30s.
      const result = await bootSubstrateWithFallback({});
      console.log(
        `[hyperbee-substrate] boot complete in ${Date.now() - t0}ms — attempted=${result.attempted} booted=${result.booted} alreadyBooted=${result.alreadyBooted} failed=${result.failed} deferred=${result.deferred}`,
      );
      if (result.failed > 0) {
        for (const r of result.results) {
          if (r.state === 'failed') {
            console.warn(
              `[hyperbee-substrate] (${r.workspaceId}::${r.harnessSlug}) failed: ${r.error}`,
            );
          }
        }
      }
    } catch (err) {
      console.warn(
        '[hyperbee-substrate] boot failed (non-fatal):',
        err instanceof Error ? err.message : err,
      );
    }
  })();

  // Spawner sidecar warm-up (WI-344 ③, plan spawner-sidecar-offload-2026-06-30 P-006).
  // When the per-host PAPERCUSP_SPAWNER_SIDECAR opt-in is set, pre-spawn the
  // agent-spawn sidecar at boot — beside the substrate boot above — so the FIRST
  // real bee/queen spawn doesn't pay the fork+handshake, and the buildInvokeOnce +
  // child_process.spawn CPU (the ~24.5% main-loop load that freezes routinesTick)
  // leaves the bg-host main event loop from the very first spawn. The lazy path in
  // spawnInvokeOnceWithFallback still spawns-on-demand, so this is a warm-up, not a
  // hard dependency. Gated on backgroundWorkers (this IS the spawn host) + the env
  // opt-in, so an operator without the flag never starts an unused sidecar; skipped
  // on a short-lived utility host (EI-368) like the substrate boot above. Detached +
  // fully guarded — a warm-up failure can never wedge boot (lazy fallback covers it).
  if (
    backgroundWorkers &&
    !utilityHost &&
    // WI-3793: shared, defensively-guarded enable-check (also never fires
    // from inside the sidecar's own re-exec'd child — see
    // isSidecarEnabledFromEnv in sidecar-spawn-shared.ts) instead of a bare
    // inline env read; behavior here is unchanged (backgroundWorkers is
    // already false in the sidecar child today), it just closes the latent
    // gap for any future caller of this same condition.
    isSidecarEnabledFromEnv({
      enableVar: 'PAPERCUSP_SPAWNER_SIDECAR',
      modeVar: 'PAPERCUSP_SPAWNER_SIDECAR_MODE',
    })
  ) {
    void (async () => {
      try {
        const { spawnSpawnerSidecar, registerSpawnerSidecarShutdownHooks } =
          await import('@papercusp/operator-core/lib/fleet/spawner-sidecar-spawn');
        const t0 = Date.now();
        await spawnSpawnerSidecar();
        registerSpawnerSidecarShutdownHooks();
        console.log(
          `[spawner-sidecar] warm boot complete in ${Date.now() - t0}ms`,
        );
      } catch (err) {
        console.warn(
          '[spawner-sidecar] warm boot failed (non-fatal; lazy fallback covers it):',
          err instanceof Error ? err.message : err,
        );
      }
    })();
  }

  // Inference-gateway sidecar supervision (cross-platform-hardening P-006).
  // On Linux dev boxes the gateway runs under a `papercup-inference-gateway`
  // systemd --user unit (Restart=always) — but macOS/Windows desktops have no
  // systemd, so a packaged app had NO gateway and NO supervisor there. This
  // block makes the bg-host the cross-platform supervisor: port-probe-first
  // (ADOPTS an externally-managed gateway — e.g. the systemd unit — instead of
  // double-spawning), spawn + respawn-with-backoff otherwise
  // (gateway-sidecar-spawn.ts, same machinery as the substrate/spawner
  // sidecars). Default ON where backgroundWorkers run; kill-switch
  // PAPERCUSP_GATEWAY_SUPERVISE=0. Deliberately env-gated, NOT getFlag():
  // flags resolve false when PostHog is unreachable at boot (the L935
  // stall-waker lesson) and the gateway must come up unconditionally.
  // Fully guarded — a supervision failure can never wedge boot.
  if (
    backgroundWorkers &&
    !utilityHost &&
    process.env.PAPERCUSP_GATEWAY_SUPERVISE !== '0'
  ) {
    void (async () => {
      try {
        const { ensureGatewaySidecar, registerGatewaySidecarShutdownHooks } =
          await import('@papercusp/operator-core/lib/inference-gateway/gateway-sidecar-spawn');
        const t0 = Date.now();
        const outcome = await ensureGatewaySidecar();
        registerGatewaySidecarShutdownHooks();
        console.log(
          `[gateway-sidecar] supervision up in ${Date.now() - t0}ms — ${outcome}`,
        );
      } catch (err) {
        console.warn(
          '[gateway-sidecar] supervision failed (non-fatal; agents fall back to direct/default credential paths):',
          err instanceof Error ? err.message : err,
        );
      }
    })();
  }

  // P-004 (capless adaptive resource governor): every long-lived operator
  // process publishes its process-local fragment, while the one background host
  // owns the cross-platform out-of-process sampler. The managed child keeps host
  // evidence moving when the operator loop wedges; the fragment going stale is
  // itself the progress signal. Default ON, with one emergency kill-switch.
  if (!utilityHost && process.env.PAPERCUSP_RESOURCE_GOVERNOR_MONITOR !== '0') {
    void import('@papercusp/operator-core/lib/resource-governor/live-health-publisher')
      .then(({ startProcessLiveHealthPublisher }) => startProcessLiveHealthPublisher())
      .catch((err) => {
        console.warn(
          '[resource-governor-health] process publisher failed to start (non-fatal; snapshot marks it unknown):',
          err instanceof Error ? err.message : err,
        );
      });
  }
  if (
    backgroundWorkers &&
    !utilityHost &&
    process.env.PAPERCUSP_RESOURCE_GOVERNOR_MONITOR !== '0'
  ) {
    void import('@papercusp/operator-core/lib/resource-governor/live-health-supervisor')
      .then(async ({ ensureLiveHealthMonitor }) => {
        const t0 = Date.now();
        await ensureLiveHealthMonitor();
        console.log(`[resource-governor-health] monitor ready in ${Date.now() - t0}ms`);
      })
      .catch((err) => {
        console.warn(
          '[resource-governor-health] monitor supervision failed (non-fatal; readers see unknown/stale):',
          err instanceof Error ? err.message : err,
        );
      });
  }

  // [harness-state P-003a] Registry coverage + peer-log drift guard (fail-loud,
  // non-fatal). Asserts every live harness_shared table is intentionally
  // classified by the two-axis registry (lib/harness-state/table-registry.ts)
  // and that the sync:'peer-log' set stays in lock-step with the hand-wired
  // Hyperbee projections. A new table that nobody classified, or a peer-log
  // table that lost its projection, logs loudly here.
  void (async () => {
    try {
      const { routeProjection, checkInventoryCoverage } = await import(
        '@papercusp/operator-core/lib/harness-state/projection-engine'
      );
      const { REGISTERED_PROJECTION_TAGS } = await import(
        '@papercusp/operator-core/lib/sync/hyperbee/projections/register-all'
      );
      const { getOrgPg } = await import('@papercusp/db-org');
      const { sql } = getOrgPg();
      const rows = (await sql`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'harness_shared'
      `) as Array<{ table_name: string }>;
      const live = rows.map((r) => r.table_name);
      // P-003c: the ONE router partitions every live table across the 3 adapters
      // and folds in the peer-log drift guard.
      const route = routeProjection(live, REGISTERED_PROJECTION_TAGS);
      if (!route.peerLogConsistency.ok) {
        console.error(
          `[harness-state] PEER-LOG DRIFT — missingProjection=[${route.peerLogConsistency.missingProjection.join(',')}] orphanTag=[${route.peerLogConsistency.orphanTag.join(',')}]`,
        );
      }
      const cov = checkInventoryCoverage(live);
      if (cov.unreviewed.length > 0) {
        console.error(
          `[harness-state] ${cov.unreviewed.length} UNCLASSIFIED table(s) — add to table-registry.ts: ${cov.unreviewed.join(', ')}`,
        );
      } else {
        console.log(
          `[harness-state] routing OK — ${cov.total} tables → git-export=${route.gitExport.length} peer-log=${route.peerLog.length} local=${route.local.length} (${cov.defaulted.length} default); peer-log drift=${route.peerLogConsistency.ok ? 'none' : 'DETECTED'}`,
        );
      }
    } catch (err) {
      console.warn(
        '[harness-state] coverage check failed (non-fatal):',
        err instanceof Error ? err.message : err,
      );
    }
  })();

  // [harness-state P-003b] Git-export boot — LIVE-VERIFIED (2026-06-02: 15
  // harnesses / 16 git tables / 15 drain loops). Per workspace's harnesses:
  // ensure the git_export_outbox + reconcile capture triggers on the sync:'git'
  // tables (attach current set, DROP stale ones for tables removed from
  // GIT_TABLES), hydrate each from `.papercusp/state/` (clone-and-go), then start
  // its autonomous PG→file drain loop. Non-fatal: a failure leaves harnesses on
  // their existing PG-only behaviour (git-export simply doesn't run). The drain's
  // auto-commit (git-committer.ts) is real + scoped to `.papercusp/state` only and
  // never pushes, but FLAG-GATED OFF by default (PAPERCUSP_GIT_EXPORT_COMMIT=1 to
  // enable); until then the files are written + visible but left uncommitted.
  if (backgroundWorkers)
    void (async () => {
    try {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { readRegistry } = await import('@papercusp/operator-core/lib/workspace-registry');
      const { loadHarnessRegistry } = await import('@papercusp/operator-core/lib/harness-registry');
      const { bootGitExportForHarnesses } = await import('@papercusp/operator-core/lib/harness-state/git-export/boot');
      const { sql } = getOrgPg();
      const harnesses: { workspaceId: string; harnessSlug: string; harnessRoot: string }[] = [];
      for (const ws of readRegistry().workspaces) {
        const reg = await loadHarnessRegistry(ws.id);
        for (const p of reg.projects) {
          harnesses.push({ workspaceId: ws.id, harnessSlug: p.slug, harnessRoot: p.path });
        }
      }
      const res = await bootGitExportForHarnesses(sql, harnesses);
      console.log(
        `[git-export] boot: ${res.harnesses} harness(es), ${res.globals.attached.length} git table(s), ` +
          `${res.handles.length} drain loop(s)` +
          (res.globals.detached.length ? `, detached ${res.globals.detached.length} stale: ${res.globals.detached.join(',')}` : ''),
      );
    } catch (err) {
      console.warn(
        '[git-export] boot failed (non-fatal, draft):',
        err instanceof Error ? err.message : err,
      );
    }
  })();

  // gateway-rate-limit-stall-autowake (2026-06-23 fix): the stall-waker re-wakes a rate-limit-stalled session
  // when its account recovers, but it was started ONLY lazily from the bee-spawn path (operator-spawn:1056). So
  // if the operator restarts and no bee spawns (a quiet / capacity-throttled fleet), the loop never runs and
  // recorded stalls — including su/psu sessions, now role-agnostic — pile up UNPROCESSED → no auto-wake (the
  // su-3650b incident: 95 stalls, oldest 34 min, never woken). Start it on BOOT too, per workspace.
  // NO FLAG-GATE (2026-06-23): gating on getFlag(INFERENCE_GATEWAY) was FRAGILE — it resolved false in the host
  // context (PostHog distinct-id / unreachable → code default false), so the boot-start no-op'd and the backlog
  // never drained. The waker just polls the gateway's /admin/stalls and no-ops if it's unreachable, so it is
  // harmless to always run (lightweight + unref'd). ensureStallWakerLoop is idempotent (spawn-path call = no-op).
  if (backgroundWorkers)
    void (async () => {
      try {
        const { readRegistry } = await import('@papercusp/operator-core/lib/workspace-registry');
        const { ensureStallWakerLoop } = await import('@papercusp/operator-core/lib/inference-gateway/stall-waker-loop');
        // ONE process-global loop, NOT one per workspace (WI-3310 layer 2): ensureStallWakerLoop is a
        // module singleton, so the old `for (ws of wss) ensureStallWakerLoop(ws.id)` silently bound the
        // ONLY loop to the registry's first entry ('default') and no-op'd the other 16 — and a
        // 'default'-bound capacityBack couldn't find any real account (they live in other workspaces'
        // pools), so its unknown-account fallback waived the availability check and woke agents onto
        // usage-walled accounts. The loop's deps now resolve accounts across ALL registry workspaces
        // (findAccountRow), so one global loop is the CORRECT shape — /admin/stalls is global anyway.
        const wss = readRegistry().workspaces;
        const primary = wss[0]?.id ?? 'default';
        ensureStallWakerLoop(primary);
        console.log(`[stall-waker] boot-start: 1 global loop (home ws '${primary}'; account lookup spans all ${wss.length} workspace(s))`);
      } catch (e) {
        console.warn(`[stall-waker] boot-start failed (non-fatal): ${e instanceof Error ? e.message : e}`);
      }
    })();

  // External-triggers P-006: Slack Socket Mode is an outbound, process-local
  // lifecycle connection. Start it only in the background owner process; its
  // managed timer is visible through schedule:inventory and retries cold gaps
  // and disconnects without requiring public ingress.
  if (backgroundWorkers && cluster.isPrimary)
    void import('@papercusp/operator-core/lib/external-triggers/slack-socket-manager')
      .then(({ startSlackSocketManager }) => startSlackSocketManager())
      .catch((e) => {
        console.warn('[slack-socket] boot-start failed (non-fatal):', e instanceof Error ? e.message : e);
      });

  // DBOS Transact durable-jobs substrate (dbos-durable-jobs-2026-05-31).
  // Gated by BOTH backgroundWorkersEnabled() and PAPERCUSP_DBOS_ENABLE=1; both
  // are required before this process can register DBOS routines. The routines
  // flag checked inside dbosRoutinesActive() is only the inner workflow-selection
  // predicate after startDbos() is reached; it is not a host-registration gate.
  // PAPERCUSP_DBOS_ENABLE=1 is default OFF. Dynamic import so the host
  // doesn't require @dbos-inc/dbos-sdk when the flag is off. This is the LIVE
  // boot path (the Hono host) — the retired instrumentation-node.ts also has
  // this block, but startDbos() is globalThis-idempotent so a double-call is a
  // no-op. startDbos() itself conditionally loads the AutoLoop (PAPERCUSP_DBOS_AUTOLOOP)
  // and periodic-timer (PAPERCUSP_DBOS_TIMERS) workflows; the legacy setInterval
  // workers stand down via their own guards.
  if (backgroundWorkers && process.env.PAPERCUSP_DBOS_ENABLE === '1') {
    void (async () => {
      try {
        // A stale/partially refreshed bundle can otherwise fail only while DBOS imports
        // its routines graph, leaving the process alive with every scheduled routine dark.
        // Check the bundled module namespace before startDbos() so the existing boot-failure
        // attention + severe-event path reports the precise contract and rebuild action.
        if (isBundledSidecar()) {
          const workItems = await import('@papercusp/operator-core/lib/work-items');
          assertDbosWorkItemsImportContract(workItems);
          console.log('[dbos] bundled work-items import contract passed');
        }
        const { startDbos } = await import('@papercusp/operator-core/lib/dbos/bootstrap');
        await startDbos();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[dbos] boot failed (non-fatal):', msg);
        // WI-4015/WI-4023: this catch used to be silent beyond the console.warn above —
        // the process stays alive and LOOKS healthy while DBOS.launch() aborted partway
        // through registration, so routinesTick never arms and every routine (git-sync,
        // cross-hive-outbox-drain, scout-cycle, ...) goes dark with zero active paging.
        // The request-path infra-liveness/single-primary detectors DO catch this
        // (verified: both fired blocker-severity escalations within ~1-8min of the
        // 2026-07-10 20:38 incident) but only via `openEscalation` — a durable PG row,
        // never an active page — so it sat unnoticed for ~40min until a human-equivalent
        // manual notice. Fire a loud, NON-flag-gated page directly from the source of
        // the failure, immediately, best-effort (must never crash this boot path further).
        try {
          const { notifyAttention } = await import('@papercusp/operator-core/lib/attention-notify');
          await notifyAttention({
            kind: 'intervention',
            title: 'DBOS boot FAILED — routines dead, engine looks healthy',
            body: `startDbos() threw during boot and was swallowed (process stays up): ${msg}. Every DBOS-scheduled routine (routinesTick, git-sync, cross-hive-outbox-drain, scout-cycle, ...) is now dark until this is fixed and the process restarted. This is not a transient blip — nothing will self-heal.`,
            importance: 'urgent',
            data: { errorMessage: msg },
          });
        } catch (notifyErr) {
          console.warn('[dbos] boot-failure notifyAttention failed (non-fatal):', notifyErr instanceof Error ? notifyErr.message : notifyErr);
        }
        try {
          const { broadcastSevereEvent } = await import('@papercusp/operator-core/lib/severe-event-broadcast');
          await broadcastSevereEvent({
            summary: `[dbos] boot FAILED on this host — DBOS routine engine is dead (process alive, nothing scheduled)`,
            body: `startDbos() threw during boot: ${msg}. routinesTick never arms, so every DBOS-scheduled routine is dark (git-sync, cross-hive-outbox-drain, scout-cycle, ...) until fixed + restarted. Check this host's boot log for the root cause (a prior instance: duplicate module-top-level DBOS registration under a tsx-direct entrypoint, WI-4015).`,
            category: 'severe-event',
            conditionKey: 'dbos-boot-failed',
          });
        } catch (broadcastErr) {
          console.warn('[dbos] boot-failure broadcast failed (non-fatal):', broadcastErr instanceof Error ? broadcastErr.message : broadcastErr);
        }
      }
    })();
  }

  // Red Queen engine-death sentinel (self-learning-frontier P-031 / FB-20): a
  // PLAIN interval, deliberately outside DBOS/routines, so it survives exactly
  // the failure it watches for — the swallowed '[dbos] boot failed' above left
  // every routine dead for 80+ min on 2026-06-12 with nothing detecting it.
  // Arm only where DBOS is SUPPOSED to launch. `backgroundWorkers` alone is too
  // broad: packaged desktop/test sidecars commonly set BACKGROUND_WORKERS=1 but
  // leave DBOS_ENABLE unset, so they do not own a routines engine. An 18h-old
  // acceptance tower in exactly that state emitted a false critical capture
  // every five minutes (EI-20416585496609835). dbosLaunchesHere() mirrors the
  // launch gate above while remaining true when startDbos() itself fails, which
  // preserves detection of the real swallowed-boot-error incident.
  // Inert while the papercusp-red-queen flag is OFF (checked every pass).
  if (dbosLaunchesHere()) {
    void (async () => {
      try {
        const { armEngineDeathSentinel } = await import('@papercusp/operator-core/lib/red-queen/engine-death');
        armEngineDeathSentinel();
      } catch (err) {
        console.warn('[red-queen-sentinel] arm failed (non-fatal):', err instanceof Error ? err.message : err);
      }
    })();
  }

  // EI-1622: lightweight in-process periodic checks — systemHealth,
  // harnessStatusSweep, connectionPressure, serviceHealth, completionRefVerify,
  // spawnReclaimSweep, staleClaimSweep, learningInfraHealth, steeringChurnSweep.
  // These ephemeral, idempotent probes were durable DBOS scheduled workflows that
  // each persisted a dbos.workflow_status row every 30–60s (~200k/day) → executor
  // starvation → routinesTick stall → Queen freeze. As plain unref'd intervals they
  // write ZERO workflow_status rows (the source fix). Skipped on a utility host
  // (gym-operator) just as the former dbosPeriodicTimersActive did.
  //
  // ⚠ CORRECTED 2026-08-02 (P-018, db-performance-remediation-2026-07-26). This comment
  // used to claim `backgroundWorkers` was what stopped "a naive interval running N×
  // across :3070 cluster request workers". IT NEVER DID: backgroundWorkersEnabled() reads
  // only env (PAPERCUSP_BACKGROUND_WORKERS / PAPERCUSP_HONO_PORT) and a forked cluster
  // worker INHERITS its parent's env, so it is true in every worker. Measured on the
  // 16-worker :3070 release cluster: ≥7 distinct worker pids each independently ran the
  // system-health tick's wide engineer_issues read within one 75s sample.
  // The N× guard now lives where the checks are (PeriodicCheck.scope, default 'host' =
  // cluster primary only), so it cannot be lost again by an edit here.
  //
  // ⚠ STILL N× IN WORKERS: `reconcileSpawnAdmissionOnBoot` below is NOT covered by that
  // fix — it runs once per worker at boot, and with SPAWN_RECLAIM_RELAUNCH on that means
  // concurrent relaunch attempts for the same reclaimed row. Filed separately rather than
  // folded into a perf change, because it is a double-spawn correctness risk in another
  // subsystem and needs its own verification. See EI (spawn-reclaim boot reconcile).
  //
  // EI-19303576975827285: PRIMARY-ONLY (cluster.isPrimary) for the reconcile itself, for
  // the same reason as the fs-watcher/harness-status-sweep/credential-sync guards above —
  // backgroundWorkersEnabled() cannot express "once per host" (a forked cluster worker
  // inherits its parent's env, so it reads true in every one of the 16 :3070 release
  // workers). Verified this reconcile's own SQL is safe against the concurrent-worker race
  // it ran under either way (UPDATE ... WHERE status IN ('running','restarting') ...
  // RETURNING is a compare-and-claim: only the worker whose UPDATE actually flips a given
  // row gets it back in RETURNING, so a row can never appear in more than one worker's
  // `rows`/relaunch loop — no double-spawn was actually possible). The gate here is still
  // correct to add: without it, all 17 workers redundantly ran the same candidate SELECT +
  // a no-op UPDATE attempt on every boot, with transient row-lock contention across them
  // for no benefit. `armInProcessPeriodicChecks()` / `armEphemeralExecutor()` below stay
  // OUTSIDE this gate — P-018 already made those safe to call in every worker via their
  // own internal PeriodicCheck.scope, so gating them here too would be a regression, not a
  // fix.
  if (backgroundWorkers && !utilityHost) {
    void (async () => {
      try {
        // EI-2186: BEFORE arming the periodic sweep, reconcile the spawn-admission
        // ceiling against reality. A host/process restart kills in-flight spawns
        // before their admission-release runs, leaving 'running' nursery rows that
        // jam `maxSimultaneousAgents` forever (the periodic reclaim can't clear them
        // — a stale launch row's reused pid reads as "alive" and its heartbeat is
        // bumped, so it never becomes a candidate). This boot reconcile frees every
        // same-host row owned by a dead prior incarnation (boot-id mismatch),
        // regardless of heartbeat freshness, then wakes any over-ceiling waiter.
        if (cluster.isPrimary) {
        try {
          const { getOrgPg } = await import('@papercusp/db-org');
          const { reconcileSpawnAdmissionOnBoot } = await import('@papercusp/operator-core/lib/fleet/spawn-reclaim');
          // EI-85 (restart-kills): re-launch a reclaimed queen/bee whose durable
          // work-item is still non-terminal, instead of just killing it — so the
          // hive survives ANY host restart. Flag-gated: OFF ⇒ no relaunch seam ⇒
          // legacy reclaim-to-`failed` (byte-identical). Resolve the flag with the
          // host id as the distinct id (a host-level routine, not a per-user gate).
          let relaunch:
            | (typeof import('@papercusp/operator-core/lib/fleet/spawn-relaunch'))['relaunchReclaimedSpawn']
            | undefined;
          try {
            const { hostname } = await import('node:os');
            if (await getFlag(FLAGS.SPAWN_RECLAIM_RELAUNCH, `host:${hostname()}`)) {
              ({ relaunchReclaimedSpawn: relaunch } = await import(
                '@papercusp/operator-core/lib/fleet/spawn-relaunch'
              ));
            }
          } catch (e) {
            console.warn(
              `[spawn-reclaim] relaunch seam unavailable (reclaim-only this boot): ${e instanceof Error ? e.message : e}`,
            );
          }
          const r = await reconcileSpawnAdmissionOnBoot(getOrgPg().sql, relaunch ? { relaunch } : {});
          if (r.reattached && r.reattached.length > 0) {
            // WI-1499: these survived the restart in their own systemd scope (own
            // cgroup, outside this host's) — RE-ATTACHED to this fresh incarnation
            // instead of reclaimed, so their turn just keeps running.
            console.warn(
              `[spawn-reclaim] boot reconcile RE-ATTACHED ${r.reattached.length} still-alive scope-isolated spawn(s) from a prior incarnation (WI-1499): ${r.reattached.join(', ')}`,
            );
          }
          if (r.relaunched && r.relaunched.length > 0) {
            console.warn(
              `[spawn-reclaim] boot reconcile RE-LAUNCHED ${r.relaunched.length} queen/bee(s) with non-terminal work after a host restart (EI-85): ${r.relaunched.join(', ')}`,
            );
          }
          if (r.reclaimed > 0) {
            console.warn(
              `[spawn-reclaim] boot reconcile freed ${r.reclaimed} stale admission debit(s) from a prior incarnation: ${r.spawnIds.join(', ')}`,
            );
            try {
              const { emitAwaitedEvent } = await import('@papercusp/operator-core/lib/events/await/engine');
              const { spawnSlotEventKey } = await import('@papercusp/operator-core/lib/fleet/operator-spawn');
              for (const ws of r.workspaces) {
                await emitAwaitedEvent({
                  key: spawnSlotEventKey(ws),
                  summary: `${r.reclaimed} stale spawn slot(s) freed by the boot reconcile (host restart)`,
                  source: 'spawn-boot-reconcile',
                  workspaceId: ws,
                }).catch(() => undefined);
              }
            } catch {
              /* best-effort — waiters fall back to their await timeout / the periodic sweep */
            }
          }
        } catch (err) {
          console.warn('[spawn-reclaim] boot reconcile failed (non-fatal):', err instanceof Error ? err.message : err);
        }
        }

        const {
          armInProcessPeriodicChecks,
          inProcessPeriodicEligibleChecks,
          inProcessPeriodicArmedNames,
          applyInProcessSweepArmState,
        } = await import('@papercusp/operator-core/lib/dbos/in-process-periodic');
        armInProcessPeriodicChecks();

        // EI-19294826146331487 — the sweeps armed above are DECLARED IN CODE, so until now the
        // Automation pane could list them but offered no switch. Their durable on/off state lives
        // in `harness_shared.routines` as `tier='in-process'` arm-state rows (migration 1046),
        // which nothing fires; this reconciler is what makes those rows mean something. It runs
        // AFTER the unconditional arm above on purpose — no database read is on the boot path, and
        // every failure inside it is fail-open (a sweep stays armed).
        if (!utilityHostEnabled()) {
          try {
            const { startInProcessSweepArmReconciler, productionSweepArmDeps } = await import(
              '@papercusp/operator-core/lib/dbos/in-process-sweep-arm'
            );
            startInProcessSweepArmReconciler(
              productionSweepArmDeps({
                eligible: inProcessPeriodicEligibleChecks,
                armed: inProcessPeriodicArmedNames,
                apply: applyInProcessSweepArmState,
              }),
            );
          } catch (err) {
            console.warn(
              '[in-process-sweep-arm] reconciler arm failed (non-fatal — every sweep stays armed):',
              err instanceof Error ? err.message : err,
            );
          }
        }

        // Ephemeral blueprint cadence tier (schedule-inventory-and-ephemeral-tier-2026-06-26 P-012 / D-006):
        // arm each ACTIVE ephemeral routine as an in-process managed timer. Single-owner: the same
        // backgroundWorkers gate as the sweeps above, AND never on a utility host (the request/util
        // tier owns no schedules). Non-fatal — a query/arm failure must not block boot.
        if (!utilityHostEnabled()) {
          try {
            const {
              armEphemeralExecutor,
              productionEphemeralExecutorDeps,
              startEphemeralRoutineInvalidationSync,
            } = await import(
              '@papercusp/operator-core/lib/dbos/ephemeral-executor'
            );
            await armEphemeralExecutor(productionEphemeralExecutorDeps());
            await startEphemeralRoutineInvalidationSync();
          } catch (err) {
            console.warn('[ephemeral-executor] arm failed (non-fatal):', err instanceof Error ? err.message : err);
          }
        }
      } catch (err) {
        console.warn('[in-process-periodic] arm failed (non-fatal):', err instanceof Error ? err.message : err);
      }
    })();
  }

  // NOTE: the in-process oddsmith-prospector bridge wiring that used to live here
  // (P-020) was REMOVED. As of harness-provided-cadence-ops-2026-06-26 (P-007 / D-001)
  // `oddsmith:prospect` is a HARNESS-PROVIDED dispatched op: the oddsmith-prospector
  // blueprint declares it, the operator registers a PROXY CoordOp on admission
  // (operator-core/lib/harness-ops/proxy.ts), and the proxy dispatches to the oddsmith
  // sidecar's /api/op/oddsmith:prospect handler — so the host no longer imports any
  // in-process bridge module. The old `import(...ops/oddsmith-prospect)` here failed on
  // every boot once that op file was deleted (WI-1087); the proxy path replaces it.
}
