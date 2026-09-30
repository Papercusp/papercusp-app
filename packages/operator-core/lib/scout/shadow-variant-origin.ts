/**
 * shadow-variant-origin.ts — the ONE place the shadow feedback-conditioned
 * variant vocabulary is defined, and the ONE predicate every ordinary
 * routed-idea reader excludes it with.
 *
 * WHY A SEPARATE (dependency-free) MODULE. The counterfactual critique lab
 * (counterfactual-critique-lab-turn-blender-grader-feedback-int-2026-08-13,
 * D-001) runs a SHADOW trial: for a frozen cohort of already-graded source
 * ideas it generates a feedback-conditioned VARIANT of each, grades both under
 * identical conditions, and measures whether the Blender's critique actually
 * improved the revision. D-001 requires the variants to (a) reuse the existing
 * routed-idea ledger, Blender grading path, and `revises` relationship, (b)
 * leave their SOURCES immutable, and (c) consume NO ordinary routing quota and
 * change no prompt/routing behavior.
 *
 * (c) is the part that cannot live in a comment. A variant rides the SAME
 * `harness_shared.scout_routed_ideas` table as ordinary routed ideas, so every
 * reader that does not filter it out silently absorbs 20 synthetic rows into a
 * production signal. That exclusion is therefore expressed ONCE, here, and
 * imported by each chokepoint — rather than as an `origin <> '…'` literal
 * re-typed per call site, which is exactly the drift shape `ungraded-scope.ts`
 * was created to stop for its own predicate.
 *
 * Deliberately PURE and import-free so the light-weight readers that must apply
 * it (`ungraded-scope.ts`, `cycle-deps.ts`) can do so without taking on the PG
 * layer that `routed-ledger.ts` carries.
 */

/**
 * The `scout_routed_ideas.origin` value carried by a shadow trial variant.
 *
 * A new value in an UNCONSTRAINED text column (migration 471 ships `origin text
 * NOT NULL DEFAULT 'scout'` with no CHECK), so this needs no migration — and
 * every reader that filters `origin = 'scout'` / `origin = 'su-ideate'` already
 * excludes it for free. The chokepoints below are the readers that DON'T.
 */
export const SHADOW_VARIANT_ORIGIN = 'shadow-variant';

/** The `origin` union member, for callers that type the dimension. */
export type ShadowVariantOrigin = typeof SHADOW_VARIANT_ORIGIN;

/**
 * The `coord_links` endpoint kind for a routed-idea node.
 *
 * The lab's lineage edge is variant →`revises`→ source, between two LEDGER rows.
 * The pre-existing `revises` machinery in `routed-ledger.ts#readRoutedIdeas`
 * joins `src_kind='issue'` to `engineer_issues`, because that lineage is filed
 * by an agent as a real work-item. A shadow variant is deliberately NOT a filed
 * work-item — filing 20 would put them in the claimable backlog, which is the
 * ordinary-quota consumption D-001 forbids — so the pair rides the same generic
 * edge table under its own endpoint kind instead.
 */
export const SHADOW_VARIANT_LINK_KIND = 'routed-idea';

/**
 * The relationship the lineage edge carries. Deliberately the EXISTING
 * `revises` rel (D-001: "reuse … the `revises` relationship"), not a new
 * lab-private vocabulary: a variant revises its source, which is the same
 * meaning the grade→revise loop already assigns it.
 */
export const SHADOW_VARIANT_REL = 'revises';

/** True when a ledger row's `origin` marks it a shadow trial variant. */
export function isShadowVariantOrigin(origin: string | null | undefined): boolean {
  return origin === SHADOW_VARIANT_ORIGIN;
}

/**
 * The SQL fragment every ordinary routed-idea reader applies so shadow variants
 * cannot reach a production signal. Returned as a plain string because the
 * chokepoints that need it span two query styles (tagged-template `sql` and
 * composed text); each interpolates it as a literal WHERE conjunct.
 *
 * ⚠ The column is referenced UNQUALIFIED. A query that aliases
 * `scout_routed_ideas` must pass its alias.
 */
export function shadowVariantExclusionSql(alias?: string): string {
  const col = alias ? `${alias}.origin` : 'origin';
  return `${col} <> '${SHADOW_VARIANT_ORIGIN}'`;
}
