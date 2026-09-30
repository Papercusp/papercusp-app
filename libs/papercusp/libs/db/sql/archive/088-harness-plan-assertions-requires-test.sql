-- 088: harness_plan_assertions.requires_test — test-gate exemption flag.
--
-- Phase E (P-060) of harness-tests-tab-and-tester-promotion-2026-05-26.
--
-- `requires_test = false` marks a VAL whose claim isn't provable by an
-- automated test — copy, a design-spec match, a human judgement call. The
-- staging orchestrator's NEXT_TESTER gate and the validator's test gate
-- skip these; every other VAL needs a passing covering test before a
-- feature can be approved. Authored as an optional `RequiresTest: false`
-- sub-bullet on the inline VAL-* block; plans:promote parses it. Default
-- true (a claim requires a test unless explicitly exempted).
--
-- Additive ALTER (not an edit to 087) so it applies cleanly to harnesses
-- whose harness_plan_assertions table already exists.

ALTER TABLE harness_shared.harness_plan_assertions
  ADD COLUMN IF NOT EXISTS requires_test BOOLEAN NOT NULL DEFAULT true;

-- Partial index for the gate query ("which claim VALs still need a test").
-- Only the small non-default (exempt) set is ever indexed.
CREATE INDEX IF NOT EXISTS hpa_requires_test_idx
  ON harness_shared.harness_plan_assertions (workspace_id, harness_slug)
  WHERE NOT requires_test;
