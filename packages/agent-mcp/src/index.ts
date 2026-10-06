/**
 * @papercusp/agent-mcp public surface.
 *
 * This package provides:
 *   - `defineTool({ ... })` for declaring MCP tools that self-register.
 *   - `dispatch({ toolName, args, bearer })` for in-process callers
 *     (Operator/Oracle) to invoke tools without an MCP transport.
 *   - `startServer()` for stdio MCP transport (out-of-process consumers
 *     like pi sessions).
 *
 * Tools live under `src/tools/<group>/<verb>.ts`. Importing `bootstrap`
 * (or running `startServer`) imports them all and populates the catalog.
 */

// Register Papercusp's capability→tier policy (plan P-012) BEFORE anything
// imports `defineTool` and self-registers — `tier` is stamped eagerly at
// registration. Must stay above `import './bootstrap'` (and is reached first
// by operator tools, which import `defineTool` from this index).
import './capability-tiers-papercusp';
// Entity resolvers (tool-arg-referential-integrity-2026-07-19 P-004): registers the
// existence checks the `entity-check` dispatch step consults for `entityRef` args.
// Same load-time-side-effect contract as the tier resolver above. Inert until an arg
// is actually declared `entityRef(kind)` — registering a resolver is what ACTIVATES
// enforcement for that kind, which is what makes the rollout stageable.
import './entity-resolvers-papercusp';

