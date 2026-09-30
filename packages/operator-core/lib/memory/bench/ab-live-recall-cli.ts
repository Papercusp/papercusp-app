/**
 * ab-live-recall-cli.ts — P-006's FRESH-SAMPLE leg
 * (memory-pg-lexical-own-injection-2026-07-13): known-item recall over the
 * LIVE canonical store, A/B'd across backends. Complements the frozen-corpus
 * bench (which seeds an isolated schema): this replays queries derived from
 * REAL, RECENT memories — including the P-004 imports — through each
 * backend, read-only.
 *
 *   npx tsx packages/operator-core/lib/memory/bench/ab-live-recall-cli.ts
 *   npx tsx ... --since 2026-06-15 --pairs 40
 *
 * Reuses the EI-10047 recall-canary machinery verbatim (deriveCanaryQuery /
 * buildCanaryPairs / measureCanaryPairs — the same admission gates orient
 * runs), only the candidate sampling differs: recent rows (>= --since)
 * instead of the canary's >=7-day-old stability window.
 *
 * READ-ONLY on the memory store; writes nothing anywhere.
 */
import os from 'node:os';
import path from 'node:path';

import { Client } from 'pg';

import {
  ClaudeFileMemoryBackend,
  HybridBackend,
  LexicalLegBackend,
  Mem0Backend,
  claudeProjectMemoryDir,
  pgClientFields,
  type MemoryBackend,
} from '@papercusp/memory';
// Side-effect: wires the LIVE operator memory host (harness_shared).
import '../configure';
import { buildCanaryPairs, measureCanaryPairs, type CanaryCandidate } from './recall-canary';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const SINCE = argValue('--since') ?? '2026-06-15';
const PAIRS = argValue('--pairs') ? Number(argValue('--pairs')) : 40;

async function main(): Promise<void> {
  const pg = new Client(await pgClientFields());
  await pg.connect();
  const rows = await pg.query(
    `SELECT id, payload->>'user_id' AS scope, payload->>'data' AS text
       FROM harness_shared.memory_canonical
      WHERE state = 'active'
        AND NOT (payload ? 'entityType')
        AND payload->>'user_id' IS NOT NULL
        AND length(coalesce(payload->>'data', '')) >= 120
        AND created_at >= $1
      ORDER BY md5(id::text)
      LIMIT 200`,
    [SINCE],
  );
  await pg.end();
  const candidates: CanaryCandidate[] = rows.rows.map((r: { id: string; scope: string; text: string }) => ({
    id: String(r.id),
    scope: String(r.scope),
    text: String(r.text),
  }));
  const pairs = buildCanaryPairs(candidates, PAIRS);
  console.log(`candidates: ${candidates.length} (created >= ${SINCE}) → pairs: ${pairs.length}`);

  const claudeDir =
    process.env.PAPERCUSP_CLAUDE_MEMORY_DIR ||
    claudeProjectMemoryDir(process.env.PAPERCUSP_CLAUDE_PROJECT_DIR || os.homedir(), path.join(os.homedir(), '.claude'));
  const mem0 = new Mem0Backend();
  const backends: Record<string, MemoryBackend> = {
    mem0,
    hybrid: new HybridBackend(new ClaudeFileMemoryBackend({ memoryDir: claudeDir }), mem0),
    'hybrid-pg': new HybridBackend(new LexicalLegBackend(mem0), mem0, { name: 'hybrid-pg' }),
  };

  console.log('backend      | recall@10 (admitted) | retrieval@10 (pre-admission) | zero-hit | p50');
  for (const [name, b] of Object.entries(backends)) {
    const m = await measureCanaryPairs((q, o) => b.search(q, o), pairs);
    const pct = (n: number) => `${((n / Math.max(1, m.scored)) * 100).toFixed(0)}%`;
    console.log(
      `${name.padEnd(12)} | ${String(m.hits).padStart(3)}/${m.scored} (${pct(m.hits)})       | ` +
        `${String(m.retrievalHits).padStart(3)}/${m.scored} (${pct(m.retrievalHits)})            | ` +
        `${m.zeroHits} | ${m.latencyP50Ms ?? '-'}ms`,
    );
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
