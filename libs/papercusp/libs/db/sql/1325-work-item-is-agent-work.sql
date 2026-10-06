-- 1325-work-item-is-agent-work.sql
--
-- Plan enterprise-data-sources-2026-10-01, item P-009 (WI-10005045), ruling D-022.
--
-- The ONE work predicate: is this work_items row agent work? Every claim and placement path
-- composes it with harness_shared.work_item_claim_floors(...) instead of carrying its own
-- hand-maintained item_kind list.
--
--   nature = 'work'                      (stamped at mint from datatype_registry, 1322 / D-018)
--   audience = 'agent'                   (a human-audience kind such as email-draft-proposal
--                                         is work, but not an agent's to claim)
--   lane IS DISTINCT FROM 'observation'  (turn-end reflections and scorecards, D-009(e))
--   needs_owner_action IS NOT TRUE       (the strict owner-action gate)
--
-- It reads work_items COLUMNS only (D-008): lane and needs_owner_action are generated from
-- payload, nature and audience are trigger-stamped. No JOIN to datatype_registry, so it is
-- IMMUTABLE and PARALLEL SAFE, and as a single-expression LANGUAGE sql function the planner
-- inlines it into the caller's WHERE clause.
--
-- Additive only: a new function, nothing dropped or renamed. The release currently serving
-- :3070 does not reference it.

CREATE OR REPLACE FUNCTION harness_shared.work_item_is_agent_work(
  p_nature             text,
  p_audience           text,
  p_lane               text,
  p_needs_owner_action boolean
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT p_nature = 'work'
     AND p_audience = 'agent'
     AND p_lane IS DISTINCT FROM 'observation'
     AND p_needs_owner_action IS NOT TRUE
$$;

COMMENT ON FUNCTION harness_shared.work_item_is_agent_work(text, text, text, boolean) IS
  'P-009 / D-022: the one work predicate. Pass wi.nature, wi.audience, wi.lane, wi.needs_owner_action. Compose with work_item_claim_floors; never replace it.';

-- Self-check: the truth table the claim paths rely on. Raises (and aborts the migration) if
-- the body is ever edited into something that admits a non-agent row.
DO $$
BEGIN
  IF NOT harness_shared.work_item_is_agent_work('work', 'agent', NULL, NULL) THEN
    RAISE EXCEPTION '1325 self-check: plain agent work must be agent work';
  END IF;
  IF NOT harness_shared.work_item_is_agent_work('work', 'agent', 'improvement', false) THEN
    RAISE EXCEPTION '1325 self-check: a non-observation lane must be agent work';
  END IF;
  IF harness_shared.work_item_is_agent_work('work', 'human', NULL, NULL) IS NOT FALSE THEN
    RAISE EXCEPTION '1325 self-check: human-audience work must not be agent work';
  END IF;
  IF harness_shared.work_item_is_agent_work('record', NULL, NULL, NULL) IS NOT FALSE THEN
    RAISE EXCEPTION '1325 self-check: a record must not be agent work';
  END IF;
  IF harness_shared.work_item_is_agent_work('document', NULL, NULL, NULL) IS NOT FALSE THEN
    RAISE EXCEPTION '1325 self-check: a document must not be agent work';
  END IF;
  IF harness_shared.work_item_is_agent_work('event', NULL, NULL, NULL) IS NOT FALSE THEN
    RAISE EXCEPTION '1325 self-check: an event must not be agent work';
  END IF;
  IF harness_shared.work_item_is_agent_work('work', 'agent', 'observation', NULL) IS NOT FALSE THEN
    RAISE EXCEPTION '1325 self-check: an observation must not be agent work';
  END IF;
  IF harness_shared.work_item_is_agent_work('work', 'agent', NULL, true) IS NOT FALSE THEN
    RAISE EXCEPTION '1325 self-check: a needs-owner-action row must not be agent work';
  END IF;
END
$$;
