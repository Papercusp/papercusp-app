/**
 * Reference template manifests — the retro-fitted proof that the
 * template.yaml schema + composition semantics describe REALITY
 * (plan app-templates-2026-07-04 P-005 + P-014).
 *
 * P-014's recommended realization (owner directive: one app = a composition
 * of MANY templates) splits template #1 three ways, extracted from what the
 * two internal reference apps actually are:
 *
 *   - PAPERCUSP_OPS_HIVES_TEMPLATE   (aspect) — the app-owned agentic
 *     plan/work-item execution plane + the ONE seam. Carries both Tier B
 *     components.
 *   - TAURI_DESKTOP_SHELL_TEMPLATE   (aspect) — the app chassis: the
 *     deterministic plane's host stack + release pipeline.
 *   - AGENTIC_DESKTOP_APP_TEMPLATE   (app)    — a THIN pure composition (no
 *     own components; the P-014 schema rule allows this exactly for non-empty
 *     composesWith). P-022 re-layered it: it now requires the non-agentic
 *     DESKTOP_APP_TEMPLATE as its BASE app (which pulls the shell + data +
 *     UI closure) and layers PAPERCUSP_OPS_HIVES on top.
 *
 * These are DRAFTS of the shippable templates: P-006 writes the GUIDE.md +
 * starter blueprints + contract templates around them, P-007 makes checks/
 * real, and P-013 (consumer #1) re-materializes its agentic plane
 * from them. The suite validates each standalone, as a set
 * (validateTemplateSet), composed (composeTemplates — the union-of-checks),
 * and against COMPONENT_CATALOG, so catalog drift breaks this file loudly
 * (the P-009 gym re-runs the same validation).
 */
import type { TemplateManifest } from "./template-manifest.js";

/** Aspect: the agentic plan/work-item execution plane + the ONE app seam. */
export const PAPERCUSP_OPS_HIVES_TEMPLATE: TemplateManifest = {
  id: "papercusp-ops-pots",
  version: "0.1.0",
  scope: "aspect",
  category: "agentic",
  summary:
    "The agentic work plane: typed blueprint operations target app-owned plan templates, which promote " +
    "through Papercusp's canonical plan-to-work-item path, preserve their blocked-by DAG, assign only " +
    "the actionable frontier to a configured stable app agent, and durably wake its live adopting " +
    "session. Validated operation results cross into the deterministic app at exactly ONE typed seam; " +
    "confinement is enforced at install and the app's " +
    "blueprints/README.md states the rule.",
  components: [
    { id: "pot-app-seam", version: "0.1.0" },
    { id: "typed-contracts", version: "0.0.1" },
  ],
  // One stable app-agent starter. It describes the session that adopts the
  // configured agentName; plan promotion + direct dispatch own execution.
  blueprints: ["app-agent"],
  // The CandidateSet analog — the typed down-leg contract template the
  // building agent specializes for its domain.
  contracts: ["candidate-set"],
  decisionPoints: [
    {
      id: "seam-work-item-kind",
      prompt:
        "What work_item kind and id prefix cross the seam (worked instances: purchase-research/PR, bet-analysis/BA)?",
    },
    {
      id: "plan-template",
      prompt:
        "Which app-owned plan template defines the run inputs and blocked-by DAG for this work, and which external binding or schedule starts it?",
    },
    {
      id: "operation-contract",
      prompt:
        "What stable operation id/version, pinned plan-template revision/hash, typed input schema, typed result schema, and request-key source expose that plan as one reusable task?",
    },
    {
      id: "execution-target",
      prompt:
        "Which app harness owns the plan runs/work queue, and which stable agent name adopts assignments and receives required wakes?",
    },
    {
      id: "contract-shape",
      prompt:
        "What does the down-leg contract carry (specialize the candidate-set template; one parse gate, rejects emitted as events)?",
    },
    {
      id: "domain-lexicon",
      prompt:
        "What are the domain nouns/verbs for hives, roles, and work (replaces the placeholder lexicon in the starter blueprints)?",
    },
    {
      id: "domain-roles",
      prompt:
        "Which role prompt and capability envelope does the stable app agent need to complete assigned work (confinement stays inviolable)?",
    },
    {
      id: "app-tables",
      prompt:
        "Which app tables does ingested contract output land in, and what is the app-plane read model over them?",
    },
  ],
  composesWith: ["papercusp-tauri-desktop-shell", "papercusp-app"],
  docs: [
    "agent-insights/templates-system-design",
    "agent-insights/templates-template-yaml",
    "agent-insights/templates-component-catalog",
  ],
  checks: [
    {
      id: "confinement-guard",
      run: "checks/confinement-guard.test.ts",
      summary:
        "no hive role holds cart/checkout/vault/approvals-write-analog capabilities",
    },
    {
      id: "seam-round-trip",
      run: "checks/seam-round-trip.test.ts",
      summary:
        "enqueue → complete with payload → contract parse gate ingests → app table row exists",
    },
    {
      id: "gym-signals",
      run: "checks/gym-signals.test.ts",
      summary: "the stable app agent's guardrail gym signals are present and wired",
    },
  ],
  musts: [
    {
      id: "canonical-plan-work-plane",
      rule: "Every reusable external or scheduled agentic run invokes a declared blueprint operation that targets an app-owned plan template and canonical plan-item promotion; never raw work-item inserts, direct work_items:create, a copied DAG, or a parallel scheduler",
      enforcedBy: "prose-only",
    },
    {
      id: "operation-first-task-binding",
      rule: "Every new reusable task binding names a typed, versioned operation and stable request key; only blueprint:result state=ready may carry output across the app parse gate, while legacy launch-plan bindings stay operational until individually parity-tested",
      enforcedBy: "seam-round-trip",
    },
    {
      id: "stable-agent-direct-dispatch",
      rule: "Every agentic binding/schedule carries execution { appHarnessSlug, agentName }; promotion assigns and durably wakes that stable agent for the actionable frontier only, while blocked descendants remain unassigned until canonical prerequisite completion",
      enforcedBy: "prose-only",
    },
    {
      id: "target-failure-is-loud",
      rule: "A dead, absent, or unwakeable adopting session is a structured retryable failure with queue state preserved — never false execution success or a silent stall",
      enforcedBy: "prose-only",
    },
    {
      id: "seam-only-crossing",
      rule: "Every judgment-plane crossing composes @papercusp/pot-app-seam (bootstrap, operation submit/status/result, compatibility plan launch, ingest loop) — never hand-rolled calls against /api/harness/*",
      enforcedBy: "seam-round-trip",
    },
    {
      id: "one-parse-gate",
      rule: "An app-owned contracts package with strict schemas both directions; the parse gate is the ONLY path from agent output to an app table and rejects emit events, never silent drops",
      enforcedBy: "seam-round-trip",
    },
    {
      id: "confinement-inviolable",
      rule: "Every hive role is read + propose-only against the app dangerous surface, pinned via role capability envelopes; the app blueprints/README.md is the canonical statement of the rule",
      enforcedBy: "confinement-guard",
    },
    {
      id: "nothing-else-crosses",
      rule: "No second transport, no side-channel table writes, no direct DB access from a role",
      enforcedBy: "prose-only",
    },
  ],
};

