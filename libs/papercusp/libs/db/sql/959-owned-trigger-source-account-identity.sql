-- 959-owned-trigger-source-account-identity.sql — WI-41703
--
-- A local owner may connect more than one account from the same provider. The
-- provider-account identity is deliberately separate from credential_ref: a
-- reconnect may rotate the opaque token field without replacing the source row
-- (and therefore without replacing its cursor, bindings, or delivery history).
--
-- FORWARD-COMPAT: this already-applied migration was not safe in isolation:
-- the deployed writer still targets the legacy owner+kind ON CONFLICT arbiter.
-- Migration 960 restores that exact index for the deploy window before this
-- account-aware tree may ship; a later CONTRACT migration may remove it only
-- after the new writer is deployed. This is an incident acknowledgment and
-- expand/contract repair record, not a claim that the deployed release ignored
-- the dropped index.

ALTER TABLE harness_shared.trigger_sources
  ADD COLUMN IF NOT EXISTS provider_account_id text;

-- Preserve every existing source id and cursor. Existing provider suites share
-- one credential_ref across their source kinds, so that reference is the
-- strongest account identity available without contacting the provider. A
-- disconnected legacy suite falls back to one owner-scoped identity.
UPDATE harness_shared.trigger_sources
   SET provider_account_id = COALESCE(
         NULLIF(btrim(credential_ref), ''),
         'legacy-owner:' || owner_user_id::text
       )
 WHERE owner_user_id IS NOT NULL
   AND provider_account_id IS NULL;

DROP INDEX IF EXISTS harness_shared.trigger_sources_owned_user_kind_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS trigger_sources_owned_account_kind_uidx
  ON harness_shared.trigger_sources
    (workspace_id, kind, owner_user_id, provider_account_id)
  WHERE owner_user_id IS NOT NULL AND provider_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS trigger_sources_workspace_owner_account_idx
  ON harness_shared.trigger_sources
    (workspace_id, owner_user_id, provider_account_id)
  WHERE owner_user_id IS NOT NULL AND provider_account_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'trigger_sources_provider_account_nonempty'
       AND conrelid = 'harness_shared.trigger_sources'::regclass
  ) THEN
    ALTER TABLE harness_shared.trigger_sources
      ADD CONSTRAINT trigger_sources_provider_account_nonempty
      CHECK (
        owner_user_id IS NULL
        OR (provider_account_id IS NOT NULL AND btrim(provider_account_id) <> '')
      );
  END IF;
END $$;

COMMENT ON COLUMN harness_shared.trigger_sources.provider_account_id IS
  'Stable owner-bound provider account identity. Credential references may rotate on surgical reconnect.';

COMMENT ON INDEX harness_shared.trigger_sources_owned_account_kind_uidx IS
  'One source kind per workspace/local-owner/provider-account; distinct provider accounts keep independent rows and cursors.';
