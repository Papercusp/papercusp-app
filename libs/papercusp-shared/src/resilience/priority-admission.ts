/**
 * PriorityAdmissionQueue — a generic, starvation-free, priority + aging admission gate
 * (resilience lib; used by the hive inference gateway, P-011).
 *
 * Bounds how many tasks run at once (`maxConcurrent`) and, when more are waiting than there are
 * slots, admits the HIGHEST-priority waiter first — so an interactive/Queen request jumps the
 * batch-bee backlog. AGING keeps it starvation-free: a queued item's effective priority rises by
 * 1 every `agingIntervalMs` it waits, so a flood of high-priority work can't starve a low one
 * forever. Domain-free (no LLM/account knowledge): the gateway maps roles → numeric priorities and
 * runs the per-request forward inside `run()`; the rate/pause budget is the governor's job, layered
 * inside the task. Pure-ish + fake-clock-testable (`now` injected).
 */
/**
 * Optional PRIORITY-TIER admission layer (gateway-priority-tiers-2026-06-22), gated entirely by the
 * caller — when `tiers` is OMITTED the queue behaves EXACTLY as before (a flat priority+aging gate).
 *
 * A tier is a small integer where 1 is the HIGHEST band (the interactive/Queen lane) and larger
 * numbers are progressively more sheddable batch bands. The tier layer adds two starvation guarantees
 * a flat priority queue can't make:
 *  - a PER-TIER in-flight cap (`caps`): a GUARANTEED MINIMUM SHARE for each tier — a flood of one
 *    tier can't crowd another tier out of the slots it is entitled to,
 *  - a RESERVED tier-1 FLOOR (`tier1Reserve`): a fixed number of slots only tier 1 may ever occupy,
 *    so the interactive lane is never fully crowded out by a saturated batch backlog — the
 *    un-starving piece. Tier > 1 admits only while `running < maxConcurrent - tier1Reserve`; tier 1
 *    may use all `maxConcurrent`.
 *
 * WORK-CONSERVING (WI-4541): a per-tier cap is a minimum share, NOT an idle-capacity ceiling. A tier
 * sitting at its cap may still BORROW a free slot when no more-important tier is waiting for one, and
 * hands it back on completion. Without this the queue refuses work while the pool idles: untagged
 * traffic defaults to the BOTTOM tier and the AIMD shed drives the bottom tier's cap to its floor of
 * 1, so in the real traffic mix (~everything in one band) the two compounded into the whole fleet
 * running single-file through ONE slot while 9-10 of 12 sat idle. The tier-1 reserve is always
 * honoured first, so borrowing never erodes the interactive guarantee.
 *
 * Aging still applies WITHIN the queue's priority ordering (its starvation guard for the FIFO pick);
 * the tier layer adds the cross-tier capacity guarantees on top. All domain-free: the gateway maps a
 * role → tier and passes it on `run()`.
 */
export interface TierAdmissionConfig {
  /** Per-tier GUARANTEED MINIMUM SHARE of in-flight tasks (key = tier number) — the slots a tier can
   *  always claim against a flood of other tiers. NOT a hard ceiling: a tier at its cap may still
   *  borrow an otherwise-idle slot when no more-important tier is waiting (WI-4541 work-conservation),
   *  bounded by `maxConcurrent` and the reserved tier-1 floor. A tier absent from the map is uncapped.
   *  Values are clamped to ≥1. */
  caps?: Record<number, number>;
  /** Slots RESERVED for tier 1 — tier > 1 is refused admission once `running` reaches
   *  `maxConcurrent - tier1Reserve`, holding that many slots open for the interactive lane even under
   *  a saturated batch backlog. Clamped to [0, maxConcurrent-1] so at least one slot is always shared.
   *  Default 0 (no reservation). */
  tier1Reserve?: number;
  /** The CONFIGURED reserve fraction that `tier1Reserve` was sized from (for example 0.15).
   *
   *  Supply it whenever the reserve came from a fraction, because `setMaxConcurrent` rescales the
   *  reserve as the live cap moves and needs to know the INTENDED share. Without it the queue can
   *  only infer the fraction as `tier1Reserve / maxConcurrent` at construction — which is wrong
   *  whenever the construction pool is small, since `defaultTierCaps` rounds the absolute reserve
   *  UP: at the gateway's seed window of 8, `ceil(8 * 0.15) = 2` and the inferred fraction is
   *  0.25, then locked in for the process's life (EI-21833234632961797 — measured live at 126/503
   *  and 58/231 on the two lanes, holding ~51 slots idle while tier 2 queued). */
  reserveFrac?: number;
}

