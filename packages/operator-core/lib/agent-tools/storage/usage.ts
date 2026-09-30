/**
 * storage:usage — live storage usage by category (storage-settings-page-2026-06-15
 * P-003). Read-only: PG table sizes + age distribution + on-disk `du`, grouped by
 * category with a federation class. Backs the Settings → Storage page's read and
 * lets an agent answer "what's using disk / what's safe to trim".
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  name: 'storage:usage',
  profile: 'engineer',
  description:
    'Live storage usage by category (PG tables grouped by federation class + on-disk stores), each with total size, an age distribution, and whether it is safe to trim. Read-only.',
  capability: 'storage:read',
  guidance: {
    when: 'Inspecting what is consuming local storage, or before a trim, to see per-category size + the age distribution and which categories are federated (read-only).',
    notWhen: 'To actually delete, use storage:prune (with dryRun first). This never deletes.',
    chaining: 'storage:usage → storage:prune { category, olderThanDays, dryRun: true } → storage:prune { category, olderThanDays }.',
    seeAlso: [
      'storage:prune (actually delete a category — dryRun first)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator'],
  args: z.object({}).optional(),
  async handler() {
    const { computeStorageUsage } = await import('../../storage/usage');
    const categories = await computeStorageUsage();
    const totalBytes = categories.reduce((a, c) => a + c.totalBytes, 0);
    return { data: { ok: true, totalBytes, categories } };
  },
});
