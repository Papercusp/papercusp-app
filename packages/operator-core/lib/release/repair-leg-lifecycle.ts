/**
 * NON-TEST GATE LEGS, GIVEN THE LIFECYCLE A TEST FILE ALREADY HAS.
 * main-green-status-visible-2026-09-03 P-002, over the ruling in D-004.
 *
 * ── THE MEASURED GAP THIS CLOSES ────────────────────────────────────────────────
 * The frozen repair queue holds ONE flat `failingTests: string[]`, and it is not flat in
 * practice: a live queue on 2026-09-03 held `["lint:tsc"]` — a gate LEG id sitting in a
 * field named, typed and TREATED as repo paths. Everything downstream that correlates the
 * failing set to work done correlates it BY PATH:
 * `detectFrozenRepairSharedTreeCollision` normalizes each entry with `normalizeRepoPath`
 * and intersects it against the edited-path set. A leg id is not a path and never
 * intersects, so a non-test leg can be admitted to the failing set and then never
 * correlate, never shrink, and never resolve. It is structurally unable to make progress
 * visible — which is precisely what P-003/P-004 need it to do.
 *
 * ── THE CORRELATION KEY, AND WHY IT IS NOT A PATH (D-005) ───────────────────────
 * The key is the leg's own registry id (`lint:tsc`, `lint:design-primitives`) and the ONLY
 * signal that moves a leg out of the failing set is THAT LEG'S OWN RE-RUN RESULT at a later
 * head. A path heuristic would re-create the bug it is trying to fix: a fixer repairing
 * `lint:design-primitives` edits a CSS or config file whose name has nothing to do with the
 * leg, so "an edited path matched" is evidence about the fixer's diff, never about the leg.
 *
 * Three rules follow, and each one is a falsifier in the test file:
 *
 *  1. ADMISSION comes from a MEASUREMENT, never from the flat list. A measurement carries a
 *     per-leg status; the flat list conflates two populations and cannot say which entry is
 *     a leg. Reading admission off the flat list is the conflation D-004 forbids.
 *
 *  2. ABSENT FROM A MEASUREMENT IS NOT PASSING. A tick that does not measure a leg leaves it
 *     exactly as it was. Dropping an unmeasured leg would render "we did not look" as "it is
 *     fixed" — the false all-clear this whole plan exists to end, and the same rule P-009's
 *     `standDown` encodes: unknown must HOLD you.
 *
 *  3. NOTHING MEASURED IS NOT NOTHING FAILING. `measured: false` is a distinct answer from
 *     `failingLegs: 0`, and `shrinkTotal` is null rather than 0 when no measurement exists.
 *
 * ── NAMING (D-004) ─────────────────────────────────────────────────────────────
 * This summary deliberately does NOT reuse the name `failingNow`. That name belongs to
 * `convergence.failingNow` (the queue row's admitted set), and D-004 rules that two counts
 * over different populations must never be presented so a reader can subtract one from the
 * other. `failingLegs` counts a THIRD population — legs specifically — so it gets its own
 * name and its own scope sentence.
 */

/** How many legs may be persisted on one queue. Mirrors the writer's own 32-leg bound. */
export const FROZEN_REPAIR_LEG_CAP = 32;

/** Longest persisted leg id. A registry id is short; anything longer is truncated, not dropped. */
const MAX_LEG_ID_CHARS = 200;

export type RepairLegStatus = 'pass' | 'fail' | 'errored';

/**
 * One leg's result from one measurement. Structurally the subset of
 * `RepairTickLegSnapshot` this lifecycle actually consumes — passed in by the caller, so
 * this module never reaches for `gate_health` itself and stays pure.
 */
export interface RepairLegMeasurement {
  id: string;
  status: RepairLegStatus;
}

/** One non-test gate leg's lifecycle within a single frozen-candidate repair cycle. */
export interface FrozenRepairLegState {
  /**
   * The leg's registry id (`lint:tsc`) — THE correlation key. Never a repo path, never
   * derived from one.
   */
  id: string;
  /** Decided only by this leg's own re-run result. */
  state: 'failing' | 'fixed';
  /**
   * The round at which this leg was FIRST admitted. Retained across a re-break on purpose:
   * it is the baseline every shrink figure is measured against, so a regression must not
   * silently reset it (the same reason `capConvergenceRounds` always keeps round 1).
   */
  admittedRound: number;
  admittedHead: string;
  admittedAtMs: number;
  /** The most recent measurement OF THIS LEG — not of the tick that happened to run. */
  lastMeasuredHead: string;
  lastMeasuredAtMs: number;
  lastMeasuredRound: number;
  /** Distinct rounds at which this leg was measured failing. */
  failingRounds: number;
  /** Present only while `state === 'fixed'`. */
  resolvedHead?: string;
  resolvedAtMs?: number;
  /** Times this leg went fixed → failing again. Non-zero is a re-break, not noise. */
  regressions?: number;
}

