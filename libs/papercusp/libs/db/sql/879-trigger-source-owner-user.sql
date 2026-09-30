-- 879-trigger-source-owner-user.sql — external-triggers P-009 / D-008
--
-- Provider payload identities are untrusted external data and must never select
-- a local Personal Vault principal. Persist the authenticated local user on the
-- source row at connection time so every adapter and secondary sink reads the
-- same server-owned association.
--
-- Nullable is intentional for pre-existing and non-user-owned source kinds.
-- Provider adapters that require a user principal fail closed in the runtime
-- source-store seam when this column is absent. Deleting a local user clears the
-- association instead of cascading through trigger bindings and deliveries.

ALTER TABLE harness_shared.trigger_sources
  ADD COLUMN IF NOT EXISTS owner_user_id uuid;

DO $trigger_source_owner_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'harness_shared.trigger_sources'::regclass
       AND conname = 'trigger_sources_owner_user_id_fkey'
  ) THEN
    ALTER TABLE harness_shared.trigger_sources
      ADD CONSTRAINT trigger_sources_owner_user_id_fkey
      FOREIGN KEY (owner_user_id)
      REFERENCES harness_shared.users(id)
      ON DELETE SET NULL;
  END IF;
END
$trigger_source_owner_fk$;

CREATE INDEX IF NOT EXISTS trigger_sources_workspace_owner_idx
  ON harness_shared.trigger_sources (workspace_id, owner_user_id)
  WHERE owner_user_id IS NOT NULL;

COMMENT ON COLUMN harness_shared.trigger_sources.owner_user_id IS
  'Authenticated local user who connected this source. Never derive this value from a provider event payload or reuse created_by audit attribution.';
