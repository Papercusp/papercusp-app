/**
 * Acceptance-author identity continuity.
 *
 * Coordination identities are intentionally ephemeral, while an acceptance rubric
 * can outlive the session that authored it. `coord:rebind-identity` is the canonical
 * recovery operation: it verifies the predecessor is no longer live, migrates its
 * owner-keyed state, and leaves an audited `tool_invocations` row. Spawned agents
 * also carry durable launcher edges: current su/desktop agents in
 * `adv_sessions.launch_spec.launchedBy`, and operator spawns in
 * `spawned_agents.parent_spawn_id`. This module keeps author-successor continuity
 * (rebinds) distinct from evaluator-independence lineage (rebinds plus launches).
 * Historical rubric/scorecard attribution remains untouched.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { parseWorkedByHistory } from './work-item-prior-work';

export interface AcceptanceAuthorIdentityOpts {
  sql?: Sql;
  workspaceId?: string;
}

/**
 * The directed identity-edge set both lineage readers walk, defined ONCE.
 *
 * There are two consumers — the pairwise {@link areAcceptanceLineageRelated} and
 * the set-based {@link lineagePartyKeys} — and a second hand-written copy of this
 * union is the classic derived-truth drift: a new edge kind added for one reader
 * silently leaves the other answering "unrelated" for parties that are related.
 * Returned as a `postgres` fragment so both spell the same CTE body.
 */
function identityEdges(sql: Sql, workspaceId: string) {
  return sql`
        SELECT args_json->>'from',
               COALESCE(NULLIF(args_json->>'to', ''), coord_owner_id)
          FROM harness_shared.tool_invocations
         WHERE workspace_id = ${workspaceId}
           AND tool_name = 'coord:rebind-identity'
           AND status = 'ok'
           AND args_json->>'from' IS NOT NULL
           AND COALESCE(NULLIF(args_json->>'to', ''), coord_owner_id) IS NOT NULL
        UNION
        -- Migration 1217 maintains this scalar from launch_spec, including
        -- legacy writers. Avoid detoasting every prompt-bearing launch document.
        --
        -- P-005 (review-routing-through-relevance-router-2026-09-26): a session the
        -- consult router dispatched to answer FROM an expert's transcript takes its
        -- lineage from that SOURCE (the consult-dispatch edge below), never from
        -- whoever is recorded as its launcher. The dispatcher records the consult
        -- REQUESTER as launchedBy, so an implementer who routes a review of their
        -- own work would otherwise be the ancestor of every reviewer the router
        -- picks, and the acceptance-BAR amendment apply guard would refuse each
        -- one as the implementer's own descendant. The launch edge is dropped only
        -- where the dispatch edge exists to replace it, so a routed fork is never
        -- left without a lineage; an ordinary launch keeps its launch edge.
        -- (Unaliased on purpose: the performance test rewrites the bare column
        -- name to replay this query against the pre-projection baseline.)
        SELECT launch_parent_owner, coord_owner_id
          FROM harness_shared.adv_sessions
         WHERE workspace_id = ${workspaceId}
           AND launch_parent_owner IS NOT NULL
           AND NULLIF(coord_owner_id, '') IS NOT NULL
           AND NOT EXISTS (
                 SELECT 1
                   FROM harness_shared.consult_state routed
                   CROSS JOIN LATERAL jsonb_array_elements(
                          CASE jsonb_typeof(routed.routing -> 'selection' -> 'selected')
                            WHEN 'array' THEN routed.routing -> 'selection' -> 'selected'
                            ELSE '[]'::jsonb
                          END
                        ) AS routed_sel
                  WHERE routed.workspace_id = ${workspaceId}
                    AND routed_sel->>'answeringOwnerId' = adv_sessions.coord_owner_id
                    AND NULLIF(routed_sel->>'ownerId', '') IS NOT NULL
                    AND routed_sel->>'ownerId' IS DISTINCT FROM routed_sel->>'answeringOwnerId'
               )
        UNION
        SELECT parent_spawn_id, spawn_id
          FROM harness_shared.spawned_agents
         WHERE workspace_id = ${workspaceId}
           AND NULLIF(parent_spawn_id, '') IS NOT NULL
        UNION
        SELECT parent_spawn_id, session_owner
          FROM harness_shared.spawned_agents
         WHERE workspace_id = ${workspaceId}
           AND NULLIF(parent_spawn_id, '') IS NOT NULL
           AND NULLIF(session_owner, '') IS NOT NULL
        UNION
        SELECT spawn_id, session_owner
          FROM harness_shared.spawned_agents
         WHERE workspace_id = ${workspaceId}
           AND NULLIF(session_owner, '') IS NOT NULL
        UNION
        SELECT session_owner, spawn_id
          FROM harness_shared.spawned_agents
         WHERE workspace_id = ${workspaceId}
           AND NULLIF(session_owner, '') IS NOT NULL
        UNION
        -- P-004: the CONSULT-DISPATCH edge — a routed expert to the identity
        -- that answers FROM their transcript.
        --
        -- Without it the launch edge above resolves a consult fork to whoever
        -- launched it (for grading, the system sweep actor), so the fork reads
        -- as unrelated to everyone and the exclusion that matters — the SOURCE
        -- transcript's lineage — is not evaluated at all. Exclusion must follow
        -- the KNOWLEDGE, not the process that started the session.
        --
        -- Derived, never a second hand-maintained field: this is the same
        -- answeringOwnerId the consult participant gate is already keyed on, so
        -- an identity that can post on a consult is exactly one this covers.
        SELECT sel->>'ownerId',
               sel->>'answeringOwnerId'
          FROM harness_shared.consult_state cs
          CROSS JOIN LATERAL jsonb_array_elements(
                 CASE jsonb_typeof(cs.routing -> 'selection' -> 'selected')
                   WHEN 'array' THEN cs.routing -> 'selection' -> 'selected'
                   ELSE '[]'::jsonb
                 END
               ) AS sel
         WHERE cs.workspace_id = ${workspaceId}
           AND NULLIF(sel->>'ownerId', '') IS NOT NULL
           AND NULLIF(sel->>'answeringOwnerId', '') IS NOT NULL
           AND sel->>'ownerId' IS DISTINCT FROM sel->>'answeringOwnerId'
  `;
}

