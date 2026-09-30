/**
 * The fact-cap victim ordering, as a pure function (EI-19451909636567773).
 *
 * ── WHY THIS IS ITS OWN MODULE ─────────────────────────────────────────────
 * `assertFact` needs to tell a writer where their OWN row landed in the victim
 * ranking ("is my fact next?"). The ranking itself lives in SQL, inside the
 * sweep's `ORDER BY`. Answering the writer's question means evaluating that
 * same ordering in TypeScript — which creates a MIRROR, and a mirror that can
 * drift from the thing it reflects is worse than no answer at all: it reports a
 * confident survival verdict the sweep then contradicts.
 *
 * Extracted here so the mirror is a NAMED, pure, directly-testable thing rather
 * than an anonymous comparator buried in a 2,000-line store. Two guards hold it
 * to the SQL, and they fail in different ways on purpose:
 *
 *   • `sweep-ranking.test.ts` (unit, no DB) pins the ordering against a
 *     deliberately-WRONG control implementation kept permanently in the test
 *     file. That control is what proves the assertions can fail at all — a
 *     guard that has never failed is a guard nobody has tested, and the repo
 *     rule is to prove it with a permanent control rather than by mutating
 *     production code in a shared tree.
 *   • `store.integration.test.ts` ("survival-ranking-matches-sweep") pins it
 *     against the REAL SQL: it predicts a victim from this function and then
 *     causes an actual eviction, asserting the row the sweep destroys is the
 *     row this function named. That is the only check that can catch the two
 *     drifting apart, because it runs both.
 *
 * ⚠ If you change the `ORDER BY` in `store.ts`'s eviction sweep, change this
 * function in the same edit. The integration guard will red if you do not.
 */

/** A `FactConfidence`-shaped value, kept loose so a raw DB row is accepted. */
type ConfidenceLike = string | null;

/**
 * The columns the sweep's `ORDER BY` reads. Deliberately snake_case: these are
 * raw DB rows, and re-mapping them would add a second place to make a mistake.
 */
export interface SweepRankableRow {
  id: string | number | null;
  confidence: ConfidenceLike;
  expires_at: string | Date;
  /**
   * Required since EI-19483432832662150: key 2 is a fraction of the DECLARED
   * TTL, and the declared TTL is only recoverable as `expires_at - created_at`.
   */
  created_at: string | Date;
  updated_at: string | Date;
}

/**
 * The confidence key, as the SQL `CASE` expression computes it.
 *
 * An UNSET confidence ranks WITH 'provisional' (1), not worst — most rows
 * predate the column, and ranking them worst would mass-evict the entire legacy
 * corpus on the next assert. This mirrors WI-6935 (c); see the sweep comment.
 */
export function sweepConfidenceRank(confidence: ConfidenceLike): number {
  return confidence === 'verified' ? 0 : confidence === 'suspected' ? 2 : 1;
}

const epochMs = (v: string | Date): number => new Date(v).getTime();

/**
 * Remaining share of the TTL its author declared, mirroring the SQL expression:
 *   (expires_at - now()) / GREATEST(expires_at - created_at, 1 second)
 *
 * ~1.0 = just written; ~0.0 = about to expire. The GREATEST guard mirrors the
 * SQL's and covers only a degenerate zero-length TTL — `created_at` and
 * `expires_at` are both NOT NULL in the schema, so there is no null case.
 */
export function sweepRemainingFraction(row: SweepRankableRow, nowMs: number): number {
  const expires = epochMs(row.expires_at);
  const ttlMs = Math.max(expires - epochMs(row.created_at), 1000);
  return (expires - nowMs) / ttlMs;
}

