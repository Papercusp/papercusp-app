/**
 * red-test-green-resolve.ts — POSITIVE green-run resolution for red-test watchdog EIs
 * (agent-ergonomics-audit-fixes-2026-07-13 P-007 / WI-4601).
 *
 * ## The gap this closes
 *
 * The watchdog RAISES a `red-test:<path>` EI when a test file fails repeatedly and is still
 * red. Nothing LOWERS it on positive evidence the test recovered. The only existing retire
 * path (auto-close.ts) fires on signal ABSENCE — the key stopped appearing in the recent
 * ran-ticks — and closes with `skipCompletionGate` as a DEDUP MARKER ("no fix was
 * dispatched; the condition cleared on its own"). Absence is AMBIGUOUS: the file may have
 * been deleted/renamed, or simply stopped being run. That ambiguity is exactly why the
 * whole auto-close sweep is gated behind the owner-authority WATCHDOG_AUTO_CLOSE flag.
 *
 * Measured live (2026-07-13, dev:pg_query): 18 of 58 open `red-test` EIs (31%) had their
 * named test CURRENTLY GREEN — false criticals sitting open for hours-to-weeks. One of
 * them (WI-4428) read as a live gate blocker off exactly this stale-but-green set.
 *
 * This adds the missing POSITIVE path: a `red-test` EI whose named test has passed
 * `minConsecutiveGreens` (default 3) times in a row on its most recent runs is resolved
 * WITH THE GREEN RUN AS REAL COMPLETION EVIDENCE (`verifiedHow: 'already-passing'`) — not a
 * dedup marker. Positive proof, not silence: it never resolves a still-red or merely-quiet
 * signal, so it is categorically safer than absence-based closing.
 *
 * ## The load-bearing silences (each is a test)
 *   - never resolve while the LATEST run is a fail/error (a regressed test stays open);
 *   - never resolve on fewer than N consecutive greens — a single lucky pass after a flake
 *     is not recovery (the live data had exactly one streak-of-1 among the green files);
 *   - never resolve a source that is not `red-test` (no positive test signal exists);
 *   - never resolve when there are NO recent runs — that is ABSENCE (auto-close's job, if
 *     the owner enables it), not a green claim we can evidence.
 *
 * Run status is read NORMALIZED across sibling checkouts (the SAME regex the red-test
 * COLLECTOR uses to key its signal — normalizeRedTestPath), so a test that just failed in
 * the green-checkpoint tree counts as red even if the canonical tree's last affected-run
 * passed. The merged latest status is the truth, and this stays exactly as conservative as
 * the signal that raised the EI.
 */

import { watchdogSourceOf } from './policy';
import type { CompletionVerificationEvidence } from '../../coord-lifecycle/records';

/** Consecutive proven-green runs required (from the latest run backward) to auto-resolve. */
export const RED_TEST_GREEN_MIN_CONSECUTIVE = 3;
/** Lookback for the green-run read. Frequent runners (green-checkpoint + affected) land ≥3 runs easily. */
export const RED_TEST_GREEN_WINDOW_HOURS = 24;

/** One recent test_runs row for a normalized path (the reader returns these LATEST-FIRST). */
export interface RedTestRun {
  /** 'pass' | 'fail' | 'error' — anything other than 'pass' breaks the green streak. */
  status: string;
  startedAtMs: number;
  commitSha?: string | null;
}

export interface RedTestGreenResolveOptions {
  /** Consecutive greens required. Default RED_TEST_GREEN_MIN_CONSECUTIVE (3). */
  minConsecutiveGreens?: number;
}

export interface GreenResolveDecision {
  resolve: boolean;
  reason: string;
  /** Consecutive greens observed from the latest run (0 when the latest is not green). */
  greenStreak: number;
  /** Real completion evidence — present only when `resolve` is true. */
  evidence?: CompletionVerificationEvidence;
  /** Terminal completionRef — present only when `resolve` is true. */
  completionRef?: string;
}

/** The path portion of a `red-test:<path>` key, or null for any other source. */
export function redTestPathOf(watchdogKey: string | undefined): string | null {
  const prefix = 'red-test:';
  return watchdogKey && watchdogKey.startsWith(prefix) ? watchdogKey.slice(prefix.length) : null;
}

/**
 * Pure: consecutive 'pass' runs counting from the LATEST (index 0). Runs MUST be ordered
 * latest-first. A fail/error at any position (including index 0) stops the count there.
 */
export function consecutiveGreenStreak(runs: readonly RedTestRun[]): number {
  let n = 0;
  for (const r of runs) {
    if (r.status === 'pass') n++;
    else break;
  }
  return n;
}

function short(sha: string | null | undefined): string | null {
  return sha ? sha.slice(0, 8) : null;
}

/**
 * Pure: should this red-test EI auto-resolve on positive green-run evidence? Returns
 * `{ resolve:false, reason }` for every guard so the decision is fully observable and
 * unit-tested. `runs` are the recent test_runs for the EI's normalized path, LATEST-FIRST.
 */
export function decideRedTestGreenResolve(
  watchdogKey: string | undefined,
  runs: readonly RedTestRun[],
  opts: RedTestGreenResolveOptions = {},
): GreenResolveDecision {
  const minGreens = Math.max(1, opts.minConsecutiveGreens ?? RED_TEST_GREEN_MIN_CONSECUTIVE);
  if (watchdogSourceOf(watchdogKey) !== 'red-test') return { resolve: false, reason: 'not-red-test', greenStreak: 0 };
  const path = redTestPathOf(watchdogKey);
  if (!path) return { resolve: false, reason: 'not-red-test', greenStreak: 0 };
  if (runs.length === 0) return { resolve: false, reason: 'no-recent-runs', greenStreak: 0 };
  // The LATEST run must be green. A test that failed on its newest run has regressed (or
  // never recovered) — absence/quiet is not our signal, positive current-green is.
  if (runs[0].status !== 'pass') return { resolve: false, reason: 'latest-not-green', greenStreak: 0 };
  const greenStreak = consecutiveGreenStreak(runs);
  if (greenStreak < minGreens) {
    return { resolve: false, reason: `insufficient-consecutive-greens (${greenStreak}<${minGreens})`, greenStreak };
  }

  const latest = runs[0];
  const latestIso = new Date(latest.startedAtMs).toISOString();
  const sha = short(latest.commitSha);
  const evidence: CompletionVerificationEvidence = {
    testsRun:
      `harness_shared.test_runs: ${path} — ${greenStreak} consecutive passing run(s) ` +
      `(latest ${latestIso}${sha ? `, commit ${sha}` : ''})`,
    testResult: `pass (${greenStreak}/${greenStreak} consecutive green)`,
    verifiedHow: 'already-passing',
    addedTests: false,
  };
  const completionRef =
    `Auto-resolved (P-007): the red-test watchdog signal is cleared by POSITIVE green-run evidence — ` +
    `${path} has ${greenStreak} consecutive passing runs in test_runs (latest ${latestIso}` +
    `${sha ? `, commit ${sha}` : ''}). This is proven-green, NOT mere signal-absence. Re-files ` +
    `automatically if it regresses (search-first dedup).`;
  return { resolve: true, reason: `proven green — ${greenStreak} consecutive passing runs`, greenStreak, evidence, completionRef };
}
