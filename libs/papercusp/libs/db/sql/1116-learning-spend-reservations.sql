-- 1116-learning-spend-reservations.sql
--
-- blender-evidence-driven-learning-redesign-2026-09-04 (P-005): close every
-- learning spend ATTEMPT through reservation + settlement.
--
-- Migration 244 gave the governor a post-hoc ledger: learning_spend_events
-- records a cost AFTER a cycle reports one. Two states have no representation
-- there, and both are what P-005 names:
--
--   * IN FLIGHT — an attempt that has committed to spend but has not been
--     charged yet. Without it, concurrent attempts all read the same
--     `budget - spent` headroom and can collectively overspend it.
--   * CLOSED WITHOUT A CHARGE — a cancelled or failed attempt, or one that
--     evaluated 3 of 10 tasks. The gym/scout mirrors both guard on
--     `costUsd > 0`, so these ledger NOTHING and the loop's real activity is
--     under-reported exactly where a human most wants to look.
--
-- This table is the missing lifecycle row. One row per ATTEMPT:
--
--   requested_usd  what the attempt asked for
--   reserved_usd   what the governor granted (<= requested; clamped to headroom)
--   used_usd       what settlement charged (0 until settled; may be partial)
--   status         'open' is the only non-terminal value; 'settled' /
--                  'cancelled' / 'failed' are all SETTLEMENTS — the attempt is
--                  closed and its reservation released.
--
-- "Unsettled" spend is therefore a query, not a column: SUM(reserved_usd)
-- WHERE status = 'open'. That is the number the old ledger could not express,
-- and it is what makes a crashed or stuck attempt visible instead of silent.
--
-- The money itself still lands on learning_spend_events (append-only, migration
-- 244) — settlement inserts the event and links it back by reservation_id, so
-- the spend ledger stays the one source of charge truth and this table stays
-- the lifecycle. Vocabulary is owned by
-- packages/operator-core/lib/learning-governor/spend.ts; columns stay plain
-- text (status excepted, where a CHECK is cheap and the set is closed),
-- mirroring migration 244's posture so the seam can evolve without a migration.
--
-- Idempotent (CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS); additive;
-- fresh-migrate-safe. No destructive DDL, so no FORWARD-COMPAT line is needed:
-- the currently-deployed release simply does not read either the new table or
-- the new column.

CREATE TABLE IF NOT EXISTS harness_shared.learning_spend_reservations (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  text NOT NULL,
    loop_id       text NOT NULL,
    -- The pot the attempt learns FOR (pot-scope-all-learnings P-004).
    pot_slug      text,
    -- 'proposer' | 'evaluation' | 'promotion' | 'cycle' (see spend.ts). A
    -- proposer call and a partial evaluation are separately closable attempts,
    -- not phases of one uncloseable "cycle" — that distinction is why this is
    -- a column rather than an assumption.
    attempt_kind  text NOT NULL DEFAULT 'cycle',
    requested_usd numeric NOT NULL,
    reserved_usd  numeric NOT NULL,
    used_usd      numeric NOT NULL DEFAULT 0,
    status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'settled', 'cancelled', 'failed')),
    -- Provenance vocabulary shared with migrations 241/244 (P-002/D-002).
    signal_origin text NOT NULL DEFAULT 'organic'
                  CHECK (signal_origin IN ('organic', 'drill', 'replay', 'shadow')),
    -- Correlation to the attempt (gym cycle, scout cycleId, replay run id).
    run_ref       text,
    note          text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    settled_at    timestamptz
);

-- THE gate read: open reservations for one loop, summed on every reservation
-- decision (budget - spent - open_reserved - floor). Partial so the index stays
-- proportional to work IN FLIGHT rather than to all spend history.
CREATE INDEX IF NOT EXISTS learning_spend_reservations_open_idx
    ON harness_shared.learning_spend_reservations (workspace_id, loop_id)
    WHERE status = 'open';

-- Positions rollup + drill-down: the four amounts over a workspace window.
CREATE INDEX IF NOT EXISTS learning_spend_reservations_ws_created_idx
    ON harness_shared.learning_spend_reservations (workspace_id, created_at DESC);

-- Per-loop history (settled attempts included).
CREATE INDEX IF NOT EXISTS learning_spend_reservations_ws_loop_created_idx
    ON harness_shared.learning_spend_reservations (workspace_id, loop_id, created_at DESC);

-- Link a charge back to the attempt that reserved it. NULL for the pre-P-005
-- events already on the ledger and for any future direct charge that is not
-- reservation-backed; a settlement always populates it.
ALTER TABLE harness_shared.learning_spend_events
    ADD COLUMN IF NOT EXISTS reservation_id uuid;

CREATE INDEX IF NOT EXISTS learning_spend_events_reservation_idx
    ON harness_shared.learning_spend_events (reservation_id)
    WHERE reservation_id IS NOT NULL;

-- Workspace isolation, mirroring learning_spend_events (migration 244). The
-- operator connects as harness_admin (superuser, bypasses RLS); the policy
-- keeps any non-superuser path workspace-scoped + consistent with
-- harness_shared.
ALTER TABLE harness_shared.learning_spend_reservations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS learning_spend_reservations_workspace_isolation ON harness_shared.learning_spend_reservations;
CREATE POLICY learning_spend_reservations_workspace_isolation ON harness_shared.learning_spend_reservations
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- Runtime-role grants (reservation/settlement writes run under the app role
-- from the routine actions; zero-sync reads stay read-only).
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.learning_spend_reservations TO harness_app;
GRANT SELECT ON harness_shared.learning_spend_reservations TO harness_zero;
