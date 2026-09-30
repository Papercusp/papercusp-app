/**
 * open-fork-pr — operator-side composition for the non-collaborator code→PR
 * path (non-collaborator-join-fork-pr sub-project B). A contributor without
 * upstream write produces a feature branch locally, then:
 *
 *   1. ensures a fork of the upstream under their account (ensureFork, B1),
 *   2. pushes the feature branch to THEIR fork over an authed remote (B4),
 *   3. opens a CROSS-FORK PR into the upstream (openPr head_owner, B2).
 *
 * This is the reusable building block the orchestrator's feature-passed hook
 * calls in fork mode. It is deliberately operator-side (Octokit + gh token live
 * here, not in the orchestrator submodule); the orchestrator invokes it through
 * an injected callback. Every external effect is an injected seam so the whole
 * composition is unit-testable with no real git / GitHub.
 *
 * Same-owner short-circuit: when the resolved fork owner equals the upstream
 * owner (the owner / collaborator-with-write case, where ensureFork returns the
 * upstream itself), the PR is a normal same-repo PR — no `head_owner`
 * namespacing.
 */

import { ensureFork, type EnsureForkOpts, type EnsureForkResult } from './ensure-fork';
import { buildCloneUrl, redactToken } from './clone-url';
import type { OpenPrArgs, Pr, PrHostResult } from '../pr-host/types';

export interface OpenForkPrOpts {
  /** Upstream remote string, "github.com/owner/repo" (the PR target). */
  upstreamRemote: string;
  upstreamOwner: string;
  upstreamRepo: string;
  /** Upstream default branch the PR targets (e.g. "main"). */
  baseBranch: string;
  /** The local feature branch holding the worker's commits (e.g. "harness/F-001"). */
  featureBranch: string;
  /** Local clone path the feature branch lives in (push source). */
  localRepoPath: string;
  title: string;
  body: string;
  /** gh token with write to the contributor's OWN fork (always available). */
  token: string;

  // ── injected seams (real defaults below) ──
  ensureForkFn?: (opts: EnsureForkOpts) => Promise<EnsureForkResult>;
  pushFn?: (args: {
    repoPath: string;
    forkFullName: string;
    branch: string;
    token: string;
  }) => Promise<void>;
  openPrFn?: (args: OpenPrArgs) => Promise<PrHostResult<Pr>>;
  /** Revalidate an enclosing authority contract at each outward mutation. */
  beforeEffect?: (effect: 'ensure-fork' | 'push' | 'open-pr') => Promise<void>;
}

export type OpenForkPrResult =
  | {
      ok: true;
      forkOwner: string;
      forkFullName: string;
      /** True when the fork was created this run (vs pre-existing / not needed). */
      created: boolean;
      prNumber: number;
      prUrl: string;
    }
  | { ok: false; error: string };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function openForkPr(opts: OpenForkPrOpts): Promise<OpenForkPrResult> {
  const ensureForkFn = opts.ensureForkFn ?? ((o) => ensureFork(o));
  const pushFn = opts.pushFn ?? defaultPush;
  const openPrFn = opts.openPrFn ?? defaultOpenPr;

  // 1. Ensure the contributor's fork exists (or short-circuit to upstream).
  let fork: EnsureForkResult;
  try {
    await opts.beforeEffect?.('ensure-fork');
    fork = await ensureForkFn({ upstreamOwner: opts.upstreamOwner, upstreamRepo: opts.upstreamRepo });
  } catch (e) {
    return { ok: false, error: redactToken(`ensureFork failed: ${errMsg(e)}`) };
  }

  // 2. Push the feature branch to the fork over an authed remote. Errors are
  //    redacted so a token embedded in the push URL never leaks.
  try {
    await opts.beforeEffect?.('push');
    await pushFn({
      repoPath: opts.localRepoPath,
      forkFullName: fork.forkFullName,
      branch: opts.featureBranch,
      token: opts.token,
    });
  } catch (e) {
    return { ok: false, error: redactToken(`push to fork failed: ${errMsg(e)}`) };
  }

  // 3. Open the PR on the upstream. Namespace the head with the fork owner only
  //    when it differs from the upstream owner (a genuine cross-fork PR).
  const crossFork = fork.forkOwner !== opts.upstreamOwner;
  try {
    await opts.beforeEffect?.('open-pr');
  } catch (e) {
    return { ok: false, error: redactToken(`open PR authorization failed: ${errMsg(e)}`) };
  }
  const prRes = await openPrFn({
    remote: opts.upstreamRemote,
    title: opts.title,
    body: opts.body,
    head_ref: opts.featureBranch,
    base_ref: opts.baseBranch,
    ...(crossFork ? { head_owner: fork.forkOwner } : {}),
  });
  if (!prRes.ok) {
    return { ok: false, error: prRes.error.message };
  }

  return {
    ok: true,
    forkOwner: fork.forkOwner,
    forkFullName: fork.forkFullName,
    created: fork.created,
    prNumber: prRes.data.ref.number,
    prUrl: prRes.data.url,
  };
}

// ─── real default seams ─────────────────────────────────────────────────────

async function defaultPush(args: {
  repoPath: string;
  forkFullName: string;
  branch: string;
  token: string;
}): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  // Authed remote (token-embedded) for write to the contributor's own fork.
  const remoteUrl = buildCloneUrl(args.forkFullName, args.token);
  try {
    await run('git', ['-C', args.repoPath, 'push', remoteUrl, `${args.branch}:${args.branch}`]);
  } catch (e) {
    // Redact the token before it can reach any caller / log.
    throw new Error(redactToken(e instanceof Error ? e.message : String(e)));
  }
}

async function defaultOpenPr(args: OpenPrArgs): Promise<PrHostResult<Pr>> {
  const { createGitHubPrHost } = await import('../pr-host/github');
  const host = await createGitHubPrHost();
  if (!host) {
    return { ok: false, error: { kind: 'unauthorized', message: 'gh not authenticated' } };
  }
  return host.openPr(args);
}
