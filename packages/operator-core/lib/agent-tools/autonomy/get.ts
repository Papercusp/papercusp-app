/**
 * autonomy:policy_get — read the Queen autonomy policy for this workspace
 * (queen-autonomy-policy-2026-06-13 B-03 / P-022).
 *
 * Returns the per-category risk ceilings, locks, graduated levels, and the
 * derived `effectiveCeiling` (min(ceiling, graduated) with lock ⇒ none). With no
 * `category` arg, returns all 13 canonical categories (behavior-neutral defaults
 * for any unseeded row); with `category`, returns just that one.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

import { isAutonomyCategory } from '../../autonomy/categories';

export default defineTool({
  name: 'autonomy:policy_get',
  profile: 'engineer',
  // Reads the workspace-scoped policy via the admin handle, scoping itself by
  // the resolved workspace id — so an unscoped operator/SU session can call it.
  crossWorkspace: true,
  description:
    'Read the autonomy policy (per-category risk ceilings, locks, graduated levels, and the derived effective ceiling) for this workspace.',
  capability: 'intel:read',
  guidance: {
    when: 'Inspecting this workspace\'s per-category autonomy ceilings — the deciding agent checking whether a category may auto-decide, or the owner settings surface rendering the policy. Pass `category` for one row; omit for all 13.',
    notWhen: 'To CHANGE a ceiling use autonomy:policy_set. For feature flags use flags:get.',
    seeAlso: [
      'autonomy:policy_set (change a ceiling — owner authority)',
      'autonomy:graduation_status (current graduated levels vs ceilings)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    category: z
      .string()
      .optional()
      .describe('One of the 13 canonical category ids; omit for the whole policy.'),
  }),
  async handler(args, ctx) {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const { readAutonomyPolicy, getAutonomyCategoryPolicy } = await import(
      '../../autonomy/policy-store'
    );
    const { effectiveCeiling } = await import('../../autonomy/policy');

    const principalWs = ctx?.principal?.workspaceId;
    const ws = principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId();
    const { sql } = getOrgPg();

    if (args.category !== undefined) {
      if (!isAutonomyCategory(args.category)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { ok: false, reason: 'unknown_category', category: args.category },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
      const p = await getAutonomyCategoryPolicy(sql, ws, args.category);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { ok: true, workspaceId: ws, policy: { ...p, effectiveCeiling: effectiveCeiling(p) } },
              null,
              2,
            ),
          },
        ],
      };
    }

    const all = await readAutonomyPolicy(sql, ws);
    const policy = all.map((p) => ({ ...p, effectiveCeiling: effectiveCeiling(p) }));
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, workspaceId: ws, policy }, null, 2) }],
    };
  },
});
