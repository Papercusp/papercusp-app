# Plugin + marketplace pipeline — state as of 2026-05-11
URL: /internal/docs/implementation/plugin-marketplace-state-2026-05-11

One-page reference for the TS plugin/template/snapshot/marketplace system as it stands today. Where the code is, what's covered by tests, what's deferred, and where to look first.

import { Aside } from '@astrojs/starlight/components';

Snapshot of the system as `tsplugin` agent left it (2026-05-11). For the
roadmap of new runtimes built on top of this (WASM, daemon, iframe),
see `papercup-native/docs/ts-plugin-system-v1-plan.md` — owned by
`@plugin` agent (Rust runtime).

Preserved as the 2026-05-11 milestone. Reading it today, note:

* The operator is now **`apps/operator/`** and its `app/api/**` routes were
  ported to **Hono routers under `packages/operator-core/lib/endpoint-route/routes/**`**;
  `apps/operator/lib/*` (e.g. `plugin-host-runtime.ts`, `plugin-grants.ts`)
  now lives under **`packages/operator-core/lib/`**. The Next route paths in
  the tables below are stale.
* Migrations **`051`** and **`052`** were folded into **`000-baseline.sql`** and
  archived (`libs/papercusp/libs/db/sql/archive/`); they are no longer live
  numbered migrations. `harness_shared.plugin_capability_grants` is defined in
  the baseline.
* The `localhost:3057` / `papercuspai.com` marketplace-api was superseded by
  the in-app **Cupboard** (`apps/operator-public`, CF Workers + Hono + D1).
* The "use git worktrees for non-main work" hard rule is **reversed** under
  the current model: the shared tree stays on `staging` and you do **not**
  branch/worktree — concurrency is serialized by the `locks:*` + `coord:*`
  systems. See the repo `CLAUDE.md` "Branch discipline" section.

## TL;DR

Three publishable kinds (`plugin`, `template`, `snapshot`) share one marketplace pipeline. Operator at `localhost:3055` serves the install/discover surface; marketplace-api at `localhost:3057` is the registry. Plugins run in-process under a two-tier capability check (manifest ∩ user-granted). Tests cover every helper and DB-backed function shipped in this session.

*As of today:* the `snapshot` publishable kind was **retired** (see the snapshot note below); the `:3057`/`papercuspai.com` registry was superseded by the in-app **Cupboard**; plugins also load as **WASM** or **daemon** runtimes, not only in-process JS.

## Source layout

| What                                                                                           | Where                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin SDK (types, capability strings, manifest schema)                                        | `packages/plugin-sdk/`                                                                                                                 |
| Plugin loader (manifest validate, capability check, reaction rules, action registry, audit)    | `packages/plugin-loader/`                                                                                                              |
| Plugin host runtime in operator                                                                | `apps/operator/lib/plugin-host-runtime.ts`                                                                                             |
| Per-(plugin, harness) grants                                                                   | `apps/operator/lib/plugin-grants.ts` + `harness_shared.plugin_capability_grants` in `000-baseline.sql`                                 |
| Audit log (PG writer)                                                                          | `apps/operator/lib/plugin-audit-writer.ts`                                                                                             |
| Marketplace API routes                                                                         | `apps/operator/app/api/{marketplace,plugins,templates,snapshots,harness/[slug]/save-as-template}/`                                     |
| Marketplace UI components                                                                      | `libs/marketplace-public-ui/src/` (shared with public site)                                                                            |
| Operator-side marketplace pages                                                                | `apps/operator/app/marketplace/{,templates,plugins,snapshots}/`                                                                        |
| Operator-side installed pages                                                                  | `apps/operator/app/installed/{harnesses,plugins,snapshots,templates}/`                                                                 |
| Marketplace registry server                                                                    | `../papercusp-registry/apps/marketplace-api/` (separate repo `papercupai/papercusp-registry`)                                          |
| CLI (`papercusp install`, `plugin enable/disable/lint/init/doctor`, `snapshot {fork,publish}`) | `libs/papercusp/packages/cli/src/`                                                                                                     |
| Snapshot capture / restore                                                                     | `libs/papercusp-export-state/src/` — **RETIRED**, moved to `_retired/snapshot-system/papercusp-export-state` (see snapshot note below) |

## What runs end-to-end today

### Plugin lifecycle

