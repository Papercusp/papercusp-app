/**
 * Shared backend for chat-bubble surfaces: spawns the configured agent
 * CLI (`claude -p` or `omp -p`) with structured-output streaming,
 * parses backend-specific events into a small typed event stream that
 * callers re-emit over SSE.
 *
 * Used by:
 *   - /oracle/chat               (Oracle tab, with MCP config + 6 oracle tools)
 *   - /:slug/agent-chats/:id/messages   (per-harness agent chat tabs)
 *   - /api/agent-mcp/operator-scan
 *
 * Backends:
 *   - 'claude-code': claude-cli with `--output-format stream-json`. MCP
 *     servers passed inline via `--mcp-config <json>`.
 *   - 'omp': @oh-my-pi/pi-coding-agent with `--mode json`. MCP servers
 *     passed via a per-spawn `PI_CODING_AGENT_DIR=<tmpdir>` whose
 *     `mcp.json` is written before spawn (omp loads it from disk).
 *   - 'codex': codex-cli `exec --json` (JSONL events; prompt on stdin via
 *     the trailing `-`). No --system-prompt / --mcp-config flags — both
 *     are configured through a per-spawn `CODEX_HOME=<tmpdir>` holding
 *     `AGENTS.md` (system prompt), `config.toml` (`[mcp_servers.*]`), and
 *     a symlink to `~/.codex/auth.json` (shared ChatGPT OAuth login).
 *   - 'anthropic-direct': stateless single Anthropic-format HTTP round-trip
 *     straight to api.anthropic.com (Claude OAuth session), no subprocess.
 *     No MCP. For one-shot LLM turns (judges, summarisers). (Named
 *     `meridian` until 2026-06-12 — EI-399; the local Meridian router leg
 *     is retired, see agent-insights/gym-boot-readiness-and-meridian-topology.)
 *
 * Caller responsibilities (intentionally NOT in here):
 *   - Prompt assembly (each surface loads its own prompt + memory)
 *   - Transcript persistence (agent-chats writes to per-harness DB;
 *     Oracle currently doesn't persist server-side)
 *   - Additional out-of-band events (tutorial_end, ui_command) — emit
 *     these from the route directly before/after iterating runAgentChat
 *
 * Cancellation: pass a signal; spawn is killed on abort.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { costFromTokens, type CostEstimate } from '@papercusp/model-pricing';
// Agent-turn robustness (opt-in via PAPERCUSP_AGENT_GOVERNOR=1). These modules are pure +
// import nothing from this file, so there's no cycle and ~no load cost when the flag is off.
import { runAgentTurn, type TurnOutcome } from './turn-runner';
import { planAgentSpawn, type AgentSpawnStagedDir } from './spawn-transform';
import { governorForBackend, BACKEND_PROFILES } from './governor-registry';
import { RateLimitGovernor, ROLLING_WINDOW_REPROBE_MS } from '../resilience/governor';
import { tierOf } from '../resilience/priority-admission';
import { classifyTurnError, isAccountWide, type TurnBackend, type TurnError } from './turn-error';
// WI-38316: the `grant_type=refresh_token` exchange that revives a rejected-but-locally-valid
// Claude OAuth token in place, plus the diagnosis text for when it can't.
import {
  refreshClaudeOauthCredential,
  describeClaudeAuthFailure,
  type ClaudeRefreshOutcome,
} from './claude-oauth';

/** Default cap on a CLI spawn's wait for a shared-governor permit (RB-012). Long enough to
    wait out a normal 429's retry-after, short enough that a multi-hour subscription lockout
    surfaces instead of freezing the caller for hours. */
export const DEFAULT_CLI_GOVERNOR_MAX_WAIT_MS = 5 * 60_000;

// --- In-process usage telemetry seam (rate-limit-layer-v2 D-002, capture point 1) --------------
// The stateless anthropic-direct path is the ONE place real `anthropic-ratelimit-*` headers +
// token usage are visible in-process. This lib stays host-free, so the host (operator-core)
// installs a sink at boot (`setStatelessUsageSink`) and both stateless paths (legacy + governed)
// emit one event per completed call. Best-effort: a sink failure must never break the LLM call.
export interface StatelessUsageEvent {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  /** Prompt-cache WRITE tokens (anthropic `cache_creation_input_tokens`) when reported. */
  cacheCreationTokens?: number;
  costUsd: number;
  /** Lower-cased response headers when the transport exposed them (anthropic-ratelimit-*). */
  headers?: Record<string, string | undefined>;
  /** The caller's identity for the usage row (EI-7625): whatever the caller passed as
   *  `RunAgentChatOptions.usageAttribution`, verbatim. Absent when the caller didn't say. */
  attribution?: StatelessUsageAttribution;
}

/** Who/what a stateless LLM call was FOR — attribution the host persists onto the
 *  `agent_usage_samples` row (role / run_id / session_id / tool_name). Before this seam
 *  every `source:'headers'` sample was anonymous (~73% of rows), which blinded the
 *  token-conservation dashboards to the in-process spenders. Free-text `role` names the
 *  calling feature ('haiku', 'llm-test', 'pr-reviewer', 'memory-extraction', a brain
 *  persona, …). */
export interface StatelessUsageAttribution {
  role?: string;
  runId?: string;
  sessionId?: string;
  toolName?: string;
  /** WI-2144763: which harness this spend was FOR. The host binds it straight onto
   *  `agent_usage_samples.harness_slug`, which every `source:'headers'` row left NULL
   *  (18,228 rows / ~$755) purely because this field did not exist — the column, the
   *  INSERT and the sink all already carried it. Only set it when the caller genuinely
   *  KNOWS the harness (scout/gym cycles take `harnessSlug` as a first-class param);
   *  leave it undefined for workspace-global work rather than guessing, since a wrong
   *  slug is worse than an honest NULL. */
  harnessSlug?: string;
}
let statelessUsageSink: ((ev: StatelessUsageEvent) => void) | undefined;
/** Install (or clear) the host's usage-telemetry sink. Call once at operator boot. */
export function setStatelessUsageSink(fn?: (ev: StatelessUsageEvent) => void): void {
  statelessUsageSink = fn;
}
function emitStatelessUsage(ev: StatelessUsageEvent): void {
  if (!statelessUsageSink) return;
  try {
    statelessUsageSink(ev);
  } catch {
    /* telemetry is best-effort; never throw into the LLM path */
  }
}

/**
 * Backends the in-app brains can drive. The three subprocess backends
 * (`claude-code`/`omp`/`codex`) are the canonical spawn set shared with
 * `@papercusp/orchestrator` (`AGENT_BACKENDS`) and
 * `apps/operator/lib/agent-config.ts` (`AGENT_BACKENDS`); `anthropic-direct`
 * is an extra brains-only stateless HTTP round-trip (no subprocess, not
 * spawnable by the orchestrator). The submodule boundary rules out a
 * single literal import; `apps/operator/lib/__tests__/agent-backend-sync.test.ts`
 * guards the subprocess subset against drift across the three. */
export const AGENT_BACKENDS = ['claude-code', 'omp', 'anthropic-direct', 'codex'] as const;
/** The subset that maps to a real subprocess (excludes `anthropic-direct`). */
export const SUBPROCESS_AGENT_BACKENDS = ['claude-code', 'omp', 'codex'] as const;
export type AgentBackend = (typeof AGENT_BACKENDS)[number];

/**
 * Claude Code built-ins denied by `disallowBuiltins` (claude-code) — the
 * filesystem/web/subagent/scheduling tools a persona brain never needs and
 * misuses (no-op `Bash` "comments", stray `Task`/`Write`). Captured from a
 * `claude -p` init's non-`mcp__` `tools` (v2.1).
 *
 * DELIBERATELY KEPT (NOT denied): `ToolSearch` + `ListMcpResourcesTool`/
 * `ReadMcpResourceTool`. A large `--mcp-config` surface is presented DEFERRED —
 * `ToolSearch` is how the model ACTIVATES a deferred tool before calling it.
 * Denying it left the brain unable to call ANY agentmcp tool: it narrated
 * "checking…" every turn with zero tool calls (verified regression,
 * 2026-06-02). So we trim the dangerous built-ins but preserve the tool-loading
 * path for callers that keep the deferred surface (workers/scopers etc.).
 *
 * A caller that instead SHRINKS its surface (operator brain: `?tools=`) and
 * sets `disableToolSearch` gets that small set loaded DIRECTLY — `ToolSearch`
 * is then unused (env-disabled), which is why the operator persona also tells
 * the brain never to call it (voice-persona-production-readiness P-009).
 */
export const CLAUDE_BUILTIN_TOOLS = [
  'Task', 'AskUserQuestion', 'Bash', 'CronCreate', 'CronDelete', 'CronList',
  'Edit', 'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree',
  'Glob', 'Grep', 'Monitor', 'NotebookEdit', 'PushNotification', 'Read',
  'RemoteTrigger', 'ScheduleWakeup', 'Skill', 'TaskCreate', 'TaskGet',
  'TaskList', 'TaskOutput', 'TaskStop', 'TaskUpdate',
  'WebFetch', 'WebSearch', 'Workflow', 'Write',
] as const;

/**
 * Extra spawn-env entries for the claude-code backend. Two things:
 *
 * 1. The tool-search toggle: `disableToolSearch` → `ENABLE_TOOL_SEARCH=false`, which
 *    loads the (caller-shrunk) `--mcp-config` surface DIRECTLY instead of deferring
 *    it behind `ToolSearch` — the proven non-deferral lever for the operator brain
 *    (per-tool `_meta.alwaysLoad` is NOT honored over HTTP MCP on claude-code
 *    2.1.x). See voice-persona-production-readiness P-009.
 *
 * 2. The GATEWAY ADMISSION TIER: `priority` → an `x-papercusp-priority: <label>` line
 *    in `ANTHROPIC_CUSTOM_HEADERS` (the claude CLI forwards those headers on every
 *    call). This is the SPAWN-side counterpart of `priorityTierHeaders()`, which
 *    only covers the in-process `anthropic-direct` backend. Without it a spawned
 *    claude brain is UNTIERED and the gateway drops it into the lowest default band
 *    — which is how the owner's interactive voice reply came to queue behind ~30
 *    background fleet agents under an account-pool crunch and hang ("processing
 *    forever", EI-10795). `inheritedCustomHeaders` (the spawn env's existing value)
 *    is APPENDED to rather than clobbered, so a caller that already forwards custom
 *    headers keeps them.
 *
 * Pure + exported for unit testing.
 */
export function claudeSpawnEnvOverrides(
  opts: { disableToolSearch?: boolean; priority?: string },
  inheritedCustomHeaders?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (opts.disableToolSearch) env.ENABLE_TOOL_SEARCH = 'false';
  const label = opts.priority?.trim();
  if (label) {
    const line = `${GATEWAY_PRIORITY_HEADER}: ${label}`;
    const existing = inheritedCustomHeaders?.trim();
    // Don't double-stamp: an inherited priority line already tiers this spawn.
    env.ANTHROPIC_CUSTOM_HEADERS = !existing
      ? line
      : existing.includes(`${GATEWAY_PRIORITY_HEADER}:`)
        ? existing
        : `${existing}\n${line}`;
  }
  return env;
}

/**
 * Optional bootstrap hook for callers that persist agent config to
 * disk (e.g. the operator's /settings/agent → ~/.papercusp/agent/
 * config.json). Called once per process before the first spawn so
 * saved values land in process.env. Pure consumers (visitor chatbot,
 * one-shot scripts) can leave this unset — they read env vars
 * directly and skip the disk-config concept entirely.
 */
let bootstrapHook: (() => void | Promise<void>) | null = null;
let bootstrapped = false;

export function setAgentConfigBootstrap(hook: () => void | Promise<void>): void {
  bootstrapHook = hook;
}

function maybeBootstrap(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  if (bootstrapHook) {
    // The hook may be async (the operator now reads agent config from PG).
    // Fire-and-forget: callers that depend on env being set immediately
    // already pre-warm via /api/agent-config GET on bootstrap; this hook
    // just keeps env in sync after a settings save.
    try {
      const r = bootstrapHook();
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch(() => { /* best-effort */ });
      }
    } catch { /* best-effort */ }
  }
}

/**
 * Resolve which backend to drive. Explicit opt > inferred from the
 * configured agent binary > AGENT_BACKEND env > default fallback omp.
 *
 * The binary wins over AGENT_BACKEND because the spawn path must match the
 * executable's CLI surface. A stale env/backend label paired with a different
 * AGENT_CMD is worse than ignoring the label: it sends the wrong flag set
 * (e.g. Claude flags to `codex exec`) and the brain dies before producing
 * output.
 *
 * Exported so non-runAgentChat callers with their own bespoke stream
 * parser can resolve the backend identically.
 */
export function resolveBackend(opts: RunAgentChatOptions): AgentBackend {
  if (opts.backend) return opts.backend;
  const cmd = opts.agentCmd ?? process.env.AGENT_CMD ?? process.env.CLAUDE_CMD ?? '';
  const first = cmd.split(/\s+/).filter(Boolean)[0] ?? '';
  if (/(?:^|\/)(omp|pi)$/.test(first)) return 'omp';
  if (/(?:^|\/)claude$/.test(first)) return 'claude-code';
  if (/(?:^|\/)codex$/.test(first)) return 'codex';
  const env = (process.env.AGENT_BACKEND ?? '').trim().toLowerCase();
  if (env === 'omp' || env === 'pi') return 'omp';
  if (env === 'claude-code' || env === 'claude') return 'claude-code';
  if (env === 'anthropic-direct') return 'anthropic-direct';
  if (env === 'codex') return 'codex';
  return 'omp';
}

/**
 * Resolve the agent binary. A caller-supplied `agentCmd` is the explicit
 * binary override. Otherwise an explicit per-call backend selects that
 * backend's compatible default binary; ambient AGENT_CMD / CLAUDE_CMD apply
 * only when the backend itself was inherited. This ordering is load-bearing
 * for per-surface overrides: `backends.portal='codex'` must not launch the
 * process-wide `AGENT_CMD='claude -p'` with Codex argv.
 */
export function resolveAgentBin(opts: RunAgentChatOptions, backend: AgentBackend): string {
  if (opts.agentCmd) return opts.agentCmd;
  if (opts.backend) {
    if (opts.backend === 'omp') return 'omp';
    if (opts.backend === 'codex') return 'codex';
    return 'claude';
  }
  const fromEnv = process.env.AGENT_CMD ?? process.env.CLAUDE_CMD;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  if (backend === 'omp') return 'omp';
  if (backend === 'codex') return 'codex';
  return 'claude';
}

/**
 * EI-11519: the operator PROCESS itself may run with a PATH that lacks the
 * standard per-user install dirs — a Tauri dev shell's spawned operator
 * inherits the launching shell's env, observed missing `~/.local/bin`,
 * which is exactly where the claude native installer (>=2.x, 2026-07-11)
 * puts the `claude` binary. A bare `spawn('claude')` then dies ENOENT and
 * (before the on('error') fix below) surfaced as an opaque
 * "claude-code exited ?" with empty stderr, on EVERY chat surface served
 * by that operator. Fixing one launcher's env would leave the class armed
 * for the next launcher (systemd units, CI, packaged desktop), so instead
 * augment the spawn PATH at this shared chokepoint: append the well-known
 * per-user binary dirs that exist on disk but are missing from PATH.
 * Existing PATH entries always win (append, never prepend).
 */
export function withAgentBinDirs(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = env.HOME ?? process.env.HOME ?? homedir();
  const wellKnown = [
    join(home, '.papercusp', 'bin'), // Papercusp-managed CLIs (codex)
    join(home, '.local', 'bin'), // claude native installer
    join(home, '.bun', 'bin'), // bun-installed CLIs (omp)
    join(home, '.cargo', 'bin'),
    '/home/linuxbrew/.linuxbrew/bin', // linuxbrew-installed CLIs (codex)
  ];
  const cur = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const missing = wellKnown.filter((d) => !cur.includes(d) && existsSync(d));
  if (missing.length === 0) return env;
  return { ...env, PATH: [...cur, ...missing].join(delimiter) };
}

/**
 * claude's `--model` wants a bare id (`claude-opus-4-7`) or an alias
 * (`opus`/`sonnet`/`haiku`); it rejects omp's `provider/model`
 * form (e.g. `anthropic/claude-opus-4-7`), which is what callers like the
 * operator brain default pass. Strip a single leading `provider/` segment
 * for the claude-code backend; an already-bare id passes through. (omp
 * does its own fuzzy resolution and must keep the prefix, so only the
 * claude branch calls this.)
 */
export function normalizeModelForClaude(model: string): string {
  if (!model) return model;
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(slash + 1) : model;
}

const REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Split Papercusp's `<model>[:<effort>]` selector at the subprocess boundary.
 * A colon is also legal inside some provider model ids, so only a suffix from
 * the shared reasoning vocabulary is treated as effort; every other colon is
 * part of the model id and passes through unchanged.
 */
export function splitCliModelSpec(spec: string): { model: string; effort?: string } {
  const normalized = normalizeModelForClaude(spec);
  const separator = normalized.lastIndexOf(':');
  if (separator <= 0) return { model: normalized };
  const effort = normalized.slice(separator + 1).toLowerCase();
  if (!REASONING_EFFORTS.has(effort)) return { model: normalized };
  return { model: normalized.slice(0, separator), effort };
}

/** Exact argv fragment for Claude Code's model + reasoning selectors. */
export function claudeModelSelectionArgs(spec: string): string[] {
  const { model, effort } = splitCliModelSpec(spec);
  return ['--model', model, ...(effort ? ['--effort', effort] : [])];
}

/** Exact argv fragment for Codex's model + reasoning selectors. */
export function codexModelSelectionArgs(spec: string): string[] {
  const { model, effort } = splitCliModelSpec(spec);
  return ['-m', model, ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : [])];
}

/** The standard request header carrying a caller's inference-gateway admission-tier
 *  label — the in-process counterpart of the spawn chokepoint's `ANTHROPIC_CUSTOM_HEADERS`
 *  priority line (gateway-priority-tiers-2026-06-22). Mirrors `PRIORITY_HEADER` in the
 *  gateway (kept as a literal here so this shared lib stays free of the operator import). */
export const GATEWAY_PRIORITY_HEADER = 'x-papercusp-priority';

/** Stable owner identity carried on in-process requests so the inference gateway can
 * attribute routing, stalls, and failures to the durable caller (the subprocess
 * spawn path carries the same header through `ANTHROPIC_CUSTOM_HEADERS`). */
