/**
 * corpus-term-selection-cli.ts — P-018's ADDRESSABLE-POPULATION probe.
 *
 *   npx tsx packages/operator-core/lib/memory/bench/corpus-term-selection-cli.ts \
 *     --queries 400 --df-sample 40000 --seed 17 [--workspace <id>]
 *
 * ─── WHY THIS EXISTS BEFORE ANY DF MACHINERY ─────────────────────────────────
 *
 * P-018 replaces LENGTH with corpus document frequency in `corpusQueryText`.
 * Before building a DF table, a scheduled refresh and a cache, one number
 * decides whether any of it can pay: **on how many real queries is term
 * SELECTION even reachable?** Three populations cannot move no matter how good
 * the ranking is —
 *
 *   • `id-shortcircuit` — an id-prefixed token wins outright and is used ALONE
 *     (`corpusQueryText`'s documented near-unique retrieval key). No selection.
 *   • `too-few`         — ≤ `CORPUS_QUERY_MAX_TERMS` candidate terms, so
 *     `slice(0, maxTerms)` keeps all of them in any order. No selection.
 *   • `empty`           — no candidate terms at all.
 *
 * Only `addressable` (more candidates than slots, no id) can change. Reporting
 * that split first is the D-063 discipline applied one layer earlier: D-063 was
 * about running an instrument that does not execute the code under test; this
 * is about not building a mechanism whose reachable population is unmeasured.
 *
 * ⚠ THIS CORRECTS A STALE ATTRIBUTION in `corpus-leg-lexical-acceptance-cli.ts`.
 * That CLI reports how many 5-term queries are byte-identical to the 2-term
 * production shape and blames "`corpusQueryText`'s id-token short-circuit
 * (P-007/WI-7237) ignores `maxTerms`". WI-7237's bare-number branch was FIXED
 * (`ID_PREFIXED_TOKEN_RE`, 2026-08-03) and the ratio did not move — so the
 * short-circuit was never the main cause. This probe separates the two causes
 * instead of asserting one.
 *
 * ─── THE DF SIGNAL IS BUILT WITH `corpusTerms`, NOT `ts_stat` ────────────────
 *
 * Deliberate, and the single most important design point here. `ts_stat`
 * returns STEMMED lexemes, while `corpusQueryText` selects over RAW tokens from
 * `corpusTerms`. Looking a raw token up in a lexeme table MISSES whenever the
 * stem differs ("sessions"→"session", "queries"→"queri"), and a miss reads as
 * df 0 ⇒ MAXIMAL idf ⇒ "rarest". That is exactly backwards: the most common
 * plural words in the corpus would be selected first, making the change worse
 * than the length proxy it replaces. Building DF with `corpusTerms` itself
 * guarantees the tokenizer matches by construction.
 *
 * DF is a RANKING signal, so a sample is sufficient — relative frequencies of
 * common terms are stable long before absolute counts converge.
 */
import { getOrgPg } from '@papercusp/db-org';

import { corpusTerms, CORPUS_QUERY_MAX_TERMS } from '../corpus-recall';
import { refreshCorpusTermDf } from '../corpus-term-df';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const QUERIES = Number(argValue('--queries') ?? 400);
const DF_SAMPLE = Number(argValue('--df-sample') ?? 40_000);
const SEED = argValue('--seed') ?? '17';
/** Minimum corpus document frequency for a term to be worth a query slot. */
const MIN_DF = Number(argValue('--min-df') ?? 2);
const WORKSPACE = argValue('--workspace') ?? 'papercusp-workspace';

/** The subset of terms allowed to short-circuit selection — mirrors
 *  `ID_PREFIXED_TOKEN_RE` in corpus-recall.ts. Detected behaviourally here so
 *  this probe needs no production change to run. */
const ID_PREFIXED = /^[a-z]{1,3}-\d{2,}$/;

type Bucket = 'empty' | 'id-shortcircuit' | 'too-few' | 'addressable';

function classify(text: string): { bucket: Bucket; terms: string[] } {
  const terms = corpusTerms(text);
  if (terms.length === 0) return { bucket: 'empty', terms };
  if (terms.some((t) => ID_PREFIXED.test(t))) return { bucket: 'id-shortcircuit', terms };
  if (terms.length <= CORPUS_QUERY_MAX_TERMS) return { bucket: 'too-few', terms };
  return { bucket: 'addressable', terms };
}

/** BM25 idf, the same form as `buildInvertedIndex` in lexical-cursor.ts:394 —
 *  ln(1 + (N - df + 0.5)/(df + 0.5)). A term absent from the corpus has df 0 ⇒
 *  maximal idf, which is the correct prior for a genuinely novel token. */
function makeIdf(df: Map<string, number>, n: number): (t: string) => number {
  return (t: string) => {
    const d = df.get(t) ?? 0;
    return Math.log(1 + (n - d + 0.5) / (d + 0.5));
  };
}

/** Production selection, verbatim from corpusQueryText: longest first, ties by
 *  first appearance. */
