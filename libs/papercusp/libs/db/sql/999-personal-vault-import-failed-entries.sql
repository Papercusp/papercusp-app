-- 999-personal-vault-import-failed-entries.sql — Personal Vault import fidelity
-- WI-186395: retain an unbounded failure count beside the bounded warning list.
--
-- The warning array remains intentionally capped for response/storage safety, but
-- a capped list cannot quantify loss. This additive counter lets an owner tell
-- whether documents were dropped even after the first 100 warnings.

ALTER TABLE harness_shared.personal_vault_import_jobs
  ADD COLUMN IF NOT EXISTS entries_failed bigint NOT NULL DEFAULT 0;

DO $entries_failed_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'harness_shared.personal_vault_import_jobs'::regclass
       AND conname = 'personal_vault_import_entries_failed_nonnegative'
  ) THEN
    ALTER TABLE harness_shared.personal_vault_import_jobs
      ADD CONSTRAINT personal_vault_import_entries_failed_nonnegative
      CHECK (entries_failed >= 0);
  END IF;
END
$entries_failed_constraint$;
