/**
 * goals:apply-package-update — the ACCEPT half of the goal-package update
 * story (work-on-everything-goal-2026-08-23 P-018; D-002 rule 3: a release
 * shipping v2 OFFERS the update, never silently rewrites).
 *
 * The offer is data on the read surfaces (goals:get `packageUpdate`, the HUD
 * board's `goalPackage` field); THIS door is the only writer, and nothing
 * calls it automatically. Dry-run by default (the house pattern): without
 * `confirm` it returns the per-field PLAN; with `confirm: true` it applies and
 * emits a `package_updated` event on the plan-events rail keyed by the goal id
 * (D-005 §2), so the owning agent's next orient folds the change — the "agent
 * notice" half of the plan item.
 */

import { z } from 'zod';
import type postgres from 'postgres';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { planGoalPackageUpdate, applyGoalPackageUpdate } from '../../goals/package-update';
import { resolveAgentIdentity } from '../coordination/identity';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { assertGoalWriteAuthorityForCaller } from '../../goals/write-authority';

const text = (payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(isError ? { isError: true as const } : {}),
});

export default defineTool({
  name: 'goals:apply-package-update',
  needsWorkspaceTx: true,
  description:
    "Apply a newer goal-package version to ONE packaged goal instance (P-018). Dry-run by default: without confirm it returns the PLAN (mode + per-field diff + withheld fields); confirm:true applies. A never-started install stub gets a FULL refresh (= what a fresh install would seed); a started instance gets CONTRACT fields only (title, body, killCriterion, tripwires with `current` preserved, IO schemas) — operational tuning (standing, budgets, launchSettings) and live state are never touched. Emits a package_updated plan event the owning agent's next orient folds.",
  guidance: {
    when: "goals:get (or the HUD) shows packageUpdate.updateAvailable on a packaged goal and the update should be adopted — plan first, then re-call with confirm:true.",
    notWhen:
      'Editing goal fields directly — goals:update / the set-* doors. Installing a package — cupboard:install-goal. Starting an installed one — goals:start-from-package.',
    chaining:
      "goals:get { id } → data.packageUpdate → goals:apply-package-update { goalId } (plan) → re-call with confirm:true.",
    seeAlso: ['goals:get (read the offer)', 'goals:update (hand-edit a goal instead)'],
  },
  capability: 'goals:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: z.object({
    goalId: z.string().min(1).describe('The packaged goal instance to update.'),
    confirm: z
      .boolean()
      .optional()
      .describe('Omit for the dry-run plan; true applies the planned update.'),
  }),
  async handler(args, ctx) {
    const workspaceId =
      ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : activeWorkspaceId();
    if (!workspaceId) return text({ error: 'no_workspace' }, true);
    const sql = ctx.tx as unknown as postgres.Sql;

    if (args.confirm !== true) {
      const plan = await planGoalPackageUpdate(sql, { workspaceId, goalId: args.goalId });
      if (!plan.ok) {
        const { ok: _ok, reason, ...rest } = plan;
        return text({ error: reason, ...rest }, true);
      }
      return text({ ok: true, dryRun: true, plan, hint: 'Re-call with confirm: true to apply.' });
    }

    await assertGoalWriteAuthorityForCaller(ctx, workspaceId, sql);
    const applied = await applyGoalPackageUpdate(sql, { workspaceId, goalId: args.goalId });
    if (!applied.ok) {
      const { ok: _ok, reason, ...rest } = applied;
      return text({ error: reason, ...rest }, true);
    }

    // The owning agent's notice: rides the EXISTING plan-events/orient rail
    // (D-005 §2 precedent — set-property's delta line), keyed by the goal id.
    // Best-effort (emitPlanEventForCaller swallows): the update itself is
    // committed either way, and the offer surfaces already reflect it.
    let actorId = 'system';
    try {
      actorId = resolveAgentIdentity(ctx).ownerId;
    } catch {
      /* unresolvable identity → 'system' */
    }
    await emitPlanEventForCaller(ctx, {
      planSlug: args.goalId,
      event: 'package_updated',
      before: applied.fromVersion,
      after: applied.toVersion,
      detail: `[${actorId}] goal package '${applied.ref}' ${applied.fromVersion} → ${applied.toVersion} applied (${applied.mode}): ${applied.applied.join(', ')}`,
    });

    return text(applied);
  },
});
