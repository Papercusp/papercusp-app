/**
 * POST /api/agent-mcp/p2p-grant-set — the owner write path for the Peers
 * capability matrix (p2p-work-distribution-2026-07-02 P-002 UI over the P-001
 * grant store).
 *
 * Thin wrapper over p2p/grant-store's setPeerGrant / revokePeerGrant (which own
 * ALL enforcement semantics: C3 workspace resolution, X6 grantor epochs, M16
 * downgrade-as-revocation). The GRANTOR is always the LOCAL resolved identity
 * (resolveUsageActor — X9 numeric GitHub id); the desktop owner surface cannot
 * issue grants as anyone else. Presets expand server-side via expandPreset so
 * the stored capabilities never drift from the preset label. Store refusals
 * ({ok:false, refusal}) surface verbatim — loud, never silently dropped (D-004).
 *
 * Loopback-only + owner authority (the trust-set / p2p-settings-set shape).
 * Fires the args-scoped notifySyncInvalidate('p2p.grants', {potSlug}) — the
 * page subscribes with the same {potSlug} args.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { isLoopbackRequest } from '../../../superuser-token';

interface Body {
  action?: unknown;
  potSlug?: unknown;
  granteeKind?: unknown;
  granteeRef?: unknown;
  preset?: unknown;
  capabilities?: unknown;
  wakeRateCapPerHour?: unknown;
  excludedDevicePubkeys?: unknown;
  note?: unknown;
}

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/p2p-grant-set',
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

    const action = body.action === 'set' || body.action === 'revoke' ? body.action : null;
    if (!action) return Response.json({ ok: false, error: 'missing_action' }, { status: 400 });

    const potSlug = typeof body.potSlug === 'string' ? body.potSlug.trim() : '';
    const granteeRef = typeof body.granteeRef === 'string' ? body.granteeRef.trim() : '';
    if (!potSlug || !granteeRef) {
      return Response.json({ ok: false, error: 'missing_hive_or_grantee' }, { status: 400 });
    }

    try {
      const caps = await import('../../../p2p/capabilities');
      if (!caps.isP2pGranteeKind(body.granteeKind)) {
        return Response.json({ ok: false, error: 'invalid_grantee_kind' }, { status: 400 });
      }
      const granteeKind = body.granteeKind;

      // The grantor is ALWAYS the local resolved identity (X9) — never caller-supplied.
      const { resolveUsageActor } = await import('../../../harness/usage-actor');
      const actor = await resolveUsageActor().catch(() => null);
      if (!actor) {
        return Response.json(
          {
            ok: false,
            error: 'identity_unresolved',
            detail:
              'No local GitHub identity/device key — grants are keyed by the numeric GitHub user id and cannot be issued anonymously.',
          },
          { status: 400 },
        );
      }

      const { activeWorkspaceId } = await import('../../../workspace-registry');
      const ws = activeWorkspaceId();
      const store = await import('../../../p2p/grant-store');

      let result;
      if (action === 'revoke') {
        result = await store.revokePeerGrant({
          workspaceId: ws,
          potSlug,
          grantorGithubUserId: actor.githubUserId,
          granteeKind,
          granteeRef,
        });
      } else {
        // Preset expands server-side; explicit capabilities may extend it.
        const preset = caps.isP2pPresetName(body.preset) ? body.preset : null;
        const explicit = Array.isArray(body.capabilities)
          ? body.capabilities.filter((c): c is string => typeof c === 'string')
          : [];
        const normalized = caps.normalizeCapabilities([
          ...(preset ? caps.expandPreset(preset) : []),
          ...explicit,
        ]);
        if (!normalized.ok) {
          // Loud refusal naming the exact invalid capabilities (D-004 — no silent drops).
          return Response.json(
            { ok: false, error: 'invalid_capabilities', detail: `unknown capabilities: ${normalized.invalid.join(', ')}` },
            { status: 400 },
          );
        }
        const capabilities = normalized.capabilities;
        if (capabilities.length === 0) {
          return Response.json({ ok: false, error: 'no_capabilities' }, { status: 400 });
        }
        const wakeCap =
          typeof body.wakeRateCapPerHour === 'number' && Number.isFinite(body.wakeRateCapPerHour)
            ? Math.max(0, Math.round(body.wakeRateCapPerHour))
            : null;
        result = await store.setPeerGrant({
          workspaceId: ws,
          potSlug,
          grantorGithubUserId: actor.githubUserId,
          granteeKind,
          granteeRef,
          capabilities,
          preset,
          wakeRateCapPerHour: wakeCap,
          excludedDevicePubkeys: Array.isArray(body.excludedDevicePubkeys)
            ? body.excludedDevicePubkeys.filter((p): p is string => typeof p === 'string')
            : [],
          note: typeof body.note === 'string' ? body.note.trim().slice(0, 500) || null : null,
        });
      }

      if (!result.ok) {
        // Store refusal — surface verbatim (loud refusals, D-004), a 409 not a 500.
        return Response.json({ ok: false, error: result.refusal.code, detail: result.refusal.detail }, { status: 409 });
      }

      // P-106: revoking (or downgrading, M16) a host→fleet grant WITHDRAWS CONSENT —
      // reap this host's in-flight foreign sessions for that fleet (fail-close to
      // 'reaped' + refusal receipt). Loud on failure and never swallowed: a revoked
      // peer left running is a security hole. Only fleet grants map to foreign
      // sessions (p2p_foreign_workspaces.fleet_slug); pool grants have no such rows.
      let reap: { reaped: number; receiptFailures: number } | { error: string } | undefined;
      if (action === 'revoke' && granteeKind === 'fleet') {
        try {
          const { reapForeignSessionsForRevocation } = await import('../../../p2p/revocation-reaper');
          const r = await reapForeignSessionsForRevocation({
            workspaceId: ws,
            potSlug,
            responderGithubUserId: actor.githubUserId,
            trigger: { kind: 'grant-revoked', fleetSlug: granteeRef },
            actor: `p2p-grant-set:${actor.githubUserId}`,
          });
          reap = r.ok ? { reaped: r.reaped.length, receiptFailures: r.receiptFailures } : { error: r.refusal.code };
        } catch (err) {
          reap = { error: (err as Error)?.message ?? 'reap_failed' };
        }
      }

      // Args-scoped subscription ({potSlug}) → args-scoped invalidate with the SAME args.
      const { notifySyncInvalidate } = await import('../../../sync-sse');
      await notifySyncInvalidate('p2p.grants', { potSlug }).catch(() => {});

      return Response.json({ ok: true, action, grant: result.grant, ...(reap ? { reap } : {}) });
    } catch (err) {
      return Response.json(
        { ok: false, error: (err as Error)?.message ?? 'p2p_grant_set_failed' },
        { status: 400 },
      );
    }
  },
});
