/**
 * harness/git-sync/standing-pr-merge — who merges a working-copy pot's standing
 * PR (P-021) and, when Papercusp merges it, the exact-merge gate (P-024, D-008).
 *
 * Policy (D-006/D-007): by default the OWNER merges the standing PR on GitHub and
 * Papercusp never touches it. Only when <repo> is itself Papercusp-managed AND its
 * pr-host install has auto-merge on does Papercusp merge — and then never through
 * GitHub's squash/merge button, because that would land a commit nobody tested.
 *
 * The merge step (one call per poll tick, stateless between calls):
 *   1. contribution-admission: a revoked author is refused first (strongest deny);
 *   2. the pr-host bar: approved + checks green (same bar as `tryAutoMerge`);
 *   3. the D-008 gate (`decideMergeGate`): build PR head onto the CURRENT target
 *      tip, run the pot suite on that exact sha, and only then fast-forward the
 *      target to exactly that tested sha under a compare-and-swap lease. If the
 *      target moved, the tested result is stale and the next tick re-tests.
 *
 * Reuse: the gate decisions are the pure `decide-merge-gate` module; the approval
 * and checks bar mirrors `pr-host/auto-merge.ts`; the integration mode comes from
 * the existing `readPotIntegrationMode` seam (no new low-level git setting, D-007).
 */

import type { Pr } from '../../pr-host/types';
import { STANDING_PR_BRANCH } from './decide-standing-pr';
import { confirmMergeAdvance, decideMergeGate, type MergeTestRecord } from './decide-merge-gate';
import type { PotIntegrationModeRead } from './pot-integration-mode';

export type StandingPrMergePolicy = 'owner' | 'auto';

export type StandingPrMergePolicyReason =
  | 'not-review-mode'
  | 'upstream-not-managed'
  | 'auto-merge-off'
  | 'managed-auto-merge';

export interface StandingPrMergePolicyInput {
  integration: PotIntegrationModeRead;
  /** <repo> is itself a Papercusp-managed pot, so its pr-host reviewer runs on the PR. */
  upstreamPapercuspManaged: boolean;
  /** The pr-host install's auto-merge setting for <repo>. */
  autoMergeEnabled: boolean;
}

export function decideStandingPrMergePolicy(input: StandingPrMergePolicyInput): {
  policy: StandingPrMergePolicy;
  reason: StandingPrMergePolicyReason;
} {
  if (input.integration.mode !== 'review') return { policy: 'owner', reason: 'not-review-mode' };
  if (!input.upstreamPapercuspManaged) return { policy: 'owner', reason: 'upstream-not-managed' };
  if (!input.autoMergeEnabled) return { policy: 'owner', reason: 'auto-merge-off' };
  return { policy: 'auto', reason: 'managed-auto-merge' };
}

/** The standing PR is the one whose head is the working copy's standing branch. */
export function isStandingPr(pr: Pick<Pr, 'head_ref'>): boolean {
  return pr.head_ref === STANDING_PR_BRANCH;
}

export type AdvanceTargetResult = { ok: true } | { ok: false; tipAtPush: string; error: string };

export interface StandingPrMergeDeps {
  /** Current sha of <repo>'s base branch. */
  readTargetTip(baseBranch: string): Promise<string>;
  /** The latest exact-merge test recorded for this PR, if any. */
  loadLastTest(prNumber: number): Promise<MergeTestRecord | null>;
  saveTest(prNumber: number, rec: MergeTestRecord): Promise<void>;
  /** Merge the PR head onto the target tip; the result sha, or null on a conflict. */
  buildMergeResult(prHeadSha: string, targetTipSha: string): Promise<string | null>;
  /** Start the pot suite on `rec.mergeSha`; its pass/fail lands later via `saveTest`. */
  startTests(prNumber: number, rec: MergeTestRecord): Promise<void>;
  /** Fast-forward the base branch to `sha` only while it is still at `expectedTip`. */
  advanceTarget(args: { baseBranch: string; sha: string; expectedTip: string }): Promise<AdvanceTargetResult>;
}

