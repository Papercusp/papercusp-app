/**
 * tsc-red-cleared-resolve.ts — POSITIVE clean-run resolution for `tsc-new-file-red` EIs
 * (EI-20064603102922814).
 *
 * ## The gap this closes
 *
 * `tsc-red-sweep.ts` FILES a standing tsc red once it has outlived its author, and nothing
 * ever RETRACTS it. The reds it files are, by the sweep's own measurement, dominated by
 * self-healing — so the steady state is an accumulating pile of `severity: 'major'` items
 * describing a tree that no longer exists. Measured 2026-08-10: 5 of the 5 open ones were
 * already fixed, 4 of them for ~30 hours. Each one reads, to the next agent triaging the
 * backlog, as a live fleet-gate blocker.
 *
 * That is worse than not filing at all. A `major` that is wrong 100% of the time trains
 * agents to skim past the lane, and the next red — which IS real — reads identically.
 *
 * ## Why this cannot be an absence test, and why that is the whole design
 *
 * The tempting rule is "the file stopped being reported red, so it is fixed". It is
 * unsound, and its failure mode is silent mass-closure. The observation store records only
 * SIGHTINGS OF REDS: nothing in it distinguishes
 *
 *     (a) the gate ran and the file is clean now          [fixed — resolve it]
 *     (b) the gate has not run at all since               [unknown — say nothing]
 *
 * and (b) is exactly what a wedged gate, a paused routines tick, or a quiet weekend looks
 * like. An absence rule closes the ENTIRE backlog the moment the sampler dies — precisely
 * when its evidence is worthless. This is the same constraint the sibling
 * `red-test-green-resolve.ts` encodes ("resolve on POSITIVE evidence, never on absence"),
 * and it is why that module could be written and this one could not: `test_runs` records
 * every run including the passes, while the tsc store recorded only the failures.
 *
 * So the store gained the missing half: `recordGateRun()` appends a RUN HEARTBEAT — "a
 * compile of this project completed at T, and it knew the complete standing set". The
 * inference then becomes positive and local:
 *
 *     a run that completed AFTER a file's last sighting, and did not re-sight it,
 *     is direct evidence the file is no longer red
 *
 * because a run that still saw the red would have appended a fresh observation for it, in
 * that same store, moving its last sighting forward. Silence between two heartbeats is
 * MEASURED silence; silence with no heartbeat at all is just silence.
 *
 * ## The load-bearing refusals (each is a test)
 *   - never resolve a key that is not `tsc-new-file-red::<path>`;
 *   - never resolve with ZERO heartbeats after the last sighting — THE vacuity case, and the
 *     one a naive implementation gets wrong, because "no evidence of red" and "evidence of
 *     no red" are byte-identical here;
 *   - never resolve on fewer than N post-sighting runs — one run can be a coalesced/replayed
 *     compile (the gate serves cached results up to PC_HEAVY_COALESCE_SEC old for files
 *     outside the caller's own `--files` set), so a single clean run is not proof;
 *   - never resolve when the file is GONE from disk — deleted/renamed is ambiguous (the red
 *     may have moved with the code), and that ambiguity is absence-shaped again.
 */

import type { CompletionVerificationEvidence } from '../../coord-lifecycle/records';

/**
 * Post-sighting clean runs required to auto-resolve.
 *
 * Two, not one, and the reason is specific rather than taste: the baseline gate can serve a
 * COALESCED compile — a replayed result up to PC_HEAVY_COALESCE_SEC (420s) old for any file
 * outside the caller's own `--files` set. So a single heartbeat after the last sighting can
 * in principle reflect a compile that predates the fix window it appears to prove. Two
 * independent runs cannot both be the same replay.
 */
export const TSC_RED_MIN_CLEAN_RUNS = 2;

/** The path portion of a `tsc-new-file-red::<path>` key, or null for any other source. */
export function tscRedPathOf(watchdogKey: string | undefined): string | null {
  const prefix = 'tsc-new-file-red::';
  return watchdogKey && watchdogKey.startsWith(prefix) ? watchdogKey.slice(prefix.length) : null;
}

/** One run heartbeat as `readRunHeartbeats()` reports it (seconds, like the store). */
export interface TscRunHeartbeat {
  ts: number;
  project?: string;
  verdict?: string;
  standingCount?: number;
}

export interface TscRedClearedInput {
  /** Unix SECONDS of the most recent sighting of this file, or null if none survives retention. */
  lastSeenSec: number | null;
  /** Run heartbeats surviving retention. Order irrelevant — only `ts` is read. */
  heartbeats: readonly TscRunHeartbeat[];
  /** Does the named file still exist in the tree? */
  fileExists: boolean;
}

