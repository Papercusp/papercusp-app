/**
 * population-census — give every FILTERED read a DENOMINATOR, and make the
 * denominator say how it was obtained (P-021, silent-wrong-answers-2026-08-01).
 *
 * WHY THIS EXISTS. Every read in this system is a filtered read, and almost none
 * of them ship a denominator, so ordinary variation reads as an anomaly. Agents
 * reason forward from a cluster without ever testing whether the cluster is
 * remarkable. On 2026-08-02 that produced two wrong answers and a near-miss
 * third (EI-19375528138828761): an investigation was dissolved by one flat
 * minute-histogram, and a "24h session lifetime cap" — 7 chains clustered at
 * 23.8-24.1h, start and stop positively correlated — was refuted by the SAME
 * table returning chains of 32/66/111/166/193h. Both times the suggestive
 * cluster and its refutation were seconds apart in one relation. Nothing was
 * hidden. The reads simply never said what they were a slice OF.
 *
 * ── Why {@link selectFleetPopulation} could not be reused as-is ──────────────
 * `fleet-population.ts` already solved this for in-memory rows, and its core
 * guarantee is that the census and the rows are derived from THE SAME array in
 * ONE pass, so they cannot disagree. That guarantee is what makes it safe, and
 * it is also exactly why it does not reach the reads that produced the 2026-08-02
 * failures: a SQL-backed read never materialises its population. You cannot
 * filter 392 sessions in memory to discover there were 392 — you have to ASK,
 * separately, and that second measurement can fail or be capped.
 *
 * So this module generalises the census along the axis the in-memory version
 * never needed: PROVENANCE OF THE DENOMINATOR. It does not fork the concept —
 * {@link MeasuredPopulationCensus} is the in-memory case expressed as a subtype,
 * and `fleet-population.ts` produces exactly that.
 *
 * ── The failure this exists to make impossible ───────────────────────────────
 * A denominator that was ITSELF capped is worse than no denominator, because it
 * reads as authoritative. `SELECT ... LIMIT 500` returning 500 does not mean the
 * population is 500; it means it is AT LEAST 500. A census that renders that as
 * "8 of 500" has manufactured a precise, wrong, and unfalsifiable-looking base
 * rate — the same defect one level up from the one it was added to fix, and the
 * shape CLAUDE.md already warns about ("a caller's `limit` bounds ROW LISTS
 * ONLY — never an aggregate").
 *
 * The fix is STRUCTURAL, not documentary. {@link PopulationDenominator} is a
 * discriminated union, so there is no way to declare a bounded denominator
 * without naming the cap that bounded it, and no way to declare an unmeasured
 * one without saying why and what would measure it. A caller cannot reach the
 * dangerous state by forgetting a field; it has to lie on purpose.
 *
 * `not-measured` is deliberately IN-BAND and branchable rather than an error or
 * a zero — the same convention `state:read` uses for a cell it could not
 * resolve. "I do not know the base rate" is a real answer that changes what a
 * reader may conclude. Zero is not; zero says the population is empty, which is
 * the one reading guaranteed to be wrong.
 */

/** How the denominator was obtained. Never absent — see {@link PopulationCensus}. */
export type DenominatorStatus = 'measured' | 'bounded' | 'not-measured';

/**
 * The denominator, stated with its provenance.
 *
 * A discriminated union rather than optional fields, because the fields that
 * make a non-exact denominator safe to read are exactly the ones a caller in a
 * hurry drops. Here the compiler asks for them.
 */
export type PopulationDenominator =
  /** The population was counted exactly. `candidates` is a total. */
  | { status: 'measured'; candidates: number }
  /**
   * The count hit a cap, so it is a FLOOR, not a total. `atLeast` rows exist and
   * possibly more; `boundedBy` names the cap so a reader can raise it.
   */
  | { status: 'bounded'; atLeast: number; boundedBy: string }
  /**
   * No denominator was obtained. `reason` says why; `measureWith` names the call
   * that would obtain one, or null when nothing cheap exists.
   */
  | { status: 'not-measured'; reason: string; measureWith: string | null };

