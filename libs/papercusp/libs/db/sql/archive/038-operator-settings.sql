\set ON_ERROR_STOP on
BEGIN;

-- Migration 038 — operator settings (key/value). Single home for
-- per-deployment configurable strings that don't deserve their own table.
-- First use: desktop_release_url (was hardcoded in marketplace-public-ui's
-- HomePage as 'https://github.com/ownerhandle/Restart/releases/latest').
--
-- Schema is intentionally generic so future per-deployment knobs (about
-- text, footer URLs, default workspace name, etc.) can land here without
-- a migration each time.

CREATE TABLE IF NOT EXISTS harness_shared.operator_settings (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL,
  description  TEXT,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

INSERT INTO harness_shared.operator_settings (key, value, description, updated_at) VALUES
  (
    'desktop_release_url',
    'https://github.com/ownerhandle/Restart/releases/latest',
    'URL the public marketplace HomePage links to for the desktop app download.',
    0
  )
ON CONFLICT (key) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_settings TO harness_app, harness_admin;

COMMENT ON TABLE harness_shared.operator_settings IS
  'Per-deployment configurable strings (URLs, default text). Edit rows to change without a code edit.';

COMMIT;
