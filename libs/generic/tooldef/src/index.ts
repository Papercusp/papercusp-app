/**
 * @papercusp/tooldef — a function-as-truth tool framework.
 *
 * Write one typed `(input, ctx) => ToolResult` function; the framework
 * projects it onto HTTP, MCP, IPC, and in-process transports with uniform
 * auth/role/quota/telemetry/streaming. Schema-agnostic (Standard Schema is
 * Phase 3), host-agnostic (every side effect is injected via deps).
 *
 * Extraction status — plan
 * `apps/operator/docs/plans/papercusp-tooldef-extraction-2026-05-29.md`.
 * Phase 1 landed the wire types; Phase 2 (this) moves the engine here. The
 * Papercusp host adapter (`@papercusp/agent-mcp`) re-exports this surface and
 * supplies the deps (PG tx, telemetry, role config, HMAC signing, …).
 */

/* ─── Wire + host seams ──────────────────────────────────────────────── */
export type {
  ToolResult,
  RolesQuota,
  ProgressCallback,
  EmitCallback,
} from './wire';
export type { SeeAlso, SeeAlsoEntry, SeeAlsoPointer } from './see-also';
// Compact tool-definition tier (deterministic-tool-definition-delivery-2026-09-21
// P-001): project a schema onto its prose-free form so a tool can be advertised
// at a fraction of the bytes while remaining CALLABLE. $defs/$ref structure is
// preserved, never inlined.
export type { CompactWireBytes } from './compact-schema';
export {
  COMPACT_DROPPED_KEYS,
  compactInputSchema,
  compactWireBytes,
} from './compact-schema';
// Partial-guidance tier (same plan, P-010 / D-006): the PROSE analogue of the
// compact schema projection. COMPACT drops `description` entirely, which on the
// MCP wire is a tool's only prose field; partial keeps the selection signal
// (`when`) plus every hard refusal/safety clause and reduces the rest. Lossy by
// nature and measured rather than asserted — see partialGuidanceLoss.
export type { PartialGuidanceLoss, GuidanceWireBytes } from './partial-guidance';
export {
  GUIDANCE_SECTION_LABELS,
  GUIDANCE_SECTION_SEPARATOR,
  SUMMARY_LEAD_MAX_CHARS,
  isSafetyClause,
  partialGuidanceDescription,
  summaryGuidanceDescription,
  partialGuidanceLoss,
  guidanceWireBytes,
} from './partial-guidance';
// Base-rate stamping (EI-19375528138828761): a filtered result carries the
// population it was drawn from, so a slice is never read as a census.
export type { Denominator, DenominatorSpec } from './denominator';
export {
  applyDenominator,
  resolveDenominator,
  renderDenominatorText,
} from './denominator';
export {
  applySeeAlso,
  resolveSeeAlso,
  renderSeeAlsoText,
  readJsonResult,
} from './see-also';
// Host-registered ambient result annotator (agent-managed-compaction P-013): the seam
// the host wires its banded context gauge into. Default no-op; see result-annotator.ts.
export type { ResultAnnotator } from './result-annotator';
export {
  setResultAnnotator,
  resetResultAnnotator,
  applyResultAnnotator,
} from './result-annotator';
// Host-registered "how stale is this process" resolver, surfaced as an extra
// sentence on an `Unrecognized key` invalid_args error (EI-19953470656367880).
export type { ServerVintage } from './server-vintage';
export {
  setServerVintageResolver,
  resetServerVintageResolver,
  readServerVintage,
  formatVintageAge,
  serverVintageHint,
  constraintVintageHint,
} from './server-vintage';
// Host-registered list of dispatch-level arg keys the transport strips before a
// tool's own schema ever validates (EI-22174225494240206) — folded into
// `unknownArgHint`'s "accepts ONLY" list so a genuinely-accepted key never reads
// as rejected. Default unregistered (empty list); see ambient-args.ts.
export {
  setAmbientArgKeysResolver,
  resetAmbientArgKeysResolver,
  readAmbientArgKeys,
} from './ambient-args';
export type {
  AgentRole,
  RoleRegistry,
  Capability,
  PluginSpawn,
  PluginSpawnOptions,
  PluginSpawnResult,
} from './host-types';

