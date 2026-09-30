# Spec: app-wide live-query convergence + generalized dock

Date: 2026-06-03
Author: Claude (autonomous run, authorized by the owner)
Status: **IN PROGRESS** — see Status Log at bottom.

> This doc is BOTH the design record AND the resumable execution checklist.
> Each phase has a task list with `[ ]`/`[x]`. On resume after a context
> reset, read the Status Log + the checkboxes to find where to continue.

## Context

The `/adv` "Create" tab (`?tab=plans`, `AdvShell.tsx:52` label "Create") is the
last surface on a legacy bespoke data path (`plans-api.ts` `useAsyncJson`: raw
`fetch` + per-call-site `useState`, no shared cache, manual `tick` refresh,
"No SSE/live-sync in v1"). The rest of the app (~75% of read sites) already
uses `@papercusp/sync`'s `useSyncQuery` — a transport-abstracted live-query
layer (Zero WS / SSE / TanStack-Query-backed polling) with a shared
`['sync', queryName, args]` cache and a server→client invalidation bus
(PG `LISTEN/NOTIFY` → SSE `invalidate`/`update` → `queryClient.invalidateQueries`).

We want ONE data layer, generalized into the shared lib, and the Create tab
moved onto our dock system (`app/harness/dock`, dockview) as free panels.

## Principles

1. **Data layer (`@papercusp/sync`) is UI-agnostic; dock/UI is data-agnostic.**
   They compose at the app level; neither imports the other.
2. **Lib owns mechanism; app owns content.** Lib ships dispatch, transports,
   cache, the PG LISTEN/NOTIFY adapter, route factories, and the dock
   close-guard seam. App supplies resolver *entries*, panel components, domain.
   The lib must stay drizzle-free / domain-free (resolvers are app-provided
   closures).
3. **Reuse, don't rebuild** — TanStack Query (via sync), the resolver-registry
   pattern, the NOTIFY bus, dockview. No new cache primitive.
4. **Pre-alpha** — migrate fully, delete the legacy `useAsyncJson` path, no
   back-compat shims.

## Architecture (the three layers)

- **Server contract**: tooldef (`defineTool`) — every read/write is a tool,
  projected to MCP/HTTP/IPC/in-process.
- **Live-query data layer**: `@papercusp/sync`
  - client (exists): `useSyncQuery({queryName,args}) → {data,loading,fetching,invalidate,error}`,
    transports (WS/SSE/polling), shared QueryClient, `['sync',name,args]` keyspace.
  - server (NEW, P0): named-query resolver registry + PG LISTEN/NOTIFY
    invalidation bus + REST/SSE route factories, all behind a `configure()` seam.
- **UI/dock layer**: `app/harness/dock` (dockview) — registry, layout, persistence,
  actions, nav; data-agnostic. Plus a NEW data-agnostic close-guard seam.

Key facts established by audit (2026-06-03):
- `sync-sse.ts` is ~80% generic; coupling = PG-LISTEN conn (`getHarnessAdminUrl`),
  NOTIFY channel `'sync_invalidate'`, the trigger→queryName bridge
  (`queryNamesForTriggerEvent` / `table-to-query-names.ts`).
- `sync-resolver/index.ts`: dispatch + registry STRUCTURE generic; the ~52
  entries are drizzle/`getOrgPg`-coupled → lib owns structure, app owns entries.
- REST/SSE routes (`endpoint-route/routes/zero-harness/{rest-query,rest-query-batch,sse}.ts`)
  are generic Web handlers; inject resolver + auth.
- `@papercusp/sync` is client-only today (`main: src/index.ts`, raw-TS workspace
  dep, no build). Server half ships as a separate entry `./server` so `pg`
  never enters the client bundle.
- Plans live as git Markdown (not PG) — fine: resolver reads files (like
  `plansDrafts.bySlug` already does); `plans:*` write tools call
  `notifySyncInvalidate(...)` explicitly. PG-NOTIFY is just the transport.

---

## P0 — Lift the sync server-half into `@papercusp/sync/server`

`@papercusp/sync` is a git submodule (`libs/generic/sync` → github.com/Papercusp/sync).
Edit there, commit on its main, bump the superproject pointer. Do NOT push.

