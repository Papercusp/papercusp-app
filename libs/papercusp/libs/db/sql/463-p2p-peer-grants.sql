-- 463-p2p-peer-grants.sql — p2p-work-distribution-2026-07-02 P-001 (Lane A).
-- Capability-grant schema for opt-in P2P work distribution: a GRANTOR (a hive
-- member, identified by GitHub NUMERIC user-id — X9: logins are mutable +
-- reusable, display-only; precedent hive/member-tier-gate.ts) grants a
-- POLYMORPHIC grantee {fleet-slug | pool-id} (D-010) a set of capabilities
-- over the grantor's machines.
--
-- FEDERATION: rides the table-op path exactly like bee_claim_specs (mig 438/439)
-- — CDC capture into substrate_outbox, drain → hive peer-log, read-side
-- projection (projections/p2p-peer-grants.ts). harness_slug = the hive HOME
-- slug (the demux). M19: grants federate USER-level — one grant row reaches
-- every machine of the hive, so a revocation lands everywhere; per-machine
-- allotments (P-201) deliberately do NOT live here.
--
-- RECEIVER-ENFORCED (M6/L9): nothing in this table is trusted as
-- sender-asserted. The projection applies an inbound op ONLY when the op's
-- VERIFIED source-log device attests to the SAME GitHub user the row names as
-- grantor_github_user_id — you can author grants solely AS YOURSELF. Grant
-- CHECKS (C6) read this table directly — no cache tier may sit between a
-- revocation landing and enforcement reading it (WI-1547 class).
--
-- X6 EPOCHS: every grant row carries grantor_epoch. Receivers track a
-- high-water epoch per (workspace, hive, grantor) in p2p_grantor_epochs
-- (LOCAL, never federated — each receiver derives it from applied ops).
-- Spawn-class enforcement refuses any grant whose epoch trails the grantor's
-- high-water. Wall-clock (sender OR arrival) NEVER gates revocation.
--
-- m25: grants are keyed by gh user-id, NOT device pubkey, so device key
-- rotation (which re-anchors the attestation) never looks like revocation.
-- m14 per-device EXCLUSIONS reference device pubkeys and are best-effort
-- across rotation: a rotated device gets a fresh pubkey, so exclusions must be
-- re-asserted (documented on the column).
--
-- Idempotent; apply via the runner (db:migrate) or psql + schema_migrations
-- row in one txn.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.p2p_peer_grants (
    workspace_id            text        NOT NULL,
    -- The hive HOME slug — the federation demux (mig-438 pattern). NOT NULL:
    -- a P2P grant is inherently hive-scoped; a "local-only grant" is
    -- meaningless (there is no foreign peer to enforce it against).
    harness_slug            text        NOT NULL,
    -- X9: the NUMERIC GitHub user-id of the granting user. Receiver-verified
    -- against the op author's attested identity on every apply.
    grantor_github_user_id  bigint      NOT NULL,
    -- Display-only convenience (X9: NEVER used for keying or enforcement).
    grantor_login           text,
    -- D-010 polymorphic grantee: a fleet (slug) or a pool/broker (id).
    grantee_kind            text        NOT NULL,
    grantee_ref             text        NOT NULL,
    -- The granted capability set: subset of
    -- {chat, steer, work-offer, wake, spawn, read-artifacts}
    -- (validated app-side in lib/p2p/capabilities.ts; presets are UI sugar).
    capabilities            text[]      NOT NULL DEFAULT '{}',
    -- Display-only preset label (Observer/Collaborator/Delegate/Operator);
    -- enforcement reads ONLY `capabilities`.
    preset                  text,
    -- Revocation is an LWW PUT of status='revoked' (+ epoch bump), NOT a
    -- DELETE — the tombstone must carry the epoch so receivers can refuse
    -- stale re-grants (X6). Reaping in-flight work is P-106.
    status                  text        NOT NULL DEFAULT 'active',
    -- X6: the grantor's epoch at write time. Bumped on every revocation-class
    -- change (revoke / capability downgrade). Receivers refuse spawn-class
    -- records whose epoch trails the tracked high-water.
    grantor_epoch           bigint      NOT NULL DEFAULT 0,
    -- M9: wake is a token-burning DoS vector — per-grantor wake rate cap
    -- (wakes/hour the grantee may spend against this grantor's machines).
    -- NULL = the enforcing side's conservative default. Metered separately
    -- from work-offer budgets.
    wake_rate_cap_per_hour  integer,
    -- m14: grantor devices EXCLUDED from this grant (e.g. "not my laptop").
    -- Best-effort across key rotation (see header); enforcement is
    -- receiver-side on the excluded device itself.
    excluded_device_pubkeys text[]      NOT NULL DEFAULT '{}',
    note                    text,
    -- The peer-log key (capture_substrate_outbox TG_ARGV key column):
    -- one grant per (grantor, grantee) within a hive.
    grant_fed_key           text GENERATED ALWAYS AS
      (grantor_github_user_id::text || ':' || grantee_kind || ':' || grantee_ref) STORED,
    -- Federation provenance (mig 438/461 pattern).
    origin                  text        NOT NULL DEFAULT 'local',
    author_pubkey           text,
    fed_ts                  bigint,
    fed_hlc                 text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT p2p_peer_grants_ws_nonempty     CHECK (workspace_id <> ''),
    CONSTRAINT p2p_peer_grants_slug_nonempty   CHECK (harness_slug <> ''),
    CONSTRAINT p2p_peer_grants_grantor_pos     CHECK (grantor_github_user_id > 0),
    CONSTRAINT p2p_peer_grants_grantee_kind    CHECK (grantee_kind IN ('fleet', 'pool')),
    CONSTRAINT p2p_peer_grants_grantee_nonempty CHECK (grantee_ref <> ''),
    CONSTRAINT p2p_peer_grants_status          CHECK (status IN ('active', 'revoked')),
    CONSTRAINT p2p_peer_grants_epoch_nonneg    CHECK (grantor_epoch >= 0),
    CONSTRAINT p2p_peer_grants_wake_cap_pos    CHECK (wake_rate_cap_per_hour IS NULL OR wake_rate_cap_per_hour > 0),
    PRIMARY KEY (workspace_id, harness_slug, grantor_github_user_id, grantee_kind, grantee_ref)
);

COMMENT ON TABLE harness_shared.p2p_peer_grants IS
  'P2P capability grants (p2p-work-distribution-2026-07-02 P-001): grantor (GitHub NUMERIC user-id) grants a polymorphic grantee {fleet|pool} capabilities over the grantor''s machines. Receiver-enforced (M6/L9): the projection verifies the op author''s attested identity == grantor_github_user_id. Revocation = LWW status=revoked + grantor_epoch bump (X6); enforcement reads bypass every cache tier (C6).';
COMMENT ON COLUMN harness_shared.p2p_peer_grants.excluded_device_pubkeys IS
  'm14: grantor devices excluded from this grant. Best-effort across device key rotation (m25 re-anchors attestation under a NEW pubkey, so exclusions must be re-asserted after rotation — rotation must never look like revocation, so we accept the exclusion gap over keying grants by device).';
COMMENT ON COLUMN harness_shared.p2p_peer_grants.grantor_epoch IS
  'X6: grantor epoch at write. Receivers track high-water per grantor (p2p_grantor_epochs); spawn-class ops refuse any record whose epoch trails high-water. Wall-clock never gates revocation.';

-- Receiver-side epoch high-water per grantor (X6). LOCAL — never federated:
-- each receiver derives it from the ops it has APPLIED (an attacker cannot
-- lower another machine's high-water by federating a row). Registered
-- WORKSPACE_OWNED_EXPLICIT / sync:'none' in table-registry.ts.
CREATE TABLE IF NOT EXISTS harness_shared.p2p_grantor_epochs (
    workspace_id            text        NOT NULL,
    harness_slug            text        NOT NULL,
    grantor_github_user_id  bigint      NOT NULL,
    high_water_epoch        bigint      NOT NULL DEFAULT 0,
    updated_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT p2p_grantor_epochs_nonneg CHECK (high_water_epoch >= 0),
    PRIMARY KEY (workspace_id, harness_slug, grantor_github_user_id)
);

COMMENT ON TABLE harness_shared.p2p_grantor_epochs IS
  'X6 receiver-side high-water epoch per (workspace, hive, grantor). LOCAL-ONLY enforcement state — never federated; advanced when a grant op applies; spawn-class capability checks refuse grants whose grantor_epoch trails this.';

-- Fast enforcement lookup by grantee (checkP2pCapability's read).
CREATE INDEX IF NOT EXISTS p2p_peer_grants_grantee_idx
  ON harness_shared.p2p_peer_grants (workspace_id, harness_slug, grantee_kind, grantee_ref)
  WHERE status = 'active';

-- ── LWW / HLC stamp (the mig-439 lesson: a federated table MUST attach the
--    BEFORE stamp trigger itself, or local writes leave fed_ts/fed_hlc NULL and
--    two honest peers can converge on different rows). ────────────────────────
DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.p2p_peer_grants;
CREATE TRIGGER stamp_local_federated_write_trg
  BEFORE INSERT OR UPDATE ON harness_shared.p2p_peer_grants
  FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write();

-- ── CDC capture (mig 438 pattern; echo-guard for origin<>'local' lives inside
--    capture_substrate_outbox). harness_slug is NOT NULL so INSERT/DELETE
--    capture unconditionally; UPDATE gets the no-op distinct guard so
--    read-merge re-upserts don't re-enqueue. ─────────────────────────────────
CREATE OR REPLACE TRIGGER capture_p2p_peer_grants_outbox_trg
  AFTER INSERT ON harness_shared.p2p_peer_grants
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('grant_fed_key');

CREATE OR REPLACE TRIGGER capture_p2p_peer_grants_outbox_upd_trg
  AFTER UPDATE ON harness_shared.p2p_peer_grants
  FOR EACH ROW
  WHEN (OLD.capabilities IS DISTINCT FROM NEW.capabilities
     OR OLD.preset IS DISTINCT FROM NEW.preset
     OR OLD.status IS DISTINCT FROM NEW.status
     OR OLD.grantor_epoch IS DISTINCT FROM NEW.grantor_epoch
     OR OLD.wake_rate_cap_per_hour IS DISTINCT FROM NEW.wake_rate_cap_per_hour
     OR OLD.excluded_device_pubkeys IS DISTINCT FROM NEW.excluded_device_pubkeys
     OR OLD.grantor_login IS DISTINCT FROM NEW.grantor_login
     OR OLD.note IS DISTINCT FROM NEW.note)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('grant_fed_key');

CREATE OR REPLACE TRIGGER capture_p2p_peer_grants_outbox_del_trg
  AFTER DELETE ON harness_shared.p2p_peer_grants
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('grant_fed_key');

COMMIT;
