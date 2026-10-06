/**
 * `invoke <role> [extras...]` — spawn the agent CLI (default `omp -p`,
 * or whatever $AGENT_CMD/$CLAUDE resolves to) with the assembled prompt,
 * capturing three outputs:
 *
 *   <logDir>/<runId>.jsonl  — raw stream-json events (UI tails this)
 *   <logDir>/<runId>.out    — the final result text (orchestrator parses this)
 *   <logDir>/<runId>.err    — stderr (logged on non-zero exit)
 *
 * Mirrors bash run.sh's invoke() function. Keeps the agent CLI as a child
 * process specifically so users on Claude Max subscriptions continue to
 * authenticate via Claude Code's CLI session (omp routes via Meridian's
 * Claude Code SDK; claude-code uses its own session) — the direct-SDK
 * route would lose that capability.
 */
import { spawn } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { codexHomeForSessionKey, sessionClaudeConfigDir, sessionMcpDir } from './session-launch-dirs';
import { harnessProfile, harnessSupports } from './harness-profile';
import { readFleetClaudeToken } from './fleet-claude-token';
import { configGet } from './config';
import {
  readEffectiveConfig,
  loadHarnessAcceptanceKind,
  loadHarnessLexicon,
  loadHarnessBlueprintPromptContext,
} from './effective-config';
import { buildPrompt } from './prompt-build';
import { fetchSubstrateContext } from './tiered-context';
import { resolvePromptFiles, resolveReplacementSystemPrompt } from './prompt-resolve';
import { extractFeatureId, makeRunId } from './run-id';
import { assertNoUnboundAcceptedOperation } from './blueprint-operation-invoke-guard';
import { harnessSlug as harnessSlugFromProjectDir } from './state';
import {
  buildSpawnMcpConfig as _buildSpawnMcpConfig, // eslint-disable-line @typescript-eslint/no-unused-vars
  extractChunkId,
  restoreSpawnMcp,
  writeSignedSpawnMcp,
  writeSignedSpawnCodexHome,
  writeSpawnOmpHome,
  writeSpawnClaudeConfig,
  isLocalOmpModel,
  ompRemoteCompactionEndpoint,
  writeOmpCompactionOverlay,
  resolveMcpConfigPlacement,
  type SpawnMcpHandle,
  type SpawnCodexHomeHandle,
  type SpawnCodexContextConfig,
  type SpawnOmpHomeHandle,
  type SpawnOmpConfigOverlayHandle,
  type SpawnClaudeConfigHandle,
} from './spawn-mcp';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentBackend, HarnessConfig, InvokeResult } from './types';
import {
  claudeModelFlagArgs,
  resolveAgentBackend,
  normalizeModelForBackend,
  resolveCodexModel,
} from './env';
import { capabilityPolicyFlags } from './managed-capability-policy';
import { hasExplicitDisallowedTools } from './native-scheduler-deny';
import { NO_SUBAGENT_TOOLS_DENY } from './no-subagent-deny';
import { ROLE_MODEL_DEFAULTS } from './role-models';
import { workspaceHomeDir } from './workspace';

/**
 * Postgres client interface the orchestrator uses for PG-canonical state.
 * Kept as a structural type so callers can pass any postgres-js Sql<{}>
 * instance (or a test double) without importing `postgres` here. When
 * undefined, the orchestrator uses the in-memory feature store
 * (`state-memory.ts`) — fine for tests and CLI standalone mode.
 * Production always wires a real PG client.
 */
export interface OrchestratorPg {
  // postgres-js tagged-template signature: pg`SELECT ...` or pg<Row[]>`SELECT ...`.
  // The optional row generic mirrors postgres-js's own `sql<T>\`\`` so call sites can type
  // their result set inline; it DEFAULTS to any[], so existing untyped `pg\`\`` callers are
  // unchanged. (Restores the typing the call sites assumed — the prior signature took no type
  // arg, so every `pg<Row[]>\`\`` errored TS2558 "Expected 0 type arguments, but got 1".)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  <T = any[]>(template: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/**
 * Serialize a JS value bound for a jsonb column. postgres-js JSON-encodes a
 * value passed to a jsonb column, so `${JSON.stringify(x)}` DOUBLE-encodes it —
 * the array/object lands as a jsonb STRING scalar and never round-trips (and a
 * `::jsonb` cast does NOT fix it; verified). The correct form is the postgres-js
 * `sql.json()` helper. This wrapper uses it when present (a real client) and
 * falls back to the raw value for test doubles (makeMockPg) that don't implement
 * `.json` — so unit mocks observe the raw value, production stores real jsonb.
 */
export function pgJson(pg: OrchestratorPg, value: unknown): unknown {
  const j = (pg as { json?: (v: unknown) => unknown }).json;
  return typeof j === 'function' ? j(value) : value;
}

export interface InvokeContext {
  /** HARNESS_DIR — root of the @papercusp/harness install. */
  harnessDir: string;
  /** PROJECT_DIR — the user's project. */
  projectDir: string;
  /** STATE_DIR — usually `<projectDir>/.papercusp`. */
  stateDir: string;
  /** LOG_DIR — usually `<stateDir>/logs`. */
  logDir: string;
  /** Resolved phase from config.json (defaulted to "staging"). */
  phase: string;
  /** Agent invocation template. e.g. `omp -p`, `claude -p --model sonnet`, or any wrapper.
      Resolved from $AGENT_CMD ?? $CLAUDE; default `omp -p`. */
  claudeCmd: string;
  /**
   * Agent backend driving the spawn. Selects the structured-output flag
   * set + the result parser. Defaults to inferring from `claudeCmd`
   * (omp/pi binary → 'omp', otherwise 'claude-code').
   */
  agentBackend?: AgentBackend;
  /**
   * Operator-owned in-process execution port. The orchestrator defines only
   * this structural seam; operator-core injects the implementation so the
   * dependency remains operator -> orchestrator. Presence alone does not
   * select it: aiBackend.{default,roles.<role>}.engine must be `loop`.
   */
  ownedLoop?: OwnedLoopInvokePort;
  /** Optional override for the dept slug (otherwise read from config.json). */
  dept?: string;
  /**
   * Function used to resolve a worktree path for a feature, if branchIso +
   * worktrees are enabled. Returns null/empty when no override applies.
   * Pluggable so the worktree subsystem (Stage 3) can be ported later
   * independently.
   */
  worktreePathFor?: (featureId: string) => string | null;
  /** Logger instance. */
  log: (message: string) => void;
  /** Override Date.now / shell time for deterministic tests. */
  nowSeconds?: () => number;
  /**
   * PG client for the workspace's Postgres database. Phase 1+ migrated
   * features, lanes, escalation, sentinels, dispatches, and checkpoints
   * onto Postgres; PG is canonical at runtime. When undefined (tests,
   * CLI standalone), the orchestrator uses the in-memory feature store
   * — features.json is no longer a supported backend. Operator wires
   * this up via `getOrgPg()`; CLI mode bootstraps its own connection.
   */
  pg?: OrchestratorPg;
  /**
   * Workspace ID for RLS scoping. Required when `pg` is set. Resolved
   * once at orchestrator startup from `~/.papercusp-workspaces/registry.json`
   * (the only legitimate pre-DB filesystem read).
   */
  workspaceId?: string;
  /**
   * Extra env vars merged into every spawned agent's process env.
   * Resolved once at orchestrator startup from PG (Migration 047 —
   * search-provider keys); attached to ctx so all `invoke()` call
   * sites pick them up without per-site plumbing.
   */
  extraSpawnEnv?: Record<string, string>;
  /**
   * Which execution path is driving this context — the operator-hosted
   * `worker:chunk-loop` op sets `'op'`; the subprocess `invoke-once` worker path
   * leaves it undefined (⇒ treated as `'subprocess'`). Used ONLY to label the
   * worker-chunk-loop outcome metrics (worker-chunk-loop-operator-hosted P-020) so the
   * dark-launch parity diff can split completion-rate / outcome-distribution by path.
   */
  executionPath?: 'subprocess' | 'op';
}

/** One headless owned-loop turn, expressed without operator-core types. */
export interface OwnedLoopInvokeRequest {
  role: string;
  prompt: string;
  model: string;
  runId: string;
  featureId: string | null;
  /** Quota/telemetry window carried by the matching subprocess MCP envelope. */
  chunkId: string | null;
  workspaceId: string;
  harnessSlug: string;
  projectDir: string;
  stateDir: string;
  cwd: string;
  signal?: AbortSignal;
  /** Emit one JSON-serializable native LoopEvent wire object. */
  emit(event: unknown): void;
}

export interface OwnedLoopInvokeOutcome {
  exitCode: number;
  stderr?: string;
}

export interface OwnedLoopInvokePort {
  invoke(request: OwnedLoopInvokeRequest): Promise<OwnedLoopInvokeOutcome>;
}

/** What the spawn step actually returns (richer than the public InvokeResult). */
interface SpawnOutcome {
  exitCode: number;
  durationMs: number;
}

/** Split `claudeCmd` into argv. Honors simple quoting like bash IFS would. */
export function splitCommand(cmd: string): string[] {
  // The bash invocation does `$CLAUDE $extra_flags` — unquoted, so it's just
  // whitespace-split. Mirror that.
  return cmd.split(/\s+/).filter(Boolean);
}

/**
 * WI-3302 fix. `runChild` (orchestrator-runner.ts) watches invoke.ts's OWN
 * process.stdout/stderr `data` events to stamp `spawned_agents.last_output_at`
 * (via `onOutputActivity`), but invoke.ts's inner agent-CLI child's stdout/stderr
 * chunks were only ever forwarded to the chunk-bus/PG — never echoed back onto
 * invoke.ts's own streams — so the outer process saw zero activity for the
 * entire run and `last_output_at` stayed null (0/1553 sampled). The fix echoes a
 * tiny marker to invoke.ts's own `process.stderr` whenever the inner child
 * produces real output, throttled well under `SPAWN_HEARTBEAT_INTERVAL_MS` (60s,
 * spawn-reclaim.ts) so the heartbeat tick almost always has a fresh timestamp.
 *
 * Pure throttle decision, extracted for unit testing without spawning anything:
 * given the last echo time (`null` = never echoed yet) and now, returns the new
 * `lastEchoAt` to store if an echo should fire, or `null` if still within the
 * throttle window (an explicit `null` sentinel rather than `0`, so "never
 * echoed" always fires regardless of what epoch/clock the caller uses).
 *
 * EI-16502: this marker line is echoed to the OUTER process's stderr, which is
 * the same stderr the invoke-result body reports back to the caller as
 * `b.stderr` for no-turn diagnosis (invoke-outcome.ts). A burst-failed spawn
 * whose child never produced any real output (or died before anything else
 * hit stderr) ends up with `stderr` consisting ENTIRELY of repeated marker
 * lines — which (a) defeats the capacity_shed fingerprint's `stderr === ''`
 * check (silently forcing a genuine capacity-shed death to classify as the
 * generic infra_loss instead) and (b) buries any real diagnostic under noise
 * in the persisted error_message. Exported so invoke-outcome.ts can strip it
 * before judging/persisting — see `stripActivityHeartbeat` there.
 */
export const OUTER_ACTIVITY_ECHO_MARKER = '[papercusp:activity]';
export const OUTER_ACTIVITY_ECHO_THROTTLE_MS = 15_000;
export function nextOuterActivityEchoAt(
  lastEchoAt: number | null,
  now: number,
  throttleMs: number = OUTER_ACTIVITY_ECHO_THROTTLE_MS,
): number | null {
  if (lastEchoAt === null) return now;
  return now - lastEchoAt < throttleMs ? null : now;
}

/**
 * Per-hive local-tier blueprint roots from the spawn extras
 * (domain-generic-hive-architecture-2026-06-18 P-012/P-014/D-012). The SPAWNER
 * (operator-core, which has the hive + PG context) materializes the hive's federated
 * `promptOverride.*` into a local-tier blueprint tree and passes its root via a
 * `BLUEPRINT_LOCAL_ROOT=<path>` extra (':'-separated for multiple tiers, most-specific
 * first). The tier-aware prompt resolver (prompt-resolve P-014) then picks a hive's
 * customized role prompt / overlay over the built-in. Absent ⇒ [] ⇒ built-in-only
 * resolution, byte-identical to before. invoke.ts only CONSUMES this (it cannot import
 * operator-core's materializer — the dependency runs the other way).
 */
export function parseBlueprintLocalRoots(extras: readonly string[]): string[] {
  const out: string[] = [];
  for (const e of extras) {
    if (!e.startsWith('BLUEPRINT_LOCAL_ROOT=')) continue;
    for (const p of e.slice('BLUEPRINT_LOCAL_ROOT='.length).split(':')) {
      const t = p.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/** Read promptOverrides.<role> from config.json. Mirrors the python helper. */
export function resolvePromptOverride(
  cfg: HarnessConfig,
  stateDir: string,
  role: string,
): string {
  const overrides = (cfg.promptOverrides as Record<string, string> | undefined) ?? {};
  const val = overrides[role];
  if (!val) return '';

  // Absolute path
  if (val.startsWith('/')) {
    if (existsSync(val)) {
      try { return readFileSync(val, 'utf8'); } catch { return ''; }
    }
    return '';
  }

  // Relative path — resolve from stateDir
  if (val.startsWith('./') || val.endsWith('.md') || val.endsWith('.txt')) {
    const p = join(stateDir, val.replace(/^\.\//, ''));
    if (existsSync(p)) {
      try { return readFileSync(p, 'utf8'); } catch { return ''; }
    }
    return '';
  }

  // Inline string
  return val;
}

/**
 * Store-aware per-role prompt override (Phase 1b read-side cutover, D-7).
 * Prefers the workspace-owned PG store
 * (`harness_shared.harness_prompt_overrides` keyed by workspace_id, harness_slug,
 * role) when a `pg` client + workspace + slug are available; otherwise — and on
 * ANY failure (no pg, missing table, query error, empty) — falls back to the
 * file/config.json `resolvePromptOverride` above. So this is regression-safe:
 * an empty/absent store, or a PG hiccup, yields exactly today's behavior. The
 * try/catch makes a store problem inert, never a spawn-breaker.
 */
export async function resolvePromptOverrideWithStore(
  cfg: HarnessConfig,
  stateDir: string,
  role: string,
  opts: { pg?: OrchestratorPg; workspaceId?: string; harnessSlug?: string },
): Promise<string> {
  const { pg, workspaceId, harnessSlug } = opts;
  if (pg && workspaceId && harnessSlug) {
    try {
      const rows = await pg`
        SELECT prompt_md FROM harness_shared.harness_prompt_overrides
         WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND role = ${role}
         LIMIT 1`;
      const md = rows?.[0]?.prompt_md;
      if (typeof md === 'string' && md.length > 0) return md;
    } catch {
      /* table absent / query error → fall through to the file-based resolver */
    }
  }
  return resolvePromptOverride(cfg, stateDir, role);
}

/**
 * Resolve the operator app's prompts directory. Walks up from the
 * orchestrator's cwd looking for `apps/operator/prompts`; honors the
 * `PAPERCUSP_OPERATOR_PROMPTS_DIR` env override.
 *
 * Returns `null` when not found — caller falls through to empty
 * playbook (no behavior change).
 */
export function resolveOperatorPromptsDir(): string | null {
  const envOverride = process.env.PAPERCUSP_OPERATOR_PROMPTS_DIR;
  if (envOverride && existsSync(envOverride)) return envOverride;
  // Walk up from cwd; stop at filesystem root.
  let dir = process.cwd();
  for (let i = 0; i < 12; i += 1) {
    const candidate = `${dir}/apps/operator/prompts`;
    if (existsSync(candidate)) return candidate;
    const parent = dir.replace(/\/[^/]+$/, '');
    if (parent === dir || parent === '') break;
    dir = parent;
  }
  return null;
}

/**
 * Locate apps/operator-docs/src/content/docs/agents/ for shared cross-role guides
 * (e.g. finding-context.mdx). Honors the
 * `PAPERCUSP_OPERATOR_DOCS_AGENTS_DIR` env override.
 *
 * Returns `null` when not found — caller falls through to empty
 * sharedGuides array (no behavior change).
 */
export function resolveOperatorDocsAgentsDir(): string | null {
  const envOverride = process.env.PAPERCUSP_OPERATOR_DOCS_AGENTS_DIR;
  if (envOverride && existsSync(envOverride)) return envOverride;
  let dir = process.cwd();
  for (let i = 0; i < 12; i += 1) {
    const candidate = `${dir}/apps/operator-docs/src/content/docs/agents`;
    if (existsSync(candidate)) return candidate;
    const parent = dir.replace(/\/[^/]+$/, '');
    if (parent === dir || parent === '') break;
    dir = parent;
  }
  return null;
}

/** Strip a leading YAML frontmatter block (--- ... ---) from MDX text. */
export function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return raw;
  // Advance past the closing '---' and the newline after it.
  let i = end + 4;
  if (raw[i] === '\n') i += 1;
  return raw.slice(i);
}

/** Per-role timeout from config.json (in seconds). 0 = no timeout. */
export function resolveTimeout(cfg: HarnessConfig, role: string): number {
  const t = configGet<unknown>(cfg, `timeouts.${role}`, 0);
  if (typeof t === 'number' && t > 0 && Number.isFinite(t)) return Math.floor(t);
  return 0;
}

/** Per-role model resolution. The per-spawn `PAPERCUSP_SPAWN_MODEL` env (an
    explicit escalation for THIS one child) wins over everything; then
    per-harness `.papercusp/config.json` wins over the user-level
    `AGENT_MODELS` env var (which the operator's /settings/agent page writes),
    which in turn wins over the committed `ROLE_MODEL_DEFAULTS` floor. Empty
    string = use the agent CLI's default. */
export function resolveModel(cfg: HarnessConfig, role: string): string {
  // Per-spawn escalation (queen-model-tier-selection-2026-06-11 P-001): an
  // explicit spec for THIS one child — cup:spawn's model/tier arg, set only
  // in the spawned child's env by spawnAgentInHarness (extraEnv), never
  // globally. Outranks even the harness config: an explicit per-task pick is
  // more specific than any standing per-role pin. Usually already applied as
  // `--model` on AGENT_CMD by buildInvokeOnce; this consult covers the
  // aiBackend agentCmd-swap path where that command-level append is replaced.
  const perSpawn = process.env.PAPERCUSP_SPAWN_MODEL;
  if (perSpawn && perSpawn.trim()) return perSpawn.trim();
  // aiBackend role override wins, then aiBackend default, then legacy models.<role>.
  const fromAiRole = configGet<string>(cfg, `aiBackend.roles.${role}.model`, '');
  if (fromAiRole) return fromAiRole;
  const fromAiDefault = configGet<string>(cfg, `aiBackend.default.model`, '');
  if (fromAiDefault) return fromAiDefault;
  const fromConfig = configGet<string>(cfg, `models.${role}`, '');
  if (fromConfig) return fromConfig;
  const envJson = process.env.AGENT_MODELS;
  if (envJson) {
    try {
      const map = JSON.parse(envJson);
      if (map && typeof map === 'object' && !Array.isArray(map)) {
        const v = (map as Record<string, unknown>)[role];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    } catch { /* malformed AGENT_MODELS — silently ignore */ }
  }
  // Committed default floor (EI-7) — applies only when nothing above set a
  // model, so a load-bearing role (release-manager) can't silently downgrade
  // to the CLI default on a host without AGENT_MODELS.
  return ROLE_MODEL_DEFAULTS[role] ?? '';
}

/** Normalize explicit model flags that were already present on the agent command.
 * The usual model path goes through `resolveModel` + `normalizeModelForBackend`,
 * but a command like `codex exec --model chatgpt:5.5` used to bypass that path
 * because invoke() saw the model flag and did not append one. */
export function normalizeExplicitModelFlagsForBackend(argv: string[], backend: AgentBackend): string[] {
  if (backend === 'claude-code') return splitClaudeExplicitModelEffort(argv);
  if (backend !== 'codex') return [...argv];
  const out = [...argv];
  for (let i = 0; i < out.length; i += 1) {
    const arg = out[i] ?? '';
    if (arg === '--model' || arg === '-m') {
      const next = out[i + 1];
      if (next) out[i + 1] = normalizeModelForBackend(next, backend);
      i += 1;
      continue;
    }
    const eq = /^(--model=|-m=)(.+)$/.exec(arg);
    if (eq) out[i] = `${eq[1]}${normalizeModelForBackend(eq[2], backend)}`;
  }
  return out;
}

/** claude-code half of {@link normalizeExplicitModelFlagsForBackend} (WI-10006244): an
 *  explicit `--model <m>:<effort>` / `--model=<m>:<effort>` on the agent command becomes
 *  `--model <m> --effort <level>` (Opus 5 `xhigh` -> `max`), because claude drops a
 *  suffixed effort. An explicit `--effort` already on the command wins, so only the
 *  model is normalized then. Specs without an effort suffix pass through unchanged. */
function splitClaudeExplicitModelEffort(argv: readonly string[]): string[] {
  const hasEffort = argv.some((a) => a === '--effort' || a.startsWith('--effort='));
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    let spec: string | undefined;
    if (arg === '--model' && i + 1 < argv.length) {
      spec = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--model=')) {
      spec = arg.slice('--model='.length);
    }
    if (spec === undefined) {
      out.push(arg);
      continue;
    }
    const [, model = spec, ...rest] = claudeModelFlagArgs(spec);
    out.push('--model', model);
    if (!hasEffort) out.push(...rest);
  }
  return out;
}

function explicitModelFromArgv(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--model' || arg === '-m') return argv[i + 1] ?? '';
    const eq = /^(?:--model=|-m=)(.+)$/.exec(arg);
    if (eq) return eq[1];
  }
  return '';
}

/** Remove any explicit `--model <v>` / `-m <v>` / `--model=<v>` from an argv, in place.
 *  Used to force the OMP gateway provider selector (`papercusp-gateway/<model>`) over a
 *  role/AGENT_CMD model — a built-in id resolves to a cloud gateway BEFORE a models.yml
 *  override applies, so the gateway selector must be the ONLY `--model` (P-006/D-006/D-008). */
export function stripExplicitModelFlags(argv: string[]): void {
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    const arg = argv[i] ?? '';
    if (arg === '--model' || arg === '-m') {
      argv.splice(i, 2);
    } else if (/^(?:--model=|-m=)/.test(arg)) {
      argv.splice(i, 1);
    }
  }
}

/**
 * Resolve the agent command + extra args for a role, layering:
 *   1. config.aiBackend.roles[role]      (most specific)
 *   2. config.aiBackend.default          (harness-wide override)
 *   3. fallbackCmd                       (process env: AGENT_CMD/CLAUDE)
 *
 * Returns the effective agent command and any role/default extraArgs to
 * append (in order: default.extraArgs, then role.extraArgs). Model is
 * still resolved via {@link resolveModel} for back-compat with the
 * existing `models.<role>` config and AGENT_MODELS env.
 *
 * Storing secrets here is NOT supported — values land in plaintext
 * config.json. For secrets, use the encrypted-credentials store.
 */
export function resolveAgentForRole(
  cfg: HarnessConfig,
  role: string,
  fallbackCmd: string,
): { agentCmd: string; extraArgs: string[] } {
  const ai = (cfg.aiBackend as
    | { default?: { agentCmd?: string; model?: string; extraArgs?: string[] };
        roles?: Record<string, { agentCmd?: string; model?: string; extraArgs?: string[] }>; }
    | undefined) ?? {};
  const def = ai.default ?? {};
  const rol = ai.roles?.[role] ?? {};

  const agentCmd =
    (rol.agentCmd && rol.agentCmd.trim()) ||
    (def.agentCmd && def.agentCmd.trim()) ||
    fallbackCmd;

  const extraArgs: string[] = [];
  if (Array.isArray(def.extraArgs)) extraArgs.push(...def.extraArgs.filter((s) => typeof s === 'string'));
  if (Array.isArray(rol.extraArgs)) extraArgs.push(...rol.extraArgs.filter((s) => typeof s === 'string'));

  return { agentCmd, extraArgs };
}

/** Resolve the execution ENGINE independently of the subprocess backend.
 * Defaults to the existing subprocess path; a role override beats the
 * harness-wide default. */
export function resolveAgentExecutionEngine(
  cfg: HarnessConfig,
  role: string,
): 'subprocess' | 'loop' {
  const ai = cfg.aiBackend as
    | { default?: { engine?: unknown }; roles?: Record<string, { engine?: unknown }> }
    | undefined;
  const value = ai?.roles?.[role]?.engine ?? ai?.default?.engine;
  if (value === undefined) return 'subprocess';
  if (value === 'subprocess' || value === 'loop') return value;
  throw new Error(
    `invoke: invalid aiBackend engine for role=${role}: ${JSON.stringify(value)} (expected subprocess|loop)`,
  );
}

/**
 * What kind of structured stream the spawned agent is emitting (or `none` for
 * plain-text / passthrough commands). Drives both the extra flag set we
 * append AND the result-extraction parser.
 */
export type StreamFormat = 'claude-stream-json' | 'omp-json' | 'codex-json' | 'loop-ndjson' | 'none';

/**
 * Pick the structured-output flag set for a given backend, unless the
 * caller's command already specifies one (so manual overrides are
 * preserved). Returns `'none'` when the command is bare bash or similar
 * and we shouldn't inject anything.
 */
export function selectStreamFormat(
  agentBackend: AgentBackend,
  agentCmd: string,
): StreamFormat {
  const argv = splitCommand(agentCmd);
  const cmd = agentCmd.toLowerCase();

  if (agentBackend === 'omp') {
    // omp/pi-coding-agent uses `--mode json` for structured streaming.
    if (cmd.includes('--mode ')) return 'none';   // user picked their own mode
    const mentionsOmp = argv.some((a) => /(?:^|\/)(omp|pi)$/.test(a));
    return mentionsOmp ? 'omp-json' : 'none';
  }

  if (agentBackend === 'codex') {
    // codex CLI: `codex exec --json` emits JSONL events. A bare `codex exec`
    // remains operator-managed: we still append --json plus the MCP-safe
    // approval bypass. Only a command that already supplies --json is treated
    // as fully user-driven for structured-stream flags.
    if (/(?:^|\s)--json(?:\s|$)/.test(cmd)) return 'none';
    const mentionsCodex = argv.some((a) => /(?:^|\/)codex$/.test(a));
    return mentionsCodex ? 'codex-json' : 'none';
  }

  // claude-code path (default).
  if (cmd.includes('stream-json')) return 'none';
  const mentionsClaude = argv.some((a) => a.includes('claude'));
  return mentionsClaude ? 'claude-stream-json' : 'none';
}

/**
 * Extra CLI flags to append for structured streaming. Decoupled from
 * `selectStreamFormat` so callers can log/test the flag list directly.
 */
export function streamFormatFlags(fmt: StreamFormat): string[] {
  switch (fmt) {
    case 'claude-stream-json':
      return ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    case 'omp-json':
      return ['--mode', 'json', '--no-session'];
    case 'codex-json':
      // `codex exec --json` → JSONL events. `--skip-git-repo-check` lets it run
      // in non-repo cwds; `--ephemeral` keeps no rollout on disk. The sandbox
      // policy (`-s …`) is decided separately by codexSandboxArgs (flag-gated),
      // appended to extraFlags BEFORE the `-` stdin positional. Model (`-m`),
      // the prompt stdin `-`, and CODEX_HOME/MCP are wired in the spawn path.
      return ['exec', '--json', '--skip-git-repo-check', '--ephemeral'];
    case 'loop-ndjson':
      // In-process owned-loop events need no CLI flags.
      return [];
    case 'none':
      return [];
  }
}

/**
 * Small, persisted stream-quality summary used by the owned-loop worker parity
 * gate (own-tui-full-divorce-2026-08-24 P-011). The raw JSONL remains canonical;
 * this is the bounded read model appended to papercusp.run_meta so the gate does
 * not have to pull or repeatedly parse multi-megabyte transcripts.
 */
export interface InvocationStreamSummary {
  schemaVersion: 'invocation-stream-summary-v1';
  format: StreamFormat;
  jsonLines: number;
  malformedLines: number;
  terminalEvents: number;
  toolCalls: number;
  toolResults: number;
  finalTextChars: number;
  ok: boolean;
  issues: string[];
}

/**
 * OMP reports provider failures inside its otherwise-terminal JSON stream. A
 * provider/auth failure can therefore leave the CLI process with exit code 0
 * even though the invocation did not produce an assistant result. Keep this
 * detector scoped to OMP's message-bearing event shapes so an unrelated
 * `stopReason` in a tool payload cannot turn a successful invocation red.
 */
export function hasOmpTerminalProviderError(source: string, format: StreamFormat): boolean {
  if (format !== 'omp-json') return false;

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const isErrorMessage = (value: unknown): boolean =>
    isRecord(value) && value.stopReason === 'error';

  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      event = parsed;
    } catch {
      continue;
    }

    const assistantMessageEvent = isRecord(event.assistantMessageEvent)
      ? event.assistantMessageEvent
      : null;
    const messageCandidates: unknown[] = [
      event.message,
      assistantMessageEvent,
      assistantMessageEvent?.message,
      ...(Array.isArray(event.messages) ? event.messages : []),
    ];
    if (messageCandidates.some(isErrorMessage)) return true;
  }
  return false;
}

/** Map a structured provider failure onto the process-level result contract. */
export function resolveInvocationExitCode(
  exitCode: number,
  source: string,
  format: StreamFormat,
): number {
  if (exitCode !== 0) return exitCode;
  return hasOmpTerminalProviderError(source, format) ? 1 : exitCode;
}

export function summarizeInvocationStream(
  source: string,
  format: StreamFormat,
  finalText: string,
): InvocationStreamSummary {
  let jsonLines = 0;
  let malformedLines = 0;
  let terminalEvents = 0;
  let toolCalls = 0;
  let toolResults = 0;

  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
      jsonLines += 1;
    } catch {
      malformedLines += 1;
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;

    if (
      (format === 'loop-ndjson' && obj.type === 'done') ||
      (format === 'omp-json' && obj.type === 'agent_end') ||
      (format === 'claude-stream-json' && obj.type === 'result') ||
      (format === 'codex-json' && obj.type === 'turn.completed')
    ) {
      terminalEvents += 1;
    }
    if (format === 'loop-ndjson' && obj.type === 'tool_call') toolCalls += 1;
    if (format === 'loop-ndjson' && obj.type === 'tool_result') toolResults += 1;
  }

