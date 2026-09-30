-- 424: agent_fleets.color_scheme — bind a PERMANENT terminal color scheme to
-- each named fleet (fleet-color-schemes-2026-06-30).
--
-- The value is a scheme NAME from the curated console-color-schemes catalog
-- (e.g. 'royal-purple'). It is allocated as the next-unused scheme at
-- fleet:create and is immutable thereafter (override via fleet:recolor /
-- setFleetScheme). Nullable for back-compat: rows created before this column
-- resolve their color via a deterministic slug-hash fallback (resolveFleetScheme),
-- so no backfill is required. Fully idempotent.

ALTER TABLE harness_shared.agent_fleets ADD COLUMN IF NOT EXISTS color_scheme text;
