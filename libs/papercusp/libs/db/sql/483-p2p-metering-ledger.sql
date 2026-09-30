-- 483-p2p-metering-ledger.sql — p2p-work-distribution-2026-07-02 P-205 (WI-1938).
-- The DURABLE metering + contribution ledger behind the pure decision core
-- packages/operator-core/lib/p2p/metering-ledger.ts (M22/H14/PRIVACY semantics
-- live THERE; these tables persist its two counter maps).
--
-- p2p_metering_spend: committed DRAW per (host, fleet, axis) — what fleet F drew
-- from host H on the remote (account) or local (GPU/slot) axis. Metering records
-- ACTUAL spend (no clamp to allotment; over-allotment truth preserved — the
-- advertised remainder floors at 0 in the projection, metering-ledger.ts).
--
-- p2p_metering_contribution: SERVED contribution per ATTESTED USER (M22 — keyed
-- by the numeric gh user id, NEVER a device: machines are cheap, so a device key
-- would let one user inflate reciprocity by spinning up VMs). The stored total
-- is the POST-CAP credited amount (the pure core clamps before the write).
--
-- H14 (unit discipline): a counter's unit is fixed at first write; the store
-- refuses a mismatched-unit draw BEFORE any SQL write (meter_unit_mismatch).
-- No cross-unit conversion, ever.
--
-- LOCAL-ONLY (WORKSPACE_OWNED_EXPLICIT / sync:'none' — registered in
-- harness-state/table-registry.ts): PRIVACY — a host advertises ONLY fleet-scoped
-- remainders + active lease grants (metering-ledger.ts projection); the raw
-- ledger (account totals, per-user breakdown) NEVER leaves the machine. Same
-- convention as p2p_refused_op_counters (mig 468) / resource_allotments (473).
--
-- Idempotent; apply via the runner (db:migrate) or psql + a schema_migrations
-- row in one txn.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.p2p_metering_spend (
    workspace_id  text        NOT NULL,
    -- The drawn-from host (this machine's host ref as the offer plane names it).
    host_ref      text        NOT NULL,
    -- The drawing fleet (D-010 grantee scope key, as in resource_allotments).
    fleet_slug    text        NOT NULL,
    -- BudgetAxis (offer-budget.ts): 'remote' (account spend) | 'local' (GPU/slots).
    axis          text        NOT NULL,
    -- Committed draw total. The pure core only accumulates finite positive
    -- amounts, so the column is monotonically non-decreasing.
    amount        double precision NOT NULL DEFAULT 0,
    -- BudgetUnit: 'usd-micros' | 'tokens' | 'slot-seconds' | 'slots' (H14: fixed
    -- per counter at first write; enforced by the store, CHECKed loose here so a
    -- future unit addition is a code change, not a migration).
    unit          text        NOT NULL,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, host_ref, fleet_slug, axis),
    CONSTRAINT p2p_metering_spend_axis          CHECK (axis IN ('remote', 'local')),
    CONSTRAINT p2p_metering_spend_nonneg        CHECK (amount >= 0),
    CONSTRAINT p2p_metering_spend_ws_nonempty   CHECK (workspace_id <> ''),
    CONSTRAINT p2p_metering_spend_host_nonempty CHECK (host_ref <> ''),
    CONSTRAINT p2p_metering_spend_fleet_nonempty CHECK (fleet_slug <> ''),
    CONSTRAINT p2p_metering_spend_unit_nonempty CHECK (unit <> '')
);

CREATE INDEX IF NOT EXISTS p2p_metering_spend_fleet_idx
  ON harness_shared.p2p_metering_spend (workspace_id, fleet_slug);

CREATE TABLE IF NOT EXISTS harness_shared.p2p_metering_contribution (
    workspace_id     text        NOT NULL,
    -- M22: the ATTESTED numeric GitHub user id (as text — the pure core's key),
    -- never a device pubkey.
    attested_user_id text        NOT NULL,
    axis             text        NOT NULL,
    -- POST-CAP credited total (the pure core clamps to perUserCap pre-write).
    amount           double precision NOT NULL DEFAULT 0,
    unit             text        NOT NULL,
    updated_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, attested_user_id, axis),
    CONSTRAINT p2p_metering_contribution_axis          CHECK (axis IN ('remote', 'local')),
    CONSTRAINT p2p_metering_contribution_nonneg        CHECK (amount >= 0),
    CONSTRAINT p2p_metering_contribution_ws_nonempty   CHECK (workspace_id <> ''),
    CONSTRAINT p2p_metering_contribution_user_nonempty CHECK (attested_user_id <> ''),
    CONSTRAINT p2p_metering_contribution_unit_nonempty CHECK (unit <> '')
);

COMMIT;
