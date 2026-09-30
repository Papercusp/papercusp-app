import { computeFacets, type CompanionListSummary, type FacetDef, type FacetSelection } from '@papercusp/facets';

export interface SeededBeyondCapCorpus<Row> {
  rows: Row[];
  beyondPageRow: Row;
}

/** Build a deterministic corpus with its distinguished match strictly past page one. */
export function seedCorpusBeyondCap<Row>(opts: {
  pageCap: number;
  makeRow: (index: number) => Row;
  makeBeyondPageRow: (index: number) => Row;
}): SeededBeyondCapCorpus<Row> {
  if (!Number.isSafeInteger(opts.pageCap) || opts.pageCap < 1) {
    throw new RangeError('pageCap must be a positive safe integer');
  }
  const beyondIndex = opts.pageCap + 1;
  const rows = Array.from({ length: opts.pageCap + 2 }, (_, index) =>
    index === beyondIndex ? opts.makeBeyondPageRow(index) : opts.makeRow(index),
  );
  return { rows, beyondPageRow: rows[beyondIndex] };
}

export interface ContractPage<Row> {
  rows: Row[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface CompanionPredicateParityProbe<Row, Args> {
  corpus: readonly Row[];
  pageCap: number;
  args: Args;
  zeroMatchArgs: Args;
  beyondPageRowId: string;
  rowId: (row: Row) => string;
  predicate: (row: Row, args: Args) => boolean;
  /** Non-facet filters that remain active in every drill-down facet pool. */
  facetBasePredicate?: (row: Row, args: Args) => boolean;
  facetDefs: readonly FacetDef<Row>[];
  selection: (args: Args) => FacetSelection;
  readPage: (args: Args, cursor: string | null) => Promise<ContractPage<Row>>;
  readSummary: (args: Args) => Promise<CompanionListSummary>;
}

const fail = (message: string): never => {
  throw new Error(`companion count contract: ${message}`);
};

function requireCursor(value: string | null, message: string): asserts value is string {
  if (!value) fail(message);
}

const sameSet = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  const b = new Set(right);
  return left.every((value) => b.has(value));
};

const facetShape = (summary: CompanionListSummary) =>
  summary.facets
    .map((group) => ({
      key: group.key,
      values: group.values
        .map((value) => ({ value: value.value, count: value.count }))
        .sort((a, b) => a.value.localeCompare(b.value)),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

/**
 * Reusable large-corpus assertion for each P-004..P-012 domain migration.
 *
 * It drains the real keyset reader, compares rows + totals + drill-down facets
 * to one in-memory predicate over the seeded corpus, proves the distinguished
 * match beyond page one is reachable, requires a truthful zero-match summary,
 * and refuses empty/repeated cursor progress while `hasMore` is true.
 */
export async function assertCompanionPredicateParity<Row, Args>(
  probe: CompanionPredicateParityProbe<Row, Args>,
): Promise<void> {
  if (probe.corpus.length <= probe.pageCap) fail('seeded corpus does not exceed the configured cap');
  const expectedRows = probe.corpus.filter((row) => probe.predicate(row, probe.args));
  const expectedIds = expectedRows.map(probe.rowId);
  if (!expectedIds.includes(probe.beyondPageRowId)) {
    fail('the distinguished beyond-page row does not match the active predicate');
  }

  const loaded: Row[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber <= probe.corpus.length + 1; pageNumber += 1) {
    const page = await probe.readPage(probe.args, cursor);
    loaded.push(...page.rows);
    if (!page.hasMore) break;
    if (page.rows.length === 0) fail('pagination claims more after a zero-growth page');
    const nextCursor = page.nextCursor;
    requireCursor(nextCursor, 'pagination claims more without a next cursor');
    if (nextCursor === cursor || seenCursors.has(nextCursor)) {
      fail('pagination repeats a cursor while claiming more');
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
    if (pageNumber === probe.corpus.length + 1) fail('pagination never terminated');
  }

  const loadedIds = loaded.map(probe.rowId);
  if (!sameSet(loadedIds, expectedIds)) fail('row pages and the normalized predicate disagree');
  if (!loadedIds.includes(probe.beyondPageRowId)) fail('a match beyond page one is unreachable');

  const summary = await probe.readSummary(probe.args);
  if (!summary || typeof summary !== 'object') fail('row result lost its companion summary response');
  if (summary.total !== probe.corpus.length) fail('summary total is not the declared corpus size');
  if (summary.matched !== expectedRows.length) fail('summary matched total and row predicate disagree');

  const facetCorpus = probe.facetBasePredicate
    ? probe.corpus.filter((row) => probe.facetBasePredicate!(row, probe.args))
    : probe.corpus;
  const expectedFacets = computeFacets(facetCorpus, probe.facetDefs, {
    minDistinctValues: 1,
    selection: probe.selection(probe.args),
  });
  const expectedSummary: CompanionListSummary = {
    total: probe.corpus.length,
    matched: expectedRows.length,
    facets: expectedFacets,
  };
  if (JSON.stringify(facetShape(summary)) !== JSON.stringify(facetShape(expectedSummary))) {
    fail('facet counts describe a different population than the normalized predicate');
  }

  const zero = await probe.readSummary(probe.zeroMatchArgs);
  if (!zero || typeof zero !== 'object') fail('zero-row result lost its exact summary/reset response');
  if (zero.total !== probe.corpus.length || zero.matched !== 0 || !Array.isArray(zero.facets)) {
    fail('zero-row result lost its exact summary/reset response');
  }
}

export interface PairedConvergenceProbe<Row> {
  readRowsBeforeWrite: () => Promise<Row[]>;
  writeBetweenQueries: () => Promise<void>;
  readRacedSummary: () => Promise<CompanionListSummary>;
  refetchPairAfterInvalidation: () => Promise<{ rows: Row[]; summary: CompanionListSummary }>;
}

/** Prove an adjacent-snapshot mismatch converges after one paired invalidation. */
export async function assertPairConvergesAfterInvalidation<Row>(probe: PairedConvergenceProbe<Row>): Promise<void> {
  const before = await probe.readRowsBeforeWrite();
  await probe.writeBetweenQueries();
  const raced = await probe.readRacedSummary();
  if (before.length === raced.matched) {
    fail('convergence probe did not create the intended adjacent-snapshot mismatch');
  }
  const settled = await probe.refetchPairAfterInvalidation();
  if (settled.rows.length !== settled.summary.matched) {
    fail('paired rows and summary did not converge after one invalidation cycle');
  }
}
