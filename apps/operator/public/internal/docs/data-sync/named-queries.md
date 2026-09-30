# Named queries
URL: /internal/docs/data-sync/named-queries

The shared catalog of queries every panel reads from.

:::danger\[Zero is fully decommissioned — this page is historical reference only]
The Zero / zero-cache / ZQL named-queries / WebSocket-push stack described below
is **gone, not just retiring**: `zero-decommission-2026-06-20` (Z-2) removed
`@rocicorp/zero` from every `package.json`, deleted the `@papercusp/zero-harness`
package (`libs/zero-harness` — the directory itself no longer exists in the
tree), and stripped the Zero-specific WS transport out of `@papercusp/sync`.
Zero-repo-wide `@rocicorp/zero` deps: **0**. The shipping desktop app uses
**SSE-primary** sync (the `:3070` Hono host pushes invalidate/update over
Postgres `LISTEN/NOTIFY` through the v2 sync-resolver registry described
below); zero-cache is not run anywhere. Source of truth:
`apps/operator/providers/HarnessSyncProvider.tsx` (transport-selection
doc-comment), the root `CLAUDE.md` deployment-model section, and
[Adding a query to the Zero-free sync resolver](/internal/docs/agent-insights/adding-a-sync-query)
for the current, authoritative recipe. The "Query does not implement
QueryInternals" section further down describes an error that **cannot recur**
— it is kept only so an agent that finds an old comment/plan mentioning it
isn't left guessing what it meant.
:::

## Why named queries

Every panel read the harness UI does goes through one **named query** —
`useSyncQuery({ queryName, args })` — resolved against a single registry, so
"what does the harness sync from Postgres?" always has one answer: open the
registry. That principle survived the Zero decommission unchanged; only the
registry's *shape* changed.

Today the registry is
`REGISTRY` in `packages/operator-core/lib/sync-resolver/index.ts` (the "v2"
resolver) — a flat `Record<string, QueryEntry>` (152 entries as of 2026-07-04) keyed by a **dotted string name** (`'featuresConsolidated.bySlug'`,
`'snapshotsConsolidated.bySlug'`, `'storage.usage'`, …), each entry pairing
a Zod `argsSchema` with an async `resolve(args)` that runs a normal
drizzle/PG query and returns a flat row array. There is no `defineQueries`
namespace object, no ZQL, and no separate `schema.ts`/publication step — a
dotted name is just a registry key, and adding one is a \~15 LOC addition to
that one file. **Full recipe, key points, and gotchas:**
[Adding a query to the Zero-free sync resolver](/internal/docs/agent-insights/adding-a-sync-query) —
this page won't duplicate it.

## The current catalog

`knownQueryNamesV2()` (same file) enumerates every registered name — that's
the canonical list; don't trust an inline copy here to stay in sync with it.
The four core per-harness entities are still slug-agnostic consolidated
tables in `harness_shared`, each read by a `.bySlug` query keyed on
`harnessSlug` (a column, not a schema name):

| Query                                                              | Returns          | Args              |
| ------------------------------------------------------------------ | ---------------- | ----------------- |
| `featuresConsolidated.bySlug`                                      | `FeatureRow[]`   | `{ harnessSlug }` |
| `issuesConsolidated.bySlug`                                        | `IssueRow[]`     | `{ harnessSlug }` |
| `agentRunsConsolidated.bySlug` (or `agentRunsConsolidated.recent`) | `AgentRunRow[]`  | `{ harnessSlug }` |
| `snapshotsConsolidated.bySlug`                                     | `SnapshotRow[]`  | `{ harnessSlug }` |
| `harnessProjects.lite`                                             | `ProjectRow[]`   | (none)            |
| `harnessWorkspaces.byHarness`                                      | `WorkspaceRow[]` | `{ harnessSlug }` |

`featuresConsolidated` also carries `featuresConsolidated.byHive` (cross-member browse, WI-259 P-006/D-010) and `featuresConsolidated.byPlanSlug`.

The doc text claiming a `needsReview` variant, a `bySourcePlan` form, or an `all` form is drift —
those queries do not exist in the registry. Adding a new harness still doesn't add a query — the slug
is a regular row value, not a schema name.

## Adding a new named query

See the full recipe (schema check, registry entry shape, the P-067 PG-trigger
bridge, the test-count-assertion gotcha, verification) at
[Adding a query to the Zero-free sync resolver](/internal/docs/agent-insights/adding-a-sync-query).
In short, an entry in `REGISTRY` looks like:

```ts
// packages/operator-core/lib/sync-resolver/index.ts
'myNewThing.bySlug': {
  argsSchema: z.object({ harnessSlug: z.string() }),
  resolve: async (args) => {
    const { harnessSlug } = args as { harnessSlug: string };
    const { getOrgPg, generated } = await import('@papercusp/db-org');
    const { eq } = await import('drizzle-orm');
    const { db } = getOrgPg();
    return (await db.select().from(generated.myNewThing)
      .where(eq(generated.myNewThing.harnessSlug, harnessSlug))) as unknown[];
  },
},
```

