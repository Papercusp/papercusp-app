/**
 * doc-section-overlap — the papercusp host binding for @papercusp/overlap-clusters.
 *
 * P-003 of guidance-overlap-contradiction-scan-2026-08-08 (workstream C).
 * The generic module owns thresholding, cross-group filtering, clustering and
 * the census; it knows nothing about doc_sections. This file supplies the two
 * things only the host can: the units, and an ANN-backed neighbour provider
 * over the migration-552 HNSW cosine index.
 *
 * ## Three properties this file exists to get right
 *
 * **1. One embedding space, always.** Cosine between vectors from two different
 * embedders is noise, not dissimilarity — semantic-leg.ts states the same rule
 * for docs:search. Every query here filters on the embedding mode. Measured
 * 2026-08-08 the whole corpus is a single "gemma" space (6520 engineering +
 * 3536 guidance sections, 100% vectorised), so the filter is currently a no-op
 * — which is exactly why it must be written down now rather than added after a
 * second space silently corrupts a sweep.
 *
 * **2. The unit is a SECTION, the group is a PAGE.** A page's own sections are
 * near-identical to each other by construction, and at top-K they crowd out
 * every real finding. Deriving the group from source+slug makes the generic
 * module's crossGroupOnly rule drop them for free, so "same page, different
 * anchor" can never reach a report.
 *
 * **3. An absolute cosine is NOT interpretable — calibrate against the null.**
 * This is the load-bearing one. The instinct is to pick a threshold like 0.80
 * and call anything above it a duplicate. Measured on this corpus that flags
 * ~78% of top-5 neighbour pairs, because gemma's random-pair distribution sits
 * at a median of ~0.62 and its p99.9 is ~0.84. A threshold is only meaningful
 * as a position in the NULL distribution of the source pair it is applied to,
 * and those distributions differ: guidance-vs-engineering random pairs run a
 * full 0.06 lower than engineering-vs-engineering ones. measureNullBaseline()
 * produces that per-source-pair null so a threshold can be chosen from evidence
 * and re-derived when the embedder changes. Hard-coding a number carried over
 * from another corpus or another model is the failure this function prevents.
 */

import { getOrgPg } from '@papercusp/db-org';
import { withIterativeScan, type PgHandle } from '@papercusp/search';
import {
  configureOverlapScan,
  scanOverlap,
  type NeighbourHit,
  type NeighbourProvider,
  type OverlapCensus,
  type OverlapPair,
  type OverlapScanReport,
  type OverlapUnit,
} from '@papercusp/overlap-clusters';
import {
  proseProfilePredicateSql,
  resolveCurrentProseProfileSelection,
  resolveProseProfileIdSelection,
  type ProseProfileSelection,
} from './prose-vector-dims';

/** The two synced corpora workstream C scans. */
export const DOC_OVERLAP_SOURCES = ['papercusp-guidance', 'papercusp-engineering'] as const;
export type DocOverlapSource = (typeof DOC_OVERLAP_SOURCES)[number];

/** A section's identity, round-trippable through the generic module's id string. */
export interface DocSectionRef {
  sourceKey: string;
  slug: string;
  anchor: string;
}

/**
 * The id delimiter: the six literal characters backslash-u-0-0-1-f.
 *
 * NOT a punctuation mark, because slugs contain slashes and dots and anchors
 * contain hyphens, so any printable single-character delimiter would eventually
 * appear inside a field and split an id into the wrong number of parts —
 * silently, and only for the documents whose names happen to contain it.
 *
 * NOT a raw 0x1F byte either, even though that is what the sequence names. A
 * literal control byte in a .ts source file trips lint:no-control-bytes (a
 * green-checkpoint leg) and makes the file read as binary to grep, so the
 * escape-shaped LITERAL is deliberately what gets stored. It is exactly as
 * safe: no doc slug or heading anchor contains a backslash — measured against
 * the live corpus 2026-08-08, 0 of 10,056 embedded sections carry one.
 */
const SEP = '\\u001f';

/** Encode a section ref as an opaque unit id. */
export function encodeSectionId(ref: DocSectionRef): string {
  return `${ref.sourceKey}${SEP}${ref.slug}${SEP}${ref.anchor}`;
}

