# 8. UI plugins — Backstage-DI + Figma-iframe hybrid
URL: /internal/docs/spec/ui-plugins



Today's harness console embeds the same UI for every harness — git-graph, branches, code-server, etc. — even when those don't apply (a marketing harness has no code branches). The fix: each harness install registers its own UI.

### 8.1 Reference apps studied

AppPlugin modelSandboxingDistribution

VS CodeManifest-declared contribution points (\~30 surfaces)Out-of-process extension host + iframe webviewsRuntime, \~50,000 extensions
BackstageReact packages registered at app build via DI container with typed services (`ApiRef`)NoneBuild-time only
FigmaPlugin JS sandboxed; UI iframe with manifest-declared network allowlistStrongest of all surveyedRuntime marketplace
JupyterLabLumino DI with typed tokens; whole app is pluginsNoneBuild OR runtime
WordPress (Gutenberg)Blocks via `registerBlockType()` + hooks systemNoneRuntime, \~60,000 plugins
ObsidianFull DOM/Node accessNone (cautionary tale — adding capability prompts post-incidents)Runtime

### 8.2 Papercusp UI plugin model — the hybrid

Backstage's API patterns + Figma's iframe sandbox + WordPress's hooks system.

Phase v1 (next 1-2 months): plugins are React packages registered via DI container at build time. Reference plugins (papercup, sheets) ship with the runtime. No sandbox — too early for marketplace concerns.

Phase v2 (when marketplace ships): same plugin manifest, but plugins ship as JS bundles loaded into iframe sandboxes. The DI container exposes services via postMessage RPC. Capabilities (§10) enforce at the iframe boundary.

### 8.3 Plugin manifest (UI portion)

```
// packages/plugin-sdk/src/index.ts (extended) — the live interface is `Plugin`
export interface PapercuspPlugin {
  name: string;
  version: string;
  description: string;
  capabilities: Capability[];   // see §10

  // ── UI contribution ─────────────────────────────────
  ui?: {
    /** URL slug — mounted at /harness/<slug> */
    slug: string;
    /** Display name in the harness picker */
    label: string;
    /** Optional icon (lucide-react name or URL) */
    icon?: string;
    /** Lazy-loaded React component (Phase v1) */
    component: () => Promise<{ default: ComponentType<HarnessUIProps> }>;
    /** Optional sub-routes within /harness/<slug>/<sub> */
    subRoutes?: SubRouteContribution[];
  };

  // (Other axes from §7…)
}

/** Props the host passes to the plugin's UI component */
export interface HarnessUIProps {
  /** Slug of the harness install */
  slug: string;
  /** DI container — plugin reads its capability-scoped services via this */
  api: PapercuspApi;
  /** Read-only? (e.g., on the public site) */
  readOnly: boolean;
}
```

### 8.3.1 Manifest authoring — TS source, frozen JSON output

Implemented (current state): the manifest is authored
directly as papercusp.json (validated against
papercusp-plugin.schema.json with
additionalProperties: false); the runtime entry point is a
Plugin literal in index.cjs that asserts
satisfies Plugin, so component/handler references are
type-checked there. The defineManifest() /
papercusp build / jsonOnly TS-source flow
described below did not ship — it is preserved here as design
rationale. See the
authoring quickstart
for the live manifest shape.

The manifest is authored as TypeScript, not JSON. Component refs are
type-checked at build time, eliminating the "componentId typo →
runtime not-found" failure mode that plagues string-keyed manifest systems.

```typescript
// papercusp.manifest.ts (authored)
import { defineManifest } from '@papercusp/plugin-sdk';
import WeatherTab from './components/WeatherTab';
import WeatherDashboard from './components/WeatherDashboard';

export default defineManifest({
name: 'sample-weather',
version: '0.1.0',
capabilities: ['ui:dashboard-tab', 'http:fetch:api.weather.gov'],
ui: {
slug: 'sample-weather',
label: 'Weather',
component: WeatherDashboard,        // typed reference, not a string
},
dashboardTabs: [
{ id: 'weather', label: 'Weather', component: WeatherTab },
],
});
```

