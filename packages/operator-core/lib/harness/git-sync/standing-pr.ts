/**
 * standing-pr — keeps a working-copy pot's ONE standing pull request in step with
 * the copy's tested main (pot-review-integration-mode-2026-10-05 P-020; D-006,
 * D-007, D-008).
 *
 * The decision is pure and lives in decide-standing-pr.ts. This module performs it:
 *
 *   1. skip early (not a working copy, mode unreadable, no fork, nothing promoted)
 *      without touching the network;
 *   2. find the open standing PR on the main repository (head branch
 *      {@link STANDING_PR_BRANCH}, base = the target branch);
 *   3. `open` → push the promoted commit to the fork's standing branch, then open
 *      the PR; `update` → push only (pushing the head branch updates the open PR);
 *      `noop` → nothing.
 *
 * The push is NON-force: the standing branch only ever moves along the copy's
 * main, which the green gate advances by fast-forward. A rejected push therefore
 * means something rewrote history, and it is surfaced instead of overwritten.
 *
 * Failure direction: if the open-PR listing fails we do NOT open a PR (that could
 * create a duplicate); every failure is returned as `{ ok:false, stage, error }`
 * with tokens redacted. It never throws, so a promotion caller can treat it as
 * best-effort without a try/catch.
 */
import { redactToken } from '../clone-url';
import type { ListOpenPrsArgs, OpenPrArgs, Pr, PrHostResult } from '../../pr-host/types';
import {
  decideStandingPr,
  STANDING_PR_BRANCH,
  type StandingPrDecision,
  type StandingPrTrigger,
} from './decide-standing-pr';
import { POT_FORK_REMOTE_NAME, type PotIntegrationModeRead } from './pot-integration-mode';

export interface StandingPrDeps {
  listOpenPrs(args: ListOpenPrsArgs): Promise<PrHostResult<Pr[]>>;
  openPr(args: OpenPrArgs): Promise<PrHostResult<Pr>>;
  /** Point the fork's `branch` at `sha` (non-force). Throws on rejection. */
  pushHead(args: { sha: string; branch: string }): Promise<void>;
}

export interface PublishStandingPrInput {
  integration: PotIntegrationModeRead;
  /** The pot's fork remote (registry `fork_remote`), when configured. */
  forkRemote?: string;
  /** Owner of the fork; namespaces the PR head when it differs from the upstream owner. */
  forkOwner: string;
  /** The main repository, "github.com/owner/repo" (the PR target). */
  upstreamRemote: string;
  upstreamOwner: string;
  /** The main repository's target branch (e.g. "main"). */
  baseBranch: string;
  /** The commit the pot's green gate promoted to the copy's main; null when none yet. */
  promotedSha: string | null;
  trigger: StandingPrTrigger;
  /** Display name of the pot, for the PR title/body. */
  potName?: string;
}

export type PublishStandingPrResult =
  | { ok: true; decision: StandingPrDecision; prNumber?: number; prUrl?: string }
  | {
      ok: false;
      stage: 'list' | 'push' | 'open';
      decision?: StandingPrDecision;
      error: string;
    };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Pick the standing PR out of the main repository's open PRs. Lowest number wins if several match.
 * Omit `baseBranch` to match a standing PR against ANY target branch (P-019's switch guard: work
 * waiting in an open standing PR is stranded by leaving the working copy, whatever its base).
 */
export function findStandingPr(prs: readonly Pr[], baseBranch?: string): Pr | null {
  const matches = prs
    .filter(
      (p) =>
        p.state === 'open' &&
        p.head_ref === STANDING_PR_BRANCH &&
        (baseBranch === undefined || p.base_ref === baseBranch),
    )
    .sort((a, b) => a.ref.number - b.ref.number);
  return matches[0] ?? null;
}

export function standingPrTitle(potName?: string): string {
  return potName ? `Tested work from ${potName}` : "Tested work from the agents' working copy";
}

