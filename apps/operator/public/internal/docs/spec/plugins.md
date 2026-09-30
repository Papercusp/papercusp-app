# 7. Plugin extension points & runtime
URL: /internal/docs/spec/plugins



Plugins extend a Papercusp install along five axes:

Extension pointWhat it addsPlugin SDK type

Lifecycle hooksCode that runs at well-known host phases (frozen surface — new pipeline integrations use event-reaction rules; plugin-system-pot-port D-003)`PluginHooks`
Event-reaction rulesDeclarative "when X settles, fire my tool" rules over the one reaction registry — the live pipeline extension surface (§7.0)`PluginReactionRule`
UI (full-route)A complete React panel mounted at `/harness/&lt;slug&gt;` — see §8`UiContribution`
API routesA Hono sub-app the runtime mounts at `/api/plugins/&lt;name&gt;/``PluginApiRoutes`
DB schemaPostgres DDL (schemaName + ddlPath, or a bare DDL-path array) applied at install under the plugin's own schema`PluginSchemaField`

Retired axes (2026-06-12, plugin-system-pot-port D-004): Roles (`RoleDefinition` — the old orchestrator's plugin-dispatched agent roles; live roles are `AGENT_ROLES` + blueprint role prompts, and "a plugin contributes a blueprint role" is a future design, not this axis) and Routines (`RoutineDefinition` — targeted the retired `pending_events` queue; use blueprint `triggers.schedule` or event-reaction schedules). Both manifest-level `roles` and `routines` entries remain schema-tolerated as inert `array<object>` declarative data — the loader ignores them; there are no `RoleDefinition` / `RoutineDefinition` SDK types.

Plugins also declare capabilities (§10) — a permission manifest that the runtime enforces at the DI boundary. Sections 7.1–7.5 below describe the substrate-level concerns that apply to every plugin regardless of which axes it extends.

### 7.0 Hooking the pipeline — event-reaction rules

The hybrid hook model (plugin-system-pot-port-2026-06-11 D-003, ratified 2026-06-12):
the typed PluginHooks fire-points that survived the run-loop retirement
(beforeMissionStart, onFeaturePassed, afterDone) are
FROZEN — they keep firing in-process for back-compat but no new typed fire-point will
ever be added, and their invocations bypass dispatch (no audit, no capability gate). The WordPress-style
hook bus (addAction/addFilter, the old PluginHookBus) is
retired (it had zero registered consumers). New pipeline fire-points are
event emissions only, and plugins subscribe by declaring reaction rules.

The PluginHooks interface declares more fire-points than
the host wires today. Of the typed surface, only
onLoad and restoreFromReload (at init) plus
beforeMissionStart, onFeaturePassed, and
afterDone (via firePluginLifecycle) are
actually invoked by the pipeline. The remaining declared hooks —
onHarnessCreated, onProposalAccepted,
onPostOrchestrator, onPostWorker,
onPostValidator, contributeOperatorSuggestions —
exist on the type but have no fire site yet; they are declared-but-not-fired.

A rule is {`{ id, on, when?, fire, args?, onlyOnSuccess?, capability? }`} —
declared in the manifest (reactions\[], the declarative subset: when is a
data-match object, args a static object) or on the entry plugin's
reactions export (function forms allowed). The host registers each into the one
reaction registry (registerReactionRule) at plugin-host boot, after the tool sweep.

The capability contract (event-reaction-system D-012):

each trigger in on requires a manifest capability events:listen:\<trigger> — the consent surface for what the plugin watches;
fire must name one of the plugin's own projected tools (\<plugin>.\<verb>) — registration refuses foreign targets;
the reaction runs through normal dispatch under a principal holding only the rule's capability (default: the fired tool's declared capability), so auth, quota, audit and the cause-chain loop guard all ride free.

What a rule can trigger on: any tool invocation observed at the dispatcher
(e.g. work\_items:complete, work\_items:claim), any plugin-emitted event
(the WASM event sink and plugins:fire\_event feed the same matcher), and the
pipeline event vocabulary the live DBOS pipeline emits
(lib/events/pipeline-events.ts):

