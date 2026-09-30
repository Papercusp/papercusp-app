-- 1240-agent-facts-recheck-exec.sql — expensive-verification-loops-2026-09-29 P-004
--
-- Executable guard rails. A fact's recheck contract ({probe, falsifier}, migration 940)
-- says in prose how to re-verify the fact. A guard-rail lesson learned the expensive way
-- (a P-505 drill rerun, a release cut) should be re-verified by MACHINE at the start of the
-- next campaign, not by whoever happens to read the fold. So recheck may now carry the
-- probe's executable form:
--
--   recheck.exec = { command, expectExitCode, stdoutIncludes?, scope: [tag, ...] }
--
-- Contract-conforming harness preflights (libs/generic/verification-harness) run every exec
-- probe whose scope shares a tag with the harness (loader:
-- packages/operator-core/lib/agent-facts/guard-rail-probes.ts).
--
-- Reuse-first, same reasoning as 940: the probe belongs to the fact's recheck contract, so it
-- rides the fact's identity, versioning and retraction instead of a second table that would
-- drift from the lesson it enforces. The store validates the fine shape (tag grammar,
-- exit-code range, lengths; validateFactRecheck in agent-facts/store.ts); this CHECK pins the
-- outline so a direct writer cannot store a probe the loader would misread.
--
-- No top-level BEGIN/COMMIT: the migration runner owns the transaction.

-- FORWARD-COMPAT: this DROP replaces the recheck CHECK with a strictly WIDER one (an optional
-- exec key). Every row the currently deployed release can write still satisfies the new
-- definition, and the drop and re-add run in the runner's single transaction.
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
        AND recheck - 'probe' - 'falsifier' - 'exec' = '{}'::jsonb
        AND (
          NOT (recheck ? 'exec')
          OR (
            jsonb_typeof(recheck -> 'exec') = 'object'
            AND jsonb_typeof(recheck -> 'exec' -> 'command') = 'string'
            AND char_length(btrim(recheck -> 'exec' ->> 'command')) BETWEEN 1 AND 500
            AND jsonb_typeof(recheck -> 'exec' -> 'expectExitCode') = 'number'
            AND jsonb_typeof(recheck -> 'exec' -> 'scope') = 'array'
            AND jsonb_array_length(recheck -> 'exec' -> 'scope') BETWEEN 1 AND 8
          )
        )
      ) IS TRUE)
  );

-- The loader reads live exec-bearing facts per workspace; they are a handful among ~11k rows.
CREATE INDEX IF NOT EXISTS agent_facts_recheck_exec
  ON harness_shared.agent_facts (workspace_id)
  WHERE recheck ? 'exec' AND retracted_at IS NULL AND superseded_at IS NULL;

COMMENT ON COLUMN harness_shared.agent_facts.recheck IS
  'P-010: optional standing-fact re-verification contract {probe,falsifier[,exec]}; probe/falsifier are non-empty and <=500 chars. probe says how to test the claim again, falsifier names the concrete result that means it is false. P-004 (1240): optional exec {command, expectExitCode, stdoutIncludes?, scope[]} is the probe''s executable form, run by harness preflights whose scope tags match.';
