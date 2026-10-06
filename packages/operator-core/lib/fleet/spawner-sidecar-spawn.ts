/**
 * Spawner sidecar spawner (WI-344 ③, plan spawner-sidecar-offload-2026-06-30).
 *
 * Cloned from sync/hyperbee/substrate-sidecar-spawn.ts. Spawns the SPAWNER sidecar
 * process (apps/operator/bin/spawner-sidecar.ts) as a child when the OFF-by-default
 * SPAWNER_SIDECAR flag is ON. The sidecar owns the agent-spawn fork/exec +
 * buildInvokeOnce (the ~24.5% main-loop CPU that freezes routinesTick), moved off
 * the bg-host main event loop; the main process talks to it over a Unix-domain
 * JSON-RPC socket (spawner-ipc-client.ts).
 *
 * Everything here is dark — gated by the OFF-by-default flag; the OFF path never
 * spawns, so this module is byte-irrelevant there.
 */

import { ChildProcess, execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { resolveSpawnerSocketPath, SPAWNER_SOCKET_ENV } from './spawner-socket-path';
import { probeUnixSocketAlive, SIDECAR_EXIT_SOCKET_IN_USE } from '../sidecar-socket/pid-keyed-socket';
import {
  resolveSidecarSpawnPlan,
  gracefulStopChild,
  respawnBackoffMs,
  pruneRespawnWindow,
  respawnBudgetExhausted,
  registerSidecarShutdownHooks as registerSharedSidecarShutdownHooks,
} from '../process-supervision/sidecar-spawn-shared';
import { isBenignHostError } from '../host-benign-errors';
import { managedSpawn } from '../task-manager/managed-spawn';
import { newTaskId, scopeUnitForTask } from '../task-manager/types';
import { SPAWNER_SCOPE_ENV } from './sidecar-exec-lifetime';
import { isGracefulDrainInstalled, isShuttingDown, onBeforeHostExit } from '../shutdown-state';

// This package is ESM (type:module), where `__dirname` is undefined. Derive the
// module dir from import.meta (the substrate EI-1612 fix) so the sidecar script
// path resolves instead of throwing "__dirname is not defined" and silently
// falling back to in-process spawning on the host's main loop.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

let sidecarProcess: ChildProcess | null = null;
let sidecarScopeUnit: string | null = null;
let sidecarReady = false;
const readyWaiters: (() => void)[] = [];

/**
 * Signal the sidecar's OWN scope — not just the `systemd-run` client.
 *
 * EI-20200233989444731. For a CONFINED task `managedSpawn` returns the systemd-run
 * CLIENT; the real payload runs in a sibling `pc-<taskId>.scope`. Signalling the
 * client alone can leave that payload running in a scope nobody holds a reference
 * to any more — which is exactly how a live process becomes an "unaccounted
 * cgroup" in the task-manager alarm. The scope unit is minted and returned by our
 * own managed spawn, so addressing it is identity-preserving: it cannot reach a
 * recycled pid the way a bare `kill(pid)` can.
 *
 * SYNCHRONOUS on purpose — the call sites are a process-exit hook and a timer
 * callback, neither of which has an async turn left to await. Best-effort by
 * design: the caller's own client-signal remains the unconfined fallback.
 */
function killOwnedScope(scopeUnit: string | null, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
  if (!scopeUnit) return;
  try {
    execFileSync('systemctl', ['--user', 'kill', `--signal=${signal}`, scopeUnit], { stdio: 'ignore' });
  } catch {
    /* best effort — an unconfined sidecar has no scope to signal. */
  }
}

/**
 * Set when this process ADOPTED a sibling's sidecar instead of spawning its own
 * (see the cross-process adoption block in `spawnSpawnerSidecar`).
 *
 * Kept distinct from `sidecarProcess` on purpose: we hold NO child here, so every
 * lifecycle path that acts on a child must skip an adopted sidecar. Stopping it
 * would kill a sidecar our SIBLINGS are still using, and auto-respawning it would
 * recreate exactly the fan-out this adoption exists to prevent. The owner of a
 * sidecar is the process that spawned it; an adopter is only ever a client.
 */
let adoptedSocketPath: string | null = null;

/** True when this process is using a sidecar it did not spawn. */
export function hasAdoptedSpawnerSidecar(): boolean {
  return adoptedSocketPath !== null;
}

// EI-19479764372783341: `managedSpawn` is ASYNC (it probes systemd scope support
// and writes the ledger row before exec), where the raw `spawn()` it replaced was
// synchronous. That opens a re-entrancy window the old code did not have — the
// `sidecarProcess` check below and the assignment that follows it are no longer in
// the same tick, so two concurrent callers could BOTH spawn a sidecar and race for
// the pid-keyed socket. This holds the in-flight attempt so they share one.
let spawnInFlight: Promise<void> | null = null;

/** One UNCONFINED warning per process — see the spawn site for why. */
let warnedUnconfined = false;

// ── P-006 (critical-process-supervisor-2026-07-04): auto-respawn-on-crash ───
//
// Before this, an unexpected sidecar exit just cleared module state and waited
// for the NEXT caller to lazily `spawnSpawnerSidecar()` again — no proactive
// respawn, no flap-damping, no give-up. That's the exact shape of the observed
// "DHT bootstrap every ~6min" churn class (WI-3568/EI-8810 residue) for the
// SIBLING substrate sidecar; this one just never got the fix substrate got in
// WI-1504. Cloned from substrate-sidecar-spawn.ts's mechanism (same shared
// helpers, same numbers) so both node-child sidecars behave identically.
// `deliberateStop` distinguishes a deliberate stopSpawnerSidecar() call from an
// unexpected crash — only the latter triggers auto-respawn.
let deliberateStop = false;
export const MAX_RESPAWN_ATTEMPTS = 5;
export const RESPAWN_WINDOW_MS = 5 * 60_000;
let respawnAttempts: number[] = []; // timestamps (ms) of recent auto-respawn schedules
let respawnTimer: ReturnType<typeof setTimeout> | null = null;
let gaveUp = false;

/** Applies a short exponential backoff (capped at 30s, `respawnBackoffMs`) so a
 *  fast crash loop doesn't hammer the spawn path, and the sliding-window circuit
 *  breaker so a persistently-crashing sidecar gives up rather than looping
 *  forever (agent-spawn just falls back to whatever `getSpawnerIpcClient`'s
 *  caller does when the sidecar is unreachable — same degrade path as today). */
function scheduleRespawn(socketPath: string): void {
  if (deliberateStop) return;
  // EI-24863236643374267: the sidecar is kept up through the host drain, so a crash
  // inside that window lands here. A fresh child would only be stopped again at
  // exit; leave git on its local fallback for the last seconds instead.
  if (isShuttingDown()) return;
  if (respawnTimer) return; // a respawn is already pending
  const now = Date.now();
  respawnAttempts = pruneRespawnWindow(respawnAttempts, now, RESPAWN_WINDOW_MS);
  if (respawnBudgetExhausted(respawnAttempts, MAX_RESPAWN_ATTEMPTS)) {
    gaveUp = true;
    console.error(
      `[spawner-sidecar] ${MAX_RESPAWN_ATTEMPTS} crashes within ${Math.round(RESPAWN_WINDOW_MS / 1000)}s — giving up auto-respawn. ` +
        'Agent-spawn stays on its degrade path until an explicit spawnSpawnerSidecar() call.',
    );
    return;
  }
  respawnAttempts.push(now);
  const backoffMs = respawnBackoffMs(respawnAttempts.length);
  console.warn(
    `[spawner-sidecar] auto-respawning in ${backoffMs}ms (attempt ${respawnAttempts.length}/${MAX_RESPAWN_ATTEMPTS} in window)`,
  );
  respawnTimer = setTimeout(() => {
    respawnTimer = null;
    spawnSpawnerSidecar(socketPath).catch((err) => {
      console.error('[spawner-sidecar] auto-respawn failed:', err);
    });
  }, backoffMs);
  // EI-22349064282832134: crash recovery is background resilience for a host
  // that still has real work; it must not BECOME the work keeping that host
  // alive. A short-lived green-checkpoint process had already rendered its
  // candidate-fossil decision when an inherited pid-keyed socket noticed its
  // owner was gone. The sidecar exited cleanly, this referenced backoff kept the
  // checkpoint process (and its serializer lock) alive, and each respawn repeated
  // the owner-gone cycle. Long-lived hosts have their own referenced handles, so
  // unref preserves their auto-respawn while letting a finished CLI exit normally.
  respawnTimer.unref?.();
}

/**
 * Spawn the spawner sidecar process.
 * Waits for the PAPERCUSP_SPAWNER_READY handshake line.
 */
export async function spawnSpawnerSidecar(socketPath?: string): Promise<void> {
  // WI-7249 / D-011: shutdown-hook registration is a property of SPAWNING, not of
  // each caller remembering. It used to live at exactly one call site
  // (host-bootstrap.ts, bg-host only), so the entry points ordinary AGENT processes
  // take — git-via-sidecar (git-sync, pot-git storage, harness docs runner,
  // dev-deploy-state) and dbos/orchestrator-runner — spawned a child and registered
  // nothing to stop it. The call-site distribution proved it: 1 of 50 orphans came
  // from bg-host (the path that DOES register), 49 of 50 from agent-session cgroups.
  //
  // The leak is PERMANENT, not a redundant duplicate: the socket is pid-keyed
  // (spawner-socket-path.ts), so once the owning host dies its sidecar can never be
  // addressed again — a corpse holding RAM, observed to 403h/16.8 days.
  //
  // Registered BEFORE the already-running early return, so a second entry point that
  // finds a live child still ensures the hooks exist. Idempotent by label, so the
  // remaining call-site calls are harmless no-ops.
  registerSpawnerSidecarShutdownHooks();

  if (sidecarProcess) {
    // Already running
    if (sidecarReady) return;
    // Wait for ready
    return new Promise((resolve) => {
      readyWaiters.push(resolve);
    });
  }

  // See `spawnInFlight` — a spawn that has passed the check above but not yet
  // assigned `sidecarProcess`. Join it rather than starting a second one.
  //
  // ⚠ The check above and the assignment below MUST stay in the same synchronous
  // tick. Do not `await` between them — that is the exact re-entrancy window
  // EI-19479764372783341 closed, and re-opening it lets two concurrent callers each
  // spawn a sidecar. The cross-process adoption probe below is async and therefore
  // lives INSIDE the guarded promise, not before it. (Caught by
  // spawner-sidecar-cgroup-confinement.test.ts's "exactly ONE sidecar" guard when
  // this was first written the other way round.)
  if (spawnInFlight) return spawnInFlight;

  spawnInFlight = (async () => {
    // ── CROSS-PROCESS ADOPTION (plan spawner-sidecar-cluster-fanout-2026-08-12) ──
    //
    // Every in-process guard is MODULE-scoped: `sidecarProcess` and `spawnInFlight`
    // can only see spawns made by THIS process. Under `node:cluster` that is not the
    // relevant scope. Each of N workers is a separate process with its own fresh
    // `sidecarProcess = null`, so each independently concluded it had to spawn a
    // sidecar — and a sidecar is a full `hono-host.mjs`. Measured 2026-08-12 at
    // PAPERCUSP_CLUSTER=16: 16 sidecars, 9.5GB, 0.004 cores each. The in-process
    // guards were working perfectly; they were answering about the wrong population.
    //
    // With the path pinned across the fork (pinSpawnerSocketForCluster) all workers
    // resolve the SAME socket, so a live listener means a sibling already did this
    // work and we ADOPT it. `getSpawnerIpcClient` dials that same path, so an
    // adopting worker is fully functional with no child of its own.
    //
    // A connect probe, not `existsSync`: a stale socket FILE routinely outlives its
    // server here (that is what the reaper exists for), so presence proves nothing.
    const probeSocket = socketPath ?? resolveSpawnerSocketPath();
    if (await probeUnixSocketAlive(probeSocket)) {
      adoptedSocketPath = probeSocket;
      return;
    }
    return spawnSpawnerSidecarInner(socketPath);
  })().finally(() => {
    spawnInFlight = null;
  });
  return spawnInFlight;
}

/** The actual spawn. Split out of `spawnSpawnerSidecar` only so the in-flight
 *  guard above can wrap exactly one attempt. */
async function spawnSpawnerSidecarInner(socketPath?: string): Promise<void> {
  // A fresh spawn attempt — clear any pending backoff timer and the deliberate-stop
  // flag so the crash-respawn machinery is armed for this (re)spawn (mirrors
  // substrate-sidecar-spawn.ts's reset at the top of spawnSubstrateSidecar).
  deliberateStop = false;
  gaveUp = false;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }

  const sidecarScript = path.join(
    // 4 levels up from packages/operator-core/lib/fleet/ → repo root,
    // then apps/operator/bin/.
    moduleDir,
    '../../../../apps/operator/bin/spawner-sidecar.ts',
  );

  // Resolve the IPC socket ONCE and pin it in process.env so the parent IPC
  // client (getSpawnerIpcClient) and the spawned child resolve the SAME absolute
  // path. NEVER CWD-relative: a relative `.papercusp` mkdir is EACCES from a
  // packaged root-owned CWD → the spawn would fail and silently fall back to
  // in-process (the P-006 substrate finding).
  const resolvedSocket = socketPath ?? resolveSpawnerSocketPath();
  process.env[SPAWNER_SOCKET_ENV] = resolvedSocket;
  const socketDir = path.dirname(resolvedSocket);
  if (!fs.existsSync(socketDir)) {
    fs.mkdirSync(socketDir, { recursive: true });
  }

  // Spawn target. esbuild bundles EVERY module into the single serve.mjs, so in a
  // PACKAGED build import.meta.url here IS serve.mjs — re-exec that artifact under
  // the bundled node with PAPERCUSP_SPAWNER_SIDECAR_MODE=1 (serve.ts diverts to
  // runSpawnerSidecarServer). In DEV (tsx, real source tree) run the .ts entry via
  // tsx.
  const selfPath = fileURLToPath(import.meta.url);
  const plan = resolveSidecarSpawnPlan({
    selfPath,
    devScriptPath: sidecarScript,
    bundledModeEnvVar: 'PAPERCUSP_SPAWNER_SIDECAR_MODE',
    bundledScriptName: 'spawner-sidecar.mjs',
    execPath: process.execPath,
    spawnerPid: process.pid,
  });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...plan.env,
    [SPAWNER_SOCKET_ENV]: resolvedSocket,
    // EI-8810 belt: the sidecar serves over the Unix socket ONLY — never hand
    // the child the parent's HTTP port or the background-worker role. A
    // mode-divert miss in the re-exec'd entry (the exact hono-host.mjs bug)
    // otherwise boots a full host on the PARENT's own port (EADDRINUSE
    // crash-respawn loop) and could double-run the single-writer background
    // machinery (EI-126). Port 0 = ephemeral bind if some entry ever listens.
    PAPERCUSP_HONO_PORT: '0',
    PORT: '0',
    PAPERCUSP_BACKGROUND_WORKERS: '0',
    // WI-6132 (P-016, db-performance-remediation): cap the sidecar's org pools.
    // The sidecar's PG traffic is a handful of spawn-RPC lookups, but without a
    // cap it opens its OWN admin+app pool at full resource-profile size — and
    // sidecars dominate the census (measured 2026-08-02: 28 of 39 per-process
    // org-admin pools on this box were sidecars; 198 connections, 169 idle).
    // Pinned unconditionally — the parent's own PAPERCUSP_DB_POOL_MAX is sized
    // for the OPERATOR's concurrency and must not leak into the child;
    // PAPERCUSP_SIDECAR_DB_POOL_MAX is the deliberate escape hatch.
    PAPERCUSP_DB_POOL_MAX: process.env.PAPERCUSP_SIDECAR_DB_POOL_MAX ?? '2',
  };

  const cmd = plan.cmd;
  const args = plan.args;

  // ── EI-19479764372783341: CGROUP LIFETIME COUPLING ────────────────────────
  //
  // This used to be a raw `spawn(cmd, args, { detached: false })`, which inherits
  // the CALLER's cgroup. That put the spawner sidecar — and the desktop-app
  // `serve.mjs` sidecars it goes on to parent — inside
  // `papercup-bg-host.service`, so restarting bg-host to pick up ANY routines
  // code change killed the lot. Measured 2026-08-04: ~208 tasks in that cgroup,
  // including 4x spawner-sidecar, 5x desktop serve.mjs, and an in-flight
  // `pg_dump` mid-write. All three restart triggers hit it — a raw `systemctl
  // restart`, `dev:restart { target:'bg-host' }` (whose "drain" is a LOCK drain
  // with no notion of cgroup children), and bghost-watchdog.mjs firing
  // UNATTENDED on a detected stall, which has a documented history of FALSE
  // positives and alerts nobody on a SINGLE successful restart.
  //
  // `managedSpawn` confines into a transient `pc-<taskId>.scope` under
  // `papercusp-sidecar.slice` via `systemd-run --user --scope`. That scope is a
  // SIBLING of papercup-bg-host.service rather than a child, so a bg-host
  // restart now bounces only bg-host. It also enrols the process in the task
  // ledger, which is what makes it killable via `processes:kill { taskId }`
  // instead of a `pkill -f` that has twice taken out the owner's live desktop.
  //
  // Note this site never tripped `lint:no-unenrolled-spawn`: that guard keys on
  // `detached: true`, and this is `detached: false`, so it was invisible to it BY
  // CONSTRUCTION. Detachment is the wrong property — the hazard is cgroup
  // lifetime coupling, which a long-lived `detached: false` child has in full.
  // Filed as EI-19483245448673321.
  //
  // Two properties this depends on, both verified in isolation before the change
  // (same ['ignore','pipe','pipe','ipc'] stdio shape as below): `--scope` (not
  // `--unit`) execs in the caller's context and KEEPS piped stdio, so the
  // PAPERCUSP_SPAWNER_READY handshake still arrives on the child's stdout —
  // measured 150ms scoped vs 111ms unscoped against a 10s budget, with the IPC
  // channel intact and the child landing in a sibling scope. And `managedSpawn`
  // FAILS SOFT: if systemd cannot give it a scope, `probeScopeSupport` returns
  // `{ok:false}` and it degrades to a plain spawn with `confinementSkippedReason`
  // set, so a box without working user scopes still gets a sidecar — unconfined,
  // exactly as before. It cannot hard-fail the agent-spawn path.
  //
  // 'ipc' as the 4th stdio slot opens the Node child_process IPC channel,
  // mirroring the substrate sidecar's spawn shape (harmless here — the spawner
  // sidecar talks over the Unix socket, not the handle channel).
  const taskId = newTaskId();
  // This is a launch identity, not a scope guessed from inherited membership.
  // The server only advertises it if /proc confirms confinement actually worked.
  env[SPAWNER_SCOPE_ENV] = scopeUnitForTask(taskId);
  const managed = await managedSpawn(
    cmd,
    args,
    {
      class: 'sidecar',
      title: 'fleet spawner sidecar',
      argv: [cmd, ...args],
      launchedBy: 'system:spawner-sidecar',
      detail: { socketPath: resolvedSocket },
    },
    {
      taskId,
      spawnOptions: {
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        detached: false,
      },
    },
  );
  sidecarProcess = managed.child;
  sidecarScopeUnit = managed.scopeUnit;
  // Warn ONCE per process, not per spawn. Scope support is probed once and cached,
  // so this condition is constant for the process lifetime — repeating it on every
  // lazy spawn and every crash-respawn (up to 5 in 5 minutes) would bury the one
  // line that matters under its own repetition.
  // ...and NOT under a test runner (EI-20006410617437313). This is an operator-
  // runtime diagnostic — it tells a human that a bg-host restart will take the
  // sidecar with it. A test never sets up or asserts on confinement: it depends
  // on ambient host state (the task manager is disabled on most boxes), so the
  // SAME COMMIT warns or stays quiet depending on the machine, and
  // `vitest-fail-on-console` converts that ambient condition into a test failure.
  // Because the latch above is MODULE-SCOPED the victim is just the first file in
  // the worker to touch this path — measured red-ing `scout/observation-consumption-
  // wiring.test.ts`, which has nothing to do with sidecars. That misattribution is
  // why the same symptom was filed SIX times (EI-19969730160803690,
  // EI-19973369415259261, EI-20000079246831498, EI-20005899247570051, WI-37487,
  // EI-20006410617437313) — each triager saw a different innocent victim file.
  // The fix is a CHANNEL change, not suppression: `vitest-fail-on-console` polices
  // console.warn/error and ignores console.log, so emitting the identical message
  // on log under test keeps it visible in the run output — and, critically, keeps
  // it ASSERTABLE. spawner-sidecar-spawn.test.ts deliberately covers the
  // exactly-once latch ("says so, exactly once, when the sidecar lands
  // UNCONFINED"); silencing it under test would have destroyed that coverage while
  // looking like a fix. The message, the latch and the operator-runtime channel
  // are all unchanged.
  const underTestRunner = Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';
  if (!managed.confined && !warnedUnconfined) {
    warnedUnconfined = true;
    const emit = underTestRunner ? console.log : console.warn;
    emit(
      `[spawner-sidecar] UNCONFINED (${managed.confinementSkippedReason ?? 'unknown reason'}) — ` +
        "it shares bg-host's cgroup, so a bg-host restart will kill it and the desktop sidecars it parents (EI-19479764372783341).",
    );
  }

  const child = sidecarProcess;
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!sidecarReady && sidecarProcess) {
        // EI-20200233989444731: kill the SCOPE first. This path then drops the only
        // reference we hold (`sidecarProcess = null`), so a payload that survived a
        // client-only signal here would be orphaned with nothing left to stop it —
        // a live process in a scope no ledger row claims, i.e. the "unaccounted
        // cgroup" the task-manager alarm reports. A sidecar that missed its 10s
        // handshake is exactly the case most likely to still be mid-startup.
        killOwnedScope(sidecarScopeUnit);
        sidecarProcess.kill();
        sidecarProcess = null;
        sidecarScopeUnit = null;
      }
      reject(new Error('Spawner sidecar startup timeout'));
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
        console.log('[spawner-sidecar]', line);

        if (line.includes('PAPERCUSP_SPAWNER_READY')) {
          sidecarReady = true;
          clearTimeout(timeout);
          // A sidecar is long-lived while its host is alive, but it must not
          // be the last referenced handle keeping a short-lived diagnostic
          // process alive. Drop the child and its handshake pipes from the
          // parent's event loop after readiness; the exit hook below still
          // signals it when the host exits.
          child.unref?.();
          (child.stdout as unknown as { unref?: () => void } | null)?.unref?.();
          (child.stderr as unknown as { unref?: () => void } | null)?.unref?.();
          (child.channel as unknown as { unref?: () => void } | null)?.unref?.();
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
      const text = chunk.toString().trim();
      // BIND-RACE LOSER (plan spawner-sidecar-cluster-fanout-2026-08-12, P-003).
      //
      // The adoption probe closes the common case, but it cannot close the window
      // between "probe found nothing" and "our child finished binding": with the
      // socket path now SHARED across cluster workers, two workers can both probe an
      // empty path and both spawn. Exactly one wins the bind; the other's child dies
      // EADDRINUSE. That is a SUCCESS for the cluster — a sidecar is now serving the
      // shared path — so treating it as a crash is doubly wrong: it logs a scary
      // error for a healthy outcome, and it burns the respawn budget re-losing the
      // same race (EI-19982828461130670 recorded exactly this EADDRINUSE killing the
      // sidecar). Mark it deliberate so the `exit` handler below neither warns nor
      // schedules a respawn, and record the adoption.
      if (text.includes('EADDRINUSE')) {
        deliberateStop = true;
        adoptedSocketPath = resolvedSocket;
        console.log(
          `[spawner-sidecar] lost the bind race for ${resolvedSocket} — a sibling is serving it; adopting theirs.`,
        );
        return;
      }
      console.warn('[spawner-sidecar-err]', text);
    });

    child.on('error', (err) => {
      sidecarProcess = null;
      sidecarScopeUnit = null;
      sidecarReady = false;
      reject(err);
    });

    child.on('exit', (code) => {
      // The child found a LIVE sidecar on the shared path and declined to start
      // (listenUnixSocketExclusive). Same outcome as the stderr bind-race case above,
      // read off the exit code because this event can arrive before that stderr line.
      if (code === SIDECAR_EXIT_SOCKET_IN_USE && !adoptedSocketPath) {
        deliberateStop = true;
        adoptedSocketPath = resolvedSocket;
        console.log(`[spawner-sidecar] a live sidecar already serves ${resolvedSocket}; adopting it.`);
      }
      const msg = code !== null ? `exit code ${code}` : 'killed';
      // A deliberate stopSpawnerSidecar() is a graceful shutdown, not a crash —
      // "died" here would be misleading noise (mirrors substrate's same guard).
      if (!deliberateStop) {
        console.warn(`[spawner-sidecar] died (${msg})`);
      }
      sidecarProcess = null;
      sidecarScopeUnit = null;
      sidecarReady = false;

      // Bind-race loser: our child exited because a SIBLING already owns the shared
      // socket, which the stderr handler above detected and recorded. The awaited
      // handshake will now never arrive, so settle the promise HERE rather than let
      // it sit until the 10s startup timeout and reject — the sidecar this caller
      // asked for does exist, it simply belongs to a sibling. Without this, a losing
      // worker reports "Spawner sidecar startup timeout" 10s later and degrades its
      // agent-spawn path for a condition that is actually success.
      if (adoptedSocketPath) {
        clearTimeout(timeout);
        resolve();
        for (const waiter of readyWaiters) waiter();
        readyWaiters.length = 0;
        return;
      }

      scheduleRespawn(resolvedSocket);
    });
  });
}

