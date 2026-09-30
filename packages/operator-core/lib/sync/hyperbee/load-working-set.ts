/**
 * loadWorkingSet — pure read: who is actively working each feature?
 *
 * Plan: papercusp-dogfood-phase6-orchestrator-claim-2026-05-24 P-038.
 *
 * Backs:
 *   - the per-row "working" indicator + "Stop working" toggle (UI).
 *   - the orchestrator eligibility check (P-038b): a feature with a
 *     non-empty working set is excluded from claim candidates.
 *
 * Joins feature_working_set with contributors for display-ready rows.
 * Excludes cleared tombstones (cleared_at IS NOT NULL). Pure:
 * injectable runQuery; defensive against missing tables (returns {}).
 */

export interface WorkingSetMember {
  github_user_id: number;
  github_username: string;
  display_name: string | null;
  avatar_url: string | null;
  /** epoch ms when this user started working the feature. */
  started_at: number;
}

export interface LoadWorkingSetOpts {
  workspace_id: string;
  harness_slug: string;
  /** Filter to a subset of features. Omit → all. */
  feature_ids?: string[];
  runQuery: <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;
}

interface RawRow {
  feature_id: string;
  github_user_id: string | number;
  github_username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  started_at: string | Date | null;
}

function toMs(v: string | Date | null): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

function toUserId(v: string | number): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

export async function loadWorkingSet(
  opts: LoadWorkingSetOpts,
): Promise<Record<string, WorkingSetMember[]>> {
  if (!opts.workspace_id || !opts.harness_slug) return {};

  const params: unknown[] = [opts.workspace_id, opts.harness_slug];
  let filterClause = '';
  if (opts.feature_ids && opts.feature_ids.length > 0) {
    const placeholders = opts.feature_ids.map((_, i) => `$${i + 3}`).join(', ');
    filterClause = `AND w.feature_id IN (${placeholders})`;
    params.push(...opts.feature_ids);
  }

  const query = `
    SELECT
      w.feature_id,
      w.github_user_id,
      c.github_username,
      c.display_name,
      c.avatar_url,
      w.started_at
    FROM harness_shared.feature_working_set w
    LEFT JOIN harness_shared.contributors c
      ON c.workspace_id = w.workspace_id
     AND c.harness_slug = w.harness_slug
     AND c.github_user_id = w.github_user_id
    WHERE w.workspace_id = $1
      AND w.harness_slug = $2
      AND w.cleared_at IS NULL
      ${filterClause}
    ORDER BY w.feature_id, w.started_at ASC
  `;

  let rows: RawRow[];
  try {
    rows = await opts.runQuery<RawRow>(query, params);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/does not exist|relation .* does not exist/i.test(msg)) return {};
    throw e;
  }

  const grouped: Record<string, WorkingSetMember[]> = {};
  for (const r of rows) {
    const userId = toUserId(r.github_user_id);
    if (userId <= 0) continue;
    const member: WorkingSetMember = {
      github_user_id: userId,
      github_username: r.github_username ?? '',
      display_name: r.display_name,
      avatar_url: r.avatar_url,
      started_at: toMs(r.started_at),
    };
    if (!grouped[r.feature_id]) grouped[r.feature_id] = [];
    grouped[r.feature_id].push(member);
  }
  return grouped;
}
