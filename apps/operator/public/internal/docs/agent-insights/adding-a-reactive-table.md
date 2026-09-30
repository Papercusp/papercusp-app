# Adding a reactive table — the consolidated pattern
URL: /internal/docs/agent-insights/adding-a-reactive-table

How to make a new PG table push live updates to the UI. PG trigger → sync_invalidate → existing /api/zero-harness/sse → libs/sync invalidates the matching useSyncQuery.

:::caution\[Superseded — the trigger→camelCase bridge is now LIVE]
The section below titled **"Two name conventions exist — they don't talk to
each other yet"** is out of date. Its central forward-looking claim — that
PG-trigger `<schema>.<table>.changed` events are **"broadcast no-ops for
existing clients today"** and that a name-translator bridge is **"Bridge work
pending"** / a dormant safety net "until that lands" — no longer holds.

The **P-067 bridge shipped** (plan `papercusp-dogfood-v5-2026-05-23`). Current behavior:

* `packages/operator-core/lib/sync-sse.ts:49-51` constructs the invalidation bus
  with `bridge: (name) => queryNamesForTriggerEvent(name)`.
* `packages/operator-core/lib/sync-resolver/table-to-query-names.ts:189`
  exports `queryNamesForTriggerEvent`, backed by the reverse map `TABLE_TO_QUERY_NAMES`
  (e.g. `table-to-query-names.ts:43` maps
  `'harness_shared.harness_text_artifacts' → ['harnessTextArtifact.byHarness']`).

So a `harness_shared.harness_text_artifacts.changed` trigger event is **now
translated** into the camelCase `harnessTextArtifact.byHarness` name that
existing `useSyncQuery` consumers subscribe to. Trigger events are **no longer
inert for existing clients** — they reach the documented camelCase consumer
surface automatically. To add coverage for a new table, add its
`'<schema>.<table>' → ['camelCase.scope']` entry to `TABLE_TO_QUERY_NAMES`.

Two further point-in-time notes (not contradictions): the generic mechanism
now lives in `libs/generic/sync/src/server/invalidation-bus.ts`
(`@papercusp/sync/server`) — `sync-sse.ts` is operator wiring + re-export, but
still exports `notifySyncInvalidate` / `subscribe` / `backfillSince` /
`SyncEvent`, so the import examples below remain valid. And the 90-second
dedupe window is correct (`DEFAULT_DEDUPE_WINDOW_MS = 90_000`), distinct from
a separate 60s ring-buffer replay window (`DEFAULT_HISTORY_WINDOW_MS = 60_000`).

The recipe and payload contract below are otherwise still accurate — the
historical narrative is preserved as-is.
:::

## What

Papercusp's UI gets live updates from PG through **one channel, two
producers**:

```
  ┌──────────────────────┐
  │ Application code     │── notifySyncInvalidate(name, args, data?) ─┐
  └──────────────────────┘                                            │
                                                                      ▼
  ┌──────────────────────┐                              pg_notify('sync_invalidate', ...)
  │ PG trigger           │── emit_change_notify() ─────────┘          │
  │ (auto, every row)    │                                            │
  └──────────────────────┘                                            ▼
                            packages/operator-core/lib/sync-sse.ts → /api/zero-harness/sse
                                                                      ▼
                              libs/sync SSEAdapter → @tanstack/react-query
                                                                      ▼
                                                useSyncQuery refetches matching query
```

Both producers emit the same payload shape; consumers don't care
which fired. The 90-second dedupe window in `sync-sse.ts` collapses
identical `(name, args)` notifies — so an app-code notify followed
by a trigger-driven one for the same row hits the wire once.

## When to use which producer

| Choice                                                | Use it for                                                                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notifySyncInvalidate(name, args, data?)` in app code | Fine-grained, intentional notifies after a meaningful write. Optional `data` payload pushes the new rows directly, saving the client a refetch. Used by 20+ writers. |
| `emit_change_notify` PG trigger                       | Coarse, automatic, fires on EVERY INSERT/UPDATE/DELETE. Catches writes that bypass app code — raw SQL from migrations, MCP-tool direct writes, agent-direct edits.   |

You usually want **both**: app code fires the targeted notify on the
happy path; the trigger covers everything else.

## Recipe — add a reactive table

### Step 1: define the table

In a `libs/papercusp/libs/db/sql/NNN-<name>.sql` migration (≥ `107`).
**Update:** the old runtime-ensure path (`ensure-schema*.ts`,
lazy-`CREATE TABLE`) is **removed** — schema is migrations-only now
(`self-contained-migration-baseline-2026-06-02`). Add a migration; do
not add an `ensureXxx()`.

### Step 2: attach the trigger

```sql
CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE
  ON harness_shared.your_new_table
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
```

**Update:** the old runtime `wireDogfoodTriggers()` helper (in the
removed `ensure-schema-dogfood.ts`) is gone. The dogfood trigger wiring
now lives in a migration — `libs/papercusp/libs/db/sql/107-dogfood-reactivity-triggers.sql`
attaches `emit_change_notify` to the reactive tables. Add your new
table's `CREATE OR REPLACE TRIGGER` line to a migration alongside those.

Idempotent (`CREATE OR REPLACE TRIGGER` is PG 14+), so re-applying the
migration is safe.

### Step 3: in app code, also call `notifySyncInvalidate` after writes

After your route handler writes to the table:

```ts
import { notifySyncInvalidate } from '@papercusp/operator-core/lib/sync-sse';