/** Aspect: the app chassis — the deterministic plane's host stack + release pipeline. */
export const TAURI_DESKTOP_SHELL_TEMPLATE: TemplateManifest = {
  id: "papercusp-tauri-desktop-shell",
  version: "0.1.0",
  scope: "aspect",
  category: "shell",
  summary:
    "The deterministic app chassis: a thin Tauri 2 shell (a HOST, not the app) spawning a Node/Hono " +
    "sidecar that serves the SPA + /api on a free localhost port, embedded Postgres with migrations on " +
    "boot and discovery-file connection resolution, operator.json for shell/CLI discovery, graceful " +
    "SIGTERM shutdown, and the tauri-release-kit build/release pipeline. Plain TypeScript packages — " +
    "Tier A throughout: compose and modify freely.",
  components: [
    { id: "tauri-shell", version: "0.0.1" },
    { id: "hono-host", version: "0.0.1" },
    { id: "embedded-postgres-server", version: "0.0.1" },
    { id: "tauri-release-kit", version: "0.1.0" },
  ],
  contracts: [],
  decisionPoints: [
    {
      id: "ui-shape",
      prompt:
        "What SPA surface does the deterministic plane need (grids, approvals view, streams)? FREE tier — compose as judged best.",
    },
    {
      id: "app-identity",
      prompt:
        "App name, bundle identifier, app-home directory, and release channels (feeds tauri.conf + tauri-release-kit config).",
    },
  ],
  composesWith: ["papercusp-ops-pots", "papercusp-app"],
  docs: [
    "agent-insights/templates-system-design",
    "agent-insights/templates-template-yaml",
    "agent-insights/templates-component-catalog",
  ],
  checks: [
    {
      id: "boot-e2e",
      run: "checks/boot-e2e.test.ts",
      summary:
        "native Cargo/config/icon inputs exist, composed app builds, sidecar spawns, discovery file written, health returns 200",
    },
  ],
  musts: [
    {
      id: "thin-shell",
      rule: "No domain logic in Rust — the shell is a HOST; packaged sidecar resolution is resource_dir()/dist-sidecar + vendored bin/node + bundled_path_env, dev is the repo dist-sidecar",
      enforcedBy: "prose-only",
    },
    {
      id: "native-bundle-inputs",
      rule: "Cargo.toml + committed Cargo.lock + tauri.conf.json + every explicitly configured bundle icon exist and are non-empty before native compilation",
      enforcedBy: "boot-e2e",
    },
    {
      id: "discovery-file",
      rule: "Port + pid written to the app home at boot and removed on shutdown — the shell polls it, the CLI reads it",
      enforcedBy: "boot-e2e",
    },
    {
      id: "graceful-shutdown",
      rule: "SIGTERM ordering host close, sync stop, PG stop, discovery-file removal, with a force-exit timer; the final unlink is synchronous (WI-2866/WI-2667 lessons)",
      enforcedBy: "boot-e2e",
    },
    {
      id: "embedded-pg-lifecycle",
      rule: "Embedded Postgres boot/stop bound to the sidecar, migrations on boot, connection via @papercusp/embedded-pg-discovery, portable initdb flags (WI-2649)",
      enforcedBy: "boot-e2e",
    },
    {
      id: "env-gated-planes",
      rule: "Booting with no optional-plane config changes nothing — an unset operator URL means the plane is off, never a crash",
      enforcedBy: "boot-e2e",
    },
  ],
};

/**
 * Aspect: the live data-sync plane (owner directive 2026-07-04 / P-017 —
 * 'Papercusp Official: Data Sync'). Integrates the sync generic-library
 * family: client transports + SSE server primitives + event-maintained
 * projections + burst control + resumable large-asset transfer.
 */
export const PAPERCUSP_DATA_SYNC_TEMPLATE: TemplateManifest = {
  id: "papercusp-data-sync",
  version: "0.1.0",
  scope: "aspect",
  category: "data",
  summary:
    "The live data-sync plane for a papercusp-composed app: @papercusp/sync (client transports with " +
    "reconnect/backpressure) paired with @papercusp/sse (server SSE primitives + PG NOTIFY bridge), " +
    "@papercusp/projection-index for event-maintained read models, @papercusp/debounce-coalesce for " +
    "wake-floor + burst-coalesce delivery, and @papercusp/resumable-download for interrupted large-asset " +
    "transfer. Compose into any app whose UI must track server state live without polling.",
  components: [
    { id: "sync", version: "0.0.1" },
    { id: "sse", version: "0.0.1" },
    { id: "projection-index", version: "0.1.0" },
    { id: "debounce-coalesce", version: "0.1.0" },
    { id: "resumable-download", version: "0.1.0" },
  ],
  contracts: [],
  decisionPoints: [
    {
      id: "sync-transport",
      prompt:
        "Which sync transport fits the app — SSE (simplest, one-directional server push over the sidecar) or Zero (bidirectional)? Default SSE unless the app needs client-originated sync.",
    },
    {
      id: "synced-surfaces",
      prompt:
        "Which app tables/views must sync live to the UI, and which stay request/response? Wire the PG NOTIFY bridge only for the live set.",
    },
    {
      id: "projection-set",
      prompt:
        "Which derived read models does the UI query (feed projection-index from the change stream), and what burst policy per subscriber (wake floor / coalesce window via debounce-coalesce)?",
    },
    {
      id: "large-assets",
      prompt:
        "Does the app move large files (models, media, archives)? If so, route them through resumable-download with streaming checksums; if not, drop the component from the composition.",
    },
  ],
  composesWith: [
    "papercusp-tauri-desktop-shell",
    "papercusp-search",
    "papercusp-data-layer",
  ],
  docs: [
    "agent-insights/templates-system-design",
    "agent-insights/templates-template-yaml",
    "agent-insights/templates-component-catalog",
  ],
  checks: [
    {
      id: "components-integrated",
      run: "checks/components-integrated.test.ts",
      summary:
        "every pinned component package is a declared dependency of the composed app (config section: components)",
    },
  ],
  musts: [
    {
      id: "sidecar-host-streams",
      rule: "Live surfaces stream over the sidecar host — never a second server for sync",
      enforcedBy: "prose-only",
    },
    {
      id: "burst-policy",
      rule: "Every synced surface has a burst policy (wake floor / coalesce window) — an unbounded change stream into a UI is a self-inflicted outage",
      enforcedBy: "prose-only",
    },
    {
      id: "deps-declared",
      rule: "Every kept component is a real package dependency — not wired on paper",
      enforcedBy: "components-integrated",
    },
  ],
};

/**
 * Aspect: the search plane (owner directive 2026-07-04 / P-018 —
 * 'Papercusp Official: Search'). Integrates the search generic-library
 * family: BM25 + pgvector hybrid retrieval over the app's own Postgres,
 * rank fusion, cross-encoder reranking, and the engine-agnostic relevance
 * core (steering / rewrite / eval contract).
 */
export const PAPERCUSP_SEARCH_TEMPLATE: TemplateManifest = {
  id: "papercusp-search",
  version: "0.1.0",
  scope: "aspect",
  category: "search",
  summary:
    "The search plane for a papercusp-composed app: @papercusp/search (host-agnostic BM25 + pgvector hybrid " +
    "retrieval over Postgres via pluggable SearchSources) fused by @papercusp/rrf, with @papercusp/rerank " +
    "(engine-agnostic cross-encoder precision pass) and @papercusp/search-core (rerank steering, LLM " +
    "category-match, query rewrite, and the shared eval-harness metric contract) layered on when relevance " +
    "quality matters. Compose into any app whose data users need to find by meaning, not just by filter.",
  components: [
    { id: "search", version: "0.1.0" },
    { id: "search-core", version: "0.1.0" },
    { id: "rerank", version: "0.1.0" },
    { id: "rrf", version: "0.1.0" },
  ],
  contracts: [],
  decisionPoints: [
    {
      id: "search-surfaces",
      prompt:
        "Which app tables/entities are searchable? Each becomes a pluggable SearchSource owning its own tsvector/pgvector SQL — the engine composes them; it never guesses your schema.",
    },
    {
      id: "retrieval-mode",
      prompt:
        "BM25-only or hybrid BM25+embeddings? Hybrid needs a query embedder injected (the lib carries no embedding provider). Default BM25-only until the app has an embedding pipeline; RRF fusion turns on with the second ranking.",
    },
    {
      id: "relevance-stack",
      prompt:
        "Is raw retrieval enough, or does the app need the precision stack — cross-encoder reranking (@papercusp/rerank; needs a ZeroEntropy API key) plus search-core's steering/rewrite/category-match? Drop rerank + search-core from the composition when plain retrieval suffices.",
    },
    {
      id: "relevance-evals",
      prompt:
        "What proves relevance for THIS domain — which golden queries and which metrics (search-core's shared eval-harness contract)? A search plane without an eval set degrades silently.",
    },
  ],
  composesWith: [
    "papercusp-tauri-desktop-shell",
    "papercusp-data-sync",
    "papercusp-data-layer",
  ],
  docs: [
    "agent-insights/templates-system-design",
    "agent-insights/templates-template-yaml",
    "agent-insights/templates-component-catalog",
  ],
  checks: [
    {
      id: "components-integrated",
      run: "checks/components-integrated.test.ts",
      summary:
        "every pinned component package is a declared dependency of the composed app (config section: components)",
    },
  ],
  musts: [
    {
      id: "own-postgres-search",
      rule: "Search queries the app OWN embedded Postgres — never a separate search engine or service",
      enforcedBy: "prose-only",
    },
    {
      id: "source-per-surface",
      rule: "Each searchable surface is its own SearchSource owning its SQL — never one source with schema switches",
      enforcedBy: "prose-only",
    },
    {
      id: "secrets-injected",
      rule: "Rerank and embedding-provider keys are injected config — never committed",
      enforcedBy: "prose-only",
    },
    {
      id: "deps-declared",
      rule: "Every kept component is a real package dependency — not wired on paper",
      enforcedBy: "components-integrated",
    },
  ],
};