/**
 * Decode a unit id back to its section ref. Returns null for anything not
 * produced by encodeSectionId.
 *
 * ## What is invalid, and what merely LOOKS invalid
 *
 * The part COUNT is the real discriminator: SEP is a six-character sequence no
 * field in this corpus contains (measured above), so a string the encoder did
 * not produce does not split into exactly three parts.
 *
 * An empty **sourceKey** is genuinely invalid — a unit with no source cannot be
 * attributed to a corpus, and every threshold in this scan is chosen per source
 * PAIR, so an unattributable unit has no threshold.
 *
 * An empty **slug** is NOT invalid: it is the corpus ROOT page. This guard used
 * to reject it, and the first live run of the scan died on the id for
 * `papercusp-engineering` with empty slug and anchor — five real embedded
 * sections of the engineering root doc, each with a title and 292-1069 chars of
 * content. The encoder emitted those ids happily from live rows while the
 * decoder refused them, so the pair was never round-trip-safe on its own
 * corpus. All 17 unit tests passed throughout, because every one supplied a
 * hand-written slug: fixtures agree with you, the corpus does not. An empty
 * ANCHOR was already accepted for exactly the same reason (a page preamble —
 * 417 real sections have one), and that asymmetry is what made this easy to
 * miss.
 */
export function decodeSectionId(id: string): DocSectionRef | null {
  const parts = id.split(SEP);
  if (parts.length !== 3) return null;
  const [sourceKey, slug, anchor] = parts;
  if (!sourceKey) return null;
  return { sourceKey, slug: slug ?? '', anchor: anchor ?? '' };
}

/**
 * The GROUP a unit belongs to: its page. Two sections of one page are the same
 * group, so crossGroupOnly drops the same-page-different-anchor pairs that
 * otherwise dominate top-K. Distinct pages are distinct groups even within one
 * source — "two different documents say the same thing" is the finding.
 */
export function pageGroupOf(ref: DocSectionRef): string {
  return `${ref.sourceKey}::${ref.slug}`;
}

/**
 * What `loadUnits` found. The un-vectorised count is returned ALONGSIDE the
 * units rather than filtered away, because a query that drops unusable rows
 * destroys the only evidence that they existed: the caller then computes a
 * numerator and a denominator from the same filtered population and gets a
 * ratio that is structurally 1.0 no matter how much of the corpus is missing.
 */
export interface DocOverlapUnitLoad {
  units: OverlapUnit[];
  /** Sections in scope whose embedding has not been written yet. */
  unavailable: number;
}

/** Injectable seam — tests and any future non-552 store. */
export interface DocOverlapDeps {
  /** Every section in the given sources and space, split into vectorised and not. */
  loadUnits: (
    sources: readonly string[],
    mode: string,
    selection: ProseProfileSelection,
  ) => Promise<DocOverlapUnitLoad>;
  /** ANN neighbours of one section, excluding its own page. */
  neighboursOf: (
    ref: DocSectionRef,
    sources: readonly string[],
    mode: string,
    limit: number,
    selection: ProseProfileSelection,
  ) => Promise<NeighbourHit[]>;
  /** Sampled cosine between unrelated pairs, per ordered source pair. */
  sampleNullPairs: (
    sources: readonly string[],
    mode: string,
    sampleSize: number,
    selection: ProseProfileSelection,
  ) => Promise<NullPairSample[]>;
}

export interface NullPairSample {
  sourceA: string;
  sourceB: string;
  /** Pairs compared for this source pair — the denominator. */
  n: number;
  p50: number;
  p95: number;
  p99: number;
  p999: number;
  max: number;
}

