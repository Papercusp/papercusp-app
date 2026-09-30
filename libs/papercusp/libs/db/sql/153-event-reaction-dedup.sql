-- Migration 153 — event-reaction idempotency ledger (D-007)
-- (plan event-reaction-system-2026-06-04, P1 / D-004 + D-007).
--
-- A durable (DBOS-queued) reaction may be delivered more than once (at-least-once
-- under DBOS recovery — a crash mid-fire re-runs the fire step). Each reaction
-- keys on a deterministic `dedup_id`; the durable fire step CLAIMS the id here
-- (INSERT … ON CONFLICT DO NOTHING) BEFORE dispatching the reaction tool, so a
-- re-delivery finds the claim and is a no-op — "a double-fire is a no-op" (D-007).
-- This is the reaction-execution analogue of the substrate fanout's
-- partial-unique-index dedup (126-coordination-fanout.sql).
--
-- The in-process reaction path (P0, the live default) does NOT use this table —
-- it fires exactly once per match and never retries. The table matters only when
-- the durable DBOS path is enabled (PAPERCUSP_DBOS_REACTIONS=1).
--
-- Additive + idempotent. Composes onto 000-baseline.sql for fresh/embedded-pg
-- boots; safe additive on the native :5432 box. Runs as harness_admin.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.event_reactions (
    -- Deterministic per logical reaction: `reaction:<rootRunId|runId>:<ruleId>[:<dedupKey>]`.
    -- The PRIMARY KEY IS the dedup gate.
    dedup_id          text PRIMARY KEY,
    workspace_id      text NOT NULL,
    -- The rule that fired + the tool it fired + the trigger that caused it.
    rule_id           text NOT NULL,
    fire              text NOT NULL,
    trigger_tool      text,
    -- Cause-chain provenance (mirrors tool_invocations.metadata_json.reaction).
    cause_root_run_id text,
    depth             integer NOT NULL DEFAULT 0,
    -- 'fired' once the reaction dispatched ok; 'failed' if the dispatch errored.
    status            text NOT NULL DEFAULT 'fired',
    error_message     text,
    fired_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE harness_shared.event_reactions IS
    'Idempotency ledger for durable event-reactions (event-reaction-system D-007). The durable fire step claims dedup_id (PK) before dispatching, so an at-least-once re-delivery is a no-op. Unused by the in-process reaction path (P0).';

-- Recent reactions per workspace (the reactive-graph "what fired" view, D-010).
CREATE INDEX IF NOT EXISTS event_reactions_ws_fired_idx
    ON harness_shared.event_reactions (workspace_id, fired_at DESC);

-- "What did rule R fire, and when" — rule-scoped inspection.
CREATE INDEX IF NOT EXISTS event_reactions_rule_idx
    ON harness_shared.event_reactions (rule_id, fired_at DESC);

COMMIT;