At publish time, `papercusp build` produces a frozen
`papercusp.json` that lists components by stable componentId
(e.g. `"./components/WeatherTab.js#default"`) for tools that
don't have a TS runtime — the marketplace site, the install consent
prompt, the registry. The JSON is generated, never hand-edited.

Plugin authors who want to ship a JSON-only manifest may opt out via
`defineManifest({ ...config, jsonOnly: true })` and accept
the runtime-error tradeoff. Reference plugins (papercup, sheets,
shareholder-briefings) all ship the TS form.

### 8.4 The DI container (host services)

Plugins consume host state via typed services. The
PapercuspApi exposes each service as a direct property
(api.tasks, api.goals,
api.pendingEvents, api.routines,
api.comments, api.secrets,
api.storage, api.db, api.fetch,
api.capabilities); each call is a capability-gated proxy
that throws MissingCapabilityError when the plugin's
manifest hasn't declared the matching capability:

```
// What plugins use — services are direct properties, not a useService() lookup:
const completedTasks = await api.tasks.list({ status: 'passed' });  // throws unless 'tasks:read' granted

// Service definitions live in @papercusp/plugin-loader (api-factory.ts),
// not the SDK; the SDK only exports the `defineService` helper + TS interfaces:
export const TasksServiceDef = defineService({
  name: 'tasks',
  methods: {
    list:      { capability: 'tasks:read' },
    get:       { capability: 'tasks:read' },
    lineage:   { capability: 'tasks:read' },
    create:    { capability: 'tasks:write' },
    setStatus: { capability: 'tasks:write' },
  },
});

export const RoutinesServiceDef = defineService({
  name: 'routines',
  methods: {
    list:    { capability: 'routines:read' },
    upsert:  { capability: 'routines:write' },
    delete:  { capability: 'routines:write' },
    trigger: { capability: 'routines:write' },  // manually fire — inserts a pending_event
  },
});

export const SecretsServiceDef = defineService({
  name: 'secrets',
  methods: {
    // resource-specific cap: 'secrets:read:YOUTUBE_API_KEY'
    read: { capability: (name) => 'secrets:read:' + name },
  },
});
```

### 8.4.1 Service ABI versioning

Service definitions evolve. Without a version contract, every substrate
release risks silently breaking installed plugins. The substrate pins
services by semver range in the plugin manifest:

```typescript
// In the plugin manifest:
export default defineManifest({
// ...
services: {
tasks:   '^1.0',
secrets: '^2.0',
routines: '^1.2',
},
});
```

On load, the substrate compares the plugin's declared range against
each service's runtime version. If the range doesn't satisfy, the
plugin is rejected at install time — never silently downgraded.

Evolution rules (substrate maintainers must follow):

Patch (1.0.0 → 1.0.1): bug fixes only, no shape change.
Minor (1.0.x → 1.1.0): additive only — see "What counts as additive" below.
Major (1.x → 2.0): anything not on the additive list. Triggers a re-install consent prompt for every plugin pinning the old range.

What counts as additive (allowed in a minor bump):

Adding a new method to the service.
Adding a new optional parameter to an existing method (with a defined default).
Adding a new optional field to a return-type schema.
Widening a return-type union (`'a' | 'b'` → `'a' | 'b' | 'c'`) — but plugins should still treat unknown values as a degraded case.
Narrowing an input-type union to be more permissive (accept additional input shapes the plugin can pass).

What does NOT count as additive (requires a major bump):

Adding a required parameter, even with a TypeScript default — JSON callers don't see TS defaults and break.
Removing or renaming any method, parameter, or return field.
Narrowing a return-type union (removing a possible value).
Narrowing an input-type union to be more restrictive (rejecting inputs that previously worked).
Changing the meaning of an existing field (same name, different semantics).
Tightening validation (e.g., a string field that previously accepted any value now requires a regex match).