async function loadUnitsReal(
  sources: readonly string[],
  mode: string,
  selection: ProseProfileSelection,
): Promise<DocOverlapUnitLoad> {
  const { sql } = getOrgPg();
  // The `embedding IS NOT NULL` test is deliberately a SELECTED COLUMN, not a
  // WHERE clause. As a predicate it silently shrinks the population and takes
  // the evidence of the shrinkage with it; as a column the shortfall is
  // counted and reported. Both numbers therefore come from ONE snapshot, so a
  // backfill running concurrently cannot make them disagree.
  const rows = await sql<Array<{ source_key: string; slug: string; anchor: string; has_vector: boolean }>>`
    SELECT source_key, slug, anchor, (embedding IS NOT NULL) AS has_vector
      FROM harness_shared.doc_sections
     WHERE source_key = ANY(${sources as string[]})
       AND ${proseProfilePredicateSql(sql, selection, 'embedding_profile', 'embedding_mode')}
     ORDER BY source_key, slug, anchor`;
  // The vector field is deliberately omitted: an ANN-backed provider never
  // reads it, and materialising ~10k x 768 floats into process memory just to
  // hand them straight back to Postgres would lose the whole point of having
  // an index.
  const units: OverlapUnit[] = [];
  let unavailable = 0;
  for (const r of rows) {
    if (!r.has_vector) {
      unavailable++;
      continue;
    }
    const ref = { sourceKey: r.source_key, slug: r.slug, anchor: r.anchor };
    units.push({ id: encodeSectionId(ref), group: pageGroupOf(ref) });
  }
  return { units, unavailable };
}

async function neighboursOfReal(
  ref: DocSectionRef,
  sources: readonly string[],
  mode: string,
  limit: number,
  selection: ProseProfileSelection,
): Promise<NeighbourHit[]> {
  const { sql } = getOrgPg();
  // The probe's own page is excluded HERE as well as by the generic module's
  // crossGroupOnly rule. Dropping it at the index means the row budget is
  // spent on candidates that can actually become findings, instead of being
  // eaten by the probe's sibling anchors before the filter ever runs.
  //
  // Iterative HNSW scan (WI-10004138): the source and same-page filters apply
  // after the capped scan, so a narrow source set came back short. Measured
  // 2026-09-30 with sources ['harness:papercusp'] over 10 probes: 81 of 100 rows
  // at LIMIT 10 and 158 of 250 at LIMIT 25 without it, all of them with it.
  const rows = (await withIterativeScan(sql as unknown as PgHandle, (handle) => {
    const sql = handle as unknown as ReturnType<typeof getOrgPg>['sql'];
    return sql<Array<{ source_key: string; slug: string; anchor: string; similarity: number }>>`
    WITH probe AS (
      SELECT embedding FROM harness_shared.doc_sections
       WHERE source_key = ${ref.sourceKey} AND slug = ${ref.slug} AND anchor = ${ref.anchor}
         AND ${proseProfilePredicateSql(sql, selection, 'embedding_profile', 'embedding_mode')}
       LIMIT 1
    )
    SELECT d.source_key, d.slug, d.anchor,
           1 - (d.embedding <=> (SELECT embedding FROM probe)) AS similarity
      FROM harness_shared.doc_sections d
     WHERE d.source_key = ANY(${sources as string[]})
       AND d.embedding IS NOT NULL
       AND ${proseProfilePredicateSql(sql, selection, 'd.embedding_profile', 'd.embedding_mode')}
       AND NOT (d.source_key = ${ref.sourceKey} AND d.slug = ${ref.slug})
     ORDER BY d.embedding <=> (SELECT embedding FROM probe)
     LIMIT ${limit}`;
  })) as unknown as Array<{ source_key: string; slug: string; anchor: string; similarity: number }>;
  return rows.map((r) => ({
    id: encodeSectionId({ sourceKey: r.source_key, slug: r.slug, anchor: r.anchor }),
    similarity: Number(r.similarity),
  }));
}

