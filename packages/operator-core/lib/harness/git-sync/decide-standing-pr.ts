/**
 * decide-standing-pr — the ONE place that answers "what should happen to a
 * working-copy pot's standing pull request right now?"
 * (pot-review-integration-mode-2026-10-05 P-020; decisions D-006, D-007, D-008).
 *
 * A working-copy (review) pot keeps exactly ONE open pull request into the main
 * repository. Its head is a dedicated branch on the pot's fork,
 * {@link STANDING_PR_BRANCH}, that only ever points at a commit the pot's own
 * green gate promoted. So the pull request never carries untested work, and the
 * merge gate (decide-merge-gate.ts) can require PR head === promoted commit.
 *
 * Inputs are facts the caller fetched; the result is the action to take. Pure
 * and sync. Fail direction matches pot-integration-mode.ts: anything that is not
 * a trustworthy `review` read does nothing — it never opens a pull request.
 */
import type { PotIntegrationModeRead } from './pot-integration-mode';

/** The fork branch that carries the standing PR head (exactly the promoted commit). */
export const STANDING_PR_BRANCH = 'papercusp/working-copy';

export type StandingPrTrigger = 'promotion' | 'on-demand';

export interface StandingPrInput {
  integration: PotIntegrationModeRead;
  /** The pot's fork remote (registry `fork_remote`), when configured. */
  forkRemote?: string;
  /** The commit the pot's green gate promoted to the copy's main; null when none yet. */
  promotedSha: string | null;
  /** The currently open standing PR, if any. */
  openPr: { number: number; headSha: string } | null;
  trigger: StandingPrTrigger;
}

export type StandingPrDecision =
  | {
      action: 'skip';
      reason: 'not-working-copy' | 'mode-unknown' | 'fork-missing' | 'nothing-promoted';
      detail: string;
    }
  | { action: 'open'; headSha: string; detail: string }
  | { action: 'update'; prNumber: number; fromSha: string; headSha: string; detail: string }
  | { action: 'noop'; reason: 'already-current'; prNumber: number; detail: string };

const short = (sha: string) => sha.slice(0, 10);

export function decideStandingPr(input: StandingPrInput): StandingPrDecision {
  const { integration, promotedSha, openPr } = input;

  if (integration.source === 'error' || integration.source === 'malformed') {
    return {
      action: 'skip',
      reason: 'mode-unknown',
      detail: "Could not read where this pot's work goes, so no pull request was opened or changed.",
    };
  }
  if (integration.mode !== 'review') {
    return {
      action: 'skip',
      reason: 'not-working-copy',
      detail: 'This pot commits straight into its repository, so it has no pull request to keep up to date.',
    };
  }
  if (!input.forkRemote || !input.forkRemote.trim()) {
    return {
      action: 'skip',
      reason: 'fork-missing',
      detail: 'This pot works in a copy of the repository, but the copy is not set up yet, so there is nothing to send.',
    };
  }
  if (!promotedSha) {
    return {
      action: 'skip',
      reason: 'nothing-promoted',
      detail:
        input.trigger === 'on-demand'
          ? "Nothing has passed the copy's test suite yet, so there is nothing to send."
          : "No commit has passed the copy's test suite yet.",
    };
  }
  if (!openPr) {
    return {
      action: 'open',
      headSha: promotedSha,
      detail: `Opening a pull request with the copy's tested work (${short(promotedSha)}).`,
    };
  }
  if (openPr.headSha === promotedSha) {
    return {
      action: 'noop',
      reason: 'already-current',
      prNumber: openPr.number,
      detail: `Pull request #${openPr.number} already holds the latest tested work (${short(promotedSha)}).`,
    };
  }
  return {
    action: 'update',
    prNumber: openPr.number,
    fromSha: openPr.headSha,
    headSha: promotedSha,
    detail: `Updating pull request #${openPr.number} with newly tested work (${short(openPr.headSha)} → ${short(promotedSha)}).`,
  };
}
