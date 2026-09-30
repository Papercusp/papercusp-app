/**
 * ensure-fork — ensures the authenticated GitHub user has a fork of the
 * upstream shared-harness repo, ready to receive a pushed feature branch.
 *
 * Part of the non-collaborator code→PR path (non-collaborator-join-fork-pr
 * sub-project B, D1): a contributor without write access to the upstream repo
 * pushes their feature branch to THEIR OWN fork and opens a cross-fork PR. This
 * module guarantees the fork exists and is ready before the push.
 *
 * Why a ready-poll: `POST /repos/{owner}/{repo}/forks` is asynchronous — GitHub
 * returns 202 immediately but the fork repo may not be queryable for a few
 * seconds. We poll `repos.get(forkOwner, repo)` until it answers 200 (or the
 * deadline elapses) so the caller can safely push right after.
 *
 * Idempotent: if the fork already exists it returns `{ created: false }` without
 * calling createFork. If the authenticated user IS the upstream owner (the
 * owner/collaborator case), no fork is needed — it short-circuits to the
 * upstream repo itself.
 *
 * Injectable Octokit (`opts.octokit`) for tests; defaults to `getOctokit()`.
 */

import { getOctokit } from '../identity/octokit-client';
import type { Octokit } from '@octokit/rest';

export interface EnsureForkOpts {
  /** Owner of the upstream shared repo (e.g. "papercupai"). */
  upstreamOwner: string;
  /** Name of the upstream shared repo (e.g. "papercup"). */
  upstreamRepo: string;
  /**
   * Injectable Octokit for tests (avoids gh-token resolution). Typed `unknown`
   * so callers don't import `@octokit/rest`; cast internally.
   */
  octokit?: unknown;
  /** Poll interval while waiting for the fork to become ready. Default 1000ms. */
  pollIntervalMs?: number;
  /** Max wall-clock to wait for the fork to become ready. Default 30000ms. */
  maxWaitMs?: number;
  /** Injectable sleep (tests pass an instant no-op). Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface EnsureForkResult {
  /** GitHub login that owns the fork (the authenticated user) — or the upstream
   *  owner when the authed user already owns the upstream (no fork needed). */
  forkOwner: string;
  /** "<forkOwner>/<repo>" — the full name to use as a git remote / PR head. */
  forkFullName: string;
  /** True when a fork was created this call; false when it pre-existed or no
   *  fork was needed (authed user owns the upstream). */
  created: boolean;
}

/**
 * Ensure the authenticated user has a ready fork of `upstreamOwner/upstreamRepo`.
 */
export async function ensureFork(opts: EnsureForkOpts): Promise<EnsureForkResult> {
  const octokit = (opts.octokit as Octokit | undefined) ?? (await getOctokit());
  if (!octokit) {
    throw new Error(
      'ensureFork: no Octokit instance available — inject opts.octokit or run `gh auth login`.',
    );
  }
  const oc = octokit as Octokit;
  const { upstreamOwner, upstreamRepo } = opts;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const maxWaitMs = opts.maxWaitMs ?? 30_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  // Resolve the authenticated user's login — this is the fork owner.
  const { data: me } = await oc.rest.users.getAuthenticated();
  const forkOwner = me.login;

  // Short-circuit: the authed user already owns the upstream repo (owner /
  // collaborator-with-write case). No fork is needed; use the upstream directly.
  if (forkOwner === upstreamOwner) {
    return {
      forkOwner,
      forkFullName: `${upstreamOwner}/${upstreamRepo}`,
      created: false,
    };
  }

  // Idempotency precheck: does the fork already exist?
  const existing = await tryGetRepo(oc, forkOwner, upstreamRepo);
  if (existing) {
    return { forkOwner, forkFullName: existing.full_name, created: false };
  }

  // Create the fork (async on GitHub's side — 202).
  await oc.rest.repos.createFork({ owner: upstreamOwner, repo: upstreamRepo });

  // Poll until the fork repo is queryable (ready) or the deadline elapses.
  const deadline = Date.now() + maxWaitMs;
  // First check immediately, then sleep between subsequent checks.
  for (;;) {
    const ready = await tryGetRepo(oc, forkOwner, upstreamRepo);
    if (ready) {
      return { forkOwner, forkFullName: ready.full_name, created: true };
    }
    if (Date.now() + pollIntervalMs > deadline) {
      throw new Error(
        `ensureFork: fork ${forkOwner}/${upstreamRepo} not ready within ${maxWaitMs}ms`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * `repos.get` that returns the repo data on 200 or `null` on 404; rethrows any
 * other error (auth, rate-limit, 5xx) so the caller surfaces it.
 */
async function tryGetRepo(
  oc: Octokit,
  owner: string,
  repo: string,
): Promise<{ full_name: string } | null> {
  try {
    const { data } = await oc.rest.repos.get({ owner, repo });
    return { full_name: (data as { full_name: string }).full_name };
  } catch (err: unknown) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}
