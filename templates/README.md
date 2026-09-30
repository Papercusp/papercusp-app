# Templates

Distributable units an agent composes into an app (or an app-aspect) on
papercusp: **components** (version-pinned refs into the
[component catalog](../libs/generic/template-kit/src/catalog.ts)) +
**guidance** (`GUIDE.md`, the composition prompt) + **checks** (the acceptance
suite any composition must pass). Correctness by **verification, not
construction** — the design of record is
`apps/operator-docs … agent-insights/templates-system-design`
(served at `/internal/docs/agent-insights/templates-system-design`).

## Source of truth (v1 — plan app-templates-2026-07-04 P-006/D-005)

- **This directory is the v1 template source of truth**: versioned with the
  repo, git-synced, readable by the anti-rot gym (P-009). The Cupboard/Comb
  Templates section (P-010) _projects_ from here.
- **Manifests are pinned by test**: `@papercusp/template-kit`
  `src/reference-templates.ts` is the machine form; the kit's suite asserts
  each `templates/<id>/template.yaml` here parses, validates, and matches it.
  Edit BOTH sides (yaml + reference manifest) — a mismatch fails the kit's
  tests loudly.
- Schema: `agent-insights/templates-template-yaml`
  (validator: `@papercusp/template-kit` `parseTemplateManifest`).

## The set (official desktop, web, and mobile roots)

| Template                                                          | Scope  | Category | What                                                                                                                                                                              |
| ----------------------------------------------------------------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`papercusp-app`](papercusp-app/)                                 | app    | app      | THE whole-app root for desktop and web. Hard-requires the data-layer + ui closure; a `target` decision point selects the chassis (`desktop`, `web`, or both) and an `agents` one adds the judgment plane. Start here.                        |
| [`papercusp-android-app`](papercusp-android-app/)                 | app    | app      | a WHOLE Android app — a thin root that hard-requires the shared mobile base + Android shell at exact `0.1.0` pins                                                                 |
| [`papercusp-iphone-app`](papercusp-iphone-app/)                   | app    | app      | a WHOLE iPhone app — a thin root that hard-requires the shared mobile base + iPhone shell at exact `0.1.0` pins                                                                   |
| [`papercusp-ops-pots`](papercusp-ops-pots/)                       | aspect | agentic  | app-owned plan → canonical work-item DAG → stable-agent assignment/wake + the ONE typed app seam                                                                                   |
| [`papercusp-tauri-desktop-shell`](papercusp-tauri-desktop-shell/) | aspect | shell    | the deterministic chassis: Tauri shell → Node/Hono sidecar → embedded Postgres + release kit                                                                                      |
| [`papercusp-web-host`](papercusp-web-host/)                       | aspect | shell    | the web chassis: Next.js standalone host (tracing root + workspace transpile), operator.json discovery, auth seam, Dockerfile builder (P-029)                                     |
| [`papercusp-mobile-base`](papercusp-mobile-base/)                 | aspect | shell    | the cross-platform Rust/UniFFI, design-token, configuration, source-hygiene, and portable-verification contract shared by both mobile roots                                       |
| [`papercusp-android-shell`](papercusp-android-shell/)             | aspect | shell    | the Compose/Gradle/cargo-ndk Android chassis, native acceptance, security, packaging, and release contract                                                                        |
| [`papercusp-iphone-shell`](papercusp-iphone-shell/)               | aspect | shell    | the SwiftUI/XcodeGen/XCFramework iPhone chassis, native acceptance, privacy, signing, and archive/export contract                                                                 |
| [`papercusp-data-layer`](papercusp-data-layer/)                   | aspect | data     | app-owned embedded Postgres + connection discovery + typed-contract write gates                                                                                                   |
| [`papercusp-data-sync`](papercusp-data-sync/)                     | aspect | data     | live UI state sync: client transports + SSE server + event-maintained projections                                                                                                 |
| [`papercusp-search`](papercusp-search/)                           | aspect | search   | search over app data: sources + hybrid retrieval + rerank + RRF fusion                                                                                                            |
| [`papercusp-ui`](papercusp-ui/)                                   | aspect | ui       | the operator-style SPA kit: headless primitives, papergrid, dock-workbench, lexicon                                                                                               |
| [`papercusp-release-pipeline`](papercusp-release-pipeline/)       | aspect | release  | tauri-release-kit as an aspect: channels, signing, updater feed, target matrix (P-023)                                                                                            |

An app built from N templates must pass the **union of their checks**
(`composeTemplates` — see the schema doc §Composition semantics). An app-scope
template may `require` another app-scope template as its BASE; every
composition has exactly ONE ROOT app (the one no other app requires).

The three official whole-app roots are `papercusp-app`, `papercusp-android-app`,
and `papercusp-iphone-app`. Start from exactly one of them; aspect templates are
pulled through its pinned closure or selected deliberately where the GUIDE
allows composition.

