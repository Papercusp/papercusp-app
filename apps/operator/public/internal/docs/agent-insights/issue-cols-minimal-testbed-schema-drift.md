# Adding a column to ISSUE_COLS/FEATURE_COLS breaks minimal-schema integration testbeds — patch every 131-applier, not just your own suite
URL: /internal/docs/agent-insights/issue-cols-minimal-testbed-schema-drift

A shared fixture (test/_work-items-schema.ts) now centralizes the engineer_issues/harness_features_consolidated DDL for ~60 integration suites — add a new ISSUE_COLS/FEATURE_COLS column there ONCE. Only composition-rig.ts (the hermetic shared-pot-loop rig) still hand-rolls its own schema and needs the old per-file patch.

## Current behavior (2026-07-03) — superseded by a shared fixture

**The "grep for `131-engineer-issues.sql` and patch every hit" fix below is no
longer the primary answer.** A shared fixture,
`packages/operator-core/test/_work-items-schema.ts`, now exports ONE
prod-faithful superset DDL (`HARNESS_FEATURES_CONSOLIDATED_DDL` +
`ENGINEER_ISSUES_MIN_DDL`, `USER_TRUST_LIST_DDL`, `WORK_ITEM_DEPS_DDL`,
`SUBSTRATE_OUTBOX_DDL`, …) that \~60 integration suites now import instead of
hand-assembling their own schema from migration files (D-014,
fixture-completeness debt). That includes the two files this doc originally
called out by name — `plan-items/plan-item-convert.integration.test.ts` and
`delegated-tasks.integration.test.ts` both now `import {
HARNESS_FEATURES_CONSOLIDATED_DDL, … } from '../../test/_work-items-schema'`
rather than hand-picking migration files for the core `engineer_issues` /
`harness_features_consolidated` shape (they still `readMigration(...)` for
*other*, non-work-item migrations, e.g. `140-plan-item-assignments.sql`).

Also note: `engineer_issues` and `harness_features_consolidated` are
themselves now compat **VIEWS** over a unified `harness_shared.work_items`
table (the P-010 work-items unification) — `_work-items-schema.ts`'s DDL
creates that base table + both views + the `INSTEAD OF` trigger that keeps
`engineer_issues` writable.

**So the current fix, for the general case:** when you add a column
`ISSUE_COLS`/`FEATURE_COLS` (`issues-engineer.ts` / `work-items.ts`) selects
unconditionally, add it to `_work-items-schema.ts`'s
`HARNESS_FEATURES_CONSOLIDATED_DDL` (the `work_items` table, and the
`engineer_issues` view's SELECT list if the issue family reads it too) —
**once** — and every importing suite picks it up automatically. Confirm with:

```bash
grep -rl "_work-items-schema" packages/operator-core/lib packages/operator-core/test | wc -l
```

**The one still-hand-rolled exception:**
`packages/operator-core/lib/shared-pot-loop/composition-rig.ts` — the
hermetic 2-swarm composition rig — deliberately keeps its **own** condensed
schema (a `CREATE TABLE` plus manually-maintained `ALTER TABLE ... ADD COLUMN
IF NOT EXISTS` blocks, each commented with the originating migration number)
rather than importing the shared fixture. That file still needs the manual
per-column patch the historical "Fix / rule" section below describes — grep
it directly rather than the whole repo:

```bash
grep -n "engineer_issues\|harness_features_consolidated" packages/operator-core/lib/shared-pot-loop/composition-rig.ts
```

The history below (symptom, root cause, the original grep-everything fix) is
preserved as-is for context on *why* the shared fixture exists and how the
failure looks when a suite is still on the old hand-rolled pattern (as
composition-rig.ts is).

## Symptom (historical — as of 2026-06-12, before the shared fixture)

`npm run test:affected:integration` goes red with 10+ tests across suites you
never touched — `delegated-tasks`, `plan-items/plan-item-convert`, the four
`shared-pot-loop` suites — all with the same error:

```
PostgresError: column "signal_origin" of relation "engineer_issues" does not exist
  ❯ createIssue lib/issues-engineer.ts:249
```

Your own suite (and the live DB) are green, because you applied your migration
there. The failures are NOT in your test; they are in the **work-items engine
code path** (`ISSUE_COLS` / `FEATURE_COLS` in
`packages/operator-core/lib/issues-engineer.ts`), which now selects/inserts a
column the other suites' test DBs don't have.

## Root cause (historical)

These suites do not provision through the full migration chain. They build a
**minimal schema** by applying hand-picked migration files plus ad-hoc
`ALTER TABLE … ADD COLUMN IF NOT EXISTS` patches:

* `lib/plan-items/plan-item-convert.integration.test.ts` (beforeAll,
  `readMigration('131-engineer-issues.sql')` + selected others)
* `lib/delegated-tasks.integration.test.ts` (same pattern)
* `lib/shared-pot-loop/composition-rig.ts` (a file list around line 270 —
  shared by composition-happy-path, fleet-monitors, redundancy-two-swarm,
  split-brain-mug)

So any migration that adds a column **the engine reads or writes
unconditionally** must also be applied in every one of these setups. This has
now recurred twice: migration 178 (`assignee_rank` — the precedent is the
inline ALTER comment in those same beforeAlls) and migration 241
(`signal_origin`, fixed 2026-06-12 during consume-edges B-09).

## Fix / rule (historical — now applies only to composition-rig.ts)

When you add a column to `engineer_issues` / `harness_features_consolidated`
that `ISSUE_COLS`/`FEATURE_COLS` (or any unconditional engine SQL) touches:

```bash
grep -rln "131-engineer-issues.sql" packages/operator-core/{lib,test}
```

and add your migration to **each** hit (one line, mirroring the existing
pattern):

```ts
// Signal provenance (frontier P-002, migration 241): ISSUE_COLS selects signal_origin.
await db.sql.unsafe(readMigration('241-signal-provenance-origin.sql')).simple();
```

(`composition-rig.ts` takes the filename in its list instead.) Then run the
hits' suites, not just your own:
`npx vitest run --config vitest.integration.config.ts <files>`.

Keep migrations like this **idempotent + standalone** (ADD COLUMN IF NOT
EXISTS, no `\set`, no BEGIN/COMMIT wrappers) — the rig strips psql
meta-commands but can't fix a migration that depends on later files.
