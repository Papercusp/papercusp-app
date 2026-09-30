/**
 * aggregateJUnitCases — the pure JUnit rollup (P-012 data layer of
 * testing-shell-cross-project-2026-06-01).
 *
 * JUnit XML is what both vitest and playwright emit in CI, and Restart's
 * /tests page is exactly a JUnit aggregator. This module is the shared
 * rollup both projects can use. It is deliberately dependency-free and
 * fs-free: each consumer's backend reads the junit.xml files and parses
 * them (with fast-xml-parser, which the lib must NOT pull in — it has zero
 * runtime deps and ships into a browser SPA), then hands the normalized
 * cases here for the rollup. Pure: no fs, no Date, no mutation.
 */

export type JUnitStatus = 'passed' | 'failed' | 'skipped' | 'errored';

/** One `<testcase>`, normalized by the consumer's parser. */
export interface JUnitCase {
  /** Workspace/dir owning the junit.xml, relative to the scan root. */
  project: string;
  /** Path to the junit.xml file, relative to the scan root (the rollup key). */
  file: string;
  /** `<testsuite name>`. */
  suite: string;
  /** `<testcase name>`. */
  test: string;
  status: JUnitStatus;
  /** `<testcase time>` in seconds. */
  durationSec: number;
  /** Failure/error message snippet, if any. */
  failure?: string;
  /** File mtime (ms), if the consumer tracked it. */
  ts?: number;
}

/** Per-file (= per junit.xml = one project run) rollup. */
export interface JUnitFileSummary {
  project: string;
  file: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  durationSec: number;
}

export interface JUnitAggregate {
  files: JUnitFileSummary[];
  totals: {
    files: number;
    cases: number;
    passed: number;
    failed: number;
    skipped: number;
    errored: number;
    durationSec: number;
  };
}

function emptySummary(project: string, file: string): JUnitFileSummary {
  return { project, file, total: 0, passed: 0, failed: 0, skipped: 0, errored: 0, durationSec: 0 };
}

/**
 * Roll a flat list of JUnit cases up into per-file summaries + grand totals.
 * Files preserve first-seen order. Pure — never mutates the input.
 */
export function aggregateJUnitCases(cases: JUnitCase[]): JUnitAggregate {
  const byFile = new Map<string, JUnitFileSummary>();
  const totals = { files: 0, cases: 0, passed: 0, failed: 0, skipped: 0, errored: 0, durationSec: 0 };

  for (const c of cases) {
    let row = byFile.get(c.file);
    if (!row) {
      row = emptySummary(c.project, c.file);
      byFile.set(c.file, row);
    }
    row.total += 1;
    row[c.status] += 1;
    row.durationSec += c.durationSec;

    totals.cases += 1;
    totals[c.status] += 1;
    totals.durationSec += c.durationSec;
  }

  const files = [...byFile.values()];
  totals.files = files.length;
  return { files, totals };
}
