/**
 * "What the learning loop produced" — the provenance union.
 *
 * (learning-tab-surface-public-release-2026-07-27 P-001 / D-002.)
 *
 * ## Why this module exists
 *
 * The Learning tab's Improve view answers ONE question: *what did the learning
 * loop actually produce?* That question has no single column, and no single tag,
 * because Scout provenance is written by three different code paths that have
 * drifted apart. Measured 2026-07-27 on the live workspace:
 *
 * | record | rows | written by |
 * |---|---|---|
 * | `payload.sourceRole = 'Scout'`        | 615 | `capture-core` at capture |
 * | topic `improvement-source:Scout`      | 662 | `capture-core` at capture (same call!) |
 * | a `scout_routed_ideas.routed_ref` row | 585 | Scout's router |
 * | **union**                             | **823** | |
 *
 * Pairwise they overlap only ~422. The topic adds 45 rows the payload lacks even
 * though the SAME capture call writes both, and the router's table adds ~163 more.
 * So picking any ONE of them silently drops 20-30% of the loop's output — which is
 * precisely the bug the Learning tab already shipped: the Ideas view read
 * `scout_routed_ideas` while the Backlog read the topic, so the two views disagreed
 * about the same population under two different names and nobody could see it.
 *
 * This module therefore unions all three. That is a READ-LAYER WORKAROUND, not the
 * fix: the durable fix is a single writer (or one derived view) owning this
 * provenance so the records cannot drift — tracked as **WI-6338**, which also owes a
 * recurrence guard that fails when the three sets diverge. Until that lands, every
 * consumer must use this function rather than re-deriving "is it Scout's" locally,
 * or the drift simply reappears in a new place.
 *
 * ## Why an id set rather than a predicate
 *
 * The three records live in three tables with no shared join key usable inside
 * `listIssues`' existing single-topic EXISTS. Resolving the union once and passing
 * it to {@link ListIssuesFilter.issueIds} keeps the filter IN Postgres (so `limit`
 * still means what it says) without teaching the generic issue reader about Scout.
 */

import { getOrgPg } from '@papercusp/db-org';
import { issuesScopeWorkspace } from '../../issues-engineer';
import { coordScopeWorkspace } from '../../agent-tools/coordination/log';

type Sql = ReturnType<typeof getOrgPg>['sql'];

/**
 * The `sourceRole` value Scout captures under, and the `improvement-source:<role>`
 * topic suffix built from it (`capture-core.ts`: `topics.push('improvement-source:' + sourceRole)`).
 * ONE constant so the payload leg and the topic leg cannot key on different spellings.
 */
export const SCOUT_SOURCE_ROLE = 'Scout';
export const SCOUT_SOURCE_TOPIC = `improvement-source:${SCOUT_SOURCE_ROLE}`;

/** Per-record counts, for the divergence guard WI-6338 owes and for diagnostics. */
export interface LoopOutputProvenanceCounts {
  /** Rows carrying `payload.sourceRole = 'Scout'`. */
  bySourceRole: number;
  /** Rows tagged the `improvement-source:Scout` topic. */
  byTopic: number;
  /** Rows referenced by a `scout_routed_ideas.routed_ref = 'wi:<id>'`. */
  byRoutedIdea: number;
  /** Size of the union — what the Improve view actually shows. */
  union: number;
}

export interface LoopOutputIds {
  ids: string[];
  counts: LoopOutputProvenanceCounts;
}

/**
 * Resolve the union of every issue id the learning loop can claim authorship of.
 *
 * ONE round trip. Returns the ids plus the per-record counts, so a caller (or the
 * WI-6338 guard) can see the divergence rather than only its resolution.
 *
 * Deliberately NOT origin-filtered here: origin (`organic` vs drill/replay/shadow)
 * is the *reader's* policy and `read-items.ts` owns that default. This function
 * answers only "whose idea was it", and intersecting it with the reader's own
 * filters happens in SQL when the ids are passed to `listIssues`.
 */
export async function readLoopOutputIds(sqlOverride?: Sql): Promise<LoopOutputIds> {
  const sql = sqlOverride ?? getOrgPg().sql;
  const issuesWs = issuesScopeWorkspace();
  // coord_links is scoped by the COORD workspace, which is NOT guaranteed to equal
  // the issues workspace — issues-engineer.ts documents that desync explicitly. Use
  // the same resolver listIssues' own topic EXISTS uses, or the topic leg silently
  // returns nothing while the other two legs work.
  const coordWs = coordScopeWorkspace();

  const rows = await sql<{ issue_id: string; via: string }[]>`
      SELECT ei.issue_id, 'sourceRole' AS via
        FROM harness_shared.engineer_issues ei
       WHERE ei.workspace_id = ${issuesWs}
         AND ei.payload ->> 'sourceRole' = ${SCOUT_SOURCE_ROLE}
    UNION ALL
      SELECT cl.src_ref AS issue_id, 'topic' AS via
        FROM harness_shared.coord_links cl
       WHERE cl.workspace_id = ${coordWs}
         AND cl.rel = 'tagged'
         AND cl.src_kind = 'issue'
         AND cl.dst_kind = 'topic'
         AND cl.dst_ref = ${SCOUT_SOURCE_TOPIC}
    UNION ALL
      SELECT DISTINCT substring(r.routed_ref from 4) AS issue_id, 'routedIdea' AS via
        FROM harness_shared.scout_routed_ideas r
       WHERE r.workspace_id = ${issuesWs}
         AND r.routed_ref LIKE 'wi:%'
  `;

  const union = new Set<string>();
  const counts: LoopOutputProvenanceCounts = {
    bySourceRole: 0,
    byTopic: 0,
    byRoutedIdea: 0,
    union: 0,
  };
  for (const row of rows) {
    const id = row.issue_id;
    if (!id) continue;
    union.add(id);
    if (row.via === 'sourceRole') counts.bySourceRole += 1;
    else if (row.via === 'topic') counts.byTopic += 1;
    else counts.byRoutedIdea += 1;
  }
  counts.union = union.size;
  return { ids: [...union], counts };
}

/**
 * How far apart the three provenance records are, as a fraction of the union.
 *
 * `0` = all three agree perfectly; `1` = no id is recorded by every writer. This is
 * the measurement the WI-6338 recurrence guard asserts on — the point being that a
 * ~50% disagreement went unnoticed for as long as it did precisely because nothing
 * ever computed it.
 */
export function provenanceDivergence(counts: LoopOutputProvenanceCounts): number {
  if (counts.union === 0) return 0;
  const agreedEverywhere = Math.min(counts.bySourceRole, counts.byTopic, counts.byRoutedIdea);
  return 1 - agreedEverywhere / counts.union;
}
