# Reference
URL: /internal/docs/endpoint-system/reference

Manifest schema, error codes, file map, capability conventions. Lookup material.

## Manifest schema (plugin tool entry)

```jsonc
{
  // Required
  "name":        "do_thing",                   // Identifier within the plugin
  "description": "One-sentence description.",  // Shown in tools/list to agents
  "inputSchema": { "type": "object", "..." },  // JSON Schema — use Zod 4's z.toJSONSchema, never zodToJsonSchema

  // Strongly recommended
  "capabilities": ["http:fetch:example.com"],  // Descriptive on plugins, enforced on built-ins
  "roles":        ["worker", "architect"],     // Role allowlist — empty/missing means "no role gate"
  "rolesQuota":   { "worker": { "perChunk": 1 } },  // Per-window quota; reads usually don't need this
  "timeoutSec":   60,                          // Default 60 if omitted

  // Streaming + state
  "events": {                                  // Typed event vocabulary; surfaced on tools/list
    "delta":     { "type": "string" },         // z.string() → raw text on the SSE wire
    "tool_call": { "type": "object", "..." }   // any object → JSON-encoded
  },
  "replayBufferSize":  100,                    // Ring-buffer size for Last-Event-ID resume. Default 0 = no replay.
  "idleTimeoutSec":    120,                    // Abort if no event emitted for N seconds. Default unset.
  "state":             { /* JSON-Schema for ctx.publishState payload */ },  // Declares state-shaped tool (auto opt-out of replay buffer; auto-streamable)
  "modality":          ["text", "voice"],      // Surface filter for prompt-assembly catalog. Default (absent) = ["text", "voice"] — visible in both catalogs.
  "guidance": {                                // Rendered into prompt-assembly tools catalog
    "when":      "User asks to <X>; pair with <Y> for the chained-list case.",
    "notWhen":   "Not for <Z> — use <other_tool> instead.",
    "chaining":  "After <prerequisite_tool>; before <successor_tool>."
  },

  // Optional — exposure overrides
  "expose": {
    "http": {
      "path":    "/api/plugins/my-plugin/do_thing",  // Default: /api/plugins/<short-name>/<tool.name>
      "methods": ["POST"]                            // Default: ["POST"]
    },
    "mcp": {
      "name":         "my-plugin.do_thing",          // Default: <short-name>.<tool.name>
      "streaming":    true,                          // Explicit streamability opt-in. Also implied by declared events or state.
      "largeOutput":  true                           // Hint that output may be written to scratch dir
    },
    "slash": {                                       // Slash-command projection via MCP prompts. DEFAULT ON for
      "name":        "do-thing",                     //   every MCP-exposed tool; `false` opts out entirely.
      "description": "Run the thing.",               //   See transports → "Slash exposure".
      "args":        ["target"]                      //   Restrict which scalar inputs become prompt arguments.
    }
  }
}
```

