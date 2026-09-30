/**
 * loadContributorsTab — data source for the Phase-8 P-048 Contributors tab.
 *
 * The richer sibling of `loadHarnessPeople` (the Insights PeopleCard): one row
 * per contributor of a harness, enriched with the binding-status badge input
 * (P-048a), per-tier activity counts (P-071 tier-A merged-PRs / tier-B
 * features-shipped / tier-C activity), joined date, and a device count (the
 * collapsed devices section). Pure — injectable `runQuery`.
 *
 * Trust-model invariant (P-048d / §0.2.7 / binding-verifier-types
 * `statsAggregateForStatus`): a contributor whose binding is NOT verified gets
 * **zeroed** tier stats — no stat aggregation happens for unverified/pending
 * bindings. The UI greys those rows.
 *
 * Tier queries mirror the per-user definitions in `lib/user-profile/load.ts`
 * (the authoritative tier source), inverted to GROUP BY the contributor for a
 * single harness.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24 P-048.
 */

import { type BindingStatus, statsAggregateForStatus } from '../identity/binding-verifier-types';

export interface ContributorTabRow {
  github_user_id: number;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
  binding_status: BindingStatus;
  joined_at: number;
  device_count: number;
  /** Tier-A merged PRs. Zeroed when the binding is not verified. */
  prs_merged: number;
  /** Tier-B features shipped. Zeroed when the binding is not verified. */
  features_shipped: number;
  /** Tier-C activity events. Zeroed when the binding is not verified. */
  activity_events: number;
}

export interface LoadContributorsTabOpts {
  workspace_id: string;
  harness_slug: string;
  limit?: number;
  runQuery: <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;
}

interface RawContributor {
  github_user_id: string | number;
  github_username: string;
  display_name: string | null;
  avatar_url: string | null;
  joined_at: Date | string | number;
  device_attestations: unknown;
}

interface CountRow {
  github_user_id: string | number;
  n: string | number;
}

function toInt(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toEpoch(v: Date | string | number): number {
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

/**
 * Per-contributor binding status from the row's `device_attestations`.
 * Mirrors `load-people.ts pickBindingStatus`: any verified device →
 * verified; else any unverified-but-present (`verified === false`) →
 * pending; else unverified.
 */
export function bindingStatusFromAttestations(raw: unknown): BindingStatus {
  if (!Array.isArray(raw) || raw.length === 0) return 'unverified';
  let anyVerified = false;
  let anyPending = false;
  for (const a of raw) {
    if (a && typeof a === 'object') {
      const verified = (a as { verified?: boolean }).verified;
      if (verified === true) anyVerified = true;
      if (verified === false) anyPending = true;
    }
  }
  if (anyVerified) return 'verified';
  if (anyPending) return 'pending';
  return 'unverified';
}

function deviceCount(raw: unknown): number {
  return Array.isArray(raw) ? raw.length : 0;
}

export async function loadContributorsTab(
  opts: LoadContributorsTabOpts,
): Promise<ContributorTabRow[]> {
  const { workspace_id, harness_slug, runQuery } = opts;
  const limit = opts.limit ?? 200;

  let contributors: RawContributor[] = [];
  try {
    contributors = await runQuery<RawContributor>(
      `SELECT github_user_id, github_username, display_name, avatar_url,
              joined_at, device_attestations
         FROM harness_shared.contributors
        WHERE workspace_id = $1 AND harness_slug = $2
        ORDER BY joined_at DESC
        LIMIT $3`,
      [workspace_id, harness_slug, limit],
    );
  } catch {
    return [];
  }
  if (contributors.length === 0) return [];

  const countMap = async (
    query: string,
    params: unknown[] = [workspace_id, harness_slug],
  ): Promise<Map<number, number>> => {
    try {
      const rows = await runQuery<CountRow>(query, params);
      return new Map(rows.map((r) => [toInt(r.github_user_id), toInt(r.n)]));
    } catch {
      return new Map();
    }
  };

  // tier-A: merged PRs authored by the contributor (auto_review_audit).
  const prsByUser = await countMap(
    `SELECT author_github_id AS github_user_id, COUNT(*) AS n
       FROM harness_shared.auto_review_audit
      WHERE workspace_id = $1 AND harness_slug = $2
        AND action IN ('auto_merge', 'manual_merge')
      GROUP BY author_github_id`,
  );
  // tier-B: features shipped by the contributor (taken_by, status='shipped').
  const shippedByUser = await countMap(
    `SELECT taken_by::bigint AS github_user_id, COUNT(*) AS n
       FROM harness_shared.harness_features_consolidated
      WHERE workspace_id = $1 AND harness_slug = $2
        AND status = 'shipped' AND taken_by IS NOT NULL
      GROUP BY taken_by`,
  );
  // tier-C: activity events (contributor_usage_events — the §7.1 source).
  // NB: contributor_usage_events is a federated substrate table keyed by
  // harness_slug only — it has NO workspace_id column (unlike auto_review_audit
  // / harness_features_consolidated). Filter on harness_slug alone, mirroring
  // lib/user-profile/load.ts §3b.
  const activityByUser = await countMap(
    `SELECT github_user_id, COUNT(*) AS n
       FROM harness_shared.contributor_usage_events
      WHERE harness_slug = $1
      GROUP BY github_user_id`,
    [harness_slug],
  );

  return contributors.map((c) => {
    const id = toInt(c.github_user_id);
    const binding_status = bindingStatusFromAttestations(c.device_attestations);
    // P-048d: only verified bindings aggregate stats; else zero them.
    const aggregate = statsAggregateForStatus(binding_status);
    return {
      github_user_id: id,
      login: c.github_username,
      display_name: c.display_name,
      avatar_url: c.avatar_url,
      binding_status,
      joined_at: toEpoch(c.joined_at),
      device_count: deviceCount(c.device_attestations),
      prs_merged: aggregate ? (prsByUser.get(id) ?? 0) : 0,
      features_shipped: aggregate ? (shippedByUser.get(id) ?? 0) : 0,
      activity_events: aggregate ? (activityByUser.get(id) ?? 0) : 0,
    };
  });
}

export type ContributorSortKey = 'joined' | 'prs' | 'features' | 'activity';

/**
 * Pure comparator for P-048c sorting. `joined` is recency (newest first);
 * the tier columns sort by count descending, with a stable login tiebreak.
 */
export function compareContributors(
  a: ContributorTabRow,
  b: ContributorTabRow,
  key: ContributorSortKey,
): number {
  let primary = 0;
  switch (key) {
    case 'joined':
      primary = b.joined_at - a.joined_at;
      break;
    case 'prs':
      primary = b.prs_merged - a.prs_merged;
      break;
    case 'features':
      primary = b.features_shipped - a.features_shipped;
      break;
    case 'activity':
      primary = b.activity_events - a.activity_events;
      break;
  }
  return primary !== 0 ? primary : a.login.localeCompare(b.login);
}
