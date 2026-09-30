import type { AccountEgress } from '../deployment/account-pool';

/**
 * Provider-neutral account selected for one upstream attempt.
 *
 * This contract deliberately lives outside gateway.ts: pools, lane descriptors, and
 * failover policy must not depend on the request-handler monolith merely to name an
 * account. Credential/egress behavior remains explicit instead of being hidden behind
 * a provider-shaped `any` bag.
 */
export interface ActiveAccount {
  accountId: string;
  token(): Promise<string>;
  invalidateToken?(): void;
  /** Per-account upstream egress. Singular/legacy; superseded by a non-empty `egressPool`. */
  egress?: AccountEgress;
  /** Rotating egress bindings for one account; callers skip entries on per-IP cooldown. */
  egressPool?: AccountEgress[];
}

/** Why a caller is clearing a park early — the pool logs it and (for `transport`) bounds it. */
export type AccountReadmitReason = 'transport' | 'store' | 'admin';

export interface AccountReadmitOptions {
  reason?: AccountReadmitReason;
  /**
   * Refuse to clear a park whose remaining duration exceeds this bound. The egress-probe
   * transport-recovery path passes the circuit-open ceiling: a transport circuit can only
   * ever have parked an account for at most that long, so a park that outlives it was a
   * measured usage WALL (a 5h/7d 429 reset) that a healthy proxy does NOT cure — clearing it
   * re-admitted walled accounts into rotation and the fleet re-burned every one of them
   * (plan codex-auto-route-all-walled-fail-fast-2026-09-05, D-001).
   */
  maxParkMs?: number;
}

/** Inputs to `AccountPool.earliestAvailableAt` — the pool's RECOVERY HORIZON. */
export interface AccountRecoveryHorizonOptions {
  /** Clock override (epoch ms); defaults to the pool's own `now()`. */
  now?: number;
  /** The shared health key: an UNPARKED entry scoring `Infinity` is not serviceable now. */
  keyOf?: (account: ActiveAccount) => number;
  /**
   * When the caller knows an instant the account recovers OUTSIDE the pool's own park (a
   * durable rate-hint window reset, a governor pause), return it here; the horizon for that
   * entry is the LATER of its park and this instant. `undefined` ⇒ no external knowledge.
   */
  recoverAtOf?: (account: ActiveAccount) => number | undefined;
}

/** A parked (out-of-rotation) account: when it was parked and until when. */
export interface AccountParkState {
  parkedAt: number;
  until: number;
}

/**
 * Shared account-selection/failover contract used by every cloud gateway lane.
 * `active()` may advance a pool cursor; read-only callers use `peek()` or `entries()`.
 */
export interface AccountPool {
  /** Pick the next unpinned account. A caller may supply the shared health key (lower is better);
   *  omitting it preserves the pool's round-robin behavior exactly. */
  active(keyOf?: (account: ActiveAccount) => number): ActiveAccount;
  /** Mark one account exhausted and choose a replacement, optionally through the same health key. */
  onExhausted(
    exhaustedId: string,
    resetAt: number,
    keyOf?: (account: ActiveAccount) => number,
  ): ActiveAccount | null;
  /** Resolve an account-affinity pin without silently substituting another account. */
  select?(accountId: string): ActiveAccount | null;
  /** Clear a transport/rate pause early. Returns true iff a park was actually cleared; a
   *  `maxParkMs`-bounded call REFUSES (false) a park longer than the bound — see AccountReadmitOptions. */
  readmit?(accountId: string, opts?: AccountReadmitOptions): boolean;
  /**
   * The pool's RECOVERY HORIZON: 0 when any entry can serve NOW (unparked AND `keyOf` finite),
   * else the earliest epoch ms at which any entry is expected back (its park expiry, raised by
   * `recoverAtOf` when the caller knows a later external reset), or `Infinity` when no entry has
   * a known recovery instant. The codex 429 ladder absorbs only when this is within its budget.
   */
  earliestAvailableAt?(opts?: AccountRecoveryHorizonOptions): number;
  /** The park an account is currently under, or undefined when it is in rotation. */
  parkState?(accountId: string): AccountParkState | undefined;
  /** Atomically replace live entries without changing the pool object held by the gateway. */
  reload?(next: readonly ActiveAccount[]): void;
  /** Accounts currently in rotation, optionally filtered by an additional health predicate. */
  healthyCount?(extra?: (accountId: string) => boolean): number;
  /** Total entries, including temporarily exhausted or paused accounts. */
  size?(): number;
  /** Non-advancing current-best account for read-only callers. */
  peek?(): ActiveAccount;
  /** Non-advancing snapshot used by health probes and registry diagnostics. */
  entries?(): readonly ActiveAccount[];
  /** Milliseconds since an account last rejoined rotation, when known. */
  msSinceReadmit?(accountId: string, nowMs?: number): number | undefined;
}
