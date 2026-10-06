/**
 * chunk-search-ab.ts — the pure half of the same-time A/B latency bench that
 * instruments acceptance BAR R-33 of plan generic-rag-chunking-2026-09-29
 * (Decision D-040; the runnable half is `chunk-search-ab-cli.ts`).
 *
 * WHY AN A/B, NOT A TIME-SEPARATED READING
 * R-33 first compared each site's end-to-end p95 with the p95 D-024 recorded on
 * 2026-09-29, before chunking. On a shared box under fleet load the rest of the
 * path (MCP door, embedding, lexical legs) drifted by 900-1,400 ms between the two
 * readings, while the chunking change itself adds 6-67 ms; a time-separated
 * reading cannot tell the two apart, load-matched or not (D-038, D-039). D-040
 * re-instruments R-33 as a paired comparison taken at the same instant:
 *
 *   arm A  the site's pre-change vector query (its SQL as of 9a9473af95)
 *   arm B  the site's current, chunk-aware code
 *
 * Both arms get the same precomputed query vector, run back to back for every
 * (round, query) with alternating order, and the reading is what B ADDS:
 * `B p95 - A p95`. A site passes when that is at most
 * `max(0.25 x its D-024 baseline p95, N_s)` — D-024's 1.25x budget, charged only
 * with what the change adds. N_s is the site's NOISE FLOOR (D-042): the largest
 * |p95(A') - p95(A)| over R33_AB_NULL_RUNS A-vs-A null runs (`--null`), i.e. the
 * smallest added cost this instrument can tell from zero at that site. D-040's
 * fixed 10 ms floor was withdrawn by D-042: it was chosen after consult's result.
 *
 * work_items:search has no fair pre-change arm (its pre-change feature leg was
 * broken; D-033), so its A arm is the same search with the semantic legs off and
 * its reading is the whole semantic-leg cost — an upper bound on the added cost.
 *
 * This module has no I/O so the test can import it without starting a run.
 */
import { D024_BASELINE_P95_MS, R33_RATIO, percentile } from './chunk-search-latency';

/** The commit whose search SQL the A arms reproduce (before any chunk-aware leg). */
export const R33_AB_PRE_CHANGE_REF = '9a9473af95';

/** The sites R-33 covers, in report order. Keys match D024_BASELINE_P95_MS. */
export const R33_AB_SITES = ['plans', 'turns', 'work_item', 'work_items_search', 'consult'] as const;
export type R33AbSite = (typeof R33_AB_SITES)[number];

/** D-042: how many valid A-vs-A null runs a site's noise floor is taken over. */
export const R33_AB_NULL_RUNS = 5;

/**
 * D-042: each site's noise floor N_s in ms, from R33_AB_NULL_RUNS valid null runs.
 * Pinned by D-043 from the 5 band-matched null runs of 2026-10-02 12:15-13:02Z
 * (docs/evidence/generic-rag-chunking-2026-09-29/p016-r33-null-runs.json; the
 * bench code as committed in 94d75a58ff). Every floor is below its site's 0.25 x D-024 budget, so no
 * budget changes: the instrument resolves the 1.25x proportion at every site.
 */
export const R33_AB_NOISE_FLOOR_MS: Readonly<Partial<Record<R33AbSite, number>>> = Object.freeze({
  plans: 1.7,
  turns: 15.9,
  work_item: 4.6,
  work_items_search: 1.5,
  consult: 1.9,
});

/**
 * D-042: a site's noise floor from its null-run spreads — the largest
 * |p95(A') - p95(A)| over exactly R33_AB_NULL_RUNS valid runs, rounded UP to 0.1 ms.
 * The maximum is fixed in advance: the null runs and a later zero-cost reading are
 * exchangeable, so a change that adds nothing exceeds the floor with chance 1/(K+1).
 */
