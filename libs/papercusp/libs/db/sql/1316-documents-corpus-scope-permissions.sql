-- 1316 — One documents corpus: scope + source-derived permission lists.
--
-- Plan enterprise-data-sources-2026-10-01 P-014 (WI-10005050), owner ruling D-005:
-- generalize personal_documents into ONE documents corpus with a scope
-- (personal | organization | pot) and a source-derived permission list; there is
-- no separate organization table. D-002: a provider identity (Slack member, Asana
-- user, OAuth subject) never selects a local principal; it maps to a local user
-- only through an explicit, owner-controlled mapping (provider_identity_mappings).
--
-- EXPAND step of an expand/contract change. The table keeps its name here; the
-- rename personal_documents -> documents is a separate later migration (leader
-- ruling on D-009(c): allowed after 2026-10-01T23:16:20Z, with main-branch readers
-- kept working through it).
--
-- Existing rows are untouched in meaning: every one becomes scope = 'personal'
-- (the column default) and keeps its user_id. An organization row has
-- user_id IS NULL, so every existing personal read (all of which bind
-- d.user_id = <owner>) can never return one.
--
-- FORWARD-COMPAT: the deployed release never names personal_documents_pkey and never upserts ON CONFLICT on (workspace_id, user_id, id); its only document conflict target, the (workspace_id, user_id, source, dedupe_key) unique, is kept unchanged. It always supplies user_id, so dropping NOT NULL and swapping the primary key to (workspace_id, id) cannot change any statement it runs. The partial unique indexes are on rows it never writes (scope <> 'personal') or on tables it never reads.
--
-- lint-migrations: allow-index-swap PK (workspace_id,user_id,id) -> (workspace_id,id) plus two NEW partial uniques; verified 2026-10-01 (su-cb96f15f, WI-10005049) that no ON CONFLICT targets the old PK in the working tree, the deployed papercup-release checkout, or the bundled desktop sidecar serve.mjs — every personal_documents upsert there targets (workspace_id, user_id, source, dedupe_key), which this migration leaves unchanged; the new organization upsert (data-sources/documents-corpus.ts) names its own partial index with WHERE scope = 'organization'.

