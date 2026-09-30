-- 436-coord-quarantine.sql
-- cross-machine-coord-parity-and-trust-2026-07-01 P-013 (D-003/D-004):
-- QUARANTINE, DON'T DROP. A federated coord message whose verified author sits
-- BELOW the required comms tier (below 'message' for inbox delivery; below
-- 'steer' for a handoff) is diverted HERE instead of applying to
-- coord_event_log — visible, grantable, never silently vanished. The requests
-- surface ("X wants to message you — grant a tier?") reads this table; a
-- subsequent trust grant lets the owner replay or simply lets future messages
-- through. Mirrors the membership approval-queue pattern.
--
-- LOCAL-ONLY (never federates — no capture trigger): quarantine is the
-- RECEIVER's judgment about the sender. Bounded by the writer (per-author cap,
-- oldest evicted) so an untrusted member cannot flood PG.

BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.coord_quarantine (
    workspace_id            text NOT NULL DEFAULT '',
    msg_id                  text NOT NULL,
    harness_slug            text NOT NULL,
    surface                 text NOT NULL,
    body                    jsonb NOT NULL,
    -- The VERIFIED author (attestation chain), never envelope fields.
    author_github_user_id   bigint,
    author_device_pubkey    text NOT NULL,
    reason                  text NOT NULL CHECK (reason IN ('below-message-tier', 'handoff-below-steer')),
    -- The message's own ts (epoch ms) + when we quarantined it.
    msg_ts                  bigint NOT NULL,
    created_ts              bigint NOT NULL,
    PRIMARY KEY (workspace_id, msg_id)
);

CREATE INDEX IF NOT EXISTS coord_quarantine_author_idx
  ON harness_shared.coord_quarantine (workspace_id, author_device_pubkey, created_ts);

COMMENT ON TABLE harness_shared.coord_quarantine IS
  'Below-tier federated coord messages (P-013, cross-machine-coord-parity-and-trust-2026-07-01). Quarantine-don''t-drop: the requests surface reads it; a comms-trust grant unblocks the sender. Local-only, per-author-bounded.';

COMMIT;
