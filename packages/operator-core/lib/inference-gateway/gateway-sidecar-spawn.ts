/**
 * Cross-platform inference-gateway supervisor (P-006/P-007,
 * cross-platform-hardening-and-agent-ergonomics-2026-07-05 / WI-3059).
 *
 * WHY: the gateway (:8788 paced OAuth egress for the whole fleet) was supervised ONLY by
 * a systemd --user unit — macOS has no systemd and WSL lacks it by default, so the
 * packaged desktop app simply never had a gateway (the Mac-VM agent found the port
 * unreachable and agonized over it). This module replicates the unit's Restart=always
 * semantics as a MANAGED CHILD of the operator, the same pattern as
 * sync/hyperbee/substrate-sidecar-spawn.ts and fleet/spawner-sidecar-spawn.ts (third
 * instance of the sidecar-spawn shape — extraction to a shared lib is tracked as a
 * follow-up, deliberately not done mid-flight here).
 *
 * KEY DIFFERENCE from its siblings: PORT-PROBE-FIRST ADOPTION. On the Linux dev box the
 * systemd unit already owns :8788; probing before spawning means we ADOPT the external
 * gateway instead of racing it for the bind (EADDRINUSE crash-loop). That probe also
 * self-gates the whole feature — no getFlag() at host-boot (fragile there: resolves
 * false when PostHog is unreachable — see the stall-waker note in host-bootstrap.ts).
 *
 * Spawn target mirrors the substrate P-006 finding: esbuild bundles EVERYTHING into the
 * single serve.mjs, so in a PACKAGED build we re-exec that artifact under the bundled
 * node with PAPERCUSP_GATEWAY_SIDECAR_MODE=1 (serve.ts diverts to runGatewaySidecarMain);
 * in DEV (tsx, real source tree) we `npx tsx` the sibling bin.ts.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { DEFAULT_GATEWAY_PORT } from './launch';
import {
  resolveSidecarSpawnPlan,
  respawnBackoffMs,
  pruneRespawnWindow,
  respawnBudgetExhausted,
  gracefulStopChild,
  registerSidecarShutdownHooks,
} from '../process-supervision/sidecar-spawn-shared';

// ESM (type:module): derive the module dir from import.meta (the EI-1612 __dirname fix).
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ── crash-respawn state (WI-3079: shared with substrate-sidecar-spawn via
// process-supervision/sidecar-spawn-shared.ts) ──────────────────────────────
export const GATEWAY_MAX_RESPAWN_ATTEMPTS = 5;
export const GATEWAY_RESPAWN_WINDOW_MS = 5 * 60_000;
/** Backoff before respawn attempt N (1-based) within the window: 1s·2^(N−1), capped 30s.
 *  Exported pure for tests (kept as a named re-export for back-compat with
 *  existing imports of this symbol). */
export function gatewayRespawnBackoffMs(attemptInWindow: number): number {
  return respawnBackoffMs(attemptInWindow);
}

let gatewayProcess: ChildProcess | null = null;
let deliberateStop = false;
let respawnAttempts: number[] = []; // timestamps (ms) of recent auto-respawn schedules
let respawnTimer: ReturnType<typeof setTimeout> | null = null;
let adoptedExternal = false;
// autonomous-loop-prod-audit-2026-07-02 P-006 (SPOF 2, deferred items d+e): true once
// scheduleRespawn's circuit breaker gives up (GATEWAY_MAX_RESPAWN_ATTEMPTS exhausted) —
// without the periodic reprobe below this was a PERMANENT fail-closed state on a
// packaged desktop (no systemd to eventually recover the port), requiring a manual
// ensureGatewaySidecar() call the agent has no reason to make.
let respawnGivenUp = false;
let reprobeHandle: ManagedHandle | null = null;

/** The port this supervisor manages (env override → default 8788). */
export function gatewaySupervisorPort(): number {
  return Number(process.env.PAPERCUSP_GATEWAY_PORT) || DEFAULT_GATEWAY_PORT;
}

/** TCP-connect probe: is ANYTHING listening on 127.0.0.1:<port>? Deliberately transport-level
 *  (no HTTP): "listening" is exactly the bind-conflict + adoption question, and it works even
 *  if the gateway's HTTP surface changes. Never throws. */
