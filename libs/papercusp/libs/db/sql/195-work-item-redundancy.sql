-- Migration 195 — work-item REDUNDANCY (BOINC-style, opt-in, off by default).
--
-- Plan: decentralized-dispatch-scaling-2026-06-08 (Phase 5, P-014).
--
-- BOINC-style redundancy for HIGH-STAKES work items: the same item is run
-- INDEPENDENTLY by N Swarms (replicas), then a judge (reuse gym:judge — the frozen
-- Opus grader) scores each replica and the strongest is ADOPTED as the item's result.
-- The losers are discarded. This INVERTS the default exactly-once claim (one Swarm
-- per item) for items the owner deliberately marks high-stakes — agentic work is
-- expensive, so redundancy is opt-in, NOT BOINC's run-everything-twice default.
--
-- TWO independent gates keep this inert until deliberately turned on:
--   1. The runtime flag PAPERCUSP_WORKITEM_REDUNDANCY=1 (workItemRedundancyEnabled()) —
--      the master switch. OFF (default) ⇒ the redundancy machinery is never reached and
--      claim_next is byte-identical to before (a `redundancy`-marked item is still claimed
--      exactly-once like everything else).
--   2. The per-item `redundancy` column below (default NULL ⇒ 1 ⇒ exactly-once) — which
--      items are high-stakes. Only items with redundancy > 1 fan out, and only when (1) is on.
--
-- (a) `harness_features_consolidated.redundancy` — the per-item opt-in. NULL/1 = today's
--     exactly-once behavior; N>1 = run on N Swarms + judge. Additive no-op until the flag is on
--     (mirrors the swarm_affinity column, mig 191).
--
-- (b) `work_item_replicas` — the redundancy-group ledger. One row per (item, replica_index):
--     a heartbeat-LEASED slot a Swarm holds while it runs its independent replica (mirroring the
--     work_item_claims lease, mig 188, so a dead Swarm's replica slot lapses and is re-claimable),
--     PLUS the replica's recorded result and the judge's verdict (composite score + rationale).
--     The exactly-once `work_item_claims` lease (mig 188) is one-holder-per-item by PK; THIS table
--     is one-holder-per-(item, slot), so up to N distinct Swarms hold distinct slots of the SAME
--     item — "claim one item to 2 Swarms". The winner's row (status='winner') is the durable record
--     of which replica was adopted.
--
-- Idempotent; composes onto 000-baseline.sql; applies on :5432.

\set ON_ERROR_STOP on
BEGIN;

-- (a) Per-item opt-in marker. Feature-family only (issue-family bugs/changes aren't
-- high-stakes pipeline items). NULL = no redundancy (exactly-once). Inert until the flag is on.
ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS redundancy integer;

COMMENT ON COLUMN harness_shared.harness_features_consolidated.redundancy IS
  'BOINC redundancy opt-in (decentralized-dispatch-scaling P-014): run this high-stakes item on N Swarms + judge. NULL/1 = exactly-once (default). Honored only when PAPERCUSP_WORKITEM_REDUNDANCY=1.';

-- (b) The redundancy-group ledger: leased replica slots + recorded results + judge verdicts.
CREATE TABLE IF NOT EXISTS harness_shared.work_item_replicas (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    work_item_id text NOT NULL,                       -- the high-stakes work-item id (the group)
    replica_index integer NOT NULL,                   -- this replica's slot, 0 .. redundancy-1
    redundancy integer NOT NULL,                      -- the target replica count N (denormalized at claim)

    -- Lease (mirrors work_item_claims, mig 188): a dead/idle Swarm's replica slot lapses
    -- when expires_ts < now() and is re-claimable by another Swarm (work-stealing the slot).
    claim_id uuid DEFAULT gen_random_uuid() NOT NULL, -- immutable for the slot's lifetime; required to heartbeat/release
    owner text NOT NULL,                              -- the Swarm session holding this replica slot (resolveAgentIdentity)
    owner_label text,                                 -- display only
    holder_pubkey text,                               -- the claiming Swarm's device pubkey (cross-Swarm identity); NULL on single box
    ttl_sec integer DEFAULT 1800 NOT NULL,            -- lease length re-applied on each renewing heartbeat (30m default)
    acquired_ts timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_ts timestamp with time zone NOT NULL,     -- the lease; slot lapses (reclaimable) when this < now()
    last_activity_ts timestamp with time zone DEFAULT clock_timestamp() NOT NULL,

    -- Lifecycle + the replica's recorded output.
    status text DEFAULT 'claimed' NOT NULL,           -- claimed → complete → winner|loser
    result jsonb,                                     -- {text, meta?} — the distilled output the judge scores + the winner adopts

    -- Judge verdict (gym:judge frozen-Opus composite over this replica's result).
    judge_composite double precision,                 -- the weighted composite reward (winner = highest)
    judge_rationale text,
    judge_model text,
    rubric_hash text,
    judge_cost_usd double precision,
    judged_ts timestamp with time zone,

    created_ts timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_ts timestamp with time zone DEFAULT clock_timestamp() NOT NULL,

    CONSTRAINT work_item_replicas_pkey PRIMARY KEY (workspace_id, harness_slug, work_item_id, replica_index),
    CONSTRAINT work_item_replicas_status_check CHECK (status IN ('claimed', 'complete', 'winner', 'loser')),
    CONSTRAINT work_item_replicas_workspace_nonempty CHECK ((workspace_id <> ''::text)),
    CONSTRAINT work_item_replicas_owner_nonempty CHECK ((owner <> ''::text)),
    CONSTRAINT work_item_replicas_index_nonneg CHECK ((replica_index >= 0)),
    CONSTRAINT work_item_replicas_redundancy_positive CHECK ((redundancy >= 1))
);

COMMENT ON TABLE harness_shared.work_item_replicas IS
  'BOINC redundancy-group ledger (decentralized-dispatch-scaling P-014): one leased slot per (high-stakes item, replica_index). Up to N distinct Swarms hold distinct slots of the SAME item and run it independently; each records its result; gym:judge scores each; the highest composite is adopted (status=winner). Lease mirrors work_item_claims (mig 188) — a lapsed slot (expires_ts < now()) is re-claimable. Opt-in/off-by-default: gated by PAPERCUSP_WORKITEM_REDUNDANCY + the per-item redundancy column.';

CREATE INDEX IF NOT EXISTS work_item_replicas_item_idx
  ON harness_shared.work_item_replicas USING btree (workspace_id, harness_slug, work_item_id);
CREATE INDEX IF NOT EXISTS work_item_replicas_owner_idx
  ON harness_shared.work_item_replicas USING btree (workspace_id, owner);
CREATE INDEX IF NOT EXISTS work_item_replicas_expires_idx
  ON harness_shared.work_item_replicas USING btree (expires_ts);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.work_item_replicas TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.work_item_replicas TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;

COMMIT;
