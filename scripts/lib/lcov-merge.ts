// scripts/lib/lcov-merge.ts
//
// P-009 (design-to-code-coverage-seam-2026-09-02), part (b): aggregate the
// per-workspace `./coverage/lcov.info` files a `--coverage` run produces into a
// single repo-root-relative report.
//
// WHY THIS EXISTS AS ITS OWN MODULE. `scripts/merge-coverage.ts` is a CLI that
// walks the filesystem; the parsing/merging is pure and is the part that can be
// wrong in ways nobody notices. Split out (mirroring `./empty-suite-guard.mjs`)
// so it is unit-testable against fixtures without a real coverage run.
//
// THE PATH PROBLEM, MEASURED. Vitest's v8 provider writes `SF:` entries RELATIVE
// TO THE VITEST ROOT, which for this repo is the workspace directory. Measured
// 2026-09-02 by running `npx vitest run --coverage src/mock-sql.test.ts` in
// `libs/test-config`:
//
//     SF:src/console-noise-filter.ts
//
// — not `libs/test-config/src/console-noise-filter.ts`, and not an absolute
// path. Concatenating two workspaces' lcov files therefore produces a report
// whose paths collide (`src/index.ts` from four packages) and match nothing a
// `git diff` names. Every record must be re-anchored to the repo root first.
// Absolute `SF:` entries are also accepted, because that is what a differently
// rooted config would emit and silently dropping them would under-report.
//
// DUPLICATE SOURCE FILES ARE SUMMED, NOT OVERWRITTEN. A shared lib exercised by
// two workspaces legitimately appears in both reports; taking the last one seen
// would discard real coverage and turn a covered line into an uncovered one —
// a false RED in the gate downstream. Hit counts add; the summary counters
// (LF/LH/FNF/FNH/BRF/BRH) are RECOMPUTED from the merged data rather than
// summed, because summing two overlapping records double-counts the file.

import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface LcovFunction {
  /** Line the function is declared on. */
  line: number;
  /** Times it was entered. */
  hits: number;
}

export interface LcovBranch {
  line: number;
  block: string;
  branch: string;
  /** `-` in lcov (branch never evaluated) is carried as 0. */
  taken: number;
}

export interface LcovRecord {
  /** Repo-root-relative POSIX path once `normalizeSourcePath` has run. */
  sourceFile: string;
  /** Function name -> declaration line + entry count. */
  functions: Map<string, LcovFunction>;
  /** Executable line number -> hit count. */
  lines: Map<number, number>;
  /** `line:block:branch` -> branch record. */
  branches: Map<string, LcovBranch>;
}

export interface LcovSource {
  /**
   * Directory the `SF:` paths in `text` are relative to — for a Vitest run,
   * the workspace directory. Absolute, or resolved against `repoRoot`.
   */
  workspaceDir: string;
  /** Contents of that workspace's `coverage/lcov.info`. */
  text: string;
}

export interface MergeStats {
  /** How many `SF:` records were read across all inputs. */
  recordsRead: number;
  /** Distinct source files in the merged output. */
  filesOut: number;
  /** `SF:` entries that resolved OUTSIDE the repo root and were dropped. */
  droppedOutsideRepo: string[];
}

function emptyRecord(sourceFile: string): LcovRecord {
  return { sourceFile, functions: new Map(), lines: new Map(), branches: new Map() };
}

/**
 * Re-anchor one `SF:` value to the repo root.
 *
 * Returns a POSIX, repo-root-relative path, or `null` when the file resolves
 * outside the repo (a linked dependency, a generated temp file). `null` is
 * reported by the caller rather than silently discarded — see `MergeStats`.
 */
