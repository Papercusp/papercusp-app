-- 434-shared-session-presence.sql
-- cross-machine-coord-parity-and-trust-2026-07-01 P-005 (D-001/D-002/D-008):
-- SESSION-GRAIN federated presence — the keystone of cross-machine parity.
--
-- Remote agents were invisible as individuals: `shared_presence` is
-- per-(user, machine) grain, surfaced with synthetic `fed:<gh>@<machine>`
-- ownerIds, so a remote su-<uuid>/bee is neither discoverable via
-- coord:presence nor addressable by coord:send (the strict roster gate rejects
-- it as unknown_recipient). This table carries each machine's LIVE SESSIONS
-- (su-*/s-*/queen ownerIds + kind/intent/plan) so the unified roster (P-006)
-- and the recipient resolver (P-007) see remote agents as first-class rows.
--
-- TRANSPORT: GOSSIP-ONLY by design (presence-gossip.ts 'sessions' frames —
-- device-signed, membership-gated). Session beats are ephemeral; they must
-- NEVER ride the append-only peer-log (the 256×10 scaling wall, plan D-002).
-- Therefore: NO capture trigger, NO substrate_outbox enqueue, NO projection
-- tag — this table is deliberately absent from PEER_LOG_TAG_TO_TABLE and the
-- table-registry's peer-log set. Rows age out by TTL on the read side; the
-- writer replaces a device's whole session set per frame (full-set semantics,
-- self-healing against missed frames).
--
-- Grain: one row per (workspace, owner_id, machine_label). owner_id is
-- globally unique in practice (su-<uuid> / s-<ts>-<hash>), machine_label
-- disambiguates a defensive collision + makes the device's full-set replace
-- cheap (DELETE WHERE device scope AND owner_id NOT IN (...)).

BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.shared_session_presence (
    workspace_id     text NOT NULL DEFAULT '',
    -- The hive this session federates under (the gossip topic's hive home) —
    -- the roster + lock-authority scope key, mirroring shared_presence.hive_slug.
    hive_slug        text,
    -- The session's harness scope (within-hive demux — D-006: keep the demux
    -- column on every federated surface; interest-scoped replication later).
    harness_slug     text NOT NULL,
    owner_id         text NOT NULL,
    -- 'su' | 'bee' | 'queen' | … (advisory display/routing hint, free text —
    -- the sender's classification, not an enforced enum).
    kind             text NOT NULL DEFAULT 'su',
    intent           text,
    plan_slug        text,
    github_user_id   bigint NOT NULL,
    machine_label    text NOT NULL,
    device_pubkey    text NOT NULL,
    -- Sender-declared liveness beat (epoch → timestamptz); readers apply their
    -- own staleness window (lag-aware) — same posture as shared_presence.
    last_seen_at     timestamptz NOT NULL DEFAULT now(),
    schema_version   bigint NOT NULL DEFAULT 1,
    PRIMARY KEY (workspace_id, owner_id, machine_label)
);

-- Roster reads: "live remote sessions of hive H" and "of harness X".
CREATE INDEX IF NOT EXISTS shared_session_presence_hive_idx
  ON harness_shared.shared_session_presence (workspace_id, hive_slug, last_seen_at DESC)
  WHERE hive_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS shared_session_presence_device_idx
  ON harness_shared.shared_session_presence (workspace_id, device_pubkey);

COMMENT ON TABLE harness_shared.shared_session_presence IS
  'Session-grain federated presence (P-005, cross-machine-coord-parity-and-trust-2026-07-01). GOSSIP-ONLY: written by presence-gossip ''sessions'' frames (device-signed, hive_members-gated) + the local announcer; never rides the peer-log (no capture trigger / projection tag — deliberate, see plan D-002). TTL-read; a device''s frame replaces its whole session set.';

COMMIT;