export const GATEWAY_OWNER_HEADER = 'x-papercusp-owner';

/**
 * The inference-gateway admission-tier headers for an in-process `anthropic-direct`
 * call. Returns `{ 'x-papercusp-priority': <role> }` when a non-blank priority/role
 * label is supplied, else `{}` (an untiered call). Trimming + the blank→none collapse
 * live here so the SDK-client construction is a one-liner and the rule is unit-tested
 * without standing up the Anthropic SDK. The gateway maps the role → a tier
 * (scout/queen/overwatch/interactive = 1, bee = 3, unknown → the lowest default band);
 * omitting the header lands the request in that first-shed default band.
 */
export function priorityTierHeaders(priority: string | undefined): Record<string, string> {
  const label = priority?.trim();
  return label ? { [GATEWAY_PRIORITY_HEADER]: label } : {};
}

/** Build the owner header for an in-process gateway request. Blank identities are
 * omitted so callers cannot accidentally turn an anonymous request into a shared
 * empty owner bucket. */
export function ownerHeaders(ownerId: string | undefined): Record<string, string> {
  const owner = ownerId?.trim();
  return owner ? { [GATEWAY_OWNER_HEADER]: owner } : {};
}

/** Escape a string for a double-quoted TOML basic value. */
function tomlStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
/**
 * A TOML bare key may only contain [A-Za-z0-9_-]; codex MCP server names
 * (e.g. `papercusp-su`) qualify, but anything with a `:` or `.` (like a
 * tool-style name) must be quoted. Quote defensively.
 */
function tomlKey(s: string): string {
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : `"${tomlStr(s)}"`;
}

type ClaudeShapeMcpConfig = {
  mcpServers?: Record<string, {
    type?: string;
    url?: string;
    command?: string;
    args?: string[];
    headers?: Record<string, string>;
    env?: Record<string, string>;
  }>;
};

export function codexMcpConfigToml(mcpConfig: ClaudeShapeMcpConfig): string {
  const servers = mcpConfig.mcpServers ?? {};
  const tomlLines: string[] = [
    '# Per-spawn codex MCP config (managed by chat-stream.ts).',
  ];
  for (const [name, srv] of Object.entries(servers)) {
    tomlLines.push('', `[mcp_servers.${tomlKey(name)}]`);
    if (srv.url) {
      tomlLines.push(`url = "${tomlStr(srv.url)}"`);
      const headers = Object.entries(srv.headers ?? {});
      if (headers.length > 0) {
        const hdrInline = headers
          .map(([h, v]) => `"${tomlStr(h)}" = "${tomlStr(v)}"`)
          .join(', ');
        tomlLines.push(`http_headers = { ${hdrInline} }`);
      }
    } else if (srv.command) {
      tomlLines.push(`command = "${tomlStr(srv.command)}"`);
      if (srv.args && srv.args.length > 0) {
        tomlLines.push(
          `args = [${srv.args.map((a) => `"${tomlStr(a)}"`).join(', ')}]`,
        );
      }
    }
  }
  return tomlLines.join('\n') + '\n';
}

function gatewayPort(): number {
  const p = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  return Number.isFinite(p) && p > 0 ? p : 8788;
}

/**
 * Per-spawn codex model-provider config. `priority` adds the gateway admission-tier
 * header alongside the account route header — the codex twin of the claude spawn's
 * ANTHROPIC_CUSTOM_HEADERS line and of `priorityTierHeaders()` for anthropic-direct.
 * Without it a codex-backed brain spawns UNTIERED into the gateway's lowest default
 * band, the same starvation that hung the owner's interactive voice (EI-10795); all
 * three backends must tier identically or the bug just moves to whichever one is
 * configured.
 */
export function codexGatewayConfigToml(
  accountId?: string | null,
  priority?: string,
  gatewayOn = false,
): string {
  const pinnedAccount = accountId?.trim();
  // The explicit gateway flag is the unpinned/auto-routing mode. Keep the provider
  // block when it is enabled even if no account pin was resolved, but never emit an
  // empty account header (the gateway treats that as a real, invalid account name).
  if (!pinnedAccount && !gatewayOn) return '';
  const providerId = 'papercusp-codex-gateway';
  const label = priority?.trim();
  const httpHeaders: string[] = [];
  if (pinnedAccount) httpHeaders.push(`"${ROUTE_ACCOUNT_HEADER}" = "${tomlStr(pinnedAccount)}"`);
  if (label) httpHeaders.push(`"${GATEWAY_PRIORITY_HEADER}" = "${tomlStr(label)}"`);
  const lines = [
    '# Per-spawn codex model provider config (managed by chat-stream.ts).',
    `model_provider = "${providerId}"`,
    '',
    `[model_providers.${providerId}]`,
    'name = "Papercusp Codex Gateway"',
    `base_url = "http://127.0.0.1:${gatewayPort()}/v1"`,
    'wire_api = "responses"',
    'experimental_bearer_token = "papercusp-gateway"',
  ];
  if (httpHeaders.length > 0) lines.push(`http_headers = { ${httpHeaders.join(', ')} }`);
  lines.push('');
  return lines.join('\n');
}

export interface RunAgentChatOptions {
  /** The full assembled prompt sent to claude on stdin. */
  promptText: string;
  /**
   * When set, sent as the agent's SYSTEM prompt (omp
   * `--append-system-prompt`, claude default-prompt replacement) and
   * `promptText` is sent as the USER message. Without this, `promptText`
   * becomes the user message and the agent treats persona+playbook
   * content as something *the user handed it*, producing meta-commentary
   * instead of acting on the persona. Required for operator/oracle/
   * architect brains whose "prompt" is actually a persona spec.
   */
  systemPromptText?: string;
  /** cwd for the spawned process. Required so claude's session-scoped
      path restriction can read files referenced in the prompt. */
  cwd?: string;
  /** Inline MCP server config — JSON-stringified and passed via
      `--mcp-config`. Pass `undefined` to spawn without MCP. */
  mcpConfig?: object;
  /** Names to whitelist via `--allowed-tools "a b c"`. Required when
      mcpConfig is set, otherwise claude refuses tool calls in -p mode. */
  allowedTools?: string[];
  /** When set, only tool_use blocks whose name passes this filter are
      surfaced as `tool_call` events. Returning a string lets the caller
      strip a prefix (e.g. `mcp__oracle__navigate` → `navigate`).
      Returning null/undefined skips that tool. Default: emit all tools. */
  toolEventFilter?: (rawName: string) => string | null | undefined;
  /** Permission mode flag. Default: not set (claude prompts). Most
      backends pass 'bypassPermissions' for unattended in-app tools. */
  permissionMode?: 'bypassPermissions' | 'default' | 'ask';
  /**
   * Isolate the spawn from the host's agent config (claude-code only).
   * When set, the `claude` subprocess runs against a CLEAN per-spawn
   * `CLAUDE_CONFIG_DIR` (a fresh tmpdir) instead of the developer's
   * `~/.claude`, so it loads NONE of the host environment: no
   * `~/.claude.json` MCP servers (`coord_*`/`harness_*`/`papercusp-su`/…),
   * no SessionStart/PreToolUse hooks, no plugins/skills. The spawn sees
   * ONLY its `--mcp-config` tools + persona system prompt. The Claude-Max
   * OAuth credentials are symlinked into the clean dir so auth carries
   * over (mirrors the codex `auth.json` symlink). The tmpdir is removed
   * on child exit. REQUIRED for in-app brains (operator/oracle) that run
   * with `bypassPermissions` on a developer box — without it the brain
   * inherits the dev's full Claude Code agent surface and goes agentic
   * (calls coord/harness tools, reads files) instead of emitting a clean
   * persona turn. Not needed for stateless one-shot completions
   * (sim/judge llm-client) which pass no mcpConfig and don't tool-call. */
  isolateConfig?: boolean;
  /**
   * Block ALL Claude Code built-in tools (claude-code only) via
   * `--disallowed-tools`, leaving ONLY the `--mcp-config` tools. A
   * persona brain (operator) reaches its world exclusively through its
   * agentmcp tools and emits `<say>`/`<spawn>` as control-tag TEXT, so it
   * needs none of `Bash`/`Read`/`Edit`/`Write`/`Glob`/`Grep`/`Task`/
   * `ToolSearch`/`WebFetch`/… — and when they're present it MISUSES them
   * (a no-op `Bash` "comment", `ToolSearch`-ing for tool names that are
   * already loaded, occasionally looping until the 600 s wall-cap). With
   * `bypassPermissions`, `--allowed-tools` does NOT restrict the surface,
   * so this explicit deny-list is the lever. */
  disallowBuiltins?: boolean;
  /**
   * Load the `--mcp-config` tool surface DIRECTLY instead of deferring it
   * behind `ToolSearch` (claude-code only — sets `ENABLE_TOOL_SEARCH=false` in
   * the spawn env). Claude Code defers any MCP surface by default, so the model
   * must `ToolSearch`-activate a tool before calling it — which makes a persona
   * brain flail (multiple searches/turn, colon/underscore name guessing,
   * occasional loops to the wall-cap). Empirically (claude-code 2.1.x) the
   * per-tool `_meta.anthropic/alwaysLoad` marker is NOT honored over the HTTP
   * MCP transport; `ENABLE_TOOL_SEARCH=false` is the lever that works.
   *
   * ONLY safe when the caller has already SHRUNK the surface (the operator
   * brain pins `?tools=` to its ~50-tool working set): disabling deferral on a
   * full 200+ tool surface would dump every schema into the prompt. Pair with a
   * filtered `mcpConfig` URL. See voice-persona-production-readiness P-009. */
  disableToolSearch?: boolean;
  /** Override the agent binary. Defaults to AGENT_CMD/CLAUDE_CMD env or
      'claude'/'omp' depending on backend. */
  agentCmd?: string;
  /**
   * Which agent backend to drive. Default: env AGENT_BACKEND, else
   * inferred from the binary name. Selects flag set + stream parser.
   */
  backend?: AgentBackend;
  /**
   * Per-call model override. Both backends accept `--model <name>`.
   * claude wants exact ids ('claude-haiku-4-5'); omp does fuzzy matching
   * ('haiku' will resolve). Pass the most specific id you expect both
   * to accept.
   */
  model?: string;
  /**
   * Attribute this call's usage-telemetry row to the calling feature
   * (anthropic-direct only — the subprocess backends attribute at the spawn
   * layer). Flows onto `agent_usage_samples.role/run_id/session_id/tool_name`
   * via the host's stateless-usage sink; without it a `source:'headers'` row
   * is anonymous and invisible to per-role spend attribution. Pass at least
   * `role` (the calling feature's name) on every stateless call.
   */
  usageAttribution?: StatelessUsageAttribution;
  /** Aborts the spawn. */
  signal?: AbortSignal;
  /**
   * Resume a specific claude session by id. When set, claude continues the
   * existing conversation; when null/undefined, claude starts a fresh one.
   * Historical delegate code used this to route each delegation to either
   * a picked existing claude-session or a brand-new one.
   */
  sessionId?: string;
  /**
   * When `sessionId` is set, controls which flag to use:
   *   - 'resume' → `-r <id>` (fail if no such session in claude's store)
   *   - 'force' → `--session-id <uuid>` (create-ONLY; uuid must be valid.
   *     ⚠ NOT create-or-resume: claude-code exits 1 "Session ID … is already
   *     in use" when the id exists — verified live 2026-07-16, WI-5071. A
   *     caller reusing a session must switch to 'resume' after the first
   *     completed turn.)
   * Default: 'force' — used by historical delegate sessions since we manage
   * the session id ourselves.
   */
  sessionMode?: 'resume' | 'force';
  /**
   * CALLER-OWNED stable isolate dir (claude-code + isolateConfig only —
   * operator-chat session reuse, WI-5071). When set, the spawn uses THIS
   * directory as its clean CLAUDE_CONFIG_DIR (created if missing) instead of
   * a fresh mkdtemp, and — critically — does NOT delete it afterwards: the
   * caller owns its lifecycle. Because the spawn cwd is the config dir and
   * claude keys its on-disk session store by cwd, a stable isolateDir is what
   * makes `sessionId` reuse across separate spawns actually find the prior
   * session (a per-spawn tmp dir strands every session it creates).
   * Ignored unless `isolateConfig` is set and the backend is claude-code.
   */
  isolateDir?: string;
  /**
   * Multi-turn message history. For the stateless backend
   * (`anthropic-direct`) this is the entire conversation sent to the
   * model each turn — caller manages history. For subprocess backends
   * (`omp` / `claude-code`), `promptText` is the only user message;
   * this field is ignored (the agent loop manages its own conversation
   * state).
   */
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /**
   * Max output tokens. `anthropic-direct` honors this; `omp` /
   * `claude-code` have their own internal limits.
   */
  maxTokens?: number;
  /**
   * Sampling temperature (0–1). `anthropic-direct` honors when the model
   * accepts it (skipped for `opus*` per the Anthropic API constraint).
   * `omp` / `claude-code` ignore.
   */
  temperature?: number;
  /**
   * Thinking budget (tokens). Maps to Anthropic's `thinking: {type:
   * 'enabled', budget_tokens: N}`. `anthropic-direct` only.
   */
  thinkingBudgetTokens?: number;
  /**
   * Cap (ms) on how long a call will wait for a shared-governor permit (the ADMISSION
   * wait) before it surfaces a `rate_limited` error instead of blocking (RB-012).
   * Interactive callers (operator/oracle brains) pass a small value (or rely on `signal`)
   * so they escalate rather than inherit a far-off shared pause (D-002); unattended callers
   * (the gym) leave the default so a normal 429's retry-after is waited out.
   *
   * Honored on BOTH governed paths (widened 2026-07-13, WI-4475):
   *  - CLI spawns — default `DEFAULT_CLI_GOVERNOR_MAX_WAIT_MS`; only when `PAPERCUSP_AGENT_GOVERNOR` is on.
   *  - the in-process `anthropic-direct` path — default `runWithRetry`'s own 600s.
   *
   * WI-4475: a caller with a bounded outer budget (a scout cycle, a request deadline) MUST
   * pass this, derived from the time it actually has left. Otherwise the inner governor wait
   * (600s default) can exceed — or equal — the caller's whole budget, and a survivable
   * capacity wait gets guillotined by the caller's timer and misreported as a transport
   * "timeout" with $0 spent. Pair it with {@link onResponseStart} so the caller can charge
   * every admission layer and generation to SEPARATE budgets.
   */
  governorMaxWaitMs?: number;
  /**
   * ABSOLUTE epoch-ms deadline for the anthropic-direct transient-retry ladder (WI-5391,
   * the WI-4475 class). The 8-attempt 2/4/8/16/32/60/60/60s ladder is deliberately patient,
   * but it is deadline-blind: a caller with a hard outer budget (a scout cycle, a request
   * deadline) can have the ladder outlive its own timer, which then fires FIRST and
   * mislabels an honest, classified capacity error (429/529) as the caller's generic
   * timeout ("cycle timed out …", $0 spent). With this set, the ladder refuses to start a
   * backoff sleep it cannot pay for before the deadline and yields the LAST classified
   * transport error instead — the caller records the true condition while it still has
   * time to. Omit ⇒ the proven ladder runs unchanged. `governorMaxWaitMs` bounds one
   * ADMISSION wait; this bounds the whole retry ladder — a bounded caller wants both.
   */
  retryDeadlineMs?: number;
  /**
   * Fired once local admission completes — i.e. immediately before the underlying HTTP
   * request is issued — and again on each retry attempt. Direct-provider calls use the shared
   * provider governor; loopback-gateway calls use a request-local retry governor because the
   * gateway is already the shared pooled-admission authority (EI-20394554339706750).
   *
   * IMPORTANT: when the transport points at Papercusp's inference gateway, the request can
   * still queue behind the gateway's own admission/account governors after this callback.
   * Therefore this is not a safe generation-timer boundary; use {@link onResponseStart}.
   *
   * `anthropic-direct` only (the governed in-process path). No-op for subprocess backends.
   */
  onAdmitted?: () => void;
  /**
   * Fired when the Anthropic stream CONNECTS (response headers arrived), after both the
   * process-local governor and the inference gateway have admitted/routed the request. This
   * is the safe boundary for a caller's generation timer. Fires per successful retry attempt.
   */
  onResponseStart?: () => void;
  /**
   * Priority/role LABEL for the inference-gateway admission tier
   * (gateway-priority-tiers-2026-06-22). For the in-process `anthropic-direct`
   * backend this is attached as the `x-papercusp-priority` request header so the
   * localhost pacing gateway maps it → an admission TIER
   * (queen/scout/overwatch/interactive = 1, bee = 3, unknown → the lowest
   * `default` band). Subprocess backends carry the SAME label via the spawn
   * chokepoint's `ANTHROPIC_CUSTOM_HEADERS`; this field is the IN-PROCESS
   * counterpart. WITHOUT it an in-process caller (the scout's ideators, the gym
   * judge) is untiered → lands in the first-shed default band and is starved
   * under fleet load (root cause of the scout's 12-day ideation outage). Omit
   * for an untiered call.
   */
  priority?: string;
  /** Stable caller identity for inference-gateway owner attribution. For the
   * in-process `anthropic-direct` backend this becomes `x-papercusp-owner`;
   * subprocess callers carry the equivalent through their spawn environment. */
  ownerId?: string;
}

export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | {
      type: 'result';
      costUsd: number;
      tokensIn: number;
      tokensOut: number;
      finalText: string;
      /** Provider terminal reason when reported (for example Anthropic's
          `end_turn` or `max_tokens`). Undefined on backends that do not expose it. */
      stopReason?: string | null;
      /** Gateway account that actually served the request. The request-side pin
          is not authoritative because the gateway may fail over. */
      servedAccount?: string;
      /** Agent-loop turn count, when the backend reports it (claude-code's
          terminal `result.num_turns`). Undefined for backends that don't
          surface it (anthropic-direct/omp/codex). Lets a consumer record the
          real turn count rather than proxying off tool_call events — the
          external-bench native arm (P-007) folds it into the run-result. */
      numTurns?: number;
      /** Prompt-cache READ / WRITE input tokens when the backend reports them
          (claude-code/anthropic `cache_read_input_tokens` /
          `cache_creation_input_tokens`). `tokensIn` stays the backend's
          headline input count; these are the additive cache-priced inputs
          (@papercusp/model-pricing). Undefined when not reported. */
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      /** Number of terminal usage frames whose cost/token measurement was incomplete.
          The numeric totals remain backward-compatible, but this marker prevents a
          missing usage field from being mistaken for a measured zero. */
      unreportedFrames?: number;
    }
  | {
      type: 'error';
      message: string;
      stderr?: string;
      /**
       * RB-006: the classified turn error, when known. Lets a consumer (e.g. the gym's
       * `llmCall` → `runAbEvaluation`) distinguish a `rate_limited` failure (pause + resume)
       * from a permanent one (skip) instead of re-parsing the message string. Populated on
       * the governed stateless + CLI paths; absent on the legacy un-governed path (consumers
       * fall back to message classification / treat as a generic error).
       */
      turn?: TurnError;
    };

