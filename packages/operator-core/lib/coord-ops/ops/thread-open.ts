/**
 * `coord:thread-open` — open a coordination thread (D-004, wraps the shipped
 * conversations / Threadable surface). The first step of a vote/deliberate
 * program: it creates the discussion thread the voters post into and the
 * `collect` op reads. Binds `{ thread_id, conversation_id }` into the spine scope.
 */
import { z } from 'zod';
import type { CoordOp } from '../types.js';
import { registerCoordOp } from '../registry.js';

const args = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  kind: z.enum(['question', 'discussion']).default('discussion'),
  topics: z.array(z.string()).optional(),
  harness: z.string().optional(),
});

const result = z.object({
  thread_id: z.string(),
  conversation_id: z.string(),
});

export const threadOpenOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'coord:thread-open',
  description: 'Open a coordination thread (a conversation) — the timeline voters post into.',
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    const r = await ctx.caps.openThread({
      title: a.title,
      body: a.body ?? a.title ?? 'Coordination thread',
      kind: a.kind,
      producer: 'coord:thread-open',
      topics: a.topics,
      harness: a.harness ?? ctx.harnessSlug,
    });
    return { thread_id: r.thread_id, conversation_id: r.conversation_id };
  },
};

registerCoordOp(threadOpenOp);
