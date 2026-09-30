/**
 * P-009 (green-main-fast-2026-08-25): FAST TARGETED RE-VERDICT AT THE FIXED TIP.
 *
 * The pathology this exists for is measurable and, right now, self-sustaining:
 * green-checkpoint's full affected suite takes longer than {@link CANDIDATE_FOSSIL_AGE_MS},
 * so by the time a red result is ready to publish its candidate is already fossil-old and
 * the verdict is WITHHELD (`reason: 'candidate-fossil'`, green-checkpoint.ts). The next run
 * cuts a fresher candidate and loses the same race. A gate in that state renders no verdict
 * at all — not a red, not a green — for as long as the suite stays slower than the freshness
 * threshold. Adding retries does not help; every retry pays the same full-suite cost.
 *
 * The way out is to stop paying full-suite cost for the common case. When a red names a
 * BOUNDED set of failing files, the question "has this been fixed at the current tip?" does
 * not need the whole suite — it needs those K files, plus whatever the diff since the
 * candidate could have broken. That is a few minutes, not an hour, so it can complete well
 * inside the freshness window and actually publish.
 *
 * ## This is the DECISION half, and only the decision half
 *
 * Exactly like `gate-hygiene-split.ts` (P-005) and `gate-auto-repair.ts` (P-007), this module
 * runs nothing, materializes nothing, and writes nothing. It has no runner dependency to
 * call. It answers two questions and stops:
 *
 *   1. {@link planTargetedReVerdict}   — may this red be re-judged at a newer tip, and if so
 *                                        exactly WHICH files must be re-run there?
 *   2. {@link assessTargetedReVerdict} — given what actually happened when a caller ran them,
 *                                        may the tip carry an upgraded verdict?
 *
 * Splitting (2) out is the same lesson P-007 records: the dangerous half is never choosing
 * what to re-run, it is deciding that the re-run PROVED something.
 *
 * ## The soundness premise, stated out loud
 *
 * An upgrade here is an INCREMENTAL verdict, and it is sound only under a premise that must
 * be checked rather than assumed:
 *
 *     candidate C was judged by a FULL suite, and every file that did not pass at C is in
 *     `candidateFailingFiles`.
 *
 * Given that, everything that passed at C still passes at tip T unless the diff C..T reached
 * it. So the tip's coverage is carried forward iff
 *
 *     ( candidateFailingFiles  UNION  affected(diff C..T) )   all pass at T.
 *
 * Two consequences follow, and both are enforced below rather than left to the caller:
 *
 *   - A candidate whose own coverage was partial or itself incremental cannot be the base of
 *     another carry-forward without bound. Chaining incremental verdicts indefinitely means
 *     no full suite ever runs again, which is a slower version of the same blindness this
 *     module is trying to cure. Hence {@link TargetedReVerdictLimits.maxChainDepth} and
 *     {@link TargetedReVerdictLimits.fullSuiteMaxAgeMs} — "full suite on a cadence" is not a
 *     nice-to-have in the P-009 wording, it is what makes the rest admissible.
 *   - An unavailable or empty affected radius against a NON-EMPTY diff is a refusal, never a
 *     shortcut. This repo has already been bitten by the inverse reading: `test:affected`
 *     maps changed paths onto workspaces, so a selection can legitimately come back empty and
 *     "pass" having executed nothing at all (CLAUDE.md, on affected-test selection). Treating
 *     that as coverage would manufacture a green out of a measurement that never happened.
 *
 * ## The upgrade attaches to the TIP, never to the candidate
 *
 * The single most tempting mistake is to flip the red candidate green because its failures
 * now pass elsewhere. That would be false: C's own tree is still broken, and a `main`
 * fast-forward to C would ship it. Every admitted plan therefore carries `verdictSha` = the
 * tip that was actually re-run, and {@link assessTargetedReVerdict} pins the outcome to
 * `plan.verdictSha` even when the tip has moved on again since (`tipMovedDuringRun`). A
 * verdict may only ever name a sha whose content was measured.
 *
 * ## Status
 *
 * The decision/assessment pair is now consumed by green-checkpoint's candidate-fossil rescue.
 * The call site remains fail-closed: unavailable diff/radius/file evidence, incomplete runner
 * results, or any exception preserve the legacy red verdict.
 */

