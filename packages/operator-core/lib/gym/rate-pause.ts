/**
 * Rate-limit pause+resume moved into the shared eval-battery engine (reconciliation
 * D-001). This thin re-export keeps the gym's modules + the (still-live) apiary
 * importing `../gym/rate-pause` working byte-identically; the canonical home is
 * `@papercusp/eval-battery`. The `GYM_*` constant names are re-exported as aliases of
 * the engine's `BATTERY_*` constants.
 */
export {
  runWithRatePause,
  type RatePauseDeps,
  BATTERY_MAX_RATE_PAUSE_MS as GYM_MAX_RATE_PAUSE_MS,
  BATTERY_RATE_PAUSE_RETRIES as GYM_RATE_PAUSE_RETRIES,
} from '@papercusp/eval-battery';
