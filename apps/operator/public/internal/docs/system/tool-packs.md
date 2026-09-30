# Tool distribution — packs (tool = pack[n=1], plugin = pack+runtime)
URL: /internal/docs/system/tool-packs

The pack model — one distribution concept for tools, packs, and plugins; authoring a runtime-less code-tool pack (kind 'pack'); declaring dependencies on units; the tool→provider resolver and the live pack catalog.

import { Aside } from '@astrojs/starlight/components';

How **tools** travel between Papercusp installs
(plan: `tool-distribution-granularity-2026-06-05`). Companion to
[Blueprint distribution](/internal/docs/system/blueprint-distribution), which
covers the blueprint side of the same dependency model.

## The taxonomy (D-001)

One distribution concept, not three:

| Concept    | What it is                                                                  | Distribution                                                             |
| ---------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Tool**   | the atomic capability + dependency unit (a `defineTool` / manifest tool)    | rides its providing unit; a *single tool* is the degenerate **n=1 pack** |
| **Pack**   | the distribution/marketplace unit — n≥1 tools, **no runtime**               | installs in isolation (a code package into the operator registry)        |
| **Plugin** | a pack **with a runtime** (hooks / MCP server / daemon / WASM / UI / state) | installs as a unit; its tools ride it                                    |

So "single tool" and "plugin" are just *points* on the pack axis (n=1, and
has-a-runtime). Dependencies are declared on **tools** (capabilities) and
resolved to their providing pack/plugin/built-in (D-002) — needing one tool
out of a five-tool pack never drags in a different unit's runtime.

**In-process code-tools** (self-contained handlers) get true pack-granular
distribution. **MCP-server-backed tools** (gitnexus, ast-grep…) ride their
plugin — the runtime is the thing being installed; the tool *listing* is a
discovery view that resolves to the providing plugin. A pack is the
pressure-relief that keeps coherent capability sets together (D-005).

## Authoring a code-tool pack (`kind: "pack"`)

A pack is a plugin-manifest package whose only contribution is statically
declared in-process tools. Reference implementation:
`libs/papercusp/plugins/example-tool-pack/`.

```jsonc
// papercusp.json
{
  "kind": "pack",
  "name": "example-tool-pack",
  "version": "0.1.0",
  "papercusp": "^0.1.0",
  "capabilities": ["tools:text:word_count", "tools:text:slugify"],
  "tools": [
    { "name": "word_count", "description": "…", "inputSchema": { /* … */ },
      "capabilities": ["tools:text:word_count"] },
    { "name": "slugify", "description": "…", "inputSchema": { /* … */ },
      "capabilities": ["tools:text:slugify"] }
  ]
}
```

The entry (`index.cjs`) exports the matching handlers under `tools:` exactly
like a plugin. The host loads a pack through the SAME plugin loader/host
machinery and projects its tools onto both transports
(`example-tool-pack.word_count` on MCP,
`/api/plugins/example-tool-pack/word_count` on HTTP) — there is no second
runtime path to learn.

**Purity rules** — the loader (`packages/plugin-loader/src/index.ts`
`validate()` + `runtimeDispatch()`) rejects a `kind: "pack"` manifest that
declares anything runtime-bearing:

* `ui[]`, `dashboardTabs`, `sidebarItems`, `roles`, `routines`, `actions`,
  code-side `hooks`, and `reactions` (both the code-side `reactions` and the
  manifest's `reactions`);
* a non-`js` `runtime` (`wasm` / `daemon`);
* `getDynamicTools` (MCP-proxy tools ride a plugin);
* zero `tools[]` (a pack is a unit of n≥1 tools).

Anything on that list means the author wanted `kind: "plugin"`.

## Declaring dependencies on a unit (D-003)

Plugins **and** packs may declare the tools their handlers call, same shape
as a blueprint's block:

```jsonc
"dependencies": { "tools": ["repomix.pack"], "packs": [], "plugins": [] }
```

The Cupboard install path (`install-plugin-core.ts`) validates these against
the live pack catalog **before** the unit is copied into place: a dep with no
known provider aborts the install (422); deps installable from the Cupboard
never block and surface on the result as `installableDependencies`. When the
Cupboard is unreachable, only tool deps (in-process, authoritative) can fail.

Who declares dependencies, in full: **blueprints** (primary —
`dependencies: {tools, packs, plugins}`, see
[Blueprint distribution](/internal/docs/system/blueprint-distribution)),
**plugins/packs** (this block), and **the Pot operator** — whose standing
toolbox is just its launch blueprint's `dependencies` block (the `pot`
built-in), not a separate mechanism. (There is no published-`snapshot`
distribution unit to inherit deps: `snapshot` was retired as a listing kind —
`retire-snapshots-instance-spec-2026-06-09` D-005 — and the lightweight
InstanceSpec replaced it; the Cupboard distributes recipes, not tarballs.)

