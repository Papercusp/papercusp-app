/**
 * gate-candidate-failures.ts — WI-1702869.
 *
 * THE ONE NUMBER GATE TRIAGE NEEDS: how many test files are failing ON THE FROZEN
 * CANDIDATE, and for each of them, whether its fix has ALREADY LANDED on `repairHead`.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 * Measured 2026-08-31, owner-escalated. Asked "how is the greening going", an agent
 * (me) hand-wrote SQL against `harness_shared.test_runs` and reported "45 → 29 failing
 * files" and "no full suite has run". Both were wrong, and wrong in the most expensive
 * direction: the real answer was ONE failing file, whose fix was ALREADY in repairHead.
 * Freeze-and-converge had worked and nobody could see it.
 *
 * The error was not carelessness. `test_runs` mixes THREE populations on any given
 * day, and only ONE of them answers "what are we promoting":
 *
 *   commit_sha='<candidate>', worktree_dirty=false  ← THE FROZEN CANDIDATE. The only
 *                                                     rows that judge what is being
 *                                                     promoted. (223 files that day.)
 *   commit_sha=NULL,          worktree_dirty=false  ← the FULL SUITE, attributed to NO
 *                                                     candidate (6,337 files). See
 *                                                     WI-1702898 — that NULL is a data
 *                                                     defect, not a category.
 *   worktree_dirty=true                             ← runs against a tree ~100 agents
 *                                                     are mutating. ZERO evidentiary
 *                                                     value about any sha, yet recorded
 *                                                     as source='ci'.
 *
 * Aggregating 2 and 3 reports FLEET CHURN as the gate's verdict. There was no cell,
 * tool or field that returned population 1, so the only way to ask the question was to
 * hand-write the join — which is exactly where the error entered. This module is that
 * missing instrument.
 *
 * ── THE FIELD THAT MATTERS ──────────────────────────────────────────────────────
 * `distinctFailingFiles[].fixInRepairHead`. A failing row on the frozen candidate does
 * NOT mean the file is still broken: the candidate is a FROZEN sha, fixes land ON TOP
 * of it (advancing `repairHead`), and the queue re-tests. So the population splits two
 * ways and only one of them is work:
 *
 *   fixInRepairHead: true   → "fixed, awaiting re-verification" — do NOT go fix it
 *   fixInRepairHead: false  → the TEST FILE's bytes are unchanged. NOT by itself "still
 *                             broken": see the non-test-carrier trap on `movesBetween`.
 *                             Decisive only when nothing else moved either; otherwise the
 *                             row hedges and `stillBrokenNeedsRunCount` counts it.
 *   fixInRepairHead: null   → unmeasurable (blob unresolvable); says nothing either way
 *
 * On the measured incident that single field would have ended a five-hour hunt at
 * 06:00Z: 1 failing file, fix already contained, nothing to do but wait for the re-cut.
 *
 * ── THE SCOPE CAVEAT IS PART OF THE ANSWER, NOT A FOOTNOTE ──────────────────────
 * `filesJudged` is the AFFECTED RADIUS the gate selected for this candidate (~223 on
 * the measured day), NOT the ~6,700-file full suite. A reader who takes
 * `distinctFailingFiles: []` as "repairHead is green" has made the mirror-image of the
 * original error — over-claiming green off a narrow probe instead of over-claiming red
 * off a wide one. Every result therefore carries `scope` as a rendered sentence, and
 * `nonTestLegsMeasured` says whether the non-test legs (lint / perf / desktop / delta)
 * were measured at all. A passing affected-tests suite is NOT a green gate.
 *
 * ── P-003: THE LEGS ARE NAMED NOW ───────────────────────────────────────────────
 * `postSuiteMeasured` — one tri-state boolean standing for four unrelated legs, and never
 * actually supplied by the one caller — is GONE. `nonTestLegs.perLeg` answers the question
 * that was really being asked ("WHICH lint leg is red, and did its fix land?") with one row
 * per leg: this tick's own result, the cycle's lifecycle state for it, and the head at which
 * that leg's own re-run last passed. `nonTestLegs.shrink` is the leg-population shrink
 * reading, carrying its own scope sentence so it is never differenced against the test-file
 * counts beside it (D-004).
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import {
  repairTickLegsCurrent,
  type RepairTickLegSnapshot,
  type StoredRepairTickLegs,
} from './release/repair-tick-legs-snapshot';
import {
  summarizeRepairLegs,
  type FrozenRepairLegState,
  type RepairLegShrinkSummary,
  type RepairLegStatus,
} from './release/repair-leg-lifecycle';
import {
  describeUnreadableFrozenCandidateRepairQueue,
  type FrozenCandidateRepairQueueRead,
} from './release/frozen-candidate-repair-queue';

/** Hard cap on rendered failing files — the result is read in-prompt. */
const MAX_FAILING_FILES = 60;
/** Blob comparison is one `git rev-parse` per file per ref; cap the fan-out. */
const MAX_BLOB_COMPARES = 40;
const GIT_TIMEOUT_MS = 5_000;

export interface GateCandidateFailingFile {
  path: string;
  /** How many rows this file has on the candidate (a gate retry writes more than one). */
  attempts: number;
  /** The LATEST attempt's status — a retried-and-passed file is not a failure. */
  status: string;
  /**
   * Whether this file's content DIFFERS between the candidate and repairHead — i.e.
   * whether a fix landed after the cut. `null` when it could not be measured.
   * See the module header: this is the field that separates work from noise.
   */
  fixInRepairHead: boolean | null;
  /** What was actually compared, so a reader can re-run it by hand. */
  comparison: string;
  candidateBlob: string | null;
  repairHeadBlob: string | null;
  /**
   * EI-24654779657165409: the gate's OWN measurement of this file AT repairHead — its latest
   * decisive (pass/fail/error) clean `source='ci'` row for that exact sha — or `null` when the
   * gate has not run it there or `test_runs` could not be read. When present it OUTRANKS the
   * blob compare: a pass means the fix rode a non-test carrier (or the candidate red was
   * environmental), and a fail means the file is still red whatever its bytes say.
   */
  atRepairHead: { status: string; runId: number } | null;
  /** Plain-language reading of the row, so the tri-state cannot be mis-skimmed. */
  reading: string;
}

