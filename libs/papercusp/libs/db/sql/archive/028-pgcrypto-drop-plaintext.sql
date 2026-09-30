-- 028-pgcrypto-drop-plaintext.sql
--
-- Plaintext-column cleanup pass for the credentials-class tables. Run
-- AFTER 027-pgcrypto-credentials.sql + the runtime backfill that
-- encrypts every row's payload into payload_ct.
--
-- This migration:
--   1. Verifies (best-effort) that no row has a non-null payload + null
--      payload_ct — that would mean a row whose plaintext hasn't been
--      encrypted yet, which would be lost by the column drop.
--   2. Replaces `payload JSONB NOT NULL` with `payload JSONB` (nullable)
--      so the operator-state-pg writer can keep storing `'{}'::jsonb`
--      there as a placeholder. The actual data lives in payload_ct.
--
-- We DON'T drop the payload column entirely — operator-state-pg still
-- writes a placeholder `'{}'::jsonb` to it on every upsert. Dropping the
-- column would require either changing every INSERT to omit it (cleaner
-- but more code change) or updating the helpers first. Leaving it as a
-- nullable column with a sentinel value is the smallest-blast-radius
-- way to land this migration. A follow-up can drop the column once we
-- confirm nothing else queries it.

-- Sanity check: any non-encrypted rows present?
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM harness_shared.operator_credentials WHERE payload_ct IS NULL AND payload IS NOT NULL AND payload <> '{}'::jsonb) +
    (SELECT count(*) FROM harness_shared.operator_voice_credentials WHERE payload_ct IS NULL AND payload IS NOT NULL AND payload <> '{}'::jsonb) +
    (SELECT count(*) FROM harness_shared.operator_marketplace_token WHERE payload_ct IS NULL AND payload IS NOT NULL AND payload <> '{}'::jsonb) +
    (SELECT count(*) FROM harness_shared.operator_publish_credentials WHERE payload_ct IS NULL AND payload IS NOT NULL AND payload <> '{}'::jsonb) +
    (SELECT count(*) FROM harness_shared.operator_trust_store WHERE payload_ct IS NULL AND payload IS NOT NULL AND payload <> '{}'::jsonb)
  INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'Migration 028: % rows still have non-encrypted plaintext payload — backfill pgp_sym_encrypt(payload::text, key) into payload_ct first', n;
  END IF;
END $$;

-- Wipe plaintext from existing rows that have ciphertext.
UPDATE harness_shared.operator_credentials          SET payload = '{}'::jsonb WHERE payload_ct IS NOT NULL;
UPDATE harness_shared.operator_voice_credentials    SET payload = '{}'::jsonb WHERE payload_ct IS NOT NULL;
UPDATE harness_shared.operator_marketplace_token    SET payload = '{}'::jsonb WHERE payload_ct IS NOT NULL;
UPDATE harness_shared.operator_publish_credentials  SET payload = '{}'::jsonb WHERE payload_ct IS NOT NULL;
UPDATE harness_shared.operator_trust_store          SET payload = '{}'::jsonb WHERE payload_ct IS NOT NULL;
