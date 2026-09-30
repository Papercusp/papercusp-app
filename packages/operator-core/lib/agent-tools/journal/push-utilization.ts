/**
 * journal:push-utilization — the P-011 per-matcher utilization dashboard
 * (ambient-semantic-push-2026-07-14 Phase 6): pushed → pulled? → acted? rates,
 * drop reasons, and an ADVISORY-ONLY retire/tune/keep recommendation per
 * matcher, read from harness_shared.push_delivery (migration 610). Read-only —
 * eviction/tuning is a HUMAN decision informed by this report (plan D-005 /
 * carry D-001); the runtime control path (ambient-push selectPushes) never
 * reads utilization. Co-registered with the journal tools because the delivery
 * rail this reports on rides the journal turn seam (record-turn).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { runUtilizationReport } from '../../push-utilization-io';

export default defineTool({
  name: 'journal:push-utilization',
  profile: 'engineer',
  description:
    'Ambient-push utilization dashboard (P-011): per-matcher pushed → pulled? → acted? engagement rates + drop reasons over the push_delivery ledger, with an ADVISORY-ONLY retire/tune/keep recommendation per matcher. Read-only; eviction/tuning is a human decision — telemetry never steers the delivery control path (D-005).',
  guidance: {
    when: 'Reviewing whether the ambient matchers (collision / dead-end / topic-sub / insight) earn their injection budget: "which pushes get pulled or acted on, and which are delivered and ignored?" — the standing utilization test every matcher lives under, and the data behind any human eviction/tuning call.',
    notWhen: 'You want the raw recent pushes themselves (query push_delivery / the delivery store directly), or you want to CHANGE matcher behavior — that is a reviewed config/code edit, never an act of this surface.',
    chaining:
      'journal:push-utilization → a matcher reads underutilized → a HUMAN decides retire/tune (the report is advisory by construction) → any change lands as a normal reviewed edit.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    ownerId: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('cut to one receiving owner (default: all receivers)'),
    sinceHours: z
      .number()
      .positive()
      .max(24 * 90)
      .optional()
      .describe('enqueue-window lookback in hours (default 168 = 7 days)'),
    limit: z.number().int().positive().max(500).optional().describe('max ledger rows read (default 500)'),
    graceMinutes: z
      .number()
      .positive()
      .max(24 * 60)
      .optional()
      .describe(
        'observation grace: a delivered push with no pull/act stamp counts as IGNORED only after this many minutes (default 60); younger rows stay pending and are excluded from rates',
      ),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const sinceHours = args.sinceHours ?? 168;
    const result = await runUtilizationReport({
      targetOwnerId: args.ownerId,
      since: new Date(Date.now() - sinceHours * 60 * 60 * 1000),
      limit: args.limit,
      observationGraceMs: args.graceMinutes != null ? args.graceMinutes * 60 * 1000 : undefined,
    });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
});
