/**
 * GET /api/admin/llm-tests/findings — cross-run findings list with
 * severity / source / axis / acknowledged / shape filters.
 *
 * Ported from app/api/admin/llm-tests/findings/route.ts. `auth: 'public'`.
 */
import { sharedUtilityPoolMax } from '../../../resource-profile';
import { getLongLivedAdminPool } from '../../../long-lived-admin-pool';
import { defineTool } from '@papercusp/agent-mcp';

// Transactional pool. Re-resolves the admin URL on every use and rebinds if the endpoint
// moved (EI-19306394439939264) — the module-level singleton this replaced could not. The
// shared connection options and idle policy are applied for us, so this site can't omit them.
const db = () => getLongLivedAdminPool('llm-tests-findings-route', {
  max: sharedUtilityPoolMax(),
  prepare: false,
});

export default defineTool({
  method: 'GET',
  path: '/admin/llm-tests/findings',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req) {
    const url = new URL(req.url);
    const severity = url.searchParams.get('severity') ?? undefined;
    const source = url.searchParams.get('source') ?? undefined;
    const axis = url.searchParams.get('axis') ?? undefined;
    const shape = url.searchParams.get('shape') ?? undefined;
    const ackParam = url.searchParams.get('acknowledged');
    // Default: only unacknowledged.
    const acknowledged = ackParam === 'true' ? true : ackParam === 'false' ? false : false;
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 200)));

    const sql = db();
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT f.id, f.run_id, f.source, f.severity, f.axis, f.assert_kind, f.shape,
             f.evidence_turn_idx, f.claim, f.suggestion, f.copy_prompt,
             f.promoted_to_assert_id, f.acknowledged,
             r.scenario_id, r.scenario_target, r.persona_id,
             r.sut_model, r.judge_model, r.started_at
      FROM harness_shared.llm_test_findings f
      JOIN harness_shared.llm_test_runs r ON r.id = f.run_id
      WHERE f.acknowledged = ${acknowledged}
        AND (${severity ?? null}::text IS NULL OR f.severity = ${severity ?? null})
        AND (${source ?? null}::text IS NULL OR f.source = ${source ?? null})
        AND (${axis ?? null}::text IS NULL OR f.axis = ${axis ?? null})
        AND (${shape ?? null}::text IS NULL OR f.shape = ${shape ?? null})
      ORDER BY
        CASE f.severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END,
        r.started_at DESC
      LIMIT ${limit}
    `;

    // Group by shape: distinct scenario count per shape, so the UI can
    // flag "shown up across N scenarios — promotion candidate".
    const shapes = await sql<Array<{ shape: string; scenario_count: string }>>`
      SELECT f.shape, COUNT(DISTINCT r.scenario_id)::text AS scenario_count
      FROM harness_shared.llm_test_findings f
      JOIN harness_shared.llm_test_runs r ON r.id = f.run_id
      WHERE f.source = 'judge'
        AND f.shape IS NOT NULL
        AND f.promoted_to_assert_id IS NULL
        AND r.started_at > now() - INTERVAL '14 days'
      GROUP BY f.shape
      HAVING COUNT(DISTINCT r.scenario_id) >= 2
    `;
    const shapeCounts: Record<string, number> = {};
    for (const s of shapes) shapeCounts[s.shape] = Number(s.scenario_count);

    return Response.json({ findings: rows, shapeCounts });
  },
});
