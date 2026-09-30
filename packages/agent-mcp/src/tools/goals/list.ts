/**
 * List goals in the current workspace.
 *
 * Demonstrates the drizzle-zod pattern for MCP tools: response rows are
 * typed via `schemaOf(table).select` so the data sent back to the agent
 * matches the column shape declared in the migration — no hand-typed
 * `Record<string, unknown>`.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { desc } from 'drizzle-orm';
import { z } from 'zod';
import { generated, schemaOf } from '@papercusp/db-org';
import { defineTool } from '@papercusp/tooldef';
import { goalHolderKey, resolveGoalHoldersBatch } from '@papercusp/operator-core/lib/goals/holder';
import {
  goalActionable,
  resolveGoalEffectiveActivity,
} from '@papercusp/operator-core/lib/goals/activity';
import { parseGoalLaunchSettings } from '@papercusp/operator-core/lib/goal-launch-settings';
import {
  blockerStatusKey,
  goalReadiness,
  readGoalBlockedByEdges,
  resolveBlockerStatuses,
  type GoalBlockerEndpoint,
  type GoalReadiness,
} from './goal-deps';

const goals = generated.goalsInHarnessShared;
const GoalSelect = schemaOf(goals).select;
type GoalRow = z.infer<typeof GoalSelect>;

export default defineTool({
  name: 'goals:list',
  needsWorkspaceTx: true,
  capability: 'goals:read',
  description:
    'List goals in the active workspace. This is a workspace-global read, not a harness-scoped read: the transport supplies the workspace transaction, so call it with `{}` or the declared `detail`/`limit` options and do not pass `harness`.',
  guidance: {
    when: 'Workspace-global read: user asks "what are we trying to do?", "what are my goals?", "which goals are doable right now?" (read `actionable`), or you need a goal id before calling `goals:get`. The active workspace comes from the transport; do not pass `harness`.',
    notWhen: 'For TASKS (concrete TODOs), use `tasks:list`. Goals are the higher-level intent; tasks are how you get there.',
    chaining: 'Pair with `goals:get` for the full body + per-blocker verdicts.',
  },
  args: z.object({
    detail: z.enum(['summary', 'full']).default('summary'),
    limit: z.number().int().positive().max(200).default(50),
  }),
  // Output schema (token-efficient-tool-result-formats P-013) — flat scalar
  // array (default `summary` shape) → unlocks CSV + outputSchema advertisement.
  // actionable / premiseInvalidated: goal-dag-shared-substrate-2026-08-18 P-003
  // — derived on read from the shared dependency substrate (D-006).
  // `deactivated` (goal-live-holder-guarantee-2026-08-18 P-004, D-011): a
  // holder-required goal whose holder is gone is administratively `active` and
  // actually dormant. The summary shape deliberately carries no `status`, so it
  // could not state the falsehood outright — but listing a dead goal
  // indistinguishably from a live one is the same failure by omission, and this
  // is the read agents call most. One flat boolean keeps the row CSV-shaped.
  // `status` (EI-23738380307533850): the summary tier used to omit it, which
  // left `actionable` — a DERIVED boolean — in a projection that dropped its
  // determinant, so a killed goal read `actionable: true` with no field present
  // that could falsify it. `actionable` is now folded through `goalActionable`
  // in BOTH tiers (the fix that stops the class); carrying the determinant here
  // too is what makes the tier honest rather than merely correct. Still a flat
  // scalar, so the row stays CSV-shaped.
  result: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.string().nullable(),
      actionable: z.boolean(),
      premiseInvalidated: z.boolean(),
      deactivated: z.boolean(),
    }),
  ),
  async handler(args, ctx) {
    const txDb = drizzle(ctx.tx);
    const rows = (await txDb
      .select({
        id: goals.id,
        title: goals.title,
        body: goals.body,
        parent_id: goals.parentId,
        budget_cents: goals.budgetCents,
        created_at: goals.createdAt,
        workspace_id: goals.workspaceId,
        status: goals.status,
        launch_settings: goals.launchSettings,
      })
      .from(goals)
      .orderBy(desc(goals.createdAt))
      .limit(args.limit));

    // Readiness fold (P-003, D-002/D-003): one edge read + one batched status
    // resolve per workspace present in the page (normally exactly one). Derived
    // on read — goal cardinality is tiny (D-006).
    const readinessById = new Map<string, GoalReadiness>();
    for (const ws of new Set(rows.map((r) => r.workspace_id))) {
      const wsRows = rows.filter((r) => r.workspace_id === ws);
      const edges = await readGoalBlockedByEdges(ctx.tx, ws);
      const union: GoalBlockerEndpoint[] = [];
      const seen = new Set<string>();
      for (const r of wsRows) {
        for (const b of edges.get(r.id) ?? []) {
          const key = blockerStatusKey(b);
          if (seen.has(key)) continue;
          seen.add(key);
          union.push(b);
        }
      }
      const statuses =
        union.length > 0
          ? await resolveBlockerStatuses(ctx.tx, ws, union)
          : new Map<string, string>();
      for (const r of wsRows) {
        const view = (edges.get(r.id) ?? []).map((b) => ({
          ...b,
          status: statuses.get(blockerStatusKey(b)) ?? null,
        }));
        readinessById.set(r.id, goalReadiness(view));
      }
    }
    const readinessOf = (id: string) =>
      readinessById.get(id) ?? { actionable: true, premiseInvalidated: false, blockers: [] };

    // Deterministic deactivation (P-004, D-011). ONE holder read + ONE oracle
    // call for the whole page — `resolveGoalHoldersBatch` exists for exactly
    // this shape, so the per-row cost of the fold is zero queries. Goal
    // cardinality is tiny (D-006), so this is the same trade the readiness fold
    // above already makes.
    const holdersByGoal = await resolveGoalHoldersBatch(
      ctx.tx,
      rows.map((r) => ({ goalId: r.id, workspaceId: r.workspace_id })),
    );
    const activityOf = (r: (typeof rows)[number]) => {
      // An absent entry would be a bug in the batch resolver, not a goal without
      // holders (that case is `unheld`) — but defaulting to `unknown` keeps a
      // resolver bug from silently DEACTIVATING every row, which is the one
      // direction this fold must never fail in.
      const liveness = holdersByGoal.get(goalHolderKey(r.workspace_id, r.id))?.liveness ?? 'unknown';
      const { settings } = parseGoalLaunchSettings(r.launch_settings);
      const activity = resolveGoalEffectiveActivity({
        status: r.status,
        launchSettings: settings,
        liveness,
      });
      // Report the liveness we MEASURED, not `activity.liveness` — that one is
      // null whenever status short-circuited the fold (paused / terminal), so
      // reading it here would tell a caller `unknown` about a paused goal whose
      // holders we just resolved perfectly well.
      return { activity, liveness };
    };

    if (args.detail === 'summary') {
      return {
        data: rows.map((r) => {
          const readiness = readinessOf(r.id);
          const { activity } = activityOf(r);
          return {
            id: r.id,
            title: r.title,
            status: activity.effectiveStatus,
            actionable: goalActionable(readiness.actionable, activity),
            premiseInvalidated: readiness.premiseInvalidated,
            deactivated: activity.deactivated,
          };
        }),
      };
    }
    return {
      data: rows.map((r) => {
        const { activity, liveness } = activityOf(r);
        const readiness = readinessOf(r.id);
        // `launch_settings` is an input to the fold, not an output — the
        // resolved `holderPolicy` says what it MEANT, without handing back a
        // raw blob every caller would have to re-parse.
        const { launch_settings: _launchSettings, ...row } = r;
        return {
          ...row,
          actionable: goalActionable(readiness.actionable, activity),
          premiseInvalidated: readiness.premiseInvalidated,
          blockedBy: readiness.blockers,
          status: activity.effectiveStatus,
          rawStatus: r.status,
          deactivated: activity.deactivated,
          holderLiveness: liveness,
          holderPolicy: activity.policy,
        };
      }),
    };
  },
});
