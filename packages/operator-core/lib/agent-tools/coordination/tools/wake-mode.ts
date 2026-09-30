/**
 * coord:wake-mode — read or set an agent's wake mode (the pause/edit gate's
 * control surface, hive-agent-tabs-psu-tui-2026-06-09 P-008 / D-005).
 *
 *   auto   — wakes fire immediately (the injected prompt lands as a normal turn).
 *   manual — wakes are STAGED (the agent is not re-invoked); the owner releases /
 *            edits / skips them via coord:wake-queue.
 *
 * Omit `mode` to read; omit `agent` to read/set the GLOBAL default. The behavior
 * itself (stage-vs-fire) is enforced in wakeRecipients (P-007), gated on
 * POT_AGENT_TABS — this tool only reads/writes the per-agent preference, which is
 * inert until that gate is on, so it needs no separate flag check.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../roles';
import {
  resolveWakeMode,
  setWakeMode,
  getDefaultWakeMode,
  setDefaultWakeMode,
} from '../wake-mode';

export default defineTool({
  name: 'coord:wake-mode',
  description:
    "Read or set an agent's wake mode — auto (wakes fire immediately) or manual (wakes are staged for the owner to release/edit/skip). Omit `mode` to read; omit `agent` to read/set the global default. Pass an optional bounded `reason` with a mode change to retain its rationale in the audit trail. The pause/edit gate (hive-agent-tabs D-005).",
  guidance: {
    when: 'Switching an agent (or the default) between auto and manual wake delivery — e.g. pausing a cup\'s auto-injected turns to review them first, or switching back. Include `reason` when the control action needs a durable rationale.',
    notWhen: "Reading who's online or what an agent is doing — that's coord:presence / fleet:assignments. Reviewing the staged wakes themselves — that's coord:wake-queue.",
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    agent: z
      .string()
      .optional()
      .describe('The agent owner id; omit to target the GLOBAL default mode.'),
    mode: z
      .enum(['auto', 'manual'])
      .optional()
      .describe('auto | manual. Omit to just READ the current mode.'),
    reason: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe('Optional bounded rationale for a mode change; retained with the setting and audit record.'),
  }),
  async handler(args) {
    if (args.mode) {
      if (args.agent) await setWakeMode(args.agent, args.mode, args.reason);
      else await setDefaultWakeMode(args.mode, args.reason);
    }
    const current = args.agent ? await resolveWakeMode(args.agent) : await getDefaultWakeMode();
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            agent: args.agent ?? null,
            mode: current,
            default: await getDefaultWakeMode(),
          }),
        },
      ],
    };
  },
});
