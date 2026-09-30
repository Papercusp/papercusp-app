-- 1244-connected-apps.sql
-- external-app-access-to-workspaces-2026-09-29 P-002 (WI-10004011).
--
-- WHY. An external app (a script, an automation host, a third-party service) must be able to
-- call a workspace's blueprint operations over HTTP and MCP with a credential the user manages.
-- The workspace already has exactly one table of "outside things allowed to act here":
-- harness_shared.mobile_devices, the paired phones. A phone and an app key are the same kind of
-- row — a labelled, workspace-scoped, revocable credential with a last-seen time — so this
-- migration GENERALIZES that table instead of adding a parallel one (reuse-first):
--
--   mobile_devices            -> connected_apps
--     device_id               -> id          (a phone's uuid, or an app key's 16-char public id)
--     device_kind             -> kind        ('mobile' | 'app')
--     device_label            -> label
--   + scopes      jsonb  what an app key may do (P-003 reads scopes.capabilities)
--   + token_hash  text   sha256 hex of the full app key; the secret itself is NEVER stored (R-8)
--   + expires_at  timestamptz  a key past this instant is refused
--   + paused_at   timestamptz  a paused key is refused until resumed (R-25)
--   + last_ip     text   the address the key was last used from (shown to the user)
--   + limits      jsonb  per-key rate/size limits (P-005 reads them)
--
-- Phone rows keep kind='mobile', their id, and their device JWT — phone pairing is unchanged
-- (R-4). mobile_push_tokens keeps its device_id column; its FK and its RLS policy reference the
-- table by OID, so they follow the rename with no DDL here.
--
-- FORWARD-COMPAT: this RENAMES a table and three columns, and adds a partial UNIQUE index on a
-- column that is NULL on every existing row. The release serving :3070 still reads and writes
-- harness_shared.mobile_devices (device-store.ts: INSERT ... ON CONFLICT (device_id), UPDATE
-- last_seen/revoked_at, SELECT for the revocation check), so the old name is kept below as an
-- auto-updatable, security_invoker view with the old column names, restricted to kind='mobile'.
-- The deployed code keeps working unchanged through it until :3070 serves the renamed code; the
-- view is dropped by a later contract migration. The new unique index cannot fail on existing
-- rows because token_hash is added by this same migration and is NULL everywhere.
--
-- lint-migrations: allow-index-swap the only drop on this table is the CHECK mobile_devices_device_kind_check (never an ON CONFLICT inference target), and the new unique index is on token_hash, a column this same migration adds, so no deployed ON CONFLICT spec can name the new shape or lose the old one; the only unique index a deployed writer infers (the pkey, device_id -> id) is renamed, never dropped or reshaped.

DO $$
DECLARE
  c record;
  new_name text;
