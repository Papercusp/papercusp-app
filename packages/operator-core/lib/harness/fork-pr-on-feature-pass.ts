/**
 * fork-pr-on-feature-pass — the operator handler wired to the DBOS pipeline's
 * feature-passed hook (`setPipelineFeaturePassedHook`). Implements sub-project
 * B3 of non-collaborator-join-fork-pr-2026-06-02 (P-002): when a feature ships,
 * a non-collaborator contributor's code becomes a cross-fork PR.
 *
 * ## Fork-mode gating heuristic (autonomous judgment call — flagged for review)
 * The plan flags the "when do we fork?" heuristic for an owner nod. The choice
 * here: fork mode iff the local identity does NOT have upstream write — i.e.
 * `getPermission` returns `read` or `none`. With `write`/`maintain`/`admin` the
 * owner/collaborator pushes to the upstream directly (the existing integration
 * flow), so this is a no-op. This matches GitHub's own collaborator-permission
 * model and is the obvious correct gate; if the owner prefers a different rule
 * (e.g. always-fork, or a per-harness toggle), change `isForkMode` below.
 *
 * ## Branch semantics (known limitation — follow-up)
 * The feature's commits are on the local clone's current HEAD (the integration
 * model commits there). We create/move `harness/<featureId>` to HEAD and PR that.
 * For the one-feature-at-a-time fork flow this is exactly the feature's work; if
 * multiple features accumulate on HEAD between PRs, the branch carries all of
 * them. True per-feature isolation needs the chunk-loop to commit each feature
 * to its own branch (an orchestrator-submodule change) — tracked as a follow-up.
 *
 * Best-effort: this handler NEVER throws. The pipeline already succeeded; a
 * PR-open failure must not fail it. All external effects are injected seams so
 * the whole thing is unit-testable with no git / GitHub / PG.
 */

import type { OpenForkPrOpts, OpenForkPrResult } from './open-fork-pr';
import { checkContribPolicy, type ContribDecision, type ContribPolicy } from './contrib-policy';
import { appendAgentTrailer } from './agent-trailer';

export type RepoPermission = 'admin' | 'maintain' | 'write' | 'read' | 'none';

export interface FeaturePassedInput {
  harnessSlug: string;
  featureId: string;
  workspaceId?: string;
}

export interface FeaturePassedRepoContext {
  /** Local clone path whose HEAD holds the feature's committed work. */
  repoPath: string;
  /** Upstream default branch the PR targets. */
  baseBranch: string;
  /** gh token (write to the contributor's own fork; read for the permission probe). */
  token: string;
  upstreamOwner: string;
  upstreamRepo: string;
  /**
   * PR-4 (c): numeric GitHub id of the HUMAN operator the local `gh` token
   * resolves to — recorded as the PR's author on `harness_feature_prs` so the
   * WI→PR row is attributable to a real human (not a generic host token), and so
   * the EN-2 P-RATE limiter buckets per-operator. Optional: when the identity
   * can't be resolved the producer records NULL (still tracks the PR).
   */
  authorGithubUserId?: number | null;
}

export interface FeaturePassedDeps {
  /** Returns the harness's shared config, or null when the harness isn't shared (→ no-op). */
  loadSharedConfig: (
    input: FeaturePassedInput,
  ) => Promise<{ github_remote: string; github_repository_id: number } | null>;
  /** Resolve the local repo + upstream context, or null when unavailable (→ no-op). */
  resolveRepoContext: (input: FeaturePassedInput) => Promise<FeaturePassedRepoContext | null>;
  /** The local identity's permission on the upstream repo (drives fork-mode). */
  getPermission: (args: { owner: string; repo: string; token: string }) => Promise<RepoPermission>;
  /** Create/move `featureBranch` to the repo's current HEAD. */
  ensureFeatureBranch: (args: { repoPath: string; featureBranch: string }) => Promise<void>;
  /** Push to the fork + open the cross-fork PR (lib/harness/open-fork-pr). */
  openForkPr: (opts: OpenForkPrOpts) => Promise<OpenForkPrResult>;
  /**
   * EN-4 P-CONTRIB (optional). Load the owner's contribution policy for the
   * harness's hive, or null when none is set. ABSENT ⇒ no contribution-rule
   * enforcement (byte-identical to the pre-EN-4 fork-PR flow).
   */
  loadContribPolicy?: (input: FeaturePassedInput) => Promise<ContribPolicy | null>;
  /**
   * EN-4 P-CONTRIB (optional). List the repo-relative files the feature branch
   * changes vs the base branch — used for the editable-path allowlist check.
   * Required only when `loadContribPolicy` returns a policy with `editablePaths`.
   */
  getChangedFiles?: (args: {
    repoPath: string;
    baseBranch: string;
    featureBranch: string;
  }) => Promise<string[]>;
  /**
   * PR-4 (b): the WI↔PR producer. Called after a PR opens to UPSERT the
   * `harness_feature_prs` row (WI → pr_url → state='open' → author). Optional +
   * BEST-EFFORT: a write failure NEVER flips a successful open to `opened:false`
   * (the PR already exists). Absent ⇒ no row written (the pre-PR-4 behavior).
   */
  recordFeaturePrOpened?: (row: {
    workspaceId?: string;
    harnessSlug: string;
    featureId: string;
    prUrl: string;
    authorGithubUserId?: number | null;
  }) => Promise<void>;
  log?: (msg: string) => void;
}

