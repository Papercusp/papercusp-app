/**
 * corpus-query-clarity-cli.ts — P-019's ESCALATION-RATE probe.
 *
 *   npx tsx packages/operator-core/lib/memory/bench/corpus-query-clarity-cli.ts \
 *     --queries 2000 [--seed 17] [--workspace papercusp-workspace]
 *
 * ─── WHY THIS RUNS BEFORE ANY ESCALATION TIER IS BUILT ───────────────────────
 *
 * P-019 proposes a cheapest-first cascade: statistical path always, escalate to
 * something expensive only when a query-performance predictor says this query
 * will not work. The ENTIRE argument for that shape is an empirical claim about
 * what fraction of REAL traffic needs the expensive tier — and the paper P-019
 * cites (The Coverage Illusion, 2026-05-26) exists precisely because that
 * fraction was badly mis-estimated: synthetic query distributions implied >90%
 * of queries need LLM augmentation while real traffic needed 27.8%.
 *
 * So the number is the deliverable, not the tier. If real traffic escalates at
 * ~2%, the tier is not worth building; if it escalates at ~90%, the cascade is
 * a rewriter with extra steps and D-046's latency/cost objection stands
 * unanswered. This probe measures it BEFORE anything is wired, which is the
 * same discipline `corpus-term-selection-cli.ts` applied to P-018 (measure the
 * addressable population before building the mechanism that addresses it).
 *
 * ─── THE SURFACE MIX IS MEASURED, NOT ASSUMED — AND IT IS THE TRAP ───────────
 *
 * `corpusQueryText`'s docstring describes turn-start's 1000-char envelope, and
 * that is the case an author naturally reaches for. Measured live over 7 days,
 * turn-start is **6.2%** of injection recalls; **mid-turn is 93.8%, at a median
 * of 154 query chars**. A short query yields far fewer candidate terms, so it
 * sits in a completely different part of the clarity distribution — measuring
 * the 1000-char case and calling it "real traffic" would characterise the tail
 * and miss the body. This probe therefore reads the live per-surface mix and
 * clamp widths from `memory_recall_stats` and weights by them.
 *
 * ⚠ THIS MEASURES A PROXY POPULATION, AND THAT LIMIT IS NOT NEGOTIABLE.
 * `memory_recall_stats` stores `query_sha256`, NOT the query text (P-041 hashes
 * it deliberately), so the exact strings that were injected are unrecoverable.
 * The proxy is real `speaker='user'` turns — the submitted-prompt population the
 * injected text is derived from — clamped to each surface's MEASURED median
 * query width. Every number below is therefore "clarity of the population
 * injection draws from", never "clarity of the exact queries injected". Do not
 * quote it as the latter.
 */
import { getOrgPg } from '@papercusp/db-org';

import {
  assessCorpusQueryClarity,
  clarityWarrantsEscalation,
  scoreCorpusQueryClarity,
  type QueryClarityVerdict,
} from '../corpus-query-clarity';
import { corpusQueryText } from '../corpus-recall';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const QUERIES = Number(argValue('--queries') ?? 2000);
const SEED = argValue('--seed') ?? '17';
const WORKSPACE = argValue('--workspace') ?? 'papercusp-workspace';
/** Surfaces worth weighting. Anything rarer is noise at this sample size. */
const SURFACE_FLOOR_PCT = 1;

const VERDICTS: QueryClarityVerdict[] = [
  'keyed',
  'focused',
  'unfocused',
  'unretrievable',
  'unknown',
];

