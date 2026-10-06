/**
 * Account pool — the Queen's model of the N Claude accounts it can draw from, with
 * a per-account rate-limit projection (`cloud-deployment-layer-2026-06-06` Phase 7).
 *
 * An **account** = one Claude subscription credential, with its OWN rate limits
 * (the P-011 "one Claude sub per frame, separated rate limits" unit). The Queen:
 *   - **P-019** registers N of them (id + credentialRef) and tracks each account's
 *     rate-limit state, reusing the existing rate governor's pause signals.
 *   - **P-020** binds one account per Swarm at deploy time, choosing by rate-limit
 *     headroom (the most-available account).
 *   - **P-021** when an account is *sustainedly* limited, scales out onto a fresh
 *     account (a new cloud Swarm) instead of only pausing.
 *
 * This file is PURE — types + decisions over a plain `AccountPool` value, no PG /
 * governor / deploy IO. The IO wiring (persistence, the governor-pause bridge, the
 * scale-out reaction) lives in `account-pool-store.ts`, so this core stays
 * exhaustively unit-testable with no fixtures.
 */
import {
  evaluateAccountBurn,
  renderBurnVerdictLabel,
  type BurnAction,
  type BurnDisposition,
  type BurnVerdict,
} from '../inference-gateway/burn-governor';
import { accountLoadKey } from '../inference-gateway/account-failover';
import { ROLLING_WINDOW_REPROBE_MAX_MS } from '@papercusp/papercusp-shared/resilience';

/**
 * Per-account upstream egress binding — per-account IP routing (D-003). Each registered Claude Max
 * subscription can be pinned to its own outbound IP so N consumer subscriptions don't all egress from
 * one shared address (consumer plans can correlate/flag a shared origin). Either an HTTP/SOCKS proxy
 * URL the gateway routes this account's upstream traffic through, or a local source IP to bind. A
 * REFERENCE/config, never a secret — safe to persist/federate. Absent ⇒ default (shared) egress; the
 * owner provisions the actual proxies (owner-gated infra, like the credentials themselves).
 */
export interface AccountEgress {
  /**
   * Forward-proxy URL for this account's upstream requests. Two schemes are routed: `http://`/`https://`
   * (undici's ProxyAgent, HTTP CONNECT) and `socks5://`/`socks://` (undici's native Socks5ProxyAgent,
   * WI-284). Any OTHER scheme is not supported: the gateway ignores it with a warning and falls back to
   * `localAddress` (if set) or the default shared egress, rather than silently 502-ing the account.
   */
  proxyUrl?: string;
  /** Local source IP to bind the upstream socket to (when the host has multiple egress IPs). */
  localAddress?: string;
  /**
   * Which `EgressProvider` (B-PROV, `inference-gateway/egress-providers/`) manages this binding —
   * e.g. `'rayobyte'`, `'static'` — when it was provisioned programmatically via `egress:provision`
   * rather than hand-registered via a bare `accounts:register{egress}`. Absent = manually registered
   * (today's common case: the owner provisions an IP out-of-band and registers it directly). Lets
   * `egress:release`/`egress:health` route back to the owning provider without guessing an identity
   * from the proxyUrl/localAddress value alone.
   */
  providerId?: string;
  /**
   * The provider-native allocation id (the `EgressProvider.release`/`healthcheck` key) for this
   * binding, when `providerId` is set. Opaque to the account pool — only meaningful to that provider.
   */
  providerAllocationId?: string;
}

/**
 * The ordered list of egress bindings for an account — the per-account IP POOL the gateway rotates the
 * account's upstream across (gateway-per-account-egress-ip-pool-2026-06-30). Precedence: a non-empty
 * `egressPool` supersedes the singular `egress`; otherwise the singular `egress` is treated as a 1-entry
 * pool; neither ⇒ `[]` (default shared egress). Entries with no proxyUrl AND no localAddress are dropped
 * (they carry no routing). SINGLE SOURCE OF TRUTH so every consumer (the gateway's dispatcher selector,
 * the egress probe, the status read-model) sees the SAME ordered list and can never drift. Pure.
 */
export function egressEntries(account: {
  egress?: AccountEgress;
  egressPool?: AccountEgress[];
}): AccountEgress[] {
  // An EXPLICIT pool keeps ALL its entries verbatim — including a `{}` entry, which is a VALID distinct
  // egress meaning "the box's default outbound IP" (no proxy / no bound source). That is how an account
  // gets a second free IP (e.g. ownerhandle8 = [its Rayobyte proxy, the box-direct IP]). Only array holes are
  // dropped. The SINGULAR/legacy `egress` is a 1-entry pool ONLY when it actually routes (a bare `{}`
  // singular ⇒ default egress ⇒ no pool, today's behavior).
  const pool = account.egressPool;
  if (pool && pool.length > 0) return pool.filter((e): e is AccountEgress => !!e);
  const e = account.egress;
  return e && (e.proxyUrl || e.localAddress) ? [e] : [];
}

export const ACCOUNT_PROVIDERS = ['claude', 'codex'] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

export function normalizeAccountProvider(provider: unknown): AccountProvider {
  return provider === 'codex' ? 'codex' : 'claude';
}

/** One provider account the operator can draw from. Legacy rows without `provider` are Claude. */
export interface ClaudeAccount {
  /**
   * Provider this account authenticates. Omitted legacy rows are treated as `claude`.
   * `codex` accounts are routed only through Codex/OpenAI-compatible gateway paths.
   */
  provider?: AccountProvider;
  /**
   * Stable id within the pool. Validated to `[A-Za-z0-9._-]+` — it becomes part of
   * the governor bucket key (`<provider>:<modelClass>@<id>`), so it must not contain
   * the `:` / `@` delimiters. This is the credential's logical identity.
   */
  id: string;
  /**
   * Opaque reference to the credential bundle mounted on a frame
   * (`DeploymentConfig.credentialRef`): `token:<path>` (a `claude setup-token` OAuth
   * token) | `file:<path>` / absolute / `~` (a `.credentials.json` bundle). A
   * REFERENCE the host resolves, never the secret — safe to persist/federate.
   */
  credentialRef: string;
  /** Optional human label. */
  label?: string;
  /** Per-account upstream egress (per-account IP routing). Absent ⇒ default shared egress.
   *  SINGULAR (legacy / single-IP). Superseded by a non-empty `egressPool`; kept for back-compat and
   *  as the implicit 1-entry pool. Resolve the effective list via `egressEntries(account)`. */
  egress?: AccountEgress;
  /**
   * Per-account egress IP POOL (gateway-per-account-egress-ip-pool-2026-06-30): a list of egress
   * bindings the gateway ROTATES this account's upstream across, so a per-IP Cloudflare edge throttle
   * (a bare-burst 429 on ONE egress IP) takes only THAT IP out of rotation instead of pausing the whole
   * account — and a HARD-pinned agent rides its account's own IP pool instead of erroring on its single
   * throttled IP. Empty/absent ⇒ fall back to the singular `egress` (a 1-entry pool) ⇒ today's behavior.
   * Resolve via `egressEntries(account)`. The owner provisions the IPs (owner-gated infra, like creds).
   */
  egressPool?: AccountEgress[];
  /** Metered spend policy (anthropic-credits-gateway-2026-09-30 P-008, D-003). `overflow` (absent ⇒
   *  this): metered serving — an api-key account, or usage-credits overage on a subscription — is used
   *  only when no included-allowance account can serve. `never`: the gateway never serves this account
   *  while it is metered. */
  meteredPolicy?: 'overflow' | 'never';
  /** When added (epoch ms). */
  addedAt: number;
  /** Swarm member harness slugs currently bound to this account (P-020). A MANUAL / deploy-time
   *  bind (owner intent) — never auto-cleared by the soft-pin lazy-repin (D-001). */
  boundTo: string[];
  /**
   * SOFT cache-affinity auto-pins (account-cache-affinity-auto-pin-2026-06-16): harness slugs the
   * SPAWN selector auto-pinned to this credential so a harness's consecutive bees co-locate on one
   * account and reuse its per-credential prompt-cache prefix. Distinct from `boundTo` (a manual
   * owner/deploy bind): a soft pin is system-set and LAZILY re-pinned — cleared the moment this
   * account fills (`drainUtil ≥ DRAIN_FULL_UTIL`) or goes unavailable, so the next spawn re-drains
   * to a fresh account and re-pins there (D-002). NEVER overwrites a manual `boundTo` bind (D-001).
   * Absent/empty ⇒ no auto-pin (today's behavior). Pure projection — the impure caller persists it.
   */
  softPin?: string[];
  /**
   * Per-account rate-limit projection the Queen tracks (P-019). Updated from the
   * account's governor pause signals (local process) + federated frame signals.
   */
  rate: AccountRateState;
}