function byLength(terms: string[], k: number): string[] {
  return [...terms]
    .sort((a, b) => b.length - a.length || terms.indexOf(a) - terms.indexOf(b))
    .slice(0, k);
}

/** P-018 AS LITERALLY PRESCRIBED: "keep the RAREST terms" — rarest first. */
function byIdf(terms: string[], k: number, idf: (t: string) => number): string[] {
  return [...terms]
    .sort((a, b) => idf(b) - idf(a) || terms.indexOf(a) - terms.indexOf(b))
    .slice(0, k);
}

/**
 * BANDED selection — rarest AMONG TERMS THE CORPUS ACTUALLY ATTESTS.
 *
 * Pure rarity selects hapax legomena: hex digests, uuids, session nonces, run
 * ids. Those are maximally "rare" precisely because they are unique noise, and
 * a term with df 0 cannot retrieve anything — under AND it empties the result
 * set outright. Rarity is a SCORING weight over documents that already matched;
 * using it to CHOOSE the query inverts it, so the naive form picks exactly the
 * terms guaranteed to match nothing.
 *
 * So: discard terms the corpus attests fewer than `minDf` times, then prefer
 * the rarest of what remains. If the filter empties the pool, fall back to
 * production's length ordering rather than querying on noise.
 */
function byBandedIdf(
  terms: string[],
  k: number,
  df: Map<string, number>,
  minDf: number,
): string[] {
  const attested = terms.filter((t) => (df.get(t) ?? 0) >= minDf);
  if (attested.length === 0) return byLength(terms, k);
  return [...attested]
    .sort(
      (a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0) || attested.indexOf(a) - attested.indexOf(b),
    )
    .slice(0, k);
}

/** Share of picked terms the corpus attests fewer than `minDf` times — i.e.
 *  how often a selector spends a slot on something that cannot retrieve. */
function unattestedShare(picks: string[][], df: Map<string, number>, minDf: number): number {
  const all = picks.flat();
  if (all.length === 0) return NaN;
  return all.filter((t) => (df.get(t) ?? 0) < minDf).length / all.length;
}

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);

