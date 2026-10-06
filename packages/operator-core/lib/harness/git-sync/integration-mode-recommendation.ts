/**
 * P-018 (pot-review-integration-mode-2026-10-05): recommend — and in one case
 * lock — the answer to "Where should the agents' work go?" from facts GitHub
 * can tell us (fetchRepoIntegrationFacts). Pure: no I/O.
 *
 * Rules, first match wins:
 *   1. No write access to <repo>           → working copy, LOCKED (the only way the work can land).
 *   2. Main requires PRs / is protected    → recommend working copy.
 *   3. Other committers on <repo>          → recommend working copy.
 *   4. CI / deploy workflows on <repo>     → recommend working copy.
 *   5. Private, you are the only committer → recommend straight in.
 *   6. Otherwise the workspace default (PotControlPolicy.newPotIntegrationMode), else straight in.
 *
 * A recommendation never points at an option that cannot be chosen: when the
 * repo has no test suite, an unlocked working-copy recommendation falls back to
 * straight in and says why. A lock with no test suite leaves NO choosable
 * option; `blocked` carries both reasons and the create step must refuse.
 */
import type { PotIntegrationMode } from './pot-integration-mode';
import type { RepoIntegrationFacts } from '../github-repo-permissions';

export interface IntegrationModeRecommendation {
  recommended: PotIntegrationMode;
  /** True when the other answer is not allowed for this repo. */
  locked: boolean;
  /** One plain-language line saying why. */
  reason: string;
  /** Which rule produced it (for tests and diagnostics). */
  rule: 'no-write-access' | 'main-requires-pr' | 'other-committers' | 'has-ci' | 'private-sole-committer' | 'workspace-default' | 'fallback';
  /** Set when no answer can be chosen (locked to the working copy, but there is no test suite). */
  blocked?: string;
}

export interface RecommendIntegrationModeOptions {
  /** How the repository is named to the user, e.g. "acme/widgets". */
  repoLabel: string;
  /** PotControlPolicy.newPotIntegrationMode, when set. */
  policyDefault?: PotIntegrationMode | null;
  /** Whether the pot has a real test suite; `undefined` = unknown (not held against the working copy). */
  hasTestSuite?: boolean;
}

const NO_SUITE =
  'This repository has no test suite, so a PR could not show the work passed tests. Add a test command first.';

export function recommendIntegrationMode(
  facts: Partial<RepoIntegrationFacts> | null | undefined,
  opts: RecommendIntegrationModeOptions,
): IntegrationModeRecommendation {
  const repo = opts.repoLabel.trim() || 'the repository';
  const f = facts ?? {};

  if (f.canWrite === false) {
    const reason = `You can't push to ${repo}, so the agents' work has to go through a working copy and PRs.`;
    return {
      recommended: 'review',
      locked: true,
      reason,
      rule: 'no-write-access',
      ...(opts.hasTestSuite === false ? { blocked: `${reason} ${NO_SUITE}` } : {}),
    };
  }

  const reviewBecause = (
    rule: IntegrationModeRecommendation['rule'],
    reason: string,
  ): IntegrationModeRecommendation =>
    opts.hasTestSuite === false
      ? { recommended: 'direct', locked: false, rule, reason: `${reason} A working copy would be safer, but ${NO_SUITE.charAt(0).toLowerCase()}${NO_SUITE.slice(1)}` }
      : { recommended: 'review', locked: false, rule, reason };

  if (f.mainRequiresPr === true) {
    return reviewBecause('main-requires-pr', `${repo}'s ${f.defaultBranch ?? 'main'} branch is protected or requires pull requests.`);
  }
  if (f.otherCommitters === true) {
    return reviewBecause('other-committers', `Other people commit to ${repo}.`);
  }
  if (f.hasCi === true) {
    return reviewBecause('has-ci', `${repo} runs CI or deploy workflows.`);
  }
  if (f.isPrivate === true && f.otherCommitters === false) {
    return {
      recommended: 'direct',
      locked: false,
      rule: 'private-sole-committer',
      reason: `${repo} is private and you are its only committer.`,
    };
  }
  if (opts.policyDefault === 'review' || opts.policyDefault === 'direct') {
    if (opts.policyDefault === 'review') {
      return reviewBecause('workspace-default', 'This is the workspace default for new pots.');
    }
    return { recommended: 'direct', locked: false, rule: 'workspace-default', reason: 'This is the workspace default for new pots.' };
  }
  return {
    recommended: 'direct',
    locked: false,
    rule: 'fallback',
    reason: `Nothing about ${repo} calls for a working copy.`,
  };
}
