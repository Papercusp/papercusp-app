/**
 * @papercusp/debounce-coalesce — a generic per-subscriber wake-floor + burst-coalesce.
 *
 * The problem this solves (unify-watch-primitive-2026-06-06, D-003): re-invoking
 * an agent ("a wake") costs a full-context turn = tokens. An agent that registers
 * a wake on a HOT, recurring key gets re-woken on every fire, burning a turn each
 * time. The fix — generalized from the pot's bespoke `potWakeFloorSec`/`withinWakeFloor`
 * — is a per-subscriber MINIMUM-INTERVAL floor plus burst COALESCING:
 *
 *   - **Floor (`minSleepMs`)** — never re-wake one subscriber more often than once
 *     per window. Leading-edge by default: the first fire after an idle stretch wakes
 *     immediately; the rest of the window is suppressed.
 *   - **Coalesce** — fires that land inside a suppressed window fold into ONE wake
 *     carrying their UNION ("here are the N things that fired while you slept"),
 *     instead of N separate wakes.
 *   - **Urgency bypass** — a fire marked `urgent` (a human message, an escalation, a
 *     hard deadline) wakes now regardless of the floor.
 *   - **Max-staleness** — a `maxStalenessMs` deadline forces a wake even mid-window so
 *     a suppressed event can't be held back indefinitely.
 *
 * This is a PURE algorithm: no clock, no storage, no I/O. The host injects `now`
 * (epoch ms) and persists the per-subscriber {@link FloorState} between ticks (in PG,
 * in memory, wherever). Zero domain coupling — the payload `T` is whatever the host
 * carries on a fire. Two consumers in this repo: the await delivery pump (per-subscriber
 * over `event_wake_deliveries`) and the pot's self-wake debounce.
 */

/** Configuration for one subscriber's wake floor + coalesce window. */
export interface FloorConfig {
  /** Minimum interval between wakes for one subscriber, in ms. `<= 0` disables the
   *  floor (every fire wakes — the no-throttle default for one-shot grants). */
  minSleepMs: number;
  /** Max time a suppressed (pending) fire may wait before forcing a wake despite the
   *  floor, in ms. `null`/omitted = no staleness deadline (the floor is absolute and a
   *  suppressed burst only flushes when the floor window elapses or a new fire is due). */
  maxStalenessMs?: number | null;
  /** Leading edge (default `true`): when the subscriber has been idle (never woken),
   *  the first fire wakes IMMEDIATELY rather than waiting out a floor window. `false` =
   *  trailing edge — anchor the floor on the first pending fire and wait `minSleepMs`. */
  leadingEdge?: boolean;
}

/** One fire that occurred — the unit that gets coalesced. `T` is the host's payload. */
export interface Fire<T> {
  /** Epoch ms the fire occurred (for ordering + staleness). */
  at: number;
  /** The host payload carried on this fire (an event key, a delivery row, …). */
  payload: T;
  /** When true, this fire bypasses the floor and wakes the subscriber now. */
  urgent?: boolean;
}

/** Per-subscriber state the host persists between evaluations. */
export interface FloorState<T> {
  /** Epoch ms of the last actual wake fired for this subscriber. `null` = never woken. */
  lastWokenAt: number | null;
  /** Suppressed fires accumulated since `lastWokenAt`, oldest→newest. */
  pending: Fire<T>[];
}

/** A fresh, never-woken, nothing-pending state. */
export function emptyFloorState<T>(): FloorState<T> {
  return { lastWokenAt: null, pending: [] };
}

/** The union a single coalesced wake carries. */
export interface Coalesced<T> {
  /** How many fires folded into this one wake (`1` for a non-coalesced wake). */
  count: number;
  /** Every folded fire, oldest→newest. */
  fires: Fire<T>[];
  /** The most recent fire — the "headline" for the wake turn. */
  latest: Fire<T>;
  /** True if any folded fire was urgent. */
  urgent: boolean;
}

/** The verdict of a floor evaluation. */
export type FloorDecision<T> =
  | {
      /** Wake the subscriber now. */
      wake: true;
      /** The union to deliver (one wake for all coalesced fires). */
      coalesced: Coalesced<T>;
      /** The post-wake state (lastWokenAt advanced, pending cleared). Persist it. */
      state: FloorState<T>;
    }
  | {
      /** Suppress for now — within the floor and not yet stale/urgent. */
      wake: false;
      /** The carried-forward state (pending retained). Persist it. */
      state: FloorState<T>;
      /** Epoch ms the next wake becomes due (schedule a tick at/after this). `null`
       *  only when there is nothing pending — a future fire is the only trigger. */
      dueAt: number | null;
    };

