/**
 * decide-merge-gate — the ONE place that answers "may the standing PR from a
 * working-copy (review) pot be merged into the main repository right now, and
 * if so, which exact commit lands?" (pot-review-integration-mode-2026-10-05
 * P-024, decision D-008 / acceptance bar R-5, owner directive #1334).
 *
 * The problem it closes: a PR can be merged into a target branch that moved
 * after the PR was tested, or the PR head can carry commits that never went
 * through the pot's own test suite. Either way the code that lands is not the
 * code that passed. So:
 *
 *   1. The PR head must be EXACTLY the pot's gate-promoted commit (the commit
 *      the pot's green gate passed on its own main). Anything else is refused.
 *   2. The suite runs on the MERGE RESULT — the PR head merged onto the main
 *      repository's CURRENT target tip — never on the PR head alone.
 *   3. The merge lands EXACTLY the tested merge commit, by advancing the
 *      target from the tip that was tested (a compare-and-swap lease) to the
 *      tested merge sha. Never a fresh merge made by the forge after testing.
 *   4. If the target tip (or the PR head) moved since the test, the old result
 *      is void: build and test a new merge result.
 *
 * Pure + sync. The caller fetches the facts (PR head, promoted sha, current
 * target tip, the latest merge-test record) and performs the action.
 */

export type MergeTestResult = 'running' | 'pass' | 'fail';

/** The latest recorded test of a built merge result. */
export interface MergeTestRecord {
  /** The merge commit that was built and tested. */
  mergeSha: string;
  /** The PR head the merge commit was built from. */
  prHeadSha: string;
  /** The target tip the merge commit was built onto. */
  targetTipSha: string;
  result: MergeTestResult;
}

export interface MergeGateInput {
  /** Head of the standing PR (the working copy's main as pushed to the PR). */
  prHeadSha: string;
  /** The pot's gate-promoted main commit; null when nothing is promoted yet. */
  promotedSha: string | null;
  /** The main repository's target branch tip, as fetched now. */
  targetTipSha: string;
  /** The latest merge-result test, if any. */
  lastTest: MergeTestRecord | null;
}

export type MergeGateDecision =
  | {
      action: 'refuse';
      reason: 'nothing-promoted' | 'pr-head-not-promoted' | 'merge-result-failed';
      detail: string;
    }
  | {
      action: 'build-and-test';
      reason: 'never-tested' | 'target-moved' | 'pr-head-moved';
      prHeadSha: string;
      targetTipSha: string;
      detail: string;
    }
  | { action: 'wait'; reason: 'test-running'; mergeSha: string; detail: string }
  | {
      action: 'merge';
      /** Advance the target branch to exactly this tested commit. */
      advanceTargetTo: string;
      /** Only if the target is still at this sha (compare-and-swap lease). */
      expectedTargetTip: string;
      detail: string;
    };

const short = (sha: string) => sha.slice(0, 10);

export function decideMergeGate(input: MergeGateInput): MergeGateDecision {
  const { prHeadSha, promotedSha, targetTipSha, lastTest } = input;

  if (!promotedSha) {
    return {
      action: 'refuse',
      reason: 'nothing-promoted',
      detail: "The working copy has no commit that passed its test suite yet, so there is nothing to merge.",
    };
  }
  if (prHeadSha !== promotedSha) {
    return {
      action: 'refuse',
      reason: 'pr-head-not-promoted',
      detail: `The pull request head (${short(prHeadSha)}) is not the commit that passed the working copy's test suite (${short(promotedSha)}). Only the tested commit can be merged.`,
    };
  }

  if (!lastTest) {
    return {
      action: 'build-and-test',
      reason: 'never-tested',
      prHeadSha,
      targetTipSha,
      detail: 'The merged result has not been tested yet. Building it and running the test suite.',
    };
  }
  if (lastTest.prHeadSha !== prHeadSha) {
    return {
      action: 'build-and-test',
      reason: 'pr-head-moved',
      prHeadSha,
      targetTipSha,
      detail: `The pull request changed since the last test (${short(lastTest.prHeadSha)} → ${short(prHeadSha)}). Re-testing the merged result.`,
    };
  }
  if (lastTest.targetTipSha !== targetTipSha) {
    return {
      action: 'build-and-test',
      reason: 'target-moved',
      prHeadSha,
      targetTipSha,
      detail: `The main repository changed since the last test (${short(lastTest.targetTipSha)} → ${short(targetTipSha)}). Re-testing the merged result.`,
    };
  }

  if (lastTest.result === 'running') {
    return {
      action: 'wait',
      reason: 'test-running',
      mergeSha: lastTest.mergeSha,
      detail: 'The test suite is running on the merged result.',
    };
  }
  if (lastTest.result === 'fail') {
    return {
      action: 'refuse',
      reason: 'merge-result-failed',
      detail: `The test suite failed on the merged result (${short(lastTest.mergeSha)}). Fix it in the working copy; the merge is re-tested when its tested commit changes.`,
    };
  }
  return {
    action: 'merge',
    advanceTargetTo: lastTest.mergeSha,
    expectedTargetTip: targetTipSha,
    detail: `Merging exactly the tested result (${short(lastTest.mergeSha)}).`,
  };
}

/**
 * At push time the target is re-checked: the advance is allowed only if the
 * target is still at the tip that was tested. Otherwise the tested result is
 * stale and the gate must re-test (the caller records nothing as merged).
 */
export function confirmMergeAdvance(
  decision: Extract<MergeGateDecision, { action: 'merge' }>,
  targetTipAtPush: string,
): { ok: true } | { ok: false; reason: 'target-moved'; detail: string } {
  if (targetTipAtPush === decision.expectedTargetTip) return { ok: true };
  return {
    ok: false,
    reason: 'target-moved',
    detail: `The main repository moved while merging (${short(decision.expectedTargetTip)} → ${short(targetTipAtPush)}). The tested result is no longer what would land; re-testing.`,
  };
}
