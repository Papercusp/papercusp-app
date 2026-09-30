# Writing a tool
URL: /internal/docs/endpoint-system/writing-a-tool

Recipe for writing a tool end-to-end — picking the right shape, declaring the manifest entry, and verifying both transports.

> **Webapp retired (2026-05-14).** Any `localhost:3055` or `localhost:3070` URL on this page is only reachable while the **Tauri dev shell** is running. Start it with `cd papercusp-desktop && npm run dev`.

## The three shapes

Before writing any code, decide which shape your tool needs. The two first-party shapes (principal-gated and role-gated) share the **same** dirs and the **same** `defineTool` primitive — the discriminator is whether you pass `requirePrincipal: false`.

### Principal-gated built-in (`packages/operator-core/lib/agent-tools/**`)

Use when **the tool needs a real authenticated principal** — declared with a plain `defineTool` (no `requirePrincipal`). Bearer token in the request → resolved to a principal with workspace ID and a capability set. The wrapper throws `UnauthorizedToolError` (HTTP 401) if no principal is present.

* Most built-ins live in `packages/operator-core/lib/agent-tools/<group>/<verb>.ts`; the smaller read-side set lives in `packages/agent-mcp/src/tools/**`.
* Used today by: dashboard-only operations (settings reads/writes, credentials, marketplace tokens, budget, preferences)
* **Agents cannot call the principal-gated flavor** — agents pass URL spawn context, not a bearer token, so a plain `defineTool` is dashboard-only. (For agent-callable first-party behavior, use the role-gated shape below.)
* Auto-projected by `defineTool({ name, capability, args, handler })`. No manifest, no plugin folder.

### Role-gated first-party (`defineTool({ requirePrincipal: false, agentRoles, rolesQuota })`)

The dominant first-party shape — 418 tool files use it. Same first-party dirs (`packages/operator-core/lib/agent-tools/**`, `packages/agent-mcp/src/tools/**`), same `defineTool` primitive, but **agent-callable via spawn context with no bearer**. Adding `requirePrincipal: false` skips the principal check; gating is the dispatcher's role allowlist (`agentRoles`) + per-window quota (`rolesQuota`), exactly like a plugin tool. The handler gets a `UnifiedToolContext` (no `principal`, no `tx` — open your own connection from the workspace-resolved pool if you need PG).

```ts
defineTool({
  name: 'plans:set-priority',
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'cup'],
  args: argsSchema,
  async handler(args, ctx) { /* ctx has no principal/tx */ },
});
```

