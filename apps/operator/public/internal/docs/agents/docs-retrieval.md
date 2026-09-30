# Docs retrieval
URL: /internal/docs/agents/docs-retrieval

The docs-engine package, the doc surfaces, and how agents read documentation across them.

import { Aside } from '@astrojs/starlight/components';

How an agent finds documentation in Papercusp. One engine, several surfaces, context-aware tool routing.

## The doc surfaces

| Surface                   | `surface` value                | URL prefix                                      | Filesystem                                                                          | Who reads it                                                                                                                                                   |
| ------------------------- | ------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Public Papercusp docs** | (human site, no agent surface) | `/docs`                                         | `apps/papercusp-docs/src/content/docs/` (Starlight)                                 | Humans browsing the public docs site                                                                                                                           |
| **Engineering reference** | `engineering`                  | `/internal/docs`                                | `apps/operator-docs/src/content/docs/` (Starlight)                                  | This page lives here. Engineering material — endpoint-system, plugins, agents, etc. Loopback-gated, and `papercusp-su`-only as an agent surface (D-005/P-016). |
| **Per-harness docs**      | `harness`                      | (no public URL; `/project-docs?harness=<slug>`) | `<projectPath>/docs/` + state files                                                 | Each harness's own SPEC, AGENTS, plans, `.papercusp/{knowledge,supervisor-notes,validation-contract}.md`                                                       |
| **Project docs**          | `project`                      | (none)                                          | `PAPERCUSP_PROJECT_DOCS_ROOT` (genericFsAdapter over an arbitrary markdown/MDX dir) | An out-of-harness caller pointed at a project's own docs via the env var (D-001/P-004)                                                                         |

There's no "public surface for agents." Agents see *either* engineering reference, a specific harness, *or* a project-docs root — never the human-facing public site.

## The engine: `@papercusp/docs-engine`

Pure functions operating on a `DocSource` adapter. The engine owns 100% of the retrieval logic; the per-surface tool wrappers stay mechanical (no retrieval logic of their own) but aren't tiny — each `docs:*` wrapper is \~145–170 lines (`docs/outline.ts` 167, `docs/get.ts` 172, `docs/search.ts` 144), carrying an explicit-scope gate (below) + a `resolveAdapter()` three-way branch plus a `defineTool` block (description/guidance/args/handler). The `cross_harness/docs_*` wrappers are smaller (\~77–95 lines) since they skip the context-resolution branch.

### Public API

```ts
// Engine functions
buildOutline(source, ctx)        → OutlinePayload
getDocs(source, args, ctx)        → GetResult       (batch, heading-slice, 50KB cap, suggestions)
searchDocs(source, args, ctx)     → SearchResult    (title×4, desc×2, body×1)

// Adapters
starlightContentAdapter(opts)     → DocSource       // walks a Starlight content tree on disk
harnessFsAdapter(projectPath)     → DocSource       // walks <projectPath>/docs/ + state files
genericFsAdapter(root, opts)      → DocSource       // walks an arbitrary markdown/MDX dir

// Cache
RunCache<T>                       // per-run LRU keyed by runId ?? spawnId

// Rendering
renderMdxToMarkdown(raw, absPath) → markdown       // MDX → clean markdown (strips JSX)
withPreamble(body, meta)          → '# title\nURL: ...\n\n' + body
```

`DocSource` is the seam: `listPages`, `getPage`, `getContent`, optional `getSectionMeta`. Any source that can answer those becomes a first-class doc surface.

### Engine guarantees (handled once, used everywhere)

