/**
 * GET /api/harness/:slug/intel/spawn-tree — spawn-tree rows for the Intel panel.
 *
 * Ported from app/api/harness/[slug]/intel/spawn-tree/route.ts. `auth: 'public'`.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

/**
 * Mirrors the writer's status vocabulary (RecordInvocationInput['status'] in
 * projected-tool-deps.ts) — a status that can be WRITTEN but not filtered for is
 * only half-observable. Had drifted: 'invalid-input' was never added, and
 * 'replayed' arrived with WI-6792.
 */
const ALLOWED_STATUS = new Set([
  'ok',
  'error',
  'timeout',
  'quota-exceeded',
  'role-not-allowed',
  'invalid-input',
  'replayed',
]);

export default defineTool({
  method: 'GET',
  path: '/harness/:slug/intel/spawn-tree',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) {
      return Response.json({ error: 'invalid slug' }, { status: 400 });
    }
    const url = new URL(req.url);
    const sinceMs = Number(url.searchParams.get('sinceMs') ?? Date.now() - 24 * 60 * 60 * 1000);
    const limitRaw = Number(url.searchParams.get('limit') ?? 200);
    const limit = Math.min(2000, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 200));
    const statusParam = url.searchParams.get('status');
    const status = statusParam && ALLOWED_STATUS.has(statusParam) ? statusParam : null;
    const ws = activeWorkspaceId();

    try {
      const { sql } = getOrgPg();
      // WI-1671: tool_invocations_spawn_tree_filtered (Migration 460) — a
      // parameterized SQL function replacing the bare `tool_invocations_spawn_tree`
      // view. The view's `WITH RECURSIVE` base term has no filter, so Postgres
      // can't push workspace_id/harness_slug/invoked_at/status down into it —
      // every query scanned the WHOLE tool_invocations table (7.4M rows) before
      // this LIMIT applied (EI-6801: a 27-min wedge, fleet-wide lock stampede).
      // The function selects the filtered candidates FIRST (indexed), then
      // walks UP (bounded 16 hops) to compute depth/root_spawn_id.
      // P-041: explicit workspace_id scope — getOrgPg uses the admin role
      // (bypasses RLS), so pass ws explicitly rather than relying on RLS.
      const rows = await sql<Array<{
        id: number;
        tool_name: string;
        plugin_name: string;
        role: string;
        feature_id: string | null;
        chunk_id: string | null;
        run_id: string | null;
        spawn_id: string;
        parent_spawn_id: string | null;
        window_key: string;
        invoked_at: Date;
        duration_ms: number | null;
        status: string;
        output_ref: string | null;
        output_size: number | null;
        error_message: string | null;
        depth: number;
        root_spawn_id: string;
      }>>`
        SELECT id, tool_name, plugin_name, role,
               feature_id, chunk_id, run_id, spawn_id, parent_spawn_id,
               window_key, invoked_at, duration_ms, status,
               output_ref, output_size, error_message,
               depth, root_spawn_id
          FROM harness_shared.tool_invocations_spawn_tree_filtered(
                 p_harness_slug => ${slug},
                 p_since => to_timestamp(${sinceMs}::double precision / 1000.0),
                 p_status => ${status},
                 p_limit => ${limit},
                 p_workspace_id => ${ws}
               )
      `;
      return Response.json({
        rows: rows.map((r) => ({
          id: r.id,
          toolName: r.tool_name,
          pluginName: r.plugin_name,
          role: r.role,
          featureId: r.feature_id,
          chunkId: r.chunk_id,
          runId: r.run_id,
          spawnId: r.spawn_id,
          parentSpawnId: r.parent_spawn_id,
          windowKey: r.window_key,
          invokedAtMs: new Date(r.invoked_at).getTime(),
          durationMs: r.duration_ms,
          status: r.status,
          outputRef: r.output_ref,
          outputSize: r.output_size,
          errorMessage: r.error_message,
          depth: r.depth,
          rootSpawnId: r.root_spawn_id,
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
