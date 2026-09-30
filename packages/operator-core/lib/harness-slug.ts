/**
 * The harness/install slug shape the LAUNCH door enforces — the one PG-free home
 * for the pattern every "could this slug actually be launched?" check needs.
 *
 * WHY THIS FILE EXISTS (EI-21563406996333542)
 * `goals:create` stored `install_slug` straight from `ctx.harnessSlug`, so a
 * session in workspace-global scope wrote the wildcard `'*'`. That was accepted,
 * read healthy on every surface, and made the goal PERMANENTLY UNLAUNCHABLE:
 * `adv/launch-su` rejects a slug failing this pattern, so the holder spawn died
 * with a bare "invalid harness slug" pointing nowhere near creation. The repair
 * added an `installSlug` arg to `goals:update` — and validated it by HAND-COPYING
 * launch-su's private regex, which is the `platform-pot-slug.ts` failure one
 * level up: two copies of a rule, one of which is free to drift, and the drift
 * is only observable at a holder launch that may be weeks away.
 *
 * So the validation and the launch door now read the SAME constant. A write door
 * that admits a slug the launch door will refuse is the entire bug class; sharing
 * the pattern is what makes that impossible rather than merely unlikely.
 *
 * Kept dependency-free on purpose: `adv/launch-su` is a route module (heavy
 * transitive imports) and `packages/agent-mcp` tool handlers must be able to
 * import this without dragging a route — the same constraint that kept
 * `PLATFORM_POT_SLUG` out of `pot-membership.ts`.
 */

/**
 * A launchable harness / install / plan / fleet slug. Mirrors — and is now the
 * source of — the pattern `adv/launch-su` applies to `harness`, `plan` and
 * `fleet` before it shells out.
 *
 * Deliberately NOT anchored to lowercase: existing slugs carry mixed case, and
 * tightening this is a migration, not a validation change.
 *
 * The wildcard scope tokens (`'*'`, `'all'`) fail this by construction. That is
 * the point — they are RESOLVED to a concrete Pot at the write door
 * (`PLATFORM_POT_SLUG` for a workspace-global scope), never stored raw.
 */
export const HARNESS_SLUG_RE = /^[A-Za-z0-9._-]+$/;

/** Would the launch door accept this slug? The predicate a write door should ask. */
export function isLaunchableSlug(slug: string): boolean {
  return HARNESS_SLUG_RE.test(slug);
}

/**
 * The tokens that mean "workspace-global scope" rather than naming a Pot.
 *
 * `'all'` is the reason this list exists separately from HARNESS_SLUG_RE: it is a
 * perfectly well-SHAPED slug, so a pattern check waves it through, and it then
 * files the row against a Pot named `all` that does not exist. `'*'` fails the
 * pattern and `'all'` does not, which is precisely why "is it launchable?" and
 * "is it a scope token?" have to be two questions.
 */
export const WILDCARD_SCOPE_TOKENS: readonly string[] = ['*', 'all'];

/**
 * Is this a workspace-global scope token rather than a Pot name?
 *
 * Callers must decide deliberately what to do with a `true`, and the two doors
 * differ on purpose: `goals:create` RESOLVES it (the token arrives from ambient
 * session scope, so refusing would leave a workspace-global session unable to
 * file a goal at all), while `goals:update` REFUSES it (the caller is naming a
 * repair target explicitly and can simply name the Pot).
 */
export function isWildcardScopeToken(slug: string): boolean {
  return WILDCARD_SCOPE_TOKENS.includes(slug);
}
