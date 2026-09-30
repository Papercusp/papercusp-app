/**
 * operator:decisions — read recent rows from the operator_decisions
 * SQL view (workspace-scoped). Mirrors GET /api/agent-mcp/decisions.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { withWorkspace, generated } from '@papercusp/db-org';
import { drizzle } from 'drizzle-orm/postgres-js';
import { desc } from 'drizzle-orm';
import { activeWorkspaceId } from '../../workspace-registry';

const v = generated.operatorDecisionsInHarnessShared;

export default defineTool({
  name: 'operator:decisions',
  profile: 'engineer',
  description: 'Read recent operator_decisions rows for the active workspace (id, ts, actor, action, target, details).',
  capability: 'operator:read',
  guidance: {
    when: `Read the operator decision log — what flips, dispatches, and autoaccepts happened and why.`,
    notWhen: `For action audit (user-action style), use \`actions:recent\` or \`operator:audit\`. decisions is the operator-policy view.`,
    seeAlso: [
      'actions:recent (user-action style audit)',
      'operator:audit (full operator audit feed)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    limit: z.number().int().positive().max(500).optional(),
  }),
  async handler(args) {
    const limit = args.limit ?? 50;
    const workspaceId = activeWorkspaceId();
    const rows = await withWorkspace(workspaceId, async (tx) => {
      const txDb = drizzle(tx);
      return await txDb
        .select({
          id: v.id,
          ts: v.ts,
          actor: v.actor,
          action: v.action,
          target: v.target,
          details: v.details,
        })
        .from(v)
        .orderBy(desc(v.ts))
        .limit(limit);
    });
    return { content: [{ type: 'text', text: JSON.stringify({ decisions: rows }) }] };
  },
});
