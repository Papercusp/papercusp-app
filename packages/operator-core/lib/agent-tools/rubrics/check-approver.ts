import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { checkAcceptanceBarApproverEligibility } from '../../rubrics';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';

const argsSchema = z.object({
  rubricRef: z.string().trim().min(1).max(200).describe('the started acceptance rubric ref'),
  ownerId: z.string().trim().min(1).max(200).describe('the prospective reviewer identity to screen'),
  applierId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('the identity that will apply the amendment, when known'),
});

function normalizeRubricRef(ref: string): string {
  const typed = /^plan:(.+)$/i.exec(ref.trim());
  return typed?.[1]?.trim() || ref.trim();
}

export default defineTool({
  name: 'rubrics:check-approver',
  profile: 'engineer',
  description:
    'Read-only lineage screen for one identity as a reviewer of a started acceptance BAR amendment: the same screen the routed amendment review applies to every candidate. Reports eligibility only; it does not approve, authorize, or apply an amendment.',
  guidance: {
    when: 'Diagnose why a specific identity is or would be screened out as a reviewer of a started acceptance BAR amendment.',
    notWhen:
      'Not a way to pick a reviewer: never message a candidate yourself; rubrics:amend { dryRun:true, reviewPreviewPost } routes the review. An eligible result is not approval; the apply guard remains authoritative.',
    chaining:
      'rubrics:amend { dryRun:true, reviewPreviewPost } routes the review and runs this screen on every candidate → if review.state is no-eligible-reviewer, rubrics:check-approver { rubricRef, ownerId } explains one identity\'s verdict.',
    seeAlso: ['rubrics:amend (preview and apply the exact amendment)', 'rubrics:get (read the full rubric criteria)'],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: argsSchema,
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    return runWithWorkspaceIfConcrete(identity.workspaceId ?? undefined, async () => {
      const result = await checkAcceptanceBarApproverEligibility({
        rubricId: normalizeRubricRef(args.rubricRef),
        ownerId: args.ownerId,
        ...(args.applierId ? { applierId: args.applierId } : {}),
      });
      return { data: { ok: true, rubricRef: args.rubricRef, ...result } };
    });
  },
});