  const issues: string[] = [];
  if (format === 'none') issues.push('unstructured stream format');
  if (malformedLines > 0) issues.push(`${malformedLines} malformed JSONL line(s)`);
  if (terminalEvents !== 1) issues.push(`expected exactly 1 terminal event, observed ${terminalEvents}`);
  if (finalText.trim().length === 0) issues.push('empty final assistant text');
  if (hasOmpTerminalProviderError(source, format)) {
    issues.push('terminal provider error');
  }
  if (format === 'loop-ndjson' && toolCalls !== toolResults) {
    issues.push(`unbalanced native tool events: ${toolCalls} call(s), ${toolResults} result(s)`);
  }

  return {
    schemaVersion: 'invocation-stream-summary-v1',
    format,
    jsonLines,
    malformedLines,
    terminalEvents,
    toolCalls,
    toolResults,
    finalTextChars: finalText.length,
    ok: issues.length === 0,
    issues,
  };
}

/** Stable pairing key for P-011. An inline canary prompt is hashed BEFORE
 * buildPrompt adds the per-run id/runtime tail, so the OMP and loop arms pair.
 * Ordinary worker runs fall back to the exact assembled prompt. */
export function workerParityPromptHash(assembledPrompt: string, inlinePrompt?: string): string {
  return createHash('sha256').update(inlinePrompt ?? assembledPrompt).digest('hex');
}

/**
 * The closed allow-list a headless fleet agent runs under
 * (`--permission-mode dontAsk`). `mcp__papercusp` is a *server wildcard*:
 * the per-spawn signed `.mcp.json` is already role-scoped server-side —
 * surface-filtered by `listMcpProjections(role)` AND denied at call-time by
 * the dispatch stack's `role-allowlist` step — so the wildcard grants
 * exactly that role's MCP surface without us enumerating (or drifting from)
 * it. The rest is the safe built-in dev kit every pipeline role needs.
 *
 * `dontAsk` denies a *gated* tool that isn't allow-listed (verified vs
 * claude 2.1.158: an un-allow-listed gated tool — arbitrary `Bash`, file
 * writes, `Workflow`, a non-role MCP call — is denied, the model is told,
 * and it continues; no hang). But gating is NOT uniform: claude exempts a
 * class of session-local / "meta" tools from the allow-list entirely, so
 * omitting them does NOT block them (verified: with this exact allow-list,
 * `CronCreate` still created a job and `EnterWorktree` still ran). Those
 * dangerous-but-exempt tools are closed via FLEET_DISALLOWED_TOOLS instead
 * — the allow-list alone is not a complete boundary. (The old setting was a
 * blanket `--permission-mode bypassPermissions`, under which everything ran.)
 */
export const FLEET_ALLOWED_TOOLS: readonly string[] = [
  'mcp__papercusp',
  'Read',
  'Edit',
  'Write',
  'Bash',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
];

export const QUEEN_MCP_TOOL_NAMES: readonly string[] = [
  'accounts:status',
  // code-run-self-state-adoption-2026-07-03 P-001: the BATCHING surface. The Queen is the
  // per-wake fan-out heavyweight (survey + assignments + status every cycle) yet code:run was
  // absent from her kit — the audit found 0 fleet adoption because the tool was unreachable,
  // while the inline nudge kept advising it. recipes:candidates backs her recipe-graduation
  // duty (code-recipes-2026-06-21). tools:find/invoke = the reachability hatch the CORE spine
  // already carries (a kit omission must degrade to discovery, not a dead end).
  'code:run',
  'code:tools',
  'recipes:search',
  'recipes:run',
  'recipes:candidates',
  'tools:find',
  'tools:invoke',
  // capability:* — gated write/exec/fetch/read surface (parity with the bee kit; the queen
  // ∈ FLEET_CAPABILITY_ROLES, so under the B-18 cutover its natives are stripped too). The
  // capability ENVELOPE remains the real per-role boundary. Pinned by cutover-role-parity.test.ts.
  'capability:bash',
  'capability:edit',
  'capability:fetch',
  'capability:git',
  'capability:read',
  'capability:write',
  'coord:ack',
  'coord:ask',
  'coord:dispatch',
  'coord:escalate',
  'coord:escalations',
  'coord:glance',
  'coord:handoff',
  'coord:orient',
  'coord:send',
  'coord:thread',
  'coord:wake',
  // The wake-GATE control pair (EI-6076): coord:glance surfaces the
  // `wake-mode-manual` / `staged-wakes-under-auto` tips to the QUEEN audience with
  // an invoke of coord:wake-mode / coord:wake-queue. The Queen already passes both
  // gates for them (COORD_ROLES + coord:write) but they were absent from her seeded
  // kit, so on the small-surface queen session they never advertised and ToolSearch
  // reloads didn't surface them — she could DETECT "wake mode is manual" via glance
  // but had no callable tool to self-recover, forcing a human blocker. Seed them so
  // every glance tip the Queen sees points at a tool she can actually invoke.
  'coord:wake-mode',
  'coord:wake-queue',
  'curation:feed',
  'dev:rate_governor_status',
  // queen-memory-hybrid L1e: the standing-facts ledger — the queen persona
  // directs facts:assert/retract for durable conclusions (prompt-referenced,
  // so they MUST be in this kit).
  'facts:assert',
  'facts:list',
  'facts:retract',
  'fleet:assignments',
  'fleet:cancel',
  'fleet:capacity',
  'fleet:drain',
  'fleet:governor',
  'fleet:place_batch',
  // (cup:spawn removed by P-059 — the verb retired with the Mug/Kettle/Cup tier,
  // so keeping it in the kit would hand the role a name that never resolves.)
  'fleet:supervise',
  'pot:declare-wake',
  'pot:get',
  'pot:get-steering',
  'pot:mug_efficiency',
  'pot:status',
  'pot:survey',
  'improvements:capture',
  'improvements:digest',
  'plans:add-decision',
  'plans:add-item',
  'plans:promote',
  'plans:search',
  'plans:set-plan-status',
  'plans:set-priority',
  'plans:set-status',
  'rubrics:get',
  'rubrics:list',
  'scheduler:running',
  'scheduler:set_claim_spec',
  'scorecards:freshness',
  'scorecards:list',
  'blender:grade-idea',
  'work_items:co_locate',
  'work_items:comment',
  'work_items:create',
  'work_items:promote',
  'work_items:release',
  'work_items:reorder',
  'work_items:set_priority',
  'work_items:set_state',
  'work_items:update',
];

export const QUEEN_ALLOWED_TOOLS: readonly string[] = [
  ...QUEEN_MCP_TOOL_NAMES.map((name) => `mcp__papercusp__${name.replace(':', '_')}`),
  'Read',
  'Glob',
  'Grep',
];

export const BEE_MCP_TOOL_NAMES: readonly string[] = [
  // capability:* — the gated write/exec/fetch/read surface. REQUIRED: under the B-18 cutover
  // (papercusp-fleet-capability-only) native Bash/Edit/Write/WebFetch are stripped
  // (FLEET_CAPABILITY_REPLACED_TOOLS), so without these in the kit a confined bee has NO write
  // surface — the autonomous-loop-canary-reliability D-002 stranding that broke the daily canary.
  // Do NOT remove; pinned by cutover-role-parity.test.ts.
  'capability:bash',
  'capability:edit',
  'capability:fetch',
  'capability:git',
  'capability:read',
  'capability:write',
  // code-run-self-state-adoption-2026-07-03 P-001: the BATCHING surface. Bees average ~19 mcp
  // calls/spawn and ~98% of bee spawns have a batchable shape, yet code:run was absent from
  // this kit (and from BEE_ALLOWED_TOOLS, which derives from it) — so fleet adoption was
  // structurally 0 while the inline nudge kept firing. tools:find/invoke = the reachability
  // hatch so future kit omissions degrade to discovery instead of a dead end.
  'code:run',
  'code:tools',
  'recipes:search',
  'recipes:run',
  'tools:find',
  'tools:invoke',
  'coord:ask',
  'coord:glance',
  'coord:inbox',
  'coord:orient',
  'coord:send',
  'coord:thread',
  'db:check_drift',
  'db:next_migration',
  'dev:service_health',
  'docs:get',
  'docs:search',
  // queen-memory-hybrid L1e: standing-facts — the bee persona directs
  // facts:assert/retract for durable repo/harness conclusions (prompt-referenced).
  'facts:assert',
  'facts:list',
  'facts:retract',
  'fleet:assignments',
  'locks:acquire_granular',
  'locks:release_granular',
  'plans:get',
  'plans:items',
  'plans:search',
  'scheduler:running',
  'work_items:claim',
  'work_items:release',
  // code-run-self-state-adoption-2026-07-03 P-001: the bee persona + the carry-note substrate
  // (su-cold-auto-mode D-004, mig 472) mandate work_items:checkpoint as the bee's "note to my
  // next self", and bees were already calling it 28×/14d via non-seeded paths — but it was
  // absent from this kit, so seeded/allowlisted bees could not comply.
  'work_items:checkpoint',
  'work_items:comment',
  'work_items:get',
  'work_items:list',
  'work_items:search',
  'work_items:set_state',
  'work_items:update',
];

export const BEE_ALLOWED_TOOLS: readonly string[] = [
  ...BEE_MCP_TOOL_NAMES.map((name) => `mcp__papercusp__${name.replace(':', '_')}`),
  'Read',
  'Edit',
  'Write',
  'Bash',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
];

/**
 * The Overwatch's scoped MCP kit. The Overwatch is a READ-heavy system-health
 * supervisor; its ONLY write surface is three verbs — `coord:send` (nudge /
 * durable hand-off — retire-work-item-mail-surface-2026-07-26 P-006: this used
 * to also carry `messages:send`, retired to `_retired/work-item-mail/`),
 * `coord:escalate` (structural issue), `improvements:capture` (observe / emit the
 * pot-coordination-health scorecard) — plus
 * `kettle:declare-wake` (its own next wake). It NEVER places work (no
 * `cup:spawn` / `fleet:place_batch` / `work_items:set_priority` — the Queen's
 * D-001 lane) and NEVER edits code (no `capability:*` — its envelope denies
 * fs-write/bash). Everything else here is a READ used to judge system health.
 *
 * Kept deliberately small: an UNSCOPED (null) surface loaded the full ~550-tool /
 * ~141k-token catalog onto the overwatch's sonnet ~200k window, so every fire died
 * with "Prompt is too long" and fell back to the synth-floor scorecard — never a
 * real 14-criterion scorecard (autonomous-loop-full-flow-reliability-2026-06-29).
 * Mirrors QUEEN_/BEE_MCP_TOOL_NAMES; wired at the spawn chokepoint (`mcpToolNames`).
 */
export const OVERWATCH_MCP_TOOL_NAMES: readonly string[] = [
  'autonomy:decide',
  'coord:ack',
  'coord:escalate',
  'coord:escalations',
  'coord:glance',
  'coord:inbox',
  'coord:orient',
  'coord:presence',
  'coord:send',
  'coord:thread',
  'coord:watermark',
  'curation:feed',
  'dev:rate_governor_status',
  'docs:get',
  'docs:search',
  'fleet:assignments',
  'pot:get',
  'pot:get-steering',
  'pot:status',
  'pot:survey',
  'improvements:capture',
  'improvements:digest',
  'notifications:recent',
  'kettle:declare-wake',
  'plans:get',
  'plans:list',
  'rubrics:get',
  'rubrics:list',
  'scorecards:freshness',
  'scorecards:list',
  'tools:find',
  'work_items:get',
  'work_items:list',
];

/**
 * Role-scoped MCP catalogs for headless invoke() children. Pipeline `worker`
 * and fleet `cup` are the same implementation role at different orchestration
 * tiers; both need the compact bee kit. Leaving worker unscoped loaded the full
 * ~550-tool catalog and made OMP reject a haiku canary at 615k prompt tokens.
 */
export function invokeMcpToolNamesForRole(role: string): readonly string[] | null {
  if (role === 'mug') return QUEEN_MCP_TOOL_NAMES;
  if (role === 'cup' || role === 'worker') return BEE_MCP_TOOL_NAMES;
  if (role === 'kettle') return OVERWATCH_MCP_TOOL_NAMES;
  return null;
}

/**
 * The UNIVERSAL core MCP tool set — the small, always-advertised catalog for omp
 * (and any small-context client) so the bootstrap + coordination + work spine is
 * callable WITHOUT the discovery/search dance. ~19 tools / ~7k tokens vs the full
 * ~551-tool / ~141k-token superuser surface (which a 32k local model cannot load
 * — tool-discovery-for-weak-models-plan-2026-06-30 WS1). Everything else is
 * reachable via `tools:find` (intent search); for omp, then activated by exact
 * name via its native `search_tool_bm25`.
 *
 * Universal (role-independent) by design: these are the spine EVERY role needs.
 * Most role-specific extras (`flags:*`, …) go through `tools:find`. The one
 * deliberate fleet exception is `fleet:launch-on-plan`: every su routing gate
 * offers the fleet route, so hiding its execution verb makes that required option
 * impossible on a trimmed client.
 */
export const CORE_MCP_TOOL_NAMES: readonly string[] = [
  // Bootstrap — one call returns assignments + backlog + inbox + plan-events + mem0.
  'coord:orient',
  'coord:declare-intent',
  // Coordinate. (coord:ack was cut in the 2026-07-05 demand-evidence rebalance — 47
  // calls/7d; a coord:send reply covers the ack. coord:ask cut 2026-07-19 by the same
  // bar: 16 calls/14d SEEDED — true rarity, not a discoverability artifact — and zero
  // tools:invoke fallback reaches; a coord:send carrying the question covers it. Both
  // stay reachable via tools:find/invoke.)
  'coord:inbox',
  'coord:send',
  'coord:glance',
  // coord:dispatch is the WORK-HANDOFF atom (assign a lane + deliver + wake + report
  // pickup); coord:send only delivers a message. It is seeded rather than left to
  // tools:find because its adoption is actively being MEASURED: the P-013 falsifier
  // (dispatch-adoption-falsifier.ts) returns `retire` on a low call rate once its
  // `reEvaluateAfter` date passes, and its stated premise is that dispatch "was seeded
  // onto the live surface
  // AND handed to agents pre-addressed ... and still was not reached for". Until
  // 2026-09-02 that first conjunct was FALSE — the verb sat only in QUEEN_MCP_TOOL_NAMES
  // (role==='mug', a retired tier), so no live session ever had it. Seeding it here is
  // what makes that verdict measure demand instead of absence; without it a zero rate
  // would retire a verb agents were never offered. coordination-spec-adoption-2026-08-03
  // P-011 (delivery half) / WI-2142095.
  'coord:dispatch',
  // Plans & work — plans:new authors an ENTIRE plan in ONE call (P-001 `body` arg), so an
  // agent never has to hunt for a create verb: the Mac-app plan-authoring fumble that
  // motivated this (create-template → get-version → set-content, plus a "plans need a
  // creation tool not just a file" mental-model gap) is the exact friction
  // cross-platform-hardening-and-agent-ergonomics-2026-07-05 P-002 removes by promoting the
  // create verb into the always-advertised spine (owner directive: "plans should be one of
  // the core tools in the trimmed list"). plans:launch stays reachable via tools:find.
  'plans:new',
  'plans:get',
  'plans:set-status',
  'plans:items',
  // plans:set-now — the plan-narration duty every plan-holding agent carries ("## Now" is
  // the status surface peers + the owner read). 467 tools:invoke fallback reaches + 807
  // direct calls in 7d — a top unmet need (2026-07-05 demand-evidence rebalance).
  'plans:set-now',
  'work_items:list',
  // work_items:create — the #1 gap of the 2026-07-05 rebalance (608 fallback reaches +
  // 1,354 direct calls across 5 roles in 7d). The discipline says "no edit without a
  // work-item" and "file blockers as WIs", but the spine carried claim/complete and NOT
  // the verb that CREATES one — every ad-hoc filing paid a tools:invoke round-trip.
  'work_items:create',
  'work_items:claim',
  // EI-6770/EI-8588: self-pull (claim_next) + read (get) + finish (complete) +
  // release are the other verbs of the canonical worker loop. Every fleet/worker
  // brief points at these, so their absence here causes "tool not available"
  // self-halts mid-drain or stranded claim handoffs.
  'work_items:claim_next',
  'work_items:get',
  'work_items:complete',
  'work_items:release',
  'work_items:set_state',
  // EI-10946 — THE INVERSE OF A SEEDED VERB MUST ALSO BE SEEDED. The 2026-07-05 rebalance
  // cut work_items:update with the rationale "set_state + comment cover the common cases"
  // — but work_items:comment was never IN the spine, so that premise was never true. The
  // result: an agent could CREATE, claim, checkpoint and CLOSE an item, but had no seeded
  // way to correct or annotate one. Observed 2026-07-13 (su-71d9f8a2): needing to retract a
  // wrong claim in an item's body, the agent's client-side tool-search reported update and
  // comment as "not found" (a trimmed surface reports a subset, and a zero-hit search is
  // indistinguishable from absence), concluded no such verb existed, and abused
  // work_items:checkpoint as an erratum channel — leaving the wrong claim in the BODY, which
  // is what every future reader and brief actually inherits.
  //
  // This is the SAME failure already fixed three times in this very list — events:await
  // (EI-9012/EI-9034), loop:end/status (EI-8597), session:request-compaction (EI-6770): a
  // seeded session whose search missed a verb concludes the capability does not exist and
  // builds a strictly-worse workaround. Demand-evidence call counts cannot arbitrate this,
  // because a tool nobody can SEE is a tool nobody calls — the metric measures the
  // discoverability bug, not the need.
  //
  // Rule going forward: never advertise the CREATE and hide the UNDO. If an agent can write
  // a durable object from the spine, it must be able to correct and annotate it from the
  // spine — otherwise the workaround IS the corruption.
  'work_items:comment',
  'work_items:update',
  // (2026-07-05 cuts, still reachable via tools:find/invoke:
  // locks:acquire_granular/release_granular — the PreToolUse hook auto-locks every
  // Edit/Write (8K+ hook acquires/week), the hand-held multi-file flow is rare + su-tier,
  // and the OMP spine had already dropped them after weak models misused them as an
  // operation-mutex.)
  // scheduler:get_next — the fleet-member feed loop: members pull claim-spec work with it
  // every drain iteration. 732 fallback reaches/7d = the second-loudest unmet need.
  'scheduler:get_next',
  // Knowledge
  'docs:search',
  'memory:search',
  'memory:remember',
  // improvements:capture — the universal "file what you notice" reflex every persona
  // mandates (observations, friction, feature proposals). 227 fallback reaches + 1,128
  // direct calls across 3 roles in 7d.
  'improvements:capture',
  // Batching + reuse (code-run-self-state-adoption-2026-07-03 P-002) — the token-frugality
  // lever every prompt base nudges toward. It was absent from the spine, so even su sessions
  // had to detour through tools:invoke, and the prose nudge's "when code:run is in your
  // toolset" self-gate read a trimmed seed as "not in my toolset" and switched itself off.
  'code:run',
  // (recipes:run was cut 2026-07-05 — 78 calls/7d from a single role; recipes:search
  // already returns the run pointer, and the run itself routes via tools:invoke.)
  'recipes:search',
  // Canonical-store reads (2026-07-19): dev:pg_query was the LOUDEST unmet need in the
  // fallback-reach ledger — 1,132 tools:invoke reaches in 14d, 2.4× the next entry —
  // and the storage policy MANDATES it for filtered/aggregate reads of PG-canonical
  // state ("query PG — don't dump-and-jq a projection"). Read-only, tiny schema.
  'dev:pg_query',
  // Agent self-state (same plan, P-002): the standing-facts ledger (upsert-by-key, scoped,
  // TTL'd, folded into orient) + the carry-note checkpoints a cold wake reads. Prompt-
  // referenced for fleet roles; in the spine so every seeded client can actually comply.
  'facts:assert',
  'facts:list',
  // EI-10946/EI-10947 — facts:retract is the ONLY exit from a standing fact, and a fact is
  // the one surface delivered VERBATIM into every future orient as BINDING context. Seeding
  // assert + list without retract meant an agent could arm that trap but not disarm it: a
  // carry-note fact ("NEXT: implement EI-10539") kept instructing every future orient to redo
  // finished work, and the agent that noticed — search reporting facts:retract as "not found"
  // — gave up on retracting it. The stale-source flag (EI-10947) now literally tells the
  // reader to call `facts:retract { key }`, so the verb it names must be callable without a
  // discovery detour. Same rule as the work-item verbs above: never seed the create and hide
  // the undo.
  'facts:retract',
  'work_items:checkpoint',
  // Engine-loop lifecycle. arm/checkpoint keep unattended sessions alive; status/end are
  // the wind-down half. EI-8597: native ToolSearch can miss loop:end/status even when the
  // catalog lists them, so seeded workers must not depend on discovery to inspect or stop
  // their own loop after the lane drains.
  'loop:arm',
  'loop:checkpoint',
  'loop:status',
  'loop:end',
  // Event-wait lifecycle (fleet-member-dx-improvements-2026-07-10 P-008, EI-9012 →
  // EI-9034): every persona/leader flow says "don't poll — events:await the key and
  // sleep", but the verbs were NOT in the spine, so a seeded/trimmed session whose
  // client-side search missed them concluded the capability didn't exist and built a
  // strictly-worse blind poll loop instead (the exact thing the bench directive
  // forbids). await = register the sleep; catalog = "what CAN I wait on" (the
  // check-before-polling step the persona mandates); cancel = retract a registered
  // await before it fires; emit = the counterpart a leader/peer fires. events:cancel
  // is seeded as the correction half of events:await (EI-21345492095209440), while
  // status stays reachable via tools:find/invoke. events:emit cut 2026-07-19: 29 calls/14d while SEEDED (true
  // rarity, not a discoverability artifact — members await; leaders/peers emit, and
  // the system fires most emits from lifecycle events) and no fallback-reach demand;
  // reachable via tools:find/invoke, natural member of a future leader-overlay seed.
  // checkpoint:await is the shared release-gate sleep primitive named by
  // checkpoint-run/trace. Seed it so trimmed Codex sessions have a direct wrapper
  // from launch; tools:find activation cannot guarantee that wrapper exists in the
  // same turn.
  'checkpoint:await',
  'events:await',
  'events:catalog',
  'events:cancel',
  // Session hygiene — EI-6770: without this in the spine, an agent nearing its
  // compaction limit has no way to compact cleanly and self-halts instead
  // ("no compaction tool available") mid-task, losing in-flight work.
  'session:request-compaction',
  // Routing-gate execution — the AUTO-off su prompt requires every client to offer
  // a fleet route. Before 2026-07-16 this verb lived only in OMP's duplicated seed,
  // so trimmed Codex/Claude sessions presented the route but had no directly callable
  // tool to execute it (the exact failure reported by the owner in a Codex session).
  // It belongs in the shared seed; client-specific drift here is the bug.
  'fleet:launch-on-plan',
  // EI-18745029375690371 (search:semantic-underuse investigation, 2026-07-27): root
  // CLAUDE.md's tool-routing table recommends "search:fulltext · search:semantic" for
  // prose recall, but NEITHER was ever in this spine — only docs:search was — so every
  // trimmed session (now the default for every client+tier) starts unable to reach
  // either without a tools:find/invoke discovery round trip. Measured over 30d:
  // docs:search calls_per_caller 2.39 vs search:fulltext 2.82 vs search:semantic 1.19
  // (near-1:1 — almost nobody who finds it comes back), and su/psu ("null"-role)
  // sessions accounted for 216/222 docs:search calls but just 1/19 search:semantic
  // calls — the gap tracks seeding, not quality (search:semantic: 0% error rate,
  // 213ms avg, and its heaviest real user — the Mug, 16/19 calls — returns to it
  // repeatedly for genuinely paraphrased queries, i.e. it works as designed for the
  // caller population that can actually reach it). tools:invoke fallback-reach demand
  // over 14d confirms the SAME asymmetry among agents who went out of their way to find
  // it anyway: search:fulltext 22 reaches/11 callers vs search:semantic 7 reaches/7
  // callers — a ~3x gap even before seeding, so seeding search:semantic too would not
  // close the remaining difference (that's its narrower by-design niche, not a bug).
  // Seed the higher-demand, cheaper half of the pair — same demand-evidence bar as
  // dev:pg_query/code:run above. search:semantic stays reachable via tools:find/invoke,
  // consistent with other deliberately-cut lower-frequency verbs in this file
  // (events:emit, recipes:run, locks:acquire_granular).
  'search:fulltext',
  // ADMITTED by P-006 of psu-seed-prompt-mandate-alignment-2026-08-09 (D-006), and this
  // RAISES NO CAP: the array was measured at 42 against a <=43 ratchet, so the slot
  // already existed. 622 tools:invoke fallback-reaches / 65 distinct callers in 14d — the
  // highest demand in the whole fallback ledger — at 4,250 B, i.e. 149.9 reaches/KB on
  // D-001's admission metric. It also discharges a MANDATORY obligation: root CLAUDE.md
  // requires a cross-lane ruling to be recorded as a plan Decision, so the one verb an
  // agent MUST call to comply was reachable only by a discovery round-trip on every
  // non-Claude client. P-003 tried to add this verb here as part of a set of three,
  // which overshot the ratchet; admitted alone, it fits.
  'plans:add-decision',
  // ADMITTED 2026-08-26 (EI-21503656260697108), raising the deliberate ratchet 44->45:
  // work_items:claimable is THE claim-floors SSOT read ("what can I actually claim") —
  // root CLAUDE.md's storage-policy table mandates it over raw status='open' (which
  // overcounts ~13x), orient/scheduler:get_next/fleet:leader-brief all point members at
  // it, yet it lived ONLY in Claude's seed (P-003): a non-Claude session calling it
  // directly got "Direct wrapper was not exposed in this session", promoted by the
  // watchdog with reproduced:true. Priced per D-001 in WIRE BYTES: 135 fallback-reaches
  // / 55 distinct callers / 14d at 2,198 B = 62.9 reach/KB — above coord:presence's own
  // admit bar (36.0).
  'work_items:claimable',
  // ADMITTED 2026-09-05 (WI-37550), raising the deliberate ratchet 47->48. This is the
  // last survivor of the P-003 trio, and the DELIBERATE budget decision the P-003 refusal
  // asked for — not another quiet append. P-003 refused to admit it as a SIDE-EFFECT of
  // another change; that refusal was about the side-effect, not the verb.
  // DEMAND, re-measured 2026-09-05 over 14d (it grew 5.3x in reaches and 7.9x in distinct
  // callers since the 124/56 reading this comment used to carry): 656 tools:invoke
  // fallback-reaches / 443 distinct callers, against 1,991 direct calls / 950 callers on
  // the clients that already have it seeded.
  // PRICED IN WIRE BYTES per D-001, by a real tools/list call, never a source scan:
  // 3,028 B => 216.6 reach/KB. That is the highest admission-time reach/KB in this whole
  // changelog (plans:add-decision 149.9, work_items:claimable 62.9, coord:presence 36.0),
  // and it is well under D-001's ">8 KB needs stated justification" bar.
  // It also discharges a MANDATORY obligation, the same shape that carried
  // plans:add-decision in: the su playbook requires mode:set on every AUTO/DRAIN/IDEATE
  // flip, because a mode honoured from directive text alone is invisible session state
  // that a compaction silently drops — so the one call an agent must make to comply cost
  // a discovery round-trip on every non-Claude client.
  // COST IS OMP/CODEX-ONLY: mode:set was already in CLAUDE_SEED_EXTRA_TOOL_NAMES, so for
  // Claude this is a RELOCATION (extras -> spine) and the Claude seed is byte-identical
  // at 64 tools. It is removed from that extras list in the same change, or the
  // "every Claude-only extra stays OUT of the weak-model OMP spine" guard fails.
  'mode:set',
  // ⚠ READ BEFORE THE NEXT ADDITION — the count is now a MEASURED-WRONG instrument, not
  // merely a suspected-wrong one. D-001 set a 256 KB wire ceiling and said crossing it
  // "requires an explicit owner decision". Measured 2026-09-05 by real tools/list:
  // this 47-entry spine was already 345,140 B (337 KB) and the Claude seed 395,879 B
  // (387 KB) — 32% and 51% OVER that ceiling, crossed silently, because the only guard
  // that runs in CI is this count. Since D-001 measured 190,885 B on 2026-08-09 the seed
  // has more than DOUBLED in bytes while this ratchet moved 43->47 (+9%). The bytes are
  // in schemas, not in this list: coord:send alone is 39,067 B — 13x the verb admitted
  // above — and work_items:complete 35,093 B and work_items:checkpoint 31,000 B each
  // inline their full nested payload schema TWICE (single shorthand + items[] batch).
  // The lever is therefore schema slimming on the whales, NOT refusing 3 KB verbs here.
  // NOTE the two guards on this array are NOT rival caps. invoke.test.ts (<=48) is a
  // RATCHET pinned to the current size, carrying the per-increment changelog above
  // (25->32->33->38->41->42->43->44->45->46->47->48) so no addition is unreviewed;
  // core-spine-inverses.test.ts (<=48) is a separate BLOAT ceiling ("a seed, not a
  // catalog"). Ratchet + ceiling is one design, not a discrepancy — do not "reconcile"
  // them into a single constant, which would destroy either the review forcing-function
  // or the backstop. They currently hold the SAME number, which makes the ceiling a
  // rubber stamp rather than a second line; re-separating them is real work, tracked
  // rather than done here (see WI-37550's completion).
  // Discovery — load anything else by intent (tools:find — WS3), or call it
  // directly without loading (tools:invoke — the universal reachability hatch,
  // dynamic-tool-surface-2026-07-01 D-003).
  'tools:find',
  'tools:invoke',
];