Reaction trigger key`events:await` keyFires when

`pipeline:launch``pipeline:launch:&lt;slug&gt;`a harness run is launched
`pipeline:step-start``pipeline:step-start:&lt;slug&gt;:&lt;feature&gt;:&lt;role&gt;`a spine role dispatch is starting
`pipeline:step-done``pipeline:step-done:&lt;slug&gt;:&lt;feature&gt;:&lt;role&gt;`a spine role dispatch finished (payload: exitCode, durationMs, runId)
`pipeline:done``pipeline:done:&lt;slug&gt;:&lt;feature&gt;`a feature pipeline finalized DONE
`pipeline:escalate``pipeline:escalate:&lt;slug&gt;:&lt;feature&gt;`a feature pipeline finalized ESCALATE (payload: reason)

The work-items lifecycle additionally emits awaited events
(work-item:claimed:\<id>, work-item:blocked:\<id>,
work-item:done:\<id>, work-item:unblocked:\<id>) — reaction rules
trigger on the tools (work\_items:claim / set\_state /
complete), while agents sleep on the exact keys via events:await. One
emission serves reactions, awaits and UI simultaneously; registered plugin rules are inspectable via
plugins:runtime\_status (reactionRules) and events:graph.

### 7.1 Inter-plugin dependencies

Plugins frequently rely on services or tools declared by other
plugins. The manifest carries this dependency as plugin-slug
metadata so lock-resolve can build a dependency graph at
Cupboard install time.

Today `requires` is a bare array of plugin slug strings (hard
dependencies, used by `papercusp install` / `papercusp plugin
        install` to build the lock-resolve graph), with a sibling
`recommends` array for soft dependencies — surfaced to the user
during install but never auto-installed. There is no
name→version-range object form and no per-entry `{ version,
        optional }` shape; both fields are arrays of slugs like
`"@org/dep-plugin"`. (The manifest's top-level is
`additionalProperties: false`, so only schema-known keys are
accepted.)

```json
// papercusp.json:
{
"name": "shareholder-briefings",
"version": "1.2.0",
// Hard dependencies — slugs lock-resolve includes in the graph.
"requires": ["@org/audit-log"],
// Soft dependencies — surfaced at install, never auto-installed.
"recommends": ["@org/papercup"]
// ...
}
```

Note: there is no implemented version-range dependency resolver
or `api.hasPlugin(name)` presence-check API today — `requires`
and `recommends` are schema-tolerated metadata that lock-resolve
reads to order installs, not a runtime semver gate. The
per-version-range resolution, cascading-uninstall, and
`--orphan` behaviors described in earlier drafts are design
intent tracked in the plugin-system plans, not shipped code.

Runtime version pinning. Independently of
plugin-to-plugin deps, every manifest declares the substrate
runtime semver range it was built against, via the
papercusp field:

```json
// papercusp.json:
{
// ...
"papercusp": "^0.1.0"   // refuses to load outside this range
}
```

This is the same versioning shape as service ABI pinning
(§8.4.1), but at the runtime level. The loader runs
satisfies(PAPERCUSP\_RUNTIME\_VERSION, manifest.papercusp)
on every load and rejects out-of-range plugins, catching the case
where a plugin built against an old runtime would otherwise hit
subtle API drift bugs. (PAPERCUSP\_RUNTIME\_VERSION is
0.1.1 today.)

A separate protocol field pins the plugin
wire-protocol version, independent of the
runtime release cycle so hooks can evolve without bumping the
whole runtime. It is enforced identically at load: the loader
runs satisfies(PROTOCOL\_VERSION, manifest.protocol)
and refuses out-of-range plugins. PROTOCOL\_VERSION
is fixed at 1.0.0 today; future bumps will refuse
loads from plugins that don't declare a compatible range.

