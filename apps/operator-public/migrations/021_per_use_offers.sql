-- Executable per-use offer terms (shared-pot DAO plan P-028).
--
-- `commerce_ledger_events` remains the source of truth. These columns are the
-- D1 projection used by the hosted catalog/read doors, so a buyer can inspect
-- the exact signed microcharge terms without replaying the whole event log.

ALTER TABLE commerce_offers ADD COLUMN unit_price_micros INTEGER;
ALTER TABLE commerce_offers ADD COLUMN meter_unit TEXT;
ALTER TABLE commerce_offers ADD COLUMN price_version TEXT;
ALTER TABLE commerce_offers ADD COLUMN split_manifest_hash TEXT;

