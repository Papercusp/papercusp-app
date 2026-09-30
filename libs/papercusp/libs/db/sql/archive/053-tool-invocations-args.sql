-- 053-tool-invocations-args.sql
--
-- Add args_json to harness_shared.tool_invocations so the /dev Sessions
-- drilldown can replay calls exactly (and not just restore context).
-- Capped at ~32KB worth of compact JSON by the writer; larger payloads
-- get truncated with a {_truncated: true, _size: N} marker.
--
-- Backfill: NULL for existing rows. Safe — readers tolerate null.

ALTER TABLE harness_shared.tool_invocations
  ADD COLUMN IF NOT EXISTS args_json jsonb;
