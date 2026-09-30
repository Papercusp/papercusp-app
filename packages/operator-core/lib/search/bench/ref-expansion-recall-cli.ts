/**
 * ref-expansion-recall-cli.ts — P-026 / WI-37498's measurement leg
 * (plan context-injection-retrieval-reach-and-visibility-2026-08-03, D-086 §6.3).
 *
 * QUESTION: does the Tier 0 `\n\n[refs] ID: title; ...` appendix that recipe v2
 * appends to every `harness_shared.work_items` row actually make those rows more
 * RETRIEVABLE? That delta is what gates extending Tier 0 to `session_turns`.
 *
 * PAIRED OFFLINE A/B — not a before/after against the live index:
 *   - v2 text is the live bodySql (title + summary + the resolved [refs] block).
 *   - v1 text is that SAME row with the appendix removed. The v2 recipe is a
 *     pure APPEND (embed-backfill.ts, work_items TARGETS entry), so v1 text is
 *     reconstructible exactly, from current table state, at any time.
 *   - BOTH arms are embedded HERE, NOW, by `resolveBackfillEmbedder()` — the
 *     same embedder the sweep uses — so the two arms share an embedding space
 *     even if older stored vectors do not.
 *
 * ⚠ THIS MEASUREMENT IS NOT GATED ON THE embedding_recipe=2 BACKFILL DRAINING.
 *   Waiting would not make a cleaner experiment available. A genuine
 *   before/after against the live index needs a v1 baseline captured BEFORE the
 *   sweep started; none was, and the sweep overwrites `embedding` in place. So
 *   waiting yields the "after" arm with no "before" — strictly less than this.
 *
 * ⚠ STRATIFIED ON THE TREATED SET, deliberately. Only ~34% of rows carry a
 *   resolvable same-harness ref; for every other row v1 and v2 bodySql emit
 *   BYTE-IDENTICAL text. A corpus-wide average therefore dilutes the true
 *   effect ~2.9x and can report a false null — the failure mode that would
 *   wrongly kill index-side expansion.
 *
 * ⚠ READ THE RESULT AS AN UPPER BOUND, NOT AS PRODUCTION LIFT. Each query is
 *   the verbatim `left(title, 200)` of a referenced item — precisely the text
 *   v2 injects. Real queries are paraphrases, so this measures how much
 *   retrievability the injected text can confer AT BEST. That is the right
 *   shape for the gating decision (a small upper bound settles it; a large one
 *   motivates a paraphrase follow-up) but it is not an estimate of the lift a
 *   user would see.
 *
 * ⚠ RECALL IS A SET METRIC AND CANNOT SEE ORDERING. It answers "did the relevant
 *   row cross into the top k", never "where in the top k did it land". Until
 *   2026-08-10 this file imported `recallAtK` ALONE, so a treatment that moved a
 *   relevant row from rank 9 to rank 1 measured as a dead-flat zero delta — the
 *   same blind spot D-073/D-074 removed from the owner-query eval. Both are now
 *   reported (plan semantic-search-fingerprint-coverage-2026-08-03, D-075).
 *
 * ⚠ READ THE TWO NUMBERS AS COMPLEMENTS, NOT AS ONE BEING A SUPERSET.
 *   `ndcgAtK` normalises against the ideal ordering OF THE GRADES IT WAS GIVEN
 *   (metrics.ts: `const ideal = [...grades].sort()`), i.e. of what actually landed
 *   in the top k — NOT against the full relevant set. So a query whose 3 relevant
 *   rows yield only 1 in the top k is scored on how well THAT ONE is placed, with
 *   no penalty for the 2 missed. Completeness is recall's job and ordering is
 *   nDCG's, and neither one subsumes the other here.
 *
 * READ-ONLY: it selects and embeds. It writes nothing, anywhere.
 *
 *   npx tsx packages/operator-core/lib/search/bench/ref-expansion-recall-cli.ts
 *   npx tsx ... --docs 300 --queries 150 --k 10 --concurrency 3
 */
import { getOrgPg } from '@papercusp/db-org';
import { evaluateRelevance } from '@papercusp/search-core';

