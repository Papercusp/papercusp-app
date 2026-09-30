/**
 * POST /api/agent-mcp/operator-audit — single lifecycle audit event.
 * Ported from app/api/agent-mcp/operator-audit/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { writeOperatorAudit, type OperatorAuditKind, type ActorMethod } from '../../../operator-audit';
import { defineTool } from '@papercusp/agent-mcp';

const ALLOWED: ReadonlySet<OperatorAuditKind> = new Set<OperatorAuditKind>([
  'accepted', 'ignored', 'accept_failed', 'undo_cancel',
  'dispatched', 'acked', 'consumed', 'escalated', 'rejected', 'failed',
  'dismissed', 'superseded',
]);

const ALLOWED_METHODS: ReadonlySet<NonNullable<ActorMethod>> = new Set(['voice', 'click', 'api']);

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-audit',
  auth: 'loopback',
  async handler(req) {
    let body: { cardId?: unknown; kind?: unknown; context?: unknown; actorMethod?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return new Response('invalid JSON', { status: 400 });
    }
    const cardId = typeof body.cardId === 'string' ? body.cardId : '';
    const kind = body.kind as OperatorAuditKind;
    if (!cardId || !ALLOWED.has(kind)) {
      return new Response('cardId and kind required (see OperatorAuditKind)', { status: 400 });
    }
    let actorMethod: ActorMethod = null;
    if (typeof body.actorMethod === 'string' && ALLOWED_METHODS.has(body.actorMethod as any)) {
      actorMethod = body.actorMethod as ActorMethod;
    }
    await writeOperatorAudit({
      cardId,
      kind,
      context: body.context && typeof body.context === 'object' ? (body.context as Record<string, unknown>) : undefined,
      actorMethod,
    });
    return Response.json({ ok: true });
  },
});
