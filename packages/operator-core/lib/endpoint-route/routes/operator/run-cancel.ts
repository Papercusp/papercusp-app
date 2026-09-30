/**
 * POST /api/operator/conversations/:id/run-cancel
 *
 * Cancels every pending ctx.askUser card under a given runId.
 * Session-auth + 30 RPS (shared with /card-response).
 *
 * Ported from app/api/operator/conversations/[id]/run-cancel/route.ts.
 * `auth: 'loopback'` (auth-tier Wave 1) — session check inline.
 */
import {
  cancelPendingCardsForRun,
  snapshotWorkspace,
} from '@papercusp/agent-mcp';
import { getSessionUser } from '../../../auth';
import { cardResponseRateAllow } from '../../../card-response-rate-limit';
import { defineTool } from '@papercusp/agent-mcp';

interface Body {
  runId: string;
  workspaceId: string;
}

export default defineTool({
  method: 'POST',
  path: '/operator/conversations/:id/run-cancel',
  auth: 'loopback',
  async handler(req) {
    const user = await getSessionUser(req.headers);
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });

    const body = (await req.json().catch(() => null)) as Body | null;
    if (
      !body ||
      typeof body.runId !== 'string' ||
      body.runId.length === 0 ||
      typeof body.workspaceId !== 'string' ||
      body.workspaceId.length === 0
    ) {
      return Response.json({ error: 'runId, workspaceId required' }, { status: 400 });
    }

    if (!cardResponseRateAllow(user.id)) {
      return Response.json({ error: 'rate limit: 30 RPS per user' }, { status: 429 });
    }

    const runs = snapshotWorkspace(body.workspaceId);
    const ownsRun = runs.some((vs) => vs.runId === body.runId);
    if (!ownsRun) {
      return Response.json({ error: 'run not found in workspace' }, { status: 404 });
    }

    cancelPendingCardsForRun(body.runId);

    return Response.json({ ok: true, cancelledRunId: body.runId });
  },
});
