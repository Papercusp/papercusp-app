/**
 * The `learning.improvements` WIRE CONTRACT — the pieces both the server compute
 * and the browser client need, and nothing else.
 *
 * ── Why this is its own module ───────────────────────────────────────────────
 * Its sibling `learning-digest-snapshot.ts` is a SERVER module: the body of
 * `computeLearningImprovementsSnapshot` dynamically imports read-items, the
 * queue-ranker, flow-metrics and the workspace registry — the PG-touching half
 * of the operator. The Learning tab needs exactly one pure function from that
 * file (`tierReasonOf`), and importing it from there would turn an ERASED
 * type-only import in LearningTab.tsx into a real one, putting that whole
 * dynamic-import graph in front of the browser bundler.
 *
 * So the contract lives here, in a leaf with NO imports at all, and the server
 * module re-exports it. Both sides are then reading one definition — the thing
 * that actually matters, since a client that decoded `trc` against its own copy
 * of the rules would drift silently rather than fail.
 */

/**
 * The wire key carrying the INTERNED `tierReason` (WI-39773 / plan
 * learning-tab-filters-are-page-scoped-2026-08-17 D-008).
 *
 * Measured live on :3170 2026-08-18: `tierReason` was 83,526 B of a 272,705 B
 * humanQueue — 30.6%, 167 B/row — across only SIX distinct sentences repeated on
 * 500/500 rows. The repetition was the cost, not the content, so it ships as a
 * code into {@link TierReasonLegend} instead of as the sentence.
 *
 * ⚠ The key is deliberately SHORT, and that is load-bearing rather than terse
 * for its own sake: at a full-corpus window (~623 rows) a 12-character key name
 * would be ~7 KB of pure key repetition, which is the margin between fitting the
 * 250,000 B sync-read budget and missing it. See D-008.
 *
 * ⚠ The prior record of this field said "15% across FOUR distinct strings"
 * (WI-7278). Both figures were carried rather than re-measured, and both were
 * wrong — re-measure before citing either.
 */
export const TIER_REASON_CODE_KEY = 'trc';

/**
 * Every distinct `tierReason` in ONE payload, in code order.
 *
 * Deliberately per-payload rather than a shared enum: the tier-reason strings are
 * generated prose ("touches protected path … → human") that changes with the
 * risk-tier policy, so a client holding its own copy would decode stale text
 * without any error. Shipping the legend beside the rows makes each payload
 * self-describing.
 */
export type TierReasonLegend = string[];

/** The interned-reason half of a humanQueue row. Structural on purpose, so this
 *  module needs no import from the digest types. */
export interface HasTierReasonCode {
  trc?: number;
}

/**
 * Resolve a humanQueue row's tier reason back to its sentence.
 *
 * The ONE supported way to read `trc` — never index the legend by hand. A row
 * paired with a DIFFERENT payload's legend resolves to the wrong sentence rather
 * than failing, so keeping every read on this one call is what makes that
 * mistake visible in review instead of at runtime.
 *
 * Returns '' — never `undefined` — for a missing, legend-less, or out-of-range
 * code. The Learning tab concatenates the result straight into its quick-search
 * haystack, and a `undefined` there would inject the literal text "undefined"
 * into every row, making a search for "undef" match everything.
 */
export function tierReasonOf(
  legend: readonly string[] | undefined,
  item: HasTierReasonCode | null | undefined,
): string {
  const code = item?.trc;
  if (code === undefined || !legend) return '';
  return legend[code] ?? '';
}