Authors who can't tell which side a change falls on should treat it as
major. The cost of an over-cautious major bump is a re-prompt; the cost
of a too-loose minor bump is silently broken installs.

Service schemas are validated with Zod (or compatible) on every method
return. A plugin compiled against v1.3 calling a v1.4 substrate gets
the new optional fields silently dropped at the schema boundary — never
a malformed object.

This is the single highest-leverage rule for the marketplace's
long-term health. Without it, "this plugin worked yesterday" becomes
the most common bug class.

### 8.5 The hooks system (WordPress-inspired)

Implemented (current state): the WordPress-style
PluginHookBus (addAction /
addFilter / emit) was retired
2026-06-12 (plugin-system-pot-port-2026-06-11
P-006 / D-003: zero registered consumers, and its invocations bypassed
dispatch — no audit, no fire-time capability gating). It is gone from
the loader, SDK, and host; the only surviving reference is a
throw-only browser stub under libs/papercusp/\_retired/.
The live model is two parts:

FROZEN typed lifecycle hooks
(PluginHooks on the Plugin interface —
onLoad, onUnload,
onHarnessCreated, beforeMissionStart,
afterDone, onFeaturePassed,
onPostWorker, etc.). The existing fire-points stay for
back-compat, but no new ones will be added — new host fire-points
ship as event emissions instead.
Capability-scoped event-reaction rules
(PluginReactionRule) — the public extension surface. A
plugin declares reactions: PluginReactionRule\[] (code
form) or manifest reactions (declarative subset); when a
rule's trigger on settles (a tool invocation observed at
the dispatcher, or a host emission like
pipeline:step-done), the host fires the rule's
fire target through normal dispatch —
auth-gated, quota'd, audited, loop-protected. The
events:listen:\<trigger> /
events:emit:\<name> capabilities still exist, gating
reaction-rule triggers and plugin event emissions (not a hook bus).

The reaction registry enforces a different namespace rule than the old
bus: a rule's fire target must be one of the plugin's
own projected tools
(\<plugin>.\<verb>) — the host throws if the
fire target belongs to another plugin. There is no list of reserved
event prefixes being rejected. The richer ordering / guard / slot
machinery in §8.5.1–§8.5.5 below (named predicates, integer priority,
addGuard/VETO,
useSlot/declareAction) is design intent and
is not in the shipped SDK.

Plugins extend behaviour without modifying core, via named hooks:

```
// Plugin code:
api.hooks.addAction('task.passed', async (task) => {
  // Generate a briefing video when the milestone task passes
  await generateBriefingVideo(task);
});

api.hooks.addFilter('task.title', (title, task) => {
  // Prepend a tag to every task title
  return '[briefings] ' + title;
});

// Substrate fires:
await api.hooks.runAction('task.passed', task);
const finalTitle = await api.hooks.applyFilter('task.title', task.title, task);
```

Hook names (and their argument shapes) are part of the spec. Plugins declare `events:listen:&lt;name&gt;` capabilities to subscribe.

### 8.5.1 Hook ordering — named predicates (canonical) + priority (fallback)

When multiple plugins register for the same hook, the substrate
determines execution order. Two ordering models are supported.
Predicates are the canonical form; integer priorities
exist as a fallback for ports of WordPress-style code.

8.5.1.a Named ordering predicates (preferred)

Authors declare relationships, not absolute numbers. The substrate
topologically sorts handlers and caches the resolved order
per-hook-name; the sort runs at install/uninstall/update
time, not on every fire. A hot hook like `task.passed`
firing thousands of times per minute reads its cached order with
no per-fire sort overhead.

Cache invalidation triggers: any plugin install, uninstall, update,
or capability change that would alter the handler set for that hook.
The substrate doesn't expose a manual cache flush — there's no
scenario where the resolved order changes without one of those
events.