export { defineTool } from '@papercusp/tooldef';
// tool-arg-referential-integrity P-001: re-exported beside `defineTool` so an arg
// naming a durable entity is declared `entityRef('pot')` right where the tool is
// written, with no extra import path to discover.
export { entityRef, type EntityKind } from '@papercusp/tooldef';
// P-004b: the tools/list overlay that publishes small entity vocabularies as
// enums, plus the revision fingerprint a transport polls to decide whether a
// `notifications/tools/list_changed` is warranted. Re-exported here because the
// HTTP MCP transport imports its whole tooldef surface through this package.
export { applyEntityRefEnums, entityEnumRevision } from '@papercusp/tooldef';
// Payload tiers (context-trimming-tiers-2026-07-01 D-004): the trimmed/standard/full
// axis over WHAT a tool returns. Hosts parse the session tier (parsePayloadTier) into
// ctx.contextTier; tools declare per-tier `shape` projections on defineTool.
export {
  applyPayloadTier,
  extractPayloadTier,
  parsePayloadTier,
  resolvePayloadTier,
  resetPayloadTierRatchet,
  PAYLOAD_TIERS,
  // EI-19447969329510166: a shaper that does not know the transport ceiling has
  // to GUESS its caps, and a guess that is fine for one row blows the ceiling at
  // a hundred — which force-re-applies that same shaper and, on failing to
  // shrink, falls back to the generic projection the shaper existed to avoid.
  // The tier surface was already re-exported here; the one number a shaper must
  // respect to stay on its own path was not.
  PAYLOAD_TIER_HARD_CEILING_CHARS,
} from '@papercusp/tooldef';
export type { PayloadTier, PayloadShapers, PayloadShaperCtx } from '@papercusp/tooldef';
// code-execution-tool-orchestration (B-CX-2A): the code-mode runtime, re-exported so the
// operator-core `code:run` agent tool can compose it.
export { runToolOrchestration } from '@papercusp/tooldef';
export type {
  OrchestrateOptions,
  OrchestrateResult,
  PlannedMutation,
  WrapDispatch,
  DispatchNext,
} from '@papercusp/tooldef';
// The role-scoped allowed-set helper BOTH code:run + code:tools use to build the facade envelope
// (mirrors the dispatcher role-allowlist; the meta-tools exclude themselves so a script can't nest
// code-mode). One definition, unit-tested in tool-facade.test.ts.
export { roleScopedToolNames } from '@papercusp/tooldef';
// code-execution-tool-orchestration B-CX-API: typed `tools.ns.verb(args)` signatures generated
// from the projected registry + the on-demand namespace index — composed by the `code:tools`
// lookup so the model loads signatures on demand instead of paying the full catalog per prompt.
export { generateToolFacadeTypes, listFacadeNamespaces, toolArgsType } from '@papercusp/tooldef';
export type {
  GenerateFacadeTypesOptions,
  FacadeNamespaceIndexEntry,
  ToolArgsType,
} from '@papercusp/tooldef';
// The shared keyed-array bulk I/O contract (bulk-endpoint-standardization D-001).
// Lives here — the lowest package both operator-core tools AND the agent-mcp
// read-side tools (artifacts/features) can import (dep direction is
// operator-core → agent-mcp). operator-core/lib/agent-tools/_bulk.ts re-exports it.
export { scalarOrArray, toList, mergeIds, runBulk, bulkContent } from './_bulk';
export type { BulkItemResult, BulkEnvelope } from './_bulk';
// Papercusp's role config (plan P-010): exporting AGENT_ROLES pulls in
// role-config.ts, whose `declare module` augmentation registers the built-in
// roles with tooldef's `RoleRegistry` — so the re-exported `AgentRole` below
// resolves to Papercusp's suggestion-union program-wide.
export {
  AGENT_ROLES,
  BRAIN_PRINCIPAL_ROLE,
  SU_ROLES,
  SU_WRITE_ROLES,
  OPERATOR_CONFIG_WRITE_ROLES,
  isOperatorConfigWriteRole,
  FROZEN_OVERLAY_ROLES,
} from './role-config';
export type { BuiltinAgentRole } from './role-config';
// hive-agent-tabs-psu-tui P-001: the shared AgentPaneKind taxonomy — one source
// of truth for the backend roster shaping + pui pane render/color.
export { classifyAgentPane, AGENT_PANE_KINDS, DRIVE_MODES } from './agent-pane-kind';
export type { AgentPaneKind, DriveMode, AgentPaneClass, AgentLaunchHint } from './agent-pane-kind';
export type { AgentRole, RoleRegistry } from '@papercusp/tooldef';
export { defineUITool } from './define-ui-tool';
export type { UIToolDefinitionInput, UIToolHandlerResult } from './define-ui-tool';
export { defineResource } from '@papercusp/tooldef';
export { definePrompt } from '@papercusp/tooldef';
export {
  dispatch,
  getPrompt,
  listPrompts,
  listResources,
  readResource,
  startServer,
} from './server';
export { getCatalog, lookup, toArgsJsonSchema } from '@papercusp/tooldef';
export {
  serializeToolResponse,
  formatOptsFromCtx,
  type SerializeFormatOpts,
  type SerializedToolResult,
} from '@papercusp/tooldef';
export {
  applyToolManifest,
  reloadToolManifest,
  hasToolManifest,
} from './tool-manifest';
export {
  getResourceCatalog,
  lookupResource,
  matchResource,
} from '@papercusp/tooldef';
export { getPromptCatalog, lookupPrompt } from '@papercusp/tooldef';
export {
  SLASH_PROMPT_PREFIX,
  resolveSlashExposure,
  slashPromptNameFor,
  isSlashPromptName,
  slashPromptToolName,
  deriveSlashPromptArguments,
  slashPromptListingFor,
  renderSlashPrompt,
} from '@papercusp/tooldef';
export type { SlashPromptListing } from '@papercusp/tooldef';
export { resolveBearer, lookupSystemPrincipalCapabilitiesByRole } from './auth';
export {
  sanitizeToolSchema,
  sanitizeToolSchemaCached,
  resetToolSchemaSanitizeCache,
  TOOL_SCHEMA_SANITIZE_CACHE_MAX_ENTRIES,
} from './tool-schema-sanitize';
export { fuzzyEnum, fuzzyEnumAsync, nearestByLevenshtein, type FuzzyEnumOpts } from './fuzzy-enum';
export {
  onWorkspaceSwitch,
  dispatchWorkspaceSwitch,
} from '@papercusp/tooldef';
export type { WorkspaceSwitchCallback } from '@papercusp/tooldef';
export {
  openRun,
  closeRun,
  setOpenCards,
  setToolState,
  getSnapshot,
  subscribeStateChannel,
  subscribeWorkspace,
  snapshotWorkspace,
  dropStateSnapshotsForWorkspaceSwitch,
} from '@papercusp/tooldef';
export type {
  StateSnapshot,
  VersionedSnapshot,
} from '@papercusp/tooldef';
export { diffSnapshot, applySnapshotDelta, chooseSnapshotEmission } from '@papercusp/tooldef';
export type { SnapshotDelta, SnapshotEmission } from '@papercusp/tooldef';
export { DeltaToolClient, dispatchWithDelta, dispatchWithConveyedDelta } from '@papercusp/tooldef';
export type { DeltaResponse, DeltaIngestResult, DeltaDispatch, DeltaDispatchResult } from '@papercusp/tooldef';
// Result-aware guidance.seeAlso cross-links (presence-coord-unification-2026-07-01
// D-003): the dispatch layer applies these; adopters using the callback form read
// their content-encoded result with readJsonResult.
export { applySeeAlso, resolveSeeAlso, renderSeeAlsoText, readJsonResult } from '@papercusp/tooldef';
export type { SeeAlso, SeeAlsoEntry, SeeAlsoPointer } from '@papercusp/tooldef';
// Base-rate stamping (EI-19375528138828761): a filtered result reports the
// population it was drawn from, so a slice is never read as a census.
export { applyDenominator, resolveDenominator, renderDenominatorText } from '@papercusp/tooldef';
export type { Denominator, DenominatorSpec } from '@papercusp/tooldef';
// Host ambient result-annotator seam (agent-managed-compaction P-013) — the operator
// wires its banded context gauge via context-gauge-wiring.ts, same as delta-flag-wiring.
export { setResultAnnotator, resetResultAnnotator, applyResultAnnotator } from '@papercusp/tooldef';
export type { ResultAnnotator } from '@papercusp/tooldef';
// Host "server vintage" seam (EI-19953470656367880) — appends a build-id + boot-age
// hint to an `Unrecognized key` invalid_args error. The operator wires it to
// build-info.ts + process.uptime() via server-vintage-wiring.ts, same shape as
// context-gauge-wiring.ts.
export {
  setServerVintageResolver,
  resetServerVintageResolver,
  readServerVintage,
  formatVintageAge,
} from '@papercusp/tooldef';
export type { ServerVintage } from '@papercusp/tooldef';
// Host "ambient dispatch arg keys" seam (EI-22174225494240206) — the `Unrecognized
// key` invalid_args hint otherwise omits genuinely-accepted dispatch-level args
// (e.g. `projection`) from its "accepts ONLY" list because they never reach the
// tool's own schema. The operator wires it to result-projection's `PROJECTION_ARG`
// via ambient-args-wiring.ts, same shape as server-vintage-wiring.ts.
export {
  setAmbientArgKeysResolver,
  resetAmbientArgKeysResolver,
  readAmbientArgKeys,
} from '@papercusp/tooldef';
// Tool-result SEMANTIC-delta flag seam (agent-tool-delta-protocol-2026-06-22, the
// flag-bite): tooldef gates the `mode:'delta'` upgrade behind this resolver, the
// host wires it to FLAGS.TOOL_DELTA_PROTOCOL (see operator-core's
// agent-tools/delta-flag-wiring.ts — the resolver needs @papercusp/flags, which
// agent-mcp doesn't depend on, so the wiring lives operator-side).
export {
  setSemanticDeltaEnabledResolver,
  resetSemanticDeltaEnabledResolver,
  isSemanticDeltaEnabled,
} from '@papercusp/tooldef';
export {
  registerCard,
  resolveCardResponse,
  cancelPendingCardsForRun,
  cancelPendingCardsForWorkspaceSwitch,
  _resetCardCorrelatorForTests,
} from '@papercusp/tooldef';
export { _resetStateChannelForTests } from '@papercusp/tooldef';
export { tierFor, setCapabilityTierResolver } from '@papercusp/tooldef';
// Papercusp's capability→tier policy (plan P-012) — the host impl registered
// as tooldef's tier resolver (see capability-tiers-papercusp.ts).
export { papercuspTierFor, papercuspLateCompletionRead, setCapabilityTierOverride, type CapabilityTierOverride } from './capability-tiers-papercusp';