/**
 * The shrink reading over legs. Every count is bounded by what was actually MEASURED, and
 * `measured` is checked first because zero-of-nothing and zero-of-something are different
 * answers wearing the same digit.
 */
export interface RepairLegShrinkSummary {
  /** False when NO leg measurement has ever been applied. NEVER read as "no legs failing". */
  measured: boolean;
  /** Distinct legs ever admitted to this cycle. The shrink baseline. */
  admittedLegs: number;
  /** Admitted legs whose own re-run has since reported pass. */
  fixedLegs: number;
  /** Admitted legs not since measured passing — including ones no recent tick measured. */
  failingLegs: number;
  /** The still-failing leg ids, sorted. Naming them is the point of the whole item. */
  failingLegIds: readonly string[];
  fixedLegIds: readonly string[];
  /** `admittedLegs - failingLegs`. Positive = shrinking. Null when nothing was measured. */
  shrinkTotal: number | null;
  /** Legs that were fixed and broke again. A shrink figure alone hides these. */
  regressedLegs: number;
  /** Newest measurement stamp across all legs; null when nothing was measured. */
  lastMeasuredAtMs: number | null;
  /** The scope sentence (D-004). Rendered, not derived by the reader. */
  scope: string;
}

const LEG_SCOPE_SENTENCE =
  'failingLegs counts NON-TEST GATE LEGS (lint/perf/desktop/delta) admitted to this repair ' +
  'cycle by their own measured result and not since measured passing. It is a different ' +
  'population from convergence.failingNow (the queue row\'s admitted signature set) and from ' +
  'candidateFailures.stillBrokenCount (files in the judged radius) — do not subtract them. ' +
  'A leg no recent tick measured stays counted here: unmeasured is not passing.';

function nonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validTimestampValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Trim to the cap while ALWAYS retaining the earliest-admitted legs. A plain tail slice would
 * drop the baseline the shrink is measured against — the same trap `capConvergenceRounds`
 * documents — so ordering is by admission, oldest first.
 */
function capLegs(legs: readonly FrozenRepairLegState[]): FrozenRepairLegState[] {
  const ordered = [...legs].sort((a, b) =>
    a.admittedRound !== b.admittedRound ? a.admittedRound - b.admittedRound : a.id.localeCompare(b.id),
  );
  return ordered.slice(0, FROZEN_REPAIR_LEG_CAP);
}

/**
 * PURE: fold one tick's leg measurements into the persisted leg states.
 *
 * ⚠ A leg ABSENT from `measurements` is returned UNCHANGED — see rule 2 in the module
 * docblock. This function never removes a leg and never infers a pass.
 */
