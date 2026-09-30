-- 518: p2p_fleet_leader_leases — federated fleet leader lease hints
-- (P-302 LIVE-2 seam 1 / WI-2001).
--
-- One row per (hive, owner, fleet) stores the incumbent leader device that the
-- deterministic election should prefer while the lease remains live. This is a
-- liveness/anti-flap hint, not an authorization grant: membership and epoch
-- fencing remain in the election/roster path. The row still federates over the
-- Hive peer-log so every machine sees the same incumbent before recomputing.
--
-- KEYING: harness_slug = the Hive home_slug; leader_lease_fed_key is the
-- per-log key `<owner-uid>/<fleet-slug>`.

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS harness_shared.p2p_fleet_leader_leases (
    workspace_id            text    NOT NULL,
    harness_slug            text    NOT NULL,        -- the Hive's home_slug
    owner_github_user_id    bigint  NOT NULL,        -- fleet owner/grantor (numeric, X9)
    fleet_slug              text    NOT NULL,
    device_pubkey           text    NOT NULL,        -- elected leader device pubkey
    leader_github_user_id   bigint  NOT NULL,        -- github user id that owns/announced that device
    since_ms                bigint  NOT NULL,
    roster_epoch            bigint  NOT NULL DEFAULT 0,
    leader_lease_fed_key    text GENERATED ALWAYS AS (owner_github_user_id::text || '/' || fleet_slug) STORED,
    author_pubkey           text,
    origin                  text    NOT NULL DEFAULT 'local',
    fed_ts                  bigint,
    fed_hlc                 text,
    created_at              bigint  NOT NULL,
    updated_at              bigint  NOT NULL DEFAULT 0
);

DO $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'p2p_fleet_leader_leases_pkey') THEN
    ALTER TABLE ONLY harness_shared.p2p_fleet_leader_leases
      ADD CONSTRAINT p2p_fleet_leader_leases_pkey
      PRIMARY KEY (workspace_id, harness_slug, owner_github_user_id, fleet_slug);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'p2p_fleet_leader_leases_owner_positive') THEN
    ALTER TABLE ONLY harness_shared.p2p_fleet_leader_leases
      ADD CONSTRAINT p2p_fleet_leader_leases_owner_positive
      CHECK (owner_github_user_id > 0 AND leader_github_user_id > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'p2p_fleet_leader_leases_epoch_nonnegative') THEN
    ALTER TABLE ONLY harness_shared.p2p_fleet_leader_leases
      ADD CONSTRAINT p2p_fleet_leader_leases_epoch_nonnegative
      CHECK (since_ms >= 0 AND roster_epoch >= 0);
  END IF;
END
$body$;

CREATE INDEX IF NOT EXISTS p2p_fleet_leader_leases_hive_idx
  ON harness_shared.p2p_fleet_leader_leases (workspace_id, harness_slug);

ALTER TABLE harness_shared.p2p_fleet_leader_leases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p2p_fleet_leader_leases_workspace_isolation ON harness_shared.p2p_fleet_leader_leases;
CREATE POLICY p2p_fleet_leader_leases_workspace_isolation
  ON harness_shared.p2p_fleet_leader_leases
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

CREATE OR REPLACE TRIGGER capture_p2p_fleet_leader_leases_outbox_trg
  AFTER INSERT OR DELETE ON harness_shared.p2p_fleet_leader_leases
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('leader_lease_fed_key');

CREATE OR REPLACE TRIGGER capture_p2p_fleet_leader_leases_outbox_upd_trg
  AFTER UPDATE ON harness_shared.p2p_fleet_leader_leases
  FOR EACH ROW WHEN (
        OLD.device_pubkey          IS DISTINCT FROM NEW.device_pubkey
     OR OLD.leader_github_user_id IS DISTINCT FROM NEW.leader_github_user_id
     OR OLD.since_ms              IS DISTINCT FROM NEW.since_ms
     OR OLD.roster_epoch          IS DISTINCT FROM NEW.roster_epoch)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('leader_lease_fed_key');

DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.p2p_fleet_leader_leases;
CREATE TRIGGER stamp_local_federated_write_trg
  BEFORE INSERT OR UPDATE ON harness_shared.p2p_fleet_leader_leases
  FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write();
