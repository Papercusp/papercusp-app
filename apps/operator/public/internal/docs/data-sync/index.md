# Data Sync overview
URL: /internal/docs/data-sync/index

How harness UI panels read from Postgres in real time via the SSE sync-resolver + RichGrid.

:::danger\[Zero is fully decommissioned, not merely retired]
Zero / zero-cache / ZQL named-queries is **gone from the tree** —
`zero-decommission-2026-06-20` (Z-2) removed `@rocicorp/zero` from every
`package.json`, deleted the `@papercusp/zero-harness` package
(`libs/zero-harness` no longer exists as a directory), and stripped the
Zero-specific transport out of `@papercusp/sync`. Zero repo-wide
`@rocicorp/zero` deps: **0**. The shipping desktop app uses **SSE-primary**
sync (the `:3070` Hono host pushes invalidate/update over Postgres
`LISTEN/NOTIFY` through the v2 sync-resolver registry, described below);
zero-cache is not run anywhere. Source of truth:
`apps/operator/providers/HarnessSyncProvider.tsx` (transport-selection
doc-comment) + the root `CLAUDE.md` deployment-model section. This page
describes the current (post-Zero) stack throughout.

**How SSE sync works today.** The `:3070` Hono host serves
`/api/zero-harness/sse`. `packages/operator-core/lib/sync-sse.ts` opens one
dedicated PG `LISTEN` on the `sync_invalidate` channel (on the embedded-PG admin
URL), fans each `pg_notify` out to subscribers, and bridges PG-trigger
`<schema>.<table>.changed` events to the camelCase query names via
`queryNamesForTriggerEvent` in `sync-resolver/table-to-query-names.ts`.

**Freshness, restated.** It is not the old \~50ms logical-replication push.
Each write fires an invalidate that pushes near-instantly to subscribers; the
worst-case staleness for an **unbridged** table is the 180s drift-repair tick
(`DEFAULT_SSE_DRIFT_REPAIR_MS` in `HarnessSyncProvider.tsx`), which is a repair
sweep, **not** a freshness source.

**Degraded fallback.** On sustained SSE failure, `SyncProvider`'s
`useTransportFallback` drops SSE → `POLLING` as a last resort. POLLING is
intentionally not the default: it re-fetches every subscribed query
(\~40 on the dashboard) each interval, saturating the browser's
6-connection-per-host HTTP/1.1 cap.
:::

import { Aside } from '@astrojs/starlight/components';

**For any new component that reads server state, default to
`useSyncQuery({queryName, args})` from `@papercusp/sync`.** Don't roll a
new `fetch + setInterval` poll. Don't open a raw `EventSource` for
query data.

The library is the single audited path: SSE/WS push, payload-on-
invalidate, REST refetch fallback, observability shim
(`window.__sync_metrics__`), reconnect resilience. Each parallel poll
or ad-hoc EventSource forks all of that and accumulates as drift.

**Genuine exceptions** (you may roll your own integration):

* **Streaming-by-nature payloads** — log tails, terminal output,
  command-runner progress, LLM token streams. These are byte streams,
  not query data; raw `EventSource` is the right tool. See the existing
  uses in `OperatorPanel`, `BranchActionRunner`, `ProvisionStream`,
  `PiPanel` (pty).
* **Pure UI timers** — `setNow(Date.now())` for relative-time refresh,
  `setInterval` for animation steps. No fetch, not data sync.
* **Mobile (`apps/operator-mobile/`)** — uses its own pure-HTTP +
  EventSource path with `usePolledList` and `sync-stream.ts` for
  per-device JWT scoping and battery-aware visibility pause. New mobile
  consumers stay on that pattern.

If you think you have another reason to bypass the library, **surface
it as a question first** instead of forking quietly. Drift here costs
real CPU, battery, and latency that the user only sees as "the app feels
sluggish."

**The migration template** (3-line summary):

1. **Read** — add a resolver entry in
   `packages/operator-core/lib/sync-resolver/index.ts` (the v2 registry):
   `'queryName.variant': { argsSchema, resolve }` returning a flat row array.
   Prefer the structured DB projection if one exists (e.g. read
   `harness_plans.items` jsonb rather than re-parsing markdown). There is no
   ZQL path anymore — `libs/zero-harness` doesn't exist.
2. **Write** — at the write site (the REST route / `defineTool` handler, or a
   watcher), fire `notifySyncInvalidate('queryName.variant', args)` from
   `packages/operator-core/lib/sync-sse.ts` after the write commits. For an
   optimistic write surface use `useSyncMutate('group.verb', restFallback)`;
   with no WebSocket/Zero client on the operator UI it always takes the REST
   fallback, and the invalidate above is what pushes the new state back to
   subscribers.
3. **Component** — `const { data } = useSyncQuery({queryName, args})`. Done.

Full recipe in the [Cookbook](/internal/docs/data-sync/cookbook); the v2
registry's per-entry recipe is in the
[adding-a-sync-query](/internal/docs/agent-insights/adding-a-sync-query) insight.

## What this section covers

