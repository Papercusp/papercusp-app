/**
 * Cross-field invariant: a plan that is operationally `started`/`paused`
 * (`harness_shared.harness_plans.op_status`) must NEVER also be at a terminal
 * lifecycle status (`shipped` / `superseded`) in its frontmatter.
 *
 * Both now live in the same `harness_plans` row (op_status column + the
 * frontmatter `status` index derived from `content`), but a column `CHECK`
 * still can't express the rule cheaply across the parsed-vs-stored boundary,
 * so we enforce it at the write boundary + on read:
 *
 *   1. Lifecycle transitions to a terminal status go through
 *      plans:set-plan-status, which clears the PG started/paused row (→ 'done').
 *      Raw content writers cannot change the lifecycle status.
 *   2. `plans:start` refuses a plan whose frontmatter is already terminal —
 *      {@link isTerminalPlanStatus}.
 *   3. `plans:list` self-heals a stale started+terminal row on read —
 *      {@link reconcileStartStatus} — so even a raw `.md` edit that bypassed
 *      every verb can't surface a terminal plan as "waiting".
 *
 * The net effect: the "N plans waiting" badge, the Running bucket chip, and
 * the plan rail all derive "waiting/running" from the same started set, and
 * a started plan can never simultaneously be shipped/superseded.
 */

import { withWorkspace } from '@papercusp/db-org';

export type StartStatus = 'started' | 'paused' | 'done' | null;

/**
 * Terminal plan-lifecycle statuses — a started plan can never be one of these.
 *
 * DEFINED in `@papercusp/plan-parser` (pure status grammar, zero I/O) and
 * re-exported here so this module's existing importers resolve unchanged. The
 * definition moved because THIS module imports `@papercusp/db-org`: a consumer
 * that must stay dependency-free (the `coord.plans` sync projection, WI-7256)
 * cannot import the predicate from here without dragging Postgres across its
 * boundary, and duplicating it is how the two copies drift.
 *
 * ⚠ IMPORT-then-export, NOT `export { … } from '…'`. A re-export forwards the
 * binding to importers but creates NO LOCAL binding, so `reconcileStartStatus`
 * below — which calls `isTerminalPlanStatus` in THIS module — threw
 * `ReferenceError: isTerminalPlanStatus is not defined` at runtime while every
 * importer resolved fine and the change looked correct (WI-7256 fallout; it
 * red-pinned the fleet gate across 3 test files / 18 tests, cand 955187351a).
 *
 * What actually guards this: `tsc`, which reports it as
 * `TS2304: Cannot find name '<symbol>'` — verified on this exact file. There is
 * deliberately NO bespoke lint for the shape, because a second detector nobody
 * runs adds noise rather than coverage. Run
 * `npm run lint:tsc -- --files=<the files you edited>` before you finish, or the
 * feedback arrives ~55min later as a fleet-gate red (EI-19403475615161567).
 */
import { PLAN_STATUSES, TERMINAL_PLAN_STATUSES, isTerminalPlanStatus } from '@papercusp/plan-parser';

export { TERMINAL_PLAN_STATUSES, isTerminalPlanStatus };

/** Statuses allowed when a plan is created or a legacy plan is converted.
 * Terminal lifecycle transitions belong to plans:set-plan-status. */
export const NON_TERMINAL_PLAN_STATUSES = PLAN_STATUSES.filter((status) => !isTerminalPlanStatus(status));

/**
 * Reconcile the operational start-status reported to a reader against the
 * plan's lifecycle status. A terminal plan can never be `started`/`paused`;
 * if a stale PG row says it is (e.g. a raw `.md` edit that bypassed the
 * write verbs), report `'done'` instead. Pure — used by `plans:list`.
 */
export function reconcileStartStatus(startStatus: StartStatus, lifecycleStatus: string | null | undefined): StartStatus {
  if ((startStatus === 'started' || startStatus === 'paused') && isTerminalPlanStatus(lifecycleStatus)) {
    return 'done';
  }
  return startStatus;
}

/**
 * Clear a plan's operational started/paused row when its lifecycle goes
 * terminal: set `status='done'` (the row is preserved so started_at /
 * priority history survives). Idempotent — only touches an active row, so
 * a no-op for plans that were never started. Best-effort by design: the
 * caller's file write has already succeeded, and {@link reconcileStartStatus}
 * recovers a missed clear on the next read.
 *
 * `workspaceId` MUST be the same (workspaceId, harnessSlug) scope the plan
 * write itself resolved (`withPlanLock`'s returned `result.scope` —
 * `resolvePlanScope`'s output), never independently re-derived. `harness_plans`
 * is keyed on (workspace_id, harness_slug, plan_slug), and a concrete-harness
 * plan's workspace is resolved via the harness registry / `harness_shared.projects`
 * (or `PAPERCUSP_WORKSPACE_ID` for the operator-home scope) — NOT via the
 * ambient "currently active workspace" (`activeWorkspaceId()`'s
 * request-ALS / env / global-registry fallback chain). A prior version of
 * this function called `activeWorkspaceId()` itself (WI-5125 class / EI-16183
 * had already fixed one generation of this bug, by replacing a hardcoded
 * `DEFAULT_WORKSPACE_ID` with `activeWorkspaceId()` — which reintroduced the
 * SAME class: whenever the caller's ambient workspace differs from the
 * harness's registered workspace — e.g. any tool call outside a browser
 * request's ALS scope, or simply a different workspace being "current" in
 * the registry — the UPDATE below silently matched zero rows and a
 * started/paused terminal plan never healed except lazily on the next
 * `plans:list` read). Passing the already-resolved scope through removes the
 * second, disagreeing resolution path entirely.
 *
 * @returns `{ cleared }` — whether an active row was transitioned.
 */
export async function clearStartedForTerminalPlan(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
): Promise<{ cleared: boolean }> {
  const now = new Date().toISOString();
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<{ plan_slug: string }[]>`
      UPDATE harness_shared.harness_plans
         SET op_status = 'done', op_updated_at = ${now}
       WHERE workspace_id = ${workspaceId}
         AND harness_slug  = ${harnessSlug}
         AND plan_slug     = ${planSlug}
         AND op_status IN ('started', 'paused')
      RETURNING plan_slug
    `;
  });
  return { cleared: rows.length > 0 };
}