export function r33AbNoiseFloorMs(spreads: readonly number[]): number {
  if (spreads.length !== R33_AB_NULL_RUNS) {
    throw new Error(`a noise floor needs exactly ${R33_AB_NULL_RUNS} null runs, got ${spreads.length}`);
  }
  if (spreads.some((x) => !Number.isFinite(x))) throw new Error('a null-run spread is not a finite number');
  // Round the scaled value first so float noise (0.1 * 3 = 0.30000000000000004) cannot ceil up a step.
  return Math.ceil(Math.round(Math.max(...spreads.map(Math.abs)) * 1e6) / 1e5) / 10;
}

/** What each site's A and B arm are, written into the evidence file. */
export const R33_AB_ARMS: Readonly<Record<R33AbSite, { a: string; b: string; limit: number }>> = {
  plans: {
    a: `harness_plans.embedding ordered scan under withWorkspace (semantic-leg.ts @ ${R33_AB_PRE_CHANGE_REF})`,
    b: 'queryTopPlansReal (chunk-aware leg + matched-section lateral)',
    limit: 30,
  },
  turns: {
    a: `operator_turns.text_embedding HNSW joined to operator_conversations (sources.ts @ ${R33_AB_PRE_CHANGE_REF})`,
    b: "SEARCH_SOURCES 'turns'.embedding (chunk-aware leg)",
    limit: 30,
  },
  work_item: {
    a: `engineer_issues.embedding HNSW (sources.ts @ ${R33_AB_PRE_CHANGE_REF})`,
    b: "SEARCH_SOURCES 'work_item'.embedding (chunk-aware leg)",
    limit: 30,
  },
  work_items_search: {
    a: 'searchWorkItems { limit: 10, semantic: false } (lexical legs only; no fair pre-change arm, D-033)',
    b: 'searchWorkItems { limit: 10, semantic: true } (query vector precomputed)',
    limit: 10,
  },
  consult: {
    a: `consult_state.query_embedding exact scan, peersKnowLookup body @ ${R33_AB_PRE_CHANGE_REF}`,
    b: "peersKnowLookup (chunk-aware leg, scan 'exact', chunkScan 'ann' over the consult_questions partial HNSW index, ef_search 100; D-046)",
    limit: 1,
  },
};

const round1 = (x: number) => Math.round(x * 10) / 10;

/** A site's added-latency budget: max(0.25 x D-024 baseline p95, its D-042 noise floor). */
export function r33AbBudgetMs(site: R33AbSite): number {
  const baseline = D024_BASELINE_P95_MS[site];
  if (typeof baseline !== 'number') throw new Error(`no D-024 baseline for site ${site}`);
  return round1(Math.max((R33_RATIO - 1) * baseline, R33_AB_NOISE_FLOOR_MS[site] ?? 0));
}

/**
 * Which arm runs first for a (round, query) pair. Alternating per pair means each
 * arm goes first in half the pairs, so neither always inherits the other's warm
 * cache or pays the first-touch cost.
 */
export function armOrder(round: number, queryIndex: number): readonly ['A', 'B'] | readonly ['B', 'A'] {
  return (round + queryIndex) % 2 === 0 ? (['A', 'B'] as const) : (['B', 'A'] as const);
}

/** One (round, query) pair: both arms' wall time and how many rows each returned. */
export interface PairedSample {
  round: number;
  q: number;
  aMs: number;
  bMs: number;
  aRows: number;
  bRows: number;
  aError?: string;
  bError?: string;
  /** Each arm's top result id (null = no result), when the CLI records one. */
  aTop?: string | null;
  bTop?: string | null;
}