### Lib modules (generic, no PG/drizzle dep)
- `src/server/query-registry.ts`
  - `type QueryEntry<A> = { argsSchema?: StandardSchema<A>; resolve(args:A): Promise<unknown[]> }`
  - `type QueryRegistry = Record<string, QueryEntry<any>>`
  - `const NAME_NOT_FOUND = Symbol(...)`
  - `createResolver(registry) => (name, args) => Promise<unknown[] | typeof NAME_NOT_FOUND>`
    (validate args via entry.argsSchema if present; else passthrough).
- `src/server/invalidation-bus.ts` — generic core of sync-sse:
  - ring buffer (`historyWindowMs`), dedupe (`dedupeWindowMs`), subscriber Set,
    `backfillSince(id)`, monotonic id.
  - `createInvalidationBus({ listen, notify, channel?, historyWindowMs?, dedupeWindowMs?, bridge? })`
    → `{ subscribe(send)→handle, backfillSince(id), notifyInvalidate(name,args?,data?), start(), stop() }`
  - `ListenSource = { start(onEvent:(raw:string)=>void): Promise<void>|void; stop(): void }`
  - `NotifySink = { notify(payloadJson:string): Promise<void> }`
  - `bridge?(triggerName:string): string[]` for PG-trigger→queryName synthesis.
  - 32KB payload-drop rule preserved; emit shape `{id,ts,name,args?,data?}`.
- `src/server/pg-adapter.ts` (sub-path export `./server/pg`) — postgres-js
  `ListenSource`/`NotifySink` factory `createPgListenSource({url,channel})` /
  `createPgNotifySink({sql,channel})`. Keeps `postgres` out of the bus core.
