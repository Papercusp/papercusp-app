/**
 * bakeoff-store.ts — PG persistence for framework bake-off deltas (plan-implementation-framework
 * P-014, migration 293). One row per bake-off run feeds the Learning/Benchmark-tab trend.
 *
 * run_at_ms is epoch ms (BIGINT) so reads map straight to BakeoffTrendRow.at (a number) — no
 * Date<->timestamptz coercion (the org PG client rejects a raw JS Date; see the
 * `org-pg-client-rejects-raw-date` memory). postgres.js returns BIGINT/NUMERIC as strings, so the
 * read coerces with Number().
 */
import type postgres from 'postgres';
import type { BakeoffResult } from './framework-bake-off';
import type { BakeoffTrendRow } from './bakeoff-trend';

/** Persist one bake-off result's delta (a re-run appends a new row — the trend keeps history). */
export async function persistBakeoffDelta(
  sql: postgres.Sql,
  input: { workspaceId: string; result: BakeoffResult; atMs: number },
): Promise<void> {
  const { workspaceId, result, atMs } = input;
  await sql`
    INSERT INTO harness_shared.pot_eval_bakeoff_deltas
      (workspace_id, flag_key, delta_mean_composite, delta_gate_pass_rate, verdict, run_at_ms)
    VALUES
      (${workspaceId}, ${result.flagKey}, ${result.delta.deltaMeanComposite},
       ${result.delta.deltaGatePassRate}, ${result.delta.verdict}, ${atMs})
  `;
}

/** Read the bake-off trend rows for a workspace, newest-first (BakeoffTrendRow[]). */
export async function readBakeoffTrendRows(
  sql: postgres.Sql,
  input: { workspaceId: string; limit?: number },
): Promise<BakeoffTrendRow[]> {
  const limit = Math.min(Math.max(1, input.limit ?? 50), 500);
  const rows = await sql<
    Array<{
      flag_key: string;
      verdict: string;
      delta_mean_composite: string | number;
      delta_gate_pass_rate: string | number;
      run_at_ms: string | number;
    }>
  >`
    SELECT flag_key, verdict, delta_mean_composite, delta_gate_pass_rate, run_at_ms
    FROM harness_shared.pot_eval_bakeoff_deltas
    WHERE workspace_id = ${input.workspaceId}
    ORDER BY run_at_ms DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    flagKey: r.flag_key,
    verdict: r.verdict as BakeoffTrendRow['verdict'],
    deltaMeanComposite: Number(r.delta_mean_composite),
    deltaGatePassRate: Number(r.delta_gate_pass_rate),
    at: Number(r.run_at_ms),
  }));
}
