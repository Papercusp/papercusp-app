# @papercusp/tooldef-mcp

The **MCP transport bridge primitives** for [`@papercusp/tooldef`](../tooldef) —
the host-agnostic glue between an MCP server and the engine's dispatcher. Two
small, dependency-light pieces:

### 1. `RequestHandlerExtra` extractors

Pull the bearer token, request URL, and headers out of the opaque `extra` object
an MCP server hands a request handler. Vercel's `mcp-handler` shapes it as
`{ requestInfo: { headers, url }, sendNotification }`; these read that shape with
loose typing, so the package needs **no `mcp-handler` dependency**.

```ts
import { bearerFromExtra, urlFromExtra, headersFromExtra } from '@papercusp/tooldef-mcp';

bearerFromExtra(extra);   // string  — strips a leading "Bearer "
urlFromExtra(extra);      // URL | null
headersFromExtra(extra);  // Headers — array-valued headers joined with ", "
```

### 2. Projected-dispatch → MCP-result mapper

Run a tool through the engine and shape the `{ ok, result | error }` outcome into
an MCP `tools/call` result:

```ts
import { dispatchProjectedToolToMcp, type McpToolCallResult } from '@papercusp/tooldef-mcp';

const res = await dispatchProjectedToolToMcp(tool, toolName, args, ctx, deps);
// success → { content }
// gate denial / handler error → { isError: true, content: [{ type:'text', text:'<code>: <message>' }] }
```

## Standalone example

[`examples/standalone-mcp.ts`](./examples/standalone-mcp.ts) exercises both jobs
importing only `@papercusp/tooldef` + this package — the extractors over a
hand-built `extra`, plus the mapper on a success (`math.add → "5"`) and a gate
denial (an anonymous call to a `requireRoles`-gated tool → `{ isError: true }`).
It's the MCP leg of the "three caller shapes, each proven standalone" proof
(alongside the engine's in-process example and `tooldef-http`'s HTTP example):

```bash
npx tsx examples/standalone-mcp.ts
```

## What is deliberately NOT here

The MCP server **assembly** — `tools/list` / `tools/call` wiring, spawn-context
auth (superuser / power-user admission, HMAC spawn-URL verification), and the
legacy-vs-projected pipeline routing — stays in the host. That logic is
inherently host-specific (Papercusp does it in
`apps/operator/lib/endpoint-route/routes/transport/_mcp-handler.ts`), and wrapping
it in a "generic factory" would only produce a Papercusp-shaped injection
surface, not genuine reuse. A host composes these primitives with its own
`createMcpHandler` call + auth — that composition is the part worth owning.

This asymmetry is intentional and differs from HTTP/IPC, which are fully
extracted ([`@papercusp/tooldef-http`](../tooldef-http),
[`@papercusp/ipc-endpoint-server`](../../libs/generic/ipc-endpoint-server)). See the engine
README's "Not generic (deliberate, scoped)" section.

## Status

Extracted in **P-031** of the tooldef extraction
([plan](../../apps/operator/docs/plans/papercusp-tooldef-extraction-2026-05-29.md)).
It is an **in-tree** workspace package (`papercup/packages/tooldef-mcp`); unlike
`@papercusp/tooldef` it is not yet mirrored to a standalone repo — promotion
travels with the in-tree-vs-mirror decision (plan item **P-054**, needs-human).

## See also

- Engine: [`@papercusp/tooldef`](../tooldef).
- HTTP counterpart: [`@papercusp/tooldef-http`](../tooldef-http).
- The Papercusp host composition: `apps/operator/lib/endpoint-route/routes/transport/_mcp-handler.ts`.
- [`TESTING.md`](./TESTING.md).