- `src/server/http-routes.ts` — framework-neutral factories returning
  `(req: Request) => Promise<Response>`: `createRestQueryHandler(resolver)`,
  `createRestBatchHandler(resolver)`, `createSseHandler(bus, sseLib)`.
  (gzip + error-envelope generic; auth injected by caller's wrapper.)
- `src/server/index.ts` — barrel. package.json `exports`: add
  `"./server": "./src/server/index.ts"` and `"./server/pg": "./src/server/pg-adapter.ts"`.
  peerDeps: `postgres` (optional, only for the pg sub-path), keep zod optional
  by accepting Standard Schema (reuse the validate helper shape).

### Operator rewiring (behavior-preserving)
- `apps/operator/lib/sync-server-config.ts` — builds the registry (existing
  `REGISTRY` from `sync-resolver` + later plans entries), PG `ListenSource`/
  `NotifySink` from `getHarnessAdminUrl`/`getOrgPg`, channel `'sync_invalidate'`,
  bridge = `queryNamesForTriggerEvent`. Calls `createInvalidationBus` +
  `createResolver`. Exports the singleton bus + resolver.
- `sync-sse.ts` → thin re-export of the bus instance; keep
  `notifySyncInvalidate`, `subscribe`, `backfillSince` names (every existing
  emitter untouched).
- `sync-resolver/index.ts` → keep the entries; `resolveNamedQueryV2 = createResolver(registry)`.
  Keep `knownQueryNamesV2`/`isRegisteredV2` for tests.
- 3 routes delegate to the lib handler factories (keep `defineTool` + auth).
- **Net behavior change: zero.** Existing harness panels prove the seam.

### P0 tasks
- [ ] sync submodule: add `src/server/query-registry.ts` + unit test
- [ ] sync submodule: add `src/server/invalidation-bus.ts` + unit test (ring/dedupe/backfill/bridge)
- [ ] sync submodule: add `src/server/pg-adapter.ts`
- [ ] sync submodule: add `src/server/http-routes.ts` + unit test
- [ ] sync submodule: `src/server/index.ts` barrel + package.json exports + peerDeps
- [ ] sync submodule: `npm test` green; commit on submodule main
- [ ] operator: `sync-server-config.ts`
- [ ] operator: rewire `sync-sse.ts` (re-export), `sync-resolver/index.ts` (createResolver)
- [ ] operator: rewire the 3 zero-harness routes to lib factories
- [ ] operator: `npm run test:affected` green; bump submodule pointer; commit superproject
- [ ] verify: operator boots, harness panels live-update, a notify round-trips (integration)

---

## P1 — Converge the Create tab (plans) onto `useSyncQuery`

### Server
- Add resolver entries (operator registry) wrapping existing plans server fns:
  `plans.list, plans.items, plans.attention, plans.search, plans.get,
   plans.revisions, plans.runs, plans.history, plans.lint, plans.lock`.
  Args schemas mirror current fetchers. Single-object reads return 1-elem arrays.
- Emit `notifySyncInvalidate` from `plans:*` write tools (set-status, set-content,
  set-now, add-item, add-decision, new, set-plan-status, start, pause, promote,
  set-priority, set-frontmatter): invalidate `plans.list`+`plans.items`+
  `plans.attention` (harness-scoped) and `plans.get`/`plans.revisions` (slug).
  Lock tools already emit — wire `plans.lock` too.

### Client
- Rewrite `plans-api.ts`: each `use*` becomes a `useSyncQuery` wrapper preserving
  the `AsyncResult<T>` shape (data/loading/error/refresh) so consumers don't all
  churn; `refresh()` → `invalidate()`; single-object reads unwrap `data[0]`.
- Delete `useAsyncJson`. Writes keep `useMutation`/`postJson`; drop manual refresh
  (server NOTIFY drives it; keep optimistic `invalidate()` for snappiness).
- Note `usePlanLock` can converge (locks emit invalidations).

### P1 tasks
- [ ] operator: add plans.* resolver entries + arg schemas + unit tests
- [ ] operator: emit notifySyncInvalidate from each plans:* write tool
- [ ] operator: rewrite plans-api.ts hooks → useSyncQuery; delete useAsyncJson
- [ ] operator: update consumers if return-shape changed; `test:affected` green
- [ ] verify: write→NOTIFY→refetch; two readers converge (integration)
- [ ] commit

---

## P2 — Dock-ify the Create tab (free panels) + generalized close-guard

### Panels (panelRegistry types `create:*`)
Decompose `PlansClient` into independent panels, each reading via `useSyncQuery`
(shared cache → no prop-drilling, no shared closure):
- `create:plans-list`, `create:inbox`, `create:preview`,
  `create:sessions-list`, `create:sessions-detail`, `create:plan-editor`
  (multi-instance via `openPanel`). Left rail dissolves → panel headers + AdvShell toolbar.
Selection/filters stay in nuqs (already). Cross-panel coherence = shared cache.

### Layout + mount
- `lib/dock-layouts.ts`: `defaultAdvCreateLayout()` + `adv-create:` branch in `getLayout`.
- `app/adv/.../AdvCreateDock.tsx` mirrors `HarnessesDock`; swap into
  `operator-vite/src/routes/adv/index.tsx` (replace `<PlansClient/>`).

### Close-guard (dock-side, data-agnostic)
- `app/harness/dock/close-guard.ts`: `registerCloseGuard(panelId, fn)` +
  injectable `confirmClose` (default `window.confirm`). Dock close path
  (`dock-actions.closePanel` / HarnessDock `onWillRemovePanel` if supported, else
  intercept) consults it. plan-editor registers a guard from its dirty state
  (replaces `leaveGuard`). Written domain-free to lift when the shell is extracted
  (shell extraction itself is OUT OF SCOPE here).

### P2 tasks
- [ ] close-guard seam + unit test
- [ ] panel components (6) reading via useSyncQuery
- [ ] defaultAdvCreateLayout + getLayout branch + AdvCreateDock
- [ ] swap adv/index.tsx mount; delete/retire PlansClient monolith
- [ ] `test:affected` green; e2e via tauri-agent-tools if desktop running
- [ ] commit

---

## P3 — Sweep remaining data loads onto sync

Each a small verified commit:
- [ ] operator-vite polling → useSyncQuery + resolvers: AdvNowRunning
      (agents+status), DiscordBadge, dogfood-substrate-health (frees 6-conn cap)
- [ ] ~7 vite one-shot fetches → useSyncQuery (projects/lite, insights, users,
      marketplace, plugin-runtime)
- [ ] design panes (4) → useSyncQuery (drop-in, already `['sync',...]`)
- [ ] useHarnessData hybrid → pure useSyncQuery (REST bootstrap → resolver)
- [ ] STAYS documented (mutations, SSE streams, auth/beforeLoad, PTY WS, health)
- [ ] commit

---

## Testing strategy
- Unit (vitest): all lib server modules (registry/dispatch, bus ring/dedupe/
  backfill/bridge, http factories), plans resolvers, close-guard.
- Integration (`npm run test:affected:integration`, testcontainers PG): notify
  round-trip; plans write→invalidate→refetch.
- `npm run test:affected` after every edit unit.
- e2e (tauri-agent-tools, per /internal/docs/testing/agent-e2e) only if the
  desktop is running; otherwise note live-verification pending.

## Risks / gotchas
- Shared multi-agent tree: commit ONLY my paths explicitly (other agents have
  uncommitted plan-docs + ORT wasm in the tree). Stay on `main`, don't push.
- `@papercusp/sync` is a submodule + shared with Restart: keep P0 ADDITIVE
  (new `./server` export; client surface unchanged) so Restart is unaffected.
  Commit in submodule, bump superproject pointer, don't push.
- No server hot-reload: server-side edits need a desktop reload to go live; rely
  on unit/integration tests for correctness, note live-verify pending.
- Named-dollar-quote / migrations: not expected here (no schema changes).

## Status Log
- 2026-06-03 01:2x — spec written; tasks #6–#9 created; coord intent declared;
  confirmed sync is a submodule (raw-TS, additive `./server` safe). Starting P0.
- 2026-06-03 ~02:00 — **P0 COMPLETE + committed.**
  - sync submodule commit `9c1a948` — `src/server/{query-registry,invalidation-bus,
    pg-adapter,http-routes,index}.ts` + tests; `package.json` exports `./server` +
    `./server/pg`. 44 lib tests pass. Lib is fully dependency-free (postgres + sse
    injected by host).
  - superproject commit `c08e39835` — operator rewired: `sync-sse.ts` builds the lib
    bus; `sync-resolver/index.ts` uses `createResolver` + re-exports NAME_NOT_FOUND;
    submodule pointer bumped. 108 sync-touching unit tests pass.
  - NOTE: the 3 zero-harness routes were left as thin operator wrappers (they consume
    the lib-backed resolver+bus); the lib SHIPS + tests route factories for new
    projects, operator adoption of them deferred as optional (low value/risk).
  - NOTE: pg-adapter parameterizes the NOTIFY channel (`pg_notify($1,$2)`); 2 notify
    tests updated to read payload at call-arg [2]. Behavior identical.
  - Live-verify (desktop SSE round-trip) PENDING — unit/behavior preserved; no server
    hot-reload, needs a desktop reload to exercise live.
  - Starting P1 (plans → useSyncQuery).
- 2026-06-03 ~03:00 — **P1 CORE COMPLETE + committed.**
  - server (commit `28fa22fe4`): 8 `plans.*` resolvers (list/items/attention/
    search/get/revisions/runs/lint) via shared `read-dispatch.ts` (callPlansRead
    over handleHttpToolRequest — same path as the admin route). Discovered the
    admin write path ALREADY fired `plans.*` invalidations; made items/attention/
    lint coarse (no args) so filter-fanned + per-harness subscriptions all refetch.
    50 resolver tests pass; the "every registered name dispatches" test now
    exercises the plans resolvers against the real tool host.
  - lib fix (sync commit `a9ca72e`) + client (commit `0524c0772`): the 4
    cross-cutting reads (list/items/attention/search) migrated to `useSyncQuery`
    via a `useSyncResource` adapter preserving the `AsyncResult` shape — shared
    cache + server-pushed invalidation replaces the `refreshItems()` fan-out
    (the thing blocking the P2 free-panel split). 191 plans-area tests pass;
    `tsc` clean for changed files (loosened `PgSqlLike` so postgres `Sql` fits).
  - **DEFERRED (judgment call, not blocking P2):** the editor-detail hooks
    `usePlan` / `usePlanRevisions` / `usePlanRuns` / `usePlanLint` stay on
    `useAsyncJson` for now — they feed the complex PlanDetail (+ `setData`
    optimistic usage) and are NOT the fan-out problem. Their resolvers
    (plans.get/revisions/runs/lint) ARE registered + ready, so migrating them is
    a low-risk follow-up. `usePlanHistory` (git, no resolver) + `usePlanLock`
    (legit polling per audit) stay bespoke.
  - Live desktop SSE round-trip verification PENDING (no server hot-reload).
  - Next: P2 foundations (close-guard seam, seed layout) → P3 safe sweeps →
    P2 PlansClient→panels decomposition (the big UI piece; needs desktop e2e).
- 2026-06-03 ~03:07 — **P2 FOUNDATIONS done + committed** (pending commit).
  - `app/harness/dock/close-guard.ts` (+ test, 6) — generic veto-before-close
    registry + injectable confirm. Standalone; wiring into the dock bridge +
    the plan-editor panel lands with the decomposition.
  - `lib/dock-layouts.ts` — `defaultAdvCreateLayout()` (option-B: inbox/plans/
    sessions tabs on the left, preview right; URL-scope-driven, no harnessSlug)
    + `adv-create` branch in `getLayout`. dock-layouts tests 27 pass.
  - **Risk decision for the big P2 piece:** I will build the panels + AdvCreateDock
    but NOT swap the operator-vite route mount (keep `<PlansClient/>` live) until
    it's verified on a running desktop — so the working Create tab can't break
    from a blind rewrite. The route swap is the one deferred line.
- 2026-06-03 ~03:11 — P1 reads migration extended: `usePlanRevisions` +
  `usePlanRuns` → `useSyncQuery` (commit `23eb4474f`). So 6 of the plan reads are
  now on the shared layer (list/items/attention/search/revisions/runs). STILL
  bespoke (documented, not blocking): `usePlan` (PlanDetail uses its `setData`),
  `usePlanLint` (custom tick hook), `usePlanHistory` (git; no resolver),
  `usePlanLock` (legit polling). Their resolvers (plans.get/lint) exist where
  applicable. **P1 essential goal MET.**
- 2026-06-03 ~03:10 — **LIVE-HOST FINDING:** the desktop IS running (Tauri pid
  ~228583 → :3070 Hono host pid ~774494, `tsx`, NO hot-reload) but the host
  PREDATES my edits → serves STALE server code. Confirmed: `rest-query?name=
  toastLog.recent` → 200 `{rows,version}` (transport OK); `name=plans.list` →
  `unknown queryName` (proves staleness, NOT a bug). **Decision: did NOT restart
  the user's live desktop** (tail risk of a broken desktop on wake > value, given
  test-level verification already covers the server path). To verify all server
  changes live: Ctrl+R the Tauri shell (or restart the :3070 host) — picks up the
  new resolvers + bus. Safe to do when the user is back.
