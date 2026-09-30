/**
 * POST /api/agent-mcp/context-epoch-bump?owner=<sid>&source=<startup|resume|clear>
 *
 * P-005 of plan `owner-directive-delivery-redesign-2026-09-22`: every context
 * wipe starts a new DELIVERY epoch. The turn-start orientation — and the open
 * owner directives it carries — is suppressed only while "you were already
 * told" is true, and that is true only inside the context it was told into.
 * The cursor is keyed on `memory_session_epochs.epoch` for exactly that reason
 * (P-023 / D-008 of the turn-start plan).
 *
 * `compact` already bumps it: the SessionStart[source=compact] hook fetches
 * session-recovery-brief, whose re-prime bumps first. The other SessionStart
 * sources did not, so after `/clear`, a `--resume` relaunch, or a fresh process
 * under a reused session id, an UNCHANGED directive set stayed suppressed for
 * a context that had never seen it. The recovery hook calls this for those
 * three sources.
 *
 * Fail-soft by contract: a failed bump answers `{ ok: true, epoch: null }` and
 * degrades to the prior behavior. A hook must never surface an error into a
 * session start. `auth: 'loopback'` — the hook runs on this box.
 */
import { defineTool } from '@papercusp/agent-mcp';

const contextEpochBump = defineTool({
  method: 'POST',
  path: '/agent-mcp/context-epoch-bump',
  auth: 'loopback',
  async handler(req) {
    const owner = (new URL(req.url).searchParams.get('owner') ?? '').trim();
    if (!owner) return Response.json({ ok: false, error: 'owner required' }, { status: 400 });
    try {
      const [{ getOrgPg }, { bumpSessionEpoch }] = await Promise.all([
        import('@papercusp/db-org'),
        import('../../../memory/session-epoch-ledger'),
      ]);
      const epoch = await bumpSessionEpoch(getOrgPg().sql, owner);
      return Response.json({ ok: true, epoch });
    } catch {
      return Response.json({ ok: true, epoch: null });
    }
  },
});

export default [contextEpochBump];
