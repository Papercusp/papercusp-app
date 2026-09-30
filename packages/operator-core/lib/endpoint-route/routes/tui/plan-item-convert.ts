/**
 * POST /api/tui/plan-item-convert — the pui CLAIM action: convert-at-pickup.
 *
 * The write half of the Plans-pane plan-item surface (plan-item-states.ts is
 * the read half). The RFC gate that deferred claim-from-TUI (P-005b) was
 * settled by project-centric-harness-rethink D-015: working a plan item =
 * convert it to a work_item first — so the TUI's pickup action IS
 * `plan_items:convert`, dispatched through the NORMAL projected-tool path
 * (audited; the tool's `emits:` fire — claim broadcast + the todo→wip flip —
 * exactly as they do for an agent pickup; the reflect rules later mirror the
 * work_item's completion back onto the plan item).
 *
 * Body: { owner, harness, plan, item, kind?, intent? } — `owner` is the pui
 * owner key (the same identity the sibling /api/tui/* routes scope on); it
 * becomes the claim's ownerId via ctx.uiClientId, so "who holds this item"
 * in plan-item-states lines up with the TUI user who clicked.
 *
 * `auth: 'loopback'` (auth-tier Wave 1) mirrors the sibling /api/tui/* routes, and like them the
 * handler explicitly gates on `isLoopbackRequest` (403 otherwise) — REQUIRED
 * here, not just convention: this route mints a wildcard-capability principal
 * with gateBypass from a body-supplied `owner`, so it must never be reachable
 * off-box even if the host bind changes.
 */
import { defineTool, lookupByMcpName, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { dispatchProjectedToolToMcp } from '@papercusp/tooldef-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { isLoopbackRequest } from '../../../superuser-token';
import { PROJECTED_DEPS } from '../../../projected-tool-deps';
import { activeWorkspaceId } from '../../../workspace-registry';

const CONVERT_TOOL = 'plan_items:convert';

interface ConvertBody {
  owner?: string;
  harness?: string;
  plan?: string;
  item?: string;
  kind?: string;
  intent?: string;
}

export default defineTool({
  method: 'POST',
  path: '/tui/plan-item-convert',
  auth: 'loopback',
  async handler(req) {
    if (!isLoopbackRequest(req.headers)) {
      return Response.json({ error: 'loopback_required' }, { status: 403 });
    }
    const body = (await req.json().catch(() => null)) as ConvertBody | null;
    const owner = body?.owner?.trim();
    const plan = body?.plan?.trim();
    const item = body?.item?.trim();
    if (!owner) return Response.json({ error: 'owner_required: pass body.owner (the pui owner id)' }, { status: 400 });
    if (!plan) return Response.json({ error: 'plan_required' }, { status: 400 });
    if (!item) return Response.json({ error: 'item_required' }, { status: 400 });

    const projected = lookupByMcpName(CONVERT_TOOL);
    if (!projected) {
      return Response.json({ error: `tool ${CONVERT_TOOL} not registered` }, { status: 500 });
    }

    const workspaceId = activeWorkspaceId();
    const result = await withWorkspace(workspaceId, async (tx) => {
      // The pui loopback caller acts as the operator role (in the tool's
      // COORD_ROLES), attributed to the pui owner via uiClientId — the same
      // identity scheme the rest of /api/tui/* persists under. Capability +
      // quota are bypassed (human-initiated loopback, like the palette
      // invoke); the role gate stays enforced and the call is audited.
      const ctx: UnifiedToolContext = {
        workspaceId,
        harnessSlug: body?.harness?.trim() || '*',
        role: 'operator',
        featureId: null,
        chunkId: null,
        runId: globalThis.crypto.randomUUID(),
        spawnId: 'pui-workbench',
        parentSpawnId: null,
        uiClientId: owner,
        isSuperuser: false,
        gateBypass: { capability: true, quota: true },
        profile: 'engineer',
        transport: 'http',
        log: () => {},
        progress: () => {},
        emit: () => {},
        signal: new AbortController().signal,
        tx,
        principal: { slug: `pui:${owner}`, workspaceId, capabilities: new Set(['*']) },
      };
      return dispatchProjectedToolToMcp(
        projected,
        CONVERT_TOOL,
        {
          plan,
          item,
          ...(body?.harness?.trim() ? { harness: body.harness.trim() } : {}),
          ...(body?.kind?.trim() ? { kind: body.kind.trim() } : {}),
          ...(body?.intent?.trim() ? { intent: body.intent.trim() } : {}),
        },
        ctx,
        PROJECTED_DEPS,
      );
    });

    // Unwrap the MCP-shaped result to the tool's JSON payload for the TUI.
    const content = (result as { content?: Array<{ text?: string }> })?.content;
    const text = Array.isArray(content) ? content[0]?.text : undefined;
    if (typeof text === 'string') {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        // plan_items:convert is dual-arity (bulk-endpoint-standardization-2026-06-21
        // P-004): a single-item dispatch returns the keyed-array envelope
        // { ok, results:[one], counts }. Flatten the single result back so the TUI
        // keeps reading the flat { ok, status, workItem?, planItem? } convert shape.
        const results = parsed.results;
        const single =
          Array.isArray(results) && results.length === 1 && parsed.counts && typeof parsed.counts === 'object'
            ? (results[0] as Record<string, unknown>)
            : parsed;
        return Response.json(single);
      } catch {
        return Response.json({ ok: false, error: text });
      }
    }
    return Response.json({ ok: false, error: 'empty tool result' }, { status: 500 });
  },
});