/** One timestamped unified-7d utilization observation retained for burn-rate derivation (WI-41147). */
export interface Utilization7dSample {
  /** Epoch ms the reading was observed. */
  at: number;
  /** The unified-7d utilization fraction (1.0 = 100%) observed at `at`. */
  u: number;
}

/** Max retained `history7d` samples per account — bounds the JSONB row (~30 bytes/sample). */
export const HISTORY_7D_MAX_SAMPLES = 48;
/**
 * Minimum spacing between retained `history7d` samples. Live gateway traffic can observe the
 * window every few seconds; retaining every reading would turn the ring into a few minutes of
 * near-identical points (useless for an hourly-rate fit) while churning the pool row. With
 * 5-minute spacing the 48-sample cap covers ≥4h of history — comfortably more than the burn
 * governor's fit lookback.
 */
export const HISTORY_7D_MIN_SPACING_MS = 5 * 60_000;

/**
 * Append a unified-7d observation to the retained history (WI-41147). Pure. Skips (returns the
 * input list) when the new sample is closer than `HISTORY_7D_MIN_SPACING_MS` to the last retained
 * one, or not strictly newer (out-of-order / clock-skew guard) — the freshest reading is always
 * available from `utilization7d`/`utilizationAt`, so history holds only well-spaced points.
 * Non-finite junk in a hand-edited persisted row is dropped on the way through.
 */
export function appendUtilization7dSample(
  history: Utilization7dSample[] | undefined,
  sample: Utilization7dSample,
): Utilization7dSample[] {
  const clean = (history ?? []).filter(
    (s) => s && Number.isFinite(s.at) && Number.isFinite(s.u),
  );
  if (!Number.isFinite(sample.at) || !Number.isFinite(sample.u)) return clean;
  const last = clean[clean.length - 1];
  if (last && sample.at - last.at < HISTORY_7D_MIN_SPACING_MS) return clean;
  clean.push({ at: sample.at, u: sample.u });
  return clean.length > HISTORY_7D_MAX_SAMPLES ? clean.slice(clean.length - HISTORY_7D_MAX_SAMPLES) : clean;
}

/** The rolled-up rate-limit state for one account (the Queen's projection). */
export interface AccountRateState {
  /** Epoch ms the account is paused until; `0` = not paused. Mirrors the governor pause. */
  pausedUntil: number;
  /** Epoch ms of the most recent 429 / usage-limit penalty observed. `0` = none. */
  lastPenaltyAt: number;
  /** Penalties counted in the current rolling window — the sustained-limit signal. */
  penaltyCount: number;
  /** Epoch ms the current penalty window started. `0` = no window open. */
  windowStartedAt: number;
  /**
   * Unified-5h rolling utilization (a fraction: 1.0 = 100%, >1 = over budget), fed from the gateway
   * response headers — the only process that sees them — so the cross-process drain selector can
   * route by REAL remaining budget. The aggregate 5h budget across subscriptions is the capacity
   * lever for Claude Max (D-003). `undefined` until first observed.
   */
  utilization?: number;
  /** Epoch ms the unified-5h window resets (`anthropic-ratelimit-unified-5h-reset`). `undefined` until observed. */
  windowResetAt?: number;
  /** Epoch ms `utilization`/`windowResetAt` were last observed — lets the selector ignore stale budget. */
  utilizationAt?: number;
  /** Codex upstream credit eligibility; included-meter exhaustion alone is not an account wall. */
  usageCreditsAvailable?: boolean;
  /** When credit eligibility was observed; a credit-only update is not a new usage-window reading. */
  usageCreditsObservedAt?: number;
  /**
   * Unified-7d (weekly) rolling utilization (a fraction; 1.0 = 100%) from
   * `anthropic-ratelimit-unified-7d-utilization` — the LONGER Claude Max limit alongside the 5h.
   * A read-only surface signal for the Accounts tab (accounts-pool-tab P-006); NOT a routing input
   * (the 5h window remains the drain selector's signal). `undefined` until observed.
   */
  utilization7d?: number;
  /** Epoch ms the unified-7d window resets (`anthropic-ratelimit-unified-7d-reset`). `undefined` until observed. */
  windowResetAt7d?: number;
  /**
   * Bounded, time-spaced history of observed `utilization7d` readings (WI-41147) — the raw
   * material the burn-rate governor derives d(utilization7d)/dt from, so the fleet can see
   * "this pool exhausts before its window resets" BEFORE it hits the wall. Retention rules
   * (see `appendUtilization7dSample`): samples closer than `HISTORY_7D_MIN_SPACING_MS` to the
   * last retained one are skipped (the freshest reading always lives in
   * `utilization7d`/`utilizationAt` anyway), and the list is capped at
   * `HISTORY_7D_MAX_SAMPLES` (oldest trimmed). `undefined` until first observed.
   */
  history7d?: Utilization7dSample[];
  /**
   * Epoch ms of the most recent `accounts:probe-capacity` attempt on this account that came back
   * `no-reading` (the probe request itself failed — network/auth/timeout — so upstream told us
   * nothing). Cleared the next time a probe or live traffic actually observes a window (see
   * `recordAccountWindow`). EI-18809949582687481: without this, a caller reading `available:false`
   * or a stale `utilization` has no way to tell "we just tried and got no answer" from "we haven't
   * asked in days" — both looked identical. `undefined` = no known probe failure since the last
   * successful observation.
   */
  lastProbeFailedAt?: number;
  /**
   * WI-41147 leg c — the burn verdict ACTION stamped by the most recent window observation
   * (`recordAccountWindow` evaluates `accountBurnVerdict` at write time). Persisting it makes a
   * verdict TRANSITION detectable at the observation WRITE seam (the never-silent stated wall)
   * without the stale-gate flap an in-context pre/post compare suffers: a re-probe of a
   * still-burning account whose reading aged past `DRAIN_UTIL_STALE_MS` would otherwise read
   * none→shed on EVERY probe cycle and re-alarm each time. `undefined` = never evaluated
   * (treated as 'none' by the transition diff — never an alarm by itself).
   */
  lastBurnAction?: BurnAction;
  /**
   * P-005 — what the stamped {@link lastBurnAction} RESTED ON when it was written: a measured
   * provider wall vs this system pacing itself off a projection. Stamped from the SAME verdict
   * that decided the action, in the same write, so the persisted row can never state an action
   * whose basis a reader has to guess (`accounts:list` returns these rows verbatim).
   * `undefined` = stamped before this field existed, or never evaluated.
   */
  lastBurnDisposition?: BurnDisposition;
}

export interface AccountPool {
  accounts: ClaudeAccount[];
}

/** The policy knobs that turn raw penalties into a "sustainedly limited" verdict. */
export interface ScalePolicy {
  /** Penalties within this window (ms) accumulate toward the sustained threshold. */
  windowMs: number;
  /** ≥ this many penalties within the window ⇒ the account is sustainedly limited. */
  sustainedPenaltyThreshold: number;
}

/**
 * Minimum penalty window for the default threshold. Three penalties need two intervals; the
 * slow account-keyed usage-cap re-probe is bounded by ROLLING_WINDOW_REPROBE_MAX_MS.
 */
export const MIN_SCALE_POLICY_WINDOW_MS = Math.max(15 * 60_000, 2 * ROLLING_WINDOW_REPROBE_MAX_MS);

export const DEFAULT_SCALE_POLICY: ScalePolicy = {
  // Three slow re-probe penalties (at the cap) must fit in one accrual window.
  windowMs: MIN_SCALE_POLICY_WINDOW_MS,
  sustainedPenaltyThreshold: 3, // 3 × 429 in the window = this account genuinely can't keep up
};

