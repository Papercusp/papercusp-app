-- 474-federation-refused-op-counters.sql — F1-4 / P-012 of
-- federated-scout-gym-learning-2026-07-02 (review H1/H7).
--
-- PER-SOURCE refused-op counters: first-class observability for FEDERATED
-- CONTENT ops (shareable facts, federatable elites, and any other peer-log
-- content table) that the receive-side projection DECLINED to apply — a
-- malformed op, a non-federatable elite a buggy/hostile sender's log carried, or
-- (later, P-014) an op over a per-source rate cap. The counter is keyed by the
-- RECEIVER-STAMPED source (`source_hive` = the immutable sourceLogKeyHex of the
-- admitted remote log, never a sender-claimed field) so "which peer is sending
-- garbage" is a one-line COUNT — the anti-poisoning signal D-005 asks for.
--
-- This mirrors `p2p_refused_op_counters` (mig 468 / P2P M15) exactly — same
-- local-only, never-federated, monotonic-count shape — with ONE added dimension:
-- `source_hive` (the P2P counter counts UNAUTHENTICATED grant-op failures by
-- reason with no source; federation refusals are always attributable to an
-- ADMITTED source log, so the source is the whole point). A separate table (not a
-- reshape of the P2P one) keeps the two refusal domains — grant-plane vs
-- content-federation — honestly distinct.
--
-- LOCAL-ONLY (WORKSPACE_OWNED_EXPLICIT / sync:'none' — registered in
-- harness-state/table-registry.ts): each receiver derives its own refusal counts
-- from ops IT applied; federating them would let a peer skew another machine's
-- observability. Loud is not unbounded.
--
-- Idempotent; apply via the runner (db:migrate) or psql + a schema_migrations
-- row in one txn.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.federation_refused_op_counters (
    workspace_id  text        NOT NULL,
    harness_slug  text        NOT NULL,   -- the receiving hive HOME slug (the projection's guard key)
    -- The receiver-stamped source-log identity (sourceLogKeyHex) of the refused
    -- op, or 'unknown-remote' when a remote op carried no resolvable source.
    source_hive   text        NOT NULL,
    -- The federated content table the op targeted (projection tableTag, e.g.
    -- 'agent-facts-by-key', 'gym-qd-elites-by-niche') — so a mixed-content
    -- source's refusals split by op type.
    table_tag     text        NOT NULL,
    -- Why the op was refused: 'malformed' (failed the wire-shape validator),
    -- 'not-federatable' (an elite whose federatable stamp was not true), or a
    -- future gate reason (P-014 'rate-capped'). Free text, bounded by callers.
    reason        text        NOT NULL,
    count         bigint      NOT NULL DEFAULT 0,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT federation_refused_op_counters_nonneg CHECK (count >= 0),
    CONSTRAINT federation_refused_op_counters_ws_nonempty     CHECK (workspace_id <> ''),
    CONSTRAINT federation_refused_op_counters_slug_nonempty   CHECK (harness_slug <> ''),
    CONSTRAINT federation_refused_op_counters_source_nonempty CHECK (source_hive <> ''),
    CONSTRAINT federation_refused_op_counters_tag_nonempty    CHECK (table_tag <> ''),
    CONSTRAINT federation_refused_op_counters_reason_nonempty CHECK (reason <> ''),
    PRIMARY KEY (workspace_id, harness_slug, source_hive, table_tag, reason)
);

COMMENT ON TABLE harness_shared.federation_refused_op_counters IS
  'F1-4/P-012 (federated-scout-gym): per-source counters for FEDERATED CONTENT ops the receive-side projection declined to apply (malformed / not-federatable / rate-capped). Keyed by receiver-stamped source_hive — the anti-poisoning observability D-005 asks for. LOCAL-ONLY; never federated (mirrors p2p_refused_op_counters + a source dimension).';

COMMIT;
