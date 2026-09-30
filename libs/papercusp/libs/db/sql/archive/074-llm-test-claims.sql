-- 074 — Claim ledger for parallel llm-test runners.
--
-- Plan §0 / handoff §D item 3. When multiple processes run scenarios
-- in parallel (CI fan-out, --parallel >1 with distributed coordinators,
-- or two devs hitting the same dev DB), each must claim its scenario
-- before starting so we don't burn duplicate Anthropic spend on the
-- same (scenario, sutModel, judgeModel) identity in the same matrix
-- window.
--
-- Semantics:
--   - One row per active claim. `owner_id` is whoever holds it (any
--     stable string — process id, hostname:pid, CI job id).
--   - `expires_at` is a TTL — defaults to 10 min in the helper. A
--     crashed runner's claim auto-releases. Heartbeating extends.
--   - `claim_key` is the natural dedupe key: scenario_id × identity
--     hash × matrix_index. Conflicts are caught via UNIQUE and turned
--     into "someone else has it".
--
-- Idempotent (IF NOT EXISTS).

BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.llm_test_claims (
  claim_key      text         PRIMARY KEY,
  owner_id       text         NOT NULL,
  scenario_id    text         NOT NULL,
  identity_hash  text         NOT NULL,
  matrix_index   int,
  acquired_at    timestamptz  NOT NULL DEFAULT now(),
  expires_at     timestamptz  NOT NULL,
  metadata_json  jsonb        NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS llm_test_claims_expires_idx
  ON harness_shared.llm_test_claims (expires_at);

CREATE INDEX IF NOT EXISTS llm_test_claims_owner_idx
  ON harness_shared.llm_test_claims (owner_id);

COMMIT;
