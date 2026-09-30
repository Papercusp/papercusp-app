/**
 * fleet:opus_budget — read/set the fleet opus-budget shed bands (live-configurability-audit P-005).
 *
 * The shed policy (reserveStart/reserveHard/nearCap/staleMs) is the only incident lever for opus
 * shedding, but was a hardcoded DEFAULT_OPUS_BUDGET_POLICY never populated at runtime. This makes it
 * settable, threaded into evaluateOpusBudgetForSpawn + summarizeOpusBudget. Monotonicity
 * (reserveStart < reserveHard < nearCap < 1) is enforced so a bad band can't invert the zones.
 * Audited + one-call-revertible via the control harness.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import { readOpusBudgetPolicy, writeOpusBudgetPolicy } from '../../opus-budget-policy';
import type { OpusBudgetPolicy } from '../../opus-budget-governor';

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

export default defineTool({
  name: 'fleet:opus_budget',
  profile: 'engineer',
  description:
    'Read or set the fleet opus-budget shed bands: reserveStart (shed background opus→sonnet), reserveHard (also shed normal), nearCap (pace critical), staleMs. Default 0.75/0.88/0.95. The only incident lever for opus shedding; set is audited + one-call-revertible, with monotonicity (reserveStart < reserveHard < nearCap < 1) enforced.',
  capability: 'operator:write',
  guidance: {
    when: 'During an opus capacity crunch, shed earlier (lower reserveStart) to reserve more 5h headroom, or relax the bands when budget is fine — live, no redeploy.',
    notWhen: 'To change WHICH roles count as critical/background (those role lists are still code consts — a tracked follow-up). To READ live pacing/zone state, use dev:rate_governor_status.',
    chaining: 'dev:rate_governor_status shows the live opusBudget zone take effect; config:list-overrides shows the active override.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('set'),
      reserveStart: z.number().gt(0).lt(1).optional(),
      reserveHard: z.number().gt(0).lt(1).optional(),
      nearCap: z.number().gt(0).lt(1).optional(),
      staleMs: z.number().int().positive().max(86_400_000).optional(),
      dryRun: z.boolean().optional(),
    }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') return json({ policy: await readOpusBudgetPolicy() });

    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('fleet:opus_budget set requires operator, architect, or mug role');
    }
    const patch: Partial<OpusBudgetPolicy> = {};
    if (args.reserveStart !== undefined) patch.reserveStart = args.reserveStart;
    if (args.reserveHard !== undefined) patch.reserveHard = args.reserveHard;
    if (args.nearCap !== undefined) patch.nearCap = args.nearCap;
    if (args.staleMs !== undefined) patch.staleMs = args.staleMs;
    if (Object.keys(patch).length === 0) {
      throw new Error('set requires at least one of reserveStart / reserveHard / nearCap / staleMs');
    }
    // Validate the RESULTING (merged) policy's monotonicity — a partial patch must not invert zones.
    const current = await readOpusBudgetPolicy();
    const next = { ...current, ...patch };
    if (!(next.reserveStart < next.reserveHard && next.reserveHard < next.nearCap && next.nearCap < 1)) {
      throw new Error(
        `monotonicity violated — require reserveStart < reserveHard < nearCap < 1 (got ${next.reserveStart} / ${next.reserveHard} / ${next.nearCap})`,
      );
    }

    const outcome = await runControlMutation<OpusBudgetPolicy>(
      {
        action: 'fleet:opus_budget',
        subject: 'opus-budget',
        actor: `role:${ctx.role}`,
        capturePrev: () => readOpusBudgetPolicy(),
        apply: () => writeOpusBudgetPolicy(patch),
        revertTo: (prev) => writeOpusBudgetPolicy(prev).then(() => {}),
        verify: async (n) => {
          const ok = (Object.keys(patch) as (keyof OpusBudgetPolicy)[]).every((k) => n[k] === patch[k]);
          return { ok, detail: ok ? undefined : 'policy did not persist' };
        },
        describe: (prev) => ({ current: prev, proposed: next }),
      },
      { dryRun: args.dryRun },
    );
    return json({
      ok: true, dryRun: outcome.dryRun, applied: outcome.applied, reverted: outcome.reverted,
      preview: outcome.preview, verify: outcome.verify, auditId: outcome.auditId, prev: outcome.prev, next: outcome.next,
    });
  },
});