```typescript
api.hooks.addAction('task.passed', handler, { runs: 'after:audit-log' });
api.hooks.addAction('task.passed', handler, { runs: 'before:billing' });
api.hooks.addAction('task.passed', handler, { runs: ['after:audit-log', 'before:billing'] });
```

Each predicate is `before:&lt;name&gt;` or
`after:&lt;name&gt;`, where `&lt;name&gt;` is
another handler's plugin name or a substrate-defined named anchor
(e.g. `after:substrate.audit-log`). Multiple predicates
AND together.

Cycles in the dependency graph are install-time errors,
not silent runtime races. References to unknown handlers are warnings
(handler still registers, predicate is treated as satisfied).

```
$ papercusp install plugin-x
Error: hook 'task.passed' has a cycle:
audit-log → billing → audit-log
Two plugins both declare runs:'after:' on each other. Pick a primary owner
and switch the other to runs:'before:'.
Aborted.
```

8.5.1.b Integer priorities (fallback)

For compatibility with WordPress-style code, integer priorities are
also accepted. Lower numbers run first; default priority is 10.

```typescript
api.hooks.addAction('task.passed', handler, { priority: 5 });   // runs first
api.hooks.addAction('task.passed', handler);                    // priority 10 (default)
api.hooks.addAction('task.passed', handler, { priority: 20 });  // runs last
```

Mixed handlers (some predicate, some priority) resolve in two passes:
the substrate first sorts the predicate-using handlers topologically,
then interleaves the priority-using handlers at their integer position
relative to that sorted list. Authors should not mix the two models in
the same hook chain — the resulting order is well-defined but harder
to reason about than picking one.

8.5.1.c Action vs filter semantics

Action chains run for side effects; all handlers fire regardless of return value. Filter chains pipe the value through each handler in order; each handler receives the previous handler's output.

```typescript
// Two plugins both filter task.title:
// Plugin A: addFilter('task.title', t => '[A] ' + t, { runs: 'after:audit-log' })
// Plugin B: addFilter('task.title', t => '[B] ' + t, { runs: 'after:billing' })
//
// If neither names the other, registration order tiebreaks.
// If A says { runs: 'after:billing' }, B runs first → final = '[A] [B] do thing'
```

Cancellation. A filter handler that returns the special papercup `api.hooks.STOP` halts the chain — no further handlers run, the current value is returned. Useful for veto patterns (e.g., a security plugin blocks a task title containing PII). For preventing actions from happening at all, see §8.5.2 (Guard hooks).

### 8.5.2 Guard hooks — pre-fact veto

Action and filter hooks run during or after an
operation. They can observe and (for filters) transform values, but
they cannot prevent the operation from happening. Guard hooks
run before an operation and can short-circuit it entirely.

```typescript
// Plugin code — block routine fires that exceed a per-fire cost cap:
api.hooks.addGuard('routine.beforeFire', (routine, ctx) => {
if (routine.estimated_cost_cents > 5000) {
return api.hooks.VETO('over per-fire $50 cap');
}
// returning nothing = approve
});

// Plugin code — block task creation with PII in title:
api.hooks.addGuard('task.beforeCreate', (task) => {
if (containsPII(task.title)) {
return api.hooks.VETO('PII detected in task title');
}
});
```

When ANY guard returns `VETO`, the operation aborts and
the substrate surfaces the reason to whoever initiated it (the
orchestrator, a routine fire, the user UI). Guard hooks run with
the same predicate-ordering semantics as actions; if multiple guards
veto, all reasons are surfaced together.

Naming convention. Substrate guards are named
`X.beforeY` (e.g. `task.beforeCreate`,
`routine.beforeFire`, `plugin.beforeInstall`).
Plugin-defined guards follow the same pattern.

