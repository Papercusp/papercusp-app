/**
 * datatype-frontier-placement — the opt-in that lets a generic-kind datatype's work-items
 * enter the autonomous PLACEMENT frontier (reflexive-platform-extensibility-datatypes
 * P-001 follow-up; the design decision the visibility filter deferred).
 *
 * VISIBILITY ≠ PLACEMENT. `featureFamilyKindClause` (work-items.ts) makes every registered
 * generic-kind datatype's items VISIBLE in list/count/search. But whether such an item also
 * gets a bee AUTO-PLACED on it (the Queen's claim/survey/wake frontier) is a heavier,
 * separate decision — a datatype is a data SHAPE, and auto-spawning a worker per instance
 * must be deliberate. So placement is OPT-IN: a datatype declares the {@link HIVE_PLACEMENT_TAG}
 * tag to enrol its kind in the frontier. Default (no tag) ⇒ tracked + visible, never
 * auto-placed.
 *
 * Tag-based (not a new column) on purpose: it needs no migration, so it can't collide on the
 * shared migration-number space. The frontier consumers (claimFloorsWhereSql /
 * survey.fetchFrontierRows / survey.countPlaceableFrontier / wake-frontier-guard) all AND in
 * the SAME clause so an item that is claimable is also surveyed + wake-counted (no skew).
 *
 * Server-only (PG fragment).
 */
import type postgres from 'postgres';

/** A generic-kind datatype carries this tag to opt its work-items into the placement frontier. */
export const HIVE_PLACEMENT_TAG = 'hive-placement';

/**
 * The frontier kind filter: the active built-in feature kind, PLUS any
 * generic-kind datatype kinds that opted into placement (the {@link HIVE_PLACEMENT_TAG}).
 * DARK until a datatype opts in — the subquery is empty otherwise, so the live frontier is
 * byte-identical to before this clause existed. Mirrors `featureFamilyKindClause` but adds
 * the opt-in tag gate (the visibility filter has no such gate).
 */
export function frontierPlacementKindClause(sql: postgres.Sql, workspaceId: string) {
  return sql`(item_kind = 'feature'
       OR item_kind IN (
         SELECT work_item_kind FROM harness_shared.datatype_registry
          WHERE workspace_id = ${workspaceId} AND tier = 'generic-kind' AND status = 'active'
            AND work_item_kind IS NOT NULL
            AND ${HIVE_PLACEMENT_TAG} = ANY(tags)
       ))`;
}