export interface PriorityAdmissionOptions {
  /** Max tasks running concurrently. */
  maxConcurrent: number;
  /** Each `agingIntervalMs` a waiter sits in the queue, its effective priority rises by 1.
      0/undefined disables aging (strict priority — can starve). Default 1000ms. */
  agingIntervalMs?: number;
  /** Max tasks allowed to WAIT (queue depth) when all slots are busy. Beyond this, `run()` rejects
   *  synchronously with `QueueFullError` so the caller can shed load (e.g. 429 + retry-after) instead
   *  of growing an unbounded backlog. A long-running task that squats its slot (e.g. the gateway
   *  waiting out a sustained upstream throttle) otherwise lets the queue grow without bound until the
   *  process is effectively wedged — load-shedding keeps it responsive + self-recovering.
   *  0/undefined = unbounded (legacy behavior). */
  maxQueued?: number;
  /** OPTIONAL priority-tier layer (per-tier caps + a reserved tier-1 floor). OMIT for the flat
   *  legacy behavior — when absent the queue is byte-identical to a plain priority+aging gate. */
  tiers?: TierAdmissionConfig;
  now?: () => number;
}

/** Thrown by `run()` when the queue is at `maxQueued` and all slots are busy — a load-shed signal,
 *  NOT a task failure. Carries a stable `code` so callers map it to a retryable response. */
export class QueueFullError extends Error {
  readonly code = 'ADMISSION_QUEUE_FULL';
  constructor(queued: number, maxQueued: number) {
    super(`admission queue full (${queued} waiting ≥ cap ${maxQueued})`);
    this.name = 'QueueFullError';
  }
}

interface Waiter<T> {
  priority: number;
  /** Tier band (1 = highest). Defaults to 1 when the caller omits it, so an untagged waiter is
   *  treated as the privileged lane (it competes on raw priority as before). */
  tier: number;
  enqueuedAt: number;
  task: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  seq: number;
  /** Detach this waiter's abort listener. Called EXACTLY once, the moment the waiter leaves
   *  `waiters` — whether it was admitted or abandoned — so a long-lived caller signal cannot
   *  accumulate listeners for the life of the process. Absent when the caller passed no signal. */
  cleanup?: () => void;
}

/** Thrown to a caller whose queued request was abandoned (its `signal` aborted) before admission.
 *  Distinct from `QueueFullError`: nothing was refused, the CALLER left. */
export class AdmissionAbandonedError extends Error {
  readonly waitedMs: number;
  constructor(waitedMs: number) {
    super(`admission abandoned by caller after ${waitedMs}ms waiting`);
    this.name = 'AdmissionAbandonedError';
    this.waitedMs = waitedMs;
  }
}

/** Per-tier admission breakdown (priority-tiers /stats). */
export interface TierSnapshot {
  tier: number;
  /** This tier's GUARANTEED MINIMUM SHARE of in-flight slots, or null when it has none.
   *
   *  NOT a ceiling, and deliberately no longer NAMED one: since WI-4541 a tier at its share
   *  BORROWS an otherwise-idle slot whenever no more-important tier is waiting, so live
   *  `inFlight` routinely sits far above it (measured 2026-08-30: tier 2 at 377 in flight
   *  against a share of 6, nothing refused). While this field was called `cap`, that gap read
   *  as a broken ceiling rather than working cap-borrowing — it cost a P-014 reviewer a
   *  false-defect investigation, which is why the readback now says what the number is. */
  minShare: number | null;
  /** Tasks of this tier running right now. */
  inFlight: number;
  /** Tasks of this tier waiting in the queue. */
  queued: number;
}

export interface AdmissionSnapshot {
  running: number;
  queued: number;
  maxConcurrent: number;
  /** Queued counts bucketed by raw priority (highest first). */
  byPriority: { priority: number; count: number }[];
  /** Per-tier {cap,inFlight,queued} — present only when the tier layer is configured (else undefined,
   *  so flag-OFF stats are byte-identical to the legacy snapshot). Ascending by tier. */
  byTier?: TierSnapshot[];
  /** Slots reserved for tier 1 (the un-starving floor). Present only with the tier layer. */
  tier1Reserve?: number;
}

