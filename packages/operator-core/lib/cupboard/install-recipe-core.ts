/**
 * Install a recipe FROM the Cupboard into the local recipe store
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-014).
 *
 * The pure half — the recipe kind's four-field slice of the generic
 * `install-self-describing-core` (D-003). Placing the dir is all that happens here;
 * seeding the `code_recipes` row is `install-recipe-io`'s second step, the same
 * dir-then-seed split the rubric and plan kinds use for the same reason: the dir is
 * machine-scoped and re-seedable, the row is workspace state.
 */
import {
  readRecipeDirForInstall,
  userRecipesDir,
  RECIPE_MANIFEST,
  type LocalRecipe,
} from './recipe-store';
import {
  installSelfDescribingFromCupboard,
  type InstallSelfDescribingDeps,
  type InstallSelfDescribingInput,
  type SelfDescribingKindSpec,
  type VerifiedContentPin,
} from './install-self-describing-core';

export {
  InstallSelfDescribingError as InstallRecipeError,
} from './install-self-describing-core';

export interface InstallRecipeCoreResult {
  ok: true;
  /** The installed dir's ref (its user-layer subdir name). */
  ref: string;
  /** The recipe id the seed keys on (recipe.json `id`, else the ref). */
  recipeId: string;
  title: string;
  description: string;
  script: string;
  toolsUsed: string[];
  tags: string[];
  /** True when the publisher's authority analyzer could not prove the script's
   *  effects statically. Surfaced to the installer, never a blocker. */
  authorityUnresolved: boolean;
  version: string;
  source: string;
  installedTo: string;
  /** The content pin this install VERIFIED (P-002), or null for an unverified tip clone. */
  pin: VerifiedContentPin | null;
}

const RECIPE_KIND_SPEC: SelfDescribingKindSpec<LocalRecipe> = {
  label: 'recipe',
  manifestFile: RECIPE_MANIFEST,
  readDir: (dir, ref) => readRecipeDirForInstall(dir, ref),
  userDir: userRecipesDir,
};

export async function installRecipeFromCupboardCore(
  input: InstallSelfDescribingInput,
  deps: InstallSelfDescribingDeps,
): Promise<InstallRecipeCoreResult> {
  const r = await installSelfDescribingFromCupboard(input, RECIPE_KIND_SPEC, deps);
  return {
    ok: true,
    ref: r.ref,
    recipeId: r.meta.id,
    title: r.meta.title,
    description: r.meta.description,
    script: r.meta.script,
    toolsUsed: r.meta.toolsUsed,
    tags: r.meta.tags,
    authorityUnresolved: r.meta.authorityUnresolved,
    version: r.meta.version,
    source: r.source,
    installedTo: r.installedTo,
    pin: r.pin,
  };
}
