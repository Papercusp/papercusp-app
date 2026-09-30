/**
 * Longest clean prefix of an ordered walk, located by BISECTION.
 *
 * `isClean(item, index)` answers, for the prefix that ENDS at `item`, whether that prefix
 * is clean: `true` = clean, `false` = it implicates the failure, `null` = it could not be
 * computed. Both `false` and `null` are STOP evidence — the prefix cannot be extended
 * through that item — and the result names the longest prefix strictly before the
 * earliest stop the search found.
 *
 * WHY bisection, not a linear scan. The predicate is CUMULATIVE (a prefix whose diff
 * touches a path keeps touching it as the prefix grows), so the walk reads
 * `clean … clean | stop … stop` and the boundary is bisectable in ⌈log2(n+1)⌉ probes. A
 * linear scan spends one probe per item, and in the green-checkpoint's prefix salvage each
 * probe is a superproject diff plus two full recursive tree listings. MEASURED 2026-09-06,
 * cron run 3ce52b07 (base a2d69cef, frozen-lineage candidate be60bb26): 11,544 commits in
 * range, the first implicating commit at position 10,490, ~1.5–2.4 probes/s — the locate
 * alone held the gate's singleton run-lock for over an hour AFTER the verdict was already
 * known, so the next hourly cron tick found the lock held and ran no suite, and a repair
 * head admitted during the run waited an extra hour to be judged. Bisection over that same
 * range is 14 probes.
 *
 * NON-MONOTONE INPUT (a path changed and then reverted byte-exactly to the base) can make
 * a later prefix read clean after an earlier one implicated. The linear scan stopped at
 * the earlier one; bisection may pick the later one. Both are prefixes whose CUMULATIVE
 * diff is clean, and the salvage's confirm run — its documented safety backstop — is what
 * validates either before `main` moves. `stopped` reports whether ANY probe returned stop
 * evidence: when it is false, every probed prefix including the maximal one read clean,
 * which is the vacuous-maximal-prefix condition the caller guards separately.
 */
export interface LongestCleanPrefixResult<T> {
  /** The last item of the longest clean prefix, or null when even the first item stops. */
  prefixTip: T | null;
  /** Did any probe return stop evidence (`false` or `null`)? */
  stopped: boolean;
  /** How many times `isClean` was called — ⌈log2(n+1)⌉ at most. */
  probes: number;
}

export async function longestCleanPrefix<T>(
  walk: readonly T[],
  isClean: (item: T, index: number) => Promise<boolean | null>,
): Promise<LongestCleanPrefixResult<T>> {
  // Invariants: walk[lo] is clean (lo === -1 is the empty prefix, clean by definition);
  // walk[hi] is a stop (hi === walk.length is past the walk, a stop by definition).
  let lo = -1;
  let hi = walk.length;
  let probes = 0;
  while (hi - lo > 1) {
    const mid = lo + ((hi - lo) >> 1);
    probes += 1;
    const verdict = await isClean(walk[mid], mid);
    if (verdict === true) lo = mid;
    else hi = mid;
  }
  return {
    prefixTip: lo >= 0 ? walk[lo] : null,
    stopped: hi < walk.length,
    probes,
  };
}
