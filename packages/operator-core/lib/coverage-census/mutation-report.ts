/**
 * Stryker mutation-report adapter — the engine half of plan
 * `design-to-code-coverage-seam-2026-09-02` P-011.
 *
 * ## The seam this module deliberately stops at (D-039 §4)
 *
 * This module owns exactly one direction: a Stryker `mutation.json` report
 * (the mutation-testing-elements schema) → **mutation lethality FACTS**.
 *
 * It does NOT:
 *  - decide which rubric criterion a test binds to,
 *  - emit spec evidence, or
 *  - extend the rubric criterion-check contract.
 *
 * Those belong to `deterministic-coverage-census-2026-08-17` P-016, whose own text
 * extends the existing `check:{kind:'tests'}` binding rather than adding a new kind
 * (D-038 §3). P-011's job is to supply the missing PRODUCER of `mutation` evidence —
 * `'mutation'` is already a member of `SPEC_EVIDENCE_KINDS` and `bindSpecEvidence`
 * already accepts it, so no new plumbing is required downstream. Crossing this seam
 * here would fork the contract census P-006 established.
 *
 * ## Why parse the JSON report rather than stdout — this is not a style preference
 *
 * Stryker's clear-text reporter prints per-test kill counts (`(killed 68)`), which is
 * tempting to scrape. It CANNOT answer the question this module exists to answer, and
 * it fails silently in the direction that looks like good news.
 *
 * Measured (WI-2142121, `@papercusp/publish-auth`, 401 mutants, 54 tests):
 *  - clear-text "All tests" entries: **29**
 *  - non-lethal bindings, from the JSON report: **25**
 *  - 29 + 25 = 54 = the suite's own "Ran 54 tests".
 *
 * The clear-text block lists ONLY tests that killed something. A test that kills nothing
 * is never printed as `(killed 0)` — it is omitted entirely. So `grep 'killed 0)'` over
 * stdout returns 0 on a suite with 25 non-lethal bindings, and that zero is
 * indistinguishable from a genuinely clean result. This exact false reading was made,
 * published to a plan Decision, and retracted (D-039 §3 → D-041). Do not reintroduce it.
 *
 * The `json` reporter carries the `killedBy` / `coveredBy` test-id arrays, which is what
 * lets this module separate three states the clear-text output conflates into one:
 * killed something · covered mutants but killed none · never ran the code at all.
 *
 * Report shape observed: `schemaVersion: "1.0"`, statuses
 * `Killed | Survived | Timeout | NoCoverage`.
 */

/**
 * Mutant statuses in the mutation-testing-elements schema.
 *
 * Only the first four participate in scoring; the rest describe mutants that never
 * produced a verdict (see {@link SCORED_STATUSES}).
 */
export const MUTANT_STATUSES = [
  'Killed',
  'Survived',
  'NoCoverage',
  'Timeout',
  'CompileError',
  'RuntimeError',
  'Ignored',
  'Pending',
] as const;

export type MutantStatus = (typeof MUTANT_STATUSES)[number];

/**
 * Statuses that count toward a mutation score.
 *
 * `CompileError` / `RuntimeError` / `Ignored` / `Pending` are EXCLUDED — a mutant that
 * never produced a verdict is not evidence either way, and folding it in as a miss
 * would understate the score for reasons that have nothing to do with test quality.
 */
export const SCORED_STATUSES: readonly MutantStatus[] = [
  'Killed',
  'Timeout',
  'Survived',
  'NoCoverage',
];

/** Statuses that mean the test suite actually caught the mutant. */
export const DETECTED_STATUSES: readonly MutantStatus[] = ['Killed', 'Timeout'];

export interface MutationReportMutant {
  id: string;
  mutatorName?: string;
  status: MutantStatus;
  /** Test ids that killed this mutant. Empty/absent for a survivor. */
  killedBy?: string[];
  /** Test ids that executed the mutated code, whether or not they killed it. */
  coveredBy?: string[];
  static?: boolean;
}

export interface MutationReportFile {
  language?: string;
  source?: string;
  mutants: MutationReportMutant[];
}

export interface MutationReportTest {
  id: string;
  name: string;
}

export interface MutationReportTestFile {
  tests: MutationReportTest[];
}

export interface MutationReport {
  schemaVersion?: string;
  files: Record<string, MutationReportFile>;
  testFiles?: Record<string, MutationReportTestFile>;
}

export interface LethalityCounts {
  /** Mutants the suite caught (Killed + Timeout). */
  detected: number;
  killed: number;
  timeout: number;
  survived: number;
  noCoverage: number;
  /** Mutants excluded from scoring (compile/runtime error, ignored, pending). */
  unscored: number;
  /** detected + survived + noCoverage — the denominator of {@link mutationScore}. */
  scored: number;
  /**
   * `(detected / scored) * 100`, rounded to 2dp.
   *
   * **`null` when `scored === 0`.** A zero here would be indistinguishable from a
   * genuinely terrible score, when the truth is "nothing was measured" — the same
   * false-zero failure mode this repo hits repeatedly with vacuous test passes. Callers
   * must branch on `null` rather than treating it as 0.
   */
  mutationScore: number | null;
  /**
   * `(detected / (detected + survived)) * 100` — the score over COVERED mutants only,
   * excluding `NoCoverage`. Stryker reports this alongside the total; it separates
   * "the tests are weak" from "the code is untested". `null` when the denominator is 0.
   */
  coveredScore: number | null;
}

