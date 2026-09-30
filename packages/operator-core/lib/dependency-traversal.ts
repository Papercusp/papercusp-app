/**
 * Cross-store dependency traversal.
 *
 * Plan-item dependencies and work-item dependencies deliberately have different
 * stores and identities:
 *
 *   - plan items: harness_plans.items / the normalized plan_items index;
 *   - plan-item <-> work-item coverage: source-plan stamps plus legacy
 *     coord_links `implements` edges;
 *   - work items: canonical work_item_deps;
 *   - typed external blockers: work_items.payload.externalBlockers.
 *
 * Consumers must not stitch those surfaces together independently. This module
 * executes ONE recursive PostgreSQL query over the union graph and returns the
 * reached nodes and edges. Later renderers may rank, diff, or draw the result;
 * this module owns only graph truth.
 */
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { getOrgPg } from '@papercusp/db-org';
import { ALL_TERMINAL_STATUSES } from './work-item-blocking';
import { getDependencyPolicy, type DependencyPolicyFinding } from './scheduler/dependency-invariants';
import {
  PG_READ_QUERY_CALL_OVERHEAD_MS,
  PG_READ_QUERY_HARD_TIMEOUT_MS,
  SET_LOCAL_UTC,
  callTimeoutMessage,
  withCallDeadline,
} from './pg-read-query';

export type DependencyTraversalDirection = 'blockers' | 'blocked';

export type DependencyTraversalStart =
  | { kind: 'plan_item'; planSlug: string; itemId: string }
  | { kind: 'work_item'; id: string };

export type DependencyTraversalNodeKind = 'plan_item' | 'work_item' | 'external';

export interface DependencyTraversalNode {
  key: string;
  kind: DependencyTraversalNodeKind;
  ref: string;
  status: string | null;
  title: string | null;
  harnessSlug: string | null;
  planSlug: string | null;
  itemId: string | null;
  depth: number;
}

export type DependencyTraversalRelation =
  | 'plan-blocks'
  | 'work-item-blocks'
  | 'coverage'
  | 'external-blocker';

/**
 * Edges use the storage/readiness orientation: subject -> dependency.
 * For a blocking edge, `subjectKey` is the blocked item and `dependencyKey` is
 * the blocker. Coverage is identity-like and is traversed in both directions.
 */
export interface DependencyTraversalEdge {
  key: string;
  subjectKey: string;
  dependencyKey: string;
  relation: DependencyTraversalRelation;
  externalRef: string | null;
}

export interface DependencyTraversalResult {
  startKey: string;
  direction: DependencyTraversalDirection;
  found: boolean;
  nodes: DependencyTraversalNode[];
  edges: DependencyTraversalEdge[];
  truncated: boolean;
  maxDepth: number;
}

export interface DependencyBottleneckCandidate {
  key: string;
  kind: DependencyTraversalNodeKind;
  ref: string;
  status: string | null;
  title: string | null;
  /** Work-item identities represented by this graph node (itself and/or coverage twins). */
  workItemRefs: string[];
  /** Canonical work-item progress, sourced only from work_items.last_progress_at. */
  lastProgressAt: string | null;
  /** Distinct nonterminal plan items transitively blocked behind this node. */
  openBlockedCount: number;
}

export interface DependencyBottleneckPopulation {
  kind: 'exact-plan-open-roots';
  planSlug: string;
  harnessSlug: string;
  basis: 'unified-dependency-graph';
  openRoots: number;
  candidates: number;
  shown: number;
  limit: number;
  truncated: boolean;
  depthLimited: boolean;
  maxDepth: number;
}

export interface DependencyBottleneckGraphNode {
  key: string;
  kind: DependencyTraversalNodeKind;
  ref: string;
  status: string | null;
  title: string | null;
}

export interface DependencyBottleneckGraph {
  nodes: DependencyBottleneckGraphNode[];
  edges: DependencyTraversalEdge[];
}

export interface DependencyBottleneckResult {
  population: DependencyBottleneckPopulation;
  rows: DependencyBottleneckCandidate[];
  /** Additive for callers constructing older snapshots; the live reader always emits it. */
  findings?: DependencyPolicyFinding[];
  /** Present only when the caller requested the human-review graph projection. */
  graph?: DependencyBottleneckGraph;
}

interface DependencyTraversalRow {
  node_key: string;
  node_kind: DependencyTraversalNodeKind;
  ref: string;
  status: string | null;
  title: string | null;
  harness_slug: string | null;
  plan_slug: string | null;
  item_id: string | null;
  depth: number | string;
  edge_key: string | null;
  subject_key: string | null;
  dependency_key: string | null;
  relation: DependencyTraversalRelation | null;
  external_ref: string | null;
  hit_depth_limit: boolean;
}

type DependencyQueryParams = Array<string | number | boolean | string[]>;

type DependencyTraversalQuery = (
  text: string,
  params: DependencyQueryParams,
) => Promise<DependencyTraversalRow[]>;

interface DependencyBottleneckRow {
  row_kind: 'population' | 'bottleneck' | 'graph_node' | 'graph_edge';
  blocker_key: string | null;
  blocker_kind: DependencyTraversalNodeKind | null;
  blocker_ref: string | null;
  blocker_status: string | null;
  blocker_title: string | null;
  work_item_refs: string[] | null;
  last_progress_at: string | null;
  open_blocked_count: number | string | null;
  open_root_count: number | string;
  candidate_count: number | string;
  depth_limited: boolean;
  graph_subject_key: string | null;
  graph_dependency_key: string | null;
  graph_relation: DependencyTraversalRelation | null;
  graph_external_ref: string | null;
}

type DependencyBottleneckQuery = (
  text: string,
  params: DependencyQueryParams,
) => Promise<DependencyBottleneckRow[]>;

type DependencyQueryClient = ReturnType<typeof getOrgPg>['sql'];

const ISSUE_FAMILY_KINDS = ['bug', 'change', 'task'];
const PLAN_ITEM_RE = /^P-\d{3,}$/;
const WORK_ITEM_RE = /^(?:WI|EI|F)-\d+$/i;

export const DEFAULT_DEPENDENCY_TRAVERSAL_MAX_DEPTH = 64;

