/**
 * WI-10005560: Postgres store for the completion-settlement history search memo
 * (`harness_shared.completion_history_search_memo`, migration 1344).
 *
 * The reader keeps an exact per-(path, close-time blob) verdict over a commit range. This
 * store keeps those verdicts across bg-host restarts, so the first settlement rotation
 * after a boot resumes where the last process stopped instead of re-searching every pair
 * over its whole range.
 */
import type { getOrgPg } from '@papercusp/db-org';
import type {
  CompletionHistoryMemoRecord,
  CompletionHistoryMemoStore,
} from '../../agent-tools/work_items/completion-freshness';

type Sql = ReturnType<typeof getOrgPg>['sql'];

const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
/** Rows per upsert statement: bounds the parameter count (11 columns × 500 < 65,535). */
const SAVE_BATCH = 500;
/** A verdict untouched this long belongs to a pair that settled or was abandoned. */
const RETENTION_DAYS = 14;

type MemoRow = {
  repository_root: string;
  from_head_sha: string;
  path: string;
  blob_sha: string;
  resolved_root: string;
  resolved_from_sha: string;
  resolved_path: string;
  searched_through: string | null;
  found_through: string | null;
};

/** A stored row as a record, or null when it is not a well-formed verdict. */
export function completionHistoryMemoRecordOf(row: MemoRow): CompletionHistoryMemoRecord | null {
  if (!SHA_RE.test(row.from_head_sha) || !SHA_RE.test(row.blob_sha) || !SHA_RE.test(row.resolved_from_sha)) return null;
  if (!row.repository_root || !row.path || !row.resolved_root || !row.resolved_path) return null;
  const at = { repositoryRoot: row.resolved_root, fromCommitSha: row.resolved_from_sha, path: row.resolved_path };
  const searched = row.searched_through;
  const found = row.found_through;
  let value: CompletionHistoryMemoRecord['value'];
  if (searched !== null && found === null && SHA_RE.test(searched)) value = { ...at, searchedThrough: searched };
  else if (found !== null && searched === null && SHA_RE.test(found)) value = { ...at, foundThrough: found };
  else return null;
  return {
    repositoryRoot: row.repository_root,
    fromHeadSha: row.from_head_sha,
    path: row.path,
    blobSha: row.blob_sha,
    value,
  };
}

export function pgCompletionHistoryMemoStore(sql: Sql, workspaceId: string): CompletionHistoryMemoStore {
  return {
    async load(limit) {
      // Hydration runs once per process, so this is also where stale verdicts are pruned.
      await sql`
        DELETE FROM harness_shared.completion_history_search_memo
         WHERE workspace_id = ${workspaceId}
           AND updated_at < now() - make_interval(days => ${RETENTION_DAYS})`;
      const rows = await sql<MemoRow[]>`
        SELECT repository_root, from_head_sha, path, blob_sha,
               resolved_root, resolved_from_sha, resolved_path, searched_through, found_through
          FROM harness_shared.completion_history_search_memo
         WHERE workspace_id = ${workspaceId}
         ORDER BY updated_at DESC
         LIMIT ${limit}`;
      return rows.flatMap((row) => {
        const record = completionHistoryMemoRecordOf(row);
        return record ? [record] : [];
      });
    },
    async save(records) {
      for (let start = 0; start < records.length; start += SAVE_BATCH) {
        const rows = records.slice(start, start + SAVE_BATCH).map((record) => ({
          workspace_id: workspaceId,
          repository_root: record.repositoryRoot,
          from_head_sha: record.fromHeadSha,
          path: record.path,
          blob_sha: record.blobSha,
          resolved_root: record.value.repositoryRoot,
          resolved_from_sha: record.value.fromCommitSha,
          resolved_path: record.value.path,
          searched_through: record.value.searchedThrough ?? null,
          found_through: record.value.foundThrough ?? null,
        }));
        if (rows.length === 0) continue;
        await sql`
          INSERT INTO harness_shared.completion_history_search_memo ${sql(
            rows,
            'workspace_id',
            'repository_root',
            'from_head_sha',
            'path',
            'blob_sha',
            'resolved_root',
            'resolved_from_sha',
            'resolved_path',
            'searched_through',
            'found_through',
          )}
          ON CONFLICT (workspace_id, repository_root, from_head_sha, path, blob_sha) DO UPDATE
             SET resolved_root = EXCLUDED.resolved_root,
                 resolved_from_sha = EXCLUDED.resolved_from_sha,
                 resolved_path = EXCLUDED.resolved_path,
                 searched_through = EXCLUDED.searched_through,
                 found_through = EXCLUDED.found_through,
                 updated_at = now()`;
      }
    },
  };
}
