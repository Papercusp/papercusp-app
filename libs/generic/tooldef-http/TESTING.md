# Testing `@papercusp/tooldef-http`

Runner: **Vitest** (`npx vitest run` from this package; `npx vitest` to watch).
Like the engine, the adapter is host-injected, so tests need **no** Postgres,
network, or web framework — they call `handleHttpToolRequest` with an empty
`HttpToolHostExtras` and assert on the returned `{ status, body }`.

## What's covered (`src/http-projection.test.ts`)

Resolution + dispatch with **no host policies** (the standalone path):

- **200 + content** — a registered tool whose `expose.http` path matches is
  dispatched and its `ToolResult` content is returned.
- **404** — an unknown pathname resolves to no tool.
- **405** — a known path called with a disallowed method.

## Standalone example (doubles as a smoke test)

[`examples/standalone-http.ts`](./examples/standalone-http.ts) serves a tool over
`handleHttpToolRequest` importing only `@papercusp/tooldef` + this package (empty
DI surface) and asserts `200 "5"`:

```bash
npx tsx examples/standalone-http.ts
```

This is also the regression guard for the CJS/ESM packaging trap: it runs under
real `tsx` module resolution, which the bundled vitest suite does **not** —
see the agent-insight *new-package CJS-family type:module trap*.

## What's NOT covered here

- **The production host seam** (`resolvePrincipalAndTx` / `withWorkspace` /
  `resolveHarnessPaths`) and the PG-backed `DispatchProjectedDeps` — those are
  Papercusp host code, exercised in `@papercusp/web` (operator) route tests.
- **Gate behavior** (role / capability / quota) — that's the engine's
  responsibility, covered in `@papercusp/tooldef`.

## After editing

```bash
npx vitest run                              # from packages/tooldef-http
npx tsc -p tsconfig.build.json --noEmit     # typecheck
npx tsx examples/standalone-http.ts         # smoke: standalone HTTP dispatch
```
