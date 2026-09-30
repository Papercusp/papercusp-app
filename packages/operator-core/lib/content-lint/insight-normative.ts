/**
 * Normative-insight frontmatter detector — enforces that an insight which
 * DECLARES itself a convention also declares what it governs
 * (unified-agent-state-plane-2026-07-27 P-022, per D-028).
 *
 * The agent-insights corpus mixes two very different kinds of document:
 * explanatory runbooks ("here is how X works / how I debugged Y") and
 * NORMATIVE conventions ("do it this way"). Only the second kind can be
 * violated, so only the second kind is worth projecting into a guard or a
 * compliance denominator. `normative: true` is that opt-in marker.
 *
 * A `normative: true` doc with no `governs:` is the failure this guards: it
 * asserts "I am a rule" while leaving the trigger/surface it applies to
 * unstated, so nothing downstream can decide WHEN the rule is in force. Such
 * a doc is strictly worse than an unmarked one — it inflates the adoption
 * denominator with an entry no projector can act on.
 *
 * Absence of `normative` means "not a convention". That default-off is
 * deliberate and is NOT a dark feature flag: this is a CLASSIFICATION of
 * existing prose, not shipped behavior gated off, so the repo's
 * flags-default-ON mandate does not apply.
 *
 * Pure detector (no fs, no git) — the thin walker
 * `scripts/check-insight-normative.mjs` supplies the corpus, exactly as
 * insight-citations.ts / check-insight-citations.mjs are paired. Frontmatter
 * is read with the SAME parser the insights index uses (`parseFrontmatter`)
 * so the lint and the index can never disagree about what a doc declares.
 */
import { parseFrontmatter } from '../memory/insights-index';

/** Why a doc failed the normative-frontmatter contract. */
export type NormativeViolationKind =
  /** `normative: true` but no non-empty `governs:`. */
  | 'missing-governs'
  /** `normative:` present with a value that is not `true`/`false`. */
  | 'invalid-normative';

/** One violation: the rule broken + the offending value (for the report). */
export interface NormativeViolation {
  kind: NormativeViolationKind;
  /** The raw `normative:` value as written, for 'invalid-normative'. */
  value?: string;
}

/** True when a frontmatter field carries at least one non-empty entry. */
function isPresent(value: string | string[] | undefined): boolean {
  if (value == null) return false;
  return Array.isArray(value)
    ? value.some((v) => v.trim() !== '')
    : value.trim() !== '';
}

/**
 * Pure detector: the doc's normative-frontmatter violations, or `[]` when it
 * is valid — which INCLUDES the common cases of "no frontmatter at all" and
 * "not marked normative" (nothing to enforce; this lint never requires a doc
 * to opt in).
 */
export function findNormativeViolations(body: string): NormativeViolation[] {
  const fm = parseFrontmatter(body);
  if (!fm) return [];

  const raw = fm.normative;
  if (raw == null) return []; // not a convention — nothing to enforce
  if (Array.isArray(raw)) return [{ kind: 'invalid-normative', value: raw.join(', ') }];

  const normalized = raw.trim().toLowerCase();
  if (normalized === '' || normalized === 'false') return [];
  if (normalized !== 'true') return [{ kind: 'invalid-normative', value: raw.trim() }];

  // normative: true — `governs` is now REQUIRED.
  return isPresent(fm.governs) ? [] : [{ kind: 'missing-governs' }];
}

/** Render a `NormativeViolation[]` as the one human-readable error string the CI lint reports. */
export function formatNormativeViolations(violations: NormativeViolation[]): string | null {
  if (violations.length === 0) return null;
  return violations
    .map((v) =>
      v.kind === 'missing-governs'
        ? '`normative: true` without `governs:` — declare the trigger/surface this convention applies to'
        : `\`normative:\` must be true or false (got: ${v.value ?? ''})`,
    )
    .join('; ');
}
