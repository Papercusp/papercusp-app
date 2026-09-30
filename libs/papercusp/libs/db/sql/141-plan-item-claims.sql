-- Migration 141 — plan-item CLAIM (heartbeat-leased, mutually exclusive).
--
-- Plan: plan-item-assignment-claim-liveness-2026-06-04 (Phase 1 + Phase 2 liveness).
--
-- A CLAIM is the live, mutually-exclusive GRIP a running session takes when it
-- actually starts a plan item — the antithesis of the durable ASSIGNMENT
-- (migration 140). It is heartbeat-LEASED (the thing today's feature_claims lacks:
-- that table is an append-only audit log with no TTL — D-001), and it is
-- AUTHORITY-MEDIATED, NEVER federated (mutual exclusion ≠ LWW; D-002): the
-- per-harness lock authority (distributed-coordination-shared-harness Track B,
-- owned by su-584a8) holds this table and is the single serialization point; peers
-- RPC acquire/release/heartbeat to it. On a single box there is one peer → the
-- authority is always self → a local UPDATE (the claim store routes through an
-- authority seam that returns isSelf=true until Track B lands). The PK enforces
-- exactly-one-holder; heartbeats are local to the authority, never touch the
-- peer-log or the plan blob.
--
-- LIVENESS (D-003) is asymmetric, encoded by liveness_mode + the lease:
--   * LOCAL harness  → 'availability': the lease is renewed by ANY heartbeat
--     (the session proving it is alive). Idle ≠ reclaimed ("your fault, manage it").
--   * SHARED harness → 'activity': only an activity heartbeat (a completed turn) or
--     an explicit extend renews the lease; a bare keep-alive does NOT. An idle claim
--     lapses (becomes reclaimable) even while the session lives, because it blocks
--     other members. Plan-item completeness is NOT the pulse (items vary too much).
-- A claim lapses when expires_ts < now(); on lapse, item returns to the ASSIGNEE if
-- assigned (assignment persists), else to the shared pool (D-004) — resolved by the
-- liveness layer reading plan_item_assignments, not stored here.
--
-- This table mirrors the su-lock-store agent_file_locks lease shape (claim_id uuid,
-- expires_ts, owner-checked heartbeat/release). NO RLS (coord-family); the claim
-- store uses the org handle + workspace_id filter. NOT federated (no origin/
-- author_pubkey, no capture trigger).
--
-- Idempotent; composes onto 000-baseline.sql; applies on :5432.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.plan_item_claims (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    plan_slug text NOT NULL,
    item_id text NOT NULL,                           -- the P-NNN plan-item id

    claim_id uuid DEFAULT gen_random_uuid() NOT NULL, -- immutable for the claim's lifetime; required to heartbeat/release
    owner text NOT NULL,                              -- the holding session's ownerId (resolveAgentIdentity)
    owner_label text,                                 -- display only
    owner_name text,                                  -- the holder's adopted agent-NAME (for lapse-to-assignee match + display); NULL = unnamed pull
    intent text DEFAULT ''::text NOT NULL,

    liveness_mode text DEFAULT 'availability'::text NOT NULL,  -- 'availability' (LOCAL) | 'activity' (SHARED) — D-003
    ttl_sec integer DEFAULT 1200 NOT NULL,            -- the lease length re-applied on each renewing heartbeat
    acquired_ts timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_ts timestamp with time zone NOT NULL,     -- the lease; claim lapses (reclaimable) when this < now()
    last_activity_ts timestamp with time zone DEFAULT clock_timestamp() NOT NULL,  -- last activity/extend heartbeat (the SHARED pulse)

    CONSTRAINT plan_item_claims_pkey PRIMARY KEY (workspace_id, harness_slug, plan_slug, item_id),
    CONSTRAINT plan_item_claims_mode_check CHECK ((liveness_mode = ANY (ARRAY['availability'::text, 'activity'::text]))),
    CONSTRAINT plan_item_claims_workspace_nonempty CHECK ((workspace_id <> ''::text)),
    CONSTRAINT plan_item_claims_owner_nonempty CHECK ((owner <> ''::text))
);

COMMENT ON TABLE harness_shared.plan_item_claims IS
  'Per-plan-item leased CLAIM (plan-item-assignment-claim-liveness D-001..D-004): a live, mutually-exclusive, heartbeat-leased grip held by one session. Authority-mediated (per-harness lock authority, distributed-coordination Track B), NEVER federated. liveness_mode availability(LOCAL)/activity(SHARED) governs what renews the lease (expires_ts). PK enforces one holder. Mirrors the su-lock-store agent_file_locks lease.';

CREATE INDEX IF NOT EXISTS plan_item_claims_owner_idx
  ON harness_shared.plan_item_claims USING btree (workspace_id, owner);
CREATE INDEX IF NOT EXISTS plan_item_claims_expires_idx
  ON harness_shared.plan_item_claims USING btree (expires_ts);
CREATE INDEX IF NOT EXISTS plan_item_claims_name_idx
  ON harness_shared.plan_item_claims USING btree (workspace_id, owner_name)
  WHERE (owner_name IS NOT NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.plan_item_claims TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.plan_item_claims TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;

COMMIT;
