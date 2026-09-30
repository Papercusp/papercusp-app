/**
 * Literal (non-pattern) string search/replace shared by the managed file-mutation
 * adapters — `capability:edit` and `capability:patch`.
 *
 * Extracted rather than copied on purpose. EI-18693907749585513 is a real
 * data-loss bug that lived in exactly this logic: `String.prototype.replace(old,
 * new)` still pattern-interprets the REPLACEMENT string (`$&`, `` $` ``, `$'`,
 * `$1`, `$$`) even when the search side is a plain string, and `` $` `` expands to
 * "everything before the match" — which spliced an entire file into itself when a
 * replacement happened to contain a literal `$` followed by a backtick. A second
 * adapter re-implementing this by hand is a second chance to reintroduce it, so
 * both mutation doors call the same audited helpers.
 */

/** Count non-overlapping occurrences of `needle` in `haystack`. An empty needle matches nothing. */
export function occurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * Replace `oldString` with `newString` literally — never as a pattern, on either side.
 *
 * `replaceAll:false` replaces the FIRST occurrence via an index splice; callers that
 * require uniqueness must check {@link occurrences} first. `replaceAll:true` uses
 * split/join, which is likewise immune to `$`-expansion.
 */
export function spliceLiteral(source: string, oldString: string, newString: string, replaceAll: boolean): string {
  if (oldString === '') return source;
  if (replaceAll) return source.split(oldString).join(newString);
  const idx = source.indexOf(oldString);
  if (idx === -1) return source;
  return source.slice(0, idx) + newString + source.slice(idx + oldString.length);
}

/** Collapse every whitespace run to a single space, so indentation drift stops mattering. */
export function squashWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