/**
 * Traversal is a read-only diagnostic, but it is also the query that exposed
 * orphaned recursive backends. Keep the server-side cap and the client-side
 * acquire/execute deadline in one place, borrowing the proven pg-read-query
 * hard ceiling instead of creating a second timeout policy. This graph query
 * builds several cross-store CTEs before it can rank a small exact-plan result;
 * the generic 5s read default is too short for a healthy graph (the live exact
 * plan read measured ~8s), while the shared 30s hard ceiling still bounds a
 * runaway backend.
 */
export const DEPENDENCY_QUERY_TIMEOUT_MS = PG_READ_QUERY_HARD_TIMEOUT_MS;

async function runDependencyQuery<T>(
  text: string,
  params: DependencyQueryParams,
  injectedQuery?: (text: string, params: DependencyQueryParams) => Promise<T[]>,
  client?: DependencyQueryClient,
): Promise<T[]> {
  if (injectedQuery) return injectedQuery(text, params);

  const sql = client ?? getOrgPg().sql;
  const callDeadlineMs = DEPENDENCY_QUERY_TIMEOUT_MS + PG_READ_QUERY_CALL_OVERHEAD_MS;
  let rows: T[] = [];
  const work = sql.begin(async (tx) => {
    await tx.unsafe('SET TRANSACTION READ ONLY');
    await tx.unsafe(`SET LOCAL statement_timeout = ${DEPENDENCY_QUERY_TIMEOUT_MS}`);
    await tx.unsafe(SET_LOCAL_UTC);
    rows = (await tx.unsafe(text, params as never[])) as unknown as T[];
  });
  await withCallDeadline(work, callDeadlineMs, callTimeoutMessage(DEPENDENCY_QUERY_TIMEOUT_MS, callDeadlineMs));
  return rows;
}

/**
 * Resolve a work-item identity only from a typed blocker's stable ref.
 *
 * Event/gate refs commonly namespace their owning item (for example
 * `harness:papercusp:wi-40086-qualified-current-tip`). We intentionally do not
 * inspect summary/evidence prose: prose can mention many items and is not an
 * identity surface.
 */
export function workItemIdFromExternalBlockerRef(ref: string): string | null {
  const match = /(?:^|[^a-z0-9])((?:WI|EI|F)-\d+)(?=$|[^a-z0-9])/i.exec(ref);
  return match?.[1]?.toUpperCase() ?? null;
}

export function dependencyTraversalStartKey(start: DependencyTraversalStart): string {
  if (start.kind === 'plan_item') {
    const planSlug = start.planSlug.trim();
    const itemId = start.itemId.trim().toUpperCase();
    if (!planSlug || !PLAN_ITEM_RE.test(itemId)) {
      throw new Error('plan-item traversal start requires a non-empty planSlug and a P-NNN itemId');
    }
    return `plan_item:${planSlug}#${itemId}`;
  }
  const id = start.id.trim().toUpperCase();
  if (!WORK_ITEM_RE.test(id)) {
    throw new Error('work-item traversal start requires a WI-/EI-/F- numeric id');
  }
  return `work_item:${id}`;
}

/**
 * ONE query builds and traverses the union graph. Parameters:
 *   $1 workspace id; $2 harness; $3 coordination workspace; $4 start key;
 *   $5 direction; $6 max depth; $7 issue-family kinds.
 *
 * `raw_plan_nodes` keeps the normalized index authoritative while retaining the
 * rebuildable harness_plans.items compatibility leg. Coverage uses the same
 * precedence as planStampOf(): payload.plan_item wins for the plan namespace and
 * its item id is unioned with source_plan_item_ids. Legacy `implements` links are
 * retained because they are the reconciliation substrate for rows predating the
 * column/payload stamps.
 */
/**
 * Build the shared graph CTEs, optionally scoped to one exact plan.
 *
 * Traversal still uses the unscoped form below: it accepts an arbitrary start
 * node and must preserve the full-harness graph. Bottleneck ranking has a
 * different, known seed (the requested plan), so its graph source can avoid
 * normalizing every plan and running the expensive coverage stamp extraction
 * for every work item. Work nodes remain harness-wide in the scoped form so
 * transitive blockers and their canonical metadata are not discarded.
 */
