# papercusp-search — composition GUIDE

**Papercusp Official: Search.** This aspect template wires the search
generic-library family into a composed app: BM25 + pgvector hybrid retrieval
over the app's own Postgres, rank fusion, an optional cross-encoder precision
pass, and the engine-agnostic relevance core. Everything here is **Tier A**
(plain libraries) — compose and modify freely; the MUSTs are about wiring
shape, not code ownership.

## MUST — consult the live papercusp docs when this GUIDE is not enough

You are building ON a live papercusp install (we dogfood papercusp in
papercusp). If anything in this GUIDE is insufficient — a component's API, a
seam convention, a release step — do NOT guess:

- read the papercusp documentation served on your install at **`/internal/docs`**
  (start with the `agent-insights` section; this template's `template.yaml`
  `docs:` list names its canonical pages), and
- inspect the **operator app** itself — it is a running reference instance of
  every pattern these templates encode.

## The construction (orientation)

The search plane has four legs, cheap→rich; take only what the app needs:

1. **Retrieval** — `@papercusp/search`: a host-agnostic engine over the app's
   Postgres. You register a **SearchSource** per searchable surface — each
   source owns its own tsvector/pgvector SQL, so the engine never couples to
   your schema. Runs BM25-only out of the box. The `SearchSource` handle is
   a **postgres-js `Sql`** tagged-template function (the `postgres`
   package), NOT node-postgres (`pg`) — wire your data layer with
   postgres-js from the start (WI-2872; the data-layer GUIDE says the
   same), or budget for an adapter.
2. **Fusion** — `@papercusp/rrf`: pure Reciprocal Rank Fusion. Turns on when
   you have a second ranking to fuse — canonically BM25 + vector similarity
   (hybrid mode needs a query embedder injected; bring your own provider).
3. **Precision pass** — `@papercusp/rerank`: engine-agnostic cross-encoder
   reranking (ZeroEntropy zerank; needs an API key). Re-orders the fused
   candidate list by true query⇄document relevance.
4. **Relevance core** — `@papercusp/search-core`: instruction-following rerank
   steering, live LLM category-match, brand-aware query rewrite, tiered
   escalation, and the shared eval-harness metric contract that makes
   relevance measurable instead of vibes.

## MUST

- Search queries the app's OWN embedded Postgres (the
  `embedded-postgres-server` pattern from `papercusp-tauri-desktop-shell`) — do NOT
  stand up a separate search engine/service; the whole point of this family
  is search without new infrastructure.
- Each searchable surface is its own SearchSource owning its SQL — never
  route multiple entity kinds through one source with schema switches.
- Keep secrets out of the composition: the rerank leg's ZeroEntropy key and
  any embedding-provider key are injected config, never committed.
- Declare every component you keep as a real dependency — the
  `components-integrated` check fails a composition that was wired "on
  paper".

## SHOULD

- Start BM25-only and add the vector leg when the app actually has an
  embedding pipeline (decision point `retrieval-mode`) — hybrid without good
  embeddings is worse than plain BM25.
- Build the eval set early (decision point `relevance-evals`): a handful of
  golden queries against search-core's metric contract catches relevance
  regressions the moment you tune anything.
- Serve search over the sidecar host (`hono-host`) as a plain `/api` route;
  pair with `papercusp-data-sync` when result surfaces must stay live.

## FREE

- Which surfaces are searchable, tsvector/pgvector column shapes, fusion
  weights, rerank steering instructions, escalation tiers, and whether the
  precision stack (rerank + search-core) exists at all — drop both from your
  composition when plain retrieval suffices.

## Checks

`checks/components-integrated.test.ts` — configure the `components` section of
your `TEMPLATE_CHECKS_CONFIG` with the package names you kept. Unconfigured it
skips; see `checks/README.md`.