export interface ArmStats {
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface PairedSummary {
  /** Pairs taken. */
  n: number;
  /** Pairs where both arms answered; only these enter the percentiles. */
  pairs: number;
  aErrors: number;
  bErrors: number;
  a: ArmStats;
  b: ArmStats;
  /** The R-33 reading: B p95 - A p95, ms. Null when no pair completed. */
  addedP95: number | null;
  /** Median over pairs of (B - A), ms: the per-query cost, robust to drift. */
  pairedMedianDeltaMs: number | null;
  /** Median over pairs of B / A. */
  pairedMedianRatio: number | null;
  /**
   * Pairs where A returned rows and B returned none. The B arms are current code
   * that may catch its own errors (peersKnowLookup returns null on any throw), so a
   * failing B arm would be fast and empty; this count is how such a run is caught.
   */
  bEmptyWhereAHadRows: number;
  /**
   * How often both arms ranked the same result first, over pairs that recorded
   * both tops. A diagnostic, not part of the verdict: chunking is meant to change
   * some rankings (a match past the parent's 2,000-character cut now counts).
   */
  topHitAgreement: { compared: number; same: number };
  firstErrors: string[];
}

function stats(xs: readonly number[]): ArmStats {
  const r = (v: number | null) => (v === null ? null : round1(v));
  return { p50: r(percentile(xs, 50)), p95: r(percentile(xs, 95)), max: xs.length ? round1(Math.max(...xs)) : null };
}

/** Summarise one site's paired samples. A pair with an error in either arm is not a reading. */
export function summarisePaired(samples: readonly PairedSample[]): PairedSummary {
  const ok = samples.filter((s) => s.aError === undefined && s.bError === undefined);
  const a = stats(ok.map((s) => s.aMs));
  const b = stats(ok.map((s) => s.bMs));
  const deltas = ok.map((s) => s.bMs - s.aMs);
  const ratios = ok.filter((s) => s.aMs > 0).map((s) => s.bMs / s.aMs);
  const tops = ok.filter((s) => s.aTop !== undefined && s.bTop !== undefined);
  const median = (xs: number[]) => {
    const m = percentile(xs, 50);
    return m === null ? null : Math.round(m * 100) / 100;
  };
  return {
    n: samples.length,
    pairs: ok.length,
    aErrors: samples.filter((s) => s.aError !== undefined).length,
    bErrors: samples.filter((s) => s.bError !== undefined).length,
    a,
    b,
    addedP95: a.p95 === null || b.p95 === null ? null : round1(b.p95 - a.p95),
    pairedMedianDeltaMs: median(deltas),
    pairedMedianRatio: median(ratios),
    bEmptyWhereAHadRows: ok.filter((s) => s.aRows > 0 && s.bRows === 0).length,
    topHitAgreement: {
      compared: tops.length,
      same: tops.filter((s) => s.aTop === s.bTop).length,
    },
    firstErrors: samples
      .flatMap((s) => [s.aError && `A: ${s.aError}`, s.bError && `B: ${s.bError}`])
      .filter((e): e is string => typeof e === 'string')
      .slice(0, 3),
  };
}

export interface R33AbVerdict {
  site: R33AbSite;
  addedP95: number | null;
  budget: number;
  /**
   * True when the added p95 is within budget, false when over it, and null when
   * the run is not a valid reading for this site (see `invalidReason`). A site
   * whose reading is invalid can never read as a pass.
   */
  withinBudget: boolean | null;
  invalidReason?: string;
}

/**
 * Judge each site. A reading is invalid when the site has no summary, when any
 * call errored (a pair missing from the percentiles would bias them), or when B
 * came back empty where A returned rows (a silently failing B arm).
 */
export function r33AbVerdicts(summaries: Readonly<Partial<Record<R33AbSite, PairedSummary>>>): R33AbVerdict[] {
  return R33_AB_SITES.map((site) => {
    const budget = r33AbBudgetMs(site);
    const s = summaries[site];
    const invalid = (invalidReason: string): R33AbVerdict => ({
      site,
      addedP95: s?.addedP95 ?? null,
      budget,
      withinBudget: null,
      invalidReason,
    });
    if (!s || s.pairs === 0 || s.addedP95 === null) return invalid('no completed pair');
    if (s.aErrors > 0 || s.bErrors > 0) {
      return invalid(`${s.aErrors} A and ${s.bErrors} B call(s) errored: ${s.firstErrors.join('; ')}`);
    }
    if (s.bEmptyWhereAHadRows > 0) {
      return invalid(`B returned no rows in ${s.bEmptyWhereAHadRows} pair(s) where A returned rows`);
    }
    return { site, addedP95: s.addedP95, budget, withinBudget: s.addedP95 <= budget };
  });
}

/** True only when every site has a valid reading within its budget. */
export function r33AbPasses(verdicts: readonly R33AbVerdict[]): boolean {
  return verdicts.length === R33_AB_SITES.length && verdicts.every((v) => v.withinBudget === true);
}

/** D-042: one null run's spread at a site, or null with the reason the run is invalid there. */
export interface R33AbNullSpread {
  site: R33AbSite;
  /** |p95(A') - p95(A)| in ms for an A-vs-A run; null when the run is invalid at this site. */
  spread: number | null;
  invalidReason?: string;
}

/**
 * Read an A-vs-A null run (`--null`, where the B slot runs arm A again). It applies
 * the reading's own validity rules — an errored call, or the second A empty where the
 * first had rows, voids the site — and reports the absolute p95 difference.
 */
export function r33AbNullSpreads(summaries: Readonly<Partial<Record<R33AbSite, PairedSummary>>>): R33AbNullSpread[] {
  return r33AbVerdicts(summaries).map((v) =>
    v.withinBudget === null || v.addedP95 === null
      ? { site: v.site, spread: null, invalidReason: v.invalidReason ?? 'no completed pair' }
      : { site: v.site, spread: round1(Math.abs(v.addedP95)) },
  );
}

/**
 * The 1-min load average D-024's baselines were measured at (D-038 records
 * 69.9/75.9/90.2 for the 1/5/15-min averages).
 */
export const D024_LOAD_1MIN = 69.9;

/**
 * D-041: the same-time A/B does not cancel load. What B adds grows with load
 * (consult +6.3 ms at 1-min load 68.6, +10 to +12 ms at 94-131), so a reading
 * counts only when the 1-min load average is within +/-20% of D-024's at both
 * ends of the timed rounds. Only the 1-min average is gated because the rounds
 * last about 1.5 min, which it brackets; the band is two-sided so a quiet box
 * cannot flatter the reading either.
 */
export const R33_AB_LOAD_BAND = Object.freeze({
  low: round1(D024_LOAD_1MIN * 0.8),
  high: round1(D024_LOAD_1MIN * 1.2),
});

export interface R33AbLoadCheck {
  matched: boolean;
  band: { low: number; high: number };
  /** 1-min load average when the timed rounds started and ended. */
  start: number | null;
  end: number | null;
  reason?: string;
}

/** Is a 1-min load average inside D-041's band? */
export function inR33AbLoadBand(load1: number): boolean {
  return Number.isFinite(load1) && load1 >= R33_AB_LOAD_BAND.low && load1 <= R33_AB_LOAD_BAND.high;
}

/** D-041's gate over `os.loadavg()` read at the start and end of the timed rounds. */
export function r33AbLoadCheck(loadavgStart: readonly number[], loadavgEnd: readonly number[]): R33AbLoadCheck {
  const band = { ...R33_AB_LOAD_BAND };
  const start = loadavgStart[0] ?? null;
  const end = loadavgEnd[0] ?? null;
  const out = (where: string, v: number | null) =>
    `1-min load at ${where} ${v ?? 'unknown'} is outside D-041's band ${band.low}-${band.high}`;
  if (start === null || !inR33AbLoadBand(start)) return { matched: false, band, start, end, reason: out('start', start) };
  if (end === null || !inR33AbLoadBand(end)) return { matched: false, band, start, end, reason: out('end', end) };
  return { matched: true, band, start, end };
}
