/**
 * Slash-prompt glue for the MCP transport
 * (slash-exposure-tool-catalog-2026-06-12).
 *
 * The DYNAMIC half of prompts/list + prompts/get: every tool the session
 * can see (the exact tools/list walk) projects as a `tool:*` MCP prompt so
 * agent clients surface the catalog as slash commands. The per-tool
 * mechanics (naming, arg derivation, instruction render) live in tooldef's
 * `slash-projection.ts`; this module binds them to the live projection
 * registry + the advertised-schema swap and owns slash-origin telemetry.
 *
 * Extracted from `_mcp-handler.ts` so the parity invariant — tools/list
 * names ⟺ dynamic prompt names — is testable against the real registry
 * without an HTTP harness (the `_mcp-result-replay.ts` pattern).
 */

import {
  lookupByMcpName,
  listAllProjectedTools,
  listMcpProjections,
  slashPromptListingFor,
  slashPromptNameFor,
  slashPromptToolName,
  resolveSlashExposure,
  renderSlashPrompt,
  type ProjectedTool,
  type SlashPromptListing,
} from '@papercusp/agent-mcp';
import type { AgentRole } from '@papercusp/plugin-sdk';
import { advertisedArgsSchema } from '@papercusp/result-encoding';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';

/**
 * Map the session-visible tool listings (the SAME array tools/list serves)
 * to dynamic slash-prompt listings. Tools with `expose.slash: false` drop
 * out here; everything else is parity by construction (plan P-004). The
 * advertised-schema swap (positional-`row` write tools,
 * token-efficient-agent-io P-008) is applied so prompt args match what the
 * agent can actually call.
 */
export function dynamicSlashListings(
  listings: ReturnType<typeof listMcpProjections>,
): SlashPromptListing[] {
  const out: SlashPromptListing[] = [];
  for (const listing of listings) {
    const projected = lookupByMcpName(listing.name);
    if (!projected) continue;
    const slash = slashPromptListingFor(
      projected,
      advertisedArgsSchema(listing.name, listing.inputSchema),
    );
    if (slash) out.push(slash);
  }
  return out;
}

/**
 * Resolve a `tool:*` prompt name back to its projected tool. Fast path is
 * the MCP name itself; a tool that overrode `expose.slash.name` is found
 * by the fallback scan (overrides are the rare exception).
 */
export function resolveSlashToolForPrompt(promptName: string): ProjectedTool | undefined {
  const suffix = slashPromptToolName(promptName);
  const direct = lookupByMcpName(suffix);
  if (direct && slashPromptNameFor(direct) === promptName) return direct;
  return listAllProjectedTools().find((t) => slashPromptNameFor(t) === promptName);
}

/**
 * Session-visibility predicate for a slash prompt — the same gates
 * `listMcpProjections` applies (MCP exposure, role allowlist, profile)
 * plus the slash opt-out, so prompts/get admits exactly what prompts/list
 * listed.
 */
export function slashToolVisibleTo(
  tool: ProjectedTool,
  role?: AgentRole,
  profile?: 'engineer' | 'power' | 'generic',
): boolean {
  if (!tool.expose.mcp || resolveSlashExposure(tool) === null) return false;
  if (role && tool.agentRoles && !tool.agentRoles.includes(role)) return false;
  if (profile === 'power' && tool.profile === 'engineer') return false;
  return true;
}

/** Render the slash instruction with the advertised (callable) schema. */
export function renderSlashPromptForTool(
  tool: ProjectedTool,
  args: Record<string, string>,
): ReturnType<typeof renderSlashPrompt> {
  return renderSlashPrompt(
    tool,
    args,
    advertisedArgsSchema(tool.expose.mcp!.name, tool.inputSchema),
  );
}

/**
 * Slash-origin telemetry (plan P-006). The sink DECISION: an `audit_log`
 * row (surfaced by `audit:list`) rather than a new table — prompts/get
 * fires once per slash invocation (low frequency), and the subsequent
 * tools/call audits through the normal dispatch path; this row only
 * records that the invocation ORIGINATED from a slash command.
 * Fire-and-forget — telemetry never blocks the render.
 */
export async function auditSlashPromptGet(
  ctx: {
    workspaceId: string;
    harnessSlug: string;
    role: string;
    spawnId: string;
  },
  toolName: string,
  argKeys: readonly string[],
): Promise<void> {
  try {
    const { sql } = getOrgPg();
    const ws =
      ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : activeWorkspaceId();
    const id = `slash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        id,
        Date.now(),
        `${ctx.role}:${ctx.spawnId}`,
        'slash.prompt_get',
        toolName,
        JSON.stringify({
          argKeys,
          role: ctx.role,
          spawnId: ctx.spawnId,
          harness: ctx.harnessSlug,
        }),
        ws,
      ],
    );
  } catch (err) {
     
    console.warn('[mcp][slash] audit write failed:', err);
  }
}