If `expose.*` is omitted entirely, the framework picks defaults for both. If you want only one transport, declare only that one. (`expose.slash` defaults ON whenever the tool is MCP-exposed — it is a catalog projection, not a transport; see [Transports → Slash exposure](/internal/docs/endpoint-system/transports#slash-exposure--the-tool-catalog-as-slash-commands).)

Built-in `defineTool` calls accept the same fields as TS/Zod (`state: z.object({...})`, `events: { delta: z.string(), ... }`, etc.). The `RoleToolDefinitionInput` shape is the canonical authority — see `libs/generic/tooldef/src/types.ts`.

## Error codes

| Code                      | HTTP | Meaning                                              |
| ------------------------- | ---- | ---------------------------------------------------- |
| `unauthorized`            | 401  | Built-in tool, no bearer / invalid bearer            |
| `role_not_allowed`        | 403  | Plugin tool, role not in allowlist                   |
| `missing_capability`      | 403  | Built-in tool, principal missing required capability |
| `quota_exceeded`          | 429  | Window count ≥ limit                                 |
| `invalid_input`           | 400  | Function threw a typed input-validation error        |
| `timeout`                 | 504  | AbortController fired before function returned       |
| `unknown_tool`            | 404  | No projection registered at this path/name           |
| `method_not_allowed`      | 405  | HTTP method not in `expose.http.methods`             |
| `handler_error`           | 500  | Function threw an unhandled error                    |
| `invalid_request_context` | 400  | MCP call missing required URL spawn params           |
| `invalid_bearer`          | 401  | (MCP) Bearer didn't resolve to a principal           |

For MCP transport, errors return `{ result: { content: [{ type: 'text', text: 'code: message' }], isError: true } }` rather than HTTP status codes. The codes are the same.

## Capability conventions

Capability strings should namespace by intent. Existing patterns:

* `tools:<plugin>:<verb>` — ownership marker for plugin-contributed tools (`tools:repomix:pack`, `tools:web:fetch_clean`)
* `compute:exec:<bin>` — subprocess execution (`compute:exec:repomix`, `compute:exec:npx`); enforces `ctx.spawn(bin, ...)` to a basename match
* `http:fetch:<host>` — outbound HTTP fetch to a specific host (`http:fetch:r.jina.ai`, `http:fetch:api.firecrawl.dev`)
* `secrets:read:<NAME>` — explicit secret access (`secrets:read:FIRECRAWL_API_KEY`)
* `<scope>:read` / `<scope>:write` — built-in tool capabilities (`audit:read`, `tasks:write`)
* `events:emit:<name>` / `events:listen:<name>` — pub-sub event bus

Don't consolidate capabilities into a single `secrets:*` or `compute:*` namespace. Granular grants exist so a future principal/auth model can selectively allow `secrets:read:FIRECRAWL_API_KEY` without granting access to all secrets.

## Role names

Agents pass one of these as the `?role=` URL param:

| Role         | Quota window | Typical use                                    |
| ------------ | ------------ | ---------------------------------------------- |
| `worker`     | `chunk:<id>` | Implements one feature per chunk               |
| `validator`  | `run:<id>`   | Tests the worker's output                      |
| `scoper`     | `run:<id>`   | Generates feature plans + validation contracts |
| `architect`  | `run:<id>`   | Routes work, owns the loop                     |
| `reviewer`   | `run:<id>`   | Code review pass                               |
| `debugger`   | `run:<id>`   | Debugs failing validations                     |
| `operator`   | `run:<id>`   | UI-mode reads/writes                           |
| `documenter` | `run:<id>`   | Doc generation                                 |
| `curator`    | `run:<id>`   | Curates artifacts                              |

The framework doesn't care if you invent a new role — `tool.roles[]` is a string list, not a typed enum at runtime. But sticking to the established set keeps quotas comparable across runs.

## Window keys

`window_key` (and the quota ceiling) in `tool_invocations` is computed by the
host-injected `DispatchProjectedDeps.computeQuotaWindow(ctx, roleQuota)` (plan P-011).
The engine default (`defaultComputeQuotaWindow` in `libs/generic/tooldef/src/dispatch-types.ts`)
is run-scoped / `perRun`; Papercusp's policy (`papercuspComputeQuotaWindow` in
`packages/agent-mcp/src/quota-policy.ts`, wired via `PROJECTED_DEPS`) is:

* `worker` → `chunk:<chunkId>` (cap `perChunk`) if `ctx.chunkId` set, else null (no window, no quota)
* power-user session → `power-user:<uiClientId>` (cap `perRun`) — keyed on the stable auth session, not the per-request run
* anyone else → `run:<runId>` (cap `perRun`) if `ctx.runId` set, else null

Null window means no quota check (and no telemetry insert path that requires the key). In practice every real call has both `?run=` and either a worker chunk or a run-scoped role, so windows are always set.

## File map

> The engine was extracted into **`@papercusp/tooldef`** (plan
> `papercusp-tooldef-extraction-2026-05-29`); the HTTP adapter into
> **`@papercusp/tooldef-http`**; IPC is **`@papercusp/ipc-endpoint-server`**.
> `@papercusp/agent-mcp` is the Papercusp host adapter (supplies the injected
> deps + re-exports the engine surface). Paths below reflect that split.

### Dispatcher / projection / transports

| Concern                                  | Module                                                                                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projection registry (3 Maps)             | `libs/generic/tooldef/src/tool-projection.ts`                                                                                                       |
| Built-in `defineTool` + auto-projection  | `libs/generic/tooldef/src/define-tool.ts`                                                                                                           |
| Plugin loader + `registerPluginTools`    | `packages/plugin-loader/src/index.ts`                                                                                                               |
| Plugin host + lifecycle                  | `packages/operator-core/lib/plugin-host-runtime.ts`                                                                                                 |
| HTTP catch-all (plugins)                 | `packages/operator-core/lib/endpoint-route/routes/plugins/catchall.ts`                                                                              |
| HTTP catch-all (built-ins)               | `packages/operator-core/lib/endpoint-route/routes/agent-tools/catchall.ts`                                                                          |
| MCP transport (both pipelines)           | `packages/operator-core/lib/endpoint-route/routes/transport/_mcp-handler.ts`                                                                        |
| Dispatcher (gates + record)              | `libs/generic/tooldef/src/dispatch-projected.ts` (+ `dispatch-stack.ts`)                                                                            |
| HTTP request → context builder           | `libs/generic/tooldef-http/src/http-projection.ts`                                                                                                  |
| Replay buffer (Last-Event-ID resume)     | `libs/generic/tooldef/src/replay-buffer.ts`                                                                                                         |
| Spawn-mcp `.mcp.json` writer             | `libs/papercusp/packages/orchestrator/src/spawn-mcp.ts`                                                                                             |
| Per-spawn URL → ctx parser               | `packages/agent-mcp/src/spawn-context.ts`                                                                                                           |
| Host deps (PG quota/telemetry, policies) | `packages/operator-core/lib/projected-tool-deps.ts` + `packages/agent-mcp/src/{quota-policy,capability-tiers-papercusp,gate-bypass,role-config}.ts` |
| Shared subprocess + secret impls         | `packages/operator-core/lib/plugin-spawn-impl.ts`                                                                                                   |
| Harness path resolver (PG-backed)        | `packages/operator-core/lib/resolve-harness-paths.ts`                                                                                               |
| IPC adapter (Unix socket / named pipe)   | `libs/generic/ipc-endpoint-server/` + `packages/operator-core/lib/endpoint-ipc/`                                                                    |

### Cards + state channel (bespoke-card-improvements arc)

| Concern                                                      | Module                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| State channel (per-run snapshot map + subscribers)           | `libs/generic/tooldef/src/state-channel.ts`                                                      |
| Card correlator (PENDING map + deferred lifecycle)           | `libs/generic/tooldef/src/card-correlator.ts`                                                    |
| `ctx.askUser` state machine + install                        | `libs/generic/tooldef/src/card-correlator.ts` (+ install site in `dispatch-stack.ts`)            |
| Workspace-switch lifecycle hook                              | `libs/generic/tooldef/src/workspace-lifecycle.ts`                                                |
| State-snapshot SSE route                                     | `packages/operator-core/lib/endpoint-route/routes/operator/state-snapshot.ts`                    |
| Card-response endpoint                                       | `packages/operator-core/lib/endpoint-route/routes/operator/card-response.ts`                     |
| Run-cancel endpoint                                          | `packages/operator-core/lib/endpoint-route/routes/operator/run-cancel.ts`                        |
| Workspace-switch endpoint (fires lifecycle hook)             | `packages/operator-core/lib/endpoint-route/routes/workspaces/switch.ts`                          |
| Rate-limit bucket (30 RPS per session user)                  | `packages/operator-core/lib/card-response-rate-limit.ts`                                         |
| Client-side state-snapshot hook                              | `apps/operator/lib/use-state-snapshots.ts`                                                       |
| Client-side card renderers (radio/checkbox/text/date/slider) | `apps/operator/app/_components/chat/{AskChoiceCard,InputCard,PendingCardsBar,LocalCardHost}.tsx` |
| `askUserLocal` client transport                              | `apps/operator/lib/chat-cards/ask-user-local.ts`                                                 |

### Secrets / telemetry / catalog

| Concern                                                                     | Module                                                                                                                                                                         |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Search-provider key reader (orchestrator-side)                              | `libs/papercusp/packages/orchestrator/src/spawn-env-from-pg.ts`                                                                                                                |
| Search-provider key reader (operator-side)                                  | `packages/operator-core/lib/search-provider-credentials.ts`                                                                                                                    |
| Telemetry schema (`harness_shared.tool_invocations`, incl. `event_count`)   | `libs/papercusp/libs/db/sql/000-baseline.sql` (the old `046`/`066` migrations were squashed into the baseline; see `self-contained-migration-baseline-2026-06-02`)             |
| Search-provider keys schema (`operator_search_provider_credentials`)        | `libs/papercusp/libs/db/sql/000-baseline.sql` (squashed from old `047`)                                                                                                        |
| `system:operator` `chat:write` grant (new principals)                       | `packages/operator-core/lib/endpoint-route/routes/agent-mcp/provision.ts` (in the default capability list)                                                                     |
| `system:operator` `chat:write` backfill (one-time, pre-existing principals) | `libs/papercusp/libs/db/sql/archive/067-operator-chat-write-cap.sql` (a data `UPDATE`, **not** in the baseline — a row backfill isn't schema, so the squash didn't capture it) |
| Read-only catalog page                                                      | `apps/operator/app/settings/plugins/tools/page.tsx` (served at `/settings/plugins/tools`)                                                                                      |
| Host status / refresh endpoint                                              | `packages/operator-core/lib/endpoint-route/routes/plugins/host-refresh.ts`                                                                                                     |
| Tool catalog endpoint                                                       | `packages/operator-core/lib/endpoint-route/routes/plugins/tools.ts`                                                                                                            |
| Provision system principals                                                 | `packages/operator-core/lib/endpoint-route/routes/agent-mcp/provision.ts` (calls `provisionSystemPrincipal` in `packages/agent-mcp/src/provisioning.ts`)                       |

## URL spawn params

Read by `buildHttpSpawnContext` in `http-projection.ts` and the equivalent on the MCP route.

| Query param    | Header                     | Field                                                   |
| -------------- | -------------------------- | ------------------------------------------------------- |
| `workspace`    | `X-Papercusp-Workspace`    | `ctx.workspaceId`                                       |
| `harness`      | `X-Papercusp-Harness`      | `ctx.harnessSlug` (also drives `projectDir` resolution) |
| `role`         | `X-Papercusp-Role`         | `ctx.role`                                              |
| `feature`      | `X-Papercusp-Feature`      | `ctx.featureId`                                         |
| `chunk`        | `X-Papercusp-Chunk`        | `ctx.chunkId`                                           |
| `run`          | `X-Papercusp-Run`          | `ctx.runId`                                             |
| `spawn`        | `X-Papercusp-Spawn`        | `ctx.spawnId`                                           |
| `parent_spawn` | `X-Papercusp-Parent-Spawn` | `ctx.parentSpawnId`                                     |
| `client`       | `X-Papercusp-Client`       | `ctx.uiClientId`                                        |

Header form takes precedence over query form when both are present. The orchestrator uses query form when writing per-spawn `.mcp.json` because mcp-handler clients don't have a clean way to attach custom headers.

`client` carries the per-session SID used for coordination ownership (locks, plan edits, `agent_chats`). It is required for superuser / power-user identity attribution: a client-less superuser/power-user call reaches `resolveAgentIdentity` with `uiClientId=null` and **throws**, so identity-resolving tools fail for those callers. It follows the same header-first precedence as the others (the `X-Papercusp-Client` header overrides a static `?client=` query value).

## Operations endpoints

| Endpoint                                             | Purpose                                                                                                                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/plugins/tools`                             | List every projected tool. Used by `/settings/plugins/tools`.                                                                                                                                                       |
| `POST /api/plugins/host/refresh`                     | Re-run discovery. Returns full host status.                                                                                                                                                                         |
| `GET /api/credentials/search-providers`              | Read masked search-provider keys + provider list (UI-only).                                                                                                                                                         |
| `POST /api/credentials/search-providers`             | Update keys (UI-only).                                                                                                                                                                                              |
| `POST /api/agent-tools/<scope>/<verb>`               | Built-in tool catch-all.                                                                                                                                                                                            |
| `POST /api/plugins/<plugin>/<tool>`                  | Plugin tool catch-all (HTTP).                                                                                                                                                                                       |
| `GET/POST /api/mcp`                                  | MCP transport (Streamable HTTP).                                                                                                                                                                                    |
| `GET /api/sse`                                       | MCP transport (SSE). Same handler.                                                                                                                                                                                  |
| `GET /api/operator/state-snapshot`                   | SSE stream of `state-snapshot` events for the active workspace. Carries `openCards` (from `ctx.askUser`) + `toolState` (from `ctx.publishState`). Session-cookie required (401).                                    |
| `POST /api/operator/conversations/:id/card-response` | Resolves a pending `ctx.askUser` card. Body: `{ correlationId, action: 'submit'\|'decline'\|'cancel', workspaceId, payload?, reason? }`. 30 RPS per session user. 404 on cross-workspace replay (defense-in-depth). |
| `POST /api/operator/conversations/:id/run-cancel`    | Cancels every pending card under a `runId`. Body: `{ runId, workspaceId }`. Same auth + rate limit + cross-workspace gate as `/card-response`.                                                                      |
| `POST /api/workspaces/switch`                        | Body `{ id }`. Captures `leaving = reg.current`, writes new current, fires `dispatchWorkspaceSwitch(leaving)` — drops state snapshots + cancels every pending card under the leaving workspace.                     |

## Result envelope

Tool functions return `ToolResult`:

```ts
interface ToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'resource'; resource: { uri: string; ...etc } }
  >;
  isError?: boolean;
}
```

The dispatcher does not inspect `content` — it's passed through to the transport verbatim. `isError` flips the MCP transport's `tools/call` error envelope but doesn't change the HTTP status (HTTP statuses come from `error.code` mapping).

For **large outputs** (>50k chars), write to `<stateDir>/scratch/<id>.<ext>` and return:

```ts
return {
  content: [{
    type: 'text',
    text: JSON.stringify({ path: '/abs/path', sizeBytes, sample: '...' }, null, 2),
  }],
};
```

The dispatcher records `output_ref` and `output_size` based on the result, so the Intel UI can link directly to scratch files without the response body bloating up.
