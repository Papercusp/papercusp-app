/**
 * Local recipe store — the on-disk layer behind the Cupboard's `kind='recipe'`
 * listings (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-014).
 *
 * The fourth consumer of `self-describing-store.ts` (templates, rubrics, plan
 * templates, now recipes), and structurally the plan-template store's twin: a
 * layered read half from the shared core, a small kind-specific write half here.
 *
 *   <ref>/recipe.json   — the manifest (recipe-export's ExportedRecipeManifest)
 *   <ref>/listing.json  — storefront metadata only
 *
 * Unlike the plan kind (whose markdown IS its manifest — D-005), a recipe genuinely
 * needs a JSON manifest: its content is a script plus structured metadata that has no
 * self-describing document form. `recipe.json` is not a second copy of anything.
 *
 * Same machine-vs-workspace reasoning as the plan-template store for why a disk layer
 * exists at all even though installing ends in a `code_recipes` row: the row is
 * workspace-visible state, the dir is machine-scoped and re-seedable.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { papercuspPath } from '../papercusp-root';
import {
  bundledDirFromEnv,
  inRepoFallbackDir,
  selfDescribingRoots,
  enumerateSelfDescribingDirs,
} from './self-describing-store';
import type { ExportedRecipeManifest, RecipeExport } from './recipe-export';
import { assertIdentityClean } from './identity-scrub';

/** The manifest file that MAKES a subdir a recipe. */
export const RECIPE_MANIFEST = 'recipe.json';

export interface RecipeRoot {
  dir: string;
  layer: 'bundled' | 'user';
}

/** A recipe resolved from the local store (one self-describing subdir). */
export interface LocalRecipe extends ExportedRecipeManifest {
  /** The subdir name. Equals the manifest id for a normal export. */
  ref: string;
  description: string;
  version: string;
  /** 'installed' for a user-layer dir, else whatever listing.json declares. */
  source: string;
  dir: string;
  layer: 'bundled' | 'user';
}

const inRepoRecipesDir = inRepoFallbackDir('recipes', import.meta.url);

/** The bundled (read-only) recipes dir: env override → in-repo dev fallback. */
export function bundledRecipesDir(): string {
  return bundledDirFromEnv('PAPERCUSP_RECIPES_DIR', inRepoRecipesDir);
}

/** The writable user recipes dir — the Cupboard `kind='recipe'` install target AND
 *  the publish path's export destination. */
export function userRecipesDir(): string {
  return papercuspPath('recipes');
}

