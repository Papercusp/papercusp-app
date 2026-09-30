/**
 * autonomy:policy_set — set the Queen autonomy ceiling / lock / graduated level
 * for one category (queen-autonomy-policy-2026-06-13 B-03 / P-022).
 *
 * High-tier: changes what the Queen may auto-decide WITHOUT asking the owner.
 * Audited via harness_shared.audit_log; a reason is required. Invariants are
 * enforced in the store (valid category + levels; graduated clamped ≤ ceiling).
 * After the write, fires notifySyncInvalidate('autonomy.policy') so the settings
 * surface refreshes.
 *
 * This does NOT arm autonomy on its own: categories ship never-auto (D-007) and
 * widen only when the owner lowers a ceiling AND the P-092 arming gate passes.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { AUTONOMY_CEILINGS } from '@papercusp/plan-parser';

export default defineTool({
  name: 'autonomy:policy_set',
  profile: 'engineer',
  // Writes the workspace-scoped policy row + the audit row via the admin handle,
  // scoping itself by the resolved workspace id.
  crossWorkspace: true,
  description:
    'Set the autonomy ceiling / lock / graduated level for one category. High-risk: widens or narrows what the deciding agent may auto-decide without asking. Audited; provide a reason.',
  capability: 'audit:write',
  guidance: {
    when: "The owner (or the owner control surface) deliberately changes a category's autonomy — lower/raise the risk ceiling, lock/unlock (protected = never-auto), or the graduation engine records an earned level (clamped ≤ the ceiling).",
    notWhen:
      'To read the policy use autonomy:policy_get. This does not arm autonomy — categories ship never-auto and widen only after the owner lowers a ceiling AND the arming gate (P-092).',
    seeAlso: [
      'autonomy:policy_get (read the policy first)',
      'autonomy:graduation_status (graduation standings the ceiling gates)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator'],
  args: z.object({
    category: z.string().describe('One of the 13 canonical autonomy category ids.'),
    ceiling: z
      .enum(AUTONOMY_CEILINGS as unknown as [string, ...string[]])
      .optional()
      .describe('Owner-set risk ceiling. `never-auto` = nothing auto-runs.'),
    locked: z.boolean().optional().describe('Never-auto regardless of ceiling (protected).'),
    graduatedLevel: z
      .enum(AUTONOMY_CEILINGS as unknown as [string, ...string[]])
      .optional()
      .describe('Graduation engine earned level; clamped to ≤ ceiling.'),
    thresholdOverrides: z.record(z.string(), z.unknown()).optional(),
    ownerOverride: z.record(z.string(), z.unknown()).nullable().optional(),
    reason: z.string().min(8, 'Provide a short reason (>=8 chars) for the audit log.'),
  }),
  async handler(args, ctx) {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const { setAutonomyPolicy } = await import('../../autonomy/policy-store');
    const { effectiveCeiling } = await import('../../autonomy/policy');

    const principalWs = ctx?.principal?.workspaceId;
    const ws = principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId();
    const actor = ctx?.principal?.slug ?? 'agent';
    const { sql } = getOrgPg();

    try {
      const policy = await setAutonomyPolicy(
        sql,
        ws,
        {
          category: args.category,
          ceiling: args.ceiling,
          locked: args.locked,
          graduatedLevel: args.graduatedLevel,
          thresholdOverrides: args.thresholdOverrides,
          ownerOverride: args.ownerOverride,
          reason: args.reason,
        },
        actor,
      );
      const { notifySyncInvalidate } = await import('../../sync-sse');
      // Name-only (no args): the settings page subscribes to autonomy.policy with
      // no args, so an args-scoped invalidate never matches its react-query key and
      // the surface wouldn't refetch. See the autonomy-policy-set route for the full
      // note. Matches this file's own doc-comment ("fires notifySyncInvalidate('autonomy.policy')").
      await notifySyncInvalidate('autonomy.policy').catch(() => {});
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: true,
                workspaceId: ws,
                policy: { ...policy, effectiveCeiling: effectiveCeiling(policy) },
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { ok: false, reason: (err as Error)?.message ?? 'set_failed', category: args.category },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
  },
});