/* ─── Kernel enforcement / identity activation seam (D-030) ──────────── */
export {
  KERNEL_ENFORCEMENT_SCHEMA,
  sameKernelRevision,
  sameExecutionRevision,
  kernelRevisionKey,
  executionRevisionKey,
  normalizeKernelEnforcementResult,
  evaluateKernelEnforcement,
  evaluateKernelDecision,
  isKernelDenied,
  appliedExecutionRevision,
  actualExecutionRevision,
  enforceKernelBoundary,
  runAtKernelBoundary,
  wrapKernelSpawn,
  wrapNativeSpawn,
  createKernelEnforcementPort,
  createKernelPolicyPort,
  allowKernelEnforcement,
  KernelEnforcementDeniedError,
} from './kernel-enforcement';
export type {
  KernelEnforcementPhase,
  KernelBoundary,
  KernelDecision,
  KernelAvailability,
  KernelExecutionRevision,
  KernelActivationRevision,
  KernelOwnershipRequirement,
  KernelActivationSnapshot,
  KernelContextState,
  KernelEnforcementRequest,
  KernelEnforcementResult,
  KernelEnforcementPort,
  KernelPolicyPort,
} from './kernel-enforcement';

/* ─── defineTool + sibling authoring primitives ──────────────────────── */
export {
  defineTool,
  toArgsJsonSchema,
  prepareToolArgsForSchema,
  // The effect oracle — for static scanners that cannot execute defineTool (WI-6464).
  inferCapabilityEffect,
  WRITE_CAPABILITIES,
  WRITE_CAPABILITY_SUFFIXES,
  // P-002: lets a tool's own contract test assert that each authored
  // `argRedirects` target really resolves to a declared key on that tool —
  // the difference between the relocation phrasing and wrongly telling the
  // caller another tool owns their data.
  isLocalSchemaTarget,
  splitLocalSchemaTarget,
} from './define-tool';
// EI-19408488769901676: the HARD ceiling was defined but never re-exported, while its
// softer sibling (the ratchet) was — so a shaper wanting to hit the budget ITSELF, and
// thereby avoid the blind generic fall-through, had no way to reference the number it
// must stay under except by copying it. Export it so that check can be a real assertion.
export {
  applyPayloadTier,
  extractPayloadTier,
  parsePayloadTier,
  resolvePayloadTier,
  resetPayloadTierRatchet,
  projectBoundedPayload,
  PAYLOAD_TIERS,
  PAYLOAD_TIER_RATCHET_CHARS,
  PAYLOAD_TIER_HARD_CEILING_CHARS,
  type PayloadTier,
  type PayloadShapers,
  type PayloadShaperCtx,
  type BoundedPayloadProjection,
  type BoundedPayloadRecovery,
  type BulkEnvelopeProjectionOpts,
  type ProjectBoundedPayloadOpts,
} from './payload-tier';
export { defineResource } from './define-resource';
export { definePrompt } from './define-prompt';

/* ─── Result serialization (token-efficient formats) ─────────────────── */
export {
  serializeToolResponse,
  formatOptsFromCtx,
  type SerializeFormatOpts,
  type SerializedToolResult,
} from './serialize-result';

/* ─── Delta protocol — agent tool result freshness negotiation ───────── */
export {
  parseDeltaRequest,
  formatDeltaRequest,
  encodeDeltaCursor,
  decodeDeltaCursor,
  computeViewFingerprint,
  contentRevision,
  negotiateDelta,
  setSemanticDeltaEnabledResolver,
  resetSemanticDeltaEnabledResolver,
  isSemanticDeltaEnabled,
  computeRowDigest,
  computeRowDigestUncapped,
  computeViewChecksum,
  diffFromDigest,
  applySemanticDelta,
  deltaCounts,
  DELTA_SMALL_RESPONSE_BYTES,
  DELTA_MAX_DIGEST_ENTRIES,
  type DeltaMode,
  type DeltaRequest,
  type DeltaCursorPayload,
  type DeltaCapability,
  type DeltaChange,
  type DeltaNegotiation,
  type NegotiatedDeltaMode,
  type DeltaFullReason,
} from './delta-protocol';

/* ─── Server-held row digests for large views (P-024) ─────────────────── */
export {
  putRowDigest,
  getRowDigest,
  resetRowDigestStore,
  rowDigestStoreStats,
  DIGEST_STORE_MAX_ROWS,
  type RowDigest,
} from './delta-digest-store';

