/**
 * `resolve` (D-006 gate terminal) — the decisive branch of a vote/deliberate
 * gate. Records the decision and (best-effort) injects the caller so the answer
 * comes back to whoever invoked the program. The durable workflow reads a
 * `resolve` outcome as "the program resolved decisively"; `decision` is the bound
 * value the caller receives. This is the op that shrinks the needs-human pile —
 * a decisive vote resolves here instead of escalating.
 */
import { z } from 'zod';
import type { CoordOp } from '../types.js';
import { registerCoordOp } from '../registry.js';

const args = z.object({
  decision: z.unknown(),
  summary: z.string().optional(),
  /** Notify the program's caller with the decision (default true). */
  notify_caller: z.boolean().default(true),
});

const result = z.object({
  resolved: z.literal(true),
  decision: z.unknown(),
});

export const resolveOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'resolve',
  description: 'Resolve a decision program decisively with the chosen decision (the gate success branch).',
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    if (a.notify_caller && ctx.callerId) {
      const summary = a.summary ?? `Decision resolved: ${JSON.stringify(a.decision)}`;
      await ctx.caps
        .notify({ to: [ctx.callerId], summary, body: a.summary })
        .catch(() => {
          /* best-effort — a notify failure never fails an already-decisive resolution */
        });
    }
    return { resolved: true, decision: a.decision };
  },
};

registerCoordOp(resolveOp);
