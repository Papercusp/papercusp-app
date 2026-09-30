-- 481-gym-qd-outcome-record-capture.sql
--
-- Fix the gym_qd_archive federation CAPTURE trigger to also fire when the
-- device-signed `outcome_record` changes (federated-scout-gym-learning-2026-07-02
-- F1-6 / P-014, D-005 hole 3 — the SEND-side signing layer).
--
-- THE BUG this repairs: mig 464 created `capture_gym_qd_outbox_upd_trg` with a
-- COLUMN-SCOPED WHEN clause that fires only on a `fitness` / `candidate_id` /
-- `federatable` change. Mig 478 then added `gym_qd_archive.outcome_record` and its
-- comment CLAIMED the record is "CDC-captured … via the archive's existing capture
-- triggers" — but the existing trigger never watched that column. The SEND-side
-- signer (markEliteFederatable's signing path) stamps `federatable=true` in one
-- UPDATE and writes `outcome_record` in a SECOND UPDATE that touches ONLY that
-- column — so the capture trigger did NOT fire for it, and because
-- capture_substrate_outbox snapshots `to_jsonb(NEW)` AT FIRE TIME, the signed
-- record was NEVER placed on the peer-log. Every federated elite went out
-- outcome-UNVERIFIED even when a signer was present.
--
-- FIX: add `OLD.outcome_record IS DISTINCT FROM NEW.outcome_record` to the WHEN
-- clause. Now the record-writing UPDATE fires the trigger, snapshotting the row
-- WITH the populated `outcome_record`, so it federates. The receiver's per-(niche ×
-- source) LWW (fed_order_key) applies the later op, leaving `outcome_verified=true`.
-- The federatable/fitness/candidate_id conditions are retained unchanged, so every
-- pre-existing capture still fires exactly as before (purely additive firing).
--
-- CREATE OR REPLACE TRIGGER is idempotent; no data migration.

BEGIN;

CREATE OR REPLACE TRIGGER capture_gym_qd_outbox_upd_trg
  AFTER UPDATE ON harness_shared.gym_qd_archive
  FOR EACH ROW
  WHEN ((NEW.federatable = true OR OLD.federatable = true)
    AND (OLD.fitness IS DISTINCT FROM NEW.fitness
      OR OLD.candidate_id IS DISTINCT FROM NEW.candidate_id
      OR OLD.federatable IS DISTINCT FROM NEW.federatable
      OR OLD.outcome_record IS DISTINCT FROM NEW.outcome_record))
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('niche_key');

COMMIT;