async function sampleNullPairsReal(
  sources: readonly string[],
  mode: string,
  sampleSize: number,
  selection: ProseProfileSelection,
): Promise<NullPairSample[]> {
  const { sql } = getOrgPg();
  // Two INDEPENDENT random draws, joined with the SAME page exclusion the scan
  // itself applies. A null that contained a page's own sections would be
  // inflated by exactly the structure the scan filters out, which would push
  // the chosen threshold up and hide real cross-page findings.
  const rows = await sql<
    Array<{ a_src: string; b_src: string; n: string; p50: number; p95: number; p99: number; p999: number; mx: number }>
  >`
    WITH a AS (
      SELECT source_key, slug, anchor, embedding FROM harness_shared.doc_sections
       WHERE source_key = ANY(${sources as string[]}) AND embedding IS NOT NULL
         AND ${proseProfilePredicateSql(sql, selection, 'embedding_profile', 'embedding_mode')}
       ORDER BY random() LIMIT ${sampleSize}
    ), b AS (
      SELECT source_key, slug, anchor, embedding FROM harness_shared.doc_sections
       WHERE source_key = ANY(${sources as string[]}) AND embedding IS NOT NULL
         AND ${proseProfilePredicateSql(sql, selection, 'embedding_profile', 'embedding_mode')}
       ORDER BY random() LIMIT ${sampleSize}
    ), pairs AS (
      SELECT a.source_key AS a_src, b.source_key AS b_src,
             1 - (a.embedding <=> b.embedding) AS sim
        FROM a JOIN b ON NOT (a.source_key = b.source_key AND a.slug = b.slug)
    )
    SELECT a_src, b_src, count(*)::text AS n,
           percentile_cont(0.5)   WITHIN GROUP (ORDER BY sim) AS p50,
           percentile_cont(0.95)  WITHIN GROUP (ORDER BY sim) AS p95,
           percentile_cont(0.99)  WITHIN GROUP (ORDER BY sim) AS p99,
           percentile_cont(0.999) WITHIN GROUP (ORDER BY sim) AS p999,
           max(sim) AS mx
      FROM pairs GROUP BY 1,2 ORDER BY 1,2`;
  return rows.map((r) => ({
    sourceA: r.a_src,
    sourceB: r.b_src,
    n: Number(r.n),
    p50: Number(r.p50),
    p95: Number(r.p95),
    p99: Number(r.p99),
    p999: Number(r.p999),
    max: Number(r.mx),
  }));
}

export const realDocOverlapDeps: DocOverlapDeps = {
  loadUnits: loadUnitsReal,
  neighboursOf: neighboursOfReal,
  sampleNullPairs: sampleNullPairsReal,
};

export interface DocOverlapOptions {
  sources?: readonly string[];
  /** The embedding space to scan. All comparisons happen inside it. */
  mode: string;
  /** Exact profile to scan. Omitted means this mode's declared current profile;
   * unknown/ineligible modes fail closed instead of falling back to mode-only. */
  profileId?: string;
  deps?: DocOverlapDeps;
}

function profileSelectionFor(opts: Pick<DocOverlapOptions, 'mode' | 'profileId'>): ProseProfileSelection {
  const selection = opts.profileId
    ? resolveProseProfileIdSelection(opts.profileId, opts.mode)
    : resolveCurrentProseProfileSelection(opts.mode);
  if (!selection) {
    throw new Error(
      `doc-section-overlap: no accepted prose profile for mode ${JSON.stringify(opts.mode)}` +
        (opts.profileId ? ` and profile ${JSON.stringify(opts.profileId)}` : ''),
    );
  }
  return selection;
}

/** Every section in the scanned sources, split into vectorised units and a shortfall count. */
export function loadDocSectionUnits(opts: DocOverlapOptions): Promise<DocOverlapUnitLoad> {
  const deps = opts.deps ?? realDocOverlapDeps;
  return deps.loadUnits(
    opts.sources ?? DOC_OVERLAP_SOURCES,
    opts.mode,
    profileSelectionFor(opts),
  );
}

/**
 * A NeighbourProvider backed by the migration-552 HNSW index.
 *
 * Fails CLOSED on an undecodable id. Returning an empty list would be
 * indistinguishable from "this section has no similar neighbours", which is the
 * single failure mode the generic module's census exists to make visible, and
 * swallowing it here would defeat that census one layer below where it can see.
 */
export function createDocSectionNeighbourProvider(opts: DocOverlapOptions): NeighbourProvider {
  const deps = opts.deps ?? realDocOverlapDeps;
  const sources = opts.sources ?? DOC_OVERLAP_SOURCES;
  const selection = profileSelectionFor(opts);
  return async (unit: OverlapUnit, limit: number): Promise<readonly NeighbourHit[]> => {
    const ref = decodeSectionId(unit.id);
    if (!ref) {
      throw new Error(
        `doc-section-overlap: unit id ${JSON.stringify(unit.id)} was not produced by encodeSectionId — ` +
          'refusing to report zero neighbours for it, because that is indistinguishable from a clean section',
      );
    }
    return deps.neighboursOf(ref, sources, opts.mode, limit, selection);
  };
}

