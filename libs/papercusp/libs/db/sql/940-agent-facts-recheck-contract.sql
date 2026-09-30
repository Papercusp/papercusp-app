-- 940-agent-facts-recheck-contract.sql — loop-wake-reliability-2026-08-24 P-010
--
-- Standing facts are delivered deterministically until expiry or retraction,
-- but an ordinary fact previously carried no executable answer to two basic
-- questions: "how do I verify this again?" and "what observation disproves
-- it?". Store those answers as one atomic JSON object beside the fact.
--
-- Reuse-first: this extends harness_shared.agent_facts, its existing append-
-- versioning, deterministic folds and federation path. A second verification
-- ledger would duplicate the fact identity and create an immediate join/drift
-- problem.
--
-- NULL remains valid for compatibility. facts:assert emits a loud success-time
-- warning when an ordinary fact omits the pair. When present, the database
-- enforces the exact two-field bounded shape so direct writers cannot bypass
-- the tool/store contract.
--
-- No top-level BEGIN/COMMIT: the migration runner owns the transaction.

ALTER TABLE harness_shared.agent_facts
  ADD COLUMN IF NOT EXISTS recheck jsonb;

-- FORWARD-COMPAT: this DROP targets only the constraint introduced by THIS
-- migration. The currently deployed release predates migration 940 and cannot
-- depend on a column/constraint it has never seen; first apply is a no-op DROP,
-- and an idempotent re-run replaces the same definition inside the migration
-- runner's single transaction.
ALTER TABLE harness_shared.agent_facts
  DROP CONSTRAINT IF EXISTS agent_facts_recheck_contract_check;

ALTER TABLE harness_shared.agent_facts
  ADD CONSTRAINT agent_facts_recheck_contract_check
  CHECK (
    recheck IS NULL
    OR ((
        jsonb_typeof(recheck) = 'object'
        AND recheck ?& ARRAY['probe', 'falsifier']
        AND jsonb_typeof(recheck -> 'probe') = 'string'
        AND char_length(btrim(recheck ->> 'probe')) BETWEEN 1 AND 500
        AND jsonb_typeof(recheck -> 'falsifier') = 'string'
        AND char_length(btrim(recheck ->> 'falsifier')) BETWEEN 1 AND 500
        AND recheck - 'probe' - 'falsifier' = '{}'::jsonb
      ) IS TRUE)
  );

COMMENT ON COLUMN harness_shared.agent_facts.recheck IS
  'P-010: optional standing-fact re-verification contract {probe,falsifier}; each field is non-empty and <=500 chars. probe says how to test the claim again, falsifier names the concrete result that means it is false.';
