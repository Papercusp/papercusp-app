/**
 * rerank-decision-cli.ts — WI-37653. The reranker INTEGRATION benchmark.
 *
 * OWNER-DIRECTED [owner 2026-08-10]: "make a much better benchmark of the
 * reranker so we can properly decide how to integrate it" + "make sure it has
 * enough data to be conclusive".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS WRONG WITH THE ONE THIS REPLACES
 *
 * D-093 closed P-008 on `known-item admitted 0/7 in both arms`. That record
 * states its own ceiling: only 2 of 7 batches were `order-blocked` (in the pool,
 * lost on rank); the other 5 were NOT-RETRIEVED, which no reorder can fix. The
 * effective sample was TWO. 0/2 is consistent with a true rescue rate up to
 * ~78%, so the null was a power failure, not a finding. More runs could not fix
 * it either: `wi-6512-replay.ts` REPLAY is a FIXED 7-batch reconstruction whose
 * raw transcript is gone — n=7 was the whole fixture.
 *
 * D-093's COST finding (+1,801ms/batch against a 2,000ms bound) is untouched by
 * this and remains the sound half of that decision.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FOUR THINGS THAT MAKE THIS ONE ANSWER THE QUESTION
 *
 * 1. A DATA SOURCE THAT SCALES. Ground truth is derived, not labelled: a real
 *    session turn that CITES a work-item is a natural-language query whose
 *    relevant document is known. Measured 2026-08-10: 55,740 such turns across
 *    7,688 sessions in 30 days. Sample size stops being the binding constraint.
 *
 * 2. THE CITED ID IS STRIPPED FROM THE QUERY. Leaving `WI-37653` in the text
 *    lets the lexical leg retrieve the target by exact token match, which is
 *    precisely where a reranker has nothing to add — the run would measure a
 *    ceiling and report a null. This is the same hazard `ref-expansion-recall-cli`
 *    documents for verbatim-title queries, and it is fatal here rather than
 *    merely optimistic.
 *
 * 3. STRATIFIED BY OPPORTUNITY, then reweighted. Reranking is a REORDER: it can
 *    only act where the target is IN the pool but BELOW the cut. Unstratified,
 *    a real effect confined to ~20-30% of traffic is diluted 3-5x. Strata are
 *    assigned from the CONTROL arm so the treatment cannot move a query between
 *    them.
 *
 * 4. EVERY NULL CARRIES ITS MDE. `pairedDifference` reports the smallest effect
 *    the run could have detected, so "no effect" always reads as "no effect
 *    larger than X". This is the D-093 defect made structurally unrepeatable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY BOTH ARMS COME FROM ONE RETRIEVAL
 *
 * The control is the fused (RRF) pool order; the treatment is that SAME pool
 * reordered by the cross-encoder. One retrieval, one corpus instant, perfectly
 * paired — and it mirrors production exactly, where `semantic.ts:149-172`
 * over-fetches with `rerankCandidateCount(limit)` and then reranks.
 *
 * ⚠ INSTRUMENT VALIDITY IS ENFORCED, NOT ASSUMED. `rerankRows` is fail-soft: with
 * no engine it returns the input order, byte-identical to the control. A
 * treatment arm that silently lost its engine therefore reports a clean 0.000
 * delta that reads exactly like "reranking does not help". This run VOIDS
 * itself unless the stage engaged AND the order actually moved AND the engine
 * was recorded (WI-37649: `rerank.ts` prefers ZeroEntropy over the local
 * cross-encoder, so an unattributed result may describe a different reranker).
 *
 * READ-ONLY: it selects, embeds and scores. It writes nothing, anywhere.
 *
 *   npx tsx packages/operator-core/lib/search/bench/rerank-decision-cli.ts \
 *     --queries 400 [--pool 24] [--concurrency 3] [--seed 17]
 */
import { getOrgPg } from '@papercusp/db-org';
import { ndcgAtK } from '@papercusp/search-core';
import { runHybridSearch, type SearchHit } from '@papercusp/search';