export function normalizeSourcePath(
  sourceFile: string,
  opts: { workspaceDir: string; repoRoot: string },
): string | null {
  const root = resolve(opts.repoRoot);
  const wsDir = isAbsolute(opts.workspaceDir)
    ? opts.workspaceDir
    : resolve(root, opts.workspaceDir);
  const abs = isAbsolute(sourceFile) ? sourceFile : resolve(wsDir, sourceFile);
  const rel = relative(root, abs);
  // `relative()` escaping upward, or landing on another drive, means outside.
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * Parse one lcov file into records, WITHOUT touching `SF:` paths — normalization
 * needs the workspace directory, which the text itself does not carry.
 *
 * Unknown directives (`TN:`, and the summary counters this module recomputes)
 * are ignored on purpose: they are derived values, and carrying a stale one
 * through a merge is exactly the drift this module exists to avoid.
 */
export function parseLcov(text: string): LcovRecord[] {
  const records: LcovRecord[] = [];
  let current: LcovRecord | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;

    if (line === 'end_of_record') {
      if (current) records.push(current);
      current = null;
      continue;
    }

    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const directive = line.slice(0, colon);
    const value = line.slice(colon + 1);

    if (directive === 'SF') {
      // A second SF without an intervening end_of_record: close the open one
      // rather than merging two files' data into a single record.
      if (current) records.push(current);
      current = emptyRecord(value);
      continue;
    }
    if (!current) continue;

    if (directive === 'FN') {
      // FN:<line>,<name> — a name may itself contain commas, so split once.
      const comma = value.indexOf(',');
      if (comma < 0) continue;
      const fnLine = Number(value.slice(0, comma));
      const name = value.slice(comma + 1);
      if (!Number.isFinite(fnLine)) continue;
      const existing = current.functions.get(name);
      current.functions.set(name, { line: fnLine, hits: existing?.hits ?? 0 });
    } else if (directive === 'FNDA') {
      // FNDA:<hits>,<name>
      const comma = value.indexOf(',');
      if (comma < 0) continue;
      const hits = Number(value.slice(0, comma));
      const name = value.slice(comma + 1);
      if (!Number.isFinite(hits)) continue;
      const existing = current.functions.get(name);
      current.functions.set(name, {
        line: existing?.line ?? 0,
        hits: (existing?.hits ?? 0) + hits,
      });
    } else if (directive === 'DA') {
      // DA:<line>,<hits>[,<checksum>] — the checksum is dropped deliberately;
      // it describes ONE workspace's copy of the source and cannot survive a
      // merge that sums two of them.
      const parts = value.split(',');
      const lineNo = Number(parts[0]);
      const hits = Number(parts[1]);
      if (!Number.isFinite(lineNo) || !Number.isFinite(hits)) continue;
      current.lines.set(lineNo, (current.lines.get(lineNo) ?? 0) + hits);
    } else if (directive === 'BRDA') {
      // BRDA:<line>,<block>,<branch>,<taken|->
      const parts = value.split(',');
      if (parts.length < 4) continue;
      const lineNo = Number(parts[0]);
      if (!Number.isFinite(lineNo)) continue;
      const [, block, branch] = parts;
      const takenRaw = parts[3];
      const taken = takenRaw === '-' ? 0 : Number(takenRaw);
      if (!Number.isFinite(taken)) continue;
      const key = `${lineNo}:${block}:${branch}`;
      const existing = current.branches.get(key);
      current.branches.set(key, {
        line: lineNo,
        block,
        branch,
        taken: (existing?.taken ?? 0) + taken,
      });
    }
  }

  // A file truncated mid-record still carries real data; keep it.
  if (current) records.push(current);
  return records;
}

/** Fold `incoming` into `into`, summing every counter. */
function foldRecord(into: LcovRecord, incoming: LcovRecord): void {
  for (const [name, fn] of incoming.functions) {
    const existing = into.functions.get(name);
    into.functions.set(name, {
      line: existing?.line || fn.line,
      hits: (existing?.hits ?? 0) + fn.hits,
    });
  }
  for (const [lineNo, hits] of incoming.lines) {
    into.lines.set(lineNo, (into.lines.get(lineNo) ?? 0) + hits);
  }
  for (const [key, branch] of incoming.branches) {
    const existing = into.branches.get(key);
    into.branches.set(key, { ...branch, taken: (existing?.taken ?? 0) + branch.taken });
  }
}

