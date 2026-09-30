-- Migration 188 — work-item CLAIM (heartbeat-leased, mutually exclusive, Hive-arbitrated).
--
-- Plan: decentralized-dispatch-scaling-2026-06-08 (Phase 1, P-004 / D-002).
--
-- A work-item CLAIM is the live, mutually-exclusive GRIP a Swarm takes when it
-- work-steals a ready item off its Hive's shared backlog (the cross-machine
-- claim-pull, D-001/D-009). It is heartbeat-LEASED (ttl + renewing heartbeat — a
-- dead/idle Swarm's claim simply lapses when `expires_ts < now()`, so the item
-- returns to the backlog for another Swarm to steal) and AUTHORITY-MEDIATED, NEVER
-- federated (mutual exclusion ≠ LWW; D-002): the per-HIVE lock authority (the
-- lowest-live-device-pubkey peer — `lockAuthorityForHive`, shared-hive-federation
-- P-009 / mig 187) is the single serialization point; peers RPC acquire/heartbeat/
-- release to it. On a single box there is one peer → the authority is always self →
-- a local UPDATE (the work-item-claims store routes through the same claim-authority
-- seam plan-items use; isSelf=true until the cross-Swarm mesh transport lands). When
-- the authority is partitioned, acquire fails OPEN to a local advisory lease (D-007
-- hybrid) and `work-item-claim-reconcile.ts` (P-005) deterministically resolves any
-- double-claim on reconvergence (earliest-claim / lowest-pubkey wins).
--
-- Distinct from the per-plan-item lease (mig 141 plan_item_claims): that is
-- per-HARNESS-authority + plan-item granularity for the plan-item assignment surface;
-- THIS is per-HIVE-authority + work-item (feature/issue/chunk) granularity for the
-- dispatch backlog. The existing `taken_by`/`assignee` columns on the work_items
-- base tables stay as the local "claimed" denorm; this lease is the authority-
-- arbitrated cross-Swarm grip layered on top (wired in P-006, flag-gated).
--
-- `hive_slug` = the authority scope (which Hive arbitrates), denormalized so the
-- backlog/reconcile can query by Hive without a registry join. `holder_pubkey` = the
-- claiming Swarm's device pubkey — carried so the P-005 reconcile + the authority
-- election agree on identity. Mirrors the agent_file_locks / plan_item_claims lease
-- shape (claim_id uuid, expires_ts, owner-checked heartbeat/release). NO RLS
-- (coord-family); the store uses the org handle + workspace_id filter. NOT federated.
--
-- Idempotent; composes onto 000-baseline.sql; applies on :5432.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.work_item_claims (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    work_item_id text NOT NULL,                       -- the F-NNN / B-NNN work-item id (unique within a harness)

    hive_slug text,                                   -- the authority scope (Hive home of the harness); NULL = harness-scoped fallback
    claim_id uuid DEFAULT gen_random_uuid() NOT NULL, -- immutable for the claim's lifetime; required to heartbeat/release
    owner text NOT NULL,                              -- the holding Swarm session's ownerId (resolveAgentIdentity)
    owner_label text,                                 -- display only
    holder_pubkey text,                               -- the claiming Swarm's device pubkey (reconcile + authority-election identity); NULL on single box
    intent text DEFAULT ''::text NOT NULL,

    ttl_sec integer DEFAULT 1800 NOT NULL,            -- the lease length re-applied on each renewing heartbeat (30m default — generous for an LLM work turn)
    acquired_ts timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_ts timestamp with time zone NOT NULL,     -- the lease; claim lapses (reclaimable) when this < now()
    last_activity_ts timestamp with time zone DEFAULT clock_timestamp() NOT NULL,

    CONSTRAINT work_item_claims_pkey PRIMARY KEY (workspace_id, harness_slug, work_item_id),
    CONSTRAINT work_item_claims_workspace_nonempty CHECK ((workspace_id <> ''::text)),
    CONSTRAINT work_item_claims_owner_nonempty CHECK ((owner <> ''::text))
);

COMMENT ON TABLE harness_shared.work_item_claims IS
  'Per-work-item leased CLAIM (decentralized-dispatch-scaling P-004 / D-002): a live, mutually-exclusive, heartbeat-leased grip a Swarm takes when it claim-pulls a ready item off its Hive backlog. Authority-mediated by the per-HIVE lock authority (lockAuthorityForHive, shared-hive-federation P-009), NEVER federated. Lapses on expires_ts < now() so a dead/idle Swarm''s item returns to the backlog (work-stealing). holder_pubkey + acquired_ts feed the fail-open reconcile (P-005). Mirrors the plan_item_claims/agent_file_locks lease.';

CREATE INDEX IF NOT EXISTS work_item_claims_owner_idx
  ON harness_shared.work_item_claims USING btree (workspace_id, owner);
CREATE INDEX IF NOT EXISTS work_item_claims_expires_idx
  ON harness_shared.work_item_claims USING btree (expires_ts);
CREATE INDEX IF NOT EXISTS work_item_claims_hive_idx
  ON harness_shared.work_item_claims USING btree (workspace_id, hive_slug)
  WHERE (hive_slug IS NOT NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.work_item_claims TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.work_item_claims TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;

COMMIT;
