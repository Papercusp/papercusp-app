/**
 * Substrate boot wrapper — conditionally uses IPC or in-process, and starts the
 * LAZY_SUBSTRATE_BOOT eviction reaper.
 *
 * Two independent feature gates ride here:
 *
 *  - LAZY_SUBSTRATE_BOOT (P-008, WI-596): after the in-process boot, start the
 *    eviction reaper so idle INERT private harness engines are torn down to bound
 *    operator RSS sub-linearly in harness count. OFF ⇒ the reaper never starts;
 *    boot is byte-identical to eager all-harness boot.
 *
 *  - SUBSTRATE_SIDECAR (P-009/WI-604): Option B "replication-offload". The
 *    sidecar owns the full per-harness substrate engine (Corestore + own-log +
 *    merge/projection loop + swarm/admission + outbox/presence send-side). The
 *    main process caches `RemoteBootedHarnessHandle` proxies and routes append /
 *    control calls over IPC. OFF (the default) remains byte-identical in-process.
 */

import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import {
  spawnSubstrateSidecar,
  registerSidecarShutdownHooks,
  stopSubstrateSidecar,
  onSidecarRespawned,
} from './substrate-sidecar-spawn';
import { getSubstrateIpcClient } from './substrate-ipc-client';
import { RemoteBootedHarnessHandle } from './remote-booted-harness';
import {
  bootAllHarnessesForActiveWorkspace,
  closeInProcessBootedHarnesses,
  enableSubstrateEvictionTracking,
  gatherBootedHarnessFacts,
  evictBootedHarnessEngine,
  setSubstrateBootDefaults,
  reconcileRemoteHandlesAfterSidecarRestart,
} from './boot-all';
import {
  startSubstrateEvictionReaper,
  type SubstrateEvictionReaper,
} from './substrate-eviction-reaper';
import {
  startSubstrateOutboxKeepalive,
  type OutboxKeepaliveHandle,
} from './substrate-outbox-keepalive';
import { createPgMergeCursorStore } from './pg-merge-cursor-store';
import type { BootedAnnounceIdentity, BootHarnessOpts } from './boot';

export interface BootSubstrateOpts {
  perHarnessTimeoutMs?: number;
}

export interface BootSubstrateResult {
  attempted: number;
  booted: number;
  alreadyBooted: number;
  failed: number;
  /** P-010: harnesses the activation policy left dark (wake on demand). */
  deferred: number;
  results: Array<{
    workspaceId: string;
    harnessSlug: string;
    state: 'booted' | 'already-booted' | 'failed' | 'deferred';
    error?: string;
    deferReason?: 'inactive';
  }>;
  usedSidecar: boolean;
  /** Whether the LAZY_SUBSTRATE_BOOT eviction reaper was started this boot. */
  evictionReaperStarted: boolean;
  /** Whether the LAZY_SUBSTRATE_BOOT outbox NOTIFY keepalive was started this boot. */
  outboxKeepaliveStarted: boolean;
}

/** Module singleton — one reaper per process; never started twice. */
let reaper: SubstrateEvictionReaper | null = null;

/** Module singleton — one keepalive listener per process. */
let keepalive: OutboxKeepaliveHandle | null = null;

/**
 * Optional operational timing overrides for bounded physical/chaos drills.
 * Production keeps the reaper's own defaults when these are absent. Invalid
 * values are ignored rather than turning a diagnostic override into a boot
 * failure or a zero-delay busy loop.
 */
