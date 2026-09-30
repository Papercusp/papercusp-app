/** coord:focus-window — bring an existing live managed-agent window forward. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { focusSessionWindow } from '../../../adv-session-focus';
import { getLatestActiveAdvSessionByOwner } from '../../../adv-sessions';
import { COORD_ROLES } from '../roles';

export default defineTool({
  name: 'coord:focus-window',
  description:
    "Focus, raise, activate, or bring to the foreground an EXISTING live managed agent's desktop terminal window by coordination ownerId. Reuses the same observed-activation backend as the HUD's Focus window button and never resumes, forks, terminates, or duplicates the agent. Returns focused:false with a typed reason when the session is headless, unrecorded, missing its window, or the desktop refuses activation.",
  guidance: {
    when:
      "A human asks to focus, foreground, raise, show, or bring forward a known live agent window. Resolve the exact ownerId with coord:presence/fleet:assignments, then call this verb. This is the primary focus action.",
    notWhen:
      "Use coord:mark-terminal only when activation fails and the human wants a loud title marker for manual discovery. Use capability:launch-agent { restoreVisible:true } only when the desktop-window oracle positively says the viewer is dead; it correctly refuses an alive window. Never force-resume or fork a live host as a focus workaround.",
    returns:
      "{ ok, ownerId, focused, advSessionId, windowId, code?, reason? }. focused:true means the shared desktop backend observed the target as active. focused:false is honest and typed: no_active_session, no_window, or focus_failed.",
  },
  // Same human-visible desktop-control envelope as coord:mark-terminal. This is
  // intentionally not general coord:write: focusing a window is a local human
  // affordance, not a datastore coordination mutation.
  capability: 'coord:mark-terminal',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    ownerId: z
      .string()
      .min(1)
      .describe('Exact coordination ownerId from coord:presence or fleet:assignments.'),
  }),
  result: z
    .object({
      ok: z.boolean(),
      ownerId: z.string(),
      focused: z.boolean(),
      advSessionId: z.number().int().positive().nullable(),
      windowId: z.string().nullable(),
      code: z.enum(['no_active_session', 'no_window', 'focus_failed']).optional(),
      reason: z.string().optional(),
    })
    .passthrough(),
  async handler(args) {
    const ownerId = args.ownerId.trim();
    const row = await getLatestActiveAdvSessionByOwner(ownerId);
    if (!row) {
      return {
        data: {
          ok: false,
          ownerId,
          focused: false,
          advSessionId: null,
          windowId: null,
          code: 'no_active_session' as const,
          reason: 'no active recorded desktop session exists for that coordination ownerId',
        },
      };
    }

    const result = await focusSessionWindow({ id: row.id }, row);
    return {
      data: result.focused
        ? {
            ok: true,
            ownerId,
            focused: true,
            advSessionId: row.id,
            windowId: result.windowId,
          }
        : {
            ok: false,
            ownerId,
            focused: false,
            advSessionId: row.id,
            windowId: result.windowId,
            code: result.code,
            reason: result.reason,
          },
    };
  },
});
