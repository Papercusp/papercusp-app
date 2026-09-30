/**
 * publish-recipe-core — the ONE server-side path that publishes a recipe to the
 * Cupboard as a `kind='recipe'` listing
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-014).
 *
 * Structurally the plan kind's twin (P-009): a recipe has no directory on disk
 * either, so this core SANITIZES (recipe-export), MATERIALIZES a self-describing dir
 * in the writable user layer, and then points a mirror-repo-backed listing at it —
 * with the same `exportOnly` stop, because the honest order is export → push →
 * publish.
 *
 * The one substantive difference is the refusal: a recipe whose script names concrete
 * workspace-scoped refs (a plan slug, a work-item id, a fleet, a literal workspace)
 * is REFUSED rather than laundered. See recipe-export.ts for why silently rewriting
 * the script would be the worse outcome.
 *
 * `uses_tools` (worker migration 033) is populated from the recipe's `toolsUsed`.
 * A recipe listing's whole promise is "this orchestrates these tools", and the
 * storefront renders that field as the unit's tool surface — so a browser can
 * filter recipes by the tools they touch without fetching the repo.
 *
 * ⚠ It is deliberately NOT `provides_tools`. That column means PROVISION — tools
 * a unit REGISTERS when installed, which the tool→provider resolver resolves —
 * and the worker gates it to plugin|pack. Sending a recipe's CONSUMPTION list
 * there is what made every publish fail with HTTP 400 `plugin_or_pack_kind_only`,
 * leaving the browsable `recipe` kind empty from its introduction until
 * WI-10001747. Owner ruling (owner, 2026-09-17) was to add the consumption-shaped
 * field rather than widen the provision gate. Do not "simplify" this back.
 *
 * REVIEW POLICY: 'recipe' is a REVIEW_POLICY_KIND (D-002) — an installed recipe is
 * executable orchestration, so it lands PENDING until an operator approves it.
 */
import { publishListingToCupboard } from './publish-listing';
import { parseGithubRemote, fetchGithubRepoMeta } from './resolve-repo-coords';
import { sanitizeRecipeForExport, type RecipeExport } from './recipe-export';
import { writeRecipeDir, type WrittenRecipe } from './recipe-store';
import { isIdentityLeakError, type IdentityLeakHit } from './identity-scrub';
import type { CodeRecipeRow } from '../code-recipes-store';
import type { RecipeAuthorityDescriptor, RecipeAuthorityRefs } from '../recipe-authority';

const SAFE_REF_RE = /^[A-Za-z0-9._-]+$/;

export interface PublishRecipeInput {
  /** The recipe id in this workspace's `code_recipes` store. */
  id: string;
  /** The public mirror repo the exported dir lives in. Required unless `exportOnly`. */
  github_url?: string;
  /** Override the within-repo subdir / user-layer dir name (else the recipe id). */
  listing_ref?: string;
  project_ref?: string;
  title?: string;
  description?: string;
  version?: string;
  /** Materialize the sanitized dir and STOP — do not create a listing. */
  exportOnly?: boolean;
}

export interface PublishRecipeExportInfo {
  written: WrittenRecipe;
  id: string;
  title: string;
  description: string;
  toolsUsed: string[];
  authorityUnresolved: boolean;
  strippedFields: string[];
}

export type PublishRecipeResult =
  | { ok: true; exportedOnly: true; export: PublishRecipeExportInfo }
  | { ok: true; exportedOnly: false; export: PublishRecipeExportInfo; listing: unknown }
  | {
      ok: false;
      status: number;
      error: string;
      detail?: unknown;
      upstream_status?: number;
      localRefs?: Partial<Record<keyof RecipeAuthorityRefs, string[]>>;
      /** Present when the write gate refused: publisher identity survived into the
       *  serialized bytes, so NOTHING was written. Names what to fix at the source. */
      identityLeaks?: IdentityLeakHit[];
    };

/** Read one recipe row + derive its authority descriptor. Injected so the core is
 *  testable without Postgres or the script analyzer. */
export type RecipeReader = (
  id: string,
) => Promise<{ row: CodeRecipeRow; authority: RecipeAuthorityDescriptor } | null>;

async function defaultRecipeReader(
  id: string,
): Promise<{ row: CodeRecipeRow; authority: RecipeAuthorityDescriptor } | null> {
  const [{ getRecipe }, { deriveRecipeAuthority }, { getOrgPg }] = await Promise.all([
    import('../code-recipes-store'),
    import('../recipe-authority'),
    import('@papercusp/db-org'),
  ]);
  const row = await getRecipe(getOrgPg().sql, id);
  if (!row) return null;
  return { row, authority: await deriveRecipeAuthority(row.script) };
}