// The goal TRANSITION seam (EI-20013729460455061 stop, WI-37615 resume). operator-core
// installs the executor at module load; without it `goals:update { status:'paused' }` is a
// pure record write — and `status:'active'` leaves placement gated behind an "active" label.
export {
  setGoalTransitionExecutor,
  getGoalTransitionExecutor,
  isStoppingStatus,
  STOPPING_STATUSES,
  isTerminalStatus,
  TERMINAL_STATUSES,
  isResumingStatus,
  isTransitioningStatus,
  isStopReport,
  type GoalTransitionExecutor,
  type GoalTransitionInput,
  type GoalTransitionReport,
  type GoalStopInput,
  type GoalStopReport,
  type GoalResumeReport,
  type StoppingStatus,
} from './tools/goals/stop-seam';

// The goal DELIBERATE-PAUSE record (goal-live-holder-guarantee-2026-08-18 P-005, D-009).
// `status='paused'` says a goal is held; this says WHO held it, WHEN and WHY — the half
// without which a reader cannot tell a deliberate hold from a goal that lost its holder.
// Exported here because the writer is in this package and the readers (the liveness
// watchdog, P-004's derived activity read) are in operator-core, which imports it.
export {
  readGoalPause,
  readGoalLastPause,
  stampGoalPause,
  clearGoalPause,
  isGoalAdministrativelyPaused,
  GOAL_PAUSE_KEY,
  GOAL_LAST_PAUSE_KEY,
  type GoalPauseRecord,
  type GoalLastPauseRecord,
  type GoalPauseView,
} from './tools/goals/pause-record';
export {
  appendGoalHistory,
  addGoalFieldChange,
  GOAL_EVIDENCE_ACTION,
  GOAL_AMENDMENT_ACTION,
  GOAL_WRITE_ACTION,
  GOAL_HISTORY_LIMIT,
  type GoalHistoryDetail,
  type GoalHistoryEntry,
  type GoalWriteDetail,
} from './tools/goals/history';

