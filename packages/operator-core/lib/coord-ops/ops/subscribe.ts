/**
 * `coord:subscribe` — subscribe an owner to a topic/object so its updates inject
 * (D-004, wraps the shipped subscribe→inject substrate). Used to subscribe the
 * caller to the decision thread so the resolution comes back to them.
 */
import { z } from 'zod';
import type { CoordOp } from '../types.js';
import { registerCoordOp } from '../registry.js';

const args = z.object({
  target_kind: z.enum(['topic', 'object']),
  target_ref: z.string().min(1),
  mode: z.enum(['full', 'digest', 'mention']).default('full'),
});

const result = z.object({ ok: z.literal(true) });

export const subscribeOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'coord:subscribe',
  description: 'Subscribe to a topic/object so its updates inject (subscribe→inject substrate).',
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    await ctx.caps.subscribe({ target_kind: a.target_kind, target_ref: a.target_ref, mode: a.mode });
    return { ok: true };
  },
};

registerCoordOp(subscribeOp);