* This is the shape for first-party operator behavior that spawned agents must be able to call: operator scan, `plans:*`, `coord:*`, harness phases, voice config.
* Role-gated tools may also declare the streaming-only fields `events`, `state`, `idleTimeoutSec`, `replayBufferSize`, `modality` (see [Other `defineTool` fields](#other-definetool-fields)).

### Plugin (`libs/papercusp/plugins/<name>/`)

Use when **a removable, third-party tool** must be agent-callable from a spawn URL. No principal required; gating is via role allowlist + per-window quota — the same gate as a role-gated built-in. Trust comes from the orchestrator's URL-baking guarantee.

* Used today by: every plugin in `libs/papercusp/plugins/` — repomix, fetch-plus, code2prompt, firecrawl-bridge
* Manifest lives in `papercusp.json`; handlers in `index.ts`'s `tools` export.
* Pick this over a role-gated built-in only for genuinely removable third-party code — first-party operator behavior stays a role-gated built-in (do **not** shape-shift it into a fake "operator-core" plugin).

### Decision rule

> *Will an agent in a spawn ever call this with just URL params (no bearer)?*
> If no → principal-gated built-in.
> If yes, and it's first-party operator behavior → role-gated built-in (`requirePrincipal: false`).
> If yes, and it's removable third-party code → plugin.

If both — agent **and** dashboard — need it, a role-gated built-in (or plugin) is correct. The dashboard can call the same agent-tool / `/api/plugins/<plugin>/<tool>` URL the agent does; loopback trust is the same boundary either way.

## The 6-step recipe

Every new tool follows the same six steps. Skip any of them and you ship a broken tool.

### Step 0 — `set_config` discipline (if your tool reads/writes workspace-scoped PG tables)

Use this pattern. Always.

```ts
await sql.begin(async (tx) => {
  await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [ctx.workspaceId]);
  // ...your queries...
});
```

**Never** write `SET LOCAL app.workspace_id = $1`. PG's `SET` command does not accept bind parameters; you'll get a silent `syntax error at or near "$1"` and your quota/telemetry will fail open.

### Step 1 — Write the function (typed, no transport awareness)

```ts
import type { ToolContext } from '@papercusp/plugin-sdk';

export async function fetchSomething(
  input: { url: string; depth?: number },
  ctx: ToolContext,
): Promise<ToolResult> {
  // No header reads. No Response objects. Cancel via ctx.signal.
  if (ctx.signal.aborted) throw new Error('cancelled');
  ctx.progress(10, 'starting');
  // ...
  return { content: [{ type: 'text', text: '...' }] };
}
```

What the `ctx` argument has:

* `workspaceId, harnessSlug, role, runId, spawnId` — URL spawn context. `runId` is always present for HTTP-projected calls (defaulted by the catch-all when no `?run=` is supplied) so the state-channel hooks below always install.
* `featureId?, chunkId?, parentSpawnId?` — optional spawn context
* `projectDir, stateDir` — resolved by the framework via `loadHarnessRegistry()`
* `log(msg)` — appends to run.log.jsonl with plugin attribution
* `signal` — `AbortSignal` for the dispatcher's timeout / cancellation
* `progress(pct, msg)` — alias over the typed-event channel (`emit('progress', { progress, total, message? })`). On MCP, both notifications require the client to have supplied a `progressToken` — with **no** progressToken, `emit`/`progress` is a no-op (streaming disabled by the client). With one: `notifications/papercusp/event` fires for every emit, and `notifications/progress` *also* fires here because the event name is `progress` and its payload is a plain object (the standard-progress send is gated on `name === 'progress'` + a non-null, non-`Uint8Array` object payload). On HTTP SSE it emits `event: progress`.
* `emit(name, payload)` — typed event channel. Declare the vocab via `defineTool({ events: { ... } })`. See [Typed event streams](./transports.mdx#typed-event-streams).
* `askUser(spec)` — mid-run interactive prompt; blocks until the user submits/declines/cancels. Returns the validated user payload. Installed when `workspaceId + runId` are set. See [ctx.askUser](./ask-user.mdx).
* `publishState(snapshot)` — push the current tool state to the state-channel SSE. Installed when the tool declared `state: ZodType<S>` AND ctx has `workspaceId + runId`. Validated against the declared schema. See [state-shaped tools](./state-tools.mdx).
* `spawn?(bin, argv, opts)` — capability-gated subprocess
* `secret?(name)` — async secret resolver. For a **plugin** tool it is plugin-scoped: `ctx.secret(name)` reads the calling plugin's encrypted `plugin_configs` row first, then falls back to env — secrets are per-plugin-namespaced, not global. (First-party `agent-mcp` tools get a non-plugin-scoped resolver instead.)
* `principal?, tx?` — only set for **principal-gated** built-in tools called with a bearer. Role-gated built-ins and plugin tools get neither.

### Step 2 — Write the manifest entry

For plugins, this goes in `libs/papercusp/plugins/<name>/papercusp.json`:

```json
{
  "name": "do_thing",
  "description": "One-sentence description. Lead with the verb. Mention what to use it instead of.",
  "inputSchema": {
    "type": "object",
    "properties": { "url": { "type": "string" } },
    "required": ["url"]
  },
  "capabilities": ["http:fetch:example.com"],
  "roles": ["worker", "architect"],
  "rolesQuota": { "worker": { "perChunk": 1 }, "architect": { "perRun": 5 } },
  "timeoutSec": 60,
  "guidance": {
    "when": "When the user asks you to <X>; pair with <Y> for the chained-list case.",
    "notWhen": "Not for <Z> — use <other_tool> instead.",
    "chaining": "After <prerequisite_tool> if you need its id; before <successor_tool>."
  }
}
```

Notes:

* **Write JSON Schema directly.** Do not reach for `zodToJsonSchema` — it returns `{}` against Zod 4. If you have a Zod schema, use Zod 4's built-in `z.toJSONSchema(schema)`.
* **`capabilities` is descriptive for plugin tools** today (used by tooling/Intel UI). Built-in tools have it enforced via the principal's capability set.
* **`roles` is enforced.** Workers use `perChunk` quotas (resets per chunk); everyone else uses `perRun` (resets per orchestrator run).
* **Reads usually don't need a quota.** Only set `rolesQuota` for: external API spend, PG write bursts, subprocess fan-out.
* **`timeoutSec` defaults to 60** if omitted. The dispatcher aborts via `ctx.signal` when it fires.
* **`guidance` is optional but strongly recommended.** Rendered into the [prompt-assembly tools catalog](/internal/docs/agents/prompt-assembly#section-2--tools-catalog) so every role that's allowed to call the tool gets the same `when` / `notWhen` / `chaining` framing without you having to write it in N role files. Built-in tools pass `guidance` to `defineTool({...})` as a sibling of `capability`. Omit it and the catalog falls back to description-only.

#### Other `defineTool` fields

The same `defineTool` primitive accepts more than `name`/`capability`/`args`/`handler`/`guidance`. The commonly-needed ones, with pointers to their dedicated pages:

* **`result` (alias `output`)** — output `data` schema. Unlocks the token-efficient compact result formats and the MCP `outputSchema` / `structuredContent`. Only meaningful when the handler returns a `ToolResponse` envelope (a raw content-shaped `ToolResult` bypasses format selection). See [token-efficient result formats](/internal/docs/endpoint-system/transports).
* **`events` + `state`** (role-gated built-ins only) — typed-event vocabulary and the state-channel snapshot schema. See [Typed event streams](./transports.mdx#typed-event-streams) and [state-shaped tools](./state-tools.mdx).
* **`harness: 'required' | 'optional' | 'none'`** — whether the call must carry a resolved harness context.
* **`requireRoles` / `authorize` / `public`** (RFC tooldef-auth) — RBAC role requirement (any-of over `principal.roles`), a per-resource authorization hook, and the opt-out from default-deny for a tool that intentionally needs no auth gate. See [tooldef-auth](/internal/docs/endpoint-system).
* **`emits` / `requires`** — intrinsic lifecycle event-reaction rules (desugared to event rules at load) and declarative preconditions evaluated by the dispatcher's `preconditions` step.
* **`crossWorkspace`** — opt a tool out of workspace-scoped RLS isolation when it legitimately spans workspaces (e.g. cross-workspace aggregation). Set this only when correct — it disables RLS for that tool.
* **`expose`** — IPC / slash / HTTP exposure overrides; **`sampleRate`**, **`profile`** ('engineer' vs 'all' visibility); and (role-gated only) **`idleTimeoutSec`**, **`replayBufferSize`**, **`modality`** (`['text']` / `['voice']`), **`timeoutSec`**.

### Step 2.5 — If you need a new PG schema, write the SQL file (it boot-applies)

New `libs/papercusp/libs/db/sql/*.sql` files now run automatically. `applyPendingMigrationsAtBoot()` runs the same idempotent runner against the native `:5432` admin DB on host boot — for the release `:3070` operator **and** the Tauri dev shell's spawned operator (the shell this page's banner tells you to start). So just write the SQL and restart the operator; the migration applies before the boot-gate flips.

```bash
# Write libs/papercusp/libs/db/sql/048-my-new-table.sql, then restart the operator.
```

Two caveats:

* Boot-apply is gated on background-workers-enabled. The request-only staging secondary on `:3170` (and anything with `PAPERCUSP_BACKGROUND_WORKERS=0`) does **not** boot-apply.
* For an in-session add (you don't want to restart), apply manually as the fallback, then verify:

```bash
PGPASSWORD=harness_admin_pwd psql -h localhost -p 5432 -U harness_admin -d papercusp -f libs/papercusp/libs/db/sql/048-my-new-table.sql
PGPASSWORD=harness_admin_pwd psql -h localhost -p 5432 -U harness_admin -d papercusp -tAc "SELECT to_regclass('harness_shared.my_new_table')"
```

If the table never lands (boot-apply skipped on a secondary, or you forgot to restart), your tool will return 200 in dev because reads/writes silently fail.

### Step 3 — curl HTTP transport

```bash
curl -X POST 'http://localhost:3055/api/plugins/<plugin>/<tool>?harness=sheets&workspace=default&role=architect&run=R&spawn=S' \
  -H "Content-Type: application/json" \
  -d '{...}'
```

The seven URL params (`harness, workspace, role, feature, chunk, run, spawn`, plus optional `parent_spawn`) are how the framework knows your spawn context. Without them, you get partial context and several gates will fail open or closed unexpectedly.

### Step 4 — curl MCP transport

```bash
curl -X POST 'http://localhost:3055/api/mcp?harness=sheets&workspace=default&role=architect&run=R&spawn=S' \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<plugin>.<tool>","arguments":{...}}}'
```

The MCP `name` is dotted (`<plugin>.<tool>`) for plugin tools, colon-namespaced (`<scope>:<verb>`) for built-ins. Both are valid.

### Step 5 — Verify telemetry row landed

```bash
PGPASSWORD=harness_admin_pwd psql -h localhost -p 5432 -U harness_admin -d papercusp -c \
  "SET app.workspace_id='default'; SELECT tool_name, role, status, duration_ms FROM harness_shared.tool_invocations ORDER BY id DESC LIMIT 1"
```

Should show `status='ok'` and a real duration. Note the `SET app.workspace_id` — the table has RLS, so reads without the GUC return zero rows.

### Step 6 — Smoke test the gates

```bash
# Quota: fire perChunk+1 with the same chunk → second is 429.
for i in 1 2; do curl -X POST '.../my/tool?...&role=worker&chunk=Q' -d '{...}'; done

# Role gate: call with a role NOT in roles[] → 403.
curl -X POST '.../my/tool?...&role=validator' -d '{...}'   # if validator not allowed

# Refresh and confirm host error count unchanged
curl -X POST http://localhost:3055/api/plugins/host/refresh | jq '.status.errors'
# expect: 2  (the two pre-existing unrelated errors). If higher → you broke something.
```

## After every plugin manifest or handler edit

```bash
curl -X POST http://localhost:3055/api/plugins/host/refresh
```

The projection registry is module-level state. HMR is unreliable. If you don't refresh, you're testing stale code and won't know.

## Don't write tools for these

* Voice WSS (true bidirectional stream — agent ↔ user audio mid-call). Use the ElevenLabs Conv AI integration.
* File uploads >5MB (multipart isn't wired)
* Browser-state actions (no server function to project; use `ui:dispatch` instead — those are client commands, not tools)

LLM streaming output *is* fine — declare typed events on the manifest and the framework projects them over HTTP/SSE and MCP. See [Typed event streams](/internal/docs/endpoint-system/transports#typed-event-streams).

Mid-run server-asks-client is *also* fine — use `ctx.askUser(spec)` (the state channel ships the prompt out-of-band; the handler blocks on a deferred until the user clicks). See [ctx.askUser](./ask-user.mdx).

If you find yourself wanting to wrap one of the three remaining above, stop and ask. The contract was deliberately kept narrow.
