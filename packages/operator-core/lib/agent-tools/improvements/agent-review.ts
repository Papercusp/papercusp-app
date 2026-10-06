/**
 * Public agent-review door over the existing work-item + Blender lifecycle.
 *
 * Identity is always caller-derived. Review pickup requires one concrete harness
 * and cannot select the submitter's own row; resubmission is accepted only from
 * the original submittedBy owner in the lifecycle core.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  claimAgentReview,
  claimNextAgentReview,
  resubmitAgentReview,
} from '../../harness/improvements/agent-review';
import { readAgentReviewState } from '../../harness/improvements/agent-review-policy';
import type { WorkItem } from '../../work-items';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { harnessRequiredResult, resolveConcreteHarnessSlug } from '../_harness-scope';

function gradeHandoff(workItem: WorkItem | null) {
  const review = workItem ? readAgentReviewState(workItem.payload) : null;
  if (review?.status !== 'pending') return {};
  return {
    ledgerIdeaId: review.ledgerIdeaId,
    gradeWith: { ideaId: review.ledgerIdeaId },
  };
}

export default defineTool({
  name: 'improvements:agent-review',
  profile: 'engineer',
  description:
    'Claim a specific or the next peer-review item in one concrete harness, or resubmit a revision-requested item. Review grades still go through blender:grade-idea; this door only owns reviewer pickup and submitter resubmission.',
  guidance: {
    when: "Use mode:'claim' with an id when a directed review must take one known pending item without consuming unrelated review work. Use mode:'claim-next' only to take the next pending change/feature. Then grade its routed idea with blender:grade-idea. Use mode:'resubmit' after addressing the review feedback on your own revision-requested item — or to adopt one whose original submitter's session is provably gone, which is otherwise stuck forever.",
    notWhen:
      'Do not use this to grade or approve — blender:grade-idea is the sole grade authority. Do not use ordinary scheduler:get_next for pending review work; that lane excludes it until approval.',
    chaining:
      "improvements:agent-review { mode:'claim', id, harness? } (directed) OR { mode:'claim-next', harness? } (queue order) → use returned gradeWith.ideaId or ledgerIdeaId with blender:grade-idea { ideaId, grade, feedback? }; revision author fixes → improvements:agent-review { mode:'resubmit', id }.",
    seeAlso: [
      'blender:grade-idea (record the peer grade and drive approval/revision)',
      'work_items:get (read the claimed work and its checkpoint)',
      'work_items:comment (record review-relevant progress)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('claim'),
      id: z
        .string()
        .min(1)
        .max(80)
        .describe('The pending peer-review work-item id to claim without consuming another review candidate.'),
      harness: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe(
          "Harness containing the review item. Omit only when the session is already scoped to one concrete harness; 'all' and '*' are refused.",
        ),
    }),
    z.object({
      mode: z.literal('claim-next'),
      harness: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe(
          "Harness to review. Omit only when the session is already scoped to one concrete harness; 'all' and '*' are refused.",
        ),
    }),
    z.object({
      mode: z.literal('resubmit'),
      id: z
        .string()
        .min(1)
        .max(80)
        .describe("The revision-requested work-item id — yours, or an orphan whose submitter is gone."),
    }),
  ]),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    if (args.mode === 'claim' || args.mode === 'claim-next') {
      const harnessSlug = resolveConcreteHarnessSlug(args.harness, ctx);
      if (!harnessSlug) return harnessRequiredResult('improvements:agent-review');
      if (args.mode === 'claim') {
        const result = await claimAgentReview({
          id: args.id,
          reviewer: identity.ownerId,
          harnessSlug,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                mode: 'claim',
                ...result,
                ...gradeHandoff(result.claimed ? result.workItem : null),
              }),
            },
          ],
        };
      }
      const workItem = await claimNextAgentReview({ reviewer: identity.ownerId, harnessSlug });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'claim-next',
              claimed: workItem !== null,
              workItem,
              ...gradeHandoff(workItem),
            }),
          },
        ],
      };
    }

    const result = await resubmitAgentReview({ id: args.id, submittedBy: identity.ownerId });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, mode: 'resubmit', ...result }),
        },
      ],
    };
  },
});
