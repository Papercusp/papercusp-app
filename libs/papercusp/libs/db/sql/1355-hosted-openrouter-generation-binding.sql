-- P004: extend the existing append-only usage receipt rail, not a second ledger.
-- Private references/fingerprints identify the actual execution key, never its
-- value. Only the initial unpriced receipt binds a globally unique generation.
-- FORWARD-COMPAT: all pre-existing rows and older-release INSERTs leave the newly added nullable binding columns NULL, outside the new partial unique index. Only the new server binding writer sets these columns; ordinary receipt identity, exact costs, tenant FKs and append-only grants are unchanged. RealPG tests preserve the old writer and exercise concurrent binding/foreign-tenant refusals.
ALTER TABLE papercusp_auth.hosted_usage_receipts
  ADD COLUMN IF NOT EXISTS openrouter_credential_ref text,
  ADD COLUMN IF NOT EXISTS openrouter_key_sha256 text,
  ADD COLUMN IF NOT EXISTS openrouter_is_byok boolean;
DO $guard$
BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hosted_usage_openrouter_binding'
               AND conrelid = 'papercusp_auth.hosted_usage_receipts'::regclass) THEN
  ALTER TABLE papercusp_auth.hosted_usage_receipts ADD CONSTRAINT hosted_usage_openrouter_binding CHECK (
    (openrouter_credential_ref IS NULL AND openrouter_key_sha256 IS NULL AND openrouter_is_byok IS NULL)
    OR (openrouter_credential_ref IS NOT NULL AND openrouter_key_sha256 IS NOT NULL AND openrouter_is_byok IS NOT NULL
        AND provider = 'openrouter' AND revision = 1 AND cost_source = 'unpriced' AND cost_micros IS NULL
        AND category = 'inference-fees' AND quantity = 1 AND unit = 'generations'
        AND usage_id ~ '^gen-[0-9A-Za-z-]{1,124}$'
        AND openrouter_key_sha256 ~ '^[a-f0-9]{64}$'
        AND length(openrouter_credential_ref) <= 256
        AND openrouter_credential_ref ~ '^(env:[A-Za-z_][A-Za-z0-9_]*|file:/[A-Za-z0-9._/-]+)$'));
END IF;
END;
$guard$;
CREATE UNIQUE INDEX IF NOT EXISTS hosted_usage_openrouter_generation_binding_uidx
  ON papercusp_auth.hosted_usage_receipts (provider, usage_id) WHERE openrouter_credential_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS hosted_usage_openrouter_generation_idx
  ON papercusp_auth.hosted_usage_receipts (provider, usage_id) WHERE provider = 'openrouter';
COMMENT ON COLUMN papercusp_auth.hosted_usage_receipts.openrouter_credential_ref IS
  'Private server-captured execution key reference; excluded from public usage receipts/statements.';
COMMENT ON COLUMN papercusp_auth.hosted_usage_receipts.openrouter_key_sha256 IS
  'SHA-256 of the key used by execution; collection refuses rotation to an unrelated key.';
