/**
 * The live memory-backend benchmark runner (memory-backend-benchmark
 * P-006, D-001/D-002/D-009): seeds the frozen real corpus into each
 * backend through the seam, replays the frozen gold set, runs the
 * write round-trips and durability probes, captures latency + cost,
 * and assembles one scorecard per backend.
 *
 * The runner DECIDES NOTHING (D-006) — it emits measurements; the
 * revive-vs-retire call is the owner's.
 *
 * Isolation (D-009): mem0 runs in the `bench_memory` PG schema
 * (created/dropped here); claude-file runs on a temp-dir copy seeded
 * through the seam; the live `harness_shared.memory_*` tables and the
 * real ~/.claude store are never written.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ClaudeFileMemoryBackend,
  Mem0Backend,
  NoopBackend,
  HybridBackend,
  LexicalLegBackend,
  invalidateMemoryClient,
  disposeMemoryClient,
  type MemoryBackend,
} from '@papercusp/memory';
import {
  generateSyntheticCorpus,
  rememberP50,
  renderScorecardMarkdown,
  runGoldSet,
  runRoundtrips,
  seedCorpus,
  type BackendScorecard,
  type CorpusEntry,
  type GoldQuery,
  type SeedManifest,
} from '@papercusp/memory/bench';

import { benchPgClient, dropBenchSchema, ensureBenchSchema, setupBenchMemoryHost } from './bench-host';
import { loadCorpusFixture } from './corpus';
import { loadGoldSetFixture } from './gold-set';
import {
  COST_METHODOLOGY,
  costPer1kRemembers,
  costPer1kSearches,
} from './cost-model';
import { ROUNDTRIP_SPECS } from './roundtrip-specs';

export const BENCH_SCOPE = 'bench';
export type BenchBackendName = 'mem0' | 'claude-file' | 'noop' | 'hybrid' | 'hybrid-pg' | 'claude-loaded-index';

export interface BenchRunOptions {
  /** Which backends to bench (default all three). */
  backends?: BenchBackendName[];
  corpusVersion?: string;
  goldVersion?: string;
  /**
   * Scale-tier corpus sizes (TOTAL store size incl. the real corpus,
   * e.g. [1000, 10000]). Empty = no scale tier. Synthetic distractors
   * are deterministic (seeded PRNG) per D-004.
   */
  scaleSizes?: number[];
  /** Parallel remember() calls while seeding (default 8). */
  seedConcurrency?: number;
  /** Skip cleanup (leave the seeded stores for inspection). */
  keep?: boolean;
  log?: (msg: string) => void;
}

export interface BenchRunReport {
  startedAt: string;
  finishedAt: string;
  corpusVersion: string;
  goldVersion: string;
  corpusSize: number;
  goldSize: number;
  costMethodology: string;
  notes: string[];
  cards: BackendScorecard[];
  scorecardMarkdown: string;
}

export interface BackendCtx {
  backend: MemoryBackend;
  /** Build a FRESH instance over the same store (restart-survival probe). */
  reinstantiate: () => MemoryBackend;
  cleanup: () => Promise<void>;
  /** Static reach rows (D-004); measured rows are appended by the run. */
  reach: Record<string, string>;
  /** Cost-model traits. */
  embeds: boolean;
  extractionOnRemember: boolean;
}