1. **Install** — *(superseded)* The original `POST /api/marketplace/install-plugin` path that shelled out to `papercusp install <slug>@<version>` (atomic staging-dir tarball download/extract/validate) is **dead**. Install now goes through **`POST /api/cupboard/install-plugin`** (revive-cupboard-distribution D-003/P2), which **git-clones** the Cupboard listing's GitHub repo (resolved from `listingId`, or a direct `githubUrl`) and runs the capability-gate + install-consent path. The route header itself describes the old `:3057`/CLI tarball install as dead.
2. **Enable** — `POST /api/plugins/enable { slug, harnesses[], disable? }` adds to `enabled-plugins.json` for each harness and writes the boot-time silent grant backfill. `enabled-plugins.json` stays the on-disk source of truth (the CLI is its only writer), but it is now **mirrored into `harness_shared.plugin_enables`** (`plugin-enables-pg.ts`) so read paths use one cross-harness PG query instead of fanning over the filesystem; an FS watcher (`harness-fs-watcher.ts`) re-mirrors on direct CLI/file edits.
3. **Consent** — `/installed/plugins/<slug>/permissions` renders a harnesses × capabilities grid; toggling `POST /api/plugins/grants { plugin, version, harness, capabilities, action }` mutates `harness_shared.plugin_capability_grants`. Two-tier check: every `hasCapability(ctx, cap)` ANDs manifest with the granted set.
4. **Run** — The typed `PluginHooks` shape is now a **frozen back-compat surface** (plugin-system-pot-port D-003); the host fires it by direct iteration. Members: `onLoad`, `onUnload`, `onHarnessCreated`, `beforeMissionStart`, `afterDone`, `onFeaturePassed`, `onProposalAccepted`, `onPostOrchestrator`, `onPostWorker`, `onPostValidator`, `contributeOperatorSuggestions`, `getStateForReload`, `restoreFromReload`. The WordPress-style **HookBus** (`addAction`/`addFilter`, plus topic strings like `mission.start` / `task.passed` / `feature.completed` / `proposal.accepted`) was **retired and deleted** from loader/SDK/host (P-006/D-003) — those topics no longer exist as fire targets. The live extension surface is capability-scoped **event-reaction rules** (see the extension axes below).
5. **Action invocation** — `POST /api/plugins/[...path]` proxies through `ctx.actions.register(...)`'d handlers. Every invocation produces an audit row via `PgAuditWriter` (fail-closed — action fails if audit write fails).
6. **Update** — `GET /api/plugins/updates` diffs installed vs catalog; `/installed/plugins` shows "Update → vX.Y.Z" with new-cap re-consent prompt before bumping.
7. **Uninstall** — `POST /api/plugins/uninstall { slug }` removes the global plugin dir + disables from every harness it was enabled in.

### Plugin runtime model + extension axes

*(Added post-snapshot — the runtime surface grew well beyond the action registry described above.)*

Each plugin instance gets a per-(plugin, harness) `ctx` carrying:

* `ctx.actions` — the action registry (`register(...)`'d handlers behind `/api/plugins/[...path]`).
* `ctx.spawn` — capability-gated `compute:exec` with a frozen PATH (`makePluginSpawn`).
* `ctx.kv` — plugin-private, quota'd K/V backed by `harness_shared.plugin_kv` (quota from `manifest.kvQuota`; left `undefined` in test/no-PG contexts, so plugins must tolerate absence).
* `ctx.oauth.token(field)` — acquires a fresh access token, resolving the backing provider from the plugin's manifest `oauth[]` entries.
* `ctx.recordResource(...)` — writes a record to the provision WAL (for in-process plugins that create external resources from a hook handler rather than a setup script).

The **primary** extension surface is no longer the typed lifecycle hooks — it is two manifest-declared axes the host wires at load:

* **Tool axis** (main consumer): `manifest.tools[]` entries are projected as agent tools `<plugin>.<verb>` over both HTTP and MCP (`registerPluginTools`).
* **Event-reaction axis**: `manifest.reactions[]` rules — when a trigger `on` settles, the rule fires one of the plugin's **own** tools through normal capability-scoped dispatch. Each `on` trigger requires an `events:listen:<on>` capability (`registerPluginReactionRules`). Plugin-emitted events (the WASM event sink, `plugins:fire_event`) feed the same reaction registry as synthetic events.

The **RoutineDefinition** and **RoleDefinition** manifest axes were **retired** in the pot port (`collectRoutines`/`collectRoles` deleted, zero callers). The manifest `roles` field stays schema-tolerated as inert data (so existing plugins that declare it still load); routines authors are pointed at blueprint triggers / event-reaction schedules.

### Template lifecycle

1. **Save** — "Save template" button on harness dashboard → `POST /api/harness/<slug>/save-as-template { slug, version, description?, author? }` forks the recipe (SPEC.md, AGENTS.md, `.papercusp/config.json`, `.papercusp/validation-contract.md` + plugin recommendations from `enabled-plugins.json`) into `~/.papercusp/templates/<slug>/<version>/`.
2. **Publish** — `POST /api/templates/<slug>/<version>/publish` tars + signs + uploads to marketplace-api.
3. **Install** — `POST /api/marketplace/install { slug, projectName, targetPath? }` scaffolds a new project. **Slug-collision recovery (PR #5)**: returns `{ code: 'project_name_taken', suggestedName: '<base>-2' }` on conflict; UI auto-offers via `confirm()`. Partial-init cleanup wipes half-scaffolded dirs on `papercusp init` failure.

### Snapshot lifecycle

The publishable-snapshot / snapshot-**export** pipeline below was **retired**
(retire-snapshots-instance-spec-2026-06-09, shipped). `libs/papercusp-export-state`
moved to `_retired/snapshot-system/papercusp-export-state`; `@papercusp/export-state`,
the `snapshots:*` tools, all `/api/snapshots/*` publish routes, and the Cupboard
`kind=snapshot` were retired (migration 199 drops `snapshot_index`). The fork route
`instantiate.ts` — the **only** non-test caller of `copyGrantsToNewHarness` — now lives
under `_retired/`. The reproducible replacement is the **InstanceSpec** system
(`packages/operator-core/lib/instance-spec/`).

The surviving `/api/harness/:slug/snapshots` route is a **different** feature —
per-harness iteration snapshots (FS rollback of `.papercusp/snapshots/<ts>-iter-<n>/`),
not publishable snapshots.

*Historical (pre-retirement) flow:*

1. **Capture** — `POST /api/snapshots/create` writes a tarball under `<harness>/.papercusp/snapshots/`.
2. **Publish** — `POST /api/snapshots/<id>/publish` uploads to marketplace.
3. **Fork** — `POST /api/snapshots/<id>/instantiate` (or `papercusp snapshot fork`) creates a new harness with schema rename. **Grants carry over (PR #2)**: `copyGrantsToNewHarness` copies every `(plugin, version, capability)` grant on the source harness to the new fork via `INSERT … SELECT … ON CONFLICT DO NOTHING`.
4. **Republish** — *pending*. PR-B paused per `@plugin`'s reply on coord, awaiting v1 plan greenlight (Batch G+1 bumps `SNAPSHOT_SCHEMA_VERSION` to 2).

## Hard rules in this code (don't break)

* **No TS deletion** anywhere in `apps/operator/` or `libs/papercusp/`. Set by `shared.jsonl` 2026-05-10T05:50.
* **Rust port is opt-in** via `?backend=rust`; default routes always go to TS.
* **Paperclip stomps** `apps/operator/app/harness/*` periodically. `pgrep -af paperclip` before editing harness UI; race-and-recommit if it stomps you.
* **Schema ownership**: `packages/plugin-sdk/papercusp-plugin.schema.json` is `@plugin`'s territory going forward (per their handoff on coord 2026-05-11T15:30). Transitional additions get a `kind: contract` post first.
* **Use git worktrees** for any non-main feature work — never branch-switch the canonical `papercup/` checkout while other agents may be writing.

## Test coverage

Plugin-loader tests (vitest, `packages/plugin-loader/`):

* 91 cases covering manifest validation, capability matching (incl. two-tier), action registry, semver, audit, api-factory, tools. *(Snapshot-era count; the suite has since grown and the HookBus tests were removed with the HookBus — new specs include the daemon/WASM runtimes, reaction rules, and `plugin doctor`.)*

Operator unit tests (vitest, `apps/operator/`):

* 67 cases on pure helpers from PRs #2-#5: `isNewerVersion`, `computeCapChange`, `suggestNextFreeName`, `SLUG_RE`, `SEMVER_RE`, `explainCapability`, `tierBadgeColor`.

Operator integration tests (vitest + testcontainers PG, `apps/operator/test/`):

* 25 cases covering every public function in `lib/plugin-grants.ts`: `copyGrantsToNewHarness` (8), `grantCapabilities/revokeCapabilities/getGrantsForPluginInHarness` (11), `backfillGrantsFromEnabledPluginsAndLegacyFile` (6).

Total: **183 tests** specifically on the plugin/marketplace surface.

## What's deferred / out of scope

Everything in the two lists below was deferred as of this snapshot but has
landed since. Kept here as the milestone record, with the as-of-today status.

Documented in `/docs/spec/plugin-runtime-roadmap` (Batch F deferrals — **all shipped**):

* Typed `ctx.kv` with quotas — **shipped** (`plugin-kv.ts`, backed by `harness_shared.plugin_kv`, per-plugin quotas wired from `manifest.kvQuota`).
* Hot-reload state preservation — **shipped** (`getStateForReload`/`restoreFromReload` SDK hooks, gated on `manifest.hotReload.preserveState`, backed by `harness_shared.plugin_reload_state`).
* `papercusp plugin doctor` (declared-vs-used capability static analysis) — **shipped** (`plugin-doctor.ts`, wired into the CLI `case 'doctor'` → `cmdPluginDoctor`).

Awaiting user greenlight (Batches G/G+/H/I in `papercup-native/docs/ts-plugin-system-v1-plan.md`):

* WASM plugin runtime via `@bytecodealliance/jco` — **shipped** (Batch G3/I): loads a `wasm32-wasip2` component via `@papercusp/plugin-loader/wasm` (`initializeWasmPlugin`).
* Subprocess daemon runtime via `bwrap` — **shipped** (Batch G3/I): loads a `bwrap`-sandboxed stdio JSON-RPC peer via `@papercusp/plugin-loader/daemon` (`initializeDaemonPlugin`).
* Sandboxed iframe UI surface — **shipped** (`apps/operator/lib/PluginIframe.tsx` + the `/api/plugins/iframe-entry` route).
* Manifest schema now declares `runtime.kind` of `js` | `wasm` | `daemon`.

Out-of-band gated:

* **PR-B (snapshot republish UI)** — paused pending G+1/G+2 schema bump
* **`feat/bundle-runtime-deps`** in `papercusp-desktop` — only Claude+Meridian on-demand installer is unique; owner's call

## Key APIs at a glance

```
GET   /api/marketplace/catalog                  — proxies marketplace-api with hide-filter
POST  /api/marketplace/install                  — template install (slug-collision aware)
POST  /api/cupboard/install-plugin              — plugin install: git-clone the listing's GitHub repo (replaces the dead marketplace/install-plugin tarball path)
DELETE /api/marketplace/uninstall               — template uninstall
GET   /api/plugins/global                       — installed plugins
GET   /api/plugins/manifest?slug=<id>           — declared capabilities for consent UI
GET   /api/plugins/updates                      — installed-vs-catalog diff with capChange
GET   /api/plugins/grants?plugin=&version=&harness=
POST  /api/plugins/grants                       — toggle a (plugin, harness, cap) grant
POST  /api/plugins/enable                       — enable/disable a plugin in harness(es)
POST  /api/plugins/uninstall
# /api/snapshots/* (create, publish, instantiate, retract) — RETIRED; the
#   publishable-snapshot system moved to _retired/snapshot-system. Replacement:
#   the InstanceSpec system (packages/operator-core/lib/instance-spec/).
#   The surviving /api/harness/:slug/snapshots is a DIFFERENT feature
#   (per-harness iteration snapshots / FS rollback).
POST  /api/harness/<slug>/save-as-template
POST  /api/templates/<slug>/<version>/publish
```

## First places to look

* New plugin author: `/docs/spec/plugin-quickstart` — five-command flow from blank dir to published plugin.
* Plugin runtime contract: `packages/plugin-sdk/src/index.ts` — capability strings + lifecycle hook signatures.
* Capability semantics: `packages/plugin-loader/src/capabilities.ts` — wildcard matching, two-tier AND.
* Manifest schema: `packages/plugin-sdk/papercusp-plugin.schema.json` — `additionalProperties: false`.
* Lifecycle wire-up: `apps/operator/lib/plugin-host-runtime.ts` — fire-points + audit + grants integration.
* Marketplace registry: `../papercusp-registry/apps/marketplace-api/src/server.ts` — catalog, signing, retraction, SBOM.