export function isGatewayListening(port: number = gatewaySupervisorPort(), timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (up: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(up);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export interface GatewaySpawnPlan {
  cmd: string;
  args: string[];
  /** Extra env entries layered over process.env for the child. */
  env: Record<string, string>;
  mode: 'bundled-reexec' | 'dev-tsx';
}

/**
 * Decide HOW to spawn the gateway process — pure, exported for tests.
 * `selfPath` = this module's resolved file (import.meta). In a packaged build esbuild has
 * inlined this module into serve.mjs, so selfPath IS the bundle (not .ts) → re-exec it in
 * gateway mode under the bundled node. In dev it's the real .ts → `npx tsx bin.ts`.
 */
export function buildGatewaySpawnPlan(opts?: {
  selfPath?: string;
  execPath?: string;
  moduleDirOverride?: string;
}): GatewaySpawnPlan {
  const selfPath = opts?.selfPath ?? fileURLToPath(import.meta.url);
  const execPath = opts?.execPath ?? process.execPath;
  const dir = opts?.moduleDirOverride ?? moduleDir;
  // Dev: bin.ts is a SIBLING of this module (same dir) — no fragile ../../../ hops.
  return resolveSidecarSpawnPlan({
    selfPath,
    devScriptPath: path.join(dir, 'bin.ts'),
    bundledModeEnvVar: 'PAPERCUSP_GATEWAY_SIDECAR_MODE',
    execPath,
    spawnerPid: process.pid,
  });
}

export type EnsureGatewayOutcome = 'disabled' | 'already-running' | 'adopted-external' | 'spawned';

/**
 * Ensure a gateway is serving on the supervisor port: adopt an already-listening one
 * (systemd on the dev box, or another operator instance), else spawn + supervise a child.
 * Idempotent; safe to call from multiple boot paths.
 */
export async function ensureGatewaySidecar(): Promise<EnsureGatewayOutcome> {
  if (process.env.PAPERCUSP_GATEWAY_SUPERVISE === '0') return 'disabled';
  if (gatewayProcess) return 'already-running';

  const port = gatewaySupervisorPort();
  armReprobeTimer(port);
  if (await isGatewayListening(port)) {
    // systemd (Linux dev box) or a sibling operator already owns the port — adopt, never
    // double-bind. If IT dies later, nothing here notices on its own (it has its own
    // Restart=always) — armReprobeTimer above is what NOW periodically re-checks this
    // (SPOF 2e: previously only the wedge watchdog covered gateway health, and that
    // detector reads a live /stats response, so a cleanly-DEAD external gateway with no
    // listener at all was invisible to it).
    adoptedExternal = true;
    return 'adopted-external';
  }

  await spawnGatewayChild(port);
  return 'spawned';
}

/** How often the reprobe timer re-checks port liveness (SPOF 2 d+e). Default 60s — cheap
 *  (a single TCP connect probe). Env PAPERCUSP_GATEWAY_REPROBE_SEC; `<=0` disables it (the
 *  supervisor then behaves exactly as before this fix — no periodic re-probe). */
export function gatewayReprobeIntervalSec(): number {
  const n = Number(process.env.PAPERCUSP_GATEWAY_REPROBE_SEC ?? 60);
  return Number.isFinite(n) ? n : 60;
}

/** Arm the periodic reprobe timer (idempotent — managedSetInterval re-arms replace, and this
 *  guards on `reprobeHandle` besides). Category 'watchdog': an out-of-band sentinel that must
 *  keep running independent of the gateway process it watches (scheduled-registry's own
 *  taxonomy for exactly this shape). */
function armReprobeTimer(port: number): void {
  if (reprobeHandle) return;
  const intervalSec = gatewayReprobeIntervalSec();
  if (intervalSec <= 0) return; // kill switch
  reprobeHandle = managedSetInterval(
    'gateway-sidecar-reprobe',
    intervalSec * 1_000,
    () => gatewayReprobeTick(port),
    { category: 'watchdog' },
  );
}

/**
 * The periodic reprobe tick (SPOF 2, autonomous-loop-prod-audit-2026-07-02 P-006, deferred
 * items d+e). Exported (with an injectable spawn seam) so the two failure classes are unit-
 * testable without forking a real child:
 *
 *  (e) adopted-external gateway died and nothing here noticed — reprobe finds the port no
 *      longer listening, so drop the adoption and spawn our OWN child (the fallback the
 *      packaged desktop needs when there's no systemd to notice/restart it).
 *  (d) the respawn circuit breaker gave up (GATEWAY_MAX_RESPAWN_ATTEMPTS exhausted) — without
 *      this, that was a PERMANENT fail-closed state. Each reprobe tick either finds the port
 *      reoccupied externally (adopt) or retries a spawn with a FRESH respawn-budget window (a
 *      long-backoff re-arm, gated by this timer's own interval rather than the tight in-window
 *      backoff, so a persistently-broken environment doesn't spin — it retries at most once per
 *      `gatewayReprobeIntervalSec()`).
 */
export async function gatewayReprobeTick(
  port: number,
  deps: { spawnGatewayChild?: (port: number) => Promise<void> } = {},
): Promise<void> {
  if (deliberateStop) return;
  const doSpawn = deps.spawnGatewayChild ?? spawnGatewayChild;
  try {
    const listening = await isGatewayListening(port);
    if (adoptedExternal) {
      if (listening) return; // still healthy — nothing to do
      console.warn(
        `[gateway-sidecar] adopted-external gateway on :${port} is no longer listening — spawning our own child`,
      );
      adoptedExternal = false;
      try {
        await doSpawn(port);
      } catch (err) {
        console.error('[gateway-sidecar] reprobe respawn-after-external-death failed:', err instanceof Error ? err.message : err);
        scheduleRespawn(port);
      }
      return;
    }
    if (respawnGivenUp) {
      if (listening) {
        // Something else took the port while we'd given up (systemd/another operator) — adopt.
        adoptedExternal = true;
        respawnGivenUp = false;
        respawnAttempts = [];
        console.log(`[gateway-sidecar] :${port} now listening externally — adopting after respawn-budget exhaustion`);
        return;
      }
      console.warn(
        `[gateway-sidecar] re-arming respawn after budget exhaustion — reprobe (every ${gatewayReprobeIntervalSec()}s) found the gateway still down on :${port}`,
      );
      respawnGivenUp = false;
      respawnAttempts = []; // fresh circuit-breaker window for this long-backoff retry
      try {
        await doSpawn(port);
      } catch (err) {
        console.error('[gateway-sidecar] re-armed respawn attempt failed:', err instanceof Error ? err.message : err);
        scheduleRespawn(port);
      }
    }
  } catch (err) {
    console.warn('[gateway-sidecar] reprobe tick failed:', err instanceof Error ? err.message : err);
  }
}

async function spawnGatewayChild(port: number): Promise<void> {
  // WI-7249 / D-011: registration belongs to the SPAWN, not to a call site. Placed on
  // the child-spawn seam rather than in ensureGatewaySidecar so the respawn path and
  // the reprobe-tick path are covered too, and so the adopt-external path (which
  // spawns nothing) correctly registers nothing. Idempotent by label.
  registerGatewaySidecarShutdownHooks();

  deliberateStop = false;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }

  const plan = buildGatewaySpawnPlan();
  const child = spawn(plan.cmd, plan.args, {
    env: { ...process.env, ...plan.env, PAPERCUSP_GATEWAY_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false, // dies with the operator by default; shutdown hooks drain it first
  });
  gatewayProcess = child;

  const prefix = '[gateway-sidecar]';
  child.stdout?.on('data', (b: Buffer) => {
    for (const line of b.toString().split('\n')) if (line.trim()) console.log(prefix, line);
  });
  child.stderr?.on('data', (b: Buffer) => {
    for (const line of b.toString().split('\n')) if (line.trim()) console.warn(prefix, line);
  });

  child.on('exit', (code, signal) => {
    if (gatewayProcess === child) gatewayProcess = null;
    if (deliberateStop) return;
    console.warn(`${prefix} exited unexpectedly (code=${code} signal=${signal}) — scheduling respawn`);
    scheduleRespawn(port);
  });

  // Readiness = the port actually accepting connections (the gateway binds synchronously
  // after account resolution; PG hiccups make that seconds, not ms — poll up to 30s).
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await isGatewayListening(port, 750)) {
      console.log(`${prefix} up on 127.0.0.1:${port} (${plan.mode}, pid ${child.pid})`);
      respawnGivenUp = false; // a successful spawn clears any prior budget-exhaustion state
      return;
    }
    if (gatewayProcess !== child) throw new Error('gateway child exited during startup');
    await new Promise((r) => setTimeout(r, 500));
  }
  // Startup timeout: kill and let the exit handler's respawn circuit decide what's next.
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  throw new Error(`gateway child did not start listening on :${port} within 30s`);
}

