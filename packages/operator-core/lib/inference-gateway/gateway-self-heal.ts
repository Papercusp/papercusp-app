/**
 * Inference-gateway IN-PROCESS self-heal release valve — EI-2086.
 *
 * The external WEDGE watchdog (`watchdog.mjs`) recovers a wedged gateway by FULL-RESTARTING the :8788
 * process — a sledgehammer that drops EVERY in-flight request AND the listener (~15-30s of fleet-wide
 * connection-refused). It fires on the `totalRequests frozen 120s while saturated` signature. The
 * problem this module fixes: the gateway's OWN per-request guards (the 5-min non-streaming headers
 * deadline, the 20-min hard ceiling) reclaim a stuck admission slot far SLOWER than 120s, so under an
 * Anthropic-wide 529/429 storm the watchdog's full restart ALWAYS pre-empts them — the routine recovery
 * path became an hourly restart (5× on 2026-06-20). See EI-2086.
 *
 * This is the in-process release valve that PRE-EMPTS the watchdog: a pure decision fn the sweeper in
 * `gateway.ts` ticks against live admission metrics. When the gateway is saturated AND nothing has
 * DRAINED for `freezeMs` (a threshold BELOW the watchdog's 120s), it reclaims the oldest stuck slot —
 * the gateway drains its own wedge while the listener + healthy traffic stay up, so the watchdog's full
 * restart becomes the rare last-resort backstop instead of the norm.
 *
 * THE DRAIN SIGNAL IS COMPLETION-BASED, NOT ADMISSION-COUNTER-BASED. The watchdog keys on
 * `totalRequests` (a count of ADMISSIONS), but reclaiming a slot itself admits a queued waiter →
 * bumps that counter → would falsely read as "draining" and reset the clock after a single reclaim.
 * So the sweeper feeds `msSinceLastDrain` = time since the last NATURAL completion (a real upstream
 * response / error — NOT a self-heal abort). A wedge we are actively reclaiming therefore stays
 * "stalled" until a request genuinely completes (the upstream recovered) or saturation eases, so a
 * multi-slot wedge drains one slot per tick instead of one per `freezeMs`.
 *
 * PURE by construction (no I/O, no clock) so the decision + target selection are trivially testable;
 * the sweeper owns the timer, the in-flight registry, the `lastDrainAt` clock, and the actual abort.
 */

/** Live admission metrics the decider reads — sourced from `queue.snapshot()` + the sweeper's
 *  completion clock. NB: read from `queue.snapshot()` directly, NOT `stats()`, because `stats()`
 *  advances the pool round-robin cursor as a side effect. */
export interface SelfHealMetrics {
  /** Requests currently holding an admission slot (`queue.snapshot().running`). */
  inFlight: number;
  /** Requests waiting for a slot (`queue.snapshot().queued`). */
  queueDepth: number;
  /** LIVE effective admission concurrency, AIMD-adjusted (`queue.snapshot().maxConcurrent`). Saturation
   *  is `inFlight >= maxConcurrent`. */
  maxConcurrent: number;
  /** ms since the last NATURAL request completion (a real upstream settle, NOT a self-heal abort). The
   *  true "is anything draining?" signal — it only grows while the gateway is genuinely stuck. */
  msSinceLastDrain: number;
}

export interface SelfHealDecision {
  /** Reclaim the oldest stuck slot NOW (abort it) to break the wedge before the watchdog restarts. */
  reclaim: boolean;
  /** Human reason (for the log + the visibility counter) when reclaiming; null otherwise. */
  reason: string | null;
}

/** Every live slot taken AND work queued behind it — the spatial half of the wedge signature. A
 *  gateway with a free slot or an empty queue is not wedged (a waiter would be admitted), so we never
 *  reclaim there. */
export function isSaturated(m: SelfHealMetrics): boolean {
  return m.maxConcurrent > 0 && m.inFlight >= m.maxConcurrent && m.queueDepth > 0;
}

/**
 * Decide whether to reclaim a slot this tick. Reclaims when the gateway is SATURATED (every slot taken,
 * work queued) AND nothing has NATURALLY drained for at least `freezeMs`. The `msSinceLastDrain`
 * threshold IS the temporal persistence guard — no separate frozen-since bookkeeping is needed, and a
 * single momentary saturation never reclaims because the drain clock has to have aged past `freezeMs`.
 *
 * STATELESS: identical inputs → identical output. The persistence lives entirely in `msSinceLastDrain`,
 * which the sweeper maintains.
 */