* `ctx.signal.aborted` checked at every async boundary; functions throw on cancel
* `ctx.metadata({ surface, requested, found, ... })` for telemetry (lands in `tool_invocations.metadata_json`)
* `ctx.progress(pct, msg)` emission during `searchDocs` for clients that subscribe
* Per-run cache via `RunCache` — keyed by `runId ?? spawnId`, optional scope
* Heading-slice via TOC anchors; rejects with `heading_not_found` if missing
* Levenshtein-nearest suggestions on `not_found` (ratio ≤ 0.3, k=3)
* 50KB body cap with truncation tail naming the first H2 anchor
* JSX cleanup via `remark-mdx-to-markdown` plugin (Callout → blockquote, Tabs/Steps unwrapped)

## The tools

### `docs:*` — context-aware

Three tools (`outline`, `get`, `search`). Each takes an optional `harness` arg. Before the adapter is picked, the handler runs it through the shared **explicit-scope gate** — `resolveHarnessScope(args.harness, ctx)` in `packages/operator-core/lib/agent-tools/_harness-scope.ts` (the same helper `plans:*` and other harness-scoped tools use) — and only then hands the resolved scope to each tool's own `resolveAdapter()`.

`resolveHarnessScope` returns one of three outcomes, in this precedence:

1. an explicit `harness: 'all'` (or the raw `'*'` papercup) arg → `{ kind: 'all' }` — deliberate operator/cross-harness scope, regardless of session.
2. an explicit concrete `harness: '<slug>'` arg → `{ kind: 'harness', slug }` — always wins over the session's own scope.
3. no arg, and the session's `ctx.harnessSlug` is a **concrete** slug → `{ kind: 'harness', slug }` (a worker/scoper/validator etc. spawned with `?harness=<slug>`).
4. no arg, and `ctx.harnessSlug` is unset **or** the operator/SU auto-default `'*'` → `{ kind: 'none' }`.

A `'none'` result short-circuits immediately to `{ error: 'harness_required', detail: HARNESS_REQUIRED_DETAIL }` — `resolveAdapter()` is never called. This is a deliberate explicit-opt-in gate (`feat(docs): explicit harness scope`, 2026-05-31): it replaced an older silent fallback where an unscoped SU/operator call (whose ctx defaults to the `'*'` wildcard) auto-defaulted straight to the engineering reference. Now that auto-default counts as "no explicit choice," and the caller must actively pass `harness: 'all'` to reach project/engineering scope — a caller who simply forgot to scope gets a loud error, not silently-wrong data.

Once scoped, `resolveAdapter(effectiveSlug, { isSuperuser })` (`effectiveSlug` is `'*'` for `{ kind: 'all' }`, or the concrete slug) resolves the adapter:

* **`{ kind: 'harness', slug }`** → *that harness's* docs via `harnessFsAdapter(resolveHarnessContentPath(reg, slug) ?? project.path)`. The content path is resolved override-aware, not from the bare `project.path`. An unregistered slug → `{ error: 'harness_not_registered', slug }`.
* **`{ kind: 'all' }`** (`effectiveSlug === '*'`) — resolution order is **strict and checked in this order**:
  1. `PAPERCUSP_PROJECT_DOCS_ROOT` set → `genericFsAdapter` over that dir, `surface: 'project'`.
  2. else if the caller is `papercusp-su` (`isSuperuser`) → the `engineeringAdapter` (`starlightContentAdapter` over `apps/operator-docs/src/content/docs/`, defined in `_engineering-adapter.ts`), `surface: 'engineering'`.
  3. else → `{ error: 'no_docs_source' }`. Engineering is **not** the unconditional default: a non-SU caller who explicitly passes `harness: 'all'` with no `PAPERCUSP_PROJECT_DOCS_ROOT` gets the error envelope, not the engineering reference. This is a deliberate confinement so Papercusp's own engineering docs don't leak to non-SU callers (D-005/P-016).

```ts
// Both callers use the same tool. Source picked by context (or the `harness` arg).
docs:outline { harness? } → { surface: 'harness'|'engineering'|'project', sections: [...], cached: bool }
docs:get { slugs, heading?, harness? } → { results: [...], surface }
docs:search { query, limit?, harness? } → { hits: [...], surface }
// harness state files (SPEC, AGENTS, .papercusp/*) surface under a synthetic `harness-state/` section.
```

