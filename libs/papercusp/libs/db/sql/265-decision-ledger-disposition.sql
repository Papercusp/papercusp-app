-- 265-decision-ledger-disposition.sql
--
-- queen-autonomy-policy-2026-06-13 B-13 / P-111: the DECIDER-DISPOSITION layer of
-- the two-layer Queen decision ledger. The ACTION-CHOKEPOINT layer (B-06 / P-110,
-- migration 260) records one row per GOVERNED action that ran; this layer records
-- one row per item the Queen's decision turn CONSIDERED — the disposition it chose
-- and why — consuming the decider's `AutonomyDecision` record (B-12, decider.ts).
--
-- Migration 260 forward-designed the shared table for this: `layer` already
-- discriminates 'action' from 'disposition', and risk_tier / reversibility /
-- authority / category / why / links / posture are all present. The disposition
-- layer adds exactly TWO things 260 did not anticipate as columns:
--
--   • disposition — the Queen's chosen response to the item, the P-111 verb set:
--       act               — she acted (an `auto` decision executed; links the
--                            action row via links.actionLedgerId).
--       defer             — postponed; revisit_at carries when (defer +revisit).
--       reject            — dropped the item (why carries the reason).
--       route-to-research — needs more knowledge first; links the spawned
--                            research-task via links.researchTaskId (the worked
--                            example: a plan that "needs more research").
--       no-op             — considered, nothing to do (why carries the reason).
--     NULL on every action-layer row (the action layer has no disposition verb;
--     its `posture` already says auto/gated/rejected). The CHECK only constrains
--     non-NULL values, so action rows are unaffected.
--   • revisit_at — for `disposition='defer'`: when to reconsider. NULL otherwise.
--
-- The disposition row's `posture` reuses the existing 260 vocabulary
-- (auto|proposed|gated|rejected): an executed auto-decision is 'auto'; a gated
-- decision the Queen proposed for owner ratification is 'proposed'; an
-- unarmed/over-ceiling decision is 'gated'. The full AutonomyDecision reasons +
-- wouldAutoIfArmed + economic signals ride `metadata` (260's jsonb).
--
-- BEHAVIOR-NEUTRAL: pure additive record-keeping behind `papercusp-decision-ledger`
-- (default-ON, same Phase-0-foundation call as the action layer). No reader gates
-- on it; the rows accumulate so B-13's surface (P-113), B-15's recent-auto-
-- decisions feed (P-031), and B-16's tripwire/graduation (P-080..P-082) can
-- consume them.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS (the named CHECK rides the first add and is
-- skipped on re-run). Existing table grants cover the new columns — no re-grant.

ALTER TABLE harness_shared.decision_ledger
  ADD COLUMN IF NOT EXISTS disposition text
    CONSTRAINT decision_ledger_disposition_check
    CHECK (disposition IS NULL OR disposition IN
      ('act', 'defer', 'reject', 'route-to-research', 'no-op')),
  ADD COLUMN IF NOT EXISTS revisit_at timestamptz;

COMMENT ON COLUMN harness_shared.decision_ledger.disposition IS
  'queen-autonomy B-13/P-111: the Queen decision turn''s chosen response to an item — act|defer|reject|route-to-research|no-op. NULL on action-layer rows (their posture already encodes auto/gated/rejected).';
COMMENT ON COLUMN harness_shared.decision_ledger.revisit_at IS
  'queen-autonomy B-13/P-111: for disposition=''defer'', when to reconsider the item. NULL otherwise.';

-- The surface (P-113) + the settings recent-auto-decisions feed (P-031) filter by
-- layer (disposition feed) then time; the existing ws+ts / ws+posture / ws+category
-- indexes don't cover a layer filter. Cheap composite for the feed query.
CREATE INDEX IF NOT EXISTS decision_ledger_ws_layer_ts_idx
  ON harness_shared.decision_ledger (workspace_id, layer, ts DESC);