/** Stable descriptive metadata about the population being counted. */
export interface PopulationMeta {
  /** Stable name of the population — the thing `counted` is a count OF. */
  population: string;
  /** One sentence: what qualifies a row for this population. */
  basis: string;
  /** Why filtered-out rows were withheld. */
  withheldReason: string;
  /** The exact argument that would include them; null when there is no lever. */
  reveal: string | null;
}

/**
 * A count that says what it is a count OF, and how sure it is of the whole.
 *
 * Every field is always present. Absence is not used to mean "fine" anywhere in
 * this shape: an omitted denominator would read as a clean total, which is the
 * misreading the module exists to prevent.
 */
export interface PopulationCensus {
  population: string;
  basis: string;
  /**
   * Rows in the population before this response's filter — a total when
   * `candidatesStatus` is 'measured', a FLOOR when 'bounded', and null when
   * 'not-measured'. Never read this without reading `candidatesStatus`.
   */
  candidates: number | null;
  /** How `candidates` was obtained. Always present. */
  candidatesStatus: DenominatorStatus;
  /**
   * True when `candidates` is a lower bound rather than a total. Redundant with
   * `candidatesStatus` on purpose: a renderer that forgets the status field
   * still has a boolean it must actively ignore to render "8 of 392" for a
   * number that means "8 of at least 392".
   */
  candidatesAreFloor: boolean;
  /** The cap that bounded it, or why it is unmeasured. Null when measured. */
  candidatesNote: string | null;
  /** The call that would measure it. Null when measured or nothing cheap exists. */
  measureWith: string | null;
  /** Rows that passed the filter — the number every count in this response describes. */
  counted: number;
  /**
   * Rows the filter removed. Null when the denominator is unknown, because
   * "withheld: 0" against an unknown population asserts the filter hid nothing,
   * which is not something an unmeasured read can know.
   */
  withheld: number | null;
  /** Why the withheld rows were withheld; null when none were, or none are known. */
  withheldReason: string | null;
  /** The exact argument that reveals them; null when there is no such lever. */
  reveal: string | null;
  /**
   * Rows actually present in the payload, when a later byte/row budget dropped
   * some of what `counted` counts. Omitted when the payload carries them all.
   * `counted` is the filter's verdict; `shown` is what survived transport.
   */
  shown?: number;
  /** Why `shown` < `counted`; present only alongside `shown`. */
  shownReason?: string;
}

/**
 * The census of a population that was counted exactly — the in-memory case,
 * where the rows and the denominator come from the same array in one pass.
 *
 * `fleet-population.ts` produces this. It is a SUBTYPE, not a sibling: anything
 * that accepts a {@link PopulationCensus} accepts this, while code that has a
 * measured census keeps the stronger non-null types without a cast.
 */
export interface MeasuredPopulationCensus extends PopulationCensus {
  candidates: number;
  candidatesStatus: 'measured';
  candidatesAreFloor: false;
  candidatesNote: null;
  measureWith: null;
  withheld: number;
}

/**
 * Filter rows and produce the census in ONE pass, so the numbers cannot drift
 * from the rows shipped beside them.
 *
 * Use this whenever the population is already in memory. The denominator is
 * `candidates.length` — measured by construction, which is why the return type
 * is the stronger {@link MeasuredPopulationCensus}.
 */
export function measuredCensus(
  counted: number,
  candidates: number,
  meta: PopulationMeta,
): MeasuredPopulationCensus {
  const withheld = candidates - counted;
  return {
    population: meta.population,
    basis: meta.basis,
    candidates,
    candidatesStatus: 'measured',
    candidatesAreFloor: false,
    candidatesNote: null,
    measureWith: null,
    counted,
    withheld,
    // A reason attached to zero withheld rows reads as an admission that
    // something is hidden, and would train readers to discount the field when it
    // finally matters.
    withheldReason: withheld > 0 ? meta.withheldReason : null,
    reveal: withheld > 0 ? meta.reveal : null,
  };
}

