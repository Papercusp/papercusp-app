-- 439-bee-claim-specs-hlc-stamp.sql
-- cross-machine-coord-parity-and-trust-2026-07-01 P-016 REGRESSION FIX (audit
-- D-013 finding M7): mig 438 federated bee_claim_specs with the AFTER
-- capture_substrate_outbox triggers but FORGOT the BEFORE
-- stamp_local_federated_write trigger (migs 214/314/317/318 install it per
-- federated table — the trigger list is fixed, so a new federated table must
-- attach it itself).
--
-- Without it, a local bee_claim_specs write leaves fed_ts/fed_hlc NULL: the
-- capture reads op_hlc = NULL, the PG HLC clock is never advanced, and the
-- projection's LWW guard (bee-claim-spec.ts) degrades to the null/wall-clock
-- fallback branch — two honest peers can converge on DIFFERENT specs (the
-- exact D-001 clock-skew divergence class the HLC machinery exists to prevent).
-- hive_settings (the analog P-016 copied) has this trigger; bee_claim_specs
-- must match. The BEFORE trigger also PERFORMs hlc_recv on a remote apply so the
-- receiving clock advances (mig 314 design).

BEGIN;

DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.bee_claim_specs;
CREATE TRIGGER stamp_local_federated_write_trg
  BEFORE INSERT OR UPDATE ON harness_shared.bee_claim_specs
  FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write();

COMMIT;
