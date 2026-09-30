-- 189: hive_members federation — fed_ts/origin/author_pubkey + capture trigger
-- (shared-hive-federation-2026-06-08 P-006, multi-Swarm admission-record
-- replication; mirrors hive_settings mig 186).
--
-- Replicates the per-Hive admission record (device_attestations + the
-- revoked_pubkeys blocklist) across a Hive's Swarms so a revocation on one Swarm
-- reaches another's admission union (loadRevokedHivePubkeys → boot.ts seam-1).
-- MULTI-SWARM only (P-010/P-011); the single-box gate works without it.
--
-- The standard federation columns (origin/author_pubkey/fed_ts) = echo-guard +
-- provenance + LWW, consumed by projections/hive-members.ts (tableTag
-- 'hive-members'). The PURE-TS wiring is su-02ae39's lane: feature-issue-op-keys.ts
-- (`hive_members → 'hive-members'` + a toHiveMemberValue mapper) + register-all.ts.
--
-- KEYING: the generic capture_substrate_outbox reads NEW.harness_slug for the
-- outbox scope (000-baseline), but hive_members' scope column is `hive_home_slug`
-- (it FKs hives + keeps the admission semantic, mig 185). Rather than rename the
-- column (and rework the tested store/revoke/tests), a thin custom capture fn sets
-- outbox.harness_slug := NEW.hive_home_slug — the Hive home slug the drain resolves
-- to the Hive topic via resolveHiveSwarmBinding. Echo-guard + key are identical to
-- the generic. Idempotent.

ALTER TABLE harness_shared.hive_members ADD COLUMN IF NOT EXISTS fed_ts bigint;
ALTER TABLE harness_shared.hive_members ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'local';
ALTER TABLE harness_shared.hive_members ADD COLUMN IF NOT EXISTS author_pubkey text;

CREATE OR REPLACE FUNCTION harness_shared.capture_hive_members_outbox() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_op      TEXT;
      v_rec     RECORD;
      v_origin  TEXT;
      v_key     TEXT;
      v_row     JSONB;
      v_ws      TEXT;
      v_slug    TEXT;
      v_keycol  TEXT := TG_ARGV[0];
    BEGIN
      IF (TG_OP = 'DELETE') THEN
        v_op := 'del';
        v_rec := OLD;
      ELSE
        v_op := 'put';
        v_rec := NEW;
      END IF;

      v_row := to_jsonb(v_rec);
      v_origin := v_row ->> 'origin';

      -- Echo-loop guard: skip remote-origin writes (the projection's own writes).
      IF COALESCE(v_origin, 'local') <> 'local' THEN
        RETURN v_rec;
      END IF;

      v_key  := v_row ->> v_keycol;
      v_ws   := COALESCE(v_row ->> 'workspace_id', '');
      v_slug := v_row ->> 'hive_home_slug';  -- the Hive scope (generic fn reads harness_slug)

      INSERT INTO harness_shared.substrate_outbox
        (workspace_id, harness_slug, table_name, op, key, row, ts)
      VALUES
        (v_ws, v_slug, TG_TABLE_NAME, v_op, v_key, v_row,
         (extract(epoch from now()) * 1000)::bigint);

      PERFORM pg_notify('substrate_outbox', v_ws || '::' || v_slug);

      RETURN v_rec;
    END;
    $$;

-- INSERT/DELETE always capture; UPDATE only when a FEDERATED field changes (not on
-- last_seen_at / channel-timestamp bumps, which are machine-local).
CREATE OR REPLACE TRIGGER capture_hive_members_outbox_trg
  AFTER INSERT OR DELETE ON harness_shared.hive_members
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_hive_members_outbox('github_user_id');

CREATE OR REPLACE TRIGGER capture_hive_members_outbox_upd_trg
  AFTER UPDATE ON harness_shared.hive_members
  FOR EACH ROW WHEN (
       OLD.revoked_pubkeys IS DISTINCT FROM NEW.revoked_pubkeys
    OR OLD.device_attestations IS DISTINCT FROM NEW.device_attestations
    OR OLD.binding_status IS DISTINCT FROM NEW.binding_status
  )
  EXECUTE FUNCTION harness_shared.capture_hive_members_outbox('github_user_id');