BEGIN
  -- Idempotent + fresh-DB safe: nothing to do once connected_apps exists, and a database that
  -- never had mobile_devices (a future squashed baseline) must not fail here.
  IF to_regclass('harness_shared.connected_apps') IS NOT NULL THEN
    RETURN;
  END IF;
  IF to_regclass('harness_shared.mobile_devices') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE harness_shared.mobile_devices RENAME TO connected_apps;
  ALTER TABLE harness_shared.connected_apps RENAME COLUMN device_id    TO id;
  ALTER TABLE harness_shared.connected_apps RENAME COLUMN device_kind  TO kind;
  ALTER TABLE harness_shared.connected_apps RENAME COLUMN device_label TO label;

  -- The old CHECK pinned device_kind = 'mobile'; an app key is the second kind.
  ALTER TABLE harness_shared.connected_apps DROP CONSTRAINT IF EXISTS mobile_devices_device_kind_check;

  -- Postgres carries constraints, indexes and policies through a rename but KEEPS their old
  -- names. Rename every remaining mobile_devices_* constraint (the pkey, and on PG18+ the named
  -- NOT NULL constraints) so a violation names the table and column it is actually about.
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'harness_shared.connected_apps'::regclass
       AND conname LIKE 'mobile\_devices\_%'
  LOOP
    new_name := replace(c.conname, 'mobile_devices_', 'connected_apps_');
    new_name := replace(new_name, '_device_id_', '_id_');
    new_name := replace(new_name, '_device_kind_', '_kind_');
    new_name := replace(new_name, '_device_label_', '_label_');
    EXECUTE format('ALTER TABLE harness_shared.connected_apps RENAME CONSTRAINT %I TO %I',
                   c.conname, new_name);
  END LOOP;

  -- Renaming the pkey CONSTRAINT above renamed its index; these two are plain indexes.
  IF to_regclass('harness_shared.mobile_devices_user_idx') IS NOT NULL THEN
    ALTER INDEX harness_shared.mobile_devices_user_idx RENAME TO connected_apps_user_idx;
  END IF;
  IF to_regclass('harness_shared.mobile_devices_workspace_idx') IS NOT NULL THEN
    ALTER INDEX harness_shared.mobile_devices_workspace_idx RENAME TO connected_apps_workspace_idx;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policy
              WHERE polrelid = 'harness_shared.connected_apps'::regclass
                AND polname = 'mobile_devices_workspace_policy') THEN
    ALTER POLICY mobile_devices_workspace_policy ON harness_shared.connected_apps
      RENAME TO connected_apps_workspace_policy;
  END IF;

  ALTER TABLE harness_shared.connected_apps
    ADD COLUMN scopes     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN token_hash text,
    ADD COLUMN expires_at timestamptz,
    ADD COLUMN paused_at  timestamptz,
    ADD COLUMN last_ip    text,
    ADD COLUMN limits     jsonb       NOT NULL DEFAULT '{}'::jsonb;

  ALTER TABLE harness_shared.connected_apps
    ADD CONSTRAINT connected_apps_kind_check CHECK (kind IN ('mobile', 'app')),
    -- R-8 at the storage layer: the only thing an app row may hold about its secret is a
    -- sha256 hex digest, so no code path can persist the plaintext key by mistake.
    ADD CONSTRAINT connected_apps_token_hash_shape
      CHECK (token_hash IS NULL OR token_hash ~ '^[0-9a-f]{64}$'),
    -- An app row without a hash is a key nobody can ever present; refuse it at write time.
    ADD CONSTRAINT connected_apps_app_has_token_hash
      CHECK (kind <> 'app' OR token_hash IS NOT NULL),
    ADD CONSTRAINT connected_apps_scopes_is_object CHECK (jsonb_typeof(scopes) = 'object'),
    ADD CONSTRAINT connected_apps_limits_is_object CHECK (jsonb_typeof(limits) = 'object');
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS connected_apps_token_hash_key
  ON harness_shared.connected_apps (token_hash)
  WHERE token_hash IS NOT NULL;

-- The deploy-window shim described in FORWARD-COMPAT above. security_invoker = true is
-- load-bearing: without it the view runs as its owner and BYPASSES the workspace RLS policy on
-- connected_apps, letting one workspace read another's phones through the old name. A simple
-- single-table view with plain column renames is auto-updatable, so the deployed INSERT (with
-- ON CONFLICT (device_id)), UPDATE and SELECT keep working; an INSERT through it omits kind and
-- so takes the column default 'mobile'. The kind='mobile' filter keeps app-key rows invisible to
-- the old phone code (its revocation check treats an unknown id as revoked).
CREATE OR REPLACE VIEW harness_shared.mobile_devices
  WITH (security_invoker = true) AS
  SELECT id    AS device_id,
         user_email,
         workspace_id,
         kind  AS device_kind,
         label AS device_label,
         paired_at,
         last_seen,
         revoked_at
    FROM harness_shared.connected_apps
   WHERE kind = 'mobile';

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.connected_apps TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.mobile_devices TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.connected_apps TO harness_zero;
  GRANT SELECT ON harness_shared.mobile_devices TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;

COMMENT ON VIEW harness_shared.mobile_devices IS
  'DEPLOY-WINDOW SHIM (migration 1244, external-app-access-to-workspaces-2026-09-29 P-002). The table is now harness_shared.connected_apps (kind=''mobile'' rows are the paired phones). This view exists only so the release checkout serving :3070 keeps working until it carries the renamed code. Do NOT write new code against this name — a later contract migration drops it.';

COMMENT ON TABLE harness_shared.connected_apps IS
  'Everything outside the workspace that is allowed to act in it: paired phones (kind=mobile, authenticated by a device JWT) and app keys (kind=app, authenticated by a pcapp_<id>_<secret> bearer whose sha256 is token_hash — the secret is never stored). A row is refused once revoked_at is set, while paused_at is set, or after expires_at.';
COMMENT ON COLUMN harness_shared.connected_apps.token_hash IS
  'sha256 hex of the full app key (pcapp_<id>_<secret>). The plaintext key is shown to the user once at creation and never persisted.';
COMMENT ON COLUMN harness_shared.connected_apps.scopes IS
  'What an app key may do. {capabilities: string[]} is the grant P-003 enforces; empty = no capabilities.';
COMMENT ON COLUMN harness_shared.connected_apps.limits IS
  'Per-key limits (rate, payload size). Empty = the workspace defaults.';
