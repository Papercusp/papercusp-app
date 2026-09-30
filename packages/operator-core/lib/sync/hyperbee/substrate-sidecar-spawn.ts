/**
 * Substrate sidecar spawner (P-009).
 *
 * Spawns the substrate sidecar process (apps/operator/bin/substrate-sidecar.ts)
 * as a child process when the SUBSTRATE_SIDECAR flag is ON.
 *
 * Option B (replication-offload, WI-604): the spawn enables the Node child IPC
 * channel (`stdio: [..., 'ipc']`) so the swarm connection handler can transfer a
 * raw peer socket to the sidecar out-of-band via `subprocess.send(msg, socket)`
 * (the sidecar's `registerHandleListener` correlates the handle to a prepared
 * handoff token). `getSubstrateSidecarProcess()` exposes the live child for that
 * transfer. ALL of this is dark — gated by the OFF-by-default SUBSTRATE_SIDECAR
 * flag; the OFF path never spawns, so the IPC channel is byte-irrelevant there.
 */

import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { resolveSubstrateSocketPath, SUBSTRATE_SOCKET_ENV } from './substrate-socket-path';
import { buildIsolatedScopeArgv, SCOPE_LAUNCH_FAILURE_RE } from '../../systemd-scope';
import {
  beginSyncEnrolment,
  completeSyncEnrolment,
  finishSyncEnrolment,
} from '../../task-manager/enroll-sync';
import type { TaskSpec } from '../../task-manager/types';
import {
  resolveSidecarSpawnPlan,
  respawnBackoffMs,
  pruneRespawnWindow,
  respawnBudgetExhausted,
  gracefulStopChild,
  registerSidecarShutdownHooks as registerSharedSidecarShutdownHooks,
} from '../../process-supervision/sidecar-spawn-shared';
import { isBenignHostError } from '../../host-benign-errors';

// EI-1612 (infra round-3/4): this package is ESM (type:module), where `__dirname`
// is undefined. The previous `path.join(__dirname, …)` threw "__dirname is not
// defined", so the sidecar spawn failed and the substrate fell back to IN-PROCESS
// — running hyperbee on the host's main event loop (the EI-79 saturation class
// that starves routinesTick / git-sync on the bg-host). Derive it from import.meta.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

let sidecarProcess: ChildProcess | null = null;
let sidecarReady = false;
const readyWaiters: (() => void)[] = [];

// --- WI-1504 (substrate-sidecar-memory-isolation-2026-07-02): scope isolation +
// crash-respawn state ---------------------------------------------------------
// `deliberateStop` distinguishes a deliberate stopSubstrateSidecar() call from an
// unexpected crash/OOM-kill in the 'exit' handler — only the latter triggers
// auto-respawn. Reset to false at the top of every (re)spawn attempt.
let deliberateStop = false;
// Sliding-window circuit breaker: MAX_RESPAWN_ATTEMPTS unexpected deaths inside
// RESPAWN_WINDOW_MS gives up auto-respawning, so a persistently-crashing sidecar
// (e.g. a leak that re-triggers immediately after every restart) can't loop
// forever burning CPU + log spam. An explicit spawnSubstrateSidecar() call (e.g.
// from substrate-boot-wrapper on the next boot) starts a fresh window.
export const MAX_RESPAWN_ATTEMPTS = 5;
export const RESPAWN_WINDOW_MS = 5 * 60_000;
let respawnAttempts: number[] = []; // timestamps (ms) of recent auto-respawn schedules
let respawnTimer: ReturnType<typeof setTimeout> | null = null;
// P-006 (critical-process-supervisor-2026-07-04): latches once the sliding-window
// circuit breaker below gives up, so `substrateSidecarSupervisionStatus()` (feeding
// dev:service_health's supervision block) can report 'gave-up' instead of silently
// looking merely idle. Reset at the top of every fresh spawnSubstrateSidecar() call,
// mirroring `deliberateStop`'s reset.
let gaveUp = false;

