/** Recurring gate failures and same-commit local divergence for Blender.
 * The gate's file-run rows have no workspace/harness stamp by writer design.
 * Read only source=ci with a committed SHA; local evidence is a separate,
 * clean population and is compared only at the identical SHA. */
import { getOrgPg } from '@papercusp/db-org';
import type { MetaPattern } from './types';

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILES_READ = 100;

export interface CiTestFailureAggregate {
  filePath: string;
  failedRows: number;
  failedGroups: number;
  latestId: string;
  latestSha: string;
  latestAt: string;
  localPassId: string | null;
}

export function buildCiTestHealthPatterns(
  aggregates: readonly CiTestFailureAggregate[],
  opts: { limit?: number; totalCandidates?: number } = {},
): MetaPattern[] {
  const limit = Math.max(1, opts.limit ?? 20);
  const candidates = aggregates
    .filter((row) => row.failedGroups >= 2 || row.localPassId !== null)
    .sort((a, b) =>
      Number(b.localPassId !== null) - Number(a.localPassId !== null) ||
      b.failedGroups - a.failedGroups ||
      b.failedRows - a.failedRows ||
      a.filePath.localeCompare(b.filePath),
    );
  const shown = candidates.slice(0, limit);
  const patterns: MetaPattern[] = shown.map((row) => {
    const divergence = row.localPassId !== null;
    return {
      category: 'ci-test-health',
      ref: `test-run:${row.latestId}`,
      summary: `${row.filePath.slice(0, 200)}: ${row.failedGroups} failing CI run group(s)${divergence ? '; clean local pass at the same commit' : ''}`,
      detail: `${row.failedRows} failed CI file-run row(s) in 7d; latest test_runs.id=${row.latestId} at ${row.latestAt}, commit ${row.latestSha}. ${divergence ? `Clean local pass test_runs.id=${row.localPassId} at the same commit. ` : ''}Counts are rows and distinct run groups, not unique incidents.`,
      weight: Math.min(1, (divergence ? 0.75 : 0.55) + row.failedGroups / 100),
    };
  });
  const unseen = Math.max(0, candidates.length - shown.length);
  const unread = Math.max(0, (opts.totalCandidates ?? aggregates.length) - aggregates.length);
  if (unseen || unread) {
    patterns.push({
      category: 'ci-test-health',
      ref: 'ci-test:coverage-residue',
      summary: `${unseen + unread} qualifying CI test file(s) outside this corpus view`,
      detail: `${unseen} below the ${limit}-pattern cap; ${unread} outside the ${MAX_FILES_READ}-file database read cap. Query test_runs for the complete file-run population.`,
      weight: 0.4,
    });
  }
  return patterns;
}

/** The source-specific query is fail-soft so a test ledger outage cannot
 * prevent the other Blender lanes from loading. */
export async function buildCiTestHealthLane(
  opts: { nowMs?: number; limit?: number } = {},
): Promise<MetaPattern[]> {
  try {
    const nowMs = opts.nowMs ?? Date.now();
    const since = new Date(nowMs - WINDOW_MS).toISOString();
    const until = new Date(nowMs).toISOString();
    const { sql } = getOrgPg();
    const rows = await sql<Array<{
      file_path: string;
      failed_rows: number | string;
      failed_groups: number | string;
      latest_id: string;
      latest_sha: string;
      latest_at: string;
      local_pass_id: string | null;
      total_candidates: number | string;
    }>>`
      WITH ci AS (
        SELECT file_path,
               count(*)::int AS failed_rows,
               count(DISTINCT coalesce(run_group_id, id::text))::int AS failed_groups,
               ((array_agg(id ORDER BY finished_at DESC, id DESC))[1])::text AS latest_id,
               (array_agg(commit_sha ORDER BY finished_at DESC, id DESC))[1] AS latest_sha,
               max(finished_at)::text AS latest_at
          FROM harness_shared.test_runs
         WHERE source = 'ci'
           AND status IN ('fail', 'error')
           AND worktree_dirty IS FALSE
           AND commit_sha IS NOT NULL
           AND finished_at >= ${since}::timestamptz
           AND finished_at <= ${until}::timestamptz
         GROUP BY file_path
      ), candidates AS (
        SELECT ci.*, local_pass.id::text AS local_pass_id,
               count(*) OVER()::int AS total_candidates
          FROM ci
          LEFT JOIN LATERAL (
            SELECT id FROM harness_shared.test_runs
             WHERE source = 'local'
               AND status = 'pass'
               AND worktree_dirty IS FALSE
               AND commit_sha = ci.latest_sha
               AND file_path = ci.file_path
               AND finished_at >= ${since}::timestamptz
               AND finished_at <= ${until}::timestamptz
             ORDER BY finished_at DESC, id DESC
             LIMIT 1
          ) local_pass ON TRUE
         WHERE ci.failed_groups >= 2 OR local_pass.id IS NOT NULL
      )
      SELECT * FROM candidates
       ORDER BY (local_pass_id IS NOT NULL) DESC, failed_groups DESC,
                failed_rows DESC, file_path ASC
       LIMIT ${MAX_FILES_READ}`;
    return buildCiTestHealthPatterns(rows.map((row) => ({
      filePath: row.file_path,
      failedRows: Number(row.failed_rows),
      failedGroups: Number(row.failed_groups),
      latestId: row.latest_id,
      latestSha: row.latest_sha,
      latestAt: row.latest_at,
      localPassId: row.local_pass_id,
    })), { limit: opts.limit, totalCandidates: Number(rows[0]?.total_candidates ?? 0) });
  } catch {
    return [];
  }
}