/**
 * Check if the sidecar is running.
 */
export function isSpawnerSidecarRunning(): boolean {
  return !!sidecarProcess && !sidecarProcess.killed;
}

/**
 * The live sidecar child process, or null when not spawned.
 */
export function getSpawnerSidecarProcess(): ChildProcess | null {
  if (!sidecarProcess || sidecarProcess.killed) return null;
  return sidecarProcess;
}

/** Test seam — inject a fake sidecar ChildProcess without spawning the real
 *  `npx tsx` child. Pass null to reset. */
export function _setSpawnerSidecarProcessForTests(proc: ChildProcess | null): void {
  sidecarProcess = proc;
  sidecarReady = !!proc;
}

/**
 * Kill the sidecar gracefully.
 */
export async function stopSpawnerSidecar(): Promise<void> {
  // An ADOPTED sidecar belongs to a sibling process that is very likely still using
  // it — dropping our client reference is the only correct "stop" here. Killing it
  // would take out a sidecar we do not own. The `!sidecarProcess` return below
  // already achieves that (an adopter holds no child); clearing the flag is what
  // lets a later spawnSpawnerSidecar() re-probe instead of believing it still has one.
  adoptedSocketPath = null;
  if (!sidecarProcess || sidecarProcess.killed) return;
  deliberateStop = true;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  const proc = sidecarProcess;
  killOwnedScope(sidecarScopeUnit);
  await gracefulStopChild(proc, { timeoutMs: 5000, kill: (sig) => proc.kill(sig) });
  sidecarProcess = null;
  sidecarScopeUnit = null;
  sidecarReady = false;
}

