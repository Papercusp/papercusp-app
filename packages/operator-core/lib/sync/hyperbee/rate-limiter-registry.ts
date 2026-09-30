/**
 * rate-limiter-registry — process-local accessor for the live EN-2 `MemberRateLimiter`
 * instances boot.ts creates (one per booted harness substrate).
 *
 * THE GAP THIS CLOSES (WI-253 / findings-EN-4.md "EN-1 GUI snapshot surface — fast
 * follow"): `rateLimiter` in boot.ts was a function-local `const` with no exported
 * accessor, so no HTTP endpoint could ever reach it to serve the owner-facing "member X
 * at N/cap" observability panel (EN-1's PotPolicyPanel ⇄ EN-2's `limiter.snapshot()`).
 * This module is a THIN, ADDITIVE accessor only — it changes no enforcement behavior;
 * the merge seam in boot.ts still closes over its own direct reference to the limiter
 * exactly as it did before. Registering it here is a side-effect-free second reference.
 *
 * Process-local by design (same posture as `member-rate-gate.ts`'s module-scope Map):
 * each machine reports the rate state of the harnesses IT has booted. A harness not
 * currently booted on this machine (or never booted here) has no entry — the read
 * accessor returns `undefined`, and callers should treat that as "no live data" (not
 * an error), the same way a cold/idle harness reports nothing to enforce against.
 */
import type { MemberRateLimiter } from './rate-limiter';

const registry = new Map<string, MemberRateLimiter>();

function key(workspaceId: string, harnessSlug: string): string {
  return `${workspaceId}::${harnessSlug}`;
}

/** Called once by boot.ts right after creating a harness's limiter. */
export function registerRateLimiter(workspaceId: string, harnessSlug: string, limiter: MemberRateLimiter): void {
  registry.set(key(workspaceId, harnessSlug), limiter);
}

/** Called by boot.ts's close-hook teardown so a stopped harness's limiter is never
 *  served as if it were still live. Idempotent — a missing key is a no-op. */
export function unregisterRateLimiter(workspaceId: string, harnessSlug: string): void {
  registry.delete(key(workspaceId, harnessSlug));
}

/** Read accessor for the observability endpoint. `undefined` when the harness is not
 *  currently booted on this machine. */
export function getRateLimiter(workspaceId: string, harnessSlug: string): MemberRateLimiter | undefined {
  return registry.get(key(workspaceId, harnessSlug));
}

/** Test/observability aid — how many booted harnesses are currently registered. */
export function rateLimiterRegistrySize(): number {
  return registry.size;
}
