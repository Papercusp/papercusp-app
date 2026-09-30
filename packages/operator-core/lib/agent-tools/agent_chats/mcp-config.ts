/**
 * agent_chats:chat's scoped MCP tool surface (work-item-chat-context-modernize-
 * 2026-07-18, P-004).
 *
 * Before this, a role-scoped WI/harness chat agent got NO MCP tools at all —
 * see chat.ts's former "Future change-point: forward here if a role gains
 * tools" comment. It could only read/edit files and shell out, so answering
 * "what does this item say", "what's it blocked by", "what does that other
 * item look like" meant grepping the repo or hand-rolling raw psql/Bash —
 * exactly the owner-reported failure (work-item-chat-context-modernize
 * Background: "fell to raw Postgres + Bash-guard fights"). Meanwhile the
 * autonomous claim-path cup working the SAME item already answers those
 * questions with one tool call.
 *
 * This gives the chat agent a SMALL, read-mostly surface covering exactly
 * those questions — layered ON TOP of its existing native tools
 * (Read/Write/Bash/Edit/…, unrestricted; this surface only ADDS tools, it
 * never narrows what the agent already has). Deliberately excludes
 * `docs:get`/`docs:outline`: the agent keeps its native Read/Bash to open a
 * doc file once `docs:search` names the path — no second doc-reading tool
 * needed alongside full filesystem access (unlike the isolated,
 * builtin-free docs-qa agent, which has no other way to read a doc).
 *
 * Follows the HTTP-direct `agentmcp` MCP-config shape used by
 * `plans/runner.ts` (`buildPlanAgentMcpConfig`) / `operator/converse.ts` —
 * the modern lever; the older `npx mcp-remote` stdio bridge oracle/docs-qa
 * still carry is the flaky empty-turn culprit that pattern replaced.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { selfUrl } from '../../self-url';
import { activeWorkspaceId } from '../../workspace-registry';

/**
 * The focused MCP surface: enough for a chat agent to answer item questions
 * BY TOOL — the item itself, related items, the plan it's derived from,
 * project docs, and prior relevant memory — plus `voice:say`, which the
 * reused Papercup persona requires on every user-facing turn. Bare `:`-form
 * names (the MCP catalog's canonical form); `AGENT_CHATS_ALLOWED_TOOLS`
 * below derives the `mcp__agentmcp__`-prefixed `--allowed-tools` form the
 * spawn needs. `voice:say` remains role-gated by its own definition
 * (`papercup` / `operator`); this list only makes it projectable.
 */
export const AGENT_CHATS_MCP_TOOLS = [
  'work_items:get',
  'work_items:list',
  'plans:get',
  'docs:search',
  'memory:search',
  'voice:say',
] as const;

/** The complete `--allowed-tools` surface for the chat's attached MCP config. */
export const AGENT_CHATS_ALLOWED_TOOLS: readonly string[] = AGENT_CHATS_MCP_TOOLS.map(
  (t) => `mcp__agentmcp__${t}`,
);

export interface AgentChatsMcpConfig {
  mcpServers: {
    agentmcp: {
      type: 'http';
      url: string;
      headers: Record<string, string>;
    };
  };
}

/** Read the loopback superuser token — the chat spawn's credential for the
 *  operator's own MCP endpoint. Empty string when absent (unprovisioned
 *  build) — the caller degrades to the pre-P-004 no-tools behavior rather
 *  than failing the chat turn. */
function readSuperuserToken(): string {
  try {
    const token = readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim();
    return token.length >= 16 ? token : '';
  } catch {
    return '';
  }
}

/**
 * Build the scoped `agentmcp` MCP config for a work-item/harness chat turn.
 * `?tools=` seeds `tools/list` to exactly `AGENT_CHATS_MCP_TOOLS` (a LISTING
 * hint — see tool-allowlist.ts — paired with the spawn's `--allowed-tools`,
 * which is the actual call gate) so the agent sees a small, focused surface
 * instead of the full ~300-tool operator catalog. `?harness=` scopes the
 * session's default harness (when known) so `work_items:get/list` /
 * `plans:get` / `docs:search` calls don't need an explicit `harness` arg —
 * mirrors the claim-path cup's own harness-scoped session.
 *
 * Returns `null` when the loopback superuser token is unavailable — the
 * caller (chat.ts) must treat that as "run with no MCP tools", exactly
 * today's pre-P-004 behavior, never a hard failure of the chat turn.
 */
export function buildAgentChatsMcpConfig(opts: {
  harness?: string | null;
  workspaceId?: string;
  readToken?: () => string;
} = {}): AgentChatsMcpConfig | null {
  const superuserToken = (opts.readToken ?? readSuperuserToken)().trim();
  // Same floor as readSuperuserToken() applies for the real file — enforced
  // here too so an injected `readToken` (tests) can't accidentally bypass it.
  if (superuserToken.length < 16) return null;

  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const toolsParam = AGENT_CHATS_MCP_TOOLS.join(',');
  const harnessParam = opts.harness ? `&harness=${encodeURIComponent(opts.harness)}` : '';
  const url =
    `${selfUrl()}/api/mcp?superuser=1` +
    `&workspace=${encodeURIComponent(workspaceId)}` +
    `&tools=${encodeURIComponent(toolsParam)}` +
    harnessParam;

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

/** Tool-event name filter (mirrors oracleToolEventFilter / DOCS_QA's
 *  inline filter): strips the `mcp__agentmcp__` prefix so a forwarded
 *  `tool_call` event reads `work_items:get`, not the raw MCP name. Returns
 *  `null` for anything else — every native builtin tool call
 *  (Bash/Read/Edit/…) is DROPPED, not surfaced as `tool_call` — so chat.ts
 *  only ever forwards `agentmcp`-sourced calls, matching the small attached
 *  surface this module owns. */
export function agentChatsToolEventFilter(raw: string): string | null {
  return raw.startsWith('mcp__agentmcp__') ? raw.slice('mcp__agentmcp__'.length) : null;
}
