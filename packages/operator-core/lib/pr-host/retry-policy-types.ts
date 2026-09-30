/**
 * pr-host/retry-policy-types — pure backoff/retry decision for the
 * P-042 poll daemon per papercusp-dogfood-v5 §8.4 audit M.
 *
 * Types-only and PURE. No I/O, no clock dependency (callers pass
 * `now`), no host driver. The runtime (poll-daemon.ts) calls
 * `decideRetry()` on each PrHost error to figure out whether to
 * retry + how long to wait.
 *
 * Tenth module in the dogfood-arc types-only spine. Same one-per-
 * design-anchor pattern.
 *
 * Sources from P-042c/d/e in
 * `papercusp-dogfood-phase7-pr-lifecycle-2026-05-24.md`:
 *   c) Exponential backoff on 5xx (max 5min).
 *   d) Honors `X-RateLimit-Reset` header on 429.
 *   e) OAuth-refresh on 401; alert user on 401-after-refresh.
 *
 * Why pure: backoff math is easy to get wrong in a daemon (off-by-
 * one on attempt counter, integer overflow, missing jitter). Pulling
 * it out lets us exhaustively test the gate at every attempt count
 * + error kind.
 */

import { type PrHostError } from './types';

/**
 * Three retry outcomes:
 *
 *   `wait`              — back off + retry after `delay_ms`.
 *   `oauth_refresh_then_retry` — call gh-token's refresh path first,
 *                                then retry once. If THAT fails, the
 *                                next decideRetry sees `attempt+1`
 *                                with an unauthorized error → maps
 *                                to `give_up` (or `alert_user`).
 *   `give_up`           — terminal. Surface to UI or audit log.
 *   `alert_user`        — terminal AND surface a banner (401 after
 *                         a previous refresh failed).
 */
export type RetryDecision =
  | { kind: 'wait'; delay_ms: number; reason: RetryReason }
  | { kind: 'oauth_refresh_then_retry' }
  | { kind: 'give_up'; reason: GiveUpReason }
  | { kind: 'alert_user'; reason: AlertReason };

export type RetryReason =
  | 'exponential_backoff_5xx'
  | 'rate_limit_reset_window'
  | 'transient_network';

export type GiveUpReason =
  | 'terminal_error'
  | 'max_attempts_exceeded'
  | 'not_found';

export type AlertReason = 'oauth_refresh_failed_user_action_needed';

/**
 * Policy configuration. Tunable per-deployment; defaults align with
 * P-042c/d's spec (max-5min backoff cap, exponential factor 2,
 * starting at 1s).
 */
