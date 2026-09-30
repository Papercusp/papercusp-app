/**
 * substrate-eviction-policy.ts — the PURE decision brain for lazy + bounded
 * harness-substrate boot (WI-147 / operator-memory-and-psu-resilience-2026-06-14
 * P-008, D-004/D-005/D-006). NO I/O: the caller (boot-all's eviction reaper)
 * gathers each booted harness's liveness facts and this module decides which
 * heavy ENGINEs to evict, leaving the lightweight keepalive resident.
 *
 * WHY a separate pure module: the eviction RULE is correctness-critical with
 * fleet-sync blast radius (a wrong eviction silently stops a harness syncing →
 * the EI-126 data-divergence class). Isolating it as a pure, exhaustively-tested
 * function lets the rule be proven WITHOUT booting real corestores/swarms, and
 * keeps the risky wiring (boot-all/outbox-drain) a thin shell around a verified
 * decision. This is the de-risked first slice (D-008 "first staged slice").
 *
 * THE RULE (D-005 correctness constraints):
 *  - NEVER evict a harness that has an ACTIVE swarm peer — it must stay joined +
 *    running the merge driver to RECEIVE that peer's pushes (evicting it = silent
 *    data divergence). This dominates every other signal.
 *  - NEVER evict a PINNED harness (the hive home / active workspace / an explicit
 *    keep) — operationally load-bearing.
 *  - NEVER evict a harness accessed within `idleMs` — it is hot.
 *  - Among the remaining (idle, peerless, unpinned) engines, keep the
 *    `maxResident` most-recently-accessed and evict the rest (LRU). `maxResident`
 *    bounds steady-state RSS independent of harness count (the whole point).
 *
 * The keepalive (swarm presence + a LISTEN substrate_outbox watch) is what makes
 * eviction SAFE — it re-boots the engine on a peer connection or a captured local
 * write, so an evicted harness still drains its outbox + receives peer pushes.
 * This module decides ONLY which engines to evict; the keepalive/re-boot wiring
 * lives in boot-all/outbox-drain (the next staged slice).
 */

/** One booted harness's eviction-relevant liveness facts (gathered by the caller). */
export interface BootedHarnessFacts {
  /** Stable handle-map key (workspace_id|harness_slug). */
  key: string;
  /** Last time something accessed this harness's engine (getOrBoot / drain / merge).
   *  Epoch ms. The LRU + idle signal. */
  lastAccessMs: number;
  /** The harness currently has ≥1 connected swarm peer. If true it is NEVER
   *  evicted (must keep receiving pushes — the D-005 correctness constraint). */
  hasActivePeer: boolean;
  /** Operationally pinned — the hive home, the active workspace's own harness, or
   *  an explicit keep. NEVER evicted. */
  pinned: boolean;
}

export interface EvictionPolicyClock {
  /** Now, epoch ms. */
  now: number;
  /** Engines accessed within this window are HOT — never evicted. */
  idleMs: number;
  /** Keep at most this many idle engines resident (the LRU cap). The hottest
   *  `maxResident` survive; the rest are evicted. 0 ⇒ evict every idle engine. */
  maxResident: number;
}

export interface EvictionDecision {
  /** Handle-map keys whose heavy engine should be torn down (keepalive stays). */
  evict: string[];
  /** Handle-map keys that stay resident, with the reason (for logging/telemetry). */
  keep: Array<{ key: string; reason: 'active-peer' | 'pinned' | 'hot' | 'within-cap' }>;
}

/**
 * Decide which booted harness ENGINEs to evict. Pure + deterministic. The
 * surviving set = every protected harness (active-peer / pinned / hot) PLUS the
 * `maxResident` most-recently-accessed of the remaining idle engines; everything
 * else is evicted.
 */
export function planSubstrateEviction(
  booted: readonly BootedHarnessFacts[],
  clock: EvictionPolicyClock,
): EvictionDecision {
  const evict: string[] = [];
  const keep: EvictionDecision['keep'] = [];
  const maxResident = Math.max(0, Math.floor(clock.maxResident));

  // Partition: protected (never-evict) vs eviction CANDIDATES (idle, peerless,
  // unpinned). Order matters only for the candidate LRU below.
  const candidates: BootedHarnessFacts[] = [];
  for (const h of booted) {
    if (h.hasActivePeer) {
      keep.push({ key: h.key, reason: 'active-peer' });
    } else if (h.pinned) {
      keep.push({ key: h.key, reason: 'pinned' });
    } else if (clock.now - h.lastAccessMs < clock.idleMs) {
      keep.push({ key: h.key, reason: 'hot' });
    } else {
      candidates.push(h);
    }
  }

  // LRU among the idle candidates: keep the `maxResident` most-recently-accessed
  // (newest lastAccessMs first), evict the rest. A stable tiebreak on key keeps
  // the decision deterministic when two candidates share a lastAccessMs.
  candidates.sort((a, b) => (b.lastAccessMs - a.lastAccessMs) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  candidates.forEach((h, i) => {
    if (i < maxResident) keep.push({ key: h.key, reason: 'within-cap' });
    else evict.push(h.key);
  });

  return { evict, keep };
}

/**
 * Should an evicted/unbooted harness be (re)booted RIGHT NOW for an on-demand
 * access? The lazy-boot dual of eviction: any access (a getBootedHarness consumer,
 * a captured local write via the LISTEN keepalive, a swarm peer connection)
 * re-boots the engine. Boot is idempotent (wireOutboxForHarness backfills the own
 * log from PG on re-boot), so this is simply "not currently resident". Kept as a
 * named predicate so the call sites read intentionally + are testable.
 */
export function shouldRebootOnAccess(isResident: boolean): boolean {
  return !isResident;
}
