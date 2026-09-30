/**
 * accounts:scale_policy — read/set the account scale-out trigger policy
 * (live-configurability-audit-2026-06-20 P-006).
 *
 * windowMs + sustainedPenaltyThreshold decide when an account is "sustainedly limited" — the verdict
 * that gates the PAID auto-scale-out. The default is a re-probe-aligned 60min / 3 policy. This makes
 * it settable, threaded into the trigger (the onGovernorPause observer), the decision (decideScaleOut),
 * and the read-model. Audited + one-call-revertible via the control harness.
 *
 * Spend note: this only tunes WHEN scale-out fires (lower threshold ⇒ provisions paid machines on a
 * smaller burst). The provisioning itself stays owner-gated (accounts:scale_out).
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import { readScalePolicy, writeScalePolicy } from '../../scale-policy';
import { MIN_SCALE_POLICY_WINDOW_MS, type ScalePolicy } from '../../deployment/account-pool';

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

export default defineTool({
  name: 'accounts:scale_policy',
  profile: 'engineer',
  description:
    `Read or set the account scale-out trigger policy: windowMs (penalty accumulation window, minimum ${Math.round(MIN_SCALE_POLICY_WINDOW_MS / 60_000)}min to cover account re-probes) + sustainedPenaltyThreshold (≥N penalties in the window ⇒ "sustainedly limited", which gates PAID auto-scale-out). Default ${Math.round(MIN_SCALE_POLICY_WINDOW_MS / 60_000)}min / 3. set is audited + one-call-revertible. Tunes WHEN scale-out fires; provisioning stays owner-gated (accounts:scale_out).`,
  capability: 'operator:write',
  guidance: {
    when: 'During a provider rate-limit storm: raise the threshold to avoid over-provisioning paid machines on transient 429 bursts, or lower it to scale out earlier under sustained limiting — live, no redeploy.',
    notWhen: 'To actually provision now, use accounts:scale_out (owner-gated). To pause/exclude an account use the accounts:* session-override tools. EXHAUSTED_UTIL/DRAIN_FULL_UTIL are not covered (structural consts, follow-up).',
    chaining: 'accounts:status shows the per-account sustained-limit state; config:list-overrides shows the active override.',
    seeAlso: [
      'accounts:scale_out (provision now — this only tunes the threshold)',
      'accounts:status (per-account sustained-limit state)',
      'config:list-overrides (the active override this wrote)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('set'),
      windowMs: z.number().int().min(MIN_SCALE_POLICY_WINDOW_MS).max(86_400_000).optional(),
      sustainedPenaltyThreshold: z.number().int().min(1).max(1000).optional(),
      dryRun: z.boolean().optional(),
    }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') return json({ policy: await readScalePolicy() });

    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('accounts:scale_policy set requires operator, architect, or mug role');
    }
    const patch: Partial<ScalePolicy> = {};
    if (args.windowMs !== undefined) patch.windowMs = args.windowMs;
    if (args.sustainedPenaltyThreshold !== undefined) patch.sustainedPenaltyThreshold = args.sustainedPenaltyThreshold;
    if (Object.keys(patch).length === 0) {
      throw new Error('set requires at least one of windowMs / sustainedPenaltyThreshold');
    }

    const outcome = await runControlMutation<ScalePolicy>(
      {
        action: 'accounts:scale_policy',
        subject: 'scale-out',
        actor: `role:${ctx.role}`,
        capturePrev: () => readScalePolicy(),
        apply: () => writeScalePolicy(patch),
        revertTo: (prev) => writeScalePolicy(prev).then(() => {}),
        verify: async (n) => {
          const ok = (Object.keys(patch) as (keyof ScalePolicy)[]).every((k) => n[k] === patch[k]);
          return { ok, detail: ok ? undefined : 'policy did not persist' };
        },
        describe: (prev) => ({ current: prev, proposed: { ...prev, ...patch } }),
      },
      { dryRun: args.dryRun },
    );
    return json({
      ok: true, dryRun: outcome.dryRun, applied: outcome.applied, reverted: outcome.reverted,
      preview: outcome.preview, verify: outcome.verify, auditId: outcome.auditId, prev: outcome.prev, next: outcome.next,
    });
  },
});
