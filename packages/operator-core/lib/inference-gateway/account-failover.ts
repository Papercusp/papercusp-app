/**
 * Account failover + load-distribution pool for the inference gateway (EI-535).
 *
 * Two jobs:
 *   1. DISTRIBUTE the fleet's UNPINNED egress ACROSS the whole pool. `active()` round-robins over
 *      the accounts that still have budget, so concurrent load spreads evenly instead of piling onto
 *      one account. (Before 2026-06-18 the pool egressed the whole fleet through ONE fixed `active`
 *      account; under the fleet's concurrent opus load that single account short-term-429'd
 *      continuously while the other 6 accounts sat IDLE — the owner-reported "accounts unused / it's
 *      not a real rate limit, the router is broken" bug. The 5h-exhaustion failover below never fired
 *      for short-term/per-minute throttles, so nothing ever spread the load.)
 *   2. FAIL OVER off an account that's out of budget. `onExhausted` marks an account out of rotation
 *      until its reset (a 5h unified-budget exhaustion, a hard usage cap, or a short bare-429 pace),
 *      and hands the retry loop the next account that still has budget. An exhausted account rejoins
 *      the rotation once its reset passes. Only when ALL accounts are exhausted does egress pause.
 *
 * Header-pinned requests (`select`, x-papercusp-account) bypass round-robin and stay on their own
 * credential for cache-affinity — a bee keeps its warm per-credential cache regardless of rotation.
 *
 * Pure + synchronous (a small Map + a cursor); the credential refresh + token getters live in the
 * resolvers the entries wrap (launch.ts). `now()` is injectable for tests.
 */
import type {
  ActiveAccount,
  AccountPool,
  AccountParkState,
  AccountReadmitOptions,
  AccountRecoveryHorizonOptions,
} from './provider-contracts';

