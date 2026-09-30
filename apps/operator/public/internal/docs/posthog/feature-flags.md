# Feature flags
URL: /internal/docs/posthog/feature-flags

The complete feature-flag system — every flag, how to flip them, where they're enforced, the V1 ship contract, and the admin UI.

> **Webapp retired (2026-05-14).** Any `localhost:3055` or `localhost:3070` URL on this page is only reachable while the **Tauri dev shell** is running. Start it with `cd papercusp-desktop && npm run dev`.

Feature flags are how Papercusp ships V1 with a minimal feature set while keeping the cut features in the codebase, ready to re-enable. The cut-for-V1 flags default to **off**; flags created for newly built features default to **on** in alpha (finished work ships active — the flag is the owner's off-switch, not a dark launch). The operator falls back to bundled defaults when offline, and admins flip flags through the operator's own UI — no PostHog dashboard required for day-to-day use.

## The flag set

The canonical set lives in `FLAGS` in `libs/flags/src/types.ts`. As of this writing it holds **101 flags** (`FLAG_DEFAULTS` is **51 default-`true` / 50 default-`false`**) — the set grows continuously, so treat the live `FLAGS` object as authoritative, not this page.

The table below is a **representative slice** (roughly the original V1 cut-set + a few later additions), **not** the full set. The \~86 flags not shown here include the autonomy set (`QUEEN_AUTONOMY_ARMED`, `QUEEN_FULL_AUTONOMY`), `OVERWATCH`, `SCHEDULED_PLANS`, `LOOPS`, `WEDGE_AUTO_REAP`, `CLAUDE_CRED_SYNC`, `OPEN_SIGNUP`, `ENDPOINT_AUTH_TIERS`, the entire self-learning-frontier set, and the workspace-isolation set. Run `grep -E '"papercusp-' libs/flags/src/types.ts` for the complete list.

| Key                                    | TS constant                        | Default | What it gates                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ---------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `papercusp-cloudflare-publish`         | `FLAGS.CLOUDFLARE_PUBLISH`         | `false` | Publish-to-Cloudflare flow.                                                                                                                                                                                                                                                                                                                                                                            |
| `papercusp-harness-phases`             | `FLAGS.HARNESS_PHASES`             | `false` | Multi-phase harness (staging / testing / production) + the harness-tests Hono endpoints.                                                                                                                                                                                                                                                                                                               |
| `papercusp-design`                     | `FLAGS.DESIGN`                     | `false` | In-harness "design" tab + `/design` route + `/api/design/*` routes.                                                                                                                                                                                                                                                                                                                                    |
| `papercusp-testing`                    | `FLAGS.TESTING`                    | `false` | Testing-only surfaces: the `pi` tab + the "add plugin" button **and** the Oracle assistant (dock + `/settings/oracle` + all `/api/oracle/*` Hono endpoints, 404 when off). The separate `papercusp-oracle` key was folded into this one by owner ask (2026-06-10) — the Oracle is now a testing surface. The server even filters the retired `papercusp-oracle` key out of any stored PG override row. |
| `papercusp-inbox-durable-escalations`  | `FLAGS.INBOX_DURABLE_ESCALATIONS`  | `false` | Mirror chat decision cards to durable coord escalations (answer live or from the inbox).                                                                                                                                                                                                                                                                                                               |
| `papercusp-improvement-auto-implement` | `FLAGS.IMPROVEMENT_AUTO_IMPLEMENT` | `false` | Master switch for auto-implementing captured improvements. Off = capture + triage only.                                                                                                                                                                                                                                                                                                                |
| `papercusp-video-channels`             | `FLAGS.VIDEO_CHANNELS`             | `true`  | Desktop P2P video channel (the workbench `VideoGrid`). Owner-activated 2026-06-09 (alpha default-on policy); the live two-instance camera E2E is still outstanding.                                                                                                                                                                                                                                    |
| `papercusp-voice-channels`             | `FLAGS.VOICE_CHANNELS`             | `true`  | Desktop P2P voice-channel surface (`VoiceChannelPanel`). Owner-activated 2026-06-09; the supervised live Tauri+mic pass is still outstanding.                                                                                                                                                                                                                                                          |
| `papercusp-the-hive`                   | `FLAGS.THE_HIVE`                   | `true`  | Selects the active brand pack for the user-facing lexicon. On (default, owner-activated 2026-06-09) = the `the-hive` cup pack; off = `classic` Papercusp. Presentation only — code/DB/MCP are unchanged.                                                                                                                                                                                               |
| `papercusp-blueprint-aware-settings`   | `FLAGS.BLUEPRINT_AWARE_SETTINGS`   | `true`  | The schema-driven harness settings panel (`BlueprintSettingsPanel`) rendered from the blueprint's declared `params`. Off = the legacy `HarnessSettingsPanel`.                                                                                                                                                                                                                                          |
| `papercusp-prompt-studio`              | `FLAGS.PROMPT_STUDIO`              | `true`  | The Prompt Studio surface at `/settings/prompt-studio` (edit the playbook/persona prompt sources with a live assembled-prompt preview) **and** its `/api/prompt-studio/*` routes.                                                                                                                                                                                                                      |
| `papercusp-pot-agent-tabs`             | `FLAGS.HIVE_AGENT_TABS`            | `true`  | The unified agent-tabs dock (every agent surface as a real psu/Claude TUI session, per-agent wake-mode gate, per-type grouping). Off = the previous dock.                                                                                                                                                                                                                                              |
| `papercusp-inference-gateway`          | `FLAGS.INFERENCE_GATEWAY`          | `false` | Points every cup spawn's `ANTHROPIC_BASE_URL` at the localhost pacing gateway (`127.0.0.1:8788`) so the fleet egresses through one paced account. **Deliberately default-off** — hard-depends on the gateway service running; flip only after the deploy + load test pass.                                                                                                                             |

> `papercusp-templates` (`FLAGS.TEMPLATES`) and `papercusp-marketplace` (`FLAGS.MARKETPLACE`) were **retired** (`revive-cupboard-distribution` D-004): the legacy :3057 marketplace + `/templates` routes/UI are deleted; distribution now lives in the (ungated) Cupboard. `papercusp-snapshots` (`FLAGS.SNAPSHOTS`) was **retired** (`retire-snapshots-instance-spec` D-005): the harness-snapshot system + the Cupboard `kind=snapshot` path are gone; the reproducible clone is the ungated, lightweight `InstanceSpec` (`packages/operator-core/lib/instance-spec/`). Their keys no longer exist in `FLAGS`.

All keys also live in `libs/flags/src/types.ts` as the single source of truth — adding a new flag means editing **one file**, then creating the matching definition in PostHog. The TypeScript `FlagKey` type is derived from the object, so call sites get autocomplete and any rename is a compile error at every site.

## Defaults and the V1 ship contract

`FLAG_DEFAULTS` in `libs/flags/src/types.ts` is the bundled default state: cut-for-V1 flags are `false`; flags for newly shipped alpha features are `true` (see "Add a new flag" below). The operator returns this map whenever PostHog is unreachable or unconfigured: every cut feature stays cut, every shipped alpha feature stays live, no network call required to discover it.

Two statements that hold for every shipped binary:

1. A freshly installed Papercusp binary on Linux / macOS / Windows makes **zero** outbound HTTP requests to `flags.papercuspai.com` under normal use.
2. Every flag resolves to its `FLAG_DEFAULTS` value, so every cut surface (default `false`) is unreachable — routes 404, nav entries are absent, API routes return 404, Hono endpoints return 404, MCP tools are not registered — while shipped alpha features (default `true`) stay live.

Both hold without any post-install configuration. Verified by the build-agent handoff via a clean-machine smoke test.

### The `KNOWN_DARK_FLAGS` invariant

Under the alpha flags-default-on policy, a **newly added flag defaults to `true`** (finished work ships active). A flag may default to `false` only when it gates genuinely incomplete/unsafe work or an explicit owner-requested dark launch — and in that case it **must** be consciously listed in `KNOWN_DARK_FLAGS` in `libs/flags/src/production-defaults.test.ts`. The test asserts that every default-`false` flag is either in that allowlist or fails the build, and it also flags stale allowlist entries (a key listed as dark that no longer defaults to `false`) plus a review-by date guard so the dark set can't silently linger. This is why the split is currently 51 `true` / 50 `false`: each of those 50 is a deliberate, reviewed dark ship.

### Runtime overrides when PostHog is unconfigured

`FLAG_DEFAULTS` is the *bundled* fallback, but it isn't the only no-PostHog path. When the flag backend is unconfigured, both `flags:set` (MCP) and `POST /api/flags/set` fall back to a **Postgres-backed override store** (`setFlagOverride` / `loadStoredOverrides` in `libs/flags/src/server.ts`), reporting `backend: 'pg-override'`. This lets you toggle a flag at runtime on a dev box with no PostHog and no restart — a stored override **beats** the evaluated/default value (`stored beats evaluated`). The presets clear these: applying either preset calls `clearAllFlagOverrides()`, so the V1 ship state truly returns to the bundled defaults rather than leaving a stale PG override in place. (Overrides are filtered through `resolveWithDefaults`, so retired keys like `papercusp-oracle` can never leak back into a client payload.)

## The two-knob model

There are two things that need to be set to enable a feature for a user:

**Knob 1 — `testingFeatures` in `~/.papercusp/posthog.json`**

A single boolean. `true` → operator phones home to PostHog and reads live flag definitions. `false` (default) → operator never contacts PostHog and uses bundled defaults. This is the per-machine privacy toggle.

**Knob 2 — individual flag values in PostHog**

The actual per-flag on/off switches. Only consulted when `testingFeatures: true`. With `testingFeatures: false`, PostHog values are irrelevant; the operator never reads them.

Combined behavior:

| `testingFeatures` | PostHog value | Effective                 |
| ----------------- | ------------- | ------------------------- |
| `false` (default) | any           | `false` (bundled default) |
| `true`            | `false`       | `false`                   |
| `true`            | `true`        | `true`                    |

You can't get a flag to evaluate `true` without `testingFeatures: true`. That's the privacy moat.

## How to flip flags

### Through the admin UI

Open **Admin → Features** (`/admin/features`). You'll see:

1. **Preset row** — two one-click buttons:
   * **🚀 V1 Production** → sets `testingFeatures: false`. Operator stops contacting PostHog. Cuts stay cut. PostHog values are left untouched (irrelevant).
   * **🧪 Full testing** → sets `testingFeatures: true` + flips every flag in `ALL_FLAG_KEYS` to `active=true` with `rollout_percentage: 100`. Everything on.
2. **Master switch** — the `testingFeatures` toggle with a status pill (`on` / `off`) and its current source (`discovery-file`, `discovery-file-opt-out`, `env`, `unconfigured`).
3. **Per-flag toggles** — every flag in `ALL_FLAG_KEYS` listed with its raw key. Only the original V1 cut-set (\~11 flags) carries a friendly label + blurb, resolved through the lexicon (`flagLabels(t)` / `flagBlurbs(t)`); the remaining \~90 flags display their raw key (`labels[key] ?? key`). Toggles are disabled (greyed) when `testingFeatures` is off — turn that on first.

Every toggle round-trips through the operator's HTTP endpoints, which:

* Persist the change (discovery file for `testingFeatures`, PostHog API for individual flags)
* Invalidate the in-process PostHog config cache
* Re-init the flag backend if `testingFeatures` was just turned on
* Publish a `flag_changed` event on the in-process SSE bus

Other open tabs subscribed to `/api/flags/stream` reflect the change **instantly** — the admin endpoint calls `publishFlagChange()` on the in-process SSE bus before responding, which fans out to every connected tab.

### Through the PostHog UI

`https://flags.papercuspai.com` is the authoritative dashboard. Admins can flip flags, edit rollout percentages, target specific users/cohorts, view history. The operator's admin UI is a convenience layer over the PostHog API.

**Propagation when flipped directly in PostHog UI**: the operator's `posthog-node` SDK polls flag definitions every 10 seconds (`featureFlagsPollingInterval: 10_000`), so flips made outside the admin UI take up to \~10s to reflect. There's no upstream webhook from PostHog → operator: PostHog's REST-hooks system is Zapier-locked + deprecated, and its Hog-functions system only fires on analytics events (flag updates are activity-log entries, not events). 10s polling is the documented behavior; if you need instant flips, use `/admin/features`.

Use this when you need targeting (cohort A/B, gradual rollout) beyond the binary on/off the admin UI exposes.

### Through MCP

For agents:

| Tool         | Capability    | Action                                                                                                                                |
| ------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `flags:list` | `intel:read`  | Lists all flags with current values (mirrors `/api/flags/bootstrap`).                                                                 |
| `flags:get`  | `intel:read`  | Reads a single flag value.                                                                                                            |
| `flags:set`  | `audit:write` | Flips a flag in PostHog. Requires a `reason` arg (≥8 chars). Writes an audit row (`action='flag:set'`) in `harness_shared.audit_log`. |

All three are defined under `packages/operator-core/lib/agent-tools/flags/`. `flags:set` is exposed to the `operator` / `architect` roles; the read tools `flags:list` / `flags:get` are exposed more widely — to `operator`, `architect`, `debugger`, **and `cup`**.

`flags:set` runs with `profile: 'engineer'` and `crossWorkspace: true`: its only PG write is the no-workspace operator `audit_log` INSERT (on the admin handle), which is why it isn't a workspace-scoped RLS write.

`flags:set` writes both `active` and `filters.groups[].rollout_percentage` so the binary on/off semantics work as expected — see "Bug 1" in the [Wire-up gotchas](#wire-up-gotchas) section for why.

### Through env vars

For CI and ephemeral overrides:

| Env var                              | Effect                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `PAPERCUSP_POSTHOG_HOST`             | Override the host. Must be paired with `PAPERCUSP_POSTHOG_KEY`.                   |
| `PAPERCUSP_POSTHOG_KEY`              | Override the project key.                                                         |
| `PAPERCUSP_POSTHOG_PERSONAL_KEY`     | Override the personal API key. Defaults to `KEY` if not set.                      |
| `PAPERCUSP_POSTHOG_TESTING_FEATURES` | Set to `"true"` to flip the master switch on without touching the discovery file. |

Env vars are checked **before** the discovery file. They never get written into the desktop binary at build time — that would defeat the privacy contract.

There is also a **per-flag** dev override, independent of PostHog: `PAPERCUSP_FLAG_<KEY>=1` (or `=true`) flips a single flag on without configuring PostHog at all. The key is uppercased with `-`→`_` — e.g. `PAPERCUSP_FLAG_PAPERCUSP_DESIGN=1`. This override beats test overrides / PostHog / defaults and is applied to both the single-flag `getFlag()` path and the all-flags bootstrap payload (so `useFlag()` sees it too). Useful in dev for exercising a gated feature (e.g. running the Oracle, which gates on `papercusp-testing` — `PAPERCUSP_FLAG_PAPERCUSP_TESTING=1`) when PostHog isn't configured.

## How flags are enforced

Each cut feature has gating at multiple layers; the goal is that no path — direct URL, deep-link, command palette, API call, MCP tool — surfaces a cut feature when its flag is off.

### Route layer (TanStack Router, operator-vite SPA)

The operator frontend is the Vite SPA (Next.js is retired). Gated routes call `requireFlag(FLAGS.X)` in their `beforeLoad`; the helper (`apps/operator-vite/src/lib/require-flag.ts`) `loadFlags()`-then-`throw notFound()` if the flag is off, which renders the root route's `notFoundComponent`:

```tsx
// apps/operator-vite/src/routes/design/$slug.tsx
import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '../../lib/require-flag';

export const Route = createFileRoute('/design/$slug')({
  beforeLoad: () => requireFlag(FLAGS.DESIGN),
  component: DesignSlugPage,
});
```

`loadFlags()` is idempotent + cached in `@papercusp/flags/client`, so every gated route's `beforeLoad` shares a single fetch. (The old page-side `requireFlag()` was a Next Server-Component gate using `next/navigation`'s `notFound()`; it was removed with the Next→Vite migration — `finish-next-removal-2026-06-01`.)

### Nav layer

Nav / settings-sidebar entries are wrapped in `useFlag(FLAGS.X) && …`. `useFlag` comes from `@papercusp/flags/client` (a synchronous read of the cached bootstrap payload that re-renders on SSE flag-change events):

```tsx
import { useFlag } from '@papercusp/flags/client';
import { FLAGS } from '@papercusp/flags';

const designFlag = useFlag(FLAGS.DESIGN);
// …
{designFlag ? <DesignLauncher /> : null}
```

### Component layer (defense-in-depth)

Modal panels like `<DesignPanel>` use `useQueryState` for their open/closed state, so anyone can deep-link `?design=true` and trigger a render. The render conditions additionally check the flag:

```tsx
{showDesign && activeSlug && designEnabled && (
  <DesignPanel … />
)}
```

Command-palette entries that would open these panels are similarly gated:

```tsx
if (designEnabled) cs.push({ id: 'design', … });
```

### API route layer

API routes are now Hono `endpoint-route` handlers (`packages/operator-core/lib/endpoint-route/routes/**`), each authored with `defineTool({ method, path, … })`. The `gateApiRoute(req, key)` helper (`packages/operator-core/lib/require-flag.ts`) returns a 404 `Response` when the flag is off, or `null` to continue:

```ts
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '../../../require-flag';

async handler(req) {
  const blocked = await gateApiRoute(req, FLAGS.DESIGN);
  if (blocked) return blocked;
  // …handler logic…
}
```

For a whole route group (Oracle, harness tests), the gate is checked per handler against `getFlag(FLAGS.X, 'system')` and returns 404 when off (see `packages/operator-core/lib/endpoint-route/routes/oracle/index.ts`). Note the Oracle group gates on `FLAGS.TESTING` — the Oracle is dark unless `papercusp-testing` is on (the `papercusp-oracle` key was folded into `TESTING`, see the flag table above):

```ts
async function oracleEnabled(): Promise<boolean> {
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  return getFlag(FLAGS.TESTING, 'system');
}
```

### MCP tool layer

Each gated MCP tool checks the flag at registration time and at runtime. Tools that are off-gated don't register their schema; agents can't call what isn't there.

### Configuration

The single source of truth for which surfaces each flag gates is **not** documented in code comments — it's expressed in the gating itself. `grep -rln "FLAGS.DESIGN" apps/operator` is the canonical answer.

## File structure

The system lives in three places:

| Path                                                       | What                                                                                                                                                                                                                                |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/flags/`                                              | The package. Types + defaults (`src/types.ts`), server SDK wrapper (`src/server.ts`), client cache + `useFlag` (`src/client.ts`), test overrides (`src/test.ts`). Exported as `@papercusp/flags` (+ `/server`, `/client`, `/test`). |
| `packages/operator-core/lib/flag-bus.ts`                   | In-process pub/sub + boot-time backend init. Wraps the `@papercusp/sse` channel.                                                                                                                                                    |
| `packages/operator-core/lib/posthog-config.ts`             | Discovery-file resolver + `fs.watch` auto-reload. The env → file → unconfigured fallback lives here.                                                                                                                                |
| `packages/operator-core/lib/require-flag.ts`               | The server-side `gateApiRoute` helper used by Hono route handlers.                                                                                                                                                                  |
| `apps/operator-vite/src/lib/require-flag.ts`               | The SPA `requireFlag` (TanStack `beforeLoad` → `notFound()`).                                                                                                                                                                       |
| `packages/operator-core/lib/endpoint-route/routes/flags/*` | The Hono handlers: `bootstrap`, `stream`, `webhook`, `testing-features`, `set`, `preset`, `dashboard-url`.                                                                                                                          |
| `packages/operator-core/lib/agent-tools/flags/*`           | The MCP tools: `list`, `get`, `set`.                                                                                                                                                                                                |
| `apps/operator/app/admin/features/FeaturesAdmin.tsx`       | The admin UI component, mounted by the SPA route `apps/operator-vite/src/routes/admin/features.tsx`.                                                                                                                                |

## HTTP API

| Method + path                      | Body                                  | Returns                                                                                                                                                                |
| ---------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/flags/bootstrap`         | —                                     | `{ flags: { [key]: bool }, evaluatedAt, source }`. The client's main read endpoint.                                                                                    |
| `GET /api/flags/stream`            | —                                     | SSE stream of `flag_changed` events. Used by the React client to refresh after flips.                                                                                  |
| `POST /api/flags/webhook`          | PostHog webhook payload               | Auth header `X-Papercusp-Webhook-Secret`. Publishes a `flag_changed` event on the SSE bus.                                                                             |
| `GET /api/flags/testing-features`  | —                                     | `{ testingFeatures: bool, source }`                                                                                                                                    |
| `POST /api/flags/testing-features` | `{ enabled: bool }`                   | Writes the discovery file, resets the in-process config cache, re-inits the flag backend.                                                                              |
| `POST /api/flags/set`              | `{ key: FlagKey, enabled: bool }`     | PATCHes the flag in PostHog. Sets `active` + `rollout_percentage` (100 or 0).                                                                                          |
| `POST /api/flags/preset`           | `{ name: 'production' \| 'testing' }` | Atomic preset apply (loopback-guarded). `production` writes `testingFeatures: false`; `testing` sets `testingFeatures: true` + flips every flag in `ALL_FLAG_KEYS` on. |
| `GET /api/flags/dashboard-url`     | —                                     | Returns the PostHog UI URL for deep-linking out of the admin page.                                                                                                     |

All of these are Hono `endpoint-route` handlers (`packages/operator-core/lib/endpoint-route/routes/flags/*`) authored via `defineTool({ method, path, auth, … })` and served by the operator's bundled Hono host on `:3070`. They split across two declarative auth tiers:

* **`auth: 'public'`** — `bootstrap`, `stream`, `webhook`, `dashboard-url`, and the **GET** half of `testing-features`. "Public" opts the route out of principal auth; `webhook` then authenticates via the shared-secret header.
* **`auth: 'loopback'`** — the flag-mutating routes `set` and `preset`, plus the **POST** half of `testing-features`. This is the auth-tier Wave 1 declarative tier (`ENDPOINT_AUTH_TIERS`): loopback is enforced at the dispatch chokepoint (a non-loopback `Host` → 403), **not** by a hand-called `requireLoopbackOr403` in the handler body. The earlier in-handler `requireLoopbackOr403` sites were converted to the declared tier.

## How a flag flip propagates

```
1. User clicks toggle in /admin/features.
   └─> POST /api/flags/set { key, enabled }

2. Handler invokes setFlag(key, enabled) in @papercusp/flags/server.
   └─> GET  flags.papercuspai.com/api/projects/@current/feature_flags/?search=<key>
       PATCH flags.papercuspai.com/api/projects/@current/feature_flags/<id>/
       body: { active, filters.groups[0].rollout_percentage }

3. Handler publishes 'flag_changed' on the in-process flag bus.
   └─> SSE channel @papercusp/sse fan-out.

4. Every open tab connected to /api/flags/stream gets the event.
   └─> The client calls loadFlags() → GET /api/flags/bootstrap.

5. The operator's posthog-node SDK has its own 10s polling interval.
   Either the SDK's local cache is already fresh (rare — flips are
   pushed via the bus) or it refreshes on its next poll.

6. All useFlag() reads re-render via the client's flag-stream subscription.
```

End-to-end: a flag flip typically reflects in the UI within 1–2 seconds for client-rendered components, and on next navigation for server-rendered pages.

**If the flip came from PostHog UI directly** (not the admin UI), the operator skips steps 1–4 entirely and only learns about the change when its 10s SDK polling refreshes. The SSE fan-out is admin-UI-only.

## Discovery-file auto-reload

`packages/operator-core/lib/posthog-config.ts` installs an `fs.watch` on `~/.papercusp/`. Any write to `posthog.json` (manual edit, secret rotation, bin-helper script) invalidates the in-process config cache and triggers `reinitFlagBackend()`:

* If `testingFeatures` flipped on → the PostHog SDK is initialized (or re-initialized with the new key)
* If `testingFeatures` flipped off → the PostHog SDK is torn down; subsequent flag reads return `FLAG_DEFAULTS`
* Either way, a `flag_changed` SSE event is broadcast so connected tabs refetch

Net effect: edit the discovery file → operator picks it up within \~50ms, no restart needed.

## The admin UI architecture

The Admin section is structured as separate operator-vite SPA routes per tab (not in-page state):

* `/admin/features` → `<AdminShell title="Features"><FeaturesAdmin /></AdminShell>` — the flag console (`apps/operator-vite/src/routes/admin/features.tsx`; the `FeaturesAdmin` component still lives at `apps/operator/app/admin/features/FeaturesAdmin.tsx`, imported via the SPA's `@/app` alias).
* Sibling tabs (`/admin/git`, `/admin/dbos`, …) follow the same `<AdminShell>` pattern.

`AdminShell` is the chrome (header with title + tabs). Each tab is a TanStack `<Link>` so navigations are full route transitions; the URL is the source of truth for the active tab (no `useState`).

The `/admin/*` routes are intentionally not linked from the nav — reach them by URL. The flag-mutating endpoints behind them (`/api/flags/set`, `/api/flags/preset`) enforce loopback server-side via the declarative `auth: 'loopback'` tier (the `ENDPOINT_AUTH_TIERS` chokepoint), **not** an in-handler `requireLoopbackOr403` call; the route itself is **not** flag-gated (an earlier `FLAGS.ADMIN` gate was removed — and that key no longer exists in `FLAGS`).

## Wire-up gotchas

Three bugs surfaced during the initial wire-up that future contributors should know about. All are fixed in `main` but the explanations are worth keeping.

### Bug 1: `setFlag` only flipped `active`

PostHog flags have a hierarchical evaluation: `active` is the master switch, but `filters.groups[].rollout_percentage` decides which fraction of users see it. The original `setFlag` only PATCHed `active`. Flags were created with `rollout_percentage: 0`, so even `active: true` evaluated `false` for every user.

Fix: `setFlag` now PATCHes both `active` and `rollout_percentage` (100 when enabling, 0 when disabling). For binary on/off semantics that's correct; for gradual rollouts use the PostHog UI directly.

### Bug 2: SDK missing `personalApiKey`

`initFlagBackend` initially constructed the `posthog-node` client with only `projectKey` and `host`. Without `personalApiKey`, the SDK can't fetch flag definitions and falls back to remote evaluation (per-call `/flags/` endpoint hits, slower and different semantics).

Fix: pass `personalApiKey` + set `featureFlagsPollingInterval: 10_000`. The SDK now polls flag definitions every 10s and evaluates locally — sub-millisecond per call, no per-request network.

### Bug 3: One-shot `booted` latch in flag-bus

`packages/operator-core/lib/flag-bus.ts` had `let booted = false` at module scope, set to `true` after the first `bootIfNeeded()` call. The intent was "init the PostHog client once at startup." But if `testingFeatures` was off at startup and got flipped to `true` later, the latch had already fired, so no init ever happened.

Fix: added `reinitFlagBackend()` which the `testing-features` and `preset` endpoints call after writing the discovery file. The latch is now a debounce, not a guard against re-init.

## Testing

The flag system has a test override hook:

```ts
import { setFlagOverridesForTest } from '@papercusp/flags/test';

beforeEach(() => {
  setFlagOverridesForTest({
    [FLAGS.DESIGN]: true,
    [FLAGS.TESTING]: false,
  });
});
```

When overrides are set, the server's `getAllFlags()` returns them directly with `source: "override"`, bypassing PostHog entirely. Tests don't need to mock the SDK or run a real PostHog instance.

This is the live way to neutralize flag state in tests — consumers include `packages/operator-core/lib/lexicon/configure.test.ts`, the `@papercusp/flags` server suites, and `apps/operator/bin/host-spa.test.ts`. (`PAPERCUSP_FLAG_<KEY>` env overrides win over test overrides, so clear them if a test relies on the override map.)

## Common operations

### "Flip everything on for a dev session"

Admin → Features → **🧪 Full testing**. Or:

```bash
curl -X POST http://localhost:3055/api/flags/preset \
  -H 'content-type: application/json' \
  -d '{"name":"testing"}'
```

### "Go back to V1 ship state"

Admin → Features → **🚀 V1 Production**. Or:

```bash
curl -X POST http://localhost:3055/api/flags/preset \
  -H 'content-type: application/json' \
  -d '{"name":"production"}'
```

### "Verify the ship state on a freshly built binary"

```bash
# On a clean install, before any admin opt-in:
curl -s http://localhost:3055/api/flags/bootstrap | jq

# Expected: source="unconfigured", every flag at its FLAG_DEFAULTS value
# (cut-for-V1 flags false; alpha default-on flags true — see the table above)
```

### "Add a new flag"

1. Add the key + default to `libs/flags/src/types.ts` (`FLAGS` + `FLAG_DEFAULTS`). **In alpha, the `FLAG_DEFAULTS` entry for a flag you create alongside the feature is `true`** — finished work ships active; the flag exists so the owner can switch it off (or cut it for ship), not to ship the feature dark. Default `false` only for genuinely incomplete/unsafe work or an explicit owner-requested dark launch — and then surface the pending flip in the plan + completion report.
2. If you also define the flag in the PostHog UI at `flags.papercuspai.com`, match the bundled default (`active: true`, `rollout_percentage: 100` for an alpha default-on flag). Key must match the TS string exactly.
3. *(Optional)* Add a friendly label/blurb in `apps/operator/app/admin/features/FeaturesAdmin.tsx`. There are **no** `FLAG_LABELS`/`FLAG_BLURBS` constants — labels and blurbs are built at render through the lexicon-bound functions `flagLabels(t)` / `flagBlurbs(t)` (so the displayed names follow the active `THE_HIVE` brand pack). These cover only the original V1 cut-set (\~11 flags); every other flag falls back to its raw key in the admin per-flag list (`labels[key] ?? key`). Skipping this step just means your flag shows its raw key — the admin list still renders and toggles it.
4. Gate the actual surfaces — pages with `requireFlag`, nav entries with `useFlag`, API routes with `gateApiRoute`, MCP tools with the same.
5. `tsc --noEmit` on the operator to confirm no surface forgot the gate.

### "Discover what a flag gates"

```bash
grep -rln "FLAGS.DESIGN" apps/operator
```

The gating sites are the documentation.
