/**
 * T3 judged-usefulness tier CLI (memory-backend-benchmark P-008).
 *
 *   npx tsx packages/operator-core/lib/memory/bench/judged-cli.ts \
 *     [--backends mem0,claude-file,noop] [--per-class 8] \
 *     [--double-score 5] [--keep]
 *
 * Needs: PG reachable (the mem0 leg's bench schema) + a working
 * embedder key, AND a judge LLM transport (a Claude OAuth session or
 * ANTHROPIC_API_KEY) — the judge is an LLM call per sampled query per
 * backend (~25 × 3 by default + the agreement probe). Artifacts land
 * under .papercusp/bench-reports/.
 */
import path from 'node:path';

import { writeStdoutSync } from '../../../../../scripts/lib/write-stdout-sync.mjs';
import { llmCall } from '../../llm-testing/llm-client';
import { collectIndependentCohort, parseBlindTargetBudget, runJudgedTier, writeJudgedReport } from './judged';
import type { BenchBackendName } from './run-bench';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const backends = (argValue('--backends')?.split(',') as BenchBackendName[] | undefined) ?? undefined;
const perClass = argValue('--per-class') ? Number.parseInt(argValue('--per-class')!, 10) : undefined;
const doubleScoreN = argValue('--double-score')
  ? Number.parseInt(argValue('--double-score')!, 10)
  : undefined;
const keep = process.argv.includes('--keep');

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '..');

// Both label collection and judged retrieval use in-process LLM calls. Apply
// the standing gateway flag at the same seam as the maintained llm-test CLI;
// a generic shell task need not inherit the operator's gateway environment.
const { FLAGS } = await import('@papercusp/flags');
const { getFlag } = await import('@papercusp/flags/server');
const { installFlagOverrideStore } = await import('../../flag-override-store');
installFlagOverrideStore();
if (await getFlag(FLAGS.INFERENCE_GATEWAY, 'system')) {
  const { applyGatewayLlmEnv } = await import('../../inference-gateway/spawn-env');
  applyGatewayLlmEnv(true);
}

if (process.argv.includes('--label-cohort')) {
  const snapshot = argValue('--snapshot'), out = argValue('--label-out');
  if (!snapshot || !out) throw new Error('--label-cohort requires --snapshot and --label-out');
  const receipt = await collectIndependentCohort({ snapshot, out, llm: llmCall,
    ...(argValue('--reuse-authors-from') ? { reuseAuthorsFrom: argValue('--reuse-authors-from') } : {}),
    ...(argValue('--reuse-calls-from') ? { reuseCallsFrom: argValue('--reuse-calls-from') } : {}),
    ...(process.argv.includes('--reuse-snapshot-expansion') ? { reuseSnapshotExpansion: true } : {}),
    ...(argValue('--adopt-donor-owner') ? { adoptDonorOwner: argValue('--adopt-donor-owner') } : {}),
    ...(argValue('--targets-per-partition') ? { targetsPerPartition: parseBlindTargetBudget(argValue('--targets-per-partition')!) } : {}),
    log: (message) => console.log(new Date().toISOString(), message) });
  // The receipt is a data-derived JSON dump that gets piped; process.exit() does not drain an
  // async pipe write, so write it synchronously first (EI-20055889379250637).
  writeStdoutSync(JSON.stringify(receipt)); process.exit(0);
}

const report = await runJudgedTier({
  llm: llmCall,
  ...(backends ? { backends } : {}),
  ...(perClass !== undefined ? { perClass } : {}),
  ...(doubleScoreN !== undefined ? { doubleScoreN } : {}),
  keep,
  log: (m) => console.log(new Date().toISOString().slice(11, 19), m),
});

const files = writeJudgedReport(report, repoRoot);
console.log('\n' + report.markdown + '\n');
console.log('wrote', files.json);
console.log('wrote', files.md);
process.exit(0);
