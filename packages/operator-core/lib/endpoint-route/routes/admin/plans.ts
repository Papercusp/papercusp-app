/**
 * /api/admin/plans/:verb — admin surface for the plans:* tools.
 *
 * Per D-009 of plans-admin-ui-2026-05-20.md, the Plans admin tab cannot
 * present an agent bearer token, so it gets its own admin-namespaced
 * routes that re-dispatch into the same defineTool handlers in-process
 * via `handleHttpToolRequest` — the exact mechanism the public
 * /api/agent-tools/* catch-all already uses in production.
 *
 * GET — the four read verbs (list / get / items / search / lint). Pure
 * filesystem reads; no principal needed.
 *
 * POST — the four assisted-write verbs (set-status / set-now /
 * add-decision / add-item) plus `new`. The body is a JSON envelope
 * passed as the tool's args. The tools themselves are
 * `requirePrincipal: false` and each owns its `locks:acquire`
 * internally (see with-plan-lock.ts), so no admin principal injection
 * is required at this layer — the admin gate on /api/admin/* is the
 * authorization story (loopback + admin-shell mount). The MCP
 * tool-result envelope ({ content: [{ type:'text', text }] }) is
 * unwrapped so client code gets clean shapes.
 */

import { handleHttpToolRequest } from '@papercusp/agent-mcp';
// Side-effect: register operator-side first-party tools (defineTool
// calls), including all plans:* tools. Same import the agent-tools
// catch-all uses.
import '../../../agent-tools/index';
// WI-5364: shared extras carry the runScoped seam so proxied handlers that use
// ctx.tx get a real DB handle instead of 500ing "ctx.tx is not a function".
import { ADMIN_PROXY_HOST_EXTRAS as HOST_EXTRAS } from './proxy-host-extras';
import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import { bodyFromSearchParams } from './_plans-args';
import { requireAllowedOriginOr403 } from '../../cors';
// papercusp-dogfood-v5 P-021 (server-side half): fire SSE invalidations
// on successful plan writes so any subscriber to `plans.*` queryNames
// refetches. Pairs with the existing `notifySyncInvalidate` →
// `sync_invalidate` channel + libs/sync SSEAdapter — same pattern as
// /api/toast-log uses for `toastLog.recent`. The client-side hook
// migration (useAsyncJson → useSyncQuery) is deferred until P-022
// (drop @rocicorp/zero), since useSyncQuery currently resolves
// queryNames through the @papercusp/zero-harness registry which is being
// retired alongside the @rocicorp/zero dep.
import { notifySyncInvalidate } from '../../../sync-sse';

const READ_VERBS = new Set([
  'list',
  'get',
  'items',
  'attention',
  'search',
  'lint',
  // plan-agent-launch P-017: the Revisions panel reads through here.
  'revisions',
  // plan-agent-launch P-018: the per-revision diff modal.
  'revision-diff',
  // plan-agent-launch P-019: the per-revision conversation drill-down.
  'revision-transcript',
  // plan-agent-launch P-021: the Agents tab's past-runs list.
  'runs',
  // plan-agent-launch P-023: the run-detail view's transcript.
  'run-transcript',
  // plan-structured-inputs P-013: the inputs panel reads the plan's schema,
  // its current values, and the start verdict through one verb.
  'get-input-schema',
]);
// `set-content` and `set-frontmatter` land in agent-plan-tracking
// Phase 5 (D-011 of plans-admin-ui-2026-05-20). Listing them now means
// the route is ready the instant the tools register — until then a
// call dispatches to handleHttpToolRequest and returns a clean 404
// `unknown_tool`, which the UI surfaces as a normal save error.
//
// NOTE: the frontmatter writer is `set-frontmatter` (promotes a legacy
// plan to have valid frontmatter). `plans:promote` (coordination tool)
// promotes a plan INTO a harness — creating features. Both are intentionally
// exposed here under different verbs ('set-frontmatter' vs 'promote').
const WRITE_VERBS = new Set([
  'set-status', 'set-importance', 'set-now', 'add-decision', 'add-item', 'new',
  'set-content', 'set-frontmatter',
  // plan-level lifecycle flip (approve/demote/ship/reject) — plans:set-plan-status.
  'set-plan-status',
  // plan-feature-pipeline-unification P-016: promote a plan into a harness
  // as features — calls coordination/tools/promote.ts (plans:promote tool).
  'promote',
  // plan-feature-pipeline-unification P-019: parse + apply a ```promote:plan
  // fenced block emitted by the architect; creates a new draft plan via
  // plans:new → plans:set-now → plans:add-item × N → plans:add-decision × N.
  'apply-plan-block',
  // plan-agent-launch P-022: the Agents-tab Launch button — admin
  // calls it with `await: false` so the POST returns immediately
  // and the turn runs fire-and-forget (UI polls `plans:runs` for
  // status updates).
  'launch',
  // plan-agent-launch P-024: the run-detail Continue form — same
  // `await: false` shape as 'launch'.
  'resume',
  // plans-central-harness-ux P-003: operational start/pause via harness_plans.op_status.
  'start', 'pause',
  // dbos-system-completion P-045: drag-to-reorder priority for the frontier dispatcher.
  'set-priority',
  // owner-plans-single-pane P-008 / EI-15304: the Plans face's stale-plan
  // sweep archives (or restores) a plan — plans:set-archived.
  'set-archived',
  // plan-structured-inputs P-013: the inputs panel supplies a parameterized
  // plan's values, so a human can satisfy the start gate from the UI rather
  // than having to call plans:set-template-data from an agent session.
  'set-template-data',
]);

