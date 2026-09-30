/**
 * curation:change-feed — the READ projection of the Change Feed (P-050).
 *
 * Query completions (work-item finishes, gym proposals, plan runs) across the
 * fleet or a single harness. Returns a ranked, salience-filtered feed where
 * each entry references the original — no duplicated log.
 *
 * Read-only, reuses the completion sources unchanged. Loads on the next :3070
 * restart like any new tool.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { gatherCompletions, rankChangeFeed, type ChangeFeedReaders } from '../../curation/change-feed';
import { buildChangeFeedReaders } from '../../curation/change-feed-deps';

export interface ChangeFeedRow {
  id: string;
  kind: 'completion' | 'proposal' | 'plan-run';
  title: string;
  detail: string | null;
  harness: string | null;
  workItemId: string | null;
  ref: string;
  ts: string;
  userRequested: boolean;
}

export interface ChangeFeedOpts {
  harness?: string;
  userRequestedOnly?: boolean;
  limit?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;

/** Project a ChangeFeedEntry to the feed row the tool returns. */
function toRow(e: Awaited<ReturnType<typeof gatherCompletions>>[number]): ChangeFeedRow {
  return {
    id: e.id,
    kind: e.kind,
    title: e.title,
    detail: e.detail ?? null,
    harness: e.harness ?? null,
    workItemId: e.workItemId ?? null,
    ref: e.ref,
    ts: e.ts,
    userRequested: e.userRequested ?? false,
  };
}

export default defineTool({
  name: 'curation:change-feed',
  description:
    'The Change Feed — a derived projection over completion records (work-item completions, gym proposals, plan runs). Summaries reference the originals (rationale:feed pattern). One calm rollup per tick, drill-down on demand. Filter by harness or user-requested work.',
  capability: 'curation:read',
  guidance: {
    when: 'You want to see recent changes across the fleet (what work finished, what proposals landed) without a replicated log. Pass userRequestedOnly to see only user-facing changes; harness to scope to one project.',
    notWhen:
      'For the raw fleet signals use curation:feed. For historical audit of all changes use the underlying work-items / coord-event-log directly.',
    seeAlso: [
      'curation:feed (the raw fleet signals)',
      'curation:state-of-pot (the cross-corpus ideation rollup)',
      'work_items:set_priority (steer the backlog after reading the feed)',
    ],
  },
  requirePrincipal: false,
  args: z.object({
    /** Filter to one harness (omit for fleet-wide). */
    harness: z.string().max(256).optional(),
    /** Only user-requested changes (vs fleet-internal). */
    userRequestedOnly: z.boolean().optional(),
    /** Max entries returned (default 100, max 300). */
    limit: z.number().int().positive().max(MAX_LIMIT).optional(),
  }),
  async handler(args) {
    const readers = buildChangeFeedReaders();
    const entries = await gatherCompletions(readers);

    // Filter by harness if requested.
    let filtered = entries;
    if (args.harness) {
      filtered = entries.filter((e) => e.harness === args.harness);
    }

    const rows = rankChangeFeed(filtered, {
      limit: args.limit ?? DEFAULT_LIMIT,
      userRequestedOnly: args.userRequestedOnly,
    }).map(toRow);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            count: rows.length,
            rows,
            harness: args.harness || 'fleet-wide',
            userRequestedOnly: args.userRequestedOnly ?? false,
          }),
        },
      ],
    };
  },
});