/**
 * Whether two identities are in a direct ancestor/descendant chain.
 *
 * Rebind edges, both agent-launch parent edges, and the consult-dispatch edge
 * (routed expert → the identity answering from their transcript) are directed.
 * A routed answering session's lineage is its source expert, not the requester
 * recorded as its launcher (P-005 — see the launch branch of `identityEdges`).
 * We walk from each candidate in turn, so an ancestor grader is excluded just
 * like a descendant grader, while siblings remain eligible (sharing a parent is
 * not lineage).
 * Spawn ids and session owners are aliases in the spawned-agent table; both
 * representations are bridged. The recursive walk is bounded and cycle-safe.
 */
export async function areAcceptanceLineageRelated(
  firstId: string | null | undefined,
  secondId: string | null | undefined,
  opts: AcceptanceAuthorIdentityOpts = {},
): Promise<boolean> {
  const first = firstId?.trim() ?? '';
  const second = secondId?.trim() ?? '';
  if (!first || !second) return false;
  if (first === second) return true;

  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const sql = opts.sql ?? getOrgPg().sql;
  const rows = await sql<Array<{ matches: boolean }>>`
      WITH RECURSIVE identity_edges(from_id, to_id) AS (
        ${identityEdges(sql, workspaceId)}
      ),
      walk(node, path, depth) AS (
        SELECT ${first}::text, ARRAY[${first}::text], 0
        UNION ALL
        SELECT edge.to_id, walk.path || edge.to_id, walk.depth + 1
          FROM walk
          JOIN identity_edges AS edge ON edge.from_id = walk.node
         WHERE walk.depth < 64
           AND NOT edge.to_id = ANY(walk.path)
      ),
      reverse_walk(node, path, depth) AS (
        SELECT ${second}::text, ARRAY[${second}::text], 0
        UNION ALL
        SELECT edge.to_id, reverse_walk.path || edge.to_id, reverse_walk.depth + 1
          FROM reverse_walk
          JOIN identity_edges AS edge ON edge.from_id = reverse_walk.node
         WHERE reverse_walk.depth < 64
           AND NOT edge.to_id = ANY(reverse_walk.path)
      )
      SELECT EXISTS (SELECT 1 FROM walk WHERE node = ${second})
          OR EXISTS (SELECT 1 FROM reverse_walk WHERE node = ${first}) AS matches
  `;
  return rows[0]?.matches === true;
}

