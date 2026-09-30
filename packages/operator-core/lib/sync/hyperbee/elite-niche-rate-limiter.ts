/**
 * elite-niche-rate-limiter — F1-6 / P-014 (federated-scout-gym, D-005 hole 3):
 * a PER-(source-author, niche) deterministic windowed admit-first-cap counter.
 *
 * WHY a per-NICHE axis (the per-source `rowsPerHour` cap already exists): niche
 * (descriptor) classification is AUTHOR-side, and the empty-niche NOVELTY-GIFT
 * bonus rewards landing an elite in a locally-empty niche. So a source can churn a
 * SINGLE locally-empty niche — re-pushing to repeatedly harvest that niche's gift —
 * while staying under its per-source TOTAL rows/hour budget (which bounds volume,
 * not concentration). This cap bounds how many elite puts ONE source can land in
 * ONE niche per window, so the farm degenerates into "occupy the niche once".
 *
 * SIBLING, NOT A FORK, of {@link import('./rate-limiter').MemberRateLimiter}. That
 * limiter is keyed (author, class) and its snapshot + WI-268 cross-author skew
 * detection are coupled to that 2-part key; adding a 3rd (niche) dimension would
 * force a rework of that convergence-critical snapshot. So this mirrors its PROVEN
 * convergence discipline in a focused, independently-testable decider and REUSES
 * its shared primitives (RATE_WINDOW_MS, RateOutcome) rather than destabilising the
 * enforcement limiter. Same determinism contract as MemberRateLimiter:
 *   - keyed per (authorId, nicheKey): every op from one source rides that source's
 *     single append-only log, read in identical append order on every honest peer,
 *     so its per-niche stream is ordered identically everywhere;
 *   - TUMBLING op-ts windows (`floor(clampedTs / windowMs)`) — intrinsic to the op,
 *     NO `Date.now`, identical on every peer;
 *   - admit the FIRST `cap` ops per (author, niche, window), drop the rest; a
 *     dropped op is NEVER remembered (O(1), so a flood cannot grow state) yet is
 *     re-dropped deterministically because the window's admitted count is already
 *     at `cap`; admitted opIds ARE remembered so a cursor-reset re-fold is
 *     idempotent (replay ⇒ prior admit, no recount);
 *   - anti-evasion clamp: each op's ts is bounded into `[hwm - windowMs, hwm +
 *     windowMs]` (hwm = monotonic high-water-mark of processed op times for the
 *     key), so a forged ts-ramp collapses into the live window and trips the cap;
 *   - retention pruning behind the per-key hwm bounds memory + window proliferation.
 *
 * Default-off: an `undefined` cap ⇒ `unlimited`, touching NO state — an un-policed
 * hive (or one with no per-niche cap set) pays nothing and behaves exactly as before.
 */

import { RATE_WINDOW_MS, type RateOutcome } from './rate-limiter';

interface Bucket {
  /** Count of ADMITTED ops in this window (monotonic up to `cap`). */
  count: number;
  /** Admitted opIds in this window (replay idempotency). Size ≤ cap. */
  opIds: Set<string>;
}

interface KeyState {
  /** windowIndex → bucket. Pruned to the recent `retentionWindows`. */
  windows: Map<number, Bucket>;
  /** Monotonic high-water-mark of processed (clamped) op times (anti-evasion
   *  clamp + pruning floor). `null` until the first op. */
  hwm: number | null;
}

export interface EliteNicheRateLimiterOptions {
  /** Window length in ms. Default `RATE_WINDOW_MS.rows` (per hour — the natural
   *  window for the `elitesPerNichePerHour` cap). */
  windowMs?: number;
  /** Keep buckets within this many windows behind the high-water-mark; prune older
   *  (bounds memory). Default 3. Must be ≥ 1. */
  retentionWindows?: number;
}

/**
 * The per-(author, niche) deterministic windowed elite limiter. One instance per
 * booted harness substrate (created in boot.ts alongside the MemberRateLimiter).
 * Pure w.r.t. wall-clock — "now" is the high-water-mark of processed op times.
 */
