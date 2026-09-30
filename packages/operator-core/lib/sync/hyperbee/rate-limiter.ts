/**
 * rate-limiter — EN-2 (P-RATE) per-member op rate limiter (shared-hive owner
 * enforcement, plan `shared-hive-owner-enforcement-2026-06-19`, Phase EN-2).
 *
 * The owner's first ENFORCEMENT teeth: an owner-set per-member rate cap causes
 * every HONEST peer to DROP a member's over-cap ops at write/op admission, so a
 * flooding member can never make the flood canonical (it is dropped by all honest
 * peers, never merged into PG). The policy itself (the caps) is the owner-signed
 * `hive_policy.rate` record from EN-1; this module is the PURE decider that the
 * admission seam (boot.ts merge driver's `applyImpl`) consults per op.
 *
 * ── Why this is a DETERMINISTIC, CONVERGENT, BOUNDED windowed counter ──
 *
 * The hard constraint of a P2P federated hive: honest peers must CONVERGE on the
 * same canonical state, so the drop decision must be a deterministic function of
 * the op STREAM, not of local wall-clock arrival timing (two peers receiving a
 * flood at different instants must still drop the same excess, or they diverge).
 *
 * The mechanism that makes this work without consensus:
 *   1. The limiter is keyed PER AUTHOR (`github_user_id`). Every op from one
 *      author originates from that author's single append-only log, and every
 *      honest peer reads that one log in identical append-index order. So an
 *      author's ops are processed in the SAME order on every honest peer.
 *   2. Windows are TUMBLING and absolute, computed from the op's own write-time
 *      `ts` (epoch ms): `windowIndex = floor(ts / windowMs)`. Not the receiver's
 *      clock — so the windowing is intrinsic to the op, identical everywhere.
 *   3. Within a `(author, class, window)` we admit the FIRST `cap` ops (in log
 *      order) and drop the rest. Same input order + same cap ⇒ same admit/drop
 *      set on every honest peer ⇒ exact convergence at the fixpoint.
 *
 * Idempotency (re-folds): the substrate re-applies winning ops on a cursor reset
 * / full re-fold. We remember ADMITTED opIds per window and short-circuit a
 * replay to its prior `admit`. A DROPPED op is NOT remembered — yet it is
 * re-dropped deterministically, because the window's admitted count is already at
 * `cap` and never moves. This is the key memory property: dropped ops cost O(1),
 * so an unbounded flood cannot grow state — per `(author, class, window)` we hold
 * at most `cap` opIds. Window proliferation is bounded by pruning windows older
 * than `retentionWindows` behind the per-(author,class) high-water-mark.
 *
 * Anti-evasion clamp: a malicious author controls its own op `ts`, so it could
 * try to spread a burst across many future windows to stay under cap. We clamp
 * each op's `ts` into `[hwm - windowMs, hwm + windowMs]` where `hwm` is the
 * limiter's monotonic high-water-mark of processed op times for that
 * `(author, class)`. `hwm` advances by at most one window per op, so a ts-ramp
 * collapses back into the live window and trips the cap — the attack degenerates
 * into "send at the allowed rate", which is the limiter working. The residual
 * (an attacker pacing exactly at the cap by honestly slow-ramping `ts`) is just
 * obeying the limit. See findings-EN-2.md for the honest trust-model write-up.
 *
 * ── Forged-op-time DETECTION (WI-268) — convergent, no wall-clock ──
 *
 * The clamp above bounds the residual's MEMORY/OOM blast radius but cannot make a
 * slow forged-`ts` ramp trip the per-window cap (that is the inherent limit of any
 * convergent op-time limiter). We close it on the OBSERVABILITY plane instead of
 * the drop plane: a client ramping forged FUTURE timestamps to pace under the cap
 * necessarily drives its op-time high-water-mark AHEAD of the honest population's
 * — and because the clamp lets `hwm` advance by at most one window per op, getting
 * N windows ahead REQUIRES ≥N ramping ops (a single stray future op cannot do it).
 * So `snapshot()` flags `suspectedTimestampSkew` when an author's hwm sits more
 * than `skewThresholdWindows` ahead of the highest OTHER author's hwm in the same
 * class. This is a pure function of the per-author hwm values — identical on every
 * honest peer at the fixpoint — so it stays convergent and `Date.now`-free like the
 * rest of the module. It is DETECTION ONLY: the owner sees the flag and manually
 * revokes (`substrate:revoke_contributor` + the C-001 re-key); it never gates a
 * drop, because a cross-author / wall-clock drop decision would diverge honest
 * peers. The flag self-clears once honest real-time traffic surpasses the forged
 * horizon. See findings-EN-2.md §forged-op-time + WI-268.
 *
 * No `Date.now()`: the windowing + pruning clock is derived ENTIRELY from the op
 * stream's own timestamps (the high-water-mark), so this module is safe in the
 * substrate sidecar / worker paths where `Date.now` is unavailable, AND it stays
 * deterministic (a real clock would make the fixpoint host-dependent).
 *
 * Default-off: a `cap` of `undefined` (no policy / class unset) returns
 * `unlimited` and touches NO state — an un-policed hive pays nothing and behaves
 * exactly as before EN-2.
 */

