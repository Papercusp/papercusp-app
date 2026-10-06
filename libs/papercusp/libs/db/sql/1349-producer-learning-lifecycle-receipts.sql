-- EI-24932377195872399: reuse the six source stores for common staged receipts.
-- Historical rows stay NULL (unmeasured). No backfill invents experiment/spend pins.
-- Source data and receipts are updated in one transaction by production writers.
ALTER TABLE harness_shared.scout_routed_ideas ADD COLUMN IF NOT EXISTS learning_lifecycle jsonb;
ALTER TABLE harness_shared.gym_proposals ADD COLUMN IF NOT EXISTS learning_lifecycle jsonb;
ALTER TABLE harness_shared.calibration_predictions ADD COLUMN IF NOT EXISTS learning_lifecycle jsonb;
ALTER TABLE harness_shared.transfer_lessons ADD COLUMN IF NOT EXISTS learning_lifecycle jsonb;
ALTER TABLE harness_shared.regret_findings ADD COLUMN IF NOT EXISTS learning_lifecycle jsonb;
ALTER TABLE harness_shared.red_queen_drills ADD COLUMN IF NOT EXISTS learning_lifecycle jsonb;