function dependencyGraphCtes(planSlugParam?: string): string {
  const planItemScope = planSlugParam ? ` AND pi.plan_slug = ${planSlugParam}` : '';
  const harnessPlanScope = planSlugParam ? ` AND hp.plan_slug = ${planSlugParam}` : '';
  const coverageWorkNodes = planSlugParam ? 'stamped_work_nodes' : 'work_nodes';
  const stampedWorkNodes = planSlugParam
    ? `stamped_work_nodes AS (
  SELECT wn.*
    FROM work_nodes wn
   WHERE wn.source_plan_slug = ${planSlugParam}
      OR wn.payload -> 'plan_item' ->> 'plan_slug' = ${planSlugParam}
),
`
    : '';

  return String.raw`
raw_plan_nodes AS (
  SELECT 0 AS source_rank,
         'plan_item:' || pi.plan_slug || '#' || pi.item_id AS node_key,
         pi.plan_slug,
         pi.item_id,
         pi.status,
         pi.item_text AS title,
         pi.blocked_by
    FROM harness_shared.plan_items pi
   WHERE pi.workspace_id = $1 AND pi.harness_slug = $2${planItemScope}
  UNION ALL
  SELECT 1 AS source_rank,
         'plan_item:' || hp.plan_slug || '#' || (item ->> 'id') AS node_key,
         hp.plan_slug,
         item ->> 'id' AS item_id,
         COALESCE(NULLIF(item ->> 'status', ''), 'todo') AS status,
         COALESCE(item ->> 'text', '') AS title,
         COALESCE(
           ARRAY(SELECT jsonb_array_elements_text(COALESCE(item -> 'blockedBy', '[]'::jsonb))),
           ARRAY[]::text[]
         ) AS blocked_by
    FROM harness_shared.harness_plans hp
   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(hp.items, '[]'::jsonb)) AS item
   WHERE hp.workspace_id = $1 AND hp.harness_slug = $2${harnessPlanScope}
     AND item ->> 'id' ~ '^P-[0-9]{3,}$'
),
plan_nodes AS (
  SELECT DISTINCT ON (node_key)
         node_key, plan_slug, item_id, status, title, blocked_by
    FROM raw_plan_nodes
   ORDER BY node_key, source_rank
),
work_nodes AS (
  SELECT 'work_item:' || upper(wi.feature_id) AS node_key,
         upper(wi.feature_id) AS item_id,
         wi.status,
         COALESCE(wi.title, wi.summary, wi.feature_id) AS title,
         wi.harness_slug,
         wi.item_kind,
         wi.payload,
         wi.source_plan_slug,
         wi.source_plan_item_ids,
         wi.last_progress_at,
         CASE WHEN wi.item_kind = ANY($7::text[]) THEN 'issue' ELSE 'feature' END AS endpoint_kind,
         CASE WHEN wi.item_kind = ANY($7::text[])
              THEN upper(wi.feature_id)
              ELSE wi.harness_slug || '#' || upper(wi.feature_id)
          END AS endpoint_ref
    FROM harness_shared.work_items wi
   WHERE wi.workspace_id = $1 AND wi.harness_slug = $2
),
${stampedWorkNodes}
plan_edges AS (
  SELECT 'plan-blocks:' || blocked.plan_slug || '#' || blocked.item_id || '<-' || blocker_id AS edge_key,
         blocked.node_key AS subject_key,
         'plan_item:' || blocked.plan_slug || '#' || blocker_id AS dependency_key,
         'plan-blocks'::text AS relation,
         NULL::text AS external_ref
    FROM plan_nodes blocked
   CROSS JOIN LATERAL unnest(blocked.blocked_by) AS blocker_id
),
column_coverage AS (
  SELECT DISTINCT
         'coverage:column:' || pn.plan_slug || '#' || pn.item_id || '<->' || wn.item_id AS edge_key,
         pn.node_key AS subject_key,
         wn.node_key AS dependency_key,
         'coverage'::text AS relation,
         NULL::text AS external_ref
    FROM ${coverageWorkNodes} wn
   CROSS JOIN LATERAL (
     SELECT COALESCE(
              NULLIF(btrim(wn.payload -> 'plan_item' ->> 'plan_slug'), ''),
              NULLIF(btrim(wn.source_plan_slug), '')
            ) AS plan_slug,
            ARRAY(
              SELECT DISTINCT candidate
                FROM unnest(
                  ARRAY_REMOVE(
                    ARRAY[
                      CASE
                        WHEN wn.payload -> 'plan_item' ->> 'item_id' ~ '^P-[0-9]{3,}$'
                        THEN wn.payload -> 'plan_item' ->> 'item_id'
                        ELSE NULL
                      END
                    ],
                    NULL
                  ) || COALESCE(wn.source_plan_item_ids, ARRAY[]::text[])
                ) AS candidate
               WHERE candidate ~ '^P-[0-9]{3,}$'
            ) AS item_ids
   ) stamp
    JOIN plan_nodes pn
      ON pn.plan_slug = stamp.plan_slug AND pn.item_id = ANY(stamp.item_ids)
),
link_coverage AS (
  SELECT DISTINCT
         'coverage:link:' || pn.plan_slug || '#' || pn.item_id || '<->' || wn.item_id AS edge_key,
         pn.node_key AS subject_key,
         wn.node_key AS dependency_key,
         'coverage'::text AS relation,
         NULL::text AS external_ref
    FROM harness_shared.coord_links link
    JOIN work_nodes wn
      ON wn.endpoint_kind = link.src_kind AND wn.endpoint_ref = link.src_ref
    JOIN plan_nodes pn
      ON pn.plan_slug || '#' || pn.item_id = link.dst_ref
   WHERE link.workspace_id IN ($1, $3)
     AND link.rel = 'implements' AND link.dst_kind = 'plan_item'
),
coverage_edges AS (
  SELECT DISTINCT ON (subject_key, dependency_key)
         edge_key, subject_key, dependency_key, relation, external_ref
    FROM (
      SELECT * FROM column_coverage
      UNION ALL
      SELECT * FROM link_coverage
    ) coverage
   ORDER BY subject_key, dependency_key, edge_key
),
work_edges AS (
  SELECT 'work-item-blocks:' || dep.blocked_kind || ':' || dep.blocked_ref || '<-' ||
         dep.blocker_kind || ':' || dep.blocker_ref AS edge_key,
         COALESCE(blocked.node_key, 'dependency:' || dep.blocked_kind || ':' || dep.blocked_ref) AS subject_key,
         COALESCE(blocker.node_key, 'dependency:' || dep.blocker_kind || ':' || dep.blocker_ref) AS dependency_key,
         'work-item-blocks'::text AS relation,
         NULL::text AS external_ref
    FROM harness_shared.work_item_deps dep
    LEFT JOIN work_nodes blocked
      ON blocked.endpoint_kind = dep.blocked_kind AND blocked.endpoint_ref = dep.blocked_ref
    LEFT JOIN work_nodes blocker
      ON blocker.endpoint_kind = dep.blocker_kind AND blocker.endpoint_ref = dep.blocker_ref
   WHERE dep.workspace_id = $3 AND dep.dep_type = 'blocks'
),
link_block_edges AS (
  SELECT 'coord-link-blocks:' || link.id AS edge_key,
         COALESCE(blocked_work.node_key, blocked_plan.node_key,
                  'dependency:' || link.dst_kind || ':' || link.dst_ref) AS subject_key,
         COALESCE(blocker_work.node_key, blocker_plan.node_key,
                  'dependency:' || link.src_kind || ':' || link.src_ref) AS dependency_key,
         'work-item-blocks'::text AS relation,
         NULL::text AS external_ref
    FROM harness_shared.coord_links link
    LEFT JOIN work_nodes blocker_work
      ON blocker_work.endpoint_kind = link.src_kind AND blocker_work.endpoint_ref = link.src_ref
    LEFT JOIN work_nodes blocked_work
      ON blocked_work.endpoint_kind = link.dst_kind AND blocked_work.endpoint_ref = link.dst_ref
    LEFT JOIN plan_nodes blocker_plan
      ON link.src_kind = 'plan_item'
     AND blocker_plan.plan_slug || '#' || blocker_plan.item_id = link.src_ref
    LEFT JOIN plan_nodes blocked_plan
      ON link.dst_kind = 'plan_item'
     AND blocked_plan.plan_slug || '#' || blocked_plan.item_id = link.dst_ref
   WHERE link.workspace_id IN ($1, $3)
     AND link.rel = 'blocks'
     -- work_item_deps is authoritative when BOTH endpoints resolve to work
     -- items. coord_links remains authoritative for polymorphic blocks such as
     -- issue -> plan_item, and for an endpoint outside this harness's graph.
     AND NOT (blocker_work.node_key IS NOT NULL AND blocked_work.node_key IS NOT NULL)
),
external_edge_data AS (
  SELECT wn.node_key AS subject_key,
         blocker ->> 'ref' AS external_ref,
         substring(upper(blocker ->> 'ref') from '(WI-[0-9]+|EI-[0-9]+|F-[0-9]+)') AS work_item_id,
         blocker ->> 'kind' AS blocker_kind
    FROM work_nodes wn
   CROSS JOIN LATERAL jsonb_array_elements(
     CASE
       WHEN jsonb_typeof(wn.payload -> 'externalBlockers') = 'array'
       THEN wn.payload -> 'externalBlockers'
       ELSE '[]'::jsonb
     END
   ) AS blocker
   WHERE blocker ->> 'status' = 'active'
     AND blocker ->> 'ref' <> ''
),
external_edges AS (
  SELECT 'external-blocker:' || data.subject_key || '<-' || data.external_ref AS edge_key,
         data.subject_key,
         COALESCE(target.node_key, 'external:' || COALESCE(NULLIF(data.blocker_kind, ''), 'unknown') || ':' || data.external_ref) AS dependency_key,
         'external-blocker'::text AS relation,
         data.external_ref
    FROM external_edge_data data
    LEFT JOIN work_nodes target ON target.item_id = data.work_item_id
),
all_edges AS (
  SELECT * FROM plan_edges
  UNION ALL SELECT * FROM work_edges
  UNION ALL SELECT * FROM link_block_edges
  UNION ALL SELECT * FROM coverage_edges
  UNION ALL SELECT * FROM external_edges
),
placeholder_nodes AS (
  SELECT DISTINCT edge_key AS node_key,
         CASE WHEN edge_key LIKE 'plan_item:%' THEN 'plan_item' ELSE 'external' END AS node_kind,
         CASE WHEN edge_key LIKE 'plan_item:%#%'
              THEN substring(edge_key from '#(P-[0-9]+)$')
              ELSE regexp_replace(edge_key, '^[^:]+:[^:]*:', '')
          END AS ref,
         NULL::text AS status,
         NULL::text AS title,
         NULL::text AS harness_slug,
         CASE WHEN edge_key LIKE 'plan_item:%#%'
              THEN substring(edge_key from '^plan_item:(.*)#P-[0-9]+$')
              ELSE NULL
          END AS plan_slug,
         CASE WHEN edge_key LIKE 'plan_item:%#%'
              THEN substring(edge_key from '#(P-[0-9]+)$')
              ELSE NULL
          END AS item_id
    FROM (
      SELECT subject_key AS edge_key FROM all_edges
      UNION
      SELECT dependency_key AS edge_key FROM all_edges
    ) edge_keys
   WHERE NOT EXISTS (SELECT 1 FROM plan_nodes pn WHERE pn.node_key = edge_key)
     AND NOT EXISTS (SELECT 1 FROM work_nodes wn WHERE wn.node_key = edge_key)
),
all_nodes AS (
  SELECT pn.node_key, 'plan_item'::text AS node_kind, pn.item_id AS ref,
         pn.status, pn.title, $2::text AS harness_slug, pn.plan_slug, pn.item_id,
         NULL::timestamptz AS last_progress_at
    FROM plan_nodes pn
  UNION ALL
  SELECT wn.node_key, 'work_item'::text AS node_kind, wn.item_id AS ref,
         wn.status, wn.title, wn.harness_slug, NULL::text AS plan_slug, wn.item_id,
         wn.last_progress_at
    FROM work_nodes wn
  UNION ALL
  SELECT placeholder.node_key, placeholder.node_kind, placeholder.ref,
         placeholder.status, placeholder.title, placeholder.harness_slug,
         placeholder.plan_slug, placeholder.item_id, NULL::timestamptz AS last_progress_at
    FROM placeholder_nodes placeholder
)
`;
}

