-- 741-work-items-condition-key-singleton.sql
--
-- P-002 of plan `gate-ownership-condition-singleton-2026-08-03`.
--
-- WHAT THIS BUYS. Work-items already carry complete ownership (`taken_by`,
-- `taken_at`, `expires_at` lease, `last_released_by`). Conditions already carry
-- keyed identity and an open/resolve lifecycle (`conditionKey`, 12 producers:
-- `green-stall:<slug>`, `main-behind-staging:<slug>`, `single-primary:<verdict>`,
-- `release-trigger-freeze:<slug>`, ...). They have never been joined, so a
-- condition has no row to own — and what cannot be owned gets re-filed by every
-- agent that notices it.
--
-- Measured 2026-08-02/03: `single-primary:no-primary` was filed as SIX separate
-- `kind=bug severity=major` work-items by six agents inside ~2h15m, plus a
-- seventh its own author retracted. None saw the others. Five are still open.
--
-- WHY A PARTIAL UNIQUE INDEX AND NOT A RECONCILER. This exact pattern has been
-- built ad hoc at least four times here — `improvements:capture { conditionKey }`
-- (observation lane only), WI-6497 (intent-divergence coalesce), WI-6986
-- (episodic-EI dedup), and EI-16151 (the Kettle's escalation-aging advisory,
-- where coalescing onto the canonical conditionKey was PURE PROMPT INSTRUCTION
-- with zero code enforcement, so the Kettle invented its own signature and the
-- advisory self-inflated for a month). WI-6986 implemented it as a QUERY and
-- RACED: "40 of 88 open rows" duplicated under a cross-machine race. Postgres
-- serializes a unique index; a query cannot. This is in-house evidence, not
-- theory.
--
-- ⚠⚠ WHY THE PREDICATE IS `condition_key IS NOT NULL` AND *NOT* `closed_ts IS
-- NULL` — the plan item originally specified `closed_ts IS NULL`, and that would
-- have shipped a permanent, silent breakage.
--
--   `closed_ts` IS NOT AN OPENNESS PREDICATE. Measured on the live operator DB
--   2026-08-03, `closed_ts` is NULL on 77.4% of `done` rows, 98.8% of
--   `resolved`, 91.5% of `dropped` and 100% of `closed` — 13,000+ terminal rows
--   carry no close stamp. The codebase says so too:
--   `directive-effect.ts` reads it as `toMs(row.closed_ts) ?? toMs(row.updated_ts)`
--   with the comment "closed_ts is the precise stamp; updated_ts is the
--   fallback". It is a best-effort precision timestamp.
--
--   Had the index used it: a condition resolves, its work-item goes terminal
--   with `closed_ts` still NULL, the condition later RE-OPENS, the bridge tries
--   to mint a fresh singleton — and hits a UNIQUE violation against the settled
--   row. That condition becomes permanently unownable, and the failure is
--   invisible until the second occurrence of a condition, which may be weeks out.
--
--   Predicating on `status` instead was the obvious repair and is also wrong FOR
--   SQL: the terminal set (`ANY_FAMILY_TERMINAL_STATES` — passed/deprecated/
--   done/dropped/resolved/closed) is a TypeScript SSOT that this file cannot
--   import, so any status list here is a hand-copy. Hand-copying that exact
--   union is a documented drift bug in this repo (EI-18653071581558556: a stale
--   copy missing `done`/`dropped` scored 15 of 17 finished units as stranded,
--   ~88% phantoms). A denylist here would also fail CLOSED — a newly-added
--   terminal state would read as open and wedge re-minting permanently.
--
-- SO: uniqueness is scoped to "rows that currently CLAIM to own a condition",
-- which is exactly `condition_key IS NOT NULL`. There is no lifecycle vocabulary
-- in this file at all, so it cannot drift from the TS enum.
--
-- RELEASE SEMANTICS (P-003, the bridge). Closing the owning work-item CLEARS
-- `condition_key` back to NULL in the same write that settles it — releasing the
-- key rather than relying on a status predicate. That decision lives in
-- TypeScript, where it imports `ANY_FAMILY_TERMINAL_STATES` directly and so can
-- never disagree with the rest of the system. The bridge additionally clears the
-- key from any already-terminal row holding it before inserting, so a missed
-- release self-heals on the next occurrence instead of wedging forever.
--
-- HISTORY IS NOT LOST BY CLEARING THE KEY. The `coord_links` edge written by
-- P-001 (`rel='about'`, `src=(issue, WI-x)`, `dst=(event, <conditionKey>)`) is
-- append-only and never cleared. So the two mechanisms answer two different
-- questions on purpose:
--   • `condition_key`        -> who owns this condition RIGHT NOW (mutable, unique)
--   • the `about` link edge  -> every item ever filed for it (append-only, historical)
--
-- SAFETY. `ADD COLUMN` with no default is a catalog-only change on PG11+ (no
-- table rewrite). The new column is NULL for every existing row, so the partial
-- index is built over zero rows and can conflict with nothing.
--
-- FORWARD-COMPAT: both the column and the index are introduced by THIS migration,
-- so no deployed release can reference either — `condition_key` does not exist in
-- any shipped code path, and there is no pre-existing non-partial index of these
-- columns whose ON CONFLICT arbiter could be narrowed out from under a running
-- release. This is a pure EXPAND with nothing to contract. (The guard exists
-- because migration 689 narrowed an in-use arbiter and broke facts:assert
-- fleet-wide for ~3h — EI-18797473716313783.)
--
-- ⚠ CONSEQUENCE FOR P-003's BRIDGE UPSERT. Because this index is PARTIAL,
-- Postgres will only infer it as an ON CONFLICT arbiter when the statement
-- REPEATS the predicate. The bridge must therefore write:
--
--     INSERT INTO harness_shared.work_items (...)
--     ON CONFLICT (workspace_id, harness_slug, condition_key)
--       WHERE condition_key IS NOT NULL
--       DO UPDATE SET ...
--
-- Omitting that `WHERE` yields a runtime "no unique or exclusion constraint
-- matching the ON CONFLICT specification" error, NOT a silent duplicate — it
-- fails loudly at the first upsert, which is the failure direction we want.

ALTER TABLE harness_shared.work_items
  ADD COLUMN IF NOT EXISTS condition_key TEXT;

COMMENT ON COLUMN harness_shared.work_items.condition_key IS
  'The condition (watchdog conditionKey, e.g. ''green-stall:papercusp'') this work-item is the CURRENT owner of. '
  'NULL = owns no condition. At most one non-terminal item may hold a given key per (workspace, harness) — enforced '
  'by work_items_condition_key_uq. CLEARED when the item settles, which is what lets a re-opened condition mint a '
  'fresh owner. Historical "every item ever filed for this condition" lives on the coord_links rel=''about'' edge to '
  '(event, <conditionKey>), which is never cleared. See plan gate-ownership-condition-singleton-2026-08-03.';

-- The singleton. Scoped per (workspace, harness) because condition keys are
-- harness-relative (`green-stall:<slug>` embeds the slug, but `single-primary:*`
-- does not), and harness_shared is multi-tenant — an unscoped unique index would
-- let one harness's condition block another's.
CREATE UNIQUE INDEX IF NOT EXISTS work_items_condition_key_uq
  ON harness_shared.work_items (workspace_id, harness_slug, condition_key)
  WHERE condition_key IS NOT NULL;
