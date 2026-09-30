/**
 * capability_tier:set — read/set/clear a runtime capability→tier override
 * (live-configurability-audit-2026-06-20 P-010).
 *
 * Re-classify a capability's risk tier (low|medium|high) at runtime, consulted by papercuspTierFor
 * BEFORE the baked EXACT table — so a mis-tiering (the EI-99/EI-111 class, both LOWERINGS) is fixable
 * without a deploy. DARK behind papercusp-auth-config-overrides (the §G auth-config umbrella; owner
 * ratifies by flipping it ON); empty/OFF ⇒ the baked table ⇒ byte-identical. Audited + revertible.
 *
 * SCOPE (honest boundary): the override is LIVE for RUNTIME tierFor callers — the capability
 * catalog/palette projection + the decision-ledger posture. Consumers reading a tool's LOAD-TIME
 * STAMPED tier (the endpoint-auth-tiers exposure gate, the watchdog per-tool timeout) re-stamp on the
 * next operator BOOT, so a re-tier reaches THEM after a restart, not live. Widening to live
 * consumer-side re-resolution on those auth-adjacent gates is an owner decision (plan D-010), not
 * autonomous — so this dial covers the runtime-caller override, dark.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import {
  readCapabilityTierOverrides,
  setCapabilityTier,
  type CapabilityTierOverrides,
} from '../../capability-tier-overrides';

function json(obj: unknown) {
  return { data: obj };
}

export default defineTool({
  name: 'capability_tier:set',
  profile: 'engineer',
  description:
    "Read/set/clear a runtime capability→tier override (low|medium|high), consulted before the baked tier table by papercuspTierFor. Fix a mis-tiering (e.g. a read mis-classified as a write inflating watchdog/ledger posture) without a deploy. DARK behind papercusp-auth-config-overrides; empty/OFF ⇒ baked table (byte-identical). LIVE for runtime tierFor callers (capability catalog + decision-ledger); load-time-stamped consumers (endpoint-auth exposure, watchdog timeout) pick it up on the next operator boot. set/clear audited + revertible.",
  capability: 'operator:write',
  guidance: {
    when: 'A capability is mis-tiered (e.g. a cheap read classified medium/high, inflating its watchdog timeout or decision-ledger posture) and you want to correct it live. Requires papercusp-auth-config-overrides ON. op:get to read the active overrides.',
    notWhen: 'To grant/deny a capability to a role use the capability/envelope tools (tier is risk CLASSIFICATION, not access). A re-tier reaches the endpoint-auth exposure gate + watchdog only after an operator restart (it re-stamps tools at boot).',
    chaining: 'config:list-overrides shows the active capability-tier-overrides; config:reset-overrides reverts to the baked table.',
    seeAlso: [
      'capability_envelope:set_role (grant / deny access — tier is classification, not access)',
      'config:list-overrides (active capability-tier overrides)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('set'),
      capability: z.string().min(1).max(120),
      tier: z.enum(['low', 'medium', 'high']),
      dryRun: z.boolean().optional(),
    }),
    z.object({ op: z.literal('clear'), capability: z.string().min(1).max(120), dryRun: z.boolean().optional() }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      const o = await readCapabilityTierOverrides();
      return json({ tiers: o.tiers ?? {} });
    }

    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('capability_tier:set requires operator, architect, or mug role');
    }

    const { capability } = args;
    const nextTier = args.op === 'clear' ? null : args.tier;

    const outcome = await runControlMutation<CapabilityTierOverrides>(
      {
        action: 'capability_tier:set',
        subject: `tier:${capability}`,
        actor: `role:${ctx.role}`,
        capturePrev: () => readCapabilityTierOverrides(),
        apply: () => setCapabilityTier(capability, nextTier),
        revertTo: (prev) => setCapabilityTier(capability, prev.tiers?.[capability] ?? null).then(() => {}),
        verify: async () => {
          const cur = await readCapabilityTierOverrides();
          const ok = (cur.tiers?.[capability] ?? null) === nextTier;
          return { ok, detail: ok ? undefined : 'capability tier override did not persist' };
        },
        describe: (prev) => ({ op: args.op, capability, prevTier: prev.tiers?.[capability] ?? null, proposedTier: nextTier }),
      },
      { dryRun: args.dryRun },
    );
    return json({
      ok: true, op: args.op, capability, dryRun: outcome.dryRun, applied: outcome.applied, reverted: outcome.reverted,
      preview: outcome.preview, verify: outcome.verify, auditId: outcome.auditId,
    });
  },
});