export interface GateCandidateFailures {
  candidateSha: string | null;
  repairHeadSha: string | null;
  /**
   * DISTINCT test files the gate judged on this candidate — the AFFECTED RADIUS,
   * not the full suite. Read `scope` before quoting this anywhere.
   */
  filesJudged: number;
  /** Files whose LATEST attempt on the candidate is fail/error. */
  distinctFailingFiles: GateCandidateFailingFile[];
  failingFileCount: number;
  /**
   * Of the failing files NOT yet run at repairHead, how many already have their fix there
   * (a changed blob) — fixed, awaiting re-verification.
   */
  alreadyFixedCount: number;
  /**
   * Of the failing files, how many the gate's own clean ci run at repairHead PASSED
   * (`atRepairHead.status === 'pass'`). Verified, not presumed: none of these is work.
   */
  passedAtRepairHeadCount: number;
  /**
   * Of the failing files, how many are still red: measured failing at repairHead, or not
   * run there and carrying an UNCHANGED blob. The second half is a fact about bytes — read
   * `stillBrokenNeedsRunCount` before calling it a queue.
   */
  stillBrokenCount: number;
  /**
   * Of `stillBrokenCount`, how many are only PRESUMED broken: not run at repairHead, the
   * test file is unchanged, but other files moved between the two refs, so the fix may sit
   * in a non-test carrier this test exercises. Each needs a run at repairHead before it
   * counts as work. When this equals `stillBrokenCount`, NOTHING here is confirmed work yet.
   */
  stillBrokenNeedsRunCount: number;
  /**
   * What moved between candidate and repairHead — the evidence behind the hedge above.
   * `null` when it could not be read (which is itself why a row may hedge).
   */
  changedBetweenRefs: { count: number; sample: string[] } | null;
  /**
   * Whether the gate's non-test legs (lint / perf / desktop / delta) were measured.
   * `null` = not recorded in the readable gate-health snapshot, which is NOT the same
   * as `false`. A passing affected-tests suite is never by itself a green gate.
   *
   * ⚠ This field's OWN persistence gap is WI-2142763's territory (the main verdict
   * computation's `postSuiteMeasured`/`postSuiteLegs` are computed but never written to
   * `gate_health`, and threading them here is that ticket's deferred "half 2" —
   * deliberately NOT done by this change, to avoid colliding with that live-gate-adjacent
   * plan). It stays exactly as before: `opts.postSuiteMeasured ?? null`, i.e. always
   * `null` in production today. See `nonTestLegs` below for a DIFFERENT, ALREADY-
   * persisted per-leg measurement this change newly surfaces.
   */
  /**
   * P-003 — REPLACES the `postSuiteMeasured` tri-state.
   *
   * That field was a collapse in two directions at once: one boolean stood for four
   * unrelated legs, AND it was never supplied. It was computed in green-checkpoint.ts,
   * consumed only for a prose note in a log file, never persisted, and the only caller of
   * this function never passed it — so `opts.postSuiteMeasured ?? null` resolved `null`
   * forever while looking like a measurement that had come back empty. (Diagnosed twice
   * independently: audit question #15 and WI-2142763.)
   *
   * This says only what is actually known, from data this module really holds: whether a
   * leg measurement was recorded at all. There is deliberately no third "ran and failed to
   * report" state to fabricate — `not-recorded` is the honest reading of an absence, and
   * WHICH legs and how they are doing is `nonTestLegs` below, by name.
   */
  nonTestLegsMeasured: 'measured' | 'not-recorded';
  /**
   * WI-2143253: the NAMED non-test legs (lint / perf / desktop / delta), read back from
   * the repair queue's own per-leg measurement (`gate_health.repairTickLegs`, written on
   * every awaiting-fixer hold tick — see `./release/repair-tick-legs-snapshot.ts`). This
   * is a DIFFERENT, ALREADY-persisted measurement from `postSuiteMeasured` above: where
   * that field only ever says whether SOMETHING non-test was measured, this names WHICH
   * legs and whether each passed.
   *
   * NEVER `null` (D-003 §2 of main-green-status-visible-2026-09-03: code plus null FIELDS,
   * never a bare null subtree). When no repair-tick measurement exists yet for this repair
   * queue (a fresh queue with no hold tick yet, no repair queue open at all, or the
   * snapshot cleared by a real verdict) `head`/`atMs`/`current` are null, `all`/`failing`
   * are empty, `reading` says NOT MEASURED — and `perLeg` still lists every leg the cycle
   * admitted, from the queue's own lifecycle, so a queue-admitted FAILING leg is outstanding
   * even though nothing measured it this tick (not looking is not a pass, D-005 §4).
   *
   * Why the shape is load-bearing: `nonTestLegs.perLeg` and `nonTestLegs.outstanding` are
   * DECLARED evidence paths of the `gate.greenCheckpoint.candidateFailures` cell
   * (cell-registrations.ts). While this subtree was `null` those paths vanished from the
   * live payload and `assessmentFrom` downgraded the whole cell to `unavailable` — the
   * silent all-clear the plan forbids, and exactly what the independent grader measured
   * (card EI-22270968007901491, criterion C2: cell-assessment-reality 222/223).
   */
  nonTestLegs: {
    /**
     * Is this measurement for the LIVE repairHead, or an earlier one the queue has
     * since moved past? `null` when currency could not be judged (no live repairHead
     * to compare against, or no measurement at all) — see `repairTickLegsCurrent`.
     */
    current: boolean | null;
    /** The (short) repairHead this measurement was actually taken at; null when unmeasured. */
    head: string | null;
    /** When the measurement was taken; null when unmeasured. */
    atMs: number | null;
    /** Every measured leg, pass and fail alike. Bounded to 32 by the writer. */
    all: RepairTickLegSnapshot[];
    /** The subset that did not pass. */
    failing: RepairTickLegSnapshot[];
    /** Plain-language reading, hedged by `current`. */
    reading: string;
    /**
     * P-003 — the NAMED per-leg surface. One row per leg this cycle knows about, joining
     * THIS tick's measurement to the queue's own lifecycle for that leg (P-002/D-005).
     *
     * The union of both sources is deliberate, and each side answers something the other
     * cannot. A leg the queue admitted but this tick did not run appears with
     * `measuredNow: 'not-measured'` and `lifecycle: 'failing'` — because not looking is not
     * a pass. A leg this tick measured that the queue never admitted appears with
     * `lifecycle: 'never-admitted'`, which is the honest reading of a leg with no cycle
     * history rather than a silent omission.
     */
    perLeg: readonly {
      id: string;
      /** This tick's own result, or `not-measured` when this tick did not run the leg. */
      measuredNow: RepairLegStatus | 'not-measured';
      /** The queue's lifecycle state for this leg. */
      lifecycle: 'failing' | 'fixed' | 'never-admitted';
      /**
       * The head at which THIS LEG's own re-run last passed — the only evidence that its
       * fix landed. Null while it is failing, and null for a leg the queue never admitted.
       * Deliberately a HEAD and not a boolean: "did the fix land" is a claim about a
       * specific sha, and a bare `true` invites it to be read as true of the current one.
       */
      fixedAtHead: string | null;
      admittedRound: number | null;
      reading: string;
    }[];
    /**
     * main-green-status-visible-2026-09-03 P-007 — the legs that are RED by this module's
     * own rule, by id, so the assessment below and every reader of it use ONE derivation
     * (`outstandingLegIds`). A leg is outstanding when this tick measured it as anything
     * but `pass`, or when this tick did not measure it and the cycle still has it
     * `failing` (not looking is not a pass). When the measurement is STALE (`current ===
     * false`) only the cycle's lifecycle counts — a pass at a head the queue has moved past
     * is not evidence about the current one.
     */
    outstanding: readonly string[];
    /** The leg shrink reading for this cycle. Carries its own scope sentence (D-004). */
    shrink: RepairLegShrinkSummary;
  };
  /** The scope sentence. Rendered, not derived by the reader. */
  scope: string;
  /** Set when the answer could not be computed; the other fields are then not evidence. */
  unavailable: string | null;
  /** Truncation marker — a capped list is a bounded measurement, never a total. */
  truncated: boolean;
  /**
   * First-match verdict code. THE ORDER IS THE CONTENT: the two "there is no answer here"
   * codes outrank every count, because in both of those states the counts below them
   * describe nothing. A reader who branches on `stillBrokenCount` alone cannot tell an
   * absent subject from a measured zero — which is precisely the collapse that produced
   * the original wrong report ("the gate has no verdict" read as "no tests ran").
   */
  assessment: GateCandidateFailuresCode;
}