export interface StandingPrMergeInput {
  pr: Pr;
  policy: StandingPrMergePolicy;
  /** The commit the pot's green gate last promoted to the working copy's main. */
  promotedSha: string | null;
  /** contribution-admission: the PR author is a revoked contributor. */
  authorRevoked: boolean;
  /**
   * A reviewer holding review permission chose Merge in the PR viewer (D-007: work
   * reaches <repo> through PRs "you (or a reviewer) approve"). The pot's own GitHub
   * account authors the standing PR and GitHub refuses self-approval, so in a
   * one-account setup no GitHub approval can ever exist: this click IS the approval
   * (WI-10006351). A GitHub `changes_requested` review still blocks. The poller never
   * sets it.
   */
  viewerApproved?: boolean;
}

export type StandingPrMergeOutcome =
  | { action: 'left-for-owner' }
  | {
      action: 'refused';
      reason: 'author-revoked' | 'nothing-promoted' | 'pr-head-not-promoted' | 'merge-result-failed' | 'merge-conflict';
      detail: string;
    }
  | { action: 'skipped'; reason: 'not-approved' | 'checks-failing'; detail: string }
  | { action: 'testing'; reason: 'never-tested' | 'target-moved' | 'pr-head-moved'; mergeSha: string; detail: string }
  | { action: 'waiting'; mergeSha: string; detail: string }
  | { action: 'merged'; mergeSha: string; detail: string }
  | { action: 'retest'; reason: 'target-moved'; detail: string }
  | { action: 'error'; detail: string };

/** Advance the standing PR's merge by one step. Never throws for gate outcomes. */
export async function stepStandingPrMerge(
  input: StandingPrMergeInput,
  deps: StandingPrMergeDeps,
): Promise<StandingPrMergeOutcome> {
  const { pr } = input;
  if (input.policy === 'owner') return { action: 'left-for-owner' };

  if (input.authorRevoked) {
    return { action: 'refused', reason: 'author-revoked', detail: 'The PR author is a revoked contributor.' };
  }
  if (pr.review_decision === 'changes_requested') {
    return { action: 'skipped', reason: 'not-approved', detail: 'Changes were requested on GitHub. Resolve them before merging.' };
  }
  if (pr.review_decision !== 'approved' && input.viewerApproved !== true) {
    return { action: 'skipped', reason: 'not-approved', detail: `Review decision is ${pr.review_decision}.` };
  }
  if (pr.checks_state !== 'success' && pr.checks_state !== 'unknown') {
    return { action: 'skipped', reason: 'checks-failing', detail: `Checks are ${pr.checks_state}.` };
  }

  const prNumber = pr.ref.number;
  const targetTipSha = await deps.readTargetTip(pr.base_ref);
  const lastTest = await deps.loadLastTest(prNumber);
  const decision = decideMergeGate({
    prHeadSha: pr.head_sha,
    promotedSha: input.promotedSha,
    targetTipSha,
    lastTest,
  });

  switch (decision.action) {
    case 'refuse':
      return { action: 'refused', reason: decision.reason, detail: decision.detail };
    case 'wait':
      return { action: 'waiting', mergeSha: decision.mergeSha, detail: decision.detail };
    case 'build-and-test': {
      const mergeSha = await deps.buildMergeResult(decision.prHeadSha, decision.targetTipSha);
      if (!mergeSha) {
        return {
          action: 'refused',
          reason: 'merge-conflict',
          detail: 'The PR does not merge cleanly onto the current main; resolve it in the working copy.',
        };
      }
      const rec: MergeTestRecord = {
        mergeSha,
        prHeadSha: decision.prHeadSha,
        targetTipSha: decision.targetTipSha,
        result: 'running',
      };
      await deps.saveTest(prNumber, rec);
      await deps.startTests(prNumber, rec);
      return { action: 'testing', reason: decision.reason, mergeSha, detail: decision.detail };
    }
    case 'merge': {
      const pushed = await deps.advanceTarget({
        baseBranch: pr.base_ref,
        sha: decision.advanceTargetTo,
        expectedTip: decision.expectedTargetTip,
      });
      if (pushed.ok) {
        return { action: 'merged', mergeSha: decision.advanceTargetTo, detail: decision.detail };
      }
      const confirm = confirmMergeAdvance(decision, pushed.tipAtPush);
      if (!confirm.ok) return { action: 'retest', reason: 'target-moved', detail: confirm.detail };
      return { action: 'error', detail: pushed.error };
    }
  }
}
