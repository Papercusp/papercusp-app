/**
 * POST /api/agent-mcp/trust-set — the owner trust-list write path
 * (shared-hive-trust-admission-2026-06-14 Phase 4 / P-011, Trust A4).
 *
 * Add or remove a trusted GitHub user — the security grant the admission gate
 * (work-items-admission.ts) consults so a VERIFIED trusted author's remote work may
 * auto-run. The `trust:add` / `trust:remove` MCP tools REQUIRE args (palette-excluded
 * by safety-filter §3), so the /settings/trust owner surface writes through this
 * dedicated loopback route — the same shape as `autonomy-policy-set`. Thin wrapper
 * over `addTrustedUser` / `removeTrustedUser` (which enforce ws-scoping D-004 + write
 * the audit row); this route adds the sync invalidation so the page refreshes.
 *
 * Loopback-only + owner authority (the desktop owner surface is the only caller).
 * High-consequence (widens what auto-runs) but never ARMS anything — an unverified
 * author is still never auto-admitted regardless of the trust list (D-001).
 */
import { defineTool } from '@papercusp/agent-mcp';
import { isLoopbackRequest } from '../../../superuser-token';

interface Body {
  action?: unknown;
  githubUserId?: unknown;
  note?: unknown;
}

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/trust-set',
  auth: 'loopback',
  async handler(req) {
    if (!isLoopbackRequest(req.headers)) {
      return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
    }
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }

    const action = body.action === 'add' || body.action === 'remove' ? body.action : '';
    if (!action) {
      return Response.json({ ok: false, error: 'missing_action' }, { status: 400 });
    }
    // A form input hands the id back as a string — coerce + validate (the store also
    // asserts a positive integer, but reject early with a clean 400 for the UI).
    const githubUserId =
      typeof body.githubUserId === 'number' ? body.githubUserId : Number(body.githubUserId);
    if (!Number.isInteger(githubUserId) || githubUserId <= 0) {
      return Response.json({ ok: false, error: 'invalid_github_user_id' }, { status: 400 });
    }
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) || null : null;

    const { activeWorkspaceId } = await import('../../../workspace-registry');
    const ws = activeWorkspaceId();
    try {
      let payload: Record<string, unknown>;
      if (action === 'add') {
        const { addTrustedUser } = await import('../../../trust/user-trust-list');
        const trusted = await addTrustedUser(ws, { githubUserId, note, actor: 'owner', nowMs: Date.now() });
        payload = { ok: true, workspaceId: ws, action, trusted };
      } else {
        const { removeTrustedUser } = await import('../../../trust/user-trust-list');
        const { removed } = await removeTrustedUser(ws, githubUserId, 'owner');
        payload = { ok: true, workspaceId: ws, action, githubUserId, removed };
      }
      // The page reads `trust.list` via useSyncQuery — refresh it after the write.
      const { notifySyncInvalidate } = await import('../../../sync-sse');
      await notifySyncInvalidate('trust.list', { workspaceId: ws }).catch(() => {});
      return Response.json(payload);
    } catch (err) {
      // addTrustedUser/removeTrustedUser throw on a non-positive id / no workspace — a 400, not a 500.
      return Response.json({ ok: false, error: (err as Error)?.message ?? 'trust_set_failed' }, { status: 400 });
    }
  },
});