/* ─── Registries ─────────────────────────────────────────────────────── */
export { getCatalog, lookup, _resetCatalogForTests } from './registry';

/* ─── Catalogue summaries (defineGroup + derived capability map) ──────── */
export {
  defineGroup,
  registerGroup,
  lookupGroup,
  getGroupCatalog,
  _resetGroupCatalogForTests,
  type GroupDefinition,
  type GroupDefinitionInput,
} from './define-group';
export {
  groupOf,
  describeGroupFromMembers,
  catalogueProjection,
  renderCapabilityMap,
  declaredGroupSlugs,
  type CatalogueEntry,
  type RenderCapabilityMapOptions,
} from './catalogue-projection';

/* ─── Code-execution tool-orchestration runtime (B-CX-1A / B-CX-2A) ────── */
export * from './code-orchestration';
export {
  collectToolEmits,
  getCollectedToolEmits,
  _resetCollectedToolEmitsForTests,
  type CollectedToolEmits,
} from './emits-registry';
export {
  getResourceCatalog,
  lookupResource,
  matchResource,
  _resetResourceCatalogForTests,
} from './resource-registry';
export {
  getPromptCatalog,
  lookupPrompt,
  _resetPromptCatalogForTests,
} from './prompt-registry';
export {
  SLASH_PROMPT_PREFIX,
  resolveSlashExposure,
  slashPromptNameFor,
  isSlashPromptName,
  slashPromptToolName,
  deriveSlashPromptArguments,
  slashPromptListingFor,
  renderSlashPrompt,
} from './slash-projection';
export type { SlashPromptListing } from './slash-projection';

/* ─── Run / workspace lifecycle ──────────────────────────────────────── */
export {
  onWorkspaceSwitch,
  dispatchWorkspaceSwitch,
} from './workspace-lifecycle';
export type { WorkspaceSwitchCallback } from './workspace-lifecycle';

/* ─── State channel (publishState, snapshots) ────────────────────────── */
export {
  openRun,
  closeRun,
  setOpenCards,
  setToolState,
  getSnapshot,
  subscribe as subscribeStateChannel,
  subscribeWorkspace,
  snapshotWorkspace,
  dropStateSnapshotsForWorkspaceSwitch,
  _resetStateChannelForTests,
} from './state-channel';
export type {
  StateSnapshot,
  VersionedSnapshot,
} from './state-channel';

/* ─── State-channel deltas (agent-tool-delta-protocol P-009) ─────────────── */
export { diffSnapshot, applySnapshotDelta, chooseSnapshotEmission } from './state-delta';
export type { SnapshotDelta, SnapshotEmission } from './state-delta';

/* ─── Tool-result delta CLIENT (agent-tool-delta-protocol follow-up — the missing half) ─── */
export { DeltaToolClient, dispatchWithDelta, dispatchWithConveyedDelta } from './delta-client';
export type { DeltaResponse, DeltaIngestResult, DeltaDispatch, DeltaDispatchResult } from './delta-client';
// Harness-side base-presence tracker (the D-006 "harness owns the base" half — when is not_modified/delta safe) — P-003.
// `dispatchWithBasePresence` is the one-call turn-wrapper integration seam (tracker + client + guarded dispatch).
export { BasePresenceTracker, dispatchWithBasePresence } from './base-presence';
// base-presence's DeltaMode ('full'|'not_modified'|'delta') is a DISTINCT type from
// delta-protocol's ('auto'|'full'|'not_modified') re-exported above — the two collided
// under the bare name (TS2300). Disambiguate the barrel; the source module keeps its own
// `DeltaMode` for internal consumers. (No external caller imports the bare barrel name.)
export type { BasePresenceOptions, DeltaMode as BasePresenceDeltaMode } from './base-presence';
// Server-side rows-array delta negotiation (the sync-resolver/SSE sibling of negotiateToolDelta) — P-006.
export { negotiateRowsDelta } from './rows-delta';
export type { RowsDeltaResult } from './rows-delta';