`papercusp-app` replaced four earlier roots — `papercusp-desktop-app`,
`papercusp-webapp`, `papercusp-agentic-desktop-app`, `papercusp-agentic-webapp`
— which were named compositions of the same aspects, not different apps
(plan `unified-app-template-2026-08-23`). What they encoded as a choice of
TEMPLATE is now a choice of ANSWER: `target` picks the chassis and `agents`
picks whether a judgment plane joins. The retired refs still resolve — they are
listed as `aliases` in `papercusp-app/listing.json`, so existing cupboard
listings and in-flight materializes keep working.

## Running the checks (landed: P-007)

The `<id>/checks/*.test.ts` files are PORTABLE template content — copied
verbatim into a composed app and parameterized via a JSON config named by the
**`TEMPLATE_CHECKS_CONFIG`** env var (schema: `@papercusp/template-kit`
`TemplateChecksConfig`). Unconfigured they SKIP. This directory is also the
`@papercusp/templates` workspace member, so in-repo:

```sh
npm test -w @papercusp/templates                 # composition-integrity green, rest skip
TEMPLATE_CHECKS_CONFIG=<config> npm test -w @papercusp/templates   # the full union
```

Worked example config:
[`papercusp-app/reference/worked-example.checks-config.json`](papercusp-app/reference/worked-example.checks-config.json).
Per-check contracts: each template's `checks/README.md`.

## The template gym (mobile closure: P-017)

Anti-rot cadence (D-007: _the template is tested by building an app from it_):
the `template-gym` system routine (`system:template-gym`, every 6h) re-verifies
seven mobile-closure legs: the canonical five-template manifest set is
byte-identical in both consumer repositories; both platform roots expose their
full composed check union; Papercusp and SideStage exercise distinct optional
capability sets on each platform; and four real-consumer legs run the portable
static conformance checks for Papercusp Android/iPhone and SideStage
Android/iPhone. A standing RED auto-files ONE `template-drift` work-item (stable
watchdogKey `template-gym:<leg>`); the gym is advisory and never gates.

Code: `packages/operator-core/lib/harness/routines/template-gym-{runner,action}.ts`.
On-demand run + per-leg re-run:

```sh
npx tsx packages/operator-core/lib/harness/routines/template-gym-runner.ts \
  [--legs mobile-manifests,mobile-check-union,mobile-capability-diversity,papercusp-android,papercusp-iphone,sidestage-android,sidestage-iphone] \
  [--papercusp-mobile-root <clone>] [--sidestage-mobile-root <clone>] \
  [--summary-json <path>]
```

Run history: `~/.papercusp/template-gym/` (`last-run.json` + `runs.jsonl`).

## Cupboard distribution (landed: P-010)

Each template here is publishable as a **`kind=template` Cupboard listing**
(repo-backed: the listing points at this dir via `listing_ref = <id>`; nothing
is flattened or copied at publish time). The loop:

- **Publish**: the `template:publish` agent tool (title ≤200 / description
  ≤280 — worker caps). D-007 review policy: a template carries GUIDE.md — an
  instruction-carrying artifact — so listings land **pending** and are publicly
  invisible until operator approval. The official set uses
  **"Papercusp Official:"** title prefixes.
