/**
 * workspace:work_scope_status — the READ-ONLY lens behind the `workspace.workScope`
 * state cell (WI-2145092, the D-003 residue of plan workspace-work-scope-policy-2026-09-04).
 *
 * `workspace:work_scope` is the CONTROL surface and carries a write capability, which the
 * read-only cell dispatcher refuses by design (predicate-watch: `effect !== 'read'`). This
 * tool exists so `state:read { cell:'workspace.workScope' }` and `state:subscribe` have a
 * resolver they are allowed to call. It projects buildWorkScopeStatusPayload — the SAME
 * derivation the /admin/work-scope pane reads — so no door can disagree with another.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { buildWorkScopeStatusPayload, readWorkScopePolicy } from '../../work-scope-policy';

export default defineTool({
  name: 'workspace:work_scope_status',
  profile: 'engineer',
  description:
    'Read the workspace work-scope policy as a status lens: mode, allow-list, ledger counts and the enforce/off/absent assessment behind state:read workspace.workScope.',
  guidance: {
    when: 'As the resolver behind state:read { cell:"workspace.workScope" }, or when you only need to READ whether the workspace is confined to an allow-list of harnesses.',
    notWhen: 'To set or clear the policy — that is workspace:work_scope { op:"set"|"clear" }.',
    chaining: 'state:read { cell:"workspace.workScope" } is the ordinary entry point; workspace:work_scope { op:"get" } returns the same policy with the full ledger ring.',
  },
  // @cell-lens workspace.workScope
  // This tool IS the registered resolver behind workspace.workScope (cell-registrations.ts
  // WORK_SCOPE_CELL.changeSignal.tool). Read-only by contract: `capability: 'intel:read'`.
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    /** how many of the most recent ledger decisions to include (0–100; default 10) */
    recent: z.number().int().min(0).max(100).optional(),
  }),
  async handler(args) {
    const policy = await readWorkScopePolicy();
    const payload = buildWorkScopeStatusPayload(policy, { recent: args.recent });
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  },
});