/** The terminal-usage slice of a claude-code `result` event (see
    {@link parseClaudeResultEvent}). Only reported keys are present. */
export interface ClaudeResultUsage {
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  numTurns?: number;
  resultText?: string;
  /** 1 when the terminal result omitted required cost or token usage evidence. */
  unreportedFrames?: number;
}

function hasFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Extract the terminal-usage slice from a claude-code `--output-format
 * stream-json` `result` event (`{type:'result', usage:{input_tokens,
 * output_tokens, cache_read_input_tokens, cache_creation_input_tokens},
 * total_cost_usd, num_turns, result}`). Pure (no closure state) so the
 * subprocess loop folds the returned fields into its accumulators AND a unit
 * test can assert the mapping without spawning `claude`. Returns ONLY the keys
 * the event actually reported, so a caller keeps its prior streamed value for
 * any absent field.
 */
export function parseClaudeResultEvent(ev: any): ClaudeResultUsage {
  const out: ClaudeResultUsage = {};
  const usage = ev?.usage;
  const hasInputTokens = typeof usage?.input_tokens === 'number' && Number.isFinite(usage.input_tokens);
  const hasOutputTokens = typeof usage?.output_tokens === 'number' && Number.isFinite(usage.output_tokens);
  const hasCost = typeof ev?.total_cost_usd === 'number' && Number.isFinite(ev.total_cost_usd);
  if (usage) {
    if (hasInputTokens) out.tokensIn = usage.input_tokens;
    if (hasOutputTokens) out.tokensOut = usage.output_tokens;
    if (typeof usage.cache_read_input_tokens === 'number')
      out.cacheReadTokens = usage.cache_read_input_tokens;
    if (typeof usage.cache_creation_input_tokens === 'number')
      out.cacheCreationTokens = usage.cache_creation_input_tokens;
  }
  if (hasCost) out.costUsd = ev.total_cost_usd;
  if (typeof ev?.num_turns === 'number') out.numTurns = ev.num_turns;
  if (typeof ev?.result === 'string') out.resultText = ev.result;
  if (!hasInputTokens || !hasOutputTokens || !hasCost) out.unreportedFrames = 1;
  return out;
}

// ===========================================================================
// Stateless `anthropic-direct` backend — a single Anthropic-format HTTP
// round-trip, NO subprocess (~100-300ms vs. ~1-2s for an agent spawn). Use
// when a caller needs an LLM round-trip but NOT a full agent loop (no MCP,
// no multi-step tool use): llm-testing judge + sim-user, summarisers,
// one-shot Q&A.
//
// Transport: DIRECT to api.anthropic.com with the Claude OAuth session
// (~/.claude/.credentials.json). The omp-era leg through the local Meridian
// router (:3456) was retired 2026-06-12 (EI-399) — the omp token died
// 2026-04-11 and every stateless call had long resolved anthropic-direct
// (agent-insights/gym-boot-readiness-and-meridian-topology is the
// historical record).
// ===========================================================================

/** Tokens this close to their recorded expiry are treated as already dead —
    a request issued now would land server-side past the cutoff. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

/**
 * Whether a token with this recorded expiry (ms epoch; null/undefined = no
 * recorded expiry) is still usable at `nowMs`. EI-281: an expired token
 * must not win transport selection over a live Claude session.
 */
export function tokenIsLive(expires: number | null | undefined, nowMs: number = Date.now()): boolean {
  return expires == null || expires > nowMs + TOKEN_EXPIRY_SKEW_MS;
}

/**
 * Claude Code's own OAuth session token (`~/.claude/.credentials.json`).
 * A Claude-Max OAuth credential that works directly against
 * api.anthropic.com with the `anthropic-beta: oauth-2025-04-20` header
 * (verified). Cached.
 *
 * Exported for consumers that need to know whether a Claude session is
 * present (e.g. the mem0 session-extraction probe) without duplicating
 * the credentials-file parsing.
 */
let _claudeTokenCache: { access: string; expires: number | null } | null | undefined;

function loadClaudeCreds(): { access: string; expires: number | null } | null {
  try {
    const raw = readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8');
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } };
    const access = parsed.claudeAiOauth?.accessToken;
    return access ? { access, expires: parsed.claudeAiOauth?.expiresAt ?? null } : null;
  } catch {
    return null;
  }
}

export function readClaudeOauthToken(): string | null {
  if (_claudeTokenCache === undefined) _claudeTokenCache = loadClaudeCreds();
  // Self-heal (EI-281, long-lived-process half): Claude OAuth tokens rotate
  // ~2-hourly on disk (claude CLI / credential-sync), so a process that
  // outlives its boot-read token must re-read the file — otherwise every
  // anthropic-direct call 401s silently until the next restart (this is what
  // starved the scout-cycle routine in the operator host).
  if (_claudeTokenCache && !tokenIsLive(_claudeTokenCache.expires)) _claudeTokenCache = loadClaudeCreds();
  if (!_claudeTokenCache || !tokenIsLive(_claudeTokenCache.expires)) return null;
  return _claudeTokenCache.access;
}

/**
 * The recorded expiry (ms epoch) of the CURRENTLY CACHED Claude OAuth token, or null when
 * there is none / it carries no expiry. WI-38316: the confusing auth failure is the one where
 * this is comfortably in the FUTURE and the API still rejects the token — the diagnosis has to
 * be able to say so.
 */
export function readClaudeOauthExpiry(): number | null {
  if (_claudeTokenCache === undefined) _claudeTokenCache = loadClaudeCreds();
  return _claudeTokenCache?.expires ?? null;
}

/**
 * Drop the cached Claude OAuth token so the next read hits
 * `~/.claude/.credentials.json` again. The claude CLI refreshes that
 * file; a long-lived process (the operator) holding the per-process
 * cache forever would eventually serve an expired token — the exact
 * silent-auth-death class that made mem0 stillborn. Callers that see a
 * 401/403 on the anthropic-direct transport invalidate, re-read, and
 * retry once (mem0-extraction-via-claude-session P-004 / D-004).
 */
export function invalidateClaudeTokenCache(): void {
  _claudeTokenCache = undefined;
}

export interface StatelessTransport {
  baseURL: string;
  token: string;
  headers: Record<string, string>;
  label: 'anthropic-direct' | 'gateway-pool';
}

/**
 * Bearer an in-process call presents to the LOCAL inference gateway when it has
 * no Claude OAuth session of its own (EI-12940). NOT a secret and NOT sent to
 * any remote host: the gateway strips inbound `authorization`/`x-api-key`
 * (gateway.ts STRIP_REQUEST) and re-auths every upstream attempt with a POOL
 * account's own credential — the inbound bearer only satisfies SDK/client
 * "token required" plumbing. Mirrors spawn-env.ts `GATEWAY_CLIENT_AUTH_TOKEN`
 * (duplicated as a bare const because papercusp-shared must not import
 * operator-core — same pattern as ROUTE_ACCOUNT_HEADER).
 */
export const GATEWAY_DELEGATED_AUTH_TOKEN = 'papercusp-gateway';

/** True when `u` parses to a loopback host — the only place the delegated
 *  placeholder bearer is allowed to go (never a remote API host). */
function isLocalhostUrl(u: string): boolean {
  try {
    const h = new URL(u).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Where a DELEGATED (no-local-token) stateless call should egress (EI-12940):
 * the env-configured base URL when it already points at a loopback host (that
 * IS the pacing gateway), else the well-known local gateway
 * `http://127.0.0.1:<PAPERCUSP_GATEWAY_PORT|8788>`. A configured NON-loopback
 * URL (e.g. api.anthropic.com) is deliberately ignored here: the placeholder
 * bearer must never egress to a real API host. The gateway is a standing
 * component on every papercusp host (host-bootstrap spawns/adopts it
 * unconditionally), so the default port is a sound last resort.
 */
export function resolveDelegatedGatewayUrl(): string {
  const configured = process.env.PAPERCUSP_ANTHROPIC_URL ?? process.env.ANTHROPIC_BASE_URL;
  if (configured && isLocalhostUrl(configured)) return configured;
  return `http://127.0.0.1:${gatewayPort()}`;
}

/**
 * Base URL for an in-process anthropic-direct (OAuth) call. Precedence:
 *   1. `PAPERCUSP_ANTHROPIC_URL` — the papercusp-specific override.
 *   2. `ANTHROPIC_BASE_URL` — the standard var the inference gateway exports
 *      for egress (inference-gateway/spawn-env.ts), so an IN-PROCESS call routes
 *      through the pacing gateway exactly like a spawned `claude -p` bee whenever
 *      the gateway is up (EI-456). Before this fallback only SPAWNED subprocesses
 *      were gateway-paced; in-process judge/proposer calls egressed direct.
 *   3. `https://api.anthropic.com` — direct.
 * Behavior is unchanged when neither env var is set.
 * Only for the OAuth/anthropic-direct path — an explicit `ANTHROPIC_API_KEY`
 * caller must NOT use this (the gateway strips x-api-key and re-auths to the
 * bound pool account, so a BYO-key call would silently use the pool).
 */
export function resolveAnthropicBaseUrl(): string {
  return (
    process.env.PAPERCUSP_ANTHROPIC_URL ??
    process.env.ANTHROPIC_BASE_URL ??
    'https://api.anthropic.com'
  );
}

/** The header the inference gateway reads to pin a request to a specific pool account's
 *  per-credential cache + per-account rate bucket (gateway.ts `ACCOUNT_HEADER`). Duplicated as a
 *  bare const here because papercusp-shared must not import operator-core (dependency direction). */
export const ROUTE_ACCOUNT_HEADER = 'x-papercusp-account';

/** Per-request account routing for in-process model calls. A blank value is the
 * gateway's auto-routing mode (no pin); a concrete id is an explicit hard
 * route for this one request. */
export function routeAccountHeaders(accountId: string | undefined): Record<string, string> {
  const id = accountId?.trim();
  return id ? { [ROUTE_ACCOUNT_HEADER]: id } : {};
}

/**
 * The pool account this IN-PROCESS anthropic-direct call should egress through, when the operator has
 * resolved one (account-aware-rate-governor-routing Phase 2). The operator sets `PAPERCUSP_ROUTE_ACCOUNT`
 * on its process env (per the per-account drain selector) so a Queen-brain / in-process operator call
 * spreads across the pool instead of all hammering the gateway's fixed `active()` account → 429-ing it →
 * poisoning the global opus bucket. Empty/unset ⇒ no header ⇒ the gateway routes to active() (today's
 * behavior). Env-based to keep this lib free of an operator-core import (mirrors `resolveAnthropicBaseUrl`).
 */
let routePinWarned = false;
export function resolveRouteAccountId(): string | undefined {
  const v = process.env.PAPERCUSP_ROUTE_ACCOUNT?.trim();
  // Loud footgun guard (autonomous-loop-hardening B4/F5): a single-account PIN on the
  // in-process anthropic-direct path has NO failover — if that one account hits its rate
  // window, in-process calls 429 with nothing to fall back on (this silently gated the
  // scout-cycle circuit). The gateway auto-routes + fails over; this pin bypasses that. The
  // owner mandate is pool AUTO-routing, so a set pin should be rare + deliberate — make it
  // loud (once per process) rather than silent. Warn does not change behavior.
  if (v && !routePinWarned) {
    routePinWarned = true;
    console.warn(
      `[route-account] ⚠ PAPERCUSP_ROUTE_ACCOUNT pins in-process anthropic-direct egress to a SINGLE ` +
        `pool account ('${v}') with NO 429 failover (autonomous-loop-hardening B4/F5). The owner mandate ` +
        `is gateway auto-routing across the pool — leave this UNSET unless deliberately/temporarily pinning.`,
    );
  }
  return v || undefined;
}

function anthropicDirectTransport(claudeTok: string): StatelessTransport {
  const headers: Record<string, string> = { 'anthropic-beta': 'oauth-2025-04-20' };
  // Phase 2: pin in-process egress to the operator-resolved pool account so the gateway routes it to
  // that credential's per-account bucket (account-aware) instead of the account-blind active().
  const routeAccount = resolveRouteAccountId();
  if (routeAccount) headers[ROUTE_ACCOUNT_HEADER] = routeAccount;
  return {
    baseURL: resolveAnthropicBaseUrl(),
    token: claudeTok,
    headers,
    label: 'anthropic-direct',
  };
}

/**
 * Delegated transport for a caller with NO usable local Claude OAuth session
 * (EI-12940): egress via the LOCAL inference gateway, which strips the inbound
 * placeholder bearer and re-auths each upstream attempt with a pool account's
 * own credential. Before this fallback existed, one stale/missing
 * `~/.claude/.credentials.json` took the whole learning loop down for 5h
 * (2026-07-16) while a 12-account pool sat idle behind a running gateway.
 * Keeps the route-account pin + tier headers at parity with the direct path.
 */
function gatewayPoolTransport(accountId?: string): StatelessTransport {
  const headers: Record<string, string> = { 'anthropic-beta': 'oauth-2025-04-20' };
  const routeAccount = accountId?.trim() || resolveRouteAccountId();
  if (routeAccount) headers[ROUTE_ACCOUNT_HEADER] = routeAccount;
  return {
    baseURL: resolveDelegatedGatewayUrl(),
    token: GATEWAY_DELEGATED_AUTH_TOKEN,
    headers,
    label: 'gateway-pool',
  };
}

/**
 * Env marker meaning "the owner has nominated a pool account as the default, so this box's
 * own ~/.claude login is no longer what unpinned traffic should use"
 * (default-deploy-account-2026-08-08 P-008 / D-004). Set by operator-core, which owns the
 * override row; env-based to keep this lib free of an operator-core import, exactly like
 * `resolveAnthropicBaseUrl` and `resolveRouteAccountId` above.
 *
 * Deliberately a BOOLEAN marker and not the account id: the id would invite stamping it as
 * an `x-papercusp-account` pin, which is a HARD pin with no failover (see the footgun warning
 * on resolveRouteAccountId). The default must stay a preference — the gateway already returns
 * it as the failover PRIMARY with the rest of the pool behind it.
 */
export const DEFAULT_ACCOUNT_ACTIVE_ENV = 'PAPERCUSP_DEFAULT_ACCOUNT_ACTIVE';

/** Read fresh on every call — never cached, so clearing the default takes effect at once. */
export function defaultAccountActive(): boolean {
  const v = process.env[DEFAULT_ACCOUNT_ACTIVE_ENV]?.trim();
  return v === '1' || v === 'true';
}

/**
 * Pure transport choice for a stateless Anthropic-format call:
 *   • the owner nominated a DEFAULT pool account → `gateway-pool`, EVEN with a live local
 *     session. This is the whole point of the default (D-004): judges, sim-users,
 *     summarisers and memory session-extraction are exactly the callers that used to be
 *     pinned to `~/.claude` by construction, so leaving them on the local token would make
 *     "set a default" quietly mean "…except for most in-process traffic". The gateway
 *     re-resolves the pool on its own hot-reload poll and returns the default FIRST with the
 *     rest behind it, so this keeps failover rather than pinning.
 *   • else a live Claude OAuth session → `anthropic-direct`.
 *   • else → `gateway-pool` (EI-12940: delegate auth to the local inference gateway's
 *     account pool instead of failing — a single stale credential file must never be a SPOF
 *     while a pool sits behind a running gateway).
 *
 * The token the caller passes is already expiry-filtered (`readClaudeOauthToken` returns null
 * for an expired session — EI-281). The omp-token → Meridian-router leg was removed
 * 2026-06-12 (EI-399). With no default set, behaviour is byte-identical to before.
 */
export function chooseStatelessTransport(args: {
  claudeTok: string | null;
  /** Defaults to the env marker; injectable so the choice stays pure + unit-testable. */
  defaultAccountSet?: boolean;
}): 'anthropic-direct' | 'gateway-pool' {
  if (args.defaultAccountSet ?? defaultAccountActive()) return 'gateway-pool';
  return args.claudeTok ? 'anthropic-direct' : 'gateway-pool';
}

/** Exported (P-007 own-tui-full-divorce-2026-08-24): the agent-loop's
 *  gateway-native ModelPort adapter rides the EXACT transport resolution the
 *  stateless family uses — same OAuth/delegation choice, same route-account
 *  pin, same base-URL precedence — so the owned loop can never disagree with
 *  the proven call path. */
export function resolveStatelessTransport(accountId?: string): StatelessTransport {
  // A concrete per-request account selection necessarily rides the local
  // gateway: a direct Anthropic endpoint cannot interpret the routing header.
  if (accountId?.trim()) return gatewayPoolTransport(accountId);
  const claudeTok = readClaudeOauthToken();
  const choice = chooseStatelessTransport({ claudeTok });
  return choice === 'anthropic-direct'
    ? anthropicDirectTransport(claudeTok!)
    : gatewayPoolTransport();
}

/**
 * Governor for one stateless HTTP call. A loopback transport is Papercusp's local inference
 * gateway, which already owns pooled account selection, cross-account admission, priority
 * tiers, per-account pacing, and failover. Putting the account-blind process singleton in
 * front of that queue creates a duplicate maxConcurrent=3 choke point: three unrelated
 * in-process calls can reject a fourth even while the gateway pool has free accounts.
 *
 * Keep a REQUEST-LOCAL governor for gateway calls rather than dropping `runAgentTurn`: it
 * preserves the classified retry loop and its retry-after sleep between this call's attempts,
 * but cannot couple concurrent calls through a fake single-provider bucket. A real remote
 * provider transport keeps the shared singleton exactly as before.
 *
 * Exported as the regression seam so tests can prove four pooled gateway calls do not share
 * the historical 3-slot bucket without standing up the Anthropic SDK or gateway.
 */
export function governorForStatelessTransport(
  transport: { baseURL: string },
  model: string,
): RateLimitGovernor {
  return isLocalhostUrl(transport.baseURL)
    ? new RateLimitGovernor({ maxConcurrent: 1 })
    : governorForBackend('anthropic-direct', model);
}

export type StatelessTransportProbe =
  | { ok: true; label: 'anthropic-direct' | 'gateway-pool' }
  | { ok: false; error: string };

/**
 * Transport-resolution probe for health monitors: would a stateless call
 * resolve a transport right now, without issuing one — and WHICH one. Shares
 * the exact resolution the real calls use, so a health leg riding it can never
 * disagree with the call path. Since EI-12940 a missing/expired local Claude
 * session resolves `gateway-pool` (auth delegated to the local gateway's
 * account pool) rather than failing — pair this with the gateway `/healthz`
 * reachability leg (learning-infra-health already does) for the composite
 * "can a call actually succeed" verdict. NEVER TCP-probe :3456 for this — the
 * retired local Meridian router not running is the normal state (EI-399; see
 * agent-insights/gym-boot-readiness-and-meridian-topology).
 */
export function probeStatelessTransport(): StatelessTransportProbe {
  const t = resolveStatelessTransport();
  return { ok: true, label: t.label };
}

interface ModelPrice { in: number; out: number }
const ANTHROPIC_PRICES: Record<string, ModelPrice> = {
  // Anthropic family (per 1M tokens, USD; approximate 2026-05 reference)
  'claude-haiku-4-5':  { in: 0.80, out: 4.00 },
  'claude-sonnet-4-6': { in: 3.00, out: 15.00 },
  // Opus 4.5+ list price is $5/$25 — $15/$75 is the LEGACY (4.1-and-earlier) rate.
  // 4-7/4-8 were stale here and 3x-overstated cost; corrected 2026-08-11 to match
  // libs/generic/model-pricing + libs/generic/bench-metrics (the canonical tables).
  'claude-opus-5':     { in: 5.00, out: 25.00 },
  'claude-opus-4-8':   { in: 5.00, out: 25.00 },
  'claude-opus-4-7':   { in: 5.00, out: 25.00 },
};
function anthropicPriceFor(model: string): ModelPrice {
  if (ANTHROPIC_PRICES[model]) return ANTHROPIC_PRICES[model];
  const prefix = Object.keys(ANTHROPIC_PRICES).find((m) => model.startsWith(m));
  return prefix ? ANTHROPIC_PRICES[prefix] : { in: 0, out: 0 };
}

/**
 * Estimate a Codex turn from the canonical cross-backend price table.
 * OpenAI's input_tokens includes cached_input_tokens, while costFromTokens
 * expects uncached input separately, so split the two before estimating.
 * The priced bit is load-bearing: an unknown model is incomplete telemetry,
 * never evidence that the turn was free.
 */
export function estimateCodexUsageCost(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): CostEstimate {
  const cached = Math.max(0, Math.min(inputTokens, cachedInputTokens));
  return costFromTokens(model ?? 'gpt-5.5', {
    inputTokens: Math.max(0, inputTokens - cached),
    outputTokens,
    cacheReadTokens: cached,
  });
}

/**
 * Codex JSON events split an MCP call's server and tool into separate fields,
 * while Claude reports the qualified `mcp__<server>__<tool>` name that shared
 * filters already consume. Reconstruct that backend-neutral filter input, but
 * keep an already-qualified or serverless tool unchanged.
 */
export function codexMcpToolFilterInput(server: unknown, tool: string): string {
  if (tool.startsWith('mcp__')) return tool;
  const normalizedServer = typeof server === 'string' ? server.trim() : '';
  return normalizedServer ? `mcp__${normalizedServer}__${tool}` : tool;
}

export type CodexMcpFailureClass =
  | 'authorization'
  | 'cancelled'
  | 'invalid_request'
  | 'server_error'
  | 'timeout'
  | 'tool_error'
  | 'transport'
  | 'unavailable'
  | 'unknown';

export interface CodexMcpFailureDebugFields {
  failureClass: CodexMcpFailureClass;
  detailSources: string;
  errorShape: string;
  resultShape: string;
  scannedChars: number;
  errorCode?: string;
  resultIsError?: boolean;
}

const CODEX_FAILURE_TEXT_KEYS = new Set([
  'content', 'data', 'detail', 'details', 'error', 'message', 'output', 'result', 'text',
]);
const CODEX_FAILURE_SHAPE_KEYS = [
  'code', 'content', 'data', 'details', 'error', 'is_error', 'isError', 'message', 'output', 'result', 'text',
] as const;
const CODEX_FAILURE_SCAN_MAX_CHARS = 2_048;

function codexFailureValueShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value !== 'object') return typeof value;
  const record = value as Record<string, unknown>;
  const safeKeys = CODEX_FAILURE_SHAPE_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(record, key));
  return safeKeys.length > 0 ? `object:${safeKeys.join(',')}` : 'object';
}

