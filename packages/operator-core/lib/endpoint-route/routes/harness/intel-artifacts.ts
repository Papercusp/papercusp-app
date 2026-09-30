/**
 * GET /api/harness/:slug/intel/artifacts — pack/diff artifact rows for the Intel panel.
 *
 * Ported from app/api/harness/[slug]/intel/artifacts/route.ts. `auth: 'public'`.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const ALLOWED_KIND = new Set(['pack', 'diff', 'all']);

export default defineTool({
  method: 'GET',
  path: '/harness/:slug/intel/artifacts',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) {
      return Response.json({ error: 'invalid slug' }, { status: 400 });
    }
    const url = new URL(req.url);
    const kindRaw = url.searchParams.get('kind') ?? 'all';
    const kind = ALLOWED_KIND.has(kindRaw) ? kindRaw : 'all';
    const sinceMs = Number(url.searchParams.get('sinceMs') ?? Date.now() - 7 * 24 * 60 * 60 * 1000);
    const limitRaw = Number(url.searchParams.get('limit') ?? 100);
    const limit = Math.min(500, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100));
    const includePack = kind === 'pack' || kind === 'all';
    const includeDiff = kind === 'diff' || kind === 'all';
    const ws = activeWorkspaceId();

    try {
      const { sql } = getOrgPg();
      // P-041: scope by workspace_id EXPLICITLY (the view exposes it). getOrgPg
      // is the admin role (bypasses RLS) and tool_invocations_artifacts is not a
      // security_invoker view, so the prior set_config('app.workspace_id') was a
      // dead no-op — the query spanned every workspace for a colliding slug.
      const rows = await sql<Array<{
        id: number;
        plugin_name: string;
        tool_name: string;
        role: string;
        feature_id: string | null;
        run_id: string | null;
        spawn_id: string;
        invoked_at: Date;
        duration_ms: number | null;
        output_ref: string | null;
        output_size: number | null;
      }>>`
        SELECT id, plugin_name, tool_name, role,
               feature_id, run_id, spawn_id,
               invoked_at, duration_ms, output_ref, output_size
          FROM harness_shared.tool_invocations_artifacts
         WHERE workspace_id = ${ws}
           AND harness_slug = ${slug}
           AND invoked_at >= to_timestamp(${sinceMs}::double precision / 1000.0)
           AND (
             (${includePack}::boolean AND tool_name LIKE '%.pack')
             OR (${includeDiff}::boolean AND tool_name LIKE '%.diff')
           )
         ORDER BY invoked_at DESC
         LIMIT ${limit}
      `;
      return Response.json({
        rows: rows.map((r) => ({
          id: r.id,
          pluginName: r.plugin_name,
          toolName: r.tool_name,
          role: r.role,
          featureId: r.feature_id,
          runId: r.run_id,
          spawnId: r.spawn_id,
          invokedAtMs: new Date(r.invoked_at).getTime(),
          durationMs: r.duration_ms,
          outputRef: r.output_ref,
          outputSize: r.output_size,
          kind: r.tool_name.endsWith('.pack') ? 'pack' : r.tool_name.endsWith('.diff') ? 'diff' : 'other',
        })),
      });
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  },
});
