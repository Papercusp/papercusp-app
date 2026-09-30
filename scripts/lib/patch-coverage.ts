// scripts/lib/patch-coverage.ts
//
// P-009 (design-to-code-coverage-seam-2026-09-02), part (c): decide whether the
// lines a change ADDS are covered, using the merged lcov from part (b).
//
// Plan decision D-028 rules this is computed in JS rather than by adopting the
// Python `diff_cover` package: the repo is npm-only (`only-allow npm`), no gate
// path executes Python, and the computation is one intersection of `git diff`
// added-line numbers with the merged lcov's `DA:` records.
//
// ⛔ THE ONE PROPERTY THIS MODULE MUST NEVER LOSE: IT MUST NOT PASS VACUOUSLY.
//
// A patch-coverage gate fed by an absent or partial lcov does not fail — it
// reports 100% and goes green, because "no coverage data" and "no uncovered
// changed lines" are the same observation unless you distinguish them
// deliberately. That is the exact defect `lint:vacuous-negatives` and
// `packages/operator-core/lib/doc-claims/coverage-wiring.test.ts` exist to
// catch, and it is why WI-2142119's stated premise ("fed by the lcov P-007
// emits") had to be corrected before any code was written: P-007 built no
// producer, so a gate built on that premise would have measured nothing.
//
// So the verdict is THREE-VALUED, not two. `undetermined` is a distinct,
// non-passing outcome for:
//   • an empty coverage index (nothing ran with `--coverage`), and
//   • a changed coverable file that appears in NO coverage record — which
//     cannot be reported as 0% (a false RED for a file no suite instruments)
//     nor as covered (the vacuous pass). It is named instead.
//
// A line the diff adds that the lcov does not list as executable (a comment, a
// blank line, a type-only declaration) is excluded from the DENOMINATOR, not
// counted as uncovered — that is standard patch-coverage semantics and is what
// keeps a docs-heavy diff from failing a gate about tests.

import type { LcovRecord } from './lcov-merge.ts';

export type PatchCoverageStatus = 'pass' | 'fail' | 'undetermined' | 'no-coverable-lines';

export interface UncoveredLine {
  file: string;
  line: number;
}

export interface PatchCoverageVerdict {
  status: PatchCoverageStatus;
  /** Covered / (covered + uncovered) as a percentage, or null when nothing was measurable. */
  percent: number | null;
  coveredLines: number;
  uncoveredLines: number;
  uncovered: UncoveredLine[];
  /** Changed files considered coverable source. */
  filesConsidered: string[];
  /**
   * Coverable changed files with NO record in the merged lcov. Non-empty ⇒
   * `undetermined`: we cannot tell "never instrumented" from "not covered".
   */
  filesWithoutCoverageData: string[];
  /** Changed files skipped as non-source (tests, docs, sql, generated). */
  filesSkipped: string[];
  thresholdPct: number;
  /** Human-readable statements of what was and was not measured. */
  notes: string[];
}

/** Extensions v8 coverage can instrument in this repo. */
const COVERABLE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Directories whose contents are never the subject of a coverage gate. */
const EXCLUDED_SEGMENTS = [
  'node_modules',
  'dist',
  'build',
  '.next',
  '.papercusp',
  '_retired',
  'coverage',
];

/**
 * Is this changed path a source file whose added lines a coverage gate should
 * judge? Tests, declarations and generated declaration sidecars are excluded:
 * a test file's own lines are not the thing under test, and `.d.ts` / `.d.mts`
 * carry no executable statements at all.
 */
export function isCoverableSourcePath(path: string): boolean {
  const segments = path.split('/');
  if (segments.some((segment) => EXCLUDED_SEGMENTS.includes(segment))) return false;
  const base = segments[segments.length - 1] ?? '';
  if (/\.d\.(ts|mts|cts)$/.test(base)) return false;
  if (/\.(test|spec)\.[^.]+$/.test(base)) return false;
  return COVERABLE_EXTENSIONS.some((ext) => base.endsWith(ext));
}

/**
 * Added line numbers per file, parsed from a unified diff.
 *
 * ⚠ Generate the diff with `--unified=0`. With any context the hunk header's
 * start line still anchors correctly here (we count only `+` lines while
 * walking the hunk), but zero context keeps the parse trivially exact and the
 * output small — so the CLI passes it and this parser tolerates either.
 *
 * DELETED files are skipped (`+++ /dev/null`): a removed line cannot be covered
 * and counting it would make every deletion fail the gate.
 */
