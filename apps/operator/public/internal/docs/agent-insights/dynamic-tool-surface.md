# The dynamic tool surface — trimmed seed + full reachability
URL: /internal/docs/agent-insights/dynamic-tool-surface

Canonical trimmed-only MCP launch contract: every client starts from a growable core seed; tools:find discovers the live long tail, tools:invoke guarantees dispatch, and legacy full inputs normalize to trimmed with deprecation metadata.

## The problem — eager catalogs force a false trade-off

The superuser MCP catalog is large enough that advertising every tool schema at launch wastes context, dilutes tool choice, and can exceed a client transport frame before the first useful call. A static small allowlist avoids that cost but strands the long tail. Papercusp therefore has one effective launch mode: a small, growable `trimmed` seed with full server-side reachability.

The old `full` launch mode is retired. Public launch schemas, saved-profile writers, UI controls, and generated argv expose only `trimmed`. Compatibility boundaries may still receive the historical spelling `full`; `normalizeSuContextSize` converts it to `trimmed` before signing, spawning, comparison, or persistence and reports a deprecation signal. It is an input alias, never an effective mode.

## The mechanism — a growable seed

1. **Seed.** SU launches advertise `CORE_MCP_TOOL_NAMES` plus the small SU-only extras through the MCP URL's `?tools=` parameter. Role launches advertise the shared core spine. `buildSuLaunchSpec` and `buildRoleLaunchSpec` set the seed for every backend and tier.
2. **Track.** On the first `tools/list`, `getSessionSurface(uiClientId, seed)` creates a mutable per-session set. The stable session identity is the key, and the seed is re-added as an invariant floor on every later list.
3. **Discover.** `tools:find { query }` searches the complete projected catalog and returns the exact tool name, description, and argument schema. Its handler also calls `ctx.activateTools` for the selected hits.
4. **Grow.** `activateSessionTools` adds newly discovered names and emits `notifications/tools/list_changed`. Clients that honor the notification can re-fetch `tools/list` and receive native wrappers for the expanded set.
5. **Invoke.** `tools:invoke { name, args }` dispatches any projected tool under the caller's existing role, profile, quota, and authorization gates. It is the universal path when a client does not materialize a wrapper after `list_changed`.

`tools:invoke` is a router, not a privilege bypass: the target call runs through the same projected dispatch and policy checks as a direct call. The compact MCP initialize instructions provide a capability map so an agent can know what category to search without loading every schema.

## Per-client behavior

| Client     | Launch surface                                                                                                                                                                                            | Long-tail path                                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **OMP**    | The per-session config advertises the core seed directly and disables OMP's second discovery gate for that small set.                                                                                     | `tools:find` grows the server surface; OMP honors `list_changed` and can call surfaced wrappers. `tools:invoke` remains available.                                 |
| **Codex**  | Always starts from the trimmed seed. There is no supported full-catalog opt-out: the old full surface exceeded the code-mode IPC frame limit.                                                             | Use `tools:find` for the live name/schema and `tools:invoke` for guaranteed dispatch. A refreshed native wrapper is an optimization, not an acceptance dependency. |
| **Claude** | `PAPERCUSP_TOOLS` seeds the same trimmed spine. Native ToolSearch stays enabled to defer the seed's schemas, but Claude no longer receives the whole Papercusp catalog's names and descriptions up front. | Use Papercusp `tools:find` and `tools:invoke` for the long tail. Do not depend on Claude refreshing an existing wrapper after `list_changed`.                      |

This is deliberately heterogeneous at the client edge and uniform at the contract boundary: every launch is effectively trimmed, and every client can still reach the complete authorized catalog.

## Legacy `full` compatibility

* CLI `--context-size=full`, old HTTP request bodies, `adv_sessions.launch_spec` / `launch_argv`, and historical fleet headcount config rows remain readable.
* The shared normalizer returns effective `trimmed` plus `normalizedLegacyFull:true`; HTTP surfaces expose `{ requested:'full', effective:'trimmed', deprecated:true }` where callers need to show the migration.
* Read paths do not mutate historical storage as a side effect. The next explicit mutation persists only `trimmed`.
* Any value other than `trimmed` or the one legacy alias is rejected.

The compatibility rule prevents old durable rows from becoming launch traps without keeping two behaviors alive.

## Tool-schema freshness

`list_changed` is a membership signal, not a schema-content invalidation signal. Editing the schema of a tool already visible in a connected session does not force that client to refresh its cached wrapper. Verify a changed schema from a fresh connection after promotion. For long-tail acceptance, a fresh trimmed session must discover the tool through `tools:find` and successfully call it through `tools:invoke`; an old session's cached direct wrapper is not evidence.

## Core invariants

* `?tools=` is a seed floor, not an authorization cap.
* Session growth is ephemeral connection state, bounded by TTL and a hard entry cap.
* A session without a stable identity remains safely static; `tools:invoke` still preserves reachability.
* Full-catalog eagerness must not be reintroduced as a public flag, saved profile, role default, or client-specific escape hatch.
* Tests should cover both the trimmed public contract and legacy-full normalization at every durable boundary.