/** Auto-respawn with exponential backoff + a sliding-window circuit breaker, mirroring
 *  substrate-sidecar-spawn (WI-1504). Before each respawn we RE-PROBE the port: if some
 *  other supervisor took it meanwhile (systemd unit restarted), adopt instead of racing. */
function scheduleRespawn(port: number): void {
  if (deliberateStop) return;
  if (respawnTimer) return; // a respawn is already pending
  const now = Date.now();
  respawnAttempts = pruneRespawnWindow(respawnAttempts, now, GATEWAY_RESPAWN_WINDOW_MS);
  if (respawnBudgetExhausted(respawnAttempts, GATEWAY_MAX_RESPAWN_ATTEMPTS)) {
    // SPOF 2d: this used to be a PERMANENT fail-closed state (a manual ensureGatewaySidecar()
    // call was the only way out — on a packaged desktop with no systemd, nothing ever made
    // that call). respawnGivenUp lets the reprobe timer (armed at ensureGatewaySidecar time)
    // retry with a fresh budget window on its own long-backoff cadence instead.
    respawnGivenUp = true;
    console.error(
      `[gateway-sidecar] ${GATEWAY_MAX_RESPAWN_ATTEMPTS} crashes within ${Math.round(GATEWAY_RESPAWN_WINDOW_MS / 1000)}s — giving up auto-respawn for now. ` +
        'Agents get connection-refused on :' + port + ' (fail-closed) until the periodic reprobe re-arms it ' +
        `(every ${gatewayReprobeIntervalSec()}s) or an explicit ensureGatewaySidecar() call.`,
    );
    return;
  }
  respawnAttempts.push(now);
  const backoffMs = gatewayRespawnBackoffMs(respawnAttempts.length);
  console.warn(`[gateway-sidecar] auto-respawning in ${backoffMs}ms (attempt ${respawnAttempts.length}/${GATEWAY_MAX_RESPAWN_ATTEMPTS} in window)`);
  respawnTimer = setTimeout(() => {
    respawnTimer = null;
    void (async () => {
      try {
        if (await isGatewayListening(port)) {
          adoptedExternal = true;
          console.log('[gateway-sidecar] port re-occupied externally during backoff — adopting, not respawning');
          return;
        }
        await spawnGatewayChild(port);
      } catch (err) {
        console.error('[gateway-sidecar] auto-respawn failed:', err instanceof Error ? err.message : err);
        scheduleRespawn(port); // count another attempt against the window
      }
    })();
  }, backoffMs);
  respawnTimer.unref?.();
}