export type GateCandidateFailuresCode =
  | 'no-frozen-candidate'
  | 'unmeasured'
  | 'none-failing'
  | 'all-fixes-contained'
  | 'repairs-outstanding'
  /**
   * main-green-status-visible-2026-09-03 P-007: no TEST FILE is still broken, but a
   * non-test leg (lint / perf / desktop / delta) is red and its fix has not landed. Before
   * this code existed the shape rendered as `none-failing` — the assessment counted only
   * test files, so a gate wedged on a lint leg read as "nothing failing" on the one cell
   * whose job is to say what is failing. That is the all-clear-while-red the plan's
   * invariant forbids.
   */
  | 'non-test-leg-failing';

type GitRunner = (cwd: string, args: string[]) => Promise<string | null>;

/** Fail-soft git: a non-zero exit or a missing ref is UNKNOWN (`null`), never a throw. */
const realGit: GitRunner = (cwd, args) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout) => {
      // `git rev-parse <ref>:<missing>` PRINTS the ref string to stdout before exiting
      // non-zero, so stdout alone is NOT a success signal here (the documented
      // `--verify --quiet` trap). Gate on the error first.
      resolve(err ? null : stdout.trim() || null);
    });
  });

/** Parse `git ls-tree -z` without losing whitespace or delimiter characters in paths. */
export function parseGitLsTreeObjectIds(output: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const record of output.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const header = record.slice(0, tab).split(/\s+/);
    const objectId = header[2];
    if (!objectId) continue;
    out.set(record.slice(tab + 1), objectId);
  }
  return out;
}

async function blobIdsAtRef(
  git: GitRunner,
  root: string,
  ref: string,
  paths: readonly string[],
): Promise<Map<string, string> | null> {
  if (paths.length === 0) return new Map();
  const raw = await git(root, ['ls-tree', '-z', ref, '--', ...paths]);
  return raw === null ? null : parseGitLsTreeObjectIds(raw);
}

export interface ReadGateCandidateFailuresOpts {
  candidateSha: string | null;
  repairHeadSha: string | null;
  /** Repo root the blob comparisons resolve against. */
  root: string;
  /** Submodule prefixes (from `submodulePaths()`), so a gitlink move is not misread. */
  submodulePaths?: readonly string[];
  /**
   * P-003: the repair queue's own per-leg LIFECYCLE (P-002 `queue.legs`) — pass it straight
   * through; this module does not fetch it. Distinct from `repairTickLegs` below: that is
   * ONE tick's measurement, this is what the cycle has accumulated across ticks, and only
   * the latter can say whether a leg's fix has landed.
   */
  queueLegs?: readonly FrozenRepairLegState[] | null;
  /**
   * WI-2143253: the repair queue's own already-parsed per-leg measurement
   * (`gate_health.repairTickLegs`, via `parseRepairTickLegs` in
   * `git-pipeline-stats.ts`) — pass it straight through; this module does not fetch it.
   * `null`/omitted when the caller has no such measurement (no repair queue open, or
   * one open with no hold tick yet).
   */
  repairTickLegs?: StoredRepairTickLegs | null;
  /**
   * P-025: the persisted queue read status. A present row that this build cannot parse is
   * NOT the same as an absent queue; preserve its disposition and raw identity in the
   * stable candidate-failures object instead of returning the old null subtree.
   */
  repairQueueRead?: FrozenCandidateRepairQueueRead | null;
  git?: GitRunner;
  sql?: ReturnType<typeof getOrgPg>['sql'];
}

const SCOPE_SENTENCE =
  'filesJudged is the AFFECTED RADIUS the gate selected for this candidate — NOT the full suite ' +
  '(~6,700 files). An empty failing list means "nothing failed in the judged radius", NOT ' +
  '"repairHead is green"; the post-suite legs (lint/perf/desktop/delta) and the main fast-forward ' +
  'are separate and are reported by nonTestLegsMeasured + nonTestLegs.perLeg, BY NAME.';

function unavailable(
  reason: string,
  candidateSha: string | null,
  repairHeadSha: string | null,
  assessment: GateCandidateFailuresCode,
  // WI-2143253: the leg measurement is independent of the test-files query this
  // function fails without — a caller who has it should not lose it just because
  // `test_runs` was unreadable, or there was no frozen candidate to judge test files
  // against. Both are REQUIRED: there is no "nothing to show" default any more, because
  // a null subtree is what made the cell's declared evidence paths vanish (C2).
  nonTestLegs: GateCandidateFailures['nonTestLegs'],
  nonTestLegsMeasured: GateCandidateFailures['nonTestLegsMeasured'],
): GateCandidateFailures {
  return {
    candidateSha,
    repairHeadSha,
    // ZEROES THAT ARE NOT MEASUREMENTS. They exist so the shape is stable for a reader
    // that destructures blindly; `assessment` and `unavailable` are what say they mean
    // nothing. This is the one place this module could manufacture a reassuring number,
    // so it is the one place that has to be explicit about not doing so.
    filesJudged: 0,
    distinctFailingFiles: [],
    failingFileCount: 0,
    alreadyFixedCount: 0,
    passedAtRepairHeadCount: 0,
    stillBrokenCount: 0,
    stillBrokenNeedsRunCount: 0,
    changedBetweenRefs: null,
    nonTestLegsMeasured,
    nonTestLegs,
    scope: SCOPE_SENTENCE,
    unavailable: reason,
    truncated: false,
    assessment,
  };
}

/**
 * The `nonTestLegs` shape when NO repair-tick measurement exists (C2 of
 * EI-22270968007901491). Not a bare null: the per-leg list is still built from the queue's
 * own lifecycle so a queue-admitted failing leg stays outstanding, and `reading` states the
 * absence in words. Exported so fixtures model the production default instead of a `null`
 * the type no longer admits.
 */
export function unmeasuredNonTestLegs(
  queueLegs?: readonly FrozenRepairLegState[] | null,
): GateCandidateFailures['nonTestLegs'] {
  const perLeg = buildPerLeg(null, queueLegs);
  const outstanding = outstandingLegIds(perLeg, null);
  const admitted = perLeg.length;
  const reading =
    admitted === 0
      ? 'NOT MEASURED — no repair-tick leg snapshot exists for this queue (no hold tick has run yet, no repair queue is open, or a real verdict cleared it), and the cycle has admitted no leg. This is not "no legs failing".'
      : `NOT MEASURED — no repair-tick leg snapshot exists for this queue; the ${admitted} leg(s) listed come from the cycle's own lifecycle alone` +
        (outstanding.length > 0
          ? `, and ${outstanding.length} of them (${outstanding.join(', ')}) are still FAILING there. Not measuring a leg is not a pass.`
          : '. Not measuring a leg is not a pass.');
  return {
    current: null,
    head: null,
    atMs: null,
    all: [],
    failing: [],
    reading,
    perLeg,
    outstanding,
    shrink: summarizeRepairLegs(queueLegs ?? undefined),
  };
}

/**
 * WI-2143253: turn a raw `StoredRepairTickLegs` (already parsed by the caller — this
 * module does no I/O of its own for it) into the rendered `nonTestLegs` shape, hedged
 * by currency against the live repairHead. Pure; NEVER null — when the caller had no
 * measurement to give it returns {@link unmeasuredNonTestLegs}, so the cell's declared
 * evidence paths (`nonTestLegs.perLeg` / `.outstanding`) always arrive and the
 * measured-ness flag beside them (`nonTestLegsMeasured`) is what says they are unmeasured.
 */
