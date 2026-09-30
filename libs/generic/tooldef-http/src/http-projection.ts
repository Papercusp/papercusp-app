/**
 * HTTP transport adapter for projected tools.
 *
 * The dynamic catch-all route at apps/operator/app/api/plugins/[...path]
 * (and any other catch-alls per agent-tools etc.) delegates to
 * `handleHttpToolRequest()`. This module is the pure routing logic —
 * isolated for testability without a Next.js / Hono runtime.
 *
 * Flow (per inbound HTTP request):
 *   1. Look up the tool by URL pathname via lookupByHttpPath.
 *   2. Verify request method is in tool.expose.http.methods (default POST).
 *   3. Build a UnifiedToolContext from request headers + URL query params:
 *        - bearer → resolveBearer → principal/tx (built-in tools)
 *        - X-Papercusp-* headers → spawn context (workspace, role, …)
 *        - urlSearchParams → fallback for the spawn context (parity with
 *          MCP transport's URL-param model)
 *   4. Validate input against tool.inputSchema (TODO: wire ajv when we
 *      build it; v1 trusts the route to validate or trusts the fn).
 *   5. Branch on the tool's expose.http content-type preference:
 *        - JSON (default): build sync response from dispatch result.
 *        - SSE (when tool.expose.mcp?.streaming and Accept includes
 *          text/event-stream): stream {progress, result} events.
 *   6. dispatchProjectedTool with the right deps.
 *   7. Shape result back to HTTP response.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 */

import type { SseSink } from '@papercusp/sse';
import {
  dispatchProjectedTool,
  type AgentRole,
  type DispatchProjectedDeps,
  type DispatchProjectedResult,
} from '@papercusp/tooldef';
import {
  emitToSseSink,
  lookupByHttpPath,
  type ProjectedTool,
  type UnifiedToolContext,
} from '@papercusp/tooldef';
import { readReplayBuffer } from '@papercusp/tooldef';

/* ─── Request context derivation ─────────────────────────────────────── */

/** Headers we read from inbound HTTP requests to populate the spawn ctx. */
export const PAPERCUSP_CONTEXT_HEADERS = {
  workspace: 'x-papercusp-workspace',
  harness: 'x-papercusp-harness',
  role: 'x-papercusp-role',
  feature: 'x-papercusp-feature',
  chunk: 'x-papercusp-chunk',
  run: 'x-papercusp-run',
  spawn: 'x-papercusp-spawn',
  parentSpawn: 'x-papercusp-parent-spawn',
  client: 'x-papercusp-client',
} as const;

/** Headers and URL params an HTTP caller can supply. */
export interface HttpRequestContextInput {
  /** Lowercased header map. */
  headers: Record<string, string | undefined>;
  /** Parsed URL query string (for parity with MCP URL-param transport). */
  searchParams: URLSearchParams;
}

/**
 * Build a partial UnifiedToolContext from HTTP request inputs. The
 * caller (route handler) layers in `log`, `signal`, `progress`, `tx`,
 * and `principal` from its own auth/PG path; this fn populates only the
 * spawn context fields that are derivable from headers/query.
 */
