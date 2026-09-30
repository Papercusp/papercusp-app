/**
 * Hybrid fusion 2D sweep (memory-backend-improve-and-hybrid P-031 / D-006).
 *
 *   npx tsx packages/operator-core/lib/memory/bench/fusion-sweep-cli.ts
 *
 * Seeds ONE shared store (claude-file lexical leg + mem0 cosine leg) with the
 * frozen corpus, then sweeps the fusion config — mode × minLexScore × minScore —
 * over the frozen gold set, reporting per config: FP@5 (hard-neg), R@10,
 * exact-identifier MRR (the column the hybrid must capture, ~0.99 ceiling), and
 * a query-level F1. The point: find the config that captures exact-id AND keeps
 * the precision/recall tradeoff sane, then lock it. Needs PG + an embedder key.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ClaudeFileMemoryBackend, Mem0Backend, HybridBackend } from '@papercusp/memory';
import { seedCorpus, runGoldSet, queryLevelPRF } from '@papercusp/memory/bench';

import { benchPgClient, releaseBenchSchema, ensureBenchSchema, setupBenchMemoryHost } from './bench-host';
import { loadCorpusFixture } from './corpus';
import { loadGoldSetFixture } from './gold-set';

interface Config {
  label: string;
  mode: 'floored-union' | 'cosine-gated';
  minLexScore?: number;
  minScore: number;
}

const CONFIGS: Config[] = [
  // cosine-gated baseline (lexical re-ranks only, never admits) — recall capped at cosine.
  { label: 'gated@0.40', mode: 'cosine-gated', minScore: 0.4 },
  { label: 'gated@0.45', mode: 'cosine-gated', minScore: 0.45 },
  // floored-union: admit lexical-only hits above the bar (captures exact-id).
  { label: 'union lex0.30@0.40', mode: 'floored-union', minLexScore: 0.3, minScore: 0.4 },
  { label: 'union lex0.30@0.45', mode: 'floored-union', minLexScore: 0.3, minScore: 0.45 },
  { label: 'union lex0.40@0.40', mode: 'floored-union', minLexScore: 0.4, minScore: 0.4 },
  { label: 'union lex0.40@0.45', mode: 'floored-union', minLexScore: 0.4, minScore: 0.45 },
];

const log = (m: string) => console.log(new Date().toISOString().slice(11, 19), m);

async function main() {
  setupBenchMemoryHost();
  const pg = await benchPgClient();
  await ensureBenchSchema(pg);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-sweep-'));
  const lexical = new ClaudeFileMemoryBackend({ memoryDir: dir, createIfMissing: true });
  const cosine = new Mem0Backend();
  const seeder = new HybridBackend(lexical, cosine);

  const corpus = loadCorpusFixture();
  const gold = loadGoldSetFixture().queries;

  try {
    log(`seeding ${corpus.length} corpus entries into both legs…`);
    await seedCorpus(seeder, corpus, { scope: 'bench', verbatim: true, concurrency: 8 });

    const rows: string[] = [];
    rows.push('| config | FP@5 | R@10 | exact-id MRR | lexgap MRR | precision | recall | F1 |');
    rows.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    const results: Array<{ cfg: Config; f1: number; exactId: number; fp: number; r10: number }> = [];

    for (const cfg of CONFIGS) {
      const hybrid = new HybridBackend(lexical, cosine, {
        fusionMode: cfg.mode,
        ...(cfg.minLexScore !== undefined ? { minLexScore: cfg.minLexScore } : {}),
      });
      const res = await runGoldSet(hybrid, gold, {
        scope: 'bench',
        limit: 10,
        minScore: cfg.minScore,
        minLexScore: cfg.minLexScore,
        fusionMode: cfg.mode,
      });
      const prf = queryLevelPRF(res.perQuery, 5);
      const fp = res.byClass['hard-negative']?.fpAt5 ?? 0;
      const exactId = res.byClass['exact-identifier']?.mrr ?? 0;
      const lexgap = res.byClass['lexical-gap']?.mrr ?? 0;
      results.push({ cfg, f1: prf.f1, exactId, fp, r10: res.overall.r10 });
      rows.push(
        `| ${cfg.label} | ${(fp * 100).toFixed(0)}% | ${(res.overall.r10 * 100).toFixed(0)}% | ${exactId.toFixed(2)} | ` +
          `${lexgap.toFixed(2)} | ${prf.precision.toFixed(2)} | ${prf.recall.toFixed(2)} | ${prf.f1.toFixed(3)} |`,
      );
      log(`  ${cfg.label}: F1=${prf.f1.toFixed(3)} exactId=${exactId.toFixed(2)} FP@5=${(fp * 100).toFixed(0)}% R@10=${(res.overall.r10 * 100).toFixed(0)}%`);
    }

    const byF1 = [...results].sort((a, b) => b.f1 - a.f1);
    const best = byF1[0];
    const md =
      `# Hybrid fusion 2D sweep — ${new Date().toISOString()}\n\ncorpus ${corpus.length} · gold ${gold.length}\n\n` +
      rows.join('\n') +
      `\n\n**Best F1: ${best.cfg.label}** (F1 ${best.f1.toFixed(3)}, exact-id MRR ${best.exactId.toFixed(2)}, FP@5 ${(best.fp * 100).toFixed(0)}%, R@10 ${(best.r10 * 100).toFixed(0)}%).\n`;

    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '..');
    const outDir = path.join(repoRoot, '.papercusp', 'bench-reports');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const mdPath = path.join(outDir, `fusion-sweep-${stamp}.md`);
    fs.writeFileSync(mdPath, md, 'utf8');
    console.log('\n' + md + '\nwrote ' + mdPath);
  } finally {
    await releaseBenchSchema(pg);
    await pg.end();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
