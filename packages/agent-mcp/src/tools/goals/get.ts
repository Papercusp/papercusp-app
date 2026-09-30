/**
 * Get a single goal by id. Returns lineage (children + descendant tasks)
 * when detail='full'.
 *
 * Uses `schemaOf(generated.goalsInHarnessShared).select` so the response
 * row shape is the same Zod schema you'd use in a form or a CRUD admin
 * page — no hand-typed `Record<string, unknown>`.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { generated, schemaOf } from '@papercusp/db-org';
import { defineTool } from '@papercusp/tooldef';
import { resolveGoalHolders } from '@papercusp/operator-core/lib/goals/holder';
import {
  goalActionable,
  resolveGoalEffectiveActivity,
} from '@papercusp/operator-core/lib/goals/activity';
import { readGoalPortfolioThroughput } from '@papercusp/operator-core/lib/goals/portfolio-throughput';
import { parseGoalLaunchSettings } from '@papercusp/operator-core/lib/goal-launch-settings';
import { goalPackageUpdateInfo } from '@papercusp/operator-core/lib/goals/package-update';
import { readGoalReadiness } from './goal-deps';
import { readGoalLastPause, readGoalPause } from './pause-record';
import { readGoalHistory } from './history';

const goals = generated.goalsInHarnessShared;
const GoalSelect = schemaOf(goals).select;
type GoalRow = z.infer<typeof GoalSelect>;

export default defineTool({
  name: 'goals:get',
  needsWorkspaceTx: true,
  capability: 'goals:read',
  description:
    'Get one goal from the active workspace. This is a workspace-global read, not a harness-scoped read: the transport supplies the workspace transaction, so pass only the goal id and optional detail; do not pass `harness`.',
  guidance: {
    when: 'Workspace-global read: user names a specific goal and wants the rationale / acceptance criteria. The active workspace comes from the transport; do not pass `harness`.',
    notWhen: 'For a list of goals, use `goals:list` first; do not pass `harness` to route this read.',
    chaining: 'Follow `goals:list` to find the id, then call this with only the id and optional detail.',
  },
  args: z.object({
    id: z.string().min(1),
    detail: z.enum(['summary', 'full']).default('summary'),
    priorAttemptRefs: z.array(z.string().min(1)).max(20).optional(),
  }),
  async handler(args, ctx) {
    const txDb = drizzle(ctx.tx);
    const rows = (await txDb
      .select()
      .from(goals)
      .where(eq(goals.id, args.id))
      .limit(1)) as GoalRow[];
    if (!rows.length) {
      return { data: null, degraded: true, degradedReasons: [`goal ${args.id} not found`] };
    }
    const goal = rows[0];
    // Readiness (goal-dag-shared-substrate-2026-08-18 P-003, D-002/D-003):
    // derived on read from the shared dependency substrate. `actionable` = every
    // blocked-by edge satisfied (doable right now); `premiseInvalidated` = a
    // KILLED goal blocker — this goal needs review, not silent unblocking. A
    // READ, never a dispatch signal.
    const readiness = await readGoalReadiness(ctx.tx, goal.workspaceId, goal.id);
    // The DELIBERATE-PAUSE record (goal-live-holder-guarantee-2026-08-18 P-005,
    // D-009), parsed out of `metadata` rather than left for the caller to find.
    //
    // Surfaced at BOTH detail levels, and `status` joins the summary with it.
    // The precedent is unambiguous: `routines:set` wrote this same record for
    // months while `routines:list` selected `active` and not `metadata`, so the
    // responder it was written FOR still saw a bare stopped flag and filed a
    // deliberate hold as a suspected stall — twice, then a third time
    // (EI-19336000265007219). A durable record nobody can read is not a fix. A
    // summary that cannot say "paused, by whom, why" reproduces it exactly.
    const metadata = (goal.metadata ?? null) as Record<string, unknown> | null;
    const pause = readGoalPause(metadata);
    // DETERMINISTIC DEACTIVATION (P-004, D-011). The raw column says what a
    // human last wrote; it does NOT say whether the goal is still running. A
    // holder-required goal whose holder is gone is administratively `active`
    // and actually dormant, and answering `active` here is the motivating bug
    // with an AGENT as the victim rather than the board — the audience that
    // then acts on it.
    //
    // So `status` carries the DERIVED value and the administrative one moves to
    // `rawStatus`. This deliberately differs from the sync-resolver board rows,
    // which keep `status` raw and add `effectiveStatus` beside it: a UI renders
    // the field it was told to render, whereas an agent reads the obvious one.
    // Leaving `status` raw here would preserve the exact footgun while looking
    // like it had been fixed.
    //
    // An invalid `launch_settings` parses to null → the DEFAULT policy
    // (requireLive: true), never a silent opt-out; and `unknown` liveness (a
    // degraded oracle read) never deactivates.
    const holders = await resolveGoalHolders(ctx.tx, {
      workspaceId: goal.workspaceId,
      goalId: goal.id,
    });
    const { settings: launchSettings } = parseGoalLaunchSettings(goal.launchSettings);
    const activity = resolveGoalEffectiveActivity({
      status: goal.status,
      launchSettings,
      liveness: holders.liveness,
    });
    /**
     * PORTFOLIO THROUGHPUT (goal-mode-drift-guards-2026-08-31 P-002) — is this
     * goal's steward PLACING anything, or merely present?
     *
     * ── WHY IT IS ON THE SUMMARY BRANCH AND NOT GATED BEHIND detail='full' ──
     *
     * Because `state:subscribe` cannot ask for `full`. A cell subscription
     * dispatches its resolver with exactly `{ [callerRelativity.param]: subject }`
     * — here `{ id }` — so `detail` takes its schema default of 'summary' on
     * every poll. A block that appeared only under 'full' would be absent from
     * the one call path the cell exists to serve, and `valueAtPath` would report
     * the missing path as `insufficient-data`: the cell would answer "the
     * resolver's shape has drifted" forever, about a resolver working perfectly.
     *
     * The cost is one aggregate over `tool_invocations_coord_owner_idx` bounded
     * to this goal's holder ids. The expensive half — `resolveGoalHolders`, a
     * ledger read plus a liveness-oracle round trip — is ALREADY done above and
     * is threaded in rather than repeated.
     *
     * ⚠ ALWAYS PRESENT, NEVER NULL. Same `valueAtPath` rule: a null here would
     * make every nested cell path undefined and turn the ordinary
     * unmeasurable cases into a false shape-drift diagnosis. The resolver
     * carries its own `unavailable` hoist for exactly that, so absence of
     * evidence is reported IN the block instead of BY the block's absence.
     */
    const portfolioThroughput = await readGoalPortfolioThroughput(ctx.tx, {
      workspaceId: goal.workspaceId,
      goalId: goal.id,
      holders,
    });
    /**
     * WHO holds this goal — hoisted so BOTH branches return the identical value
     * (EI-22084485266424071).
     *
     * `holderLiveness` was already on the summary branch while `holders` was
     * gated behind detail='full', so the default read answered "held" and could
     * not say BY WHOM. A liveness verdict with no identity beside it is not a
     * weaker answer, it is an unusable one: the reader's next question is always
     * "held by whom, and are they actually working?", and the only remaining
     * source was `metadata.agentOwnerId` — a stale hand-written field that
     * pointed at a session recorded five days earlier, which is exactly how the
     * filing mistook a live goal for an abandoned one.
     *
     * The same argument the portfolioThroughput block above spells out applies
     * verbatim: `state:subscribe` dispatches its resolver with only `{ id }`, so
     * `detail` takes its 'summary' default on every poll and anything gated
     * behind 'full' is absent from the one call path that matters.
     *
     * Hoisted rather than copied because the defect was two independently
     * maintained response literals drifting apart. One value consumed twice
     * cannot drift; a second copy can, and did.
     */
    const holderIdentities = holders.holders.map((h) => ({
      ownerId: h.ownerId,
      live: h.live,
      sessionState: h.sessionState,
    }));
    const requestedHistoryRefs = args.priorAttemptRefs ?? [];
    const explicitHistoryRead = requestedHistoryRefs.length > 0;
    // Keep the continuity compiler off the agent-MCP bootstrap graph. It owns
    // plan/source readers, and eagerly importing it here makes every unrelated
    // tool test inherit that graph (including tests with intentionally narrow
    // plans/source mocks). A full or explicit drill-down is the only call path
    // that consumes it, so load the module exactly at that production boundary.
    const continuity =
      args.detail === 'full' || explicitHistoryRead
        ? await import('@papercusp/operator-core/lib/prior-attempt-context')
        : null;
    const historyContext = continuity ? await continuity.readGoalHistoryContext(goal.id) : undefined;
    const priorAttemptRecords = explicitHistoryRead
      ? await continuity!.resolvePriorAttemptRefs({
          target: { kind: 'goal', ref: goal.id },
          rawRefs: requestedHistoryRefs,
        })
      : undefined;
    if (args.detail === 'summary') {
      return {
        data: {
          id: goal.id,
          title: goal.title,
          status: activity.effectiveStatus,
          rawStatus: goal.status,
          deactivated: activity.deactivated,
          holderLiveness: holders.liveness,
          holders: holderIdentities,
          pause,
          actionable: goalActionable(readiness.actionable, activity),
          premiseInvalidated: readiness.premiseInvalidated,
          // P-018: the package-update OFFER, folded where the owning agent
          // already reads its goal. Null unless packaged; the accept is
          // goals:apply-package-update, never automatic.
          packageUpdate: goalPackageUpdateInfo(metadata),
          portfolioThroughput,
          ...(historyContext ? { historyContext } : {}),
          ...(priorAttemptRecords ? { priorAttemptRecords } : {}),
        },
      };
    }
    const children = (await txDb
      .select({ id: goals.id, title: goals.title })
      .from(goals)
      .where(eq(goals.parentId, args.id))) as Array<Pick<GoalRow, 'id' | 'title'>>;
    const history = await readGoalHistory(ctx.tx, {
      workspaceId: goal.workspaceId,
      goalId: goal.id,
    });
    return {
      data: {
        ...goal,
        // `...goal` spreads the RAW column, so these must land AFTER it — the
        // whole point is that a `full` read cannot hand back `active` for a
        // goal nothing is holding.
        status: activity.effectiveStatus,
        rawStatus: goal.status,
        deactivated: activity.deactivated,
        holderLiveness: holders.liveness,
        /** Why `deactivated` is what it is — the policy the fold actually used. */
        holderPolicy: activity.policy,
        holders: holderIdentities,
        children,
        history,
        historyContext,
        ...(priorAttemptRecords ? { priorAttemptRecords } : {}),
        pause,
        // The archived record of the last pause that has since been resumed —
        // "was this ever held, and by whom" survives the resume.
        lastPause: readGoalLastPause(metadata),
        actionable: goalActionable(readiness.actionable, activity),
        premiseInvalidated: readiness.premiseInvalidated,
        blockedBy: readiness.blockers,
        // P-018: see the summary branch's note.
        packageUpdate: goalPackageUpdateInfo(metadata),
        // P-002: the same reading the summary branch carries, at the same path,
        // so a cell declared against one branch cannot miss on the other.
        portfolioThroughput,
      },
    };
  },
});