/**
 * Aspect: the app-owned data plane (owner directive 2026-07-04 / P-019 —
 * 'Papercusp Official: Embedded Data Layer'). embedded-postgres-server
 * (pattern) + @papercusp/embedded-pg-discovery + typed-contracts (pattern):
 * an embedded Postgres that boots with the app, generic connection
 * resolution, and the single-parse-gate write discipline.
 */
export const PAPERCUSP_DATA_LAYER_TEMPLATE: TemplateManifest = {
  id: "papercusp-data-layer",
  version: "0.1.0",
  scope: "aspect",
  category: "data",
  summary:
    "The embedded data layer for a papercusp-composed app: the embedded-postgres-server pattern (an app-owned " +
    "Postgres booted with the app — lifecycle, migrations on boot, per-boot port, discovery file), " +
    "@papercusp/embedded-pg-discovery for connection resolution (env vars → discovery file → fallback), and " +
    "the typed-contracts pattern — a single parse gate for every write that crosses a trust boundary into app " +
    "tables. Compose into any app that owns its data instead of depending on external infrastructure.",
  components: [
    { id: "embedded-postgres-server", version: "0.0.1" },
    { id: "embedded-pg-discovery", version: "0.1.0" },
    { id: "typed-contracts", version: "0.0.1" },
  ],
  contracts: [],
  decisionPoints: [
    {
      id: "app-schema",
      prompt:
        "Which tables does the app own, and what is the migration story? Migrations run forward-only on boot (the embedded-postgres-server pattern) — there is no ops window in a desktop app.",
    },
    {
      id: "connection-resolution",
      prompt:
        "Parameterize @papercusp/embedded-pg-discovery for THIS app: which env vars (in priority order), which discovery-file path under the app home, which fallback URL? Never hardcode the port — it rotates per boot.",
    },
    {
      id: "contract-gates",
      prompt:
        "Which writes cross a trust boundary (agent output, imported files, network payloads)? Each gets the typed-contracts discipline — a dedicated contracts package + ONE parse gate, rejects surfaced as events. If the app composes papercusp-ops-pots this is MANDATORY for the seam; if nothing untrusted writes, drop the pattern.",
    },
  ],
  composesWith: [
    "papercusp-tauri-desktop-shell",
    "papercusp-data-sync",
    "papercusp-search",
  ],
  docs: [
    "agent-insights/templates-system-design",
    "agent-insights/templates-template-yaml",
    "agent-insights/templates-component-catalog",
  ],
  checks: [
    {
      id: "components-integrated",
      run: "checks/components-integrated.test.ts",
      summary:
        "every pinned component package is a declared dependency of the composed app (config section: components)",
    },
  ],
  musts: [
    {
      id: "app-owns-postgres",
      rule: "The app owns its embedded Postgres under the app home — never a system or external database",
      enforcedBy: "prose-only",
    },
    {
      id: "no-hardcoded-pg",
      rule: "Never hardcode the PG port or URL — the port rotates per boot; always resolve through resolvePgUrl",
      enforcedBy: "prose-only",
    },
    {
      id: "postgres-js-client",
      rule: "postgres-js is the app PG client, not node-postgres — the search aspect SearchSource types its handle as a postgres-js Sql function (WI-2872)",
      enforcedBy: "prose-only",
    },
    {
      id: "forward-only-migrations",
      rule: "Migrations run on boot and are forward-only — a desktop app has no ops window",
      enforcedBy: "prose-only",
    },
    {
      id: "single-parse-gate",
      rule: "Every trust-boundary write goes through a single typed-contract parse gate — mandatory for the seam down-leg when composing papercusp-ops-pots",
      enforcedBy: "prose-only",
    },
    {
      id: "deps-declared",
      rule: "Every kept component is a real package dependency — not wired on paper",
      enforcedBy: "components-integrated",
    },
  ],
};

/**
 * Aspect: the UI kit (owner directive 2026-07-04 / P-020 —
 * 'Papercusp Official: UI Kit'). Integrates the UI generic-library family:
 * headless React primitives, the papergrid data-grid stack, the dockview
 * workbench shell, and brand-lexicon terminology resolution.
 */
export const PAPERCUSP_UI_TEMPLATE: TemplateManifest = {
  id: "papercusp-ui",
  version: "0.1.0",
  scope: "aspect",
  category: "ui",
  summary:
    "The UI kit for a papercusp-composed app: @papercusp/ui-primitives (headless ANSI/terminal, markdown, " +
    "JSON-tree, and virtualized-list primitives — brand-value-free, consumer-styled), the papergrid data-grid " +
    "stack (grid-core sort/selection/virtualization + bloom-grid server-rendered rows), " +
    "@papercusp/dock-workbench (host-agnostic dockview panel workbench with pluggable layout persistence), and " +
    "@papercusp/lexicon (canonical term keys → brand-pack display labels, so rebranding is a pack swap). " +
    "Compose into any app whose deterministic plane needs an operator-style SPA.",
  components: [
    { id: "ui-primitives", version: "0.0.1" },
    { id: "papergrid", version: "0.1.0" },
    { id: "dock-workbench", version: "0.0.1" },
    { id: "lexicon", version: "0.1.0" },
  ],
  contracts: [],
  decisionPoints: [
    {
      id: "ui-surfaces",
      prompt:
        "Which surfaces does the app's deterministic plane need — data grids, terminal/agent-output panes, markdown/docs views, JSON inspectors, a multi-panel workbench? Take only the components those surfaces use; drop the rest from the composition.",
    },
    {
      id: "grid-usage",
      prompt:
        "papergrid is a META-PACKAGE — apps depend on the grid SUB-PACKAGES directly (@papercusp/grid-core, @papercusp/bloom-grid, @papercusp/grid). Which grids does the app need, and do any need server-rendered rows (bloom-grid) vs pure client virtualization (grid-core)?",
    },
    {
      id: "workbench-layout",
      prompt:
        "What is the panel layout — which panels register in the dock-workbench registry, what is the default logical layout, and where does layout persistence live (the app's data layer vs localStorage)?",
    },
    {
      id: "branding-lexicon",
      prompt:
        "How are user-facing nouns kept rebrandable? @papercusp/lexicon's TermKey is a CLOSED papercusp-internal vocabulary (fleet, harness, operator, ...) resolved through the active brand pack — route THOSE terms through it (wire the configure*() host seam to the app's pack selection) wherever your chrome surfaces them. The app's OWN domain nouns are NOT lexicon terms: keep them in one app-local terms module so a rebrand is still one edit — never hardcode a display label a rebrand would have to grep for.",
    },
  ],
  composesWith: ["papercusp-tauri-desktop-shell", "papercusp-data-sync"],
  docs: [
    "agent-insights/templates-system-design",
    "agent-insights/templates-template-yaml",
    "agent-insights/templates-component-catalog",
  ],
  checks: [
    {
      id: "components-integrated",
      run: "checks/components-integrated.test.ts",
      summary:
        "every pinned component package is a declared dependency of the composed app (config section: components)",
    },
    {
      id: "theme-tokens",
      run: "checks/theme-tokens.test.ts",
      summary:
        "the app consumes the generated shared theme tokens.css (3-state light/dark/system model, D-011) and its app CSS carries no raw hex — every color routes through the semantic vars (config section: themeTokens)",
    },
  ],
  musts: [
    {
      id: "headless-primitives",
      rule: "Primitives stay headless and are styled from the app design system — never forked to hardcode brand values",
      enforcedBy: "prose-only",
    },
    {
      id: "theme-via-tokens",
      rule: "App CSS draws every color from the shared token package's semantic vars (tokens/tokens.base.json → generated tokens.css) — no raw hex; per-app accents/extras are a thin override layer on top, and dark mode arrives from the tokens, never from per-app hex",
      enforcedBy: "theme-tokens",
    },
    {
      id: "grid-subpackages",
      rule: "Depend on the grid sub-packages directly — @papercusp/papergrid is the catalog handle, not the import",
      enforcedBy: "prose-only",
    },
    {
      id: "lexicon-scope",
      rule: "papercusp-internal TermKeys route through the lexicon; the app own domain nouns live in one app-local terms module (WI-2873) — never hardcode a label a rebrand would grep for",
      enforcedBy: "prose-only",
    },
    {
      id: "deps-declared",
      rule: "Every kept component (and the primitives peer deps) is a real package dependency — not wired on paper",
      enforcedBy: "components-integrated",
    },
  ],
};

