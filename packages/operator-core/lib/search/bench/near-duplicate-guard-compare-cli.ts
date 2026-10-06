/**
 * near-duplicate-guard-compare-cli — run the R-8 comparison of
 * shared-vector-search-libraries-2026-09-29 P-004 (WI-10004273) against the
 * operator database and write the committed evidence file.
 *
 *   npx tsx packages/operator-core/lib/search/bench/near-duplicate-guard-compare-cli.ts \
 *     [--out docs/evidence/shared-vector-search-libraries-2026-09-29/p004-dupe-guard-comparison.json] \
 *     [--per-stratum 260] [--unlabelled 150]
 *
 * POPULATION (all in one workspace + harness, both items embedded in one mode):
 *  - labelled pairs from harness_shared.dedup_adjudications (the admission
 *    promoter's model adjudications; latest verdict per unordered pair):
 *    r-finding-merge -> duplicate, distinct, r-related -> related,
 *    r-remedy-keep -> remedy-keep;
 *  - closed-as-duplicate: dropped items whose terminal_reason names a survivor
 *    ("duplicate of WI-…/EI-…") and whose pair the ledger never judged;
 *  - unlabelled: a deterministic sample of recent real filings, to measure how
 *    often each approach fires at all.
 * For a labelled pair the FILING is the later-created item and the PARTNER the
 * earlier one; the pair is kept only if the partner was still open when the
 * filing was created (the guard screens against open items only).
 *
 * POOL (per filing, reconstructed as the guard would have seen it at creation):
 * same workspace + harness + embedding mode, created before the filing, and not
 * in a terminal status by then (closed_ts, falling back to updated_ts).
 * Two arms are read from that ONE pool in one SQL statement per filing, so the
 * guard's before/after comparison uses the same labelled sample and the same
 * live database snapshot per pair:
 *  - current: the shipped guard, which excludes observation-lane rows before
 *    top-k (WI-10004338). Every approach (current, library, hybrid) runs here.
 *  - previous: the same pool WITHOUT the observation filter, i.e. the guard as
 *    it ran before WI-10004338. Only the current guard is scored on it.
 * The observation filter must be applied per arm, never in the shared pool CTE:
 * filtering the pool made both arms identical and the run reported a vacuous
 * delta of 0 (WI-10005217). pairedArmDivergence() now refuses such a run.
 * Cosines are exact (no ANN index), over the vectors stored today.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { dupeThresholds } from '../../agent-tools/work_items/semantic-dupe-guard';
import { ALL_TERMINAL_STATUSES } from '../../work-item-blocking';
import { observationLaneExclusionSql } from '../../work-items';
import {
  classifyWithCurrentGuard,
  classifyWithHybrid,
  classifyWithLibrary,
  GUARD_CANDIDATE_LIMIT,
  HYBRID_TITLE_FLOOR,
  pairedArmDivergence,
  summarizeComparison,
  type FilingObservation,
  type PairLabel,
  type ScoredObservation,
} from './near-duplicate-guard-compare';
import { DEFAULT_BACKGROUND_SAMPLE_LIMIT, DEFAULT_NEAR_DUPLICATE_QUANTILE } from '../../../../../libs/generic/search/src/near-duplicate';

const WORKSPACE = process.env.PAPERCUSP_WORKSPACE ?? 'papercusp-workspace';
const HARNESS = process.env.PAPERCUSP_HARNESS ?? 'papercusp';
const DEFAULT_OUT = 'docs/evidence/shared-vector-search-libraries-2026-09-29/p004-dupe-guard-comparison.json';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function intArg(name: string, dflt: number): number {
  const raw = arg(name);
  if (raw === undefined) return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer; got ${raw}`);
  return n;
}

interface PairRow {
  filing_id: string;
  partner_id: string | null;
  filing_title: string;
  label: PairLabel;
}

const VERDICT_LABEL: Record<string, PairLabel> = {
  'r-finding-merge': 'duplicate',
  distinct: 'distinct',
  'r-related': 'related',
  'r-remedy-keep': 'remedy-keep',
};

async function selectPairs(perStratum: number, unlabelled: number): Promise<PairRow[]> {
  const { sql } = getOrgPg();
  const terminal = [...ALL_TERMINAL_STATUSES];
  // "older still open when newer was filed", the guard's own screening scope.
  const adjudicated = await sql<Array<{ filing_id: string; partner_id: string; filing_title: string; verdict: string }>>`
    WITH latest AS (
      SELECT DISTINCT ON (LEAST(a, b), GREATEST(a, b)) a, b, verdict
        FROM harness_shared.dedup_adjudications
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
       ORDER BY LEAST(a, b), GREATEST(a, b), judged_at DESC
    ), pairs AS (
      SELECT l.verdict,
             CASE WHEN x.created_ts >= y.created_ts THEN x ELSE y END AS newer,
             CASE WHEN x.created_ts >= y.created_ts THEN y ELSE x END AS older
        FROM latest l
        JOIN harness_shared.work_items x ON x.workspace_id = ${WORKSPACE} AND x.feature_id = l.a
        JOIN harness_shared.work_items y ON y.workspace_id = ${WORKSPACE} AND y.feature_id = l.b
       WHERE x.embedding IS NOT NULL AND y.embedding IS NOT NULL AND x.embedding_mode = y.embedding_mode
    )
    SELECT (newer).feature_id AS filing_id, (older).feature_id AS partner_id,
           COALESCE((newer).title, '') AS filing_title, verdict
      FROM pairs
     WHERE (older).created_ts < (newer).created_ts
       AND NOT (COALESCE((older).status, '') = ANY(${terminal}::text[])
                AND COALESCE((older).closed_ts, (older).updated_ts) <= (newer).created_ts)
     ORDER BY verdict, md5((newer).feature_id || ':' || (older).feature_id)`;
  const closedAsDuplicate = await sql<Array<{ filing_id: string; partner_id: string; filing_title: string }>>`
    WITH named AS (
      SELECT d.feature_id AS did, s.feature_id AS sid,
             CASE WHEN d.created_ts >= s.created_ts THEN d ELSE s END AS newer,
             CASE WHEN d.created_ts >= s.created_ts THEN s ELSE d END AS older
        FROM harness_shared.work_items d
        JOIN harness_shared.work_items s
          ON s.workspace_id = d.workspace_id
         AND s.feature_id = substring(d.terminal_reason from '^duplicate of ((?:WI|EI)-[0-9]+)')
       WHERE d.workspace_id = ${WORKSPACE} AND d.harness_slug = ${HARNESS}
         AND d.status = 'dropped' AND d.lane IS DISTINCT FROM 'observation'
         AND d.embedding IS NOT NULL AND s.embedding IS NOT NULL AND d.embedding_mode = s.embedding_mode
    )
    SELECT (newer).feature_id AS filing_id, (older).feature_id AS partner_id, COALESCE((newer).title, '') AS filing_title
      FROM named n
     WHERE (older).created_ts < (newer).created_ts
       AND NOT (COALESCE((older).status, '') = ANY(${terminal}::text[])
                AND COALESCE((older).closed_ts, (older).updated_ts) <= (newer).created_ts)
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.dedup_adjudications j
          WHERE j.workspace_id = ${WORKSPACE} AND j.harness_slug = ${HARNESS}
            AND LEAST(j.a, j.b) = LEAST(n.did, n.sid) AND GREATEST(j.a, j.b) = GREATEST(n.did, n.sid))
     ORDER BY md5((newer).feature_id || ':' || (older).feature_id)`;
  const random = await sql<Array<{ filing_id: string; filing_title: string }>>`
    SELECT feature_id AS filing_id, COALESCE(title, '') AS filing_title
      FROM harness_shared.work_items
     WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
       AND lane IS DISTINCT FROM 'observation' AND embedding IS NOT NULL
       AND created_ts > (EXTRACT(EPOCH FROM now() - interval '45 days') * 1000)::bigint
     ORDER BY md5(feature_id || ':p004-r8')
     LIMIT ${unlabelled}`;

  const out: PairRow[] = [];
  const perLabel = new Map<PairLabel, number>();
  for (const r of adjudicated) {
    const label = VERDICT_LABEL[r.verdict];
    if (!label) continue;
    const n = perLabel.get(label) ?? 0;
    if (n >= perStratum) continue;
    perLabel.set(label, n + 1);
    out.push({ filing_id: r.filing_id, partner_id: r.partner_id, filing_title: r.filing_title, label });
  }
  for (const r of closedAsDuplicate.slice(0, perStratum)) out.push({ ...r, label: 'closed-as-duplicate' });
  for (const r of random) out.push({ ...r, partner_id: null, label: 'unlabelled' });
  return out;
}

interface PairedPoolObservation {
  /** Historical behavior: observations were allowed into the top-k candidate pool. */
  previous: FilingObservation;
  /** Current behavior: D-005 excludes observation-lane candidates before top-k. */
  current: FilingObservation;
}

