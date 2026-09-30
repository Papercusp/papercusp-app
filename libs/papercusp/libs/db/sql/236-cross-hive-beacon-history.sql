-- 236-cross-hive-beacon-history.sql
-- Beacon snapshot history for the tier-4 dossier (hive-network-surface-2026-06-11
-- P-014, item 2). Each time a foreign hive's directory announce carries a C-2
-- beacon and is accepted, one row is appended here — so the dossier tab can show
-- how a hive's status has evolved over time (liveAgents, queueDepth, focus etc.).
--
-- Scoped to a single process (per-device, not federated). The beacon payload is
-- stored as jsonb so new beacon fields (C-2 extensions, D-003 roll-up shape) are
-- stored without a schema migration. Column constraints mirror
-- cross_hive_outbox (mig 196) conventions.
\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS harness_shared.cross_hive_beacon_history (
    id           uuid        NOT NULL DEFAULT gen_random_uuid(),
    hive_id      text        NOT NULL,    -- DiscoveredHive.hiveId
    hive_pubkey  text,                    -- DiscoveredHive.hivePubkey (may be absent)
    beacon       jsonb       NOT NULL,    -- the sanitized HiveStatusBeacon object
    captured_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cross_hive_beacon_history_pkey PRIMARY KEY (id),
    CONSTRAINT cross_hive_beacon_history_hive_id_nonempty CHECK (hive_id <> '')
);

-- Primary read path: newest-first history for a given hive (the dossier panel).
CREATE INDEX IF NOT EXISTS cross_hive_beacon_history_hive_captured_idx
  ON harness_shared.cross_hive_beacon_history (hive_id, captured_at DESC);

GRANT SELECT, INSERT ON harness_shared.cross_hive_beacon_history TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.cross_hive_beacon_history TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;
