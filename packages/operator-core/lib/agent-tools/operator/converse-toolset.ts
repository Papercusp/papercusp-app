/**
 * converse-toolset — the host-TRUST-keyed tool surface + MCP mount of the
 * converse brain (papercup-chat-one-component-one-contract-2026-09-06 P-005,
 * D-007 §2/§3; PARITY rows op-tool-working-set / op-delegate-deep).
 *
 * ONE backend serves both hosts, so the tool surface is keyed on WHO is on the
 * other end, never on the route:
 *
 *   owner   — the desktop / TUI / device surfaces of the workspace owner: the
 *             curated operator working set (ALL_AGENT_MCP_TOOLS) over the
 *             `superuser=1` MCP mount with the on-disk superuser token.
 *   public  — the browser-reachable portal behind its per-user boundary: the
 *             OWNED-loop capability DOORS (`capability:*` + the task facades —
 *             OWNED_LOOP_TOOL_SELECTION, the same set the agent-chats seam gave
 *             the portal's papercup role) plus the interactive card tool, over a
 *             mount that NEVER carries `superuser=1` or the disk token — the
 *             per-user boundary supplies the bearer, and without one the brain
 *             runs TOOL-LESS (fail-closed) rather than borrowing the owner's.
 *
 * The papercup role carries `voice:delegate_deep` under BOTH trusts (D-007 §3):
 * the quick chat model routes hard questions to a papercup-deep session and the
 * answer lands back in the turn. Pure — the door list is injected so the
 * selector unit-tests without the projected-tool registry.
 */
import { ALL_AGENT_MCP_TOOLS, INTERACTIVE_CHAT_TOOLS } from '../../operator-mcp-tools';

export type ConverseHostTrust = 'owner' | 'public';
export const CONVERSE_HOST_TRUSTS = ['owner', 'public'] as const;

/** Claude-code's allowed-tools prefix for agentmcp-projected tools. */
export const AGENT_MCP_TOOL_PREFIX = 'mcp__agentmcp__';

/** The deep-delegation lane as the brain's allowed-tools name. */
export const DELEGATE_DEEP_TOOL = `${AGENT_MCP_TOOL_PREFIX}voice:delegate_deep`;

/** Roles whose toolset carries the deep-delegation tool. */
const DEEP_DELEGATING_ROLES: ReadonlySet<string> = new Set(['papercup']);

export interface SelectConverseToolsInput {
  role: string;
  hostTrust: ConverseHostTrust;
  /** The public host's door names in colon form (capabilityToolNames(
   *  OWNED_LOOP_TOOL_SELECTION)). Called only on public trust. */
  publicDoorNames: () => readonly string[];
}

function toAllowedToolName(colonName: string): string {
  return colonName.startsWith(AGENT_MCP_TOOL_PREFIX) ? colonName : `${AGENT_MCP_TOOL_PREFIX}${colonName}`;
}

function dedupe(names: readonly string[]): readonly string[] {
  return [...new Set(names)];
}

/**
 * The brain's tool surface for this turn, in claude-code allowed-tools form
 * (`mcp__agentmcp__<colon name>`). One list feeds BOTH the `?tools=` mount
 * filter and `--allowed-tools`, so listed == callable by construction.
 */
export function selectConverseTools(input: SelectConverseToolsInput): readonly string[] {
  const deep = DEEP_DELEGATING_ROLES.has(input.role) ? [DELEGATE_DEEP_TOOL] : [];
  if (input.hostTrust === 'owner') {
    return dedupe([...ALL_AGENT_MCP_TOOLS, ...deep]);
  }
  const doors = input.publicDoorNames().map(toAllowedToolName);
  return dedupe([...doors, ...INTERACTIVE_CHAT_TOOLS, ...deep]);
}

export interface ConverseMcpMountInput {
  hostTrust: ConverseHostTrust;
  /** selfUrl() — the operator host base. */
  baseUrl: string;
  workspaceId: string;
  /** The selected tool list (selectConverseTools output). */
  tools: readonly string[];
  /** The browser tab / llm-testing client id, when valid. */
  uiClientId: string | null;
  /** The on-disk superuser token — owner trust only. */
  superuserToken: string;
  /** The per-user boundary's bearer — public trust only. */
  principalToken: string | null;
  /**
   * D-421 (WI-10003195): the brain's agent CLI runs as the hosted customer workspace
   * account (the spawn transform is installed). That account must never hold the
   * operator superuser token, so the owner mount is withheld and the brain runs tool-less.
   */
  agentRunsAsCustomer?: boolean;
}

export interface ConverseMcpMount {
  url: string;
  bearer: string;
}

/**
 * The agentmcp HTTP MCP mount for this turn, or null when the trust's credential
 * is absent (the brain then runs tool-less — never on a borrowed credential).
 * `?tools=` shrinks the /api/mcp surface to the selected set, loaded NON-deferred;
 * `workspace=` scopes the state channel so chat:ask_choice cards reach the
 * surface that subscribed (a mismatch silently kills every card).
 */
export function buildConverseMcpMount(input: ConverseMcpMountInput): ConverseMcpMount | null {
  const toolsParam = input.tools.map((t) => t.replace(AGENT_MCP_TOOL_PREFIX, '')).join(',');
  const common =
    `workspace=${encodeURIComponent(input.workspaceId)}` +
    `&tools=${encodeURIComponent(toolsParam)}` +
    (input.uiClientId ? `&client=${encodeURIComponent(input.uiClientId)}` : '');
  if (input.hostTrust === 'owner') {
    if (!input.superuserToken || input.agentRunsAsCustomer) return null;
    return { url: `${input.baseUrl}/api/mcp?superuser=1&${common}`, bearer: input.superuserToken };
  }
  // Public trust: no superuser param, no disk token — ever. The per-user
  // boundary hands the brain ITS OWN bearer or the brain gets no mount.
  const bearer = input.principalToken?.trim() ?? '';
  if (!bearer) return null;
  return { url: `${input.baseUrl}/api/mcp?principal=pi&${common}`, bearer };
}
