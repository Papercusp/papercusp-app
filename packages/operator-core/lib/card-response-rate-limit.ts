/**
 * Rate-limit state for /api/operator/conversations/:id/card-response.
 *
 * Sliding window per identity key. We bucket on session userId rather
 * than caller-supplied workspaceId (audit: a malicious caller could
 * vary workspaceId per request to bypass the limit).
 *
 * Lives in its own module so the Next.js route file only exports HTTP
 * methods + the `dynamic`/`runtime` config exports — Next warns on
 * extra exports from route files.
 */
import { pinModuleState } from '@papercusp/module-singleton';

const RATE_WINDOW_MS = 1000;
const RATE_LIMIT = 30;

interface RateBucket {
  /** Wall-clock ms timestamps within the window. */
  ts: number[];
}

// Pinned through @papercusp/module-singleton rather than a hand-rolled
// `globalThis[Symbol.for(...)]` pair. Hand-rolling still shares the state
// correctly, but the key is invisible to listModuleDuplications(), which then
// answers a confident `[]` while this module is split (EI-19479108855357092).
// The key string is unchanged, so a duplicate record loaded through a different
// seam still lands on the same bucket map.
const __rateState = pinModuleState<{ buckets: Map<string /* userId */, RateBucket> }>(
  'papercusp.cardResponseRateLimiter',
  () => ({ buckets: new Map() }),
);

function buckets(): Map<string, RateBucket> {
  return __rateState.buckets;
}

/** Returns true when the request should proceed; false when 429. */
export function cardResponseRateAllow(identityKey: string): boolean {
  const now = Date.now();
  const m = buckets();
  let b = m.get(identityKey);
  if (!b) {
    b = { ts: [] };
    m.set(identityKey, b);
  }
  while (b.ts.length > 0 && now - b.ts[0] > RATE_WINDOW_MS) {
    b.ts.shift();
  }
  if (b.ts.length >= RATE_LIMIT) return false;
  b.ts.push(now);
  return true;
}

/** Test-only: clear all buckets. */
export function _resetCardResponseRateLimitForTests(): void {
  buckets().clear();
}

export const CARD_RESPONSE_RATE_LIMIT = RATE_LIMIT;
export const CARD_RESPONSE_RATE_WINDOW_MS = RATE_WINDOW_MS;
