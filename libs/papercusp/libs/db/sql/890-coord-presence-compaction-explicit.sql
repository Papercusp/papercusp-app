-- 890-coord-presence-compaction-explicit.sql — WI-40653
--
-- Preserve whether a stored soft compaction limit was deliberately chosen at
-- runtime (config:set-compaction-limit / an explicit leader override) or was
-- derived by the watchdog. Existing rows are legacy derived values.

ALTER TABLE harness_shared.coord_presence
  ADD COLUMN IF NOT EXISTS compaction_limit_explicit boolean NOT NULL DEFAULT false;