export interface FailoverPoolOptions {
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/** Weight of ONE in-flight request in the load-aware selection key, relative to the [0,1) utilization
 *  term. ≥1 so a single extra concurrent request outranks the ENTIRE utilization range — i.e. among
 *  accounts that all have headroom the LEAST-LOADED (fewest in-flight) wins, and utilization (residual
 *  budget) only breaks ties between equally-loaded accounts. This is the proactive load-balancing lever
 *  (load-aware-routing-2026-06-29): selection no longer waits for an account to be stressed before it
 *  spreads. Env-tunable. */
export const ACCOUNT_INFLIGHT_LOAD_WEIGHT = Number(process.env.PAPERCUSP_GATEWAY_INFLIGHT_LOAD_WEIGHT) || 1;
/** Cache-affinity tiebreak credit: how much "better" a soft-pinned account is TREATED as when deciding
 *  whether to yield it, so a sequential / single-session request KEEPS its warm per-credential cache
 *  (siblings within this margin do not displace the pin) but the pin YIELDS the moment a sibling is
 *  meaningfully less loaded — a concurrent pile-up on the pin (in-flight ≥ 1) or a climbing utilization
 *  band, WELL before the pinned account is maxed. Kept < ACCOUNT_INFLIGHT_LOAD_WEIGHT so even ONE extra
 *  in-flight request on the pin overcomes the credit and spreads load. Env-tunable. */
export const SOFT_PIN_AFFINITY_CREDIT = Number(process.env.PAPERCUSP_GATEWAY_SOFT_PIN_AFFINITY_CREDIT) || 0.5;
/** A flaky-proxy account (an unrecovered transport-failure streak) is bucketed behind EVERY clean
 *  account regardless of its load, so a clean account always wins — but it still ranks ahead of a
 *  paused / exhausted account (which scores Infinity). Large enough to dominate any realistic in-flight
 *  count, finite so two flaky accounts still order by their own load. */
const FLAKY_LOAD_BUCKET = 1e6;
/** A burn-governor THROTTLE is a pacing warning, not a measured wall. Keep it selectable when the
 *  whole pool is under pressure, but rank it behind every account whose projected burn is healthy.
 *  The bucket stays below the transport-degraded bucket: a serviceable-but-burning credential is a
 *  safer fallback than a credential whose upstream transport is actively failing. */
export const BURN_THROTTLE_LOAD_BUCKET = 1e5;

export type AccountBurnAction = 'none' | 'throttle' | 'shed';
export type AccountTransportHealth = 'healthy' | 'degraded' | 'unavailable';

/** One provider-reported capacity window. The scorer deliberately does not name a duration: Claude
 *  and Codex both expose 5h/7d windows today, while another provider may expose a different ladder.
 *  A window whose reset is at/before `now` describes expired budget and contributes zero load. */
export interface AccountCapacityWindow {
  utilization?: number;
  resetAt?: number;
}

/** Inputs to the pure load-aware selection key. All optional + defaulted so a partial / cold-start
 *  snapshot degrades gracefully (an unknown field reads as idle/healthy). */
export interface AccountLoadInputs {
  /** Governor hard-paused / egress-circuit-open / cold-start-hint paused right now ⇒ never pick. */
  paused?: boolean;
  /** A budget window is rejected by the server, or essentially full (util ≳ cap) ⇒ never pick — an
   *  exhausted account is UNUSABLE, not merely "slightly worse" than a healthy one. */
  exhausted?: boolean;
  /** An unrecovered upstream transport-failure streak (dead/flaky egress proxy) ⇒ bucket behind every
   *  clean account, but still ahead of a paused/exhausted one. */
  flaky?: boolean;
  /** Concurrent requests on this (model, account) governor — the PRIMARY load term. */
  inFlight?: number;
  /** Observed unified utilization fraction [0,1] — the residual-budget tiebreak among equal-load peers. */
  utilization?: number;
  /** Provider-reported capacity windows (for example 5h + 7d). The tightest ACTIVE window wins. */
  capacityWindows?: readonly AccountCapacityWindow[];
  /** At/above this utilization an active capacity window is a measured wall. Default 0.99. */
  capacityFullAt?: number;
  /** Clock used to expire capacity windows at their reset boundary. Omit only for timeless snapshots. */
  now?: number;
  /** Burn-governor pacing verdict. `shed` is out of the race; `throttle` is a finite fallback bucket. */
  burnAction?: AccountBurnAction;
  /** Transport health independent of quota. `unavailable` is out; `degraded` is the flaky bucket. */
  transportHealth?: AccountTransportHealth;
}

/**
 * Load-aware account selection key (LOWER = better) — the shared scoring the gateway uses for BOTH the
 * unpinned proactive pick and the soft-pin failover (load-aware-routing-2026-06-29). Pure + synchronous
 * so it is exhaustively unit-testable in isolation.
 *
 * Ordering, strongest first:
 *   1. paused / exhausted / SHED / unavailable transport / active full window → Infinity;
 *   2. degraded transport        → bucketed behind every serviceable transport (`FLAKY_LOAD_BUCKET`);
 *   3. burn THROTTLE             → bucketed behind non-burning accounts, but remains a fallback;
 *   4. in-flight count           → the PRIMARY load term (weighted ≥ the whole utilization range), so
 *                                  selection lands on the account with the LEAST live load — never piling
 *                                  onto one account while siblings idle;
 *   5. tightest active capacity-window utilization → residual-budget tiebreak among equal-load peers.
 *
 * An idle, clean, fresh-proxy account scores 0 (the happy path), so a caller can cheaply gate "is the
 * current pick already optimal?" on `key === 0`.
 */
export function accountLoadKey(i: AccountLoadInputs): number {
  const now = Number.isFinite(i.now) ? (i.now as number) : undefined;
  const fullAtRaw = Number.isFinite(i.capacityFullAt) ? (i.capacityFullAt as number) : 0.99;
  const fullAt = Math.min(1, Math.max(0, fullAtRaw));
  let capacityUtil = 0;
  let capacityExhausted = false;
  for (const window of i.capacityWindows ?? []) {
    const resetAt = Number.isFinite(window.resetAt) ? (window.resetAt as number) : undefined;
    if (now !== undefined && resetAt !== undefined && resetAt <= now) continue;
    const raw = Number.isFinite(window.utilization) ? (window.utilization as number) : 0;
    const util = Math.min(1, Math.max(0, raw));
    capacityUtil = Math.max(capacityUtil, util);
    if (util >= fullAt) capacityExhausted = true;
  }
  if (i.paused || i.exhausted || capacityExhausted || i.burnAction === 'shed' || i.transportHealth === 'unavailable') {
    return Infinity;
  }
  const inFlight = Number.isFinite(i.inFlight) ? Math.max(0, i.inFlight as number) : 0;
  const utilRaw = Number.isFinite(i.utilization) ? (i.utilization as number) : 0;
  const util = Math.max(capacityUtil, Math.min(1, Math.max(0, utilRaw)));
  const transportBucket = i.flaky || i.transportHealth === 'degraded' ? FLAKY_LOAD_BUCKET : 0;
  const burnBucket = i.burnAction === 'throttle' ? BURN_THROTTLE_LOAD_BUCKET : 0;
  return transportBucket + burnBucket + inFlight * ACCOUNT_INFLIGHT_LOAD_WEIGHT + util;
}

export function createFailoverPool(entries: readonly ActiveAccount[], opts: FailoverPoolOptions = {}): AccountPool {
  if (entries.length === 0) throw new Error('createFailoverPool: at least one account is required');
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  /** accountId → epoch ms its budget resets; an entry with a still-future value is skipped. */
  const exhaustedUntil = new Map<string, number>();
  /** accountId → epoch ms it was EARLY-readmitted via readmit() (the half-open proxy-recovered path,
   *  which deletes the exhaustedUntil entry). Observability-only, read solely by msSinceReadmit — the
   *  cold-rest causation probe (WI-3151). A NATURAL expiry needs no entry here: exhaustedUntil retains
   *  the (now-past) reset boundary, which msSinceReadmit reads directly. */
  const readmittedAt = new Map<string, number>();
  /** accountId → epoch ms the CURRENT park began (set in onExhausted alongside exhaustedUntil, cleared on
   *  readmit / reload-prune). Read by parkState() so the store↔pool reconciliation can tell whether a
   *  durable availability reading is NEWER than the park it would clear (plan
   *  codex-auto-route-all-walled-fail-fast-2026-09-05, P-008): a reading taken BEFORE the park says
   *  nothing about whether the park's cause has cleared. */
  const parkedAt = new Map<string, number>();
  /** Round-robin cursor — the NEXT index to consider, advanced on every `active()` so unpinned
   *  egress spreads across the whole pool instead of concentrating on one account. */
  let rrIdx = 0;
  /** The LIVE pool entries. Mutable so the gateway can HOT-RELOAD the account pool (B-HOT-1): an atomic
   *  swap via `reload()` re-points active()/onExhausted()/select() at the new set WITHOUT a gateway
   *  restart and WITHOUT changing this pool object's identity (the gateway holds this object for its
   *  whole lifetime). Initialised from the constructor `entries`. */
  let live: readonly ActiveAccount[] = entries.slice();

  const available = (e: ActiveAccount): boolean => {
    const until = exhaustedUntil.get(e.accountId);
    return until === undefined || until <= now();
  };

  /** The account to egress the next UNPINNED request through — round-robin across the accounts that
   *  still have budget, so the fleet's load distributes evenly. Falls back to plain round-robin
   *  (including paused accounts) only when EVERY account is currently exhausted, so the gateway still
   *  picks SOMETHING (the retry loop / governor then paces it) rather than starving. */
  function active(keyOf?: (account: ActiveAccount) => number): ActiveAccount {
    let seedIdx = -1;
    for (let step = 0; step < live.length; step++) {
      const idx = (rrIdx + step) % live.length;
      if (available(live[idx])) {
        seedIdx = idx;
        break;
      }
    }
    // When every account is in the pool's in-memory exhausted set, preserve the existing fallback:
    // pick SOMETHING so the request ladder can emit a truthful terminal response instead of starving.
    if (seedIdx < 0) seedIdx = rrIdx % live.length;
    rrIdx = (seedIdx + 1) % live.length;
    const seed = live[seedIdx];
    if (!keyOf) return seed;

    let best = seed;
    let bestKey = keyOf(seed);
    // Scan in round-robin order and replace only on a STRICTLY lower score. Equal-health accounts
    // therefore retain the seed's fair cursor order; health ranking never collapses ties onto index 0.
    for (let step = 1; step < live.length; step++) {
      const idx = (seedIdx + step) % live.length;
      const candidate = live[idx];
      if (!available(candidate)) continue;
      const key = keyOf(candidate);
      if (key < bestKey) {
        best = candidate;
        bestKey = key;
      }
    }
    return best;
  }

  /** H3 (inference-gateway-audit-2026-06-23): the NON-advancing twin of active() — same "current best"
   *  selection but it does NOT mutate rrIdx. Read-only callers (stats(), the startup log, the watchdog/health
   *  pollers) must use this so OBSERVING the pool doesn't perturb the production round-robin. active() advances
   *  on every call, so a frequent /stats poll — heaviest during an incident, when distribution matters most —
   *  was silently biasing which account each real request landed on. */
  function peek(): ActiveAccount {
    for (let step = 0; step < live.length; step++) {
      const idx = (rrIdx + step) % live.length;
      if (available(live[idx])) return live[idx];
    }
    return live[rrIdx % live.length];
  }

  /** Mark `exhaustedId` out of rotation until `resetAt`, and return the next DIFFERENT account that
   *  still has budget for the retry loop to rotate onto (null when none remain → egress pauses until
   *  a reset). Idempotent: re-exhausting an already-paused account just refreshes its reset. */
  function onExhausted(
    exhaustedId: string,
    resetAt: number,
    keyOf?: (account: ActiveAccount) => number,
  ): ActiveAccount | null {
    const at = now();
    exhaustedUntil.set(exhaustedId, resetAt > at ? resetAt : at + FIVE_HOURS_MS);
    parkedAt.set(exhaustedId, at);
    // Re-exhausted ⇒ no longer "freshly readmitted"; drop any stale early-readmit stamp so the next
    // rejoin's boundary is this new pause's expiry, not a prior readmit() (msSinceReadmit, WI-3151).
    readmittedAt.delete(exhaustedId);
    let bestIdx = -1;
    let bestKey = Infinity;
    for (let step = 0; step < live.length; step++) {
      const idx = (rrIdx + step) % live.length;
      if (live[idx].accountId !== exhaustedId && available(live[idx])) {
        if (!keyOf) {
          bestIdx = idx;
          break;
        }
        const key = keyOf(live[idx]);
        // Keep the first available candidate as a terminal-response fallback even when every external
        // health key is Infinity; the request ladder still needs a concrete account to explain the wall.
        if (bestIdx < 0 || key < bestKey) {
          bestIdx = idx;
          bestKey = key;
        }
      }
    }
    if (bestIdx >= 0) {
      rrIdx = (bestIdx + 1) % live.length;
      log('warn', `inference-gateway: '${exhaustedId}' out of rotation → '${live[bestIdx].accountId}'`);
      return live[bestIdx];
    }
    log(
      'error',
      `inference-gateway: '${exhaustedId}' exhausted and no other account has budget — egress pauses until reset`,
    );
    return null;
  }

  /** Clear an account's out-of-rotation pause AHEAD of its reset — the dual of onExhausted. Called when a
   *  half-open egress probe confirms the proxy RECOVERED (`reason:'transport'`), when the durable
   *  availability store reports the account serviceable again (`reason:'store'`, P-008), or by the
   *  /admin/readmit operator lever (`reason:'admin'`), so a token-healthy account rejoins rotation the
   *  instant it is usable again instead of sitting out the full window (owner-reported 2026-06-21: flaky
   *  proxies kept healthy accounts out 60s → empty-pool "all throttled" sheds). No-op (false) if the
   *  account wasn't paused.
   *
   *  `maxParkMs` bounds WHICH parks a caller may clear: a transport-probe readmit passes the circuit-open
   *  ceiling, because a transport circuit can only ever have created a park that short — a park that
   *  outlives it is a measured 5h/7d usage WALL a healthy proxy does not cure. Before this bound the
   *  proactive egress probe readmitted every walled codex account on each successful probe, the fleet
   *  re-burned all of them, and `active()` kept "finding" capacity that did not exist
   *  (codex-auto-route-all-walled-fail-fast-2026-09-05 D-001). */
  function readmit(accountId: string, opts: AccountReadmitOptions = {}): boolean {
    const until = exhaustedUntil.get(accountId);
    if (until === undefined) return false;
    const reason = opts.reason ?? 'transport';
    const at = now();
    if (opts.maxParkMs !== undefined && until - at > opts.maxParkMs) {
      log(
        'warn',
        `inference-gateway: '${accountId}' readmit (${reason}) REFUSED — park runs ${Math.round((until - at) / 1000)}s more, exceeds the ${Math.round(opts.maxParkMs / 1000)}s ${reason} horizon (a usage wall, not a ${reason} pause)`,
      );
      return false;
    }
    exhaustedUntil.delete(accountId);
    parkedAt.delete(accountId);
    readmittedAt.set(accountId, at); // stamp the rejoin moment for the cold-rest probe (WI-3151)
    const why =
      reason === 'transport'
        ? 'egress proxy recovered'
        : reason === 'store'
          ? 'availability store reports capacity'
          : 'operator readmit';
    log('warn', `inference-gateway: '${accountId}' readmitted to rotation (${why})`);
    return true;
  }

  /** The park `accountId` is currently under, or undefined when it is in rotation (never parked, or its
   *  park expired / was cleared). `parkedAt` is when THIS park began — the freshness boundary a
   *  store-driven readmit compares its reading against. */
  function parkState(accountId: string): AccountParkState | undefined {
    const until = exhaustedUntil.get(accountId);
    if (until === undefined || until <= now()) return undefined;
    return { parkedAt: parkedAt.get(accountId) ?? 0, until };
  }

  /** The pool's RECOVERY HORIZON (codex-auto-route-all-walled-fail-fast-2026-09-05 P-001): the instant
   *  the pool is next expected to have a serviceable account.
   *
   *    0         — some entry can serve NOW: not parked AND (keyOf ?? 0) is finite;
   *    epoch ms  — every entry is out; this is the EARLIEST of their known recovery instants, where an
   *                entry's instant is the LATER of its park expiry and the caller's `recoverAtOf` (a
   *                durable window reset / governor pause the pool itself cannot see);
   *    Infinity  — every entry is out and NONE has a known recovery instant (e.g. keyOf says Infinity
   *                for reasons with no reset — a shed, an unavailable transport).
   *
   *  The codex 429 ladder absorbs (parks the request and re-picks later) ONLY when this horizon falls
   *  inside its absorb budget; an all-walled pool with resets hours away fails fast instead of sleeping
   *  the whole budget on an account that cannot recover in time — the stall the owner measured on
   *  2026-09-05 (every auto-routed codex request hung ~2min on a pool whose earliest reset was ~3h out).
   *  Read-only: never advances the cursor. */
  function earliestAvailableAt(opts: AccountRecoveryHorizonOptions = {}): number {
    const at = opts.now ?? now();
    let horizon = Infinity;
    for (const e of live) {
      const until = exhaustedUntil.get(e.accountId);
      const parked = until !== undefined && until > at;
      if (!parked && (opts.keyOf?.(e) ?? 0) < Infinity) return 0;
      const external = opts.recoverAtOf?.(e);
      const externalAt = external !== undefined && Number.isFinite(external) && external > at ? external : 0;
      const candidate = Math.max(parked ? until : 0, externalAt);
      if (candidate > 0 && candidate < horizon) horizon = candidate;
    }
    return horizon;
  }

  /** Cold-rest causation probe (WI-3151): ms since this account last REJOINED rotation from a cold rest,
   *  or undefined when it is either currently paused/exhausted (not "rested and back") or was never
   *  exhausted at all. The gateway pairs this with the 429 shape at the throttle site to tell a
   *  rested-account-still-429s event apart from a genuine account wall — a bare/edge 429 moments after a
   *  cold rest is evidence the throttle is SHARED-edge/IP-caused (resting the account didn't clear it),
   *  not this account's own budget. Read-only bookkeeping: it never affects selection. The rejoin
   *  boundary is the LATER of the naturally-expired pause (exhaustedUntil retains its past reset) and any
   *  early readmit() stamp. */
  function msSinceReadmit(accountId: string, at: number = now()): number | undefined {
    const until = exhaustedUntil.get(accountId);
    if (until !== undefined && until > at) return undefined; // still paused — not a rejoin
    const expiredBoundary = until; // present here only when until <= at (a naturally-expired pause)
    const explicitBoundary = readmittedAt.get(accountId);
    let boundary: number | undefined;
    if (expiredBoundary !== undefined && explicitBoundary !== undefined) {
      boundary = Math.max(expiredBoundary, explicitBoundary);
    } else {
      boundary = expiredBoundary ?? explicitBoundary;
    }
    if (boundary === undefined) return undefined; // never exhausted ⇒ never cold-rested
    return Math.max(0, at - boundary);
  }

  /** Per-request cache-affinity routing (inference-gateway-multi-credential-routing P-002):
   *  the pool entry named by the `x-papercusp-account` header, or null when unknown (the gateway
   *  falls back to active()). Pins a bee to its account regardless of which one is `active` — a
   *  failover moves `active`, but a header-pinned request stays on its own credential's cache. */
  function select(accountId: string): ActiveAccount | null {
    return live.find((e) => e.accountId === accountId) ?? null;
  }

  /** HOT-RELOAD the pool (B-HOT-1): atomically swap the live entries to `next` WITHOUT a gateway
   *  restart. The pool object identity is preserved (the gateway's captured `pool` reference keeps
   *  working), the round-robin cursor is clamped to the new length, and the exhausted-state map is
   *  pruned of accounts that LEFT the pool — a still-present paused account KEEPS its pause across the
   *  swap. Throws on an empty set: the gateway must always have at least one egress account. */
  function reload(next: readonly ActiveAccount[]): void {
    if (next.length === 0) throw new Error('createFailoverPool.reload: at least one account is required');
    live = next.slice();
    const presentIds = new Set(live.map((e) => e.accountId));
    for (const id of [...exhaustedUntil.keys()]) if (!presentIds.has(id)) exhaustedUntil.delete(id);
    for (const id of [...readmittedAt.keys()]) if (!presentIds.has(id)) readmittedAt.delete(id);
    for (const id of [...parkedAt.keys()]) if (!presentIds.has(id)) parkedAt.delete(id);
    rrIdx = rrIdx % live.length;
    log('info', `inference-gateway: account pool hot-reloaded → [${live.map((e) => e.accountId).join(', ')}]`);
  }

  /** Accounts currently IN rotation (budget available, not paused) — the live capacity denominator the
   *  priority-tier `/stats` reports + the serviceable-count admission clamp. Counts the same `available()`
   *  predicate `active()` round-robins over. The optional `extra` predicate further narrows to accounts the
   *  CALLER also considers serviceable: `available()` here only sees the pool's `exhaustedUntil` (a hard-429 /
   *  transport-circuit pause), NOT the per-(model,account) governor's PREDICTIVE pausedUntil — so without it a
   *  97%-7d governor-paused account counts as "healthy", over-reporting capacity and masking a thundering herd
   *  (audit 2026-06-23). The gateway passes a governor-not-paused check so the count matches what `active()` +
   *  the capacity-walk will actually serve. */
  function healthyCount(extra?: (accountId: string) => boolean): number {
    return live.reduce((n, e) => n + (available(e) && (!extra || extra(e.accountId)) ? 1 : 0), 0);
  }

  /** Total accounts in the live pool (the DENOMINATOR for healthyCount). The fleet-wide-bare-burst
   *  detector (WI-649 / gateway G1) compares healthyCount() against this to decide whether ≥half the
   *  pool is out of rotation — i.e. rotating A→B→C would find no capacity. Reflects hot-reload swaps. */
  function size(): number {
    return live.length;
  }

  /** Read-only live-entry snapshot (no cursor advance) — the proactive egress prober's enumerator. */
  function entriesSnapshot(): readonly ActiveAccount[] {
    return live;
  }

  return {
    active,
    onExhausted,
    select,
    reload,
    readmit,
    parkState,
    earliestAvailableAt,
    msSinceReadmit,
    healthyCount,
    peek,
    size,
    entries: entriesSnapshot,
  };
}
