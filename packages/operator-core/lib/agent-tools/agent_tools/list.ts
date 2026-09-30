/**
 * agent_tools:list — list every MCP-exposed tool with an `allowed` flag
 * for the calling context. Companion to `tools/list` (which strips the
 * gating metadata): this surfaces the role allowlist, capability gate,
 * tier, and quota windows so an agent can introspect *why* a tool would
 * succeed or fail before invoking it.
 *
 * `allowed` is conservative — if it's true the call would clear the
 * role + capability gates. Per-window quota is not consulted here
 * (it's stateful and changes per invocation).
 */

import { z } from 'zod';
import {
  defineTool,
  listAllProjectedTools,
  SU_ROLES,
} from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { loadRoleCapabilities } from '../../endpoint-route/routes/transport/role-principal-caps';
import { shapeAgentToolsList } from './list-shape';

export default defineTool({
  name: 'agent_tools:list',
  description:
    'List MCP-exposed tools with permission status for the caller. Each entry includes name, description, capability, roles allowlist, an `allowed` flag with `reason` when blocked, AND per-tool `guidance` (when/notWhen/chaining resolved for the queried role). Use to discover what you can call without trial-and-error.',
  capability: 'agent_tools:read',
  guidance: {
    when: 'Your tools playbook didn\'t cover a user request and you need to discover what\'s callable. Returns the full catalog filtered by your role, with each tool\'s guidance — treat this as the runtime fallback playbook.',
    notWhen: 'Don\'t use as a fishing expedition. If your playbook covers it, just call the tool. `agent_tools:list` costs a tool call.',
    // EI-21672500371422859: this tool narrows by `filter` (a literal substring over the
    // catalog) while its sibling discovery verb tools:find narrows by `query` (an intent).
    // A caller arriving from tools:find reaches for `query` here, and the bare
    // unrecognized-key rejection ("accepts ONLY: filter, limit, onlyAllowed, asRole")
    // named neither the local spelling nor the intent-search verb. Zero prompt weight
    // (never rendered into the description); paid only on that failure path.
    argRedirects: {
      query: {
        tool: 'tools:find',
        args: { query: '<what you need the tool to DO>' },
        note: 'agent_tools:list has no `query` — it is a permission-annotated catalog DUMP narrowed by `filter` (a literal substring over tool names). Searching by INTENT is tools:find { query }. If you meant the literal-substring narrowing, re-send as agent_tools:list { filter }',
      },
    },
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    /** Optional substring/regex match on tool name. */
    filter: z.string().optional(),
    /** Limit; default 250. */
    limit: z.number().int().positive().max(500).optional(),
    /** Set false to also include tools the caller cannot invoke. Default true. */
    onlyAllowed: z.boolean().optional(),
    /**
     * Hypothetical role to evaluate `allowed` against. Defaults to the
     * caller's own role. Useful in superuser/operator shells: "what
     * would a worker see?" without spawning a real worker.
     */
    asRole: z.string().optional(),
  }),
  // context-trimming-tiers P-023: trimmed/standard sessions get name/capability/
  // allowed + a description excerpt per row (see list-shape.ts) — the full
  // guidance playbook stays behind payloadTier:"full".
  shape: {
    // WI-2145871: the row axis is PINNABLE — `project()` rebuilds each row FROM
    // LITERALS, so a field added to the handler's tools[] mapping and not to that
    // literal is dropped silently at both non-full tiers, `trimmed` being the
    // DEFAULT read. `fields` is the INTERSECTION of both tiers' UNCONDITIONAL
    // keys: the standard-tier extras (reason/composition/when) are behind a tier
    // branch, so pinning them would assert something trimmed never promises.
    // No top-level `preserve`: the envelope is `{ ...d, tools }`, a SPREAD, so a
    // preserve pin would be TRIVIALLY SATISFIED — green while asserting nothing.
    // Falsifiability measured, not assumed
    // (.papercusp/scratch/wi2145871-final-two-teeth.mts, 12/12): the vacuity
    // sentinel is ABSENT here, a dropped `description` is CAUGHT, and the same
    // contract over an identity passthrough is REFUSED as vacuous — and the
    // probe's CALIBRATION arm (the same assertion against logs:read's spreading
    // shaper) DID surface the sentinel, so "absent" is a finding rather than
    // what a broken probe also prints.
    contract: {
      rows: 'tools',
      fields: ['name', 'capability', 'allowed', 'description'],
    },
    standard: (data) => shapeAgentToolsList(data, 'standard'),
    trimmed: (data) => shapeAgentToolsList(data, 'trimmed'),
  },
  async handler(args, ctx) {
    // When asRole is supplied we evaluate the role allowlist against
    // that hypothetical role AND drop the isSuperuser bypass — the
    // caller is asking "what would this role see?", not "what can I
    // bypass right now?".
    const asRoleOverride = args.asRole && args.asRole.length > 0 ? args.asRole : null;
    const role = asRoleOverride ?? ctx.role;
    const isSuperuser = asRoleOverride ? false : ctx.isSuperuser === true;
    // In asRole simulation, use the same role→capability synthesis as real
    // dispatch (synthesizeDispatchPrincipal → loadRoleCapabilities). The
    // earlier lookup of only the system_principals row diverged for roles with
    // blueprint/runtime baseline grants — notably `judge`, whose real
    // principal is synthesized with read-only caps even when its row is absent.
    // Keep this read-only simulation under a short workspace-scoped
    // transaction so runtime grants and RLS see the same workspace as dispatch.
    let effectivePrincipal: { capabilities?: ReadonlySet<string> } | null;
    let principalCaps: ReadonlySet<string>;
    if (asRoleOverride) {
      const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
      const roleCaps = workspaceId
        ? await withWorkspace(workspaceId, (tx) =>
            loadRoleCapabilities(tx, workspaceId, asRoleOverride),
          )
        : null;
      effectivePrincipal = roleCaps ? { capabilities: roleCaps } : null;
      principalCaps = roleCaps ?? new Set<string>();
    } else {
      effectivePrincipal = ctx.principal ?? null;
      principalCaps = effectivePrincipal?.capabilities ?? new Set<string>();
    }

    const filterRe = args.filter ? safeRegex(args.filter) : null;
    const onlyAllowed = args.onlyAllowed ?? true;
    const limit = args.limit ?? 250;

    const out: Array<{
      name: string;
      description: string;
      capability: string | null;
      roles: readonly string[] | null;
      tier: string | null;
      timeoutSec: number | null;
      rolesQuota: Record<string, unknown> | null;
      allowed: boolean;
      reason: string | null;
      /**
       * Per-tool guidance, resolved against the queried role (i.e.
       * `byRole[role]` shallow-merged over the base). Null when the tool
       * has no guidance authored. This is the runtime playbook the model
       * consults when a tool isn't in `<role>.tools.md`. Phase 1a of the
       * tool-guidance arc.
       */
      guidance: { when?: string; notWhen?: string; chaining?: string } | null;
      /** tool-call-batching-wrappers P-010: 'composite' when this tool bundles others
       *  (has `replaces`), else 'primitive'. Filter for composites via composition. */
      composition: 'primitive' | 'composite' | null;
      /** The canonical tool names a composite bundles (the back-pointer source). */
      replaces: readonly string[] | null;
    }> = [];

    for (const tool of listAllProjectedTools()) {
      if (!tool.expose.mcp) continue;
      const name = tool.expose.mcp.name;
      if (filterRe && !filterRe.test(name)) continue;

      let allowed = true;
      let reason: string | null = null;

      // Role allowlist (skipped in superuser mode).
      if (!isSuperuser && tool.agentRoles && role && !tool.agentRoles.includes(role)) {
        allowed = false;
        reason = `role_not_allowed: tool requires one of [${tool.agentRoles.join(', ')}], caller is "${role}"`;
      }

      // Capability gate — only meaningful when a principal is attached
      // (i.e., the bearer resolved) AND we're not in superuser bypass.
      // Mirrors dispatchProjectedTool's check exactly:
      //   if (ctx.principal && !ctx.isSuperuser && tool.capabilities.length > 0)
      // — see packages/agent-mcp/src/dispatch-projected.ts:142.
      if (allowed && effectivePrincipal && !isSuperuser && tool.capabilities.length > 0) {
        const missing = tool.capabilities.filter((c) => !principalCaps.has(c));
        if (missing.length > 0) {
          allowed = false;
          reason = `missing_capability: principal lacks [${missing.join(', ')}]`;
        }
      }

      if (onlyAllowed && !allowed) continue;

      // Resolve per-role guidance: shallow-merge byRole[role] over base.
      // Returns null when the tool has no guidance OR when every resolved
      // field is empty — keeps the response payload small for the common
      // un-migrated case.
      const guidance = resolveProjectedGuidance(tool.guidance, role ?? null);

      out.push({
        name,
        description: tool.description,
        capability: tool.capabilities[0] ?? null,
        roles: tool.agentRoles ?? null,
        // tier is on the legacy ToolDefinition; ProjectedTool doesn't carry it
        // — leave null for now, callers can grep the manifest if they care.
        tier: null,
        timeoutSec: tool.timeoutSec ?? null,
        rolesQuota: (tool.rolesQuota as Record<string, unknown> | undefined) ?? null,
        allowed,
        reason,
        guidance,
        composition: tool.composition ?? null,
        replaces: tool.replaces ?? null,
      });

      if (out.length >= limit) break;
    }

    // {data} envelope so the payload-tier shapers apply.
    return {
      data: {
        callerRole: role ?? null,
        isSuperuser,
        count: out.length,
        tools: out,
      },
    };
  },
});

function safeRegex(input: string): RegExp | null {
  try {
    return new RegExp(input, 'i');
  } catch {
    return null;
  }
}

/**
 * Resolve per-tool guidance for a specific role. Shallow-merges
 * `byRole[role]` over the base `{ when, notWhen, chaining }`. Returns
 * null when there's nothing to surface — keeps the response compact for
 * tools that haven't authored guidance yet.
 */
function resolveProjectedGuidance(
  raw:
    | {
        when?: string;
        notWhen?: string;
        chaining?: string;
        byRole?: Record<string, { when?: string; notWhen?: string; chaining?: string }>;
      }
    | undefined,
  role: string | null,
): { when?: string; notWhen?: string; chaining?: string } | null {
  if (!raw) return null;
  const base = { when: raw.when, notWhen: raw.notWhen, chaining: raw.chaining };
  const override = role && raw.byRole ? raw.byRole[role] : undefined;
  const merged = override ? { ...base, ...override } : base;
  if (!merged.when && !merged.notWhen && !merged.chaining) return null;
  return merged;
}