export class EliteNicheRateLimiter {
  private readonly windowMs: number;
  private readonly retentionWindows: number;
  /** `${authorId}:${nicheKey}` → KeyState. */
  private readonly state = new Map<string, KeyState>();

  constructor(opts?: EliteNicheRateLimiterOptions) {
    const w = opts?.windowMs;
    this.windowMs = typeof w === 'number' && Number.isFinite(w) && w > 0 ? Math.floor(w) : RATE_WINDOW_MS.rows;
    const r = opts?.retentionWindows;
    this.retentionWindows = typeof r === 'number' && Number.isFinite(r) && r >= 1 ? Math.floor(r) : 3;
  }

  private key(authorId: number, nicheKey: string): string {
    // authorId is a bounded integer (github_user_id) and nicheKey is opaque; the
    // author segment can never contain ':' so the join is unambiguous.
    return `${authorId}:${nicheKey}`;
  }

  private locate(authorId: number, nicheKey: string): KeyState {
    const k = this.key(authorId, nicheKey);
    let ks = this.state.get(k);
    if (!ks) {
      ks = { windows: new Map(), hwm: null };
      this.state.set(k, ks);
    }
    return ks;
  }

  /**
   * Decide one elite put against the per-(author, niche) cap. `unlimited` when the
   * cap is unset (no state touched). Deterministic given the per-author log order
   * (identical on every honest peer) ⇒ the surviving canonical set converges.
   */
  decide(
    authorId: number,
    nicheKey: string,
    opId: string,
    tsMs: number,
    cap: number | undefined,
  ): RateOutcome {
    if (cap === undefined) return 'unlimited';
    // Malformed attribution / ts ⇒ do not gate (mirrors MemberRateLimiter.decide;
    // a fail-closed drop for unattributable ops is the caller's job, upstream).
    if (!Number.isFinite(authorId) || !Number.isFinite(tsMs) || !nicheKey) return 'admit';

    const ks = this.locate(authorId, nicheKey);
    const windowMs = this.windowMs;
    // Anti-evasion clamp into one window of the monotonic high-water-mark.
    const hwm = ks.hwm ?? tsMs;
    const clampedTs = Math.max(hwm - windowMs, Math.min(tsMs, hwm + windowMs));
    const windowIndex = Math.floor(clampedTs / windowMs);
    const bucket = ks.windows.get(windowIndex);

    let outcome: RateOutcome;
    if (bucket?.opIds.has(opId)) {
      // Replay of an already-admitted op ⇒ admit, no recount (idempotent re-fold).
      outcome = 'admit';
    } else {
      const count = bucket?.count ?? 0;
      // count < cap ⇒ admit; cap === 0 ⇒ block-all (0 < 0 is false ⇒ drop). A
      // dropped op is never remembered, so a re-fold re-drops deterministically.
      if (count < cap) {
        let b = bucket;
        if (!b) {
          b = { count: 0, opIds: new Set() };
          ks.windows.set(windowIndex, b);
        }
        b.count += 1;
        b.opIds.add(opId);
        outcome = 'admit';
      } else {
        outcome = 'drop';
      }
    }

    // Advance the high-water-mark + prune old windows (admit OR drop — the clock
    // tracks the op stream; pruning bounds memory).
    ks.hwm = ks.hwm === null ? clampedTs : Math.max(ks.hwm, clampedTs);
    const floor = Math.floor(ks.hwm / windowMs) - this.retentionWindows;
    if (floor > 0) {
      for (const idx of ks.windows.keys()) {
        if (idx < floor) ks.windows.delete(idx);
      }
    }
    return outcome;
  }

  /** Number of tracked (author, niche) entries — test/observability aid. */
  size(): number {
    return this.state.size;
  }

  /** Total live window buckets across all keys — the anti-OOM gauge (bounded by
   *  `size() * (retentionWindows + 1)` regardless of flood size). */
  windowCount(): number {
    let n = 0;
    for (const ks of this.state.values()) n += ks.windows.size;
    return n;
  }
}