/**
 * Aspect: the desktop release plane (owner directive 2026-07-04 / P-023 —
 * 'Papercusp Official: Release Pipeline'). tauri-release-kit as a composable
 * aspect: the kit owns the release DANCE; the app injects ONLY buildSidecar()
 * + a TauriReleaseConfig. Same 0.1.0 pin the shell template carries —
 * composing both stays pin-consistent.
 */
export const RELEASE_PIPELINE_TEMPLATE: TemplateManifest = {
  id: "papercusp-release-pipeline",
  version: "0.1.0",
  scope: "aspect",
  category: "release",
  summary:
    "The desktop release plane: @papercusp/tauri-release-kit — provider-agnostic build+release orchestration " +
    "(version bump across versionFiles, channel→tag resolution, tauri build target matrix, artifact " +
    "classification, latest.json updater-manifest generation, gh release upload, Mac/Windows VM drivers over " +
    "an SSH frame) with the app-specific sidecar build injected via the buildSidecar() seam and all side " +
    "effects behind Exec/Fs/Log ports. The shell template already pins the kit; THIS aspect is the deepened " +
    "release guidance — channels, signing, updater feed, target matrix — for apps that ship for real.",
  components: [{ id: "tauri-release-kit", version: "0.1.0" }],
  contracts: [],
  decisionPoints: [
    {
      id: "release-channels",
      prompt:
        "Which release channels does the app ship (stable only? stable+beta?) and what tag scheme names them? The kit's channel→tag resolution (defaultTagFor) encodes the answer; every channel needs its own updater feed URL.",
    },
    {
      id: "release-targets",
      prompt:
        "What is the target matrix — linux-x86_64 (deb/AppImage) built locally, mac universal (dmg) and windows (msi/nsis) on VMs over the kit's SSH frame? Which targets are release-blocking vs best-effort?",
    },
    {
      id: "signing-and-updater",
      prompt:
        "Where does the Tauri signing key live (keyPath + passwordEnv — the key and password are NEVER committed; keychain/keyfile per platform), and where do updater manifests point (latestJsonUrl — usually the gh release asset URL)? A desktop app without signing/updater wiring is a prototype.",
    },
    {
      id: "sidecar-build",
      prompt:
        "What does buildSidecar(ctx) do for THIS app — the ONE injected seam (worked instances range from ~42 lines of esbuild to a ~1,070-line bundler)? Keep it a pure function of the repo tree; everything else is the kit's.",
    },
  ],
  composesWith: ["papercusp-tauri-desktop-shell", "papercusp-app"],
  docs: [
    "agent-insights/templates-system-design",
    "agent-insights/templates-template-yaml",
    "agent-insights/templates-component-catalog",
    "build-system/tauri-release-kit-proposal",
  ],
  checks: [
    {
      id: "components-integrated",
      run: "checks/components-integrated.test.ts",
      summary:
        "every pinned component package is a declared dependency of the composed app (config section: components)",
    },
  ],
  musts: [
    {
      id: "no-signing-material-in-repo",
      rule: "Signing material never enters the repo — signing.keyPath points outside it",
      enforcedBy: "prose-only",
    },
    {
      id: "kit-bumps-versions",
      rule: "The kit bumps versions, never by hand — every file carrying the version is listed in its config",
      enforcedBy: "prose-only",
    },
    {
      id: "generated-updater-manifests",
      rule: "Updater manifests are generated, never hand-rolled — latest.json comes from the kit",
      enforcedBy: "prose-only",
    },
    {
      id: "buildsidecar-only-seam",
      rule: "buildSidecar() stays the ONLY app-specific code path in the release plane",
      enforcedBy: "prose-only",
    },
  ],
};

/** Aspect: a generated, versioned project-history read model for any app. */
export const PROJECT_HISTORY_TEMPLATE: TemplateManifest = {
  id: "papercusp-project-history",
  version: "0.1.0",
  scope: "aspect",
  category: "data",
  summary:
    "A reusable project History plane: the installed papercusp project-history generator reads the chosen " +
    "Papercusp harness plus Git, writes a disposable versioned artifact, and leaves each app with only a thin " +
    "static-file or server-import adapter. @papercusp/plan-parser owns the product-neutral schema and assembler.",
  components: [{ id: "plan-parser", version: "0.1.0" }],
  contracts: [],
  decisionPoints: [
    {
      id: "history-scope",
      prompt:
        "Which harness is authoritative, and should the default <harness>- plan-prefix filter be kept or disabled with --prefix= to export the whole harness?",
    },
    {
      id: "project-identity",
      prompt:
        "What stable project id/name and repository web URL should the artifact expose?",
    },
    {
      id: "artifact-adapter",
      prompt:
        "Will the host serve JSON statically or import the generated TypeScript artifact through a thin API adapter, and at what committed path?",
    },
    {
      id: "regeneration-gate",
      prompt:
        "Which build/test command regenerates the artifact, and where does --check fail stale committed output?",
    },
  ],
  composesWith: ["papercusp-app", "papercusp-ui"],
  docs: [
    "build-system/project-history",
    "agent-insights/templates-system-design",
    "agent-insights/templates-template-yaml",
    "agent-insights/templates-component-catalog",
  ],
  checks: [
    {
      id: "project-history-artifact",
      run: "checks/project-history-artifact.test.ts",
      summary:
        "the configured generated JSON or TypeScript artifact is schema v1, belongs to the expected project/harness, and names the canonical generator",
    },
  ],
  musts: [
    {
      id: "derived-read-model",
      rule: "The generated artifact is disposable derived output; Papercusp ledgers and Git remain authoritative",
      enforcedBy: "project-history-artifact",
    },
    {
      id: "installed-generator",
      rule: "Generation invokes the installed papercusp project-history CLI, never a path into a Papercusp source checkout",
      enforcedBy: "prose-only",
    },
    {
      id: "versioned-contract",
      rule: "Consumers reject unknown schema versions instead of guessing a compatible shape",
      enforcedBy: "project-history-artifact",
    },
    {
      id: "thin-consumer-adapter",
      rule: "Project-specific code only selects config, transports the artifact, and composes UI; it never forks the assembler",
      enforcedBy: "prose-only",
    },
  ],
};

