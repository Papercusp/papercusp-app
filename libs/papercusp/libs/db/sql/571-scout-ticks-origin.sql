-- 571-scout-ticks-origin.sql
--
-- su-ideate-learning-substrate-2026-07-10 P-010: add an ORIGIN dimension to the
-- Scout tick ledger (harness_shared.scout_ticks, migration 208) — the SAME
-- partition move migration 471 made on the routed-idea ledger.
--
-- WHY: su sessions in IDEATE mode run their own "ideate passes"
-- (blender:ideate-pass-record) that we want to observe on the SAME durable tick
-- ledger as the scout-cycle routine — but a su-ideate pass is NOT a Scout cycle.
-- Without a discriminator a su-ideate status='ran' tick would
--   (a) reset Scout's CADENCE floor — readLastScoutRunAtMs / readLastRanTickAtMs
--       measure the last status IN ('ran','fired') tick, so a foreign 'ran' tick
--       would gate the next real Scout cycle as 'min-interval' (the EI-1600
--       dark-Scout failure), and
--   (b) MASK a dead Scout in the learning-loop health read (max(tick_at)) and
--       hijack the Learning tab's Scout view (last-tick display).
-- This column lets su-ideate ticks ride the ledger while every Scout reader
-- filters origin='scout'. An origin is NOT a pseudo-gate — just a provenance
-- dimension (D-009, mirroring the routed-ledger split).
--
-- Backfill-safe: every existing row is a Scout tick, so the NOT NULL DEFAULT
-- 'scout' backfills them correctly and each reader that now filters
-- origin='scout' returns exactly today's set. ADD COLUMN with a constant DEFAULT
-- is a metadata-only change in PG (no table rewrite); idempotent; additive.

ALTER TABLE harness_shared.scout_ticks
    ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'scout';

-- Scout readers filter (workspace_id, ..., origin='scout'); the su-ideate
-- partition reader filters origin='su-ideate'. Index the dimension so both stay
-- cheap (mirrors scout_routed_ideas_ws_origin_idx from migration 471).
CREATE INDEX IF NOT EXISTS scout_ticks_ws_origin_idx
    ON harness_shared.scout_ticks (workspace_id, origin);
