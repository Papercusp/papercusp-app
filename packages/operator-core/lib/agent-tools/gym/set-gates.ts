/**
 * gym:set-gates — read/set a harness's gym promotion gates (live-configurability-audit P-012).
 *
 * epsilon / delta (accept margins) + costCeiling were an inline placeholder in the gym optimization
 * loop. This makes them per-harness settable, threaded into runOptimizationLoop's `thresholds`.
 * The gym loop is human-gated (autoPromote:false), so these only steer the loop's ADVISORY verdict.
 * Audited + one-call-revertible via the control harness.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import { readGymGates, writeGymGates, type GymGates } from '../../gym-gates';

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

export default defineTool({
  name: 'gym:set-gates',
  profile: 'engineer',
  description:
    "Read or set a harness's gym promotion gates: epsilon / delta (accept margins) + costCeiling (max cost multiple of baseline a champion may promote at). Default 0.1 / 0.5 / 3. The gym loop is human-gated, so these only steer its ADVISORY verdict. set is audited + one-call-revertible.",
  capability: 'operator:write',
  guidance: {
    when: "Tune a harness's gym accept strictness — raise epsilon/delta to demand a bigger measured win before a champion is flagged promotable, or raise costCeiling to tolerate a costlier champion.",
    notWhen: 'To judge a specific proposal use gym:judge. Judge WEIGHTS live in the blueprint gym rubric, not here. To arm the gym loop itself, see the gym autoloop config.',
    chaining: 'config:list-overrides shows active per-harness gate overrides; config:reset-overrides reverts them.',
    seeAlso: [
      'config:list-overrides (active per-harness gate overrides)',
      'config:reset-overrides (revert a gate override)',
      'gym:judge (evaluated against these gates)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get'), harness: z.string().min(1).max(120) }),
    z.object({
      op: z.literal('set'),
      harness: z.string().min(1).max(120),
      epsilon: z.number().min(0).max(1).optional(),
      delta: z.number().min(0).max(1).optional(),
      costCeiling: z.number().gt(0).max(100).optional(),
      dryRun: z.boolean().optional(),
    }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      return json({ harness: args.harness, gates: await readGymGates(args.harness) });
    }

    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('gym:set-gates set requires operator, architect, or mug role');
    }
    const patch: Partial<GymGates> = {};
    if (args.epsilon !== undefined) patch.epsilon = args.epsilon;
    if (args.delta !== undefined) patch.delta = args.delta;
    if (args.costCeiling !== undefined) patch.costCeiling = args.costCeiling;
    if (Object.keys(patch).length === 0) {
      throw new Error('set requires at least one of epsilon / delta / costCeiling');
    }

    const harness = args.harness;
    const outcome = await runControlMutation<GymGates>(
      {
        action: 'gym:set-gates',
        subject: `gym-gates:${harness}`,
        actor: `role:${ctx.role}`,
        capturePrev: () => readGymGates(harness),
        apply: () => writeGymGates(harness, patch),
        revertTo: (prev) => writeGymGates(harness, prev).then(() => {}),
        verify: async (n) => {
          const ok = (Object.keys(patch) as (keyof GymGates)[]).every((k) => n[k] === patch[k]);
          return { ok, detail: ok ? undefined : 'gates did not persist' };
        },
        describe: (prev) => ({ harness, current: prev, proposed: { ...prev, ...patch } }),
      },
      { dryRun: args.dryRun },
    );
    return json({
      ok: true, harness, dryRun: outcome.dryRun, applied: outcome.applied, reverted: outcome.reverted,
      preview: outcome.preview, verify: outcome.verify, auditId: outcome.auditId, prev: outcome.prev, next: outcome.next,
    });
  },
});