// Admin proxy identity: the writes (set-status/set-now/add-decision/
// add-item) flow through with-plan-lock → readIdentity, which requires
// power-user / superuser / principal attribution. The admin shell
// isn't bearer-auth'd, so we synthesize a superuser ctx (gated by the
// fact that /admin/* is loopback-bound — the same security model the
// rest of /admin/* uses). The synthesized `?superuser=1` triggers the
// http-projection branch that sets isSuperuser=true; the in-process
// `validateSuperuser` accepts it because this route is the only caller
// that ever synthesizes that URL.
const ADMIN_UI_CLIENT_ID = 'pc-admin-plans-ui';

function unwrap(toolResult: { status: number; body: unknown }): Response {
  if (toolResult.status === 200) {
    const body = toolResult.body as { content?: Array<{ type: string; text?: string }> };
    const text = body.content?.find((c) => c.type === 'text')?.text;
    if (text !== undefined) {
      try {
        return Response.json(JSON.parse(text));
      } catch {
        return new Response(text, { headers: { 'content-type': 'text/plain' } });
      }
    }
    return Response.json({});
  }
  return Response.json(toolResult.body, { status: toolResult.status });
}

/**
 * `plans:get` is now a BULK tool: even a single-slug call returns the runBulk
 * envelope `{ ok, results: [plan], counts }` (get.ts → bulkContent). The plans
 * admin UI (usePlan → fetchPlan) is single-plan and reads `data.raw/prose/
 * frontmatter/contentHash` straight off the response — so without this it gets
 * the envelope, `data.raw`/`data.prose` are undefined, and PlanDetail renders a
 * BLANK editor (the symptom: select a plan, nothing shows). Unwrap `results[0]`
 * here so the route keeps its documented contract — present clean single-object
 * shapes to client code (line ~21). Non-bulk shapes (a top-level `{ error }`
 * from a trust/validation failure) pass through unchanged.
 */
export function unwrapBulkGet(toolResult: { status: number; body: unknown }): Response {
  return unwrapBulkSingle(toolResult, {
    error: { code: 'not_found', message: 'Plan not found.' },
  });
}

/**
 * Unwrap a bulk tool result when the admin route's contract is one row.
 *
 * Bulk tools keep their `{ ok, results, counts }` envelope for agent callers,
 * including a single-slug request. Admin consumers such as the inputs panel
 * read one row directly, so forwarding that envelope makes every field look
 * absent without producing an error. Keep this helper opt-in per verb: list
 * and search endpoints legitimately return multiple rows and must retain the
 * envelope/payload they received.
 */
