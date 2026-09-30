/** pilot:assign — preview or safely materialize a directed-pair pilot cohort. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry.js';
import { materializePilotCohort } from '../../pilot-cohort.js';
import { resolveAgentIdentity } from '../coordination/identity.js';
import { COORD_ROLES } from '../coordination/roles.js';
import { resolveConcreteHarnessSlug } from '../_harness-scope.js';

const candidate = z.object({
  id: z.string().min(1),
  tier: z.enum(['trivial', 'substantive', 'high-risk']),
  stratum: z.string().min(1).optional(),
  expectedUpdatedTs: z.number().int().nonnegative().optional(),
  expectedAssignee: z.string().min(1).optional(),
  expectedTakenAt: z.string().datetime().optional(),
});

export default defineTool({
  name: 'pilot:assign',
  profile: 'engineer',
  description:
    'Preview or atomically materialize the exact 21-item seeded directed-pair pilot cohort. Preview is pure and returns the deterministic assignment plus completion/grading fan-in plan. Confirmation derives workspace, harness and actor from tool context, requires exact frozen row/claim versions, validates canonical binding+dispatch receipts, re-reads the current green deployed pin, and applies all 21 stamps in one transaction.',
  guidance: {
    when: 'Preparing or starting the frozen 21-item directed-pair pilot cohort. Preview first, persist canonical participant claim/dispatch receipts, then confirm with exact expectedUpdatedTs/expectedAssignee/expectedTakenAt values after the arm-B live probe passes.',
    notWhen:
      'Hand-picking arms, supplying participant identity or cost-window timestamps, assigning trivial/high-risk work, or collecting results (pilot:collect). Never use generic payload edits to bypass this gate.',
    chaining:
      'pilot:assign { confirm:false } → run/verify the arm-B probe → pilot:assign { same seed/candidates, confirm:true } → execute items → blinded scorecards:emit → pilot:collect.',
    seeAlso: ['pilot:collect', 'scorecards:emit', 'work_items:get'],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    seed: z.string().min(1).max(200),
    candidates: z.array(candidate).length(21),
    harness: z.string().max(80).optional(),
    probeItemId: z.string().min(1).max(120).optional(),
    confirm: z.boolean().optional().describe('false/omitted = read-only preview; true = gated materialization'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const workspaceId = identity.workspaceId ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const harnessSlug = resolveConcreteHarnessSlug(args.harness, ctx);
    if (!harnessSlug) throw new Error('pilot:assign requires a harness-scoped session or harness argument');
    const result = await materializePilotCohort({
      workspaceId,
      harnessSlug,
      actor: identity.ownerId,
      seed: args.seed,
      candidates: args.candidates,
      probeItemId: args.probeItemId,
      confirm: args.confirm,
    });
    return { data: result };
  },
});
