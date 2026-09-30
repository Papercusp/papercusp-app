/**
 * testing-verdict-diff.ts — the five-bucket gate-verdict diff core
 * (plan `test-verdict-diff-2026-08-31` P-001, filed as EI-19316659347083806).
 *
 * THE QUESTION IT ANSWERS: *which test files changed verdict because of my
 * change?* Today an agent staring at "41 red" cannot tell which reds are theirs,
 * while the standing repo rule says a red gate is yours to green. Measured on two
 * consecutive real CI groups, that 41 decomposed into 14 newly-failing + 8
 * inherited — a decomposition no existing surface produces.
 *
 * WHY A DIFF AND NOT A GREP. The filing's founding incident: an author shipped a
 * rail touching every unit test in the monorepo and measured the fallout with
 * `196 rail hits, 0 AssertionError/Failed markers`. The 196 was right. But the
 * dominant failure class that rail produces is a `vitest-fail-on-console`
 * verdict, which emits NEITHER marker — so a careful measurement read clean for a
 * change that red-pinned 47 files 18 minutes later. A grep needs you to already
 * know the shape of the failure you have not seen yet; comparing OUTCOMES catches
 * a class the author has never seen.
 *
 * This module is deliberately PURE — it takes rows and returns buckets, with no
 * database access — so every rule below is testable without a fixture database.
 * The SQL population rules (D-001 run-group identity, D-004 source/dirty
 * filtering) live in the `testing:verdict_diff` tool that feeds it.
 */

/**
 * D-003 — A NON-VERDICT IS NOT A VERDICT.
 *
 * The `test_runs.status` enum is `pass | fail | skip | error | cancelled |
 * running`. Only two of those six are outcomes about the code:
 *
 *  - RED is `fail` OR `error`. `error` is a red too: a suite that errored before
 *    it could fail still did not pass, and a fail-only filter under-reports it.
 *  - `skip` / `cancelled` / `running` are NOT outcomes. A file going
 *    `pass -> skip` is neither newlyFailing nor newlyPassing; nothing was
 *    measured, and saying otherwise invents a transition.
 *
 * An UNRECOGNISED status maps to `not-measured`, never to `green`. That
 * direction is chosen deliberately: a new enum member silently counted as a pass
 * is the exact false-negative this whole item exists to kill (EI-21974750710808305
 * fixed the same shape one layer up — a run that executed ZERO tests reported
 * `status=passed` + exit 0). A verdict is only a measurement if something ran.
 */
export type VerdictClass = 'green' | 'red' | 'not-measured';

/** The RED set, shared with `testing:runs`. Never `'failed'` — that literal can
 *  NEVER match this column and reads as a clean result. */
export const RED_STATUSES = ['fail', 'error'] as const;
/** The only status that asserts the code was exercised and was fine. */
export const GREEN_STATUSES = ['pass'] as const;

export function classifyVerdict(status: string | null | undefined): VerdictClass {
  if (status === null || status === undefined) return 'not-measured';
  const normalized = status.trim().toLowerCase();
  if ((RED_STATUSES as readonly string[]).includes(normalized)) return 'red';
  if ((GREEN_STATUSES as readonly string[]).includes(normalized)) return 'green';
  return 'not-measured';
}

/** One collapsed per-file verdict from a single run group. */
export type VerdictRow = {
  filePath: string;
  status: string;
  /** Only populated for red rows, and truncated. Used for signature grouping. */
  outputTail?: string | null;
};

export type DiffEntry = {
  filePath: string;
  /** null when the file was not present in that group at all. */
  baselineStatus: string | null;
  candidateStatus: string | null;
  /** Present only on newlyFailing entries that produced one (P-006). */
  signature?: string | null;
};

export type VerdictBucketName =
  | 'newlyFailing'
  | 'newlyPassing'
  | 'stillFailing'
  | 'onlyInCandidate'
  | 'onlyInBaseline'
  | 'notMeasured';