const DEPENDENCY_GRAPH_CTES = dependencyGraphCtes();
const DEPENDENCY_BOTTLENECK_GRAPH_CTES = dependencyGraphCtes('$9');

const DEPENDENCY_TRAVERSAL_SQL = String.raw`
WITH RECURSIVE
${DEPENDENCY_GRAPH_CTES},
frontier_walk(frontier_keys, visited_keys, depth) AS (
  SELECT ARRAY[$4::text], ARRAY[$4::text], 0
  UNION ALL
  SELECT next_frontier.frontier_keys,
         walk.visited_keys || next_frontier.frontier_keys,
         walk.depth + 1
    FROM frontier_walk walk
   CROSS JOIN LATERAL (
     SELECT COALESCE(array_agg(next_step.next_key ORDER BY next_step.next_key), ARRAY[]::text[]) AS frontier_keys
       FROM (
         SELECT DISTINCT CASE
                  WHEN edge.relation = 'coverage' AND edge.subject_key = current.node_key
                    THEN edge.dependency_key
                  WHEN edge.relation = 'coverage' AND edge.dependency_key = current.node_key
                    THEN edge.subject_key
                  WHEN $5 = 'blockers' AND edge.subject_key = current.node_key
                    THEN edge.dependency_key
                  WHEN $5 = 'blocked' AND edge.dependency_key = current.node_key
                    THEN edge.subject_key
                END AS next_key
           FROM unnest(walk.frontier_keys) AS current(node_key)
           JOIN all_edges edge
             ON (edge.relation = 'coverage' AND current.node_key IN (edge.subject_key, edge.dependency_key))
             OR ($5 = 'blockers' AND edge.subject_key = current.node_key)
             OR ($5 = 'blocked' AND edge.dependency_key = current.node_key)
       ) next_step
      WHERE next_step.next_key IS NOT NULL
        AND NOT next_step.next_key = ANY(walk.visited_keys)
   ) next_frontier
   WHERE walk.depth < $6
     AND cardinality(next_frontier.frontier_keys) > 0
),
reachable_nodes AS (
  SELECT $4::text AS node_key, 0 AS depth
  UNION ALL
  SELECT unnest(walk.frontier_keys), walk.depth
    FROM frontier_walk walk
   WHERE walk.depth > 0
),
reachable_nodes_dedup AS (
  SELECT node_key, min(depth)::int AS depth
    FROM reachable_nodes
   GROUP BY node_key
),
frontier_depth_limit AS (
  SELECT COALESCE(bool_or(
           next_step.next_key IS NOT NULL
           AND NOT next_step.next_key = ANY(walk.visited_keys)
         ), false) AS hit_depth_limit
    FROM frontier_walk walk
   CROSS JOIN LATERAL unnest(walk.frontier_keys) AS current(node_key)
   LEFT JOIN LATERAL (
     SELECT CASE
              WHEN edge.relation = 'coverage' AND edge.subject_key = current.node_key
                THEN edge.dependency_key
              WHEN edge.relation = 'coverage' AND edge.dependency_key = current.node_key
                THEN edge.subject_key
              WHEN $5 = 'blockers' AND edge.subject_key = current.node_key
                THEN edge.dependency_key
              WHEN $5 = 'blocked' AND edge.dependency_key = current.node_key
                THEN edge.subject_key
            END AS next_key
       FROM all_edges edge
      WHERE (edge.relation = 'coverage' AND current.node_key IN (edge.subject_key, edge.dependency_key))
         OR ($5 = 'blockers' AND edge.subject_key = current.node_key)
         OR ($5 = 'blocked' AND edge.dependency_key = current.node_key)
   ) next_step ON true
   WHERE walk.depth = $6
),
reachable_edges AS (
  SELECT DISTINCT ON (edge.edge_key)
         edge.edge_key, edge.subject_key, edge.dependency_key, edge.relation, edge.external_ref,
         subject.depth AS subject_depth, dependency.depth AS dependency_depth
    FROM all_edges edge
    JOIN reachable_nodes_dedup subject ON subject.node_key = edge.subject_key
    JOIN reachable_nodes_dedup dependency ON dependency.node_key = edge.dependency_key
   WHERE edge.relation = 'coverage'
      OR ($5 = 'blockers' AND edge.subject_key = subject.node_key)
      OR ($5 = 'blocked' AND edge.dependency_key = dependency.node_key)
   ORDER BY edge.edge_key
)
SELECT node.node_key,
       node.node_kind,
       node.ref,
       node.status,
       node.title,
       node.harness_slug,
       node.plan_slug,
       node.item_id,
       walk.depth,
       NULL::text AS edge_key,
       NULL::text AS subject_key,
       NULL::text AS dependency_key,
       NULL::text AS relation,
       NULL::text AS external_ref,
       (walk.depth = $6 AND (SELECT hit_depth_limit FROM frontier_depth_limit)) AS hit_depth_limit
  FROM reachable_nodes_dedup walk
  JOIN all_nodes node ON node.node_key = walk.node_key
UNION ALL
SELECT node.node_key,
       node.node_kind,
       node.ref,
       node.status,
       node.title,
       node.harness_slug,
       node.plan_slug,
       node.item_id,
       destination.depth,
       edge.edge_key,
       edge.subject_key,
       edge.dependency_key,
       edge.relation,
       edge.external_ref,
       false AS hit_depth_limit
  FROM reachable_edges edge
  JOIN reachable_nodes_dedup subject ON subject.node_key = edge.subject_key
  JOIN reachable_nodes_dedup dependency ON dependency.node_key = edge.dependency_key
  JOIN reachable_nodes_dedup destination
    ON destination.node_key = CASE
         WHEN edge.relation = 'coverage'
           THEN CASE WHEN subject.depth >= dependency.depth THEN subject.node_key ELSE dependency.node_key END
         WHEN $5 = 'blockers' THEN dependency.node_key
         ELSE subject.node_key
       END
  JOIN all_nodes node ON node.node_key = destination.node_key
 ORDER BY depth, node_key, edge_key NULLS FIRST
`;

