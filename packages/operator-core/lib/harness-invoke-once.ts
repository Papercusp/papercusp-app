/**
 * Build the spawn command + env for a one-shot TS agent invoke via the
 * orchestrator's `invoke-once.ts` bin.
 *
 * This is the replacement for the legacy
 *   `bash -c 'source <(awk ... run.sh); invoke <role> EXTRAS...'`
 * pattern that operator sites used to spawn an agent off run.sh's
 * bash function library: `harness-scoper.ts` (background scoper) and the
 * `/harness/:slug/invoke` route. `invoke-once.ts` reads ROLE / EXTRAS_JSON / RESULT_PATH plus the
 * usual PROJECT_DIR / STATE_DIR / HARNESS_DIR from env, constructs the
 * InvokeContext (with PG bootstrap), and runs the TS `invoke()` exactly
 * once — the same code path the orchestrator main loop drives.
 *
 * Callers own the spawn options (detached vs. synchronous, stdio) and any
 * result-file polling; this just assembles the command + env so the call
 * sites stay in lockstep.
 */
import { invokeOnceBin, tsxBin } from './harness-paths';
import { augmentedSpawnPath, resolveBin } from './plugin-spawn-impl';
import { getHarnessAdminUrl } from './embedded-pg-discovery';
import { roleModelDefault } from '@papercusp/orchestrator/role-models';
import { DEFAULT_BACKEND_CMDS, normalizeModelSpec, type AgentBackend } from './agent-config-constants';
import { codexContextConfigArgs, normalizeCodexCliModel, resolveCodexModel } from './model-context-budget.mjs';
import type { TurnBackend } from '@papercusp/papercusp-shared/agent';

export { normalizeCodexCliModel } from './model-context-budget.mjs';

/** Backend a command's binary drives (the same discriminator
    resolveSpawnBackendModel / effectiveBackend use). */
function cmdBackend(cmd: string): AgentBackend {
  const bin = cmd.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (/codex/.test(bin)) return 'codex';
  if (/claude/.test(bin)) return 'claude-code';
  return 'omp';
}

/**
 * Swap the base agent command to `backend`'s default when it differs from the
 * command's own backend (per-tier backend, queen-model-tier-selection). The
 * host command's flags are deliberately NOT carried over — they're
 * binary-specific (a claude flag means nothing to omp); backend-specific
 * flags (stream format, scheduler deny) are appended by the child's invoke
 * path from the resolved backend, not from AGENT_CMD. No-op when the
 * backends already match, so the host's tuned command survives the usual case.
 */
export function applyBackendSwap(baseCmd: string, backend?: string): string {
  if (!backend) return baseCmd;
  const target = backend as AgentBackend;
  if (!DEFAULT_BACKEND_CMDS[target] || cmdBackend(baseCmd) === target) return baseCmd;
  return DEFAULT_BACKEND_CMDS[target];
}

function specModelId(spec?: string): string {
  const trimmed = (spec ?? '').trim();
  if (!trimmed) return '';
  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon <= 0) return trimmed;
  const suffix = trimmed.slice(lastColon + 1);
  return EFFORT_LEVELS.has(suffix) ? trimmed.slice(0, lastColon) : trimmed;
}

/**
 * Claude Code's BARE model aliases, optionally carrying the `[1m]` auto-compact
 * window marker (`sonnet`, `opus[1m]`, …). These resolve ONLY inside the
 * `claude` CLI: `omp models` publishes no bare alias at all — its Claude entries
 * are fully qualified (`claude-sonnet-4-6`, `claude-opus-4-8`,
 * `claude-haiku-4-5`) — so handing one to `omp -p` kills the spawn before its
 * first turn with `Model "sonnet[1m]:high" not found`.
 *
 * ⚠ Deliberately ANCHORED on both ends. It must NOT match `claude-sonnet-4-6` /
 * `claude-opus-4-8`, which ARE valid omp ids: a loose /sonnet|opus/ test would
 * yank legitimate omp spawns onto the claude binary — the same bug with the
 * sign flipped.
 */
const CLAUDE_ONLY_ALIAS_RE = /^(?:sonnet|opus|haiku|fable)(?:\[1m\])?$/;

/** True when `spec`'s model id is one of Claude Code's bare aliases — a spec
    ONLY the `claude` binary can resolve. */
