/**
 * resolvePlanWriteScope — the ONE authority for the `(workspace_id,
 * harness_slug)` key an operational `harness_shared.harness_plans` WRITE must
 * use. It is deliberately the SAME resolution the plan READERS perform, from
 * the SAME resolver (`source.ts`'s `resolvePlanScope`).
 *
 * ⚠ Use this in every harness_plans writer. Do NOT re-derive the tenant with
 * `activeWorkspaceId()` (or a `DEFAULT_WORKSPACE_ID` literal), and do NOT key on
 * the raw ctx harness slug. This repo has now shipped THREE generations of the
 * same bug, each because a writer resolved its key on a second path that could
 * disagree with the reader's:
 *
 *   gen 1 (WI-5125 / EI-16183) — a hardcoded `DEFAULT_WORKSPACE_ID`: matched
 *     ZERO rows for every real tenant (plans live in 'papercusp-workspace', not
 *     'default'), while the handlers still reported ok:true. Drag-to-reorder,
 *     start and pause silently did nothing on every real plan for weeks.
 *   gen 2 (the EI-16183 FIX, caught in plan-start-state.ts) — `activeWorkspaceId()`:
 *     the AMBIENT workspace (request-ALS → env → registry default). Right only
 *     when the caller happens to sit inside a browser request whose workspace
 *     matches the harness's REGISTERED one. Any agent-side tool call outside
 *     that ALS scope — or simply a different workspace being "current" — keys a
 *     different row than the reader just read.
 *   gen 3 (WI-5825) — the raw ctx harness slug: plans are Hive-scoped and
 *     `resolvePlanScope` collapses a MEMBER harness to its Hive home, so a
 *     writer that skips the collapse keys a row no reader ever looks at.
 *
 * `resolvePlanScope` is the single authority: it resolves the workspace from
 * `harness_shared.projects` then the authoritative harness registry, THROWS
 * rather than silently defaulting when neither knows the harness, and applies
 * the Hive-home collapse. Threading its output through for BOTH the
 * `withWorkspace()` scope and the SQL WHERE clause removes the second,
 * disagreeing resolution path entirely — the same repair already applied to
 * {@link clearStartedForTerminalPlan}, which takes its scope as a parameter for
 * exactly this reason.
 *
 * Callers that ALREADY hold a resolved scope (notably `withPlanLock`'s returned
 * `result.scope`) should thread THAT through rather than resolving again.
 *
 * Lives in its own module rather than in `_ctx-opts.ts` so that importing it
 * does not pull `source.ts` (fs + pg + the harness registry) into every reader
 * that only wants `ctxToPlanSourceOpts`.
 */

import { resolvePlanScope } from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';

export interface PlanWriteScope {
  /** The tenant the row lives under — use for withWorkspace() AND the WHERE clause. */
  workspaceId: string;
  /** The Hive-home-collapsed harness slug the row is keyed on. */
  harnessSlug: string;
}

export async function resolvePlanWriteScope(ctx: unknown): Promise<PlanWriteScope> {
  return resolvePlanScope(await ctxToPlanSourceOpts(ctx));
}