/**
 * The per-source-pair null distribution: what cosine two UNRELATED sections
 * score. Read a candidate threshold against this, never in isolation.
 */
export function measureNullBaseline(
  opts: DocOverlapOptions & { sampleSize?: number },
): Promise<NullPairSample[]> {
  const deps = opts.deps ?? realDocOverlapDeps;
  const sampleSize = opts.sampleSize ?? 300;
  if (!Number.isInteger(sampleSize) || sampleSize < 2) {
    throw new TypeError('measureNullBaseline: sampleSize must be an integer >= 2');
  }
  return deps.sampleNullPairs(
    opts.sources ?? DOC_OVERLAP_SOURCES,
    opts.mode,
    sampleSize,
    profileSelectionFor(opts),
  );
}

/**
 * Where a similarity sits in a source pair's null — the number a threshold
 * should actually be argued from.
 *
 * Returns the tightest measured percentile the value CLEARS, as a label. A
 * value below the null median is two sections LESS alike than two random ones,
 * which no threshold should ever admit.
 */
export function describeAgainstNull(similarity: number, sample: NullPairSample): string {
  if (similarity > sample.max) return `above the sampled null max (${sample.max.toFixed(4)}, n=${sample.n})`;
  if (similarity >= sample.p999) return `p99.9+ of the null (${sample.p999.toFixed(4)}, n=${sample.n})`;
  if (similarity >= sample.p99) return `p99-p99.9 of the null (n=${sample.n})`;
  if (similarity >= sample.p95) return `p95-p99 of the null (n=${sample.n})`;
  if (similarity >= sample.p50) return `median-p95 of the null — WEAK (n=${sample.n})`;
  return `BELOW the null median (${sample.p50.toFixed(4)}) — less alike than two random sections (n=${sample.n})`;
}

/* ------------------------------------------------------------------------- *
 * The runnable scan (P-003's closing piece)
 * ------------------------------------------------------------------------- */

/**
 * The two thresholds D-003 settled. They are NOT interchangeable and there is
 * no single value that stands in for both: at one global 0.95 the corpus yields
 * 361 same-source findings and exactly ONE cross-source, so a single threshold
 * silently kills the more valuable leg while appearing to have scanned both.
 */
export interface SourcePairThresholds {
  /** Both sections from the same source_key. D-003: 0.92. */
  sameSource: number;
  /** Sections from different source_keys — the leg worth having. D-003: 0.88. */
  crossSource: number;
}

/** A reported pair, with both ends decoded and the threshold it was judged against. */
export interface DocOverlapFinding extends OverlapPair {
  refA: DocSectionRef;
  refB: DocSectionRef;
  sameSource: boolean;
  appliedThreshold: number;
}

/** Per source-pair accounting, so no leg can be empty without saying so. */
export interface SourcePairYield {
  sourceA: string;
  sourceB: string;
  sameSource: boolean;
  threshold: number;
  /** Pairs kept for this source pair. */
  kept: number;
  /**
   * Pairs this source pair contributed to the base scan but that its OWN
   * threshold rejected.
   *
   * ⚠ For the leg whose threshold EQUALS the base threshold (the cross-source
   * leg, since the base runs at the lower of the two), this is 0 BY
   * CONSTRUCTION — the base scan already dropped everything below it, so
   * nothing survives to be rejected. It is not a measurement of that leg's
   * cleanliness, and `rejectedIsStructuralZero` marks it so a reader cannot
   * mistake the two.
   */
  rejected: number;
  /** True when `rejected` is 0 because the base scan pre-filtered at this leg's threshold, not because nothing was rejected. */
  rejectedIsStructuralZero: boolean;
}

export interface DocOverlapScanReport {
  thresholds: SourcePairThresholds;
  /** The single threshold the underlying generic scan actually ran at (see below). */
  scanThreshold: number;
  findings: DocOverlapFinding[];
  bySourcePair: SourcePairYield[];
  census: OverlapCensus;
  /**
   * Non-null means this run could not have produced a trustworthy finding set —
   * D-001's rule, extended with the one failure the generic module cannot see
   * (a truncated base scan, which makes the per-source-pair filter unsound).
   */
  inconclusive: string | null;
  /** The unfiltered generic report, kept so the filtering can be audited. */
  base: OverlapScanReport;
}