function codexFailureText(value: unknown, depth = 0, budget = CODEX_FAILURE_SCAN_MAX_CHARS): string {
  if (budget <= 0 || value == null) return '';
  if (typeof value === 'string') return value.slice(0, budget);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).slice(0, budget);
  if (depth >= 4) return '';

  const values = Array.isArray(value)
    ? value.slice(0, 8)
    : Object.entries(value as Record<string, unknown>)
        .filter(([key]) => CODEX_FAILURE_TEXT_KEYS.has(key))
        .slice(0, 12)
        .map(([, child]) => child);
  let out = '';
  for (const child of values) {
    const next = codexFailureText(child, depth + 1, budget - out.length);
    if (!next) continue;
    out += `${out ? ' ' : ''}${next}`;
    if (out.length >= budget) break;
  }
  return out.slice(0, budget);
}

function codexFailureClass(text: string, resultIsError: boolean | undefined): CodexMcpFailureClass {
  if (/cancel(?:led|ed|ation)?|declined|denied by (?:the )?user/i.test(text)) return 'cancelled';
  if (/\b(?:401|403)\b|unauthenticated|unauthorized|forbidden|permission(?: denied| error)?|not authorized/i.test(text)) {
    return 'authorization';
  }
  if (/timed? out|timeout|deadline exceeded/i.test(text)) return 'timeout';
  if (/connection|connect(?:ion)? refused|transport|channel closed|socket|econn(?:refused|reset)|fetch failed/i.test(text)) {
    return 'transport';
  }
  if (/not found|unknown tool|tool (?:is )?unavailable|unavailable in this session|does not exist/i.test(text)) {
    return 'unavailable';
  }
  if (/invalid (?:argument|params?|request)|validation|schema|bad request|\b(?:400|422|-32602)\b/i.test(text)) {
    return 'invalid_request';
  }
  if (/server (?:error|overloaded)|internal (?:error|failure)|\b(?:500|502|503|504|-32603|-32001)\b/i.test(text)) {
    return 'server_error';
  }
  if (resultIsError || /\berror\b|\bfailed\b/i.test(text)) return 'tool_error';
  return 'unknown';
}

/**
 * Extract a bounded, non-secret diagnostic from a failed Codex MCP JSONL item.
 * The raw failure may contain tool output, prompt text, arguments, bearer tokens,
 * or credentials, so this deliberately returns only a coarse class, safe field
 * SHAPES, a sanitized machine code, and counts. Raw values never leave memory.
 */
export function codexMcpFailureDebugFields(itemValue: unknown): CodexMcpFailureDebugFields {
  const item = itemValue && typeof itemValue === 'object'
    ? itemValue as Record<string, unknown>
    : {};
  const sources = ['error', 'message', 'result', 'output']
    .filter((key) => Object.prototype.hasOwnProperty.call(item, key));
  const result = item.result;
  const resultRecord = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : null;
  const resultIsError = typeof resultRecord?.isError === 'boolean'
    ? resultRecord.isError
    : typeof resultRecord?.is_error === 'boolean'
      ? resultRecord.is_error
      : undefined;
  const text = sources
    .map((key) => codexFailureText(item[key]))
    .filter(Boolean)
    .join(' ')
    .slice(0, CODEX_FAILURE_SCAN_MAX_CHARS);

  const errorRecord = item.error && typeof item.error === 'object' && !Array.isArray(item.error)
    ? item.error as Record<string, unknown>
    : null;
  const nestedError = resultRecord?.error && typeof resultRecord.error === 'object' && !Array.isArray(resultRecord.error)
    ? resultRecord.error as Record<string, unknown>
    : null;
  const rawCode = errorRecord?.code ?? nestedError?.code ?? resultRecord?.code;
  const safeCode = typeof rawCode === 'number' && Number.isFinite(rawCode)
    ? String(rawCode)
    : typeof rawCode === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(rawCode)
      ? rawCode
      : undefined;

  return {
    failureClass: codexFailureClass(text, resultIsError),
    detailSources: sources.length > 0 ? sources.join(',') : 'none',
    errorShape: codexFailureValueShape(item.error),
    resultShape: codexFailureValueShape(result),
    scannedChars: text.length,
    ...(safeCode ? { errorCode: safeCode } : {}),
    ...(resultIsError !== undefined ? { resultIsError } : {}),
  };
}

/** Upper bound on the backend failure line carried in a terminal error message. */
const BACKEND_FAILURE_LINE_MAX_CHARS = 400;

/**
 * WI-10003188 — reduce a CLI backend's own failure text to ONE human-readable line.
 *
 * Providers often hand the CLI a JSON error envelope that the CLI then forwards as a
 * STRING (measured codex-cli 0.157.1: `{"type":"error","status":400,"error":{"type":
 * "invalid_request_error","message":"The '…' model is not supported …"}}`). When the whole
 * text parses as such an envelope, the innermost `error.message` / `message` is the line a
 * person can act on. Otherwise the first non-empty line is taken as-is, capped.
 */
export function backendFailureLine(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const nested = parsed?.error && typeof parsed.error === 'object'
        ? (parsed.error as Record<string, unknown>).message
        : undefined;
      const inner = typeof nested === 'string' && nested.trim()
        ? nested
        : typeof parsed?.message === 'string' ? parsed.message : undefined;
      if (typeof inner === 'string' && inner.trim()) text = inner.trim();
    } catch { /* not an envelope — keep the text */ }
  }
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  return line.length > BACKEND_FAILURE_LINE_MAX_CHARS
    ? `${line.slice(0, BACKEND_FAILURE_LINE_MAX_CHARS - 1)}…`
    : line;
}

/**
 * WI-10003188 — the failure text a `codex exec --json` frame carries, or null.
 *
 * codex reports a failed turn ON STDOUT, with an empty stderr (measured codex-cli 0.157.1):
 *   {"type":"error","message":"<text>"}
 *   {"type":"turn.failed","error":{"message":"<text>"}}
 * An `item.completed` whose `item.type` is `error` is a NON-fatal warning (e.g. "Model
 * metadata for `x` not found. Defaulting to fallback metadata") — never the cause.
 */
export function codexFailureFrameMessage(ev: unknown): string | null {
  if (!ev || typeof ev !== 'object') return null;
  const frame = ev as Record<string, unknown>;
  if (frame.type === 'turn.failed') {
    const err = frame.error && typeof frame.error === 'object' ? frame.error as Record<string, unknown> : null;
    return typeof err?.message === 'string' && err.message.trim() ? err.message : null;
  }
  if (frame.type === 'error') {
    return typeof frame.message === 'string' && frame.message.trim() ? frame.message : null;
  }
  return null;
}

/**
 * WI-10003188 — the failure text of a claude `stream-json` terminal `result` frame, or null.
 * An `is_error:true` result carries the account/API wall ("Invalid API key · Please run
 * /login", "API Error: 401 … OAuth token has been revoked …") in `result`.
 */
export function claudeFailureResultMessage(ev: unknown): string | null {
  if (!ev || typeof ev !== 'object') return null;
  const frame = ev as Record<string, unknown>;
  if (frame.type !== 'result' || frame.is_error !== true) return null;
  return typeof frame.result === 'string' && frame.result.trim() ? frame.result : null;
}

/**
 * The terminal error message for a CLI backend that exited non-zero. Keeps the
 * `<backend> exited <code>` prefix every consumer already matches, and appends the
 * backend's own failure line when it reported one — so a hosted surface that renders
 * only this message tells the customer WHY (plan cap, revoked login) instead of a bare
 * exit code.
 */
export function agentExitErrorMessage(
  backend: string,
  exitCode: number | null,
  failureLine: string | null,
): string {
  const base = `${backend} exited ${exitCode ?? '?'}`;
  return failureLine ? `${base}: ${failureLine}` : base;
}

function isTransientLlmError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Anthropic SDK APIError surfaces as `<status> <body>` in .message.
  // Retry on 529 overloaded, 429 rate-limit, 5xx, and network blips.
  return /(\b529\b|overloaded|rate.?limit|service unavailable|\b50[02-4]\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up)/i.test(msg);
}

/**
 * Connection-level failure to reach the transport at all. The Anthropic SDK
 * masks the underlying syscall error as APIConnectionError with the bare
 * message "Connection error." — which `isTransientLlmError` deliberately does
 * NOT match (retrying an unreachable endpoint 8 times helps nobody). Kept
 * exported for consumers that classify connection-level death (EI-281), not
 * as a retry classifier.
 */
export function isConnectionFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /(connection error|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up)/i.test(msg);
}

/** Auth rejection (expired/revoked token). The Anthropic SDK APIError carries
    `.status`; the message form is `<status> <body>`. Used for the EI-281
    rotated-token retry on anthropic-direct, not as a general retry classifier. */
export function isAuthFailure(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (status === 401 || status === 403) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /^\s*40[13]\b/.test(msg) || /authentication_error|permission_error/i.test(msg);
}

/** Prompt-caching is ON unless explicitly disabled (RB-008). Off-switch:
    `PAPERCUSP_PROMPT_CACHE=0` (e.g. if a transport rejects `cache_control`). */
export function promptCacheEnabled(): boolean {
  return process.env.PAPERCUSP_PROMPT_CACHE !== '0';
}

/** A cached system text block. */
type CachedSystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl?: '5m' | '1h' } };

/**
 * Build the stateless call's `system` request field (RB-008: prompt caching).
 *
 * When caching is enabled we send the system prompt as a single text block marked
 * `cache_control: { type: 'ephemeral' }` instead of a bare string. The system prompt is the
 * large STABLE prefix on our in-process stateless calls (the gym judge's frozen 32k-thinking
 * rubric, the sim-user persona, the generators' instructions) while the user turn varies —
 * so caching it makes the prefix a cache-READ on repeat calls, and cache-read input tokens
 * don't count toward ITPM, raising effective throughput (the cheapest rate-limit pressure
 * relief per the plan review). Anthropic ignores `cache_control` below the minimum cacheable
 * size, so it's a safe no-op on short prompts; the off-switch covers a transport that rejects
 * the field outright.
 */
/** Optional extended cache TTL for the shared system prefix (inference-gateway-multi-credential-
    routing P-006). `PAPERCUSP_PROMPT_CACHE_TTL=1h` opts the large STABLE in-process system prefix
    into the 1-hour cache window — it survives the longer inter-hit gaps once load spreads across
    credentials (a 1h-TTL write costs ~2× but breaks even at ~3 reads, easily met for a hot prefix).
    Unset / any other value = the default 5-minute ephemeral window (byte-identical to today).
    NOTE: fleet `claude -p` bees manage their own cache_control inside the CLI (out of our control),
    so this covers the in-process anthropic-direct calls (gym judge / sim-user) — the cache_control
    we DO own. */
export function promptCacheTtl(): '1h' | undefined {
  return process.env.PAPERCUSP_PROMPT_CACHE_TTL === '1h' ? '1h' : undefined;
}

/**
 * The Claude Code identifier — MUST be the FIRST `system` block on a Max-OAuth (Claude Max subscription
 * OAuth) request, which is what every inference-gateway pool credential is. WITHOUT it, Anthropic shunts
 * the request to a far stricter rate-limit bucket that bogus-429s, especially on opus — confirmed live
 * 2026-06-30: opus returned 200 in 2.6s WITH this block but 20s-timeout/429 WITHOUT, through the gateway.
 * The `claude` CLI fleet bees self-frame (they ARE Claude Code); our IN-PROCESS anthropic-direct calls
 * (scout ideators / gym judge / sim-user / transfer) did NOT — which is exactly why the headless
 * autonomous loop's opus calls 429'd while interactive terminal (claude-CLI) sessions on the same box
 * worked. Same string as `su.ts` CLAUDE_CODE_IDENTIFIER + the external-bench copies — keep in sync.
 */
export const CLAUDE_CODE_IDENTIFIER = "You are Claude Code, Anthropic's official CLI for Claude.";

export function buildSystemParam(systemPromptText: string, cache: boolean = promptCacheEnabled()): CachedSystemBlock[] {
  // FIRST block = the Claude Code identifier (auth-bucket framing, see CLAUDE_CODE_IDENTIFIER), as a
  // SEPARATE block; then the caller's prompt — which is the cache_control breakpoint (the large STABLE
  // prefix) when caching is on. Always returns the block-array form so the identifier is present even
  // when caching is off or the caller passes no system prompt.
  const idBlock: CachedSystemBlock = { type: 'text', text: CLAUDE_CODE_IDENTIFIER };
  if (!systemPromptText) return [idBlock];
  if (!cache) return [idBlock, { type: 'text', text: systemPromptText }];
  const ttl = promptCacheTtl();
  const cache_control = ttl ? ({ type: 'ephemeral', ttl } as const) : ({ type: 'ephemeral' } as const);
  return [idBlock, { type: 'text', text: systemPromptText, cache_control }];
}

