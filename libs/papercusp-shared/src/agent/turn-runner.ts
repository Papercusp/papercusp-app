/**
 * runAgentTurn — the AGENT wrapper over the generic resilience loop (RB-003 / RB-013).
 *
 * Thin by design: it maps an agent backend invocation (`runOnce`) + the agent's TurnError
 * taxonomy onto the generic `runWithRetry` policy loop (`../resilience/retry`). runWithRetry
 * owns the governance + retry/backoff/abort policy (domain-free); THIS layer owns only the
 * agent-specific CLASSIFICATION (`classifyTurnError`) and translating the generic
 * `RetryVerdict` back into a `TurnError`. Returns a STRUCTURED result and never throws on a
 * handled class — the caller decides (re-queue / pause-loop / escalate / degrade). A
 * rejected `runOnce` is caught + classified, never propagated.
 */
import { classifyTurnError, isAccountWide, type TurnBackend, type TurnError, type TurnProvider } from './turn-error';
import type { RateLimitGovernor, TokenEstimate } from '../resilience/governor';
import { runWithRetry, type AttemptOutcome, type RetryVerdict } from '../resilience/retry';

/** What one backend invocation returns: success (+headers) or a raw failure to classify. */
export type TurnOutcome<T> =
  | { ok: true; value: T; headers?: Record<string, string | undefined> }
  | { ok: false; raw: Parameters<typeof classifyTurnError>[1] };

export type TurnRunResult<T> = { ok: true; value: T } | { ok: false; error: TurnError };

export interface RunAgentTurnSpec {
  backend: TurnBackend;
  /** Estimated tokens for governor budgeting (in-process callers know these). */
  estTokens?: TokenEstimate;
  /** Max attempts before returning the last error. Default 6. */
  maxAttempts?: number;
  /** Cap on total wait (governor pauses + backoff) across attempts (ms). Default 10 min. */
  maxWaitMs?: number;
  /** Base for exponential backoff on hint-less transient classes (ms). Default 1000. */
  baseBackoffMs?: number;
  /** Abort the turn (interactive callers) — a pending governor wait bails to a TurnError. */
  signal?: AbortSignal;
  /** Existing gateway priority tier, forwarded to the process-local governor. */
  priorityTier?: number;
}

export interface RunAgentTurnDeps<T> {
  governor: RateLimitGovernor;
  runOnce: () => Promise<TurnOutcome<T>>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function providerForBackend(backend: TurnBackend): TurnProvider {
  return backend === 'codex' ? 'openai' : backend === 'omp' ? 'unknown' : 'anthropic';
}

export async function runAgentTurn<T>(spec: RunAgentTurnSpec, deps: RunAgentTurnDeps<T>): Promise<TurnRunResult<T>> {
  const now = deps.now ?? (() => Date.now());
  const r = await runWithRetry<T>(
    {
      estTokens: spec.estTokens,
      maxAttempts: spec.maxAttempts,
      maxWaitMs: spec.maxWaitMs,
      baseBackoffMs: spec.baseBackoffMs,
      signal: spec.signal,
      priorityTier: spec.priorityTier,
    },
    {
      governor: deps.governor,
      now,
      sleep: deps.sleep,
      attempt: async (): Promise<AttemptOutcome<T>> => {
        let outcome: TurnOutcome<T>;
        try {
          outcome = await deps.runOnce();
        } catch (e) {
          // A thrown/rejected runOnce — classify from the message (network blips, …) rather
          // than letting it escape and crash the parent.
          outcome = { ok: false, raw: { message: e instanceof Error ? e.message : String(e) } as never };
        }
        if (outcome.ok) return { ok: true, value: outcome.value, headers: outcome.headers };
        const te = classifyTurnError(spec.backend, outcome.raw, now());
        return {
          ok: false,
          error: {
            retryable: te.retryable,
            // rate_limited/overloaded/usage_limit are account-wide → pause the shared governor.
            accountWide: isAccountWide(te.class),
            retryAfterMs: te.retryAfterMs,
            resetAt: te.resetAt,
            message: te.message,
            detail: te, // carry the full TurnError so the caller recovers the precise class
          },
        };
      },
    },
  );
  if (r.ok) return { ok: true, value: r.value };
  return { ok: false, error: verdictToTurnError(r.error, spec.backend) };
}

/** Recover the agent's TurnError from a generic verdict. The classifier attaches it as
    `detail`; the only verdict WITHOUT one is runWithRetry's own bail (acquire gave up) →
    surface it as a non-retryable rate-limit stop (with the reset, if known). */
function verdictToTurnError(v: RetryVerdict, backend: TurnBackend): TurnError {
  if (v.detail && typeof v.detail === 'object' && 'class' in (v.detail as object)) return v.detail as TurnError;
  return {
    class: 'rate_limited',
    message: v.message ?? 'rate-limited',
    provider: providerForBackend(backend),
    retryable: false,
    ...(v.retryAfterMs !== undefined ? { retryAfterMs: v.retryAfterMs } : {}),
    ...(v.resetAt !== undefined ? { resetAt: v.resetAt } : {}),
    ...(v.admissionDenial ? { admissionDenial: v.admissionDenial } : {}),
  };
}
