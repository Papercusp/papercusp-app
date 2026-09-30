/**
 * loadUserRecentActivity — cross-harness activity feed for one user.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24
 *       (P-072c real-data follow-up).
 *
 * Returns the most recent ~30 events across every visible harness this
 * user has touched. Sources mirror loadHarnessActivity but filter by
 * actor (this user's GH id) instead of by harness:
 *
 *   - harness_features_consolidated WHERE taken_by = $1 AND status='shipped'
 *   - auto_review_audit WHERE author_github_id = $1
 *   - contributors WHERE github_user_id = $1 (joined events)
 *   - claim_audit WHERE claimer_github_user_id = $1
 *
 * Pure logic with injectable runQuery; defensive per-source.
 */

import type { ActivityEntry } from './types';

export interface LoadUserRecentActivityOpts {
  github_user_id: number;
  /** Subset of harness slugs the viewer is allowed to see for this user. */
  visible_harness_slugs: ReadonlyArray<string>;
  limit?: number;
  runQuery: <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;
}

interface ShippedRow {
  harness_slug: string;
  feature_id: string;
  title: string;
  updated_ts: string | number;
}

interface MergedPrRow {
  id: string;
  harness_slug: string;
  pr_number: number;
  pr_url: string | null;
  ts: string | Date;
}

interface ContributorJoinedRow {
  harness_slug: string;
  joined_at: string | Date;
}

interface ClaimAuditRow {
  id: string;
  harness_slug: string;
  feature_id: string;
  outcome: string | null;
  ts: string | Date;
}

function asEpoch(v: string | number | Date): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

export async function loadUserRecentActivity(
  opts: LoadUserRecentActivityOpts,
): Promise<ActivityEntry[]> {
  const { github_user_id, runQuery } = opts;
  const visible = new Set(opts.visible_harness_slugs);
  const limit = opts.limit ?? 30;
  if (visible.size === 0) return [];
  const perSource = limit;
  const slugList = Array.from(visible);

  const out: ActivityEntry[] = [];

  // shipped
  try {
    const rows = await runQuery<ShippedRow>(
      `SELECT harness_slug, feature_id, title, updated_ts
         FROM harness_shared.harness_features_consolidated
        WHERE taken_by = $1
          AND status = 'shipped'
          AND harness_slug = ANY($2)
        ORDER BY updated_ts DESC
        LIMIT $3`,
      [String(github_user_id), slugList, perSource],
    );
    for (const r of rows) {
      out.push({
        id: `feature-${r.harness_slug}-${r.feature_id}`,
        ts: asEpoch(r.updated_ts),
        kind: 'feature_shipped',
        label: `Shipped ${r.feature_id} in ${r.harness_slug}`,
        href: `/harness/${r.harness_slug}`,
      });
    }
  } catch {
    // skip
  }

  // pr_merged
  try {
    const rows = await runQuery<MergedPrRow>(
      `SELECT id::text AS id, harness_slug, pr_number, pr_url, ts
         FROM harness_shared.auto_review_audit
        WHERE author_github_id = $1
          AND harness_slug = ANY($2)
          AND action IN ('auto_merge', 'manual_merge')
        ORDER BY ts DESC
        LIMIT $3`,
      [github_user_id, slugList, perSource],
    );
    for (const r of rows) {
      out.push({
        id: `pr-${r.harness_slug}-${r.id}`,
        ts: asEpoch(r.ts),
        kind: 'pr_merged',
        label: `Merged PR #${r.pr_number} in ${r.harness_slug}`,
        href: r.pr_url ?? `/harness/${r.harness_slug}`,
      });
    }
  } catch {
    // skip
  }

  // contributor_joined
  try {
    const rows = await runQuery<ContributorJoinedRow>(
      `SELECT harness_slug, joined_at
         FROM harness_shared.contributors
        WHERE github_user_id = $1
          AND harness_slug = ANY($2)
        ORDER BY joined_at DESC
        LIMIT $3`,
      [github_user_id, slugList, perSource],
    );
    for (const r of rows) {
      out.push({
        id: `joined-${r.harness_slug}`,
        ts: asEpoch(r.joined_at),
        kind: 'contributor_joined',
        label: `Joined ${r.harness_slug}`,
        href: `/harness/${r.harness_slug}`,
      });
    }
  } catch {
    // skip
  }

  // escalation_opened (lost claim races / lost permission etc.)
  try {
    const rows = await runQuery<ClaimAuditRow>(
      `SELECT id::text AS id, harness_slug, feature_id, outcome, ts
         FROM harness_shared.claim_audit
        WHERE claimer_github_user_id = $1
          AND harness_slug = ANY($2)
          AND outcome IS NOT NULL
          AND outcome <> 'won'
        ORDER BY ts DESC
        LIMIT $3`,
      [github_user_id, slugList, perSource],
    );
    for (const r of rows) {
      out.push({
        id: `claim-${r.harness_slug}-${r.id}`,
        ts: asEpoch(r.ts),
        kind: 'escalation_opened',
        label: `Claim on ${r.feature_id} in ${r.harness_slug}: ${r.outcome}`,
        href: `/harness/${r.harness_slug}`,
      });
    }
  } catch {
    // skip
  }

  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, limit);
}
