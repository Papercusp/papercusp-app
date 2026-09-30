/**
 * sessions:rename — the agent-facing half of the display-name write path
 * (plan hud-session-display-names-2026-08-31, P-007).
 *
 * The HUMAN half is POST /api/adv/sessions/rename, driven by the conversation
 * popup header (D-002). Both call `setAgentDisplayName`, so the encoding
 * contract R6 depends on — blank CLEARS, by DELETing the row — is stated once,
 * in the store, and neither surface can drift from it.
 *
 * They differ in exactly one field, on purpose: the route stamps `set_by:
 * 'owner'`, this stamps the CALLER's coord ownerId, so a surface can tell an
 * owner's name from one an agent gave itself.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  AGENT_DISPLAY_NAME_MAX,
  resolveOwnerWorkspaceId,
  setAgentDisplayName,
} from '../../display-names/store';
import { notifySyncInvalidate } from '../../sync-sse';

export default defineTool({
  name: 'sessions:rename',
  profile: 'engineer',
  description:
    "Name a session, so its HUD card and OS terminal title lead with the name instead of an id or its objective. Omit `name` to clear it and fall back to the objective. Defaults to yourself; pass `agent` to name another session.",
  capability: 'coord:write',
  guidance: {
    when: 'You want a session identifiable at a glance across a busy board — a long-running lane, or one whose objective does not say what it is really for.',
    notWhen: 'To change what a session is DOING (that is coord:declare-intent, and the objective follows it automatically).',
    seeAlso: ['coord:declare-intent', 'coord:glance'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    name: z
      .string()
      .max(400)
      .optional()
      .describe(`the name (trimmed, max ${AGENT_DISPLAY_NAME_MAX} chars kept); omit or pass blank to clear`),
    agent: z.string().max(120).optional().describe('target ownerId (exact, e.g. su-…); omit for yourself'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const ownerId = args.agent?.trim() || identity.ownerId;
    if (!ownerId) {
      return { data: { ok: false, error: 'no target ownerId — pass `agent`, or call from an identified session' } };
    }
    // The TARGET's own presence workspace first: that is the key both readers
    // use, and naming another agent that runs in a different workspace must
    // write where THAT agent's card and title will look, not where the caller
    // happens to live.
    const workspaceId =
      (await resolveOwnerWorkspaceId(ownerId).catch(() => null)) ??
      identity.workspaceId ??
      activeWorkspaceId();
    const result = await setAgentDisplayName({
      workspaceId,
      ownerId,
      name: args.name ?? null,
      setBy: identity.ownerId || 'agent',
    });
    // Same invalidation the route fires — the board must not need a reload.
    void notifySyncInvalidate('roster').catch(() => {});
    return {
      data: {
        ok: true,
        ownerId: result.ownerId,
        workspaceId,
        displayName: result.displayName,
        cleared: result.cleared,
      },
    };
  },
});
