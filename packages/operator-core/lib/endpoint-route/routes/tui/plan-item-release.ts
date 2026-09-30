/**
 * POST /api/tui/plan-item-release — the pui RELEASE action: put a picked-up
 * plan item back.
 *
 * The inverse of plan-item-convert.ts (the `:pickup` route), completing the
 * P-005b write surface (tui-workbench-ratatui-2026-06-04 P-010): claim AND
 * release from the pui. Which tool fires depends on what the pickup created
 * (`releaseDispatch`, unit-tested):
 *
 *   - The item was converted (an `implements`-linked, non-terminal work_item
 *     exists) → dispatch `work_items:release { id }` through the NORMAL
 *     projected-tool path. Its emits + the plan-item reflect rules then do the
 *     rest exactly as for an agent release: the item flips back to `todo`
 *     (plan-item-reflect:release) and the lease drops
 *     (plan-item-reflect:release-releases-lease).
 *   - No live work_item (a bare `plan_items:claim` lease, or the record is
 *     terminal) → dispatch `plan_items:release { plan, item }` — drop the
 *     lease only, no status flip (mirrors agent-side semantics: a bare lease
 *     drop never owned a wip flip).
 *
 * Identity: the caller acts as the pui owner (uiClientId), so the lease drop
 * resolves *their* claim — releasing an item whose lease a peer holds is the
 * same polite no-op it is for agents (the peer's lease lapses by TTL).
 *
 * `auth: 'loopback'` (auth-tier Wave 1) + explicit `isLoopbackRequest` gate — REQUIRED, not just
 * convention: like the convert route this mints a wildcard-capability
 * principal from a body-supplied `owner`, so it must never be reachable
 * off-box even if the host bind changes.
 */
import { defineTool, lookupByMcpName, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { dispatchProjectedToolToMcp } from '@papercusp/tooldef-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { isLoopbackRequest } from '../../../superuser-token';
import { PROJECTED_DEPS } from '../../../projected-tool-deps';
import { activeWorkspaceId } from '../../../workspace-registry';
import { findImplementingWorkItem, TERMINAL_WORK_ITEM_STATES } from '../../../plan-items/convert';

interface ReleaseBody {
  owner?: string;
  harness?: string;
  plan?: string;
  item?: string;
}

/** The slice of a work_item the dispatch decision reads (full WorkItem satisfies it). */
export interface ReleasableWorkItem {
  id: string;
  state: string;
  harness?: string | null;
}

export interface ReleaseDispatch {
  tool: 'work_items:release' | 'plan_items:release';
  args: Record<string, unknown>;
}

/**
 * Decide which release tool a put-back dispatches (pure — unit-tested):
 * a live (non-terminal) execution record is released as a work_item (reflect
 * rules flip the plan item + drop the lease); otherwise only the bare
 * plan-item lease is dropped.
 */
export function releaseDispatch(
  workItem: ReleasableWorkItem | null,
  scope: { harness?: string; plan: string; item: string },
): ReleaseDispatch {
  if (workItem && !TERMINAL_WORK_ITEM_STATES.has(workItem.state)) {
    return {
      tool: 'work_items:release',
      args: { id: workItem.id, ...(workItem.harness ? { harness: workItem.harness } : {}) },
    };
  }
  return {
    tool: 'plan_items:release',
    args: {
      plan: scope.plan,
      item: scope.item,
      ...(scope.harness ? { harness: scope.harness } : {}),
    },
  };
}

export default defineTool({
  method: 'POST',
  path: '/tui/plan-item-release',
  auth: 'loopback',
  async handler(req) {
    if (!isLoopbackRequest(req.headers)) {
      return Response.json({ error: 'loopback_required' }, { status: 403 });
    }
    const body = (await req.json().catch(() => null)) as ReleaseBody | null;
    const owner = body?.owner?.trim();
    const plan = body?.plan?.trim();
    const item = body?.item?.trim();
    if (!owner) return Response.json({ error: 'owner_required: pass body.owner (the pui owner id)' }, { status: 400 });
    if (!plan) return Response.json({ error: 'plan_required' }, { status: 400 });
    if (!item) return Response.json({ error: 'item_required' }, { status: 400 });

    const harness = body?.harness?.trim() || undefined;
    const workItem = await findImplementingWorkItem(plan, item);
    const dispatch = releaseDispatch(workItem, { harness, plan, item });

    const projected = lookupByMcpName(dispatch.tool);
    if (!projected) {
      return Response.json({ error: `tool ${dispatch.tool} not registered` }, { status: 500 });
    }

    const workspaceId = activeWorkspaceId();
    const result = await withWorkspace(workspaceId, async (tx) => {
      // Same identity scheme as the convert route: the pui loopback caller
      // acts as the operator role attributed to the pui owner via uiClientId,
      // capability + quota bypassed (human-initiated loopback), role gate
      // enforced, call audited — so the reflect rules' lease drop resolves
      // the same identity the pickup claimed under.
      const ctx: UnifiedToolContext = {
        workspaceId,
        harnessSlug: harness ?? '*',
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
      return dispatchProjectedToolToMcp(projected, dispatch.tool, dispatch.args, ctx, PROJECTED_DEPS);
    });

    // Unwrap the MCP-shaped result to the tool's JSON payload, stamped with
    // which path released so the TUI can phrase its toast.
    const content = (result as { content?: Array<{ text?: string }> })?.content;
    const text = Array.isArray(content) ? content[0]?.text : undefined;
    if (typeof text === 'string') {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        // BOTH dispatch targets are now dual-arity (bulk-endpoint-standardization-
        // 2026-06-21: work_items:release P-002, plan_items:release P-004): a
        // single-item dispatch returns the keyed-array envelope { ok, results:[one],
        // counts }. Flatten the single result back so this route's response (and the
        // TUI toast it feeds) keeps its { via, ok, workItem?/released?, error? } shape.
        const results = parsed.results;
        const single =
          Array.isArray(results) && results.length === 1 && parsed.counts && typeof parsed.counts === 'object'
            ? (results[0] as Record<string, unknown>)
            : parsed;
        return Response.json({ via: dispatch.tool, ...single });
      } catch {
        return Response.json({ ok: false, via: dispatch.tool, error: text });
      }
    }
    return Response.json({ ok: false, via: dispatch.tool, error: 'empty tool result' }, { status: 500 });
  },
});