export type VerdictDiff = {
  newlyFailing: DiffEntry[];
  newlyPassing: DiffEntry[];
  stillFailing: DiffEntry[];
  /**
   * D-002 — FIVE BUCKETS, NOT THREE. `test:affected` selects a different radius
   * per run, so files legitimately appear on only one side (measured: 14 only in
   * the candidate, 6 only in the baseline). Folding an only-in-candidate file
   * into `newlyFailing` asserts a transition that was never observed — the
   * baseline never ran it. These are first-class buckets, not a rounding error.
   */
  onlyInCandidate: DiffEntry[];
  onlyInBaseline: DiffEntry[];
  /** D-003: present on both sides, but at least one side is not an outcome. */
  notMeasured: DiffEntry[];
  /**
   * Files that passed on BOTH sides. A COUNT, never a list: this is the bucket
   * that holds ~6,600 files on a real gate pair, and materialising it would bury
   * every bucket that carries signal.
   */
  unchangedPassing: number;
  /** Files seen in each group, and how many of them were red. */
  baselineFiles: number;
  candidateFiles: number;
  baselineRed: number;
  candidateRed: number;
  /**
   * Rows discarded because their file path had already been seen in that group.
   * The caller is expected to pass ONE row per file (latest-per-file); a nonzero
   * count here means it did not, and is surfaced rather than silently absorbed.
   */
  duplicateRowsIgnored: number;
};

function indexByFile(rows: readonly VerdictRow[]): { index: Map<string, VerdictRow>; duplicates: number } {
  const index = new Map<string, VerdictRow>();
  let duplicates = 0;
  for (const row of rows) {
    // FIRST wins: the caller orders rows latest-first (SQL `DISTINCT ON ...
    // ORDER BY finished_at DESC`), so the first row for a path is the current
    // verdict and a later one is a superseded attempt.
    if (index.has(row.filePath)) {
      duplicates += 1;
      continue;
    }
    index.set(row.filePath, row);
  }
  return { index, duplicates };
}

/**
 * Compare two groups' per-file verdicts. Pure: no I/O, no clock, no database.
 *
 * The classification is exhaustive over (baselineClass, candidateClass) and the
 * ONLY pairs that produce a verdict-change bucket are ones where BOTH sides are
 * real outcomes. Everything else lands in `notMeasured` or a presence bucket.
 */
export function diffVerdicts(input: {
  baseline: readonly VerdictRow[];
  candidate: readonly VerdictRow[];
}): VerdictDiff {
  const base = indexByFile(input.baseline);
  const cand = indexByFile(input.candidate);

  const diff: VerdictDiff = {
    newlyFailing: [],
    newlyPassing: [],
    stillFailing: [],
    onlyInCandidate: [],
    onlyInBaseline: [],
    notMeasured: [],
    unchangedPassing: 0,
    baselineFiles: base.index.size,
    candidateFiles: cand.index.size,
    baselineRed: 0,
    candidateRed: 0,
    duplicateRowsIgnored: base.duplicates + cand.duplicates,
  };

  for (const row of base.index.values()) {
    if (classifyVerdict(row.status) === 'red') diff.baselineRed += 1;
  }
  for (const row of cand.index.values()) {
    if (classifyVerdict(row.status) === 'red') diff.candidateRed += 1;
  }

  for (const [filePath, candidateRow] of cand.index) {
    const baselineRow = base.index.get(filePath);
    if (baselineRow === undefined) {
      diff.onlyInCandidate.push({
        filePath,
        baselineStatus: null,
        candidateStatus: candidateRow.status,
      });
      continue;
    }
    const entry: DiffEntry = {
      filePath,
      baselineStatus: baselineRow.status,
      candidateStatus: candidateRow.status,
    };
    const before = classifyVerdict(baselineRow.status);
    const after = classifyVerdict(candidateRow.status);

    if (before === 'not-measured' || after === 'not-measured') {
      diff.notMeasured.push(entry);
      continue;
    }
    if (before === 'green' && after === 'red') {
      diff.newlyFailing.push({ ...entry, signature: failureSignature(candidateRow.outputTail) });
      continue;
    }
    if (before === 'red' && after === 'green') {
      diff.newlyPassing.push(entry);
      continue;
    }
    if (before === 'red' && after === 'red') {
      diff.stillFailing.push(entry);
      continue;
    }
    diff.unchangedPassing += 1;
  }

  for (const [filePath, baselineRow] of base.index) {
    if (cand.index.has(filePath)) continue;
    diff.onlyInBaseline.push({
      filePath,
      baselineStatus: baselineRow.status,
      candidateStatus: null,
    });
  }

  orderBySignature(diff.newlyFailing);
  return diff;
}

