/**
 * autonomy:graduation_status — per-(category, class) trust-graduation standings
 * (queen-autonomy-policy-2026-06-13 B-16 / P-082; backs the settings
 * "graduation-eligible reports" surface, P-032).
 *
 * Recounts the tripwire ledger into trailing clean-pass streaks per (category,
 * class), and reports each category's earned `graduated_level` target vs its
 * current level + ceiling. Read-only — it does NOT write graduated_level (the
 * autonomy-trust-scan routine does) and NEVER raises a ceiling (owner authority).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  name: 'autonomy:graduation_status',
  profile: 'engineer',
  crossWorkspace: true,
  description:
    'Read the trust-graduation standings: per-(category, class) clean-auto-pass streaks from the tripwire ledger, each category\'s earned graduated_level vs its current level + ceiling, and which classes are graduation-eligible (an owner ratification ask to raise a ceiling). Read-only.',
  capability: 'intel:read',
  guidance: {
    when: 'Rendering the owner graduation surface, or checking how close a category is to earning more autonomy. Pairs with autonomy:policy_get (ceilings) + autonomy:tripwire_list (the underlying passes).',
    notWhen:
      'To raise a ceiling use autonomy:policy_set (owner authority). The graduated_level itself is written by the autonomy-trust-scan routine, not here.',
    seeAlso: [
      'autonomy:policy_set (raise a ceiling — owner authority)',
      'autonomy:policy_get (read the current policy)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    lookbackDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Evidence lookback window (default 90).'),
  }),
  async handler(args, ctx) {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const { readTripwireEvidence } = await import('../../autonomy/tripwire/store');
    const { readAutonomyPolicy } = await import('../../autonomy/policy-store');
    const { effectiveCeiling } = await import('../../autonomy/policy');
    const {
      computeAutonomyStandings,
      computeCategoryGraduationTargets,
      DEFAULT_AUTONOMY_GRADUATION_POLICY,
      parseGradKey,
    } = await import('../../autonomy/tripwire/graduation');

    const principalWs = ctx?.principal?.workspaceId;
    const ws = principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId();
    const { sql } = getOrgPg();

    const nowMs = Date.now();
    const lookbackDays = args.lookbackDays ?? 90;
    const rows = await readTripwireEvidence(sql, ws, { lookbackDays, nowMs });
    const standings = computeAutonomyStandings(rows, DEFAULT_AUTONOMY_GRADUATION_POLICY, nowMs);

    const policies = await readAutonomyPolicy(sql, ws);
    const policyMap = new Map(policies.map((p) => [p.category, p]));
    const targets = computeCategoryGraduationTargets(standings, policyMap, DEFAULT_AUTONOMY_GRADUATION_POLICY);

    const standingsOut = standings.map((s) => {
      const { category, findingClass } = parseGradKey(s.findingClass);
      return {
        category,
        findingClass,
        cleanStreak: s.cleanStreak,
        totalClean: s.totalClean,
        totalRecurred: s.totalRecurred,
        totalDirty: s.totalDirty,
        pendingWindow: s.pendingWindow,
        eligible: s.eligible,
        eligibleTier: s.eligibleTier,
      };
    });
    const ceilings = policies.map((p) => ({
      category: p.category,
      ceiling: p.ceiling,
      graduatedLevel: p.graduatedLevel,
      locked: p.locked,
      effectiveCeiling: effectiveCeiling(p),
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { ok: true, workspaceId: ws, lookbackDays, standings: standingsOut, targets, ceilings },
            null,
            2,
          ),
        },
      ],
    };
  },
});
