// qodo-cover-loop.ts — P-025, plan design-to-code-coverage-seam-2026-09-02.
//
// The Qodo Cover loop D-004 adopts: generate a candidate test, verify it
// BUILDS, PASSES and RAISES COVERAGE, and keep it ONLY then. D-004 rules the
// loop in and the unmaintained OSS dependency out, so this is built on in-repo
// surfaces and adds no dependency.
//
// ── Why the coverage leg is a delta and not the patch-coverage gate (D-048) ──
// The obvious wiring — hand the candidate's diff to `judgePatchCoverage` from
// scripts/lib/patch-coverage.ts — is vacuous here. That gate's
// `isCoverableSourcePath` excludes `*.test.ts` by design ("a test file's own
// lines are not the thing under test"), so a candidate test's diff skips every
// path, measures zero lines, and resolves to `no-coverable-lines` — which
// scripts/patch-coverage.ts documents as exit 0, a PASS. Every generated test
// would be kept, including the zero-delta ones this loop exists to discard: a
// check that does not gate is decoration (D-008), wearing a confident verdict.
//
// So RAISES-COVERAGE is a two-snapshot covered-line-set delta: run the suite
// WITHOUT the candidate, run it WITH, and ask which executable lines went from
// unhit to hit. That still reuses P-007 — `parseLcov` + `indexBySourceFile`
// produce records whose `lines` map is exactly "executable line -> hit count",
// the substrate a delta needs. `CoverageRecord` below is structurally satisfied
// by `LcovRecord`, so a caller passes that output straight in; operator-core
// deliberately takes no import edge into scripts/.
//
// ── The conclusiveness rule ──
// A zero delta and an unmeasurable delta are opposite meanings with identical
// output (`newlyCoveredLines === 0`), and the confusion fails in the
// false-confidence direction. Every verdict here therefore carries its own
// coverage report — `conclusive` plus a reason — and callers must gate a
// keep/discard decision on `isCoverLoopVerdictConclusive`, never on the counts
// alone. Same discipline P-017/P-018 landed as `unsuppliedTurns` /
// `unmeasuredSessions`.

/**
 * One file's executable-line hit counts from a coverage run.
 *
 * Structurally satisfied by `LcovRecord` from scripts/lib/lcov-merge.ts, whose
 * `lines` is documented "Executable line number -> hit count". Paths are
 * expected repo-root-relative and normalized (that file's `normalizeSourcePath`
 * does it); this module compares them as opaque keys and never resolves them.
 */
export interface CoverageRecord {
  readonly sourceFile: string;
  readonly lines: ReadonlyMap<number, number>;
}

/**
 * A coverage snapshot, or the explicit absence of one.
 *
 * `null` means the run produced no artifact at all — distinct from an empty
 * array, which means it produced one that instrumented nothing. Both are
 * inconclusive, and they are kept apart because they have different causes
 * (the run never happened vs. the run measured nothing).
 */
export type CoverageSnapshot = readonly CoverageRecord[] | null;

export type CoverageDeltaInconclusiveReason =
  | 'baseline-missing'
  | 'candidate-missing'
  | 'baseline-empty'
  | 'candidate-empty';

export interface NewlyCoveredFile {
  readonly file: string;
  /** Ascending line numbers that went from unhit (or absent) to hit. */
  readonly lines: readonly number[];
}

export interface CoverageDelta {
  /** Executable lines that went from unhit-or-absent in baseline to hit. */
  readonly newlyCoveredLines: number;
  readonly newlyCoveredByFile: readonly NewlyCoveredFile[];
  /**
   * Lines hit in baseline that are present-but-unhit in the candidate run.
   * A line merely ABSENT from the candidate is NOT counted here — absence is a
   * measurement gap, not a regression, and conflating them would invent
   * regressions out of files the candidate run did not instrument.
   */
  readonly regressedLines: number;
  /** Baseline-hit lines the candidate run did not measure at all. */
  readonly unmeasuredInCandidate: number;
  readonly baselineFiles: number;
  readonly candidateFiles: number;
  /** Union of executable lines seen across both snapshots. */
  readonly measuredLines: number;
  /**
   * Whether the delta means anything. False ⇒ `newlyCoveredLines === 0` says
   * "we could not tell", NEVER "the test raised no coverage".
   */
  readonly conclusive: boolean;
  readonly inconclusiveReason: CoverageDeltaInconclusiveReason | null;
}