/**
 * Utilization at/above which an account's unified-5h window is genuinely exhausted (1.0 = 100%).
 * This is the SELF-HEALING exhaustion signal (D-003 false-exhaustion fix): a rolling-utilization
 * window decays continuously, so reading the freshest observed utilization (not a stale far-future
 * pause) means an account stops reading "exhausted" the moment its window recovers below the cap.
 */
export const EXHAUSTED_UTIL = 1.0;

export class AccountPoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountPoolError';
  }
}

const ID_RE = /^[A-Za-z0-9._-]+$/;

export function emptyPool(): AccountPool {
  return { accounts: [] };
}

function freshRate(): AccountRateState {
  return { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0 };
}

/**
 * Re-hydrate a persisted account row to the full invariant shape: every REQUIRED `rate`
 * counter present + finite (missing/NaN → the freshRate default), optional observed-budget
 * fields passed through, `boundTo` defaulted to []. Guards the whole rate-math surface
 * (`isAvailable`, the penalty `Math.max`, headroom ranking, …) against a partially-written
 * pool row: a row stored with `rate: {}` used to read as PERMANENTLY PAUSED because
 * `undefined <= now` is false (WI-3068 — the codex CLI-bridge account). Pure.
 */
export function normalizeAccount(account: ClaudeAccount): ClaudeAccount {
  const r = (account.rate ?? {}) as Partial<AccountRateState>;
  const fresh = freshRate();
  const fin = (v: number | undefined, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return {
    ...account,
    boundTo: account.boundTo ?? [],
    rate: {
      ...r,
      pausedUntil: fin(r.pausedUntil, fresh.pausedUntil),
      lastPenaltyAt: fin(r.lastPenaltyAt, fresh.lastPenaltyAt),
      penaltyCount: fin(r.penaltyCount, fresh.penaltyCount),
      windowStartedAt: fin(r.windowStartedAt, fresh.windowStartedAt),
    },
  };
}

export function getAccount(pool: AccountPool, id: string): ClaudeAccount | undefined {
  return pool.accounts.find((a) => a.id === id);
}

export function accountProvider(account: Pick<ClaudeAccount, 'provider'>): AccountProvider {
  return normalizeAccountProvider(account.provider);
}

export function accountsForProvider(pool: AccountPool, provider: AccountProvider): ClaudeAccount[] {
  return pool.accounts.filter((a) => accountProvider(a) === provider);
}

export function accountIdsForProvider(pool: AccountPool, provider: AccountProvider): string[] {
  return accountsForProvider(pool, provider).map((a) => a.id);
}

export function poolForProvider(pool: AccountPool, provider: AccountProvider): AccountPool {
  return { accounts: accountsForProvider(pool, provider) };
}

/** Find the account a given credentialRef belongs to (reverse lookup). */
export function accountByCredentialRef(pool: AccountPool, credentialRef: string): ClaudeAccount | undefined {
  return pool.accounts.find((a) => a.credentialRef === credentialRef);
}

/**
 * Register (or idempotently update) an account. A new id is appended fresh; an
 * existing id has its `credentialRef`/`label` updated in place (rate + bindings
 * preserved). Pure — returns a new pool.
 */
export function registerAccount(
  pool: AccountPool,
  input: {
    id: string;
    credentialRef: string;
    label?: string;
    egress?: AccountEgress;
    egressPool?: AccountEgress[];
    provider?: AccountProvider;
    meteredPolicy?: 'overflow' | 'never';
  },
  now: number,
): AccountPool {
  const id = input.id.trim();
  if (!ID_RE.test(id)) {
    throw new AccountPoolError(`invalid account id '${input.id}' — allowed: A-Za-z0-9 . _ - (no ':' or '@')`);
  }
  const credentialRef = input.credentialRef.trim();
  if (!credentialRef) throw new AccountPoolError('credentialRef is required');

  const provider = normalizeAccountProvider(input.provider);

  if (getAccount(pool, id)) {
    return {
      accounts: pool.accounts.map((a) =>
        a.id === id
          ? {
              ...a,
              provider,
              credentialRef,
              label: input.label ?? a.label,
              egress: input.egress ?? a.egress,
              egressPool: input.egressPool ?? a.egressPool,
              ...((input.meteredPolicy ?? a.meteredPolicy) ? { meteredPolicy: input.meteredPolicy ?? a.meteredPolicy } : {}),
            }
          : a,
      ),
    };
  }
  const account: ClaudeAccount = {
    provider,
    id,
    credentialRef,
    label: input.label,
    egress: input.egress,
    egressPool: input.egressPool,
    ...(input.meteredPolicy ? { meteredPolicy: input.meteredPolicy } : {}),
    addedAt: now,
    boundTo: [],
    rate: freshRate(),
  };
  return { accounts: [...pool.accounts, account] };
}

/** Remove an account from the pool. Pure. */
export function removeAccount(pool: AccountPool, id: string): AccountPool {
  return { accounts: pool.accounts.filter((a) => a.id !== id) };
}

/** Bind a member harness slug to an account (idempotent). Pure. */
export function bindAccount(pool: AccountPool, id: string, slug: string): AccountPool {
  return {
    accounts: pool.accounts.map((a) =>
      a.id === id ? { ...a, boundTo: a.boundTo.includes(slug) ? a.boundTo : [...a.boundTo, slug] } : a,
    ),
  };
}

/** Remove a slug from whatever account currently holds it (a slug binds ≤1 account). Pure. */
export function unbindAccount(pool: AccountPool, slug: string): AccountPool {
  return { accounts: pool.accounts.map((a) => ({ ...a, boundTo: a.boundTo.filter((s) => s !== slug) })) };
}

/** The account a harness is MANUALLY bound to (`boundTo`), if any — the owner/deploy intent the
 *  soft auto-pin must never overwrite (D-001). Pure. */
export function manuallyBoundAccount(pool: AccountPool, slug: string): ClaudeAccount | undefined {
  return pool.accounts.find((a) => a.boundTo.includes(slug));
}

/** The account a harness is SOFT-pinned to (`softPin`), if any (cache-affinity auto-pin). Pure. */
export function softPinnedAccount(pool: AccountPool, slug: string): ClaudeAccount | undefined {
  return pool.accounts.find((a) => a.softPin?.includes(slug));
}

/**
 * Soft-pin a harness to one account (cache-affinity auto-pin): set the pin on `id`, removing any
 * prior soft pin for `slug` on a DIFFERENT account (a slug soft-pins ≤1 account, mirroring a bind).
 * A NO-OP when the harness is already manually bound (D-001 — never shadow an owner bind) or already
 * soft-pinned to `id`. Pure — the impure caller persists the returned pool.
 */
export function setSoftPin(pool: AccountPool, id: string, slug: string): AccountPool {
  if (manuallyBoundAccount(pool, slug)) return pool; // owner bind wins — don't auto-pin over it
  return {
    accounts: pool.accounts.map((a) => {
      const has = a.softPin?.includes(slug) ?? false;
      if (a.id === id) return has ? a : { ...a, softPin: [...(a.softPin ?? []), slug] };
      if (has) return { ...a, softPin: a.softPin!.filter((s) => s !== slug) }; // drop the stale pin
      return a;
    }),
  };
}

/** Clear a harness's soft pin from whatever account holds it (lazy re-pin / failover). Pure. */
export function clearSoftPin(pool: AccountPool, slug: string): AccountPool {
  return {
    accounts: pool.accounts.map((a) =>
      a.softPin?.includes(slug) ? { ...a, softPin: a.softPin.filter((s) => s !== slug) } : a,
    ),
  };
}

/**
 * Record a rate-limit penalty against an account (pure). Rolls the inclusive penalty window:
 * a penalty outside the current window opens a fresh count of 1; inside it
 * increments. `pausedUntil` advances monotonically — a penalty never shortens an
 * existing pause. A penalty for an unknown id is a no-op.
 */
export function recordAccountPenalty(
  pool: AccountPool,
  id: string,
  now: number,
  opts: { pausedUntil?: number } = {},
  policy: ScalePolicy = DEFAULT_SCALE_POLICY,
): AccountPool {
  return {
    accounts: pool.accounts.map((a) => {
      if (a.id !== id) return a;
      const inWindow = a.rate.windowStartedAt > 0 && now - a.rate.windowStartedAt <= policy.windowMs;
      const rate: AccountRateState = {
        // Preserve the last-known observed budget (utilization / windowResetAt / utilizationAt): a 429
        // penalty must NOT erase the usage reading, else the Accounts tab loses the "% used" the
        // instant an account gets rate-limited — the exact moment you want to SEE it. Only the
        // pause/penalty fields below are recomputed.
        ...a.rate,
        pausedUntil: Math.max(a.rate.pausedUntil, opts.pausedUntil ?? 0),
        lastPenaltyAt: now,
        penaltyCount: inWindow ? a.rate.penaltyCount + 1 : 1,
        windowStartedAt: inWindow ? a.rate.windowStartedAt : now,
      };
      return { ...a, rate };
    }),
  };
}

/**
 * Clear an account's pause + penalty window (e.g. on a confirmed reset). Pure.
 * By DEFAULT preserves the last-known observed budget (utilization / windowResetAt /
 * utilizationAt) — the reset clears the false-exhaustion pause/penalty, not the real usage
 * reading, so the Accounts tab can still show "~X% used · as of …". Staleness is carried by
 * `utilizationAt`, and the drain selector already discounts a stale reading, so keeping it is
 * safe.
 *
 * `resetWindows: true` (WI-3553) is the DELIBERATE owner override for when the projected
 * utilization/windowResetAt reading itself is wrong or can't be re-probed (accounts:probe-capacity
 * is the preferred, evidence-based path when the probe CAN run — see its own guidance): it also
 * zeroes `utilization`/`windowResetAt`/`utilization7d`/`windowResetAt7d`/`utilizationAt`, i.e. a
 * plain `{ ...freshRate() }` with none of the observed-budget fields carried forward. Default
 * `false` is byte-identical to the pre-WI-3553 behavior.
 */
export function recordAccountReset(pool: AccountPool, id: string, opts: { resetWindows?: boolean } = {}): AccountPool {
  return {
    accounts: pool.accounts.map((a) =>
      a.id === id
        ? {
            ...a,
            rate: opts.resetWindows
              ? { ...freshRate() }
              : {
                  ...freshRate(),
                  utilization: a.rate.utilization,
                  windowResetAt: a.rate.windowResetAt,
                  utilization7d: a.rate.utilization7d,
                  windowResetAt7d: a.rate.windowResetAt7d,
                  utilizationAt: a.rate.utilizationAt,
                },
          }
        : a,
    ),
  };
}

/**
 * Record an account's observed unified-5h budget window (utilization + reset) into the projection —
 * the cross-process signal the drain selector routes by (the gateway sees the headers; the spawn
 * chokepoint reads this). Stamps `utilizationAt = now` for staleness. A field left undefined keeps
 * its prior value. Unknown id = no-op. Pure.
 */
export function recordAccountWindow(
  pool: AccountPool,
  id: string,
  w: { utilization?: number; windowResetAt?: number; utilization7d?: number; windowResetAt7d?: number; usageCreditsAvailable?: boolean },
  now: number,
): AccountPool {
  return {
    accounts: pool.accounts.map((a) => {
      if (a.id !== id) return a;
      const rate: AccountRateState = {
        ...a.rate,
        utilization: w.utilization ?? a.rate.utilization,
        windowResetAt: w.windowResetAt ?? a.rate.windowResetAt,
        utilization7d: w.utilization7d ?? a.rate.utilization7d,
        windowResetAt7d: w.windowResetAt7d ?? a.rate.windowResetAt7d,
        utilizationAt:
          w.utilization !== undefined || w.windowResetAt !== undefined ||
          w.utilization7d !== undefined || w.windowResetAt7d !== undefined
            ? now : a.rate.utilizationAt,
        ...(accountProvider(a) === 'codex' && w.usageCreditsAvailable !== undefined
          ? { usageCreditsAvailable: w.usageCreditsAvailable, usageCreditsObservedAt: now } : {}),
        // WI-41147: retain a spaced history of 7d readings so the burn governor can derive
        // d(utilization7d)/dt. Only a real 7d observation appends — a 5h-only update leaves
        // the history untouched (appending the STALE carried-forward 7d value would flatten
        // the derived rate toward zero exactly when traffic is heaviest).
        history7d:
          w.utilization7d !== undefined
            ? appendUtilization7dSample(a.rate.history7d, { at: now, u: w.utilization7d })
            : a.rate.history7d,
        // A real observation just landed — any earlier "we asked and got nothing" marker is stale.
        lastProbeFailedAt: undefined,
      };
      // WI-41147 leg c: stamp the burn verdict this observation implies, so the WRITE seam can
      // detect a verdict TRANSITION (the never-silent stated wall) by diffing before/after. The
      // reading is fresh by construction (`utilizationAt = now`), so the stale gate never
      // interferes at write time.
      const stamped = accountBurnVerdict(rate, now);
      rate.lastBurnAction = stamped.action;
      // P-005: the stamp is a persisted VERDICT, and `accounts:list` hands the raw row to readers.
      // An action stored without its basis is the same omission the reader-contract forbids on
      // every other surface — and it is free to keep here, from the very verdict that decided it.
      rate.lastBurnDisposition = stamped.disposition;
      return { ...a, rate };
    }),
  };
}

/** One burn-verdict transition observed at the WRITE seam (WI-41147 leg c). */
export interface BurnTransition {
  accountId: string;
  from: BurnAction;
  to: BurnAction;
  /** The verdict's stated WHY at the moment of transition (never silent). */
  reason: string;
  /**
   * What the new action RESTS ON at the moment of transition — carried on the transition itself
   * so every downstream writer (the standing fact, the severe-event broadcast) states it without
   * re-evaluating the verdict (P-001).
   */
  disposition: BurnDisposition;
  /** The one canonical rendering of the new verdict — `renderBurnVerdictLabel` (P-001). */
  label: string;
}

/**
 * Diff two pool states' persisted `lastBurnAction` stamps for ONE account (WI-41147 leg c).
 * Pure. Returns the transition, or null when nothing changed / the account is unknown in
 * either state. An unstamped account reads as 'none' — a first-ever stamp of 'none' is
 * therefore NOT a transition (never alarm on missing data), while a first-ever stamp of
 * throttle/shed is.
 */
export function accountBurnTransition(
  before: AccountPool,
  after: AccountPool,
  id: string,
  now: number,
): BurnTransition | null {
  const b = before.accounts.find((a) => a.id === id);
  const aft = after.accounts.find((a) => a.id === id);
  if (!b || !aft) return null;
  const from: BurnAction = b.rate.lastBurnAction ?? 'none';
  const to: BurnAction = aft.rate.lastBurnAction ?? 'none';
  if (from === to) return null;
  // ONE evaluation feeds reason + disposition + label, so the three can never disagree.
  const verdict = accountBurnVerdict(aft.rate, now);
  return {
    accountId: id,
    from,
    to,
    reason: verdict.reason,
    disposition: verdict.disposition,
    label: renderBurnVerdictLabel(verdict),
  };
}

/**
 * Record that an `accounts:probe-capacity` attempt on this account came back `no-reading` (the
 * probe itself failed — no window observed, so `recordAccountWindow` was never called). Pure;
 * unknown id = no-op. Companion to `recordAccountWindow`, which clears this the next time a real
 * observation lands (from a probe OR from live traffic). EI-18809949582687481.
 */
export function recordProbeFailure(pool: AccountPool, id: string, now: number): AccountPool {
  return {
    accounts: pool.accounts.map((a) => (a.id === id ? { ...a, rate: { ...a.rate, lastProbeFailedAt: now } } : a)),
  };
}

/**
 * How stale the account's observed usage-window reading (`rate.utilizationAt`) is, RIGHT NOW —
 * the freshness verdict `accounts:status` surfaces per row so a caller can tell "measured a moment
 * ago" apart from "never measured" / "measured a long time ago" instead of trusting a bare
 * `available`/`usageWalled` boolean at face value (EI-18809949582687481). Pure; shares the same
 * `DRAIN_UTIL_STALE_MS` window the drain selector itself uses to discount a stale reading.
 */
export function accountReadingStatus(
  account: Pick<ClaudeAccount, 'rate'>,
  now: number,
): { readingStatus: 'never-observed' | 'stale' | 'fresh'; readingAgeMs?: number } {
  const at = account.rate.utilizationAt;
  if (at === undefined) return { readingStatus: 'never-observed' };
  const readingAgeMs = Math.max(0, now - at);
  return { readingStatus: readingAgeMs > DRAIN_UTIL_STALE_MS ? 'stale' : 'fresh', readingAgeMs };
}

/** Is the account usable right now (not currently paused)? */
export function isAvailable(account: ClaudeAccount, now: number): boolean {
  // Tolerate a partially-hydrated row (e.g. a hand-written pool JSON with `rate: {}`): a MISSING
  // pausedUntil means "never paused", NOT "paused forever" — `undefined <= now` is false, which
  // made the codex CLI-bridge account read permanently unavailable (WI-3068). loadAccountPool
  // normalizes rows on read; this is the last-line guard for rows built outside that path.
  return (account.rate?.pausedUntil ?? 0) <= now;
}

/**
 * Is the account *sustainedly* rate-limited — the P-021 scale-out trigger (provisions PAID
 * machines, so a false positive costs money)? True when EITHER:
 *   (a) the freshest observed unified-5h/7d utilization is at/over cap (`EXHAUSTED_UTIL`) — the
 *       genuine, SELF-HEALING budget signal (it decays back below cap as the rolling window
 *       recovers, so the account stops reading exhausted on its own); OR
 *   (b) the account accrued `sustainedPenaltyThreshold` real penalties inside the window (a
 *       repeated-429 burst, not a one-off).
 * A SINGLE far-future pause is deliberately NOT a trigger anymore (D-003 false-exhaustion fix): on
 * Claude Max a single 429 routinely carries a pause to the multi-hour 5h/7d reset even when the
 * account is not actually over budget, which used to flip it straight to "exhausted".
 */
export function isSustainedlyLimited(
  account: ClaudeAccount,
  now: number,
  policy: ScalePolicy = DEFAULT_SCALE_POLICY,
): boolean {
  const r = account.rate;
  if (effectiveDrainUtil(account, now) >= EXHAUSTED_UTIL) return true;
  const inWindow = r.windowStartedAt > 0 && now - r.windowStartedAt <= policy.windowMs;
  return inWindow && r.penaltyCount >= policy.sustainedPenaltyThreshold;
}

export interface SelectOpts {
  /** Exclude these ids (e.g. the exhausted account we're scaling away from). */
  exclude?: string[];
  /** Only consider accounts available right now (not paused). Default true. */
  availableOnly?: boolean;
  /** Prefer accounts with no bindings yet (spread Swarms across distinct accounts). */
  preferUnbound?: boolean;
  /** Candidate-eligibility predicate applied when `availableOnly` (default `!accountFull`). Non-CLI
   *  callers may pass `isSpawnEligible` when they can tolerate gateway pacing on a stale predictive
   *  pause. Spawned CLI agents deliberately keep the stricter default: a paused hard pin can terminate
   *  the turn before the agent emits required artifacts. */
  eligible?: (a: ClaudeAccount, now: number) => boolean;
  /** SPREAD a concurrent burst across candidates weighted by remaining headroom (anti-thundering-herd)
   *  instead of deterministically returning the single best — so the fleet fans out rather than piling
   *  onto one account until it RPM-storms. `rng()===0` returns the deterministic best, so non-spread
   *  callers/tests are byte-identical; production passes `Math.random`. */
  spread?: boolean;
  rng?: () => number;
  /** When spreading, give this account (the harness's soft-pin) a cache-affinity weight bonus so the
   *  hive prefers its warm-cache credential without funnelling every bee onto it. */
  affinityId?: string;
}

/**
 * Choose the account with the most rate-limit headroom (P-020), deterministically.
 * Ranking (ascending = better): when `preferUnbound`, unbound accounts first; then
 * fewest bindings (spread load); then least-recently penalized (a clean account
 * beats a recently-limited one); then oldest-added; then id (stable tie-break).
 * Returns undefined when nothing qualifies.
 */
export function selectAccountByHeadroom(pool: AccountPool, now: number, opts: SelectOpts = {}): ClaudeAccount | undefined {
  const { exclude = [], availableOnly = true, preferUnbound = false } = opts;
  let candidates = pool.accounts.filter((a) => !exclude.includes(a.id));
  if (availableOnly) candidates = candidates.filter((a) => isAvailable(a, now));
  if (candidates.length === 0) return undefined;

  const rank = (a: ClaudeAccount): number[] => [
    preferUnbound ? (a.boundTo.length === 0 ? 0 : 1) : 0,
    a.boundTo.length,
    a.rate.lastPenaltyAt, // 0 (never penalized) sorts first
    a.addedAt,
  ];
  return [...candidates].sort((x, y) => {
    const rx = rank(x);
    const ry = rank(y);
    for (let i = 0; i < rx.length; i++) if (rx[i] !== ry[i]) return rx[i] - ry[i];
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  })[0];
}

export interface SpawnSelectOpts {
  /** The bee's harness slug — pins to an account that has this harness bound (boundTo), so a
   *  harness's bees co-locate on one credential and share the system/tools prefix cache. */
  harness?: string;
  /** The account this (logical) bee last egressed through — kept sticky so its per-credential
   *  conversation cache survives across a re-spawn. */
  priorAccountId?: string;
  /** Injectable RNG for the drain SPREAD (default `Math.random`). Tests pass a fixed rng (e.g. `() => 0`
   *  → deterministic best) so spawn selection stays assertable. */
  rng?: () => number;
  /**
   * WI-41147 burn-rate governor toggle (default ON). The pure selector cannot read the
   * feature flag (async IO), so the impure caller (`selectSpawnAccount` in the store) reads
   * `FLAGS.ACCOUNT_BURN_GOVERNOR` and passes it down. `false` restores pre-governor selection
   * byte-for-byte.
   */
  burnGovernor?: boolean;
}

/** Beyond this age the unified-budget projection is treated as unknown (the gateway hasn't egressed
 *  through that account recently), so the drain selector falls back to recency order. */
export const DRAIN_UTIL_STALE_MS = 10 * 60_000;
/** A window resetting within this horizon is "about to reset" — drain its remaining budget first
 *  (use-it-before-you-lose-it: that budget vanishes at the reset). */
export const DRAIN_URGENT_RESET_MS = 20 * 60_000;
/** At/above this unified utilization an account is effectively full — don't route fresh load to it. */
export const DRAIN_FULL_UTIL = 0.97;
/** Cache-affinity weight multiplier for a harness's soft-pinned account in the drain SPREAD
 *  (account-spawn-spread fix, 2026-06-23). The pinned account is gently preferred (warm system/tools
 *  prefix cache) but NOT exclusive: with a bonus of B and N equal-headroom peers it draws ≈ B/(B+N−1)
 *  of the hive's bees. Kept LOW (1.3) so HEADROOM dominates — when a budgeted hive is one giant
 *  soft-pinned slug (the autonomous fleet under `papercusp`), a strong bonus would re-funnel every bee
 *  onto the pinned account even when peers have MORE budget; at 1.3 affinity is a tiebreaker, not an
 *  override, so the account with the most budget still draws the most load. Env-tunable; 1 = pure spread. */
export const SOFT_PIN_AFFINITY_WEIGHT = Number(process.env.PAPERCUSP_SPAWN_SOFT_PIN_AFFINITY_WEIGHT) || 1.3;

/**
 * The burn-governor verdict for one account's rate state, STALE-GATED (WI-41147): a reading
 * older than `DRAIN_UTIL_STALE_MS` (or never observed) stands the governor down — stale
 * readings are the existing wall machinery's jurisdiction (`drainUtil7d` discounts them with
 * reset-pending nuance), and a projection fitted over stale points would be exactly the kind
 * of confident-but-wrong verdict the governor exists to prevent. ONE authority for both the
 * selection wiring below and the `accounts:status` surface, so they can never disagree.
 */
export function accountBurnVerdict(rate: AccountRateState, now: number): BurnVerdict {
  const at = rate.utilizationAt;
  if (rate.usageCreditsAvailable === true || at === undefined || now - at > DRAIN_UTIL_STALE_MS) {
    return {
      burnRatePerHr: null,
      headroomFraction: rate.utilization7d !== undefined && Number.isFinite(rate.utilization7d)
        ? Math.max(0, 1 - rate.utilization7d)
        : null,
      projectedExhaustionAt: null,
      exhaustsBeforeReset: false,
      action: 'none',
      utilization7d:
        rate.utilization7d !== undefined && Number.isFinite(rate.utilization7d) ? rate.utilization7d : null,
      // The gate stands the governor DOWN — it asserts no wall of its own even when the stale
      // reading it carries sits at/over 1.0. That is precisely why `disposition` is stamped at
      // the deciding branch rather than re-derived from `utilization7d` by a reader (P-001).
      disposition: 'no-verdict',
      reason:
        rate.usageCreditsAvailable === true
          ? 'Codex usage credits available — included allowance does not bound account capacity'
          : at === undefined
          ? 'usage window never observed — burn governor stands down'
          : 'usage reading stale — burn governor stands down (the wall machinery owns stale readings)',
    };
  }
  return evaluateAccountBurn(rate, now);
}

/** Shorthand: the stale-gated burn action for selection wiring. */
export function accountBurnAction(a: Pick<ClaudeAccount, 'rate'>, now: number): BurnAction {
  return accountBurnVerdict(a.rate, now).action;
}

/** The account's drain-relevant utilization: the observed unified-5h fraction, or 0 when never
 *  observed / stale / window-expired (treat as most-available so a cold pool degrades gracefully). */
export function drainUtil(a: ClaudeAccount, now: number): number {
  const r = a.rate;
  if (r.utilization === undefined) return 0;
  // WINDOW-RESET EXPIRY (stale-capped-projection fix, 2026-06-29): once the observed 5h window has
  // passed its reset, the prior reading describes a window that NO LONGER EXISTS — the rolling budget
  // is freed at the reset, so the stale "capped" fraction must self-expire to 0. Without this a fresh
  // (within-staleness) reading kept gating a freed account as full, so it stayed excluded from
  // rotation until a human ran `accounts:reset-rate` (owner-reported: ownerhandle + ownerhandle8 stuck capped
  // after their windows had already reset). Re-validates automatically on the next observation.
  if (r.windowResetAt !== undefined && now >= r.windowResetAt) return 0;
  if (r.utilizationAt !== undefined && now - r.utilizationAt > DRAIN_UTIL_STALE_MS) return 0;
  return r.utilization;
}

/**
 * The account's 7d-window (WEEKLY) utilization, or 0 when never observed / stale. On Claude Max the
 * 7d window is a HARDER constraint than the 5h: an account can read 5h-fresh yet sit near its weekly
 * cap, so routing fresh load by 5h-util alone hammers it into the 7d limit (the "ownerhandle2 trap":
 * 5h-util 0.09 but 7d-util 0.96 → a routed bee 429s on the weekly window). Shares `utilizationAt`
 * freshness with `drainUtil` (recordAccountWindow writes both together).
 */
export function drainUtil7d(a: ClaudeAccount, now: number): number {
  const r = a.rate;
  if (r.utilization7d === undefined) return 0;
  // WINDOW-RESET EXPIRY (mirrors drainUtil): a 7d reading past its weekly reset describes an expired
  // window → 0, so a weekly-capped account auto-re-enters rotation the instant its window resets — even
  // if the last observation is still "fresh" (within DRAIN_UTIL_STALE_MS). Handled BEFORE the staleness
  // branch so the freed budget is recognised whether the reading is fresh or stale.
  if (r.windowResetAt7d !== undefined && now >= r.windowResetAt7d) return 0;
  if (r.utilizationAt !== undefined && now - r.utilizationAt > DRAIN_UTIL_STALE_MS) {
    const weeklyResetPending = r.windowResetAt7d !== undefined && r.windowResetAt7d > now;
    if (weeklyResetPending && r.utilization7d >= DRAIN_FULL_UTIL) return r.utilization7d;
    return 0;
  }
  return r.utilization7d;
}

/**
 * Effective fullness for routing/ranking: the TIGHTER of the 5h and 7d windows. Ranking + gating by
 * this prefers BOTH-window headroom, so a 5h-fresh-but-7d-near-cap account is correctly deprioritized
 * in favor of an account with real headroom in both windows (7d-aware-account-selection-2026-06-17).
 */
export function effectiveDrainUtil(a: ClaudeAccount, now: number): number {
  const included = Math.max(drainUtil(a, now), drainUtil7d(a, now));
  return accountProvider(a) === 'codex' && a.rate.usageCreditsAvailable === true && included >= DRAIN_FULL_UTIL
    ? 0
    : included;
}

/**
 * Is this account effectively FULL for fresh load — paused, or its fresh unified-5h/7d utilization at/
 * above `DRAIN_FULL_UTIL`? Used to (a) LAZILY re-pin a soft cache-affinity pin off a near-cap account
 * (D-002) and (b) decide the account-aware class pause: the opus class only pauses globally when EVERY
 * account is full (mirrors the gateway failover — "only when ALL are exhausted does egress pause").
 */
export function accountFull(a: ClaudeAccount, now: number): boolean {
  // 7d-aware: full when EITHER window is at/over cap (effectiveDrainUtil = max(5h, 7d)), so a
  // 5h-fresh-but-weekly-capped account is not treated as fresh capacity.
  return !isAvailable(a, now) || effectiveDrainUtil(a, now) >= DRAIN_FULL_UTIL;
}

/**
 * USAGE WALL (WI-3310): until when is this account walled by an EXHAUSTED usage window — the
 * binding (latest) reset among the 5h/7d windows whose utilization reads at/over
 * `DRAIN_FULL_UTIL` — or 0 when it is not usage-walled.
 *
 * A usage wall and a rate-limit pause are DIFFERENT meters and must never be conflated:
 * `rate.pausedUntil` is deliberately BOUNDED (the gateway caps a weekly-cap pause at ~6h, and a
 * body-classified usage-cap without a parseable reset at ~1h, so one wrong header can never
 * strand an account for days) — which means **pause expiry is NOT usage recovery**. An account
 * whose pause lapsed but whose weekly window is still at 100% cannot serve a single request
 * until `windowResetAt7d`. Consumers that mean "can this account actually serve right now"
 * must check the wall too (`accountFull` / `accountStatus.available` / the stall-waker's
 * `capacityBack`), not just the pause.
 *
 * Self-healing exactly like `drainUtil`/`drainUtil7d` (which this delegates to): the wall
 * expires the instant the observed window's reset passes, and any fresh sub-cap reading clears
 * it immediately — so a wrong/stale at-cap reading can gate the account no longer than the
 * (provider-supplied) window reset itself.
 */
export function usageWalledUntil(a: ClaudeAccount, now: number): number {
  if (accountProvider(a) === 'codex' && a.rate.usageCreditsAvailable === true) return 0;
  let until = 0;
  const r = a.rate;
  if (drainUtil(a, now) >= DRAIN_FULL_UTIL && r.windowResetAt !== undefined && r.windowResetAt > now) {
    until = Math.max(until, r.windowResetAt);
  }
  if (drainUtil7d(a, now) >= DRAIN_FULL_UTIL && r.windowResetAt7d !== undefined && r.windowResetAt7d > now) {
    until = Math.max(until, r.windowResetAt7d);
  }
  return until;
}

/**
 * Is this account a valid SPAWN-SELECTION candidate — can a freshly-spawning bee pin to it?
 * Deliberately WIDER than `isAvailable` (account-spawn-eligibility fix, 2026-06-23): on Claude Max a
 * single transient per-minute 429 routinely carries a pause out to the multi-hour 5h/7d window reset
 * even when the account is NOT over budget (the D-003 phenomenon). `rate.pausedUntil` advances
 * monotonically and is never shortened on recovery, so that ONE 429 strands a budget-healthy account
 * out of spawn selection for 10-30 min (observed: ownerhandle util5h=0, penaltyCount=1, yet paused 26 min;
 * ownerhandle2/ownerhandle6 paused 12-13 min with their windows already reset). The narrow `isAvailable` filter
 * then collapses the candidate pool to a couple of accounts, so the fleet funnels onto one — it
 * RPM-storms while budgeted peers sit idle (the owner-reported "accounts have usage but aren't picked").
 *
 * Eligible when it has real budget (effective 5h∧7d utilization below the full mark) AND is not
 * GENUINELY rate-exhausted (not sustainedly-limited: ≥threshold real penalties in-window, or a fresh
 * at-cap reading). The gateway's per-(model,account) governor is the runtime pace authority — it
 * paces/rotates a still-throttled account at request time — so spawn selection should only EXCLUDE
 * accounts that are truly out of budget, not ones merely carrying a stale pause.
 *
 * EI-8070: `isSustainedlyLimited` must be checked UNCONDITIONALLY, not only when the account is
 * currently paused. The original version short-circuited `if (isAvailable(a, now)) return true` —
 * so an account that raced up 3+ real 429 penalties inside the 15-min window (genuinely can't keep
 * up) but whose MOST RECENT individual pause had already lapsed by the time of the check (each pause
 * was short; `isAvailable` back to true) read as unconditionally eligible, the sustained-penalty
 * signal never consulted at all. Live symptom (accounts:status, 2026-07-06): ownerhandle7/ownerhandle8/
 * ownerhandle8-direct/avistorewolf.com showed `sustainedlyLimited:true` with `available:true` — fresh
 * spawns kept getting routed to them (nothing here excluded them) and crash-looped within ~20-30s on
 * their first inference call, zero progress, across repeated placements. Now: budget below the full
 * mark AND not sustainedly-limited, in either order — a lapsed pause no longer hides an active
 * penalty streak.
 */
export function isSpawnEligible(a: ClaudeAccount, now: number, policy: ScalePolicy = DEFAULT_SCALE_POLICY): boolean {
  if (effectiveDrainUtil(a, now) >= DRAIN_FULL_UTIL) return false;
  return !isSustainedlyLimited(a, now, policy);
}

/**
 * Account-aware opus-pause decision (account-aware-rate-governor-routing-2026-06-16 Phase 1). A single
 * account's 429 must NOT pause the whole model class while other accounts have headroom — the class
 * "pauses" ONLY when EVERY account is full (paused or at/over its 5h cap). With ≥1 account having
 * headroom this is false, so the spawn-admission gate keeps admitting (routed to the fresh account by
 * `selectAccountForSpawn`). An EMPTY pool is NOT exhausted (single-credential fallback handles pacing).
 */
export function isClassExhausted(pool: AccountPool, now: number): boolean {
  if (pool.accounts.length === 0) return false;
  return pool.accounts.every((a) => accountFull(a, now));
}

/** Any account with headroom right now (the inverse — a spawn/in-process call can route somewhere
 *  without globally pausing the class). An empty pool reads "available" (frame-default fallback). */
export function anyAccountAvailable(pool: AccountPool, now: number): boolean {
  return pool.accounts.length === 0 || pool.accounts.some((a) => !accountFull(a, now));
}

/**
 * Choose the available account that best FILLS the aggregate Claude Max budget — the multi-account
 * capacity lever (more subscriptions = more aggregate 5h budget; D-003). Keeps every subscription's
 * 5h window productive instead of spreading thin or hammering one. Ranking (ascending = better),
 * among available (not paused) candidates:
 *   1. urgency — a window about to reset AND still under-full sorts first (use-it-before-you-lose-it);
 *   2. lowest current utilization (most remaining 5h budget) — balances load so no window sits idle;
 *   3. least-recently penalized; 4. oldest-added; 5. id (stable tie-break).
 * Utilization that is unknown or stale is treated as 0, so a cold pool degrades to recency order.
 * This is the consumer-Max budget-maximizing selector D-001 wrongly excluded as "unnecessary".
 */
export function selectAccountByDrain(pool: AccountPool, now: number, opts: SelectOpts = {}): ClaudeAccount | undefined {
  const { exclude = [], availableOnly = true, eligible = (a: ClaudeAccount, t: number) => !accountFull(a, t) } = opts;
  let candidates = pool.accounts.filter((a) => !exclude.includes(a.id));
  if (availableOnly) candidates = candidates.filter((a) => eligible(a, now));
  if (candidates.length === 0) return undefined;

  const urgent = (a: ClaudeAccount): boolean => {
    const reset = a.rate.windowResetAt;
    return reset !== undefined && reset - now > 0 && reset - now <= DRAIN_URGENT_RESET_MS && effectiveDrainUtil(a, now) < DRAIN_FULL_UTIL;
  };
  // 7d-aware rank: order by the TIGHTER window (max 5h/7d util) so selection prefers both-window
  // headroom (ownerhandle6) over a 5h-fresh-but-7d-near-cap account (ownerhandle2) — 7d-aware-account-selection.
  const rank = (a: ClaudeAccount): number[] => [urgent(a) ? 0 : 1, effectiveDrainUtil(a, now), a.rate.lastPenaltyAt, a.addedAt];
  const sorted = [...candidates].sort((x, y) => {
    const rx = rank(x);
    const ry = rank(y);
    for (let i = 0; i < rx.length; i++) if (rx[i] !== ry[i]) return rx[i] - ry[i];
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });
  if (!opts.spread) return sorted[0];
  // SPREAD (account-spawn-spread fix, 2026-06-23): distribute a concurrent burst across accounts
  // weighted by remaining headroom so the fleet fans out instead of every bee piling on the single
  // best account (which then RPM-storms while budgeted peers idle).
  //  - Prefer accounts SERVING right now; only spread into budget-healthy-but-paused candidates
  //    (admitted by `isSpawnEligible`) when NO available account remains — a stale predictive pause
  //    widens the fallback set without demoting accounts that are ready to serve immediately.
  //  - Preserve the URGENT class (use-it-before-you-lose-it): when any window is about to reset,
  //    spread only among those.
  const availableNow = sorted.filter((a) => isAvailable(a, now) && effectiveDrainUtil(a, now) < DRAIN_FULL_UTIL);
  const tier = availableNow.length > 0 ? availableNow : sorted;
  const urgentSet = tier.filter(urgent);
  return weightedHeadroomPick(urgentSet.length > 0 ? urgentSet : tier, now, opts.rng ?? Math.random, opts.affinityId);
}

/**
 * Pick from `cands` (already best-first) weighted by remaining headroom (1 − effective util, floored so
 * a near-full account keeps a slim chance), with an optional cache-affinity BONUS for `affinityId` (the
 * harness's soft-pinned account) so a hive prefers its warm-cache credential without piling every bee
 * on it. `rng()===0` deterministically returns the first (best) candidate, so deterministic
 * callers/tests are unchanged; a uniform `rng` spreads a burst roughly in proportion to the weights.
 */
function weightedHeadroomPick(
  cands: readonly ClaudeAccount[],
  now: number,
  rng: () => number,
  affinityId?: string,
): ClaudeAccount {
  if (cands.length <= 1) return cands[0];
  const weights = cands.map((a) => {
    const base = Math.max(0.05, 1 - effectiveDrainUtil(a, now));
    return a.id === affinityId ? base * SOFT_PIN_AFFINITY_WEIGHT : base;
  });
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rng() * total;
  for (let i = 0; i < cands.length; i++) {
    r -= weights[i];
    if (r < 0) return cands[i];
  }
  return cands[cands.length - 1];
}

/**
 * The result of `selectAccountForSpawn`. `accountId` is the chosen egress credential (undefined ⇒ no
 * available account → the caller sets no header, the gateway falls back to its active account).
 * `newlyPinned` is set ONLY when the DRAIN step assigned a fresh soft cache-affinity pin for `harness`
 * → `accountId` that the (impure) caller should PERSIST (account-cache-affinity-auto-pin Phase 1) so
 * the harness's next bees stick to the same credential. `pinSource` is observability: which rule chose.
 */
export interface SpawnSelection {
  accountId?: string;
  /** Set when DRAIN newly soft-pinned this harness to `accountId` — the caller persists the pin. */
  newlyPinned?: { harness: string; accountId: string };
  pinSource?: 'sticky' | 'manual-bind' | 'soft-pin' | 'drain';
}

/**
 * Pick the account a spawning bee should egress through (inference-gateway-multi-credential-routing
 * P-005, corrected to the Claude Max basis — D-003). Cache-affinity FIRST (the dominant cost lever —
 * the conversation/prompt cache is per-credential), then budget-draining among the rest:
 *   1. STICKY — the bee's prior account, if still available (preserves its per-credential cache — this
 *      is the per-BEE multi-turn affinity; the dominant cache lever).
 *   2. MANUAL-BIND — an available account with the harness in `boundTo` (owner/deploy pin); ties → drain.
 *   3. SOFT-PIN as an AFFINITY HINT (account-spawn-spread fix, 2026-06-23) — the account a harness was
 *      auto-pinned to is PREFERRED in the drain spread (warm system/tools prefix cache) but is NO LONGER
 *      a hard funnel: a busy hive's CONCURRENT bees fan out across budgeted peers instead of every bee
 *      piling on the one pinned account and RPM-storming it. A full/paused pin contributes no hint.
 *   4. DRAIN — SPREAD across AVAILABLE accounts weighted by headroom (+ the affinity bonus). When
 *      the harness has NO pin yet, the chosen account is surfaced via `newlyPinned` to ESTABLISH the
 *      hive's cache anchor; an existing pin is kept stable (not re-thrashed per spilled bee).
 * Pure — the soft-pin WRITE-BACK is the caller's (keeps this exhaustively unit-testable).
 */
export function selectAccountForSpawn(pool: AccountPool, now: number, opts: SpawnSelectOpts = {}): SpawnSelection {
  // EI-8070: every eligibility gate below excludes on `hardPinUnsafe`, NOT the original bare
  // `!accountFull`. This function HARD-PINS its pick (the gateway honors a pin with no failover —
  // see the note on step 4), so it deliberately keeps `accountFull`'s STRICT "any active pause
  // excludes" behavior (a stale-but-short pause could still be live at the exact moment the pinned
  // spawn makes its first call — unlike `isSpawnEligible`, which is right to tolerate that for
  // non-pinning callers, this call site is not one of them). What it was MISSING: a sustained
  // repeated-429 streak (isSustainedlyLimited via penaltyCount, not util) whose most recent
  // individual pause had already lapsed by selection time read as perfectly fine and kept getting
  // freshly-spawned bees hard-pinned onto it — they died on their first inference call. Live:
  // accounts:status showed ownerhandle7/ownerhandle8/ownerhandle8-direct/avistorewolf.com as
  // sustainedlyLimited:true with available:true; fresh cup:spawn placements kept landing there and
  // crash-looped (sessionState:ended within ~20-30s, zero progress).
  // WI-41147: the burn governor's SHED verdict (window projected to exhaust before it resets,
  // imminently, on a FRESH reading — see accountBurnVerdict's stale gate) also makes an account
  // hard-pin-unsafe: pinning a fresh spawn onto an account about to hit its 7d wall is exactly
  // the 2026-08-23 incident pattern (the pinned CLI dies mid-session at the wall; the gateway
  // honors a pin with no failover). The gateway's UNPINNED failover path may still use the
  // account for individual calls — shed only refuses the hard pin. Cached per selection call:
  // the verdict is pure over the row, and one spawn selection consults it up to 3×/account.
  const burnOn = opts.burnGovernor !== false;
  const burnActionCache = new Map<string, BurnAction>();
  const healthKeyCache = new Map<string, number>();
  const burnActionOf = (a: ClaudeAccount, t: number): BurnAction => {
    if (!burnOn) return 'none';
    let v = burnActionCache.get(a.id);
    if (v === undefined) {
      v = accountBurnAction(a, t);
      burnActionCache.set(a.id, v);
    }
    return v;
  };
  const healthKeyOf = (a: ClaudeAccount, t: number): number => {
    let key = healthKeyCache.get(a.id);
    if (key !== undefined) return key;
    key = accountLoadKey({
      paused: !isAvailable(a, t),
      exhausted: isSustainedlyLimited(a, t),
      capacityWindows: [
        { utilization: drainUtil(a, t), resetAt: a.rate.windowResetAt },
        { utilization: drainUtil7d(a, t), resetAt: a.rate.windowResetAt7d },
      ],
      capacityFullAt: DRAIN_FULL_UTIL,
      now: t,
      burnAction: burnActionOf(a, t),
    });
    healthKeyCache.set(a.id, key);
    return key;
  };
  const hardPinUnsafe = (a: ClaudeAccount, t: number): boolean => healthKeyOf(a, t) === Infinity;
  // 1. Sticky to the prior account while it is still usable (cache affinity dominates cost).
  if (opts.priorAccountId) {
    const prior = getAccount(pool, opts.priorAccountId);
    if (prior && !hardPinUnsafe(prior, now)) return { accountId: prior.id, pinSource: 'sticky' };
  }
  const harness = opts.harness;
  let affinityId: string | undefined;
  if (harness) {
    // 2. Manually-bound account (owner/deploy intent), best drain among the bound ties — a hard pin.
    const bound = pool.accounts.filter((a) => a.boundTo.includes(harness) && !hardPinUnsafe(a, now));
    const boundBest = selectAccountByDrain({ accounts: bound }, now, { eligible: (a, t) => !hardPinUnsafe(a, t) });
    if (boundBest) return { accountId: boundBest.id, pinSource: 'manual-bind' };
    // 3. Soft cache-affinity pin → an AFFINITY HINT for the spread (weighted preference, not a funnel).
    //    Skipped when full/paused/sustainedly-limited (lazy re-pin, D-002) so the hive re-anchors onto
    //    fresh capacity.
    const softPinned = softPinnedAccount(pool, harness);
    if (softPinned && !hardPinUnsafe(softPinned, now)) affinityId = softPinned.id;
  }
  // 4. Budget-drain across the whole pool — SPREAD across accounts that are
  //    available RIGHT NOW. Do not pin a paused account into a spawned CLI turn:
  //    the gateway honors the pin and returns a terminal 429 instead of rotating,
  //    so autonomous roles can die before emitting their required artifacts. When
  //    no account is safely pinnable, return no header and let the gateway's
  //    unpinned active/failover path handle the request.
  //    WI-41147 THROTTLE (burn governor): "prefer other accounts" — a first pass EXCLUDES
  //    throttled accounts (projected to exhaust before their window resets, but not imminently);
  //    only when NO un-throttled candidate survives does a second pass admit them. Graceful by
  //    construction: the governor can deprioritize but never shrink the servable set below what
  //    the wall machinery alone would allow.
  const drained =
    selectAccountByDrain(pool, now, {
      spread: true,
      rng: opts.rng,
      affinityId,
      eligible: (a, t) => !hardPinUnsafe(a, t) && burnActionOf(a, t) !== 'throttle',
    }) ?? selectAccountByDrain(pool, now, { spread: true, rng: opts.rng, affinityId, eligible: (a, t) => !hardPinUnsafe(a, t) });
  if (!drained) return {};
  return {
    accountId: drained.id,
    pinSource: drained.id === affinityId ? 'soft-pin' : 'drain',
    // ESTABLISH the hive's cache anchor only when it had none; keep an existing pin stable so a bee that
    // spilled off it via the spread does not re-pin the whole harness onto its spill target.
    ...(harness && !affinityId ? { newlyPinned: { harness, accountId: drained.id } } : {}),
  };
}

export type ScaleOutDecision =
  | { provision: true; account: ClaudeAccount }
  | { provision: false; reason: 'no-fresh-account' | 'not-sustained' };

/**
 * Decide whether to scale out off an exhausted account (P-021): when the account is
 * sustainedly limited (gate optional via `requireSustained`) AND a fresh available
 * account exists, return it to provision a new Swarm onto; otherwise don't (the
 * caller falls back to the existing pause). Pure.
 */
export function decideScaleOut(
  pool: AccountPool,
  exhaustedId: string,
  now: number,
  opts: { policy?: ScalePolicy; requireSustained?: boolean } = {},
): ScaleOutDecision {
  const policy = opts.policy ?? DEFAULT_SCALE_POLICY;
  const requireSustained = opts.requireSustained ?? true;
  const exhausted = getAccount(pool, exhaustedId);
  if (requireSustained && exhausted && !isSustainedlyLimited(exhausted, now, policy)) {
    return { provision: false, reason: 'not-sustained' };
  }
  const fresh = selectAccountByHeadroom(pool, now, {
    exclude: [exhaustedId],
    availableOnly: true,
    preferUnbound: true,
  });
  if (!fresh) return { provision: false, reason: 'no-fresh-account' };
  return { provision: true, account: fresh };
}
