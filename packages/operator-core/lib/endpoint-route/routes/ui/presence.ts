/**
 * POST /api/ui/presence — tab presence heartbeat upsert.
 *
 * Ported from app/api/ui/presence/route.ts. `auth: 'loopback'` (auth-tier Wave 1) —
 * loopback check inline (preserves exact 403 'loopback_required' shape).
 */
import { z } from 'zod';
import { getOrgPg } from '@papercusp/db-org';
import { isLoopbackRequest } from '../../../superuser-token';
import { defineTool } from '@papercusp/agent-mcp';

const BodySchema = z.object({
  client_id: z.string().min(8).max(128),
  url: z.string().min(1).max(4096),
  title: z.string().max(512).nullable().optional(),
  workspace_id: z.string().max(128).nullable().optional(),
  viewport: z.record(z.string(), z.unknown()).nullable().optional(),
});

export default defineTool({
  method: 'POST',
  path: '/ui/presence',
  auth: 'loopback',
  async handler(req) {
    if (!isLoopbackRequest(req.headers)) {
      return Response.json({ error: 'loopback_required' }, { status: 403 });
    }
    let body: unknown;
    try { body = await req.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
    }
    const { client_id, url, title, workspace_id, viewport } = parsed.data;

    const { sql } = getOrgPg();
    const viewportJson = viewport ? JSON.stringify(viewport) : null;
    await sql`
      INSERT INTO harness_shared.ui_clients (client_id, workspace_id, url, title, viewport, last_seen_at)
      VALUES (
        ${client_id},
        ${workspace_id ?? null},
        ${url},
        ${title ?? null},
        ${viewportJson}::text::jsonb,
        now()
      )
      ON CONFLICT (client_id) DO UPDATE
        SET workspace_id = EXCLUDED.workspace_id,
            url          = EXCLUDED.url,
            title        = EXCLUDED.title,
            viewport     = EXCLUDED.viewport,
            last_seen_at = now()
    `;
    return Response.json({ ok: true });
  },
});