/**
 * Every identity lineage-related to `id`: the set S with
 * `areAcceptanceLineageRelated(x, id) === S.has(x)` for every x (id included).
 * Same edge set and the same 64-hop bound, walked as descendants plus ancestors
 * in ONE query, so a screen can apply one identity's population to a whole
 * candidate menu instead of one recursive query per (candidate, identity) pair
 * (P-005, review-routing-through-relevance-router-2026-09-26). Query failures
 * propagate: an unreadable population must not read as an empty one.
 */
export async function acceptanceLineageClosure(
  id: string | null | undefined,
  opts: AcceptanceAuthorIdentityOpts = {},
): Promise<Set<string>> {
  const self = id?.trim() ?? '';
  if (!self) return new Set();
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const sql = opts.sql ?? getOrgPg().sql;
  const rows = await sql<Array<{ node: string }>>`
      WITH RECURSIVE identity_edges(from_id, to_id) AS (
        ${identityEdges(sql, workspaceId)}
      ),
      descendants(node, path, depth) AS (
        SELECT ${self}::text, ARRAY[${self}::text], 0
        UNION ALL
        SELECT edge.to_id, descendants.path || edge.to_id, descendants.depth + 1
          FROM descendants
          JOIN identity_edges AS edge ON edge.from_id = descendants.node
         WHERE descendants.depth < 64
           AND NOT edge.to_id = ANY(descendants.path)
      ),
      ancestors(node, path, depth) AS (
        SELECT ${self}::text, ARRAY[${self}::text], 0
        UNION ALL
        SELECT edge.from_id, ancestors.path || edge.from_id, ancestors.depth + 1
          FROM ancestors
          JOIN identity_edges AS edge ON edge.to_id = ancestors.node
         WHERE ancestors.depth < 64
           AND NOT edge.from_id = ANY(ancestors.path)
      )
      SELECT node FROM descendants
      UNION
      SELECT node FROM ancestors
  `;
  return new Set(rows.map((row) => row.node).filter((node): node is string => Boolean(node)));
}

/**
 * Whether `candidateId` is the recorded author or a successor reachable through
 * one or more successful `coord:rebind-identity` operations. Spawn descendants
 * are deliberately NOT author successors; callers that need evaluator
 * independence use {@link areAcceptanceLineageRelated} separately.
 *
 * Fail closed: if the audit ledger is unavailable, only raw identity equality is
 * accepted. The recursive walk is cycle-safe and bounded so malformed historical
 * rows cannot turn an acceptance check into an unbounded query.
 */