// After the successful write:
void notifySyncInvalidate('your_table.changed', { workspace_id, op }).catch(() => {});
```

Best-effort — never let a notify failure break the write itself.

### Step 4: on the client, subscribe with `useSyncQuery`

```tsx
import { useSyncQuery } from '@papercusp/sync';

const { data, loading } = useSyncQuery<YourRow>({
  // ...
});
```

`useSyncQuery` reads the SSE invalidate stream and refetches whenever
a matching `name` arrives.

## Payload shape — never break this

Both producers emit on `sync_invalidate` channel with:

```json
{
  "name": "<event-name>",
  "args": { "workspace_id": "<id|null>", "op": "INSERT|UPDATE|DELETE" }
}
```

Consumers filter on `name`. The format is the established `SyncEvent`
contract in `packages/operator-core/lib/sync-sse.ts` — don't invent a parallel
channel; the trigger function was rewritten in commit `20609bb` to
stop doing exactly that (was emitting on a new `papercusp_changes`
channel; consolidated onto `sync_invalidate` for the 20+ existing
consumers).

### Two name conventions exist — they don't talk to each other yet

| Producer                                                | Name shape                 | Example                                                          |
| ------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------- |
| Application code via `notifySyncInvalidate(name, args)` | camelCase noun + scope     | `plans.list`, `toastLog.recent`, `harnessTextArtifact.byHarness` |
| PG trigger `emit_change_notify` (this insight's recipe) | `<schema>.<table>.changed` | `harness_shared.plan_runs.changed`                               |

Today's existing `useSyncQuery` consumers subscribe with `queryName:
'harnessTextArtifact.byHarness'` (camelCase). My PG-trigger events
fire with `harness_shared.harness_text_artifacts.changed` — clients
filter on name, see no match, refetch nothing. Trigger events are
**broadcast no-ops for existing clients today.**

**What this enables**: future code subscribing to
`<schema>.<table>.changed` (the catch-all name shape) gets free
coverage of any write to that table, including raw-SQL or
MCP-tool writes that app code never notified about.

**Bridge work pending**: a future item should add a translator —
"when `harness_shared.harness_text_artifacts.changed` arrives,
also invalidate any subscriber to `harnessTextArtifact.*`." That
ties the trigger producer to the existing consumer surface. Until
that lands, app-code `notifySyncInvalidate` calls remain the active
path for known consumers; the trigger is the dormant safety net.

## Verifying it works

Live test that brings its own embedded PG, no shared-state risk:

```bash
node apps/operator/scripts/verify-trigger-consolidation.mjs
```

Runs in \~2s. Asserts the trigger fires on INSERT/UPDATE/DELETE, the
payload shape is correct, the GUC workspace\_id is captured, and a
coexisting trigger on the same table doesn't block this one.

## Why it matters

Before the consolidation, agents were tempted to invent a new
channel per concern (e.g., a new `/api/sync/stream` endpoint for a
new feature). That fragments the SSE consumer surface (one EventSource
per channel — and browsers cap HTTP/1.1 connections per host at 6).
One channel + payload-filtered topic gives sub-second invalidation
across the whole UI without exhausting the connection pool. See the
[connection-pool insight](/internal/docs/agent-insights/webkit-connection-pool-exhaustion)
for the failure mode if you stack multiple long-lived connections.

## Related

* `packages/operator-core/lib/sync-sse.ts` — `notifySyncInvalidate` + `subscribe`
* `packages/operator-core/lib/endpoint-route/routes/zero-harness/sse.ts` — the SSE endpoint
* `libs/papercusp/libs/db/sql/000-baseline.sql` — the `emit_change_notify()` trigger function (originally `archive/078-emit-change-notify.sql`)
* `libs/papercusp/libs/db/sql/107-dogfood-reactivity-triggers.sql` — the trigger-attach migration (replaced the removed `wireDogfoodTriggers()` runtime helper)
* `apps/operator/scripts/verify-trigger-consolidation.mjs` — the live verifier