// Type-only import (erased at runtime — the limiter stays a pure, dependency-free
// module). Aliasing the cap shape to EN-1's CANONICAL `HivePolicyRate` is the
// single source of truth: if EN-1's policy.rate shape changes, this file fails to
// typecheck rather than silently drifting (su-3a2ba's "don't fork the schema").
import type { HivePolicyRate } from '../../hive-policy-schema';

/** The three rate classes an op can be counted against (the `hive_policy.rate`
 *  axes). NOTE on `prs`: there is no PR op on the substrate — pull requests ride
 *  the CODE plane (git-sync → main, Brief AH), not the content substrate. The
 *  class exists so the policy type + limiter are complete and a future code-plane
 *  enforcer can reuse this same decider, but the EN-2 substrate wiring only feeds
 *  `ops` + `rows`. See findings-EN-2.md §scope. */
export type RateClass = 'ops' | 'rows' | 'prs';

/** The owner-set caps from EN-1's `hive_policy.rate` — aliased to the canonical
 *  `HivePolicyRate` so the two never drift. Each axis is per its natural window
 *  (min / hour / day). An `undefined` axis ⇒ no limit on that class. A finite `0`
 *  ⇒ block ALL ops of that class (a deliberate owner freeze). A negative /
 *  non-finite value is ignored by `capForClass` (treated as unset) — defensive
 *  against a malformed federated policy. */
export type RateCaps = HivePolicyRate;

/** Window length per class, in ms. */
export const RATE_WINDOW_MS: Readonly<Record<RateClass, number>> = Object.freeze({
  ops: 60_000, // per minute
  rows: 3_600_000, // per hour
  prs: 86_400_000, // per day
});

/** Resolve the cap for a class from the policy's `rate` object. Returns
 *  `undefined` (⇒ unlimited) for an unset / negative / non-finite axis; a finite
 *  `>= 0` value (incl. 0 = block-all) otherwise. */
export function capForClass(caps: RateCaps | null | undefined, cls: RateClass): number | undefined {
  if (!caps) return undefined;
  const raw = cls === 'ops' ? caps.opsPerMin : cls === 'rows' ? caps.rowsPerHour : caps.prsPerDay;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
  return raw;
}

/** The decision for one op against one class. `unlimited` = no cap set for the
 *  class (no state touched). `admit` / `drop` = within / over cap. */
export type RateOutcome = 'admit' | 'drop' | 'unlimited';

export interface RateCheck {
  /** The op author's resolved GitHub user id (the attribution key). */
  authorId: number;
  /** Which class to count this op against. */
  cls: RateClass;
  /**
   * A STABLE per-op identity, used to make re-applies (cursor reset / full
   * re-fold) idempotent. Must be identical for the same op across folds and
   * distinct across different ops from the same author. The wiring builds it from
   * the unforgeable source-log key + table + key + ts + hlc.
   */
  opId: string;
  /** The op's own write-time (epoch ms) — the intrinsic windowing clock. */
  tsMs: number;
  /** The owner-set cap for this class (from `capForClass`). `undefined` ⇒ no
   *  limit (returns `unlimited`, touches no state). */
  cap: number | undefined;
}