export const CORE_ALLOWED_TOOLS: readonly string[] = [
  ...CORE_MCP_TOOL_NAMES.map((name) => `mcp__papercusp__${name.replace(':', '_')}`),
  'Read',
  'Edit',
  'Write',
  'Bash',
  'Glob',
  'Grep',
];

/**
 * Hard denies layered on top of the allow-list. `--disallowed-tools` removes
 * a tool from the spawn ENTIRELY — it wins over the allow-list, over the
 * dontAsk exemption, and even under `bypassPermissions` (all verified vs
 * claude 2.1.158: a denied tool reports "No such tool exists in this
 * environment"). Two jobs:
 *
 * 1. **Dangerous *exempt* tools** — the automation/scheduling/spawn/remote
 *    built-ins a `claude -p` spawn carries that bypass the allow-list under
 *    dontAsk (see FLEET_ALLOWED_TOOLS). None are needed by a pipeline role;
 *    `EnterWorktree`/`ExitWorktree` would also violate the repo's
 *    one-tree/no-worktree rule, and `Workflow`/`Task`/`Agent` are uncontrolled
 *    sub-agent fan-out outside the orchestrator's spawn graph. **`Task`/`Agent`
 *    come from the shared `NO_SUBAGENT_TOOLS_DENY` (no-subagent-deny.ts) —
 *    the tool was renamed `Task`→`Agent` between claude 2.1.158 and 2.1.198,
 *    and a `Task`-only deny was verified live (2026-07-01) to be a silent
 *    no-op on the newer CLI (a spawned Agent-tool subagent still ran); both
 *    names are carried so the deny survives either CLI generation.**
 * 2. **Dangerous *commands* inside the granted `Bash`** — `Bash` is
 *    allow-listed (roles need it) and can run anything, so the highest-value,
 *    no-legit-fleet-use commands are denied here.
 *
 * Defense-in-depth, NOT airtight containment, and the code must not pretend
 * otherwise:
 *   - `git push` is *primarily* blocked by the repo's pre-push hook —
 *     command-string matching is evadable (`git -C … push`, aliases,
 *     `&& git push`). This deny is the backstop.
 *   - credential reads (the allow-listed `Read` tool reaches any path) and
 *     network egress (the allow-listed `WebFetch`) are NOT closed here;
 *     true containment of those needs a network/fs sandbox — tracked as a
 *     follow-up, not solved by a deny-list.
 *   - ⚠ **NEVER put an `mcp__*` tool in this list expecting it to be
 *     withheld.** Everything above about `--disallowed-tools` being airtight
 *     is true only for a NATIVE tool, which the client alone can run. An MCP
 *     tool is executed SERVER-side, and `tools:invoke { name, args }` — a
 *     permitted client tool — dispatches to it BY NAME. The server never sees
 *     the client's deny list, so one call re-reaches the "denied" verb. That
 *     hatch is documented behaviour (`tools:find`'s own `howToCall` tells
 *     agents to use it), not an exploit. Withholding an MCP tool needs
 *     server-side enforcement, or denying `tools:invoke` AND `tools:find` too
 *     — which removes the general reachability hatch for every tool. Note
 *     this file DOES build `mcp__` name lists elsewhere (the `mcp__papercusp`
 *     server wildcard in FLEET_ALLOWED_TOOLS, and the `':' -> '_'` role-kit
 *     mapping), so this is a realistic mistake, not a hypothetical.
 *     Second trap: a deny is OBSERVABLY IDENTICAL to a never-seeded tool
 *     (both = absent from discovery + "No such tool available"), so any deny
 *     probe without a same-server, same-tier control can record a false
 *     confirmation. Full write-up + provenance:
 *     /internal/docs/agent-insights/disallowed-tools-cannot-withhold-an-mcp-tool
 */
export const FLEET_DISALLOWED_TOOLS: readonly string[] = [
  // Dangerous built-ins that bypass the allow-list under dontAsk.
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'EnterWorktree',
  'ExitWorktree',
  'Workflow',
  ...NO_SUBAGENT_TOOLS_DENY, // 'Task' (pre-rename) + 'Agent' (current) — see no-subagent-deny.ts
  'RemoteTrigger',
  'PushNotification',
  'Monitor',
  // Dangerous commands within the (allow-listed) Bash tool.
  'Bash(sudo:*)',
  'Bash(git push:*)',
  // WI-3159 (e2e-proven 2026-07-06): deny patterns are evaluated against the
  // POST-PreToolUse-hook updatedInput, so the rtk token-filter hook's rewrite
  // (`git push …` → `rtk git push …`) silently evades the `Bash(git push:*)`
  // prefix match — the control (a non-rewritten command) was denied correctly,
  // proving pure pattern evasion. rtk is on the dev box PATH today (manual
  // vector) and any fleet rtk-hook rollout would make the evasion automatic.
  // The repo pre-push hook stays the primary enforcement; this closes the
  // concrete rtk variant of the documented command-string evadability.
  'Bash(rtk git push:*)',
];

/**
 * Roles whose prompts **explicitly forbid the `Write`/`Edit` tools** — they
 * are API/MCP-only (their output goes through the operator, not the working
 * tree). For these we drop `Edit`/`Write` from the allow-list, mechanically
 * enforcing the instruction the prompt already gives (resists a model that
 * ignores it, e.g. via prompt-injection).
 *
 * The dedicated acceptance `judge` is evidence-only: it reads the frozen
 * context and emits a scorecard, never edits implementation files.
 *
 * This is the ONLY per-role built-in tightening that's verifiably safe from a
 * prompt read: other review/gate roles (reviewer, validator, infra-reviewer,
 * …) DO write legitimate output via the `Write` tool (review files,
 * infra-contract.json), so denying it would break them.
 * NOTE it's a defense-in-depth nudge, not a hard boundary: `Bash` is still
 * granted (these roles curl/run things), so a determined spawn could write via
 * a shell redirect — closing that needs a sandbox, not an allow-list. Further
 * per-role cuts should be gated on a real fleet-spawn run, not a prompt read.
 */
export const FLEET_NO_WRITE_ROLES: ReadonlySet<string> = new Set<string>(['judge']);

/* ─── B-18 fleet cutover (agent-capability-confinement-2026-06-13 P-020/D-001) ──
 * When the cutover is ARMED (papercusp-fleet-capability-only, surfaced per-spawn
 * as PAPERCUSP_FLEET_CAPABILITY_ONLY by the operator), a confined fleet agent
 * holds NO native write/exec/fetch tools — every such capability is a
 * policy-gated `capability:*` defineTool (B-05) routed through the shared dispatch
 * (capability envelope + decision ledger). The native equivalents are dropped from
 * the allow-list AND hard-denied; the gated tools are already in the role-scoped
 * `mcp__papercusp` wildcard. DEFAULT-OFF: the owner arms it (P-023 is an owner
 * item) after capability:* ergonomics are validated on a live bee. */

/** Native tools the `capability:*` defineTools replace under the cutover — dropped
 *  from the allow-list and hard-denied for a confined role. `Bash`→capability:bash,
 *  `Edit`/`Write`→capability:edit/write, `WebFetch`→capability:fetch. Read-only
 *  natives (`Read`/`Glob`/`Grep`) + `WebSearch` (no capability replacement) stay. */
export const FLEET_CAPABILITY_REPLACED_TOOLS: readonly string[] = ['Bash', 'Edit', 'Write', 'WebFetch'];

/** Roles that HAVE the `capability:*` defineTools — their `agentRoles` is
 *  `[...SU_ROLES, 'bee']` (B-05). The cutover strips native tools ONLY for these
 *  roles, so a role without a capability replacement is never stranded
 *  (extending confinement to the auxiliary roles needs the capability tools'
 *  `agentRoles` widened first — tracked follow-up). MUST stay in lockstep with the
 *  capability tools' `agentRoles`; pinned by the drift guard
 *  `agent-tools/capability/cutover-role-parity.test.ts` in operator-core. */
export const FLEET_CAPABILITY_ROLES: ReadonlySet<string> = new Set<string>([
  // SU_ROLES (packages/agent-mcp/src/role-config.ts) — kept literal because the
  // orchestrator does not depend on @papercusp/agent-mcp; the parity test guards it.
  'scoper', 'architect', 'worker', 'validator', 'reviewer', 'debugger', 'operator', 'mug', 'documenter', 'curator',
  'cup',
]);

/** True when the B-18 fleet cutover is armed for this spawn. The operator resolves
 *  the `papercusp-fleet-capability-only` flag per-spawn and threads it as this env
 *  var into the invoke-once child (mirrors `fleetSandboxEnabled()`). DEFAULT-OFF:
 *  unset / `0` / `false` / `off` ⇒ today's allow-list (native tools granted). */
export function fleetCapabilityOnlyEnabled(): boolean {
  const v = (process.env.PAPERCUSP_FLEET_CAPABILITY_ONLY ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** Whether the cutover applies to `role` for this spawn (armed AND the role has the
 *  capability:* replacements). */
function fleetCutoverApplies(role: string | undefined, capabilityOnly: boolean): boolean {
  return capabilityOnly && !!role && FLEET_CAPABILITY_ROLES.has(role);
}

/**
 * The allow-list for a given fleet role: the full safe kit
 * (`FLEET_ALLOWED_TOOLS`), minus `Edit`/`Write` for the API-only roles in
 * `FLEET_NO_WRITE_ROLES`, and minus the native write/exec/fetch tools under the
 * B-18 cutover (`capabilityOnly`, role-gated). An unknown/empty role gets the full
 * kit — never silently strip a tool from a role we don't recognise.
 */
/** Per-role tool scope from a blueprint (domain-generic-agent-personas-2026-06-17 P-005):
 *  a blueprint's `roles[].tools` narrows a role's kit so a NON-CODING role (e.g. a
 *  business/research role) can drop Edit/Write/Bash. `allow` (when non-empty) REPLACES
 *  the default allow-list as the base; `deny` is added to the hard-deny. Composes with
 *  the B-18 capability cutover — its native-tool strip runs ON TOP of the scoped base. */
export interface RoleToolScope {
  allow?: readonly string[];
  deny?: readonly string[];
}

export function fleetAllowedToolsForRole(
  role: string | undefined,
  capabilityOnly = false,
  scope?: RoleToolScope,
): string[] {
  // Pick the base kit. A non-empty blueprint scope.allow REPLACES the default base (for any
  // role, incl. queen/bee); otherwise queen/bee use their curated kits and every other role
  // gets the full FLEET_ALLOWED_TOOLS.
  const scoped = !!(scope?.allow && scope.allow.length > 0);
  let tools: string[];
  if (scoped) tools = [...scope!.allow!];
  else if (role === 'mug') tools = [...QUEEN_ALLOWED_TOOLS];
  else if (role === 'cup') tools = [...BEE_ALLOWED_TOOLS];
  else tools = [...FLEET_ALLOWED_TOOLS];
  // B-18 cutover: drop the native write/exec/fetch tools a confined role replaces with
  // capability:* — applied to EVERY base (incl. queen/bee, which previously early-returned
  // BEFORE this filter) so the allow-list never LISTS a tool the deny-list strips (the D-002
  // allow/deny asymmetry). The capability:* replacements live in the role's MCP kit
  // (QUEEN_MCP_TOOL_NAMES / BEE_MCP_TOOL_NAMES), so a confined role keeps a working surface.
  if (fleetCutoverApplies(role, capabilityOnly)) {
    tools = tools.filter((t) => !FLEET_CAPABILITY_REPLACED_TOOLS.includes(t));
  }
  if (role && FLEET_NO_WRITE_ROLES.has(role)) {
    tools = tools.filter((t) => t !== 'Edit' && t !== 'Write');
  }
  return tools;
}

/** The hard-deny list for a given fleet role: the standing `FLEET_DISALLOWED_TOOLS`
 *  plus, under the cutover, the native write/exec/fetch tools — `--disallowed-tools`
 *  removes a tool ENTIRELY and wins even over the dontAsk allow-list exemption
 *  (verified vs claude 2.1.158), so the removal is airtight, not just an omission.
 *
 *  ⚠ "Airtight" scopes to NATIVE tools ONLY. Every entry this function returns today is
 *  native, which is what keeps the claim true as written. It would NOT hold for an
 *  `mcp__*` entry: those execute server-side and `tools:invoke` re-reaches them by name
 *  in one call, so adding one here buys discovery friction, not confinement. See the
 *  caveat on FLEET_DISALLOWED_TOOLS above and
 *  /internal/docs/agent-insights/disallowed-tools-cannot-withhold-an-mcp-tool */
export function fleetDisallowedToolsForRole(
  role: string | undefined,
  capabilityOnly = false,
  scope?: RoleToolScope,
): string[] {
  const base = [...FLEET_DISALLOWED_TOOLS, ...(scope?.deny ?? [])];
  if (role === 'judge' && !base.includes('Bash')) base.push('Bash');
  if (fleetCutoverApplies(role, capabilityOnly)) {
    return [...base, ...FLEET_CAPABILITY_REPLACED_TOOLS];
  }
  return base;
}

/** Resolve a role's blueprint/config-declared tool scope (domain-generic-agent-personas
 *  P-005). A blueprint narrows a role's kit by declaring `toolScope.<role>.{allow,deny}`
 *  (projected into the effective config like other blueprint knobs). Empty/absent →
 *  undefined (the role keeps the full default kit — never silently strip). */
export function resolveRoleToolScope(cfg: HarnessConfig, role: string | undefined): RoleToolScope | undefined {
  if (!role) return undefined;
  const allow = configGet<string[]>(cfg, `toolScope.${role}.allow`, []);
  const deny = configGet<string[]>(cfg, `toolScope.${role}.deny`, []);
  const a = Array.isArray(allow) && allow.length > 0 ? allow : undefined;
  const d = Array.isArray(deny) && deny.length > 0 ? deny : undefined;
  return a || d ? { allow: a, deny: d } : undefined;
}

/* ─── B-18 cutover, omp leg (agent-capability-confinement P-034) ──────────────
 * The omp analog of the claude `--allowed-tools` cut above. claude removes native
 * Bash/Edit/Write/WebFetch via --allowed-tools/--disallowed-tools; omp's native
 * built-ins are removed via its `--tools <allowlist>` flag (an ALLOWLIST of which
 * built-ins to ENABLE; MCP tools — the capability:* surface — connect via .mcp.json
 * discovery and are unaffected). So under the cutover we enable ONLY omp's read-only
 * built-ins, dropping native execution / file mutation / network egress / sub-spawn
 * so those route through the gated capability:* MCP tools (or, where there's no
 * replacement, are removed and left to srt containment).
 *
 * codex has NO equivalent: its core `local_shell`/`apply_patch` are intrinsic with
 * no per-tool removal knob, and the PreToolUse hook that could block them is broken
 * upstream (openai/codex #20204 / #16732). codex confinement is therefore the srt
 * wrap (containment) + the client-uniform server-side capability envelope
 * (governance), NOT client-side tool removal. See plan D-013. */

/**
 * omp native built-ins KEPT under the cutover — the read-only / non-mutating set,
 * the omp analog of claude's kept Read/Glob/Grep/WebSearch. Everything NOT listed is
 * dropped:
 *   - bash · python · ssh        → native EXECUTION        → capability:bash
 *   - edit · write · ast_edit · notebook · generate_image → file MUTATION → capability:edit/write
 *   - fetch                      → network egress          → capability:fetch
 *   - browser                    → puppeteer ACTIONS       → (no replacement; srt-contained)
 *   - task                       → uncontrolled sub-spawn  → the Queen owns fan-out
 *   - ask                        → a NATIVE blocking question bypasses the server-side
 *                                  agent-question gate (B-10) → force chat:ask_choice (gated MCP)
 *   - lsp                        → rename/code_actions/request can MUTATE outside the
 *                                  capability gate (read ops recoverable via grep/ast_grep + MCP)
 * Owner-tunable: re-add a built-in here if a confined bee genuinely needs it.
 */
export const FLEET_OMP_CAPABILITY_ALLOWED_TOOLS: readonly string[] = [
  // Keep this to names accepted by the installed OMP `--tools` validator.
  // OMP 0.0.0-20260821 removed ast_grep/calc/todo_write/poll; naming even one
  // unknown tool aborts before inference, so a stale allowlist hard-downs every
  // capability-only OMP worker instead of merely omitting that tool.
  'read', 'find', 'glob', 'grep', 'web_search',
];

/**
 * `--tools <allowlist>` for an omp fleet spawn under the B-18 capability-only cutover
 * (P-034). Returns [] for any non-omp backend, when the cutover is disarmed or the
 * role has no capability:* replacements (`fleetCutoverApplies`), or when AGENT_CMD
 * already sets `--tools`/`--no-tools` (defer to the operator, mirroring
 * `codexSandboxArgs`). Pushed into `extraFlags` before the `@promptfile` positional.
 */
export function fleetOmpToolsArgs(
  agentBackend: AgentBackend,
  roleAgentCmd: string,
  role: string | undefined,
  capabilityOnly: boolean,
): string[] {
  if (agentBackend !== 'omp') return [];
  if (!fleetCutoverApplies(role, capabilityOnly)) return [];
  if (/(?:^|\s)--tools(?:\s|=)/.test(roleAgentCmd) || roleAgentCmd.includes('--no-tools')) return [];
  return ['--tools', FLEET_OMP_CAPABILITY_ALLOWED_TOOLS.join(',')];
}

/* ─── Fleet OS sandbox (plan fleet-spawn-sandbox-2026-06-01) ─────────────────
 * DEFAULT-ON (P-013/D-015); opt out with PAPERCUSP_FLEET_SANDBOX=0. Closes the
 * gaps the tool whitelist CANNOT: credential reads + network egress. Uses
 * claude-code's OWN built-in
 * sandbox (Linux bubblewrap + socat proxy; macOS Seatbelt) injected via
 * `--settings`, NOT a hand-rolled wrapper. Verified vs claude 2.1.159: the
 * sandbox engages headlessly, composes with `--permission-mode dontAsk`, hides
 * denyRead paths, confines writes to cwd, and blocks egress to unlisted hosts.
 * ──────────────────────────────────────────────────────────────────────── */

/** Credential dirs hidden from the sandboxed Bash subprocess (`denyRead`). */
export const FLEET_SANDBOX_DENY_READ: readonly string[] = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.config/gcloud',
  '~/.papercusp',
  '~/.npmrc',
];

/**
 * Domains a sandboxed Bash command may reach — the package registries a build/
 * test role legitimately needs. Verified (P-012/D-011): claude's sandbox egress
 * allowlist works (`curl registry.npmjs.org` → 200, `curl example.com` → 000).
 * Deny-all (`[]`) was the original floor but it breaks any role that runs
 * `npm/pip/cargo install` — so this is the functional default for the (now
 * default-on) sandbox. The agent's own model + MCP connections are OUTSIDE the sandbox and
 * unaffected; this list only governs what a sandboxed Bash *command* can fetch.
 *
 * Tradeoff (D-005): every domain here is reachable with TLS UNINSPECTED, so it
 * widens a potential exfil channel. Kept to package registries + the few common
 * toolchain CDNs a default-on fleet hits out-of-box — Playwright browsers
 * (`cdn.playwright.dev` + the `playwright.download.prss.microsoft.com` fallback)
 * and node-gyp headers (`nodejs.org`), added for default-on (P-013/D-015) after
 * the real fleet pass (D-013) showed `npx playwright install` / native-addon
 * builds blocked. A security-hardened deployment strips ALL of these with
 * `PAPERCUSP_FLEET_SANDBOX_DENY_ALL_EGRESS=1`. Per-role narrowing (read-only
 * roles need none) is a future refinement.
 *
 * DEPLOYMENT-EXTENSIBLE (the no-fork widening path — the enabler for default-on,
 * D-012): the effective list is resolved at spawn time by
 * `resolveFleetAllowedDomains()`, which layers two env knobs over this base so a
 * deployment whose toolchain needs a non-registry host (a private registry, a
 * Playwright/Cypress browser CDN, an internal mirror) can adjust WITHOUT editing
 * code — exactly the breakage axis a per-project default-on must absorb:
 *   • `PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS` — comma/space-separated extra
 *     hosts APPENDED to this base (deduped).
 *   • `PAPERCUSP_FLEET_SANDBOX_DENY_ALL_EGRESS=1` — lockdown: ignore the base +
 *     the append var and emit `[]` (a security-hardened deployment blocks ALL
 *     sandboxed-Bash egress). Wins over the append var.
 */
export const FLEET_SANDBOX_ALLOWED_DOMAINS: readonly string[] = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'static.crates.io',
  'index.crates.io',
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  // EI-13191: `github.com/<org>/<repo>/releases/download/...` 302-redirects to a
  // signed Azure blob URL on THIS host — every `curl -L` of a GitHub release
  // asset (a common install pattern; e.g. papercusp-desktop/bin/mac-vm-build.sh's
  // zellij download) needs it reachable too, not just the API/git-object hosts above.
  'release-assets.githubusercontent.com',
  // Common toolchain CDNs a default-on fleet needs out-of-box (P-013/D-015):
  'cdn.playwright.dev', // Playwright browser binaries (primary)
  'playwright.download.prss.microsoft.com', // Playwright browser binaries (fallback)
  'nodejs.org', // node-gyp headers for native addons
];

/**
 * Resolve the effective sandboxed-Bash egress allowlist for this spawn: the
 * `FLEET_SANDBOX_ALLOWED_DOMAINS` base plus any deployment additions, or `[]`
 * under lockdown. See the const docstring for the two env knobs. This is the
 * no-fork widening path that lets a default-on sandbox absorb a project whose
 * build/test toolchain reaches a host outside the registry defaults, instead of
 * that role's Bash step failing with an opaque egress block. Resolved from the
 * trusted orchestrator env, never from agent-supplied tool input.
 */
export function resolveFleetAllowedDomains(): string[] {
  const lockdown = process.env.PAPERCUSP_FLEET_SANDBOX_DENY_ALL_EGRESS;
  if (lockdown === '1' || lockdown === 'true') return [];
  const extra = (process.env.PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS ?? '')
    .split(/[\s,]+/)
    .map((d) => d.trim())
    .filter(Boolean);
  return [...new Set([...FLEET_SANDBOX_ALLOWED_DOMAINS, ...extra])];
}