export interface FileLethality extends LethalityCounts {
  /** Report-relative file path, exactly as the report keys it. */
  file: string;
}

export interface TestLethality {
  testId: string;
  /** Test name from the report's `testFiles` map, or `null` if unresolvable. */
  name: string | null;
  /** Mutants this test killed. */
  killedCount: number;
  /** Mutants this test executed, whether or not it killed them. */
  coveredCount: number;
  /**
   * `true` when this test killed at least one mutant.
   *
   * This is census P-016's binding predicate: "scoped mutation over the surface's
   * implementing files must kill >=1 bound test".
   */
  lethal: boolean;
}

/** Thrown when a report cannot be trusted to describe a real run. */
export class MutationReportError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10000) / 100;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/**
 * Validate and narrow a parsed `mutation.json`.
 *
 * REFUSES a report describing zero files rather than returning an empty summary that
 * a caller would read as "measured, and clean". An empty report is the mutation-testing
 * analogue of a test run that matched zero files: it is an UNDETERMINED result, and the
 * only safe thing to do with it is fail loudly.
 */
export function parseMutationReport(raw: unknown): MutationReport {
  if (!isRecord(raw)) {
    throw new MutationReportError('mutation report is not an object');
  }
  if (!isRecord(raw.files)) {
    throw new MutationReportError('mutation report has no `files` map');
  }

  const files: Record<string, MutationReportFile> = {};
  for (const [path, entry] of Object.entries(raw.files)) {
    if (!isRecord(entry) || !Array.isArray(entry.mutants)) {
      throw new MutationReportError(`mutation report file "${path}" has no mutants array`);
    }
    files[path] = {
      language: typeof entry.language === 'string' ? entry.language : undefined,
      // `source` MUST be preserved: it is the only input `toMutationEvidenceRecords`
      // can hand to a caller's `fingerprintFor`. Dropping it here silently degrades
      // every fingerprint to a hash of `undefined` — identical across all files, so
      // freshness comparison would treat every surface as unchanged forever. Regression
      // guard: 'preserves file source through the parse path'.
      source: typeof entry.source === 'string' ? entry.source : undefined,
      mutants: entry.mutants.filter(isRecord).map((m) => ({
        id: String(m.id ?? ''),
        mutatorName: typeof m.mutatorName === 'string' ? m.mutatorName : undefined,
        status: (MUTANT_STATUSES as readonly string[]).includes(String(m.status))
          ? (m.status as MutantStatus)
          : 'Pending',
        killedBy: asStringArray(m.killedBy),
        coveredBy: asStringArray(m.coveredBy),
        static: m.static === true,
      })),
    };
  }

  if (Object.keys(files).length === 0) {
    throw new MutationReportError(
      'mutation report describes ZERO files — undetermined, not clean. ' +
        'Check the `mutate` glob and that the run actually executed.',
    );
  }

  const testFiles: Record<string, MutationReportTestFile> = {};
  if (isRecord(raw.testFiles)) {
    for (const [path, entry] of Object.entries(raw.testFiles)) {
      if (!isRecord(entry) || !Array.isArray(entry.tests)) continue;
      testFiles[path] = {
        tests: entry.tests
          .filter(isRecord)
          .map((t) => ({ id: String(t.id ?? ''), name: String(t.name ?? '') })),
      };
    }
  }

  return {
    schemaVersion: typeof raw.schemaVersion === 'string' ? raw.schemaVersion : undefined,
    files,
    testFiles: Object.keys(testFiles).length > 0 ? testFiles : undefined,
  };
}

function countMutants(mutants: readonly MutationReportMutant[]): LethalityCounts {
  let killed = 0;
  let timeout = 0;
  let survived = 0;
  let noCoverage = 0;
  let unscored = 0;

  for (const m of mutants) {
    switch (m.status) {
      case 'Killed':
        killed += 1;
        break;
      case 'Timeout':
        timeout += 1;
        break;
      case 'Survived':
        survived += 1;
        break;
      case 'NoCoverage':
        noCoverage += 1;
        break;
      default:
        unscored += 1;
        break;
    }
  }

  const detected = killed + timeout;
  const scored = detected + survived + noCoverage;

  return {
    detected,
    killed,
    timeout,
    survived,
    noCoverage,
    unscored,
    scored,
    mutationScore: pct(detected, scored),
    coveredScore: pct(detected, detected + survived),
  };
}

/** Per-file lethality, in report order. */
export function fileLethality(report: MutationReport): FileLethality[] {
  return Object.entries(report.files).map(([file, entry]) => ({
    file,
    ...countMutants(entry.mutants),
  }));
}

/** Whole-report lethality, across every file. */
export function overallLethality(report: MutationReport): LethalityCounts {
  return countMutants(Object.values(report.files).flatMap((f) => f.mutants));
}