### 7.2 Plugin lifecycle — enable / disable

A plugin lives on disk under
\~/.papercusp/global-plugins/\<slug>/ (installed by
the Cupboard git-clone above, or symlinked for local dev). Its
runtime presence is binary per harness: enabled
or disabled. There is no six-state machine and
no per-plugin runtime quarantined/updating/uninstalling
state tracked in code today — those, along with a crash circuit
breaker and a transition audit log, are design intent in the
plugin-system plans, not shipped substrate.

StateMeaningHooks fire?UI mounted?

disabled
On disk under global-plugins/\<slug>/ but not wired into a harness. Config and any DB schema are retained.
No
No

enabled
Wired into the harness: tools projected, reaction rules registered, typed hooks live, UI route mounted at /harness/\<slug>.
Yes
Yes

The CLI wires both transitions:
papercusp plugin enable \<slug> \[--harness \<slug>]
records the manifest's capabilities as grants for the target
harness (after consent) and brings the plugin into the host;
papercusp plugin disable \<slug> \[--harness \<slug>]
unwires it. (A quarantined/withdrawn
concept does exist, but only at the Cupboard lock/version
layer — papercusp lock upgrade-pin/upgrade-all
operate over withdrawn or quarantined package versions,
not a per-plugin runtime circuit-breaker.)

Hot-reload state. When a plugin reloads (a file
change in dev, a config edit), the host can preserve in-flight
state across the swap. If the manifest opts in
(hotReload: {`{ preserveState: true }`}), the host
calls the plugin's getStateForReload(ctx) before
unloading and restoreFromReload(ctx, state) after the
new module's init() — before any other hook. The
stashed value (JSON, ≤ 64 KiB, keyed by plugin + harness) lives in
harness\_shared.plugin\_reload\_state (Migration 055).

### 7.3 Host hook-error handling

Plugins fail. The host must not let one plugin's bug take down a
harness run. The typed-hook invoker
(firePluginLifecycle) wraps each handler call in
try/catch: a throw is caught, logged to the harness run log
(hook "\<name>" threw: \<message>), and the
pipeline continues. The throw never propagates to the host's main
loop.

That is the whole of the shipped fault-isolation story for typed
hooks today — catch, log, continue. There is no
throw/timeout counting, no per-fault-class threshold, no
quarantine transition, and no audit row. The per-plugin crash
circuit breaker (5-throws-in-60s thresholds, handler eviction,
a circuitBreaker manifest field) described in earlier
drafts is unbuilt design intent: there is no
circuitBreaker key in the SDK manifest type or the
JSON schema (whose top-level is additionalProperties:
false), so a manifest declaring one is rejected outright.

Reaction rules (§7.0) are the path that does get the full
substrate treatment — they run through normal dispatch, so auth,
quota, audit, and the cause-chain loop guard all apply. New
fault-tolerance work targets that surface, not the frozen typed
hooks.

### 7.4 Failure-mode taxonomy

The implemented substrate behavior for the failure classes that
exist in code today:

FailureSubstrate behaviorWhat the plugin author does about it

Capability missing / revoked at call
The DI proxy / dispatch refuses the call — the capability AND-check fails (§10).
Declare the capability in the manifest; wrap optional calls in try/catch and degrade gracefully.

Typed hook handler throws
Caught and logged to the run log; the pipeline continues (§7.3). No counter, no eviction, no audit row.
Read the run log; keep hook bodies defensive — they are advisory, not for heavy lifting.

Runtime version out of range
The loader runs satisfies(PAPERCUSP\_RUNTIME\_VERSION, manifest.papercusp) and refuses to load with a one-line range-mismatch error.
Bump the manifest's papercusp range and republish.

Wire-protocol version out of range
The loader runs satisfies(PROTOCOL\_VERSION, manifest.protocol) and refuses to load.
Bump the manifest's protocol range to include the host's PROTOCOL\_VERSION.