export function parseAddedLines(diffText: string): Map<string, Set<number>> {
  const added = new Map<string, Set<number>>();
  let currentFile: string | null = null;
  let nextLine = 0;

  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const target = raw.slice(4).trim();
      if (target === '/dev/null') {
        currentFile = null;
        continue;
      }
      // `+++ b/path/to/file` — strip the one-letter prefix git adds. A path with
      // no prefix (git diff --no-prefix) is taken verbatim.
      currentFile = /^[a-z]\//.test(target) ? target.slice(2) : target;
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('diff --git ')) continue;
    if (raw.startsWith('@@')) {
      // @@ -oldStart,oldCount +newStart,newCount @@
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      nextLine = match ? Number(match[1]) : 0;
      continue;
    }
    if (currentFile === null || nextLine === 0) continue;

    if (raw.startsWith('+')) {
      let lines = added.get(currentFile);
      if (!lines) {
        lines = new Set<number>();
        added.set(currentFile, lines);
      }
      lines.add(nextLine);
      nextLine += 1;
    } else if (raw.startsWith('-') || raw.startsWith('\\')) {
      // A removed line does not advance the NEW-file cursor; `\ No newline at
      // end of file` belongs to whichever side precedes it and advances nothing.
    } else {
      // Context line (present when the caller did not pass --unified=0).
      nextLine += 1;
    }
  }
  return added;
}

export interface JudgeInput {
  /** Added lines per repo-root-relative path, from `parseAddedLines`. */
  changed: Map<string, Set<number>>;
  /** Merged coverage, keyed by repo-root-relative path. */
  coverage: Map<string, LcovRecord>;
  /** Percentage of changed executable lines that must be covered. */
  thresholdPct: number;
}

export function judgePatchCoverage(input: JudgeInput): PatchCoverageVerdict {
  const filesConsidered: string[] = [];
  const filesSkipped: string[] = [];
  const filesWithoutCoverageData: string[] = [];
  const uncovered: UncoveredLine[] = [];
  const notes: string[] = [];
  let coveredLines = 0;

  for (const file of [...input.changed.keys()].sort()) {
    if (!isCoverableSourcePath(file)) {
      filesSkipped.push(file);
      continue;
    }
    filesConsidered.push(file);

    const record = input.coverage.get(file);
    if (!record) {
      filesWithoutCoverageData.push(file);
      continue;
    }
    for (const line of [...(input.changed.get(file) ?? [])].sort((a, b) => a - b)) {
      const hits = record.lines.get(line);
      // Not listed in DA: not an executable line — excluded from the denominator.
      if (hits === undefined) continue;
      if (hits > 0) coveredLines += 1;
      else uncovered.push({ file, line });
    }
  }

  const uncoveredLines = uncovered.length;
  const measured = coveredLines + uncoveredLines;
  const percent = measured > 0 ? (coveredLines / measured) * 100 : null;

  const base = {
    percent,
    coveredLines,
    uncoveredLines,
    uncovered,
    filesConsidered,
    filesWithoutCoverageData,
    filesSkipped,
    thresholdPct: input.thresholdPct,
  };

  // ── The non-vacuity checks, in the order that keeps each one honest ──
  if (input.coverage.size === 0) {
    notes.push(
      'The merged coverage index is EMPTY — no workspace ran with `--coverage`, so nothing ' +
        'was measured. Reported as UNDETERMINED rather than 100%: an absent lcov and a fully ' +
        'covered patch are indistinguishable unless they are named apart. ' +
        'Run `npm run test:affected -- --coverage --changed-paths <paths>` then `npm run coverage:merge`.',
    );
    return { ...base, status: 'undetermined', notes };
  }

  if (filesWithoutCoverageData.length > 0) {
    notes.push(
      `${filesWithoutCoverageData.length} changed source file(s) appear in NO coverage record: ` +
        `${filesWithoutCoverageData.join(', ')}. That is UNDETERMINED, not 0% and not covered — ` +
        'no suite in the merged run instrumented them. Widen the coverage run to the workspace ' +
        'that owns them, or add a test that reaches them.',
    );
    return { ...base, status: 'undetermined', notes };
  }

  if (filesConsidered.length === 0) {
    notes.push(
      'No coverable source files changed (only tests, docs, config or generated files). ' +
        'Nothing for a patch-coverage gate to judge.',
    );
    return { ...base, status: 'no-coverable-lines', notes };
  }

  if (measured === 0) {
    notes.push(
      `${filesConsidered.length} source file(s) changed, but none of the added lines are ` +
        'executable statements (comments, types, blank lines). Reported explicitly rather than ' +
        'as 100%, so a green result is never mistaken for measured coverage.',
    );
    return { ...base, status: 'no-coverable-lines', notes };
  }

  notes.push(
    `${coveredLines}/${measured} added executable lines covered across ` +
      `${filesConsidered.length} file(s).`,
  );
  return {
    ...base,
    status: (percent ?? 0) >= input.thresholdPct ? 'pass' : 'fail',
    notes,
  };
}

/** One-line human summary — the line a gate log should carry. */
export function formatVerdictLine(verdict: PatchCoverageVerdict): string {
  const pct = verdict.percent === null ? 'n/a' : `${verdict.percent.toFixed(2)}%`;
  return (
    `PATCH_COVERAGE status=${verdict.status} percent=${pct} ` +
    `covered=${verdict.coveredLines} uncovered=${verdict.uncoveredLines} ` +
    `files=${verdict.filesConsidered.length} unmeasured=${verdict.filesWithoutCoverageData.length} ` +
    `threshold=${verdict.thresholdPct}%`
  );
}
