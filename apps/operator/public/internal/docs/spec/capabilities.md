# 10. Capability-gated plugin permissions
URL: /internal/docs/spec/capabilities



Three layers, modeled on Tauri's capability files + Browser Manifest V3 install consent + Cap'n-Proto-style typed proxies:

### 10.1 Manifest declaration

```
const plugin: PapercuspPlugin = {
  name: 'shareholder-briefings',
  capabilities: [
    // Data access (scoped):
    'tasks:read',
    'comments:write',
    'features:read',
    'routines:write',

    // Plugin-private resources (always granted; declarative):
    'storage:plugin-private',
    'db:plugin-schema',

    // Network — manifest declares allowed domains; iframe CSP enforces:
    'http:fetch:youtube.com',
    'http:fetch:googleapis.com',

    // UI surfaces this plugin claims:
    'ui:dashboard-tab',
    'ui:sidebar-item',

    // Secrets — by name, no wildcard:
    'secrets:read:YOUTUBE_API_KEY',

    // Hooks:
    'events:emit:briefing-ready',
    'events:listen:task-completed',

    // Roles to register:
    'roles:register:narrator',
  ],
};
```

### 10.2 DI container runtime check

```
function createPluginContext(plugin: LoadedPlugin): PapercuspApi {
  return {
    tasks: makeServiceProxy(plugin, TasksService),
    comments: makeServiceProxy(plugin, CommentsService),
    routines: makeServiceProxy(plugin, RoutinesService),
    secrets: makeSecretsProxy(plugin),
    fetch: makeFetchProxy(plugin),     // checks domain against http:fetch:* allowlist
    storage: makePluginStorage(plugin),
    db: makePluginDb(plugin),
    hooks: makeHookBus(plugin),         // checks events:listen:* / events:emit:*
  };
}

function makeServiceProxy(plugin, service) {
  return new Proxy({}, {
    get: (_, method) => {
      const requiredCap = service.methods[method]?.capability;
      if (!requiredCap) throw new MethodNotAllowedError(service.name, method);
      if (!plugin.capabilities.includes(requiredCap)) {
        throw new MissingCapabilityError(plugin.name, requiredCap);
      }
      return realServices[service.name][method];
    }
  });
}
```

### 10.3 Install-time user consent

```
$ papercusp install shareholder-briefings@1.2.0

shareholder-briefings@1.2.0 requests these permissions:

  Read your tasks
  Write comments on tasks
  Register routines (scheduled work)
  Read your YOUTUBE_API_KEY secret
  Make HTTP requests to: youtube.com, googleapis.com
  Add a dashboard tab + sidebar item
  Register a 'narrator' role

Approve all? [y/N/per-capability]: y

Saved to ~/.papercusp/installed/shareholder-briefings/granted-capabilities.json
```

Permissions can be revoked per-capability later. There is no
`papercusp permissions revoke` CLI subcommand in the shipped
operator — revocation runs through the HTTP route
`POST /api/plugins/grants` with `action: 'revoke'`, backed by
`revokeCapabilities()` in `plugin-grants.ts` (a `DELETE` of the
specific `(plugin, version, harness, capability)` rows from
Postgres). The matching `action: 'grant'` re-grants a cap.

### 10.4 Iframe sandbox network enforcement

Outbound-domain enforcement is done host-side by
the `makeFetchProxy` DI proxy
(`plugin-loader/src/capabilities.ts`), not by a per-plugin CSP. The
proxy resolves each request's hostname, builds the
`http:fetch:&lt;host&gt;` capability, and rejects with
`MissingCapabilityError` unless the plugin's manifest declares that
host (exact or subdomain-wildcard — see the two-tier check in §10.7).
The CSP-as-domain-allowlist
sketch below is future-state (v2) and is not how the shipped
code works:

```
<!-- v2 (not shipped): inject manifest domains into the iframe CSP -->
<iframe
src="..."
sandbox="allow-scripts"
csp="default-src 'self'; connect-src https://youtube.com https://googleapis.com"
/>
```

The CSP the operator actually serves for the plugin iframe
(`endpoint-route/routes/plugins/iframe-entry.ts`) is fixed and does
not inject any manifest domains:

```
default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self' 'unsafe-inline';
connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'
```