export async function isAcceptanceAuthorIdentity(
  recordedAuthorId: string | null | undefined,
  candidateId: string | null | undefined,
  opts: AcceptanceAuthorIdentityOpts = {},
): Promise<boolean> {
  const author = recordedAuthorId?.trim() ?? '';
  const candidate = candidateId?.trim() ?? '';
  if (!author || !candidate) return false;
  if (author === candidate) return true;

  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  try {
    const sql = opts.sql ?? getOrgPg().sql;
    const rows = await sql<Array<{ matches: boolean }>>`
      WITH RECURSIVE rebind_edges AS (
        SELECT args_json->>'from' AS from_id,
               COALESCE(NULLIF(args_json->>'to', ''), coord_owner_id) AS to_id
          FROM harness_shared.tool_invocations
         WHERE workspace_id = ${workspaceId}
           AND tool_name = 'coord:rebind-identity'
           AND status = 'ok'
           AND args_json->>'from' IS NOT NULL
           AND COALESCE(NULLIF(args_json->>'to', ''), coord_owner_id) IS NOT NULL
      ), author_lineage(owner_id, path, depth) AS (
        SELECT ${author}::text, ARRAY[${author}::text], 0
        UNION ALL
        SELECT edge.to_id, lineage.path || edge.to_id, lineage.depth + 1
          FROM author_lineage AS lineage
          JOIN rebind_edges AS edge ON edge.from_id = lineage.owner_id
         WHERE lineage.depth < 32
           AND NOT edge.to_id = ANY(lineage.path)
      )
      SELECT EXISTS(
        SELECT 1 FROM author_lineage WHERE owner_id = ${candidate}
      ) AS matches
    `;
    return rows[0]?.matches === true;
  } catch {
    return false;
  }
}

/**
 * Resolve the principal implementer identities for an acceptance rubric's
 * subject plan.
 *
 * `Rubric.createdBy` is the acceptance-author/seat identity, not necessarily the
 * person who implemented the plan. The principal population is deliberately read
 * from BOTH the current row and its append-only history:
 *
 *   - `taken_by`, `terminal_owner`, and `last_released_by` cover the current/final
 *     row projections;
 *   - `worked_by_history` covers every recorded claimant transition, including an
 *     implementer who handed the item off before completion;
 *   - `plan_audits.created_by` covers the activation/completion auditors who shaped
 *     or certified the subject plan.
 *
 * Reading only the two mutable owner columns made a former implementer eligible to
 * grade after a handoff. Treat an unrecognisable non-null history shape as a hard
 * read error: silently shrinking an independence population is a fail-open gate.
 *
 * This is deliberately workspace-scoped and returns only nonblank identities.
 * Query failures propagate to callers, which must not silently convert an
 * unreadable independence population into a clean result.
 */
export async function resolvePlanImplementerIdentities(
  subjectPlan: string | null | undefined,
  opts: AcceptanceAuthorIdentityOpts = {},
): Promise<string[]> {
  const planSlug = subjectPlan?.trim() ?? '';
  if (!planSlug) return [];

  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const sql = opts.sql ?? getOrgPg().sql;
  const [workItems, audits] = await Promise.all([
    sql<
      Array<{
        terminal_owner: string | null;
        taken_by: string | null;
        last_released_by: string | null;
        worked_by_history: unknown;
      }>
    >`
      SELECT terminal_owner, taken_by, last_released_by, worked_by_history
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND source_plan_slug = ${planSlug}
       ORDER BY feature_id
    `,
    sql<Array<{ created_by: string | null }>>`
      SELECT created_by
        FROM harness_shared.plan_audits
       WHERE workspace_id = ${workspaceId}
         AND plan_slug = ${planSlug}
         AND audit_kind IN ('activation', 'completion')
       ORDER BY audit_seq
    `,
  ]);

  const identities = new Set<string>();
  const add = (value: string | null | undefined) => {
    const owner = value?.trim() ?? '';
    if (owner) identities.add(owner);
  };

  for (const row of workItems) {
    add(row.taken_by);
    add(row.terminal_owner);
    add(row.last_released_by);
    if (row.worked_by_history != null && !Array.isArray(row.worked_by_history)) {
      throw new Error(
        `acceptance_lineage_unreadable: work item history for plan '${planSlug}' is not an array`,
      );
    }
    for (const owner of parseWorkedByHistory(row.worked_by_history)) add(owner);
  }
  for (const row of audits) add(row.created_by);

  return [...identities].sort();
}

