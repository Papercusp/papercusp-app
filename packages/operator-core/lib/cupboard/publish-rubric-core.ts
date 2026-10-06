/**
 * publish-rubric-core — the ONE server-side path that publishes a rubric TO the
 * Cupboard as a `kind='rubric'` listing
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-003).
 *
 * Mirrors publish-template-core.ts (D-001 reuse-first, no fork): a rubric listing is
 * MIRROR-REPO-BACKED. Like a template — and unlike a plugin installed from a clone
 * with its own git origin — a rubric's content lives on-disk in the layered rubric
 * store with NO origin remote of its own, so `github_url` (the public mirror repo
 * the rubric dir was pushed to) is REQUIRED and `listing_ref` is the per-rubric
 * subdir. Title/description/characteristic default from the LOCAL rubric when the
 * ref resolves in the store.
 *
 * WHAT IS PUBLISHED, and what is deliberately NOT.
 * The listing is a POINTER plus storefront metadata — it never carries the rubric's
 * criteria inline. The criteria travel in the mirror repo's `rubric.json`, which is
 * the same file the local store already reads and the installer already validates.
 * Publishing a second copy of the criteria into the listing row would be a derived
 * duplicate of content the repo owns (the derived-truth-ladder rule), and the two
 * would drift the first time a rubric was amended.
 *
 * REVIEW POLICY: 'rubric' is a REVIEW_POLICY_KIND (D-002) — a rubric supplies the
 * criteria and METHOD.md runbook by which work is GRADED, so a hostile one silently
 * corrupts every acceptance verdict it touches. The publish therefore lands PENDING
 * and is publicly invisible until an operator approves it. That is enforced
 * server-side by the worker, not here; this core just surfaces it in the result.
 */
import { publishListingToCupboard } from './publish-listing';
import { buildSelfDescribingPublishExtras, type SelfDescribingPublishExtras } from './self-describing-release';
import { resolveLocalRubric } from './rubric-store';
import { parseGithubRemote, fetchGithubRepoMeta } from './resolve-repo-coords';
import { getRubric } from '../rubrics';

// A rubric ref is a within-repo subdir + the human handle — a safe single segment.
// Mirrors install-self-describing-core's SAFE_REF_RE. UNTRUSTED (from the caller).
const SAFE_REF_RE = /^[A-Za-z0-9._-]+$/;

export interface PublishRubricInput {
  /** The rubric's local ref/id (defaults the metadata; also the default listing_ref). */
  ref: string;
  /** The public mirror repo the rubric dir lives in (REQUIRED). */
  github_url: string;
  /** Override the within-repo subdir (else `ref`). */
  listing_ref?: string;
  /** Papercupai project remote (D-008). */
  project_ref?: string;
  /** Override title (else the local rubric's title, else the ref). */
  title?: string;
  /** Override description (else the local rubric's description). */
  description?: string;
}

export type PublishRubricResult =
  | { ok: true; listing: unknown }
  | { ok: false; status: number; error: string; detail?: unknown; upstream_status?: number };

/**
 * Publish a rubric to the Cupboard. Returns a structured result — never throws for
 * an expected failure; the caller maps status+error to its response.
 */
export async function publishRubricToCupboard(input: PublishRubricInput): Promise<PublishRubricResult> {
  const ref = String(input.ref ?? '').trim();
  if (!SAFE_REF_RE.test(ref)) {
    return { ok: false, status: 400, error: `invalid rubric ref "${ref}"` };
  }

  const githubUrl = typeof input.github_url === 'string' ? input.github_url.trim() : '';
  if (!githubUrl) {
    return {
      ok: false,
      status: 400,
      error: 'github_url required (the public mirror repo the rubric dir lives in)',
    };
  }
  const parsed = parseGithubRemote(githubUrl);
  if (!parsed) {
    return { ok: false, status: 400, error: `invalid github_url "${githubUrl}"` };
  }

  // Publishing is a distribution step for a rubric that is already a live,
  // reviewed instrument in this workspace. The local filesystem layer only
  // supplies storefront metadata; the rubric store is authoritative for
  // lifecycle and ratification, so fail closed before touching GitHub or the
  // Cupboard when that source cannot be proven publishable.
  const source = await getRubric(ref);
  if (!source) {
    return { ok: false, status: 404, error: `rubric "${ref}" not found` };
  }
  if (source.status !== 'active') {
    return { ok: false, status: 409, error: `rubric "${ref}" is not active` };
  }
  if (typeof source.ratifiedBy !== 'string' || !source.ratifiedBy.trim()) {
    return { ok: false, status: 409, error: `rubric "${ref}" is not ratified` };
  }

  const meta = await fetchGithubRepoMeta(parsed.owner, parsed.repo);
  if (!meta) {
    return { ok: false, status: 422, error: `could not resolve GitHub repo ${parsed.owner}/${parsed.repo}` };
  }

  // Default the storefront metadata from the LOCAL rubric when the ref resolves in
  // the layered store. A publish of a ref not present locally still works (the
  // metadata then comes entirely from the input) — the mirror repo, not this box,
  // is the content authority.
  const local = resolveLocalRubric(ref);

  // The characteristic is what a rubric MEASURES, and it is the single most useful
  // thing on a rubric card — so fold it into the description when the publisher did
  // not write one, rather than shipping an empty-description listing.
  const fallbackDescription =
    local?.description ||
    (local?.characteristic ? `Grades: ${local.characteristic}` : '') ||
    '';

  const listingRef =
    typeof input.listing_ref === 'string' && input.listing_ref.trim() ? input.listing_ref.trim() : ref;

  // Same split as templates: a locally-resolved rubric dir has bytes to pin + ship to the R2 origin; a
  // ref only present in the rubric store (no on-disk dir) publishes GitHub-only as before.
  let releaseExtras: Partial<SelfDescribingPublishExtras> = {};
  if (local?.dir) {
    const releaseBuild = await buildSelfDescribingPublishExtras({
      listingKind: 'rubric',
      listingRef,
      dir: local.dir,
    });
    if (!releaseBuild.ok) {
      return { ok: false, status: releaseBuild.status, error: releaseBuild.error, detail: releaseBuild.detail };
    }
    releaseExtras = releaseBuild.extras;
  }

  const result = await publishListingToCupboard({
    ...releaseExtras,
    listing_kind: 'rubric',
    listing_ref: listingRef,
    project_ref: typeof input.project_ref === 'string' ? input.project_ref : undefined,
    github_repository_id: meta.id,
    github_owner: parsed.owner,
    github_name: parsed.repo,
    github_url: meta.html_url || `https://github.com/${parsed.owner}/${parsed.repo}`,
    title: typeof input.title === 'string' ? input.title : (local?.title ?? ref),
    description: typeof input.description === 'string' ? input.description : fallbackDescription,
  });

  // Map explicitly rather than casting: the shared publisher returns its payload as
  // `data`, while every publish-*-core surfaces it as `listing`. A cast would
  // typecheck and hand the caller `listing: undefined` at runtime.
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
