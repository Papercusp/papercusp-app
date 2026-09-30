\set ON_ERROR_STOP on
BEGIN;

-- Migration 039 — encryption-at-rest for harness_shared.plugin_configs.
-- Plugin configs hold OAuth tokens + arbitrary plaintext settings written
-- by the substrate plugin loader; the file at
-- ~/.papercusp/harnesses/<slug>/plugin-configs/<plugin>.json must remain
-- plaintext (substrate reads it directly), but the PG mirror is dump-
-- exposed and easy to encrypt.
--
-- Same pattern as migration 027 (operator credentials class):
--   - Add config_ct BYTEA alongside the existing config JSONB.
--   - Reader prefers config_ct when present, falls back to config.
--   - Writer always populates config_ct; we keep config (plaintext) NULL
--     after encryption to remove the dump-leak surface.
--
-- The on-disk file at <harness>/plugin-configs/<plugin>.json is a separate
-- problem; tightening its mode to 0600 happens in the helper code.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE harness_shared.plugin_configs
  ADD COLUMN IF NOT EXISTS config_ct BYTEA;

COMMENT ON COLUMN harness_shared.plugin_configs.config_ct IS
  'pgcrypto-encrypted JSON payload (replaces plaintext config column). Decrypted via pgp_sym_decrypt with the key from ~/.papercusp/db-encryption-key (or PAPERCUSP_DB_ENCRYPTION_KEY).';

COMMIT;
