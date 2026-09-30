/**
 * P-009 (review-routing-through-relevance-router-2026-09-26, D-002): which started-BAR
 * amendments need an outside-lineage approval.
 *
 * RULE. An amendment skips approval only when EVERY change is mechanically additive: it adds a
 * structured `check` where none existed, or grows an existing check's or the BAR's
 * `requiredTestLayers` arrays without changing anything else. Anything the classifier cannot
 * prove additive keeps the review: a removed BAR, a new BAR (new prose meaning), a prose
 * rewording, a changed check kind or scalar, a narrowed array, or any other meaning field. A
 * mixed amendment (one addition plus one rewording) still requires approval.
 *
 * WHY MECHANICAL. Strictness is judged from the shape of the diff alone, never from what the
 * prose says, so the verdict cannot be argued into "additive" by wording. `barHash` is ignored
 * because the canonical writer derives it from the other meaning fields; it always moves with
 * them.
 *
 * Consumes the rubric loss guard's `changes` (the same diff that decides `changedBars`), so the
 * set of BARs judged here is exactly the set whose meaning moved.
 */

export type AmendmentChange = { barKey: string; kind: string; fields: readonly string[] };

export interface AmendmentAdditivity {
  /** True unless every meaning change was proven additive. */
  approvalRequired: boolean;
  /** Changed BARs whose every change is additive. */
  additiveBars: string[];
  /** Changed BARs that keep the review, each with the first reason found. */
  reviewedBars: Array<{ barKey: string; reason: string }>;
}

/** Fields that may change additively. Everything else in a meaning change keeps the review. */
const ADDITIVE_FIELDS = new Set(['check', 'requiredTestLayers']);
/** Derived from the other meaning fields by the canonical writer. */
const DERIVED_FIELDS = new Set(['barHash']);

const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : v,
);

const isAbsent = (value: unknown): boolean =>
  value === undefined || value === null || (Array.isArray(value) && value.length === 0);

/**
 * `next` only ADDS to `prior`: absent → anything, arrays grow (every prior element kept),
 * objects keep the same keys with each value additive, scalars are unchanged.
 */
export function isAdditiveValue(prior: unknown, next: unknown): boolean {
  if (isAbsent(prior)) return true;
  if (Array.isArray(prior)) {
    if (!Array.isArray(next)) return false;
    const kept = new Set(next.map(canonical));
    return prior.every((element) => kept.has(canonical(element)));
  }
  if (typeof prior === 'object') {
    if (!next || typeof next !== 'object' || Array.isArray(next)) return false;
    const priorRecord = prior as Record<string, unknown>;
    const nextRecord = next as Record<string, unknown>;
    // A key the prior value lacked could narrow the check (a filter, a pattern), so it is
    // not provably additive.
    if (Object.keys(nextRecord).some((key) => !(key in priorRecord) && !isAbsent(nextRecord[key]))) return false;
    return Object.keys(priorRecord).every((key) => isAdditiveValue(priorRecord[key], nextRecord[key]));
  }
  return canonical(prior) === canonical(next);
}

export function classifyAmendmentAdditivity(input: {
  changes: readonly AmendmentChange[];
  prior: ReadonlyArray<Record<string, unknown>>;
  next: ReadonlyArray<Record<string, unknown>>;
  barKeyOf: (criterion: Record<string, unknown>) => string;
}): AmendmentAdditivity {
  const priorByKey = new Map(input.prior.map((criterion) => [input.barKeyOf(criterion), criterion]));
  const nextByKey = new Map(input.next.map((criterion) => [input.barKeyOf(criterion), criterion]));
  const reasons = new Map<string, string>();
  const additive = new Set<string>();
  const keep = (barKey: string, reason: string) => {
    if (!reasons.has(barKey)) reasons.set(barKey, reason);
  };

  for (const change of input.changes) {
    if (change.kind === 'removed') keep(change.barKey, 'BAR removed');
    else if (change.kind === 'added') keep(change.barKey, 'new BAR (new prose meaning)');
    else if (change.kind === 'meaning') {
      const prior = priorByKey.get(change.barKey);
      const next = nextByKey.get(change.barKey);
      const fields = change.fields.filter((field) => !DERIVED_FIELDS.has(field));
      if (!prior || !next) keep(change.barKey, 'BAR missing on one side of the diff');
      else if (fields.length === 0) keep(change.barKey, 'derived hash moved without a meaning field');
      else {
        const blocking = fields.find(
          (field) => !ADDITIVE_FIELDS.has(field) || !isAdditiveValue(prior[field], next[field]),
        );
        if (blocking) {
          keep(
            change.barKey,
            ADDITIVE_FIELDS.has(blocking) ? `${blocking} removed or changed, not only added to` : `${blocking} changed`,
          );
        } else additive.add(change.barKey);
      }
    }
  }

  const reviewedBars = [...reasons].map(([barKey, reason]) => ({ barKey, reason }));
  return {
    approvalRequired: reviewedBars.length > 0,
    additiveBars: [...additive].filter((barKey) => !reasons.has(barKey)).sort(),
    reviewedBars,
  };
}
