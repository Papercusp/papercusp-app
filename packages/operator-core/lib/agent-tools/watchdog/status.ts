import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import {
  readScheduledWatchdogStatus,
  SCHEDULED_WATCHDOG_IDS,
} from '../../watchdog/status';

export default defineTool({
  name: 'watchdog:status',
  profile: 'engineer',
  description:
    'Read the effective health of a scheduled watchdog by joining its live configuration, scheduler execution, eligible scoped rows, and fire ledger. Returns one classified state plus the next diagnostic verb; currently supports su-ideate-ungraded.',
  guidance: {
    when: 'First stop for “is this scheduled watchdog healthy / should zero fires be alarming?” It resolves default-vs-env thresholds, DBOS operation health, tenant-scoped eligibility, and fire history in one read.',
    notWhen: 'For the improvement signal collector use improvements:watchdog-status. To change system routine cadence use routines:set.',
    chaining: 'watchdog:status → follow nextVerb only when non-null.',
    seeAlso: ['improvements:watchdog-status', 'schedule:inventory', 'notifications:recent'],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.enum(SCHEDULED_WATCHDOG_IDS).describe('scheduled watchdog id'),
    scope: z
      .object({
        workspace: z.string().min(1).max(120).optional(),
        harness: z.string().min(1).max(120).optional(),
      })
      .strict()
      .optional()
      .describe('explicit tenant scope; omitted values fall back to the request context'),
  }),
  async handler(args, ctx) {
    const harnessSlug = resolveConcreteHarnessSlug(args.scope?.harness, ctx);
    if (!harnessSlug) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'harness_required' }) }],
        isError: true,
      };
    }
    const workspaceId = resolveConcreteWorkspaceId(args.scope?.workspace, ctx.workspaceId);
    const status = await readScheduledWatchdogStatus({ id: args.id, workspaceId, harnessSlug });
    return { content: [{ type: 'text' as const, text: JSON.stringify(status) }] };
  },
});