- 2026-06-03 ~03:20 — **P2 CODE-COMPLETE + committed** (gated).
  - close-guard wired into the dock bridge close path (commit `f2a3e3d21`); 184
    dock tests pass.
  - `app/adv/create/`: `use-create-data.ts` (shared scope + plan-list maps +
    inbox derivation, lifted from PlansClient) + 5 panels (Inbox/Preview/
    PlansList/Sessions/PlanEditor) + `AdvCreateDock` (commit `<this>`).
    Typecheck clean for all adv/create/. Panels reuse PlansClient's proven
    sub-components verbatim via the shared hooks.
  - **Route NOT swapped** — operator-vite still mounts `<PlansClient/>`. The swap
    (one line in `apps/operator-vite/src/routes/adv/index.tsx`: `<PlansClient/>`
    → `<AdvCreateDock/>`) + live dock e2e are the remaining P2 step, gated on the
    desktop.

- 2026-06-03 ~03:25 — **⚠ ACTION NEEDED FROM USER: restart the dev-api host.**
  - The operator-vite watch-build rebuilt `dist` (03:18) AFTER the P1 client
    commit (03:01), so the live webview (`:3070`, built bundle `index-DepeCP_z.js`)
    is running my NEW client (useSyncQuery `plans.*`). The `:3070` host
    (`papercup-dev-api.service`, no hot-reload) is STALE (no `plans.*` resolvers).
    → the live Create tab's plan lists are EMPTY/degraded until the host restarts.
  - This is the normal "server has no hot-reload" dev state; the fix is the
    routine restart that activates my server changes anyway:
        `systemctl --user restart papercup-dev-api.service`
    (or restart the desktop dev stack). After it: new client + new server =
    consistent; Create tab works via PlansClient on the new resolvers.
  - I attempted the restart; it was correctly auto-denied (unattended shared-service
    restart needs explicit authorization). I did NOT work around it.

- **STOPPING the autonomous loop here (responsible blocked point).** P3 (sweeps)
  is DEFERRED: every P3 item is a client data-migration that the watch-build would
  auto-deploy live while the server stays stale (same skew as P1) — and I can't
  restart to verify it. P3 + the P2 route-swap + usePlan/usePlanLint migration
  should be done once the user is back + can restart/verify. Resume point for a
  future session: P3 sweeps (operator-vite polling, design panes, useHarnessData,
  one-shot fetches) + the one-line route swap, each verified live.