function indexSnapshot(snapshot: readonly CoverageRecord[]): Map<string, ReadonlyMap<number, number>> {
  const byFile = new Map<string, ReadonlyMap<number, number>>();
  for (const record of snapshot) {
    const existing = byFile.get(record.sourceFile);
    if (!existing) {
      byFile.set(record.sourceFile, record.lines);
      continue;
    }
    // Duplicate records for one file: merge by taking the max hit count, the
    // same union semantics lcov merging uses. A line hit by either run is hit.
    const merged = new Map(existing);
    for (const [line, hits] of record.lines) {
      merged.set(line, Math.max(merged.get(line) ?? 0, hits));
    }
    byFile.set(record.sourceFile, merged);
  }
  return byFile;
}

function inconclusiveDelta(
  reason: CoverageDeltaInconclusiveReason,
  baselineFiles: number,
  candidateFiles: number,
): CoverageDelta {
  return {
    newlyCoveredLines: 0,
    newlyCoveredByFile: [],
    regressedLines: 0,
    unmeasuredInCandidate: 0,
    baselineFiles,
    candidateFiles,
    measuredLines: 0,
    conclusive: false,
    inconclusiveReason: reason,
  };
}

/**
 * Compare two coverage snapshots and report which executable lines the
 * candidate run newly reached.
 *
 * Returns an INCONCLUSIVE delta rather than a zero one whenever either snapshot
 * is missing or instrumented nothing — the distinction this whole module exists
 * to preserve.
 */
export function computeCoverageDelta(
  baseline: CoverageSnapshot,
  candidate: CoverageSnapshot,
): CoverageDelta {
  if (baseline === null) return inconclusiveDelta('baseline-missing', 0, candidate?.length ?? 0);
  if (candidate === null) return inconclusiveDelta('candidate-missing', baseline.length, 0);

  const baselineByFile = indexSnapshot(baseline);
  const candidateByFile = indexSnapshot(candidate);

  const baselineExecutable = [...baselineByFile.values()].reduce((n, lines) => n + lines.size, 0);
  const candidateExecutable = [...candidateByFile.values()].reduce((n, lines) => n + lines.size, 0);

  if (baselineExecutable === 0) {
    return inconclusiveDelta('baseline-empty', baselineByFile.size, candidateByFile.size);
  }
  if (candidateExecutable === 0) {
    return inconclusiveDelta('candidate-empty', baselineByFile.size, candidateByFile.size);
  }

  const newlyCoveredByFile: NewlyCoveredFile[] = [];
  let newlyCoveredLines = 0;
  let regressedLines = 0;
  let unmeasuredInCandidate = 0;

  for (const [file, candidateLines] of [...candidateByFile].sort((a, b) => a[0].localeCompare(b[0]))) {
    const baselineLines = baselineByFile.get(file);
    const gained: number[] = [];
    for (const [line, hits] of candidateLines) {
      if (hits <= 0) continue;
      const before = baselineLines?.get(line);
      // Absent in baseline counts as newly covered: the line is reachable now
      // and was not measured as hit before.
      if (before === undefined || before === 0) gained.push(line);
    }
    if (gained.length > 0) {
      gained.sort((a, b) => a - b);
      newlyCoveredByFile.push({ file, lines: gained });
      newlyCoveredLines += gained.length;
    }
  }

  for (const [file, baselineLines] of baselineByFile) {
    const candidateLines = candidateByFile.get(file);
    for (const [line, hits] of baselineLines) {
      if (hits <= 0) continue;
      const after = candidateLines?.get(line);
      if (after === undefined) unmeasuredInCandidate += 1;
      else if (after === 0) regressedLines += 1;
    }
  }

  const measured = new Set<string>();
  for (const [file, lines] of baselineByFile) for (const line of lines.keys()) measured.add(`${file}:${line}`);
  for (const [file, lines] of candidateByFile) for (const line of lines.keys()) measured.add(`${file}:${line}`);

  return {
    newlyCoveredLines,
    newlyCoveredByFile,
    regressedLines,
    unmeasuredInCandidate,
    baselineFiles: baselineByFile.size,
    candidateFiles: candidateByFile.size,
    measuredLines: measured.size,
    conclusive: true,
    inconclusiveReason: null,
  };
}

/** A leg's outcome. `undetermined` is never collapsed into `fail`. */
export type CoverLegStatus = 'pass' | 'fail' | 'undetermined';

export type CoverLoopDecision = 'keep' | 'discard' | 'undetermined';

export type CoverLoopDiscardReason =
  | 'build-failed'
  | 'tests-failed'
  | 'no-coverage-gain';

