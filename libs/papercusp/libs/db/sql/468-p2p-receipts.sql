-- 468-p2p-receipts.sql — p2p-work-distribution-2026-07-02 P-004 (Lane A).
-- Loud-refusal receipts + M15 refused-op counters.
--
-- p2p_receipts: IMMUTABLE receipt FACTS (gate_verdicts pattern — INSERT-only,
-- ON CONFLICT DO NOTHING on apply). Every refused/interrupted cross-peer action
-- on an AUTHENTICATED path produces one receipt row naming the exact missing
-- capability/budget (D-004: no silent drops). Rows federate over the hive
-- peer-log so the REQUESTER's machines receive their receipt and p2p:trace can
-- assemble the cross-machine timeline from BOTH sides' rows (M21: offer_id
-- threads through every receipt/audit/log line).
-- X8: kind='excused-breach' marks preemption-class interruptions (host
-- kill-switch wind-down, revocation-lite downgrade) — excluded from reliability
-- signals (P-203).
--
-- p2p_refused_op_counters: M15 — UNAUTHENTICATED failure paths (no verified
-- requester to receipt: forged/unresolvable grant ops, unattested devices) get
-- LOCAL COUNTERS, not receipts — loud is not unbounded. Local-only
-- (WORKSPACE_OWNED_EXPLICIT / sync:'none'); also the P-003 acceptance's
-- "refused-op counters exist".
--
-- Idempotent; apply via the runner (db:migrate) or psql + schema_migrations
-- row in one txn.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.p2p_receipts (
    workspace_id              text        NOT NULL,
    harness_slug              text        NOT NULL,   -- the hive HOME slug (federation demux)
    receipt_id                text        NOT NULL,   -- uuid; the peer-log key
    kind                      text        NOT NULL,   -- X8 taxonomy
    -- M21: the offer-id thread key. NULL for pre-offer refusals (a bare grant
    -- check); set on every offer-lifecycle receipt so p2p:trace can assemble
    -- the cross-machine timeline for one offer.
    offer_id                  text,
    -- The refused/interrupted cross-peer action (e.g. 'work-offer:claim',
    -- 'wake', 'spawn', 'chat', 'wind-down').
    action                    text        NOT NULL,
    -- The structured refusal (checkP2pCapability shape): code + the EXACT
    -- missing capability/budget axis the requester lacked.
    refusal_code              text,
    missing_capability        text,
    budget_axis               text,                    -- P-107/P-201 refusals (remote|local)
    detail                    text        NOT NULL,
    -- Requester identity (the grantee side, D-010 polymorphic).
    requester_kind            text,
    requester_ref             text,
    requester_github_user_id  bigint,
    -- Responder identity (the enforcing/host side — the receipt AUTHOR). The
    -- projection receiver-enforces: op author's ATTESTED gh user-id must equal
    -- responder_github_user_id (you can only author receipts AS YOURSELF).
    responder_github_user_id  bigint      NOT NULL,
    responder_device_pubkey   text,
    -- Event time (epoch ms) — federated so both sides order the timeline the
    -- same way; created_at is machine-local.
    receipt_ts                bigint      NOT NULL,
    -- Federation provenance (mig 438/463 pattern).
    origin                    text        NOT NULL DEFAULT 'local',
    author_pubkey             text,
    fed_ts                    bigint,
    fed_hlc                   text,
    created_at                timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT p2p_receipts_ws_nonempty   CHECK (workspace_id <> ''),
    CONSTRAINT p2p_receipts_slug_nonempty CHECK (harness_slug <> ''),
    CONSTRAINT p2p_receipts_id_nonempty   CHECK (receipt_id <> ''),
    CONSTRAINT p2p_receipts_kind          CHECK (kind IN ('refusal', 'excused-breach')),
    CONSTRAINT p2p_receipts_action_nonempty CHECK (action <> ''),
    CONSTRAINT p2p_receipts_responder_pos CHECK (responder_github_user_id > 0),
    PRIMARY KEY (workspace_id, harness_slug, receipt_id)
);

COMMENT ON TABLE harness_shared.p2p_receipts IS
  'P2P loud-refusal receipts (p2p-work-distribution-2026-07-02 P-004): immutable INSERT-only facts, federated over the hive peer-log so the requester''s machines receive them and p2p:trace assembles the cross-machine timeline (M21 offer_id threading). X8: kind=excused-breach marks preemption-class interruptions, excluded from reliability signals.';

-- M21 trace read path: by offer.
CREATE INDEX IF NOT EXISTS p2p_receipts_offer_idx
  ON harness_shared.p2p_receipts (workspace_id, harness_slug, offer_id, receipt_ts)
  WHERE offer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS p2p_receipts_ts_idx
  ON harness_shared.p2p_receipts (workspace_id, harness_slug, receipt_ts);

-- M15: local refused-op counters for UNAUTHENTICATED failure paths.
CREATE TABLE IF NOT EXISTS harness_shared.p2p_refused_op_counters (
    workspace_id  text        NOT NULL,
    harness_slug  text        NOT NULL,
    reason        text        NOT NULL,
    count         bigint      NOT NULL DEFAULT 0,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT p2p_refused_op_counters_nonneg CHECK (count >= 0),
    PRIMARY KEY (workspace_id, harness_slug, reason)
);

COMMENT ON TABLE harness_shared.p2p_refused_op_counters IS
  'M15 (P-004): counters for UNAUTHENTICATED refused cross-peer ops (no verified requester to receipt — forged grant ops, unattested devices). LOCAL-ONLY; never federated. Loud is not unbounded.';

-- LWW/HLC stamp (mig-439 lesson — every federated table attaches its own).
DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.p2p_receipts;
CREATE TRIGGER stamp_local_federated_write_trg
  BEFORE INSERT OR UPDATE ON harness_shared.p2p_receipts
  FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write();

-- CDC capture: INSERT + DELETE only — receipts are immutable facts (no UPDATE
-- trigger; an UPDATE is a programming error and simply never federates).
CREATE OR REPLACE TRIGGER capture_p2p_receipts_outbox_trg
  AFTER INSERT ON harness_shared.p2p_receipts
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('receipt_id');

CREATE OR REPLACE TRIGGER capture_p2p_receipts_outbox_del_trg
  AFTER DELETE ON harness_shared.p2p_receipts
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('receipt_id');

COMMIT;