Because `connect-src` is `'self'`, iframe JS cannot make any
cross-origin request — allowlisted or not — so plugin `http:fetch`
traffic goes through the host fetch proxy rather than directly from
the iframe. The host sandbox is `allow-scripts allow-forms`
(`PluginIframe.tsx`). Multiple defenses (manifest declaration +
host-side fetch proxy + the locked-down iframe CSP) so that bypassing
any one isn't sufficient.

### 10.5 Cross-plugin coordination & conflict resolution

Multiple plugins inevitably want the same surface. The substrate resolves conflicts at install or load time, never silently. Three classes of conflict:

UI surface conflicts (tabs, sidebar items, routes)

Each UI contribution declares a global `id` (e.g. `dashboardTabs[].id = "directives"`). At install time, the substrate checks the registry for collisions:

```
$ papercusp install foo

Error: foo declares dashboardTab id "directives" but papercup already
owns it. Either:
--rename-id directives:foo-directives    (mount as separate tab)
--replace                                (replace papercup's tab — papercup must not be installed)
--supplement                             (run as a sibling action when papercup's tab is rendered; requires papercup to declare it as a slot)
Aborted.
```

Default behavior is abort. The user explicitly picks the resolution. This avoids "I installed plugin X and my dashboard broke" silent breakage.

Hook chain conflicts

Multiple plugins listening to the same hook are not a conflict — they're a chain (§8.5.1). Authors pick priorities. The substrate logs the full chain to `audit.hook_executions` so you can debug surprising filter outputs.

Schema namespace conflicts

Each plugin owns its own Postgres schema (`papercup_shared`, `briefings`, etc.). Two plugins claiming the same schema is rejected at install time. Plugins that share data do so via the substrate's typed services — never by writing into another plugin's schema directly. Cross-plugin reads through the substrate are gated on `data:read:&lt;plugin-name&gt;:&lt;table&gt;` capabilities.

Tenant isolation

When two substrate installs run side-by-side (personal + work), they default to a per-install Postgres database. The plugin schema name (`papercup_shared`) is scoped within the install's DB, so the same plugin running in two installs writes to two independent schemas. Substrate explicitly does not support shared-database multi-tenancy — operators that need multiple users on one DB run their own row-level-security policies on top.

### 10.6 Mitigating permission fatigue

Browser/Android permission systems all converge on the same failure mode: users blindly approve everything because the manifests are long and abstract. Papercusp mitigates with four policy choices baked into the consent flow (§10.3):

Tier capabilities by impact, not count. See §10.6.1 below — every capability is classified low/medium/high, and the consent prompt surfaces high-impact caps (secrets, outbound network, cross-plugin reads) first. There is no per-tier count cap; the tier drives display order and the Operator's ask-vs-auto-grant decision, not a numeric limit. This is more honest than counting raw capabilities, since "26 capabilities" can be either trivial (a reference plugin like Papercup) or alarming (a generic plugin reading every secret).

Group at consent. See §10.6.2 — the CLI prompt collapses related capabilities into a single user-facing decision. "Read 3 secrets: A, B, C" is one line, not three. "Network access: youtube.com, googleapis.com" is one line, not two. A plugin declaring 26 capabilities typically reduces to 5–7 user-visible decisions.

Order by blast radius. The grouped-and-tiered list is sorted with secrets and outbound network at the top, internal reads at the bottom. The user reads "Read your YOUTUBE\_API\_KEY" before "Add a sidebar item".

Default-deny new capabilities at update time. When `papercusp update` finds new capabilities in the new version, it prompts only for those — previously-granted ones aren't re-asked. If the user denies, the install runs at the old version's capability set; the plugin must check `api.hasCapability()` and degrade gracefully. See §10.8 for full lifecycle.

#### 10.6.1 Capability tiers

Each capability is classified low/medium/high. The tier drives two
things: the order and grouping of the consent prompt (§10.6.2), and
the Operator's ask-vs-auto-grant decision. It is not
a count cap — nothing in the codebase limits how many caps of a tier
a plugin may request, and there are no overage flags.

Tiers are configurable per-plugin, with one
constraint. The manifest exposes an optional `tierMap`
(`plugin-sdk/src/index.ts`) that lets a plugin declare a more
permissive tier for caps it owns (e.g. mapping a safe webhook
`http:fetch:slack.com` down to `low`). The single guardrail: a
high-tier substrate cap cannot be downgraded — the Operator
pipeline ignores any `tierMap` entry that maps a substrate cap below
what the substrate table specifies. Plugin-defined caps not in the
substrate table default to `high` (fail-safe → always ask) and can be
lowered via `tierMap`.

