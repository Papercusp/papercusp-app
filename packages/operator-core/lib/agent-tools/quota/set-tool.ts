/**
 * quota:set_tool — read/set/clear a runtime per-(tool,role) quota override
 * (live-configurability-audit-2026-06-20 P-018).
 *
 * Each tool bakes a `rolesQuota[role]` cap (perChunk/perRun/perDay) enforced at the dispatch quota
 * step. This dial overrides ONE tool's cap for ONE role live — raise it for a planned burst, or
 * tighten it when a tool is hammering a window — without editing the literal + deploying. The
 * override is MERGED OVER the baked cap (set fields win; absent fields keep the baked value). Empty
 * override ⇒ baked cap ⇒ byte-identical. Audited + one-call-revertible via the control harness.
 *
 * Operational, not auth: a quota cap rate-limits call COUNT in a window — it never widens which
 * tools a role may call (that is capability:* / quota is downstream of capability). So this ships
 * LIVE (no dark flag), like the other operational dials.
 */
import { z } from 'zod';
import { defineTool, entityRef, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import {
  readQuotaOverrides,
  setToolQuotaOverride,
  quotaOverrideKey,
  type QuotaOverride,
  type QuotaOverrides,
} from '../../quota-overrides';

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

const quotaField = z.number().int().min(0).max(1_000_000);

export default defineTool({
  name: 'quota:set_tool',
  profile: 'engineer',
  description:
    "Read/set/clear a runtime per-(tool,role) quota override (perChunk/perRun/perDay), merged over the tool's baked rolesQuota at the dispatch quota step. Raise a tool's cap for a role for a planned burst, or tighten it mid-incident — live, no deploy. set/clear audited + one-call-revertible; empty override ⇒ baked cap (byte-identical).",
  capability: 'operator:write',
  guidance: {
    when: 'A specific tool is throttling a role (raise its perRun/perChunk for that role), or a tool is being hammered and you want to tighten its cap — without editing the rolesQuota literal + deploying. op:get to read the active overrides.',
    notWhen: 'To change WHICH tools a role may call use the capability/envelope tools (quota is call-COUNT rate-limiting, downstream of capability). To change fleet-wide rate limits use operator:rate_limit_config.',
    chaining: 'config:list-overrides shows the active tool-quota-overrides; config:reset-overrides reverts them to the baked caps.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 40 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z
      .object({
        op: z.literal('set'),
        toolName: z.string().min(1).max(120),
        role: entityRef('role', { max: 80 }),
        perChunk: quotaField.optional(),
        perRun: quotaField.optional(),
        perDay: quotaField.optional(),
        dryRun: z.boolean().optional(),
      })
      .refine((a) => a.perChunk !== undefined || a.perRun !== undefined || a.perDay !== undefined, {
        message: 'set requires at least one of perChunk / perRun / perDay (or use op:clear)',
      }),
    z.object({ op: z.literal('clear'), toolName: z.string().min(1).max(120), role: entityRef('role', { max: 80 }), dryRun: z.boolean().optional() }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      const o = await readQuotaOverrides();
      return json({ overrides: o.overrides ?? {} });
    }

    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('quota:set_tool requires operator, architect, or mug role');
    }

    const { toolName, role } = args;
    const key = quotaOverrideKey(toolName, role);
    const nextQuota: QuotaOverride | null =
      args.op === 'clear'
        ? null
        : {
            ...(args.perChunk !== undefined ? { perChunk: args.perChunk } : {}),
            ...(args.perRun !== undefined ? { perRun: args.perRun } : {}),
            ...(args.perDay !== undefined ? { perDay: args.perDay } : {}),
          };

    const outcome = await runControlMutation<QuotaOverrides>(
      {
        action: 'quota:set_tool',
        subject: key,
        actor: `role:${ctx.role}`,
        capturePrev: () => readQuotaOverrides(),
        apply: () => setToolQuotaOverride(toolName, role, nextQuota),
        revertTo: (prev) => setToolQuotaOverride(toolName, role, prev.overrides?.[key] ?? null).then(() => {}),
        verify: async () => {
          const cur = await readQuotaOverrides();
          const got = cur.overrides?.[key] ?? null;
          const ok = JSON.stringify(got) === JSON.stringify(nextQuota);
          return { ok, detail: ok ? undefined : 'quota override did not persist' };
        },
        describe: (prev) => ({ op: args.op, key, prev: prev.overrides?.[key] ?? null, proposed: nextQuota }),
      },
      { dryRun: args.dryRun },
    );
    return json({
      ok: true, op: args.op, key, dryRun: outcome.dryRun, applied: outcome.applied, reverted: outcome.reverted,
      preview: outcome.preview, verify: outcome.verify, auditId: outcome.auditId,
    });
  },
});