## The tool→provider resolver + the live pack catalog

The pure model lives in `@papercusp/blueprint-distribution`
(`pack-model.ts`): `buildPackCatalogView(packs, builtinTools)` indexes
distribution units; `resolveToolProvider(tool, view)` answers *who provides
this tool* —

* `available` — built-in, or an installed plugin/pack registered it;
* `installable` — a Cupboard listing declares it in `provides_tools`;
* `unknown` — no known provider (the hard-fail case for deps).

The operator wires it in `packages/operator-core/lib/cupboard/pack-catalog.ts`
(`derivePackCatalog()`): built-ins from the projected-tool registry
(`pluginName: 'agent-mcp'`), installed units from the manifest scan + live
registry, Cupboard units from `GET /listings?kind=plugin|pack` with their
`provides_tools`. `depHostSetsFromCatalog()` projects it into the
dep-validator's host sets — the one-call wiring used by the `harness:create`
gate and the install gate.

`harness:create`'s tool gate used to resolve against the legacy built-in
catalog only — a blueprint depending on a plugin-provided tool
(`repomix.pack`) hard-failed even with the plugin installed. The pack catalog
unions the projected registry, so plugin/pack-provided tools resolve.

## Distribution + discovery

Packs publish/install through the **standard Cupboard machinery** as listing
kind `pack` (the install route `POST /api/cupboard/install-plugin` is
kind-agnostic — it clones the listing repo and installs the manifest dir;
capability grants stay consent-gated). Listings of kinds `plugin`/`pack`
carry `provides_tools` (the tool names the unit registers) so the storefront
can render a **tools section** that resolves each tool to its providing
listing, and the dep-validator can mark not-installed tools *installable*.

### The worker wire (migrations 006 + 008 + 011)

The Cupboard worker (`apps/operator-public`) stores listings with
`listing_kind ∈ {harness, blueprint, plugin, pack, knowledge-pack, template, app, rubric, plan, recipe}`
(`LISTING_KINDS` in `apps/operator-public/src/db.ts`) and a nullable
`provides_tools` TEXT column (JSON `string[]`; migration
`006_pack_kind_provides_tools.sql` — a table rebuild, since SQLite can't
ALTER the kind CHECK). **Migration 008** (`learning-packs-2026-06-11` D-005)
reshaped the kind set: `snapshot` was RETIRED (its rows are `DELETE`d),
`pack` was briefly RENAMED `tool-pack`, and a sibling `learning-pack` (a
distributable set of curated pot learnings) joined. The
`cupboard-public-release-2026-07-12` rename then settled the names: the
runtime-less code-tool pack this page is about is once again the **`pack`**
kind, and its sibling is **`knowledge-pack`** (migration 011 renamed
`learning-pack` → `knowledge-pack` — see the `knowledge-pack` section below).
Both superseded values survive only as wire aliases normalized forward
(`normalizeListingKind`: `tool-pack` → `pack`, `learning-pack` →
`knowledge-pack`), so older clients keep parsing. On `POST /listings`,
`provides_tools` is accepted only for kinds `plugin`/`pack` (1–200
entries, each a non-empty string ≤128 chars) and returned verbatim on every
GET. A `pack` listing follows the non-harness rules: `listing_ref`
required, `(repo, kind, ref)` dedup, action **install** (`listingActionFor`
returns `'install'` for the `pack` case, in
`operator-core/lib/cupboard/types.ts`).

#### The sibling `knowledge-pack` kind (migrations 008 + 011)