/**
 * Order rows MOST-valuable-first — the same order the sweep ranks victims in,
 * where the tail past the cap is what gets evicted.
 *
 * Mirrors, key for key:
 *   ORDER BY CASE confidence ... END ASC,
 *            (EXTRACT(epoch FROM (expires_at - now()))
 *               / GREATEST(EXTRACT(epoch FROM (expires_at - created_at)), 1)) DESC,
 *            updated_at DESC
 *
 * Returns a new array; the input is not mutated.
 *
 * ⚠ `nowMs` is a REAL input, not a convenience default. Key 2 became a fraction
 * of elapsed life in EI-19483432832662150, so this ordering is TIME-DEPENDENT:
 * the same rows can order differently at two instants with no write in between
 * (that is the point — it is how a short-lived fact serves its purpose and then
 * yields). A caller checking against a specific SQL result should pass that
 * statement's instant; the default is right only for "as of right now".
 *
 * ⚠ Exact ties are ORDER-AMBIGUOUS in SQL (no total order is specified), so
 * this function does not invent a tiebreak to look more precise than the thing
 * it mirrors. Callers must treat a tied tail as "one of these goes next", not
 * "this exact one goes next". Ties are rarer under a continuous fraction than
 * under a timestamp, but not impossible.
 */
export function orderAsSweepWould<T extends SweepRankableRow>(
  rows: readonly T[],
  nowMs: number = Date.now(),
): T[] {
  return [...rows].sort((a, b) => {
    const byConfidence = sweepConfidenceRank(a.confidence) - sweepConfidenceRank(b.confidence);
    if (byConfidence !== 0) return byConfidence;
    // DESC: the LARGER remaining fraction ranks first (survives).
    const byFraction = sweepRemainingFraction(b, nowMs) - sweepRemainingFraction(a, nowMs);
    if (byFraction !== 0) return byFraction;
    return epochMs(b.updated_at) - epochMs(a.updated_at);
  });
}

/**
 * Where `id` sits in that ordering, 1-based; 0 when the id is not present.
 *
 * ⚠ Compares ids as STRINGS. `id` is a bigint column, so the driver may hand
 * back either a JS number or an exact-precision string, and a `===` across the
 * two silently never matches — which would report "not found" for every write
 * and make the whole survival signal quietly disappear rather than fail loudly.
 */
export function rankOfId(ordered: readonly SweepRankableRow[], id: string | number | null): number {
  if (id === null || id === undefined) return 0;
  const idx = ordered.findIndex((r) => String(r.id) === String(id));
  return idx + 1;
}

/**
 * Does `candidate` rank STRICTLY ABOVE `incumbent` in the sweep's ordering?
 * (EI-21585375376448939)
 *
 * The cross-author cap guard needs exactly one bit before it refuses a write:
 * is the incoming fact BETTER than the row it would displace? Answering that
 * by re-deriving the comparison at the call site would recreate the anonymous
 * buried comparator this module exists to prevent (see the header), so the
 * question gets a named, pure, directly-testable home here beside the ordering
 * it depends on.
 *
 * ⚠ STRICT: a tie returns false. The SQL ordering specifies no total order, so
 * tied rows are "one of these goes next", not a decidable winner — and the
 * caller is a protective guard, where the safe reading of "no better than" is
 * "do not displace". Ties therefore keep the refusal rather than silently
 * resolving in the writer's favour.
 */
export function outranksForSweep(
  candidate: SweepRankableRow,
  incumbent: SweepRankableRow,
  nowMs: number = Date.now(),
): boolean {
  // Each key mirrors `orderAsSweepWould`'s comparator with `candidate` as `a`
  // and `incumbent` as `b`: that sort returns NEGATIVE when `a` sorts first, so
  // "candidate outranks incumbent" is exactly "that comparator would be < 0".
  const byConfidence =
    sweepConfidenceRank(candidate.confidence) - sweepConfidenceRank(incumbent.confidence);
  if (byConfidence !== 0) return byConfidence < 0;
  // DESC on remaining fraction: the LARGER fraction sorts first, so the sort
  // term is frac(incumbent) - frac(candidate) and the candidate wins when it is
  // negative — i.e. when the candidate has MORE life left.
  const byFraction =
    sweepRemainingFraction(incumbent, nowMs) - sweepRemainingFraction(candidate, nowMs);
  if (byFraction !== 0) return byFraction < 0;
  return epochMs(incumbent.updated_at) < epochMs(candidate.updated_at);
}
