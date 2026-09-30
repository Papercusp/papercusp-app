-- 269-autonomy-tripwire-decision-id.sql
--
-- queen-autonomy-policy-2026-06-13 (B-16 follow-on, P-031 link / D-025): add a
-- nullable `decision_id` to the tripwire ledger so the decision-ledger feed
-- (B-13) can LEFT-JOIN tripwires and expose `tripwireId` + `revert_handle` on the
-- recent-auto-decisions row — what lights up the one-click UNDO (B-15 P-031).
--
-- The Queen execution layer mints ONE decision id per auto-decision and writes it
-- to BOTH its ledger disposition row AND the tripwire (via
-- armTripwireForDecision's `decisionId`), so the two rows for the same
-- auto-decision share a stable join key (action+category is NOT unique). Nullable
-- — a tripwire armed without a correlated ledger row simply has no link.
--
-- Additive; idempotent; fresh-migrate-safe (runs after 266 created the table; the
-- column inherits the table's existing harness_app/harness_zero grants).

ALTER TABLE harness_shared.autonomy_tripwires
    ADD COLUMN IF NOT EXISTS decision_id text;

-- The feed's join key (workspace-scoped). Partial — most rows carry a decision_id
-- once the execution layer correlates them; a null link is cheap to skip.
CREATE INDEX IF NOT EXISTS autonomy_tripwires_decision_id_idx
    ON harness_shared.autonomy_tripwires (workspace_id, decision_id)
    WHERE decision_id IS NOT NULL;
