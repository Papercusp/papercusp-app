/**
 * Adapter: tooldef catalog (`ToolDefinition`) → `Capability[]` (P-003, server half).
 *
 * The mapper takes a structural `ToolDefinitionMeta` (the subset of tooldef's
 * `ToolDefinition` we read) so it carries no dependency on `@papercusp/tooldef`
 * and is trivially testable. The server-side enumerator (P-004) passes real
 * `ToolDefinition`s — structurally compatible — and the `tools/list` MCP
 * projection is unchanged.
 */
import type { Capability, CapabilityRiskTier } from './types';
import { schemaRequiresArgs } from './introspection';
import { humanizeCapabilityId, shorten } from './format';

/** The fields of tooldef's `ToolDefinition` this adapter reads. */
export interface ToolDefinitionMeta {
  name: string;
  description: string;
  capability: string;
  tier: CapabilityRiskTier; // tooldef CapabilityTier === our CapabilityRiskTier
  args?: unknown;
  guidance?: { when?: string };
  /** Agent-persona allowlist (`tool.roles`), if the def carries one. */
  roles?: Iterable<string>;
}

// Conservative heuristics: better to over-confirm / over-exclude than to fire a
// destructive or streaming tool from a single keystroke. Phase 2 replaces these
// with explicit flags on the tool definition (P-006).
// Token-boundary-aware so substrings don't false-match (e.g. "proce[sse]s"
// must NOT count as streaming). Boundaries are the id/capability separators.
const DESTRUCTIVE_RE = /(?:^|[._:-])(delete|remove|kill|destroy|reset|rollback|cancel|dismiss|purge|drop|promote|restore|revoke|deprecate)(?:$|[._:-])/i;
const STREAMING_RE = /(?:^|[._:-])(sse|stream|streaming|realtime|voice|conv|converse)(?:$|[._:-])/i;
const INTERACTIVE_RE = /(?:^|[._:-])(converse|conv|chat|ask|askchoice)(?:$|[._:-])/i;

export function toolDefinitionToCapability(def: ToolDefinitionMeta): Capability {
  const id = def.name;
  const destructive =
    DESTRUCTIVE_RE.test(id) || DESTRUCTIVE_RE.test(def.capability) || def.tier === 'high';

  return {
    id,
    title: humanizeCapabilityId(id),
    description: shorten(def.description),
    agentDescription: def.guidance?.when ?? def.description,
    runsIn: 'server',
    requiresArgs: schemaRequiresArgs(def.args),
    destructive,
    streaming: STREAMING_RE.test(id),
    interactive: INTERACTIVE_RE.test(id),
    tier: def.tier,
    gating: {
      agentRoles: def.roles ? [...def.roles] : undefined,
      // The tool's required capability string becomes a principal-capability requirement.
      auth: { capabilities: [def.capability] },
    },
    surfaces: { mcp: true },
  };
}

export function tooldefCatalogToCapabilities(defs: readonly ToolDefinitionMeta[]): Capability[] {
  return defs.map(toolDefinitionToCapability);
}

/**
 * The fields of a projected-registry `ProjectedTool` entry this adapter reads
 * (structural, so this module stays free of `@papercusp/tooldef` imports).
 *
 * The projected registry is the FULL tool surface: principal-gated tools
 * (auto-projected from the legacy catalog), role-gated tools
 * (`requirePrincipal: false` — these NEVER enter the legacy `getCatalog()`),
 * and plugin tools. The palette listing + invoke must read THIS shape — the
 * legacy-catalog read silently dropped every role-gated group (hive:*,
 * flags:*, …), so the Start Hive button got `no tool named "pot:start"`.
 */
export interface ProjectedToolMeta {
  description: string;
  /** JSON Schema for tool input (already projected from Zod at register time). */
  inputSchema: Record<string, unknown>;
  /** Required capability strings (empty = no capability gate). */
  capabilities: readonly string[];
  /** Agent-persona allowlist, if the tool carries one. */
  agentRoles?: readonly string[];
  guidance?: { when?: string };
}

const TIER_ORDER: Record<CapabilityRiskTier, number> = { low: 0, medium: 1, high: 2 };

/**
 * Map a projected-registry entry to a palette `Capability`. `tierFor` is the
 * host's capability→tier resolver (injected to keep this module dependency-
 * free); a multi-capability tool gets its highest capability's tier.
 */
export function projectedToolToCapability(
  name: string,
  tool: ProjectedToolMeta,
  tierFor: (capability: string) => CapabilityRiskTier,
): Capability {
  const tier = tool.capabilities.reduce<CapabilityRiskTier>(
    (acc, c) => (TIER_ORDER[tierFor(c)] > TIER_ORDER[acc] ? tierFor(c) : acc),
    'low',
  );
  const destructive =
    DESTRUCTIVE_RE.test(name) || tool.capabilities.some((c) => DESTRUCTIVE_RE.test(c)) || tier === 'high';

  return {
    id: name,
    title: humanizeCapabilityId(name),
    description: shorten(tool.description),
    agentDescription: tool.guidance?.when ?? tool.description,
    runsIn: 'server',
    requiresArgs: schemaRequiresArgs(tool.inputSchema),
    destructive,
    streaming: STREAMING_RE.test(name),
    interactive: INTERACTIVE_RE.test(name),
    tier,
    gating: {
      agentRoles: tool.agentRoles ? [...tool.agentRoles] : undefined,
      auth: { capabilities: [...tool.capabilities] },
    },
    surfaces: { mcp: true },
  };
}