function positiveEnvMs(name: string): number | undefined {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** WI-1877: register the post-respawn reconcile hook at most once per process
 *  (spawnSubstrateSidecar's respawn machinery is itself a module singleton, so
 *  double-registering here would re-boot every remote harness twice per respawn). */
let respawnReconcileRegistered = false;
function ensureSidecarRespawnReconcileRegistered(): void {
  if (respawnReconcileRegistered) return;
  respawnReconcileRegistered = true;
  onSidecarRespawned(() => {
    void reconcileRemoteHandlesAfterSidecarRestart().catch((e) => {
      console.error(
        '[substrate-boot] post-respawn reconcile threw (harnesses may still be dark on the new sidecar):',
        e instanceof Error ? e.message : String(e),
      );
    });
  });
}

/** Test seam — allow re-registering the respawn hook between unit tests. */
export function _resetSidecarRespawnReconcileRegistrationForTests(): void {
  respawnReconcileRegistered = false;
}

/**
 * Start the LAZY_SUBSTRATE_BOOT eviction reaper if the flag is ON and it isn't
 * already running. Returns whether the reaper is now active. Best-effort: a
 * failure to start never fails boot.
 */
export async function maybeStartSubstrateEvictionReaper(): Promise<boolean> {
  if (reaper) return true;
  let on = false;
  try {
    on = await getFlag(FLAGS.LAZY_SUBSTRATE_BOOT, 'system');
  } catch {
    on = false; // fail-closed: a flag-read error keeps eager behavior
  }
  if (!on) return false;
  try {
    enableSubstrateEvictionTracking();
    const intervalMs = positiveEnvMs('PAPERCUSP_SUBSTRATE_EVICTION_INTERVAL_MS');
    const idleMs = positiveEnvMs('PAPERCUSP_SUBSTRATE_EVICTION_IDLE_MS');
    reaper = startSubstrateEvictionReaper({
      gatherFacts: (now) => gatherBootedHarnessFacts(now),
      evict: (key, guard) => evictBootedHarnessEngine(key, guard),
      ...(intervalMs == null ? {} : { intervalMs }),
      ...(idleMs == null ? {} : { idleMs }),
    });
    registerEvictionReaperShutdown();
    console.log('[substrate-boot] LAZY_SUBSTRATE_BOOT eviction reaper started');
    // Start the outbox NOTIFY keepalive (re-boot-on-NOTIFY, AC#2).
    try {
      const { sql } = (await import('@papercusp/db-org')).getOrgPg();
      keepalive = startSubstrateOutboxKeepalive(sql);
      console.log('[substrate-boot] outbox NOTIFY keepalive (re-boot-on-NOTIFY) started');
    } catch (e) {
      console.warn(
        '[substrate-boot] outbox keepalive startup failed (re-boot-on-NOTIFY disabled):',
        e instanceof Error ? e.message : String(e),
      );
    }
    return true;
  } catch (e) {
    console.warn(
      '[substrate-boot] failed to start eviction reaper (continuing eager):',
      e instanceof Error ? e.message : String(e),
    );
    reaper = null;
    return false;
  }
}

let reaperShutdownRegistered = false;
function registerEvictionReaperShutdown(): void {
  if (reaperShutdownRegistered) return;
  reaperShutdownRegistered = true;
  const stop = (): void => {
    try {
      reaper?.stop();
    } catch {
      // best-effort
    }
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

/** Stop the reaper (tests + shutdown). Idempotent. */
export function stopSubstrateEvictionReaper(): void {
  try {
    reaper?.stop();
    keepalive?.stop().catch(() => {});
  } finally {
    reaper = null;
    keepalive = null;
  }
}

/**
 * Boot substrate — via IPC sidecar if the (dark) SUBSTRATE_SIDECAR flag is ON,
 * else in-process — then start the LAZY_SUBSTRATE_BOOT reaper.
 */
export async function bootSubstrateWithFallback(
  opts?: BootSubstrateOpts,
): Promise<BootSubstrateResult> {
  const useSidecar = await getFlag(FLAGS.SUBSTRATE_SIDECAR, 'system').catch(() => false);
  // WI-3297 (flag-gated, default ON — the same gate substrate-sidecar-host reads):
  // durable PG merge-cursor for IN-PROCESS engines, so a packaged install (no
  // sidecar) resumes each admitted log's fold across restarts instead of
  // re-folding the whole seed log from 0 every boot. Installed process-globally
  // so standalone bootSingleHarness/rekeyHarness boots get it too; the sidecar
  // branch clears it (the sidecar host constructs its own on its side).
  const mergeCursorStoreFactory = (await getFlag(FLAGS.SUBSTRATE_MERGE_CURSOR_PG, 'system').catch(
    () => true,
  ))
    ? createPgMergeCursorStore
    : null;

  const finish = async (
    r: Awaited<ReturnType<typeof bootAllHarnessesForActiveWorkspace>>,
    usedSidecar: boolean,
  ): Promise<BootSubstrateResult> => {
    const evictionReaperStarted = await maybeStartSubstrateEvictionReaper();
    return { ...r, usedSidecar, evictionReaperStarted, outboxKeepaliveStarted: keepalive !== null };
  };

  if (!useSidecar) {
    // Flag OFF (the default + correct state): in-process boot, then the reaper.
    // Clear any sidecar boot defaults so standalone bootSingleHarness/rekeyHarness
    // boot in-process + wire the drain in-process (the byte-identical default path).
    setSubstrateBootDefaults({ bootHarness: null, skipSendSideWiring: false, mergeCursorStoreFactory });
    const result = await bootAllHarnessesForActiveWorkspace(opts);
    return finish(result, false);
  }

  try {
    console.log('[substrate-boot] SUBSTRATE_SIDECAR on: spawning sidecar for relocated substrate boot');
    await spawnSubstrateSidecar();
    registerSidecarShutdownHooks();
    // WI-1877: arm the post-respawn reconcile BEFORE the first boot sweep below —
    // a crash-respawn minutes from now must re-register every harness this
    // process ends up caching, not just ones booted after this line.
    ensureSidecarRespawnReconcileRegistered();
    const client = getSubstrateIpcClient();
    await client.call('sidecar:healthz');
    // The remote (sidecar) boot factory. Bootstrap-sweep AND every standalone
    // boot route must use it — see setSubstrateBootDefaults below.
    const sidecarBootHarness = async (bootOpts: BootHarnessOpts) => {
      const booted = await client.call<{
        storeId: string;
        ownLogKey: string;
        ownLogLength?: number;
        // WI-2142873: the sidecar owns the swarm, so it owns the identity peers
        // file our socket under. Carrying it back is what lets the git-sync hive
        // legs sign as the device that actually serves this pot's topic.
        announceIdentity?: BootedAnnounceIdentity | null;
      }>('substrate:bootHarness', {
        workspaceRoot: bootOpts.workspaceRoot,
        workspaceId: bootOpts.workspaceId,
        harnessSlug: bootOpts.harnessSlug,
        swarmBinding: bootOpts.swarmBinding ?? null,
      });
      return new RemoteBootedHarnessHandle({
        workspaceId: bootOpts.workspaceId,
        harnessSlug: bootOpts.harnessSlug,
        storeId: booted.storeId,
        ownLogKey: booted.ownLogKey,
        ownLogLength: booted.ownLogLength,
        announceIdentity: booted.announceIdentity ?? null,
        client,
      });
    };
    // Register the sidecar boot config PROCESS-GLOBALLY so EVERY boot path routes
    // through the sidecar — not just this bootstrap sweep. Without this, a
    // standalone rekeyHarness/bootSingleHarness (owner publishCreatedHive, joiner
    // joinHiveAsView/join-shared-harness) for a harness created AFTER bootstrap
    // booted IN-PROCESS, so the sidecar never wired its outbox drain → content
    // captured + peer_connected but federation = 0 (the live cross-machine bug).
    setSubstrateBootDefaults({
      bootHarness: sidecarBootHarness,
      skipSendSideWiring: true,
      mergeCursorStoreFactory: null,
    });
    // WI-2105: tear down any engine that raced in-process before this decision
    // (see markSubstrateBootRoutingPending) so the sweep re-boots it via the
    // sidecar — left alive it is a SECOND concurrent substrate instance whose
    // announcer/drainer races the sidecar's (the tower↔VM federation outage).
    const tookOver = await closeInProcessBootedHarnesses();
    if (tookOver.length > 0) {
      console.warn(
        `[substrate-boot] closed ${tookOver.length} in-process engine(s) booted before sidecar routing decided: ${tookOver.join(', ')}`,
      );
    }
    const result = await bootAllHarnessesForActiveWorkspace({
      ...opts,
      skipSendSideWiring: true,
      bootHarness: sidecarBootHarness,
    });
    return finish(result, true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[substrate-boot] sidecar spawn failed, falling back to in-process:', msg);
    // WI-900 (M4): this catch also covers a PARTIAL mid-boot failure — the sidecar
    // spawned + passed healthz, `bootAllHarnessesForActiveWorkspace` ran routed
    // through it (line ~203 above), and some harnesses booted successfully via the
    // sidecar (opening their corestores THERE, under its exclusive per-path file
    // lock) before a later harness's boot call threw. Without stopping the
    // still-alive sidecar first, this in-process retry re-runs
    // bootAllHarnessesForActiveWorkspace for EVERY harness (including the ones the
    // sidecar already has open) — those corestore paths are lock-held by the
    // sidecar process, so the in-process open fails too: the harness boots in
    // NEITHER process. Stop the sidecar (idempotent no-op if it never spawned /
    // already exited) so it releases every lock it holds BEFORE the in-process
    // fallback tries to reacquire them.
    await stopSubstrateSidecar().catch((e) => {
      console.warn(
        '[substrate-boot] stopSubstrateSidecar during fallback failed (continuing anyway):',
        e instanceof Error ? e.message : String(e),
      );
    });
    // Sidecar unavailable → clear the defaults so standalone boots use in-process.
    setSubstrateBootDefaults({ bootHarness: null, skipSendSideWiring: false, mergeCursorStoreFactory });
    const result = await bootAllHarnessesForActiveWorkspace(opts);
    return finish(result, false);
  }
}
