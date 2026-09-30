/**
 * goals:propose — put a READ-THROUGH goal proposal in front of the owner as a
 * pre-filled, fully-editable confirm card, instead of handing them a blank form.
 *
 * WHY THIS TOOL EXISTS AT ALL (goal-mode-2026-08-07 P-022, D-024). GOAL mode's
 * kickoff already mandates reading the existing portfolio, proposing a concrete
 * KILL CRITERION and SPEND CEILING "rather than offering a blank menu", and
 * settling the RELATIONSHIP to whatever already targets the goal. All of that
 * work happens BEFORE any row is written — and until now it had nowhere to
 * land: the agent either created the goal unilaterally, or narrated four values
 * in prose and hoped. This tool is the landing place. It writes NOTHING; it
 * hands the owner the agent's proposal with every field editable and one button
 * that calls `goals:create`.
 *
 * WHY NOT A "New Goal" FORM (the alternative this replaces). Both paths write
 * the same four values, so the question is what PRODUCES them. A form asks for
 * them cold, before anything has been read — and the two fields it degrades
 * worst are the KILL CRITERION and the CEILING, which are the only things that
 * can ever stop a goal. Worse, `relationship` is a question a form cannot ask:
 * "is this a step inside the goal already running, a sub-goal, or a separate
 * one?" is unanswerable until the portfolio has been read, so a form defaults BY
 * OMISSION to the wrong answer (a new top-level goal silently owning a pot that
 * already has an owner). Hence `relationship` is REQUIRED here.
 *
 * WHY killCriterion + budgetCents ARE REQUIRED HERE THOUGH OPTIONAL ON
 * goals:create. `goals:create` must stay able to file a goal whose criterion is
 * genuinely unquantifiable (and is called by scripts and humans). This tool is
 * the CONTRACT-BEARING door: its whole purpose is to carry the two mandated
 * values, so omitting one is a caller bug, not a degraded mode. A proposal
 * without them is exactly the blank menu the contract forbids.
 *
 * RENDERING — the tool-call args ARE the card's payload. The chat-card registry
 * keys on the tool NAME and reads `args` straight off the transcript's tool_use
 * block, so nothing here needs to know about cards. See D-024 for the verified
 * chain (and for why `ctx.askUser` cannot be used: an su session has no runId).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
import { killCriterionProblem } from '@papercusp/operator-core/lib/goals/kill-criterion';
import { SU_WRITE_ROLES } from '../../role-config';
import { TripwireSchema } from './create';

/**
 * The three relationships GOAL mode's kickoff contract enumerates, plus the
 * case where nothing already targets the goal.
 *
 * `new-top-level` is deliberately NOT the default — it is the answer a form
 * gives by omission, and the contract's line is that "the default answer is not
 * 'a new goal'". Making the caller name it forces the portfolio read to have
 * actually happened.
 */
export const GOAL_RELATIONSHIP_KINDS = [
  'plan-in-existing-pot',
  'sub-goal',
  'sibling-goal',
  'new-top-level',
] as const;

export const GoalRelationshipSchema = z.object({
  kind: z.enum(GOAL_RELATIONSHIP_KINDS).describe(
    'plan-in-existing-pot = a step in a goal already running (the usual right answer, and NOT a goal); sub-goal = separate outcome that only matters because a parent does (needs ref); sibling-goal = independent outcome merely sharing tooling; new-top-level = nothing already targets this',
  ),
  ref: z
    .string()
    .max(200)
    .optional()
    .describe('the goal id / pot slug this relates to — REQUIRED for every kind except new-top-level'),
  why: z
    .string()
    .min(1)
    .max(600)
    .describe('why THIS relationship and not the other two — the contract requires saying which you chose and why'),
});
export type GoalRelationship = z.infer<typeof GoalRelationshipSchema>;