/** Exported for the T3 judged tier (./judged), which seeds the same isolated contexts. */
export async function makeBackendCtx(name: BenchBackendName, keep: boolean): Promise<BackendCtx> {
  if (name === 'mem0') {
    setupBenchMemoryHost();
    const pg = await benchPgClient();
    await ensureBenchSchema(pg);
    return {
      backend: new Mem0Backend(),
      reinstantiate: () => {
        invalidateMemoryClient(); // force a full client rebuild over the same PG store
        return new Mem0Backend();
      },
      cleanup: async () => {
        // AWAIT the mem0 client's PG pool closure BEFORE the drop — a live
        // pooled connection holds locks on bench tables and 55P03s the
        // DROP (fire-and-forget invalidate still raced it; killed a run).
        await disposeMemoryClient();
        if (!keep) await dropBenchSchema(pg);
        await pg.end();
      },
      reach: {
        'readable from codex/omp/operator/memory-tab': 'yes — any process with PG access (PG-backed)',
        'concurrent multi-agent writes': 'yes — PG row-per-fact, no shared index file',
        'restart survival': 'yes — Postgres',
        requires: 'PG + pgvector, embedder key (OpenAI) or local model, LLM key for extraction',
      },
      embeds: true,
      extractionOnRemember: true,
    };
  }
  if (name === 'claude-file') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-bench-claude-'));
    return {
      backend: new ClaudeFileMemoryBackend({ memoryDir: dir, createIfMissing: true }),
      reinstantiate: () => new ClaudeFileMemoryBackend({ memoryDir: dir, createIfMissing: true }),
      cleanup: async () => {
        if (!keep) fs.rmSync(dir, { recursive: true, force: true });
      },
      reach: {
        'readable from codex/omp/operator/memory-tab':
          'FS-local only — processes on the same box reading ~/.claude (operator via the claude-file backend; codex/omp read the files natively)',
        'concurrent multi-agent writes': 'file-per-fact, last-write-wins per file; index regen is single-writer (SessionStart hook)',
        'restart survival': 'yes — plain files',
        requires: 'nothing (no keys, no DB); MEMORY.md index soft-cap 20KB / hard ~24.4KB already hit once',
      },
      embeds: false,
      extractionOnRemember: false,
    };
  }
  if (name === 'hybrid') {
    // The hybrid fuses a LEXICAL leg (claude-file temp dir — exact-id) and a
    // COSINE leg (mem0 over the bench PG schema — paraphrase). HybridBackend
    // write-throughs each seed to BOTH legs, so the standard seedCorpus path
    // populates both; search then fuses (cosine-gated RRF + the FP floor).
    setupBenchMemoryHost();
    const pg = await benchPgClient();
    await ensureBenchSchema(pg);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-bench-hybrid-'));
    const make = () =>
      new HybridBackend(
        new ClaudeFileMemoryBackend({ memoryDir: dir, createIfMissing: true }),
        new Mem0Backend(),
      );
    return {
      backend: make(),
      reinstantiate: () => {
        invalidateMemoryClient(); // rebuild the mem0 client over the same PG store
        return make();
      },
      cleanup: async () => {
        // Awaited pool-close before drop — same 55P03 protection as the mem0 ctx.
        await disposeMemoryClient();
        if (!keep) {
          await dropBenchSchema(pg);
          fs.rmSync(dir, { recursive: true, force: true });
        }
        await pg.end();
      },
      reach: {
        'readable from codex/omp/operator/memory-tab':
          'yes — canonical writes land in PG (cosine leg); the lexical claude-file leg is a write-through projection for exact-id recall',
        'concurrent multi-agent writes': 'yes — PG row-per-fact (canonical); lexical projection is best-effort per-file',
        'restart survival': 'yes — Postgres (canonical) + plain files (projection)',
        requires: 'PG + pgvector + embedder key (cosine leg); nothing for the lexical leg',
      },
      embeds: true,
      extractionOnRemember: true,
    };
  }
  if (name === 'hybrid-pg') {
    // The SELF-OWNED hybrid (memory-pg-lexical-own-injection-2026-07-13
    // P-003): BOTH legs over the ONE bench PG schema — the lexical leg is
    // canonical-store lexicalSearch (field-weighted token match, P-002)
    // presented via LexicalLegBackend (its remember() is a no-op: the cosine
    // leg's write already landed the shared row, so the hybrid write-through
    // cannot double-write), the cosine leg the same SHARED Mem0Backend. No
    // temp dir, no claude-file projection, no ~/.claude dependency.
    setupBenchMemoryHost();
    const pg = await benchPgClient();
    await ensureBenchSchema(pg);
    const make = () => {
      const mem0 = new Mem0Backend();
      return new HybridBackend(new LexicalLegBackend(mem0), mem0, { name: 'hybrid-pg' });
    };
    return {
      backend: make(),
      reinstantiate: () => {
        invalidateMemoryClient(); // rebuild the mem0 client over the same PG store
        return make();
      },
      cleanup: async () => {
        // Awaited pool-close before drop — same 55P03 protection as the mem0 ctx.
        await disposeMemoryClient();
        if (!keep) await dropBenchSchema(pg);
        await pg.end();
      },
      reach: {
        'readable from codex/omp/operator/memory-tab':
          'yes — ONE canonical PG store; both legs are rankings over the same rows (no projection)',
        'concurrent multi-agent writes': 'yes — PG row-per-fact; no shared index file, no per-file projection',
        'restart survival': 'yes — Postgres',
        requires: 'PG + pgvector; embedder key for the cosine leg only (the lexical leg is embed-free)',
      },
      embeds: true,
      extractionOnRemember: true,
    };
  }
  if (name === 'claude-loaded-index') {
    // The load-all-runtime model (P-012): writes land in a temp-dir claude-file
    // store; search renders the FULL index and lets an LLM pick — the actual
    // mechanism of the live always-loaded MEMORY.md, vs the claude-file
    // backend's lexical search. LLM transport lazy-imported so the plain
    // backends don't pay the llm-testing import.
    const { llmCall } = await import('../../llm-testing/llm-client');
    const { ClaudeLoadedIndexBackend, LOADED_INDEX_MODEL } = await import('./loaded-index-backend');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-bench-loaded-idx-'));
    const make = () =>
      new ClaudeLoadedIndexBackend(
        new ClaudeFileMemoryBackend({ memoryDir: dir, createIfMissing: true }),
        llmCall,
      );
    return {
      backend: make(),
      reinstantiate: make,
      cleanup: async () => {
        if (!keep) fs.rmSync(dir, { recursive: true, force: true });
      },
      reach: {
        'readable from codex/omp/operator/memory-tab':
          'FS-local only — same store as claude-file; this backend differs only in HOW recall happens',
        'concurrent multi-agent writes': 'file-per-fact, last-write-wins per file (same as claude-file)',
        'restart survival': 'yes — plain files',
        requires:
          `an LLM per search (${LOADED_INDEX_MODEL}; the live analogue is the main model reading the ` +
          'loaded index at $0 marginal in-context) — cost rows below EXCLUDE that call',
      },
      embeds: false,
      extractionOnRemember: false,
    };
  }
  return {
    backend: new NoopBackend(),
    reinstantiate: () => new NoopBackend(),
    cleanup: async () => {},
    reach: { control: 'noop — the D-001 control; any non-zero metric here is a bench bug' },
    embeds: false,
    extractionOnRemember: false,
  };
}

