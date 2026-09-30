/**
 * rubrics:list — the rubrics store read surface (rubric-driven-observations-2026-06-20
 * P-002). Active first, then proposed. Returns summary rows (criteriaCount, not the full
 * criteria) — use rubrics:get for the full criteria.
 *
 * v1 (local-first-party-rubric-bundling-2026-07-07): the first read lazily SEEDS the
 * bundled first-party rubrics into the workspace store (listRubrics → loadAllRubrics →
 * ensureFirstPartyRubricsSeeded; idempotent, no-clobber), so a fresh install lists the
 * shipped set offline. v2 seam (flag FLAGS.RUBRICS_MARKETPLACE, dark): merge remote
 * Cupboard kind='rubric' listings on top, local-shadows-remote — the exact
 * templates:list merge shape; the remote fetch does not exist yet, the flag reserves it.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { listRubrics } from '../../rubrics';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';

export default defineTool({
  name: 'rubrics:list',
  profile: 'engineer',
  description:
    'List rubrics (shared standards for a system characteristic) — active first, then proposed. Filter by status / characteristic / subjectPlan (the acceptance rubric for one plan). Workspace-global, NOT harness-scoped — there is no `harness` filter; a rubric applies across the whole workspace, or (kind:\'acceptance\') to exactly the one plan named by `subjectPlan`. A rubric carries the model (how it should work), method, rating scale + drift markers, and per-characteristic criteria that agents grade STRUCTURED OBSERVATIONS against. Returns summary rows; use rubrics:get for full criteria.',
  guidance: {
    when: 'Before filing an observation — check whether an ACTIVE rubric fits the characteristic you are assessing, so you can file a structured (rated) observation instead of free-text. Overwatch/Blender: discover the rubric set to grade against. Need the acceptance rubric for a specific plan? Pass `subjectPlan: "<plan slug>"` (implies kind:\'acceptance\').',
    notWhen:
      'You already have the rubric_id and want the full criteria — rubrics:get. Free-text keyword lookup — rubrics:search. Scoping to a harness/project — not supported: rubrics are workspace-global, never pass a `harness` key (rejected as an unrecognized key).',
    chaining: 'rubrics:list { status: "active" } → rubrics:get { rubricRef } → file a structured observation.',
    seeAlso: [
      'rubrics:get (full criteria for an id)',
      'rubrics:search (free-text keyword lookup)',
      'rubrics:propose (author one when none fits)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  // Acceptance judges need the summary browse step to discover a rubric ref before
  // calling rubrics:get/evaluate. This is read-only and mirrors rubrics:get's judge
  // allowlist without widening judge into the general coordination role set.
  agentRoles: [...COORD_ROLES, 'judge'],
  args: z
    .object({
      status: z.enum(['proposed', 'active', 'retired']).optional().describe('filter by lifecycle status; omit for all'),
      characteristic: z.string().optional().describe('filter to one umbrella domain (e.g. "hive-coordination")'),
      kind: z
        .enum(['standard', 'acceptance', 'any'])
        .optional()
        .describe(
          "kind scope (default 'standard' — the reusable shared-standards library). 'acceptance' / 'any' opt into per-plan acceptance rubrics (one-shot definitions-of-done, acceptance-rubrics-on-every-plan-2026-08-11)",
        ),
      subjectPlan: z
        .string()
        .optional()
        .describe(
          "filter to the acceptance rubric(s) for this plan slug. Implies kind:'acceptance' when kind is omitted — subjectPlan applies ONLY to acceptance-kind rubrics, never the standard library, so it is refused together with an explicit kind:'standard'.",
        ),
      limit: z.number().int().positive().max(500).optional(),
    })
    .superRefine((val, ctx) => {
      if (val.subjectPlan && val.kind === 'standard') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "subjectPlan filters ACCEPTANCE rubrics only (standard-kind rubrics never carry one) — pass kind:'acceptance' or kind:'any', or omit kind (it is inferred as 'acceptance').",
          path: ['kind'],
        });
      }
    }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    return runWithWorkspaceIfConcrete(identity.workspaceId ?? undefined, async () => {
      const kind = args.kind ?? (args.subjectPlan ? 'acceptance' : undefined);
      const rubrics = await listRubrics({
        status: args.status,
        characteristic: args.characteristic,
        limit: args.limit,
        subjectPlan: args.subjectPlan,
        ...(kind ? { kind } : {}),
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              count: rubrics.length,
              rubrics: rubrics.map((r) => ({
                rubricId: r.rubricId,
                kind: r.kind,
                ...(r.subjectPlan ? { subjectPlan: r.subjectPlan } : {}),
                characteristic: r.characteristic,
                title: r.title,
                status: r.status,
                criteriaCount: r.criteria.length,
                ratingScale: r.ratingScale,
                methodRef: r.methodRef,
                updatedAt: r.updatedAt,
              })),
            }),
          },
        ],
      };
    });
  },
});
