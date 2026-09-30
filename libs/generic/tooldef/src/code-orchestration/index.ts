/**
 * code-execution-tool-orchestration runtime (B-CX-1A / B-CX-2A).
 *
 * Public surface of the code-mode runtime: build a capability-scoped tool facade, run a
 * model-submitted orchestration script in a vm sandbox returning only its summary, statically
 * parse-check tool references, bind the facade to the real dispatcher, and compose them with the
 * dry-run/confirm gate (`runToolOrchestration`). The `code:run` agent tool is a thin wrapper.
 */
export {
  buildToolFacade,
  facadeToolNames,
  roleScopedToolNames,
  type ToolFacade,
  type FacadeDispatch,
} from './tool-facade';
export {
  runOrchestrationScript,
  DEFAULT_SCRIPT_TIMEOUT_MS,
  type RunScriptResult,
  type RunScriptOptions,
  type OrchestrationInputs,
  type OrchestrationInputValue,
  type FieldMiss,
  type SleepCap,
} from './run-script';
export {
  checkScript,
  ensureParseCheckReady,
  type ParseCheckResult,
  type StaticToolCall,
} from './parse-check';
export {
  realDispatch,
  unwrapToolResult,
  ToolDispatchError,
  isPreExecutionFailure,
} from './dispatch-binding';
export { parseJsonWithTrailer, type JsonWithTrailer } from './json-prefix';
export {
  runToolOrchestration,
  detectStrandedWrites,
  type OrchestrateOptions,
  type OrchestrateResult,
  type OrchestrationCallRecord,
  type DetachedOrchestrationCall,
  type OrchestrationCallDisposition,
  type OrchestrationOutputReference,
  CODE_RUN_REPLAY_PROOF_META_KEY,
  CODE_RUN_REPLAY_PROOF_SCHEMA_VERSION,
  deriveCodeRunSettledReadReplayProof,
  type CodeRunSettledReadReplayProof,
  type DeriveCodeRunSettledReadReplayProofInput,
  type PlannedMutation,
  type WrapDispatch,
  type DispatchNext,
} from './orchestrate';
// P-019 / D-019: per-call checkpointing for explicitly durable orchestration runs.
export {
  createDurableDispatch,
  classifyDurableCall,
  durableRuntimeTools,
  durableAuthorizationDenied,
  DurableRunHaltedError,
  DURABLE_RUNTIME_TOOL_NAMES,
  type DurableDispatchOptions,
  type DurableDispatchState,
  type DurableReplayClass,
  type DurableStepHost,
  type DurableStepSummary,
} from './durable-dispatch';
// B-CX-API: compile-time typed signatures for the facade + the on-demand namespace index.
export {
  generateToolFacadeTypes,
  listFacadeNamespaces,
  toolArgsType,
  type GenerateFacadeTypesOptions,
  type FacadeNamespaceIndexEntry,
  type ToolArgsType,
} from './facade-types';
