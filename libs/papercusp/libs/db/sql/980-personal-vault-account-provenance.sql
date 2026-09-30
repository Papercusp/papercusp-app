-- 980-personal-vault-account-provenance.sql — history readiness P-008
--
-- Account provenance stays nullable for old offline archives. Backfill only
-- when exactly one owned live source makes attribution unambiguous.
-- FORWARD-COMPAT: this expand-only migration adds nullable columns, indexes,
-- and a null-tolerant check, then updates rows in place; deployed writers keep
-- using the existing columns and dedupe arbiter throughout the rollout.

ALTER TABLE harness_shared.personal_documents
  ADD COLUMN IF NOT EXISTS source_id uuid,
  ADD COLUMN IF NOT EXISTS provider_account_id text;

DO $personal_account_checks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'harness_shared.personal_documents'::regclass
       AND conname = 'personal_documents_provider_account_nonempty'
  ) THEN
    ALTER TABLE harness_shared.personal_documents
      ADD CONSTRAINT personal_documents_provider_account_nonempty
      CHECK (provider_account_id IS NULL OR length(btrim(provider_account_id)) > 0);
  END IF;
END
$personal_account_checks$;

WITH unambiguous_sources AS (
  SELECT workspace_id, owner_user_id,
         CASE kind WHEN 'gmail' THEN 'gmail'
                   WHEN 'gcal' THEN 'calendar'
                   WHEN 'facebook' THEN 'facebook' END AS personal_source,
         min(id::text)::uuid AS source_id,
         min(provider_account_id) AS provider_account_id
    FROM harness_shared.trigger_sources
   WHERE owner_user_id IS NOT NULL
     AND provider_account_id IS NOT NULL
     AND kind IN ('gmail', 'gcal', 'facebook')
   GROUP BY workspace_id, owner_user_id, kind
  HAVING count(*) = 1
)
UPDATE harness_shared.personal_documents AS document
   SET source_id = source.source_id,
       provider_account_id = source.provider_account_id,
       updated_at = now()
  FROM unambiguous_sources AS source
 WHERE document.workspace_id = source.workspace_id
   AND document.user_id = source.owner_user_id
   AND document.source = source.personal_source
   AND document.source_id IS NULL
   AND document.provider_account_id IS NULL;

UPDATE harness_shared.personal_documents
   SET dedupe_key = 'account:'
                    || encode(digest(provider_account_id, 'sha256'), 'hex')
                    || ':' || dedupe_key,
       updated_at = now()
 WHERE provider_account_id IS NOT NULL
   AND dedupe_key !~ '^account:[0-9a-f]{64}:';

CREATE INDEX IF NOT EXISTS personal_documents_account_time_idx
  ON harness_shared.personal_documents
    (workspace_id, user_id, source, provider_account_id, occurred_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS personal_documents_source_id_idx
  ON harness_shared.personal_documents (workspace_id, user_id, source_id)
  WHERE source_id IS NOT NULL;

COMMENT ON COLUMN harness_shared.personal_documents.source_id IS
  'Canonical trigger-source identity for live provenance; nullable when offline attribution is unknown.';
COMMENT ON COLUMN harness_shared.personal_documents.provider_account_id IS
  'Provider-native account identity used by account-scoped dedupe, search, status, and purge.';