function testNames(report: MutationReport): Map<string, string> {
  const names = new Map<string, string>();
  for (const tf of Object.values(report.testFiles ?? {})) {
    for (const t of tf.tests) names.set(t.id, t.name);
  }
  return names;
}

/**
 * Per-test lethality: how many mutants each test killed, and how many it merely covered.
 *
 * Only tests that appear in some mutant's `killedBy`/`coveredBy` are returned — a test
 * the report never associates with a mutant has no lethality signal here at all, which
 * is a different (and quieter) condition than being non-lethal.
 */
export function testLethality(report: MutationReport): TestLethality[] {
  const names = testNames(report);
  const killed = new Map<string, number>();
  const covered = new Map<string, number>();

  for (const file of Object.values(report.files)) {
    for (const m of file.mutants) {
      for (const id of m.killedBy ?? []) killed.set(id, (killed.get(id) ?? 0) + 1);
      for (const id of m.coveredBy ?? []) covered.set(id, (covered.get(id) ?? 0) + 1);
    }
  }

  const ids = new Set([...killed.keys(), ...covered.keys()]);
  return [...ids]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((testId) => {
      const killedCount = killed.get(testId) ?? 0;
      return {
        testId,
        name: names.get(testId) ?? null,
        killedCount,
        coveredCount: covered.get(testId) ?? 0,
        lethal: killedCount > 0,
      };
    });
}

/**
 * Census P-016's flag condition: tests that EXECUTE mutated code but kill nothing.
 *
 * A non-lethal binding is a test that runs the implementation without pinning its
 * behaviour — the exact failure mutation testing exists to surface, and the one a
 * line-coverage number cannot see. Tests with zero coverage are deliberately NOT
 * included: they are untested-surface evidence, not weak-assertion evidence.
 */
export function nonLethalTests(report: MutationReport): TestLethality[] {
  return testLethality(report).filter((t) => !t.lethal && t.coveredCount > 0);
}

/**
 * One `mutation` spec-evidence record, ready to hand to `bindSpecEvidence`.
 *
 * Deliberately NOT the full `BindSpecEvidenceInput`: the caller still supplies the
 * identity half (`workItemId`, `planSlug`/`specId`, `actorId`), because that is the
 * binding context this module has no business inventing.
 */
export interface MutationEvidenceRecord {
  evidenceKind: 'mutation';
  /** Stable per-surface reference: `mutation:<file path as the report keys it>`. */
  evidenceRef: string;
  sourceFingerprint: string;
  /** Counts + the non-lethal triage list, for the evidence row's `details`. */
  details: {
    mutationScore: number | null;
    coveredScore: number | null;
    detected: number;
    survived: number;
    noCoverage: number;
    scored: number;
    unscored: number;
    nonLethalTestNames: string[];
  };
}

export interface MutationEvidenceOptions {
  /**
   * Supplies the `sourceFingerprint` for a mutated file.
   *
   * **Why this is a callback and not computed here.** `sourceFingerprint` is validated
   * repo-wide as nothing more than `z.string().trim().min(1).max(256)` (measured across
   * bind-spec-evidence.ts, get-spec-evidence.ts and evaluate-spec-test-adequacy.ts —
   * three independent copies of the same opaque shape), and there is NO shared helper
   * that computes one. So there is no existing convention to match.
   *
   * That makes the fingerprint scheme a CONTRACT decision, not an implementation detail:
   * whatever goes here is what `get-spec-evidence` later compares to decide "current"
   * versus "stale". Inventing one inside this module would quietly define freshness
   * semantics for the census consumer (D-039 §4 puts that on the consumer's side of the
   * seam), and a wrong guess would fail in the worst direction — evidence that silently
   * reads as current forever, or as stale forever.
   */
  fingerprintFor: (file: string, source: string | undefined) => string;
}

/**
 * Map a parsed report to one `mutation` evidence record per mutated FILE.
 *
 * File granularity matches census P-016's framing ("scoped mutation over the surface's
 * IMPLEMENTING FILES"), and matches how the census already resolves scope by
 * `sourceFiles`. Records are returned, never written — the caller performs the
 * `bindSpecEvidence` write with its own identity fields.
 */
export function toMutationEvidenceRecords(
  report: MutationReport,
  opts: MutationEvidenceOptions,
): MutationEvidenceRecord[] {
  const nonLethalNames = nonLethalTests(report)
    .map((t) => t.name ?? t.testId)
    .sort((a, b) => a.localeCompare(b));

  return fileLethality(report).map((f) => ({
    evidenceKind: 'mutation' as const,
    evidenceRef: `mutation:${f.file}`,
    sourceFingerprint: opts.fingerprintFor(f.file, report.files[f.file]?.source),
    details: {
      mutationScore: f.mutationScore,
      coveredScore: f.coveredScore,
      detected: f.detected,
      survived: f.survived,
      noCoverage: f.noCoverage,
      scored: f.scored,
      unscored: f.unscored,
      // Report-wide, not per-file: a test's lethality is a property of the test across
      // every mutant it touched, so slicing it per file would misreport a test that
      // kills in one file and merely covers another.
      nonLethalTestNames: nonLethalNames,
    },
  }));
}
