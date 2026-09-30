/**
 * operator:nudge — dedup-arbitrate a spoken voice nudge.
 *
 * Returns `{ fired: true }` when the nudge should be spoken (and
 * persists the timestamp). Returns `{ fired: false }` when the
 * per-kind dedup window is still active. Same logic as the legacy
 * /api/agent-mcp/operator-nudge route.
 *
 * Per-kind windows: budget 30 min, breaker 10 min, pause 5 min.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { maybeFireNudge, type NudgeKind } from '../../voice-nudges';

const ALLOWED_KINDS = ['budget', 'breaker', 'pause'] as const;

export default defineTool({
  name: 'operator:nudge',
  profile: 'engineer',
  description: 'Arbitrate a spoken nudge — returns { fired } indicating whether the per-kind dedup window allows speaking now.',
  capability: 'operator:write',
  guidance: {
    when: `Send a one-shot toast to the user — "checkpoint?", "smoke failed", etc. Use sparingly; chat is the primary channel.`,
    notWhen: `For conversation, just speak in your reply. nudge is for non-conversational status only.`,
    seeAlso: [
      'operator:converse (speak in a normal reply)',
      'notifications:recent (recent transient toasts)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect'],
  rolesQuota: {
    architect: { perRun: 30 },
    operator: { perRun: 100 },
  },
  args: z.object({
    kind: z.enum(ALLOWED_KINDS),
  }),
  async handler(args) {
    const fired = await maybeFireNudge(args.kind as NudgeKind);
    return { data: { fired, kind: args.kind } };
  },
});
