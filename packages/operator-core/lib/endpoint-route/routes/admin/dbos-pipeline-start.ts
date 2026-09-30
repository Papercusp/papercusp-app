/**
 * POST /api/admin/dbos/pipeline/start — opt a feature into a durable pipeline
 * (dbos-durable-jobs-2026-05-31 Phase 3, D-011/D-012). Body:
 * `{ harnessSlug, featureId }`. Ownership-respecting via `ensureFeaturePipeline`:
 * reuses a live pipeline, else starts a fresh epoch (no double-dispatch).
 *
 * Only meaningful when `PAPERCUSP_DBOS_ORCHESTRATOR=1` (the workflow is
 * registered + DBOS launched there) — returns 409 otherwise. This is the manual
 * trigger / ops affordance + the validation vehicle for the carve-out + start
 * wiring; the production auto-dispatcher is a separate follow-up. `orchestrator-
 * start` is imported lazily so its DBOS workflow registration only runs when the
 * endpoint is actually invoked (never at route-registration time when the flag
 * is off).
 */
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/admin/dbos/pipeline/start',
  auth: { trust: ['trusted'] },
  async handler(req): Promise<Response> {
    if (process.env.PAPERCUSP_DBOS_ORCHESTRATOR === '0') {
      return Response.json(
        {
          error: 'orchestrator_disabled',
          message: 'The durable orchestrator is explicitly disabled (PAPERCUSP_DBOS_ORCHESTRATOR=0). Unset it (default-on since P-009) + ensure DBOS is enabled (PAPERCUSP_DBOS_ENABLE=1) to use durable pipelines.',
        },
        { status: 409 },
      );
    }
    let body: { harnessSlug?: unknown; featureId?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: 'bad_json' }, { status: 400 });
    }
    const harnessSlug = typeof body.harnessSlug === 'string' ? body.harnessSlug.trim() : '';
    const featureId = typeof body.featureId === 'string' ? body.featureId.trim() : '';
    if (!harnessSlug || !featureId) {
      return Response.json(
        { error: 'missing_args', message: 'harnessSlug and featureId are required' },
        { status: 400 },
      );
    }
    try {
      const { ensureFeaturePipeline } = await import('../../../dbos/orchestrator-start');
      const result = await ensureFeaturePipeline(harnessSlug, featureId);
      return Response.json({ ok: true, ...result });
    } catch (err) {
      return Response.json(
        { error: 'start_failed', message: (err as Error).message },
        { status: 500 },
      );
    }
  },
});
