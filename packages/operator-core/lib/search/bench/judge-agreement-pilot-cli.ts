/**
 * judge-agreement-pilot-cli.ts — runs P-038's judge-agreement pilot against the
 * derived gold set (plan semantic-search-fingerprint-coverage-2026-08-03,
 * D-077 §3 / WI-37638).
 *
 * Reuses D-076's construction verbatim via `ref-expansion-gold.ts` — the gold
 * is NOT re-derived here. Read `judge-agreement.ts`'s header for what the three
 * reported numbers do and do not mean before quoting any of them.
 *
 * Needs: PG reachable + a judge LLM transport (a Claude OAuth session or
 * ANTHROPIC_API_KEY). It does NOT need the embedder — judging a (query,
 * document) pair involves no retrieval, so the embed sidecar stays untouched.
 *
 * READ-ONLY against PG: it selects. It writes nothing, anywhere.
 *
 *   npx tsx packages/operator-core/lib/search/bench/judge-agreement-pilot-cli.ts
 *   npx tsx ... --queries 12 --docs 300 --harness papercusp --self-consistency 8
 *   npx tsx ... --dry-run          # build + print the pairs, spend nothing
 */
import fs from 'node:fs';

import { getOrgPg } from '@papercusp/db-org';

import { llmCall } from '../../llm-testing/llm-client';
import { buildGoldQueries, buildPool, sampleSql, type SampledRow } from './ref-expansion-gold';
import { buildPairsForQuery, formatReport, runJudgeAgreement } from './judge-agreement';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function argInt(name: string, fallback: number): number {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

async function main(): Promise<void> {
  const docsWanted = argInt('--docs', 300);
  const queriesWanted = argInt('--queries', 12);
  const selfConsistencyN = argInt('--self-consistency', 8);
  const harness = argValue('--harness');
  const dryRun = process.argv.includes('--dry-run');

  const { sql } = getOrgPg();
  // Treated fraction is ~34%, so oversample candidates to land `docsWanted`.
  // Default to a FIXED seed: this run is compared to earlier ones, so the
  // sample is part of the frozen contract (`--seed random` opts back out).
  const seedArg = argValue('--seed') ?? 'p038-pilot-v1';
  const seed = seedArg === 'random' ? undefined : seedArg;
  const rows = await sql.unsafe<SampledRow[]>(
    sampleSql(docsWanted * 4, docsWanted, harness, seed),
  );
  const pool = buildPool(rows);
  const queries = buildGoldQueries(rows, queriesWanted);
  if (pool.length === 0 || queries.length === 0) {
    console.error(
      `[judge-agreement] nothing to measure — pool=${pool.length} queries=${queries.length}`,
    );
    process.exitCode = 1;
    return;
  }

  const pairs = queries.flatMap((q) => buildPairsForQuery(q, pool));
  console.log(
    `[judge-agreement] pool=${pool.length} queries=${queries.length} pairs=${pairs.length} ` +
      `(2 arms x {pos,neg}) + ${selfConsistencyN} re-judged`,
  );

  if (dryRun) {
    for (const p of pairs.slice(0, 8)) {
      console.log(
        `\n--- ${p.pairId} gold=${p.goldRelevant ? 'RELEVANT' : 'irrelevant'}\n` +
          `query: ${p.query}\ndoc(${p.docId}): ${p.docText.slice(0, 220).replace(/\s+/g, ' ')}…`,
      );
    }
    console.log(`\n[judge-agreement] --dry-run: no judge calls made, nothing spent.`);
    return;
  }

  const report = await runJudgeAgreement({
    pairs,
    llm: llmCall,
    selfConsistencyN,
    log: (m) => console.log(new Date().toISOString().slice(11, 19), m),
  });

  // Persist EVERY per-pair row, not just the aggregates. Sensitivity cannot say
  // whether a miss landed just under the bar or at the floor, and the judge's
  // own rationale on a low-scored gold positive is the only material that can
  // adjudicate judge-error vs a citation that was never topical. Re-deriving
  // that means paying for the whole run again.
  const out = argValue('--out') ?? `/tmp/claude-1000/p038-judge-pilot-${Date.now()}.json`;
  fs.writeFileSync(out, JSON.stringify(report, null, 2));

  console.log('\n' + formatReport(report) + '\n');
  console.log(`wrote full per-pair record: ${out}`);
}

await main();
process.exit(0);
