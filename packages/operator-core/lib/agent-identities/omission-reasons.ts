/**
 * Why a selected identity output was NOT produced. One source for the binder
 * (source.ts, which writes `omitted:<reason>` pins) and every reader that
 * parses those pins back (role-launch-spec.ts), so a new reason cannot be
 * accepted by the writer while a reader's hand-kept regex silently drops it.
 *
 * - ineligible     — the contribution does not apply to this subject.
 * - not-requested  — the sink did not ask for it this time.
 * - unavailable    — it applies but could not be produced (carries errorRef).
 * - experiment-arm — an R-4 / D-032 behavior arm deliberately withheld it, so a
 *                    grader can tell an arm-withheld delivery from a genuinely
 *                    absent one using receipts alone.
 */
export const IDENTITY_OMISSION_REASONS = [
  'ineligible',
  'not-requested',
  'unavailable',
  'experiment-arm',
] as const;

export type IdentityOmissionReason = (typeof IDENTITY_OMISSION_REASONS)[number];

/** Matches a pinned `omitted:<reason>` decision for any known reason. */
export const OMITTED_DECISION_PATTERN = new RegExp(`^omitted:(${IDENTITY_OMISSION_REASONS.join('|')})$`);
