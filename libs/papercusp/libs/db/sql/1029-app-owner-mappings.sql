-- P-003 (plan platform-to-app-data-producer-2026-08-30)
--
-- The platform→app data producer must deliver each canonical row to the RIGHT
-- person's app. Platform-side a row is owned by (workspace_id, user_id) — a uuid
-- FK to harness_shared.users. App-side every store read is scoped by an opaque
-- `ownerId` string, taken from the `sub` of a JWT the app verifies itself
-- (apps/sidecar/src/auth.ts). Nothing today relates the two.
--
-- Those identifiers are NOT derivable from one another, and inferring one from
-- the other is the failure this table exists to prevent: a wrong mapping does
-- not error, it silently delivers one person's mail into another person's app.
-- So the relation is stored EXPLICITLY and configured deliberately, mirroring
-- how personal-vault/live-sink.ts resolves its target user from the source's
-- server-owned ownerUserId rather than from anything in a provider payload.
--
-- Purely additive: creates one new table, touches nothing deployed. No
-- FORWARD-COMPAT acknowledgment is required (no destructive DDL).

CREATE TABLE IF NOT EXISTS harness_shared.app_owner_mappings (
  workspace_id text        NOT NULL,
  user_id      uuid        NOT NULL REFERENCES harness_shared.users(id) ON DELETE CASCADE,
  app          text        NOT NULL,
  owner_id     text        NOT NULL,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT app_owner_mappings_pkey PRIMARY KEY (workspace_id, user_id, app),

  -- Same slug shape personal_documents.source uses, so an app key cannot be a
  -- stray display string. Which apps actually EXIST is validated in code, not
  -- here: adding one already requires a code change (its audience and signing
  -- secret), and a CHECK listing app names would make that a migration too.
  CONSTRAINT app_owner_mappings_app_check
    CHECK (app ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  CONSTRAINT app_owner_mappings_owner_id_check
    CHECK (length(btrim(owner_id)) > 0),

  -- THE LOAD-BEARING CONSTRAINT. Within one app, an owner_id may belong to at
  -- most one platform user. Without it, two users could be mapped to the same
  -- app owner and their mail would MERGE in that app's store — the exact
  -- cross-tenant leak P-003 names, arriving silently and with no error to read.
  -- The PK already stops one user having two owners for the same app; this
  -- stops the other direction, which is the dangerous one.
  CONSTRAINT app_owner_mappings_owner_unique UNIQUE (workspace_id, app, owner_id)
);

COMMENT ON TABLE harness_shared.app_owner_mappings IS
  'Explicit platform-user -> app-owner mapping for the platform->app data producer (P-003). Never inferred: a wrong mapping delivers one person''s data into another person''s app.';
COMMENT ON COLUMN harness_shared.app_owner_mappings.app IS
  'App slug (e.g. email, calendar). The JWT audience is derived from it in code as papercusp-<app>, so the two cannot drift.';
COMMENT ON COLUMN harness_shared.app_owner_mappings.owner_id IS
  'The app-side AuthIdentity.ownerId — the `sub` the app verifies. Opaque to the platform.';
COMMENT ON COLUMN harness_shared.app_owner_mappings.note IS
  'Optional operator note recording WHY this mapping exists / who configured it.';

-- No further index is declared on purpose. The PK indexes the forward path
-- (workspace, user, app), and app_owner_mappings_owner_unique already creates
-- the exact (workspace_id, app, owner_id) index the reverse lookup needs — a
-- second one would be a duplicate paid for on every write.
