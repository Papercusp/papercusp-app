/**
 * `coord:goal` — what an agent is currently working toward, as a REF
 * (unified-agent-state-plane-2026-07-27, P-016).
 *
 * THE `agent.goal` CELL'S RESOLVER LENS. It exists because a registered cell that
 * nothing can dispatch is not readable at all: `readCell` needs a read-only poll
 * tool to invoke, and a cell registered without one would return
 * `insufficient-data` forever — a registry entry nobody can use, which is the
 * "surface #29" failure D-010's adoption gate exists to prevent.
 *
 * ⚠ NOT A SECOND DERIVATION. This holds no logic: it calls `resolveOwnerGoal`,
 * the same function the cell names as its resolver and the same one P-026's
 * `HolderContext` seam calls. Agents should normally read
 * `state:read { cell:'agent.goal', as:'<ownerId>' }` rather than this tool
 * directly — that path applies the cell's audience check first. This is the door
 * that read goes through.
 *
 * ⚠ IT ANSWERS "RIGHT NOW", NOT "WHAT WAS TRUE THEN" (D-051). For the historical
 * question — what goal was a PAST tool call made under — read the P-009 stamp via
 * `sessions:timeline`. Taking the newest row of that log as current state is a
 * re-derivation from the wrong datum: it goes stale between calls and is silent
 * for an agent that has declared but not yet acted.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { resolveOwnerGoalWithAssessment, type GoalLens } from '../agent-goal-sources';

export default defineTool({
  name: 'coord:goal',
  description:
    "An agent's CURRENT goal as a resolvable ref (a work-item, a plan item, or a fleet mission) — auto-derived from what they hold, never prose they typed. Omit `ownerId` for your own. Returns { goal: null } when they hold nothing; `goal.agreement` says whether the underlying claims corroborate ('corroborated'), stand alone ('sole'), or disagree ('divergent'), and `goal.competing` lists every other ref they hold. Answers what they are doing NOW — for what a past tool call was made under, read the stamp via sessions:timeline.",
  guidance: {
    when: 'Before you wait on, interrupt, or duplicate a peer — read what they are actually working toward. Also when a claim, lock or release is blocked on someone: their goal ref tells you whether to wait or go elsewhere, and you can query the ref itself to see if it is still open.',
    notWhen:
      "The historical goal behind a past tool call — that is the P-009 stamp via sessions:timeline, not this. A holder's goal on a surface that already names them (a lock block, a claim refusal) — those already carry it. Prose about what someone is doing — this returns refs.",
    chaining:
      "coord:goal { ownerId } → work_items:get / plans:get-item on `goal.ref` to see whether the goal is still open → decide to wait or proceed. `goal.agreement:'divergent'` → read `goal.competing`: they hold more than one thing and the ref alone does not tell you which.",
  },
  // @cell-lens agent.goal
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    ownerId: z.string().max(200).optional().describe('The agent to ask about. Omit for your own goal.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const ownerId = (args.ownerId ?? '').trim() || identity.ownerId;
    /**
     * ⚠ THE LENS IS DECIDED HERE BECAUSE ONLY HERE IS IT KNOWABLE. This one tool
     * answers BOTH audiences off the same resolver — omit `ownerId` and it is a
     * self-read, name a peer and it is a peer-read — so the resolver cannot pick
     * a policy for lapsed plan-item claims on its own (EI-20073149682963544).
     * Asking about yourself surfaces a lapsed lease as COLD (you know you are
     * still working); asking about someone else keeps it filtered, because a
     * lapsed claim of theirs may genuinely be history.
     */
    const lens: GoalLens = ownerId === identity.ownerId ? 'self' : 'peer';
    const resolved = await resolveOwnerGoalWithAssessment(ownerId, lens);
    const { goal, assessment, diagnostics } = resolved;

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            ownerId,
            assessment,
            /**
             * ⚠ HOISTED TO THE TOP LEVEL DELIBERATELY — this is the cell's
             * declared `changeSignal.path`, and nesting it would break the read.
             * `valueAtPath` returns `undefined` the moment any segment is null,
             * so a path of `goal.ref` against a goal-less agent (`goal: null`)
             * would make `readCell` report `insufficient-data` — whose message
             * says the resolver's shape has "drifted apart" from the cell. That
             * is a FALSE diagnosis of the most ordinary case there is: an agent
             * holding nothing. Hoisted, the same case reads as `value: null`,
             * which is honest and is what the other nullable cells do.
             */
            goalRef: goal?.ref ?? null,
            /**
             * Axis 2's hoist. A null `goalRef` is not self-explaining, and the
             * caller who skips the detail object is exactly the one who would
             * read the null as "unknown/broken" rather than "holds nothing".
             * Named to match `ClaimHolder.goalUnknown`, which already draws this
             * distinction for the reader-independent projection.
             */
            goalUnknown: goal || diagnostics.length > 0 ? null : 'nothing-held',
            /**
             * ⚠ HOISTED FOR THE SAME REASON `goalRef` IS, and it was missed the
             * first time (P-011, agent-state-plane-verification-2026-07-27). This
             * is the `agent.goal` cell's declared FALSIFIER path, and nesting it
             * reproduced verbatim the bug the comment above describes: against a
             * goal-less agent (`goal: null`), `goal.agreement` does not exist, so
             * the falsifier is unreadable in the single most ordinary case there
             * is — the one the cell most needs it to explain.
             *
             * The headline was hoisted flat precisely to avoid that, and the
             * falsifier simply did not get the same treatment. Nothing caught it
             * because every existing assertion compared the declaration to another
             * declaration rather than to a payload.
             *
             * Purely additive: `goal.agreement` stays where the description and
             * `summary` already point.
             */
            goalAgreement: goal?.agreement ?? null,
            goalCompeting: goal?.competing ?? [],
            goalResolverDiagnostics: diagnostics,
            /**
             * Hoisted for the same reason `goalRef` and `goalAgreement` are: it is
             * ACTIONABLE ("re-claim before you edit"), and a reader who branches on
             * the flat fields must not have to reach into `goal` to find the one
             * caveat that changes what they should do next.
             *
             * ⚠ ONLY EVER TRUE ON A SELF-READ. The peer lens filters lapsed claims
             * out in SQL, so `false` there means "no lapsed claim was looked for",
             * not "their lease is warm" — which is why the self path is the only
             * one that can honestly say `true`.
             */
            goalLeaseCold: goal?.leaseCold ?? false,
            goal,
            // Prose for a human-facing surface. `goal`/`goalRef` stay branchable
            // because prose cannot be branched on.
            summary:
              diagnostics.length > 0
                ? `${ownerId}'s goal could not be fully verified: ${diagnostics.map((d) => `${d.leg}: ${d.detail}`).join('; ')}. Any partial raw goal remains visible, but its assessment is unavailable.`
                : goal
                  ? `${ownerId} → ${goal.ref} (${goal.source}, ${goal.agreement})${
                      goal.leaseCold
                        ? ' — ⚠ lease COLD: the plan-item claim behind this goal has passed its TTL. The work is still yours (nobody else took the row), but the fence is gone — re-claim before editing.'
                        : ''
                    }`
                  : `${ownerId} holds no work-item, plan-item claim or fleet mission, so there is no goal to report. That is an honest "nothing declared", not a failed read.`,
          }),
        },
      ],
    };
  },
});
