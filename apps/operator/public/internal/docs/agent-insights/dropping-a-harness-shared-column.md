# Dropping a harness_shared column — the 4-place procedure
URL: /internal/docs/agent-insights/dropping-a-harness-shared-column

A DROP COLUMN migration alone fails the fresh-migrate STRICT gate. Sync 4 places (migration, 000-baseline, generated.ts, schema.ts), unfreeze SELECT* views, grep pg_proc bodies, and boot-apply via dev:restart.

## What

Dropping a `harness_shared.*` column in papercup touches **4 places**, not 1 —
a plain `DROP COLUMN` migration alone fails the `fresh-migrate.integration`
STRICT gate. First proven on migration **155** (drop
`harness_features_consolidated.blocked_by`, plan
`harness-blueprint-orchestration-2026-06-03` P-020/EI-1).

## The 4 consistency points (same change, same tick)

1. **The migration** — `libs/papercusp/libs/db/sql/<NNN>-*.sql`. Reserve the
   number via `db:next-migration` (never max-on-disk+1; it collides with
   peers' reservations).
2. **`000-baseline.sql`** — the squashed dump still defines the column + its
   indexes. Re-applying baseline RAW on the post-drop head fails
   (`CREATE INDEX … (col)` → "column does not exist"; the
   `CREATE TABLE IF NOT EXISTS` is a no-op so it doesn't re-add the column).
   The fresh-migrate "re-applying 000-baseline.sql RAW is a clean no-op" gate
   catches this. → **Surgically remove the column def + any index from
   baseline.** There is no baseline-regen CI compare (`verify-baseline.ts`
   only counts tables), so a hand-edit is safe. A full live-dump regen is the
   WRONG scope — it folds in every peer's un-regenerated migration.
3. **`src/schema/generated.ts`** — the canonical drizzle mirror (runtime
   imports it via `schema/index.ts`). `pull-schema.mjs` regenerates it but the
   file is stale fleet-wide (peers don't run it), so **surgical-edit** the
   column + index out; don't full-regen.
4. **`src/schema/schema.ts`** — the raw drizzle-kit introspect intermediate
   (not imported, but keep it consistent). Same surgical edit.

## Two hazards that bite

* **`SELECT *` views freeze their column list at CREATE.** `work_items` is
  `SELECT * FROM harness_features_consolidated` (migration 136) — created
  after the column existed, so it froze it and PG refuses the `DROP COLUMN`
  while the view lists it. The migration must `DROP VIEW` → `DROP COLUMN` →
  recreate the view. Views frozen *before* the column existed don't list it —
  verify live with
  `information_schema.view_column_usage WHERE column_name='<col>'`.
* **Function/trigger bodies aren't in pg\_depend.** Grep
  `pg_proc.prosrc ILIKE '%<col>%'` live before dropping — `DROP … CASCADE`
  does not rewrite function bodies that name the column.

## Applying live

The native `:5432` dev box **boot-applies pending migrations on
`dev:restart`** (`papercup-dev-api.service`). Restart FIRST so new code stops
reading the column before the drop lands (no error window), then check
`notifications:recent { level: 'error' }`.

## Provenance

Lifted from the Claude memory archive
(`project_drop_baseline_column_procedure`, 2026-06-04) during the
claude-memory-projection-integration boundary split — runbooks live here, not
in per-client memory.
