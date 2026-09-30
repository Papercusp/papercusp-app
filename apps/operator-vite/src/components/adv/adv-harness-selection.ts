import type { HarnessScopeMode } from '@papercusp/operator-core/lib/harness/scope';

/**
 * Select display token for the "All harnesses" row. Widget-only: picking it
 * sets `?scope=all`; it is NEVER written to `?slug=` (which always holds a
 * real harness slug or null). Keeping the sentinel out of `?slug=` means
 * every `?slug=` consumer stays sentinel-unaware — the "all" intent lives
 * entirely on the orthogonal `?scope=` axis. It IS a valid persisted value
 * (localStorage) so "I chose All" survives a reload.
 */
export const ALL_HARNESSES_OPTION = '__all__';

/**
 * Decide the harness selection to apply on a fresh /adv load (no explicit
 * `?slug=` yet). Pure + standalone so the precedence is unit-tested without
 * importing the AdvShell component tree.
 *
 *   1. An explicit `?scope=all` OR valid `?slug=` in the URL wins — leave it
 *      alone (deep link / refresh).
 *   2. Else restore the persisted selection: a persisted concrete slug (still
 *      a real project) → select it in scope=expanded, which exits "all" mode
 *      so the full per-harness tab strip shows.
 *   3. Else (nothing persisted, or the persisted value is the ALL sentinel) →
 *      All-harnesses (scope=all).
 *
 * Returns the fields to set; an empty object means "no change". `setSlug` is
 * only ever a real project slug (the ALL sentinel never lands in ?slug=).
 */
export function resolveAdvHarnessSelection(opts: {
  projectSlugs: readonly string[];
  urlSlug: string | null;
  urlScope?: HarnessScopeMode;
  persisted: string | null;
}): { setSlug?: string; setScope?: HarnessScopeMode } {
  const { projectSlugs, urlSlug, urlScope, persisted } = opts;
  if (projectSlugs.length === 0) return {};
  if (urlScope === 'all') return {};
  if (urlSlug && projectSlugs.includes(urlSlug)) return {};
  if (persisted && persisted !== ALL_HARNESSES_OPTION && projectSlugs.includes(persisted)) {
    return { setSlug: persisted, setScope: 'expanded' };
  }
  return { setScope: 'all' };
}
