/**
 * admitted-composition-format.ts — the ONE prose rendering of an admitted lane's
 * nit/minor share (EI-22184028605968917).
 *
 * WHY ITS OWN MODULE, beside the fold that produces the numbers rather than inside it:
 * `get-next.ts` is the DB-backed scheduler, and the two consumers of this sentence
 * (`work_items:claimable`, `fleet:launch-on-plan`) sit in suites that MOCK that whole
 * module to stay database-free. A pure formatter exported from there is replaced by the
 * mock along with everything else — it arrives `undefined` at the call site, which turns
 * a prose fix into a TypeError in exactly the degenerate-lane branch it was written for.
 * A DB-free module cannot be shadowed that way, and the type import below is erased at
 * runtime, so importing this costs a consumer nothing.
 */
import type { IssueClaimAdmittedComposition } from './get-next';

/**
 * "N of M row(s) (P%) are nit/minor severity" — the single rendering every consumer that
 * says this in prose must use.
 *
 * EI-22184028605968917: both sites hand-rendered `Math.round(share * 100)`, and at
 * 2,363 of 2,366 that prints **"100% of this lane is nit/minor severity"** while three
 * major-severity rows sit in the same payload. Any share >= 99.5% rounds up, so at that
 * lane size up to ~11 non-low rows are erased by the sentence. The erased rows are
 * precisely the population the warning exists to protect: prose whose job is to stop a
 * reader quoting the count as a workload deleted the only rows in it that WERE workload.
 * It had already propagated into a plan Decision titled "the admitted claim pool is now
 * 100% low-severity".
 *
 * Two rules, both structural rather than advisory:
 *  - FLOOR to one decimal, never round: the sentence may understate the share, never
 *    overstate it, so "P%" is always safe to read as "at least P%".
 *  - "100%" is printed ONLY when `low >= total`. It is a claim of EMPTINESS about the
 *    non-low population, so it is gated on that population actually being empty, not on
 *    a percentage that happens to land there.
 *
 * The COUNTS lead the percentage for the same reason `total` travels with
 * `lowSeverityShare` on the composition itself: "2363 of 2366" cannot round a row away,
 * and it carries its own denominator. `low` is recomputed from `bySeverity` — exact
 * integers under the same nit+minor definition `summarizeAdmittedRows` folds — rather
 * than from the float share.
 */
export function formatLowSeverityShare(
  comp: Pick<IssueClaimAdmittedComposition, 'total' | 'bySeverity'>,
  noun = 'row(s)',
): string {
  const total = comp.total;
  if (total <= 0) return `0 of 0 ${noun} are nit/minor severity`;
  const bySeverity = comp.bySeverity ?? {};
  const low = (bySeverity.nit ?? 0) + (bySeverity.minor ?? 0);
  const pct = low >= total ? 100 : Math.floor((low / total) * 1000) / 10;
  const rendered = Number.isInteger(pct) ? `${pct}` : pct.toFixed(1);
  return `${low} of ${total} ${noun} (${rendered}%) are nit/minor severity`;
}
