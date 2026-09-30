/**
 * CLI to ingest AgentsNet results/*.json into the reproducibility store as
 * suite='agentsnet' rows (plan benchmark-suite-agentsnet-2026-06-17, P-004).
 * Idempotent — safe to re-run as the pilot accumulates more instances.
 *
 *   npx tsx packages/operator-core/lib/external-bench/agentsnet-ingest-cli.ts \
 *     [resultsDir] [runId] [arm] [workspaceId]
 *
 * Needs the score column (migration 302) applied to the target DB.
 */
import { resolveBenchWorkspace } from './bench-workspace';
import { ingestAgentsnetResults } from './agentsnet-ingest';
import { listSuites, listRunResults } from './reproducibility/store';
import type { ArmId } from '@papercusp/bench-metrics';

async function main() {
  const resultsDir = process.argv[2] || `${process.env.HOME}/.papercusp/bench-harnesses/agentsnet/results`;
  const runId = process.argv[3] || 'agentsnet-pilot-2026-06-17';
  const arm = (process.argv[4] as ArmId) || 'baseline-b-native';
  const workspaceId = resolveBenchWorkspace(process.argv[5]);

  const res = await ingestAgentsnetResults({
    resultsDir,
    runId,
    arm,
    modelId: 'claude-opus-4-8',
    harnessVersion: 'agentsnet@vendored-2026-06-17',
    label: 'AgentsNet (opus-as-nodes, route A)',
    workspaceId,
  });
  console.log(`[ingest] ${res.ingested} rows, runId=${res.runId}, prereg=${res.preregHash.slice(0, 12)}`);

  const rows = await listRunResults({ runId, suite: 'agentsnet', workspaceId });
  const scored = rows.filter((r) => r.resolved !== null);
  const binary = scored.length ? scored.filter((r) => r.resolved).length / scored.length : 0;
  const cont = scored.length ? scored.reduce((s, r) => s + (r.score ?? 0), 0) / scored.length : 0;
  console.log(`[ingest] rows=${rows.length} scored=${scored.length} binary=${binary.toFixed(4)} continuous=${cont.toFixed(4)}`);

  const suites = await listSuites({ runId, workspaceId });
  console.log('[ingest] suite scoreboard:', JSON.stringify(suites.find((s) => s.suite === 'agentsnet')));
  process.exit(0);
}

main().catch((e) => {
  console.error('[ingest] FAILED:', e);
  process.exit(1);
});
