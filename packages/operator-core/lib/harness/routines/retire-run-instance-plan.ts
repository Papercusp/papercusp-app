/**
 * Retire a scheduled-run INSTANCE plan (`<template>@run-<token>`) — WI-10005040.
 *
 * Retiring an instance and closing its `plan_items` are two facts. Two raw-SQL
 * writers (`reconcile-plan-runs.ts` on a settled run, `plan-run-action.ts`
 * `recordScheduledFireFailure` on a failed fire) used to record only the first
 * (`UPDATE harness_plans SET status='superseded'`), so every instance whose items
 * were never promoted kept them `todo` forever: measured 2026-10-01, 28 phantom
 * open items on 10 superseded instances, +~3 per fire, every one a settled
 * `success` run (EI-24725593397767049 comment #1154022).
 *
 * This is the ONE retirement path for both writers. It mirrors the seed in
 * `plan-run-action.ts` (which writes the instance's content, `items` jsonb AND the
 * derived `plan_items` index on the same `sql` seam): content + `items` jsonb +
 * `plan_items` are rewritten together, never `plan_items` alone, because the index
 * is derived from content and a blind UPDATE would diverge from it.
 *
 * Items still non-terminal at retirement were, by definition, not completed by any
 * work-item (work-item completion already reflects `done` onto the plan item), so
 * they are `dropped` with a reason — never `done`, which would claim execution that
 * did not happen. Deliberately NOT routed through `evaluateSupersedeItemGate`: that
 * gate guards a HUMAN silently abandoning a plan; an ephemeral per-fire snapshot
 * whose ledger is `plan_runs` is retired by the system, with the reason recorded.
 */
import type { Sql } from 'postgres';
import { hashPlanContent } from '@papercusp/plan-parser/content-hash';
import { writePlanIndexRows } from '../../agent-tools/plans/plan-index-rows';
import { deriveIndexFromContent, type PlanIndexDecision, type PlanIndexItem } from '../../agent-tools/plans/source';

export type RetiredRunOutcome = 'success' | 'partial' | 'failed';

export interface RetireRunInstanceInput {
  workspaceId: string;
  /** Hive-scoped `harness_plans.harness_slug` (the `routineStorageSlug` result). */
  planStorageSlug: string;
  instanceSlug: string;
  templateSlug: string;
  outcome: RetiredRunOutcome;
  /**
   * Which plan status this call may retire. Default `'active'` — the normal lifecycle,
   * where the status guard makes a concurrent retire win. `'superseded'` is the BACKFILL
   * form: an instance an older writer superseded WITHOUT closing its items is re-run
   * through the same item-closing path (status stays `superseded`).
   */
  onlyIfStatus?: 'active' | 'superseded';
}

export interface RetireRunInstanceResult {
  /** False when the instance was absent or already retired (idempotent no-op). */
  retired: boolean;
  /** Non-terminal items closed as `dropped` by this call. */
  itemsClosed: number;
}

/** Item statuses that need no closing. */
const TERMINAL_ITEM_STATUSES: ReadonlySet<string> = new Set(['done', 'dropped']);

export function runInstanceRetiredNote(outcome: RetiredRunOutcome): string {
  return `run instance retired: run settled ${outcome}; item was never completed by a work-item`;
}

export async function retireRunInstancePlan(
  sql: Sql,
  input: RetireRunInstanceInput,
): Promise<RetireRunInstanceResult> {
  const { workspaceId, planStorageSlug, instanceSlug, templateSlug, outcome } = input;
  const fromStatus = input.onlyIfStatus ?? 'active';
  const rows = await sql<Array<{ content: string | null; items: unknown; decisions: unknown }>>`
    SELECT content, items, decisions
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${planStorageSlug}
       AND plan_slug = ${instanceSlug}
       AND template_slug = ${templateSlug}
       AND status = ${fromStatus}
  `;
  const row = rows[0];
  if (!row) return { retired: false, itemsClosed: 0 };

  // Lazy: set-status / set-plan-status are the canonical PURE content rewriters but
  // live in the heavy tool modules; loading them only when there is a row to retire
  // keeps this module cycle-free and light for the callers' mocked unit tests.
  const { flipStatusInBody } = await import('../../agent-tools/plans/set-status');
  const { flipPlanFrontmatterStatus } = await import('../../agent-tools/plans/set-plan-status');

  let body = typeof row.content === 'string' ? row.content : '';
  const derived = deriveIndexFromContent(body);
  // Same preference the seed uses: a populated stored index wins over re-derivation.
  const storedItems = Array.isArray(row.items) ? (row.items as PlanIndexItem[]) : [];
  const storedDecisions = Array.isArray(row.decisions) ? (row.decisions as PlanIndexDecision[]) : [];
  const items = storedItems.length > 0 ? storedItems : derived.items;
  const decisions = storedDecisions.length > 0 ? storedDecisions : derived.decisions;

  const note = runInstanceRetiredNote(outcome);
  let itemsClosed = 0;
  const closedItems = items.map((it) => {
    const status = typeof it.status === 'string' && it.status !== '' ? it.status : 'todo';
    if (TERMINAL_ITEM_STATUSES.has(status)) return it;
    itemsClosed += 1;
    body = flipStatusInBody(body, it.id, 'dropped', note).newBody;
    return { ...it, status: 'dropped' };
  });

  const flipped = flipPlanFrontmatterStatus(body, 'superseded');
  if (flipped.newBody) body = flipped.newBody;

  const contentHash = hashPlanContent(body);
  // The content rewrite, its plan_revisions row and the derived index commit together: a
  // pool `sql` gets its own transaction, a caller's transaction is used as-is.
  const writeRetirement = async (db: Sql): Promise<void> => {
    const updated = await db`
      UPDATE harness_shared.harness_plans
         SET status = 'superseded',
             content = ${body},
             content_hash = ${contentHash},
             items = ${JSON.stringify(closedItems)}::text::jsonb,
             version = version + 1,
             origin = 'local'
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${planStorageSlug}
         AND plan_slug = ${instanceSlug}
         AND template_slug = ${templateSlug}
         AND status = ${fromStatus}
    `;
    // WI-10006321: this raw UPDATE rewrites content outside withPlanLock, so it records the
    // revision itself. Without one, the plan-parts reconcile sweep has no content clock for
    // the retired body and falls back to updated_at. Only when a row was actually written:
    // a concurrent retire that won the status guard wrote its own.
    if (updated.count > 0) {
      const { recordSystemPlanRevisionInTransaction, PLAN_RUN_INSTANCE_RETIRE_REVISION_AUTHOR } =
        await import('../../agent-tools/plans/revisions');
      await recordSystemPlanRevisionInTransaction(db, {
        workspaceId,
        harnessSlug: planStorageSlug,
        planSlug: instanceSlug,
        content: body,
        contentHash,
        rationale: `run instance retired (run settled ${outcome})`,
        authorId: PLAN_RUN_INSTANCE_RETIRE_REVISION_AUTHOR,
      });
    }
    await writePlanIndexRows(
      db as unknown as Parameters<typeof writePlanIndexRows>[0],
      { workspaceId, harnessSlug: planStorageSlug, planSlug: instanceSlug },
      { items: closedItems, decisions },
    );
  };
  if ('begin' in sql && typeof sql.begin === 'function') {
    await sql.begin((tx) => writeRetirement(tx as unknown as Sql));
  } else {
    await writeRetirement(sql);
  }
  return { retired: true, itemsClosed };
}
