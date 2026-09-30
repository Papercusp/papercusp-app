/**
 * Harness Contributors — list endpoint for Phase 8 P-048.
 *
 *   GET /api/harness/:slug/contributors
 *
 * Reads the PG-projected `harness_shared.contributors` table for the
 * active workspace + harness slug. Returns rows shaped for the
 * Contributors tab (P-048a). Activity stats (tier-A PRs merged,
 * tier-B features shipped, tier-C events) are LEFT JOINed from the
 * sibling tables; missing rows produce zeros.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24 P-048.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';
import { type BindingStatus, statsAggregateForStatus } from '../../../identity/binding-verifier-types';

export interface ContributorListRow {
  github_user_id: number;
  github_username: string;
  display_name: string | null;
  avatar_url: string | null;
  joined_at: number;
  last_seen_at: number | null;
  binding_status: BindingStatus;
  binding_last_checked_at: number | null;
  device_count: number;
  prs_merged: number;
  features_shipped: number;
  activity_events: number;
}

interface RawRow {
  github_user_id: number;
  github_username: string;
  display_name: string | null;
  avatar_url: string | null;
  joined_at: Date | string;
  last_seen_at: Date | string | null;
  binding_status: BindingStatus;
  binding_last_checked_at: Date | string | null;
  device_attestations: unknown;
  prs_merged: string | number | null;
  features_shipped: string | number | null;
  activity_events: string | number | null;
}

function toMs(v: Date | string | null): number | null {
  if (v === null) return null;
  if (v instanceof Date) return v.getTime();
  return new Date(v).getTime();
}

function toCount(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

function deviceCount(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  return raw.length;
}

const list = defineTool({
  method: 'GET',
  path: '/harness/:slug/contributors',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const workspaceId = activeWorkspaceId();
    const { sql } = getOrgPg();
    const rows = (await sql<RawRow[]>`
      SELECT
        c.github_user_id,
        c.github_username,
        c.display_name,
        c.avatar_url,
        c.joined_at,
        c.last_seen_at,
        c.binding_status,
        c.binding_last_checked_at,
        c.device_attestations,
        -- Tier sources MIRROR lib/user-profile/load.ts (P-072b) +
        -- lib/harness-insights/load-contributors-tab.ts so the Contributors tab
        -- and the user profile show IDENTICAL tier numbers. (Previously this used
        -- harness_feature_prs / harness_features.shipped_by_github_id, which have
        -- no producer outside the gated substrate — inert + inconsistent.)
        (
          SELECT COUNT(*) FROM harness_shared.auto_review_audit a
          WHERE a.workspace_id = c.workspace_id
            AND a.harness_slug = c.harness_slug
            AND a.author_github_id = c.github_user_id
            AND a.action IN ('auto_merge', 'manual_merge')
        ) AS prs_merged,
        (
          SELECT COUNT(*) FROM harness_shared.harness_features_consolidated f
          WHERE f.workspace_id = c.workspace_id
            AND f.harness_slug = c.harness_slug
            AND f.status = 'shipped'
            AND f.taken_by = c.github_user_id::text
        ) AS features_shipped,
        -- contributor_usage_events is a federated substrate table keyed by
        -- harness_slug only (NO workspace_id column, unlike the tier-A/B
        -- tables above). Mirrors lib/user-profile/load.ts §3b.
        (
          SELECT COUNT(*) FROM harness_shared.contributor_usage_events e
          WHERE e.harness_slug = c.harness_slug
            AND e.github_user_id = c.github_user_id
        ) AS activity_events
      FROM harness_shared.contributors c
      WHERE c.workspace_id = ${workspaceId}
        AND c.harness_slug = ${slug}
      ORDER BY c.joined_at DESC
    `) as unknown as RawRow[];

    const contributors: ContributorListRow[] = rows.map((r) => {
      // P-048d / §0.2.7: only verified bindings aggregate stats. Zero the tiers
      // for unverified/pending contributors server-side (the panel also greys
      // them). Mirrors load-contributors-tab.ts + statsAggregateForStatus.
      const aggregate = statsAggregateForStatus(r.binding_status);
      return {
        github_user_id: r.github_user_id,
        github_username: r.github_username,
        display_name: r.display_name,
        avatar_url: r.avatar_url,
        joined_at: toMs(r.joined_at) ?? 0,
        last_seen_at: toMs(r.last_seen_at),
        binding_status: r.binding_status,
        binding_last_checked_at: toMs(r.binding_last_checked_at),
        device_count: deviceCount(r.device_attestations),
        prs_merged: aggregate ? toCount(r.prs_merged) : 0,
        features_shipped: aggregate ? toCount(r.features_shipped) : 0,
        activity_events: aggregate ? toCount(r.activity_events) : 0,
      };
    });

    return Response.json({ contributors });
  },
});

export default [list];