export function buildHttpSpawnContext(input: HttpRequestContextInput): {
  workspaceId?: string;
  harnessSlug?: string;
  role?: AgentRole;
  featureId?: string | null;
  chunkId?: string | null;
  runId?: string;
  spawnId?: string;
  parentSpawnId?: string | null;
  projectDir?: string;
  stateDir?: string;
  uiClientId?: string | null;
} {
  const get = (k: keyof typeof PAPERCUSP_CONTEXT_HEADERS): string | null => {
    const headerVal = input.headers[PAPERCUSP_CONTEXT_HEADERS[k]];
    if (headerVal && headerVal.trim()) return headerVal.trim();
    const queryVal = input.searchParams.get(
      k === 'workspace' ? 'workspace'
        : k === 'harness' ? 'harness'
          : k === 'role' ? 'role'
            : k === 'feature' ? 'feature'
              : k === 'chunk' ? 'chunk'
                : k === 'run' ? 'run'
                  : k === 'spawn' ? 'spawn'
                    : k === 'client' ? 'client'
                      : 'parent_spawn',
    );
    return queryVal && queryVal.trim() ? queryVal.trim() : null;
  };
  const out: ReturnType<typeof buildHttpSpawnContext> = {};
  const ws = get('workspace'); if (ws) out.workspaceId = ws;
  const slug = get('harness'); if (slug) out.harnessSlug = slug;
  const role = get('role'); if (role) out.role = role as AgentRole;
  out.featureId = get('feature');
  out.chunkId = get('chunk');
  const runId = get('run'); if (runId) out.runId = runId;
  const spawnId = get('spawn'); if (spawnId) out.spawnId = spawnId;
  out.parentSpawnId = get('parentSpawn');
  // The per-session uiClientId the coordination layer uses for ownership
  // attribution (locks, plan edits, agent_chats). OMP's explicit client header
  // wins first; for an admitted superuser MCP request, Mcp-Session-Id is the
  // per-session identity before the URL's static client fallback. Only trust
  // that handshake id on the superuser route: other tiers must use their
  // authenticated client identity, not the transport session id. Most
  // clients carry it as `?client=` in the MCP url (Claude env-expands
  // `${PAPERCUSP_SID}`; Codex bakes `&client=<sid>` per launch). OMP
  // can't interpolate its mcp.json url, but it DOES resolve header
  // values (env / `!cmd`) at connect time, so the `x-papercusp-client`
  // header carries the per-launch SID and overrides OMP's static
  // `?client=<machine-id>`. Without any source
  // the HTTP transport reaches resolveAgentIdentity with uiClientId=null,
  // which throws for superuser / power-user callers.
  const clientHeader = input.headers[PAPERCUSP_CONTEXT_HEADERS.client]?.trim() || null;
  const clientQuery = input.searchParams.get('client')?.trim() || null;
  const mcpSessionId = input.searchParams.get('superuser') === '1'
    ? input.headers['mcp-session-id']?.trim() || null
    : null;
  const client = clientHeader ?? mcpSessionId ?? clientQuery;
  if (client) out.uiClientId = client;
  return out;
}

/* ─── HTTP request handler ───────────────────────────────────────────── */

export interface HttpToolRequest {
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface HttpToolResponse {
  status: number;
  body: Record<string, unknown> | { error: { code: string; message: string; meta?: Record<string, unknown> } };
}

export type HttpToolResult =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'stream'; tool: ProjectedTool; ctx: UnifiedToolContext; input: unknown };

/**
 * Resolve a request to a ProjectedTool via lookupByHttpPath, build the
 * UnifiedToolContext, and dispatch.
 *
 * The host wires `extras` — a dependency surface giving us access to
 * bearer-auth resolution (for built-in tools), PG (for tx + quota +
 * recording), and a logger. The host also constructs the function-side
 * `progress` callback (no-op for non-streaming HTTP, SSE writer for
 * streaming).
 */
/**
 * The scope the host needs to pick a DB handle for one tool dispatch
 * (P-062 Phase 3). Passed to `HttpToolHostExtras.runScoped` so the host —
 * not this adapter — owns the admin-vs-workspace-scoped policy.
 */
export interface ToolScope {
  /** The resolved tool — the host may read a per-tool cross-workspace opt-out off it. */
  tool: ProjectedTool;
  /** Resolved auth principal, if any (bearer / device JWT). */
  principal: UnifiedToolContext['principal'];
  /** Spawn workspace id. `'*'` or undefined for superuser / unscoped calls. */
  workspaceId: string | undefined;
  /** True when admitted via `?superuser=1` — host should NOT workspace-scope these. */
  isSuperuser: boolean;
}