/**
 * Aspect: the web app chassis (owner directive 2026-07-05 / P-029 — extracted
 * from the origin-webapp audit, agent-insights/
 * restart-webapp-audit-papercusp-webapp-template). The web twin of
 * papercusp-tauri-desktop-shell: the HOST is config/skeleton (a pattern component),
 * not a lib — the heavy web stack (UI kit, sync, search) already lives in
 * the sibling aspect templates.
 */
export const PAPERCUSP_WEB_HOST_TEMPLATE: TemplateManifest = {
  id: "papercusp-web-host",
  version: "0.1.0",
  scope: "aspect",
  category: "shell",
  summary:
    "The web app chassis — the web twin of papercusp-tauri-desktop-shell, extracted from the first " +
    "papercusp webapp: a Next.js app-router host built with output:'standalone' (outputFileTracingRoot at " +
    "the monorepo root + transpilePackages for every workspace lib — the classic monorepo miss), started as " +
    "node server.js with static/public assets staged in, operator.json discovery written on boot, an auth " +
    "seam (middleware.ts gate stub + a minimal basic-auth reverse proxy — placeholders to REPLACE before real " +
    "exposure), a Dockerfile builder on the workspace-manifest COPY layer, and a serial-PG vitest rig. " +
    "Config/skeleton, not a lib — Tier A throughout: compose and modify freely.",
  components: [{ id: "next-standalone-host", version: "0.0.1" }],
  contracts: [],
  decisionPoints: [
    // Declared HERE, not on an app root: tenancy is a web-chassis concern, so
    // it appears exactly when this chassis is in the closure (composition tags
    // every decision point with the template that owns it — no conditionals).
    {
      id: "tenancy",
      prompt:
        "Single-user local install (papercusp-style, embedded PG per install) or multi-user server " +
        "deployment (one PG, real auth, sessions)? The web chassis serves both, but auth-strategy, data-layer " +
        "connection resolution, and the hosting target all fork on this answer — decide it FIRST.",
    },
    {
      id: "hosting-target",
      prompt:
        "Where does the app run — a local per-user install (papercusp-style), a container (the Dockerfile " +
        "builder pattern), or behind a reverse proxy on a server? Drives PORT/HOSTNAME wiring, the update " +
        "story, and whether the basic-auth proxy is even relevant.",
    },
    {
      id: "auth-strategy",
      prompt:
        "What replaces the auth placeholders before exposure? The template ships a middleware.ts gate STUB " +
        "and a basic-auth reverse proxy for pre-release protection — shipping either as the real auth is the " +
        "classic miss; pick the app's real authn/z at composition time.",
    },
    {
      id: "render-strategy",
      prompt:
        "Which routes are SSR/server-components vs client-only? The standalone output serves both; decide " +
        "per surface — data-heavy operator-style panes usually go client + live sync, content/docs surfaces " +
        "go server.",
    },
    {
      id: "observability",
      prompt:
        "Does the app wire instrumentation.ts (OTEL) and browser RUM, or ship without? FREE tier — a " +
        "deployed multi-user webapp without traces debugs blind; a local single-user install can skip it.",
    },
  ],
  composesWith: [
    "papercusp-data-layer",
    "papercusp-ui",
    "papercusp-data-sync",
    "papercusp-search",
    "papercusp-app",
  ],
  docs: [
    "agent-insights/templates-system-design",
    "agent-insights/templates-template-yaml",
    "agent-insights/templates-component-catalog",
    "agent-insights/restart-webapp-audit-papercusp-webapp-template",
  ],
  checks: [
    {
      id: "boot-e2e",
      run: "checks/boot-e2e.test.ts",
      summary:
        "composed web app builds, host starts, discovery file written, health returns 200",
    },
  ],
  musts: [
    {
      id: "standalone-output",
      rule: "output standalone + outputFileTracingRoot + complete transpilePackages — all three before first deploy",
      enforcedBy: "prose-only",
    },
    {
      id: "auth-before-exposure",
      rule: "Both auth placeholders replaced before any non-local exposure — the auth-strategy decision point is not optional",
      enforcedBy: "prose-only",
    },
    {
      id: "discovery-lifecycle",
      rule: "The discovery file is written on boot and removed on shutdown",
      enforcedBy: "boot-e2e",
    },
    {
      id: "wire-boot-check",
      rule: "checks/boot-e2e.test.ts is wired in the composed app TEMPLATE_CHECKS_CONFIG boot section, spawn mode in CI",
      enforcedBy: "prose-only",
    },
    {
      id: "next-manual-sig-handle",
      rule: "NEXT_MANUAL_SIG_HANDLE=1 whenever the app registers its own shutdown hook (WI-2880) — else Next truncates async cleanup",
      enforcedBy: "boot-e2e",
    },
    {
      id: "native-deps-copy",
      rule: "A post-build native-deps copy step for every spawn-based dependency (WI-2875) — the standalone tracer will not carry them",
      enforcedBy: "prose-only",
    },
  ],
};

/**
 * App: THE whole-app root (plan unified-app-template-2026-08-23, D-001).
 *
 * The four previous roots (papercusp-webapp, papercusp-desktop-app, and their
 * two agentic twins) were the cross-product of two booleans — which chassis,
 * and whether the agent plane joins. Measured, web and desktop shared 15 of 15
 * paths with 11 byte-identical and zero code divergence. This root carries the
 * invariant half (data + UI) in `requires` and moves the chassis onto
 * `target.selects`, because `requires` is a static pin and cannot express a
 * choice. `composeTemplates` enforces the selection structurally, so nothing
 * is weakened by the collapse.
 */
