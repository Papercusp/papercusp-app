/**
 * Rate-limit pause+resume for the battery's unattended LLM calls (factored out of the
 * gym's `rate-pause.ts` into the shared eval-battery engine, reconciliation D-001).
 *
 * The battery (judge, the optimization loop's proposer + evaluator) must NEVER abort on
 * a single rate-limited turn. `runWithRatePause` wraps a call so a `rate_limited`/
 * `overloaded` failure with a NEAR reset is waited out and retried (unattended
 * pause+resume); a far-off reset (past `maxPauseMs`) or a non-rate error is rethrown for
 * the caller to record + skip and continue. Pure: clock + sleep are injected for the
 * fake-clock test.
 */
import { rateLimitInfo } from '@papercusp/testing-shell/llm';

export const BATTERY_MAX_RATE_PAUSE_MS = Number(process.env.BATTERY_MAX_RATE_PAUSE_MS ?? 30 * 60_000);
export const BATTERY_RATE_PAUSE_RETRIES = Number(process.env.BATTERY_RATE_PAUSE_RETRIES ?? 3);

export interface RatePauseDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  maxPauseMs?: number;
  maxRetries?: number;
  /** Fired when a pause begins / ends (await-event-primitive-2026-06-05):
   *  the host wires these to `rate-limit:paused:<scope>` / `rate-limit:reset:<scope>`
   *  emits so the battery's rate state is AWAITABLE (events:await) instead of invisible
   *  inside a 30-min in-process sleep. Optional + fire-and-forget — purity (the
   *  fake-clock test) is preserved when unwired, and a hook failure never breaks the pause. */
  onPause?(info: { waitMs: number; attempt: number }): void;
  onReset?(info: { waitedMs: number; attempt: number }): void;
}

export async function runWithRatePause<T>(fn: () => Promise<T>, deps: RatePauseDeps): Promise<T> {
  const maxPauseMs = deps.maxPauseMs ?? BATTERY_MAX_RATE_PAUSE_MS;
  const maxRetries = deps.maxRetries ?? BATTERY_RATE_PAUSE_RETRIES;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const rl = rateLimitInfo(err);
      if (!rl || attempt >= maxRetries) throw err;
      // Wait out the server's stated reset; bail (rethrow) if it's farther off than we'll wait.
      const waitMs = rl.retryAfterMs ?? (rl.resetAt !== undefined ? rl.resetAt - deps.now() : maxPauseMs);
      if (waitMs > maxPauseMs) throw err;
      try {
        deps.onPause?.({ waitMs, attempt });
      } catch {
        /* visibility must never break the pause */
      }
      await deps.sleep(Math.max(0, waitMs));
      try {
        deps.onReset?.({ waitedMs: waitMs, attempt });
      } catch {
        /* ditto */
      }
    }
  }
}
