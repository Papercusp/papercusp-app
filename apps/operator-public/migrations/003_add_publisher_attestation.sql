-- Cupboard migration 003 — channel-2 publisher attestation + ban-list (item 1).
--
-- Pattern (a): the desktop pre-attests a device-binding gist (device Ed25519
-- pubkey ↔ github login, signed by the device key) and passes its id + the
-- pubkey in the publish body. Cupboard stores them here. The hourly indexer
-- verifies (gist owner + pubkey match) and handles revocation (gist 404 →
-- clears the attestation). An operator ban-list filters banned device pubkeys
-- out of public listings. See cupboard-provisional-listing-trust-2026-06-02
-- (item 1) + substrate-revocation-model (gist-deletion = revocation).
--
-- Both columns are nullable: attestation is optional (a publish without it
-- still works — the publisher-permission signal from migration 002 applies).

ALTER TABLE harnesses ADD COLUMN publisher_device_pubkey TEXT;
ALTER TABLE harnesses ADD COLUMN publisher_attestation_gist_id TEXT;

-- Operator-managed ban-list of publisher device pubkeys. A banned pubkey's
-- listings are filtered from GET /harnesses and 404 on GET /harnesses/:id.
-- Keyed on the base64 Ed25519 pubkey (the cross-surface device identity that
-- also appears in the swarm's revoked_pubkeys).
CREATE TABLE IF NOT EXISTS banned_publisher_pubkeys (
  pubkey TEXT PRIMARY KEY NOT NULL,            -- base64 Ed25519 device pubkey
  reason TEXT NOT NULL,                         -- 'abuse' | 'spam' | 'impersonation' | ...
  added_at INTEGER NOT NULL,                    -- unix ms
  added_by_operator_user_id INTEGER,            -- nullable: imported / system ban
  updated_at INTEGER NOT NULL                   -- unix ms
);

CREATE INDEX IF NOT EXISTS banned_pubkeys_added_at_idx
  ON banned_publisher_pubkeys (added_at DESC);
