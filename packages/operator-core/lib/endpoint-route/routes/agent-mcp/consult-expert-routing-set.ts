/**
 * POST /api/agent-mcp/consult-expert-routing-set — the owner write path for the
 * consult expert-routing settings surface (consult-expert-routing-2026-09-22 P-006).
 *
 * The /settings/expert-routing page writes through this dedicated loopback route
 * (the trust-set / p2p-settings-set shape): a thin wrapper over
 * consult/expert-routing-settings, plus the sync invalidation so the page
 * refreshes from the value that was actually persisted.
 *
 * ⚠ THIS ROUTE MERGES; `writeConsultExpertRoutingSettings` DOES NOT.
 * That writer takes a `Partial<ConsultExpertRoutingSettings>` but normalizes a
 * MISSING field to the SEED — `normalizeExpertModelAllowlist(undefined)` returns
 * `[]`, which `normalizeConsultExpertRoutingSettings` then replaces with the
 * seeded allowlist. So a naive "just forward the patch" handler would let an edit
 * that touches ONLY the half-life silently reset the owner's whole ranked
 * allowlist back to fable/opus/sol/astra. The partial shape is deliberate (it is
 * what makes every read total — see that module's header), so the merge belongs
 * HERE, at the one caller that has a patch rather than a whole value: read the
 * current settings, apply only the fields the body actually carried, write the
 * complete object.
 *
 * RANK IS POSITIONAL. The body's `allowlist` is an ORDERED array and this route
 * assigns `rank = index + 1` from it, ignoring any client-sent rank. Order is the
 * policy (D-004) and the wire should carry it exactly once; letting a client send
 * both an order and a disagreeing rank field creates a conflict with no correct
 * resolution.
 *
 * Loopback-only + owner authority (the desktop owner surface is the only caller).
 */
import { defineTool } from '@papercusp/agent-mcp';
import { isLoopbackRequest } from '../../../superuser-token';

interface Body {
  allowlist?: unknown;
  recencyHalfLifeDays?: unknown;
}

/** One wire row of the ranked allowlist. `rank` is positional — see the header. */
function readAllowlistRows(raw: unknown): Array<{ agent: string; model: string }> | null {
  if (!Array.isArray(raw)) return null;
  return raw.map((row) => {
    const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
    return { agent: String(r.agent ?? ''), model: String(r.model ?? '') };
  });
}

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/consult-expert-routing-set',
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

    // Presence, not truthiness: `recencyHalfLifeDays: 0` and an empty allowlist are
    // both *sent* values the normalizer must get a chance to reject/clamp, and
    // treating them as "absent" would silently keep the stored value instead.
    const hasAllowlist = Object.prototype.hasOwnProperty.call(body, 'allowlist');
    const hasHalfLife = Object.prototype.hasOwnProperty.call(body, 'recencyHalfLifeDays');
    if (!hasAllowlist && !hasHalfLife) {
      return Response.json({ ok: false, error: 'empty_patch' }, { status: 400 });
    }

    const rows = hasAllowlist ? readAllowlistRows(body.allowlist) : null;
    if (hasAllowlist && rows === null) {
      return Response.json({ ok: false, error: 'invalid_allowlist' }, { status: 400 });
    }

    try {
      const { activeWorkspaceId } = await import('../../../workspace-registry');
      const ws = activeWorkspaceId();
      const store = await import('../../../consult/expert-routing-settings');

      // The merge the writer cannot do for us — see the header.
      const current = await store.readConsultExpertRoutingSettings(ws);
      const settings = await store.writeConsultExpertRoutingSettings(
        {
          allowlist: rows
            ? rows.map((row, index) => ({
                rank: index + 1,
                agent: row.agent as never,
                model: row.model,
              }))
            : current.allowlist,
          recencyHalfLifeDays: hasHalfLife
            ? Number(body.recencyHalfLifeDays)
            : current.recencyHalfLifeDays,
        },
        ws,
      );

      // The page reads `consult.expertRouting` via useSyncQuery with NO args →
      // name-only invalidate (an args-scoped emit would never match — the
      // adding-a-sync-query gotcha).
      const { notifySyncInvalidate } = await import('../../../sync-sse');
      await notifySyncInvalidate('consult.expertRouting').catch(() => {});

      return Response.json({ ok: true, workspaceId: ws, settings });
    } catch (err) {
      return Response.json(
        { ok: false, error: (err as Error)?.message ?? 'consult_expert_routing_set_failed' },
        { status: 400 },
      );
    }
  },
});