export function unwrapBulkSingle(
  toolResult: { status: number; body: unknown },
  emptyResult: unknown = { ok: false, error: 'not_found' },
): Response {
  if (toolResult.status !== 200) {
    return Response.json(toolResult.body, { status: toolResult.status });
  }
  const body = toolResult.body as { content?: Array<{ type: string; text?: string }> };
  const text = body.content?.find((c) => c.type === 'text')?.text;
  if (text === undefined) return Response.json({});
  let env: unknown;
  try {
    env = JSON.parse(text);
  } catch {
    return new Response(text, { headers: { 'content-type': 'text/plain' } });
  }
  if (
    env &&
    typeof env === 'object' &&
    Array.isArray((env as { results?: unknown }).results) &&
    (env as { counts?: unknown }).counts &&
    typeof (env as { counts?: unknown }).counts === 'object'
  ) {
    const row = (env as { results: unknown[] }).results[0];
    return Response.json(row ?? emptyResult);
  }
  // Not the bulk envelope (e.g. a bare { error } from trust/validation) — pass through.
  return Response.json(env as Record<string, unknown>);
}

function collectHeaders(req: Request): Record<string, string | undefined> {
  const m: Record<string, string | undefined> = {};
  req.headers.forEach((v, k) => {
    m[k.toLowerCase()] = v;
  });
  return m;
}

/* `bodyFromSearchParams` — plans:* tools register `methods: ['POST']`
 * (defineTool default) and read args from `req.body`, so the route
 * dispatches internally as POST and projects the query string into a
 * body. The pure coercion logic lives in ./_plans-args.ts so it can
 * be unit-tested without importing the tool registry. */

/** Build the synthetic searchParams every internal dispatch uses.
 *  `?superuser=1` triggers the isSuperuser=true branch; `?client=...`
 *  supplies the stable uiClientId readIdentity() requires for writes
 *  (with-plan-lock attribution) and locks:queue. Reads don't depend on
 *  either, but keeping a single shape across verbs simplifies the
 *  dispatch. */
