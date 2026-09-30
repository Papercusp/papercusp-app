/**
 * storage:prune — safe prune-by-category-and-age (storage-settings-page-2026-06-15
 * P-003). High-tier + destructive: deletes local diagnostic/bloat rows or on-disk
 * session/cache entries older than N days (or all). DEFAULT keep-all — only an
 * explicit call runs it. Federated categories are refused (trimming changes what
 * peers see). Always dry-run first.
 *
 * Bloat-queue categories (substrate_outbox) also VACUUM FULL to return disk,
 * coordinated via the db:migrate exclusive resource lock with drain.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  name: 'storage:prune',
  profile: 'engineer',
  description:
    "Delete a storage category's rows/entries older than N days (or all). Local-only safe categories only; federated categories are refused. Bloat tables also VACUUM FULL to reclaim disk. Pass dryRun to preview count + estimated reclaim.",
  capability: 'storage:write',
  guidance: {
    when: 'The owner (or the Storage settings page) deliberately trims a local-only category — telemetry tables, the drained federation outbox, or on-disk session/scratch/flight-recorder stores.',
    notWhen: 'To read sizes use storage:usage. Federated categories (plans/features/issues/coord) are refused — trimming would change what peers see.',
    chaining: 'storage:usage → storage:prune { category, olderThanDays, dryRun: true } → review reclaim → storage:prune { category, olderThanDays }.',
    seeAlso: [
      'storage:usage (read sizes before trimming)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator'],
  args: z.object({
    category: z.string().describe('Storage category id (storage:usage lists them).'),
    olderThanDays: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe('Delete rows/entries older than this many days. Omit or null = ALL.'),
    dryRun: z
      .boolean()
      .optional()
      .describe('Preview matched count + estimated reclaim WITHOUT deleting.'),
  }),
  async handler(args, ctx) {
    const { pruneStorageCategory } = await import('../../storage/prune');
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const principalWs = ctx?.principal?.workspaceId;
    const ws = principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId();
    const result = await pruneStorageCategory({
      categoryId: args.category,
      olderThanDays: args.olderThanDays ?? null,
      dryRun: args.dryRun ?? false,
      workspaceId: ws,
      signal: ctx?.signal,
    });
    if (result.ok && !result.dryRun) {
      const { notifySyncInvalidate } = await import('../../sync-sse');
      await notifySyncInvalidate('storage.usage').catch(() => {});
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: !result.ok,
    };
  },
});
