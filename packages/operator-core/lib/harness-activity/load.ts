/**
 * loadHarnessActivity — Insights ActivityFeedCard data source.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24
 *       (P-073b real-data follow-up).
 *
 * Aggregates the last N events for one harness from:
 *   - harness_shared.harness_features_consolidated  → feature_shipped (tier B)
 *   - harness_shared.auto_review_audit              → pr_merged       (tier A)
 *   - harness_shared.contributors                    → contributor_joined (C)
 *   - harness_shared.claim_audit                     → escalation_opened  (C)
 * plus optional tier-A GitHub-sourced events (merged PRs from the GitHub
 * API, via `opts.githubEvents`), interleaved + deduped against the PG
 * ledger by `tsEpoch` / `dedupKey` (P-003).
 *
 * Pure logic — takes an injectable `runQuery` so tests fake PG. Sorts
 * client-side by `tsEpoch` desc, dedupes by `dedupKey`, slices to `limit`.
 * Defensive: missing-table errors yield empty arrays so the consumer
 * renders the empty state rather than 500-ing.
 *
 * Decision-added events are absent because plan revisions live in a
 * separate schema (plan_revisions) and tying them to a harness is its
 * own join — folded into the next follow-up.
 */

import type {
  ActivityFeedEvent,
  ActivityKind,
} from '../harness-insights/card-types';

export interface LoadHarnessActivityOpts {
  workspace_id: string;
  harness_slug: string;
  limit?: number;
  runQuery: <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;
  /**
   * URL builder for each event kind. Optional; null hrefs render as
   * non-clickable rows in the card.
   */
  buildHref?: (
    kind: ActivityKind,
    refId: string,
  ) => string | null;
  /**
   * Tier-A GitHub-sourced events (e.g. merged PRs from the GitHub API)
   * to interleave with the PG ledger. Sorted with the PG events by
   * `tsEpoch` desc and deduped by `dedupKey` — when a GitHub event and a
   * PG event share a `dedupKey` (a merged PR seen in both the local
   * `auto_review_audit` ledger and the GitHub API), the GitHub (tier-A,
   * verifiable) event wins. Optional; omitted (no token / no remote)
   * degrades to the PG-only feed.
   */
  githubEvents?: ActivityFeedEvent[];
}

interface ShippedRow {
  feature_id: string;
  title: string;
  updated_ts: string | number;
  taken_by: string | null;
}

interface MergedPrRow {
  id: string;
  pr_number: number;
  pr_url: string | null;
  author_github_id: string | number | null;
  ts: string | Date;
}

interface ContributorJoinedRow {
  github_username: string;
  joined_at: string | Date;
}

interface ClaimAuditRow {
  id: string;
  feature_id: string;
  claimer_github_user_id: string | number | null;
  outcome: string | null;
  ts: string | Date;
}

function asEpoch(v: string | number | Date): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function relTime(ts: number): string {
  const ageMs = Date.now() - ts;
  if (ageMs < 0) return 'just now';
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  return `${w}w ago`;
}

const DEFAULT_HREF: NonNullable<LoadHarnessActivityOpts['buildHref']> = () => null;

