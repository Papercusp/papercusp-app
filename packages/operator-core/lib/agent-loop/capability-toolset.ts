/**
 * capability-toolset — project registry tools into the loop's LoopTool shape
 * (P-007, own-tui-full-divorce-2026-08-24).
 *
 * "Tools are the capability:* doors over MCP" (the plan item): the loop does
 * NOT define its own tool surface — it re-exposes the projected-tool registry
 * (`listAllProjectedTools()`, the same catalog MCP serves), so confinement,
 * gating and telemetry hold by construction: execution routes through a
 * DISPATCHER the host binds to a real principal + tx (the same chokepoint
 * `tools:invoke` rides via `ctx.dispatchTool`). This module never invents an
 * ungated execution path — no dispatcher, no execution.
 *
 * The dispatcher is a SEAM on purpose: which principal the loop acts as is a
 * session-scoped decision that belongs to the loop SERVICE host (P-008 route
 * wiring / P-009 sessions), not to tool projection.
 */
import { listAllProjectedTools, type ProjectedTool } from '@papercusp/tooldef';
import type { LoopTool } from './loop';
import { assertSelectedInputSchemaBudget } from '../agent-tools/tool-guidance-budget';

/** MCP-shaped dispatch result (the registry dispatcher's return contract). */
export interface DispatchResult {
  content?: ReadonlyArray<unknown>;
  structuredContent?: unknown;
  isError?: boolean;
}

/** The host-bound execution chokepoint: same contract as `ctx.dispatchTool`
 *  (principal + gating + telemetry live BEHIND it). */
export type ToolDispatcher = (
  name: string,
  args: Record<string, unknown>,
) => Promise<DispatchResult>;

export interface CapabilityToolsetOpts {
  /** The principal-bound dispatcher. Required — there is no ungated default. */
  dispatch: ToolDispatcher;
  /** Exact tool names to include (colon form, e.g. 'capability:read'). */
  names?: readonly string[];
  /** Name prefixes to include. Default: ['capability:'] — the doors. */
  prefixes?: readonly string[];
  /** Per-tool HITL gate; return true to route the call through the loop's
   *  ApprovalPort. Default: no approval required (the doors are already
   *  confinement-armed; interactive HITL policy is the host's call). */
  needsApproval?: (toolName: string, input: unknown) => boolean;
  /** Injectable registry source (tests). Default: listAllProjectedTools(). */
  registry?: () => ProjectedTool[];
}

/** Selection-only subset used by prompt assembly before a dispatcher exists. */
export type CapabilityToolSelectionOpts = Pick<
  CapabilityToolsetOpts,
  'names' | 'prefixes' | 'registry'
>;

/**
 * The owned chat loop exposes the capability doors plus the canonical task
 * engine's model-family facades. Keep this selection shared by prompt
 * assembly and executable tool construction so the model cannot be told about
 * a task tool that the loop omitted (or vice versa).
 */
export const OWNED_LOOP_TOOL_SELECTION: CapabilityToolSelectionOpts = {
  prefixes: ['capability:'],
  names: ['tasks:ops', 'tasks:todo_write', 'tasks:update_plan'],
};

/** A projected tool's MCP name, when it is MCP-exposed. */
function mcpName(t: ProjectedTool): string | undefined {
  const name = (t as { expose?: { mcp?: { name?: unknown } } }).expose?.mcp?.name;
  return typeof name === 'string' && name ? name : undefined;
}

function selectCapabilityTools(
  opts: CapabilityToolSelectionOpts,
): Array<{ name: string; tool: ProjectedTool }> {
  const prefixes = opts.prefixes ?? ['capability:'];
  const wantNames = new Set(opts.names ?? []);
  const all = (opts.registry ?? listAllProjectedTools)();

  const selected: Array<{ name: string; tool: ProjectedTool }> = [];
  const seen = new Set<string>();
  for (const t of all) {
    const name = mcpName(t);
    if (!name || seen.has(name)) continue;
    if (wantNames.has(name) || prefixes.some((p) => name.startsWith(p))) {
      seen.add(name);
      selected.push({ name, tool: t });
    }
  }

  const missing = [...wantNames].filter((n) => !seen.has(n));
  if (missing.length) {
    throw new Error(`capabilityToolset: named tool(s) not in the projected registry: ${missing.join(', ')}`);
  }
  return selected;
}

/**
 * Exact names the loop will expose for a selection. Prompt builders use this
 * before the principal-bound dispatcher (and therefore the executable
 * LoopTools) can be constructed, keeping advertised tools and executable tools
 * on the same selector instead of duplicating the `capability:` filter.
 */
export function capabilityToolNames(opts: CapabilityToolSelectionOpts = {}): string[] {
  return selectCapabilityTools(opts).map(({ name }) => name);
}

/** Flatten an MCP-shaped result into a JSON-serializable tool_result payload:
 *  structuredContent when present, else parsed/plain text content. */
export function flattenDispatchResult(result: DispatchResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const texts: string[] = [];
  for (const item of result.content ?? []) {
    if (item && typeof item === 'object' && (item as { type?: unknown }).type === 'text') {
      const text = (item as { text?: unknown }).text;
      if (typeof text === 'string') texts.push(text);
    }
  }
  const joined = texts.join('\n');
  if (!joined) return null;
  try {
    return JSON.parse(joined);
  } catch {
    return joined;
  }
}

/**
 * Build the loop's toolset from the projected registry. Selection = exact
 * `names` ∪ `prefixes` matches over MCP-exposed tools; a name in `names` that
 * matches nothing is a hard error (a silently-missing door is exactly the
 * misconfiguration that must fail loud at construction, not mid-conversation).
 */
export function capabilityToolset(opts: CapabilityToolsetOpts): LoopTool[] {
  const selected = selectCapabilityTools(opts);
  assertSelectedInputSchemaBudget(
    selected.map(({ name, tool }) => ({ name, inputSchema: tool.inputSchema })),
    { label: 'capabilityToolset' },
  );
  return selected.map(({ name, tool }) => ({
    name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(opts.needsApproval
      ? { needsApproval: (input: unknown) => opts.needsApproval!(name, input) }
      : {}),
    execute: async (input: unknown) => {
      const args =
        input && typeof input === 'object' && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      const result = await opts.dispatch(name, args);
      const payload = flattenDispatchResult(result);
      if (result.isError) {
        // Throw → the loop records an isError tool_result the model can react to.
        throw new Error(
          typeof payload === 'string' ? payload : JSON.stringify(payload ?? `tool ${name} failed`),
        );
      }
      return payload;
    },
  }));
}
