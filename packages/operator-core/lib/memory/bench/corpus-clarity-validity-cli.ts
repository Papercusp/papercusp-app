/**
 * corpus-clarity-validity-cli.ts — P-019 / D-088 R5: does clarity PREDICT anything?
 *
 *   npx tsx packages/operator-core/lib/memory/bench/corpus-clarity-validity-cli.ts \
 *     --queries 400 [--seed 17] [--workspace papercusp-workspace] [--concurrency 4]
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `corpus-query-clarity-cli.ts` measured the DISTRIBUTION of clarity over real
 * traffic (19.7% traffic-weighted escalation). D-088 R5 states plainly that this
 * establishes nothing about VALIDITY: no measurement anywhere shows that a
 * low-clarity query actually retrieves worse. Until that is tested, "19.7% of
 * traffic is unfocused" must never be restated as "19.7% retrieves badly", and
 * `CORPUS_CLARITY_FOCUSED_BITS` is an arbitrary placeholder that every published
 * rate is silently quoted at.
 *
 * This probe pairs the PREDICTOR with the REAL leg's OUTCOME on the SAME query,
 * so the association can be measured instead of assumed.
 *
 * ─── THE PREDICTOR SIDE ──────────────────────────────────────────────────────
 *
 * `assessCorpusQueryClarity(text, { df, ndocs })` — ISSUED scope (the ≤2 terms
 * retrieval actually sees). Scoring the candidate POOL instead is a length meter
 * and returns 87.7% escalation against the same threshold on the same queries;
 * see the warning on `assessCorpusQueryClarity`. Do not "improve" this probe by
 * widening the scope.
 *
 * ─── THE OUTCOME SIDE, AND WHAT EACH NUMBER CAN AND CANNOT ESTABLISH ─────────
 *
 * Outcomes are LABEL-FREE. There is no gold set for this leg, and the one
 * tempting substitute is barred: a known-item set whose query is derived FROM
 * the target document makes the target match every query term BY CONSTRUCTION
 * (`corpus-leg-lexical-acceptance-cli.ts` refuses to report an MRR for exactly
 * this reason). Two outcomes are measured instead, and they answer DIFFERENT
 * questions — reading either alone gets the sign wrong:
 *
 *   FILL / ZERO-HIT  How many of the leg's 6 slots got filled; how often it
 *                    admits nothing at all. This is the leg's OPERATIONAL
 *                    failure mode.
 *
 *     ⚠⚠ FILL IS MECHANICALLY ANTI-CORRELATED WITH CLARITY, and that is not a
 *     finding — it is arithmetic. Stage 1 ANDs its lexemes (`plainto_tsquery`),
 *     so a query of two RARE terms matches FEW documents and can match none,
 *     while two COMMON terms match many. High clarity therefore BUYS zero-hits.
 *     A negative clarity→fill slope is the expected shape and is NOT evidence
 *     that the predictor's construct is wrong; a POSITIVE one would be the
 *     surprise. What fill does settle is the CASCADE'S question: if the queries
 *     that return nothing are the FOCUSED ones, then escalating `unfocused` is
 *     spending money on the queries that already work while ignoring the ones
 *     that fail — and the escalation trigger is pointed the wrong way round.
 *
 *   POST-RETRIEVAL CLARITY  KL divergence of the RETRIEVED set's language model
 *                    from the collection's, in bits, over the same attested-term
 *                    support and the same estimator as the predictor
 *                    (`SCS = Σ P(w|Q)·log2(P(w|Q)/P(w|C))` with `P(w|Q)` uniform
 *                    over query terms reduces to `avgIdf − log2(n)`; swap in
 *                    `P(w|R)` from the retrieved set and you have the
 *                    Cronen-Townsend et al. (2002) clarity that the pre-retrieval
 *                    SCS is an approximation OF).
 *
 *     This is the CONSTRUCT test: SCS's entire claim is that it cheaply predicts
 *     how concentrated the result distribution will be. If pre-retrieval SCS
 *     does not track post-retrieval clarity, the predictor fails on its own
 *     terms and no threshold can rescue it. It is not a relevance measure and
 *     must not be reported as one.
 *
 * ─── THE CONTROL ─────────────────────────────────────────────────────────────
 *
 * Every association is recomputed against a PERMUTED pairing — each query's
 * clarity against a DIFFERENT query's outcome. All of them must collapse to ≈0.
 * This falsifies "the harness manufactures the correlation" (shared sampling,
 * shared clamping, shared corpus instant), which no amount of care in the
 * measurement itself can rule out. It reuses the measured outcomes, so it costs
 * nothing.
 *
 * ⛔ THIS PROBE DOES NOT PICK A THRESHOLD, AND MUST NOT BE MADE TO.
 * `CORPUS_CLARITY_FOCUSED_BITS` is calibrated by a KNEE in the measured curve or
 * not at all. Choosing a percentile fits the constant to the sample; fitting to
 * the Coverage Illusion's 27.8% fits it to the number the work set out to
 * reproduce. Both produce a confident constant that encodes nothing.
 *
 * ⚠ PROXY POPULATION, inherited from the distribution probe and equally
 * non-negotiable: `memory_recall_stats` stores `query_sha256`, not the query
 * text (P-041), so the injected strings are unrecoverable. These are real
 * `speaker='user'` turns clamped to each surface's MEASURED median width, with
 * each prompt assigned a surface by the live traffic mix — so the sample is
 * traffic-weighted by construction and one retrieval covers one query.
 *
 * READ-ONLY. Writes nothing, seeds nothing, mutates no tree.
 */