/**
 * Merge every workspace's lcov into one repo-root-relative record set.
 *
 * Records are returned sorted by source path so the emitted artifact is stable
 * across runs — a report whose line order depends on filesystem walk order
 * cannot be diffed between two gate runs.
 */
export function mergeLcovSources(
  sources: LcovSource[],
  opts: { repoRoot: string },
): { records: LcovRecord[]; stats: MergeStats } {
  const byPath = new Map<string, LcovRecord>();
  const droppedOutsideRepo: string[] = [];
  let recordsRead = 0;

  for (const source of sources) {
    for (const record of parseLcov(source.text)) {
      recordsRead += 1;
      const normalized = normalizeSourcePath(record.sourceFile, {
        workspaceDir: source.workspaceDir,
        repoRoot: opts.repoRoot,
      });
      if (normalized === null) {
        droppedOutsideRepo.push(record.sourceFile);
        continue;
      }
      const existing = byPath.get(normalized);
      if (existing) {
        foldRecord(existing, record);
      } else {
        byPath.set(normalized, { ...record, sourceFile: normalized });
      }
    }
  }

  const records = [...byPath.values()].sort((a, b) =>
    a.sourceFile < b.sourceFile ? -1 : a.sourceFile > b.sourceFile ? 1 : 0,
  );
  return {
    records,
    stats: { recordsRead, filesOut: records.length, droppedOutsideRepo },
  };
}

/**
 * Render records back to lcov text, recomputing every summary counter.
 *
 * FNF/FNH/LF/LH/BRF/BRH are DERIVED here rather than carried through the merge:
 * they are a second copy of what the DA/FNDA/BRDA lines already say, and the
 * repo's derived-truth rule is to compute such a value rather than transcribe
 * one that can drift.
 */
export function formatLcov(records: LcovRecord[]): string {
  const out: string[] = [];
  for (const record of records) {
    out.push('TN:');
    out.push(`SF:${record.sourceFile}`);

    const functions = [...record.functions.entries()].sort((a, b) =>
      a[1].line - b[1].line || (a[0] < b[0] ? -1 : 1),
    );
    for (const [name, fn] of functions) out.push(`FN:${fn.line},${name}`);
    for (const [name, fn] of functions) out.push(`FNDA:${fn.hits},${name}`);
    out.push(`FNF:${functions.length}`);
    out.push(`FNH:${functions.filter(([, fn]) => fn.hits > 0).length}`);

    const branches = [...record.branches.values()].sort(
      (a, b) => a.line - b.line || (a.block < b.block ? -1 : a.block > b.block ? 1 : 0),
    );
    for (const branch of branches) {
      out.push(
        `BRDA:${branch.line},${branch.block},${branch.branch},${branch.taken === 0 ? '-' : branch.taken}`,
      );
    }
    if (branches.length > 0) {
      out.push(`BRF:${branches.length}`);
      out.push(`BRH:${branches.filter((b) => b.taken > 0).length}`);
    }

    const lines = [...record.lines.entries()].sort((a, b) => a[0] - b[0]);
    for (const [lineNo, hits] of lines) out.push(`DA:${lineNo},${hits}`);
    out.push(`LF:${lines.length}`);
    out.push(`LH:${lines.filter(([, hits]) => hits > 0).length}`);

    out.push('end_of_record');
  }
  return out.length > 0 ? `${out.join('\n')}\n` : '';
}

/** Records keyed by repo-root-relative path — the shape the patch gate consumes. */
export function indexBySourceFile(records: LcovRecord[]): Map<string, LcovRecord> {
  return new Map(records.map((record) => [record.sourceFile, record]));
}