import { rerankRows, rerankText } from '../../agent-tools/search/rerank';
import { SEARCH_SOURCES } from '../../agent-tools/search/sources';
import { resolveBackfillEmbedder } from '../embed-backfill';
import {
  classifyOpportunity,
  instrumentValidity,
  pairedDifference,
  requiredPairs,
  rescueCeiling,
  reweightToPopulation,
  type RerankOpportunity,
} from './rerank-decision';
import { writeFileSync } from 'node:fs';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function argInt(name: string, fallback: number): number {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

const QUERIES = argInt('--queries', 400);
const POOL = argInt('--pool', 24);
const CONCURRENCY = argInt('--concurrency', 3);
const SEED = argInt('--seed', 17);
const WORKSPACE = argValue('--workspace') ?? 'papercusp-workspace';
/**
 * Where to dump the raw per-query outcomes as JSON. Written BEFORE the validity
 * gate on purpose: retrieval is the expensive part of this run, and an
 * ANALYSIS-layer verdict must never be able to discard it. The 2026-08-10
 * pool=24 run threw away 390 pairs of real work because one query was fail-soft.
 */
const DUMP = argValue('--dump');

/** Cuts to sweep. The integration question is "at what page size", not "yes/no". */
const CUTS = [3, 6, 10] as const;
/** The cut the strata are defined at (the corpus leg's admitted-slot scale). */
const PRIMARY_CUT = 6;
/** Grade for the known-relevant row; everything else is 0. */
const RELEVANT_GRADE = 3;

const ID_TOKEN = /\b(?:WI|EI|F|D)-\d{2,20}\b/g;

interface Sample {
  query: string;
  targetId: string;
}

interface Outcome {
  targetId: string;
  opportunity: RerankOpportunity;
  controlRank: number | null;
  treatmentRank: number | null;
  ndcgControl: Record<number, number>;
  ndcgTreatment: Record<number, number>;
  orderMoved: boolean;
  attempted: boolean;
  /**
   * When !attempted: 'nothing-to-reorder' (benign) | 'no-engine' | 'threw:*' |
   * 'degraded:*' — the last being an engine that resolved and then scored
   * NOTHING (WI-37670), most often `degraded:timeout`. That one is the reason
   * this run type can silently measure a disabled reranker, so it must never be
   * folded in with the benign skip.
   */
  skipReason: string | null;
  engine: string | null;
}

/** nDCG@k for a known-item list: the target scores RELEVANT_GRADE, rest 0. */
function ndcgFor(rank: number | null, k: number, poolSize: number): number {
  const grades = new Array<number>(poolSize).fill(0);
  if (rank !== null && rank >= 0 && rank < poolSize) grades[rank] = RELEVANT_GRADE;
  return ndcgAtK(grades, k);
}

/**
 * Element-wise order comparison. Deliberately NOT a join-on-a-sentinel: any
 * separator can in principle occur inside a key, and a sentinel that collides
 * silently reports "order unchanged" — which this bench reads as a dead
 * reranker and VOIDS the run on.
 */
function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Hit identity. `SearchHit` has no `key` — that lives on the RankedItem the
 * engine fuses over — so identity here is the source-qualified id, which is
 * what `sources.ts` builds its own fusion key from.
 */
function hitId(h: SearchHit): string {
  return `${h.source}:${h.source_id}`;
}

function rankOf(keys: readonly string[], targetId: string): number | null {
  const i = keys.indexOf(`work_item:${targetId}`);
  return i >= 0 ? i : null;
}

async function main(): Promise<void> {
  const { sql } = getOrgPg();
  const resolved = await resolveBackfillEmbedder();
  if (resolved.mode === 'disabled') {
    // Refusing beats measuring: with no embedder the run degrades to BM25-only,
    // which changes the candidate pool the reranker is scored on. That is a
    // DIFFERENT experiment reported under this one's name.
    console.error(
      `VOID — embedder disabled (${resolved.reason ?? 'no reason given'}). The pool would be ` +
        `BM25-only, so the measured reranker effect would not be the production one.`,
    );
    process.exitCode = 1;
    return;
  }
  const embedder = resolved.embed;

  console.log(`# WI-37653 — reranker INTEGRATION benchmark\n`);
  console.log(
    `workspace=${WORKSPACE} · requested=${QUERIES} · pool=${POOL} · cuts=${CUTS.join('/')} · ` +
      `primary_cut=${PRIMARY_CUT} · seed=${SEED} · concurrency=${CONCURRENCY}\n`,
  );

  // ── Derived ground truth: a real turn that cites a work-item that EXISTS. ──
  // `speaker='user'` keeps the queries human-authored prose rather than an
  // agent's own summary of what it just did, which would be near-verbatim to
  // the item body and re-introduce the ceiling stripping the id exists to avoid.
  // ⚠ NO `workspace_id` FILTER HERE, deliberately. `session_turns.workspace_id`
  // is ALWAYS the literal 'default' — a transcript-corpus namespace, not a
  // tenant. Filtering it by the tenant slug returns 6 rows out of 55,734 and
  // the run VOIDs for what looks like a data shortage. (The tenant slug IS
  // correct for the `runHybridSearch` call below, which reads work_items.)
  //
  // ⚠ AND `speaker='user'` IS NOT ENOUGH. On agent sessions that role also
  // carries MACHINE-INJECTED text — wake pumps, loop fires, compaction
  // continuations — which cite ids inside boilerplate no human would ever type.
  // Benchmarking retrieval on wake-pump prose measures the wrong distribution,
  // so the machine shapes are excluded explicitly.
  const rows = (await sql`
    SELECT st.text AS turn_text,
           substring(st.text from '(?:WI|EI)-[0-9]{3,}') AS target_id
      FROM harness_shared.session_turns st
     WHERE st.speaker = 'user'
       AND st.ts > now() - interval '30 days'
       AND length(st.text) BETWEEN 60 AND 1200
       AND st.text ~ '(WI|EI)-[0-9]{3,}'
       AND st.text NOT LIKE '%turn-origin:%'
       AND st.text NOT LIKE '%[await-event]%'
       AND st.text NOT LIKE '%LOOP WAKE%'
       AND st.text NOT LIKE '%system-reminder%'
     ORDER BY md5(st.session_id || st.turn_idx::text || ${String(SEED)})
     LIMIT ${QUERIES * 4}
  `) as Array<{ turn_text: string; target_id: string | null }>;

  const samples: Sample[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (samples.length >= QUERIES) break;
    const targetId = r.target_id;
    if (!targetId || seen.has(targetId)) continue;
    // STRIP every id token — see header note 2. Without this the lexical leg
    // matches the id verbatim and the reranker has nothing left to contribute.
    const query = r.turn_text.replace(ID_TOKEN, ' ').replace(/\s+/g, ' ').trim();
    if (query.length < 40) continue;
    seen.add(targetId);
    samples.push({ query, targetId });
  }

  // Only targets that actually exist can be "relevant" — and existence is
  // checked in `engineer_issues`, the SAME relation the `work_item` search
  // source selects from (sources.ts). Checking a different relation would admit
  // targets retrieval can never return, inflating `not-retrieved` with rows
  // that were never candidates and diluting every stratum below it.
  const ids = samples.map((s) => s.targetId);
  const live = new Set(
    (
      (await sql`
        SELECT issue_id FROM harness_shared.engineer_issues WHERE issue_id = ANY(${ids})
      `) as Array<{ issue_id: string }>
    ).map((r) => r.issue_id),
  );
  const usable = samples.filter((s) => live.has(s.targetId));
  console.log(
    `derived ground truth: ${rows.length} candidate turns → ${samples.length} distinct targets → ` +
      `**${usable.length} usable** (target row still exists)\n`,
  );
  if (usable.length < 3) {
    console.log('VOID — too few usable samples to measure anything.');
    return;
  }

  const sources = SEARCH_SOURCES.filter((s) => s.name === 'work_item');
  const outcomes: Outcome[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= usable.length) return;
      const s = usable[i]!;
      try {
        const { results } = await runHybridSearch(sources, {
          sql,
          query: s.query,
          workspaceId: WORKSPACE,
          scopeFilter: null,
          limit: POOL,
          mode: 'hybrid',
          embedder,
          embedTimeoutMs: 8_000,
          filters: {},
        } as never);

        const pool: SearchHit[] = results ?? [];
        if (pool.length === 0) continue;

        const controlKeys = pool.map(hitId);
        const controlRank = rankOf(controlKeys, s.targetId);

        let attempted = false;
        let engine: string | null = null;
        // WHY the stage did not engage, when it did not. The three reasons mean
        // OPPOSITE things — 'nothing-to-reorder' is a benign 1-row pool, while
        // 'no-engine'/'threw:*' are engine failures — so a run that does not
        // record this cannot tell a healthy exclusion from a dark engine.
        let skipReason: string | null = null;
        // limit = pool.length: REORDER without cutting. The cut is applied
        // afterwards, per-k, so one rerank call serves the whole sweep.
        const reranked = await rerankRows<SearchHit>(s.query, pool, {
          limit: pool.length,
          id: hitId,
          // `rerankText` is the SAME match-centred text production scores on.
          // Hand-rolling this would measure a reranker nobody ships.
          text: rerankText,
          qualityScore: (r) => r.score,
          rerankTimeoutMs: 10_000,
          onOutcome: (o) => {
            attempted = o.attempted;
            // The engine is recorded even on a DEGRADE (WI-37670): "resolved
            // `local` but scored nothing" and "no engine at all" are different
            // failures, and a run that cannot tell them apart cannot say which.
            if (o.engine) engine = o.engine;
            else if (o.attempted && o.reason) engine = o.reason;
            if (!o.attempted) skipReason = o.reason ?? 'unknown';
          },
        });
        const treatmentKeys = reranked.map(hitId);
        const treatmentRank = rankOf(treatmentKeys, s.targetId);

        const ndcgControl: Record<number, number> = {};
        const ndcgTreatment: Record<number, number> = {};
        for (const k of CUTS) {
          ndcgControl[k] = ndcgFor(controlRank, k, pool.length);
          ndcgTreatment[k] = ndcgFor(treatmentRank, k, pool.length);
        }

        outcomes.push({
          targetId: s.targetId,
          opportunity: classifyOpportunity(controlRank, PRIMARY_CUT),
          controlRank,
          treatmentRank,
          ndcgControl,
          ndcgTreatment,
          orderMoved: !sameOrder(controlKeys, treatmentKeys),
          attempted,
          skipReason,
          engine,
        });
      } catch (err) {
        console.error(`[skip] ${s.targetId}: ${(err as Error).message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // ── Persist the RAW outcomes before any verdict logic can discard them. ──
  if (DUMP) {
    try {
      writeFileSync(DUMP, JSON.stringify({ workspace: WORKSPACE, pool: POOL, seed: SEED, cuts: CUTS, primaryCut: PRIMARY_CUT, outcomes }, null, 2));
      console.log(`[dump] ${outcomes.length} raw outcomes → ${DUMP}\n`);
    } catch (err) {
      console.error(`[dump] FAILED to write ${DUMP}: ${(err as Error).message}`);
    }
  }

  // ── Instrument validity FIRST. A void run must not print a verdict. ──
  const engineSeen = outcomes.find((o) => o.engine)?.engine ?? null;
  const skipped = outcomes.filter((o) => !o.attempted);
  const validity = instrumentValidity({
    attempted: outcomes.filter((o) => o.attempted).length,
    total: outcomes.length,
    ordersMoved: outcomes.filter((o) => o.orderMoved).length,
    engine: engineSeen,
    benignSkips: skipped.filter((o) => o.skipReason === 'nothing-to-reorder').length,
  });

  console.log(`## Run health\n`);
  console.log(`| ran | stage engaged | order moved | engine |`);
  console.log(`|---:|---:|---:|---|`);
  console.log(
    `| ${outcomes.length} | ${outcomes.filter((o) => o.attempted).length} | ` +
      `${outcomes.filter((o) => o.orderMoved).length} | ${engineSeen ?? '**NONE RECORDED**'} |\n`,
  );
  if (skipped.length) {
    // A bare "N did not engage" conflates a benign 1-row pool with a dark
    // engine. Name the reasons so the reader can tell which happened.
    const byReason = new Map<string, number>();
    for (const o of skipped) byReason.set(o.skipReason ?? 'unknown', (byReason.get(o.skipReason ?? 'unknown') ?? 0) + 1);
    console.log(`Non-engagement by reason: ` + [...byReason].map(([r, n]) => `\`${r}\` ×${n}`).join(', ') + `\n`);
  }
  if (!validity.ok) {
    console.log(`## ⛔ RUN VOIDED — do NOT read a verdict from it\n`);
    for (const r of validity.reasons) console.log(`- ${r}`);
    console.log(
      `\nThe rerank stage is fail-soft: with no engine it returns the input order, byte-identical ` +
        `to the control. A delta of 0.000 from such a run is indistinguishable from "reranking does ` +
        `not help" and must never be published as one.`,
    );
    if (DUMP) console.log(`\nThe raw outcomes were still dumped to ${DUMP} — re-analyse without re-running.`);
    return;
  }

  // Every delta below is computed on the ENGAGED subset ONLY. A fail-soft pair
  // is treatment == control by construction, so including it would drag the
  // estimate toward zero — the exact "looks like no effect" artefact this
  // instrument exists to prevent. The strata SHARES stay on the full ran set:
  // `opportunity` is a CONTROL-arm property, valid whether or not rerank engaged.
  const engaged = outcomes.filter((o) => o.attempted);
  if (validity.warnings.length) {
    console.log(`### ⚠ Caveats that travel with every number below\n`);
    for (const w of validity.warnings) console.log(`- ${w}`);
    console.log(`\nAnalysed pairs: **${engaged.length}** of ${outcomes.length} ran.\n`);
  }

  // ── Strata base rates (the population shares reweighting needs). ──
  const strataNames: RerankOpportunity[] = ['admitted', 'order-blocked', 'not-retrieved'];
  console.log(`## Opportunity strata at cut=${PRIMARY_CUT} — where reranking CAN act\n`);
  console.log(`| stratum | n | share | meaning |`);
  console.log(`|---|---:|---:|---|`);
  const MEANING: Record<RerankOpportunity, string> = {
    admitted: 'already above the cut — a reorder can only LOSE ground',
    'order-blocked': '**in the pool, below the cut — the ONLY stratum rerank can win**',
    'not-retrieved': 'never retrieved — no reordering can conjure it',
  };
  const shares: Record<string, number> = {};
  for (const name of strataNames) {
    const n = outcomes.filter((o) => o.opportunity === name).length;
    shares[name] = outcomes.length ? n / outcomes.length : 0;
    console.log(`| \`${name}\` | ${n} | ${(shares[name]! * 100).toFixed(1)}% | ${MEANING[name]} |`);
  }

  // ── The verdict, per cut, per stratum, with MDE beside every number. ──
  console.log(`\n## Effect on nDCG — paired, with the MDE beside every result\n`);
  console.log(`| cut | stratum | n | mean Δ nDCG | 95% CI | MDE@80% | reading |`);
  console.log(`|---:|---|---:|---:|---|---:|---|`);
  for (const k of CUTS) {
    for (const name of [...strataNames, 'ALL' as const]) {
      const bucket = name === 'ALL' ? engaged : engaged.filter((o) => o.opportunity === name);
      if (bucket.length < 3) {
        console.log(`| ${k} | ${name} | ${bucket.length} | — | — | — | too few pairs to measure |`);
        continue;
      }
      const d = pairedDifference(
        bucket.map((o) => o.ndcgControl[k]!),
        bucket.map((o) => o.ndcgTreatment[k]!),
      );
      if (!d) continue;
      const reading =
        d.nullIsInformative === true
          ? 'INFORMATIVE NULL — no effect worth shipping'
          : d.nullIsInformative === null
            ? '⚠ UNDECIDABLE — underpowered, not a null'
            : d.meanDiff > 0
              ? '**REAL GAIN**'
              : '**REAL LOSS**';
      console.log(
        `| ${k} | ${name} | ${d.n} | ${d.meanDiff >= 0 ? '+' : ''}${d.meanDiff.toFixed(4)} | ` +
          `${d.ci95[0].toFixed(4)} … ${d.ci95[1].toFixed(4)} | ${d.mde80.toFixed(4)} | ${reading} |`,
      );
    }
  }

  // ── Population effect: reweight the oversampled strata back to reality. ──
  console.log(`\n## Population effect at cut=${PRIMARY_CUT} (strata reweighted to base rates)\n`);
  const strata = strataNames
    .map((name) => {
      const bucket = engaged.filter((o) => o.opportunity === name);
      if (bucket.length < 3) return null;
      const d = pairedDifference(
        bucket.map((o) => o.ndcgControl[PRIMARY_CUT]!),
        bucket.map((o) => o.ndcgTreatment[PRIMARY_CUT]!),
      );
      return d ? { name, share: shares[name]!, effect: d.meanDiff, se: d.se } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const pop = reweightToPopulation(strata);
  if (pop) {
    const popReading =
      pop.nullIsInformative === true
        ? 'INFORMATIVE NULL — no population effect worth shipping'
        : pop.nullIsInformative === null
          ? '⚠ UNDECIDABLE — underpowered at the population level, NOT a null'
          : pop.effect > 0
            ? '**REAL POPULATION GAIN**'
            : '**REAL POPULATION LOSS**';
    console.log(
      `Population Δ nDCG@${PRIMARY_CUT} = **${pop.effect >= 0 ? '+' : ''}${pop.effect.toFixed(4)}** ` +
        `(95% CI ${pop.ci95[0].toFixed(4)} … ${pop.ci95[1].toFixed(4)}, ` +
        `MDE@80% ${pop.mde80.toFixed(4)}) — ${popReading}`,
    );
    if (pop.unmeasured.length)
      console.log(`\n⚠ UNMEASURED strata (not treated as zero): ${pop.unmeasured.join(', ')}`);
    console.log(
      `\nThis is the number an integration decision should use. A within-stratum gain is NOT the ` +
        `production effect: a large win confined to \`order-blocked\` is scaled by that stratum's ` +
        `share, and a demotion inside \`admitted\` subtracts from it.`,
    );
  }

  // ── The ceiling on what reranking could EVER contribute. ──
  // Printed UNCONDITIONALLY, including when `order-blocked` is empty — that is
  // precisely the case the old sizing block stayed silent on, and the case where
  // a bound is decisive rather than merely suggestive.
  const obAll = outcomes.filter((o) => o.opportunity === 'order-blocked');
  const ceiling = rescueCeiling({ observed: obAll.length, n: outcomes.length });
  if (ceiling) {
    console.log(`\n## Ceiling — the most reranking could EVER be worth here\n`);
    console.log(
      `\`order-blocked\` observed **${obAll.length}/${outcomes.length}**; 95% upper bound on its ` +
        `population share = **${(ceiling.shareUpperBound * 100).toFixed(2)}%**.\n`,
    );
    console.log(
      `nDCG ∈ [0,1], so a target below the cut scores 0 and can gain at most 1.0 by being lifted to ` +
        `rank 1. A **PERFECT** reranker — rescuing every order-blocked query flawlessly, and never ` +
        `demoting an admitted one — therefore raises population nDCG@${PRIMARY_CUT} by at most ` +
        `**+${ceiling.populationCeiling.toFixed(4)}**.\n`,
    );
    if (obAll.length === 0)
      console.log(
        `⚠ This is a bound derived from an ABSENCE, and it is a CONCLUSION, not a shortfall: a larger ` +
          `sample can only lower it. If this ceiling is under the smallest effect worth shipping, the ` +
          `integration question is closed at this over-fetch — the lever is retrieval REACH (pool size), ` +
          `not ranking order.\n`,
      );
  }

  // ── Sizing guidance for the NEXT run. ──
  const ob = engaged.filter((o) => o.opportunity === 'order-blocked');
  if (ob.length >= 3) {
    const d = pairedDifference(
      ob.map((o) => o.ndcgControl[PRIMARY_CUT]!),
      ob.map((o) => o.ndcgTreatment[PRIMARY_CUT]!),
    );
    if (d) {
      const need = requiredPairs(d.sdDiff, 0.02);
      const share = Math.max(shares['order-blocked'] ?? 0, 1e-9);
      console.log(
        `\n## Sizing\n\nObserved per-pair SD in \`order-blocked\` = ${d.sdDiff.toFixed(4)}. ` +
          `Detecting a 2-point nDCG effect there at 80% power needs **${need ?? '—'} pairs**; ` +
          `this run had **${d.n}**. At a ${(share * 100).toFixed(1)}% base rate that is ` +
          `~${need ? Math.ceil(need / share) : '—'} sampled queries.`,
      );
    }
  }

  console.log(
    `\n⚠ Ground truth is DERIVED (a turn citing an item), not labelled: it scores ONE known-relevant ` +
      `row per query and says nothing about whether the other admitted rows were useful. It measures ` +
      `known-item placement, which is what reranking claims to improve — not overall answer quality.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
