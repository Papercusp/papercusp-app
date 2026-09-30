/**
 * config:reset-overrides — revert runtime-config overrides back to baked defaults
 * (live-configurability-audit-2026-06-20 P-025; the mid-incident "undo the overrides"
 * companion to config:list-overrides).
 *
 * One concern (concern:"watchdog-tunables") or ALL (all:true). Each concern's reset runs through
 * the gateway-control harness, so it's audited and one-call-revertible per concern (capturePrev
 * = the current overrides, apply = reset-to-defaults, revertTo = re-apply the captured overrides).
 *
 * A generic blanket revert-to-defaults is cross-cutting by nature — consistent with D-001 (which
 * forbids a generic WRITE god-tool with per-concern *semantics*, not a uniform reset).
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import { listOverrideConcerns, getOverrideConcern } from '../../config-overrides/registry';

export default defineTool({
  name: 'config:reset-overrides',
  profile: 'engineer',
  description:
    'Revert runtime-config overrides back to baked defaults — one concern (concern:"watchdog-tunables") or all (all:true). Each reset is audited + one-call-revertible via the control harness. The mid-incident "undo the overrides" companion to config:list-overrides.',
  capability: 'operator:write',
  guidance: {
    when: 'Roll back runtime-config changes to baked defaults — a single concern after a bad tune, or everything at once during an incident ("reset all overrides").',
    notWhen: "To SEE what's overridden first, use config:list-overrides. To change one value, use that concern's set tool.",
    chaining: 'config:list-overrides before to see what will reset, and after to confirm it cleared.',
    seeAlso: [
      'config:list-overrides (see what will reset before, confirm cleared after)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.object({
    concern: z.string().max(120).optional().describe('Concern name to reset; omit and pass all:true to reset every concern.'),
    all: z.boolean().optional().describe('Reset ALL registered concerns to defaults.'),
    dryRun: z.boolean().optional().describe('Preview what would reset without applying.'),
  }),
  async handler(args, ctx) {
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('config:reset-overrides requires operator, architect, or mug role');
    }
    if (!args.all && !args.concern) throw new Error('pass concern:"<name>" or all:true');

    const targets = args.all
      ? listOverrideConcerns()
      : [getOverrideConcern(args.concern!)].filter((c): c is NonNullable<typeof c> => Boolean(c));
    if (targets.length === 0) {
      throw new Error(args.concern ? `unknown concern: ${args.concern}` : 'no registered concerns to reset');
    }

    const reset = [];
    for (const c of targets) {
      const outcome = await runControlMutation<unknown>(
        {
          action: 'config:reset-overrides',
          subject: c.name,
          actor: `role:${ctx.role}`,
          capturePrev: () => c.capture(),
          apply: () => c.reset(),
          revertTo: (prev) => c.restore(prev),
          verify: async () => {
            const remaining = await c.diff();
            return { ok: remaining.length === 0, detail: remaining.length ? `${remaining.length} override(s) remain` : undefined };
          },
          describe: (prev) => prev,
        },
        { dryRun: args.dryRun },
      );
      reset.push({
        concern: c.name,
        dryRun: outcome.dryRun,
        applied: outcome.applied,
        reverted: outcome.reverted,
        preview: outcome.preview,
        verify: outcome.verify,
        auditId: outcome.auditId,
      });
    }

    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, reset }) }] };
  },
});