// ── WI-1877: post-respawn reconcile hook ─────────────────────────────────────
//
// THE BUG this closes: `scheduleRespawn` below only re-starts the sidecar
// PROCESS. Nothing re-issues `bootHarness` (substrate:bootHarness over IPC)
// for the harnesses that were booted onto the OLD (now-gone) sidecar instance
// — the new process starts with ZERO harnesses registered, so it joins no
// swarm topics and federation goes silently dark until a full app restart
// (live repro: mac VM 2026-07-03, 10+ min with zero topic joins post-respawn).
//
// `onSidecarRespawned` lets a higher layer (substrate-boot-wrapper, which
// already owns the `handles` map of booted harnesses in boot-all.ts) register
// a callback that fires once a crash-triggered auto-respawn SUCCEEDS (the new
// sidecar is ready) — this module stays agnostic of what "re-boot every
// harness" means; it only reports the fact that a fresh sidecar just came up.
type RespawnListener = () => void;
const respawnListeners = new Set<RespawnListener>();

/** Register a callback fired after an unexpected-crash auto-respawn SUCCEEDS
 *  (the new sidecar process passed its ready handshake). Never fires for the
 *  FIRST (non-respawn) spawn, and never for a deliberate stop. Returns an
 *  unsubscribe fn. Listener errors are caught + logged — one bad listener
 *  must never break the others or the respawn itself. */
export function onSidecarRespawned(listener: RespawnListener): () => void {
  respawnListeners.add(listener);
  return () => {
    respawnListeners.delete(listener);
  };
}

function notifySidecarRespawned(): void {
  for (const listener of respawnListeners) {
    try {
      listener();
    } catch (e) {
      console.error('[substrate-sidecar] onSidecarRespawned listener threw:', e instanceof Error ? e.message : String(e));
    }
  }
}

/** Test seam — clear registered respawn listeners between unit tests. */
export function _resetSidecarRespawnListenersForTests(): void {
  respawnListeners.clear();
}

/** Per-sidecar memory cap (GiB) for the isolated spawn scope (systemd-run --user
 *  --scope). WI-1504: the sidecar leaks under peer-sync load (27GB bursts observed
 *  in the wild) — scoping it means a balloon OOM-kills ONLY the sidecar's own
 *  cgroup, never the bg-host's (which would otherwise drag every in-flight agent
 *  down with it), and the exit handler below auto-respawns it. Override:
 *  PAPERCUSP_SUBSTRATE_SIDECAR_MEMORY_MAX_G. */
export function substrateSidecarScopeMemoryMaxG(): number {
  const raw = Number(process.env.PAPERCUSP_SUBSTRATE_SIDECAR_MEMORY_MAX_G);
  return Number.isFinite(raw) && raw > 0 ? raw : 8;
}

/** Isolation kill-switch (peer of orchestrator-runner.ts's PAPERCUSP_AGENT_SPAWN_SCOPE
 *  / release-actions.ts's PAPERCUSP_CHECKPOINT_SCOPE): PAPERCUSP_SUBSTRATE_SIDECAR_SCOPE=0
 *  forces the pre-hardening same-cgroup spawn (ops escape hatch). Linux-only —
 *  systemd-run has no analog elsewhere, and every deployment target for this
 *  operator is a Linux host (dev box + prod). */
export function substrateSidecarScopeEnabled(): boolean {
  return process.platform === 'linux' && process.env.PAPERCUSP_SUBSTRATE_SIDECAR_SCOPE !== '0';
}

/** Group-kill the sidecar's whole process tree. Under `detached: true` the wrapper
 *  (systemd-run, when scoped) and the wrapped payload share the child's pgid, so a
 *  single `process.kill(-pid)` reaps both; falls back to a single-pid kill if the
 *  group signal fails (e.g. already exited / no such group). */
function killSidecarTree(sig: NodeJS.Signals): void {
  const proc = sidecarProcess;
  if (!proc) return;
  const pid = proc.pid;
  if (pid) {
    try {
      process.kill(-pid, sig);
      return;
    } catch {
      /* fall through to single-pid kill */
    }
  }
  try {
    proc.kill(sig);
  } catch {
    /* ignore */
  }
}

/** Auto-respawn-on-crash (WI-1504 AC: "synthetic 10G allocation → sidecar
 *  killed+respawned, bg-host main + agents untouched"). Applies a short exponential
 *  backoff (capped at 30s) so a fast crash loop doesn't hammer systemd-run, and the
 *  sliding-window circuit breaker above so a persistently-crashing sidecar gives up
 *  rather than looping forever. */
