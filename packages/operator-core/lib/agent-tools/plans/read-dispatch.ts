/**
 * In-process dispatch of the plans:* READ tools.
 *
 * Shared by the two server surfaces that need the EXACT same canonical
 * read logic (file-based plan reads) so they can't drift:
 *   - `/api/admin/plans/:verb` GET — the verified-admin Plans UI surface.
 *   - the `@papercusp/sync` named-query resolvers (`plans.*` live queries
 *     in apps/operator/lib/sync-resolver) consumed by `useSyncQuery`.
 *
 * Both synthesize a superuser ctx (`?superuser=1` + validateSuperuser),
 * which is safe because the operator host is loopback-bound — the same
 * security model the rest of `/admin/*` + the public rest-query endpoint
 * already rely on.
 */
import { handleHttpToolRequest, type HttpToolHostExtras } from '@papercusp/agent-mcp';
// Side-effect: register operator-side first-party tools (defineTool calls),
// including all plans:* tools. Same import the agent-tools catch-all uses.
import '../index';
import { PROJECTED_DEPS } from '../../projected-tool-deps';

const ADMIN_UI_CLIENT_ID = 'pc-admin-plans-ui';

const HOST_EXTRAS: HttpToolHostExtras = {
  deps: PROJECTED_DEPS,
  log: () => {},
  validateSuperuser: () => true,
};

export interface PlansReadResult {
  status: number;
  /** Unwrapped JSON (the tool's text envelope, parsed) on 200; the raw
   *  tool error body otherwise. */
  data: unknown;
}

/**
 * Dispatch a plans READ verb in-process. Never throws — non-200 surfaces
 * via `status` + `data` (the tool's error envelope). The admin route uses
 * this to build its `Response`.
 */
export interface PlansReadOpts {
  /**
   * Apply the UI display projection (ui-read-projection.ts). Default true.
   *
   * Pass `false` for a DETAIL read that must see the fields the list feed
   * drops — `plans.attentionItem` is the one caller: the list feed clips each
   * attention item's `body` but deliberately keeps `actions` so the selected
   * row's controls render before detail hydration; the detail pane still needs
   * the full body back (slim-plans-attention-sync-payload-2026-07-26 P-004).
   * This is NOT a way to opt out of the payload-tier ceiling — that is
   * `payloadTier` above, and it stays `'full'` either way.
   */
  uiProjection?: boolean;
}

export async function callPlansReadRaw(
  verb: string,
  body: Record<string, unknown>,
  opts?: PlansReadOpts,
): Promise<PlansReadResult> {
  const sp = new URLSearchParams();
  sp.set('superuser', '1');
  sp.set('client', ADMIN_UI_CLIENT_ID);
  const b: Record<string, unknown> = { ...body };
  // PlanDetail needs the complete document/CAS fields, but does not display
  // descendant execution history. That fresh enrichment lives outside the
  // plan-body cache and otherwise delays even a warm popup read. Keep an
  // explicit history request intact; MCP/agent reads do not use this seam.
  if (verb === 'get' && b.includeHistory == null) b.includeHistory = false;
  // /adv shows the ACTIVE workspace's plans. The cross-plan `list` verb defaults
  // to the workspace-wide listing (workspace-data-isolation-leaks F-A1) instead
  // of the harness:'all' wildcard (→ papercup/papercusp-workspace), which leaked
  // papercup's plans into every other workspace. Other verbs target a specific
  // plan (the UI passes its harness), so they keep the 'all' → papercup default.
  if (verb === 'list' && b.harness == null && b.harness_slugs == null && b.workspaceWide == null) {
    b.workspaceWide = true;
  } else if (b.harness == null) {
    b.harness = 'all';
  }
  // The UI reads FULL payloads: this in-process dispatch feeds the admin Plans
  // routes + the @papercusp/sync resolvers (no model-context budget, no MCP
  // result cap). Without the EXPLICIT per-call escape hatch, the payload-tier
  // HARD CEILING force-trims any >30KB shaper-tool result — plans:attention
  // (~1.1MB) came back as item-less group summaries, which the UI's
  // normalizeAttentionGroups dropped entirely, blanking the Queue / Overview
  // needs-you / sidebar Inbox (WI-5078). A caller that wants a shaped read can
  // still pass its own payloadTier.
  if (b.payloadTier == null) b.payloadTier = 'full';
  const result = await handleHttpToolRequest(
    {
      method: 'POST',
      pathname: `/api/agent-tools/plans/${verb}`,
      searchParams: sp,
      headers: {},
      body: b,
    },
    HOST_EXTRAS,
  );
  if (result.status === 200) {
    const rb = result.body as { content?: Array<{ type: string; text?: string }> };
    const text = rb.content?.find((c) => c.type === 'text')?.text;
    if (text !== undefined) {
      try {
        // UI-only display projection (whole-app-sync-payload-audit P-005, extended
        // to `attention` by slim-plans-attention-sync-payload-2026-07-26 P-003):
        // slim the fat scan-list payloads (plans:list/items/attention) to the
        // display shape — clip preview text + drop non-display blobs. get/etc.
        // pass through unchanged; agent/MCP sessions never reach callPlansReadRaw,
        // so the agent shapers are untouched. See ui-read-projection.ts.
        const parsed: unknown = JSON.parse(text);
        if (opts?.uiProjection === false) return { status: 200, data: parsed };
        const { projectPlansReadForUi } = await import('./ui-read-projection');
        return { status: 200, data: projectPlansReadForUi(verb, parsed) };
      } catch {
        return { status: 200, data: text };
      }
    }
    return { status: 200, data: {} };
  }
  return { status: result.status, data: result.body };
}

/**
 * Resolver convenience: dispatch a read and THROW on non-200 (the
 * rest-query route maps the throw to HTTP 500). Returns the unwrapped
 * JSON object (e.g. `{ plans: [...] }`).
 */
export async function callPlansRead(
  verb: string,
  body: Record<string, unknown>,
  opts?: PlansReadOpts,
): Promise<unknown> {
  const r = await callPlansReadRaw(verb, body, opts);
  if (r.status !== 200) {
    const err = (r.data as { error?: unknown } | null)?.error;
    // The HTTP dispatcher returns { error: { code, message } }. Preserve its
    // explanation so a rejected query cannot collapse to an opaque status
    // (WI-2147274: an older server rejected the popup's ownerAgentId argument).
    const message = typeof err === 'object' && err !== null && 'message' in err ? err.message : err;
    throw new Error(typeof message === 'string' ? message : `plans:${verb} → ${r.status}`);
  }
  return r.data;
}
