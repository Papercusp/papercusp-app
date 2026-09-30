-- 231-cross-hive-asks.sql
-- Durable ask ledger for the cross-Hive boundary, ASKING side
-- (hive-network-surface-2026-06-11 P-002, contract C-1). One row per cross-Hive
-- request this Hive tracks: an outbound ask/work-request we initiated
-- (direction 'out'), or an inbound request another Hive made of us
-- (direction 'in'). It is the durable record the ephemeral onReply callback
-- could not provide — an answer arriving after a restart correlates back to its
-- row by correlation_id, and a sleeping Queen is woken on
-- `cross-hive:answered:<correlationId>`.
--
-- LOCAL per-Swarm ledger (the asking side's durable state); it does NOT federate
-- (no capture trigger / peer-log) — it records THIS Swarm's view of its own
-- cross-Hive traffic. Scoped by (workspace_id, hive_slug) = the asking Hive's
-- home, mirroring the cross_hive_outbox (migration 196) conventions.
--
-- Legal state transitions (enforced in the store, cross-hive-asks-pg.ts):
--   queued -> sent -> answered | declined ; queued | sent -> expired
-- answered / declined / expired are terminal.
\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS harness_shared.cross_hive_asks (
    workspace_id   text NOT NULL,
    hive_slug      text NOT NULL,                 -- the asking Hive's home_slug
    id             uuid NOT NULL DEFAULT gen_random_uuid(),
    peer_pubkey    text NOT NULL,                 -- raw-32-byte base64 peer Hive pubkey
    direction      text NOT NULL DEFAULT 'out',   -- out (we asked) | in (we were asked)
    kind           text NOT NULL,                 -- ask | work-request
    subject        text NOT NULL DEFAULT '',
    body           text NOT NULL DEFAULT '',
    correlation_id text NOT NULL,                 -- the wire envelope id a reply correlates to
    state          text NOT NULL DEFAULT 'queued',
    reply_body     text,                          -- answer/decline body, once received
    reply_ts       timestamptz,                   -- when the reply landed
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cross_hive_asks_pkey PRIMARY KEY (id),
    CONSTRAINT cross_hive_asks_workspace_nonempty CHECK (workspace_id <> ''),
    CONSTRAINT cross_hive_asks_direction_check CHECK (direction IN ('out', 'in')),
    CONSTRAINT cross_hive_asks_kind_check CHECK (kind IN ('ask', 'work-request')),
    CONSTRAINT cross_hive_asks_state_check
      CHECK (state IN ('queued', 'sent', 'answered', 'declined', 'expired')),
    -- correlation_id is unique within a Hive — it is the reply's lookup key, so a
    -- duplicate reply (store-and-forward redelivery) can never fork into two rows.
    -- This UNIQUE also serves as the correlation-lookup index.
    CONSTRAINT cross_hive_asks_correlation_uniq UNIQUE (workspace_id, hive_slug, correlation_id)
);

-- List/filter order: most-recent-first per asking Hive (the hive:asks + Network board order).
CREATE INDEX IF NOT EXISTS cross_hive_asks_listing_idx
  ON harness_shared.cross_hive_asks USING btree (workspace_id, hive_slug, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.cross_hive_asks TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.cross_hive_asks TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;