export interface RetryPolicyConfig {
  /** Initial backoff in ms. Default 1000 (1s). */
  initial_backoff_ms: number;
  /** Multiplier per attempt. Default 2 (doubling). */
  backoff_multiplier: number;
  /** Cap per single backoff. Default 300_000 (5min per P-042c). */
  max_backoff_ms: number;
  /** Hard cap on retry attempts before giving up. Default 8 (gives
   * ~8.5min of cumulative backoff before terminal). */
  max_attempts: number;
  /** Random jitter as a fraction of the backoff (0..1). Default 0.1
   * (±10%) — keeps multiple harnesses from polling in sync after a
   * synchronized GitHub outage. */
  jitter_fraction: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicyConfig = {
  initial_backoff_ms: 1000,
  backoff_multiplier: 2,
  max_backoff_ms: 5 * 60 * 1000,
  max_attempts: 8,
  jitter_fraction: 0.1,
};

/**
 * Context the daemon supplies on each decideRetry call.
 *
 *   `attempt` — number of failed attempts so far (0 = first failure,
 *               this call decides what to do after attempt #1
 *               returned an error).
 *   `oauth_refresh_attempted` — has the daemon already tried the
 *               401-refresh path in THIS retry sequence? (Resets when
 *               the call eventually succeeds.) Used by the 401-after-
 *               refresh→alert path.
 *   `now`     — caller-supplied epoch ms. Lets the test suite drive
 *               deterministic now.
 *   `random`  — caller-supplied 0..1 RNG sample. Pure-function
 *               jitter; callers pass `Math.random()`.
 */
export interface RetryContext {
  attempt: number;
  oauth_refresh_attempted: boolean;
  now: number;
  random: number;
}

/**
 * Pure decision function. Inspects the error + context, returns a
 * RetryDecision. The daemon then either schedules a wait, fires the
 * OAuth refresh, surfaces a banner, or marks the poll dead.
 */
export function decideRetry(
  error: PrHostError,
  ctx: RetryContext,
  config: RetryPolicyConfig = DEFAULT_RETRY_POLICY,
): RetryDecision {
  // Max-attempts guard (applies to every retryable case).
  if (ctx.attempt >= config.max_attempts) {
    return { kind: 'give_up', reason: 'max_attempts_exceeded' };
  }

  switch (error.kind) {
    case 'unauthorized':
      if (ctx.oauth_refresh_attempted) {
        // We already tried refreshing; this 401 is post-refresh.
        // Surface to user — token is bad and the user needs to
        // re-OAuth.
        return {
          kind: 'alert_user',
          reason: 'oauth_refresh_failed_user_action_needed',
        };
      }
      return { kind: 'oauth_refresh_then_retry' };

    case 'rate_limited':
      // Honor X-RateLimit-Reset (per P-042d) when set; fall back to
      // exponential backoff if not.
      if (typeof error.retry_after_ms === 'number' && error.retry_after_ms > 0) {
        return {
          kind: 'wait',
          delay_ms: error.retry_after_ms,
          reason: 'rate_limit_reset_window',
        };
      }
      return {
        kind: 'wait',
        delay_ms: computeBackoffMs(ctx.attempt, ctx.random, config),
        reason: 'exponential_backoff_5xx',
      };

    case 'server_error':
      return {
        kind: 'wait',
        delay_ms: computeBackoffMs(ctx.attempt, ctx.random, config),
        reason: 'exponential_backoff_5xx',
      };

    case 'network_error':
      return {
        kind: 'wait',
        delay_ms: computeBackoffMs(ctx.attempt, ctx.random, config),
        reason: 'transient_network',
      };

    case 'not_found':
      // P-042f: demote to gone. Terminal.
      return { kind: 'give_up', reason: 'not_found' };

    case 'forbidden':
    case 'conflict':
    case 'validation':
    case 'unsupported':
      return { kind: 'give_up', reason: 'terminal_error' };
  }
}

/**
 * Compute the next backoff delay with exponential + jitter. Caps
 * at `config.max_backoff_ms` per P-042c.
 *
 * Formula:
 *   base = initial × multiplier ^ attempt
 *   capped = min(base, max_backoff)
 *   jittered = capped × (1 - jitter + 2 × jitter × random)
 *
 * For default config (1s start, 2× multiplier, 5min cap, ±10%):
 *   attempt 0: ~1s   ± 100ms
 *   attempt 1: ~2s   ± 200ms
 *   attempt 2: ~4s   ± 400ms
 *   attempt 3: ~8s   ± 800ms
 *   attempt 4: ~16s  ± 1.6s
 *   attempt 5: ~32s  ± 3.2s
 *   attempt 6: ~64s  ± 6.4s
 *   attempt 7: ~128s ± 12.8s
 *   attempt 8: ~256s ± 25.6s (under 5min cap)
 *   attempt 9: ~300s ± 30s   (capped)
 */
export function computeBackoffMs(
  attempt: number,
  random: number,
  config: RetryPolicyConfig = DEFAULT_RETRY_POLICY,
): number {
  const base = config.initial_backoff_ms * Math.pow(config.backoff_multiplier, attempt);
  const capped = Math.min(base, config.max_backoff_ms);
  const jitter = config.jitter_fraction;
  // random is 0..1 → scale to -1..+1, multiply by jitter fraction.
  const offset = (random * 2 - 1) * jitter;
  const result = Math.round(capped * (1 + offset));
  return Math.max(0, result);
}

/**
 * Predicate: should the next-attempt counter reset after this
 * decision? `oauth_refresh_then_retry` is a single-shot — the next
 * attempt is still part of the same retry sequence and SHOULD have
 * `attempt + 1`. Same for `wait`. Terminal decisions (give_up,
 * alert_user) end the sequence; the next call starts at attempt=0.
 */
export function continuesSequence(decision: RetryDecision): boolean {
  return decision.kind === 'wait' || decision.kind === 'oauth_refresh_then_retry';
}

/**
 * Sum every wait the decision sequence would impose if we ran the
 * full backoff to max_attempts. Useful for capacity-planning math
 * + the "cumulative backoff before terminal" docstring.
 */
export function totalBackoffBudgetMs(
  config: RetryPolicyConfig = DEFAULT_RETRY_POLICY,
): number {
  let total = 0;
  // Compute mid-point (random=0.5 → no jitter offset) at every attempt.
  for (let i = 0; i < config.max_attempts; i++) {
    total += computeBackoffMs(i, 0.5, config);
  }
  return total;
}

/**
 * The error kinds the poll daemon SHOULD see and retry on (vs.
 * "should never see in normal operation"). Used by the daemon's
 * audit log to differentiate "expected transient" from "schema-
 * level surprise."
 */
export const EXPECTED_TRANSIENT_ERROR_KINDS = [
  'rate_limited',
  'server_error',
  'network_error',
  'unauthorized', // expected on token expiry; refresh handles it
] as const;
