/**
 * POST /api/work-scope/set   { mode, allowHarnesses, exceptions?, reason, dryRun? }
 * POST /api/work-scope/clear { dryRun? }
 *
 * The /admin/work-scope pane's write doors (WI-2145092, the D-003 residue of plan
 * workspace-work-scope-policy-2026-09-04). Both run the SAME audited control mutation as
 * the MCP tool `workspace:work_scope` (applyWorkScopeSet / applyWorkScopeClear in
 * work-scope-control.ts), so a pane click and a tool call are indistinguishable in the
 * pot-control-policy audit trail: capture-prev, apply, verify, revert-on-failure, audit id.
 *
 * `auth: 'loopback'` like /flags/set — an admin-pane write from the desktop's own content
 * layer. The reply mirrors the tool's shape (applied / reverted / verify / auditId / policy);
 * a mutation the harness had to REVERT answers ok:false so the pane never shows a green
 * toast for a policy that did not persist.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { applyWorkScopeClear, applyWorkScopeSet, workScopeSetSchema } from '../../../work-scope-control';

const ClearBody = z.object({ dryRun: z.boolean().optional() });

function actorFor(ctx: { principal?: { slug?: string } | null }): string {
  return `admin:${ctx.principal?.slug ?? 'operator'}`;
}

const set = defineTool({
  method: 'POST',
  path: '/work-scope/set',
  auth: 'loopback',
  input: workScopeSetSchema,
  async handler(_req, ctx) {
    const { mode, allowHarnesses, exceptions, reason, dryRun } = ctx.input;
    const outcome = await applyWorkScopeSet({ mode, allowHarnesses, exceptions, reason }, actorFor(ctx), { dryRun });
    const ok = !outcome.reverted;
    return Response.json(
      {
        ok,
        op: 'set',
        dryRun: outcome.dryRun,
        applied: outcome.applied,
        reverted: outcome.reverted,
        preview: outcome.preview,
        verify: outcome.verify,
        auditId: outcome.auditId,
        policy: outcome.next ? { ...outcome.next, ledger: undefined } : null,
        ...(ok ? {} : { error: outcome.verify?.detail ?? 'the policy did not persist and was reverted' }),
      },
      { status: ok ? 200 : 502 },
    );
  },
});

const clear = defineTool({
  method: 'POST',
  path: '/work-scope/clear',
  auth: 'loopback',
  input: ClearBody,
  async handler(_req, ctx) {
    const outcome = await applyWorkScopeClear(actorFor(ctx), { dryRun: ctx.input.dryRun });
    const ok = !outcome.reverted;
    return Response.json(
      {
        ok,
        op: 'clear',
        dryRun: outcome.dryRun,
        applied: outcome.applied,
        reverted: outcome.reverted,
        preview: outcome.preview,
        verify: outcome.verify,
        auditId: outcome.auditId,
        ...(ok ? {} : { error: outcome.verify?.detail ?? 'the policy was still present after clear and the clear was reverted' }),
      },
      { status: ok ? 200 : 502 },
    );
  },
});

export default [set, clear];
