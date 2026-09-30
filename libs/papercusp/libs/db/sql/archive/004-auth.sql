-- Papercusp auth tables. Minimal magic-link setup, no external email dep
-- in dev (link is logged to console). Idempotent — safe to re-run.

CREATE SCHEMA IF NOT EXISTS papercusp_auth;

CREATE TABLE IF NOT EXISTS papercusp_auth.users (
  id TEXT PRIMARY KEY,                -- generated UUID-ish at signup
  email TEXT UNIQUE NOT NULL,         -- normalized lowercase
  display_name TEXT,
  github_login TEXT UNIQUE,           -- if signed in via GitHub OAuth (future)
  created_ts BIGINT NOT NULL,
  last_login_ts BIGINT
);
CREATE INDEX IF NOT EXISTS users_email_idx ON papercusp_auth.users(email);

CREATE TABLE IF NOT EXISTS papercusp_auth.sessions (
  id TEXT PRIMARY KEY,                -- random session token
  user_id TEXT NOT NULL REFERENCES papercusp_auth.users(id) ON DELETE CASCADE,
  created_ts BIGINT NOT NULL,
  expires_ts BIGINT NOT NULL,
  user_agent TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON papercusp_auth.sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON papercusp_auth.sessions(expires_ts);

-- Pending magic-link requests. Token is single-use; consumed → session created.
CREATE TABLE IF NOT EXISTS papercusp_auth.magic_link_requests (
  token TEXT PRIMARY KEY,             -- random URL-safe token
  email TEXT NOT NULL,                -- normalized lowercase
  created_ts BIGINT NOT NULL,
  expires_ts BIGINT NOT NULL,         -- typically created_ts + 15min
  consumed_ts BIGINT,                 -- non-null once redeemed
  ip TEXT
);
CREATE INDEX IF NOT EXISTS magic_email_idx ON papercusp_auth.magic_link_requests(email);
CREATE INDEX IF NOT EXISTS magic_expires_idx ON papercusp_auth.magic_link_requests(expires_ts);

GRANT USAGE ON SCHEMA papercusp_auth TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA papercusp_auth TO harness_app, harness_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA papercusp_auth
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO harness_app, harness_admin;
