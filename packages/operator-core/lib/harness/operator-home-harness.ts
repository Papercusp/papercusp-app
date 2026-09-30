/**
 * operatorHomeHarnessSlug — the SINGLE source of truth for "which harness/hive is
 * the workspace's operator HOME": where workspace-level maintenance routines seed,
 * what operator-scoped plans default to, etc.
 *
 * papercup→papercusp generalization (2026-06-19, owner-directed): historically ~30
 * sites baked the literal `'papercup'` (`process.env.X ?? 'papercup'`), which made
 * the dev harness a hardcoded special case. That is legacy. The home hive is named
 * ONCE — by the `PAPERCUSP_POT_HOME_SLUG` pointer — and every site derives from it
 * here, so:
 *   - ANY hive can be the operator home (just point the env at it),
 *   - the designated hive (today: `papercusp`) is treated like any other hive — the
 *     ONLY thing that makes it "home" is this one pointer,
 *   - no slug literal is scattered across the codebase.
 *
 * Sync + env-only, so module-level consts and Zod arg-defaults can call it (the
 * async `resolveHomeHiveSlug` in agent-tools/hive/_resolve.ts is the runtime
 * counterpart that additionally falls back to the registry's first hive).
 *
 * `LEGACY_DEFAULT_HOME_HARNESS` is the LAST-resort fallback for installs that predate
 * the pointer — the single, intentional place the old `papercup` literal survives.
 * Set `PAPERCUSP_POT_HOME_SLUG` to designate the home hive on any install.
 */

/** Last-resort fallback when PAPERCUSP_POT_HOME_SLUG is unset. Flipped papercup→papercusp
 *  (owner-directed full migration, 2026-06-20): papercusp is the workspace's default home, so
 *  no env-less process falls back to the retired 'papercup' slug. */
export const LEGACY_DEFAULT_HOME_HARNESS = 'papercusp' as const;

/** The env pointer that names the workspace's operator-home hive. */
export const HOME_HARNESS_ENV = 'PAPERCUSP_POT_HOME_SLUG' as const;

/**
 * Resolve the operator-home harness slug from the single pointer. Returns the
 * `PAPERCUSP_POT_HOME_SLUG` value when set, else the legacy default. Sync, pure
 * over `process.env` — safe in module-level consts and arg defaults.
 */
export function operatorHomeHarnessSlug(): string {
  const ptr = process.env[HOME_HARNESS_ENV]?.trim();
  return ptr && ptr.length > 0 ? ptr : LEGACY_DEFAULT_HOME_HARNESS;
}

/**
 * Retired → current harness-slug aliases. When a home/registered harness is
 * RENAMED, lingering references to the old slug — a stale env var, persisted ctx,
 * a fire-path/autoloop row, an un-restarted bg-host — keep resolving to a 404 long
 * after the rename. That is exactly how EI-2224 went dark: `papercup` was renamed
 * to `papercusp` on 2026-06-19, but `PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS=papercup`
 * (and the home ctx) still pointed at the retired slug, so every fire / dispatch /
 * spawn 404'd ("unknown project") and the auto-implement dispatcher sat silently
 * dark ~34h while ~100+ auto-eligible bugs starved.
 *
 * This is a RENAME-COMPAT shim, not an arbitrary normalizer: only a KNOWN retired
 * slug maps to its current name, and resolution still PREFERS a direct registry hit
 * (see `resolveProject`), so a genuine registration under the old slug — should one
 * ever exist — still wins. Add an entry here whenever a home/registered harness is
 * renamed, so the rename self-heals instead of darkening a fire-path.
 */
export const RETIRED_HARNESS_SLUG_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  papercup: 'papercusp',
  // The home HIVE's legacy slug (retired 2026-06-19 with the papercup→papercusp
  // rebrand; the hive is now `papercusp`). A lingering queen/fire-path on
  // `papercup-hive` 404/400'd ("unknown project") instead of self-healing — its
  // sibling `papercup` was aliased but this one was the gap (infra-fail-fast P-014/D1).
  'papercup-hive': 'papercusp',
});

/**
 * Canonicalize a (possibly retired) harness slug to its current name. Returns the
 * trimmed input unchanged when it is not a known retired slug. Pure + sync — safe
 * in module-level consts, arg defaults, and the registry resolver.
 */
export function canonicalHarnessSlug(slug: string): string {
  const s = slug?.trim();
  if (!s) return slug;
  return RETIRED_HARNESS_SLUG_ALIASES[s] ?? s;
}
