/**
 * The production-shaped hybrid backend context used by the memory precision
 * worker. Keep this factory separate from run-bench.ts: that general runner
 * owns optional backends whose lazy imports are still followed by esbuild when
 * bg-host bundles runtime workers.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ClaudeFileMemoryBackend,
  Mem0Backend,
  HybridBackend,
  invalidateMemoryClient,
  disposeMemoryClient,
  type MemoryBackend,
} from '@papercusp/memory';

import { benchPgClient, releaseBenchSchema, ensureBenchSchema, setupBenchMemoryHost } from './bench-host-primitives';

export const BENCH_SCOPE = 'bench';

export interface PrecisionBenchBackendCtx {
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

/** Shared with run-bench.ts so the precision worker never imports that runner. */
export async function makeHybridBackendCtx(keep: boolean): Promise<PrecisionBenchBackendCtx> {
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
        await releaseBenchSchema(pg);
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