import {
  CANDIDATE_FOSSIL_AGE_MS,
  GATE_FIRE_INTERVAL_MS,
} from "./gate-verdict-freshness.js";

/** The production call site is enabled; refusals remain explicit and fail-closed. */
export const TARGETED_REVERDICT_ENABLED = true;

/** A test file, qualified by the workspace whose runner owns it. Mirrors the shape
 *  green-checkpoint's isolation primitives already use (`{ workspace, file }`), so the
 *  eventual caller passes what it already has rather than reshaping it. */
export interface TargetedReVerdictFile {
  workspace: string;
  file: string;
}

/**
 * How the candidate's own verdict was reached. Only `full-suite` can be carried forward
 * without qualification; the others are why `maxChainDepth` exists.
 *
 * `unknown` is deliberately NOT treated as `full-suite`. A caller that cannot say how its
 * base was covered has not established the premise, and guessing in the permissive direction
 * is exactly how an unsound green gets published.
 */
export type CandidateCoverage =
  | "full-suite"
  | "incremental"
  | "partial"
  | "unknown";

export interface TargetedReVerdictLimits {
  /** Beyond this many failing files a red is a broad regression, not a targeted question.
   *  Kept at green-checkpoint's own `ISOLATION_MAX_FILES` value for the same reason it uses
   *  it: past this point the re-run stops being cheap and stops being evidence of a fix. */
  maxFailingFiles: number;
  /** Beyond this many workspaces in the affected radius the "targeted" claim is false — the
   *  re-run would approach full-suite cost and lose the race it was built to win. */
  maxAffectedWorkspaces: number;
  /** How many incremental upgrades may chain before a full suite is required. */
  maxChainDepth: number;
  /** How stale the last FULL-suite verdict may be before an incremental upgrade is refused.
   *  This is the "full suite on a cadence" half of P-009 expressed as a hard bound. */
  fullSuiteMaxAgeMs: number;
  /** The re-run must be able to finish inside the freshness window, or publishing it just
   *  loses the fossil race again. Used to refuse a plan whose own estimate cannot fit. */
  freshnessBudgetMs: number;
}

export const DEFAULT_TARGETED_REVERDICT_LIMITS: TargetedReVerdictLimits = {
  // green-checkpoint.ts ISOLATION_MAX_FILES === 15.
  maxFailingFiles: 15,
  maxAffectedWorkspaces: 8,
  maxChainDepth: 4,
  // Four gate intervals: long enough that a healthy gate never trips it, short enough that a
  // chain cannot outlive a working day without a real full suite behind it.
  fullSuiteMaxAgeMs: 4 * GATE_FIRE_INTERVAL_MS,
  // Leave half the fossil window as headroom for materialization + publication.
  freshnessBudgetMs: Math.floor(CANDIDATE_FOSSIL_AGE_MS / 2),
};

export type TargetedReVerdictRefusal =
  /** The base verdict was not a red — there is nothing to upgrade. */
  | "not-red"
  /** The tip is the candidate. A re-run would re-measure the same content and could only
   *  restate the red; nothing about a fix can be learned from it. */
  | "no-newer-tip"
  /** The candidate's coverage does not support carry-forward (`partial` / `unknown`). */
  | "candidate-coverage-not-full"
  /** More failing files than `maxFailingFiles` — a broad red is a real regression. */
  | "failing-set-unbounded"
  /** A red with no failing-file signature at all. There is no targeted question to ask, and
   *  an empty target set trivially "passes" — the emptiness trap in its purest form. */
  | "failing-set-empty"
  /** The diff C..T could not be computed, so the radius is unknown. */
  | "diff-unavailable"
  /** The diff is non-empty but no affected radius could be derived from it. */
  | "affected-radius-unavailable"
  /** The diff is non-empty yet the radius came back empty. Not evidence of safety: see the
   *  module docblock on affected-test selection returning zero workspaces. */
  | "affected-radius-empty-with-diff"
  /** Radius wider than `maxAffectedWorkspaces` — no longer targeted, no longer fast. */
  | "affected-radius-too-wide"
  /** `maxChainDepth` incremental upgrades already stacked on the last full suite. */
  | "incremental-chain-exhausted"
  /** The last full-suite verdict is older than `fullSuiteMaxAgeMs`. */
  | "full-suite-overdue"
  /** The caller's own duration estimate does not fit inside `freshnessBudgetMs`. */
  | "cannot-finish-in-freshness-window";

