/**
 * `coord:escalate` — open an escalation to the human (D-004, wraps the shipped
 * `coord:escalate` / `openEscalation`). The vote/deliberate gate's split branch
 * fires this: a *curated* escalation (the thread + the split + the advocate's
 * objection) so a genuine escalation arrives pre-deliberated.
 */
import { z } from 'zod';
import type { CoordOp } from '../types.js';
import { registerCoordOp } from '../registry.js';

const args = z.object({
  severity: z.enum(['blocker', 'question', 'advisory']).default('question'),
  summary: z.string().min(1),
  body: z.string().optional(),
  options: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  plan_slug: z.string().optional(),
});

const result = z.object({ msg_id: z.string(), escalated: z.literal(true) });

export const escalateOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'coord:escalate',
  description: 'Escalate a decision to the human (the curated split-vote / unresolved-deliberation branch).',
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    const r = await ctx.caps.escalate({
      severity: a.severity,
      summary: a.summary,
      body: a.body,
      options: a.options,
      plan_slug: a.plan_slug,
    });
    return { msg_id: r.msg_id, escalated: true };
  },
};

registerCoordOp(escalateOp);