async function* statelessAgentChat(
  opts: RunAgentChatOptions,
): AsyncGenerator<ChatEvent, void, void> {
  if (opts.mcpConfig) {
    yield { type: 'error', message: 'anthropic-direct backend does not support mcpConfig — use omp/claude-code for MCP-bearing turns' };
    return;
  }
  if (!opts.model) {
    yield { type: 'error', message: 'anthropic-direct backend requires opts.model (resolve via modelRoles or pass explicitly)' };
    return;
  }
  // Resolve transport: direct-to-Anthropic with the Claude OAuth session, or
  // gateway-pool delegation when no usable local session exists (EI-12940 —
  // see resolveStatelessTransport / gatewayPoolTransport).
  let transport: StatelessTransport = resolveStatelessTransport();

  // Lazy-load the SDK so consumers that never use this path don't pay the import
  // cost. Dynamic `import()` (not a static top-level import) keeps it lazy, stays
  // inlinable by the desktop sidecar's esbuild bundle, and resolves the class off
  // the module namespace at runtime — avoiding the ESM↔CJS named-import linking
  // failure under tsx (operator-core is `"type": "module"`).
  const sdkMod = await import('@anthropic-ai/sdk');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Anthropic: any = (sdkMod as { default?: unknown }).default ?? sdkMod;

  // Gateway admission-tier label (gateway-priority-tiers-2026-06-22): attach the
  // caller's role as `x-papercusp-priority` so the localhost pacing gateway tiers
  // THIS in-process request (the subprocess path carries the same header via
  // ANTHROPIC_CUSTOM_HEADERS). Without it the request is untiered → the gateway's
  // lowest `default` band (first-shed under AIMD shrink) and starves under fleet
  // load — the root cause of the scout's 12-day ideation outage (it routed through
  // the gateway via gatewayLlmEnv but never identified itself as `scout`).
  const tierHeaders = priorityTierHeaders(opts.priority);
  const callerHeaders = ownerHeaders(opts.ownerId);
  const mkClient = (t: StatelessTransport) =>
    new Anthropic({
      baseURL: t.baseURL,
      authToken: t.token,
      defaultHeaders: { ...t.headers, ...tierHeaders, ...callerHeaders },
      maxRetries: 2,
    });
  let client = mkClient(transport);

  // Build request params. messages overrides promptText for multi-turn.
  const messages = opts.messages && opts.messages.length > 0
    ? opts.messages
    : [{ role: 'user' as const, content: opts.promptText }];
  // opus models reject the temperature parameter (Anthropic API
  // constraint as of 2026-05); skip pre-emptively.
  const sendsTemperature = !/opus/i.test(opts.model);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: Record<string, any> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    messages,
  };
  // ALWAYS set `system` (even with no caller prompt) so the Claude Code identifier frames the auth
  // bucket — a Max-OAuth request with no/un-framed system block is shunted to the stricter 429 bucket.
  params.system = buildSystemParam(opts.systemPromptText ?? '');
  if (sendsTemperature && opts.temperature !== undefined) params.temperature = opts.temperature;
  if (opts.thinkingBudgetTokens && opts.thinkingBudgetTokens > 0) {
    params.thinking = { type: 'enabled', budget_tokens: opts.thinkingBudgetTokens };
  }

  // Robustness opt-in (agent-turn-robustness P-004): route through the shared
  // RateLimitGovernor + runAgentTurn so concurrent callers pace under the provider's
  // limit and a 429 honors the server's retry-after instead of a blind backoff. OFF by
  // default → the proven retry loop below runs unchanged (zero behavior change for the
  // live fleet until validated).
  if (process.env.PAPERCUSP_AGENT_GOVERNOR === '1') {
    yield* governedStatelessChat(client, params, opts, { transport, mkClient });
    return;
  }

  // Patient retry on transient errors (sustained 529 overload). 8
  // attempts, backoff 2/4/8/16/32/60/60/60s + SDK's own retries.
  const RETRY_MAX = 8;
  const RETRY_CAP_MS = 60_000;
  let lastErr: unknown;
  // WI-38316 auth-diagnosis state: what the local credential claimed at the moment it was
  // rejected, and what the one-shot refresh attempt made of it. Both feed the error text so a
  // failure that survives the retry ladder explains ITSELF instead of reading as misconfig.
  let refreshAttempted = false;
  let refreshOutcome: ClaudeRefreshOutcome | undefined;
  let authExpiresAt: number | null = null;
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    if (opts.signal?.aborted) {
      yield { type: 'error', message: 'anthropic-direct: aborted' };
      return;
    }
    try {
      // Use the streaming transport (.stream().finalMessage()) rather than the
      // non-streaming .create(): the Anthropic SDK REJECTS a non-streaming request
      // whose max_tokens could exceed the 10-minute ceiling (e.g. the gym's frozen
      // Opus judge runs 32k-token extended thinking → ~36k max_tokens, which trips
      // "Streaming is required for operations that may take longer than 10 minutes").
      // .stream() satisfies that guard; .finalMessage() resolves to the same full
      // Message (content + usage), so the downstream extraction below is unchanged.
      const stream = client.messages.stream(params, opts.signal ? { signal: opts.signal } : {});
      stream.once('connect', () => {
        try {
          opts.onResponseStart?.();
        } catch {
          /* a caller's bookkeeping must never break the turn */
        }
      });
      const resp = await stream.finalMessage();
      let finalText = '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const block of (resp.content ?? []) as Array<any>) {
        if (block?.type === 'text' && typeof block.text === 'string') finalText += block.text;
      }
      const reportedInputTokens = resp.usage?.input_tokens;
      const reportedOutputTokens = resp.usage?.output_tokens;
      const inputTokens = hasFiniteNumber(reportedInputTokens) ? reportedInputTokens : 0;
      const outputTokens = hasFiniteNumber(reportedOutputTokens) ? reportedOutputTokens : 0;
      const unreportedFrames = hasFiniteNumber(reportedInputTokens) && hasFiniteNumber(reportedOutputTokens)
        ? undefined
        : 1;
      const p = anthropicPriceFor(opts.model);
      const costUsd = (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
      const headers = headersToRecord(stream.response?.headers);
      const servedAccount = servedAccountFromHeaders(headers);
      // Usage telemetry (D-002 capture point 1): tokens + the raw response's ratelimit headers.
      emitStatelessUsage({
        model: opts.model,
        inputTokens,
        outputTokens,
        cacheReadTokens: resp.usage?.cache_read_input_tokens ?? undefined,
        cacheCreationTokens: resp.usage?.cache_creation_input_tokens ?? undefined,
        costUsd,
        headers,
        attribution: opts.usageAttribution,
      });
      if (finalText) yield { type: 'delta', text: finalText };
      yield {
        type: 'result',
        costUsd,
        tokensIn: inputTokens,
        tokensOut: outputTokens,
        finalText,
        stopReason: resp.stop_reason,
        ...(servedAccount ? { servedAccount } : {}),
        ...(unreportedFrames !== undefined ? { unreportedFrames } : {}),
      };
      return;
    } catch (err) {
      lastErr = err;
      // EI-281 (auth half): a 401/403 on anthropic-direct usually means the
      // cached Claude token rotated on disk after we read it. Invalidate,
      // re-read, and retry once with the fresh token; if the re-read yields
      // the SAME token, the session is genuinely dead — fail normally.
      if (isAuthFailure(err)) {
        const staleTok = transport.token;
        authExpiresAt = readClaudeOauthExpiry();
        invalidateClaudeTokenCache();
        const freshTok = readClaudeOauthToken();
        if (freshTok && freshTok !== staleTok) {
          transport = anthropicDirectTransport(freshTok);
          client = mkClient(transport);
          console.warn(
            '[anthropic-direct] auth failure with a rotated on-disk token — retrying with the fresh Claude OAuth session (EI-281)',
          );
          continue;
        }
        // WI-38316: the on-disk token is UNCHANGED, so this is not a rotation we lost a race
        // to — the API is rejecting the credential we still hold (revoked, or rotated out from
        // under this host). The same bundle carries a refresh token; spend it rather than
        // surfacing a hard non-retryable 401 that takes out every in-process LLM caller until
        // a human notices. ONE attempt per call: the refresh token is single-use and rotates,
        // so a retry ladder here would burn its own successors. Only for `anthropic-direct` —
        // on a `gateway-pool` transport the rejected credential is the GATEWAY's pool account,
        // not this host's bundle, so refreshing ours would spend a refresh token to fix
        // nothing.
        if (!refreshAttempted && transport.label === 'anthropic-direct') {
          refreshAttempted = true;
          refreshOutcome = await refreshClaudeOauthCredential({ rejectedAccessToken: staleTok });
          if (refreshOutcome.ok) {
            invalidateClaudeTokenCache();
            const refreshedTok = readClaudeOauthToken();
            if (refreshedTok && refreshedTok !== staleTok) {
              transport = anthropicDirectTransport(refreshedTok);
              client = mkClient(transport);
              console.warn(
                `[anthropic-direct] auth failure with an unrotated on-disk token — ${
                  refreshOutcome.adopted ? 'adopted a peer-refreshed' : 'refreshed the'
                } Claude OAuth session and retrying (WI-38316)`,
              );
              continue;
            }
          }
        }
      }
      if (!isTransientLlmError(err) || attempt === RETRY_MAX) {
        yield {
          type: 'error',
          message: `${transport.label} error: ${err instanceof Error ? err.message : String(err)}${statelessErrorContext(transport, err, { expiresAt: authExpiresAt, refreshOutcome })}`,
        };
        return;
      }
      const backoffMs = Math.min(RETRY_CAP_MS, 1000 * 2 ** attempt) + Math.random() * 500;
      // WI-5391: a deadline-bounded caller must get the HONEST classified error back while
      // it can still record it — a backoff sleep that runs past `retryDeadlineMs` hands the
      // outcome to the caller's own timer, which reports a generic timeout instead of the
      // real (capacity-classifiable) condition. Never start a sleep that can't pay for itself.
      if (retryLadderDeadlineExceeded(opts.retryDeadlineMs, backoffMs)) {
        yield {
          type: 'error',
          message: `${transport.label} error: ${err instanceof Error ? err.message : String(err)} (retry ladder stopped at attempt ${attempt}/${RETRY_MAX}: caller retry deadline reached)${statelessErrorContext(transport, err, { expiresAt: authExpiresAt, refreshOutcome })}`,
        };
        return;
      }
      console.warn(
        `[anthropic-direct] transient (attempt ${attempt}/${RETRY_MAX}), retrying in ${Math.round(backoffMs)}ms: ${err instanceof Error ? err.message.slice(0, 140) : String(err)}`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  yield {
    type: 'error',
    message: `${transport.label}: exhausted ${RETRY_MAX} retries: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}${statelessErrorContext(transport, lastErr, { expiresAt: authExpiresAt, refreshOutcome })}`,
  };
}

/**
 * Diagnostic suffix for a failed stateless call (EI-12940): a `gateway-pool`
 * (delegated) transport that cannot even CONNECT means BOTH credential paths
 * are down — no usable local Claude OAuth token AND no reachable local
 * gateway. Say so explicitly on the tick ledger instead of a bare
 * "fetch failed" that hides the missing-local-token half.
 */
function statelessErrorContext(
  transport: StatelessTransport,
  err: unknown,
  auth?: { expiresAt: number | null; refreshOutcome?: ClaudeRefreshOutcome },
): string {
  // WI-38316: an auth rejection on the direct transport is the case where every LOCAL check
  // passes (file present, token unexpired) and only the 401 body knows the truth — so the
  // error has to carry the local credential's own claim plus the refresh verdict.
  if (transport.label === 'anthropic-direct' && isAuthFailure(err)) {
    return describeClaudeAuthFailure({
      expiresAt: auth?.expiresAt ?? readClaudeOauthExpiry(),
      refreshOutcome: auth?.refreshOutcome,
    });
  }
  if (transport.label !== 'gateway-pool') return '';
  if (isConnectionFailure(err)) {
    return (
      ' [gateway-pool: no usable local Claude OAuth token (~/.claude/.credentials.json missing/expired),' +
      ` so the call was delegated to the inference gateway at ${transport.baseURL} — which is UNREACHABLE;` +
      ' both credential paths are down (EI-12940)]'
    );
  }
  return ' [via gateway-pool delegation — no usable local Claude OAuth token (EI-12940)]';
}

/** Convert an SDK error's `.headers` (a Headers object OR a plain object) to a record so
    the TurnError classifier can read `retry-after` / `anthropic-ratelimit-*`. */
/**
 * WI-5391 (pure, exported for tests): true when starting a `backoffMs` retry sleep would
 * cross the caller's absolute retry deadline — the ladder must then surface the last
 * classified error instead of sleeping, so a deadline-bounded caller (a scout cycle)
 * records the true capacity condition rather than its own generic timeout.
 */
export function retryLadderDeadlineExceeded(
  retryDeadlineMs: number | undefined,
  backoffMs: number,
  nowMs: number = Date.now(),
): boolean {
  return retryDeadlineMs !== undefined && nowMs + backoffMs >= retryDeadlineMs;
}

export function headersToRecord(h: unknown): Record<string, string | undefined> | undefined {
  if (!h || typeof h !== 'object') return undefined;
  const anyH = h as { forEach?: (cb: (v: string, k: string) => void) => void };
  if (typeof anyH.forEach === 'function') {
    const o: Record<string, string> = {};
    anyH.forEach((v, k) => {
      o[k.toLowerCase()] = v;
    });
    return o;
  }
  const o: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) o[k.toLowerCase()] = v == null ? undefined : String(v);
  return o;
}

const ROUTED_ACCOUNT_HEADER = 'x-papercusp-routed-account';

function servedAccountFromHeaders(headers: Record<string, string | undefined> | undefined): string | undefined {
  const account = headers?.[ROUTED_ACCOUNT_HEADER]?.trim();
  return account || undefined;
}

/**
 * Governed stateless request (agent-turn-robustness P-004): the SAME single request as the
 * loop above, but run through `runAgentTurn` + a transport-appropriate `RateLimitGovernor`.
 * Direct-provider traffic uses the shared provider bucket. Loopback-gateway traffic uses a
 * request-local governor because the gateway already owns pooled shared admission; this keeps
 * classified retries and the current call's retry-after wait without imposing a duplicate
 * account-blind concurrency ceiling. Yields the same delta/result/error.
 */
