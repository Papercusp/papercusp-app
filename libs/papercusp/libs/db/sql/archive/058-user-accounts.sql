-- 058-user-accounts.sql
--
-- Multi-user same-workspace support. Local-only accounts. No OAuth.
-- Optional password (NULL = passwordless login allowed). Server-side
-- session table with opaque tokens (no JWT — loopback bind, no need
-- for distributed verification per the endpoint-system threat model).
--
-- Per-user setting overrides land in `user_preferences.payload`
-- (JSONB). Resolution at read time: user pref (if set) →
-- workspace pref → default. Workspace prefs are NOT removed; the user
-- layer is purely additive (overrides at read).
--
-- Fresh install: instrumentation seeds a `default` user with NULL
-- password. `/login` UX defaults to that user if it's the only one.
--
-- pgcrypto is already enabled by migration 027.

CREATE TABLE IF NOT EXISTS "harness_shared"."users" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "username"        text NOT NULL UNIQUE,
  "display_name"    text NOT NULL,
  "password_hash"   text,                   -- NULL = passwordless login
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "last_login_at"   timestamptz,
  "is_active"       boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS "users_username_idx"
  ON "harness_shared"."users" ("username")
  WHERE "is_active" = true;

CREATE TABLE IF NOT EXISTS "harness_shared"."user_sessions" (
  "token"           text PRIMARY KEY,                -- 32-byte hex (64 chars)
  "user_id"         uuid NOT NULL REFERENCES "harness_shared"."users"("id") ON DELETE CASCADE,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "expires_at"      timestamptz NOT NULL,
  "last_seen_at"    timestamptz NOT NULL DEFAULT now(),
  "user_agent"      text,
  "remote_addr"     text
);

CREATE INDEX IF NOT EXISTS "user_sessions_user_idx"
  ON "harness_shared"."user_sessions" ("user_id");

CREATE INDEX IF NOT EXISTS "user_sessions_expires_idx"
  ON "harness_shared"."user_sessions" ("expires_at")
  WHERE "expires_at" > '2026-01-01'::timestamptz;

CREATE TABLE IF NOT EXISTS "harness_shared"."user_preferences" (
  "user_id"         uuid PRIMARY KEY REFERENCES "harness_shared"."users"("id") ON DELETE CASCADE,
  "payload"         jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at"      timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON "harness_shared"."users" TO "harness_app";
GRANT INSERT, UPDATE ON "harness_shared"."users" TO "harness_admin";

GRANT SELECT, INSERT, DELETE ON "harness_shared"."user_sessions" TO "harness_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "harness_shared"."user_sessions" TO "harness_admin";

GRANT SELECT, INSERT, UPDATE ON "harness_shared"."user_preferences" TO "harness_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "harness_shared"."user_preferences" TO "harness_admin";
