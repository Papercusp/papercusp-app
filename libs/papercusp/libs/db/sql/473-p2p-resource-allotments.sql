-- 473-p2p-resource-allotments.sql — p2p-work-distribution-2026-07-02 P-201.
-- Two-axis allotment records per (host, fleet): the persistence behind the
-- /res Resources board (a host hands its account pools + local GPUs to the
-- fleets in its hive tree, each with a share cap).
--
-- LOCAL, NOT FEDERATED (M19): allotments stay per-machine — physics differ per
-- box (a GPU slot is physical to THIS machine; an account-pool $ cap is this
-- host's spend). Unlike p2p_peer_grants (mig 463, federated USER-level), this
-- table has NO CDC capture / no LWW-HLC stamp: it never leaves the machine that
-- owns the resource. The host advertises only fleet-scoped REMAINDERS derived
-- from these rows (P-205/P-206 privacy), never the rows themselves.
--
-- M11 — DEFAULT ALLOTMENT IS ZERO: joining a fleet grants it nothing. A row's
-- EXISTENCE (created by the host in /res) is the explicit opt-in; share_pct is
-- the cap. No row ⇒ the fleet may draw nothing from this resource.
--
-- CAPS, NOT RESERVATIONS (D-008): oversubscription is safe — contention
-- resolves at claim time (P-202 host-gateway claim authority reads these caps
-- against live headroom). A cap is a ceiling, never a guaranteed reservation.
--
-- TWO AXES: resource_kind splits them. 'account' rows are the REMOTE axis (a %
-- of the pool's budget → a $/model-class cap for the fleet). 'gpu' rows are the
-- LOCAL axis (a share of local inference slots/time). The richer axis fields
-- (dollar cap, model-class weights, windows, preemptClass, slot count — P-201's
-- full D-008 shape) land in the `axis` JSONB seam and graduate to typed columns
-- as the Phase-2 economics (P-202..P-207) are built; share_pct is the v1 cap
-- the /res GUI writes today (GPU locked at 100% until local inference, P-207).
--
-- Idempotent; apply via the runner (db:migrate) or psql + a schema_migrations
-- row in one txn.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.resource_allotments (
    workspace_id    text        NOT NULL,
    -- The grantee fleet (slug). One host may allot to many fleets.
    fleet_slug      text        NOT NULL,
    -- 'account' (remote axis — a gateway account pool) | 'gpu' (local axis — a
    -- local inference device). Extensible; app-side validation in the store.
    resource_kind   text        NOT NULL,
    -- The resource identity: a pool id (accounts:list) or a local device id.
    resource_ref    text        NOT NULL,
    -- The share CAP as a percent. Remote axis: % of the pool budget the fleet
    -- may spend. Local axis: % of GPU time/slots. M11: meaningful only because
    -- the ROW exists (opt-in); absence ⇒ zero.
    share_pct       integer     NOT NULL DEFAULT 0,
    -- Forward-compat seam for P-201's full two-axis shape without a migration
    -- per field: { dollarCapUsd, modelClassWeights, windows, allowedModels,
    -- preemptClass, slots, ... }. Typed columns graduate as P-202..P-207 land.
    axis            jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- active | paused (a host can pause an allotment without deleting it — the
    -- /res "Contributing/Paused" control). Enforcement treats paused as zero.
    status          text        NOT NULL DEFAULT 'active',
    -- X9: the NUMERIC GitHub user-id of the host who set this (display/audit
    -- only; the resource is this machine's, the setter is its operator).
    created_by_github_user_id bigint,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT resource_allotments_ws_nonempty    CHECK (workspace_id <> ''),
    CONSTRAINT resource_allotments_fleet_nonempty CHECK (fleet_slug <> ''),
    CONSTRAINT resource_allotments_kind           CHECK (resource_kind IN ('account', 'gpu')),
    CONSTRAINT resource_allotments_ref_nonempty   CHECK (resource_ref <> ''),
    CONSTRAINT resource_allotments_pct            CHECK (share_pct >= 0 AND share_pct <= 100),
    CONSTRAINT resource_allotments_status         CHECK (status IN ('active', 'paused')),
    -- One allotment per (fleet, resource) on this machine. Re-allocating the
    -- same resource to the same fleet is an UPSERT of the cap.
    PRIMARY KEY (workspace_id, fleet_slug, resource_kind, resource_ref)
);

COMMENT ON TABLE harness_shared.resource_allotments IS
  'P-201 two-axis allotments (p2p-work-distribution-2026-07-02): per-machine (M19) caps a host sets in /res handing its account pools (remote axis) + local GPUs (local axis) to fleets. LOCAL — never federated (no CDC/LWW): the resource is this machine''s. M11 default-zero (a row is the opt-in); caps not reservations (contention resolves at claim time, P-202). The full D-008 axis shape lands in the axis JSONB seam.';
COMMENT ON COLUMN harness_shared.resource_allotments.axis IS
  'P-201 forward seam for the full two-axis contract (dollar cap / model-class weights / windows / allowedModels / preemptClass / slots). Typed columns graduate as P-202..P-207 land; share_pct is the v1 cap the /res GUI writes.';

-- GUI read: "all allotments in this workspace" (the /res board's own view).
CREATE INDEX IF NOT EXISTS resource_allotments_ws_idx
  ON harness_shared.resource_allotments (workspace_id)
  WHERE status = 'active';

-- Claim-authority read (P-202): "what may fleet F draw here right now", both axes.
CREATE INDEX IF NOT EXISTS resource_allotments_fleet_idx
  ON harness_shared.resource_allotments (workspace_id, fleet_slug)
  WHERE status = 'active';

COMMIT;