export class PriorityAdmissionQueue {
  private maxConcurrent: number;
  private readonly agingIntervalMs: number;
  private readonly maxQueued: number;
  private readonly now: () => number;
  private running = 0;
  private seq = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly waiters: Waiter<any>[] = [];
  /** Tier layer (null when not configured → legacy flat behavior). */
  private readonly tierCaps: Map<number, number> | null;
  private tier1Reserve = 0;
  /** H11 (inference-gateway-audit-2026-06-23): the ORIGINAL tier-1 reserve FRACTION (reserve÷cap at construction)
   *  so setMaxConcurrent can rescale the reserve PROPORTIONALLY as the AIMD shrinks the live cap — instead of
   *  re-clamping the absolute reserve, which swelled a 15%-of-24 reserve to 75% of a 4-slot floor. */
  private reserveFrac = 0;
  /** Live in-flight count per tier (only maintained when the tier layer is on). */
  private readonly inFlightByTier = new Map<number, number>();

  constructor(opts: PriorityAdmissionOptions) {
    this.maxConcurrent = Math.max(1, opts.maxConcurrent);
    this.agingIntervalMs = opts.agingIntervalMs ?? 1000;
    this.maxQueued = opts.maxQueued && opts.maxQueued > 0 ? Math.floor(opts.maxQueued) : 0;
    this.now = opts.now ?? (() => Date.now());
    if (opts.tiers) {
      this.tierCaps = new Map();
      for (const [k, v] of Object.entries(opts.tiers.caps ?? {})) {
        const tier = Number(k);
        if (Number.isFinite(tier) && Number.isFinite(v)) this.tierCaps.set(tier, Math.max(1, Math.floor(v)));
      }
      this.tier1Reserve = this.clampReserve(opts.tiers.tier1Reserve ?? 0);
      // Prefer the CONFIGURED fraction over re-deriving it from the absolute reserve. Deriving it
      // (the fallback, for callers that only ever supply an absolute) reads `ceil()` rounding as
      // intent: at the gateway's construction window of 8, ceil(8 * 0.15) = 2 makes the inferred
      // fraction 0.25, and setMaxConcurrent then holds 25% of every later cap for tier 1 forever.
      const configuredFrac = opts.tiers.reserveFrac;
      this.reserveFrac =
        typeof configuredFrac === 'number' && Number.isFinite(configuredFrac) && configuredFrac >= 0
          ? configuredFrac
          : this.maxConcurrent > 0
            ? (opts.tiers.tier1Reserve ?? 0) / this.maxConcurrent
            : 0;
    } else {
      this.tierCaps = null;
    }
  }

  /** A reserve must leave ≥1 shared slot, and never exceed the live cap. */
  private clampReserve(n: number): number {
    return Math.min(Math.max(0, Math.floor(n)), Math.max(0, this.maxConcurrent - 1));
  }

  /** Whether the tier layer is active (per-tier caps + reserved tier-1 floor). */
  private get tiered(): boolean {
    return this.tierCaps !== null;
  }

  /** Is a MORE IMPORTANT tier (a strictly lower tier number) currently waiting in the queue? Gates
   *  cap-borrowing below: idle capacity may be lent out, but never over the head of a waiter that
   *  outranks the borrower. */
  private hasWaiterAboveTier(tier: number): boolean {
    for (const w of this.waiters) if (w.tier < tier) return true;
    return false;
  }