export interface TargetedReVerdictPlanInput {
  /** The red candidate sha whose verdict is being carried forward. */
  candidate: string;
  /** The tip the re-run would be performed at. MUST be the sha actually materialized. */
  tip: string;
  /** Was the base verdict a red? A green needs no upgrade; anything else is not a base. */
  candidateGreen: boolean | null;
  /** How the candidate's verdict was covered. See {@link CandidateCoverage}. */
  candidateCoverage: CandidateCoverage;
  /** Every file that did not pass at the candidate. The premise in the docblock requires
   *  this to be COMPLETE, not a sample. */
  candidateFailingFiles: TargetedReVerdictFile[];
  /** `git diff --name-only <candidate>..<tip>`. `null` means unavailable (a refusal); `[]`
   *  means the tip differs in no path, which is treated as a real empty diff. */
  changedPathsSinceCandidate: string[] | null;
  /** Workspaces the changed paths select, as derived by the same affected-tests instrument
   *  the gate uses. `null` means it could not be derived (a refusal). */
  affectedWorkspaces: string[] | null;
  /** Files in the affected radius that must be re-run alongside the failing set. Supplied by
   *  the caller because file-level selection belongs to the runner, not to this decision. */
  affectedFiles?: TargetedReVerdictFile[];
  /** How many incremental upgrades already sit between the last full suite and this one. */
  incrementalChainDepth: number;
  /** Age of the last FULL-suite verdict. `null` means none on record, refused as overdue. */
  msSinceLastFullSuiteVerdict: number | null;
  /** Caller's estimate of the targeted re-run's wall-clock cost, if it has one. */
  estimatedRunDurationMs?: number | null;
  limits?: Partial<TargetedReVerdictLimits>;
}

export interface TargetedReVerdictCoverageBasis {
  /** The verdict this upgrade carries forward from. */
  carriedFrom: string;
  /** Why that carry-forward is admissible. */
  carriedCoverage: CandidateCoverage;
  /** Files re-run because they failed at the candidate. */
  failingFiles: TargetedReVerdictFile[];
  /** Files re-run because the diff since the candidate could have reached them. */
  affectedFiles: TargetedReVerdictFile[];
  /** Paths that changed between candidate and tip. */
  changedPaths: string[];
  /** Chain depth this upgrade would occupy. */
  chainDepth: number;
}

export type TargetedReVerdictPlan =
  | {
      admitted: false;
      reasonCode: TargetedReVerdictRefusal;
      summary: string;
    }
  | {
      admitted: true;
      /** The sha the upgraded verdict may name. Never the candidate. */
      verdictSha: string;
      candidate: string;
      /** The exact set to re-run at `verdictSha`, de-duplicated. */
      reRunFiles: TargetedReVerdictFile[];
      reRunWorkspaces: string[];
      coverageBasis: TargetedReVerdictCoverageBasis;
      /** A full suite is owed once the chain reaches this depth. */
      fullSuiteOwedAtChainDepth: number;
      summary: string;
    };

const fileKey = (f: TargetedReVerdictFile) => `${f.workspace}::${f.file}`;

function dedupeFiles(
  files: readonly TargetedReVerdictFile[],
): TargetedReVerdictFile[] {
  const seen = new Set<string>();
  const out: TargetedReVerdictFile[] = [];
  for (const f of files) {
    const k = fileKey(f);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ workspace: f.workspace, file: f.file });
  }
  return out;
}

function refuse(
  reasonCode: TargetedReVerdictRefusal,
  summary: string,
): TargetedReVerdictPlan {
  return { admitted: false, reasonCode, summary };
}

/**
 * Decide whether a red candidate may be re-judged at a newer tip, and produce the exact set
 * that must be re-run there.
 *
 * Every refusal path is a NAMED code rather than a bare `null`, because the caller's job on a
 * refusal is to fall back to a full suite and say why — and "why" is the part a log without
 * codes loses first.
 */
