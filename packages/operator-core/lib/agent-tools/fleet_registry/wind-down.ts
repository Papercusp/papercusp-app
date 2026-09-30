/**
 * fleet:wind-down — flip a fleet's TYPED control state to winding-down
 * (coord-authority-hardening-2026-07-11 P-009 / H4). Guard + persist + typed
 * cue live in ./control-core; fleet:pause is an alias, fleet:resume the inverse.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { applyFleetControl } from './control-core';
import { json, ROUTING_LADDER } from './_shared';

export default defineTool({
  name: 'fleet:wind-down',
  description:
    "WIND DOWN a named fleet — a TYPED, BINDING control state (registry control_state=winding-down + reason/by/ts), not a free-text ask: live members get a fleet-scoped control cue (checkpoint → release claims/locks → await the resume gate → loop:end → ack leader; pull no new work), and LATE JOINERS see the state at orient. The park DECLARES a latching resume gate members await instead of stopping wake-less; fleet:resume fires it. Invokers: the owner (su session), THAT fleet's leader, or an Overwatch (system-authority) pane — anyone else is refused (EI-9501 class). Reverse with fleet:resume; fleet:pause is an alias of this.",
  guidance: {
    when: "Standing a fleet down at end-of-mission, before a risky shared-tree change, or on the owner's stand-down order — anywhere 'stop pulling work' must bind members who haven't read chat.",
    notWhen:
      'To stop ONE member — coord:send them a yield / turn:interrupt. To pause a plan — plans:pause. To evict nursery cups — fleet:drain (the cup-fleet surface). A free-text "please pause" stays advisory by definition; this verb is the binding form.',
    chaining: ROUTING_LADDER,
    seeAlso: ['fleet:resume (lift it)', 'fleet:pause (alias of this verb)', 'fleet:status (shows controlState)'],
  },
  capability: 'fleet:wind-down',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  // EI-21834728970912985: the typed registry flip is idempotent and must not
  // wait behind the ambient workspace transaction while optional post-flip
  // saga legs run. This lets the dispatcher surface a committed state flip
  // instead of turning a slow receipt into an unknown mutation outcome.
  idempotent: true,
  skipWorkspaceTx: true,
  args: z.object({
    fleet: z.string().min(1).max(120).describe('Fleet slug (or name — slugified like every registry surface).'),
    reason: z
      .string()
      .max(500)
      .optional()
      .describe('Why the fleet is winding down — travels on the registry row + the member cue.'),
    harness: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe(
        "P-006: harness whose lane to snapshot for the auto-drain stamp (the live scheduler:get_next exclusion breakdown + re-verify command auto-appended to the reason). Omit to use your session harness, else the fleet sentinel spec's own scope.",
      ),
    acknowledgeOpenDirectives: z
      .boolean()
      .optional()
      .describe(
        'EI-11484 guard: open owner directives soft-block wind-down (members loop:end on the cue, removing their wake render surface). Pass true to consciously proceed with them still open.',
      ),
    resumeGate: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "WI-2034563: NAME the latching resume gate this park publishes (auto-scoped to `fleet:<slug>:<name>`). Members await that exact key instead of stopping wake-less, and fleet:resume FIRES it. Omit for the default 'resume' — a park with no key is the defect this exists to remove, so a gate is declared either way unless noResumePath is set.",
      ),
    resumeWithinSec: z
      .number()
      .int()
      .positive()
      .max(30 * 24 * 3600)
      .optional()
      .describe(
        'WI-2034563: bound this park to N seconds. Sets a registry deadline (leader-brief reports the park as OVERDUE past it) and lapses the gate declaration with it, so an abandoned park leaves nothing standing. Omit for an indefinite park — which leader-brief reports as indefinite lost capacity.',
      ),
    noResumePath: z
      .boolean()
      .optional()
      .describe(
        "WI-2034563: this park is TERMINAL — nobody is coming back. Declares no gate and keeps a member's wake-less loop:end authorized. Use for a real end-of-mission shutdown; do NOT use it to skip declaring a gate on a fleet you intend to resume, since that is exactly the shape that stranded ~23 members for hours.",
      ),
  }),
  async handler(args, ctx) {
    // EI-11484 P4: winding down cues every member to loop:end — the same
    // surface-loss moment as a direct loop:end. Warn while open owner
    // directives remain; acknowledgeOpenDirectives:true proceeds. Fail-open.
    const { checkOpenDirectivesGuard } = await import('../orders/open-directives-guard');
    const { resolveAgentIdentity } = await import('../coordination/identity');
    // Soft resolve, like the rest of this fail-open guard: an unattributable
    // caller simply gets the workspace-wide view instead of its own agenda.
    let viewerOwnerId: string | undefined;
    try {
      viewerOwnerId = resolveAgentIdentity(ctx).ownerId;
    } catch {
      viewerOwnerId = undefined;
    }
    const guard = await checkOpenDirectivesGuard({
      workspaceId: (ctx as { workspaceId?: string | null }).workspaceId ?? ctx.principal?.workspaceId,
      acknowledged: args.acknowledgeOpenDirectives,
      action: 'fleet:wind-down',
      viewerOwnerId,
    });
    if (guard) return json(guard as unknown as Record<string, unknown>, true);
    const result = await applyFleetControl(ctx, args.fleet, 'wind-down', args.reason, {
      harness: args.harness,
      resumeGate: args.resumeGate,
      resumeWithinSec: args.resumeWithinSec,
      noResumePath: args.noResumePath,
    });
    return json(result as unknown as Record<string, unknown>, !result.ok);
  },
});