/** Durability probes → measured reach rows. */
async function durabilityProbes(
  ctx: BackendCtx,
  corpusGold: readonly GoldQuery[],
): Promise<Record<string, string>> {
  const rows: Record<string, string> = {};
  // Concurrent writers: 12 parallel verbatim writes must all persist.
  const texts = Array.from({ length: 12 }, (_, i) => `bench concurrent-write probe ${i} kestrel-meridian-${i}`);
  try {
    const results = await Promise.all(
      texts.map((t, i) =>
        ctx.backend.remember(t, { scope: BENCH_SCOPE, verbatim: true, metadata: { probe: `conc_${i}` } }),
      ),
    );
    const stored = results.filter((r) => (r.storedEvents ?? r.ids.length) > 0).length;
    rows['measured: 12 concurrent writes'] = `${stored}/12 persisted`;
    for (const r of results) for (const id of r.ids) await ctx.backend.forget(id).catch(() => {});
  } catch (e) {
    rows['measured: 12 concurrent writes'] = `threw: ${(e as Error).message.slice(0, 80)}`;
  }
  // Reinstantiation: a FRESH instance over the same store still serves the corpus.
  try {
    const fresh = ctx.reinstantiate();
    const probe = corpusGold.find((q) => q.class === 'exact-identifier') ?? corpusGold[0];
    const hits = probe ? await fresh.search(probe.query, { scope: BENCH_SCOPE, limit: 5 }) : [];
    rows['measured: fresh-instance recall (restart analogue)'] = hits.length > 0 ? `yes (${hits.length} hits)` : 'NO HITS';
  } catch (e) {
    rows['measured: fresh-instance recall (restart analogue)'] = `threw: ${(e as Error).message.slice(0, 80)}`;
  }
  return rows;
}

