-- Extend the existing attempt ledger; NULL preserves legacy USD-only rows.
-- Reserved resource bounds remain committed after monetary settlement. They
-- are ceilings, never measured usage or evidence of a provider charge.
ALTER TABLE harness_shared.learning_spend_reservations
  ADD COLUMN IF NOT EXISTS arm_id text,
  ADD COLUMN IF NOT EXISTS reserved_input_tokens bigint,
  ADD COLUMN IF NOT EXISTS reserved_output_tokens bigint;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'harness_shared.learning_spend_reservations'::regclass
      AND conname = 'learning_reservation_resources_valid') THEN
    ALTER TABLE harness_shared.learning_spend_reservations
      ADD CONSTRAINT learning_reservation_resources_valid CHECK (
        (arm_id IS NULL AND reserved_input_tokens IS NULL AND reserved_output_tokens IS NULL)
        OR (arm_id IS NOT NULL AND length(btrim(arm_id)) BETWEEN 1 AND 256
          AND reserved_input_tokens IS NOT NULL AND reserved_input_tokens BETWEEN 0 AND 9007199254740991
          AND reserved_output_tokens IS NOT NULL AND reserved_output_tokens BETWEEN 1 AND 9007199254740991)
      );
  END IF;
END $$;