// Per-spawn URL-param parser — used by both projected-tool transports
// to extract harness/workspace/role/feature/chunk/run/spawn from the
// orchestrator-baked URL.
export {
  parseRequestContext,
  InvalidRequestContextError,
  type PluginRequestContext,
} from './spawn-context';

// Function-as-truth projected tool registry — every tool is a function;
// HTTP and MCP are projections of it. Spec: plugin-mcp-host-design.md.
export {
  registerProjectedTool,
  unregisterProjectedToolsForPlugin,
  lookupByMcpName,
  resolveMcpName,
  resolveMcpNameTagged,
  type McpNameResolution,
  type ResolveMcpNameOptions,
  type ResolvedMcpName,
  normalizeMcpName,
  lookupByHttpPath,
  listAllProjectedTools,
  PROJECTED_TOOL_REGISTRY_SOURCE,
  projectedToolRegistryRevision,
  projectedToolCallContract,
  projectedToolAdmitted,
  assertProjectedToolCallContract,
  renderProjectedToolCall,
  projectedToolCorrectiveCalls,
  assertProjectedToolGuidanceConformance,
  ProjectedToolContractError,
  listMcpProjections,
  ToolRegistrationError,
  emitToSseSink,
  isPapercuspBinaryEnvelope,
  _resetProjectionRegistryForTests,
  type ProjectedTool,
  type ToolFn,
  type ToolExposure,
  type ToolExposureHttp,
  type ToolExposureMcp,
  type ToolExposureSlash,
  type ProjectedToolAvailability,
  type ProjectedToolCallContract,
  type ProjectedToolCorrectiveCall,
  type ValidatedProjectedToolCorrectiveCall,
  type ProjectedToolGuidanceConformance,
  type UnifiedToolContext,
  type RequestOriginMetadata,
  type MinimalEventSink,
  type PapercuspBinaryEnvelope,
} from '@papercusp/tooldef';

