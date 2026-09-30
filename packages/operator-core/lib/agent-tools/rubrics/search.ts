/**
 * rubrics:search — full-text search over rubric id / characteristic / title /
 * description (rubric-driven-observations-2026-06-20 P-002). The dedup check before
 * proposing a new rubric, and a keyword way to find an existing standard.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { searchRubrics } from '../../rubrics';

export default defineTool({
  name: 'rubrics:search',
  profile: 'engineer',
  description:
    "Full-text search rubrics by id / characteristic / title / description. Use before rubrics:propose to avoid a duplicate, or to locate an existing standard by keywords. Default scope is kind:'standard' (acceptance rubrics — one per plan — are excluded so the shared library stays bounded); a 0-count result under a single-kind scope carries `scopeNote` when the OTHER kind actually matches, so a scoped-empty read is never mistaken for genuine absence — check it before concluding none exists / proposing a duplicate.",
  guidance: {
    when: 'Before proposing a rubric (dedup), or to find a standard covering a characteristic by keyword.',
    notWhen: 'You want a filtered list by status/characteristic — rubrics:list. You have the id — rubrics:get.',
    chaining: 'rubrics:search → rubrics:get (use the existing one) / rubrics:propose (if none fits).',
    seeAlso: [
      'rubrics:list (filtered list by status/characteristic)',
      'rubrics:get (you already have the id)',
      'rubrics:propose (author one if none fits)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(200).optional(),
    kind: z
      .enum(['standard', 'acceptance', 'any'])
      .optional()
      .describe(
        "kind scope (default 'standard' — the reusable library). 'acceptance' / 'any' opt into per-plan acceptance rubrics",
      ),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const effectiveKind = args.kind ?? 'standard';
    const rubrics = await searchRubrics(args.query, args.limit, effectiveKind);
    // Scope-absence guard (EI-21914820970269971): 'standard' and 'acceptance' are the
    // only two rubric kinds, and a search scoped to one of them returning zero results
    // reads exactly like "no such rubric exists" — the false-absence class this tool's
    // own kind default (excluding the unbounded acceptance population from the shared
    // library) makes easy to trip. When the caller asked for one specific kind (not
    // 'any') and got nothing, check whether the OTHER kind matches; if it does, say so
    // instead of leaving a caller one step from proposing a duplicate of a rubric that
    // already exists just outside the scope they searched. Mirrors the docs:search
    // `scopeNote` convention for a scoped-but-not-absent result.
    let scopeNote: string | undefined;
    if (rubrics.length === 0 && effectiveKind !== 'any') {
      const otherKind = effectiveKind === 'standard' ? 'acceptance' : 'standard';
      const otherMatches = await searchRubrics(args.query, args.limit, otherKind);
      if (otherMatches.length > 0) {
        scopeNote =
          `0 ${effectiveKind}-kind rubrics matched, but ${otherMatches.length} ${otherKind}-kind ` +
          `rubric(s) do (e.g. "${otherMatches[0]!.rubricId}") — excluded by the kind:'${effectiveKind}' ` +
          "scope, not absent. Pass kind:'any' (or kind:'" +
          otherKind +
          "') to see them before concluding none exists.";
      }
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            count: rubrics.length,
            ...(scopeNote ? { scopeNote } : {}),
            rubrics: rubrics.map((r) => ({
              rubricId: r.rubricId,
              kind: r.kind,
              ...(r.subjectPlan ? { subjectPlan: r.subjectPlan } : {}),
              characteristic: r.characteristic,
              title: r.title,
              status: r.status,
              criteriaCount: r.criteria.length,
            })),
          }),
        },
      ],
    };
  },
});
