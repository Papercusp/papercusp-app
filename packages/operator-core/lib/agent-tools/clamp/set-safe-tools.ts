/**
 * clamp:set_safe_tools — read/set/clear the runtime NARROW-only override of the scoped-superuser
 * cross-workspace safe-tool allowlist (live-configurability-audit-2026-06-20 P-019).
 *
 * The baked SCOPED_SAFE_CROSSWORKSPACE set (_mcp-handler.ts) is the small allowlist of crossWorkspace
 * tools a SCOPED superuser session may still call (they self-confine to the caller's own workspace).
 * This dial can REMOVE tools from that allowlist live — so a scoped superuser is denied a tool the
 * clamp would otherwise let through. TIGHTEN-ONLY: it is a remove-set, never an add — it can only
 * NARROW a scoped superuser's cross-workspace reach, never widen it. Gated by the DARK
 * papercusp-auth-config-overrides flag; empty ⇒ baked allowlist ⇒ byte-identical. Audited + revertible.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import {
  readAuthConfigOverrides,
  setSafeToolsRemove,
  type AuthConfigOverrides,
} from '../../auth-config-overrides';

function json(obj: unknown) {
  return { data: obj };
}

export default defineTool({
  name: 'clamp:set_safe_tools',
  profile: 'engineer',
  description:
    "Read/set/clear the NARROW-only override of the scoped-superuser cross-workspace safe-tool allowlist. Lists tools to REMOVE from the baked SCOPED_SAFE_CROSSWORKSPACE allowlist (the clamp then denies them from a scoped SU session). TIGHTEN-ONLY (remove-set, never add). DARK behind papercusp-auth-config-overrides; empty ⇒ baked allowlist (byte-identical). set/clear audited + revertible.",
  capability: 'operator:write',
  guidance: {
    when: 'You want a scoped-superuser session to be DENIED a crossWorkspace tool the baked allowlist permits (narrow its cross-workspace reach) — live, no deploy. Requires papercusp-auth-config-overrides ON. op:get to read the active remove-set.',
    notWhen: 'You cannot ADD tools to the allowlist with this dial (tighten-only by design). To grant capabilities use the capability tools.',
    chaining: 'config:list-overrides shows the active auth-config-overrides; config:reset-overrides reverts (restores the full baked allowlist).',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('set'),
      remove: z.array(z.string().min(1).max(120)).max(200).describe('Tool names to REMOVE from the scoped-SU cross-workspace allowlist.'),
      dryRun: z.boolean().optional(),
    }),
    z.object({ op: z.literal('clear'), dryRun: z.boolean().optional() }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      const o = await readAuthConfigOverrides();
      return json({ safeToolsRemove: o.safeToolsRemove ?? [] });
    }

    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('clamp:set_safe_tools requires operator, architect, or mug role');
    }

    const nextRemove = args.op === 'clear' ? null : args.remove;

    const outcome = await runControlMutation<AuthConfigOverrides>(
      {
        action: 'clamp:set_safe_tools',
        subject: 'clamp:safe-tools-remove',
        actor: `role:${ctx.role}`,
        capturePrev: () => readAuthConfigOverrides(),
        apply: () => setSafeToolsRemove(nextRemove),
        revertTo: (prev) => setSafeToolsRemove(prev.safeToolsRemove ?? null).then(() => {}),
        verify: async () => {
          const cur = await readAuthConfigOverrides();
          const ok = JSON.stringify(cur.safeToolsRemove ?? null) === JSON.stringify(nextRemove);
          return { ok, detail: ok ? undefined : 'safe-tools remove-set did not persist' };
        },
        describe: (prev) => ({ op: args.op, prevRemove: prev.safeToolsRemove ?? [], proposedRemove: nextRemove }),
      },
      { dryRun: args.dryRun },
    );
    return json({
      ok: true, op: args.op, dryRun: outcome.dryRun, applied: outcome.applied, reverted: outcome.reverted,
      preview: outcome.preview, verify: outcome.verify, auditId: outcome.auditId,
    });
  },
});
