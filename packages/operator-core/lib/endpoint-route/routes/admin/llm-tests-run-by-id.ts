/**
 * GET /api/admin/llm-tests/runs/:id — full run detail (transcript +
 * findings + telemetry + judge).
 *
 * Ported from app/api/admin/llm-tests/runs/[id]/route.ts.
 * `auth: 'public'`. Next `[id]` → Hono `:id`.
 */
import { sharedUtilityPoolMax } from '../../../resource-profile';
import { getLongLivedAdminPool } from '../../../long-lived-admin-pool';
import { defineTool } from '@papercusp/agent-mcp';

// Transactional pool. Re-resolves the admin URL on every use and rebinds if the endpoint
// moved (EI-19306394439939264) — the module-level singleton this replaced could not. The
// shared connection options and idle policy are applied for us, so this site can't omit them.
const db = () => getLongLivedAdminPool('llm-tests-run-by-id-route', {
  max: sharedUtilityPoolMax(),
  prepare: false,
});

export default defineTool({
  method: 'GET',
  path: '/admin/llm-tests/runs/:id',
  auth: { trust: ['verified', 'trusted'] },
  async handler(_req, ctx) {
    const { id } = ctx.params;
    const sql = db();
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT id, scenario_id, scenario_version, scenario_target, scenario_hash,
             identity_hash, matrix_group_id, matrix_index,
             rubric_version, sut_model, judge_model,
             persona_id, persona_traits_json,
             workspace_mode, transport_mode,
             status, started_at, finished_at,
             cost_usd, cap_breaches,
             scores_json, findings_count,
             transcript_norm_json,
             telemetry_json, asserts_json, judge_json,
             metadata_json
      FROM harness_shared.llm_test_runs
      WHERE id = ${id}
    `;
    if (rows.length === 0) {
      return Response.json({ error: 'not found' }, { status: 404 });
    }
    const findings = await sql<Array<Record<string, unknown>>>`
      SELECT id, source, severity, axis, assert_kind, shape,
             evidence_turn_idx, claim, suggestion, copy_prompt,
             acknowledged, acknowledged_by, acknowledged_at
      FROM harness_shared.llm_test_findings
      WHERE run_id = ${id}
      ORDER BY severity, source, axis
    `;
    return Response.json({ run: rows[0], findings });
  },
});