async function benchOne(
  name: BenchBackendName,
  corpus: readonly CorpusEntry[],
  gold: readonly GoldQuery[],
  opts: BenchRunOptions,
  notes: string[],
): Promise<BackendScorecard> {
  const log = opts.log ?? (() => {});
  const ctx = await makeBackendCtx(name, opts.keep ?? false);
  const manifests: SeedManifest[] = [];
  try {
    log(`[${name}] seeding ${corpus.length} entries…`);
    const manifest = await seedCorpus(ctx.backend, corpus, {
      scope: BENCH_SCOPE,
      verbatim: true,
      concurrency: opts.seedConcurrency ?? 8,
    });
    manifests.push(manifest);
    if (manifest.failed.length > 0) {
      notes.push(`[${name}] seed failures: ${manifest.failed.length}/${corpus.length} (${manifest.failed.slice(0, 5).join(', ')}…)`);
    }

    log(`[${name}] replaying ${gold.length} gold queries…`);
    const retrieval = await runGoldSet(ctx.backend, gold, { scope: BENCH_SCOPE, limit: 10, concurrency: 4 });

    log(`[${name}] write round-trips…`);
    const roundtrips = await runRoundtrips(ctx.backend, ROUNDTRIP_SPECS, { scope: BENCH_SCOPE });

    log(`[${name}] durability probes…`);
    const measuredReach = await durabilityProbes(ctx, gold);

    // Scale tier: cumulative synthetic distractors, gold replayed per size.
    const scale: BackendScorecard['scale'] = [];
    if ((opts.scaleSizes?.length ?? 0) > 0 && name !== 'noop') {
      scale.push({
        size: corpus.length,
        p5: retrieval.overall.p5,
        mrr: retrieval.overall.mrr,
        searchP50Ms: retrieval.latency.p50,
      });
      let current = corpus.length;
      for (const target of [...(opts.scaleSizes ?? [])].sort((a, b) => a - b)) {
        const delta = target - current;
        if (delta <= 0) continue;
        log(`[${name}] scale: seeding ${delta} synthetic distractors → ${target}…`);
        const synthetic = generateSyntheticCorpus(delta, 1337 + current);
        const m = await seedCorpus(ctx.backend, synthetic, {
          scope: BENCH_SCOPE,
          verbatim: true,
          concurrency: opts.seedConcurrency ?? 8,
        });
        manifests.push(m);
        current = target;
        log(`[${name}] scale: replaying gold @${target}…`);
        const r = await runGoldSet(ctx.backend, gold, { scope: BENCH_SCOPE, limit: 10, concurrency: 4 });
        scale.push({ size: target, p5: r.overall.p5, mrr: r.overall.mrr, searchP50Ms: r.latency.p50 });
      }
    }

    const avgRememberChars = manifests[0].totalChars / Math.max(1, corpus.length);
    const avgSearchChars = gold.reduce((a, q) => a + q.query.length, 0) / Math.max(1, gold.length);
    const costInputs = {
      avgRememberChars,
      avgSearchChars,
      extractionOnRemember: ctx.extractionOnRemember,
      embeds: ctx.embeds,
    };

    return {
      // The REQUESTED bench name. This used to be load-bearing: both hybrid
      // variants reported the class's hardcoded 'hybrid', which printed two
      // identical "hybrid" scorecard columns in the 2026-07-13 run. That is
      // fixed at the source now (HybridBackend takes its name from opts —
      // memory-declaude-and-defaults-2026-07-28 P-003), so this is merely the
      // more direct expression of the same value, not a workaround.
      backend: name,
      seeded: corpus.length,
      seedFailed: manifests[0].failed.length,
      retrieval,
      roundtrips,
      rememberP50Ms: rememberP50(manifests[0].rememberMs),
      costPer1kRemembers: costPer1kRemembers(costInputs),
      costPer1kSearches: costPer1kSearches(costInputs),
      ...(scale && scale.length > 0 ? { scale } : {}),
      reach: { ...ctx.reach, ...measuredReach },
      ops: {
        remembers: manifests.reduce((a, m) => a + Object.keys(m.ids).length, 0),
        searches: gold.length * (1 + (scale?.length ? scale.length - 1 : 0)),
        totalCharsWritten: manifests.reduce((a, m) => a + m.totalChars, 0),
        totalCharsQueried: Math.round(avgSearchChars * gold.length),
      },
    };
  } finally {
    log(`[${name}] cleanup…`);
    // A cleanup failure must never destroy the run's measurements — the
    // report only writes after ALL backends complete.
    try {
      await ctx.cleanup();
    } catch (e) {
      const msg = (e as Error).message.slice(0, 120);
      notes.push(`[${name}] cleanup failed (non-fatal): ${msg}`);
      log(`[${name}] cleanup FAILED (non-fatal): ${msg}`);
    }
  }
}

