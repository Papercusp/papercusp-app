/**
 * fleet:resume — lift a fleet's wind-down: TYPED control state back to active
 * (coord-authority-hardening-2026-07-11 P-009 / H4). The inverse of
 * fleet:wind-down / fleet:pause; shared engine in ./control-core.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { applyFleetControl } from './control-core';
import { json, ROUTING_LADDER } from './_shared';

export default defineTool({
  name: 'fleet:resume',
  description:
    'RESUME a wound-down fleet — flips the registry control_state back to active (+ reason/by/ts) and sends live members a typed fleet-scoped control cue to pick their lanes back up. Invokers: the owner (su session), THAT fleet\'s leader, or the queen. The inverse of fleet:wind-down / fleet:pause.',
  guidance: {
    when: 'Lifting a stand-down: the risky change landed, the incident cleared, the mission is back on.',
    notWhen: 'The fleet was never wound down — a no-op resume just refreshes reason/by/ts (reported alreadyInState).',
    chaining: ROUTING_LADDER,
    seeAlso: ['fleet:wind-down (the stand-down)', 'fleet:status (shows controlState)'],
  },
  capability: 'fleet:resume',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    fleet: z.string().min(1).max(120).describe('Fleet slug (or name — slugified like every registry surface).'),
    reason: z
      .string()
      .max(500)
      .optional()
      .describe('Why the fleet is resuming — travels on the registry row + the member cue.'),
  }),
  async handler(args, ctx) {
    const result = await applyFleetControl(ctx, args.fleet, 'resume', args.reason);
    return json(result as unknown as Record<string, unknown>, !result.ok);
  },
});
