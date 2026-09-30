/**
 * POST /api/admin/embed-backfill — one-shot runBackfillSweep().
 *
 * Ported from app/api/admin/embed-backfill/route.ts.
 * `auth: { trust: ['trusted'] }`; `timeoutSec: 600` preserves the Next
 * route's `maxDuration = 600` (the sweep can take tens of seconds).
 */
import { runBackfillSweep } from '../../../search/embed-backfill';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/admin/embed-backfill',
  auth: { trust: ['trusted'] },
  timeoutSec: 600,
  async handler() {
    try {
      const result = await runBackfillSweep();
      return Response.json({ ok: true, result });
    } catch (err) {
      return Response.json(
        { error: 'sweep_failed', message: (err as Error).message },
        { status: 500 },
      );
    }
  },
});