/** Run the full benchmark; returns the report (caller persists it). */
export async function runBench(opts: BenchRunOptions = {}): Promise<BenchRunReport> {
  const startedAt = new Date().toISOString();
  const corpusVersion = opts.corpusVersion ?? 'v1';
  const goldVersion = opts.goldVersion ?? 'v1';
  const corpus = loadCorpusFixture(corpusVersion);
  const goldFixture = loadGoldSetFixture(goldVersion);
  const gold = goldFixture.queries;
  const backends = opts.backends ?? (['mem0', 'claude-file', 'hybrid', 'hybrid-pg', 'noop'] as BenchBackendName[]);
  const notes: string[] = [];

  const cards: BackendScorecard[] = [];
  for (const name of backends) {
    cards.push(await benchOne(name, corpus, gold, opts, notes));
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    corpusVersion,
    goldVersion,
    corpusSize: corpus.length,
    goldSize: gold.length,
    costMethodology: COST_METHODOLOGY,
    notes,
    cards,
    scorecardMarkdown: renderScorecardMarkdown(cards),
  };
}

/** Persist a report under .papercusp/bench-reports/ (repo-relative). */
export function writeBenchReport(report: BenchRunReport, repoRoot: string): { json: string; md: string } {
  const dir = path.join(repoRoot, '.papercusp', 'bench-reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const json = path.join(dir, `memory-bench-${stamp}.json`);
  const md = path.join(dir, `memory-bench-${stamp}.md`);
  fs.writeFileSync(json, JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(
    md,
    `# memory-backend benchmark — ${report.startedAt}\n\n` +
      `corpus ${report.corpusVersion} (${report.corpusSize} entries) · gold ${report.goldVersion} (${report.goldSize} queries)\n\n` +
      report.scorecardMarkdown +
      '\n\n## Notes\n' +
      (report.notes.length ? report.notes.map((n) => `- ${n}`).join('\n') : '- none') +
      `\n\n## Cost methodology\n${report.costMethodology}\n`,
    'utf8',
  );
  return { json, md };
}