  /** Can a waiter of `tier` be admitted RIGHT NOW given live in-flight + the reserved floor + its cap?
   *  Only consulted when the tier layer is on. */
  private canAdmitTier(tier: number): boolean {
    // (1) HARD — the reserved tier-1 floor: tier > 1 may never occupy the slots held open for tier 1.
    //     Checked FIRST so cap-borrowing below can never erode the interactive guarantee.
    if (tier > 1 && this.running >= this.maxConcurrent - this.tier1Reserve) return false;

    // (2) The per-tier in-flight cap is a GUARANTEED MINIMUM SHARE, not an idle-capacity ceiling.
    const cap = this.tierCaps!.get(tier);
    if (cap === undefined || (this.inFlightByTier.get(tier) ?? 0) < cap) return true;

    // (3) AT CAP → BORROW an otherwise-IDLE slot, but only when no more-important tier is waiting.
    //     WI-4541: the caps were a hard ceiling, so a tier at its cap was refused even with the pool
    //     nearly EMPTY. That is catastrophic in the real traffic mix, because the two mechanisms
    //     compound: untagged requests default to the BOTTOM tier (DEFAULT_TIER = 5), and the AIMD
    //     shed drives the bottom tier's cap down to its floor of 1 (`shedTierCaps`). Measured live on
    //     2026-07-13: every queued request sat in tier 5 at cap 1 while tiers 2-4 were EMPTY and 9-10
    //     of 12 slots idled — the whole fleet serialized through ONE admission slot, and the owner's
    //     voice turn ("processing forever", EI-10795) queued behind it. The shed is meant to squeeze
    //     BATCH tiers so the interactive lane keeps working; it assumed traffic is spread across
    //     tiers, and silently became "shed EVERYTHING" once ~all traffic landed in one band.
    //     This is the sibling of the H11 fix below (which rescued the same starvation on the RESERVE
    //     axis but left the CAP axis armed).
    //     Borrowing rides on two guards, because a borrowed slot CANNOT BE PREEMPTED — an in-flight
    //     upstream call can't be clawed back, so a slot lent out is gone for a whole request-duration:
    //
    //  (a) Never borrow over the head of an OUTRANKING WAITER already queued. Still necessary even
    //      though `priorityFromLabel`'s DEFAULT ladder now gives every known role a DISTINCT numeric
    //      priority in tier order (WI-4542 — it used to score su/scout/bee/untagged all 0, so a
    //      tier-2 waiter did not outrank an earlier-queued tier-5 one on priority alone): an
    //      env-overridden `GATEWAY_PRIORITY_MAP`, an unrecognized role, or a caller that hands the
    //      queue an explicit `{ priority, tier }` pair directly (as the tests below do) can still tie
    //      or invert priority vs tier. The TIER breaks that tie regardless of the label ladder, or
    //      borrowing would starve the better band.
    //
    //  (b) A tier > 1 must leave a HEADROOM slot free, so a tier-1 (interactive/queen) request that
    //      arrives LATER is still admitted INSTANTLY rather than waiting out a borrowed request. The
    //      tier-1 reserve normally IS that headroom; `max(tier1Reserve, 1)` keeps the guarantee alive
    //      even for a caller that configures `tier1Reserve: 0` and relies on the caps alone to hold a
    //      slot open (the un-starving-core contract). In production the reserve is already ≥1, so this
    //      floor costs nothing; it only closes the degenerate config's footgun.
    if (this.hasWaiterAboveTier(tier)) return false;
    if (tier > 1 && this.running >= this.maxConcurrent - Math.max(this.tier1Reserve, 1)) return false;
    return true;
  }

  /** Effective priority at `t` — raw priority plus one point per aging interval waited. */
  private effective(w: Waiter<unknown>, t: number): number {
    if (this.agingIntervalMs <= 0) return w.priority;
    return w.priority + Math.floor((t - w.enqueuedAt) / this.agingIntervalMs);
  }

  /** Admit a task at `priority` (higher = sooner). Resolves/rejects with the task's result.
   *  Rejects synchronously with `QueueFullError` when all slots are busy AND the queue is at
   *  `maxQueued` (load-shed) — a free slot always runs the task regardless of the cap.
   *
   *  `opts.tier` (1 = highest band) drives the optional tier layer; it is IGNORED when the queue was
   *  constructed without `tiers` (legacy behavior). Omitting it ⇒ tier 1 (the privileged lane). */
  run<T>(
    priority: number,
    task: () => Promise<T>,
    opts?: { tier?: number; signal?: AbortSignal },
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const signal = opts?.signal;
      if (signal?.aborted) {
        reject(new AdmissionAbandonedError(0));
        return;
      }
      if (this.maxQueued > 0 && this.running >= this.maxConcurrent && this.waiters.length >= this.maxQueued) {
        reject(new QueueFullError(this.waiters.length, this.maxQueued));
        return;
      }
      const tier = this.tiered ? Math.max(1, Math.floor(opts?.tier ?? 1)) : 1;
      const waiter: Waiter<T> = { priority, tier, enqueuedAt: this.now(), task, resolve, reject, seq: this.seq++ };
      this.waiters.push(waiter);

      // THE ABANDONED-WAITER LEAK (WI-2140943, measured outage 2026-09-02).
      //
      // Before this, `run()` had NO cancellation path: a waiter could leave `waiters` only by being
      // ADMITTED. So when a caller gave up — an agent CLI hitting its request timeout, a session
      // killed, a client socket closed — its waiter stayed queued forever, still holding a priority
      // and still AGING. Aging made it worse rather than self-limiting: an abandoned waiter's
      // effective priority climbs with age, so the deadest entries outranked live traffic and were
      // admitted first, spending a real slot on a caller that had already gone.
      //
      // That is a RATCHET, and it is why the queue never recovered on its own. Measured: 1,206
      // queued against a window of 18 while upstream was clean (0 429s, 7 healthy accounts); the
      // owner's desktop sessions timed out behind it, and RESUMING them only appended a fresh
      // waiter to the back of the same queue. A gateway restart dropped the depth to ~5 under
      // identical demand — proving ~1,190 of those waiters had no caller left.
      //
      // Removing an abandoned waiter is therefore not an optimization; it is what makes the queue's
      // depth mean "work someone is still waiting for". Note the `indexOf` guard: once pump() has
      // spliced this waiter out, the task OWNS the slot and abort is no longer ours to act on —
      // tearing down an in-flight upstream call is the transport's job, not the queue's.
      if (signal) {
        const onAbort = () => {
          const i = this.waiters.indexOf(waiter as Waiter<unknown>);
          if (i < 0) return; // already admitted — the running task owns cancellation from here
          this.waiters.splice(i, 1);
          reject(new AdmissionAbandonedError(this.now() - waiter.enqueuedAt));
          // A freed slot may now admit someone else, so keep the pump honest.
          this.pump();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      this.pump();
    });
  }