function adminSearchParams(inbound: URLSearchParams): URLSearchParams {
  const sp = new URLSearchParams(inbound);
  sp.set('superuser', '1');
  if (!sp.has('client')) sp.set('client', ADMIN_UI_CLIENT_ID);
  return sp;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizePlanScopeArg(body: Record<string, unknown>): string | undefined {
  const harness = firstString(
    body.harness,
    body.harnessSlug,
    body.harness_slug,
    body.hive,
    body.potSlug,
    body.hive_slug,
  );
  if (harness) body.harness = harness;
  return harness;
}

export async function dispatchRead(req: Request, ctx: RouteContext): Promise<Response> {
  const verb = ctx.params.verb;
  if (!READ_VERBS.has(verb)) {
    return Response.json(
      { error: { code: 'unknown_verb', message: `plans read verb '${verb}' not found` } },
      { status: 404 },
    );
  }
  const url = new URL(req.url);
  const body = bodyFromSearchParams(url.searchParams) as Record<string, unknown>;
  normalizePlanScopeArg(body);
  // /adv shows the ACTIVE workspace's plans. For the cross-plan `list` verb,
  // default to the workspace-wide listing (every plan in the active workspace,
  // any harness) instead of the harness:'all' wildcard — that wildcard resolves
  // to papercup/papercusp-workspace and LEAKED its plans into every other
  // workspace (workspace-data-isolation-leaks F-A1). Other verbs keep the 'all'
  // → papercup default (they target a specific plan whose harness the UI passes).
  if (verb === 'list' && body.harness == null && body.harness_slugs == null && body.workspaceWide == null) {
    body.workspaceWide = true;
  } else if (body.harness == null) {
    body.harness = 'all';
  }
  // The admin Edit mode round-trips the whole document through plans:set-content
  // (CAS hashes the exact raw bytes), so the UI needs `raw` — which P-008 drops
  // from plans:get by default. Opt in for the single-plan `get` the editor loads.
  if (verb === 'get') {
    body.includeRaw = true;
    // PlanDetail's guarded one-shot fetch uses this REST route, rather than
    // the sync reader in read-dispatch.ts. Both need the complete document,
    // but neither displays descendant execution history. Keep explicit
    // opt-ins; the tool also honors heading:History and priorAttemptRefs.
    if (body.includeHistory == null) body.includeHistory = false;
  }
  // The UI reads FULL, unshaped payloads. This loopback admin surface has no
  // model-context budget, so — like the @papercusp/sync path in
  // read-dispatch.ts (callPlansReadRaw) — it MUST take the explicit
  // `payloadTier:'full'` escape hatch out of the payload-tier HARD CEILING
  // (WI-5078 / WI-2859). Without it, a >30KB `mode:'full'` plan read was
  // force-shaped down: the prose body dropped and every item past the first
  // emptied to `{}` — so the PlanDetail popup rendered a blank Vditor body
  // (no prose to render) AND crashed the whole view on plans whose items lost
  // their `id` (previewNextItemId's `t.id.match(...)` threw). A caller may
  // still pass an explicit lower tier via `?payloadTier=`.
  if (body.payloadTier == null) body.payloadTier = 'full';
  const result = await handleHttpToolRequest(
    {
      method: 'POST',
      pathname: `/api/agent-tools/plans/${verb}`,
      searchParams: adminSearchParams(url.searchParams),
      headers: collectHeaders(req),
      body,
    },
    HOST_EXTRAS,
  );
  if (verb === 'get') return unwrapBulkGet(result);
  if (verb === 'get-input-schema') {
    return unwrapBulkSingle(result);
  }
  return unwrap(result);
}

async function dispatchWrite(req: Request, ctx: RouteContext): Promise<Response> {
  // WI-6501: this route admits `unverified-loopback` so the cookie-less desktop
  // webview can reach it (see the route definition). That admission removes the
  // trust tier as the cross-origin backstop, so the CSRF origin guard IS the
  // backstop — mirrors coord/:verb and the coordination proxy. Must stay FIRST.
  const csrf = requireAllowedOriginOr403(req);
  if (csrf) return csrf;

  const verb = ctx.params.verb;
  if (!WRITE_VERBS.has(verb)) {
    return Response.json(
      { error: { code: 'unknown_verb', message: `plans write verb '${verb}' not found` } },
      { status: 404 },
    );
  }
  let body: Record<string, unknown> = {};
  try {
    const txt = await req.text();
    if (txt) body = JSON.parse(txt) as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: { code: 'invalid_json', message: 'request body must be JSON' } },
      { status: 400 },
    );
  }
  const normalizedHarness = normalizePlanScopeArg(body);
  // Same /adv default as dispatchRead: operator-scope writes target Papercusp's
  // own plans, so default the harness gate to 'all' (→ papercup) unless given.
  if (body.harness == null) body.harness = 'all';
  const url = new URL(req.url);
  const result = await handleHttpToolRequest(
    {
      method: 'POST',
      pathname: `/api/agent-tools/plans/${verb}`,
      searchParams: adminSearchParams(url.searchParams),
      headers: collectHeaders(req),
      body,
    },
    HOST_EXTRAS,
  );
  // Fire SSE invalidations on success so the libs/sync SSEAdapter
  // refetches any matching `plans.*` queries. Best-effort: failure to
  // notify must not break the write itself. Coarse mapping for now —
  // future fine-grained tuning (only invalidate plans.history on
  // structural changes etc.) is a small follow-up.
  //
  // EI-7433 cleanup: plans.list / plans.items / plans.attention are ALREADY
  // bridged as bare (full-bust) entries in table-to-query-names.ts — every
  // WRITE_VERBS path here writes harness_plans (plans are PG-canonical), so
  // the `emit_change_notify` trigger already fires a name-only invalidate for
  // all three on this same write, and the bus's 90s (name,args) dedupe
  // absorbed the duplicate call this route used to also fire. Removed as
  // redundant. plans.lint has NO bridge entry in table-to-query-names.ts
  // (nothing maps harness_plans → plans.lint) — this route is its ONLY
  // invalidation path, so it stays explicit.
  if (result.status >= 200 && result.status < 300) {
    const slug = typeof body.slug === 'string' ? body.slug : undefined;
    void notifySyncInvalidate('plans.lint', undefined).catch(() => {});
    if (slug) {
      void notifySyncInvalidate('plans.get', { slug }).catch(() => {});
      if (verb === 'set-content' || verb === 'set-frontmatter' || verb === 'new' || verb === 'set-plan-status') {
        void notifySyncInvalidate('plans.history', { slug }).catch(() => {});
        void notifySyncInvalidate('plans.revisions', { slug }).catch(() => {});
      }
      if (verb === 'new' || verb === 'set-frontmatter' || verb === 'set-content' || verb === 'set-plan-status') {
        // Any of these can change plan status (e.g. draft→active), which
        // affects ProposalsPanel's plansDrafts.bySlug subscription.
        // R2-D: also accept harness from the URL query (?harness=…) — this
        // is the path the scoper subprocess uses when running curl from a
        // harness cwd; it doesn't set the harness_slug body field.
        const url = new URL(req.url);
        const harnessSlug =
          normalizedHarness ||
          firstString(body.harness_slug, body.harnessSlug, url.searchParams.get('harness'));
        if (harnessSlug) {
          void notifySyncInvalidate('plansDrafts.bySlug', { harnessSlug }).catch(() => {});
        }
      }
      if (verb === 'apply-plan-block') {
        // R2 audit: architect's promote:plan flow creates a new draft
        // plan via this verb. Pass through harnessSlug (different key
        // shape from harness_slug because plan-block-handler accepts
        // camelCase) to invalidate ProposalsPanel's subscription so the
        // new card appears immediately instead of waiting for refresh.
        const harnessSlug = normalizedHarness || firstString(body.harnessSlug, body.harness_slug);
        if (harnessSlug) {
          void notifySyncInvalidate('plansDrafts.bySlug', { harnessSlug }).catch(() => {});
        }
      }
      if (verb === 'launch' || verb === 'resume') {
        void notifySyncInvalidate('plans.runs', { slug }).catch(() => {});
        // The Runs-tab history+rollup query keys on { planSlug } (plans.runHistory).
        void notifySyncInvalidate('plans.runHistory', { planSlug: slug }).catch(() => {});
      }
      if (verb === 'promote') {
        // Promote creates features — invalidate featuresConsolidated so the
        // plan detail status badges and harness feature list update live.
        const harnessSlug = normalizedHarness || firstString(body.harness_slug, body.harnessSlug);
        if (harnessSlug) {
          void notifySyncInvalidate('featuresConsolidated.bySlug', { harnessSlug }).catch(() => {});
          void notifySyncInvalidate('featuresConsolidated.byPlanSlug', { planSlug: slug }).catch(() => {});
          // R2-B: promote also flips the plan frontmatter from draft → active,
          // so the ProposalsPanel subscription needs to refetch and drop the
          // card from the list.
          void notifySyncInvalidate('plansDrafts.bySlug', { harnessSlug }).catch(() => {});
        }
        void notifySyncInvalidate('plans.get', { slug: slug ?? '' }).catch(() => {});
      }
    }
  }
  return unwrap(result);
}

