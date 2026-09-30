/**
 * File-index cap probe CLI (memory-backend-benchmark P-010, D-004).
 *
 *   npx tsx packages/operator-core/lib/memory/bench/index-cap-cli.ts \
 *     [--sizes 1000,10000] [--no-real-projector]
 *
 * Pure-FS probe — no PG, no embedder, no LLM. Seeds temp-dir claude-file
 * stores (real corpus + deterministic synthetic distractors) and records
 * the MEMORY.md projection behavior at each size: what fits the index,
 * what one compaction pass would archive (and thereby remove from the
 * searchable store). Artifacts land under .papercusp/bench-reports/.
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadCorpusFixture } from './corpus';
import { probeIndexCap } from './index-cap';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const sizes = argValue('--sizes')
  ?.split(',')
  .map((s) => Number.parseInt(s, 10))
  .filter((n) => Number.isFinite(n) && n > 0) ?? [1000, 10000];
const noReal = process.argv.includes('--no-real-projector');

const corpus = loadCorpusFixture();
const report = await probeIndexCap({
  corpus,
  sizes,
  ...(noReal ? { projectorScript: null } : {}),
  log: (m) => console.log(new Date().toISOString().slice(11, 19), m),
});

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '..');
const dir = path.join(repoRoot, '.papercusp', 'bench-reports');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const json = path.join(dir, `index-cap-${stamp}.json`);
const md = path.join(dir, `index-cap-${stamp}.md`);
fs.writeFileSync(json, JSON.stringify(report, null, 2) + '\n', 'utf8');
fs.writeFileSync(md, `# file-index cap probe — ${stamp}\n\ncorpus ${report.corpusSize} entries\n\n${report.markdown}\n`, 'utf8');

console.log('\n' + report.markdown + '\n');
console.log('wrote', json);
console.log('wrote', md);