/**
 * Self-heal the fleet sandbox's zero-byte manifest artifact. When a spawn's cwd
 * has no `package.json`, claude's sandbox leaves a 0-BYTE one behind (a
 * mount-point artifact of its protected-file masking, alongside empty `.env*` /
 * lockfiles — observed live on Hetzner frame 138790170, 2026-06-09). A 0-byte
 * package.json is INVALID JSON, so every later Node/Bun-based agent start in
 * that cwd aborts at boot with ERR_INVALID_PACKAGE_CONFIG — the FIRST sandboxed
 * spawn bricks the harness dir for the rest of the pipeline (the director ran;
 * every retry after it failed `exit=1, empty=true`). Repair is tightly scoped:
 * only `package.json`, only when it exists AND is exactly 0 bytes (a state our
 * own sandbox caused; the other empty artifacts are harmless). A non-empty
 * file — valid or not — is the project's own and is never touched.
 */
export function healSandboxZeroByteManifest(cwd: string, log?: (msg: string) => void): void {
  try {
    const p = join(cwd, 'package.json');
    if (existsSync(p) && statSync(p).size === 0) {
      writeFileSync(p, '{}\n', 'utf8');
      log?.(`  healed 0-byte package.json in ${cwd} (fleet-sandbox mask artifact; would brick later spawns with ERR_INVALID_PACKAGE_CONFIG)`);
    }
  } catch {
    /* best-effort — a failed heal just surfaces as the original invoke error */
  }
}

/**
 * Root for fleet agent package-manager caches. The sandbox makes everything
 * outside cwd read-only (allowWrite is cwd + this dir), but npm/pip/cargo write
 * their caches under $HOME (e.g. ~/.npm/_cacache) — so a real `npm install`
 * under the sandbox fails EROFS (verified P-014/D-013: the registry was
 * REACHED, the cache write was denied). Rather than weaken containment by
 * leaving $HOME writable, we add THIS one dedicated dir to `allowWrite` and
 * point each ecosystem's cache env at a per-project subdir of it (see
 * fleetSandboxCacheEnv). Workspace agent spawns keep using those isolated paths
 * even when the OS sandbox is explicitly disabled, so sibling checkouts and
 * /tmp scratch projects do not race the shared ~/.npm content store. NOT under
 * `~/.papercusp` (which is denyRead).
 * Computed from the operator process home so it matches the absolute cache-env
 * paths even when the child gets a per-spawn HOME (resolveSpawnHome).
 */
export const FLEET_SANDBOX_CACHE_ROOT = join(homedir(), '.cache', 'papercusp-fleet-sandbox');

/**
 * Cache-redirect env for a workspace agent spawn whose project lives at `cwd`.
 * Points npm/yarn/pip/cargo/go + the generic XDG cache at a per-project subdir
 * of FLEET_SANDBOX_CACHE_ROOT (which is allow-listed for writes when the OS
 * sandbox is enabled). Per-project keying (a short hash of cwd) keeps one
 * project's build from poisoning another's cache. Absolute paths, so they're
 * independent of the child's HOME. The caller mkdir -p's the dirs.
 */
export function fleetSandboxCacheEnv(cwd: string): Record<string, string> {
  const key = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  const base = join(FLEET_SANDBOX_CACHE_ROOT, key);
  return {
    npm_config_cache: join(base, 'npm'),
    YARN_CACHE_FOLDER: join(base, 'yarn'),
    PIP_CACHE_DIR: join(base, 'pip'),
    CARGO_HOME: join(base, 'cargo'),
    GOCACHE: join(base, 'go-build'),
    GOMODCACHE: join(base, 'go-mod'),
    // Catch-all: many tools honor XDG (~/.cache → here), incl. pip + Playwright.
    XDG_CACHE_HOME: join(base, 'xdg'),
  };
}

/**
 * `Read`/`Edit` permission DENY rules for the credential paths. Required
 * because claude's sandbox covers `Bash` + children only — the `Read`/`Edit`
 * TOOLS bypass it (they go through the permission system), and the default
 * read policy still allows `~/.ssh` / `~/.aws/credentials`. Path syntax is the
 * permission-rule form (`~/` for home), distinct from the sandbox `denyRead`.
 */
export const FLEET_SANDBOX_DENY_RULES: readonly string[] = [
  'Read(~/.ssh/**)',
  'Read(~/.aws/**)',
  'Read(~/.gnupg/**)',
  'Read(~/.config/gcloud/**)',
  'Read(~/.papercusp/**)',
  'Edit(~/.ssh/**)',
  'Edit(~/.aws/**)',
  'Edit(~/.papercusp/**)',
];

/**
 * True when the fleet OS sandbox should engage. DEFAULT-ON (P-013/D-015): the
 * real fleet pass (D-013) confirmed MCP survives the sandbox, the egress
 * allowlist covers the common toolchains, and the `npm install` EROFS is fixed
 * (P-014) — so claude-code fleet spawns are sandboxed by default. Opt OUT with
 * `PAPERCUSP_FLEET_SANDBOX=0` (or `false`/`off`) — e.g. a deployment whose host
 * lacks bubblewrap, since the sandbox is `failIfUnavailable:true` (claude-code
 * only; codex/omp are unaffected — D-009/D-010). Read per-spawn, so the default
 * takes effect on the next operator restart (the :3070 host has no hot-reload).
 */
export function fleetSandboxEnabled(): boolean {
  const v = (process.env.PAPERCUSP_FLEET_SANDBOX ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

/**
 * The sandbox settings claude-code consumes, **decided per role by trusted
 * orchestrator code** (this runs inside `invoke()`, never from agent-supplied
 * tool input — an agent must not be able to choose/weaken its child's sandbox).
 *
 * `role` is the per-role decision seat. The POLICY is uniform today —
 * credential protection (`denyRead` + Read/Edit deny rules) and deny-all egress,
 * which every role needs and none should escape. Two per-role facts verified
 * against claude 2.1.159 (P-004) shape what varies and what can't:
 *
 *  - Per-role WRITE tightening is NOT achievable via the sandbox: the cwd is
 *    ALWAYS writable (`allowWrite` only *adds* paths beyond cwd; `denyWrite`
 *    of the cwd didn't reliably block either). So write-discipline per role
 *    stays at the allowed-tools layer (via FLEET_NO_WRITE_ROLES, currently
 *    empty); the residual Bash-escape is a known, documented limit.
 *  - Per-role EGRESS *is* the achievable axis (e.g. a read-only review role
 *    does web research and would need an allowlist, while a worker needs none) — that's
 *    where `role` will branch. Today the egress floor is the registry allowlist
 *    `resolveFleetAllowedDomains()` (base + the deployment env knobs, D-012),
 *    uniform across roles; the exact per-role narrowing still wants the
 *    real-spawn verification pass (P-012).
 */
export function fleetSandboxSettingsForRole(role: string | undefined): Record<string, unknown> {
  // role: reserved for per-role egress policy (P-012). Uniform floor today; see docstring.
  void role;
  return {
    sandbox: {
      enabled: true,
      // Default-on (P-013) → if deps (bubblewrap/socat) are missing, fail loudly
      // rather than silently run unsandboxed. A host without bwrap opts out
      // explicitly with PAPERCUSP_FLEET_SANDBOX=0 (don't weaken the guarantee by
      // degrading to unsandboxed by default). claude-code only; codex/omp are
      // unaffected (D-009/D-010).
      failIfUnavailable: true,
      // Strict: no `dangerouslyDisableSandbox` retry-outside-the-sandbox escape hatch.
      allowUnsandboxedCommands: false,
      // cwd is always writable in claude's sandbox; this allowWrite is the
      // explicit (no-extra-paths) form of that default.
      // cwd + the allow-listed package-manager cache root (FLEET_SANDBOX_CACHE_ROOT):
      // without the latter a real `npm/pip/cargo install` fails EROFS, since those
      // caches live under $HOME which the sandbox makes read-only (D-013/P-014).
      filesystem: { allowWrite: ['.', FLEET_SANDBOX_CACHE_ROOT], denyRead: [...FLEET_SANDBOX_DENY_READ] },
      network: { allowedDomains: resolveFleetAllowedDomains() },
    },
    // Read/Edit tool deny rules — the sandbox does NOT cover these tools (D-004).
    permissions: { deny: [...FLEET_SANDBOX_DENY_RULES] },
  };
}

/* ─── G4 / P-011: spawn-env least-privilege (plan papercusp-user-protection-gate
 * 2026-05-31) ────────────────────────────────────────────────────────────────
 * The spawned agent CLI (claude/omp/codex) reaches EVERY privileged surface via
 * the SIGNED MCP HTTP endpoint (:3070) — never via a direct PG connection — so
 * it does not need the operator's admin PG creds or the key that decrypts
 * `operator_secrets`. Yet the merged `spawnEnv` (`...process.env` +
 * `ctx.extraSpawnEnv` + `options.extraEnv`) hands every child the full operator
 * env. `scopeSpawnEnvForRole` removes the secrets the child can't use, so a
 * fooled/compromised agent — or one executing a feature the auditor (G2)
 * mis-admitted — can't read admin PG creds or the decryption key straight out of
 * its environment (D-007: G4 is the damage-bound backstop to the auditor).
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Operator-internal secrets removed from EVERY spawned agent-CLI child env: the
 * admin Postgres DSNs and the key that decrypts `operator_secrets`. The agent
 * CLI authenticates to all privileged surfaces through the signed MCP HTTP
 * endpoint, so it never reads these directly — only the trusted orchestrator
 * (`invoke()` / `invoke-once`) needs them, and they stay in ITS `process.env`
 * because this helper scopes the CHILD `spawnEnv` only, not `process.env`.
 *  - `DATABASE_URL` / `PAPERCUSP_PG_DSN` — admin PG connection strings.
 *  - `PAPERCUSP_DB_ENCRYPTION_KEY` — decrypts the `operator_secrets` /
 *    search-provider-credentials store (see spawn-env-from-pg.ts).
 */
export const SPAWN_ENV_ALL_ROLES_STRIP: readonly string[] = [
  'DATABASE_URL',
  'PAPERCUSP_PG_DSN',
  'PAPERCUSP_DB_ENCRYPTION_KEY',
];

/**
 * Private detector identity copied from the invoke-once process into the
 * actual agent CLI environment. The signed MCP URL carries the same value as
 * `?detector=...`; hooks cannot read that URL, so this is their process-local
 * carrier for draining failure-loop state without conflating it with the
 * public coordination owner.
 */
export const FAILURE_LOOP_SESSION_KEY_ENV = 'PAPERCUSP_FAILURE_LOOP_SESSION_KEY';

/**
 * Decrypted search-provider API-key env names that OMP's `web_search` providers
 * consume. SOURCE OF TRUTH: `apps/operator/lib/search-provider-credentials.ts`
 * `SEARCH_PROVIDERS` (each provider's `primary` + `alternates` + the SearXNG
 * `fields`). Mirrored here (a small, stable list) because the orchestrator
 * package can't import from `apps/operator` — wrong dependency direction.
 * **Keep in sync** with that file; the unit test
 * `SEARCH_PROVIDER_ENV_KEYS — mirrors …` pins the names so a drift is caught.
 *
 * These are stripped for the AUDITOR only (a read-only judge with no
 * `web_search` and no tools beyond read). NOTE several of these names
 * (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `CODEX_API_KEY`) could in principle be
 * a backend's API auth — but the fleet's agent backends authenticate via
 * session/OAuth FILES, NOT an API-key env: claude → `~/.claude` (per-spawn HOME
 * via `resolveSpawnHome`); codex → `~/.codex/auth.json` symlinked into the
 * per-spawn `CODEX_HOME` (`writeSignedSpawnCodexHome`); omp → the Meridian
 * Claude-Code-SDK bridge. So NO key here is load-bearing for backend auth, and
 * stripping them all still lets the auditor run + emit a verdict.
 */
export const SEARCH_PROVIDER_ENV_KEYS: readonly string[] = [
  'TAVILY_API_KEY',
  'PERPLEXITY_API_KEY',
  'PPLX_API_KEY',
  'BRAVE_API_KEY',
  'JINA_API_KEY',
  'MOONSHOT_SEARCH_API_KEY',
  'KIMI_SEARCH_API_KEY',
  'MOONSHOT_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'CODEX_API_KEY',
  'ZAI_API_KEY',
  'EXA_API_KEY',
  'PARALLEL_API_KEY',
  'KAGI_API_KEY',
  'SYNTHETIC_API_KEY',
  'SEARXNG_ENDPOINT',
  'SEARXNG_TOKEN',
  'SEARXNG_BASIC_USERNAME',
  'SEARXNG_BASIC_PASSWORD',
];

/**
 * Return a COPY of `env` with the secrets a spawned agent-CLI child of `role`
 * does not need removed (never mutates the input). Decided by trusted
 * orchestrator code, never from agent-supplied input.
 *
 *  - ALL roles lose the operator-internal PG/DB secrets
 *    (`SPAWN_ENV_ALL_ROLES_STRIP`) — the child uses the signed MCP endpoint.
 *  - The `auditor` role ADDITIONALLY loses every decrypted search-provider API
 *    key (`SEARCH_PROVIDER_ENV_KEYS`) — it is a read-only judge with no
 *    `web_search`. Backend auth is session/OAuth-file based, so no key here is
 *    needed for the auditor to run (see SEARCH_PROVIDER_ENV_KEYS).
 *
 * Applied to the merged `spawnEnv` BEFORE the post-merge env mutations
 * (`OMP_*`/`PI_*` memory flags, `resolveSpawnHome` → HOME/USERPROFILE,
 * `gitConfigNoPushEnv`, the per-spawn `CODEX_HOME`/`.mcp.json` and sandbox
 * cache-redirect), so HOME, the git-no-push config, and the MCP/cache env added
 * afterward survive — none of those are secrets this strips. The private
 * failure-loop detector key is copied from `PAPERCUSP_SID` into its explicit
 * hook carrier here, at the same producer boundary that signs `?detector=` in
 * the MCP URL. A missing SID clears any inherited carrier rather than leaking
 * a stale detector identity into a child.
 */
export function scopeSpawnEnvForRole(env: NodeJS.ProcessEnv, role: string): NodeJS.ProcessEnv {
  const scoped: NodeJS.ProcessEnv = { ...env };
  const detectorSessionKey = typeof env.PAPERCUSP_SID === 'string' ? env.PAPERCUSP_SID.trim() : '';
  if (detectorSessionKey) scoped[FAILURE_LOOP_SESSION_KEY_ENV] = detectorSessionKey;
  else delete scoped[FAILURE_LOOP_SESSION_KEY_ENV];
  for (const k of SPAWN_ENV_ALL_ROLES_STRIP) delete scoped[k];
  if (role === 'auditor') {
    for (const k of SEARCH_PROVIDER_ENV_KEYS) delete scoped[k];
  }
  return scoped;
}

/**
 * `--settings <inline JSON>` carrying the per-role fleet OS sandbox, appended
 * to a claude-code spawn when PAPERCUSP_FLEET_SANDBOX is set. The policy is
 * resolved from the trusted `role` (see fleetSandboxSettingsForRole). Returns
 * `[]` unless enabled + claude-code + claude stream + a workspace, or when the
 * user already passed their own `--settings` in AGENT_CMD (we defer to them).
 */
export function claudeSandboxArgs(
  agentBackend: AgentBackend,
  streamFormat: StreamFormat,
  roleAgentCmd: string,
  hasWorkspace: boolean,
  enabled: boolean,
  role: string,
): string[] {
  if (
    !enabled ||
    agentBackend !== 'claude-code' ||
    streamFormat !== 'claude-stream-json' ||
    !hasWorkspace ||
    roleAgentCmd.includes('--settings')
  ) {
    return [];
  }
  return ['--settings', JSON.stringify(fleetSandboxSettingsForRole(role))];
}

/**
 * codex's sandbox flags. **codex is NOT sandboxable for the fleet** — verified
 * vs codex on this box (P-012, D-009) and RE-VERIFIED on codex-cli 0.135 (D-016):
 * under `-s workspace-write` (and `read-only`) codex CANCELS MCP tool calls
 * ("user cancelled MCP tool call", client-side — never reaches the server),
 * while the same call REACHES the server under the bypass. A sandboxed codex
 * worker is therefore tool-less, which breaks the MCP-dependent fleet. So codex
 * always runs under `-s danger-full-access --dangerously-bypass-approvals-and-
 * sandbox` REGARDLESS of PAPERCUSP_FLEET_SANDBOX — the flag deliberately does
 * not switch codex to workspace-write (that would silently disable its tools).
 *
 * (workspace-write *does* confine writes + block command egress — but the MCP
 * cancellation makes it unusable here. RULED OUT (D-016): `network_access=true`
 * does NOT help — the cancel is a codex policy gating MCP under any sandbox, not
 * an egress block; and codex 0.135 has no auto-approve/MCP-trust knob — the only
 * approval-bypass is bundled with sandbox-bypass. Revisit if codex gains
 * MCP-under-sandbox support. claude is sandboxed because its sandbox covers only
 * sub-commands, leaving the agent's own MCP connection intact; codex differs.)
 *
 * CONTAINMENT FOR codex now comes from an EXTERNAL wrap, NOT its native sandbox:
 * under PAPERCUSP_FLEET_SANDBOX the codex spawn is wrapped in `srt`
 * (wrapSpawnWithSrt at the spawn site, P-017/D-017) while keeping the bypass
 * here — so MCP works AND shell commands are confined. This function's job is
 * just to keep codex's OWN sandbox off (the bypass); srt does the confining.
 *
 * Appended to `extraFlags` before the `-` stdin positional. Defers to a
 * user-set `-s`/`--sandbox`/bypass in AGENT_CMD. `enabled` is intentionally
 * unused: codex's NATIVE posture does not depend on the fleet-sandbox flag
 * (the flag drives the external srt-wrap instead).
 */
export function codexSandboxArgs(
  agentBackend: AgentBackend,
  streamFormat: StreamFormat,
  roleAgentCmd: string,
  enabled: boolean,
): string[] {
  void enabled; // codex can't be sandboxed (MCP cancellation) — see docstring.
  if (agentBackend !== 'codex') return [];
  const isCodexExec = /(?:^|\s)exec(?:\s|$)/.test(roleAgentCmd);
  if (streamFormat !== 'codex-json' && !isCodexExec) return [];
  // Defer to a user-chosen sandbox/bypass posture in AGENT_CMD.
  if (
    /(?:^|\s)-s\s/.test(roleAgentCmd) ||
    roleAgentCmd.includes('--sandbox') ||
    roleAgentCmd.includes('--dangerously-bypass-approvals-and-sandbox')
  ) {
    return [];
  }
  return ['-s', 'danger-full-access', '--dangerously-bypass-approvals-and-sandbox'];
}

/* ─── External srt-wrap — codex containment (plan fleet-spawn-sandbox, P-017/D-017) ──
 * codex's NATIVE sandbox cancels MCP (D-009/D-016), so codex can't self-sandbox.
 * The way around (verified end-to-end, D-017): run codex with its native sandbox
 * OFF (codexSandboxArgs keeps `--dangerously-bypass-approvals-and-sandbox`, so
 * MCP is NOT cancelled) and wrap the WHOLE codex process in `srt`
 * (@anthropic-ai/sandbox-runtime: bubblewrap `--unshare-net` + a host-side
 * allowlisting proxy). srt then confines codex's shell commands (writes →
 * cwd+cache, egress → allowlist, creds hidden) while codex's MCP + model traffic
 * is allow-listed THROUGH srt's proxy. Crucial detail: srt injects a `no_proxy`
 * that excludes loopback + RFC1918, which would route the operator MCP DIRECTLY
 * into the isolated netns (unreachable) — so the wrap clears `no_proxy` inside
 * the srt shell, sending operator + model traffic through srt's proxy instead.
 *
 * omp (no native sandbox at all) uses the SAME wrap (D-018/D-019): omp's model
 * + MCP are loopback on this box (ollama / the meridian bridge) — the same
 * loopback-through-srt's-proxy transport proven for codex — so its egress
 * allowlist is the operator + localhost + registries (a cloud-model omp adds its
 * host via PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS). Its writable agent dirs
 * (`~/.omp` + PI_CODING_AGENT_DIR = `<project>/.papercusp/pi-sessions`, which holds
 * omp's agent/auth/models SQLite DBs) are added to allowWrite. Verified under
 * srt: omp starts cleanly + reaches its model (the residual omp↔ollama
 * tool-schema 400 is an omp bug, present with or without srt — NOT a containment
 * gap). claude uses its own `--settings` sandbox, not srt.
 * ──────────────────────────────────────────────────────────────────────── */

/** `srt` binary path (the egress+fs sandbox wrapper) if on PATH, else null. */
export function srtBinOnPath(): string | null {
  for (const d of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const p = join(d, 'srt');
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Model-endpoint hosts the wrapped agent process must reach THROUGH srt's proxy.
 * codex (ChatGPT auth) talks to the OpenAI API + auth hosts. omp returns `[]`:
 * on this box its model is loopback (ollama :11434 / the meridian bridge :3456),
 * already covered by the `localhost`/`127.0.0.1` entries in buildFleetSrtSettings;
 * a deployment that points omp at a CLOUD model adds that host via
 * `PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS` (omp's provider is deployment-set,
 * so there's no single stable host to hardcode like codex's OpenAI).
 */
export function fleetSrtModelDomains(backend: AgentBackend): string[] {
  // Declared on the backend's profile (harness-profile.ts) rather than branched
  // on here, so adding a backend is forced to state its egress hosts instead of
  // silently inheriting codex's or an empty set.
  return [...harnessProfile(backend).srtModelDomains];
}

/**
 * srt settings for an externally-wrapped agent spawn. Confines the WHOLE agent
 * process: writes → cwd + the pkg-cache root + the backend's own agent dirs
 * (`agentHomes` — codex's CODEX_HOME; omp's `~/.omp` + PI_CODING_AGENT_DIR);
 * egress → the operator (localhost/127.0.0.1) + the model endpoints + the
 * package registries/CDNs (resolveFleetAllowedDomains); credential dirs hidden
 * via `denyRead`, with `allowRead` re-permitting any agentHome that sits under a
 * denied dir (codex's CODEX_HOME lives under `~/.papercusp`, verified D-017). srt
 * schema: filesystem {allowWrite, denyWrite, denyRead, allowRead}.
 */
export function buildFleetSrtSettings(opts: {
  cwd: string;
  backend: AgentBackend;
  agentHomes?: string[];
}): Record<string, unknown> {
  const home = homedir();
  const abs = (p: string) => (p.startsWith('~/') ? join(home, p.slice(2)) : p);
  const denyRead = FLEET_SANDBOX_DENY_READ.map(abs);
  const homes = (opts.agentHomes ?? []).filter(Boolean).map(abs);
  const allowWrite = [opts.cwd, FLEET_SANDBOX_CACHE_ROOT, ...homes];
  // Re-allow reading any agent home that's under a denyRead dir (codex
  // CODEX_HOME is under ~/.papercusp) so the agent can load its config + auth.
  const allowRead = homes.filter((h) => denyRead.some((d) => h.startsWith(d)));
  return {
    network: {
      allowedDomains: [
        ...resolveFleetAllowedDomains(),
        ...fleetSrtModelDomains(opts.backend),
        'localhost',
        '127.0.0.1',
      ],
      deniedDomains: [],
    },
    filesystem: {
      allowWrite,
      denyWrite: [],
      denyRead,
      ...(allowRead.length ? { allowRead } : {}),
    },
  };
}

/** Write per-spawn srt settings to a 0600 temp file; returns its path. */
export function writeFleetSrtSettings(opts: {
  cwd: string;
  backend: AgentBackend;
  agentHomes?: string[];
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'papercusp-fleet-srt-'));
  const path = join(dir, 'srt-settings.json');
  writeFileSync(path, JSON.stringify(buildFleetSrtSettings(opts)), { mode: 0o600 });
  return path;
}

/** Single-quote shell-escape each arg into one `sh -c`-safe string. */
function shQuote(parts: string[]): string {
  return parts.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ');
}

/**
 * Backends wrapped in srt: those with no usable native sandbox.
 *
 * Stated as the REASON (`native-sandbox`) rather than the conclusion
 * (`codex || omp`) — a new backend answers "do I sandbox myself?" on its
 * profile, and gets wrapped correctly without editing this predicate.
 */
export function backendUsesSrt(backend: AgentBackend): boolean {
  return !harnessSupports(backend, 'native-sandbox');
}

/**
 * Wrap a codex/omp spawn in `srt` (P-017/D-017 codex, D-018/D-019 omp). Returns
 * the command unchanged for claude-code (its own `--settings` sandbox) or when
 * disabled / srt absent. The wrapped form runs the agent via
 * `srt -s <settings> -c 'export no_proxy=… ; exec <agent …>'` so `no_proxy` is
 * cleared INSIDE the sandbox (srt injects its own otherwise) — letting the
 * operator MCP + model route through srt's proxy. The prompt arrives via the
 * agent's own channel (codex's trailing stdin `-`; omp's `@promptfile` arg),
 * inherited through the exec.
 */
export function wrapSpawnWithSrt(
  command: string,
  argv: string[],
  opts: { enabled: boolean; backend: AgentBackend; srtBin: string | null; settingsPath: string | null },
): { command: string; argv: string[] } {
  if (!opts.enabled || !backendUsesSrt(opts.backend) || !opts.srtBin || !opts.settingsPath) {
    return { command, argv };
  }
  const inner = `export no_proxy='' NO_PROXY=''; exec ${shQuote([command, ...argv])}`;
  return { command: opts.srtBin, argv: ['-s', opts.settingsPath, '-c', inner] };
}

/**
 * Extra CLI args that make claude-code load + trust the per-spawn signed
 * `.mcp.json` AND run under a closed, per-role whitelist instead of
 * unrestricted.
 *
 * omp path-discovers `<cwd>/.mcp.json` and connects automatically.
 * claude-code does NOT: it treats a project `.mcp.json` as "pending
 * approval" and, in headless `-p` mode (no way to approve), never connects
 * to it (verified against claude 2.1.158 — `claude mcp get` reports
 * unapproved `.mcp.json` servers as "⏸ Pending approval and not connected
 * to"). `--mcp-config <path>` loads AND trusts the file directly (bypassing
 * the approval gate); `--strict-mcp-config` restricts the worker to ONLY
 * that server, not the engineer's personal `~/.claude.json` fleet.
 *
 * `--permission-mode dontAsk` + `--allowed-tools <whitelist>` is the
 * permission posture: dontAsk pre-approves the allow-listed tools (no prompt,
 * no hang) and hard-denies everything else in headless mode — a true
 * default-deny whitelist (verified vs claude 2.1.158; note `default` mode
 * sandboxes even allow-listed writes, `dontAsk` does not, which is why we
 * use dontAsk and not default). `--disallowed-tools` adds the Bash
 * command-pattern backstop. See FLEET_ALLOWED_TOOLS / FLEET_DISALLOWED_TOOLS.
 *
 * Returns `[]` for any non-claude backend, a non-claude stream, or when no
 * workspace is set (the `.mcp.json` is only written when `ctx.workspaceId`
 * is present). If the user manages MCP loading or the permission posture
 * themselves in AGENT_CMD, we defer to them for that part.
 */
export function claudeMcpArgs(
  agentBackend: AgentBackend,
  streamFormat: StreamFormat,
  roleAgentCmd: string,
  mcpConfigPath: string,
  hasWorkspace: boolean,
  role: string,
  toolScope?: RoleToolScope,
): string[] {
  if (
    agentBackend !== 'claude-code' ||
    streamFormat !== 'claude-stream-json' ||
    !hasWorkspace
  ) {
    return [];
  }
  const out: string[] = [];
  if (!roleAgentCmd.includes('--mcp-config')) {
    out.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
  }
  // The permission posture is a unit (mode + allow-list + deny-list). If the
  // user set ANY permission-related flag in AGENT_CMD, they're managing it
  // themselves — don't half-apply ours on top (which could contradict
  // theirs). Otherwise impose the closed whitelist.
  const userManagesPermissions =
    roleAgentCmd.includes('--permission-mode') ||
    roleAgentCmd.includes('--allowed-tools') ||
    roleAgentCmd.includes('--allowedTools') ||
    roleAgentCmd.includes('--disallowed-tools') ||
    roleAgentCmd.includes('--disallowedTools') ||
    roleAgentCmd.includes('--dangerously-skip-permissions') ||
    roleAgentCmd.includes('--allow-dangerously-skip-permissions');
  // B-18 cutover (default-off): resolve once. The env that arms it is set ONLY by
  // spawnInvokeOnce (the fleet chokepoint), so fleetCutoverApplies is never true
  // for an SU/human session — the D-002 carve-out holds by construction.
  const capabilityOnly = fleetCapabilityOnlyEnabled();
  if (!userManagesPermissions) {
    out.push('--permission-mode', 'dontAsk');
    // Allow-list as one space-joined value (claude splits it); deny patterns
    // as separate argv elements so each pattern's internal spaces (e.g.
    // `Bash(git push:*)`) survive. Both forms verified against claude 2.1.158.
    out.push('--allowed-tools', fleetAllowedToolsForRole(role, capabilityOnly, toolScope).join(' '));
    out.push('--disallowed-tools', ...fleetDisallowedToolsForRole(role, capabilityOnly, toolScope));
  } else if (fleetCutoverApplies(role, capabilityOnly)) {
    // The cutover's native-tool hard-deny is a security INVARIANT, not a
    // user-defeatable preference. When the deployment manages the rest of the
    // posture (AGENT_CMD already carries a permission flag, so the block above is
    // skipped), we defer mode + allow-list to them but STILL hard-remove native
    // Bash/Edit/Write/WebFetch from a confined fleet spawn — `--disallowed-tools`
    // wins even under bypassPermissions (verified vs claude 2.1.158). Without this,
    // a hardened AGENT_CMD (e.g. `--permission-mode dontAsk`) would silently no-op
    // the cutover and leave native exec on a confined bee.
    out.push('--disallowed-tools', ...FLEET_CAPABILITY_REPLACED_TOOLS);
  }
  return out;
}

/**
 * The fleet pre-push hook body. Installed per-spawn via a spawn-env-only
 * `core.hooksPath` override (see `gitConfigNoPushEnv`), so it fires ONLY for
 * orchestrator-spawned agents — the shared checkout's config and the
 * user's / other agents' pushes are untouched. Unconditional block: the repo
 * invariant is "agents don't push" (integration is the orchestrator's job).
 * This is the real no-push enforcement; the `Bash(git push:*)` deny in
 * FLEET_DISALLOWED_TOOLS is an evadable backstop (`git -C … push`, aliases,
 * `&& git push` slip past command-string matching — this hook does not).
 */
const FLEET_PRE_PUSH_HOOK = `#!/bin/sh
# papercusp fleet pre-push hook — installed per-spawn via GIT_CONFIG core.hooksPath.
echo "papercusp: autonomous fleet spawns may not 'git push' (integration is the orchestrator's job; repo invariant: agents don't push). Blocked by the fleet pre-push hook." 1>&2
exit 1
`;

// Cached per orchestrator process — the hooks dir is created once with an
// unguessable name (see ensureFleetGitHooksDir) and reused across spawns.
let cachedFleetGitHooksDir: string | null = null;

/**
 * Create (once per process, then cached) a hooks directory holding only the
 * fleet pre-push hook and return its absolute path.
 *
 * Security: a `core.hooksPath` directory is an RCE sink — git executes
 * whatever hooks live there — so it must not sit at a predictable, shared
 * tmp path another user could pre-create / symlink (plant a hook, or clobber
 * a victim file through our write). So: `mkdtempSync` mints an unguessable
 * name and creates the dir atomically with mode 0700 (owner-only); the hook
 * is written through `O_NOFOLLOW | O_EXCL` so a pre-existing symlink/file at
 * the path errors rather than being followed/overwritten. `core.hooksPath`
 * pointing here means no OTHER hook type runs for the spawn — fine, fleet
 * agents commit with `--no-verify` and the only hook we want is pre-push.
 */
export function ensureFleetGitHooksDir(): string {
  if (cachedFleetGitHooksDir && existsSync(join(cachedFleetGitHooksDir, 'pre-push'))) {
    return cachedFleetGitHooksDir;
  }
  // mkdtemp → 0700, owner-only, unguessable name (can't be pre-created).
  const dir = mkdtempSync(join(tmpdir(), 'papercusp-fleet-githooks-'));
  const hookPath = join(dir, 'pre-push');
  // O_EXCL: the freshly-minted dir is empty, so this also fails loudly if
  // anything raced a file in; O_NOFOLLOW: never write through a symlink.
  const fd = openSync(
    hookPath,
    // eslint-disable-next-line no-bitwise
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o700,
  );
  try {
    writeSync(fd, FLEET_PRE_PUSH_HOOK);
  } finally {
    closeSync(fd);
  }
  cachedFleetGitHooksDir = dir;
  return dir;
}

/**
 * Spawn-env additions that point THIS spawn's git at the fleet hooks dir via
 * `GIT_CONFIG_*`, blocking `git push` (see FLEET_PRE_PUSH_HOOK). Injected into
 * the spawn env only — the shared repo config + the user's / other agents'
 * git are untouched. Composes with any pre-existing `GIT_CONFIG_COUNT` in the
 * env rather than clobbering it. Verified vs git: blocks push, commits still
 * work (pre-push only fires on push).
 */
export function gitConfigNoPushEnv(
  baseEnv: NodeJS.ProcessEnv,
  hooksDir: string,
): Record<string, string> {
  const parsed = Number.parseInt(baseEnv.GIT_CONFIG_COUNT ?? '', 10);
  const n = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: 'core.hooksPath',
    [`GIT_CONFIG_VALUE_${n}`]: hooksDir,
  };
}

/**
 * claude-code-only spawn-env hardening (fleet-coordination-painpoints P-012).
 *
 * Belt-and-suspenders env hardening for claude-code spawns. The PRIMARY P-012
 * fix is {@link writeSpawnClaudeConfig} (an isolated, plugin-free
 * `CLAUDE_CONFIG_DIR`): with no enabled plugins / known marketplaces, claude
 * never resolves an external marketplace source and so can't check a plugin
 * tree out into the worker cwd (the "empty config stubs" bug — root-caused via
 * live strace to claude-code's `git clone --no-checkout` + `git checkout <sha>`
 * whose work-tree is the process cwd). These env vars are secondary defense:
 *   - `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1` — never
 *     bootstrap/clone the official marketplace during a spawn (the only git
 *     activity a plugin-free config could still trigger).
 *   - `DISABLE_AUTOUPDATER=1` — stops the binary self-updater. NOTE: this does
 *     NOT gate the marketplace refresh (verified against the 2.1.161 binary —
 *     the refresh is gated by a per-marketplace `autoUpdate` flag, not this
 *     var); it was the prior, ineffective sole fix and is kept only as cheap
 *     hygiene. Do not rely on it to prevent the leak.
 * Returns `{}` for any non-claude backend (codex/omp have no plugin marketplace).
 */
export function claudeSpawnEnvHardening(agentBackend: AgentBackend): Record<string, string> {
  if (agentBackend !== 'claude-code') return {};
  return {
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    DISABLE_AUTOUPDATER: '1',
  };
}

/**
 * Phase E (P-051 / D-008): resolve the per-spawn `HOME` for a child agent.
 *
 * In the shared-operator model — signaled by `PAPERCUSP_SHARED_OPERATOR=1`,
 * which only the new desktop shell sets — ONE sidecar serves many workspaces
 * under a neutral process HOME (the real user home). Each spawned child must
 * therefore get its OWN workspace's HOME so filesystem credentials resolve
 * per-workspace: `~/.claude` (Claude session) + `~/.gitconfig` (git identity),
 * which the shell provisions into every workspace dir
 * (`workspaces.rs::link_workspace_credentials`).
 *
 * Returns the workspace HOME dir, or `null` to leave the inherited process HOME
 * untouched. `null` when: not the shared-operator model (dev / standalone / the
 * legacy per-process-HOME packaged build — D-009: never flip piecemeal in dev);
 * no workspace bound; the workspace dir isn't provisioned; or the caller
 * already pinned a HOME. (`PAPERCUSP_HOME` — operator *state* — is set
 * separately by the spawn envelope; this is the OS HOME for filesystem creds,
 * which `PAPERCUSP_HOME` does not cover.)
 */
export function resolveSpawnHome(
  workspaceId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  callerHomeOverride?: string,
): string | null {
  if (callerHomeOverride) return null;
  if (env.PAPERCUSP_SHARED_OPERATOR !== '1') return null;
  if (!workspaceId) return null;
  const wsHome = workspaceHomeDir(workspaceId, env);
  return existsSync(wsHome) ? wsHome : null;
}

/**
 * Parse the final assistant text from a structured-stream log file.
 *
 * For `claude-stream-json`: the terminal event is
 *   `{"type":"result","result":"...","total_cost_usd":N,...}`.
 *
 * For `omp-json`: events are `{"type":"message_update", message, assistantMessageEvent}` /
 *   `{"type":"message_end", message: AssistantMessage}` / `{"type":"agent_end", messages}`.
 *   The final assistant text is the last assistant `message_end` (or the
 *   `done` assistantMessageEvent), reconstructed from the message's text content blocks.
 *
 * For `none`: returns the file contents verbatim (matches old fallback).
 */
/**
 * Extract the final assistant text from accumulated stream-json content.
 * Either pass the raw content directly, or a filesystem path (back-compat
 * for callers that still keep the JSONL on disk).
 */
export function extractResult(source: string, format: StreamFormat): string {
  // Heuristic: a string with no newlines that exists as a path → treat as path.
  // Any other input is treated as content directly. Callers that want to be
  // explicit can use extractResultFromContent.
  let data = '';
  if (source.length > 0 && !source.includes('\n') && existsSync(source)) {
    try { data = readFileSync(source, 'utf8'); } catch { return ''; }
  } else {
    data = source;
  }
  if (format === 'none') return data;

  const lines = data.trimEnd().split(/\r?\n/);

  if (format === 'loop-ndjson') {
    // The owned loop's terminal `done` event carries the final text. Walk
    // backward so a future trailing metadata/event line cannot obscure it.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object' && obj.type === 'done' && typeof obj.finalText === 'string') {
          return obj.finalText;
        }
      } catch { /* tolerate a malformed/interleaved line */ }
    }
    // Crash/error salvage mirrors omp-json: text_delta is already ordered and
    // belongs to the in-flight assistant response when no terminal done exists.
    let partial = '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object' && obj.type === 'text_delta' && typeof obj.text === 'string') {
          partial += obj.text;
        }
      } catch { /* skip malformed lines */ }
    }
    return partial.trim();
  }

  if (format === 'claude-stream-json') {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object' && obj.type === 'result' && typeof obj.result === 'string') {
          return obj.result;
        }
      } catch { /* claude can interleave non-JSON occasionally */ }
    }
    // Partial-output salvage (agent-turn-robustness, Brief 49): no terminal `result`
    // event means the stream was truncated mid-turn (crash / timeout / SIGKILL). The
    // partial stream still carries the agent's work — complete assistant messages
    // arrive as {"type":"assistant","message":{content:[{type:"text",text}]}} events,
    // and the in-flight message (we spawn with --include-partial-messages) streams as
    // {"type":"stream_event","event":{"type":"content_block_delta","delta":
    // {"type":"text_delta","text"}}}. Reconstruct best-effort text so a crashed turn's
    // out_body shows WHAT the agent was doing instead of '' — the UI run view, gym
    // collectors, and the debugger all read out_body. The terminal-result path above is
    // unchanged; salvage only fires when it found nothing. NOTE: a crashed run is never
    // REUSED off this salvaged output — findPriorRunForIdempotency re-spawns on a
    // non-zero exit.
    let lastAssistant = '';
    let trailingPartial = '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      if (!obj || typeof obj !== 'object') continue;
      if (obj.type === 'assistant') {
        const text = typeof obj.message === 'string' ? obj.message : collectAssistantText(obj.message);
        // A completed message folds in the deltas that streamed before it — reset the
        // partial accumulator so its text isn't double-counted.
        if (text) { lastAssistant = text; trailingPartial = ''; }
      } else if (obj.type === 'stream_event') {
        const ev = obj.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
          trailingPartial += ev.delta.text;
        }
      }
    }
    return [lastAssistant, trailingPartial.trim()].filter(Boolean).join('\n');
  }

  if (format === 'codex-json') {
    // `codex exec --json` JSONL: the assistant's text arrives as one or
    // more `{type:'item.completed', item:{type:'agent_message', text}}`
    // events (codex emits no single terminal `result`). Concatenate them
    // in order — the decision verb the orchestrator greps for is in this
    // text just like the claude/omp paths.
    const parts: string[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      if (
        obj && typeof obj === 'object'
        && obj.type === 'item.completed'
        && obj.item && typeof obj.item === 'object'
        && obj.item.type === 'agent_message'
        && typeof obj.item.text === 'string'
      ) {
        parts.push(obj.item.text);
      }
    }
    return parts.join('').trim();
  }

  // omp-json: walk from the end, find the last message_end / done /
  // agent_end carrying an assistant message. Pull text-content blocks.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;

    // Direct message_end with the final assistant message.
    if (obj.type === 'message_end' && obj.message?.role === 'assistant') {
      const text = collectAssistantText(obj.message);
      if (text) return text;
    }
    // assistantMessageEvent.type === 'done' carries the final message too.
    if (
      obj.type === 'message_update'
      && obj.assistantMessageEvent?.type === 'done'
      && obj.assistantMessageEvent.message
    ) {
      const text = collectAssistantText(obj.assistantMessageEvent.message);
      if (text) return text;
    }
    // agent_end has the full messages list — last assistant entry wins.
    if (obj.type === 'agent_end' && Array.isArray(obj.messages)) {
      for (let j = obj.messages.length - 1; j >= 0; j--) {
        const m = obj.messages[j];
        if (m?.role === 'assistant') {
          const text = collectAssistantText(m);
          if (text) return text;
          break;
        }
      }
    }
  }
  // Partial-output salvage (agent-turn-robustness, Brief 49): no complete assistant
  // message anywhere (message_end / done / agent_end) — the omp stream was truncated
  // mid-FIRST-message. Every text_delta in the log therefore belongs to that one
  // in-flight message (a completed message would have hit the walk above), so
  // concatenating them reconstructs the partial text.
  let partial = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    if (obj.type === 'message_update' && obj.assistantMessageEvent?.type === 'text_delta' && typeof obj.assistantMessageEvent.delta === 'string') {
      partial += obj.assistantMessageEvent.delta;
    }
  }
  return partial.trim();
}

