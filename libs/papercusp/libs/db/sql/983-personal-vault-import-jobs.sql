-- 983-personal-vault-import-jobs.sql — Gmail/Facebook history readiness P-009
-- Armed under gmail-facebook-history-production-readiness-2026-08-25#D-016
-- after real-PG admission/cleanup coverage and migration lints passed.
--
-- Durable, account-scoped jobs replace request-bound archive parsing. The HTTP
-- route only streams the owner-selected archive into private workspace storage;
-- this table owns idempotency, bounded progress, cancellation, retry leases,
-- and crash-resume checkpoints for the background system routine.
--
-- FORWARD-COMPAT: every object is additive. The routine host fail-soft skips an
-- unknown `system:personal-vault-import` target until the matching handler is
-- deployed, so an early migration cannot consume or mutate a queued archive.

CREATE TABLE IF NOT EXISTS harness_shared.personal_vault_import_jobs (
  id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
  workspace_id          text        NOT NULL,
  user_id               uuid        NOT NULL REFERENCES harness_shared.users(id) ON DELETE CASCADE,
  source_id             uuid,
  provider_account_id   text,
  filename              text        NOT NULL CHECK (length(btrim(filename)) BETWEEN 1 AND 1024),
  storage_path          text,
  content_type          text,
  content_sha256        text        NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key       text        NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  size_bytes            bigint      NOT NULL CHECK (size_bytes >= 0),
  status                text        NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  bytes_processed       bigint      NOT NULL DEFAULT 0 CHECK (bytes_processed >= 0),
  entries_processed     integer     NOT NULL DEFAULT 0 CHECK (entries_processed >= 0),
  documents_seen        bigint      NOT NULL DEFAULT 0 CHECK (documents_seen >= 0),
  documents_imported    bigint      NOT NULL DEFAULT 0 CHECK (documents_imported >= 0),
  checkpoint            jsonb       NOT NULL DEFAULT '{"entryIndex":0,"recordIndex":0}'::jsonb,
  warnings              jsonb       NOT NULL DEFAULT '[]'::jsonb,
  cancel_requested      boolean     NOT NULL DEFAULT false,
  attempt_count         integer     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts          integer     NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at       timestamptz NOT NULL DEFAULT now(),
  lease_owner           text,
  lease_expires_at      timestamptz,
  retained_until        timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  last_error            text,
  started_at            timestamptz,
  completed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, id),
  UNIQUE (workspace_id, user_id, idempotency_key),
  CONSTRAINT personal_vault_import_source_account_pair CHECK (
    source_id IS NULL OR provider_account_id IS NOT NULL
  ),
  CONSTRAINT personal_vault_import_storage_lifecycle CHECK (
    storage_path IS NOT NULL OR status IN ('completed', 'cancelled')
  ),
  CONSTRAINT personal_vault_import_lease_shape CHECK (
    (status = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  )
);

-- An upload does not have its content digest/idempotency identity until the
-- request body has finished streaming. Reserve aggregate capacity first so a
-- crash (or concurrent requests) cannot consume unaccounted disk before the
-- durable import-job row exists.
CREATE TABLE IF NOT EXISTS harness_shared.personal_vault_import_uploads (
  id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
  workspace_id          text        NOT NULL,
  user_id               uuid        NOT NULL REFERENCES harness_shared.users(id) ON DELETE CASCADE,
  filename              text        NOT NULL CHECK (length(btrim(filename)) BETWEEN 1 AND 1024),
  storage_path          text        NOT NULL,
  declared_size_bytes   bigint      CHECK (declared_size_bytes > 0),
  reserved_bytes        bigint      NOT NULL CHECK (reserved_bytes > 0),
  received_bytes        bigint      NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
  expires_at            timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, id),
  UNIQUE (workspace_id, storage_path),
  CONSTRAINT personal_vault_import_upload_declared_reservation CHECK (
    declared_size_bytes IS NULL OR declared_size_bytes <= reserved_bytes
  ),
  CONSTRAINT personal_vault_import_upload_received_reservation CHECK (
    received_bytes <= reserved_bytes
  )
);

CREATE INDEX IF NOT EXISTS personal_vault_import_jobs_claim_idx
  ON harness_shared.personal_vault_import_jobs
    (workspace_id, status, next_attempt_at, created_at)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS personal_vault_import_jobs_owner_idx
  ON harness_shared.personal_vault_import_jobs
    (workspace_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS personal_vault_import_jobs_retention_idx
  ON harness_shared.personal_vault_import_jobs (workspace_id, retained_until)
  WHERE storage_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS personal_vault_import_uploads_expiry_idx
  ON harness_shared.personal_vault_import_uploads (workspace_id, expires_at);
CREATE INDEX IF NOT EXISTS personal_vault_import_uploads_owner_idx
  ON harness_shared.personal_vault_import_uploads
    (workspace_id, user_id, created_at DESC);

ALTER TABLE harness_shared.personal_vault_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.personal_vault_import_uploads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS personal_vault_import_jobs_workspace_isolation
  ON harness_shared.personal_vault_import_jobs;
CREATE POLICY personal_vault_import_jobs_workspace_isolation
  ON harness_shared.personal_vault_import_jobs FOR ALL TO public
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
DROP POLICY IF EXISTS personal_vault_import_uploads_workspace_isolation
  ON harness_shared.personal_vault_import_uploads;
CREATE POLICY personal_vault_import_uploads_workspace_isolation
  ON harness_shared.personal_vault_import_uploads FOR ALL TO public
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.personal_vault_import_jobs TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.personal_vault_import_uploads TO harness_app, harness_admin;

COMMENT ON TABLE harness_shared.personal_vault_import_jobs IS
  'Owner/workspace/account-scoped Personal Vault archive jobs. Raw archives are deleted on completion/cancellation and after bounded failed-job retention.';
COMMENT ON TABLE harness_shared.personal_vault_import_uploads IS
  'Short-lived pre-job capacity reservations for partial encrypted Personal Vault uploads; promoted atomically into import jobs after finalization.';

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.personal_vault_import_jobs
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.personal_vault_import_uploads
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();

-- Ten-second cadence: one replay-safe worker claims at most one job per fire.
-- A running job carries a renewable lease, so crash recovery is deterministic.
INSERT INTO harness_shared.routines
  (id, install_slug, workspace_id, name, trigger_kind, trigger_config,
   target_role, concurrency, catchup, active, next_fire_at, tier)
VALUES
  ('rt_papercusp_personal_vault_import', 'papercusp', 'papercusp-workspace',
   'personal-vault-import', 'cron',
   '{"cron":"5/10 * * * * *","batch_size":100,"lease_seconds":600}'::jsonb,
   'system:personal-vault-import', 'skip', 'skip-old', TRUE, now(), 'durable')
ON CONFLICT (install_slug, name) DO UPDATE SET
  workspace_id = EXCLUDED.workspace_id,
  trigger_kind = EXCLUDED.trigger_kind,
  trigger_config = EXCLUDED.trigger_config,
  target_role = EXCLUDED.target_role,
  concurrency = EXCLUDED.concurrency,
  catchup = EXCLUDED.catchup,
  tier = EXCLUDED.tier,
  active = harness_shared.routines.active,
  updated_at = now();
