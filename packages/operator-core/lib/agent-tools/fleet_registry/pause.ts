/**
 * fleet:pause — ALIAS of fleet:wind-down (coord-authority-hardening-2026-07-11
 * P-009 / H4, per the plan item: "fleet:pause = alias of wind-down"). Exists so
 * the natural verb an owner reaches for lands on the SAME typed control state
 * instead of degrading to a free-text (advisory-by-definition) ask.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { applyFleetControl } from './control-core';
import { json, ROUTING_LADDER } from './_shared';

export default defineTool({
  name: 'fleet:pause',
  description:
    'PAUSE a named fleet — an ALIAS of fleet:wind-down: the same typed, binding control state (registry control_state=winding-down) + fleet-scoped member cue. Invokers: the owner (su session), THAT fleet\'s leader, or the queen. Lift with fleet:resume.',
  guidance: {
    when: "You'd say 'pause the fleet' — same semantics as fleet:wind-down.",
    notWhen: 'To pause the Mug/pot — pot:pause. To pause one plan — plans:pause.',
    chaining: ROUTING_LADDER,
    seeAlso: ['fleet:wind-down (the canonical verb)', 'fleet:resume (lift it)'],
  },
  capability: 'fleet:pause',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    fleet: z.string().min(1).max(120).describe('Fleet slug (or name — slugified like every registry surface).'),
    reason: z
      .string()
      .max(500)
      .optional()
      .describe('Why the fleet is pausing — travels on the registry row + the member cue.'),
  }),
  async handler(args, ctx) {
    const result = await applyFleetControl(ctx, args.fleet, 'wind-down', args.reason);
    return json({ ...result, alias: 'fleet:wind-down' } as unknown as Record<string, unknown>, !result.ok);
  },
});