export interface HttpToolHostExtras {
  /** Resolves a bearer token to a principal + tx; null on auth failure. */
  resolvePrincipalAndTx?(bearer: string): Promise<{
    principal: NonNullable<UnifiedToolContext['principal']>;
    tx: UnifiedToolContext['tx'];
  } | null>;
  /**
   * Scoping seam (P-062 Phase 3). When present, the adapter runs the tool's
   * dispatch INSIDE this callback so the HOST — not this adapter — picks the
   * DB handle the tool sees as `ctx.tx`: a workspace-bound (RLS-subject)
   * handle for normal calls, or the admin (rolbypassrls) handle for superuser
   * calls and tools that declare themselves cross-workspace. The adapter
   * overrides `ctx.tx` with whatever `run` is given and stays policy-free.
   * When ABSENT, the adapter uses the static `ctx.tx` from
   * resolvePrincipalAndTx (legacy path). A host whose impl is
   * `runScoped: (_s, run) => run(adminTx)` is behavior-identical to the
   * pre-seam path — neutral by construction until the host opts to scope.
   */
  runScoped?<T>(scope: ToolScope, run: (tx: UnifiedToolContext['tx']) => Promise<T>): Promise<T>;
  /** Quota + invocation persistence. */
  deps: DispatchProjectedDeps;
  /** Per-tool logger; receives line + plugin/tool/ctx for routing. */
  log?(line: string, ctx: UnifiedToolContext): void;
  /** Progress writer — for non-streaming HTTP, this is no-op. */
  progress?(pct: number | undefined, msg: string | undefined, ctx: UnifiedToolContext): void;
  /**
   * Capability-gated subprocess helper. Plugin tools that need to shell
   * out (repomix, code2prompt, …) call `ctx.spawn(bin, argv, opts)`. The
   * host owns the impl so it can route through its capability check
   * + PATH resolution. Same shape used by the MCP transport.
   */
  spawn?: NonNullable<UnifiedToolContext['spawn']>;
  /** Secret resolver for plugin tools needing API keys (FIRECRAWL_API_KEY etc). */
  secret?: NonNullable<UnifiedToolContext['secret']>;
  /**
   * Resolve a harness slug + workspace id to project + state dirs. The
   * MCP transport already does this via the operator's
   * `resolveHarnessPaths`; HTTP needs the same resolver so plugin tools
   * (repomix, code2prompt, …) get a populated `ctx.projectDir`.
   */
  /**
   * Optional superuser admission check. Called when the request URL
   * has `?superuser=1`. Return true to admit (bypasses role + quota
   * gates). Return false to reject — the dispatcher returns 401
   * unauthorized rather than fall through to anonymous dispatch.
   *
   * Hosts typically check loopback origin + bearer-token equality.
   * See `apps/operator/lib/superuser-token.ts` for the operator impl.
   */
  validateSuperuser?(req: HttpToolRequest): boolean;
  resolveHarnessPaths?(
    harnessSlug: string,
    workspaceId: string,
  ): Promise<{ projectDir: string; stateDir: string }>;
}

/**
 * Resolve the inbound tool request to a ProjectedTool + UnifiedToolContext
 * before dispatch. Shared by both `handleHttpToolRequest` (JSON path) and
 * `handleHttpToolRequestStreaming` (SSE path).
 */
async function resolveToolAndContext(
  req: HttpToolRequest,
  extras: HttpToolHostExtras,
): Promise<
  | { ok: true; tool: ProjectedTool; ctx: UnifiedToolContext }
  | { ok: false; status: number; body: HttpToolResponse['body'] }
