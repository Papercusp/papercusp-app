/**
 * `coord:thread-post` — post to a coordination thread (D-004, wraps
 * conversations.postReply / answerQuestion). The op a spawned voter calls
 * (directly, as a tool) to cast its structured vote; also usable as a spine step.
 */
import { z } from 'zod';
import type { CoordOp } from '../types.js';
import { registerCoordOp } from '../registry.js';

const args = z.object({
  conversation_id: z.string().min(1),
  body: z.string().min(1),
  is_answer: z.boolean().default(false),
});

const result = z.object({ post_id: z.number() });

export const threadPostOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'coord:thread-post',
  description: [
    'Post a message (e.g. a structured vote) to a coordination conversation by conversation_id.',
    'For work-item threads, use work_items:comment { id, body }; work-item-thread-* values are not conversation IDs.',
  ].join(' '),
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    if (a.conversation_id.startsWith('work-item-thread-')) {
      throw new Error(
        [
          'This is a work-item thread key, not a coordination conversation ID.',
          'Use work_items:comment { id: <work-item-id>, body: <comment> } for work-item threads.',
        ].join(' '),
      );
    }
    const r = await ctx.caps.postThread({
      conversation_id: a.conversation_id,
      body: a.body,
      isAnswer: a.is_answer,
    });
    return { post_id: r.post_id };
  },
};

registerCoordOp(threadPostOp);