  private pump(): void {
    while (this.running < this.maxConcurrent && this.waiters.length > 0) {
      const t = this.now();
      // Pick the highest effective priority; ties broken by earliest arrival (FIFO, stable). With the
      // tier layer on, ONLY consider waiters their tier can admit right now — so a saturated low tier
      // (or a tier > 1 blocked by the reserved tier-1 floor) is SKIPPED rather than head-of-line-
      // blocking an admissible higher tier behind it. When no waiter is admissible, stop (the slot is
      // held open — for tier 1, that is exactly the reserved-floor guarantee).
      let bestIdx = -1;
      let bestEff = -Infinity;
      for (let i = 0; i < this.waiters.length; i++) {
        const w = this.waiters[i];
        if (this.tiered && !this.canAdmitTier(w.tier)) continue;
        const eff = this.effective(w, t);
        if (bestIdx === -1 || eff > bestEff || (eff === bestEff && w.seq < this.waiters[bestIdx].seq)) {
          bestEff = eff;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) break; // nothing admissible (e.g. only tier > 1 waiters left, reserve held)
      const w = this.waiters.splice(bestIdx, 1)[0];
      // Admitted: detach the abandon listener. From here the task owns the request, so a later
      // abort must NOT reject this promise out from under a call that is already in flight.
      w.cleanup?.();
      this.running++;
      if (this.tiered) this.inFlightByTier.set(w.tier, (this.inFlightByTier.get(w.tier) ?? 0) + 1);
      const onSettle = () => {
        this.running--;
        if (this.tiered) this.inFlightByTier.set(w.tier, Math.max(0, (this.inFlightByTier.get(w.tier) ?? 0) - 1));
      };
      // Run outside the loop's sync frame; settle → free the slot → pump again.
      void Promise.resolve()
        .then(() => w.task())
        .then(
          (v) => {
            onSettle();
            w.resolve(v);
            this.pump();
          },
          (e) => {
            onSettle();
            w.reject(e);
            this.pump();
          },
        );
    }
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, Math.floor(n));
    // H11 (2026-06-23): RESCALE the reserve proportionally to the new live cap (round(cap × reserveFrac)), not
    // just re-clamp the absolute reserve — else when the AIMD shrinks the cap to the floor, a 15%-of-24 reserve
    // (=4) stays ~4 and becomes 3-of-4 live slots (75%), starving su + every bee tier to ONE shared slot exactly
    // when the fleet most needs throughput. clampReserve still guarantees ≥1 shared slot stays open.
    if (this.tiered) {
      const scaled = Math.round(this.maxConcurrent * this.reserveFrac);
      const reserve = this.reserveFrac > 0 && this.maxConcurrent > 1 ? Math.max(1, scaled) : scaled;
      this.tier1Reserve = this.clampReserve(reserve);
    }
    this.pump();
  }

