/**
 * `@papercusp/blueprint-distribution` — the Harness Blueprint **distribution
 * layer** (`harness-blueprint-distribution-2026-06-03` E1/E2).
 *
 * Built ON TOP of the frozen `@papercusp/orchestrator/blueprint` engine (its
 * public `ResolveExtendsPath` seam + `dependencies.{tools,plugins}` field) —
 * NOT a change to it. Two pure, host-injected concerns:
 *
 *   - **E1a** `makeComposedResolveExtends` — widen `extends` resolution from the
 *     engine's built-in-only default to the three distribution tiers (local →
 *     installed → built-in), passed straight to the loader's `resolve` arg.
 *   - **E2a** `validateBlueprintDependencies` — resolve a blueprint's declared
 *     tool/plugin deps against the host's catalog + installed plugins + Cupboard
 *     listings, failing UPFRONT instead of at call-time `unknown_tool`.
 *
 * Both consumed by the CLI (`papercusp init --from`) and the operator
 * (`harness:create` / blueprint-load).
 */
export {
  makeComposedResolveExtends,
  blueprintFileIn,
  type ComposedResolveOptions,
} from './resolve-extends-composed.ts';
export {
  validateBlueprintDependencies,
  parseDepSpec,
  type BlueprintDependencyInput,
  type DependencyHostSets,
  type BlueprintDependencyValidation,
} from './blueprint-deps.ts';
export {
  buildPackCatalogView,
  resolveToolProvider,
  availableToolNames,
  resolveEventProvider,
  availableEventFamilies,
  type PackDescriptor,
  type PackProviderKind,
  type PackCatalogView,
  type ToolProviderResolution,
  type EventProviderResolution,
  type ProvidedEventFamily,
  type RequiredEventFamily,
} from './pack-model.ts';
export {
  resolveAndValidateBlueprint,
  makeChildBlueprint,
  serializeBlueprint,
  type ResolveResult,
} from './instantiate.ts';
