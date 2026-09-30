/**
 * goals:attach-pot / goals:detach-pot / goals:pots — the write and read halves
 * of the goal ↔ pot edge (goal-mode-2026-08-07 P-016).
 *
 * A goal is not a pot: it is pursued THROUGH pots, plural, and a pot can serve
 * more than one goal. Until this edge existed the GUI could not answer the
 * first question anyone asks of a goal — "what is actually working on this?" —
 * because the only link was an agent's memory of which pot it had made for
 * which purpose, which does not survive the session that made it.
 *
 * The domain logic (roles, tombstones, the one-main-owner rule, and the
 * DISTINCT-over-pots spend rollup) lives in `@papercusp/db-org`'s `goal-pots`
 * module, not here: operator-core needs the same functions for the
 * sync-resolver queries and cannot import this package.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
import { goalSpend, goalsForPot, linkPot, potsForGoal, unlinkPot } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { SU_WRITE_ROLES } from '../../role-config';
import { resolveGoalWorkspace as resolveWorkspace } from './_workspace';
import { assertGoalWriteAuthorityForCaller } from '@papercusp/operator-core/lib/goals/write-authority';

/**
 * Built fresh per call rather than shared as a frozen constant: `as const`
 * would widen `degradedReasons` to a readonly tuple, which does not satisfy the
 * mutable `string[]` the tool result declares.
 */
const noWorkspace = (): { data: null; degraded: boolean; degradedReasons: string[] } => ({
  data: null,
  degraded: true,
  degradedReasons: [
    'no concrete workspace in scope (neither the app.workspace_id GUC nor ctx.workspaceId resolved)',
  ],
});