interface Bucket {
  /** Count of ADMITTED ops in this window (monotonic up to `cap`). */
  count: number;
  /** Admitted opIds in this window (for replay idempotency). Size ≤ cap. */
  opIds: Set<string>;
}

interface ClassState {
  /** windowIndex → bucket. Pruned to the recent `retentionWindows`. */
  windows: Map<number, Bucket>;
  /** Monotonic high-water-mark of processed (clamped) op times for the
   *  anti-evasion clamp + pruning floor. `null` until the first op. */
  hwm: number | null;
}

export interface RateLimiterOptions {
  /** Keep buckets within this many windows behind the high-water-mark; prune
   *  older ones (bounds memory + window proliferation). Default 3. Must be ≥ 1.
   *  A re-fold of ops older than this re-creates an empty bucket and re-admits
   *  them — harmless (those windows are long past the live enforcement edge). */
  retentionWindows?: number;
  /**
   * Forged-op-time DETECTION threshold (WI-268), in windows. An author whose
   * current op-time high-water-mark sits MORE than this many windows ahead of the
   * highest OTHER author's hwm (same class) is flagged `suspectedTimestampSkew` in
   * `snapshot()` — the convergent signature of a client forging FUTURE op
   * timestamps to ramp past the per-window cap (see the §forged-op-time DETECTION
   * note above). Default 5. Must be ≥ 1. This is the FP/sensitivity knob: the gap
   * is only reachable by ≥N ramping ops (the ±1-window clamp caps hwm growth at one
   * window/op), so a single stray far-future op never trips it; the threshold's job
   * is to stay above honest inter-member CLOCK SKEW (members stamp ops on their own
   * wall clocks). 5 ⇒ ~5min for `ops`, ~5h for `rows` — comfortably above sane
   * skew, well below any real ramp. Detection only — never gates a drop. */
  skewThresholdWindows?: number;
}

/** Per-member observability row (for the owner GUI "member X at N/cap"). */
export interface RateStateRow {
  authorId: number;
  cls: RateClass;
  /** Admitted count in the current (high-water-mark) window. */
  count: number;
  /** The cap in force for the class, or null when unlimited (no cap tracked). */
  cap: number | null;
  /** True when the member is AT/over cap in the current window — the explicit
   *  "throttled" degraded signal the owner GUI shows (EI-1618 honest-not-hidden:
   *  a throttled member is visible, never silently dropped). */
  throttled: boolean;
  windowMs: number;
  /** The high-water-mark window's start (epoch ms), for display. */
  windowStartMs: number;
  /** The author's current high-water-mark window INDEX for this class
   *  (`floor(hwm / windowMs)`) — the basis for the cross-author skew comparison. */
  hwmWindow: number;
  /** WI-268: how many windows this author's hwm sits AHEAD of the highest OTHER
   *  author's hwm in the same class (0 if it is not ahead, or if no other author
   *  is tracked for the class — a lone author has no honest baseline). Convergent:
   *  computed from the per-author hwm values, which are identical on every honest
   *  peer at the merge fixpoint (each author's log is read in the same order). */
  skewWindows: number;
  /** WI-268: `skewWindows > skewThresholdWindows` — the convergent forged-op-time
   *  signature (a client ramping forged FUTURE timestamps to pace under the
   *  per-window cap). Surfaced for the owner to MANUALLY revoke
   *  (`substrate:revoke_contributor` + the C-001 re-key); it never gates a drop
   *  (a wall-clock/cross-author drop would diverge honest peers). */
  suspectedTimestampSkew: boolean;
}

/**
 * The per-member, per-class deterministic windowed op limiter. One instance per
 * booted harness substrate (created in boot.ts). Pure w.r.t. wall-clock — its
 * notion of "now" is the high-water-mark of op timestamps it has processed.
 */
export class MemberRateLimiter {
  private readonly retentionWindows: number;
  private readonly skewThresholdWindows: number;
  /** `${authorId}:${cls}` → ClassState. */
  private readonly state = new Map<string, ClassState>();

  constructor(opts?: RateLimiterOptions) {
    const r = opts?.retentionWindows;
    this.retentionWindows = typeof r === 'number' && Number.isFinite(r) && r >= 1 ? Math.floor(r) : 3;
    const s = opts?.skewThresholdWindows;
    this.skewThresholdWindows = typeof s === 'number' && Number.isFinite(s) && s >= 1 ? Math.floor(s) : 5;
  }