/** Concatenate text-typed content blocks from an omp/pi-ai assistant message. */
function collectAssistantText(message: any): string {
  if (!message || !Array.isArray(message.content)) return '';
  const parts: string[] = [];
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('').trim();
}

/** Initialize the empty memory files bash creates on first invocation. */
function ensureMemoryFiles(stateDir: string): void {
  const memDir = join(stateDir, 'memory');
  if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });
  for (const f of ['raw.md', 'summary.md', 'MEMORY.md']) {
    const p = join(memDir, f);
    if (!existsSync(p)) writeFileSync(p, '');
  }
}

/**
 * Run the agent CLI (`omp -p` default, `claude -p` opt-in, or override) for a
 * given role. Returns the captured result.
 *
 * Pipes the assembled prompt to stdin; captures stream-json (or plain text)
 * to <logDir>/<runId>.jsonl, stderr to .err. Final result text is extracted
 * to .out for the orchestrator's decision parser.
 */
/**
 * Optional overrides for ad-hoc invocations (chunk-loop driver, etc.).
 * `inlinePrompt` short-circuits the prompt-file resolution — useful
 * when the caller has built the prompt programmatically and doesn't
 * want to write it to disk first. `cwd` overrides the working
 * directory the agent runs in (otherwise inferred from
 * `ctx.worktreePathFor` based on the FEATURE_ID extra).
 */
export interface InvokeOptions {
  inlinePrompt?: string;
  cwd?: string;
  /**
   * Parent spawn ID, set when this `invoke()` was triggered by another
   * agent's `orchestrator.spawn` MCP-tool call (Phase 9). Null/undefined
   * for orchestrator main-loop spawns. Plumbed through to the per-spawn
   * `.mcp.json` so plugin-tool calls from this child carry the lineage.
   */
  parentSpawnId?: string | null;
  /**
   * Extra env vars to inject into the spawned agent's process. The
   * operator passes decrypted search-provider keys (Migration 047) here
   * so workers/validators/scoper/architect can use OMP's web_search
   * providers. The orchestrator itself doesn't reach into operator
   * state — the caller (operator) computes these and passes them in.
   */
  extraEnv?: Record<string, string>;
  /**
   * Optional AbortSignal. When aborted, the spawn flow sends SIGTERM
   * to the child agent process (then SIGKILL after 2s grace via the
   * existing timeout path). Used by Phase 9's orchestrator.spawn
   * primitive to implement `orchestrator.cancel`.
   */
  signal?: AbortSignal;
  /**
   * Idempotency key (dbos-durable-jobs-2026-05-31 Phase 3, P-015). When set, it
   * is used as the run ID so the `harness_run_output` record is keyed
   * deterministically across re-invocations (e.g. a DBOS workflow step re-running
   * after a crash). Before spawning, invoke() checks for a completed run under
   * this key and, if found, returns the prior result WITHOUT re-spawning the
   * agent — so wrapping invoke() as a durable step can't double-run a completed
   * agent. Opt-in: unset (every current caller) keeps the timestamped run-id and
   * always spawns, so existing behaviour is unchanged.
   */
  idempotencyKey?: string;
}

/**
 * Idempotency short-circuit (dbos-durable-jobs-2026-05-31 Phase 3, P-015): look
 * up a prior COMPLETED run under `runId` (= the supplied idempotencyKey) and
 * reconstruct its InvokeResult so the caller can skip re-spawning the agent.
 * Returns null when no prior run exists (→ proceed to spawn). Exported for direct
 * unit testing. Takes primitives (no ctx) so a fake `pg` is enough to exercise it.
 */
export async function findPriorRunForIdempotency(
  pg: OrchestratorPg,
  workspaceId: string,
  harnessSlug: string,
  runId: string,
  role: string,
  log: (m: string) => void,
): Promise<InvokeResult | null> {
  let prior;
  try {
    const { readRunOutputPg } = await import('./run-output-pg');
    prior = await readRunOutputPg({ pg, workspaceId, harnessSlug }, runId);
  } catch (err) {
    log(`  idempotency lookup failed (non-fatal, proceeding to spawn): ${(err as Error).message}`);
    return null;
  }
  if (!prior) return null;
  // An empty-output prior run is not a meaningful completed run (the agent
  // emitted nothing → did no work). Reusing it would poison a DBOS decide-step
  // retry / a re-trigger with the empty result, so a transient empty (e.g. claude
  // returning nothing under concurrent load) could never recover (P-010). Treat
  // it as "no prior run" so the caller re-spawns.
  if (!prior.outBody.trim()) {
    log(`invoke ${role} prior run ${runId} had empty output — not reusing, will re-spawn`);
    return null;
  }
  // A crashed prior run (non-zero exit) is not a meaningful completed run either: its
  // out_body may carry SALVAGED partial output (see extractResult's no-terminal-event
  // fallback) — debugging signal, not a result. Reusing it would hand the same failure
  // back to every DBOS step retry (the retry exists to get a FRESH attempt), so a
  // transient crash could never recover. Re-spawn instead.
  if (prior.exitCode !== 0) {
    log(`invoke ${role} prior run ${runId} exited ${prior.exitCode} — not reusing, will re-spawn`);
    return null;
  }
  log(`invoke ${role} idempotent hit (runId=${runId}, rc=${prior.exitCode}) — reusing prior run, no re-spawn`);
  return {
    output: prior.outBody.replace(/\n$/, ''),
    jsonlPath: '',
    outPath: '',
    exitCode: prior.exitCode,
    durationMs: prior.durationMs,
  };
}

/**
 * Resolve the slug advertised in the substrate-context "## Your harness" banner
 * (EI-787). Pure/testable extraction of the resolution order the banner uses:
 * prefer `harnessSlugFromProjectDir` (the SAME resolver every other operator-API
 * call in `invoke()` already uses — it prefers the pipeline-injected
 * $HARNESS_SLUG/$PAPERCUSP_HARNESS_SLUG, the authoritative REGISTRY slug, before
 * ever falling back to the directory basename), falling back to the harness
 * config's own `slug` field only if that resolver throws or returns empty.
 *
 * Before this, the banner read `cfg.slug` (or the raw projectDir basename)
 * FIRST — on a harness whose config `slug` / directory basename diverges from
 * the registry slug (observed on a benchmark member harness: dir/config slug
 * `extbench-q1ubTg` vs registry slug `xbq72ugvaz…`), the banner advertised a
 * slug that work_items tools / the `/api/harness/<slug>/...` route reject as "unknown project",
 * costing ~4 wasted tool calls before the agent found the real slug via
 * GET /api/harness/projects.
 */
export function resolveSubstrateSelfSlug(cfg: HarnessConfig, projectDir: string): string {
  let selfSlug = '';
  try {
    selfSlug = harnessSlugFromProjectDir(projectDir);
  } catch { /* fall through to the config fallback below */ }
  if (!selfSlug) selfSlug = configGet<string>(cfg, 'slug', '');
  return selfSlug;
}

/** Copy the canonical Codex window pair already present on the actual launch
 * argv into a per-spawn CODEX_HOME. Policy stays in operator-core's
 * model-context-budget.mjs; this lower layer only recognizes the two exact
 * config overrides it was handed. A partial/invalid pair is ignored. */
export function codexContextConfigFromArgv(argv: readonly string[]): SpawnCodexContextConfig | null {
  const values = new Map<string, number>();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '-c') continue;
    const entry = argv[i + 1] ?? '';
    const match = /^(model_context_window|model_auto_compact_token_limit)=(\d+)$/.exec(entry);
    if (!match) continue;
    const value = Number(match[2]);
    if (Number.isSafeInteger(value) && value > 0) values.set(match[1], value);
    i += 1;
  }
  const modelContextWindow = values.get('model_context_window');
  const modelAutoCompactTokenLimit = values.get('model_auto_compact_token_limit');
  if (modelContextWindow == null || modelAutoCompactTokenLimit == null) return null;
  if (modelAutoCompactTokenLimit >= modelContextWindow) return null;
  return { modelContextWindow, modelAutoCompactTokenLimit };
}

interface InvokeExecutionBodies {
  rawJsonlBody: string;
  errBody: string;
  outcome: SpawnOutcome;
  startedAt: number;
}

/** Execute one owned-loop turn and project its native events onto the SAME
 * NDJSON chunk stream the subprocess path persists/publishes. */