export function evaluateSelfHeal(m: SelfHealMetrics, freezeMs: number): SelfHealDecision {
  if (isSaturated(m) && m.msSinceLastDrain >= freezeMs) {
    return {
      reclaim: true,
      reason: `saturated (${m.inFlight}/${m.maxConcurrent} in-flight, ${m.queueDepth} queued) with nothing drained for ${Math.round(m.msSinceLastDrain / 1000)}s ≥ ${Math.round(freezeMs / 1000)}s — reclaiming oldest stuck slot to pre-empt the watchdog restart`,
    };
  }
  return { reclaim: false, reason: null };
}

/** A reclaim candidate — one entry of the sweeper's in-flight registry. */
export interface ReclaimCandidate {
  id: number;
  /** epoch ms the request acquired its admission slot. */
  startedAt: number;
  /** Whether the request is a streaming (`stream:true`) call. */
  isStream: boolean;
}

/**
 * Pick which slot to reclaim: the OLDEST NON-STREAMING in-flight request — the actual wedge culprits
 * (raw-SDK / scout / gym callers stuck on the generous non-streaming headers deadline), preferentially
 * SPARING active bee streams (which the per-chunk body-idle guard already protects from their own
 * stalls and which legitimately run long). Falls back to the oldest overall only when EVERY in-flight
 * request is a stream (so a genuinely all-streams wedge is still broken). Null when no candidates. PURE.
 */
export function pickReclaimTarget<T extends ReclaimCandidate>(entries: readonly T[]): T | null {
  if (entries.length === 0) return null;
  const nonStream = entries.filter((e) => !e.isStream);
  const pool = nonStream.length > 0 ? nonStream : entries;
  return pool.reduce((oldest, e) => (e.startedAt < oldest.startedAt ? e : oldest));
}

/** The two slot-leak shapes the reconcile guard flags (P-005/W3, D-001). */
export type SlotReconcileViolation = 'registry>slots' | 'wedged-unreclaimable';

/**
 * P-005/W3 slot-leak RECURRENCE GUARD (D-001) — PURE classifier. Cross-checks the two INDEPENDENT
 * in-flight accountings that must move together: the admission queue's held-slot counter (`running`)
 * and the self-heal in-flight registry (`tracked`). Every request bumps `running` at admission and
 * registers exactly one registry entry (deleted just before its slot frees), so the registry is a
 * strict SUBSET of held slots — `tracked <= running` always, and equal when quiescent. A `running >
 * tracked` gap is a NORMAL transient (a request between queue admission and registry insert — e.g. mid
 * body-read), so it is NOT flagged on its own. Only two shapes cannot be a healthy transient:
 *   - `registry>slots` (`tracked > running`): structurally impossible — a registry entry that outlived
 *     its slot, i.e. a broken decrement path; and
 *   - `wedged-unreclaimable`: the self-heal decider WANTS to reclaim (saturated + nothing drained for
 *     freezeMs) and slots are held, but NOTHING is registered to reclaim (`!hasReclaimTarget`) — an
 *     un-registered leak (e.g. a stall BEFORE the request reached the registry) the valve is blind to,
 *     which today rides silently to the watchdog restart.
 * STATELESS: the sweeper owns the de-bounce (only a violation sustained across sweeps counts) + the
 * counter + the log. Returns the violation shape, or null when the two accountings are consistent.
 */
export function classifySlotReconcile(args: {
  running: number;
  tracked: number;
  /** The self-heal decider's verdict this tick (`evaluateSelfHeal(...).reclaim`). */
  wantsReclaim: boolean;
  /** Whether `pickReclaimTarget` found a registry entry to reclaim this tick. */
  hasReclaimTarget: boolean;
}): SlotReconcileViolation | null {
  const { running, tracked, wantsReclaim, hasReclaimTarget } = args;
  if (tracked > running) return 'registry>slots';
  if (wantsReclaim && running > 0 && !hasReclaimTarget) return 'wedged-unreclaimable';
  return null;
}
