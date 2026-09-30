/**
 * fork-remote — the LOCAL fork-remote config seam for the upstream-contribution
 * path (per-hive-learning-loops-2026-06-14 P-072 / D-007b).
 *
 * The contribution design (D-007): a platform self-hive (or any member without
 * upstream write) git-syncs its local commits to the USER'S OWN FORK — never the
 * canonical upstream — and improvements reach upstream only as human-reviewed PRs
 * or moderated Comb knowledge-pack listings. This module is the CONFIG SEAM for the
 * "sync to my fork" half: it reads/writes the `fork_remote` field on the registry
 * entry and resolves WHICH remote a git-sync should push to.
 *
 * It performs NO outward git action — no push, no fork-create, no PR. Setting a
 * fork remote is a pure registry write; resolving the push target is pure logic.
 * The LIVE fork-push / PR-open is the OWNER-/DEPLOY-GATED platform:contribute path
 * (open-fork-pr), deliberately kept outside this local seam (D-007 — a user's loop
 * NEVER direct-pushes upstream and the outward action is gated like the marketplace
 * round-trip).
 */
import type { ProjectEntry } from '../../harness-registry';
import { mutateHarnessRegistry } from '../../harness-registry';
import { parseGithubUrl } from '../clone-github';

export type ForkPushTarget =
  /** Push to the user's own fork (the contribution lane — D-007b). */
  | { target: 'fork'; remote: string; reason: string }
  /** No fork configured + the operator has upstream write — push the upstream directly. */
  | { target: 'upstream'; remote: string; reason: string }
  /** No fork, no upstream-write (or no upstream at all) — commit-only, never push. */
  | { target: 'none'; reason: string };

export interface ResolveForkPushTargetInput {
  /** The user's own fork remote, when configured (registry `fork_remote`). */
  forkRemote?: string;
  /** The upstream remote, when known (registry `github_remote`). */
  upstreamRemote?: string;
  /**
   * Does the operator hold write to the UPSTREAM? (decideGitSyncPush's permission
   * probe answer.) Only consulted when no fork is configured: a fork ALWAYS wins
   * (the contribution lane never pushes upstream even when it could — D-007).
   *
   * TRI-state, and `null` (unknown) means UNKNOWN — never "no". The probe
   * (`fetchRepoPushPermission`) asks GitHub over the **gh/octokit token**, while
   * the push itself rides **git transport**, which resolves per-URL credential
   * helpers the token knows nothing about. The two planes legitimately disagree:
   * a private repo reachable by a repo-scoped helper is invisible to the global
   * token, so the probe 404s → `null`. Reading that as "no write" silently
   * demotes a healthy bridged hive to commit-only forever (observed live on the
   * oddsmith hive 2026-07-19: canonical established, integrator elected, and
   * origin frozen behind a bridge reporting `divergence: clear`).
   */
  upstreamWrite?: boolean | null;
}

/**
 * Resolve where a git-sync should push, PURE — no IO. The contribution rule
 * (D-007b): a configured fork ALWAYS wins (a user's loop never direct-pushes
 * upstream, even with write). Absent a fork, push upstream unless GitHub
 * AFFIRMATIVELY refused (`upstreamWrite === false`) — `null`/unknown attempts
 * the push, matching `decideGitSyncPush` rule 6's best-effort optimism.
 */
export function resolveForkPushTarget(input: ResolveForkPushTargetInput): ForkPushTarget {
  if (input.forkRemote) {
    return {
      target: 'fork',
      remote: input.forkRemote,
      reason: 'fork configured — contribution lane pushes the user\'s fork, never upstream (D-007b)',
    };
  }
  if (input.upstreamRemote && input.upstreamWrite !== false) {
    return {
      target: 'upstream',
      remote: input.upstreamRemote,
      reason:
        input.upstreamWrite === true
          ? 'no fork configured + operator has upstream write — push upstream directly'
          : 'no fork configured + upstream write UNKNOWN — attempt upstream (decideGitSyncPush rule 6 ' +
            'optimism: the probe and the git transport are different credential planes, so "unknown" is ' +
            'not "no". Egress is FF-only + CAS + secrets-scanned, so a wrong guess is a rejected push — ' +
            'a signal — never damage)',
    };
  }
  return {
    target: 'none',
    reason: input.upstreamRemote
      ? 'no fork configured + upstream write REFUSED by GitHub — commit-only (configure a fork to contribute)'
      : 'no fork and no upstream remote — commit-only (local checkout)',
  };
}

export type SetForkRemoteResult =
  | { ok: true; slug: string; forkRemote: string | null; cleared: boolean }
  | { ok: false; error: 'harness_not_found' | 'invalid_url'; message: string };

/**
 * Set (or clear, with `forkUrl: null`) the user's fork remote on a registry entry —
 * a LOCAL config write, no outward action. The URL is normalized through
 * parseGithubUrl (the same normalization github_remote uses) so the stored value is
 * a canonical HTTPS clone URL. Returns harness_not_found when the slug isn't in the
 * workspace registry, invalid_url when the fork URL isn't a GitHub URL.
 */
export async function setForkRemote(
  slug: string,
  forkUrl: string | null,
  workspaceId?: string,
): Promise<SetForkRemoteResult> {
  let normalized: string | null = null;
  if (forkUrl !== null) {
    const parsed = parseGithubUrl(forkUrl);
    if (!parsed) {
      return { ok: false, error: 'invalid_url', message: `not a GitHub URL: ${forkUrl}` };
    }
    normalized = parsed.cloneUrl;
  }

  let found = false;
  await mutateHarnessRegistry((reg) => {
    return {
      ...reg,
      projects: reg.projects.map((p) => {
        if (p.slug !== slug) return p;
        found = true;
        if (normalized === null) {
          // Clear: drop the field entirely (omit rather than store undefined).
          const { fork_remote: _drop, ...rest } = p;
          return rest as ProjectEntry;
        }
        return { ...p, fork_remote: normalized };
      }),
    };
  }, workspaceId);

  if (!found) {
    return { ok: false, error: 'harness_not_found', message: `no harness '${slug}' in this workspace registry` };
  }
  return { ok: true, slug, forkRemote: normalized, cleared: normalized === null };
}

/** Read the configured fork remote for a registry entry (pure accessor over an entry). */
export function forkRemoteOf(entry: Pick<ProjectEntry, 'fork_remote'>): string | undefined {
  return entry.fork_remote;
}