  /** Adjust the reserved tier-1 floor live (tier-aware shedding shrinks/grows it). No-op without the
   *  tier layer. Clamped so ≥1 slot always stays shared. */
  setTier1Reserve(n: number): void {
    if (!this.tiered) return;
    this.tier1Reserve = this.clampReserve(n);
    this.pump();
  }

  /** Adjust a single tier's in-flight cap live (tier-aware shedding shrinks tier 4→3→2 under 429
   *  pressure, holding tier 1). No-op without the tier layer. `cap` is clamped to ≥1. */
  setTierCap(tier: number, cap: number): void {
    if (!this.tiered) return;
    this.tierCaps!.set(tier, Math.max(1, Math.floor(cap)));
    // A raised cap may newly admit; a lowered cap can't evict an already-running task (it only gates
    // future admission), so pump() is safe + sufficient.
    this.pump();
  }

  /** The configured cap for a tier, or null when uncapped / no tier layer. */
  tierCap(tier: number): number | null {
    return this.tierCaps?.get(tier) ?? null;
  }

  get reservedTier1(): number {
    return this.tiered ? this.tier1Reserve : 0;
  }

  get size(): number {
    return this.waiters.length;
  }
  get inFlight(): number {
    return this.running;
  }

  snapshot(): AdmissionSnapshot {
    const byPriority = new Map<number, number>();
    for (const w of this.waiters) byPriority.set(w.priority, (byPriority.get(w.priority) ?? 0) + 1);
    const base: AdmissionSnapshot = {
      running: this.running,
      queued: this.waiters.length,
      maxConcurrent: this.maxConcurrent,
      byPriority: [...byPriority.entries()].sort((a, b) => b[0] - a[0]).map(([priority, count]) => ({ priority, count })),
    };
    if (!this.tiered) return base; // flag-OFF: byte-identical to the legacy snapshot
    const queuedByTier = new Map<number, number>();
    for (const w of this.waiters) queuedByTier.set(w.tier, (queuedByTier.get(w.tier) ?? 0) + 1);
    // Union of every tier that has a share, an in-flight task, or a waiter — so /stats shows a
    // known tier even at zero load.
    const tiers = new Set<number>([...this.tierCaps!.keys(), ...this.inFlightByTier.keys(), ...queuedByTier.keys()]);
    base.byTier = [...tiers]
      .sort((a, b) => a - b)
      .map((tier) => ({
        tier,
        minShare: this.tierCaps!.get(tier) ?? null,
        inFlight: this.inFlightByTier.get(tier) ?? 0,
        queued: queuedByTier.get(tier) ?? 0,
      }));
    base.tier1Reserve = this.tier1Reserve;
    return base;
  }
}

/** WI-4542 — the vocabulary-divergence fix: numeric within-queue PRIORITY for every AUTONOMOUS role
 *  that also carries a TIER band in `DEFAULT_GATEWAY_PRIORITY_MAP` below, kept in the SAME rank order
 *  as that map so the two vocabularies can't silently disagree again. Before this table, every role
 *  not hand-cased in `priorityFromLabel`'s switch below (scout/blender/overwatch/kettle/su/gym/
 *  benchmark/llm-testing) fell through to the untagged default of 0 — identical to a bee or literally
 *  no header at all — despite sitting in strictly more-protected tiers. Consequence: those roles
 *  queued dead-last within their own tier and lost same-priority ties (broken by FIFO arrival, not
 *  tier) to lower-tier traffic whenever the shared pool had slack. Interactive/queen/mug/operator
 *  (100), maintenance/compaction (75), and the tier-less literal levels high/low/batch/'' keep their
 *  existing hand-tuned numbers in the switch below — this table covers exactly the gap.
 *  `test('DEFAULT_GATEWAY_PRIORITY_MAP tier order matches priorityFromLabel order', …)` guards the
 *  two tables from re-diverging without requiring them to be merged into one literal object. */
const ROLE_QUEUE_PRIORITY: Record<string, number> = {
  // tier 1 (DEFAULT_GATEWAY_PRIORITY_MAP), but below interactive/queen/mug/operator/maintenance —
  // the owner's live turn and maintenance calls must still preempt an autonomous role's request.
  scout: 60,
  blender: 60,
  overwatch: 60,
  kettle: 60,
  // tier 2
  su: 40,
  // tier 3 — still above the untagged/batch default (0), so a labeled bee no longer ties with an
  // anonymous request when both happen to be admissible in the shared pool at once.
  bee: 10,
  cup: 10,
  // tier 4
  gym: 5,
  benchmark: 5,
  'llm-testing': 5,
};

