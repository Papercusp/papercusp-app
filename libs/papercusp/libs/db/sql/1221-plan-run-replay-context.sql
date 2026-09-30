-- A seeded plan-run must retain the promotion context from its original
-- template. A pinned replay after the template changes repairs the original
-- instance instead of re-reading a mutable executor kind.
ALTER TABLE harness_shared.plan_runs
  ADD COLUMN IF NOT EXISTS replay_item_kind text;
