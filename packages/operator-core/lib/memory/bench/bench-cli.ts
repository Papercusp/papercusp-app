/**
 * memory-backend benchmark CLI (memory-backend-benchmark P-006/P-007).
 *
 *   npx tsx packages/operator-core/lib/memory/bench/bench-cli.ts \
 *     [--backends mem0,claude-file,noop] [--scale 1000,10000] \
 *     [--seed-concurrency 8] [--keep]
 *
 * Needs: PG reachable (the memory host's admin URL) with pgvector for
 * the mem0 leg, and a working embedder key (OpenAI) — the claude-file
 * and noop legs run without either. Artifacts land under
 * .papercusp/bench-reports/.
 */
import path from 'node:path';

import { runBench, type BenchBackendName, writeBenchReport } from './run-bench';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const backends = (argValue('--backends')?.split(',') as BenchBackendName[] | undefined) ?? undefined;
const scaleSizes = argValue('--scale')
  ?.split(',')
  .map((s) => Number.parseInt(s, 10))
  .filter((n) => Number.isFinite(n) && n > 0);
const seedConcurrency = argValue('--seed-concurrency')
  ? Number.parseInt(argValue('--seed-concurrency')!, 10)
  : undefined;
const keep = process.argv.includes('--keep');

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '..');

const report = await runBench({
  ...(backends ? { backends } : {}),
  ...(scaleSizes && scaleSizes.length ? { scaleSizes } : {}),
  ...(seedConcurrency ? { seedConcurrency } : {}),
  keep,
  log: (m) => console.log(new Date().toISOString().slice(11, 19), m),
});

const files = writeBenchReport(report, repoRoot);
console.log('\n' + report.scorecardMarkdown + '\n');
for (const note of report.notes) console.log('note:', note);
console.log('\nwrote', files.json);
console.log('wrote', files.md);
process.exit(0);