/** Map a request priority label/number to a numeric admission priority (higher = sooner). */
export function priorityFromLabel(label: string | number | undefined): number {
  if (typeof label === 'number') return label;
  const key = (label ?? '').toLowerCase();
  switch (key) {
    case 'interactive':
    case 'operator':
    case 'queen':
    case 'mug': // pot-rename dual-accept (P1 MIGRATE): additive twin of `queen`
      return 100;
    case 'maintenance':
    case 'compaction': // alias — compaction/summarizer calls are the canonical maintenance traffic
      // Above `high`, below interactive: a maintenance call (a compaction summary) is small, rare,
      // and blocking a session's ability to continue — it must not queue behind worker traffic
      // (deterministic-context-carry P-002; the 2026-07-13 ornith incident starved exactly this call).
      return 75;
    case 'high':
      return 50;
    case 'low':
    case 'batch':
    case '':
      return 0;
    default: {
      if (key in ROLE_QUEUE_PRIORITY) return ROLE_QUEUE_PRIORITY[key];
      const n = Number(label);
      return Number.isFinite(n) ? n : 0;
    }
  }
}

// ── Priority TIER mapping (gateway-priority-tiers-2026-06-22) ───────────────────────────────────────
//
// A TIER is the small admission band a role belongs to (1 = the highest, most-protected interactive
// lane; larger = more sheddable batch). Distinct from the `priorityFromLabel` number, which still
// orders WITHIN the queue; the tier drives the per-tier caps + the reserved tier-1 floor. Lower tier
// number = higher protection — the inverse of the priority number's "higher = sooner".

/** A role/label → tier map. Lower tier = more protected. */
export type PriorityTierMap = Record<string, number>;

/** The fallback band for any role not named in the map (the most-sheddable lane). */
export const DEFAULT_TIER = 5;

/** Default role → tier map (gateway-priority-tiers-2026-06-22). Env-overridable via
 *  `GATEWAY_PRIORITY_MAP` (a JSON object of `role: tier`, merged over these defaults), parsed by
 *  `parsePriorityTierMap`. The `default` key sets the fallback band for unnamed roles. */
export const DEFAULT_GATEWAY_PRIORITY_MAP: PriorityTierMap = {
  queen: 1,
  mug: 1, // pot-rename dual-accept (P1 MIGRATE): additive twin of `queen`
  scout: 1,
  blender: 1, // pot-rename dual-accept (P1 MIGRATE): additive twin of `scout`
  overwatch: 1,
  kettle: 1, // pot-rename dual-accept (P1 MIGRATE): additive twin of `overwatch`
  operator: 1,
  interactive: 1,
  // Maintenance lane (deterministic-context-carry P-002): compaction/summarizer calls ride tier 1 so
  // fleet worker traffic can never starve them — the tier-1 reserved floor is the "small reserved
  // budget for maintenance calls" of the ornith-overflow brief (fix 3), and tier 1 is never AIMD-shed.
  // They are rare and tiny (one short completion per compaction), so they cannot crowd interactive.
  maintenance: 1,
  compaction: 1, // alias for the same lane
  su: 2,
  bee: 3,
  cup: 3, // pot-rename dual-accept (P1 MIGRATE): additive twin of `bee`
  gym: 4,
  benchmark: 4,
  // EI-315: llm-testing scenario runs (sim-user + judge calls, packages/operator-core/lib/
  // llm-testing/llm-client.ts) used to go out UNLABELED and fall to the `default` band below
  // (tier 5 — the most aggressively AIMD-shed lane), which is the literal root cause of
  // "17/17 attempts 429-capped over 7h" under fleet load. Same batch-lane floor as gym/
  // benchmark — high enough to stop starving, never ahead of real interactive work.
  'llm-testing': 4,
  default: DEFAULT_TIER,
};

/** Parse a `GATEWAY_PRIORITY_MAP` JSON env value, MERGED over the defaults. Invalid JSON / non-numeric
 *  entries are ignored (fail-safe to the defaults). Keys are lower-cased so the lookup is
 *  case-insensitive. */
export function parsePriorityTierMap(raw: string | undefined, base: PriorityTierMap = DEFAULT_GATEWAY_PRIORITY_MAP): PriorityTierMap {
  const map: PriorityTierMap = {};
  for (const [k, v] of Object.entries(base)) map[k.toLowerCase()] = v;
  if (!raw) return map;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 1) map[k.toLowerCase()] = Math.floor(n);
    }
  } catch {
    /* malformed env → keep the defaults (fail-safe) */
  }
  return map;
}

