/**
 * Generic client-side sort helper for RichGrid consumers.
 *
 * Use when the row count is small enough that re-sorting on every render
 * is fine (a few thousand rows max). For larger sets, push the sort into
 * the data source (e.g. Zero's `.orderBy(...)`) instead.
 *
 * Behaviour:
 *  - `null` / `undefined` always sort to the end, regardless of `dir`
 *    (so empty cells don't crowd the head of either order)
 *  - numeric columns sort numerically; everything else is `String(...)`
 *    + `localeCompare`
 *  - non-mutating; returns a fresh array
 */
import type { SortState } from './RichGrid';

export function applySort<T>(rows: readonly T[], state: SortState | null | undefined): T[] {
  if (!state) return rows as T[];
  const dir = state.dir === 'asc' ? 1 : -1;
  const key = state.column as keyof T;
  return [...rows].sort((a, b) => {
    const av = a[key] as unknown;
    const bv = b[key] as unknown;
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}