import { getOrgPg } from '@papercusp/db-org';

import {
  assessCorpusQueryClarity,
  CORPUS_CLARITY_FOCUSED_BITS,
  clarityWarrantsEscalation,
  type QueryClarityVerdict,
} from '../corpus-query-clarity';
import { CORPUS_MAX_ITEMS, corpusTerms } from '../corpus-recall';
import { recallCorpusContext, warmCorpusEmbedder } from '../corpus-recall-io';
import {
  mean,
  partialSpearman,
  permutationNull,
  postRetrievalClarity,
  spearman,
  teaserOf,
} from './corpus-clarity-validity';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const QUERIES = Number(argValue('--queries') ?? 400);
const SEED = argValue('--seed') ?? '17';
const WORKSPACE = argValue('--workspace') ?? 'papercusp-workspace';
const CONCURRENCY = Math.max(1, Number(argValue('--concurrency') ?? 4));
/** Surfaces worth weighting. Anything rarer is noise at this sample size. */
const SURFACE_FLOOR_PCT = 1;

const VERDICTS: QueryClarityVerdict[] = [
  'keyed',
  'focused',
  'unfocused',
  'unretrievable',
  'unknown',
];

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`);
const f2 = (n: number | null): string => (n === null || !Number.isFinite(n) ? '—' : n.toFixed(2));

/** FNV-1a → [0,1). Deterministic surface assignment without pulling in a PRNG. */
function unitHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x100000000;
}

// The statistics this study's RULING rests on — mean / averageRanks / spearman /
// permute / permutationNull / postRetrievalClarity / teaserOf — live in
// `./corpus-clarity-validity` and are imported above. They are NOT inlined here
// on purpose: a bench that only ever runs against live data has no control on
// its own arithmetic, so a defect in `spearman` would print a plausible number
// and never throw. The module's companion test carries permanent controls
// (known-ρ, tie-saturated, independent-series null) that this file cannot have.

interface SurfaceMix {
  surface: string;
  recalls: number;
  share: number;
  clampChars: number;
}

interface Sample {
  surface: string;
  chars: number;
  verdict: QueryClarityVerdict;
  scs: number | null;
  escalates: boolean;
  /** Lines the leg ADMITTED — what the agent actually sees. */
  admitted: number;
  /** Candidates the engine returned, before selection. */
  pool: number;
  outcome: string;
  postBits: number | null;
  postAttested: number | null;
  ms: number;
  embedder: boolean;
}

/** Run `fn` over `items` with bounded concurrency, preserving input order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

function bucketRow(label: string, rows: readonly Sample[], total: number): string {
  const zero = rows.filter((r) => r.admitted === 0).length;
  const full = rows.filter((r) => r.admitted >= CORPUS_MAX_ITEMS).length;
  const post = rows.map((r) => r.postBits).filter((b): b is number => b !== null);
  return (
    `| ${label} | ${rows.length} | ${pct(rows.length, total)} | ${pct(zero, rows.length)} | ` +
    `${f2(mean(rows.map((r) => r.admitted)))} | ${pct(full, rows.length)} | ` +
    `${f2(mean(rows.map((r) => r.pool)))} | ${f2(mean(post))} | ${post.length} |`
  );
}

async function main(): Promise<void> {
  const { sql } = getOrgPg();

  // ── The DF signal, read exactly as the leg's own lookup builds it. ──
  const dfRows = (await sql`
    SELECT term, df, ndocs FROM harness_shared.corpus_term_df WHERE workspace_id = ${WORKSPACE}
  `) as unknown as Array<{ term: string; df: number; ndocs: number }>;

  if (dfRows.length === 0) {
    console.log(
      `> ⚠ **SKIPPED — no \`corpus_term_df\` table for workspace ${WORKSPACE}.** ` +
        `Every verdict would be \`unknown\` by construction, so the association is ` +
        `unmeasurable, not absent.`,
    );
    return;
  }

  const dfMap = new Map<string, number>();
  for (const r of dfRows) dfMap.set(r.term, r.df);
  const ndocs = dfRows[0]!.ndocs;
  const df = (term: string): number => dfMap.get(term) ?? 0;
  const MIN_DF = 2; // CORPUS_QUERY_MIN_DF — the leg's own attestation floor.

  // ── The live surface mix. MEASURED: assuming it is the documented trap. ──
  const mixRows = (await sql`
    SELECT surface,
           count(*)::int AS recalls,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY query_chars)::int AS p50
      FROM harness_shared.memory_recall_stats
     WHERE query_chars IS NOT NULL
       AND created_at > now() - interval '7 days'
       AND (workspace_id = ${WORKSPACE} OR workspace_id IS NULL)
     GROUP BY surface
     ORDER BY recalls DESC
  `) as unknown as Array<{ surface: string; recalls: number; p50: number }>;

  const totalRecalls = mixRows.reduce((n, r) => n + r.recalls, 0);
  const kept = mixRows.filter((r) => (r.recalls / Math.max(totalRecalls, 1)) * 100 >= SURFACE_FLOOR_PCT);
  const keptRecalls = kept.reduce((n, r) => n + r.recalls, 0);
  const mix: SurfaceMix[] = kept.map((r) => ({
    surface: r.surface,
    recalls: r.recalls,
    share: r.recalls / Math.max(keptRecalls, 1),
    clampChars: r.p50,
  }));

  // ── The proxy population: identical sampling to the distribution probe, so
  //    the two runs describe the SAME population and their numbers compose. ──
  const turns = (await sql`
    SELECT text
      FROM harness_shared.session_turns
     WHERE (workspace_id = ${WORKSPACE} OR workspace_id = 'default')
       AND speaker = 'user'
       AND length(text) >= 40
     ORDER BY md5(source_kind || session_id || turn_idx::text || ${SEED})
     LIMIT ${QUERIES}
  `) as unknown as Array<{ text: string }>;

  console.log(`# P-019 / D-088 R5 — does query clarity PREDICT retrieval outcome?\n`);
  console.log(
    `workspace=${WORKSPACE} · df_terms=${dfRows.length.toLocaleString()} · ndocs=${ndocs.toLocaleString()} · ` +
      `sampled_prompts=${turns.length.toLocaleString()} · seed=${SEED} · ` +
      `focusedBits=${CORPUS_CLARITY_FOCUSED_BITS} · concurrency=${CONCURRENCY}\n`,
  );
  console.log(
    `⚠ PROXY POPULATION — real submitted prompts clamped to each surface's measured median width, ` +
      `surface-assigned by the live mix. \`memory_recall_stats\` stores query_sha256, not text (P-041), ` +
      `so these are not the exact injected strings.\n`,
  );
  if (CONCURRENCY > 1) {
    console.log(
      `⚠ concurrency=${CONCURRENCY}: the latency column is NOT comparable to production single-flight ` +
        `timings. It is reported only to show the leg ran inside its bound.\n`,
    );
  }

  // Assign each prompt a surface by the live share, deterministically.
  const assigned = turns.map((t) => {
    const u = unitHash(t.text + SEED);
    let acc = 0;
    let picked = mix[mix.length - 1]!;
    for (const m of mix) {
      acc += m.share;
      if (u < acc) {
        picked = m;
        break;
      }
    }
    return { text: t.text.slice(0, picked.clampChars), surface: picked.surface };
  });

  // ⚠ EI-19460902984682209: the leg uses the embedder ONLY when it is ALREADY
  // warm — a cold request degrades to BM25-only and leaves the warmup running
  // behind it, deliberately. So a bench that merely issues a throwaway query
  // does NOT warm the arm: measured on the N=40 smoke run, `embedderAvailable`
  // came back 0.0% for every one of 40 queries, i.e. the whole study would have
  // been a BM25-only arm silently labelled as the production leg. AWAIT the
  // acquisition explicitly, then report the achieved rate either way — a
  // BM25-only run is a legitimate arm, but it must be a STATED one.
  await warmCorpusEmbedder();

  const t0 = Date.now();
  const samples = await mapLimit(assigned, CONCURRENCY, async (a): Promise<Sample> => {
    const clarity = assessCorpusQueryClarity(a.text, { df, ndocs, minDf: MIN_DF });
    const started = Date.now();
    const res = await recallCorpusContext({
      queryText: a.text,
      workspaceId: WORKSPACE,
      skipFlagCheck: true,
    });
    const ms = Date.now() - started;
    // `corpusTerms` is passed in rather than imported by the module: the
    // post-retrieval score MUST use the same tokenizer the predictor uses, and
    // injecting it is what makes that commensurability visible at the call site
    // (and testable without a corpus).
    const post = postRetrievalClarity(
      res.lines.map((l) => teaserOf(l.line)),
      corpusTerms,
      df,
      ndocs,
      MIN_DF,
    );
    return {
      surface: a.surface,
      chars: a.text.length,
      verdict: clarity.verdict,
      scs: clarity.scs,
      escalates: clarityWarrantsEscalation(clarity.verdict),
      admitted: res.lines.length,
      pool: res.candidateCount,
      outcome: res.outcome,
      postBits: post.bits,
      postAttested: post.attestedRatio,
      ms,
      embedder: res.embedderAvailable,
    };
  });
  const elapsedS = ((Date.now() - t0) / 1000).toFixed(0);

  const n = samples.length;
  const okSamples = samples.filter((s) => s.outcome === 'ok');
  const embedderRate = samples.filter((s) => s.embedder).length;
  const timedOut = samples.filter((s) => s.outcome === 'timed-out').length;
  const failed = samples.filter((s) => s.outcome === 'failed').length;

  console.log(`## Run health\n`);
  console.log(
    `| queries | ran to completion | timed-out | failed | embedder available | wall |\n` +
      `|---:|---:|---:|---:|---:|---:|\n` +
      `| ${n} | ${pct(okSamples.length, n)} | ${timedOut} | ${failed} | ${pct(embedderRate, n)} | ${elapsedS}s |`,
  );
  // ⚠ The arm must be judged over the rows that actually RAN, not over every
  // sample. A timed-out leg never reaches fusion, so it reports
  // `embedderAvailable: false` for a reason that has nothing to do with the
  // embedder — scoring those in the denominator reported a clean 100%-hybrid
  // run as "MIXED … treat every association as confounded", which is a false
  // alarm that invites re-running a sound measurement.
  const okEmbedder = okSamples.filter((s) => s.embedder).length;
  console.log(
    okEmbedder === okSamples.length
      ? `\nARM: **hybrid** (BM25 + vector) — the production shape, on all ${okSamples.length} completed queries.`
      : okEmbedder === 0
        ? `\n⚠ ARM: **BM25-only** — the embedder never warmed in this process, so this measures the ` +
          `leg's DEGRADED path, not the production hybrid one. Every number below is scoped to that arm.`
        : `\n⚠ ARM: **MIXED** — ${pct(okEmbedder, okSamples.length)} of COMPLETED queries ran hybrid and ` +
          `the rest BM25-only, so the sample spans two retrieval systems. Treat every association as ` +
          `confounded and re-run.`,
  );
  if (timedOut + failed > 0) {
    console.log(
      `\n⚠ ${timedOut + failed} query(s) did not run to completion. A \`timed-out\` leg returns an ` +
        `EMPTY \`lines\` that is indistinguishable from "the corpus had nothing" — those rows are ` +
        `EXCLUDED from every association below rather than scored as zero-fill.`,
    );
  }

  // Everything downstream uses only the rows that actually ran.
  const rows = okSamples;

  console.log(`\n## Outcome by clarity verdict\n`);
  console.log(
    `| verdict | n | share | zero-hit | mean admitted | full (6/6) | mean pool | mean post-clarity (bits) | scored |`,
  );
  console.log(`|---|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const v of VERDICTS) {
    const bucket = rows.filter((r) => r.verdict === v);
    if (bucket.length === 0) continue;
    console.log(bucketRow(`\`${v}\``, bucket, rows.length));
  }
  const escalating = rows.filter((r) => r.escalates);
  const notEscalating = rows.filter((r) => !r.escalates);
  console.log(bucketRow(`**would escalate**`, escalating, rows.length));
  console.log(bucketRow(`**would not**`, notEscalating, rows.length));

  // ── The curve. Deciles of SCS among rows that HAVE an SCS (keyed/unknown/
  //    unretrievable have none by construction and must not be folded in as 0). ──
  const scored = rows.filter((r): r is Sample & { scs: number } => r.scs !== null);
  console.log(`\n## The curve — outcome by SCS decile (rows with a computable SCS: ${scored.length})\n`);
  const byScs = [...scored].sort((a, b) => a.scs - b.scs);
  const DECILES = 10;
  console.log(`| decile | SCS range (bits) | n | zero-hit | mean admitted | mean pool | mean post-clarity |`);
  console.log(`|---:|---|---:|---:|---:|---:|---:|`);
  for (let d = 0; d < DECILES; d++) {
    const lo = Math.floor((d * byScs.length) / DECILES);
    const hi = Math.floor(((d + 1) * byScs.length) / DECILES);
    const bucket = byScs.slice(lo, hi);
    if (bucket.length === 0) continue;
    const post = bucket.map((r) => r.postBits).filter((b): b is number => b !== null);
    const zero = bucket.filter((r) => r.admitted === 0).length;
    console.log(
      `| ${d + 1} | ${f2(bucket[0]!.scs)}–${f2(bucket[bucket.length - 1]!.scs)} | ${bucket.length} | ` +
        `${pct(zero, bucket.length)} | ${f2(mean(bucket.map((r) => r.admitted)))} | ` +
        `${f2(mean(bucket.map((r) => r.pool)))} | ${f2(mean(post))} |`,
    );
  }

  // ── Associations + the permutation control. ──
  const scs = scored.map((r) => r.scs);
  const admitted = scored.map((r) => r.admitted);
  const pool = scored.map((r) => r.pool);
  const withPost = scored.filter((r): r is Sample & { scs: number; postBits: number } => r.postBits !== null);

  const pairings: Array<[string, readonly number[], readonly number[]]> = [
    ['SCS → admitted lines', scs, admitted],
    ['SCS → candidate pool', scs, pool],
    [
      'SCS → post-retrieval clarity',
      withPost.map((r) => r.scs),
      withPost.map((r) => r.postBits),
    ],
    // The pairing this study omitted for its first two runs, and the one that
    // decides the ruling. `postRetrievalClarity` is a PLUG-IN KL estimator over
    // the retrieved set's term distribution, so a SMALLER set is sparser and
    // therefore peakier and its bits rise for a purely mechanical reason. If
    // this row is strongly negative, the headline `SCS → post-retrieval clarity`
    // is not an independent quality signal at all — it is the reach column
    // (`SCS → admitted`, ρ ≈ −0.69) reflected through the estimator's own bias.
    [
      'admitted → post-retrieval clarity ⚠ CONFOUND CHECK',
      withPost.map((r) => r.admitted),
      withPost.map((r) => r.postBits),
    ],
  ];

  const DRAWS = 999;
  console.log(`\n## Association (Spearman ρ) against the permutation null (${DRAWS} draws)\n`);
  console.log(`| pairing | n | ρ observed | null mean | null 95% band | p |`);
  console.log(`|---|---:|---:|---:|---|---:|`);
  for (const [label, xs, ys] of pairings) {
    const observed = spearman(xs, ys);
    if (observed === null) {
      console.log(`| ${label} | ${xs.length} | — (series constant) | — | — | — |`);
      continue;
    }
    const nul = permutationNull(xs, ys, observed, DRAWS);
    console.log(
      `| ${label} | ${xs.length} | **${observed.toFixed(3)}** | ${nul ? nul.mean.toFixed(3) : '—'} | ` +
        `${nul ? `${nul.lo.toFixed(3)} … ${nul.hi.toFixed(3)}` : '—'} | ${nul ? nul.p.toFixed(3) : '—'} |`,
    );
  }
  // ── REACH control (the confound the within-surface control does NOT cover). ──
  // The within-surface control below rules out CLAMP WIDTH. It cannot rule out
  // REACH, because reach varies inside every surface. Both outcome columns are
  // measured on the SAME result set and the estimator is size-biased, so the
  // headline association is satisfiable by a query that merely retrieves less.
  // Partialling `admitted` out of `SCS → post-clarity` is what separates the
  // two readings — and a partial that collapses toward 0 is the informative
  // outcome, not a failure to find one.
  {
    const px = withPost.map((r) => r.scs);
    const py = withPost.map((r) => r.postBits);
    const pz = withPost.map((r) => r.admitted);
    const raw = spearman(px, py);
    const partial = partialSpearman(px, py, pz);
    console.log(`\n## Reach control — is "post-retrieval clarity" independent of how MUCH was retrieved?\n`);
    console.log(`| statistic | n | value |`);
    console.log(`|---|---:|---:|`);
    console.log(`| ρ(SCS → post-clarity) RAW | ${px.length} | ${raw === null ? '—' : raw.toFixed(3)} |`);
    console.log(
      `| ρ(SCS → post-clarity) CONTROLLING FOR admitted | ${px.length} | ` +
        `${partial === null ? '— (undefined)' : `**${partial.toFixed(3)}**`} |`,
    );
    if (raw !== null && partial !== null) {
      const shrink = Math.abs(raw) > 0 ? 1 - Math.abs(partial) / Math.abs(raw) : 0;
      console.log(
        `\nThe partial removes ${(shrink * 100).toFixed(1)}% of the raw association's magnitude. ` +
          `A partial near 0 means the raw ρ is ACCOUNTED FOR by retrieval reach — the predictor would then be ` +
          `tracking how MUCH is retrieved, which is mechanically guaranteed (rarer terms match fewer documents) ` +
          `and establishes NOTHING about quality. Read a surviving partial as the only evidence of validity here, ` +
          `and note that neither outcome column is a RELEVANCE judgement: nothing in this study labels whether an ` +
          `admitted line was actually useful.`,
      );
    }
  }

  // ── WITHIN-SURFACE control. ──
  // `SCS = avgIdf − log2(n)` and the clamp width sets how many terms the
  // selector has to choose from, so the SURFACE moves both sides of every
  // pairing above. An association that exists only ACROSS surfaces is a
  // statement about clamp widths wearing a predictor's clothes. If the sign and
  // rough magnitude survive within each surface, it is not that artifact.
  console.log(`\n## Within-surface control — is this a clarity effect or a clamp-width effect?\n`);
  console.log(`| surface | clamp | n | ρ(SCS → admitted) | ρ(SCS → post-clarity) |`);
  console.log(`|---|---:|---:|---:|---:|`);
  for (const m of mix) {
    const bucket = scored.filter((r) => r.surface === m.surface);
    if (bucket.length < 30) continue;
    const post = bucket.filter((r): r is Sample & { scs: number; postBits: number } => r.postBits !== null);
    const a = spearman(bucket.map((r) => r.scs), bucket.map((r) => r.admitted));
    const b = spearman(post.map((r) => r.scs), post.map((r) => r.postBits));
    console.log(
      `| ${m.surface} | ${m.clampChars}ch | ${bucket.length} | ${a === null ? '—' : a.toFixed(3)} | ` +
        `${b === null ? '—' : b.toFixed(3)} |`,
    );
  }

  // ── What the escalation trigger would actually BUY. ──
  const wouldEscalate = rows.filter((r) => r.escalates);
  const escFails = wouldEscalate.filter((r) => r.admitted === 0).length;
  const allFails = rows.filter((r) => r.admitted === 0).length;
  const escNeverEmpty = wouldEscalate.filter((r) => r.admitted >= CORPUS_MAX_ITEMS).length;
  console.log(`\n## Where the escalation budget would go\n`);
  console.log(
    `| escalated | of traffic | that return NOTHING | that fill ALL ${CORPUS_MAX_ITEMS} slots | ` +
      `share of ALL empty results captured |\n|---:|---:|---:|---:|---:|\n` +
      `| ${wouldEscalate.length} | ${pct(wouldEscalate.length, rows.length)} | ` +
      `${escFails} (${pct(escFails, wouldEscalate.length)}) | ` +
      `${escNeverEmpty} (${pct(escNeverEmpty, wouldEscalate.length)}) | ` +
      `${pct(escFails, allFails)} |`,
  );

  console.log(
    `\nThe null mean must be ≈0 and the observed ρ must sit OUTSIDE the 95% band to mean anything. ` +
      `A ρ inside the band is chance — report it as "no association measured", never as a weak one. ` +
      `This control exists because shared sampling, shared clamping and one corpus instant can ` +
      `manufacture an association that no care in the measurement itself would reveal.`,
  );

  console.log(
    `\n⛔ NO THRESHOLD IS PROPOSED HERE. \`CORPUS_CLARITY_FOCUSED_BITS\` moves only on a KNEE in the ` +
      `decile curve above. Picking a percentile fits the constant to this sample; fitting to the ` +
      `Coverage Illusion's 27.8% fits it to the number the work set out to reproduce.`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
