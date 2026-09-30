/**
 * Design sketches — list + create.
 *
 *   GET  /api/design/sketches?harness=<slug>&feature=<id>&workspace=<id>
 *   POST /api/design/sketches  { harness, feature, png, label? }
 *
 * `png` is a data URL (data:image/png;base64,…) stored inline in the
 * jsonb payload. v0.1 keeps everything inline because volume is low
 * and queries don't read the bytes.
 *
 * Ported from app/api/design/sketches/route.ts. `auth: 'public'` —
 * gateApiRoute(FLAGS.DESIGN) is the actual gate.
 */
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '../../../require-flag';
import { defineTool } from '@papercusp/agent-mcp';

interface SketchPayload {
  png: string;
  label?: string;
}

const MAX_PNG_BYTES = 5 * 1024 * 1024;

const list = defineTool({
  method: 'GET',
  path: '/design/sketches',
  auth: 'public',
  async handler(req) {
    const blocked = await gateApiRoute(req, FLAGS.DESIGN);
    if (blocked) return blocked;
    const url = new URL(req.url);
    const harness = url.searchParams.get('harness') ?? '';
    const feature = url.searchParams.get('feature') ?? '';
    const workspace = url.searchParams.get('workspace') ?? 'default';
    if (!harness || !feature) {
      return Response.json(
        { ok: false, error: 'harness and feature query params required' },
        { status: 400 },
      );
    }
    try {
      const { sql } = getOrgPg();
      const rows = await sql.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspace]);
        return await tx`
          SELECT id, payload, metadata, created_ts
            FROM harness_shared.harness_design_artifacts
           WHERE harness_slug = ${harness}
             AND feature_id   = ${feature}
             AND kind         = 'sketch'
           ORDER BY created_ts DESC
           LIMIT 100
        `;
      });
      return Response.json({
        ok: true,
        sketches: rows.map((r) => ({
          id: r.id,
          label: (r.payload as SketchPayload | null)?.label ?? null,
          png: (r.payload as SketchPayload | null)?.png ?? null,
          createdTs: r.created_ts == null ? null : Number(r.created_ts),
          metadata: r.metadata ?? {},
        })),
      });
    } catch (err) {
      return Response.json(
        { ok: false, error: 'pg_error', detail: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  },
});

const create = defineTool({
  method: 'POST',
  path: '/design/sketches',
  auth: 'loopback',
  async handler(req) {
    const blocked = await gateApiRoute(req, FLAGS.DESIGN);
    if (blocked) return blocked;
    let body: { harness?: string; feature?: string; png?: string; label?: string; workspace?: string };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }
    const harness = body.harness?.trim();
    const feature = body.feature?.trim();
    const png = body.png?.trim();
    const workspace = body.workspace?.trim() || 'default';
    if (!harness || !feature || !png) {
      return Response.json(
        { ok: false, error: 'harness, feature, and png required' },
        { status: 400 },
      );
    }
    if (!png.startsWith('data:image/png;base64,')) {
      return Response.json(
        { ok: false, error: 'png must be a data:image/png;base64,… URL' },
        { status: 400 },
      );
    }
    if (png.length > MAX_PNG_BYTES) {
      return Response.json(
        { ok: false, error: 'png too large', detail: `max ${MAX_PNG_BYTES} bytes` },
        { status: 413 },
      );
    }
    try {
      const id = `sketch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = Date.now();
      const payload: SketchPayload = { png, label: body.label };
      const { sql } = getOrgPg();
      const payloadJson = JSON.stringify(payload);
      const metadataJson = JSON.stringify({ source: 'design-tab-sketch' });
      await sql.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspace]);
        await tx`
          INSERT INTO harness_shared.harness_design_artifacts
            (id, harness_slug, feature_id, kind, payload, metadata, created_ts)
          VALUES (${id}, ${harness}, ${feature}, 'sketch',
                  ${payloadJson}::text::jsonb, ${metadataJson}::text::jsonb, ${now})
        `;
      });
      return Response.json({ ok: true, id, createdTs: now });
    } catch (err) {
      return Response.json(
        { ok: false, error: 'pg_error', detail: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  },
});

export default [list, create];