/** Resolve the admission TIER for a request's priority label / caller role. `label` is the
 *  `x-papercusp-priority` header value (a role name like `queen`/`bee`/`su`, an interactive alias, or
 *  a bare tier number). A numeric label is taken as the tier directly (clamped to ≥1); an unknown
 *  label falls back to the map's `default` band. */
export function tierOf(label: string | number | undefined, map: PriorityTierMap = DEFAULT_GATEWAY_PRIORITY_MAP): number {
  const fallback = map.default ?? DEFAULT_TIER;
  if (typeof label === 'number') return Number.isFinite(label) ? Math.max(1, Math.floor(label)) : fallback;
  const key = (label ?? '').trim().toLowerCase();
  if (key === '') return fallback;
  if (key in map && key !== 'default') return map[key];
  // A bare numeric string ("2") is an explicit tier.
  const n = Number(key);
  if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  return fallback;
}

/** The set of distinct tiers a map can produce (every value + the `default` fallback), ascending. */
export function tiersOfMap(map: PriorityTierMap = DEFAULT_GATEWAY_PRIORITY_MAP): number[] {
  const tiers = new Set<number>();
  for (const [k, v] of Object.entries(map)) {
    if (Number.isFinite(v) && v >= 1) tiers.add(Math.floor(v));
    if (k === 'default' && Number.isFinite(v)) tiers.add(Math.floor(v));
  }
  if (tiers.size === 0) tiers.add(DEFAULT_TIER);
  return [...tiers].sort((a, b) => a - b);
}

/** Steady-state per-tier in-flight caps for a pool of `poolSlots`. Tier 1 may use the WHOLE pool (it is
 *  the protected interactive lane). Tiers 2-3 may use the shared pool (`poolSlots - reserve`) so SU and
 *  implementation bees can restore the fleet quickly. Lower bands are progressively bounded so high-volume
 *  benchmark/gym/default egress has its own frame but cannot occupy every shared slot. */
export function defaultTierCaps(poolSlots: number, tiers: number[], reserveFrac = 0.15): { caps: Record<number, number>; reserve: number } {
  const slots = Math.max(1, Math.floor(poolSlots));
  const reserve = Math.max(1, Math.ceil(slots * Math.max(0, reserveFrac)));
  const sharedCap = Math.max(1, slots - reserve);
  const caps: Record<number, number> = {};
  for (const t of tiers) {
    if (t <= 1) caps[t] = slots;
    else if (t <= 3) caps[t] = sharedCap;
    else caps[t] = Math.max(1, Math.ceil(sharedCap / (t - 2)));
  }
  return { caps, reserve };
}

/** TIER-AWARE LOAD-SHEDDING (gateway-priority-tiers-2026-06-22, step 4). Given the steady-state `base`
 *  caps and how many concurrency slots have been lost (`shed = cap - effective`, the AIMD shrink),
 *  shrink the MOST-SHEDDABLE bands FIRST — the highest tier number down to (but never including) tier 1 —
 *  by removing `shed` units of headroom bottom-up. Tier 1 is NEVER reduced (the interactive lane is held
 *  whole even under a full storm); a band can be squeezed to a floor of 1. Returns the adjusted caps.
 *
 *  Bottom-up ordering ("4 → 3 → 2 first, hold tier 1") means a partial storm degrades batch throughput
 *  before it ever touches su (tier 2), and only an extreme storm pins every non-tier-1 band at 1 — tier 1
 *  still admits at full pool width. Pure + deterministic (no clock / no queue mutation): the gateway calls
 *  it on each AIMD change and applies the result via `queue.setTierCap`. */
export function shedTierCaps(base: Record<number, number>, shed: number): Record<number, number> {
  const out: Record<number, number> = { ...base };
  let remaining = Math.max(0, Math.floor(shed));
  if (remaining === 0) return out;
  // Most-sheddable first: highest tier number down to 2 (tier 1 is held).
  const order = Object.keys(out)
    .map(Number)
    .filter((t) => t > 1)
    .sort((a, b) => b - a);
  for (const t of order) {
    if (remaining <= 0) break;
    const headroom = Math.max(0, out[t] - 1); // never below 1
    const take = Math.min(headroom, remaining);
    out[t] -= take;
    remaining -= take;
  }
  return out;
}
