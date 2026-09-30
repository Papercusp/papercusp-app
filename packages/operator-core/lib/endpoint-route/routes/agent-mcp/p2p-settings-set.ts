/**
 * POST /api/agent-mcp/p2p-settings-set — the owner write path for the P2P
 * work-sharing settings surface (p2p-work-distribution-2026-07-02 P-002).
 *
 * The /settings/p2p page writes through this dedicated loopback route (the
 * trust-set / autonomy-policy-set shape): thin wrapper over the p2p/settings
 * store, plus the sync invalidation so the page refreshes. Actions:
 *
 *   set             — merge a sanitized patch into one layer
 *                     ('default' = workspace-DEFAULT, 'workspace' = the
 *                     current-workspace OVERRIDE)
 *   clear-layer     — remove a stored layer (reverts to the layer below)
 *   kill-switch     — engage/disengage the GLOBAL pause-all-foreign-work
 *                     switch (M10/X13 semantics live in the store contract).
 *                     AUDITED: an audit_log row per flip — the kill-switch is
 *                     an owner-authority action whose history must be
 *                     reconstructable (P-002 Audit section reads it back).
 *   starter-profile — m18 one-click adoption preset onto the workspace layer
 *                     (audited too: it flips the host from inert to accepting).
 *
 * Loopback-only + owner authority (the desktop owner surface is the only
 * caller). Never ARMS anything by itself: accepting foreign work additionally
 * requires grants (P-001) + the tier flag (P-005) — this surface is the host's
 * local opt-in half.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { isLoopbackRequest } from '../../../superuser-token';

interface Body {
  action?: unknown;
  layer?: unknown;
  patch?: unknown;
  engage?: unknown;
  reason?: unknown;
}

const ACTIONS = ['set', 'clear-layer', 'kill-switch', 'starter-profile'] as const;
type Action = (typeof ACTIONS)[number];

/** Fire-safe audit append (the recordTrustAudit shape — full-column, never blocks
 *  the write it describes). Actions are `p2p:*`-prefixed so the P-002 Audit
 *  section (and later P-004's p2p:trace) can filter the ledger by prefix. */
async function recordP2pAudit(
  action: string,
  subject: string,
  workspaceId: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const id = `p2p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await sql`
      INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
      VALUES (${id}, ${Date.now()}, ${'owner'}, ${action}, ${subject},
              ${JSON.stringify(details)}::text::jsonb, ${workspaceId})`;
  } catch (err) {
    console.warn('[p2p-settings-set] audit write failed:', (err as Error)?.message);
  }
}

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/p2p-settings-set',
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

    const action = ACTIONS.includes(body.action as Action) ? (body.action as Action) : null;
    if (!action) {
      return Response.json({ ok: false, error: 'missing_action' }, { status: 400 });
    }

    const { activeWorkspaceId } = await import('../../../workspace-registry');
    const ws = activeWorkspaceId();

    try {
      const store = await import('../../../p2p/settings');
      let layers;

      if (action === 'set' || action === 'clear-layer') {
        const layer = body.layer === 'default' || body.layer === 'workspace' ? body.layer : null;
        if (!layer) {
          return Response.json({ ok: false, error: 'invalid_layer' }, { status: 400 });
        }
        layers = await store.writeP2pSettings({
          workspaceId: ws,
          layer,
          patch: action === 'clear-layer' ? null : store.sanitizeP2pSettingsPatch(body.patch),
        });
      } else if (action === 'kill-switch') {
        if (typeof body.engage !== 'boolean') {
          return Response.json({ ok: false, error: 'missing_engage' }, { status: 400 });
        }
        const reason =
          typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) || null : null;
        layers = await store.setP2pKillSwitch({ workspaceId: ws, engage: body.engage, reason });
        await recordP2pAudit(
          body.engage ? 'p2p:kill-switch:engage' : 'p2p:kill-switch:disengage',
          'p2p-foreign-work',
          ws,
          {
            reason,
            windDownGraceSec: layers.effective.killSwitch.windDownGraceSec,
          },
        );
      } else {
        // starter-profile (m18)
        layers = await store.writeP2pSettings({
          workspaceId: ws,
          layer: 'workspace',
          patch: store.P2P_STARTER_PROFILE,
        });
        await recordP2pAudit('p2p:starter-profile:apply', 'p2p-foreign-work', ws, {
          profile: store.P2P_STARTER_PROFILE,
        });
      }

      // The page reads `p2p.settings` via useSyncQuery with NO args → name-only
      // invalidate (an args-scoped emit would never match — adding-a-sync-query gotcha).
      const { notifySyncInvalidate } = await import('../../../sync-sse');
      await notifySyncInvalidate('p2p.settings').catch(() => {});

      return Response.json({ ok: true, workspaceId: ws, action, layers });
    } catch (err) {
      return Response.json(
        { ok: false, error: (err as Error)?.message ?? 'p2p_settings_set_failed' },
        { status: 400 },
      );
    }
  },
});
