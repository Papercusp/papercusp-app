-- 874 — Personal Vault: owner-local documents, identity resolution, grants,
-- cursors, and the global kill switch.
--
-- Plan personal-vault-2026-08-22 P-001/P-004/P-005/P-008, decision D-001.
-- The vault is a separate, workspace+user-scoped corpus. It is never part of
-- the default recall fan-out: callers must present a server-resolved principal
-- that matches a live personal_grants row. Embeddings are deliberately limited
-- to EmbeddingGemma's local `gemma` space; cloud-mode vectors are rejected at
-- the database boundary as well as by the writer.
--
-- Expand-only and idempotent. Every object is new, so the currently deployed
-- release neither reads nor writes it and no forward-compat acknowledgement is
-- required.

CREATE TABLE IF NOT EXISTS harness_shared.personal_vault_settings (
  workspace_id text        NOT NULL,
  user_id      uuid        NOT NULL REFERENCES harness_shared.users(id) ON DELETE CASCADE,
  enabled      boolean     NOT NULL DEFAULT true,
  updated_by   text        NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS harness_shared.personal_documents (
  id                uuid        NOT NULL DEFAULT gen_random_uuid(),
  workspace_id      text        NOT NULL,
  user_id           uuid        NOT NULL REFERENCES harness_shared.users(id) ON DELETE CASCADE,
  source            text        NOT NULL CHECK (source ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  scope_key         text        GENERATED ALWAYS AS ('personal:' || source) STORED,
  kind              text        NOT NULL CHECK (length(btrim(kind)) > 0),
  external_id       text,
  occurred_at       timestamptz,
  participants      text[]      NOT NULL DEFAULT ARRAY[]::text[],
  participant_ids   uuid[]      NOT NULL DEFAULT ARRAY[]::uuid[],
  title             text        NOT NULL DEFAULT '',
  text              text        NOT NULL DEFAULT '',
  metadata          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key        text        NOT NULL CHECK (length(btrim(dedupe_key)) > 0),
  embedding_mode    text        CHECK (embedding_mode IS NULL OR embedding_mode = 'gemma'),
  text_tsv          tsvector    GENERATED ALWAYS AS (
    to_tsvector('english'::regconfig, coalesce(title, '') || ' ' || coalesce(text, ''))
  ) STORED,
  imported_at       timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, id),
  UNIQUE (workspace_id, user_id, source, dedupe_key)
);

-- pgvector is optional at install time. A vault on a host without it still has
-- complete lexical search and can be embedded after the extension appears.
DO $personal_vector$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    ALTER TABLE harness_shared.personal_documents
      ADD COLUMN IF NOT EXISTS embedding public.vector(768);
  END IF;
END
$personal_vector$;

CREATE INDEX IF NOT EXISTS personal_documents_source_time_idx
  ON harness_shared.personal_documents
    (workspace_id, user_id, source, occurred_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS personal_documents_scope_time_idx
  ON harness_shared.personal_documents
    (workspace_id, user_id, scope_key, occurred_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS personal_documents_text_tsv_idx
  ON harness_shared.personal_documents USING gin (text_tsv);
CREATE INDEX IF NOT EXISTS personal_documents_participants_idx
  ON harness_shared.personal_documents USING gin (participants);
CREATE INDEX IF NOT EXISTS personal_documents_participant_ids_idx
  ON harness_shared.personal_documents USING gin (participant_ids);
CREATE INDEX IF NOT EXISTS personal_documents_embedding_mode_idx
  ON harness_shared.personal_documents (workspace_id, user_id, embedding_mode)
  WHERE embedding_mode IS NOT NULL;

CREATE TABLE IF NOT EXISTS harness_shared.personal_sync_state (
  workspace_id  text        NOT NULL,
  user_id       uuid        NOT NULL REFERENCES harness_shared.users(id) ON DELETE CASCADE,
  source        text        NOT NULL CHECK (source ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  cursor        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at  timestamptz,
  last_error    text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, source)
);

CREATE TABLE IF NOT EXISTS harness_shared.personal_grants (
  id             uuid        NOT NULL DEFAULT gen_random_uuid(),
  workspace_id   text        NOT NULL,
  user_id        uuid        NOT NULL REFERENCES harness_shared.users(id) ON DELETE CASCADE,
  principal_type text        NOT NULL CHECK (principal_type IN ('plan-template', 'binding', 'agent-role')),
  principal_id   text        NOT NULL CHECK (length(btrim(principal_id)) > 0),
  scopes         text[]      NOT NULL CHECK (cardinality(scopes) > 0),
  granted_by     text        NOT NULL CHECK (length(btrim(granted_by)) > 0),
  granted_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,
  revoked_at     timestamptz,
  metadata       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, user_id, id),
  CHECK (expires_at IS NULL OR expires_at > granted_at)
);

-- New-table partial uniqueness: one live grant for an exact principal/scope set.
-- Revocation retains history and allows a later owner re-grant.
-- FORWARD-COMPAT: The currently deployed release cannot infer this partial index or target it with ON CONFLICT because personal_grants is created for the first time by this migration.
CREATE UNIQUE INDEX IF NOT EXISTS personal_grants_live_identity
  ON harness_shared.personal_grants
    (workspace_id, user_id, principal_type, principal_id, scopes)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS personal_grants_authorization_lookup
  ON harness_shared.personal_grants
    (workspace_id, user_id, principal_type, principal_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS harness_shared.personal_identities (
  id             uuid        NOT NULL DEFAULT gen_random_uuid(),
  workspace_id   text        NOT NULL,
  user_id        uuid        NOT NULL REFERENCES harness_shared.users(id) ON DELETE CASCADE,
  display_name   text        NOT NULL DEFAULT '',
  primary_email  text,
  metadata       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, id)
);

CREATE INDEX IF NOT EXISTS personal_identities_primary_email_idx
  ON harness_shared.personal_identities (workspace_id, user_id, lower(primary_email))
  WHERE primary_email IS NOT NULL;

CREATE TABLE IF NOT EXISTS harness_shared.personal_identity_aliases (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  workspace_id     text        NOT NULL,
  user_id          uuid        NOT NULL,
  identity_id      uuid        NOT NULL,
  source           text        NOT NULL CHECK (source ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  alias_kind       text        NOT NULL CHECK (alias_kind IN ('email', 'contact', 'social-handle', 'name')),
  normalized_value text        NOT NULL CHECK (length(btrim(normalized_value)) > 0),
  display_value    text        NOT NULL DEFAULT '',
  metadata         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, id),
  FOREIGN KEY (workspace_id, user_id, identity_id)
    REFERENCES harness_shared.personal_identities (workspace_id, user_id, id)
    ON DELETE CASCADE,
  UNIQUE (workspace_id, user_id, source, alias_kind, normalized_value)
);

CREATE INDEX IF NOT EXISTS personal_identity_aliases_identity_idx
  ON harness_shared.personal_identity_aliases (workspace_id, user_id, identity_id);

-- RLS is the workspace boundary. The server additionally binds every operation
-- to user_id and performs the grant decision; no direct client query receives a
-- cross-user row even inside one workspace.
ALTER TABLE harness_shared.personal_vault_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.personal_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.personal_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.personal_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.personal_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.personal_identity_aliases ENABLE ROW LEVEL SECURITY;

DO $personal_policies$
DECLARE
  tbl text;
  pol text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'personal_vault_settings',
    'personal_documents',
    'personal_sync_state',
    'personal_grants',
    'personal_identities',
    'personal_identity_aliases'
  ]
  LOOP
    pol := tbl || '_workspace_isolation';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'harness_shared'
         AND tablename = tbl
         AND policyname = pol
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON harness_shared.%I FOR ALL TO public '
        || 'USING (workspace_id = current_setting(''app.workspace_id'', true)) '
        || 'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
        pol, tbl
      );
    END IF;
  END LOOP;
END
$personal_policies$;

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.personal_vault_settings TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.personal_documents TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.personal_sync_state TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.personal_grants TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.personal_identities TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.personal_identity_aliases TO harness_app, harness_admin;

COMMENT ON TABLE harness_shared.personal_documents IS
  'Owner-local Personal Vault corpus. Never included in default recall; server-side personal_grants authorization is mandatory. embedding_mode is constrained to local EmbeddingGemma (gemma).';
COMMENT ON TABLE harness_shared.personal_grants IS
  'Default-deny owner grants for plan-template, binding, or agent-role principals. Revocation is historical (revoked_at), not destructive.';
COMMENT ON TABLE harness_shared.personal_vault_settings IS
  'Per-workspace/user global kill switch. Missing row means enabled; enabled=false makes every ingest/search/injection path refuse.';