export const attachPot = defineTool({
  name: 'goals:attach-pot',
  needsWorkspaceTx: true,
  description:
    'Record that a pot (harness) is being worked on IN SERVICE OF a goal. ' +
    '{ goalId, harnessSlug, role?: "owner"|"contributing", note? }. ' +
    'A pot may serve several goals — attaching to a second one does NOT detach the first.',
  capability: 'goals:write',
  guidance: {
    when:
      'Right after creating (or adopting) a pot for a goal you own. This edge is what makes the goal\'s page show its pots, its spend, and its progress — an unattached pot is invisible to the goal it serves.',
    notWhen:
      'For a unit of work inside a pot use work_items:create; the goal stamp on those is automatic from your GOAL mode. This tool is for the POT-level edge only.',
    chaining:
      'goals:create → pot:create → goals:attach-pot { role:"owner" } → plans:new inside that pot.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_WRITE_ROLES],
  args: z.object({
    goalId: z.string().min(1),
    harnessSlug: z.string().min(1).describe('the pot/harness slug'),
    role: z
      .enum(['owner', 'contributing'])
      .default('contributing')
      .describe(
        '"owner" = this goal is what the pot primarily exists for (at most ONE goal per pot — promoting demotes the incumbent to contributing). "contributing" = a real but secondary claim.',
      ),
    killCriterion: z
      .string()
      .max(2000)
      .optional()
      .describe(
        'what would make this goal STOP pursuing this pot (GOAL contract clause 4). Recorded on the link, not the harness, because a shared pot can warrant a different answer per goal.',
      ),
    note: z.string().max(1000).optional().describe('why this pot serves this goal'),
  }),
  async handler(args, ctx) {
    const workspaceId = await resolveWorkspace(ctx as never);
    if (!workspaceId) return noWorkspace();
    await assertGoalWriteAuthorityForCaller(ctx, workspaceId, ctx.tx as Sql);
    // workspace-work-scope-policy-2026-09-04 P-007: a goal may not be bound to a pot outside
    // the workspace work-scope policy — that binding is exactly how sidestage work leaked into
    // work-on-everything. Refused + ledgered; no policy ⇒ byte-identical.
    {
      const { gateWorkScope, workScopeRefusal } = await import('@papercusp/operator-core/lib/work-scope-policy');
      const scope = await gateWorkScope('goals:attach-pot', {
        harness: args.harnessSlug,
        goal: args.goalId,
        actor: ctx.uiClientId ?? null,
      });
      if (!scope.allowed) return { data: workScopeRefusal(scope, { goalId: args.goalId }) };
    }
    const link = await linkPot(ctx.tx as Sql, {
      workspaceId,
      goalId: args.goalId,
      harnessSlug: args.harnessSlug,
      role: args.role,
      by: ctx.uiClientId ?? null,
      note: args.note ?? null,
      killCriterion: args.killCriterion ?? null,
    });
    // How many goals this pot now serves — the number behind the "shared with
    // N goals" badge, returned here so the caller learns about a shared pot at
    // the moment it attaches rather than discovering it later as a surprising
    // spend figure.
    const siblings = await goalsForPot(ctx.tx as Sql, {
      workspaceId,
      harnessSlug: args.harnessSlug,
    });
    return {
      data: {
        ...link,
        servesGoals: siblings.map((s) => s.goalId),
        shared: siblings.length > 1,
      },
    };
  },
});

export const detachPot = defineTool({
  name: 'goals:detach-pot',
  needsWorkspaceTx: true,
  description:
    'Stop counting a pot toward a goal: { goalId, harnessSlug }. Tombstones the link (keeps the history) rather than deleting it.',
  capability: 'goals:write',
  guidance: {
    when:
      'A pot turned out not to serve this goal, or the goal moved on. Detaching removes it from the goal\'s page and from its spend rollup going forward.',
    notWhen:
      'Do NOT detach to record that a pot FAILED — that is what killing it says. A detached pot reads as "never really part of this", which loses the evidence that the goal tried something and stopped.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_WRITE_ROLES],
  args: z.object({ goalId: z.string().min(1), harnessSlug: z.string().min(1) }),
  async handler(args, ctx) {
    const workspaceId = await resolveWorkspace(ctx as never);
    if (!workspaceId) return noWorkspace();
    await assertGoalWriteAuthorityForCaller(ctx, workspaceId, ctx.tx as Sql);
    const removed = await unlinkPot(ctx.tx as Sql, {
      workspaceId,
      goalId: args.goalId,
      harnessSlug: args.harnessSlug,
      by: ctx.uiClientId ?? null,
    });
    return {
      data: { goalId: args.goalId, harnessSlug: args.harnessSlug, removed },
      ...(removed
        ? {}
        : {
            degraded: true,
            degradedReasons: [`no live link between ${args.goalId} and ${args.harnessSlug}`],
          }),
    };
  },
});

export const listGoalPots = defineTool({
  name: 'goals:pots',
  needsWorkspaceTx: true,
  description:
    'The pots a goal is pursued through, main owner first, with measured child-fleet spend rolled up from no earlier than the goal\'s creation (not interactive-session attribution): { goalId, sinceMs?, spend? }.',
  capability: 'goals:read',
  guidance: {
    when:
      'Reporting on a goal, reading measured child-fleet spend, or deciding where to put the next unit of effort. Read this BEFORE creating another pot — the portfolio pass GOAL mode mandates is exactly this call plus goals:list. It does not provide reliable per-session attribution for the interactive GOAL agent.',
    chaining: 'goals:list → goals:pots → pot:status per pot.',
  },
  // Principal-gated like its sibling reads (goals:list / goals:get) — the
  // write tools above are the ones that opt into role gating.
  args: z.object({
    goalId: z.string().min(1),
    spend: z.boolean().default(true).describe('include the spend rollup'),
    sinceMs: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'only count usage at or after this epoch-ms; the goal creation time remains the hard lower bound when omitted or earlier',
      ),
  }),
  async handler(args, ctx) {
    const workspaceId = await resolveWorkspace(ctx as never);
    if (!workspaceId) return noWorkspace();
    const pots = await potsForGoal(ctx.tx as Sql, { workspaceId, goalId: args.goalId });
    const shared = await Promise.all(
      pots.map(async (p) => ({
        ...p,
        servesGoals: (await goalsForPot(ctx.tx as Sql, { workspaceId, harnessSlug: p.harnessSlug }))
          .length,
      })),
    );
    if (!args.spend) return { data: { goalId: args.goalId, pots: shared } };
    const spend = await goalSpend(ctx.tx as Sql, {
      workspaceId,
      goalId: args.goalId,
      sinceMs: args.sinceMs,
    });
    return {
      data: {
        goalId: args.goalId,
        pots: shared,
        spend: {
          ...spend,
          // Named for what it measures. The goal agent's OWN turns are
          // subscription-billed and measure ~$0, so this is the cost of the
          // children a goal spawns — the number a ceiling should govern — not
          // a total cost of ownership.
          label: 'fleet spend',
          // Stated because it is counter-intuitive and summing is the natural
          // thing to do: a pot serving two goals counts IN FULL on both.
          note:
            'A shared pot counts in full against every goal it serves — goal spend figures DO NOT SUM into a portfolio total.',
        },
      },
    };
  },
});

export default attachPot;
