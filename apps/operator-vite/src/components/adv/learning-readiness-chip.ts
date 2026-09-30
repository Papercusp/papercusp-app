/**
 * learning-readiness-chip — the Verify strip's rubric chip text (EI-21949865560276745).
 *
 * PURE, and a sibling module rather than an inline template literal, for the reason the
 * neighbouring `learning-pot-drawer.ts` / `learning-pot-rail.ts` are: wording that
 * encodes a judgement deserves a test, and this text now encodes three of them.
 *
 * What it is fixing. The chip used to read `rubric: active · 4 scorecards · latest 9/10`,
 * where BOTH numbers overstated confidence and neither could look wrong:
 *
 *  - the count included PROVISIONAL working notes and audit-PENDING gradings — the two
 *    classes the trend refuses to count as settled evidence — so "4 scorecards" was not
 *    4 gradings;
 *  - the score was simply the newest of those rows, so a mid-run working note could BE
 *    the release score;
 *  - and a grade whose generation had since ENDED (a restart voids it — the 2026-07-17
 *    case: a 4.5h soak and a 6/6 verdict dead three minutes after emit) rendered exactly
 *    like a current one.
 *
 * The reader now admits settled cards only, so the count is genuinely evidence — which
 * is precisely why the label had to change with it. Leaving it saying "scorecards" while
 * it had quietly started counting something narrower would be the same stale-description
 * defect one level up: nothing fails, and the only symptom is a reader believing a
 * number that no longer means what it says.
 */
import type { ReleaseReadinessRubricInfo } from "@papercusp/operator-core/lib/sync-resolver/learning-release-readiness-read";

export function readinessRubricChipText(
  rubric: ReleaseReadinessRubricInfo | null | undefined,
): string {
  if (!rubric) return "rubric: none proposed";

  const ev = rubric.scoreEvidence;
  const unsettled =
    (ev?.excluded.provisional ?? 0) + (ev?.excluded.gradingAuditPending ?? 0);

  if (rubric.scorecardCount <= 0) {
    // "Graded, but nothing has SETTLED" is a different — and worse — state than "never
    // graded", because it looks like activity. Before the admission policy applied here
    // the first case was indistinguishable from a healthy one.
    return unsettled > 0
      ? `rubric: ${rubric.status} · no settled grade (${unsettled} unsettled)`
      : `rubric: ${rubric.status} · no scorecards yet`;
  }

  const parts: string[] = [
    // The trailing '+' is the truncation marker: past the page cap this count is a
    // FLOOR, and a floor rendered as a total is the failure the marker exists to stop.
    `${rubric.scorecardCount} settled${ev?.countTruncated ? "+" : ""}`,
  ];
  if (rubric.latestScore10 != null) parts.push(`latest ${rubric.latestScore10}/10`);
  // Only 'stale' is called out. 'unknown' must NOT be shown as a warning (it is an
  // unstamped or unresolvable card, not a dead one) and must not be shown as fine
  // either — silence is the honest rendering of "not recorded".
  if (ev?.latestGenerationFreshness === "stale") parts.push("gen ended");

  return `rubric: ${rubric.status} · ${parts.join(" · ")}`;
}
