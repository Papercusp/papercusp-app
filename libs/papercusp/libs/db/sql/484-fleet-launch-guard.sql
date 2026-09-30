-- 484: agent_fleets launch-guard columns — CROSS-WORKER idempotency for
-- fleet:launch-on-plan.
--
-- Why: the P-005 relaunch guard was a module-scoped in-process Map, but :3070
-- serves MCP from a multi-process worker pool — each rapid re-fire of
-- fleet:launch-on-plan can land on a different worker whose map is empty. On
-- 2026-07-03 an ornith leader re-called the tool 7× in 40s ("launch" used as a
-- status check); 6 calls each won their worker's first-hit and opened 2
-- terminals apiece — 12 unwanted desktop windows. The guard state must live
-- where all workers share it: this table.
--
-- last_launch_at is epoch-ms (matches created_at/updated_at). Null = no launch
-- recorded / slot released after a fully-failed spawn.
--
-- Fully idempotent.

ALTER TABLE harness_shared.agent_fleets ADD COLUMN IF NOT EXISTS last_launch_at bigint;
ALTER TABLE harness_shared.agent_fleets ADD COLUMN IF NOT EXISTS last_launch_count integer;