export function applyRepairLegMeasurements(
  existing: readonly FrozenRepairLegState[] | undefined,
  input: {
    measurements: readonly RepairLegMeasurement[];
    head: string;
    round: number;
    nowMs: number;
    /**
     * The ids the QUEUE SIGNATURE already names as failing at the candidate.
     *
     * Why this exists (EI-23917645695738835, measured 2026-09-21): the signature and `legs`
     * are populated by DIFFERENT paths — the signature at freeze time from the candidate's
     * failing set, `legs` only by a repair tick that measured a leg FAILING. A leg that was
     * red at the candidate but has never been measured failing BY A TICK therefore has no
     * prior state, so its first PASSING measurement used to hit the `!prior` skip below and
     * be discarded. The signature kept naming it, `legState()` kept returning undefined, and
     * `buildRepairManifest` kept re-deriving `red-at-candidate` from that silence — forever.
     * On a subject-less workspace-task leg (`subjectSource:'none'`, so `admitCommand:null`)
     * there is also no admission that could ever clear it, so the queue could not leave
     * `awaiting-fixer` by any route. One queue sat stranded ~40h that way with `legs: []`,
     * freezing `main` for the whole fleet while both named legs measured GREEN at the repair
     * head in the very same run.
     *
     * Passing the signature ids lets a measured pass RESOLVE such a leg. It does not weaken
     * rule 2 in the module docblock: silence still changes nothing, and a leg outside the
     * signature still takes the skip, so the cap is not filled with legs that never failed.
     */
    signatureIds?: readonly string[];
  },
): FrozenRepairLegState[] {
  const byId = new Map<string, FrozenRepairLegState>((existing ?? []).map((leg) => [leg.id, leg]));
  const signatureIds = new Set(
    (input.signatureIds ?? [])
      .filter((id) => nonBlankString(id))
      .map((id) => id.trim().slice(0, MAX_LEG_ID_CHARS)),
  );

  for (const measurement of input.measurements) {
    if (!nonBlankString(measurement.id)) continue;
    const id = measurement.id.trim().slice(0, MAX_LEG_ID_CHARS);
    const failing = measurement.status === 'fail' || measurement.status === 'errored';
    const prior = byId.get(id);

    if (!prior) {
      // A PASSING leg with no prior state was never admitted, so there is nothing to record.
      // Persisting every green leg would fill the cap with legs that never failed and evict
      // the ones that did — the baseline loss capLegs exists to prevent.
      //
      // EXCEPT when the SIGNATURE already names it failing: that leg WAS admitted to the
      // failing set (at freeze, from the candidate), it simply never got a `legs` row
      // because no tick ever measured it failing. Dropping its pass is what stranded a
      // queue for 40h, so resolve it instead. `failingRounds: 0` is the honest count — it
      // never failed a repair ROUND, it was only ever red at the candidate.
      if (!failing) {
        if (!signatureIds.has(id)) continue;
        byId.set(id, {
          id,
          state: 'fixed',
          admittedRound: input.round,
          admittedHead: input.head,
          admittedAtMs: input.nowMs,
          lastMeasuredHead: input.head,
          lastMeasuredAtMs: input.nowMs,
          lastMeasuredRound: input.round,
          failingRounds: 0,
          resolvedHead: input.head,
          resolvedAtMs: input.nowMs,
        });
        continue;
      }
      byId.set(id, {
        id,
        state: 'failing',
        admittedRound: input.round,
        admittedHead: input.head,
        admittedAtMs: input.nowMs,
        lastMeasuredHead: input.head,
        lastMeasuredAtMs: input.nowMs,
        lastMeasuredRound: input.round,
        failingRounds: 1,
      });
      continue;
    }

    const measuredNewRound = input.round > prior.lastMeasuredRound;
    if (failing) {
      const regressed = prior.state === 'fixed';
      const next: FrozenRepairLegState = {
        ...prior,
        state: 'failing',
        lastMeasuredHead: input.head,
        lastMeasuredAtMs: input.nowMs,
        lastMeasuredRound: input.round,
        // Count ROUNDS, not measurements: two ticks in one round is one round failing.
        failingRounds: measuredNewRound ? prior.failingRounds + 1 : prior.failingRounds,
        ...(regressed ? { regressions: (prior.regressions ?? 0) + 1 } : {}),
      };
      delete next.resolvedHead;
      delete next.resolvedAtMs;
      byId.set(id, next);
      continue;
    }

    byId.set(id, {
      ...prior,
      state: 'fixed',
      lastMeasuredHead: input.head,
      lastMeasuredAtMs: input.nowMs,
      lastMeasuredRound: input.round,
      resolvedHead: input.head,
      resolvedAtMs: input.nowMs,
    });
  }

  return capLegs([...byId.values()]);
}

/**
 * PURE: interpret a persisted `legs` array.
 *
 * Malformed ENTRIES are dropped, never the whole array — legs are observability, and the
 * same reasoning `parseConvergenceRounds` records applies: refusing to parse a live queue
 * over a corrupt display row would discard the frozen head and let the treadmill resume.
 */
export function parseRepairLegStates(value: unknown): FrozenRepairLegState[] {
  if (!Array.isArray(value)) return [];
  const legs: FrozenRepairLegState[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (!nonBlankString(row.id)) continue;
    if (row.state !== 'failing' && row.state !== 'fixed') continue;
    if (!Number.isInteger(row.admittedRound) || (row.admittedRound as number) < 1) continue;
    if (!nonBlankString(row.admittedHead) || !nonBlankString(row.lastMeasuredHead)) continue;
    if (!validTimestampValue(row.admittedAtMs) || !validTimestampValue(row.lastMeasuredAtMs)) continue;
    if (!Number.isInteger(row.lastMeasuredRound) || (row.lastMeasuredRound as number) < 1) continue;
    if (!Number.isInteger(row.failingRounds) || (row.failingRounds as number) < 0) continue;
    const resolvedHead = nonBlankString(row.resolvedHead) ? row.resolvedHead : undefined;
    const resolvedAtMs = validTimestampValue(row.resolvedAtMs) ? row.resolvedAtMs : undefined;
    const regressions =
      Number.isInteger(row.regressions) && (row.regressions as number) > 0 ? (row.regressions as number) : undefined;
    legs.push({
      id: (row.id as string).slice(0, MAX_LEG_ID_CHARS),
      state: row.state,
      admittedRound: row.admittedRound as number,
      admittedHead: row.admittedHead,
      admittedAtMs: row.admittedAtMs,
      lastMeasuredHead: row.lastMeasuredHead,
      lastMeasuredAtMs: row.lastMeasuredAtMs,
      lastMeasuredRound: row.lastMeasuredRound as number,
      failingRounds: row.failingRounds as number,
      ...(row.state === 'fixed' && resolvedHead ? { resolvedHead } : {}),
      ...(row.state === 'fixed' && resolvedAtMs ? { resolvedAtMs } : {}),
      ...(regressions ? { regressions } : {}),
    });
  }
  return capLegs(legs);
}

