/**
 * operator-rate-key — the per-operator anti-spam rate-bucket key
 * (PLAN-pr-system-completion-dogfood Phase PR-4 / Brief PR-4 (c)6; EN-2 P-RATE).
 *
 * Owner decision (c): one HUMAN = one identity = one rate bucket. A contributor's
 * agents all act AS the authenticated `gh` user, so the correct anti-spam
 * granularity is the operator's numeric GitHub id — NOT per-agent (a spammer would
 * multiply buckets by spawning agents) and NOT a generic host token (no
 * accountability). This module is the single seam the owner-enforcement P-RATE
 * limiter (EN-2) keys on, so contribution / review / PR-open rate limits all
 * collapse onto the same human bucket.
 *
 * The key is derived from the SAME identity resolution every other PR-4 surface
 * uses (resolveLocalGithubIdentity → the producer's author_github_user_id + the
 * audit reviewer id), so the rate bucket and the attribution row are guaranteed to
 * name the same human. Returns null when gh isn't authenticated (the caller decides
 * its fail-open / fail-closed posture; the limiter has no key to bucket on).
 */

import {
  resolveLocalGithubIdentity,
  type ResolveLocalGithubIdentityOpts,
} from './resolve-local-github-identity';

/** Stable prefix so a github-id bucket can't collide with another key namespace. */
export const OPERATOR_RATE_KEY_PREFIX = 'gh-user';

/** Format a github_user_id into the namespaced rate-bucket key. Pure. */
export function operatorRateKeyForGithubUserId(githubUserId: number): string {
  return `${OPERATOR_RATE_KEY_PREFIX}:${githubUserId}`;
}

/**
 * Resolve THIS operator's rate-bucket key from the local `gh` identity, or null
 * when gh isn't authenticated. `opts` forwards the resolver's injectable seams so
 * the lookup is unit-testable with no gh / network.
 */
export async function resolveOperatorRateKey(
  opts: ResolveLocalGithubIdentityOpts = {},
): Promise<string | null> {
  const id = await resolveLocalGithubIdentity(opts);
  if (id.kind !== 'ok') return null;
  return operatorRateKeyForGithubUserId(id.githubUserId);
}
