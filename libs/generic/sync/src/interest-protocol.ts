/**
 * Wire contract for the per-client invalidation interest declaration.
 *
 * ONE definition, shared by both halves of the feature: the client builds the
 * SSE URL with `withInterestParam`, and the server route parses the same param
 * back into a per-subscriber filter. The param name and the cap therefore have
 * a single source rather than a copy on each side that can drift apart — a
 * drifted param name here fails SILENTLY (the server sees no declaration and
 * falls back to full fan-out), which is precisely the shape of bug that never
 * gets reported as one.
 *
 * Both directions are deliberately FAIL-OPEN (plan D-002): every ambiguous
 * input resolves to "no filtering", i.e. exactly today's full fan-out. The
 * failure mode of this feature is silent staleness, which no test suite
 * reliably catches and users report only as "the UI is wrong sometimes", so
 * an event is dropped only on positive knowledge that the client does not
 * want it.
 */

/**
 * Query param carrying the client's declared interest set: the query names it
 * is currently observing, comma-separated (`?queries=plans.items,work.items`).
 */
export const INTEREST_PARAM = 'queries';

/**
 * Refuse to build a filter from an implausibly large declaration rather than
 * truncating one. Truncating would silently starve whichever names fell off
 * the end — the exact failure D-002 exists to prevent — so an over-cap
 * declaration falls back to no filter, which is merely today's behaviour.
 */
export const MAX_DECLARED_QUERY_NAMES = 500;

/**
 * Parse a raw declaration into the set of names the client wants.
 *
 * Returns `undefined` — meaning NO filtering — for every ambiguous input:
 *
 *   - `null`/absent        -> undefined. An un-upgraded client, or one
 *                             mid-handshake, is never degraded.
 *   - parses to EMPTY      -> undefined, NOT "send nothing". This is the
 *                             single most dangerous misreading available
 *                             here: read as an empty allow-list it would
 *                             starve the client completely, and the symptom
 *                             (a UI that never updates) looks like a dead
 *                             connection rather than a filter bug.
 *   - over the cap         -> undefined (see MAX_DECLARED_QUERY_NAMES).
 *
 * A client that genuinely wants nothing simply does not open the stream.
 */
export function parseInterestParam(raw: string | null | undefined): Set<string> | undefined {
  return parseInterestDeclaration(raw).names;
}

/**
 * Why a declaration resolved the way it did.
 *
 * `parseInterestParam` deliberately collapses every fail-open case to a single
 * `undefined`, which is the right shape for the hot path and the WRONG shape
 * for an operator: `over-cap` is a client that WANTED filtering and silently
 * got full fan-out instead, and it is indistinguishable from `absent` (a
 * client that never asked) once both are `undefined`. That is the reversion
 * nobody reports, because from the outside it looks exactly like the feature
 * being switched off.
 */
export type InterestDisposition =
  /** A usable declaration: deliver exactly these names. */
  | 'declared'
  /** No declaration on the wire at all — an un-upgraded or mid-handshake client. */
  | 'absent'
  /** A declaration that normalises to nothing. NEVER read as "send nothing". */
  | 'empty'
  /** More distinct names than the cap allows — refused rather than TRUNCATED. */
  | 'over-cap'
  /** The carrier itself could not be read (a malformed URL). */
  | 'unreadable';

/** The full result of resolving a declaration, disposition included. */
export interface InterestDeclaration {
  readonly disposition: InterestDisposition;
  /** The names to filter on — present ONLY for `disposition: 'declared'`. */
  readonly names?: Set<string>;
  /** Distinct normalised names seen BEFORE the cap decision (0 when absent/unreadable). */
  readonly declaredCount: number;
  /** True whenever the resolved behaviour is full fan-out (every non-`declared` case). */
  readonly failsOpen: boolean;
}

/** The one normalisation rule: trim, drop blanks, de-duplicate, sort. */
export function normalizeInterestNames(names: Iterable<string>): string[] {
  return [...new Set([...names].map((n) => n.trim()))].filter((n) => n.length > 0).sort();
}

/**
 * Apply the cap rule to a name set — the SINGLE definition of it.
 *
 * Both halves of the wire route through here (the client before it builds the
 * param, the server after it parses one), so the cap cannot be enforced at one
 * value on one side and another value on the other. A second copy of `> 500`
 * anywhere is the drift `single-wire-contract` exists to forbid.
 */
export function classifyInterestNames(names: Iterable<string>): InterestDeclaration {
  const sorted = normalizeInterestNames(names);
  if (sorted.length === 0) return { disposition: 'empty', declaredCount: 0, failsOpen: true };
  if (sorted.length > MAX_DECLARED_QUERY_NAMES) {
    return { disposition: 'over-cap', declaredCount: sorted.length, failsOpen: true };
  }
  return {
    disposition: 'declared',
    names: new Set(sorted),
    declaredCount: sorted.length,
    failsOpen: false,
  };
}

/**
 * Parse a raw declaration, reporting WHY as well as WHAT.
 *
 * `parseInterestParam` is derived from this rather than the other way round,
 * so the fail-open table has one implementation and the disposition can never
 * disagree with the filter actually applied.
 */
export function parseInterestDeclaration(raw: string | null | undefined): InterestDeclaration {
  if (raw === null || raw === undefined) {
    return { disposition: 'absent', declaredCount: 0, failsOpen: true };
  }
  return classifyInterestNames(raw.split(','));
}

/**
 * Build the SSE URL carrying `names` as this connection's declaration.
 *
 * Returns the url UNCHANGED when the declaration would be one the server is
 * required to ignore anyway (empty, or over the cap). Emitting it regardless
 * would be harmless given `parseInterestParam` refuses it too, but leaving it
 * off keeps the two sides agreeing on what a declaration MEANS, and keeps a
 * pointlessly huge param off the wire.
 *
 * Names are sorted so an unchanged set produces a byte-identical URL: the
 * reconnect path is driven by URL inequality, and a set that merely got
 * re-enumerated in a different order must not look like a change.
 */
export function withInterestParam(url: string, names: Iterable<string>): string {
  // Route through the SAME classifier the server parses with, rather than
  // re-stating trim/dedupe/cap here: the two sides must agree on what a name
  // IS and on where the cap sits, or the client can emit a declaration the
  // server normalises into a different set than the one intended.
  const { names: usable } = classifyInterestNames(names);
  if (usable === undefined) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${INTEREST_PARAM}=${encodeURIComponent([...usable].join(','))}`;
}