/** Group key for one unordered source pair. Structural, so no delimiter can collide with a source name. */
function sourcePairKey(a: string, b: string): string {
  return JSON.stringify(a <= b ? [a, b] : [b, a]);
}

/**
 * ONE base scan at the LOWER threshold, then a per-source-pair filter.
 *
 * ## Why one pass and not two
 *
 * The plan proposed running `scanOverlap` twice — once at 0.92 keeping
 * same-source pairs, once at 0.88 keeping cross-source ones — and merging.
 * A single pass at `min(sameSource, crossSource)` followed by a per-pair filter
 * returns the IDENTICAL set, because `scanOverlap` at threshold T emits every
 * cross-group pair scoring >= T: the 0.92 run's output is a strict subset of the
 * 0.88 run's, so filtering the latter reconstructs both legs exactly. It costs
 * half the ANN queries (one lookup per unit instead of two) and, more usefully,
 * yields a single shared census — two runs would produce two denominators that
 * a reader would have to reconcile by hand.
 *
 * ## The one condition that makes the equivalence hold, asserted rather than assumed
 *
 * `maxPairs` truncation breaks it. The generic scan sorts by DESCENDING
 * similarity before capping, so a truncated run discards its LOWEST-scoring
 * pairs — which is precisely the 0.88-0.92 band where every cross-source finding
 * lives. A capped base scan would therefore drop cross-source findings while
 * retaining same-source ones, i.e. it would reproduce the exact bias D-003 chose
 * split thresholds to avoid, and it would do so silently. So `pairsDropped > 0`
 * is treated as INCONCLUSIVE here rather than as a merely partial report.
 * (`judgeInconclusive` does not flag it, correctly: for the generic module a cap
 * is a partial answer, not a zero-that-measured-nothing. It is only unsound for
 * THIS caller, so this caller is where it is caught.)
 */