async function runOwnedLoopInvocation(args: {
  ctx: InvokeContext;
  port: OwnedLoopInvokePort;
  role: string;
  prompt: string;
  model: string;
  runId: string;
  featureId: string | null;
  chunkId: string | null;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<InvokeExecutionBodies> {
  const { ctx } = args;
  if (!ctx.workspaceId) {
    throw new Error('invoke: aiBackend engine=loop requires ctx.workspaceId');
  }
  const harnessSlug = harnessSlugFromProjectDir(ctx.projectDir);
  const startedAt = Date.now();
  const jsonlChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  const persistChunks = process.env.PAPERCUSP_PERSIST_CHUNKS === '1';

  let harnessToken: string | null = null;
  try {
    const cfgRaw = readFileSync(`${ctx.stateDir}/config.json`, 'utf8');
    const cfgJson = JSON.parse(cfgRaw) as { harness_token?: string };
    if (typeof cfgJson.harness_token === 'string' && cfgJson.harness_token.length > 0) {
      harnessToken = cfgJson.harness_token;
    }
  } catch { /* tokenless CLI/test path: persistence still captures the body */ }

  type ChunkPgCtx = { pg: OrchestratorPg; workspaceId: string; harnessSlug: string };
  let chunksPgCtx: ChunkPgCtx | null = null;
  let appendChunkPgFn:
    | ((c: ChunkPgCtx, runId: string, seq: number, data: string) => Promise<void>)
    | null = null;
  if (persistChunks && ctx.pg) {
    chunksPgCtx = { pg: ctx.pg, workspaceId: ctx.workspaceId, harnessSlug };
    appendChunkPgFn = (await import('./run-chunks-pg')).appendChunkPg;
  }

  let chunkSeq = 0;
  let chunkPostQueue: Promise<void> = Promise.resolve();
  let chunkPgQueue: Promise<void> = Promise.resolve();
  let sawErrorEvent = false;
  const emit = (event: unknown) => {
    let data: string;
    try {
      data = `${JSON.stringify(event)}\n`;
    } catch (error) {
      data = `${JSON.stringify({
        type: 'error',
        message: `owned-loop event was not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
      })}\n`;
    }
    try {
      const parsed = JSON.parse(data) as { type?: unknown };
      if (parsed.type === 'error') sawErrorEvent = true;
    } catch { /* data was produced above and is valid JSON */ }
    jsonlChunks.push(Buffer.from(data));
    const seq = chunkSeq++;
    if (harnessToken) {
      chunkPostQueue = chunkPostQueue.then(async () => {
        try {
          await fetch(`${operatorBase}/api/internal/run-chunk`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${harnessToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ runId: args.runId, seq, chunk: data }),
          });
        } catch { /* best-effort live delivery */ }
      });
    }
    if (chunksPgCtx && appendChunkPgFn) {
      chunkPgQueue = chunkPgQueue.then(() =>
        appendChunkPgFn!(chunksPgCtx!, args.runId, seq, data));
    }
  };

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (args.signal) {
    if (args.signal.aborted) controller.abort();
    else args.signal.addEventListener('abort', onAbort, { once: true });
  }
  let timedOut = false;
  const timer = args.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, args.timeoutMs)
    : undefined;

  let exitCode = 1;
  try {
    const result = await args.port.invoke({
      role: args.role,
      prompt: args.prompt,
      model: args.model,
      runId: args.runId,
      featureId: args.featureId,
      chunkId: args.chunkId,
      workspaceId: ctx.workspaceId,
      harnessSlug,
      projectDir: ctx.projectDir,
      stateDir: ctx.stateDir,
      cwd: args.cwd,
      signal: controller.signal,
      emit,
    });
    exitCode = timedOut ? 124 : result.exitCode;
    if (result.stderr) errChunks.push(Buffer.from(result.stderr));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errChunks.push(Buffer.from(message));
    if (!sawErrorEvent) emit({ type: 'error', message });
    exitCode = timedOut ? 124 : 1;
  } finally {
    if (timer) clearTimeout(timer);
    if (args.signal) args.signal.removeEventListener('abort', onAbort);
  }

  await chunkPostQueue.catch(() => {});
  if (harnessToken) {
    try {
      await fetch(`${operatorBase}/api/internal/run-chunk`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${harnessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ runId: args.runId, seq: chunkSeq, chunk: '', done: true }),
      });
    } catch { /* best-effort close */ }
  }
  await chunkPgQueue.catch(() => {});

  return {
    rawJsonlBody: Buffer.concat(jsonlChunks).toString('utf8'),
    errBody: Buffer.concat(errChunks).toString('utf8'),
    outcome: { exitCode, durationMs: Date.now() - startedAt },
    startedAt,
  };
}

/** Shared result extraction, run-output persistence, usage capture, and
 * artifact fallback for subprocess and owned-loop executions. */
async function finalizeInvocation(args: {
  ctx: InvokeContext;
  role: string;
  prompt: string;
  promptHash: string;
  runId: string;
  featureId: string | null;
  streamFormat: StreamFormat;
  runBackend: string;
  resolvedModel: string;
  requestedModel: string;
  jsonlPath: string;
  outPath: string;
  errPath: string;
  rawJsonlBody: string;
  errBody: string;
  outcome: SpawnOutcome;
  startedAt: number;
  timeoutSeconds: number;
  retainReleaseFixerFiles: boolean;
}): Promise<InvokeResult> {
  const finalText = extractResult(args.rawJsonlBody, args.streamFormat);
  const effectiveExitCode = resolveInvocationExitCode(
    args.outcome.exitCode,
    args.rawJsonlBody,
    args.streamFormat,
  );
  if (args.runBackend === 'codex' && args.streamFormat === 'codex-json') {
    try {
      const { writeCodexTranscript } = await import('./codex-transcript');
      const teePath = writeCodexTranscript({
        sessionId: process.env.PAPERCUSP_NATIVE_SESSION_ID,
        prompt: args.prompt,
        rawJsonl: args.rawJsonlBody,
      });
      if (teePath) args.ctx.log(`  codex transcript → ${teePath}`);
    } catch { /* the tee must never fail the run */ }
  }
  const outBody = args.streamFormat !== 'none' ? `${finalText}\n` : finalText;
  const streamSummary = summarizeInvocationStream(args.rawJsonlBody, args.streamFormat, finalText);
  const jsonlBody =
    args.streamFormat === 'none'
      ? args.rawJsonlBody
      : `${args.rawJsonlBody}${args.rawJsonlBody.length === 0 || args.rawJsonlBody.endsWith('\n') ? '' : '\n'}${JSON.stringify(
          {
            type: 'papercusp.run_meta',
            schemaVersion: 'worker-parity-v1',
            backend: args.runBackend,
            engine: args.runBackend === 'owned-loop' ? 'loop' : 'subprocess',
            model: args.resolvedModel,
            requestedModel: args.requestedModel,
            role: args.role,
            runId: args.runId,
            featureId: args.featureId,
            promptHash: args.promptHash,
            stream: streamSummary,
          },
        )}\n`;

  const writeFilesForFallback = args.retainReleaseFixerFiles || !(args.ctx.pg && args.ctx.workspaceId)
    || process.env.PAPERCUSP_KEEP_FILES === '1';
  if (writeFilesForFallback) {
    if (!existsSync(args.ctx.logDir)) mkdirSync(args.ctx.logDir, { recursive: true });
    writeFileSync(args.jsonlPath, jsonlBody);
    writeFileSync(args.errPath, args.errBody);
    writeFileSync(args.outPath, outBody);
  }

  if (args.ctx.pg && args.ctx.workspaceId) {
    try {
      const { recordRunOutputPg } = await import('./run-output-pg');
      const { harnessSlug: getSlug } = await import('./state');
      await recordRunOutputPg(
        { pg: args.ctx.pg, workspaceId: args.ctx.workspaceId, harnessSlug: getSlug(args.ctx.projectDir) },
        {
          runId: args.runId,
          role: args.role,
          promptBody: args.prompt,
          jsonlBody,
          outBody,
          errBody: args.errBody,
          exitCode: effectiveExitCode,
          durationMs: args.outcome.durationMs,
          startedAt: args.startedAt,
          endedAt: Date.now(),
        },
      );
    } catch (error) {
      args.ctx.log(`  PG ingest failed (non-fatal): ${(error as Error).message}`);
    }
    try {
      const { extractRunUsage } = await import('./cost-cap');
      const usage = extractRunUsage(jsonlBody);
      if (usage) {
        const { recordUsageSamplePg } = await import('./usage-sample-pg');
        const { harnessSlug: getSlug } = await import('./state');
        await recordUsageSamplePg(
          { pg: args.ctx.pg, workspaceId: args.ctx.workspaceId },
          {
            backend: args.runBackend,
            model: args.resolvedModel,
            usage,
            harnessSlug: getSlug(args.ctx.projectDir),
            runId: args.runId,
            role: args.role,
            sessionId: args.runBackend === 'owned-loop'
              ? undefined
              : process.env.PAPERCUSP_NATIVE_SESSION_ID,
            turnTrigger: process.env.PAPERCUSP_TURN_TRIGGER,
            accountId: process.env.PAPERCUSP_ACCOUNT_ID,
          },
        );
      }
    } catch (error) {
      args.ctx.log(`  usage-sample ingest failed (non-fatal): ${(error as Error).message}`);
    }
  }

  args.ctx.log(`invoke ${args.role} rc=${effectiveExitCode} (stdout: ${args.outPath})`);
  if (effectiveExitCode === 124) {
    args.ctx.log(`  role=${args.role} TIMED OUT after ${args.timeoutSeconds}s (rc=124)`);
  }
  if (effectiveExitCode !== 0) {
    const errSnippet = args.errBody.split(/\r?\n/).slice(0, 5);
    if (errSnippet.some((line) => line.length > 0)) {
      args.ctx.log('  stderr (first 5 lines):');
      for (const line of errSnippet) {
        if (line.length > 0) args.ctx.log(`    ${line}`);
      }
    }
  }

  return {
    output: finalText,
    jsonlPath: args.jsonlPath,
    outPath: args.outPath,
    exitCode: effectiveExitCode,
    durationMs: args.outcome.durationMs,
  };
}

export async function invoke(
  ctx: InvokeContext,
  role: string,
  extras: readonly string[] = [],
  options: InvokeOptions = {},
): Promise<InvokeResult> {
  const cfg = readEffectiveConfig(ctx.stateDir);
  const dept = ctx.dept ?? configGet<string>(cfg, 'dept', '');
  const executionEngine = resolveAgentExecutionEngine(cfg, role);
  // A program launch names a blueprint already addressable below a prompt root.
  // A normal harness launch instead names its own `.papercusp/blueprint.yaml`;
  // preserve that file's resolved parent chain because the file itself is NOT at
  // `blueprints/<id>/blueprint.yaml` and cannot be rediscovered from id alone.
  const explicitBlueprintId =
    extras.find((e) => e.startsWith('BLUEPRINT_ID='))?.slice('BLUEPRINT_ID='.length) || undefined;
  const harnessBlueprintPrompt = explicitBlueprintId
    ? undefined
    : loadHarnessBlueprintPromptContext(ctx.stateDir);
  const promptBlueprintId = explicitBlueprintId ?? harnessBlueprintPrompt?.blueprintId;
  const promptExtendsChain = explicitBlueprintId
    ? undefined
    : harnessBlueprintPrompt?.extendsChain;

  // 1. Resolve prompt file (with phase + dept fallback chain), unless
  //    the caller supplied an inlinePrompt — in which case we skip the
  //    file resolution entirely and pass the inline string through to
  //    buildPrompt as-is.
  let promptFile = '';
  let promptFiles: string[] = [];
  if (!options.inlinePrompt) {
    // A program-blueprint spawn (coordination-ops-as-blueprint-primitives) passes
    // BLUEPRINT_ID=<id> so a program role (voter/advocate) resolves its prompt from
    // blueprints/<id>/prompts/<role>.md. Absent for the normal pipeline.
    // Per-hive local-tier roots (P-012/P-014): a hive's materialized override prompts
    // win over the built-in blueprint. Absent ⇒ [] ⇒ built-in-only (unchanged).
    const blueprintRoots = parseBlueprintLocalRoots(extras);
    // Layered list (base/<role>.md first when present — audit P-019), the
    // concrete most-specific prompt last.
    promptFiles = resolvePromptFiles(
      {
        harnessDir: ctx.harnessDir,
        phase: ctx.phase,
        dept,
        blueprintId: promptBlueprintId,
        extendsChain: promptExtendsChain,
        blueprintRoots,
      },
      role,
    );
    if (promptFiles.length === 0) {
      const where = promptBlueprintId
        ? `${ctx.harnessDir}/blueprints/${promptBlueprintId}/prompts or ${ctx.harnessDir}/blueprints/base/prompts`
        : `${ctx.harnessDir}/blueprints/base/prompts`;
      throw new Error(`invoke: no prompt file for role=${role} (looked under ${where})`);
    }
    // The most-specific file stays the run-record's promptFile (stable reporting).
    promptFile = promptFiles[promptFiles.length - 1];
  }

  // 2. Feature ID + run ID. An idempotency key (P-015) is used as the run ID so
  //    the record is keyed deterministically across re-invocations; without it
  //    the run ID stays timestamped (every current caller).
  const featureId = extractFeatureId(extras);
  // An accepted operation carries a pinned restricted identity and tool set.
  // This legacy path builds neither its launch artifact nor an adv_sessions
  // grant receipt, so letting it spawn would grant the worker ordinary role
  // authority before any MCP policy check. The role bootstrap path binds the
  // receipt; autonomous operation launch must do the same before using invoke.
  if (featureId && ctx.pg && ctx.workspaceId) {
    await assertNoUnboundAcceptedOperation({
      pg: ctx.pg, workspaceId: ctx.workspaceId,
      harnessSlug: harnessSlugFromProjectDir(ctx.projectDir), featureId,
    });
  }
  const invocationChunkId = extractChunkId(extras);
  const featureTag = featureId ? `-${featureId}` : '';
  const nowSec = (ctx.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  const runId = options.idempotencyKey ?? makeRunId(role, featureId, nowSec);

  // 2a. Idempotent short-circuit (P-015): reuse a prior completed run under this
  //     key instead of re-spawning. The guard that lets invoke() be wrapped as a
  //     durable DBOS step — a crash that re-runs a COMPLETED invoke returns the
  //     prior result, not a second agent run. An *interrupted* run leaves no row
  //     (written at run end), so it re-spawns on resume; re-spawn-fresh is the
  //     policy (D-003: the agent re-reads git state, so git is the dedup). Opt-in.
  if (options.idempotencyKey && ctx.pg && ctx.workspaceId) {
    const { harnessSlug: getSlug } = await import('./state');
    const prior = await findPriorRunForIdempotency(
      ctx.pg, ctx.workspaceId, getSlug(ctx.projectDir), runId, role, ctx.log,
    );
    if (prior) return prior;
  }

  // 3. Worktree cwd override. Caller's `options.cwd` wins; otherwise
  //    we infer from the registered worktreePathFor + the FEATURE_ID
  //    extra.
  let cwdOverride = '';
  if (options.cwd && existsSync(options.cwd)) {
    cwdOverride = options.cwd;
  } else if (featureId && ctx.worktreePathFor) {
    const wt = ctx.worktreePathFor(featureId) ?? '';
    if (wt && existsSync(wt)) cwdOverride = wt;
  }

  // 4. Backend-aware structured-stream detection. Defaults to inferring
  //    from the binary name in claudeCmd (omp/pi → omp, otherwise claude-code).
  //    Per-role / per-harness aiBackend config can override the agent
  //    command (and append extraArgs) — falls back to ctx.claudeCmd which
  //    came from process env (AGENT_CMD / CLAUDE).
  const { agentCmd: roleAgentCmd, extraArgs: roleExtraArgs } =
    resolveAgentForRole(cfg, role, ctx.claudeCmd);
  if (roleAgentCmd !== ctx.claudeCmd) {
    ctx.log(`  role=${role} agentCmd=${roleAgentCmd} (from config.json)`);
  }
  const agentBackend: AgentBackend = ctx.agentBackend ?? resolveAgentBackend(roleAgentCmd);
  const argv = normalizeExplicitModelFlagsForBackend(splitCommand(roleAgentCmd), agentBackend);
  const streamFormat: StreamFormat = executionEngine === 'loop'
    ? 'loop-ndjson'
    : selectStreamFormat(agentBackend, roleAgentCmd);
  // Fleet sandboxing is an operator/workspace boundary, not a process-wide
  // default that standalone CLI callers should inherit. Resolve it once for
  // this subprocess invocation so every sandbox leg agrees on the same scope.
  // Owned-loop calls do not spawn a child and therefore do not need srt.
  const workspaceAgentSpawn =
    executionEngine === 'subprocess' && Boolean(ctx.workspaceId);
  const fleetSandboxForSpawn = workspaceAgentSpawn && fleetSandboxEnabled();
  const fleetSrtBin =
    fleetSandboxForSpawn && backendUsesSrt(agentBackend) ? srtBinOnPath() : null;
  if (fleetSandboxForSpawn && backendUsesSrt(agentBackend) && !fleetSrtBin) {
    // Keep this rejection outside the async spawn executor. A throw inside
    // `new Promise(async (resolve) => ...)` becomes an unhandled rejection
    // instead of the invoke() promise's failure result.
    throw new Error(
      `PAPERCUSP_FLEET_SANDBOX is set for a ${agentBackend} spawn but \`srt\` is not on PATH. ` +
        'Install @anthropic-ai/sandbox-runtime (npm i -g @anthropic-ai/sandbox-runtime) ' +
        'or set PAPERCUSP_FLEET_SANDBOX=0.',
    );
  }
  const ownedLoopPort = ctx.ownedLoop;
  const extraFlags: string[] = [...streamFormatFlags(streamFormat)];
  if (agentBackend === 'codex' && streamFormat === 'codex-json' && argv.includes('exec')) {
    const execIdx = extraFlags.indexOf('exec');
    if (execIdx >= 0) extraFlags.splice(execIdx, 1);
  }

  // codex sandbox policy (plan fleet-spawn-sandbox Phase 2) — flag-gated
  // workspace-write vs the prior danger-full-access default. Goes in extraFlags
  // (before the `-` stdin positional) because codex wants options before the prompt.
  extraFlags.push(...codexSandboxArgs(agentBackend, streamFormat, roleAgentCmd, fleetSandboxForSpawn));

  // omp leg of the B-18 capability-only cutover (P-034): under the cutover, restrict
  // omp to its read-only native built-ins via `--tools`, so native execution /
  // mutation / egress route through the gated capability:* MCP tools instead — the
  // omp analog of claude's --allowed-tools cut. No-op for non-omp / disarmed / a role
  // without capability:* / when AGENT_CMD sets --tools. Before the `@promptfile`.
  extraFlags.push(...fleetOmpToolsArgs(agentBackend, roleAgentCmd, role, fleetCapabilityOnlyEnabled()));

  // Native-scheduler lockout (native-scheduler-lockout-2026-06-09 D-001/D-005):
  // every headless claude agent spawn loses claude-code's own scheduling
  // surfaces, so wakes can only live in the harness routines table. Applied at
  // the exec boundary so per-role agentCmd swaps (resolveAgentForRole) are
  // covered too; an explicit operator-supplied deny list wins (D-004). The
  // command must actually NAME claude (same discriminator as
  // selectStreamFormat) — 'claude-code' is the DEFAULT backend label even for
  // arbitrary commands (e.g. the plain-text test stub `cat`), which must not
  // receive a claude flag.
  if (
    harnessSupports(agentBackend, 'subagent-tools') &&
    splitCommand(roleAgentCmd).some((a) => a.includes('claude'))
  ) {
    // ONE capability policy (P-005) resolves EVERY native restriction for this
    // client/surface — subagent fanout, native tool-search, owner-desktop
    // notification, native scheduler — together with their aliases, their nested
    // routes (`Bash(crontab:*)` reaches the OS scheduler without touching
    // CronCreate) and their overrides. It replaces the hand-listed sequence of
    // four *DenyFlag() pushes that used to live here.
    //
    // Why a policy and not four pushes: this site pushed all four while the WAKE
    // path (events/await/wake-executor.ts) pushed only three, so a woken agent
    // silently regained `notify-send` — a restriction that read as enforced at
    // every launch and quietly lapsed on the first wake. Each site read healthy
    // alone, which is exactly why nothing caught it. Composing the set in one
    // place makes that drift unrepresentable rather than merely fixed.
    //
    // Per-restriction authority is preserved, not flattened: the subagent deny is
    // unconditional (owner mandate 2026-07-02 — headless has no `--allow-subagents`
    // opt-in), while the scheduler deny still yields to an explicit
    // operator-supplied deny list (D-004), which is what `explicitDenyList` carries.
    // claude UNIONS repeated `--disallowedTools` occurrences, so these still compose
    // with any operator/Layer-A (claudeMcpArgs) deny rather than overriding it.
    extraFlags.push(
      ...capabilityPolicyFlags({
        client: 'claude',
        surface: 'launch',
        audience: 'headless-agent',
        explicitDenyList: hasExplicitDisallowedTools(roleAgentCmd),
      }),
    );
  }

  // 5. Per-role model — only inject if user didn't already pass one.
  //    codex's model flag is `-m` (bare id); claude/omp use `--model`.
  const modelFlag = harnessProfile(agentBackend).modelFlag;
  const cmdAlreadyHasModel = roleAgentCmd.includes('--model ') || /(?:^|\s)-m\s/.test(roleAgentCmd);
  // OMP gateway routing (P-006/D-008): when this spawn is pinned through the gateway,
  // resolveSpawnGatewayEnv emitted PAPERCUSP_OMP_MODEL_SELECTOR (`papercusp-gateway/<model>`)
  // alongside the models.yml. Force-select that dedicated provider — it MUST win over any
  // role/AGENT_CMD `--model`, because a built-in id (e.g. `claude-sonnet-4`) resolves to a
  // cloud gateway BEFORE a models.yml override applies (D-006). So strip any explicit model
  // from argv and append ONLY the gateway selector. Empty (dormant) unless the omp seeder
  // is active — the matching `<HOME>/.omp/agent/models.yml` is written by the seeder block below.
  const ompGatewaySelector =
    executionEngine === 'subprocess'
    && harnessSupports(agentBackend, 'gateway-models-yml')
    && (process.env.PAPERCUSP_OMP_MODELS_YML ?? '').trim()
      ? (process.env.PAPERCUSP_OMP_MODEL_SELECTOR ?? '').trim()
      : '';
  // Kept for the usage-telemetry bucket key (step 11.5) — best-effort either way.
  let resolvedModel = '';
  if (executionEngine === 'loop') {
    // The owned ModelPort consumes psu's public `<modelId>[:<effort>]` wire
    // directly. Do not normalize it through whichever subprocess backend the
    // host happens to use — that backend is irrelevant on this leg.
    resolvedModel = resolveModel(cfg, role);
    if (!resolvedModel) {
      throw new Error(`invoke: aiBackend engine=loop for role=${role} requires a model`);
    }
    ctx.log(`  role=${role} engine=loop model=${resolvedModel}`);
  } else if (ompGatewaySelector) {
    stripExplicitModelFlags(argv);
    extraFlags.push('--model', ompGatewaySelector);
    resolvedModel = ompGatewaySelector;
    ctx.log(`  role=${role} omp gateway model=${ompGatewaySelector} (routed via models.yml)`);
  } else if (!cmdAlreadyHasModel) {
    const model = normalizeModelForBackend(resolveModel(cfg, role), agentBackend);
    if (model) {
      resolvedModel = model;
      // claude-code takes effort as its own flag; a suffixed --model drops it
      // (WI-10006244). Every other backend keeps its single model flag.
      if (agentBackend === 'claude-code') extraFlags.push(...claudeModelFlagArgs(model));
      else extraFlags.push(modelFlag, model);
      ctx.log(`  role=${role} model=${model} (from config.json)`);
    }
  } else {
    resolvedModel = explicitModelFromArgv(argv);
  }
  // `resolvedModel` is the transport model used for invocation and cost
  // attribution. OMP gateway routing wraps the public model in a dedicated
  // provider selector (`papercusp-gateway/<model>`), which must not make a
  // same-model parity pair look mismatched. Keep the requested model as a
  // separate wire field while preserving `model` for existing usage readers.
  const requestedModel = ompGatewaySelector
    ? ompGatewaySelector.replace(/^papercusp-gateway\//, '')
    : resolvedModel;

  // 5a. omp spawns get compaction settings via omp's repeatable `--config <file>` overlay
  //     (deterministic-context-carry P-001/P-002; unified by P-022 2026-07-18:
  //     omp's NATIVE strategies — snapcompact et al. — are retired fleet-wide, so
  //     EVERY omp spawn seeds the papercusp mechanical `shake` @70. The P-001
  //     "a gateway-pinned hosted model keeps its native strategy" posture is
  //     superseded — that null branch was the last spawn lane still on
  //     snapcompact, whose image archives + own-backend LLM summarize killed the
  //     ornith session 2026-07-13). Gateway-pinned spawns ALSO carry
  //     remoteEndpoint so any remaining LLM summarization routes to the gateway
  //     maintenance lane. omp THROWS on remoteEndpoint failure (no local
  //     fallback), which is why no other spawn shape gets an endpoint. Overlay
  //     file removed with the other handles on close.
  let ompCompactionOverlay: SpawnOmpConfigOverlayHandle | null = null;
  const ompLocalModel =
    executionEngine === 'subprocess' && agentBackend === 'omp' && isLocalOmpModel(resolvedModel);
  if (ompLocalModel || ompGatewaySelector) {
    try {
      const remoteEndpoint = ompRemoteCompactionEndpoint(process.env.PAPERCUSP_OMP_MODELS_YML);
      ompCompactionOverlay = writeOmpCompactionOverlay({ strategy: 'shake', remoteEndpoint });
      extraFlags.push('--config', ompCompactionOverlay.path);
      ctx.log(
        `  role=${role} omp ${ompLocalModel ? `local model ${resolvedModel}` : 'gateway-pinned'} — compaction overlay (shake @70%, remote ${remoteEndpoint}) via --config`,
      );
    } catch (err) {
      // Fail-soft: the spawn still runs, just on the config's own compaction defaults.
      ctx.log(`  omp compaction overlay failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 5b. Per-role extraArgs from aiBackend.{default,roles[role]}.extraArgs.
  if (roleExtraArgs.length > 0) {
    extraFlags.push(...roleExtraArgs);
  }

  // 6. Timeout.
  const timeoutSeconds = resolveTimeout(cfg, role);
  const timeoutMs = timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined;
  if (timeoutMs) {
    ctx.log(`  role=${role} timeout=${timeoutSeconds}s`);
  }

  // 7. Per-role prompt override — workspace-owned PG store preferred, with a
  //    file/config.json fallback (regression-safe; see resolvePromptOverrideWithStore).
  const promptOverride = await resolvePromptOverrideWithStore(cfg, ctx.stateDir, role, {
    pg: ctx.pg,
    workspaceId: ctx.workspaceId,
    harnessSlug: harnessSlugFromProjectDir(ctx.projectDir),
  });
  if (promptOverride) {
    ctx.log(`  role=${role} prompt-override applied (${promptOverride.length} chars)`);
  }

  // 8. Memory directory exists.
  ensureMemoryFiles(ctx.stateDir);

  // 8.5 Substrate context (Tier 1 + Tier 2 + Tier 3 + bounded supervisor inbox).
  // Best-effort; empty string on any fetch failure. Slug resolution: see
  // resolveSubstrateSelfSlug's docstring (EI-787).
  const selfSlug = resolveSubstrateSelfSlug(cfg, ctx.projectDir);
  const parentSlug = configGet<string>(cfg, 'parent_slug', '') || null;
  let substrateContext = '';
  if (selfSlug) {
    try {
      substrateContext = await fetchSubstrateContext({ selfSlug, parentSlug });
    } catch { /* leave empty */ }
  }

  // 8.6 Feature history — read PG-only (notes + debugger findings + audit
  // transitions). Best-effort; empty when the feature has no recorded
  // history yet OR when ctx.pg/workspaceId are unset (CLI mode without
  // PG bootstrap). Cache-safe: appended at end of prompt by buildPrompt.
  let featureHistory = '';
  if (featureId && ctx.pg && ctx.workspaceId) {
    try {
      const { fetchFeatureHistory } = await import('./feature-history.js');
      const { harnessSlug: getSlug } = await import('./state.js');
      featureHistory = await fetchFeatureHistory({
        pg: ctx.pg,
        workspaceId: ctx.workspaceId,
        harnessSlug: getSlug(ctx.projectDir),
        featureId,
      });
    } catch { /* best-effort; empty section is harmless */ }
  }

  // 8.6b G3 — feature provenance (P-009): look up the feature's `origin`
  // from harness_shared.harness_features_consolidated so buildPrompt can
  // wrap remote-authored content (featureHistory, planContext) in the
  // <untrusted-peer-content> delimiter. Best-effort; defaults to null
  // (treated as local/trusted) on any error or when PG is unavailable.
  //
  // G3 FAIL-OPEN DECISION (security trade-off, documented per G3 audit):
  //
  //   A PG query failure OR a missing row → featureOrigin stays null →
  //   content is treated as LOCAL/TRUSTED → NOT wrapped by wrapUntrusted().
  //
  //   This is an accepted defence-in-depth tradeoff:
  //   - G2 (the pick-gate) is the PRIMARY control — it rejects remote
  //     features before they are dispatched to agents at all. featureOrigin
  //     wrapping is a belt-and-suspenders layer, not the gate itself.
  //   - Pre-G1 rows (features created before the origin column existed)
  //     have null origin in the DB, and they are all local by construction
  //     — they predate the remote-feature ingest path.
  //   - Wrapping unknown-origin content as untrusted would add noise for
  //     the common case (most features are local) while providing minimal
  //     security gain (G2 already blocks remote dispatch).
  //   - A fail-SAFE alternative (wrap unknown as remote) was considered and
  //     rejected because it breaks the worker UX for every pre-G1 harness
  //     at no meaningful security gain (G2 is the gate).
  //
  //   If G2 is ever removed or weakened, revisit this decision and change
  //   the fallback to `'remote'` (fail-safe wrap).
  let featureOrigin: 'local' | 'remote' | null = null;
  if (featureId && ctx.pg) {
    try {
      const { harnessSlug: getSlug } = await import('./state.js');
      const rows = await ctx.pg<{ origin: string | null }[]>`
        SELECT origin
          FROM harness_shared.harness_features_consolidated
         WHERE harness_slug = ${getSlug(ctx.projectDir)}
           AND feature_id   = ${featureId}
         LIMIT 1
      `;
      const raw = rows[0]?.origin;
      featureOrigin = raw === 'remote' ? 'remote' : 'local';
    } catch { /* best-effort; null → treated as local/trusted (see fail-open comment above) */ }
  }

  // 8.7 Materialize per-feature operator notes from PG → FS.
  //
  // PG is canonical for `harness_feature_notes`; the FS path
  // `<stateDir>/notes/<fid>.md` is a transient projection refreshed
  // here just before the worker spawns. The role prompt at
  // libs/papercusp/packages/harness/prompts/worker.md instructs the
  // agent to read this file if present.
  //
  // Best-effort. Skipped for non-feature-bound roles (orchestrator,
  // scoper, etc.) since they don't read the file and it would be
  // wasted I/O.
  if (
    featureId &&
    (role === 'worker' || role === 'validator' || role === 'debugger') &&
    ctx.pg && ctx.workspaceId
  ) {
    try {
      const { materializeFeatureNote } = await import('./feature-notes.js');
      const { materializeFeatureDebugNote } = await import('./feature-debug-notes.js');
      const { harnessSlug: getSlug } = await import('./state.js');
      const slug = getSlug(ctx.projectDir);
      const matInput = {
        pg: ctx.pg,
        workspaceId: ctx.workspaceId,
        harnessSlug: slug,
        featureId,
        stateDir: ctx.stateDir,
      };
      // Materialize both operator notes and debugger findings in
      // parallel — independent PG reads, neither depends on the other.
      await Promise.all([
        materializeFeatureNote(matInput),
        materializeFeatureDebugNote(matInput),
      ]);
    } catch { /* best-effort — worker prompt handles missing file */ }
  }

  // 8.10 Plan context — fetch the origin plan's ## Now + last 3 decisions
  // for worker/validator/reviewer roles executing plan-derived features.
  // Fetched over HTTP from the operator so this submodule stays free of
  // operator-layer PG imports. Best-effort; 3 s timeout; empty on miss.
  let planContext = '';
  if (
    featureId &&
    (role === 'worker' || role === 'validator' || role === 'reviewer')
  ) {
    try {
      const planCtxBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
      const planCtxRes = await fetch(
        `${planCtxBase}/api/harness/${harnessSlugFromProjectDir(ctx.projectDir)}/features/${featureId}/plan-context`,
        { signal: AbortSignal.timeout(3000) },
      );
      if (planCtxRes.ok) {
        const planCtxData = await planCtxRes.json() as { section?: string };
        planContext = planCtxData.section ?? '';
      }
    } catch { /* best-effort — feature has no plan origin or operator unreachable */ }
  }

  // 8b. Pre-fetch per-role identity from PG (Migration 041
  // `harness_shared.identity_files`). When ctx.pg isn't set, this
  // returns empty and prompt-build falls back to reading the on-disk
  // file at <harnessDir>/identity/<role>.md.
  let identity = '';
  if (ctx.pg) {
    try {
      const rows = await ctx.pg<{ content: string }[]>`
        SELECT content FROM harness_shared.identity_files
         WHERE role = ${role}
         LIMIT 1
      `;
      identity = rows[0]?.content ?? '';
    } catch { /* best-effort; file fallback covers this */ }
  }

  // 8.8 Cross-tool playbook (`<role>.tools.md` from the operator's
  // prompts directory). Authored once per role; captures workflows +
  // patterns that span multiple tools. The operator-app is the single
  // source of truth for these files — the orchestrator reads them at
  // spawn time so the agent has the playbook in its system prompt.
  //
  // Path resolution: PAPERCUSP_OPERATOR_PROMPTS_DIR env override wins,
  // otherwise walk up from cwd looking for apps/operator/prompts.
  // Best-effort: missing files just produce an empty section.
  let toolsPlaybook = '';
  try {
    const promptsDir = resolveOperatorPromptsDir();
    if (promptsDir) {
      const playbookPath = `${promptsDir}/${role}.tools.md`;
      if (existsSync(playbookPath)) {
        toolsPlaybook = readFileSync(playbookPath, 'utf8');
      }
    }
  } catch { /* best-effort */ }

  // 8.9 Shared cross-role guides — Path B injection per docs-engine plan.
  // Authored as MDX in apps/operator-docs/src/content/docs/agents/ so the
  // doc-site page and the prompt content share one source. We strip
  // leading frontmatter and pass each guide as a separate section.
  const sharedGuides: string[] = [];
  try {
    const docsAgentsDir = resolveOperatorDocsAgentsDir();
    if (docsAgentsDir) {
      for (const name of ['finding-context.mdx']) {
        const guidePath = `${docsAgentsDir}/${name}`;
        if (existsSync(guidePath)) {
          const raw = readFileSync(guidePath, 'utf8');
          sharedGuides.push(stripFrontmatter(raw));
        }
      }
    }
  } catch { /* best-effort */ }

  // 8.11 Queen brief — situational overlay for a spawned bee (cross-cutting context,
  // watch-fors, priority, what-other-bees-are-doing). Set by the Queen at spawn time
  // in extraEnv.MUG_BRIEF. P-060/061. Best-effort; empty when not set.
  const brief = (process.env.MUG_BRIEF ?? process.env.QUEEN_BRIEF /* legacy env name — dual-accept until callers migrate */ ?? '').trim();

  // 8.12 Queen wake-brief — the Queen's OWN precomputed survey snapshot (ranked
  // frontier/plans floor + her carry-note), assembled by the hive launch blueprint
  // (queen-brief-cache-assembly B-03/B-04) and threaded via MUG_WAKE_BRIEF.
  // buildPrompt renders it as a <system-reminder> in the volatile tail (D-006), so
  // it never touches the cacheable preamble. Empty ⇒ she falls back to the survey
  // tools (graceful degradation). Distinct from `brief` (the Queen→bee overlay).
  const queenBrief = (
    process.env.MUG_WAKE_BRIEF ??
    process.env.QUEEN_WAKE_BRIEF /* legacy env name — dual-accept until callers migrate */ ??
    ''
  ).trim();

  // 8.12b Overwatch wake-brief — the overwatch's OWN precomputed system-health
  // snapshot (the OverwatchBrief: detected anomalies + health panels), assembled by
  // the system:overwatch-launch action (overwatch-role-2026-06-15 B-04) and threaded
  // via OVERWATCH_WAKE_BRIEF. buildPrompt renders it as a <system-reminder> in the
  // volatile tail, exactly like queenBrief — a distinct brief for a distinct role.
  // Empty ⇒ the overwatch gathers the panels itself (overwatch.md's degraded fallback).
  const overwatchBrief = (process.env.OVERWATCH_WAKE_BRIEF ?? '').trim();

  // 8.13 Spawn/wake-handoff hydration — the ONE bounded `## Handoff` block
  // (directed-wake-honesty-and-spawn-handoff P-021/P-012): predecessor handoff +
  // hive-roster snapshot + work-item carry-note, assembled + bounded operator-side
  // by assembleSpawnHydration (gated on FLAGS.SPAWN_HANDOFF_HYDRATION) and threaded
  // via extraEnv.SPAWN_HANDOFF. The block is ALREADY provenance-framed (untrusted
  // entries wrapUntrusted-wrapped, bodies atomic) and carries its own `## Handoff`
  // heading → buildPrompt places it VERBATIM in the volatile tail. Empty when the
  // flag is off or every source degraded. Distinct from `brief`/`queenBrief`.
  const handoff = (process.env.SPAWN_HANDOFF ?? '').trim();

  // 9. Build the prompt.
  const prompt = buildPrompt({
    role,
    promptFile,
    promptFiles,
    inlinePrompt: options.inlinePrompt,
    promptOverride,
    stateDir: ctx.stateDir,
    harnessDir: ctx.harnessDir,
    identity,
    projectDir: ctx.projectDir,
    cwdOverride,
    featureId,
    runId,
    // hive-blueprint-generalization P-008: a generic hive's blueprint
    // (acceptance.kind: judge / human-gate / none) swaps the tests-based
    // TESTING_STANDARD for the domain-agnostic VERIFICATION_STANDARD, so a
    // deliverable-producing bee isn't told to write tests. undefined for a coding
    // harness ⇒ TESTING_STANDARD (unchanged). Same source as the finalize gate.
    acceptanceKind: loadHarnessAcceptanceKind(ctx.stateDir),
    // P-016: the hive's noun overrides → a "Hive vocabulary" reminder. Absent for a
    // coding harness ⇒ no block (prefix byte-identical).
    lexicon: loadHarnessLexicon(ctx.stateDir),
    // EI-311: the durable `s-…` coord owner (the umbilical), so the agent
    // names itself by its REAL identity — not the per-call Run ID — on any
    // degraded path where it composes its own messages.
    coordOwnerId: (process.env.PAPERCUSP_SPAWN_ID ?? '').trim() || null,
    extras,
    substrateContext,
    planContext,
    brief,
    queenBrief,
    overwatchBrief,
    handoff,
    featureHistory,
    toolsPlaybook,
    sharedGuides,
    // G3 — pass provenance so buildPrompt can wrap remote-authored content
    // (featureHistory, planContext) in <untrusted-peer-content> delimiters.
    featureOrigin,
  });

  // Token-spend telemetry — emit once per invoke so we can see how the
  // prompt budget breaks down across sections in production logs.
  // Char counts (not tokens; tokens ≈ chars/4 for english).
  //
  // Two channels:
  //   1. Log line (transport) — visible in run.log immediately.
  //   2. PG row (persistence, async best-effort) — enables the
  //      operator UI's "what did each turn cost" historical view.
  // Per architectural rule: log first, persist after. We do NOT
  // await the PG write; failure to persist is silent.
  ctx.log(
    `  prompt-budget role=${role} feature=${featureId ?? '-'} ` +
    `total=${prompt.length} substrate=${substrateContext.length} ` +
    `history=${featureHistory.length} playbook=${toolsPlaybook.length}`,
  );
  if (ctx.pg && ctx.workspaceId) {
    try {
      const { recordPromptComposition } = await import('./prompt-telemetry.js');
      const { harnessSlug: getSlug } = await import('./state.js');
      recordPromptComposition(ctx.pg, {
        workspaceId: ctx.workspaceId,
        harnessSlug: getSlug(ctx.projectDir),
        featureId,
        role,
        runId,
        totalChars: prompt.length,
        substrateChars: substrateContext.length,
        historyChars: featureHistory.length,
      });
    } catch { /* best-effort */ }
  }

  // 10. Spawn claude. logDir creation is deferred until we actually
  // need to write files (CLI fallback path); PG-canonical mode never
  // touches the directory.
  const jsonlPath = join(ctx.logDir, `${runId}.jsonl`);
  const outPath = join(ctx.logDir, `${runId}.out`);
  const errPath = join(ctx.logDir, `${runId}.err`);
  // Release-fixers need a durable pre-turn trail: their first-turn guard can
  // SIGTERM the child before the normal end-of-run writer executes. Keep the
  // legacy .out/.err paths alive for this role even in PG-canonical mode so a
  // killed attempt is diagnosable from the path recorded in its run log.
  const retainReleaseFixerFiles = role === 'release-fixer';
  if (retainReleaseFixerFiles) {
    mkdirSync(ctx.logDir, { recursive: true });
    writeFileSync(outPath, '');
    writeFileSync(errPath, '');
  }

  const cwd = cwdOverride || ctx.projectDir;
  // Heal this for BOTH execution engines: the owned loop's capability tools
  // operate in the same cwd a subprocess would receive.
  healSandboxZeroByteManifest(cwd, ctx.log);

  if (executionEngine === 'loop') {
    if (!ownedLoopPort) {
      throw new Error(
        `invoke: aiBackend engine=loop for role=${role} requires an operator-injected ownedLoop port`,
      );
    }
    const execution = await runOwnedLoopInvocation({
      ctx,
      port: ownedLoopPort,
      role,
      prompt,
      model: resolvedModel,
      runId,
      featureId: featureId ?? null,
      chunkId: invocationChunkId,
      cwd,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    return finalizeInvocation({
      ctx,
      role,
      prompt,
      promptHash: workerParityPromptHash(prompt, options.inlinePrompt),
      runId,
      featureId: featureId ?? null,
      streamFormat,
      runBackend: 'owned-loop',
      resolvedModel,
      requestedModel,
      jsonlPath,
      outPath,
      errPath,
      rawJsonlBody: execution.rawJsonlBody,
      errBody: execution.errBody,
      outcome: execution.outcome,
      startedAt: execution.startedAt,
      timeoutSeconds,
      retainReleaseFixerFiles,
    });
  }

  const finalArgv = [...argv.slice(1), ...extraFlags];
  const command = argv[0];
  const startedAt = Date.now();

  // omp's `-p` mode reads the message from a positional arg (or `@file`),
  // not from stdin. Materialise the prompt to an ephemeral tmpfile under
  // ramTmpRoot() (Linux: /dev/shm tmpfs; macOS/Windows: page-cache-backed
  // os.tmpdir()), pass `@<path>` as argv, and rm the dir in the finally
  // block after spawn close. The harness directory stays pure-code; the
  // prompt body still lands in harness_run_output's prompt_body column
  // for post-hoc replay/debugging (Phase 4 + 5 working together).
  let ompPromptDir: string | undefined;
  let ompPromptPath: string | undefined;
  if (agentBackend === 'omp' && streamFormat !== 'none') {
    const { ramTmpRoot } = await import('./tmpfs');
    ompPromptDir = mkdtempSync(join(ramTmpRoot(), 'papercusp-'));
    ompPromptPath = join(ompPromptDir, 'prompt.md');
    writeFileSync(ompPromptPath, prompt, 'utf8');
    finalArgv.push(`@${ompPromptPath}`);
  }

  // codex `exec` reads the prompt from stdin via the trailing `-` positional
  // (the stdin.write block below pipes `prompt` to every non-omp backend).
  if (agentBackend === 'codex' && streamFormat !== 'none') {
    finalArgv.push('-');
  }

  // identities-v1 D-018 / D-021 / WI-2143907: Claude system-prompt replacement is
  // unconditional. The slot composer supplies the neutral kernel plus the blueprint's
  // domain overlay under the seal; retaining an append branch would put Claude's
  // unsealed coding prose above that kernel. The assembled role/task prompt still rides
  // stdin unchanged. OMP/Codex carry their own base and never enter this branch.
  let sysPromptDir: string | undefined;
  if (
    harnessSupports(agentBackend, 'system-prompt-override') &&
    streamFormat === 'claude-stream-json'
  ) {
    // Effective blueprint: a program-blueprint spawn's BLUEPRINT_ID extra, else the harness's
    // own blueprint id (so a normal coding-pipeline spawn — which carries no BLUEPRINT_ID —
    // still resolves the coding overlay). Absent/non-blueprint ⇒ neutral preamble only.
    const sysText = resolveReplacementSystemPrompt({
      harnessDir: ctx.harnessDir,
      phase: '',
      dept: '',
      blueprintId: promptBlueprintId,
      extendsChain: promptExtendsChain,
      // Per-hive local-tier overlay override (P-012/P-014): a hive may ship its own
      // agent-base-overlay in the materialized local tier. Absent ⇒ built-in.
      blueprintRoots: parseBlueprintLocalRoots(extras),
    });
    if (sysText) {
      const { ramTmpRoot } = await import('./tmpfs');
      sysPromptDir = mkdtempSync(join(ramTmpRoot(), 'papercusp-sys-'));
      const sysPromptPath = join(sysPromptDir, 'system-prompt.md');
      writeFileSync(sysPromptPath, sysText, 'utf8');
      finalArgv.push('--system-prompt-file', sysPromptPath);
    }
  }

  // Per-spawn MCP config location. claude loads its config from an EXPLICIT
  // path (`--mcp-config … --strict-mcp-config`), so it can live in a UNIQUE
  // per-spawn temp dir rather than the shared `<cwd>/.mcp.json`. That lets
  // several claude spawns share ONE project dir without race-clobbering each
  // other's config — the coord-op vote fan-out spawns N voters + an advocate in
  // one harness dir, and a shared `.mcp.json` made two of them authenticate
  // under a single role (coordination-ops-as-blueprint-primitives D-012/D-014).
  // tmpdir() is sandbox-readable (not in FLEET_SANDBOX_DENY_READ). omp
  // path-discovers `<cwd>/.mcp.json` and has no explicit-path override, so it
  // keeps the shared file (its fan-out stays sequential); codex uses a per-spawn
  // CODEX_HOME (already isolated). The temp dir is removed alongside mcpHandle
  // when the spawn closes.
  let mcpConfigDir = cwd;
  let mcpTempDir: string | null = null;
  // TRACKED (resumable) launches — the invoke route minted a native session id
  // (bpkind=hive, D-010) — bake the config at a PERSISTENT conventional path
  // keyed by the spawn id instead: wake-executor later resumes this session via
  // `claude --resume --mcp-config <that path>`, which a deleted temp dir would
  // break (the Queen would wake toolless).
  const trackedSessionSpawnId = (process.env.PAPERCUSP_NATIVE_SESSION_ID ?? '').trim()
    ? (process.env.PAPERCUSP_SPAWN_ID ?? '').trim()
    : '';
  // ONE value carries BOTH the path and the close-time restore skip, so the two
  // cannot drift apart the way separate variables did (EI-23336628915114721).
  const mcpPlacement = resolveMcpConfigPlacement({
    agentBackend,
    workspaceId: ctx.workspaceId,
    trackedSessionSpawnId,
  });
  const mcpConfigPersistsOutsideCwd = mcpPlacement.persistsOutsideCwd;
  if (mcpPlacement.kind === 'session-dir') {
    // Keyed by the tracked spawn id (== the adv_sessions coord_owner_id on the
    // hive path) via the ONE shared helper, so the wake-executor resume leg
    // remounts the IDENTICAL dir (unify-launch-mechanics P-004).
    mcpConfigDir = sessionMcpDir(mcpPlacement.spawnId);
    mkdirSync(mcpConfigDir, { recursive: true });
  } else if (mcpPlacement.kind === 'temp-dir') {
    mcpTempDir = mkdtempSync(join(tmpdir(), 'papercusp-mcp-'));
    mcpConfigDir = mcpTempDir;
  }
  const mcpConfigPath = join(mcpConfigDir, '.mcp.json');

  // 10b. claude-code MCP wiring — make claude load + trust the per-spawn
  // signed .mcp.json (omp path-discovers it; claude won't without these
  // flags). See claudeMcpArgs.
  finalArgv.push(
    ...claudeMcpArgs(
      agentBackend,
      streamFormat,
      roleAgentCmd,
      mcpConfigPath,
      Boolean(ctx.workspaceId),
      role,
      resolveRoleToolScope(readEffectiveConfig(ctx.stateDir), role),
    ),
  );

  // 10b1. Session tracking for resumable launches (local-hive-orchestration P-010).
  // The pot/hive blueprint launches record a native session UUID so wake-executor
  // can resume them via `claude --resume <sessionId>`. Thread the session ID from
  // the invoke route into the claude argv.
  const nativeSessionId = process.env.PAPERCUSP_NATIVE_SESSION_ID;
  if (harnessSupports(agentBackend, 'native-session-id') && nativeSessionId) {
    finalArgv.push('--session-id', nativeSessionId);
  }

  // 10c. Optional OS sandbox (PAPERCUSP_FLEET_SANDBOX) — claude-code's built-in
  // sandbox via --settings: hides credential dirs, confines writes to cwd, and
  // allowlists command egress. Off by default; no-op for non-claude backends.
  // See plan fleet-spawn-sandbox-2026-06-01.
  finalArgv.push(
    ...claudeSandboxArgs(
      agentBackend,
      streamFormat,
      roleAgentCmd,
      Boolean(ctx.workspaceId),
      fleetSandboxForSpawn,
      role,
    ),
  );

  // Body accumulators (in-memory). Filesystem JSONL/ERR is only
  // touched in true-CLI fallback (no operator, no PG) — see writeBodyToDiskAtExit.
  const jsonlChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];

  // Live chunk streaming via in-process bus on the operator. Each
  // stdout chunk is HTTP-POSTed to /api/internal/run-chunk on the
  // operator; the operator's per-run EventEmitter fans out to SSE
  // subscribers without filesystem coupling.
  //
  // OPTIONAL persistence: when PAPERCUSP_PERSIST_CHUNKS=1 AND ctx.pg
  // is wired, each chunk is ALSO INSERTed into harness_run_chunks for
  // archival per-chunk replay (timing analysis, fine-grained playback).
  // The bus delivery does not wait for the PG write — persistence is
  // a parallel queue. Default OFF: full-body persistence at run exit
  // (harness_run_output, Phase 4) covers post-hoc replay for ~all use
  // cases.
  //
  // Falls back to file-only when:
  //   - PAPERCUSP_OPERATOR_BASE is unset/unreachable (CLI-only mode,
  //     no operator running)
  //   - harness_token isn't available (legacy harness without one)
  // Files are written ONLY at run end (not appended per-chunk) and
  // ONLY when neither bus nor PG is active — see writeFilesForFallback
  // below. Default PG-canonical mode produces zero files.
  let chunkSeq = 0;
  let chunkPostQueue: Promise<void> = Promise.resolve();
  let chunkPgQueue: Promise<void> = Promise.resolve();
  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  const persistChunks = process.env.PAPERCUSP_PERSIST_CHUNKS === '1';
  let harnessToken: string | null = null;
  try {
    const cfgRaw = readFileSync(`${ctx.stateDir}/config.json`, 'utf8');
    const cfgJson = JSON.parse(cfgRaw) as { harness_token?: string };
    if (typeof cfgJson.harness_token === 'string' && cfgJson.harness_token.length > 0) {
      harnessToken = cfgJson.harness_token;
    }
  } catch { /* no token → bus disabled, file-only path */ }

  // Pre-resolve the PG chunk-archival path when both flag + ctx.pg are
  // set. Done before the spawn Promise so the sync stdout handler can
  // reference appendChunkPg without an `await import`.
  type ChunkPgCtx = { pg: OrchestratorPg; workspaceId: string; harnessSlug: string };
  let chunksPgCtx: ChunkPgCtx | null = null;
  let appendChunkPgFn: ((c: ChunkPgCtx, runId: string, seq: number, data: string) => Promise<void>) | null = null;
  if (persistChunks && ctx.pg && ctx.workspaceId) {
    const { harnessSlug: getSlug } = await import('./state');
    chunksPgCtx = {
      pg: ctx.pg,
      workspaceId: ctx.workspaceId,
      harnessSlug: getSlug(ctx.projectDir),
    };
    appendChunkPgFn = (await import('./run-chunks-pg')).appendChunkPg;
  }

  const outcome: SpawnOutcome = await new Promise(async (resolve) => {
    // Spawn env: defensively disable omp's autonomous memory backend
    // for harness invocations. The harness composes the prompt itself
    // (substrate + role + memory + identity + feature history) and
    // owns context discipline; we don't want omp's `recall`/`reflect`
    // to autonomously inject extra context that competes.
    //
    // Both env keys covered:
    //   - `OMP_MEMORIES_ENABLED=false` — pre-backend `memories.enabled` flag
    //   - `OMP_MEMORY_BACKEND=off`     — explicit backend selection
    // Per omp's env docs, `OMP_*` keys are mirrored to `PI_*`. Setting
    // both forms protects against an unannounced rename.
    // Caller-supplied env on the ctx (e.g. decrypted search-provider keys
    // from Migration 047, resolved once at orchestrator boot). Spread
    // before the OMP_* memory-disable flags so we don't let the caller
    // accidentally override those.
    const spawnEnv: NodeJS.ProcessEnv = scopeSpawnEnvForRole(
      {
        ...process.env,
        ...(ctx.extraSpawnEnv ?? {}),
        ...(options.extraEnv ?? {}),
        OMP_MEMORIES_ENABLED: 'false',
        OMP_MEMORY_BACKEND: 'off',
        PI_MEMORIES_ENABLED: 'false',
        PI_MEMORY_BACKEND: 'off',
        // Every orchestrator spawn is by definition an AGENT session: arm the
        // hook-level native-scheduler guard (the omp coord-hook / cc bash gate
        // key off this; native-scheduler-lockout-2026-06-09 P-010). The flag
        // deny-list above covers claude even hook-less (headless config dirs
        // carry no hooks); this covers the rest.
        PAPERCUSP_AGENT_SESSION: '1',
      },
      // G4 / P-011: strip operator-internal secrets the agent CLI never needs
      // (it uses the signed MCP endpoint, not direct PG); the auditor role
      // additionally loses the decrypted search-provider keys (read-only judge,
      // no web_search). Applied to the MERGED env BEFORE the per-spawn HOME /
      // git-no-push / MCP-config / sandbox-cache env is added below, so those
      // (non-secret) additions survive. See scopeSpawnEnvForRole.
      role,
    );

    // Phase E (P-051 / D-008): per-spawn HOME for filesystem-credential
    // isolation (~/.claude, ~/.gitconfig). See resolveSpawnHome — gated on the
    // shared-operator model so dev / legacy builds inherit the process HOME.
    const spawnHome = resolveSpawnHome(
      ctx.workspaceId,
      spawnEnv,
      options.extraEnv?.HOME ?? ctx.extraSpawnEnv?.HOME,
    );
    if (spawnHome) {
      spawnEnv.HOME = spawnHome;
      spawnEnv.USERPROFILE = spawnHome; // Windows
    }

    // claude-code only (P-012): point the spawn at an isolated, plugin-free
    // CLAUDE_CONFIG_DIR so the worker has no enabled plugins / known
    // marketplaces to resolve — and therefore can't run the
    // `git clone --no-checkout` + `git checkout <sha>` whose work-tree is the
    // process cwd, which leaks the plugin tree into the worker's cwd (the
    // empty package.json/.mcp.json/.env stub bug). It is a claude-code defect,
    // not ours (filed upstream); this denies it anything to resolve. The auth
    // session is symlinked in, so the worker stays logged in. CLAUDE_CONFIG_DIR
    // relocates the whole `~/.claude` tree AND the sibling `~/.claude.json`
    // (verified on claude-code 2.1.169 — an OLDER note here that `.claude.json`
    // "stays at $HOME" is stale), so the worker inherits NONE of the engineer's
    // personal MCP fleet / plugins / trust — which only reinforces this
    // isolation, and is harmless headless (`-p` skips onboarding; the worker's
    // MCP comes from its per-spawn `.mcp.json`, not `~/.claude.json`). The
    // INTERACTIVE counterpart can't take this fresh dir — it must mirror the
    // user's config (see operator-core `writeInteractiveClaudeConfig`, EI-155).
    // See writeSpawnClaudeConfig + claudeSpawnEnvHardening (secondary env defense).
    let claudeConfigHandle: SpawnClaudeConfigHandle | null = null;
    if (agentBackend === 'claude-code') {
      // Tracked (resumable) launches get a PERSISTENT config dir — claude
      // writes the session transcript under it, and `claude --resume` at wake
      // time must find that transcript again (wake-executor sets
      // CLAUDE_CONFIG_DIR to the same conventional path). A temp dir here ==
      // an unresumable Queen (the Stage-A smoke failure, 2026-06-06).
      // Keyed by the tracked spawn id via the ONE shared helper, so wake-executor
      // sets CLAUDE_CONFIG_DIR to the IDENTICAL path on resume (unify-launch-mechanics
      // P-004; the EI-153 launch↔resume key is computed in one place now).
      const persistentDir = trackedSessionSpawnId
        ? sessionClaudeConfigDir(trackedSessionSpawnId)
        : undefined;
      claudeConfigHandle = writeSpawnClaudeConfig(spawnEnv.HOME ?? homedir(), { persistentDir });
      spawnEnv.CLAUDE_CONFIG_DIR = claudeConfigHandle.configDir;
      // Fleet token (claude-credential-sync-2026-06-10 P-003): when the owner
      // has minted a dedicated `claude setup-token` (~/.papercusp/claude-token),
      // authenticate this autonomous spawn with it instead of the symlinked
      // interactive OAuth bundle — a non-rotating token keeps fleet refreshes
      // from invalidating the owner's terminals. The LOCAL leg of the same
      // convention frame-bootstrap uses for remote frames. Absent token ⇒
      // unchanged (config-dir credentials, exactly as before).
      if (!spawnEnv.CLAUDE_CODE_OAUTH_TOKEN) {
        const fleetToken = readFleetClaudeToken();
        if (fleetToken) spawnEnv.CLAUDE_CODE_OAUTH_TOKEN = fleetToken;
      }
    }
    Object.assign(spawnEnv, claudeSpawnEnvHardening(agentBackend));

    // No orchestrator-spawned agent may `git push` — integration is the
    // orchestrator's job and the repo's invariant is "agents don't push".
    // Inject a pre-push hook via GIT_CONFIG into THIS spawn's env only, so
    // the shared checkout's config and the user's / other agents' pushes are
    // untouched. Real enforcement; the Bash(git push:*) deny is the backstop.
    Object.assign(spawnEnv, gitConfigNoPushEnv(spawnEnv, ensureFleetGitHooksDir()));

    // Workspace agent spawns always use an isolated package-manager cache. This
    // prevents npm's content-addressed ~/.npm store from racing across sibling
    // checkouts and /tmp scratch projects even when the OS sandbox is opted out.
    // Under the sandbox the same paths are also the allow-listed writable cache
    // root; outside it they remain a durable isolation boundary.
    if (workspaceAgentSpawn) {
      const cacheEnv = fleetSandboxCacheEnv(cwd);
      for (const dir of new Set(Object.values(cacheEnv))) {
        try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort; a real install would surface the error */ }
      }
      Object.assign(spawnEnv, cacheEnv);
    }

    // When the OS sandbox is on, also strip provider/cloud creds from the
    // sandboxed Bash subprocess env (verified: =1 strips e.g. AWS_SECRET_ACCESS_KEY
    // from a Bash subprocess). Complements the sandbox's denyRead + egress block.
    if (fleetSandboxForSpawn) {
      spawnEnv.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
    }

    // Per-spawn .mcp.json: write the seven-param URL config so OMP
    // discovers our agent-mcp endpoint with this spawn's harness/role/
    // feature/chunk/run/spawn baked in. Cleanup runs on close even if
    // spawn errors. Spec: apps/operator/docs/plugin-mcp-host-design.md (D4).
    let mcpHandle: SpawnMcpHandle | null = null;
    let codexHomeHandle: SpawnCodexHomeHandle | null = null;
    let ompHomeHandle: SpawnOmpHomeHandle | null = null;
    if (ctx.workspaceId) {
      try {
        // THE UMBILICAL (voice-gap fix): prefer the operator's durable `s-…` spawnId
        // (threaded in via PAPERCUSP_SPAWN_ID by fleet/operator-spawn) over a fresh
        // random UUID. It's the SAME id recorded as the spawned_agents row's
        // sessionOwner, so baking it as the MCP URL's stable `client=` lets the
        // operator attribute this child's coord:* / plans:* / improvements:* writes to
        // a real coord owner instead of throwing "no attributable identity" (which
        // made every cup:spawn bee MUTE). The id stays fixed across the child's
        // tool calls, so it's a valid coord/lock owner (unlike the per-call runId).
        const stableSpawnId = (process.env.PAPERCUSP_SPAWN_ID ?? '').trim();
        const spawnId = stableSpawnId || randomUUID();
        const slug = harnessSlugFromProjectDir(ctx.projectDir);
        const chunkId = extractChunkId(extras);
        const parentSpawnId =
          options.parentSpawnId ?? ((process.env.PAPERCUSP_PARENT_SPAWN_ID || '').trim() || null);
        const signedInput = {
          harnessSlug: slug,
          workspaceId: ctx.workspaceId,
          role,
          runId,
          spawnId,
          featureId: featureId || null,
          chunkId,
          parentSpawnId,
          // The stable coord owner id baked as `client=`. Only when we actually have a
          // durable operator-assigned spawnId — a bare random UUID would not be a real
          // coord owner, so omit it there (the legacy pipeline-role path is unchanged).
          clientId: stableSpawnId || null,
          // Private detector identity: invoke-once children inherit PAPERCUSP_SID,
          // which is stable for the auditor session but intentionally differs from
          // the public resolveAgentIdentity result on client-less signed invokes.
          // Sign it into the MCP URL; never substitute runId or spawnId here.
          detectorSessionKey: (process.env.PAPERCUSP_SID ?? '').trim() || null,
          // pot-rename dual-accept plus the pipeline worker↔cup equivalence:
          // select a bounded catalog before OMP serializes tool schemas.
          mcpToolNames: invokeMcpToolNamesForRole(role),
        };
        // Standalone orchestrator callers (including the parity runner) can
        // hold a fully-authorized PG client without exporting its DSN. Reuse
        // that handle for the spawn-signing-key read so a signing failure can
        // never restore an unrelated cwd .mcp.json and silently change role.
        const signingPg = ctx.pg ? { pg: ctx.pg } : {};
        // codex: no `.mcp.json` discovery — its MCP servers live in
        // $CODEX_HOME/config.toml. Mint a per-spawn CODEX_HOME with the
        // same signed, role-scoped URL + the ChatGPT auth symlink, and
        // point the child at it. omp writes the shared `<cwd>/.mcp.json`
        // (path discovery); claude writes to its per-spawn `mcpConfigDir`
        // (a unique temp dir — see the mcpConfigPath block above) and loads
        // it via `--mcp-config`, so concurrent claude spawns in one cwd
        // don't clobber a shared file.
        if (agentBackend === 'codex') {
          const trackedCodexKey = (process.env.PAPERCUSP_CODEX_SESSION_KEY ?? '').trim();
          const contextConfig = codexContextConfigFromArgv(argv);
          codexHomeHandle = await writeSignedSpawnCodexHome(signedInput, trackedCodexKey
            ? {
                codexHome: codexHomeForSessionKey(trackedCodexKey),
                cleanup: false,
                model: resolveCodexModel(resolvedModel),
                contextConfig,
                ...signingPg,
              }
            : { model: resolveCodexModel(resolvedModel), contextConfig, ...signingPg });
          spawnEnv.CODEX_HOME = codexHomeHandle.codexHome;
        } else {
          // writeSignedSpawnMcp signs the URL params. In strict mode
          // (default since 2026-05-11) a signing failure throws — the
          // outer try/catch below logs `spawn-mcp write failed` and
          // proceeds with mcpHandle=null, so the agent runs but has no
          // MCP endpoint. That is the intended failure mode: better to
          // fail loudly than to emit an unsigned URL the operator will
          // reject on every tool call. To restore the silent-fallback
          // (soft-warn) behavior, pass `allowUnsigned: true` here AND
          // unset PAPERCUSP_REQUIRE_SPAWN_SIG on the operator.
          // No await-time risk: signing is a single PG round-trip against
          // a 32-byte row + an HMAC; total < 50ms in normal operation.
          mcpHandle = await writeSignedSpawnMcp(mcpConfigDir, signedInput, signingPg);
        }
      } catch (err) {
        ctx.log(`  spawn-mcp write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // OMP gateway routing (omp-account-pinning-gateway-2026-06-29 P-006/D-008): pi reads
    // models.yml + auth from <HOME>/.omp/agent (USER-LEVEL only — HOME is the sole lever, D-002),
    // so route a pinned omp fleet spawn through the gateway by minting a per-spawn HOME seeded
    // from the source omp agent dir + carrying the gateway models.yml, then force-selecting
    // `papercusp-gateway/<model>` (the `--model` appended in the model-flag block above). Gated on
    // PAPERCUSP_OMP_MODELS_YML — emitted by resolveSpawnGatewayEnv's omp branch ONLY when the
    // gateway is on + an account is pinned + the capability matrix supports omp ⇒ dormant
    // otherwise (byte-identical spawn). OVERRIDES the resolveSpawnHome HOME set above (a pinned
    // omp spawn needs the SEEDED home; its source IS that resolveSpawnHome home, else ~/.omp).
    // PI_CODING_AGENT_DIR (the session store) is left untouched. Cleaned up on close/error below.
    if (harnessSupports(agentBackend, 'gateway-models-yml') && (process.env.PAPERCUSP_OMP_MODELS_YML ?? '').trim()) {
      try {
        const sourceAgentDir = join(spawnHome ?? homedir(), '.omp', 'agent');
        ompHomeHandle = writeSpawnOmpHome(process.env.PAPERCUSP_OMP_MODELS_YML as string, sourceAgentDir);
        spawnEnv.HOME = ompHomeHandle.home;
        spawnEnv.USERPROFILE = ompHomeHandle.home; // Windows
        ctx.log(`  role=${role} omp gateway home=${ompHomeHandle.home} (seeded from ${sourceAgentDir})`);
      } catch (err) {
        // Fail-soft: a seed failure leaves the spawn on its normal HOME (direct egress) and never
        // blocks the spawn — the matrix still reports omp supported via the connect path.
        ctx.log(`  omp gateway home seed failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // External OS-sandbox for backends that can't self-sandbox: codex (P-017/
    // D-017). codex's native sandbox cancels MCP (D-009), so it runs with its
    // sandbox bypassed (codexSandboxArgs) but wrapped in `srt`, which confines
    // its shell commands (writes → cwd+cache+agent-dirs, egress → allowlist,
    // creds hidden) while its MCP+model are allow-listed through srt's proxy.
    // The wrap clears `no_proxy` inside the srt shell so the operator
    // (loopback/RFC1918, which srt's default no_proxy excludes) routes through
    // that proxy instead of the isolated netns. omp gets the SAME wrap
    // (D-018/D-019: no native sandbox; model+MCP are loopback here). claude uses
    // its own --settings sandbox, not srt.
    let spawnCommand = command;
    let spawnArgv = finalArgv;
    if (fleetSandboxForSpawn && backendUsesSrt(agentBackend)) {
      // The backend's own writable agent/state dirs (its config/auth/session DBs):
      // codex → the per-spawn CODEX_HOME; claude → the per-spawn isolated
      // CLAUDE_CONFIG_DIR (claude writes session/project state under it, and the
      // sandbox makes $HOME read-only); omp → ~/.omp + PI_CODING_AGENT_DIR
      // (the agent/auth/models SQLite DBs; usually <project>/.papercusp/pi-sessions,
      // already under cwd, but pinned here in case it's set to an absolute path).
      const agentHomes =
        agentBackend === 'codex'
          ? [codexHomeHandle?.codexHome].filter((x): x is string => Boolean(x))
          : agentBackend === 'claude-code'
            ? [claudeConfigHandle?.configDir].filter((x): x is string => Boolean(x))
            : [join(spawnEnv.HOME ?? homedir(), '.omp'), spawnEnv.PI_CODING_AGENT_DIR].filter(
                (x): x is string => Boolean(x),
              );
      const settingsPath = writeFleetSrtSettings({ cwd, backend: agentBackend, agentHomes });
      ({ command: spawnCommand, argv: spawnArgv } = wrapSpawnWithSrt(command, finalArgv, {
        enabled: true,
        backend: agentBackend,
        srtBin: fleetSrtBin,
        settingsPath,
      }));
    }
    const child = spawn(spawnCommand, spawnArgv, { cwd, env: spawnEnv, stdio: ['pipe', 'pipe', 'pipe'] });

    // Write a row to harness_shared.harness_lanes so the operator UI's
    // "agents in flight" pill bar can subscribe to the live agent set.
    // Bash run.sh used to do this via `pg_write_lane`; the TS migration
    // dropped it, leaving the UI stuck on "No agents in flight" / the
    // "Orchestrator deciding next step…" subtitle even when a worker
    // was actively spawning. PK is (harness_slug, phase, role) — single
    // lane per role is fine for the common chunk-loop case; if parallel
    // workers ever need distinct rows the role string already encodes
    // the lane.
    let laneWritePromise: Promise<void> | null = null;
    const laneSlug = (() => {
      try { return harnessSlugFromProjectDir(ctx.projectDir); } catch { return ''; }
    })();
    if (ctx.pg && ctx.workspaceId && child.pid != null && laneSlug) {
      const lanePid = child.pid;
      const pg = ctx.pg;
      const ws = ctx.workspaceId;
      const startedAtMs = Date.now();
      laneWritePromise = (async () => {
        try {
          await pg`
            INSERT INTO harness_shared.harness_lanes
              (workspace_id, harness_slug, phase, role, feature_id, pid, started_at)
            VALUES (${ws}, ${laneSlug}, ${ctx.phase}, ${role}, ${featureId ?? null}, ${lanePid}, ${startedAtMs})
            ON CONFLICT (harness_slug, phase, role) DO UPDATE SET
              feature_id   = EXCLUDED.feature_id,
              pid          = EXCLUDED.pid,
              started_at   = EXCLUDED.started_at,
              workspace_id = EXCLUDED.workspace_id
          `;
        } catch (err) {
          ctx.log(`  lane write failed: ${(err as Error).message}`);
        }
      })();
    }
    const clearLane = async () => {
      if (!ctx.pg || !ctx.workspaceId || !laneSlug) return;
      const pg = ctx.pg;
      try {
        // Wait for the insert (if any) to finish before deleting — a
        // delete that races ahead of the insert leaves an orphan row
        // that the operator's status-sweep would have to clean up
        // later.
        if (laneWritePromise) await laneWritePromise;
        await pg`
          DELETE FROM harness_shared.harness_lanes
          WHERE harness_slug = ${laneSlug}
            AND phase = ${ctx.phase}
            AND role = ${role}
        `;
      } catch (err) {
        ctx.log(`  lane clear failed: ${(err as Error).message}`);
      }
    };

    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }, timeoutMs);
    }

    // Phase 9: caller-supplied AbortSignal lets `orchestrator.cancel`
    // kill the child mid-flight. SIGTERM first; the orchestrator's
    // existing exit-handling drains, then we send SIGKILL after 2s if
    // the child doesn't exit. If the signal is already aborted at spawn
    // time we kill immediately.
    let cancelled = false;
    const onAbort = () => {
      if (cancelled) return;
      cancelled = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2_000).unref();
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    // WI-3302: this child is invoke.ts's OWN inner agent-CLI process — its
    // stdout/stderr chunks are forwarded to the chunk-bus/PG below, but were
    // never echoed back onto invoke.ts's own process.stdout/stderr. invoke.ts
    // runs in the SAME OS process as invoke-once.ts (imported module, not a
    // separate spawn), and orchestrator-runner.ts's `runChild` watches THAT
    // outer process's stdout/stderr `data` events (`reportActivity()`) to stamp
    // `spawned_agents.last_output_at` via `onOutputActivity`. Because nothing
    // upstream ever wrote to the outer process's own streams mid-run (only a
    // final summary at the very end — see invoke-once.ts), `last_output_at`
    // stayed null for the entire run (0/1553 sampled — WI-3302). Fix: echo a
    // tiny throttled marker to our OWN process.stderr (never stdout — several
    // downstream consumers, e.g. classifyTurnError/rawStdoutTail, key off the
    // exact stdout content, so polluting it would be riskier than necessary)
    // whenever the inner child emits real output, capped well under
    // SPAWN_HEARTBEAT_INTERVAL_MS (60s, spawn-reclaim.ts) so the heartbeat tick
    // almost always has a fresh timestamp to promote. Throttle decision is the
    // pure, unit-tested `nextOuterActivityEchoAt` above.
    let lastOuterActivityEchoAt: number | null = null;
    const echoActivityToOuterProcess = () => {
      const next = nextOuterActivityEchoAt(lastOuterActivityEchoAt, Date.now());
      if (next === null) return;
      lastOuterActivityEchoAt = next;
      try { process.stderr.write(`${OUTER_ACTIVITY_ECHO_MARKER}\n`); } catch { /* best-effort */ }
    };

    // Live streaming via the operator's chunk bus. POST each stdout
    // chunk to /api/internal/run-chunk; the operator publishes to an
    // in-process EventEmitter that the SSE handler subscribes to.
    // Sub-ms latency end-to-end vs ~10-50ms via fs.watch. Best-effort:
    // if the POST fails (operator down, network hiccup), the on-disk
    // JSONL still has the chunk and Phase 4 ingest-at-exit + the SSE
    // handler's fs.watch fallback keep the stream functional.
    child.stdout.on('data', (chunk: Buffer) => {
      echoActivityToOuterProcess();
      if (retainReleaseFixerFiles) {
        try { appendFileSync(outPath, chunk); } catch { /* best-effort diagnostic trail */ }
      }
      jsonlChunks.push(chunk);
      const mySeq = chunkSeq;
      const myData = chunk.toString('utf8');
      let advancedSeq = false;
      if (harnessToken) {
        advancedSeq = true;
        // Serialize POSTs via Promise chain so chunks land in arrival
        // order at the bus even though fetch is async. Errors are
        // swallowed — never break the stream.
        chunkPostQueue = chunkPostQueue.then(async () => {
          try {
            await fetch(`${operatorBase}/api/internal/run-chunk`, {
              method: 'POST',
              headers: {
                'authorization': `Bearer ${harnessToken}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({ runId, seq: mySeq, chunk: myData }),
            });
          } catch { /* operator unreachable; in-memory accumulator + Phase 4 covers post-run replay */ }
        });
      }
      // Optional: also persist to PG for archival per-chunk replay.
      // Independent queue from the bus POST; both share the seq number.
      if (chunksPgCtx && appendChunkPgFn) {
        advancedSeq = true;
        chunkPgQueue = chunkPgQueue.then(() => appendChunkPgFn!(chunksPgCtx!, runId, mySeq, myData));
      }
      if (advancedSeq) chunkSeq++;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      echoActivityToOuterProcess();
      if (retainReleaseFixerFiles) {
        try { appendFileSync(errPath, chunk); } catch { /* best-effort diagnostic trail */ }
      }
      errChunks.push(chunk);
    });

    // EPIPE protection: if the subprocess exits before reading our stdin
    // (e.g. `true`, or a crashed claude binary), the write would throw an
    // unhandled EPIPE. Swallow it — the agent's exit code already tells
    // the caller something went wrong.
    child.stdin.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        ctx.log(`  stdin error: ${err.message}`);
      }
    });
    // Gate on streamFormat, not agentBackend: omp's @file convention
    // only applies when we're actually invoking omp/pi (streamFormat ===
    // 'omp-json'). For any other backend or for omp-with-stub-binary
    // (e.g. claudeCmd='cat' in tests), feed the prompt via stdin like
    // claude-code does — that's the universal Unix interface.
    if (streamFormat === 'omp-json') {
      try { child.stdin.end(); } catch { /* EPIPE-safe */ }
    } else {
      try {
        child.stdin.write(prompt);
        child.stdin.end();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
          ctx.log(`  stdin write error: ${(err as Error).message}`);
        }
      }
    }

    child.on('error', (err) => {
      ctx.log(`  spawn error: ${err.message}`);
      if (timer) clearTimeout(timer);
      // Skip the restore ONLY when the config was baked OUTSIDE cwd (the resume
      // leg needs that one). A tracked launch whose config still lives at the
      // shared `<cwd>/.mcp.json` MUST restore it.
      if (mcpHandle && !mcpConfigPersistsOutsideCwd) restoreSpawnMcp(mcpHandle);
      if (mcpTempDir) { try { rmSync(mcpTempDir, { recursive: true, force: true }); } catch { /* best-effort */ } }
      if (codexHomeHandle) codexHomeHandle.cleanup();
      if (ompHomeHandle) ompHomeHandle.cleanup();
      if (ompCompactionOverlay) ompCompactionOverlay.cleanup();
      if (claudeConfigHandle) claudeConfigHandle.cleanup();
      void clearLane();
      resolve({ exitCode: 127, durationMs: Date.now() - startedAt });
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      // Skip the restore ONLY when the config was baked OUTSIDE cwd (the resume
      // leg needs that one). A tracked launch whose config still lives at the
      // shared `<cwd>/.mcp.json` MUST restore it.
      if (mcpHandle && !mcpConfigPersistsOutsideCwd) restoreSpawnMcp(mcpHandle);
      if (mcpTempDir) { try { rmSync(mcpTempDir, { recursive: true, force: true }); } catch { /* best-effort */ } }
      if (codexHomeHandle) codexHomeHandle.cleanup();
      if (ompHomeHandle) ompHomeHandle.cleanup();
      if (ompCompactionOverlay) ompCompactionOverlay.cleanup();
      if (claudeConfigHandle) claudeConfigHandle.cleanup();
      void clearLane();
      // bash uses exit 124 for timeout (matches `timeout` coreutil).
      const exitCode = timedOut ? 124 : (code ?? 0);
      resolve({ exitCode, durationMs: Date.now() - startedAt });
    });
  });

  // Drain the live-streaming POST queue + send a final close signal
  // so subscribers know the run finished. Best-effort throughout.
  if (harnessToken) {
    await chunkPostQueue.catch(() => {});
    try {
      await fetch(`${operatorBase}/api/internal/run-chunk`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${harnessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ runId, seq: chunkSeq, chunk: '', done: true }),
      });
    } catch { /* operator unreachable; subscribers fall back to file */ }
  }
  // Drain the optional PG-archival queue. If a chunk INSERT was still
  // in flight when the subprocess closed, this lets it complete before
  // Phase 4 finalization (run_output INSERT) runs.
  if (chunksPgCtx) {
    await chunkPgQueue.catch(() => {});
  }

  // 11. Extract result text from the in-memory accumulator.
  const rawJsonlBody = Buffer.concat(jsonlChunks).toString('utf8');
  const errBody = Buffer.concat(errChunks).toString('utf8');
  const effectiveExitCode = resolveInvocationExitCode(outcome.exitCode, rawJsonlBody, streamFormat);
  const finalText = extractResult(rawJsonlBody, streamFormat);
  // Codex transcript tee (2026-07-01): synthesize the claude-shaped wake
  // transcript the hive-tabs mirror panes tail — codex records nothing itself
  // (`--ephemeral`), which left the owner's queen/overwatch panes on "no
  // transcript found" forever after the gpt-5.4 switch. Best-effort by design.
  if (agentBackend === 'codex' && streamFormat === 'codex-json') {
    try {
      const { writeCodexTranscript } = await import('./codex-transcript');
      const teePath = writeCodexTranscript({
        sessionId: process.env.PAPERCUSP_NATIVE_SESSION_ID,
        prompt,
        rawJsonl: rawJsonlBody,
      });
      if (teePath) ctx.log(`  codex transcript → ${teePath}`);
    } catch {
      /* the tee must never fail the run */
    }
  }
  const outBody = streamFormat !== 'none' ? `${finalText}\n` : finalText;
  const streamSummary = summarizeInvocationStream(rawJsonlBody, streamFormat, finalText);
  // papercusp.run_meta (cross-backend-cost-capture D-005): stamp backend+model+role onto
  // the persisted stream so post-hoc scanners (scanAgentRuns, sumJsonlCost) can attribute
  // usage for EVERY backend without re-deriving spawn context — codex's stream names no
  // model, and the filename carries no backend. Stream parsers ignore unknown event types;
  // plain-text ('none') bodies are left untouched.
  const jsonlBody =
    streamFormat === 'none'
      ? rawJsonlBody
      : `${rawJsonlBody}${rawJsonlBody.length === 0 || rawJsonlBody.endsWith('\n') ? '' : '\n'}${JSON.stringify(
          {
            type: 'papercusp.run_meta',
            schemaVersion: 'worker-parity-v1',
            backend: agentBackend,
            engine: 'subprocess',
            model: resolvedModel,
            requestedModel,
            role,
            runId,
            featureId: featureId ?? null,
            promptHash: workerParityPromptHash(prompt, options.inlinePrompt),
            stream: streamSummary,
          },
        )}\n`;

  // 11.5. Persistence: when ctx.pg is wired, the canonical record is
  // the harness_run_output row. The on-disk jsonl/out/err files are
  // skipped entirely — replay reads from PG.
  //
  // Files are still written when:
  //   - PG isn't wired (CLI fallback — user might tail -f), OR
  //   - PAPERCUSP_KEEP_FILES=1 (explicit override for debug)
  const writeFilesForFallback = retainReleaseFixerFiles || !(ctx.pg && ctx.workspaceId)
    || process.env.PAPERCUSP_KEEP_FILES === '1';
  if (writeFilesForFallback) {
    if (!existsSync(ctx.logDir)) mkdirSync(ctx.logDir, { recursive: true });
    writeFileSync(jsonlPath, jsonlBody);
    writeFileSync(errPath, errBody);
    writeFileSync(outPath, outBody);
  }

  if (ctx.pg && ctx.workspaceId) {
    try {
      const { recordRunOutputPg } = await import('./run-output-pg');
      const { harnessSlug: getSlug } = await import('./state');
      await recordRunOutputPg(
        { pg: ctx.pg, workspaceId: ctx.workspaceId, harnessSlug: getSlug(ctx.projectDir) },
        {
          runId,
          role,
          promptBody: prompt,
          jsonlBody,
          outBody,
          errBody,
          exitCode: effectiveExitCode,
          durationMs: outcome.durationMs,
          startedAt,
          endedAt: Date.now(),
        },
      );
    } catch (err) {
      ctx.log(`  PG ingest failed (non-fatal): ${(err as Error).message}`);
    }
    // Usage telemetry (rate-limit-layer-v2 D-002 capture point 2; backend-aware +
    // run-attributed per cross-backend-cost-capture D-005): persist the run's token
    // counts + $cost from the JSONL terminal events. Best-effort — never fails the run.
    try {
      const { extractRunUsage } = await import('./cost-cap');
      const usage = extractRunUsage(jsonlBody);
      if (usage) {
        const { recordUsageSamplePg } = await import('./usage-sample-pg');
        const { harnessSlug: getSlug } = await import('./state');
        await recordUsageSamplePg(
          { pg: ctx.pg, workspaceId: ctx.workspaceId },
          {
            backend: agentBackend,
            model: resolvedModel,
            usage,
            harnessSlug: getSlug(ctx.projectDir),
            runId,
            role,
            // Native session id (claude `--session-id`) so a bee's successive
            // warm-inject/resume samples group by the session they share — the
            // carry-cost read (bee-context-efficiency P-001). Undefined → NULL
            // for omp/codex (no forced native id), matching --session-id.
            sessionId: process.env.PAPERCUSP_NATIVE_SESSION_ID,
            // Per-turn trigger (B-TOK-4): the spawn/wake stamps PAPERCUSP_TURN_TRIGGER
            // ('coord-wake' | 'cron' | 'autoloop' | 'user') so coordination-driven
            // spend is summable. Undefined → NULL ('unattributed') for an unstamped path.
            turnTrigger: process.env.PAPERCUSP_TURN_TRIGGER,
            // Provider account attribution for account-routed Claude/Codex spawns.
            accountId: process.env.PAPERCUSP_ACCOUNT_ID,
          },
        );
      }
    } catch (err) {
      ctx.log(`  usage-sample ingest failed (non-fatal): ${(err as Error).message}`);
    }
  }

  ctx.log(`invoke ${role} rc=${effectiveExitCode} (stdout: ${outPath})`);
  if (effectiveExitCode === 124) {
    ctx.log(`  role=${role} TIMED OUT after ${timeoutSeconds}s (rc=124)`);
  }
  if (effectiveExitCode !== 0) {
    const errSnippet = errBody.split(/\r?\n/).slice(0, 5);
    if (errSnippet.some((l) => l.length > 0)) {
      ctx.log('  stderr (first 5 lines):');
      for (const line of errSnippet) {
        if (line.length > 0) ctx.log(`    ${line}`);
      }
    }
  }

  // Phase 5: clean up the ephemeral omp prompt tmpdir. Always runs —
  // even on subprocess crash + PG-ingest failure — so /tmp doesn't
  // accumulate stale dirs. SIGKILL'd orchestrators leak; the OS sweeper
  // (systemd-tmpfiles on Linux, launchd on macOS) reaps them.
  if (ompPromptDir) {
    try { rmSync(ompPromptDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  // P-013: clean up the ephemeral replacement system-prompt tmpdir (same lifecycle
  // as the omp prompt dir — always runs, OS sweeper reaps a SIGKILL leak).
  if (sysPromptDir) {
    try { rmSync(sysPromptDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  return {
    output: finalText,
    jsonlPath,
    outPath,
    exitCode: effectiveExitCode,
    durationMs: outcome.durationMs,
  };
}
