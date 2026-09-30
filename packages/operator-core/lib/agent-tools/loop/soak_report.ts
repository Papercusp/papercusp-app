import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePotHomeSlug } from '../../pot/wake';
import { readPotSoakReport, MAX_SOAK_WINDOW_HOURS, MIN_SOAK_WINDOW_HOURS } from '../../pot/soak-report';

export default defineTool({
  name: 'loop:soak-report',
  profile: 'engineer',
  description:
    'Read the machine-checkable production-readiness gate for one hive over a rolling 12–24h window: bg-host stability, infra-curse rate, agent + Overwatch turn success, escalation backlog, green-checkpoint ratio, deploy latency, and context-burn telemetry (per-wake injected overhead, compactions/session, post-compaction error markers), plus a READY/NOT-READY verdict with reasons.',
  guidance: {
    when: 'You need one deterministic "is this pot production-ready yet?" verdict backed by concrete operational metrics instead of a judgment call.',
    notWhen: 'You only need the next wake / subscriptions / placements summary — that is pot:status. Per-session loop state is loop:status.',
    chaining: 'Use with pot:status for the live wake/placements view, or the Learning tab panel for the same verdict in the UI.',
    seeAlso: [
      'pot:status (current wake / placement state)',
      'loop:status (per-session loop state)',
      'dev:service_health (current bg-host ticker health)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().max(120).optional().describe('Pot home harness slug (default: ctx harness or PAPERCUSP_POT_HOME_SLUG).'),
    windowHours: z.number().int().min(MIN_SOAK_WINDOW_HOURS).max(MAX_SOAK_WINDOW_HOURS).optional(),
  }),
  async handler(args, ctx) {
    const potSlug = resolvePotHomeSlug(args.harness, ctx.harnessSlug);
    if (!potSlug) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'no hive home harness resolved' }) }],
      };
    }
    const report = await readPotSoakReport(potSlug, { windowHours: args.windowHours });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, report }) }],
    };
  },
});
