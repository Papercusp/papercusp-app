/**
 * notifications:recent — list recent toast notifications shown
 * anywhere in the app (errors, warnings, info).
 *
 * Calls listToasts() in lib/toast-log-data.ts directly — same function
 * the GET /api/toast-log route projects. No HTTP roundtrip.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { listToasts } from '../../toast-log-data';

export default defineTool({
  name: 'notifications:recent',
  profile: 'engineer',
  description: 'List recent toast notifications shown in the app (errors, warnings, info, success).',
  capability: 'notifications:read',
  guidance: {
    when: `Read recent toast notifications shown to the user — for "did I miss anything?" / replay.`,
    notWhen: `For PERSISTENT cross-agent messages, use \`coord:inbox\`. Notifications are ephemeral toasts.`,
    seeAlso: [
      'coord:inbox (persistent cross-agent messages)',
      'operator:nudge (send a transient toast)',
    ],
  },
  requirePrincipal: false,
  // + overwatch (overwatch-role-2026-06-15 B-01): the system-health supervisor reads
  // recent notifications/toasts to spot "why did the app just error?" drift.
  agentRoles: [...SU_ROLES, 'kettle'],
  args: z.object({
    level: z.enum(['default', 'info', 'success', 'warning', 'error', 'loading', 'all']).optional(),
    limit: z.number().int().positive().max(500).optional(),
  }),
  async handler(args) {
    const { toasts } = await listToasts({ limit: args.limit });
    const filtered =
      args.level && args.level !== 'all' ? toasts.filter((t) => t.level === args.level) : toasts;
    return {
      content: [
        { type: 'text', text: JSON.stringify({ count: filtered.length, notifications: filtered }) },
      ],
    };
  },
});