function scheduleRespawn(socketPath: string): void {
  if (deliberateStop) return;
  if (respawnTimer) return; // a respawn is already pending
  const now = Date.now();
  respawnAttempts = pruneRespawnWindow(respawnAttempts, now, RESPAWN_WINDOW_MS);
  if (respawnBudgetExhausted(respawnAttempts, MAX_RESPAWN_ATTEMPTS)) {
    gaveUp = true;
    console.error(
      `[substrate-sidecar] ${MAX_RESPAWN_ATTEMPTS} crashes within ${Math.round(RESPAWN_WINDOW_MS / 1000)}s — giving up auto-respawn. ` +
        'Substrate stays on its in-process fallback (see substrate-boot-wrapper) until an explicit spawnSubstrateSidecar() call.',
    );
    return;
  }
  respawnAttempts.push(now);
  const backoffMs = respawnBackoffMs(respawnAttempts.length);
  console.warn(
    `[substrate-sidecar] auto-respawning in ${backoffMs}ms (attempt ${respawnAttempts.length}/${MAX_RESPAWN_ATTEMPTS} in window)`,
  );
  respawnTimer = setTimeout(() => {
    respawnTimer = null;
    spawnSubstrateSidecar(socketPath)
      .then(() => {
        // WI-1877: the process is back, but the new instance knows about
        // ZERO harnesses — notify so the harness-level reconcile (owned by
        // boot-all.ts via substrate-boot-wrapper) re-registers each one.
        notifySidecarRespawned();
      })
      .catch((err) => {
        console.error('[substrate-sidecar] auto-respawn failed:', err);
      });
  }, backoffMs);
}

/**
 * Spawn the substrate sidecar process.
 * Waits for the PAPERCUSP_SUBSTRATE_READY handshake line.
 */
