/**
 * change-feed-deps.ts — the production WIRING of the Change Feed readers
 * to actual database sources (work_items, gym_proposals, harness_plans).
 *
 * Mirrors the fleet-signals / deps pattern: inject minimal reader contracts
 * so the core `change-feed` normalizer stays pure + testable. The production
 * builder wires the real PG queries.
 *
 * DERIVED, not logged (self-learning-central D-005): every reader queries the
 * completion SOURCE — the unified `work_items` view, `gym_proposals`,
 * `harness_plans` — there is no change_feed table, so "regenerating" the feed
 * is just running these queries again. Each entry carries a `ref` back to the
 * original row.
 *
 * (Rewritten for P-060: the first cut of this file queried an imagined schema
 * — `getOperatorDb()` didn't exist, the work_items view has no `id` column and
 * `taken_at` is timestamptz not epoch-ms, and plan completion lives on
 * `op_status`/`op_updated_at`, not `status='done'`/`finished_at`. Every reader
 * silently returned [] via the core's defensive wrapper, so the production
 * feed regenerated EMPTY. The Phase-7 integration test
 * (change-feed-deps.integration.test.ts) now pins these queries against the
 * real migrated schema.)
 */

import { getOrgPg } from '@papercusp/db-org';
import type { ChangeFeedEntry, ChangeFeedReaders } from './change-feed';

/** ISO timestamp from an epoch-ms bigint column (postgres-js returns bigint as string). */
function epochMsToIso(v: string | number | null): string {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return new Date(Number.isFinite(n) ? n : 0).toISOString();
}

/**
 * The work-item statuses that count as a WINNING terminal, shared with the
 * su-ideate ref-scoped completions read (scout/routed-ledger.ts) so the two
 * paths can never disagree on what "completed" means.
 */
export const CHANGE_FEED_COMPLETION_STATUSES = ['done', 'passed', 'resolved', 'closed'] as const;

/**
 * Work-item completions: rows of the unified `work_items` view (features ∪
 * engineer issues, migrations 159/178) that reached a COMPLETION status AND
 * carry the WI-1403/WI-1405 completion-integrity pair (`terminal_owner` +
 * `terminal_completion_ref`). That excludes watchdog/hygiene/revert dedup
 * flips, which are terminal but are not genuine shipped work. The view's id
 * column is `feature_id`; `updated_ts` (epoch ms) is the lifecycle write that
 * took the item terminal — the completion clock.
 */
async function fetchWorkItemCompletions(): Promise<ChangeFeedEntry[]> {
  const { sql } = getOrgPg();
  const rows = await sql<
    {
      feature_id: string;
      harness_slug: string | null;
      title: string | null;
      status: string | null;
      updated_ts: string | null;
      created_by_github_user_id: string | null;
    }[]
  >`
    SELECT feature_id, harness_slug, title, status, updated_ts, created_by_github_user_id::text
      FROM harness_shared.work_items
     WHERE status = ANY(${[...CHANGE_FEED_COMPLETION_STATUSES]}::text[])
       AND terminal_owner IS NOT NULL AND terminal_owner <> ''
       AND terminal_completion_ref IS NOT NULL AND terminal_completion_ref <> ''
     ORDER BY updated_ts DESC NULLS LAST
     LIMIT 500`;

  return rows.map((r) => ({
    id: `wi:${r.feature_id}`,
    kind: 'completion' as const,
    title: r.title || `Completed: ${r.feature_id}`,
    detail: `Status: ${r.status}`,
    harness: r.harness_slug ?? undefined,
    workItemId: r.feature_id,
    ref: `wi:${r.feature_id}`,
    ts: epochMsToIso(r.updated_ts),
    userRequested: r.created_by_github_user_id != null,
  }));
}

/**
 * Gym proposals that reached a decision (accepted / rejected / superseded).
 * `decided_at` is an epoch-ms bigint (migration 110).
 */
async function fetchGymProposals(): Promise<ChangeFeedEntry[]> {
  const { sql } = getOrgPg();
  const rows = await sql<
    { id: string; harness_slug: string | null; role: string; status: string; decided_at: string }[]
  >`
    SELECT id, harness_slug, role, status, decided_at
      FROM harness_shared.gym_proposals
     WHERE status IN ('accepted', 'rejected', 'superseded')
       AND decided_at IS NOT NULL
     ORDER BY decided_at DESC
     LIMIT 500`;

  const label: Record<string, string> = {
    accepted: 'Accepted',
    rejected: 'Rejected',
    superseded: 'Superseded',
  };
  return rows.map((r) => ({
    id: `gym:${r.id}`,
    kind: 'proposal' as const,
    title: `${label[r.status] ?? r.status} prompt for ${r.role}`,
    detail: `Status: ${r.status}`,
    harness: r.harness_slug ?? undefined,
    ref: `gym:${r.id}`,
    ts: epochMsToIso(r.decided_at),
    userRequested: false,
  }));
}

/**
 * Plan runs that finished: `harness_plans` whose OPERATIONAL status is done.
 * Completion lives on `op_status`/`op_updated_at` (folded from
 * harness_plan_status — migration 122, D-007), NOT the frontmatter `status`
 * column (draft/ready/active/shipped/superseded).
 */
async function fetchPlanRuns(): Promise<ChangeFeedEntry[]> {
  const { sql } = getOrgPg();
  const rows = await sql<
    { plan_slug: string; title: string | null; harness_slug: string; op_updated_at: Date }[]
  >`
    SELECT plan_slug, title, harness_slug, op_updated_at
      FROM harness_shared.harness_plans
     WHERE op_status = 'done'
       AND op_updated_at IS NOT NULL
     ORDER BY op_updated_at DESC
     LIMIT 500`;

  return rows.map((r) => ({
    id: `plan:${r.plan_slug}`,
    kind: 'plan-run' as const,
    title: `Plan completed: ${r.title || r.plan_slug}`,
    harness: r.harness_slug || undefined,
    ref: `plan:${r.plan_slug}`,
    ts: new Date(r.op_updated_at).toISOString(),
    userRequested: false,
  }));
}

/**
 * Build the production ChangeFeedReaders that query the database.
 * The core's `gatherCompletions` wraps each reader defensively so one bad
 * query doesn't kill the entire feed.
 */
export function buildChangeFeedReaders(): ChangeFeedReaders {
  return {
    async workItemCompletions() {
      return fetchWorkItemCompletions();
    },
    async gymProposals() {
      return fetchGymProposals();
    },
    async planRuns() {
      return fetchPlanRuns();
    },
  };
}
