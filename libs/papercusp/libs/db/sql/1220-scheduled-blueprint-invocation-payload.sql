-- Retain the exact accepted input for a legacy scheduled blueprint work-item.
-- A DBOS routine replay may resolve a newer blueprint after the receipt was
-- reserved; the persisted payload and target id keep that fire on its original
-- accepted task rather than minting another item from the new definition.
ALTER TABLE harness_shared.blueprint_operation_invocations
  ADD COLUMN IF NOT EXISTS request_payload jsonb;

DO $constraints$ BEGIN
  ALTER TABLE harness_shared.blueprint_operation_invocations
    ADD CONSTRAINT blueprint_operation_invocations_payload_object
    CHECK (request_payload IS NULL OR jsonb_typeof(request_payload) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL;
END $constraints$;
