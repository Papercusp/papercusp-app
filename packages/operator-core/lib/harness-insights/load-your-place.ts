/**
 * loadYourPlace — Insights YourPlaceCard data source.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24
 *       (P-073d real-data follow-up).
 *
 * Viewer-scoped per-harness aggregations:
 *   queue          — pending features in the user's queue,
 *                    in-flight (working), shipped-this-week
 *   role           — pr_reviewer_enabled / provisional-owner / claimant
 *   trust          — N authors I trust + N who trust me
 *
 * (Per-viewer spend was removed — cross-backend-cost-capture D-003 #2;
 * the harness total lives on the SpendCard.)
 *
 * Pure logic — injectable runQuery. Every section defends against a
 * missing table independently.
 */

import type { YourPlaceCardProps } from './card-types';

export interface LoadYourPlaceOpts {
  workspace_id: string;
  harness_slug: string;
  viewer_github_user_id: number;
  /** Sliding window for shipped-this-week. Default 7d. */
  windowMs?: number;
  runQuery: <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;
}

interface CountRow {
  n: string | number;
}

async function safeCount(
  runQuery: LoadYourPlaceOpts['runQuery'],
  query: string,
  params: unknown[],
): Promise<number> {
  try {
    const rows = await runQuery<CountRow>(query, params);
    const v = rows[0]?.n;
    if (v == null) return 0;
    const n = typeof v === 'string' ? Number.parseInt(v, 10) : Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function safeBool(
  runQuery: LoadYourPlaceOpts['runQuery'],
  query: string,
  params: unknown[],
): Promise<boolean> {
  try {
    const rows = await runQuery<{ b: boolean | null }>(query, params);
    return rows[0]?.b === true;
  } catch {
    return false;
  }
}

export async function loadYourPlace(
  opts: LoadYourPlaceOpts,
): Promise<YourPlaceCardProps> {
  const {
    workspace_id,
    harness_slug,
    viewer_github_user_id,
    runQuery,
  } = opts;
  const windowMs = opts.windowMs ?? 7 * 24 * 60 * 60 * 1000;
  const windowStart = Date.now() - windowMs;

  // ── queue ────────────────────────────────────────────────────────
  const queued = await safeCount(
    runQuery,
    `SELECT COUNT(*) AS n
       FROM harness_shared.feature_queue
      WHERE workspace_id = $1
        AND harness_slug = $2
        AND github_user_id = $3`,
    [workspace_id, harness_slug, viewer_github_user_id],
  );
  const working = await safeCount(
    runQuery,
    `SELECT COUNT(*) AS n
       FROM harness_shared.harness_features_consolidated
      WHERE workspace_id = $1
        AND harness_slug = $2
        AND taken_by = $3
        AND status IN ('claiming', 'working', 'wip')`,
    [workspace_id, harness_slug, String(viewer_github_user_id)],
  );
  const shipped_this_week = await safeCount(
    runQuery,
    `SELECT COUNT(*) AS n
       FROM harness_shared.harness_features_consolidated
      WHERE workspace_id = $1
        AND harness_slug = $2
        AND taken_by = $3
        AND status = 'shipped'
        AND updated_ts >= $4`,
    [workspace_id, harness_slug, String(viewer_github_user_id), windowStart],
  );

  // ── role ──────────────────────────────────────────────────────────
  const pr_reviewer_enabled = await safeBool(
    runQuery,
    `SELECT pr_reviewer_role_enabled AS b
       FROM harness_shared.pr_reviewer_settings
      WHERE workspace_id = $1
        AND harness_slug = $2
        AND github_user_id = $3`,
    [workspace_id, harness_slug, viewer_github_user_id],
  );
  const is_provisional_owner = await safeBool(
    runQuery,
    `SELECT (provisional_owner_github_user_id = $3) AS b
       FROM harness_shared.shared_repo_binding_cache
      WHERE workspace_id = $1
        AND harness_slug = $2`,
    [workspace_id, harness_slug, viewer_github_user_id],
  );
  const is_claimant = await safeBool(
    runQuery,
    `SELECT ($3 = ANY(claimed_by_github_user_ids)) AS b
       FROM harness_shared.shared_repo_binding_cache
      WHERE workspace_id = $1
        AND harness_slug = $2`,
    [workspace_id, harness_slug, String(viewer_github_user_id)],
  );

  // ── trust ─────────────────────────────────────────────────────────
  const trusted_authors_count = await safeCount(
    runQuery,
    `SELECT COUNT(*) AS n
       FROM harness_shared.trusted_authors
      WHERE workspace_id = $1
        AND harness_slug = $2
        AND trusted_by_github_user_id = $3`,
    [workspace_id, harness_slug, viewer_github_user_id],
  );
  const trusted_by_count = await safeCount(
    runQuery,
    `SELECT COUNT(*) AS n
       FROM harness_shared.trusted_authors
      WHERE workspace_id = $1
        AND harness_slug = $2
        AND trusted_github_user_id = $3`,
    [workspace_id, harness_slug, viewer_github_user_id],
  );

  // Per-viewer spend was REMOVED (cross-backend-cost-capture D-003 #2): the old
  // query summed phantom `tool_invocations.cost_microcents` (column never
  // existed → always $0), and agent runs are orchestrator-spawned with no
  // per-person attribution. The harness total lives on the SpendCard
  // (load-spend.ts → agent_usage_samples).

  return {
    queue: { queued, working, shipped_this_week },
    role: {
      pr_reviewer_enabled,
      is_provisional_owner,
      is_claimant,
    },
    trust: { trusted_authors_count, trusted_by_count },
  };
}