Capability gating. Registering a guard requires
`events:guard:&lt;hook-name&gt;` in the manifest — separate
from `events:listen:&lt;hook-name&gt;` for advisory hooks.
Guards are higher-impact (they can break the substrate's flow), so
consent prompts surface them prominently.

### 8.5.3 Hook namespacing

Substrate-defined hooks live in flat namespaces (`task.passed`,
`routine.fired`). Plugin-defined hooks must
be prefixed with the plugin name to avoid collisions:

```typescript
// In plugin "shareholder-briefings" — defines a hook other plugins can listen to:
api.hooks.declareAction('shareholder-briefings.briefingReady', {
args: { briefing: BriefingSchema },
});

// Other plugins listen with the namespaced name:
api.hooks.addAction('shareholder-briefings.briefingReady', async (args) => {
await postToSlack(args.briefing);
});
```

The substrate rejects `declareAction()` calls whose hook
name doesn't begin with the plugin's own name. Listeners can subscribe
to anything (gated by `events:listen:&lt;hook-name&gt;`),
but only the owning plugin can fire the hook.

This eliminates the WordPress pathology where two unrelated plugins
each define a `save_post`-shaped hook and step on each other.

### 8.5.4 Cross-plugin transactions and consistency

Hooks are post-commit. When plugin A writes to its
schema and the substrate fires `plugin-a.rowSaved`, plugin B's
listener sees the row already committed. If B fails, the substrate
does not roll back A's write.

This is eventual-consistency by design. Plugin authors writing
cross-plugin flows should assume:

The originating write has committed before the hook fires.
Listener errors are logged to `audit.hook_executions`; subsequent listeners still run.
Retry logic is the listener's responsibility (e.g. via routines that re-process unsynced rows).

Saga semantics (cross-plugin atomicity, compensating
actions on failure) are out of scope for v1.0. Plugins that need
transactional cross-plugin behaviour should expose substrate-mediated
services that wrap the entire flow, rather than relying on hook chains.

### 8.5.5 Slots — composable surface contributions

§10.5 introduces --supplement as one resolution
for UI conflicts: a plugin runs as a sibling action when another
plugin's tab is rendered, "requires papercup to declare it as a
slot." This section defines what a slot is.

A slot is a named extension point inside a host
plugin's UI that other plugins can mount components into. The
host plugin declares slots in its manifest and renders them with
a typed component; supplementing plugins target slots by id.
It's the same pattern as VS Code's "menu contribution points"
but typed end-to-end.

Host plugin: declare slots.

```typescript
// papercup's manifest:
export default defineManifest({
name: 'papercup',
ui: {
slug: 'papercup',
component: PapercupRoot,
slots: [
{
  id: 'directives.row-actions',
  description: 'Per-row action buttons rendered after the default Edit/Delete in the directives table.',
  propsSchema: z.object({
    directive: DirectiveSchema,
    onClose: z.function().returns(z.void()),
  }),
},
{
  id: 'briefing-summary.footer',
  description: 'Footer area below the auto-generated briefing summary.',
  propsSchema: z.object({ briefingId: z.string() }),
},
],
},
});
```

Host plugin: render the slot.

```tsx
// In papercup's React tree:
import { useSlot } from '@papercusp/plugin-sdk/react';


export function DirectivesTableRow({ directive, onClose }) {
const slotChildren = useSlot('directives.row-actions', { directive, onClose });
return (
<tr>
<td>{directive.title}</td>
<td>
  <Button onClick={...}>Edit</Button>
  <Button onClick={...}>Delete</Button>
  {slotChildren /* every supplementing plugin's component appears here, in install order */}
</td>
</tr>
);
}
```

Supplementing plugin: contribute to a slot.

```typescript
// shareholder-briefings manifest:
export default defineManifest({
name: 'shareholder-briefings',
capabilities: ['ui:slot:papercup:directives.row-actions'],
ui: {
slug: 'shareholder-briefings',
component: BriefingsRoot,
slotContributions: [
{
  slot: 'papercup:directives.row-actions',
  component: GenerateBriefingButton,
},
],
},
});
```

Substrate guarantees.

Typed props. The host's propsSchema
is the contract. Supplementing components receive props validated
against that schema; a mismatch is an install-time error.
Capability gating. Slot contributions require
the resource-shaped capability
ui:slot:\<owner>:\<slot-id>. Users
consent at install time per slot, not blanket.
Failure isolation. A supplementing component
crash is caught by an error boundary the substrate wraps around
each slot child. The host's render tree continues; the broken
contribution shows a 1-line "X failed to render — see logs"
placeholder.
Order. Within a slot, contributions render
in install order by default. A contribution can declare a
`position` field of `'first'`, `'last'`, `{ before: 'plugin-name' }`,
or `{ after: 'plugin-name' }` — same predicate model as hook
ordering (§8.5.1.a).
Slot deprecation. Removing or renaming a
slot is a major-version event for the host plugin, just like
a service ABI break (§8.4.1). Substrate refuses load when
a contribution targets a removed slot.
Adding a new slot is additive (§8.4.1) — a minor
version bump for the host plugin. Existing supplementing plugins
keep working; new contributors can target the new slot. Renaming
the slot's propsSchema to be more permissive
(e.g., adding optional fields) is also additive; tightening the
schema (e.g., adding a required field, narrowing a union) is a
major-version event because existing contributors break.

Plugin-defined slots prefix. Like hook names
(§8.5.3), slot ids declared inside a plugin must be referenced as
\<owner>:\<slot-id> from outside. This
keeps two unrelated plugins from accidentally claiming the same
slot id.

### 8.6 v2 sandboxing — iframe + postMessage RPC

When the marketplace ships, plugins load as iframes:

```
<!-- Host renders for each registered plugin: -->
<iframe
  src="https://plugin-cdn.papercusp.com/<name>/<version>/index.html"
  sandbox="allow-scripts"
  csp="default-src 'self'; connect-src https://youtube.com https://googleapis.com"
/>

<!-- Inside the iframe: -->
<script>
  import { connectHostApi } from '@papercusp/plugin-sdk/iframe';
  const api = await connectHostApi();   // postMessage RPC handshake
  // Now `api` works just like the v1 in-process version
</script>
```

Same plugin code, same DI calls — only the loader changes. CSP enforces network allowlist; iframe sandbox enforces no DOM/storage access outside the plugin.

Implemented (current state): the
@papercusp/plugin-sdk/iframe subpath has shipped, but the
v2 sandbox model above is still design intent. The live iframe-bridge
surface is initPapercupIframe() plus the
usePapercupAction / usePapercupEvent /
usePapercupQuery helpers (not a single
connectHostApi() handshake as sketched here).

### 8.7 Two distribution channels: tarball-install vs iframe-CDN

The marketplace described in §11 ships tarballs that get installed locally and run in-process with the substrate. The iframe model in §8.6 describes a different channel — CDN-hosted iframe widgets. Both will exist; they target different use cases:

ChannelUse caseCode livesCapability boundaryTrust model

Tarball install (primary)
Full plugins: roles, schemas, routines, API routes, full-route UI panels. Anything that needs Postgres or long-lived state.
`~/.papercusp/installed/&lt;name&gt;/` after `papercusp install`
Function-call DI proxy (in-process)
User-grants capabilities at install time; plugin runs with full DI access for granted caps. Capability scope is the security perimeter.

Iframe widget (v2, supplementary)
Embeds, charts, demos, third-party visualizations, anything ephemeral that doesn't need substrate state. Also: untrusted plugins where the user wants stronger isolation.
CDN bundle at `https://plugin-cdn.papercusp.com/&lt;name&gt;/&lt;version&gt;/`
iframe sandbox + CSP + postMessage RPC
User picks per-plugin trust level. Iframe defaults to no DI access; capabilities only granted via postMessage RPC after explicit user approval.

A given plugin can ship as either. A few that do both: `weather-widget` ships as an iframe (just a chart), `shareholder-briefings` ships as a tarball (registers a routine + a role + a schema). A plugin that wants both forms publishes two manifests with the same name (CLI handles it; the user picks at install time).

Important caveat: the iframe sandbox stops DOM access and unlisted network calls. It does not add isolation for the DI surface — if the iframe is granted `db:plugin-schema`, it can still issue queries through the postMessage proxy. The DB write can hit the same Postgres rows as a tarball plugin's write. The iframe boundary is a network/DOM boundary, not a data boundary. If you need true data isolation, run the substrate against a separate database namespace (see §10.5).

Latency caveat. Every DI call from inside an iframe
is a postMessage RPC round-trip — typically 1–5ms. Per-frame interactions
(timeline scrubbers, drag handles, scroll-driven charts, audio
visualizers, anything inside a 16ms render budget) cannot afford that.
Iframe widgets are appropriate for read-mostly or
ephemeral surfaces; use a tarball install for any UI that touches the
DI surface in a render loop. Authors who attempt high-frequency
iframe RPC will hit jank that no engineering inside the plugin can fix.

### 8.8 Iframe-host routes inside the operator app

A dashboard tab (dashboardTabs\[] entry) can ship as an
in-process React component (componentRoot +
componentId) or an iframe
(iframeUrl, or iframeUrlConfigKey resolved against
the plugin's config). When both are present, the host prefers the iframe URL
(cheaper to validate at runtime; no rebuild required to update). An
iframe-mode tab can point at any URL — a separate origin like
localhost:8082 for code-server, or a route on the operator
itself. The latter is the iframe-host route pattern: the
plugin contributes nothing but a manifest, and the operator app renders the
actual UI at a dedicated route. @papercupai/starlight follows
this shape today (it is the successor to the outgoing
@papercupai/fumadocs — fumadocs the framework was migrated to
Astro Starlight): its tab declares
iframeUrlConfigKey: "docsUrl", defaulting to
[http://localhost:3055/project-docs](http://localhost:3055/project-docs).
(@papercupai/pi-coding originally used this pattern pointing at
/pi, but has since moved to an inline React dock —
componentRoot/componentId with
embedMode: "inline-dock" — rather than an iframe.)

Two non-obvious requirements when adding such a route:

Replicate provider context. The route inherits only the
app's root layout. Components that "just work" inside
/harness/\* may rely on harness-scoped providers (for example
Tooltip.Provider, HarnessSyncProvider) that the
root layout doesn't supply, throwing
"Tooltip must be used within TooltipProvider" at render.
Replicate just the providers the embedded component actually uses.
Strip the global chrome. The operator's root layout
always renders the top nav, OracleDock, and Chatwoot widget. Inside an
iframe-tab those are noise. Drop in
{'<Chromeless />'} from app/\_components/Chromeless.tsx:
it adds the papercusp-chromeless body class, which
globals.css uses to hide
.pc-header, #chatwoot\_live\_chat\_widget, and
the OracleDock (via its .oracle-dock /
.oracle-fab class selectors — not the
data-oracle-dock attribute). Pass auto when the route
is also meaningful standalone (e.g. /project-docs,
where direct visitors should still see chrome) — it will only apply
chromeless when window\.self !== window\.top.

Whether plugin dashboard tabs render at all is gated by the
PAPERCUSP\_TABS\_FROM\_PLUGINS feature flag (the "P7 plugin-tab
cutover", set to 1 on the substrate process). Given that flag,
the manifest's replaces: \['\<built-in-id>'] array handles
suppression: the dashboard hides the built-in hard-coded tab (e.g.
docs) when a plugin replacement is present and active. So the two
concerns are distinct — the flag controls whether plugin tabs appear, and
replaces controls which built-in tab the new one supersedes. See
pi integration for the
worked example.
