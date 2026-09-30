/**
 * Injected seams (P-071).
 *
 * The generic LLM-testing framework names no host app. Everything host-specific
 * — the concrete LLM transport, the per-target chat surfaces, telemetry pulls,
 * the run-report store, and the parallel-runner claim ledger — is injected
 * through this `RunnerDeps` bag. A host (the operator, or any borrower) supplies
 * concrete implementations; the lib itself imports nothing host-coupled.
 *
 * The interface signatures here MATCH the operator's existing
 * `apps/operator/lib/llm-testing/{llm-client,telemetry,storage,ledger}.ts`
 * exports so the operator's switchover is a thin adapter, not a rewrite.
 */

import type { LlmCallOpts, LlmCallResult } from './llm-client';
import type { ChatTarget, ContinueChainRow, ScenarioSetup, ToolInvocationRow } from './types';
// `import type` is erased at runtime → no runtime cycle with runner.ts.
import type { RunReport } from './runner';

/**
 * The concrete one-shot LLM completion. The operator implements this over its
 * `runAgentChat`/`meridian` backend; tests pass a fake. Shapes are the generic
 * `LlmCallOpts`/`LlmCallResult` from ./llm-client.
 */
export type LlmCallFn = (opts: LlmCallOpts) => Promise<LlmCallResult>;

/**
 * Resolve the judge/sim default models from a host config source (e.g. the
 * operator agent-config). Optional — when absent the runner falls back to env
 * (`LLM_TEST_JUDGE_MODEL` / `LLM_TEST_SIM_MODEL`) + the registry default.
 * Either field may be omitted to mean "no host preference; use the fallback".
 */
export type ModelResolver = () => Promise<{ judgeModel?: string; simModel?: string }>;

/**
 * Best-effort telemetry pull keyed by the run's `uiClientId`. Optional —
 * skipped if absent. Matches operator `telemetry.ts`:
 * `pullToolInvocations` / `pullContinueChainRows`.
 */
export interface TelemetryProvider {
  pullToolInvocations(uiClientId: string): Promise<ToolInvocationRow[]>;
  pullContinueChainRows(uiClientId: string): Promise<ContinueChainRow[]>;
}

/**
 * Persist a finished run report. Optional — when present the runner calls it
 * once at end-of-run. Matches operator `storage.ts`:
 * `persistRunReport(report, rubricVersion, scenarioHash)`.
 */
export interface LlmTestStore {
  persistRunReport(report: RunReport, rubricVersion: string, scenarioHash: string): Promise<void>;
}

/** Result of a claim attempt against the parallel-runner ledger. Mirrors
 *  operator `ledger.ts`'s `ClaimResult` (a holder describes the current owner). */
export type ClaimResult =
  | { ok: true; claimKey: string; ownerId: string; expiresAt: Date }
  | { ok: false; reason: 'busy'; holder: { ownerId: string; acquiredAt: Date; expiresAt: Date } };

/** Input to a claim attempt. Mirrors operator `ledger.ts`'s `TryClaimOpts`. */
export interface ClaimOpts {
  scenarioId: string;
  identityHash: string;
  matrixIndex?: number;
  ownerId?: string;
  ttlSec?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Coordinates parallel runners so two processes don't double-spend on the same
 * (scenario × identity × matrix-index) tuple. Optional — when absent the runner
 * skips claiming. Matches operator `ledger.ts`: `tryClaim` / `release`.
 */
export interface ClaimStore {
  tryClaim(opts: ClaimOpts): Promise<ClaimResult>;
  release(claimKey: string, ownerId: string): Promise<void>;
}

/**
 * Undo whatever `applySetup` seeded — called once per run in a finally,
 * after the session closes, so seeded state never outlives its run even
 * when the run errors. Must be idempotent-ish (a second call is a no-op
 * or harmless).
 */
export type SetupCleanup = () => Promise<void>;

/**
 * Apply a scenario's `setup` block before the session opens (memory
 * seeding, fixture rows, …) and return the cleanup that removes it.
 * Optional — when absent, scenarios with `setup` run without seeding
 * (the runner warns). The host owns ALL semantics: which store, which
 * scopes, what `kind` maps to. Returning void means "nothing to clean".
 */
export type SetupApplier = (
  setup: ScenarioSetup,
  ctx: { runId: string },
) => Promise<SetupCleanup | void>;

/**
 * The full injected dependency bag for `runScenario`. Only `llmCall` +
 * `getTarget` are required; the rest are optional best-effort seams.
 */
export interface RunnerDeps {
  /** Concrete LLM transport for the sim-user + judge. */
  llmCall: LlmCallFn;
  /** Resolve a registered chat target by id (the host owns the registry). */
  getTarget: (id: string) => ChatTarget;
  /** Host model preferences; falls back to env + registry when omitted. */
  resolveModels?: ModelResolver;
  /** Best-effort post-run telemetry pull; skipped when omitted. */
  telemetry?: TelemetryProvider;
  /** Persist the run report at end-of-run; skipped when omitted. */
  store?: LlmTestStore;
  /** Parallel-runner claim coordination; skipped when omitted. */
  claim?: ClaimStore;
  /** Apply scenario.setup before the session opens; cleanup runs post-run. */
  applySetup?: SetupApplier;
}
