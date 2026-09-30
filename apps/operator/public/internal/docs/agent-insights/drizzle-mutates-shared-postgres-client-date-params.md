# drizzle() mutates the shared postgres-js client — raw Date params throw, and silent catches zero your instrument
URL: /internal/docs/agent-insights/drizzle-mutates-shared-postgres-client-date-params

EI-13076: drizzle-orm's postgres-js driver overwrites the shared client's date-OID serializers with a transparent passthrough; any raw sql`…${aDate}` then throws Buffer.byteLength(Date). Fixed by sticky hybrid serializers in buildClient — but know the trap and its detection signature.

## The symptom signatures

1. **The loud form:** a raw tagged-template query on a canonical client
   (`getOrgPg().sql`, `getHarnessPg(slug).sql`) with a JS `Date` parameter throws:

   ```
   TypeError: The "string" argument must be of type string or an instance of
   Buffer or ArrayBuffer. Received an instance of Date
   ```

2. **The silent form (the one that hid for weeks):** the same query wrapped in
   `.catch(() => fallback)` — the instrument it feeds reads as permanently
   zero/empty with NO error anywhere. Detection signature: a metrics table where a
   derived-from-the-query column has NEVER been non-zero/non-null across its whole
   history (`pot_throughput_ticks.placements` was 0 on all 22,396 ticks — EI-13076),
   while sibling columns fed by OTHER queries look healthy.

## The mechanism

`drizzle(client)` (drizzle-orm/postgres-js `driver.js`) **mutates the client it
wraps**: it overwrites `client.options.parsers[oid]` and
`client.options.serializers[oid]` with a transparent `(val) => val` for the
date/time OIDs (`1184, 1082, 1083, 1114, 1182, 1185, 1115, 1231`) plus json
(`114, 3802`) — so its own pre-stringified params pass through unmangled.

Our canonical clients are SHARED between drizzle and raw `sql` callers, so the
mutation breaks every raw caller passing a `Date`: postgres-js looks up
`serializers[1184]`, gets the passthrough, and hands the raw `Date` to
`Buffer.byteLength` → throw.

Two aggravations:

* **Runtime re-mutation:** `drizzle(tx)` is called on transaction handles at
  runtime (operator-audit, agent-mcp tools, dev/table-rows, …). A postgres-js tx
  handle shares the parent client's `options` object, so each of those calls
  re-installs the transparent serializers. A boot-time-only fix gets re-broken.
* **String params were always fine** — only `Date` instances trip it, so a query
  "works in dev:pg\_query / psql / a hand-built client" while failing on the
  canonical one. Isolate by diffing the CLIENT, not the SQL.

## The fix (in place since 2026-07-16)

`restoreRawDateSerializers()` in `libs/papercusp/libs/db/src/connection.ts`,
called by `buildClient` on every canonical client: installs HYBRID serializers
(`Date` → ISO string; anything else passes through, so drizzle's pre-stringified
params keep working) as **sticky accessor properties** — the setter is a no-op,
so drizzle's later plain assignments can't re-break them. Parsers are left as
drizzle sets them (raw reads return timestamps as STRINGS — code should keep
tolerating `string | Date`).

Recurrence guard: `libs/papercusp/libs/db/src/connection-date-serializers.test.ts`.

## Rules to carry

* **A hand-rolled `postgres(url, …)` client that you then `drizzle()`-wrap must
  call `restoreRawDateSerializers(client)`** — same drift class as EI-9265's
  bigint note.
* **Never `.catch(() => [])` an instrument query without logging** — a
  fail-soft contract may keep the loop alive, but the failure must be visible
  (see `warnSpawnReadError` in `packages/operator-core/lib/pot/throughput.ts`:
  once-per-process-per-distinct-message).
* **Residual latent trap:** json OIDs `114`/`3802` are still transparent — a raw
  `sql.json(obj)` / object param would hit the same throw class. Pass
  pre-stringified JSON (`JSON.stringify(x)::jsonb` style), which all current
  callers do.
* **Auditing for silent zeroing:** suspect any all-time-zero metric column whose
  feeding query passes a `Date` param on a canonical client and is
  catch-wrapped. `tripwire/store.ts` (resolved\_at/reverted\_at writes) and
  `fleet/pg-stores.ts` (tombstones) passed raw Dates and were repaired by the
  same fix.
