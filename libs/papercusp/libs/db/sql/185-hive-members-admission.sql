-- 185: hive_members — per-Hive contributor/device admission
-- (shared-hive-federation-2026-06-08 P-006, D-004).
--
-- The Hive-grain analog of harness_shared.contributors. D-004: "a contributor/
-- device joins the HIVE once and thereby its harnesses" — so admission (WHO may
-- join) moves from per-harness to per-Hive. This table is the Hive-scoped
-- contributor record; the existing per-harness `contributors` table stays for the
-- finer single-harness sub-share grain (P-007).
--
-- Same shape as contributors (device_attestations + the revoked_pubkeys blocklist
-- + the channel-1/2 binding fields), so the read-admission decider + verifyBinding
-- adapter are REUSED UNCHANGED — only the source of the revoked-set union changes
-- (load-revoked-hive-pubkeys vs load-revoked-pubkeys; wired into boot.ts's
-- admission seed/refresh by the P-004 substrate re-key).
--
-- Keyed by the Hive's home_slug (the hives PK + the registry handle the P-004
-- harness↔Hive membership points at), FK→hives so dissolving a Hive cascades its
-- members away. The Hive's global pubkey identity is reachable by join to hives.
-- RLS workspace isolation mirrors hives/contributors (ENABLE, not FORCE: the table
-- owner bypasses, so integration tests work without an app.workspace_id GUC).
-- Idempotent.

CREATE TABLE IF NOT EXISTS harness_shared.hive_members (
    workspace_id            text NOT NULL,
    hive_home_slug          text NOT NULL,
    github_user_id          bigint NOT NULL,
    github_username         text NOT NULL,
    display_name            text,
    avatar_url              text,
    device_attestations     jsonb DEFAULT '[]'::jsonb NOT NULL,
    revoked_pubkeys         text[] DEFAULT '{}'::text[] NOT NULL,
    joined_at               timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at            timestamp with time zone,
    schema_version          bigint DEFAULT 1 NOT NULL,
    binding_status          text DEFAULT 'unverified'::text NOT NULL,
    channel1_verified_at    timestamp with time zone,
    channel2_verified_at    timestamp with time zone,
    channel2_branch_ref     text,
    binding_last_checked_at timestamp with time zone
);

DO $body$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'hive_members_pkey'
  ) THEN
    ALTER TABLE ONLY harness_shared.hive_members
      ADD CONSTRAINT hive_members_pkey PRIMARY KEY (workspace_id, hive_home_slug, github_user_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'hive_members_hive_fkey'
  ) THEN
    ALTER TABLE ONLY harness_shared.hive_members
      ADD CONSTRAINT hive_members_hive_fkey
      FOREIGN KEY (workspace_id, hive_home_slug)
      REFERENCES harness_shared.hives (workspace_id, home_slug)
      ON DELETE CASCADE;
  END IF;
END
$body$;

CREATE INDEX IF NOT EXISTS hive_members_username_idx
  ON harness_shared.hive_members USING btree (workspace_id, hive_home_slug, github_username);

ALTER TABLE harness_shared.hive_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hive_members_workspace_isolation ON harness_shared.hive_members;
CREATE POLICY hive_members_workspace_isolation ON harness_shared.hive_members USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
