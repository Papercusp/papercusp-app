# Testing `@papercusp/tooldef-mcp`

Runner: **Vitest** (`npx vitest run` from this package; `npx vitest` to watch).
The bridge primitives are pure functions — no MCP server, no Postgres, no
network. Tests pass a hand-built `extra` object / mock `ctx` and assert on the
returned value.

## What's covered (`src/index.test.ts`)

- **`RequestHandlerExtra` extractors** —
  - `bearerFromExtra` strips the `Bearer ` prefix.
  - `urlFromExtra` parses the request URL (and returns `null` when absent).
  - `headersFromExtra` builds a Web `Headers`, joining array-valued headers.
- **`dispatchProjectedToolToMcp`** —
  - maps a successful dispatch to `{ content }`.
  - maps a gate denial to `{ isError: true, content: [{ type:'text', text:'<code>: <message>' }] }`.

Together with `@papercusp/tooldef-http`'s standalone example and the engine's
in-process example, the success/denial mapping here is the MCP leg of the
"usable standalone across all three caller shapes" proof (plan P-051).

## Standalone example (doubles as a smoke test)

[`examples/standalone-mcp.ts`](./examples/standalone-mcp.ts) imports only the
engine + this package and exercises the extractors plus the success/denial
mapping end-to-end (and runs under real `tsx`, the CJS/ESM resolution the bundled
vitest suite doesn't — see the agent-insight *new-package CJS-family type:module trap*):

```bash
npx tsx examples/standalone-mcp.ts
```

## What's NOT covered here

- **The MCP server assembly + spawn-context auth** — that's host code (see the
  README's "What is deliberately NOT here"), exercised in the operator
  (`@papercusp/web`) against the running host, not in this package.
- **Gate behavior** — the engine's responsibility (`@papercusp/tooldef`).

## After editing

```bash
npx vitest run                              # from packages/tooldef-mcp
npx tsc -p tsconfig.build.json --noEmit     # typecheck
```
