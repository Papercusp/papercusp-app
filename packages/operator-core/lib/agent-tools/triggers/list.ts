import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { loadExternalTriggerAdminSnapshot } from '../../external-triggers/admin';
import { data, triggerToolContext } from './_shared';

export default defineTool({
  name: 'triggers:list',
  profile: 'engineer',
  description: 'List configured external trigger sources and installed plan bindings in the current workspace.',
  guidance: {
    when: 'Discover trigger source ids before triggers:bind, or inspect which plans already have external-event bindings.',
    notWhen: 'For run/failure health and recent activity use triggers:status. To create a source use triggers:create.',
    chaining:
      'triggers:list → triggers:bind { sourceId, harness, plan, eventPattern } → triggers:arm { bindingId, confirm:true }.',
    seeAlso: ['triggers:status (health and recent runs)', 'triggers:create (install a source)'],
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    sourceKind: z.string().min(1).max(80).optional(),
    plan: z.string().min(1).max(200).optional().describe('plan slug filter'),
    limit: z.number().int().positive().max(500).optional().describe('max sources and bindings, each (default 100)'),
  }),
  async handler(args, ctx) {
    const { sql, workspaceId } = triggerToolContext(ctx);
    const snapshot = await loadExternalTriggerAdminSnapshot(sql, workspaceId);
    const limit = args.limit ?? 100;
    const sources = snapshot.sources.filter((row) => !args.sourceKind || row.kind === args.sourceKind);
    const allowedSourceIds = new Set(sources.map((row) => row.id));
    const bindings = snapshot.bindings.filter(
      (row) => allowedSourceIds.has(row.sourceId) && (!args.plan || row.planSlug === args.plan),
    );
    return data({
      ok: true,
      sources: sources.slice(0, limit),
      bindings: bindings.slice(0, limit),
      counts: { sources: sources.length, bindings: bindings.length },
      truncated: sources.length > limit || bindings.length > limit,
    });
  },
});
