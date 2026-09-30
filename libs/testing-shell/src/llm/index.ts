/**
 * @papercusp/testing-shell/llm — generic LLM-testing framework (Phase 7,
 * P-070 + P-071).
 *
 * The host-agnostic conversational LLM-testing framework: a SimUser drives a
 * multi-turn chat against an injected ChatTarget (the SUT), a Judge scores the
 * transcript against a rubric, and deterministic asserts run alongside. Every
 * host-specific capability — the LLM transport, the target registry, telemetry
 * pulls, the run-report store, the parallel-runner claim ledger — is injected
 * via `RunnerDeps` (see ./deps). This lib imports nothing host-coupled (no
 * operator, no @papercusp/papercusp-shared, no Postgres, no @/lib/*).
 */

// Core type graph (ChatTarget / ChatSession / Scenario / RunSummary / rubric / …).
export * from './types';

// Injected seams (LlmCallFn / RunnerDeps / TelemetryProvider / LlmTestStore / ClaimStore / …).
export * from './deps';

// Runner orchestrator.
export {
  runScenario,
  inconclusiveReason,
  computeRunStatus,
  type RunReport,
  type SingleRunReport,
  type RunnerOpts,
} from './runner';

// Judge.
export {
  judgeRun,
  buildInconclusiveJudge,
  // Derived identity of the judge prompt's STATIC scaffolding (WI-41675 / D-012).
  // Any consumer that persists or compares judged output must fold this into its
  // own rubric/cache version, or an edit to the rules or output schema here
  // silently leaves paid grades keyed to a prompt that no longer exists.
  JUDGE_PROMPT_SCAFFOLD_VERSION,
  composeJudgeScaffoldProbe,
  type JudgeOpts,
  type JudgePromptRunFields,
} from './judge';

// Sim-user.
export {
  SimUser,
  simActionToTurnContext,
  type SimUserOpts,
  type SimNextInput,
  type SimAction,
  type SimHistoryEntry,
  type SimTurnContext,
} from './sim-user';

// Deterministic asserts (registers all evaluators on import).
export { evaluateAsserts, registerEvaluator, type AssertEvaluator } from './asserts/index';

// Pipeline (invoke-once) target kind.
export * from './pipeline';

// Identity hashing.
// `identityFor` was removed by WI-41685: a zero-caller positional wrapper that,
// left un-updated, would have been a scaffold-BLIND second identity path.
export { computeIdentityHash, computeScenarioHash, computeFindingShape } from './identity';

// Derived rubric versions (WI-41678 / EI-21449130141174031). A rubric's version
// feeds computeIdentityHash, so it decides which stored runs are comparable.
// Derive it from the rubric's version-free CONTENT instead of hand-maintaining a
// literal, or an anchor edit keeps a stale identity and makes incomparable runs
// look like one continuous trend.
export { deriveRubricVersion } from './rubric-version';

// Persona blends + trait composition.
export * from './personas/blends';
export { composePersonaPrompt, resolvePersona } from './personas/traits';

// Tool-dispatch override helpers. (PASS_THROUGH + the ToolDispatchOverride /
// ToolResult types already come from ./types; re-export only the unique
// registry + builder helpers here to avoid a duplicate-export collision.)
export {
  registerOverride,
  getOverride,
  clearOverride,
  makeStaticOverride,
  makeSlowOverride,
  chainOverrides,
} from './dispatch-override';

// Tape-ordering helpers.
export { findEventsAfter, deltaTextAfter } from './tape-ordering';

// Compare/select runner + Scorer modes (test-gym P-002 + P-003).
export {
  BASELINE_ID,
  compareArms,
  runCompareSelect,
  deterministicScorer,
  judgeAxisScorer,
  passRateScorer,
  meanCostScorer,
  meanLatencyScorer,
  toolCallRateScorer,
  type Scorer,
  type ScorerDirection,
  type CompareArm,
  type CompareArmsOpts,
  type CompareSelectOpts,
  type CompareSelectResult,
  type MetricDiff,
  type RankedCandidate,
} from './compare-select';

// LLM-client generic helpers (pricing + JSON recovery + call shapes).
export {
  MODEL_PRICES,
  estimateCost,
  tryParseJson,
  isTemperatureDeprecatedError,
  type LlmCallOpts,
  type LlmCallResult,
} from './llm-client';

// Typed LLM-call error.
export {
  LlmCallError,
  isLlmCallError,
  rateLimitInfo,
  type TurnError,
  type TurnErrorClass,
  type RateLimitInfo,
} from './llm-error';

// Static scenario linter.
export {
  lintScenario,
  lintScenarios,
  formatViolations,
  type LintViolation,
  type LintOpts,
} from './lint';

// Judge-model registry.
export {
  resolveJudgeModel,
  isSelfGradingPair,
  type JudgeRegistryEntry,
} from './judges/registry';

// Fixture loader (SSE tape → TurnResult).
export {
  loadFixtureTurn,
  loadFixtureTurns,
  loadFixtureTranscript,
  loadFixtureTelemetry,
  resolveFixturePath,
  type FixtureTelemetry,
} from './fixtures/loader';