/** Deliberate stop: SIGTERM (the child drains, bounded by its own HARD_STOP_MS), SIGKILL fallback. */
export async function stopGatewaySidecar(): Promise<void> {
  deliberateStop = true;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  if (reprobeHandle) {
    reprobeHandle.stop();
    reprobeHandle = null;
  }
  const child = gatewayProcess;
  if (!child) return;
  await gracefulStopChild(child, { timeoutMs: 15_000, kill: (sig) => child.kill(sig) });
  gatewayProcess = null;
}

/** Best-effort drain of the child when the OPERATOR exits (mirrors the sibling spawners). */
export function registerGatewaySidecarShutdownHooks(): void {
  registerSidecarShutdownHooks({
    label: 'gateway-sidecar-spawn',
    mode: 'sync-with-exit',
    stop: () => {
      deliberateStop = true;
      try {
        gatewayProcess?.kill('SIGTERM');
      } catch {
        /* gone */
      }
    },
  });
}

// ── test seams ────────────────────────────────────────────────────────────────
export function _resetGatewaySidecarStateForTests(): void {
  gatewayProcess = null;
  deliberateStop = false;
  respawnAttempts = [];
  if (respawnTimer) clearTimeout(respawnTimer);
  respawnTimer = null;
  adoptedExternal = false;
  respawnGivenUp = false;
  if (reprobeHandle) reprobeHandle.stop();
  reprobeHandle = null;
}
export function _gatewaySidecarStateForTests(): {
  running: boolean;
  adoptedExternal: boolean;
  pendingRespawn: boolean;
  attemptsInWindow: number;
  respawnGivenUp: boolean;
  reprobeArmed: boolean;
} {
  return {
    running: gatewayProcess != null,
    adoptedExternal,
    pendingRespawn: respawnTimer != null,
    attemptsInWindow: respawnAttempts.length,
    respawnGivenUp,
    reprobeArmed: reprobeHandle != null,
  };
}
/** Test seam: force respawnGivenUp true without running the real 5-crash window
 *  (gatewayReprobeTick's (d) branch is otherwise expensive to reach in a unit test). */
export function _setRespawnGivenUpForTests(v: boolean): void {
  respawnGivenUp = v;
}