- **Public mirror (REQUIRED)**: the worker rejects listings on private repos
  (`private_repo_rejected` — a listing users can't clone is broken), and this
  monorepo is private. Official listings therefore publish from the PUBLIC
  mirror **[Papercusp/templates](https://github.com/Papercusp/templates)** —
  a copy of these `<id>/` dirs (this tree stays canonical; push changed dirs
  to the mirror before re-publishing). Mirror-sync automation is a tracked
  follow-up (P-027).

## Supply chain — building OUTSIDE papercup (v1, WI-2860..2863 + WI-2891)

A builder cloning only the public mirror gets everything it needs to compose
an app and run the checks union — the round-1 greenfield build proved the
template DESIGN holds but surfaced four distribution gaps; this is the
official v1 mechanism that closes them:

- **`@papercusp/template-kit`** is VENDORED in the mirror as `template-kit/`
  (source-shippable: zero runtime deps, `main: ./src/index.ts`). Consume it
  with a `file:` dependency — the mirror's root `package.json` already wires
  `"@papercusp/template-kit": "file:./template-kit"`, so
  `composition-integrity` runs after a plain `npm install`. The kit is NOT
  on npm; this monorepo (`libs/generic/template-kit/`) stays canonical and
  the vendored copy rides the mirror sync (below).
- **`@papercusp/pot-app-seam`** — the papercusp-ops-pots Tier-B MUST
  component — is vendored the same way as `pot-app-seam/` (WI-2891: the
  round-3 build proved the catalog's source repo is not reachable from
  outside papercusp, so the seam MUST ride the mirror). Zero runtime deps,
  `main: ./src/index.ts`; the mirror root `package.json` wires
  `"@papercusp/pot-app-seam": "file:./pot-app-seam"`.
  Canonical: `libs/generic/pot-app-seam` in the monorepo.
  ⚠ An app repo should link it from the **install-resolved `libs/generic`
  root** (`templates:get-guide` / `templates:new-app` return it as
  `supplyChain`), NOT from a mirror clone: the mirror is currently pre-rename
  and 404s on `pot-app-seam/`, still serving `hive-app-seam/` (measured
  2026-08-10, WI-37775). `npm run mirror:check` tells you whether that is
  still true.
- **Mirror sync has a drift CHECK you must run by hand — it is not automatic.**
  `scripts/templates-mirror-sync.mjs` diffs this canonical tree against a local
  clone of the mirror and exits non-zero on ANY drift:

  ```bash
  git clone https://github.com/Papercusp/templates.git /tmp/pc-templates-mirror
  PC_TEMPLATES_MIRROR=/tmp/pc-templates-mirror npm run mirror:check   # exit 1 on drift
  PC_TEMPLATES_MIRROR=/tmp/pc-templates-mirror npm run mirror:push    # apply + commit + push
  ```

  It compares every template dir, this README, and the vendored packages
  (`template-kit/`, `pot-app-seam/` — `src/**` minus `*.test.ts`, plus
  `package.json`/`tsconfig.json`), and leaves the mirror's own root plumbing
  (`package.json`, lockfile, each vendored `README.md`) alone. Exit codes:
  `0` in sync · `1` drift · `2` usage/env error.

  ⚠ **Read this bullet's history before trusting any claim in it.** It used to
  assert that this same check ran as a gate and that publish tooling "refuses
  to publish official listings while red". That was false for five weeks: the
  script had been written but was auto-committed in a side clone that was never
  pushed, so nothing in this repo ran it or could even see it, and the mirror
  duly went stale AND pre-rename (WI-37775). The script is now restored here
  and covered by
  `packages/operator-core/lib/templates-mirror-sync-cli.test.ts`.

  **What still does NOT exist — do not assume otherwise:** no CI job, no
  green-checkpoint gate and no publish tooling runs `mirror:check`. Nothing
  stops a stale mirror from being published. Syncing remains a MANUAL step you
  perform after changing any template dir, this README, or a vendored package —
  the check just means you can now verify it in one command instead of by eye.
  Assume the mirror trails the canonical tree unless you just ran the check.

  **Measured 2026-08-10:** the live mirror is at 132 drift items (76 missing,
  26 changed, 30 extraneous) — including `missing pot-app-seam/package.json`
  and `extraneous papercusp-ops-hives/…`, i.e. it still serves the pre-rename
  `hive-app-seam`/`papercusp-ops-hives` layout. Until someone runs
  `mirror:push`, a `file:`-link into a mirror clone will NOT resolve
  `@papercusp/pot-app-seam`.

- **Other component packages** (`@papercusp/sync`, `@papercusp/ui-primitives`,
  …) are not published to npm either and are NOT vendored (they have runtime
  deps or platform coupling the mirror can't carry). The official v1
  mechanism: `file:`-link them from a **local papercusp install**
  (`<install>/libs/generic/<pkg>`).

  ⚠ **Do NOT copy a relative example path into an app.** This bullet used to
  read `"@papercusp/sync": "file:../papercusp/libs/generic/sync"`, which only
  works inside a dev checkout that happens to have a sibling `papercusp/` repo.
  On a real install there is no such sibling, so that dependency resolves to
  nothing and `npm install` fails on a package that also 404s on npm (all of
  these are `private: true`). **The path is per-install and the product now
  reports it**: `templates:get-guide` and `templates:new-app` both return a
  `supplyChain` block carrying this install's resolved `libs/generic` root and
  an absolute `file:` spec to use, and `templates:new-app` also injects it into
  the builder's kickoff. Read that instead of hardcoding a path
  (`packages/operator-core/lib/cupboard/generic-libs-root.ts`).

  `supplyChain.root: null` is a REAL answer, not an error: this install has no
  source tree, so these packages cannot be linked at all — build with what the
  template vendors, or install a build that ships `source.tar.zst`. Known
  no-tree configurations: the **macOS GUI app** (the archive is deliberately
  stashed out for the `gui` role to keep the DMG small — the **macOS Server
  app does** ship it) and **cross-built macOS** bundles (Linux-native
  `node_modules` are the wrong architecture, so staging is off by default with
  an opt-in darwin cross-install). Linux and Windows ship it by default.
  See WI-37790.

- **Runnable checks harness**: the mirror root carries `package.json` +
  `vitest.config.ts`, so `npm install && npm test` runs every
  `<id>/checks/*.test.ts` — `composition-integrity` green against the
  mirror's template set, the app-parameterized checks SKIP until your app
  sets `TEMPLATE_CHECKS_CONFIG`.
- **Worked exemplars are papercusp-internal** — the templates cite proven
  shapes, not repos to clone. The PORTABLE truth every builder can rely on
  is each template's `GUIDE.md` + `checks/` + the checked-in worked configs
  (e.g. `papercusp-app/reference/worked-example.checks-config.json`).

## Cupboard install

- **Install**: the Cupboard **Templates** tab (`?kind=template`) →
  `POST /api/cupboard/install-template` → shallow-clone + kit validation
  (schema + component-catalog pin check — a stale pin fails the install, same
  rule as the gym) → materialized under **`~/.papercusp/templates/<id>/`**,
  where the from-template scaffold entry (P-011) reads it.
- Worker side: D1 migration `010_template_kind.sql`;
  operator side: `operator-core/lib/cupboard/install-template-core.ts`.
