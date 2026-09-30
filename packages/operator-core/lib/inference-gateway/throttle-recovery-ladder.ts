/**
 * throttle-recovery-ladder.ts — the lane-neutral OUTER RECOVERY LADDER decision
 * (plan `codex-429-recovery-and-routing-2026-09-01`, P-009).
 *
 * WHAT THIS IS. When `executeGatewayRequestKernel` settles on a throttle the
 * kernel's own ladder (reserve-tier retry, sibling-IP, rotation) could not
 * rescue, the CALLER decides whether to intercept before relaying: wait the
 * penalty out on the held slot, absorb (release + re-acquire), or forward a
 * SHAPED terminal response. Until P-009 that decision lived inline in the
 * Claude handler's `downstream.start` closure (gateway.ts) and the codex lanes
 * had only the terminal-shaping half (WI-2038027 P1) — a codex pool that
 * throttled transiently was never waited out or absorbed, so codex sessions
 * shed where Claude sessions recovered. This module is the ONE decision both
 * providers consult; the ACT halves (sleeping, slot release/re-acquire, model
 * downgrade) stay in each lane because they are made of lane-owned machinery
 * (governor slots, admission queues, pool rotation, `res` timers).
 *
 * THE RUNGS, in order — transcribed 1:1 from the live Claude ladder so the
 * extraction changes no behaviour (D-003 discipline of the kernel-adoption
 * plan):
 *
 *   (1) BOUNDED TRANSIENT WAIT — the throttle is SHORT (reset within
 *       `waitCapMs`): wait it out on this same slot and retry, bounded by the
 *       per-request `transientTotalWaitBudgetMs` and the wedge-prevention
 *       `retryDeadlineAt`.
 *   (2) EXTENDED ABSORPTION — the wait rung cannot rescue it (walled past the
 *       cap, or budgets spent) but the caller's absorb budget is open and no
 *       response head has been written: release the slot, wait, re-acquire on
 *       the pool's then-best account, retry. A 529 overload carries its own
 *       `backoffMs` because nothing rate-pauses the account, so an immediate
 *       re-acquire would return instantly and re-burn the overloaded upstream.
 *       The absorb is a bet that the POOL recovers inside the budget, so a
 *       caller that knows the pool's recovery horizon (`poolRecoveryAt`, the
 *       codex lanes' `AccountPool.earliestAvailableAt`) hands it in and the
 *       rung declines when the horizon lies past the absorb deadline: an
 *       all-walled pool whose earliest reset is hours out FAILS FAST instead of
 *       sleeping the whole budget to re-pick an account that cannot have
 *       recovered (plan codex-auto-route-all-walled-fail-fast-2026-09-05).
 *   (3) FORWARD — the ladder is exhausted. `transient:false` here IS the
 *       all-walled fail-fast: a multi-hour usage wall never burns the wait
 *       budget, it falls straight through to the lane's terminal shaping (and,
 *       on the Claude lane, the lane-specific last-resort opus→sonnet
 *       downgrade, which keys off exactly this `transient` flag).
 *
 * Rotation suppression (G1 fleet-wide bare-burst) is NOT here: it is already a
 * kernel-adapter hook (`canRotate`), i.e. lane-neutral by construction, and on
 * the codex lanes exhausted accounts are parked by `AccountPool.onExhausted`
 * so an all-walled pool stops rotating without a separate flag.
 *
 * Everything is a parameter — budgets, caps, header names — because the
 * constants live in gateway.ts (some exported, all lane-tuned) and this module
 * must not import the gateway (the gateway imports it).
 */

/** Budgets a lane hands the decision — all lane-tuned gateway constants. */
export interface ThrottleLadderBudgets {
  /**
   * A reset at/under this bound is TRANSIENT (waitable); past it the throttle
   * is a wall and rung (1) never fires (Claude: ALL_THROTTLED_RECOVERY_WAIT_CAP_MS).
   */
  waitCapMs: number;
  /** Total rung-(1) wait allowed across the whole request (Claude: TRANSIENT_TOTAL_WAIT_BUDGET_MS). */
  transientTotalWaitBudgetMs: number;
  /**
   * Absorb backoff for a server-overload status (529): nothing rate-pauses the
   * account, so the re-acquire returns immediately — back off first
   * (Claude: OVERLOAD_529_BACKOFF_MS).
   */
  overloadBackoffMs: number;
}

/** Per-request ladder state at the moment of decision. */
export interface ThrottleLadderState {
  /** Rung-(1) wait already spent on this request. */
  transientWaitedMs: number;
  /** Wedge-prevention deadline: never wait past it, never start a wait after it. */
  retryDeadlineAt: number;
  /** Absorb budget deadline; 0 ⇒ the absorb is off for this request. */
  absorbDeadlineAt: number;
  /** A written response head forecloses the absorb (the caller already saw bytes). */
  headersSent: boolean;
}

export type ThrottleLadderDecision =
  | { action: 'wait'; waitMs: number; transient: boolean }
  | { action: 'absorb'; backoffMs: number; transient: boolean }
  | { action: 'forward'; transient: boolean };

/**
 * The rung selection. `retryIntent` is the lane classifier's verdict that this
 * settle is a retryable throttle class at all (`classification.kind !==
 * 'forward'`); with it false the decision is always `forward` (the `transient`
 * flag still computed, for telemetry symmetry).
 *
 * Statuses are deliberately NOT interpreted here beyond the 529 backoff pick:
 * WHICH statuses reach the ladder is the lane classifier's job (Claude:
 * 429/529/403-org; codex: 429), and folding a status whitelist in here would
 * make the module disagree with the classifier that routed to it.
 */