/* ─── Card correlator (ctx.askUser) ──────────────────────────────────── */
export {
  registerCard,
  resolveCardResponse,
  cancelPendingCardsForRun,
  cancelPendingCardsForWorkspaceSwitch,
  _resetCardCorrelatorForTests,
} from './card-correlator';

/* ─── Capability tiers ───────────────────────────────────────────────── */
export {
  tierFor,
  setCapabilityTierResolver,
  defaultTierResolver,
  type CapabilityTierResolver,
  setLateCompletionReadClassifier,
  defaultLateCompletionReadClassifier,
  isLateCompletionSafeRead,
  type LateCompletionReadClassifier,
  type LateCompletionToolFacts,
} from './capability-tiers';

/* ─── Entity-reference args (referential integrity at dispatch) ───────── */
export {
  entityRef,
  entityRefMeta,
  collectEntityRefs,
  setEntityResolver,
  clearEntityResolvers,
  hasEntityResolver,
  resolveEntityRefs,
  formatEntityRefViolations,
  setEntityEnum,
  clearEntityEnums,
  applyEntityRefEnums,
  entityEnumRevision,
  DEFAULT_MAX_ENUM_VALUES,
  type EntityKind,
  type EntityRefMeta,
  type EntityRefSite,
  type EntityResolver,
  type EntityRefViolation,
  type EntityEnumerator,
  type EntityEnumOptions,
} from './entity-ref';

/* ─── Schema → JSON-Schema adapter (pluggable; default Zod) ───────────── */
export {
  toJsonSchema,
  setJsonSchemaAdapter,
  zodJsonSchemaAdapter,
  type JsonSchemaAdapter,
} from './schema-adapter';

/* ─── Standard Schema validation (validator-agnostic) ────────────────── */
export {
  standardValidate,
  validateSync,
  formatIssues,
  type StandardSchemaV1,
  type ValidationResult,
} from './standard-schema';

/* ─── Projected-tool registry (the function-as-truth core) ───────────── */
export {
  registerProjectedTool,
  unregisterProjectedToolsForPlugin,
  toolDeclaresGate,
  listUngatedProjectedTools,
  lookupByMcpName,
  resolveMcpName,
  resolveMcpNameTagged,
  type McpNameResolution,
  type ResolveMcpNameOptions,
  type ResolvedMcpName,
  normalizeMcpName,
  lookupByHttpPath,
  listAllProjectedTools,
  projectedToolSourceFile,
  projectedToolBundledDefinitionSite,
  listDeclaredToolShapers,
  recordToolShapers,
  PROJECTED_TOOL_REGISTRY_SOURCE,
  projectedToolRegistryRevision,
  projectedToolCallContract,
  projectedToolAdmitted,
  assertProjectedToolCallContract,
  renderProjectedToolCall,
  projectedToolCorrectiveCalls,
  isProjectedToolDrop,
  assertProjectedToolGuidanceConformance,
  ProjectedToolContractError,
  listMcpProjections,
  mcpObjectOutputSchema,
  ToolRegistrationError,
  emitToSseSink,
  isPapercuspBinaryEnvelope,
  _resetProjectionRegistryForTests,
  type ProjectedTool,
  type AbortCompletionReceipt,
  type AbortCompletionContext,
  type AbortCompletionReceiptResolver,
  type ToolFn,
  type ToolExposure,
  type ToolExposureHttp,
  type ToolExposureMcp,
  type ToolExposureSlash,
  type ProjectedToolAvailability,
  type ProjectedToolCallContract,
  type ProjectedToolArgRedirect,
  type ProjectedToolCorrectiveCall,
  type ProjectedToolDrop,
  type ValidatedProjectedToolCorrectiveCall,
  type ProjectedToolGuidanceConformance,
  type UnifiedToolContext,
  type GateBypass,
  type RequestOriginMetadata,
  type MinimalEventSink,
  type PapercuspBinaryEnvelope,
  type EventWireKind,
  // WI-37843: the host reads this to decide whether prose may be appended to a
  // door-exempt result, so it has to cross the package boundary.
  type ResultDoorSkipReason,
} from './tool-projection';

