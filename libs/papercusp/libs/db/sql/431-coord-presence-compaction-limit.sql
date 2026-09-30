-- 431-coord-presence-compaction-limit.sql — per-session soft compaction limit.
-- Adds coord_presence.compaction_limit (int, nullable): the token target above
-- which an agent session steers toward a clean stopping point and self-compacts
-- (agent-managed-compaction-2026-07-01). Keyed by owner_id (the session SID);
-- set via config:set-compaction-limit; NULL ⇒ per-model default at read time.
--
-- The migration runner wraps each file in its own txn — NO top-level BEGIN;/COMMIT;
-- (lint:migrations, files >= 215). coord_presence carries no extra grants/RLS
-- beyond baseline, so a plain ADD COLUMN IF NOT EXISTS is sufficient.

ALTER TABLE harness_shared.coord_presence
  ADD COLUMN IF NOT EXISTS compaction_limit integer;
