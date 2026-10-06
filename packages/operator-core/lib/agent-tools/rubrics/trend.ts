/**
 * rubrics:trend — the qualitative health TREND for a rubric
 * (plan-templates-and-rubric-v2-2026-06-20 P-010 / D-004).
 *
 * The every-turn Overwatch scorecard already IS a per-criterion rating
 * time-series; this rolls it up — per criterion, over time, with a direction —
 * so the Queen/owner sees "queen-placement-health: degraded, worsening over 5
 * ratings" instead of re-reading raw scorecards. Pure read+aggregate over the
 * scorecards (P-013, scorecards:list) — no new data, the quick-win the data
 * already supported.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { scorecardTrend } from '../../scorecards';

export default defineTool({
  name: 'rubrics:trend',
  profile: 'engineer',
  description:
    'Rubric health trend: per-criterion direction, distribution and first/latest ratings. includeSeries adds chronological RLE runs. staleness detects persistently unassessable criteria, excluding idle unknowns. observationAge separately judges retained observation ends against observationMaxAgeSec: fresh, stale, mixed or unknown, with timestamp coverage. Omitted horizon or incomplete/invalid/future timestamps means unknown. Filing freshness is separate.',
  guidance: {
    when: 'You want to see how a rubric\'s criteria have trended OVER TIME — is a characteristic improving or worsening? which criteria are degrading across recent wakes? Or whether the rubric ITSELF is STALE (its model drifted — `staleness.stale`). The qualitative health-over-time view, vs a single point-in-time scorecard.',
    notWhen:
      'You want the raw recent scorecards (point-in-time standing + completeness via missingKeys) — scorecards:list. You want the rubric DEFINITION (criteria/model/method) — rubrics:get. You want the cross-corpus ideation rollup — curation:state-of-pot.',
    chaining:
      'rubrics:list { status: "active" } → rubrics:trend { rubricRef, since } → drill a worsening criterion via scorecards:list { rubricRef, since } → work_items:get on a scorecard issueId. If `staleness.stale`, re-ratify the rubric via the rubric↔scout loop (revise template_data → plans:set-plan-status).',
    seeAlso: [
      'scorecards:list (raw point-in-time scores vs this over-time view)',
      'rubrics:get (the rubric DEFINITION — criteria/model/method)',
      'curation:state-of-pot (the cross-corpus ideation rollup)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      rubricRef: z.string().min(1).describe('the rubric to trend, e.g. "pot-coordination-health" (a trend is per-rubric)'),
      sourceHive: z.string().optional().describe('restrict the trend to one source-hive'),
      since: z
        .string()
        .optional()
        .describe('ISO timestamp — only scorecards filed at/after this (the trend window); omit for all'),
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe('max scorecards to aggregate (newest-first read; default 500)'),
      observationMaxAgeSec: z
        .number()
        .finite()
        .positive()
        .optional()
        .describe('explicit observation-age horizon in seconds for the retained cohort; omitted means unknown, independent of filing time and rubric staleness'),
      includeSeries: z
        .boolean()
        .optional()
        .describe(
          'also return each criterion\'s chronological series as RLE runs {rating, from, to, n} (default false — the summary fields are the payload)',
        ),
      includeDefinition: z
        .boolean()
        .optional()
        .describe(
          'also return the resolved full rubric definition (default false — most trend consumers need only aggregates)',
        ),
    }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const trend = await scorecardTrend({
      rubricRef: args.rubricRef,
      sourceHive: args.sourceHive,
      since: args.since,
      limit: args.limit,
      observationMaxAgeSec: args.observationMaxAgeSec,
      includeSeries: args.includeSeries,
      includeDefinition: args.includeDefinition,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, trend }),
        },
      ],
    };
  },
});