/**
 * Partition `ownerIds` into PARTIES — groups of ids that are one agent wearing
 * several coordination identities — and return each id's canonical party key.
 *
 * WHY THIS EXISTS (unified-responder-selection-critique-and-grading-2026-08-30
 * D-008). Grader selection deduped its menu on raw `ownerId`, which is not the
 * same claim as "these are different parties" — it is precisely the claim
 * {@link areAcceptanceLineageRelated} exists to refute. Once grading became a
 * min-1/max-2 cascade (D-003) a two-entry menu could be one party twice, so the
 * "second opinion" reviewing grader 1's carried card would be that same party
 * reviewing itself, and the gate would rank the self-review as the
 * better-informed card (D-007's recency tie-break). Measured against live PG on
 * 2026-08-30: 67 launcher/launched pairs across 12 distinct parents were BOTH
 * routable and BOTH coord-role-bearing, i.e. both selectable as graders.
 *
 * ONE query, not N². The pairwise helper answers a single question per call; a
 * candidate pool needs the whole relation, so this walks from every id at once
 * and keeps only the arrivals that are themselves candidates.
 *
 * The key for a group is the EARLIEST id in the caller's own order, so passing a
 * ranked pool makes each party's representative its best-ranked member.
 *
 * ⚠ DELIBERATELY OVER-MERGES SIBLINGS (D-008). Grouping is union-find over the
 * related PAIRS found inside the set, so with A→B and B→C present and B also a
 * candidate, siblings A and C land in one party even though the pairwise helper
 * calls them unrelated (sharing a parent is not lineage). That direction
 * over-excludes, which for an independence guard is the correct way to be wrong.
 *
 * Throws on a read fault rather than guessing; callers decide whether their
 * degraded behaviour is to fall back to raw-id distinctness.
 */
export async function lineagePartyKeys(
  ownerIds: readonly (string | null | undefined)[],
  opts: AcceptanceAuthorIdentityOpts = {},
): Promise<Map<string, string>> {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const raw of ownerIds) {
    const id = raw?.trim() ?? '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  const keys = new Map<string, string>(ordered.map((id) => [id, id]));
  if (ordered.length < 2) return keys;

  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const sql = opts.sql ?? getOrgPg().sql;
  const pairs = await sql<Array<{ a: string; b: string }>>`
      WITH RECURSIVE identity_edges(from_id, to_id) AS (
        ${identityEdges(sql, workspaceId)}
      ),
      walk(src, node, path, depth) AS (
        SELECT s.seed, s.seed, ARRAY[s.seed], 0
          FROM unnest(${ordered}::text[]) AS s(seed)
        UNION ALL
        SELECT walk.src, edge.to_id, walk.path || edge.to_id, walk.depth + 1
          FROM walk
          JOIN identity_edges AS edge ON edge.from_id = walk.node
         WHERE walk.depth < 64
           AND NOT edge.to_id = ANY(walk.path)
      )
      SELECT DISTINCT walk.src AS a, walk.node AS b
        FROM walk
       WHERE walk.node <> walk.src
         AND walk.node = ANY(${ordered}::text[])
  `;
  if (pairs.length === 0) return keys;

  // Union-find, resolving each group to its earliest member in caller order.
  const rank = new Map(ordered.map((id, index) => [id, index] as const));
  const parent = new Map<string, string>(ordered.map((id) => [id, id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = id;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  for (const { a, b } of pairs) {
    if (!parent.has(a) || !parent.has(b)) continue;
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) continue;
    const [keep, drop] = (rank.get(rootA) ?? 0) <= (rank.get(rootB) ?? 0) ? [rootA, rootB] : [rootB, rootA];
    parent.set(drop, keep);
  }
  for (const id of ordered) keys.set(id, find(id));
  return keys;
}