export async function spawnSubstrateSidecar(
  socketPath?: string,
  useScope: boolean = substrateSidecarScopeEnabled(),
): Promise<void> {
  // WI-7249 / D-011: registration belongs to the SPAWN, not to a call site. This
  // sidecar registers via substrate-boot-wrapper today and so does not leak — but it
  // has the same call-site-coupled shape the spawner-sidecar leaked from, and is one
  // new entry point away from the same bug. Idempotent by label.
  registerSidecarShutdownHooks();

  if (sidecarProcess) {
    // Already running
    if (sidecarReady) return;
    // Wait for ready
    return new Promise((resolve) => {
      readyWaiters.push(resolve);
    });
  }

  // A fresh spawn attempt — clear any pending backoff timer and the deliberate-stop
  // flag so the crash-respawn machinery is armed for this (re)spawn.
  deliberateStop = false;
  gaveUp = false;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }

  const sidecarScript = path.join(
    // 5 levels up from packages/operator-core/lib/sync/hyperbee/ → repo root,
    // then apps/operator/bin/. (Was 4 — a latent path bug masked by the __dirname
    // crash; with the EI-1612 __dirname fix it surfaced as packages/apps/… ENOENT.)
    moduleDir,
    '../../../../../apps/operator/bin/substrate-sidecar.ts',
  );

  // Resolve the IPC socket ONCE and pin it in process.env so the parent IPC
  // client (getSubstrateIpcClient) and the spawned child resolve the SAME
  // absolute path. NEVER CWD-relative: a relative `.papercusp` mkdir is EACCES
  // from a packaged root-owned CWD (e.g. /usr/lib/Papercusp/sidecar) → the spawn
  // failed and silently fell back to in-process, so the relocation only ever ran
  // off a dev tree (P-006 live 2-machine rig finding, 2026-06-25).
  const resolvedSocket = socketPath ?? resolveSubstrateSocketPath();
  process.env[SUBSTRATE_SOCKET_ENV] = resolvedSocket;
  const socketDir = path.dirname(resolvedSocket);
  if (!fs.existsSync(socketDir)) {
    fs.mkdirSync(socketDir, { recursive: true });
  }

  // Spawn target. esbuild bundles EVERY module into the single serve.mjs, so in a
  // PACKAGED build import.meta.url here IS serve.mjs — re-exec that artifact under
  // the bundled node with PAPERCUSP_SUBSTRATE_SIDECAR_MODE=1 (serve.ts diverts to
  // runSubstrateSidecarServer). In DEV (tsx, real source tree) run the .ts entry
  // via tsx. The old unconditional `npx tsx <.ts>` could not work off a bundle
  // (no tsx, no .ts on disk) — the other half of the P-006 finding.
  const selfPath = fileURLToPath(import.meta.url);
  const plan = resolveSidecarSpawnPlan({
    selfPath,
    devScriptPath: sidecarScript,
    bundledModeEnvVar: 'PAPERCUSP_SUBSTRATE_SIDECAR_MODE',
    execPath: process.execPath,
    spawnerPid: process.pid,
  });

  return new Promise<void>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...plan.env,
      [SUBSTRATE_SOCKET_ENV]: resolvedSocket,
    };

    const cmd = plan.cmd;
    const args = plan.args;
    const launchedAt = Date.now();

    // P-009 (task-manager-no-escape-2026-07-27): enrol this sidecar in the task
    // ledger. CONFINEMENT was never the gap here — buildIsolatedScopeArgv already
    // caps memory — but it builds an UNNAMED transient scope (`run-rNNNN.scope`),
    // and a row the ledger cannot join to by unit name is a row the reconciler
    // reads as `unaccounted`. That is why this was the one site the detached-spawn
    // guard still allowlists as a P-009 follow-up.
    //
    // `enrolment.wrap` emits the SAME systemd-run scope with a NAMED unit
    // (`pc-<taskId>.scope`) under the sidecar slice, and buildTaskScopeArgv emits
    // MemoryMax AND MemorySwapMax=0 whenever memoryMaxBytes > 0 — so the WI-1504
    // swap-thrash guarantee ("synthetic 10G allocation -> sidecar killed, bg-host
    // untouched") is preserved byte-for-byte, not merely approximated.
    //
    // `confine: useScope` keeps the scope-launch-failure fallback intact: that
    // path re-enters with useScope=false, and an unconfined enrolment leaves argv
    // untouched, so the retry is byte-identical to its pre-P-009 behaviour. Same
    // for task-manager flag-OFF, which falls back to the unnamed isolated scope.
    const taskSpec: TaskSpec = {
      class: 'sidecar',
      title: 'substrate sidecar',
      argv: [cmd, ...args],
      launchedBy: 'system:substrate-sidecar',
      memoryMaxBytes: substrateSidecarScopeMemoryMaxG() * 1024 ** 3,
      // WI-41206: EXPLICIT 'deny'. The scope builders now default to 'allow' so that ordinary
      // worker scopes page instead of being OOM-killed — but this sidecar is the exact payload
      // that earned the swap-0 policy in the first place. Its leak drove the bg-host cgroup to
      // 46.7 GB and a 68 GB swap-thrash that froze the event loop (WI-1086), and the WI-1504
      // guarantee below ("synthetic 10G allocation -> sidecar killed, bg-host untouched")
      // depends on it dying rather than paging. Do NOT relax this to inherit the default.
      swap: 'deny',
      detail: { socketPath: resolvedSocket },
    };
    const enrolment = beginSyncEnrolment(taskSpec, { confine: useScope });
    const wrapped = enrolment.confined ? enrolment.wrap(cmd, args) : null;

    const [spawnCommand, ...spawnArgs] = wrapped
      ? [wrapped.binary, ...wrapped.argv]
      : useScope
        ? // WI-41206: 'deny' here too — the unnamed-scope fallback must match the named path
          // above, or the WI-1504 guarantee would hold only when the task manager is enabled.
          buildIsolatedScopeArgv([cmd, ...args], substrateSidecarScopeMemoryMaxG(), 'deny')
        : [cmd, ...args];
    let stderr = '';
    let settled = false;

    // 'ipc' as the 4th stdio slot opens the Node child_process IPC channel —
    // the out-of-band Duplex *handle* transport the Option B socket-handoff
    // rides (`subprocess.send(msg, socket)` → sidecar's process.on('message',
    // (msg, handle))). Without it `process.send` is undefined in the child and
    // the handle listener no-ops, so the raw socket can never cross the process
    // boundary. Harmless on the OFF path (the sidecar is never spawned there).
    sidecarProcess = spawn(spawnCommand, spawnArgs, {
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: true,
    });
    const child = sidecarProcess;
    // Fire-and-forget by contract — never awaited by the spawn path and never
    // allowed to reject into it. A lost enrolment degrades to an `unaccounted`
    // row on the next reconcile, which is the alarm that classification exists
    // to raise, rather than a failed sidecar boot.
    completeSyncEnrolment(enrolment, taskSpec, child.pid ?? null);

    // Guards the exit handler against double-closing the ledger row. The row is
    // per-SPAWN, not per-sidecar: scheduleRespawn() re-enters spawnSubstrateSidecar
    // and mints a fresh enrolment, so a respawn must close this row and open a new
    // one. Holding one row across a respawn is exactly the non-exit strand leak
    // already filed as WI-7249.
    let enrolmentClosed = false;

    const cleanup = () => {
      clearTimeout(timeout);
    };
    const isScopeLaunchFailure = (code: number | null): boolean =>
      useScope &&
      !sidecarReady &&
      code !== 0 &&
      Date.now() - launchedAt < 5_000 &&
      SCOPE_LAUNCH_FAILURE_RE.test(stderr);

    const timeout = setTimeout(() => {
      if (!sidecarReady && sidecarProcess === child) {
        killSidecarTree('SIGKILL');
        sidecarProcess = null;
      }
      if (settled) return;
      settled = true;
      reject(new Error('Sidecar startup timeout'));
    }, 10000);

    // Listen for ready handshake. Decode across chunk boundaries — the
    // handshake line carries a socket PATH, which can contain non-ASCII.
    const readyDecoder = new StringDecoder('utf8');
    let stdoutBuffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += readyDecoder.write(chunk);
      const lines = stdoutBuffer.split('\n');

      // Keep the last incomplete line
      stdoutBuffer = lines[lines.length - 1] || '';

      for (const line of lines.slice(0, -1)) {
        console.log('[substrate-sidecar]', line);

        if (line.includes('PAPERCUSP_SUBSTRATE_READY')) {
          sidecarReady = true;
          cleanup();
          if (settled) return;
          settled = true;
          resolve();

          // Wake any other waiters
          for (const waiter of readyWaiters) {
            waiter();
          }
          readyWaiters.length = 0;
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      console.warn('[substrate-sidecar-err]', text.trim());
    });

    child.on('error', (err) => {
      cleanup();
      if (sidecarProcess === child) sidecarProcess = null;
      sidecarReady = false;
      if (settled) return;
      if (useScope) {
        settled = true;
        resolve(spawnSubstrateSidecar(resolvedSocket, false));
        return;
      }
      settled = true;
      reject(err);
    });

    child.on('exit', (code) => {
      cleanup();
      const msg = code !== null ? `exit code ${code}` : 'killed';
      // Close the ledger row for THIS spawn. `code === null` means the process was
      // signalled rather than exiting on its own, which is the ledger's 'killed';
      // a deliberateStop is still a clean 'exited'. Without this the row survives
      // its process and the reconciler has to strand it, which is the 88-rows-in-24h
      // shape D-015 measured.
      if (!enrolmentClosed) {
        enrolmentClosed = true;
        finishSyncEnrolment(enrolment, {
          state: code === null && !deliberateStop ? 'killed' : 'exited',
          exitCode: code,
          exitReason: deliberateStop ? 'deliberate stop' : `substrate sidecar ${msg}`,
        });
      }
      // A deliberate stopSubstrateSidecar() is a graceful shutdown, not a
      // crash — warning "died" here is misleading noise (and trips
      // vitest-fail-on-console). Only warn for an UNEXPECTED exit.
      if (!deliberateStop) {
        // WI-2030: the captured stderr (already streamed line-by-line via the
        // '[substrate-sidecar-err]' passthrough above) is inline-correlated
        // with the death event here too — on a busy/aggregated log a reader
        // scanning for "died" previously had to separately hunt down the
        // nearby stderr lines to learn WHY; a possibly-red-herring first line
        // (e.g. a headless-container dbus warning) could otherwise be mistaken
        // for the real exit reason with no tail to check it against.
        const stderrTail = stderr.trim().slice(-500);
        console.warn(
          `[substrate-sidecar] died (${msg})${stderrTail ? ` — stderr tail: ${stderrTail}` : ' — no stderr captured'}`,
        );
      }
      const launchFailed = isScopeLaunchFailure(code);
      if (sidecarProcess === child) {
        sidecarProcess = null;
      }
      sidecarReady = false;
      if (launchFailed) {
        if (settled) return;
        settled = true;
        resolve(spawnSubstrateSidecar(resolvedSocket, false));
        return;
      }
      if (!settled) {
        settled = true;
        reject(new Error(`Sidecar exited before ready (${msg})`));
        return;
      }
      scheduleRespawn(resolvedSocket);
    });
  });
}

