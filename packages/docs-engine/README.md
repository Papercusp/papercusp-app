# @papercusp/docs-engine

Source-agnostic docs retrieval. The engine functions (`outline`, `get`,
`search`) and an MDX-to-markdown pipeline operate on a pluggable
`DocSource` adapter — one implementation, many surfaces. Each docs surface
(public Papercusp docs, per-harness docs, internal-engineering docs)
registers thin `defineTool` wrappers that instantiate an adapter and call
the engine.

## Layout

| Entry | Contents |
| --- | --- |
| `@papercusp/docs-engine` | The engine: `buildOutline`, `getDocs`, `searchDocs`, the MDX renderers (`renderMdxToMarkdown`), and the bundled adapters. |
| `@papercusp/docs-engine/types` | The `DocSource` contract + payload types (`OutlinePayload`, `GetResult`, `SearchResult`, …). |
| `@papercusp/docs-engine/adapters/harness-fs` | The per-harness filesystem adapter. |

## The `DocSource` contract

An adapter (see `src/types.ts` → `DocSource`) supplies the engine with the
raw doc tree and page bytes; the engine owns the outline assembly, the
`get` payload budgeting (`MAX_PAYLOAD_BYTES`), the BM25-ish `search`
tokenizer, and the MDX → markdown rendering. Three adapters ship today:

- `harnessFsAdapter` — per-harness docs on disk.
- `genericFsAdapter` — any MDX/markdown directory tree.
- `starlightContentAdapter` — a Starlight `content/docs` collection.

## Design

- **One engine, many surfaces.** Add a docs surface by writing a
  `DocSource` adapter, not by reimplementing outline/get/search.
- **MDX is rendered to plain markdown** (`remark-mdx-to-markdown`) so JSX
  components are stripped for agent/tool consumption.
- Results are cached per run (`per-run-cache.ts`).

Extracted/audited per `papercusp-systems-abstraction-2026-05-29` (D-007):
zero `harness_shared.*` / `@papercusp/db-org` / domain-type imports.
