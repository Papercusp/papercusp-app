-- 411: widen the hive_epoch_keys federation CAPTURE trigger from AFTER INSERT to
-- AFTER INSERT OR UPDATE (shared-hive-member-content-federation-2026-06-20 D-028, BUG B).
--
-- BUG B — the epoch-key self-heal was OWNER-DB-LOCAL, never member-RECEIPT-aware. A hive
-- member that MISSED the original federated epoch-key grant (joined-after-grant /
-- forward-only cursor / re-session) could never be re-sent it. The capture trigger on
-- harness_shared.hive_epoch_keys was AFTER INSERT ONLY (mig 316), so RE-WRITING an
-- existing wrapped_key row — the refederate self-heal: putWrappedKeys ON CONFLICT DO
-- UPDATE re-stamping origin='local', fed_ts=NULL, fed_hlc=NULL so the BEFORE-stamp
-- trigger mints a fresh HLC and the member's LWW accepts the re-sent key — never
-- re-enqueued the substrate_outbox op, so the key never re-federated to the member.
--
-- FIX (layer 1 of 3): the capture must ALSO fire on UPDATE. Drop the mig-316 trigger(s)
-- and recreate ONE trigger AS AFTER INSERT OR UPDATE. The capture FUNCTION already
-- carries the echo-loop guard keyed on the ROW's `origin` column (capture_substrate_outbox,
-- mig 359):
--
--     v_origin := v_row ->> 'origin';
--     -- Echo-loop guard: skip remote-origin writes (the projection's own writes).
--     IF COALESCE(v_origin, 'local') <> 'local' THEN
--       RETURN v_rec;
--     END IF;
--
-- so an UPDATE that sets origin='local' (the refederate re-stamp) IS captured, while a
-- federated-in apply (the projection's writeToPg writes origin='remote') is NOT — no
-- federation loop. A combined INSERT OR UPDATE trigger carries NO WHEN clause (a WHEN
-- referencing OLD is invalid on INSERT); the origin guard inside the function is the gate.
--
-- Additive + idempotent. DROP ... IF EXISTS tolerates BOTH shapes: the AFTER-INSERT-only
-- single trigger on an already-migrated DB, and the two-trigger (INSERT + WHEN-gated
-- UPDATE) shape a fresh DB built from the edited mig-316 source carries. Both converge on
-- the one AFTER INSERT OR UPDATE trigger. The runner wraps this file in its own txn
-- (migration-runner.js contract) — NO top-level BEGIN;/COMMIT; (lint:migrations).

DROP TRIGGER IF EXISTS capture_hive_epoch_keys_outbox_trg ON harness_shared.hive_epoch_keys;
DROP TRIGGER IF EXISTS capture_hive_epoch_keys_outbox_upd_trg ON harness_shared.hive_epoch_keys;

CREATE OR REPLACE TRIGGER capture_hive_epoch_keys_outbox_trg
  AFTER INSERT OR UPDATE ON harness_shared.hive_epoch_keys
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('epoch_key_fed_key');
