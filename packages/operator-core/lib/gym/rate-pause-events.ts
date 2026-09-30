/**
 * rate-pause-events — host wiring for the gym's rate-limit pause visibility
 * (await-event-primitive-2026-06-05 P-010, D-006 #1).
 *
 * The gym's `runWithRatePause` stays a bounded in-process pause (its loop is
 * a held workflow, not a resumable agent turn — converting it would be a
 * persistence refactor out of proportion to the win; the inventory's
 * "borderline — migrate only if cheap" logic). What WAS missing is that the
 * pause was invisible and un-awaitable: nothing outside the process could
 * know the gym was rate-parked or be woken at the reset.
 *
 * These hooks emit `rate-limit:paused:<scope>` / `rate-limit:reset:<scope>`
 * through the await-event primitive: anyone (an agent deciding whether to
 * launch gym work, a dashboard, the operator) can `events:await` the reset
 * key — D-006 #1's wake-at-reset — and the pause is on the wake meter. For
 * an agent holding only a `retryAfterMs`, the same wake-at-reset is already
 * expressible with zero extra infra: `events:await { event:
 * 'rate-limit:reset:<scope>', timeout_sec: ceil(retryAfterMs/1000),
 * on_timeout: 'wake' }` — the deadline IS the reset wake, and an earlier
 * reset emit just arrives sooner.
 *
 * Lazy-imports the engine so the pure rate-pause tests never touch PG;
 * fire-and-forget so an emit failure can never break the pause.
 */

import type { RatePauseDeps } from './rate-pause';
import { trackDetached } from '../detached-imports';

export function ratePauseEventHooks(scope: string): Pick<RatePauseDeps, 'onPause' | 'onReset'> {
  const emit = (key: string, summary: string, payload: Record<string, unknown>) => {
    void trackDetached(import('../events/await/engine'))
      .then(({ emitAwaitedEvent }) => emitAwaitedEvent({ key, summary, payload, source: `gym:${scope}` }))
      .catch(() => {
        /* visibility only — never break the pause */
      });
  };
  return {
    onPause: ({ waitMs, attempt }) =>
      emit(`rate-limit:paused:${scope}`, `gym ${scope} rate-paused ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1})`, {
        waitMs,
        attempt,
      }),
    onReset: ({ waitedMs, attempt }) =>
      emit(`rate-limit:reset:${scope}`, `gym ${scope} rate-pause over (waited ${Math.round(waitedMs / 1000)}s)`, {
        waitedMs,
        attempt,
      }),
  };
}