There are three classification sources in the live code, and they do
not perfectly agree — a reviewer reconciling them should treat the
runtime resolver as authoritative for the Operator pipeline:

Runtime resolver — `papercuspTierFor()`
(`agent-mcp/src/capability-tiers-papercusp.ts`), registered via
`setCapabilityTierResolver` at boot (P-012 / D-006). Prefix rules:
`secrets:`, `http:fetch:`, and `data:read:` → high;
`events:` and `roles:register:` → medium; anything
unclassified → medium (fail-safe default).

Substrate tier table — `tier-table.json`, consumed
by the Operator pipeline's `lookupTier()`. It classifies most
`:read` caps `low` and most `:write` caps `medium`; notable entries
are `comments:write` → `low`, `data:read:*:*` → `medium`,
`secrets:read:*` / `secrets:write:*` / `harness:dispatch:*` /
`pending_events:write` → `high`.

CLI display — `tierOf()` in the CLI
(`cli/src/consent.ts`) is display-only (it groups caps under
high/medium/low headings, it does not count or gate). It differs
from the resolver: `events:emit:`/`events:listen:` → `low`, and a
non-wildcard `http:fetch:&lt;host&gt;` → `medium` while a wildcard
`http:fetch:*` → `high`.

Tier names like `events:guard:*`, `routines:rate-limit-bypass:*`, and
`budget:daily:*-usd` are not declared anywhere in the substrate today;
they are illustrative of the high tier's intent, not shipped caps.

The reference plugin Papercup declares a large capability set
dominated by low-tier reads, UI surfaces, and plugin-private storage,
with a handful of medium (writes, routines, role registrations) and a
few high (cross-plugin reads + outbound network). Because there is no
count cap, the only consent-flow consequence is ordering and grouping
— the high-impact caps surface first.

#### 10.6.2 Grouped consent

At consent time, the substrate collapses related capabilities into
single user-facing lines. The grouping rules are part of the spec
(not per-plugin), so two plugins that ask for similar things present
the user with similar prompts.

Grouping rules:

`secrets:read:A`, `secrets:read:B`, `secrets:read:C` → one line: "Read 3 secrets: A, B, C"
`http:fetch:youtube.com`, `http:fetch:googleapis.com` → one line: "Network access: youtube.com, googleapis.com"
`events:listen:X`, `events:listen:Y` → one line: "Subscribe to 2 hooks: X, Y" (only listed if \<=5 hooks; more get summarized)
`events:emit:X`, `events:emit:Y` → one line: "Emit 2 plugin-defined hooks: X, Y"
`roles:register:R1`, `roles:register:R2` → one line: "Register 2 roles: R1, R2"
`tasks:read` + `tasks:write` → one line: "Read and write your tasks" (read-only and read-write are different lines)

Worked example for a plugin declaring 26 capabilities (Papercup):

```
$ papercusp install papercup@0.0.1

papercup@0.0.1 requests these permissions:

HIGH-IMPACT:
✓ Read your tasks, features, goals, projects, and comments
✓ Write to your tasks, features, goals, projects, and comments

MEDIUM-IMPACT:
✓ Read and register routines
✓ Register 5 roles: orchestrator, worker, validator, documenter, curator
✓ Emit 4 plugin-defined hooks: directive-routed, proposal-accepted, budget-allocated, project-launched
✓ Subscribe to 2 hooks: market-signal, capability-released

LOW-IMPACT:
✓ Mount UI surfaces (dashboard tab, sidebar item, harness route)

Approve all? [Y/n/per-line]: y
```

The user makes seven decisions, not 26. The
underlying granted-capabilities.json still records all 26 — grouping
is purely a presentation concern.

### 10.7 Capability lifecycle and revocation

Capability state is read from an in-memory cache on every
method invocation through the DI proxy — never from disk on
the hot path. In the shipped operator the cache is per-host:
`state.grants` is a `Map<key, string[] | undefined>` keyed by
`(plugin, install)`, loaded once at plugin init from
Postgres (`plugin-host-runtime.ts`) and read O(1) per call. The
durable record-of-truth is Postgres —
`harness_shared.plugin_capability_grants` (the table originally landed
as Migration 051, now in `000-baseline.sql`), not a file. The CLI
consent flow (§10.3) still writes
`~/.papercusp/granted-capabilities.json`, but the operator treats that
file as a read-only legacy fallback for installs that
predate the PG store.

