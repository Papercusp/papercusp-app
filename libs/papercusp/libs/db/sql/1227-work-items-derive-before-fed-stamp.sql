-- 1227-work-items-derive-before-fed-stamp.sql
--
-- WI-10003230 (live-federation cert RED WI-10003114, concurrent_lww PHASE 2 never
-- converges). The work_items BEFORE-row triggers that DERIVE a column from OLD/NEW must
-- fire BEFORE stamp_local_federated_write_trg, because the stamp decides "content
-- changed" by comparing NEW with OLD, and a derivation that runs after it rewrites NEW
-- underneath a verdict that was already taken.
--
-- WHAT WAS WRONG
--   PostgreSQL fires same-timing row triggers in NAME order (byte order). On work_items:
--     stamp_local_federated_write_trg            <- judges NEW vs OLD, mints the clock
--     stamp_work_item_closed_ts_trg              <- terminal->terminal: NEW.closed_ts := OLD.closed_ts
--     stamp_work_item_state_changed_at_trg       <- same-status: NEW.state_changed_at := OLD...
--     zz_work_item_completion_event_intent_trg   <- terminal->terminal: restores the prior intent id
--   'l' < 'w' < 'z', so all three normalizers ran AFTER the stamp had already judged the
--   caller's un-normalized NEW.
--
-- MEASURED (rig pcusp-wi2882, 2026-09-26, forensic audit triggers; chain on WI-10003230)
--   Frame B held the contested row terminal with closed_ts NULL, frame A with
--   closed_ts 1790419581205. Each remote op was applied twice: the first apply moves the
--   clock (the stamp's explicit clock-move branch honours it) and closed_ts is frozen at
--   OLD by the terminal->terminal rule; the duplicate, clock-STATIONARY re-apply then
--   carries closed_ts that differs from the stored value, so the stamp judged it a
--   content change, minted a fresh local HLC and origin='local', and only THEN did
--   stamp_work_item_closed_ts freeze closed_ts back. The row's content was unchanged but
--   its clock was new, so the capture shipped it; the peer did the same with the other
--   closed_ts. ~1 op/s on both frames, forever. Mig 1226 (feature_wire_row) did not stop
--   it: closed_ts IS a column peers apply, so it stays content under 1226 by design.
--
--   The same shape exists for the other two derivations: a clock-stationary write whose
--   state_changed_at (issue-family wire content) or payload._completionEventIntentId
--   (wire content in both families) differs from what the normalizer will restore mints
--   a clock for a row that ends up byte-identical.
--
-- THE FIX
--   Rename the three derivation triggers into the stamp_before_fed_* band, which sorts
--   after every existing guard/attribution trigger (completion_authority_floor_*,
--   preserve_*, record_*, reject_*) and before stamp_local_federated_write_trg
--   ('stamp_b' < 'stamp_l'). Their relative order to those earlier triggers is therefore
--   unchanged; only their order relative to the stamp moves. None of the three reads
--   fed_ts / fed_hlc / origin, so none depends on the stamp having run first. The
--   stamp trigger's own name is deliberately NOT changed: stamp-trigger-coverage and
--   the shared-pot composition rig address it by name on ~22 tables.
--
--   Functions, events and FOR EACH ROW are unchanged — only the trigger names move.
--   DROP + CREATE (rather than ALTER TRIGGER ... RENAME) keeps the file idempotent on a
--   database where either name already exists.
--
--   A class guard in work-items-derive-before-fed-stamp.integration.test.ts fails if
--   any BEFORE-row trigger that assigns NEW.<col> sorts after the stamp on ANY table the
--   stamp serves.
--
-- FORWARD-COMPAT: the deployed release never addresses these three trigger names at
-- runtime (only a test asserted one of them, updated in this change), and the trigger
-- functions and their events are unchanged, so the running :3070 build sees identical
-- behaviour apart from the stamp no longer minting clocks for normalized-away writes.

DROP TRIGGER IF EXISTS stamp_work_item_closed_ts_trg ON harness_shared.work_items;
DROP TRIGGER IF EXISTS stamp_before_fed_work_item_closed_ts_trg ON harness_shared.work_items;
CREATE TRIGGER stamp_before_fed_work_item_closed_ts_trg
  BEFORE INSERT OR UPDATE ON harness_shared.work_items
  FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_work_item_closed_ts();

DROP TRIGGER IF EXISTS zz_work_item_completion_event_intent_trg ON harness_shared.work_items;
DROP TRIGGER IF EXISTS stamp_before_fed_work_item_completion_event_intent_trg ON harness_shared.work_items;
CREATE TRIGGER stamp_before_fed_work_item_completion_event_intent_trg
  BEFORE INSERT OR UPDATE ON harness_shared.work_items
  FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_work_item_completion_event_intent();

DROP TRIGGER IF EXISTS stamp_work_item_state_changed_at_trg ON harness_shared.work_items;
DROP TRIGGER IF EXISTS stamp_before_fed_work_item_state_changed_at_trg ON harness_shared.work_items;
CREATE TRIGGER stamp_before_fed_work_item_state_changed_at_trg
  BEFORE INSERT OR UPDATE ON harness_shared.work_items
  FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_work_item_state_changed_at();

COMMENT ON TRIGGER stamp_before_fed_work_item_closed_ts_trg ON harness_shared.work_items IS
  'Mig 1227 (WI-10003230): must sort before stamp_local_federated_write_trg so the stamp judges the derived closed_ts.';
COMMENT ON TRIGGER stamp_before_fed_work_item_completion_event_intent_trg ON harness_shared.work_items IS
  'Mig 1227 (WI-10003230): must sort before stamp_local_federated_write_trg so the stamp judges the derived payload.';
COMMENT ON TRIGGER stamp_before_fed_work_item_state_changed_at_trg ON harness_shared.work_items IS
  'Mig 1227 (WI-10003230): must sort before stamp_local_federated_write_trg so the stamp judges the derived state_changed_at.';
