/**
 * config:list-overrides — the runtime-config observability keystone
 * (live-configurability-audit-2026-06-20 P-024, reviewer gap #1 / D-005).
 *
 * Reads EVERY registered runtime-config concern (the override-concern registry) and reports,
 * per concern, the keys currently diverging from baked defaults — each with its effective
 * value, the layer that set it, and (best-effort) the latest audit row (who/when). So the
 * override layer is never opaque: one read answers "what runtime config has been changed away
 * from defaults, by whom, across the whole system."
 *
 * A generic READ — consistent with D-001 (the no-god-tool rule is about generic WRITES).
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { listOverrideConcerns, type OverrideEntry } from '../../config-overrides/registry';

export default defineTool({
  name: 'config:list-overrides',
  profile: 'engineer',
  description:
    'Read every live runtime-config override diverging from baked defaults, across all registered concerns (watchdog tunables, …). Each key reports its effective value, the layer that set it, and the latest audit row. The observability surface over the runtime-config control tools so the override layer is never opaque.',
  capability: 'operator:read',
  guidance: {
    when: 'You (or an operator debugging odd fleet behavior) need to see what runtime config has been changed away from its baked defaults — every override across all concerns, in one place, with who/when.',
    notWhen: "To CHANGE a value, use that concern's set tool (e.g. improvements:set-watchdog-tunables). To revert overrides to defaults, use config:reset-overrides.",
    chaining: 'config:reset-overrides to revert a concern (or all) back to baked defaults.',
    seeAlso: [
      'config:reset-overrides (revert a concern back to baked defaults)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 60 } },
  args: z.object({
    concern: z.string().max(120).optional().describe('Limit to one concern by name; omit for all.'),
  }),
  async handler(args) {
    const concerns = listOverrideConcerns().filter((c) => !args.concern || c.name === args.concern);
    const { sql } = getOrgPg();
    const ws = activeWorkspaceId();

    const out: Array<{
      concern: string;
      description?: string;
      overrideCount: number;
      overrides: OverrideEntry[];
      lastChange: { actor: string; ts: number } | null;
    }> = [];

    for (const c of concerns) {
      let overrides: OverrideEntry[] = [];
      try {
        overrides = await c.diff();
      } catch (e) {
        // A single concern's read failure must not blank the whole readback.
        console.warn(`[config:list-overrides] concern '${c.name}' diff failed:`, e instanceof Error ? e.message : e);
      }

      let lastChange: { actor: string; ts: number } | null = null;
      if (c.auditAction) {
        try {
          const rows = await sql<{ actor: string; ts: number | string }[]>`
            SELECT actor, ts
              FROM harness_shared.audit_log
             WHERE workspace_id = ${ws} AND action = ${'gateway-control.' + c.auditAction}
             ORDER BY ts DESC
             LIMIT 1`;
          if (rows[0]) lastChange = { actor: rows[0].actor, ts: Number(rows[0].ts) };
        } catch {
          /* best-effort — no audit row is fine */
        }
      }

      out.push({
        concern: c.name,
        description: c.description,
        overrideCount: overrides.length,
        overrides,
        lastChange,
      });
    }

    const totalOverrides = out.reduce((n, c) => n + c.overrideCount, 0);
    return { content: [{ type: 'text', text: JSON.stringify({ concernCount: out.length, totalOverrides, concerns: out }) }] };
  },
});
