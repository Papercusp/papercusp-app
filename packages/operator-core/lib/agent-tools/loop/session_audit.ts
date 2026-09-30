import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePotHomeSlug } from '../../pot/wake';
import { readSessionAuditDigest } from '../../pot/session-audit';

export default defineTool({
  name: 'loop:session-audit',
  profile: 'engineer',
  description:
    'Read a structured session-audit digest for one pot over a recent window: compaction reconciliation (session:request-compaction calls vs. every REAL compaction — requested or Claude native auto-compact — detected by scanning session transcripts for the compaction-boundary marker), clustered runs of the same tool failing repeatedly for one session, green-checkpoint/deploy gate transitions, and failure signatures recurring across DIFFERENT sessions (systemic friction). Answers "why" without grepping raw session JSONL by hand.',
  guidance: {
    when: 'You need to understand WHY context-burn/compaction numbers look off, or find a stuck retry loop / systemic recurring failure, without manually reading transcripts or tool_invocations.',
    notWhen: 'You just need the current READY/NOT-READY verdict — that is loop:soak-report. This is the deeper investigative digest behind that gate\'s contextBurn numbers.',
    chaining: 'Use after loop:soak-report flags contextBurn or role-success reasons, to see the concrete sessions/clusters/signatures behind the number.',
    seeAlso: ['loop:soak-report (the READY/NOT-READY gate)', 'sessions:search (verbatim transcript recall for one session)'],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().max(120).optional().describe('Pot home harness slug (default: ctx harness or PAPERCUSP_POT_HOME_SLUG).'),
    windowHours: z.number().int().min(1).max(24 * 7).optional().describe('Lookback window in hours (default 24, max 7 days).'),
  }),
  async handler(args, ctx) {
    const potSlug = resolvePotHomeSlug(args.harness, ctx.harnessSlug);
    if (!potSlug) {
      return { data: { ok: false, error: 'no hive home harness resolved' } };
    }
    const digest = await readSessionAuditDigest(potSlug, { windowHours: args.windowHours });
    return { data: { ok: true, digest } };
  },
});