function buildNonTestLegs(
  snap: StoredRepairTickLegs | null | undefined,
  repairHeadSha: string | null,
  queueLegs?: readonly FrozenRepairLegState[] | null,
): GateCandidateFailures['nonTestLegs'] {
  if (!snap) return unmeasuredNonTestLegs(queueLegs);
  const current = repairTickLegsCurrent(snap, repairHeadSha);
  const failing = snap.legs.filter((l) => l.status !== 'pass');
  const reading =
    current === false
      ? `STALE — measured at an earlier repairHead (${snap.head}); the queue has since moved past it. Not evidence about the current repairHead.`
      : failing.length === 0
        ? 'All measured non-test legs (lint/perf/desktop/delta) passed at this repairHead.'
        : `${failing.length} non-test leg(s) failing at this repairHead: ${failing.map((l) => l.id).join(', ')}.`;
  const perLeg = buildPerLeg(snap, queueLegs);
  return {
    current,
    head: snap.head,
    atMs: snap.atMs,
    all: snap.legs,
    failing,
    reading,
    perLeg,
    outstanding: outstandingLegIds(perLeg, current),
    shrink: summarizeRepairLegs(queueLegs ?? undefined),
  };
}

/**
 * P-007 — WHICH legs are red, by ONE rule, so the assessment and the per-leg readings
 * cannot disagree about it. Exported so the rule is testable on its own.
 *
 * - measured at the CURRENT head (or currency unknown): red iff this tick's result is not
 *   `pass`; a leg this tick did not run is red iff the cycle still has it `failing`
 *   (not measuring it is not a pass — D-005 rule 4).
 * - measured at a STALE head (`current === false`): this tick's result is not evidence
 *   about the current head in either direction, so only the cycle's lifecycle counts.
 * - a `fixed` leg is red again only on a fresh non-pass measurement (a regression); a
 *   `never-admitted` leg is red only when this tick actually measured it red.
 */
export function outstandingLegIds(
  perLeg: ReadonlyArray<{ id: string; measuredNow: RepairLegStatus | 'not-measured'; lifecycle: 'failing' | 'fixed' | 'never-admitted' }>,
  current: boolean | null,
): string[] {
  return perLeg
    .filter((l) =>
      current === false || l.measuredNow === 'not-measured' ? l.lifecycle === 'failing' : l.measuredNow !== 'pass',
    )
    .map((l) => l.id);
}

/**
 * P-003 — one row per leg, over the UNION of this tick's measurement and the cycle's
 * lifecycle.
 *
 * The union is the content. Intersecting instead would drop a leg the queue is still
 * tracking simply because this tick did not run it, which renders "we did not look" as
 * "it is not on the list" — the same false absence D-005 rule 4 exists to stop.
 */
function buildPerLeg(
  snap: StoredRepairTickLegs | null,
  queueLegs?: readonly FrozenRepairLegState[] | null,
): GateCandidateFailures['nonTestLegs']['perLeg'] {
  // No snapshot ⇒ nothing was measured this tick: every row is `not-measured`, and only
  // the cycle's lifecycle speaks (a `failing` leg stays outstanding — D-005 rule 4).
  const measured = new Map((snap?.legs ?? []).map((leg) => [leg.id, leg.status]));
  const lifecycles = new Map((queueLegs ?? []).map((leg) => [leg.id, leg]));
  const ids = [...new Set([...measured.keys(), ...lifecycles.keys()])].sort();
  return ids.map((id) => {
    const measuredNow: RepairLegStatus | 'not-measured' = measured.get(id) ?? 'not-measured';
    const state = lifecycles.get(id);
    const lifecycle = state ? state.state : ('never-admitted' as const);
    const fixedAtHead = state?.state === 'fixed' ? (state.resolvedHead ?? null) : null;
    return {
      id,
      measuredNow,
      lifecycle,
      fixedAtHead,
      admittedRound: state?.admittedRound ?? null,
      reading: perLegReading(id, measuredNow, lifecycle, fixedAtHead),
    };
  });
}

function perLegReading(
  id: string,
  measuredNow: RepairLegStatus | 'not-measured',
  lifecycle: 'failing' | 'fixed' | 'never-admitted',
  fixedAtHead: string | null,
): string {
  if (measuredNow === 'not-measured') {
    return lifecycle === 'failing'
      ? `${id} was NOT measured by this tick and the cycle still has it FAILING. Not measuring it is not a pass — this is outstanding work.`
      : lifecycle === 'fixed'
        ? `${id} was not measured by this tick; its own re-run last passed at ${fixedAtHead ?? 'an unrecorded head'}.`
        : `${id} was not measured by this tick and the cycle never admitted it — nothing is known about it here.`;
  }
  if (measuredNow === 'pass') {
    return lifecycle === 'never-admitted'
      ? `${id} passed at this tick and was never admitted to this cycle — it is not repair work.`
      : `${id} PASSED at this tick${fixedAtHead ? ` (fix observed at ${fixedAtHead})` : ''}. Do NOT go fix it.`;
  }
  return lifecycle === 'never-admitted'
    ? `${id} is ${measuredNow} at this tick but the cycle has no lifecycle for it yet — it has not been admitted, so no shrink is being tracked for it.`
    : `${id} is ${measuredNow} and the cycle has it FAILING. Repair it by making THAT LEG pass — a path match is not evidence about a leg (D-005).`;
}

/**
 * Is `p` inside one of the submodule prefixes?
 *
 * ⚠ THE SUBMODULE TRAP, hit twice on 2026-08-31 before it was named: for a path inside
 * a submodule, `git rev-parse <candidate>:<path>` compares content that is IDENTICAL in
 * both refs while the GITLINK moved underneath it. That answers "unchanged" confidently
 * and wrongly — the false-negative direction, which sends an agent to re-fix a file that
 * was already fixed. Submodule-backed paths are therefore compared by GITLINK, not blob.
 */
function submoduleFor(p: string, subs: readonly string[]): string | null {
  return subs.find((s) => p === s || p.startsWith(s + '/')) ?? null;
}

/**
 * Which submodules could a SUBMODULE-RELATIVE path belong to?
 *
 * ⚠ THE UNQUALIFIED-PATH TRAP (EI-23433375151859491), the submodule trap's other half.
 * `submoduleFor` above matches a SUPERPROJECT-relative path by prefix. But a failing path
 * arrives from `harness_shared.test_runs.file_path` exactly as the runner recorded it, and a
 * suite that ran INSIDE a submodule records it relative to THAT submodule —
 * `src/dispatch-projected.test.ts`, never `libs/generic/tooldef/src/dispatch-projected.test.ts`.
 * Such a path matches no prefix, so it fell through to the superproject `ls-tree` batch, where
 * a submodule-internal path can never resolve: both blobs came back null and the row degraded
 * to UNMEASURABLE.
 *
 * That degradation is SILENT and DIRECTIONAL. An unmeasurable row is indistinguishable from an
 * unfixed one, so the convergence read UNDER-reports how converged a frozen queue is — which
 * invites the two worst responses to a red gate: re-fixing a file whose fix already landed, or
 * retiring a queue that was about to go green. Measured 2026-09-16 on candidate 152598ba4515 /
 * repairHead c1c1807bc78d: the row read "says nothing either way" when the true answer was
 * FIXED (blobs 8a1dd5928fe6 vs 7bbb58297abf inside `libs/generic/tooldef`).
 *
 * Working-tree existence NOMINATES candidates; it never ANSWERS. The verdict is still measured
 * in git against the commit each ref PINS. Ambiguity is reported rather than guessed through:
 * 35 of this repo's 38 submodules have a `src/` directory, so a bare `src/...` path genuinely
 * can belong to more than one, and taking the first would put a confident wrong answer exactly
 * where an honest unknown belongs.
 */
