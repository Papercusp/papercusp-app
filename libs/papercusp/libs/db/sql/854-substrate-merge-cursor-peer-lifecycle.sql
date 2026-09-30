-- 854-substrate-merge-cursor-peer-lifecycle.sql
-- WI-40001 / EI-20952891450691643: retain explicit peer identity and lifecycle
-- beside the canonical durable merge cursor.
--
-- `substrate_merge_cursor` survives process restarts, but the log-key to device
-- identity mapping and admitted/revoked sets previously lived only in boot.ts
-- memory. After a restart, a historical silent cursor was therefore
-- indistinguishable from an intentionally retired peer. Silence is not a safe
-- retirement signal: unknown or unexpectedly absent peers must remain visible
-- to the PEERS ABSENT monitor.
--
-- Existing rows become `unknown` with no identity. Only a later explicit boot
-- admission/revocation writer may set `active` or `retired`, and known states
-- require the device pubkey that supplied that evidence. This is expand-only:
-- current position/apply-binding readers and writers remain byte-compatible.

ALTER TABLE harness_shared.substrate_merge_cursor
  ADD COLUMN IF NOT EXISTS peer_device_pubkey text,
  ADD COLUMN IF NOT EXISTS peer_lifecycle_state text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS peer_lifecycle_updated_at timestamptz;

DO $$
BEGIN
  ALTER TABLE harness_shared.substrate_merge_cursor
    ADD CONSTRAINT substrate_merge_cursor_peer_lifecycle_state_check
    CHECK (peer_lifecycle_state IN ('unknown', 'active', 'retired'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TABLE harness_shared.substrate_merge_cursor
    ADD CONSTRAINT substrate_merge_cursor_peer_lifecycle_identity_check
    CHECK (peer_lifecycle_state = 'unknown' OR peer_device_pubkey IS NOT NULL);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

COMMENT ON COLUMN harness_shared.substrate_merge_cursor.peer_device_pubkey IS
  'WI-40001: device signing pubkey explicitly observed for this log key; NULL means historical/unknown identity, never retired-by-inference.';

COMMENT ON COLUMN harness_shared.substrate_merge_cursor.peer_lifecycle_state IS
  'WI-40001: explicit peer lifecycle: unknown (no durable evidence), active (admitted/unrevoked), or retired (revoked/explicitly removed). Silence never writes retired.';

COMMENT ON COLUMN harness_shared.substrate_merge_cursor.peer_lifecycle_updated_at IS
  'WI-40001: time the explicit active/retired evidence was persisted; NULL for historical unknown rows.';
