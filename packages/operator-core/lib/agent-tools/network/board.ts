/**
 * network:board — the aggregate Network-tab board over the capability-tier
 * ladder (hive-network-surface-2026-06-11, brief B-08, P-006; CONTRACT OWNER
 * C-3). One row per other-hive context: tier 1 this Swarm · tier 2 own other
 * hives · tier 3 shared-Hive peer Swarms (federated) · tier 4 foreign Hives
 * (directory + beacon + our grants/asks).
 *
 * This is the AGENT/MCP projection of the same C-3 rows the `network.board`
 * named sync query serves the dock Network pane (B-09) — both call
 * buildNetworkBoard, so there is one composition, no drift. Read-only; no raw
 * route (the UI rides the sync-resolver + SSE invalidation).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { buildNetworkBoard } from '../../network-board/build-board';

export default defineTool({
  name: 'network:board',
  profile: 'engineer',
  description:
    'The aggregate Network board: one row per other-hive context across the capability-tier ladder — tier 1 this Swarm, tier 2 your own other hives, tier 3 shared-Hive peer Swarms (federated presence), tier 4 foreign Hives from the P2P directory (with their status beacon, your grants, and your outbound-ask traffic). Each row carries a tier + trust label; tier-specific fields (liveAgents/queueDepth/focus/wake/grants/asks) are present only where that tier supplies them. The data behind the dock Network tab.',
  guidance: {
    when: 'You want a single cross-hive situational view — what every other hive context (own, federated peer, foreign) is and what we can see of it.',
    notWhen:
      'Just the workspace-local hives — pot:list. Just the joinable P2P directory — discovery:pots. Per-bee placement detail — fleet:assignments. One hive in depth — pot:get.',
    chaining:
      'discovery:pots → pot:cross_grant to admit a tier-4 peer; pot:get { slug } to drill into an own hive.',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const rows = await buildNetworkBoard({ workspaceId });
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ ok: true, count: rows.length, rows }) },
      ],
    };
  },
});
