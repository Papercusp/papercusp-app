-- 1256-connected-app-mcp-oauth.sql
-- external-app-access-to-workspaces-2026-09-29 P-006 (WI-10004015).
--
-- WHY. Off-the-shelf MCP clients (Claude.ai custom connectors, ChatGPT connectors, the MCP SDK)
-- connect to a server they were given only the URL of: they discover its OAuth authorization
-- server, register themselves (RFC 7591), send the user through authorization code + PKCE with a
-- consent step, and exchange the code for an access token. On a local install that token is a
-- connected-app key (harness_shared.connected_apps, kind='app'), exactly as if the user had created
-- it in Connect-an-app, so scope enforcement, pause, revoke and the kill switch apply unchanged.
--
-- Two additions:
--   1. connected_app_oauth_clients — one row per registered client. Workspace-agnostic: a client
--      registers before any user has consented to anything, so the table is read and written only
--      on the admin connection. RLS is on with no policy, so the workspace role sees nothing.
--   2. OAuth columns on connected_app_device_grants — an authorization request IS a device grant:
--      it waits for the same local approval (Settings -> Remote access, or the local consent
--      page), under the same user code, and becomes a key the same way. The extra columns hold
--      what OAuth must bind the code to (client, redirect URI, PKCE challenge, state, resource)
--      and the one-time authorization code (sha256 only). `granted_scopes` records what the
--      approver actually consented to, which may be narrower than what was requested; the key is
--      issued with it when present.
--
-- Additive only: a new table and nullable columns. The deployed release never sets the new
-- columns, so every row it writes keeps them NULL and satisfies the new checks.
-- FORWARD-COMPAT: the only unique index added is partial on auth_code_hash IS NOT NULL; the deployed release's INSERT ... ON CONFLICT DO NOTHING into connected_app_device_grants always writes auth_code_hash NULL, so the new index can never be its arbiter or change its outcome.
-- lint-migrations: allow-index-swap the only DROPs are DROP CONSTRAINT IF EXISTS of the three CHECK constraints this migration itself adds (re-run safety), never a UNIQUE one; the one new unique index is partial on the brand-new auth_code_hash column, which no deployed ON CONFLICT names.

CREATE TABLE IF NOT EXISTS harness_shared.connected_app_oauth_clients (
  -- Public identifier returned by registration (pcoc_ + 22 url-safe characters).
  client_id                  text        PRIMARY KEY
                                         CONSTRAINT connected_app_oauth_clients_id_shape
                                         CHECK (client_id ~ '^pcoc_[A-Za-z0-9_-]{22}$'),
  -- Display-only name the client gave for itself (shown on the consent screen). Never an identifier.
  client_name                text        NOT NULL,
  -- Exact-match redirect targets; an authorization request naming any other URI is refused.
  redirect_uris              text[]      NOT NULL
                                         CONSTRAINT connected_app_oauth_clients_redirect_count
                                         CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
  -- 'none' = public client (PKCE only); the secret methods issue a client secret at registration.
  token_endpoint_auth_method text        NOT NULL DEFAULT 'none'
                                         CONSTRAINT connected_app_oauth_clients_auth_method_check
                                         CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
  -- sha256 hex of the client secret; the secret itself is returned once at registration.
  client_secret_hash         text
                                         CONSTRAINT connected_app_oauth_clients_secret_hash_shape
                                         CHECK (client_secret_hash IS NULL OR client_secret_hash ~ '^[0-9a-f]{64}$'),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  last_used_at               timestamptz,
  CONSTRAINT connected_app_oauth_clients_secret_matches_method
    CHECK ((token_endpoint_auth_method = 'none') = (client_secret_hash IS NULL))
);

ALTER TABLE harness_shared.connected_app_oauth_clients ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE harness_shared.connected_app_oauth_clients IS
  'OAuth clients registered with a local install''s MCP authorization server (RFC 7591, external-app-access P-006). Admin connection only (RLS on, no policy). The client secret is stored only as sha256.';

ALTER TABLE harness_shared.connected_app_device_grants
  ADD COLUMN IF NOT EXISTS oauth_client_id      text
    REFERENCES harness_shared.connected_app_oauth_clients (client_id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS oauth_redirect_uri   text,
  ADD COLUMN IF NOT EXISTS oauth_code_challenge text,
  ADD COLUMN IF NOT EXISTS oauth_state          text,
  ADD COLUMN IF NOT EXISTS oauth_resource       text,
  ADD COLUMN IF NOT EXISTS auth_code_hash       text,
  ADD COLUMN IF NOT EXISTS auth_code_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS granted_scopes       jsonb;

ALTER TABLE harness_shared.connected_app_device_grants
  DROP CONSTRAINT IF EXISTS connected_app_device_grants_oauth_request_complete;
ALTER TABLE harness_shared.connected_app_device_grants
  ADD CONSTRAINT connected_app_device_grants_oauth_request_complete
  CHECK (oauth_client_id IS NULL
         OR (oauth_redirect_uri IS NOT NULL AND oauth_code_challenge ~ '^[A-Za-z0-9_-]{43}$'));

ALTER TABLE harness_shared.connected_app_device_grants
  DROP CONSTRAINT IF EXISTS connected_app_device_grants_auth_code_shape;
ALTER TABLE harness_shared.connected_app_device_grants
  ADD CONSTRAINT connected_app_device_grants_auth_code_shape
  CHECK (auth_code_hash IS NULL
         OR (auth_code_hash ~ '^[0-9a-f]{64}$' AND auth_code_expires_at IS NOT NULL AND oauth_client_id IS NOT NULL));

ALTER TABLE harness_shared.connected_app_device_grants
  DROP CONSTRAINT IF EXISTS connected_app_device_grants_granted_scopes_is_object;
ALTER TABLE harness_shared.connected_app_device_grants
  ADD CONSTRAINT connected_app_device_grants_granted_scopes_is_object
  CHECK (granted_scopes IS NULL OR jsonb_typeof(granted_scopes) = 'object');

CREATE UNIQUE INDEX IF NOT EXISTS connected_app_device_grants_auth_code_key
  ON harness_shared.connected_app_device_grants (auth_code_hash)
  WHERE auth_code_hash IS NOT NULL;

COMMENT ON COLUMN harness_shared.connected_app_device_grants.oauth_client_id IS
  'Set when this grant is an OAuth authorization request (P-006) rather than an RFC 8628 device sign-in. Such a grant is never exchanged by /device/token.';
COMMENT ON COLUMN harness_shared.connected_app_device_grants.auth_code_hash IS
  'sha256 of the one-time OAuth authorization code minted after approval; valid until auth_code_expires_at and only for oauth_client_id + oauth_redirect_uri + the PKCE verifier of oauth_code_challenge.';
COMMENT ON COLUMN harness_shared.connected_app_device_grants.granted_scopes IS
  'The scopes the approver consented to (may be narrower than requested_scopes). The key is issued with these when set.';
