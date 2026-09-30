/**
 * substrate-eviction-reaper.ts — the LAZY_SUBSTRATE_BOOT wiring (WI-596 /
 * operator-memory-and-psu-resilience-2026-06-14 P-008, D-004/D-005/D-006).
 *
 * The pure decision brain lives in `substrate-eviction-policy.ts`
 * (`planSubstrateEviction`). This module is the thin, best-effort REAPER LOOP
 * that, on a cadence, gathers each booted harness's liveness facts, asks the
 * policy which engines to evict, and tears those engines down — bounding
 * operator RSS sub-linearly in harness count (~108 MB/harness today, D-002).
 *
 * ── v1 SAFETY BOUNDARY (the reason this is safe to ship ON) ──
 * The caller's fact-gatherer (`gatherBootedHarnessFacts` in boot-all.ts) marks
 * any harness with a LIVE SWARM (`handle.swarm != null`) or admitted remote
 * peers as `pinned`, so the policy NEVER evicts it. Only INERT private
 * (swarm-less, peerless) harness engines are eviction candidates. A private
 * harness's substrate merges nothing (no peers) and its local writes are
 * PG-direct, so tearing its engine down loses no federation state and risks no
 * cross-machine divergence (the EI-126 class). The harder case — evicting an
 * idle SHARED harness while keeping a lightweight swarm-presence keepalive so a
 * later peer still re-boots it (D-004) — is the documented v2 and is explicitly
 * OUT of v1's eviction set.
 *
 * The whole loop is FLAG-GATED + best-effort: when LAZY_SUBSTRATE_BOOT is OFF
 * the reaper never starts (boot is byte-identical to eager all-harness boot),
 * and a throwing tick/evict is swallowed so the reaper can never destabilise the
 * operator.
 */

import {
  planSubstrateEviction,
  type BootedHarnessFacts,
  type EvictionDecision,
} from './substrate-eviction-policy';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';

/** Default reaper tick cadence (ms): re-evaluate the resident set every minute. */
export const DEFAULT_REAPER_INTERVAL_MS = 60_000;
/** Default idle window (ms): a harness touched within 30 min is HOT (never
 *  evicted). Deliberately generous — an evicted engine pays a re-boot on its
 *  next access, so we only reclaim genuinely-cold engines. */
export const DEFAULT_REAPER_IDLE_MS = 30 * 60_000;
/** Default LRU cap among idle candidates. 0 ⇒ evict EVERY idle (inert) private
 *  engine — they merge nothing, so there is no reason to keep any resident. */
export const DEFAULT_REAPER_MAX_RESIDENT = 0;

export interface SubstrateEvictionReaperOpts {
  /** Reaper tick cadence (ms). Default {@link DEFAULT_REAPER_INTERVAL_MS}. */
  intervalMs?: number;
  /** Idle window (ms) — engines accessed within it are HOT. Default {@link DEFAULT_REAPER_IDLE_MS}. */
  idleMs?: number;
  /** Keep at most this many idle candidates resident (LRU). Default {@link DEFAULT_REAPER_MAX_RESIDENT}. */
  maxResident?: number;
  /** Gather the current booted set's eviction facts. Injected by the caller
   *  (boot-all's `gatherBootedHarnessFacts`) — owns the v1 pinned boundary. */
  gatherFacts: (now: number) => BootedHarnessFacts[];
  /** Tear down ONE engine by its handle-map key. Returns whether it actually
   *  evicted (a last-moment liveness re-check may skip it). Best-effort: the
   *  caller (boot-all's `evictBootedHarnessEngine`) re-checks freshness +
   *  swarm/peer state right before close to close the access/evict race. */
  evict: (key: string, guard: { now: number; idleMs: number }) => Promise<boolean> | boolean;
  /** Clock seam (test). Default `Date.now`. */
  now?: () => number;
  /** Observability seam (test): called with each tick's decision (after evicts). */
  onTick?: (info: { decision: EvictionDecision; evicted: string[] }) => void;
}

export interface SubstrateEvictionReaper {
  /** Stop the loop + release the timer. Idempotent. */
  stop(): void;
  /** Run one tick by hand (tests). Resolves with the keys actually evicted. */
  tickOnce(): Promise<string[]>;
}

/**
 * Start the eviction reaper loop. The returned handle's `stop()` clears the
 * timer; `tickOnce()` drives a single pass for tests. The interval timer is
 * `unref`'d so it never holds the event loop open on its own. Ticks never
 * overlap (a slow evict skips the next tick) and never throw out.
 */
export function startSubstrateEvictionReaper(
  opts: SubstrateEvictionReaperOpts,
): SubstrateEvictionReaper {
  const intervalMs = opts.intervalMs ?? DEFAULT_REAPER_INTERVAL_MS;
  const idleMs = opts.idleMs ?? DEFAULT_REAPER_IDLE_MS;
  const maxResident = opts.maxResident ?? DEFAULT_REAPER_MAX_RESIDENT;
  const now = opts.now ?? (() => Date.now());

  let stopped = false;
  let running = false;

  async function tickOnce(): Promise<string[]> {
    // Never overlap a previous slow pass.
    if (running) return [];
    running = true;
    const evictedKeys: string[] = [];
    try {
      const t = now();
      const facts = opts.gatherFacts(t);
      const decision = planSubstrateEviction(facts, { now: t, idleMs, maxResident });
      for (const key of decision.evict) {
        try {
          const did = await opts.evict(key, { now: now(), idleMs });
          if (did) evictedKeys.push(key);
        } catch (e) {
          // Best-effort: one engine's failed teardown never aborts the pass.
          console.warn(
            `[substrate-eviction-reaper] evict failed for ${key}:`,
            e instanceof Error ? e.message : String(e),
          );
        }
      }
      try {
        opts.onTick?.({ decision, evicted: evictedKeys });
      } catch {
        // observability must never break the loop
      }
    } catch (e) {
      // A throwing gatherFacts/policy must not kill the reaper.
      console.warn(
        '[substrate-eviction-reaper] tick failed:',
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      running = false;
    }
    return evictedKeys;
  }

  const timer: ManagedHandle | null =
    intervalMs > 0
      ? managedSetInterval('substrate-eviction-reaper', intervalMs, () => {
          if (stopped) return;
          void tickOnce();
        }, { category: 'lifecycle', instanced: true })
      : null;

  return {
    stop() {
      stopped = true;
      if (timer) {
        try {
          timer.stop();
        } catch {
          // no-op
        }
      }
    },
    tickOnce,
  };
}