export function decideThrottleRecovery(input: {
  status: number;
  retryIntent: boolean;
  /**
   * The instant the throttled account can serve again, as the lane's dialect
   * parser learned it from the failing attempt (0/absent ⇒ unknown). Claude:
   * `lastExhaustResetAt` from `parseRateReset` + governor penalties; codex:
   * `parseCodexRateReset(...).resetAt` with the lane's short-backoff fallback
   * for a transient burst carrying no reset header.
   */
  lastExhaustResetAt: number;
  /**
   * The POOL's recovery horizon, when the lane can compute one
   * (`AccountPool.earliestAvailableAt`): 0 ⇒ some account can serve now;
   * an epoch ms ⇒ the earliest instant any account is expected back;
   * `Infinity` ⇒ every account is out with no known recovery. Omitted ⇒ the
   * caller has no pool view and rung (2) keeps its pre-horizon behaviour.
   * Rung (2) fires only when this horizon falls at/before the absorb deadline.
   */
  poolRecoveryAt?: number;
  state: ThrottleLadderState;
  budgets: ThrottleLadderBudgets;
  /** Injectable clock for tests. */
  now?: number;
}): ThrottleLadderDecision {
  const now = input.now ?? Date.now();
  const { state, budgets } = input;
  // A genuinely transient throttle resets within the recovery cap; a usage cap
  // or org pause is hours out and is never waited on.
  const transient = input.lastExhaustResetAt > 0 && input.lastExhaustResetAt - now <= budgets.waitCapMs;
  if (!input.retryIntent) return { action: 'forward', transient };
  const waitMs = Math.min(
    Math.max(0, input.lastExhaustResetAt - now),
    budgets.waitCapMs,
    // Never wait PAST the wedge-prevention deadline.
    Math.max(0, state.retryDeadlineAt - now),
  );
  // (1) BOUNDED TRANSIENT WAIT.
  if (
    transient &&
    waitMs > 0 &&
    state.transientWaitedMs + waitMs <= budgets.transientTotalWaitBudgetMs &&
    now < state.retryDeadlineAt
  ) {
    return { action: 'wait', waitMs, transient };
  }
  // (2) EXTENDED ABSORPTION — only a bet worth placing when the pool can recover
  // inside the budget; a known horizon past the deadline is the all-walled fail-fast.
  const poolRecoversInBudget = input.poolRecoveryAt === undefined || input.poolRecoveryAt <= state.absorbDeadlineAt;
  if (state.absorbDeadlineAt > 0 && now < state.absorbDeadlineAt && !state.headersSent && poolRecoversInBudget) {
    return {
      action: 'absorb',
      backoffMs: input.status === 529 ? budgets.overloadBackoffMs : 0,
      transient,
    };
  }
  // (3) FORWARD — all-walled fail-fast when !transient, plain exhaustion otherwise.
  return { action: 'forward', transient };
}

/** What a lane merges into its outgoing headers for a terminal throttle. */
export interface TerminalThrottleShaping {
  headers: Record<string, string>;
  /** The capped client-facing retry-after, when one was requested (seconds). */
  retryAfterSec: number | null;
}

/**
 * Terminal shaping — the headers a lane stamps on a throttle it is FORWARDING
 * as its final answer, so a downstream CLI neither retries a wall forever nor
 * dies before the stall-waker can resume it:
 *
 *  - the retries-exhausted marker, so "slow" is distinguishable from "never";
 *  - optionally a retry-after CAPPED at the lane's bee cap (codex lanes): by
 *    the time the client re-asks, routing has walked to a healthy account or
 *    the stall-waker owns the recovery;
 *  - optionally `x-should-retry: false` (Claude lane): a raw upstream
 *    `x-should-retry: true` invites the Anthropic SDK to silently retry a
 *    terminal condition forever.
 *
 * Which options a lane picks is that lane's live contract — this function
 * exists so the codex twins share one implementation and every future lane
 * states its shaping as data, not as a re-typed block.
 */
export function shapeTerminalThrottle(input: {
  /** Attempts the gateway burned before giving up (the marker's value). */
  attempts: number;
  /** Header NAME for the exhausted marker (gateway's RETRIES_EXHAUSTED_HEADER). */
  retriesExhaustedHeader: string;
  /** Emit a capped retry-after (codex lanes). */
  retryAfter?: {
    /** The dialect-parsed reset instant; null ⇒ fall back to `fallbackSec`. */
    resetAt: number | null;
    /** Retry-after when no reset is known (gateway's LOADSHED_RETRY_AFTER_SEC). */
    fallbackSec: number;
    /** Cap so a bee re-asks soon regardless of the wall (gateway's BEE_RETRY_AFTER_CAP_S). */
    capS: number;
  };
  /** Emit `x-should-retry: false` (Claude lane's SDK-loop suppression). */
  suppressClientRetry?: boolean;
  /** Injectable clock for tests. */
  now?: number;
}): TerminalThrottleShaping {
  const now = input.now ?? Date.now();
  const headers: Record<string, string> = {
    [input.retriesExhaustedHeader]: String(input.attempts),
  };
  let retryAfterSec: number | null = null;
  if (input.retryAfter) {
    const resetAt = input.retryAfter.resetAt ?? now + input.retryAfter.fallbackSec * 1000;
    retryAfterSec = Math.min(input.retryAfter.capS, Math.max(1, Math.ceil((resetAt - now) / 1000)));
    headers['retry-after'] = String(retryAfterSec);
  }
  if (input.suppressClientRetry) headers['x-should-retry'] = 'false';
  return { headers, retryAfterSec };
}
