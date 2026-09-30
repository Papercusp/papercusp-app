/**
 * learning:set-scout-budget — read/set/clear the runtime Scout workspace spend-ceiling override
 * (live-configurability-audit-2026-06-20 P-022).
 *
 * The workspace-wide Scout spend ceiling (the P-051 aggregate safety cap consulted by
 * scoutWorkspaceCeilingGate before every cycle) was tunable ONLY via the
 * `PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD` env — a baked env value-gate needing a host restart
 * (P-023). This dial makes it live: a PG override consulted IN FRONT of the env, set without a
 * deploy (e.g. tighten the workspace ceiling mid-incident when armed hives are summing to too much
 * scout spend, or raise it to let a planned exploration burst through). Empty override (default) ⇒
 * env/default fallback ⇒ byte-identical. Audited + one-call-revertible via the control harness.
 *
 * Scope note: regret-mining tunables (minScore / maxSessions / maxReplaysPerTick / replayBudgetUsd)
 * are ALREADY runtime-settable via the regret routine's payload (regretOptionsFromPayload →
 * routines:set), and the per-cycle Scout/regret SPEND budgets are owner-set on the learning governor
 * — so this dial deliberately covers only the workspace-wide ceiling, the one genuinely env-baked knob.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import {
  readScoutBudgetOverrides,
  setScoutWorkspaceCeilingUsd,
  resolveScoutWorkspaceCeilingUsd,
  resolveScoutWorkspaceCeilingUsdLive,
  type ScoutBudgetOverrides,
} from '../../learning-governor/scout-budget-overrides';

// Canonical `{ data }` ToolResponse — the framework owns wire encoding (tool-data-shape-ratchet).
function json(obj: unknown) {
  return { data: obj };
}

export default defineTool({
  name: 'learning:set-scout-budget',
  profile: 'engineer',
  description:
    "Read/set/clear the runtime Scout WORKSPACE spend-ceiling override (USD), consulted before the PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD env. Tighten the aggregate scout cap mid-incident or raise it for a planned exploration burst — live, no deploy. set/clear audited + one-call-revertible; empty override ⇒ env/default (byte-identical).",
  capability: 'operator:write',
  guidance: {
    when: 'Blender spend across armed pots is summing too high (tighten the workspace ceiling live) or you want to raise it for a planned exploration burst, without a host restart. op:get to read the active override + effective ceiling.',
    notWhen: 'To tune regret-mining replay knobs (minScore/maxSessions/maxReplaysPerTick) use the regret routine payload via routines:set. To set a per-cycle learning SPEND budget use the learning-governor arming surface. This dial is the workspace-wide ceiling only.',
    chaining: 'config:list-overrides shows the active scout-workspace-budget override; config:reset-overrides reverts it to env/default.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('set'),
      workspaceCeilingUsd: z
        .number()
        .finite()
        .min(0)
        .max(100_000)
        .describe('Workspace-wide Blender spend ceiling in USD (0 = no Blender spend allowed).'),
      dryRun: z.boolean().optional(),
    }),
    z.object({ op: z.literal('clear'), dryRun: z.boolean().optional() }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      const override = await readScoutBudgetOverrides();
      return json({
        override,
        effectiveCeilingUsd: await resolveScoutWorkspaceCeilingUsdLive(),
        envCeilingUsd: resolveScoutWorkspaceCeilingUsd(),
      });
    }

    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('learning:set-scout-budget requires operator, architect, or mug role');
    }

    const nextUsd = args.op === 'clear' ? null : args.workspaceCeilingUsd;

    const outcome = await runControlMutation<ScoutBudgetOverrides>(
      {
        action: 'learning:set-scout-budget',
        subject: 'scout:workspace-ceiling',
        actor: `role:${ctx.role}`,
        capturePrev: () => readScoutBudgetOverrides(),
        apply: () => setScoutWorkspaceCeilingUsd(nextUsd),
        revertTo: (prev) => setScoutWorkspaceCeilingUsd(prev.workspaceCeilingUsd ?? null).then(() => {}),
        verify: async () => {
          const cur = await readScoutBudgetOverrides();
          const ok = (cur.workspaceCeilingUsd ?? null) === nextUsd;
          return { ok, detail: ok ? undefined : 'scout workspace ceiling override did not persist' };
        },
        describe: (prev) => ({ op: args.op, prevCeilingUsd: prev.workspaceCeilingUsd ?? null, proposedCeilingUsd: nextUsd }),
      },
      { dryRun: args.dryRun },
    );
    return json({
      ok: true, op: args.op, dryRun: outcome.dryRun, applied: outcome.applied, reverted: outcome.reverted,
      preview: outcome.preview, verify: outcome.verify, auditId: outcome.auditId,
    });
  },
});
