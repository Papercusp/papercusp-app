/**
 * dev:coord_categorize — the re-runnable VALIDATION INSTRUMENT for
 * coordination-message automation (coord-lifecycle-automation-2026-06-04 D-006).
 *
 * Categorizes the coord_event_log `messages` corpus into the lifecycle buckets
 * (D-003 table) + the irreducible `contextual` residual, and returns the
 * headline percentages. The plan's success criterion: "re-run after each phase —
 * the contextual bucket should be the only thing left on coord:send." As
 * automation lands, completion/claim/intent prose becomes `auto`-stamped
 * `coord:emit`s (the `lifecycle-auto` bucket), so `contextualPct` should fall
 * toward the ~5% the plan predicts and stay there.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import {
  categorizeCorpus,
  categorizeCoordMessage,
  type CoordMsgLike,
} from '../../coord-lifecycle/corpus-categorize';

export default defineTool({
  name: 'dev:coord_categorize',
  profile: 'engineer',
  description:
    'Categorize the coord_event_log `messages` corpus into lifecycle buckets (completion/claim/intent/restart/ack/finding) vs the irreducible contextual residual. The instrument for coord-lifecycle-automation D-006: re-run after each phase; contextualPct + automatedPct are the headline metrics.',
  guidance: {
    when: 'Measure coord-lifecycle automation progress — how much free-text coord is predictable lifecycle vs genuinely contextual.',
    notWhen: 'To read your inbox use coord:inbox; this is an aggregate measurement over the whole corpus, not a feed.',
    seeAlso: [
      'coord:inbox (read your actual inbox)',
      'dev:telemetry (other aggregate measures)',
    ],
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'curator', 'cup'],
  args: z.object({
    hours: z
      .number()
      .int()
      .positive()
      .max(8760)
      .optional()
      .describe('look-back window in hours; omit for all-time'),
    sample: z
      .number()
      .int()
      .min(0)
      .max(50)
      .default(10)
      .describe('# of contextual-residual example summaries to return (audit the residual is truly contextual)'),
  }),
  async handler(args) {
    const sql = getOrgPg().sql;
    const rows = args.hours
      ? await sql`
          select body from harness_shared.coord_event_log
          where surface = 'messages' and ts > now() - make_interval(hours => ${args.hours})`
      : await sql`select body from harness_shared.coord_event_log where surface = 'messages'`;

    const msgs: CoordMsgLike[] = (rows as unknown as Array<{ body: Record<string, unknown> | null }>).map((r) => {
      const b = (r.body ?? {}) as Record<string, unknown>;
      return {
        kind: typeof b.kind === 'string' ? b.kind : undefined,
        summary: typeof b.summary === 'string' ? b.summary : undefined,
        body: typeof b.body === 'string' ? b.body : undefined,
        auto: b.auto === true,
        lifecycle: typeof b.lifecycle === 'string' ? b.lifecycle : undefined,
      };
    });

    const report = categorizeCorpus(msgs);
    const residualSample = msgs
      .filter((m) => categorizeCoordMessage(m) === 'contextual')
      .slice(0, args.sample)
      .map((m) => (m.summary ?? m.body ?? '').slice(0, 140));

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, ...report, residualSample }, null, 2),
        },
      ],
    };
  },
});
