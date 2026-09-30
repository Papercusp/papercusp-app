/**
 * Parallel isolation (P-004) — a pure, order-preserving concurrency-limited map.
 *
 * Runs up to `limit` workers at once. The gym uses this to evaluate N (task×variant)
 * runs concurrently within the one dedicated gym instance; runs are isolated by
 * construction (distinct throwaway harness schemas + clone dirs + feature ids), so the
 * only thing to bound is in-flight concurrency (≈ the DBOS pipeline queue width).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
