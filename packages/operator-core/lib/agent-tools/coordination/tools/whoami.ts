/**
 * coord:whoami — return the coordination identity the server resolved
 * for the caller. Debug aid: confirm how the coordination layer (L1)
 * sees this agent before relying on lock-ownership / message-sender
 * behaviour.
 *
 * agent-coordination-architecture-v2 §4.3.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, deriveFleetMembership } from '../identity';
import { COORD_ROLES } from '../roles';
import { inboxWakeKey } from '../inbox-wake';

export default defineTool({
  name: 'coord:whoami',
  description:
    "Show this agent's identity. Includes ownerId (the stable per-agent id), ownerLabel, source, workspaceId, userId, named-fleet membership (fleetSlug/fleetRole, live presence with launch-env fallback on read failure), and inbox_wake_key (the key coord:send {wake:true} fires + the one coord:await-inbox watches). Debug aid for how the coordination layer sees this agent.",
  guidance: {
    when: 'Debugging identity — "what ownerId am I?" before relying on lock or message behaviour.',
    notWhen: 'Routine work — identity is resolved automatically by every coord:* and locks:* call.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  // EI-20226779878046151: identity resolution is self-contained and does not
  // read ctx.tx; avoid an ambient org-app transaction for this orient leg.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.object({}),
  async handler(_args, ctx) {
    // EI-1748: whoami is the IDENTITY-INTROSPECTION tool — when the server can't
    // resolve an identity (e.g. a superuser/HTTP-bridge request with no ?client=),
    // returning the reason + the fix is far more useful than throwing a structural
    // error. Degrade gracefully into a readable payload instead of a 500-class throw.
    let identity;
    try {
      identity = resolveAgentIdentity(ctx);
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              resolved: false,
              error: err instanceof Error ? err.message : String(err),
              hint:
                'No coordination identity resolved. Calling the superuser MCP endpoint ' +
                'directly (curl/HTTP bridge)? Add ?client=<your-su-id> to the request URL ' +
                '(and workspace=<id> for scoped reads).',
              isSuperuser: ctx.isSuperuser ?? false,
              workspaceId: ctx.workspaceId ?? null,
            }),
          },
        ],
      };
    }
    // Named-fleet membership (P-005/P-015): current presence is authoritative because
    // fleet:join / fleet:take-leadership can change membership without rewriting this
    // process's launch environment. Keep the launch env as a failure-only fallback so
    // identity introspection remains useful during a transient coordination read outage.
    const launchFleet = deriveFleetMembership();
    let fleet = launchFleet;
    try {
      // Keep the PG-backed presence join out of this module's static dependency graph;
      // whoami is an identity read and must remain loadable when the DB layer is absent.
      const { resolvePresenceFleet } = await import('../presence-fleet');
      fleet = await resolvePresenceFleet(identity.ownerId, launchFleet);
    } catch {
      // Preserve the fail-soft identity response and its launch-time fallback.
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ...identity,
            fleetSlug: fleet.fleetSlug,
            fleetRole: fleet.fleetRole,
            inbox_wake_key: inboxWakeKey(identity.ownerId),
          }),
        },
      ],
    };
  },
});