> {
  const tool = lookupByHttpPath(req.pathname);
  if (!tool) {
    return {
      ok: false,
      status: 404,
      body: { error: { code: 'unknown_tool', message: `No tool at path "${req.pathname}"` } },
    };
  }
  const allowedMethods = tool.expose.http?.methods ?? ['POST'];
  if (!allowedMethods.includes(req.method as 'POST')) {
    return {
      ok: false,
      status: 405,
      body: { error: { code: 'method_not_allowed', message: `Tool "${req.pathname}" does not accept ${req.method}` } },
    };
  }
  // Superuser path: if `?superuser=1` is set, the host's validator MUST
  // accept it. If not, reject with 401 — never fall through to anonymous
  // dispatch, otherwise unauthenticated callers could trigger plugin tools
  // by appending ?superuser=1 and exploiting any tool that fails-open on
  // missing context.
  const wantsSuperuser = req.searchParams.get('superuser') === '1';
  if (wantsSuperuser && !extras.validateSuperuser?.(req)) {
    return {
      ok: false,
      status: 401,
      body: { error: { code: 'unauthorized', message: '?superuser=1 requires loopback origin + valid bearer token (see ~/.papercusp/superuser-token)' } },
    };
  }
  const spawnCtx = buildHttpSpawnContext({ headers: req.headers, searchParams: req.searchParams });
  let isSuperuser = false;
  if (wantsSuperuser) {
    isSuperuser = true;
    if (!spawnCtx.workspaceId) spawnCtx.workspaceId = '*';
    if (!spawnCtx.harnessSlug) spawnCtx.harnessSlug = '*';
    if (!spawnCtx.role) spawnCtx.role = 'operator' as AgentRole;
    // An admitted superuser who sent no `?client=` / x-papercusp-client still
    // needs a stable coordination identity: identity resolvers treat a
    // superuser ctx with no uiClientId as unattributable and THROW, so every
    // client-less call to an identity-resolving tool over this transport
    // failed deterministically (EI-334 — the advertised curl-able
    // `fleet/spawn?superuser=1` admin trigger was structurally broken).
    // Admission already proved "the machine admin" (host validator: loopback
    // + the on-disk bearer), so a fixed transport-level id is attributable —
    // the same stability class as a `?client=` machine UUID. An explicit
    // client id, when provided, still wins (checked above).
    if (!spawnCtx.uiClientId) spawnCtx.uiClientId = 'su-http-loopback';
    // Per-request UUID rather than a shared 'standalone' sentinel.
    // Audit5: when claude-code spawned via mcp-remote calls multiple
    // tools concurrently from one subprocess, the URL is static — so
    // all those calls share whatever runId is in the URL (or the
    // default). Sub-tool A's dispatcher finally calling
    // cancelPendingCardsForRun(runId) would wipe sub-tool B's still-
    // pending askUser cards. Unique runIds per request fix that.
    //
    // Replay-buffer (T2.2) is keyed on (workspace, tool, runId); per-
    // request UUIDs disable accidental cross-request replay coalescing.
    // Clients explicitly resuming via X-Papercusp-Run header still get
    // matched against the right buffer.
    if (!spawnCtx.runId) spawnCtx.runId = globalThis.crypto.randomUUID();
    if (!spawnCtx.spawnId) {
      const buf = new Uint8Array(8);
      globalThis.crypto.getRandomValues(buf);
      spawnCtx.spawnId = `ephemeral-${Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    }
  }
  // Resolve project + state dirs from harness slug + workspace id when
  // both are present and the host supplied a resolver. Without this the
  // ctx fields stay undefined and tools needing `ctx.projectDir` (repomix,
  // code2prompt) fail with a transport-layer error.
  // Skip path resolution for superuser wildcards ('*') — tools that
  // need a real workspace path will fail loud with their own per-tool
  // fallback ("workspace= arg required").
  // Ensure every HTTP-projected tool call has a runId. ctx.askUser /
  // ctx.publishState only install when both workspaceId + runId are
  // present; tools relying on either silently no-op (chat:ask_choice
  // returns "no_chat_surface", state-shaped tools return
  // "no_state_channel") when the JSON path doesn't supply one. The
  // SSE route (apps/operator/.../agent-tools/route.ts) already injects
  // a runId via `url.searchParams.set('run', ...)`; the superuser
  // branch above also defaults one. Mirror that here so the bearer-
  // auth JSON path has parity. Found during pass-9 E2E audit.
  if (!spawnCtx.runId) {
    spawnCtx.runId = globalThis.crypto?.randomUUID?.() ??
      `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  const realWorkspace = spawnCtx.workspaceId && spawnCtx.workspaceId !== '*';
  const realHarness = spawnCtx.harnessSlug && spawnCtx.harnessSlug !== '*';
  if (extras.resolveHarnessPaths && realHarness && realWorkspace) {
    try {
      const paths = await extras.resolveHarnessPaths(spawnCtx.harnessSlug!, spawnCtx.workspaceId!);
      (spawnCtx as { projectDir?: string }).projectDir = paths.projectDir;
      (spawnCtx as { stateDir?: string }).stateDir = paths.stateDir;
    } catch { /* leave undefined; tool will surface a clear error */ }
  }
  const abort = new AbortController();
  // Default `emit` is a no-op for the JSON path; the streaming path
  // (`handleHttpToolRequestStreaming`) overwrites this with a sink writer.
  const noopEmit = () => { /* non-streaming http transport */ };
  const ctx: UnifiedToolContext = {
    log: (msg) => {
      const fullCtx: UnifiedToolContext = { ...spawnCtx, log: () => {}, signal: abort.signal, progress: () => {}, emit: noopEmit };
      extras.log?.(msg, fullCtx);
    },
    signal: abort.signal,
    progress: (pct, msg) => {
      const fullCtx: UnifiedToolContext = { ...spawnCtx, log: () => {}, signal: abort.signal, progress: () => {}, emit: noopEmit };
      extras.progress?.(pct, msg, fullCtx);
    },
    emit: noopEmit,
    transport: 'http',
    // Result-format negotiation (P-008): explicit `?format=` wins over the
    // `Accept` MIME type. Parsed by the result serializer; unrecognized values
    // fall through to the HTTP transport default (lossless JSON).
    requestedFormat: req.searchParams.get('format') ?? req.headers['accept'] ?? undefined,
    requestedStructured: req.searchParams.get('structured') === '1',
    ...spawnCtx,
    isSuperuser,
    // Neutral gate-bypass signal the dispatcher reads (P-014). An admitted
    // superuser bypasses all three gates; this transport has no power-user
    // tier, so quota is bypassed too. (The host decides *who* is a superuser
    // via `extras.validateSuperuser`; the bypass consequence is the adapter's.)
    gateBypass: isSuperuser ? { role: true, capability: true, quota: true } : undefined,
    ...(extras.spawn ? { spawn: extras.spawn } : {}),
    ...(extras.secret ? { secret: extras.secret } : {}),
  };
  const auth = req.headers['authorization'];
  if (auth && extras.resolvePrincipalAndTx) {
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    try {
      const resolved = await extras.resolvePrincipalAndTx(bearer);
      if (resolved) {
        ctx.principal = resolved.principal;
        ctx.tx = resolved.tx;
      }
    } catch { /* continue anonymous */ }
  }
  return { ok: true, tool, ctx };
}

function statusForErrorCode(code: string | undefined): number {
  switch (code) {
    case 'unauthorized': return 401;
    case 'role_not_allowed': return 403;
    case 'missing_capability': return 403;
    // RBAC role requirement (tooldef-auth Phase 2) — was falling through to 500.
    case 'missing_role': return 403;
    // Resource-authorize denial / default-deny (Phases 1b/3) — were 500.
    case 'authorization_denied': return 403;
    case 'ungated': return 403;
    // harness:'required' tool with no harness in scope — was 500.
    case 'harness_required': return 400;
    // Declarative `requires:` precondition (D-006) — Precondition Failed.
    case 'precondition_failed': return 412;
    case 'quota_exceeded': return 429;
    case 'invalid_input': return 400;
    case 'timeout': return 504;
    case 'unknown_tool': return 404;
    case 'method_not_allowed': return 405;
    default: return 500;
  }
}

/**
 * Dispatch the resolved tool, honoring the host's optional `runScoped`
 * scoping seam (P-062 Phase 3). With `runScoped`, the host chooses the DB
 * handle and the dispatch runs inside its callback (that handle becomes
 * `ctx.tx`); without it, the static `ctx.tx` from resolvePrincipalAndTx is
 * used. Behavior is identical when the host's runScoped yields that same
 * handle. Shared by the JSON + SSE handlers so the seam wraps both.
 */
function dispatchScoped(
  req: HttpToolRequest,
  extras: HttpToolHostExtras,
  resolved: { tool: ProjectedTool; ctx: UnifiedToolContext },
): Promise<DispatchProjectedResult> {
  const toolName = resolved.tool.expose.mcp?.name ?? req.pathname;
  const run = (tx: UnifiedToolContext['tx']): Promise<DispatchProjectedResult> => {
    resolved.ctx.tx = tx;
    return dispatchProjectedTool(resolved.tool, toolName, req.body, resolved.ctx, extras.deps);
  };
  if (!extras.runScoped) return run(resolved.ctx.tx);
  const scope: ToolScope = {
    tool: resolved.tool,
    principal: resolved.ctx.principal,
    workspaceId: resolved.ctx.workspaceId,
    isSuperuser: !!resolved.ctx.isSuperuser,
  };
  return extras.runScoped(scope, run);
}

export async function handleHttpToolRequest(
  req: HttpToolRequest,
  extras: HttpToolHostExtras,
): Promise<HttpToolResponse> {
  const resolved = await resolveToolAndContext(req, extras);
  if (!resolved.ok) return { status: resolved.status, body: resolved.body };

  const r: DispatchProjectedResult = await dispatchScoped(req, extras, resolved);

  if (!r.ok) {
    return { status: statusForErrorCode(r.error?.code), body: { error: r.error! } };
  }
  // Forward the result `_meta` (format tag + pagination/degraded envelope, P-006)
  // alongside content so HTTP consumers can read the negotiated format + cursor.
  const meta = r.result?._meta;
  const body: Record<string, unknown> = { content: r.result?.content ?? [] };
  if (meta && Object.keys(meta).length > 0) body._meta = meta;
  if (r.result?.structuredContent !== undefined) body.structuredContent = r.result.structuredContent;
  return { status: 200, body };
}

/* ─── Streaming variant (SSE) ────────────────────────────────────────── */

/**
 * Handle a streaming tool request — same flow as `handleHttpToolRequest`
 * but writes Server-Sent Events into the caller-supplied `SseSink`.
 *
 * Wire events the framework emits automatically:
 *   event: done    data: <ToolResult.content as JSON>  (on handler return)
 *   event: error   data: { code, message }             (on dispatch failure)
 *
 * Plus whatever the handler emits via `ctx.emit` and `ctx.progress`.
 *
 * The `ctx.emit` passed to the handler is wired here to fan each
 * call to a sink event. The legacy `ctx.progress` is reshaped as
 * a thin alias over `ctx.emit('progress', { progress, total, message? })`.
 *
 * Caller is responsible for opening the SSE response (via @papercusp/sse's
 * `sseResponse({ setup: (sink) => handleHttpToolRequestStreaming(...) })`).
 * This function closes the sink before returning.
 */
export async function handleHttpToolRequestStreaming(
  req: HttpToolRequest,
  extras: HttpToolHostExtras,
  sink: SseSink,
): Promise<void> {
  const resolved = await resolveToolAndContext(req, extras);
  if (!resolved.ok) {
    const body = resolved.body as { error: { code: string; message: string } };
    sink.event('error', { code: body.error.code, message: body.error.message });
    sink.close();
    return;
  }

  // Phase 4 T2.2 — replay-on-reconnect. Browsers auto-set Last-Event-ID
  // on SSE reconnect; callers pass X-Papercusp-Run (mapped to ctx.runId)
  // to identify the original call. When both are present AND the tool
  // declared replayBufferSize, serve buffered events past sinceId then
  // close — the original tool aborted on disconnect, so we don't
  // re-dispatch (which would duplicate events + may have side effects).
  // First-time connects skip this path because runId differs.
  const runIdForReplay = resolved.ctx.runId;
  const lastEventIdRaw = req.headers['last-event-id'];
  const wantsReplay =
    !!runIdForReplay &&
    !!lastEventIdRaw &&
    !!resolved.tool.replayBufferSize &&
    !!resolved.ctx.workspaceId;
  if (wantsReplay) {
    const sinceId = Number.parseInt(lastEventIdRaw, 10);
    if (Number.isFinite(sinceId) && sinceId >= 0) {
      const toolName = resolved.tool.expose.mcp?.name ?? req.pathname;
      const buffered = readReplayBuffer({
        workspaceId: resolved.ctx.workspaceId!,
        toolName,
        runId: runIdForReplay,
        sinceId,
      });
      if (buffered !== null) {
        // Buffer hit (may be empty if client is already caught up).
        // Either way, treat this as a successful resume — replay
        // remaining tail, signal done, close. We don't re-run the
        // tool: the original call aborted on disconnect by design.
        for (const ev of buffered) {
          // Honor the tool's wire kind so resumed events look identical
          // to their original transmission.
          emitToSseSink(sink, resolved.tool, ev.name, ev.data);
        }
        sink.event('done', { resumed: true, replayed: buffered.length });
        sink.close();
        return;
      }
      // Buffer miss: original buffer expired (>5min) or the tuple was
      // never opened. Fall through to normal dispatch — caller will
      // see a fresh stream from event id 1, which is the documented
      // behavior when the resume window has elapsed.
    }
  }

  // Wire emit → sink. Each ctx.emit(name, data) becomes one SSE event.
  // The wire-kind dispatch lives in emitToSseSink so transports and
  // route shims share one source of truth — see its doc comment.
  resolved.ctx.emit = (name, data) => emitToSseSink(sink, resolved.tool, name, data);
  resolved.ctx.progress = (pct, msg) => {
    resolved.ctx.emit('progress', {
      progress: typeof pct === 'number' ? pct : 0,
      total: 100,
      ...(msg ? { message: msg } : {}),
    });
  };

  const r = await dispatchScoped(req, extras, resolved);
  if (!r.ok) {
    // Dispatch failure: auto-error. Honor the tool's schema-inferred
    // wire kind for `error` — if the tool declared `error: z.string()`,
    // emit the raw message so the wire shape matches handler-emitted
    // 'error' events. Otherwise default to the JSON envelope.
    const errorKind = resolved.tool.eventWireKinds?.error;
    if (errorKind === 'string') {
      sink.eventRaw('error', r.error!.message);
    } else {
      sink.event('error', r.error!);
    }
  } else {
    // Auto-done: handler returned successfully. Payload is the ToolResult
    // content array — same shape MCP transport returns via tools/call.
    // Handler-emitted events (delta, tool_call, …) have already streamed
    // through ctx.emit; this is the terminal event consumers wait for.
    sink.event('done', r.result?.content ?? []);
  }
  sink.close();
}