Revocation is not live in the running plugin. The
`state.grants` cache is invalidated only on a full plugin reload (the
same path that clears `initialized`); it is not re-read on a
revoke event. A revoke (`POST /api/plugins/grants` with
`action: 'revoke'` → `DELETE` from PG, §10.3) therefore does not
propagate to an already-running plugin until it reloads. The next
method call after a revoke uses the cached grant and does not
throw immediately — the new state takes effect on reload, not
mid-call.

How grants come to exist matters as much as how they're checked. At
operator boot, `backfillGrantsFromEnabledPluginsAndLegacyFile()`
replays the legacy file verbatim and silently grants every
`enabled-plugins.json` plugin its manifest-declared caps (system
grants, revocable later from the consent UI). When a harness is
forked, `copyGrantsToNewHarness()` copies the parent's grants to the
new install so the fork inherits its trust decisions instead of
degrading on first invocation.

```typescript
// Revocation runs through the HTTP route, not a CLI subcommand:
//   POST /api/plugins/grants { action: 'revoke', ... } → revokeCapabilities()
// Mid-session, while briefings has an open `api.tasks` reference:

const tasks = api.tasks;     // proxy reads the per-host state.grants cache
await tasks.list();          // ✓ if tasks:read in the cached grant set
// ... user revokes tasks:read (deletes the PG row) ...
await tasks.list();          // STILL ✓ — cache is unchanged until reload
// On next plugin reload the cache is rebuilt from PG; tasks:read now denied.
```

Plugins should still wrap DI calls in try/catch and degrade gracefully
— same pattern as a network call failing. The substrate will not
auto-pause a plugin on a revocation error; that's a routine-level
concern (§9.4).

The two-tier capability check

The load-bearing enforcement (gestured at by the §10.2 pseudocode) is
a two-tier AND in `hasCapability()`
(`plugin-loader/src/capabilities.ts`):

Tier 1 — manifest. The plugin's `capabilities[]`
must declare the cap (exact match or a wildcard pattern that covers
it). Fails → denied.

Tier 2 — user-granted set. The cached granted set
must also contain the cap (exact or wildcard). Both tiers must pass.

Legacy fallback. When the granted set is
`undefined` the host short-circuits to manifest-only (single-tier)
semantics and returns `true` after Tier 1. An empty PG result loads
as `undefined` (not `[]`), so a missing or never-run grant load does
not deny — it falls through to manifest-only. A real revoke
is expressed by deleting specific caps, never as an empty array.

Wildcard matching (`matchWildcardCap`) is what scopes `http:fetch` and
`secrets:read`: a declared `*.host` subdomain pattern matches any
`&lt;sub&gt;.host`, and a `head*` prefix pattern matches any resource
starting with the non-empty `head`. The prefix segment (e.g.
`http:fetch`) must match exactly, so a `*` cap can never cross
namespaces.

### 10.8 Capability changes across plugin updates

When an update finds capability changes in the new version, the
shipped substrate handles two change classes — add and remove —
computed by `netNewCapabilitiesSinceGrant()` /
`diffCapabilitiesSinceGrant()` in `cli/src/consent.ts` against the
most recent prior grant for the (slug, harness) pair:

ChangeSubstrate behaviour

Capability added
Prompt user for the new capability only (the diff). If denied, install runs at the old version's grants — plugin must check its granted set and degrade.

Capability removed
Dropped from the granted set; no prompt. Plugin no longer has (or needs) access.

Not implemented. The spec previously described three
further mechanisms that do not exist in the code and are future-state:

Capability rename via aliases. There is no
capability-rename alias mechanism. The only manifest `aliases` field
belongs to configSchema and handles config-field
schema-evolution rename/removal, not capabilities. A renamed cap is
seen as an add of the new name plus a remove of the old.

Major-version "clean slate" re-prompt. There is no
`1.x → 2.0` re-prompt-from-scratch path and no targetSdk-style reset;
updates always diff against the prior grant regardless of version.

Tier-escalation reapproval. Nothing detects a cap
moving from medium to high and forces re-consent; only add/remove
drive the prompt.
