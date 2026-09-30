/**
 * `llm-test promote-candidates` — list novel_failure shapes that have
 * shown up in ≥3 distinct scenarios over the last 14 days.
 *
 * Plan §6.6. The promotion loop: judge findings carry a `shape` hash
 * (sha256 of axis + normalized summary). When the same shape repeats
 * across scenarios, that's a sign it should become a built-in
 * deterministic assert instead of relying on the judge to catch it.
 *
 * This module is the read side. The admin runs `pnpm llm-test
 * promote-candidates`, eyeballs the list, then runs
 * `pnpm llm-test promote --shape <hash>` to scaffold the new assert.
 */

import { getLongLivedAdminPool } from '../../long-lived-admin-pool';

export interface PromotionCandidate {
  shape: string;
  axis: string;
  exampleClaim: string;
  scenarioCount: number;
  runCount: number;
  firstSeen: Date;
  lastSeen: Date;
}

// Transactional pool — re-resolves the admin URL on every use and rebinds if the endpoint
// moved (EI-19306394439939264). Shared connection options + idle policy come with it.
const db = () =>
  getLongLivedAdminPool('llm-testing-promotion-candidates', { max: 2, prepare: false });

const DEFAULTS = {
  windowDays: 14,
  minScenarios: 3,
};

export async function findPromotionCandidates(opts: {
  windowDays?: number;
  minScenarios?: number;
} = {}): Promise<PromotionCandidate[]> {
  const sql = db();
  const windowDays = opts.windowDays ?? DEFAULTS.windowDays;
  const minScenarios = opts.minScenarios ?? DEFAULTS.minScenarios;

  const rows = await sql<Array<{
    shape: string;
    axis: string;
    example_claim: string;
    scenario_count: string;
    run_count: string;
    first_seen: Date;
    last_seen: Date;
  }>>`
    WITH per_shape AS (
      SELECT
        f.shape,
        f.axis,
        (array_agg(f.claim ORDER BY r.started_at DESC))[1] AS example_claim,
        COUNT(DISTINCT r.scenario_id) AS scenario_count,
        COUNT(*) AS run_count,
        MIN(r.started_at) AS first_seen,
        MAX(r.started_at) AS last_seen
      FROM harness_shared.llm_test_findings f
      JOIN harness_shared.llm_test_runs r ON r.id = f.run_id
      WHERE f.source = 'judge'
        AND f.shape IS NOT NULL
        AND f.promoted_to_assert_id IS NULL
        AND r.started_at > now() - (${windowDays}::int * INTERVAL '1 day')
      GROUP BY f.shape, f.axis
    )
    SELECT shape, axis, example_claim,
           scenario_count, run_count,
           first_seen, last_seen
    FROM per_shape
    WHERE scenario_count >= ${minScenarios}
    ORDER BY scenario_count DESC, run_count DESC
  `;

  return rows.map((r) => ({
    shape: r.shape,
    axis: r.axis,
    exampleClaim: r.example_claim,
    scenarioCount: Number(r.scenario_count),
    runCount: Number(r.run_count),
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  }));
}

export function formatCandidatesReport(c: PromotionCandidate[]): string {
  if (c.length === 0) {
    return 'No novel-failure shapes have repeated across ≥3 scenarios in the lookback window. Nothing to promote.';
  }
  const lines: string[] = [];
  lines.push(`Found ${c.length} candidate(s) for promotion to built-in asserts:\n`);
  for (const cand of c) {
    lines.push(`  ${cand.shape.slice(0, 12)}…  axis=${cand.axis}`);
    lines.push(`    scenarios: ${cand.scenarioCount}    runs: ${cand.runCount}    last: ${cand.lastSeen.toISOString()}`);
    lines.push(`    example:  ${truncate(cand.exampleClaim, 100)}`);
    lines.push('');
  }
  lines.push('To promote one, run:  pnpm llm-test promote --shape <full-hash>');
  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
