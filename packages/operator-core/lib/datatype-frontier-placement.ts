/**
 * datatype-frontier-placement — which feature-family work-items enter the autonomous
 * PLACEMENT frontier (claimFloorsWhereSql / survey.fetchFrontierRows /
 * survey.countPlaceableFrontier / wake-frontier-guard). They all AND in this ONE clause, so
 * an item that is claimable is also surveyed and wake-counted (no skew).
 *
 * enterprise-data-sources-2026-10-01 P-009 / D-022: placement is decided by the row's
 * NATURE and AUDIENCE (stamped at mint from datatype_registry, D-018) through the single work
 * predicate `harness_shared.work_item_is_agent_work` — not by a per-row datatype_registry
 * subquery for an opt-in tag. The old `hive-placement` tag gate is retired as a decider: a
 * registered generic-kind datatype whose kind is nature `work`, audience `agent` is placeable
 * like `feature`; a `record`/`document`/`event` kind, or a `work` kind addressed to a HUMAN
 * (e.g. `email-draft-proposal`), never is.
 *
 * The issue-family kinds are routed to the issue claim path instead; that ROUTE is spelled
 * once, in {@link issueFamilyRouteSql}. `chunk` needs no case: work_items:create rejects it
 * and every chunk row is terminal, so the status floors already exclude it (D-022 point 2).
 *
 * Valid only composed into a SELECT over `harness_shared.harness_features_consolidated`
 * (columns referenced UNQUALIFIED). Server-only (PG fragment).
 */
import type postgres from 'postgres';
import { agentWorkConsolidatedWhereSql, issueFamilyRouteSql } from './work-nature/agent-work-predicate';

/**
 * The retired opt-in tag. Kept exported only so tests can prove a tagged datatype gains
 * nothing from it: placement follows nature/audience whether or not the tag is present.
 */
export const HIVE_PLACEMENT_TAG = 'hive-placement';

/**
 * The frontier filter: every feature-family row (not issue-routed) that is agent work.
 * `workspaceId` is unused since D-022 (the predicate reads row columns only, D-008); every
 * caller already filters `workspace_id` itself.
 */
export function frontierPlacementKindClause(sql: postgres.Sql, _workspaceId?: string) {
  return sql`(NOT (${issueFamilyRouteSql(sql, null)}) AND ${agentWorkConsolidatedWhereSql(sql, null)})`;
}