export function isClaudeOnlyModelSpec(spec?: string): boolean {
  return CLAUDE_ONLY_ALIAS_RE.test(specModelId(spec).toLowerCase());
}

/**
 * The base agent command to fall back on when the host has configured NOTHING —
 * no `AGENT_CMD`, no `CLAUDE`, no per-spawn or per-role backend. This is the
 * bare code-level literal, NOT an operator preference, so it is the one place
 * the model spec is allowed to pick the binary: a committed spec the fallback
 * binary cannot run is never what anyone intended.
 *
 * WI-36197 (2026-08-08): the literal used to be an unconditional `'omp -p'`.
 * `papercup-bg-host.service` exports `AGENT_CMD='claude -p'`, so mug/kettle
 * spawns were fine and the gap stayed invisible — but the OPERATOR process
 * exports none, and it is the process that serves `cup:spawn`. Cups therefore
 * launched `omp -p --model sonnet[1m]:high` (their committed
 * `cup: 'sonnet[1m]:high'` default) while `omp models` publishes no bare alias
 * at all, so six consecutive spawns returned `ok` and died in ~1.5s with
 * `Model "sonnet[1m]:high" not found`, blocking goal-mode-2026-08-07 P-002.
 *
 * This is the MIRROR of the 2026-07-16 kettle@papercusp outage recorded in
 * role-models.ts, where a claude-binary role was handed a codex-only
 * `gpt-5.6-luna`. A spec/binary mismatch is fatal at launch and near-silent in
 * the logs, so pair them from the spec whenever nothing else has an opinion.
 *
 * ⚠ Deliberately does NOT override an explicit choice. An operator who sets
 * `AGENT_CMD='omp -p'` or `AGENT_ROLE_BACKENDS` still gets exactly that (both
 * are pinned by tests) — those callers have expressed intent, and quietly
 * overruling them is how the codex branch of `inferBackendFromModelSpec` earns
 * its much narrower scope.
 */
export function fallbackBaseCmd(spec?: string): string {
  return isClaudeOnlyModelSpec(spec) ? DEFAULT_BACKEND_CMDS['claude-code'] : DEFAULT_BACKEND_CMDS.omp;
}

/** Infer a subprocess backend from an explicit per-spawn model spec when the
    spec is unambiguously provider-specific. Keep this intentionally narrow:
    only Codex-shaped specs FORCE a backend swap (they outrank even an explicit
    per-role backend — honoring a claude/omp preference against a Codex-only
    model is a guaranteed launch failure). Claude/OMP aliases continue to
    inherit the configured command unless the caller supplied
    PAPERCUSP_SPAWN_BACKEND; when nothing is configured at all they steer the
    literal default instead, via `fallbackBaseCmd` above. */
export function inferBackendFromModelSpec(spec?: string): AgentBackend | undefined {
  const id = specModelId(spec).toLowerCase();
  if (!id) return undefined;
  if (id.startsWith('openai-codex/') || id.startsWith('chatgpt:') || /^gpt-\d/.test(id)) return 'codex';
  return undefined;
}

/**
 * Infer the `{ backend, model }` the spawned CLI will actually use for `role` — from the
 * resolved per-role agent command (`AGENT_CMD`/`CLAUDE` + the `AGENT_MODELS` override). Used
 * to key the SHARED RateLimitGovernor to the right `(provider, model-class)` bucket (RB-012)
 * so the pipeline spawn paces against the bucket it really hits: the default `omp -p` is
 * self-pacing (collapses to omp's concurrency-only bucket), `claude …` → the Anthropic
 * per-model-class bucket (opus/sonnet are separate buckets), `codex …` → the OpenAI bucket.
 * Previously the orchestrator hardcoded `('claude-code', '')`, which both mis-attributed the
 * default omp spawns to Anthropic AND collapsed every role into one `anthropic:default`
 * bucket. Exported for unit testing.
 */
