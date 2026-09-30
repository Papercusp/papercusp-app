/**
 * loadQueueMembership — pure read: who has each feature queued?
 *
 * Plan: papercusp-dogfood-phase5b-hyperbee-ui-integration-2026-05-24 P-032.
 *
 * Backs the avatar-cluster column in FeatureList (up to 5 avatars +
 * "+N more" overflow per v5 §9.1).
 *
 * Joins `harness_shared.feature_queue` with `harness_shared.contributors`
 * so the caller gets display-ready rows in one shot. Excludes soft-
 * deleted tombstones (removed_at IS NOT NULL).
 *
 * Pure: injectable runQuery; no PG client import. Defensive against the
 * tables not existing yet (substrate not booted) — returns {} instead of
 * throwing.
 */

export interface QueueMember {
  github_user_id: number;
  github_username: string;
  display_name: string | null;
  avatar_url: string | null;
  /** epoch ms when this user queued the feature. */
  queued_at: number;
}

export interface LoadQueueMembershipOpts {
  workspace_id: string;
  harness_slug: string;
  /** Filter to a specific subset of features. Omit → all features. */
  feature_ids?: string[];
  runQuery: <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;
}

interface RawRow {
  feature_id: string;
  github_user_id: string | number;
  github_username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  queued_at: string | Date | null;
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

export async function loadQueueMembership(
  opts: LoadQueueMembershipOpts,
): Promise<Record<string, QueueMember[]>> {
  if (!opts.workspace_id || !opts.harness_slug) return {};

  const params: unknown[] = [opts.workspace_id, opts.harness_slug];
  let filterClause = '';
  if (opts.feature_ids && opts.feature_ids.length > 0) {
    const placeholders = opts.feature_ids
      .map((_, i) => `$${i + 3}`)
      .join(', ');
    filterClause = `AND q.feature_id IN (${placeholders})`;
    params.push(...opts.feature_ids);
  }

  const query = `
    SELECT
      q.feature_id,
      q.github_user_id,
      c.github_username,
      c.display_name,
      c.avatar_url,
      q.queued_at
    FROM harness_shared.feature_queue q
    LEFT JOIN harness_shared.contributors c
      ON c.workspace_id = q.workspace_id
     AND c.harness_slug = q.harness_slug
     AND c.github_user_id = q.github_user_id
    WHERE q.workspace_id = $1
      AND q.harness_slug = $2
      AND q.removed_at IS NULL
      ${filterClause}
    ORDER BY q.feature_id, q.queued_at ASC
  `;

  let rows: RawRow[];
  try {
    rows = await opts.runQuery<RawRow>(query, params);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Substrate tables not yet ensured (e.g. early in boot, or flag off).
    if (/does not exist|relation .* does not exist/i.test(msg)) return {};
    throw e;
  }

  const grouped: Record<string, QueueMember[]> = {};
  for (const r of rows) {
    const userId = toUserId(r.github_user_id);
    if (userId <= 0) continue;
    const member: QueueMember = {
      github_user_id: userId,
      github_username: r.github_username ?? '',
      display_name: r.display_name,
      avatar_url: r.avatar_url,
      queued_at: toMs(r.queued_at),
    };
    if (!grouped[r.feature_id]) grouped[r.feature_id] = [];
    grouped[r.feature_id].push(member);
  }
  return grouped;
}
