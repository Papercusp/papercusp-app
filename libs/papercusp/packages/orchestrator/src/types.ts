/**
 * Shared types for the orchestrator. `HarnessConfig` is the in-memory EFFECTIVE
 * harness config (`deprecate-harness-config-json-2026-06-06`): it is assembled from
 * the `coding` blueprint's knobs ⊕ the workspace-PG instance store and delivered to
 * the orchestrator via the `HARNESS_CONFIG_JSON` env-transport — it is NO LONGER a
 * model of an on-disk `.papercusp/config.json` (that file is deprecated to zero for
 * config). Feature records live in PG (`harness_features`) or the in-memory test
 * store; FeaturesJson describes the snapshot/import wire shape.
 */

/** Harness phase — which prompt set the orchestrator pulls from. */
export type HarnessPhase = 'staging' | 'department' | 'production' | string;

/** Harness kind — coding harness vs parent (org / department). */
export type HarnessKind = '' | 'coding' | 'org' | 'department';

/** A per-phase entry in the instance config's `phases` map (port / dbPath / …). */
export interface PhaseConfig {
  port?: number | string;
  dbPath?: string;
  // … phases can carry arbitrary keys; orchestrator only needs port + dbPath
  [k: string]: unknown;
}

/** The effective in-memory harness config (blueprint knobs ⊕ workspace-PG instance,
 *  via the HARNESS_CONFIG_JSON env-transport). NOT an on-disk file shape — see the
 *  module header (`deprecate-harness-config-json-2026-06-06`). */
export interface HarnessConfig {
  phase?: HarnessPhase;
  harness_kind?: HarnessKind;
  dept?: string;
  /** Per-phase configuration. Phase name → port / dbPath / etc. */
  phases?: Record<string, PhaseConfig>;
  /** Iteration cost cap in USD across the entire run. */
  maxCostUsd?: number;
  /** Number of agent log files to keep before pruning. Default 500. */
  logRetention?: number;
  /** Branch isolation toggle. */
  branchIsolation?: { enabled?: boolean; baseBranch?: string };
  /** Worktree-per-feature toggle. */
  worktrees?: { enabled?: boolean };
  /** Reviewer behavior toggles. */
  reviewer?: { replanOnAccept?: boolean };
  product?: {
    enabled?: boolean;
    triggerOnNearDone?: boolean;
    nearDoneThreshold?: number;
    mode?: 'auto-apply' | 'propose-only';
    replanOnAccept?: boolean;
  };
  /** Per-role model overrides. */
  models?: Record<string, string>;
  /**
   * Per-harness AI backend configuration with optional per-role overrides.
   * `default` applies to every role; `roles[<role>]` overrides per role.
   * Resolution: roles[role] ⊕ default ⊕ (legacy AGENT_CMD env / models.{role}).
   *
   * `env` is intentionally omitted from this shape: secrets must go through
   * the encrypted-store path (see harness_ai_backend_secrets, future), not
   * the plaintext config.json. Non-secret env can still be passed via
   * `extraArgs` (e.g. `--model`, custom flags).
   */
  aiBackend?: AiBackendConfig;
  /** Anything else the harness might set. */
  [k: string]: unknown;
}

/** Per-role or default AI backend invocation settings. */
export interface AiBackendRoleConfig {
  /** Execution engine. `subprocess` drives one of AGENT_BACKENDS; `loop`
   *  delegates to the operator-injected owned-loop port. Kept separate from
   *  AgentBackend because the owned loop is in-process, not a spawn backend. */
  engine?: 'subprocess' | 'loop';
  /** Full agent command, e.g. `omp -p`, `claude -p`, `omp -p --model claude-sonnet-4-6`. */
  agentCmd?: string;
  /** Model passed via `--model` if `agentCmd` doesn't already include `--model `. */
  model?: string;
  /** Extra argv tokens appended to the spawn (after structured-output flags). */
  extraArgs?: string[];
}