async function observe(row: PairRow): Promise<PairedPoolObservation | null> {
  const { sql } = getOrgPg();
  const terminal = [...ALL_TERMINAL_STATUSES];
  const partner = row.partner_id ?? '';
  const [r] = await sql<Array<{
    found: boolean;
    pool_size: number;
    previous_pool_size: number;
    top: Array<{ id: string; title: string; cosine: number; titleSimilarity: number }>;
    previous_top: Array<{ id: string; title: string; cosine: number; titleSimilarity: number }>;
    background: number[];
    partner: { cosine: number; titleSimilarity: number; rank: number } | null;
    previous_partner: { cosine: number; titleSimilarity: number; rank: number } | null;
  }>>`
    WITH f AS (
      SELECT feature_id, harness_slug, COALESCE(title, '') AS title, created_ts, embedding, embedding_mode
        FROM harness_shared.work_items
       WHERE workspace_id = ${WORKSPACE} AND feature_id = ${row.filing_id} AND embedding IS NOT NULL
    ), pool AS MATERIALIZED (
      SELECT p.feature_id, COALESCE(p.title, '') AS title, p.lane,
             1 - (p.embedding <=> f.embedding) AS cosine
        FROM harness_shared.work_items p, f
       WHERE p.workspace_id = ${WORKSPACE}
         AND p.harness_slug = f.harness_slug
         AND p.embedding IS NOT NULL
         AND p.embedding_mode = f.embedding_mode
         AND p.feature_id <> f.feature_id
         AND p.created_ts < f.created_ts
         -- NO lane filter here: the previous arm reads this pool unfiltered, and the
         -- current arm applies observationLaneExclusionSql itself (WI-10005217).
         AND NOT (COALESCE(p.status, '') = ANY(${terminal}::text[])
                  AND COALESCE(p.closed_ts, p.updated_ts) <= f.created_ts)
    ), top AS (
      SELECT feature_id, title, cosine FROM pool p
       WHERE ${observationLaneExclusionSql(sql, 'payload')}
       ORDER BY cosine DESC, feature_id LIMIT ${GUARD_CANDIDATE_LIMIT}
    ), previous_top AS (
      SELECT feature_id, title, cosine FROM pool ORDER BY cosine DESC, feature_id LIMIT ${GUARD_CANDIDATE_LIMIT}
    )
    SELECT EXISTS (SELECT 1 FROM f) AS found,
           (SELECT count(*) FROM pool p WHERE ${observationLaneExclusionSql(sql, 'payload')})::int AS pool_size,
           (SELECT count(*) FROM pool)::int AS previous_pool_size,
           (SELECT COALESCE(json_agg(json_build_object(
                     'id', t.feature_id, 'title', t.title, 'cosine', t.cosine,
                     'titleSimilarity', similarity(t.title, (SELECT title FROM f)))
                   ORDER BY t.cosine DESC, t.feature_id), '[]'::json) FROM top t) AS top,
           (SELECT COALESCE(json_agg(json_build_object(
                     'id', t.feature_id, 'title', t.title, 'cosine', t.cosine,
                     'titleSimilarity', similarity(t.title, (SELECT title FROM f)))
                   ORDER BY t.cosine DESC, t.feature_id), '[]'::json) FROM previous_top t) AS previous_top,
           (SELECT COALESCE(json_agg(b.cosine), '[]'::json) FROM (
              SELECT cosine FROM pool p
               WHERE ${observationLaneExclusionSql(sql, 'payload')}
                 AND feature_id NOT IN (SELECT feature_id FROM top)
               ORDER BY md5(feature_id || ':' || ${row.filing_id}) LIMIT ${DEFAULT_BACKGROUND_SAMPLE_LIMIT}) b) AS background,
           (SELECT json_build_object(
                     'cosine', pp.cosine,
                     'titleSimilarity', similarity(pp.title, (SELECT title FROM f)),
                     'rank', 1 + (SELECT count(*) FROM pool q WHERE ${observationLaneExclusionSql(sql, 'payload')} AND q.cosine > pp.cosine))
              FROM pool pp WHERE ${observationLaneExclusionSql(sql, 'payload')} AND pp.feature_id = ${partner}) AS partner,
           (SELECT json_build_object(
                     'cosine', pp.cosine,
                     'titleSimilarity', similarity(pp.title, (SELECT title FROM f)),
                     'rank', 1 + (SELECT count(*) FROM pool q WHERE q.cosine > pp.cosine))
              FROM pool pp WHERE pp.feature_id = ${partner}) AS previous_partner`;
  if (!r || !r.found) return null;
  return {
    current: {
      filingId: row.filing_id,
      partnerId: row.partner_id,
      label: row.label,
      poolSize: r.pool_size,
      top: r.top,
      background: r.background,
      partner: r.partner,
    },
    previous: {
      filingId: row.filing_id,
      partnerId: row.partner_id,
      label: row.label,
      poolSize: r.previous_pool_size,
      top: r.previous_top,
      background: [],
      partner: r.previous_partner,
    },
  };
}