export interface CoverLoopLegs {
  readonly builds: CoverLegStatus;
  readonly passes: CoverLegStatus;
  readonly raisesCoverage: CoverLegStatus;
}

export interface BuildLegResult {
  /** Did the candidate compile / typecheck? `null` ⇒ the check did not run. */
  readonly ok: boolean | null;
  readonly detail?: string;
}

export interface TestLegResult {
  /**
   * Did the candidate test pass? `null` ⇒ not run or not determinable.
   *
   * ⚠ A runner that matched ZERO tests must report `null`, never `true`: a
   * vacuous green is the exact shape this loop is meant to reject.
   */
  readonly ok: boolean | null;
  readonly testsRun?: number;
  readonly detail?: string;
}

export interface CoverLoopVerdict {
  readonly decision: CoverLoopDecision;
  readonly legs: CoverLoopLegs;
  readonly delta: CoverageDelta | null;
  readonly discardReason: CoverLoopDiscardReason | null;
  /** Why the decision came out this way, in one line. */
  readonly reason: string;
  /** What was NOT measured, and why — the coverage report on the verdict. */
  readonly notes: readonly string[];
}

export interface JudgeCoverLoopInput {
  readonly build: BuildLegResult;
  readonly tests: TestLegResult;
  readonly baseline: CoverageSnapshot;
  readonly candidate: CoverageSnapshot;
}

/**
 * The pure keep/discard judgement. All three legs are reported independently —
 * they are never collapsed to a boolean, because "passed" alone must not be
 * sufficient to keep a generated test.
 *
 * A leg that could not run reports `undetermined` and pushes a note saying so,
 * rather than borrowing the verdict of a leg that did run.
 */
export function judgeCoverLoop(input: JudgeCoverLoopInput): CoverLoopVerdict {
  const notes: string[] = [];

  const builds: CoverLegStatus =
    input.build.ok === null ? 'undetermined' : input.build.ok ? 'pass' : 'fail';
  if (builds === 'undetermined') {
    notes.push(`build leg not determined${input.build.detail ? `: ${input.build.detail}` : ''}`);
  }

  if (builds === 'fail') {
    return {
      decision: 'discard',
      legs: { builds, passes: 'undetermined', raisesCoverage: 'undetermined' },
      delta: null,
      discardReason: 'build-failed',
      reason: `candidate does not build${input.build.detail ? `: ${input.build.detail}` : ''}`,
      notes: [...notes, 'tests not run: build failed', 'coverage not measured: build failed'],
    };
  }
  if (builds === 'undetermined') {
    return {
      decision: 'undetermined',
      legs: { builds, passes: 'undetermined', raisesCoverage: 'undetermined' },
      delta: null,
      discardReason: null,
      reason: 'cannot judge: the build leg did not run, so neither later leg is meaningful',
      notes: [...notes, 'tests not run: build undetermined', 'coverage not measured: build undetermined'],
    };
  }

  const passes: CoverLegStatus =
    input.tests.ok === null ? 'undetermined' : input.tests.ok ? 'pass' : 'fail';
  if (passes === 'undetermined') {
    notes.push(`test leg not determined${input.tests.detail ? `: ${input.tests.detail}` : ''}`);
  }
  if (passes === 'pass' && input.tests.testsRun === 0) {
    // A runner reporting ok with zero tests measured nothing; refuse to treat
    // that as a pass regardless of what it claimed.
    return {
      decision: 'undetermined',
      legs: { builds, passes: 'undetermined', raisesCoverage: 'undetermined' },
      delta: null,
      discardReason: null,
      reason: 'cannot judge: the test run matched zero tests, so its green is vacuous',
      notes: [...notes, 'test leg reported ok with testsRun=0', 'coverage not measured: test leg vacuous'],
    };
  }

  if (passes === 'fail') {
    return {
      decision: 'discard',
      legs: { builds, passes, raisesCoverage: 'undetermined' },
      delta: null,
      discardReason: 'tests-failed',
      reason: `candidate test does not pass${input.tests.detail ? `: ${input.tests.detail}` : ''}`,
      notes: [...notes, 'coverage not measured: test leg failed'],
    };
  }
  if (passes === 'undetermined') {
    return {
      decision: 'undetermined',
      legs: { builds, passes, raisesCoverage: 'undetermined' },
      delta: null,
      discardReason: null,
      reason: 'cannot judge: the test leg did not run',
      notes: [...notes, 'coverage not measured: test leg undetermined'],
    };
  }

  const delta = computeCoverageDelta(input.baseline, input.candidate);

  if (!delta.conclusive) {
    notes.push(`coverage delta inconclusive: ${delta.inconclusiveReason}`);
    return {
      decision: 'undetermined',
      legs: { builds, passes, raisesCoverage: 'undetermined' },
      delta,
      discardReason: null,
      reason:
        `candidate builds and passes, but the coverage delta could not be measured ` +
        `(${delta.inconclusiveReason}) — this is NOT a zero delta`,
      notes,
    };
  }

  if (delta.regressedLines > 0) {
    notes.push(`${delta.regressedLines} line(s) covered in baseline are unhit in the candidate run`);
  }
  if (delta.unmeasuredInCandidate > 0) {
    notes.push(
      `${delta.unmeasuredInCandidate} baseline-hit line(s) were not instrumented in the candidate run`,
    );
  }

  if (delta.newlyCoveredLines === 0) {
    return {
      decision: 'discard',
      legs: { builds, passes, raisesCoverage: 'fail' },
      delta,
      discardReason: 'no-coverage-gain',
      reason:
        'candidate builds and passes but reaches no line the suite did not already cover ' +
        `(measured ${delta.measuredLines} executable line(s))`,
      notes,
    };
  }

  return {
    decision: 'keep',
    legs: { builds, passes, raisesCoverage: 'pass' },
    delta,
    discardReason: null,
    reason:
      `candidate builds, passes, and newly covers ${delta.newlyCoveredLines} line(s) ` +
      `across ${delta.newlyCoveredByFile.length} file(s)`,
    notes,
  };
}