export function planTargetedReVerdict(
  input: TargetedReVerdictPlanInput,
): TargetedReVerdictPlan {
  const limits: TargetedReVerdictLimits = {
    ...DEFAULT_TARGETED_REVERDICT_LIMITS,
    ...(input.limits ?? {}),
  };

  if (input.candidateGreen !== false) {
    return refuse(
      "not-red",
      `targeted-reverdict: base verdict for ${input.candidate.slice(0, 8)} is ` +
        `${input.candidateGreen === true ? "green" : "absent"}, not a red — nothing to upgrade.`,
    );
  }

  if (!input.tip || input.tip === input.candidate) {
    return refuse(
      "no-newer-tip",
      `targeted-reverdict: tip equals candidate ${input.candidate.slice(0, 8)} — ` +
        `re-running the same content cannot show a fix.`,
    );
  }

  if (
    input.candidateCoverage !== "full-suite" &&
    input.candidateCoverage !== "incremental"
  ) {
    return refuse(
      "candidate-coverage-not-full",
      `targeted-reverdict: candidate coverage is '${input.candidateCoverage}' — ` +
        `carry-forward requires a full-suite (or admissibly chained incremental) base.`,
    );
  }

  const failing = dedupeFiles(input.candidateFailingFiles ?? []);
  if (failing.length === 0) {
    return refuse(
      "failing-set-empty",
      `targeted-reverdict: red on ${input.candidate.slice(0, 8)} carries no failing-file ` +
        `signature — there is no targeted question to ask, and an empty target set would ` +
        `pass without executing anything.`,
    );
  }
  if (failing.length > limits.maxFailingFiles) {
    return refuse(
      "failing-set-unbounded",
      `targeted-reverdict: ${failing.length} failing files (> ${limits.maxFailingFiles}) — ` +
        `a broad red is a real regression, not a stale-candidate question.`,
    );
  }

  if (input.changedPathsSinceCandidate == null) {
    return refuse(
      "diff-unavailable",
      `targeted-reverdict: could not compute the diff ${input.candidate.slice(0, 8)}..` +
        `${input.tip.slice(0, 8)}; the radius the re-run must cover is unknown.`,
    );
  }
  const changedPaths = [...input.changedPathsSinceCandidate];

  if (input.affectedWorkspaces == null) {
    return refuse(
      "affected-radius-unavailable",
      `targeted-reverdict: ${changedPaths.length} changed path(s) since ` +
        `${input.candidate.slice(0, 8)}, but no affected radius could be derived from them.`,
    );
  }
  const affectedWorkspaces = [...new Set(input.affectedWorkspaces)];
  if (changedPaths.length > 0 && affectedWorkspaces.length === 0) {
    return refuse(
      "affected-radius-empty-with-diff",
      `targeted-reverdict: ${changedPaths.length} changed path(s) selected ZERO workspaces. ` +
        `An empty selection executes nothing, so it is not evidence that the diff is safe.`,
    );
  }
  if (affectedWorkspaces.length > limits.maxAffectedWorkspaces) {
    return refuse(
      "affected-radius-too-wide",
      `targeted-reverdict: affected radius spans ${affectedWorkspaces.length} workspaces ` +
        `(> ${limits.maxAffectedWorkspaces}) — this is a full suite wearing a targeted label.`,
    );
  }

  if (input.msSinceLastFullSuiteVerdict == null) {
    return refuse(
      "full-suite-overdue",
      `targeted-reverdict: no full-suite verdict on record to carry forward from.`,
    );
  }
  if (input.msSinceLastFullSuiteVerdict > limits.fullSuiteMaxAgeMs) {
    const ageMin = Math.round(input.msSinceLastFullSuiteVerdict / 60_000);
    return refuse(
      "full-suite-overdue",
      `targeted-reverdict: last full-suite verdict is ${ageMin}m old ` +
        `(> ${Math.round(limits.fullSuiteMaxAgeMs / 60_000)}m) — a full suite is owed before ` +
        `another incremental upgrade.`,
    );
  }

  const chainDepth = Math.max(0, input.incrementalChainDepth) + 1;
  if (chainDepth > limits.maxChainDepth) {
    return refuse(
      "incremental-chain-exhausted",
      `targeted-reverdict: ${input.incrementalChainDepth} incremental upgrade(s) already ` +
        `chained on the last full suite (max ${limits.maxChainDepth}) — run the full suite.`,
    );
  }

  if (
    input.estimatedRunDurationMs != null &&
    input.estimatedRunDurationMs > limits.freshnessBudgetMs
  ) {
    return refuse(
      "cannot-finish-in-freshness-window",
      `targeted-reverdict: estimated ${Math.round(input.estimatedRunDurationMs / 60_000)}m ` +
        `re-run does not fit the ${Math.round(limits.freshnessBudgetMs / 60_000)}m freshness ` +
        `budget — publishing it would lose the same fossil race the full suite loses.`,
    );
  }

  const affectedFiles = dedupeFiles(input.affectedFiles ?? []);
  const reRunFiles = dedupeFiles([...failing, ...affectedFiles]);
  const reRunWorkspaces = [
    ...new Set(reRunFiles.map((f) => f.workspace)),
  ].sort();

  return {
    admitted: true,
    verdictSha: input.tip,
    candidate: input.candidate,
    reRunFiles,
    reRunWorkspaces,
    coverageBasis: {
      carriedFrom: input.candidate,
      carriedCoverage: input.candidateCoverage,
      failingFiles: failing,
      affectedFiles,
      changedPaths,
      chainDepth,
    },
    fullSuiteOwedAtChainDepth: limits.maxChainDepth,
    summary:
      `targeted-reverdict: re-judging ${input.tip.slice(0, 8)} with ${reRunFiles.length} file(s) ` +
      `across ${reRunWorkspaces.length} workspace(s) — ${failing.length} carried from the red on ` +
      `${input.candidate.slice(0, 8)}, ${affectedFiles.length} from the ${changedPaths.length}-path ` +
      `diff. Chain depth ${chainDepth}/${limits.maxChainDepth}.`,
  };
}

