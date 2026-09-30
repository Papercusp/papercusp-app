/**
 * POST /api/agent-mcp/rebind-identity  { from, to, force? }
 *
 * compaction-continuity-hardening-2026-07-07 P-007: the write the SessionStart
 * recovery hook (session-recover-hook.mjs) fires when it detects the live
 * PAPERCUSP_SID differs from the recorded launch sid — migrates every
 * ownerId-keyed surface (armed loop, carry-note, claims, awaits, fleet,
 * held items, owner facts) from the dead predecessor id to the live one.
 *
 * Unlike the sibling recovery-brief read this is a WRITE, so it does NOT
 * fail-soft to ok:true — the hook needs the refusal/failure to surface the
 * manual one-call instruction instead of claiming success. `auth: 'loopback'`
 * — the hook runs on this box; agents elsewhere use coord:rebind-identity.
 */
import { defineTool } from '@papercusp/agent-mcp';
// The SessionStart recovery hook reaches this loopback route rather than the
// MCP tool wrapper. Wire the SU-lock side database here too, or a lock held by
// the predecessor remains stranded until TTL after an identity rebind.
import { rebindLockOwner } from '../../../agent-tools/locks/su-lock-store';

const rebind = defineTool({
  method: 'POST',
  path: '/agent-mcp/rebind-identity',
  auth: 'loopback',
  async handler(req) {
    let body: { from?: unknown; to?: unknown; force?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }
    const from = typeof body.from === 'string' ? body.from.trim() : '';
    const to = typeof body.to === 'string' ? body.to.trim() : '';
    if (!from || !to) return Response.json({ ok: false, error: 'from and to required' }, { status: 400 });
    try {
      const { rebindIdentity } = await import('../../../agent-tools/coordination/rebind-identity');
      const result = await rebindIdentity(from, to, { force: body.force === true, rebindLockOwner });
      return Response.json(result);
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  },
});

export default [rebind];
