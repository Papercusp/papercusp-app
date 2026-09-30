# @papercusp/tooldef-http

The **HTTP transport adapter** for [`@papercusp/tooldef`](../tooldef). It turns an
inbound HTTP request into an engine dispatch:

1. **Resolve** — match `method` + `pathname` (+ query) to a projected tool's
   `expose.http` declaration (404 if no path matches, 405 if the method isn't
   allowed).
2. **Build context** — assemble a `UnifiedToolContext` from `X-Papercusp-*`
   headers / query params, using host-injected hooks for the parts only the host
   knows (principal, workspace tx, harness paths).
3. **Dispatch** — run the tool through the engine's gate stack and shape the
   outcome into an HTTP status + body (with a streaming SSE variant).

It depends only on the engine (`@papercusp/tooldef`) and the SSE writer
(`@papercusp/sse`) — **no web framework**. Next.js / Hono / Express are thin
shims that hand this adapter a normalized request and forward its response.

## Surface

```ts
import {
  handleHttpToolRequest,          // request → { status, body }
  handleHttpToolRequestStreaming, // request → SSE stream of ctx.emit events
  buildHttpSpawnContext,          // header/query → UnifiedToolContext (+ host hooks)
  PAPERCUSP_CONTEXT_HEADERS,      // the X-Papercusp-* header names it reads
  type HttpToolRequest,           // { method, pathname, searchParams, headers, body }
  type HttpToolResponse,          // { status, body, headers? }
  type HttpToolHostExtras,        // the injected host seam (see below)
  type HttpRequestContextInput,
  type HttpToolResult,
} from '@papercusp/tooldef-http';
```

## Host-injection seam — `HttpToolHostExtras`

The adapter is framework-neutral **and** host-neutral: everything Papercusp- or
deployment-specific is injected through `HttpToolHostExtras` — the second
argument to `handleHttpToolRequest`, carrying the engine `deps`
(`DispatchProjectedDeps`) plus the optional host hooks `resolvePrincipalAndTx`,
`withWorkspace`, and `resolveHarnessPaths`. Pass just `{ deps: {} }` and you get
a fully standalone HTTP tool server — no auth, no DB, no quota:

```ts
import { registerProjectedTool } from '@papercusp/tooldef';
import { handleHttpToolRequest } from '@papercusp/tooldef-http';

registerProjectedTool({
  pluginName: 'example', description: 'Add two numbers',
  inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  capabilities: [], expose: { http: { path: '/api/plugins/example/add', methods: ['POST'] } },
  async fn(input) { const { a, b } = input as { a: number; b: number }; return { content: [{ type: 'text', text: String(a + b) }] }; },
});

const res = await handleHttpToolRequest(
  { method: 'POST', pathname: '/api/plugins/example/add', searchParams: new URLSearchParams(), headers: {}, body: { a: 2, b: 3 } },
  { deps: {} }, // empty DI surface
);
// res.status === 200, res.body.content[0].text === '5'
```

A runnable copy is in [`examples/standalone-http.ts`](./examples/standalone-http.ts):
`npx tsx examples/standalone-http.ts`. It imports **only** the engine + this
adapter — the falsifiable proof the HTTP transport is usable with no host.

A real host (Papercusp's operator) instead passes the production `HttpToolHostExtras`
— `resolvePrincipalAndTx` (bearer → principal + workspace SQL client),
`withWorkspace`, `resolveHarnessPaths` — and the PG-backed `DispatchProjectedDeps`.

## Status

Extracted from the host in **P-030** of the tooldef extraction
([plan](../../apps/operator/docs/plans/papercusp-tooldef-extraction-2026-05-29.md)).
It is an **in-tree** workspace package (`papercup/packages/tooldef-http`); unlike
`@papercusp/tooldef` it is not yet mirrored to a standalone repo — whether to
promote it travels with the in-tree-vs-mirror decision (plan item **P-054**,
needs-human).

## See also

- Engine + host-injection model: [`@papercusp/tooldef`](../tooldef).
- MCP counterpart: [`@papercusp/tooldef-mcp`](../tooldef-mcp).
- Design docs: `/internal/docs/endpoint-system/transports`.
- [`TESTING.md`](./TESTING.md).
