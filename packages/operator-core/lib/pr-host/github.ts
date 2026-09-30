/**
 * pr-host/github — GitHub implementation of PrHost (Phase 7 P-040).
 *
 * Uses getOctokit() from lib/identity/octokit-client for auth; the
 * Octokit instance handles token caching + 401-retry automatically.
 *
 * Remote format: "github.com/<owner>/<repo>" (same as completion_ref.remote).
 * parseRemote() extracts owner + repo from that string.
 */

import type { Octokit } from '@octokit/rest';
import { getOctokit } from '../identity/octokit-client';
import {
  type Pr,
  type PrHost,
  type PrHostResult,
  type OpenPrArgs,
  type PostReviewArgs,
  type MergePrArgs,
  type ListOpenPrsArgs,
  type PrState,
  type PrReviewDecision,
  type PrMergeableState,
  ok,
  err,
  statusToErrorKind,
} from './types';

/** Parse "github.com/owner/repo" → { owner, repo } or null. */
export function parseRemote(remote: string): { owner: string; repo: string } | null {
  const m = /^(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

function mapOctokitError(e: unknown): ReturnType<typeof err> {
  if (e && typeof e === 'object') {
    const status: number = (e as { status?: number }).status ?? 0;
    const message: string = (e as { message?: string }).message ?? 'GitHub API error';
    const rateLimitReset =
      (e as { response?: { headers?: { 'x-ratelimit-reset'?: string } } }).response?.headers?.[
        'x-ratelimit-reset'
      ];
    const kind = statusToErrorKind(status || 500);
    const retry_after_ms =
      kind === 'rate_limited' && rateLimitReset
        ? Math.max(0, Number(rateLimitReset) * 1000 - Date.now())
        : undefined;
    return err({ kind, message, status: status || undefined, retry_after_ms });
  }
  return err({ kind: 'network_error', message: String(e) });
}

function ghStateToPrState(state: string, merged: boolean): PrState {
  if (merged) return 'merged';
  if (state === 'open') return 'open';
  return 'closed';
}

function ghReviewStateToPrDecision(state: string): PrReviewDecision {
  switch (state.toUpperCase()) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'COMMENTED':
    case 'DISMISSED': // dismissed is no longer actionable; treat as commented
      return 'commented';
    default:
      return 'none';
  }
}

function ghMergeableStateToPrMergeableState(
  mergeable: boolean | null | undefined,
): PrMergeableState {
  if (mergeable === true) return 'mergeable';
  if (mergeable === false) return 'not_mergeable';
  return 'unknown';
}

export class GitHubPrHost implements PrHost {
  readonly kind = 'github' as const;

  constructor(private readonly oc: Octokit) {}

  async openPr(args: OpenPrArgs): Promise<PrHostResult<Pr>> {
    const parsed = parseRemote(args.remote);
    if (!parsed) {
      return err({ kind: 'validation', message: `Cannot parse remote: ${args.remote}` });
    }
    try {
      // Cross-fork PR: namespace the head with the fork owner
      // (`<head_owner>:<head_ref>`) while keeping owner/repo = upstream, so a
      // contributor's fork branch opens a PR on the upstream repo. Same-repo
      // PRs (no head_owner) send the bare head ref.
      const head = args.head_owner ? `${args.head_owner}:${args.head_ref}` : args.head_ref;
      const { data } = await this.oc.pulls.create({
        owner: parsed.owner,
        repo: parsed.repo,
        title: args.title,
        body: args.body,
        head,
        base: args.base_ref,
        draft: args.draft ?? false,
      });
      const pr: Pr = {
        ref: { remote: args.remote, number: data.number },
        state: 'open',
        title: data.title,
        body: data.body ?? null,
        head_ref: data.head.ref,
        base_ref: data.base.ref,
        head_sha: data.head.sha,
        merge_commit_sha: null,
        author: { github_user_id: data.user?.id ?? 0, github_login: data.user?.login ?? '' },
        reviewers_requested: [],
        review_decision: 'none',
        checks_state: 'unknown',
        mergeable_state: 'unknown',
        is_draft: data.draft ?? false,
        url: data.html_url,
        updated_at: new Date(data.updated_at).getTime(),
      };
      return ok(pr);
    } catch (e) {
      return mapOctokitError(e);
    }
  }

  async getPr(ref: { remote: string; number: number }): Promise<PrHostResult<Pr>> {
    const parsed = parseRemote(ref.remote);
    if (!parsed) {
      return err({ kind: 'validation', message: `Cannot parse remote: ${ref.remote}` });
    }
    try {
      const { data } = await this.oc.pulls.get({
        owner: parsed.owner,
        repo: parsed.repo,
        pull_number: ref.number,
      });
      const state = ghStateToPrState(data.state, data.merged ?? false);
      const reviews = await this.oc.pulls.listReviews({
        owner: parsed.owner,
        repo: parsed.repo,
        pull_number: ref.number,
        per_page: 50,
      });
      const latestDecision = reviews.data.length
        ? ghReviewStateToPrDecision(reviews.data[reviews.data.length - 1].state)
        : 'none';
      const pr: Pr = {
        ref: { remote: ref.remote, number: data.number },
        state,
        title: data.title,
        body: data.body ?? null,
        head_ref: data.head.ref,
        base_ref: data.base.ref,
        head_sha: data.head.sha,
        merge_commit_sha: (data as { merge_commit_sha?: string | null }).merge_commit_sha ?? null,
        author: { github_user_id: data.user?.id ?? 0, github_login: data.user?.login ?? '' },
        reviewers_requested: (data.requested_reviewers ?? []).map((r) => ({
          github_user_id: r.id,
          github_login: r.login,
          avatar_url: r.avatar_url ?? undefined,
        })),
        review_decision: latestDecision,
        checks_state: 'unknown',
        mergeable_state: ghMergeableStateToPrMergeableState(
          (data as { mergeable?: boolean | null }).mergeable,
        ),
        is_draft: data.draft ?? false,
        url: data.html_url,
        updated_at: new Date(data.updated_at).getTime(),
      };
      return ok(pr);
    } catch (e) {
      return mapOctokitError(e);
    }
  }

  async getPrDiff(ref: { remote: string; number: number }): Promise<PrHostResult<string>> {
    const parsed = parseRemote(ref.remote);
    if (!parsed) {
      return err({ kind: 'validation', message: `Cannot parse remote: ${ref.remote}` });
    }
    try {
      // `mediaType.format: 'diff'` makes GitHub return the raw unified
      // diff as the response body. Octokit still types `data` as the PR
      // object, so cast — at runtime it is the diff string.
      const res = await this.oc.pulls.get({
        owner: parsed.owner,
        repo: parsed.repo,
        pull_number: ref.number,
        mediaType: { format: 'diff' },
      });
      return ok(res.data as unknown as string);
    } catch (e) {
      return mapOctokitError(e);
    }
  }

  async getRepoFile(args: {
    remote: string;
    path: string;
    ref?: string;
  }): Promise<PrHostResult<string>> {
    const parsed = parseRemote(args.remote);
    if (!parsed) {
      return err({ kind: 'validation', message: `Cannot parse remote: ${args.remote}` });
    }
    try {
      // `mediaType.format: 'raw'` returns the file body as a string. Octokit
      // types `data` as the content object, so cast — at runtime it is the
      // raw text. A directory path 404s/errors → mapped like any miss.
      const res = await this.oc.repos.getContent({
        owner: parsed.owner,
        repo: parsed.repo,
        path: args.path,
        ref: args.ref,
        mediaType: { format: 'raw' },
      });
      return ok(res.data as unknown as string);
    } catch (e) {
      return mapOctokitError(e);
    }
  }

  async postReview(args: PostReviewArgs): Promise<PrHostResult<void>> {
    const parsed = parseRemote(args.ref.remote);
    if (!parsed) {
      return err({ kind: 'validation', message: `Cannot parse remote: ${args.ref.remote}` });
    }
    const eventMap: Record<string, string> = {
      approve: 'APPROVE',
      request_changes: 'REQUEST_CHANGES',
      comment: 'COMMENT',
    };
    try {
      await this.oc.pulls.createReview({
        owner: parsed.owner,
        repo: parsed.repo,
        pull_number: args.ref.number,
        event: eventMap[args.event] as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
        body: args.body,
      });
      return ok(undefined);
    } catch (e) {
      return mapOctokitError(e);
    }
  }

  async merge(args: MergePrArgs): Promise<PrHostResult<{ merge_commit_sha: string }>> {
    const parsed = parseRemote(args.ref.remote);
    if (!parsed) {
      return err({ kind: 'validation', message: `Cannot parse remote: ${args.ref.remote}` });
    }
    const mergeMethodMap: Record<string, 'merge' | 'squash' | 'rebase'> = {
      merge: 'merge',
      squash: 'squash',
      rebase: 'rebase',
    };
    try {
      const { data } = await this.oc.pulls.merge({
        owner: parsed.owner,
        repo: parsed.repo,
        pull_number: args.ref.number,
        merge_method: mergeMethodMap[args.method] ?? 'squash',
        commit_title: args.commit_title,
        commit_message: args.commit_message,
        sha: args.expected_head_sha,
      });
      return ok({ merge_commit_sha: data.sha ?? '' });
    } catch (e) {
      return mapOctokitError(e);
    }
  }

  async listOpenPrs(args: ListOpenPrsArgs): Promise<PrHostResult<Pr[]>> {
    const parsed = parseRemote(args.remote);
    if (!parsed) {
      return err({ kind: 'validation', message: `Cannot parse remote: ${args.remote}` });
    }
    try {
      const { data } = await this.oc.pulls.list({
        owner: parsed.owner,
        repo: parsed.repo,
        state: 'open',
        per_page: args.per_page ?? 100,
      });
      const prs: Pr[] = data.map((d) => ({
        ref: { remote: args.remote, number: d.number },
        state: 'open' as PrState,
        title: d.title,
        body: d.body ?? null,
        head_ref: d.head.ref,
        base_ref: d.base.ref,
        head_sha: d.head.sha,
        merge_commit_sha: null,
        author: { github_user_id: d.user?.id ?? 0, github_login: d.user?.login ?? '' },
        reviewers_requested: (d.requested_reviewers ?? []).map((r) => ({
          github_user_id: r.id,
          github_login: r.login,
          avatar_url: r.avatar_url ?? undefined,
        })),
        review_decision: 'none',
        checks_state: 'unknown',
        mergeable_state: 'unknown',
        is_draft: d.draft ?? false,
        url: d.html_url,
        updated_at: new Date(d.updated_at).getTime(),
      }));
      return ok(prs);
    } catch (e) {
      return mapOctokitError(e);
    }
  }
}

/** Factory: resolves getOctokit() and wraps in GitHubPrHost. Returns null if not authed. */
export async function createGitHubPrHost(): Promise<GitHubPrHost | null> {
  const oc = await getOctokit();
  if (!oc) return null;
  return new GitHubPrHost(oc);
}
