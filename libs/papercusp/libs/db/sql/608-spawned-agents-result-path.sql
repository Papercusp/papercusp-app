-- WI-4894: a systemd-scoped Cup can outlive the operator process that launched
-- it. Persist the invoke-once result artifact path so a fresh operator can
-- harvest its real exit status after a deploy restart instead of false-reclaiming
-- the now-dead PID with exit_code NULL.

ALTER TABLE harness_shared.spawned_agents
  ADD COLUMN IF NOT EXISTS result_path text;
