-- 027-pgcrypto-credentials.sql
--
-- Encryption-at-rest for the credentials-class tables.
--
-- The five tables below store secrets (API keys, OAuth tokens, signing-key
-- fingerprints, R2 access keys). They are NOT in zero_harness publication
-- so WS broadcast is already prevented; this migration adds a second layer
-- of defense against backup leaks, casual `pg_dump` paste, WAL filesystem
-- exposure, and similar offline-attack vectors.
--
-- Mechanism: pgcrypto's pgp_sym_encrypt / pgp_sym_decrypt with a symmetric
-- key sourced by the application from `~/.papercusp/db-encryption-key`
-- (auto-generated 32-byte random, mode 0600) or
-- `process.env.PAPERCUSP_DB_ENCRYPTION_KEY` for deploy-time override.
--
-- The schema change is additive in this migration: a new BYTEA column
-- holds the ciphertext. The application backfills existing plaintext rows
-- on first read, then a follow-up migration (or runbook) drops the
-- plaintext column. This staged approach lets us roll forward without a
-- coordinated downtime; a partially-migrated table reads correctly because
-- the helper falls back to plaintext when ciphertext is null.
--
-- After backfill + plaintext drop, every read goes through pgp_sym_decrypt
-- and every write through pgp_sym_encrypt. A leaked DB dump shows opaque
-- ciphertext bytes; only the host with the key file can read.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE harness_shared.operator_credentials
  ADD COLUMN IF NOT EXISTS payload_ct BYTEA;
ALTER TABLE harness_shared.operator_voice_credentials
  ADD COLUMN IF NOT EXISTS payload_ct BYTEA;
ALTER TABLE harness_shared.operator_marketplace_token
  ADD COLUMN IF NOT EXISTS payload_ct BYTEA;
ALTER TABLE harness_shared.operator_publish_credentials
  ADD COLUMN IF NOT EXISTS payload_ct BYTEA;
ALTER TABLE harness_shared.operator_trust_store
  ADD COLUMN IF NOT EXISTS payload_ct BYTEA;
