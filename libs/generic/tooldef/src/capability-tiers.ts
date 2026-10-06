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

import { pinModuleState } from '@papercusp/module-singleton';
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

/* ─── Late-completion READ classification (WI-10004577) ──────────────────────
 *
 * When a handler finishes AFTER its deadline fired, the dispatcher normally
 * discards the result and reports `timeout` (a possibly-cancelled write must not
 * be reported as a success). That rule has two exemptions: a tool that declares
 * `idempotent: true`, and a tool whose every capability resolves to tier 'low'.
 *
 * Tier is NOT a usable read signal for most read tools: the host tier table
 * falls back to 'medium' for any capability it has no row for, and tier also
 * drives auth exposure and the watchdog timeout — re-tiering a whole capability
 * family (`intel:read`, `operator:read`, … ≈160 tools) to buy this one
 * exemption would change those gates too. So the exemption is its own host
 * seam: the host says which tools are SAFE TO SURFACE LATE, independent of tier.
 *
 * The engine default is `false` for everything (conservative: unchanged
 * behaviour for any host that does not register a classifier).
 */

/** The facts about a tool the classifier may judge on. */
export interface LateCompletionToolFacts {
  /** The name the dispatcher was invoked with. */
  name: string;
  /** Declared capabilities. */
  capabilities: readonly string[];
  /**
   * The tool's declared/inferred effect. NOTE: `effect` is a DEFAULT inference
   * (everything not write-suffixed infers 'read'), never a verification — a host
   * classifier must combine it with an authored signal (the capability, an
   * explicit allowlist), never key a safety exemption on it alone.
   */
  effect?: 'read' | 'write';
}

/** Is a handler result that completed after the deadline safe to surface as a success? */
export type LateCompletionReadClassifier = (tool: LateCompletionToolFacts) => boolean;

/** Engine default: nothing is late-completion-safe (the abort stays authoritative). */
export const defaultLateCompletionReadClassifier: LateCompletionReadClassifier = () => false;

const lateCompletionState = pinModuleState('@papercusp/tooldef.late-completion-read-classifier', () => ({
  classify: defaultLateCompletionReadClassifier as LateCompletionReadClassifier,
}));

/**
 * Register the host's late-completion-read policy. Idempotent; last writer wins.
 * Use `defaultLateCompletionReadClassifier` to reset.
 */
export function setLateCompletionReadClassifier(fn: LateCompletionReadClassifier): void {
  lateCompletionState.classify = fn;
}

/**
 * Ask the active classifier whether a completed-after-abort result for this tool
 * is safe to surface. A throwing classifier fails CLOSED (`false` ⇒ the abort stays
 * authoritative) — a broken policy must never widen the exemption.
 */
export function isLateCompletionSafeRead(tool: LateCompletionToolFacts): boolean {
  try {
    return lateCompletionState.classify(tool) === true;
  } catch {
    return false;
  }
}
