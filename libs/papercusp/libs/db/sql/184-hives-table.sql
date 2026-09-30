-- 184: hives — the first-class Hive entity (shared-hive-federation-2026-06-08 P-002, D-008).
--
-- A Hive = a PROJECT (its harnesses + plans + settings), identified by a stable
-- Ed25519 KEYPAIR (D-002) so it is addressable/dial-able by pubkey and the pubkey
-- can become the federation topic key (P-003). The SECRET key lives in the OS
-- keychain (identity/hive-keypair.ts, service 'papercusp-hive-keypair'); PG stores
-- only the PUBLIC key (the dial-able identity) + the keychain id that locates the
-- secret. A workspace hosts MULTIPLE Hives (owner ruling D-008), each its home
-- `kind:'hive'` harness.
--
-- A real multi-row table (NOT the operator-state single-row JSONB blob) precisely
-- so Phase-1 federation can key/join on the hive identity (the ~18 federation
-- sites + migs 144/150 re-key from harness_slug -> hive id). Idempotent; PK
-- (workspace_id, home_slug); public_key globally UNIQUE (a pubkey identifies one
-- Hive everywhere — the cross-Hive addressing invariant). RLS workspace isolation
-- mirrors harness_shared.contributors (ENABLE, not FORCE: the table owner bypasses,
-- so integration tests work without an app.workspace_id GUC).

CREATE TABLE IF NOT EXISTS harness_shared.hives (
    workspace_id text NOT NULL,
    home_slug    text NOT NULL,
    public_key   bytea NOT NULL,
    keychain_id  text NOT NULL,
    title        text,
    description  text,
    created_at   bigint NOT NULL,
    updated_at   bigint DEFAULT 0 NOT NULL
);

DO $body$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'hives_pkey'
  ) THEN
    ALTER TABLE ONLY harness_shared.hives
      ADD CONSTRAINT hives_pkey PRIMARY KEY (workspace_id, home_slug);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'hives_public_key_key'
  ) THEN
    ALTER TABLE ONLY harness_shared.hives
      ADD CONSTRAINT hives_public_key_key UNIQUE (public_key);
  END IF;
END
$body$;

ALTER TABLE harness_shared.hives ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hives_workspace_isolation ON harness_shared.hives;
CREATE POLICY hives_workspace_isolation ON harness_shared.hives USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
