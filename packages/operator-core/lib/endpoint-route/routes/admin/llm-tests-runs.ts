/**
 * GET /api/admin/llm-tests/runs — list recent llm_test_runs (small
 * projection; full transcript via the run-detail route).
 *
 * Ported from app/api/admin/llm-tests/runs/route.ts. `auth: 'public'`.
 */
import { sharedUtilityPoolMax } from '../../../resource-profile';
import { getLongLivedAdminPool } from '../../../long-lived-admin-pool';
import { defineTool } from '@papercusp/agent-mcp';

// Transactional pool. Re-resolves the admin URL on every use and rebinds if the endpoint
// moved (EI-19306394439939264) — the module-level singleton this replaced could not. The
// shared connection options and idle policy are applied for us, so this site can't omit them.
const db = () => getLongLivedAdminPool('llm-tests-runs-route', {
  max: sharedUtilityPoolMax(),
  prepare: false,
});

export default defineTool({
  method: 'GET',
  path: '/admin/llm-tests/runs',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req) {
    const url = new URL(req.url);
    // Empty strings come from the UI's "any" sentinel; treat as undefined.
    const target = url.searchParams.get('target') || undefined;
    const scenario = url.searchParams.get('scenario') || undefined;
    const status = url.searchParams.get('status') || undefined;
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));

    const sql = db();
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT id, scenario_id, scenario_version, scenario_target, identity_hash,
             matrix_group_id, matrix_index,
             rubric_version, sut_model, judge_model,
             persona_id, status,
             started_at, finished_at, cost_usd,
             scores_json, findings_count, cap_breaches
      FROM harness_shared.llm_test_runs
      WHERE (${target ?? null}::text IS NULL OR scenario_target = ${target ?? null})
        AND (${scenario ?? null}::text IS NULL OR scenario_id = ${scenario ?? null})
        AND (${status ?? null}::text IS NULL OR status = ${status ?? null})
      ORDER BY started_at DESC
      LIMIT ${limit}
    `;

    return Response.json({ runs: rows });
  },
});