Then in your panel, read it through the `@papercusp/sync` wrapper. The
`useSyncQuery` hook is exported from `@papercusp/sync` (the package lives
at `libs/generic/sync`) and is transport-agnostic — it resolves
`queryName` + `args` through whichever adapter is active:

```tsx
const { data: rows } = useSyncQuery<MyNewThingRow>({
  queryName: 'myNewThing.bySlug',
  args: { harnessSlug: slug },
});
```

The same generic (`libs/generic/sync`) package also exports the companion
write hook `useSyncMutate(path, restFallback)` and `useSyncPrefetch()`. On the
operator harness UI (SSE transport, no WebSocket client) `useSyncMutate`
always takes the `restFallback` — it exists so a call site can adopt the same
API a `WEBSOCKETS`-transport consumer of the generic package would use
(elsewhere in the monorepo) without a behavior difference on SSE/polling.
`useSyncPrefetch()` warms the cache so a later `useSyncQuery` for the same
`queryName` + `args` resolves instantly.

You also need the PG-trigger bridge entry so writes that bypass app code
(raw SQL, MCP-tool writes, migrations) still invalidate the query: add
`'harness_shared.your_table': ['myNewThing.bySlug']` to `TABLE_TO_QUERY_NAMES`
in `packages/operator-core/lib/sync-resolver/table-to-query-names.ts` — see
[Adding a query to the Zero-free sync resolver](/internal/docs/agent-insights/adding-a-sync-query)
Step 3. Skip it and the query still works for app-code writes (which call
`notifySyncInvalidate` directly) but silently misses out-of-band ones.

:::note
A subtler silent-empty case: `useSyncQuery` rendered **outside** a
`<SyncProvider>` does not throw — it returns
`{ data: undefined, loading: false, error: null }` (with a stale flag),
by design, so panels mounted in app chrome above `/harness/*` don't crash.
An unwrapped panel therefore shows no data with no error. If you need live
data outside a provider, branch on the result and supply your own fallback.
:::

## "Query does not implement QueryInternals" (Zero-era, historical)

This error meant the panel's `@rocicorp/zero` package and the one Zero
instantiated against were different copies, thrown from every `useQuery`
call. It cannot recur — `@rocicorp/zero` has zero `package.json` references
left anywhere in the repo (`zero-decommission-2026-06-20` Z-2) — but it's
left here in case an old comment, plan, or search result references it and
an agent needs to know it's inert history, not a live failure mode to
reproduce or guard against.

## Cross-harness queries (consolidated tables)

`harness_features_consolidated` is the **canonical** base table in
`harness_shared` — writers target it directly. The data-flow direction was
inverted across two migrations:

* **Migration 029** made the consolidated table the source of truth. It had
  started life as a trigger-mirrored copy of the per-harness
  `harness_features` tables (writers pumped into per-harness, a trigger
  fanned out into consolidated), but 029 flipped that so writes go straight
  to the consolidated table.
* **Migration 032** dropped the per-harness physical tables entirely and
  replaced each with an auto-updatable `VIEW` over the consolidated table,
  filtered by `harness_slug` (`WITH CHECK OPTION` so a write can't land
  under the wrong slug). The fan-in trigger functions
  (`sync_features_consolidated()`, `sync_issues_consolidated()`,
  `sync_agent_runs_consolidated()`, `sync_snapshots_consolidated()`) were
  dropped at the same time. The same inversion applies to the other three
  consolidated entities (`harness_issues` / `agent_runs` /
  `harness_snapshots`).

So a per-harness read still works (it goes through the view), but the
canonical store everything resolves against is the single consolidated base
table.

Why a base table and not a Postgres view at the top? The PG trigger that
drives invalidation (`emit_change_notify`, the bridge behind
`TABLE_TO_QUERY_NAMES`) fires on the underlying relation's row-level
INSERT/UPDATE/DELETE; an auto-updatable view's writes execute against that
same underlying relation, so a trigger on the base table still sees them —
but a view is not itself a relation a trigger can attach row-level logic to
directly. Historically this table-not-view split was **also** required
because Zero's logical-replication publications couldn't include views; that
constraint is gone along with Zero, but the trigger-attachment reason still
holds on its own, so the architecture is unchanged.

The cross-harness `/features` page reads from the consolidated table via the
`featuresConsolidated.byHive` named query. Earlier versions of this page
claimed an all-features query existed; that was drift.

If you need another cross-harness aggregation, the recipe is:

1. Add a canonical base table in `harness_shared` and have writers target
   it directly (optionally expose per-harness views over it, filtered by
   `harness_slug`, rather than fanning in via triggers).
2. Register the table in `TABLE_TO_QUERY_NAMES`
   (`table-to-query-names.ts`) so out-of-band writes still invalidate.
3. Register a named query with no slug arg (an `.all`-style query) in the
   v2 registry.
