/**
 * The `<templateSlug>@run-<token>` plan-run INSTANCE SLUG grammar (WI-7256).
 *
 * A scheduled or manually-run plan template mints one *instance* plan row per
 * fire, whose slug is the template's slug plus a `@run-<token>` suffix (the
 * token is the routine's `last_fired_at` epoch-ms for a scheduled fire, or a
 * module-monotonic epoch-ms for a manual `plans:run-now` — see
 * `harness/routines/plan-run-action.ts`). Those rows accrue PERMANENTLY: one
 * per fire, forever, with nothing pruning them.
 *
 * This module is the ONE place that grammar is written down. It is deliberately
 * dependency-free so the *consumer* side (the `coord.plans` sync projection,
 * which must stay a pure row transform) can share it with the *producer* side
 * (`plan-run-action.ts`, which pulls Postgres + flags) without dragging those
 * deps across the sync boundary. Producer and predicate drifting apart is the
 * failure this placement exists to prevent — a hand-rolled `slug.includes('@run-')`
 * at the call site is what it replaces.
 */

/** The separator between a template slug and its run token. */
export const PLAN_RUN_INSTANCE_SEPARATOR = '@run-';

/** Build the instance slug for one run of `templateSlug` at `token`. */
export function planRunInstanceSlug(templateSlug: string, token: number | string): string {
  return `${templateSlug}${PLAN_RUN_INSTANCE_SEPARATOR}${token}`;
}

/**
 * True when `slug` is a plan-run INSTANCE (a per-fire snapshot), not a plan a
 * human authored.
 *
 * Deliberately stricter than a bare `includes('@run-')`: the token must be a
 * non-empty run of digits at the very END of the slug, so a human-authored slug
 * that merely contains the literal `@run-` is not swept up. A separator with no
 * template before it (`'@run-123'`) is likewise not an instance — there is no
 * parent for it to be an instance OF.
 */
export function isPlanRunInstanceSlug(slug: unknown): boolean {
  return typeof slug === 'string' && /.+@run-\d+$/.test(slug);
}

/**
 * The TEMPLATE slug an instance was minted from, or `null` when `slug` is not an
 * instance slug. (The parent is the plan a reader actually wants to open.)
 */
export function planRunTemplateSlug(slug: unknown): string | null {
  if (typeof slug !== 'string') return null;
  const m = /^(.+)@run-\d+$/.exec(slug);
  return m ? m[1] : null;
}