export function selectPopulation<T>(
  candidates: readonly T[],
  keep: (row: T) => boolean,
  meta: PopulationMeta,
): { rows: T[]; census: MeasuredPopulationCensus } {
  const rows = candidates.filter((row) => keep(row));
  return { rows, census: measuredCensus(rows.length, candidates.length, meta) };
}

/**
 * Build a census for a read whose population was NOT materialised — a SQL slice,
 * a search, any filter applied upstream of this process.
 *
 * `counted` is what you are returning; `denominator` is what you managed to learn
 * about the whole, including the honest answer that you learned nothing.
 */
export function censusFromCounts(
  counted: number,
  denominator: PopulationDenominator,
  meta: PopulationMeta,
): PopulationCensus {
  const base = {
    population: meta.population,
    basis: meta.basis,
    counted,
  };

  if (denominator.status === 'measured') {
    return measuredCensus(counted, denominator.candidates, meta);
  }

  if (denominator.status === 'bounded') {
    // `atLeast - counted` is itself a floor. It is still worth publishing: it
    // says the filter removed AT LEAST this many, which is the direction that
    // matters — a reader who under-estimates what was hidden is the one who
    // concludes a slice is the whole.
    const withheldAtLeast = Math.max(0, denominator.atLeast - counted);
    return {
      ...base,
      candidates: denominator.atLeast,
      candidatesStatus: 'bounded',
      candidatesAreFloor: true,
      candidatesNote: denominator.boundedBy,
      measureWith: null,
      withheld: withheldAtLeast,
      withheldReason: withheldAtLeast > 0 ? meta.withheldReason : null,
      reveal: withheldAtLeast > 0 ? meta.reveal : null,
    };
  }

  return {
    ...base,
    candidates: null,
    candidatesStatus: 'not-measured',
    candidatesAreFloor: false,
    candidatesNote: denominator.reason,
    measureWith: denominator.measureWith,
    withheld: null,
    withheldReason: null,
    reveal: meta.reveal,
  };
}

/**
 * Record that transport dropped rows the filter had kept.
 *
 * A no-op when `shown` is not actually smaller than `counted`, so a caller can
 * pass its page size unconditionally without inventing a discrepancy.
 */
export function withShownCount<C extends PopulationCensus>(
  census: C,
  shown: number,
  shownReason: string,
): C {
  if (!Number.isFinite(shown) || shown >= census.counted) return census;
  return { ...census, shown, shownReason };
}

/**
 * The census AS ONE SENTENCE — "matched 8 of 392 sessions in this window".
 *
 * This exists because the census reaches agents as a JSON object, and a reader
 * scanning a payload sees `candidates: 500` long before it sees
 * `candidatesAreFloor: true`. The sentence puts the qualifier where it cannot be
 * skimmed past: a bounded denominator renders `of at least 500`, and an
 * unmeasured one renders the absence of a base rate as a statement rather than
 * as a missing field.
 */
export function describeCensus(census: PopulationCensus): string {
  const noun = census.population;
  const shownClause =
    census.shown !== undefined && census.shown < census.counted
      ? ` — only ${census.shown} present in this payload (${census.shownReason ?? 'truncated'})`
      : '';

  if (census.candidatesStatus === 'not-measured') {
    const how = census.measureWith ? ` Measure it with ${census.measureWith}.` : '';
    return (
      `matched ${census.counted} ${noun}, of an UNKNOWN total ` +
      `(${census.candidatesNote ?? 'denominator not measured'}) — this slice cannot ` +
      `tell you whether ${census.counted} is many or few.${how}${shownClause}`
    );
  }

  if (census.candidatesStatus === 'bounded') {
    return (
      `matched ${census.counted} of AT LEAST ${census.candidates} ${noun} ` +
      `(the total is a floor, capped by ${census.candidatesNote ?? 'an upstream limit'}; ` +
      `the real population may be larger)${shownClause}`
    );
  }

  return `matched ${census.counted} of ${census.candidates} ${noun}${shownClause}`;
}
