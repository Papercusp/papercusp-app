/**
 * load — user profile data fetcher.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24
 *       (P-072 real data follow-up).
 *
 * Resolves a github_user_id into a UserProfileData via PG reads against:
 *   - harness_shared.contributors          → header + per-harness rows
 *   - harness_shared.harness_features_consolidated → features-shipped
 *   - harness_shared.shared_repo_binding_cache     → claimed_harnesses
 *
 * Pure logic — takes an injectable `runQuery` so tests can fake PG
 * without a postgres instance. Production callers pass a thin wrapper
 * around getOrgPg().sql.unsafe.
 *
 * Defensive about missing tables / empty rows: returns an empty profile
 * if no contributor rows match.
 */

import type {
  ActivityEntry,
  ClaimedHarness,
  HarnessBlock,
  UserProfileData,
} from './types';
import type { BindingStatus } from '../identity/binding-verifier-types';
import type { ClaimStatus } from '../harness/claim-status-types';
import { loadUserRecentActivity } from './load-activity';
import { visibleHarnessesForViewer } from './visible-harnesses';

export interface UserProfileLoadOpts {
  github_user_id: number;
  /**
   * The viewer's `github_user_id` — used for the §18 privacy filter
   * (Q-2): rows from shared-private harnesses where the viewer isn't
   * a member are hidden. When null, only shared-public harnesses
   * appear (anonymous viewer).
   */
  viewer_github_user_id?: number | null;
  /**
   * Inject-able PG query runner. Production: a thin wrapper around
   * `getOrgPg().sql.unsafe(query, params)` returning rows.
   */
  runQuery: <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;
}

interface ContributorRow {
  workspace_id: string;
  harness_slug: string;
  github_user_id: string | number;
  github_username: string;
  display_name: string | null;
  avatar_url: string | null;
  device_attestations: unknown;
  joined_at: string | Date;
}

interface FeaturesShippedRow {
  harness_slug: string;
  features_shipped: string | number;
}

interface BindingRow {
  harness_slug: string;
  claim_status: string;
  privacy: string;
}

function pickBindingStatus(rows: ContributorRow[]): BindingStatus {
  if (rows.length === 0) return 'unverified';
  let anyVerified = false;
  let anyPending = false;
  for (const r of rows) {
    const attestations = Array.isArray(r.device_attestations)
      ? r.device_attestations
      : [];
    for (const a of attestations) {
      if (a && typeof a === 'object') {
        const verified = (a as { verified?: boolean }).verified;
        if (verified === true) anyVerified = true;
        if (verified === false) anyPending = true;
      }
    }
  }
  if (anyVerified) return 'verified';
  if (anyPending) return 'pending';
  return 'unverified';
}

function normalizeClaimStatus(s: string): ClaimStatus {
  if (s === 'claimed' || s === 'unclaimed' || s === 'stale' || s === 'superseded') {
    return s;
  }
  return 'unclaimed';
}

/** Coerce a PG COUNT(*) (returned as a string by node-postgres) to int. */
function toInt(v: string | number): number {
  return typeof v === 'string' ? Number.parseInt(v, 10) || 0 : Number(v) || 0;
}

/**
 * Load a user profile from PG. Empty/missing tables yield an empty
 * profile rather than throwing.
 */