export function recipeRoots(): RecipeRoot[] {
  return selfDescribingRoots({
    envVar: 'PAPERCUSP_RECIPES_DIR',
    devFallbackDir: inRepoRecipesDir,
    userSubdir: 'recipes',
  });
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

function readJsonOrNull(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Read a recipe subdir. `recipe.json` is REQUIRED and must carry a non-empty id,
 * title and script — a manifest missing any of those cannot become a `code_recipes`
 * row, so surfacing it would mean an install that "succeeds" into nothing. Null ⇒
 * not a recipe dir (skipped by enumeration, 422 by the installer, which is exactly
 * why both go through this one reader).
 */
function readRecipeDir(dir: string, ref: string, layer: 'bundled' | 'user'): LocalRecipe | null {
  const manifest = readJsonOrNull(join(dir, RECIPE_MANIFEST));
  if (!manifest) return null;

  const id = str(manifest.id) ?? ref;
  const title = str(manifest.title);
  const script = str(manifest.script);
  if (!title || !script) return null;

  const listing = readJsonOrNull(join(dir, 'listing.json')) ?? {};
  const cause = str(manifest.authorityUnresolvedCause);

  return {
    ref,
    id,
    title,
    script,
    description: str(manifest.description) ?? str(listing.description) ?? '',
    toolsUsed: strArray(manifest.toolsUsed),
    tags: strArray(manifest.tags),
    authorityUnresolved: manifest.authorityUnresolved === true,
    ...(cause ? { authorityUnresolvedCause: cause } : {}),
    version: str(listing.version) ?? '0.1.0',
    source: str(listing.source) ?? (layer === 'user' ? 'installed' : 'first-party'),
    dir,
    layer,
  };
}

/** Read a candidate dir as a USER-layer recipe, for the Cupboard install path — the
 *  SAME reader the enumeration uses, so a dir that installs is one that resolves. */
export function readRecipeDirForInstall(dir: string, ref: string): LocalRecipe | null {
  return readRecipeDir(dir, ref, 'user');
}

/** Enumerate every recipe across the layered roots (user shadows bundled). */
export function listLocalRecipes(roots: RecipeRoot[] = recipeRoots()): LocalRecipe[] {
  return enumerateSelfDescribingDirs(roots, readRecipeDir);
}

/** Resolve one local recipe by subdir ref or by its manifest id. */
export function resolveLocalRecipe(
  idOrRef: string,
  roots: RecipeRoot[] = recipeRoots(),
): LocalRecipe | null {
  const key = (idOrRef ?? '').trim();
  if (!key) return null;
  return listLocalRecipes(roots).find((r) => r.ref === key || r.id === key) ?? null;
}

/** Same safe-single-segment rule the generic installer enforces — applied here too
 *  because this path writes a directory named by caller input. */
const SAFE_REF_RE = /^[A-Za-z0-9._-]+$/;

export interface WrittenRecipe {
  ref: string;
  dir: string;
  manifestPath: string;
  listingPath: string;
}

/**
 * Materialize a sanitized recipe export as a self-describing dir in the writable
 * user layer — the WRITE half, deliberately not generalized.
 *
 * This is what gives `cupboard:publish-recipe` something to push: a recipe lives in
 * Postgres, so there is no dir until something writes one. Overwrites an existing dir
 * of the same ref, because re-exporting your own recipe is the normal case and a
 * stale half of a previous export would otherwise be published as if current.
 */
export function writeRecipeDir(
  exported: RecipeExport,
  opts: {
    ref?: string;
    version?: string;
    targetDir?: string;
    /** Identity values scrubbed upstream; a surviving copy refuses the write. */
    knownIdentityValues?: readonly string[];
  } = {},
): WrittenRecipe {
  const ref = (opts.ref ?? exported.manifest.id).trim();
  if (!SAFE_REF_RE.test(ref)) throw new Error(`unsafe recipe ref ${JSON.stringify(ref)}`);

  const root = opts.targetDir ?? userRecipesDir();
  const dir = join(root, ref);

  const manifestJson = `${JSON.stringify(exported.manifest, null, 2)}\n`;
  const listingJson =
    `${JSON.stringify(
      {
        kind: 'recipe',
        id: exported.manifest.id,
        title: exported.manifest.title,
        description: exported.description,
        version: opts.version ?? '0.1.0',
        source: 'exported',
        tools_used: exported.manifest.toolsUsed,
      },
      null,
      2,
    )}\n`;

  // THE GATE (EI-23420285862298325). The manifest embeds the recipe SCRIPT verbatim,
  // which sanitizeRecipeForExport deliberately does not rewrite — so this is the only
  // thing standing between a script carrying the publisher's home paths / session ids
  // and a PUBLIC mirror repo. Asserted before mkdir so a refusal leaves no dir behind.
  const scanOpts = opts.knownIdentityValues
    ? { knownIdentityValues: opts.knownIdentityValues }
    : {};
  assertIdentityClean(manifestJson, `recipe ${ref}/${RECIPE_MANIFEST}`, scanOpts);
  assertIdentityClean(listingJson, `recipe ${ref}/listing.json`, scanOpts);

  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, RECIPE_MANIFEST);
  writeFileSync(manifestPath, manifestJson, 'utf8');
  const listingPath = join(dir, 'listing.json');
  writeFileSync(listingPath, listingJson, 'utf8');

  return { ref, dir, manifestPath, listingPath };
}
