/**
 * The plan-agent runner — plan-agent-launch-2026-05-21, Phase 3 (P-011).
 *
 * A launched plan agent is a NEW sibling surface over the shared
 * `runAgentChat` primitive (D-004), in the mould of `oracle/chat.ts` /
 * `operator/converse.ts`. It is NOT built on `lib/delegates` or
 * the retired delegate voice feature; this module never
 * imports it, so plan agents carry zero coupling to and zero blast
 * radius on voice.
 *
 * What this module owns:
 *
 *   - `buildPlanAgentMcpConfig` — the `agentmcp` HTTP MCP surface the
 *     launched agent talks through. The MCP URL carries
 *     `?plan_run=<sessionId>` — the concrete consumer of P-006 / D-016:
 *     the transport folds it onto `ctx.planRunSessionId`, so every
 *     `plans:*` write the launched agent makes is attributed to its run
 *     in `plan_revisions`.
 *   - `PLAN_AGENT_ALLOWED_TOOLS` — native coding tools (the agent does
 *     real engineering work) + the operator's non-interactive
 *     world-model surface + the `plans:*` surface.
 *   - `runPlanAgent` — the thin `runAgentChat` wrapper. Resumable via
 *     `sessionMode: 'force'` (create-or-resume — D-010).
 *
 * What it does NOT own: `plans:launch` (P-012) is the tool that mints
 * the run, assembles the P-009 context bundle, calls this runner, and
 * persists turns to `plan_run_turns`. This module is just the runner.
 */

import { runAgentChat, type ChatEvent } from '../../agent-chat-stream';
// WI-10004357: the one token reader, so the launched agent presents exactly the bearer
// `isValidSuperuserBearer` checks ($PAPERCUSP_HOME first, then ~/.papercusp).
import { readSuperuserToken, SUPERUSER_TOKEN_PATH } from '../../superuser-token';
import { surfaceBackend, surfaceModel } from '../../agent-config';
import { selfUrl } from '../../self-url';
import { activeWorkspaceId } from '../../workspace-registry';
import { NON_INTERACTIVE_AGENT_MCP_TOOLS } from '../../operator-mcp-tools';

/**
 * Model for a launched plan agent. A plan agent does real engineering
 * work, so it runs on the strong model — the explicit `provider/model`
 * form omp's `--model` requires (a bare id fuzzy-resolves wrong).
 */
export const PLAN_AGENT_MODEL = 'anthropic/claude-opus-4-7';

/**
 * Native agent tools a launched plan agent needs to advance a plan —
 * it edits code, runs commands, searches the tree. claude restricts to
 * exactly `--allowed-tools`, so these must be listed explicitly; omp
 * routes the non-`mcp__` names to `--tools` and ignores any it does not
 * know, so the list is backend-portable.
 */
export const PLAN_AGENT_NATIVE_TOOLS: readonly string[] = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
  'LS',
  'Task',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
];

/**
 * The `plans:*` MCP surface a plan agent uses to advance the plan it
 * was launched on. Its writes through these verbs are attributed to
 * the run (revision capture reads `?plan_run=` — D-016).
 * `plans:backfill-revisions` is deliberately excluded — a one-time
 * migration tool, not something a plan agent should reach for.
 */
const PLAN_TOOL_NAMES = [
  'plans:list',
  'plans:get',
  'plans:items',
  'plans:search',
  'plans:lint',
  'plans:revisions',
  'plans:new',
  'plans:set-content',
  'plans:set-now',
  'plans:set-status',
  'plans:add-decision',
  'plans:add-item',
  'plans:set-frontmatter',
  'plans:set-title',
] as const;

/** The `plans:*` surface, as `mcp__agentmcp__`-prefixed allowed-tool names. */
export const PLAN_AGENT_PLAN_TOOLS: readonly string[] = PLAN_TOOL_NAMES.map(
  (n) => `mcp__agentmcp__${n}`,
);

/**
 * Full MCP allowlist: the operator's non-interactive world-model
 * surface (`harness:*`, `search:*`, `messages:*`, … — a plan is usually
 * about harness work) plus the `plans:*` surface. The interactive
 * `chat:ask_choice` is excluded — a launched run has no live responder
 * mid-run; it is resumed asynchronously (D-010), not chatted with in
 * real time.
 */
export const PLAN_AGENT_MCP_TOOLS: readonly string[] = [
  ...NON_INTERACTIVE_AGENT_MCP_TOOLS,
  ...PLAN_AGENT_PLAN_TOOLS,
];

/** The complete `--allowed-tools` surface for a launched plan agent. */
export const PLAN_AGENT_ALLOWED_TOOLS: readonly string[] = [
  ...PLAN_AGENT_NATIVE_TOOLS,
  ...PLAN_AGENT_MCP_TOOLS,
];

/**
 * Assemble the MCP endpoint URL for a launched plan agent. Pure — no
 * IO — so the query-string contract (`?plan_run=` in particular) is
 * unit-testable without the filesystem.
 */
export function buildPlanAgentMcpUrl(opts: {
  base: string;
  workspace: string;
  /** The run's session id — D-016: travels as `?plan_run=` so the
   *  transport attributes the agent's plan writes to this run. */
  planRunSessionId: string;
  /** Browser-tab client id, when the launch originated from a tab. */
  uiClientId?: string | null;
}): string {
  return (
    `${opts.base}/api/mcp?superuser=1` +
    `&workspace=${encodeURIComponent(opts.workspace)}` +
    `&plan_run=${encodeURIComponent(opts.planRunSessionId)}` +
    (opts.uiClientId ? `&client=${encodeURIComponent(opts.uiClientId)}` : '')
  );
}

