-- 695-boot-history-events-origin-column.sql
-- EI-18736339540215666: harness_shared.boot_history_events is written by BOTH real
-- harnesses and vitest integration-test fixtures running continuously on the same box,
-- with no marker separating them. Any straightforward aggregate over the table (e.g.
-- "how many join_succeeded / announce_admitted in the last 24h") is dominated by test
-- fixture churn and reads as thriving federation while real hives have zero remote
-- peers admitted — a false-confidence trap of the same shape as EI-18735338283879820's
-- substrate diagnostic (a healthy-looking answer assembled from the wrong population).
--
-- Fix: stamp provenance on the row rather than splitting storage. `origin` defaults to
-- 'real' (every existing row, and every future INSERT that doesn't explicitly pass a
-- value, is real) so this migration needs no backfill and cannot regress existing
-- non-test call sites that haven't been touched. The writer (boot-history-pg-store.ts)
-- now stamps 'test' when process.env.VITEST is set (the existing, already-used-elsewhere
-- convention in this codebase — rubrics.ts, work-items.ts — not a new one), and every
-- read/aggregate surface defaults to `origin = 'real'` unless a caller explicitly opts
-- into test rows for debugging the tests themselves.

-- FORWARD-COMPAT: the DROP+ADD below targets `origin`, a column this SAME migration is
-- what introduces (ADD COLUMN IF NOT EXISTS two lines down) — no deployed release
-- predates this migration's own column, so there is nothing for old code to have relied
-- on. Checked against deployed sha 1e0ddc5864: the deployed writer
-- (boot-history-pg-store.ts) already writes `origin` explicitly as exactly 'real' or
-- 'test' on every INSERT, so the DROP-then-ADD is a same-shape idempotent re-assertion
-- (identical CHECK before and after) rather than a narrowing — deployed values remain
-- valid under both. (WI-6842)

-- NOTE: no top-level BEGIN;/COMMIT; here — the migration runner already wraps each file
-- in its own transaction (see migration 660's own note on this).
ALTER TABLE harness_shared.boot_history_events
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'real';

ALTER TABLE harness_shared.boot_history_events
  DROP CONSTRAINT IF EXISTS boot_history_events_origin_check;

ALTER TABLE harness_shared.boot_history_events
  ADD CONSTRAINT boot_history_events_origin_check CHECK (origin IN ('real', 'test'));

-- Aggregates/reads filtering to real-only traffic are the common case (this is exactly
-- what the false-confidence trap needs to be cheap to avoid) — index it alongside the
-- existing scope index rather than forcing a sequential scan + filter.
CREATE INDEX IF NOT EXISTS boot_history_events_origin_scope_idx
  ON harness_shared.boot_history_events (origin, workspace_id, harness_slug, created_ts);

COMMENT ON COLUMN harness_shared.boot_history_events.origin IS
  'real | test — real (default) for genuine harness activity, test for vitest fixture writes (process.env.VITEST). Read/aggregate surfaces default to origin=''real'' so test traffic can never silently masquerade as federation health (EI-18736339540215666).';
