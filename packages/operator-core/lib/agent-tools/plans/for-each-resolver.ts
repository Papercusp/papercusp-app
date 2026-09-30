/**
 * Papercusp adapter for the generic generative `for_each` resolver (P-043 / D-012a).
 *
 * The fan-out algorithm itself — resolve a spec (items/glob/sql) to a deduped,
 * capped item-set; escalate over the cap or on failure — lives in the generic,
 * zero-coupling `@papercusp/fanout-resolver` lib. This adapter maps the
 * promote-policy WAVE shape onto that seam: a wave's resolver is `ForEachResolver`
 * (parsed/validated in `promote-policy`, where the deferred kind is keyed
 * `from_feature`), which this module translates to the generic `FanoutSpec` (where
 * the deferred kind is keyed `deferred`) before resolving. The glob/sql runners
 * are injected by the promote tool (`buildForEachCtx` — fast-glob over the harness
 * repo, a read-only SELECT against the harness PG).
 *
 * NOT YET (surfaced follow-up): the grep/AST resolver; the COMPLETION-TIME
 * resolver expanded when a producing feature publishes its items (see
 * `expand-generators.ts`); and edge-rewriting generated children into a dependent
 * wave's `blocked_by`.
 */
import {
  resolveFanout,
  isFanoutSpec,
  FanoutResolverError,
  type FanoutSpec,
  type ResolveFanoutCtx,
} from '@papercusp/fanout-resolver';
import type { ForEachResolver } from './promote-policy';

/** True when a wave's `for_each` is a system-run resolver (object), not a legacy
 *  named string (resolved by the agent passing `generate_items`). */
export function isForEachResolver(forEach: string | ForEachResolver): forEach is ForEachResolver {
  return isFanoutSpec(forEach);
}

/**
 * True when a `for_each` resolver is COMPLETION-TIME (`from_feature`) — its
 * item-set is published by a producing feature's worker and is NOT known at
 * promote time, so the wave is deferred and expanded when that feature publishes
 * (D-019). The promote-time kinds (items/glob/sql) return false.
 */
export function isCompletionTimeForEach(
  forEach: string | ForEachResolver,
): forEach is { from_feature: string } {
  return isForEachResolver(forEach) && 'from_feature' in forEach;
}

/**
 * True when a `for_each` resolves from a named PLAN INPUT (P-012) — the run-scoped
 * kind, resolved here in the adapter rather than in the generic lib because the
 * generic fan-out resolver has no notion of a plan or its inputs (and should not
 * acquire one: it is the domain-free algorithm).
 */
export function isFromInputForEach(
  forEach: string | ForEachResolver,
): forEach is { from_input: string } {
  return isForEachResolver(forEach) && 'from_input' in forEach;
}

/** Map the papercusp wave resolver (`from_feature`) onto the generic spec (`deferred`).
 *  The promote-time kinds (items/glob/sql) are already the generic shape;
 *  `from_input` is resolved to `items` before it ever reaches here. */
function toFanoutSpec(spec: ForEachResolver): FanoutSpec {
  return 'from_feature' in spec ? { deferred: spec.from_feature } : (spec as FanoutSpec);
}

/**
 * Resolve a `from_input` spec against the run's inputs, into the generic `items`
 * shape. Fail-loud on both bad cases, because a generative wave that silently
 * resolves to zero items is the failure mode D-012a exists to prevent — the wave
 * simply mints nothing and the plan looks like it ran.
 */
function itemsFromInput(field: string, inputs: unknown): { items: string[] } {
  const bag =
    inputs && typeof inputs === 'object' && !Array.isArray(inputs)
      ? (inputs as Record<string, unknown>)
      : {};
  const value = bag[field];
  if (value === undefined) {
    throw new FanoutResolverError(
      `for_each { from_input: "${field}" } — no such input on this run. Declare "${field}" in ` +
        `the plan's input_schema (required, type array) so the start gate cannot let a run ` +
        `reach promote without it.`,
    );
  }
  if (!Array.isArray(value)) {
    throw new FanoutResolverError(
      `for_each { from_input: "${field}" } — input is ${typeof value}, expected an array to fan ` +
        `out over. Give the field "type": "array" in the plan's input_schema.`,
    );
  }
  // Non-string entries are coerced rather than dropped: dropping would silently
  // shrink the fan-out, which is exactly the invisible-partial-expansion failure
  // the cap/escalation machinery is built to make loud.
  return { items: value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v) ?? String(v))) };
}

/**
 * Resolve a generative wave's item-set by running its resolver. Returns the
 * deduped, trimmed, non-empty items. Throws `FanoutCapError` over the cap and
 * `FanoutResolverError` on any resolver failure (including a `from_feature`
 * spec, which is completion-time and not resolvable here) — both signal
 * "escalate", never silent truncation/zero.
 */
export async function resolveForEach(
  spec: ForEachResolver,
  ctx: ResolveFanoutCtx = {},
  /** The run's validated inputs — required only by the `from_input` kind (P-012). */
  inputs?: unknown,
): Promise<string[]> {
  // from_input is resolved to an explicit item-set HERE, then handed to the generic
  // resolver so it still gets the same dedupe / trim / cap / escalate treatment as
  // every other kind. Keeping that shared is the point: a run-scoped fan-out must not
  // become a second code path with its own (weaker) safety rules.
  if ('from_input' in spec) {
    return resolveFanout(itemsFromInput(spec.from_input, inputs), ctx);
  }
  return resolveFanout(toFanoutSpec(spec), ctx);
}
