/**
 * substrate-active-set-policy.ts — the PURE decision brain for ACTIVATE-ON-DEMAND
 * substrate boot (shared-hive-cross-machine-scale-10k-2026-06-29 P-010).
 *
 * The BOOT-TIME DUAL of {@link ./substrate-eviction-policy}. That module decides
 * what to RELEASE once resident; this one decides what to bring up in the first
 * place. Same shape deliberately: no I/O, caller gathers the facts, so a rule with
 * fleet-sync blast radius is provable without booting a real corestore or swarm.
 *
 * THE PROBLEM. `bootAllHarnessesForActiveWorkspace` is EAGER: it discovers every
 * (workspace, harness) pair in the PG registry and boots a full substrate engine
 * (Corestore + own-log + merge/projection loop + swarm join) for each one, four at
 * a time. Eviction then runs AFTERWARDS. So the peak footprint at startup is
 * O(ALL harnesses) no matter how few are actually in use — and worse, the reaper
 * cannot correct it: `gatherBootedHarnessFacts` marks any SWARMED harness
 * `pinned`, and every shared-hive member is swarmed, so a shared hive is booted
 * eagerly and then never evicted. At the 10k-hive target that is the wall. The
 * goal of this policy is that concurrent footprint tracks the ACTIVE set, not the
 * registry.
 *
 * WHY "activate", not just "boot". Activation is the whole bundle the plan item
 * names — join the DHT topic, boot the engine, start the merge loop — because
 * they are inseparable in the current architecture: the swarm binding replicates
 * the corestore, so there is no "joined but not booted" state to occupy. A
 * deferred harness is therefore genuinely dark: it holds no fds, no RSS, no
 * connections, and no CPU.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 * A harness is activated at boot when ANY of these holds; otherwise it is
 * DEFERRED and comes up on demand:
 *
 *  - PINNED (the hive home, the active workspace's own harness, an explicit
 *    keep) — operationally load-bearing, exactly as in the eviction rule.
 *  - PENDING LOCAL WRITES — undrained `substrate_outbox` rows. These MUST
 *    federate; leaving them dark is the EI-126 data-divergence class. This is
 *    the one signal that is dangerous to get wrong in the deferring direction,
 *    so it dominates every "looks idle" heuristic.
 *  - LIVE PRESENCE — a `shared_presence` row seen within `presenceActiveMs`.
 *    Note this is cross-machine-aware: presence gossip means a REMOTE agent
 *    working the hive shows up here too, so "someone else is using this hive"
 *    activates it.
 *
 * ── THE SAFETY INTERLOCK (`deferFederating`) ──────────────────────────────
 * A deferred harness is not joined to its topic, so it cannot HEAR a remote
 * peer's push. Every activation trigger that exists TODAY is local-side:
 *  (a) a local write  → `substrate_outbox` NOTIFY → keepalive re-boot,
 *  (b) a local read   → `getBootedHarness` → reboot-on-access.
 * There is deliberately NO third trigger for "a remote machine appended to a
 * hive we are dark on" — that lightweight always-on wake signal is P-012, and
 * until it exists, deferring a FEDERATING harness would mean a remote push is
 * not merely delayed but unheard until something local happens to touch it.
 * That is silent divergence, i.e. precisely the failure the eviction rule's
 * dominant "never evict a harness with an active peer" constraint exists to
 * prevent — so this policy honours the same constraint at boot.
 *
 * P-012 has now landed. The production boot-all caller explicitly passes
 * `deferFederating:true` by default, then requires a successful per-harness
 * keepalive verdict before it actually leaves a federating harness dark. The
 * pure policy retains its false-by-omission fail-safe for direct callers: a
 * caller that does not attest remote-wake coverage still boots shared hives.
 *
 * This is a deliberate under-claim: it is better for P-010 to bound the footprint
 * it can bound SAFELY than to hit the headline number by darkening hives whose
 * only writer is on another machine.
 */

/** One registry harness's activation-relevant facts, gathered BEFORE any boot. */
export interface HarnessActivationFacts {
  /** Stable handle-map key (`workspaceId::harnessSlug`). */
  key: string;
  /** Operationally pinned — the hive home, the active workspace's own harness, or
   *  an explicit keep. ALWAYS activated (mirrors the eviction rule's `pinned`). */
  pinned: boolean;
  /** Count of undrained `substrate_outbox` rows. > 0 ⇒ this harness owes the hive
   *  a federation write and MUST come up. */
  pendingOutboxRows: number;
  /** Most recent `shared_presence.last_seen_at` for the harness, epoch ms; null
   *  when no device has ever announced presence on it. Cross-machine aware. */
  lastPresenceMs: number | null;
  /** This harness federates — it has a swarm binding (a shared-hive member), so a
   *  REMOTE machine may write to it. Gates the `deferFederating` interlock. */
  federating: boolean;
}

export interface ActivationPolicyClock {
  /** Now, epoch ms. */
  now: number;
  /** A presence row newer than this counts as live activity. */
  presenceActiveMs: number;
  /**
   * Allow DEFERRING harnesses that federate. The production caller passes true
   * now that P-012 exists, but omission remains fail-safe false for direct
   * policy callers that cannot attest remote-wake coverage.
   */
  deferFederating?: boolean;
}

/** Why a harness was activated — for logging/telemetry, and so a surprising
 *  activation is explainable rather than mysterious. */
export type ActivationReason =
  | 'pinned'
  | 'pending-writes'
  | 'live-presence'
  /** Activated ONLY because it federates and no remote wake signal exists yet
   *  (the P-012 interlock). This is the count to watch: it is exactly the set
   *  P-012 converts into deferrals. */
  | 'federating-no-remote-wake';

export interface ActivationDecision {
  /** Harnesses to boot eagerly in this sweep, with the reason. */
  activate: Array<{ key: string; reason: ActivationReason }>;
  /** Harnesses left dark — activated later on demand. */
  defer: string[];
}

/**
 * Decide which registry harnesses to activate at boot. Pure + deterministic;
 * input order is preserved so a caller's concurrency ordering is stable.
 *
 * NOTE there is deliberately NO cap on the activate set. A second bound here
 * would be a second way to leave a hive dark, and the steady-state footprint is
 * already bounded by the eviction reaper's `maxResident`. "Footprint is O(active
 * hives)" is the goal — so if the active set is genuinely large, activating it is
 * correct, not a leak.
 */
export function planSubstrateActivation(
  registry: readonly HarnessActivationFacts[],
  clock: ActivationPolicyClock,
): ActivationDecision {
  const activate: ActivationDecision['activate'] = [];
  const defer: string[] = [];
  const deferFederating = clock.deferFederating === true;
  // A non-positive window would make every presence row look stale and silently
  // dark a live hive; treat it as "no presence signal" only if explicitly 0.
  const presenceWindow = Math.max(0, clock.presenceActiveMs);

  for (const h of registry) {
    if (h.pinned) {
      activate.push({ key: h.key, reason: 'pinned' });
    } else if (h.pendingOutboxRows > 0) {
      activate.push({ key: h.key, reason: 'pending-writes' });
    } else if (
      h.lastPresenceMs !== null &&
      presenceWindow > 0 &&
      clock.now - h.lastPresenceMs < presenceWindow
    ) {
      activate.push({ key: h.key, reason: 'live-presence' });
    } else if (h.federating && !deferFederating) {
      activate.push({ key: h.key, reason: 'federating-no-remote-wake' });
    } else {
      defer.push(h.key);
    }
  }

  return { activate, defer };
}