export const PAPERCUSP_APP_TEMPLATE: TemplateManifest = {
  id: "papercusp-app",
  version: "0.1.0",
  scope: "app",
  category: "app",
  summary:
    "The one whole-app root — a THIN pure composition of papercusp-data-layer (app-owned Postgres, " +
    "connection discovery, typed-contract write gates) and papercusp-ui (headless primitives, data grids, " +
    "dock workbench, brand lexicon) as hard requires, plus a `target` decision point that selects the " +
    "chassis: papercusp-tauri-desktop-shell for desktop, papercusp-web-host for the browser, or BOTH from " +
    "one codebase. The data and UI closure is identical either way — that is why one root serves both. No " +
    "own components; an app built from it must pass the UNION of its closure's checks, so a dual-target " +
    "build inherits both chassis suites and is opt-in, never the default.",
  components: [],
  contracts: [],
  decisionPoints: [
    // ANSWERED FIRST — it selects the chassis, and every chassis-level decision
    // point arrives with whichever one is chosen.
    {
      id: "target",
      prompt:
        "Which runtime target does this app ship — desktop (the Tauri chassis: thin Tauri host, Node/Hono " +
        "sidecar, release pipeline), web (the Next.js standalone host, auth seam, deploy skeleton), or BOTH " +
        "from one codebase? Answer this FIRST: it selects the chassis aspect, and the chassis brings its own " +
        "decision points with it. Choosing both is deliberate, never the default — the composed app must pass " +
        "the UNION of both chassis check suites on every build. MEASURED (P-005): that union is 5 check " +
        "declarations against a single target's 4 — the chassis contributes exactly ONE check (its " +
        "boot-e2e), and the other three (composition-integrity, data-layer, ui) are shared and paid once " +
        "either way. So the tax is +1 declaration, NOT a doubling — but it is the most expensive KIND of " +
        "check (build the app, boot the host, probe health), so a declaration count understates the wall " +
        "clock. Choose both because the app genuinely ships two artifacts.",
      selects: {
        arity: "one-or-more",
        options: [
          {
            value: "desktop",
            summary:
              "The Tauri chassis — thin Tauri host to a Node/Hono sidecar, with the release pipeline and an " +
              "embedded per-install Postgres.",
            templates: [{ id: "papercusp-tauri-desktop-shell", version: "0.1.0" }],
          },
          {
            value: "web",
            summary:
              "The Next.js standalone host — auth seam, discovery on boot, the Dockerfile builder layer, and " +
              "the tenancy fork it declares.",
            templates: [{ id: "papercusp-web-host", version: "0.1.0" }],
          },
        ],
      },
    },
    // The second axis the four old roots encoded as separate templates.
    // OPTIONAL — the explicit `none` answer is what makes it so.
    {
      id: "agents",
      prompt:
        "Does this app embed an agent plane? `none` is the ordinary answer and the default shape: a " +
        "deterministic app with no agent work plane or seam. Answer `pots` and papercusp-ops-pots joins the " +
        "composition, bringing the canonical plan-to-work-item execution plane (app-owned plan runs, blocked-by " +
        "DAG, stable-agent assignment + required wake) and the ONE typed seam the app crosses to reach it — " +
        "which is a real architectural commitment, not a feature flag. It is answered here rather than by " +
        "picking a different template, because the agent plane was always a layer on the same app, never a " +
        "different app.",
      selects: {
        options: [
          {
            value: "none",
            summary: "No agent plane or seam — the deterministic app only.",
            templates: [],
          },
          {
            value: "pots",
            summary:
              "The canonical plan/work-item/stable-agent execution plane, layered on via papercusp-ops-pots and reached across exactly one typed seam.",
            templates: [{ id: "papercusp-ops-pots", version: "0.1.0" }],
          },
        ],
      },
    },
    {
      id: "domain",
      prompt:
        "What is the app's domain — the noun its data layer ledgers and its UI surfaces? Drives every " +
        "aspect-level decision point (schema, searchable surfaces, panels, lexicon terms).",
    },
    {
      id: "optional-planes",
      prompt:
        "Beyond the required closure, does the app need live UI state sync (compose papercusp-data-sync) or " +
        "search over its data (compose papercusp-search)? Add them to the composition now if so — both are " +
        "designed to drop onto either chassis.",
    },
  ],
  composesWith: [
    "papercusp-tauri-desktop-shell",
    "papercusp-web-host",
    "papercusp-data-layer",
    "papercusp-ui",
    "papercusp-ops-pots",
    "papercusp-data-sync",
    "papercusp-search",
  ],
  // The INVARIANT half of the closure. The chassis is deliberately NOT here —
  // it is selected by `target`, and composeTemplates enforces that selection
  // with the same force a hard pin would.
  requires: [
    { id: "papercusp-data-layer", version: "0.1.0" },
    { id: "papercusp-ui", version: "0.1.0" },
  ],
  docs: [
    "agent-insights/templates-system-design",
    "agent-insights/templates-template-yaml",
    "agent-insights/restart-webapp-audit-papercusp-webapp-template",
  ],
  checks: [
    {
      id: "composition-integrity",
      run: "checks/composition-integrity.test.ts",
      summary:
        "the composed set resolves (composeTemplates ok: pins consistent, one root app scope, every selecting decision point satisfied) and the union of checks is what CI runs",
    },
  ],
  musts: [
    {
      id: "thin-app-template",
      rule: "The app template adds glue guidance and decision points, never its own components — capability belongs in aspects",
      enforcedBy: "composition-integrity",
    },
    {
      id: "answer-target-first",
      rule: "`target` is answered BEFORE any other decision point — it selects the chassis, and the chassis's own decision points (tenancy, hosting-target, auth-strategy) only appear once it is chosen",
      enforcedBy: "composition-integrity",
    },
    {
      id: "full-union-green",
      rule: "The composed app passes the FULL union of the closure checks — the chassis's boot/contract checks, components-integrated, composition-integrity",
      enforcedBy: "prose-only",
    },
    {
      id: "dual-target-is-opt-in",
      rule: "target: both is chosen deliberately and never by default — it adds the second chassis's boot-e2e check to the union the app must pass on every build (MEASURED P-005: 6 declarations vs 5; the non-chassis four are shared), and that cost is stated in the ship disclosure",
      enforcedBy: "prose-only",
    },
    {
      id: "agents-are-explicit",
      rule: "No agent work plane and no seam unless `agents` was answered `pots` — the plane joins only by an explicit answer that puts papercusp-ops-pots in the composition, and is never implicit",
      enforcedBy: "composition-integrity",
    },
    {
      id: "agentic-plan-work-plane",
      rule: "When `agents` is `pots`, every external or scheduled agentic run uses an app-owned plan template, canonical plan-item promotion, the blocked-by DAG, and execution { appHarnessSlug, agentName } for actionable-only assignment plus required wake — never an app-local orchestration loop",
      enforcedBy: "prose-only",
    },
    {
      id: "one-seam",
      rule: "When `agents` is `pots`, the deterministic app and agentic work plane meet at exactly ONE typed seam — the seam discipline is papercusp-ops-pots' Tier B MUST and is honored in full, not re-invented in app code",
      enforcedBy: "prose-only",
    },
  ],
};

/** Aspect: the portable Rust/UniFFI/config/token contract shared by Android and iPhone. */
export const PAPERCUSP_MOBILE_BASE_TEMPLATE: TemplateManifest = {
  id: "papercusp-mobile-base",
  version: "0.1.0",
  scope: "aspect",
  category: "shell",
  summary:
    "The cross-platform base for official Papercusp mobile apps: a three-crate Rust workspace (portable core, " +
    "one UniFFI bindings crate, and an off-device CLI), one generated Kotlin/Swift boundary, deterministic design " +
    "tokens, explicit non-secret runtime configuration, source/placeholder/secret hygiene, and portable verification. " +
    "Product domain behavior, endpoints, copy, navigation, branding, assets, and optional native capabilities stay in " +
    "the consuming app.",
  components: [{ id: "rust-uniffi-mobile-base", version: "0.1.0" }],
  contracts: [],
  decisionPoints: [
    {
      id: "product-domain",
      prompt:
        "What domain behavior belongs in the portable Rust core, and what remains native presentation?",
    },
    {
      id: "rust-msrv",
      prompt: "Which supported Rust MSRV does the app require?",
    },
    {
      id: "license-and-repository",
      prompt:
        "What SPDX license, authorship, and repository metadata replace the neutral starter values?",
    },
    {
      id: "design-token-source",
      prompt:
        "Which product token values and typography replace the neutral token source while preserving deterministic Kotlin/Swift generation?",
    },
    {
      id: "optional-capabilities",
      prompt:
        "Which optional native seams—credentials, deep links, push, crash reporting, analytics, camera, microphone, media playback, or local networking—are enabled?",
    },
    {
      id: "runtime-configuration",
      prompt:
        "Which non-secret endpoints/identifiers are build-time versus runtime inputs, and which device credentials use secure storage?",
    },
  ],
  composesWith: [],
  docs: [
    "agent-insights/templates-system-design",
    "agent-insights/templates-template-yaml",
    "agent-insights/templates-component-catalog",
  ],
  checks: [
    {
      id: "mobile-base-contract",
      run: "checks/mobile-base-contract.test.ts",
      summary:
        "the three-crate Rust/UniFFI/token scaffold exists and source is free of unallowlisted placeholders, secret paths, and credential signatures",
    },
    {
      id: "mobile-base-commands",
      run: "checks/mobile-base-commands.test.ts",
      summary:
        "the configured Rust, binding-smoke, and token-drift commands execute directly and pass",
    },
  ],
  musts: [
    {
      id: "portable-domain-core",
      rule: "Portable domain outcomes, state transitions, validation, serialization, and error taxonomy live in Rust; native shells own presentation and platform lifecycle",
      enforcedBy: "mobile-base-contract",
    },
    {
      id: "single-uniffi-boundary",
      rule: "One UDL is the native contract source and generated Kotlin/Swift never becomes a hand-maintained second boundary",
      enforcedBy: "mobile-base-contract",
    },
    {
      id: "deterministic-mobile-tokens",
      rule: "One neutral token source deterministically generates Kotlin and Swift outputs and fails on drift",
      enforcedBy: "mobile-base-commands",
    },
    {
      id: "no-secrets-or-placeholders",
      rule: "Tracked source contains no usable credential, service payload, generated native artifact, unresolved identity placeholder, or foreign product identity outside an explicit allowlist",
      enforcedBy: "mobile-base-contract",
    },
    {
      id: "portable-verification",
      rule: "Rust format, clippy, tests, boundary smoke, and token drift execute as direct configured commands; unsupported platform legs report host-constrained in their shell checks",
      enforcedBy: "mobile-base-commands",
    },
    {
      id: "optional-capabilities-stay-optional",
      rule: "Credentials, links, push, analytics, crash reporting, camera, microphone, media, and local networking add no default base dependency",
      enforcedBy: "prose-only",
    },
  ],
};

