/**
 * health:ack — acknowledge/snooze a Health-tab panel
 * (health-tab-v2-2026-07-12 P-004, decision D-A).
 *
 * The ONE deliberate amendment to the Health tab's read-only stance (D-002): an
 * ack is a view-level judgment about ATTENTION — "I know this is warn/crit,
 * stop tinting the overall bar" — not an operational control. A covered panel
 * renders muted and is excluded from `overall`; the ack auto-clears when the
 * panel recovers to ok or the snooze expires, and an ack taken at 'warn' does
 * NOT mute a later 'crit' (escalation re-alarms).
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { PANEL_ORDER } from '../../system-health/types';
import { upsertHealthAck } from '../../system-health/acks';
import { lastSystemHealth, runSystemHealthTick } from '../../system-health/compute';
import { activeWorkspaceId } from '../../workspace-registry';

export default defineTool({
  name: 'health:ack',
  description:
    'Acknowledge/snooze a Health-tab panel: mutes its warn/crit out of the overall light (the card renders muted with your reason) until it RECOVERS to ok or the snooze expires. An ack at warn does NOT cover a later crit — escalation re-alarms. Panels: ' +
    PANEL_ORDER.join(', ') +
    '.',
  guidance: {
    when: 'A panel is warn/crit for a KNOWN, accepted reason (a deliberately paused Mug, a standing backlog being worked elsewhere) and its standing color is drowning fresh signal.',
    notWhen: 'To silence a condition nobody has diagnosed — an ack without a real reason is how reds become wallpaper. Fix or file it instead.',
    chaining: 'health:unack reverses it. The ack auto-clears on recovery, so no cleanup is needed for transient conditions.',
    seeAlso: ['health:unack (remove an ack early)'],
  },
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    panel: z.enum(PANEL_ORDER as unknown as [string, ...string[]]).describe('The panel key to acknowledge.'),
    reason: z.string().min(3).max(500).describe('Why this warn/crit is accepted — rendered on the muted card.'),
    snoozeHours: z
      .number()
      .positive()
      .max(24 * 14)
      .optional()
      .describe('Optional hard expiry in hours; omitted = until the panel recovers to ok.'),
    ackedBy: z.string().max(120).optional().describe("Who is acking (defaults to 'owner' — the tab's user)."),
  }),
  async handler(args) {
    const ws = activeWorkspaceId();
    const current = lastSystemHealth(ws);
    const panel = current?.panels?.[args.panel as keyof typeof current.panels];
    const status = panel?.status === 'crit' ? 'crit' : 'warn';
    if (panel && (panel.status === 'ok' || panel.status === 'unknown')) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, error: 'panel_not_alarming', panel: args.panel, status: panel.status }),
          },
        ],
      };
    }
    await upsertHealthAck({
      workspaceId: ws,
      panel: args.panel,
      status,
      reason: args.reason,
      ackedBy: args.ackedBy ?? 'owner',
      snoozeUntil: args.snoozeHours ? Date.now() + args.snoozeHours * 60 * 60_000 : null,
    });
    // Recompute so the open tab flips immediately (the tick invalidates SSE).
    const health = await runSystemHealthTick(ws).catch(() => null);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            panel: args.panel,
            ackedAtStatus: status,
            overall: health?.overall ?? null,
            ackedCount: health?.ackedCount ?? null,
          }),
        },
      ],
    };
  },
});
