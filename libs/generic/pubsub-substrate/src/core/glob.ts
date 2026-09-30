/**
 * glob.ts — the v1 path-glob matcher used by watch/notify subscriptions.
 * PURE.
 *
 * v1 pattern syntax (deliberate simplification):
 *   `**` matches anything including `/`
 *   `*`  matches anything except `/`
 *   everything else literal
 * No brace expansion, no `?`. Good enough for common path globs;
 * upgrade to a real glob lib only when a real use case forces it.
 *
 * (Extracted from coordination/subscriptions.ts. The persistence side of
 * subscriptions stays host-side — see the package README — but the pure
 * matcher belongs in coord-core.)
 */

export type WatchTrigger =
  | 'lock_acquired'
  | 'file_edited'
  | 'plan_referenced'
  | 'any';

/** Convert a v1 path-glob pattern to a regex. See module header for syntax. */
export function patternToRegex(pattern: string): RegExp {
  // Escape regex specials except *
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // Single pass: ** (crosses '/') -> .*  |  * (within a segment) -> [^/]*.
  // The alternation tries ** first, so no placeholder byte is needed.
  const re = escaped.replace(/\*\*|\*/g, (m) => (m === '**' ? '.*' : '[^/]*'));
  return new RegExp('^' + re + '$');
}

/** True if `path` matches the glob `pattern` (v1 syntax). */
export function matchesPattern(pattern: string, path: string): boolean {
  return patternToRegex(pattern).test(path);
}
