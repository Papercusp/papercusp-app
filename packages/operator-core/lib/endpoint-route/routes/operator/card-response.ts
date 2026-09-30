/**
 * POST /api/operator/conversations/:id/card-response
 *
 * Resolves a pending ctx.askUser card. Session-auth + 30 RPS per user.
 *
 * Ported from app/api/operator/conversations/[id]/card-response/route.ts.
 * `auth: 'loopback'` (auth-tier Wave 1) — session check inline.
 */
import { resolveCardResponse } from '@papercusp/agent-mcp';
import { getSessionUserOrLocalDefault } from '../../session-or-local';
import { cardResponseRateAllow } from '../../../card-response-rate-limit';
import { defineTool } from '@papercusp/agent-mcp';

interface Body {
  correlationId: string;
  action: 'submit' | 'decline' | 'cancel';
  workspaceId: string;
  payload?: unknown;
  reason?: string;
}

export default defineTool({
  method: 'POST',
  path: '/operator/conversations/:id/card-response',
  auth: 'loopback',
  async handler(req) {
    // WI-5044: session user OR (loopback-only) the seeded default user — the
    // desktop webview has no session cookie; a strict cookie check made every
    // card pick un-postable on the shipping product.
    const user = await getSessionUserOrLocalDefault(req);
    if (!user) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as Body | null;
    if (
      !body ||
      typeof body.correlationId !== 'string' ||
      body.correlationId.length === 0 ||
      typeof body.workspaceId !== 'string' ||
      body.workspaceId.length === 0 ||
      (body.action !== 'submit' && body.action !== 'decline' && body.action !== 'cancel')
    ) {
      return Response.json(
        { error: 'correlationId, workspaceId, action required; action ∈ {submit,decline,cancel}' },
        { status: 400 },
      );
    }

    if (!cardResponseRateAllow(user.id)) {
      return Response.json(
        { error: 'rate limit: 30 RPS per user' },
        { status: 429 },
      );
    }

    const r = resolveCardResponse({
      correlationId: body.correlationId,
      action: body.action,
      payload: body.payload,
      reason: body.reason,
      expectedWorkspaceId: body.workspaceId,
    });

    if (!r.ok) {
      return Response.json(
        { error: r.error, ...(r.details ? { details: r.details } : {}) },
        { status: r.status },
      );
    }
    return Response.json({ ok: true });
  },
});
