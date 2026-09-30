/**
 * Server-only entry point. Pull this from API routes / server modules
 * via `@papercusp/papercusp-shared/agent`. Don't import from a client
 * component — this module reaches `node:child_process` and Turbopack
 * will refuse to bundle it for the client. (We don't pull in the
 * `server-only` marker package since it isn't a workspace dep; the
 * sub-export boundary alone keeps it out of the client graph.)
 */
export {
  runAgentChat,
  setAgentConfigBootstrap,
  resolveBackend,
  resolveAgentBin,
  setStatelessUsageSink,
  readClaudeOauthToken,
  readClaudeOauthExpiry,
  invalidateClaudeTokenCache,
  resolveAnthropicBaseUrl,
  probeStatelessTransport,
  type StatelessTransportProbe,
  // P-007 (own-tui-full-divorce-2026-08-24): the agent-loop ModelPort adapter
  // reuses the stateless family's transport resolution, admission-tier headers
  // and OAuth-framed system param instead of duplicating them.
  resolveStatelessTransport,
  type StatelessTransport,
  priorityTierHeaders,
  ownerHeaders,
  headersToRecord,
  routeAccountHeaders,
  ROUTE_ACCOUNT_HEADER,
  buildSystemParam,
  // EI-18685386548651513 / WI-5391 — the delegated-gateway transport choice (EI-12940): a
  // caller with no local Claude OAuth session (every in-process bg-host/Scout ideator call —
  // register-scout-action.ts's FB-16 wiring) egresses via the LOCAL inference gateway's account
  // pool instead of failing. Exported so a cross-package test (operator-core's real
  // createInferenceGateway) can exercise this exact path end-to-end without duplicating its
  // header/token/URL construction — see gateway-scout-delegated-failover.test.ts.
  chooseStatelessTransport,
  resolveDelegatedGatewayUrl,
  GATEWAY_DELEGATED_AUTH_TOKEN,
  // default-deploy-account-2026-08-08 P-008: the marker operator-core publishes so the
  // in-process stateless family routes via the gateway (which starts on the owner's default
  // account) rather than this box's ~/.claude login.
  DEFAULT_ACCOUNT_ACTIVE_ENV,
  defaultAccountActive,
  AGENT_BACKENDS,
  SUBPROCESS_AGENT_BACKENDS,
  CLAUDE_BUILTIN_TOOLS,
  type AgentBackend,
  type ChatEvent,
  type RunAgentChatOptions,
  type StatelessUsageEvent,
  type StatelessUsageAttribution,
} from './chat-stream';

// WI-38316: the Claude OAuth bundle + its refresh exchange. The client id / endpoints live
// here (the leaf) rather than in operator-core's oauth/providers.ts, which now re-exports
// them — the stateless anthropic-direct transport has to refresh the same bundle on an
// upstream rejection, and papercusp-shared cannot import operator-core.
export {
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_OAUTH_DEFAULTS,
  claudeCredentialsPath,
  readClaudeCredentialBundle,
  refreshClaudeOauthCredential,
  describeClaudeAuthFailure,
  type ClaudeCredentialBundle,
  type ClaudeOauthBlock,
  type ClaudeRefreshOutcome,
  type RefreshClaudeOauthOpts,
} from './claude-oauth';

