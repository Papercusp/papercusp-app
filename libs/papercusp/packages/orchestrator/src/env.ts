/**
 * Resolve the orchestrator runtime environment from process env + config.
 *
 * Mirrors the top of bash run.sh: HARNESS_DIR, PROJECT_DIR, STATE_DIR,
 * LOG_DIR, MAX_ITERATIONS, CLAUDE, plus phase-aware HARNESS_PHASE / PORT /
 * DB_PATH derived from .papercusp/config.json.
 */
import { harnessRoot } from '@papercusp/harness/paths';
import { resolvePhase } from './config';
import { readEffectiveConfig } from './effective-config';
import type { AgentBackend, OrchestratorEnv } from './types';
// This leaf module is dependency-free and is also consumed by the bare-node
// psu launcher. Keeping the Codex policy in one place prevents the orchestrator
// from reintroducing a model-less or Spark-bearing command before it reaches
// the operator-side writers.
import {
  normalizeClaudeModelEffortSpec,
  resolveCodexModel,
} from '../../../../../packages/operator-core/lib/model-context-budget.mjs';

export { resolveCodexModel };

const CLAUDE_EFFORT_SPEC_RE = /^(.+):(low|medium|high|xhigh|max)$/i;

/**
 * The claude-code argv for a psu-style `<model>[:<effort>]` spec (WI-10006244).
 * Claude takes reasoning effort as its OWN `--effort` flag: a verbatim
 * `--model opus:xhigh` sets the model and silently drops the effort (the EI-7138
 * class operator-core's applyRoleModel already handles). Opus 5 also retired
 * `xhigh` in favor of `max`, so the spec goes through the same
 * `normalizeClaudeModelEffortSpec` rule every other Claude launch boundary uses.
 * A spec with no recognized effort suffix keeps the single `--model <spec>`.
 * Input is the backend-normalized model (provider prefix already stripped).
 */
export function claudeModelFlagArgs(model: string): string[] {
  const normalized = normalizeClaudeModelEffortSpec(model);
  const m = CLAUDE_EFFORT_SPEC_RE.exec(normalized);
  return m ? ['--model', m[1], '--effort', m[2].toLowerCase()] : ['--model', normalized];
}

/**
 * Resolve which agent backend to drive. Reads `AGENT_BACKEND` directly,
 * else infers from the agent command (`omp` keyword → omp, otherwise
 * claude-code). The explicit env var wins so users can force the parser
 * even when shelling through wrappers.
 */
export function resolveAgentBackend(agentCmd: string): AgentBackend {
  const explicit = (process.env.AGENT_BACKEND ?? '').trim().toLowerCase();
  if (explicit === 'omp' || explicit === 'pi') return 'omp';
  if (explicit === 'claude-code' || explicit === 'claude') return 'claude-code';
  if (explicit === 'codex') return 'codex';
  // Infer from the binary name in agentCmd.
  const first = agentCmd.split(/\s+/).filter(Boolean)[0] ?? '';
  if (/(^|\/)(omp|pi)$/.test(first)) return 'omp';
  if (/(^|\/)codex$/.test(first)) return 'codex';
  return 'claude-code';
}

/**
 * Normalize a model id for the target backend's CLI.
 *
 * omp uses the explicit `provider/model` form (e.g.
 * `anthropic/claude-opus-4-7`), and that is what the operator's
 * /settings/agent page + per-harness config.json store. The claude CLI's
 * `--model`, however, rejects the provider prefix — it wants a bare id
 * (`claude-opus-4-7`) or an alias (`opus`/`sonnet`/`haiku`). So for the
 * claude-code backend we strip a single leading `provider/` segment;
 * for omp (and an already-bare id) we pass the value through untouched.
 * codex's `-m` likewise wants a bare id (`gpt-5.5`), so it strips the
 * provider prefix the same way claude-code does and maps Papercusp's
 * user-facing `chatgpt:5.5` alias to Codex CLI's native `gpt-5.5`.
 * Empty in → empty out.
 */
export function normalizeModelForBackend(model: string, backend: AgentBackend): string {
  if (!model && backend !== 'codex') return '';
  if (backend !== 'claude-code' && backend !== 'codex') return model;
  const slash = model.indexOf('/');
  const bare = slash > 0 ? model.slice(slash + 1) : model;
  if (backend !== 'codex') return bare;
  const chatgpt = /^chatgpt:(.+?)(?::(?:low|medium|high|xhigh|max))?$/i.exec(bare);
  const normalized = chatgpt ? `gpt-${chatgpt[1]}` : bare;
  // Resolve/validate through the canonical policy even when the caller supplied
  // a model explicitly. Codex's CLI takes a bare id; strip only the recognized
  // effort suffix after the policy has inspected the complete spec.
  const resolved = resolveCodexModel(normalized);
  return resolved.replace(/:(?:low|medium|high|xhigh|max)$/i, '');
}

/**
 * Resolve the agent invocation command. `AGENT_CMD` wins over the
 * legacy `CLAUDE` env (back-compat) so existing harness installs keep
 * working without an env-var migration.
 */
export function resolveAgentCmd(): string {
  const fromAgent = process.env.AGENT_CMD;
  if (fromAgent && fromAgent.trim()) return fromAgent;
  return process.env.CLAUDE ?? 'claude -p';
}

export interface ResolvedPaths {
  harnessDir: string;
  projectDir: string;
  stateDir: string;
  logDir: string;
}

export function resolvePaths(): ResolvedPaths {
  const harnessDir = harnessRoot();
  const projectDir = process.env.PROJECT_DIR ?? process.cwd();
  const stateDir = `${projectDir}/.papercusp`;
  const logDir = `${stateDir}/logs`;
  return { harnessDir, projectDir, stateDir, logDir };
}

export function resolveEnv(): OrchestratorEnv & ResolvedPaths {
  const paths = resolvePaths();
  const cfg = readEffectiveConfig(paths.stateDir);
  const { phase, port, dbPath } = resolvePhase(cfg);
  const claudeCmd = resolveAgentCmd();

  return {
    ...paths,
    maxIterations: parseInt(process.env.MAX_ITERATIONS ?? '200', 10),
    iterationSleep: parseFloat(process.env.ITERATION_SLEEP ?? '2'),
    claudeCmd,
    agentBackend: resolveAgentBackend(claudeCmd),
    phase,
    port,
    dbPath,
  };
}