export function standingPrBody(potName: string | undefined, headSha: string): string {
  const who = potName ? `the ${potName} pot` : 'this pot';
  return [
    `This pull request carries the combined work of ${who}'s agents.`,
    '',
    `It only ever points at a commit that passed the working copy's full test suite (currently \`${headSha.slice(0, 12)}\`).`,
    'It is updated automatically each time a newer commit passes. Merging it is up to you.',
    '',
    // P-016: sync-back recognises already-merged work by commit id, so a squash or
    // rebase merge would make that work reappear in every later pull request.
    'Please merge it with **Create a merge commit**, not "Squash and merge" or "Rebase and merge". ' +
      'The working copy recognises its already-merged work by commit id, so a squash or rebase ' +
      'would make that work show up again in the next pull request.',
  ].join('\n');
}

export async function publishStandingPr(
  input: PublishStandingPrInput,
  deps: StandingPrDeps,
): Promise<PublishStandingPrResult> {
  const base = {
    integration: input.integration,
    forkRemote: input.forkRemote,
    promotedSha: input.promotedSha,
    trigger: input.trigger,
  };

  // 1. Skip conditions need no network: decide with no PR first.
  const pre = decideStandingPr({ ...base, openPr: null });
  if (pre.action === 'skip') return { ok: true, decision: pre };

  // 2. Find the open standing PR. A failed listing must not open a duplicate.
  let listed: PrHostResult<Pr[]>;
  try {
    listed = await deps.listOpenPrs({ remote: input.upstreamRemote });
  } catch (e) {
    return { ok: false, stage: 'list', error: redactToken(`listing open pull requests failed: ${errMsg(e)}`) };
  }
  if (!listed.ok) {
    return { ok: false, stage: 'list', error: redactToken(`listing open pull requests failed: ${listed.error.message}`) };
  }
  const existing = findStandingPr(listed.data, input.baseBranch);

  const decision = decideStandingPr({
    ...base,
    openPr: existing ? { number: existing.ref.number, headSha: existing.head_sha } : null,
  });
  if (decision.action === 'skip') return { ok: true, decision };
  if (decision.action === 'noop') {
    return { ok: true, decision, prNumber: decision.prNumber, ...(existing ? { prUrl: existing.url } : {}) };
  }

  // 3. Move the fork's standing branch to the tested commit.
  try {
    await deps.pushHead({ sha: decision.headSha, branch: STANDING_PR_BRANCH });
  } catch (e) {
    return { ok: false, stage: 'push', decision, error: redactToken(`push to the working copy failed: ${errMsg(e)}`) };
  }
  if (decision.action === 'update') {
    return { ok: true, decision, prNumber: decision.prNumber, ...(existing ? { prUrl: existing.url } : {}) };
  }

  // 4. Open the PR (head namespaced by the fork owner when it is a genuine cross-fork PR).
  const crossFork = input.forkOwner !== input.upstreamOwner;
  let opened: PrHostResult<Pr>;
  try {
    opened = await deps.openPr({
      remote: input.upstreamRemote,
      title: standingPrTitle(input.potName),
      body: standingPrBody(input.potName, decision.headSha),
      head_ref: STANDING_PR_BRANCH,
      base_ref: input.baseBranch,
      ...(crossFork ? { head_owner: input.forkOwner } : {}),
    });
  } catch (e) {
    return { ok: false, stage: 'open', decision, error: redactToken(`opening the pull request failed: ${errMsg(e)}`) };
  }
  if (!opened.ok) {
    return { ok: false, stage: 'open', decision, error: redactToken(`opening the pull request failed: ${opened.error.message}`) };
  }
  return { ok: true, decision, prNumber: opened.data.ref.number, prUrl: opened.data.url };
}

// ─── real default seams ─────────────────────────────────────────────────────

/** Default deps: GitHub PR host + a non-force push through the pot's `pot-fork` remote. */
export async function createDefaultStandingPrDeps(opts: { repoPath: string }): Promise<StandingPrDeps | null> {
  const { createGitHubPrHost } = await import('../../pr-host/github');
  const host = await createGitHubPrHost();
  if (!host) return null;
  return {
    listOpenPrs: (args) => host.listOpenPrs(args),
    openPr: (args) => host.openPr(args),
    pushHead: async ({ sha, branch }) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      try {
        await promisify(execFile)('git', ['-C', opts.repoPath, 'push', POT_FORK_REMOTE_NAME, `${sha}:refs/heads/${branch}`]);
      } catch (e) {
        throw new Error(redactToken(errMsg(e)));
      }
    },
  };
}