Symmetric with the existing context-aware tool family (`harness:status`, `harness:list_features`, etc.). Same name, different content per caller — no second mental model.

### `cross_harness:docs_*` — explicit-slug

Three tools for agents outside any harness who need to read a specific harness's docs (typical SU use case). Takes required `harnessSlug` and optional `workspaceId` args:

```ts
cross_harness:docs_outline { harnessSlug, workspaceId? }
cross_harness:docs_get { harnessSlug, workspaceId?, slugs, heading? }
cross_harness:docs_search { harnessSlug, workspaceId?, query, limit? }
```

Roles: `['operator', 'oracle']` + superuser bypass. Workers don't see them (and don't need them — they're in their own harness). `cross_harness:docs_get` carries a per-run quota of `operator: { perRun: 15 }`.

### Why not collapse to one tool with a `surface` arg?

Considered and rejected. Trade-offs:

* Authorization: `roles: [...]` per surface is dispatcher-enforced. Surface-as-arg would require runtime checks inside handlers (silent failure mode if forgotten).
* Catalog clarity: distinct tool names in agent\_tools:list; one tool with a hidden arg invites misuse.
* Telemetry: `tool_invocations.tool_name` partitions naturally.
* Symmetry: the codebase already has `cross_harness:*` for "explicit-slug variants of harness-context tools" (`cross_harness:inbox`, `cross_harness:outbox`). Docs follow the pattern.

## MCP Resources

Two URI families exposed via `defineResource`:

```
papercusp://docs/index                       — engineering sitemap (text/plain)
papercusp://docs/section/{section}           — one entry per engineering section (markdown)

papercusp://harness/{slug}/docs/index        — one entry per registered harness (sitemap)
papercusp://harness/{slug}/docs/section/{section}  — per (harness, section) consolidated markdown
```

Resources are URI-keyed; they have no caller context. The default `papercusp://docs/*` URI returns engineering reference (the same content non-harness `docs:*` callers see), matching what an MCP client (Cursor, Claude Desktop) pointed at our endpoint would expect from "the Papercusp docs."

## HTTP routes (served by the Hono host, outside the endpoint system)

The Starlight build emits the docs site plus its `llms.txt` / per-page markdown twins into `apps/operator/public/internal/docs/` (see `apps/operator-docs/scripts/emit-md-twins.ts`). The Hono host (`apps/operator/bin/host-docs.ts`) serves them as static files:

```
GET /internal/docs/llms.txt         — engineering sitemap
GET /internal/docs/<slug>           — the Starlight page (or its `.md` twin)
```

These are static files served by the Hono host's docs router, not `defineTool` projections — per the [endpoint-system overview](/internal/docs/endpoint-system/overview), the framework is for request → response tool calls, not arbitrary HTTP routes.

The `/internal/docs/*` router is loopback-gated in `apps/operator/bin/host-docs.ts` via `isLoopbackHost` (from `loopback-guard.ts`, Host-header check). Off-loopback callers get 403 unless `PAPERCUSP_INTERNAL_DOCS_BYPASS=1`. The public `/docs/*` site (served by `host-docs-public.ts`) is NOT gated.

## Prompt injection — finding-context