/**
 * EI-24863236643374267: SYNCHRONOUS stop, run by the host's before-exit hook
 * (shutdown-state onBeforeHostExit → host-recycle exitOnce). The host exits by
 * SIGKILLing itself right after, so this cannot await gracefulStopChild's SIGKILL
 * escalation: it signals the owned scope and the child, and the sidecar's own
 * SIGTERM handling (plus its owner-PID watchdog, WI-10002859) finishes the job.
 */
export function stopSpawnerSidecarAtHostExit(): void {
  adoptedSocketPath = null;
  if (!sidecarProcess || sidecarProcess.killed) return;
  deliberateStop = true;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  const proc = sidecarProcess;
  killOwnedScope(sidecarScopeUnit);
  try {
    proc.kill('SIGTERM');
  } catch {
    /* already gone */
  }
}

/**
 * Register graceful shutdown hooks.
 *
 * EI-24863236643374267: when this process has a graceful drain armed
 * (installGracefulShutdown), SIGTERM/SIGINT no longer stop the sidecar up front —
 * measured 2026-10-02 11:49:26-33Z on bg-host, that sent every git call made during
 * the ~10 s drain to a 256-512 ms main-thread fork. The sidecar now serves through
 * the drain and is stopped by the before-exit hook. Processes without that drain
 * (cluster primary, short-lived CLIs) keep the immediate stop.
 */
