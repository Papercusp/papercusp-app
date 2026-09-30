# Pitfalls
URL: /internal/docs/data-sync/pitfalls

Specific failure modes that have silently broken every panel in a schema. Read before debugging.

These are catalogued because each one cost real time. If a panel is
behaving wrong, work down this list before you start changing code.

:::note\[Some entries are zero-cache–era]
Zero / zero-cache / ZQL is on the retirement path — the shipping desktop app
uses **SSE-primary** sync (the operator sidecar pushes invalidate/update over
Postgres `LISTEN/NOTIFY`); **zero-cache is not run**. The zero-cache–specific
items below (publication membership, port collisions, replication slots, the
`SchemaVersionNotSupported` cache) are kept as historical reference. The
RichGrid / `useSyncQuery` / `rowProps` gotchas (#1, #4, #8) are current and
still apply.
:::

## 1. `render: (row) =>` instead of `render: ({ row }) =>`

**Symptom**: every cell in the column renders blank or shows
`[object Object]`.

**Why**: `ColumnDef.render` is called with a context object
`{ row, rowIndex, rowBg, isSelected }`, not the row itself. TypeScript
accepts both signatures because the context structurally satisfies many
row shapes. (Same gotcha applies to `rowProps` and `cellStyle`, which also
receive this ctx.)

**Fix**: destructure `{ row }` from the argument.

```ts
render: ({ row }) => row.name,   // ✓
render: (row) => row.name,       // ✗ row is the ctx; row.name is undefined
```

## 2. PG `TIMESTAMPTZ` declared as `string()` in Zero schema

**Symptom**: `SchemaVersionNotSupported` in `zero-cache` logs.
WebSocket dies. **Every panel using that schema goes blank.** Reload
doesn't help.

**Why**: Zero deserializes `TIMESTAMPTZ` as epoch-ms `number`. If the
schema declares it as `string()`, validation fails for every row and
the cache disconnects.

**Fix**: declare as `number()`.

```ts
ts: number(),   // ✓
ts: string(),   // ✗ — kills the WS for the whole schema
```

This has bitten us at least three times. **Always check the column type
before declaring a TIMESTAMPTZ field.**

> **Era note.** The type rule still holds today, but it's now enforced by the
> schema **generator**, not a hand-edited file: `libs/zero-harness/src/schema.ts`
> is auto-generated and maps `timestamp → number` in
> `libs/zero-harness/scripts/generate-schema.mjs`. The fix is to correct the
> Drizzle source type and regenerate — don't hand-edit `schema.ts`. The
> `SchemaVersionNotSupported` / WS-disconnect symptom above is zero-cache–era;
> with SSE-primary sync a type mismatch now surfaces through the SSE/REST path,
> not a WebSocket drop.

## 3. Two copies of `@rocicorp/zero` in the dep tree

**Symptom**: `Query does not implement QueryInternals` thrown from
every `useQuery` call.

**Why**: a sub-app declared `@rocicorp/zero` directly in its
`package.json` and npm hoisted it into `apps/<name>/node_modules`. The
panel's import resolves to the local copy; Zero's runtime resolves to
the workspace root copy. Two distinct module instances → instanceof
fails → `QueryInternals` mismatch.

**Fix**: symlink the inner copy to the workspace root.

```bash
cd apps/<name>
rm -rf node_modules/@rocicorp/zero
ln -s ../../../node_modules/@rocicorp/zero node_modules/@rocicorp/zero
```

Then preferably remove the direct dep from the sub-app's
`package.json` so the next `npm install` doesn't reintroduce it.

## 4. Legacy class with `display: grid` in `rowProps`

**Symptom**: cells render on top of each other; the whole grid looks
collapsed.

**Why**: `RichGrid` uses CSS Grid for its cell layout. If `rowProps`
returns a `className` that has its own `display: grid`, the two
grids fight.

**Fix**: override with inline `style: { display: 'block' }`. (`rowProps`
receives the cell-render ctx — destructure `{ row }` if you need it.)

```tsx
rowProps={({ row }) => ({
  className: 'h-issue',
  style: { display: 'block' },
})}
```

## 5. Schema change not reflected on clients

**Symptom**: you changed `schema.ts` (added a column, renamed one,
changed a type), restarted `zero-cache`, and clients still see the old
shape — or worse, throw `SchemaVersionNotSupported`.

**Why**: clients cache the schema and the cache wasn't invalidated.

> **Historical.** Older `@rocicorp/zero` carried an explicit `schemaVersion`
> constant you bumped on every change. The current schema
> (`libs/zero-harness/src/schema.ts` → `createSchema({ tables: [...] })`)
> has **no** `schemaVersion` field — that knob is gone. A change there is
> registered by adding/editing the table in the `tables` list and restarting
> zero-cache; if a stale shape persists, clear the client's cached schema.

## 6. Forgot to add the table to the Postgres publication

**Symptom**: the named query returns `[]` always, even though
`SELECT * FROM harness_<slug>.harness_<table>` shows rows.

**Why**: the table isn't in the `zero_harness` publication, so logical
replication isn't broadcasting it.

**Fix**:

```sql
ALTER PUBLICATION zero_harness ADD TABLE harness_<slug>.harness_<table>;
```

…then restart `zero-cache-harness` so it re-reads the publication
membership.

## 7. zero-cache port collisions

**Symptom**: zero-cache logs "address already in use" on `:4849` or
`:4850`.

**Why**: the shop zero-cache (different DB, different config) defaults
its change-streamer port to `ZERO_PORT + 1 = 4849`, which collides with
the harness zero-cache main port.

**Fix**: set `ZERO_CHANGE_STREAMER_PORT=4847` on the shop zero-cache
unit. The current allocation is:

| Port | Service                         |
| ---- | ------------------------------- |
| 4849 | harness zero-cache main         |
| 4850 | harness change-streamer         |
| 4847 | shop change-streamer (override) |

## 8. Sync hook outside the provider

**Symptom**: a panel using `useSyncQuery` shows no data and never loads —
`data` is `undefined`, `loading` is `false`. Or, if you used
`useSyncPrefetch` / `useSyncContext` instead, a thrown
`useSyncQuery must be used within a <SyncProvider>`.

**Why**: the component is mounted above the `SyncProvider` wrapper.
`useSyncQuery` is **tolerant** — outside a provider it returns
`{ data: undefined, loading: false, error: null }` instead of throwing (so
chrome rendered at the root layout doesn't crash). The throwing variants are
`useSyncContext` and `useSyncPrefetch`.

**Fix**: ensure your panel is mounted inside the provider tree. In the
operator the provider is `RootSyncProvider` (which wraps
`HarnessSyncProvider`), mounted near the root layout, so most components are
already inside it — see `apps/operator/app/_components/RootSyncProvider.tsx`.
In operator-vite it's mounted in `apps/operator-vite/src/routes/__root.tsx` as
the **outermost** data-layer provider — only the Radix `Tooltip.Provider` sits
above it, so ChromeShell, the sidebars, the dev rails, etc. are all inside.
That makes "above the provider" a rarely-hit safety net rather than a routine
case: confirm your panel is genuinely above it before assuming the empty-result
path. If a panel renders above it, hoist the provider or branch on the empty
result and supply your own fallback (REST poll, prefetch cache).

**Sibling gotcha**: `useSyncMutate` is provider-tolerant the same way. Outside a
provider there's no Zero client, so **every call silently takes the REST
fallback** — it never goes optimistic. A write that appears to "work" may never
be routed through Zero at all if the provider (or WS) is absent.

## 9. JSON ledger out of sync with PG

> **Historical.** The `apps/papercup` `projects` JSON-ledger and its
> file-writing accessor pair have been **removed**: `saveProjects()` no longer
> exists anywhere in non-retired source, and the projects surface it backed was
> retired. (A function literally named `loadProjects` still lives in
> `scripts/migrate-snapshots-to-pg.ts` — but it reads the harness registry
> `~/.restart-harness-projects.json`, a different artifact, not the retired
> ledger.) Kept as a cautionary pattern.

**Symptom**: a PG-backed accessor returns rows that don't match what the UI
shows (or vice versa).

**Why**: a "PG mirror" pattern where a JSON file is primary and PG is
best-effort — both were sources of truth and some code paths wrote to one
and not the other; the file always drifts ahead.

**Fix**: PG is canonical. Do not adopt the file-primary / PG-mirror pattern
for app-level state — go full PG (the storage-policy rule). If you must keep
a file authoritative for a real reason, drive every writer through one mirror
helper plus a backfill/drift-recovery script (see the cookbook's
*PG-mirrored filesystem store* recipe).

## 10. dev:web vs dev:operator confusion

> **Retired (2026-05-30).** `apps/web` (the `@papercup/web` public site) was moved to
> `_retired/papercup/` and dropped from the workspace; the `dev:web` script no longer
> exists. Kept for reference. The operator (`:3055`) is the **Vite** SPA — see the **Fix** note.

**Symptom**: edits to `apps/web/...` don't take effect after restart.

**Why**: `dev:web` serves `apps/web/.next/standalone/server.js`, **not**
a dev server. To see source changes you need `npm run build` (full
rebuild — never `npx next build`, which skips the static-asset copy).

**Fix**: rebuild apps/web. The operator (`:3055`) uses the **Vite** dev
server (`@papercusp/operator-vite`) and picks up source changes via HMR;
only the legacy `apps/web` Next standalone is the static-build outlier.

## 11. Replication slot stuck after DB rename

**Symptom**: `zero-cache-harness` won't start; logs show "replication
slot in use."

**Fix**:

```sql
SELECT pid, application_name FROM pg_stat_replication
  WHERE slot_name = 'zero_harness';
SELECT pg_terminate_backend(<pid>);
```

If `postgres_app` is the holder, restart it.

## 12. A fetch cap papering over a non-virtualized grid (and a lying count)

**Symptom**: a panel "only shows N rows" when more exist (e.g. the work-items
table capped at 300 of 404); a state/search filter mysteriously misses matches;
the header count reads like a total but is really the downloaded length.

**Why**: two coupled mistakes. (a) `<RichGrid rows={array}>` (legacy mode) mounts
**every** row as DOM, so a large set janks — and the usual "fix" is to cap the
fetch (`limit: 300`). On a local desktop app the data is already local, so the
cap is pure downside, and any client-side filter/search then runs over only the
truncated window. (b) The resolver returns a **bare array**, so the panel shows
`items.length` (the capped length) as the count.

**Fix**: virtualize instead of capping, and carry the true total.

* Render with [`VirtualGrid`](/internal/docs/data-sync/richgrid#virtualgrid-the-drop-in-for-large-grids)
  (owns the virtualizer + scroll element), then lift the cap and load the full
  local set.
* Carry the true total on `rows[0]._meta` via
  [`attachListMeta` / `readListTotal` / `listCountLabel`](/internal/docs/data-sync/richgrid#honest-counts-the-true-total-via-_meta)
  so the header shows `"N of TOTAL"`, never the downloaded length.

Reference: `WorkItemsPanel.tsx` + the `workItems.byHarness` resolver.

## 13. Expensive derived work on a sync-resolver read path

**Symptom**: a panel takes **seconds** to load in a *local desktop app* — and
worse, *unrelated* panels on the same screen stall with it. Measured on
`:3070`: `learning.soakReport` **27.3s**, `storage.usage` **20.0s**,
`plans.lint` **13.8s**, while pure DB reads on the same host were **3–20ms**.

**Why**: it is never Postgres. Each of those resolvers performed **expensive
derived work synchronously, on the user-facing read, per page load, uncached** —
a subprocess (`journalctl`), a recursive disk walk (`du`-style sizing), or a
full-corpus parse (linting every plan). `soakReport` was the worst case: a
host-global `journalctl` scan sat *inside* a per-pot fan-out, so \~12 hives meant
\~24 concurrent scans of a 1.2GB journal; one of the two calls was also missing
`-u <unit>`, so it walked **every** unit on the box — 25.97s to return 17 bytes.

**Amplifier (removed 2026-07-26 — kept here because the shape recurs)**:
`zero-harness/rest-query-batch` resolved with `Promise.all`, so the batch
response waited for the **slowest** query in it. One slow resolver held every
other panel in that batch hostage — which is why an unrelated rubrics panel felt
\~10s. That amplifier is **gone**: the client now issues one
`GET /rest-query` per query through a bounded concurrency gate
(`libs/generic/sync/src/transports/polling/query-fetcher.ts`), so a slow
resolver costs only its own panel. Do not read the "keep it out of a batch"
advice below as still actionable — there is no batch. The underlying rule
survives unchanged, and is now the *only* protection: **a slow resolver is slow
for the user who needs it**, and the fix is to make it fast, not to route around
it.

**Fix — precompute into Postgres; do not just cache.** A background routine
writes the derived rows; the resolver becomes a plain `SELECT`. This is
implemented: `harness_shared.derived_read_snapshots` + the producer registry in
`packages/operator-core/lib/derived-reads/`, refreshed by the
`system:precompute-derived-reads` routine. Measured on `:3170` after the change:

| query                 | before | after      |
| --------------------- | ------ | ---------- |
| `learning.soakReport` | 27.3s  | **0.091s** |
| `storage.usage`       | 20.0s  | **0.092s** |
| `plans.lint`          | 13.8s  | **0.130s** |

And the amplifier, measured directly at the time: a batch requesting all three
together returned in **0.54s**, where before it took as long as its slowest
member — over 27 seconds — because `Promise.all` waits for the last one. (The
batch endpoint has since been retired; see the amplifier note above.)

To add one: register a producer in `derived-reads/producers.ts` and make the
resolver `return readDerivedSnapshotRows('<key>')`. A read NEVER computes on a
miss — it returns the last snapshot (or empty, with a staleness marker) and lets
the routine fill it, because a compute-on-miss path reintroduces exactly the
cold-load stall this exists to remove.

**Two things the backfill exposed, both worth knowing:**

* The real compute costs are far higher than the read-path timings suggested —
  `storage.usage` takes **70s** and `plans.lint` **159s** when allowed to run to
  completion. The read path was silently truncating them (a wall-clock budget
  returning partial sizes). A cache would have been *worse* than useless here:
  the first user of every TTL window would have waited over a minute.

* `plans.lint` had been returning `[]` **forever**. The lint tool's all-plans
  branch returns a bounded summary with no `reports` field, while the resolver
  read `r?.reports ?? []` — so it linted 484 plans and threw the result away. A
  159-second computation producing a 5-byte payload is the kind of thing only a
  timing sweep finds.

* A cache still pays the **full cost on cold load**, so the first user of every
  TTL window eats the 27s. It is a stopgap, not the fix.

* More decisively: the **shipped desktop app runs embedded Postgres on hosts
  where `journalctl` does not exist at all** (no systemd on macOS; none in a
  bare container). A resolver that shells out to a host-only binary does not
  degrade — it *fails*, permanently, for every real user.

**Rules for any new sync query** (see
[named queries](/internal/docs/data-sync/named-queries)):

1. A resolver does **I/O against Postgres and nothing else**. No `child_process`,
   no recursive `fs` walk, no full-corpus parse.
2. Derived/aggregate values are **materialized by a scheduled routine** into a
   table the resolver reads. Push the cost to write-time, off the user's path.
3. Never assume host binaries (`journalctl`, `systemctl`, `du`, `git`) exist.
   The shipping target is a desktop app, not this dev box.
4. If a resolver is unavoidably slow, that is now *its own* panel's latency and
   nobody else's — the batch that used to spread it across the page is gone
   (2026-07-26). Make it fast anyway: it still occupies one of the client's
   bounded in-flight slots, and it is still a user waiting.

**The guard that keeps rule 1 true:**
`packages/operator-core/lib/sync-resolver/no-heavy-io-on-read-path.test.ts`
statically walks the resolver registry and fails if any directly-reached module
spawns a subprocess. When first written it found **six** more offenders below
the 12s bar (WI-5476); all are now resolved and it holds at **zero** known
offenders. Note the three treatments — not every hit is a precompute:

* **`storage.usage`, `plans.lint`, `learning.soakReport`, `dev.serviceHealth`,
  `dev.deployState`, `dev.gitPipelineHives`** → precomputed producers.
* **`adv-sessions`** → the read functions were pure Postgres; only sibling
  `wmctrl` window helpers spawned. Splitting them into `adv-session-windows.ts`
  took the subprocess off the read graph — no precompute needed. Watch for this:
  a module flagged by the guard may not spawn in the function the resolver calls.
* **`viewer-identity`, `featureTimeline.byFeature`** → deliberately allow-listed.
  The first is a per-viewer-*machine* `git config` read, module-cached to one
  spawn per process — precomputing it on the operator host would compute the
  wrong identity for a remote peer. The second is a click-to-open drill-down, not
  a page-load panel. Precompute is the wrong tool for both; the guard's ALLOW
  list documents why.

Reference: `packages/operator-core/lib/pot/soak-report.ts` (the fan-out +
missing `-u`), `lib/storage/usage.ts` (the disk walk, which mitigated with a
wall-clock budget rather than precompute), and WI-5460 / WI-5476 for the full
timing sweep of all 200 registered query names.
