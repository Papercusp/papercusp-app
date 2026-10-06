/**
 * The ONE work predicate (enterprise-data-sources-2026-10-01 P-009, D-022).
 *
 * Whether a work_items row is work an AGENT may select is decided by its NATURE and
 * AUDIENCE (stamped at mint from datatype_registry by migration 1322's trigger, D-018),
 * plus the two standing exclusions that were already claim floors: the observation lane
 * and needs-owner-action. Migration 1325 owns the SQL definition:
 *
 *   harness_shared.work_item_is_agent_work(nature, audience, lane, needs_owner_action)
 *     = nature = 'work' AND audience = 'agent'
 *       AND lane IS DISTINCT FROM 'observation' AND needs_owner_action IS NOT TRUE
 *
 * This module is the only place claim and placement paths spell it. It reads
 * work_items columns only (D-008 — no JOIN to datatype_registry inside a claim path),
 * and composes with the existing claim floors rather than replacing them.
 *
 * Family ROUTING (which claim mechanism handles a row — the issue-family claim vs the
 * feature-family claim) is not a claimability decider (D-022 point 3). It is spelled in
 * exactly one place too: {@link ISSUE_FAMILY_ROUTE_KINDS}. The R-3 lint
 * (work-predicate-lint.test.ts) fails any other hardcoded `item_kind IN (...)` list or
 * kind array in a claim or placement path.
 */
import type postgres from 'postgres';

/**
 * The issue-family kinds — the single routing list. `work-items.ts` re-exports it as
 * `ISSUE_FAMILY_KINDS`. It is a ROUTE, not a gate: the predicate below decides
 * claimability.
 */
export const ISSUE_FAMILY_ROUTE_KINDS = ['bug', 'change', 'task'] as const;
export type IssueFamilyRouteKind = (typeof ISSUE_FAMILY_ROUTE_KINDS)[number];

const IDENT = /^[a-z_][a-z0-9_]*$/;

function columnPrefix(alias: string | null): string {
  if (alias === null) return '';
  if (!IDENT.test(alias)) throw new Error(`agent-work-predicate: invalid relation alias ${JSON.stringify(alias)}`);
  return `${alias}.`;
}

/**
 * `<alias>.item_kind IN ('bug', 'change', 'task')`, spelled as LITERALS generated from
 * {@link ISSUE_FAMILY_ROUTE_KINDS}. Literals (not a bound `= ANY($1)` array) on purpose:
 * partial indexes such as `work_items_escalated_open_idx` carry this exact list in their
 * predicate, and the planner can prove implication only from a literal list.
 */
export function issueFamilyRouteSql(sql: postgres.Sql, alias: string | null = 'wi') {
  const list = ISSUE_FAMILY_ROUTE_KINDS.map((k) => `'${k}'`).join(', ');
  return sql.unsafe(`${columnPrefix(alias)}item_kind IN (${list})`);
}

/**
 * The work predicate over a relation that carries the base-table columns
 * (`harness_shared.work_items`, aliased `alias`): nature, audience and the generated
 * lane / needs_owner_action columns.
 */
export function agentWorkWhereSql(sql: postgres.Sql, alias: string | null = 'wi') {
  const p = columnPrefix(alias);
  return sql.unsafe(
    `harness_shared.work_item_is_agent_work(${p}nature, ${p}audience, ${p}lane, ${p}needs_owner_action)`,
  );
}

/**
 * The same predicate over `harness_shared.harness_features_consolidated`, which projects
 * nature, audience and payload but not the generated lane / needs_owner_action columns.
 * The two arguments are the generated columns' own expressions (migration 721 for lane;
 * needs_owner_action = (payload ->> 'needsOwnerAction') = 'true').
 */
export function agentWorkConsolidatedWhereSql(sql: postgres.Sql, alias: string | null = null) {
  const p = columnPrefix(alias);
  return sql.unsafe(
    `harness_shared.work_item_is_agent_work(${p}nature, ${p}audience, ${p}payload ->> 'lane', (${p}payload ->> 'needsOwnerAction') = 'true')`,
  );
}

/**
 * The CATEGORY half of the same function, for the by-id claim (claimWorkItem). It passes
 * NULL for lane and needs_owner_action, so only nature = 'work' AND audience = 'agent' can
 * refuse. Readiness floors (owner action, the observation lane) stay off the by-id path per
 * work-item-dependency-edges-2026-08-02#D-008; whether a row is agent work at all is a
 * category fact that never becomes ready, so it gates every door (D-022 point 4, D-024).
 */
export function agentWorkCategoryWhereSql(sql: postgres.Sql, alias: string | null = null) {
  const p = columnPrefix(alias);
  return sql.unsafe(`harness_shared.work_item_is_agent_work(${p}nature, ${p}audience, NULL, NULL)`);
}

/**
 * D-041 (enterprise-data-sources-2026-10-01, WI-10005358): the READ-side audience filter.
 * 'agent' is the SAME category predicate the write doors refuse on (D-024/D-035), imported
 * rather than restated, so a row a default agent list shows is a row the doors accept.
 * 'human' selects human-audience rows; 'any' (or unset) applies no audience filter.
 */
export const WORK_AUDIENCE_FILTERS = ['agent', 'human', 'any'] as const;
export type WorkAudienceFilter = (typeof WORK_AUDIENCE_FILTERS)[number];

export function audienceWhereSql(
  sql: postgres.Sql,
  audience: WorkAudienceFilter | null | undefined,
  alias: string | null = null,
) {
  if (audience === 'agent') return agentWorkCategoryWhereSql(sql, alias);
  if (audience === 'human') return sql.unsafe(`${columnPrefix(alias)}audience = 'human'`);
  return sql.unsafe('TRUE');
}

/** The in-memory twin, for paths that hold a row rather than a query. Same truth table. */
export function isAgentWork(row: {
  nature: string | null | undefined;
  audience: string | null | undefined;
  lane?: string | null;
  needsOwnerAction?: boolean | null;
}): boolean {
  return (
    row.nature === 'work' &&
    row.audience === 'agent' &&
    row.lane !== 'observation' &&
    row.needsOwnerAction !== true
  );
}
