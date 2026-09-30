/**
 * workspace:work_scope — read / set / clear the workspace WORK-SCOPE policy
 * (plan workspace-work-scope-policy-2026-09-04).
 *
 * The policy says which harnesses agents may be launched into or pull work from.
 * It is enforced at the chokepoints (agent launches, scheduler pulls / claims,
 * admission promotion, git-sync fixer dispatch, grading sweeps) — never at filing.
 * Absent ⇒ every harness allowed, byte-identical to before. set/clear are audited
 * + one-call-revertible through the control harness, exactly like pot:control_policy —
 * via the SHARED helpers in work-scope-control.ts, which the /admin/work-scope pane's
 * HTTP route calls too (WI-2145092): one mutation path, two doors.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { readWorkScopePolicy, evaluateWorkScope } from '../../work-scope-policy';
import { applyWorkScopeClear, applyWorkScopeSet, workScopeSetSchema } from '../../work-scope-control';

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

export default defineTool({
  name: 'workspace:work_scope',
  profile: 'engineer',
  description:
    "Read or set the workspace WORK-SCOPE policy: which harnesses agents may be launched into / pull work from (e.g. allowHarnesses ['papercusp','papercusp/*']). Enforced at launch / claim / promotion / fixer-dispatch chokepoints; absent ⇒ everything allowed. set/clear are audited + revertible.",
  capability: 'operator:write',
  guidance: {
    when: "The owner wants agents confined to one project (\"only papercusp work right now\"): set { mode:'enforce', allowHarnesses:['papercusp','papercusp/*'] }. `check` answers whether one harness/plan/goal/work-item is in scope. `get` shows the policy + the ledger of recent denials/holds/re-homes.",
    notWhen: 'To steer WHICH items inside an allowed harness a fleet pulls, use scheduler:set_claim_spec. To pause one pot entirely use pot:pause.',
    chaining: "config:list-overrides shows the active policy; the ledger on { op:'get' } shows the last denials. state:read { cell:'workspace.workScope' } is the read-only lens.",
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 40 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('check'),
      harness: z.string().min(1).max(120),
      plan: z.string().min(1).max(200).optional(),
      goal: z.string().min(1).max(200).optional(),
      workItem: z.string().min(1).max(120).optional(),
    }),
    workScopeSetSchema.extend({ op: z.literal('set') }),
    z.object({ op: z.literal('clear'), dryRun: z.boolean().optional() }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      const policy = await readWorkScopePolicy();
      return json({
        ok: true,
        enforced: !!policy && policy.mode === 'enforce' && policy.allowHarnesses.length > 0,
        policy: policy
          ? { ...policy, ledger: undefined }
          : null,
        ledger: policy?.ledger ?? { entries: [], counts: { denied: 0, held: 0, rehomed: 0 } },
      });
    }
    if (args.op === 'check') {
      const policy = await readWorkScopePolicy();
      const verdict = evaluateWorkScope(
        { harness: args.harness, plan: args.plan ?? null, goal: args.goal ?? null, workItem: args.workItem ?? null },
        policy,
      );
      return json({ ok: true, verdict });
    }

    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('workspace:work_scope set/clear requires operator, architect, or mug role');
    }
    const actor = `role:${ctx.role}`;
    if (args.op === 'clear') {
      const outcome = await applyWorkScopeClear(actor, { dryRun: args.dryRun });
      return json({ ok: true, op: 'clear', dryRun: outcome.dryRun, applied: outcome.applied, reverted: outcome.reverted, preview: outcome.preview, verify: outcome.verify, auditId: outcome.auditId });
    }

    const outcome = await applyWorkScopeSet(
      { mode: args.mode, allowHarnesses: args.allowHarnesses, exceptions: args.exceptions, reason: args.reason },
      actor,
      { dryRun: args.dryRun },
    );
    return json({
      ok: true,
      op: 'set',
      dryRun: outcome.dryRun,
      applied: outcome.applied,
      reverted: outcome.reverted,
      preview: outcome.preview,
      verify: outcome.verify,
      auditId: outcome.auditId,
      policy: outcome.next ? { ...outcome.next, ledger: undefined } : null,
    });
  },
});
