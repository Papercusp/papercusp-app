/**
 * Vitest bench for the generic client-side sort helper.
 *
 * Per testing-spec §1.12, tracks render-path micro-benchmarks for
 * libs/papergrid. `applySort` is the hottest pure function in the
 * grid path (every column-header click + every prop-driven re-sort
 * runs through it) — a regression here is felt across every grid
 * consumer.
 *
 * Run: `npm run bench --workspace libs/papergrid/grid-core`
 *      (or `npx vitest bench` from the package directory)
 *
 * Results upload as a CI artifact in nightly; per-PR runs only on
 * grid-core changes via the affected graph. Not gated.
 */
import { bench, describe } from 'vitest';
import { applySort } from './sort-util';
import type { SortState } from './RichGrid';

interface Row {
  id: number;
  name: string;
  price: number | null;
  sku: string;
}

function makeRows(n: number, seed = 1): Row[] {
  // Deterministic LCG so bench inputs are reproducible across runs.
  let s = seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
  const rows: Row[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = rand();
    rows[i] = {
      id: i,
      name: `item-${Math.floor(r * 1_000_000).toString(36)}`,
      price: r < 0.1 ? null : Math.floor(r * 10_000) / 100,
      sku: `SKU-${Math.floor(r * 1_000_000)}`,
    };
  }
  return rows;
}

const ROWS_100 = makeRows(100);
const ROWS_1K = makeRows(1_000);
const ROWS_10K = makeRows(10_000);

const ASC: SortState = { column: 'price', dir: 'asc' };
const DESC: SortState = { column: 'name', dir: 'desc' };

describe('applySort — numeric column with nulls', () => {
  bench('100 rows', () => {
    applySort(ROWS_100, ASC);
  });
  bench('1k rows', () => {
    applySort(ROWS_1K, ASC);
  });
  bench('10k rows', () => {
    applySort(ROWS_10K, ASC);
  });
});

describe('applySort — string column, descending', () => {
  bench('100 rows', () => {
    applySort(ROWS_100, DESC);
  });
  bench('1k rows', () => {
    applySort(ROWS_1K, DESC);
  });
  bench('10k rows', () => {
    applySort(ROWS_10K, DESC);
  });
});

describe('applySort — no-op (state=null returns input)', () => {
  bench('10k rows, state=null', () => {
    applySort(ROWS_10K, null);
  });
});