/* ─── Dispatcher ─────────────────────────────────────────────────────── */
export {
  dispatchProjectedTool,
  dispatchProjectedToolStream,
  defaultComputeQuotaWindow,
  UnauthorizedToolError,
  HarnessRequiredError,
  WorkspaceTxNotDeclaredError,
  WorkspaceTxUnavailableError,
  InvalidInputError,
  PASS_THROUGH,
  type QuotaWindow,
  type DispatchProjectedDeps,
  type DispatchProjectedResult,
  type DispatchProjectedErrorCode,
  type InvalidInputCorrection,
  type InvalidInputMetadata,
  type DispatchStreamEvent,
  type PostInvokeEvent,
  type CapabilityEnvelopeVerdict,
  type ToolDispatchOverrideFn,
} from './dispatch-projected';
// The canonical named stack is also used for no-handler authorization probes.
export { DEFAULT_DISPATCH_STACK, runDispatchStack, preflightDispatchStack, withReplacedStep } from './dispatch-stack';

/**
 * P-015 — the shared refusal helper. Exported so a host can render or act on the corrected
 * call itself; every tool defined through this library already inherits it in the refusal
 * message with no per-verb wiring, which is the property the item asked for.
 */
export {
  buildCorrectedCall,
  correctedCallHint,
  type CorrectedCall,
  type CorrectedCallStep,
} from './corrected-call';

/**
 * P-016 — the EXECUTE half of D-104. A tool declares `argReencodings` and the dispatcher
 * repairs-and-RUNS those calls, disclosing each correction. Exported so a host can author
 * a rule beside the schema it repairs; see `reencode-args.ts` for the boundary that keeps
 * this narrower than the refusal helper above.
 */
export {
  applyArgReencodings,
  correctedDisclosure,
  boundValue,
  type ArgReencoding,
  type ArgReencodingOutcome,
  type AppliedArgCorrection,
} from './reencode-args';

/** Explicit workspace-transaction contract helpers for host/nested adapters. */
export { boundWorkspaceTx, applyWorkspaceTxContract } from './workspace-tx';

/* ─── Resource authorization (RFC tooldef-auth-rfc Phase 1 — contract only) ─── */
export { ownerOnly } from './authz';
export type {
  AuthzQuery,
  AuthDecision,
  PolicyDecisionPoint,
  AuthAuditEvent,
  Authorizer,
} from './authz';

/* ─── Core types ─────────────────────────────────────────────────────── */
export type {
  Principal,
  PrincipalKind,
  PrincipalAuthMethod,
  PrincipalTrust,
  PrincipalRequirements,
  RouteAuth,
  RouteMethod,
  RouteContext,
  RouteDefinition,
  CapabilityTier,
  ToolContext,
  ToolDefinition,
  ToolDefinitionInput,
  ToolGuidance,
  ToolGuidanceCorrectiveCall,
  ToolGuidanceDrop,
  ToolEmitSpec,
  ToolEventLike,
  ToolResponse,
  UIResourceContent,
  ResourceContext,
  ResourceContents,
  ResourceDefinition,
  ResourceListEntry,
  PromptContext,
  PromptDefinition,
  PromptMessage,
  PromptResult,
  CardSpec,
  CardResponse,
  CardPresentation,
  CardOption,
  OpenCardSnapshot,
} from './types';

/* ─── Declarative preconditions (`requires:` — D-006) ────────────────── */
export type {
  ToolRequireSpec,
  ToolPreInvokeEvent,
  PreconditionFireRequest,
} from './requires';

/* ─── Replay buffer ──────────────────────────────────────────────────── */
export {
  readBuffer as readReplayBuffer,
  closeBuffer as closeReplayBuffer,
  replayBufferStats,
  type BufferedEvent as ReplayBufferedEvent,
  type ReplayBufferWriter,
} from './replay-buffer';

/* ─── OpenAPI assembly ───────────────────────────────────────────────── */
export {
  toolToOpenApiFragment,
  componentKey,
  standardResponseComponents,
  type OpenApiFragment,
} from './openapi-fragments';
export {
  assembleOpenApiDocument,
  toolOperationName,
  type OpenApiDocumentOptions,
} from './openapi-assemble';

/* ─── Bundled definition sites (P-002 / EI-25176539351759672) ─────────── */
export {
  indexBundleModuleMarkers,
  bundleModuleAtLine,
  definingModuleOfBundledSite,
  type BundledDefinitionSite,
  type BundleModuleMarkers,
  type BundledDefiningModule,
} from './bundle-definition-site';
