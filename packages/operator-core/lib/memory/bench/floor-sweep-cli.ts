/**
 * FP-floor sweep CLI (memory-backend-improve-and-hybrid P-031 / D-006).
 *
 *   npx tsx packages/operator-core/lib/memory/bench/floor-sweep-cli.ts \
 *     [--backend hybrid|mem0] [--floors 0,0.40,0.42,0.45,0.48] [--seed-concurrency 8]
 *
 * Seeds ONE store (default the hybrid) with the frozen real corpus, then replays
 * the frozen gold set at each candidate floor (a search-time param — no re-seed),
 * reporting FP@5 / R@10 / MRR / exact-id MRR / query-level F1 per floor and the
 * F1-max value to lock as the default. Needs PG + an embedder key (the cosine leg).
 * Artifacts land under .papercusp/bench-reports/.
 */
import fs from 'node:fs';
import path from 'node:path';

import { runFloorSweep, renderFloorSweepMarkdown, seedCorpus, seedFailureReason } from '@papercusp/memory/bench';

import { pushSearchFloors } from '../injection';
import { makeBackendCtx, BENCH_SCOPE, type BenchBackendName } from './run-bench';
import { loadCorpusFixture } from './corpus';
import { loadGoldSetFixture } from './gold-set';

const pushFloors = pushSearchFloors();

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/**
 * P-050 (D-057): defaults re-pointed at the PRODUCTION push path.
 *
 * Two things about the previous defaults made a run actively misleading rather
 * than merely narrow, and both were invisible in the output:
 *
 *  1. `--backend hybrid` is the claude-file+mem0 wiring. Production is
 *     **hybrid-pg** (both legs over one PG store), which is what D-056 measured.
 *  2. The sweep inherited the backend's `floored-union` default, where the
 *     lexical leg admits independently of `minScore` — so raising the floor just
 *     frees slots the lexical leg backfills (D-008). The production PUSH path is
 *     `cosine-gated`. A floor swept under the wrong mode does not transfer.
 *
 * The mode + lexical bar now come from `pushSearchFloors()` — the SAME
 * constructor `buildBlockInner` runs — so this instrument cannot drift from the
 * path it is calibrating (the failure `bench/precision-monitor.ts` still shows).
 *
 * The floor GRID also had to move: every old candidate except 0.48 sits BELOW
 * the measured hard-negative minimum (0.4658), so the old sweep could not have
 * rejected a single off-topic query at any point on its own grid.
 */
const backend = (argValue('--backend') as BenchBackendName | undefined) ?? 'hybrid-pg';
const floors = (argValue('--floors')?.split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 0))
  ?? [0, 0.45, 0.5, 0.52, 0.55, 0.58, 0.6, 0.62, 0.65];
const seedConcurrency = argValue('--seed-concurrency') ? Number.parseInt(argValue('--seed-concurrency')!, 10) : 8;
const keep = process.argv.includes('--keep');
const log = (m: string) => console.log(new Date().toISOString().slice(11, 19), m);

const corpus = loadCorpusFixture();
const gold = loadGoldSetFixture().queries;

const ctx = await makeBackendCtx(backend, keep);
try {
  log(`[${backend}] seeding ${corpus.length} corpus entries…`);
  const seeded = await seedCorpus(ctx.backend, corpus, { scope: BENCH_SCOPE, verbatim: true, concurrency: seedConcurrency });
  // The manifest used to be discarded here, so a store that never seeded swept to
  // "every floor admits nothing" and read as a precision result (WI-10004107).
  const seedFailure = seedFailureReason(seeded, corpus.length);
  if (seedFailure) throw new Error(`${seedFailure} — refusing to sweep floors over a partially seeded store`);

  log(
    `[${backend}] sweeping floors ${floors.join(', ')} over ${gold.length} gold queries ` +
      `under the LIVE push contract (fusionMode=${pushFloors.fusionMode}, ` +
      `minLexScore=${pushFloors.minLexScore ?? 'backend default'}; current floor ${pushFloors.minScore ?? 'off'})…`,
  );
  const result = await runFloorSweep(ctx.backend, gold, {
    scope: BENCH_SCOPE,
    floors,
    limit: 10,
    // The LIVE push admission contract — never a re-declared constant.
    fusionMode: pushFloors.fusionMode,
    ...(pushFloors.minLexScore !== undefined ? { minLexScore: pushFloors.minLexScore } : {}),
    onProgress: (floor, done, total) => {
      if (done === total) log(`  floor ${floor.toFixed(2)} — ${total} queries replayed`);
    },
  });

  const md = renderFloorSweepMarkdown(result);
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '..');
  const dir = path.join(repoRoot, '.papercusp', 'bench-reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(dir, `floor-sweep-${backend}-${stamp}.json`);
  const mdPath = path.join(dir, `floor-sweep-${backend}-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  fs.writeFileSync(mdPath, `# FP-floor sweep — ${backend} — ${stamp}\n\ncorpus ${corpus.length} · gold ${gold.length}\n\n${md}\n`, 'utf8');

  console.log('\n' + md + '\n');
  console.log('wrote', jsonPath);
  console.log('wrote', mdPath);
} finally {
  await ctx.cleanup();
}
process.exit(0);
