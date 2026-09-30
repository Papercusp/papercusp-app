/**
 * POST /api/tui/intents/:id/result — the pui dispatcher posts an intent result
 * back. The TUI analogue of /api/ui/intents/:id/result. `auth: 'loopback'` (auth-tier Wave 1) —
 * loopback-gated inline.
 */
import { z } from 'zod';
import { getOrgPg } from '@papercusp/db-org';
import { isLoopbackRequest } from '../../../superuser-token';
import { defineTool } from '@papercusp/agent-mcp';

const BodySchema = z.object({
  result: z.unknown().optional(),
  error: z.string().nullable().optional(),
});

export default defineTool({
  method: 'POST',
  path: '/tui/intents/:id/result',
  auth: 'loopback',
  async handler(req, ctx) {
    if (!isLoopbackRequest(req.headers)) {
      return Response.json({ error: 'loopback_required' }, { status: 403 });
    }
    const idRaw = ctx.params.id as string;
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) {
      return Response.json({ error: 'invalid_id' }, { status: 400 });
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 });
    }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: 'invalid_body' }, { status: 400 });
    }
    const { result, error } = parsed.data;

    const { sql } = getOrgPg();

    const status = error ? 'error' : 'done';
    const resultJson = result === undefined ? null : JSON.stringify(result);
    const rows = await sql`
      UPDATE harness_shared.tui_intents
      SET status = ${status},
          result = ${resultJson}::text::jsonb,
          error_message = ${error ?? null},
          completed_at = now()
      WHERE id = ${id} AND status = 'pending'
      RETURNING id
    `;
    if (rows.length === 0) {
      return Response.json({ error: 'not_pending_or_missing' }, { status: 404 });
    }
    return Response.json({ ok: true, status });
  },
});
