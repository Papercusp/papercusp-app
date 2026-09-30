# The live db-org postgres client rejects JS Date AND sql.json(array) params — pass ISO/JSON strings
URL: /internal/docs/agent-insights/db-org-client-rejects-js-date-params

getOrgPg()'s live client throws 'The "string" argument must be of type string… Received an instance of Date' on a Date query parameter — and the same class of error ('Received an instance of Array') on sql.json() of an array — while the plain testcontainers clients integration tests use accept both fine, so the failure ships green and only surfaces live.

## Symptom

A write/read through `getOrgPg()` that passes a JavaScript `Date` as a query
parameter (e.g. `${new Date(ms)}` into a `timestamptz` column) fails at runtime
with:

```
The "string" argument must be of type string or an instance of Buffer or
ArrayBuffer. Received an instance of Date
```

Every integration test stays GREEN: the `_org-test-db` / `createOrgTestDb`
fixtures hand tests a plain `postgres(url)` client (and mock `@papercusp/db-org`
onto it), and vanilla postgres.js serializes `Date` natively. The live
`getOrgPg()` client is configured differently (custom type/serializer setup),
and there a `Date` parameter throws. FB-02's change-ledger hit this: 7/7
integration tests green, then the first LIVE scan recorded 0 of 139 rows
(best-effort swallow+warn made it visible instead of fatal).

## Rule

**Never pass a `Date` instance as a `getOrgPg()` query parameter. Convert to an
ISO string** — Postgres casts `text` → `timestamptz` fine:

```ts
${new Date(ms).toISOString()}          // ✅
${new Date(ms)}                        // ❌ throws on the live client only
```

This also means a green `*.integration.test.ts` does NOT prove parameter
serialization against the live client — if your write path is new, run one real
write through the live `getOrgPg()` (a tsx one-off or the live surface) before
calling it verified. Best-effort writers (swallow+warn, dispatch-ledger style)
make this class of failure observable instead of silent.

## The same trap, jsonb edition: `sql.json(<array>)`

The identical green-then-live failure shape exists for **jsonb** parameters.
`sql.json(someArray)` works on the testcontainers clients but the live
`getOrgPg()` client throws:

```
The "string" argument must be of type string or an instance of Buffer or
ArrayBuffer. Received an instance of Array
```

**Rule: pass jsonb params as JSON STRINGS with an explicit cast** — works on
both clients:

```ts
${JSON.stringify(rows)}::text::jsonb                      // ✅
${value == null ? null : JSON.stringify(value)}::text::jsonb  // ✅ nullable
${sql.json(rows)}                                         // ❌ array throws live
```

FB-09's prompt-ablation store hit this: 4/4 integration tests green, then the
first LIVE supervised cycle crashed at the row insert on a jsonb array param
(`ledger_context`). Fixed to stringified-with-cast on 2026-06-12
(`packages/operator-core/lib/ablation/store.ts`).

## Where it bit

`packages/operator-core/lib/change-ledger/change-ledger.ts`
(`recordBehaviorChange` `recorded_at` backfill + `readRecentChanges` `sinceMs`
filter), fixed to `.toISOString()` on 2026-06-12 (self-learning-frontier FB-02).
`packages/operator-core/lib/ablation/store.ts` (`insertAblationRun` jsonb
params), fixed to `JSON.stringify(...)::text::jsonb` on 2026-06-12
(self-learning-frontier FB-09).