/**
 * Rank the blockers behind one exact plan in ONE query over the same graph CTE
 * used by traverseDependencies. The population row is unconditional, so an
 * empty measured result remains distinguishable from an unread/failed query.
 *
 * Parameters extend the traversal contract with $8 terminal statuses, $9 exact
 * plan slug, $10 row limit and $11 whether to return the graph rows used by the
 * optional human renderer. The graph projection remains part of this ONE SQL
 * execution; enabling it never starts a second traversal.
 */
const DEPENDENCY_BOTTLENECK_SQL = String.raw`
WITH RECURSIVE
${DEPENDENCY_BOTTLENECK_GRAPH_CTES},
-- The shared graph parameter contract reserves $4/$5 for traversal start and
-- direction. This ranking query does not consume either value, but PostgreSQL
-- still requires every supplied positional parameter to have a resolvable type.
parameter_contract AS (
  SELECT $4::text AS unused_start_key, $5::text AS unused_direction
),
plan_roots AS (
  SELECT node_key
    FROM plan_nodes
   WHERE plan_slug = $9
     AND NOT (lower(COALESCE(status, 'todo')) = ANY($8::text[]))
),
-- Walk once from the small exact-plan root set toward blockers. The old query
-- seeded one reverse walk per candidate blocker, so a plan with four roots and
-- hundreds of candidates repeatedly scanned the whole graph before discovering
-- which candidates could reach a root. Reversing that relation preserves the
-- reachable-node relation while making the recursion proportional to the exact
-- plan's frontier instead of the global candidate population.
root_walk(root_key, frontier_keys, visited_keys, depth) AS (
  SELECT root.node_key, ARRAY[root.node_key], ARRAY[root.node_key], 0
    FROM plan_roots root
  UNION ALL
  SELECT walk.root_key,
         next_frontier.frontier_keys,
         walk.visited_keys || next_frontier.frontier_keys,
         walk.depth + 1
    FROM root_walk walk
   CROSS JOIN LATERAL (
     SELECT COALESCE(array_agg(next_step.next_key ORDER BY next_step.next_key), ARRAY[]::text[]) AS frontier_keys
       FROM (
         SELECT DISTINCT CASE
                  WHEN edge.relation = 'coverage' AND edge.subject_key = current.node_key
                    THEN edge.dependency_key
                  WHEN edge.relation = 'coverage' AND edge.dependency_key = current.node_key
                    THEN edge.subject_key
                  WHEN edge.relation <> 'coverage' AND edge.subject_key = current.node_key
                    THEN edge.dependency_key
                END AS next_key
           FROM unnest(walk.frontier_keys) AS current(node_key)
           JOIN all_edges edge
             ON (edge.relation = 'coverage' AND current.node_key IN (edge.subject_key, edge.dependency_key))
             OR (edge.relation <> 'coverage' AND edge.subject_key = current.node_key)
       ) next_step
      WHERE next_step.next_key IS NOT NULL
        AND NOT next_step.next_key = ANY(walk.visited_keys)
   ) next_frontier
   WHERE walk.depth < $6
     AND cardinality(next_frontier.frontier_keys) > 0
),
root_reachable AS (
  SELECT node_key AS root_key, node_key, 0 AS depth
    FROM plan_roots
  UNION ALL
  SELECT walk.root_key, unnest(walk.frontier_keys), walk.depth
    FROM root_walk walk
   WHERE walk.depth > 0
),
root_reachable_dedup AS (
  SELECT root_key, node_key, min(depth)::int AS depth
    FROM root_reachable
   GROUP BY root_key, node_key
),
depth_limit_signal AS (
  SELECT walk.root_key,
         current.node_key AS blocker_key,
         bool_or(next_step.next_key IS NOT NULL
                 AND NOT next_step.next_key = ANY(walk.visited_keys)) AS depth_limited
    FROM root_walk walk
   CROSS JOIN LATERAL unnest(walk.frontier_keys) AS current(node_key)
   LEFT JOIN LATERAL (
     SELECT CASE
              WHEN edge.relation = 'coverage' AND edge.subject_key = current.node_key
                THEN edge.dependency_key
              WHEN edge.relation = 'coverage' AND edge.dependency_key = current.node_key
                THEN edge.subject_key
              WHEN edge.relation <> 'coverage' AND edge.subject_key = current.node_key
                THEN edge.dependency_key
            END AS next_key
       FROM all_edges edge
      WHERE (edge.relation = 'coverage' AND current.node_key IN (edge.subject_key, edge.dependency_key))
         OR (edge.relation <> 'coverage' AND edge.subject_key = current.node_key)
   ) next_step ON true
   WHERE walk.depth = $6
   GROUP BY walk.root_key, current.node_key
),
candidate_depth_signal AS (
  SELECT blocker_key, bool_or(depth_limited) AS depth_limited
    FROM depth_limit_signal
   GROUP BY blocker_key
),
candidate_blockers AS (
  SELECT DISTINCT edge.dependency_key AS blocker_key
    FROM all_edges edge
    JOIN all_nodes blocker ON blocker.node_key = edge.dependency_key
    JOIN root_reachable_dedup reached ON reached.node_key = edge.dependency_key
   WHERE edge.relation <> 'coverage'
     AND (blocker.status IS NULL OR NOT (lower(blocker.status) = ANY($8::text[])))
),
candidate_identity AS (
  SELECT blocker_key, blocker_key AS identity_key
    FROM candidate_blockers
  UNION
  SELECT candidate.blocker_key,
         CASE
           WHEN edge.subject_key = candidate.blocker_key THEN edge.dependency_key
           ELSE edge.subject_key
         END AS identity_key
    FROM candidate_blockers candidate
    JOIN all_edges edge
      ON edge.relation = 'coverage'
     AND candidate.blocker_key IN (edge.subject_key, edge.dependency_key)
),
ranked AS (
  SELECT candidate.blocker_key,
         blocker.node_kind AS blocker_kind,
         blocker.ref AS blocker_ref,
         blocker.status AS blocker_status,
         blocker.title AS blocker_title,
         ARRAY(
           SELECT DISTINCT represented.ref
             FROM candidate_identity identity
             JOIN all_nodes represented ON represented.node_key = identity.identity_key
            WHERE identity.blocker_key = candidate.blocker_key
              AND represented.node_kind = 'work_item'
            ORDER BY represented.ref
         ) AS work_item_refs,
         (
           SELECT max(represented.last_progress_at)::text
             FROM candidate_identity identity
             JOIN all_nodes represented ON represented.node_key = identity.identity_key
            WHERE identity.blocker_key = candidate.blocker_key
              AND represented.node_kind = 'work_item'
         ) AS last_progress_at,
         count(DISTINCT root.node_key)::int AS open_blocked_count,
         COALESCE(depth_signal.depth_limited, false) AS depth_limited
    FROM candidate_blockers candidate
    JOIN all_nodes blocker ON blocker.node_key = candidate.blocker_key
    JOIN root_reachable_dedup reached ON reached.node_key = candidate.blocker_key
    JOIN plan_roots root ON root.node_key = reached.root_key
    LEFT JOIN candidate_depth_signal depth_signal ON depth_signal.blocker_key = candidate.blocker_key
   WHERE NOT EXISTS (
     SELECT 1
       FROM candidate_identity identity
      WHERE identity.blocker_key = candidate.blocker_key
        AND identity.identity_key = root.node_key
   )
   GROUP BY candidate.blocker_key, blocker.node_kind, blocker.ref, blocker.status, blocker.title,
            depth_signal.depth_limited
  HAVING count(DISTINCT root.node_key) > 0
),
ordered AS (
  SELECT *, row_number() OVER (ORDER BY open_blocked_count DESC, blocker_key) AS rank
    FROM ranked
),
population AS (
  SELECT count(*)::int AS candidate_count,
         (SELECT count(*)::int FROM plan_roots) AS open_root_count,
         COALESCE(bool_or(depth_limited), false) AS depth_limited
    FROM ranked
),
rooted_blockers AS (
  SELECT DISTINCT candidate.blocker_key
    FROM candidate_blockers candidate
   WHERE $11::boolean
),
rooted_roots AS (
  SELECT DISTINCT reached.root_key
    FROM root_reachable_dedup reached
    JOIN rooted_blockers rooted ON rooted.blocker_key = reached.node_key
   WHERE $11::boolean
),
graph_edges AS (
  SELECT DISTINCT ON (edge.subject_key, edge.dependency_key, edge.relation)
         edge.edge_key,
         edge.subject_key,
         edge.dependency_key,
         edge.relation,
         edge.external_ref
    FROM all_edges edge
    JOIN root_reachable_dedup subject_scope
      ON subject_scope.node_key = edge.subject_key
    JOIN root_reachable_dedup dependency_scope
      ON dependency_scope.node_key = edge.dependency_key
    JOIN rooted_roots rooted ON rooted.root_key = subject_scope.root_key
                             AND rooted.root_key = dependency_scope.root_key
   WHERE $11::boolean
   ORDER BY edge.subject_key, edge.dependency_key, edge.relation, edge.edge_key
),
graph_node_keys AS (
  SELECT node_key FROM plan_roots WHERE $11::boolean
  UNION
  SELECT reached.node_key
    FROM root_reachable_dedup reached
    JOIN rooted_roots rooted ON rooted.root_key = reached.root_key
   WHERE $11::boolean
  UNION
  SELECT subject_key FROM graph_edges
  UNION
  SELECT dependency_key FROM graph_edges
)
SELECT 'population'::text AS row_kind,
       NULL::text AS blocker_key,
       NULL::text AS blocker_kind,
       NULL::text AS blocker_ref,
       NULL::text AS blocker_status,
       NULL::text AS blocker_title,
       NULL::text[] AS work_item_refs,
       NULL::text AS last_progress_at,
       NULL::int AS open_blocked_count,
       population.open_root_count,
       population.candidate_count,
       population.depth_limited,
       NULL::text AS graph_subject_key,
       NULL::text AS graph_dependency_key,
       NULL::text AS graph_relation,
       NULL::text AS graph_external_ref
  FROM population
UNION ALL
SELECT 'bottleneck'::text AS row_kind,
       ordered.blocker_key,
       ordered.blocker_kind,
       ordered.blocker_ref,
       ordered.blocker_status,
       ordered.blocker_title,
       ordered.work_item_refs,
       ordered.last_progress_at,
       ordered.open_blocked_count,
       population.open_root_count,
       population.candidate_count,
       population.depth_limited,
       NULL::text AS graph_subject_key,
       NULL::text AS graph_dependency_key,
       NULL::text AS graph_relation,
       NULL::text AS graph_external_ref
  FROM ordered
 CROSS JOIN population
 WHERE ordered.rank <= $10
UNION ALL
SELECT 'graph_node'::text AS row_kind,
       node.node_key AS blocker_key,
       node.node_kind AS blocker_kind,
       node.ref AS blocker_ref,
       node.status AS blocker_status,
       node.title AS blocker_title,
       NULL::text[] AS work_item_refs,
       NULL::text AS last_progress_at,
       NULL::int AS open_blocked_count,
       population.open_root_count,
       population.candidate_count,
       population.depth_limited,
       NULL::text AS graph_subject_key,
       NULL::text AS graph_dependency_key,
       NULL::text AS graph_relation,
       NULL::text AS graph_external_ref
  FROM graph_node_keys keys
  JOIN all_nodes node ON node.node_key = keys.node_key
 CROSS JOIN population
UNION ALL
SELECT 'graph_edge'::text AS row_kind,
       edge.edge_key AS blocker_key,
       NULL::text AS blocker_kind,
       NULL::text AS blocker_ref,
       NULL::text AS blocker_status,
       NULL::text AS blocker_title,
       NULL::text[] AS work_item_refs,
       NULL::text AS last_progress_at,
       NULL::int AS open_blocked_count,
       population.open_root_count,
       population.candidate_count,
       population.depth_limited,
       edge.subject_key AS graph_subject_key,
       edge.dependency_key AS graph_dependency_key,
       edge.relation AS graph_relation,
       edge.external_ref AS graph_external_ref
  FROM graph_edges edge
 CROSS JOIN population
 ORDER BY row_kind DESC, open_blocked_count DESC NULLS LAST, blocker_key NULLS LAST
`;

