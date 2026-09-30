/**
 * exogenous-commit-lane.ts — the RECENT-COMMIT DIGEST lane (NOV-2,
 * autonomous-loop-prod-audit-2026-07-02 P-015 / WI-4635): "cross-hive corpora,
 * telemetry anomalies, recent-commit digests, deprecated-draft salvage —
 * external entropy so ideas are not resampled from the same internal pool."
 *
 * Three of NOV-2's four named stimuli were already live under other plans by
 * the time this landed:
 *  - CROSS-HIVE CORPORA — corpus-digest-deps' friction()/observations() readers
 *    (readImprovementItems / readObservationItems) default to EVERY harness in
 *    the workspace, not just the caller's, unless a harnessSlug is explicitly
 *    passed (buildStateOfHiveReaders calls them with no scope).
 *  - TELEMETRY ANOMALIES — the watchdog-health / gate-pipeline-health /
 *    coord-health / tool-telemetry / spend-anomaly lanes (blender-self-learning
 *    P-007/P-008/P-009/P-010/P-011).
 *  - DEPRECATED-DRAFT SALVAGE — deprecate-learnings.ts: a superseded draft's
 *    tried/stalled/salvageable free text is captured as an observation that
 *    rides the friction lane, PLUS a shareable cross-hive negative-result fact
 *    (queen-scout-feedback-loop-2026-06-20 P-006, federated-scout-gym-learning
 *    P-005).
 *
 * This file supplies the missing fourth stimulus: RECENT-COMMIT DIGESTS.
 *
 * A raw commit-MESSAGE digest is not a useful signal here: this repo's shared
 * tree is git-sync auto-committed on a schedule, so the overwhelming majority
 * of commit subjects are the identical `chore(git-sync): auto-commit papercusp
 * [skip ci]` boilerplate — the message itself carries ~zero entropy. The real
 * information is WHERE the tree is actually churning: which repo areas are
 * under active, ongoing edit right now, independent of whether any of that
 * churn is tracked by a work-item (a tracked change already reaches the digest
 * via the completions / change-feed lane; an ad-hoc/manual fix with no work-item
 * does not). So this lane rolls up recently-changed file PATHS by repo area and
 * reports the churn hotspots as citable patterns — a genuinely exogenous
 * ("outside Scout's own operational-history readers") stimulus.
 */
import type { MetaPattern } from './types';

export interface CommitChurnOptions {
  /** Areas surfaced per cycle (default 6). */
  limit?: number;
  /** Minimum distinct touched-file count for an area to surface (default 3 — a
   *  lone edit is not a hotspot). */
  minFiles?: number;
  /** How many example paths to keep per area for the detail line (default 4). */
  exampleFiles?: number;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'unknown'
  );
}

/** Repo-relative path → its churn "area" (top 2 segments; 1 for a shallow path). */
export function commitChurnArea(path: string): string {
  const segs = path.split('/').filter(Boolean);
  if (segs.length <= 1) return segs[0] ?? '(root)';
  return `${segs[0]}/${segs[1]}`;
}

/**
 * PURE: repo-relative file paths touched across the recent-commit window →
 * churn-hotspot patterns, most-touched area first. `paths` may repeat a path
 * (one entry per commit it appeared in), so a file edited across several
 * commits weighs more than one touched once; ranking is by DISTINCT file count
 * per area first (breadth of churn), touch count as the tiebreak.
 */
export function buildRecentCommitPatterns(
  paths: readonly string[],
  opts: CommitChurnOptions = {},
): MetaPattern[] {
  const limit = Math.max(1, opts.limit ?? 6);
  const minFiles = Math.max(1, opts.minFiles ?? 3);
  const exampleFiles = Math.max(1, opts.exampleFiles ?? 4);

  const byArea = new Map<string, { touches: number; files: Set<string> }>();
  for (const raw of paths) {
    const clean = raw.trim();
    if (!clean) continue;
    const area = commitChurnArea(clean);
    const bucket = byArea.get(area) ?? { touches: 0, files: new Set<string>() };
    bucket.touches += 1;
    bucket.files.add(clean);
    byArea.set(area, bucket);
  }

  const ranked = [...byArea.entries()]
    .filter(([, b]) => b.files.size >= minFiles)
    .sort(
      (a, b) =>
        b[1].files.size - a[1].files.size || b[1].touches - a[1].touches || a[0].localeCompare(b[0]),
    );

  const max = ranked.length ? ranked[0][1].files.size : 0;
  return ranked.slice(0, limit).map(([area, b]) => {
    const examples = [...b.files].sort().slice(0, exampleFiles);
    const more = b.files.size > examples.length ? ', …' : '';
    return {
      category: 'recent-commit' as const,
      ref: `commit-churn:${slug(area)}`,
      summary: `${b.files.size} file(s) touched recently in ${area} (${b.touches} commit-touch(es))`,
      detail: `recent examples: ${examples.join(', ')}${more}`,
      weight: max > 0 ? Math.min(1, b.files.size / max) : 0,
    };
  });
}

/** Injectable git reader (unit-testable without a real spawn) — same shape as
 *  harness/docs/git-runner.ts's GitRunner, so the production edge reuses it
 *  directly rather than re-deriving a spawn call. */
export interface GitLogReader {
  (args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface GatherRecentCommitChurnOptions {
  /** Repo directory to resolve the toplevel from (default process.cwd()). */
  repoRoot?: string;
  /** Lookback window in days (default 3 — a short "what's moving right now" window;
   *  deliberately shorter than the digest's other lanes, which look back further). */
  sinceDays?: number;
  /** Hard cap on commits scanned, so a very active window can't blow up cost
   *  (default 500). */
  maxCommits?: number;
  /** Override the git runner (tests). Default: harness/docs/git-runner's runGit. */
  runGit?: GitLogReader;
}

/**
 * The git edge: recently-touched repo-relative file paths over `sinceDays`.
 * Fail-soft — [] on any git failure (a fresh checkout with no history, a
 * non-git tree, a spawn error, …), never throws.
 */
export async function gatherRecentCommitChurn(
  opts: GatherRecentCommitChurnOptions = {},
): Promise<string[]> {
  try {
    const runGit =
      opts.runGit ?? (await import('../harness/docs/git-runner')).runGit;
    const sinceDays = Math.max(1, opts.sinceDays ?? 3);
    const maxCommits = Math.max(1, opts.maxCommits ?? 500);
    const cwd = opts.repoRoot ?? process.cwd();

    const top = await runGit(['rev-parse', '--show-toplevel'], cwd);
    const repoRoot = top.code === 0 && top.stdout.trim() ? top.stdout.trim() : cwd;

    const res = await runGit(
      [
        'log',
        `--since=${sinceDays}.days`,
        `--max-count=${maxCommits}`,
        '--name-only',
        '--pretty=format:',
      ],
      repoRoot,
    );
    if (res.code !== 0) return [];
    return res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The digest-lane edge: gather + build in one call (mirrors buildToolTelemetryLane /
 * buildWatchdogHealthLane). Fail-soft — [] on any failure, never disturbs the cycle.
 */
export async function buildRecentCommitLane(
  opts: GatherRecentCommitChurnOptions & CommitChurnOptions = {},
): Promise<MetaPattern[]> {
  try {
    const paths = await gatherRecentCommitChurn(opts);
    return buildRecentCommitPatterns(paths, opts);
  } catch {
    return [];
  }
}
