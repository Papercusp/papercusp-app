/**
 * blender:ideate-pass-record — record one su IDEATE pass on the Scout tick
 * ledger (su-ideate-learning-substrate-2026-07-10 P-010).
 *
 * The scout-cycle routine writes a durable row per tick (tick-ledger.ts /
 * harness_shared.scout_ticks) so "is the ideation engine actually firing, and
 * with what yield?" is answerable. An su session running IDEATE mode does the
 * same generative work by hand but left no such trace — so pacing/observability
 * (Phase 3) had nothing to measure the su side by. This thin tool writes the su
 * analogue: a status='ran', origin='su-ideate' tick (migration 571) attributed
 * to the caller's ownerId, carrying the pass's yield (ideas filed, observations
 * mined) and an optional note.
 *
 * origin='su-ideate' is the partition that keeps these rows OFF Scout's cadence
 * floor and health reads (readLastScoutRunAtMs / learning-loop health filter
 * origin='scout') — a su-ideate pass is observed, never mistaken for a Scout
 * cycle. Best-effort by contract, mirroring recordScoutTick: an observability
 * write must never fail the caller's real work.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';

import { recordScoutTick, type RecordScoutTickInput } from '../../scout/tick-ledger';
import {
  goalPlanningReviewInputSchema,
  goalPlanningReviewSchema,
  readGoalPlanningReviewContext,
  type GoalPlanningReview,
  type GoalPlanningReviewContext,
} from '../../goal-planning-review';
import type { GoalPlanFeedbackResult } from '../../scout/goal-feedback';
import { resolveAgentIdentity } from '../coordination/identity';
import { softText, LIMITS } from '../limits';

export const ideatePassRecordArgs = z
  .object({
    ideasFiled: z
      .number()
      .int()
      .min(0)
      .describe('how many ideas this pass filed/routed onward (improvements:capture / blender:route-idea)'),
    observationsMined: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('how many raw observations the pass examined before filing (the denominator of yield)'),
    notes: softText(LIMITS.ANNOTATION)
      .optional()
      .describe('a short free-form note on the pass (theme, corpus, what was skipped) — stored on the tick detail'),
    goalReview: goalPlanningReviewInputSchema.optional().describe(
      'Evidence-backed review of your current GOAL: adopt/revise/create a necessary plan, route work, report a blocker, or explain why existing plans suffice. Zero new ideas is valid. The server measures scope and portfolio fingerprint; this is not execution authority or a worker claim.',
    ),
  })
  .strict();
export type IdeatePassRecordArgs = z.infer<typeof ideatePassRecordArgs>;

/** The tool's payload — what was recorded and who it was attributed to. */
export interface IdeatePassRecordSuccess {
  ok: true;
  origin: 'su-ideate';
  status: 'ran';
  ideasFiled: number;
  observationsMined?: number;
  notes?: string;
  /** The ownerId the tick is attributed to (stored on detail.owner). */
  owner: string;
  /** The harness the pass ran for (the tick's install_slug). */
  installSlug: string;
  goalReview?: GoalPlanningReview;
  /** Per-plan ledger disposition for the review's goal-local plans (P-009). */
  goalFeedback?: GoalPlanFeedbackResult[];
}

export type IdeatePassRecordResult = IdeatePassRecordSuccess | {
  ok: false;
  reason: 'goal-review-unavailable' | 'goal-review-scope-mismatch';
  message: string;
};

/** Injectable seam — unit tests drive the flow with a fake recorder (no PG). */
export interface IdeatePassRecordDeps {
  recordTick: (input: RecordScoutTickInput) => Promise<void>;
  readGoalReviewContext: (workspaceId: string, ownerId: string) => Promise<GoalPlanningReviewContext | null>;
  /** P-009: feed a recorded review's goal-local plans into the routed-idea ledger. */
  recordGoalFeedback?: (input: {
    workspaceId: string;
    ownerId: string;
    review: GoalPlanningReview;
  }) => Promise<GoalPlanFeedbackResult[]>;
}

const defaultDeps: IdeatePassRecordDeps = {
  recordTick: recordScoutTick,
  readGoalReviewContext: readGoalPlanningReviewContext,
  recordGoalFeedback: async (input) => (await import('../../scout/goal-feedback')).recordGoalReviewFeedback(input),
};

/**
 * The testable core: map the pass onto a su-ideate tick and persist it.
 * Column mapping for the origin='su-ideate' row (Scout readers never see it):
 *   ideas_routed    ← ideasFiled        (ideas filed/routed onward this pass)
 *   ideas_generated ← observationsMined (raw observations examined)
 *   detail          ← { owner, notes? } (attribution + free-form context)
 */