export type FeaturePassedOutcome =
  | {
      opened: true;
      prUrl: string;
      forkOwner: string;
      /** EN-4 P-CONTRIB: the auto-merge verdict for this PR (present when an owner
       *  contribution policy applies). A downstream auto-merge step must honor
       *  `autoMergeAllowed` — false ⇒ the owner reviews/merges by hand. */
      contrib?: ContribDecision;
    }
  | {
      opened: false;
      reason:
        | 'not_shared'
        | 'no_repo_context'
        | 'integration_mode'
        | 'pr_failed'
        | 'error'
        | 'contrib_path_denied';
      detail?: string;
    };

/** write/maintain/admin can push to the upstream directly → no fork PR. */
function isForkMode(perm: RepoPermission): boolean {
  return perm === 'read' || perm === 'none';
}

export async function handleFeaturePassed(
  input: FeaturePassedInput,
  deps: FeaturePassedDeps,
): Promise<FeaturePassedOutcome> {
  try {
    // Only shared harnesses federate code via fork PRs.
    const shared = await deps.loadSharedConfig(input);
    if (!shared) return { opened: false, reason: 'not_shared' };

    const ctx = await deps.resolveRepoContext(input);
    if (!ctx) return { opened: false, reason: 'no_repo_context' };

    const perm = await deps.getPermission({
      owner: ctx.upstreamOwner,
      repo: ctx.upstreamRepo,
      token: ctx.token,
    });
    if (!isForkMode(perm)) {
      // Owner / collaborator-with-write: the integration flow pushes upstream
      // directly; no fork PR.
      return { opened: false, reason: 'integration_mode' };
    }

    const featureBranch = `harness/${input.featureId}`;
    await deps.ensureFeatureBranch({ repoPath: ctx.repoPath, featureBranch });

    // EN-4 P-CONTRIB: apply the owner's contribution rules at the fork→PR
    // boundary. The editable-path allowlist gates OPENING the PR (an out-of-bounds
    // change is rejected before it becomes a PR); the auto-merge verdict is carried
    // on the result for a downstream merge step to honor. Skipped entirely when no
    // policy is wired/set (no behavior change).
    let contrib: ContribDecision | undefined;
    const contribPolicy = deps.loadContribPolicy ? await deps.loadContribPolicy(input) : null;
    if (contribPolicy) {
      const changedFiles =
        deps.getChangedFiles && Array.isArray(contribPolicy.editablePaths)
          ? await deps.getChangedFiles({
              repoPath: ctx.repoPath,
              baseBranch: ctx.baseBranch,
              featureBranch,
            })
          : [];
      contrib = checkContribPolicy(contribPolicy, { changedFiles });
      if (!contrib.pathsAllowed) {
        deps.log?.(
          `[fork-pr] ${input.featureId} blocked by editable-path policy: ${contrib.deniedPaths.join(', ')}`,
        );
        return {
          opened: false,
          reason: 'contrib_path_denied',
          detail: `changed files outside editable-path allowlist: ${contrib.deniedPaths.join(', ')}`,
        };
      }
    }

    const res = await deps.openForkPr({
      upstreamRemote: `github.com/${ctx.upstreamOwner}/${ctx.upstreamRepo}`,
      upstreamOwner: ctx.upstreamOwner,
      upstreamRepo: ctx.upstreamRepo,
      baseBranch: ctx.baseBranch,
      featureBranch,
      localRepoPath: ctx.repoPath,
      title: `${input.featureId}`,
      // PR-4 (c): the fork→PR-on-feature-pass path is always Bee-driven (the
      // pipeline shipped the feature), so mark the body agent-authored — the
      // account stays the human operator; only the agency is marked.
      body: appendAgentTrailer(`Automated PR for ${input.featureId} (Papercusp fork-mode code→PR).`),
      token: ctx.token,
    });

    if (res.ok) {
      deps.log?.(`[fork-pr] ${input.featureId} → ${res.prUrl}`);
      // PR-4 (b): track the WI→PR link the moment the PR opens, attributed to the
      // HUMAN operator. Best-effort — the PR already exists, so a producer failure
      // must NOT flip this to opened:false.
      if (deps.recordFeaturePrOpened) {
        try {
          await deps.recordFeaturePrOpened({
            workspaceId: input.workspaceId,
            harnessSlug: input.harnessSlug,
            featureId: input.featureId,
            prUrl: res.prUrl,
            authorGithubUserId: ctx.authorGithubUserId ?? null,
          });
        } catch (e) {
          deps.log?.(
            `[fork-pr] ${input.featureId} PR opened but harness_feature_prs write failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }
      return {
        opened: true,
        prUrl: res.prUrl,
        forkOwner: res.forkOwner,
        ...(contrib ? { contrib } : {}),
      };
    }
    deps.log?.(`[fork-pr] ${input.featureId} PR failed: ${res.error}`);
    return { opened: false, reason: 'pr_failed', detail: res.error };
  } catch (e) {
    // Best-effort: never throw — the pipeline already succeeded.
    const detail = e instanceof Error ? e.message : String(e);
    deps.log?.(`[fork-pr] ${input.featureId} error: ${detail}`);
    return { opened: false, reason: 'error', detail };
  }
}
