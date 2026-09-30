/**
 * Hard-stop budget enforcement at proposal-accept.
 *
 * Substrate enforces atomic budget checks before any work is created:
 * if currently committed costs + proposed cost > project budget, reject.
 *
 * Implemented in a Postgres transaction with a row-level lock on the project
 * row, so concurrent accepts cannot both pass the check and together exceed
 * the budget.
 */

import type { Sql } from 'postgres';

export interface BudgetCheckResult {
  ok: boolean;
  projectId: string;
  budgetCents: number | null;     // null = no budget cap
  committedCents: number;
  proposedCents: number;
  remainingCents: number | null;  // null when budgetCents is null
  wouldExceedBy?: number;
}

export class BudgetExceededError extends Error {
  constructor(public detail: BudgetCheckResult) {
    super(
      `project ${detail.projectId} would exceed budget by ${detail.wouldExceedBy} cents ` +
      `(budget=${detail.budgetCents}, committed=${detail.committedCents}, proposed=${detail.proposedCents})`
    );
    this.name = 'BudgetExceededError';
  }
}

function validateSchema(schemaName: string): void {
  if (!/^harness_[a-z0-9_]+$/.test(schemaName)) {
    throw new Error(`invalid schema name: ${schemaName}`);
  }
}

/**
 * Check whether a project can absorb a new feature's cost without exceeding budget.
 *
 * MUST be called inside a transaction (caller wraps with sql.begin()).
 * Uses SELECT FOR UPDATE on the project row so concurrent accepts serialize.
 *
 * Returns ok=true + remainingCents=null when the project has no budget set.
 */
export async function checkProjectBudget(
  sql: Sql,
  projectId: string,
  proposedCostCents: number,
  /** Schemas containing harness_features tables to scan. Pass all per-harness schema names. */
  harnessSchemas: string[]
): Promise<BudgetCheckResult> {
  for (const s of harnessSchemas) validateSchema(s);

  // 1. Lock the project row.
  const projectRows = await sql<{ id: string; budget_cents: number | null }[]>`
    SELECT id, budget_cents FROM harness_shared.projects
     WHERE id = ${projectId}
     FOR UPDATE
  `;
  if (projectRows.length === 0) {
    throw new Error(`project ${projectId} not found`);
  }
  const project = projectRows[0];
  const budgetCents = project.budget_cents !== null ? Number(project.budget_cents) : null;

  if (budgetCents === null) {
    return {
      ok: true,
      projectId,
      budgetCents: null,
      committedCents: 0,
      proposedCents: proposedCostCents,
      remainingCents: null,
    };
  }

  // 2. Sum currently committed costs across all per-harness feature tables.
  let committedCents = 0;
  for (const schema of harnessSchemas) {
    const tableRef = sql(`${schema}.harness_features`);
    const rows = await sql<{ total: number }[]>`
      SELECT COALESCE(SUM(expected_cost_cents), 0)::bigint AS total
        FROM ${tableRef}
       WHERE project_id = ${projectId}
         AND status NOT IN ('cancelled', 'rejected')
    `;
    committedCents += Number(rows[0]?.total ?? 0);
  }

  const remainingCents = budgetCents - committedCents;
  const wouldExceedBy = (committedCents + proposedCostCents) - budgetCents;

  if (committedCents + proposedCostCents > budgetCents) {
    return {
      ok: false,
      projectId,
      budgetCents,
      committedCents,
      proposedCents: proposedCostCents,
      remainingCents,
      wouldExceedBy,
    };
  }

  return {
    ok: true,
    projectId,
    budgetCents,
    committedCents,
    proposedCents: proposedCostCents,
    remainingCents,
  };
}

/**
 * Convenience: check the budget AND throw if exceeded. Caller wraps in transaction.
 *
 * IMPORTANT (D-002): the `SELECT … FOR UPDATE` in checkProjectBudget only
 * serializes concurrent accepts if the caller does the budget check AND the
 * cost-creating INSERT inside the SAME transaction that holds the lock. Calling
 * this in its own transaction and inserting the feature in a later one releases
 * the lock in between and re-opens the write-skew window. Prefer
 * {@link withProjectBudget}, which encapsulates the whole check-then-spend in
 * one transaction so the lock can't be misused.
 */
export async function assertProjectBudget(
  sql: Sql,
  projectId: string,
  proposedCostCents: number,
  harnessSchemas: string[]
): Promise<BudgetCheckResult> {
  const result = await checkProjectBudget(sql, projectId, proposedCostCents, harnessSchemas);
  if (!result.ok) throw new BudgetExceededError(result);
  return result;
}

/**
 * Atomic budget-gated spend (D-002 — the write-skew-safe entry point).
 *
 * Opens ONE transaction, locks the project row (`FOR UPDATE` inside
 * checkProjectBudget), verifies the proposed cost fits, and — only if it does —
 * runs `spend(tx)` to create the work, all under the same lock. Concurrent
 * accepts for the same project therefore serialize on that one row: the second
 * blocks until the first commits, then re-sums and sees the first's committed
 * cost, so the two cannot together exceed the cap. This is the "materialize the
 * invariant onto one row" fix — correct at READ COMMITTED, no SERIALIZABLE
 * abort/retry needed for this hot path.
 *
 * `spend` MUST perform its writes through the passed `tx` (e.g. INSERT the new
 * feature's `expected_cost_cents`); writing through any other handle escapes
 * the lock. Throws {@link BudgetExceededError} BEFORE calling `spend` when the
 * cost would exceed budget.
 */
export async function withProjectBudget<T>(
  sql: Sql,
  params: { projectId: string; proposedCostCents: number; harnessSchemas: string[] },
  spend: (tx: Sql) => Promise<T>
): Promise<{ budget: BudgetCheckResult; result: T }> {
  const out = await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as Sql;
    const budget = await checkProjectBudget(
      tx,
      params.projectId,
      params.proposedCostCents,
      params.harnessSchemas
    );
    if (!budget.ok) throw new BudgetExceededError(budget);
    const result = await spend(tx);
    return { budget, result };
  });
  return out as { budget: BudgetCheckResult; result: T };
}