export function registerSpawnerSidecarShutdownHooks(): void {
  onBeforeHostExit('spawner-sidecar-spawn', stopSpawnerSidecarAtHostExit);
  registerSharedSidecarShutdownHooks({
    label: 'spawner-sidecar-spawn',
    mode: 'async-with-exit',
    stop: () => stopSpawnerSidecar(),
    deferStopToHostExit: isGracefulDrainInstalled,
    // P-006: only tear down the sidecar for an uncaughtException that is
    // ACTUALLY fatal to the host — one hono-host's own guard does NOT already
    // swallow. Otherwise every benign client-disconnect `write EPIPE` kills a
    // healthy sidecar and the next caller warm-respawns it (the observed
    // ~6min "DHT bootstrap" churn).
    isFatalException: (err) => !isBenignHostError(err),
  });
}

/** Test seam — reset the module-global respawn state between unit tests. */
export function _resetSpawnerSidecarSpawnStateForTests(): void {
  deliberateStop = false;
  gaveUp = false;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  respawnAttempts = [];
  sidecarProcess = null;
  sidecarScopeUnit = null;
  sidecarReady = false;
  readyWaiters.length = 0;
  // Same reasoning as `spawnInFlight` below: an adoption left set by a prior test
  // makes the next spawnSpawnerSidecar() return early having spawned nothing, so a
  // later "spawn called 0 times" assertion would pass for the wrong reason.
  adoptedSocketPath = null;
  // Must be cleared with the rest: an attempt left in flight by a prior test
  // would be RETURNED to the next caller instead of spawning, so every later
  // assertion reads "spawn called 0 times" for a reason that is not the subject.
  spawnInFlight = null;
  warnedUnconfined = false;
}

/**
 * P-006: node-child supervision status for `dev:service_health`'s additive
 * `supervision` block — mirrors `substrateSidecarSupervisionStatus()`
 * (sync/hyperbee/substrate-sidecar-spawn.ts). PURE given the module's own
 * in-memory state (no I/O), safe to call on every request.
 */
export interface SpawnerSidecarSupervisionStatus {
  running: boolean;
  respawnAttemptsInWindow: number;
  gaveUp: boolean;
  lastRespawnScheduledAt: number | null;
}

export function spawnerSidecarSupervisionStatus(now: number = Date.now()): SpawnerSidecarSupervisionStatus {
  const attempts = pruneRespawnWindow(respawnAttempts, now, RESPAWN_WINDOW_MS);
  return {
    running: !!sidecarProcess && !sidecarProcess.killed,
    respawnAttemptsInWindow: attempts.length,
    gaveUp,
    lastRespawnScheduledAt: attempts.length ? attempts[attempts.length - 1] : null,
  };
}