/** One re-run result, as reported by whatever runner executed the plan. */
export interface TargetedReVerdictRunResult {
  workspace: string;
  file: string;
  passed: boolean;
  /** Timeout / spawn error / crash. Counted as still-failing, never as absent. */
  errored?: boolean;
  /** How many test cases actually EXECUTED. `0` with `passed: true` is the
   *  matched-nothing trap (CLAUDE.md, on gate failure triage) and is refused. `undefined`
   *  means the runner did not report it, which is tolerated but recorded. */
  executedCount?: number;
}

export type TargetedReVerdictOutcomeRefusal =
  /** A planned file produced no result at all. */
  | "results-incomplete"
  /** A result arrived for a file that was not planned — the runner ran something else. */
  | "results-unplanned"
  /** At least one planned file still fails at the tip. */
  | "still-failing"
  /** At least one planned file errored (timeout/spawn/crash) — undetermined, so red stands. */
  | "run-errored"
  /** A file reported `passed` having executed zero tests. */
  | "zero-tests-executed";

export interface TargetedReVerdictOutcomeInput {
  plan: Extract<TargetedReVerdictPlan, { admitted: true }>;
  results: readonly TargetedReVerdictRunResult[];
  /** The integration tip re-read AFTER the run completed. Used only to flag that another
   *  re-verdict is owed — it never changes which sha this verdict names. */
  tipAtCompletion?: string | null;
}

export type TargetedReVerdictOutcome =
  | {
      upgraded: false;
      reasonCode: TargetedReVerdictOutcomeRefusal;
      summary: string;
      offendingFiles: TargetedReVerdictFile[];
    }
  | {
      upgraded: true;
      /** ALWAYS `plan.verdictSha`. A verdict may only name a sha whose content was measured. */
      verdictSha: string;
      coverageBasis: TargetedReVerdictCoverageBasis;
      /** The tip moved on while the re-run was in flight. The verdict below is still valid
       *  for the sha it names; a further re-verdict is owed for the newer tip. */
      tipMovedDuringRun: boolean;
      summary: string;
    };