-- 1. Source-derived permission lists. One list per (source, source_ref): e.g. a
--    Slack channel, an Asana project. Its members are PROVIDER identities, copied
--    from the source and replaced as a set whenever the source reports a change.
CREATE TABLE IF NOT EXISTS harness_shared.document_permission_lists (
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  workspace_id  text        NOT NULL,
  source        text        NOT NULL CHECK (source ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  source_ref    text        NOT NULL CHECK (length(btrim(source_ref)) > 0),
  title         text        NOT NULL DEFAULT '',
  refreshed_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_permission_lists_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT document_permission_lists_source_ref_key UNIQUE (workspace_id, source, source_ref)
);

CREATE TABLE IF NOT EXISTS harness_shared.document_permission_members (
  workspace_id      text        NOT NULL,
  list_id           uuid        NOT NULL,
  provider          text        NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  provider_user_id  text        NOT NULL CHECK (length(btrim(provider_user_id)) > 0),
  added_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_permission_members_pkey
    PRIMARY KEY (workspace_id, list_id, provider, provider_user_id),
  CONSTRAINT document_permission_members_list_fk
    FOREIGN KEY (workspace_id, list_id)
    REFERENCES harness_shared.document_permission_lists (workspace_id, id) ON DELETE CASCADE
);

-- Reverse path for retrieval: from a principal's mapped provider identities to the
-- lists that contain them.
CREATE INDEX IF NOT EXISTS document_permission_members_identity_idx
  ON harness_shared.document_permission_members (workspace_id, provider, provider_user_id);

-- 2. Explicit provider identity -> local user mapping (D-002). Never inferred from a
--    payload. Revocation is historical (revoked_at), like personal_grants.
CREATE TABLE IF NOT EXISTS harness_shared.provider_identity_mappings (
  id                uuid        NOT NULL DEFAULT gen_random_uuid(),
  workspace_id      text        NOT NULL,
  provider          text        NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  provider_user_id  text        NOT NULL CHECK (length(btrim(provider_user_id)) > 0),
  user_id           uuid        NOT NULL REFERENCES harness_shared.users(id) ON DELETE CASCADE,
  mapped_by         text        NOT NULL CHECK (length(btrim(mapped_by)) > 0),
  mapped_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  revoked_by        text,
  CONSTRAINT provider_identity_mappings_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT provider_identity_mappings_revocation_chk
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

-- New-table partial uniqueness: a provider identity maps to at most ONE live local
-- user. Two live mappings would let one provider member's access reach two people.
CREATE UNIQUE INDEX IF NOT EXISTS provider_identity_mappings_live_identity
  ON harness_shared.provider_identity_mappings (workspace_id, provider, provider_user_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS provider_identity_mappings_user_idx
  ON harness_shared.provider_identity_mappings (workspace_id, user_id)
  WHERE revoked_at IS NULL;

-- 3. The corpus columns.
ALTER TABLE harness_shared.personal_documents
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'personal',
  ADD COLUMN IF NOT EXISTS pot_slug text,
  ADD COLUMN IF NOT EXISTS permission_list_id uuid;

-- 4. Primary key (workspace_id, user_id, id) -> (workspace_id, id), so a row with no
--    owning user can exist. id is gen_random_uuid(), already unique in practice.
DO $documents_corpus_pk$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'harness_shared.personal_documents'::regclass
       AND conname = 'personal_documents_pkey'
       AND array_length(conkey, 1) = 3
  ) THEN
    ALTER TABLE harness_shared.personal_documents DROP CONSTRAINT personal_documents_pkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'harness_shared.personal_documents'::regclass
       AND contype = 'p'
  ) THEN
    ALTER TABLE harness_shared.personal_documents
      ADD CONSTRAINT personal_documents_pkey PRIMARY KEY (workspace_id, id);
  END IF;
END
$documents_corpus_pk$;

ALTER TABLE harness_shared.personal_documents ALTER COLUMN user_id DROP NOT NULL;

-- 5. Scope coherence. Dropped first only so a re-run is idempotent (this
--    migration's own constraints).
ALTER TABLE harness_shared.personal_documents
  DROP CONSTRAINT IF EXISTS personal_documents_scope_chk,
  DROP CONSTRAINT IF EXISTS personal_documents_pot_slug_chk,
  DROP CONSTRAINT IF EXISTS personal_documents_permission_list_fk;

ALTER TABLE harness_shared.personal_documents
  ADD CONSTRAINT personal_documents_scope_chk CHECK (
       (scope = 'personal'     AND user_id IS NOT NULL AND permission_list_id IS NULL AND pot_slug IS NULL)
    OR (scope = 'organization' AND user_id IS NULL     AND permission_list_id IS NOT NULL AND pot_slug IS NULL)
    OR (scope = 'pot'          AND user_id IS NULL     AND pot_slug IS NOT NULL)
  ),
  ADD CONSTRAINT personal_documents_pot_slug_chk
    CHECK (pot_slug IS NULL OR pot_slug ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  ADD CONSTRAINT personal_documents_permission_list_fk
    FOREIGN KEY (workspace_id, permission_list_id)
    REFERENCES harness_shared.document_permission_lists (workspace_id, id) ON DELETE RESTRICT;

-- Dedupe for rows without an owner. The personal unique (workspace_id, user_id,
-- source, dedupe_key) treats NULL user_ids as distinct, so it cannot dedupe them.
CREATE UNIQUE INDEX IF NOT EXISTS personal_documents_organization_dedupe
  ON harness_shared.personal_documents (workspace_id, source, dedupe_key)
  WHERE scope = 'organization';
CREATE UNIQUE INDEX IF NOT EXISTS personal_documents_pot_dedupe
  ON harness_shared.personal_documents (workspace_id, pot_slug, source, dedupe_key)
  WHERE scope = 'pot';
CREATE INDEX IF NOT EXISTS personal_documents_permission_list_idx
  ON harness_shared.personal_documents (workspace_id, permission_list_id)
  WHERE scope = 'organization';

-- 6. Same workspace boundary every vault table carries (874 / 1303).
ALTER TABLE harness_shared.document_permission_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.document_permission_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.provider_identity_mappings ENABLE ROW LEVEL SECURITY;

DO $documents_corpus_policies$
DECLARE
  tbl text;
  pol text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'document_permission_lists',
    'document_permission_members',
    'provider_identity_mappings'
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
$documents_corpus_policies$;

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.document_permission_lists TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.document_permission_members TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.provider_identity_mappings TO harness_app, harness_admin;

COMMENT ON TABLE harness_shared.personal_documents IS
  'Documents corpus (D-005). scope = personal: owner-local Personal Vault, never in default recall, personal_grants authorization mandatory. scope = organization: user_id IS NULL, readable only by a principal whose mapped provider identity is on permission_list_id AND who holds a live organization vault grant. scope_key is the personal-grant scope and is meaningful only for scope = personal. embedding_mode is constrained to local EmbeddingGemma (gemma).';
COMMENT ON COLUMN harness_shared.personal_documents.scope IS
  'personal | organization | pot (D-005). Personal rows carry user_id; organization rows carry permission_list_id; pot rows carry pot_slug.';
COMMENT ON TABLE harness_shared.document_permission_lists IS
  'Source-derived access list for organization documents, one per (source, source_ref) such as a Slack channel. Members are replaced as a set on every membership change; access is evaluated at query time.';
COMMENT ON TABLE harness_shared.document_permission_members IS
  'Provider identities copied from the source ACL. Grants nothing on its own: a member reaches a local user only through a live provider_identity_mappings row (D-002).';
COMMENT ON TABLE harness_shared.provider_identity_mappings IS
  'Explicit, owner-controlled provider identity -> local user mapping (D-002). Never inferred from a provider payload. provider_user_id is opaque and qualified by the connector where the provider namespace needs it (e.g. Slack team:member).';
