# Hermetic dispatch tests must seed EVERY postInvoke-seam table (tool_invocations + decision_ledger)
URL: /internal/docs/agent-insights/dispatch-postinvoke-seam-tables-in-hermetic-tests

A pot integration test that dispatches a governed tool through the real dispatch path runs the postInvoke seam, which writes to BOTH harness_shared.tool_invocations (recordInvocation) AND harness_shared.decision_ledger (recordDecisionLedger, migration 260). A beforeAll that hand-curates a migration subset and seeds only some of those tables reddens the WHOLE file via vitest-fail-on-console. Symptom: 'Expected test not to call console.warn()' wrapping 'relation harness_shared.X does not exist'.

## The symptom

A pot integration test (`packages/operator-core/lib/hive/*-e2e.integration.test.ts`,
`shared-pot-loop/*.integration.test.ts`) goes red with:

```
vitest-fail-on-console > Expected test not to call console.warn().
[decision-ledger] insert failed: relation "harness_shared.decision_ledger" does not exist
    at recordDecisionLedgerImpl (.../lib/decision-ledger/emit.ts:190)
```

The assertion the test *wrote* passes; the file fails anyway because **any
`console.warn` reddens the whole file** under `vitest-fail-on-console`. The warn
comes from a side-effect you didn't write — the dispatch postInvoke seam.

This bit EI-496 + EI-497 (`declared-event-wake-e2e`, `start-pot-e2e`) on
2026-06-14. The same file already carried the identical comment one table
earlier for `tool_invocations` — so this is the **second** postInvoke-seam table
to draw blood. Expect a third when a new seam table lands.

## Why

These hermetic tests don't run the migration runner — their `beforeAll`
hand-curates a *subset* of `libs/papercusp/libs/db/sql/*.sql` (plus a couple of
inline `CREATE TABLE`s). But every governed tool dispatch runs the shared
endpoint **postInvoke seam**, which writes to:

* `harness_shared.tool_invocations` — `recordInvocation` (projected-tool-deps),
  on EVERY dispatch incl. reads.
* `harness_shared.decision_ledger` — `recordDecisionLedger`
  (`lib/decision-ledger/emit.ts`), migration **260**, on governed (non-read)
  non-SU actions.

Miss either table and the seam `console.warn`s rather than throwing (it's
best-effort by design — the ledger must never break a real dispatch), so the
test *runs* but the file goes red.

## The fix

Seed BOTH tables in `beforeAll`. `260-decision-ledger.sql` is self-contained
(`CREATE TABLE IF NOT EXISTS` depending only on the `harness_shared` schema +
the `harness_app`/`harness_zero` roles, both created earlier in these hooks), so
just apply it like the other migrations:

```ts
await rootSql.unsafe(readMigration('260-decision-ledger.sql')).simple();
```

`tool_invocations` is created inline in these files (see the existing block).
When you add a new hermetic dispatch test, copy a *current* sibling's `beforeAll`
rather than an old one — the seam's table set only grows.

## Rule of thumb

If a test dispatches a governed tool through the real path, its `beforeAll` must
provide every table the postInvoke seam touches — not just the tables your
assertions read. When a new seam side-effect adds a table, every hand-curated
hermetic dispatch test inherits the gap at once; the watchdog will file it as a
"test failing repeatedly" EI per file.