export async function loadUserProfile(
  opts: UserProfileLoadOpts,
): Promise<UserProfileData> {
  const { github_user_id, runQuery } = opts;
  const viewerId = opts.viewer_github_user_id ?? null;

  // 1) Contributor rows for this user — one per (workspace, harness).
  //    Defensive: catch missing-table errors (fresh install before
  //    dogfood ensure ran) and treat as empty.
  let contribRows: ContributorRow[] = [];
  try {
    contribRows = await runQuery<ContributorRow>(
      `SELECT workspace_id, harness_slug, github_user_id, github_username,
              display_name, avatar_url, device_attestations, joined_at
         FROM harness_shared.contributors
        WHERE github_user_id = $1
        ORDER BY joined_at ASC`,
      [github_user_id],
    );
  } catch {
    contribRows = [];
  }

  if (contribRows.length === 0) {
    return {
      github_user_id,
      github_login: `user-${github_user_id}`,
      display_name: null,
      avatar_url: null,
      binding_status: 'unverified',
      harnesses: [],
      recent_activity: [],
      claimed_harnesses: [],
    };
  }

  // Pick the "primary" identity row — most recent display name + avatar.
  const primary = contribRows[contribRows.length - 1]!;

  // 2) Privacy filter — for shared-private harnesses the viewer isn't
  //    in, drop the row. Anonymous viewer (null) only sees shared-public.
  //    Needs binding rows to know privacy; fetch alongside claimed harnesses.
  let bindingRows: BindingRow[] = [];
  try {
    bindingRows = await runQuery<BindingRow>(
      `SELECT harness_slug, claim_status, privacy
         FROM harness_shared.shared_repo_binding_cache
        WHERE workspace_id = ANY($1)`,
      [Array.from(new Set(contribRows.map((r) => r.workspace_id)))],
    );
  } catch {
    bindingRows = [];
  }
  const bindingBySlug = new Map<string, BindingRow>(
    bindingRows.map((b) => [b.harness_slug, b]),
  );

  // viewerHarnessMembership: harnesses the viewer is contributing to (used to
  // unlock shared-private rows).
  let viewerHarnessMembership: Set<string> = new Set();
  if (viewerId != null) {
    try {
      const vrows = await runQuery<{ harness_slug: string }>(
        `SELECT DISTINCT harness_slug
           FROM harness_shared.contributors
          WHERE github_user_id = $1`,
        [viewerId],
      );
      viewerHarnessMembership = new Set(vrows.map((r) => r.harness_slug));
    } catch {
      viewerHarnessMembership = new Set();
    }
  }

  // §18 privacy filter via the `visibleHarnessesForViewer` SEAM. The seam
  // is PURE (no PG) so the real viewer-identity wiring (a known SHARED GAP
  // — the live /adv shell has no viewer-identity resolution; absent it,
  // viewerId is null = anonymous = shared-public-only) is a one-line change
  // at the call site, not a rewrite. See visible-harnesses.ts.
  const visibleSlugSet = new Set(
    visibleHarnessesForViewer({
      subjectGithubUserId: github_user_id,
      viewerGithubUserId: viewerId,
      harnesses: contribRows.map((r) => ({
        harness_slug: r.harness_slug,
        privacy: bindingBySlug.get(r.harness_slug)?.privacy,
      })),
      viewerMembership: viewerHarnessMembership,
    }).map((h) => h.harness_slug),
  );
  function visible(harness_slug: string): boolean {
    return visibleSlugSet.has(harness_slug);
  }

  const visibleContribRows = contribRows.filter((r) => visible(r.harness_slug));

  // 3) Per-harness features-shipped count.
  let featuresShippedRows: FeaturesShippedRow[] = [];
  try {
    featuresShippedRows = await runQuery<FeaturesShippedRow>(
      `SELECT harness_slug, COUNT(*) AS features_shipped
         FROM harness_shared.harness_features_consolidated
        WHERE status = 'shipped'
          AND taken_by = $1
        GROUP BY harness_slug`,
      [String(github_user_id)],
    );
  } catch {
    featuresShippedRows = [];
  }
  const shippedBySlug = new Map<string, number>(
    featuresShippedRows.map((r) => [
      r.harness_slug,
      toInt(r.features_shipped),
    ]),
  );

  // 3a) Per-harness tier-A PRs-merged count — auto_review_audit rows this
  //     user authored that were merged (auto or manual). Mirrors the
  //     loadUserRecentActivity pr_merged source but as a GROUP BY count.
  let prsMergedRows: Array<{ harness_slug: string; prs_merged: string | number }> = [];
  try {
    prsMergedRows = await runQuery(
      `SELECT harness_slug, COUNT(*) AS prs_merged
         FROM harness_shared.auto_review_audit
        WHERE author_github_id = $1
          AND action IN ('auto_merge', 'manual_merge')
        GROUP BY harness_slug`,
      [github_user_id],
    );
  } catch {
    prsMergedRows = [];
  }
  const prsMergedBySlug = new Map<string, number>(
    prsMergedRows.map((r) => [r.harness_slug, toInt(r.prs_merged)]),
  );

  // 3b) Per-harness tier-C activity count — contributor_usage_events is the
  //     source of truth for all tier-C activity stats (v5 §7.1 / D-027;
  //     rollups derived on read, never stored as a mutable counter).
  let activityRows: Array<{ harness_slug: string; activity_events: string | number }> = [];
  try {
    activityRows = await runQuery(
      `SELECT harness_slug, COUNT(*) AS activity_events
         FROM harness_shared.contributor_usage_events
        WHERE github_user_id = $1
        GROUP BY harness_slug`,
      [github_user_id],
    );
  } catch {
    activityRows = [];
  }
  const activityBySlug = new Map<string, number>(
    activityRows.map((r) => [r.harness_slug, toInt(r.activity_events)]),
  );

  const harnesses: HarnessBlock[] = visibleContribRows.map((r) => ({
    harness_slug: r.harness_slug,
    display_title: r.harness_slug,
    href: `/harness/${r.harness_slug}`,
    prs_merged: prsMergedBySlug.get(r.harness_slug) ?? 0,
    features_shipped: shippedBySlug.get(r.harness_slug) ?? 0,
    activity_events: activityBySlug.get(r.harness_slug) ?? 0,
  }));

  // 4) Claimed harnesses — VERIFIED-claimant rows only (P-072d / §5.1).
  //    A verified claimant holds an active GitHub repo permission, i.e.
  //    claim_status='claimed'. `stale` means all claimants LOST that
  //    permission on the daily re-check, so a stale binding is NOT a
  //    verified claim and is omitted from the profile footer.
  //    Falls back to empty when the table isn't present.
  let claimedRows: Array<{
    harness_slug: string;
    claim_status: string;
  }> = [];
  try {
    claimedRows = await runQuery(
      `SELECT harness_slug, claim_status
         FROM harness_shared.shared_repo_binding_cache
        WHERE claim_status = 'claimed'
          AND $1 = ANY(claimed_by_github_user_ids)`,
      [github_user_id],
    );
  } catch {
    claimedRows = [];
  }
  const claimed_harnesses: ClaimedHarness[] = claimedRows
    .filter((c) => visible(c.harness_slug))
    .map((c) => ({
      harness_slug: c.harness_slug,
      display_title: c.harness_slug,
      href: `/harness/${c.harness_slug}`,
      claim_status: normalizeClaimStatus(c.claim_status),
    }));

  // 5) Recent activity feed — cross-harness, scoped to visible harnesses.
  let recent_activity: ActivityEntry[] = [];
  try {
    recent_activity = await loadUserRecentActivity({
      github_user_id,
      visible_harness_slugs: harnesses.map((h) => h.harness_slug),
      runQuery,
    });
  } catch {
    recent_activity = [];
  }

  return {
    github_user_id,
    github_login: primary.github_username,
    display_name: primary.display_name,
    avatar_url: primary.avatar_url,
    binding_status: pickBindingStatus(visibleContribRows),
    harnesses,
    recent_activity,
    claimed_harnesses,
  };
}