  private key(authorId: number, cls: RateClass): string {
    return `${authorId}:${cls}`;
  }

  private locate(authorId: number, cls: RateClass): ClassState {
    const k = this.key(authorId, cls);
    let cs = this.state.get(k);
    if (!cs) {
      cs = { windows: new Map(), hwm: null };
      this.state.set(k, cs);
    }
    return cs;
  }

  /** Pure peek for one (author,class): does this op admit, and at which window?
   *  No mutation — `decide` commits only after evaluating EVERY class, so a
   *  dropped op never consumes any class's budget. */
  private peek(
    cs: ClassState,
    cls: RateClass,
    opId: string,
    tsMs: number,
    cap: number,
  ): { admit: boolean; replay: boolean; windowIndex: number; clampedTs: number } {
    const windowMs = RATE_WINDOW_MS[cls];
    // Anti-evasion clamp: bound the op's effective time into one window of the
    // monotonic high-water-mark, so a ts-ramp can't outrun the live window.
    const hwm = cs.hwm ?? tsMs;
    const clampedTs = Math.max(hwm - windowMs, Math.min(tsMs, hwm + windowMs));
    const windowIndex = Math.floor(clampedTs / windowMs);
    const bucket = cs.windows.get(windowIndex);
    if (bucket?.opIds.has(opId)) {
      // Replay of an already-admitted op ⇒ admit, no recount (idempotent re-fold).
      return { admit: true, replay: true, windowIndex, clampedTs };
    }
    // count < cap ⇒ admit; cap === 0 ⇒ block-all (0 < 0 is false ⇒ drop). A
    // dropped op is never remembered, so a re-fold re-drops deterministically
    // (the admitted count never moves).
    const count = bucket?.count ?? 0;
    return { admit: count < cap, replay: false, windowIndex, clampedTs };
  }

  /** Commit one ADMITTED new op into its window bucket (count + remember opId). */
  private commit(cs: ClassState, windowIndex: number, opId: string): void {
    let bucket = cs.windows.get(windowIndex);
    if (!bucket) {
      bucket = { count: 0, opIds: new Set() };
      cs.windows.set(windowIndex, bucket);
    }
    bucket.count += 1;
    bucket.opIds.add(opId);
  }

  /**
   * Decide one op against SEVERAL classes ATOMICALLY (e.g. a content put counts
   * against both `ops` and `rows`). The op is admitted iff EVERY capped class is
   * under cap; if any class is over cap the op is dropped and NO class's budget is
   * consumed (so a drop on `rows` can't phantom-spend an `ops` slot). `undefined`
   * caps are skipped; all-undefined ⇒ `unlimited` (no state touched).
   * Deterministic given the per-author processing order (identical on every
   * honest peer) ⇒ the surviving canonical set converges.
   */
  decide(
    authorId: number,
    opId: string,
    tsMs: number,
    classes: ReadonlyArray<{ cls: RateClass; cap: number | undefined }>,
  ): RateOutcome {
    const active = classes.filter((c) => c.cap !== undefined) as Array<{ cls: RateClass; cap: number }>;
    if (active.length === 0) return 'unlimited';
    if (!Number.isFinite(authorId) || !Number.isFinite(tsMs)) return 'admit';

    const peeks = active.map(({ cls, cap }) => {
      const cs = this.locate(authorId, cls);
      return { cls, cs, ...this.peek(cs, cls, opId, tsMs, cap) };
    });
    const overallAdmit = peeks.every((p) => p.admit);

    for (const p of peeks) {
      const windowMs = RATE_WINDOW_MS[p.cls];
      // Commit the count ONLY on an overall admit of a genuinely-new op (a replay
      // is already counted). On a drop, commit nothing — the op spends no budget.
      if (overallAdmit && !p.replay) this.commit(p.cs, p.windowIndex, opId);
      // Advance the high-water-mark + prune for every processed class, admit or
      // drop (the clock tracks the op stream; pruning bounds memory).
      this.advance(p.cs, p.clampedTs, windowMs);
    }
    return overallAdmit ? 'admit' : 'drop';
  }

