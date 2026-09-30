/**
 * `@papercusp/orchestrator/blueprint` — the Harness Blueprint engine.
 *
 * `harness-blueprint-orchestration-2026-06-03` Phase A (keystone). The engine is
 * the declarative orchestration layer: a Blueprint (schema.ts) is interpreted by
 * `deriveNext` (the pure replacement for `classifyDecision`), validated by
 * `validateBlueprint`, and loaded git-canonical → PG by the loader.
 *
 * Lives in this lib (not the operator app) so both the operator AND the
 * `papercusp init` CLI / distribution plan can import it.
 */
export * from './schema.js';
// Declared injection points (portable-identity-packages P-010): the sink/trigger/
// budget vocabulary a provider contribution declares and its compile validation.
export * from './injection-points.js';
// First-party context classes (portable-identity-packages P-005, D-039): the
// platform producers builtin identities name by class@major.
export * from './first-party-classes.js';
// Schema-driven per-harness config read/write/validate keyed by a blueprint's declared
// `params` (psu-isolation-and-blueprint-aware-harness-ui-2026-06-09 P-007).
export {
  getParamPath,
  setParamPath,
  validateParamValue,
  resolveParamViews,
  validateParamPatch,
  applyParamPatch,
} from './params.js';
export type { ParamValidationResult, ParamView, ParamPatchResult } from './params.js';
export type { PipelineAction } from './action.js';
export { deriveNext } from './derive-next.js';
export type { ParsedDecisionLike } from './derive-next.js';
export { validateBlueprint } from './validate.js';
export type { BlueprintIssue, BlueprintValidation, ValidateOptions } from './validate.js';
// Spawn-time childBlueprint binding (D-008 — the gym's `$target` lift) + the
// no-nest guard for privileged kind:'hive' blueprints (local-hive D-009 / swarm
// D-018 enforcement A).
export {
  resolveChildBlueprint,
  isChildBlueprintParam,
  CHILD_BLUEPRINT_PARAM_RE,
  assertNotNestedHive,
} from './resolve-child.js';
// Coord-op-program layer (coordination-ops-as-blueprint-primitives-2026-06-04):
// `{{ path }}` interpolation and the pure program interpreter (planStep /
// selectGateBranch — the program-mode `deriveNext`). These are the generic,
// domain-free step-program core — extracted to the borrowable
// `@papercusp/step-program` lib (generalize-libs-to-generic-2026-06-05 #5) and
// re-exported here. The string-expr DSL (`evalExpr`/`parseExpr`/`isValidExpr`)
// is deliberately NOT re-exported: the canonical condition language on this
// surface is the `@papercusp/rules` `DataCondition` (adopt-event-rules-engines
// D-002) — the spine injects `evaluateDataCondition` as its `WhenEval`; the
// string DSL remains only as step-program's standalone default.
export { readPath, truthy } from '@papercusp/step-program';
export type { Scope } from '@papercusp/step-program';
export { interpolate, interpolateArgs } from '@papercusp/step-program';
export { planStep, selectGateBranch, isProgramSpine } from '@papercusp/step-program';
export type { StepPlan, GateDecision } from '@papercusp/step-program';
export {
  loadBuiltinBlueprint,
  loadBlueprintFromFile,
  resolveBlueprint,
  resolveBlueprintSource,
  resolveExtends,
  resolveLayers,
  layerContentHash,
  mergeRaw,
  blueprintHash,
  builtinBlueprintPath,
  resolveBuiltinExtends,
  layerSourceDocument,
} from './loader.js';
export type { LoadedBlueprint, BlueprintLayer, ResolveExtendsPath, BlueprintValidateRegistry, RawBlueprint } from './loader.js';
// identities-v1 P-038 / D-028: one immutable composition boundary over the
// existing loader, prompt resolver, addressed-document inputs and sealed render.
export {
  COMPOSITION_COMPILER_VERSION,
  COMPOSITION_COMPILER_REVISION,
  CompositionCompilerError,
  compileAgentSpecification,
  compileResolvedAgentSpecification,
  compileResolvedSpecification,
  compileComposition,
  operationFromSpecification,
  pinnedOperationProgramBlueprint,
  pinnedOperationRubricPackage,
  compileReplacementSystemPromptSpecification,
  compileStackSpecification,
  specificationPrompt,
  promptBytesFromSpecification,
  pinPackageInput,
  packageContentHash,
  snapshotPackageDirectory,
  blueprintPackageInputs,
  validateAgentInputClosure,
  validateSpecificationBundles,
  replayAgentSpecification,
} from './composition-compiler.js';
export type {
  CompositionCompilerErrorCode,
  CompositionCompilerInput,
  CompositionPromptInput,
  CompositionPromptFileInput,
  CompositionAddressedDocumentInput,
  CompositionAddressedDocumentSet,
  CompositionSettingInput,
  CompiledAgentSpecification,
  CompositionPackageInput,
} from './composition-compiler.js';
// identities-v1-2026-08-30 P-001: the slot registry (D-007 / D-008 amendments), the
// D-011 bundle kinds, and the MERGE_RULES registry the P-019 merger consumes.
export * from './slots.js';
export {
  MERGE_RULES,
  mergeRuleFor,
  enumerateSchemaLeaves,
  enumerateBlueprintLeaves,
  missingMergeRules,
  danglingMergeRules,
} from './merge-rules.js';
export type { MergeRule, MergeRuleKind, SchemaLeaf } from './merge-rules.js';
// identities-v1-2026-08-30 P-019: the merger that consumes MERGE_RULES (resolveLayers
// composes a stack with mergeByRules; the per-leaf primitives are exported for tests
// and for a renderer that composes a single leaf).
export {
  mergeByRules,
  applyMergeRule,
  MergeConflictError,
  setUnionArrays,
  keyedOverlayArrays,
  intersectConstraint,
  schemaInteriorPaths,
} from './merge.js';
export type { RawDocument, MergeContext } from './merge.js';
// identities-v1-2026-08-30 P-002: the su.md decomposition — anchor tiling into
// kernel / slot / instance parts, the verbatim part documents, the base role
// library disposition, and the interactive su's default stack.
export {
  SU_TILES,
  SU_PART_DOCUMENTS,
  SU_DEFAULT_STACK,
  BASE_ROLE_LIBRARY_DISPOSITION,
  SU_SOURCE_REL,
  SU_PREAMBLE_REL,
  isSuPart,
  suTilingProblems,
  locateSuTiles,
  extractSuPart,
  suPartDocumentDrift,
  suPartDocumentHome,
  suPartDocumentBlueprintId,
  writeSuPartDocuments,
  renderSuDecompositionMarkdown,
} from './su-decomposition.js';
export type {
  SuPart,
  SuTile,
  LocatedSuTile,
  SuPartDocument,
  SuPartDocId,
  FleetPostureRole,
  RoleLibraryRow,
  RoleLibraryDisposition,
  SuStackEntry,
} from './su-decomposition.js';
// identities-v1 P-021 — MODES AS FACETS: the mode-axis identities (one exclusive axis slot per
// mode definition, bound from the registry's active modes) and the `audience` identities
// (the former file-based persona modes), both resolved through the prompt chain.
export {
  SU_MODE_DOCUMENTS,
  AUDIENCE_IDENTITY_DOCUMENTS,
  AUDIENCE_ROLES,
  AUDIENCE_MODES,
  suModeDocument,
  suModeLayer,
  suModeLayers,
  modeCatalogFromValidatedSources,
  isSuModeDocId,
  audienceIdentityId,
  audienceIdentityDocument,
} from './mode-identities.js';
export type {
  SuModeDocument,
  SuModeDocId,
  AudienceIdentityDocument,
  AudienceRole,
  AudienceMode,
  ModeCatalogEntry,
  ModeCatalogSnapshot,
} from './mode-identities.js';
// identities-v1 P-003 — the kernel seal: slot-based prompt assembly (the kernel renders
// LAST under an explicit precedence statement), the composed-stack identity-lint (structural
// BLOCK tier + heuristic WARN tier, D-009 as amended), and the interactive su's composed source.
export {
  composeStack,
  orderStackDocuments,
  renderKernelSeal,
  isIdentityLayer,
  KERNEL_SEAL_MARKER,
  KERNEL_SEAL_HEADING,
} from './render-stack.js';
// identities-v1 P-040 / D-030: revisioned stack activation and explicit
// soft/fresh-context delivery boundaries.
export {
  activationContextForDelivery,
  acknowledgeStackMutationActivation,
  failStackMutationActivation,
  prepareStackMutationActivation,
} from './stack-mutation.js';
export type {
  StackActivationContext,
  StackActivationRevision,
  StackMutationActivation,
} from './stack-mutation.js';
export type { StackDocument, ComposedStack, ComposedStackEntry, ComposeStackOptions } from './render-stack.js';
export {
  lintStackLayers,
  lintStackDocuments,
  detectHeadingOverlap,
  headingLines,
  FORGED_CONTROL_LITERALS,
  MODE_AXIS_ALLOWED_FIELDS,
  KERNEL_CONTRADICTION_PATTERNS,
  GENERATED_MARKER,
  CLIENT_SEAM_MARKER,
} from './identity-lint.js';
export type {
  IdentityLintFinding,
  IdentityLintOptions,
  IdentityLintTier,
  StackLayerInput,
  LayerTrust,
} from './identity-lint.js';
export {
  suStackDocuments,
  composeSuStackSource,
  composeSuStackMutation,
  suBoundLayerDocument,
  suIdentityRoots,
  resolveSuIdentityDocument,
  suEffectiveBinding,
  suPostureBinding,
  suPostureLayer,
  suSessionBinding,
  SU_STATIC_LAYERS,
} from './su-stack.js';
export type { SuIdentityDocumentHit } from './su-stack.js';
export type { SuStackComposeOptions, ComposedSuStack, SuStackDocuments } from './su-stack.js';
// identities-v1 P-012 — the STACK-MUTATION PRIMITIVE: attach / detach a slot layer on a live
// session (exclusive ⇒ swap, additive ⇒ stack), the per-slot delivery rule (inject-now vs
// relaunch-with-carry), the kernel-safe apply (next render composed under the seal BEFORE the
// injection renders), and the `⟦stack⟧`-stamped inject-now payload.
export {
  attachLayer,
  detachLayer,
  applyStackMutation,
  diffStackBindings,
  normalizeStackBinding,
  emptyStackBinding,
  bindingRef,
  bindingRefs,
  parseBindingRef,
  stackBindingFromRefs,
  mutationDelivery,
  renderStackInjection,
  renderStackMutationMarkdown,
  SLOT_MUTATION_DELIVERY,
  STACK_INJECTION_STAMP,
} from './stack-mutation.js';
export type {
  BoundLayer,
  StackBinding,
  StackMutation,
  StackMutationOp,
  MutationDelivery,
  MutationDeliverySpec,
  ApplyStackMutationInput,
  AppliedStackMutation,
} from './stack-mutation.js';
export { layerTrust } from './loader.js';
// Launch-eligibility guard (WI-5645): read a resolved blueprint's inherited
// `retired` marker, and the assert-form for a launch/spend chokepoint.
export {
  blueprintRetirement,
  describeBlueprintRetirement,
  assertBlueprintLaunchEligible,
  BlueprintRetiredError,
} from './retirement.js';
export type { BlueprintRetirementInfo } from './retirement.js';
