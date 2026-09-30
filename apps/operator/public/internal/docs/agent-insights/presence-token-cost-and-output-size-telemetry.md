# Presence token cost + `tool_invocations.output_size` is the per-tool result-size signal
URL: /internal/docs/agent-insights/presence-token-cost-and-output-size-telemetry

output_size is recorded for EVERY tool dispatch (= JSON.stringify(result.content).length), not just artifact tools — so COUNT(*)+SUM(output_size) over tool_invocations is the canonical per-tool call-count + result-size telemetry. Also: the coord:presence pot-scoped read really is an inline glance; the big reads are no-pot workspace fallbacks.

## The reusable fact: `output_size` is recorded for every tool

`harness_shared.tool_invocations.output_size` holds the **serialized result
length of the tool's response, for EVERY tool dispatch** — not only the
scratch-artifact tools (Repomix / Pack / code2prompt) that set an explicit
`outputSize`. The generic dispatch stack fills it for everything:

```ts
// libs/generic/tooldef/src/dispatch-stack.ts
outputSize: r.outputSize ?? JSON.stringify(r.content).length,
```

So a pure-read MCP tool like `coord:presence` gets `output_size` =
`JSON.stringify(result.content).length` (≈ the JSON bytes the agent paid tokens
for). Verified live: a `coord:presence` row recorded `21995` for a read whose
payload was \~22 KB.

**Don't trust a code-reading conclusion that "output\_size is only for tools that
write a scratch artifact"** — that reads the artifact-tool call sites and misses
the dispatch fallback. Check the live data first.

### How to query per-tool call-count + result-size telemetry

`tool_name` is the `group:verb` form (`coord:presence`, `coord:inbox`,
`fleet:assignments`, `plans:list`, …); `plugin_name` is `agent-mcp` for MCP
tools. `invoked_at` is `timestamptz` (convert epoch-ms with
`to_timestamp(${ms}::double precision / 1000.0)`).

```sql
SELECT tool_name, COUNT(*) AS calls,
       SUM(output_size) AS bytes, ROUND(AVG(output_size)) AS avg_bytes
  FROM harness_shared.tool_invocations
 WHERE workspace_id = $1
   AND invoked_at >= to_timestamp($2::double precision / 1000.0)
   AND tool_name = ANY($3)        -- e.g. {'coord:presence','coord:inbox'}
 GROUP BY 1;
```

`COUNT(*)` is the call-count lever (token-usage-reduction #1); `SUM/AVG(output_size)`
is the tool-result-size lever (#2). This is exactly what the weekly token report's
**Presence/coord read-volume** block uses (`token-report-action.ts`,
presence-v2-2026-06-14 P-016) so a richer presence can't silently regress either.

## Presence cost: the pot-scoped read really is an inline glance

`coord:presence` `output_size` over 7d, by `scope` arg (`args_json->>'scope'`):

| scope            | calls | p50   | avg     |
| ---------------- | ----- | ----- | ------- |
| `pot` (explicit) | 17    | 182 B | \~4 KB  |
| default (no arg) | 229   | 28 KB | \~30 KB |
| `workspace`      | 81    | 67 KB | \~69 KB |
| `all`            | 4     | 66 KB | \~84 KB |

The design (presence-v2 D-002: pot-scoped default) **holds** — an explicit
pot-scoped read is \~182 B / \~46 tokens, a true inline glance. The large reads
are **SU/operator callers who have NO pot**: `resolvePresenceScope` falls back
to **workspace** scope, and on this multi-effort dev box that's a 28-active +
long-stale roster (the D-002 "one mega-workspace" artifact), plus the deliberate
`workspace`/`all` admin opt-in. No default-field trim is warranted — the lean
read shape (`toStableRosterRow`) is already small; the projection stays maximal.

The CI ceiling on the controllable lean shape lives in
`presence-cost.ts` / `presence-cost.test.ts` (P-012): a heavy lean row
\< 600 tokens, a 12-agent pot snapshot \< 6000 tokens (the "inline glance,
not a file-persist" budget). Presence has **no separate delta stream** (D-013) —
deltas ride the `[coord+N]` lifecycle injects on `coord:inbox`, so the per-turn
delta rate is just the `coord:inbox` read-volume, also in the guardrail.