/**
 * Publish (or just export) a recipe. Returns a structured result — never throws for
 * an expected failure.
 */
export async function publishRecipeToCupboard(
  input: PublishRecipeInput,
  readRecipe: RecipeReader = defaultRecipeReader,
): Promise<PublishRecipeResult> {
  const id = String(input.id ?? '').trim();
  if (!id) return { ok: false, status: 400, error: 'id required (the recipe to publish)' };

  const found = await readRecipe(id);
  if (!found) return { ok: false, status: 404, error: `recipe "${id}" not found` };

  const sanitized = sanitizeRecipeForExport(found.row, found.authority);
  if ('error' in sanitized) {
    return {
      ok: false,
      status: sanitized.status,
      error: sanitized.error,
      ...(sanitized.localRefs ? { localRefs: sanitized.localRefs } : {}),
    };
  }

  // Caller overrides apply to the MANIFEST, not just the listing row, so the dir a
  // publisher pushes and the listing they create cannot disagree about the title.
  const exported: RecipeExport = {
    ...sanitized,
    manifest: {
      ...sanitized.manifest,
      ...(input.title ? { title: input.title } : {}),
      ...(input.description ? { description: input.description } : {}),
    },
    ...(input.description ? { description: input.description } : {}),
  };

  const ref = (input.listing_ref ?? exported.manifest.id).trim();
  if (!SAFE_REF_RE.test(ref)) {
    return { ok: false, status: 400, error: `invalid recipe ref "${ref}"` };
  }

  let written: WrittenRecipe;
  try {
    // No `knownIdentityValues` harvest here, deliberately. A recipe is a SCRIPT, and
    // the policy this module already applies to workspace-scoped refs applies to
    // identity too: refuse, never launder — a rewritten script RUNS differently from
    // what its title claims. So there is no structural scrub to harvest from, and the
    // gate works off host-shaped patterns (home paths, su-ids, emails, the OS user)
    // plus the secret detector. Goal packages scrub CONFIG and therefore do harvest.
    written = writeRecipeDir(exported, { ref, ...(input.version ? { version: input.version } : {}) });
  } catch (e) {
    // A refused write is a PUBLISHER-FIXABLE 422 naming the leak, not an opaque 500:
    // the dir was never created, so the only useful answer is what to remove.
    if (isIdentityLeakError(e)) {
      return { ok: false, status: 422, error: e.message, identityLeaks: e.hits };
    }
    return {
      ok: false,
      status: 500,
      error: 'could not materialize the recipe dir',
      detail: e instanceof Error ? e.message.slice(0, 300) : String(e),
    };
  }

  const info: PublishRecipeExportInfo = {
    written,
    id: exported.manifest.id,
    title: exported.manifest.title,
    description: exported.description,
    toolsUsed: exported.manifest.toolsUsed,
    authorityUnresolved: exported.manifest.authorityUnresolved,
    strippedFields: exported.strippedFields,
  };

  if (input.exportOnly === true) return { ok: true, exportedOnly: true, export: info };

  const githubUrl = typeof input.github_url === 'string' ? input.github_url.trim() : '';
  if (!githubUrl) {
    return {
      ok: false,
      status: 400,
      error:
        'github_url required (the public mirror repo the exported dir lives in) — or pass exportOnly to materialize the dir first',
    };
  }
  const parsed = parseGithubRemote(githubUrl);
  if (!parsed) return { ok: false, status: 400, error: `invalid github_url "${githubUrl}"` };
  const meta = await fetchGithubRepoMeta(parsed.owner, parsed.repo);
  if (!meta) {
    return { ok: false, status: 422, error: `could not resolve GitHub repo ${parsed.owner}/${parsed.repo}` };
  }

  const result = await publishListingToCupboard({
    listing_kind: 'recipe',
    listing_ref: ref,
    ...(typeof input.project_ref === 'string' ? { project_ref: input.project_ref } : {}),
    github_repository_id: meta.id,
    github_owner: parsed.owner,
    github_name: parsed.repo,
    github_url: meta.html_url || `https://github.com/${parsed.owner}/${parsed.repo}`,
    title: exported.manifest.title,
    description: exported.description,
    ...(exported.manifest.toolsUsed.length > 0 ? { uses_tools: exported.manifest.toolsUsed } : {}),
  });

  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: result.error,
      detail: result.detail,
      upstream_status: result.upstream_status,
    };
  }
  return { ok: true, exportedOnly: false, export: info, listing: result.data };
}
