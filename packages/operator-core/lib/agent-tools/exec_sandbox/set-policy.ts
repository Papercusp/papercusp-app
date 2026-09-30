/**
 * exec_sandbox:set_policy — read/set/clear the runtime TIGHTEN-ONLY capability-sandbox policy override
 * (live-configurability-audit-2026-06-20 P-019).
 *
 * The capability:bash sandbox masks a baked set of credential dirs (CAPABILITY_SANDBOX_MASK_DIRS) and
 * optionally denies all egress (the PAPERCUSP_CAPABILITY_SANDBOX_DENY_ALL_EGRESS env). This dial lets
 * an operator ADD extra home-relative mask dirs and/or FORCE deny-all-egress live — e.g. lock the
 * sandbox down harder during a security event — without a deploy. TIGHTEN-ONLY: it can only ADD masks
 * and FORCE egress-deny; it can never unmask a baked dir or re-open egress the env locked down. Gated
 * by the DARK papercusp-auth-config-overrides flag; empty ⇒ baked policy ⇒ byte-identical. Audited.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import {
  readAuthConfigOverrides,
  setSandboxPolicy,
  type AuthConfigOverrides,
} from '../../auth-config-overrides';
import { CAPABILITY_SANDBOX_MASK_DIRS } from '../capability/exec-sandbox';

function json(obj: unknown) {
  // { data } shape: the framework owns wire encoding (tool-data-shape ratchet, WI-10002555).
  return { data: obj };
}

export default defineTool({
  name: 'exec_sandbox:set_policy',
  profile: 'engineer',
  description:
    "Read/set/clear the TIGHTEN-ONLY capability-sandbox policy override: ADD home-relative mask dirs (unioned over the baked CAPABILITY_SANDBOX_MASK_DIRS) and/or FORCE deny-all-egress, live. Can only add masks / lock down — never unmask a baked dir or re-open egress. DARK behind papercusp-auth-config-overrides; empty ⇒ baked policy (byte-identical). set/clear audited + revertible.",
  capability: 'operator:write',
  guidance: {
    when: 'Lock the capability:bash sandbox down harder during a security event — mask additional credential dirs or force deny-all-egress — live, no deploy. Requires papercusp-auth-config-overrides ON. op:get to read the active additions + the baked masks.',
    notWhen: 'You cannot remove a baked mask or re-open egress with this dial (tighten-only). maskAdditions are home-relative dir paths (e.g. ".config/foo").',
    chaining: 'config:list-overrides shows the active auth-config-overrides; config:reset-overrides reverts to the baked sandbox policy.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z
      .object({
        op: z.literal('set'),
        maskAdditions: z.array(z.string().min(1).max(200)).max(64).optional().describe('Extra home-relative dirs to mask (add-only).'),
        denyAllEgress: z.boolean().optional().describe('true forces deny-all-egress (tighten-only).'),
        dryRun: z.boolean().optional(),
      })
      .refine((a) => a.maskAdditions !== undefined || a.denyAllEgress !== undefined, {
        message: 'set requires maskAdditions and/or denyAllEgress (or use op:clear)',
      }),
    z.object({ op: z.literal('clear'), dryRun: z.boolean().optional() }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      const o = await readAuthConfigOverrides();
      return json({
        maskAdditions: o.sandboxMaskAdditions ?? [],
        denyAllEgress: o.sandboxDenyAllEgress ?? null,
        bakedMaskDirs: [...CAPABILITY_SANDBOX_MASK_DIRS],
      });
    }

    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('exec_sandbox:set_policy requires operator, architect, or mug role');
    }

    const nextPolicy =
      args.op === 'clear'
        ? null
        : {
            ...(args.maskAdditions !== undefined ? { maskAdditions: args.maskAdditions } : {}),
            ...(args.denyAllEgress !== undefined ? { denyAllEgress: args.denyAllEgress } : {}),
          };

    const outcome = await runControlMutation<AuthConfigOverrides>(
      {
        action: 'exec_sandbox:set_policy',
        subject: 'exec_sandbox:policy',
        actor: `role:${ctx.role}`,
        capturePrev: () => readAuthConfigOverrides(),
        apply: () => setSandboxPolicy(nextPolicy),
        revertTo: (prev) =>
          setSandboxPolicy({
            maskAdditions: prev.sandboxMaskAdditions ?? null,
            denyAllEgress: prev.sandboxDenyAllEgress ?? null,
          }).then(() => {}),
        verify: async (next) => {
          const cur = await readAuthConfigOverrides();
          const ok = JSON.stringify(cur) === JSON.stringify(next);
          return { ok, detail: ok ? undefined : 'sandbox policy override did not persist' };
        },
        describe: (prev) => ({
          op: args.op,
          prev: { maskAdditions: prev.sandboxMaskAdditions ?? [], denyAllEgress: prev.sandboxDenyAllEgress ?? null },
          proposed: nextPolicy,
        }),
      },
      { dryRun: args.dryRun },
    );
    return json({
      ok: true, op: args.op, dryRun: outcome.dryRun, applied: outcome.applied, reverted: outcome.reverted,
      preview: outcome.preview, verify: outcome.verify, auditId: outcome.auditId,
    });
  },
});
