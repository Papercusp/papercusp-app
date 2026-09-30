# Manually-applied migrations must be re-run-safe — guard DDL or the auto-deploy dies on lock timeouts
URL: /internal/docs/agent-insights/migration-reapply-lock-guards

The deploy pipeline re-applies every pending sql/<NNN> file on the live DB. A migration already applied by hand on the dev box re-runs at deploy time — and bare ALTER TABLE/CREATE POLICY/GRANT statements take ACCESS EXCLUSIVE locks that can hit the runner's lock_timeout and roll back the whole deploy. Wrap RLS/policy/grant DDL in existence-guarded DO blocks so a re-run takes zero locks.

## What happened (live, 2026-06-09)

Migration `208-scout-ticks-and-lens-weights.sql` was applied **manually** to the
dev box's native PG (the documented dev chore — native `:5432` has no
auto-runner). The auto-deploy pipeline then tried to apply the same file on the
live DB at 20:00/20:30/20:45 and **all three deploys failed with
`canceling statement due to lock timeout` and auto-rolled back**, stranding the
live operator \~5 hours behind staging.

`CREATE TABLE IF NOT EXISTS` no-ops cheaply — but the rest of a conventional
migration does NOT:

* `ALTER TABLE … ENABLE ROW LEVEL SECURITY` — ACCESS EXCLUSIVE, **every run**
* `DROP POLICY IF EXISTS … ; CREATE POLICY …` — ACCESS EXCLUSIVE, every run
* `GRANT …` — ACCESS EXCLUSIVE, every run

On a table that's already live (because the manual apply created it and
resolvers/routines are already reading it), any concurrent reader queues those
locks past the runner's `lock_timeout` → the migrate step dies → rollback.

## The rule

A migration that can ever be **re-applied on a DB where it already ran** (which
is every migration on this project, because of the manual-dev-apply +
deploy-re-apply pattern) must make its lock-taking statements conditional:

```sql
DO $$ BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'harness_shared.t'::regclass) THEN
    ALTER TABLE harness_shared.t ENABLE ROW LEVEL SECURITY;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='harness_shared'
                  AND tablename='t' AND policyname='t_workspace_isolation') THEN
    CREATE POLICY t_workspace_isolation ON harness_shared.t USING (…) WITH CHECK (…);
  END IF;
  IF NOT has_table_privilege('harness_app', 'harness_shared.t', 'INSERT') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.t TO harness_app;
  END IF;
END $$;
```

Guarded = the re-run takes **zero** table locks; the fresh-migrate path
(embedded-pg, the `fresh-migrate.integration.test.ts` gate) executes the
statements normally. See `208-scout-ticks-and-lens-weights.sql` for the worked
fix, and mirror it instead of the older bare-DDL pattern in `202-*.sql`.

:::note\[Update: a second call site exists now, with different failure semantics — the guard rule still covers both]
`migration-runner.js`'s `applyPendingMigrations` takes a `continueOnError` flag, and there are now
**two** distinct call sites that set it differently:

* **`apps/operator/lib/release/migrate.ts`** (`applyStagedMigrations`) — the DEPLOY path this
  incident is about. `continueOnError: false` (the default): a lock-timeout or any other failure
  THROWS, aborting the deploy and rolling back, exactly as described above. `lock_timeout` is
  configurable via `readMigratePolicy()` (`db:migrate-policy`), 15000ms by default;
  `application_name: 'papercusp-deploy-migrate'`.
* **`packages/operator-core/lib/db-boot-migrate.ts`** (`applyPendingMigrationsAtBoot`) — a NEWER,
  separate path that runs at native-box **boot** time (not deploy time — see
  handoff-coordination-dx-followups-2026-06-04 §A1). It sets `continueOnError: true`: a failing
  migration is logged and left **unrecorded** in `schema_migrations` (so it's retried on the next
  boot) instead of throwing, and a coord message (`category: 'service-health'`) is broadcast so the
  failure isn't silent. It has its own `lock_timeout: 15_000` and
  `application_name: 'papercusp-boot-migrate'`.

These are complementary, not redundant: the deploy path stays fail-loud on purpose (a bad migration
should never ship), while the boot path is deliberately soft-fail (a single boot-time hiccup
shouldn't crash-loop the box; it just retries next boot). **The guard-your-DDL rule above still
applies unconditionally to both** — `continueOnError: true` changes what happens to the *runner's
bookkeeping* after a lock-timeout, it does not make the lock-timeout itself any less likely or
less disruptive to concurrent readers of the table while it's pending.
:::

## How to recognize it

* `/tmp/papercup-auto-deploy.log` shows `migrate: apply <NNN>-…` then
  `✖ deploy failed: canceling statement due to lock timeout` then a rollback.
* `papercup-release` checkout SHA stops advancing while `origin/main` moves.
* The live operator stays healthy (rollback works) — the failure is silent
  unless you look at the deploy log, so a stalled release SHA is the tell.