import { resolveBackfillEmbedder } from '../embed-backfill';
import {
  buildGoldQueries,
  buildPool,
  sampleSql,
  type PoolDoc,
  type SampledRow,
} from './ref-expansion-gold';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function argInt(name: string, fallback: number): number {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Bounded-concurrency map — keeps the shared embed sidecar usable by the sweep. */
async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The embed sidecar is SHARED with the live backfill sweep, so a transient
 * `sidecar_required_unavailable` under load is expected, not fatal. Retry with
 * backoff — otherwise one abort ~2 minutes into a multi-minute run discards
 * every embedding computed so far.
 */
async function embedWithRetry(
  embed: (text: string) => Promise<number[]>,
  text: string,
  attempts = 5,
): Promise<number[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await embed(text);
    } catch (err) {
      lastErr = err;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  }
  throw lastErr;
}

function normalise(vec: number[]): Float64Array {
  const v = Float64Array.from(vec);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i]! /= norm;
  return v;
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const docsWanted = argInt('--docs', 300);
  const queriesWanted = argInt('--queries', 150);
  const k = argInt('--k', 10);
  const concurrency = argInt('--concurrency', 3);
  const harness = argValue('--harness');

  const embedder = await resolveBackfillEmbedder();
  if (embedder.mode === 'disabled') {
    console.error(`[ref-expansion-recall] embedder disabled (${embedder.reason ?? 'no reason'}) — cannot measure.`);
    process.exitCode = 1;
    return;
  }
  const embed = embedder.embed;
  console.log(`[ref-expansion-recall] embedder mode=${embedder.mode} dims=${embedder.dims}`);

  const { sql } = getOrgPg();
  // Treated fraction is ~34%, so oversample candidates to land `docsWanted`.
  const rows = await sql.unsafe<SampledRow[]>(sampleSql(docsWanted * 4, docsWanted, harness));

  const pool: PoolDoc[] = buildPool(rows);
  if (pool.length === 0) {
    console.error('[ref-expansion-recall] sampled 0 treated rows — nothing to measure.');
    process.exitCode = 1;
    return;
  }

  // Ground truth + the derived query set — see ref-expansion-gold.ts for the
  // construction and for what the labels do and do not mean.
  const candidateQueries = buildGoldQueries(rows, queriesWanted);

  if (candidateQueries.length === 0) {
    console.error('[ref-expansion-recall] no usable queries — every referenced title was too short.');
    process.exitCode = 1;
    return;
  }

  const totalEmbeds = pool.length * 2 + candidateQueries.length * 2;
  console.log(
    `[ref-expansion-recall] pool=${pool.length} treated rows · queries=${candidateQueries.length} · ` +
      `k=${k} · ${totalEmbeds} embeddings at concurrency ${concurrency}`,
  );

  const v1Vecs = await mapPool(pool, concurrency, async (d) =>
    normalise(await embedWithRetry(embed, d.v1Text)),
  );
  const v2Vecs = await mapPool(pool, concurrency, async (d) =>
    normalise(await embedWithRetry(embed, d.v2Text)),
  );
  const qVecs = await mapPool(candidateQueries, concurrency, async (q) =>
    normalise(await embedWithRetry(embed, q.text)),
  );
  const qdVecs = await mapPool(candidateQueries, concurrency, async (q) =>
    normalise(await embedWithRetry(embed, q.degraded)),
  );

  const rank = (qVec: Float64Array, vecs: Float64Array[], excludeId: string): string[] =>
    pool
      .map((d, i) => ({ id: d.id, score: dot(qVec, vecs[i]!) }))
      // The referenced item itself is not a row that REFERENCES it; its
      // presence in the pool is an artifact of sampling, so drop it from both
      // arms identically rather than letting it occupy a top slot.
      .filter((x) => x.id !== excludeId)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.id);

  // Rank ONCE per query per arm, then read every cutoff off the same ranking —
  // the embeddings are the expensive part, so extra k values are ~free.
  const cutoffs = [...new Set([1, 5, k])].sort((a, b) => a - b);

  const reportArm = (label: string, caveat: string, queryVecs: Float64Array[]): void => {
    const v1Recall = new Map<number, number[]>(cutoffs.map((c) => [c, [] as number[]]));
    const v2Recall = new Map<number, number[]>(cutoffs.map((c) => [c, [] as number[]]));
    const v1Ndcg = new Map<number, number[]>(cutoffs.map((c) => [c, [] as number[]]));
    const v2Ndcg = new Map<number, number[]>(cutoffs.map((c) => [c, [] as number[]]));
    let wins = 0;
    let losses = 0;
    let ties = 0;
    // Of the queries where recall@k TIED, how often did ORDERING still move?
    // This is precisely the population a recall-only reading reports as "no
    // effect", so it is the number that justifies carrying nDCG at all.
    let tiedNdcgBetter = 0;
    let tiedNdcgWorse = 0;

    candidateQueries.forEach((q, i) => {
      const qVec = queryVecs[i]!;
      const ranked1 = rank(qVec, v1Vecs, q.ref);
      const ranked2 = rank(qVec, v2Vecs, q.ref);

      // KNOWN-ITEM retrieval: a pooled row either resolves a ref to the queried
      // item or it does not, so the 0..3 scale collapses to 3-or-0. That is a
      // real binary judgement derived from the sampled edges — NOT a placeholder
      // for graded labels nobody supplied. With one relevant row, nDCG@k reduces
      // to 1/log2(rank+1): 1.000 at rank 1, 0.387 at rank 5, 0.289 at rank 10,
      // where recall@10 reads a flat 1.000 for all three.
      const relevant = new Set(q.relevantIds);
      const grade = (id: string): number => (relevant.has(id) ? 3 : 0);
      const groundTruth = { ids: q.relevantIds, idOf: (id: string) => id };

      for (const c of cutoffs) {
        const e1 = evaluateRelevance({ ranked: ranked1, grade, k: c, groundTruth });
        const e2 = evaluateRelevance({ ranked: ranked2, grade, k: c, groundTruth });
        const r1 = e1.recallAtK;
        const r2 = e2.recallAtK;
        if (r1 === null || r2 === null) continue; // no referent — never scored as 0
        v1Recall.get(c)!.push(r1);
        v2Recall.get(c)!.push(r2);
        v1Ndcg.get(c)!.push(e1.ndcgAtK);
        v2Ndcg.get(c)!.push(e2.ndcgAtK);
        if (c !== k) continue;
        if (r2 > r1) wins++;
        else if (r2 < r1) losses++;
        else {
          ties++;
          if (e2.ndcgAtK > e1.ndcgAtK) tiedNdcgBetter++;
          else if (e2.ndcgAtK < e1.ndcgAtK) tiedNdcgWorse++;
        }
      }
    });

    console.log('');
    console.log(`--- ${label} ---`);
    console.log(`  ${caveat}`);
    for (const c of cutoffs) {
      const m1 = mean(v1Recall.get(c)!);
      const m2 = mean(v2Recall.get(c)!);
      console.log(
        `  recall@${String(c).padEnd(2)} v1 ${pct(m1).padStart(6)}  ->  v2 ${pct(m2).padStart(6)}` +
          `   delta ${((m2 - m1 >= 0 ? '+' : '') + pct(m2 - m1)).padStart(7)}` +
          `   ${m1 > 0 ? `${(m2 / m1).toFixed(2)}x` : 'n/a (v1 0)'}`,
      );
    }
    for (const c of cutoffs) {
      const n1 = mean(v1Ndcg.get(c)!);
      const n2 = mean(v2Ndcg.get(c)!);
      const d = n2 - n1;
      console.log(
        `  nDCG@${String(c).padEnd(2)}   v1 ${n1.toFixed(4).padStart(6)}  ->  v2 ${n2.toFixed(4).padStart(6)}` +
          `   delta ${((d >= 0 ? '+' : '') + d.toFixed(4)).padStart(8)}` +
          `   ${n1 > 0 ? `${(n2 / n1).toFixed(2)}x` : 'n/a (v1 0)'}`,
      );
    }
    console.log(`  per-query @${k}: v2 better ${wins}   worse ${losses}   tied ${ties}`);
    console.log(
      `  of those ${ties} recall-TIED queries, nDCG@${k} moved: better ${tiedNdcgBetter}` +
        `   worse ${tiedNdcgWorse}   unchanged ${ties - tiedNdcgBetter - tiedNdcgWorse}`,
    );
  };

  console.log('');
  console.log('=== P-026 Tier 0 ref-expansion: paired recall A/B ===');
  console.log(`queries: ${candidateQueries.length}   pool (treated rows): ${pool.length}`);

  reportArm(
    'ARM A — verbatim referenced title (CEILING)',
    'the query IS the injected string, so this is the most the appendix can buy',
    qVecs,
  );
  reportArm(
    'ARM B — degraded query, ~half the title words (closer to real use)',
    'no exact-substring advantage; still not a paraphrase, so not a lower bound either',
    qdVecs,
  );
  console.log('');
  console.log('Read A and B as BRACKETING the effect, not as one number. Both arms query for');
  console.log('text the appendix injects, so neither estimates lift on an unrelated query.');

  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('[ref-expansion-recall] failed:', err);
  process.exitCode = 1;
});
