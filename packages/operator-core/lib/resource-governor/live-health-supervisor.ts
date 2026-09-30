/** Managed-child supervisor for the cross-platform live-health monitor. */

import type { ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinModuleState } from '@papercusp/module-singleton';
import {
  gracefulStopChild,
  pruneRespawnWindow,
  registerSidecarShutdownHooks,
  resolveSidecarSpawnPlan,
  respawnBackoffMs,
  respawnBudgetExhausted,
  type SidecarSpawnPlan,
} from '../process-supervision/sidecar-spawn-shared';
import { createTextCollector } from '../child-output';
import { managedSpawn } from '../task-manager/managed-spawn';
import { LIVE_HEALTH_MONITOR_READY_PREFIX } from './live-health-monitor-main';

const moduleDir = dirname(fileURLToPath(import.meta.url));
export const LIVE_HEALTH_MONITOR_MAX_RESPAWN_ATTEMPTS = 5;
export const LIVE_HEALTH_MONITOR_RESPAWN_WINDOW_MS = 5 * 60_000;
export const LIVE_HEALTH_MONITOR_READY_TIMEOUT_MS = 15_000;

interface SupervisorState {
  child: ChildProcess | null;
  ready: boolean;
  deliberateStop: boolean;
  spawnInFlight: Promise<void> | null;
  respawnAttempts: number[];
  respawnTimer: ReturnType<typeof setTimeout> | null;
}

const state = pinModuleState(
  '@papercusp/operator-core.resource-governor-live-health-supervisor',
  () =>
    ({
      child: null,
      ready: false,
      deliberateStop: false,
      spawnInFlight: null,
      respawnAttempts: [],
      respawnTimer: null,
    }) as SupervisorState,
);

export function buildLiveHealthMonitorSpawnPlan(
  options: {
    selfPath?: string;
    execPath?: string;
    moduleDirOverride?: string;
    spawnerPid?: number;
  } = {},
): SidecarSpawnPlan {
  return resolveSidecarSpawnPlan({
    selfPath: options.selfPath ?? fileURLToPath(import.meta.url),
    devScriptPath: join(options.moduleDirOverride ?? moduleDir, 'live-health-monitor-bin.ts'),
    bundledModeEnvVar: 'PAPERCUSP_RESOURCE_GOVERNOR_MONITOR_MODE',
    execPath: options.execPath ?? process.execPath,
    spawnerPid: options.spawnerPid ?? process.pid,
  });
}

function scheduleRespawn(): void {
  if (state.deliberateStop || state.respawnTimer) return;
  const now = Date.now();
  state.respawnAttempts = pruneRespawnWindow(state.respawnAttempts, now, LIVE_HEALTH_MONITOR_RESPAWN_WINDOW_MS);
  if (respawnBudgetExhausted(state.respawnAttempts, LIVE_HEALTH_MONITOR_MAX_RESPAWN_ATTEMPTS)) {
    console.error(
      `[resource-governor-health] ${LIVE_HEALTH_MONITOR_MAX_RESPAWN_ATTEMPTS} monitor crashes within ` +
        `${LIVE_HEALTH_MONITOR_RESPAWN_WINDOW_MS / 1_000}s — auto-respawn paused until the next host boot`,
    );
    return;
  }
  state.respawnAttempts.push(now);
  const delayMs = respawnBackoffMs(state.respawnAttempts.length);
  state.respawnTimer = setTimeout(() => {
    state.respawnTimer = null;
    void ensureLiveHealthMonitor().catch((error) => {
      console.error('[resource-governor-health] respawn failed:', error instanceof Error ? error.message : error);
      scheduleRespawn();
    });
  }, delayMs);
  state.respawnTimer.unref?.();
}

async function spawnMonitor(): Promise<void> {
  registerLiveHealthMonitorShutdownHooks();
  state.deliberateStop = false;
  if (state.respawnTimer) {
    clearTimeout(state.respawnTimer);
    state.respawnTimer = null;
  }
  const plan = buildLiveHealthMonitorSpawnPlan();
  const managed = await managedSpawn(
    plan.cmd,
    plan.args,
    {
      class: 'sidecar',
      title: 'resource-governor live-health monitor',
      argv: [plan.cmd, ...plan.args],
      launchedBy: 'system:resource-governor-live-health-monitor',
      detail: { mode: plan.mode },
    },
    {
      spawnOptions: {
        env: { ...process.env, ...plan.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      },
    },
  );
  const child = managed.child;
  state.child = child;
  state.ready = false;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    // Boundary-safe: a multi-byte UTF-8 character split across two 'data'
    // events must not decode to replacement chars. peek() never flushes, so it
    // is safe to call on every chunk; consumedChars tracks the line-complete
    // prefix we have already dispatched.
    const stdoutCollector = createTextCollector();
    let consumedChars = 0;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      finish(new Error(`live-health monitor did not become ready within ${LIVE_HEALTH_MONITOR_READY_TIMEOUT_MS}ms`));
    }, LIVE_HEALTH_MONITOR_READY_TIMEOUT_MS);
    timeout.unref?.();
    stdoutCollector.attach(child.stdout);
    child.stdout?.on('data', () => {
      const all = stdoutCollector.peek();
      const lines = all.slice(consumedChars).split('\n');
      const partial = lines.pop() ?? '';
      consumedChars = all.length - partial.length;
      for (const line of lines) {
        if (line.startsWith(LIVE_HEALTH_MONITOR_READY_PREFIX)) {
          state.ready = true;
          finish();
        } else if (line.trim()) {
          console.log('[resource-governor-health]', line);
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) console.warn('[resource-governor-health]', line);
      }
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      const wasDeliberate = state.deliberateStop;
      if (state.child === child) state.child = null;
      state.ready = false;
      if (!settled) finish(new Error(`live-health monitor exited before ready (${signal ?? code ?? 'unknown'})`));
      if (!wasDeliberate) scheduleRespawn();
    });
  });
}

/** Default-on, idempotent child start for desktop, packaged, and service hosts. */
export function ensureLiveHealthMonitor(): Promise<void> {
  if (process.env.PAPERCUSP_RESOURCE_GOVERNOR_MONITOR === '0') return Promise.resolve();
  if (state.child && state.ready) return Promise.resolve();
  if (state.spawnInFlight) return state.spawnInFlight;
  state.spawnInFlight = spawnMonitor().finally(() => {
    state.spawnInFlight = null;
  });
  return state.spawnInFlight;
}

export async function stopLiveHealthMonitor(): Promise<void> {
  state.deliberateStop = true;
  if (state.respawnTimer) {
    clearTimeout(state.respawnTimer);
    state.respawnTimer = null;
  }
  const child = state.child;
  state.child = null;
  state.ready = false;
  if (!child) return;
  child.stdin?.end();
  await gracefulStopChild(child, {
    timeoutMs: 5_000,
    kill: (signal) => child.kill(signal),
  });
}

export function registerLiveHealthMonitorShutdownHooks(): void {
  registerSidecarShutdownHooks({
    label: 'resource-governor-live-health-monitor',
    stop: stopLiveHealthMonitor,
    mode: 'async-with-exit',
  });
}

export function _resetLiveHealthSupervisorForTests(): void {
  if (state.respawnTimer) clearTimeout(state.respawnTimer);
  state.child = null;
  state.ready = false;
  state.deliberateStop = false;
  state.spawnInFlight = null;
  state.respawnAttempts = [];
  state.respawnTimer = null;
}