export async function traverseDependencies(
  args: {
    workspaceId: string;
    harnessSlug: string;
    start: DependencyTraversalStart;
    direction?: DependencyTraversalDirection;
    maxDepth?: number;
    coordinationWorkspaceId?: string;
  },
  deps: { query?: DependencyTraversalQuery; client?: DependencyQueryClient } = {},
): Promise<DependencyTraversalResult> {
  const workspaceId = args.workspaceId.trim();
  const harnessSlug = args.harnessSlug.trim();
  if (!workspaceId || !harnessSlug) throw new Error('dependency traversal requires workspaceId and harnessSlug');
  const startKey = dependencyTraversalStartKey(args.start);
  const direction = args.direction ?? 'blockers';
  const maxDepth = Math.max(1, Math.min(256, Math.floor(args.maxDepth ?? DEFAULT_DEPENDENCY_TRAVERSAL_MAX_DEPTH)));
  const coordinationWorkspaceId = args.coordinationWorkspaceId?.trim() || DEFAULT_COORD_WORKSPACE;
  const rows = await runDependencyQuery<DependencyTraversalRow>(DEPENDENCY_TRAVERSAL_SQL, [
    workspaceId,
    harnessSlug,
    coordinationWorkspaceId,
    startKey,
    direction,
    maxDepth,
    ISSUE_FAMILY_KINDS,
  ], deps.query, deps.client);

  const nodes = new Map<string, DependencyTraversalNode>();
  const edges = new Map<string, DependencyTraversalEdge>();
  let truncated = false;
  for (const row of rows) {
    const depth = Number(row.depth);
    const current = nodes.get(row.node_key);
    if (!current || depth < current.depth) {
      nodes.set(row.node_key, {
        key: row.node_key,
        kind: row.node_kind,
        ref: row.ref,
        status: row.status,
        title: row.title,
        harnessSlug: row.harness_slug,
        planSlug: row.plan_slug,
        itemId: row.item_id,
        depth,
      });
    }
    if (
      row.edge_key &&
      row.subject_key &&
      row.dependency_key &&
      row.relation
    ) {
      edges.set(row.edge_key, {
        key: row.edge_key,
        subjectKey: row.subject_key,
        dependencyKey: row.dependency_key,
        relation: row.relation,
        externalRef: row.external_ref,
      });
    }
    if (row.hit_depth_limit) truncated = true;
  }

  return {
    startKey,
    direction,
    found: nodes.has(startKey),
    nodes: [...nodes.values()].sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key)),
    edges: [...edges.values()].sort((a, b) => a.key.localeCompare(b.key)),
    truncated,
    maxDepth,
  };
}