export function resolveSpawnBackendModel(
  role: string,
  overrideSpec?: string,
  overrideBackend?: string,
): { backend: TurnBackend; model: string } {
  // Backend inference keys off the EFFECTIVE spec (override > env map > committed
  // default), not just the per-spawn channel — a Codex-only committed default
  // (kettle post-P-020) must bucket against OpenAI, not Anthropic (WI-4640).
  const effectiveSpec = resolveEffectiveRoleModelSpec(role, overrideSpec);
  const effectiveBackend =
    overrideBackend || inferBackendFromModelSpec(effectiveSpec) || roleBackendOverride(role);
  const base = applyBackendSwap(
    process.env.AGENT_CMD ?? process.env.CLAUDE ?? fallbackBaseCmd(effectiveSpec),
    effectiveBackend,
  );
  const cmd = applyRoleModel(base, role, overrideSpec);
  const bin = cmd.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const backend: TurnBackend = /codex/.test(bin) ? 'codex' : /claude/.test(bin) ? 'claude-code' : 'omp';
  const m = /(?:--model(?:=|\s+)|\s-m\s+)(\S+)/.exec(cmd);
  return { backend, model: m?.[1] ?? '' };
}

/** The EFFECTIVE model spec a spawn of `role` will run — the same precedence
 *  applyRoleModel injects into the command: per-spawn override >
 *  AGENT_MODELS env map > committed ROLE_MODEL_DEFAULTS floor. Exported so
 *  backend inference (buildInvokeOnce / resolveSpawnBackendModel) keys off the
 *  spec that will ACTUALLY be injected, not just the per-spawn channel: when
 *  P-020 moved kettle's COMMITTED default to the Codex-only `gpt-5.6-luna:high`,
 *  the inference still only saw PAPERCUSP_SPAWN_MODEL, so every kettle fire
 *  handed `--model gpt-5.6-luna` to the claude CLI and died at launch
 *  (WI-4640 runtime casualty, 2026-07-17). */
export function resolveEffectiveRoleModelSpec(role: string, overrideSpec?: string): string {
  if (typeof overrideSpec === 'string' && overrideSpec.trim()) return overrideSpec.trim();
  const raw = process.env.AGENT_MODELS;
  if (raw) {
    try {
      const models = JSON.parse(raw) as Record<string, unknown>;
      const v = models[role];
      if (typeof v === 'string' && v.trim()) return v.trim();
    } catch {
      /* malformed AGENT_MODELS — fall through to the committed default */
    }
  }
  const fallback = roleModelDefault(role);
  return typeof fallback === 'string' ? fallback.trim() : '';
}

/** Per-role backend override from /settings/agent. Explicit per-spawn backend
    wins before this is consulted; malformed JSON fails open to inherited. */
