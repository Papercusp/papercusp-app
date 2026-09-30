/**
 * The platform (dogfood) Pot slug — the ONE pure, PG-free home for the literal
 * every "is this papercusp itself?" check needs.
 *
 * WHY THIS FILE EXISTS (EI-19370922358009801)
 * The literal `'papercusp'` was written out THREE times independently — here's
 * where it used to live: `pot-membership.ts` (`PLATFORM_POT_SLUG`),
 * `harness-registry.ts` (a private `CANONICAL_DOGFOOD_SLUG`), and — the one that
 * broke — `improvements/triage.ts`, which hardcoded the PRE-RENAME spelling
 * `'harness:papercup'` in its self-scope allowlist and was never updated when the
 * Pot became `papercusp`. Migrations 630/631 (owner-directed, 2026-07-19) re-slugged
 * the workspace's own issues onto `harness_slug='papercusp'`, the engineer_issues
 * view derives `scope = 'harness:' || harness_slug`, and from that moment the
 * classifier read EVERY dogfood idea as "an external project's code" → `product` →
 * unconditional `place`. ~1,100 consecutive decisions, one label, 13 days.
 *
 * `pot-membership.ts` could not be the SSOT for a pure classifier: it imports
 * `@papercusp/db-org`, so consuming it drags a PG client into pure code. Hence a
 * dependency-free module both can import. `pot-membership` re-exports both symbols,
 * so every existing call site is unchanged.
 */

/**
 * The canonical dogfood / platform Pot slug — a workspace's own "self" Pot.
 * Mirrors the SQL `harness_shared.canonical_harness_slug` (migration 359) and the
 * migration-649 backfill catch-all target. A workspace-global ("operator") work
 * item homes here.
 */
export const PLATFORM_POT_SLUG = 'papercusp';

/** The pre-rename spellings of the platform Pot that still appear in old rows. */
export const LEGACY_PLATFORM_POT_SLUGS: readonly string[] = ['papercup', 'papercup-hive'];

/**
 * TS mirror of `harness_shared.canonical_harness_slug` (SQL migration 359): the
 * legacy dogfood repo name folds to the platform Pot; everything else is unchanged.
 * Keep aligned with the SQL function and the P-006 backstop migration.
 */
export function canonicalPotSlug(slug: string): string {
  return LEGACY_PLATFORM_POT_SLUGS.includes(slug) ? PLATFORM_POT_SLUG : slug;
}

/**
 * Is this `harness:<slug>`-shaped scope the PLATFORM Pot (i.e. papercusp itself),
 * under any spelling it has ever had? The one predicate a "self vs external project"
 * branch should ask — never a literal comparison, which is what rotted.
 */
export function isPlatformPotScope(scope: string): boolean {
  const HARNESS_PREFIX = 'harness:';
  if (!scope.startsWith(HARNESS_PREFIX)) return false;
  return canonicalPotSlug(scope.slice(HARNESS_PREFIX.length).trim()) === PLATFORM_POT_SLUG;
}