/** Harness-level AI backend block: a default with optional per-role overrides. */
export interface AiBackendConfig {
  default?: AiBackendRoleConfig;
  roles?: Record<string, AiBackendRoleConfig>;
}

/** A single feature record. Canonical store is `harness_features` (PG);
 * snapshots may emit this shape as JSON for archival. */
export interface FeatureRecord {
  id: string;
  status: 'pending' | 'in_progress' | 'passed' | 'failed' | 'proposed' | string;
  attempts?: number;
  worker?: string;
  description?: string;
  [k: string]: unknown;
}

/** Top-level shape used by snapshots / archival exports of the feature
 * list (object or array form). Not a runtime store. */
export type FeaturesJson = { features: FeatureRecord[] } | FeatureRecord[];

/**
 * Which agent CLI is being driven. Determines stream-output parsing +
 * default flag set. `claude-code` (Anthropic claude-cli) emits
 * `stream-json` events with `content_block_delta`; `omp`
 * (`@oh-my-pi/pi-coding-agent`) emits its own `--mode json` event
 * stream with `message_update`/`text_delta`/`tool_call`/`state_update`;
 * `codex` (OpenAI Codex CLI) emits `codex exec --json` JSONL events.
 *
 * Canonical subprocess-spawn backend set. This is the SAME set as
 * `apps/operator/lib/agent-config.ts` `AGENT_BACKENDS`, and a subset of
 * `@papercusp/papercusp-shared` chat-stream's (which additionally has
 * `anthropic-direct` — a stateless HTTP round-trip with no subprocess, so it is
 * NOT spawnable by the orchestrator and is intentionally excluded here).
 * A drift-guard test in `apps/operator/lib/__tests__/agent-backend-sync.test.ts`
 * asserts these three stay consistent (the submodule boundary rules out a
 * single literal import, so the tuple-as-source + guard is the unification).
 */
export const AGENT_BACKENDS = ['claude-code', 'omp', 'codex'] as const;
export type AgentBackend = (typeof AGENT_BACKENDS)[number];

/** Args passed to the orchestrator entry point. */
export interface OrchestratorEnv {
  /** Absolute path to the harness install (HARNESS_DIR env var). */
  harnessDir: string;
  /** Absolute path to the project being driven (PROJECT_DIR env var / cwd). */
  projectDir: string;
  /** Hard iteration cap. Default 200. */
  maxIterations: number;
  /** Sleep seconds between iterations. Default 2. */
  iterationSleep: number;
  /** Override for the agent invocation command. Default `omp -p`. */
  claudeCmd: string;
  /** Backend driving the spawn — selects parser + extra flags. Default 'claude-code'. */
  agentBackend: AgentBackend;
  /** Phase resolved from config.json (defaulted to "staging"). */
  phase: HarnessPhase;
  /** Optional port for phase-aware prompts. */
  port?: string;
  /** Optional DB path for phase-aware prompts. */
  dbPath?: string;
}

/** Decision the orchestrator role emits as its final answer. */
export type OrchestratorDecision =
  | { kind: 'NEXT_WORKER'; featureId: string }
  | { kind: 'NEXT_VALIDATOR'; featureId: string }
  | { kind: 'NEXT_DEBUGGER'; featureId: string }
  | { kind: 'DONE' }
  | { kind: 'PLAN' }
  | { kind: 'REPLAN' }
  | { kind: 'PROPOSAL_REVIEW' }
  | { kind: 'CHILD_HARNESS'; childPath: string }
  | { kind: 'UNKNOWN'; raw: string };

/** What `invoke()` returns. */
export interface InvokeResult {
  /** stdout (the final result line — what bash captured into `$out`). */
  output: string;
  /** Path to the `.jsonl` stream-json log for UIs. */
  jsonlPath: string;
  /** Path to the final `.out` text. */
  outPath: string;
  /** Process exit code. 0 = success. */
  exitCode: number;
  /** Wall-clock duration in ms. */
  durationMs: number;
}