export async function runIdeatePassRecord(
  args: IdeatePassRecordArgs,
  ctx: unknown,
  deps: IdeatePassRecordDeps = defaultDeps,
): Promise<IdeatePassRecordResult> {
  const identity = resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]);
  const ctxHarnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
  const installSlug =
    typeof ctxHarnessRaw === 'string' && ctxHarnessRaw && ctxHarnessRaw !== '*' ? ctxHarnessRaw : 'papercusp';
  const notes = typeof args.notes === 'string' && args.notes.trim() ? args.notes.trim() : undefined;
  const workspaceId = identity.workspaceId?.trim();
  let goalReview: GoalPlanningReview | undefined;
  if (args.goalReview) {
    const requested = goalPlanningReviewInputSchema.parse(args.goalReview);
    const context = workspaceId && workspaceId !== '*'
      ? await deps.readGoalReviewContext(workspaceId, identity.ownerId).catch(() => null)
      : null;
    if (!context) {
      return { ok: false, reason: 'goal-review-unavailable', message: 'Cannot verify this caller\'s current GOAL scope; no review was recorded.' };
    }
    if (requested.goalId !== context.goalId) {
      return { ok: false, reason: 'goal-review-scope-mismatch', message: 'The review does not name this caller\'s current GOAL; no review was recorded.' };
    }
    goalReview = goalPlanningReviewSchema.parse({
      ...requested,
      schemaVersion: 1,
      portfolioFingerprint: context.portfolioFingerprint,
      reviewedAt: context.observedAt,
    });
  }

  await deps.recordTick({
    ...(goalReview && workspaceId ? { workspaceId } : {}),
    status: 'ran',
    origin: 'su-ideate',
    installSlug,
    ideasRouted: args.ideasFiled,
    ideasGenerated: args.observationsMined ?? 0,
    detail: { owner: identity.ownerId, ...(notes ? { notes } : {}), ...(goalReview ? { goalReview } : {}) },
  });

  // Best-effort AFTER the review is durable: ledger feedback is derived metadata,
  // and a failure here must not un-record the review the caller just made.
  let goalFeedback: GoalPlanFeedbackResult[] | undefined;
  if (goalReview && workspaceId && goalReview.planRefs.length > 0 && deps.recordGoalFeedback) {
    goalFeedback = await deps
      .recordGoalFeedback({ workspaceId, ownerId: identity.ownerId, review: goalReview })
      .catch(() => undefined);
  }

  return {
    ok: true,
    origin: 'su-ideate',
    status: 'ran',
    ideasFiled: args.ideasFiled,
    ...(args.observationsMined != null ? { observationsMined: args.observationsMined } : {}),
    ...(notes ? { notes } : {}),
    owner: identity.ownerId,
    installSlug,
    ...(goalReview ? { goalReview } : {}),
    ...(goalFeedback ? { goalFeedback } : {}),
  };
}

/** Map the outcome onto the tool envelope. */
export function toToolResult(out: IdeatePassRecordResult): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
    ...(out.ok ? {} : { isError: true }),
  };
}

export default defineTool({
  name: 'blender:ideate-pass-record',
  description:
    "Record one su IDEATE pass on the Scout tick ledger: a status='ran', origin='su-ideate' tick attributed to you, carrying the pass's yield. Pass `ideasFiled` (required), `observationsMined?`, `notes?`. origin='su-ideate' keeps the row OFF Scout's cadence floor and health reads — a su pass is observed, never mistaken for a Scout cycle. Best-effort observability: call it once at the end of an ideate pass.",
  capability: 'harness:write',
  guidance: {
    when: 'At the end of an ideation pass or a scoped GOAL gap review. Record evidence and disposition in goalReview; ideasFiled may be zero when existing plans suffice or no eligible work exists. A recorded review is not proof of delegated execution.',
    notWhen:
      'Filing an individual idea (improvements:capture) or routing one to a plan (blender:route-idea) — this records the PASS, not an idea. Recording a Scout-cycle tick — that is the scout-cycle routine, not this tool.',
    chaining:
      'improvements:capture / blender:route-idea (file the ideas) → blender:ideate-pass-record { ideasFiled, observationsMined?, notes? } (record the pass). The su-partition pacing/observability reads (Phase 3) aggregate these origin=su-ideate ticks.',
    seeAlso: [
      'blender:route-idea (route one idea onto the plan rail)',
      'improvements:capture (file one idea/improvement)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: ideatePassRecordArgs,
  async handler(args, ctx) {
    return toToolResult(await runIdeatePassRecord(args, ctx));
  },
});