export function submoduleRelativeCandidates(root: string, p: string, subs: readonly string[]): string[] {
  // A path that is absolute, empty, or climbs out of the tree is not submodule-relative.
  if (!p || p.startsWith('/') || p.split('/').includes('..')) return [];
  return subs.filter((s) => existsSync(join(root, s, p)));
}

/**
 * Compare one path's blob INSIDE a submodule, at the commit each ref pins for that submodule.
 *
 * This is the measurement the superproject cannot make. `git rev-parse <ref>:<sub>` yields the
 * GITLINK — the submodule commit that ref pins — and the blob compare then runs in the
 * submodule's own object store. Strictly better evidence than the gitlink-MOVE proxy the
 * qualified-path branch uses: a move says only "something inside this submodule changed",
 * while this says whether THIS FILE changed, and returns two blob ids as evidence rather than
 * a pair of nulls. Fail-soft in both legs: an unreadable pin yields null, never a throw, and
 * null stays UNKNOWN rather than collapsing to "unchanged".
 */
async function blobsInsideSubmodule(
  git: GitRunner,
  root: string,
  sub: string,
  relPath: string,
  candidateSha: string,
  repairHeadSha: string,
): Promise<{ candidate: string | null; repairHead: string | null }> {
  const [candPin, headPin] = await Promise.all([
    git(root, ['rev-parse', '--verify', '--quiet', `${candidateSha}:${sub}`]),
    git(root, ['rev-parse', '--verify', '--quiet', `${repairHeadSha}:${sub}`]),
  ]);
  const subRoot = join(root, sub);
  const [candidate, repairHead] = await Promise.all([
    candPin === null
      ? Promise.resolve(null)
      : git(subRoot, ['rev-parse', '--verify', '--quiet', `${candPin}:${relPath}`]),
    headPin === null
      ? Promise.resolve(null)
      : git(subRoot, ['rev-parse', '--verify', '--quiet', `${headPin}:${relPath}`]),
  ]);
  return { candidate, repairHead };
}

/**
 * Last resort for a path the superproject could not resolve: read it as submodule-relative.
 *
 * Returns `null` when the path is nothing to do with a submodule, so the caller keeps its
 * existing UNMEASURABLE answer untouched. Only ever reached AFTER the batched superproject
 * compare has already failed, so the hot path pays nothing for it — which matters here: the
 * live bg-host profile once caught this loop spending 62.1% of sampled CPU in native spawn
 * (EI-22737582656157929), and nomination is `existsSync`, not a subprocess.
 */
async function submoduleRelativeComparison(
  git: GitRunner,
  root: string,
  path: string,
  subs: readonly string[],
  candidateSha: string,
  repairHeadSha: string,
): Promise<Pick<
  GateCandidateFailingFile,
  'fixInRepairHead' | 'comparison' | 'candidateBlob' | 'repairHeadBlob' | 'reading'
> | null> {
  const candidates = submoduleRelativeCandidates(root, path, subs);
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    const shown = candidates.slice(0, 4).join(', ') + (candidates.length > 4 ? ', …' : '');
    return {
      fixInRepairHead: null,
      comparison: `ambiguous submodule-relative path — '${path}' exists in ${candidates.length} submodules (${shown})`,
      candidateBlob: null,
      repairHeadBlob: null,
      reading:
        `UNMEASURABLE — '${path}' does not resolve in the superproject and is present in ${candidates.length} ` +
        `submodules (${shown}), so which one this red belongs to is genuinely undetermined. Re-run the failing leg ` +
        `for a repo-qualified path, or compare by hand inside the intended submodule. This is NOT a claim that ` +
        `nothing landed.`,
    };
  }
  const sub = candidates[0]!;
  const { candidate, repairHead } = await blobsInsideSubmodule(git, root, sub, path, candidateSha, repairHeadSha);
  const fixInRepairHead = candidate === null || repairHead === null ? null : candidate !== repairHead;
  return {
    fixInRepairHead,
    comparison:
      `git object ids inside ${sub}, at the submodule commits ${candidateSha.slice(0, 12)} and ` +
      `${repairHeadSha.slice(0, 12)} pin, for ${sub}/${path} (path was recorded submodule-relative)`,
    candidateBlob: candidate,
    repairHeadBlob: repairHead,
    reading:
      fixInRepairHead === null
        ? `UNMEASURABLE — '${path}' resolved to ${sub}/${path}, but one of the two pinned blobs did not read; ` +
          `this says nothing either way.`
        : fixInRepairHead
          ? `FIXED AT repairHead, awaiting re-verification — ${sub}/${path} changed inside the ${sub} submodule ` +
            `after the candidate was cut. Do NOT re-fix it.`
          : `The file ${sub}/${path} is UNCHANGED between the two commits the refs pin for ${sub}, so no fix has ` +
            `landed in THIS file. A fix riding a non-test file inside the submodule would not show here — check ` +
            `the submodule's own diff between those pins before concluding this is real work.`,
  };
}

/**
 * What ELSE moved between the candidate and repairHead.
 *
 * ⚠ THE NON-TEST-CARRIER TRAP — the same wrong-object failure as the submodule case
 * above, one level out. `fixInRepairHead` compares the FAILING TEST FILE's blob, which
 * answers "did the test change", and that is only a proxy for "was this fixed". The
 * proxy breaks for the commonest repair shape there is: the fix lands in the code UNDER
 * test — a script the test shells out to, a helper module, a fixture, or a whole-repo
 * scanner the test invokes — leaving the test file itself byte-identical. The blob
 * compare then reports "no fix has landed. This one is real work" with full confidence,
 * and sends an agent to re-fix something already repaired.
 *
 * Measured 2026-09-02 on candidate 797454468a / repairHead 607bff8f43: ALL THREE files
 * the cell called "real work" were already fixed — enforcement-lint and state-snapshot
 * by `scripts/check-resource-governor-enforcement.mjs`, undrained-stdout-exit-guard by
 * `scripts/pc-heavy-jobs.mjs` (a `process.exit(0)` → `return` so piped stdout flushes).
 * All three passed at repairHead. The cell's own instruction was wrong 3 times out of 3.
 *
 * So a `false` is only decisive when NOTHING else moved either. This reads that, and
 * asks it in a form whose empty answer is not ambiguous: tree ids are compared first,
 * because `git diff --name-only` returns an empty string both when nothing changed and
 * when the command failed, and collapsing those two would reintroduce the same class of
 * confident-and-wrong reading this exists to remove.
 */
type ElsewhereMoves =
  | { kind: 'none' }
  | { kind: 'some'; paths: readonly string[] }
  | { kind: 'unknown' };