/** Inline MCP server config in the shape `runAgentChat` forwards to the
 *  agent backend (`--mcp-config` for claude, `mcp.json` for omp). */
export interface PlanAgentMcpConfig {
  mcpServers: {
    agentmcp: {
      type: 'http';
      url: string;
      headers: Record<string, string>;
    };
  };
}

/**
 * Build the `agentmcp` MCP config a launched plan agent talks through —
 * the operator's own `/api/mcp` over direct HTTP (the form
 * `operator:converse` uses; the old `npx mcp-remote` stdio bridge was
 * the flaky empty-turn culprit). Returns `null` when the loopback
 * superuser token is unavailable — `plans:launch` (P-012) surfaces
 * "plan agent not provisioned".
 */
export function buildPlanAgentMcpConfig(opts: {
  planRunSessionId: string;
  uiClientId?: string | null;
}): PlanAgentMcpConfig | null {
  const superuserToken = readSuperuserToken();
  if (!superuserToken) return null;
  const url = buildPlanAgentMcpUrl({
    base: selfUrl(),
    workspace: activeWorkspaceId(),
    planRunSessionId: opts.planRunSessionId,
    uiClientId: opts.uiClientId ?? null,
  });
  return {
    mcpServers: {
      agentmcp: {
        type: 'http',
        url,
        headers: { Authorization: `Bearer ${superuserToken}` },
      },
    },
  };
}

/**
 * Tool-event name filter for the run transcript. Strips the
 * `mcp__agentmcp__` prefix so `plans:set-content` reads cleanly in the
 * run view; native tool calls (`Bash`, `Edit`, …) pass through
 * unchanged — unlike oracle's filter, a plan agent's native tool use is
 * real work and must surface in the transcript.
 */
export function planAgentToolEventFilter(raw: string): string {
  return raw.startsWith('mcp__agentmcp__')
    ? raw.replace(/^mcp__agentmcp__/, '')
    : raw;
}

export interface RunPlanAgentOptions {
  /**
   * The run's stable session id. Used three ways, all the same id:
   * `runAgentChat`'s `sessionId` (the agent CLI session),
   * `?plan_run=` on the MCP URL (revision attribution — D-016), and
   * the `plan_runs.session_id` row P-012 writes.
   */
  sessionId: string;
  /**
   * The launch seed — the P-009 context bundle (preamble + plan doc +
   * rationale digest). Sent as the agent's SYSTEM prompt so the run
   * transcript (`plan_run_turns`) holds the real conversation, not a
   * 25 KB seed-as-turn-1.
   */
  systemPromptText: string;
  /**
   * The user turn: the free-text launch note, or — on resume — the
   * continuation message. A default kickoff is used when a launch
   * carries no note.
   */
  promptText: string;
  /** Working directory — workspace root (D-008: the launch is
   *  workspace-scoped; the agent `cd`s into harnesses as needed). */
  cwd: string;
  /** Browser-tab client id, when the launch came from a tab — lets the
   *  agent's `ui:*` calls default to it. */
  uiClientId?: string | null;
  /**
   * Gateway admission-tier label (gateway-priority-tiers WI-4542) — forwarded
   * verbatim to `runAgentChat`'s `priority`, which stamps `x-papercusp-priority`
   * on the spawned agent's own LLM calls. Callers (`plans:launch` / `plans:resume`)
   * derive this from who triggered the run — `'interactive'` when a human is
   * synchronously watching (a power-user/UI launch), else a non-interactive
   * label (e.g. `'su'`) so an autonomous launch never rides fully untagged into
   * the lowest default band.
   */
  priority?: string;
  /** Cancellation — forwarded to the spawned process. */
  signal?: AbortSignal;
}

/**
 * Run (or resume) a plan agent. A thin wrapper over `runAgentChat`:
 * builds the MCP config, sets the plan-agent tool surface, and uses
 * `sessionMode: 'force'` (create-or-resume) so the same call launches a
 * fresh run and resumes an existing one (D-010). Yields `runAgentChat`'s
 * `ChatEvent` stream verbatim — `plans:launch` (P-012) consumes it to
 * stream the UI and persist turns to `plan_run_turns`.
 *
 * Throws when the agent is not provisioned (no superuser token) — a
 * launch cannot proceed without the `plans:*` MCP surface.
 */
export async function* runPlanAgent(
  opts: RunPlanAgentOptions,
): AsyncGenerator<ChatEvent, void, void> {
  const mcpConfig = buildPlanAgentMcpConfig({
    planRunSessionId: opts.sessionId,
    uiClientId: opts.uiClientId ?? null,
  });
  if (!mcpConfig) {
    throw new Error(
      `plan agent not provisioned: ${SUPERUSER_TOKEN_PATH} is missing ` +
        'or too short — the launched agent cannot reach the plans:* MCP surface.',
    );
  }
  // per-surface backend override (/settings/agent); undefined → global
  const plansBackend = await surfaceBackend('plans');
  yield* runAgentChat({
    promptText: opts.promptText,
    systemPromptText: opts.systemPromptText,
    model: (await surfaceModel('plans')) ?? PLAN_AGENT_MODEL, // OQ3 override
    backend: plansBackend,
    mcpConfig,
    allowedTools: [...PLAN_AGENT_ALLOWED_TOOLS],
    toolEventFilter: planAgentToolEventFilter,
    permissionMode: 'bypassPermissions',
    // gateway-priority-tiers (WI-4542/WI-5676): tag the spawn's admission tier so it
    // never falls to the untagged lowest band — caller-supplied (see RunPlanAgentOptions.priority);
    // 'su' is a safe default when a caller omits it (better than untagged tier-5).
    priority: opts.priority ?? 'su',
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    sessionMode: 'force',
    signal: opts.signal,
  });
}