// Agent-turn robustness (RB-*): the turn-error taxonomy + classifier, the backend governor
// registry, and the agent runAgentTurn wrapper — so server modules (e.g. the DBOS
// orchestrator) can pace/classify agent spawns through the shared governor.
export {
  classifyTurnError,
  classifySubprocessResult,
  classifyHttpError,
  isAccountWide,
  parseUsageReset,
  usageRearmCapMs,
  clampUsageRearmDelayMs,
  USAGE_REARM_CAP_MS,
  USAGE_REARM_CAP_HIGH_CONFIDENCE_MS,
  // The Codex model-capacity signature + its fixed retry window. Re-exported so the
  // operator-side death classifiers consume the ONE literal instead of each growing a copy.
  MODEL_CAPACITY_RE,
  MODEL_CAPACITY_RETRY_AFTER_MS,
  type TurnError,
  type TurnBackend,
  type TurnProvider,
  type TurnErrorClass,
  type UsageReset,
  type UsageResetPrecision,
} from './turn-error';
export {
  governorForBackend,
  getGovernor,
  modelClassOf,
  BACKEND_PROFILES,
  resolveLimitModel,
  resolveProviderLimitModel,
  onGovernorPause,
  snapshotGovernors,
  governorKey,
  parseGovernorKey,
  resetGovernorRegistry,
  setGovernorStore,
  setGlobalConcurrencyCap,
  setGlobalConcurrencyFloor,
  setGlobalConcurrencySeed,
  setGlobalGateClock,
  createGlobalConcurrencyGate,
  GLOBAL_CONSTRAINT_TTL_MS,
  setAimdTuning,
  getAimdTuning,
  setProviderFloorOverride,
  getProviderFloorOverrides,
  globalConcurrencySnapshot,
  effectiveConcurrencySnapshot,
  recordGlobalConcurrencyPenalty,
  recordGlobalConcurrencyClean,
  AIMD_CLEAN_TURNS_PER_STEP,
  type BackendProfile,
  type LimitModel,
  type GovernorSnapshot,
  type GovernorPauseListener,
  type GlobalConcurrencyGateController,
  type GlobalConcurrencyGateOptions,
  type GlobalConcurrencySnapshot,
  type EffectiveConcurrencySnapshot,
} from './governor-registry';
export {
  configureAgentSpawnTransform,
  agentSpawnTransformConfigured,
  planAgentSpawn,
  buildLoopbackIdentitySpawn,
  AgentSpawnRefusedError,
  LOOPBACK_IDENTITY_HEADER_VERSION,
  LOOPBACK_IDENTITY_WRAPPER_SOURCE,
} from './spawn-transform';
// D-424: the interactive (PTY) sibling of the loopback identity spawn — plain .mjs so psu imports
// the same implementation (see loopback-identity-tty.mjs).
export {
  AGENT_IDENTITY_SPEC_ENV,
  AGENT_IDENTITY_SPEC_VERSION,
  AgentIdentityTtyRefusedError,
  parseAgentIdentitySpec,
  planAgentIdentityTty,
  stageAgentIdentityTty,
  type AgentIdentitySpec,
  type AgentIdentityTtyExec,
  type AgentIdentityTtyRequest,
} from './loopback-identity-tty.mjs';
export type {
  AgentSpawnRequest,
  AgentSpawnPlan,
  AgentSpawnStagedDir,
  AgentSpawnTransform,
  LoopbackIdentityHomeLink,
  LoopbackIdentitySpawnOptions,
  LoopbackIdentityHeader,
} from './spawn-transform';
export type {
  AdmissionDenial,
  AdmissionDenialReason,
  GovernorPauseEvent,
  GovernorState,
  GovernorStore,
  GovernorLimits,
  GlobalConcurrencyGate,
  GlobalFeedbackEvent,
} from '../resilience/governor';
export { LEGACY_RATE_LIMIT_BLOCKED_REASON } from '../resilience/governor';
export {
  runAgentTurn,
  type TurnOutcome,
  type TurnRunResult,
  type RunAgentTurnSpec,
  type RunAgentTurnDeps,
} from './turn-runner';
// Generic resilience primitives (domain-independent) — re-exported for convenience.
export {
  RateLimitGovernor,
  runWithRetry,
  initGovernorState,
  effectiveRpmFactor,
  effectiveRpm,
  effectivePaceMs,
  PriorityAdmissionQueue,
  QueueFullError,
  priorityFromLabel,
  tierOf,
  tiersOfMap,
  defaultTierCaps,
  shedTierCaps,
  parsePriorityTierMap,
  DEFAULT_GATEWAY_PRIORITY_MAP,
  DEFAULT_TIER,
  AimdConcurrencyController,
} from '../resilience';
export { ROLLING_WINDOW_REPROBE_MAX_MS } from '../resilience/governor';
export type {
  AdmissionSnapshot,
  PriorityAdmissionOptions,
  UnifiedWindowState,
  AimdConcurrencyOptions,
  AimdSnapshot,
  TierAdmissionConfig,
  TierSnapshot,
  PriorityTierMap,
} from '../resilience';
