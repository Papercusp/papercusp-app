/**
 * testing-flakiness.ts — flip-rate analytics over harness_shared.test_runs
 * (EI-6141).
 *
 * PROBLEM: flaky tests are discovered anecdotally today — an agent fighting a
 * red reruns it, sees green, shrugs, and moves on; the next agent to hit the
 * same red re-pays the identical investigation. `test_runs` already stores a
 * per-file verdict per run (persistHarnessTestRuns / testing-run-store.ts) but
 * nothing aggregates it into "how often does this file flip between green and
 * red" — the one number that answers "is this red MINE or a known flake" in a
 * single call, for the agent currently trying to green a gate (see also the
 * green-checkpoint's OWN narrower per-workspace chronic-flake tracker in
 * harness/routines/release-actions.ts, which this complements rather than
 * duplicates — that one only sees CI-retry pairs inside its own gate run;
 * this reads the full cross-run history any caller can query on demand).
 *
 * A file's FLIP = a status transition between pass and fail/error across two
 * CONSECUTIVE runs for that file, ordered by finished_at. flipRate = flips /
 * (runs - 1); a file with 1 run has nothing to compare and reads flipRate 0.
 * Pure aggregation — read-only, no writes.
 */
import { getOrgPg } from '@papercusp/db-org';

/** A postgres-js-like tagged-template client; injectable so this stays unit-testable. */
type SqlLike = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown[]>;

async function resolveSql(sql?: SqlLike): Promise<SqlLike> {
  if (sql) return sql;
  return getOrgPg().sql as unknown as SqlLike;
}

const FAIL_STATUSES = new Set(['fail', 'error']);
// A run row addressed via the restored-checkout scheme (a checkpoint/gate
// worktree copy) uses a different path scheme than a harness's own root —
// same exclusion testing-orphan-runs.ts applies, so it's not double-counted
// as a distinct "file" here.
const RESTORED_CHECKOUT_PREFIX = 'papercupai-workspace/papercup-';

export interface FlakinessRow {
  filePath: string;
  totalRuns: number;
  passCount: number;
  failCount: number;
  flips: number;
  /** flips / (totalRuns - 1), rounded to 3dp. 0 when totalRuns <= 1. */
  flipRate: number;
  lastStatus: string;
  lastFinishedAt: string | null;
  /** Most-recent-last, capped at the last 10 runs — enough to eyeball the pattern. */
  recentStatuses: string[];
}

export interface FlakinessOpts {
  /** Scope to one harness's rows (harness_slug). Omit for a workspace-wide read. */
  harnessSlug?: string | null;
  /** Scope to one workspace when harnessSlug is omitted. */
  workspaceId?: string | null;
  /** How far back to look, in days. Default 14. */
  lookbackDays?: number;
  /** Minimum run count for a file to be considered (too few runs ⇒ noise). Default 4. */
  minRuns?: number;
  /** Max rows returned, ranked by flipRate desc then totalRuns desc. Default 20, capped 100. */
  limit?: number;
  /** Test seam: inject a fake sql client. Defaults to getOrgPg().sql. */
  sql?: SqlLike;
}

/**
 * Rank test files by cross-run flip-rate (how often pass/fail flips between
 * consecutive runs). Read-only.
 */