export async function readDependencyBottlenecks(
  args: {
    workspaceId: string;
    harnessSlug: string;
    planSlug: string;
    maxDepth?: number;
    limit?: number;
    includeGraph?: boolean;
    coordinationWorkspaceId?: string;
  },
  deps: { query?: DependencyBottleneckQuery; client?: DependencyQueryClient } = {},
): Promise<DependencyBottleneckResult> {
  const workspaceId = args.workspaceId.trim();
  const harnessSlug = args.harnessSlug.trim();
  const planSlug = args.planSlug.trim();
  if (!workspaceId || !harnessSlug || !planSlug) {
    throw new Error('dependency bottleneck read requires workspaceId, harnessSlug, and planSlug');
  }
  const maxDepth = Math.max(1, Math.min(256, Math.floor(args.maxDepth ?? DEFAULT_DEPENDENCY_TRAVERSAL_MAX_DEPTH)));
  const limit = Math.max(1, Math.min(50, Math.floor(args.limit ?? 10)));
  const coordinationWorkspaceId = args.coordinationWorkspaceId?.trim() || DEFAULT_COORD_WORKSPACE;
  const rows = await runDependencyQuery<DependencyBottleneckRow>(DEPENDENCY_BOTTLENECK_SQL, [
    workspaceId,
    harnessSlug,
    coordinationWorkspaceId,
    '',
    'blocked',
    maxDepth,
    ISSUE_FAMILY_KINDS,
    [...ALL_TERMINAL_STATUSES].map((status) => status.toLowerCase()),
    planSlug,
    limit,
    true,
  ], deps.query, deps.client);
  const populationRow = rows.find((row) => row.row_kind === 'population');
  if (!populationRow) throw new Error('dependency bottleneck query returned no population row');
  const candidates = Number(populationRow.candidate_count);
  const openRoots = Number(populationRow.open_root_count);
  const bottlenecks = rows
    .filter((row) => row.row_kind === 'bottleneck')
    .map((row): DependencyBottleneckCandidate => {
      if (!row.blocker_key || !row.blocker_kind || !row.blocker_ref || row.open_blocked_count == null) {
        throw new Error('dependency bottleneck query returned an incomplete ranked row');
      }
      return {
        key: row.blocker_key,
        kind: row.blocker_kind,
        ref: row.blocker_ref,
        status: row.blocker_status,
        title: row.blocker_title,
        workItemRefs: row.work_item_refs ?? [],
        lastProgressAt: row.last_progress_at,
        openBlockedCount: Number(row.open_blocked_count),
      };
    });
  const measuredGraph = {
        nodes: rows
          .filter((row) => row.row_kind === 'graph_node')
          .map((row): DependencyBottleneckGraphNode => {
            if (!row.blocker_key || !row.blocker_kind || !row.blocker_ref) {
              throw new Error('dependency bottleneck query returned an incomplete graph node');
            }
            return {
              key: row.blocker_key,
              kind: row.blocker_kind,
              ref: row.blocker_ref,
              status: row.blocker_status,
              title: row.blocker_title,
            };
          })
          .sort((a, b) => a.key.localeCompare(b.key)),
        edges: rows
          .filter((row) => row.row_kind === 'graph_edge')
          .map((row): DependencyTraversalEdge => {
            if (
              !row.blocker_key ||
              !row.graph_subject_key ||
              !row.graph_dependency_key ||
              !row.graph_relation
            ) {
              throw new Error('dependency bottleneck query returned an incomplete graph edge');
            }
            return {
              key: row.blocker_key,
              subjectKey: row.graph_subject_key,
              dependencyKey: row.graph_dependency_key,
              relation: row.graph_relation,
              externalRef: row.graph_external_ref,
            };
          })
          .sort((a, b) => a.key.localeCompare(b.key)),
      };
  const highDegreePolicy = getDependencyPolicy('high-degree-node');
  if (!highDegreePolicy) throw new Error('dependency policy high-degree-node is not registered');
  const findings: DependencyPolicyFinding[] = bottlenecks.flatMap((candidate) => {
    const incident = measuredGraph.edges.filter((edge) => edge.dependencyKey === candidate.key);
    // An aggregate transitive count cannot satisfy P-013's exact-edge evidence
    // contract. Stay silent unless this same snapshot carries every direct edge.
    if (incident.length < 4) return [];
    return [{
      code: highDegreePolicy.code,
      classification: highDegreePolicy.classification,
      confidence: highDegreePolicy.confidence,
      nodes: [candidate.key, ...incident.map((edge) => edge.subjectKey)],
      edges: incident.map((edge) => ({ subject: edge.subjectKey, dependency: edge.dependencyKey })),
      evidence: {
        topologyMetrics: { directFanOut: incident.length, openBlockedCount: candidate.openBlockedCount },
        exactEdgesComplete: !populationRow.depth_limited,
      },
      provenance: [...highDegreePolicy.provenance],
      suggestedAction: highDegreePolicy.suggestedAction,
    }];
  });
  return {
    population: {
      kind: 'exact-plan-open-roots',
      planSlug,
      harnessSlug,
      basis: 'unified-dependency-graph',
      openRoots,
      candidates,
      shown: bottlenecks.length,
      limit,
      truncated: candidates > bottlenecks.length,
      depthLimited: populationRow.depth_limited,
      maxDepth,
    },
    rows: bottlenecks,
    findings,
    ...(args.includeGraph ? { graph: measuredGraph } : {}),
  };
}
