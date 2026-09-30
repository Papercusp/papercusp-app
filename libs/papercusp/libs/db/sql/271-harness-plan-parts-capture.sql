-- 271: capture trigger on harness_plan_parts — per-PART plan federation
-- (plan-federation-regrain-2026-06-13 P-005). Mirrors hive_settings mig 186.
--
-- Enqueues LOCAL part writes into substrate_outbox keyed on part_fed_key
-- (= plan_slug || '/' || part_key, the generated column, mig 270), which the
-- drain federates and the 'plan-parts' projection (projections/harness-plan-parts.ts)
-- applies on peers. The echo-guard in capture_substrate_outbox skips writes whose
-- origin <> 'local', so the projection's OWN applied parts (written origin='remote')
-- are NOT re-federated. UPDATE fires only on a real federated-field change (body /
-- ordinal / tombstone / kind / fed_ts), never on a created_at/updated_at bump.
--
-- DARK: nothing writes harness_plan_parts LOCALLY (origin='local') until the
-- flag-gated reconcile lands behind papercusp-plan-part-federation, so this trigger
-- never fires in practice until the cutover. The op-key map + register-all +
-- table-registry already classify harness_plan_parts as peer-log; this is its
-- producer (the P-011 capture-coverage guard's CDC producer). Idempotent.
--
-- The migration runner wraps each file in its own transaction (and strips psql
-- metacommands), so this file carries NO top-level BEGIN;/COMMIT;/\set — an inner
-- COMMIT would end the runner's wrapper txn early and break apply+ledger atomicity
-- (migration-runner.js contract; lint:migrations).

CREATE OR REPLACE TRIGGER capture_harness_plan_parts_outbox_trg
  AFTER INSERT ON harness_shared.harness_plan_parts
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('part_fed_key');

CREATE OR REPLACE TRIGGER capture_harness_plan_parts_outbox_upd_trg
  AFTER UPDATE ON harness_shared.harness_plan_parts
  FOR EACH ROW WHEN (
    OLD.body IS DISTINCT FROM NEW.body
    OR OLD.ordinal IS DISTINCT FROM NEW.ordinal
    OR OLD.tombstone IS DISTINCT FROM NEW.tombstone
    OR OLD.kind IS DISTINCT FROM NEW.kind
    OR OLD.fed_ts IS DISTINCT FROM NEW.fed_ts
  )
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('part_fed_key');
