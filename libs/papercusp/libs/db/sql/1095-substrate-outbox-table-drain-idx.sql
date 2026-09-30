-- 1095-substrate-outbox-table-drain-idx.sql
--
-- EI-22138988923269437 (durable fix, WI-2141185's mitigation follow-up):
-- substrate_outbox drains strict-FIFO with no priority lane, so a bulk
-- backfill of one table's rows can head-of-line-block EVERY other table
-- (coordination included) for as long as the bulk table's backlog takes to
-- clear. The fix (outbox-drain.ts) replaces the single flat `ORDER BY id
-- LIMIT batch` SELECT with TWO independently-bounded scans — one over just
-- the small OUTBOX_PRIORITY_TABLES set (coord_event_log/conversations/
-- threads/thread_posts), one over everything else (unchanged flat FIFO) —
-- unioned with priority rows ordered first, so coordination traffic is
-- included in a pass regardless of how old a bulk backfill sitting in the
-- non-priority scan is.
--
-- The priority scan needs table_name as a LEADING index column ahead of id —
-- the existing substrate_outbox_drain_idx (workspace_id, harness_slug,
-- drained_at, id) has no table_name column, so filtering to 4 table_names
-- while ordering by the GLOBAL id would have to walk (and heap-fetch) every
-- undrained row in id order until it collects enough matches — exactly the
-- O(backlog) cost this fix exists to avoid for a sparse/late table like
-- coord_event_log sitting behind a large bulk backfill.
--
-- Purely additive (new index only) — no FORWARD-COMPAT note needed.
CREATE INDEX IF NOT EXISTS substrate_outbox_table_drain_idx
  ON harness_shared.substrate_outbox
  USING btree (workspace_id, harness_slug, table_name, drained_at, id);