/** Fold a non-empty list of fires into their union. */
export function coalesce<T>(fires: Fire<T>[]): Coalesced<T> {
  if (fires.length === 0) throw new Error('coalesce: empty fires');
  return {
    count: fires.length,
    fires,
    latest: fires[fires.length - 1],
    urgent: fires.some((f) => f.urgent === true),
  };
}

const normMinSleep = (cfg: FloorConfig): number => (cfg.minSleepMs > 0 ? cfg.minSleepMs : 0);

/**
 * The epoch ms at which a subscriber with `pending` fires is next ALLOWED or FORCED to
 * wake — the floor-allowed time, pulled earlier by a staleness deadline if configured.
 * `null` when nothing is pending (only a fresh fire can trigger a wake).
 *
 * Anchor for the floor window:
 *   - already woken once → `lastWokenAt + minSleep`.
 *   - never woken, leading edge → `now`-equivalent (the first fire may wake immediately,
 *     so `firstPendingAt` is the floor-allowed instant).
 *   - never woken, trailing edge → `firstPendingAt + minSleep`.
 */
export function nextDueAt<T>(opts: {
  lastWokenAt: number | null;
  pending: Fire<T>[];
  cfg: FloorConfig;
}): number | null {
  const { lastWokenAt, pending, cfg } = opts;
  if (pending.length === 0) return null;
  const minSleep = normMinSleep(cfg);
  const firstAt = pending[0].at;
  const leading = cfg.leadingEdge !== false;
  const floorAllowedAt =
    lastWokenAt != null
      ? lastWokenAt + minSleep
      : leading
        ? firstAt // leading edge + never woken → allowed at the first fire
        : firstAt + minSleep;
  const staleAt = cfg.maxStalenessMs != null ? firstAt + cfg.maxStalenessMs : null;
  return staleAt != null ? Math.min(floorAllowedAt, staleAt) : floorAllowedAt;
}

/**
 * Evaluate one subscriber's wake floor given the fires pending RIGHT NOW (which may
 * include a just-arrived fire the caller has appended). The single entry point both the
 * pump (each tick, pending = the subscriber's due deliveries) and an event-driven caller
 * (pending = state.pending + the new fire) use.
 *
 * Wakes when ANY of: a pending fire is `urgent`; the floor has no throttle (`minSleepMs<=0`);
 * the floor-allowed instant has arrived (`now >= nextDueAt`); or the staleness deadline passed.
 * Otherwise suppresses and reports `dueAt` so the host can schedule the flush.
 */
export function decideWake<T>(opts: {
  lastWokenAt: number | null;
  pending: Fire<T>[];
  now: number;
  cfg: FloorConfig;
}): FloorDecision<T> {
  const { lastWokenAt, pending, now, cfg } = opts;
  if (pending.length === 0) {
    return { wake: false, state: { lastWokenAt, pending: [] }, dueAt: null };
  }
  const urgent = pending.some((f) => f.urgent === true);
  const dueAt = nextDueAt({ lastWokenAt, pending, cfg });
  if (urgent || (dueAt != null && now >= dueAt)) {
    return {
      wake: true,
      coalesced: coalesce(pending),
      state: { lastWokenAt: now, pending: [] },
    };
  }
  return { wake: false, state: { lastWokenAt, pending }, dueAt };
}

/**
 * Append a freshly-arrived fire to a subscriber's state and evaluate. Convenience over
 * {@link decideWake} for event-driven callers that hold {@link FloorState} in hand.
 */
export function onFire<T>(opts: {
  state: FloorState<T>;
  fire: Fire<T>;
  now: number;
  cfg: FloorConfig;
}): FloorDecision<T> {
  const { state, fire, now, cfg } = opts;
  const pending = [...state.pending, fire];
  return decideWake({ lastWokenAt: state.lastWokenAt, pending, now, cfg });
}

/**
 * Whether a wake at `now` falls inside the floor window of the last one — i.e. should be
 * SUPPRESSED. `urgent` always returns false (never suppress an urgent wake). This is the
 * debounce half on its own, for callers (the pot) that drop suppressed fires rather than
 * coalescing a payload union.
 */
export function withinFloor(opts: {
  lastWokenAt: number | null;
  minSleepMs: number;
  now: number;
  urgent?: boolean;
}): boolean {
  if (opts.urgent) return false;
  if (opts.lastWokenAt == null) return false;
  return opts.now - opts.lastWokenAt < Math.max(0, opts.minSleepMs);
}

/**
 * Clamp a requested future wake time up to `now + minSleepMs` — used for a self-declared
 * time wake so a confused caller can't schedule a wake inside its own floor.
 */
export function clampToFloor(opts: {
  requestedAt: number;
  minSleepMs: number;
  now: number;
}): { at: number; clamped: boolean } {
  const min = opts.now + Math.max(0, opts.minSleepMs);
  if (opts.requestedAt < min) return { at: min, clamped: true };
  return { at: opts.requestedAt, clamped: false };
}
