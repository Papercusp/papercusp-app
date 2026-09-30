-- 196-cross-hive-outbox.sql
-- Durable store-and-forward outbox for the cross-Hive boundary
-- (cross-hive-boundary-2026-06-08 P-006). A directed Hive→Hive envelope is
-- enqueued here BEFORE the swarm send is attempted, so a crash mid-send (or a
-- peer Hive being offline) never loses the message — flushCrossHiveOutbox
-- redelivers on reconnect. Replaces the in-memory InMemoryCrossHiveOutbox.
--
-- This is a LOCAL per-Swarm outbox (the sending side's durable queue); it does
-- NOT federate (no capture trigger / peer-log) — the envelope is delivered to
-- the PEER Hive over the cross-hive transport, not replicated within this Hive.
-- Scoped by (workspace_id, hive_slug) = the SENDING Hive's home; envelope id is
-- the stable dedup key.
\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.cross_hive_outbox (
    workspace_id     text NOT NULL,
    hive_slug        text NOT NULL,                 -- the SENDING Hive's home_slug
    id               text NOT NULL,                 -- stable envelope id (dedup + reply correlation)
    from_hive_pubkey text NOT NULL,                 -- raw-32-byte base64 sending Hive pubkey (== this Hive)
    to_hive_pubkey   text NOT NULL,                 -- raw-32-byte base64 recipient Hive pubkey
    kind             text NOT NULL,                 -- ask | work-request | answer | decline
    subject          text NOT NULL DEFAULT '',
    body             text NOT NULL DEFAULT '',
    correlation_id   text,                          -- a reply's originating request id (nullable)
    sig              text NOT NULL,                 -- base64 Ed25519 sig by the sending Hive
    created_at       bigint NOT NULL DEFAULT 0,     -- epoch-ms enqueue time
    attempt_count    integer NOT NULL DEFAULT 0,
    last_attempt_at  bigint NOT NULL DEFAULT 0,     -- epoch-ms of the last delivery attempt
    CONSTRAINT cross_hive_outbox_pkey PRIMARY KEY (workspace_id, hive_slug, id),
    CONSTRAINT cross_hive_outbox_workspace_nonempty CHECK (workspace_id <> ''),
    CONSTRAINT cross_hive_outbox_kind_check
      CHECK (kind IN ('ask', 'work-request', 'answer', 'decline'))
);

-- Pending-drain order: oldest-first per sending Hive.
CREATE INDEX IF NOT EXISTS cross_hive_outbox_pending_idx
  ON harness_shared.cross_hive_outbox USING btree (workspace_id, hive_slug, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.cross_hive_outbox TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.cross_hive_outbox TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;

COMMIT;
