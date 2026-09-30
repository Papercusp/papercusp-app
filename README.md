# Papercusp

Papercusp is a desktop workspace where coding agents work alongside you, coordinated
through shared plans, work items, locks and memory. This repository is its source,
licensed under the Elastic License 2.0 (see LICENSE and NOTICE): you may read, run,
modify and self-host it, but not offer it to others as a hosted or managed service.

- Exported from `Papercusp/papercup` at `e89081eeca350093f221036099aa831a5a644384`, with
  37 submodule(s) flattened in at their pinned commits (MANIFEST.json).
- It is the same public-safe source cut the Papercusp Server installer carries, without
  `node_modules` (run `npm ci` to install dependencies from `package-lock.json`), plus the
  Tauri desktop shell in `papercusp-desktop/`.
- Each update is a new commit on top of the previous one, so `git pull` works and forks
  and pull requests keep a shared history.

## Download Papercusp

Installers for every published version, with release notes and install instructions, are on
the **[Papercusp releases page](https://pub-cb5359a346e94c0c88562bd41db9295a.r2.dev/HK70BNWvxXWRRRkMgl3PXqgdZyWYLsCG/index.html)**. Install both apps: **Papercusp Server**
runs the operator, its embedded database and your agents on your machine, and **Papercusp GUI**
is the desktop window onto it.

## Build and run from source

You need **Node.js 25** (see `.nvmrc`), **Rust stable** (1.77 or newer) and your platform's
webview build libraries (the table under "Prerequisites" in `papercusp-desktop/README.md`).
You also need **pgvector for PostgreSQL 18**: the app runs its own embedded Postgres, and the
schema uses the `vector` extension, which that Postgres does not ship with. On Debian or
Ubuntu, install `postgresql-18-pgvector` from the PostgreSQL apt repository
(https://wiki.postgresql.org/wiki/Apt); on macOS, `brew install pgvector`.

```sh
npm ci                                               # also copies pgvector into the embedded Postgres
npm --workspace @papercusp/operator-vite run build   # the UI bundle the desktop window loads
cd papercusp-desktop && npm ci && npm run dev        # builds the Rust shell and opens the window
```

The first `npm run dev` compiles the Rust shell, which takes several minutes. The app then
creates its embedded database, applies the migrations and serves the operator from this
tree. If pgvector was missing during `npm ci`, install it and run
`node scripts/install-embedded-pgvector.mjs`. Release installers are built by
`papercusp-desktop/bin/build-linux-local.sh` and its siblings, which also need signing and
release-identity inputs that development does not.

## How this source ships inside every release

The Papercusp Server installer carries this same source tree as one compressed resource,
`sidecar/source.tar.zst`:

- **What is in it.** The code you are reading plus its already-installed `node_modules`. The
  release build selects it with the same allowlist, and checks it with the same audit, that
  produced this snapshot. Both refuse git history, internal plans, agent transcripts and
  state, and credentials, and both redact personal identity. The only difference here is that
  `node_modules` is left out.
- **Where it goes.** On first launch the app extracts the archive into a writable folder in
  its own data directory (on Windows, inside the `papercup-runtime` WSL distro). Later
  launches skip the extract.
- **What runs from it.** Two of the environments in the app's environment switcher run
  Papercusp from that extracted source instead of from the prebuilt server: **dev**
  (port 3270) runs the API host straight from TypeScript (`tsx apps/operator/bin/hono-host.ts`),
  and **local** (port 3055) runs the Vite dev server over the UI in `apps/operator-vite`.
  Both run on the Node.js bundled in the app with the tree's own `tsx` and `vite`, because
  an installed machine has no npm.

## Why the release carries its own source

So that the Papercusp you installed can run a Papercusp you changed. Papercusp is developed
with Papercusp, and shipping the runnable source means any install can do what the
development machine does: open the tree, edit it (by hand or with agents), and run the edited
build side by side with the installed one, without cloning a repository or installing a
toolchain. Two design choices follow from that:

- **Extracted to a writable folder, not run in place.** The install directory is read-only,
  and a source tree you cannot edit defeats the purpose.
- **One archive, not loose files.** The tree with its `node_modules` runs to several
  gigabytes of small files. Copying them one by one through the app bundler's resource
  pipeline is slow, and the `node_modules/.bin` symlinks survive `tar` but not that copy.

This repository is the same source without `node_modules`, so you can read it before you install.

## Contributing, security and telemetry

- **Contributing:** see CONTRIBUTING.md. Code contributions need a signed Contributor
  License Agreement; a bot links it on your first pull request.
- **Security:** report vulnerabilities privately, as described in SECURITY.md.
- **Conduct:** everyone taking part follows CODE_OF_CONDUCT.md.
- **Telemetry is off unless you opt in** during setup, and development builds never send
  any. If you distribute your own build, point opted-in telemetry at your own PostHog
  with `PAPERCUSP_POSTHOG_HOST` and `PAPERCUSP_POSTHOG_KEY` (or `~/.papercusp/posthog.json`);
  otherwise it goes to Papercusp's. The in-app support chat loads only on the `/support` page.

## Where to read first

- `CLAUDE.md` / `AGENTS.md` — the conventions every agent in this codebase works under.
- `docs/` — design and architecture notes.
- `apps/operator/` — the operator: API host, agent tools, coordination.
- `libs/papercusp/` — the core platform libraries (database schema and migrations live in `libs/papercusp/libs/db/`).

## Top-level layout

- `.gitignore`
- `.nvmrc`
- `AGENTS.md`
- `BORROWABLE.md`
- `CLAUDE.md`
- `apps/`
- `bin/`
- `design-tokens/`
- `design/`
- `docs/`
- `eslint.config.mjs`
- `knip.json`
- `libs/`
- `package-lock.json`
- `package.json`
- `packages/`
- `papercusp-desktop/`
- `patches/`
- `rubrics/`
- `scripts/`
- `templates/`
- `tools/`
- `tsconfig.base.json`
- `tsconfig.declarations.json`
- `vitest.config.ts`

## Workspaces

| path | package | description |
|---|---|---|
| `apps/operator` | `@papercusp/web` |  |
| `apps/operator-docs` | `@papercupai/operator-docs` |  |
| `apps/operator-public` | `@papercusp/cupboard-worker` |  |
| `apps/operator-vite` | `@papercusp/operator-vite` |  |
| `apps/papercusp-docs` | `@papercupai/papercusp-docs` |  |
| `libs/agent-chat` | `@papercusp/agent-chat` | Reusable React agent-chat UI components (streaming transcript, tool calls, message composer). |
| `libs/flags` | `@papercusp/flags` | Feature flags for Papercusp. Server-side evaluation via PostHog with file-only fallback. Clients never load PostHog SDK - they fetch resolved booleans from the backend. |
| `libs/generic/activity-bridge` | `@papercusp/activity-bridge` | Normalize cross-CLI coding-agent hook events (native tool calls / lifecycle / todo snapshots, across Claude/Codex/OMP-style CLIs) into a uniform { kind, summary, detail } activity record, and persist them through an injected TelemetryStore port. Pure normalizer + a narrow ingest seam; zero host coupling — the consumer supplies the store (PG, SQLite, memory, …). |
| `libs/generic/agent-roster` | `@papercusp/agent-roster` | Headless agent-roster presentation — fleet grouping/ordering, activity-liveness and thinking predicates, display-name and glyph resolution, machine tabs, and the row/section rendering. Data arrives as props; host chrome (popover, tooltip, dots), labels and row/bulk actions enter through injected components and callbacks, so no host path is imported. |
| `libs/generic/artifact-registry` | `@papercusp/artifact-registry` | A generic artifact registry: publish/install distributable artifacts (plugins, snapshots, blueprints, packages…) over a pluggable storage backend. Content-addressed blob store (hash-verified put/get, idempotent dedupe, visibility-gated download, refcounted GC) behind a BlobStore port, plus an ArtifactRegistry over a ListingStore port (publish-with-dedup, list, get, unlist+GC, claim) with the domain — kinds, identity/trust, validation — injected. Zero coupling: no Cloudflare, no SQL, no HTTP framework. Web-Crypto only. |
| `libs/generic/audio-dsp` | `@papercusp/audio-dsp` | Generic real-time audio DSP cores: NLMS acoustic echo cancellation with bulk-delay estimation + double-talk detection, gain, and the noise-suppressor seam. Pure algorithms on PCM16 frames — zero runtime deps; engine bindings (e.g. RNNoise WASM) are host-injected. |
| `libs/generic/bench-metrics` | `@papercusp/bench-metrics` | Benchmark scoring + cost/Pareto metrics for the impartial benchmark suite (impartial-benchmark-suite-2026-06-15, BRIEF 7 / P-011). Owns the canonical run-result TS schema (co-defined with P-010), a published model price table, per-arm token/$ accounting (coordination overhead counted), iso-budget verification, cost/accuracy Pareto, and pass@1-over-seeds + confidence intervals + a uniform pass@k/pass^k protocol. The pure statistics cores (pass-k, intervals, pareto) are domain-free and independently borrowable; schema/pricing/aggregate compose them into the benchmark layer. |
| `libs/generic/cache` | `@papercusp/cache` | Generic workspace-scoped cache: getOrSet/invalidateByTag over a tag-based bumpable-generation model, an in-process L1 LRU, single-flight, and stale-while-revalidate. Pure algorithm + injected GenerationStore seam (in-memory default; host wires a NOTIFY-fed map / PG store). Zero domain coupling, zero runtime deps. |
| `libs/generic/card-stack` | `@papercusp/card-stack` | Overlapping card-deck browser for same-type items — index-based transform animation (Motion card-stack pattern, pure CSS: mounted layers, fly-off/return, animated height), down-right stacked peeks with dimmed live content, on-card Prev/Next pills, keyboard arrows, story-style position dots, and an on-card category badge. Headless of domain: render-prop cards, theme via CSS custom properties with self-contained fallbacks. Zero runtime deps beyond React + lucide-react (peers). |
| `libs/generic/chat-cards` | `@papercusp/chat-cards` | Host-free React renderers for @papercusp/chat-protocol interactive cards. Cards and transport callbacks enter through props; no operator or portal path is imported. |
| `libs/generic/chat-protocol` | `@papercusp/chat-protocol` | Deps-free streaming-chat wire contract — SSE event union + interactive-card protocol. Shared across Restart (Scout) and papercusp. |
| `libs/generic/control-mutation` | `@papercusp/control-mutation` | The D-005 control-mutation harness: dryRun preview · apply · post-apply verify (auto-revert) · audit · one-call revert, over an injected audit-write port. Pure, zero domain/DB coupling. |
| `libs/generic/debounce-coalesce` | `@papercusp/debounce-coalesce` | Generic per-subscriber wake-floor + burst-coalesce primitive: a leading-edge debounce that enforces a minimum re-invocation interval per subscriber and folds the events suppressed inside the window into ONE delivery carrying their union, with an urgency bypass and a max-staleness deadline. Pure algorithm over injected time + state; zero domain coupling, zero runtime deps. The host persists the per-subscriber state and supplies `now`. |
| `libs/generic/decision-model` | `@papercusp/decision-model` | Provider-agnostic client for typed decision models (choice / score / yes-no questions answered with probabilities, no text output). Ships a TypeSafe Jev adapter pinned to a versioned model id, a single-deadline client with 429/529 backoff, per-call credential resolution and a fire-and-forget call observer. Every failure is a typed inconclusive{reason} — never an empty verdict. Zero domain coupling behind a configure*() seam. |
| `libs/generic/dependency-order` | `@papercusp/dependency-order` | Order nodes so every node's dependencies are visited first, grouping each dependency cycle into one batch instead of failing. Iterative Tarjan (no recursion, so a deep import graph cannot overflow the stack); the edge source is injected, so it works from a plain import scan as readily as from a code-graph service. Dependencies referenced but absent from the node set are reported as external rather than silently dropped. Zero I/O, zero domain coupling, zero dependencies. |
| `libs/generic/deployment-driver` | `@papercusp/deployment-driver` | Provider-agnostic deployment abstraction: a DeploymentDriver (provision/install/join/teardown over a Frame handle) selected by an open `target` discriminator, with a built-in no-op `local` driver and a configure*() host seam for cloud backends. Pure, zero domain coupling, zero runtime deps — each backend narrows + validates its own provider config host-side. |
| `libs/generic/desktop-ipc` | `@papercusp/desktop-ipc` | Endpoint-stream transport for Tauri desktop webviews: an IPC transport (over the Tauri bridge) + HTTP transport + a runtime picker, with the desktop-bootstrap fetch/EventSource polyfills. Routes /api/* over IPC to dodge the WebKitGTK/libsoup 6-connection-per-host limit. |
| `libs/generic/dock-workbench` | `@papercusp/dock-workbench` | Host-agnostic dockview workbench shell: panel registry, logical layout schema, adapters, pluggable persistence, and React DockWorkspace. |
| `libs/generic/embedded-pg-discovery` | `@papercusp/embedded-pg-discovery` | Generic Postgres connection-URL discovery for desktop / local-first apps: env vars → JSON discovery file → fallback. Pure, zero domain coupling, parameterized. |
| `libs/generic/eval-battery` | `@papercusp/eval-battery` | The one eval-battery engine: a bounded variant×case×repeat battery loop with a swappable `Subject` port (run → collect/distill → judge → score, never-abort + rate-pause discipline) plus the frozen LLM-judge + scoring + rate-pause cores it owns. The gym is the `HarnessSubject` (a component eval), the Apiary/gen-0 is the `InstanceSubject` (a whole-instance eval) — one engine, two subjects (self-improvement-stack-reconciliation-2026-06-09 D-001). Pure, dependency-injected core; the only runtime dep is the rate-limit-error classifier. |
| `libs/generic/event-reaction` | `@papercusp/event-reaction` | A generic, durable ECA reaction engine over any dispatcher. Register reaction rules { id, on, when, fire, args } plus execution metadata (mode, onlyOnSuccess, capability, dedupKey); given a settled event, match -> loop-guard (depth + cycle) -> schedule (durable enqueue or in-process), with an idempotent durable executor over an injected store. Builds on @papercusp/rules (the pure matcher); dispatch, the durable runner, and the dedup store are injected as ports, so it has zero coupling to any host. |
| `libs/generic/facets` | `@papercusp/facets` | A domain-free faceted-filtering core. Given a list of rows of any type T and a set of facet definitions (each knowing how to extract 0..N values from a row), it tallies value counts, hides facets that can't filter (single-value), sorts + caps values, and builds the AND-across / OR-within filter predicate — all from the ACTUAL rows, so both the facets shown and their values reflect only what is present. Pure, sync, no React. The domain knowledge lives entirely in the caller-supplied `extract(row)` closures; the lib carries the algorithm. |
| `libs/generic/failure-detector` | `@papercusp/failure-detector` | A generic, pure failure detector: φ-accrual (Hayashibara 2004 — a continuous suspicion level from observed heartbeat inter-arrivals, instead of a binary timeout) + SWIM-style indirect probing (Das 2002 — ask k relays before declaring a peer dead) + a combined eviction policy. Zero I/O, zero timers, zero domain coupling — the caller feeds heartbeats and injects the relay-probe transport; the lib decides suspicion + whether to evict. |
| `libs/generic/fanout-resolver` | `@papercusp/fanout-resolver` | A generic, pure generative fan-out core. Resolve a fan-out spec (inline items / file-glob / SQL query — runners injected; or a `deferred` set produced later by an upstream producer) to a deduped, trimmed, capped item list, then expand a list into N deterministic-id children. Zero I/O, zero domain coupling — glob/SQL runners are injected; over-cap fan-out and resolver failures throw (FanoutCapError / FanoutResolverError) rather than silently truncating or yielding zero. |
| `libs/generic/git-graph` | `@papercusp/git-graph` | React components for rendering a git commit graph (commit list, commit detail, diff tooltips). Brand-value-free; styling injected by consumers via git-graph.css. |
| `libs/generic/gui-readiness` | `@papercusp/gui-readiness` | Generic, domain-free GUI process/window readiness barrier + cold-start measurement. Level-triggered polling with a hard deadline and process-liveness fail-fast, so waiting for readiness can NEVER hang — including when attaching to an already-running (persistent) process whose one-shot startup signal already fired before you started watching. |
| `libs/generic/image-blankness` | `@papercusp/image-blankness` | Generic zero-dependency detector for a BLANK image capture — a screenshot a tool wrote successfully, and exited 0 over, of a window that never painted (uniform fill, smooth gradient, fully transparent). Decodes non-interlaced PNG with node:zlib alone, then judges adjacent-pixel detail PER ROW so that content occupying only a narrow band of an otherwise empty frame still reads as rendered. Deliberately fail-open: anything undecodable, too small, or merely ambiguous is never reported 'blank', so a caller can act only on a confident negative. |
| `libs/generic/ipc-endpoint-server` | `@papercusp/ipc-endpoint-server` | Host-agnostic Unix-socket/named-pipe server for the endpoint IPC protocol: framed REQUEST/CANCEL in, EVENT_JSON/EVENT_BIN/DONE/ERROR out, with the privileged sys:http HTTP-over-IPC bridge. Tool resolution, dispatch, and workspace state are injected via an IpcEndpointHost seam — zero registry or application coupling. |
| `libs/generic/ipc-framing` | `@papercusp/ipc-framing` | Length-prefixed binary frame codec for IPC/socket streams: [4B BE length][1B type][payload], with a streaming decoder. Pure, zero dependencies, zero domain coupling. |
| `libs/generic/kokoro-tts` | `@papercusp/kokoro-tts` | Generic, domain-free port of kokoro-js@1.2.1's glue (text normalization + phonemization chain, voice-style table + HF voices-bin loader, StyleTextToSpeech2Model wrapper) — Apache-2.0-attributed, upstream https://github.com/hexgrad/kokoro. Zero @huggingface/transformers runtime dependency: the model/tokenizer/tensor primitives are host-injected via configureKokoroTts() (WI-4470), so this package never pins a transformers version and can't create the nested-dependency duplicate that vendoring originally worked around (see WI-4449/WI-4471). The tiny `phonemizer` package is a real dependency (no injection needed). |
| `libs/generic/lexicon` | `@papercusp/lexicon` | A generic terminology resolver: maps a canonical term key to a display label keyed by an active brand pack. Ships pure singular/plural/lowercase resolution over a closed set of term keys, a registry of brand packs, and a `configure*()` host seam so an ambient (non-React) caller can resolve against the host-selected pack. Zero domain coupling beyond the shipped packs; the selection mechanism (which pack is active) is injected by the host, never imported. |
| `libs/generic/linkable-edges` | `@papercusp/linkable-edges` | A generic typed-entity graph: polymorphic edges (src →rel→ dst) between {kind,ref} object references, with idempotent link/unlink + directional listOut/listIn queries over an injected store. Ships an in-memory store, a Taggable-rides-Linkable helper (a tag IS an object→topic edge), and one conformance suite any backend can run. Zero domain coupling — the host injects the store (PG, etc.). |
| `libs/generic/locks-core` | `@papercusp/locks-core` | Generic, pure concurrency + causality primitives for distributed coordination. Four zero-I/O, zero-domain-coupling modules: Hybrid Logical Clocks (Kulkarni 2014 — 8-byte causal timestamps that stay monotone across NTP steps, the software substitute for TrueTime); state-based CRDTs (PN-Counter, add-wins OR-Set, per-field HLC LWW-Register, version vectors / dotted version vectors, and a Thomas-Write-Rule merge decision that routes genuine concurrency to a resolver instead of clobbering); the Gray-1976 multi-granularity intention-lock matrix (IS/IX/S/SIX/X compatibility, ancestor lock-set derivation, conflict detection); and authority-hardening — fencing + anti-flap for a lowest-id leader election (monotonic fencing token a la Kleppmann, no-preemption hysteresis + re-grant cooldown a la Consul/Chubby, an RCU grace window on handover). The consumer injects persistence/transport (a PG lock store, a federation outbox) and maps its own domain onto these algorithms — the lib names no host. |
| `libs/generic/memory` | `@papercusp/memory` | Persistent-memory store behind a swappable MemoryBackend seam: neutral remember/search/list/forget/update verbs over {id,text,kind,scope,score,metadata}, a backend registry + selector (configureMemory({backend})), and three shipped impls — mem0 (mem0ai/oss + canonical pgvector store, per-embedder vec tables, local BGE embedder, re-embed pass), noop (clean 'no store'), and claude-file (Claude Code topic-file bridge). Host-agnostic — admin URL, LLM credentials, embedder, and backend choice are injected via configureMemory(). Zero @papercusp/@restart runtime deps. |
| `libs/generic/model-pricing` | `@papercusp/model-pricing` | Canonical model→price table + cost estimation for agent usage telemetry (cross-backend-cost-capture). Single source of truth for claude/codex/openai list prices; consumed by the orchestrator (cost cap, usage samples), operator-core (telemetry, insights), and testing-shell (re-export). Dependency-free. |
| `libs/generic/module-singleton` | `@papercusp/module-singleton` | Pin a module's mutable state to the realm under a Symbol.for key AND count module evaluations, so a split module-singleton (tsx CJS/ESM double-load, bare-vs-relative specifier, symlinked node_modules) is both fixed and observable instead of silently halving every reader's view. Domain-free; no host coupling; no dependencies. |
| `libs/generic/overlap-clusters` | `@papercusp/overlap-clusters` | Generic near-duplicate overlap detection over embedded units: cross-source pair thresholding, union-find clustering, and a census that makes an empty result distinguishable from a blind one. Domain-free; the neighbour source is injected at a configure*() seam so a host can back it with an ANN index rather than brute force. |
| `libs/generic/p2p-voice` | `@papercusp/p2p-voice` | Generic P2P voice-channel core: channel join/leave over an injected swarm, per-peer control+audio framing, codec seam, N-peer mixing, per-peer tap. Pure algorithm — swarm and codec are host-injected; zero runtime deps. |
| `libs/generic/papergrid` | `@papercusp/papergrid` | Workspaces meta-package for the Papercusp data-grid stack: @papercusp/grid-core (sort/selection/virtualization logic), @papercusp/bloom-grid (row store + server render), and @papercusp/grid. Consumers depend on the sub-packages directly. |
| `libs/generic/plan-parser` | `@papercusp/plan-parser` | Pure plan-document parser and versioned Project History read-model assembler. Zero I/O, zero product coupling. |
| `libs/generic/plugin-loader` | `@papercusp/plugin-loader-core` | Generic, domain-free plugin-loader kernel: a filesystem→typed-plugin discovery pipeline (discover dirs → read+validate manifest → optional alternate-runtime dispatch → import entry → validate → dedupe by name with source precedence), a pluggable JSON-Schema manifest validator (ajv), and a minimal semver-range matcher. All host-specifics (manifest shape, validation rules, runtime kinds, search-path resolution) inject through a ports object — the lib names no consuming app. |
| `libs/generic/pot-app-seam` | `@papercusp/pot-app-seam` | A host-injected seam for agentic apps that bootstrap one or more pots, launch deterministic app requests as canonical plan runs, and ingest judged pot outputs through explicit parser/storage ports. The package is framework-agnostic and imports no Papercusp operator internals; the host supplies the pot, plan-run, and ingestion adapters. |
| `libs/generic/projection-index` | `@papercusp/projection-index` | A generic, event-maintained structured→index projection. Feed it source records as they change; it keeps an inverted index (key → entries) incrementally — computing the minimal delta against each source's prior contributions so a record that drops or retags an entry removes the stale one. Query a key to get the aggregated entries: no full scan, no re-summarisation, no drift. The domain mapping (record → contributions) and the persistence store are injected; the lib owns only the incremental-maintenance algorithm. Zero I/O, zero domain coupling, zero runtime deps. |
| `libs/generic/pubsub-substrate` | `@papercusp/pubsub-substrate` | A host-agnostic agent-coordination / pub-sub substrate: the pure protocol core (envelope types + identity-free fold/merge/glob logic), a swappable append-only CoordEventLog (the outbox/CDC channel-log seam — fs default + in-memory double, covering messages/handoffs/escalations/plan-events), PresenceStore (live presence), and WatermarkStore (per-agent read cursors). Every store is an interface with an in-memory + portable-fs double, all passing one conformance suite; the PG backends are injected by the host adapter (@papercusp/coordination). Zero domain coupling, zero postgres dep. |
| `libs/generic/ranked-selection` | `@papercusp/ranked-selection` | Select an ordered menu of participants from a ranked candidate list under a named bounds policy: take qualified candidates best-first up to a maximum, then, when fewer than the minimum result, fill from the full ranked pool with the fill picks LABELLED rather than silently blended. Ships the pure selection algorithm generic over the candidate type, plus a `configure*()` policy registry so several call sites read one shared setting instead of each hard-coding its own bounds. Zero I/O, zero domain coupling. |
| `libs/generic/rate-limit` | `@papercusp/rate-limit` | Generic two-bucket rate limiter (soft refundable + hard lockout) over an injected BucketStore. Pure algorithm, zero domain coupling, zero runtime deps. |
| `libs/generic/release-profile` | `@papercusp/release-profile` | Generic composite release-profile evaluator: aggregates named components (a rubric verdict, a hard operational gate, or any other pass/fail/unknown check) into one GO/NO-GO verdict, enforcing staleness and lineage-match policy UNIFORMLY so no individual checker reimplements them. Zero I/O, zero domain coupling — the caller injects async check() functions; this module only combines the results and records exact evidence provenance. |
| `libs/generic/rerank` | `@papercusp/rerank` | Engine-agnostic cross-encoder reranking: a local ONNX cross-encoder (no key, no network) or the hosted ZeroEntropy zerank API. Shared across Papercusp and Restart. |
| `libs/generic/resource-profile` | `@papercusp/resource-profile` | Detect a host's effective compute resources ONCE at boot (cgroup-quota-aware cores via os.availableParallelism(), total/free RAM) and derive every scale cap with explicit floors + ceilings, so nothing is hardcoded for one machine. Pure: host signals are injected behind a configureResourceProfile() seam; zero domain coupling, zero runtime deps. |
| `libs/generic/result-encoding` | `@papercusp/result-encoding` | Generic token-efficient serialization for structured tool results: a lossless TOON encoder/decoder plus opt-in CSV/TSV/markdown-table encoders, and a static schema→capability-set eligibility analyzer (which formats a given JSON-Schema data shape can be safely rendered in). Domain-free; no host coupling. Wraps @toon-format/toon. |
| `libs/generic/resumable-download` | `@papercusp/resumable-download` | Generic, domain-free resumable HTTP downloader with streaming checksum verification (HTTP Range resume + incremental SHA-256), injected sink + fetch + hasher ports. Zero coupling: no fs, no fetch impl, no crypto lib baked in — pure algorithm over injected ports. |
| `libs/generic/rrf` | `@papercusp/rrf` | Reciprocal Rank Fusion — combine multiple ranked result lists into one. Pure, zero-dependency. Canonical use is fusing a BM25 ranking with a vector-similarity ranking, but it is domain-agnostic. |
| `libs/generic/rules` | `@papercusp/rules` | A generic, pure ECA (Event-Condition-Action) rules engine. Register rules { id, on, when, fire, args }; given an event, return the actions that should fire. Indexed by trigger, declarative data-matcher (MatchMap surface, evaluated via a mingo-backed leaf compiler) + JS predicate escape-hatch, Zod-validated serializable rules. No dispatch, no durability — the consumer fires what match() returns. |
| `libs/generic/scheduled-registry` | `@papercusp/scheduled-registry` | Generic managed-setInterval registry: wraps setInterval with a name, a category, and per-timer last-fire / last-error / armed tracking, a re-entrancy guard, an injectable shed-gate, and an injectable timer seam — then exposes listManaged() so EVERY interval is visible in one inventory. visibility != control: a registered timer keeps its own behavior (a watchdog stays out-of-band); registration only makes it listable. Pure registry over injected time + timers; zero domain coupling. Its one dependency is @papercusp/module-singleton (itself domain-free and dependency-free), which pins this registry's state to the realm so a duplicated module record cannot split the inventory in half. Consumed by papercusp (host health sweeps + the ephemeral blueprint cadence tier) and any host that wants total timer visibility. |
| `libs/generic/search` | `@papercusp/search` | Host-agnostic lexical + pgvector hybrid search over Postgres. The host registers pluggable SearchSources (each owning its tsvector/pgvector SQL); the engine runs lexical-only or lexical+embeddings fused via Reciprocal Rank Fusion. The lexical ranker is Postgres ts_rank_cd (cover density), NOT Okapi BM25. PG handle + query embedder are injected — zero schema coupling, zero embedding-provider dependency. |
| `libs/generic/search-core` | `@papercusp/search-core` | Engine-agnostic search-relevance core: instruction-following rerank steering, live LLM category-match, brand-aware query rewrite, tiered escalation, and the shared eval-harness metric contract. Builds on @papercusp/rerank; no project (Typesense/PG/catalog-schema) deps. Shared across Papercusp and Restart. |
| `libs/generic/seed-bundle` | `@papercusp/seed-bundle` | Generic seed-bundle primitive: a manifest + provider registry + restore orchestration for shipping a CHECKPOINT of a replicated store (git, hypercore, …) that a host restores BEFORE the store's own catch-up protocol runs — pre-positioning bytes so the unmodified live sync transfers only the delta. Pure data + orchestration over injected SeedProviders; zero domain coupling, zero runtime deps. The host supplies the providers, the payload resolver, and the restore context. |
| `libs/generic/sequence-patterns` | `@papercusp/sequence-patterns` | Find the ORDERED action sequences that recur across independent actors in a timestamped event stream. Segments each actor's stream on an idle gap so adjacency means something, gates on distinct-cohort breadth (a shared pattern, not one actor's habit), and ranks by LIFT rather than frequency — which structurally demotes the ambient heartbeat/telemetry sequences that outrank real patterns in every instrumented system, with no denylist to maintain. Suppresses sub-patterns already explained by a longer extension. Zero I/O, zero domain coupling, zero dependencies. |
| `libs/generic/sse` | `@papercusp/sse` | Spec-compliant Server-Sent Events primitives — server response builder, in-process channel bus, PG NOTIFY bridge, resilient EventSource client, React hook. |
| `libs/generic/step-program` | `@papercusp/step-program` | A generic, pure declarative step-program interpreter. A program is an ordered list of steps (each invokes a named op with {{ path }}-interpolated args, an optional `when` guard, and a result `bind`) followed by a conditional `gate`. The interpreter (planStep / selectGateBranch) decides WHAT op to run; the runner (runProgram) drives it, delegating every op to an injected `runOp` seam (the op registry / durability boundary). Also ships a safe no-eval boolean/comparison expression evaluator, type-preserving `{{ path }}` interpolation, and a structured-block poll reducer (confidence-weighted votes + an advocate veto). Zero I/O, zero domain coupling — the consumer injects the ops. |
| `libs/generic/structured-concurrency` | `@papercusp/structured-concurrency` | Generic distributed-systems concurrency toolkit over injected store ports: a structured-concurrency nursery (transitive cancel + completion gate), an OTP supervision tree (restart strategies + restart-intensity governor), a layered backpressure governor (token bucket + circuit breaker + credits), sagas + tombstones for compensable destructive ops, and a total lock-class order for deadlock avoidance. Pure algorithms; the host injects the durable store (PG, in-memory, …) and the resource-release / notify / escalate effects. Zero domain coupling, zero runtime deps. |
| `libs/generic/sync` | `@papercusp/sync` | Schema-agnostic SSE sync with polling fallback, reconnect, and backpressure handling. |
| `libs/generic/tauri-release-kit` | `@papercusp/tauri-release-kit` | Provider-agnostic Tauri desktop build+release orchestration: a pure core (version bump, channel/tag resolution, latest.json updater-manifest generation, artifact classification) plus a per-target driver registry (Linux-local, Mac/Windows over an SSH frame) selected by an open target discriminator, with the app-specific sidecar build injected via a buildSidecar() seam and all side effects behind Exec/Fs/Log ports. Zero domain coupling, zero runtime deps; the host wires real ports + an app release.config. |
| `libs/generic/tauri-verify` | `@papercusp/tauri-verify` | Stable Tauri verification surface: app-ready, route, and scope assertions with semantic screen identifiers. Built on tauri-agent-tools bridge for headless UI testing. |
| `libs/generic/template-kit` | `@papercusp/template-kit` | Pure schema + validation kit for the templates system (agent-composed apps): the component-manifest format ({id, version, tier, kind, provides, composesWith, source, tests, summary}) with a zero-dep structural validator, and the curated component catalog (the machine-readable source of truth the human docs catalog projects from). Plus the template.yaml manifest schema, multi-template composition semantics (union-of-checks), and the reference template manifests pinned to the repo templates/ dir by test (plan app-templates-2026-07-04 P-005/P-014/P-006). Zero I/O, zero runtime deps, zero domain coupling — validation is pure data-in/data-out; YAML parsing stays in the consumer (yaml is a test-only devDep). |
| `libs/generic/token-kit` | `@papercusp/token-kit` | Generic DTCG → multi-format tooling for Style Dictionary: OKLCH/hex/rgba colour transforms, a Tailwind v4 @theme emitter, a typed-TS emitter, and source preflight guards. Brand-value-free; shared across projects. |
| `libs/generic/tooldef` | `@papercusp/tooldef` | Function-as-truth tool framework: write one typed (input, ctx) => result function and project it onto HTTP, MCP, IPC, and in-process transports with uniform auth/role/quota/telemetry/streaming. Schema-agnostic (Standard Schema), host-agnostic (all I/O injected). |
| `libs/generic/tooldef-http` | `@papercusp/tooldef-http` | HTTP transport adapter for @papercusp/tooldef — resolve an inbound request to a projected tool, build the context from headers/query (host-injected principal + harness-path resolution), and dispatch. Framework-neutral; Next.js/Hono/Express are thin shims on top. |
| `libs/generic/ui-primitives` | `@papercusp/ui-primitives` | Shared headless React UI primitives — ANSI/terminal output, markdown (GFM), JSON tree viewer, and virtualized lists — used across Papercusp surfaces. Brand-value-free; styling is injected by consumers. |
| `libs/generic/verification-harness` | `@papercusp/verification-harness` | Verification-harness contract + shared runner for expensive harnesses (drills, release cuts, headless UI runs, LLM batteries): declared phases with dependencies and a fast preflight, structured per-phase results {phase, step, reasonCode, evidenceDir}, one retained evidence dir per run, --only/--from re-runs that reuse passed setup from a prior run, and never-abort continuation past failures later phases do not depend on. bin/vh.sh gives shell harnesses the same contract. |
| `libs/holepunch-spike` | `@papercup/holepunch-spike` | Phase 0 spike for papercusp-dogfood-v5: verify Holepunch P2P primitives bundle + work on the target runtime. Throwaway package — delete if spike fails and fall back to git-as-sync per the named fallback. |
| `libs/host-platform` | `@papercusp/host-platform` | Host-boundary interface — fs / paths / database URL resolution behind one swappable adapter. Desktop impl + server stub. |
| `libs/papercusp` | `papercusp` | Papercusp — open standard for autonomous-harness frameworks |
| `libs/papercusp-db` | `@papercusp/papercusp-db` |  |
| `libs/papercusp-publish-auth` | `@papercusp/publish-auth` |  |
| `libs/papercusp-shared` | `@papercusp/papercusp-shared` |  |
| `libs/test-config` | `@papercusp/test-config` | Shared Vitest config + testcontainers (PG/Redis/Typesense) + generic createFreshTestDb isolation + MSW + schema-driven fixtures + in-process Hono client; NestJS boot helper via the ./nest subpath. |
| `libs/testing-shell` | `@papercusp/testing-shell` | Shared testing-domains registry + UI shell. Consumed by /admin/testing (operator-vite) and the harness Tests tab (operator). Registry is pure data; the panel/shell take an injected dataSource so the same component drives both the admin and harness API surfaces. |
| `packages/agent-mcp` | `@papercusp/agent-mcp` | MCP server exposing workspace-knowledge tools to in-app concierges (Operator, Oracle) and out-of-process pi sessions. |
| `packages/backup` | `@papercusp/backup` | Per-workspace kopia backup system: snapshot/restore/verify/maintenance over the kopia CLI, SQL-backed snapshot+settings+destination metadata, pre-snapshot DB-dump hook, interval+event scheduling, and orphan sweep. Host-agnostic — the org PG handle, workspaces-root path, schema bootstrap, and embedded-pg admin URL are injected via configureBackup(). Zero @papercusp/@restart runtime deps. |
| `packages/coordination` | `@papercusp/coordination` | The Papercusp Postgres tie-in adapter over the generic pub/sub substrate (@papercusp/pubsub-substrate) + typed-entity graph (@papercusp/linkable-edges). The host-agnostic algorithm cores moved to those borrowable libs; this package keeps only the papercusp-bound PG backends (PgCoordLog → harness_shared.coord_event_log, PgPresenceStore, PgWatermarkStore, and the Pg capability stores → coord_topics/entity_subscriptions/threads/links) and re-exports the generic seams + conformance suites so the @papercusp/coordination public surface is unchanged. Identity resolution stays host-side by design. |
| `packages/docs-engine` | `@papercusp/docs-engine` | Source-agnostic docs retrieval engine. Outline + get + search + MDX-to-markdown pipeline, operating on a pluggable DocSource adapter. |
| `packages/omp-plugin` | `@papercusp/omp` | Launch an OMP agent session pre-seeded with the Papercusp engineer-collaborator playbook, scoped to one workspace. |
| `packages/operator-core` | `@papercusp/operator-core` | Headless operator backend — agent-tools, endpoint-route handlers, harness logic, host composition. Zero UI/React dependency; consumed by apps/operator (the UI package) and the desktop sidecar. Carved from apps/operator in SP1 C4 (plan operator-core-headless-serve-2026-06-04). Resolution is via the consumer's tsconfig path / vite alias (source-only, no build); internal imports are relative. |
| `packages/operator-ui` | `@papercusp/operator-ui` | Operator SURFACES as importable React components — the panels that used to live only inside the operator SPA, moved here so a second app (the cloud portal) can mount them natively instead of framing them in an iframe. Host-specific concerns (router Link, toast, API reachability) are injected through configureOperatorUi(); everything else is the operator's own component, unchanged. Each panel ships its own CSS string so a host needs no build-time stylesheet wiring. |
| `packages/plugin-loader` | `@papercusp/plugin-loader` |  |
| `packages/plugin-sdk` | `@papercusp/plugin-sdk` |  |
| `packages/plugin-wit` | `@papercusp/plugin-wit` | Canonical WIT (WebAssembly Interface Type) definitions for the Papercusp plugin protocol. Shared between the JS host (jco-transpiled) and the Rust runtime (wasmtime + bindgen!). Bump versions by adding a new wit/<version>/ directory; never edit a published version in place. |
| `packages/tooldef-mcp` | `@papercusp/tooldef-mcp` | MCP transport bridge primitives for @papercusp/tooldef — the host-agnostic glue between an MCP server (Vercel mcp-handler or any SDK) and the tooldef dispatcher: RequestHandlerExtra extractors + a projected-dispatch→MCP-result mapper. The auth/spawn-context assembly is inherently host-specific and stays in the host (see README). |
