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

import { llmCall } from '../../llm-testing/llm-client';
import { runJudgedTier, writeJudgedReport } from './judged';
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
