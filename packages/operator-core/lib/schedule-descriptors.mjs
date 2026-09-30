/**
 * Writer-consumed schedule descriptors.
 *
 * Plain ESM is intentional: the TypeScript gateway and the bare-Node watchdog /
 * psu entrypoints import this same object. `schedule-inventory.ts` derives its
 * static rows from these descriptors; it never carries a second manifest.
 *
 * A descriptor is not merely documentation. Every writer named by `source`
 * consumes its key for the timer name, default cadence, or trigger identity.
 * The bidirectional recurrence test in schedule-inventory.test.ts enforces both
 * directions: descriptor -> writer and writer reference -> descriptor.
 */

const timer = (process, name, defaultIntervalMs, source, category, classification) =>
  Object.freeze({ process, name, defaultIntervalMs, source, category, classification });

export const EXTERNAL_SCHEDULES = Object.freeze({
  gatewayProactiveEgressProbe: timer(
    'inference-gateway',
    'inference-gateway:proactive-egress-probe',
    45_000,
    'packages/operator-core/lib/inference-gateway/gateway.ts',
    'health-probe',
    'must-sample',
  ),
  gatewaySelfHeal: timer(
    'inference-gateway',
    'gateway-self-heal',
    10_000,
    'packages/operator-core/lib/inference-gateway/gateway.ts',
    'watchdog',
    'timeout-reaper',
  ),
  gatewayTokenRefresh: timer(
    'inference-gateway',
    'gateway-token-refresh',
    45 * 60_000,
    'packages/operator-core/lib/inference-gateway/launch.ts',
    'cache',
    'timeout-reaper',
  ),
  gatewayPoolReload: timer(
    'inference-gateway',
    'gateway-pool-reload',
    60_000,
    'packages/operator-core/lib/inference-gateway/launch.ts',
    'cache',
    'violation',
  ),
  gatewayRateHintPinResync: timer(
    'inference-gateway',
    'gateway-ratehint-pin-resync',
    60_000,
    'packages/operator-core/lib/inference-gateway/launch.ts',
    'cache',
    'violation',
  ),
  gatewayLocalBackendRefresh: timer(
    'inference-gateway',
    'gateway-local-backend-refresh-health',
    30_000,
    'packages/operator-core/lib/inference-gateway/launch.ts',
    'health-probe',
    'must-sample',
  ),
  gatewayPayloadSpoolSweep: timer(
    'inference-gateway',
    'gateway-payload-spool-sweep',
    60_000,
    'packages/operator-core/lib/inference-gateway/launch.ts',
    'global-sweep',
    'timeout-reaper',
  ),
  gatewayWatchdogPoll: timer(
    'gateway-watchdog',
    'gateway-watchdog-poll',
    15_000,
    'packages/operator-core/lib/inference-gateway/watchdog.mjs',
    'watchdog',
    'must-sample',
  ),
  mcpProxyWatchdogPoll: timer(
    'mcp-proxy-watchdog',
    'mcp-proxy-watchdog-poll',
    15_000,
    'apps/operator/lib/mcp-proxy/watchdog.mjs',
    'watchdog',
    'must-sample',
  ),
  mcpProxySessionPlanePoll: timer(
    'mcp-proxy-watchdog',
    'mcp-proxy-session-plane-poll',
    15_000,
    'apps/operator/lib/mcp-proxy/watchdog.mjs',
    'watchdog',
    'must-sample',
  ),
  bgHostWatchdogPoll: timer(
    'bg-host-watchdog',
    'bg-host-watchdog-poll',
    30_000,
    'apps/operator/scripts/bghost-watchdog.mjs',
    'watchdog',
    'must-sample',
  ),
  psuSupervisorHeartbeat: timer(
    'psu-launcher',
    'psu-supervisor-heartbeat',
    60_000,
    'apps/operator/scripts/psu-launcher.mjs',
    'lifecycle',
    'must-sample',
  ),
});

export const EXTERNAL_PROCESS_TIMERS = Object.freeze(Object.values(EXTERNAL_SCHEDULES));

export const SYNC_TRIGGERED_SCHEDULES = Object.freeze({
  docFreshnessSweep: Object.freeze({
    name: 'doc-freshness-sweep',
    cadence: 'after each git-sync',
    armed: true,
    source: 'packages/operator-core/lib/harness/docs/sweep-after-sync.ts',
    trigger: 'git-sync-action.ts -> runDocFreshnessSweepAfterSync',
    spends: 'none',
    note: "Detects drifted docs by comparing HEAD against each doc's anchored code. Free - no agent spawn.",
  }),
  docStewardDispatch: Object.freeze({
    name: 'doc-steward-dispatch',
    cadence: 'after each git-sync (when drift is found)',
    armed: null,
    flag: 'papercusp-doc-steward',
    source: 'packages/operator-core/lib/harness/docs/doc-steward-dispatch.ts',
    trigger: 'doc-freshness-sweep -> dispatchDocStewardForDrift',
    spends: 'llm',
    note: 'Spawns an LLM doc-steward agent to re-sync drifted docs. Owner-authority dark flag.',
  }),
});

export const SYNC_TRIGGERED_SWEEPS = Object.freeze(Object.values(SYNC_TRIGGERED_SCHEDULES));
