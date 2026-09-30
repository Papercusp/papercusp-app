/**
 * fleet:delivery — set YOUR delivery tier for a named fleet's broadcasts
 * (fleet-delivery-override-mute-digest-2026-06-30 D-001).
 *
 * Fleet membership is DERIVED (you join a fleet, you're auto-subscribed to its
 * @fleet:<slug> broadcasts). This is the OPTIONAL per-member override: turn the
 * cohort's live noise down WITHOUT leaving the fleet.
 *
 *   full    — every broadcast, live in your inbox (the default; clears any override)
 *   digest  — a terse, coalesced one-liner instead of the full message
 *   muted   — no live delivery at all; the history is still retained, so you read it
 *             on demand with coord:catch-up { audience: '@fleet:<slug>' }
 *
 * You stay a member either way — this only changes how broadcasts reach you, and
 * never your ability to catch up on the fleet's history.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { fleetSlugFromName } from '../../../agent-fleets-store';
import { setFleetDelivery } from '../fleet-delivery';

export default defineTool({
  name: 'fleet:delivery',
  description:
    "Set YOUR delivery for a named fleet's @fleet:<slug> broadcasts: full (default — every message live) | digest (terse coalesced one-liner) | muted (no live delivery; still pullable via coord:catch-up). Turns a noisy cohort down without leaving the fleet — you stay a member and can always catch up on history. 'full' clears any override. Idempotent.",
  guidance: {
    when: 'A fleet you are in is broadcasting more than you need live — set digest (terse) or muted (silent; pull on demand). You remain a member.',
    notWhen: 'To LEAVE a fleet entirely → fleet:leave. To read what you missed → coord:catch-up { audience: "@fleet:<slug>" }.',
    chaining: 'fleet:delivery { fleet, mode:"muted" } → later coord:catch-up { audience:"@fleet:<slug>" } to read the backlog.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    fleet: z.string().min(1).describe('The fleet slug (or human name — it is slugified) whose broadcasts you are tuning.'),
    mode: z.enum(['full', 'digest', 'muted']).describe("full = every broadcast live (clears the override); digest = terse coalesced; muted = no live delivery (history still pullable via coord:catch-up)."),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const fleetSlug = fleetSlugFromName(args.fleet);
    await setFleetDelivery(identity.ownerId, fleetSlug, args.mode);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            fleet: fleetSlug,
            mode: args.mode,
            note:
              args.mode === 'muted'
                ? `Muted @fleet:${fleetSlug} — no live delivery; pull history with coord:catch-up { audience: "@fleet:${fleetSlug}" }.`
                : args.mode === 'digest'
                  ? `@fleet:${fleetSlug} broadcasts will arrive as a terse digest.`
                  : `@fleet:${fleetSlug} delivery reset to full (override cleared).`,
          }),
        },
      ],
    };
  },
});