async function movesBetween(
  git: GitRunner,
  root: string,
  candidateSha: string,
  repairHeadSha: string,
): Promise<ElsewhereMoves> {
  // EI-22131981911313887: a ref cannot differ from ITSELF, so on a queue whose repairHead has
  // not advanced this is knowable without asking git at all. Answering it structurally matters
  // because the tree-id branch below is fail-SOFT: if either `rev-parse` returns null (an
  // unreadable repo, a pruned object) the result degrades to `unknown`, and `unknown` is what
  // `stillBrokenNeedsRunCount` treats as "a fix may be riding a non-test file that moved" —
  // presuming a carrier that cannot exist. Short-circuiting keeps the invariant true even when
  // git answers nothing, and saves two pointless subprocesses on the common fresh-queue path.
  if (candidateSha === repairHeadSha) return { kind: 'none' };
  const [candTree, headTree] = await Promise.all([
    git(root, ['rev-parse', `${candidateSha}^{tree}`]),
    git(root, ['rev-parse', `${repairHeadSha}^{tree}`]),
  ]);
  // Tree ids never render empty, so this branch cannot be faked by a failed command.
  if (candTree !== null && headTree !== null && candTree === headTree) return { kind: 'none' };
  const out = await git(root, ['diff', '--name-only', candidateSha, repairHeadSha]);
  if (out === null) return { kind: 'unknown' };
  const paths = out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return paths.length === 0 ? { kind: 'none' } : { kind: 'some', paths };
}

/** The still-broken reading, hedged exactly as far as the evidence supports and no further. */
function stillBrokenReading(path: string, moves: ElsewhereMoves): string {
  const others = moves.kind === 'some' ? moves.paths.filter((p) => p !== path) : [];
  if (moves.kind === 'none' || (moves.kind === 'some' && others.length === 0)) {
    return (
      'STILL BROKEN — the file is byte-identical at repairHead AND nothing else moved between ' +
      'the two refs, so no fix has landed anywhere. This one is real work.'
    );
  }
  const scale =
    moves.kind === 'unknown'
      ? 'whether anything else moved could not be read'
      : `${others.length} other file(s) DID move`;
  return (
    `NO FIX IN THIS FILE — it is byte-identical at repairHead, which is all a blob compare can ` +
    `say. ${scale} between the candidate and repairHead, and a fix landing in a non-test file ` +
    `this test exercises (a script it invokes, a helper, a fixture, a whole-repo scanner it runs) ` +
    `is INVISIBLE here. RUN THIS FILE AT repairHead before treating it as real work — measured ` +
    `2026-09-02, this row was wrong 3 times out of 3.`
  );
}

async function compareOne(
  git: GitRunner,
  root: string,
  path: string,
  candidateSha: string,
  repairHeadSha: string,
  subs: readonly string[],
  moves: ElsewhereMoves,
  batchedBlobs?: {
    candidate: Map<string, string> | null;
    repairHead: Map<string, string> | null;
  },
): Promise<Pick<GateCandidateFailingFile, 'fixInRepairHead' | 'comparison' | 'candidateBlob' | 'repairHeadBlob' | 'reading'>> {
  // EI-22131981911313887: `repairHead` starts EQUAL to the candidate and stays there until a
  // fixer commits (see frozen-candidate-repair-queue.ts — "starts equal to `candidate` and stays
  // there"), so this is the ordinary state of every freshly-frozen queue, not a resolver fault.
  // Without this branch both `rev-parse` calls resolve the SAME ref, `movesBetween` diffs a ref
  // against itself and returns `none`, and the generic path below then renders a two-ref
  // comparison (`X:<path> vs X:<path>`) plus "nothing else moved between the two refs" — prose
  // describing a measurement nobody performed. That dead-ended string reads as an implementation
  // bug and was filed as one; the reporter compared a pre-converge cell reading against a
  // post-converge queue reading and concluded the cell compared a blob against itself.
  //
  // The VERDICT deliberately stays `false`, NOT `null`: nothing can have landed on a head that
  // has not moved, so every failing file here is genuinely unrepaired and the caller's
  // "fix the files whose fixInRepairHead is false" advice is exactly right. Downgrading these to
  // `null` would collapse `stillBrokenCount` to 0 and flip the assessment to `unmeasured`
  // precisely when a fresh queue's advice is most actionable — the reassuring-degradation
  // failure this cell was filed to end. Only the EXPLANATION changes.
  if (candidateSha === repairHeadSha) {
    return {
      fixInRepairHead: false,
      comparison:
        `not compared — repairHead is still the frozen candidate ${candidateSha.slice(0, 12)}, ` +
        `so there are not two refs to compare`,
      candidateBlob: null,
      repairHeadBlob: null,
      reading:
        'STILL BROKEN — repairHead has not advanced from the frozen candidate, so no fixer has ' +
        'committed yet and no fix can have landed for ANY file on this queue. This one is real ' +
        'work. (Nothing was blob-compared: with a single ref there is nothing to compare.)',
    };
  }
  const sub = submoduleFor(path, subs);
  if (sub) {
    // Compare the GITLINK, not the file. `git diff --raw` emits mode 160000 rows for
    // submodule pointers; a non-empty result means the submodule moved between the two
    // refs, which is the only thing the superproject can honestly say about this path.
    const raw = await git(root, ['diff', '--raw', candidateSha, repairHeadSha, '--', sub]);
    const moved = raw === null ? null : /^:160000/m.test(raw);
    return {
      fixInRepairHead: moved,
      comparison: `gitlink ${sub} between ${candidateSha.slice(0, 12)} and ${repairHeadSha.slice(0, 12)} (submodule-backed path — blob compare would answer about the wrong object)`,
      candidateBlob: null,
      repairHeadBlob: null,
      reading:
        moved === null
          ? 'UNMEASURABLE — the gitlink diff could not be read; this says nothing either way.'
          : moved
            ? `The ${sub} submodule pointer MOVED between the candidate and repairHead, so this red may already be repaired — verify in the submodule before fixing it again.`
            : `The ${sub} submodule pointer is UNCHANGED at repairHead, so nothing has landed for this path yet.`,
    };
  }

  // EI-22737582656157929: the live bg-host profile caught this loop spending 62.1% of real
  // sampled CPU in native spawn. The caller preloads every ordinary path with two `ls-tree`
  // calls (one per ref); retain the old per-path rev-parse only as a fail-soft fallback when a
  // whole batch read itself failed. A successful batch that omits a path means that path is
  // absent at the ref, exactly like the old null result — do not spawn again for an omission.
  const [a, b] = await Promise.all([
    batchedBlobs && batchedBlobs.candidate !== null
      ? Promise.resolve(batchedBlobs.candidate.get(path) ?? null)
      : git(root, ['rev-parse', '--verify', '--quiet', `${candidateSha}:${path}`]),
    batchedBlobs && batchedBlobs.repairHead !== null
      ? Promise.resolve(batchedBlobs.repairHead.get(path) ?? null)
      : git(root, ['rev-parse', '--verify', '--quiet', `${repairHeadSha}:${path}`]),
  ]);
  // Either blob unresolvable ⇒ UNKNOWN. An absent path and an unresolvable ref look
  // identical here, and neither is evidence about whether a fix landed.
  const fixInRepairHead = a === null || b === null ? null : a !== b;
  // EI-23433375151859491: a superproject miss is the ONLY signal that the path might have been
  // recorded submodule-relative, so this is asked here and nowhere earlier — a resolvable path
  // never reaches it, and the ordinary case pays nothing. Returning `null` from the helper means
  // "not a submodule path at all", which leaves the UNMEASURABLE answer below exactly as it was.
  if (fixInRepairHead === null) {
    const viaSubmodule = await submoduleRelativeComparison(git, root, path, subs, candidateSha, repairHeadSha);
    if (viaSubmodule) return viaSubmodule;
  }
  return {
    fixInRepairHead,
    comparison:
      batchedBlobs && batchedBlobs.candidate !== null && batchedBlobs.repairHead !== null
        ? `batched git ls-tree ${candidateSha.slice(0, 12)} vs ${repairHeadSha.slice(0, 12)} for ${path}`
        : `git object ids ${candidateSha.slice(0, 12)}:${path} vs ${repairHeadSha.slice(0, 12)}:${path} (per-ref fallback used where a batch read failed)`,
    candidateBlob: a,
    repairHeadBlob: b,
    reading:
      fixInRepairHead === null
        ? 'UNMEASURABLE — one of the two blobs did not resolve; this says nothing either way.'
        : fixInRepairHead
          ? 'FIXED AT repairHead, awaiting re-verification — the file changed after the candidate was cut. Do NOT re-fix it.'
          : stillBrokenReading(path, moves),
  };
}