export const GoalProposalSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(500)
    .describe('the outcome, stated so its achievement is checkable — not "apps that make money"'),
  body: z
    .string()
    .max(20000)
    .optional()
    .describe('what winning looks like, scope, constraints — shown to the owner as the proposal rationale'),
  killCriterion: z
    .string()
    .min(1)
    .max(2000)
    .describe('the written condition under which this goal is ABANDONED. Propose a concrete one; never a blank or a platitude'),
  budgetCents: z
    .number()
    .int()
    .nonnegative()
    .describe('proposed spend ceiling in cents — a concrete figure you can defend, not a guess left to the owner'),
  tripwires: z
    .array(TripwireSchema)
    .max(12)
    .optional()
    .describe('structured form of the criterion — renders as live bars ("day 12 of 30") instead of prose nobody re-checks'),
  relationship: GoalRelationshipSchema.describe(
    'what this goal is RELATIVE TO what already exists — settle it before creating anything',
  ),
});
export type GoalProposal = z.infer<typeof GoalProposalSchema>;

/**
 * Refusals the tool returns instead of presenting an unconfirmable card.
 *
 * Each is a case where the proposal would render as a card the owner cannot
 * sensibly act on, so failing loudly beats showing it. Returned as `degraded`
 * (the tool's own convention) rather than thrown, so the agent gets the reason
 * and can re-propose in the same turn.
 */
export function validateProposal(p: GoalProposal): string[] {
  const problems: string[] = [];
  if (p.relationship.kind !== 'new-top-level' && !p.relationship.ref) {
    problems.push(
      `relationship.kind '${p.relationship.kind}' names an EXISTING thing, so relationship.ref (the goal id / pot slug) is required — without it the owner cannot tell what this attaches to`,
    );
  }
  if (p.relationship.kind === 'new-top-level' && p.relationship.ref) {
    problems.push(
      'relationship.kind is new-top-level but a ref was given — if something already targets this goal, the kind is one of the other three',
    );
  }
  // A criterion that states no condition is the blank menu wearing a sentence.
  // The rule itself lives in `killCriterionProblem` and is SHARED with
  // `goals:update` (P-009): the owner can now set a criterion inline from the
  // detail panel, and an edit door with its own copy of this check is exactly
  // how you end up able to install a criterion this door would have refused.
  const criterionProblem = killCriterionProblem(p.killCriterion);
  if (criterionProblem) problems.push(criterionProblem);
  return problems;
}

export default defineTool({
  name: 'goals:propose',
  description:
    'Present a goal PROPOSAL to the owner as a pre-filled, fully-editable confirm card — every field carries your proposed value and one button calls goals:create. Writes nothing. ' +
    '{ title, killCriterion, budgetCents, relationship{kind,ref?,why}, body?, tripwires? }. ' +
    'killCriterion and budgetCents are REQUIRED (they are the two things a goal cannot run without); `relationship` is the question a blank form cannot ask.',
  capability: 'goals:write',
  guidance: {
    when:
      'GOAL-mode kickoff, AFTER reading the existing portfolio (goals:list + pot:list + plans:list) and settling the relationship — call this INSTEAD of goals:create so the owner confirms your proposed criterion and ceiling. If they are at a terminal with no GUI, the result is your script: read the proposal out, and call goals:create yourself once they agree.',
    notWhen:
      'Not for a goal the owner already specified in full (call goals:create). Not for updating a live goal (goals:update). Never as a way to ask a blank question — if you cannot propose a concrete criterion and ceiling, you have not read the portfolio yet.',
    chaining: 'goals:list/pot:list (read the portfolio) → goals:propose → owner confirms → goals:create.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_WRITE_ROLES],
  args: GoalProposalSchema,
  async handler(args) {
    const problems = validateProposal(args);
    if (problems.length > 0) {
      return {
        data: null,
        degraded: true,
        degradedReasons: problems,
      };
    }

    // The card reads its values off THIS call's args, not off the return —
    // the return is what the AGENT needs, which is different: confirmation
    // that the proposal is now in front of the owner, and an unambiguous
    // instruction not to also create the goal itself.
    return {
      data: {
        presented: true,
        proposal: {
          title: args.title,
          kill_criterion: args.killCriterion,
          budget_cents: args.budgetCents,
          relationship: args.relationship,
          tripwires: args.tripwires ?? null,
        },
        next:
          'The owner now has an editable confirm card; its button calls goals:create with whatever they land on, so do NOT call goals:create yourself. ' +
          'They may edit any field — treat THEIR values as final, not yours. ' +
          'If this conversation has no GUI surface (a terminal-only session), the card never renders: read the four values out, and call goals:create once they agree.',
      },
    };
  },
});
