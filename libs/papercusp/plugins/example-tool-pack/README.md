# example-tool-pack

The reference **code-tool pack** (`tool-distribution-granularity-2026-06-05`
D-001/D-004).

A **pack** is the unified tool-distribution unit: *tool = pack[n=1]; plugin =
pack + runtime*. This pack is the runtime-less point on that axis — its only
contribution is two self-contained, in-process tools:

| Tool | MCP name | HTTP |
| --- | --- | --- |
| `word_count` | `example-tool-pack.word_count` | `POST /api/plugins/example-tool-pack/word_count` |
| `slugify` | `example-tool-pack.slugify` | `POST /api/plugins/example-tool-pack/slugify` |

## What makes it a pack (vs a plugin)

`papercusp.json` declares `"kind": "pack"`. The loader then enforces purity
(`packages/plugin-loader/src/index.ts` `validate()`):

- statically-declared `tools[]` only — `getDynamicTools` (MCP-proxy) is rejected;
- no `ui[]`, `dashboardTabs`, `sidebarItems`, `roles`, `routines`, `actions`,
  or code-side `hooks`;
- `runtime` must stay `js` (no `wasm`/`daemon`);
- at least one tool (a pack is a distribution unit of n≥1 tools).

Because a pack carries no runtime, it can install in isolation — true
tool-granular distribution (D-004). Runtime-bearing capabilities ride a
`kind: "plugin"` manifest instead.

## Declaring dependencies

A pack (or plugin) may declare `dependencies: { tools, packs, plugins }` —
the tools its handlers call. The Cupboard install path validates them against
the host's pack catalog before the copy lands
(`install-plugin-core.ts`); a hard-missing dep aborts with 422.

## Distribution

Publish/install rides the standard Cupboard machinery as listing kind `pack`
(`POST /api/cupboard/install-plugin` accepts pack listings — the route is
kind-agnostic). Discovery: the Cupboard tools/packs sections.
