/**
 * POST /api/agent-mcp/p2p-allotment-set — the owner write path for the /res
 * Resources board (p2p-work-distribution-2026-07-02 P-201).
 *
 * The /res page writes through this dedicated loopback route (the
 * p2p-settings-set shape). Since agent-allocation-framework-2026-07-03 P-002
 * (D-004) the route is a thin wrapper over the SHARED delegation core
 * (`delegateResource` in agent-tools/resource/delegate.ts) — the same core the
 * `resource:delegate` MCP tool runs — so the UI and agents cannot drift apart:
 * loopback wraps the tool core; the tool core wraps the store. Actions:
 *
 *   set    — upsert an allotment: a host hands a resource (an account pool =
 *            remote axis, a local GPU = local axis, or agent_slot SEATS =
 *            count-capped) to a fleet. Re-setting the same (fleet, kind, ref)
 *            UPDATES the cap (PK upsert), so the /res writes are idempotent.
 *   remove — revoke a fleet's draw on a resource (the /res chip's ×).
 *
 * Loopback-only + owner authority (the desktop /res surface is the only
 * caller). Allotments are LOCAL/per-machine (M19) — never federated. The STORE
 * owns all field validation + the refusal shapes; the core passes them through
 * and this route maps a refusal → 400 { error: refusal.code, detail }. The
 * core also fires the p2p.allotments sync invalidate (name-only) on success.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { isLoopbackRequest } from '../../../superuser-token';

interface Body {
  action?: unknown;
  fleetSlug?: unknown;
  /** P-001: the pot-scoped grantee — mutually exclusive with fleetSlug. */
  potSlug?: unknown;
  /** P-001/D-002: required iff potSlug is set. */
  audience?: unknown;
  resourceKind?: unknown;
  resourceRef?: unknown;
  sharePct?: unknown;
  /** agent_slot seats (D-002 count cap) — the P-003 UI POSTs `quantity` (the store
   *  column name); `count` (the D-004 tool arg name) is accepted as an alias. */
  quantity?: unknown;
  count?: unknown;
  /** agent_slot trio — explicit fields win over axis-carried values in the core. */
  model?: unknown;
  effort?: unknown;
  account?: unknown;
  axis?: unknown;
  status?: unknown;
}

const ACTIONS = ['set', 'remove'] as const;
type Action = (typeof ACTIONS)[number];

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/p2p-allotment-set',
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
      const { delegateResource } = await import('../../../agent-tools/resource/delegate');

      // action === 'set' — resolve the setting host's numeric GitHub id (X9:
      // display/audit only; the resource is this machine's). Best-effort → null.
      let createdByGithubUserId: number | null = null;
      if (action === 'set') {
        try {
          const { resolveUsageActor } = await import('../../../harness/usage-actor');
          createdByGithubUserId = (await resolveUsageActor().catch(() => null))?.githubUserId ?? null;
        } catch {}
      }

      // Pass identity fields through — the store validates the grantee (exactly
      // one of fleetSlug/potSlug) + kind and returns typed refusals
      // (grantee_required / grantee_conflict / audience_required /
      // resource_required / invalid_resource_kind / …).
      const result = await delegateResource({
        workspaceId: ws,
        fleetSlug: str(body.fleetSlug),
        potSlug: str(body.potSlug),
        audience: body.audience === 'trusted-members' || body.audience === 'whole-pot' ? body.audience : undefined,
        kind: typeof body.resourceKind === 'string' ? body.resourceKind : '',
        ref: str(body.resourceRef),
        // NaN when absent/non-numeric → the store's invalid_share_pct refusal (account/gpu).
        sharePct: typeof body.sharePct === 'number' ? body.sharePct : undefined,
        count:
          typeof body.quantity === 'number'
            ? body.quantity
            : typeof body.count === 'number'
              ? body.count
              : undefined,
        model: str(body.model),
        effort: str(body.effort),
        account: str(body.account),
        axis:
          body.axis && typeof body.axis === 'object' && !Array.isArray(body.axis)
            ? (body.axis as Record<string, unknown>)
            : undefined,
        status: body.status === 'paused' ? 'paused' : body.status === 'active' ? 'active' : undefined,
        remove: action === 'remove',
        createdByGithubUserId,
      });

      if (!result.ok) {
        return Response.json(
          { ok: false, error: result.refusal.code, detail: result.refusal.detail },
          { status: 400 },
        );
      }
      return Response.json(
        result.action === 'remove'
          ? { ok: true, workspaceId: ws, action, removed: result.removed }
          : { ok: true, workspaceId: ws, action, allotment: result.allotment },
      );
    } catch (err) {
      return Response.json(
        { ok: false, error: (err as Error)?.message ?? 'p2p_allotment_set_failed' },
        { status: 400 },
      );
    }
  },
});
