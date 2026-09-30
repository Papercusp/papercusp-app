-- 1261-connected-app-client-credentials.sql
-- external-app-access-to-workspaces-2026-09-29 P-016 (WI-10004017), design D-022.
--
-- WHY. An unattended app should not send its long-lived secret on every call. With the OAuth
-- client-credentials grant it presents that secret (or a signed assertion) only to a token
-- endpoint and receives a SHORT-LIVED access token for the actual calls, so a leaked access token
-- stops working within the hour.
--
-- THE CLIENT is an existing service key (connected_apps kind='service', P-015) switched into a
-- client-credentials mode, so it keeps every service-key property: scopes, the mandatory spending
-- cap, pause, revoke, expiry and rotation with overlap. `client_auth` names how it authenticates
-- at the token endpoint:
--   'client_secret'   — client_secret_basic / client_secret_post with the row's pcapp_ secret;
--   'private_key_jwt' — an RFC 7523 assertion signed by the key in `client_jwk` (public part only).
-- NULL means the row is an ordinary bearer key. A row in client-credentials mode is REFUSED as a
-- bearer on /api/mcp and /agent-tools (connected-apps/store.ts verdict 'token_endpoint_only').
--
-- ACCESS TOKENS live in connected_app_access_tokens. A token is `pcat_<id>_<secret>`: the id is
-- the row's primary key (a primary-key read, like an app key), and only the SHA-256 digest of the
-- whole token is stored, with the (possibly narrowed) scopes it carries and a finite expiry (R-15;
-- NOT NULL plus the CHECK below). A token is never a principal of its own: every call re-checks the
-- PARENT row, so revoking, pausing or expiring the client stops all of its tokens on the next call,
-- and spend rolls up to the client (P-011).
--
-- CLIENT ASSERTIONS: connected_app_client_assertions remembers each accepted private_key_jwt `jti`
-- until the assertion's own expiry, so a captured assertion cannot be replayed.
--
-- FORWARD-COMPAT: nothing here is destructive. The two connected_apps columns are nullable with
-- no default, so the deployed :3070 release's INSERT column lists stay valid, and it never reads
-- them. The two tables are new.

DO $$
BEGIN
  -- Fresh-DB safe, like 1244/1252: a database with no connected_apps table has nothing to extend.
  IF to_regclass('harness_shared.connected_apps') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE harness_shared.connected_apps
    ADD COLUMN IF NOT EXISTS client_auth text,
    ADD COLUMN IF NOT EXISTS client_jwk  jsonb;

  ALTER TABLE harness_shared.connected_apps
    DROP CONSTRAINT IF EXISTS connected_apps_client_auth_check,
    ADD CONSTRAINT connected_apps_client_auth_check CHECK (
      client_auth IS NULL
      OR (kind = 'service' AND client_auth IN ('client_secret', 'private_key_jwt'))
    );

  -- A signed-assertion client without a registered key could never authenticate; a key on any
  -- other row would be a credential nothing reads. IS NOT DISTINCT FROM keeps a NULL client_auth
  -- from making the first branch NULL (a NULL CHECK result passes).
  ALTER TABLE harness_shared.connected_apps
    DROP CONSTRAINT IF EXISTS connected_apps_client_jwk_check,
    ADD CONSTRAINT connected_apps_client_jwk_check CHECK (
      CASE WHEN client_auth IS NOT DISTINCT FROM 'private_key_jwt'
           THEN client_jwk IS NOT NULL AND jsonb_typeof(client_jwk) = 'object'
           ELSE client_jwk IS NULL
      END
    );

  CREATE TABLE IF NOT EXISTS harness_shared.connected_app_access_tokens (
    id           text        PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9]{16}$'),
    token_hash   text        NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    app_id       text        NOT NULL REFERENCES harness_shared.connected_apps(id) ON DELETE CASCADE,
    workspace_id text        NOT NULL,
    scopes       jsonb       NOT NULL CHECK (jsonb_typeof(scopes) = 'object'),
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    CONSTRAINT connected_app_access_tokens_expiry_after_creation CHECK (expires_at > created_at)
  );
  CREATE INDEX IF NOT EXISTS connected_app_access_tokens_app_expiry_idx
    ON harness_shared.connected_app_access_tokens (app_id, expires_at);

  CREATE TABLE IF NOT EXISTS harness_shared.connected_app_client_assertions (
    app_id       text        NOT NULL REFERENCES harness_shared.connected_apps(id) ON DELETE CASCADE,
    jti          text        NOT NULL CHECK (length(jti) BETWEEN 1 AND 200),
    workspace_id text        NOT NULL,
    expires_at   timestamptz NOT NULL,
    PRIMARY KEY (app_id, jti)
  );

  ALTER TABLE harness_shared.connected_app_access_tokens ENABLE ROW LEVEL SECURITY;
  ALTER TABLE harness_shared.connected_app_client_assertions ENABLE ROW LEVEL SECURITY;

  IF NOT EXISTS (SELECT 1 FROM pg_policy
                  WHERE polrelid = 'harness_shared.connected_app_access_tokens'::regclass
                    AND polname = 'connected_app_access_tokens_workspace_policy') THEN
    CREATE POLICY connected_app_access_tokens_workspace_policy ON harness_shared.connected_app_access_tokens
      USING (workspace_id = current_setting('app.workspace_id', true))
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy
                  WHERE polrelid = 'harness_shared.connected_app_client_assertions'::regclass
                    AND polname = 'connected_app_client_assertions_workspace_policy') THEN
    CREATE POLICY connected_app_client_assertions_workspace_policy ON harness_shared.connected_app_client_assertions
      USING (workspace_id = current_setting('app.workspace_id', true))
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
  END IF;

  GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.connected_app_access_tokens TO harness_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.connected_app_client_assertions TO harness_app;
END $$;
