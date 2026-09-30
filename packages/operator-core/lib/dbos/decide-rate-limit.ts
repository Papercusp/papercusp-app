/**
 * In-step transient-rate-limit tolerance for the durable pipeline's DECIDE step
 * (cloud-deployment-layer — frame-work-on-frame hardening).
 *
 * The problem this closes: the director's "decide" step (orchestrator-workflow.ts)
 * throws on ANY non-zero invoke exit, and DBOS then retries the step only 3× over
 * ~15s before ERRORing the whole feature pipeline. A TRANSIENT 429 ("Server is
 * temporarily limiting requests … · Rate limited") — which the claude/codex CLIs
 * surface as a non-zero exit with that text on STDOUT — is therefore
 * indistinguishable from a real decision failure: 3 quick retries can't clear a
 * rate-limit blip, so the pipeline ERRORs and stops making progress. That was the
 * dominant failure mode under load (the cloud frame ran during heavy API
 * instability; the dev box still hits these 429s when the fleet is busy).
 *
 * The fix: before letting a failed decide invoke fall through to the throw, classify
 * it (`classifyTurnError`, the same taxonomy the spawn governor uses). If it is a
 * TRANSIENT back-off class (`rate_limited` / `overloaded`), wait — honoring the
 * server's `retry-after`, else exponential backoff — and re-invoke, bounded by a max
 * attempt count AND a cumulative-wait cap. ANY OTHER outcome (a clean success, or a
 * genuine failure: `agent_crash` / `empty_output` / `usage_limit` / `auth` / …)
 * returns IMMEDIATELY so the caller's existing throw→DBOS-retry→ERROR semantics are
 * unchanged. We deliberately do NOT absorb `usage_limit` here (a plan/subscription
 * cap is futile to retry into — it must surface + the fleet park until reset), nor
 * the other "retryable" crash classes (those should fail fast to DBOS's own retry,
 * not sit in a multi-minute in-step wait).
 *
 * Pure + injectable (sleep/clock/run are deps) so it unit-tests with a fake clock
 * and a scripted runner — no real spawns, no real waits.
 */
import { classifyTurnError, type TurnBackend } from '@papercusp/papercusp-shared/agent';

/** The decide invoke's result shape (a superset of `PipelineInvokeRunner`'s return). */
export interface DecideInvokeResult {
  output: string;
  exitCode: number;
  stderr?: string;
  timedOut?: boolean;
  /**
   * TERMINAL (not transient): the harness no longer resolves (`resolveProject`
   * returned null). The pipeline must STOP cleanly rather than retry — see
   * `PipelineInvokeRunner`'s return type. WI-5630.
   */
  unresolvedHarness?: boolean;
}

export interface RateLimitToleranceDeps {
  /** Run one decide invoke (the real runner call, or a test fake). */
  run: () => Promise<DecideInvokeResult>;
  /** Backend the decider CLI uses — only labels the classified error's provider; the
   *  transient-429 detection itself is provider-independent. */
  backend: TurnBackend;
  /** Injected sleep (tests pass a no-op / fake clock). Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected clock for retry-after parsing determinism. Default `Date.now`. */
  now?: () => number;
  /** Optional progress log (the workflow passes a console.warn shim). */
  log?: (m: string) => void;
  /** Max TOTAL invoke attempts including the first (default 6). */
  maxAttempts?: number;
  /** Hard cap on cumulative backoff wait across attempts, ms (default 300_000 = 5 min). */
  maxTotalWaitMs?: number;
  /** Backoff when a 429 carries no `retry-after`, by 0-based wait index.
   *  Default 10s · 2^i capped at 60s. */
  fallbackWaitMs?: (waitIndex: number) => number;
}

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_MAX_TOTAL_WAIT_MS = 300_000;
const defaultFallbackWaitMs = (i: number): number => Math.min(60_000, 10_000 * 2 ** i);
const realSleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/** The transient back-off-and-retry classes — distinct from `isAccountWide`, which also
 *  includes `usage_limit` (a cap we must NOT retry into). */
function isTransientBackoff(cls: string): boolean {
  return cls === 'rate_limited' || cls === 'overloaded';
}

/**
 * Run a decide invoke, absorbing TRANSIENT rate-limit / overload failures in-process.
 * Returns the first successful result, or — when the failure is not a transient
 * back-off class, or the retry budget is exhausted — the last result (so the caller
 * applies its own success/failure check). Never throws on its own.
 */
export async function runWithRateLimitTolerance(deps: RateLimitToleranceDeps): Promise<DecideInvokeResult> {
  const sleep = deps.sleep ?? realSleep;
  const nowFn = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const maxTotalWaitMs = deps.maxTotalWaitMs ?? DEFAULT_MAX_TOTAL_WAIT_MS;
  const fallbackWaitMs = deps.fallbackWaitMs ?? defaultFallbackWaitMs;

  let totalWaited = 0;
  let waitIndex = 0;
  let last: DecideInvokeResult = { output: '', exitCode: 1 };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await deps.run();
    last = r;
    // A clean, non-empty decision — done.
    if (r.exitCode === 0 && r.output.trim()) return r;

    // Classify the failure; only a transient rate/overload is absorbed here. The 429
    // text lands on stdout for the claude/codex CLIs, so pass `output` as `stdout`.
    const te = classifyTurnError(
      deps.backend,
      { exitCode: r.exitCode, stderr: r.stderr, stdout: r.output, timedOut: r.timedOut },
      nowFn(),
    );
    if (!isTransientBackoff(te.class)) return r; // genuine failure / success-but-empty — caller decides.

    if (attempt >= maxAttempts) {
      log(`decide rate-limited (${te.class}) — exhausted ${maxAttempts} attempts; giving up (caller will ERROR)`);
      return r;
    }
    const wait = Math.max(0, te.retryAfterMs ?? fallbackWaitMs(waitIndex++));
    if (totalWaited + wait > maxTotalWaitMs) {
      log(
        `decide rate-limited (${te.class}) — next wait ${wait}ms would exceed the ${maxTotalWaitMs}ms cap ` +
          `(waited ${totalWaited}ms over ${attempt} attempts); giving up (caller will ERROR)`,
      );
      return r;
    }
    totalWaited += wait;
    log(
      `decide rate-limited (${te.class}); waiting ${wait}ms then re-invoking ` +
        `(attempt ${attempt + 1}/${maxAttempts}, cumulative wait ${totalWaited}ms)`,
    );
    await sleep(wait);
  }
  return last;
}