Migration 008 also added a curated-pot-learnings listing kind (originally
`learning-pack`, renamed `knowledge-pack` by migration 011) that coexists with
`pack` in the same worker schema and storefront this page describes — but
it is a different thing: a distributable set of curated pot learnings
(installed into a pot's shared memory through conflict review), not a
code-tool pack. The instruction/judgment-carrying kinds (`knowledge-pack`, `blueprint`,
`rubric`, `plan`, and `recipe`) carry a pre-publication `review_status` (`pending` / `approved` /
`rejected`, `REVIEW_POLICY_KINDS`): they publish `pending` and surface
publicly only on operator approval, whereas code kinds (`pack` / `plugin`)
keep install-consent + reactive moderation. The `pack` kind remains the
runtime-less code-tool pack documented here.

### Publishing a unit

`POST /api/cupboard/publish-plugin { slug }` publishes an installed unit: a
`kind: "pack"` manifest lists as `listing_kind='pack'` (the manifest
format's `kind:"pack"` value and the Cupboard listing kind now match again —
migration 008 briefly diverged them as `tool-pack`, migration 011's release
line settled the listing kind back to `pack`), anything else as `plugin`.
`provides_tools` defaults to the manifest's tool names (the
loader's `<unit>.<tool>` naming convention via `manifestToolNames`); pass
`provides_tools: [...]` in the body to override.

### Tool-level discovery: `GET /api/cupboard/tools`

The marketplace's **Tools** view is the resolver fanned out — every known
tool resolved to its provider, merging the local pack catalog (built-ins +
installed units) with the Cupboard's `provides_tools` declarations. Each
entry carries its `category` (the tool namespace) and a one-line
`description` (the tool's own, or the providing unit's), and the payload rides
back `categories` facets:

```jsonc
// GET /api/cupboard/tools?q=render+markdown&status=installable&category=md
{
  "tools": [{
    "tool": "md.render",
    "status": "installable",                                  // or "available"
    "category": "md",                                         // namespace prefix
    "description": "Render markdown to HTML",                 // capability text (searchable)
    "capability": null,                                       // gate string, for built-ins
    "provider": { "kind": "pack", "name": "markdown-tools", "listingId": "…" },
    "unit": { "name": "markdown-tools", "kind": "pack", "source": "cupboard", "listingId": "…" }
  }],
  "counts": { "available": 0, "installable": 1 },
  "categories": [{ "name": "md", "count": 1 }],               // facets over the searched set
  "cupboardReachable": true                                    // false ⇒ local-only view
}
```

`q` runs **capability search** (see below) rather than a bare substring match;
`status` + `category` narrow; `categories` facets the searched/status set so
the UI can offer one-click namespace filters.

A tool never installs in isolation (D-005): the storefront's Tools view
(`/cupboard?kind=tools`) routes an installable tool's action to its
**providing listing's** detail page, where the normal install-consent flow
executes. The storefront also gains a **Packs** kind tab (keyed on the
`pack` kind value — `VIEW_FILTERS` in `CupboardClient.tsx`, alongside the
sibling **Knowledge Packs** tab), and plugin/pack detail pages surface the
listing's `provides_tools`.

### Closing the install loop (`autoInstallDeps`)

Discovery + the dep gate stop at *advisory*: `harness:create` resolves a
declared tool to an installable Cupboard listing and **reports** it, but the
shipped gate never installed it — a human had to. The install loop closes that
gap (`tool-distribution-discovery-2026-06-08` D-002):

* **`resolveAndInstallDeps(declared, deps)`**
  (`packages/operator-core/lib/cupboard/resolve-and-install.ts`) — pure +
  dependency-injected. It classifies a declared `{tools,packs,plugins}` set
  against the live catalog, installs every *installable* unit via the injected
  installer, re-derives the catalog, folds in each installed unit's own declared
  deps, and recurses — bounded by a visited-set + a round cap (`maxRounds`,
  default **8**) so a cyclic/deep dep graph terminates. A tool with **no**
  provider still hard-fails; an
  unreachable Cupboard softens unknown packs/plugins to advisory (mirroring the
  gate).
* **`cupboard:install-deps`** (`POST /api/cupboard/install-deps`) — the
  deliberate one-click action: pass a `deps` set or a `blueprintId`/`blueprint`
  and it installs everything the Cupboard can provide, returning
  `{ ok, installed, stillMissing, advisory, rounds }`. The real install IO
  (`install-io.ts`) reuses `installPluginFromCupboardCore` (a pack and a plugin
  install through the *same* core — no second runtime) behind one
  `installCupboardUnitFromListing` seam, shared with the install-plugin route.
* **`harness:create { autoInstallDeps: true }`** — opt-in: when the blueprint's
  only unmet deps are Cupboard-installable, the gate installs them (transitively)
  and re-validates before deciding, instead of failing. Default off — silent
  installs on every create would surprise. Code-tool packs install globally;
  runtime-plugin capability grants for the new harness are a separate
  `cupboard:install-deps { harness }` call.

The full cycle — publish a `kind:'pack'` code-pack → `GET /api/cupboard/tools`
discovers it → a blueprint declaring one of its tools → the loop installs it →
the tool resolves `available` — is proven end-to-end against the real
`example-tool-pack` in `resolve-and-install.e2e.test.ts`.

The loop is proven against the local + in-memory Cupboard. Publishing a pack to
the **prod** Cupboard worker still needs the federation-owner-gated deploy
(`wrangler d1 execute …006…sql --remote` + `wrangler deploy` — base D-007 §1 /
discovery D-003). Until applied, `?kind=pack` 400s at the prod worker and the
loop's `installable` units resolve only against locally-listed packs.

## Capability discovery

Discovery answers the question the install loop's *inverse* asks: not "for this
declared tool, what do I install?" but **"I want capability X — what provides
it, and is it already available?"** Over the \~380-tool merged catalog, that
needs ranked search, not a substring filter
(`tool-distribution-discovery-2026-06-08` P-005..P-008).

### Capability search + ranking (P-005)

`searchTools` (`packages/operator-core/lib/cupboard/tools-search.ts`) is a pure,
field-weighted relevance scorer over the resolved discovery entries. Each entry
is matched on five fields, weighted so the right provider surfaces first:

| Field                | Weight | Why                                                      |
| -------------------- | ------ | -------------------------------------------------------- |
| tool name            | 10     | an exact/prefix name hit is the strongest signal         |
| category (namespace) | 5      | `coord` should surface every `coord:*` tool              |
| capability gate      | 4      | built-ins carry a `capability` string (`tasks:read`)     |
| providing unit name  | 3      | "markdown-tools" finds `md.render`                       |
| description          | 2      | the capability text — "pack a repo" finds `repomix.pack` |

Search is **OR across content query tokens** — stopwords (`a`, `to`, `the`, …)
are dropped, and an entry matches if *at least one* remaining token hits some
field, so a natural-language query ("send a message to a peer") matches on its
content words instead of failing because every filler word must also land. Each
matched token adds the best `weight × tier` it achieves on any field
(`exact token` ≫ `token prefix` ≫ `substring`), so broader coverage scores
higher; a whole-query hit on the name adds a phrase boost, so an exact tool name
always leads. The per-tool capability text comes from the live registries
(`collectToolMeta` — `getCatalog()` descriptions + capability gates, plus
`listAllProjectedTools()` for installed plugin/pack tools); a Cupboard-only tool
falls back to its providing unit's description.

> Why a bespoke scorer and not `@papercusp/rrf`: rank fusion deliberately
> discards score magnitude and field semantics, but here a name-exact match
> must *always* outrank a description hit — an ordering the field weights above
> express directly.

### "What provides X": `GET /api/cupboard/provides` (P-006)

The human-facing inverse of the dependency resolver. Given a tool name
(`?tool=`, exact) or a capability phrase (`?q=`), it returns the providing
pack/plugin/listing + the install action:

```jsonc
// GET /api/cupboard/provides?tool=md.render   (or ?q=render+markdown)
{
  "query": "md.render",
  "resolved": {                                  // exact-name resolution (null for a ?q= phrase)
    "tool": "md.render", "status": "installable", "category": "md",
    "provider": { "kind": "pack", "name": "markdown-tools", "listingId": "lst-1" },
    "unit": { "name": "markdown-tools", "kind": "pack", "source": "cupboard", "listingId": "lst-1" }
  },
  "matches": [ /* ranked candidates; the exact resolution leads */ ],
  "cupboardReachable": true
}
```

An installable match carries `provider.listingId` + `unit` — that *is* the
install action: the UI routes it to the listing's install-consent flow, the
same surface `cupboard:install-deps` acts on.

### Cupboard UI discovery (P-007)

The storefront's **Tools** view (`/cupboard?kind=tools`) wires the above to the
chrome: the shared search box runs capability search, a **status filter** (All /
Available / Installable) and **category facet chips** (the tool namespaces)
narrow the result, and each row shows its capability description. All three are
URL-backed (`?q=` / `?toolStatus=` / `?cat=`, nuqs) so an agent can drive them
via `ui:dispatch`.

## Source map

| Concern                                                    | Source                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure pack model + resolver                                 | `libs/papercusp/packages/blueprint-distribution/src/pack-model.ts`                                                                                                                                                                                                           |
| Live pack catalog (operator wiring)                        | `packages/operator-core/lib/cupboard/pack-catalog.ts`                                                                                                                                                                                                                        |
| Pack purity validation                                     | `packages/plugin-loader/src/index.ts` (`validate`, `runtimeDispatch`)                                                                                                                                                                                                        |
| Manifest schema (`kind`, `dependencies`)                   | `packages/plugin-sdk/papercusp-plugin.schema.json`                                                                                                                                                                                                                           |
| Install gate                                               | `packages/operator-core/lib/cupboard/install-plugin-core.ts` + `…/routes/cupboard-install-plugin.ts`                                                                                                                                                                         |
| Install loop (pure)                                        | `packages/operator-core/lib/cupboard/resolve-and-install.ts`                                                                                                                                                                                                                 |
| Install IO (shared seam)                                   | `packages/operator-core/lib/cupboard/install-io.ts`                                                                                                                                                                                                                          |
| `cupboard:install-deps` tool/route                         | `packages/operator-core/lib/endpoint-route/routes/cupboard-install-deps.ts`                                                                                                                                                                                                  |
| `harness:create { autoInstallDeps }`                       | `packages/operator-core/lib/agent-tools/harness/create.ts`                                                                                                                                                                                                                   |
| End-to-end loop proof                                      | `packages/operator-core/lib/cupboard/resolve-and-install.e2e.test.ts`                                                                                                                                                                                                        |
| Reference pack                                             | `libs/papercusp/plugins/example-tool-pack/`                                                                                                                                                                                                                                  |
| Dep validator (pure)                                       | `libs/papercusp/packages/blueprint-distribution/src/blueprint-deps.ts`                                                                                                                                                                                                       |
| Worker schema + routes (`provides_tools`, kind set)        | `apps/operator-public/migrations/006_pack_kind_provides_tools.sql` + `apps/operator-public/migrations/008_learning_pack_kind_review_status.sql` + `apps/operator-public/src/db.ts` (`LISTING_KINDS`, `normalizeListingKind`) + `apps/operator-public/src/routes/listings.ts` |
| Publish route (pack-aware)                                 | `packages/operator-core/lib/endpoint-route/routes/cupboard-publish-plugin.ts`                                                                                                                                                                                                |
| Tools discovery (route + projection)                       | `packages/operator-core/lib/endpoint-route/routes/cupboard.ts` (`GET /cupboard/tools`) + `packages/operator-core/lib/cupboard/tools-discovery.ts`                                                                                                                            |
| Capability search (pure scorer)                            | `packages/operator-core/lib/cupboard/tools-search.ts` (`searchTools`, `categoryOf`)                                                                                                                                                                                          |
| "What provides X" resolver                                 | `packages/operator-core/lib/endpoint-route/routes/cupboard.ts` (`GET /cupboard/provides`) → `buildToolProvenance` in `tools-discovery.ts`                                                                                                                                    |
| Storefront UI (Packs tab + Tools view + discovery filters) | `apps/operator/app/cupboard/CupboardClient.tsx` + `apps/operator/app/cupboard/ToolsSection.tsx`                                                                                                                                                                              |
