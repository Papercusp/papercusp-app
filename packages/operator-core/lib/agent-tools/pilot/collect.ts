/** pilot:collect — assemble real cohort observations and the D-022 report. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry.js';
import { collectPilotCohort, DEFAULT_PILOT_RUBRIC } from '../../pilot-cohort.js';
import { resolveAgentIdentity } from '../coordination/identity.js';
import { COORD_ROLES } from '../coordination/roles.js';

const gradeBinding = z.object({
  itemId: z.string().min(1),
  graderOwnerId: z.string().min(1),
  packetFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
});
const gradeCardReceipt = z.object({ itemId: z.string().min(1), cardId: z.string().min(1) });
const exactCompletionReceipt = z.object({
  itemId: z.string().min(1),
  event: z.string().min(1),
  awaitId: z.number().int().positive(),
  registeredAtMs: z.number().positive(),
});
const composedReceipt = z.object({
  kind: z.enum(['completion', 'grading']),
  batchIndex: z.number().int().nonnegative(),
  rootFingerprint: z.string().min(1),
  rootId: z.number().int().positive(),
  anchorAwaitId: z.number().int().positive(),
  leafCount: z.number().int().positive(),
  registeredAtMs: z.number().positive(),
});

export default defineTool({
  name: 'pilot:collect',
  profile: 'engineer',
  description:
    'Collect the exact completed 21-item directed-pair pilot cohort from canonical work-item, participant-receipt, scorecard and usage ledgers. Requires exact completion registration receipts (21 direct or composed 20+1), mandatory subject-filtered grading 20+1 receipts, prebound independent graders, exact returned card ids, and server-issued binding-to-close cost windows. Missing evidence is returned as typed gaps.',
  guidance: {
    when: 'Pilot items are terminal and have blinded rubric scorecards; you need per-item ArmObservation rows plus per-arm score, interval, wall-clock, cost and rare-event summaries.',
    notWhen:
      'Assigning/stamping a cohort (pilot:assign), emitting grades (scorecards:emit), or reading unfinished items as outcomes.',
    chaining:
      'pilot:assign → execute/complete → scorecards:emit with subject.ref=<item id> → pilot:collect → record the verdict in the plan and drive the adaptive tier gate.',
    seeAlso: ['pilot:assign', 'scorecards:emit', 'scorecards:list'],
  },
  ignoreSessionPayloadTier: true,
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES, 'judge'],
  args: z.object({
    itemIds: z.array(z.string().min(1)).length(21),
    harness: z.string().max(80).optional(),
    rubricRef: z.string().min(1).max(120).optional().default(DEFAULT_PILOT_RUBRIC),
    runbookAuthorOwnerId: z.string().min(1),
    gradeBindings: z.array(gradeBinding).length(21),
    gradeCardReceipts: z.array(gradeCardReceipt).length(21),
    completionExactReceipts: z.array(exactCompletionReceipt).length(21).optional(),
    completionComposedReceipts: z.array(composedReceipt).length(2).optional(),
    gradingComposedReceipts: z.array(composedReceipt).length(2),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const workspaceId = identity.workspaceId ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const result = await collectPilotCohort({
      workspaceId,
      itemIds: args.itemIds,
      harness: args.harness,
      rubricRef: args.rubricRef,
      operatorOwnerId: identity.ownerId,
      runbookAuthorOwnerId: args.runbookAuthorOwnerId,
      gradeBindings: args.gradeBindings,
      gradeCardReceipts: args.gradeCardReceipts,
      completionExactReceipts: args.completionExactReceipts,
      completionComposedReceipts: args.completionComposedReceipts,
      gradingComposedReceipts: args.gradingComposedReceipts,
    });
    return { data: result };
  },
});
