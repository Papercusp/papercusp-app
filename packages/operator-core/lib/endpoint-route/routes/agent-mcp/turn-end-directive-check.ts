/**
 * POST /api/agent-mcp/turn-end-directive-check?owner=<sid>&workspace=<ws>
 *
 * P-007 of plan `owner-directive-delivery-redesign-2026-09-22`: the Stop hook
 * (stop-owner-directive-check.mjs) asks this before a session's turn ends.
 * Answers `{ ok: true, reason }` — a non-null reason is what the hook blocks the
 * turn end with. The rules live in owner-directive-turn-end-check.ts.
 *
 * Fail-silent by contract: every failure answers `{ ok: true, reason: null }`,
 * so a broken check degrades to no check and never to a blocked agent.
 * `auth: 'loopback'` — the hook runs on this box.
 */
import { defineTool } from '@papercusp/agent-mcp';

const turnEndDirectiveCheck = defineTool({
  method: 'POST',
  path: '/agent-mcp/turn-end-directive-check',
  auth: 'loopback',
  async handler(req) {
    const params = new URL(req.url).searchParams;
    const owner = (params.get('owner') ?? '').trim();
    if (!owner) return Response.json({ ok: false, error: 'owner required' }, { status: 400 });
    try {
      const [{ runTurnEndDirectiveCheck }, { activeWorkspaceId }] = await Promise.all([
        import('../../../owner-directive-turn-end-check'),
        import('../../../workspace-registry'),
      ]);
      const workspace = (params.get('workspace') ?? '').trim();
      const workspaceId = workspace && workspace !== '*' ? workspace : activeWorkspaceId();
      const reason = await runTurnEndDirectiveCheck({ ownerId: owner, workspaceId });
      return Response.json({ ok: true, reason });
    } catch {
      return Response.json({ ok: true, reason: null });
    }
  },
});

export default [turnEndDirectiveCheck];