interface SurfaceMix {
  surface: string;
  recalls: number;
  share: number;
  clampChars: number;
}

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`);

function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i]!;
}

async function main(): Promise<void> {
  const { sql } = getOrgPg();

  // ── The DF signal, read exactly as the leg's lookup builds it. ──
  const dfRows = (await sql`
    SELECT term, df, ndocs FROM harness_shared.corpus_term_df WHERE workspace_id = ${WORKSPACE}
  `) as unknown as Array<{ term: string; df: number; ndocs: number }>;

  if (dfRows.length === 0) {
    console.log(
      `> ⚠ **SKIPPED — no \`corpus_term_df\` table for workspace ${WORKSPACE}.** ` +
        `Populate it first (\`corpus-term-selection-cli.ts --refresh\`, or wait for the ` +
        `\`system:corpus-term-df\` routine). Without it every verdict is \`unknown\` by ` +
        `construction and the escalation rate is unmeasurable, not zero.`,
    );
    return;
  }

  const dfMap = new Map<string, number>();
  for (const r of dfRows) dfMap.set(r.term, r.df);
  const ndocs = dfRows[0]!.ndocs;
  const df = (term: string): number => dfMap.get(term) ?? 0;

  // ── The live surface mix. MEASURED, because assuming it is the documented trap. ──
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
  const mix: SurfaceMix[] = mixRows
    .filter((r) => (r.recalls / Math.max(totalRecalls, 1)) * 100 >= SURFACE_FLOOR_PCT)
    .map((r) => ({
      surface: r.surface,
      recalls: r.recalls,
      share: r.recalls / totalRecalls,
      clampChars: r.p50,
    }));

  // ── The proxy population: real submitted prompts, sampled deterministically. ──
  const turns = (await sql`
    SELECT text
      FROM harness_shared.session_turns
     WHERE (workspace_id = ${WORKSPACE} OR workspace_id = 'default')
       AND speaker = 'user'
       AND length(text) >= 40
     ORDER BY md5(source_kind || session_id || turn_idx::text || ${SEED})
     LIMIT ${QUERIES}
  `) as unknown as Array<{ text: string }>;

  console.log(`# P-019 — corpus query clarity / escalation rate\n`);
  console.log(
    `workspace=${WORKSPACE} · df_terms=${dfRows.length.toLocaleString()} · ndocs=${ndocs.toLocaleString()} · ` +
      `sampled_prompts=${turns.length.toLocaleString()} · seed=${SEED}\n`,
  );
  console.log(
    `⚠ PROXY POPULATION: \`memory_recall_stats\` stores query_sha256, not the query text, so these ` +
      `are real submitted prompts clamped to each surface's measured median width — not the exact ` +
      `injected strings.\n`,
  );

  console.log(`## Live surface mix (7d, ${totalRecalls.toLocaleString()} recalls)\n`);
  console.log(`| surface | recalls | share | median query chars |`);
  console.log(`|---|---:|---:|---:|`);
  for (const m of mix) {
    console.log(
      `| ${m.surface} | ${m.recalls.toLocaleString()} | ${(m.share * 100).toFixed(1)}% | ${m.clampChars} |`,
    );
  }

  console.log(`\n## Clarity verdict by surface — scored on the ISSUED query (≤2 terms)\n`);
  console.log(
    `| surface | clamp | ${VERDICTS.join(' | ')} | ESCALATES | (unfocused, pool-scored — control) |`,
  );
  console.log(`|---|---:|${VERDICTS.map(() => '---:').join('|')}|---:|---:|`);

  let weightedEscalate = 0;
  let weightedPoolUnfocused = 0;
  let weightedIssuedUnfocused = 0;
  let weightedKeyed = 0;
  let weightShare = 0;
  const perSurfaceScs = new Map<string, number[]>();
  const perSurfaceIssuedScs = new Map<string, number[]>();

  for (const m of mix) {
    const counts = new Map<QueryClarityVerdict, number>(VERDICTS.map((v) => [v, 0]));
    const scs: number[] = [];
    const issuedCounts = new Map<QueryClarityVerdict, number>(VERDICTS.map((v) => [v, 0]));
    const issuedScs: number[] = [];
    for (const t of turns) {
      const clamped = t.text.slice(0, m.clampChars);

      // CONTROL ARM — the full candidate pool. Kept only to demonstrate the
      // length contamination: SCS = avgIdf − log2(n), so a pool-scored query
      // loses a bit of clarity for every doubling of the candidate count, and
      // the pool size is a property of the SURFACE's clamp, not of the content.
      const a = assessCorpusQueryClarity(clamped, { df, ndocs, scope: 'pool' });
      counts.set(a.verdict, (counts.get(a.verdict) ?? 0) + 1);
      if (a.scs !== null) scs.push(a.scs);

      // SUBJECT ARM — the query production ACTUALLY ISSUES (≤2 terms, derived
      // with no `df` exactly as the leg derives it). This is what retrieval
      // sees, so it is the only arm a claim about retrieval may rest on.
      const b = assessCorpusQueryClarity(clamped, { df, ndocs });
      issuedCounts.set(b.verdict, (issuedCounts.get(b.verdict) ?? 0) + 1);
      if (b.scs !== null) issuedScs.push(b.scs);
    }
    scs.sort((a, b) => a - b);
    issuedScs.sort((a, b) => a - b);
    perSurfaceScs.set(m.surface, scs);
    perSurfaceIssuedScs.set(m.surface, issuedScs);

    // Summed THROUGH the shipped predicate, never a hand-written verdict list.
    // This probe's entire job is to report what the code would actually spend
    // on, so a local copy of the rule does not merely duplicate it — it reports
    // the OLD rule with full confidence the moment the rule moves, which is
    // exactly what happened when D-095 narrowed escalation to `unretrievable`
    // alone (this line used to add `unfocused` in, and would have printed 29.4%
    // for a predicate that fires on ~9.6%). Same reasoning that pulled
    // `corpusQueryIdToken` out of corpus-recall rather than copying it.
    const sumEscalating = (c: Map<QueryClarityVerdict, number>): number =>
      VERDICTS.reduce((n, v) => n + (clarityWarrantsEscalation(v) ? (c.get(v) ?? 0) : 0), 0);
    const escalate = sumEscalating(issuedCounts);

    // ⚠ THE POOL ARM IS THE CLARITY-INSTRUMENT CONTROL AND MUST BE READ ON THE
    // `unfocused` SHARE, NOT ON THE ESCALATION RATE. Running it through the
    // predicate instead prints ~0% by construction and means nothing: pool scope
    // scores every candidate term, so a query is almost never WHOLLY unattested,
    // and `unretrievable` — the sole escalating verdict since D-095 — is an
    // ATTESTATION verdict, not a clarity one. The `−log2(n)` length artifact this
    // control exists to expose lives entirely in the focused/unfocused cut, so
    // that is the cut it has to be measured on.
    const poolUnfocused = counts.get('unfocused') ?? 0;
    const issuedUnfocused = issuedCounts.get('unfocused') ?? 0;

    weightedEscalate += m.share * (escalate / turns.length);
    weightedPoolUnfocused += m.share * (poolUnfocused / turns.length);
    weightedIssuedUnfocused += m.share * (issuedUnfocused / turns.length);
    weightedKeyed += m.share * ((issuedCounts.get('keyed') ?? 0) / turns.length);
    weightShare += m.share;

    console.log(
      `| ${m.surface} | ${m.clampChars} | ` +
        VERDICTS.map((v) => pct(issuedCounts.get(v) ?? 0, turns.length)).join(' | ') +
        ` | **${pct(escalate, turns.length)}** | ${pct(poolUnfocused, turns.length)} |`,
    );
  }

  console.log(`\n## SCS distribution (bits, attested terms only)\n`);
  console.log(`| surface | p10 | p25 | p50 | p75 | p90 | n scored |`);
  console.log(`|---|---:|---:|---:|---:|---:|---:|`);
  for (const m of mix) {
    const s = perSurfaceScs.get(m.surface) ?? [];
    const q = (v: number): string => {
      const x = quantile(s, v);
      return x === null ? 'n/a' : x.toFixed(2);
    };
    console.log(`| ${m.surface} | ${q(0.1)} | ${q(0.25)} | ${q(0.5)} | ${q(0.75)} | ${q(0.9)} | ${s.length} |`);
  }

  console.log(`\n## SCS of the ISSUED query (≤2 terms — the control for length contamination)\n`);
  console.log(`| surface | clamp | p10 | p25 | p50 | p75 | p90 | n scored |`);
  console.log(`|---|---:|---:|---:|---:|---:|---:|---:|`);
  for (const m of mix) {
    const s = perSurfaceIssuedScs.get(m.surface) ?? [];
    const q = (v: number): string => {
      const x = quantile(s, v);
      return x === null ? 'n/a' : x.toFixed(2);
    };
    console.log(
      `| ${m.surface} | ${m.clampChars} | ${q(0.1)} | ${q(0.25)} | ${q(0.5)} | ${q(0.75)} | ${q(0.9)} | ${s.length} |`,
    );
  }
  console.log(
    `\n> Read the two SCS tables TOGETHER. If pool-scored SCS falls monotonically with the clamp ` +
      `width while issued-scored SCS does not, the pool-scored predictor is largely reporting how ` +
      `long the envelope was — a property of the SURFACE, already known for free.`,
  );

  // Renormalised over the surfaces that cleared the floor, so the headline is a
  // share OF MEASURED TRAFFIC rather than a number silently diluted by the tail.
  const norm = weightShare > 0 ? weightShare : 1;
  console.log(`\n## Headline\n`);
  // The bucket list is DERIVED from the predicate, not typed out beside it, so
  // the label can never describe a rule the number was not computed with.
  const escalatingVerdicts = VERDICTS.filter((v) => clarityWarrantsEscalation(v));
  console.log(
    `- **Traffic-weighted escalation rate: ${((weightedEscalate / norm) * 100).toFixed(1)}%** ` +
      `(${escalatingVerdicts.join(' + ')}, scored on the ISSUED query), over ${(norm * 100).toFixed(1)}% of recalls.`,
  );
  console.log(
    `- ⚠ NOT comparable to rates published before D-095 (2026-08-10). Escalation was ` +
      `re-targeted from \`unfocused\`+\`unretrievable\` to \`unretrievable\` alone, so the ` +
      `pre-D-095 figures (19.7% on 2026-08-09, 29.4% on 2026-08-12) count a bucket this ` +
      `number excludes. Compare rules before comparing rates.`,
  );
  console.log(
    `- Clarity-instrument control (the D-095 re-target does not touch this): the SAME queries ` +
      `are labelled \`unfocused\` ${((weightedIssuedUnfocused / norm) * 100).toFixed(1)}% of the ` +
      `time issued-scored vs ${((weightedPoolUnfocused / norm) * 100).toFixed(1)}% pool-scored. ` +
      `That gap is entirely the \`−log2(n)\` length artifact — pool scoring subtracts a bit of ` +
      `"clarity" per DOUBLING of the candidate count, so it reports envelope length, not query ` +
      `content. This is why issued is the default (D-088 R2).`,
  );
  console.log(
    `- Keyed (retrievable by construction, never escalate): ${((weightedKeyed / norm) * 100).toFixed(1)}%.`,
  );
  console.log(
    `- Compare against The Coverage Illusion's real-traffic 27.8% and synthetic >90% (D-061).`,
  );

  await sql.end({ timeout: 5 });
}

void main().catch((err: unknown) => {
  console.error('[corpus-query-clarity-cli] failed:', (err as Error)?.message ?? err);
  process.exitCode = 1;
});