/** Aspect: the Compose/Gradle/cargo-ndk chassis for official Android apps. */
export const PAPERCUSP_ANDROID_SHELL_TEMPLATE: TemplateManifest = {
  id: "papercusp-android-shell",
  version: "0.1.0",
  scope: "aspect",
  category: "shell",
  summary:
    "The Android chassis for official Papercusp mobile apps: a thin Compose application module, pinned " +
    "Gradle/AGP/Kotlin/Java/SDK/NDK inputs, incremental UniFFI Kotlin generation, four cargo-ndk ABIs, " +
    "secure capability and cleartext policy, native/unit/instrumentation acceptance, and release APK/AAB " +
    "provenance with external-only signing inputs and 16 KB alignment. Product screens, domain flows, " +
    "endpoints, brand, and optional service dependencies stay in the consuming app.",
  components: [],
  contracts: [],
  decisionPoints: [
    {
      id: "android-identity",
      prompt:
        "What namespace, application ID, package path, display name, version source, and launcher identity are used?",
    },
    {
      id: "android-sdk-floor",
      prompt:
        "Does the app keep the default minimum SDK or raise it for a selected capability?",
    },
    {
      id: "android-local-network",
      prompt:
        "Is a debug-only local cleartext endpoint required, and how is it constrained so release remains cleartext-free?",
    },
    {
      id: "android-capabilities",
      prompt:
        "Which optional permissions, features, services, Gradle plugins, repositories, and manifest entries are enabled?",
    },
    {
      id: "android-release",
      prompt:
        "Which external signing-property names, release channel, version input, and provenance destination are used?",
    },
  ],
  composesWith: ["papercusp-mobile-base"],
  docs: [
    "agent-insights/templates-system-design",
    "agent-insights/templates-template-yaml",
    "agent-insights/templates-component-catalog",
  ],
  checks: [
    {
      id: "android-shell-contract",
      run: "checks/android-shell-contract.test.ts",
      summary:
        "the parameterized Compose/Gradle/cargo-ndk source pins identity, toolchains, generated bindings, ABI inputs, privacy, test roots, and external-only signing without developer-home or product assumptions",
    },
    {
      id: "android-shell-assertions",
      run: "checks/android-shell-commands.test.ts",
      summary:
        "every MOB-AND host leg runs directly, writes an atomic machine evidence record, and proves binding generation, exact packaged ABIs, lint, unit/instrumentation smoke, merged-manifest privacy, provenance, missing-signing rejection, and 16 KB alignment",
    },
  ],
  musts: [
    {
      id: "pinned-android-chassis",
      rule: "One thin Compose app module pins Gradle 8.14.3, AGP 8.13.2, Kotlin 2.0.21, Java 17, compile/target SDK 36, NDK 27.0.12077973, and an explicitly chosen minimum SDK",
      enforcedBy: "android-shell-contract",
    },
    {
      id: "generated-binding-before-compile",
      rule: "Gradle generates Kotlin from the one UniFFI UDL/config/lock input set before preBuild and declares the generated output",
      enforcedBy: "android-shell-contract",
    },
    {
      id: "exact-abi-and-alignment",
      rule: "Fresh cargo-ndk output and packaged APK/AAB contain exactly arm64-v8a, armeabi-v7a, x86, and x86_64; checksum exports and every 64-bit release ELF/APK satisfy the 16 KB contract",
      enforcedBy: "android-shell-assertions",
    },
    {
      id: "native-tests-and-privacy",
      rule: "Lint, non-zero JVM unit and instrumentation smoke, merged-manifest permission allowlisting, and release cleartext prohibition execute on an Android-capable host",
      enforcedBy: "android-shell-assertions",
    },
    {
      id: "provenance-and-external-signing",
      rule: "A publishable APK/AAB pair binds one version and clean source commit to atomic SHA-256 provenance, while signing names have no templated values and their absence fails publish preflight",
      enforcedBy: "android-shell-assertions",
    },
    {
      id: "product-capabilities-stay-owned",
      rule: "Optional permissions, services, plugins, repositories, and provider dependencies appear only when selected; product screens, routes, data, endpoints, brand, and domain behavior never enter the shell",
      enforcedBy: "prose-only",
    },
  ],
};

/** Aspect: the SwiftUI/XcodeGen/XCFramework chassis for official iPhone apps. */
export const PAPERCUSP_IPHONE_SHELL_TEMPLATE: TemplateManifest = {
  id: "papercusp-iphone-shell",
  version: "0.1.0",
  scope: "aspect",
  category: "shell",
  summary:
    "The iPhone chassis for official Papercusp mobile apps: a thin SwiftUI application generated from " +
    "XcodeGen source, a dedicated generated-binding module over one device-and-simulator XCFramework, " +
    "local or named-remote Mac execution, non-zero XCTest/XCUITest acceptance, explicit privacy and " +
    "entitlement policy, and archive/export/signing preflight with no upload. Product screens, domain " +
    "flows, endpoints, brand, and optional service dependencies stay in the consuming app.",
  components: [],
  contracts: [],
  decisionPoints: [
    {
      id: "iphone-identity",
      prompt:
        "What bundle ID, module, scheme, product/display name, version/build source, and generated project name are used?",
    },
    {
      id: "iphone-os-floor",
      prompt:
        "Does the app keep the default deployment target or raise it for a selected capability?",
    },
    {
      id: "iphone-capabilities",
      prompt:
        "Which optional entitlements, privacy declarations, URL schemes, associated domains, background modes, and Swift packages are enabled?",
    },
    {
      id: "iphone-test-host",
      prompt:
        "Are Xcode checks executed locally on macOS or delegated to a named Mac host from Linux?",
    },
    {
      id: "iphone-release",
      prompt:
        "Which external team/signing inputs, archive/export mode, release channel, and validation actions are used?",
    },
  ],
  composesWith: ["papercusp-mobile-base"],
  docs: [
    "agent-insights/templates-system-design",
    "agent-insights/templates-template-yaml",
    "agent-insights/templates-component-catalog",
  ],
  checks: [
    {
      id: "iphone-shell-contract",
      run: "checks/iphone-shell-contract.test.ts",
      summary:
        "the parameterized SwiftUI/XcodeGen source pins identity, the dedicated generated Swift module, exact Rust slices, XCFramework inputs, host strategy, privacy declarations, external signing names, and no-upload release preflight without product assumptions",
    },
    {
      id: "iphone-shell-assertions",
      run: "checks/iphone-shell-commands.test.ts",
      summary:
        "every MOB-IOS host leg runs directly, writes an atomic machine evidence record, and proves deterministic project generation, XCFramework and module compilation, host health, non-zero XCTest/XCUITest execution, privacy/capability agreement, archive/export preflight, and signing-absence rejection",
    },
  ],
  musts: [
    {
      id: "xcodegen-source-chassis",
      rule: "One thin SwiftUI app pins iOS 17.0 or higher and Swift 5.9, keeps ios/project.yml as the XcodeGen source of truth, and treats the generated .xcodeproj as ignored build output",
      enforcedBy: "iphone-shell-contract",
    },
    {
      id: "exact-xcframework-slices",
      rule: "Fresh Rust builds produce aarch64-apple-ios plus aarch64-apple-ios-sim and x86_64-apple-ios, lipo the simulator library, and create one XCFramework with generated headers and modulemap",
      enforcedBy: "iphone-shell-contract",
    },
    {
      id: "dedicated-generated-module",
      rule: "Generated Swift and the FFI XCFramework compile behind their own framework target; the app and tests import that module instead of compiling generated bindings ad hoc",
      enforcedBy: "iphone-shell-contract",
    },
    {
      id: "host-and-test-evidence",
      rule: "Local-mac or named remote-host preflight proves Xcode, SDK, simulator, XcodeGen, and SwiftFormat health; XCTest and XCUITest execute a non-zero count, while incapable hosts report host-constrained",
      enforcedBy: "iphone-shell-assertions",
    },
    {
      id: "privacy-and-no-upload-release",
      rule: "Privacy manifest, usage descriptions, background modes, selected entitlements, and capability answers agree; archive/export/signing preflight uses external input names and performs no upload",
      enforcedBy: "iphone-shell-assertions",
    },
    {
      id: "product-capabilities-stay-owned",
      rule: "Optional capabilities, Swift packages, product screens, routes, data, endpoints, brand, assets, and domain behavior appear only when selected by the consuming product",
      enforcedBy: "prose-only",
    },
  ],
};

