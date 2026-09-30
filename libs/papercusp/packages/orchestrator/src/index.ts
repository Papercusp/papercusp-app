/**
 * @papercusp/orchestrator — TypeScript port of the harness orchestrator
 * (`run.sh`). Drops the bash prereq for Windows users while keeping the
 * agent CLI shell-out (`omp -p` default via Meridian, `claude -p` opt-in)
 * so Claude Max subscriptions continue to work without API keys.
 *
 * Status: STAGE 0 — skeleton + read-only utilities only. The actual
 * iteration loop still goes through bash run.sh until later stages port
 * `invoke()`, the main while loop, and worktree/branch isolation.
 *
 * Feature flag (set by Tauri's main.rs spawn for the desktop bundle):
 *
 *   PAPERCUSP_USE_TS_ORCHESTRATOR=1
 *
 * When unset / != 1, the bin/run.ts entry point exec's bash run.sh instead.
 */
export { configGet, resolvePhase } from './config';
export {
  readEffectiveConfig,
  readInstanceConfig,
  loadHarnessKnobs,
  blueprintKnobsToConfigOverlay,
  deepMergeConfig,
} from './effective-config';
export {
  readFeatures,
  featuresExist,
  featureAttempts,
  setFeatureStatus,
  harnessSlug,
  passedFraction,
} from './state';
export { createLogger } from './log';
export { resolvePaths, resolveEnv, resolveAgentCmd, resolveAgentBackend } from './env';
export { AGENT_BACKENDS } from './types';
export {
  MANAGED_CAPABILITY_CONTRACT_VERSION,
  MANAGED_CAPABILITY_FAMILY_IDS,
  MANAGED_CAPABILITY_DISPOSITIONS,
  MANAGED_CAPABILITY_CUTOVER_READY,
  managedCapabilityContractViolations,
  managedCapabilityDisposition,
} from './managed-capability-contract';
export type {
  ManagedCapabilityFamilyId,
  ManagedCapabilityDispositionKind,
  ManagedCapabilityGapKind,
  ManagedCapabilitySourceCitation,
  ManagedCapabilityGap,
  ManagedCapabilityDisposition,
  ManagedCapabilityContractCandidate,
} from './managed-capability-contract';
export { allHarnessProfiles, harnessProfile, harnessSupports } from './harness-profile';
export type {
  HarnessAdapterProfile,
  HarnessCapability,
  HarnessProvider,
} from './harness-profile';
// worker-chunk-loop-operator-hosted-2026-06-14 (D-005): additive exports so the
// operator-hosted `worker:chunk-loop` op (a near-PORT) reuses the SHIPPED worker
// loop + its chunk file-claim coordinator instead of re-porting them.
// The operator-hosted runner is a live consumer, so keep the loop entry point on
// the public barrel until that op is retired as well. Removing only this export
// leaves the source file present but makes the operator bundle fail at link time.
export { runWorkerChunkLoop } from './run-worker-chunk-loop';
export { FileLockQueueCoordinator } from './file-lock-queue-coordinator';
export type { ChunkLoopOutcome, ChunkLoopFeature, ChunkLoopDeps } from './worker-chunk-loop';
// P-020 monitoring metrics: per-run outcome persistence + the completion-rate /
// outcome-distribution-by-path aggregation the dark-launch parity diff + ramp gate read.
export {
  outcomeToRecord,
  recordWorkerChunkOutcome,
  readWorkerChunkOutcomes,
  summarizeWorkerChunkOutcomes,
} from './worker-chunk-outcome-pg';
export type {
  WorkerExecutionPath,
  ChunkLoopOutcomeRecord,
  WorkerChunkOutcomeCtx,
  WorkerChunkPathMetrics,
  WorkerChunkMetrics,
} from './worker-chunk-outcome-pg';
// P-021 deterministic ramp-gate: the pure advance/hold/rollback recommender over P-020 metrics.
export { decideRampAdvance, DEFAULT_RAMP_THRESHOLDS, RAMP_STEPS } from './worker-chunk-ramp';
export type { RampStep, RampThresholds, RampDecision } from './worker-chunk-ramp';
export { readFeaturesPg, durableOwnedFeatureIdsPg } from './state-pg';
export type { PgStateContext } from './state-pg';
// G2 Auditor dispatch lane (P-007): screen remote-pending features through the
// auditor role before the pick loop can consider them.
export {
  selectRemotePendingFeatures,
  applyAuditVerdict,
  parseAuditorOutput,
  dispatchAuditorLane,
} from './auditor-dispatch';
export type {
  RemotePendingFeature,
  AuditVerdict,
  AuditorSpawnFn,
  CreateEscalationFn,
  AuditorDispatchCtx,
} from './auditor-dispatch';
// Debug-note capture/materialize — the durable pipeline's debugger-before-worker
// gate (operator P-012) reuses these instead of duplicating the PG SQL.
export { captureDebuggerOutput, materializeFeatureDebugNote } from './feature-debug-notes';
export type { DebugNoteContext } from './feature-debug-notes';
export type { AgentBackend } from './types';
export { promptCandidates, resolvePromptFile, resolvePromptFiles } from './prompt-resolve';
export type { PromptResolveContext } from './prompt-resolve';
export { extractFeatureId, makeRunId } from './run-id';
export { buildPrompt } from './prompt-build';
export type { BuildPromptInput } from './prompt-build';
export { assembleRolePrompt, lookupProjectDir } from './role-prompt-from-slug';
export type {
  AssembleRolePromptOptions,
  AssembledPrompt,
  RolePromptMode,
} from './role-prompt-from-slug';
export {
  invoke,
  splitCommand,
  extractResult,
  resolvePromptOverride,
  resolvePromptOverrideWithStore,
  resolveTimeout,
  resolveModel,
  scopeSpawnEnvForRole,
  SEARCH_PROVIDER_ENV_KEYS,
  // EI-16502: the outer-process activity-heartbeat marker echoed to stderr —
  // invoke-outcome.ts strips it before judging/persisting a no-turn death so
  // the heartbeat noise can't mask a real diagnostic or defeat the
  // capacity_shed `stderr === ''` fingerprint.
  OUTER_ACTIVITY_ECHO_MARKER,
  // B-18 fleet cutover (agent-capability-confinement P-020): the capability-only
  // allow/deny derivation + the role set that must stay in lockstep with the
  // capability tools' agentRoles (pinned by capability/cutover-role-parity.test.ts).
  fleetAllowedToolsForRole,
  fleetDisallowedToolsForRole,
  fleetCapabilityOnlyEnabled,
  FLEET_CAPABILITY_REPLACED_TOOLS,
  FLEET_CAPABILITY_ROLES,
  // The fleet-sandbox credential deny-read list — the canonical credential dirs;
  // the capability-exec sandbox (P-022) masks the same set (parity-tested).
  FLEET_SANDBOX_DENY_READ,
  // srt (@anthropic-ai/sandbox-runtime) — the egress-capable sandbox wrapper the
  // capability-exec sandbox reuses for domain-allowlist egress parity (P-033).
  srtBinOnPath,
  buildFleetSrtSettings,
  wrapSpawnWithSrt,
  // Small-context core tool spine (tool-discovery-for-weak-models WS1) — the
  // always-loaded catalog operator-core launch code filters the trimmed (~50k)
  // context variants down to. Exported here so the launch/route layer can import
  // it without reaching into the invoke.ts module path directly.
  CORE_MCP_TOOL_NAMES,
  CORE_ALLOWED_TOOLS,
  // Repairs the fleet sandbox's 0-byte package.json mask artifact. Exported so the
  // OPERATOR spawn path (operator-core's spawnInvokeOnceWithFallback) can heal too:
  // invoke.ts heals its own spawns, but a cup placed through operator-spawn.ts never
  // reached that call, so the first sandboxed agent in a fresh app dir bricked every
  // later one with ERR_INVALID_PACKAGE_CONFIG (measured 2026-08-09, P-010 canary).
  healSandboxZeroByteManifest,
} from './invoke';
export type {
  InvokeContext,
  OrchestratorPg,
  OwnedLoopInvokePort,
  OwnedLoopInvokeRequest,
  OwnedLoopInvokeOutcome,
} from './invoke';
export { parseDecision, parseDecisionFor, DECISION_VERBS } from './decision-parse';
export type { DecisionVerb, ParsedDecision, ParsedSpineDecision } from './decision-parse';
// Harness Blueprint engine (harness-blueprint-orchestration-2026-06-03 Phase A).
// Re-exported here for convenience; the subpath `@papercusp/orchestrator/blueprint`
// is the canonical import for blueprint-only consumers (the init CLI, the loader).
export * from './blueprint/index.js';
export { runHook } from './hooks';
export type { RunHookOptions, RunHookResult } from './hooks';
export { checkFleetSandboxHostDeps } from './sandbox-deps';
export type {
  SandboxDepCheck,
  SandboxDepsReport,
  SandboxDepProbes,
  SandboxDepOptions,
} from './sandbox-deps';
export { evaluateCostCap, extractRunUsage, sumJsonlCost } from './cost-cap';
export type { CostCapResult, RunUsage } from './cost-cap';
export { postCuratorOutputs, postArchiveEvent } from './bus-posts';
export { ROLE_MODEL_DEFAULTS, roleModelDefault } from './role-models';
// (plugin-hooks.ts — the per-plugin shell-out via the papercusp-fire-hook CLI —
// was RETIRED by plugin-system-hive-port-2026-06-11 P-006: its one caller, the
// DBOS finalizer's afterDone, now fires the in-process typed hook plus the
// `pipeline:done` event emission. See that plan's D-003.)
export {
  buildCompetitionManifest,
  competitionManifestPath,
  createLanePool,
  maxFeaturesInFlight,
  parallelMaxWorkers,
  readCompetitionManifest,
  resolveWorkerCount,
  writeCompetitionManifest,
} from './lanes';
export type {
  CompetitionLane,
  CompetitionManifest,
  LanePool,
  LaneRecord,
} from './lanes';
export type {
  HarnessPhase,
  HarnessKind,
  HarnessConfig,
  PhaseConfig,
  FeatureRecord,
  FeaturesJson,
  OrchestratorEnv,
  OrchestratorDecision,
  InvokeResult,
} from './types';
