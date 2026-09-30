/**
 * pot:get — the full state of one pot (hive-tool-namespace-2026-06-08 P-003,
 * D-001).
 *
 * The unified pot view: `resolvePot` (home harness + deployment + wake) joined
 * with the live fleet (cups with {doing, queued, load} via fleet:assignments) and
 * the frontier (todo work-items in the pot's harness). A pure aggregator — no
 * new state — composing the canonical readers rather than reimplementing them.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { groupByAgent, listFleetAssignments } from '../../fleet/assignments';
import { listWorkItems } from '../../work-items';
import { resolvePot } from './_resolve';
import { hiveFederationTopicHex } from '../../hive-identity';

export default defineTool({
  name: 'pot:get',
  profile: 'engineer',
  description:
    'The full state of one pot: its home harness + deployment + wake schedule (scheduled?, next/last fire, event subscriptions), its live cups with {doing, queued, load}, and its todo-work frontier depth. Composes resolvePot + fleet:assignments + work_items — the one call for "how is pot X doing".',
  guidance: {
    when: 'You want one pot in depth: is the pot scheduled to wake, who are the members and how loaded, how much work is queued.',
    notWhen: 'A list of all pots — pot:list. The raw per-agent fleet view across the workspace — fleet:assignments.',
    chaining:
      'pot:list to find the slug; pot:wake to fire the pot operator now; pot:declare-wake to change the cadence; pot:dissolve to tear it down.',
    seeAlso: [
      'pot:list (all pots at a glance)',
      'fleet:assignments (the raw per-agent fleet view)',
      'pot:status (next-wake schedule detail)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    slug: z.string().min(1).max(120).describe("The pot's home-harness slug (or its potId)."),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const pot = await resolvePot(args.slug, workspaceId);
    if (!pot) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'hive_not_found',
              message: `No kind:'hive' harness '${args.slug}' in this workspace. Use pot:list to see the pots.`,
            }),
          },
        ],
      };
    }

    // Cups: live agents (+ orphaned claims) in the pot's home harness, with their
    // ordered work-lists — the Mug's placement read, scoped to this pot.
    const rows = await listFleetAssignments({ workspaceId, harness: pot.slug });
    const agents = groupByAgent(rows).filter((a) => a.alive || a.claims.length > 0);
    const cups = agents.map((a) => ({
      agentId: a.agentId,
      label: a.label,
      name: a.name,
      alive: a.alive,
      intent: a.intent,
      doing: a.doing,
      queued: a.queued,
      load: a.load,
    }));

    // Frontier: claimable work-items in the pot's harness — the queue depth the Mug
    // places from. work-item-status-full-unify P-007: the unified claimable token is 'open'
    // (was 'todo'); listWorkItems filters status EXACTLY, so 'todo' now matches ~nothing.
    const todo = await listWorkItems({ harness: pot.slug, state: 'open', limit: 500 });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            pot,
            // The pot's substrate federation topic (hex), derived from its pubkey
            // identity (shared-pot-federation P-003). null until the identity row
            // exists. The swarm-join call-site swap is the Phase-1 boundary.
            federationTopic: pot.pubkey ? hiveFederationTopicHex(pot.pubkey) : null,
            fleet: {
              cups,
              live: cups.filter((b) => b.alive).length,
              work_item_load: cups.reduce((n, b) => n + b.load, 0),
            },
            frontier: { todo_depth: todo.length },
          }),
        },
      ],
    };
  },
});
