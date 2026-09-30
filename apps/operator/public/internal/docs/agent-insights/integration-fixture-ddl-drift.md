# Adding a column to a shared SELECT list breaks hand-rolled integration fixtures
URL: /internal/docs/agent-insights/integration-fixture-ddl-drift

ISSUE_COLS/FEATURE_COLS-style column additions 42703 every integration fixture that hand-rolls the table's DDL — sweep the fixtures with the migration, or better, source DDL from a shared test schema helper

## Symptom

Dozens of integration tests across several `*.integration.test.ts` files go red
at once with `PostgresError: column "<new_col>" does not exist` (code `42703`),
usually surfacing from a deep shared read like `getIssue`/`getWorkItem` — in
tests that have nothing to do with the column or the lane that added it.
`test:affected` looks fleet-broken; each failing suite is innocent.

## Cause

A migration added a column AND a shared SELECT list (`ISSUE_COLS`,
`FEATURE_COLS`, `SELECT_COLS`, …) now selects it — but integration fixtures do
not run the full migration chain. They hand-roll the table from a few
`readMigration(...)` calls plus an inline `ALTER TABLE … ADD COLUMN IF NOT
EXISTS` patch block, so the new column never exists in the fixture DB while the
production code unconditionally selects it.

Three occurrences of the class so far: migration 178's `assignee_rank`/
`rank_writer` columns (every work-items fixture grew the ALTER patch block),
and twice on 2026-06-12 — migration 241's `engineer_issues.signal_origin`
broke six work-items fixtures (48 red tests) hours after the same pattern hit
`work-items-priority`.

## Fix (immediate)

Grep the fixtures that bootstrap the table and extend their ALTER patch block:

```bash
grep -rln "readMigration('131-engineer-issues" packages/operator-core/lib | xargs grep -l "ALTER TABLE.*engineer_issues"
```

then add the column to each block, e.g.
`ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic'`.

## Fix (durable — do this when you ADD such a column)

1. **Before landing**: grep for the SELECT list you're extending; every
   `*.integration.test.ts` that hand-rolls that table's DDL needs the column.
2. **Better**: move the table's fixture DDL into a shared helper the way D-014
   did for `harness_features_consolidated`
   (`packages/operator-core/test/_work-items-schema.ts` exports
   `HARNESS_FEATURES_CONSOLIDATED_DDL` — the single source of truth fixtures
   import). `engineer_issues` still lacks such a helper; whoever next touches
   its shape should lift the DDL there and point the six fixtures at it.

## Related

* `packages/operator-core/test/_work-items-schema.ts` — the D-014 precedent.
* Plan context: pot-network-surface-2026-06-11 (P-011 close-out hit this);
  self-learning-frontier P-002 (migration 241, the trigger).