// The raw ESC byte is written as an escape on purpose: a literal 0x1b makes
// ripgrep treat the file as binary and skip it, and it reds the fleet-wide
// `lint:no-control-bytes` gate leg. `\x1b` is byte-identical at runtime.
const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]/g;
const SIGNATURE_MAX_CHARS = 140;

/**
 * P-006 / D-005 — SIGNATURE GROUPING SHIPS AS SECONDARY ORDERING, NOT AS THE
 * HEADLINE. The filing hoped grouping WAS the diagnosis (47 distinct reds
 * collapsing to 1 cause). Measurement says otherwise: 14 newly-failing files
 * collapsed to ~6 signatures at 2/1/1/1/1/1. Useful for putting related reds
 * next to each other; not a diagnosis. Ship it, do not sell it.
 *
 * Deliberately a heuristic over the stored output tail: normalise away the parts
 * that differ per file (paths, line numbers, durations, hex ids) and keep the
 * first line that looks like a failure. Returns null when nothing usable is
 * present — an absent signature is reported as absent, never as a shared one,
 * because a null-keyed cluster would merge unrelated reds into a fake pattern.
 */
export function failureSignature(outputTail: string | null | undefined): string | null {
  if (!outputTail) return null;
  const lines = outputTail
    .replace(ANSI_ESCAPE, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const interesting =
    lines.find((line) => /(?:Error|Exception|✕|×|FAIL|Unhandled|expected|assert)/i.test(line)) ?? lines[0];
  if (interesting === undefined) return null;

  const normalized = interesting
    // Anything path-shaped (with or without a line:col suffix) is per-file noise.
    .replace(/(?:\/|\.\/|[A-Za-z]:\\)[\w./\\@-]+(?::\d+(?::\d+)?)?/g, '<path>')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<hex>')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/gi, '<duration>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized.length === 0 ? null : normalized.slice(0, SIGNATURE_MAX_CHARS);
}

export type SignatureCluster = { signature: string; count: number; files: string[] };

/** Cluster entries by signature, largest cluster first. Entries with no
 *  signature are omitted — they are not a cluster, they are unknowns. */
export function groupBySignature(entries: readonly DiffEntry[]): SignatureCluster[] {
  const clusters = new Map<string, string[]>();
  for (const entry of entries) {
    const signature = entry.signature ?? null;
    if (signature === null) continue;
    const files = clusters.get(signature);
    if (files) files.push(entry.filePath);
    else clusters.set(signature, [entry.filePath]);
  }
  return [...clusters.entries()]
    .map(([signature, files]) => ({ signature, count: files.length, files }))
    .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
}

/** Reorder in place so files sharing a signature sit together, biggest cluster
 *  first, unsignatured entries last. Secondary ordering only (D-005). */
export function orderBySignature(entries: DiffEntry[]): void {
  const rank = new Map<string, number>();
  groupBySignature(entries).forEach((cluster, position) => rank.set(cluster.signature, position));
  entries.sort((a, b) => {
    const aRank = a.signature ? (rank.get(a.signature) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    const bRank = b.signature ? (rank.get(b.signature) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    return aRank - bRank || a.filePath.localeCompare(b.filePath);
  });
}

/**
 * P-003 — A COUNT COMPUTED OVER A CAPPED FETCH MUST SAY SO ON THE AGGREGATE.
 *
 * The repo rule, restated because this is exactly the surface it governs: a
 * caller's `limit` bounds ROW LISTS ONLY, never an aggregate, and a bounded
 * measurement rendered as a confident number is indistinguishable from a real
 * zero. So the bucket COUNT is always the census count, and only the returned
 * `files` list is capped — with the cap declared beside the number it bounds,
 * not somewhere else in the payload.
 */
export type BoundedBucket = {
  count: number;
  files: DiffEntry[];
  truncatedByLimit: boolean;
  omitted: number;
};

export function boundBucket(entries: readonly DiffEntry[], limit: number): BoundedBucket {
  const files = entries.slice(0, limit);
  return {
    count: entries.length,
    files,
    truncatedByLimit: entries.length > files.length,
    omitted: entries.length - files.length,
  };
}