/**
 * Did this verdict actually measure what it claims?
 *
 * Gate every keep/discard action on this. A verdict with `decision:'discard'`
 * is trustworthy; one with `decision:'undetermined'` means the loop could not
 * tell and the candidate needs re-running, not throwing away.
 */
export function isCoverLoopVerdictConclusive(verdict: CoverLoopVerdict): boolean {
  return verdict.decision !== 'undetermined';
}

/** One-line human summary, for logs and work-item evidence. */
export function describeCoverLoopVerdict(verdict: CoverLoopVerdict): string {
  const legs =
    `builds=${verdict.legs.builds} passes=${verdict.legs.passes} ` +
    `raisesCoverage=${verdict.legs.raisesCoverage}`;
  const gain = verdict.delta?.conclusive ? ` +${verdict.delta.newlyCoveredLines} line(s)` : '';
  return `${verdict.decision.toUpperCase()} [${legs}]${gain} — ${verdict.reason}`;
}

/** Injected runners — nothing in this module shells out or touches a database. */
export interface CoverLoopRunners<TCandidate> {
  /** Compile/typecheck the candidate. */
  readonly build: (candidate: TCandidate) => Promise<BuildLegResult>;
  /** Run the candidate test. Must report `ok:null` if it matched zero tests. */
  readonly runTests: (candidate: TCandidate) => Promise<TestLegResult>;
  /** Coverage WITHOUT the candidate applied. */
  readonly baselineCoverage: (candidate: TCandidate) => Promise<CoverageSnapshot>;
  /** Coverage WITH the candidate applied. */
  readonly candidateCoverage: (candidate: TCandidate) => Promise<CoverageSnapshot>;
}

/**
 * Run the loop for one candidate: build → pass → raises-coverage → verdict.
 *
 * Legs run in order and STOP at the first one that settles the verdict, so a
 * candidate that does not build never pays for a coverage run. A runner that
 * throws is reported as an undetermined leg, never as a failure — an exception
 * says the measurement broke, not that the candidate is bad.
 */
export async function runCoverLoop<TCandidate>(
  candidate: TCandidate,
  runners: CoverLoopRunners<TCandidate>,
): Promise<CoverLoopVerdict> {
  const build = await settle(() => runners.build(candidate), (detail) => ({ ok: null, detail }));
  if (build.ok !== true) {
    return judgeCoverLoop({ build, tests: { ok: null }, baseline: null, candidate: null });
  }

  const tests = await settle(() => runners.runTests(candidate), (detail) => ({ ok: null, detail }));
  if (tests.ok !== true || tests.testsRun === 0) {
    return judgeCoverLoop({ build, tests, baseline: null, candidate: null });
  }

  const baseline = await settle(() => runners.baselineCoverage(candidate), () => null);
  const candidateSnapshot = await settle(() => runners.candidateCoverage(candidate), () => null);

  return judgeCoverLoop({ build, tests, baseline, candidate: candidateSnapshot });
}

async function settle<T>(run: () => Promise<T>, onError: (detail: string) => T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    return onError(err instanceof Error ? err.message : String(err));
  }
}
