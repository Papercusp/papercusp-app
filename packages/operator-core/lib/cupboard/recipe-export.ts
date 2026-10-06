/**
 * recipe-export — turn a workspace recipe into a shareable, self-describing manifest
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-013).
 *
 * A recipe is the most skill-like unit in the system — a captured multi-step tool
 * orchestration — and also the one most likely to be silently workspace-bound. Three
 * distinct things make a stored recipe local, and only two of them are strippable:
 *
 *   1. USAGE + ATTRIBUTION columns (runCount, successCount, lastRunAt, potSlug,
 *      createdBy, status, promotedTool, mergedInto). Meaningless elsewhere and pure
 *      identity leak. STRIPPED — they simply do not appear in the manifest.
 *   2. The AUTHORITY PROOF that accompanies a run (`runArgs.authority.context`,
 *      pinning `workspace` / `harness`). Never stored on the row in the first place —
 *      it is minted per run — so exporting the row cannot carry it, and the installing
 *      workspace derives its own. Nothing to strip; stated here because P-013 names it
 *      and a reader is entitled to know why no code removes it.
 *   3. Concrete SCOPED REFS baked into the SCRIPT — a literal workspace id, plan slug,
 *      fleet name, work-item id or resource. These are NOT strippable, and this is the
 *      one judgement in the file: rewriting somebody's script to remove a plan slug
 *      would produce a recipe that runs and does something subtly different from what
 *      its title claims. So a script naming concrete scoped refs is REFUSED, with the
 *      refs named, rather than silently laundered.
 *
 * `unresolved` (an opaque `dev:pg_query` / shell / nested `code:run` the authority
 * analyzer cannot prove) is NOT a refusal. Most captured recipes are unresolved and
 * most are perfectly portable — opacity means "effects unprovable statically", not
 * "workspace-bound". It travels as a WARNING on the manifest so an installer knows
 * what it is accepting, which is the honest handling of a property we cannot decide.
 *
 * Pure apart from the injected authority analyzer, so the refusal rule is testable
 * without a script parser in the loop.
 */
import type { CodeRecipeRow } from '../code-recipes-store';
import type { RecipeAuthorityDescriptor, RecipeAuthorityRefs } from '../recipe-authority';

/** The scoped-ref families that make a script WORKSPACE-LOCAL. `resources` is
 *  deliberately included: a resource lock names a host-local resource. */
const LOCAL_REF_FAMILIES = ['workspaces', 'fleets', 'plans', 'harnesses', 'items', 'resources'] as const;

// The manifest shapes live in a dependency-free leaf so recipe-dir readers never compile
// this file's authority imports (WI-10004876).
import type { ExportedRecipeManifest, RecipeExport } from './recipe-manifest';
export type { ExportedRecipeManifest, RecipeExport } from './recipe-manifest';

export type RecipeExportResult =
  | RecipeExport
  | { error: string; status: number; localRefs?: Partial<Record<keyof RecipeAuthorityRefs, string[]>> };

/** The usage/attribution columns a shared recipe must not carry. Named explicitly
 *  (rather than derived by omission) so adding a column to CodeRecipeRow forces a
 *  decision here instead of leaking by default. */
const STRIPPED_FIELDS = [
  'potSlug',
  'authorRole',
  'runCount',
  'successCount',
  'lastRunAt',
  'status',
  'promotedTool',
  'mergedInto',
  'createdBy',
  'createdAt',
  'updatedAt',
  'hasEmbedding',
] as const;

/** Collect the concrete scoped refs a descriptor names, by family. Empty ⇒ portable. */
export function localRefsOf(
  refs: RecipeAuthorityRefs,
): Partial<Record<keyof RecipeAuthorityRefs, string[]>> {
  const out: Partial<Record<keyof RecipeAuthorityRefs, string[]>> = {};
  for (const family of LOCAL_REF_FAMILIES) {
    const values = refs[family];
    if (Array.isArray(values) && values.length > 0) out[family] = [...values];
  }
  return out;
}

/**
 * Sanitize a stored recipe into a shareable manifest.
 *
 * `authority` is the descriptor `deriveRecipeAuthority(row.script)` produced — passed
 * in rather than derived here so the refusal rule is unit-testable and so a caller
 * that already derived it (the publish path does, to report `unresolved`) does not
 * pay for it twice.
 */
export function sanitizeRecipeForExport(
  row: Pick<CodeRecipeRow, 'id' | 'title' | 'description' | 'script' | 'toolsUsed' | 'tags'>,
  authority: RecipeAuthorityDescriptor,
): RecipeExportResult {
  const id = String(row.id ?? '').trim();
  if (!id) return { error: 'recipe id required', status: 400 };
  const script = String(row.script ?? '');
  if (script.trim() === '') return { error: `recipe "${id}" has an empty script`, status: 422 };

  const localRefs = localRefsOf(authority.refs);
  const families = Object.keys(localRefs);
  if (families.length > 0) {
    const detail = families
      .map((f) => `${f}: ${(localRefs[f as keyof RecipeAuthorityRefs] ?? []).join(', ')}`)
      .join('; ');
    return {
      status: 422,
      error:
        `recipe "${id}" names concrete workspace-scoped refs and cannot be published as-is (${detail}). ` +
        `Rewriting the script to remove them here would publish something that runs and does ` +
        `something different from what its title claims — generalize the recipe (parameterize the ` +
        `scoped values) and re-capture it instead.`,
      localRefs,
    };
  }

  const cause = authority.unresolvedCause ?? null;
  const manifest: ExportedRecipeManifest = {
    id,
    title: String(row.title ?? id),
    description: String(row.description ?? ''),
    script,
    toolsUsed: Array.isArray(row.toolsUsed) ? [...row.toolsUsed] : [],
    tags: Array.isArray(row.tags) ? [...row.tags] : [],
    authorityUnresolved: authority.unresolved === true,
    ...(cause ? { authorityUnresolvedCause: cause.kind } : {}),
  };

  return {
    manifest,
    description: manifest.description || manifest.title,
    strippedFields: [...STRIPPED_FIELDS],
  };
}