export async function runDocSectionOverlapScan(
  opts: DocOverlapOptions & {
    thresholds: SourcePairThresholds;
    neighbourLimit?: number;
    maxPairs?: number;
    /** Coverage floor below which the run is inconclusive. Default 0.99 — see the call site. */
    minCoverage?: number;
  },
): Promise<DocOverlapScanReport> {
  const { sameSource, crossSource } = opts.thresholds ?? ({} as SourcePairThresholds);
  for (const [name, value] of [
    ['sameSource', sameSource],
    ['crossSource', crossSource],
  ] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(
        `runDocSectionOverlapScan: thresholds.${name} must be a finite number — ` +
          "there is no default; D-003 derived these from this corpus's null distribution and they are void if the embedder changes",
      );
    }
  }

  const { units, unavailable } = await loadDocSectionUnits(opts);
  const config = configureOverlapScan({
    threshold: Math.min(sameSource, crossSource),
    neighbours: createDocSectionNeighbourProvider(opts),
    // 30, not the lib's default 10: measured convergence (D-009). K=60 returns
    // the IDENTICAL set as K=30 while adding ~30k candidate pairs of work, and
    // K=10 misses 9 real pairs — 5 of them CROSS-SOURCE, which is the leg this
    // scan exists to find, so the lib's default would silently lose findings.
    neighbourLimit: opts.neighbourLimit ?? 30,
    // A section whose vector has not been written yet can only cause a MISSED
    // finding, never a false one, so a small shortfall does not invalidate the
    // pairs we found — it invalidates only the claim that nothing else exists.
    // Relaxed from the lib's strict 1.0 because embed-backfill legitimately
    // lags a live corpus; the shortfall is still reported in the census.
    minCoverage: opts.minCoverage ?? 0.99,
    // Deliberately far above any plausible finding count: the cap must never be
    // what ends this scan, because a cap here silently biases the result set
    // (see the doc-comment above). It is a memory backstop, not a budget.
    maxPairs: opts.maxPairs ?? 100_000,
    crossGroupOnly: true,
  });

  const base = await scanOverlap(units, config, {
    unitsUnavailable: unavailable,
    unitsUnavailableReason: 'their embedding has not been written yet — embed-backfill lags a live corpus',
  });

  const findings: DocOverlapFinding[] = [];
  const yields = new Map<string, SourcePairYield>();
  for (const pair of base.pairs) {
    const refA = decodeSectionId(pair.a);
    const refB = decodeSectionId(pair.b);
    if (!refA || !refB) {
      // Same fail-closed stance as the neighbour provider: an id that does not
      // decode cannot be assigned a threshold, and guessing one would classify a
      // finding into the wrong leg rather than surfacing a corpus/id bug.
      throw new Error(
        `runDocSectionOverlapScan: reported pair ${JSON.stringify([pair.a, pair.b])} contains an id not produced by ` +
          'encodeSectionId — refusing to guess which threshold applies to it',
      );
    }
    const isSame = refA.sourceKey === refB.sourceKey;
    const threshold = isSame ? sameSource : crossSource;
    const [sa, sb] =
      refA.sourceKey <= refB.sourceKey
        ? [refA.sourceKey, refB.sourceKey]
        : [refB.sourceKey, refA.sourceKey];
    const key = sourcePairKey(sa, sb);
    let bucket = yields.get(key);
    if (!bucket) {
      bucket = {
        sourceA: sa,
        sourceB: sb,
        sameSource: isSame,
        threshold,
        kept: 0,
        rejected: 0,
        rejectedIsStructuralZero: threshold <= config.threshold,
      };
      yields.set(key, bucket);
    }
    if (pair.similarity >= threshold) {
      bucket.kept++;
      findings.push({ ...pair, refA, refB, sameSource: isSame, appliedThreshold: threshold });
    } else {
      bucket.rejected++;
    }
  }

  const truncated =
    base.census.pairsDropped > 0
      ? `the base scan hit its maxPairs cap and discarded ${base.census.pairsDropped} of ${base.census.pairsAboveThreshold} pair(s). ` +
        'Pairs are capped after a descending-similarity sort, so the discarded ones are the lowest-scoring — exactly the band ' +
        `where cross-source findings live (threshold ${crossSource} vs same-source ${sameSource}). The per-source-pair filter ` +
        'below is therefore applied to a biased set and this result is NOT evidence about the corpus; re-run with a higher maxPairs.'
      : null;

  return {
    thresholds: { sameSource, crossSource },
    scanThreshold: config.threshold,
    findings,
    bySourcePair: [...yields.values()].sort(
      (x, y) => x.sourceA.localeCompare(y.sourceA) || x.sourceB.localeCompare(y.sourceB),
    ),
    census: base.census,
    inconclusive: base.inconclusive ?? truncated,
    base,
  };
}

/**
 * One paragraph stating what the scan measured — the denominator travels with
 * the number, per D-001, and each source-pair leg reports its own yield so a
 * silently-empty leg cannot hide inside a healthy total.
 */
export function describeDocOverlapScan(report: DocOverlapScanReport): string {
  const c = report.census;
  const legs = report.bySourcePair.length
    ? report.bySourcePair
        .map(
          (y) =>
            `  ${y.sourceA} x ${y.sourceB} (${y.sameSource ? 'same-source' : 'CROSS-source'}, >=${y.threshold}): ` +
            `${y.kept} kept, ` +
            (y.rejectedIsStructuralZero
              ? 'rejected n/a — this leg\'s threshold IS the base threshold, so nothing could survive to be rejected'
              : `${y.rejected} below its threshold`),
        )
        .join('\n')
    : '  (no source pair produced a candidate above the base threshold)';
  const head =
    `${c.unitsComparable} comparable section(s) of ${c.unitsIn} across ${c.groupsSeen} page(s); ` +
    `${c.neighbourLookups} ANN lookup(s) -> ${c.candidateHitsSeen} candidate hit(s) -> ${c.candidatePairs} distinct pair(s), ` +
    `${c.pairsCrossGroup} cross-page, ${c.pairsAboveThreshold} at or above the base threshold ${report.scanThreshold}. ` +
    `Per-source-pair thresholds kept ${report.findings.length}.`;
  const verdict = report.inconclusive
    ? `\nINCONCLUSIVE — this run is not evidence about the corpus: ${report.inconclusive}`
    : report.findings.length === 0
      ? '\nZero findings, and the run was capable of producing one — this is a real "no overlap above threshold" result.'
      : '';
  return `${head}\n${legs}${verdict}`;
}
