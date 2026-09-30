/**
 * harness:health — single-call health verdict for a harness slug.
 *
 * Calls getHealth() in lib/harness-readers.ts directly — same function
 * the GET /api/harness/:slug/health route projects.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getHealth } from '../../harness-readers';

// + overwatch (overwatch-role-2026-06-15 B-01): the supervisor reads harness health.
const ALL_ROLES = [...SU_ROLES, 'papercup', 'papercup-deep', 'kettle'] as const;

export default defineTool({
  name: 'harness:health',
  profile: 'engineer',
  description:
    'Read consolidated health verdict for a harness (alive, escalated, feature counts, ghost rate, checks).',
  capability: 'harness:read',
  guidance: {
    when: 'User asks "is sheets healthy?", "is the harness running?". Single fast snapshot — alive, escalated flag, feature-status counts.',
    notWhen: 'For LIVE phase + activity (recent audit events), use `harness:status`. For open issues, use `work_items:list`.',
    seeAlso: [
      'harness:status (LIVE phase + recent activity)',
      'harness:overview (the consolidated read)',
      'work_items:list (open issues)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({
    slug: z.string().min(1),
  }),
  async handler(args) {
    const result = await getHealth(args.slug);
    if (!result.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }] };
    }
    // P-008: augment with this harness's stuck-queue slice (freed-but-non-dispatchable
    // + dead-held feature rows). Best-effort — omitted if the read fails. The
    // workspace-global reaper metric + reaper-liveness alarm live in system-health.
    let stuckQueue: { stuckFeatures: number; deadHeldFeatures: number } | undefined;
    try {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { activeWorkspaceId } = await import('../../workspace-registry');
      const { readHarnessStuckFeatures } = await import('../../work-queue-health');
      stuckQueue = await readHarnessStuckFeatures(getOrgPg().sql, activeWorkspaceId(), args.slug);
    } catch { /* best-effort — omit stuckQueue on failure */ }
    return { content: [{ type: 'text', text: JSON.stringify({ ...result.data, stuckQueue }) }] };
  },
});
