/**
 * /api/discovery/beacon-consent — the HTTP face of the per-Hive beacon-publish
 * consent (hive-network-surface-2026-06-11 P-005, brief B-07; contract C-2).
 *
 *   GET  ?potId=<slug>        → { ok, potId, consent }   (absent = false, D-002)
 *   POST { potId, consent }   → { ok, potId, consent }
 *
 * The desktop hive header strip's beacon toggle drives this — the secondary
 * surface for the publish-flow consent question. Writes route through the shared
 * `beacon-consent` accessor so the value federates to every Swarm of the Hive.
 *
 * `auth: 'loopback'` (auth-tier Wave 1), exactly like /discovery/set-pot — the
 * desktop webview is cookie-less and the loopback bind is the perimeter.
 */
import { defineTool } from '@papercusp/agent-mcp';

const getBeaconConsent = defineTool({
  method: 'GET',
  path: '/discovery/beacon-consent',
  auth: 'loopback',
  async handler(req) {
    const potId = String(new URL(req.url).searchParams.get('potId') ?? '').trim();
    if (!potId) {
      return Response.json({ error: 'potId required', code: 'invalid_args' }, { status: 400 });
    }
    const { getBeaconPublishConsent } = await import('../../../beacon-consent');
    const { activeWorkspaceId } = await import('../../../workspace-registry');
    const consent = await getBeaconPublishConsent(activeWorkspaceId(), potId).catch(() => false);
    return Response.json({ ok: true, potId, consent });
  },
});

const setBeaconConsent = defineTool({
  method: 'POST',
  path: '/discovery/beacon-consent',
  auth: 'loopback',
  async handler(req) {
    let body: { potId?: string; consent?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      /* empty body */
    }
    const potId = String(body.potId ?? '').trim();
    if (!potId) {
      return Response.json({ error: 'potId required', code: 'invalid_args' }, { status: 400 });
    }
    if (typeof body.consent !== 'boolean') {
      return Response.json(
        { error: 'consent must be a boolean', code: 'invalid_args' },
        { status: 400 },
      );
    }
    const { setBeaconPublishConsent } = await import('../../../beacon-consent');
    const { activeWorkspaceId } = await import('../../../workspace-registry');
    try {
      await setBeaconPublishConsent(activeWorkspaceId(), potId, body.consent);
    } catch (e) {
      // setHiveSetting rejects when the hive doesn't exist (logical scope, no FK).
      const msg = e instanceof Error ? e.message : String(e);
      const notFound = /no Hive/.test(msg);
      return Response.json(
        { error: msg, code: notFound ? 'hive_not_found' : 'set_failed' },
        { status: notFound ? 404 : 502 },
      );
    }
    return Response.json({ ok: true, potId, consent: body.consent });
  },
});

export default [getBeaconConsent, setBeaconConsent];