/**
 * EI-24654779657165409 — the gate's own verdict on each failing file AT repairHead.
 *
 * Verifying the queue re-runs the affected radius at repairHead, so the direct answer to
 * "is this file still red" is usually already in `test_runs`. Without it the blob compare can
 * only hedge ("RUN THIS FILE AT repairHead"). Measured 2026-09-30 on candidate 5ec99902 /
 * repairHead d8b65f92, the cell reported 20 still-broken files. repairHead's own verification
 * had run all of them clean (7,032 ci passes), and the real red was one lint leg.
 *
 * Same single population as the candidate query (ci, clean tree, this exact sha). Only a
 * DECISIVE row counts: a skip or cancelled run says nothing about red or green.
 */
async function runsAtRepairHead(
  sql: ReturnType<typeof getOrgPg>['sql'],
  repairHeadSha: string,
  paths: readonly string[],
): Promise<Map<string, { status: string; runId: number }>> {
  const out = new Map<string, { status: string; runId: number }>();
  if (paths.length === 0) return out;
  const rows = await sql<Array<{ file_path: string; status: string; id: string | number }>>`
    WITH repair_head_runs AS (
      SELECT file_path, status, finished_at, id
        FROM harness_shared.test_runs
       WHERE source = 'ci'
         AND worktree_dirty = false
         AND commit_sha = ${repairHeadSha}
         AND file_path = ANY(${paths as string[]}::text[])
         AND status IN ('pass', 'fail', 'error')
    )
    SELECT DISTINCT ON (file_path) file_path, status, id
      FROM repair_head_runs
     ORDER BY file_path, finished_at DESC NULLS LAST, id DESC`;
  for (const r of rows) out.set(r.file_path, { status: r.status, runId: Number(r.id) });
  return out;
}

function atRepairHeadReading(
  m: { status: string; runId: number },
  repairHeadSha: string,
  fixInRepairHead: boolean | null,
): string {
  const where = `the gate's own clean ci run #${m.runId} at repairHead ${repairHeadSha.slice(0, 12)}`;
  if (m.status === 'pass') {
    return (
      `PASSED AT repairHead — ${where} passed this file, so it is NOT repair work. ` +
      (fixInRepairHead === false
        ? 'Its bytes are unchanged, so the fix rode a non-test file it exercises, or the candidate red was environmental.'
        : 'Do NOT re-fix it.')
    );
  }
  return (
    `STILL FAILING AT repairHead — ${where} recorded ${m.status}` +
    (fixInRepairHead === true ? ', even though the file changed after the cut, so the landed change did not fix it.' : '.') +
    ' This one is real work.'
  );
}

/**
 * Read the failing-files-on-the-frozen-candidate answer.
 *
 * Fail-soft in every direction: an unreachable database, an unresolvable ref, or a
 * missing candidate all return `unavailable` with the reason stated. A cell must always
 * render, and "I could not measure this" is a correct answer — a fabricated zero is not.
 */
