# @papercusp/tooldef

A **function-as-truth** tool framework. Write one typed function:

```ts
(input, ctx) => ToolResult
```

…declare a small manifest (capabilities, roles, quotas, exposure), and the
framework projects it onto **HTTP**, **MCP**, **IPC**, and **in-process**
callers — all through one dispatcher with uniform auth / role / quota /
timeout / telemetry / streaming behavior. You don't write per-transport glue.

What makes it reusable outside Papercusp:

- **Host-agnostic.** Every side effect — quota reads, telemetry writes,
  principal resolution, capability→tier mapping, gate-bypass policy — is
  *injected*. The core depends on no database, no web framework, and no
  host-adapter package (e.g. `@papercusp/agent-mcp`).
- **Validator-agnostic.** Tool `args`/`input`, card payloads, and `state`
  accept any [Standard Schema](https://standardschema.dev) validator (Zod
  3.24+, Valibot, ArkType), validated via `~standard.validate`. JSON-Schema
  generation is a separate pluggable adapter (default: Zod).
- **Streaming-or-not, no rewrite.** A handler that calls `ctx.progress()` /
  `ctx.emit()` gets MCP notifications and SSE events for free; one that
  doesn't returns a single result.

## Status

The extraction is **complete** (Phases 1–6 — engine carve-out, host-injection
seams, Standard Schema adoption, transport extraction, re-home, verification):
- **Engine** (this package): dispatcher, registry, `defineTool`, tool-projection,
  state/card/replay channels, OpenAPI assembly, core types — carved out,
  host-agnostic, and validator-agnostic.
- **Transports extracted:** HTTP → [`@papercusp/tooldef-http`](../tooldef-http),
  IPC → [`@papercusp/ipc-endpoint-server`](../../libs/generic/ipc-endpoint-server), and the
  host-agnostic MCP bridge primitives → [`@papercusp/tooldef-mcp`](../tooldef-mcp)
  (the MCP auth/spawn *assembly* stays in the host by design — see that package's
  notes). The Papercusp host adapter is `@papercusp/agent-mcp`.

Remaining: only **P-054** (needs-human: whether to consume the standalone repo
in-tree vs as a mirror) — owned by the maintainer, separate from the engine
work. Tracking plan:
[`papercusp-tooldef-extraction-2026-05-29.md`](../../apps/operator/docs/plans/papercusp-tooldef-extraction-2026-05-29.md).

## Quickstart (in-process)

The engine works standalone — no host, no Postgres, no transport. Define a
tool and dispatch it through the full gate stack:

```ts
import {
  registerProjectedTool, lookupByMcpName, dispatchProjectedTool,
} from '@papercusp/tooldef';

registerProjectedTool({
  pluginName: 'example',
  description: 'Add two numbers',
  inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  capabilities: [],
  expose: { mcp: { name: 'math.add' } },
  async fn(input) {
    const { a, b } = input as { a: number; b: number };
    return { content: [{ type: 'text', text: String(a + b) }] };
  },
});

const tool = lookupByMcpName('math.add')!;
const r = await dispatchProjectedTool(tool, 'math.add', { a: 2, b: 3 }, /* ctx */ {
  log: () => {}, signal: new AbortController().signal, progress: () => {}, emit: () => {},
}, /* deps */ {});
// r.result.content[0].text === '5'
```

A runnable copy (zero `@papercusp/*` host imports — the falsifiable proof of
standalone usability) is in [`examples/standalone-inprocess.ts`](./examples/standalone-inprocess.ts):
`npx tsx examples/standalone-inprocess.ts`.

## Host-injection seams

Everything Papercusp-specific is injected; the core ships a generic default
for each. A host overrides them at startup (Papercusp does so in
`@papercusp/agent-mcp`).

| Concern | Seam | Core default | Papercusp override |
|---|---|---|---|
| **Roles** | augment the `RoleRegistry` interface (declaration merging) → shapes `AgentRole` | `string` (any role) | `role-config.ts` registers scoper…curator |
| **Quota window + ceiling** | `DispatchProjectedDeps.computeQuotaWindow(ctx, roleQuota)` | `defaultComputeQuotaWindow` — `run:<id>` / `perRun` | `quota-policy.ts` — worker→chunk, power-user→session |
| **Capability → tier** | `setCapabilityTierResolver(fn)` (read via `tierFor`) | everything `'low'` | `capability-tiers-papercusp.ts` |
| **Gate bypass** (privileged callers) | `ctx.gateBypass { role?, capability?, quota? }` | absent ⇒ every gate enforces (fail-closed) | `gate-bypass.ts` maps superuser/power-user |
| **Schema validation** | `args`/`state`/card `dataSchema` typed `StandardSchemaV1`; `standardValidate` / `validateSync` | any Standard Schema validator | host keeps Zod |
| **Schema → JSON Schema** | `setJsonSchemaAdapter(fn)` (read via `toJsonSchema`) | Zod 4 `toJSONSchema` | (uses default) |
| **Quota / telemetry I/O** | `DispatchProjectedDeps.readQuotaState` / `recordInvocation` / `overrideTool` | no-ops | PG-backed in `projected-tool-deps.ts` |
| **Transaction handle** | `ToolContext<Tx = any>` | `any` | workspace-scoped SQL client |

The dispatch pipeline (`DEFAULT_DISPATCH_STACK`) is a named, ordered,
replaceable list of steps — role → capability → harness → quota → timeout →
idle-watchdog → replay-buffer → ctx-bindings → invoke — with telemetry in the
orchestrator's `finally`. Swap a step by name with `withReplacedStep`.

## Not generic (deliberate, scoped)

- **Event schemas** (`events`) stay Zod-typed: wire-kind classification
  (`string`/`json`/`binary`) needs schema introspection that Standard
  Schema's `validate()` doesn't expose.
- **Route definitions** (`RouteDefinition`) stay Zod-typed: routes are
  validated host-side by the host's `registerRoute`, not the core dispatcher.
- **MCP auth/spawn assembly** stays host-side (only the generic bridge
  primitives are in `@papercusp/tooldef-mcp`): superuser/power-user admission +
  HMAC spawn-URL verification + legacy-vs-projected routing are inherently
  host-specific. (HTTP + IPC are fully extracted — see Status.)

## Consuming this package

`@papercusp/tooldef` is the in-tree workspace package at
`papercup/packages/tooldef`. It is **also** mirrored to a standalone repo
(`Papercusp/tooldef`) consumed by other projects (e.g. Restart, via a
`libs/tooldef` submodule). Until the conversion decision lands (plan item
**P-054**, needs-human), the two are kept in sync manually: **any edit here
must also be pushed to `Papercusp/tooldef` and the downstream pin bumped**, or
the mirror goes stale.

## See also

- Design docs: `/internal/docs/endpoint-system/*` (overview, function-as-truth,
  transports).
- Tests: `npx vitest run` (here). The standalone example doubles as a smoke test.
