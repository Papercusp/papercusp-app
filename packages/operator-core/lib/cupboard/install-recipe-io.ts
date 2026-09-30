/**
 * install-recipe-io — the REAL (network + git + recipe seed) wiring for installing a
 * Cupboard recipe (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-014).
 *
 * Two steps: place the self-describing dir, then seed a `code_recipes` row so the
 * recipe is visible to `recipes:search` / `recipes:get` / `recipes:run`. A dir alone
 * is inert — recipes are resolved from Postgres, never from the store — so reporting
 * success after only the first step would report a recipe that does not exist to any
 * caller.
 *
 * NO-CLOBBER, and this one needs saying out loud because `upsertRecipe` is an UPSERT:
 * it would happily overwrite a local recipe of the same id with a stranger's script.
 * A recipe id is a kebab slug derived from its title, so a collision between an
 * installed recipe and a locally-captured one is not exotic — and silently replacing
 * executable orchestration with someone else's is the worst version of that. So the
 * seed checks first and REFUSES to overwrite; the caller is told the id exists.
 *
 * The seeded row is attributed as installed, not authored here: `createdBy` carries
 * the listing source rather than the installing agent, so the recipe corpus's
 * first-write attribution stays honest.
 */
import {
  installRecipeFromCupboardCore,
  InstallRecipeError,
  type InstallRecipeCoreResult,
} from './install-recipe-core';
import { cupboardGitDeps } from './install-io';
import type { ContentPinRef } from './install-self-describing-core';
import { resolveListingByKind } from './resolve-listing-by-kind';

export interface InstallRecipeFromCupboardInput {
  /** Resolve the mirror repo URL + listing_ref from the Cupboard listing. */
  listingId?: string;
  /** OR install a mirror repo directly (listingRef = the recipe subdir). */
  githubUrl?: string;
  listingRef?: string;
  /** Skip the code_recipes seed — the dir is placed and nothing else. */
  skipSeed?: boolean;
}

export interface InstallRecipeOutcome extends InstallRecipeCoreResult {
  /** Whether a `code_recipes` row was created. */
  seeded: boolean;
  /** Why it was not: 'exists' (no-clobber) | 'skipped' | an error string. */
  seedSkipped?: string;
}

export type InstallRecipeFromCupboardResult =
  | { ok: true; result: InstallRecipeOutcome }
  | { ok: false; status: number; error: string; detail?: string };

/** Seed one recipe row, no-clobber. Injected so the install path is testable without
 *  a live Postgres. */
export type RecipeSeeder = (
  r: InstallRecipeCoreResult,
  source: string,
) => Promise<{ seeded: boolean; reason?: string }>;

async function defaultRecipeSeeder(
  r: InstallRecipeCoreResult,
  source: string,
): Promise<{ seeded: boolean; reason?: string }> {
  const [{ getRecipe, upsertRecipe }, { getOrgPg }] = await Promise.all([
    import('../code-recipes-store'),
    import('@papercusp/db-org'),
  ]);
  const sql = getOrgPg().sql;

  // The no-clobber check upsertRecipe itself does not do. A tiny race remains
  // (another writer could land the same id between this read and the upsert), and it
  // is accepted deliberately: the alternative is a transaction around a network-fed
  // install, and the realistic collision here is a human-timescale name clash, not a
  // concurrent write of the same slug.
  if (await getRecipe(sql, r.recipeId)) return { seeded: false, reason: 'exists' };

  await upsertRecipe(sql, {
    id: r.recipeId,
    title: r.title,
    description: r.description,
    script: r.script,
    toolsUsed: r.toolsUsed,
    tags: r.tags,
    // Attribution: this workspace did not author it. `potSlug: null` is the explicit
    // "genuinely context-less" value the store's contract asks for (D-002 of
    // pot-scope-all-learnings) — an installed recipe belongs to no local pot.
    potSlug: null,
    authorRole: 'cupboard-install',
    createdBy: source,
  });
  return { seeded: true };
}

/**
 * The ONE orchestrated path that installs a recipe from the Cupboard by listing id
 * OR direct github url, and makes it live.
 */
export async function installRecipeFromCupboard(
  input: InstallRecipeFromCupboardInput,
  deps: { seedRecipe?: RecipeSeeder } = {},
): Promise<InstallRecipeFromCupboardResult> {
  let githubUrl = typeof input.githubUrl === 'string' ? input.githubUrl.trim() : '';
  let listingRef = typeof input.listingRef === 'string' ? input.listingRef.trim() : '';

  // The Worker's publish-time content pin (P-002): present ⇒ the install fetches
  // exactly that commit and refuses content-address-mismatch. Only a listing carries
  // one; a direct githubUrl install is an unverified tip clone by construction.
  let pin: ContentPinRef | undefined;

  if (!githubUrl && input.listingId) {
    const resolved = await resolveListingByKind(String(input.listingId), 'recipe');
    if ('error' in resolved) return { ok: false, status: resolved.status, error: resolved.error };
    githubUrl = resolved.githubUrl;
    if (!listingRef) listingRef = resolved.ref;
    pin = resolved.pin;
  }
  if (!githubUrl) return { ok: false, status: 400, error: 'githubUrl or listingId required' };
  if (!listingRef) return { ok: false, status: 400, error: 'listingRef required (the recipe subdir)' };

  let result: InstallRecipeCoreResult;
  try {
    result = await installRecipeFromCupboardCore(
      { githubUrl, listingRef, pin },
      cupboardGitDeps(),
    );
  } catch (e) {
    if (e instanceof InstallRecipeError) return { ok: false, status: e.status, error: e.message };
    return {
      ok: false,
      status: 500,
      error: 'install failed',
      detail: e instanceof Error ? e.message.slice(0, 300) : String(e),
    };
  }

  if (input.skipSeed === true) {
    return { ok: true, result: { ...result, seeded: false, seedSkipped: 'skipped' } };
  }

  const seeder = deps.seedRecipe ?? defaultRecipeSeeder;
  try {
    const seed = await seeder(result, `cupboard:${githubUrl}`);
    return {
      ok: true,
      result: { ...result, seeded: seed.seeded, ...(seed.reason ? { seedSkipped: seed.reason } : {}) },
    };
  } catch (e) {
    // The dir is correctly placed and is the re-seedable source; a seed failure is
    // reported, not fatal — but it MUST be reported, since until it succeeds the
    // recipe is invisible to recipes:search / recipes:run.
    return {
      ok: true,
      result: {
        ...result,
        seeded: false,
        seedSkipped: e instanceof Error ? e.message.slice(0, 300) : String(e),
      },
    };
  }
}
