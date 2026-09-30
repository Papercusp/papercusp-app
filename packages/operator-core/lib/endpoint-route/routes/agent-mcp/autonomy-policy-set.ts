/**
 * POST /api/agent-mcp/autonomy-policy-set — the owner control surface write path
 * (queen-autonomy-policy-2026-06-13 B-15 / P-030).
 *
 * Sets one category's autonomy ceiling / lock / graduated level. The MCP
 * `autonomy:policy_set` tool can't be reached through the command-palette
 * `run-tool` path (it REQUIRES args → palette-excluded by safety-filter §3), so
 * the settings page writes through this dedicated loopback route — the same shape
 * as `operator-voice-prefs`. Both transports are thin wrappers over the one store
 * fn `setAutonomyPolicy` (which enforces the invariants + writes the audit row);
 * this route adds the sync invalidation so the page refreshes.
 *
 * Loopback-only: the desktop owner surface is the only caller. High-consequence
 * (changes what the Queen may auto-decide) but never ARMS autonomy on its own —
 * categories ship never-auto and widen only after the P-092 arming gate too.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { isLoopbackRequest } from '../../../superuser-token';

interface Body {
  category?: unknown;
  ceiling?: unknown;
  locked?: unknown;
  graduatedLevel?: unknown;
  ownerOverride?: unknown;
  reason?: unknown;
}

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/autonomy-policy-set',
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

    const category = typeof body.category === 'string' ? body.category : '';
    if (!category) {
      return Response.json({ ok: false, error: 'missing_category' }, { status: 400 });
    }
    // A reason is required for the audit row (mirrors the MCP tool's zod min(8)).
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 8) {
      return Response.json({ ok: false, error: 'reason_required' }, { status: 400 });
    }

    const { getOrgPg } = await import('@papercusp/db-org');
    const { activeWorkspaceId } = await import('../../../workspace-registry');
    const { setAutonomyPolicy } = await import('../../../autonomy/policy-store');
    const { decoratePolicyForView } = await import('../../../autonomy/policy-view');

    const ws = activeWorkspaceId();
    try {
      const policy = await setAutonomyPolicy(
        getOrgPg().sql,
        ws,
        {
          category,
          ceiling: typeof body.ceiling === 'string' ? body.ceiling : undefined,
          locked: typeof body.locked === 'boolean' ? body.locked : undefined,
          graduatedLevel:
            typeof body.graduatedLevel === 'string' ? body.graduatedLevel : undefined,
          // null clears the directive; a non-null object sets it; undefined leaves it.
          ownerOverride:
            body.ownerOverride === null
              ? null
              : typeof body.ownerOverride === 'object' && body.ownerOverride
                ? (body.ownerOverride as Record<string, unknown>)
                : undefined,
          reason,
        },
        // The desktop owner surface IS the owner — the audited authority actor (D-005).
        'owner',
      );
      const { notifySyncInvalidate } = await import('../../../sync-sse');
      // NAME-ONLY invalidation (no args). The `autonomy.policy` / `autonomy.graduation`
      // resolvers take no args (they read activeWorkspaceId() internally) and the
      // settings page subscribes with no args, so its react-query key is
      // ['sync','autonomy.policy',{}]. An args-scoped invalidation
      // (`{ workspaceId }`) makes the SSE client do an EXACT-key invalidate of
      // ['sync','autonomy.policy',{workspaceId}], which never matches the {} key —
      // so the ceiling write saved but the table never refetched (looked like it
      // "wasn't saving"). Name-only takes the predicate branch that invalidates
      // every entry under the name. (See SSEAdapter.tsx invalidate handling.)
      await notifySyncInvalidate('autonomy.policy').catch(() => {});
      // A graduatedLevel ratify (P-032) changes a category's graduation target, so
      // refresh the graduation surface too (cheap; derives from the same policy).
      await notifySyncInvalidate('autonomy.graduation').catch(() => {});
      return Response.json({ ok: true, workspaceId: ws, policy: decoratePolicyForView(policy) });
    } catch (err) {
      // setAutonomyPolicy throws on unknown category / invalid level — a 400, not a 500.
      return Response.json(
        { ok: false, error: (err as Error)?.message ?? 'set_failed' },
        { status: 400 },
      );
    }
  },
});