/** Test seam — reset the module-global respawn/scope state between unit tests. */
export function _resetSubstrateSidecarSpawnStateForTests(): void {
  deliberateStop = false;
  gaveUp = false;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  respawnAttempts = [];
  sidecarProcess = null;
  sidecarReady = false;
  readyWaiters.length = 0;
}

/**
 * P-006: node-child supervision status for `dev:service_health`'s additive
 * `supervision` block (mirrors the systemd-user layer's `supervisionSnapshot()`,
 * `packages/operator-core/lib/supervision/unit-reconciler.ts`) — PURE given the
 * module's own in-memory state (no I/O), safe to call on every request.
 */
export interface SidecarSupervisionStatus {
  running: boolean;
  respawnAttemptsInWindow: number;
  gaveUp: boolean;
  lastRespawnScheduledAt: number | null;
}

export function substrateSidecarSupervisionStatus(now: number = Date.now()): SidecarSupervisionStatus {
  const attempts = pruneRespawnWindow(respawnAttempts, now, RESPAWN_WINDOW_MS);
  return {
    running: !!sidecarProcess && !sidecarProcess.killed,
    respawnAttemptsInWindow: attempts.length,
    gaveUp,
    lastRespawnScheduledAt: attempts.length ? attempts[attempts.length - 1] : null,
  };
}

