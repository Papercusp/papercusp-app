# A minimal CREATE TABLE IF NOT EXISTS stub silently shadows a fuller later definition
URL: /internal/docs/agent-insights/fixture-subset-stub-shadows-fuller-create-table

Why an integration test dies with \"column <x> does not exist\" at a CREATE TRIGGER even though the table's fuller DDL declares that column — the shared-fixture subset-stub trap (D-014), and how to fix it.

# The subset-stub trap

**Symptom.** An integration test fails at schema setup with a bare Postgres error like
`column old.content does not exist` (or `column "workspace_id" does not exist`) thrown by a
`CREATE TRIGGER … WHEN (OLD.<col> …)` or a `CREATE INDEX`, even though the table's "real"
fixture DDL clearly declares that column. Both `it()` blocks in the file fail identically
(the throw is in shared `setupPeerSchema` / bootstrap, not the test body).

**Root cause.** Two `CREATE TABLE IF NOT EXISTS harness_shared.<t>` run against the same
throwaway DB, in this order:

1. A shared fixture (e.g. `HARNESS_FEATURES_CONSOLIDATED_DDL` in
   `packages/operator-core/test/_work-items-schema.ts`) applies a **minimal stub** of `<t>`
   for read-path completeness (e.g. just the PK columns).
2. A fuller DDL (e.g. a test-local `HARNESS_PLANS_FED_DDL`) then applies the **complete** `<t>`.

`CREATE TABLE IF NOT EXISTS` **cannot add columns** — step 2 silently NO-OPs against the stub
from step 1. The complete table's columns never materialize, so the trigger/index that
references them fails to create. The stub *shadows* the fuller definition.

`_work-items-schema.ts` already documents this as the **D-014 fixture-subset trap** (it broke
the green gate on 2026-07-05 for `plan_item_claims`, whose stub was stunted). The same file's
`harness_plans` stub then omitted `content`, which broke
`federation-content-matrix.repro.integration.test.ts` for days (EI-9524, 3 dispatch attempts).

**Fixes (pick per situation).**

* **Authoritative-definition wins (simplest):** prepend
  `DROP TABLE IF EXISTS harness_shared.<t> CASCADE;` to the fuller DDL so it always
  recreates the complete table. Safe only when nothing has written `<t>` yet at that point
  (true in a linear `setupPeerSchema`). This is what EI-9524 used.
* **Compose (either order):** make the fuller DDL idempotently additive — keep the
  `CREATE TABLE IF NOT EXISTS`, then `ALTER TABLE … ADD COLUMN IF NOT EXISTS` every column
  beyond the stub's. This is what the D-014 doctrine comment *intends* ("a richer real-DDL
  application in either order composes instead of colliding") — but note a bare
  `CREATE TABLE IF NOT EXISTS` alone does **not** achieve it.
* **Keep the stub a true superset-safe subset:** if you add a `CREATE TABLE IF NOT EXISTS`
  stub to a shared fixture, it must carry *every* column any later same-table DDL's triggers /
  indexes reference — or the later DDL must be additive (above). A strict column subset is the
  trap.

**How to diagnose without Docker.** These are testcontainer tests (`@papercusp/test-config`
hardcodes `PostgreSqlContainer`). When Docker/PG is unavailable, reproduce the exact DDL
sequence against a real backend with **`postgres --single`** (needs no socket/bind — works in a
locked-down sandbox): `node_modules/@embedded-postgres/linux-x64/native/bin/postgres --single
-D <datadir> -c exit_on_error=off postgres < repro.sql`. Feed it the stub CREATE, the fuller
`CREATE TABLE IF NOT EXISTS`, then the trigger — it prints the same `column … does not exist`,
and confirms your fix clears it.
