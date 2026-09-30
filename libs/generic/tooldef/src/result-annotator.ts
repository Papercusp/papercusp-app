/**
 * result-annotator — a host-registered, result-time envelope annotator.
 *
 * The generic complement to {@link applySeeAlso}. Where `seeAlso` renders a tool's OWN
 * declared cross-links, this is a single HOST-level hook that runs on EVERY settled tool
 * result: the host inspects `(result, ctx)` and MAY append an ambient line (e.g.
 * Papercusp's banded context-usage gauge — agent-managed-compaction P-013) without any
 * tool declaring it. The library owns the SEAM (invoke-step call + fail-safety); the host
 * owns the POLICY (what, if anything, to append) — the same "declare the port here, wire
 * the impl host-side" model as `setSemanticDeltaEnabledResolver` /
 * `setCapabilityTierResolver`.
 *
 * Default is the identity (no annotator registered ⇒ zero-cost no-op), so every existing
 * consumer/test is behavior-neutral. The annotator MUST be cheap + synchronous (it runs
 * inline on the dispatch hot path); a host that needs I/O caches it out-of-band and the
 * annotator only reads the cache.
 */
import type { ToolResult } from './wire';

/**
 * A host annotator: given a settled result + the call ctx, return the (possibly
 * annotated) result. Return the input unchanged to append nothing. `ctx` is loosely
 * typed (`unknown`) to keep this leaf module free of host coupling — the host narrows.
 */
export type ResultAnnotator = (result: ToolResult, ctx: unknown) => ToolResult;

let annotator: ResultAnnotator | null = null;

/** Register the host result annotator (last registration wins). */
export function setResultAnnotator(fn: ResultAnnotator | null): void {
  annotator = fn;
}

/** Clear the registered annotator — test seam + host teardown. */
export function resetResultAnnotator(): void {
  annotator = null;
}

/**
 * Apply the registered annotator to a result. NO annotator ⇒ the result is returned
 * unchanged. A soft error result is passed through untouched (ambient lines never ride a
 * failed call). NEVER throws — a broken annotator must not fail the underlying tool call,
 * so a thrown annotator error is swallowed and the original result returned.
 */
export function applyResultAnnotator(result: ToolResult, ctx: unknown): ToolResult {
  if (!annotator || result.isError) return result;
  try {
    return annotator(result, ctx);
  } catch {
    return result;
  }
}