/** App: the thin official Android composition root. */
export const PAPERCUSP_ANDROID_APP_TEMPLATE: TemplateManifest = {
  id: "papercusp-android-app",
  version: "0.1.0",
  scope: "app",
  category: "app",
  summary:
    "The official whole-app root for a Papercusp-style Android app: a thin pure composition that hard-requires " +
    "papercusp-mobile-base and papercusp-android-shell at 0.1.0, records every decision-point answer in the exact " +
    "closure, and runs the additive union of portable and Android-native checks. It adds no product component or " +
    "platform behavior of its own.",
  components: [],
  contracts: [],
  decisionPoints: [
    {
      id: "android-app-purpose",
      prompt:
        "What product is this Android app, and which answers are supplied to every decision point in its exact dependency closure?",
    },
  ],
  composesWith: ["papercusp-mobile-base", "papercusp-android-shell"],
  requires: [
    { id: "papercusp-mobile-base", version: "0.1.0" },
    { id: "papercusp-android-shell", version: "0.1.0" },
  ],
  docs: [
    "agent-insights/templates-system-design",
    "agent-insights/templates-template-yaml",
    "agent-insights/templates-component-catalog",
  ],
  checks: [
    {
      id: "composition-integrity",
      run: "checks/composition-integrity.test.ts",
      summary:
        "the root resolves exactly to the pinned mobile-base and Android-shell closure, every tagged decision point has a non-empty answer, and the additive union retains every closure check",
    },
  ],
  musts: [
    {
      id: "thin-app-template",
      rule: "The Android app root adds purpose and composition guidance only; reusable behavior belongs in the mobile-base or Android-shell aspects and product behavior stays in the consumer",
      enforcedBy: "composition-integrity",
    },
    {
      id: "exact-mobile-closure",
      rule: "The root hard-requires exactly papercusp-mobile-base@0.1.0 and papercusp-android-shell@0.1.0 with no unpinned or substitute chassis",
      enforcedBy: "composition-integrity",
    },
    {
      id: "complete-decision-record",
      rule: "The materialized checks config records one non-empty template-id:decision-id answer for every decision point in the exact closure",
      enforcedBy: "composition-integrity",
    },
    {
      id: "full-union-green",
      rule: "The composed Android app passes the full additive union of root, shared-base, and Android-shell checks; the root never duplicates or weakens aspect assertions",
      enforcedBy: "composition-integrity",
    },
    {
      id: "product-behavior-stays-owned",
      rule: "Domain flows, endpoints, routes, copy, brand, assets, and selected optional capability implementations remain owned by the consuming product",
      enforcedBy: "prose-only",
    },
  ],
};

/** App: the thin official iPhone composition root. */
export const PAPERCUSP_IPHONE_APP_TEMPLATE: TemplateManifest = {
  id: "papercusp-iphone-app",
  version: "0.1.0",
  scope: "app",
  category: "app",
  summary:
    "The official whole-app root for a Papercusp-style iPhone app: a thin pure composition that hard-requires " +
    "papercusp-mobile-base and papercusp-iphone-shell at 0.1.0, records every decision-point answer in the exact " +
    "closure, and runs the additive union of portable and iPhone-native checks. It adds no product component or " +
    "platform behavior of its own.",
  components: [],
  contracts: [],
  decisionPoints: [
    {
      id: "iphone-app-purpose",
      prompt:
        "What product is this iPhone app, and which answers are supplied to every decision point in its exact dependency closure?",
    },
  ],
  composesWith: ["papercusp-mobile-base", "papercusp-iphone-shell"],
  requires: [
    { id: "papercusp-mobile-base", version: "0.1.0" },
    { id: "papercusp-iphone-shell", version: "0.1.0" },
  ],
  docs: [
    "agent-insights/templates-system-design",
    "agent-insights/templates-template-yaml",
    "agent-insights/templates-component-catalog",
  ],
  checks: [
    {
      id: "composition-integrity",
      run: "checks/composition-integrity.test.ts",
      summary:
        "the root resolves exactly to the pinned mobile-base and iPhone-shell closure, every tagged decision point has a non-empty answer, and the additive union retains every closure check",
    },
  ],
  musts: [
    {
      id: "thin-app-template",
      rule: "The iPhone app root adds purpose and composition guidance only; reusable behavior belongs in the mobile-base or iPhone-shell aspects and product behavior stays in the consumer",
      enforcedBy: "composition-integrity",
    },
    {
      id: "exact-mobile-closure",
      rule: "The root hard-requires exactly papercusp-mobile-base@0.1.0 and papercusp-iphone-shell@0.1.0 with no unpinned or substitute chassis",
      enforcedBy: "composition-integrity",
    },
    {
      id: "complete-decision-record",
      rule: "The materialized checks config records one non-empty template-id:decision-id answer for every decision point in the exact closure",
      enforcedBy: "composition-integrity",
    },
    {
      id: "full-union-green",
      rule: "The composed iPhone app passes the full additive union of root, shared-base, and iPhone-shell checks; the root never duplicates or weakens aspect assertions",
      enforcedBy: "composition-integrity",
    },
    {
      id: "product-behavior-stays-owned",
      rule: "Domain flows, endpoints, routes, copy, brand, assets, and selected optional capability implementations remain owned by the consuming product",
      enforcedBy: "prose-only",
    },
  ],
};

/** The reference template set — validateTemplateSet(REFERENCE_TEMPLATES) must stay green. */
export const REFERENCE_TEMPLATES: TemplateManifest[] = [
  PAPERCUSP_APP_TEMPLATE,
  PAPERCUSP_OPS_HIVES_TEMPLATE,
  TAURI_DESKTOP_SHELL_TEMPLATE,
  PAPERCUSP_DATA_SYNC_TEMPLATE,
  PAPERCUSP_SEARCH_TEMPLATE,
  PAPERCUSP_DATA_LAYER_TEMPLATE,
  PAPERCUSP_UI_TEMPLATE,
  RELEASE_PIPELINE_TEMPLATE,
  PROJECT_HISTORY_TEMPLATE,
  PAPERCUSP_WEB_HOST_TEMPLATE,
  PAPERCUSP_MOBILE_BASE_TEMPLATE,
  PAPERCUSP_ANDROID_SHELL_TEMPLATE,
  PAPERCUSP_IPHONE_SHELL_TEMPLATE,
  PAPERCUSP_ANDROID_APP_TEMPLATE,
  PAPERCUSP_IPHONE_APP_TEMPLATE,
];