`apps/operator-docs/src/content/docs/agents/finding-context.mdx` is the only page from the docs surface that gets injected into every spawned agent's system prompt. The orchestrator locates the agents-docs dir via `resolveOperatorDocsAgentsDir()` (in `@papercusp/orchestrator`'s `invoke.ts`) and passes the page through `buildPrompt` as a `sharedGuides` section (Section 3b — see [prompt-assembly](/internal/docs/agents/prompt-assembly#section-3b---shared-cross-role-guides)).

The page documents the retrieval surfaces for agents — same content humans browse, also pasted into every prompt. One source of truth.

## File map

```
packages/docs-engine/
├── package.json                          @papercusp/docs-engine
├── src/
│   ├── index.ts                          public exports
│   ├── types.ts                          DocSource, EngineCtx, OutlinePayload, GetResult, SearchResult
│   ├── outline.ts                        buildOutline
│   ├── get.ts                            getDocs (batch + heading-slice + cap + suggestions)
│   ├── search.ts                         searchDocs (title×4 desc×2 body×1)
│   ├── shared.ts                         levenshtein, sliceByHeading, reactToText, ...
│   ├── per-run-cache.ts                  RunCache<T>
│   ├── render-mdx.ts                     renderMdxToMarkdown, withPreamble
│   ├── remark-mdx-to-markdown.ts         JSX cleanup plugin
│   └── adapters/
│       ├── starlight.ts                  starlightContentAdapter
│       ├── harness-fs.ts                 harnessFsAdapter
│       └── generic-fs.ts                 genericFsAdapter
└── __tests__/                            unit tests (mock DocSource + adapters)

packages/operator-core/lib/agent-tools/
├── _harness-scope.ts                     resolveHarnessScope / HARNESS_REQUIRED_DETAIL (shared explicit-scope gate; also used by plans:*)
├── docs/
│   ├── outline.ts                        docs:outline      (context-aware)
│   ├── get.ts                            docs:get          (context-aware)
│   ├── search.ts                         docs:search       (context-aware)
│   ├── _engineering-adapter.ts           engineeringAdapter (starlight over operator-docs)
│   ├── _repo-paths.ts                    DOCS_CONTENT_ROOT / LLMS_TXT_PATH resolution
│   ├── resource-index.ts                 papercusp://docs/index
│   ├── resource-section.ts               papercusp://docs/section/{section}
│   └── __tests__/routing.test.ts         resolveAdapter branching tests
└── cross_harness/
    ├── docs_outline.ts                   cross_harness:docs_outline
    ├── docs_get.ts                       cross_harness:docs_get
    ├── docs_search.ts                    cross_harness:docs_search
    ├── docs-resource-index.ts            papercusp://harness/{slug}/docs/index
    ├── docs-resource-section.ts          papercusp://harness/{slug}/docs/section/{section}
    └── __tests__/docs.test.ts            wrapper error + workspaceId tests

apps/operator-docs/src/content/docs/      Starlight engineering-docs content tree
apps/operator-docs/scripts/emit-md-twins.ts  emits llms.txt + per-page .md twins

apps/operator/bin/host-docs.ts             Hono router for /internal/docs/* (loopback-gated)
apps/operator/bin/host-docs-public.ts      Hono router for /docs/* (public, not gated)
```

## Adding a new doc surface

If you need a fourth surface (e.g. a customer's external doc site as a `DocSource`), the pattern is:

1. Write an adapter in `packages/docs-engine/src/adapters/<name>.ts` that returns a `DocSource`
2. Register three tools (`<scope>:docs_outline/get/search`) that instantiate the adapter and call the engine functions
3. Register the matching MCP resources at `papercusp://<scope>/...`
4. Add adapter tests in `packages/docs-engine/__tests__/<name>-adapter.test.ts`

The engine doesn't change. Wrappers carry no retrieval logic of their own — copy `docs/outline.ts` or `cross_harness/docs_outline.ts` and swap the adapter — but they're \~140–170 lines (or \~77–95 for the cross\_harness shape), most of it the `resolveAdapter()` branch and the `defineTool` block, not 30-line stubs.

## See also

* [Finding context](/internal/docs/agents/finding-context) — the prompt-injected retrieval decision tree
* [Prompt assembly](/internal/docs/agents/prompt-assembly#section-3b---shared-cross-role-guides) — Section 3b explains the sharedGuides injection layer
* [Endpoint system overview](/internal/docs/endpoint-system/overview) — the framework `defineTool` + `defineResource` project onto
