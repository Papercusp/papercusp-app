/**
 * POST /api/agent-mcp/storage-prune — the Storage settings page's trim write path
 * (storage-settings-page-2026-06-15 P-002 / P-003).
 *
 * The MCP `storage:prune` tool REQUIRES args → it's command-palette-excluded
 * (safety-filter §3), so the page writes through this dedicated loopback route —
 * the same shape as `autonomy-policy-set`. Both transports are thin wrappers over
 * the one executor `pruneStorageCategory` (which enforces the federated-refusal +
 * keep-all-by-default invariants); this route adds the sync invalidation so the
 * page refreshes its usage.
 *
 * Loopback-only: the desktop owner surface is the only caller. Destructive, but
 * never auto-fires — only this explicit POST runs it.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { isLoopbackRequest } from '../../../superuser-token';

interface Body {
  category?: unknown;
  olderThanDays?: unknown;
  dryRun?: unknown;
}

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/storage-prune',
  auth: 'loopback',
  async handler(req) {
    if (!isLoopbackRequest(req.headers)) {
      return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
    }
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }

    const category = typeof body.category === 'string' ? body.category : '';
    if (!category) {
      return Response.json({ ok: false, error: 'missing_category' }, { status: 400 });
    }
    // null / omitted → ALL; otherwise a non-negative integer day count.
    let olderThanDays: number | null = null;
    if (body.olderThanDays != null) {
      const n = Number(body.olderThanDays);
      if (!Number.isInteger(n) || n < 0) {
        return Response.json({ ok: false, error: 'invalid_older_than_days' }, { status: 400 });
      }
      olderThanDays = n;
    }
    const dryRun = body.dryRun === true;

    const { activeWorkspaceId } = await import('../../../workspace-registry');
    const { pruneStorageCategory } = await import('../../../storage/prune');
    const ws = activeWorkspaceId();

    try {
      const result = await pruneStorageCategory({
        categoryId: category,
        olderThanDays,
        dryRun,
        workspaceId: ws,
      });
      if (result.ok && !result.dryRun) {
        const { notifySyncInvalidate } = await import('../../../sync-sse');
        // Name-only invalidation (no args): the page subscribes to storage.usage
        // with no args, matching its react-query key ['sync','storage.usage',{}].
        await notifySyncInvalidate('storage.usage').catch(() => {});
      }
      const status = result.ok ? 200 : 400;
      return Response.json(result, { status });
    } catch (err) {
      return Response.json(
        { ok: false, error: (err as Error)?.message ?? 'prune_failed' },
        { status: 500 },
      );
    }
  },
});
