/**
 * Capability → tier classification (plan P-010 / P-012, D-006).
 *
 * Tiers are host policy, not engine knowledge: a capability string like
 * `secrets:read:*` is "high" only because a particular host says so. The
 * engine therefore ships no table — it exposes a pluggable resolver that
 * `defineTool`/`defineResource`/`definePrompt` consult at registration to
 * stamp each definition's `tier`. The default classifies everything as
 * `'low'`; a host registers its real policy via `setCapabilityTierResolver`
 * before its tools self-register (Papercusp does this in
 * `@papercusp/agent-mcp`'s `capability-tiers-papercusp.ts`).
 *
 * `tier` is descriptive metadata (surfaced in catalogs / prompt assembly);
 * the dispatcher does not gate on it.
 */

import type { CapabilityTier } from './types';

/** Resolve a capability string to its tier. Host-supplied; see file header. */
export type CapabilityTierResolver = (capability: string) => CapabilityTier;

/**
 * The engine default: everything is `'low'`. Generic and conservative — a
 * host that cares about tiers overrides this. (Note: this is *not* Papercusp's
 * policy, which keeps a real table with a `'medium'` fallback; that lives in
 * the host adapter.)
 */
export const defaultTierResolver: CapabilityTierResolver = () => 'low';

let resolver: CapabilityTierResolver = defaultTierResolver;

/**
 * Register the host's capability→tier policy. Call once, before any
 * `defineTool` runs (tools stamp `tier` eagerly at registration). Idempotent;
 * last writer wins. Pass nothing/`null` is not supported — use
 * `defaultTierResolver` to reset.
 */
export function setCapabilityTierResolver(fn: CapabilityTierResolver): void {
  resolver = fn;
}

/** Look up the tier for a capability via the active resolver. */
export function tierFor(capability: string): CapabilityTier {
  return resolver(capability);
}
