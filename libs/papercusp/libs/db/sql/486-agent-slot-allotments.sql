-- 486-agent-slot-allotments.sql — agent-allocation-framework-2026-07-03 P-001 (D-002).
-- agent_slot becomes the THIRD resource_allotments kind alongside account/gpu:
-- delegated AGENT SEATS a fleet owner may launch su-agents from (D-001's
-- "Agent seats" group on the /res board).
--
-- Slots are COUNT-capped, not %-shared (D-002): a fleet is handed "5 seats of
-- opus·xhigh on AUTO", so the cap is a first-class `quantity` column, not
-- share_pct (which stays the cap for the account/gpu kinds and is stored 0 for
-- slots). resource_ref for an agent_slot row is the DERIVED slot template
-- '<model>:<effort>:<account>' (agentSlotRef in resource-allotments.ts); axis
-- carries the structured trio { model, effort, account }. The account is the
-- inference-GATEWAY selection (D-003) — 'AUTO' draws from the fleet's
-- allocated accounts — never a raw credential.
--
-- Still LOCAL/per-machine (M19) like the rest of this table: federation of
-- seat-OFFERS is Phase 3 (D-005, the offer-store/directory leg), not a CDC
-- property of these rows.
--
-- Idempotent; apply via the runner (db:migrate) or psql + a schema_migrations
-- row in one txn.

\set ON_ERROR_STOP on
BEGIN;

-- Seat count cap for agent_slot rows (D-002). NULL for the share-capped kinds.
ALTER TABLE harness_shared.resource_allotments
  ADD COLUMN IF NOT EXISTS quantity integer;

-- Widen the kind CHECK to admit the third kind. DROP+ADD keeps the run
-- idempotent (re-running re-validates a small table; the runner records it
-- once anyway).
ALTER TABLE harness_shared.resource_allotments
  DROP CONSTRAINT IF EXISTS resource_allotments_kind;
ALTER TABLE harness_shared.resource_allotments
  ADD CONSTRAINT resource_allotments_kind
  CHECK (resource_kind IN ('account', 'gpu', 'agent_slot'));

-- Count-vs-share discipline as a DB recurrence guard, matching the store's
-- refusals (quantity_required / quantity_out_of_range): an agent_slot row MUST
-- carry a bounded count; a share-capped row must NOT carry one.
ALTER TABLE harness_shared.resource_allotments
  DROP CONSTRAINT IF EXISTS resource_allotments_quantity;
ALTER TABLE harness_shared.resource_allotments
  ADD CONSTRAINT resource_allotments_quantity
  CHECK (
    (resource_kind = 'agent_slot' AND quantity IS NOT NULL AND quantity >= 1 AND quantity <= 1000)
    OR (resource_kind <> 'agent_slot' AND quantity IS NULL)
  );

COMMENT ON COLUMN harness_shared.resource_allotments.quantity IS
  'D-002 (agent-allocation-framework): seat COUNT cap for agent_slot rows (1..1000) — slots cap by count, accounts/GPUs by share_pct. NULL for non-slot kinds (enforced by resource_allotments_quantity).';

COMMIT;
