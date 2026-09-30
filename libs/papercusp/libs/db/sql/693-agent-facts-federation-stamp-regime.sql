-- Migration 693 — put `agent_facts` into the LWW stamp regime its siblings already run.
--
-- Plan: unified-agent-state-plane-2026-07-27, P-008 (c) facts-as-cells.
-- Ruling: D-077 (which corrects a false premise in D-012).
--
-- WHY -------------------------------------------------------------------------------
-- D-012's hard constraint on cell versions is: *"`agent_facts`, `harness_plans` and
-- `coord_event_log` all carry `fed_ts` + `fed_hlc` … Cell versions MUST ride the
-- existing HLC/`fed_ts` scheme"* — because a cell registry that mints its own version
-- counter cannot federate, which would silently break cells for the shared-hive p2p
-- work.
--
-- Measured on the live dev DB before writing this, the premise does not hold:
--   coord_event_log   100,884 / 105,237 rows stamped
--   harness_plans           979 /     979
--   agent_facts               0 /   2,030      ← and NO fed_hlc column at all
--
-- Cause (pg_trigger): agent_facts carries the three `capture_substrate_outbox`
-- triggers (ins/upd/del) but NOT `stamp_local_federated_write_trg`, which BOTH
-- sibling tables carry. So agent_facts is HALF-FEDERATED: it ships ops to the outbox
-- but holds no LWW clock and no ordering key.
--
-- That is not merely a gap for cells — it is the divergence class mig 446 was written
-- to eliminate. Per 446's own branch logic, a put on a row whose `fed_hlc IS NULL`
-- takes the non-stamp path and wires `now()` (TRANSACTION-START time) as the op ts,
-- with no HLC for the receivers' LWW guard to order by. Every federated fact is
-- therefore unordered w.r.t. concurrent remote edits. This migration fixes that
-- pre-existing defect; facts-as-cells is what surfaced it.
--
-- WHAT ------------------------------------------------------------------------------
-- Reuse, do not invent (D-012's constraint + D-004's no-new-store rule):
--   1. add `fed_hlc text` — the trigger assigns NEW.fed_hlc, so the column must exist
--      or every write raises;
--   2. attach the EXISTING `harness_shared.stamp_local_federated_write()` — a fully
--      generic function: it derives its ignore-mask from `pg_attribute` (so
--      agent_facts' generated columns are covered without another migration), gates
--      the INSERT stamp on `origin='local'` (a projection apply carrying a remote
--      fed_ts is respected verbatim), and on UPDATE stamps only when a REAL content
--      column changed — `updated_at` is already in its base mask.
--
-- No new mechanism, no new counter: after this, a fact's cell version is its
-- `(fed_ts, fed_hlc)`, identical to every other federated cell in the system.
--
-- INTERACTION WITH APPEND-VERSIONING (mig 689) --------------------------------------
-- A supersede sets `superseded_at`/`supersedes_id` — a real content change, so the row
-- re-stamps. That is correct: a supersede is an event peers must converge on. The
-- append-version CHAIN stays keyed by `supersedes_id`/`superseded_at` and is untouched
-- by the clock.
--
-- BACKFILL --------------------------------------------------------------------------
-- Existing rows are left at fed_ts/fed_hlc NULL deliberately. Stamping 2,030 historic
-- rows with a fresh clock would assert they were all authored NOW, which would win
-- every LWW comparison against genuinely newer remote state. They heal on their next
-- write, exactly as mig 446 chose for the same situation ("no repair pass … heals on
-- the row's next write").

ALTER TABLE harness_shared.agent_facts
  ADD COLUMN IF NOT EXISTS fed_hlc text;

DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.agent_facts;
CREATE TRIGGER stamp_local_federated_write_trg
  BEFORE INSERT OR UPDATE ON harness_shared.agent_facts
  FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write();

COMMENT ON COLUMN harness_shared.agent_facts.fed_hlc IS
  'Hybrid-logical-clock ordering key, stamped with fed_ts by stamp_local_federated_write (mig 693). A fact''s CELL VERSION is (fed_ts, fed_hlc) — D-012''s hard constraint, corrected premise in D-077.';
