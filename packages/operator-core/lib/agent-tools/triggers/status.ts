import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { loadExternalTriggerAdminSnapshot } from '../../external-triggers/admin';
import { data, triggerToolContext } from './_shared';

export default defineTool({
  // @not-a-cell filtered multi-row source/binding/run-history collection; this is the one canonical door over that collection, not a scalar value duplicated outside the state plane
  name: 'triggers:status',
  profile: 'engineer',
  description: 'Read external-trigger health, armed state, failures, and recent plan-launch runs.',
  guidance: {
    when: 'Verify a source/binding after connect, bind, arm, or disarm; diagnose failed deliveries or plan launches.',
    notWhen: 'For a compact discovery list use triggers:list. This is read-only and does not reconnect a provider.',
    chaining: 'triggers:status → fix source/filter/policy → triggers:arm or triggers:disarm → triggers:status.',
    seeAlso: ['triggers:list (compact inventory)', 'schedule:inventory (recurring runtime visibility)'],
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    sourceId: z.string().uuid().optional(),
    bindingId: z.string().uuid().optional(),
    plan: z.string().min(1).max(200).optional(),
  }),
  async handler(args, ctx) {
    const { sql, workspaceId } = triggerToolContext(ctx);
    const snapshot = await loadExternalTriggerAdminSnapshot(sql, workspaceId);
    const sources = snapshot.sources.filter((row) => !args.sourceId || row.id === args.sourceId);
    const sourceIds = new Set(sources.map((row) => row.id));
    const bindings = snapshot.bindings.filter(
      (row) =>
        sourceIds.has(row.sourceId) &&
        (!args.bindingId || row.id === args.bindingId) &&
        (!args.plan || row.planSlug === args.plan),
    );
    if (args.sourceId && sources.length === 0) {
      return data({ ok: false, error: 'source_not_found', sourceId: args.sourceId });
    }
    if (args.bindingId && bindings.length === 0) {
      return data({ ok: false, error: 'binding_not_found', bindingId: args.bindingId });
    }
    const bindingIds = new Set(bindings.map((row) => row.id));
    const recentRuns = snapshot.recentRuns.filter((row) => bindingIds.has(row.bindingId));
    return data({ ok: true, enabled: snapshot.enabled, counts: snapshot.counts, sources, bindings, recentRuns });
  },
});