/**
 * Check if the sidecar is running.
 */
export function isSubstrateSidecarRunning(): boolean {
  return !!sidecarProcess && !sidecarProcess.killed;
}

/**
 * The live sidecar child process, or null when not spawned. Exposed for the
 * Option B socket-handoff: the swarm connection handler calls
 * `proc.send({ kind: 'substrate:socketHandle', handoffToken }, socket)` to
 * transfer a raw peer socket to the sidecar over the child IPC channel. Returns
 * null (and the caller falls back to in-process replication) when the sidecar
 * is absent or its IPC channel is unavailable.
 */
export function getSubstrateSidecarProcess(): ChildProcess | null {
  if (!sidecarProcess || sidecarProcess.killed) return null;
  return sidecarProcess;
}

/** Test seam — inject a fake sidecar ChildProcess (for the handoff unit test)
 *  without spawning the real `npx tsx` child. Pass null to reset. */
export function _setSubstrateSidecarProcessForTests(proc: ChildProcess | null): void {
  sidecarProcess = proc;
  sidecarReady = !!proc;
}

/**
 * Kill the sidecar gracefully.
 */
export async function stopSubstrateSidecar(): Promise<void> {
  if (!sidecarProcess || sidecarProcess.killed) return;
  deliberateStop = true;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  const proc = sidecarProcess;
  await gracefulStopChild(proc, { timeoutMs: 5000, kill: (sig) => killSidecarTree(sig) });
  sidecarProcess = null;
  sidecarReady = false;
}

/**
 * Register graceful shutdown hooks.
 */
export function registerSidecarShutdownHooks(): void {
  registerSharedSidecarShutdownHooks({
    label: 'substrate-sidecar-spawn',
    stop: () => stopSubstrateSidecar(),
    // P-006: don't tear down a healthy substrate sidecar for an
    // uncaughtException hono-host's own guard already classified benign +
    // swallowed (e.g. a client-disconnect `write EPIPE`) — see the matching
    // comment in fleet/spawner-sidecar-spawn.ts.
    isFatalException: (err) => !isBenignHostError(err),
  });
}