async function* governedStatelessChat(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any>,
  opts: RunAgentChatOptions,
  // WI-38316: the governed path builds its client ONCE up front, so without these it has no
  // way to swap in a refreshed credential — the refresh-on-upstream-rejection fix would apply
  // only to the legacy ladder and silently stop applying the day PAPERCUSP_AGENT_GOVERNOR=1
  // becomes the default.
  auth?: {
    transport: StatelessTransport;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mkClient: (t: StatelessTransport) => any;
  },
): AsyncGenerator<ChatEvent, void, void> {
  const model = opts.model as string;
  let refreshAttempted = false;
  let refreshOutcome: ClaudeRefreshOutcome | undefined;
  let authExpiresAt: number | null = null;
  let lastRawErr: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let activeClient: any = client;

  /**
   * One-shot credential recovery for an auth rejection, shared in spirit with the legacy
   * ladder: rotation first (a peer rewrote the file), then the refresh-token exchange.
   * Returns a fresh client, or null when nothing recovered it.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recoverAuth = async (): Promise<any | null> => {
    if (refreshAttempted || !auth || auth.transport.label !== 'anthropic-direct') return null;
    refreshAttempted = true;
    const staleTok = auth.transport.token;
    authExpiresAt = readClaudeOauthExpiry();
    invalidateClaudeTokenCache();
    let tok = readClaudeOauthToken();
    if (!tok || tok === staleTok) {
      refreshOutcome = await refreshClaudeOauthCredential({ rejectedAccessToken: staleTok });
      if (!refreshOutcome.ok) return null;
      invalidateClaudeTokenCache();
      tok = readClaudeOauthToken();
    }
    if (!tok || tok === staleTok) return null;
    auth.transport = anthropicDirectTransport(tok);
    console.warn('[anthropic-direct] governed path recovered a rejected Claude OAuth session — retrying (WI-38316)');
    return auth.mkClient(auth.transport);
  };
  const governor = auth
    ? governorForStatelessTransport(auth.transport, model)
    : governorForBackend('anthropic-direct', model);
  type V = {
    finalText: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    stopReason?: string | null;
    servedAccount?: string;
    unreportedFrames?: number;
  };
  const result = await runAgentTurn<V>(
    // No estTokens: max_tokens does NOT count toward OTPM (only tokens actually produced),
    // so estimating OTPM as max_tokens would massively over-charge the budget. Until we
    // reconcile from real usage headers, pace on concurrency + RPM + 429-penalty only
    // (token-budget dimensions stay inert on the subscription path anyway). [reviewer #4]
    //
    // WI-4475: `maxWaitMs` was NOT threaded here, so this path always used runWithRetry's
    // 600s default no matter what the caller asked for. For a caller with a bounded outer
    // budget that is fatal: the governor's ADMISSION wait could equal (scout cycle: 600s) or
    // exceed (scout ideator: 180s) the caller's entire budget, so a correctly-paced wait for
    // capacity got axed by the caller's timer and misreported as a transport "timeout" with
    // $0 spent. Undefined => unchanged 600s default, so no existing caller shifts.
    {
      backend: 'anthropic-direct',
      maxAttempts: 8,
      signal: opts.signal,
      priorityTier: tierOf(opts.priority),
      ...(opts.governorMaxWaitMs !== undefined ? { maxWaitMs: opts.governorMaxWaitMs } : {}),
    },
    {
      governor,
      runOnce: async (): Promise<TurnOutcome<V>> => {
        if (opts.signal?.aborted) return { ok: false, raw: { message: 'anthropic-direct: aborted' } };
        // WI-38316: `runAgentTurn` classifies an auth rejection as non-retryable (correctly —
        // re-issuing the same dead credential helps nobody), so credential recovery has to
        // happen INSIDE one logical attempt. Issue, and on an auth failure recover once and
        // re-issue; anything else is returned unchanged.
        let issued = await issueOnce(activeClient);
        if (!issued.ok && isAuthFailure(lastRawErr)) {
          const fresh = await recoverAuth();
          if (fresh) {
            activeClient = fresh;
            issued = await issueOnce(activeClient);
          }
        }
        return issued;
      },
    },
  );
  if (result.ok) {
    if (result.value.finalText) yield { type: 'delta', text: result.value.finalText };
    yield {
      type: 'result',
      costUsd: result.value.costUsd,
      tokensIn: result.value.tokensIn,
      tokensOut: result.value.tokensOut,
      finalText: result.value.finalText,
      ...(result.value.stopReason !== undefined ? { stopReason: result.value.stopReason } : {}),
      ...(result.value.servedAccount ? { servedAccount: result.value.servedAccount } : {}),
      ...(result.value.unreportedFrames !== undefined
        ? { unreportedFrames: result.value.unreportedFrames }
        : {}),
    };
  } else {
    // result.error IS a TurnError — pass it through so the caller can pause/resume on a
    // rate_limited class instead of re-parsing the message (RB-006). WI-38316: append the
    // credential diagnosis when the classified failure is an auth rejection, so this path
    // explains itself exactly like the legacy ladder does.
    const authCtx =
      auth && isAuthFailure(lastRawErr)
        ? statelessErrorContext(auth.transport, lastRawErr, { expiresAt: authExpiresAt, refreshOutcome })
        : '';
    yield { type: 'error', message: `anthropic-direct error: ${result.error.message}${authCtx}`, turn: result.error };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function issueOnce(client: any): Promise<TurnOutcome<V>> {
        // LOCAL admission only: the transport-appropriate governor has granted a permit and
        // we are about to issue the HTTP request. The request may still queue inside the
        // inference gateway, so the generation timer must wait for stream 'connect' below
        // (EI-11417). For loopback traffic this local permit is deliberately request-scoped;
        // the gateway is the shared pooled-admission authority (EI-20394554339706750).
        try {
          opts.onAdmitted?.();
        } catch {
          /* a caller's bookkeeping must never break the turn */
        }
        try {
          const stream = client.messages.stream(params, opts.signal ? { signal: opts.signal } : {});
          stream.once('connect', () => {
            try {
              opts.onResponseStart?.();
            } catch {
              /* a caller's bookkeeping must never break the turn */
            }
          });
          const resp = await stream.finalMessage();
          let finalText = '';
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const block of (resp.content ?? []) as Array<any>) {
            if (block?.type === 'text' && typeof block.text === 'string') finalText += block.text;
          }
          const reportedInputTokens = resp.usage?.input_tokens;
          const reportedOutputTokens = resp.usage?.output_tokens;
          const tokensIn = hasFiniteNumber(reportedInputTokens) ? reportedInputTokens : 0;
          const tokensOut = hasFiniteNumber(reportedOutputTokens) ? reportedOutputTokens : 0;
          const unreportedFrames = hasFiniteNumber(reportedInputTokens) && hasFiniteNumber(reportedOutputTokens)
            ? undefined
            : 1;
          const p = anthropicPriceFor(model);
          const costUsd = (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
          const headers = headersToRecord(stream.response?.headers);
          const servedAccount = servedAccountFromHeaders(headers);
          // Usage telemetry (D-002 capture point 1) — tokens + ratelimit headers when present.
          emitStatelessUsage({
            model,
            inputTokens: tokensIn,
            outputTokens: tokensOut,
            cacheReadTokens: resp.usage?.cache_read_input_tokens ?? undefined,
            cacheCreationTokens: resp.usage?.cache_creation_input_tokens ?? undefined,
            costUsd,
            headers,
            attribution: opts.usageAttribution,
          });
          // Returning headers lets runWithRetry feed governor.recordResponse → header-driven
          // pacing (limits auto-tune, low-headroom soft pacing) activates on API-key paths.
          return {
            ok: true,
            value: {
              finalText,
              tokensIn,
              tokensOut,
              costUsd,
              stopReason: resp.stop_reason,
              ...(servedAccount ? { servedAccount } : {}),
              ...(unreportedFrames !== undefined ? { unreportedFrames } : {}),
            },
            ...(headers ? { headers } : {}),
          };
        } catch (err) {
          // WI-38316: keep the RAW error — `isAuthFailure` reads `.status` off the SDK error
          // object, which the flattened `raw` record no longer carries as a throwable.
          lastRawErr = err;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const e = err as any;
          return {
            ok: false,
            raw: {
              status: typeof e?.status === 'number' ? e.status : undefined,
              headers: headersToRecord(e?.headers),
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
  }
}

/**
 * Spawn claude and yield events as they arrive. Always yields exactly
 * one terminal event (`result` on success, `error` on failure) before
 * returning so consumers can rely on it for transcript writing.
 */
export async function* runAgentChat(
  opts: RunAgentChatOptions,
): AsyncGenerator<ChatEvent, void, void> {
  maybeBootstrap();
  const backend: AgentBackend = resolveBackend(opts);
  if (backend === 'anthropic-direct') {
    yield* statelessAgentChat(opts);
    return;
  }

  // RB-012/RB-005 — govern the CLI spawn at the subprocess-turn granularity (flag-gated;
  // default OFF = byte-identical legacy path). Acquire a SHARED concurrency permit BEFORE
  // spawning (the real burst lever), and on a rate-limited / overloaded outcome penalize the
  // shared governor with the server's retry-after so concurrent callers back off. We do NOT
  // re-retry the spawn: the CLI self-retries internally and the orchestrator/director owns
  // turn retries (re-spawning here would be our-retry × CLI-retry amplification — exactly
  // what makes 429s worse). omp self-paces (fallback chaining) → concurrency-cap only. The
  // permit is held for the whole subprocess and released in the `finally` below.
  const governed = process.env.PAPERCUSP_AGENT_GOVERNOR === '1';
  let releaseGovernor: (() => void) | null = null;
  if (governed) {
    const gov = governorForBackend(backend as TurnBackend, opts.model ?? '');
    let admissionDenial: import('../resilience/governor').AdmissionDenial | undefined;
    const release = await gov.acquire(
      {},
      {
        signal: opts.signal,
        maxWaitMs: opts.governorMaxWaitMs ?? DEFAULT_CLI_GOVERNOR_MAX_WAIT_MS,
        priorityTier: tierOf(opts.priority),
        onDenied: (denial) => {
          admissionDenial = denial;
        },
      },
    );
    if (!release) {
      // Bailed: the shared bucket is paused past our maxWait (a far-off reset) or aborted.
      // Surface as an error so the caller decides — interactive: escalate (D-002); the gym:
      // pause/resume (RB-006) — instead of freezing here. Attach a structured `rate_limited`
      // turn (carrying the reset) so the caller doesn't re-parse the message.
      const pausedUntil = gov.state.pausedUntil;
      const aborted = opts.signal?.aborted;
      yield {
        type: 'error',
        message: aborted
          ? `${backend}: aborted`
          : `${backend}: rate-limited${pausedUntil ? ` — paused until ${new Date(pausedUntil).toISOString()}` : ''}`,
        ...(aborted
          ? {}
          : {
              turn: {
                class: 'rate_limited' as const,
                message: 'shared rate-limit pause exceeds maxWait',
                provider: BACKEND_PROFILES[backend as TurnBackend].provider,
                retryable: false,
                ...(pausedUntil ? { resetAt: pausedUntil } : {}),
                ...(admissionDenial ? { admissionDenial } : {}),
              },
            }),
      };
      return;
    }
    releaseGovernor = release;
  }

  // try/finally exists only so the governor permit is released on EVERY exit path (normal,
  // spawn-failure return, abort, or a consumer abandoning the generator). Body indentation is
  // left unchanged to keep the diff readable.
  try {
  // Spawn-phase timing (WI-5068): split first-event latency into prep
  // (config/system-prompt writes) → process spawn→first stdout → parse→first
  // visible event, so "model TTFT" vs "CLI spawn overhead" is measured, not
  // guessed (operator chat firstEventMs was 12–18s with no way to tell which
  // side owned it). One `[agent-chat] spawn-timings` log line per turn,
  // emitted at the first visible (delta/tool_call) event in the drain loop.
  const tPrep = Date.now();
  let tSpawned = 0;
  let tFirstStdout = 0;
  let spawnTimingsLogged = false;
  const agentCmd = resolveAgentBin(opts, backend);
  const argv = agentCmd.split(/\s+/).filter(Boolean);
  const command = argv[0];
  const baseArgs = argv.slice(1);

  // Per-spawn agent dir (omp only) — `mcp.json` written here is loaded
  // by omp's MCP discovery as if it were `~/.omp/agent/mcp.json`.
  // Cleaned up after the child exits.
  let ompAgentDir: string | undefined;

  // Per-spawn CODEX_HOME (codex only) — holds AGENTS.md (codex's only
  // system-prompt surface), config.toml (MCP servers), and a symlink to
  // the user's ~/.codex/auth.json so the ChatGPT OAuth login carries
  // over. Created only when systemPromptText or mcpConfig is set;
  // otherwise codex runs against the user's real ~/.codex. Cleaned up
  // after the child exits (alongside ompAgentDir).
  let codexHome: string | undefined;

  // Per-spawn clean CLAUDE_CONFIG_DIR (claude-code, opts.isolateConfig
  // only) — isolates the brain spawn from the developer's ~/.claude.
  // Holds only a symlink to the real ~/.claude/.credentials.json so the
  // OAuth login carries over; nothing else, so no host MCP/hooks/plugins
  // load. Cleaned up after the child exits (alongside codexHome).
  let claudeConfigDir: string | undefined;
  // True when claudeConfigDir is a caller-owned stable dir (opts.isolateDir,
  // WI-5071) — cleanup must then LEAVE it alone (it holds the claude session
  // store the next turn resumes from).
  let claudeConfigDirCallerOwned = false;

  // Per-spawn dir holding the claude-code `--system-prompt-file` (the
  // persona). Only allocated when claudeConfigDir is absent (the persona
  // file is otherwise written INTO claudeConfigDir, sharing its cleanup).
  let claudeSysDir: string | undefined;

  const args: string[] = [...baseArgs];
  let spawnEnv: NodeJS.ProcessEnv = process.env;

  if (backend === 'claude-code') {
    args.push('-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages');
    if (opts.model) args.push(...claudeModelSelectionArgs(opts.model));
    if (opts.mcpConfig) {
      args.push('--mcp-config', JSON.stringify(opts.mcpConfig));
    }
    if (opts.allowedTools && opts.allowedTools.length > 0) {
      args.push('--allowed-tools', opts.allowedTools.join(' '));
    }
    if (opts.disallowBuiltins) {
      // Deny every Claude Code built-in so a persona brain has ONLY its
      // --mcp-config tools (under bypassPermissions, --allowed-tools does
      // not restrict the surface — this deny-list does).
      args.push('--disallowed-tools', CLAUDE_BUILTIN_TOOLS.join(' '));
    }
    if (opts.permissionMode) {
      args.push('--permission-mode', opts.permissionMode);
    }
    if (opts.sessionId) {
      if ((opts.sessionMode ?? 'force') === 'resume') {
        args.push('-r', opts.sessionId);
      } else {
        args.push('--session-id', opts.sessionId);
      }
    }
    if (opts.isolateConfig) {
      // Run against a CLEAN CLAUDE_CONFIG_DIR so the spawn inherits NONE
      // of the host ~/.claude (no `.claude.json` MCP servers, no
      // settings.json/SessionStart hooks, no plugins/skills). Symlink the
      // real OAuth credentials in so Claude-Max auth still works — exactly
      // the codex `auth.json` symlink pattern below. (`--bare` would also
      // isolate but forces ANTHROPIC_API_KEY auth, disabling the OAuth
      // login this box runs on — see plan operator-brain-test-isolation.)
      // WI-5071: a caller-supplied `isolateDir` is a STABLE, caller-owned
      // config dir (session reuse across spawns needs the same config dir +
      // cwd every turn); without one, allocate a throwaway tmp dir as before.
      if (opts.isolateDir) {
        claudeConfigDir = opts.isolateDir;
        claudeConfigDirCallerOwned = true;
        try { mkdirSync(claudeConfigDir, { recursive: true }); } catch { /* exists */ }
      } else {
        claudeConfigDir = mkdtempSync(join(tmpdir(), 'claude-chat-'));
      }
      try {
        const realCreds = join(homedir(), '.claude', '.credentials.json');
        const linkPath = join(claudeConfigDir, '.credentials.json');
        if (existsSync(realCreds) && !existsSync(linkPath)) {
          symlinkSync(realCreds, linkPath);
        }
      } catch (err) {
        console.warn('[chat-stream] claude-code: failed to symlink credentials:', err);
      }
      spawnEnv = { ...process.env, CLAUDE_CONFIG_DIR: claudeConfigDir };
    }
    // Tool-search toggle (disableToolSearch → ENABLE_TOOL_SEARCH=false) + the gateway
    // admission-tier header (priority → ANTHROPIC_CUSTOM_HEADERS `x-papercusp-priority`,
    // EI-10795 — an untagged spawn lands in the gateway's lowest default band). The
    // inherited value is passed in so the priority line APPENDS instead of clobbering
    // any custom headers already on the env. Spread into a COPY: spawnEnv may still
    // alias process.env when isolateConfig is off, and we must not mutate the parent's env.
    spawnEnv = { ...spawnEnv, ...claudeSpawnEnvOverrides(opts, spawnEnv.ANTHROPIC_CUSTOM_HEADERS) };
  } else if (backend === 'codex') {
    // codex (`codex exec`). Like claude, codex reads the prompt from
    // STDIN via the `-` positional (handled in the stdin block below).
    // `--json` emits JSONL events (one per line, NOT token-streamed);
    // `--skip-git-repo-check` allows running outside a git repo;
    // `--ephemeral` keeps no persistent session/rollout on disk.
    args.push('exec', '--json', '--skip-git-repo-check', '--ephemeral');
    // Sandbox / approval mode. Default read-only; bypassPermissions
    // unlocks full access (lets MCP tool calls + shell run without an
    // interactive approval gate — verified: `read-only` cancels MCP
    // calls with "user cancelled MCP tool call").
    if (opts.permissionMode === 'bypassPermissions') {
      args.push('-s', 'danger-full-access', '--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('-s', 'read-only');
    }
    // Model: codex wants a bare id (`gpt-5.5`); strip any `provider/`
    // prefix the same way the claude branch normalizes.
    if (opts.model) args.push(...codexModelSelectionArgs(opts.model));

    // codex has NO --system-prompt flag and NO inline --mcp-config flag.
    // Both surfaces are configured through a per-spawn CODEX_HOME:
    //   - AGENTS.md  ← systemPromptText (codex's only system-prompt surface)
    //   - config.toml ← [mcp_servers.<name>] blocks (mirrors
    //                    install-standalone-mcp.sh's codex-su TOML shape)
    //   - auth.json  ← symlink to ~/.codex/auth.json (shared ChatGPT login)
    // Created only when one of those is needed; otherwise codex uses the
    // user's real ~/.codex (which already has auth + config).
    if (opts.systemPromptText !== undefined || opts.mcpConfig) {
      codexHome = mkdtempSync(join(tmpdir(), 'codex-chat-'));
      // Share the ChatGPT OAuth login. codex resolves auth from
      // $CODEX_HOME/auth.json; symlink the user's real one in so we
      // don't need an API key (login is via ChatGPT OAuth).
      try {
        const realAuth = join(homedir(), '.codex', 'auth.json');
        if (existsSync(realAuth)) {
          symlinkSync(realAuth, join(codexHome, 'auth.json'));
        }
      } catch (err) {
        console.warn('[chat-stream] codex: failed to symlink auth.json:', err);
      }

      if (opts.systemPromptText !== undefined) {
        // AGENTS.md is codex's only system-prompt surface (it has no
        // --system-prompt / --append-system-prompt flag).
        writeFileSync(join(codexHome, 'AGENTS.md'), opts.systemPromptText, 'utf8');
      }

      spawnEnv = { ...process.env, CODEX_HOME: codexHome };

      const codexGatewayAccountId = process.env.PAPERCUSP_ACCOUNT_ID?.trim();
      const codexGatewayOn = process.env.PAPERCUSP_CODEX_GATEWAY === '1';
      const configParts = [
        codexGatewayConfigToml(codexGatewayAccountId, opts.priority, codexGatewayOn),
        opts.mcpConfig ? codexMcpConfigToml(opts.mcpConfig as ClaudeShapeMcpConfig) : '',
      ].filter(Boolean);
      if (configParts.length > 0) {
        // Translate the claude-shape mcpConfig ({ mcpServers: { <name>:
        // { type:'http', url, headers:{Authorization:'Bearer <tok>'} } } })
        // into codex's config.toml [mcp_servers.<name>] blocks. codex does
        // NOT reliably deliver `bearer_token_env_var` for HTTP MCP on the
        // Codex versions Papercusp runs, so bake the exact headers into the
        // per-spawn 0600 config, matching writeSuCodexHome. When the spawn
        // chokepoint selected a Codex pool account, include the matching
        // model_provider so Codex model traffic routes through the gateway too.
        writeFileSync(join(codexHome, 'config.toml'), configParts.join('\n'), 'utf8');
      }
    }

    // codex reads the prompt from stdin via the trailing `-` positional
    // (added after finalArgs is built, so it's the last arg).
  } else {
    // omp / pi-coding-agent. omp's `-p` takes the message as a positional
    // arg (or `@file` to read from disk) — it does NOT read stdin like
    // claude does. Long prompts overflow argv, so we always go via @file.
    args.push('-p', '--mode', 'json');
    if (opts.model) args.push('--model', opts.model);
    if (!opts.sessionId) args.push('--no-session');
    // Skills + project rules are unrelated to chat surfaces — turn off
    // for predictable, fast spawns.
    args.push('--no-skills', '--no-rules');
    // --allow-home: when mcpConfig is set, the omp branch below points
    // BOTH `HOME` and the spawn `cwd` at ompAgentDir — HOME for CLAUDE.md
    // suppression, cwd so omp's project-scope `$cwd/mcp.json` scan finds
    // our merged config. But omp, started in a dir that *equals* `~`,
    // auto-switches cwd to a throwaway temp dir — which silently defeats
    // the `$cwd/mcp.json` scan, so agentmcp never loads and the brain
    // runs with zero MCP tools (2026-05-21 P5 root cause; verified with
    // a logging MCP proxy — 0 requests without this flag, full
    // initialize + tools/list handshake with it). Harmless when cwd != ~.
    args.push('--allow-home');

    if (opts.mcpConfig) {
      const mcpConfig = opts.mcpConfig as ClaudeShapeMcpConfig;
      // Translate claude-shape mcp-config into a per-spawn omp agent dir.
      // omp loads PI_CODING_AGENT_DIR/mcp.json on startup; PI_CODING_AGENT_DIR
      // is the FULL agent state directory, NOT just an mcp.json holder
      // (it also contains auth.json — Meridian/Anthropic OAuth — plus
      // config.json, claude-bridge.json, the session DB, and blobs).
      //
      // Earlier versions of this code pointed PI_CODING_AGENT_DIR at a
      // fresh tmpdir with ONLY mcp.json, which silently broke every omp
      // invocation that passed mcpConfig: auth.json was missing → omp
      // could not authenticate to Meridian → produced zero output and
      // exited 0 (silent failure). Symptom: oracle "thinking" then
      // empty response; operator-scan returns done event with 0 deltas.
      //
      // The fix: copy the user's existing agent dir into our tmpdir
      // (so auth + config carry over), then OVERWRITE mcp.json with
      // the union of the user's existing servers plus the caller's.
      const realAgentDir = process.env.PI_CODING_AGENT_DIR
        ?? join(homedir(), '.omp', 'agent');
      ompAgentDir = mkdtempSync(join(tmpdir(), 'omp-chat-'));
      // Copy the small per-agent metadata files (auth, config, bridge,
      // model-roles yaml). Also includes agent.db so the MCP tool
      // cache (mcp_tools:* rows) carries over — without it, omp's
      // 250ms STARTUP_TIMEOUT_MS expires before our HTTP MCP server
      // can return tools/list (especially for papercusp-su which
      // serves 100+ tools). Cached tools are surfaced as
      // DeferredMCPTool while the real connection finishes in the
      // background, so the model sees the full surface immediately.
      // Threads/jobs in agent.db are session-keyed and don't pollute
      // a fresh spawn. NOT blobs (large file cache).
      //
      // config.yml is the most important: it carries `modelRoles`
      // which selects the Anthropic-via-Meridian provider. Without it,
      // omp falls back to the claude-bridge provider, which fails with
      // "Claude Code native binary not found" if @anthropic-ai/
      // claude-agent-sdk-linux-x64-musl isn't installed at the path
      // omp expects (and on this workspace it isn't). Symptom: omp
      // exits 0 but message_start carries an errorMessage, no deltas,
      // empty finalText.
      for (const f of [
        'auth.json',          // Meridian/Anthropic OAuth tokens
        'config.json',        // user prefs
        'config.yml',         // modelRoles → selects anthropic provider
        'models.json',        // **provider config: baseUrl=http://127.0.0.1:3456 (Meridian)**
        'models.yml',         // models.json's yaml twin
        'claude-bridge.json', // claude-bridge tool config (askClaude etc.)
        'agent.db',           // cache table holds mcp_tools:* — needed for fast cold-start MCP surface
      ]) {
        const src = join(realAgentDir, f);
        if (existsSync(src)) {
          try { cpSync(src, join(ompAgentDir, f)); } catch { /* best-effort */ }
        }
      }

      // Per-spawn-unique Meridian agent identity (2026-05-21 P5 bug #5
      // core root cause). The engineer's models.json/models.yml set
      // `providers.*.headers.x-meridian-agent: pi` — `pi` is the SHARED
      // omp identity every omp process on the box uses. Meridian keys
      // context (system prompt + tool set + prompt cache) by that name,
      // so all `pi` traffic is folded into ONE shared context. A brain
      // spawn that inherits `pi` has its request's `system` + `tools`
      // OVERRIDDEN by whatever other `pi` agent is live — e.g. the
      // engineer's Claude Code session — so the model never sees its 228
      // agentmcp tools, reports "no such tool", and confabulates. (The
      // engineer's normal omp agents are unaffected: they all expect the
      // same shared fleet, so sharing is harmless for them; only a brain
      // that uniquely needs `agentmcp` breaks.) Verified by direct
      // Meridian probe: identical request with `x-meridian-agent: pi`
      // ignores the request's tools and returns a foreign session's
      // toolset; with a fresh unique name the tools pass through and the
      // model calls them. Rewrite to a per-spawn-unique value so Meridian
      // gives this brain an isolated context. Per-spawn (not per-role)
      // so concurrent brain spawns never cross-contaminate each other.
      const meridianAgent = `papercup-brain-${basename(ompAgentDir)}`;
      for (const modelFile of ['models.json', 'models.yml']) {
        const modelPath = join(ompAgentDir, modelFile);
        if (!existsSync(modelPath)) continue;
        try {
          const yaml = await import('yaml');
          const isJson = modelFile.endsWith('.json');
          const raw = readFileSync(modelPath, 'utf8');
          const parsed = (isJson ? JSON.parse(raw) : yaml.parse(raw)) as
            | { providers?: Record<string, { headers?: Record<string, string> }> }
            | null;
          if (parsed && parsed.providers && typeof parsed.providers === 'object') {
            for (const provider of Object.values(parsed.providers)) {
              if (!provider || typeof provider !== 'object') continue;
              const headers = (provider.headers ??= {} as Record<string, string>);
              headers['x-meridian-agent'] = meridianAgent;
            }
            writeFileSync(
              modelPath,
              isJson ? JSON.stringify(parsed, null, 2) : yaml.stringify(parsed),
              'utf8',
            );
          }
        } catch (err) {
          console.warn(`[chat-stream] failed to rewrite ${modelFile} x-meridian-agent:`, err);
        }
      }

      // mcp.json: ONLY the caller-provided servers (e.g. agentmcp).
      // Deliberately NOT merged with the engineer's personal
      // ~/.omp/agent/mcp.json. A papercusp brain (operator / oracle /
      // agent-chat) works entirely through agentmcp; it has no use for
      // playwright / voice-mode / hindsight / plur, which are stdio
      // servers. omp connects to EVERY configured server at startup and
      // blocks on uncached ones until their handshake settles — cold-
      // spawning the engineer's npx-based stdio MCP fleet on every brain
      // turn pushed operator:converse past its 600s timeout once
      // --allow-home made mcp.json actually load (2026-05-21 P5).
      writeFileSync(
        join(ompAgentDir, 'mcp.json'),
        JSON.stringify({ mcpServers: mcpConfig.mcpServers ?? {} }),
        'utf8',
      );

      // Disable omp's MCP tool-discovery mode for papercusp brain
      // spawns. The user's global config carries tools.discoveryMode=
      // mcp-only for their own coding sessions; for a brain spawn that
      // is wrong twice over: (a) discovery gates agentmcp's tools behind
      // a search_tool_bm25 step the model does not reliably take — it
      // concludes "no tools" and confabulates; and (b) — observed
      // 2026-05-21 P5 — an omp run with discovery on does not exit after
      // the turn completes, hanging operator:converse until its 600s
      // timeout (diag: discovery-on omp exit=124, discovery-off exit=0,
      // all else identical). mcp.json holds only agentmcp now, so there
      // is nothing to "discover" — load every tool directly. PER-SPAWN;
      // the user's real ~/.omp/agent/config.yml is untouched.
      try {
        const configPath = join(ompAgentDir, 'config.yml');
        if (existsSync(configPath)) {
          const yaml = await import('yaml');
          const parsed = (yaml.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown> | null) ?? {};
          const tools = (parsed.tools ??= {} as Record<string, unknown>) as Record<string, unknown>;
          tools.discoveryMode = 'off';
          const mcp = (parsed.mcp ??= {} as Record<string, unknown>) as Record<string, unknown>;
          mcp.discoveryMode = false;
          // Disable omp's local memory backend for brain spawns.
          // chat-stream copies the engineer's agent.db (for auth/model
          // config); with memories enabled omp injects the ENGINEER's
          // accumulated omp memories into the brain's system prompt, and
          // the operator brain recites that stale papercup state
          // (feature ids, escalations, server names like papercusp-su)
          // as if it were live data it had retrieved — the 2026-05-21 P5
          // confabulation. The brain must read live state through
          // agentmcp tools and nothing else.
          const memories = (parsed.memories ??= {} as Record<string, unknown>) as Record<string, unknown>;
          memories.enabled = false;
          writeFileSync(configPath, yaml.stringify(parsed), 'utf8');
        }
      } catch (err) {
        // Non-fatal: if yaml parsing fails, we still have a working config.
        console.warn('[chat-stream] failed to disable omp discovery mode:', err);
      }

      // Redirect HOME to the scoped agent dir. Otherwise omp's `claude`
      // discovery provider (node_modules/@oh-my-pi/pi-coding-agent/src/
      // discovery/claude.ts) scans `$HOME/.claude/` and pulls in the
      // user's CLAUDE.md as system context — on engineer workstations
      // that file says "you are the engineer-collaborator working with
      // Papercusp engineers," which makes the operator brain refuse to
      // roleplay as the Operator and emit a coherent role-refusal
      // instead of operator output (2026-05-21 P5 root cause). PI_CODING_AGENT_DIR
      // continues to point at the same scoped dir, so omp's own
      // ~/.omp/agent state discovery still resolves correctly.
      // ompAgentDir has no `.claude/` subdir → omp's claude provider
      // finds nothing → brain runs with only the supplied prompt.
      spawnEnv = { ...process.env, HOME: ompAgentDir, PI_CODING_AGENT_DIR: ompAgentDir };
    }

    if (opts.allowedTools && opts.allowedTools.length > 0) {
      // omp `--tools` allow-lists built-in tool names. MCP tools are
      // surfaced through the mcp.json path (see PI_CODING_AGENT_DIR
      // and mcp.discoveryDefaultServers above), not via --tools.
      //
      // Strictly safer than a hardcoded built-in name Set: passes through
      // every non-MCP name to omp. omp ignores unknown names so this is
      // forward-compatible with new built-ins (e.g. future `web_search`)
      // without requiring a sync edit here.
      const ompTools = opts.allowedTools.filter((t) => !t.startsWith('mcp__'));
      if (ompTools.length > 0) args.push('--tools', ompTools.join(','));
    }

    if (opts.sessionId) {
      // omp resumes by id-prefix; force-create semantics aren't a 1:1
      // map. We treat both modes as resume-or-start (the file gets
      // created under PI_CODING_AGENT_DIR if absent).
      args.push('-r', opts.sessionId);
    }
  }

  // omp prompt-file: written before spawn so it's visible to the child;
  // deleted after exit. Defined here (outside the spawn try-block) so
  // the cleanup at the end can see it.
  let ompPromptFile: string | undefined;

  // For omp, materialise the prompt to a tmpfile and pass `@<path>` as
  // the positional message arg. Avoids both ARG_MAX overflow and the
  // stdin-not-read footgun.
  //
  // When `systemPromptText` is provided, write it to a separate file
  // and pass it via `--append-system-prompt` so the operator/oracle
  // persona is ADDED to omp's default prompt. Without the system/user
  // split, persona+playbook content lands in the user-message slot and
  // the model meta-comments on it instead of acting on it.
  const finalArgs = [...args];
  let ompSystemPromptFile: string | undefined;
  if (backend === 'omp') {
    const promptDir = ompAgentDir ?? mkdtempSync(join(tmpdir(), 'omp-prompt-'));
    if (!ompAgentDir) ompAgentDir = promptDir; // reuse cleanup
    if (opts.systemPromptText !== undefined) {
      ompSystemPromptFile = join(promptDir, 'system.md');
      writeFileSync(ompSystemPromptFile, opts.systemPromptText, 'utf8');
      // Two things this line gets right, both 2026-05-21 P5 bug #5:
      //
      // 1. `--append-system-prompt`, NOT `--system-prompt`. omp's
      //    `--system-prompt` REPLACES omp's default prompt; that default
      //    is what grounds the model as an omp agent ("you have these
      //    tools, use them to complete the task"). Stripped of it the
      //    brain reverts to its training prior — claude-opus-4-7's prior
      //    is Claude Code — and opens the turn with the Claude-Code
      //    `WaitForMcpServers` startup reflex. omp has no such tool, the
      //    call fails, and the brain concludes MCP is unavailable and
      //    confabulates instead of calling its (real, connected) tools.
      //    `--append-system-prompt` keeps omp's grounding and layers the
      //    persona AFTER it (persona wins on any conflict). Verified:
      //    `--system-prompt` → 5x WaitForMcpServers / 0 real tool calls;
      //    `--append-system-prompt` → 0 WaitForMcpServers.
      //
      // 2. BARE FILE PATH, not `@file`. omp's resolvePromptInput() does
      //    `Bun.file(value).text()` directly; a leading `@` makes the
      //    path nonexistent, the ENOENT is silently swallowed, and omp
      //    falls back to the literal string `@/tmp/.../system.md` as the
      //    prompt — persona never reaches the model (model-API proxy:
      //    systemChars 1370 with `@`, ~73k as a bare path appended to
      //    omp's default). The `@` IS correct for the positional message
      //    arg below — that path goes through omp's file-processor which
      //    does expand `@file`. Only the prompt flags differ.
      finalArgs.push('--append-system-prompt', ompSystemPromptFile);
    }
    ompPromptFile = join(promptDir, 'prompt.md');
    writeFileSync(ompPromptFile, opts.promptText, 'utf8');
    finalArgs.push(`@${ompPromptFile}`);
  } else if (backend === 'codex') {
    // codex reads the prompt from STDIN via the trailing `-` positional —
    // it must be the LAST arg (everything after it is treated as the
    // positional prompt source). The prompt itself is written to
    // child.stdin in the stdin block below, exactly like the claude branch.
    finalArgs.push('-');
  } else if (backend === 'claude-code' && opts.systemPromptText !== undefined) {
    // claude-code's `-p` mode otherwise runs with its DEFAULT Claude Code
    // coding-agent system prompt — so a persona caller (operator/oracle
    // brain, sim-user, judge) that only sets `systemPromptText` would be
    // ignored: the spawn behaves as a generic coding agent (reads the cwd
    // CLAUDE.md, asks "what would you like to work on?") instead of BEING
    // the persona, which breaks every persona turn. Pass the persona via
    // `--system-prompt-file` (REPLACE — matches the anthropic-direct backend's
    // `params.system = systemPromptText`, NOT omp's append-to-default).
    // The persona is large (~70k chars), so a file, not an inline arg.
    // Written into claudeConfigDir when isolated (shares its cleanup),
    // else a dedicated tmpdir tracked via claudeSysDir.
    const sysDir = claudeConfigDir ?? (claudeSysDir = mkdtempSync(join(tmpdir(), 'claude-sys-')));
    const sysFile = join(sysDir, 'system.md');
    writeFileSync(sysFile, opts.systemPromptText, 'utf8');
    finalArgs.push('--system-prompt-file', sysFile);
  }

  // omp's MCP discovery uses os.homedir() for the user-scope mcp.json
  // and spawn-cwd for the project-scope mcp.json — it does NOT honor
  // PI_CODING_AGENT_DIR for MCP loading (that env var is only for
  // sessions/prompts/etc). To make our merged mcp.json visible we run
  // omp with cwd = ompAgentDir, so its project-level scan
  // ($cwd/mcp.json) lands on the file we just wrote. For an isolated
  // claude-code spawn, run in the clean config dir (no project CLAUDE.md)
  // so the persona spawn doesn't inherit the repo's agent guide as context.
  const spawnCwd = ompAgentDir ?? claudeConfigDir ?? opts.cwd;

  let child: ChildProcess;
  let spawnPrelude: Buffer | undefined;
  try {
    // D-421 (byoc-cloud-workspaces-gcp-aws-azure-2026-08-22): the identity
    // the agent runs as is decided by the process-wide spawn transform. With
    // none configured this is the staged spawn unchanged; a hosted workspace
    // host runs customer-driven agents as the customer workspace identity.
    const stagedDirs: AgentSpawnStagedDir[] = [];
    if (codexHome) stagedDirs.push({ path: codexHome, persistent: false });
    if (ompAgentDir) stagedDirs.push({ path: ompAgentDir, persistent: false });
    if (claudeConfigDir) stagedDirs.push({ path: claudeConfigDir, persistent: claudeConfigDirCallerOwned });
    if (claudeSysDir && claudeSysDir !== claudeConfigDir) stagedDirs.push({ path: claudeSysDir, persistent: false });
    const plan = planAgentSpawn({
      backend,
      command,
      args: finalArgs,
      cwd: spawnCwd,
      // EI-11519: augment PATH with the well-known per-user bin dirs so the
      // agent binary resolves even when the operator's own env is stripped
      // (Tauri dev shell). See withAgentBinDirs.
      env: withAgentBinDirs(spawnEnv),
      stagedDirs,
    });
    spawnPrelude = plan.stdinPrelude;
    child = spawn(plan.command, [...plan.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: plan.cwd,
      env: plan.env,
    });
  } catch (e) {
    if (ompAgentDir) {
      try { rmSync(ompAgentDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    if (codexHome) {
      try { rmSync(codexHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    if (claudeConfigDir && !claudeConfigDirCallerOwned) {
      try { rmSync(claudeConfigDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    if (claudeSysDir) {
      try { rmSync(claudeSysDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    yield { type: 'error', message: `failed to spawn ${agentCmd}: ${(e as Error).message}` };
    return;
  }
  tSpawned = Date.now();

  const onAbort = () => {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  // Track in-flight tool_use content blocks so we can pair the name
  // (from content_block_start) with the streamed input json
  // (input_json_delta) and emit one tool_call event per call when the
  // block stops.
  const liveTools = new Map<number, { name: string; input: string }>();

  let stderrBuf = '';
  let stdoutLineBuf = '';
  let finalText = '';
  let costUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let unreportedFrames = 0;
  // Surfaced on the terminal `result` event when the backend reports them
  // (claude-code: num_turns + cache_read/creation_input_tokens). Undefined
  // otherwise so a consumer can tell "0 turns" from "not reported".
  let numTurns: number | undefined;
  let cacheReadTokens: number | undefined;
  let cacheCreationTokens: number | undefined;
  let claudeTerminalUsageSeen = false;
  let ompUsageSeen = false;
  let ompUsageComplete = false;
  let codexUsageSeen = false;
  let codexUsageComplete = false;
  // WI-10003188 — the backend's OWN statement of why a turn failed, read from its
  // structured stdout (codex `turn.failed`/`error` frames, a claude `is_error` result).
  // `backendFailureIsTerminal` lets a codex `turn.failed` outrank an earlier `error` frame.
  let backendFailureRaw: string | null = null;
  let backendFailureIsTerminal = false;
  // Buffer events from the line-parser; the generator drains this queue.
  const queue: ChatEvent[] = [];
  let resolveTick: (() => void) | null = null;
  const tick = () => { if (resolveTick) { resolveTick(); resolveTick = null; } };

  const handleClaudeEvent = (ev: any) => {
    const inner = ev.type === 'stream_event' && ev.event ? ev.event : ev;

    if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
      const text = inner.delta.text ?? '';
      finalText += text;
      queue.push({ type: 'delta', text });
    } else if (
      inner?.type === 'content_block_start' &&
      inner.content_block?.type === 'tool_use' &&
      typeof inner.content_block.name === 'string' &&
      typeof inner.index === 'number'
    ) {
      liveTools.set(inner.index, { name: inner.content_block.name, input: '' });
    } else if (
      inner?.type === 'content_block_delta' &&
      inner.delta?.type === 'input_json_delta' &&
      typeof inner.index === 'number' &&
      liveTools.has(inner.index)
    ) {
      liveTools.get(inner.index)!.input += inner.delta.partial_json ?? '';
    } else if (
      inner?.type === 'content_block_stop' &&
      typeof inner.index === 'number' &&
      liveTools.has(inner.index)
    ) {
      const entry = liveTools.get(inner.index)!;
      liveTools.delete(inner.index);
      const filtered = opts.toolEventFilter
        ? opts.toolEventFilter(entry.name)
        : entry.name;
      if (filtered) {
        let parsed: unknown;
        try { parsed = entry.input ? JSON.parse(entry.input) : {}; } catch { parsed = entry.input; }
        queue.push({ type: 'tool_call', name: filtered, input: parsed });
      }
    } else if (ev.type === 'result') {
      claudeTerminalUsageSeen = true;
      const failure = claudeFailureResultMessage(ev);
      if (failure) {
        backendFailureRaw = failure;
        backendFailureIsTerminal = true;
      }
      const u = parseClaudeResultEvent(ev);
      if (u.tokensIn !== undefined) tokensIn = u.tokensIn;
      if (u.tokensOut !== undefined) tokensOut = u.tokensOut;
      if (u.cacheReadTokens !== undefined) cacheReadTokens = u.cacheReadTokens;
      if (u.cacheCreationTokens !== undefined) cacheCreationTokens = u.cacheCreationTokens;
      if (u.costUsd !== undefined) costUsd = u.costUsd;
      if (u.unreportedFrames !== undefined) unreportedFrames = Math.max(unreportedFrames, u.unreportedFrames);
      if (u.numTurns !== undefined) numTurns = u.numTurns;
      // Sometimes the terminal `result.result` is the most complete
      // assistant text — prefer it if longer than the streamed accum.
      if (u.resultText !== undefined && u.resultText.length > finalText.length) {
        finalText = u.resultText;
      }
    }
  };

  /**
   * omp `--mode json` event handler. Maps:
   *   message_update.assistantMessageEvent.text_delta → delta
   *   tool_execution_start                            → tool_call (with full args)
   *   message_end (assistant role) / agent_end        → updates finalText + usage
   */
  const handleOmpEvent = (ev: any) => {
    if (!ev || typeof ev !== 'object') return;

    if (ev.type === 'message_update' && ev.assistantMessageEvent) {
      const ame = ev.assistantMessageEvent;
      if (ame.type === 'text_delta' && typeof ame.delta === 'string') {
        finalText += ame.delta;
        queue.push({ type: 'delta', text: ame.delta });
      } else if (ame.type === 'done' && ame.message) {
        // Capture token usage from the final assistant message.
        const u = ame.message.usage;
        if (u) recordOmpUsage(u);
      }
      return;
    }

    if (ev.type === 'tool_execution_start' && typeof ev.toolName === 'string') {
      const filtered = opts.toolEventFilter
        ? opts.toolEventFilter(ev.toolName)
        : ev.toolName;
      if (filtered) {
        queue.push({ type: 'tool_call', name: filtered, input: ev.args ?? {} });
      }
      return;
    }

    if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
      // Reconstruct from text content blocks if streaming missed any.
      const parts: string[] = [];
      for (const b of ev.message.content ?? []) {
        if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
      const reconstructed = parts.join('');
      if (reconstructed.length > finalText.length) finalText = reconstructed;
      const u = ev.message.usage;
      if (u) recordOmpUsage(u);
      return;
    }
  };

  const recordOmpUsage = (u: any) => {
    ompUsageSeen = true;
    const input = u?.input;
    const output = u?.output;
    const cacheRead = hasFiniteNumber(u?.cacheRead) ? u.cacheRead : 0;
    const cacheWrite = hasFiniteNumber(u?.cacheWrite) ? u.cacheWrite : 0;
    tokensIn = (hasFiniteNumber(input) ? input : 0) + cacheRead + cacheWrite;
    tokensOut = hasFiniteNumber(output) ? output : tokensOut;
    const reportedCost = u?.costUsd ?? u?.cost ?? u?.totalCost;
    if (hasFiniteNumber(reportedCost)) costUsd = reportedCost;
    ompUsageComplete = hasFiniteNumber(input) && hasFiniteNumber(output) && hasFiniteNumber(reportedCost);
  };

  /**
   * codex `exec --json` event handler. codex emits JSONL (one event per
   * line), NOT token-streamed. Observed shapes (verified codex 0.135.0):
   *   {type:'thread.started', thread_id}                       → ignore
   *   {type:'turn.started'}                                    → ignore
   *   {type:'item.started',  item:{...}}                       → ignore (we
   *                                                              act on the
   *                                                              matching
   *                                                              item.completed)
   *   {type:'item.completed', item:{type:'agent_message', text}}
   *       → assistant text (WHOLE blob): emit one delta + accumulate finalText
   *   {type:'item.completed', item:{type:'mcp_tool_call',
   *       server, tool, arguments, status}}                    → tool_call
   *   {type:'item.completed', item:{type:'command_execution',
   *       command, exit_code, status}}                         → tool_call
   *   {type:'turn.completed', usage:{input_tokens,
   *       cached_input_tokens, output_tokens,
   *       reasoning_output_tokens}}                            → terminal usage
   *                                                              (cost derived
   *                                                              from CODEX_PRICES;
   *                                                              codex emits NO
   *                                                              cost field)
   *
   * Tool items arrive twice — once as item.started (status 'in_progress')
   * and once as item.completed (status 'completed'/'failed'). We emit the
   * tool_call on the COMPLETED item only (full arguments present, no
   * double-emit).
   */
  const handleCodexEvent = (ev: any) => {
    if (!ev || typeof ev !== 'object') return;

    // WI-10003188 — keep codex's own failure text (usage limit, rejected model, auth) so
    // the terminal error and the turn classifier can see it; stderr is empty in --json mode.
    const failure = codexFailureFrameMessage(ev);
    if (failure && (ev.type === 'turn.failed' || !backendFailureIsTerminal)) {
      backendFailureRaw = failure;
      backendFailureIsTerminal = ev.type === 'turn.failed';
    }

    // `codex exec --json` grows new item/event variants independently of this
    // adapter. In debug runs, retain only the bounded routing fields for every
    // non-message item plus terminal errors so an ignored compositor event is
    // diagnosable without logging tool arguments, prompts, or credentials.
    const debugItem = ev.item && typeof ev.item === 'object' ? ev.item : null;
    if (
      process.env.PAPERCUSP_AGENT_DEBUG
      && (
        ev.type === 'error'
        || ev.type === 'turn.failed'
        || (typeof ev.type === 'string' && ev.type.startsWith('item.') && debugItem?.type !== 'agent_message')
      )
    ) {
      const failureFields = debugItem?.type === 'mcp_tool_call' && debugItem?.status === 'failed'
        ? codexMcpFailureDebugFields(debugItem)
        : null;
      console.error(
        '[chat-stream][codex-jsonl] ' +
          `event=${String(ev.type ?? '')} itemType=${String(debugItem?.type ?? '')} ` +
          `server=${String(debugItem?.server ?? '')} tool=${String(debugItem?.tool ?? debugItem?.name ?? '')} ` +
          `status=${String(debugItem?.status ?? '')}` +
          (failureFields ? ` failure=${JSON.stringify(failureFields)}` : ''),
      );
    }

    if (ev.type === 'item.completed' && ev.item && typeof ev.item === 'object') {
      const item = ev.item;
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        // codex emits the assistant message as one whole blob (not token
        // deltas). Emit it as a single delta and accumulate finalText.
        finalText += item.text;
        queue.push({ type: 'delta', text: item.text });
        return;
      }
      if (item.type === 'mcp_tool_call') {
        // MCP tool name lives on item.tool (NOT item.name); args on
        // item.arguments. item.server names the configured server.
        const toolName = typeof item.tool === 'string' ? item.tool : '';
        if (!toolName) return;
        const filterInput = codexMcpToolFilterInput(item.server, toolName);
        const filtered = opts.toolEventFilter ? opts.toolEventFilter(filterInput) : toolName;
        if (filtered) {
          queue.push({ type: 'tool_call', name: filtered, input: item.arguments ?? {} });
        }
        return;
      }
      if (item.type === 'command_execution') {
        // codex's built-in shell tool. Surface it as a `shell` tool_call
        // (subject to toolEventFilter like every other backend).
        const filtered = opts.toolEventFilter ? opts.toolEventFilter('shell') : 'shell';
        if (filtered) {
          queue.push({
            type: 'tool_call',
            name: filtered,
            input: { command: item.command ?? '', exit_code: item.exit_code ?? null },
          });
        }
        return;
      }
      return;
    }

    if (ev.type === 'turn.completed' && ev.usage && typeof ev.usage === 'object') {
      const u = ev.usage;
      codexUsageSeen = true;
      // input_tokens already includes cached_input_tokens in codex's
      // accounting; keep the raw total for tokensIn.
      const hasInput = hasFiniteNumber(u.input_tokens);
      const hasOutput = hasFiniteNumber(u.output_tokens);
      tokensIn = hasInput ? u.input_tokens : tokensIn;
      tokensOut = (hasOutput ? u.output_tokens : 0) + (hasFiniteNumber(u.reasoning_output_tokens) ? u.reasoning_output_tokens : 0);
      codexUsageComplete = hasInput && hasOutput;
      // codex emits NO cost field — derive an ESTIMATE from the canonical
      // cross-backend table. Unknown model prices count as an unreported frame
      // rather than masquerading as a measured $0 turn.
      const cachedInput = hasFiniteNumber(u.cached_input_tokens) ? u.cached_input_tokens : 0;
      const estimate = estimateCodexUsageCost(opts.model, tokensIn, tokensOut, cachedInput);
      costUsd = estimate.usd;
      if (!estimate.priced) unreportedFrames = Math.max(unreportedFrames, 1);
      return;
    }
  };

  const handle =
    backend === 'codex'
      ? handleCodexEvent
      : backend === 'omp'
        ? handleOmpEvent
        : handleClaudeEvent;

  child.stdout!.on('data', (chunk: Buffer) => {
    if (!tFirstStdout) tFirstStdout = Date.now();
    stdoutLineBuf += chunk.toString('utf8');
    let nl: number;
    // eslint-disable-next-line no-cond-assign
    while ((nl = stdoutLineBuf.indexOf('\n')) >= 0) {
      const line = stdoutLineBuf.slice(0, nl).trim();
      stdoutLineBuf = stdoutLineBuf.slice(nl + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch { /* non-JSON line — ignore */ }
      tick();
    }
  });

  child.stderr!.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
  });

  // claude AND codex read the prompt on stdin (codex via its trailing `-`
  // positional); omp reads it from a `@file` positional arg (handled in
  // finalArgs above). For omp we still close stdin so the child doesn't
  // block waiting for input that won't come.
  if (spawnPrelude) child.stdin!.write(spawnPrelude);
  if (backend === 'omp') {
    child.stdin!.end();
  } else {
    child.stdin!.write(opts.promptText);
    child.stdin!.end();
  }

  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let exited = false;
  // EI-11519: an async spawn failure (ENOENT — binary not on PATH — being the
  // classic) lands HERE, not in the try/catch above. Swallowing the error
  // object made it surface as "<backend> exited ?" with empty stderr — hours
  // of misdiagnosis. Capture it so the terminal error event names the cause.
  let spawnErrMsg: string | null = null;
  child.on('exit', (code, signal) => { exitCode = code; exitSignal = signal; exited = true; tick(); });
  child.on('error', (e) => {
    spawnErrMsg = `failed to spawn ${command}: ${(e as Error).message}`;
    stderrBuf += (stderrBuf ? '\n' : '') + spawnErrMsg;
    exited = true;
    tick();
  });

  // RB review #6 — wall-clock turn timeout backstop. A subprocess that hangs (never exits,
  // never streams) would otherwise wedge an un-signaled caller forever; the orchestrator passes
  // its own AbortSignal/deadline, but ungoverned/interactive callers may not. On expiry we set
  // `timedOut` (→ classified `timeout`, retryable) and SIGTERM, escalating to SIGKILL after a
  // short grace. Default 15 min — generous, so a caller's own shorter deadline usually fires first.
  let timedOut = false;
  const TURN_TIMEOUT_MS = Number(process.env.PAPERCUSP_AGENT_TURN_TIMEOUT_MS ?? 900_000);
  const turnTimer =
    TURN_TIMEOUT_MS > 0
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGTERM'); } catch { /* ignore */ }
          setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 5_000).unref?.();
          tick();
        }, TURN_TIMEOUT_MS)
      : null;
  turnTimer?.unref?.();

  // Drain loop.
  while (true) {
    while (queue.length > 0) {
      const ev = queue.shift()!;
      if (!spawnTimingsLogged && (ev.type === 'delta' || ev.type === 'tool_call')) {
        spawnTimingsLogged = true;
        const now = Date.now();
        console.log(
          `[agent-chat] spawn-timings backend=${backend} prepMs=${tSpawned ? tSpawned - tPrep : -1} ` +
            `spawnToFirstStdoutMs=${tFirstStdout && tSpawned ? tFirstStdout - tSpawned : -1} ` +
            `stdoutToFirstEventMs=${tFirstStdout ? now - tFirstStdout : -1} ` +
            `totalToFirstEventMs=${now - tPrep} model=${opts.model ?? '(default)'}`,
        );
      }
      yield ev;
    }
    if (exited) break;
    await new Promise<void>((resolve) => { resolveTick = resolve; });
  }

  if (turnTimer) clearTimeout(turnTimer);
  if (opts.signal) opts.signal.removeEventListener('abort', onAbort);

  // Silent-failure surfacing: an agent that exits 0 with no text is
  // almost always a misconfigured per-spawn agent dir (missing auth or
  // provider config — see the omp branch above). Log the command +
  // stderr so it is diagnosable, instead of bubbling up to the caller
  // as a blank turn.
  if (exitCode === 0 && finalText.trim() === '') {
    console.error(
      `[chat-stream] ${backend} exited 0 with EMPTY output. ` +
        `cmd: ${command} ${finalArgs.join(' ')} | cwd: ${spawnCwd ?? '(default)'} | ` +
        `stderr: ${stderrBuf.slice(-1500) || '(none)'}`,
    );
  }

  if (ompAgentDir) {
    if (process.env.PAPERCUSP_AGENT_DEBUG) {
      console.error(`[chat-stream] PAPERCUSP_AGENT_DEBUG — preserving agent dir: ${ompAgentDir}`);
    } else {
      try { rmSync(ompAgentDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
  if (codexHome) {
    if (process.env.PAPERCUSP_AGENT_DEBUG) {
      console.error(`[chat-stream] PAPERCUSP_AGENT_DEBUG — preserving CODEX_HOME: ${codexHome}`);
    } else {
      try { rmSync(codexHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
  if (claudeConfigDir) {
    if (process.env.PAPERCUSP_AGENT_DEBUG) {
      console.error(`[chat-stream] PAPERCUSP_AGENT_DEBUG — preserving CLAUDE_CONFIG_DIR: ${claudeConfigDir}`);
    } else {
      try { rmSync(claudeConfigDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
  if (claudeSysDir) {
    if (process.env.PAPERCUSP_AGENT_DEBUG) {
      console.error(`[chat-stream] PAPERCUSP_AGENT_DEBUG — preserving claude system-prompt dir: ${claudeSysDir}`);
    } else {
      try { rmSync(claudeSysDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }

  // RB-012/RB-005 — classify the subprocess TURN outcome and, on rate-limit/overload,
  // penalize the SHARED governor so concurrent callers back off (no re-spawn here). Only on
  // the governed path; cheap + side-effect-free otherwise. The classified turn is also
  // attached to the terminal error event so a consumer can pause/resume (RB-006).
  // WI-10003188 — the backend's own failure line (plan cap, rejected model, revoked login),
  // read from its structured stdout. Only meaningful on a failed exit.
  const failureLine = exitCode !== 0 ? backendFailureLine(backendFailureRaw) : null;

  let cliTurn: TurnError | undefined;
  if (governed) {
    // codex --json puts its wall text in stdout JSONL frames, not in stderr or the assistant
    // text, so fold the captured line into the stdout the classifier scans on a failed exit —
    // otherwise a codex plan cap is never classified `usage_limit` and never pauses the governor.
    const classifyStdout =
      backendFailureRaw && exitCode !== 0 && !finalText.includes(backendFailureRaw)
        ? `${finalText}\n${backendFailureRaw}`
        : finalText;
    cliTurn = classifyTurnError(
      backend as TurnBackend,
      { exitCode, signal: exitSignal, stderr: stderrBuf, stdout: classifyStdout, timedOut },
      Date.now(),
    );
    if (isAccountWide(cliTurn.class)) {
      // rate_limited/overloaded (transient) AND usage_limit (plan cap) all pause the shared
      // bucket so concurrent CLI spawns back off together (D-001). BUT a Claude Max usage_limit is a
      // ROLLING 5h/7d window that recovers continuously — pausing the shared bucket to its full
      // (often hours-away) reset goes stale ("opus paused until 09:10, zero pressure" = the
      // owner-flagged false exhaustion). So an Anthropic usage_limit is bounded to a re-probe
      // interval (the fleet resumes the moment the window frees); a non-Anthropic hard quota
      // (codex/openai daily-weekly) keeps its full reset, and transient classes honor retry-after.
      const rollingCap = cliTurn.class === 'usage_limit' && cliTurn.provider === 'anthropic';
      governorForBackend(backend as TurnBackend, opts.model ?? '').penalize({
        retryAfterMs: cliTurn.retryAfterMs,
        resetAt: cliTurn.resetAt,
        ...(rollingCap ? { maxPauseMs: ROLLING_WINDOW_REPROBE_MS } : {}),
      });
    }
  }

  if (exitCode !== 0) {
    yield {
      type: 'error',
      // A spawn failure never produced an exit code — name the real cause
      // (e.g. "failed to spawn claude: spawn claude ENOENT") instead of the
      // opaque "exited ?" (EI-11519). Otherwise append the backend's own failure line
      // (WI-10003188) so a surface that renders only `message` can say WHY.
      message: spawnErrMsg ?? agentExitErrorMessage(backend, exitCode, failureLine),
      stderr: stderrBuf.slice(-800),
      ...(cliTurn ? { turn: cliTurn } : {}),
    };
  } else {
    if (
      (backend === 'claude-code' && !claudeTerminalUsageSeen) ||
      (backend === 'omp' && (!ompUsageSeen || !ompUsageComplete)) ||
      (backend === 'codex' && (!codexUsageSeen || !codexUsageComplete))
    ) {
      unreportedFrames = Math.max(unreportedFrames, 1);
    }
    yield {
      type: 'result',
      costUsd,
      tokensIn,
      tokensOut,
      finalText,
      ...(numTurns !== undefined ? { numTurns } : {}),
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
      ...(unreportedFrames > 0 ? { unreportedFrames } : {}),
    };
  }
  } finally {
    // Release the shared concurrency permit (no-op when ungoverned). Runs on normal exit, the
    // spawn-failure early return, an abort, and a consumer that abandons the generator early.
    releaseGovernor?.();
  }
}
