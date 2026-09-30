/** Publish a locally-declared datatype as a Cupboard `datatype` listing.
 *
 * This is the surface that RETIRES `datatypes:publish` (P-027 / D-010). The
 * lifecycle is unchanged in substance — publish → pending → operator approves →
 * globally visible → install — but it is now the ONE Cupboard moderation queue
 * rather than a second, parallel implementation of it. `datatype` is in
 * REVIEW_POLICY_KINDS precisely so this keeps publishing PENDING; consolidation
 * must not be a silent downgrade from moderated to auto-approved.
 *
 * The definition still resolves from `datatype_registry` (D-010): this reads the
 * registry row and exports it as a package. It never becomes the source of truth.
 */
import { publishListingToCupboard } from './publish-listing';
import { fetchGithubRepoMeta, parseGithubRemote } from './resolve-repo-coords';
import {
  writeDatatypePackageDir,
  type DatatypeExportSource,
  type WrittenDatatypePackage,
} from './datatype-store';

export interface PublishDatatypeInput {
  /** The `datatype_registry` id (kebab slug) to publish. */
  datatypeId: string;
  github_url: string;
  listing_ref?: string;
  project_ref?: string;
  version?: string;
  title?: string;
  description?: string;
  exportOnly?: boolean;
}

export interface PublishDatatypeDeps {
  /** Resolution stays with the registry (D-010) — injected, never re-implemented here. */
  listDatatypes: () => Promise<DatatypeExportSource[]>;
  writePackage: typeof writeDatatypePackageDir;
  fetchRepo: typeof fetchGithubRepoMeta;
  publish: typeof publishListingToCupboard;
}

export type PublishDatatypeResult =
  | { ok: true; exportedOnly: boolean; export: WrittenDatatypePackage; listing?: unknown }
  | { ok: false; status: number; error: string; detail?: unknown; upstream_status?: number };

export async function publishDatatypeToCupboard(
  input: PublishDatatypeInput,
  deps: PublishDatatypeDeps,
): Promise<PublishDatatypeResult> {
  const datatypeId = String(input.datatypeId ?? '').trim();
  const datatype = (await deps.listDatatypes()).find((candidate) => candidate.id === datatypeId);
  if (!datatype) return { ok: false, status: 404, error: `datatype "${datatypeId}" not found in this workspace` };

  const githubUrl = String(input.github_url ?? '').trim();
  const repo = parseGithubRemote(githubUrl);
  if (!repo) return { ok: false, status: 400, error: `invalid github_url "${githubUrl}"` };
  const listingRef = (input.listing_ref ?? datatype.id).trim();

  let written: WrittenDatatypePackage;
  try {
    written = deps.writePackage(datatype, {
      ref: listingRef,
      version: input.version,
      description: input.description,
      source: githubUrl,
    });
  } catch (error) {
    return { ok: false, status: 422, error: error instanceof Error ? error.message : String(error) };
  }
  if (input.exportOnly === true) return { ok: true, exportedOnly: true, export: written };

  const meta = await deps.fetchRepo(repo.owner, repo.repo);
  if (!meta) return { ok: false, status: 422, error: `could not resolve GitHub repo ${repo.owner}/${repo.repo}` };
  const result = await deps.publish({
    listing_kind: 'datatype',
    listing_ref: listingRef,
    ...(input.project_ref ? { project_ref: input.project_ref } : {}),
    github_repository_id: meta.id,
    github_owner: repo.owner,
    github_name: repo.repo,
    github_url: meta.html_url || githubUrl,
    title: input.title?.trim() || written.manifest.title,
    description: input.description?.trim() || written.manifest.description,
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
  return { ok: true, exportedOnly: false, export: written, listing: result.data };
}
