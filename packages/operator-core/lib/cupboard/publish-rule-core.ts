/**
 * publish-rule-core — publish a local rule package TO the Cupboard as a
 * `kind='rule'` listing (portable-identity-packages P-011, D-023 §6 — the D-055 gap).
 *
 * Mirrors publish-rubric-core: the listing is a POINTER into the public mirror repo
 * the rule dir was pushed to, plus storefront metadata; the rule itself travels in
 * the repo's `rule.json`, the file the installer validates. `rule` is in the
 * Worker's REVIEW_POLICY_KINDS, so the publish lands PENDING — a rule actuates in
 * every installing pot, so no publisher makes one public without an operator.
 *
 * Fail closed before touching GitHub or the Cupboard: the ref must resolve to a
 * rule this box can parse, so a malformed manifest is never advertised.
 */
import { publishListingToCupboard } from './publish-listing';
import { resolveLocalRule } from './rule-store';
import { fetchGithubRepoMeta, parseGithubRemote } from './resolve-repo-coords';

// A ref is a within-repo subdir and a directory name — one safe segment.
const SAFE_REF_RE = /^[A-Za-z0-9._-]+$/;

export interface PublishRuleInput {
  /** The rule's local ref or id; also the default listing_ref. */
  ref: string;
  github_url: string;
  listing_ref?: string;
  project_ref?: string;
  title?: string;
  description?: string;
}

export type PublishRuleResult =
  | { ok: true; listing: unknown }
  | { ok: false; status: number; error: string; detail?: unknown; upstream_status?: number };

export async function publishRuleToCupboard(input: PublishRuleInput): Promise<PublishRuleResult> {
  const ref = String(input.ref ?? '').trim();
  if (!SAFE_REF_RE.test(ref)) return { ok: false, status: 400, error: `invalid rule ref "${ref}"` };
  const githubUrl = typeof input.github_url === 'string' ? input.github_url.trim() : '';
  if (!githubUrl) {
    return { ok: false, status: 400, error: 'github_url required (the public mirror repo the rule dir lives in)' };
  }
  const parsed = parseGithubRemote(githubUrl);
  if (!parsed) return { ok: false, status: 400, error: `invalid github_url "${githubUrl}"` };

  const local = resolveLocalRule(ref);
  if (!local) {
    return { ok: false, status: 404, error: `rule "${ref}" is not installed here or its rule.json does not parse` };
  }

  const meta = await fetchGithubRepoMeta(parsed.owner, parsed.repo);
  if (!meta) return { ok: false, status: 422, error: `could not resolve GitHub repo ${parsed.owner}/${parsed.repo}` };

  const listingRef = typeof input.listing_ref === 'string' && input.listing_ref.trim() ? input.listing_ref.trim() : ref;
  if (!SAFE_REF_RE.test(listingRef)) return { ok: false, status: 400, error: `invalid listing_ref "${listingRef}"` };
  const result = await publishListingToCupboard({
    listing_kind: 'rule',
    listing_ref: listingRef,
    project_ref: typeof input.project_ref === 'string' ? input.project_ref : undefined,
    github_repository_id: meta.id,
    github_owner: parsed.owner,
    github_name: parsed.repo,
    github_url: meta.html_url || `https://github.com/${parsed.owner}/${parsed.repo}`,
    title: typeof input.title === 'string' ? input.title : local.title,
    description: typeof input.description === 'string' ? input.description : local.description,
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