// WI-6501 (owner-reported 2026-07-27: "plans:get → 403: trust unverified-loopback
// not in allowlist" opening a plan from the left sidebar).
//
// Both routes admit `unverified-loopback` — the EI-338 class, same fix as the coord
// / coordination / deploy-accounts families. A native fetch from the DESKTOP webview
// (the only shipping target) does not ride the sys:http IPC bridge that injects the
// loopback-superuser bearer, so every plans read resolved `unverified-loopback` and
// this VT gate refused it. The plans rail is not an optional pane — it is the primary
// navigation surface, so VT here meant the sidebar was dead in the shipping build.
//
// Why widen rather than move the UI to sync queries (the other sanctioned fix): the
// plans client is ~30 verbs across reads AND mutations, and useSyncQuery is a read
// transport — it has no mutation path, so that route would fix half the surface and
// leave every write 403ing. Widening fixes both halves at the layer the bug is in.
//
// The trust tier is therefore no longer what stops a cross-origin browser POST.
// `dispatchWrite` opens with requireAllowedOriginOr403 for exactly that reason —
// if you remove one, remove the other, or this becomes a cross-origin write hole.
const PLANS_TRUST = ['verified', 'trusted', 'unverified-loopback'] as const;

const readRoute = defineTool({
  method: 'GET',
  path: '/admin/plans/:verb',
  auth: { trust: [...PLANS_TRUST] },
  handler: dispatchRead,
});

const writeRoute = defineTool({
  method: 'POST',
  path: '/admin/plans/:verb',
  auth: { trust: [...PLANS_TRUST] },
  handler: dispatchWrite,
});

export default [readRoute, writeRoute];
