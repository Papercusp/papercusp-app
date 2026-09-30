# Papercusp runtime changelog

This file tracks changes to the **runtime contract** plugins depend on:
the lifecycle hooks that fire, the services exposed via `PapercuspApi`, the
capability strings, and the manifest fields the loader recognises.

The constant `PAPERCUSP_RUNTIME_VERSION` (in `@papercusp/plugin-sdk`) is
the single source of truth for the host's current runtime; plugin
manifests declare a compatible range via `papercusp: '<range>'`.

Bump rules:
- **patch** — bug fixes / internals invisible to plugins.
- **minor** — adds new optional surface (lifecycle hook, service, ctx
  field, capability prefix). Backwards-compatible.
- **major** — removes or renames existing surface, or changes the
  semantics of an existing field. Plugins with `^OLD.x` will refuse to
  load against `NEW.0`.

## 0.1.0 — 2026-04-29

First documented runtime version. Establishes the v1.0 framework shape.
Plugins shipped before this changelog landed used the same surface and
should keep working without manifest changes.

### Lifecycle hooks (typed `PluginHooks` shape)

All seven fire-points are wired:

- `onLoad(ctx)` / `onUnload(ctx)` — plugin lifecycle.
- `beforeMissionStart(ctx)` — fires once before the harness loop's first
  iteration. Wired in both the operator (POST `/launch`) and `run.sh`.
- `afterDone(ctx)` — fires when the orchestrator decides DONE. Wired in
  `run.sh`.
- `onFeaturePassed(ctx, featureId)` — fires after a feature transitions
  to `passed`. Wired in the operator (PATCH features).
- `onProposalAccepted(ctx, proposalPath)` — fires after a reviewer-
  approved proposal is applied. Wired in the operator.
- `onPostOrchestrator(ctx, decision)` — fires after every orchestrator
  invoke; receives the decision verb. Wired in `run.sh`.
- `onPostWorker(ctx, featureId)` — fires after each worker invoke. Wired
  at all four worker call sites in `run.sh` (CEO mode, competition lane,
  parallel lane, sequential lane).
- `onPostValidator(ctx, featureId, status)` — fires after each validator
  invoke; status is `'passed' | 'failing'`. Wired in `run.sh`.

Lifecycle hooks live on the `Plugin.hooks` field. Each handler receives
a `PapercuspContext` (paths + log + actions registry).

### Free-form event bus

Plugins may also `addAction` / `addFilter` / `emit` arbitrary string
events through `ctx.api.hooks` (a per-plugin `PluginHookBus` view). The
host emits a small set of free-form events alongside the typed ones:

- `mission.start` — paired with `beforeMissionStart`.
- `task.passed` / `feature.completed` — paired with `onFeaturePassed`.
- `proposal.accepted` — paired with `onProposalAccepted`.

Plugins must declare `events:listen:<name>` to subscribe and
`events:emit:<name>` to fire their own events.

### Action registry

Plugins declare actions in `manifest.actions[]` and bind handlers from
`init(ctx)` via `ctx.actions.register(name, handler)`. The host:

1. Builds a per-(plugin, harness) `ServerActionRegistry` keyed off the
   manifest declarations.
2. Validates each declared action's `capabilities[]` is a subset of the
   plugin's manifest-level `capabilities[]`.
3. Calls `init(ctx)` so the plugin can register handlers.
4. Seals the registry — subsequent `register()` calls throw.
5. Dispatches via `invokePluginAction({plugin, action, slug, params})`,
   honoring `manifest.actions[i].serverHandler.timeoutSec`.

The registry is exposed at `ctx.actions: PluginActionRegistry` on the
`PapercuspContext`.

### Capability strings

```
roles:register:<role>
ui:harness-route | ui:dashboard-tab | ui:sidebar-item | ui:harness-toolbar
events:emit:<name> | events:listen:<name>
http:fetch:<host>           // exact OR `*.subdomain` wildcard
secrets:read:<NAME>         // exact OR `<PREFIX>_*` wildcard
storage:plugin-private
db:plugin-schema
tasks:read | tasks:write
goals:read | goals:write
routines:read | routines:write
comments:read | comments:write
```

Wildcard rules (added 2026-04-29):
- `http:fetch:*.foo.com` matches any `http:fetch:<sub>.foo.com` (the
  leading `*.` is literal — does not match the bare suffix).
- `secrets:read:YT_*` matches any `secrets:read:YT_<rest>` (head must be
  non-empty; `secrets:read:*` is rejected).

### Manifest schema

```json
{
  "name": "@scope/plugin",
  "version": "0.1.0",
  "papercusp": "^0.1.0",
  "capabilities": [...],
  "actions": [...],
  "dashboardTabs": [...],
  "sidebarItems": [...],
  "routines": [...],
  "schema": { "schemaName": "myplugin", "ddlPath": "sql/init.sql" },
  "configSchema": {...},
  "uiSchema": {...}
}
```

The `schema` field accepts three shapes (the install path normalizes):
- A single `PluginSchemaDef` object.
- An array of `PluginSchemaDef` objects (multiple owned schemas).
- A legacy bare string array of DDL paths.

`papercusp install` runs the DDL files via `psql ON_ERROR_STOP=1` against
the `papercusp` database.

### Loader contract

- `loadPluginFromDir(dir)` returns `{plugin, path, source}` or `{error, path}`.
- `loadPlugins({projectDir, harnessSlugs, globalPluginsDir})` discovers and
  dedupes (project > harness > global).
- Validation rejects: `papercusp` range mismatches with the runtime;
  manifest/plugin name or version mismatches; declared roles without
  matching `roles:register:<n>` capability; UI / dashboardTabs /
  sidebarItems contributions without their respective UI capability.

### Host runtime APIs

Server-side, the operator exposes:

- `GET /api/plugins/runtime/status?reset=1` — diagnostics.
- `POST /api/plugins/runtime/fire-event` — dispatch a free-form event or
  a typed lifecycle hook (testing only).
- `POST /api/plugins/runtime/invoke-action` — invoke a plugin action via
  the in-process registry.
- `GET /api/plugins/global` — installed-plugin manifest dump.
- `GET /api/plugins/:slug/contributions` — flattened dashboardTabs +
  sidebarItems + routes for a harness.
- `mountPluginApiRoutes(app)` — mounts each plugin's `apiRoutes` (Hono
  app or Fetch handler) at `/api/plugins/<plugin-name>/`.

### Known shape changes since pre-0.1.0

- `PapercuspContext.actions?: PluginActionRegistry` is now an honest
  field on the SDK type (was previously runtime-only).
- `PluginSchemaDef` joined by a sibling `PluginSchemaField` union to
  allow array / legacy string-array forms in the manifest.
- Wildcard caps recognised by `hasCapability` (subdomain + prefix).