  /**
   * Decide one op against a single class — a thin wrapper over `decide`.
   * Returns `unlimited` without touching state when no cap is set for the class.
   */
  check(c: RateCheck): RateOutcome {
    return this.decide(c.authorId, c.opId, c.tsMs, [{ cls: c.cls, cap: c.cap }]);
  }

  /** Advance the high-water-mark + prune windows older than the retention floor. */
  private advance(cs: ClassState, clampedTs: number, windowMs: number): void {
    cs.hwm = cs.hwm === null ? clampedTs : Math.max(cs.hwm, clampedTs);
    const hwmWindow = Math.floor(cs.hwm / windowMs);
    const floor = hwmWindow - this.retentionWindows;
    if (floor <= 0) return;
    for (const idx of cs.windows.keys()) {
      if (idx < floor) cs.windows.delete(idx);
    }
  }

  /**
   * Observability snapshot: the current-window admitted count vs cap for every
   * tracked (author, class). `caps` supplies the live cap per class so a class
   * whose cap was unset reports `cap: null`. Cheap — iterates the bounded state.
   */
  snapshot(caps?: RateCaps | null): RateStateRow[] {
    // Pass 1: base row per tracked (author,class), and the per-class set of author
    // hwm-windows (the basis for the WI-268 cross-author skew). Each author's
    // hwmWindow is a pure function of that author's own (identically-ordered) log,
    // so this map — and therefore the skew below — is identical on every honest
    // peer at the merge fixpoint (no Date.now, no interleaving dependence).
    const rows: Array<RateStateRow & { _hwmWindow: number }> = [];
    const hwmByClass = new Map<RateClass, Array<{ authorId: number; hwmWindow: number }>>();
    for (const [k, cs] of this.state) {
      if (cs.hwm === null) continue;
      const sep = k.lastIndexOf(':');
      const authorId = Number(k.slice(0, sep));
      const cls = k.slice(sep + 1) as RateClass;
      const windowMs = RATE_WINDOW_MS[cls];
      const hwmWindow = Math.floor(cs.hwm / windowMs);
      const bucket = cs.windows.get(hwmWindow);
      const count = bucket?.count ?? 0;
      const cap = capForClass(caps, cls) ?? null;
      rows.push({
        authorId,
        cls,
        count,
        cap,
        throttled: cap !== null && count >= cap,
        windowMs,
        windowStartMs: hwmWindow * windowMs,
        hwmWindow,
        skewWindows: 0,
        suspectedTimestampSkew: false,
        _hwmWindow: hwmWindow,
      });
      let arr = hwmByClass.get(cls);
      if (!arr) hwmByClass.set(cls, (arr = []));
      arr.push({ authorId, hwmWindow });
    }
    // Pass 2: how far each author's hwm sits AHEAD of the highest OTHER author's
    // hwm in the same class. A lone author (no other baseline) ⇒ skew 0 (we cannot
    // distinguish a forger from the only voice; a lone over-cap flooder is still
    // throttled per-window). The ±1-window clamp makes an N-window gap require ≥N
    // ramping ops, so a single stray future op never trips the flag.
    for (const r of rows) {
      const peers = hwmByClass.get(r.cls)!;
      let maxOther = -Infinity;
      for (const p of peers) {
        if (p.authorId === r.authorId) continue;
        if (p.hwmWindow > maxOther) maxOther = p.hwmWindow;
      }
      if (maxOther !== -Infinity) {
        r.skewWindows = Math.max(0, r._hwmWindow - maxOther);
        r.suspectedTimestampSkew = r.skewWindows > this.skewThresholdWindows;
      }
    }
    return rows.map(({ _hwmWindow, ...row }) => row);
  }

  /** Number of tracked (author,class) entries — test/observability aid. */
  size(): number {
    return this.state.size;
  }

  /** Total live window buckets across all (author,class) — the anti-OOM gauge.
   *  Bounded by `size() * (retentionWindows + 1)` no matter how large the flood
   *  (pruning keeps only the recent windows; dropped ops add no bucket). */
  windowCount(): number {
    let n = 0;
    for (const cs of this.state.values()) n += cs.windows.size;
    return n;
  }
}
