/**
 * improvements:set-auto-policy — read/set the auto-implement risk policy + dispatch limits
 * (live-configurability-audit-2026-06-20 P-011).
 *
 * Provides the config surface CLAUDE.md asked for ("Phase-4 graduation is a CONFIG change, not a code
 * change"): autoKinds (bug→change→feature graduation), maxPerRun/maxAttempts (dispatch ceilings,
 * migrated off PAPERCUSP_IMPROVEMENT_* env gates), and TIGHTEN-ONLY protected-path/keyword ADDITIONS
 * (D-002 — the baked TCB floor is unioned + never removable; there is deliberately no remove op).
 *
 * Inert until FLAGS.IMPROVEMENT_AUTO_IMPLEMENT is armed; operator-gated + audited + one-call-revertible.
 * The release-manager at deploy (D-005) remains the real guarantee on any actual change.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { runControlMutation } from '../../gateway-control/control-harness';
import {
  readAutoImplementPolicy,
  readStoredAutoImplementPolicy,
  writeAutoImplementPolicy,
  setStoredAutoImplementPolicy,
  type StoredAutoImplementPolicy,
} from '../../auto-implement-policy';
import { DEFAULT_RISK_TIER_POLICY } from '../../harness/improvements/policy';

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

const WORK_ITEM_KINDS = ['feature', 'bug', 'change'] as const;

export default defineTool({
  name: 'improvements:set-auto-policy',
  profile: 'engineer',
  description:
    "Read or set the auto-implement risk policy: autoKinds (the bug→change→feature graduation dial), maxPerRun / maxAttempts (dispatch ceilings), and TIGHTEN-ONLY protected-path/keyword additions (the baked TCB floor is unioned + never removable — no remove op by design, D-002). Inert until the IMPROVEMENT_AUTO_IMPLEMENT flag is armed; audited + one-call-revertible.",
  capability: 'operator:write',
  guidance: {
    when: 'Graduate the auto-implement lane (widen autoKinds as trust is earned), tune the dispatch rate (maxPerRun/maxAttempts), or ADD a path/keyword to the never-auto protected set — live, no redeploy.',
    notWhen: "To REMOVE a baked protection (impossible by design — D-002 tighten-only). To arm auto-implement itself, flip FLAGS.IMPROVEMENT_AUTO_IMPLEMENT via /admin/features (this only configures the policy). To triage the queue, use improvements:digest.",
    chaining: 'improvements:digest shows the auto/human partition under the current policy; config:list-overrides shows the active override; config:reset-overrides reverts it.',
    seeAlso: [
      'improvements:digest (see the auto/human partition under the policy)',
      'config:list-overrides (the active override this wrote)',
      'config:reset-overrides (revert the policy override)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('set'),
      autoKinds: z.array(z.enum(WORK_ITEM_KINDS)).max(8).optional().describe('REPLACE the auto-eligible kinds (the graduation dial). [] = everything human-gated.'),
      addProtectedPaths: z.array(z.string().min(1).max(300)).max(50).optional().describe('APPEND glob patterns to the never-auto protected set (tighten-only).'),
      addProtectedKeywords: z.array(z.string().min(1).max(120)).max(50).optional().describe('APPEND keywords to the never-auto protected set (tighten-only).'),
      maxPerRun: z.number().int().min(0).max(1000).optional(),
      maxAttempts: z.number().int().min(0).max(100).optional(),
      dryRun: z.boolean().optional(),
    }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      const [eff, stored, flagEnabled] = await Promise.all([
        readAutoImplementPolicy(),
        readStoredAutoImplementPolicy(),
        getFlag(FLAGS.IMPROVEMENT_AUTO_IMPLEMENT, 'system').catch(() => false),
      ]);
      return json({
        autoImplementFlagEnabled: flagEnabled,
        autoKinds: eff.riskTier.autoKinds,
        maxPerRun: eff.maxPerRun ?? null,
        maxAttempts: eff.maxAttempts ?? null,
        bakedProtectedPathCount: DEFAULT_RISK_TIER_POLICY.protectedPathPatterns.length,
        protectedPathAdditions: stored.protectedPathAdditions ?? [],
        bakedProtectedKeywordCount: DEFAULT_RISK_TIER_POLICY.protectedKeywords.length,
        protectedKeywordAdditions: stored.protectedKeywordAdditions ?? [],
      });
    }

    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('improvements:set-auto-policy set requires operator, architect, or mug role');
    }
    const patch = {
      ...(args.autoKinds !== undefined ? { autoKinds: args.autoKinds } : {}),
      ...(args.addProtectedPaths?.length ? { addProtectedPaths: args.addProtectedPaths } : {}),
      ...(args.addProtectedKeywords?.length ? { addProtectedKeywords: args.addProtectedKeywords } : {}),
      ...(args.maxPerRun !== undefined ? { maxPerRun: args.maxPerRun } : {}),
      ...(args.maxAttempts !== undefined ? { maxAttempts: args.maxAttempts } : {}),
    };
    if (Object.keys(patch).length === 0) {
      throw new Error('set requires at least one of autoKinds / addProtectedPaths / addProtectedKeywords / maxPerRun / maxAttempts');
    }

    const outcome = await runControlMutation<StoredAutoImplementPolicy>(
      {
        action: 'improvements:set-auto-policy',
        subject: 'auto-implement-policy',
        actor: `role:${ctx.role}`,
        capturePrev: () => readStoredAutoImplementPolicy(),
        apply: () => writeAutoImplementPolicy(patch),
        revertTo: (prev) => setStoredAutoImplementPolicy(prev),
        verify: async (next) => {
          const ok =
            (args.autoKinds === undefined || (next.autoKinds ?? []).join(',') === args.autoKinds.join(',')) &&
            (args.maxPerRun === undefined || next.maxPerRun === args.maxPerRun) &&
            (args.maxAttempts === undefined || next.maxAttempts === args.maxAttempts);
          return { ok, detail: ok ? undefined : 'policy did not persist' };
        },
        describe: (prev) => ({ prevStored: prev, patch }),
      },
      { dryRun: args.dryRun },
    );
    return json({
      ok: true, dryRun: outcome.dryRun, applied: outcome.applied, reverted: outcome.reverted,
      preview: outcome.preview, verify: outcome.verify, auditId: outcome.auditId, next: outcome.next,
    });
  },
});