/** PURE: the shrink reading over a cycle's legs. */
export function summarizeRepairLegs(legs: readonly FrozenRepairLegState[] | undefined): RepairLegShrinkSummary {
  const all = legs ?? [];
  if (all.length === 0) {
    return {
      measured: false,
      admittedLegs: 0,
      fixedLegs: 0,
      failingLegs: 0,
      failingLegIds: [],
      fixedLegIds: [],
      // NOT 0 — a zero shrink is a claim that a measured cycle is not shrinking.
      shrinkTotal: null,
      regressedLegs: 0,
      lastMeasuredAtMs: null,
      scope: `No leg measurement has been applied to this cycle. ${LEG_SCOPE_SENTENCE}`,
    };
  }
  const failing = all.filter((leg) => leg.state === 'failing');
  const fixed = all.filter((leg) => leg.state === 'fixed');
  return {
    measured: true,
    admittedLegs: all.length,
    fixedLegs: fixed.length,
    failingLegs: failing.length,
    failingLegIds: failing.map((leg) => leg.id).sort(),
    fixedLegIds: fixed.map((leg) => leg.id).sort(),
    shrinkTotal: all.length - failing.length,
    regressedLegs: all.filter((leg) => (leg.regressions ?? 0) > 0).length,
    lastMeasuredAtMs: all.reduce((newest, leg) => (leg.lastMeasuredAtMs > newest ? leg.lastMeasuredAtMs : newest), 0),
    scope: LEG_SCOPE_SENTENCE,
  };
}

/**
 * How one entry of the queue's flat `failingTests` list was classified.
 *
 * `unclassified` is deliberately its own bucket rather than being folded into either side.
 * An entry that no measurement has ever named as a leg, and that is not path-shaped, is a
 * thing we have no evidence about — and the one move guaranteed to reproduce this item's bug
 * is to guess. Naming the ignorance is what lets a reader see that the flat list holds
 * something neither population accounts for.
 */
export interface RepairSignaturePartition {
  testPaths: readonly string[];
  legIds: readonly string[];
  unclassified: readonly string[];
}

/**
 * PURE: split the queue's flat failing list into the two populations it silently mixes.
 *
 * `knownLegIds` is the AUTHORITY — it comes from what a tick actually measured, so leg
 * membership is a fact about observations rather than a guess about a string. Only entries
 * that no measurement names are then judged by shape, and only in the safe direction: a
 * path-shaped entry is a path; anything else is `unclassified`, never promoted to a leg.
 */
export function partitionRepairSignatures(
  failingTests: readonly string[] | undefined,
  knownLegIds: readonly string[] | undefined,
): RepairSignaturePartition {
  const known = new Set((knownLegIds ?? []).filter(nonBlankString).map((id) => id.trim()));
  const testPaths: string[] = [];
  const legIds: string[] = [];
  const unclassified: string[] = [];
  for (const raw of failingTests ?? []) {
    if (!nonBlankString(raw)) continue;
    const entry = raw.trim();
    if (known.has(entry)) {
      legIds.push(entry);
      continue;
    }
    // Path-shaped: a directory separator, or a filename with an extension. Both are
    // properties of the string itself, and neither can promote an entry TO a leg.
    if (entry.includes('/') || /\.[A-Za-z0-9]+$/.test(entry)) {
      testPaths.push(entry);
      continue;
    }
    unclassified.push(entry);
  }
  return {
    testPaths: [...new Set(testPaths)].sort(),
    legIds: [...new Set(legIds)].sort(),
    unclassified: [...new Set(unclassified)].sort(),
  };
}