export interface TscRedClearedOptions {
  /** Post-sighting clean runs required. Default TSC_RED_MIN_CLEAN_RUNS (2). */
  minCleanRuns?: number;
}

export interface TscRedClearedDecision {
  resolve: boolean;
  reason: string;
  /** Heartbeats strictly newer than the last sighting. */
  cleanRuns: number;
  /** Real completion evidence — present only when `resolve` is true. */
  evidence?: CompletionVerificationEvidence;
  /** Terminal completionRef — present only when `resolve` is true. */
  completionRef?: string;
}

/**
 * Pure: heartbeats STRICTLY newer than the last sighting.
 *
 * Strict is deliberate. The gate records its heartbeat and its observations within the same
 * one-second tick, so a heartbeat at exactly `lastSeenSec` may well be the very run that
 * SIGHTED the file. `>=` would let that run count as evidence the file is clean — reading a
 * red as proof of its own absence. Ties therefore resolve toward "not evidence".
 */
export function cleanRunsAfter(heartbeats: readonly TscRunHeartbeat[], lastSeenSec: number): number {
  let n = 0;
  for (const h of heartbeats) {
    if (typeof h?.ts === 'number' && h.ts > lastSeenSec) n++;
  }
  return n;
}

/**
 * Pure: should this `tsc-new-file-red` EI auto-resolve on positive clean-run evidence?
 * Returns `{ resolve:false, reason }` for every refusal so the decision is fully observable
 * and unit-tested.
 */
export function decideTscRedCleared(
  watchdogKey: string | undefined,
  input: TscRedClearedInput,
  opts: TscRedClearedOptions = {},
): TscRedClearedDecision {
  const minRuns = Math.max(1, opts.minCleanRuns ?? TSC_RED_MIN_CLEAN_RUNS);
  const path = tscRedPathOf(watchdogKey);
  if (!path) return { resolve: false, reason: 'not-tsc-new-file-red', cleanRuns: 0 };

  // No sighting inside retention means there is no "after" to measure against. Every
  // heartbeat in the store would count, including ones older than the red itself.
  if (input.lastSeenSec == null || !Number.isFinite(input.lastSeenSec)) {
    return { resolve: false, reason: 'no-sighting-in-retention', cleanRuns: 0 };
  }

  // A vanished file is ambiguous, not clean: a rename carries the red to a new path (where
  // it is observed as its own new red), and a delete may be a peer mid-refactor. Either way
  // this is an absence argument, which is the one thing this module refuses to make.
  if (!input.fileExists) {
    return { resolve: false, reason: 'file-absent-from-tree (ambiguous: deleted or renamed)', cleanRuns: 0 };
  }

  const cleanRuns = cleanRunsAfter(input.heartbeats, input.lastSeenSec);

  // THE VACUITY GUARD. Zero post-sighting runs means the sampler has not spoken since the
  // red was last seen — which is what a wedged gate looks like, and is indistinguishable
  // from a fixed file to any rule that reasons from absence. Without this line the naive
  // implementation closes the entire backlog the moment the gate stops running.
  if (cleanRuns === 0) {
    return { resolve: false, reason: 'no-runs-since-last-sighting (absence, not evidence)', cleanRuns: 0 };
  }
  if (cleanRuns < minRuns) {
    return { resolve: false, reason: `insufficient-clean-runs (${cleanRuns}<${minRuns})`, cleanRuns };
  }

  const lastSeenIso = new Date(input.lastSeenSec * 1000).toISOString();
  const evidence: CompletionVerificationEvidence = {
    testsRun:
      `tsc baseline gate (run heartbeats): ${cleanRuns} compile(s) completed after the last ` +
      `sighting of ${path} (${lastSeenIso}) without re-observing it as a standing red`,
    testResult: `clean (${cleanRuns} post-sighting run(s), 0 re-sightings)`,
    verifiedHow: 'already-passing',
    addedTests: false,
  };
  const completionRef =
    `Auto-resolved: the standing tsc red on ${path} is cleared by POSITIVE clean-run evidence — ` +
    `${cleanRuns} baseline-gate compile(s) completed after its last sighting (${lastSeenIso}) and none ` +
    `re-observed it, while the file is still present in the tree. A run that still saw the red would ` +
    `have re-recorded it in the same store, so this is measured absence of the red, NOT mere absence ` +
    `of signal. Re-files automatically if it regresses (search-first dedup).`;
  return {
    resolve: true,
    reason: `cleared — ${cleanRuns} clean run(s) since ${lastSeenIso}`,
    cleanRuns,
    evidence,
    completionRef,
  };
}