/**
 * Decide whether an executed plan actually earned the upgrade.
 *
 * Fail-safe in every direction: a missing result, an extra result, an errored run, and a pass
 * that executed nothing all keep the red. The only path to `upgraded: true` is every planned
 * file, and only planned files, passing with a non-zero (or unreported) execution count.
 */
export function assessTargetedReVerdict(
  input: TargetedReVerdictOutcomeInput,
): TargetedReVerdictOutcome {
  const { plan } = input;
  const planned = new Map(plan.reRunFiles.map((f) => [fileKey(f), f]));
  const seen = new Map<string, TargetedReVerdictRunResult>();

  const unplanned: TargetedReVerdictFile[] = [];
  for (const r of input.results ?? []) {
    const k = fileKey(r);
    if (!planned.has(k)) {
      unplanned.push({ workspace: r.workspace, file: r.file });
      continue;
    }
    seen.set(k, r);
  }
  if (unplanned.length > 0) {
    return {
      upgraded: false,
      reasonCode: "results-unplanned",
      offendingFiles: unplanned,
      summary:
        `targeted-reverdict: ${unplanned.length} result(s) for file(s) that were not planned — ` +
        `the runner did not execute the set this decision was made about; red stands.`,
    };
  }

  const missing = [...planned.entries()]
    .filter(([k]) => !seen.has(k))
    .map(([, f]) => f);
  if (missing.length > 0) {
    return {
      upgraded: false,
      reasonCode: "results-incomplete",
      offendingFiles: missing,
      summary:
        `targeted-reverdict: ${missing.length} of ${planned.size} planned file(s) produced no ` +
        `result — coverage is incomplete, so the red stands.`,
    };
  }

  const errored = [...seen.values()].filter((r) => r.errored);
  if (errored.length > 0) {
    return {
      upgraded: false,
      reasonCode: "run-errored",
      offendingFiles: errored.map((r) => ({
        workspace: r.workspace,
        file: r.file,
      })),
      summary:
        `targeted-reverdict: ${errored.length} file(s) errored (timeout/spawn/crash) — ` +
        `undetermined is not passing; red stands.`,
    };
  }

  const zeroExecuted = [...seen.values()].filter(
    (r) => r.passed && r.executedCount === 0,
  );
  if (zeroExecuted.length > 0) {
    return {
      upgraded: false,
      reasonCode: "zero-tests-executed",
      offendingFiles: zeroExecuted.map((r) => ({
        workspace: r.workspace,
        file: r.file,
      })),
      summary:
        `targeted-reverdict: ${zeroExecuted.length} file(s) reported PASS having executed zero ` +
        `tests — a run that measured nothing is not evidence of a fix; red stands.`,
    };
  }

  const stillFailing = [...seen.values()].filter((r) => !r.passed);
  if (stillFailing.length > 0) {
    return {
      upgraded: false,
      reasonCode: "still-failing",
      offendingFiles: stillFailing.map((r) => ({
        workspace: r.workspace,
        file: r.file,
      })),
      summary:
        `targeted-reverdict: ${stillFailing.length} of ${planned.size} file(s) still fail at ` +
        `${plan.verdictSha.slice(0, 8)} — the tip does not carry the fix.`,
    };
  }

  const tipMovedDuringRun =
    input.tipAtCompletion != null && input.tipAtCompletion !== plan.verdictSha;

  return {
    upgraded: true,
    verdictSha: plan.verdictSha,
    coverageBasis: plan.coverageBasis,
    tipMovedDuringRun,
    summary:
      `targeted-reverdict: ${plan.verdictSha.slice(0, 8)} UPGRADED to green — all ` +
      `${planned.size} targeted file(s) pass, carrying forward the full-suite coverage of ` +
      `${plan.candidate.slice(0, 8)} across a ${plan.coverageBasis.changedPaths.length}-path diff ` +
      `(chain depth ${plan.coverageBasis.chainDepth}/${plan.fullSuiteOwedAtChainDepth})` +
      (tipMovedDuringRun
        ? `. NOTE: the tip advanced to ${input.tipAtCompletion!.slice(0, 8)} during the run — ` +
          `this verdict names the sha that was measured, and a further re-verdict is owed.`
        : `.`),
  };
}
