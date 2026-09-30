-- 266-autonomy-tripwires.sql
--
-- queen-autonomy-policy-2026-06-13 (B-16 / P-080, P-081, P-082): the auto-revert
-- tripwire ledger — one row per Queen AUTO-decision of a REVERSIBLE action. Each
-- row carries a `revert_handle` (how to undo the action) and an armed WATCH
-- window; a sweep evaluates the window against the outcome rails (EKG drift ·
-- validator bounce · gym regression · owner thumbs-down) and, on a hit, TRIPS:
-- auto-revert + demote the category one step (D-006 / D-005).
--
-- The table doubles as the GRADUATION evidence source (P-082): a tripwire that
-- closes its window clean is one clean auto-pass for its (category, class); a
-- tripped one resets the streak. The graduation engine counts trailing clean
-- passes per (category, class) and, on threshold, raises the category's
-- `graduated_level` WITHIN the owner ceiling (autonomy_policy, mig 259 — the
-- store clamps ≤ ceiling) and files an owner "graduation-eligible" report. It
-- never raises the ceiling itself (authority, never auto).
--
-- SAFETY / behavior-neutral (D-007): rows only ever get written when the Queen
-- ACTUALLY auto-decides, which requires the P-092 arming flag ON *and* a category
-- ceiling lowered below never-auto. Both ship dark, so this table stays empty
-- until the owner deliberately arms autonomy — the whole subsystem is dormant by
-- construction. Irreversible / owner-authority / protected actions never auto, so
-- they never get a row (the arming core enforces it; the CHECK is belt-and-braces).
--
-- Category ids are the canonical 13-category partition (categories.ts
-- AUTONOMY_CATEGORY_IDS); risk_tier vocabulary = @papercusp/plan-parser
-- RISK_TIERS (B-01 seam). Mutable status table (armed → cleared|tripped →
-- reverted): harness_app keeps SELECT/INSERT/UPDATE; DELETE/TRUNCATE revoked
-- (the ledger is history — rows are resolved in place, never removed). The
-- baseline's ALTER DEFAULT PRIVILEGES hands harness_app ALL at CREATE, so the
-- REVOKE rides this migration (246's lesson). harness_zero (read-only sync) gets
-- SELECT only.
--
-- Idempotent; additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.autonomy_tripwires (
    id              text PRIMARY KEY,
    workspace_id    text NOT NULL DEFAULT 'default',
    -- The auto-decided action's category (one of the 13 canonical ids).
    category        text NOT NULL,
    -- The (category, class) sub-key the graduation engine counts on — finer than
    -- category so one narrow action's track record never graduates the whole
    -- category off alone. 'unclassified' when the class can't be resolved.
    finding_class   text NOT NULL DEFAULT 'unclassified',
    -- The MCP tool/verb the auto-decided action used (group:verb), for the ledger.
    action          text,
    -- The item's graded risk at decision time (B-01 vocabulary).
    risk_tier       text NOT NULL DEFAULT 'critical'
        CHECK (risk_tier IN ('trivial', 'low', 'moderate', 'high', 'critical')),
    -- Always 'reversible' for an armed tripwire — irreversible never auto (B-02
    -- hard gate). Stored for ledger fidelity; the CHECK bars an irreversible row.
    reversibility   text NOT NULL DEFAULT 'reversible'
        CHECK (reversibility = 'reversible'),
    -- How to UNDO the action if the watch trips: { kind, ... } — opaque to this
    -- table, interpreted by the revert executor (e.g. a git sha to revert, a
    -- flag's prior value, a placement id to unplace).
    revert_handle   jsonb NOT NULL,
    -- The AutonomyDecision snapshot (category · action · risk · reversibility ·
    -- ceiling · reasons), for the ledger / settings "why" surface.
    decision        jsonb,
    -- armed → (cleared | tripped); tripped → reverted (after the revert executes).
    status          text NOT NULL DEFAULT 'armed'
        CHECK (status IN ('armed', 'cleared', 'tripped', 'reverted')),
    -- Which watch signal tripped it (null until tripped).
    trip_reason     text
        CHECK (trip_reason IS NULL OR trip_reason IN
            ('ekg-drift', 'validator-bounce', 'gym-regression', 'owner-thumbs-down')),
    armed_at        timestamptz NOT NULL DEFAULT now(),
    -- End of the watch window — the sweep clears an armed row clean once now()
    -- passes this with no signal.
    window_until    timestamptz NOT NULL,
    -- When the row left 'armed' (cleared or tripped).
    resolved_at     timestamptz,
    -- When the auto-revert actually executed (status 'reverted').
    reverted_at     timestamptz,
    -- Who/what resolved it: 'sweep' (window closed clean / signal tripped it) or
    -- an actor id (owner thumbs-down).
    resolved_by     text
);

-- The sweep's hot path: armed rows whose window has closed (clear) or that need
-- a signal check.
CREATE INDEX IF NOT EXISTS autonomy_tripwires_sweep_idx
    ON harness_shared.autonomy_tripwires (workspace_id, status, window_until);
-- Graduation evidence: trailing clean/tripped passes per (category, class).
CREATE INDEX IF NOT EXISTS autonomy_tripwires_class_idx
    ON harness_shared.autonomy_tripwires (workspace_id, category, finding_class, armed_at);

GRANT SELECT, INSERT, UPDATE ON harness_shared.autonomy_tripwires TO harness_app;
REVOKE DELETE, TRUNCATE ON harness_shared.autonomy_tripwires FROM harness_app;
GRANT SELECT ON harness_shared.autonomy_tripwires TO harness_zero;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON harness_shared.autonomy_tripwires FROM harness_zero;
