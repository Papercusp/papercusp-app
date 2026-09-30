/**
 * auth:set_full_access_roles — read/set/clear the runtime testing-phase full-access bypass-role set
 * (live-configurability-audit-2026-06-20 P-019; the §G escalation surface).
 *
 * The baked TESTING_FULL_ACCESS_ROLES set (gate-bypass.ts) gives its roles the SAME role+capability
 * gate bypass as a superuser — the strongest escalation in the system. This dial REPLACES that set at
 * runtime (e.g. add a role that needs full access mid-incident, or trim to least-privilege) without a
 * deploy. Because adding a role WIDENS access, the override is gated behind the DARK
 * papercusp-auth-config-overrides flag (owner-authority): OFF (default) ⇒ the baked set applies ⇒
 * byte-identical; the owner flips the flag ON to ratify this dial. Audited + one-call-revertible.
 *
 * The global kill-switch (disable testing-full-access entirely) is the separate
 * papercusp-testing-full-access flag (flip it OFF), not this dial.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole, TESTING_FULL_ACCESS_ROLES } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import {
  readAuthConfigOverrides,
  setFullAccessRoles,
  type AuthConfigOverrides,
} from '../../auth-config-overrides';

function json(obj: unknown) {
  return { data: obj };
}

export default defineTool({
  name: 'auth:set_full_access_roles',
  profile: 'engineer',
  description:
    "Read/set/clear the runtime testing-phase full-access bypass-role set (REPLACES the baked TESTING_FULL_ACCESS_ROLES — roles that skip all role+capability gates). DARK behind papercusp-auth-config-overrides (OFF ⇒ baked set, byte-identical); the owner flips it ON to ratify. The global enable/disable is the papercusp-testing-full-access flag. set/clear audited + one-call-revertible.",
  capability: 'operator:write',
  guidance: {
    when: 'A role needs the testing-phase full-access bypass mid-incident (add it), or you are trimming the bypass set toward least-privilege — live, no deploy. Requires the owner to have flipped papercusp-auth-config-overrides ON. op:get to read the override + baked set.',
    notWhen: 'To globally DISABLE testing-full-access use the papercusp-testing-full-access flag (the kill-switch). To confine a role\'s capabilities use capability_envelope:set_role. This widens access — the highest-stakes dial; prefer tightening.',
    chaining: 'config:list-overrides shows the active auth-config-overrides; config:reset-overrides reverts to the baked set.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('set'),
      roles: z.array(z.string().min(1).max(80)).max(64).describe('The roles that get full-access bypass (REPLACES the baked set).'),
      dryRun: z.boolean().optional(),
    }),
    z.object({ op: z.literal('clear'), dryRun: z.boolean().optional() }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      const o = await readAuthConfigOverrides();
      return json({ overrideRoles: o.fullAccessRoles ?? null, bakedRoles: [...TESTING_FULL_ACCESS_ROLES] });
    }

    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('auth:set_full_access_roles requires operator, architect, or mug role');
    }

    const nextRoles = args.op === 'clear' ? null : args.roles;

    const outcome = await runControlMutation<AuthConfigOverrides>(
      {
        action: 'auth:set_full_access_roles',
        subject: 'auth:full-access-roles',
        actor: `role:${ctx.role}`,
        capturePrev: () => readAuthConfigOverrides(),
        apply: () => setFullAccessRoles(nextRoles),
        revertTo: (prev) => setFullAccessRoles(prev.fullAccessRoles ?? null).then(() => {}),
        verify: async () => {
          const cur = await readAuthConfigOverrides();
          const ok = JSON.stringify(cur.fullAccessRoles ?? null) === JSON.stringify(nextRoles);
          return { ok, detail: ok ? undefined : 'full-access roles override did not persist' };
        },
        describe: (prev) => ({ op: args.op, prevRoles: prev.fullAccessRoles ?? null, proposedRoles: nextRoles }),
      },
      { dryRun: args.dryRun },
    );
    return json({
      ok: true, op: args.op, dryRun: outcome.dryRun, applied: outcome.applied, reverted: outcome.reverted,
      preview: outcome.preview, verify: outcome.verify, auditId: outcome.auditId,
    });
  },
});