export async function loadHarnessActivity(
  opts: LoadHarnessActivityOpts,
): Promise<ActivityFeedEvent[]> {
  const { workspace_id, harness_slug, runQuery } = opts;
  const limit = opts.limit ?? 20;
  const buildHref = opts.buildHref ?? DEFAULT_HREF;
  // Over-fetch each source by `limit`; merge + sort + slice once.
  const perSource = limit;

  const out: ActivityFeedEvent[] = [];

  // 1) feature_shipped — features whose status flipped to shipped.
  try {
    const shipped = await runQuery<ShippedRow>(
      `SELECT feature_id, title, updated_ts, taken_by
         FROM harness_shared.harness_features_consolidated
        WHERE workspace_id = $1
          AND harness_slug = $2
          AND status = 'shipped'
        ORDER BY updated_ts DESC
        LIMIT $3`,
      [workspace_id, harness_slug, perSource],
    );
    for (const r of shipped) {
      const ts = asEpoch(r.updated_ts);
      out.push({
        id: `feature-${r.feature_id}`,
        kind: 'feature_shipped',
        text: `shipped ${r.feature_id} — ${r.title}`,
        actorLogin: r.taken_by ?? 'unknown',
        whenLabel: relTime(ts),
        href: buildHref('feature_shipped', r.feature_id),
        tsEpoch: ts,
      });
    }
  } catch {
    // missing table — skip
  }

  // 2) pr_merged — auto_review_audit rows with action='auto_merge' or 'manual_merge'.
  try {
    const merged = await runQuery<MergedPrRow>(
      `SELECT id::text AS id, pr_number, pr_url, author_github_id, ts
         FROM harness_shared.auto_review_audit
        WHERE workspace_id = $1
          AND harness_slug = $2
          AND action IN ('auto_merge', 'manual_merge')
        ORDER BY ts DESC
        LIMIT $3`,
      [workspace_id, harness_slug, perSource],
    );
    for (const r of merged) {
      const ts = asEpoch(r.ts);
      out.push({
        id: `pr-${r.id}`,
        kind: 'pr_merged',
        text: `merged PR #${r.pr_number}`,
        actorLogin: r.author_github_id ? String(r.author_github_id) : 'unknown',
        whenLabel: relTime(ts),
        href: r.pr_url ?? buildHref('pr_merged', String(r.pr_number)),
        tsEpoch: ts,
        // Dedupe key shared with the GitHub-sourced merged-PR event so the
        // two collapse to one (the tier-A GitHub event wins). Mirrors
        // github-facts.ts `prDedupKey`.
        dedupKey: `pr:${r.pr_number}`,
      });
    }
  } catch {
    // missing table — skip
  }

  // 3) contributor_joined — new contributors rows for this harness.
  try {
    const joined = await runQuery<ContributorJoinedRow>(
      `SELECT github_username, joined_at
         FROM harness_shared.contributors
        WHERE workspace_id = $1
          AND harness_slug = $2
        ORDER BY joined_at DESC
        LIMIT $3`,
      [workspace_id, harness_slug, perSource],
    );
    for (const r of joined) {
      const ts = asEpoch(r.joined_at);
      out.push({
        id: `contrib-${r.github_username}-${ts}`,
        kind: 'contributor_joined',
        text: `joined as contributor`,
        actorLogin: r.github_username,
        whenLabel: relTime(ts),
        href: buildHref('contributor_joined', r.github_username),
        tsEpoch: ts,
      });
    }
  } catch {
    // missing table — skip
  }

  // 4) escalation_opened — claim_audit rows with outcome='lost-permission'
  //    or other distinctive markers. The card's escalation kind covers
  //    "something went wrong" generally; we surface lost-permission
  //    rows since they're the most user-actionable.
  try {
    const claimRows = await runQuery<ClaimAuditRow>(
      `SELECT id::text AS id, feature_id, claimer_github_user_id, outcome, ts
         FROM harness_shared.claim_audit
        WHERE workspace_id = $1
          AND harness_slug = $2
          AND outcome IS NOT NULL
          AND outcome <> 'won'
        ORDER BY ts DESC
        LIMIT $3`,
      [workspace_id, harness_slug, perSource],
    );
    for (const r of claimRows) {
      const ts = asEpoch(r.ts);
      out.push({
        id: `claim-${r.id}`,
        kind: 'escalation_opened',
        text: `claim on ${r.feature_id}: ${r.outcome}`,
        actorLogin: r.claimer_github_user_id
          ? String(r.claimer_github_user_id)
          : 'unknown',
        whenLabel: relTime(ts),
        href: buildHref('escalation_opened', r.feature_id),
        tsEpoch: ts,
      });
    }
  } catch {
    // missing table — skip
  }

  // Interleave the PG ledger with the tier-A GitHub events, sort by real
  // timestamp desc, dedupe, and cap. Now that every event carries a
  // `tsEpoch`, the sort is recency-correct (no more lossy whenLabel
  // reverse-engineering).
  return mergeActivityEvents(out, opts.githubEvents ?? [], limit);
}

/**
 * PURE: merge two activity-event streams (PG ledger + GitHub) into one
 * recency-sorted, deduped, capped list.
 *
 * - Sort by `tsEpoch` desc (events without a `tsEpoch` sort last).
 * - Dedupe by `dedupKey`: when two events share a key, keep the GitHub
 *   one (tier-A, verifiable straight from the API) over the PG ledger
 *   one. Events without a key are never deduped against each other.
 * - Slice to `limit`.
 *
 * Exported for unit testing the merge/dedup independently of PG.
 */
export function mergeActivityEvents(
  pgEvents: ActivityFeedEvent[],
  githubEvents: ActivityFeedEvent[],
  limit: number,
): ActivityFeedEvent[] {
  const byKey = new Map<string, ActivityFeedEvent>();
  const unkeyed: ActivityFeedEvent[] = [];

  // GitHub events first so they win the dedupe on key collision; PG events
  // only fill keys GitHub didn't already claim.
  for (const e of githubEvents) {
    if (e.dedupKey) byKey.set(e.dedupKey, e);
    else unkeyed.push(e);
  }
  for (const e of pgEvents) {
    if (e.dedupKey) {
      if (!byKey.has(e.dedupKey)) byKey.set(e.dedupKey, e);
    } else {
      unkeyed.push(e);
    }
  }

  const all = [...byKey.values(), ...unkeyed];
  all.sort((a, b) => {
    const ta = a.tsEpoch ?? -Infinity;
    const tb = b.tsEpoch ?? -Infinity;
    if (ta !== tb) return tb - ta;
    return a.id.localeCompare(b.id);
  });
  return all.slice(0, limit);
}
