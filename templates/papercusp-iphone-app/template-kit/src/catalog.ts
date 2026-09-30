/**
 * The curated component catalog — the machine-readable SOURCE OF TRUTH for
 * template-composable components (plan app-templates-2026-07-04 P-004).
 *
 * The human docs page (operator-docs
 * `agent-insights/templates-component-catalog`) is a PROJECTION of this
 * array — edit HERE, then mirror the docs table. `catalog.test.ts` validates
 * every entry (format + unique ids + resolvable composesWith), which is the
 * "manifests validate" acceptance; the anti-rot gym (P-009) re-checks entries
 * against the living repos.
 *
 * Membership is curated in code (the BORROWABLE.md precedent: tagging never
 * requires a submodule commit). `pattern` entries describe a documented shape
 * whose canonical form lives in the reference apps; `package` entries are
 * extracted, directly consumable code.
 */
import type { ComponentManifest } from "./component-manifest.js";

export const COMPONENT_CATALOG: ComponentManifest[] = [
  {
    id: "plan-parser",
    version: "0.1.0",
    tier: "A",
    kind: "package",
    provides: [
      "plan-document-parsing",
      "project-history-schema",
      "project-history-assembler",
    ],
    composesWith: [],
    source: {
      repo: "Papercusp/plan-parser",
      path: "libs/generic/plan-parser",
      package: "@papercusp/plan-parser",
    },
    tests:
      "npm test in the lib (vitest); the installed papercusp project-history CLI exercises the provider boundary end to end",
    summary:
      "Pure plan-document algebra plus the versioned Project History read-model contract and assembler. " +
      "The package owns schema and deterministic assembly; the installed papercusp CLI supplies Papercusp-ledger and Git I/O, " +
      "so consuming apps keep only a thin generated-artifact adapter.",
  },
  {
    id: "pot-app-seam",
    version: "0.1.0",
    tier: "B",
    kind: "package",
    provides: ["hive-bootstrap", "domain-work-items-transport", "ingest-loop"],
    composesWith: [
      "typed-contracts",
      "hono-host",
      "embedded-postgres-server",
      "tauri-shell",
    ],
    source: {
      repo: "Papercusp/pot-app-seam",
      path: "libs/generic/pot-app-seam",
      package: "@papercusp/pot-app-seam",
    },
    tests:
      "npm test in the lib (17 vitest tests); consumed with app tests unmodified in both internal reference apps",
    summary:
      "The ONE app⇄hive seam (Tier B component #1): first-run hive bootstrap (bundled-blueprint local install + " +
      "idempotent fingerprint marker + ensure-hive), the generic domain work-items transport over " +
      "/api/harness/:slug/work-items (UP: enqueue kind:'task' items carrying the payload.domainKind envelope; " +
      "DOWN: fetchCompleted() returns untrusted payload.out for the app-owned contract gate), and the best-effort " +
      "poll ingest loop. Contract gates, storage, and app defaults stay app-side by design. The source repo is " +
      "papercusp-internal; consume the copy VENDORED in the public templates mirror as pot-app-seam/ (file:-link " +
      "it — see the templates README, Supply chain).",
    guide: "agent-insights/templates-system-design",
  },
  {
    id: "tauri-shell",
    version: "0.0.1",
    tier: "A",
    kind: "pattern",
    provides: [
      "desktop-window-lifecycle",
      "sidecar-process-lifecycle",
      "packaged-sidecar-resolution",
    ],
    composesWith: ["hono-host", "embedded-postgres-server"],
    source: {
      path: "internal reference app: apps/desktop/src-tauri/src/main.rs (extraction = P-003)",
    },
    tests:
      "reference apps' shells build + boot E2E (deb proven green 2026-07-04); packaged-sidecar checks land with P-003",
    summary:
      "The thin Tauri 2 host pattern — a HOST, not the app: pick a free port, spawn the Node sidecar " +
      "(packaged: resource_dir()/dist-sidecar + vendored bin/node + bundled_path_env; dev: repo dist-sidecar), " +
      "poll the operator.json discovery file until the Hono host is live, open the WebviewWindow at that port, " +
      "and SIGTERM the sidecar on close. Everything app-shaped lives in the SPA + sidecar. " +
      "Generalization into a reusable skeleton is P-003 (sequenced behind the packaged-build verification).",
    guide: "agent-insights/templates-system-design",
  },
  {
    id: "embedded-postgres-server",
    version: "0.0.1",
    tier: "A",
    kind: "pattern",
    provides: ["embedded-postgres", "db-lifecycle", "connection-discovery"],
    // The discovery half IS an extracted, shared package, so it is carried as a
    // resolvable catalog edge rather than as prose in source.package — this is a
    // `pattern` (two app-local copies of the SERVER half), so it has no npm
    // package of its own to name (EI-21113414214889358).
    composesWith: ["hono-host", "pot-app-seam", "embedded-pg-discovery"],
    source: {
      path: "both internal reference apps: libs/embedded-postgres-server (an app-local package each)",
    },
    tests:
      "each app's PG-backed integration suites (testcontainers global setup) exercise it end-to-end",
    summary:
      "Per-app embedded Postgres: download/extract-free native PG via embedded-postgres, boot/stop lifecycle " +
      "bound to the sidecar, migrations on boot, and connection-URL discovery via @papercusp/embedded-pg-discovery " +
      "(env → JSON discovery file → fallback). Currently two app-namespaced copies of the server half — a " +
      "promotion candidate to one @papercusp package; the discovery half is already extracted + shared.",
  },
  {
    id: "tauri-release-kit",
    version: "0.1.0",
    tier: "A",
    kind: "package",
    provides: [
      "desktop-build-orchestration",
      "release-channels",
      "updater-manifest",
      "artifact-classification",
    ],
    composesWith: ["tauri-shell"],
    source: {
      repo: "Papercusp/tauri-release-kit",
      path: "libs/generic/tauri-release-kit",
      package: "@papercusp/tauri-release-kit",
    },
    tests:
      "npm test in the lib (vitest); driven for real by both internal reference apps' bin/release.ts",
    summary:
      "Provider-agnostic Tauri desktop build+release orchestration: a pure core (version bump, channel/tag " +
      "resolution, latest.json updater-manifest generation, artifact classification) plus a per-target driver " +
      "registry (Linux-local, Mac/Windows over an SSH frame), with the app-specific sidecar build injected via a " +
      "buildSidecar() seam and all side effects behind Exec/Fs/Log ports. Zero domain coupling, zero runtime deps.",
  },
  {
    id: "typed-contracts",
    version: "0.0.1",
    tier: "B",
    kind: "pattern",
    provides: ["contract-schema", "single-parse-gate", "payload-validation"],
    composesWith: ["pot-app-seam"],
    source: {
      path: "internal reference apps: the contracts packages (parseCandidateSet/PurchaseResearchInputSchema; SignalSchema)",
    },
    tests:
      "contract packages' own vitest suites + every seam test that round-trips a payload through the gate",
    summary:
      "The typed-contract pattern — the MANDATORY down-leg discipline of the one seam: a dedicated contracts " +
      "package owns the zod schemas for what crosses the app⇄hive boundary (input payloads wire-validated at " +
      "enqueue; agent outputs parsed through ONE gate before touching app tables; rejects emitted UP as events, " +
      "never silently dropped). An app composes pot-app-seam with ITS OWN contracts package — the seam " +
      "deliberately ships no validation.",
    guide: "agent-insights/templates-system-design",
  },
  {
    id: "hono-host",
    version: "0.0.1",
    tier: "A",
    kind: "pattern",
    provides: [
      "sidecar-http-host",
      "operator-json-discovery",
      "spa-serving",
      "sse-streams",
    ],
    composesWith: ["tauri-shell", "embedded-postgres-server", "pot-app-seam"],
    source: {
      path: "internal reference apps: apps/desktop/bin/serve.ts + apps/desktop/src/_hono/",
    },
    tests:
      "each app's _hono route integration suites (real PG + fake transports)",
    summary:
      "The Node sidecar host pattern: a Hono app serving the SPA + /api routes on a free localhost port, " +
      "operator.json written to the app home for shell/CLI discovery (port + pid, removed on shutdown), SSE " +
      "streams for table-less moments, graceful SIGTERM shutdown (host close → sync stop → PG stop → discovery " +
      "file removal), and env-gated optional planes so boot without config changes nothing.",
  },

  // ---- P-017: the data-sync component family (papercusp-data-sync template) ----
  {
    id: "sync",
    version: "0.0.1",
    tier: "A",
    kind: "package",
    provides: [
      "state-sync-transport",
      "sse-sync-client",
      "reconnect-backpressure",
    ],
    composesWith: ["sse", "projection-index", "debounce-coalesce", "hono-host"],
    source: {
      repo: "Papercusp/papercup",
      path: "libs/generic/sync",
      package: "@papercusp/sync",
    },
    tests: "npm test in the lib (vitest)",
    summary:
      "Schema-agnostic sync transports (Zero + SSE) with reconnect and backpressure handling — the client half " +
      "of live app-state sync: subscribe to server changes, survive drops, and never overrun a slow consumer.",
    guide: "agent-insights/templates-system-design",
  },
  {
    id: "sse",
    version: "0.0.1",
    tier: "A",
    kind: "package",
    provides: ["sse-response-builder", "sse-channel-bus", "pg-notify-bridge"],
    composesWith: ["sync", "hono-host", "embedded-postgres-server"],
    source: {
      repo: "Papercusp/papercup",
      path: "libs/generic/sse",
      package: "@papercusp/sse",
    },
    tests: "npm test in the lib (vitest)",
    summary:
      "Spec-compliant Server-Sent Events primitives — the server half of live sync: an SSE response builder for " +
      "any fetch-style host (Hono drop-in), an in-process channel bus, and a PG NOTIFY bridge so table changes " +
      "stream to subscribed clients without polling.",
  },
  {
    id: "projection-index",
    version: "0.1.0",
    tier: "A",
    kind: "package",
    provides: ["event-maintained-projection", "structured-index"],
    composesWith: ["sync", "sse", "embedded-postgres-server"],
    source: {
      repo: "Papercusp/papercup",
      path: "libs/generic/projection-index",
      package: "@papercusp/projection-index",
    },
    tests: "npm test in the lib (vitest)",
    summary:
      "A generic event-maintained structured→index projection: feed it source records as they change and it " +
      "keeps a queryable index current — the read-model half of a synced data plane (derived views stay fresh " +
      "without rebuild jobs).",
  },
  {
    id: "debounce-coalesce",
    version: "0.1.0",
    tier: "A",
    kind: "package",
    provides: ["wake-floor-debounce", "burst-coalesce"],
    composesWith: ["sync", "sse", "projection-index"],
    source: {
      repo: "Papercusp/papercup",
      path: "libs/generic/debounce-coalesce",
      package: "@papercusp/debounce-coalesce",
    },
    tests: "npm test in the lib (vitest)",
    summary:
      "Per-subscriber wake-floor + burst-coalesce primitive: a leading-edge debounce that enforces a minimum " +
      "wake interval and folds change bursts into one delivery — what keeps a live sync plane from stampeding " +
      "its consumers.",
  },
  {
    id: "resumable-download",
    version: "0.1.0",
    tier: "A",
    kind: "package",
    provides: ["resumable-http-download", "streaming-checksum"],
    composesWith: ["sync", "hono-host"],
    source: {
      repo: "Papercusp/papercup",
      path: "libs/generic/resumable-download",
      package: "@papercusp/resumable-download",
    },
    tests: "npm test in the lib (vitest)",
    summary:
      "Generic, domain-free resumable HTTP downloader with streaming checksum verification (HTTP Range resume) — " +
      "the large-asset leg of data sync: interrupted transfers continue where they stopped and corruption is " +
      "caught in-stream.",
  },

  // ---- P-018: the search component family (papercusp-search template) ----
  {
    id: "search",
    version: "0.1.0",
    tier: "A",
    kind: "package",
    provides: [
      "bm25-search",
      "hybrid-vector-search",
      "pluggable-search-sources",
    ],
    composesWith: [
      "rrf",
      "search-core",
      "embedded-postgres-server",
      "hono-host",
    ],
    source: {
      repo: "Papercusp/papercup",
      path: "libs/generic/search",
      package: "@papercusp/search",
    },
    tests: "npm test in the lib (vitest)",
    summary:
      "Host-agnostic BM25 + pgvector hybrid search over Postgres: the host registers pluggable SearchSources " +
      "(each owning its tsvector/pgvector SQL); the engine runs BM25-only or BM25+embeddings fused via RRF. " +
      "PG handle + query embedder are injected — zero schema coupling, zero embedding-provider dependency.",
    guide: "agent-insights/templates-system-design",
  },
  {
    id: "search-core",
    version: "0.1.0",
    tier: "A",
    kind: "package",
    provides: [
      "rerank-steering",
      "llm-category-match",
      "query-rewrite",
      "search-eval-contract",
    ],
    composesWith: ["rerank", "search"],
    source: {
      repo: "Papercusp/papercup",
      path: "libs/generic/search-core",
      package: "@papercusp/search-core",
    },
    tests: "npm test in the lib (vitest)",
    summary:
      "Engine-agnostic search-relevance core: instruction-following rerank steering, live LLM category-match, " +
      "brand-aware query rewrite, tiered escalation, and the shared eval-harness metric contract. Builds on " +
      "@papercusp/rerank; no engine or catalog-schema dependencies.",
  },
  {
    id: "rerank",
    version: "0.1.0",
    tier: "A",
    kind: "package",
    provides: ["cross-encoder-rerank"],
    composesWith: ["search-core", "search"],
    source: {
      repo: "Papercusp/papercup",
      path: "libs/generic/rerank",
      package: "@papercusp/rerank",
    },
    tests: "npm test in the lib (vitest)",
    summary:
      "Engine-agnostic cross-encoder reranking (ZeroEntropy zerank): re-order a candidate list by true " +
      "query⇄document relevance as a final precision pass over any retrieval engine's output.",
  },
  {
    id: "rrf",
    version: "0.1.0",
    tier: "A",
    kind: "package",
    provides: ["reciprocal-rank-fusion"],
    composesWith: ["search"],
    source: {
      repo: "Papercusp/papercup",
      path: "libs/generic/rrf",
      package: "@papercusp/rrf",
    },
    tests: "npm test in the lib (vitest)",
    summary:
      "Reciprocal Rank Fusion — combine multiple ranked result lists into one. Pure and zero-dependency; the " +
      "canonical use is fusing a BM25 ranking with a vector-similarity ranking, but it is domain-agnostic.",
  },

  // ---- P-019: the embedded data-layer family (papercusp-data-layer template) ----
  // (embedded-postgres-server + typed-contracts already cataloged above.)
  {
    id: "embedded-pg-discovery",
    version: "0.1.0",
    tier: "A",
    kind: "package",
    provides: ["pg-connection-discovery", "env-discovery-fallback-resolution"],
    composesWith: ["embedded-postgres-server", "hono-host", "tauri-shell"],
    source: {
      repo: "Papercusp/papercup",
      path: "libs/generic/embedded-pg-discovery",
      package: "@papercusp/embedded-pg-discovery",
    },
    tests: "npm test in the lib (vitest)",
    summary:
      "Generic Postgres connection-URL discovery for desktop / local-first apps, where the DB location isn't " +
      "known until a host boots the embedded instance and writes a discovery file: env vars (in order, empty " +
      "string = absent) → discovery file's url → fallback. Pure, zero-dependency; the app-specific config " +
      "(which env vars, which file, which fallback) lives in the caller.",
  },

  // ---- P-020: the UI component family (papercusp-ui template) ----
  {
    id: "ui-primitives",
    version: "0.0.1",
    tier: "A",
    kind: "package",
    provides: [
      "ansi-terminal-output",
      "markdown-rendering",
      "json-tree-view",
      "virtualized-lists",
    ],
    composesWith: ["dock-workbench", "papergrid", "lexicon"],
    source: {
      repo: "Papercusp/papercup",
      path: "libs/generic/ui-primitives",
      package: "@papercusp/ui-primitives",
    },
    tests: "npm test in the lib (vitest)",
    summary:
      "Shared headless React UI primitives — ANSI/terminal output, markdown (GFM), JSON tree viewer, and " +
      "virtualized lists. Brand-value-free: styling is injected by consumers, so the same primitives render " +
      "under any app's design system.",
    guide: "agent-insights/templates-system-design",
  },
  {
    id: "papergrid",
    version: "0.1.0",
    tier: "A",
    kind: "package",
    provides: [
      "data-grid-stack",
      "grid-virtualization",
      "server-rendered-rows",
    ],
    composesWith: ["ui-primitives", "dock-workbench", "sync"],
    source: {
      repo: "Papercusp/papercup",
      path: "libs/generic/papergrid",
      package: "@papercusp/papergrid",
    },
    tests: "npm test in the grid sub-packages (vitest)",
    summary:
      "The Papercusp data-grid stack, published as a workspaces META-PACKAGE: @papercusp/grid-core " +
      "(sort/selection/virtualization logic), @papercusp/bloom-grid (row store + server render), and " +
      "@papercusp/grid. Consumers depend on the SUB-PACKAGES directly — the meta-package is the catalog " +
      "handle, not the import.",
  },
  {
    id: "dock-workbench",
    version: "0.0.1",
    tier: "A",
    kind: "package",
    provides: ["dock-panel-workbench", "panel-registry", "layout-persistence"],
    composesWith: ["ui-primitives", "papergrid"],
    source: {
      repo: "Papercusp/papercup",
      path: "libs/generic/dock-workbench",
      package: "@papercusp/dock-workbench",
    },
    tests: "npm test in the lib (vitest)",
    summary:
      "Host-agnostic dockview workbench shell: a panel registry, a logical layout schema with adapters, " +
      "pluggable layout persistence, and the React DockWorkspace component — the multi-panel chrome of an " +
      "operator-style app without coupling to any host.",
  },
  {
    id: "lexicon",
    version: "0.1.0",
    tier: "A",
    kind: "package",
    provides: ["brand-lexicon-resolution", "term-registry"],
    composesWith: ["ui-primitives", "dock-workbench"],
    source: {
      repo: "Papercusp/papercup",
      path: "libs/generic/lexicon",
      package: "@papercusp/lexicon",
    },
    tests: "npm test in the lib (vitest)",
    summary:
      "A generic terminology resolver: canonical term keys → display labels via an active brand pack, with " +
      "pure singular/plural/lowercase resolution and a configure*() host seam for ambient (non-React) callers. " +
      "Route every user-facing noun through it and rebranding becomes a pack swap, not a grep.",
  },

  // ---- P-029: the web host chassis (papercusp-web-host template) ----
  {
    id: "next-standalone-host",
    version: "0.0.1",
    tier: "A",
    kind: "pattern",
    provides: [
      "web-http-host",
      "standalone-build",
      "workspace-lib-transpile",
      "auth-middleware-seam",
      "operator-json-discovery",
    ],
    composesWith: ["embedded-postgres-server", "pot-app-seam"],
    source: {
      path:
        "origin webapp: apps/web (next.config.js standalone + tracing root, middleware.ts, auth-proxy.mjs, " +
        "Dockerfile.web); the install's operator app (the papercusp-native reference instance)",
    },
    tests:
      "the composed app's boot-e2e (papercusp-web-host checks/) + the app's own vitest serial-PG rig",
    summary:
      "The web host chassis pattern — the web twin of the tauri-shell + hono-host pair: a Next.js app-router " +
      "host built with output:'standalone' (outputFileTracingRoot at the monorepo root so workspace libs trace " +
      "into the bundle, transpilePackages naming every @papercusp/* lib the app consumes), started as " +
      "`node .next/standalone/.../server.js` with .next/static + public/ staged in, operator.json discovery " +
      "written on boot for CLI/tooling parity, an auth seam (a middleware.ts gate stub + a minimal basic-auth " +
      "reverse proxy for pre-real-auth exposure — both placeholders by design), and a Dockerfile builder using " +
      "the workspace-manifest COPY layer for cacheable installs. Config/skeleton, not a lib.",
  },

  // ---- official mobile base (official-mobile-app-templates-2026-08-20 P-007) ----
  {
    id: "rust-uniffi-mobile-base",
    version: "0.1.0",
    tier: "A",
    kind: "pattern",
    provides: [
      "portable-mobile-core",
      "uniffi-native-boundary",
      "cross-language-design-tokens",
      "mobile-source-hygiene",
    ],
    composesWith: [],
    source: {
      path: "templates/papercusp-mobile-base (neutral checked reference); Papercusp and SideStage mobile apps are independent conformance consumers",
    },
    tests:
      "npm test -w @papercusp/template-kit plus papercusp-mobile-base portable checks under TEMPLATE_CHECKS_CONFIG in each reference consumer",
    summary:
      "The three-crate Rust/UniFFI mobile-base pattern shared by Android and iPhone: portable core, one generated " +
      "bindings boundary, off-device CLI, deterministic Kotlin/Swift design-token generation, explicit runtime " +
      "configuration, and placeholder/secret/source hygiene. It deliberately contains no product models, endpoints, " +
      "copy, routes, brand, or native UI. Product repositories instantiate the pattern and prove it through the " +
      "template's parameterized checks rather than importing a product-owned crate.",
    guide: "agent-insights/templates-system-design",
  },
];
