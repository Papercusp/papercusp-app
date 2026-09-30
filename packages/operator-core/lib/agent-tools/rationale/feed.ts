/**
 * rationale:feed — the "why" of a subsystem-topic, projected
 * (docs-and-memory-as-projections-2026-06-05 D-003).
 *
 * Query a topic and get the decisions + work-items + insights relevant to it,
 * indexed — NOT a full search (token cost), NOT an LLM re-summary (token cost). The
 * index is event-maintained, so it's fresh and never drifts. This is the agent-facing
 * read of the rationale projection; pair it with `docs:get` / `plans:get` to drill
 * into the full text of any entry via its `ref`.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { queryTopic } from '../../rationale/service';

export default defineTool({
  name: 'rationale:feed',
  description:
    'The "why" of a subsystem-topic: the decisions, work-items, and insights relevant to it, projected from the plans/work-items/insights — indexed, no full search, never stale. Each entry carries a `ref` to drill into via plans:get / docs:get.',
  guidance: {
    when: 'Before working in a subsystem (e.g. `coordination-substrate`), to load the rationale behind it — why it is the way it is — without searching everything.',
    notWhen:
      'You want the cross-object work-stream / status of an area (topics:feed), the list of topics (topics:list), or messages waiting for you (coord:inbox).',
    chaining: 'topics:list → rationale:feed { topic } → plans:get / docs:get on an entry’s `ref` for the full text.',
    seeAlso: [
      'topics:list (list topics to feed from)',
      'topics:feed (the cross-object work-stream of an area)',
      'rationale:reproject (rebuild the projection)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    topic: z.string().min(1).describe('A topic slug from topics:list.'),
    kinds: z
      .array(z.enum(['decision', 'work_item', 'insight']))
      .optional()
      .describe('Restrict to these entry kinds. Omit for all.'),
    limit: z.number().int().min(1).max(200).optional().describe('Max entries (default 50).'),
    order: z
      .enum(['asc', 'desc'])
      .optional()
      .describe('Order over each entry’s date/sortKey. Default desc (newest first).'),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const rows = await queryTopic(args.topic, {
      ...(args.kinds ? { kinds: args.kinds } : {}),
      limit: args.limit ?? 50,
      order: args.order ?? 'desc',
    });
    const entries = rows.map((r) => r.entry);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, topic: args.topic, count: entries.length, entries }),
        },
      ],
    };
  },
});
