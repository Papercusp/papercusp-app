/**
 * Resume chunking (bulk-review-report-legibility-and-lifecycle-2026-08-31
 * P-009, D-002) — shared by both bulk flows because both hit the same wall.
 *
 * `resume` carries one id per element. A run stopped early over a whole
 * workspace can leave thousands of rows unassessed, so resuming "everything
 * that was never judged" as ONE request exceeds the route's body limit and the
 * owner's only visible affordance fails with a transport error. Posting in
 * chunks turns that into N ordinary requests.
 *
 * Deliberately a plain pure function in its own module: it is imported by two
 * report components and by their tests, and none of them should have to pull in
 * a React component to get it.
 */

/** Comfortably under the route's body limit for the widest id shape either
 *  flow produces (plan-cleanup finding ids embed harness + slug + item). */
export const RESUME_CHUNK_SIZE = 500;

export function chunkFindingIds(
  ids: readonly string[],
  size: number = RESUME_CHUNK_SIZE,
): string[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`chunk size must be a positive integer, got ${size}`);
  }
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push([...ids.slice(i, i + size)]);
  }
  return chunks;
}
