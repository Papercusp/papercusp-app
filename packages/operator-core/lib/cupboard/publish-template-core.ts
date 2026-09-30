/**
 * publish-template-core — the ONE server-side path that publishes an app-template
 * TO the Cupboard as a `kind=template` listing.
 *
 * Extracted (cupboard-agent-tool-coverage-2026-07-14 P-002, D-001 reuse-first)
 * from the inline body of `endpoint-route/routes/cupboard-publish-template.ts`
 * so BOTH the loopback HTTP route AND the agent-callable
 * `cupboard:publish-template` tool run the exact same logic — no fork.
 *
 * A template listing is mirror-repo-backed: it points at the public templates
 * repo (`github_url`, e.g. Papercusp/templates) with `listing_ref` = the
 * per-template subdir. Unlike a plugin (installed from a clone with a git
 * origin), a template's content lives on-disk in the bundled store with NO
 * origin remote — so `github_url` is REQUIRED; title/description default from
 * the local template when the ref resolves.
 */
import { publishListingToCupboard } from './publish-listing';
import { resolveLocalTemplate } from './template-store';
import { parseGithubRemote, fetchGithubRepoMeta } from './resolve-repo-coords';

// A template ref is a within-repo subdir + the human handle — a safe single
// segment (mirrors templates.ts SAFE_REF_RE). UNTRUSTED (from the caller).
const SAFE_REF_RE = /^[A-Za-z0-9._-]+$/;

export interface PublishTemplateInput {
  /** The template's local ref/id (defaults title+description; also the default listing_ref). */
  ref: string;
  /** The public mirror repo the template lives in (REQUIRED). */
  github_url: string;
  /** Override the within-repo subdir (else `ref`). */
  listing_ref?: string;
  /** Papercupai project remote (D-008). */
  project_ref?: string;
  /** Override title (else the local template's title, else the ref). */
  title?: string;
  /** Override description (else the local template's description). */
  description?: string;
}

export type PublishTemplateResult =
  | { ok: true; listing: unknown }
  | { ok: false; status: number; error: string; detail?: unknown; upstream_status?: number };

/**
 * Publish an app-template to the Cupboard. Returns a structured result — never
 * throws for an expected failure; the caller maps status+error to its response.
 */
export async function publishTemplateToCupboard(input: PublishTemplateInput): Promise<PublishTemplateResult> {
  const ref = String(input.ref ?? '').trim();
  if (!SAFE_REF_RE.test(ref)) {
    return { ok: false, status: 400, error: `invalid template ref "${ref}"` };
  }

  const githubUrl = typeof input.github_url === 'string' ? input.github_url.trim() : '';
  if (!githubUrl) {
    return { ok: false, status: 400, error: 'github_url required (the public mirror repo the template lives in)' };
  }
  const parsed = parseGithubRemote(githubUrl);
  if (!parsed) {
    return { ok: false, status: 400, error: `invalid github_url "${githubUrl}"` };
  }
  const meta = await fetchGithubRepoMeta(parsed.owner, parsed.repo);
  if (!meta) {
    return { ok: false, status: 422, error: `could not resolve GitHub repo ${parsed.owner}/${parsed.repo}` };
  }

  // Default title/description from the local template when the ref resolves in the
  // bundled/user store (a publish of a ref not present locally still works —
  // title/description then come from the input).
  const local = resolveLocalTemplate(ref);

  const result = await publishListingToCupboard({
    listing_kind: 'template',
    listing_ref: typeof input.listing_ref === 'string' && input.listing_ref.trim() ? input.listing_ref.trim() : ref,
    project_ref: typeof input.project_ref === 'string' ? input.project_ref : undefined,
    github_repository_id: meta.id,
    github_owner: parsed.owner,
    github_name: parsed.repo,
    github_url: meta.html_url || `https://github.com/${parsed.owner}/${parsed.repo}`,
    title: typeof input.title === 'string' ? input.title : (local?.title ?? ref),
    description:
      typeof input.description === 'string'
        ? input.description
        : typeof local?.description === 'string' && local.description
          ? local.description
          : undefined,
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
  return { ok: true, listing: result.data };
}