export function roleBackendOverride(role: string): AgentBackend | undefined {
  if (!role) return undefined;
  const raw = process.env.AGENT_ROLE_BACKENDS;
  if (!raw) return undefined;
  try {
    const map = JSON.parse(raw) as Record<string, unknown>;
    const v = map[role];
    return v === 'claude-code' || v === 'omp' || v === 'codex' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** A disagreement between the two EXPLICIT operator settings that steer a
    spawn's backend. `inferredBackend` is the one that WINS. */
export interface RoleBackendConflict {
  role: string;
  /** The effective `AGENT_MODELS[role]` spec whose family implied a backend. */
  modelSpec: string;
  /** Implied by `modelSpec` — the backend the spawn actually launches on. */
  inferredBackend: AgentBackend;
  /** The per-role `AGENT_ROLE_BACKENDS[role]` choice being overridden. */
  roleBackend: AgentBackend;
}

/**
 * Detect the case where `AGENT_MODELS[role]` (a model spec, whose family implies
 * a backend) and `AGENT_ROLE_BACKENDS[role]` (a backend named outright) — both
 * EXPLICIT operator settings — disagree.
 *
 * The disagreement is resolved toward the model spec, and must keep being:
 * baking a Codex-only id onto the claude CLI 404s on every fire, hard-downing
 * the role (WI-4640). What was wrong is that the resolution was SILENT, so a
 * role pinned to `claude-code` could launch on `codex` indefinitely with nothing
 * saying why — the release-fixer ran that way against a usage-walled Codex
 * account while the green gate sat red for 100 consecutive runs (WI-2142846).
 * This reports the conflict; it deliberately does NOT change the precedence.
 *
 * Returns null unless BOTH settings resolve AND disagree — never a guess. A
 * per-spawn `PAPERCUSP_SPAWN_BACKEND` outranks both and so is not a conflict,
 * and a role carrying only one of the two settings has nothing to disagree with.
 */
export function detectRoleBackendConflict(
  role: string,
  overrideSpec?: string,
  overrideBackend?: string,
): RoleBackendConflict | null {
  if (overrideBackend) return null;
  const roleBackend = roleBackendOverride(role);
  if (!roleBackend) return null;
  const modelSpec = resolveEffectiveRoleModelSpec(role, overrideSpec);
  const inferredBackend = inferBackendFromModelSpec(modelSpec);
  if (!inferredBackend || inferredBackend === roleBackend) return null;
  return { role, modelSpec, inferredBackend, roleBackend };
}

/** One-line, greppable rendering of a `RoleBackendConflict`. Says which setting
    won, which was ignored, and why the precedence is deliberate — so a reader
    hitting it in a log does not "fix" it by inverting the order (that is the
    WI-4640 regression). */
export function formatRoleBackendConflict(conflict: RoleBackendConflict): string {
  return (
    `[backend-conflict] role '${conflict.role}': AGENT_ROLE_BACKENDS pins ` +
    `'${conflict.roleBackend}' but the AGENT_MODELS spec '${conflict.modelSpec}' implies ` +
    `'${conflict.inferredBackend}'. Launching on '${conflict.inferredBackend}' and IGNORING ` +
    `the per-role backend — a model spec baked onto the wrong CLI fails at launch (WI-4640). ` +
    `Align the two settings in /settings/agent; do not invert this precedence.`
  );
}

/**
 * True when `role`'s resolved 'omp' backend traces to an EXPLICIT operator
 * choice — a per-role `AGENT_ROLE_BACKENDS` override, or a globally configured
 * `AGENT_CMD`/`CLAUDE` command — rather than the bare code-level literal
 * default (`applyBackendSwap`'s `'omp -p'` fallback, applied only when NOTHING
 * is configured). Only meaningful to call once the caller already knows the
 * role resolved to 'omp': if either env var were set to a non-omp command the
 * resolution would not have landed on 'omp' in the first place, so "is set"
 * alone is sufficient here without re-parsing its content.
 *
 * Used by the tracked hive/overwatch launch guard (spawn.ts, EI-18133554034909305
 * "Agent spawns are failing repeatedly") to decide whether a
 * forced-native-session-id failure should hard-fail (an intentional operator
 * choice deserves a loud, honest error) or be silently rescued by falling back
 * to claude-code (the unconfigured "just fell through to the generic default"
 * case — which is what EVERY tracked launch hit on a host with no explicit
 * backend config, since OMP structurally cannot support a forced session id).
 */
export function isOmpBackendExplicitlyConfigured(role: string): boolean {
  return roleBackendOverride(role) === 'omp' || Boolean(process.env.AGENT_CMD) || Boolean(process.env.CLAUDE);
}

/** Reasoning-effort levels the `claude --effort` flag accepts. */
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Apply a PER-ROLE model (and optional reasoning effort) override to the base agent
 * command. `AGENT_MODELS` is a JSON map `{ <role>: <spec> }` (mirrored from
 * `AgentConfig.models` by `applyToProcessEnv`). Each `<spec>` is either a bare
 * `<modelId>` or `<modelId>:<effort>` where effort ∈ {low,medium,high,xhigh,max}
 * — the `model:effort` form mirrors the repo's existing convention (e.g.
 * `gpt-5.5:xhigh`) and maps to the CLI's `--model` + `--effort` flags. When the
 * spawned role has an entry, we strip any global `--model`/`--effort` and append
 * the role's — so e.g. the worker (or merge-resolver) runs a stronger model at
 * higher effort while the fast reasoning roles stay on the cheap `AGENT_CMD`
 * default.
 *
 * `AGENT_MODELS` OVERRIDES the committed `ROLE_MODEL_DEFAULTS` floor (EI-7): a
 * role with no env entry falls back to its committed default spec (so e.g.
 * `release-manager` runs at `opus:xhigh` even on a host with `AGENT_MODELS`
 * unset, instead of silently downgrading to the CLI default). A role with
 * neither an env entry nor a committed default keeps the base command
 * unchanged. Exported for unit testing.
 *
 * `overrideSpec` is the PER-SPAWN escalation channel
 * (queen-model-tier-selection-2026-06-11 P-001): an explicit spec for THIS one
 * child — cup:spawn's `model`/`tier` arg, threaded via
 * extraEnv.PAPERCUSP_SPAWN_MODEL — that outranks both the env map and the
 * committed default. Tier-derived overrides are already floor-clamped by
 * resolveTierSpec before they reach here.
 */
export function applyRoleModel(baseCmd: string, role: string, overrideSpec?: string): string {
  const bin = baseCmd.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const isCodex = /(?:^|\/)codex$/.test(bin);
  const isClaude = /(?:^|\/)claude$/.test(bin);
  // Per-spawn override wins, then env, then the committed default floor —
  // resolveEffectiveRoleModelSpec is the one source of that precedence (the
  // backend inference in buildInvokeOnce keys off the SAME resolution). A bare
  // Codex command is different from the other backends: it must carry the
  // canonical safe model even when no role override exists.
  const configuredSpec = resolveEffectiveRoleModelSpec(role, overrideSpec);
  // A role with no configured/committed model must not overwrite an explicit
  // model already present in AGENT_CMD.  That command is an operator choice
  // (and is what RB-012 measures); the policy still validates it so a retired
  // Spark spelling cannot sneak through this otherwise-preserved path.  Only a
  // genuinely model-less Codex command receives the managed default.
  if (isCodex && !configuredSpec) {
    const existing = /(?:--model(?:=|\s+)|(?:^|\s)-m\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(baseCmd);
    const existingModel = existing?.[1] ?? existing?.[2] ?? existing?.[3] ?? '';
    if (existingModel.trim()) {
      resolveCodexModel(existingModel);
      return baseCmd;
    }
  }
  const trimmed = isCodex ? resolveCodexModel(configuredSpec || undefined) : configuredSpec;
  if (!trimmed) return baseCmd;
  // Split a trailing `:<effort>` ONLY when the suffix is a known effort level AND
  // the backend has a distinct effort channel to split it INTO (codex's config
  // override, claude's own --effort flag). EI-7138: this used to split
  // unconditionally regardless of backend — for an omp-backed role (a real,
  // reachable DEFAULT_BACKEND_CMDS entry, `omp -p`) that tore a valid
  // `<model>:<effort>` spec (omp's OWN native format, per suWrapperExtraArgs'
  // omp branch — it takes the suffixed spec verbatim) into separate
  // `--model X --effort Y` flags; omp has no standalone --effort flag, so the
  // effort silently dropped — the exact same effort-drop class this function
  // already guards against for codex/claude, just never closed for omp (or
  // any other/unknown backend, which gets the same verbatim treatment here).
  let model = trimmed;
  let effort: string | undefined;
  if ((isCodex || isClaude) && trimmed.lastIndexOf(':') > 0 && EFFORT_LEVELS.has(trimmed.slice(trimmed.lastIndexOf(':') + 1))) {
    const lastColon = trimmed.lastIndexOf(':');
    model = trimmed.slice(0, lastColon);
    effort = trimmed.slice(lastColon + 1);
  }
  // Strip any existing model/effort flags, then append the role's. Codex does
  // not have a `--effort` flag; its reasoning effort is a config override.
  let cmd = baseCmd
    .replace(/\s--model(?:=|\s+)\S+/g, '')
    .replace(/\s-m\s+\S+/g, '')
    .replace(/\s--effort(?:=|\s+)\S+/g, '')
    .replace(/\s-c\s+model_reasoning_effort=(?:"[^"]*"|'[^']*'|\S+)/g, '')
    // Strip a PREVIOUSLY-appended window pair too, or re-applying this function
    // to its own output accumulates duplicate `-c` overrides for a model that
    // may since have changed (plan codex-1m-context-window-2026-08-17 P-003).
    .replace(/\s-c\s+model_context_window=(?:"[^"]*"|'[^']*'|\S+)/g, '')
    .replace(/\s-c\s+model_auto_compact_token_limit=(?:"[^"]*"|'[^']*'|\S+)/g, '')
    .trimEnd();
  // Claude CLI exec boundary: a default-1M-family spec (opus/fable/sonnet-5,
  // incl. the bare `sonnet` alias) must carry the `[1m]` window marker — a bare
  // spec runs a 200k AUTO-COMPACT window in CC 2.1.198 (live-verified via
  // /context 2026-07-02; auto-fires ~167k, which killed a wave of sonnet fleet
  // members). Normalizing HERE covers every channel funneling into this argv
  // (committed role default, AGENT_MODELS, per-spawn pin) without changing
  // their precedence. Claude-only: OMP/Codex specs never get the marker.
  const cliModel = isCodex ? normalizeCodexCliModel(model) : isClaude ? normalizeModelSpec(model) : model;
  cmd = `${cmd} --model ${cliModel}`;
  if (effort) {
    cmd = isCodex
      ? `${cmd} -c model_reasoning_effort="${effort}"`
      : `${cmd} --effort ${effort}`;
  }
  // Codex extended-window models launch at their declared window (plan
  // codex-1m-context-window-2026-08-17 D-002). Kept in lockstep with
  // psu-launcher `modelArgsFor` by the EI-7138 parity guard in
  // apps/operator/lib/psu-launcher.test.ts — a window pair added on one side
  // only will red that test, which is the point. Empty for a model with no
  // extended window, so those commands stay byte-identical.
  if (isCodex) {
    const windowArgs = codexContextConfigArgs(cliModel);
    if (windowArgs.length) cmd = `${cmd} ${windowArgs.join(' ')}`;
  }
  return cmd;
}

/**
 * Append a forced native session id to the agent command so a headless bee run
 * is resumable by EXACT uuid — `claude --resume <uuid>` — for the hive-tabs bee
 * attach (hive-agent-tabs-psu-tui-2026-06-09 P-016 / D-007). Only `claude`
 * accepts `--session-id`; omp resumes by thread id and codex by rollout, so for
 * those the command is returned UNCHANGED (the caller records the backend-native
 * handle instead). Idempotent — never double-appends if a `--session-id` is
 * already present. Exported for unit testing.
 */
export function appendForcedSessionId(cmd: string, sessionId: string): string {
  const bin = cmd.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!/claude/.test(bin)) return cmd; // omp/codex: not claude-resumable this way
  if (/--session-id(?:=|\s)/.test(cmd)) return cmd; // already forced
  return `${cmd.trimEnd()} --session-id ${sessionId}`;
}

export interface InvokeOnceSpec {
  /** PROJECT_DIR — the user's project root. */
  projectDir: string;
  /** STATE_DIR — usually `<projectDir>/.papercusp`. */
  stateDir: string;
  /** HARNESS_DIR — normally the harness package dir; a caller may
      overlay a per-run prompt-shadow dir here. */
  harnessDir: string;
  /** Role to invoke (scoper, worker, …). */
  role: string;
  /** Positional `K=V` extras (e.g. `MODE=proposal`, `FEATURE_ID=F-1`)
      — passed to invoke-once as EXTRAS_JSON. */
  extras: string[];
  /** When set, invoke-once tees output here and appends the
      `__INVOCATION_DONE__` sentinel on exit (for background pollers). */
  resultPath?: string;
  /** Extra env merged in (role-specific: SCOPER_*, decrypted
      search-provider keys). `undefined` values are skipped. */
  extraEnv?: Record<string, string | undefined>;
  /** P-016/D-007: force this native session uuid so the run is resumable by exact
      id (`claude --resume <uuid>`). Applied only when the resolved backend is
      claude (see appendForcedSessionId); the caller records it for the bee attach. */
  forceSessionId?: string;
}

export function buildInvokeOnce(spec: InvokeOnceSpec): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  // Per-role model override (AGENT_MODELS): lets the worker run a stronger model
  // than the fast reasoning roles. invoke-once's resolveAgentCmd() reads
  // `AGENT_CMD ?? CLAUDE`, so we MUST override AGENT_CMD (the preferred var) —
  // setting only CLAUDE is masked by the inherited global AGENT_CMD. Set both so
  // whichever resolveAgentCmd reads gets the per-role command.
  // PAPERCUSP_SPAWN_MODEL (in extraEnv) is the per-spawn escalation: an explicit
  // spec for THIS child that outranks the env map + committed default — set by
  // spawnAgentInHarness from cup:spawn's model/tier arg (P-001). It also rides
  // the child's env, where invoke.ts resolveModel consults it first (covers the
  // config.aiBackend agentCmd-swap path this command-level append can't reach).
  // PAPERCUSP_SPAWN_BACKEND (per-tier backend) swaps the base command to that
  // backend's default before the model is applied — and must ALSO override the
  // inherited AGENT_BACKEND below: the child's resolveAgentBackend prefers the
  // explicit env over binary inference, so a swapped command with a stale
  // AGENT_BACKEND would mis-resolve every backend-keyed flag.
  // Backend inference keys off the EFFECTIVE spec — per-spawn override >
  // AGENT_MODELS > committed ROLE_MODEL_DEFAULTS — because applyRoleModel will
  // bake exactly that spec into AGENT_CMD. Keying off PAPERCUSP_SPAWN_MODEL
  // alone left a Codex-only COMMITTED default (kettle → gpt-5.6-luna:high,
  // P-020) on the claude CLI: Anthropic 404s the id and the role is hard-down
  // on every fire (WI-4640, 2026-07-17). A Codex-shaped effective spec also
  // deliberately outranks roleBackendOverride: honoring an explicit claude/omp
  // per-role backend against a Codex-only model is a guaranteed launch failure,
  // not a preference to preserve.
  const effectiveSpawnSpec = resolveEffectiveRoleModelSpec(
    spec.role,
    spec.extraEnv?.PAPERCUSP_SPAWN_MODEL,
  );
  const spawnBackend =
    spec.extraEnv?.PAPERCUSP_SPAWN_BACKEND ||
    inferBackendFromModelSpec(effectiveSpawnSpec) ||
    roleBackendOverride(spec.role);
  // WI-2142846: the precedence above is deliberate (WI-4640), but it silently
  // discards an explicit per-role backend when the model spec implies another.
  // Say so at the spawn seam — that silence is what let the release-fixer launch
  // on a usage-walled Codex account for a day while the gate sat red.
  const backendConflict = detectRoleBackendConflict(
    spec.role,
    spec.extraEnv?.PAPERCUSP_SPAWN_MODEL,
    spec.extraEnv?.PAPERCUSP_SPAWN_BACKEND,
  );
  if (backendConflict) console.warn(formatRoleBackendConflict(backendConflict));
  const roleAgentCmd = applyRoleModel(
    applyBackendSwap(
      process.env.AGENT_CMD ?? process.env.CLAUDE ?? fallbackBaseCmd(effectiveSpawnSpec),
      spawnBackend,
    ),
    spec.role,
    spec.extraEnv?.PAPERCUSP_SPAWN_MODEL,
  );
  // P-016/D-007: when the spawn forces a native session id, bake `--session-id`
  // into the (claude) agent command so the headless bee run is resumable by exact
  // uuid for the hive-tabs bee attach. No-op for omp/codex (appendForcedSessionId).
  const agentCmd = spec.forceSessionId
    ? appendForcedSessionId(roleAgentCmd, spec.forceSessionId)
    : roleAgentCmd;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PROJECT_DIR: spec.projectDir,
    STATE_DIR: spec.stateDir,
    HARNESS_DIR: spec.harnessDir,
    LOG_DIR: `${spec.stateDir}/logs`,
    ROLE: spec.role,
    EXTRAS_JSON: JSON.stringify(spec.extras),
    AGENT_CMD: agentCmd,
    CLAUDE: agentCmd,
    // Per-tier backend swap: pin the child's explicit backend to the swapped
    // one (resolveAgentBackend prefers AGENT_BACKEND over binary inference).
    ...(spawnBackend && DEFAULT_BACKEND_CMDS[spawnBackend as AgentBackend]
      ? { AGENT_BACKEND: spawnBackend }
      : {}),
    ...(spawnBackend && DEFAULT_BACKEND_CMDS[spawnBackend as AgentBackend]
      ? { PAPERCUSP_SPAWN_BACKEND: spawnBackend }
      : {}),
    // Production launchers must enable the PG state path + provide the DSN — the
    // pg-bootstrap otherwise runs with empty in-memory state and the spawned
    // agent's tools (spawn-mcp) fail "no PG DSN in env". Mirrors harness-launch.ts
    // so invoke-route/scoper agents hit the SAME Postgres the operator
    // uses. `??` keeps any explicit override (e.g. tests forcing in-memory).
    PAPERCUSP_USE_PG_STATE: process.env.PAPERCUSP_USE_PG_STATE ?? '1',
    // `||` (not `??`): an EMPTY-string DATABASE_URL must fall through to the
    // resolved admin URL, not mask it — an empty value reaches the agent as
    // `DATABASE_URL=''`, which spawn-mcp reads as "no PG DSN" and refuses to sign
    // the MCP URL (observed breaking a durable-pipeline director invoke).
    // WI-1666 env-inheritance leg (2026-07-03): in an ISOLATED process (explicit
    // PAPERCUSP_PG_PORT — smoke witnesses, rig instances, desktop sidecars), an
    // INHERITED DATABASE_URL (agent shells export the box's shared native :5432)
    // must NEVER reroute spawned workers to the shared PG — that is exactly how a
    // "fresh, isolated" from-repo smoke read the tower's pre-existing directory/
    // binding state. getHarnessAdminUrl() honors PAPERCUSP_PG_PORT in its native
    // fallback (and PAPERCUSP_SKIP_PG_DISCOVERY=1 bypasses stale discovery), so
    // isolated processes resolve to their OWN embedded PG.
    DATABASE_URL:
      (process.env.PAPERCUSP_PG_PORT ? '' : process.env.DATABASE_URL) || getHarnessAdminUrl(),
    // The orchestrator's pg-bootstrap (which the spawned invoke-once subprocess runs)
    // resolves its DSN from PAPERCUSP_DATABASE_URL > ~/.papercusp/embedded-pg.json >
    // hardcoded :5432/papercusp — it does NOT read DATABASE_URL. So setting DATABASE_URL
    // alone is NOT enough to make the worker "hit the SAME Postgres the operator uses":
    // when the operator's DB ≠ the :5432/papercusp fallback (e.g. the harness gym's
    // dedicated PG), the worker connects to the wrong DB and `UPDATE harness_features`
    // 42P01s (the gym's per-harness schema is absent there). Mirror the resolved DSN
    // onto PAPERCUSP_DATABASE_URL so the worker's bootstrap tracks the operator's DB.
    // For the live fleet this equals DATABASE_URL (= the live DB the fallback already
    // resolved to), so it's a no-op there; an explicit PAPERCUSP_DATABASE_URL is kept.
    PAPERCUSP_DATABASE_URL:
      process.env.PAPERCUSP_DATABASE_URL ||
      (process.env.PAPERCUSP_PG_PORT ? '' : process.env.DATABASE_URL) ||
      getHarnessAdminUrl(),
  };
  if (spec.resultPath) env.RESULT_PATH = spec.resultPath;
  for (const [k, v] of Object.entries(spec.extraEnv ?? {})) {
    if (v !== undefined) env[k] = v;
  }
  // Packaged desktop: invoke-once is a self-contained esbuild bundle
  // (invoke-once.mjs) → run with plain `node`, no tsx, no dep tree. Dev: run
  // the `.ts` via `node <tsx-cli> <invoke-once.ts>` (avoids npx's CWD-walk in
  // user project dirs). invokeOnceBin() returns the .mjs when it's bundled.
  const bin = invokeOnceBin();
  const args = bin.endsWith('.mjs') ? [bin] : [tsxBin(), bin];
  // Resolve `node` to an ABSOLUTE path (and pin an augmented PATH onto the child
  // env) instead of spawning the bare `'node'` basename. The operator sidecar is
  // launched (Tauri bg-host / systemd dev unit) with a minimal PATH that often
  // OMITS the dir where `node` lives, so `spawn('node')` throws ENOENT and wedges
  // every invoke-driven routine — git-sync + deploys froze ~10h on 2026-06-20
  // from exactly this (a restart does NOT fix it; the PATH gap recurs).
  //
  // We deliberately do NOT spawn `process.execPath` directly: on the node bg-host
  // it equals node, but the operator also runs INSIDE the packaged desktop (the
  // Tauri embedder boots `node serve.mjs`, and that operator spawns harness
  // invokes too) where execPath can be a non-node wrapper binary — spawning it
  // would mis-launch. resolveBin keeps the command a real `node` in EVERY runtime
  // (bg-host, dev, packaged), falling back to bare `node` only when none is found
  // (a clear ENOENT, not a silent mis-spawn). augmentedSpawnPath = the running
  // runtime's own dir + well-known node locations; pinning it onto env.PATH also
  // protects the child's own downstream basename spawns. Same helpers + discipline
  // as plugin-spawn-impl.ts, the codebase's fix for this exact ENOENT class.
  const spawnPath = augmentedSpawnPath();
  env.PATH = spawnPath;
  return { command: resolveBin('node', spawnPath), args, env };
}