function gitBlob(path: string): string | null {
  try {
    return execFileSync('git', ['hash-object', path], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function round(n: number, d = 4): number {
  const s = 10 ** d;
  return Math.round(n * s) / s;
}

async function main(): Promise<void> {
  const out = arg('--out') ?? DEFAULT_OUT;
  const perStratum = intArg('--per-stratum', 260);
  const unlabelled = intArg('--unlabelled', 150);
  const started = Date.now();
  const pairs = await selectPairs(perStratum, unlabelled);
  const thresholds = dupeThresholds();
  const scored: ScoredObservation[] = [];
  const previousPoolScored: ScoredObservation[] = [];
  const pairedObservations: PairedPoolObservation[] = [];
  const skipped: Array<{ filingId: string; reason: string }> = [];
  for (const [i, row] of pairs.entries()) {
    const paired = await observe(row);
    if (!paired) {
      skipped.push({ filingId: row.filing_id, reason: 'filing-not-found-or-unembedded' });
      continue;
    }
    pairedObservations.push(paired);
    const current = await classifyWithCurrentGuard(paired.current, row.filing_title, HARNESS);
    const previousCurrent = await classifyWithCurrentGuard(paired.previous, row.filing_title, HARNESS);
    const library = await classifyWithLibrary(paired.current);
    const hybrid = classifyWithHybrid(paired.current, library, thresholds.hard);
    scored.push({ obs: paired.current, verdicts: { current, library, hybrid } });
    previousPoolScored.push({
      obs: paired.previous,
      verdicts: {
        current: previousCurrent,
        library: { flagged: [], noVerdict: true },
        hybrid: { flagged: [], noVerdict: true },
      },
    });
    if ((i + 1) % 50 === 0) console.error(`R8_PROGRESS ${i + 1}/${pairs.length} ${Math.round((Date.now() - started) / 1000)}s`);
  }
  const divergence = pairedArmDivergence(pairedObservations);
  const summary = summarizeComparison(scored);
  const previousPoolCurrent = summarizeComparison(previousPoolScored).find((s) => s.approach === 'current')!;
  const currentSummary = summary.find((s) => s.approach === 'current')!;
  const libCuts = scored.map((s) => s.verdicts.library.cut).filter((c): c is number => c !== undefined).sort((a, b) => a - b);
  const pct = (q: number) => (libCuts.length ? round(libCuts[Math.min(libCuts.length - 1, Math.floor(q * libCuts.length))]!) : null);
  const result = {
    generatedAt: new Date().toISOString(),
    plan: 'shared-vector-search-libraries-2026-09-29',
    item: 'P-004',
    spec: 'AUTO-BAR-R-8-P-004',
    workItem: 'WI-10004273',
    workspace: WORKSPACE,
    harness: HARNESS,
    sources: {
      guard: { path: 'packages/operator-core/lib/agent-tools/work_items/semantic-dupe-guard.ts', blob: gitBlob('packages/operator-core/lib/agent-tools/work_items/semantic-dupe-guard.ts') },
      library: { path: 'libs/generic/search/src/near-duplicate.ts', blob: gitBlob('libs/generic/search/src/near-duplicate.ts') },
      comparison: { path: 'packages/operator-core/lib/search/bench/near-duplicate-guard-compare.ts', blob: gitBlob('packages/operator-core/lib/search/bench/near-duplicate-guard-compare.ts') },
      cli: { path: 'packages/operator-core/lib/search/bench/near-duplicate-guard-compare-cli.ts', blob: gitBlob('packages/operator-core/lib/search/bench/near-duplicate-guard-compare-cli.ts') },
    },
    approaches: {
      current: `production semantic-dupe-guard, run through findSemanticDupes with the historical top-${GUARD_CANDIDATE_LIMIT}: refuse when cosine >= ${thresholds.hard} or (cosine >= 0.86 and pg_trgm title similarity >= 0.45)`,
      library: `@papercusp/search checkNearDuplicates over the same top-${GUARD_CANDIDATE_LIMIT}: refuse when cosine >= the p${Math.round(DEFAULT_NEAR_DUPLICATE_QUANTILE * 100)} of the filing's cosine to ${DEFAULT_BACKGROUND_SAMPLE_LIMIT} other open items; no verdict below 32 background samples`,
      hybrid: `HYPOTHETICAL (no production code): refuse when cosine >= ${thresholds.hard} or (cosine >= the library cut and pg_trgm title similarity >= ${HYBRID_TITLE_FLOOR})`,
    },
    definitions: {
      missedDuplicate: 'a duplicate-labelled pair whose earlier item the approach did not refuse over',
      falseMerge: 'a distinct / related / remedy-keep pair whose earlier item the approach refused over',
      filing: 'the later-created item of a pair; the pair counts only if the earlier item was open when it was filed',
    },
    caveats: [
      'Labels are the admission promoter\'s model adjudications (dedup_adjudications), not human judgments; its candidate pairs were pre-selected by cosine >= 0.85, a shared title key or a shared condition key, so the labelled population over-represents high-cosine pairs for BOTH approaches.',
      'Vectors are the ones stored today (title + first 2000 chars of body); the guard embeds title + summary at create time, and some rows may have been re-embedded since filing.',
      'Openness at filing time uses closed_ts, falling back to updated_ts for terminal rows without closed_ts; a reopened item is treated by its current status.',
      'Observation-lane rows are excluded from the candidate pool per D-005; NULL lane values remain eligible.',
    ],
    counts: { pairsSelected: pairs.length, pairsObserved: scored.length, filingsObserved: new Set(scored.map((s) => s.obs.filingId)).size, skipped },
    libraryCut: { calibrated: libCuts.length, p05: pct(0.05), p50: pct(0.5), p95: pct(0.95) },
    poolSize: (() => {
      const sizes = scored.map((s) => s.obs.poolSize).sort((a, b) => a - b);
      return sizes.length ? { min: sizes[0], p50: sizes[Math.floor(sizes.length / 2)], max: sizes[sizes.length - 1] } : null;
    })(),
    candidatePoolFilterComparison: {
      method: 'paired current/unfiltered candidate pools read from the same SQL statement for every filing',
      pairs: pairs.length,
      divergence,
      previousUnfiltered: previousPoolCurrent,
      currentObservationExcluded: currentSummary,
      delta: {
        missedDuplicates: currentSummary.missedDuplicates - previousPoolCurrent.missedDuplicates,
        falseMerges: currentSummary.falseMerges - previousPoolCurrent.falseMerges,
      },
    },
    summary,
    rows: scored.map(({ obs, verdicts }, i) => ({
      filing: obs.filingId,
      partner: obs.partnerId,
      label: obs.label,
      poolSize: obs.poolSize,
      previous: {
        poolSize: previousPoolScored[i]!.obs.poolSize,
        top: previousPoolScored[i]!.obs.top.map((n) => n.id),
        flaggedCurrent: previousPoolScored[i]!.verdicts.current.noVerdict ? null : previousPoolScored[i]!.verdicts.current.flagged,
      },
      partnerCosine: obs.partner ? round(obs.partner.cosine) : null,
      partnerTitleSimilarity: obs.partner ? round(obs.partner.titleSimilarity) : null,
      partnerRank: obs.partner?.rank ?? null,
      top: obs.top.map((n) => ({ id: n.id, cosine: round(n.cosine), titleSimilarity: round(n.titleSimilarity) })),
      libraryCut: verdicts.library.cut === undefined ? null : round(verdicts.library.cut),
      flagged: {
        current: verdicts.current.noVerdict ? null : verdicts.current.flagged,
        library: verdicts.library.noVerdict ? null : verdicts.library.flagged,
        hybrid: verdicts.hybrid.flagged,
      },
    })),
    elapsedMs: Date.now() - started,
  };
  if (divergence.vacuous) {
    // WI-10005217: identical arms mean the observation filter leaked into the shared
    // pool (or the corpus has no observation rows at all). Either way the paired
    // delta is not a measurement, so refuse rather than publish "0 regressions".
    console.error(
      `R8_VACUOUS_PAIRED_COMPARISON ${JSON.stringify(divergence)} — the previous and current arms saw identical pools for every filing; nothing was written to ${out}`,
    );
    process.exitCode = 2;
    return;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    'R8_SUMMARY ' +
      JSON.stringify({
        out,
        pairs: scored.length,
        filings: result.counts.filingsObserved,
        headline: summary.map((s) => ({
          approach: s.approach,
          missedDuplicates: `${s.missedDuplicates}/${s.duplicatePairs}`,
          falseMerges: `${s.falseMerges}/${s.nonDuplicatePairs}`,
        })),
        libraryCut: result.libraryCut,
      }),
  );
}

main()
  .then(async () => {
    await getOrgPg()
      .sql.end?.()
      .catch(() => null);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