async function main(): Promise<void> {
  const { sql } = getOrgPg();

  // `--refresh` rebuilds the REAL `corpus_term_df` table (what production
  // selects with) before probing. The `system:corpus-term-df` routine does this
  // on a 6h cadence; this is the manual trigger for a first population or an
  // immediate re-measure.
  if (process.argv.includes('--refresh')) {
    const r = await refreshCorpusTermDf(sql, {
      workspaceId: WORKSPACE,
      sampleDocs: DF_SAMPLE,
    });
    console.log(
      `refreshed corpus_term_df: ${r.ndocs} docs folded → ${r.stored} term(s) stored with df ≥ ${r.minDf} ` +
        `(dropped ${r.distinctSeen - r.stored} unattested of ${r.distinctSeen} distinct)\n`,
    );
  }

  // ── 1. Build the DF table over RAW corpusTerms tokens (see header). ────────
  const dfRows = (await sql`
    SELECT text
      FROM harness_shared.session_turns
     WHERE (workspace_id = ${WORKSPACE} OR workspace_id = 'default')
       AND length(text) BETWEEN 40 AND 20000
     ORDER BY md5(source_kind || session_id || turn_idx::text || ${SEED} || 'df')
     LIMIT ${DF_SAMPLE}
  `) as unknown as Array<{ text: string }>;

  const df = new Map<string, number>();
  for (const row of dfRows) {
    // corpusTerms already de-duplicates within a document, so each hit is one
    // DOCUMENT frequency increment — not a term frequency.
    for (const t of corpusTerms(row.text)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = dfRows.length;
  const idf = makeIdf(df, N);

  // ── 2. The SAME query sample the lexical-acceptance CLI uses. ──────────────
  const rows = (await sql`
    SELECT text
      FROM harness_shared.session_turns
     WHERE (workspace_id = ${WORKSPACE} OR workspace_id = 'default')
       AND speaker = 'user'
       AND length(text) BETWEEN 200 AND 8000
     ORDER BY md5(source_kind || session_id || turn_idx::text || ${SEED})
     LIMIT ${QUERIES}
  `) as unknown as Array<{ text: string }>;

  const buckets: Record<Bucket, number> = {
    empty: 0,
    'id-shortcircuit': 0,
    'too-few': 0,
    addressable: 0,
  };
  let changed = 0;
  let changedTop1 = 0;
  let bandedChanged = 0;
  const examples: string[] = [];
  const candidateCounts: number[] = [];
  const lenPicks: string[][] = [];
  const idfPicks: string[][] = [];
  const bandedPicks: string[][] = [];

  for (const { text } of rows) {
    const { bucket, terms } = classify(text);
    buckets[bucket] += 1;
    if (bucket !== 'addressable') continue;
    candidateCounts.push(terms.length);

    const lenPick = byLength(terms, CORPUS_QUERY_MAX_TERMS);
    const idfPick = byIdf(terms, CORPUS_QUERY_MAX_TERMS, idf);
    const bandedPick = byBandedIdf(terms, CORPUS_QUERY_MAX_TERMS, df, MIN_DF);
    lenPicks.push(lenPick);
    idfPicks.push(idfPick);
    bandedPicks.push(bandedPick);

    if (lenPick.join(' ') !== bandedPick.join(' ')) bandedChanged += 1;
    if (lenPick.join(' ') !== idfPick.join(' ')) {
      changed += 1;
      if (lenPick[0] !== idfPick[0]) changedTop1 += 1;
      if (examples.length < 10) {
        const show = (ts: string[]) =>
          ts.map((t) => `${t}(df=${df.get(t) ?? 0},len=${t.length})`).join(' ');
        examples.push(
          `  length: ${show(lenPick)}\n  idf   : ${show(idfPick)}\n  banded: ${show(bandedPick)}`,
        );
      }
    }
  }

  const addressable = buckets.addressable;
  const total = rows.length;
  const L: string[] = [];
  L.push('# P-018 — is term SELECTION reachable? (addressable-population probe)');
  L.push('');
  L.push(
    `DF built from ${N.toLocaleString()} corpus documents via \`corpusTerms\` (tokenizer-matched, NOT ts_stat) · ${df.size.toLocaleString()} distinct terms · query sample n=${total}, seed=${SEED}`,
  );
  L.push('');
  L.push('| population | n | share | can term-selection change it? |');
  L.push('|---|---|---|---|');
  L.push(`| \`empty\` | ${buckets.empty} | ${pct(buckets.empty, total)} | no — no terms |`);
  L.push(
    `| \`id-shortcircuit\` | ${buckets['id-shortcircuit']} | ${pct(buckets['id-shortcircuit'], total)} | no — the id is used ALONE |`,
  );
  L.push(
    `| \`too-few\` | ${buckets['too-few']} | ${pct(buckets['too-few'], total)} | no — ≤${CORPUS_QUERY_MAX_TERMS} candidates, all kept |`,
  );
  L.push(
    `| **\`addressable\`** | **${addressable}** | **${pct(addressable, total)}** | **YES — more candidates than slots** |`,
  );
  L.push('');
  L.push(
    `- P-018's CEILING is the addressable share: **${pct(addressable, total)}** of real queries. Nothing outside it can move, at any DF quality.`,
  );
  if (addressable > 0) {
    const meanCand = candidateCounts.reduce((a, b) => a + b, 0) / candidateCounts.length;
    L.push(`- addressable queries carry a mean of ${meanCand.toFixed(1)} candidate terms`);
    L.push(
      `- idf picks a DIFFERENT pair than length on **${changed}/${addressable}** addressable queries (${pct(changed, addressable)}) — i.e. ${pct(changed, total)} of ALL queries`,
    );
    L.push(
      `- the FIRST (highest-weight) term differs on **${changedTop1}/${addressable}** (${pct(changedTop1, addressable)})`,
    );
    L.push('');
    L.push('### does the selector spend its slots on terms that CAN retrieve?');
    L.push('');
    L.push(`| selector | picked terms with df < ${MIN_DF} | changes the query vs length |`);
    L.push('|---|---|---|');
    const fmt = (x: number) => `${(100 * x).toFixed(1)}%`;
    L.push(
      `| \`length\` (production today) | ${fmt(unattestedShare(lenPicks, df, MIN_DF))} | — |`,
    );
    L.push(
      `| \`idf\` (P-018 as prescribed: rarest) | ${fmt(unattestedShare(idfPicks, df, MIN_DF))} | ${pct(changed, addressable)} |`,
    );
    L.push(
      `| \`banded\` (rarest with df ≥ ${MIN_DF}) | ${fmt(unattestedShare(bandedPicks, df, MIN_DF))} | ${pct(bandedChanged, addressable)} |`,
    );
    L.push('');
    L.push(
      `⚠ **A term with df < ${MIN_DF} cannot retrieve.** Under \`plainto_tsquery\`'s AND it empties the result set outright; even in the graded cascade it contributes no coverage. So the middle row is not "more aggressive tuning" — it is the selector spending its slots on hex digests, uuids and session nonces, which are maximally rare precisely because they are unique NOISE. Rarity is a SCORING weight applied to documents that already matched; using it to CHOOSE the query inverts it.`,
    );
  }
  if (examples.length) {
    L.push('');
    L.push('### where the two rankings disagree');
    L.push('```');
    L.push(examples.join('\n\n'));
    L.push('```');
  }
  L.push('');
  L.push(
    '⚠ A DIFFERENT query is not a BETTER query. This probe bounds how much P-018 could matter and shows which way the rankings disagree; whether the rarer term retrieves something more useful is a RELEVANCE question this probe deliberately does not answer (D-063 R4).',
  );

  console.log(L.join('\n'));
  await sql.end({ timeout: 5 });
}

void main();