Tool / handler cross-validation fails
The loader rejects the plugin at load: every manifest tool needs a handler, no orphan handlers, and each tool's capabilities must subset the plugin's declared set.
Keep papercusp.json tools\[] and the exported handler map in sync (or use getDynamicTools).

The richer taxonomy from earlier drafts — per-hook deadlines with
a hooks:long-running capability, API-route 500s into
audit.api\_errors, routine-fire timeouts into
routine\_fires, transactional migration rollback, UI
slot-id collision resolution, and the
audit.plugin\_errors/audit.install\_attempts
tables — describes substrate that does not exist in code. None of
those audit tables are defined, and routines are a retired axis
(§7). Treat that list as design intent for the plugin-runtime
roadmap, not current behavior.

### 7.5 Developer experience

The inner loop for plugin authors determines whether the marketplace
ever has third-party content. The substrate ships an opinionated
dev mode aimed at sub-second iteration:

Implemented (current state): the shipped author commands are
papercusp plugin init \<name> \[--template \<slug>]
(scaffold from a reference plugin — default cloudflare-stack),
papercusp plugin lint, papercusp plugin doctor,
and papercusp plugin watch \<slug>. The manifest is a
papercusp.json file (not a TS file); plugins symlink into
\~/.papercusp/global-plugins/ for local dev. The
papercusp dev single-command hot-reload session sketched
below is design intent — see the
authoring quickstart
for the current workflow and the
runtime roadmap
for what shipped vs. deferred.

```
$ papercusp dev ./my-plugin

==> Linked ./my-plugin into ~/.papercusp/installed/my-plugin/ (symlink)
==> Watching: src/**, papercusp.manifest.ts, migrations/**, public/**
==> Substrate state: my-plugin@dev (state=active, hot-reload=on)
==> http://localhost:3055/                ← substrate UI
==> http://localhost:3055/harness/my-plugin   ← your UI surface

[hot-reload] src/components/Tab.tsx changed → React Refresh applied (no remount)
[hot-reload] papercusp.manifest.ts changed → manifest revalidated; new capabilities require consent (paused)
[hot-reload] migrations/0002_add_foo.sql added → applied (foo column exists)
```

Substrate guarantees in dev mode:

UI components hot-swap. React Fast Refresh
is preserved across the substrate-plugin boundary. Component
state survives unless the export shape changes.
Hook handler swaps. Editing a handler's body
replaces the registered function on next file save. In-flight
handler calls continue with the old function; the next fire
uses the new one.
Service ABI mismatches surface immediately
as a substrate banner instead of a runtime crash.
Schema migrations auto-apply on file change.
New `up.sql` files run in order; new `down.sql` siblings allow
the substrate to reverse a migration when the file is reverted
(`papercusp dev --no-auto-migrate` opts out).
Capability changes pause the plugin with a
single-line consent prompt rather than auto-granting in dev.
The author must approve, just as users will. This catches the
"works on my machine, fails on user install" failure mode.
Routines fire at 10× normal cadence when
`papercusp dev --fast-routines` is set, so cron jobs are
observable in a 5-minute session instead of waiting an hour.

What dev mode does not do:

It does not bypass capability checks. A plugin that needs
`secrets:read:FOO` in production needs it in dev too.
It does not change the wire format of any DI service or
hook payload. What works in dev works in install — modulo
environment differences.
It does not auto-publish. Publishing is always
`papercusp publish`, an explicit user action.

Plugin SDK scaffolding.

```
$ papercusp plugin init my-plugin --template cloudflare-stack

==> Creating ./my-plugin/
package.json
papercusp.json
index.cjs
provision/setup.sh
README.md
...

==> Done. Next:
cd my-plugin && papercusp plugin lint
```

papercusp plugin init copies an existing reference
plugin (default cloudflare-stack) and rewrites every
reference to the new slug; --template \<slug> picks
a different starter and --from-path \<dir> forks a
local checkout. Because the scaffold is a real first-party plugin
under libs/papercusp/plugins/, the output is verifiable
from source.
