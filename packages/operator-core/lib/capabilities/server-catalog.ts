/**
 * Server capability projection (P-004, read side).
 *
 * Projects the live PROJECTED-TOOL registry (`listAllProjectedTools()`) into
 * palette-eligible `Capability` records for a given principal:
 *   - principal capability gate (mirrors dispatch: `*` or holds every cap),
 *   - the §3 palette safety filter (excludes streaming/interactive/required-arg;
 *     keeps non-destructive low/med as fire-and-toast and destructive/high as confirm).
 *
 * The projected registry — not the legacy `getCatalog()` — is the full tool
 * surface: principal-gated tools (auto-projected), role-gated tools
 * (`requirePrincipal: false`, which never enter the legacy catalog), and
 * plugin tools. Reading the legacy catalog silently dropped every role-gated
 * group (hive:*, flags:*, …) from the palette: listed-but-uninvocable was the
 * visible half, and `no tool named "pot:start"` from the run-tool bridge was
 * the invisible half.
 *
 * Read-only: it never invokes anything. The MCP `tools/list` projection is
 * untouched (D-002 non-goal). Execution authority is re-checked at dispatch
 * (the invoke endpoint), so this projection is a UX convenience, not the gate
 * of record.
 */
import { listAllProjectedTools, tierFor } from '@papercusp/agent-mcp';
import type { Principal } from '@papercusp/agent-mcp';
import type { ProjectedToolMeta } from './from-tooldef';
import { projectedToolToCapability } from './from-tooldef';
import { paletteEligibility } from './safety-filter';
import type { Capability } from './types';

export interface ServerCapability extends Capability {
  /** How the palette must run it (never `'exclude'` — those are filtered out here). */
  eligibility: 'fire-and-toast' | 'confirm';
}

/** A named projected-registry entry — the enumerable unit of the catalog. */
export interface NamedProjectedTool {
  /** The MCP name (the palette invoke name, e.g. `pot:start`). */
  name: string;
  tool: ProjectedToolMeta;
}

function principalAllows(
  principal: Pick<Principal, 'capabilities'>,
  requiredCapabilities: readonly string[],
): boolean {
  const caps = principal.capabilities;
  if (caps.has('*')) return true;
  return requiredCapabilities.every((c) => caps.has(c));
}

/** The live registry, projected to the enumerable shape (MCP-named entries only). */
function liveCatalog(): NamedProjectedTool[] {
  const out: NamedProjectedTool[] = [];
  for (const tool of listAllProjectedTools()) {
    const name = tool.expose.mcp?.name;
    if (!name) continue; // HTTP-only plumbing — not invocable by name
    out.push({ name, tool: { ...tool, capabilities: tool.capabilities as readonly string[] } });
  }
  return out;
}

/**
 * Palette-eligible server capabilities the principal may invoke. `catalog`
 * is injectable for tests; defaults to the live projected registry.
 */
export function getServerCapabilities(opts: {
  principal: Pick<Principal, 'capabilities'>;
  /**
   * Agent persona the palette invokes as (the run-tool ctx uses `operator`).
   * When set, tools whose `agentRoles` allowlist excludes it are filtered out
   * so the listing matches invocability — a tool that would 403 at dispatch
   * never appears. Tools with no allowlist are available to every role.
   */
  role?: string;
  catalog?: readonly NamedProjectedTool[];
}): ServerCapability[] {
  const entries: readonly NamedProjectedTool[] = opts.catalog ?? liveCatalog();
  const out: ServerCapability[] = [];
  for (const { name, tool } of entries) {
    if (!principalAllows(opts.principal, tool.capabilities)) continue;
    const cap = projectedToolToCapability(name, tool, tierFor);
    if (
      opts.role &&
      cap.gating.agentRoles &&
      cap.gating.agentRoles.length > 0 &&
      !cap.gating.agentRoles.includes(opts.role)
    ) {
      continue;
    }
    const eligibility = paletteEligibility(cap);
    if (eligibility === 'exclude') continue;
    out.push({ ...cap, eligibility });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
