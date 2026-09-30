/**
 * Typed LLM-call error.
 *
 * A host's concrete `llmCall` (the gym judge / sim-user / generators) used to
 * throw a bare `Error(message)` on a failed turn, which a rate-limited judge
 * turned into a thrown exception that aborted the WHOLE A/B run. `LlmCallError`
 * instead carries a classified `TurnError` so an A/B loop can tell a
 * `rate_limited` failure (pause + resume) from a permanent one (skip) — never
 * crashing the run.
 *
 * This lib defines a minimal local `TurnError` shape (structurally matching the
 * host agent taxonomy) so it carries NO host import — a host's richer
 * `TurnError` assigns into this type without a cast.
 */

/** Minimal classification of an LLM turn failure (a host may pass a superset). */
export type TurnErrorClass =
  | 'rate_limited'
  | 'usage_limit'
  | 'overloaded'
  | 'timeout'
  | 'transient_io'
  | 'auth'
  | 'context_overflow'
  | 'agent_crash'
  | 'empty_output'
  | 'malformed_output'
  | 'permanent';

/**
 * Structural subset of the host agent's `TurnError`. Only the fields the
 * error-handling here actually reads are required; a host's wider object (with
 * extra fields like `provider`) is assignable without a cast. We deliberately
 * do NOT declare an index signature — `[k: string]: unknown` would make a host
 * `interface TurnError` (which has none) fail to assign ("index signature
 * missing"), the opposite of the intent. Excess host fields are tolerated by
 * normal structural assignment anyway.
 */
export interface TurnError {
  class: TurnErrorClass;
  message: string;
  /** From `retry-after` (rate_limited/overloaded), in ms. */
  retryAfterMs?: number;
  /** Epoch ms when the limiting bucket replenishes (from `*-reset`). */
  resetAt?: number;
  /** Convenience: is this class worth another attempt (with the right wait)? */
  retryable?: boolean;
}

export class LlmCallError extends Error {
  readonly turn: TurnError;
  constructor(turn: TurnError) {
    super(turn.message);
    this.name = 'LlmCallError';
    this.turn = turn;
  }
}

export function isLlmCallError(e: unknown): e is LlmCallError {
  return e instanceof LlmCallError;
}

export interface RateLimitInfo {
  resetAt?: number;
  retryAfterMs?: number;
}

/**
 * If `e` is a rate-limited / overloaded / usage-capped turn error, return its reset hints (so the
 * caller can wait-until-reset and resume); otherwise null. `overloaded` (529/5xx) is included
 * because it, like a 429, is transient backpressure to wait out rather than score. `usage_limit`
 * (a plan/subscription cap) is included so an unattended loop pauses/skips on a cap instead of
 * aborting — its reset is typically hours off, so the bounded-pause caller waits then rethrows,
 * which records the run as rate-limited + excludes it (never a crash).
 */
export function rateLimitInfo(e: unknown): RateLimitInfo | null {
  if (
    e instanceof LlmCallError &&
    (e.turn.class === 'rate_limited' || e.turn.class === 'overloaded' || e.turn.class === 'usage_limit')
  ) {
    return { resetAt: e.turn.resetAt, retryAfterMs: e.turn.retryAfterMs };
  }
  return null;
}
