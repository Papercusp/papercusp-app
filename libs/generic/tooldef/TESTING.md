# Testing `@papercusp/tooldef`

Runner: **Vitest** (`npx vitest run` from this package; `npx vitest` to watch).
The engine is pure and deps-injected, so tests need **no** Postgres, no
network, and no transport — they target functions with a mock `ctx` + an
empty/partial `DispatchProjectedDeps`.

## What's covered (colocated `src/*.test.ts`)

- **Dispatch** — `dispatch-projected.test.ts`, `dispatch-stack.test.ts`: the
  gate stack (role / capability / harness / quota), `gateBypass`, the
  `computeQuotaWindow` seam (`defaultComputeQuotaWindow` + a host-supplied
  override), step ordering, telemetry, timeout/abort.
- **Standard Schema** — `standard-schema.test.ts`: `standardValidate` /
  `validateSync` / `formatIssues` against a **hand-rolled non-Zod** validator
  (sync, async, and the async-on-sync-path guard) — the proof the core isn't
  Zod-locked.
- **Channels** — `state-channel.test.ts`, `card-correlator.test.ts`,
  `ask-user.test.ts`, `publish-state.test.ts`, `replay-buffer.test.ts`:
  in-memory state snapshots, `ctx.askUser` correlation, replay ring buffer.
- **Projection / wire** — `tool-projection.test.ts`, `wire.test.ts`,
  `openapi-assemble.test.ts`, `openapi-fragments.test.ts`: event wire-kind
  classification, MCP/HTTP projection, OpenAPI fragment assembly.
- **Lifecycle** — `workspace-lifecycle.test.ts`.

## What's NOT covered here

- **Transport behavior** (HTTP/MCP/IPC) — those adapters live in the host
  (`@papercusp/agent-mcp`) until Phase 4; their tests live there
  (`http-projection.test.ts` etc.).
- **The Papercusp host seam impls** (role config, quota policy, tier table,
  gate-bypass) — tested in `@papercusp/agent-mcp` (e.g. `quota-policy.test.ts`,
  `define-tool.test.ts`).

## After editing

```bash
npx vitest run            # from packages/tooldef
npx tsc -p tsconfig.build.json --noEmit   # typecheck
npx tsx examples/standalone-inprocess.ts  # smoke: standalone dispatch still works
```

Because this package is mirrored to `Papercusp/tooldef` (see README → Consuming),
run the host suite too when changing public surface:
`cd ../agent-mcp && npx vitest run` and `npx tsc -p tsconfig.build.json --noEmit`.