This is a reference for agents and humans building UI panels in the harness
operator (`apps/operator/app/harness/`). Read this **before** you wire a new
panel to data.

The stack is two layered conventions, not a single library:

1. **The sync-resolver + SSE push** — Postgres is the source of truth. The
   v2 registry (`packages/operator-core/lib/sync-resolver/index.ts`) resolves
   named queries; `sync-sse.ts` LISTENs on `sync_invalidate` and pushes
   invalidations to subscribers over Server-Sent Events. Clients call
   `useSyncQuery(...)` and refetch when the query's name/args are
   invalidated — no manual polling loop to write.
2. **RichGrid** (`@papercusp/grid-core`, mirrored at
   `Papercusp/papergrid`) — the column-driven grid renderer every tabular
   panel uses. It is a DOM / CSS-grid renderer that virtualizes via
   `@tanstack/virtual-core` (its sibling `DataGridShell` is the canvas
   glide-data-grid one). It accepts plain rows + a `ColumnDef[]`, handles
   sorting, row click, row styling, and (optionally) virtual rendering. It does
   **not** know about the sync layer — the panel passes `useSyncQuery`'s rows
   as the `rows` prop.

These two are intentionally orthogonal:

* A panel can use **sync without RichGrid** (e.g. card or feed UX).
* A panel can use **RichGrid without sync** (e.g. data that comes from a
  one-shot REST call — `ProjectsList` at
  `apps/operator/app/harness/[slug]/projects/`).
* The default for a new tabular panel that displays Postgres-backed data
  is **both**.

## Why this exists

Before this stack was in place, every panel had its own list-rendering
code (a `<table>` or a `.map()` over `<div>`s), its own polling loop, its
own optimistic-update logic, and its own bug about "stale data after a
mutation." Migrating to RichGrid + the sync library collapses all of that
into:

```tsx
const { data: rows } = useSyncQuery<SnapshotRow>({ queryName: 'snapshotsConsolidated.bySlug', args: { harnessSlug: slug } });
return <RichGrid rows={rows ?? []} columns={columns} getRowId={s => s.id} inline />;
```

Mutations write directly to Postgres (via a normal `POST /api/...` route).
Freshness is invalidate-driven: each write fires a `sync_invalidate` notify
that pushes near-instantly to subscribers, and an unbridged table's
worst-case staleness is the 180s drift-repair tick (see the banner above),
which is a repair sweep, not the normal freshness path.

## Where each piece lives

| Concern                                | Package                  | Path                                                               |
| -------------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| RichGrid component + `ColumnDef` types | `@papercusp/grid-core`   | `libs/generic/papergrid/grid-core/src/RichGrid.tsx`                |
| Named-query registry (v2 resolver)     | `packages/operator-core` | `packages/operator-core/lib/sync-resolver/index.ts`                |
| PG-trigger → query-name bridge         | `packages/operator-core` | `packages/operator-core/lib/sync-resolver/table-to-query-names.ts` |
| Sync hooks (`useSyncQuery`, …)         | `@papercusp/sync`        | `libs/generic/sync/src/SyncContext.ts`                             |
| SSE wiring (LISTEN, invalidate bus)    | `packages/operator-core` | `packages/operator-core/lib/sync-sse.ts`                           |
| Sync provider for harness app          | local                    | `apps/operator/providers/HarnessSyncProvider.tsx`                  |
| Postgres database                      | server                   | `papercusp` DB on `:5432`                                          |

## Reading order for new contributors

1. [RichGrid](/internal/docs/data-sync/richgrid) — the renderer; learn this first
   because it's the smaller, self-contained surface.
2. [Named queries](/internal/docs/data-sync/named-queries) — the v2 registry: how
   a row in Postgres becomes a row in your component, and how to add a new query
   to the shared catalog.
3. [Schema conventions](/internal/docs/data-sync/schema) — per-harness Postgres
   schemas, `harness_shared` cross-harness views.
4. [Pitfalls](/internal/docs/data-sync/pitfalls) — non-obvious issues that have
   silently broken every panel in a schema. Read this before debugging.
5. [Cookbook](/internal/docs/data-sync/cookbook) — copy-paste recipes for the most
   common panel-building tasks.

## Source-of-truth files

When the docs and the code disagree, the code wins. The docs are kept in
sync best-effort, but the canonical references are:

* `libs/generic/papergrid/grid-core/src/RichGrid.tsx` — props, `ColumnDef` shape
* `packages/operator-core/lib/sync-resolver/index.ts` — every query name and its
  `argsSchema`/`resolve` (`knownQueryNamesV2()` enumerates them)
* `packages/operator-core/lib/sync-resolver/table-to-query-names.ts` — which
  Postgres table backs which query name, for the PG-trigger invalidation bridge
* `apps/operator/app/adv/harnesses/useHarnessData.ts` — a live consumer
  reading the consolidated queries via `useSyncQuery` (`featuresConsolidated.bySlug`,
  `issuesConsolidated.bySlug`, `agentRunsConsolidated.bySlug`)