export {
  dispatchProjectedTool,
  dispatchProjectedToolStream,
  defaultComputeQuotaWindow,
  UnauthorizedToolError,
  HarnessRequiredError,
  WorkspaceTxNotDeclaredError,
  WorkspaceTxUnavailableError,
  PASS_THROUGH,
  type QuotaWindow,
  type DispatchProjectedDeps,
  type DispatchProjectedResult,
  type DispatchProjectedErrorCode,
  type DispatchStreamEvent,
  type PostInvokeEvent,
  type CapabilityEnvelopeVerdict,
  type ToolDispatchOverrideFn,
} from '@papercusp/tooldef';
export { boundWorkspaceTx, applyWorkspaceTxContract } from '@papercusp/tooldef';
// Declarative preconditions (`requires:` — autoloop-pot-operator-rebuild D-006):
// the preInvoke mirror of `emits:`. The host wires `deps.firePrecondition` to
// its dispatcher (Papercusp's: `lib/events` → fireReactionInProcess).
export type {
  ToolRequireSpec,
  ToolPreInvokeEvent,
  PreconditionFireRequest,
} from '@papercusp/tooldef';
// Papercusp's quota windowing policy (plan P-011) — the host impl of
// tooldef's `computeQuotaWindow` seam. Wired into PROJECTED_DEPS.
export { papercuspComputeQuotaWindow } from './quota-policy';
// Papercusp's auth-tier → gate-bypass mapping (plan P-014) — the host impl of
// tooldef's neutral `ctx.gateBypass`, set by the HTTP + MCP transports.
export {
  papercuspGateBypass,
  testingFullAccess,
  TESTING_FULL_ACCESS_ROLES,
  setTestingFullAccessResolver,
  type TestingFullAccessResolver,
} from './gate-bypass';
export type { GateBypass } from '@papercusp/tooldef';

// identities-v1 / D-030: expose the host-neutral kernel enforcement seam to
// transport and operator adapters without making them depend on the generic
// package's internal source path.
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
} from '@papercusp/tooldef';
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
} from '@papercusp/tooldef';

// Resource authorization (RFC tooldef-auth). The host supplies the decision
// (an `authorize` hook / PolicyDecisionPoint) and wires `deps.auditAuth` to a
// sink — Papercusp's is `apps/operator/lib/tool-authz-audit.ts`.
export { ownerOnly } from '@papercusp/tooldef';
export type {
  AuthzQuery,
  AuthDecision,
  PolicyDecisionPoint,
  AuthAuditEvent,
  Authorizer,
} from '@papercusp/tooldef';

// HTTP transport adapter — extracted to @papercusp/tooldef-http (plan P-030).
// Re-exported here so existing `@papercusp/agent-mcp` consumers are untouched.
export {
  handleHttpToolRequest,
  handleHttpToolRequestStreaming,
  buildHttpSpawnContext,
  PAPERCUSP_CONTEXT_HEADERS,
  type HttpToolRequest,
  type HttpToolResponse,
  type HttpToolResult,
  type HttpToolHostExtras,
  type ToolScope,
  type HttpRequestContextInput,
} from '@papercusp/tooldef-http';
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
  ToolResponse,
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
} from '@papercusp/tooldef';

export {
  readReplayBuffer,
  closeReplayBuffer,
  replayBufferStats,
  type ReplayBufferedEvent,
} from '@papercusp/tooldef';

export {
  validatePluginEventSchema,
  validateAndClassifyPluginEvents,
  classifyEventWireFromJsonSchema,
  PluginEventSchemaError,
  SUPPORTED_KEYWORDS as PLUGIN_EVENT_SUPPORTED_KEYWORDS,
  REJECTED_KEYWORDS as PLUGIN_EVENT_REJECTED_KEYWORDS,
} from './plugin-events';

export {
  toolToOpenApiFragment,
  componentKey,
  standardResponseComponents,
  type OpenApiFragment,
} from '@papercusp/tooldef';
export {
  assembleOpenApiDocument,
  toolOperationName,
  type OpenApiDocumentOptions,
} from '@papercusp/tooldef';

export {
  tokens,
  checksumRows,
  computeListDelta,
  applyListDelta,
  evalSnapshotTransition,
  type Row as DeltaEvalRow,
  type ListDelta,
  type FullReason as DeltaFullEvalReason,
  type DeltaEvalOpts,
  type SnapshotEval,
  type ModeTokens,
} from './delta-eval-harness';

import './bootstrap';
