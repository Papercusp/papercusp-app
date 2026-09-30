/**
 * POST /api/admin/backup-orphan-cleanup — one-shot sweepOrphanSnapshots().
 *
 * Ported from app/api/admin/backup-orphan-cleanup/route.ts.
 * `auth: { trust: ['trusted'] }` — the route's prior
 * `requirePrincipal({ trust: ['trusted'] })`; loopback alone is rejected.
 */
import { sweepOrphanSnapshots } from '../../../backup/orphan-cleanup';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/admin/backup-orphan-cleanup',
  auth: { trust: ['trusted'] },
  timeoutSec: 60,
  async handler(req) {
    let olderThanMs: number | undefined;
    try {
      const body = await req.json();
      if (typeof body?.olderThanMs === 'number' && body.olderThanMs > 0) {
        olderThanMs = body.olderThanMs;
      }
    } catch {
      // No body or invalid JSON — accept defaults.
    }

    try {
      const result = await sweepOrphanSnapshots(olderThanMs ? { olderThanMs } : undefined);
      return Response.json({ ok: true, result });
    } catch (err) {
      return Response.json(
        { error: 'sweep_failed', message: (err as Error).message },
        { status: 500 },
      );
    }
  },
});
