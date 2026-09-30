/**
 * Orphaned harness_shared.test_runs row detection + prune (EI-5366).
 *
 * `test_runs` rows persist a file_path stamped with the harness that ran it
 * (persistHarnessTestRuns, testing-run-store.ts) — root-relative POSIX to the
 * worktree the run executed in. When a test file is later DELETED or RENAMED
 * (a refactor), its last row is frozen at the pre-move sha and surfaces as a
 * phantom "current red/green" in latest-status-per-file queries. Functionally
 * harmless (the live Tests-tab glob walks the filesystem and never shows a
 * deleted file; the green gate re-runs affected tests, it never reads these
 * rows directly) — but the rows pollute raw test_runs diagnostics forever
 * with no sanctioned way to clear them (the papercusp-workspace operator DB
 * is in-process PGlite; there is no safe external write path, so cleanup must
 * run INSIDE the live operator's own connection, not via psql/dev:pg_query).
 *
 * DETECTION: for each distinct (harness_slug, file_path) pair, resolve the
 * harness's STAGING worktree root (the only phase that matters for "does this
 * file currently exist" — testing/production worktrees are ephemeral clones)
 * and check the file against the live filesystem. A pair with no matching
 * harness_slug in the registry (never assigned to any harness's WI-1858 tests,
 * or the harness itself was since removed) is also reported as orphaned —
 * pruning is still safe (nothing can resolve it to a real file).
 *
 * PHANTOM-PATHS: rows under preserved `_retired/` trees, scratch `tdg-*`
 * throwaway directories, or sibling checkout prefixes are not active test
 * signal even when the path exists on disk. They are pruned by explicit path
 * classification, not by file-existence inference.
 *
 * Prune is DELETE-only on the exact orphaned (harness_slug, file_path) pairs
 * this scan found — never a broader sweep — and is dry-run by default.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadHarnessRegistry } from './harness-registry';
import { phasePath } from './harness-phases';

const WRONG_TREE_PREFIXES = [
  'papercupai-workspace/papercup-checkpoint/',
  'papercupai-workspace/papercusp-checkpoint/',
  'papercupai-workspace/papercup-staging/',
] as const;

export type OrphanRunReason =
  | 'file_not_found'
  | 'harness_not_found'
  | 'retired_path'
  | 'scratch_path'
  | 'flakeproof_path'
  | 'wrong_tree_path';

export interface OrphanRunGroup {
  harnessSlug: string | null;
  filePath: string;
  /** How many test_runs rows share this (harness_slug, file_path) pair. */
  rowCount: number;
  /** Why it's considered orphaned. */
  reason: OrphanRunReason;
}

/** A postgres-js-like tagged-template client; injectable so this stays unit-testable. */
type SqlLike = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown[]>;

async function resolveSql(sql?: SqlLike): Promise<SqlLike> {
  if (sql) return sql;
  const { getOrgPg } = await import('@papercusp/db-org');
  return getOrgPg().sql as unknown as SqlLike;
}

function classifyPhantomPath(filePath: string): OrphanRunReason | null {
  if (
    filePath.startsWith('_retired/') ||
    filePath.includes('/_retired/')
  ) {
    return 'retired_path';
  }
  if (
    filePath.startsWith('.papercusp/scratch/tdg-') ||
    filePath.includes('/.papercusp/scratch/tdg-')
  ) {
    return 'scratch_path';
  }
  // `*.flakeproof.test.{ts,tsx}` — reserved, gitignored flake-soak self-test
  // fixtures (scripts/flake-soak.sh). Their runs are intended REDs and the file
  // is never committed, so any test_runs row for one is a phantom regardless of
  // whether a scratch copy currently exists on disk (EI-10761). Classified as
  // non-signal so these rows (including null-harness ones) can be pruned.
  if (filePath.includes('.flakeproof.test.')) {
    return 'flakeproof_path';
  }
  if (WRONG_TREE_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
    return 'wrong_tree_path';
  }
  return null;
}

/**
 * Scan harness_shared.test_runs for (harness_slug, file_path) pairs whose file
 * no longer exists in that harness's staging worktree. Read-only.
 */
export async function findOrphanTestRunGroups(opts: {
  workspaceId: string;
  sql?: SqlLike;
}): Promise<OrphanRunGroup[]> {
  const sql = await resolveSql(opts.sql);
  const rows = (await sql`
    SELECT harness_slug, file_path, count(*)::int AS row_count
      FROM harness_shared.test_runs
     WHERE file_path IS NOT NULL
     GROUP BY harness_slug, file_path
  `) as Array<{ harness_slug: string | null; file_path: string; row_count: number }>;
  if (rows.length === 0) return [];

  const { projects } = await loadHarnessRegistry(opts.workspaceId);
  const rootBySlug = new Map<string, string>();
  for (const p of projects) rootBySlug.set(p.slug, phasePath(p, 'staging'));

  const orphans: OrphanRunGroup[] = [];
  for (const r of rows) {
    const phantomReason = classifyPhantomPath(r.file_path);
    if (phantomReason) {
      orphans.push({
        harnessSlug: r.harness_slug,
        filePath: r.file_path,
        rowCount: r.row_count,
        reason: phantomReason,
      });
      continue;
    }
    if (!r.harness_slug) continue;
    const root = rootBySlug.get(r.harness_slug);
    if (!root) {
      orphans.push({ harnessSlug: r.harness_slug, filePath: r.file_path, rowCount: r.row_count, reason: 'harness_not_found' });
      continue;
    }
    if (!existsSync(join(root, r.file_path))) {
      orphans.push({ harnessSlug: r.harness_slug, filePath: r.file_path, rowCount: r.row_count, reason: 'file_not_found' });
    }
  }
  return orphans;
}

/**
 * DELETE the given orphaned (harness_slug, file_path) pairs from
 * harness_shared.test_runs. Callers must pass EXACTLY the groups
 * {@link findOrphanTestRunGroups} just reported — this never re-derives or
 * widens the target set. Returns the total rows deleted.
 */
export async function pruneOrphanTestRunGroups(
  groups: OrphanRunGroup[],
  opts: { sql?: SqlLike } = {},
): Promise<number> {
  if (groups.length === 0) return 0;
  const sql = await resolveSql(opts.sql);
  let deleted = 0;
  for (const g of groups) {
    const res = g.harnessSlug === null
      ? (await sql`
        DELETE FROM harness_shared.test_runs
         WHERE harness_slug IS NULL AND file_path = ${g.filePath}
      `) as unknown as { count?: number }
      : (await sql`
        DELETE FROM harness_shared.test_runs
         WHERE harness_slug = ${g.harnessSlug} AND file_path = ${g.filePath}
      `) as unknown as { count?: number };
    deleted += typeof res?.count === 'number' ? res.count : g.rowCount;
  }
  return deleted;
}