export async function computeFlakiness(opts: FlakinessOpts = {}): Promise<FlakinessRow[]> {
  const sql = await resolveSql(opts.sql);
  const lookbackDays = opts.lookbackDays ?? 14;
  const minRuns = opts.minRuns ?? 4;
  const limit = Math.min(opts.limit ?? 20, 100);

  // EI-8xxx: a "plain operator self-test run" (the common case for THIS
  // workspace's own dogfood suite — see admin-test-runs-reporter.ts's "NULL
  // for a plain operator self-test run" comment) writes workspace_id NULL,
  // not this workspace's id. 99%+ of harness_shared.test_runs rows are
  // (harness_slug, workspace_id) = (NULL, NULL). A strict workspace_id =
  // opts.workspaceId filter therefore silently excludes almost every row for
  // any workspace-scoped caller (an MCP call always carries ctx.workspaceId),
  // making computeFlakiness see near-zero data despite the docstring's "Omit
  // for workspace-wide" promise. A NULL workspace_id row can't leak another
  // tenant's data (it belongs to no tenant), so it's always safe to include
  // alongside this workspace's own explicitly-tagged rows.
  //
  // WI-3925: the SAME bug existed for harness_slug and was never fixed
  // alongside workspace_id above — a strict `harness_slug = opts.harnessSlug`
  // filter excludes ~100% of real rows (confirmed live: every test_runs row
  // in the last 14 days has harness_slug IS NULL), so ANY harness-scoped call
  // — including the `testing:flakiness` MCP tool's own default fallback to
  // `ctx.harnessSlug` when the caller omits `harness` — silently saw zero
  // rows. Same fix, same reasoning: a NULL harness_slug row belongs to no
  // harness, so it can't leak another harness's data and is always safe to
  // include alongside this harness's own explicitly-tagged rows.
  // EI-19307211919650123: EXCLUDE the release gate's own rows (`source='ci'`)
  // and mutation-probe evidence. Both are valid test-run measurements, but
  // neither belongs in local cross-run flake/quarantine analytics.
  // They record the SAME repo-relative file paths as an agent's local run, but from
  // a different environment: the checkpoint worktree, under the gate's capped fork
  // concurrency and GREEN_CHECKPOINT skip-set. Folding both populations into one
  // flip-rate would make a genuine gate-ONLY failure — the most important signal
  // there is, a test that fails on committed code and passes for everyone locally —
  // read as ordinary flakiness and get nominated for quarantine. Gate-vs-local
  // divergence is a real and valuable question; it is just a DIFFERENT one, and
  // answering it needs the two populations kept apart. Note this filter must stay
  // ahead of the NULL-tolerant harness/workspace predicates below: gate rows carry
  // (harness_slug, workspace_id) = (NULL, NULL), so those deliberately admit them.
  const rows = (await sql`
    SELECT file_path, status, finished_at
      FROM harness_shared.test_runs
     WHERE finished_at IS NOT NULL
       AND finished_at > now() - make_interval(days => ${lookbackDays})
       AND status IN ('pass', 'fail', 'error')
       AND source NOT IN ('ci', 'mutation-probe')
       AND file_path NOT LIKE ${RESTORED_CHECKOUT_PREFIX + '%'}
       AND ${opts.harnessSlug ? sql`(harness_slug = ${opts.harnessSlug} OR harness_slug IS NULL)` : sql`TRUE`}
       AND ${!opts.harnessSlug && opts.workspaceId ? sql`(workspace_id = ${opts.workspaceId} OR workspace_id IS NULL)` : sql`TRUE`}
     ORDER BY file_path ASC, finished_at ASC
  `) as unknown as Array<{ file_path: string; status: string; finished_at: string }>;

  const byFile = new Map<string, Array<{ status: string; finishedAt: string }>>();
  for (const r of rows) {
    const arr = byFile.get(r.file_path) ?? [];
    arr.push({ status: r.status, finishedAt: r.finished_at });
    byFile.set(r.file_path, arr);
  }

  const out: FlakinessRow[] = [];
  for (const [filePath, runs] of byFile) {
    if (runs.length < minRuns) continue;
    let flips = 0;
    let passCount = 0;
    let failCount = 0;
    for (let i = 0; i < runs.length; i++) {
      const isFail = FAIL_STATUSES.has(runs[i].status);
      if (isFail) failCount++; else passCount++;
      if (i > 0 && FAIL_STATUSES.has(runs[i - 1].status) !== isFail) flips++;
    }
    const flipRate = runs.length > 1 ? flips / (runs.length - 1) : 0;
    const last = runs[runs.length - 1];
    out.push({
      filePath,
      totalRuns: runs.length,
      passCount,
      failCount,
      flips,
      flipRate: Math.round(flipRate * 1000) / 1000,
      lastStatus: last.status,
      lastFinishedAt: last.finishedAt,
      recentStatuses: runs.slice(-10).map((r) => r.status),
    });
  }

  out.sort((a, b) => b.flipRate - a.flipRate || b.totalRuns - a.totalRuns);
  return out.slice(0, limit);
}

/** Default gate for "chronic enough to propose quarantining" — deliberately
 *  stricter than the read's own `minRuns` default so a borderline file just
 *  shows up in the ranked list without tripping an auto-file. */
export const QUARANTINE_CANDIDATE_THRESHOLD = 0.3;
export const QUARANTINE_CANDIDATE_MIN_RUNS = 6;

export function isQuarantineCandidate(
  row: Pick<FlakinessRow, 'totalRuns' | 'flipRate'>,
  opts: { threshold?: number; minRuns?: number } = {},
): boolean {
  const threshold = opts.threshold ?? QUARANTINE_CANDIDATE_THRESHOLD;
  const minRuns = opts.minRuns ?? QUARANTINE_CANDIDATE_MIN_RUNS;
  return row.totalRuns >= minRuns && row.flipRate >= threshold;
}