export async function readGateCandidateFailures(
  opts: ReadGateCandidateFailuresOpts,
): Promise<GateCandidateFailures> {
  const candidateSha = opts.candidateSha?.trim() || null;
  const repairHeadSha = opts.repairHeadSha?.trim() || null;
  // WI-2143253: pure and cheap — compute once, thread through every return path
  // (including the unavailable ones below) rather than only the success path.
  // P-012 / C2: measured-ness is derived from whether a SNAPSHOT exists, never from the
  // truthiness of `nonTestLegs` — that object is always present now, so its truthiness
  // would read every unmeasured queue as 'measured'.
  const nonTestLegsMeasured: GateCandidateFailures['nonTestLegsMeasured'] = opts.repairTickLegs
    ? 'measured'
    : 'not-recorded';
  const nonTestLegs = buildNonTestLegs(opts.repairTickLegs, repairHeadSha, opts.queueLegs);
  if (opts.repairQueueRead?.status === 'unreadable') {
    return unavailable(
      `${describeUnreadableFrozenCandidateRepairQueue(opts.repairQueueRead)}; ` +
        'the reader cannot safely measure test_runs for this row, so candidate failures are UNMEASURED.',
      opts.repairQueueRead.candidate ?? candidateSha,
      opts.repairQueueRead.repairHead ?? repairHeadSha,
      'unmeasured',
      nonTestLegs,
      nonTestLegsMeasured,
    );
  }
  if (!candidateSha) {
    return unavailable(
      'no frozen candidate — there is no sha to judge, so there is no failing-files answer. This is not "zero failures".',
      null,
      repairHeadSha,
      'no-frozen-candidate',
      nonTestLegs,
      nonTestLegsMeasured,
    );
  }

  const git = opts.git ?? realGit;
  const subs = opts.submodulePaths ?? [];

  let judged: Array<{ files_judged: string | number }>;
  let failing: Array<{ file_path: string; status: string; attempts: string | number }>;
  try {
    const sql = opts.sql ?? getOrgPg().sql;
    // ONE population, stated explicitly: rows the CI gate recorded FOR THIS SHA against a
    // CLEAN tree. `worktree_dirty=false` is not defensive noise — a dirty-tree run is a
    // measurement of a tree ~100 agents are mutating and proves nothing about any sha.
    [judged, failing] = await Promise.all([
      sql<Array<{ files_judged: string | number }>>`
        SELECT count(DISTINCT file_path) AS files_judged
          FROM harness_shared.test_runs
         WHERE source = 'ci'
           AND worktree_dirty = false
           AND commit_sha = ${candidateSha}`,
      // DISTINCT ON keeps only each file's LATEST attempt: a gate retry writes a second
      // row, and counting the superseded attempt forever is how a fixed file keeps
      // reading as red.
      sql<Array<{ file_path: string; status: string; attempts: string | number }>>`
        WITH candidate_runs AS (
          SELECT file_path, status, finished_at, id
            FROM harness_shared.test_runs
           WHERE source = 'ci'
             AND worktree_dirty = false
             AND commit_sha = ${candidateSha}
        ), latest AS (
          SELECT DISTINCT ON (file_path) file_path, status
            FROM candidate_runs
           ORDER BY file_path, finished_at DESC NULLS LAST, id DESC
        )
        SELECT l.file_path,
               l.status,
               (SELECT count(*) FROM candidate_runs c WHERE c.file_path = l.file_path) AS attempts
          FROM latest l
         WHERE l.status IN ('fail', 'error')
         ORDER BY l.file_path`,
    ]);
  } catch (err) {
    return unavailable(
      `test_runs unreadable: ${err instanceof Error ? err.message : String(err)}`,
      candidateSha,
      repairHeadSha,
      'unmeasured',
      nonTestLegs,
      nonTestLegsMeasured,
    );
  }

  const filesJudged = Number(judged[0]?.files_judged ?? 0);
  const truncated = failing.length > MAX_FAILING_FILES;
  const rows = failing.slice(0, MAX_FAILING_FILES);

  // A repairHead that has not advanced IS the candidate, so its rows are the ones above.
  // Fail-soft: an unreadable read leaves every row on the blob reading it had before, which
  // hedges toward "run it at repairHead" rather than toward a verdict.
  let atHead = new Map<string, { status: string; runId: number }>();
  if (repairHeadSha && repairHeadSha !== candidateSha && rows.length > 0) {
    try {
      atHead = await runsAtRepairHead(
        opts.sql ?? getOrgPg().sql,
        repairHeadSha,
        rows.map((r) => r.file_path),
      );
    } catch {
      atHead = new Map();
    }
  }

  // Read ONCE for the whole result, not per row: it is the same two refs every time.
  const moves: ElsewhereMoves = repairHeadSha
    ? await movesBetween(git, opts.root, candidateSha, repairHeadSha)
    : { kind: 'unknown' };

  // One `ls-tree` per ref replaces the former two-child-processes-per-file fan-out. Submodule
  // rows stay on their deliberately different gitlink comparison path below.
  const blobPaths = repairHeadSha
    ? rows
        .slice(0, MAX_BLOB_COMPARES)
        .map((row) => row.file_path)
        .filter((path) => !submoduleFor(path, subs))
    : [];
  const batchedBlobs =
    repairHeadSha && candidateSha !== repairHeadSha && blobPaths.length > 0
      ? await Promise.all([
          blobIdsAtRef(git, opts.root, candidateSha, blobPaths),
          blobIdsAtRef(git, opts.root, repairHeadSha, blobPaths),
        ]).then(([candidate, repairHead]) => ({ candidate, repairHead }))
      : undefined;

  const compared: Array<Omit<GateCandidateFailingFile, 'atRepairHead'>> = [];
  for (const [i, r] of rows.entries()) {
    const base = {
      path: r.file_path,
      attempts: Number(r.attempts ?? 1),
      status: r.status,
    };
    if (!repairHeadSha) {
      compared.push({
        ...base,
        fixInRepairHead: null,
        comparison: 'not compared — no repairHead sha is open for this candidate',
        candidateBlob: null,
        repairHeadBlob: null,
        reading: 'UNMEASURABLE — without a repairHead there is nothing to compare the candidate against.',
      });
      continue;
    }
    if (i >= MAX_BLOB_COMPARES) {
      compared.push({
        ...base,
        fixInRepairHead: null,
        comparison: `not compared — past the ${MAX_BLOB_COMPARES}-file blob-compare cap`,
        candidateBlob: null,
        repairHeadBlob: null,
        reading: 'UNMEASURABLE — comparison capped; re-run the comparison by hand for this path.',
      });
      continue;
    }
    compared.push({
      ...base,
      ...(await compareOne(git, opts.root, r.file_path, candidateSha, repairHeadSha, subs, moves, batchedBlobs)),
    });
  }

  // The gate's own run at repairHead outranks the blob compare, in both directions.
  const files: GateCandidateFailingFile[] = compared.map((f) => {
    const m = atHead.get(f.path) ?? null;
    return m && repairHeadSha
      ? { ...f, atRepairHead: m, reading: atRepairHeadReading(m, repairHeadSha, f.fixInRepairHead) }
      : { ...f, atRepairHead: null };
  });
  const notRunAtHead = files.filter((f) => f.atRepairHead === null);
  const alreadyFixedCount = notRunAtHead.filter((f) => f.fixInRepairHead === true).length;
  const passedAtRepairHeadCount = files.filter((f) => f.atRepairHead?.status === 'pass').length;
  const stillBrokenCount = files.filter((f) =>
    f.atRepairHead ? f.atRepairHead.status !== 'pass' : f.fixInRepairHead === false,
  ).length;
  // Of the still-broken rows NOT run at repairHead, how many are only PRESUMED so — the test
  // blob is unchanged but other files moved, so a non-test carrier may hold the fix. These
  // need a run at repairHead before they are work. A row the gate already ran there is a
  // measurement, never a presumption, so it is never counted here.
  const stillBrokenNeedsRunCount = notRunAtHead.filter(
    (f) => f.fixInRepairHead === false && moves.kind !== 'none' && !(moves.kind === 'some' && moves.paths.filter((p) => p !== f.path).length === 0),
  ).length;

  return {
    candidateSha,
    repairHeadSha,
    filesJudged,
    distinctFailingFiles: files,
    failingFileCount: failing.length,
    alreadyFixedCount,
    passedAtRepairHeadCount,
    stillBrokenCount,
    stillBrokenNeedsRunCount,
    changedBetweenRefs:
      moves.kind === 'unknown'
        ? null
        : { count: moves.kind === 'none' ? 0 : moves.paths.length, sample: moves.kind === 'none' ? [] : moves.paths.slice(0, 10) },
    nonTestLegsMeasured,
    nonTestLegs,
    scope: SCOPE_SENTENCE,
    unavailable: null,
    truncated,
    // First-match, and `stillBrokenCount > 0` is checked FIRST on purpose: while even one
    // file is genuinely unrepaired, that is the answer, regardless of how many of its
    // siblings are already fixed. `all-fixes-contained` is reserved for the case where
    // there is nothing left to do — claiming it while real work remains would be the
    // reassuring-degradation failure this cell was filed to end.
    //
    // P-007: the NON-TEST LEGS are part of "what is failing on this candidate", so they
    // enter the verdict at the same rank as a still-broken file — a red lint leg with zero
    // failing test files used to read `none-failing`, which is the all-clear-while-red the
    // plan's invariant forbids. `none-failing` now means no file AND no measured leg is
    // red; `nonTestLegsMeasured: 'not-recorded'` still rides beside it to say the legs
    // were never looked at (P-012's measured-ness pairing), which is not the same claim.
    assessment: assessCandidateFailures({
      fileCount: files.length,
      stillBrokenCount,
      alreadyFixedCount,
      passedAtRepairHeadCount,
      outstandingLegs: nonTestLegs.outstanding.length,
      fixedLegs: nonTestLegs.perLeg.filter((l) => l.lifecycle === 'fixed' && !nonTestLegs.outstanding.includes(l.id)).length,
    }),
  };
}

/**
 * P-007 — the verdict rule, pure and exported so it can be falsified without a database.
 * First match wins; the order IS the content (see the comment at the call site).
 */
export function assessCandidateFailures(c: {
  fileCount: number;
  stillBrokenCount: number;
  alreadyFixedCount: number;
  passedAtRepairHeadCount: number;
  outstandingLegs: number;
  fixedLegs: number;
}): GateCandidateFailuresCode {
  // A genuinely unrepaired test file is real work, whatever else is true.
  if (c.stillBrokenCount > 0) return 'repairs-outstanding';
  // A red non-test leg with no landed fix is real work too — and it is the one the file
  // counts cannot see, so it must be named before any file-count reading can say "done".
  if (c.outstandingLegs > 0) return 'non-test-leg-failing';
  // Rows exist but some could not be compared: an unmeasured state wearing a green coat,
  // reported as unmeasured rather than as either verdict.
  // A file the gate already PASSED at repairHead is resolved, not unmeasured.
  if (c.fileCount > 0 && c.alreadyFixedCount + c.passedAtRepairHeadCount !== c.fileCount) return 'unmeasured';
  // Everything that was red — files, legs, or both — has a fix at repairHead awaiting
  // re-verification. This is freeze-and-converge working as designed.
  if (c.fileCount > 0 || c.fixedLegs > 0) return 'all-fixes-contained';
  return 'none-failing';
}
