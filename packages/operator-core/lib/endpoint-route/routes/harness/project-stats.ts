/**
 * Per-project (not per-harness) budget and stats:
 *
 *   GET /api/harness/projects/:id/budget   — budget vs committed vs spent
 *   GET /api/harness/projects/:id/stats    — full per-status breakdown,
 *                                            per-harness rollup, budget
 *
 * Note `:id` not `:slug` — this is a workspace project id, not a harness slug.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 6).
 */
import { getLegacyClient } from '@papercusp/db-org';
import { defineTool } from '@papercusp/agent-mcp';

const getBudget = defineTool({
  method: 'GET',
  path: '/harness/projects/:id/budget',
  auth: 'public',
  async handler(_req, ctx) {
    const projectId = ctx.params.id as string;
    try {
      // Cross-harness admin read: keyed by workspace project id (`:id`, not
      // `:slug` — see the file header), and `projects`/`all_features` are not
      // scoped to one harness. harnessQuery/withHarnessSchema are inherently
      // per-harness-schema-scoped and have no equivalent for a shape like this,
      // so this stays on the no-slug admin client (getOrgPg()). Decision + why:
      // WI-5384, mirroring D-005's per-harness getHarnessPg rationale.
      const dbc = getLegacyClient();
      const project = await dbc.prepare('SELECT id, name, budget_cents FROM projects WHERE id = ?').get(projectId) as any;
      if (!project) return Response.json({ error: 'project not found' }, { status: 404 });
      const budget = project.budget_cents == null ? null : Number(project.budget_cents);

      const committed = Number(((await dbc.prepare(`
        SELECT COALESCE(SUM(expected_cost_cents), 0) as total
        FROM all_features
        WHERE project_id = ? AND status NOT IN ('cancelled', 'launched', 'passed')
      `).get(projectId)) as any).total ?? 0);
      const spent = Number(((await dbc.prepare(`
        SELECT COALESCE(SUM(expected_cost_cents), 0) as total
        FROM all_features
        WHERE project_id = ? AND status = 'launched'
      `).get(projectId)) as any).total ?? 0);

      return Response.json({
        project_id: project.id,
        name: project.name,
        budget_cents: budget,
        unlimited: budget === null,
        committed_cents: committed,
        spent_cents: spent,
        available_cents: budget === null ? null : budget - committed,
      });
    } catch (e) {
      return Response.json({ error: `budget query failed: ${(e as Error).message}` }, { status: 500 });
    }
  },
});

const getStats = defineTool({
  method: 'GET',
  path: '/harness/projects/:id/stats',
  auth: 'public',
  async handler(_req, ctx) {
    const projectId = ctx.params.id as string;
    try {
      // Cross-harness admin read: this handler's own GROUP BY harness_slug
      // rollup below is definitionally cross-harness — see the getBudget
      // comment above for the full rationale (WI-5384).
      const dbc = getLegacyClient();
      const project = await dbc.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
      if (!project) return Response.json({ error: 'project not found' }, { status: 404 });
      const budget = project.budget_cents == null ? null : Number(project.budget_cents);

      const featureCounts = (await dbc.prepare(`
        SELECT status, COUNT(*)::int as n, COALESCE(SUM(expected_cost_cents), 0)::bigint as total_cost
        FROM all_features WHERE project_id = ? GROUP BY status
      `).all(projectId) as any[]).map((r) => ({ status: r.status, n: Number(r.n), total_cost: Number(r.total_cost) }));

      const perHarness = (await dbc.prepare(`
        SELECT harness_slug, COUNT(*)::int as features, COALESCE(SUM(expected_cost_cents), 0)::bigint as total_cost
        FROM all_features WHERE project_id = ? GROUP BY harness_slug ORDER BY harness_slug
      `).all(projectId) as any[]).map((r) => ({ harness_slug: r.harness_slug, features: Number(r.features), total_cost: Number(r.total_cost) }));

      const committed = Number(((await dbc.prepare(`
        SELECT COALESCE(SUM(expected_cost_cents), 0) as total FROM all_features
        WHERE project_id = ? AND status NOT IN ('cancelled', 'launched', 'passed')
      `).get(projectId)) as any).total ?? 0);
      const spent = Number(((await dbc.prepare(`
        SELECT COALESCE(SUM(expected_cost_cents), 0) as total FROM all_features
        WHERE project_id = ? AND status = 'launched'
      `).get(projectId)) as any).total ?? 0);

      return Response.json({
        project: {
          id: project.id, name: project.name, status: project.status,
          budget_cents: budget,
          unlimited: budget === null,
          owning_dept: project.owning_dept,
          vertical: project.vertical,
        },
        budget: {
          budget_cents: budget,
          committed_cents: committed,
          spent_cents: spent,
          available_cents: budget === null ? null : budget - committed,
          utilization: budget === null ? null : Math.round(100 * committed / budget),
        },
        featureCounts,
        perHarness,
      });
    } catch (e) {
      return Response.json({ error: `stats query failed: ${(e as Error).message}` }, { status: 500 });
    }
  },
});

export default [getBudget, getStats];
